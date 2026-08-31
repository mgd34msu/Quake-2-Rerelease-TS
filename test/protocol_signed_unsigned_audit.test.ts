// Regression gate for the signed-vs-unsigned 16-bit read audit that commit
// 8018fcc started (modelindex1-4/frame/skinnum/effects/renderfx/morefx in
// the q2repro/kexdemo codecs) and .orch/followups.md's "signed/unsigned
// follow-up" queued as the remainder: pm_flags/pm_time/gravity/the sound
// word in q2repro.ts, "and ANY other MSG_ReadShort site" in the kex-family
// codecs (src/qcommon/protocol/q2repro.ts, src/qcommon/protocol/kexdemo.ts).
//
// Every case below targets a field this audit reclassified from
// MSG_ReadShort (signed) to MSG_ReadWord (unsigned), or a field confirmed to
// be genuinely signed and therefore left alone -- see each file's own inline
// citations (q2proto_proto_q2repro.c / q2proto_proto_kex.c /
// q2proto_internal_io.h line numbers) for the underlying C source proof.
// Boundary values are 0x8000 (the sign bit) and 0xffff (all 16 bits, q2repro
// msg.c:633's `mask = 0xffff0000` lets the whole range ride the wire) per
// this unit's own task brief, plus a couple of values specific to a field's
// own bit-packing (gunskin's 3-bit range, gunbits' frame+subflag split).

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteFloat } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { PS_M_TIME, PS_M_FLAGS, PS_WEAPONINDEX, PS_WEAPONFRAME, U_SOUND } from "../src/qcommon/qcommon";
import { Q2REPRO_CODEC, readFog, Q2PRO_GUNINDEX_BITS, Q2PRO_GUNINDEX_MASK } from "../src/qcommon/protocol/q2repro";
import { SvcFogDataBitsT } from "../src/kexapi/game";
import {
  KEX_DEMO_CODEC,
  PROTOCOL_KEX,
  setKexProtocol,
  readPoiKex,
  readMuzzleflash3Kex,
  readSoundKex,
  readConfigblastKex,
  readSpawnbaselineblastKex,
  HI_KEX_OWNER,
  HI_KEX_OLDFRAME,
  GUNBIT_GUNRATE,
} from "../src/qcommon/protocol/kexdemo";
import { combineBits } from "../src/qcommon/protocol/q2repro";

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  resetNetMessage();
  setKexProtocol(PROTOCOL_KEX);
});

const BOUNDARY_VALUES = [0x8000, 0xffff];

// =============================================================================
// q2repro.ts (1038 live network protocol)
// =============================================================================

