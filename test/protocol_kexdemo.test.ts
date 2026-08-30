// Hand-derived byte-vector gate for the KEX demo/native codec
// (src/qcommon/protocol/kexdemo.ts), KEX demo playback unit
// (.orch/RESUME.md).
//
// Unlike protocol_golden.test.ts's vanilla fixtures (captured via
// git-stash) or protocol_q2repro.test.ts's own hand-derived vectors (which
// at least have a real writer, Q2REPRO_CODEC, to sanity-check against),
// KEX_DEMO_CODEC's write side is deliberately unimplemented (read-only
// demo codec, see kexdemo.ts's own file header) -- every input byte
// sequence below is constructed BY HAND with the low-level MSG_Write*
// primitives, derived directly from reading q2proto's C source
// (~/Projects/q2proto/src/q2proto_proto_kex.c and the shared machinery it
// calls into), matching protocol_q2repro.test.ts's own stated methodology.
// Each case's derivation is shown in a comment citing the exact source
// lines, matching that file's own convention.

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, MSG_ReadByte, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteFloat, MSG_WriteString, MSG_WriteDir } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { vec3 } from "../src/shared/math";
import { EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { SvcOpsT } from "../src/qcommon/qcommon";
import { combineBits } from "../src/qcommon/protocol/q2repro";
import {
  KEX_DEMO_CODEC,
  PROTOCOL_KEX_DEMOS,
  PROTOCOL_KEX,
  setKexProtocol,
  readDamageKex,
  readPoiKex,
  readHelpPathKex,
  readMuzzleflash3Kex,
  readAchievementKex,
  readLocprintKex,
  readSplitclientKex,
  readSoundKex,
  readConfigblastKex,
  readSpawnbaselineblastKex,
} from "../src/qcommon/protocol/kexdemo";

function deflateWrapped(bytes: Uint8Array): Uint8Array {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  return new Uint8Array(zlib.deflateSync(bytes));
}

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  resetNetMessage();
  setKexProtocol(PROTOCOL_KEX); // full precision by default; individual tests override
});

// ---------------------------------------------------------------------------
// svc_serverdata (kex.c:335-347)
// ---------------------------------------------------------------------------

