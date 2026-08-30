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

import { NetadrT, NetsrcT, MAX_MSGLEN, SysError } from "./qcommon";
import { SizeBuf, SZ_Init, SZ_Write, MSG_WriteLong, MSG_WriteShort, MSG_BeginReading, MSG_ReadLong, MSG_ReadShort, stringToBytes } from "./sizebuf";
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
}

export function Netchan_Init(): void {
  // pick a port value that should be nice and random. The C version seeds
  // this from Sys_Milliseconds() & 0xffff; ported to Math.random() per brief
  // (same 0-65535 range intent, no seeded-determinism requirement here).
  const port = Math.floor(Math.random() * 0x10000);

  showpackets = mustCvar("showpackets", "0", 0);
  showdrop = mustCvar("showdrop", "0", 0);
  qport = mustCvar("qport", Com_sprintf("%i", port), CVAR_NOSET);
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

// called to open a channel to a remote system
export function Netchan_Setup(sock: NetsrcT, chan: NetchanT, adr: NetadrT, qportNum: number): void {
  chan.fatal_error = false;
  chan.dropped = 0;
  chan.last_sent = 0;

  chan.sock = sock;
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

  const send_reliable = Netchan_NeedReliable(chan);

  if (!chan.reliable_length && chan.message.cursize) {
    chan.reliable_buf.set(chan.message_buf.subarray(0, chan.message.cursize));
    chan.reliable_length = chan.message.cursize;
    chan.message.cursize = 0;
    chan.reliable_sequence ^= 1;
  }

  // write the packet header
  const send_buf = new Uint8Array(MAX_MSGLEN);
  const send = new SizeBuf();
  SZ_Init(send, send_buf, send_buf.length);

  const sendReliableBit = send_reliable ? 1 : 0;
  const w1 = (chan.outgoing_sequence & ~(1 << 31)) | (sendReliableBit << 31);
  const w2 = (chan.incoming_sequence & ~(1 << 31)) | (chan.incoming_reliable_sequence << 31);

  chan.outgoing_sequence++;
  chan.last_sent = curtime.value;

  MSG_WriteLong(send, w1);
  MSG_WriteLong(send, w2);

  // send the qport if we are a client
  if (chan.sock === NetsrcT.NS_CLIENT) {
    MSG_WriteShort(send, qport ? qport.value : 0);
  }

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

  // read the qport if we are a server
  if (chan.sock === NetsrcT.NS_SERVER) {
    MSG_ReadShort(msg); // qport -- read to consume the header bytes, unused here (see report)
  }

  const reliable_message = (sequence >>> 31) & 1;
  const reliable_ack = (sequence_ack >>> 31) & 1;

  sequence &= ~(1 << 31);
  sequence_ack &= ~(1 << 31);

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
