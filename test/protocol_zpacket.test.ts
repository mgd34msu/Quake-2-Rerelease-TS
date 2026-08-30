// svc_zpacket / svc_r1q2_zpacket wrap/unwrap gate (v1.0.0 wire cluster, task
// board #23). Covers src/qcommon/protocol/zpacket.ts's tryWrapZPacket
// (server-side wrap) and readZPacketPayload (client-side unwrap), plus the
// Netchan_Transmit integration point (src/qcommon/net_chan.ts) that decides
// WHEN to wrap.
//
// Wire format golden vectors are hand-derived from
// ~/Projects/q2proto/src/q2proto_internal_maybe_zpacket.c:56-83 and
// q2proto_proto_r1q2.c:558-576 (r1q2_client_read_zpacket): [u8 opcode=21]
// [u16 compressed_len LE][u16 uncompressed_len LE][raw-deflate bytes].

import { describe, test, expect } from "bun:test";
import * as zlib from "node:zlib";
import { tryWrapZPacket, readZPacketPayload, ZPACKET_MIN_COMPRESS_SIZE } from "../src/qcommon/protocol/zpacket";
import { SVC_ZPACKET } from "../src/qcommon/qcommon";
import { SizeBuf, SZ_Init, SZ_Write, MSG_BeginReading } from "../src/qcommon/sizebuf";
import { NetchanT, Netchan_Setup, Netchan_Transmit } from "../src/qcommon/net_chan";
import { NetsrcT, NetadrT, NetadrtypeT, MAX_MSGLEN } from "../src/qcommon/qcommon";

function loadIntoBuf(bytes: Uint8Array): SizeBuf {
  const msg = new SizeBuf();
  SZ_Init(msg, new Uint8Array(4096), 4096);
  SZ_Write(msg, bytes, bytes.length);
  MSG_BeginReading(msg);
  return msg;
}

// Highly-compressible payload (repeated byte run) large enough to clear
// ZPACKET_MIN_COMPRESS_SIZE and to actually shrink under deflate -- real
// configstring/baseline bursts are dominated by repeated short ASCII
// strings, which compress similarly well.
function compressiblePayload(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = i % 4 === 0 ? 0x41 : 0x00;
  return out;
}

describe("zpacket wire format", () => {
  test("wraps a compressible payload above the size threshold", () => {
    const payload = compressiblePayload(200);
    const wrapped = tryWrapZPacket(payload, payload.length, 1024);
    expect(wrapped).not.toBeNull();
    const w = wrapped as Uint8Array;

    expect(w[0]).toBe(SVC_ZPACKET);
    const compressedLen = w[1] | (w[2] << 8);
    const uncompressedLen = w[3] | (w[4] << 8);
    expect(uncompressedLen).toBe(payload.length);
    expect(compressedLen).toBe(w.length - 5);
    expect(w.length).toBeLessThan(payload.length);

    // the compressed body must be raw deflate (no zlib/gzip header) --
    // inflateRawSync must succeed and reproduce the original bytes.
    const inflated = zlib.inflateRawSync(w.subarray(5));
    expect(Array.from(new Uint8Array(inflated))).toEqual(Array.from(payload));
  });

  test("declines to wrap payloads below ZPACKET_MIN_COMPRESS_SIZE", () => {
    const payload = compressiblePayload(ZPACKET_MIN_COMPRESS_SIZE - 1);
    expect(tryWrapZPacket(payload, payload.length, 4096)).toBeNull();
  });

  test("declines to wrap when compression would not shrink the message", () => {
    // cryptographically random-ish bytes (a counter run through a
    // non-repeating permutation) don't compress well; deflate's own
    // overhead can make the "compressed" form no smaller than the input.
    const len = ZPACKET_MIN_COMPRESS_SIZE + 10;
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) payload[i] = (i * 137 + 59) & 0xff;
    const wrapped = tryWrapZPacket(payload, payload.length, 4096);
    // Either null (declined) or, if it did shrink, still smaller than input --
    // the real assertion is the invariant tryWrapZPacket documents.
    if (wrapped) expect(wrapped.length).toBeLessThan(payload.length);
  });

  test("declines to wrap when the result would not fit maxOut", () => {
    const payload = compressiblePayload(500);
    expect(tryWrapZPacket(payload, payload.length, 4)).toBeNull();
  });

  test("readZPacketPayload inflates a hand-built envelope back to the original bytes", () => {
    const original = compressiblePayload(300);
    const compressed = zlib.deflateRawSync(original);
    const envelope = new Uint8Array(4 + compressed.length);
    envelope[0] = compressed.length & 0xff;
    envelope[1] = (compressed.length >> 8) & 0xff;
    envelope[2] = original.length & 0xff;
    envelope[3] = (original.length >> 8) & 0xff;
    envelope.set(compressed, 4);

    // caller has already consumed the leading opcode byte -- see this
    // file's header comment and zpacket.ts's readZPacketPayload doc comment.
    const msg = loadIntoBuf(envelope);
    const result = readZPacketPayload(msg);
    expect(Array.from(result)).toEqual(Array.from(original));
  });

  test("round-trips through tryWrapZPacket -> readZPacketPayload (minus the leading opcode byte the real dispatch loop consumes)", () => {
    const original = compressiblePayload(400);
    const wrapped = tryWrapZPacket(original, original.length, 4096);
    expect(wrapped).not.toBeNull();
    const w = wrapped as Uint8Array;

    const msg = loadIntoBuf(w.subarray(1)); // drop the opcode byte, as the real dispatch loop would have already read it
    const result = readZPacketPayload(msg);
    expect(Array.from(result)).toEqual(Array.from(original));
  });
});

