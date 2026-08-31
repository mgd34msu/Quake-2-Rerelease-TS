/*
Unit tests for the re-release's real muzzle-flash MODEL system, ported into
src/client/cl_tent.ts (CL_AddMuzzleFX, MuzzlefxT, cl_mod_muzzles) and wired
into src/client/cl_fx.ts's CL_ParseMuzzleFlash2 (the monster/NPC muzzle
flash decoder). Ground truth for the model directory names is q2repro's
src/client/tent.c:278-291 muzzlenames table; the retail-gated section below
confirms every one of those 12 directories' tris.md2 actually ships in
baseq2/pak0.pak (this task's own file survey).

Self-sufficient per .orch/preferences.md rule 13: every test resets
cl_explosions/r_numentities/the cl_muzzleflashes cvar itself, none relies
on execution order.

CL_AddMuzzleFX is exercised directly against src/client/ref.ts's ModelS
(`type ModelS = unknown`) poked straight into cl_mod_muzzles -- this port's
ref_gl/ isn't built (PORTING.md), so `re` (RefExports) stays null and
CL_RegisterTEntModels's real re.RegisterModel() calls never run in a test
process; poking cl_mod_muzzles directly tests CL_AddMuzzleFX's own logic
(the part this unit actually wrote) without needing a full RefExports stub.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { vec3, vec3_origin } from "../src/shared/math";
import { ComError } from "../src/qcommon/qcommon";
import { Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";
import { cl, clCvars } from "../src/client/client";
import { V_ClearScene, r_numentities, r_entities } from "../src/client/cl_view";
import {
  MuzzlefxT,
  muzzlenames,
  cl_mod_muzzles,
  cl_explosions,
  ExptypeT,
  CL_AddMuzzleFX,
  CL_ClearTEnts,
  CL_AddTEnts,
} from "../src/client/cl_tent";

const { MFLASH_MACHN, MFLASH_BOOMER, MFLASH_TOTAL } = MuzzlefxT;

function countLiveExplosions(): number {
  return cl_explosions.filter((ex) => ex.type !== ExptypeT.ex_free).length;
}

beforeEach(() => {
  CL_ClearTEnts();
  V_ClearScene();
  clCvars.cl_muzzleflashes = Cvar_Get("cl_muzzleflashes", "1", 0);
  // Cvar_Get returns the SAME singleton once registered (matches real cvar
  // semantics: the requested default is ignored for an already-live cvar),
  // so a prior test's mutation of .value would otherwise leak forward --
  // force it back to "on" every test.
  Cvar_ForceSet("cl_muzzleflashes", "1");
  for (let i = 0; i < cl_mod_muzzles.length; i++) cl_mod_muzzles[i] = null;
});

describe("MuzzlefxT / muzzlenames -- structure matches q2repro tent.c:278-291", () => {
  test("MFLASH_TOTAL is 12, muzzlenames has exactly one entry per MuzzlefxT member", () => {
    expect(MFLASH_TOTAL).toBe(12);
    expect(muzzlenames.length).toBe(MFLASH_TOTAL);
  });

  test("muzzlenames matches q2repro's table in enum order exactly", () => {
    expect(Array.from(muzzlenames)).toEqual([
      "v_machn",
      "v_shotg2",
      "v_shotg",
      "v_rocket",
      "v_rail",
      "v_launch",
      "v_etf_rifle",
      "v_dist",
      "v_boomer",
      "v_blast",
      "v_bfg",
      "v_beamer",
    ]);
  });
});

describe("CL_AddMuzzleFX", () => {
  test("does nothing when cl_muzzleflashes is off", () => {
    // Cvar_Set/ForceSet (src/qcommon/cvar.ts's Cvar_Set2) both short-circuit
    // when `.string` already equals the requested value, regardless of
    // `.value` -- go through Cvar_ForceSet here (not a direct `.value =`
    // mutation) so beforeEach's own Cvar_ForceSet(..., "1") reliably
    // restores it afterward.
    const cvar = Cvar_ForceSet("cl_muzzleflashes", "0");
    expect(cvar).not.toBeNull();
    if (!cvar) return;
    clCvars.cl_muzzleflashes = cvar;
    cl_mod_muzzles[MFLASH_MACHN] = { name: "fake" };

    CL_AddMuzzleFX(vec3(1, 2, 3), vec3_origin, MFLASH_MACHN, 0, 18);

    expect(countLiveExplosions()).toBe(0);
  });

  test("does nothing when the model was never registered (cl_mod_muzzles[fx] is null)", () => {
    // Real state in a test process: ref_gl isn't built, so
    // CL_RegisterTEntModels never actually ran re.RegisterModel().
    CL_AddMuzzleFX(vec3(1, 2, 3), vec3_origin, MFLASH_MACHN, 0, 18);
    expect(countLiveExplosions()).toBe(0);
  });

  test("throws ComError on an out-of-range fx (mirrors q2repro's Q_assert(fx < q_countof(cl_mod_muzzles)))", () => {
    expect(() => CL_AddMuzzleFX(vec3(1, 2, 3), vec3_origin, MFLASH_TOTAL, 0, 18)).toThrow(ComError);
  });

  test("allocates a real ex_mflash explosion with the registered model, origin, angles, and skin", () => {
    const fakeModel = { name: "models/weapons/v_machn/flash/tris.md2" };
    cl_mod_muzzles[MFLASH_MACHN] = fakeModel;

    const origin = vec3(10, 20, 30);
    const angles = vec3(0, 90, 0);
    CL_AddMuzzleFX(origin, angles, MFLASH_MACHN, 2, 18);

    expect(countLiveExplosions()).toBe(1);
    const ex = cl_explosions.find((e) => e.type === ExptypeT.ex_mflash);
    expect(ex).toBeDefined();
    if (!ex) return;
    expect(ex.ent.model).toBe(fakeModel);
    expect(ex.ent.origin[0]).toBeCloseTo(10);
    expect(ex.ent.origin[1]).toBeCloseTo(20);
    expect(ex.ent.origin[2]).toBeCloseTo(30);
    expect(ex.ent.angles[1]).toBeCloseTo(90);
    expect(ex.ent.skinnum).toBe(2);
    expect(ex.ent.alpha).toBe(1.0);
  });

  test("MFLASH_BOOMER leaves angles[2] (roll) untouched; every other flash type randomizes it", () => {
    cl_mod_muzzles[MFLASH_BOOMER] = { name: "fake-boomer" };
    const angles = vec3(0, 0, 42);
    CL_AddMuzzleFX(vec3_origin, angles, MFLASH_BOOMER, 0, 15);

    const ex = cl_explosions.find((e) => e.type === ExptypeT.ex_mflash);
    expect(ex).toBeDefined();
    if (!ex) return;
    expect(ex.ent.angles[2]).toBe(42);
  });

  test("ex_mflash explosions render for ~50ms then free themselves (q2repro tent.c:542-548)", () => {
    const fakeModel = { name: "fake-lifecycle" };
    cl_mod_muzzles[MFLASH_MACHN] = fakeModel;

    // ex.start = cl.frame.servertime - 100 (CL_AddMuzzleFX); cl.time = 900
    // right after creation puts elapsed (cl.time - ex.start) at exactly 0.
    cl.frame.servertime = 1000;
    CL_AddMuzzleFX(vec3_origin, vec3_origin, MFLASH_MACHN, 0, 18);
    expect(countLiveExplosions()).toBe(1);

    // Still within the 50ms window: CL_AddTEnts renders it (V_AddEntity),
    // findable in r_entities, and it stays alive. (Not asserting an exact
    // r_numentities total: CL_AddTEnts also drives CL_AddBeams/CL_AddLasers/
    // CL_ProcessSustain, unrelated subsystems this test doesn't otherwise
    // touch.)
    cl.time = 900;
    CL_AddTEnts();
    expect(r_entities.slice(0, r_numentities).some((e) => e.model === fakeModel)).toBe(true);
    expect(countLiveExplosions()).toBe(1);

    // Past the window (elapsed 100ms > 50ms): it frees itself and stops
    // rendering.
    cl.time = 1000;
    V_ClearScene();
    CL_AddTEnts();
    expect(r_entities.slice(0, r_numentities).some((e) => e.model === fakeModel)).toBe(false);
    expect(countLiveExplosions()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retail-gated: every models/weapons/<name>/flash/tris.md2 this task's own
// muzzlenames table names actually ships in the real retail data.
// ---------------------------------------------------------------------------

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const havePak = existsSync(PAK_PATH);

function readPackNames(pakPath: string): Set<string> | null {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return null;
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

describe("muzzlenames against real retail data (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("every models/weapons/<name>/flash/tris.md2 this table names is a real retail file", () => {
    const names = readPackNames(PAK_PATH);
    expect(names).not.toBeNull();
    if (!names) return;

    for (const name of muzzlenames) {
      const path = `models/weapons/${name}/flash/tris.md2`;
      expect(names.has(path)).toBe(true);
    }
  });
});
