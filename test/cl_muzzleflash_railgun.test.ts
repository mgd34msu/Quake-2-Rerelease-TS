// Divergence-audit wave-B partial fix for the "No muzzle-flash models"
// visible-wrong finding: q2repro effects.c:301-302 adds a delayed rail
// follow-up report/echo (weapons/railgr1b.wav on CHAN_AUX3) alongside the
// classic MZ_RAILGUN dlight+sound, gated on cl_rerelease_effects (default
// on). This piece is self-contained (a second S_StartSound call in
// CL_ParseMuzzleFlash's existing MZ_RAILGUN case) and within this unit's
// territory; the md2 flash-MODEL rendering the finding's title refers to is
// NOT -- see this unit's report for why (needs cl_tent.ts's explosion pool/
// model registry and a view-weapon overlay renderer, both out of scope for
// cl_fx.ts alone).
//
// Follows test/cl_fx.test.ts's own TE_EXPLOSION1 precedent: S_StartSound is
// safe to call without a real audio device (S_RegisterSound returns null
// when sound isn't started, and S_StartSound tolerates a null sfx), so this
// only asserts "does not throw" plus the dlight color/radius math, not
// actual audio playback.

import { describe, test, expect, beforeEach } from "bun:test";
import { SZ_Clear, MSG_BeginReading, MSG_WriteShort, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { cl, cls, cl_entities, cl_dlights } from "../src/client/client";
import { CL_ParseMuzzleFlash, CL_ClearDlights } from "../src/client/cl_fx";
import { MZ_RAILGUN } from "../src/shared/q_shared";
import { Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";

const ENT = 3;

function writeMuzzleFlash(ent: number, weapon: number): void {
  SZ_Clear(net_message);
  MSG_WriteShort(net_message, ent);
  MSG_WriteByte(net_message, weapon);
  MSG_BeginReading(net_message);
}

describe("cl_fx.ts CL_ParseMuzzleFlash(MZ_RAILGUN) -- rerelease follow-up sound", () => {
  beforeEach(() => {
    CL_ClearDlights();
    cl.time = 1000;
    cl_entities[ENT].current.origin.set([0, 0, 0]);
    cl_entities[ENT].current.angles.set([0, 0, 0]);
    // cl_rerelease_effects is registered by cl_main.ts's CL_InitLocal in
    // real boot; Cvar_Get here fetches-or-creates the same cvar (idempotent,
    // see cl_fx.ts's own doc comment on this pattern).
    Cvar_Get("cl_rerelease_effects", "1", 0);
    Cvar_ForceSet("cl_rerelease_effects", "1");
  });

  test("does not throw with cl_rerelease_effects enabled (default)", () => {
    writeMuzzleFlash(ENT, MZ_RAILGUN);
    expect(() => CL_ParseMuzzleFlash()).not.toThrow();
  });

  test("does not throw with cl_rerelease_effects disabled", () => {
    Cvar_ForceSet("cl_rerelease_effects", "0");
    writeMuzzleFlash(ENT, MZ_RAILGUN);
    expect(() => CL_ParseMuzzleFlash()).not.toThrow();
  });

  test("still sets the classic railgun dlight color regardless of cl_rerelease_effects", () => {
    writeMuzzleFlash(ENT, MZ_RAILGUN);
    CL_ParseMuzzleFlash();
    const dl = cl_dlights.find((d) => d.radius > 0);
    expect(dl).toBeDefined();
    expect(dl?.color[0]).toBeCloseTo(0.5);
    expect(dl?.color[1]).toBeCloseTo(0.5);
    expect(dl?.color[2]).toBeCloseTo(1.0);
  });
});
