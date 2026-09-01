// net_chan.c
//
// packet header
// -------------
// 31	sequence
// 1	does this message contain a reliable payload
// 31	acknowledge sequence
// 1	acknowledge receipt of even/odd message
// 16	qport
//
// The remote connection never knows if it missed a reliable message, the
// local side detects that it has been dropped by seeing a sequence acknowledge
// higher thatn the last reliable sequence, but without the correct evon/odd
// bit for the reliable set.
//
// If the sender notices that a reliable message has been dropped, it will be
// retransmitted.  It will not be retransmitted again until a message after
// the retransmit has been acknowledged and the reliable still failed to get there.
//
// if the sequence number is -1, the packet should be handled without a netcon
//
// The reliable message can be added to at any time by doing
// MSG_Write* (&netchan->message, <data>).
//
// If the message buffer is overflowed, either by a single message, or by
// multiple frames worth piling up while the last reliable transmit goes
// unacknowledged, the netchan signals a fatal error.
//
// Reliable messages are always placed first in a packet, then the unreliable
// message is included if there is sufficient room.
//
// To the receiver, there is no distinction between the reliable and unreliable
// parts of the message, they are just processed out as a single larger message.
//
// Illogical packet sequence numbers cause the packet to be dropped, but do
// not kill the connection.  This, combined with the tight window of valid
// reliable acknowledgement numbers provides protection against malicious
// address spoofing.
//
// The qport field is a workaround for bad address translating routers that
// sometimes remap the client's source port on a packet during gameplay.
//
// If the base part of the net address matches and the qport matches, then the
// channel matches even if the IP port differs.  The IP port should be updated
// to the new value before sending out any replies.
//
// If there is no information that needs to be transfered on a given frame,
// such as during the connection stage while waiting for the client to load,
// then a packet only needs to be delivered if there is something in the
// unacknowledged reliable

import { NetadrT, NetsrcT, MAX_MSGLEN, PROTOCOL_VERSION, PROTOCOL_VERSION_R1Q2, SysError } from "./qcommon";
import { tryWrapZPacket } from "./protocol/zpacket";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_WriteLong, MSG_WriteShort, MSG_WriteByte, MSG_BeginReading, MSG_ReadLong, MSG_ReadShort, MSG_ReadByte, stringToBytes } from "./sizebuf";
import { Cvar_Get } from "./cvar";
import { Com_Printf } from "./common";
import { curtime } from "../platform/sys";
import { type CvarT, Com_sprintf, CVAR_NOSET } from "../shared/q_shared";
import { NET_SendPacket, NET_AdrToString } from "../platform/net_udp";

// net_from/net_message/net_message_buffer are declared (not just extern'd) in
// net_chan.c, so this is their owning module. The original leaves them
// uninitialized until sv_main.c/cl_main.c's Init routines call SZ_Init on
// net_message -- those modules are not yet ported, so net_message is
// initialized eagerly here instead; see report.
export const net_from: NetadrT = new NetadrT();
export const net_message_buffer: Uint8Array = new Uint8Array(MAX_MSGLEN);
export const net_message: SizeBuf = new SizeBuf();
SZ_Init(net_message, net_message_buffer, net_message_buffer.length);

export let showpackets: CvarT | null = null;
export let showdrop: CvarT | null = null;
export let qport: CvarT | null = null;

// q2repro's own packet-size ladder (inc/common/net/net.h:29-34). Needed here
// because NETCHAN_NEW splits any write larger than maxpacketlen into
// fragments, so "how big may one datagram's payload be" becomes a real
// per-connection number rather than an implicit MAX_MSGLEN.
export const MAX_PACKETLEN = 4096; // max length of a single packet
export const PACKET_HEADER = 10; // two ints and a short (worst case)
export const MAX_PACKETLEN_DEFAULT = 1400; // default quake2 limit
export const MAX_PACKETLEN_WRITABLE_DEFAULT = MAX_PACKETLEN_DEFAULT - PACKET_HEADER;
// net.h:33-34's other two ladder rungs, needed once packet_length actually
// gets negotiated (sv_main.ts's SVC_DirectConnect / cl_main.ts's
// CL_SendConnectPacket): MAX_PACKETLEN_WRITABLE (4086) is the hard ceiling a
// client may ever request (server/main.c:749's `p->maxlength >
// MAX_PACKETLEN_WRITABLE` reject, and cl_main's own loopback request value,
// client/main.c:461); MIN_PACKETLEN (512) is the floor a negotiated value is
// clamped up to (server/main.c:763-764).
export const MAX_PACKETLEN_WRITABLE = MAX_PACKETLEN - PACKET_HEADER;
export const MIN_PACKETLEN = 512; // don't allow smaller packets (net.h:29)

