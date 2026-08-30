/*
Phase-7 unit: SV_Clip (sv_world.ts, ported from q2repro's world.c SV_Clip/
PF_Clip -- the engine service the kex binding's `clip` import now calls) and
the debug-draw buffer (sv_debugdraw.ts -- the seam standing in for kex's ten
no-op `Draw_*` game imports, see that file's header for the mechanism
finding/ruling).

Loads the same synthetic BSP test/sv_world.test.ts uses (no copyrighted map
data) purely so CM_LoadMap's CM_InitBoxHull has run -- CM_HeadnodeForBox
(used by every fabricated bbox entity below) depends on the box hull it
builds. No world-BSP geometry itself is exercised by these cases.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { CONTENTS_MONSTER, EntityStateT } from "../src/shared/q_shared";
import { type Vec3, vec3, VectorCopy } from "../src/shared/math";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import { sv } from "../src/server/server";
import { type Edict, LinkT, MAX_ENT_CLUSTERS, SolidT } from "../src/game/game";
import { SV_Clip } from "../src/server/sv_world";
import {
  SV_DebugDraw_Line,
  SV_DebugDraw_Point,
  SV_DebugDraw_Bounds,
  SV_DebugDraw_Arrow,
  SV_DebugDraw_Tick,
  SV_DebugDraw_Drain,
  SV_DebugDraw_Clear,
} from "../src/server/sv_debugdraw";

// Same fabrication helper as test/sv_world.test.ts -- server code touches
// edicts only through the `Edict` interface (PORTING.md), never the game
// module's private `EdictT`.
function makeEdict(solid: SolidT, mins: Vec3, maxs: Vec3, origin: Vec3): Edict {
  const s = new EntityStateT();
  VectorCopy(origin, s.origin);
  return {
    s,
    client: null,
    inuse: true,
    linkcount: 0,
    area: new LinkT(),
    num_clusters: 0,
    clusternums: new Int32Array(MAX_ENT_CLUSTERS),
    headnode: 0,
    areanum: 0,
    areanum2: 0,
    svflags: 0,
    mins: vec3(mins[0], mins[1], mins[2]),
    maxs: vec3(maxs[0], maxs[1], maxs[2]),
    absmin: vec3(),
    absmax: vec3(),
    size: vec3(),
    solid,
    clipmask: 0,
    owner: null,
  };
}

describe("SV_Clip -- single-entity clip (q2repro world.c SV_Clip port)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2clip-"));
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

  test("hits a fabricated bbox entity: fraction and plane match hand-computed box-trace math", () => {
    // 32-unit cube centered on the origin: world-space faces at x=+-16.
    const target = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -16), vec3(16, 16, 16), vec3(0, 0, 0));

    const start = vec3(-40, 0, 0);
    const end = vec3(40, 0, 0);
    const trace = SV_Clip(start, null, null, end, target, CONTENTS_MONSTER);

    // Point trace (mins=maxs=origin) from x=-40 to x=40 against a face at
    // x=-16: exact fraction is (-16 - -40) / (40 - -40) = 24/80 = 0.3, minus
    // the engine's small surface epsilon (measured: 0.299609375).
    expect(trace.fraction).toBeCloseTo(0.3, 2);
    expect(trace.allsolid).toBe(false);
    expect(trace.startsolid).toBe(false);
    // outward normal of the box's -x face, distance 16 from the origin.
    expect(trace.plane.normal[0]).toBeCloseTo(-1, 6);
    expect(trace.plane.normal[1]).toBeCloseTo(0, 6);
    expect(trace.plane.normal[2]).toBeCloseTo(0, 6);
    expect(trace.plane.dist).toBeCloseTo(16, 6);
    expect(trace.ent).toBe(target);
  });

  test("start-inside: tracing from inside the entity's box reports startsolid", () => {
    const target = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -16), vec3(16, 16, 16), vec3(0, 0, 0));

    const trace = SV_Clip(vec3(0, 0, 0), null, null, vec3(40, 0, 0), target, CONTENTS_MONSTER);

    expect(trace.startsolid).toBe(true);
    expect(trace.ent).toBe(target);
  });

  test("miss: a path entirely clear of the entity's box reports fraction 1, ent still set", () => {
    const target = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -16), vec3(16, 16, 16), vec3(0, 0, 0));

    // well clear in Y of the +-16 box
    const trace = SV_Clip(vec3(-40, 100, 0), null, null, vec3(40, 100, 0), target, CONTENTS_MONSTER);

    expect(trace.fraction).toBe(1);
    expect(trace.allsolid).toBe(false);
    expect(trace.startsolid).toBe(false);
    // q2repro's SV_Clip sets trace.ent = clip unconditionally, even on a
    // clean miss -- not left null the way a whole-world SV_Trace miss would
    // report the world edict.
    expect(trace.ent).toBe(target);
  });

  test("ignores other entities: a second entity placed directly in the path is not clipped against", () => {
    const target = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -16), vec3(16, 16, 16), vec3(80, 0, 0));
    // blocker sits between the trace start and `target`, but is NOT the
    // entity passed to SV_Clip.
    const blocker = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -16), vec3(16, 16, 16), vec3(0, 0, 0));
    void blocker; // never linked into the area tree and never passed to SV_Clip

    const start = vec3(-40, 0, 0);
    const end = vec3(120, 0, 0);

    // Clip against `target` only: SV_Clip does no SV_AreaEdicts scan, so
    // `blocker`'s geometry (which would stop a whole-world SV_Trace well
    // short of x=64) must have zero effect on this result.
    const trace = SV_Clip(start, null, null, end, target, CONTENTS_MONSTER);

    // target's near face is at world x = 80 - 16 = 64; a whole-world
    // SV_Trace would stop at `blocker`'s far face (x = 16) instead --
    // fraction (24-of-160ths, ~0.15) proves `blocker` had no effect.
    const expectedFraction = (64 - -40) / (end[0] - start[0]);
    expect(trace.fraction).toBeCloseTo(expectedFraction, 2);
    expect(trace.fraction).toBeGreaterThan(0.5); // would be ~0.35 if `blocker` had been hit instead
    // CM_TransformedBoxTrace reports the hit plane in the entity's own local
    // hull space (untranslated by the entity's world origin) -- this is the
    // engine's existing, pre-existing convention (see sv_world.ts's
    // SV_ClipMoveToEntities, which never re-offsets it either), not
    // something this unit introduces. Local dist is the box's own half-size.
    expect(trace.plane.dist).toBeCloseTo(16, 6);
    expect(trace.ent).toBe(target);
  });

  test("clip to a box-sized mover volume: a wider trace box still resolves against the single target entity", () => {
    const target = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -16), vec3(16, 16, 16), vec3(0, 0, 0));

    const start = vec3(-40, 0, 0);
    const end = vec3(40, 0, 0);
    // an 8-unit-radius mover reaches the box's face 8 units earlier
    const trace = SV_Clip(start, vec3(-8, -8, -8), vec3(8, 8, 8), end, target, CONTENTS_MONSTER);

    expect(trace.fraction).toBeLessThan(0.3);
    expect(trace.ent).toBe(target);
  });
});

describe("sv_debugdraw.ts -- buffered debug-draw seam (Draw_* game imports)", () => {
  beforeEach(() => {
    SV_DebugDraw_Clear();
  });

  test("one-shot entries (lifeTime <= 0) are returned by exactly one Drain call", () => {
    SV_DebugDraw_Point(vec3(1, 2, 3), 4, { r: 255, g: 0, b: 0, a: 255 }, 0, false);

    const first = SV_DebugDraw_Drain();
    expect(first).toHaveLength(1);
    expect(first[0].shape.kind).toBe("point");

    const second = SV_DebugDraw_Drain();
    expect(second).toHaveLength(0);
  });

  test("persistent entries (lifeTime > 0) survive Drain until Tick expires them", () => {
    SV_DebugDraw_Line(vec3(0, 0, 0), vec3(1, 0, 0), { r: 0, g: 255, b: 0, a: 255 }, 1 /* seconds */, true);

    expect(SV_DebugDraw_Drain()).toHaveLength(1);

    SV_DebugDraw_Tick(500); // 500ms elapsed of 1000ms lifetime
    expect(SV_DebugDraw_Drain()).toHaveLength(1); // still alive

    SV_DebugDraw_Tick(600); // 1100ms total elapsed -- expired
    expect(SV_DebugDraw_Drain()).toHaveLength(0);
  });

  test("drain order is FIFO insertion order across mixed shape kinds", () => {
    const idLine = SV_DebugDraw_Line(vec3(0, 0, 0), vec3(1, 1, 1), { r: 1, g: 1, b: 1, a: 1 }, 5, false);
    const idBounds = SV_DebugDraw_Bounds(vec3(-1, -1, -1), vec3(1, 1, 1), { r: 2, g: 2, b: 2, a: 2 }, 5, false);
    const idArrow = SV_DebugDraw_Arrow(vec3(0, 0, 0), vec3(2, 2, 2), 3, { r: 3, g: 3, b: 3, a: 3 }, { r: 4, g: 4, b: 4, a: 4 }, 0, false);

    const drained = SV_DebugDraw_Drain();
    expect(drained.map((e) => e.id)).toEqual([idLine, idBounds, idArrow]);
    expect(drained.map((e) => e.shape.kind)).toEqual(["line", "bounds", "arrow"]);
  });

  test("Arrow records both line color and arrow color distinctly", () => {
    const lineColor = { r: 10, g: 20, b: 30, a: 255 };
    const arrowColor = { r: 40, g: 50, b: 60, a: 255 };
    SV_DebugDraw_Arrow(vec3(0, 0, 0), vec3(5, 0, 0), 2, lineColor, arrowColor, 0, true);

    const [entry] = SV_DebugDraw_Drain();
    expect(entry.color).toEqual(lineColor);
    expect(entry.shape.kind).toBe("arrow");
    if (entry.shape.kind === "arrow") {
      expect(entry.shape.arrowColor).toEqual(arrowColor);
    }
    expect(entry.depthTest).toBe(true);
  });

  test("Tick is a no-op on one-shot entries still sitting in the buffer (they expire via Drain, not Tick)", () => {
    SV_DebugDraw_Point(vec3(0, 0, 0), 1, { r: 0, g: 0, b: 0, a: 255 }, 0, false);
    SV_DebugDraw_Tick(999999);
    // still present -- one-shot entries are only removed by the Drain call
    // that returns them, never by Tick.
    expect(SV_DebugDraw_Drain()).toHaveLength(1);
  });
});
