// NETCHAN_NEW wire-shape tests: the qport field's protocol-dependent width,
// and send-side fragment splitting / receive-side reassembly.
//
// References (qsrc/q2repro/src/common/net/chan.c):
//   NetchanOld_Transmit          212-221   qport width by protocol
//   NetchanOld_Process           275-282   qport width by protocol
//   Netchan_TransmitNextFragment 358-462   FRG_BIT + offset word + splitting
//   NetchanNew_Transmit          456-487   when a write becomes fragments
//   NetchanNew_Process           545-660   reassembly
//
// Self-sufficient per .orch/preferences.md rule 13: every test calls
// Netchan_Init() and NET_ClearLoopback() itself and builds its own netchans.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  NetadrT,
  NetadrtypeT,
  NetsrcT,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_RERELEASE,
} from "../src/qcommon/qcommon";
import { SZ_Write } from "../src/qcommon/sizebuf";
import { NET_ClearLoopback, NET_GetPacket } from "../src/platform/net_udp";
import {
  NetchanT,
  Netchan_Init,
  Netchan_Setup,
  Netchan_Transmit,
  Netchan_Process,
  NETCHAN_OLD,
  NETCHAN_NEW,
  net_from,
  net_message,
  qport,
} from "../src/qcommon/net_chan";

function loopbackAdr(): NetadrT {
  const a = new NetadrT();
  a.type = NetadrtypeT.NA_LOOPBACK;
  return a;
}

const EMPTY = new Uint8Array(0);

function qportValue(): number {
  return qport ? qport.value : 0;
}

// A client/server netchan pair sharing one loopback address, both set up with
// the same protocol/type/maxpacketlen the way SVC_DirectConnect and the
// client's "client_connect" handler do for a real connection.
function pair(chanType: 0 | 1, protocol: number, maxpacketlen?: number): { client: NetchanT; server: NetchanT } {
  Netchan_Init();
  NET_ClearLoopback();
  const adr = loopbackAdr();
  const client = new NetchanT();
  const server = new NetchanT();
  const qp = qportValue();
  Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, qp, chanType, protocol, maxpacketlen);
  Netchan_Setup(NetsrcT.NS_SERVER, server, adr, qp, chanType, protocol, maxpacketlen);
  return { client, server };
}

// Pulls the next datagram off the loopback ring into net_message WITHOUT
// letting Netchan_Process consume it, so a test can inspect raw header bytes.
function peekDatagram(): Uint8Array {
  expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
  return net_message.data.slice(0, net_message.cursize);
}

function le32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0);
}

function le16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

describe("qport field width is chosen by protocol, not by netchan type", () => {
  beforeEach(() => {
    NET_ClearLoopback();
  });

  // Vanilla is the ONLY protocol with the classic unconditional 16-bit qport
  // (chan.c:215-216's `if (chan->protocol < PROTOCOL_VERSION_R1Q2)
  // SZ_WriteShort`). Header is 4 + 4 + 2 = 10 bytes.
  test("protocol 34 / NETCHAN_OLD writes an unconditional 16-bit qport", () => {
    const { client, server } = pair(NETCHAN_OLD, PROTOCOL_VERSION);
    const body = Uint8Array.from([0xa1, 0xa2, 0xa3]);
    Netchan_Transmit(client, body.length, body);

    const raw = peekDatagram();
    expect(raw.length).toBe(4 + 4 + 2 + 3);
    expect(le16(raw, 8)).toBe(qportValue() & 0xffff);
    expect(Array.from(raw.subarray(10))).toEqual([0xa1, 0xa2, 0xa3]);

    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(net_message.readcount).toBe(10);
  });

  // R1Q2 keeps NETCHAN_OLD framing but switched to the one-byte conditional
  // qport (chan.c:217-218). This is the exact divergence that stopped a real
  // q2repro client from ever spawning at protocol 35: the server consumed two
  // bytes where the client wrote one, so the reliable `clc_stringcmd "new"`
  // that follows was never seen.
  test("protocol 35 / NETCHAN_OLD writes a ONE-byte qport, leaving the payload one byte earlier", () => {
    const { client, server } = pair(NETCHAN_OLD, PROTOCOL_VERSION_R1Q2);
    const body = Uint8Array.from([0xb1, 0xb2, 0xb3]);
    Netchan_Transmit(client, body.length, body);

    const raw = peekDatagram();
    expect(raw.length).toBe(4 + 4 + 1 + 3);
    expect(raw[8]).toBe(qportValue() & 0xff);
    expect(Array.from(raw.subarray(9))).toEqual([0xb1, 0xb2, 0xb3]);

    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(net_message.readcount).toBe(9);
  });

  test("protocol 36 / NETCHAN_NEW also writes a ONE-byte qport", () => {
    const { client, server } = pair(NETCHAN_NEW, PROTOCOL_VERSION_Q2PRO);
    const body = Uint8Array.from([0xc1, 0xc2]);
    Netchan_Transmit(client, body.length, body);

    const raw = peekDatagram();
    expect(raw.length).toBe(4 + 4 + 1 + 2);
    expect(raw[8]).toBe(qportValue() & 0xff);

    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(net_message.readcount).toBe(9);
  });

  // chan.c writes the byte only `if (chan->qport)`; a zero qport means no
  // field at all on the wire, and NetchanNew_Process/NetchanOld_Process
  // symmetrically read none.
  test("a zero qport emits no qport byte at all under R1Q2 and above", () => {
    Netchan_Init();
    NET_ClearLoopback();
    const adr = loopbackAdr();
    const client = new NetchanT();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, 0, NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE);
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 0, NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE);

    // Netchan_Transmit reads the qport CVAR for the value it writes (this
    // port's client never populates cls.quakePort), so force the "absent"
    // case the only way the wire can express it: a chan whose stored qport is
    // 0 makes the SERVER read no byte, and the client writes none when the
    // cvar itself is 0. Assert the read side, which is what SV_ReadPackets
    // depends on.
    const body = Uint8Array.from([0xd1]);
    const hasCvarQport = (qportValue() & 0xff) !== 0;
    Netchan_Transmit(client, body.length, body);
    const raw = peekDatagram();
    expect(raw.length).toBe(4 + 4 + (hasCvarQport ? 1 : 0) + 1);

    // The server reads no qport byte (chan.qport === 0), so it consumes only
    // the two sequence longs.
    Netchan_Process(server, net_message);
    expect(net_message.readcount).toBe(8);
  });
});

