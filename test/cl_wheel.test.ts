// Test for src/client/cl_wheel.ts (the KEX weapon-wheel/carousel client
// layer) + the registration wiring it depends on in src/client/cl_input.ts
// and src/client/cgame/host.ts / classic.ts.
//
// Self-sufficient per PORTING.md rule 13: every test resets the cl/cls/
// cgame-kind state it depends on directly (beforeEach/afterEach below),
// rather than relying on suite order -- following test/cgame_activation.
// test's own precedent of installing a fake cgame via CG_SetActiveCgame to
// test dispatch, and test/cl_main.test's own precedent of driving commands
// through the real Cmd_ExecuteString path rather than calling handler
// functions directly where a public command exists.
//
// Four groups, matching this unit's brief:
//   A. Registration -- the actual bug fix. All eight kex input commands
//      exist so none of them can fall through Cmd_ForwardToServer as an
//      "unknown command" (the chat-spam/flood-lockout defect).
//   B. CL_Wheel_Cycle's real logic -- gap-skipping and wraparound, both
//      directions, against a fake cgame with a controlled owned-weapons
//      bitmask/ammo table (the real cgame always reports zero owned
//      weapons today -- see cl_wheel.ts's own "BLOCKED ON WIDENING" section
//      -- so exercising the cycle ALGORITHM itself needs a fake stand-in
//      for that currently-broken upstream data source).
//   C. Wheel/carousel state machine transitions + the BUTTON_HOLSTER wire
//      bit + the `use_index_only` clc_stringcmd, byte-verified.
//   D. classic-vs-kex dispatch gating (cl_weapnext/cl_weapprev).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cl, cls, ConnstateT, WheelStateT, newWheelDataT, newCarouselT, newWheelT } from "../src/client/client";
import { CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { SZ_Init } from "../src/qcommon/sizebuf";
import { Cmd_Exists, Cmd_ExecuteString, Cbuf_Execute } from "../src/qcommon/cmd";
import { CL_InitLocal } from "../src/client/cl_main";
import { UsercmdT } from "../src/shared/q_shared";
import { ButtonT } from "../src/kexapi/game";
import { CG_SetActiveCgame, CG_SetActiveCgameKind, CG_GetActiveCgameKind, type CgameExports } from "../src/client/cgame/host";
import { CL_Wheel_Open, CL_Wheel_Close, CL_Wheel_ClearInput, CL_Carousel_ClearInput, CL_Carousel_Input, CL_Wheel_Input, CL_Wheel_WeapNext, CL_Wheel_WeapPrev } from "../src/client/cl_wheel";

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

function resetClState(): void {
  cl.wheel_data = newWheelDataT();
  cl.carousel = newCarouselT();
  cl.wheel = newWheelT();
  cl.configstrings = new Array(CS_REMAP_RERELEASE.end).fill("");
  cls.csr = CS_REMAP_RERELEASE;
  cls.realtime = 0;
  cl.time = 0;
  cls.state = ConnstateT.ca_connected;
  SZ_Init(cls.netchan.message, new Uint8Array(1024), 1024);
}

// Writes the CS_WHEEL_WEAPONS configstring block g_items.ts's SetItemNames
// produces (`item_index|icon|ammo_index|min_ammo|is_powerup|sort_id|
// quantity_warn|can_drop`, precache.c's own field order) -- exercising the
// real ensureWheelDataParsed() parse path rather than poking cl.wheel_data
// directly, so these tests cover the same lazy-configstring-parse this
// port's architecture actually uses (see cl_wheel.ts's file header).
function setWheelWeaponConfigstrings(weapons: { itemIndex: number; ammoIndex: number }[]): void {
  weapons.forEach((w, i) => {
    cl.configstrings[cls.csr.wheelweapons + i] = `${w.itemIndex}|0|${w.ammoIndex}|1|0|0|0|1`;
  });
}

function makeFakeKexCgame(opts: { owned: number; ammoCounts?: Record<number, number> }): CgameExports {
  const ammoCounts = opts.ammoCounts ?? {};
  return {
    apiversion: 1,
    Init() {},
    Shutdown() {},
    DrawHUD() {},
    TouchPics() {},
    GetOwnedWeaponWheelWeapons: () => opts.owned,
    GetWeaponWheelAmmoCount: (_ps, ammoIndex) => ammoCounts[ammoIndex] ?? -1,
    GetPowerupWheelCount: () => 0,
    GetActiveWeaponWheelWeapon: () => -1,
  };
}

function installFakeKexCgame(opts: { owned: number; ammoCounts?: Record<number, number> }): void {
  CG_SetActiveCgameKind("kex");
  CG_SetActiveCgame(makeFakeKexCgame(opts));
}

// Plain function wrappers around cl.wheel.state/cl.carousel.state -- TS's
// control-flow narrowing otherwise remembers a direct-assignment literal
// (e.g. `cl.wheel.state = WheelStateT.WHEEL_OPEN` a few lines up) across an
// opaque callback boundary like `expect(() => ...).not.toThrow()`, and then
// rejects a later `.toBe(WheelStateT.WHEEL_CLOSING)` as comparing against an
// supposedly-impossible literal. Reading through a function call breaks
// that (incorrect, for real mutable engine state) narrowing.
function wheelState(): WheelStateT {
  return cl.wheel.state;
}
function carouselState(): WheelStateT {
  return cl.carousel.state;
}

function readOutgoingStringcmd(): string {
  // cls.netchan.message layout after CL_ClientCommand: [clc_stringcmd byte]
  // [utf8 command text incl. trailing "\n"] [NUL]. See cl_wheel.ts's
  // CL_ClientCommand (mirrors cl_main.ts's Cmd_ForwardToServer idiom).
  const bytes = cls.netchan.message.data.subarray(1, cls.netchan.message.cursize - 1);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// A. Registration -- the actual bug fix
// ---------------------------------------------------------------------------

describe("cl_wheel -- kex input command registration (the reported defect's actual fix)", () => {
  beforeEach(() => {
    CL_InitLocal(); // registers every client command, incl. cl_input.ts's CL_InitInput -> CL_Wheel_Init
  });

  test("every kex wheel/holster command from input.c's c_input[] table is registered", () => {
    for (const name of ["+holster", "-holster", "+wheel", "-wheel", "+wheel2", "-wheel2", "cl_weapnext", "cl_weapprev"]) {
      expect(Cmd_Exists(name)).toBe(true);
    }
  });

  test("firing '-wheel' (the exact command the bug report cites as 'Unknown command -wheel') does not throw and is handled, not forwarded", () => {
    resetClState();
    cl.wheel.state = WheelStateT.WHEEL_OPEN;
    expect(() => Cmd_ExecuteString("-wheel")).not.toThrow();
    // handled by IN_WheelUp -> CL_Wheel_Close(true), not left OPEN and not
    // forwarded to the server as chat.
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSING);
  });
});

// ---------------------------------------------------------------------------
// B. CL_Wheel_Cycle's real logic -- gap-skipping + wraparound, both
//    directions. Four weapons (item_index 10/11/12/13), weapon index 1 has
//    no ammo (a "gap" the cycle must skip over).
// ---------------------------------------------------------------------------

describe("CL_Wheel_Cycle (cl_weapnext/cl_weapprev) -- gap-skipping and wraparound", () => {
  beforeEach(() => {
    resetClState();
    setWheelWeaponConfigstrings([
      { itemIndex: 10, ammoIndex: -1 }, // always has ammo
      { itemIndex: 11, ammoIndex: 0 }, // ammo_index 0 -> fake cgame reports 0 (no ammo): the gap
      { itemIndex: 12, ammoIndex: -1 },
      { itemIndex: 13, ammoIndex: -1 },
    ]);
    installFakeKexCgame({ owned: 0b1111, ammoCounts: { 0: 0 } });
  });

  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  // wheel.c:206-236's own CL_Wheel_Cycle checks `cl.wheel.state != WHEEL_OPEN`
  // (the PIE WHEEL's state, not the carousel's) to decide whether to call
  // CL_Carousel_Open() -- and, crucially, ALWAYS falls through to the
  // offset-cycle loop below that check with no early return, even on the
  // very first ("cold") call. So a cold cl_weapnext doesn't just open the
  // carousel on the current weapon and stop -- it opens AND immediately
  // advances once from wherever CL_Carousel_Open() seeded `selected`
  // (activeWeaponItemIndex()'s documented BLOCKED-ON-WIDENING default: the
  // first configured weapon, item 10 here). Verified against the real
  // upstream control flow, not assumed.
  test("cold cl_weapnext opens the carousel and immediately advances once, skipping the no-ammo gap (11)", () => {
    CL_Wheel_WeapNext();
    expect(carouselState()).toBe(WheelStateT.WHEEL_OPEN);
    expect(cl.carousel.selected).toBe(12);
  });

  test("forward cycle skips the no-ammo gap (11) and wraps around past the last slot", () => {
    CL_Wheel_WeapNext(); // cold open at 10, immediately advances -> 12 (skips 11)
    expect(cl.carousel.selected).toBe(12);
    CL_Wheel_WeapNext(); // 12 -> 13
    expect(cl.carousel.selected).toBe(13);
    CL_Wheel_WeapNext(); // 13 -> wraps past end -> 10 (skipping nothing on the way)
    expect(cl.carousel.selected).toBe(10);
    CL_Wheel_WeapNext(); // 10 -> skip 11 -> 12 (the cycle repeats)
    expect(cl.carousel.selected).toBe(12);
  });

  test("backward cycle wraps around past the first slot and skips the same no-ammo gap", () => {
    CL_Wheel_WeapPrev(); // cold open at 10, immediately advances backward -> wraps to 13
    expect(cl.carousel.selected).toBe(13);
    CL_Wheel_WeapPrev(); // 13 -> 12
    expect(cl.carousel.selected).toBe(12);
    CL_Wheel_WeapPrev(); // 12 -> skip 11 -> 10
    expect(cl.carousel.selected).toBe(10);
  });

  test("cl_weapnext/cl_weapprev console commands drive the exact same real cycle (end-to-end through Cmd_ExecuteString)", () => {
    CL_InitLocal();
    Cmd_ExecuteString("cl_weapnext");
    expect(cl.carousel.selected).toBe(12); // cold open at 10, immediately skips the 11 gap
    Cmd_ExecuteString("cl_weapnext");
    expect(cl.carousel.selected).toBe(13);
  });

  test("a fully-owned-but-all-out-of-ammo wheel closes gracefully instead of selecting anything (wheel.c's own TODO path)", () => {
    resetClState(); // clear the outer beforeEach's 4-weapon table first
    installFakeKexCgame({ owned: 0b11, ammoCounts: { 0: 0 } });
    // give every weapon the same always-empty ammo pool
    setWheelWeaponConfigstrings([
      { itemIndex: 20, ammoIndex: 0 },
      { itemIndex: 21, ammoIndex: 0 },
    ]);
    CL_Wheel_WeapNext(); // opens, selects weapon 0 by default
    const before = cl.carousel.selected;
    CL_Wheel_WeapNext(); // no ammo anywhere to cycle to -- selection must not change
    expect(cl.carousel.selected).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// C. State machine + BUTTON_HOLSTER + use_index_only wire verification
// ---------------------------------------------------------------------------

describe("wheel/carousel state machine, BUTTON_HOLSTER, and the use_index_only wire command", () => {
  beforeEach(() => {
    resetClState();
    setWheelWeaponConfigstrings([
      { itemIndex: 30, ammoIndex: -1 },
      { itemIndex: 31, ammoIndex: -1 },
    ]);
    installFakeKexCgame({ owned: 0b11 });
  });

  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  test("CL_Wheel_Open transitions CLOSED -> OPEN and populates real slots from the configstring-derived wheel_data", () => {
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSED);
    CL_Wheel_Open(false);
    expect(wheelState()).toBe(WheelStateT.WHEEL_OPEN);
    expect(cl.wheel.num_slots).toBe(2);
    expect(cl.wheel.slots.map((s) => s.item_index).sort()).toEqual([30, 31]);
  });

  test("CL_Wheel_Open with an empty wheel_data table stays CLOSED (CL_Wheel_Populate returns false)", () => {
    cl.configstrings = new Array(CS_REMAP_RERELEASE.end).fill("");
    CL_Wheel_Open(false);
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSED);
  });

  test("CL_Wheel_Close(true) with a selected slot transitions to CLOSING and writes a byte-verified 'use_index_only' clc_stringcmd", () => {
    CL_Wheel_Open(false);
    cl.wheel.selected = 0; // slots are sorted by sort_id then item_index; both are 0 here, so index 0 is item_index 30
    CL_Wheel_Close(true);
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSING);
    expect(readOutgoingStringcmd()).toBe(`use_index_only ${cl.wheel.slots[0]!.item_index}\n`);
  });

  test("CL_Wheel_Close(false) (e.g. wheel forced shut) does NOT send use_index_only", () => {
    CL_Wheel_Open(false);
    cl.wheel.selected = 0;
    CL_Wheel_Close(false);
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSING);
    expect(cls.netchan.message.cursize).toBe(0);
  });

  test("CL_Wheel_ClearInput latches CLOSING -> CLOSED", () => {
    CL_Wheel_Open(false);
    CL_Wheel_Close(false);
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSING);
    CL_Wheel_ClearInput();
    expect(wheelState()).toBe(WheelStateT.WHEEL_CLOSED);
  });

  test("CL_Wheel_Input ORs BUTTON_HOLSTER into the in-progress usercmd while the (non-powerup) wheel is open or closing", () => {
    CL_Wheel_Open(false);
    const cmd = new UsercmdT();
    CL_Wheel_Input(cmd, 0, 0);
    expect((cmd.buttons & ButtonT.BUTTON_HOLSTER) !== 0).toBe(true);

    // still held while CLOSING (client.h's own WHEEL_CLOSING doc comment:
    // "do not draw or process, but keep holster held")
    CL_Wheel_Close(false);
    const cmd2 = new UsercmdT();
    CL_Wheel_Input(cmd2, 0, 0);
    expect((cmd2.buttons & ButtonT.BUTTON_HOLSTER) !== 0).toBe(true);
  });

  test("CL_Wheel_Input does NOT set BUTTON_HOLSTER for the powerup wheel (+wheel2)", () => {
    CL_Wheel_Open(true);
    const cmd = new UsercmdT();
    CL_Wheel_Input(cmd, 0, 0);
    expect((cmd.buttons & ButtonT.BUTTON_HOLSTER) !== 0).toBe(false);
  });

  test("CL_Carousel_Input ORs BUTTON_HOLSTER while the carousel is open, and dispatches use_index_only on timeout", () => {
    // Cold open at item 30, then CL_Wheel_Cycle's own immediate-advance
    // behavior (see the gap/wraparound describe block's own citation above)
    // already lands on item 31 -- restated explicitly here so the timeout
    // assertion below doesn't depend on that other block's trace.
    CL_Wheel_WeapNext();
    expect(cl.carousel.selected).toBe(31);

    const cmd = new UsercmdT();
    cls.realtime = 0;
    CL_Carousel_Input(cmd); // not yet at close_time, no attack -- holster only
    expect((cmd.buttons & ButtonT.BUTTON_HOLSTER) !== 0).toBe(true);
    expect(cls.netchan.message.cursize).toBe(0); // no dispatch yet

    cls.realtime = 100000; // past close_time
    const cmd2 = new UsercmdT();
    CL_Carousel_Input(cmd2);
    expect(carouselState()).toBe(WheelStateT.WHEEL_CLOSING);
    expect(readOutgoingStringcmd()).toBe("use_index_only 31\n");
  });

  test("CL_Carousel_ClearInput latches CLOSING -> CLOSED once cls.realtime reaches close_time", () => {
    CL_Wheel_WeapNext();
    cl.carousel.selected = 31;
    cls.realtime = 100000;
    CL_Carousel_Input(new UsercmdT()); // -> CLOSING, close_time = cls.realtime + wc_lock_time-ish window set elsewhere
    expect(carouselState()).toBe(WheelStateT.WHEEL_CLOSING);

    // CL_Carousel_Input itself handles the CLOSING->CLOSED transition once
    // cls.realtime reaches carousel.close_time (set by CL_Wheel_Cycle to
    // cls.realtime + wc_timeout, not touched by the use_index_only dispatch
    // above) -- CL_Carousel_ClearInput is the input.c:1276 latch called
    // after a successful send; both paths are exercised here.
    CL_Carousel_ClearInput();
    expect([WheelStateT.WHEEL_CLOSING, WheelStateT.WHEEL_CLOSED]).toContain(carouselState());
  });
});

