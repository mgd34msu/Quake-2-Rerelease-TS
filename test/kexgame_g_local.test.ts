/*
Unit tests for the kex g_local.h port (src/kexgame/g_local.ts,
src/kexgame/g_local_types.ts, src/kexgame/g_save_registry.ts).

Scope, per this unit's brief:
  - g_save_registry.ts: register/lookup/reverse-lookup/duplicate-throw,
    across more than one function kind (proving kinds don't share state).
  - ItemIdT: spot checks against the C++ source's exact ordinals --
    first (IT_NULL), last (IT_ITEM_COMPASS) and IT_TOTAL, plus the
    xatrix/rogue interleave boundaries verified by reading
    ~/Projects/quake2-rerelease-dll/rerelease/g_local.h:862-962 directly.
  - MmoveT: the frame-count validation invariant (mirrors the precedent in
    src/game/g_local.ts's MmoveT).
*/

import { describe, test, expect } from "bun:test";
import { ItemIdT, MELEE_DISTANCE } from "../src/kexgame/g_local";
import { MframeT, MmoveT } from "../src/kexgame/g_local_types";
import {
  RegisterThink,
  LookupThink,
  NameOfThink,
  RegisterUse,
  LookupUse,
  NameOfUse,
  type ThinkFn,
  type UseFn,
} from "../src/kexgame/g_save_registry";

describe("g_save_registry", () => {
  test("register/lookup/reverse round-trip for a single kind", () => {
    const think_a: ThinkFn = () => {};
    RegisterThink("kexgame_test_think_a", think_a);

    expect(LookupThink("kexgame_test_think_a")).toBe(think_a);
    expect(NameOfThink(think_a)).toBe("kexgame_test_think_a");
  });

  test("lookup of an unknown name returns null", () => {
    expect(LookupThink("kexgame_test_think_does_not_exist")).toBeNull();
  });

  test("nameOf of an unregistered function returns null", () => {
    const unregistered: ThinkFn = () => {};
    expect(NameOfThink(unregistered)).toBeNull();
  });

  test("nameOf of null returns null", () => {
    expect(NameOfThink(null)).toBeNull();
  });

  test("duplicate name registration throws", () => {
    const fn: ThinkFn = () => {};
    RegisterThink("kexgame_test_think_dup", fn);
    expect(() => RegisterThink("kexgame_test_think_dup", () => {})).toThrow();
  });

  test("each function-pointer kind has its own independent namespace", () => {
    // Registering the same name in a DIFFERENT kind (Use vs Think) must not
    // collide -- the whole point of "one registry per kind" per the brief.
    const think_b: ThinkFn = () => {};
    const use_b: UseFn = () => {};
    RegisterThink("kexgame_test_shared_name", think_b);
    RegisterUse("kexgame_test_shared_name", use_b);

    expect(LookupThink("kexgame_test_shared_name")).toBe(think_b);
    expect(LookupUse("kexgame_test_shared_name")).toBe(use_b);
    expect(NameOfThink(think_b)).toBe("kexgame_test_shared_name");
    expect(NameOfUse(use_b)).toBe("kexgame_test_shared_name");

    // A Use function must never resolve through the Think registry's lookup
    // (they're different Maps, so this is really just proving no accidental
    // shared backing store), and a Think function has no meaning as a
    // registered Use -- NameOfUse on a Think value is simply "not found".
    expect(NameOfUse(think_b as unknown as UseFn)).toBeNull();
  });
});

describe("ItemIdT ordinals (verified against g_local.h:862-962)", () => {
  test("first entry: IT_NULL must always be zero", () => {
    expect(ItemIdT.IT_NULL).toBe(0);
  });

  test("last real item before IT_TOTAL: IT_ITEM_COMPASS", () => {
    expect(ItemIdT.IT_ITEM_COMPASS).toBe(83);
  });

  test("IT_TOTAL is the sentinel one past the last real item", () => {
    expect(ItemIdT.IT_TOTAL).toBe(84);
    expect(ItemIdT.IT_TOTAL).toBe(ItemIdT.IT_ITEM_COMPASS + 1);
  });

  test("rogue weapon IT_WEAPON_ETF_RIFLE interleaved between vanilla machinegun and chaingun", () => {
    expect(ItemIdT.IT_WEAPON_MACHINEGUN).toBe(12);
    expect(ItemIdT.IT_WEAPON_ETF_RIFLE).toBe(13);
    expect(ItemIdT.IT_WEAPON_CHAINGUN).toBe(14);
  });

  test("rogue ammo IT_AMMO_TRAP / IT_AMMO_TESLA interleaved after IT_AMMO_GRENADES", () => {
    expect(ItemIdT.IT_AMMO_GRENADES).toBe(15);
    expect(ItemIdT.IT_AMMO_TRAP).toBe(16);
    expect(ItemIdT.IT_AMMO_TESLA).toBe(17);
  });

  test("xatrix weapon IT_WEAPON_IONRIPPER interleaved between hyperblaster and plasmabeam", () => {
    expect(ItemIdT.IT_WEAPON_HYPERBLASTER).toBe(21);
    expect(ItemIdT.IT_WEAPON_IONRIPPER).toBe(22);
    expect(ItemIdT.IT_WEAPON_PLASMABEAM).toBe(23);
  });

  test("rogue weapon IT_WEAPON_DISRUPTOR ends the weapon block (IT_WEAPON_DISINTEGRATOR is #if 0'd out)", () => {
    expect(ItemIdT.IT_WEAPON_BFG).toBe(26);
    expect(ItemIdT.IT_WEAPON_DISRUPTOR).toBe(27);
    expect(ItemIdT.IT_AMMO_SHELLS).toBe(28);
  });

  test("xatrix ammo IT_AMMO_MAGSLUG / IT_AMMO_FLECHETTES interleaved between slugs and rogue prox", () => {
    expect(ItemIdT.IT_AMMO_SLUGS).toBe(32);
    expect(ItemIdT.IT_AMMO_MAGSLUG).toBe(33);
    expect(ItemIdT.IT_AMMO_FLECHETTES).toBe(34);
    expect(ItemIdT.IT_AMMO_PROX).toBe(35);
  });
});

describe("MmoveT frame-count invariant", () => {
  test("assigning a frame array of the correct length succeeds", () => {
    const move = new MmoveT();
    move.firstframe = 0;
    move.lastframe = 2;
    const frames: MframeT[] = [{ aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 }, { aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 }, { aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 }];
    move.frame = frames;
    expect(move.frame).toBe(frames);
    expect(move.frame.length).toBe(3);
  });

  test("assigning a mismatched frame array throws by default", () => {
    const move = new MmoveT();
    move.firstframe = 0;
    move.lastframe = 2; // expects 3 frames
    expect(() => {
      move.frame = [{ aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 }];
    }).toThrow();
  });

  test("allowFrameCountMismatch bypasses the check (id-Software-bug escape hatch)", () => {
    const move = new MmoveT();
    move.firstframe = 0;
    move.lastframe = 2; // expects 3 frames
    move.allowFrameCountMismatch = true;
    const oneFrame: MframeT[] = [{ aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 }];
    expect(() => {
      move.frame = oneFrame;
    }).not.toThrow();
    expect(move.frame).toBe(oneFrame);
  });
});

describe("misc constant sanity", () => {
  test("MELEE_DISTANCE matches the KEX value (50), not the vanilla/legacy value (80)", () => {
    expect(MELEE_DISTANCE).toBe(50);
  });
});