// q2repro's MAX_MSGLEN (inc/common/protocol.h:25, 0x8000) -- the capacity its
// Netchan_Setup gives fragment_in/fragment_out, and the size of the
// msg_read_buffer a reassembled message is handed back in. This port's own
// MAX_MSGLEN is vanilla's 1400, which is the SINGLE-DATAGRAM limit and
// deliberately not changed here; a reassembled NETCHAN_NEW message is by
// definition larger than one datagram, so it needs the C's real number.
export const MAX_FRAGMENT_MSGLEN = 0x8000;

// q2repro's msg_read_buffer equivalent for reassembled NETCHAN_NEW messages:
// a message that arrived as fragments is by definition larger than one
// datagram, so it cannot be handed back in net_message_buffer. Netchan_Process
// re-inits the caller's SizeBuf over this buffer once a fragmented message is
// complete, exactly as chan.c:643-645's SZ_InitRead does.
const net_message_assembled_buffer: Uint8Array = new Uint8Array(MAX_FRAGMENT_MSGLEN);

// RULE-17 FINDING (phase-8 q2repro interop, matrix cell a): a real q2repro
// client negotiating protocol 1038 (or 36/Q2PRO) never uses the classic
// header this file previously implemented unconditionally. q2repro's own
// src/common/net/chan.c defines TWO wire framings selected per-connection
// (inc/common/net/chan.h's netchan_type_t): NETCHAN_OLD (this file's
// pre-existing behavior -- unconditional 16-bit qport, reliable flag in bit
// 31) and NETCHAN_NEW (qport is a SINGLE byte, written only when nonzero,
// and bit 30 of both sequence longs is reserved as a fragmentation flag
// FRG_BIT so usable sequence numbers are 30 bits instead of 31 -- chan.c:
// 98-101's REL_BIT/FRG_BIT/OLD_MASK/NEW_MASK). Confirmed by capturing a real
// q2repro binary: with only NETCHAN_OLD implemented, its client's post-
// connect packets were silently dropped by SV_ReadPackets' qport check
// (reading a 16-bit field where the client wrote a 1-byte one), so the
// client never advanced past "Connected to ..." even though every server
// send succeeded. Q2PRO and the kex/rerelease family both request
// NETCHAN_NEW (q2repro's src/client/main.c CL_CheckForResend: `type =
// (cls.serverProtocol == PROTOCOL_VERSION_Q2PRO || == PROTOCOL_VERSION_
// RERELEASE) ? NETCHAN_NEW : NETCHAN_OLD`); vanilla and R1Q2 stay
// NETCHAN_OLD. NETCHAN_NEW fragmentation (send-side splitting and receive-
// side reassembly) is implemented below, ported from chan.c's
// Netchan_TransmitNextFragment / NetchanNew_Transmit / NetchanNew_Process.
//
// SECOND RULE-17 FINDING (protocol-35 spawn diagnosis): the qport field's
// WIDTH is NOT a function of the netchan type. chan.c's NetchanOld_Transmit
// (lines 212-221) and NetchanOld_Process (lines 275-282) both branch on the
// PROTOCOL instead -- `if (chan->protocol < PROTOCOL_VERSION_R1Q2)
// SZ_WriteShort(qport); else if (chan->qport) SZ_WriteByte(qport);` -- so
// R1Q2 (35) runs NETCHAN_OLD framing with a SINGLE-BYTE qport. Keying the
// width on NETCHAN_OLD/NETCHAN_NEW happens to be right for 34, 36 and 1038
// and is wrong for exactly one protocol, 35, which is why a real q2repro
// client negotiating 35 connected and then never spawned: its first
// post-connect packet carried `01 00 00 80 | 00 00 00 00 | 6a | 04 "new"`
// -- a one-byte qport 0x6a -- and this server consumed two bytes for it, so
// SV_ReadPackets' qport comparison saw 0x046a and dropped every packet the
// client ever sent. Confirmed live with a byte-level capture; the client
// then sent `clc_stringcmd "disconnect"` and quit on its own connect
// timeout, which is the "exits silently within seconds" symptom. NetchanT
// therefore carries `protocol` exactly as netchan_t does (chan.h:32).
export const NETCHAN_OLD = 0;
export const NETCHAN_NEW = 1;
export type NetchanTypeT = typeof NETCHAN_OLD | typeof NETCHAN_NEW;