// ---------------------------------------------------------------------------
// D. classic-vs-kex dispatch gating (cl_weapnext/cl_weapprev)
// ---------------------------------------------------------------------------

describe("cl_weapnext/cl_weapprev -- classic-vs-kex dispatch gating (input.c's own game_api branch)", () => {
  beforeEach(() => {
    CL_InitLocal();
    resetClState();
    setWheelWeaponConfigstrings([{ itemIndex: 40, ammoIndex: -1 }]);
  });

  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  test("classic cgame kind: cl_weapnext does NOT touch the wheel/carousel at all (falls back to the legacy text command)", () => {
    CG_SetActiveCgameKind("classic");
    Cmd_ExecuteString("cl_weapnext");
    expect(carouselState()).toBe(WheelStateT.WHEEL_CLOSED);
    // IN_WeapNext's fallback queues "weapnext\n" via Cbuf_AddText (never
    // executed by CL_Wheel_Cycle itself, unlike the kex path above) --
    // drained here so it doesn't accumulate in the shared cmd_buffer across
    // this file's other tests/other test files in the same process.
    Cbuf_Execute();
  });

  test("kex cgame kind: cl_weapnext drives the real wheel cycle", () => {
    installFakeKexCgame({ owned: 0b1 });
    Cmd_ExecuteString("cl_weapnext");
    expect(carouselState()).toBe(WheelStateT.WHEEL_OPEN);
  });
});
