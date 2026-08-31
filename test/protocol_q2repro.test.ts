// Golden-byte gate for the 1038 (q2repro) protocol codec
// (src/qcommon/protocol/q2repro.ts), ARCHITECTURE.md "Protocol layer" /
// .orch/phase5-design.md phase 5 unit.
//
// Unlike test/protocol_golden.test.ts's vanilla fixtures (captured from a
// pre-refactor code path via git-stash), there is no prior TypeScript
// implementation of 1038 to capture bytes from. Every expected byte array
// below is derived BY HAND from reading q2proto's C source
// (~/Projects/q2proto/src/q2proto_proto_q2repro.c and the shared machinery
// it calls into -- q2proto_internal_common.c's entity-bits header writer,
// q2proto_internal_protocol.h's bit constants, inc/q2proto/q2proto_valenc.h's
// quantization formulas), with each case's derivation shown in a comment
// immediately above it citing the exact source lines. IEEE-754 float32 byte
// patterns and int16 two's-complement byte patterns are computed
// arithmetically (shown inline) rather than guessed -- both are pure,
// well-defined bit-layout functions, not implementation-specific behavior.
//
// Read-side coverage is round-trip (write via Q2REPRO_CODEC, read back via
// Q2REPRO_CODEC, assert field equality) rather than second byte-array
// assertions, matching protocol_golden.test.ts's own stated convention for
// read-side tests.

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT, UsercmdT } from "../src/shared/q_shared";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
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
// writeDeltaEntity -- golden bytes hand-derived from
// q2proto_q2repro_server_write_entity_state_delta (q2repro.c:1776-1975) and
// q2proto_common_server_write_entity_bits (q2proto_internal_common.c:115-145).
// =============================================================================

