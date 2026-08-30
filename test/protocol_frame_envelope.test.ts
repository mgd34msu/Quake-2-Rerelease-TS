// Frame-envelope gate for the protocol codec seam (ARCHITECTURE.md "Protocol
// layer" / .orch/phase5-design.md phase 5 follow-up unit -- completes the
// "1038 wire interop" work src/qcommon/protocol/q2repro.ts's file header
// used to flag as "KNOWN GAP: frame envelope").
//
// Three kinds of coverage, matching this codebase's established convention
// (test/protocol_golden.test.ts / test/protocol_q2repro.test.ts's own stated
// splits):
//
//   1. VANILLA_CODEC.writeFrame byte-identity: preferences.md rule 15 bans
//      git stash/reset/checkout on the shared tree, so this does NOT use
//      protocol_golden.test.ts's git-stash-capture method. Instead it reads
//      the pre-refactor source directly via `git show HEAD:src/server/
//      sv_ents.ts` (the read-only alternative preferences.md rule 15 itself
//      names), confirms it verbatim (done once, by hand, before writing this
//      file -- the transcript is quoted in `referenceWriteFrame`'s comment
//      below), and asserts VANILLA_CODEC.writeFrame produces byte-identical
//      output to that transcribed reference across several fixtures
//      (no-delta/delta, with/without entities, with a remove). The entities
//      portion needs no separate re-verification: SV_EmitPacketEntities's
//      diff loop is untouched by this unit (only its leading opcode moved
//      from an inline `MSG_WriteByte(msg, SvcOpsT.svc_packetentities)` to
//      `svs.codec.writePacketEntitiesBegin(msg)`, which VANILLA_CODEC
//      implements as that exact same instruction).
//
//   2. Q2REPRO_CODEC envelope structure: byte arrays hand-derived from
//      q2proto_proto_q2repro.c:2206-2242 (q2repro_server_write_frame) and
//      :2006-2065 (q2repro_server_write_playerstate's bit computation),
//      each with its derivation shown in a comment, matching
//      protocol_q2repro.test.ts's own stated hand-derivation convention.
//
//   3 & 4. Round-trip coverage: write via Q2REPRO_CODEC, read back via
//      Q2REPRO_CODEC, assert field equality (protocol_golden.test.ts's
//      stated read-side convention) -- both at the codec-primitive level and
//      through the real src/server/sv_ents.ts SV_WriteFrameToClient/
//      SV_EmitPacketEntities pipeline with a fabricated ClientT (no PVS/BSP
//      needed: SV_WriteFrameToClient/SV_EmitPacketEntities only ever touch
//      client.frames/svs.client_entities/sv.baselines/svs.codec, none of
//      which requires a loaded map -- SV_BuildClientFrame's PVS work is
//      deliberately bypassed by hand-populating the ClientFrameT it would
//      otherwise produce).

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_BeginReading, MSG_WriteByte, MSG_WriteLong, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { SvcOpsT, U_REMOVE, UPDATE_MASK } from "../src/qcommon/qcommon";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import type { FrameWriteParamsT } from "../src/qcommon/protocol/codec";
import { ClientT, sv, svs } from "../src/server/server";
import { SV_WriteFrameToClient } from "../src/server/sv_ents";

function bufOf(fn: (msg: SizeBuf) => void): number[] {
  const msg = new SizeBuf();
  SZ_Init(msg, new Uint8Array(4096), 4096);
  fn(msg);
  return Array.from(msg.data.subarray(0, msg.cursize));
}

function newMsg(): SizeBuf {
  const msg = new SizeBuf();
  SZ_Init(msg, new Uint8Array(4096), 4096);
  return msg;
}

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

// Loads a captured byte array into the net_message singleton for reading,
// the way a real received UDP packet would land there (net_chan.ts owns the
// singleton; this just appends then rewinds the read cursor).
function loadIntoNetMessage(bytes: number[] | Uint8Array): void {
  SZ_Clear(net_message);
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  SZ_Write(net_message, arr, arr.length);
  MSG_BeginReading(net_message);
}

