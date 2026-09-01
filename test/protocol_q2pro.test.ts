// Golden-vector suite for Q2PRO_CODEC (protocol 36 -- v1.0.0 wire cluster,
// task board #23). Bytes hand-derived from ~/Projects/q2proto/src/
// q2proto_proto_q2pro.c (this port's reference implementation); each vector
// cites the exact function/lines it was traced from, matching this port
// line's established convention (test/protocol_frame_envelope.test.ts /
// test/protocol_q2repro.test.ts).
//
// Run alone (per .orch/preferences.md rule 13): `bun test test/protocol_q2pro.test.ts`

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadString } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT, UsercmdT } from "../src/shared/q_shared";
import { SvcOpsT, PROTOCOL_VERSION_Q2PRO, U_EFFECTS16, U_RENDERFX16 } from "../src/qcommon/qcommon";
import { Q2PRO_CODEC, createQ2ProCodec, noteQ2ProFrameOpcodeExtrabits } from "../src/qcommon/protocol/q2pro";
import type { FrameWriteParamsT } from "../src/qcommon/protocol/codec";
import { ClientT, sv, svs } from "../src/server/server";
import { SV_WriteFrameToClient } from "../src/server/sv_ents";
import { UPDATE_MASK } from "../src/qcommon/qcommon";

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
  net_message.data.set(arr);
  net_message.cursize = arr.length;
  MSG_BeginReading(net_message);
}

// Mirrors the real cl_parse.ts dispatch loop's future integration (see
// q2pro.ts's file header "INTEGRATION GAP" note): the raw svc_frame opcode
// byte's top 3 bits must be extracted and handed to the codec BEFORE
// readFrameHeader runs.
function consumeFrameOpcodeAndNoteExtrabits(): void {
  const cmd = MSG_ReadByte(net_message);
  expect(cmd & 0x1f).toBe(SvcOpsT.svc_frame);
  noteQ2ProFrameOpcodeExtrabits(cmd & 0xe0);
}

beforeEach(() => {
  resetNetMessage();
});

function baseEntity(number: number): EntityStateT {
  const e = new EntityStateT();
  e.number = number;
  return e;
}

// =============================================================================
// 1. U_SOLID always u32, unconditionally (q2pro.c:133 `has_solid32 = true`,
//    :1776-1777 write, :555-556 read -- no minor-version gate, unlike R1Q2).
// =============================================================================
describe("entity delta: U_SOLID is always a u32", () => {
  test("write: solid change alone produces bits=U_SOLID (0x08000000) + u32 value", () => {
    const from = baseEntity(3);
    const to = baseEntity(3);
    to.solid = 0x12345678;

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeDeltaEntity(msg, from, to, false, false));

    // bits = U_SOLID (1<<27) only -> needs 4 bytes of bits (MOREBITS1/2/3 all
    // set since bit 27 lives in the 4th byte), then u8 number, then u32 solid.
    expect(bytes.length).toBe(1 + 3 + 1 + 4);
    const solidBytes = bytes.slice(-4);
    const view = new DataView(new Uint8Array(solidBytes).buffer);
    expect(view.getUint32(0, true)).toBe(0x12345678);
  });

  test("round-trip: u32 solid survives write+read (would truncate under vanilla's u16)", () => {
    const from = baseEntity(5);
    const to = baseEntity(5);
    to.solid = 0xabcd1234; // > 0xffff -- a vanilla u16 write would truncate this

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    loadIntoNetMessage(bytes);

    const { number, bits } = Q2PRO_CODEC.readEntityBits();
    const out = new EntityStateT();
    Q2PRO_CODEC.readDeltaEntity(from, out, number, bits);

    // MSG_ReadLong returns a signed i32 (matching this port's existing
    // convention for every other u32-as-i32 field) -- compare as unsigned to
    // check the bit pattern round-tripped, not the JS sign.
    expect(out.solid >>> 0).toBe(0xabcd1234);
  });
});

