/*
Unit + integration tests for src/server/nav.ts (ported from q2repro's
src/server/nav.c + inc/server/nav.h).

Two layers:
 - format/A* unit tests build a byte-exact minimal .nav v6 buffer (a 3-node
   line graph A-B-C, plus a disconnected node D for the unreachable-goal
   case) and load it through the `Nav_LoadFromBuffer` test seam directly,
   skipping the filesystem entirely.
 - one integration test exercises the real `Nav_Load(mapName)` path against
   a temp gamedir with NO bots/navigation/<map>.nav file present (the common
   case for almost every real map), the same synthetic-BSP-room pattern
   test/sv_world.test.ts already uses, to pin down nav.ts's documented
   "file not found" quirk end-to-end (see nav.ts's header, "A PRESERVED
   UPSTREAM QUIRK").

Nav_ClosestNodeTo (nav.c:527-583) does a real SV_Trace visibility check
against the loaded world, so every pathfinding test needs a real (synthetic)
BSP loaded into sv.models[1] -- same requirement test/sv_world.test.ts has,
solved the same way (test/support/bsp_builder.ts's buildBoxRoomBsp, an empty
room for |x|,|y|,|z| < ROOM_HALF = 64). All node origins and request start/
goal points below are kept well inside that room.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { vec3, type Vec3 } from "../src/shared/math";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import { sv } from "../src/server/server";
import { SV_ClearWorld } from "../src/server/sv_world";
import { PathFlags, PathReturnCode, type PathRequest } from "../src/kexapi/game";
import { Nav_LoadFromBuffer, Nav_Load, Nav_Unload, Nav_GetPathToGoal, Nav_DebugState, Nav_RegisterEdict, Nav_UnRegisterEdict, NAV_MAGIC, type NavGameEdictView } from "../src/server/nav";

//============================================================================
// .nav v6 buffer builder (nav.c:86-183's kaitai-struct layout, reproduced by
// hand: header, data header, node headers, node origins, links, traversals,
// edict count + edicts).
//============================================================================

interface NavTestNode {
  flags?: number;
  radius: number;
  origin: [number, number, number];
}
interface NavTestLink {
  from: number;
  to: number;
  type?: number;
  flags?: number;
  traversal?: number;
}

function buildNavV6(nodes: NavTestNode[], links: NavTestLink[], heuristic = 1.0): Uint8Array {
  // group links by source node, preserving the caller's array order within
  // each node's slice (mirrors nav.c:939-953's first_link/num_links extents)
  const bySource = new Map<number, NavTestLink[]>();
  for (const l of links) {
    if (!bySource.has(l.from)) bySource.set(l.from, []);
    bySource.get(l.from)!.push(l);
  }
  const flatLinks: NavTestLink[] = [];
  const firstLink: number[] = [];
  const numLinks: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    firstLink.push(flatLinks.length);
    const forNode = bySource.get(i) ?? [];
    numLinks.push(forNode.length);
    flatLinks.push(...forNode);
  }

  const num_nodes = nodes.length;
  const num_links = flatLinks.length;
  const num_traversals = 0;
  const num_edicts = 0;

  const size = 4 + 4 + (4 + 4 + 4 + 4) + num_nodes * 8 + num_nodes * 12 + num_links * 6 + num_traversals * 48 + 4 + num_edicts * 0;

  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setInt32(o, NAV_MAGIC, true);
  o += 4;
  view.setInt32(o, 6, true); // NAV_VERSION_6
  o += 4;

  view.setInt32(o, num_nodes, true);
  o += 4;
  view.setInt32(o, num_links, true);
  o += 4;
  view.setInt32(o, num_traversals, true);
  o += 4;
  view.setFloat32(o, heuristic, true);
  o += 4;

  for (let i = 0; i < num_nodes; i++) {
    view.setUint16(o, nodes[i].flags ?? 0, true);
    o += 2;
    view.setInt16(o, numLinks[i], true);
    o += 2;
    view.setInt16(o, firstLink[i], true);
    o += 2;
    view.setInt16(o, nodes[i].radius, true);
    o += 2;
  }

  for (let i = 0; i < num_nodes; i++) {
    view.setFloat32(o, nodes[i].origin[0], true);
    o += 4;
    view.setFloat32(o, nodes[i].origin[1], true);
    o += 4;
    view.setFloat32(o, nodes[i].origin[2], true);
    o += 4;
  }

  for (const l of flatLinks) {
    view.setInt16(o, l.to, true);
    o += 2;
    view.setUint8(o, l.type ?? 0 /* NavLinkTypeT.Walk */);
    o += 1;
    view.setUint8(o, l.flags ?? 0);
    o += 1;
    view.setInt16(o, l.traversal ?? -1, true);
    o += 2;
  }

  // num_traversals is 0 in every test graph -- no traversal records to write

  view.setInt32(o, num_edicts, true);
  o += 4;

  // num_edicts is 0 in every test graph -- no edict records to write

  return buf;
}

