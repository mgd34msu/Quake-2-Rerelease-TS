// Golden-byte gate for the protocol codec seam (ARCHITECTURE.md "Protocol
// layer" / .orch/phase5-design.md step 1: src/qcommon/protocol/codec.ts +
// vanilla.ts).
//
// The expected byte arrays below were captured from the PRE-REFACTOR code
// path, not computed by hand: `git stash` was used to return the working
// tree to the commit before this codec seam existed, `SV_WritePlayerstateToClient`
// was temporarily marked `export` (sv_ents.ts's only change, uncommitted,
// discarded afterward) so it could be called directly, and a scratch script
// fed the exact EntityStateT/PlayerStateT/UsercmdT fixtures below through
// MSG_WriteDeltaEntity / SV_WritePlayerstateToClient / MSG_WriteDeltaUsercmd,
// dumping the produced bytes. The tree was then restored (`git checkout --`
// on the temporary export, `git stash pop` to bring this refactor back) and
// the captured arrays were pasted in as the `entity:*`/`playerstate:*`/
// `usercmd:*` constants below. This test now runs the SAME fixtures through
// VANILLA_CODEC (the post-refactor path) and asserts byte-for-byte equality
// -- the actual regression gate for the sv_ents.ts/cl_ents.ts extractions
// documented in vanilla.ts's header comment.
//
// The two `writeEntityRemove`/`writePacketEntitiesEnd` cases are the
// exception: they were hand-computed (shown in comments below) rather than
// captured via stash, since both are a few lines of unchanged primitives
// (MSG_WriteByte/MSG_WriteShort, U_REMOVE/U_NUMBER16/U_MOREBITS1 -- none of
// which this refactor touches) and the bit arithmetic is trivial to verify
// by inspection; the risk the stash-capture step guards against (transcription
// errors in a large cut-paste) doesn't apply to a 6-line extraction.

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT, UsercmdT, MAX_STATS } from "../src/shared/q_shared";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";

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

beforeEach(() => {
  resetNetMessage();
});

// =============================================================================
// Entity delta write -- golden bytes captured pre-refactor (see header).
// Covers all three MOREBITS boundaries (bits spanning 8-15 / 16-23 / 24-31)
// plus the various 8-vs-16-vs-32-bit field encodings.
// =============================================================================