// =============================================================================
// 2. writeSpawnBaseline: svc_spawnbaseline opcode + forced full delta from a
//    null entity_state_t, using the same u32-solid path as above.
// =============================================================================
describe("writeSpawnBaseline", () => {
  test("leading opcode is svc_spawnbaseline, body round-trips through readDeltaEntity", () => {
    const base = baseEntity(7);
    base.origin.set([32, 0, 0]);
    base.solid = 0x00020202; // a real q2pro packed-bbox-style value

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeSpawnBaseline(msg, base));
    expect(bytes[0]).toBe(SvcOpsT.svc_spawnbaseline);

    loadIntoNetMessage(bytes.slice(1));
    const { number, bits } = Q2PRO_CODEC.readEntityBits();
    const out = new EntityStateT();
    Q2PRO_CODEC.readDeltaEntity(new EntityStateT(), out, number, bits);

    expect(number).toBe(7);
    expect(out.origin[0]).toBeCloseTo(32, 1);
    expect(out.solid).toBe(0x00020202);
  });
});

// =============================================================================
// 3. Frame envelope: opcode-byte extrabits + suppress_count nibble packing
//    (q2pro.c:2138-2176's exact bit math, cited in q2pro.ts's file header).
// =============================================================================
describe("writeFrame: extraflags packed into opcode high bits + suppress nibble", () => {
  function frameParams(psFrom: PlayerStateT | null, psTo: PlayerStateT, framenum: number, lastframe: number): FrameWriteParamsT {
    return { framenum, lastframe, surpressCount: 0, areabits: new Uint8Array(0), areabytes: 0, psFrom, psTo };
  }

  test("no extraflags set -> opcode byte is bare svc_frame, suppress byte's high nibble is 0", () => {
    const ps = new PlayerStateT();
    const bytes = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, frameParams(ps, ps, 10, -1), () => {}));
    expect(bytes[0]).toBe(SvcOpsT.svc_frame);
    // encodedFrame (4 bytes) then suppress byte
    const suppressByte = bytes[5];
    expect(suppressByte & 0xf0).toBe(0);
  });

  test("EPS_STATS set (a stat changed) -> opcode byte low nibble bit lands in suppress_count's high nibble", () => {
    // EPS_STATS = 1<<5 -- bits 4-6 of extraflags ride the opcode
    // (extrabits = (extraflags & 0x70) << 1), bits 0-3 ride the suppress
    // nibble. EPS_STATS's bit (5) is in the 4-6 range -> opcode byte only.
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.stats[2] = 99;

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, frameParams(from, to, 1, -1), () => {}));
    // extraflags = EPS_STATS = 0x20. extrabits = (0x20 & 0x70) << 1 = 0x40.
    expect(bytes[0]).toBe(SvcOpsT.svc_frame | 0x40);
    const suppressByte = bytes[5];
    expect(suppressByte & 0xf0).toBe(0); // EPS_STATS's bit is not in the low nibble
  });

  test("EPS_GUNOFFSET set (bit0) -> lands in suppress_count's high nibble, not the opcode", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunoffset.set([1, 0, 0]);

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, frameParams(from, to, 1, -1), () => {}));
    // extraflags = EPS_GUNOFFSET = 0x01. extrabits = (0x01 & 0x70) << 1 = 0.
    expect(bytes[0]).toBe(SvcOpsT.svc_frame);
    const suppressByte = bytes[5];
    expect((suppressByte & 0xf0) >> 4).toBe(0x01);
  });

  test("no-delta sentinel: deltaframe=-1 encodes as top-5-bits=31", () => {
    const ps = new PlayerStateT();
    const bytes = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, frameParams(ps, ps, 100, -1), () => {}));
    const encodedFrame = new DataView(new Uint8Array(bytes.slice(1, 5)).buffer).getInt32(0, true);
    expect(encodedFrame >>> 27).toBe(31);
    expect(encodedFrame & 0x07ffffff).toBe(100);
  });

  test("round-trip: readFrameHeader recovers serverframe/deltaframe through the real dispatch-loop opcode step", () => {
    const ps = new PlayerStateT();
    const bytes = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, frameParams(ps, ps, 55, 50), () => {}));

    loadIntoNetMessage(bytes);
    consumeFrameOpcodeAndNoteExtrabits();
    const header = Q2PRO_CODEC.readFrameHeader(new Uint8Array(32), false);

    expect(header.serverframe).toBe(55);
    expect(header.deltaframe).toBe(50);
  });
});