describe("Q2REPRO_CODEC.writeDeltaEntity -- golden bytes", () => {
  test("no change, force=false -> nothing written", () => {
    const same = new EntityStateT();
    same.number = 7;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, same, same, false, false));
    expect(bytes).toEqual([]);
  });

  // Wide entity number (1023, the max valid MAX_EDICTS-1 index) + a single
  // float origin axis change.
  //   lo = U_ORIGIN3(BIT(9)=0x200) | U_NUMBER16(BIT(8)=0x100) = 0x300
  //   0x300 & 0x0000ff00 != 0 -> MOREBITS1 (BIT(7)=0x80) added -> lo=0x380
  //   byte0 = 0x380&0xff=0x80=128; byte1=(0x380>>>8)&0xff=0x03=3
  //   entnum=1023=0x03FF -> MSG_WriteShort LE = [0xFF,0x03] = [255,3]
  //   field: U_ORIGIN3 -> float32(300.0) = [0,0,150,67] (IEEE-754 LE)
  test("wide entity number (1023) + single float origin axis", () => {
    const from = new EntityStateT();
    from.number = 1023;
    const to = new EntityStateT();
    to.number = 1023;
    to.origin[2] = 300.0;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 3, 255, 3, 0, 0, 150, 67]);
  });

  // alpha + scale set together from their 0 ("default") sentinel.
  //   lo = U_ALPHA (BIT(30)=0x40000000); hi = HI_SCALE (overall BIT(32))
  //   hi!=0 -> lo |= MOREBITS4|3|2|1 (0x80000000|0x800000|0x8000|0x80)
  //   lo = 0x40000000|0x80000000|0x800000|0x8000|0x80 = 0xC0808080
  //   bytes (LE dword) = [0x80,0x80,0x80,0xC0] = [128,128,128,192]
  //   MOREBITS4 set -> hi byte = HI_SCALE&0xff = 1
  //   entnum=50 (<256) -> byte 50
  //   fields: U_ALPHA -> encodeAlpha(0.5) = clamp(trunc(0.5*255),1,255) = 127
  //           HI_SCALE -> encodeScale(2.0) = clamp(trunc(2.0*16),1,255) = 32
  //   (q2proto_valenc.h:124-139; q2repro.c:1847-1851,1967-1971)
  test("alpha + scale set (hi-word bits, MOREBITS4 chain)", () => {
    const from = new EntityStateT();
    from.number = 50;
    const to = new EntityStateT();
    to.number = 50;
    to.alpha = 0.5;
    to.scale = 2.0;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 128, 192, 1, 50, 127, 32]);
  });

  // effects_more (morefx) alone, small enough for the 8-bit encoding.
  //   lo = U_MOREFX8 (BIT(29)=0x20000000); hi=0
  //   lo&0xff000000 != 0 -> MOREBITS3|2|1 (not 4, hi==0) -> lo=0x20808080
  //   bytes = [0x80,0x80,0x80,0x20] = [128,128,128,32]; entnum=7
  //   field: U_MOREFX8 only -> MSG_WriteByte(5) (q2repro.c:1960-1965)
  test("effects_more (morefx) 8-bit alone", () => {
    const from = new EntityStateT();
    from.number = 7;
    const to = new EntityStateT();
    to.number = 7;
    to.morefx = 5;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 128, 32, 7, 5]);
  });

  // effects_more needing the 16-bit width (300 doesn't fit in 8 bits: 300 &
  // 0xff00 != 0). HI_MOREFX16 lives entirely in the hi word, so hi!=0 forces
  // the full MOREBITS4 chain even though lo has no other bits set.
  //   lo=0 initially; hi=HI_MOREFX16(2) -> lo|=MOREBITS4|3|2|1=0x80808080
  //   bytes=[0x80,0x80,0x80,0x80]=[128,128,128,128]; hi byte=2; entnum=9
  //   field: HI_MOREFX16 set, U_MOREFX8 NOT set -> MSG_WriteShort(300)
  //   300 = 0x012C -> LE [0x2C,0x01] = [44,1]
  test("effects_more (morefx) needs 16-bit width", () => {
    const from = new EntityStateT();
    from.number = 9;
    const to = new EntityStateT();
    to.number = 9;
    to.morefx = 300;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 128, 128, 2, 9, 44, 1]);
  });

  // sound index change + loop_volume change together: q2repro.c:1940-1953
  // packs loop_volume/loop_attenuation "extra" bits into the sound_word's
  // top two bits (SOUND_FLAG_VOLUME=BIT(14), SOUND_FLAG_ATTENUATION=BIT(15)).
  //   lo = U_SOUND (BIT(26)=0x04000000); lo&0xff000000!=0 -> MOREBITS3|2|1
  //   lo = 0x04000000|0x800000|0x8000|0x80 = 0x04808080
  //   bytes=[0x80,0x80,0x80,0x04]=[128,128,128,4]; entnum=3
  //   soundWord = 5 | SOUND_FLAG_VOLUME(0x4000) = 0x4005 -> LE[0x05,0x40]=[5,64]
  //   loop_volume: encodeLoopVolume(0.5) = trunc(0.5*255)=127 (not 0/255) -> 127
  test("sound index change + loop_volume change (packed sound word)", () => {
    const from = new EntityStateT();
    from.number = 3;
    from.sound = 0;
    from.loop_volume = 0;
    const to = new EntityStateT();
    to.number = 3;
    to.sound = 5;
    to.loop_volume = 0.5;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 128, 4, 3, 5, 64, 127]);
  });

  // QUIRK (faithfully reproduced): loop_volume/loop_attenuation are only
  // ever transmitted alongside a `sound` index change (q2repro.c:1940 gates
  // the entire block on `bits & U_SOUND`, and U_SOUND is only set from a
  // Q2P_ESD_SOUND/`sound` change -- never from LOOP_VOLUME/LOOP_ATTENUATION
  // alone, q2repro.c:1841-1842 vs 1942-1945). A loop_volume-only change with
  // an unchanged sound index is therefore silently dropped this delta.
  test("QUIRK: loop_volume changes alone (sound unchanged) are dropped", () => {
    const from = new EntityStateT();
    from.number = 3;
    from.sound = 5;
    from.loop_volume = 0;
    const to = new EntityStateT();
    to.number = 3;
    to.sound = 5; // unchanged
    to.loop_volume = 0.9; // changed, but never transmitted
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([]);
  });

  // modelindex >= 256 forces U_MODEL16 (q2repro.c:1835-1839).
  //   lo = U_MODEL(BIT(11)=0x800) | U_MODEL16(BIT(28)=0x10000000) = 0x10000800
  //   lo&0xff000000!=0 -> MOREBITS3|2|1 -> lo = 0x10000800|0x800000|0x8000|0x80
  //                     = 0x10808880
  //   bytes = [0x80,0x88,0x80,0x10] = [128,136,128,16]; entnum=2
  //   field: U_MODEL16 -> MSG_WriteShort(300) = [44,1]
  test("modelindex >= 256 forces U_MODEL16", () => {
    const from = new EntityStateT();
    from.number = 2;
    const to = new EntityStateT();
    to.number = 2;
    to.modelindex = 300;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 136, 128, 16, 2, 44, 1]);
  });

  // RF_BEAM forces U_OLDORIGIN even without newentity (mirrors vanilla's
  // identical `newentity || renderfx&RF_BEAM` rule -- q2repro.c relies on the
  // caller/game to decide Q2P_ESD_OLD_ORIGIN the same way; see q2repro.ts's
  // file header derivation note).
  //   lo = U_OLDORIGIN (BIT(24)=0x1000000); entnum=4 (<256, no NUMBER16)
  //   lo&0xff000000!=0 -> MOREBITS3|2|1 -> lo = 0x1000000|0x800000|0x8000|0x80
  //                     = 0x1808080
  //   bytes = [0x80,0x80,0x80,0x01] = [128,128,128,1]; entnum byte=4
  //   field: old_origin float32(0,0,0) x3 = twelve zero bytes
  test("RF_BEAM forces U_OLDORIGIN without newentity", () => {
    const RF_BEAM = 128;
    const from = new EntityStateT();
    from.number = 4;
    const to = new EntityStateT();
    to.number = 4;
    to.renderfx = RF_BEAM;
    from.renderfx = RF_BEAM; // renderfx itself unchanged; only RF_BEAM gates old_origin
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    expect(bytes).toEqual([128, 128, 128, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

// =============================================================================
// writeEntityRemove / writePacketEntitiesEnd -- Q2REPRO_CODEC reuses
// VANILLA_CODEC's implementations directly (see q2repro.ts's comment on why
// this is byte-identical for every value this engine produces: a
// U_REMOVE(+U_NUMBER16)-only bits value never needs MOREBITS2/3/4 under
// EITHER codec's entity-bits header writer).
// =============================================================================

describe("Q2REPRO_CODEC.writeEntityRemove / writePacketEntitiesEnd", () => {
  test("identical function references to VANILLA_CODEC", () => {
    expect(Q2REPRO_CODEC.writeEntityRemove).toBe(VANILLA_CODEC.writeEntityRemove);
    expect(Q2REPRO_CODEC.writePacketEntitiesEnd).toBe(VANILLA_CODEC.writePacketEntitiesEnd);
  });

  test("oldnum >= 256: bits=U_REMOVE|U_NUMBER16|U_MOREBITS1(448), short entity number", () => {
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeEntityRemove(msg, 300));
    expect(bytes).toEqual([192, 1, 44, 1]);
  });

  test("packetentities terminator is a zero short", () => {
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePacketEntitiesEnd(msg));
    expect(bytes).toEqual([0, 0]);
  });
});

// =============================================================================
// writePlayerStateDelta -- golden bytes hand-derived from
// q2repro_server_write_playerstate (q2repro.c:2006-2204).
// =============================================================================

describe("Q2REPRO_CODEC.writePlayerStateDelta -- golden bytes", () => {
  // Unlike vanilla (which force-sets PS_WEAPONINDEX unconditionally),
  // q2repro's `flags` word has NO forced bit -- q2repro.c:2015-2071 only
  // ever ORs in a flag when the corresponding delta actually changed.
  // no changes -> flags=0 (u16), extraflags=0 (u8).
  test("no changes: flags/extraflags both 0 (no forced bit, unlike vanilla)", () => {
    const ps = new PlayerStateT();
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, new PlayerStateT(), ps));
    expect(bytes).toEqual([17, 0, 0, 0]);
  });

  // pm_origin change: XY share one flag bit (PS_M_ORIGIN), Z has its own
  // extraflags bit (EPS_M_ORIGIN2) -- q2repro.c:2017-2020. FLOAT PMOVE STATE
  // END TO END: this codec now sources pm_origin/pm_velocity from
  // PmoveStateT's float mirror (originF), matching q2repro.c's own encoding
  // exactly (full IEEE-754 float, no fixed-point stage) -- see q2repro.ts's
  // file header.
  //   flags = PS_M_ORIGIN(BIT(1)=2); extraflags = EPS_M_ORIGIN2(BIT(3)=8)
  //   float32(100)=[0,0,200,66]; float32(-200)=[0,0,72,195]; float32(300)=[0,0,150,67]
  test("pm_origin change: PS_M_ORIGIN (xy) + EPS_M_ORIGIN2 (z) split", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.originF.set([100, -200, 300]);
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 2, 0, 8, 0, 0, 200, 66, 0, 0, 72, 195, 0, 0, 150, 67]);
  });

  // FLOAT PMOVE STATE END TO END (.orch/followups.md): a genuinely
  // sub-1/8-unit-grid origin (x=15.7301, not a multiple of 0.125) must
  // survive an encode/decode round trip WITHOUT snapping to the nearest
  // 0.125 -- the exact residual the old short-domain round trip introduced
  // (round(15.7301*8)/8 = round(125.8408)/8 = 126/8 = 15.75, a visible
  // ~0.02-unit loss that, compounded across a client prediction replay,
  // destroyed PM_StepSlideMove's DIST_EPSILON floor clearance). float32
  // itself is NOT exact for 15.7301 (no binary fraction is), so the
  // assertion is "close to the requested value, not snapped to a 1/8-unit
  // grid point" -- toBeCloseTo at 4 decimal places is well inside float32
  // precision at this magnitude and would fail if the value had been
  // silently rounded to 15.75.
  test("pm_origin: sub-1/8-unit-grid value round-trips at float precision, not snapped to 0.125", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.originF.set([15.7301, -42.0625, 7.11]);
    to.pmove.velocityF.set([3.14159, -0.001, 99.99]);

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1;

    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);

    expect(out.pmove.originF[0]).toBeCloseTo(15.7301, 4);
    expect(out.pmove.originF[1]).toBeCloseTo(-42.0625, 4);
    expect(out.pmove.originF[2]).toBeCloseTo(7.11, 4);
    expect(out.pmove.originF[0]).not.toBe(15.75); // the old requantized value
    expect(out.pmove.velocityF[0]).toBeCloseTo(3.14159, 4);
    expect(out.pmove.velocityF[1]).toBeCloseTo(-0.001, 4);
    expect(out.pmove.velocityF[2]).toBeCloseTo(99.99, 4);
  });

  // gunindex + gunskin packed into one u16: gunindex | (gunskin << 13)
  // (Q2PRO_GUNINDEX_BITS=13, q2repro.c:2141-2147). gunindex=5, gunskin=3 ->
  // 5 | (3<<13) = 5 | 24576 = 24581 = 0x6005 -> LE [5,96].
  //   flags = PS_WEAPONINDEX (BIT(12)=4096=0x1000) -> LE [0,16]
  test("gunindex + gunskin packed into one u16", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunindex = 5;
    to.gunskin = 3;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 16, 0, 5, 96]);
  });

  // PS_RR_VIEWHEIGHT (BIT(15) of `flags`, q2proto_internal_protocol.h:263) --
  // the re-release-only eye-height field. Written as an i8 by
  // q2proto_proto_q2repro.c:2196-2197, at the very end of the playerstate
  // body (after EPS_GUNRATE's gunrate byte, before EPS_CLIENTNUM, which this
  // codec never sets); the flag is chosen at :2033-2034.
  //   flags = 0x8000 -> LE [0,128]; extraflags = 0; then the single i8.
  //
  // This is the wire half of the "player renders permanently crouched"
  // defect: the re-release keeps eye height OUT of viewoffset (q2repro
  // server/entities.c:610-612, "Rerelease game doesn't include viewheight in
  // viewoffset, vanilla does"), so a codec that never sets this bit leaves
  // the client's camera at the player's feet.
  test("PS_RR_VIEWHEIGHT: standing eye height (22) is one i8 after a 0x8000 flags word", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.viewheight = 22;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 128, 0, 22]);
  });

  // The field is SIGNED (READ_CHECKED(..., i8) / WRITE_CHECKED(..., i8)) --
  // p_move.cpp's PM_SetDimensions drives it negative for a dead/gibbed
  // player, so an unsigned read would put the camera 240 units in the air.
  test("PS_RR_VIEWHEIGHT: a negative eye height round-trips as a signed i8", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.viewheight = -16;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 128, 0, 0xf0]); // -16 two's complement

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1; // consume the svc_playerinfo tag
    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.pmove.viewheight).toBe(-16);
  });

  // Delta semantics: an unchanged viewheight sets no bit at all, and the
  // read side inherits it from the `from` baseline (readPlayerStateFields'
  // copy-forward step) rather than resetting it to 0 -- otherwise the camera
  // would drop to the feet on every frame that happened not to change it.
  test("PS_RR_VIEWHEIGHT: unchanged viewheight sets no bit and is inherited from the baseline", () => {
    const from = new PlayerStateT();
    from.pmove.viewheight = 22;
    const to = new PlayerStateT();
    to.pmove.viewheight = 22;
    expect(bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to))).toEqual([17, 0, 0, 0]);

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1;
    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.pmove.viewheight).toBe(22);
  });

  // QUIRK (faithfully reproduced): PS_WEAPONINDEX is gated on Q2P_PSD_GUNINDEX
  // ONLY (q2repro.c:2053 -- `if (delta_bits & Q2P_PSD_GUNINDEX) flags |=
  // PS_WEAPONINDEX;`, no Q2P_PSD_GUNSKIN check anywhere in that function). A
  // gunskin-only change with gunindex unchanged is silently NOT transmitted.
  test("QUIRK: gunskin-only change (gunindex unchanged) is dropped", () => {
    const from = new PlayerStateT();
    from.gunindex = 5;
    const to = new PlayerStateT();
    to.gunindex = 5; // unchanged
    to.gunskin = 7; // changed, but never transmitted without a gunindex change
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 0, 0]);
  });

  // blend + damage_blend share ONE flag bit (PS_BLEND) and one combined
  // bitmask byte: low nibble = blend's 4 changed components, high nibble =
  // damage_blend's (q2repro_internal_io.h:483-497, server_write_q2pro_extv2_blends).
  // to.blend=[1,0,0,0.5] -> byte-encoded [255,0,0,127]; components 0,3 changed
  //   -> blendBits = BIT(0)|BIT(3) = 9
  // to.damage_blend=[0,1,0,0] -> byte-encoded [0,255,0,0]; component 1 changed
  //   -> damageBlendBits = BIT(1) = 2
  //   combined byte = (9&0xf) | ((2&0xf)<<4) = 9 | 32 = 41
  //   then blend[0]=255, blend[3]=127 (trunc(0.5*255)=127), damage_blend[1]=255
  test("blend + damage_blend combined bitmask byte", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.blend.set([1, 0, 0, 0.5]);
    to.damage_blend.set([0, 1, 0, 0]);
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 4, 0, 41, 255, 127, 255]);
  });

  // 64-bit statbits (Q2PROTO_STATS=64, q2proto_proto_q2repro.c:2183-2190:
  // one WRITE_CHECKED(..., u64, statbits) -- a single 8-byte little-endian
  // op, MSG_WriteLong64 here -- then one i16 per set bit, 0..63). stat[0]
  // and stat[31] both changed, both below bit 32, so this byte vector is
  // identical to what a naive low/high-32-bit split would also produce:
  //   statbits = BIT(0)|BIT(31) = 0x0000000080000001n -> LE 8 bytes
  //     [1,0,0,128,0,0,0,0]
  //   extraflags = EPS_STATS (BIT(5)=32)
  //   per-bit i16 values in ascending index order: stats[0]=100 -> [100,0],
  //   stats[31]=7 -> [7,0]
  test("64-bit statbits spanning low and bit-31", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.stats[0] = 100;
    to.stats[31] = 7;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 0, 32, 1, 0, 0, 128, 0, 0, 0, 0, 100, 0, 7, 0]);
  });

  // Widened storage (q_shared.ts's MAX_STATS_STORAGE=64, "wide core" limit
  // lift): stat[32] and stat[63] -- the weapon-wheel/coop-respawn slots past
  // the classic 32-stat boundary -- now round-trip for real, matching
  // q2proto_proto_q2repro.c's single-u64-statbits wire shape exactly
  // (previously the write side hardcoded a second all-zero 32-bit word and
  // the read side discarded it, so nothing past index 31 ever crossed the
  // wire). stat[32]=STAT_WEAPONS_OWNED_1's slot, stat[63]=the top slot:
  //   statbits = BIT(32)|BIT(63) = 0x8000000100000000n -> LE 8 bytes
  //     [0,0,0,0,1,0,0,128]
  //   extraflags = EPS_STATS (32); per-bit i16 values in ascending index
  //   order: stats[32]=1234 -> [210,4], stats[63]=-1 -> [255,255] (i16 -1)
  test("64-bit statbits: high-index stats (32, 63) past the classic 32-stat boundary write and read back", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.stats[32] = 1234;
    to.stats[63] = -1;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 0, 32, 0, 0, 0, 0, 1, 0, 0, 128, 210, 4, 255, 255]);

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1; // consume the svc_playerinfo tag, matching the existing round-trip test's idiom
    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.stats[32]).toBe(1234);
    expect(out.stats[63]).toBe(-1);
    // every classic-range slot (untouched) reads back as the `from` baseline's 0
    expect(out.stats[0]).toBe(0);
    expect(out.stats[31]).toBe(0);
  });

  // gunrate (RERELEASE-only field) -> EPS_GUNRATE (BIT(7)=128), one byte.
  test("gunrate change", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunrate = 30;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([17, 0, 0, 128, 30]);
  });

  // viewoffset/kick_angles/gunoffset/gunangles: each its own fixed-point
  // int16 scale (q2proto_valenc.h:142-174), values chosen as exact multiples
  // of 1/scale so truncation is a no-op:
  //   viewoffset [1,-2,0.5] * 16     = [16,-32,8]     -> PS_VIEWOFFSET(BIT(7)=128)
  //   kick_angles[0.5,-0.25,1]*1024  = [512,-256,1024]-> PS_KICKANGLES(BIT(9)=512)
  //   gunoffset  [1,-1,0.5]*512      = [512,-512,256] -> EPS_GUNOFFSET(BIT(0)=1)
  //   gunangles  [1,-1,0.5]*4096     = [4096,-4096,2048]-> EPS_GUNANGLES(BIT(1)=2)
  //   flags = 128+512 = 640 = 0x280 -> LE [128,2]; extraflags = 1+2 = 3
  //   int16 LE: 16->[16,0]; -32->0xFFE0->[224,255]; 8->[8,0]
  //             512->[0,2]; -256->0xFF00->[0,255]; 1024->[0,4]
  //             512->[0,2]; -512->0xFE00->[0,254]; 256->[0,1]
  //             4096->[0,16]; -4096->0xF000->[0,240]; 2048->[0,8]
  test("viewoffset + kick_angles + gunoffset + gunangles fixed-point encodings", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.viewoffset.set([1, -2, 0.5]);
    to.kick_angles.set([0.5, -0.25, 1]);
    to.gunoffset.set([1, -1, 0.5]);
    to.gunangles.set([1, -1, 0.5]);
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to));
    expect(bytes).toEqual([
      17, 128, 2, 3, 16, 0, 224, 255, 8, 0, 0, 2, 0, 255, 0, 4, 0, 2, 0, 254, 0, 1, 0, 16, 0, 240, 0, 8,
    ]);
  });
});