describe("KEX_DEMO_CODEC.readServerData", () => {
  test("basic fields, server_fps discarded", () => {
    // Field order (kex.c:51-59), protocol i32 already consumed by the
    // caller: servercount(i32)=7, attractloop(u8)=1, server_fps(u8)=40
    // (discarded), gamedir(string)="baseq2", clientnum(i16)=3,
    // levelname(string)="q2dm1".
    MSG_WriteLong(net_message, 7);
    MSG_WriteByte(net_message, 1);
    MSG_WriteByte(net_message, 40);
    MSG_WriteString(net_message, "baseq2");
    MSG_WriteShort(net_message, 3);
    MSG_WriteString(net_message, "q2dm1");
    MSG_BeginReading(net_message);

    const sd = KEX_DEMO_CODEC.readServerData();
    expect(sd.servercount).toBe(7);
    expect(sd.attractloop).toBe(true);
    expect(sd.gamedir).toBe("baseq2");
    expect(sd.clientnum).toBe(3);
    expect(sd.levelname).toBe("q2dm1");
    expect(sd.serverState).toBe(0); // KEX has no q2pro-style server_state field
  });

  test("clientnum -2 (split-screen sentinel) throws (kex.c:56-58)", () => {
    MSG_WriteLong(net_message, 1);
    MSG_WriteByte(net_message, 0);
    MSG_WriteByte(net_message, 10);
    MSG_WriteString(net_message, "baseq2");
    MSG_WriteShort(net_message, -2);
    MSG_WriteString(net_message, "q2dm1");
    MSG_BeginReading(net_message);

    expect(() => KEX_DEMO_CODEC.readServerData()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Entity delta (kex.c:349-549) -- field order/encoding verified directly
// against the C source.
// ---------------------------------------------------------------------------

describe("KEX_DEMO_CODEC.readDeltaEntity", () => {
  test("model(8-bit) + frame8 + skin16", () => {
    // bits = U_MODEL(BIT(11)=0x800) | U_FRAME8(BIT(4)=0x10) | U_SKIN16(BIT(25))
    // model16 false (U_MODEL16 not set) -> modelindex is a byte.
    // U_SKIN16 alone (not the U_SKIN8|U_SKIN16 "laser color" combo) -> u16 read.
    const bits = 0x800 | 0x10 | (1 << 25);
    MSG_WriteByte(net_message, 5); // modelindex
    MSG_WriteByte(net_message, 7); // frame
    MSG_WriteShort(net_message, 1000); // skinnum
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 42, bits);
    expect(to.number).toBe(42);
    expect(to.modelindex).toBe(5);
    expect(to.frame).toBe(7);
    expect(to.skinnum).toBe(1000);
  });

  test("64-bit effects: low word (U_KEX_EFFECTS64) read before the high word (U_EFFECTS16)", () => {
    // kex.c:391-411: low_effects(u32) read FIRST when U_KEX_EFFECTS64 is set,
    // THEN the plain 8/16/32-progressive effects field (here U_EFFECTS16
    // alone -> u16) becomes the HIGH word: effects = (high<<32)|low.
    // U_KEX_EFFECTS64 = BIT(29) (q2proto_internal_protocol.h:153); U_EFFECTS16 = BIT(19).
    const U_KEX_EFFECTS64 = 1 << 29;
    const U_EFFECTS16 = 1 << 19;
    const bits = U_KEX_EFFECTS64 | U_EFFECTS16;
    MSG_WriteLong(net_message, 0x12345678); // low_effects
    MSG_WriteShort(net_message, 0x1234); // high word (via the 16-bit effects field)
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 1, bits);
    expect(to.effects >>> 0).toBe(0x12345678);
    expect(to.morefx >>> 0).toBe(0x1234);
  });

  test("solid + high-precision (float) origin -- default protocol (2023)", () => {
    // U_SOLID(BIT(27)) moves BEFORE origin (kex.c:434-439, unlike q2repro).
    // Default kexServerProtocol (set in beforeEach) is PROTOCOL_KEX (2023)
    // -> always high precision regardless of solid's value.
    const U_SOLID = 1 << 27;
    const U_ORIGIN1 = 1 << 0;
    const U_ORIGIN2 = 1 << 1;
    const U_ORIGIN3 = 1 << 9;
    const bits = U_SOLID | U_ORIGIN1 | U_ORIGIN2 | U_ORIGIN3;
    MSG_WriteLong(net_message, 42); // solid (nonzero)
    MSG_WriteFloat(net_message, 100.5);
    MSG_WriteFloat(net_message, -50.25);
    MSG_WriteFloat(net_message, 12.0);
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 2, bits);
    expect(to.solid).toBe(42);
    expect(to.origin[0]).toBeCloseTo(100.5, 4);
    expect(to.origin[1]).toBeCloseTo(-50.25, 4);
    expect(to.origin[2]).toBeCloseTo(12.0, 4);
  });

  test("solid=0 + low-precision (12.3 fixed short) origin -- demo protocol (2022)", () => {
    // PROTOCOL_KEX_DEMOS (2022) drops to a short*0.125 encoding whenever the
    // entity's solid is 0 (kex.c:441, _q2proto_valenc_int2coord: x*0.125,
    // q2proto_valenc.h:64 -- the same 1/8-unit scale classic Quake II has
    // always used for MSG_ReadShort-encoded coordinates).
    setKexProtocol(PROTOCOL_KEX_DEMOS);
    const U_SOLID = 1 << 27;
    const U_ORIGIN1 = 1 << 0;
    const U_ORIGIN2 = 1 << 1;
    const U_ORIGIN3 = 1 << 9;
    const bits = U_SOLID | U_ORIGIN1 | U_ORIGIN2 | U_ORIGIN3;
    MSG_WriteLong(net_message, 0); // solid (zero -> low precision)
    MSG_WriteShort(net_message, 800); // 800 * 0.125 = 100
    MSG_WriteShort(net_message, -400); // -400 * 0.125 = -50
    MSG_WriteShort(net_message, 96); // 96 * 0.125 = 12
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 3, bits);
    expect(to.solid).toBe(0);
    expect(to.origin[0]).toBeCloseTo(100, 4);
    expect(to.origin[1]).toBeCloseTo(-50, 4);
    expect(to.origin[2]).toBeCloseTo(12, 4);
  });

  test("solid tracking persists across calls for the same entity number when U_SOLID is unsent", () => {
    setKexProtocol(PROTOCOL_KEX_DEMOS);
    const U_SOLID = 1 << 27;
    const U_ORIGIN1 = 1 << 0;

    // First call: sends solid=5 (nonzero) for entity 10 -> tracked as true.
    MSG_WriteLong(net_message, 5);
    MSG_WriteFloat(net_message, 1.0);
    MSG_BeginReading(net_message);
    const to1 = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to1, 10, U_SOLID | U_ORIGIN1);
    expect(to1.origin[0]).toBeCloseTo(1.0, 4);

    // Second call: same entity 10, U_SOLID NOT sent -> falls back to the
    // tracked nonzero value from the first call -> still high precision
    // (float, 4 bytes), not the low-precision short (2 bytes).
    resetNetMessage();
    MSG_WriteFloat(net_message, 2.0);
    MSG_BeginReading(net_message);
    const to2 = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(to1, to2, 10, U_ORIGIN1);
    expect(to2.origin[0]).toBeCloseTo(2.0, 4);
  });

  test("angles are always plain float degrees (no U_ANGLE16 branch)", () => {
    const U_ANGLE1 = 1 << 10;
    const U_ANGLE2 = 1 << 2;
    const U_ANGLE3 = 1 << 3;
    const bits = U_ANGLE1 | U_ANGLE2 | U_ANGLE3;
    MSG_WriteFloat(net_message, 45.0);
    MSG_WriteFloat(net_message, -90.0);
    MSG_WriteFloat(net_message, 180.0);
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 4, bits);
    expect(to.angles[0]).toBeCloseTo(45.0, 4);
    expect(to.angles[1]).toBeCloseTo(-90.0, 4);
    expect(to.angles[2]).toBeCloseTo(180.0, 4);
  });

  test("owner/oldframe/instance_bits: KEX-only hi-word bits 33/34/35", () => {
    // HI_KEX_INSTANCE(bit33, same slot as HI_MOREFX16=2) | HI_KEX_OWNER(bit34=4)
    // | HI_KEX_OLDFRAME(bit35=8). Read order (kex.c:531-545): instance, owner,
    // oldframe -- the LAST three fields in the whole entity delta.
    const bits = combineBits(0, 2 | 4 | 8);
    MSG_WriteByte(net_message, 0x07); // instance_bits
    MSG_WriteShort(net_message, 99); // owner
    MSG_WriteShort(net_message, 55); // old_frame
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 5, bits);
    expect(to.instance_bits).toBe(7);
    expect(to.owner).toBe(99);
    expect(to.old_frame).toBe(55);
  });

  test("sound with volume+attenuation flags", () => {
    const U_SOUND = 1 << 26;
    const SOUND_FLAG_VOLUME = 1 << 14;
    const SOUND_FLAG_ATTENUATION = 1 << 15;
    const soundWord = 100 | SOUND_FLAG_VOLUME | SOUND_FLAG_ATTENUATION;
    MSG_WriteShort(net_message, soundWord);
    MSG_WriteByte(net_message, 128); // loop_volume byte
    MSG_WriteByte(net_message, 64); // loop_attenuation byte
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 6, U_SOUND);
    expect(to.sound).toBe(100);
    expect(to.loop_volume).toBeCloseTo(128 / 255, 5);
    expect(to.loop_attenuation).toBeCloseTo(64 / 64, 5);
  });

  test("event resets to 0 when U_EVENT is not set, even if `from` carried a nonzero value", () => {
    const from = new EntityStateT();
    from.event = 5;
    const to = new EntityStateT();
    MSG_BeginReading(net_message); // no bytes -- bits=0
    KEX_DEMO_CODEC.readDeltaEntity(from, to, 7, 0);
    expect(to.event).toBe(0);
  });

  test("alpha + scale (HI_SCALE hi-word bit)", () => {
    const U_ALPHA = 1 << 30;
    const bits = combineBits(U_ALPHA, 1 /* HI_SCALE */);
    MSG_WriteByte(net_message, 128); // alpha byte
    MSG_WriteByte(net_message, 32); // scale byte
    MSG_BeginReading(net_message);

    const to = new EntityStateT();
    KEX_DEMO_CODEC.readDeltaEntity(new EntityStateT(), to, 8, bits);
    expect(to.alpha).toBeCloseTo(128 / 255, 5);
    expect(to.scale).toBeCloseTo(32 / 16, 5);
  });
});