// bit 31 = REL_BIT, bit 30 = FRG_BIT (NETCHAN_NEW only). `1 << 31` is
// negative in JS's 32-bit signed bitwise ops, so the masks below are spelled
// as hex literals rather than derived via arithmetic on that shift.
const REL_BIT = 0x80000000;
const FRG_BIT = 0x40000000;
const OLD_MASK = 0x7fffffff; // 31 usable sequence bits (bit 31 = REL_BIT)
const NEW_MASK = 0x3fffffff; // 30 usable sequence bits (bit 31 = REL_BIT, bit 30 = FRG_BIT)

function mustCvar(name: string, value: string, flags: number): CvarT {
  const v = Cvar_Get(name, value, flags);
  if (!v) {
    throw new SysError(`Netchan_Init: Cvar_Get(\"${name}\") failed`);
  }
  return v;
}

// netchan_t
export class NetchanT {
  fatal_error = false;

  sock: NetsrcT = NetsrcT.NS_CLIENT;
  type: NetchanTypeT = NETCHAN_OLD;
  // netchan_t::protocol (q2repro inc/common/net/chan.h:32) -- the negotiated
  // major protocol version, read only by the qport-width branches (see
  // NETCHAN_NEW's doc comment above).
  protocol: number = PROTOCOL_VERSION;
  // netchan_t::maxpacketlen (chan.h:33) -- largest payload one datagram may
  // carry before NETCHAN_NEW splits the write into fragments.
  maxpacketlen: number = MAX_PACKETLEN_WRITABLE_DEFAULT;

  dropped = 0; // between last packet and previous

  last_received = 0; // for timeouts
  last_sent = 0; // for retransmits

  remote_address: NetadrT = new NetadrT();
  qport = 0; // qport value to write when transmitting

  // sequencing variables
  incoming_sequence = 0;
  incoming_acknowledged = 0;
  incoming_reliable_acknowledged = 0; // single bit

  incoming_reliable_sequence = 0; // single bit, maintained local

  outgoing_sequence = 0;
  reliable_sequence = 0; // single bit
  last_reliable_sequence = 0; // sequence number of last send

  // reliable staging and holding areas
  message: SizeBuf = new SizeBuf(); // writing buffer to send to server
  message_buf: Uint8Array = new Uint8Array(MAX_MSGLEN - 16); // leave space for header

  // message is copied to this buffer when it is first transfered
  reliable_length = 0;
  reliable_buf: Uint8Array = new Uint8Array(MAX_MSGLEN - 16); // unacked reliable message

  // NETCHAN_NEW fragmentation state (q2repro chan.h:47-51). fragment_in
  // accumulates an inbound multi-packet message; fragment_out holds the
  // outbound one still being drained by Netchan_TransmitNextFragment.
  fragment_sequence = 0;
  fragment_pending = false;
  fragment_in: SizeBuf = new SizeBuf();
  fragment_in_buf: Uint8Array = new Uint8Array(0);
  fragment_out: SizeBuf = new SizeBuf();
  fragment_out_buf: Uint8Array = new Uint8Array(0);

  // v1.0.0 wire cluster (task board #23): true when this connection's
  // negotiated protocol both understands svc_r1q2_zpacket and has it turned
  // on (R1Q2: always; Q2PRO: only when the client's connect string set its
  // zlib token -- see qcommon/protocol/zpacket.ts's header comment). Set by
  // sv_main.ts's SVC_DirectConnect; read only by Netchan_Transmit below, and
  // only on the server side (chan.sock === NetsrcT.NS_SERVER) -- this engine
  // never compresses a client's OUTGOING (clc_*) reliable traffic, matching
  // every protocol this port studied (svc_zpacket is a server-to-client
  // opcode only).
  compress = false;
}

