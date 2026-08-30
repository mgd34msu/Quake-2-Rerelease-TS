// svc_zpacket / svc_r1q2_zpacket -- compressed reliable message wrapping,
// shared byte-for-byte by the R1Q2 (35) and Q2PRO (36) codecs (v1.0.0 wire
// cluster, task board #23; ~/Projects/qsrc/q2repro and
// ~/Projects/q2proto/src/q2proto_internal_maybe_zpacket.c).
//
// Wire format (q2proto_internal_maybe_zpacket.c:56-83,
// q2proto_proto_r1q2.c:558-576's r1q2_client_read_zpacket, shared verbatim by
// q2proto_proto_q2pro.c's dispatch -- "case svc_r1q2_zpacket:" calls the same
// function):
//
//   u8  SVC_ZPACKET (== 21, qcommon.ts)
//   u16 compressed_len
//   u16 uncompressed_len   -- informational only; the real q2proto client
//                             reader never validates the inflated size
//                             against it, it just inflates compressed_len
//                             bytes and stops when the stream is exhausted
//   u8[compressed_len]     -- raw DEFLATE (Q2P_INFL_DEFL_RAW: no zlib/gzip
//                             header/trailer, no preset dictionary)
//
// Negotiation (per-protocol, NOT part of this module -- see sv_main.ts's
// SVC_DirectConnect and cl_main.ts's CL_ServerConnect for where these are
// decided): R1Q2 always supports it (q2proto_proto_r1q2.c:39,
// `parsed_connect->has_zlib = true` unconditionally); Q2PRO only when the
// client's connect string sets its zlib token
// (q2proto_proto_q2pro.c:1348, `enable_deflate = connect_info->has_zlib`).
// Q2REPRO/1038 and vanilla/34 never use this opcode at all
// (q2proto_proto_kex.c:942 hardcodes `enable_deflate = false`; kex has its
// own, unrelated, zlib-HEADER "blast" compression for gamestate bursts only
// -- see kexdemo.ts's svc_rr_configblast/svc_rr_spawnbaselineblast comment).
//
// ARCHITECTURAL ADAPTATION (documented deviation, not a wire-format
// deviation): q2proto gates each individual write call
// (q2proto_maybe_zpacket_begin/end wraps specific bulk writes, mainly the
// initial gamestate/configstring/baseline burst). This engine's server
// instead accumulates every reliable write for a connection into one
// `ClientT.netchan.message` SizeBuf across possibly many separate calls
// (SV_New_f/SV_Configstrings_f/SV_Baselines_f/etc all write into the same
// buffer), and only ever has ONE choke point where "the whole pending
// reliable message is about to go on the wire": qcommon/net_chan.ts's
// Netchan_Transmit, at the exact place it copies chan.message's bytes into
// chan.reliable_buf. Wrapping there (see net_chan.ts's own citation of this
// file) achieves the identical OBSERVABLE behavior real q2proto servers
// produce -- large reliable bursts (gamestate, configstrings, baselines) get
// compressed, small per-frame reliable trickle does not, because the size
// gate below is the same MIN_COMPRESS_SIZE q2proto itself uses -- without
// requiring every sv_user.ts/sv_send.ts call site to know about compression
// individually. FIDELITY RAZOR (.orch/preferences.md rule 17): same
// interop-relevant behavior, different (correct-for-this-codebase) internal
// mechanism.

import * as zlib from "node:zlib";
import { SVC_ZPACKET, ERR_DROP, ComError } from "../qcommon";
import { type SizeBuf, MSG_ReadShort, MSG_ReadData } from "../sizebuf";

// q2proto_internal_maybe_zpacket.c: `#define MIN_COMPRESS_SIZE (5 + 16)` --
// the 5-byte zpacket header plus 16 bytes of slack, used as the "is this
// even worth trying to compress" gate before q2proto bothers calling
// deflate at all.
export const ZPACKET_MIN_COMPRESS_SIZE = 5 + 16;

const ZPACKET_HEADER_SIZE = 5; // u8 opcode + u16 compressed_len + u16 uncompressed_len

// Attempts to wrap `data.subarray(0, len)` (an already-built reliable
// message body) in a svc_zpacket envelope that both (a) is smaller than the
// original `len` bytes and (b) fits within `maxOut` bytes. Returns null if
// compression isn't worth attempting, doesn't help, or the wrapped result
// wouldn't fit -- callers fall back to sending `data`/`len` unwrapped exactly
// as before, matching q2proto_maybe_zpacket_begin's own "just don't wrap it"
// fallback path.
export function tryWrapZPacket(data: Uint8Array, len: number, maxOut: number): Uint8Array | null {
  if (len < ZPACKET_MIN_COMPRESS_SIZE) return null;
  if (len > 0xffff) return null; // uncompressed_len is a u16 field

  const compressed = zlib.deflateRawSync(data.subarray(0, len));
  if (compressed.length > 0xffff) return null; // compressed_len is a u16 field

  const total = ZPACKET_HEADER_SIZE + compressed.length;
  if (total >= len) return null; // not actually smaller -- not worth it
  if (total > maxOut) return null; // wouldn't fit in the destination buffer

  const out = new Uint8Array(total);
  out[0] = SVC_ZPACKET & 0xff;
  out[1] = compressed.length & 0xff;
  out[2] = (compressed.length >> 8) & 0xff;
  out[3] = len & 0xff;
  out[4] = (len >> 8) & 0xff;
  out.set(compressed, ZPACKET_HEADER_SIZE);
  return out;
}

// Client-side unwrap. Caller has already consumed the leading SVC_ZPACKET
// opcode byte (matching every other svc_* reader in this codebase, e.g.
// vanilla.ts's readFramePlayerstate consuming svc_playerinfo itself before
// delegating); this reads compressed_len/uncompressed_len and the deflated
// body, and returns the inflated bytes. uncompressed_len is read and
// discarded (r1q2_client_read_zpacket never validates it -- see this file's
// header comment).
export function readZPacketPayload(msg: SizeBuf): Uint8Array {
  const compressedLen = MSG_ReadShort(msg);
  MSG_ReadShort(msg); // uncompressed_len -- informational only, discarded

  const compressed = new Uint8Array(compressedLen);
  MSG_ReadData(msg, compressed, compressedLen);

  try {
    return new Uint8Array(zlib.inflateRawSync(compressed));
  } catch (e) {
    throw new ComError(ERR_DROP, `zpacket: raw inflate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
