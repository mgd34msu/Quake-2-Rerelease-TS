/*
The compass breadcrumb trail's nav-mesh query, end to end through BOTH game
bindings, against base1's REAL shipped navigation graph.

WHY THIS FILE EXISTS. test/nav.test.ts already covers src/server/nav.ts
itself -- the .nav v6 parser and the A* -- against hand-built synthetic
graphs. What it cannot cover is the seam this unit wired: whether the two
BINDINGS actually reach that code, and whether they agree. Both were dead
before: src/server/bindings/kex.ts had `GetPathToGoal: () => false` and
src/server/bindings/legacy.ts had no nav import at all, so the re-release
compass (Use_Compass -> Compass_Update -> svc_help_path -> the client's
SCR_AddHelpPath) was inert under BOTH modules even though every other link
in that chain was complete. A synthetic 4-node graph would not have caught
it; only calling the bindings does.

No copyrighted data is committed: bots/navigation/base1.nav and
maps/base1.bsp are read out of the user's local retail install at run time
through this port's own FS, and every case skips when that install is
absent -- the same convention test/cmodel_retail_qbsp_sweep.test.ts and the
rest of the retail-gated suite follow.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, FS_LoadFile, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { sv } from "../src/server/server";
import { SV_ClearWorld } from "../src/server/sv_world";
import { vec3, type Vec3 } from "../src/shared/math";
import { PathFlags, PathLinkType, PathReturnCode, type PathInfo, type PathRequest } from "../src/kexapi/game";
import { Nav_Load, Nav_Unload, Nav_DebugState } from "../src/server/nav";
import { BuildKexImports } from "../src/server/bindings/kex";
import { PF_GetPathToGoal, PATH_LINK_TYPE_WALK, PATH_RETURN_START_PATH_ERRORS } from "../src/server/bindings/legacy";
import type { PathQueryT } from "../src/game/game";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

/** base1's `info_player_start` (the non-"base2" one) and its `target_poi`
 *  "t70" -- both read straight out of the map's own entity lump. */
const BASE1_START: Vec3 = vec3(128, -320, 32);
const BASE1_POI: Vec3 = vec3(-1664, 1536, 144);

/** g_items.cpp:1495: `constexpr size_t MAX_TEMP_POI_POINTS = 128;`. */
const MAX_TEMP_POI_POINTS = 128;

/** The node-search settings BOTH re-release compass call sites use verbatim
 *  (g_items.cpp:1571-1574's Use_Compass and g_target.cpp:1604-1607's
 *  distance_to_poi). */
function kexCompassRequest(start: Vec3, goal: Vec3, points: Vec3[] | null): PathRequest {
  return {
    start,
    goal,
    pathFlags: PathFlags.All,
    moveDist: 64,
    debugging: { drawTime: 0 },
    nodeSearch: { ignoreNodeFlags: true, minHeight: 128, maxHeight: 128, radius: 1024 },
    traversals: { dropHeight: 0, jumpHeight: 0 },
    pathPoints: { array: points, count: points === null ? 0 : MAX_TEMP_POI_POINTS },
  };
}

function freshInfo(): PathInfo {
  return {
    numPathPoints: 0,
    pathDistSqr: 0,
    firstMovePoint: vec3(),
    secondMovePoint: vec3(),
    pathLinkType: PathLinkType.Walk,
    returnCode: PathReturnCode.StartPathErrors,
  };
}

function classicCompassQuery(start: Vec3, goal: Vec3, points: Vec3[] | null): PathQueryT {
  return {
    start,
    goal,
    moveDist: 64,
    pathFlags: 0xffffffff,
    ignoreNodeFlags: true,
    minHeight: 128,
    maxHeight: 128,
    radius: 1024,
    points,
    maxPoints: points === null ? 0 : MAX_TEMP_POI_POINTS,
  };
}

function buffer(): Vec3[] {
  return Array.from({ length: MAX_TEMP_POI_POINTS }, () => vec3());
}

function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