describe("VANILLA_CODEC.writeDeltaEntity -- golden bytes", () => {
  test("no change, force=false -> nothing written", () => {
    const same = new EntityStateT();
    same.number = 7;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, same, same, false, false));
    expect(bytes).toEqual([]);
  });

  test("low-byte-only bits (no MOREBITS): origin1+origin2+angle2", () => {
    const from = new EntityStateT();
    from.number = 10;
    const to = new EntityStateT();
    to.number = 10;
    to.origin.set([16, -8, 0]);
    to.angles[1] = 45;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([7, 10, 128, 0, 192, 255, 32]);
  });

  test("MOREBITS1 boundary (bits 8-15): modelindex + origin1", () => {
    const from = new EntityStateT();
    from.number = 11;
    const to = new EntityStateT();
    to.number = 11;
    to.modelindex = 5;
    to.origin[0] = 32;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([129, 8, 11, 5, 0, 1]);
  });

  test("MOREBITS1+2 boundary (bits 16-23): skinnum small change alone", () => {
    const from = new EntityStateT();
    from.number = 12;
    const to = new EntityStateT();
    to.number = 12;
    to.skinnum = 3;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 1, 12, 3]);
  });

  test("MOREBITS1+2+3 boundary (bits 24-31): forced U_OLDORIGIN via newentity=true", () => {
    const same = new EntityStateT();
    same.number = 13;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, same, same, false, true));
    expect(bytes).toEqual([128, 128, 128, 1, 13, 0, 0, 0, 0, 0, 0]);
  });

  test("entity number >= 256 (U_NUMBER16) + origin change", () => {
    const from = new EntityStateT();
    from.number = 300;
    const to = new EntityStateT();
    to.number = 300;
    to.origin[2] = 64;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 3, 44, 1, 0, 2]);
  });

  test("comprehensive: every field changed, force+newentity true", () => {
    const from = new EntityStateT();
    const to = new EntityStateT();
    to.number = 42;
    to.origin.set([104.125, -32.0, 0.25]);
    to.angles.set([90, -90, 45]);
    to.old_origin.set([8.0, -8.0, 0]);
    to.modelindex = 5;
    to.modelindex2 = 6;
    to.modelindex3 = 7;
    to.modelindex4 = 8;
    to.frame = 10;
    to.skinnum = 7;
    to.effects = 0x100;
    to.renderfx = 0x20;
    to.solid = 200;
    to.sound = 9;
    to.event = 3;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, true, true));
    expect(bytes).toEqual([191, 158, 249, 13, 42, 5, 6, 7, 8, 10, 7, 0, 1, 32, 65, 3, 0, 255, 2, 0, 64, 192, 32, 64, 0, 192, 255, 0, 0, 9, 3, 200, 0]);
  });

  test("U_EVENT is zero-compressed: from.event=5 -> to.event=0 still writes/reads 0", () => {
    const from = new EntityStateT();
    from.number = 3;
    from.event = 5;
    const to = new EntityStateT();
    to.number = 3;
    to.modelindex = 1; // force nonzero bits
    to.event = 0;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, true));
    expect(bytes).toEqual([128, 136, 128, 1, 3, 1, 0, 0, 0, 0, 0, 0]);
  });

  test("solid change alone (top byte -> all three MOREBITS)", () => {
    const from = new EntityStateT();
    from.number = 20;
    const to = new EntityStateT();
    to.number = 20;
    to.solid = 200;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 128, 8, 20, 200, 0]);
  });

  test("skinnum >= 0x10000: both U_SKIN8+U_SKIN16 -> MSG_WriteLong path", () => {
    const from = new EntityStateT();
    from.number = 21;
    const to = new EntityStateT();
    to.number = 21;
    to.skinnum = 0x12345;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 129, 2, 21, 69, 35, 1, 0]);
  });

  test("effects >= 0x8000: both bits -> MSG_WriteLong path", () => {
    const from = new EntityStateT();
    from.number = 22;
    const to = new EntityStateT();
    to.number = 22;
    to.effects = 0x9000;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 192, 8, 22, 0, 144, 0, 0]);
  });

  test("renderfx >= 0x8000: both bits -> MSG_WriteLong path", () => {
    const from = new EntityStateT();
    from.number = 23;
    const to = new EntityStateT();
    to.number = 23;
    to.renderfx = 0x8100;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 144, 4, 23, 0, 129, 0, 0]);
  });

  test("frame >= 256 (U_FRAME16)", () => {
    const from = new EntityStateT();
    from.number = 24;
    const to = new EntityStateT();
    to.number = 24;
    to.frame = 300;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 2, 24, 44, 1]);
  });

  test("modelindex2/3/4 combined (weapon/flag attachment case)", () => {
    const from = new EntityStateT();
    from.number = 25;
    const to = new EntityStateT();
    to.number = 25;
    to.modelindex2 = 11;
    to.modelindex3 = 12;
    to.modelindex4 = 13;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 112, 25, 11, 12, 13]);
  });
});

// =============================================================================
// writeEntityRemove / writePacketEntitiesEnd -- hand-verified (see header for
// why these two skip the stash-capture step).
// =============================================================================

describe("VANILLA_CODEC.writeEntityRemove / writePacketEntitiesEnd", () => {
  test("oldnum < 256: bits=U_REMOVE(64) only, byte entity number", () => {
    const bytes = bufOf((msg) => VANILLA_CODEC.writeEntityRemove(msg, 5));
    expect(bytes).toEqual([64, 5]);
  });

  test("oldnum >= 256: bits=U_REMOVE|U_NUMBER16|U_MOREBITS1(448), short entity number", () => {
    // 448 = 0x1C0 -> low byte 0xC0=192, high byte (448>>8)&255=1;
    // U_NUMBER16 set -> short(300) little-endian = [44, 1]
    const bytes = bufOf((msg) => VANILLA_CODEC.writeEntityRemove(msg, 300));
    expect(bytes).toEqual([192, 1, 44, 1]);
  });

  test("packetentities terminator is a zero short", () => {
    const bytes = bufOf((msg) => VANILLA_CODEC.writePacketEntitiesEnd(msg));
    expect(bytes).toEqual([0, 0]);
  });
});

