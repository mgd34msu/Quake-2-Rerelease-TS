// Byte-vector suite for the Q2PRO/q2repro batched-move client commands
// (clc_q2pro_move_batched / clc_q2pro_move_nodelta / clc_q2pro_userinfo_delta
// -- phase-8 q2repro interop unit). Covers Q2REPRO_CODEC.readBatchMove
// (src/qcommon/protocol/q2repro.ts) and Q2PRO_CODEC.readBatchMove
// (src/qcommon/protocol/q2pro.ts), both built on the shared decode machinery
// in src/qcommon/protocol/clc_batch_move.ts.
//
// Vector construction: the simplest cases (no-op command, malformed
// rejection, userinfo delta) are literal byte arrays with the derivation
// shown inline. The multi-field/multi-command cases use a small test-local
// `TestBitWriter`, transcribed directly from q2proto's OWN bitwriter
// (~/Projects/q2proto/src/q2proto_internal_bit_read_write.h:28-81's
// bitwriter_write/bitwriter_flush -- an LSB-first bit packer, cited field by
// field below), to keep hand-tracing a 50+ bit stream by eye out of the
// loop: the writer is the reference algorithm's write half, not a shortcut
// around it, and every case's field VALUES are still chosen and asserted by
// hand against q2proto_proto_q2repro.c/q2proto_proto_q2pro.c's read
// functions.
//
// Run alone (per .orch/preferences.md rule 13):
//   bun test test/protocol_clc_batch_move.test.ts

import { describe, test, expect } from "bun:test";
import { SizeBuf, SZ_Init, MSG_BeginReading } from "../src/qcommon/sizebuf";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import { Q2PRO_CODEC } from "../src/qcommon/protocol/q2pro";
import { ClcBatchMoveError } from "../src/qcommon/protocol/clc_batch_move";

function bufFromBytes(bytes: number[]): SizeBuf {
  const msg = new SizeBuf();
  const size = Math.max(bytes.length, 1) + 16;
  SZ_Init(msg, new Uint8Array(size), size);
  msg.data.set(bytes, 0);
  msg.cursize = bytes.length;
  MSG_BeginReading(msg);
  return msg;
}

// LSB-first bit packer, transcribed from bitwriter_write/bitwriter_flush
// (q2proto_internal_bit_read_write.h:41-81): each `write(value, bits)` call
// appends `bits` low bits of `value` (unsigned view -- callers pre-mask
// negative values the same way the C's `v & ((1<<bits)-1)` does) to the
// stream, LSB of the FIRST call ending up as bit 0 of byte 0. `finish()`
// zero-pads the final partial byte, matching bitwriter_flush's byte-at-a-
// time drain of any leftover bits.
class TestBitWriter {
  private acc = 0;
  private accBits = 0;
  private readonly bytes: number[] = [];

  write(value: number, bits: number): void {
    const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    const v = (value & mask) >>> 0;
    this.acc = (this.acc | (v * 2 ** this.accBits)) >>> 0;
    this.accBits += bits;
    while (this.accBits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc = Math.floor(this.acc / 256);
      this.accBits -= 8;
    }
  }

  finish(): number[] {
    if (this.accBits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.accBits = 0;
    }
    return this.bytes;
  }
}

function le32(n: number): number[] {
  const u = n >>> 0;
  return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
}

// CM_* bit positions (qcommon.ts): ANGLE1=1, ANGLE2=2, ANGLE3=4, FORWARD=8,
// SIDE=16, UP=32, BUTTONS=64, IMPULSE=128.
const CM_ANGLE1 = 1;
const CM_ANGLE2 = 2;
const CM_ANGLE3 = 4;
const CM_FORWARD = 8;
const CM_SIDE = 16;
const CM_UP = 32;
const CM_BUTTONS = 64;
const CM_IMPULSE = 128;