// =============================================================================
// 4. EPS_M_ORIGIN2/EPS_M_VELOCITY2/EPS_VIEWANGLE2: independent Z-axis reads a
//    vanilla playerstate delta structurally cannot produce (vanilla always
//    reads/writes all 3 origin/velocity/viewangle components together).
// =============================================================================
describe("playerstate delta: independent Z-axis extraflags", () => {
  function roundTrip(from: PlayerStateT, to: PlayerStateT): PlayerStateT {
    const bytes = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, { framenum: 1, lastframe: -1, surpressCount: 0, areabits: new Uint8Array(0), areabytes: 0, psFrom: from, psTo: to }, () => {}));
    loadIntoNetMessage(bytes);
    consumeFrameOpcodeAndNoteExtrabits();
    Q2PRO_CODEC.readFrameHeader(new Uint8Array(32), false);
    const out = new PlayerStateT();
    Q2PRO_CODEC.readFramePlayerstate(from, out);
    return out;
  }

  test("Z-only origin change: PS_M_ORIGIN clear, EPS_M_ORIGIN2 carries just origin[2]", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.origin[2] = 500;

    const out = roundTrip(from, to);
    expect(out.pmove.origin[0]).toBe(0);
    expect(out.pmove.origin[1]).toBe(0);
    expect(out.pmove.origin[2]).toBe(500);
  });

  test("Z-only velocity change round-trips independently of X/Y", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.velocity[2] = -77;

    const out = roundTrip(from, to);
    expect(out.pmove.velocity[2]).toBe(-77);
    expect(out.pmove.velocity[0]).toBe(0);
  });

  test("EPS_STATS opt-in: no stat changes -> zero stats bytes on the wire (unlike vanilla's unconditional 4-byte statbits)", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    // nothing changed at all
    const enc = bufOf((msg) => Q2PRO_CODEC.writeFrame(msg, { framenum: 1, lastframe: -1, surpressCount: 0, areabits: new Uint8Array(0), areabytes: 0, psFrom: from, psTo: to }, () => {}));
    // opcode(1) + encodedFrame(4) + suppress(1) + areabytes(1) + flags(2) +
    // gunindex(1, PS_WEAPONINDEX is forced unconditionally -- vanilla quirk
    // preserved, see encodePlayerStateDelta's own comment) == 10 bytes, no
    // EPS_STATS bytes at all.
    expect(enc.length).toBe(10);
  });

  test("EPS_STATS set when a stat changes: statbits + one i16 value present", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.stats[4] = 42;

    const out = roundTrip(from, to);
    expect(out.stats[4]).toBe(42);
  });

  test("EPS_GUNOFFSET/EPS_GUNANGLES decoupled from PS_WEAPONFRAME: gunframe unchanged, gunoffset changed", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunoffset.set([2, 0, 0]);
    // gunframe deliberately left equal to `from`'s (0) -- PS_WEAPONFRAME
    // must NOT be set, yet gunoffset must still travel (a vanilla stream
    // can never produce this: vanilla bundles gunoffset under PS_WEAPONFRAME).

    const out = roundTrip(from, to);
    expect(out.gunoffset[0]).toBeCloseTo(2, 1);
    expect(out.gunframe).toBe(0);
  });
});

// =============================================================================
// 5. clc_move: byte-identical to vanilla's MSG_WriteDeltaUsercmd/
//    MSG_ReadDeltaUsercmd (q2pro.c:1061-1108 -- no DBLFORWARD/DBL_ANGLE1
//    byte-shortening, confirmed absent from Q2PRO's plain-tier move write).
// =============================================================================
describe("clc_move: identical shape to vanilla, no byte-shortening", () => {
  test("round-trip preserves forwardmove/angles/buttons exactly", () => {
    const from = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.forwardmove = 400;
    cmd.angles[0] = 12345;
    cmd.buttons = 1;
    cmd.msec = 16;

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeDeltaUsercmd(msg, from, cmd));
    loadIntoNetMessage(bytes);
    const out = new UsercmdT();
    Q2PRO_CODEC.readDeltaUsercmd(net_message, from, out);

    expect(out.forwardmove).toBe(400);
    expect(out.angles[0]).toBe(12345);
    expect(out.buttons).toBe(1);
    expect(out.msec).toBe(16);
  });
});