// =============================================================================
// writeDeltaUsercmd -- q2repro_client_write_move_delta (q2repro.c:1099-1148).
// Bit values/order/widths for angle/forward/side/buttons/impulse/msec/
// lightlevel are IDENTICAL to vanilla's MSG_WriteDeltaUsercmd (q2proto's
// CM_* constants share vanilla's exact bit positions -- q2proto_internal_protocol.h:295-302
// vs qcommon.ts's CM_ANGLE1..CM_IMPULSE). upmove is unrepresentable (see
// q2repro.ts's "KNOWN GAP: usercmd upmove").
// =============================================================================

describe("Q2REPRO_CODEC.writeDeltaUsercmd -- golden bytes", () => {
  test("no change: only bits=0, msec, lightlevel written", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes).toEqual([0, 0, 0]);
  });

  // Byte-identical to VANILLA_CODEC's equivalent case (protocol_golden.test.ts's
  // "angles + forwardmove changed") since 1038's non-batched move-delta shares
  // vanilla's exact bit layout for every field except upmove.
  test("angles + forwardmove changed: byte-identical to VANILLA_CODEC", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.angles.set([100, -200, 300]);
    cmd.forwardmove = 400;
    cmd.msec = 16;
    cmd.lightlevel = 32;
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeDeltaUsercmd(msg, from, cmd));
    expect(bytes).toEqual([15, 100, 0, 56, 255, 44, 1, 144, 1, 16, 32]);
  });

  test("upmove change throws (Q2P_ERR_BAD_DATA in q2repro.c:1112-1113)", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.upmove = 10;
    expect(() => bufOf((msg) => Q2REPRO_CODEC.writeDeltaUsercmd(msg, from, cmd))).toThrow();
  });
});