function makeRequest(start: Vec3, goal: Vec3, overrides: Partial<PathRequest> = {}): PathRequest {
  return {
    start,
    goal,
    pathFlags: PathFlags.Walk,
    moveDist: 0,
    debugging: { drawTime: 0 },
    nodeSearch: { ignoreNodeFlags: false, minHeight: 0, maxHeight: 0, radius: 0 },
    traversals: { dropHeight: 0, jumpHeight: 0 },
    pathPoints: { array: null, count: 0 },
    ...overrides,
  };
}

// A-B-C line graph: A(-40,0,0) <-> B(0,0,0) <-> C(40,0,0), all bidirectional
// Walk links, plus a disconnected node D(0,60,0) with no links at all.
function abcdGraph(): { nodes: NavTestNode[]; links: NavTestLink[] } {
  return {
    nodes: [
      { radius: 32, origin: [-40, 0, 0] }, // 0: A
      { radius: 32, origin: [0, 0, 0] }, // 1: B
      { radius: 32, origin: [40, 0, 0] }, // 2: C
      { radius: 16, origin: [0, 60, 0] }, // 3: D (disconnected)
    ],
    links: [
      { from: 0, to: 1 }, // A -> B
      { from: 1, to: 0 }, // B -> A
      { from: 1, to: 2 }, // B -> C
      { from: 2, to: 1 }, // C -> B
    ],
  };
}