// The svc_frame opcode byte writeFrame writes as its first byte is consumed
// by the OUTER dispatch loop in real usage (cl_parse.ts's
// CL_ParseServerMessage: `const cmd = MSG_ReadByte(net_message); ... case
// SvcOpsT.svc_frame: CL_ParseFrame();`), not by readFrameHeader itself --
// readFrameHeader only ever runs after that byte is already gone. Tests
// calling readFrameHeader directly against a writeFrame-produced buffer must
// discard it themselves first.
function discardOpcode(): void {
  MSG_ReadByte(net_message);
}

beforeEach(() => {
  resetNetMessage();
});

// =============================================================================
// 1. VANILLA_CODEC.writeFrame -- byte-identity vs. the pre-refactor source
// =============================================================================
//
// Transcribed verbatim from `git show HEAD:src/server/sv_ents.ts` (run
// before this refactor's edits landed on top of it -- confirmed by hand,
// preferences.md rule 15's read-only alternative to git stash):
//
//   MSG_WriteByte(msg, SvcOpsT.svc_frame);
//   MSG_WriteLong(msg, sv.framenum);
//   MSG_WriteLong(msg, lastframe);
//   MSG_WriteByte(msg, client.surpressCount);
//   MSG_WriteByte(msg, frame.areabytes);
//   SZ_Write(msg, frame.areabits, frame.areabytes);
//   SV_WritePlayerstateToClient(oldframe, frame, msg); // = svs.codec.writePlayerStateDelta(msg, from ? from.ps : new PlayerStateT(), to.ps)
//   SV_EmitPacketEntities(oldframe, frame, msg); // unchanged diff loop, see file header
//
// `referenceWriteFrame` below reproduces exactly this sequence, taking the
// same FrameWriteParamsT shape SV_WriteFrameToClient now builds, so the only
// thing this test isolates is "did extracting this into VANILLA_CODEC.writeFrame
// change a single byte" -- it does not re-prove writePlayerStateDelta or the
// entity ops, which are unchanged and already golden-tested elsewhere.
function referenceWriteFrame(msg: SizeBuf, params: FrameWriteParamsT, writeEntities: (msg: SizeBuf) => void): void {
  MSG_WriteByte(msg, SvcOpsT.svc_frame);
  MSG_WriteLong(msg, params.framenum);
  MSG_WriteLong(msg, params.lastframe);
  MSG_WriteByte(msg, params.surpressCount);
  MSG_WriteByte(msg, params.areabytes);
  SZ_Write(msg, params.areabits, params.areabytes);
  VANILLA_CODEC.writePlayerStateDelta(msg, params.psFrom ?? new PlayerStateT(), params.psTo);
  writeEntities(msg);
}

describe("VANILLA_CODEC.writeFrame -- byte-identity vs. pre-refactor sv_ents.ts (git show HEAD, not git stash -- preferences.md rule 15)", () => {
  function noEntities(msg: SizeBuf): void {
    VANILLA_CODEC.writePacketEntitiesBegin(msg);
    VANILLA_CODEC.writePacketEntitiesEnd(msg);
  }

  test("no delta, no playerstate change, no entities", () => {
    const params: FrameWriteParamsT = {
      framenum: 42,
      lastframe: -1,
      surpressCount: 0,
      areabits: new Uint8Array(0),
      areabytes: 0,
      psFrom: null,
      psTo: new PlayerStateT(),
    };
    const expected = bufOf((msg) => referenceWriteFrame(msg, params, noEntities));
    const actual = bufOf((msg) => VANILLA_CODEC.writeFrame(msg, params, noEntities));
    expect(actual).toEqual(expected);
  });

  test("delta frame, surpressCount set, non-empty areabits, playerstate change", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.gunframe = 12; // PS_WEAPONFRAME
    to.viewangles.set([10, 20, 30]);
    const params: FrameWriteParamsT = {
      framenum: 500,
      lastframe: 480,
      surpressCount: 3,
      areabits: new Uint8Array([0xaa, 0x55, 0x0f]),
      areabytes: 3,
      psFrom: from,
      psTo: to,
    };
    const expected = bufOf((msg) => referenceWriteFrame(msg, params, noEntities));
    const actual = bufOf((msg) => VANILLA_CODEC.writeFrame(msg, params, noEntities));
    expect(actual).toEqual(expected);
  });

  test("with entities: a delta-updated entity plus a remove, through the real entity ops", () => {
    const fromEnt = new EntityStateT();
    fromEnt.number = 3;
    const toEnt = new EntityStateT();
    toEnt.number = 3;
    toEnt.origin.set([64, 0, 0]);

    function withEntities(msg: SizeBuf): void {
      VANILLA_CODEC.writePacketEntitiesBegin(msg);
      VANILLA_CODEC.writeDeltaEntity(msg, fromEnt, toEnt, false, false);
      VANILLA_CODEC.writeEntityRemove(msg, 9);
      VANILLA_CODEC.writePacketEntitiesEnd(msg);
    }

    const params: FrameWriteParamsT = {
      framenum: 7,
      lastframe: -1,
      surpressCount: 0,
      areabits: new Uint8Array(0),
      areabytes: 0,
      psFrom: null,
      psTo: new PlayerStateT(),
    };
    const expected = bufOf((msg) => referenceWriteFrame(msg, params, withEntities));
    const actual = bufOf((msg) => VANILLA_CODEC.writeFrame(msg, params, withEntities));
    expect(actual).toEqual(expected);
  });
});