export function Netchan_Init(): void {
  // pick a port value that should be nice and random. The C version seeds
  // this from Sys_Milliseconds() & 0xffff; ported to Math.random() per brief
  // (same 0-65535 range intent, no seeded-determinism requirement here).
  const port = Math.floor(Math.random() * 0x10000);

  showpackets = mustCvar("showpackets", "0", 0);
  showdrop = mustCvar("showdrop", "0", 0);
  // q2repro src/common/net/chan.c:129 flags qport 0, not CVAR_NOSET
  // (cvar-parity fix).
  qport = mustCvar("qport", Com_sprintf("%i", port), 0);
  // q2repro src/common/net/chan.c:130-132. Registered, consumer unported:
  // net_maxmsglen (a receive-side message-length clamp) and net_chantype
  // (selects the legacy vs. "new" netchan wire format) have no gate in this
  // port's Netchan_Transmit/Netchan_Process -- chanType is always chosen by
  // the caller (see NETCHAN_NEW's doc comment above), never by a cvar.
  mustCvar("net_maxmsglen", "1390", 0); // MAX_PACKETLEN_WRITABLE_DEFAULT = 1400 - 10 (inc/common/net/net.h:31-34)
  mustCvar("net_chantype", "1", 0);
}

// Sends an out-of-band datagram
export function Netchan_OutOfBand(net_socket: NetsrcT, adr: NetadrT, length: number, data: Uint8Array): void {
  const send_buf = new Uint8Array(MAX_MSGLEN);
  const send = new SizeBuf();

  // write the packet header
  SZ_Init(send, send_buf, send_buf.length);

  MSG_WriteLong(send, -1); // -1 sequence means out of band
  SZ_Write(send, data, length);

  // send the datagram
  NET_SendPacket(net_socket, send.cursize, send.data, adr);
}

// Sends a text message in an out-of-band datagram
export function Netchan_OutOfBandPrint(net_socket: NetsrcT, adr: NetadrT, format: string, ...args: Array<string | number>): void {
  const s = Com_sprintf(format, ...args);
  const bytes = stringToBytes(s);
  Netchan_OutOfBand(net_socket, adr, bytes.length, bytes);
}

// called to open a channel to a remote system. `chanType` defaults to
// NETCHAN_OLD so every pre-existing call site (vanilla/R1Q2 server dispatch,
// this port's own client connect flow) keeps its prior behavior unchanged;
// only kex-family and Q2PRO connections pass NETCHAN_NEW explicitly (see
// NETCHAN_NEW's doc comment above).
// `protocolVersion` likewise defaults to PROTOCOL_VERSION (34) so a caller
// that doesn't know its negotiated protocol keeps the classic 16-bit qport
// field; every caller that CAN know it must pass it, because 35 needs the
// one-byte form (see NETCHAN_NEW's doc comment).
export function Netchan_Setup(
  sock: NetsrcT,
  chan: NetchanT,
  adr: NetadrT,
  qportNum: number,
  chanType: NetchanTypeT = NETCHAN_OLD,
  protocolVersion: number = PROTOCOL_VERSION,
  maxpacketlen: number = MAX_PACKETLEN_WRITABLE_DEFAULT,
): void {
  chan.fatal_error = false;
  chan.dropped = 0;
  chan.last_sent = 0;

  chan.sock = sock;
  chan.type = chanType;
  chan.protocol = protocolVersion;
  chan.maxpacketlen = maxpacketlen;
  chan.remote_address = adr;
  chan.qport = qportNum;
  chan.last_received = curtime.value;
  chan.incoming_sequence = 0;
  chan.outgoing_sequence = 1;

  chan.incoming_acknowledged = 0;
  chan.incoming_reliable_acknowledged = 0;
  chan.incoming_reliable_sequence = 0;
  chan.reliable_sequence = 0;
  chan.last_reliable_sequence = 0;

  chan.reliable_length = 0;
  chan.message_buf = new Uint8Array(MAX_MSGLEN - 16);
  chan.reliable_buf = new Uint8Array(MAX_MSGLEN - 16);

  chan.message = new SizeBuf();
  SZ_Init(chan.message, chan.message_buf, chan.message_buf.length);
  chan.message.allowoverflow = true;

  // Netchan_Setup's `case NETCHAN_NEW:` arm allocates fragment_in/
  // fragment_out (chan.c:735-740); NETCHAN_OLD gets neither.
  chan.fragment_sequence = 0;
  chan.fragment_pending = false;
  if (chanType === NETCHAN_NEW) {
    chan.fragment_in_buf = new Uint8Array(MAX_FRAGMENT_MSGLEN);
    chan.fragment_out_buf = new Uint8Array(MAX_FRAGMENT_MSGLEN);
  } else {
    chan.fragment_in_buf = new Uint8Array(0);
    chan.fragment_out_buf = new Uint8Array(0);
  }
  chan.fragment_in = new SizeBuf();
  chan.fragment_out = new SizeBuf();
  SZ_Init(chan.fragment_in, chan.fragment_in_buf, chan.fragment_in_buf.length);
  SZ_Init(chan.fragment_out, chan.fragment_out_buf, chan.fragment_out_buf.length);
}

