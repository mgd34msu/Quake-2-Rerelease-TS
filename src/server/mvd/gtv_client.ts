// GTV "connect out to a relay" role.
//
// PLACEMENT NOTE: the initial research brief for this unit expected this
// capability under src/server/mvd/client.c, but that C file (ported as
// ./client.ts in this port) is actually the CHANNEL container (mvd_t) --
// confirmed by reading inc/server/mvd/client.h, which declares no socket or
// connect-related functions. The real engine's only "connect out to a GTV
// server" implementation lives in the graphical CLIENT program
// (src/client/gtv.c), driven by its demo-recording UI (`gtv connect
// <host>`) -- not a headless dedicated-server module. This port has no
// graphical client demo-recording UI to hang that off of, so this file is a
// fresh, server-side connector that speaks the SAME wire handshake
// (sv_mvd.ts's GTV server side: magic exchange, GTC_HELLO/GTS_HELLO,
// GTC_STREAM_START/GTS_STREAM_START, GTS_STREAM_DATA), sufficient to prove
// the relay round-trips end to end (this unit's test/mvd.test.ts spawns a
// second bun process as the peer). It is not a literal port of
// src/client/gtv.c's UI-bound code.

import { TCP_Connect, TCP_Read, TCP_Write, TCP_IsClosed, TCP_Close } from "../../platform/net_tcp";
import { MVD_MAGIC, GtvServerOpT, GtvClientOpT, GTV_PROTOCOL_VERSION, GTF_DEFLATE } from "../../qcommon/protocol/mvd";
import { MvdChannelT, MVD_NewChannel } from "./client";
import { MVD_ParseMessage } from "./parse";

export enum GtvClientLinkStateT {
  CONNECTING,
  AWAITING_MAGIC_ECHO,
  AWAITING_HELLO,
  AWAITING_STREAM_START,
  STREAMING,
  CLOSED,
}

export interface GtvClientLinkT {
  connId: number;
  state: GtvClientLinkStateT;
  recvBuf: Uint8Array;
  channel: MvdChannelT;
  lastError: string | null;
  // GTF_DEFLATE (item 5, GTV hardening): true once the server's GTS_HELLO
  // reply echoes GTF_DEFLATE back -- every GTS_STREAM_DATA payload after
  // that point is an independent Bun.deflateSync block (see sv_mvd.ts's
  // writeGtvMessage for why "independent per message" rather than one
  // continuous zlib stream).
  deflate: boolean;
  requestDeflate: boolean;
  // GTC_HELLO's password field (item 5, GTV hardening) -- matched against
  // the server's sv_mvd_password cvar in sv_mvd.ts's authGtvClient.
  password: string;
}

function appendRecv(link: GtvClientLinkT, data: Uint8Array): void {
  const merged = new Uint8Array(link.recvBuf.length + data.length);
  merged.set(link.recvBuf, 0);
  merged.set(data, link.recvBuf.length);
  link.recvBuf = merged;
}

function writeFramedClientMessage(link: GtvClientLinkT, op: GtvClientOpT, body: Uint8Array): void {
  const header = new Uint8Array(2);
  new DataView(header.buffer).setUint16(0, body.length + 1, true);
  TCP_Write(link.connId, header);
  TCP_Write(link.connId, new Uint8Array([op, ...body]));
}

function encodeCString(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  bytes.push(0);
  return bytes;
}

function sendHello(link: GtvClientLinkT, password: string): void {
  const flags = link.requestDeflate ? GTF_DEFLATE : 0;
  const body: number[] = [];
  body.push(GTV_PROTOCOL_VERSION & 0xff, (GTV_PROTOCOL_VERSION >> 8) & 0xff); // word protocol
  body.push(flags & 0xff, (flags >> 8) & 0xff, (flags >> 16) & 0xff, (flags >> 24) & 0xff); // long flags
  body.push(0, 0, 0, 0); // long unused
  body.push(...encodeCString("quake-2-re-ts-mvd-test"));
  body.push(...encodeCString(password));
  body.push(...encodeCString("1.0")); // version
  writeFramedClientMessage(link, GtvClientOpT.GTC_HELLO, new Uint8Array(body));
}

function sendStreamStart(link: GtvClientLinkT): void {
  const body = new Uint8Array(2);
  new DataView(body.buffer).setUint16(0, 4, true); // maxbuf
  writeFramedClientMessage(link, GtvClientOpT.GTC_STREAM_START, body);
}

/*
==============
MVD_GtvConnect

Opens an outbound GTV connection and sends the initial magic bytes (the
client speaks first -- see sv_mvd.ts's accept_client/parse_message port).
Returns null if the TCP connect itself fails; the handshake continues
asynchronously via MVD_GtvPump.
==============
*/
export interface GtvConnectOptionsT {
  password?: string;
  requestDeflate?: boolean;
}

