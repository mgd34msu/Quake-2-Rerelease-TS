import { beforeEach, describe, expect, test } from "bun:test";
import { NetadrT, NetadrtypeT, NetsrcT } from "../src/qcommon/qcommon";
import { SizeBuf, SZ_Init, MSG_BeginReading, MSG_ReadLong, MSG_ReadByte, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { Cvar_Get } from "../src/qcommon/cvar";
import { CVAR_NOSET } from "../src/shared/q_shared";
import {
  NET_ClearLoopback,
  NET_StringToAdr,
  NET_AdrToString,
  NET_CompareAdr,
  NET_CompareBaseAdr,
  NET_IsLocalAddress,
  NET_SendPacket,
  NET_GetPacket,
  NET_Config,
  NET_Shutdown,
  NET_SocketBound,
  NET_SocketPort,
} from "../src/platform/net_udp";
import { NetchanT, Netchan_Init, Netchan_Setup, Netchan_Transmit, Netchan_Process, Netchan_NeedReliable, Netchan_CanReliable, Netchan_OutOfBandPrint, net_from, net_message, qport } from "../src/qcommon/net_chan";

function loopbackAdr(): NetadrT {
  const a = new NetadrT();
  a.type = NetadrtypeT.NA_LOOPBACK;
  return a;
}

// Transmits `payload` from `sender` and delivers the resulting datagram to
// `receiver` in one step (both endpoints share the loopback ring pair, so the
// receiving side is whichever netsrc `sender`'s traffic lands on).
function transmitAndDeliver(sender: NetchanT, receiver: NetchanT, receiverSock: NetsrcT, payload: Uint8Array): boolean {
  Netchan_Transmit(sender, payload.length, payload);
  if (!NET_GetPacket(receiverSock, net_from, net_message)) return false;
  return Netchan_Process(receiver, net_message);
}

// Transmits `payload` and drains the datagram off the loopback ring without
// ever handing it to Netchan_Process -- simulates the packet being lost after
// the receiving socket got it but before the application processed it.
function transmitAndDrop(sender: NetchanT, receiverSock: NetsrcT, payload: Uint8Array): void {
  Netchan_Transmit(sender, payload.length, payload);
  NET_GetPacket(receiverSock, net_from, net_message);
}

describe("NET_StringToAdr / NET_AdrToString", () => {
  test("parses a dotted-quad address with a port and round-trips through NET_AdrToString", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("192.246.40.70:27910", a)).toBe(true);
    expect(a.type).toBe(NetadrtypeT.NA_IP);
    expect(Array.from(a.ip)).toEqual([192, 246, 40, 70]);
    expect(a.port).toBe(27910);
    expect(NET_AdrToString(a)).toBe("192.246.40.70:27910");
  });

  test("parses 'localhost:0' as 127.0.0.1 (matches gethostbyname('localhost'), not the bare NA_LOOPBACK special case)", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("localhost:0", a)).toBe(true);
    expect(a.type).toBe(NetadrtypeT.NA_IP);
    expect(Array.from(a.ip)).toEqual([127, 0, 0, 1]);
    expect(a.port).toBe(0);
    expect(NET_AdrToString(a)).toBe("127.0.0.1:0");
  });

  test("bare 'localhost' (no port) hits the NA_LOOPBACK special case", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("localhost", a)).toBe(true);
    expect(a.type).toBe(NetadrtypeT.NA_LOOPBACK);
  });

  test("rejects garbage input", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("not-an-address", a)).toBe(false);
  });
});

describe("NET_CompareAdr / NET_CompareBaseAdr / NET_IsLocalAddress", () => {
  test("compares full address including port", () => {
    const a = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", a);
    const b = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", b);
    const c = new NetadrT();
    NET_StringToAdr("10.0.0.1:200", c);
    expect(NET_CompareAdr(a, b)).toBe(true);
    expect(NET_CompareAdr(a, c)).toBe(false);
  });

  test("base compare ignores port but not type", () => {
    const a = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", a);
    const b = new NetadrT();
    NET_StringToAdr("10.0.0.1:200", b);
    expect(NET_CompareBaseAdr(a, b)).toBe(true);

    const loop = loopbackAdr();
    expect(NET_CompareBaseAdr(a, loop)).toBe(false); // different .type
    expect(NET_CompareBaseAdr(loop, loopbackAdr())).toBe(true); // NA_LOOPBACK always matches itself
  });

  test("NET_IsLocalAddress compares against the zeroed net_local_adr (never set on this port)", () => {
    const zero = new NetadrT(); // NA_LOOPBACK, ip/port all 0 -- matches net_local_adr's default
    expect(NET_IsLocalAddress(zero)).toBe(true);

    const notLocal = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", notLocal);
    expect(NET_IsLocalAddress(notLocal)).toBe(false);
  });
});

