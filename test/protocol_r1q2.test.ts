// R1Q2 protocol codec (protocol 35) golden-byte + round-trip suite.
// v1.0.0 wire cluster (task board #23). Hand-derived from
// ~/Projects/q2proto/src/q2proto_proto_r1q2.c, citing exact line ranges per
// vector, matching this codebase's established convention
// (test/protocol_golden.test.ts / test/protocol_q2repro.test.ts /
// test/protocol_frame_envelope.test.ts's own stated derivation style).
//
// Self-sufficient per .orch/preferences.md rule 13: every test initializes
// its own net_message state via beforeEach; run standalone with
// `bun test test/protocol_r1q2.test.ts`.

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, SZ_Write, MSG_ReadByte, MSG_ReadShort, MSG_ReadLong } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT, UsercmdT } from "../src/shared/q_shared";
import { SvcOpsT, U_SOLID } from "../src/qcommon/qcommon";
import { R1Q2_CODEC, createR1Q2Codec, setR1Q2FrameExtrabits } from "../src/qcommon/protocol/r1q2";
import type { FrameWriteParamsT } from "../src/qcommon/protocol/codec";

function bufOf(fn: (msg: SizeBuf) => void): number[] {
  const msg = new SizeBuf();
  SZ_Init(msg, new Uint8Array(4096), 4096);
  fn(msg);
  return Array.from(msg.data.subarray(0, msg.cursize));
}

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

function loadIntoNetMessage(bytes: number[] | Uint8Array): void {
  SZ_Clear(net_message);
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  SZ_Write(net_message, arr, arr.length);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  resetNetMessage();
  setR1Q2FrameExtrabits(0);
});

// =============================================================================
// 1. U_SOLID width -- gated on minor version >= PROTOCOL_VERSION_R1Q2_LONG_SOLID
//    (1905). q2proto_proto_r1q2.c:386-391.
// =============================================================================

describe("R1Q2 entity delta -- U_SOLID width", () => {
  test("minor version 1903: U_SOLID stays a u16 short (byte-identical to vanilla)", () => {
    const codec = createR1Q2Codec(1903);
    const from = new EntityStateT();
    from.number = 3;
    const to = new EntityStateT();
    to.number = 3;
    to.solid = 0x1234;

    const bytes = bufOf((msg) => codec.writeDeltaEntity(msg, from, to, false, false));
    // bits = U_SOLID (1<<27) only. U_SOLID alone is in the 0xff000000 byte
    // range, so MSG_WriteDeltaEntity's morebits folding sets ALL THREE
    // morebits flags (U_MOREBITS1=1<<7, U_MOREBITS2=1<<15, U_MOREBITS3=1<<23)
    // to signal a 4-byte bits prefix:
    //   bits = 0x08000000 | 0x80 | 0x8000 | 0x800000 = 0x08808080
    //   byte0 = bits&255            = 0x80
    //   byte1 = (bits>>8)&255       = 0x80
    //   byte2 = (bits>>16)&255      = 0x80
    //   byte3 = (bits>>24)&255      = 0x08 (U_SOLID's own bit, top nibble)
    expect(bytes.slice(0, 4)).toEqual([0x80, 0x80, 0x80, 0x08]);
    // number (< 256, U_NUMBER16 unset) -> single byte
    expect(bytes[4]).toBe(3);
    // solid: u16 LE
    expect(bytes.slice(5)).toEqual([0x34, 0x12]);
    expect(bytes.length).toBe(7);
  });

  test("minor version 1905: U_SOLID widens to a u32 packed value", () => {
    const codec = createR1Q2Codec(1905);
    const from = new EntityStateT();
    from.number = 3;
    const to = new EntityStateT();
    to.number = 3;
    to.solid = 0x11223344;

    const bytes = bufOf((msg) => codec.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes.slice(0, 4)).toEqual([0x80, 0x80, 0x80, 0x08]);
    expect(bytes[4]).toBe(3);
    // solid: u32 LE (MSG_WriteLong)
    expect(bytes.slice(5)).toEqual([0x44, 0x33, 0x22, 0x11]);
    expect(bytes.length).toBe(9);
  });

  test("round trip at 1905 preserves the full 32-bit solid value that 1903 would truncate", () => {
    const codec = createR1Q2Codec(1905);
    const from = new EntityStateT();
    from.number = 5;
    const to = new EntityStateT();
    to.number = 5;
    to.solid = 0xabcdef01;

    loadIntoNetMessage(bufOf((msg) => codec.writeDeltaEntity(msg, from, to, false, false)));
    const { number, bits } = codec.readEntityBits();
    expect(number).toBe(5);
    expect((bits & U_SOLID) !== 0).toBe(true);
    const out = new EntityStateT();
    codec.readDeltaEntity(from, out, number, bits);
    expect(out.solid >>> 0).toBe(0xabcdef01);
  });
});

