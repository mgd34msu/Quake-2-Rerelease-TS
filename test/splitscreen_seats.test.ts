/*
LOCAL SPLITSCREEN SEATS -- targeted coverage for the v1.1.0 feature.

This is the IMPLEMENTATION suite. test/splitscreen.test.ts is its older
sibling and stays as-is: that file pins the phase-7 API-plumbing ruling
(local_sound/unicast per-target delivery, dupe_key accepted-and-ignored,
distinct slots for distinct callers, split-suffixed userinfo keys inert) and
every one of those guarantees is still exactly true -- seats are built ON TOP
of that multi-client behavior, not instead of it. What has changed since that
file was written is only its scope note ("WITHOUT local split rendering"),
which this feature supersedes; see src/server/sv_seats.ts's header for the
re-audit of all three reference trees that establishes there is no reference
implementation to copy and what therefore had to be invented here.

WHAT IS PINNED HERE
  1. viewport rect math -- the invented part, so it gets the most coverage:
     tiling, no overlap, alignment, the 2-seat auto rule, 3-seat quadrants.
  2. per-seat usercmd generation -- stick signs, look integration, the
     button map, weapon-cycle edge triggering, pitch clamping.
  3. per-seat HUD rect/scale -- that a seat's HUD lands inside its own pane
     and scales to the pane rather than the display.
  4. server-side seat lifecycle -- seating, distinct slots, direct
     ClientThink delivery, teardown, and PVS-union origin reporting.

Self-sufficient per .orch/preferences.md rule 13: every describe block
installs the globals it reads (fake ge, sv.state, viddef, cvars) in its own
beforeEach and tears them down in afterEach.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  MAX_LOCAL_SEATS,
  SplitscreenLayout,
  SPLIT_LAYOUT_AUTO,
  SPLIT_LAYOUT_SIDE_BY_SIDE,
  SPLIT_LAYOUT_STACKED,
  SeatInputStateT,
  CL_Seat_BuildCmd,
  CL_Seat_ClampPitch,
  SEAT_PAD_BUTTON_JUMP,
  SEAT_PAD_BUTTON_CROUCH,
  SEAT_PAD_BUTTON_USE,
  SEAT_PAD_BUTTON_WEAPNEXT,
  SEAT_PAD_BUTTON_WEAPPREV,
  type SeatCmdCvarsT,
  type SeatViewportT,
} from "../src/client/cl_seats";
import { kexSeatHudVrect, kexSeatHudSafe, seatHudUpscaleFactor, autoHudUpscale } from "../src/client/cgame/host";
import { viddef } from "../src/client/vid";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { ANGLE2SHORT, SHORT2ANGLE, PITCH, YAW, UsercmdT } from "../src/shared/q_shared";
import { ButtonT } from "../src/kexapi/game";
import type { GameExports, Edict } from "../src/game/game";
import { geHolder } from "../src/server/sv_game";
import { sv, svs, ServerStateT, ClientStateT, ClientT } from "../src/server/server";
import { Cvar_FullSet } from "../src/qcommon/cvar";
import { CVAR_SERVERINFO, CVAR_LATCH } from "../src/shared/q_shared";
import { SV_Init } from "../src/server/sv_main";
import {
  SV_AddLocalSeat,
  SV_RemoveLocalSeats,
  SV_NumLocalSeats,
  SV_LocalSeatThink,
  SV_LocalSeatCommand,
  SV_LocalSeatPlayerState,
  SV_LocalSeatPlayernum,
  SV_LocalSeatViewOrigins,
  SV_ClearLocalSeatsForTests,
} from "../src/server/sv_seats";

// ---------------------------------------------------------------------------
// 1. VIEWPORT RECT MATH
// ---------------------------------------------------------------------------

function area(r: SeatViewportT): number {
  return r.width * r.height;
}

function overlaps(a: SeatViewportT, b: SeatViewportT): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("SplitscreenLayout -- viewport rect math", () => {
  test("one seat is the whole screen, aligned exactly the way SCR_CalcVrect aligns it (width & ~7, height & ~1)", () => {
    // 1366x769 is deliberately unaligned on both axes.
    const [full] = SplitscreenLayout(1, 1366, 769, SPLIT_LAYOUT_AUTO);
    expect(full.x).toBe(0);
    expect(full.y).toBe(0);
    expect(full.width).toBe(1366 & ~7); // 1360
    expect(full.height).toBe(769 & ~1); // 768
  });

  test("seat count is clamped to [1, MAX_LOCAL_SEATS] -- a bogus cvar can never produce more panes than the layout defines", () => {
    expect(SplitscreenLayout(0, 1280, 720, SPLIT_LAYOUT_AUTO)).toHaveLength(1);
    expect(SplitscreenLayout(-3, 1280, 720, SPLIT_LAYOUT_AUTO)).toHaveLength(1);
    expect(SplitscreenLayout(99, 1280, 720, SPLIT_LAYOUT_AUTO)).toHaveLength(MAX_LOCAL_SEATS);
    expect(SplitscreenLayout(2.9, 1280, 720, SPLIT_LAYOUT_AUTO)).toHaveLength(2);
  });

  test("two seats, forced side-by-side: a vertical divider, panes at x=0 and x=halfWidth, full height", () => {
    const [a, b] = SplitscreenLayout(2, 1280, 720, SPLIT_LAYOUT_SIDE_BY_SIDE);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(b.x).toBe(640);
    expect(b.y).toBe(0);
    expect(a.height).toBe(720);
    expect(b.height).toBe(720);
    expect(a.width).toBe(640);
    expect(b.width).toBe(640);
  });

  test("two seats, forced stacked: a horizontal divider, panes at y=0 and y=halfHeight, full width", () => {
    const [a, b] = SplitscreenLayout(2, 1280, 720, SPLIT_LAYOUT_STACKED);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(b.x).toBe(0);
    expect(b.y).toBe(360);
    expect(a.width).toBe(1280);
    expect(b.width).toBe(1280);
    expect(a.height).toBe(360);
    expect(b.height).toBe(360);
  });

  test("two seats on auto: side-by-side on a wide display, stacked once the display is narrower than 3:2", () => {
    // 16:9 -- 1.78, wide.
    const wide = SplitscreenLayout(2, 1920, 1080, SPLIT_LAYOUT_AUTO);
    expect(wide[1].x).toBeGreaterThan(0); // split along x
    expect(wide[1].y).toBe(0);

    // 4:3 -- 1.33, narrow.
    const narrow = SplitscreenLayout(2, 1024, 768, SPLIT_LAYOUT_AUTO);
    expect(narrow[1].x).toBe(0);
    expect(narrow[1].y).toBeGreaterThan(0); // split along y

    // Exactly at the 3:2 threshold the rule is inclusive: side-by-side.
    const threshold = SplitscreenLayout(2, 1200, 800, SPLIT_LAYOUT_AUTO);
    expect(threshold[1].x).toBeGreaterThan(0);
  });

  test("three seats are quadrants with the bottom-right cell left empty -- every pane keeps the same size and aspect", () => {
    const seats = SplitscreenLayout(3, 1280, 720, SPLIT_LAYOUT_AUTO);
    expect(seats).toHaveLength(3);
    expect(seats[0]).toMatchObject({ x: 0, y: 0 });
    expect(seats[1]).toMatchObject({ x: 640, y: 0 });
    expect(seats[2]).toMatchObject({ x: 0, y: 360 });
    // No pane is stretched to fill the missing fourth cell.
    expect(area(seats[0])).toBe(area(seats[1]));
    expect(area(seats[0])).toBe(area(seats[2]));
  });

  test("four seats are the full quadrant set", () => {
    const seats = SplitscreenLayout(4, 1280, 720, SPLIT_LAYOUT_AUTO);
    expect(seats).toHaveLength(4);
    expect(seats[0]).toMatchObject({ x: 0, y: 0 });
    expect(seats[1]).toMatchObject({ x: 640, y: 0 });
    expect(seats[2]).toMatchObject({ x: 0, y: 360 });
    expect(seats[3]).toMatchObject({ x: 640, y: 360 });
  });

  test("panes never overlap, at any seat count, on aligned and unaligned displays alike", () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [1366, 769],
      [1024, 768],
      [800, 600],
    ]) {
      for (const n of [2, 3, 4]) {
        for (const mode of [SPLIT_LAYOUT_AUTO, SPLIT_LAYOUT_SIDE_BY_SIDE, SPLIT_LAYOUT_STACKED]) {
          const seats = SplitscreenLayout(n, w, h, mode);
          for (let i = 0; i < seats.length; i++) {
            for (let j = i + 1; j < seats.length; j++) {
              expect(overlaps(seats[i], seats[j])).toBe(false);
            }
          }
        }
      }
    }
  });

  test("every pane stays inside the display and keeps SCR_CalcVrect's alignment, so neither renderer is handed a rect it cannot set a viewport for", () => {
    for (const [w, h] of [
      [1366, 769],
      [1920, 1080],
      [1023, 767],
    ]) {
      for (const n of [1, 2, 3, 4]) {
        for (const seat of SplitscreenLayout(n, w, h, SPLIT_LAYOUT_AUTO)) {
          expect(seat.x).toBeGreaterThanOrEqual(0);
          expect(seat.y).toBeGreaterThanOrEqual(0);
          expect(seat.x + seat.width).toBeLessThanOrEqual(w);
          expect(seat.y + seat.height).toBeLessThanOrEqual(h);
          expect(seat.width % 8).toBe(0);
          expect(seat.height % 2).toBe(0);
          expect(seat.width).toBeGreaterThan(0);
          expect(seat.height).toBeGreaterThan(0);
        }
      }
    }
  });

  test("the alignment slack is small -- the gutter between panes is a divider, not a missing chunk of screen", () => {
    // Four quadrants on an unaligned display: the panes must still cover
    // nearly the whole surface (>98%), or the split would read as broken.
    const seats = SplitscreenLayout(4, 1366, 769, SPLIT_LAYOUT_AUTO);
    const covered = seats.reduce((sum, r) => sum + area(r), 0);
    expect(covered / (1366 * 769)).toBeGreaterThan(0.98);
  });
});

// ---------------------------------------------------------------------------
// 2. PER-SEAT USERCMD GENERATION
// ---------------------------------------------------------------------------

const TEST_CVARS: SeatCmdCvarsT = {
  forwardspeed: 200,
  sidespeed: 200,
  upspeed: 200,
  yawspeed: 140,
  pitchspeed: 150,
  deadzone: 0.15,
  forwardsensitivity: 1,
  sidesensitivity: 1,
  yawsensitivity: 1,
  pitchsensitivity: 1,
};

// Reading through a call defeats TypeScript's assignment narrowing: after a
// literal `state.pendingCommand = null`, a direct property read stays typed
// `null` for the rest of the block even across the intervening BuildCmd call,
// which makes `expect(...).toBe("weapnext")` pick the wrong overload.
function pendingOf(s: SeatInputStateT): string | null {
  return s.pendingCommand;
}

function pad(over: Partial<{ leftX: number; leftY: number; rightX: number; rightY: number; triggerL: number; triggerR: number; buttons: number }> = {}) {
  return { leftX: 0, leftY: 0, rightX: 0, rightY: 0, triggerL: 0, triggerR: 0, buttons: 0, ...over };
}

describe("CL_Seat_BuildCmd -- per-seat usercmd from a pad snapshot", () => {
  test("an idle pad produces a still command: no movement, no buttons, angles echoing the seat's own viewangles", () => {
    const state = new SeatInputStateT();
    state.viewangles[YAW] = 45;
    const cmd = CL_Seat_BuildCmd(state, pad(), 0.05, 50, TEST_CVARS, 0);

    // toBeCloseTo, not toBe: a zeroed stick multiplies through `-ly` and
    // yields -0, which is numerically zero and encodes to the same wire
    // short, but is not `Object.is`-equal to 0.
    expect(cmd.forwardmove).toBeCloseTo(0, 10);
    expect(cmd.sidemove).toBeCloseTo(0, 10);
    expect(cmd.upmove).toBe(0);
    expect(cmd.buttons).toBe(0);
    expect(cmd.msec).toBe(50);
    expect(cmd.angles[YAW]).toBe(ANGLE2SHORT(45));
  });

  test("left stick up is FORWARD (SDL's Y axis is positive down) and left stick right is strafe right -- the same signs IN_JoyMove gives seat 0", () => {
    const state = new SeatInputStateT();
    const fwd = CL_Seat_BuildCmd(state, pad({ leftY: -32767 }), 0.05, 50, TEST_CVARS, 0);
    expect(fwd.forwardmove).toBeGreaterThan(0);

    const back = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ leftY: 32767 }), 0.05, 50, TEST_CVARS, 0);
    expect(back.forwardmove).toBeLessThan(0);

    const right = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ leftX: 32767 }), 0.05, 50, TEST_CVARS, 0);
    expect(right.sidemove).toBeGreaterThan(0);

    const left = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ leftX: -32767 }), 0.05, 50, TEST_CVARS, 0);
    expect(left.sidemove).toBeLessThan(0);
  });

  test("stick input inside the deadzone produces no movement at all", () => {
    const state = new SeatInputStateT();
    // 10% of full scale, under the 0.15 deadzone.
    const cmd = CL_Seat_BuildCmd(state, pad({ leftX: 3276, leftY: 3276 }), 0.05, 50, TEST_CVARS, 0);
    expect(cmd.forwardmove).toBeCloseTo(0, 10);
    expect(cmd.sidemove).toBeCloseTo(0, 10);
  });

  test("right stick integrates the seat's OWN viewangles over frametime: stick right lowers yaw, stick down raises pitch", () => {
    const state = new SeatInputStateT();
    CL_Seat_BuildCmd(state, pad({ rightX: 32767 }), 0.1, 100, TEST_CVARS, 0);
    expect(state.viewangles[YAW]).toBeLessThan(0);

    const state2 = new SeatInputStateT();
    CL_Seat_BuildCmd(state2, pad({ rightY: 32767 }), 0.1, 100, TEST_CVARS, 0);
    expect(state2.viewangles[PITCH]).toBeGreaterThan(0);
  });

  test("look integration accumulates across frames and is scaled by frametime, not applied per-call as a constant", () => {
    const oneLongFrame = new SeatInputStateT();
    CL_Seat_BuildCmd(oneLongFrame, pad({ rightX: 32767 }), 0.1, 100, TEST_CVARS, 0);

    const twoShortFrames = new SeatInputStateT();
    CL_Seat_BuildCmd(twoShortFrames, pad({ rightX: 32767 }), 0.05, 50, TEST_CVARS, 0);
    CL_Seat_BuildCmd(twoShortFrames, pad({ rightX: 32767 }), 0.05, 50, TEST_CVARS, 0);

    expect(twoShortFrames.viewangles[YAW]).toBeCloseTo(oneLongFrame.viewangles[YAW], 4);
  });

  test("two seats' viewangles are independent -- one seat looking around never moves the other's camera", () => {
    const seat1 = new SeatInputStateT();
    const seat2 = new SeatInputStateT();
    CL_Seat_BuildCmd(seat1, pad({ rightX: 32767 }), 0.1, 100, TEST_CVARS, 0);
    CL_Seat_BuildCmd(seat2, pad(), 0.1, 100, TEST_CVARS, 0);

    expect(seat1.viewangles[YAW]).not.toBe(0);
    expect(seat2.viewangles[YAW]).toBe(0);
  });

  test("right trigger past the threshold is BUTTON_ATTACK; below it, nothing", () => {
    const on = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ triggerR: 32767 }), 0.05, 50, TEST_CVARS, 0);
    expect(on.buttons & ButtonT.BUTTON_ATTACK).toBeTruthy();

    // 10% pull, under the 0.3 threshold gamepad_map.ts uses for seat 0.
    const off = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ triggerR: 3276 }), 0.05, 50, TEST_CVARS, 0);
    expect(off.buttons & ButtonT.BUTTON_ATTACK).toBeFalsy();
  });

  test("the button map: X uses, A jumps (and drives upmove), B crouches (and drives negative upmove)", () => {
    const use = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ buttons: 1 << SEAT_PAD_BUTTON_USE }), 0.05, 50, TEST_CVARS, 0);
    expect(use.buttons & ButtonT.BUTTON_USE).toBeTruthy();

    const jump = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ buttons: 1 << SEAT_PAD_BUTTON_JUMP }), 0.05, 50, TEST_CVARS, 0);
    expect(jump.buttons & ButtonT.BUTTON_JUMP).toBeTruthy();
    expect(jump.upmove).toBe(TEST_CVARS.upspeed);

    const crouch = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ buttons: 1 << SEAT_PAD_BUTTON_CROUCH }), 0.05, 50, TEST_CVARS, 0);
    expect(crouch.buttons & ButtonT.BUTTON_CROUCH).toBeTruthy();
    expect(crouch.upmove).toBe(-TEST_CVARS.upspeed);
  });

  test("BUTTON_ANY is set whenever anything is pressed and clear when nothing is -- the same 'any key whatsoever' contract CL_FinishMove keeps for seat 0", () => {
    const idle = CL_Seat_BuildCmd(new SeatInputStateT(), pad(), 0.05, 50, TEST_CVARS, 0);
    expect(idle.buttons & ButtonT.BUTTON_ANY).toBeFalsy();

    const pressed = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ buttons: 1 << SEAT_PAD_BUTTON_USE }), 0.05, 50, TEST_CVARS, 0);
    expect(pressed.buttons & ButtonT.BUTTON_ANY).toBeTruthy();
  });

  test("weapon cycling is EDGE triggered: one queued command per press, not one per frame the shoulder is held", () => {
    const state = new SeatInputStateT();
    const down = pad({ buttons: 1 << SEAT_PAD_BUTTON_WEAPNEXT });

    CL_Seat_BuildCmd(state, down, 0.05, 50, TEST_CVARS, 0);
    expect(state.pendingCommand).toBe("weapnext");

    // The runtime drains it; holding the button must not re-queue.
    state.pendingCommand = null;
    CL_Seat_BuildCmd(state, down, 0.05, 50, TEST_CVARS, 0);
    expect(pendingOf(state)).toBeNull();

    // Release, then press again -- a new edge, a new command.
    CL_Seat_BuildCmd(state, pad(), 0.05, 50, TEST_CVARS, 0);
    CL_Seat_BuildCmd(state, down, 0.05, 50, TEST_CVARS, 0);
    expect(pendingOf(state)).toBe("weapnext");
  });

  test("the left shoulder queues weapprev", () => {
    const state = new SeatInputStateT();
    CL_Seat_BuildCmd(state, pad({ buttons: 1 << SEAT_PAD_BUTTON_WEAPPREV }), 0.05, 50, TEST_CVARS, 0);
    expect(state.pendingCommand).toBe("weapprev");
  });

  test("forward/side movement is clamped to the server's 400 unit ceiling, exactly as CL_ClampSpeed clamps seat 0's", () => {
    const fast: SeatCmdCvarsT = { ...TEST_CVARS, forwardspeed: 5000, sidespeed: 5000 };
    const cmd = CL_Seat_BuildCmd(new SeatInputStateT(), pad({ leftX: 32767, leftY: -32767 }), 0.05, 50, fast, 0);
    expect(cmd.forwardmove).toBe(400);
    expect(cmd.sidemove).toBe(400);
  });

  test("an unreasonable frame time is replaced with 100ms, matching CL_FinishMove's own guard", () => {
    const cmd = CL_Seat_BuildCmd(new SeatInputStateT(), pad(), 0.05, 900, TEST_CVARS, 0);
    expect(cmd.msec).toBe(100);
  });
});

describe("CL_Seat_ClampPitch -- per-seat, against the seat's own delta_angles", () => {
  test("pitch is clamped to +/-89 degrees so a seat cannot look through its own feet", () => {
    const up = new SeatInputStateT();
    up.viewangles[PITCH] = -200;
    CL_Seat_ClampPitch(up, 0);
    expect(up.viewangles[PITCH]).toBeCloseTo(-89, 4);

    const down = new SeatInputStateT();
    down.viewangles[PITCH] = 200;
    CL_Seat_ClampPitch(down, 0);
    expect(down.viewangles[PITCH]).toBeCloseTo(89, 4);
  });

  test("a pitch past a full turn WRAPS first and is then only clamped if it is still out of range -- CL_ClampPitch's exact wrap-then-clamp order, reproduced rather than 'fixed'", () => {
    // -400 wraps to -40, which is inside +/-89, so the clamp does not fire.
    // Clamping first would have produced -89 and silently changed where the
    // seat is looking.
    const wrapped = new SeatInputStateT();
    wrapped.viewangles[PITCH] = -400;
    CL_Seat_ClampPitch(wrapped, 0);
    expect(wrapped.viewangles[PITCH]).toBeCloseTo(-40, 4);
  });

  test("the clamp is applied against the seat's delta_angles, so a server-forced view angle shifts the limit with it (same arithmetic as CL_ClampPitch)", () => {
    const state = new SeatInputStateT();
    state.viewangles[PITCH] = 89;
    const delta = ANGLE2SHORT(30);
    CL_Seat_ClampPitch(state, delta);
    // The sum must land on the ceiling, not the raw viewangle.
    expect(state.viewangles[PITCH] + SHORT2ANGLE(delta)).toBeCloseTo(89, 3);
  });

  test("an in-range pitch is left untouched", () => {
    const state = new SeatInputStateT();
    state.viewangles[PITCH] = 12.5;
    CL_Seat_ClampPitch(state, 0);
    expect(state.viewangles[PITCH]).toBeCloseTo(12.5, 4);
  });
});

// ---------------------------------------------------------------------------
// 3. PER-SEAT HUD RECT AND SCALE
// ---------------------------------------------------------------------------

describe("per-seat HUD geometry", () => {
  let savedWidth = 0;
  let savedHeight = 0;

  beforeEach(() => {
    savedWidth = viddef.width;
    savedHeight = viddef.height;
    Cvar_ForceSet("scr_scale", "0"); // auto tier
  });

  afterEach(() => {
    viddef.width = savedWidth;
    viddef.height = savedHeight;
    Cvar_ForceSet("scr_scale", "0");
  });

  test("a seat's auto HUD scale is derived from its own pane, not the display: a quarter of a 4K screen scales like the 1080p screen it is the size of", () => {
    const quarterOf4K = seatHudUpscaleFactor(1920, 1080);
    const whole1080p = autoHudUpscale(1920, 1080);
    expect(quarterOf4K).toBe(whole1080p);
    // And it is genuinely smaller than the factor the full 4K surface picks.
    expect(quarterOf4K).toBeLessThanOrEqual(autoHudUpscale(3840, 2160));
  });

  test("a user-set scr_scale still wins outright over the per-seat auto tier (R_ClampScale's own precedence)", () => {
    Cvar_ForceSet("scr_scale", "3");
    expect(seatHudUpscaleFactor(1920, 1080)).toBe(3);
    Cvar_ForceSet("scr_scale", "99");
    expect(seatHudUpscaleFactor(1920, 1080)).toBe(10); // clamped 1..10
  });

  test("the seat's hud_vrect is its real pixel rect pre-divided by the upscale, so multiplying back by `scale` lands every HUD element inside that pane", () => {
    const seat = { x: 640, y: 0, width: 640, height: 720 };
    const upscale = 2;
    const rect = kexSeatHudVrect(seat, upscale);

    expect(rect.x).toBe(320);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(320);
    expect(rect.height).toBe(360);

    // cg_screen.ts computes `(hud_vrect.x + offset) * scale`; with offset 0
    // that has to come back to the pane's real left edge.
    expect(rect.x * upscale).toBe(seat.x);
    expect((rect.x + rect.width) * upscale).toBe(seat.x + seat.width);
  });

  test("hud_safe is a ZERO-origin inset, not a second copy of hud_vrect -- the bug that left the two bottom panes of a live 4-way frame with no HUD at all", () => {
    // cg_screen.ts computes bottom-anchored positions as
    // `(hud_vrect.y + hud_vrect.height + offset) * scale - hud_safe.y`
    // (cg_screen.ts:911). Passing the seat's own rect as hud_safe made
    // hud_safe.y nonzero for any pane not at the top of the screen, which
    // moved every bottom-anchored element (health, ammo, armor) off the
    // bottom edge. Reproduced here as the arithmetic, so it cannot come back.
    // A bottom-left quadrant of a 1280x720 display, at the upscale a pane
    // that size actually picks (1).
    const bottomPane = { x: 0, y: 360, width: 640, height: 360 };
    const upscale = 1;
    const vrect = kexSeatHudVrect(bottomPane, upscale);
    const safe = kexSeatHudSafe(vrect);

    expect(safe.x).toBe(0);
    expect(safe.y).toBe(0);
    expect(safe.width).toBe(vrect.width);
    expect(safe.height).toBe(vrect.height);

    // A HUD item anchored 32 pixels above the pane's bottom edge.
    const bottomAnchored = (vrect.y + vrect.height - 32) * upscale - safe.y;
    expect(bottomAnchored).toBe(bottomPane.y + bottomPane.height - 32);
    expect(bottomAnchored).toBeGreaterThan(bottomPane.y); // inside its own pane
    expect(bottomAnchored).toBeLessThan(bottomPane.y + bottomPane.height);

    // With the old (wrong) inset the subtraction ran twice: the item was
    // displaced a full pane-height UPWARD, out of its own pane and into the
    // one above it -- which is why the live 4-way frame showed HUDs only in
    // the two TOP panes.
    const withWrongInset = (vrect.y + vrect.height - 32) * upscale - vrect.y;
    expect(withWrongInset).toBeLessThan(bottomPane.y);
  });

  test("a left-anchored item in a right-hand pane lands inside that pane, not shifted by a phantom inset", () => {
    const rightPane = { x: 640, y: 0, width: 640, height: 720 };
    const upscale = 2;
    const vrect = kexSeatHudVrect(rightPane, upscale);
    const safe = kexSeatHudSafe(vrect);

    const leftAnchored = (vrect.x + 16 / upscale) * upscale + safe.x;
    expect(leftAnchored).toBe(rightPane.x + 16);
    expect(leftAnchored).toBeLessThan(rightPane.x + rightPane.width);
  });

  test("every seat's HUD rect stays within its own pane at upscale 1 -- no pane's HUD can draw into a neighbour's viewport", () => {
    const seats = SplitscreenLayout(4, 1920, 1080, SPLIT_LAYOUT_AUTO);
    for (const seat of seats) {
      const rect = kexSeatHudVrect(seat, 1);
      expect(rect.x).toBe(seat.x);
      expect(rect.y).toBe(seat.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1920);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1080);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. SERVER-SIDE SEAT LIFECYCLE
// ---------------------------------------------------------------------------

interface FakeGClient {
  ps: {
    pmove: { origin: Int16Array; viewheight: number; delta_angles: Int16Array };
    viewoffset: Float32Array;
    viewangles: Float32Array;
  };
}

function makeFakeEdict(number: number): Edict & { client: FakeGClient } {
  const client: FakeGClient = {
    ps: {
      pmove: { origin: new Int16Array(3), viewheight: 22, delta_angles: new Int16Array(3) },
      viewoffset: new Float32Array(3),
      viewangles: new Float32Array(3),
    },
  };
  const ent = {
    s: { number },
    client,
    inuse: false,
    svflags: 0,
    areanum: 0,
    areanum2: 0,
  };
  // Edict carries far more than a seat test touches; the seat code only ever
  // reads .client.ps and passes the edict straight back to the game module,
  // so this narrow shape is what the seam actually requires.
  return ent as unknown as Edict & { client: FakeGClient };
}

interface SeatTrace {
  connects: number[];
  begins: number[];
  thinks: { entnum: number; cmd: UsercmdT }[];
  commands: number[];
  disconnects: number[];
}

function makeSeatGameExports(trace: SeatTrace, edicts: (Edict & { client: FakeGClient })[]): GameExports {
  return {
    apiversion: 3,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect(ent: Edict, userinfo: string) {
      trace.connects.push(ent.s.number);
      return { allowed: true, userinfo };
    },
    ClientBegin(ent: Edict) {
      trace.begins.push(ent.s.number);
    },
    ClientUserinfoChanged() {},
    ClientDisconnect(ent: Edict) {
      trace.disconnects.push(ent.s.number);
    },
    ClientCommand(ent: Edict) {
      trace.commands.push(ent.s.number);
    },
    ClientThink(ent: Edict, cmd: UsercmdT) {
      trace.thinks.push({ entnum: ent.s.number, cmd });
    },
    RunFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: edicts.length,
    max_edicts: edicts.length,
  };
}

describe("SV_AddLocalSeat / SV_LocalSeatThink / SV_RemoveLocalSeats", () => {
  let trace: SeatTrace;
  let edicts: (Edict & { client: FakeGClient })[];
  let savedGe: GameExports | null = null;
  let savedState = ServerStateT.ss_dead;

  beforeEach(() => {
    // Rule 13: this suite brings up everything it reads. maxclients must be
    // wide enough for a primary plus three seats; SV_Init is what binds the
    // module-level `maxclients` cvar handle sv_seats.ts reads.
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    SV_Init();
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);

    savedGe = geHolder.ge;
    savedState = sv.state;

    trace = { connects: [], begins: [], thinks: [], commands: [], disconnects: [] };
    edicts = Array.from({ length: 9 }, (_, i) => makeFakeEdict(i));
    geHolder.ge = makeSeatGameExports(trace, edicts);

    // svs.clients is allocated by SV_InitGame (sv_init.ts), not SV_Init, so
    // a suite that never spawns a server has to provide it -- same direct
    // assignment test/server_core.test.ts uses for its own client fixtures.
    svs.clients = Array.from({ length: 8 }, () => new ClientT());
    sv.state = ServerStateT.ss_game;
    SV_ClearLocalSeatsForTests();
  });

  afterEach(() => {
    SV_ClearLocalSeatsForTests();
    for (const c of svs.clients) c.clear();
    geHolder.ge = savedGe;
    sv.state = savedState;
  });

  test("a seat is refused unless a local GAME is running -- there is no wire representation for a seat on a remote server", () => {
    sv.state = ServerStateT.ss_dead;
    expect(SV_AddLocalSeat("\\name\\Player 2")).toBeNull();
    expect(SV_NumLocalSeats()).toBe(0);

    sv.state = ServerStateT.ss_game;
    expect(SV_AddLocalSeat("\\name\\Player 2")).toBe(0);
    expect(SV_NumLocalSeats()).toBe(1);
  });

  test("seating runs the game module's real connect handshake: ClientConnect then ClientBegin, on the seat's own edict", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    expect(trace.connects).toHaveLength(1);
    expect(trace.begins).toHaveLength(1);
    expect(trace.connects[0]).toBe(trace.begins[0]);
    // Player slot 0 is edict 1 -- the same clientnum+1 mapping
    // SVC_DirectConnect uses.
    expect(trace.begins[0]).toBe(1);
  });

  test("each seat takes a DISTINCT player slot and a distinct edict, exactly as two separate connections would", () => {
    const a = SV_AddLocalSeat("\\name\\Player 2");
    const b = SV_AddLocalSeat("\\name\\Player 3");
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(SV_LocalSeatPlayernum(0)).not.toBe(SV_LocalSeatPlayernum(1));
    expect(trace.begins).toEqual([1, 2]);
    expect(SV_NumLocalSeats()).toBe(2);
  });

  test("a seated client is marked isLocalSeat and left in cs_spawned, so the send loop skips it and the timeout sweep does not see a stalled connection", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    const seated = svs.clients.filter((c) => c.isLocalSeat);
    expect(seated).toHaveLength(1);
    expect(seated[0].state).toBe(ClientStateT.cs_spawned);
    // No netchan was ever set up: it must still be the untouched default.
    expect(seated[0].netchan.remote_address.port).toBe(0);
  });

  test("a seat's usercmd reaches the game module's ClientThink on the seat's OWN edict, with the command it was given", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    SV_AddLocalSeat("\\name\\Player 3");

    const cmd0 = new UsercmdT();
    cmd0.forwardmove = 111;
    const cmd1 = new UsercmdT();
    cmd1.forwardmove = 222;

    SV_LocalSeatThink(0, cmd0);
    SV_LocalSeatThink(1, cmd1);

    expect(trace.thinks).toHaveLength(2);
    expect(trace.thinks[0].entnum).toBe(1);
    expect(trace.thinks[0].cmd.forwardmove).toBe(111);
    expect(trace.thinks[1].entnum).toBe(2);
    expect(trace.thinks[1].cmd.forwardmove).toBe(222);
  });

  test("seat commands never cross seats: seat 1's move is not delivered to seat 0's edict", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    SV_AddLocalSeat("\\name\\Player 3");

    const cmd = new UsercmdT();
    cmd.sidemove = 50;
    SV_LocalSeatThink(1, cmd);

    expect(trace.thinks).toHaveLength(1);
    expect(trace.thinks[0].entnum).toBe(2);
  });

  test("thinking on an unseated index is a no-op rather than an error -- a pad unplugged mid-frame must not take the game down", () => {
    expect(() => SV_LocalSeatThink(3, new UsercmdT())).not.toThrow();
    expect(trace.thinks).toHaveLength(0);
  });

  test("SV_LocalSeatCommand routes a game command (weapnext) to the seat's own edict", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    SV_LocalSeatCommand(0, "weapnext");
    expect(trace.commands).toEqual([1]);
  });

  test("teardown disconnects every seat through the game module and frees the player slots for the next session", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    SV_AddLocalSeat("\\name\\Player 3");
    SV_RemoveLocalSeats();

    expect(trace.disconnects).toEqual([1, 2]);
    expect(SV_NumLocalSeats()).toBe(0);
    expect(svs.clients.filter((c) => c.state !== ClientStateT.cs_free)).toHaveLength(0);
    expect(svs.clients.filter((c) => c.isLocalSeat)).toHaveLength(0);
  });

  test("seat count is capped at MAX_LOCAL_SEATS even when the server has slots to spare", () => {
    for (let i = 0; i < MAX_LOCAL_SEATS + 3; i++) SV_AddLocalSeat(`\\name\\P${i}`);
    expect(SV_NumLocalSeats()).toBe(MAX_LOCAL_SEATS);
  });

  test("SV_LocalSeatPlayerState hands back the game module's live gclient playerstate, not a copy taken at seat time", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    const ps = SV_LocalSeatPlayerState(0);
    expect(ps).not.toBeNull();

    // Mutating the game's own edict must be visible through the accessor --
    // this is what makes a seat's viewport track the server with no frame
    // decode in between.
    edicts[1].client.ps.pmove.origin[0] = 800;
    expect(SV_LocalSeatPlayerState(0)?.pmove.origin[0]).toBe(800);
  });
});

describe("SV_LocalSeatViewOrigins -- the PVS-union input", () => {
  let trace: SeatTrace;
  let edicts: (Edict & { client: FakeGClient })[];
  let savedGe: GameExports | null = null;
  let savedState = ServerStateT.ss_dead;

  beforeEach(() => {
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    SV_Init();
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    savedGe = geHolder.ge;
    savedState = sv.state;
    trace = { connects: [], begins: [], thinks: [], commands: [], disconnects: [] };
    edicts = Array.from({ length: 9 }, (_, i) => makeFakeEdict(i));
    geHolder.ge = makeSeatGameExports(trace, edicts);
    // svs.clients is allocated by SV_InitGame (sv_init.ts), not SV_Init, so
    // a suite that never spawns a server has to provide it -- same direct
    // assignment test/server_core.test.ts uses for its own client fixtures.
    svs.clients = Array.from({ length: 8 }, () => new ClientT());
    sv.state = ServerStateT.ss_game;
    SV_ClearLocalSeatsForTests();
  });

  afterEach(() => {
    SV_ClearLocalSeatsForTests();
    for (const c of svs.clients) c.clear();
    geHolder.ge = savedGe;
    sv.state = savedState;
  });

  test("with no seats the list is empty -- every union inside SV_BuildClientFrame collapses to the pre-splitscreen single-origin computation", () => {
    expect(SV_LocalSeatViewOrigins()).toHaveLength(0);
  });

  test("each seat contributes its EYE origin: quantized pmove origin, plus viewoffset, plus the re-release viewheight term", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    // pmove.origin is in 1/8 units.
    edicts[1].client.ps.pmove.origin[0] = 800; // 100 units
    edicts[1].client.ps.pmove.origin[1] = -400; // -50 units
    edicts[1].client.ps.pmove.origin[2] = 160; // 20 units
    edicts[1].client.ps.viewoffset[2] = 1;
    edicts[1].client.ps.pmove.viewheight = 22;

    const origins = SV_LocalSeatViewOrigins();
    expect(origins).toHaveLength(1);
    expect(origins[0][0]).toBeCloseTo(100, 4);
    expect(origins[0][1]).toBeCloseTo(-50, 4);
    expect(origins[0][2]).toBeCloseTo(20 + 1 + 22, 4);
  });

  test("two seats far apart both report, so the frame's PVS union covers both viewports", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    SV_AddLocalSeat("\\name\\Player 3");
    edicts[1].client.ps.pmove.origin[0] = 8000; // 1000 units
    edicts[2].client.ps.pmove.origin[0] = -8000; // -1000 units

    const origins = SV_LocalSeatViewOrigins();
    expect(origins).toHaveLength(2);
    expect(origins[0][0]).toBeCloseTo(1000, 4);
    expect(origins[1][0]).toBeCloseTo(-1000, 4);
  });
});
