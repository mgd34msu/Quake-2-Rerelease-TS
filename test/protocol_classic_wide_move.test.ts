/*
The widened CLASSIC session (protocol 4038, Q2REPRO_CLASSIC_CODEC) carries the
client's move commands in q2repro's BATCHED form, because that is the only form
the 1038-family wire has. But the batched form was designed around the
RERELEASE game module, and drops two usercmd fields that module never reads:

  - `upmove`. q2repro's own decoder treats CM_UP as a protocol violation
    (Q2P_ERR_BAD_DATA); the rerelease carries vertical intent as BUTTON_JUMP /
    BUTTON_CROUCH instead. The CLASSIC module has no such handling: qcommon/
    pmove.ts reads cmd.upmove directly in PM_CheckJump (`upmove < 10` -> no
    jump), PM_CheckDuck (`upmove < 0` -> duck), PM_WaterMove and PM_FlyMove.
  - `lightlevel`. The batched message carries one lightlevel byte, but
    apply_usercmd_delta never copies it into usercmd_t, so 1038 writes 0 and
    discards it on read. The CLASSIC module does read it: p_client.ts's
    ClientThink does `ent.light_level = ucmd.lightlevel`, and g_ai.ts's
    FindTarget then early-outs on `client.light_level <= 5` ("is client in an
    spot too dark to be seen?").

Shipping 1038's encoder on 4038 therefore handed the classic module upmove 0
and lightlevel 0 on every frame of a widened session: the player could neither
jump nor crouch, and no monster ever acquired him -- indistinguishable from
notarget being on. 4038 is this engine's OWN protocol number (see
PROTOCOL_VERSION_RERELEASE_CLASSIC in qcommon.ts) and no other implementation
speaks it, so it carries both fields; 1038 is unchanged and still rejects
CM_UP, which the last group below pins down.

Rule 13: self-sufficient -- every test builds its own SizeBufs, UsercmdTs and
PmoveT stubs; no engine init, no other test file.
*/

import { describe, expect, test } from "bun:test";
import { SizeBuf, SZ_Init } from "../src/qcommon/sizebuf";
import { Pmove } from "../src/qcommon/pmove";
import { UsercmdT, PmoveT, TraceT, CplaneT, PmTypeT, PMF_DUCKED, PMF_ON_GROUND } from "../src/shared/q_shared";
import { Q2REPRO_CODEC, Q2REPRO_CLASSIC_CODEC } from "../src/qcommon/protocol/q2repro";
import { ClcBatchMoveError, type ClcBatchMoveFrameT } from "../src/qcommon/protocol/clc_batch_move";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { type Vec3, VectorCopy } from "../src/shared/math";

function makeCmd(fields: Partial<{ forward: number; side: number; up: number; buttons: number; msec: number; lightlevel: number }>): UsercmdT {
  const cmd = new UsercmdT();
  cmd.forwardmove = fields.forward ?? 0;
  cmd.sidemove = fields.side ?? 0;
  cmd.upmove = fields.up ?? 0;
  cmd.buttons = fields.buttons ?? 0;
  cmd.msec = fields.msec ?? 0;
  cmd.lightlevel = fields.lightlevel ?? 0;
  return cmd;
}

/** One client->server move packet, written by `codec` and read back by the
 *  same codec -- i.e. exactly what the server's SV_NewClientExecuteMove ends
 *  up handing to SV_ClientThink. */
function roundTrip(codec: ProtocolCodec, frames: ClcBatchMoveFrameT[]): ClcBatchMoveFrameT[] {
  const buf = new SizeBuf();
  SZ_Init(buf, new Uint8Array(512), 512);
  if (!codec.writeBatchMove || !codec.readBatchMove) throw new Error(`${codec.name} is missing batch-move members`);
  codec.writeBatchMove(buf, 77, frames);
  buf.readcount = 0;
  const out = codec.readBatchMove(buf, false, 0);
  // a trailing surplus would desync the next clc message in a real packet
  expect(buf.readcount).toBe(buf.cursize);
  return out.frames;
}

function roundTripOne(codec: ProtocolCodec, cmd: UsercmdT): UsercmdT {
  return roundTrip(codec, [{ cmds: [cmd] }])[0].cmds[0];
}

