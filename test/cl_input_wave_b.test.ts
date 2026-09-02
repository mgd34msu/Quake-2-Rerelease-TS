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
//   E. regression guard, added after a "+moveup only lasts one frame" report
//      that did NOT reproduce: a key held across MANY frames must keep
//      contributing its full cl_*speed every single frame, not just the
//      first. cl_input.c's CL_KeyState returns the fraction of the frame the
//      key was down (1.0 for a full frame) and CL_BaseMove multiplies the
//      speed cvar by it unconditionally, so the value is flat for as long as
//      the key is down. Nothing in the existing suite walked more than two
//      frames, and the one test that looked like it did (cl_main.test.ts's
//      "reports a fraction ... growing as the hold continues") reads
//      CL_KeyState AFTER CL_CreateCmd already consumed the accumulated msec,
//      so it only ever saw 0 and asserted the vacuous 0 <= v <= 1.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { cl, cls, ConnstateT, clCvars, in_klook, in_strafe, in_speed, type KbuttonT } from "../src/client/client";
import { Cmd_ExecuteString } from "../src/qcommon/cmd";
import { CL_InitLocal } from "../src/client/cl_main";
import { in_up, in_down, in_forward, CL_CreateCmd, CL_ClampSpeed, CL_StripKexButtonsForLegacyWire, Sys_SendKeyEvents } from "../src/client/cl_input";
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

  // -------------------------------------------------------------------
  // E. a held key sustains its move across many frames (regression guard)
  //
  // Drives the real per-frame sequence CL_SendCommand (cl_main.ts) runs:
  // Sys_SendKeyEvents latches sys_frame_time for the frame, then
  // CL_CreateCmd computes frame_msec from it and calls CL_BaseMove.
  // CL_KeyState's steady-state value is EXACTLY 1 here, not merely close to
  // it: on every frame after the first, `msec = sys_frame_time - downtime`
  // and `frame_msec = sys_frame_time - old_sys_frame_time` are measured over
  // the same interval, because CL_KeyState latches downtime and CL_CreateCmd
  // latches old_sys_frame_time from the same previous sys_frame_time. So the
  // per-frame move is the speed cvar unscaled, whatever the real frame time
  // turns out to be, and these assertions are exact rather than approximate.
  // -------------------------------------------------------------------

  // Each frame needs sys_frame_time (platform/sys.ts's Sys_Milliseconds, a
  // whole-millisecond counter) to actually advance; a zero-length frame
  // would clamp frame_msec to 1 with 0 accumulated msec and read as no
  // input at all. Bun.sleep(5) is the same real-clock step the existing
  // cl_main.test.ts kbutton tests use.
  const FRAME_SLEEP_MS = 5;

  async function pumpFrame(): Promise<UsercmdT> {
    await Bun.sleep(FRAME_SLEEP_MS);
    Sys_SendKeyEvents(); // what CL_SendCommand does first, every frame
    return CL_CreateCmd();
  }

  function resetSpeedCvars(): void {
    // self-sufficient per the file header: these cvars and the modifier
    // kbuttons are process-wide singletons shared with cl_main.test.ts.
    if (clCvars.cl_upspeed) clCvars.cl_upspeed.value = 200;
    if (clCvars.cl_forwardspeed) clCvars.cl_forwardspeed.value = 200;
    if (clCvars.cl_sidespeed) clCvars.cl_sidespeed.value = 200;
    if (clCvars.cl_run) clCvars.cl_run.value = 0; // no speed-key doubling
    resetButton(in_klook);
    resetButton(in_strafe);
    resetButton(in_speed);
  }

  test("+moveup held for 10 frames keeps upmove at cl_upspeed on every frame", async () => {
    resetSpeedCvars();
    await pumpFrame(); // warm frame_msec / old_sys_frame_time

    Cmd_ExecuteString("+moveup"); // console/cfg form, exactly like a bound cfg

    const upmoves: number[] = [];
    const jumpBits: number[] = [];
    for (let i = 0; i < 10; i++) {
      const cmd = await pumpFrame();
      upmoves.push(cmd.upmove);
      jumpBits.push(cmd.buttons & ButtonT.BUTTON_JUMP);
    }

    expect(upmoves).toEqual(new Array(10).fill(200));
    // kex vertical intent rides the button bit (the 1038 batched-move format
    // has no upmove field), so that must hold every frame too.
    expect(jumpBits).toEqual(new Array(10).fill(ButtonT.BUTTON_JUMP));
    expect(in_up.state & 1).toBe(1); // still down

    Cmd_ExecuteString("-moveup");
  });

  test("-moveup ends the hold: the next frame's upmove is back to 0 and stays there", async () => {
    resetSpeedCvars();
    await pumpFrame();

    Cmd_ExecuteString("+moveup");
    expect((await pumpFrame()).upmove).toBe(200);
    expect((await pumpFrame()).upmove).toBe(200);

    // KeyUp's "typed manually at the console" branch clears both key slots
    // and accumulates no trailing msec, so the release is clean immediately.
    Cmd_ExecuteString("-moveup");
    expect(in_up.state & 1).toBe(0);

    const after: number[] = [];
    for (let i = 0; i < 4; i++) after.push((await pumpFrame()).upmove);
    expect(after).toEqual([0, 0, 0, 0]);
  });

  test("+movedown held for 10 frames keeps upmove at -cl_upspeed on every frame", async () => {
    resetSpeedCvars();
    await pumpFrame();

    Cmd_ExecuteString("+movedown");

    const upmoves: number[] = [];
    const crouchBits: number[] = [];
    for (let i = 0; i < 10; i++) {
      const cmd = await pumpFrame();
      upmoves.push(cmd.upmove);
      crouchBits.push(cmd.buttons & ButtonT.BUTTON_CROUCH);
    }

    expect(upmoves).toEqual(new Array(10).fill(-200));
    expect(crouchBits).toEqual(new Array(10).fill(ButtonT.BUTTON_CROUCH));

    Cmd_ExecuteString("-movedown");
    expect((await pumpFrame()).upmove).toBe(0);
  });

  test("+forward sustains identically -- the vertical and horizontal paths do not diverge", async () => {
    resetSpeedCvars();
    await pumpFrame();

    Cmd_ExecuteString("+forward");
    const forwards: number[] = [];
    for (let i = 0; i < 10; i++) forwards.push((await pumpFrame()).forwardmove);
    expect(forwards).toEqual(new Array(10).fill(200));
    Cmd_ExecuteString("-forward");
    expect((await pumpFrame()).forwardmove).toBe(0);
  });

  test("a bound-key hold (+moveup with a key number) sustains just like the console form", async () => {
    resetSpeedCvars();
    await pumpFrame();

    // The bind path passes the key number and a real downtime timestamp.
    // It must be a timestamp that is always in the PAST relative to
    // sys_frame_time (platform/sys.ts counts milliseconds since the first
    // Sys_Milliseconds call in the process, so early in a fast `bun test`
    // run it is only a few hundred); a downtime ahead of it would make
    // CL_KeyState's `sys_frame_time - downtime` negative and clamp to 0.
    Cmd_ExecuteString("+moveup 32 1");
    const upmoves: number[] = [];
    for (let i = 0; i < 10; i++) upmoves.push((await pumpFrame()).upmove);
    expect(upmoves).toEqual(new Array(10).fill(200));

    // a key-repeat +moveup for the SAME key mid-hold must change nothing
    // (KeyDown's "repeating key" early-out)
    Cmd_ExecuteString("+moveup 32 1");
    expect((await pumpFrame()).upmove).toBe(200);

    Cmd_ExecuteString("-moveup 32");
    expect(in_up.state & 1).toBe(0);
  });
});
