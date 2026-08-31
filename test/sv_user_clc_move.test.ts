// SV_ExecuteClientMessage's non-batched clc_move path.
//
// Two things are pinned here, both settled against
// qsrc/q2repro/src/server/user.c's SV_OldClientExecuteMove (lines 1066-1110):
//
//   1. The leading sequence-checksum byte is VANILLA-ONLY. Vanilla's
//      vanilla_server_read_move (q2proto_proto_vanilla.c:1168-1176) opens by
//      skipping it; r1q2_server_read_move (q2proto_proto_r1q2.c:1528-1535) and
//      q2pro_server_read_move (q2proto_proto_q2pro.c:2387-2393) start straight
//      at the i32 lastframe. Consuming it for 35/36 shifts every later field
//      by one byte, which desynchronizes the rest of the packet.
//
//   2. The cs_spawned check happens BEFORE lastframe/frame_latency are
//      recorded (user.c:1082-1087), and a second clc_move in one packet drops
//      the client rather than being silently ignored (user.c:1072-1077).
//
// Deliberately drives only UNSPAWNED clients, so SV_ClientThink (and therefore
// a real game library) is never reached -- the parse framing is still fully
// exercised, because a misaligned read shows up as the trailing clc_nop being
// misread as an unknown opcode and the client being dropped.
//
// Self-sufficient per .orch/preferences.md rule 13.

import { beforeEach, describe, expect, test } from "bun:test";
import { NetadrT, NetsrcT, ClcOpsT, UPDATE_MASK } from "../src/qcommon/qcommon";
import { UsercmdT } from "../src/shared/q_shared";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_BeginReading, MSG_WriteByte, MSG_WriteLong } from "../src/qcommon/sizebuf";
import { Netchan_Setup, net_message } from "../src/qcommon/net_chan";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { createR1Q2Codec } from "../src/qcommon/protocol/r1q2";
import { createQ2ProCodec } from "../src/qcommon/protocol/q2pro";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { ClientT, ClientStateT, LATENCY_COUNTS, svs, svClientHolder, svPlayerHolder } from "../src/server/server";
import { SV_ExecuteClientMessage } from "../src/server/sv_user";

function makeClient(codec: ProtocolCodec): ClientT {
  const cl = new ClientT();
  Netchan_Setup(NetsrcT.NS_SERVER, cl.netchan, new NetadrT(), 0);
  cl.codec = codec;
  cl.state = ClientStateT.cs_connected; // never cs_spawned -- no SV_ClientThink
  cl.edict = null;
  cl.name = "tester";
  return cl;
}

// Reads back through a call boundary so tsc's control-flow narrowing on the
// literal assigned above does not pin the property's apparent type (same
// reason test/sv_game.test.ts uses this shape).
function stateOf(cl: ClientT): ClientStateT {
  return cl.state;
}

// Builds a clc_move packet for `codec`: the checksum byte is emitted only when
// that codec's own wire format has one.
function buildMovePacket(codec: ProtocolCodec, lastframe: number, opts: { trailingNop?: boolean; secondMove?: boolean } = {}): Uint8Array {
  const msg = new SizeBuf();
  SZ_Init(msg, new Uint8Array(1024), 1024);

  const writeOneMove = (): void => {
    MSG_WriteByte(msg, ClcOpsT.clc_move);
    if (codec.clcMoveHasChecksum === true) MSG_WriteByte(msg, 0); // checksum (never validated on an unspawned client)
    MSG_WriteLong(msg, lastframe);
    const nullcmd = new UsercmdT();
    const cmd = new UsercmdT();
    cmd.msec = 16;
    codec.writeDeltaUsercmd(msg, nullcmd, cmd);
    codec.writeDeltaUsercmd(msg, cmd, cmd);
    codec.writeDeltaUsercmd(msg, cmd, cmd);
  };

  writeOneMove();
  if (opts.secondMove) writeOneMove();
  if (opts.trailingNop) MSG_WriteByte(msg, ClcOpsT.clc_nop);

  return msg.data.slice(0, msg.cursize);
}

function loadNetMessage(bytes: Uint8Array): void {
  SZ_Clear(net_message);
  SZ_Write(net_message, bytes, bytes.length);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
  svs.realtime = 1000;
  svClientHolder.sv_client = null;
  svPlayerHolder.sv_player = null;
});