// =============================================================================
// 6. serverdata handshake: q2proto_q2pro_continue_serverdata's field order
//    for protocol_version < EXTENDED_LIMITS(1024) -- three separate bool
//    bytes, not the single q2pro_flags word (out of this port's scope).
// =============================================================================
describe("writeServerData / readServerData", () => {
  test("field order: protocol_version(u16), server_state(u8), strafejump/qw/waterjump (u8 each)", () => {
    const bytes = bufOf((msg) =>
      Q2PRO_CODEC.writeServerData(msg, {
        servercount: 5,
        attractloop: false,
        gamedir: "",
        clientnum: 0,
        levelname: "",
        serverState: 3,
        q2proVersion: 1017,
        q2proStrafejumpHack: true,
        q2proQwMode: false,
        q2proWaterjumpHack: true,
      }),
    );

    loadIntoNetMessage(bytes);
    expect(MSG_ReadByte(net_message)).toBe(SvcOpsT.svc_serverdata);
    expect(MSG_ReadLong(net_message)).toBe(PROTOCOL_VERSION_Q2PRO);
    expect(MSG_ReadLong(net_message)).toBe(5); // servercount
    expect(MSG_ReadByte(net_message)).toBe(0); // attractloop
    expect(MSG_ReadString(net_message)).toBe(""); // gamedir
    expect(MSG_ReadShort(net_message)).toBe(0); // clientnum
    expect(MSG_ReadString(net_message)).toBe(""); // levelname
    expect(MSG_ReadShort(net_message)).toBe(1017); // q2pro minor version
    expect(MSG_ReadByte(net_message)).toBe(3); // server_state
    expect(MSG_ReadByte(net_message)).toBe(1); // strafejump_hack
    expect(MSG_ReadByte(net_message)).toBe(0); // qw_mode
    expect(MSG_ReadByte(net_message)).toBe(1); // waterjump_hack
  });

  test("round-trip via createQ2ProCodec's closure-bound minor version default", () => {
    const codec = createQ2ProCodec(1019);
    const bytes = bufOf((msg) =>
      codec.writeServerData(msg, {
        servercount: 1,
        attractloop: true,
        gamedir: "xatrix",
        clientnum: 2,
        levelname: "base1",
        serverState: 0,
      }),
    );
    loadIntoNetMessage(bytes);
    MSG_ReadByte(net_message); // opcode
    MSG_ReadLong(net_message); // protocol number
    const sd = codec.readServerData();
    expect(sd.servercount).toBe(1);
    expect(sd.gamedir).toBe("xatrix");
    expect(sd.q2proVersion).toBe(1019); // no explicit q2proVersion param -- falls back to the codec's closure default
  });
});

// =============================================================================
// 7. E2E: the real src/server/sv_ents.ts SV_WriteFrameToClient +
//    SV_EmitPacketEntities pipeline with client.codec = Q2PRO_CODEC, mirroring
//    test/protocol_frame_envelope.test.ts's own E2E section for Q2REPRO_CODEC.
// =============================================================================
describe("SV_WriteFrameToClient E2E with client.codec = Q2PRO_CODEC", () => {
  test("nodelta frame with one baseline-diverging entity produces a Q2PRO envelope that round-trips", () => {
    const savedNumClientEntities = svs.num_client_entities;
    const savedClientEntities = svs.client_entities;
    const savedFramenum = sv.framenum;
    try {
      svs.num_client_entities = 4;
      svs.client_entities = Array.from({ length: 4 }, () => new EntityStateT());

      const client = new ClientT();
      client.codec = Q2PRO_CODEC;

      sv.framenum = 1;
      const frame = client.frames[sv.framenum & UPDATE_MASK];
      frame.ps = new PlayerStateT();
      frame.ps.pmove.origin.set([64, 0, 0]);
      frame.areabytes = 0;
      frame.num_entities = 1;
      frame.first_entity = 0;

      const ent = new EntityStateT();
      ent.number = 9;
      ent.origin.set([8, 0, 0]);
      ent.solid = 0xff00ff; // exercises the u32 solid path end to end
      svs.client_entities[0] = ent;
      sv.baselines[9] = new EntityStateT();
      sv.baselines[9].number = 9;

      const msg = new SizeBuf();
      SZ_Init(msg, new Uint8Array(4096), 4096);
      SV_WriteFrameToClient(client, msg);

      loadIntoNetMessage(Array.from(msg.data.subarray(0, msg.cursize)));
      consumeFrameOpcodeAndNoteExtrabits();
      const header = Q2PRO_CODEC.readFrameHeader(new Uint8Array(32), false);
      expect(header.serverframe).toBe(1);
      expect(header.deltaframe).toBe(-1);

      const outPs = new PlayerStateT();
      Q2PRO_CODEC.readFramePlayerstate(new PlayerStateT(), outPs);
      expect(outPs.pmove.origin[0]).toBe(64);

      Q2PRO_CODEC.readPacketEntitiesBegin(); // no-op, but must not throw / consume a byte
      const { number, bits } = Q2PRO_CODEC.readEntityBits();
      expect(number).toBe(9);
      const outEnt = new EntityStateT();
      Q2PRO_CODEC.readDeltaEntity(sv.baselines[9], outEnt, number, bits);
      expect(outEnt.origin[0]).toBeCloseTo(8, 1);
      expect(outEnt.solid).toBe(0xff00ff);
    } finally {
      svs.num_client_entities = savedNumClientEntities;
      svs.client_entities = savedClientEntities;
      sv.framenum = savedFramenum;
    }
  });
});