// =============================================================================
// 2. Q2REPRO_CODEC envelope structure -- hand-derived from
//    q2proto_proto_q2repro.c:2206-2242 (q2repro_server_write_frame) and
//    :2006-2065 (extraflags/flags bit computation).
// =============================================================================

describe("Q2REPRO_CODEC.writeFrame -- 1038 envelope structure (q2proto_proto_q2repro.c:2206-2242)", () => {
  // framenum & 0x07FFFFFF stays as-is; deltaframe===-1 -> offset=31 (the
  // "special case", q2repro.c:2210-2213), packed into the top 5 bits:
  // (100 & 0x07FFFFFF) | (31 << 27) = 100 | 0xF8000000 = 0xF80000064 truncated
  // to int32 -> little-endian bytes [100, 0, 0, 0xF8].
  test("no-delta frame: offset=31 sentinel, empty areabits/playerstate/entities", () => {
    const params: FrameWriteParamsT = {
      framenum: 100,
      lastframe: -1,
      surpressCount: 0,
      areabits: new Uint8Array(0),
      areabytes: 0,
      psFrom: null,
      psTo: new PlayerStateT(),
    };
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeFrame(msg, params, (m) => Q2REPRO_CODEC.writePacketEntitiesEnd(m)));
    expect(bytes).toEqual([
      SvcOpsT.svc_frame,
      100,
      0,
      0,
      0xf8, // encodedFrame, offset=31 special case
      0, // q2pro_frame_flags: surpressCount=0 -> no FF_SUPPRESSED
      0, // extraflags: no playerstate change
      0, // areabytes
      0,
      0, // playerstate flags(u16)=0 (no fields follow)
      0,
      0, // packetentities terminator (bits=0, entnum=0) -- no leading opcode (1038 has none)
    ]);
  });

  // deltaframe=90, framenum=100 -> offset = 100-90 = 10 -> (100 & 0x07FFFFFF)
  // | (10 << 27) = 100 | 0x50000000 -> LE bytes [100, 0, 0, 0x50].
  // surpressCount=5 (nonzero) -> FF_SUPPRESSED (qsrc/q2repro/inc/common/
  // protocol.h:468) set in q2pro_frame_flags. PS_M_TIME (1<<3=8,
  // qcommon.ts) is the only playerstate change -> flags=8, no extraflags.
  // Entities: one U_REMOVE marker for entnum 5 (q2repro.c:2244-2260 -- no
  // opcode boundary at all, straight into the entity-bits stream).
  test("delta frame with suppress flag, areabits payload, a playerstate field, and a remove", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.pmove.pm_time = 999;

    const params: FrameWriteParamsT = {
      framenum: 100,
      lastframe: 90,
      surpressCount: 5,
      areabits: new Uint8Array([0xaa, 0xbb]),
      areabytes: 2,
      psFrom: from,
      psTo: to,
    };
    const bytes = bufOf((msg) =>
      Q2REPRO_CODEC.writeFrame(msg, params, (m) => {
        Q2REPRO_CODEC.writeEntityRemove(m, 5);
        Q2REPRO_CODEC.writePacketEntitiesEnd(m);
      }),
    );
    expect(bytes).toEqual([
      SvcOpsT.svc_frame,
      100,
      0,
      0,
      0x50, // encodedFrame, offset=10
      1, // q2pro_frame_flags: FF_SUPPRESSED (surpressCount!==0)
      0, // extraflags: no EPS_* bits touched by a pm_time-only change
      2, // areabytes
      0xaa,
      0xbb, // areabits payload
      8,
      0, // playerstate flags(u16) = PS_M_TIME (1<<3)
      231,
      3, // pm_time=999 as u16 LE (999 = 0x03E7)
      64,
      5, // writeEntityRemove(5): bits=U_REMOVE(1<<6=64), entnum=5 (both < 256, 1 byte each)
      0,
      0, // terminator
    ]);
  });

  // Proves the DISTINCTIVE 1038 property this whole unit is about: the
  // extraflags byte sits at wire position 6 (right after q2pro_frame_flags,
  // BEFORE areabits/areabytes at position 7) -- q2repro.c:2219-2221's
  // q2protoio_write_reserve_raw call, patched by q2repro_server_write_playerstate
  // (q2repro.c:2010-2011,2035 `*extraflags |= EPS_VIEWANGLE2`) -- NOT
  // adjacent to `flags` the way the standalone svc_playerinfo message
  // (writePlayerStateDelta) places it. EPS_VIEWANGLE2 = 1<<4 = 16
  // (q2proto_internal_protocol.h:270-280, mirrored in q2repro.ts's local
  // EPS_VIEWANGLE2 const). viewangles Z-only change (90 degrees) ->
  // ANGLE2SHORT(90) = trunc(90*65536/360) = 16384 = 0x4000 -> LE [0, 64].
  test("extraflags-only playerstate change lands the extraflags byte BEFORE areabits, not after flags", () => {
    const from = new PlayerStateT();
    const to = new PlayerStateT();
    to.viewangles.set([0, 0, 90]); // Z-only -> EPS_VIEWANGLE2, not PS_VIEWANGLES

    const params: FrameWriteParamsT = {
      framenum: 1,
      lastframe: -1,
      surpressCount: 0,
      areabits: new Uint8Array(0),
      areabytes: 0,
      psFrom: from,
      psTo: to,
    };
    const bytes = bufOf((msg) => Q2REPRO_CODEC.writeFrame(msg, params, (m) => Q2REPRO_CODEC.writePacketEntitiesEnd(m)));
    expect(bytes).toEqual([
      SvcOpsT.svc_frame,
      1,
      0,
      0,
      0xf8, // encodedFrame, offset=31
      0, // frame_flags
      16, // extraflags = EPS_VIEWANGLE2, at index 6 -- BEFORE areabytes
      0, // areabytes, at index 7
      0,
      0, // playerstate flags(u16) = 0 -- PS_VIEWANGLES was NOT set
      0,
      64, // EPS_VIEWANGLE2's short field (ANGLE2SHORT(90)=16384), written after areabits
      0,
      0, // terminator
    ]);
    // The critical assertion, spelled out: extraflags is NOT adjacent to
    // `flags` (which would be the standalone-message shape) -- areabytes(0)
    // sits between them.
    expect(bytes[6]).toBe(16);
    expect(bytes[7]).toBe(0); // areabytes
    expect(bytes[8]).toBe(0); // flags low byte -- three bytes after extraflags, not one
  });
});

