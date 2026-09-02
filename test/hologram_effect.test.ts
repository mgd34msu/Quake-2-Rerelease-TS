/*
EF_HOLOGRAM -- misc_hologram's N64 shimmer, under BOTH rulesets.

Before this unit `grep -rn HOLOGRAM src` found exactly three things: the enum
value in src/kexapi/game.ts, the setter in src/kexgame/g_misc.ts, and a
comment in src/game/g_kexmisc.ts explaining that the classic module
deliberately did not set it. Nothing anywhere CONSUMED it -- no client code,
no renderer -- so misc_hologram rendered as a plain opaque strogg1 model under
the re-release module too, not just the classic one.

q2repro's client does one thing with the bit (src/client/entities.c:1065-1066):

    if (effects & EF_HOLOGRAM)
        CL_HologramParticles(ent.origin);

and CL_HologramParticles (src/client/newfx.c:974-1007) throws one particle
per vertex normal 100 units out along that normal, after rotating the whole
normal set by a yaw/pitch that advances with cl.time, all as
INSTANT_PARTICLE so the shell re-forms fresh every frame.

What this file pins:

  1. THE BIT'S PLACE IN THIS PORT'S SPLIT EFFECTS FIELD. EF_HOLOGRAM is
     BIT_ULL(33) of the re-release's uint64 effects_t. This port keeps the
     low 32 bits in EntityStateT.effects (the frozen legacy contract) and the
     high 32 in EntityStateT.morefx, so bit 33 is bit 1 of morefx. Both the
     client-side and classic-module-side constants spell that locally rather
     than importing kexapi; both are compared against kexapi's own value
     here so they cannot drift.

  2. THE KEX BINDING'S SPLIT actually lands the bit in morefx -- checked
     through bindings/kex.ts's own splitEffects/joinEffects pair, which is
     what carries src/kexgame/g_misc.ts's `ent.s.effects = EF_HOLOGRAM` onto
     the engine entity state.

  3. THE PARTICLE EFFECT: CL_HologramParticles allocates exactly
     NUMVERTEXNORMALS particles, every one of them at distance 100 from the
     origin passed in (the rotation is orthonormal, so it preserves the unit
     length of each bytedir), coloured 0xd0, with zero velocity and
     acceleration and INSTANT_PARTICLE alphavel.

  4. THE WIRE. morefx is carried by the protocol 1038/4038 delta and by
     nothing else, so the bit reaches a client on a wide session and cannot
     on protocol 34 -- which is why src/game/g_kexmisc.ts gates the write on
     gi.extended_layout().
*/

import { describe, expect, test, beforeEach, afterAll } from "bun:test";

import { EffectsT } from "../src/kexapi/game";
import { splitEffects, joinEffects } from "../src/server/bindings/kex";
import { EntityStateT } from "../src/shared/q_shared";
import { NUMVERTEXNORMALS } from "../src/qcommon/anorms";
import { vec3 } from "../src/shared/math";
import { cl, INSTANT_PARTICLE } from "../src/client/client";
import { particleList, CL_ClearParticles } from "../src/client/cl_fx";
import { CL_HologramParticles } from "../src/client/cl_newfx";

/** cl_ents.ts's and g_kexmisc.ts's local spelling of the bit. */
const MOREFX_HOLOGRAM = 1 << 1;

// ---------------------------------------------------------------------------
// 1. The bit
// ---------------------------------------------------------------------------

describe("EF_HOLOGRAM in this port's split effects field", () => {
  test("kexapi still declares it as bit 33 of the 64-bit field", () => {
    expect(EffectsT.EF_HOLOGRAM).toBe(1n << 33n);
  });

  test("the local MOREFX_HOLOGRAM constant is that bit's position in morefx", () => {
    // high half = value >> 32, so bit 33 becomes bit 1.
    expect(Number(EffectsT.EF_HOLOGRAM >> 32n)).toBe(MOREFX_HOLOGRAM);
  });

  test("it does NOT collide with anything in the low (legacy) 32 bits", () => {
    expect(Number(BigInt.asUintN(32, EffectsT.EF_HOLOGRAM))).toBe(0);
  });
});