describe("NET_SendPacket / NET_GetPacket over the loopback ring", () => {
  beforeEach(() => {
    NET_ClearLoopback(); // rule 13: earlier suites may have used the rings
  });

  test("round-trips a raw payload from NS_CLIENT to NS_SERVER", () => {
    const adr = loopbackAdr();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);

    NET_SendPacket(NetsrcT.NS_CLIENT, payload.length, payload, adr);

    const from = new NetadrT();
    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(1400), 1400);

    expect(NET_GetPacket(NetsrcT.NS_SERVER, from, msg)).toBe(true);
    expect(Array.from(msg.data.slice(0, msg.cursize))).toEqual([1, 2, 3, 4, 5]);
    expect(from.type).toBe(NetadrtypeT.NA_LOOPBACK);

    // nothing else queued
    expect(NET_GetPacket(NetsrcT.NS_SERVER, from, msg)).toBe(false);
  });

  test("NS_CLIENT and NS_SERVER loopback rings are independent directions", () => {
    const adr = loopbackAdr();
    NET_SendPacket(NetsrcT.NS_SERVER, 1, new Uint8Array([9]), adr);

    const from = new NetadrT();
    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(1400), 1400);

    // a send from NS_SERVER lands in NS_CLIENT's inbox, not NS_SERVER's
    expect(NET_GetPacket(NetsrcT.NS_SERVER, from, msg)).toBe(false);
    expect(NET_GetPacket(NetsrcT.NS_CLIENT, from, msg)).toBe(true);
    expect(msg.data[0]).toBe(9);
  });
});