describe("clc_move framing: the checksum byte is vanilla-only", () => {
  // Each codec's packet is built with its OWN wire shape and must parse to
  // completion: the trailing clc_nop is the canary. If the reader consumed one
  // byte too many (or too few), that nop lands mid-usercmd and the dispatch
  // falls into its `default:` arm, which drops the client.
  const cases: Array<{ label: string; codec: ProtocolCodec; expectChecksum: boolean }> = [
    { label: "vanilla / protocol 34", codec: VANILLA_CODEC, expectChecksum: true },
    { label: "R1Q2 / protocol 35", codec: createR1Q2Codec(1905), expectChecksum: false },
    { label: "Q2PRO / protocol 36", codec: createQ2ProCodec(1024), expectChecksum: false },
  ];

  for (const { label, codec, expectChecksum } of cases) {
    test(`${label}: clcMoveHasChecksum is ${expectChecksum}`, () => {
      expect(codec.clcMoveHasChecksum === true).toBe(expectChecksum);
    });

    test(`${label}: a well-formed clc_move packet parses to the end without dropping the client`, () => {
      const cl = makeClient(codec);
      svs.clients = [cl];
      loadNetMessage(buildMovePacket(codec, 4, { trailingNop: true }));

      SV_ExecuteClientMessage(cl);

      expect(stateOf(cl)).toBe(ClientStateT.cs_connected); // not cs_zombie => never dropped
      expect(net_message.readcount).toBeGreaterThanOrEqual(net_message.cursize);
    });
  }

  // The concrete regression: feed an R1Q2 client a packet that carries
  // vanilla's extra checksum byte. Every following field shifts by one and the
  // parse must NOT quietly succeed -- this is the shape that produced the live
  // "Failed command checksum" / "badread" flood before clcMoveHasChecksum
  // existed.
  test("an R1Q2 client fed a vanilla-shaped (checksum-carrying) clc_move desynchronizes and is dropped", () => {
    const r1q2 = createR1Q2Codec(1905);
    const cl = makeClient(r1q2);
    svs.clients = [cl];

    const good = buildMovePacket(r1q2, 4, { trailingNop: true });
    const bad = new Uint8Array(good.length + 1);
    bad[0] = good[0]; // clc_move
    bad[1] = 0x00; // a checksum byte R1Q2 never sends
    bad.set(good.subarray(1), 2);

    loadNetMessage(bad);
    SV_ExecuteClientMessage(cl);

    expect(stateOf(cl)).toBe(ClientStateT.cs_zombie);
  });
});

describe("SV_OldClientExecuteMove ordering and multi-move handling", () => {
  // user.c:1082-1087 checks cs_spawned FIRST and forces lastframe to -1
  // without ever touching frame_latency. id's original recorded
  // lastframe/frame_latency before that check; the observable difference is
  // whether frame_latency[] gets written for an unspawned client.
  test("an unspawned client's frame_latency is left untouched and lastframe is forced to -1", () => {
    const cl = makeClient(VANILLA_CODEC);
    svs.clients = [cl];
    cl.lastframe = 0;
    const slot = 4 & (LATENCY_COUNTS - 1);
    cl.frame_latency[slot] = 0;
    cl.frames[4 & UPDATE_MASK].senttime = 250; // would have produced 1000-250=750

    loadNetMessage(buildMovePacket(VANILLA_CODEC, 4, { trailingNop: true }));
    SV_ExecuteClientMessage(cl);

    expect(cl.lastframe).toBe(-1);
    expect(cl.frame_latency[slot]).toBe(0); // never recorded -- state checked first
    expect(stateOf(cl)).toBe(ClientStateT.cs_connected);
  });

  // user.c:1072-1077: `SV_DropClient(sv_client, "multiple clc_move commands
  // in packet")`, not a bare `return`.
  test("a second clc_move in one packet drops the client", () => {
    const cl = makeClient(VANILLA_CODEC);
    svs.clients = [cl];

    loadNetMessage(buildMovePacket(VANILLA_CODEC, 4, { secondMove: true }));
    SV_ExecuteClientMessage(cl);

    expect(stateOf(cl)).toBe(ClientStateT.cs_zombie);
  });

  test("a single clc_move does NOT drop the client", () => {
    const cl = makeClient(VANILLA_CODEC);
    svs.clients = [cl];

    loadNetMessage(buildMovePacket(VANILLA_CODEC, 4));
    SV_ExecuteClientMessage(cl);

    expect(stateOf(cl)).toBe(ClientStateT.cs_connected);
  });
});