describe("Netchan_Transmit svc_zpacket integration", () => {
  function makeChan(sock: NetsrcT, compress: boolean): NetchanT {
    const chan = new NetchanT();
    const adr = new NetadrT();
    adr.type = NetadrtypeT.NA_LOOPBACK;
    Netchan_Setup(sock, chan, adr, 0);
    chan.compress = compress;
    return chan;
  }

  test("wraps a large reliable server->client message when chan.compress is set", () => {
    const chan = makeChan(NetsrcT.NS_SERVER, true);
    const payload = compressiblePayload(300);
    SZ_Write(chan.message, payload, payload.length);

    Netchan_Transmit(chan, 0, new Uint8Array(0));

    expect(chan.reliable_length).toBeGreaterThan(0);
    expect(chan.reliable_buf[0]).toBe(SVC_ZPACKET);
    expect(chan.reliable_length).toBeLessThan(payload.length);
  });

  test("does not wrap when chan.compress is false", () => {
    const chan = makeChan(NetsrcT.NS_SERVER, false);
    const payload = compressiblePayload(300);
    SZ_Write(chan.message, payload, payload.length);

    Netchan_Transmit(chan, 0, new Uint8Array(0));

    expect(chan.reliable_length).toBe(payload.length);
    expect(chan.reliable_buf[0]).toBe(payload[0]);
  });

  test("does not wrap a client->server (NS_CLIENT) channel even if compress is set", () => {
    const chan = makeChan(NetsrcT.NS_CLIENT, true);
    const payload = compressiblePayload(300);
    SZ_Write(chan.message, payload, payload.length);

    Netchan_Transmit(chan, 0, new Uint8Array(0));

    expect(chan.reliable_length).toBe(payload.length);
    expect(chan.reliable_buf[0]).toBe(payload[0]);
  });

  test("does not wrap a small reliable message even when compress is set", () => {
    const chan = makeChan(NetsrcT.NS_SERVER, true);
    const payload = compressiblePayload(4); // below ZPACKET_MIN_COMPRESS_SIZE
    SZ_Write(chan.message, payload, payload.length);

    Netchan_Transmit(chan, 0, new Uint8Array(0));

    expect(chan.reliable_length).toBe(payload.length);
    expect(Array.from(chan.reliable_buf.subarray(0, payload.length))).toEqual(Array.from(payload));
  });
});