describe("NETCHAN_NEW fragmentation: split on send, reassemble on receive", () => {
  beforeEach(() => {
    NET_ClearLoopback();
  });

  function bigPayload(n: number): Uint8Array {
    const p = new Uint8Array(n);
    for (let i = 0; i < n; i++) p[i] = (i * 7 + 3) & 0xff;
    return p;
  }

  // The headline round-trip: one reliable write far larger than a single
  // datagram goes out as several FRG_BIT packets and comes back out of
  // Netchan_Process as one intact message.
  test("a reliable write larger than one packet round-trips through split + reassemble", () => {
    const maxpacketlen = 512;
    const { client, server } = pair(NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, maxpacketlen);

    const payload = bigPayload(1200); // 512 + 512 + 176 => exactly 3 fragments
    SZ_Write(client.message, payload, payload.length);

    // fragment 1
    Netchan_Transmit(client, 0, EMPTY);
    expect(client.fragment_pending).toBe(true);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(false); // more_fragments
    expect(server.fragment_in.cursize).toBe(512);

    // fragment 2 -- NetchanNew_Transmit's `if (chan->fragment_pending) return
    // Netchan_TransmitNextFragment(chan);` short-circuit (chan.c:456-458)
    Netchan_Transmit(client, 0, EMPTY);
    expect(client.fragment_pending).toBe(true);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(false);
    expect(server.fragment_in.cursize).toBe(1024);

    // fragment 3 -- last one, so the message assembles and Process succeeds
    Netchan_Transmit(client, 0, EMPTY);
    expect(client.fragment_pending).toBe(false);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(true);

    // net_message now points at the reassembled message, positioned at 0
    expect(net_message.cursize).toBe(1200);
    expect(net_message.readcount).toBe(0);
    expect(Array.from(net_message.data.subarray(0, 1200))).toEqual(Array.from(payload));

    // fragment_out was cleared and the sequence advanced exactly ONCE for the
    // whole fragmented message (chan.c:431-436)
    expect(client.fragment_out.cursize).toBe(0);
    expect(server.fragment_in.cursize).toBe(0);
    expect(server.incoming_sequence).toBe(1);
    expect(client.outgoing_sequence).toBe(2);
  });

  // Hand-derived header for the first fragment of the run above.
  test("fragment headers carry FRG_BIT, a shared sequence, and the offset/more_fragments word", () => {
    const maxpacketlen = 512;
    const { client } = pair(NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, maxpacketlen);
    const payload = bigPayload(1200);
    SZ_Write(client.message, payload, payload.length);
    const qpBytes = (qportValue() & 0xff) !== 0 ? 1 : 0;
    const offsetAt = 8 + qpBytes;

    // fragment 1: sequence 1, REL_BIT (a reliable message is in flight) and
    // FRG_BIT both set; offset 0 with the 0x8000 more_fragments flag.
    Netchan_Transmit(client, 0, EMPTY);
    let raw = peekDatagram();
    expect(le32(raw, 0)).toBe((1 | 0x40000000 | 0x80000000) >>> 0);
    expect(le32(raw, 4)).toBe(0);
    expect(le16(raw, offsetAt)).toBe(0x8000);
    expect(raw.length).toBe(offsetAt + 2 + 512);
    expect(Array.from(raw.subarray(offsetAt + 2))).toEqual(Array.from(payload.subarray(0, 512)));

    // fragment 2: SAME sequence (1), offset 512, still more_fragments
    Netchan_Transmit(client, 0, EMPTY);
    raw = peekDatagram();
    expect(le32(raw, 0)).toBe((1 | 0x40000000 | 0x80000000) >>> 0);
    expect(le16(raw, offsetAt)).toBe(0x8000 | 512);

    // fragment 3: same sequence, offset 1024, more_fragments CLEAR, 176 bytes
    Netchan_Transmit(client, 0, EMPTY);
    raw = peekDatagram();
    expect(le32(raw, 0)).toBe((1 | 0x40000000 | 0x80000000) >>> 0);
    expect(le16(raw, offsetAt)).toBe(1024);
    expect(raw.length).toBe(offsetAt + 2 + 176);
    expect(Array.from(raw.subarray(offsetAt + 2))).toEqual(Array.from(payload.subarray(1024, 1200)));
  });

  // chan.c:625-629: a fragment whose offset is past the end of what has been
  // accumulated means an earlier fragment was lost -- drop it and keep the
  // partial buffer as-is rather than assembling a hole.
  test("a missing middle fragment is rejected, not silently stitched over", () => {
    const maxpacketlen = 512;
    const { client, server } = pair(NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, maxpacketlen);
    const payload = bigPayload(1200);
    SZ_Write(client.message, payload, payload.length);

    Netchan_Transmit(client, 0, EMPTY); // fragment 1 -> delivered
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(false);
    expect(server.fragment_in.cursize).toBe(512);

    Netchan_Transmit(client, 0, EMPTY); // fragment 2 -> dropped in transit
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);

    Netchan_Transmit(client, 0, EMPTY); // fragment 3 -> arrives at offset 1024
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(false);

    // buffer untouched, and no bogus message was handed up
    expect(server.fragment_in.cursize).toBe(512);
  });

  // chan.c:620-624: an offset BEHIND what we already have is a duplicate or
  // reordered fragment.
  test("a duplicated (out of order) fragment is rejected", () => {
    const maxpacketlen = 512;
    const { client, server } = pair(NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, maxpacketlen);
    SZ_Write(client.message, bigPayload(1200), 1200);

    Netchan_Transmit(client, 0, EMPTY);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    const first = net_message.data.slice(0, net_message.cursize);
    expect(Netchan_Process(server, net_message)).toBe(false);
    expect(server.fragment_in.cursize).toBe(512);

    // replay fragment 1 (offset 0 < cursize 512)
    net_message.data.set(first, 0);
    net_message.cursize = first.length;
    expect(Netchan_Process(server, net_message)).toBe(false);
    expect(server.fragment_in.cursize).toBe(512);
  });

  // NETCHAN_OLD has no fragmentation path at all: NetchanOld_Transmit never
  // consults maxpacketlen and never sets FRG_BIT, it just fills one datagram
  // and warns "dumped unreliable" if the payload does not fit the send buffer.
  // So the SAME write that produced three fragments above goes out here as one
  // oversized unfragmented packet, even with maxpacketlen set to 512.
  test("NETCHAN_OLD never fragments -- maxpacketlen does not apply to it", () => {
    const { client, server } = pair(NETCHAN_OLD, PROTOCOL_VERSION, 512);
    const payload = bigPayload(1200);
    Netchan_Transmit(client, payload.length, payload);

    const raw = peekDatagram();
    expect((le32(raw, 0) & 0x40000000) >>> 0).toBe(0); // no FRG_BIT
    expect(raw.length).toBe(10 + 1200); // one packet, 16-bit qport header
    expect(Array.from(raw.subarray(10))).toEqual(Array.from(payload));

    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(server.fragment_in.cursize).toBe(0); // no reassembly buffer in use
  });

  // A NETCHAN_NEW write that still fits stays a single unfragmented packet.
  test("a NETCHAN_NEW write that fits one packet is not fragmented", () => {
    const { client, server } = pair(NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, 512);
    const body = bigPayload(100);
    Netchan_Transmit(client, body.length, body);
    expect(client.fragment_pending).toBe(false);

    const raw = peekDatagram();
    expect((le32(raw, 0) & 0x40000000) >>> 0).toBe(0);
    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(Array.from(net_message.data.subarray(net_message.readcount, net_message.cursize))).toEqual(Array.from(body));
  });
});