// =============================================================================
// 3. Round trip at the codec-primitive level: write via Q2REPRO_CODEC.writeFrame,
//    read back via readFrameHeader/readFramePlayerstate/readPacketEntitiesBegin
//    + the existing readEntityBits/readDeltaEntity loop, assert field equality
//    (protocol_golden.test.ts's stated read-side convention).
// =============================================================================

describe("Q2REPRO_CODEC frame envelope round trip", () => {
  test("delta frame: playerstate fields + a delta-updated entity + a removed entity round-trip", () => {
    const psFrom = new PlayerStateT();
    const psTo = new PlayerStateT();
    psTo.pmove.pm_type = 1;
    psTo.pmove.origin.set([800, -400, 240]); // -> float [100,-50,30], exact (protocol_q2repro.test.ts's own fixture)
    psTo.pmove.velocity.set([80, -80, 40]);
    psTo.gunindex = 5;
    psTo.gunskin = 3;

    const entFrom = new EntityStateT();
    entFrom.number = 3;
    const entTo = new EntityStateT();
    entTo.number = 3;
    entTo.origin.set([16, 32, 48]);
    entTo.modelindex = 42;

    const params: FrameWriteParamsT = {
      framenum: 250,
      lastframe: 240,
      surpressCount: 0,
      areabits: new Uint8Array([0x12, 0x34]),
      areabytes: 2,
      psFrom,
      psTo,
    };

    Q2REPRO_CODEC.writeFrame(net_message, params, (m) => {
      Q2REPRO_CODEC.writeDeltaEntity(m, entFrom, entTo, false, false);
      Q2REPRO_CODEC.writeEntityRemove(m, 9);
      Q2REPRO_CODEC.writePacketEntitiesEnd(m);
    });
    MSG_BeginReading(net_message);
    discardOpcode();

    const areabitsOut = new Uint8Array(32);
    const header = Q2REPRO_CODEC.readFrameHeader(areabitsOut, true);
    expect(header.serverframe).toBe(250);
    expect(header.deltaframe).toBe(240); // offset=10, reconstructed exactly
    expect(header.surpressCount).toBe(0);
    expect(Array.from(areabitsOut.subarray(0, 2))).toEqual([0x12, 0x34]);

    const psOut = new PlayerStateT();
    Q2REPRO_CODEC.readFramePlayerstate(psFrom, psOut);
    expect(psOut.pmove.pm_type).toBe(1);
    expect(Array.from(psOut.pmove.origin)).toEqual([800, -400, 240]);
    expect(Array.from(psOut.pmove.velocity)).toEqual([80, -80, 40]);
    expect(psOut.gunindex).toBe(5);
    expect(psOut.gunskin).toBe(3);

    Q2REPRO_CODEC.readPacketEntitiesBegin(); // no-op for 1038; must not throw or consume bytes

    const first = Q2REPRO_CODEC.readEntityBits();
    expect(first.number).toBe(3);
    const entOut = new EntityStateT();
    Q2REPRO_CODEC.readDeltaEntity(entFrom, entOut, first.number, first.bits);
    expect(Array.from(entOut.origin)).toEqual([16, 32, 48]);
    expect(entOut.modelindex).toBe(42);

    const second = Q2REPRO_CODEC.readEntityBits();
    expect(second.number).toBe(9);
    expect((second.bits & U_REMOVE) !== 0).toBe(true);

    const terminator = Q2REPRO_CODEC.readEntityBits();
    expect(terminator.number).toBe(0);
  });

  test("no-delta frame: readFrameHeader reconstructs deltaframe=-1 from the offset=31 sentinel", () => {
    const params: FrameWriteParamsT = {
      framenum: 5,
      lastframe: -1,
      surpressCount: 0,
      areabits: new Uint8Array(0),
      areabytes: 0,
      psFrom: null,
      psTo: new PlayerStateT(),
    };
    Q2REPRO_CODEC.writeFrame(net_message, params, (m) => Q2REPRO_CODEC.writePacketEntitiesEnd(m));
    MSG_BeginReading(net_message);
    discardOpcode();

    const header = Q2REPRO_CODEC.readFrameHeader(new Uint8Array(32), true);
    expect(header.serverframe).toBe(5);
    expect(header.deltaframe).toBe(-1);
  });
});