describe("Q2REPRO_CODEC -- signed/unsigned audit regressions", () => {
  for (const value of BOUNDARY_VALUES) {
    test(`readEntityBitsWide: entnum 0x${value.toString(16)} round-trips unsigned (q2proto_internal_common.c:88-89)`, () => {
      const from = new EntityStateT();
      from.number = value;
      const to = new EntityStateT();
      to.number = value;
      to.solid = 5; // any real delta so writeDeltaEntity emits something to read back

      Q2REPRO_CODEC.writeDeltaEntity(net_message, from, to, true, true);
      MSG_BeginReading(net_message);
      const { number, bits } = Q2REPRO_CODEC.readEntityBits();
      expect(number).toBe(value);

      const out = new EntityStateT();
      Q2REPRO_CODEC.readDeltaEntity(from, out, number, bits);
      expect(out.solid).toBe(5);
    });
  }

  for (const value of BOUNDARY_VALUES) {
    test(`playerstate delta: pm_time 0x${value.toString(16)} round-trips unsigned (q2proto_proto_q2repro.c:656)`, () => {
      const from = new PlayerStateT();
      const to = new PlayerStateT();
      to.pmove.pm_time = value;

      const msg = new SizeBuf();
      SZ_Init(msg, new Uint8Array(64), 64);
      Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
      MSG_BeginReading(msg);
      msg.readcount = 1; // consume the svc_playerinfo tag

      const out = new PlayerStateT();
      Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
      expect(out.pmove.pm_time).toBe(value);
    });

    test(`playerstate delta: pm_flags 0x${value.toString(16)} round-trips unsigned (q2proto_proto_q2repro.c:659)`, () => {
      const from = new PlayerStateT();
      const to = new PlayerStateT();
      to.pmove.pm_flags = value;

      const msg = new SizeBuf();
      SZ_Init(msg, new Uint8Array(64), 64);
      Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
      MSG_BeginReading(msg);
      msg.readcount = 1;

      const out = new PlayerStateT();
      Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
      expect(out.pmove.pm_flags).toBe(value);
    });

    test(`playerstate delta: gunframe 0x${value.toString(16)} round-trips unsigned (q2proto_proto_q2repro.c:697)`, () => {
      const from = new PlayerStateT();
      const to = new PlayerStateT();
      to.gunframe = value;

      const msg = new SizeBuf();
      SZ_Init(msg, new Uint8Array(64), 64);
      Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
      MSG_BeginReading(msg);
      msg.readcount = 1;

      const out = new PlayerStateT();
      Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
      expect(out.gunframe).toBe(value);
    });
  }

  // gravity is genuinely SIGNED (q2proto_proto_q2repro.c:662, i16) -- confirm
  // a negative value still round-trips, guarding against an over-eager
  // future "just convert every pm_* field" pass undoing this deliberately
  // preserved case.
  test("playerstate delta: negative gravity still round-trips signed (q2proto_proto_q2repro.c:662)", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.gravity = -800;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1;

    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.pmove.gravity).toBe(-800);
  });

  // gun_index_and_skin: the real bug. gunskin=7 sets bit 15 of the packed
  // u16 (7 << Q2PRO_GUNINDEX_BITS(13) = 0xE000) -- exactly the condition a
  // signed MSG_ReadShort corrupts via `>>> Q2PRO_GUNINDEX_BITS` sign
  // extension (q2proto_proto_q2repro.c:688-689).
  test("playerstate delta: gunskin=7 (bit 15 set) round-trips without corruption", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunindex = 5;
    to.gunskin = 7;
    expect((5 | (7 << Q2PRO_GUNINDEX_BITS)) & 0xffff).toBe(0xe005);

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1;

    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.gunindex & Q2PRO_GUNINDEX_MASK).toBe(5);
    expect(out.gunskin).toBe(7); // buggy signed read would produce ~524284, not 7
  });

  for (const value of BOUNDARY_VALUES) {
    test(`readFog: BIT_TIME 0x${value.toString(16)} round-trips unsigned (q2proto_proto_q2repro.c:845)`, () => {
      MSG_WriteByte(net_message, SvcFogDataBitsT.BIT_TIME); // bits byte, fits without BIT_MORE_BITS
      MSG_WriteShort(net_message, value);
      MSG_BeginReading(net_message);

      const fog = readFog();
      expect(fog.time).toBe(value);
    });
  }
});

// =============================================================================
// kexdemo.ts (KEX-native demo playback + live-network aux readers shared
// with q2repro.ts via cl_parse.ts, per that file's own imports)
// =============================================================================

