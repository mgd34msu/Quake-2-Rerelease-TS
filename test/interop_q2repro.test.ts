// Phase-8 q2repro interop gate: golden-vector / round-trip tests for the
// reproducible wire-level fixes found by driving a REAL q2repro binary
// (built from ~/Projects/qsrc/q2repro against ~/Projects/q2proto) against
// this engine's server and client, and vice versa. The binary-driven matrix
// itself lives in scripts/interop-matrix.sh (skips gracefully when the
// binary isn't present); this file covers only what's byte-level
// reproducible without it. See .orch/followups.md's "phase-8 q2repro
// interop" entries for the full narrative and citations.
//
// Two real, evidenced bugs are covered here:
//   1. sv_main.ts's SVC_GetChallenge omitted the "p=<protocols>" suffix a
//      real q2proto-based client's q2proto_parse_challenge requires to
//      negotiate anything past an ambiguous implicit-vanilla fallback.
//   2. src/qcommon/net_chan.ts implemented only NETCHAN_OLD framing; a real
//      q2repro client negotiating kex (1038) or Q2PRO (36) always uses
//      NETCHAN_NEW (single conditional-byte qport, FRG_BIT-reserved 30-bit
//      sequence numbers) on both ends.
//
// Rule 13: this file initializes everything it reads and restores shared
// module state (svs.csr) it mutates, so it is safe to run alone or in any
// file order alongside the rest of the suite.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NetadrT, NetadrtypeT, NetsrcT } from "../src/qcommon/qcommon";
import { MSG_BeginReading, MSG_ReadLong, MSG_WriteLong, SizeBuf, SZ_Init } from "../src/qcommon/sizebuf";
import {
  NetchanT,
  Netchan_Init,
  Netchan_Setup,
  Netchan_Transmit,
  Netchan_Process,
  net_from,
  net_message,
  qport,
  NETCHAN_OLD,
  NETCHAN_NEW,
} from "../src/qcommon/net_chan";
import { NET_ClearLoopback, NET_SendPacket, NET_GetPacket } from "../src/platform/net_udp";
import { SV_ConnectionlessPacket } from "../src/server/sv_main";
import { svs } from "../src/server/server";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";

function loopbackAdr(): NetadrT {
  const a = new NetadrT();
  a.type = NetadrtypeT.NA_LOOPBACK;
  return a;
}