// The qport field, written by the client only. Three-way exactly as the C
// spells it across NetchanNew_Transmit (chan.c:503-508) and
// NetchanOld_Transmit (chan.c:212-221): NETCHAN_NEW always uses the one-byte
// conditional form; NETCHAN_OLD uses a 16-bit short below R1Q2 and the same
// one-byte conditional form at R1Q2 and above.
//
// The VALUE still comes from the `qport` cvar rather than chan.qport (which
// is what q2repro reads) because this port's client never populates
// cls.quakePort -- its connect string advertises the cvar, so the cvar is
// what keeps the two self-consistent. See report.
function writeQport(send: SizeBuf, chan: NetchanT): void {
  if (chan.sock !== NetsrcT.NS_CLIENT) return;
  const qportValue = qport ? qport.value : 0;
  // The one-byte forms test the MASKED value for "is there a field at all",
  // exactly as q2repro's `if (chan->qport)` does -- chan->qport there is
  // already the &0xff value q2proto put in the connect string
  // (q2proto_proto_r1q2.c:49 / q2proto_proto_q2pro.c:71 /
  // q2proto_proto_q2repro.c:47), and cl_main.ts's CL_SendConnectPacket now
  // advertises the same masked value. Testing the UNMASKED value here would
  // emit a 0x00 qport byte for e.g. qport 512 while telling the server its
  // qport is 0 -- the server would then read no byte and misparse everything
  // that follows.
  const qportByte = qportValue & 0xff;
  if (chan.type === NETCHAN_NEW) {
    if (qportByte) MSG_WriteByte(send, qportByte);
  } else if (chan.protocol < PROTOCOL_VERSION_R1Q2) {
    MSG_WriteShort(send, qportValue);
  } else if (qportByte) {
    MSG_WriteByte(send, qportByte);
  }
}

/*
===============
Netchan_TransmitNextFragment
================
*/
export function Netchan_TransmitNextFragment(chan: NetchanT): void {
  const send_reliable = chan.reliable_length !== 0;

  // write the packet header
  let w1 = (chan.outgoing_sequence & NEW_MASK) | FRG_BIT;
  if (send_reliable) w1 |= REL_BIT;

  let w2 = chan.incoming_sequence & NEW_MASK;
  if (chan.incoming_reliable_sequence) w2 |= REL_BIT;

  const send_buf = new Uint8Array(MAX_PACKETLEN);
  const send = new SizeBuf();
  SZ_Init(send, send_buf, send_buf.length);

  MSG_WriteLong(send, w1);
  MSG_WriteLong(send, w2);

  writeQport(send, chan);

  let fragment_length = chan.fragment_out.cursize - chan.fragment_out.readcount;
  if (fragment_length > chan.maxpacketlen) fragment_length = chan.maxpacketlen;

  let more_fragments = true;
  if (chan.fragment_out.readcount + fragment_length === chan.fragment_out.cursize) more_fragments = false;

  // write fragment offset
  let offset = chan.fragment_out.readcount & 0x7fff;
  if (more_fragments) offset |= 0x8000;
  MSG_WriteShort(send, offset);

  // write fragment contents
  SZ_Write(send, chan.fragment_out.data.subarray(chan.fragment_out.readcount, chan.fragment_out.readcount + fragment_length), fragment_length);

  if (showpackets && showpackets.value) {
    Com_Printf(
      "send %4i : s=%i ack=%i rack=%i fragment_offset=%i more_fragments=%i\n",
      send.cursize,
      chan.outgoing_sequence,
      chan.incoming_sequence,
      chan.incoming_reliable_sequence,
      chan.fragment_out.readcount,
      more_fragments ? 1 : 0,
    );
  }

  chan.fragment_out.readcount += fragment_length;
  chan.fragment_pending = more_fragments;

  // if the message has been sent completely, clear the fragment buffer
  if (!chan.fragment_pending) {
    chan.outgoing_sequence++;
    chan.last_sent = curtime.value;
    SZ_Clear(chan.fragment_out);
    chan.fragment_out.readcount = 0;
  }

  // send the datagram
  NET_SendPacket(chan.sock, send.cursize, send.data, chan.remote_address);
}