describe("4038 (widened classic session) batched move carries upmove", () => {
  test("a jump command's upmove survives the wire", () => {
    const rt = roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ up: 200, msec: 20 }));
    expect(rt.upmove).toBe(200);
  });

  test("a crouch command's negative upmove survives the wire", () => {
    const rt = roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ up: -200, msec: 20 }));
    expect(rt.upmove).toBe(-200);
  });

  test("the running-speed extreme CL_BaseMove can produce (+/-400) survives", () => {
    expect(roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ up: 400, msec: 20 })).upmove).toBe(400);
    expect(roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ up: -400, msec: 20 })).upmove).toBe(-400);
  });

  test("an unchanged upmove inherits across commands in one batch (delta form)", () => {
    // Second command repeats the first's upmove, so CM_UP is not re-sent; the
    // decoder must inherit it via seedFromPrev rather than reset it to 0.
    const frames = roundTrip(Q2REPRO_CLASSIC_CODEC, [
      { cmds: [makeCmd({ up: 200, msec: 20 }), makeCmd({ up: 200, msec: 20, forward: 300 })] },
    ]);
    expect(frames[0].cmds[0].upmove).toBe(200);
    expect(frames[0].cmds[1].upmove).toBe(200);
    expect(frames[0].cmds[1].forwardmove).toBe(300);
  });

  test("releasing the key mid-batch sends upmove back to 0", () => {
    const frames = roundTrip(Q2REPRO_CLASSIC_CODEC, [
      { cmds: [makeCmd({ up: 200, msec: 20 }), makeCmd({ up: 0, msec: 20 })] },
    ]);
    expect(frames[0].cmds[0].upmove).toBe(200);
    expect(frames[0].cmds[1].upmove).toBe(0);
  });

  test("upmove does not disturb the fields the batched form already carried", () => {
    const rt = roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ forward: 400, side: -200, up: 200, buttons: 0x89, msec: 25 }));
    expect(rt.forwardmove).toBe(400);
    expect(rt.sidemove).toBe(-200);
    expect(rt.buttons).toBe(0x89);
    expect(rt.msec).toBe(25);
    expect(rt.upmove).toBe(200);
  });
});

describe("4038 batched move carries lightlevel (FindTarget's too-dark gate)", () => {
  test("a lit player's light level survives the wire", () => {
    // Anything above FindTarget's `<= 5` threshold is what matters; 128 is a
    // typical mid-brightness R_SetLightLevel result.
    expect(roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ lightlevel: 128, msec: 20 })).lightlevel).toBe(128);
  });

  test("the full byte range survives", () => {
    expect(roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ lightlevel: 255, msec: 20 })).lightlevel).toBe(255);
    expect(roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ lightlevel: 0, msec: 20 })).lightlevel).toBe(0);
  });

  test("the message's single lightlevel byte reaches every command in the batch", () => {
    // q2repro.c:2704 stamps one per-MESSAGE byte onto every decoded command.
    const frames = roundTrip(Q2REPRO_CLASSIC_CODEC, [
      { cmds: [makeCmd({ lightlevel: 90, msec: 20 }), makeCmd({ lightlevel: 90, msec: 20, forward: 100 })] },
    ]);
    expect(frames[0].cmds[0].lightlevel).toBe(90);
    expect(frames[0].cmds[1].lightlevel).toBe(90);
  });
});

describe("1038 (real q2repro wire) is unchanged", () => {
  test("upmove is still dropped, exactly as q2repro's own encoder drops it", () => {
    expect(roundTripOne(Q2REPRO_CODEC, makeCmd({ up: 200, msec: 20 })).upmove).toBe(0);
  });

  test("lightlevel is still written 0 and discarded", () => {
    expect(roundTripOne(Q2REPRO_CODEC, makeCmd({ lightlevel: 128, msec: 20 })).lightlevel).toBe(0);
  });

  test("1038's reader still rejects a CM_UP-bearing stream", () => {
    // Encode with 4038 (which sets CM_UP), decode with 1038: this is the
    // Q2P_ERR_BAD_DATA path q2proto_proto_q2repro.c:2662-2663 takes, and it
    // must stay a hard rejection so a real q2repro peer's guarantees hold.
    const buf = new SizeBuf();
    SZ_Init(buf, new Uint8Array(512), 512);
    if (!Q2REPRO_CLASSIC_CODEC.writeBatchMove || !Q2REPRO_CODEC.readBatchMove) throw new Error("codec missing batch-move members");
    Q2REPRO_CLASSIC_CODEC.writeBatchMove(buf, 77, [{ cmds: [makeCmd({ up: 200, msec: 20 })] }]);
    buf.readcount = 0;
    expect(() => Q2REPRO_CODEC.readBatchMove?.(buf, false, 0)).toThrow(ClcBatchMoveError);
  });

  test("a command with no vertical movement is byte-identical on both codecs", () => {
    // The 4038 extension must cost nothing when the player is not pressing
    // jump or crouch and the light level is 0 -- the only bytes that can
    // differ are the ones the extension actually adds.
    const cmd = makeCmd({ forward: 400, side: -200, buttons: 0x03, msec: 25 });
    const bufA = new SizeBuf();
    SZ_Init(bufA, new Uint8Array(512), 512);
    const bufB = new SizeBuf();
    SZ_Init(bufB, new Uint8Array(512), 512);
    Q2REPRO_CODEC.writeBatchMove?.(bufA, 77, [{ cmds: [cmd] }]);
    Q2REPRO_CLASSIC_CODEC.writeBatchMove?.(bufB, 77, [{ cmds: [cmd] }]);
    expect(Array.from(bufB.data.subarray(0, bufB.cursize))).toEqual(Array.from(bufA.data.subarray(0, bufA.cursize)));
  });
});