// =============================================================================
// 2. writeFrame -- opcode extrabits + suppress_count nibble packing
//    (q2proto_proto_r1q2.c:1323-1364).
// =============================================================================

function frameParams(overrides: Partial<FrameWriteParamsT> = {}): FrameWriteParamsT {
  return {
    framenum: 1,
    lastframe: -1,
    surpressCount: 0,
    areabits: new Uint8Array(0),
    areabytes: 0,
    psFrom: new PlayerStateT(),
    psTo: new PlayerStateT(),
    ...overrides,
  };
}

describe("R1Q2_CODEC.writeFrame -- extraflags smuggled into opcode + suppress_count bytes", () => {
  test("no playerstate change: opcode is plain svc_frame, suppress_count untouched", () => {
    const bytes = bufOf((msg) => R1Q2_CODEC.writeFrame(msg, frameParams({ surpressCount: 3 }), () => {}));
    expect(bytes[0]).toBe(SvcOpsT.svc_frame);
    // encodedFrame (framenum=1, lastframe=-1 -> offset=31 sentinel):
    // (1 & 0x07FFFFFF) | (31<<27) = 1 | 0xF8000000 -> LE bytes [1,0,0,0xF8]
    expect(bytes.slice(1, 5)).toEqual([1, 0, 0, 0xf8]);
    expect(bytes[5]).toBe(3); // suppress_count low nibble only, no extraflags bits
  });

  test("EPS_VIEWANGLE2 (bit4=0x10) lands in the opcode byte's bits 5-6 via (extraflags&0xF0)<<1", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.viewangles.set([0, 0, 90]); // Z-only change -> EPS_VIEWANGLE2, not PS_VIEWANGLES
    const bytes = bufOf((msg) => R1Q2_CODEC.writeFrame(msg, frameParams({ psFrom: from, psTo: to }), () => {}));
    // extraflags = EPS_VIEWANGLE2 = 0x10; (0x10 & 0xF0) << 1 = 0x20
    expect(bytes[0]).toBe(SvcOpsT.svc_frame | 0x20);
    expect(bytes[5]).toBe(0); // suppress_count: no low-nibble extraflags bits
  });

  test("EPS_STATS (bit5=0x20) also lands in the opcode byte, combined with EPS_VIEWANGLE2", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.viewangles.set([0, 0, 90]); // EPS_VIEWANGLE2
    to.stats[2] = 7; // any stat change -> EPS_STATS
    const bytes = bufOf((msg) => R1Q2_CODEC.writeFrame(msg, frameParams({ psFrom: from, psTo: to }), () => {}));
    // extraflags = EPS_VIEWANGLE2(0x10) | EPS_STATS(0x20) = 0x30; (0x30&0xF0)<<1 = 0x60
    expect(bytes[0]).toBe(SvcOpsT.svc_frame | 0x60);
  });

  test("EPS_M_ORIGIN2/EPS_M_VELOCITY2/EPS_GUNOFFSET/EPS_GUNANGLES (bits 0-3) land in suppress_count's high nibble", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.origin.set([0, 0, 40]); // Z-only -> EPS_M_ORIGIN2 (bit3=0x08)
    to.gunoffset.set([0.5, 0, 0]); // -> EPS_GUNOFFSET (bit0=0x01)
    const bytes = bufOf((msg) => R1Q2_CODEC.writeFrame(msg, frameParams({ psFrom: from, psTo: to, surpressCount: 2 }), () => {}));
    // extraflags = EPS_GUNOFFSET(0x01) | EPS_M_ORIGIN2(0x08) = 0x09;
    // opcode byte: (0x09 & 0xF0) << 1 = 0 -> plain svc_frame
    expect(bytes[0]).toBe(SvcOpsT.svc_frame);
    // suppress_count byte: surpressCount(2) | ((0x09 & 0x0F) << 4) = 2 | 0x90 = 0x92
    expect(bytes[5]).toBe((2 | (0x09 << 4)) & 0xff);
  });

  test("round trip: readFrameHeader reconstructs extraflags from opcode extrabits (dispatch-caller sim) + suppress_count nibble", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.velocity.set([0, 0, -10]); // EPS_M_VELOCITY2 (bit2=0x04)
    to.stats[0] = 1; // EPS_STATS (bit5=0x20)

    const bytes = bufOf((msg) => R1Q2_CODEC.writeFrame(msg, frameParams({ psFrom: from, psTo: to, framenum: 50, lastframe: 40 }), () => {}));
    loadIntoNetMessage(bytes);
    const opcode = MSG_ReadByte(net_message); // simulates cl_parse.ts's dispatch already having consumed it
    setR1Q2FrameExtrabits(opcode & 0xe0);

    const header = R1Q2_CODEC.readFrameHeader(new Uint8Array(0), false);
    expect(header.serverframe).toBe(50);
    expect(header.deltaframe).toBe(40); // offset=10 reconstructed

    const psOut = new PlayerStateT();
    R1Q2_CODEC.readFramePlayerstate(from, psOut);
    expect(psOut.pmove.velocity[2]).toBe(-10);
    expect(psOut.stats[0]).toBe(1);
  });
});