// =============================================================================
// writeServerData -- q2repro_server_write_serverdata (q2repro.c:1746-1774).
// =============================================================================

describe("Q2REPRO_CODEC.writeServerData -- golden bytes", () => {
  // tag(svc_serverdata=12), protocol(i32 LE 1038=0x040E->[14,4,0,0]),
  // servercount(i32 LE 5->[5,0,0,0]), attractloop(u8 0), gamedir string
  // "baseq2"+NUL (ASCII codes 98,97,115,101,113,50,0), clientnum(i16 LE 0),
  // levelname string "base1"+NUL (98,97,115,101,49,0), protocol_version
  // (u16 LE 0 -- no q2pro extended minor version advertised), q2pro.server_state
  // (u8, ServerStateT.ss_game=2), q2pro_flags (u16 LE 0 -- no q2pro
  // extensions/hacks advertised), server_fps (u8 10 -- BASE_FRAMERATE).
  test("full handshake layout", () => {
    const bytes = bufOf((msg) =>
      Q2REPRO_CODEC.writeServerData(msg, {
        servercount: 5,
        attractloop: false,
        gamedir: "baseq2",
        clientnum: 0,
        levelname: "base1",
        serverState: 2,
      }),
    );
    expect(bytes).toEqual([
      12, 14, 4, 0, 0, 5, 0, 0, 0, 0, 98, 97, 115, 101, 113, 50, 0, 0, 0, 98, 97, 115, 101, 49, 0, 0, 0, 2, 0, 0, 10,
    ]);
  });
});

