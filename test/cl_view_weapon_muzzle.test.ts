/*
Unit tests for the LOCAL player's first-person view-weapon muzzle-flash
MODEL -- the piece the muzzle-flash-MODELS unit (commit 912c058) explicitly
cited as cut ("player view-weapon muzzle model needs viewmodel state in
cl_view"). Two halves, matching q2repro:

  1. WRITE side: cl_fx.ts's CL_ParseMuzzleFlash (effects.c's CL_MuzzleFlash)
     calls a locally-defined CL_AddWeaponMuzzleFX (tent.c:428-448) that
     writes cl.weapon.muzzle -- but ONLY for the local player's own shot
     (mz.entity != cl.frame.clientNum + 1 bails in the C; this port checks
     `entity !== cl.playernum + 1`, this codebase's established equivalent,
     see cl_pred.ts/cl_tent.ts/snd_dma.ts's identical `cl.playernum + 1`
     idiom).

  2. READ side: cl_ents.ts's CL_AddViewWeapon (entities.c:1320-1349) appends
     a second, short-lived (50ms) V_AddEntity call for the flash model,
     positioned via cl.weapon.muzzle.offset projected along the view-weapon
     entity's own forward/right/up, gated on cl_muzzleflashes.

Self-sufficient per .orch/preferences.md rule 13: every test resets
cl/cls/net_message/cl_mod_muzzles/r_entities/the relevant cvars itself, none
relies on execution order or a prior test's state.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { PlayerStateT, MZ_BLASTER, MZ_HEATBEAM, MZ_SHOTGUN2, MZ_BFG2, MZ_PHALANX2, MZ_PROX, MZ_PHALANX, MZ_ETF_RIFLE, MZ_UNUSED } from "../src/shared/q_shared";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { SZ_Clear, MSG_BeginReading, MSG_WriteShort, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";
import { cl, cls, clCvars, cl_entities } from "../src/client/client";
import { V_ClearScene, r_numentities, r_entities } from "../src/client/cl_view";
import { CL_ParseMuzzleFlash } from "../src/client/cl_fx";
import { CL_AddViewWeapon } from "../src/client/cl_ents";
import { MuzzlefxT, cl_mod_muzzles } from "../src/client/cl_tent";

const { MFLASH_BLAST, MFLASH_BEAMER, MFLASH_ETF_RIFLE, MFLASH_BFG, MFLASH_ROCKET, MFLASH_LAUNCH } = MuzzlefxT;

// q2repro inc/shared/shared.h:1264-1301's muzzle-flash enum, ground-truthed
// against the running values of the port's OWN neighboring constants
// (MZ_PHALANX/MZ_UNUSED, both already present before this follow-up) rather
// than hand-transcribed magic numbers.
describe("MZ_BFG2 / MZ_PHALANX2 / MZ_PROX -- q2repro shared.h:1287-1293 exact values", () => {
  test("MZ_BFG2 and MZ_PHALANX2 follow MZ_PHALANX (18) at 19 and 20 (shared.h:1285-1289)", () => {
    expect(MZ_PHALANX).toBe(18);
    expect(MZ_BFG2).toBe(19);
    expect(MZ_PHALANX2).toBe(20);
  });

  test("MZ_PROX shares slot 31 with the vanilla MZ_UNUSED placeholder (shared.h:1292-1293, MZ_ETF_RIFLE=30 explicit)", () => {
    expect(MZ_ETF_RIFLE).toBe(30);
    expect(MZ_PROX).toBe(31);
    expect(MZ_UNUSED).toBe(31);
    expect(MZ_SHOTGUN2).toBe(32);
  });
});

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

function writeMuzzleFlash(ent: number, weapon: number): void {
  MSG_WriteShort(net_message, ent);
  MSG_WriteByte(net_message, weapon);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  cl.clear();
  cls.clear(); // resets cls.csr to CS_REMAP_OLD (classic)
  V_ClearScene();
  resetNetMessage();

  clCvars.cl_muzzleflashes = Cvar_Get("cl_muzzleflashes", "1", 0);
  Cvar_ForceSet("cl_muzzleflashes", "1"); // Cvar_Get returns the same singleton once registered -- force it back on
  clCvars.cl_gun = Cvar_Get("cl_gun", "1", 0);
  Cvar_ForceSet("cl_gun", "1");

  for (let i = 0; i < cl_mod_muzzles.length; i++) cl_mod_muzzles[i] = null;
});

describe("CL_ParseMuzzleFlash -- local-player view-weapon muzzle state (write side)", () => {
  test("local player's own flash writes cl.weapon.muzzle with the right MuzzlefxT model, offset, scale, and lifetime", () => {
    const fakeModel = { name: "fake-v_blast" };
    cl_mod_muzzles[MFLASH_BLAST] = fakeModel;
    cl.playernum = 0; // local player entity number is playernum + 1 == 1
    cl.frame.servertime = 5000;

    writeMuzzleFlash(1, MZ_BLASTER);
    CL_ParseMuzzleFlash();

    // q2repro effects.c:243: CL_AddWeaponMuzzleFX(MFLASH_BLAST, {27.0,7.4,-6.6}, 8.0)
    expect(cl.weapon.muzzle.model).toBe(fakeModel);
    expect(cl.weapon.muzzle.scale).toBeCloseTo(8.0);
    expect(cl.weapon.muzzle.offset[0]).toBeCloseTo(27.0);
    expect(cl.weapon.muzzle.offset[1]).toBeCloseTo(7.4);
    expect(cl.weapon.muzzle.offset[2]).toBeCloseTo(-6.6);
    expect(cl.weapon.muzzle.roll).toBe(0); // MZ_BLASTER isn't MACHN/BEAMER -- no roll randomization
    // tent.c:447: cl.weapon.muzzle.time = cl.servertime - CL_FRAMETIME, mapped
    // to this port's cl.frame.servertime - 100 (same idiom cl_tent.ts's
    // CL_AddMuzzleFX uses for `ex->start`).
    expect(cl.weapon.muzzle.time).toBe(4900);
  });

  test("MZ_HEATBEAM (MFLASH_BEAMER) randomizes roll into [0, 360)", () => {
    cl_mod_muzzles[MFLASH_BEAMER] = { name: "fake-v_beamer" };
    cl.playernum = 0;

    writeMuzzleFlash(1, MZ_HEATBEAM);
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).not.toBeNull();
    expect(cl.weapon.muzzle.roll).toBeGreaterThanOrEqual(0);
    expect(cl.weapon.muzzle.roll).toBeLessThan(360);
  });

  test("non-local player's flash does NOT touch cl.weapon.muzzle", () => {
    cl_mod_muzzles[MFLASH_BLAST] = { name: "fake-v_blast" };
    cl.playernum = 5; // local player entity is 6

    writeMuzzleFlash(1, MZ_BLASTER); // entity 1 -- some OTHER player, not local
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).toBeNull();
  });

  test("cl_muzzleflashes 0 suppresses the write even for the local player", () => {
    Cvar_ForceSet("cl_muzzleflashes", "0");
    cl_mod_muzzles[MFLASH_BLAST] = { name: "fake-v_blast" };
    cl.playernum = 0;

    writeMuzzleFlash(1, MZ_BLASTER);
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).toBeNull();
  });

  test("no registered model (cl_mod_muzzles[fx] still null) leaves cl.weapon.muzzle untouched", () => {
    cl.playernum = 0;
    // cl_mod_muzzles[MFLASH_BLAST] deliberately left null (beforeEach's reset)
    writeMuzzleFlash(1, MZ_BLASTER);
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).toBeNull();
  });

  test("MZ_SHOTGUN2 only gets a flash model under the extended (kex) family, matching q2repro effects.c:366-376", () => {
    cl_mod_muzzles[MFLASH_ETF_RIFLE] = { name: "fake-v_etf_rifle" };
    cl.playernum = 0;

    // Classic family (default cls.csr from cls.clear()): no flash model.
    expect(cls.csr).toBe(CS_REMAP_OLD);
    writeMuzzleFlash(1, MZ_SHOTGUN2);
    CL_ParseMuzzleFlash();
    expect(cl.weapon.muzzle.model).toBeNull();

    // Extended (kex) family: flash model IS written.
    cls.csr = CS_REMAP_RERELEASE;
    resetNetMessage();
    writeMuzzleFlash(1, MZ_SHOTGUN2);
    CL_ParseMuzzleFlash();
    expect(cl.weapon.muzzle.model).toBe(cl_mod_muzzles[MFLASH_ETF_RIFLE]);
    expect(cl.weapon.muzzle.offset[1]).toBeCloseTo(4.0); // {24.0, 4.0, -5.5} -- the extended-only offset, distinct from MZ_ETF_RIFLE's {24.0, 5.25, -5.5}
  });

  test("MZ_BFG2 writes MFLASH_BFG at q2repro effects.c:321-324's offset/scale (distinct from MZ_BFG, which has no flash model)", () => {
    const fakeModel = { name: "fake-v_bfg" };
    cl_mod_muzzles[MFLASH_BFG] = fakeModel;
    cl.playernum = 0;

    writeMuzzleFlash(1, MZ_BFG2);
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).toBe(fakeModel);
    expect(cl.weapon.muzzle.scale).toBeCloseTo(16.0);
    expect(cl.weapon.muzzle.offset[0]).toBeCloseTo(18.0);
    expect(cl.weapon.muzzle.offset[1]).toBeCloseTo(8.0);
    expect(cl.weapon.muzzle.offset[2]).toBeCloseTo(-7.5);
  });

  test("MZ_PHALANX2 writes MFLASH_ROCKET at q2repro effects.c:345-348's offset/scale (distinct from MZ_PHALANX, which has no flash model)", () => {
    const fakeModel = { name: "fake-v_rocket" };
    cl_mod_muzzles[MFLASH_ROCKET] = fakeModel;
    cl.playernum = 0;

    writeMuzzleFlash(1, MZ_PHALANX2);
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).toBe(fakeModel);
    expect(cl.weapon.muzzle.scale).toBeCloseTo(9.0);
    expect(cl.weapon.muzzle.offset[0]).toBeCloseTo(18.0);
    expect(cl.weapon.muzzle.offset[1]).toBeCloseTo(10.0);
    expect(cl.weapon.muzzle.offset[2]).toBeCloseTo(-6.0);
  });

  test("MZ_PROX writes MFLASH_LAUNCH at q2repro effects.c:355-360's offset/scale", () => {
    const fakeModel = { name: "fake-v_launch" };
    cl_mod_muzzles[MFLASH_LAUNCH] = fakeModel;
    cl.playernum = 0;

    writeMuzzleFlash(1, MZ_PROX);
    CL_ParseMuzzleFlash();

    expect(cl.weapon.muzzle.model).toBe(fakeModel);
    expect(cl.weapon.muzzle.scale).toBeCloseTo(9.0);
    expect(cl.weapon.muzzle.offset[0]).toBeCloseTo(18.0);
    expect(cl.weapon.muzzle.offset[1]).toBeCloseTo(6.0);
    expect(cl.weapon.muzzle.offset[2]).toBeCloseTo(-6.5);
  });
});

describe("CL_AddViewWeapon -- view-weapon muzzle flash render pass (read side)", () => {
  function baseViewSetup(): { ps: PlayerStateT; ops: PlayerStateT } {
    const ps = new PlayerStateT();
    const ops = new PlayerStateT();
    ps.gunindex = 1;
    ops.gunindex = 1;
    cl.model_draw[1] = { name: "fake-view-weapon" };
    cl.refdef.vieworg[0] = 100;
    cl.refdef.vieworg[1] = 200;
    cl.refdef.vieworg[2] = 300;
    // angles all zero on both ps/ops/viewangles: AngleVectors(0,0,0) gives a
    // known, hand-computable forward/right/up (forward=(1,0,0),
    // right=(0,-1,0), up=(0,0,1)), so the offset projection below is exact.
    cl.lerpfrac = 1;
    return { ps, ops };
  }

  test("no muzzle state set: only the base view-weapon entity is added, no crash", () => {
    const { ps, ops } = baseViewSetup();
    CL_AddViewWeapon(ps, ops);

    expect(r_numentities).toBe(1);
    expect(r_entities[0]?.model).toBe(cl.model_draw[1]);
  });

  test("fresh muzzle flash within the 50ms window appends a second entity, positioned via offset/forward/right/up and flagged fullbright+translucent", () => {
    const { ps, ops } = baseViewSetup();
    const muzzleModel = { name: "fake-v_blast-flash" };
    cl.weapon.muzzle.model = muzzleModel;
    cl.weapon.muzzle.scale = 8.0;
    cl.weapon.muzzle.roll = 33;
    cl.weapon.muzzle.offset[0] = 10;
    cl.weapon.muzzle.offset[1] = 5;
    cl.weapon.muzzle.offset[2] = -2;
    cl.weapon.muzzle.time = 900;
    cl.time = 920; // 20ms elapsed, inside the 50ms window (entities.c:1324)

    CL_AddViewWeapon(ps, ops);

    expect(r_numentities).toBe(2);
    const flash = r_entities[1];
    expect(flash?.model).toBe(muzzleModel);
    expect(flash?.alpha).toBe(1.0);
    expect(flash?.skinnum).toBe(0);
    expect(flash?.backlerp).toBe(0);
    expect(flash?.frame).toBe(0);
    expect(flash?.oldframe).toBe(0);
    // RF_FULLBRIGHT(8) | RF_DEPTHHACK(16) | RF_WEAPONMODEL(4) | RF_TRANSLUCENT(32) == 60
    expect(flash?.flags).toBe(60);

    // gun.origin starts at cl.refdef.vieworg == (100,200,300) (zero
    // gunoffset/lerp), then offset (10,5,-2) projected along
    // forward=(1,0,0), right=(0,-1,0), up=(0,0,1):
    // (100+10*1, 200+5*-1, 300+ -2*1) == (110, 195, 298)
    expect(flash?.origin[0]).toBeCloseTo(110);
    expect(flash?.origin[1]).toBeCloseTo(195);
    expect(flash?.origin[2]).toBeCloseTo(298);

    // gun.angles is overwritten to cl.refdef.viewangles (0,0,0) plus roll on Z.
    expect(flash?.angles[0]).toBeCloseTo(0);
    expect(flash?.angles[1]).toBeCloseTo(0);
    expect(flash?.angles[2]).toBeCloseTo(33);

    // cl.weapon.muzzle state is untouched (still live) while inside the window.
    expect(cl.weapon.muzzle.model).toBe(muzzleModel);
  });

  test("expired muzzle flash (>50ms elapsed) is NOT rendered and clears cl.weapon.muzzle.model", () => {
    const { ps, ops } = baseViewSetup();
    cl.weapon.muzzle.model = { name: "fake-stale-flash" };
    cl.weapon.muzzle.time = 900;
    cl.time = 1000; // 100ms elapsed > 50ms (entities.c:1324-1327)

    CL_AddViewWeapon(ps, ops);

    expect(r_numentities).toBe(1); // only the base view-weapon entity
    expect(cl.weapon.muzzle.model).toBeNull();
  });

  test("cl_gun 0 suppresses the whole view-weapon pass, including any pending muzzle flash", () => {
    const { ps, ops } = baseViewSetup();
    Cvar_ForceSet("cl_gun", "0");
    cl.weapon.muzzle.model = { name: "fake-flash" };
    cl.weapon.muzzle.time = 900;
    cl.time = 910;

    CL_AddViewWeapon(ps, ops);

    expect(r_numentities).toBe(0);
    // muzzle state itself is untouched -- the function bailed before reaching it
    expect(cl.weapon.muzzle.model).not.toBeNull();
  });
});
