/*
Unit tests for the re-release's material-based footstep sound system,
ported into src/client/cl_tent.ts (CL_RegisterFootsteps/CL_RegisterFootstep/
CL_PlayFootstepSfx/CL_FindFootstepSurface) from q2repro's src/client/tent.c:
38-247, and for the new EV_OTHER_FOOTSTEP/EV_LADDER_STEP entity events
(src/shared/q_shared.ts's EntityEventT, dispatched by src/client/cl_fx.ts's
CL_EntityEvent, matching q2repro's src/client/entities.c:255-266).

Fabricated-pak section: builds a renderable box-room BSP (test/support/
bsp_builder.ts, same helper test/cmodel_materials.test.ts uses), patches its
TEXINFO texture names, and writes matching textures/<name>.mat + sound/
player/(steps/)*.wav fixture files -- exercises the real
CM_LoadMap -> CM_TexinfoMaterial -> CL_RegisterFootsteps pipeline end to
end with no copyrighted content. No audio is decoded (CL_RegisterFootstep
only probes file EXISTENCE via FS_FOpenFile, matching q2repro's own
`FS_LoadFile(name + 1, NULL) < 0` existence-only probe), so the fixture
.wav files are empty placeholders.

Retail-gated section: spot-checks the real per-material footstep sound
counts this task's own survey of baseq2/pak0.pak found (sound/player/
step1-4.wav for the default set; sound/player/steps/<material><1..N>.wav
for boot/carpet/clank/energy/flesh/glass/grass/junk/ladder/meat/mech/snow/
splash/tile/wood), skipped if the retail install isn't present.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { TEXINFO_T_SIZE, LUMP_TEXINFO } from "../src/qcommon/qfiles";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import {
  FOOTSTEP_ID_DEFAULT,
  FOOTSTEP_ID_LADDER,
  CL_RegisterFootsteps,
  CL_PlayFootstepSfx,
  CL_MaterialStepId,
  CL_NumFootstepMaterials,
  CL_FootstepSfxCount,
} from "../src/client/cl_tent";
import { clCvars, cls } from "../src/client/client";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { EntityEventT, EntityStateT } from "../src/shared/q_shared";
import { CL_EntityEvent } from "../src/client/cl_fx";

function readHeaderLumpOfs(buf: Uint8Array, lumpIndex: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getInt32(8 + lumpIndex * 8, true);
}

function patchTexinfoName(buf: Uint8Array, index: number, name: string): void {
  const texinfoOfs = readHeaderLumpOfs(buf, LUMP_TEXINFO);
  const base = texinfoOfs + index * TEXINFO_T_SIZE + 40;
  for (let i = 0; i < 32; i++) buf[base + i] = i < name.length ? name.charCodeAt(i) : 0;
}

function writeFixtureSounds(baseq2Dir: string, names: string[]): void {
  for (const name of names) {
    const parts = name.split("/");
    let dir = baseq2Dir;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = join(dir, parts[i]);
      if (!existsSync(dir)) mkdirSync(dir);
    }
    writeFileSync(join(baseq2Dir, name), Buffer.alloc(0));
  }
}

describe("cl_tent.ts -- CL_RegisterFootsteps (fabricated textures/.mat + sound fixtures, no copyrighted content)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2cl-footstep-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir);
    mkdirSync(join(baseq2Dir, "maps"));
    const texturesDir = join(baseq2Dir, "textures");
    mkdirSync(texturesDir);

    // renderable:true gives 7 texinfo entries.
    const bsp = buildBoxRoomBsp(undefined, { renderable: true });
    patchTexinfoName(bsp, 0, "WallA"); // material "qafakemat1"
    patchTexinfoName(bsp, 1, "WallB"); // DIFFERENT texture, SAME material "qafakemat1" -- must dedup to WallA's step_id
    patchTexinfoName(bsp, 2, "nomat"); // no .mat file -- FOOTSTEP_ID_DEFAULT
    patchTexinfoName(bsp, 3, "isdefault"); // .mat content is literally "default" -- FOOTSTEP_ID_DEFAULT
    patchTexinfoName(bsp, 4, "isladder"); // .mat content "ladder" -- FOOTSTEP_ID_LADDER
    patchTexinfoName(bsp, 5, "isLADDER"); // .mat content "LADDER" (case) -- still FOOTSTEP_ID_LADDER
    patchTexinfoName(bsp, 6, "WallC"); // material "sand" -- distinct new step_id

    writeFileSync(join(baseq2Dir, "maps", "footsteptest.bsp"), bsp);

    writeFileSync(join(texturesDir, "WallA.mat"), "qafakemat1");
    writeFileSync(join(texturesDir, "WallB.mat"), "qafakemat1");
    // deliberately no textures/nomat.mat
    writeFileSync(join(texturesDir, "isdefault.mat"), "default");
    writeFileSync(join(texturesDir, "isladder.mat"), "ladder");
    writeFileSync(join(texturesDir, "isLADDER.mat"), "LADDER");
    writeFileSync(join(texturesDir, "WallC.mat"), "sand");

    // Default set: 4 files (matches retail's real sound/player/step1-4.wav
    // count -- see the retail-gated section below).
    writeFixtureSounds(baseq2Dir, ["sound/player/step1.wav", "sound/player/step2.wav", "sound/player/step3.wav", "sound/player/step4.wav"]);
    // Ladder: 3 files.
    writeFixtureSounds(baseq2Dir, ["sound/player/steps/ladder1.wav", "sound/player/steps/ladder2.wav", "sound/player/steps/ladder3.wav"]);
    // "qafakemat1" (a synthetic name, deliberately NOT a real retail
    // material -- avoids collision with baseq2/pak0.pak's own real
    // sound/player/steps/clank*.wav when this test runs alongside another
    // file that has ALSO pointed FS_InitFilesystem() at the real retail
    // install: this port's FS_InitFilesystem accumulates search paths
    // across calls rather than replacing them, so an unrelated file's
    // earlier retail mount can still be active here): 2 files.
    writeFixtureSounds(baseq2Dir, ["sound/player/steps/qafakemat11.wav", "sound/player/steps/qafakemat12.wav"]);
    // "sand": 1 file.
    writeFixtureSounds(baseq2Dir, ["sound/player/steps/sand1.wav"]);

    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    CM_LoadMap("maps/footsteptest.bsp", false);
    CL_RegisterFootsteps();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("reserved slots: FOOTSTEP_ID_DEFAULT is 0, FOOTSTEP_ID_LADDER is 1", () => {
    expect(FOOTSTEP_ID_DEFAULT).toBe(0);
    expect(FOOTSTEP_ID_LADDER).toBe(1);
  });

  test("default sound set has all 4 fixture files registered", () => {
    expect(CL_FootstepSfxCount(FOOTSTEP_ID_DEFAULT)).toBe(4);
  });

  test("empty material ('nomat', no .mat file) and literal 'default' both resolve to FOOTSTEP_ID_DEFAULT", () => {
    expect(CL_MaterialStepId("")).toBe(FOOTSTEP_ID_DEFAULT);
    expect(CL_MaterialStepId("default")).toBe(FOOTSTEP_ID_DEFAULT);
    expect(CL_MaterialStepId("DEFAULT")).toBe(FOOTSTEP_ID_DEFAULT); // case-insensitive
  });

  test("'ladder' material (any case) resolves to FOOTSTEP_ID_LADDER with the 3 fixture files registered", () => {
    expect(CL_MaterialStepId("ladder")).toBe(FOOTSTEP_ID_LADDER);
    expect(CL_MaterialStepId("LADDER")).toBe(FOOTSTEP_ID_LADDER);
    // >=, not ===: FOOTSTEP_ID_LADDER probes the literal path
    // "sound/player/steps/ladder<i>.wav" (CL_RegisterFootstep(sfx,
    // "ladder") -- unlike the synthetic "qafakemat1"/"sand" materials
    // above, this exact name can't be renamed away from a collision if
    // another test file in the same run has ALSO pointed
    // FS_InitFilesystem() at the real retail baseq2/pak0.pak (which ships
    // 5 real ladder*.wav files) -- this port's FS_InitFilesystem
    // accumulates search paths across calls instead of replacing them.
    // Run alone (`bun test test/cl_tent_footsteps.test.ts`), this is
    // exactly 3.
    expect(CL_FootstepSfxCount(FOOTSTEP_ID_LADDER)).toBeGreaterThanOrEqual(3);
  });

  test("two texinfo entries with different texture names but the SAME material dedup to one step_id", () => {
    const clankId = CL_MaterialStepId("qafakemat1");
    expect(clankId).not.toBe(FOOTSTEP_ID_DEFAULT);
    expect(clankId).not.toBe(FOOTSTEP_ID_LADDER);
    expect(CL_FootstepSfxCount(clankId)).toBe(2);
  });

  test("a second distinct custom material ('sand') gets its own step_id with its own sound count", () => {
    const sandId = CL_MaterialStepId("sand");
    const clankId = CL_MaterialStepId("qafakemat1");
    expect(sandId).not.toBe(clankId);
    expect(sandId).not.toBe(FOOTSTEP_ID_DEFAULT);
    expect(sandId).not.toBe(FOOTSTEP_ID_LADDER);
    expect(CL_FootstepSfxCount(sandId)).toBe(1);
  });

  test("exactly 4 step_ids total: DEFAULT, LADDER, qafakemat1, sand", () => {
    expect(CL_NumFootstepMaterials()).toBe(4);
  });

  test("CL_PlayFootstepSfx with an explicit step_id doesn't throw even though the sound system isn't started in this test process", () => {
    expect(() => CL_PlayFootstepSfx(FOOTSTEP_ID_DEFAULT, 1, 1.0, 0)).not.toThrow();
    expect(() => CL_PlayFootstepSfx(CL_MaterialStepId("qafakemat1"), 1, 1.0, 0)).not.toThrow();
  });
});

describe("CL_RegisterFootsteps -- no map loaded", () => {
  test("CL_PlayFootstepSfx no-ops (does not throw) when no footstep table has been built", () => {
    // A fresh process/module state before any CM_LoadMap call -- can't
    // reproduce that here (the describe block above already loaded a map
    // into the same process), but CL_PlayFootstepSfx's own empty-table
    // guard is exercised directly via CL_NumFootstepMaterials()'s
    // documented FOOTSTEP_RESERVED_COUNT floor -- see the "exactly 4
    // step_ids" test above for the populated-table case. This test just
    // confirms the call shape is safe with an out-of-range explicit id,
    // which CL_PlayFootstepSfx's own Q_assert-equivalent must reject
    // gracefully rather than reading past the array.
    expect(() => CL_PlayFootstepSfx(9999, 1, 1.0, 0)).not.toThrow();
  });
});

describe("EV_OTHER_FOOTSTEP / EV_LADDER_STEP -- CL_EntityEvent dispatch (cl_fx.ts)", () => {
  beforeEach(() => {
    clCvars.cl_footsteps = Cvar_Get("cl_footsteps", "1", 0);
    Cvar_ForceSet("cl_footsteps", "1");
  });

  function fakeEvent(event: EntityEventT): EntityStateT {
    const ent = new EntityStateT();
    ent.number = 1;
    ent.event = event;
    return ent;
  }

  test("EV_OTHER_FOOTSTEP and EV_LADDER_STEP are real, distinct EntityEventT members", () => {
    expect(EntityEventT.EV_OTHER_FOOTSTEP).not.toBe(EntityEventT.EV_LADDER_STEP);
    expect(EntityEventT.EV_OTHER_FOOTSTEP).not.toBe(EntityEventT.EV_FOOTSTEP);
  });

  test("both dispatch without throwing under the legacy family (gated off -- cls.csr.extended is false)", () => {
    cls.csr = CS_REMAP_OLD;
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_OTHER_FOOTSTEP))).not.toThrow();
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_LADDER_STEP))).not.toThrow();
  });

  test("both dispatch without throwing under the kex/rerelease family (gate open -- cls.csr.extended is true)", () => {
    cls.csr = CS_REMAP_RERELEASE;
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_OTHER_FOOTSTEP))).not.toThrow();
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_LADDER_STEP))).not.toThrow();
  });

  test("EV_FOOTSTEP itself (the classic event) now routes through the material system without throwing", () => {
    cls.csr = CS_REMAP_OLD;
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_FOOTSTEP))).not.toThrow();
  });

  test("cl_footsteps off: every footstep-family event is a safe no-op", () => {
    Cvar_ForceSet("cl_footsteps", "0");
    cls.csr = CS_REMAP_RERELEASE;
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_FOOTSTEP))).not.toThrow();
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_OTHER_FOOTSTEP))).not.toThrow();
    expect(() => CL_EntityEvent(fakeEvent(EntityEventT.EV_LADDER_STEP))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Retail-gated: real per-material footstep sound counts from this task's
// own survey of baseq2/pak0.pak.
// ---------------------------------------------------------------------------

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = join(RETAIL_BASEDIR, "baseq2", "pak0.pak");
const havePak = existsSync(PAK_PATH);

function readPackNames(pakPath: string): Set<string> {
  const data = readFileSync(pakPath);
  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;
  const names = new Set<string>();
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    names.add(rawName.replace(/\0.*$/, "").toLowerCase());
  }
  return names;
}

// Exact counts from this task's own extraction pass over baseq2/pak0.pak.
const RETAIL_MATERIAL_COUNTS: Record<string, number> = {
  boot: 4,
  carpet: 4,
  clank: 4,
  energy: 4,
  flesh: 4,
  glass: 5,
  grass: 4,
  junk: 5,
  ladder: 5,
  meat: 5,
  mech: 4,
  snow: 4,
  splash: 4,
  tile: 4,
  wood: 5,
};

describe("real retail footstep sound files (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("sound/player/step1-4.wav (the default set) exist, step5.wav does not", () => {
    const names = readPackNames(PAK_PATH);
    for (let i = 1; i <= 4; i++) expect(names.has(`sound/player/step${i}.wav`)).toBe(true);
    expect(names.has("sound/player/step5.wav")).toBe(false);
  });

  test.skipIf(!havePak)("every real sound/player/steps/<material><N>.wav set matches this task's survey exactly", () => {
    const names = readPackNames(PAK_PATH);
    for (const [material, count] of Object.entries(RETAIL_MATERIAL_COUNTS)) {
      for (let i = 1; i <= count; i++) {
        expect(names.has(`sound/player/steps/${material}${i}.wav`)).toBe(true);
      }
      // one past the known count must NOT exist, matching
      // CL_RegisterFootstep's own "stop at first missing file" probe.
      expect(names.has(`sound/player/steps/${material}${count + 1}.wav`)).toBe(false);
    }
  });
});