// =============================================================================
// PlayerState delta write -- golden bytes captured pre-refactor from
// SV_WritePlayerstateToClient (see header). This is the flagged large
// verbatim extraction (sv_ents.ts -> vanilla.ts's writePlayerStateDelta).
// =============================================================================

describe("VANILLA_CODEC.writePlayerStateDelta -- golden bytes", () => {
  test("no changes at all: PS_WEAPONINDEX is always forced", () => {
    const ps = new PlayerStateT();
    const bytes = bufOf((msg) => VANILLA_CODEC.writePlayerStateDelta(msg, new PlayerStateT(), ps));
    expect(bytes).toEqual([17, 0, 16, 0, 0, 0, 0, 0]);
  });

  test("comprehensive: every delta-tracked field changed", () => {
    const to = new PlayerStateT();
    to.pmove.pm_type = 1;
    to.pmove.origin.set([100, 200, 300]);
    to.pmove.velocity.set([10, -10, 5]);
    to.pmove.pm_time = 50;
    to.pmove.pm_flags = 2;
    to.pmove.gravity = 800;
    to.pmove.delta_angles.set([1000, 2000, -3000]);
    to.viewoffset.set([1, 2, 3]);
    to.viewangles.set([10, 20, 30]);
    to.kick_angles.set([1, -1, 0.5]);
    to.blend.set([0.1, 0.2, 0.3, 0.4]);
    to.fov = 90;
    to.rdflags = 1;
    to.gunindex = 5;
    to.gunframe = 12;
    to.gunoffset.set([0.5, -0.5, 0.25]);
    to.gunangles.set([1, 2, 3]);
    to.stats[0] = 100;
    to.stats[5] = 55;
    to.stats[31] = 999;
    const bytes = bufOf((msg) => VANILLA_CODEC.writePlayerStateDelta(msg, new PlayerStateT(), to));
    expect(bytes).toEqual([
      17, 255, 127, 1, 100, 0, 200, 0, 44, 1, 10, 0, 246, 255, 5, 0, 50, 2, 32, 3, 232, 3, 208, 7, 72, 244, 4, 8, 12, 28, 7, 56, 14, 85, 21, 4, 252,
      2, 5, 12, 2, 254, 1, 4, 8, 12, 25, 51, 76, 102, 90, 1, 33, 0, 0, 128, 100, 0, 55, 0, 231, 3,
    ]);
  });

  test("stats-only change, exercising the bit-31 boundary of the stat bitmask", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.stats[0] = 5;
    to.stats[31] = 7;
    const bytes = bufOf((msg) => VANILLA_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 16, 0, 1, 0, 0, 128, 5, 0, 7, 0]);
  });

  test("viewangles + kickangles + blend changed", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.viewangles.set([45, -45, 0]);
    to.kick_angles.set([2, -2, 1]);
    to.blend.set([1, 0, 0, 0.5]);
    const bytes = bufOf((msg) => VANILLA_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 23, 0, 32, 0, 224, 0, 0, 8, 248, 4, 0, 255, 0, 0, 127, 0, 0, 0, 0]);
  });

  test("weaponframe with gun offsets/angles", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunframe = 3;
    to.gunoffset.set([1, 1, 1]);
    to.gunangles.set([2, 2, 2]);
    const bytes = bufOf((msg) => VANILLA_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 48, 0, 3, 4, 4, 4, 8, 8, 8, 0, 0, 0, 0]);
  });
});

// =============================================================================
// Usercmd delta write -- golden bytes captured pre-refactor from
// MSG_WriteDeltaUsercmd (wrapped, not moved -- see vanilla.ts).
// =============================================================================