// =============================================================================
// Read-side round trips (per protocol_golden.test.ts's own stated
// convention: write side is golden-byte-locked, read side is verified by
// round-tripping through the same codec's write ops).
// =============================================================================

describe("Q2REPRO_CODEC read-side round trips", () => {
  test("entity delta: wide entnum + alpha/scale + 16-bit morefx + u32 solid round-trips", () => {
    const from = new EntityStateT();
    from.number = 1023;
    const to = new EntityStateT();
    to.number = 1023;
    to.origin.set([104.25, -32.5, 0.75]);
    to.angles.set([90, -90, 45]);
    to.alpha = 0.5;
    to.scale = 2.0;
    to.morefx = 300;
    to.effects = 0x1234;
    to.solid = 0x00123456; // exercises the u32 (not vanilla's u16) solid write
    to.modelindex = 300; // U_MODEL16

    Q2REPRO_CODEC.writeDeltaEntity(net_message, from, to, true, true);
    MSG_BeginReading(net_message);

    const { number, bits } = Q2REPRO_CODEC.readEntityBits();
    expect(number).toBe(1023);

    const out = new EntityStateT();
    Q2REPRO_CODEC.readDeltaEntity(from, out, number, bits);

    expect(out.number).toBe(1023);
    expect(Array.from(out.origin)).toEqual([104.25, -32.5, 0.75]);
    expect(out.angles[0]).toBeCloseTo(90, 5);
    expect(out.angles[1]).toBeCloseTo(-90, 5);
    expect(out.angles[2]).toBeCloseTo(45, 5);
    // alpha round-trips through a byte (encodeAlpha(0.5) = trunc(0.5*255) =
    // 127, decodeAlpha(127) = 127/255), not exactly 0.5 -- byte quantization
    // is lossy by design (q2proto_valenc.h:124-129).
    expect(out.alpha).toBeCloseTo(127 / 255, 6);
    expect(out.scale).toBe(2.0);
    expect(out.morefx).toBe(300);
    expect(out.effects).toBe(0x1234);
    expect(out.solid).toBe(0x00123456);
    expect(out.modelindex).toBe(300);
  });

  test("entity delta: alpha=0/scale=0 sentinel round-trips as 0, not the encoded byte", () => {
    const from = new EntityStateT();
    from.number = 5;
    from.alpha = 0.5;
    const to = new EntityStateT();
    to.number = 5;
    to.alpha = 0; // explicit reset to the "default" sentinel

    Q2REPRO_CODEC.writeDeltaEntity(net_message, from, to, false, false);
    MSG_BeginReading(net_message);
    const { number, bits } = Q2REPRO_CODEC.readEntityBits();
    const out = new EntityStateT();
    Q2REPRO_CODEC.readDeltaEntity(from, out, number, bits);
    expect(out.alpha).toBe(0);
  });

  test("playerstate delta: pm_origin/velocity xyz + gunskin/gunrate/damage_blend/high-index stats round-trip", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.pm_type = 1;
    // FLOAT PMOVE STATE END TO END: the wire (and this codec's encode/decode)
    // now sources pm_origin/pm_velocity from PmoveStateT's float mirror
    // (originF/velocityF), not the legacy 12.3 Int16 shadow -- see
    // q2repro.ts's own file header. [100,-50,30]/[10,-10,5] are the same
    // world-unit values the old short=[800,-400,240]/[80,-80,40] encoding
    // used to represent.
    to.pmove.originF.set([100, -50, 30]);
    to.pmove.velocityF.set([10, -10, 5]);
    to.pmove.pm_time = 50;
    to.pmove.pm_flags = 2;
    to.pmove.gravity = 800;
    to.pmove.delta_angles.set([1000, 2000, 3000]);
    to.viewangles.set([90, -90, 45]);
    to.gunindex = 5;
    to.gunskin = 3;
    to.gunrate = 30;
    to.damage_blend.set([0.2, 0, 0, 0]);
    to.stats[0] = 100;
    to.stats[31] = 999;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(256), 256);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    // writePlayerStateDelta writes the svc_playerinfo tag itself; consume it
    // the same way the vanilla golden test does before calling the read op.
    msg.readcount = 1;

    const out = new PlayerStateT();
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);

    expect(out.pmove.pm_type).toBe(1);
    expect(Array.from(out.pmove.originF)).toEqual([100, -50, 30]);
    expect(Array.from(out.pmove.velocityF)).toEqual([10, -10, 5]);
    // legacy 12.3 shadow stays in sync too (family-generic consumers, see
    // q2repro.ts's file header).
    expect(Array.from(out.pmove.origin)).toEqual([800, -400, 240]);
    expect(Array.from(out.pmove.velocity)).toEqual([80, -80, 40]);
    expect(out.pmove.pm_time).toBe(50);
    expect(out.pmove.pm_flags).toBe(2);
    expect(out.pmove.gravity).toBe(800);
    expect(Array.from(out.pmove.delta_angles)).toEqual([1000, 2000, 3000]);
    expect(out.gunindex).toBe(5);
    expect(out.gunskin).toBe(3);
    expect(out.gunrate).toBe(30);
    expect(out.damage_blend[0]).toBeCloseTo(0.2, 2);
    expect(out.stats[0]).toBe(100);
    expect(out.stats[31]).toBe(999);
  });

  test("playerstate delta: from-frame values survive when the corresponding flag bit is unset", () => {
    const from = new PlayerStateT();
    from.fov = 77;
    from.gunrate = 12;
    const to = new PlayerStateT();
    to.fov = 77; // unchanged -> PS_FOV not set
    to.gunrate = 12; // unchanged -> EPS_GUNRATE not set

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writePlayerStateDelta(msg, from, to);
    MSG_BeginReading(msg);
    msg.readcount = 1;

    const out = new PlayerStateT();
    out.fov = 0; // sentinel different from both from/to
    out.gunrate = 0;
    Q2REPRO_CODEC.readPlayerStateDelta(msg, from, out);
    expect(out.fov).toBe(77);
    expect(out.gunrate).toBe(12);
  });

  test("usercmd delta: readDeltaUsercmd reconstructs the written command (no upmove)", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.angles.set([100, -200, 300]);
    cmd.forwardmove = 400;
    cmd.sidemove = -50;
    cmd.buttons = 3;
    cmd.impulse = 5;
    cmd.msec = 16;
    cmd.lightlevel = 32;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(64), 64);
    Q2REPRO_CODEC.writeDeltaUsercmd(msg, from, cmd);
    MSG_BeginReading(msg);

    const out = new UsercmdT();
    Q2REPRO_CODEC.readDeltaUsercmd(msg, from, out);
    expect(Array.from(out.angles)).toEqual([100, -200, 300]);
    expect(out.forwardmove).toBe(400);
    expect(out.sidemove).toBe(-50);
    expect(out.upmove).toBe(0);
    expect(out.buttons).toBe(3);
    expect(out.impulse).toBe(5);
    expect(out.msec).toBe(16);
    expect(out.lightlevel).toBe(32);
  });
});