describe("nav.ts -- .nav file format, A* pathfinding, edict registration", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2nav-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);
    writeFileSync(join(mapsDir, "testroom.bsp"), buildBoxRoomBsp());

    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();

    const { model } = CM_LoadMap("maps/testroom.bsp", false);
    sv.models[1] = model;
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    SV_ClearWorld();
    Nav_Unload();
  });

  //--------------------------------------------------------------------
  // format parsing (nav.c:904-1050)
  //--------------------------------------------------------------------

  test("Nav_LoadFromBuffer: valid v6 3-node line graph parses successfully (nav.c:920-1041)", () => {
    const { nodes, links } = abcdGraph();
    const buf = buildNavV6(nodes, links);

    const result = Nav_LoadFromBuffer(buf, "test.nav");

    expect(result.ok).toBe(true);
    const state = Nav_DebugState();
    expect(state.loaded).toBe(true);
    expect(state.num_nodes).toBe(4);
    expect(state.num_links).toBe(4);
    expect(state.num_traversals).toBe(0);
    expect(state.num_edicts).toBe(0);
    // node 1 (B) has both its links resolved to real node objects
    expect(state.nodes[1].links.length).toBe(2);
    expect(state.nodes[1].links[0].target).toBe(state.nodes[0]);
    expect(state.nodes[1].links[1].target).toBe(state.nodes[2]);
  });

  test("Nav_LoadFromBuffer: bad magic is rejected (nav.c:920-921)", () => {
    const { nodes, links } = abcdGraph();
    const buf = buildNavV6(nodes, links);
    const view = new DataView(buf.buffer);
    view.setInt32(0, 0xdeadbeef, true); // corrupt the magic

    const result = Nav_LoadFromBuffer(buf, "test.nav");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bad magic/);
    expect(Nav_DebugState().loaded).toBe(false); // nav.c:1046-1047's Nav_Unload() on fail
  });

  test("Nav_LoadFromBuffer: version above NAV_VERSION_LATEST is rejected (nav.c:923-924)", () => {
    const { nodes, links } = abcdGraph();
    const buf = buildNavV6(nodes, links);
    const view = new DataView(buf.buffer);
    view.setInt32(4, 99, true); // version field, right after the magic

    const result = Nav_LoadFromBuffer(buf, "test.nav");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bad version/);
    expect(Nav_DebugState().loaded).toBe(false);
  });

  test("Nav_LoadFromBuffer: truncated buffer (cut off mid-header) is rejected (NAV_VERIFY_READ, nav.c:392-393)", () => {
    const { nodes, links } = abcdGraph();
    const full = buildNavV6(nodes, links);
    const truncated = full.slice(0, 10); // magic + version + partial num_nodes

    const result = Nav_LoadFromBuffer(truncated, "test.nav");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bad data/);
    expect(Nav_DebugState().loaded).toBe(false);
  });

  test("Nav_LoadFromBuffer: out-of-range link target is rejected (nav.c:972)", () => {
    const { nodes } = abcdGraph();
    // link target 99 doesn't exist among 4 nodes
    const buf = buildNavV6(nodes, [{ from: 0, to: 99 }]);

    const result = Nav_LoadFromBuffer(buf, "test.nav");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bad link target/);
  });

  //--------------------------------------------------------------------
  // A* pathfinding (nav.c:745-856, 646-743) via Nav_GetPathToGoal
  // (server/game.c:772-782's PF_GetPathToGoal, ported as Nav_GetPathToGoal)
  //--------------------------------------------------------------------

  test("Nav_GetPathToGoal: A -> C through B finds a path (returnCode < StartPathErrors)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const pathPointsBuf = Array.from({ length: 16 }, () => vec3());
    const request = makeRequest(vec3(-40, 0, 0), vec3(40, 0, 0), {
      pathPoints: { array: pathPointsBuf, count: pathPointsBuf.length },
    });
    const info = {
      numPathPoints: 0,
      pathDistSqr: 0,
      firstMovePoint: vec3(),
      secondMovePoint: vec3(),
      pathLinkType: 0,
      returnCode: PathReturnCode.StartPathErrors,
    };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(true);
    expect(info.returnCode).toBeLessThan(PathReturnCode.StartPathErrors);
    // path must pass through B(0,0,0) on the way from A to C
    const visited = pathPointsBuf.slice(0, info.numPathPoints).map((v) => [v[0], v[1], v[2]]);
    expect(visited.some((p) => p[0] === 0 && p[1] === 0 && p[2] === 0)).toBe(true);
  });

  test("Nav_GetPathToGoal: start already at/touching the goal node returns ReachedGoal (nav.c:775-779)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const request = makeRequest(vec3(0, 0, 0), vec3(0, 0, 0));
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(true);
    expect(info.returnCode).toBe(PathReturnCode.ReachedGoal);
  });

  test("Nav_GetPathToGoal: goal node is graph-disconnected from start returns NoPathFound (nav.c:814-853's open-set exhaustion)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    // D(0,60,0) has no links to/from A/B/C
    const request = makeRequest(vec3(-40, 0, 0), vec3(0, 60, 0));
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(false);
    expect(info.returnCode).toBe(PathReturnCode.NoPathFound);
  });

  test("Nav_GetPathToGoal: goal position with no node in Z range returns NoGoalNode (nav.c:768-773)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    // 300 units above any node's Z=0 origin, well outside the default
    // +-64 minHeight/maxHeight search band (nav.c:531-532's defaults)
    const request = makeRequest(vec3(-40, 0, 0), vec3(0, 0, 300));
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(false);
    expect(info.returnCode).toBe(PathReturnCode.NoGoalNode);
  });

  test("Nav_GetPathToGoal: start position with no node in Z range returns NoStartNode (nav.c:761-766)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const request = makeRequest(vec3(0, 0, 300), vec3(40, 0, 0));
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(false);
    expect(info.returnCode).toBe(PathReturnCode.NoStartNode);
  });

  test("Nav_GetPathToGoal: missing both Walk and Water path flags returns MissingWalkOrSwimFlag (nav.c:754-757)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const request = makeRequest(vec3(-40, 0, 0), vec3(40, 0, 0), { pathFlags: PathFlags.Elevator });
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(false);
    expect(info.returnCode).toBe(PathReturnCode.MissingWalkOrSwimFlag);
  });

  test("Nav_GetPathToGoal: ignoreNodeFlags requests a raw path (RawPathFound, nav.c:723-726)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const request = makeRequest(vec3(-40, 0, 0), vec3(40, 0, 0), {
      nodeSearch: { ignoreNodeFlags: true, minHeight: 0, maxHeight: 0, radius: 0 },
    });
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(true);
    expect(info.returnCode).toBe(PathReturnCode.RawPathFound);
  });

  //--------------------------------------------------------------------
  // load lifecycle (nav.c:904-1060) -- the "no .nav file" quirk and the
  // reentrancy guard
  //--------------------------------------------------------------------

  test("Nav_Load: no bots/navigation/<map>.nav on disk loads gracefully (nav.c:915-916), and pathfinding then returns NoStartNode, not NoNavAvailable (the preserved quirk)", () => {
    // no file written for this map name -- FS_LoadFile inside Nav_Load
    // returns null (file genuinely doesn't exist), exercised end-to-end
    // through the real Nav_Load(mapName), not the buffer seam.
    expect(() => Nav_Load("nonexistent_map_xyz")).not.toThrow();

    const state = Nav_DebugState();
    expect(state.loaded).toBe(true); // nav.c:906-908: set before the file open attempt
    expect(state.num_nodes).toBe(0);

    const request = makeRequest(vec3(0, 0, 0), vec3(10, 0, 0));
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };
    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(false);
    // NOT NoNavAvailable: nav_data.loaded is true (just empty), so
    // Nav_Path_'s `if (!nav_data.loaded)` guard (nav.c:749) never fires;
    // Nav_ClosestNodeTo finds nothing among zero nodes instead.
    expect(info.returnCode).toBe(PathReturnCode.NoStartNode);
  });

  test("Nav_GetPathToGoal before any Nav_Load (or after Nav_Unload) returns NoNavAvailable (nav.c:749-752)", () => {
    // beforeEach already called Nav_Unload(); nav_data.loaded is false here.
    const request = makeRequest(vec3(0, 0, 0), vec3(10, 0, 0));
    const info = { numPathPoints: 0, pathDistSqr: 0, firstMovePoint: vec3(), secondMovePoint: vec3(), pathLinkType: 0, returnCode: PathReturnCode.StartPathErrors };

    const ok = Nav_GetPathToGoal(request, info);

    expect(ok).toBe(false);
    expect(info.returnCode).toBe(PathReturnCode.NoNavAvailable);
  });

  test("Nav_Load: calling it again while already loaded throws (nav.c:906's Q_assert(!nav_data.loaded))", () => {
    Nav_Load("nonexistent_map_xyz");
    expect(() => Nav_Load("another_map")).toThrow();
  });

  //--------------------------------------------------------------------
  // edict registration (nav.c:1481-1524)
  //--------------------------------------------------------------------

  function fakeEdict(): NavGameEdictView {
    return {
      inuse: true,
      svflags: 0,
      solid: 0,
      absmin: vec3(),
      absmax: vec3(),
      s: { modelindex: 0, renderfx: 0, origin: vec3(), old_origin: vec3() },
      sv: { classname: "func_door", ent_flags: 0n },
    };
  }

  test("Nav_RegisterEdict: registers once, and re-registering the same edict is a no-op (nav.c:1485-1497)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const e = fakeEdict();
    Nav_RegisterEdict(e);
    Nav_RegisterEdict(e); // duplicate registration must not grow the registry

    const state = Nav_DebugState();
    const count = state.registered_edicts.filter((x) => x === e).length;
    expect(count).toBe(1);
  });

  test("Nav_UnRegisterEdict: removes a registered edict and trims the tail (nav.c:1500-1524)", () => {
    const { nodes, links } = abcdGraph();
    expect(Nav_LoadFromBuffer(buildNavV6(nodes, links), "test.nav").ok).toBe(true);

    const e1 = fakeEdict();
    const e2 = fakeEdict();
    Nav_RegisterEdict(e1);
    Nav_RegisterEdict(e2);
    Nav_UnRegisterEdict(e2);

    const state = Nav_DebugState();
    expect(state.registered_edicts).not.toContain(e2);
    expect(state.registered_edicts).toContain(e1);
  });

  test("Nav_RegisterEdict/Nav_UnRegisterEdict tolerate null (defensive, matches PF_Bot_RegisterEdict forwarding a possibly-null edict)", () => {
    expect(() => Nav_RegisterEdict(null)).not.toThrow();
    expect(() => Nav_UnRegisterEdict(null)).not.toThrow();
  });
});