// ---------------------------------------------------------------------------
// Player state (kex.c:625-766)
// ---------------------------------------------------------------------------

describe("KEX_DEMO_CODEC.readFramePlayerstate", () => {
  function writeStatbitsZero(): void {
    MSG_WriteLong(net_message, 0);
    MSG_WriteLong(net_message, 0);
  }

  test("basic pmove field (PS_M_TYPE) + viewoffset with pm_viewheight discard", () => {
    const PS_M_TYPE = 1 << 0;
    const PS_VIEWOFFSET = 1 << 7;
    const flags = PS_M_TYPE | PS_VIEWOFFSET;
    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_WriteShort(net_message, flags);
    MSG_WriteByte(net_message, 1); // pm_type
    MSG_WriteShort(net_message, 160); // viewoffset.x * 16 -> 10
    MSG_WriteShort(net_message, -80); // viewoffset.y * 16 -> -5
    MSG_WriteShort(net_message, 64); // viewoffset.z * 16 -> 4
    MSG_WriteByte(net_message, 22); // pm_viewheight -- discarded (no field to store it in)
    writeStatbitsZero();
    MSG_BeginReading(net_message);

    const to = new PlayerStateT();
    KEX_DEMO_CODEC.readFramePlayerstate(new PlayerStateT(), to);
    expect(to.pmove.pm_type).toBe(1);
    expect(to.viewoffset[0]).toBeCloseTo(10, 4);
    expect(to.viewoffset[1]).toBeCloseTo(-5, 4);
    expect(to.viewoffset[2]).toBeCloseTo(4, 4);
  });

  test("weaponframe: 9-bit frame + 7-bit GUNBIT_* sub-flags packed into one u16 (kex.c:704-726)", () => {
    const PS_WEAPONFRAME = 1 << 13;
    const GUNBIT_OFFSET_X = 1 << 0;
    const GUNBIT_ANGLES_Z = 1 << 5;
    const GUNBIT_GUNRATE = 1 << 6;
    const subflags = GUNBIT_OFFSET_X | GUNBIT_ANGLES_Z | GUNBIT_GUNRATE;
    const gunbitsWord = 100 | (subflags << 9); // frame=100

    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_WriteShort(net_message, PS_WEAPONFRAME);
    MSG_WriteShort(net_message, gunbitsWord);
    MSG_WriteFloat(net_message, 3.5); // gunoffset.x (plain float, no GUNOFFSET_SCALE)
    MSG_WriteFloat(net_message, 90.0); // gunangles.z (plain float)
    MSG_WriteByte(net_message, 20); // gunrate
    writeStatbitsZero();
    MSG_BeginReading(net_message);

    const to = new PlayerStateT();
    KEX_DEMO_CODEC.readFramePlayerstate(new PlayerStateT(), to);
    expect(to.gunframe).toBe(100);
    expect(to.gunoffset[0]).toBeCloseTo(3.5, 4);
    expect(to.gunangles[2]).toBeCloseTo(90.0, 4);
    expect(to.gunrate).toBe(20);
  });

  test("PS_MOREBITS extended flags: PS_KEX_DAMAGE_BLEND + PS_KEX_TEAM_ID", () => {
    const PS_MOREBITS = 1 << 15;
    // moreFlags (the second u16) shifts left 16 -- bit0=PS_KEX_DAMAGE_BLEND
    // (overall bit16), bit1=PS_KEX_TEAM_ID (overall bit17).
    const moreFlags = 1 | 2;

    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_WriteShort(net_message, PS_MOREBITS);
    MSG_WriteShort(net_message, moreFlags);
    writeStatbitsZero();
    MSG_WriteByte(net_message, 255); // damage_blend.r
    MSG_WriteByte(net_message, 128); // damage_blend.g
    MSG_WriteByte(net_message, 64); // damage_blend.b
    MSG_WriteByte(net_message, 32); // damage_blend.a
    MSG_WriteByte(net_message, 3); // team_id
    MSG_BeginReading(net_message);

    const to = new PlayerStateT();
    KEX_DEMO_CODEC.readFramePlayerstate(new PlayerStateT(), to);
    expect(to.damage_blend[0]).toBeCloseTo(255 / 255, 4);
    expect(to.damage_blend[1]).toBeCloseTo(128 / 255, 4);
    expect(to.damage_blend[2]).toBeCloseTo(64 / 255, 4);
    expect(to.damage_blend[3]).toBeCloseTo(32 / 255, 4);
    expect(to.team_id).toBe(3);
  });

  test("stats: two u32 masks read unconditionally; only the first 32 slots (this port's MAX_STATS) are stored", () => {
    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_WriteShort(net_message, 0); // flags: nothing else set
    MSG_WriteLong(net_message, 0x21); // statbits1: bit0 + bit5
    MSG_WriteShort(net_message, 111); // stats[0]
    MSG_WriteShort(net_message, 222); // stats[5]
    MSG_WriteLong(net_message, 0x1); // statbits2: bit0 -> overall slot 32 (out of range)
    MSG_WriteShort(net_message, 333); // consumed, not stored (idx 32 >= 32-slot array)
    MSG_BeginReading(net_message);

    const to = new PlayerStateT();
    expect(() => KEX_DEMO_CODEC.readFramePlayerstate(new PlayerStateT(), to)).not.toThrow();
    expect(to.stats[0]).toBe(111);
    expect(to.stats[5]).toBe(222);
    expect(to.stats.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Frame envelope (kex.c:768-796)
// ---------------------------------------------------------------------------

describe("KEX_DEMO_CODEC.readFrameHeader / readPacketEntitiesBegin", () => {
  test("unpacked serverframe/deltaframe (no q2repro-style offset packing)", () => {
    MSG_WriteLong(net_message, 100);
    MSG_WriteLong(net_message, 95);
    MSG_WriteByte(net_message, 2); // suppress_count
    MSG_WriteByte(net_message, 3); // areabits_len
    MSG_WriteByte(net_message, 0xaa);
    MSG_WriteByte(net_message, 0xbb);
    MSG_WriteByte(net_message, 0xcc);
    MSG_BeginReading(net_message);

    const areabits = new Uint8Array(8);
    const header = KEX_DEMO_CODEC.readFrameHeader(areabits, false);
    expect(header.serverframe).toBe(100);
    expect(header.deltaframe).toBe(95);
    expect(header.surpressCount).toBe(2);
    expect(Array.from(areabits.subarray(0, 3))).toEqual([0xaa, 0xbb, 0xcc]);
  });

  test("deltaframe -1 (keyframe sentinel) passes through unpacked", () => {
    MSG_WriteLong(net_message, 50);
    MSG_WriteLong(net_message, -1);
    MSG_WriteByte(net_message, 0);
    MSG_WriteByte(net_message, 0);
    MSG_BeginReading(net_message);

    const header = KEX_DEMO_CODEC.readFrameHeader(new Uint8Array(1), false);
    expect(header.deltaframe).toBe(-1);
  });

  test("readPacketEntitiesBegin validates the svc_packetentities opcode", () => {
    MSG_WriteByte(net_message, SvcOpsT.svc_packetentities);
    MSG_BeginReading(net_message);
    expect(() => KEX_DEMO_CODEC.readPacketEntitiesBegin()).not.toThrow();

    resetNetMessage();
    MSG_WriteByte(net_message, 99);
    MSG_BeginReading(net_message);
    expect(() => KEX_DEMO_CODEC.readPacketEntitiesBegin()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Auxiliary messages (not part of ProtocolCodec -- see kexdemo.ts header)
// ---------------------------------------------------------------------------

describe("KEX auxiliary message readers", () => {
  test("readDamageKex: overflow beyond MAX_DAMAGE_INDICATORS(4) is consumed but not stored", () => {
    MSG_WriteByte(net_message, 5); // count -- exceeds the 4-slot limit
    for (let i = 0; i < 5; i++) {
      const encoded = i === 0 ? (1 | 0x20) : i + 1; // i=0 sets damage=1,health=true
      MSG_WriteByte(net_message, encoded);
      MSG_WriteDir(net_message, vec3(1, 0, 0));
    }
    MSG_BeginReading(net_message);

    const result = readDamageKex();
    expect(result.length).toBe(4); // 5th indicator consumed, not stored
    expect(result[0]!.damage).toBe(1);
    expect(result[0]!.health).toBe(true);
  });

  test("readPoiKex", () => {
    MSG_WriteShort(net_message, 10); // key
    MSG_WriteShort(net_message, 20); // time
    MSG_WriteFloat(net_message, 1);
    MSG_WriteFloat(net_message, 2);
    MSG_WriteFloat(net_message, 3);
    MSG_WriteShort(net_message, 5); // image
    MSG_WriteByte(net_message, 7); // color
    MSG_WriteByte(net_message, 1); // flags
    MSG_BeginReading(net_message);

    const poi = readPoiKex();
    expect(poi.key).toBe(10);
    expect(poi.time).toBe(20);
    expect(Array.from(poi.pos)).toEqual([1, 2, 3]);
    expect(poi.image).toBe(5);
    expect(poi.color).toBe(7);
    expect(poi.flags).toBe(1);
  });

  test("readHelpPathKex", () => {
    MSG_WriteByte(net_message, 1); // start = true
    MSG_WriteFloat(net_message, 4);
    MSG_WriteFloat(net_message, 5);
    MSG_WriteFloat(net_message, 6);
    MSG_WriteDir(net_message, vec3(0, 1, 0));
    MSG_BeginReading(net_message);

    const hp = readHelpPathKex();
    expect(hp.start).toBe(true);
    expect(Array.from(hp.pos)).toEqual([4, 5, 6]);
    expect(hp.dir[1]).toBeCloseTo(1, 4);
  });

  test("readMuzzleflash3Kex: signed entity, unsigned weapon", () => {
    MSG_WriteShort(net_message, -5);
    MSG_WriteShort(net_message, 300);
    MSG_BeginReading(net_message);

    const mf = readMuzzleflash3Kex();
    expect(mf.entity).toBe(-5);
    expect(mf.weapon).toBe(300);
  });

  test("readAchievementKex", () => {
    MSG_WriteString(net_message, "ACH_SECRET_FOUND");
    MSG_BeginReading(net_message);
    expect(readAchievementKex()).toBe("ACH_SECRET_FOUND");
  });

  test("readLocprintKex: base + args", () => {
    MSG_WriteByte(net_message, 1); // flags
    MSG_WriteString(net_message, "$g_pickup_item");
    MSG_WriteByte(net_message, 2); // num_args
    MSG_WriteString(net_message, "Health");
    MSG_WriteString(net_message, "25");
    MSG_BeginReading(net_message);

    const lp = readLocprintKex();
    expect(lp.flags).toBe(1);
    expect(lp.base).toBe("$g_pickup_item");
    expect(lp.args).toEqual(["Health", "25"]);
  });

  test("readLocprintKex: num_args beyond MAX_LOCALIZATION_ARGS(8) throws", () => {
    MSG_WriteByte(net_message, 0);
    MSG_WriteString(net_message, "x");
    MSG_WriteByte(net_message, 9);
    MSG_BeginReading(net_message);
    expect(() => readLocprintKex()).toThrow();
  });

  test("readSplitclientKex: consumes exactly one byte", () => {
    MSG_WriteByte(net_message, 1);
    MSG_BeginReading(net_message);
    expect(() => readSplitclientKex()).not.toThrow();
    expect(net_message.readcount).toBe(net_message.cursize);
  });

  test("readSoundKex: SND_KEX_LARGE_ENT widens entchan to u32", () => {
    const SND_ENT = 1 << 3;
    const SND_KEX_LARGE_ENT = 1 << 6;
    const flags = SND_ENT | SND_KEX_LARGE_ENT;
    const entnum = 5000; // exceeds 13-bit range a u16 entchan could safely carry alongside a channel
    const entchan = (entnum << 3) | 2; // channel=2

    MSG_WriteByte(net_message, flags);
    MSG_WriteShort(net_message, 42); // index
    MSG_WriteLong(net_message, entchan);
    MSG_BeginReading(net_message);

    const sound = readSoundKex();
    expect(sound.index).toBe(42);
    expect(sound.entity).toBe(entnum);
    expect(sound.channel).toBe(2);
    expect(sound.pos).toBeNull();
    expect(sound.volume).toBe(1.0); // SND_VOLUME not set -> default
    expect(sound.attenuation).toBe(1.0); // SND_ATTENUATION not set -> default
  });

  test("readSoundKex: SND_POS low-precision short form under the demo protocol", () => {
    setKexProtocol(PROTOCOL_KEX_DEMOS);
    const SND_POS = 1 << 2;
    MSG_WriteByte(net_message, SND_POS);
    MSG_WriteShort(net_message, 10); // index
    MSG_WriteShort(net_message, 800); // 100
    MSG_WriteShort(net_message, -400); // -50
    MSG_WriteShort(net_message, 96); // 12
    MSG_BeginReading(net_message);

    const sound = readSoundKex();
    expect(sound.pos).not.toBeNull();
    expect(sound.pos![0]).toBeCloseTo(100, 4);
    expect(sound.pos![1]).toBeCloseTo(-50, 4);
    expect(sound.pos![2]).toBeCloseTo(12, 4);
  });

  test("readSoundKex: SND_POS under the live (2023) protocol is not implemented and throws rather than misdecoding", () => {
    // kexServerProtocol defaults to PROTOCOL_KEX in beforeEach.
    const SND_POS = 1 << 2;
    MSG_WriteByte(net_message, SND_POS);
    MSG_WriteShort(net_message, 10);
    MSG_BeginReading(net_message);
    expect(() => readSoundKex()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// svc_rr_configblast / svc_rr_spawnbaselineblast (kex.c:807-890) -- real
// zlib inflate via node:zlib, matching this port line's own established
// precedent (qcommon/png.ts, qcommon/zipfile.ts). The compressed payloads
// below are produced with node:zlib.deflateSync in the test itself
// (Q2P_INFL_DEFL_HEADER = a standard zlib-wrapped stream, matching
// inflateSync's expected input) -- this validates the real inflate
// round-trip, not just the byte layout around it.
// ---------------------------------------------------------------------------

describe("KEX auxiliary blast messages (deflate round-trip)", () => {
  test("readConfigblastKex decodes a stream of {index, value} records", () => {
    const inner = new SizeBuf();
    SZ_Init(inner, new Uint8Array(256), 256);
    MSG_WriteShort(inner, 5);
    MSG_WriteString(inner, "some_configstring");
    MSG_WriteShort(inner, 12);
    MSG_WriteString(inner, "another one");
    const compressed = deflateWrapped(inner.data.subarray(0, inner.cursize));

    MSG_WriteShort(net_message, compressed.length);
    MSG_WriteShort(net_message, inner.cursize); // uncompressed_len -- discarded by the reader
    for (const b of compressed) MSG_WriteByte(net_message, b);
    MSG_BeginReading(net_message);

    const records = readConfigblastKex();
    expect(records).toEqual([
      { index: 5, value: "some_configstring" },
      { index: 12, value: "another one" },
    ]);
  });

  test("readSpawnbaselineblastKex decodes a stream of baseline entity-delta records without disturbing net_message afterward", () => {
    // One simple baseline record: bits=U_FRAME8(0x10) only (fits a single lo
    // byte, no MOREBITS chain needed), entnum=7 (<256, no U_NUMBER16).
    const inner = new Uint8Array([0x10, 7, 55]);
    const compressed = deflateWrapped(inner);

    MSG_WriteShort(net_message, compressed.length);
    MSG_WriteShort(net_message, inner.length);
    for (const b of compressed) MSG_WriteByte(net_message, b);
    // A sentinel byte the outer dispatch loop would read NEXT, after the
    // blast message -- proves net_message's cursor/data were correctly
    // restored, not left pointing at the (now torn-down) inflated buffer.
    MSG_WriteByte(net_message, 0xee);
    MSG_BeginReading(net_message);

    const records = readSpawnbaselineblastKex();
    expect(records.length).toBe(1);
    expect(records[0]!.entnum).toBe(7);
    expect(records[0]!.state.frame).toBe(55);

    expect(MSG_ReadByte(net_message)).toBe(0xee);
  });
});