// =============================================================================
// 3. clc_move byte-shortening -- gated on minor version >=
//    PROTOCOL_VERSION_R1Q2_UCMD (1904). q2proto_proto_r1q2.c:650-742.
// =============================================================================

describe("R1Q2 clc_move -- DBLFORWARD/DBL_ANGLE1 byte-shortening", () => {
  test("version 1904+: forwardmove divisible by 5 is written as a signed byte with BUTTON_UCMD_DBLFORWARD set", () => {
    const codec = createR1Q2Codec(1904);
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.forwardmove = 50; // 50/5 = 10, fits in i8
    cmd.buttons = 1; // any nonzero buttons value forces CM_BUTTONS + triggers the compression check

    const bytes = bufOf((msg) => codec.writeDeltaUsercmd(msg, from, cmd));
    // bits byte: CM_FORWARD(1<<3=8) | CM_BUTTONS(1<<6=64) = 72
    expect(bytes[0]).toBe(72);
    // buttons byte: original buttons(1) | BUTTON_UCMD_DBLFORWARD(1<<2=4) = 5
    expect(bytes[1]).toBe(5);
    // forwardmove as signed byte: 50/5 = 10
    expect(bytes[2]).toBe(10);
  });

  test("version 1904+: forwardmove NOT divisible by 5 is written as a full i16, no DBLFORWARD", () => {
    const codec = createR1Q2Codec(1904);
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.forwardmove = 51;
    cmd.buttons = 1;

    const bytes = bufOf((msg) => codec.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes[1]).toBe(1); // buttons unchanged -- no DBLFORWARD bit
    expect(bytes.slice(2, 4)).toEqual([51, 0]); // i16 LE
  });

  test("version 1903 (below UCMD threshold): forwardmove is never compressed even if divisible by 5", () => {
    const codec = createR1Q2Codec(1903);
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.forwardmove = 50;
    cmd.buttons = 1;

    const bytes = bufOf((msg) => codec.writeDeltaUsercmd(msg, from, cmd));
    // no compressed-movements buttons byte written before the fields at all;
    // buttons byte is written AFTER the fields instead (vanilla order).
    expect(bytes.slice(1, 3)).toEqual([50, 0]); // full i16
    expect(bytes[3]).toBe(1); // buttons, vanilla position
  });

  test("angle1 divisible by 64 (abs quotient < 128) triggers BUTTON_UCMD_DBL_ANGLE1", () => {
    const codec = createR1Q2Codec(1905);
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.angles[0] = 6400; // 6400/64 = 100, |100| < 128
    cmd.buttons = 1;

    const bytes = bufOf((msg) => codec.writeDeltaUsercmd(msg, from, cmd));
    // bits byte: CM_ANGLE1(1<<0=1) | CM_BUTTONS(1<<6=64) = 65
    expect(bytes[0]).toBe(65);
    // buttons byte: 1 | BUTTON_UCMD_DBL_ANGLE1(1<<5=32) = 33
    expect(bytes[1]).toBe(33);
    expect(bytes[2]).toBe(100); // signed byte
  });

  test("round trip: forward + angle1 compression survive readDeltaUsercmd", () => {
    const codec = createR1Q2Codec(1905);
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.forwardmove = -25; // -25/5 = -5
    cmd.angles[0] = -12800; // -12800/64 = -200 -- |200| >= 128, so NOT compressed (exercises the range guard)
    cmd.buttons = 1;

    loadIntoNetMessage(bufOf((msg) => codec.writeDeltaUsercmd(msg, from, cmd)));
    const out = new UsercmdT();
    codec.readDeltaUsercmd(net_message, from, out);
    expect(out.forwardmove).toBe(-25);
    expect(out.angles[0]).toBe(-12800);
    expect(out.buttons).toBe(1);
  });
});