describe("VANILLA_CODEC.writeDeltaUsercmd -- golden bytes", () => {
  test("no change: only bits=0, msec, lightlevel written", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes).toEqual([0, 0, 0]);
  });

  test("angles + forwardmove changed", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.angles.set([100, -200, 300]);
    cmd.forwardmove = 400;
    cmd.msec = 16;
    cmd.lightlevel = 32;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes).toEqual([15, 100, 0, 56, 255, 44, 1, 144, 1, 16, 32]);
  });

  test("side/up/buttons/impulse changed", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.sidemove = -50;
    cmd.upmove = 10;
    cmd.buttons = 3;
    cmd.impulse = 5;
    cmd.msec = 10;
    cmd.lightlevel = 200;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes).toEqual([240, 206, 255, 10, 0, 3, 5, 10, 200]);
  });

  test("msec/lightlevel always written even with no other diff", () => {
    const from = new UsercmdT();
    from.forwardmove = 400;
    from.buttons = 1;
    const cmd = new UsercmdT();
    cmd.forwardmove = 400; // unchanged from `from`
    cmd.buttons = 1; // unchanged
    cmd.msec = 33;
    cmd.lightlevel = 64;
    const bytes = bufOf((msg) => VANILLA_CODEC.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes).toEqual([0, 33, 64]);
  });
});

// =============================================================================
// Read-side round trips: bytes -> parse -> struct equality (not golden-byte
// locked -- per the task brief, only the write side needs hardcoded expected
// arrays; the read side is verified by round-tripping through the same
// codec's write ops).
// =============================================================================

