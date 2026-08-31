/*
Round-trip tests for the client-side batched-move WRITER (clc_batch_move.ts's
BitWriter/writeBatchMoveFrames + q2repro.ts's encodeQ2ReproBatchCmd/
writeBatchMove) against this port's own byte-exact READER (readBatchMove,
itself validated against q2proto_proto_q2repro.c by hand-derived vectors in
test/protocol_clc_batch_move.test.ts). The reader is the wire truth here:
whatever it reconstructs is what the server's SV_NewClientExecuteMove runs.

Rule 13: self-sufficient -- everything below builds its own SizeBufs and
UsercmdTs; no engine init, no other test file.
*/

import { describe, test, expect } from "bun:test";
import { SizeBuf, SZ_Init, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { UsercmdT } from "../src/shared/q_shared";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import type { ClcBatchMoveFrameT } from "../src/qcommon/protocol/clc_batch_move";

function makeCmd(fields: Partial<{ pitch: number; yaw: number; roll: number; forward: number; side: number; buttons: number; msec: number }>): UsercmdT {
  const cmd = new UsercmdT();
  if (fields.pitch !== undefined) cmd.angles[0] = fields.pitch;
  if (fields.yaw !== undefined) cmd.angles[1] = fields.yaw;
  if (fields.roll !== undefined) cmd.angles[2] = fields.roll;
  cmd.forwardmove = fields.forward ?? 0;
  cmd.sidemove = fields.side ?? 0;
  cmd.buttons = fields.buttons ?? 0;
  cmd.msec = fields.msec ?? 0;
  return cmd;
}

function roundTrip(lastframe: number | null, frames: ClcBatchMoveFrameT[]): { lastframe: number; frames: ClcBatchMoveFrameT[] } {
  const buf = new SizeBuf();
  SZ_Init(buf, new Uint8Array(256), 256);
  if (!Q2REPRO_CODEC.writeBatchMove || !Q2REPRO_CODEC.readBatchMove) throw new Error("codec missing batch move members");
  Q2REPRO_CODEC.writeBatchMove(buf, lastframe, frames);
  buf.readcount = 0;
  const result = Q2REPRO_CODEC.readBatchMove(buf, lastframe === null, 0);
  // the reader must have consumed the entire encoding -- a trailing surplus
  // would desync the NEXT clc message in a real packet
  expect(buf.readcount).toBe(buf.cursize);
  return result;
}

describe("q2repro writeBatchMove -> readBatchMove round trip", () => {
  test("single frame, single cmd: every field survives", () => {
    const cmd = makeCmd({ pitch: -1200, yaw: 9000, roll: -3, forward: 200, side: -110, buttons: 0x89, msec: 25 });
    const out = roundTrip(77, [{ cmds: [cmd] }]);
    expect(out.lastframe).toBe(77);
    expect(out.frames.length).toBe(1);
    const rt = out.frames[0].cmds[0];
    expect(rt.angles[0]).toBe(-1200);
    expect(rt.angles[1]).toBe(9000);
    expect(rt.angles[2]).toBe(-3);
    expect(rt.forwardmove).toBe(200);
    expect(rt.sidemove).toBe(-110);
    expect(rt.buttons).toBe(0x89);
    expect(rt.msec).toBe(25);
  });

  test("nodelta form: no lastframe long on the wire, reader sees -1", () => {
    const out = roundTrip(null, [{ cmds: [makeCmd({ forward: 400, msec: 16 })] }]);
    expect(out.lastframe).toBe(-1);
    expect(out.frames[0].cmds[0].forwardmove).toBe(400);
  });

  test("prev-inheritance chain: unchanged fields ride the seedFromPrev copy across cmds and frame boundaries", () => {
    const a = makeCmd({ pitch: 100, yaw: 200, forward: 200, buttons: 1, msec: 25 });
    const b = makeCmd({ pitch: 100, yaw: 250, forward: 200, buttons: 1, msec: 25 }); // only yaw changes
    const c = makeCmd({ pitch: 100, yaw: 250, forward: -50, buttons: 3, msec: 30 }); // frame 2
    const out = roundTrip(5, [{ cmds: [a, b] }, { cmds: [c] }]);
    expect(out.frames.length).toBe(2);
    const [ra, rb] = out.frames[0].cmds;
    const rc = out.frames[1].cmds[0];
    expect(rb.angles[0]).toBe(100);
    expect(rb.angles[1]).toBe(250);
    expect(rb.forwardmove).toBe(200);
    expect(rc.angles[1]).toBe(250); // inherited across the frame boundary
    expect(rc.forwardmove).toBe(-50);
    expect(rc.buttons).toBe(3);
    expect(rc.msec).toBe(30);
    expect(ra.buttons).toBe(1);
  });

  test("signed 16-bit angle extremes round-trip (Int16Array wrap semantics)", () => {
    const cmd = makeCmd({ pitch: -32768, yaw: 32767, roll: -32768, msec: 10 });
    const rt = roundTrip(0, [{ cmds: [cmd] }]).frames[0].cmds[0];
    expect(rt.angles[0]).toBe(-32768);
    expect(rt.angles[1]).toBe(32767);
    expect(rt.angles[2]).toBe(-32768);
  });

  test("forward/side clamp to the signed 10-bit range instead of corrupting the bitstream", () => {
    const cmd = makeCmd({ forward: 5000, side: -5000, msec: 10 });
    const rt = roundTrip(0, [{ cmds: [cmd] }]).frames[0].cmds[0];
    expect(rt.forwardmove).toBe(511);
    expect(rt.sidemove).toBe(-512);
  });

  test("empty frame (0 cmds) encodes and reads as an empty frame", () => {
    const out = roundTrip(3, [{ cmds: [] }]);
    expect(out.frames.length).toBe(1);
    expect(out.frames[0].cmds.length).toBe(0);
  });

  test("wire prefix layout: lastframe long, numDups byte, lightlevel byte precede the bitstream", () => {
    const buf = new SizeBuf();
    SZ_Init(buf, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writeBatchMove!(buf, 0x01020304, [{ cmds: [] }, { cmds: [] }]);
    buf.readcount = 0;
    expect(MSG_ReadByte(buf)).toBe(0x04); // little-endian long
    expect(MSG_ReadByte(buf)).toBe(0x03);
    expect(MSG_ReadByte(buf)).toBe(0x02);
    expect(MSG_ReadByte(buf)).toBe(0x01);
    expect(MSG_ReadByte(buf)).toBe(1); // numDups = frames-1
    expect(MSG_ReadByte(buf)).toBe(0); // lightlevel
  });
});