// =============================================================================
// 4. serverdata handshake -- q2proto_r1q2_continue_serverdata (:72-97) /
//    r1q2_server_write_serverdata (:937-951).
// =============================================================================

describe("R1Q2_CODEC serverdata handshake", () => {
  test("write then read round-trips r1q2Version and r1q2StrafejumpHack through the exact field order", () => {
    const bytes = bufOf((msg) =>
      R1Q2_CODEC.writeServerData(msg, {
        servercount: 7,
        attractloop: false,
        gamedir: "baseq2",
        clientnum: 2,
        levelname: "base1",
        serverState: 0,
        r1q2Version: 1905,
        r1q2StrafejumpHack: true,
      }),
    );
    // opcode, protocol(i32=35 LE), servercount(i32=7 LE) -- skip to the tail:
    // after levelname's NUL, tail is: enhanced(u8=1), version(u16 LE=1905),
    // placeholder(u8=0), strafejump_hack(u8=1).
    const tail = bytes.slice(bytes.length - 5);
    expect(tail[0]).toBe(1); // enhanced
    expect(tail.slice(1, 3)).toEqual([1905 & 0xff, (1905 >> 8) & 0xff]);
    expect(tail[3]).toBe(0); // placeholder ("advanced deltas")
    expect(tail[4]).toBe(1); // strafejump_hack

    loadIntoNetMessage(bytes.slice(1)); // strip svc_serverdata opcode
    const proto = MSG_ReadLong(net_message);
    expect(proto).toBe(35);
    const sd = R1Q2_CODEC.readServerData();
    expect(sd.servercount).toBe(7);
    expect(sd.gamedir).toBe("baseq2");
    expect(sd.levelname).toBe("base1");
    expect(sd.r1q2Version).toBe(1905);
    expect(sd.r1q2StrafejumpHack).toBe(true);
  });
});

// =============================================================================
// 5. EPS_GUNOFFSET/EPS_GUNANGLES decoupled from PS_WEAPONFRAME
//    (q2proto_proto_r1q2.c:486-496).
// =============================================================================

describe("R1Q2 playerstate delta -- gun offset/angles independent of weaponframe", () => {
  test("gunoffset changes without a gunframe change: EPS_GUNOFFSET set, PS_WEAPONFRAME clear, no gunframe byte", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunoffset.set([1, -1, 0.5]);

    const bytes = bufOf((msg) => R1Q2_CODEC.writePlayerStateDelta(msg, from, to));
    // flags(u16): PS_WEAPONINDEX (always-set quirk, see vanilla.ts) only --
    // PS_WEAPONFRAME (1<<13=0x2000) must be clear.
    const flags = bytes[0] | (bytes[1] << 8);
    expect(flags & 0x2000).toBe(0);
    // bytes[2] is writePlayerStateDelta's own explicit extraflags byte (see
    // its doc comment -- not part of the real wire-embedded frame layout,
    // just this standalone op's self-consistent shape): EPS_GUNOFFSET(0x01).
    expect(bytes[2]).toBe(0x01);
    // Body: PS_WEAPONINDEX's gunindex byte, then EPS_GUNOFFSET's 3 chars --
    // no gunframe byte in between (that's what "decoupled" means on the wire).
    expect(bytes.length).toBe(2 + 1 + 1 + 3);

    loadIntoNetMessage(bytes);
    const out = new PlayerStateT();
    R1Q2_CODEC.readPlayerStateDelta(net_message, from, out);
    expect(Array.from(out.gunoffset)).toEqual(Array.from(to.gunoffset).map((v) => Math.round(v * 4) * 0.25));
    expect(out.gunframe).toBe(from.gunframe); // untouched -- PS_WEAPONFRAME was never set
  });
});
