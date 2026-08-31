// Divergence-audit wave B fixes for src/client/cl_input.ts, verified
// against q2repro's src/client/input.c. Self-sufficient per PORTING.md rule
// 13: every test resets the kbutton_t state it depends on directly, since
// cl_input.ts's kbutton_t globals (in_up/in_down/in_forward/...) are
// process-wide singletons shared with test/cl_main.test.ts's own cl_input.ts
// coverage when bun runs both files in the same process.
//
// Four groups, one per finding:
//   A. visible-wrong: a jump/crouch tap fully contained within one frame
//      used to lose its BUTTON_JUMP/BUTTON_CROUCH latch (input.c:326-333,
//      465-482, 665-668, 824-827, 869-887).
//   B. latent: CL_ClampSpeed was entirely missing (input.c:617-623).
//   C. latent: KeyUp's uptime>downtime guard was missing (input.c:314-321).
//   D. latent: the classic (has_upmove) wire write path kept
//      BUTTON_HOLSTER/JUMP/CROUCH in the buttons byte instead of masking
//      them out (input.c:933-963).

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { cl, cls, ConnstateT, type KbuttonT } from "../src/client/client";
import { Cmd_ExecuteString } from "../src/qcommon/cmd";
import { CL_InitLocal } from "../src/client/cl_main";
import { in_up, in_down, in_forward, CL_CreateCmd, CL_ClampSpeed, CL_StripKexButtonsForLegacyWire } from "../src/client/cl_input";
import { UsercmdT } from "../src/shared/q_shared";
import { ButtonT } from "../src/kexapi/game";

function resetButton(b: KbuttonT): void {
  b.down[0] = 0;
  b.down[1] = 0;
  b.state = 0;
  b.msec = 0;
  b.downtime = 0;
}