// =============================================================================
// Rule-17 UB re-audit: readDeltaEntity's frame/skinnum/effects/renderfx 16-bit
// -only reads used a signed MSG_ReadShort, sign-extending any wire value
// >= 0x8000 into a negative number. q2proto_proto_q2pro.c reads all four as
// `u16` for the 16-bit-only path (lines 446-447 frame, 451-453 skinnum,
// 460-462 effects, 469-471 renderfx) -- unlike vanilla.c/r1q2.c, which keep
// vanilla's own original signed-short bug (uint16_safe=false in q2proto's
// shared choose_width_flags helper); q2pro.c passes uint16_safe=true for
// skinnum/effects/renderfx (q2proto_proto_q2pro.c:1596-1617), and frame has
// no 32-bit escape hatch at all in any of these protocols, so a real q2pro
// peer (or this port's own encoder above, for skinnum/frame specifically)
// can legitimately put a value >= 0x8000 on the wire.
// =============================================================================
describe("entity delta: frame/skinnum/effects/renderfx 16-bit reads are unsigned", () => {
  test("frame: a value >= 0x8000 round-trips through this port's own encoder as positive, not sign-extended", () => {
    const from = baseEntity(2);
    const to = baseEntity(2);
    to.frame = 0x9c40; // no 32-bit fallback exists for frame -- always U_FRAME16 above 255

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    loadIntoNetMessage(bytes);

    const { number, bits } = Q2PRO_CODEC.readEntityBits();
    const out = new EntityStateT();
    Q2PRO_CODEC.readDeltaEntity(from, out, number, bits);

    expect(out.frame).toBe(0x9c40);
  });

  test("skinnum: a value in [0x8000, 0x10000) round-trips through this port's own encoder as positive, not sign-extended", () => {
    const from = baseEntity(2);
    const to = baseEntity(2);
    to.skinnum = 0xabcd; // this port's own U_SKIN16 gate is < 0x10000, matching real q2pro

    const bytes = bufOf((msg) => Q2PRO_CODEC.writeDeltaEntity(msg, from, to, false, false));
    loadIntoNetMessage(bytes);

    const { number, bits } = Q2PRO_CODEC.readEntityBits();
    const out = new EntityStateT();
    Q2PRO_CODEC.readDeltaEntity(from, out, number, bits);

    expect(out.skinnum).toBe(0xabcd);
  });

  // effects/renderfx: this port's own encoder is conservative (gates the
  // 16-bit-only path at < 0x8000, matching vanilla/r1q2 rather than real
  // q2pro's < 0x10000 -- a documented, benign divergence since both ends of
  // THIS port's own round trip agree; not touched here, see q2pro.ts's own
  // encoder comment). A real q2pro peer can still send U_EFFECTS16/
  // U_RENDERFX16 alone for a value >= 0x8000, so the read side is tested
  // directly against hand-built bits instead of this port's own encoder.
  test("effects: U_EFFECTS16 alone with a wire value >= 0x8000 reads as unsigned", () => {
    loadIntoNetMessage([0x40, 0x9c]); // 0x9c40, little-endian u16
    const from = baseEntity(2);
    const out = new EntityStateT();
    Q2PRO_CODEC.readDeltaEntity(from, out, 2, U_EFFECTS16);
    expect(out.effects).toBe(0x9c40);
  });

  test("renderfx: U_RENDERFX16 alone with a wire value >= 0x8000 reads as unsigned", () => {
    loadIntoNetMessage([0xff, 0xff]); // 0xffff, little-endian u16
    const from = baseEntity(2);
    const out = new EntityStateT();
    Q2PRO_CODEC.readDeltaEntity(from, out, 2, U_RENDERFX16);
    expect(out.renderfx).toBe(0xffff);
  });
});