describe("Netchan_* over loopback", () => {
  beforeEach(() => {
    NET_ClearLoopback();
  });

  test("Netchan_Transmit then Netchan_Process delivers an unreliable payload and increments sequence numbers", () => {
    Netchan_Init();
    const adr = loopbackAdr();

    const client = new NetchanT();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, qport ? qport.value : 0);
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 0);

    expect(client.outgoing_sequence).toBe(1);

    const payload = new Uint8Array([10, 20, 30]);
    expect(transmitAndDeliver(client, server, NetsrcT.NS_SERVER, payload)).toBe(true);

    expect(client.outgoing_sequence).toBe(2); // incremented by the transmit
    expect(server.incoming_sequence).toBe(1);
    expect(server.dropped).toBe(0);

    // Netchan_Process leaves the read cursor positioned right after the
    // header, ready for the caller to read the payload that follows it.
    expect(MSG_ReadByte(net_message)).toBe(10);
    expect(MSG_ReadByte(net_message)).toBe(20);
    expect(MSG_ReadByte(net_message)).toBe(30);

    // a second transmit bumps the sequence again
    expect(transmitAndDeliver(client, server, NetsrcT.NS_SERVER, new Uint8Array(0))).toBe(true);
    expect(client.outgoing_sequence).toBe(3);
    expect(server.incoming_sequence).toBe(2);
  });

  test("duplicate and out-of-order packets are rejected without disturbing the connection", () => {
    Netchan_Init();
    const adr = loopbackAdr();
    const client = new NetchanT();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, qport ? qport.value : 0);
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 0);

    Netchan_Transmit(client, 0, new Uint8Array(0)); // sequence 1
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    const saved = net_message.data.slice(0, net_message.cursize);

    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(server.incoming_sequence).toBe(1);

    // redeliver the exact same datagram: sequence 1 <= incoming_sequence 1.
    // SZ_Init always zeroes cursize (it initializes a buffer for writing);
    // set cursize directly afterward, the way NET_GetPacket itself populates
    // a SizeBuf from already-received bytes.
    const dup = new SizeBuf();
    SZ_Init(dup, saved, saved.length);
    dup.cursize = saved.length;
    expect(Netchan_Process(server, dup)).toBe(false);
    expect(server.incoming_sequence).toBe(1); // unchanged
  });

  test("a reliable message survives a deliberately dropped packet", () => {
    Netchan_Init();
    const adr = loopbackAdr();
    const client = new NetchanT();
    const server = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, client, adr, qport ? qport.value : 0);
    Netchan_Setup(NetsrcT.NS_SERVER, server, adr, 0);

    // queue a reliable payload the way application code does: MSG_Write*
    // directly onto netchan->message
    MSG_WriteByte(client.message, 0xab);
    expect(Netchan_CanReliable(client)).toBe(true); // nothing in flight yet

    // packet 1: picks up the reliable payload, then is lost before the server
    // ever hands it to Netchan_Process
    transmitAndDrop(client, NetsrcT.NS_SERVER, new Uint8Array(0));
    expect(client.reliable_length).toBe(1); // still buffered, unacked
    expect(Netchan_CanReliable(client)).toBe(false); // waiting for ack

    // packet 2: unreliable-only (the resend condition hasn't been met yet),
    // delivered normally -- the server notices packet 1 never arrived
    expect(transmitAndDeliver(client, server, NetsrcT.NS_SERVER, new Uint8Array(0))).toBe(true);
    expect(server.dropped).toBe(1);

    // server's first reply acks up through packet 2
    expect(transmitAndDeliver(server, client, NetsrcT.NS_CLIENT, new Uint8Array(0))).toBe(true);
    expect(Netchan_NeedReliable(client)).toBe(false); // ack hasn't passed last_reliable_sequence yet

    // packet 3 / reply round trip pushes the client's acknowledged sequence
    // past last_reliable_sequence, which is what actually arms the resend
    expect(transmitAndDeliver(client, server, NetsrcT.NS_SERVER, new Uint8Array(0))).toBe(true);
    expect(transmitAndDeliver(server, client, NetsrcT.NS_CLIENT, new Uint8Array(0))).toBe(true);
    expect(Netchan_NeedReliable(client)).toBe(true);

    // packet 4: the retransmit, carrying the original reliable byte again
    Netchan_Transmit(client, 0, new Uint8Array(0));
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    expect(Netchan_Process(server, net_message)).toBe(true);
    expect(MSG_ReadByte(net_message)).toBe(0xab);
  });

  test("Netchan_OutOfBandPrint sends a -1-sequence datagram", () => {
    const adr = loopbackAdr();
    Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, adr, "ping %i", 7);

    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    MSG_BeginReading(net_message);
    expect(MSG_ReadLong(net_message)).toBe(-1);

    const rest = net_message.data.slice(net_message.readcount, net_message.cursize);
    expect(new TextDecoder().decode(rest)).toBe("ping 7");
  });
});

// Real UDP: bound to 127.0.0.1 on ephemeral ports so the test never fights a
// real server for PORT_SERVER (27910). "port"/"ip" are pre-created here with
// CVAR_NOSET before NET_Config runs, so NET_OpenIP's own Cvar_Get calls just
// pick up these values instead of creating fresh ones (Cvar_Get never
// overwrites an existing cvar's value).
Cvar_Get("port", "0", CVAR_NOSET);
Cvar_Get("ip", "127.0.0.1", CVAR_NOSET);
const canBindUdp = await NET_Config(true)
  .then(() => NET_SocketBound(NetsrcT.NS_CLIENT) && NET_SocketBound(NetsrcT.NS_SERVER))
  .catch(() => false);

describe("real UDP transport (optional)", () => {
  test.skipIf(!canBindUdp)("sends and receives a real datagram over 127.0.0.1", async () => {
    const to = new NetadrT();
    to.type = NetadrtypeT.NA_IP;
    to.ip.set([127, 0, 0, 1]);
    to.port = NET_SocketPort(NetsrcT.NS_SERVER);

    const payload = new Uint8Array([9, 8, 7, 6]);
    NET_SendPacket(NetsrcT.NS_CLIENT, payload.length, payload, to);

    const from = new NetadrT();
    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(1400), 1400);

    let got = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (NET_GetPacket(NetsrcT.NS_SERVER, from, msg)) {
        got = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(got).toBe(true);
    expect(Array.from(msg.data.slice(0, msg.cursize))).toEqual([9, 8, 7, 6]);
    expect(from.type).toBe(NetadrtypeT.NA_IP);
    expect(from.ip[0]).toBe(127);

    await NET_Shutdown();
  });
});