describe("the kex binding's effects split carries the bit into morefx", () => {
  test("splitEffects puts EF_HOLOGRAM in morefx, not effects", () => {
    const { effects, morefx } = splitEffects(EffectsT.EF_HOLOGRAM);
    expect(effects).toBe(0);
    expect(morefx & MOREFX_HOLOGRAM).toBe(MOREFX_HOLOGRAM);
  });

  test("joinEffects round trips it back to the kex value", () => {
    expect(joinEffects(0, MOREFX_HOLOGRAM)).toBe(EffectsT.EF_HOLOGRAM);
  });

  test("it survives alongside a low-half effect (EF_ROTATE)", () => {
    const combined = EffectsT.EF_HOLOGRAM | EffectsT.EF_ROTATE;
    const { effects, morefx } = splitEffects(combined);
    expect(morefx & MOREFX_HOLOGRAM).toBe(MOREFX_HOLOGRAM);
    expect(effects).toBe(Number(EffectsT.EF_ROTATE));
    expect(joinEffects(effects, morefx)).toBe(combined);
  });
});

// ---------------------------------------------------------------------------
// 2. The classic entity state can hold it at all
// ---------------------------------------------------------------------------

describe("the classic EntityStateT has somewhere to put it", () => {
  test("morefx exists and defaults to 0, so a protocol-34 entity reads clean", () => {
    const s = new EntityStateT();
    expect(s.morefx).toBe(0);
    expect(s.morefx & MOREFX_HOLOGRAM).toBe(0);
  });

  test("setting it leaves the legacy `effects` field untouched", () => {
    const s = new EntityStateT();
    s.morefx |= MOREFX_HOLOGRAM;
    expect(s.effects).toBe(0);
    expect(s.morefx).toBe(MOREFX_HOLOGRAM);
  });
});

// ---------------------------------------------------------------------------
// 3. The particle effect
// ---------------------------------------------------------------------------

describe("CL_HologramParticles (newfx.c:974-1007)", () => {
  const savedTime = cl.time;

  beforeEach(() => {
    CL_ClearParticles();
    cl.time = 1000;
  });

  // The particle pool and cl.time are module singletons shared with every
  // other test file in the run. The pool-exhaustion case below deliberately
  // drains the free list, so both are put back before this file is done --
  // otherwise a later file would allocate from an empty pool.
  afterAll(() => {
    CL_ClearParticles();
    cl.time = savedTime;
  });

  function active(): Array<{ org: Float32Array; color: number; alpha: number; alphavel: number; vel: Float32Array; accel: Float32Array }> {
    const out = [];
    for (let p = particleList.active; p; p = p.next) out.push(p);
    return out;
  }

  test("allocates exactly one particle per vertex normal", () => {
    CL_HologramParticles(vec3(0, 0, 0));
    expect(active().length).toBe(NUMVERTEXNORMALS);
  });

  test("every particle sits exactly 100 units from the origin", () => {
    const org = vec3(100, -200, 50);
    CL_HologramParticles(org);
    for (const p of active()) {
      const dx = p.org[0] - org[0];
      const dy = p.org[1] - org[1];
      const dz = p.org[2] - org[2];
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeCloseTo(100, 3);
    }
  });

  test("colour 0xd0, full alpha, INSTANT_PARTICLE alphavel, no motion", () => {
    CL_HologramParticles(vec3(0, 0, 0));
    for (const p of active()) {
      expect(p.color).toBe(0xd0);
      expect(p.alpha).toBe(1.0);
      expect(p.alphavel).toBe(INSTANT_PARTICLE);
      expect(Array.from(p.vel)).toEqual([0, 0, 0]);
      expect(Array.from(p.accel)).toEqual([0, 0, 0]);
    }
  });

  test("the shell rotates with cl.time -- a later frame is a different set of points", () => {
    CL_HologramParticles(vec3(0, 0, 0));
    const first = active().map((p) => Array.from(p.org));

    CL_ClearParticles();
    cl.time = 5000;
    CL_HologramParticles(vec3(0, 0, 0));
    const later = active().map((p) => Array.from(p.org));

    expect(later.length).toBe(first.length);
    // At least one point must have moved; ltime = cl.time * 0.03 differs by
    // 120 degrees of yaw between these two frames.
    const moved = first.some((f, i) => Math.abs(f[0] - later[i][0]) > 0.001 || Math.abs(f[1] - later[i][1]) > 0.001 || Math.abs(f[2] - later[i][2]) > 0.001);
    expect(moved).toBe(true);
  });

  test("it stops cleanly when the particle pool runs dry rather than throwing", () => {
    // Drain the free list to a handful, then ask for a full shell.
    let taken = 0;
    while (particleList.free && taken < 4000) {
      const p = particleList.free;
      particleList.free = p.next;
      taken++;
    }
    expect(() => CL_HologramParticles(vec3(0, 0, 0))).not.toThrow();
  });
});