describe("compass nav-mesh query through both game bindings, on base1's real .nav (skipped if the retail install isn't present)", () => {
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    if (!havePak) return;
    // rule 13: fs_searchpaths is a process-wide singleton that only ever
    // accumulates -- snapshot/restore so this mount cannot shadow another
    // file's missing-file fixture. Same guard the other retail-gated tests use.
    fsSnapshot = FS_TestSnapshotSearchPaths();
    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    FS_InitFilesystem();

    // Nav_ClosestNodeTo does a real SV_Trace against the loaded world, so the
    // collision model has to be up before any query runs.
    sv.models[1] = CM_LoadMap("maps/base1.bsp", false).model;
    SV_ClearWorld();

    Nav_Unload();
    Nav_Load("base1");
  });

  afterAll(() => {
    if (!havePak) return;
    Nav_Unload();
    FS_TestRestoreSearchPaths(fsSnapshot);
  });

  test.skipIf(!havePak)("Nav_Load finds bots/navigation/base1.nav in the retail pak and parses its graph", () => {
    expect(FS_LoadFile("bots/navigation/base1.nav")).not.toBeNull();

    const st = Nav_DebugState();
    expect(st.filename).toBe("bots/navigation/base1.nav");
    expect(st.num_nodes).toBe(416);
    expect(st.num_links).toBe(1391);
  });

  test.skipIf(!havePak)("the kex binding's GetPathToGoal walks base1's start to its objective POI", () => {
    const points = buffer();
    const info = freshInfo();
    const ok = BuildKexImports().GetPathToGoal(kexCompassRequest(BASE1_START, BASE1_POI, points), info);

    // The stub this replaced returned false unconditionally; that is the
    // regression this case exists to catch.
    expect(ok).toBe(true);
    expect(info.returnCode).toBeLessThan(PathReturnCode.StartPathErrors);
    expect(info.numPathPoints).toBeGreaterThan(1);
    expect(info.numPathPoints).toBeLessThanOrEqual(MAX_TEMP_POI_POINTS);

    // First breadcrumb at the player, last at the objective -- the trail has
    // to actually span the request, not just be non-empty.
    expect(dist(points[0]!, BASE1_START)).toBeLessThan(64);
    expect(dist(points[info.numPathPoints - 1]!, BASE1_POI)).toBeLessThan(64);

    // ...and go somewhere in between: base1's POI is most of the level away.
    const straight = dist(BASE1_START, BASE1_POI);
    expect(straight).toBeGreaterThan(2000);
    let walked = 0;
    for (let i = 1; i < info.numPathPoints; i++) walked += dist(points[i - 1]!, points[i]!);
    expect(walked).toBeGreaterThan(straight);
  });

  test.skipIf(!havePak)("pathDistSqr equals the squared sum of the returned path's segment lengths", () => {
    // Independent check on info.pathDistSqr, computed from the OUTPUT
    // (request.start, the pathPoints buffer GetPathToGoal filled, then
    // request.goal) rather than by re-deriving it from nav.ts's internals.
    // The buffer is large enough here that nothing is truncated -- prepending
    // start and appending goal is safe even when Nav_ReachedGoal already put
    // one or both of them in the buffer itself (PATH_POINT_TOO_CLOSE, nav.ts)
    // since that just sums an extra zero-length segment.
    const points = buffer();
    const info = freshInfo();
    const ok = BuildKexImports().GetPathToGoal(kexCompassRequest(BASE1_START, BASE1_POI, points), info);

    expect(ok).toBe(true);
    // Has to be unfilled headroom, or "the returned points" would be a
    // truncated prefix rather than nav.ts's whole path.
    expect(info.numPathPoints).toBeLessThan(MAX_TEMP_POI_POINTS);

    let walked = 0;
    let prev = BASE1_START;
    for (let i = 0; i < info.numPathPoints; i++) {
      walked += dist(prev, points[i]!);
      prev = points[i]!;
    }
    walked += dist(prev, BASE1_POI);

    expect(info.pathDistSqr).toBeCloseTo(walked * walked, 3);
  });

  test.skipIf(!havePak)("the classic binding's get_path_to_goal hook returns the same points as the kex binding's", () => {
    const kexPoints = buffer();
    const kexInfo = freshInfo();
    const kexOk = BuildKexImports().GetPathToGoal(kexCompassRequest(BASE1_START, BASE1_POI, kexPoints), kexInfo);

    const classicPoints = buffer();
    const classicResult = PF_GetPathToGoal(classicCompassQuery(BASE1_START, BASE1_POI, classicPoints));

    expect(classicResult.found).toBe(kexOk);
    expect(classicResult.returnCode).toBe(kexInfo.returnCode);
    expect(classicResult.numPathPoints).toBe(kexInfo.numPathPoints);
    expect(classicResult.pathDistSqr).toBe(kexInfo.pathDistSqr);

    for (let i = 0; i < kexInfo.numPathPoints; i++) {
      expect([...classicPoints[i]!]).toEqual([...kexPoints[i]!]);
    }
  });

  test.skipIf(!havePak)("the classic hook writes into the caller's own Vec3 objects, the way the C++ pointer contract does", () => {
    const points = buffer();
    const firstSlot = points[0]!;
    const result = PF_GetPathToGoal(classicCompassQuery(BASE1_START, BASE1_POI, points));

    expect(result.found).toBe(true);
    // Not replaced with a new Vec3 -- filled in place, so a caller holding a
    // reference into the buffer (Use_Compass's `points[i + 1]` copy loop)
    // sees the path.
    expect(points[0]).toBe(firstSlot);
    expect(dist(firstSlot, BASE1_START)).toBeLessThan(64);
  });

  test.skipIf(!havePak)("a goal with no reachable node reports a failure code rather than a bogus path", () => {
    // Far outside base1's world bounds: no nav node is anywhere near it.
    const result = PF_GetPathToGoal(classicCompassQuery(BASE1_START, vec3(100000, 100000, 100000), buffer()));

    expect(result.found).toBe(false);
    expect(result.returnCode).toBeGreaterThanOrEqual(PathReturnCode.StartPathErrors);
    // ...and specifically NOT "no nav available", which is the one code
    // distance_to_poi treats as "fall back to straight-line distance".
    expect(result.returnCode).not.toBe(PathReturnCode.NoNavAvailable);
  });

  test("the two PathInfo ordinals legacy.ts spells locally match kexapi's enums", () => {
    // legacy.ts deliberately names no kex API symbol (see its own comment);
    // these two constants are the whole of that duplication.
    expect(PATH_LINK_TYPE_WALK).toBe(PathLinkType.Walk);
    expect(PATH_RETURN_START_PATH_ERRORS).toBe(PathReturnCode.StartPathErrors);
  });
});