// ---------------------------------------------------------------------------
// End to end: the classic Pmove, driven by commands that actually went through
// each wire. This is the behavior the play-test reported -- "player is unable
// to jump ... the player is unable to crouch".
// ---------------------------------------------------------------------------

function makeStubTrace(grounded: boolean): (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceT {
  return (_start, _mins, _maxs, end) => {
    const t = new TraceT();
    t.allsolid = false;
    t.startsolid = false;
    t.fraction = 1;
    VectorCopy(end, t.endpos);
    t.plane = new CplaneT();
    t.plane.normal[2] = 1;
    t.surface = null;
    t.contents = 0;
    t.ent = grounded ? {} : null;
    return t;
  };
}

function newGroundedPmove(): PmoveT {
  const pm = new PmoveT();
  pm.trace = makeStubTrace(true);
  pm.pointcontents = () => 0;
  pm.s.pm_type = PmTypeT.PM_NORMAL;
  pm.s.gravity = 800;
  pm.cmd.msec = 20;
  return pm;
}

/** Runs one Pmove frame with `cmd` after it has crossed `codec`'s wire. */
function stepThroughWire(pm: PmoveT, codec: ProtocolCodec, cmd: UsercmdT): void {
  const wire = roundTripOne(codec, cmd);
  pm.cmd = wire;
  Pmove(pm);
}

describe("classic Pmove driven through the widened-session wire", () => {
  test("4038: crouch ducks the player and drops the view height", () => {
    const pm = newGroundedPmove();
    stepThroughWire(pm, Q2REPRO_CLASSIC_CODEC, makeCmd({ msec: 20 })); // settle on ground
    expect(pm.s.pm_flags & PMF_ON_GROUND).not.toBe(0);
    expect(pm.s.pm_flags & PMF_DUCKED).toBe(0);
    expect(pm.viewheight).toBe(22);

    stepThroughWire(pm, Q2REPRO_CLASSIC_CODEC, makeCmd({ up: -200, msec: 20 }));
    expect(pm.s.pm_flags & PMF_DUCKED).not.toBe(0);
    expect(pm.viewheight).toBe(-2);
    expect(pm.maxs[2]).toBe(4);
  });

  test("1038's encoder on the same session would leave the player unable to crouch", () => {
    // The shipped bug, pinned so it cannot come back: identical input, 1038
    // wire, no duck at all.
    const pm = newGroundedPmove();
    stepThroughWire(pm, Q2REPRO_CODEC, makeCmd({ msec: 20 }));
    stepThroughWire(pm, Q2REPRO_CODEC, makeCmd({ up: -200, msec: 20 }));
    expect(pm.s.pm_flags & PMF_DUCKED).toBe(0);
    expect(pm.viewheight).toBe(22);
  });

  test("4038: jump leaves the ground with the classic 270 unit/s impulse", () => {
    const pm = newGroundedPmove();
    stepThroughWire(pm, Q2REPRO_CLASSIC_CODEC, makeCmd({ msec: 20 }));
    expect(pm.s.pm_flags & PMF_ON_GROUND).not.toBe(0);

    stepThroughWire(pm, Q2REPRO_CLASSIC_CODEC, makeCmd({ up: 200, msec: 20 }));
    // PM_CheckJump sets velocity[2] = 270, then PM_AirMove's gravity takes one
    // frame's worth back off it -- so it is well above 0 and the player is no
    // longer on the ground.
    expect(pm.s.velocity[2]).toBeGreaterThan(200);
    expect(pm.s.pm_flags & PMF_ON_GROUND).toBe(0);
  });

  test("1038's encoder on the same session would leave the player unable to jump", () => {
    const pm = newGroundedPmove();
    stepThroughWire(pm, Q2REPRO_CODEC, makeCmd({ msec: 20 }));
    stepThroughWire(pm, Q2REPRO_CODEC, makeCmd({ up: 200, msec: 20 }));
    expect(pm.s.velocity[2]).toBeLessThanOrEqual(0);
    expect(pm.s.pm_flags & PMF_ON_GROUND).not.toBe(0);
  });

  test("4038: a lit player crosses FindTarget's `light_level > 5` threshold", () => {
    // ClientThink assigns ent.light_level = ucmd.lightlevel verbatim, so the
    // wire value IS what FindTarget tests.
    const lit = roundTripOne(Q2REPRO_CLASSIC_CODEC, makeCmd({ lightlevel: 128, msec: 20 }));
    expect(lit.lightlevel).toBeGreaterThan(5);
    // ...and the 1038 encoder's 0 does not, which is why monsters never
    // acquired the player in a widened classic session.
    const unlit = roundTripOne(Q2REPRO_CODEC, makeCmd({ lightlevel: 128, msec: 20 }));
    expect(unlit.lightlevel).toBeLessThanOrEqual(5);
  });
});