function sendGetChallenge(): void {
  const text = "getchallenge";
  const bytes = new Uint8Array(4 + text.length);
  bytes.set([0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < text.length; i++) bytes[4 + i] = text.charCodeAt(i);
  NET_SendPacket(NetsrcT.NS_CLIENT, bytes.length, bytes, loopbackAdr());
}

// ---- SVC_GetChallenge's "p=" protocol-list suffix -------------------------
//
// Real q2repro/q2proto servers (src/server/main.c's own SVC_GetChallenge)
// always append q2proto_get_challenge_extras()'s "p=<netvers>" to the
// challenge reply. Confirmed missing here by capturing a real q2repro
// client against this server: it printed "Requesting connection... N" then
// immediately "Could not get connect string (PROTOCOL_NOT_SUPPORTED)"
// (client/main.c:491) because q2proto_client.c's q2proto_parse_challenge
// treats a bare "challenge %i" as an implicit-vanilla offer that leaves
// cls.serverProtocol unresolved rather than a real negotiated protocol.

describe("SVC_GetChallenge protocol-list suffix (phase-8 q2repro interop)", () => {
  const savedCsr = svs.csr;

  beforeEach(() => {
    NET_ClearLoopback(); // rule 13: earlier suites may have used the rings
  });

  test("kex family (svs.csr === CS_REMAP_RERELEASE) advertises exactly p=1038", () => {
    svs.csr = CS_REMAP_RERELEASE;
    try {
      sendGetChallenge();
      expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
      SV_ConnectionlessPacket();

      const replyFrom = new NetadrT();
      expect(NET_GetPacket(NetsrcT.NS_CLIENT, replyFrom, net_message)).toBe(true);
      MSG_BeginReading(net_message);
      MSG_ReadLong(net_message); // -1 OOB marker
      const rest = new TextDecoder().decode(net_message.data.slice(net_message.readcount, net_message.cursize));
      expect(rest.startsWith("challenge ")).toBe(true);
      expect(rest.endsWith(" p=1038")).toBe(true);
    } finally {
      svs.csr = savedCsr;
    }
  });

  test("legacy family (svs.csr === CS_REMAP_OLD) advertises p=34,35,36 ascending", () => {
    svs.csr = CS_REMAP_OLD;
    try {
      sendGetChallenge();
      expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
      SV_ConnectionlessPacket();

      const replyFrom = new NetadrT();
      expect(NET_GetPacket(NetsrcT.NS_CLIENT, replyFrom, net_message)).toBe(true);
      MSG_BeginReading(net_message);
      MSG_ReadLong(net_message);
      const rest = new TextDecoder().decode(net_message.data.slice(net_message.readcount, net_message.cursize));
      expect(rest.endsWith(" p=34,35,36")).toBe(true);
    } finally {
      svs.csr = savedCsr;
    }
  });
});

// ---- NETCHAN_NEW framing ---------------------------------------------------
//
// q2repro's real src/common/net/chan.c (NetchanNew_Transmit/NetchanNew_
// Process, lines 444-624): qport is a single byte written only when nonzero
// (vs NETCHAN_OLD's unconditional 16-bit short), and bit 30 of both sequence
// longs (FRG_BIT) marks a fragmented packet, leaving 30 usable sequence bits
// instead of 31 (NEW_MASK = 0x3fffffff vs OLD_MASK = 0x7fffffff). Confirmed
// missing here by capturing a real q2repro client: with only NETCHAN_OLD
// implemented, every post-connect packet it sent was silently dropped
// (SV_ReadPackets read a 16-bit qport field where the client wrote a 1-byte
// one), so the client never advanced past "Connected to ...".

function netMessageBytes(): Uint8Array {
  return net_message.data.slice(0, net_message.cursize);
}

describe("NETCHAN_NEW wire framing (phase-8 q2repro interop)", () => {
  // rule 13: `qport` is a real process-wide CvarT singleton (matching C's
  // global cvar semantics) that other suites read for their OWN connect
  // flows (e.g. cl_main.test.ts embeds it in a real connect string and its
  // own netchan Transmit). A test here that sets qport.value and never
  // restores it leaks a stale value into whichever suite happens to run
  // next -- caught by a real regression: setting it to 0 broke cl_main.
  // test.ts's loopback connect test when the full suite ran in an order
  // that put this file first.
  let savedQportValue = 0;

  beforeEach(() => {
    NET_ClearLoopback();
    Netchan_Init();
    savedQportValue = qport ? qport.value : 0;
  });

  afterEach(() => {
    if (qport) qport.value = savedQportValue;
  });

  test("Transmit writes qport as a single byte when nonzero, not the old 16-bit short", () => {
    const adr = loopbackAdr();
    const client = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, 4321, NETCHAN_NEW);
    if (qport) qport.value = 4321;

    Netchan_Transmit(client, 0, new Uint8Array(0));
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);

    const bytes = netMessageBytes();
    // 4 (sequence) + 4 (ack) + 1 (qport byte) = 9-byte header, zero payload
    expect(bytes.length).toBe(9);
    expect(bytes[8]).toBe(4321 & 0xff);
  });

  test("Transmit omits the qport byte entirely when qport is 0 (q2repro chan.c:391/507's own gate)", () => {
    const adr = loopbackAdr();
    const client = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, 0, NETCHAN_NEW);
    if (qport) qport.value = 0;

    Netchan_Transmit(client, 0, new Uint8Array(0));
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);

    const bytes = netMessageBytes();
    // 4 + 4 = 8-byte header only, no qport byte at all
    expect(bytes.length).toBe(8);
  });

  test("NETCHAN_OLD is unaffected: still an unconditional 16-bit qport (regression guard)", () => {
    const adr = loopbackAdr();
    const client = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, 4321, NETCHAN_OLD);
    if (qport) qport.value = 4321;

    Netchan_Transmit(client, 0, new Uint8Array(0));
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);

    const bytes = netMessageBytes();
    // 4 + 4 + 2 (short) = 10-byte header
    expect(bytes.length).toBe(10);
    expect(bytes[8] | (bytes[9] << 8)).toBe(4321);
  });

  test("full round trip: NETCHAN_NEW client -> server delivers payload and the server correctly consumes the 1-byte qport", () => {
    const adr = loopbackAdr();
    const client = new NetchanT();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, 4321, NETCHAN_NEW);
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 4321, NETCHAN_NEW);
    if (qport) qport.value = 4321;

    const payload = new Uint8Array([1, 2, 3, 4]);
    Netchan_Transmit(client, payload.length, payload);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(true);

    // Netchan_Process leaves the read cursor right after the header; the
    // payload should be exactly what was sent, with no leftover qport byte
    // misread into it (that's the exact class of bug this fix corrects).
    const remaining = net_message.data.slice(net_message.readcount, net_message.cursize);
    expect(Array.from(remaining)).toEqual(Array.from(payload));
    expect(server.incoming_sequence).toBe(1);
  });

  test("a fragmented (FRG_BIT) NETCHAN_NEW packet is dropped cleanly, not misparsed or crashed", () => {
    const adr = loopbackAdr();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 0, NETCHAN_NEW);

    // Hand-build a raw NETCHAN_NEW header: sequence=1 with FRG_BIT (bit 30)
    // set, no REL_BIT, ack=0. qport is 0 on this chan, so no qport byte.
    const FRG_BIT = 1 << 30;
    const raw = new SizeBuf();
    const buf = new Uint8Array(64);
    SZ_Init(raw, buf, buf.length);
    MSG_WriteLong(raw, 1 | FRG_BIT);
    MSG_WriteLong(raw, 0);

    const beforeSeq = server.incoming_sequence;
    expect(Netchan_Process(server, raw)).toBe(false);
    // state must be untouched -- Netchan_Process bails before updating
    // chan.incoming_sequence for a dropped fragmented packet
    expect(server.incoming_sequence).toBe(beforeSeq);
  });

  test("NETCHAN_NEW's 30-bit sequence mask clears FRG_BIT but preserves a large in-range sequence value", () => {
    const adr = loopbackAdr();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 0, NETCHAN_NEW);

    // sequence = 0x3ffffffe (just under NEW_MASK's 30-bit ceiling), no
    // REL_BIT/FRG_BIT set -- must survive masking unchanged.
    const raw = new SizeBuf();
    const buf = new Uint8Array(64);
    SZ_Init(raw, buf, buf.length);
    MSG_WriteLong(raw, 0x3ffffffe);
    MSG_WriteLong(raw, 0);

    expect(Netchan_Process(server, raw)).toBe(true);
    expect(server.incoming_sequence).toBe(0x3ffffffe);
  });
});