// Returns true if the last reliable message has acked
export function Netchan_CanReliable(chan: NetchanT): boolean {
  if (chan.reliable_length) return false; // waiting for ack
  return true;
}

export function Netchan_NeedReliable(chan: NetchanT): boolean {
  // if the remote side dropped the last reliable message, resend it
  let send_reliable = false;

  if (chan.incoming_acknowledged > chan.last_reliable_sequence && chan.incoming_reliable_acknowledged !== chan.reliable_sequence) {
    send_reliable = true;
  }

  // if the reliable transmit buffer is empty, copy the current message out
  if (!chan.reliable_length && chan.message.cursize) {
    send_reliable = true;
  }

  return send_reliable;
}

// tries to send an unreliable message to a connection, and handles the
// transmition / retransmition of the reliable messages.
//
// A 0 length will still generate a packet and deal with the reliable messages.
export function Netchan_Transmit(chan: NetchanT, length: number, data: Uint8Array): void {
  // check for message overflow
  if (chan.message.overflowed) {
    chan.fatal_error = true;
    Com_Printf("%s:Outgoing message overflow\n", NET_AdrToString(chan.remote_address));
    return;
  }

  // NetchanNew_Transmit's very first statement (chan.c:456-458): a partially
  // drained fragmented message owns the wire until it is finished, and THIS
  // call's unreliable payload is dropped on the floor to make that happen.
  if (chan.type === NETCHAN_NEW && chan.fragment_pending) {
    Netchan_TransmitNextFragment(chan);
    return;
  }

  const send_reliable = Netchan_NeedReliable(chan);

  if (!chan.reliable_length && chan.message.cursize) {
    // svc_zpacket wrap point (v1.0.0 wire cluster, task board #23) -- see
    // qcommon/protocol/zpacket.ts's header comment for why THIS is the one
    // choke point in this codebase's architecture that corresponds to
    // q2proto's own per-write compression gating. Server-side only
    // (svc_zpacket is a server-to-client opcode); `chan.compress` is only
    // ever set true on a server-side NetchanT (sv_main.ts's
    // SVC_DirectConnect), so the `chan.sock` check is redundant defense, not
    // load-bearing, but kept explicit for the reader.
    const wrapped =
      chan.compress && chan.sock === NetsrcT.NS_SERVER
        ? tryWrapZPacket(chan.message_buf, chan.message.cursize, chan.reliable_buf.length)
        : null;
    if (wrapped) {
      chan.reliable_buf.set(wrapped);
      chan.reliable_length = wrapped.length;
    } else {
      chan.reliable_buf.set(chan.message_buf.subarray(0, chan.message.cursize));
      chan.reliable_length = chan.message.cursize;
    }
    chan.message.cursize = 0;
    chan.reliable_sequence ^= 1;
  }

  // NETCHAN_NEW: a write that cannot fit one datagram goes out as fragments
  // instead (chan.c:475-487). NETCHAN_OLD has no such path -- vanilla simply
  // prints "dumped unreliable" below and loses the payload.
  if (chan.type === NETCHAN_NEW && (length > chan.maxpacketlen || (send_reliable && chan.reliable_length + length > chan.maxpacketlen))) {
    if (send_reliable) {
      chan.last_reliable_sequence = chan.outgoing_sequence;
      SZ_Write(chan.fragment_out, chan.reliable_buf, chan.reliable_length);
    }
    // add the unreliable part if space is available
    if (chan.fragment_out.maxsize - chan.fragment_out.cursize >= length) {
      SZ_Write(chan.fragment_out, data, length);
    } else {
      Com_Printf("%s: dumped unreliable\n", NET_AdrToString(chan.remote_address));
    }
    Netchan_TransmitNextFragment(chan);
    return;
  }

  // write the packet header. Sized to MAX_PACKETLEN (4096), not MAX_MSGLEN
  // (1400): chan.c's NetchanOld_Transmit and NetchanNew_Transmit both
  // declare `byte send_buf[MAX_PACKETLEN]` (chan.c:177, chan.c:449) --
  // exactly what Netchan_TransmitNextFragment above already uses. A fixed
  // MAX_MSGLEN buffer here silently truncated (via the "dumped unreliable"
  // branch below) any connection that negotiated a packet_length above 1390
  // (e.g. a loopback kex client's MAX_PACKETLEN_WRITABLE request, 4086 --
  // see sv_main.ts's SVC_DirectConnect / cl_main.ts's CL_SendConnectPacket).
  const send_buf = new Uint8Array(MAX_PACKETLEN);
  const send = new SizeBuf();
  SZ_Init(send, send_buf, send_buf.length);

  const seqMask = chan.type === NETCHAN_NEW ? NEW_MASK : OLD_MASK;
  const sendReliableBit = send_reliable ? 1 : 0;
  const w1 = (chan.outgoing_sequence & seqMask) | (sendReliableBit << 31);
  const w2 = (chan.incoming_sequence & seqMask) | (chan.incoming_reliable_sequence << 31);

  chan.outgoing_sequence++;
  chan.last_sent = curtime.value;

  MSG_WriteLong(send, w1);
  MSG_WriteLong(send, w2);

  // send the qport if we are a client (width per writeQport's doc comment)
  writeQport(send, chan);

  // copy the reliable message to the packet first
  if (send_reliable) {
    SZ_Write(send, chan.reliable_buf, chan.reliable_length);
    chan.last_reliable_sequence = chan.outgoing_sequence;
  }

  // add the unreliable part if space is available
  if (send.maxsize - send.cursize >= length) {
    SZ_Write(send, data, length);
  } else {
    Com_Printf("Netchan_Transmit: dumped unreliable\n");
  }

  // send the datagram
  NET_SendPacket(chan.sock, send.cursize, send.data, chan.remote_address);

  if (showpackets && showpackets.value) {
    if (send_reliable) {
      Com_Printf(
        "send %4i : s=%i reliable=%i ack=%i rack=%i\n",
        send.cursize,
        chan.outgoing_sequence - 1,
        chan.reliable_sequence,
        chan.incoming_sequence,
        chan.incoming_reliable_sequence,
      );
    } else {
      Com_Printf("send %4i : s=%i ack=%i rack=%i\n", send.cursize, chan.outgoing_sequence - 1, chan.incoming_sequence, chan.incoming_reliable_sequence);
    }
  }
}