export async function MVD_GtvConnect(hostname: string, port: number, options: GtvConnectOptionsT = {}): Promise<GtvClientLinkT | null> {
  const connId = await TCP_Connect(hostname, port);
  if (connId === null) return null;

  const magic = new Uint8Array(4);
  new DataView(magic.buffer).setUint32(0, MVD_MAGIC, true);
  TCP_Write(connId, magic);

  return {
    connId,
    state: GtvClientLinkStateT.AWAITING_MAGIC_ECHO,
    recvBuf: new Uint8Array(0),
    channel: MVD_NewChannel(),
    lastError: null,
    deflate: false,
    requestDeflate: !!options.requestDeflate,
    password: options.password ?? "",
  };
}

/*
==============
MVD_GtvPump

Drains buffered bytes and advances the handshake state machine, feeding
every GTS_STREAM_DATA payload into the link's channel via MVD_ParseMessage.
Call repeatedly (e.g. in a polling loop) until `state === STREAMING` and
frames start arriving, or `state === CLOSED`.
==============
*/
export function MVD_GtvPump(link: GtvClientLinkT): void {
  if (link.state === GtvClientLinkStateT.CLOSED) return;

  if (TCP_IsClosed(link.connId)) {
    link.state = GtvClientLinkStateT.CLOSED;
    return;
  }

  const chunk = TCP_Read(link.connId);
  if (chunk) appendRecv(link, chunk);

  for (;;) {
    if (link.state === GtvClientLinkStateT.AWAITING_MAGIC_ECHO) {
      if (link.recvBuf.length < 4) return;
      const echoed = new DataView(link.recvBuf.buffer, link.recvBuf.byteOffset, 4).getUint32(0, true);
      link.recvBuf = link.recvBuf.subarray(4);
      if (echoed !== MVD_MAGIC) {
        link.lastError = "server echoed a bad magic";
        link.state = GtvClientLinkStateT.CLOSED;
        TCP_Close(link.connId);
        return;
      }
      link.state = GtvClientLinkStateT.AWAITING_HELLO;
      sendHello(link, link.password);
      continue;
    }

    if (link.recvBuf.length < 2) return;
    const msglen = new DataView(link.recvBuf.buffer, link.recvBuf.byteOffset, 2).getUint16(0, true);
    if (link.recvBuf.length < 2 + msglen) return;

    const body = link.recvBuf.subarray(2, 2 + msglen);
    link.recvBuf = link.recvBuf.subarray(2 + msglen);

    if (msglen === 0) {
      link.state = GtvClientLinkStateT.CLOSED;
      TCP_Close(link.connId);
      return;
    }

    const op = body[0];
    const payload = body.subarray(1);

    switch (op) {
      case GtvServerOpT.GTS_HELLO:
        if (link.state === GtvClientLinkStateT.AWAITING_HELLO) {
          // Echoed flags (sv_mvd.ts's handleGtvHello reply body): a single
          // long, GTF_DEFLATE bit0. Read in plaintext -- deflate does not
          // apply until AFTER this exact message (see sv_mvd.ts's
          // handleGtvHello for the matching ordering on the write side).
          const echoedFlags = payload.length >= 4 ? new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true) : 0;
          link.deflate = !!(echoedFlags & GTF_DEFLATE);
          link.state = GtvClientLinkStateT.AWAITING_STREAM_START;
          sendStreamStart(link);
        }
        break;
      case GtvServerOpT.GTS_STREAM_START:
        if (link.state === GtvClientLinkStateT.AWAITING_STREAM_START) {
          link.state = GtvClientLinkStateT.STREAMING;
        }
        break;
      case GtvServerOpT.GTS_STREAM_DATA:
        if (payload.length > 0) {
          // `new Uint8Array(payload)` copies into a fresh ArrayBuffer-backed
          // typed array -- see sv_mvd.ts's writeGtvMessage for the matching
          // write-side note on why Bun's zlib bindings need this copy.
          const decoded = link.deflate ? Bun.inflateSync(new Uint8Array(payload)) : payload;
          MVD_ParseMessage(link.channel, decoded);
        }
        break;
      case GtvServerOpT.GTS_BADREQUEST:
      case GtvServerOpT.GTS_NOACCESS:
      case GtvServerOpT.GTS_ERROR:
        link.lastError = `server rejected connection (op ${op})`;
        link.state = GtvClientLinkStateT.CLOSED;
        TCP_Close(link.connId);
        return;
      default:
        break;
    }
  }
}