describe("VANILLA_CODEC read-side round trips", () => {
  test("entity delta: readEntityBits + readDeltaEntity reconstructs the written state", () => {
    const from = new EntityStateT();
    from.number = 42;
    const to = new EntityStateT();
    to.number = 42;
    to.origin.set([104.125, -32.0, 0.25]); // multiples of 1/8: exact under MSG_WriteCoord/ReadCoord
    to.angles.set([90, -90, 45]); // exact under MSG_WriteAngle/ReadAngle's byte quantization
    to.old_origin.set([8.0, -8.0, 0]);
    to.modelindex = 5;
    to.modelindex2 = 6;
    to.modelindex3 = 7;
    to.modelindex4 = 8;
    to.frame = 10;
    to.skinnum = 7;
    to.effects = 0x100;
    to.renderfx = 0x20;
    to.solid = 200;
    to.sound = 9;
    to.event = 3;

    VANILLA_CODEC.writeDeltaEntity(net_message, from, to, true, true);
    MSG_BeginReading(net_message);

    const { number, bits } = VANILLA_CODEC.readEntityBits();
    expect(number).toBe(42);

    const out = new EntityStateT();
    VANILLA_CODEC.readDeltaEntity(from, out, number, bits);

    expect(out.number).toBe(42);
    expect(Array.from(out.origin)).toEqual([104.125, -32.0, 0.25]);
    expect(Array.from(out.angles)).toEqual([90, -90, 45]);
    expect(Array.from(out.old_origin)).toEqual([8.0, -8.0, 0]);
    expect(out.modelindex).toBe(5);
    expect(out.modelindex2).toBe(6);
    expect(out.modelindex3).toBe(7);
    expect(out.modelindex4).toBe(8);
    expect(out.frame).toBe(10);
    expect(out.skinnum).toBe(7);
    expect(out.effects).toBe(0x100);
    expect(out.renderfx).toBe(0x20);
    expect(out.solid).toBe(200);
    expect(out.sound).toBe(9);
    expect(out.event).toBe(3);
  });

  test("entity delta: U_EVENT zero-compression survives the round trip", () => {
    const from = new EntityStateT();
    from.event = 5;
    const to = new EntityStateT();
    to.number = 3;
    to.modelindex = 1;
    to.event = 0;

    VANILLA_CODEC.writeDeltaEntity(net_message, from, to, false, true);
    MSG_BeginReading(net_message);

    const { number, bits } = VANILLA_CODEC.readEntityBits();
    const out = new EntityStateT();
    out.event = 99; // sentinel; must be overwritten to 0
    VANILLA_CODEC.readDeltaEntity(from, out, number, bits);
    expect(out.event).toBe(0);
  });

  test("usercmd delta: readDeltaUsercmd reconstructs the written command", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.angles.set([100, -200, 300]);
    cmd.forwardmove = 400;
    cmd.sidemove = -50;
    cmd.upmove = 10;
    cmd.buttons = 3;
    cmd.impulse = 5;
    cmd.msec = 16;
    cmd.lightlevel = 32;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    VANILLA_CODEC.writeDeltaUsercmd(msg, from, cmd);
    MSG_BeginReading(msg);

    const out = new UsercmdT();
    VANILLA_CODEC.readDeltaUsercmd(msg, from, out);
    expect(Array.from(out.angles)).toEqual([100, -200, 300]);
    expect(out.forwardmove).toBe(400);
    expect(out.sidemove).toBe(-50);
    expect(out.upmove).toBe(10);
    expect(out.buttons).toBe(3);
    expect(out.impulse).toBe(5);
    expect(out.msec).toBe(16);
    expect(out.lightlevel).toBe(32);
  });

  test("playerstate delta: readPlayerStateDelta reconstructs bit-exact fields (blend excluded: documented lossy)", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.pm_type = 1;
    to.pmove.origin.set([100, 200, 300]);
    to.pmove.velocity.set([10, -10, 5]);
    to.pmove.pm_time = 50;
    to.pmove.pm_flags = 2;
    to.pmove.gravity = 800;
    to.pmove.delta_angles.set([1000, 2000, -3000]);
    to.viewoffset.set([1, 2, 3]); // multiples of 0.25: exact under *4 char quantization
    to.viewangles.set([90, -90, 45]); // exact under MSG_WriteAngle16/ReadAngle16
    to.kick_angles.set([1, -1, 0.5]);
    to.fov = 90;
    to.rdflags = 1;
    to.gunindex = 5;
    to.gunframe = 12;
    to.gunoffset.set([0.5, -0.5, 0.25]);
    to.gunangles.set([1, 2, 3]);
    to.stats[0] = 100;
    to.stats[31] = 999;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(256), 256);
    VANILLA_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);

    // writePlayerStateDelta writes the svc_playerinfo tag byte itself
    // (matching SV_WritePlayerstateToClient); readPlayerStateDelta does not
    // consume it (matching CL_ParsePlayerstate) -- in the real client that
    // byte is read by CL_ParseFrame's dispatch switch before it calls
    // CL_ParsePlayerstate. Mirror that here.
    MSG_ReadByte(msg);

    const out = new PlayerStateT();
    VANILLA_CODEC.readPlayerStateDelta(msg, from, out);

    expect(out.pmove.pm_type).toBe(1);
    expect(Array.from(out.pmove.origin)).toEqual([100, 200, 300]);
    expect(Array.from(out.pmove.velocity)).toEqual([10, -10, 5]);
    expect(out.pmove.pm_time).toBe(50);
    expect(out.pmove.pm_flags).toBe(2);
    expect(out.pmove.gravity).toBe(800);
    expect(Array.from(out.pmove.delta_angles)).toEqual([1000, 2000, -3000]);
    expect(Array.from(out.viewoffset)).toEqual([1, 2, 3]);
    expect(Array.from(out.viewangles)).toEqual([90, -90, 45]);
    expect(Array.from(out.kick_angles)).toEqual([1, -1, 0.5]);
    expect(out.fov).toBe(90);
    expect(out.rdflags).toBe(1);
    expect(out.gunindex).toBe(5);
    expect(out.gunframe).toBe(12);
    expect(Array.from(out.gunoffset)).toEqual([0.5, -0.5, 0.25]);
    expect(Array.from(out.gunangles)).toEqual([1, 2, 3]);
    expect(out.stats[0]).toBe(100);
    expect(out.stats[31]).toBe(999);
  });

  test("playerstate delta: from-frame values survive when the corresponding pflag bit is unset", () => {
    const from = new PlayerStateT();
    from.fov = 77;
    from.pmove.pm_type = 4;
    const to = new PlayerStateT();
    to.fov = 77; // unchanged -> PS_FOV not set -> read side must keep the seeded value
    to.pmove.pm_type = 4; // unchanged -> PS_M_TYPE not set

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    VANILLA_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    MSG_ReadByte(msg); // skip the svc_playerinfo tag -- see comment above

    const out = new PlayerStateT();
    out.fov = 0; // sentinel different from both from/to -- readPlayerStateDelta must seed from `from`, not leave this alone
    VANILLA_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.fov).toBe(77);
    expect(out.pmove.pm_type).toBe(4);
  });
});

// Sanity check that MAX_STATS still matches what the golden byte layout
// above assumes (a 32-bit stat bitmask, one MSG_WriteLong).
test("MAX_STATS is 32 (assumed by the stat-bitmask golden byte layout above)", () => {
  expect(MAX_STATS).toBe(32);
});