// =============================================================================
// 4. E2E integration: the real src/server/sv_ents.ts SV_WriteFrameToClient +
//    SV_EmitPacketEntities pipeline, with svs.codec swapped to Q2REPRO_CODEC,
//    driven across two successive "server loop" frames with a fabricated
//    ClientT (no PVS/BSP -- see this file's header comment for why that's
//    safe). Proves the WIRING (sv_ents.ts routing through svs.codec.writeFrame),
//    not just the codec ops in isolation.
// =============================================================================

describe("SV_WriteFrameToClient E2E with a fabricated client (svs.codec = Q2REPRO_CODEC)", () => {
  test("two successive frames (nodelta then delta) produce a 1038 envelope that Q2REPRO_CODEC parses back", () => {
    const savedCodec = svs.codec;
    const savedNumClientEntities = svs.num_client_entities;
    const savedClientEntities = svs.client_entities;
    const savedFramenum = sv.framenum;
    try {
      svs.codec = Q2REPRO_CODEC;
      svs.num_client_entities = 8;
      svs.client_entities = Array.from({ length: 8 }, () => new EntityStateT());

      const client = new ClientT();
      // v1.0.0 wire cluster (task board #23): SV_WriteFrameToClient now
      // reads client.codec, not svs.codec (per-client codec negotiation) --
      // svs.codec above is still set for anything that legitimately stays
      // family-wide (demo recording), but this test's actual assertions
      // depend on client.codec specifically.
      client.codec = Q2REPRO_CODEC;
      // client.lastframe defaults to 0 (<=0 -> SV_WriteFrameToClient's
      // nodelta branch), matching a freshly connected client.

      // ---- frame 1 (nodelta) --------------------------------------------
      sv.framenum = 1;
      const frame1 = client.frames[sv.framenum & UPDATE_MASK];
      frame1.ps = new PlayerStateT();
      frame1.ps.pmove.origin.set([160, 0, 0]);
      frame1.areabytes = 0;
      frame1.num_entities = 1;
      frame1.first_entity = 0;
      const ent3v1 = new EntityStateT();
      ent3v1.number = 3;
      ent3v1.origin.set([16, 0, 0]);
      svs.client_entities[0] = ent3v1;

      const msg1 = newMsg();
      SV_WriteFrameToClient(client, msg1);
      const bytes1 = msg1.data.slice(0, msg1.cursize);

      loadIntoNetMessage(bytes1);
      discardOpcode();
      const header1 = Q2REPRO_CODEC.readFrameHeader(new Uint8Array(32), true);
      expect(header1.serverframe).toBe(1);
      expect(header1.deltaframe).toBe(-1); // client.lastframe was 0 -> nodelta
      const ps1Out = new PlayerStateT();
      Q2REPRO_CODEC.readFramePlayerstate(new PlayerStateT(), ps1Out);
      expect(Array.from(ps1Out.pmove.origin)).toEqual([160, 0, 0]);
      Q2REPRO_CODEC.readPacketEntitiesBegin();
      const e1 = Q2REPRO_CODEC.readEntityBits();
      expect(e1.number).toBe(3);
      const ent3v1Out = new EntityStateT();
      Q2REPRO_CODEC.readDeltaEntity(new EntityStateT(), ent3v1Out, e1.number, e1.bits);
      expect(Array.from(ent3v1Out.origin)).toEqual([16, 0, 0]);
      expect(Q2REPRO_CODEC.readEntityBits().number).toBe(0); // terminator

      // ---- simulate the client ack'ing frame 1, advance the server loop -
      client.lastframe = 1;
      sv.framenum = 2;
      const frame2 = client.frames[sv.framenum & UPDATE_MASK];
      frame2.ps = new PlayerStateT();
      frame2.ps.pmove.origin.set([320, 0, 0]); // changed from frame1
      frame2.areabytes = 0;
      frame2.num_entities = 2;
      frame2.first_entity = 1; // distinct slots -- frame1's snapshot at index 0 must survive untouched
      const ent3v2 = new EntityStateT();
      ent3v2.number = 3;
      ent3v2.origin.set([20, 0, 0]); // changed from frame1's [16,0,0] -> must produce a real delta header
      const ent7New = new EntityStateT();
      ent7New.number = 7;
      ent7New.origin.set([48, 0, 0]);
      svs.client_entities[1] = ent3v2;
      svs.client_entities[2] = ent7New;

      const msg2 = newMsg();
      SV_WriteFrameToClient(client, msg2);
      const bytes2 = msg2.data.slice(0, msg2.cursize);

      loadIntoNetMessage(bytes2);
      discardOpcode();
      const header2 = Q2REPRO_CODEC.readFrameHeader(new Uint8Array(32), true);
      expect(header2.serverframe).toBe(2);
      expect(header2.deltaframe).toBe(1); // real delta this time
      const ps2Out = new PlayerStateT();
      Q2REPRO_CODEC.readFramePlayerstate(new PlayerStateT(), ps2Out);
      expect(Array.from(ps2Out.pmove.origin)).toEqual([320, 0, 0]);
      Q2REPRO_CODEC.readPacketEntitiesBegin();

      // entity 3 (delta from its prior frame1 state) then entity 7 (new, from baseline)
      const e2a = Q2REPRO_CODEC.readEntityBits();
      expect(e2a.number).toBe(3);
      const ent3v2Out = new EntityStateT();
      Q2REPRO_CODEC.readDeltaEntity(ent3v1, ent3v2Out, e2a.number, e2a.bits);
      expect(Array.from(ent3v2Out.origin)).toEqual([20, 0, 0]);
      const e2b = Q2REPRO_CODEC.readEntityBits();
      expect(e2b.number).toBe(7);
      const ent7Out = new EntityStateT();
      Q2REPRO_CODEC.readDeltaEntity(sv.baselines[7], ent7Out, e2b.number, e2b.bits);
      expect(Array.from(ent7Out.origin)).toEqual([48, 0, 0]);
      expect(Q2REPRO_CODEC.readEntityBits().number).toBe(0); // terminator
    } finally {
      svs.codec = savedCodec;
      svs.num_client_entities = savedNumClientEntities;
      svs.client_entities = savedClientEntities;
      sv.framenum = savedFramenum;
    }
  });

  test("the same fabricated-client pipeline is byte-identical to the pre-refactor reference when svs.codec = VANILLA_CODEC", () => {
    const savedCodec = svs.codec;
    const savedNumClientEntities = svs.num_client_entities;
    const savedClientEntities = svs.client_entities;
    const savedFramenum = sv.framenum;
    try {
      svs.codec = VANILLA_CODEC;
      svs.num_client_entities = 4;
      svs.client_entities = Array.from({ length: 4 }, () => new EntityStateT());

      const client = new ClientT();
      // v1.0.0 wire cluster (task board #23): explicit even though it
      // matches ClientT's own default -- see the sibling Q2REPRO_CODEC test
      // above for why client.codec (not svs.codec) is what
      // SV_WriteFrameToClient actually reads now.
      client.codec = VANILLA_CODEC;
      sv.framenum = 1;
      const frame = client.frames[sv.framenum & UPDATE_MASK];
      frame.ps = new PlayerStateT();
      frame.ps.gunframe = 7;
      frame.areabytes = 1;
      frame.areabits[0] = 0xff;
      frame.num_entities = 0;
      frame.first_entity = 0;

      const msg = newMsg();
      SV_WriteFrameToClient(client, msg);
      const actual = Array.from(msg.data.subarray(0, msg.cursize));

      const params: FrameWriteParamsT = {
        framenum: 1,
        lastframe: -1,
        surpressCount: 0,
        areabits: frame.areabits,
        areabytes: 1,
        psFrom: null,
        psTo: frame.ps,
      };
      const expected = bufOf((m) =>
        referenceWriteFrame(m, params, (m2) => {
          VANILLA_CODEC.writePacketEntitiesBegin(m2);
          VANILLA_CODEC.writePacketEntitiesEnd(m2);
        }),
      );
      expect(actual).toEqual(expected);
    } finally {
      svs.codec = savedCodec;
      svs.num_client_entities = savedNumClientEntities;
      svs.client_entities = savedClientEntities;
      sv.framenum = savedFramenum;
    }
  });
});