// called when the current net_message is from remote_address
// modifies net_message so that it points to the packet payload
export function Netchan_Process(chan: NetchanT, msg: SizeBuf): boolean {
  // get sequence numbers
  MSG_BeginReading(msg);
  let sequence = MSG_ReadLong(msg);
  let sequence_ack = MSG_ReadLong(msg);

  // read the qport if we are a server. Mirrors NetchanNew_Process
  // (chan.c:551-554) and NetchanOld_Process (chan.c:275-282) exactly: the
  // one-byte conditional form under NETCHAN_NEW and under NETCHAN_OLD from
  // R1Q2 up, the unconditional 16-bit short only below R1Q2.
  if (chan.sock === NetsrcT.NS_SERVER) {
    if (chan.type === NETCHAN_NEW) {
      if (chan.qport) MSG_ReadByte(msg); // qport -- read to consume the header byte, unused here (see report)
    } else if (chan.protocol < PROTOCOL_VERSION_R1Q2) {
      MSG_ReadShort(msg); // qport -- read to consume the header bytes, unused here (see report)
    } else if (chan.qport) {
      MSG_ReadByte(msg); // qport -- read to consume the header byte, unused here (see report)
    }
  }

  const seqMask = chan.type === NETCHAN_NEW ? NEW_MASK : OLD_MASK;
  const reliable_message = (sequence >>> 31) & 1;
  const reliable_ack = (sequence_ack >>> 31) & 1;
  // NETCHAN_NEW: bit 30 (FRG_BIT) marks a fragmented packet, whose header
  // carries an extra 16-bit offset word before the payload.
  const fragmented_message = chan.type === NETCHAN_NEW && (sequence & FRG_BIT) !== 0;

  sequence &= seqMask;
  sequence_ack &= seqMask;

  let fragment_offset = 0;
  let more_fragments = false;
  if (fragmented_message) {
    fragment_offset = MSG_ReadShort(msg) & 0xffff;
    more_fragments = (fragment_offset & 0x8000) !== 0;
    fragment_offset &= 0x7fff;
  }

  if (msg.readcount > msg.cursize) {
    if (showdrop && showdrop.value) {
      Com_Printf("%s: message too short\n", NET_AdrToString(chan.remote_address));
    }
    return false;
  }

  if (showpackets && showpackets.value) {
    if (reliable_message) {
      Com_Printf("recv %4i : s=%i reliable=%i ack=%i rack=%i\n", msg.cursize, sequence, chan.incoming_reliable_sequence ^ 1, sequence_ack, reliable_ack);
    } else {
      Com_Printf("recv %4i : s=%i ack=%i rack=%i\n", msg.cursize, sequence, sequence_ack, reliable_ack);
    }
  }

  //
  // discard stale or duplicated packets
  //
  if (sequence <= chan.incoming_sequence) {
    if (showdrop && showdrop.value) {
      Com_Printf("%s:Out of order packet %i at %i\n", NET_AdrToString(chan.remote_address), sequence, chan.incoming_sequence);
    }
    return false;
  }

  //
  // dropped packets don't keep the message from being used
  //
  chan.dropped = sequence - (chan.incoming_sequence + 1);
  if (chan.dropped > 0) {
    if (showdrop && showdrop.value) {
      Com_Printf("%s:Dropped %i packets at %i\n", NET_AdrToString(chan.remote_address), chan.dropped, sequence);
    }
  }

  //
  // if the current outgoing reliable message has been acknowledged
  // clear the buffer to make way for the next
  //
  if (reliable_ack === chan.reliable_sequence) {
    chan.reliable_length = 0; // it has been received
  }

  //
  // parse fragment header, if any
  //
  if (fragmented_message) {
    if (chan.fragment_sequence !== sequence) {
      // start new receive sequence
      chan.fragment_sequence = sequence;
      SZ_Clear(chan.fragment_in);
    }

    if (fragment_offset < chan.fragment_in.cursize) {
      if (showdrop && showdrop.value) {
        Com_Printf("%s: out of order fragment at %i\n", NET_AdrToString(chan.remote_address), sequence);
      }
      return false;
    }

    if (fragment_offset > chan.fragment_in.cursize) {
      if (showdrop && showdrop.value) {
        Com_Printf("%s: dropped fragment(s) at %i\n", NET_AdrToString(chan.remote_address), sequence);
      }
      return false;
    }

    const length = msg.cursize - msg.readcount;
    if (length > chan.fragment_in.maxsize - chan.fragment_in.cursize) {
      if (showdrop && showdrop.value) {
        Com_Printf("%s: oversize fragment at %i\n", NET_AdrToString(chan.remote_address), sequence);
      }
      return false;
    }

    SZ_Write(chan.fragment_in, msg.data.subarray(msg.readcount, msg.readcount + length), length);
    if (more_fragments) return false;

    // message has been successfully assembled. The C re-inits msg_read over
    // its own msg_read_buffer (chan.c:643-645); this port's net_message is
    // only MAX_MSGLEN (1400) wide, so the assembled message is handed back in
    // a dedicated buffer of q2repro's real MAX_MSGLEN instead -- see
    // MAX_FRAGMENT_MSGLEN's doc comment.
    const assembled = chan.fragment_in.cursize;
    net_message_assembled_buffer.set(chan.fragment_in.data.subarray(0, assembled), 0);
    SZ_Init(msg, net_message_assembled_buffer, net_message_assembled_buffer.length);
    msg.cursize = assembled;
    msg.readcount = 0;
    SZ_Clear(chan.fragment_in);
  }

  //
  // if this message contains a reliable message, bump incoming_reliable_sequence
  //
  chan.incoming_sequence = sequence;
  chan.incoming_acknowledged = sequence_ack;
  chan.incoming_reliable_acknowledged = reliable_ack;
  if (reliable_message) {
    chan.incoming_reliable_sequence ^= 1;
  }

  //
  // the message can now be read from the current message pointer
  //
  chan.last_received = curtime.value;

  return true;
}