describe("Q2REPRO_CODEC.readBatchMove -- clc_q2pro_move_batched (1038)", () => {
  test("single frame, single cmd, no content bit -> all-zero command (prev=null)", () => {
    // lastframe=250 (i32 LE), numDups=0, lightlevel=7 (decoded, unused),
    // bitstream: numCmds(5 bits)=1, hasContents(1 bit)=0 -> packed into one
    // byte: bit0..4 = 00001 (value 1), bit5 = 0 -> byte = 0x01.
    const bytes = [...le32(250), 0, 7, 0x01];
    const msg = bufFromBytes(bytes);
    const result = Q2REPRO_CODEC.readBatchMove!(msg, false, 0);

    expect(result.lastframe).toBe(250);
    expect(result.numDups).toBe(0);
    expect(result.frames.length).toBe(1);
    expect(result.frames[0].cmds.length).toBe(1);
    const cmd = result.frames[0].cmds[0];
    expect(Array.from(cmd.angles)).toEqual([0, 0, 0]);
    expect(cmd.forwardmove).toBe(0);
    expect(cmd.sidemove).toBe(0);
    expect(cmd.buttons).toBe(0);
    expect(cmd.msec).toBe(0);
  });

  test("clc_q2pro_move_nodelta variant: no lastframe on the wire, result.lastframe = -1", () => {
    // Same bitstream as above, but the i32 lastframe field is absent
    // (q2repro_server_read_batch_move: `if (nodelta) move->lastframe = -1;`).
    const bytes = [0, 9, 0x01];
    const msg = bufFromBytes(bytes);
    const result = Q2REPRO_CODEC.readBatchMove!(msg, true, 0);

    expect(result.lastframe).toBe(-1);
    expect(result.numDups).toBe(0);
    expect(result.frames[0].cmds.length).toBe(1);
  });

  test("single cmd with absolute angles + forward + buttons + explicit msec", () => {
    const bits = CM_ANGLE1 | CM_ANGLE2 | CM_ANGLE3 | CM_FORWARD | CM_SIDE | CM_BUTTONS | CM_IMPULSE;
    const w = new TestBitWriter();
    w.write(1, 5); // numCmds
    w.write(1, 1); // hasContents
    w.write(bits, 8);
    w.write(0, 1); // angle0 deltaFlag=0 (absolute)
    w.write(1000, 16); // angle0 = 1000
    w.write(0, 1); // angle1 deltaFlag=0 (absolute)
    w.write(-2000 & 0xffff, 16); // angle1 = -2000 (two's complement in 16 bits)
    w.write(12345 & 0xffff, 16); // angle2 -- always absolute, no delta flag bit at all
    w.write(300 & 0x3ff, 10); // forwardmove = 300 (10-bit signed field)
    w.write(-100 & 0x3ff, 10); // sidemove = -100
    w.write(3, 8); // buttons = 3
    w.write(20, 8); // msec = 20 (CM_IMPULSE reused as "explicit msec follows")
    const bitstream = w.finish();

    const bytes = [...le32(0), 0, 0, ...bitstream];
    const msg = bufFromBytes(bytes);
    const result = Q2REPRO_CODEC.readBatchMove!(msg, false, 0);

    const cmd = result.frames[0].cmds[0];
    expect(cmd.angles[0]).toBe(1000);
    expect(cmd.angles[1]).toBe(-2000);
    expect(cmd.angles[2]).toBe(12345);
    expect(cmd.forwardmove).toBe(300);
    expect(cmd.sidemove).toBe(-100);
    expect(cmd.buttons).toBe(3);
    expect(cmd.msec).toBe(20);
  });

  test("batch of 3 frames (num_dups=2), angle deltas and full-field inheritance chained across frame boundaries", () => {
    const w = new TestBitWriter();

    // Frame 0: one cmd, sets angle0=5000 (absolute), forwardmove=400, buttons=1, no explicit msec (inherits 0).
    w.write(1, 5); // frame 0 numCmds
    w.write(1, 1); // hasContents
    w.write(CM_ANGLE1 | CM_FORWARD | CM_BUTTONS, 8);
    w.write(0, 1); // angle0 absolute
    w.write(5000 & 0xffff, 16);
    w.write(400 & 0x3ff, 10);
    w.write(1, 8); // buttons

    // Frame 1: one cmd, has_contents=0 -> inherits EVERYTHING from frame 0's cmd (angle0=5000, forwardmove=400, buttons=1, msec=0).
    w.write(1, 5); // frame 1 numCmds
    w.write(0, 1); // hasContents = 0

    // Frame 2 (the newest, index numDups=2): one cmd, angle0 DELTA (+50 from
    // the inherited 5000 -> 5050), sidemove set, explicit msec.
    w.write(1, 5); // frame 2 numCmds
    w.write(1, 1); // hasContents
    w.write(CM_ANGLE1 | CM_SIDE | CM_IMPULSE, 8);
    w.write(1, 1); // angle0 deltaFlag=1 (relative)
    w.write(50 & 0xff, 8); // +50
    w.write(-25 & 0x3ff, 10); // sidemove = -25
    w.write(16, 8); // explicit msec = 16

    const bitstream = w.finish();
    const bytes = [...le32(0), 2, 0, ...bitstream]; // numDups=2 -> 3 frames
    const msg = bufFromBytes(bytes);
    const result = Q2REPRO_CODEC.readBatchMove!(msg, false, 0);

    expect(result.numDups).toBe(2);
    expect(result.frames.length).toBe(3);

    const cmd0 = result.frames[0].cmds[0];
    expect(cmd0.angles[0]).toBe(5000);
    expect(cmd0.forwardmove).toBe(400);
    expect(cmd0.buttons).toBe(1);
    expect(cmd0.msec).toBe(0);

    const cmd1 = result.frames[1].cmds[0];
    expect(cmd1.angles[0]).toBe(5000); // inherited
    expect(cmd1.forwardmove).toBe(400); // inherited (full-field inheritance, not just angles/msec)
    expect(cmd1.buttons).toBe(1); // inherited
    expect(cmd1.msec).toBe(0); // inherited

    const cmd2 = result.frames[2].cmds[0];
    expect(cmd2.angles[0]).toBe(5050); // 5000 + 50 delta, chained through cmd1
    expect(cmd2.forwardmove).toBe(400); // still inherited (never re-set)
    expect(cmd2.sidemove).toBe(-25);
    expect(cmd2.buttons).toBe(1); // still inherited
    expect(cmd2.msec).toBe(16);
  });

  test("CM_UP bit set -> ClcBatchMoveError (q2repro's decoder hard-rejects vertical movement in batch mode)", () => {
    const w = new TestBitWriter();
    w.write(1, 5); // numCmds
    w.write(1, 1); // hasContents
    w.write(CM_UP, 8);
    const bitstream = w.finish();
    const bytes = [...le32(0), 0, 0, ...bitstream];
    const msg = bufFromBytes(bytes);

    expect(() => Q2REPRO_CODEC.readBatchMove!(msg, false, 0)).toThrow(ClcBatchMoveError);
  });

  test("num_dups >= MAX_CLC_BATCH_MOVE_FRAMES-1 (3) -> ClcBatchMoveError before any bitstream is touched", () => {
    const bytes = [...le32(0), 3]; // numDups=3 -- rejected immediately, no lightlevel/bitstream needed
    const msg = bufFromBytes(bytes);

    expect(() => Q2REPRO_CODEC.readBatchMove!(msg, false, 0)).toThrow(ClcBatchMoveError);
  });

  test("truncated message (bitstream ends mid-command) -> ClcBatchMoveError, not a silent misdecode", () => {
    const bytes = [...le32(5), 0, 2]; // lastframe, numDups=0, lightlevel -- then NO bitstream bytes at all
    const msg = bufFromBytes(bytes);

    expect(() => Q2REPRO_CODEC.readBatchMove!(msg, false, 0)).toThrow(ClcBatchMoveError);
  });
});