describe("KEX_DEMO_CODEC -- signed/unsigned audit regressions", () => {
  for (const value of BOUNDARY_VALUES) {
    test(`readDeltaEntity: owner 0x${value.toString(16)} round-trips unsigned (q2proto_proto_kex.c:538)`, () => {
      const from = new EntityStateT();
      from.number = 7;
      const to = new EntityStateT();

      MSG_WriteShort(net_message, value);
      MSG_BeginReading(net_message);

      KEX_DEMO_CODEC.readDeltaEntity(from, to, 7, combineBits(0, HI_KEX_OWNER));
      expect(to.owner).toBe(value);
    });

    test(`readDeltaEntity: old_frame 0x${value.toString(16)} round-trips unsigned (q2proto_proto_kex.c:544)`, () => {
      const from = new EntityStateT();
      from.number = 8;
      const to = new EntityStateT();

      MSG_WriteShort(net_message, value);
      MSG_BeginReading(net_message);

      KEX_DEMO_CODEC.readDeltaEntity(from, to, 8, combineBits(0, HI_KEX_OLDFRAME));
      expect(to.old_frame).toBe(value);
    });
  }

  test("readDeltaEntity: owner AND old_frame together stay aligned (no cross-field corruption)", () => {
    const from = new EntityStateT();
    from.number = 9;
    const to = new EntityStateT();

    MSG_WriteShort(net_message, 0x8000);
    MSG_WriteShort(net_message, 0xffff);
    MSG_BeginReading(net_message);

    KEX_DEMO_CODEC.readDeltaEntity(from, to, 9, combineBits(0, HI_KEX_OWNER | HI_KEX_OLDFRAME));
    expect(to.owner).toBe(0x8000);
    expect(to.old_frame).toBe(0xffff);
  });

  // kex playerstate body: flags word(s) via readKexFlags, then the field
  // body, then TWO unconditional u32 statbit masks (kex.c:738-751) -- every
  // hand-built buffer below ends with two zero longs for that reason, even
  // when the test isn't about stats.
  for (const value of BOUNDARY_VALUES) {
    test(`readPlayerStateDelta: pm_time 0x${value.toString(16)} round-trips unsigned (q2proto_proto_kex.c:661)`, () => {
      MSG_WriteShort(net_message, PS_M_TIME);
      MSG_WriteShort(net_message, value);
      MSG_WriteLong(net_message, 0); // statbits1
      MSG_WriteLong(net_message, 0); // statbits2
      MSG_BeginReading(net_message);

      const from = new PlayerStateT();
      const to = new PlayerStateT();
      KEX_DEMO_CODEC.readPlayerStateDelta(net_message, from, to);
      expect(to.pmove.pm_time).toBe(value);
    });

    test(`readPlayerStateDelta: pm_flags 0x${value.toString(16)} round-trips unsigned (q2proto_proto_kex.c:664)`, () => {
      MSG_WriteShort(net_message, PS_M_FLAGS);
      MSG_WriteShort(net_message, value);
      MSG_WriteLong(net_message, 0);
      MSG_WriteLong(net_message, 0);
      MSG_BeginReading(net_message);

      const from = new PlayerStateT();
      const to = new PlayerStateT();
      KEX_DEMO_CODEC.readPlayerStateDelta(net_message, from, to);
      expect(to.pmove.pm_flags).toBe(value);
    });
  }

  test("readPlayerStateDelta: gunskin=7 (bit 15 set) round-trips without corruption (q2proto_proto_kex.c:695)", () => {
    MSG_WriteShort(net_message, PS_WEAPONINDEX);
    MSG_WriteShort(net_message, (5 | (7 << Q2PRO_GUNINDEX_BITS)) & 0xffff); // 0xe005
    MSG_WriteLong(net_message, 0);
    MSG_WriteLong(net_message, 0);
    MSG_BeginReading(net_message);

    const from = new PlayerStateT();
    const to = new PlayerStateT();
    KEX_DEMO_CODEC.readPlayerStateDelta(net_message, from, to);
    expect(to.gunindex & Q2PRO_GUNINDEX_MASK).toBe(5);
    expect(to.gunskin).toBe(7);
  });

  // gunbits: structurally similar to gun_index_and_skin above (a >>> shift
  // right after a 16-bit read), but VERIFIED HARMLESS under a signed read --
  // GUNBIT_* only tests bits 0-6 of the post-shift value, which come from
  // the wire value's bits 9-15 (untouched by sign extension either way);
  // the polluted bits a signed read would introduce land in post-shift bits
  // 7-22, which nothing here reads. This test exists to pin that
  // "harmless" conclusion down with a concrete case (frame=100,
  // GUNBIT_GUNRATE alone -> wire value 0x8064, bit 15 set) rather than
  // leaving it as an unverified claim in a comment: if a future change made
  // gunbits magnitude-sensitive (e.g. storing the raw shifted value instead
  // of testing it bit-by-bit), this would start failing.
  test("readPlayerStateDelta: gunbits high subflag (GUNBIT_GUNRATE alone) decodes correctly, no extra fields consumed (q2proto_proto_kex.c:704)", () => {
    const gunbits = 100 | (GUNBIT_GUNRATE << 9);
    expect(gunbits).toBe(0x8064);

    MSG_WriteShort(net_message, PS_WEAPONFRAME);
    MSG_WriteShort(net_message, gunbits);
    MSG_WriteByte(net_message, 5); // gunrate (the only GUNBIT_* field this buffer carries)
    MSG_WriteLong(net_message, 0);
    MSG_WriteLong(net_message, 0);
    MSG_BeginReading(net_message);

    const from = new PlayerStateT();
    const to = new PlayerStateT();
    KEX_DEMO_CODEC.readPlayerStateDelta(net_message, from, to);

    expect(to.gunframe).toBe(100);
    expect(to.gunrate).toBe(5);
    // No GUNBIT_OFFSET_*/ANGLES_* fields were sent -- if the shift corrupted
    // the subflag field, one of these would have absorbed 4 bytes of the
    // (nonexistent) float fields, or the trailing statbits longs, instead.
    expect(Array.from(to.gunoffset)).toEqual([0, 0, 0]);
    expect(Array.from(to.gunangles)).toEqual([0, 0, 0]);
  });

  for (const value of BOUNDARY_VALUES) {
    test(`readPoiKex: key/time/image 0x${value.toString(16)} round-trip unsigned (q2repro.c:887-890)`, () => {
      MSG_WriteShort(net_message, value); // key
      MSG_WriteShort(net_message, value); // time
      MSG_WriteFloat(net_message, 1);
      MSG_WriteFloat(net_message, 2);
      MSG_WriteFloat(net_message, 3);
      MSG_WriteShort(net_message, value); // image
      MSG_WriteByte(net_message, 1); // color
      MSG_WriteByte(net_message, 0); // flags
      MSG_BeginReading(net_message);

      const poi = readPoiKex();
      expect(poi.key).toBe(value);
      expect(poi.time).toBe(value);
      expect(poi.image).toBe(value);
    });
  }

  test("readMuzzleflash3Kex: weapon 0xffff round-trips unsigned, entity stays signed (q2repro.c:746-747)", () => {
    MSG_WriteShort(net_message, -1); // entity: i16, -1 is a real sentinel value
    MSG_WriteShort(net_message, 0xffff); // weapon: u16
    MSG_BeginReading(net_message);

    const mf = readMuzzleflash3Kex();
    expect(mf.entity).toBe(-1);
    expect(mf.weapon).toBe(0xffff);
  });

  for (const value of BOUNDARY_VALUES) {
    test(`readSoundKex: index 0x${value.toString(16)} round-trips unsigned (q2proto_proto_kex.c:570)`, () => {
      MSG_WriteByte(net_message, 0); // flags: no SND_VOLUME/ATTENUATION/OFFSET/ENT/POS
      MSG_WriteShort(net_message, value); // index
      MSG_BeginReading(net_message);

      const sound = readSoundKex();
      expect(sound.index).toBe(value);
    });
  }

  // compressed_len: the most consequential bug in this audit by failure
  // mode, even though it never manifested against real retail demo data.
  // Both configblast and spawnbaselineblast read it via MSG_ReadShort into
  // `new Uint8Array(compressedLen)` -- a compressed block >= 32768 bytes
  // (very plausible for a configstring or baseline blast bundling dozens of
  // records) would have gone negative and thrown RangeError, crashing the
  // parser outright rather than misdecoding a value. This builds a real
  // >32KB deflate stream (high-entropy input, so it doesn't compress away)
  // to reproduce the exact wire shape, not just assert on a hand-picked
  // number.
  function bigIncompressibleBlock(): Uint8Array {
    const raw = new Uint8Array(40000);
    // xorshift32, not Math.random(): deterministic across runs, and its
    // output is high-entropy enough that deflate cannot shrink it below the
    // 0x8000 boundary this test needs to exercise.
    let state = 0x9e3779b9;
    for (let i = 0; i < raw.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raw[i] = state & 0xff;
    }
    const zlib = require("node:zlib") as typeof import("node:zlib");
    const compressed = new Uint8Array(zlib.deflateSync(raw));
    expect(compressed.length).toBeGreaterThan(0x8000); // sanity: the test actually exercises the boundary
    expect(compressed.length).toBeLessThan(0x10000); // must still fit the u16 field
    return compressed;
  }

  // Both readers consume from the shared net_message singleton (kexdemo.ts's
  // documented "signature asymmetry" -- see readSpawnbaselineblastKex's own
  // save/restore-net_message idiom, mirrored here), so net_message itself
  // has to be grown to hold the >32KB block rather than a scratch SizeBuf.
  function withBigNetMessage(compressed: Uint8Array, run: () => void): void {
    const savedData = net_message.data;
    const savedView = net_message.view;
    const savedCursize = net_message.cursize;
    const savedReadcount = net_message.readcount;
    const savedMaxsize = net_message.maxsize;
    try {
      const big = new SizeBuf();
      SZ_Init(big, new Uint8Array(compressed.length + 4096), compressed.length + 4096);
      MSG_WriteShort(big, compressed.length); // compressed_len
      MSG_WriteShort(big, 40000); // uncompressed_len -- discarded either way
      for (const b of compressed) MSG_WriteByte(big, b);
      net_message.data = big.data;
      net_message.view = big.view;
      net_message.cursize = big.cursize;
      net_message.readcount = 0;
      net_message.maxsize = big.maxsize;
      run();
    } finally {
      net_message.data = savedData;
      net_message.view = savedView;
      net_message.cursize = savedCursize;
      net_message.readcount = savedReadcount;
      net_message.maxsize = savedMaxsize;
    }
  }

  test("readConfigblastKex: compressed_len >= 0x8000 does not throw RangeError (q2proto_proto_kex.c:876)", () => {
    const compressed = bigIncompressibleBlock();
    withBigNetMessage(compressed, () => {
      expect(() => readConfigblastKex()).not.toThrow();
    });
  });

  test("readSpawnbaselineblastKex: compressed_len >= 0x8000 does not throw RangeError (q2proto_proto_kex.c:832)", () => {
    const compressed = bigIncompressibleBlock();
    withBigNetMessage(compressed, () => {
      expect(() => readSpawnbaselineblastKex()).not.toThrow();
    });
  });
});
