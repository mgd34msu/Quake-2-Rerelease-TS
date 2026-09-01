/*
Integration test: loads a synthetic BSP (built by test/support/bsp_builder.ts,
no copyrighted map data), wires it into `sv.models[1]` the same minimal way
SV_SpawnServer does (without calling SV_SpawnServer itself -- sv_game.ts's
SV_InitGameProgs is a real implementation now, but driving it here would
need a full game module boot this unit test doesn't otherwise require),
and exercises the area-node BSP: SV_ClearWorld/SV_LinkEdict/SV_UnlinkEdict/
SV_AreaEdicts/SV_PointContents/SV_Trace.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { AREA_SOLID, AREA_TRIGGERS, CONTENTS_MONSTER, EntityStateT } from "../src/shared/q_shared";
import { type Vec3, vec3, VectorCopy } from "../src/shared/math";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import { sv } from "../src/server/server";
import { type Edict, LinkT, MAX_ENT_CLUSTERS, SolidT } from "../src/game/game";
import { SV_AreaEdicts, SV_ClearWorld, SV_LinkEdict, SV_PointContents, SV_Trace, SV_UnlinkEdict } from "../src/server/sv_world";

// Server code touches edicts only through the `Edict` interface (PORTING.md),
// never the game module's private `EdictT`, so tests fabricate plain objects
// satisfying that interface instead of importing g_local.ts's EdictT.
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

describe("sv_world.ts -- area tree, entity linking, point contents, traces", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2sw-"));
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
    // doesn't otherwise need.
    const { model } = CM_LoadMap("maps/testroom.bsp", false);
    sv.models[1] = model;
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    SV_ClearWorld();
  });

  test("SV_LinkEdict + SV_AreaEdicts: a solid-bbox edict inside the room is returned for AREA_SOLID", () => {
    const ent = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -24), vec3(16, 16, 32), vec3(0, 0, 0));
    SV_LinkEdict(ent);

    const list: Edict[] = new Array(16);
    const count = SV_AreaEdicts(vec3(-40, -40, -40), vec3(40, 40, 40), list, 16, AREA_SOLID);

    expect(count).toBeGreaterThanOrEqual(1);
    expect(list.slice(0, count)).toContain(ent);
  });

  test("SV_PointContents inside the linked bbox edict reports the box-hull's contents", () => {
    const ent = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -24), vec3(16, 16, 32), vec3(0, 0, 0));
    SV_LinkEdict(ent);

    // deep interior of the room, well clear of the +-64 walls -- also
    // deep inside the fabricated bbox edict itself
    const contents = SV_PointContents(vec3(0, 0, 0));
    expect(contents & CONTENTS_MONSTER).toBe(CONTENTS_MONSTER); // CM_InitBoxHull's box brush contents
  });

  test("SV_Trace stops on a linked solid edict, and passes through after SV_UnlinkEdict", () => {
    const ent = makeEdict(SolidT.SOLID_BBOX, vec3(-16, -16, -24), vec3(16, 16, 32), vec3(0, 0, 0));
    SV_LinkEdict(ent);

    const start = vec3(-40, 0, 0);
    const end = vec3(40, 0, 0);

    const blocked = SV_Trace(start, null, null, end, null, CONTENTS_MONSTER);
    expect(blocked.fraction).toBeLessThan(1);
    expect(blocked.ent).toBe(ent);

    SV_UnlinkEdict(ent);

    const clear = SV_Trace(start, null, null, end, null, CONTENTS_MONSTER);
    expect(clear.fraction).toBe(1);
  });

  test("a SOLID_TRIGGER edict is filed under AREA_TRIGGERS, not AREA_SOLID", () => {
    const trigger = makeEdict(SolidT.SOLID_TRIGGER, vec3(-8, -8, -8), vec3(8, 8, 8), vec3(20, 20, 0));
    SV_LinkEdict(trigger);

    const solidList: Edict[] = new Array(16);
    const solidCount = SV_AreaEdicts(vec3(-40, -40, -40), vec3(40, 40, 40), solidList, 16, AREA_SOLID);
    expect(solidList.slice(0, solidCount)).not.toContain(trigger);

    const triggerList: Edict[] = new Array(16);
    const triggerCount = SV_AreaEdicts(vec3(-40, -40, -40), vec3(40, 40, 40), triggerList, 16, AREA_TRIGGERS);
    expect(triggerList.slice(0, triggerCount)).toContain(trigger);
  });
});