describe("cl_input.ts wave-B divergence-audit fixes", () => {
  beforeAll(() => {
    CL_InitLocal(); // registers +moveup/-moveup/+forward/-forward/etc.
  });

  beforeEach(() => {
    resetButton(in_up);
    resetButton(in_down);
    resetButton(in_forward);
    cls.state = ConnstateT.ca_active;
    cl.weapon_lock_time = 0;
    cl.time = 0;
    cls.frametime = 0.05;
  });

  // -------------------------------------------------------------------
  // A. sub-frame jump/crouch tap latch (visible-wrong)
  // -------------------------------------------------------------------

  test("a jump tap fully contained in one frame still sets BUTTON_JUMP", () => {
    CL_CreateCmd(); // warm up frame_msec / flush any prior edge state
    Cmd_ExecuteString("+moveup 501 1000");
    Cmd_ExecuteString("-moveup 501 1010");
    const cmd = CL_CreateCmd();
    expect(cmd.buttons & ButtonT.BUTTON_JUMP).toBe(ButtonT.BUTTON_JUMP);
  });

  test("a crouch tap fully contained in one frame still sets BUTTON_CROUCH", () => {
    CL_CreateCmd();
    Cmd_ExecuteString("+movedown 502 1000");
    Cmd_ExecuteString("-movedown 502 1010");
    const cmd = CL_CreateCmd();
    expect(cmd.buttons & ButtonT.BUTTON_CROUCH).toBe(ButtonT.BUTTON_CROUCH);
  });

  test("no jump/crouch bit is set when neither key was ever touched", () => {
    CL_CreateCmd();
    const cmd = CL_CreateCmd();
    expect(cmd.buttons & ButtonT.BUTTON_JUMP).toBe(0);
    expect(cmd.buttons & ButtonT.BUTTON_CROUCH).toBe(0);
  });

  test("the latch is consumed, not sticky -- it does not bleed into the following frame", () => {
    CL_CreateCmd();
    Cmd_ExecuteString("+moveup 503 1000");
    Cmd_ExecuteString("-moveup 503 1010");
    const first = CL_CreateCmd();
    expect(first.buttons & ButtonT.BUTTON_JUMP).toBe(ButtonT.BUTTON_JUMP);

    const second = CL_CreateCmd(); // no new +moveup/-moveup events this frame
    expect(second.buttons & ButtonT.BUTTON_JUMP).toBe(0);
  });

  test("a key still held down at frame-build time keeps setting the button every frame", () => {
    CL_CreateCmd();
    Cmd_ExecuteString("+moveup 504 1000"); // never released
    const first = CL_CreateCmd();
    expect(first.buttons & ButtonT.BUTTON_JUMP).toBe(ButtonT.BUTTON_JUMP);
    const second = CL_CreateCmd();
    expect(second.buttons & ButtonT.BUTTON_JUMP).toBe(ButtonT.BUTTON_JUMP);
    Cmd_ExecuteString("-moveup 504 2000");
  });

  // -------------------------------------------------------------------
  // B. CL_ClampSpeed (latent)
  // -------------------------------------------------------------------

  test("CL_ClampSpeed caps forward/side to +/-400 and leaves upmove untouched", () => {
    const cmd = new UsercmdT();
    cmd.forwardmove = 900;
    cmd.sidemove = -900;
    cmd.upmove = 900;
    CL_ClampSpeed(cmd);
    expect(cmd.forwardmove).toBe(400);
    expect(cmd.sidemove).toBe(-400);
    expect(cmd.upmove).toBe(900);
  });

  test("CL_ClampSpeed is a no-op within the default range", () => {
    const cmd = new UsercmdT();
    cmd.forwardmove = 150;
    cmd.sidemove = -75;
    CL_ClampSpeed(cmd);
    expect(cmd.forwardmove).toBe(150);
    expect(cmd.sidemove).toBe(-75);
  });

  // -------------------------------------------------------------------
  // C. KeyUp's uptime>downtime guard (latent)
  // -------------------------------------------------------------------

  test("a stale KeyUp timestamp (uptime <= downtime) adds no held time", () => {
    Cmd_ExecuteString("+forward 601 5000"); // downtime = 5000
    Cmd_ExecuteString("-forward 601 4000"); // uptime = 4000, BEFORE downtime
    expect(in_forward.msec).toBe(0);
  });

  test("uptime === downtime also adds nothing (not `> `, strictly greater required)", () => {
    Cmd_ExecuteString("+forward 604 5000");
    Cmd_ExecuteString("-forward 604 5000");
    expect(in_forward.msec).toBe(0);
  });

  test("a normal KeyUp timestamp (uptime > downtime) still accumulates the held time", () => {
    Cmd_ExecuteString("+forward 602 1000");
    Cmd_ExecuteString("-forward 602 1500");
    expect(in_forward.msec).toBe(500);
  });

  test("KeyUp with uptime===0 keeps the vanilla +10ms fallback, unaffected by the guard", () => {
    Cmd_ExecuteString("+forward 603 1000");
    Cmd_ExecuteString("-forward 603 0");
    expect(in_forward.msec).toBe(10);
  });

  // -------------------------------------------------------------------
  // D. legacy (has_upmove) wire write masking (latent)
  // -------------------------------------------------------------------

  test("CL_StripKexButtonsForLegacyWire drops HOLSTER/JUMP/CROUCH but keeps ATTACK/USE/ANY", () => {
    const BUTTON_ATTACK = 1;
    const BUTTON_USE = 2;
    const BUTTON_ANY = 128;
    const src = new UsercmdT();
    src.buttons = ButtonT.BUTTON_HOLSTER | ButtonT.BUTTON_JUMP | ButtonT.BUTTON_CROUCH | BUTTON_ATTACK | BUTTON_USE | BUTTON_ANY;
    src.upmove = 42; // real analog upmove -- must NOT be touched/folded
    src.forwardmove = 7;
    src.msec = 16;

    const out = CL_StripKexButtonsForLegacyWire(src);

    expect(out.buttons).toBe(BUTTON_ATTACK | BUTTON_USE | BUTTON_ANY);
    expect(out.upmove).toBe(42);
    expect(out.forwardmove).toBe(7);
    expect(out.msec).toBe(16);

    // the source object itself must be unmutated -- cl.cmds[] entries are
    // shared with local prediction and the kex batched-move writer.
    expect(src.buttons).toBe(ButtonT.BUTTON_HOLSTER | ButtonT.BUTTON_JUMP | ButtonT.BUTTON_CROUCH | BUTTON_ATTACK | BUTTON_USE | BUTTON_ANY);
  });

  test("CL_StripKexButtonsForLegacyWire is a no-op when none of the three bits are set", () => {
    const src = new UsercmdT();
    src.buttons = 1 | 2; // ATTACK | USE
    const out = CL_StripKexButtonsForLegacyWire(src);
    expect(out.buttons).toBe(1 | 2);
  });
});
