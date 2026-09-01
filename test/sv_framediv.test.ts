/*
Focused unit test for the per-edict origin-history ring added for framediv
interpolation (.orch/phase3-design.md sequencing item 3, mirroring
q2repro's server_entity_t.history[] -- src/server/server.h:120-140 -- and
its recording site, PF_LinkEdict in world.c ~lines 330-335).

Reuses sv_world.test.ts's minimal synthetic-BSP scaffolding since
SV_LinkEdict (sv_world.ts) is the only place the ring is populated today.
Nothing reads the ring yet -- the framediv send path is future work -- so
this test only exercises recording and wraparound, not interpolation.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { EntityStateT } from "../src/shared/q_shared";
import { type Vec3, vec3, VectorCopy } from "../src/shared/math";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import { sv, ENT_HISTORY_SIZE, ENT_HISTORY_MASK } from "../src/server/server";
import { type Edict, LinkT, MAX_ENT_CLUSTERS, SolidT } from "../src/game/game";
import { SV_ClearWorld, SV_LinkEdict } from "../src/server/sv_world";

// Server code touches edicts only through the `Edict` interface (PORTING.md),
// never the game module's private `EdictT`, so this test fabricates plain
// objects satisfying that interface instead of importing g_local.ts's EdictT
// (same approach as sv_world.test.ts).
function makeEdict(solid: SolidT, mins: Vec3, maxs: Vec3, origin: Vec3, number: number): Edict {
  const s = new EntityStateT();
  VectorCopy(origin, s.origin);
  s.number = number;
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

describe("origin-history ring (framediv interpolation) -- recording only", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fd-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);
    writeFileSync(join(mapsDir, "testroom.bsp"), buildBoxRoomBsp());

    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();

    // minimal replication of SV_SpawnServer's sv.models[1] wiring (sv_init.ts),
    // skipped rather than called since it also drives SV_InitGameProgs -- a
    // real implementation now, but a full game module boot this unit test
    // doesn't otherwise need (same rationale as sv_world.test.ts).
    const { model } = CM_LoadMap("maps/testroom.bsp", false);
    sv.models[1] = model;
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    SV_ClearWorld();
    sv.framenum = 0;
  });

  test("SV_LinkEdict records the current origin/framenum into the entity's history ring", () => {
    const ent = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -24), vec3(16, 16, 32), vec3(1, 2, 3), 5);
    sv.framenum = 42;
    SV_LinkEdict(ent);

    const slot = sv.entities[5].history[42 & ENT_HISTORY_MASK];
    expect(slot.framenum).toBe(42);
    expect(Array.from(slot.origin)).toEqual([1, 2, 3]);
  });

  test("the ring wraps after ENT_HISTORY_SIZE frames, overwriting the oldest slot", () => {
    const ent = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -24), vec3(16, 16, 32), vec3(0, 0, 0), 7);

    for (let f = 0; f < ENT_HISTORY_SIZE; f++) {
      sv.framenum = f;
      VectorCopy(vec3(f, f, f), ent.s.origin);
      SV_LinkEdict(ent);
    }

    // slot 0 now holds frame 0's data
    expect(sv.entities[7].history[0].framenum).toBe(0);
    expect(Array.from(sv.entities[7].history[0].origin)).toEqual([0, 0, 0]);

    // one more frame wraps back around to slot 0, overwriting frame 0's entry
    sv.framenum = ENT_HISTORY_SIZE;
    VectorCopy(vec3(99, 99, 99), ent.s.origin);
    SV_LinkEdict(ent);

    expect(sv.entities[7].history[0].framenum).toBe(ENT_HISTORY_SIZE);
    expect(Array.from(sv.entities[7].history[0].origin)).toEqual([99, 99, 99]);

    // every other slot still holds its original frame's data, untouched by the wrap
    for (let f = 1; f < ENT_HISTORY_SIZE; f++) {
      expect(sv.entities[7].history[f].framenum).toBe(f);
    }
  });

  test("distinct edicts get independent history rings, indexed by s.number", () => {
    const a = makeEdict(SolidT.SOLID_BBOX, vec3(-8, -8, -8), vec3(8, 8, 8), vec3(10, 0, 0), 1);
    const b = makeEdict(SolidT.SOLID_BBOX, vec3(-8, -8, -8), vec3(8, 8, 8), vec3(-10, 0, 0), 2);

    sv.framenum = 3;
    SV_LinkEdict(a);
    SV_LinkEdict(b);

    expect(Array.from(sv.entities[1].history[3].origin)).toEqual([10, 0, 0]);
    expect(Array.from(sv.entities[2].history[3].origin)).toEqual([-10, 0, 0]);
  });
});