describe("Q2REPRO_CODEC.readUserinfoDelta -- clc_q2pro_userinfo_delta (1038)", () => {
  test("decodes a name/value string pair (null-terminated, MSG_ReadString convention)", () => {
    // "fov\0" + "90\0"
    const bytes = [102, 111, 118, 0, 57, 48, 0];
    const msg = bufFromBytes(bytes);
    const result = Q2REPRO_CODEC.readUserinfoDelta!(msg);
    expect(result.name).toBe("fov");
    expect(result.value).toBe("90");
  });

  test("empty value string (key deletion form)", () => {
    // "rate\0" + "\0"
    const bytes = [114, 97, 116, 101, 0, 0];
    const msg = bufFromBytes(bytes);
    const result = Q2REPRO_CODEC.readUserinfoDelta!(msg);
    expect(result.name).toBe("rate");
    expect(result.value).toBe("");
  });
});

describe("Q2PRO_CODEC.readBatchMove -- clc_q2pro_move_batched (protocol 36)", () => {
  test("num_dups comes from opcodeExtra (the opcode byte's upper 3 bits), NOT a stream byte", () => {
    // No num_dups byte on the wire at all for this protocol -- only
    // lastframe, lightlevel, then the bitstream (q2pro_server_read_batch_move,
    // q2proto_proto_q2pro.c:2477-2515).
    const bytes = [...le32(42), 8, 0x01]; // lastframe=42, lightlevel=8, bitstream: numCmds=1,hasContents=0
    const msg = bufFromBytes(bytes);
    const result = Q2PRO_CODEC.readBatchMove!(msg, false, 0); // opcodeExtra=0 -> numDups=0

    expect(result.lastframe).toBe(42);
    expect(result.numDups).toBe(0);
    expect(result.frames.length).toBe(1);
  });

  test("CM_UP is decoded (unlike 1038) but never applied to the resolved command", () => {
    const w = new TestBitWriter();
    w.write(1, 5); // numCmds
    w.write(1, 1); // hasContents
    w.write(CM_UP | CM_FORWARD, 8);
    // Decode order matches q2pro_server_read_batch_move_delta's field order
    // (q2proto_proto_q2pro.c:2447-2461): CM_FORWARD is read BEFORE CM_UP.
    w.write(200 & 0x3ff, 10); // forwardmove = 200
    w.write(77 & 0x3ff, 10); // upmove value -- decoded, then discarded
    const bitstream = w.finish();
    const bytes = [...le32(0), 5, ...bitstream];
    const msg = bufFromBytes(bytes);
    const result = Q2PRO_CODEC.readBatchMove!(msg, false, 0);

    const cmd = result.frames[0].cmds[0];
    expect(cmd.upmove).toBe(0); // never applied -- apply_usercmd_delta has no upmove assignment on any protocol
    expect(cmd.forwardmove).toBe(200); // the field AFTER the discarded up-move value decodes correctly -- proves byte alignment survives the discard
  });

  test("CM_BUTTONS is a 3-bit remapped field, not q2repro's full byte: raw=5 (0b101) -> buttons = 1 | 128", () => {
    // q2pro.c:2465-2466: `(buttons_value & 3) | ((buttons_value & 4) << 5)`.
    // raw=5 = 0b101 -> (5&3)=1, (5&4)<<5 = 4<<5 = 128 -> buttons = 129.
    const w = new TestBitWriter();
    w.write(1, 5); // numCmds
    w.write(1, 1); // hasContents
    w.write(CM_BUTTONS, 8);
    w.write(5, 3); // raw 3-bit buttons field
    const bitstream = w.finish();
    const bytes = [...le32(0), 0, ...bitstream];
    const msg = bufFromBytes(bytes);
    const result = Q2PRO_CODEC.readBatchMove!(msg, false, 0);

    expect(result.frames[0].cmds[0].buttons).toBe(129);
  });

  test("num_dups (from opcodeExtra) >= MAX_CLC_BATCH_MOVE_FRAMES-1 -> ClcBatchMoveError before reading anything", () => {
    const bytes = [...le32(0), 0]; // never reached
    const msg = bufFromBytes(bytes);

    expect(() => Q2PRO_CODEC.readBatchMove!(msg, false, 3)).toThrow(ClcBatchMoveError);
  });

  test("clc_q2pro_move_nodelta variant on protocol 36: no lastframe on the wire", () => {
    const bytes = [3, 0x01]; // lightlevel=3, bitstream: numCmds=1,hasContents=0
    const msg = bufFromBytes(bytes);
    const result = Q2PRO_CODEC.readBatchMove!(msg, true, 0);

    expect(result.lastframe).toBe(-1);
    expect(result.frames[0].cmds.length).toBe(1);
  });
});

describe("Q2PRO_CODEC.readUserinfoDelta -- clc_q2pro_userinfo_delta (protocol 36)", () => {
  test("byte-identical shape to q2repro's (both wrap the same two-string q2proto_string_t pair)", () => {
    const bytes = [110, 97, 109, 101, 0, 66, 111, 98, 0]; // "name\0" + "Bob\0"
    const msg = bufFromBytes(bytes);
    const result = Q2PRO_CODEC.readUserinfoDelta!(msg);
    expect(result.name).toBe("name");
    expect(result.value).toBe("Bob");
  });
});
