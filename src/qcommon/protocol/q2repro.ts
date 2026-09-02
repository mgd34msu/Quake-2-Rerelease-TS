// Protocol 1038 ("q2repro") codec: q2repro's re-release wire protocol, ported
// from ~/Projects/q2proto's reference implementation (GPLv2-or-later; see
// this file's LICENSE FINDING below) behind the ProtocolCodec seam
// (codec.ts). ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md
// phase 5 unit.
//
// LICENSE FINDING: q2proto/src/q2proto_proto_q2repro.c's header reads
// "Copyright (C) 1997-2001 Id Software, Inc. / Copyright (C) 2003-2011
// Richard Stanway / Copyright (C) 2003-2024 Andrey Nazarov / Copyright (C)
// 2024-2026 Frank Richter ... GNU General Public License ... version 2 ...
// or (at your option) any later version." -- GPLv2-or-later, matching this
// project's stated GPLv2-compatible vendoring policy (ARCHITECTURE.md
// "License rules"). Every fact ported below (bit layouts, field order, byte
// widths, quantization formulas) is cited to a specific q2proto file/line so
// the derivation is checkable against that source.
//
// ---------------------------------------------------------------------------
// SOURCES CONSULTED (all under ~/Projects/q2proto and ~/Projects/qsrc/q2repro)
// ---------------------------------------------------------------------------
//   src/q2proto_proto_q2repro.c           -- the 1038 codec (2,815 lines)
//   src/q2proto_internal_common.c/.h      -- shared entity-bits header codec,
//                                             q2proto_common_choose_width_flags
//   src/q2proto_internal_io.h             -- maybe_diff_coords_write_differs_*,
//                                             q2pro_extv2_blends read/write
//   src/q2proto_internal_protocol.h       -- U_*/PS_*/EPS_*/CM_* bit constants
//   inc/q2proto/q2proto_struct_svc.h      -- Q2P_ESD_*/Q2P_PSD_* delta-bit enums
//   inc/q2proto/q2proto_struct_clc.h      -- Q2P_CMD_* delta-bit enum
//   inc/q2proto/q2proto_valenc.h          -- alpha/scale/viewoffset/gunoffset/
//                                             kick_angles/gunangles quantization
//   inc/q2proto/q2proto_defs.h            -- Q2PROTO_FEATURES_RERELEASE bitmask
//   src/q2proto_sound.c                   -- loop_attenuation encode/decode
//   ~/Projects/qsrc/q2repro/src/common/msg.c -- MSG_PackEntity's
//                                             Q_clip_alpha/Q_clip_scale/
//                                             loop_volume bandwidth collapse
//   ~/Projects/qsrc/q2repro/inc/common/protocol.h -- PROTOCOL_VERSION_RERELEASE
//                                             = 1038, Q2PRO_PF_*/Q2REPRO_PF_*
//
// ---------------------------------------------------------------------------
// FEATURE SET: q2repro builds q2proto with Q2PROTO_ENTITY_STATE_FEATURES =
// Q2PROTO_PLAYER_STATE_FEATURES = Q2PROTO_FEATURES_RERELEASE (qsrc/q2repro/
// inc/common/q2proto_config.h:23-24), which q2proto_defs.h:64,77,84 expands
// to GUNSKIN | ENTITY_LOOP_ALPHA_SCALE_FX64 | PLAYER_DAMAGE_BLEND |
// PLAYER_GUNRATE_VIEWHEIGHT (FOG explicitly excluded). Every `#if
// Q2PROTO_..._FEATURES & ...` branch in the sources above is therefore taken
// for 1038, and this port implements all of them EXCEPT player fog (not
// requested, not enabled) and PM_VIEWHEIGHT (see gap below).
//
// ---------------------------------------------------------------------------
// FINDING: fields the task brief named that 1038 does NOT actually carry
// ---------------------------------------------------------------------------
// The task brief's parenthetical field list included "owner/old_frame" for
// entities and "team_id" for playerstate. Reading the actual delta-bit enums
// shows these are NOT part of q2repro/q2proto's Q2P_ESD_*/Q2P_PSD_* sets:
//   - inc/q2proto/q2proto_struct_svc.h's Q2P_ESD_* enum (grepped in full) has
//     no OWNER or OLD_FRAME entry. `owner`/`old_frame` are ADDITIONS from
//     q2proto_internal_protocol.h's U_KEX_OWNER(34)/U_KEX_OLDFRAME(35) bit
//     ALIASES, which are used exclusively by q2proto_proto_kex.c (the
//     separate native-KEX-format demo codec, out of scope per
//     ARCHITECTURE.md: "KEX 2022/2023, demo playback only in q2repro;
//     defer"), not by q2proto_proto_q2repro.c (the 1038 network codec ported
//     here). Confirmed by grep: q2repro.c never references U_KEX_OWNER/
//     U_KEX_OLDFRAME, and the RERELEASE feature bitmask does not gate any
//     owner/old_frame field.
//   - PS_KEX_TEAM_ID (q2proto_internal_protocol.h:267) is likewise only
//     referenced by the kex-native codec's playerstate writer, never by
//     q2repro_server_write_playerstate (verified by reading the full 199-line
//     function body: no team_id read/write appears anywhere in it).
// Net effect: EntityStateT.owner/old_frame and PlayerStateT.team_id have NO
// 1038 wire representation in this codec (same as they have none in
// VANILLA_CODEC) -- both remain KEX-native-protocol-only fields, ported in
// good faith to the wide EntityStateT/PlayerStateT shape (phase 2) but
// dormant until the (out-of-scope) native KEX demo codec exists.
//
// ---------------------------------------------------------------------------
// pmove's PM_VIEWHEIGHT bit (was a KNOWN GAP; now carried for real)
// ---------------------------------------------------------------------------
// Q2P_PSD_PM_VIEWHEIGHT / PS_RR_VIEWHEIGHT (BIT(15) of `flags`,
// q2proto_internal_protocol.h:263) is part of the RERELEASE feature set
// (Q2PROTO_FEATURE_FLAG_PLAYER_GUNRATE_VIEWHEIGHT). It is written as an i8
// immediately after EPS_GUNRATE's gunrate byte and before EPS_CLIENTNUM
// (q2proto_proto_q2repro.c:2192-2198 write / :734-736 read).
//
// This used to be skipped because PmoveStateT had no viewheight field at
// all. It does now (shared/q_shared.ts), because dropping it is exactly what
// made a re-release player render permanently crouched: the re-release game
// keeps eye height OUT of `viewoffset` (q2repro server/entities.c:610-612,
// "Rerelease game doesn't include viewheight in viewoffset, vanilla does"),
// so a client that never receives pm_viewheight puts the camera at the
// player's feet instead of 22 units up.
//
// ---------------------------------------------------------------------------
// KNOWN GAP: usercmd upmove
// ---------------------------------------------------------------------------
// q2repro_client_write_move_delta/q2repro_server_read_move_delta (the
// NON-batched clc_move format this codec ports, matching our engine's
// existing one-usercmd-per-message architecture) has NO CM_UP bit at all --
// q2proto_struct_clc.h defines Q2P_CMD_MOVE_UP, but q2repro.c:1112-1113 and
// :2578-2579 both hard-fail (`return Q2P_ERR_BAD_DATA`) the instant it would
// be needed. Real q2repro clients avoid this entirely by using the KEX-style
// BATCHED move format (q2repro_client_write_batch_move, q2repro.c:1265-1297,
// a bit-packed 3-commands-per-message format with its own opcode and a
// bitwriter instead of byte-aligned fields) for live play, which supports
// upmove. Implementing the batched format is a materially larger change --
// it replaces the per-frame single-usercmd client input pipeline
// (cl_input.ts/sv_user.ts's clc_move handling) with a 3-deep batch and a
// bit-level writer/reader, not just a codec-seam addition -- and is explicitly
// deferred (see this file's end-to-end summary in the task report). This
// codec faithfully reproduces the non-batched format's real limitation:
// writeDeltaUsercmd throws if upmove changes, exactly mirroring upstream's
// Q2P_ERR_BAD_DATA rather than silently dropping vertical movement input.
//
// ---------------------------------------------------------------------------
// RESOLVED: frame envelope (svc_frame combining playerstate + packetentities)
// ---------------------------------------------------------------------------
// q2repro_server_write_frame (q2repro.c:2206-2242) bundles ONE svc_frame
// message containing the frame-number+delta-offset encoding, a
// q2pro_frame_flags byte, a reserved extraflags byte (patched in after
// q2repro_server_write_playerstate computes it), areabits, AND the
// playerstate delta -- packetentities follow directly (no opcode --
// Q2P_SVC_FRAME_ENTITY_DELTA is a reader-side "pseudo-message",
// q2proto_struct_svc.h:530-536). This was structurally different from
// protocol 34's three independent svc_frame / svc_playerinfo /
// svc_packetentities messages, which src/server/sv_ents.ts
// (SV_WriteFrameToClient) used to emit regardless of which codec was active
// -- this note originally deferred that restructuring as a follow-up unit.
// That follow-up is this file's `writeFrame`/`readFrameHeader`/
// `readFramePlayerstate`/`writePacketEntitiesBegin` ops (see codec.ts's
// FrameWriteParamsT/FrameHeaderT doc comments): sv_ents.ts's
// SV_WriteFrameToClient and src/client/cl_ents.ts's CL_ParseFrame now both
// route through `svs.codec`/`cls.codec`, so selecting Q2REPRO_CODEC produces
// (and consumes) a real 1038-shaped envelope, not protocol-34-shaped framing
// around 1038-encoded fields. The entity DIFF LOOP itself (deciding which
// entities changed) stays in sv_ents.ts/cl_ents.ts on both sides, matching
// q2proto's own split (see codec.ts's FrameWriteParamsT comment).
//
// ---------------------------------------------------------------------------
// DOCUMENTED SIMPLIFICATION: origin/velocity change detection
// ---------------------------------------------------------------------------
// q2proto compares entity origin and playerstate pm_origin/pm_velocity
// changes via q2proto_maybe_diff_coords_write_differs_int/_float
// (q2proto_internal_io.h:540-569), which for entities reads back the
// **already round-tripped-through-int-encoding** component values (so two
// floats that quantize to the same encoded int compare equal, i.e. "no
// change"). This port's EntityStateT.origin/PlayerStateT.pmove.origin are
// authoritative floats/fixed-point shorts with no separate "encoded int"
// staging value, so this codec compares the plain values directly (`!==`).
// This can only ever make this codec MORE conservative than upstream (an
// occasional redundant-but-correct field write for a sub-quantization-step
// change), never produce an incorrect byte for a field it does decide to
// write -- the written bytes are computed from the same source value either
// way. Golden test cases below use values large enough that this never
// matters for the byte-exactness assertions.
//
// ---------------------------------------------------------------------------
// FLOAT PMOVE STATE END TO END (.orch/followups.md)
// ---------------------------------------------------------------------------
// 1038's wire format transmits pm_origin/pm_velocity as full IEEE-754
// floats (q2repro.c:2081-2099, matching KEX's native float pmove_state_t --
// rerelease game.h:400-412's real `pmove_state_t` is `vec3_t origin; vec3_t
// velocity;`, no fixed-point at all). This port's PmoveStateT
// (shared/q_shared.ts) now carries a matching float mirror
// (`originF`/`velocityF`), which server/bindings/kex.ts's
// syncPlayerStateKexToEngine populates directly from the kex game's own
// float pmove state (no narrowing) and this codec reads/writes directly for
// the wire below -- no short-domain round trip. The classic
// `origin`/`velocity` Int16Array fields (12.3 fixed) are a SEPARATE shadow,
// still kept in sync (same `pmFloatToShort` formula this codec always used)
// purely for family-generic consumers that still read them (sv_ents.ts's
// PVS origin calc; client/cl_ents.ts's interpolation teleport check and
// non-predicting render path; CL_CheckPredictionError's debug compare) --
// none of those need the extra precision, and it keeps them byte-for-byte
// unchanged by this fix. This closes the quantize-requantize round trip that
// used to destroy PM_StepSlideMove's DIST_EPSILON floor clearance during
// client-side prediction replay (client/cgame/host.ts's
// kexPmoveStateViewFromClassic now seeds from `originF`/`velocityF`
// directly instead of widening the Int16 shadow).

import type { SizeBuf } from "../sizebuf";
import { MSG_WriteByte, MSG_WriteChar, MSG_WriteShort, MSG_WriteLong, MSG_WriteLong64, MSG_WriteFloat, MSG_WriteString, MSG_WriteDeltaUsercmd, SZ_Write } from "../sizebuf";
import { MSG_ReadByte, MSG_ReadChar, MSG_ReadShort, MSG_ReadWord, MSG_ReadLong, MSG_ReadLong64, MSG_ReadFloat, MSG_ReadString, MSG_ReadDeltaUsercmd, MSG_ReadData } from "../sizebuf";
import {
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_FRAME8,
  U_FRAME16,
  U_EVENT,
  U_REMOVE,
  U_MOREBITS1,
  U_NUMBER16,
  U_MODEL,
  U_RENDERFX8,
  U_RENDERFX16,
  U_EFFECTS8,
  U_EFFECTS16,
  U_MOREBITS2,
  U_SKIN8,
  U_SKIN16,
  U_MODEL2,
  U_MODEL3,
  U_MODEL4,
  U_MOREBITS3,
  U_OLDORIGIN,
  U_SOUND,
  U_SOLID,
  PS_M_TYPE,
  PS_M_ORIGIN,
  PS_M_VELOCITY,
  PS_M_TIME,
  PS_M_FLAGS,
  PS_M_GRAVITY,
  PS_M_DELTA_ANGLES,
  PS_VIEWOFFSET,
  PS_VIEWANGLES,
  PS_KICKANGLES,
  PS_BLEND,
  PS_FOV,
  PS_WEAPONINDEX,
  PS_WEAPONFRAME,
  PS_RDFLAGS,
  PS_RR_VIEWHEIGHT,
  CM_ANGLE1,
  CM_ANGLE2,
  CM_ANGLE3,
  CM_FORWARD,
  CM_SIDE,
  CM_UP,
  CM_BUTTONS,
  CM_IMPULSE,
  SvcOpsT,
  ComError,
  ERR_DROP,
  PROTOCOL_VERSION_RERELEASE,
  PROTOCOL_VERSION_RERELEASE_CLASSIC,
} from "../qcommon";
import { net_message } from "../net_chan";
import { SvcFogDataBitsT, type SvcFogDataT } from "../../kexapi/game";
import { EntityStateT, PlayerStateT, type UsercmdT, ANGLE2SHORT, SHORT2ANGLE, RF_BEAM } from "../../shared/q_shared";
import type { ProtocolCodec, ServerDataParamsT, ServerDataReadResultT, FrameWriteParamsT, FrameHeaderT, ClcBatchMoveT, ClcUserinfoDeltaT, ClcClientSettingT } from "./codec";
import { VANILLA_CODEC } from "./vanilla";
import { BitReader, BitWriter, readBatchMoveAngleComponent, readBatchMoveFrames, writeBatchMoveFrames, seedFromPrev, ClcBatchMoveError, MAX_CLC_BATCH_MOVE_FRAMES, type ClcBatchMoveFrameT } from "./clc_batch_move";

// ---------------------------------------------------------------------------
// Local bit constants: q2proto's U_/PS_/EPS_ layouts that protocol 34 never
// engages (so qcommon.ts's existing exported constants stop short of them --
// see vanilla.ts's imports for the ones that DO already exist and are reused
// below without redefinition).
// ---------------------------------------------------------------------------

// q2proto_internal_protocol.h:134 -- "Q2PRO: 'short' angles". Unused by
// protocol 34 (which never sets it), so absent from qcommon.ts.
const U_ANGLE16 = 1 << 13;
// q2proto_internal_protocol.h:151-155,157-158
const U_MODEL16 = 1 << 28;
const U_MOREFX8 = 1 << 29;
const U_ALPHA = 1 << 30;
const U_MOREBITS4 = 1 << 31;
// Bits 32/33 of q2proto's 64-bit `bits` word don't fit a 32-bit JS bitwise
// operand. Tracked as a separate small "hi" word (bit 0 = overall bit 32 =
// U_SCALE, bit 1 = overall bit 33 = U_MOREFX16) combined with the 32-bit
// "lo" word into one plain `number` for the ProtocolCodec.readEntityBits()
// return value (safe: JS numbers are exact integers up to 2^53, well past
// the 2^34 this format ever needs). See combineBits/bitsHasHi below.
// Exported (not just this file's own use): qcommon/protocol/kexdemo.ts's KEX
// demo/native codec shares this exact 40-bit entity-bits header format
// (verified byte-identical against q2proto_internal_common.c's
// q2proto_common_client_read_entity_bits, which EVERY protocol q2proto
// supports -- vanilla/r1q2/q2pro/q2pro_extdemo/q2repro/kex -- calls
// unchanged) and adds two more hi-word flags of its own (U_KEX_OWNER=bit34,
// U_KEX_OLDFRAME=bit35) in the same already-reserved hi-byte this file's
// own HI_SCALE(bit32)/HI_MOREFX16(bit33) already occupy -- see kexdemo.ts's
// own header for the citation.
export const HI_SCALE = 1;
export const HI_MOREFX16 = 2;
export function combineBits(lo: number, hi: number): number {
  return (lo >>> 0) + hi * 4294967296; // 2**32
}
export function bitsHasHi(bits: number, hiFlag: number): boolean {
  return (Math.floor(bits / 4294967296) & hiFlag) !== 0;
}

// q2proto_internal_protocol.h:305,307 -- packed into the U_SOUND u16 word.
export const SOUND_FLAG_VOLUME = 1 << 14;
export const SOUND_FLAG_ATTENUATION = 1 << 15;

// q2proto_internal_protocol.h:270-280 -- the svc_frame "extraflags" byte.
const EPS_GUNOFFSET = 1 << 0;
const EPS_GUNANGLES = 1 << 1;
const EPS_M_VELOCITY2 = 1 << 2;
const EPS_M_ORIGIN2 = 1 << 3;
const EPS_VIEWANGLE2 = 1 << 4;
const EPS_STATS = 1 << 5;
// EPS_CLIENTNUM (1<<6) and EPS_GUNRATE (1<<7) declared inline below at their
// one use site each; EPS_CLIENTNUM is never set (see PS_RR_VIEWHEIGHT-style
// gap note: no PlayerStateT.clientnum field, and q2proto gates it behind an
// opt-in servercontext feature this port doesn't enable).
const EPS_GUNRATE = 1 << 7;

// q2proto_internal_protocol.h:363,365
export const Q2PRO_GUNINDEX_BITS = 13;
export const Q2PRO_GUNINDEX_MASK = (1 << Q2PRO_GUNINDEX_BITS) - 1;

// PROTOCOL_VERSION_RERELEASE (qsrc/q2repro/inc/common/protocol.h:32), hosted
// centrally in qcommon.ts (added alongside PROTOCOL_VERSION) so cl_parse.ts
// can select this codec off the same literal.
const PROTOCOL_Q2REPRO = PROTOCOL_VERSION_RERELEASE;

// ---------------------------------------------------------------------------
// Value quantization helpers (inc/q2proto/q2proto_valenc.h + src/q2proto_sound.c
// + qsrc/q2repro/src/common/msg.c -- see file header for exact citations).
// All C "(int)x" casts truncate toward zero, NOT round; ported as Math.trunc.
// ---------------------------------------------------------------------------

// q2proto_valenc.h:124-129 (alpha) / :132-139 (scale), matching qsrc/q2repro's
// own Q_clip_alpha/Q_clip_scale (msg.c:527-535) bit-for-bit: 0 is a "default"
// sentinel that passes through unchanged; any other value is scaled,
// truncated, and clamped to [1,255] so it can never collide with 0.
function encodeAlpha(x: number): number {
  if (x === 0) return 0;
  let v = Math.trunc(x * 255);
  if (v < 1) v = 1;
  if (v > 255) v = 255;
  return v;
}
export function decodeAlpha(b: number): number {
  return b === 0 ? 0 : b / 255;
}
function encodeScale(x: number): number {
  if (x === 0) return 0;
  let v = Math.trunc(x * 16);
  if (v < 1) v = 1;
  if (v > 255) v = 255;
  return v;
}
export function decodeScale(b: number): number {
  return b === 0 ? 0 : b / 16;
}

// qsrc/q2repro msg.c:561,565 (MSG_PackEntity): Q_clip_uint8(x*255), then a
// bandwidth-saving collapse of the unreachable-otherwise value 255 down to 0
// (0 already means "default" per this port's EntityStateT.loop_volume
// convention, matching decode's `b===0` passthrough below).
function encodeLoopVolume(x: number): number {
  if (x === 0) return 0;
  let v = Math.trunc(x * 255);
  if (v < 0) v = 0;
  if (v > 255) v = 255;
  if (v === 255) v = 0;
  return v;
}
export function decodeLoopVolume(b: number): number {
  return b === 0 ? 0 : b / 255;
}

// src/q2proto_sound.c:93-114 (q2proto_sound_decode/encode_loop_attenuation):
// ATTN_LOOP_NONE(-1) <-> byte 192 (ENCODE_LOOP_NONE); otherwise x*64,
// truncated, clamped [0,255], with the collision value 192 folded to 0.
const ATTN_LOOP_NONE = -1;
const ENCODE_LOOP_NONE = 192;
function encodeLoopAttenuation(x: number): number {
  if (x === ATTN_LOOP_NONE) return ENCODE_LOOP_NONE;
  let v = Math.trunc(x * 64);
  if (v < 0) v = 0;
  if (v > 255) v = 255;
  if (v === ENCODE_LOOP_NONE) v = 0;
  return v;
}
export function decodeLoopAttenuation(b: number): number {
  return b === ENCODE_LOOP_NONE ? ATTN_LOOP_NONE : b / 64;
}

// q2proto_valenc.h:145-147 (viewoffset), :154-156 (gunoffset), :163-165
// (kick_angles), :172-174 (gunangles): each `_q2proto_valenc_clamped_mul`
// truncates toward zero and clamps to the full int16 range (no 0-sentinel
// unlike alpha/scale -- these are plain fixed-point conversions).
function clampInt16(x: number): number {
  if (x < -32768) return -32768;
  if (x > 32767) return 32767;
  return x;
}
function encodeFixed16(x: number, scale: number): number {
  return clampInt16(Math.trunc(x * scale));
}
export const VIEWOFFSET_SCALE = 16; // q2proto_valenc.h:142,145
const GUNOFFSET_SCALE = 512; // q2proto_valenc.h:151,154
export const KICK_ANGLE_SCALE = 1024; // q2proto_valenc.h:160,163
const GUNANGLE_SCALE = 4096; // q2proto_valenc.h:169,172

// q2proto_common_choose_width_flags (q2proto_internal_common.h:38-48).
// Returns which of an 8/16/32-bit encoding a value needs.
function widthOf(value: number, uint16Safe: boolean): 0 | 1 | 2 {
  const v = value >>> 0;
  const mask32 = uint16Safe ? 0xffff0000 : 0xffff8000;
  if (v & mask32) return 2;
  if (v & 0xff00) return 1;
  return 0;
}

// Still used to keep the legacy 12.3 fixed-point `origin`/`velocity` shadow
// (q_shared.ts's PmoveStateT, see its own doc comment) in sync for the
// family-generic consumers that read it -- the wire itself now reads/writes
// `originF`/`velocityF` directly (see file header's "FLOAT PMOVE STATE END
// TO END" section).
export function pmFloatToShort(f: number): number {
  return clampInt16(Math.round(f * 8));
}

// ---------------------------------------------------------------------------
// Entity-bits header (q2proto_common_server_write_entity_bits /
// q2proto_common_client_read_entity_bits, q2proto_internal_common.c:115-145
// and its unshown-but-symmetric read counterpart -- the write body fully
// specifies the read layout since it's a strict chain of "read one more byte
// if the previous MOREBITSn bit was set").
// ---------------------------------------------------------------------------

function writeEntityBitsWide(msg: SizeBuf, lo0: number, hi: number, entnum: number): void {
  let lo = lo0 >>> 0;
  if (entnum >= 256) lo |= U_NUMBER16;

  if (hi !== 0) lo |= U_MOREBITS4 | U_MOREBITS3 | U_MOREBITS2 | U_MOREBITS1;
  else if (lo & 0xff000000) lo |= U_MOREBITS3 | U_MOREBITS2 | U_MOREBITS1;
  else if (lo & 0x00ff0000) lo |= U_MOREBITS2 | U_MOREBITS1;
  else if (lo & 0x0000ff00) lo |= U_MOREBITS1;

  MSG_WriteByte(msg, lo & 0xff);
  if (lo & U_MOREBITS1) MSG_WriteByte(msg, (lo >>> 8) & 0xff);
  if (lo & U_MOREBITS2) MSG_WriteByte(msg, (lo >>> 16) & 0xff);
  if (lo & U_MOREBITS3) MSG_WriteByte(msg, (lo >>> 24) & 0xff);
  if (lo & U_MOREBITS4) MSG_WriteByte(msg, hi & 0xff);

  if (lo & U_NUMBER16) MSG_WriteShort(msg, entnum);
  else MSG_WriteByte(msg, entnum);
}

export function readEntityBitsWide(): { number: number; bits: number } {
  let lo = MSG_ReadByte(net_message);
  if (lo & U_MOREBITS1) lo |= MSG_ReadByte(net_message) << 8;
  if (lo & U_MOREBITS2) lo |= MSG_ReadByte(net_message) << 16;
  if (lo & U_MOREBITS3) lo |= MSG_ReadByte(net_message) << 24;
  let hi = 0;
  if (lo & U_MOREBITS4) hi = MSG_ReadByte(net_message);

  // entnum is unsigned (q2proto_internal_common.c:88-89's
  // `READ_CHECKED(client_read, io_arg, *entnum, u16)`), shared by every
  // q2repro/kex-family codec's entity-bits header -- MSG_ReadWord, not
  // MSG_ReadShort. Practically unreachable today (MAX_EDICTS is nowhere near
  // 0x8000), so this was never a live bug, but a signed read would silently
  // misindex `cl_entities`/`cl.baselines` the day an entity count grows past
  // 32767, so it is matched exactly rather than left "harmless for now".
  let number: number;
  if (lo & U_NUMBER16) number = MSG_ReadWord(net_message);
  else number = MSG_ReadByte(net_message);

  return { number, bits: combineBits(lo, hi) };
}

// ---------------------------------------------------------------------------
// server -> client writes
// ---------------------------------------------------------------------------

// q2repro_server_write_serverdata, q2repro.c:1746-1774. Fields this engine
// has no data source for (q2pro qw_mode/strafejump_hack/waterjump_hack/
// extensions/extensions_v2/game3_compat) are sent as their "off" default --
// this engine implements none of q2pro's extended-protocol features, so
// advertising them enabled would be a lie the client could act on.
function writeServerData(msg: SizeBuf, params: ServerDataParamsT): void {
  writeServerDataAs(PROTOCOL_Q2REPRO, msg, params);
}

// The classic-module variant of the same handshake -- see
// PROTOCOL_VERSION_RERELEASE_CLASSIC's doc comment in qcommon.ts. Identical
// bytes except for the protocol long, which is the whole point: the number is
// how the client learns that the wide indices it is about to read come from
// the CLASSIC game module rather than the rerelease one.
function writeServerDataClassic(msg: SizeBuf, params: ServerDataParamsT): void {
  writeServerDataAs(PROTOCOL_VERSION_RERELEASE_CLASSIC, msg, params);
}

function writeServerDataAs(protocol: number, msg: SizeBuf, params: ServerDataParamsT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_serverdata);
  MSG_WriteLong(msg, protocol);
  MSG_WriteLong(msg, params.servercount);
  MSG_WriteByte(msg, params.attractloop ? 1 : 0);
  MSG_WriteString(msg, params.gamedir);
  MSG_WriteShort(msg, params.clientnum);
  MSG_WriteString(msg, params.levelname);
  MSG_WriteShort(msg, 0); // protocol_version (q2pro extended minor version): none advertised
  MSG_WriteByte(msg, params.serverState & 0xff); // q2pro.server_state <- ServerStateT numeric value
  MSG_WriteShort(msg, 0); // q2pro_flags: no q2pro extensions/hacks advertised
  MSG_WriteByte(msg, 10); // server_fps: BASE_FRAMERATE (server.ts:76 -- fixed at 10Hz)
}

function writeDeltaEntity(msg: SizeBuf, from: EntityStateT, to: EntityStateT, force: boolean, newentity: boolean): void {
  let lo = 0;
  let hi = 0;

  // origin: full float per-component compare (see file header's "DOCUMENTED
  // SIMPLIFICATION"). q2repro.c:1782-1788.
  if (to.origin[0] !== from.origin[0]) lo |= U_ORIGIN1;
  if (to.origin[1] !== from.origin[1]) lo |= U_ORIGIN2;
  if (to.origin[2] !== from.origin[2]) lo |= U_ORIGIN3;

  // angles: compared as ANGLE2SHORT-quantized values, matching
  // q2repro_server_make_entity_state_delta's comparison of already-short-
  // packed to->angles/from->angles (q2repro.c:1398-1409); ALWAYS 16-bit on
  // this protocol (q2repro.c:1796-1797 forces U_ANGLE16 whenever any angle
  // bit is set -- unlike vanilla's optional 8-bit char angles).
  const toAngle: [number, number, number] = [ANGLE2SHORT(to.angles[0]), ANGLE2SHORT(to.angles[1]), ANGLE2SHORT(to.angles[2])];
  const fromAngle: [number, number, number] = [ANGLE2SHORT(from.angles[0]), ANGLE2SHORT(from.angles[1]), ANGLE2SHORT(from.angles[2])];
  if (toAngle[0] !== fromAngle[0]) lo |= U_ANGLE1;
  if (toAngle[1] !== fromAngle[1]) lo |= U_ANGLE2;
  if (toAngle[2] !== fromAngle[2]) lo |= U_ANGLE3;
  if (lo & (U_ANGLE1 | U_ANGLE2 | U_ANGLE3)) lo |= U_ANGLE16;

  // skinnum / frame / effects / renderfx: q2repro.c:1800-1819.
  if (to.skinnum !== from.skinnum) {
    const w = widthOf(to.skinnum, true);
    lo |= w === 2 ? U_SKIN8 | U_SKIN16 : w === 1 ? U_SKIN16 : U_SKIN8;
  }
  if (to.frame !== from.frame) lo |= to.frame >= 256 ? U_FRAME16 : U_FRAME8;

  const effectsChanged = to.effects !== from.effects;
  const morefxChanged = to.morefx !== from.morefx;
  if (effectsChanged) {
    const w = widthOf(to.effects, true);
    lo |= w === 2 ? U_EFFECTS8 | U_EFFECTS16 : w === 1 ? U_EFFECTS16 : U_EFFECTS8;
  }
  if (morefxChanged) {
    const w = widthOf(to.morefx, true);
    if (w === 0) lo |= U_MOREFX8;
    else if (w === 1) hi |= HI_MOREFX16;
    else {
      lo |= U_MOREFX8;
      hi |= HI_MOREFX16;
    }
  }

  if (to.renderfx !== from.renderfx) {
    const w = widthOf(to.renderfx, true);
    lo |= w === 2 ? U_RENDERFX8 | U_RENDERFX16 : w === 1 ? U_RENDERFX16 : U_RENDERFX8;
  }

  if (to.solid !== from.solid) lo |= U_SOLID;
  if (to.event) lo |= U_EVENT; // zero-compressed, q2repro.c:1454-1457/1824-1825

  if (to.modelindex !== from.modelindex) lo |= U_MODEL;
  if (to.modelindex2 !== from.modelindex2) lo |= U_MODEL2;
  if (to.modelindex3 !== from.modelindex3) lo |= U_MODEL3;
  if (to.modelindex4 !== from.modelindex4) lo |= U_MODEL4;
  if (
    (lo & U_MODEL && to.modelindex > 255) ||
    (lo & U_MODEL2 && to.modelindex2 > 255) ||
    (lo & U_MODEL3 && to.modelindex3 > 255) ||
    (lo & U_MODEL4 && to.modelindex4 > 255)
  )
    lo |= U_MODEL16;

  const soundChanged = to.sound !== from.sound;
  if (soundChanged) lo |= U_SOUND;
  const loopVolumeChanged = to.loop_volume !== from.loop_volume;
  const loopAttenuationChanged = to.loop_attenuation !== from.loop_attenuation;

  // Q2P_ESD_OLD_ORIGIN is decided by the caller/game before it ever reaches
  // q2proto (q2repro_server_make_entity_state_delta takes it as a `bool
  // write_old_origin` parameter, q2repro.c:1385,1411-1416) -- q2proto itself
  // just relays the bit. This engine's equivalent decision already lives in
  // vanilla's MSG_WriteDeltaEntity (sizebuf.ts): `newentity || renderfx &
  // RF_BEAM`. Reproduced identically here (RF_BEAM entities -- lasers/beams
  // -- need old_origin every frame for their far-endpoint; new entities get
  // it once as part of their full baseline/first delta).
  if (newentity || to.renderfx & RF_BEAM) lo |= U_OLDORIGIN;

  const alphaChanged = to.alpha !== from.alpha;
  const scaleChanged = to.scale !== from.scale;
  if (alphaChanged) lo |= U_ALPHA;
  if (scaleChanged) hi |= HI_SCALE; // U_SCALE = BIT_ULL(32), lives in the hi word

  if (!lo && !hi && !force) return; // nothing to send

  writeEntityBitsWide(msg, lo, hi, to.number);

  if (lo & U_MODEL16) {
    if (lo & U_MODEL) MSG_WriteShort(msg, to.modelindex);
    if (lo & U_MODEL2) MSG_WriteShort(msg, to.modelindex2);
    if (lo & U_MODEL3) MSG_WriteShort(msg, to.modelindex3);
    if (lo & U_MODEL4) MSG_WriteShort(msg, to.modelindex4);
  } else {
    if (lo & U_MODEL) MSG_WriteByte(msg, to.modelindex);
    if (lo & U_MODEL2) MSG_WriteByte(msg, to.modelindex2);
    if (lo & U_MODEL3) MSG_WriteByte(msg, to.modelindex3);
    if (lo & U_MODEL4) MSG_WriteByte(msg, to.modelindex4);
  }

  if (lo & U_FRAME16) MSG_WriteShort(msg, to.frame);
  else if (lo & U_FRAME8) MSG_WriteByte(msg, to.frame);

  if ((lo & (U_SKIN8 | U_SKIN16)) === (U_SKIN8 | U_SKIN16)) MSG_WriteLong(msg, to.skinnum);
  else if (lo & U_SKIN16) MSG_WriteShort(msg, to.skinnum);
  else if (lo & U_SKIN8) MSG_WriteByte(msg, to.skinnum);

  if ((lo & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) MSG_WriteLong(msg, to.effects);
  else if (lo & U_EFFECTS16) MSG_WriteShort(msg, to.effects);
  else if (lo & U_EFFECTS8) MSG_WriteByte(msg, to.effects);

  if ((lo & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) MSG_WriteLong(msg, to.renderfx);
  else if (lo & U_RENDERFX16) MSG_WriteShort(msg, to.renderfx);
  else if (lo & U_RENDERFX8) MSG_WriteByte(msg, to.renderfx);

  if (lo & U_ORIGIN1) MSG_WriteFloat(msg, to.origin[0]);
  if (lo & U_ORIGIN2) MSG_WriteFloat(msg, to.origin[1]);
  if (lo & U_ORIGIN3) MSG_WriteFloat(msg, to.origin[2]);

  // U_ANGLE16 is always set whenever any angle bit is set (see above), so
  // the 8-bit-char branch of q2repro.c:1913-1933 is unreachable here.
  if (lo & U_ANGLE1) MSG_WriteShort(msg, toAngle[0]);
  if (lo & U_ANGLE2) MSG_WriteShort(msg, toAngle[1]);
  if (lo & U_ANGLE3) MSG_WriteShort(msg, toAngle[2]);

  if (lo & U_OLDORIGIN) {
    MSG_WriteFloat(msg, to.old_origin[0]);
    MSG_WriteFloat(msg, to.old_origin[1]);
    MSG_WriteFloat(msg, to.old_origin[2]);
  }

  // Sound word: loop_volume/loop_attenuation only ever transmitted alongside
  // a sound-index change (q2repro.c:1940-1953 -- see file header's sound
  // encoding note: U_SOUND gates the whole block, and U_SOUND is only set
  // from a `sound` change, never from loop_volume/loop_attenuation alone).
  if (lo & U_SOUND) {
    let soundWord = to.sound & 0x3fff;
    if (loopAttenuationChanged) soundWord |= SOUND_FLAG_ATTENUATION;
    if (loopVolumeChanged) soundWord |= SOUND_FLAG_VOLUME;
    MSG_WriteShort(msg, soundWord);
    if (soundWord & SOUND_FLAG_VOLUME) MSG_WriteByte(msg, encodeLoopVolume(to.loop_volume));
    if (soundWord & SOUND_FLAG_ATTENUATION) MSG_WriteByte(msg, encodeLoopAttenuation(to.loop_attenuation));
  }

  if (lo & U_EVENT) MSG_WriteByte(msg, to.event);
  if (lo & U_SOLID) MSG_WriteLong(msg, to.solid); // u32 (q2repro.c:1957), not vanilla's u16

  if ((hi & HI_MOREFX16) !== 0 && (lo & U_MOREFX8) !== 0) MSG_WriteLong(msg, to.morefx);
  else if (hi & HI_MOREFX16) MSG_WriteShort(msg, to.morefx);
  else if (lo & U_MOREFX8) MSG_WriteByte(msg, to.morefx);

  if (lo & U_ALPHA) MSG_WriteByte(msg, encodeAlpha(to.alpha));
  if (hi & HI_SCALE) MSG_WriteByte(msg, encodeScale(to.scale));
}

// writeEntityRemove/writePacketEntitiesEnd: byte-identical to VANILLA_CODEC's
// for every value this engine ever produces. q2proto_common_server_write_entity_bits
// (the general 1038 header writer) and vanilla's inline equivalent agree
// exactly for a bits value that only ever sets U_REMOVE(+U_NUMBER16): both
// never need MOREBITS2/3/4 for that narrow case (U_REMOVE=bit6, U_NUMBER16=
// bit8 -- at most MOREBITS1 is required), so the two codecs cannot diverge
// here. Reused directly rather than re-implemented (q2repro.c:2247-2248
// calls the exact same q2proto_common_server_write_entity_bits helper this
// codec's writeEntityBitsWide ports above, for the identical U_REMOVE-only
// input).
const writeEntityRemove = VANILLA_CODEC.writeEntityRemove;
const writePacketEntitiesEnd = VANILLA_CODEC.writePacketEntitiesEnd;

const NULL_ENTITY_STATE = new EntityStateT();

function writeSpawnBaseline(msg: SizeBuf, base: EntityStateT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_spawnbaseline);
  writeDeltaEntity(msg, NULL_ENTITY_STATE, base, true, true);
}

// Result of computing (but not yet writing) a q2repro playerstate delta.
// Split out of writePlayerStateDelta so the frame envelope (writeFrame,
// below) can place `extraflags` at 1038's real wire position -- right after
// the frame's q2pro_frame_flags byte, BEFORE areabits
// (q2proto_proto_q2repro.c:2206-2242's `q2protoio_write_reserve_raw`/patch
// dance) -- while writeFlags()+writeBody() still land `flags` and the field
// bytes at their normal position after areabits. writePlayerStateDelta
// (the public, standalone-message op; unchanged wire format, still
// golden-tested by test/protocol_q2repro.test.ts) is now a thin wrapper
// around this that reproduces its original opcode+flags+extraflags+fields
// order exactly.
interface PlayerStateDeltaEncodedT {
  flags: number;
  extraflags: number;
  writeFlags(msg: SizeBuf): void;
  writeBody(msg: SizeBuf): void;
}

// q2repro_server_write_playerstate, q2repro.c:2006-2204 (the bit-computation
// half, q2repro.c:2006-2065; the "write it" half is writeFlags/writeBody
// below).
function encodePlayerStateDelta(from: PlayerStateT, to: PlayerStateT): PlayerStateDeltaEncodedT {
  let flags = 0;
  let extraflags = 0;

  // FLOAT PMOVE STATE END TO END (.orch/followups.md): sourced from
  // `originF`/`velocityF` (q_shared.ts) -- the genuine, un-narrowed float
  // value server/bindings/kex.ts's syncPlayerStateKexToEngine copies
  // straight from the kex game's own float pmove state -- not from the
  // legacy 12.3 fixed-point `origin`/`velocity` shadow. This is what
  // eliminates the quantize-requantize round trip: the value written to the
  // wire below is exactly what the kex game module holds, matching
  // q2repro.c's own encoding (q2proto_proto_q2repro.c:2081-2099, full
  // IEEE-754 float, no fixed-point stage at all).
  const toOriginF: [number, number, number] = [to.pmove.originF[0], to.pmove.originF[1], to.pmove.originF[2]];
  const fromOriginF: [number, number, number] = [from.pmove.originF[0], from.pmove.originF[1], from.pmove.originF[2]];
  const toVelF: [number, number, number] = [to.pmove.velocityF[0], to.pmove.velocityF[1], to.pmove.velocityF[2]];
  const fromVelF: [number, number, number] = [from.pmove.velocityF[0], from.pmove.velocityF[1], from.pmove.velocityF[2]];

  if (to.pmove.pm_type !== from.pmove.pm_type) flags |= PS_M_TYPE;

  const originXYChanged = toOriginF[0] !== fromOriginF[0] || toOriginF[1] !== fromOriginF[1];
  const originZChanged = toOriginF[2] !== fromOriginF[2];
  if (originXYChanged) flags |= PS_M_ORIGIN;
  if (originZChanged) extraflags |= EPS_M_ORIGIN2;

  const velXYChanged = toVelF[0] !== fromVelF[0] || toVelF[1] !== fromVelF[1];
  const velZChanged = toVelF[2] !== fromVelF[2];
  if (velXYChanged) flags |= PS_M_VELOCITY;
  if (velZChanged) extraflags |= EPS_M_VELOCITY2;

  if (to.pmove.pm_time !== from.pmove.pm_time) flags |= PS_M_TIME;
  if (to.pmove.pm_flags !== from.pmove.pm_flags) flags |= PS_M_FLAGS;
  if (to.pmove.gravity !== from.pmove.gravity) flags |= PS_M_GRAVITY;
  if (
    to.pmove.delta_angles[0] !== from.pmove.delta_angles[0] ||
    to.pmove.delta_angles[1] !== from.pmove.delta_angles[1] ||
    to.pmove.delta_angles[2] !== from.pmove.delta_angles[2]
  )
    flags |= PS_M_DELTA_ANGLES;

  // q2proto_proto_q2repro.c:2033-2034. Re-release eye height (int8); see the
  // file header's PM_VIEWHEIGHT section.
  if (to.pmove.viewheight !== from.pmove.viewheight) flags |= PS_RR_VIEWHEIGHT;

  const toViewoffset = [encodeFixed16(to.viewoffset[0], VIEWOFFSET_SCALE), encodeFixed16(to.viewoffset[1], VIEWOFFSET_SCALE), encodeFixed16(to.viewoffset[2], VIEWOFFSET_SCALE)];
  const fromViewoffset = [
    encodeFixed16(from.viewoffset[0], VIEWOFFSET_SCALE),
    encodeFixed16(from.viewoffset[1], VIEWOFFSET_SCALE),
    encodeFixed16(from.viewoffset[2], VIEWOFFSET_SCALE),
  ];
  const viewoffsetChanged = toViewoffset[0] !== fromViewoffset[0] || toViewoffset[1] !== fromViewoffset[1] || toViewoffset[2] !== fromViewoffset[2];
  if (viewoffsetChanged) flags |= PS_VIEWOFFSET;

  const toViewangleShort = [ANGLE2SHORT(to.viewangles[0]), ANGLE2SHORT(to.viewangles[1]), ANGLE2SHORT(to.viewangles[2])];
  const fromViewangleShort = [ANGLE2SHORT(from.viewangles[0]), ANGLE2SHORT(from.viewangles[1]), ANGLE2SHORT(from.viewangles[2])];
  const viewangleXYChanged = toViewangleShort[0] !== fromViewangleShort[0] || toViewangleShort[1] !== fromViewangleShort[1];
  const viewangleZChanged = toViewangleShort[2] !== fromViewangleShort[2];
  if (viewangleXYChanged) flags |= PS_VIEWANGLES;
  if (viewangleZChanged) extraflags |= EPS_VIEWANGLE2;

  const toKick = [encodeFixed16(to.kick_angles[0], KICK_ANGLE_SCALE), encodeFixed16(to.kick_angles[1], KICK_ANGLE_SCALE), encodeFixed16(to.kick_angles[2], KICK_ANGLE_SCALE)];
  const fromKick = [
    encodeFixed16(from.kick_angles[0], KICK_ANGLE_SCALE),
    encodeFixed16(from.kick_angles[1], KICK_ANGLE_SCALE),
    encodeFixed16(from.kick_angles[2], KICK_ANGLE_SCALE),
  ];
  const kickChanged = toKick[0] !== fromKick[0] || toKick[1] !== fromKick[1] || toKick[2] !== fromKick[2];
  if (kickChanged) flags |= PS_KICKANGLES;

  function byteColor(x: number): number {
    return Math.trunc(x * 255) & 0xff;
  }
  let blendBits = 0;
  for (let i = 0; i < 4; i++) if (byteColor(to.blend[i]) !== byteColor(from.blend[i])) blendBits |= 1 << i;
  let damageBlendBits = 0;
  for (let i = 0; i < 4; i++) if (byteColor(to.damage_blend[i]) !== byteColor(from.damage_blend[i])) damageBlendBits |= 1 << i;
  if (blendBits !== 0 || damageBlendBits !== 0) flags |= PS_BLEND;

  if (to.fov !== from.fov) flags |= PS_FOV;
  if (to.rdflags !== from.rdflags) flags |= PS_RDFLAGS;

  // PS_WEAPONINDEX is gated on gunindex ONLY, not gunskin -- a faithfully
  // reproduced q2repro quirk (q2repro.c:2053: `if (delta_bits &
  // Q2P_PSD_GUNINDEX) flags |= PS_WEAPONINDEX;`, no Q2P_PSD_GUNSKIN check).
  // A gunskin-only change is therefore silently NOT transmitted this delta.
  const gunindexChanged = to.gunindex !== from.gunindex;
  if (gunindexChanged) flags |= PS_WEAPONINDEX;

  if (to.gunframe !== from.gunframe) flags |= PS_WEAPONFRAME;

  const toGunoffset = [encodeFixed16(to.gunoffset[0], GUNOFFSET_SCALE), encodeFixed16(to.gunoffset[1], GUNOFFSET_SCALE), encodeFixed16(to.gunoffset[2], GUNOFFSET_SCALE)];
  const fromGunoffset = [
    encodeFixed16(from.gunoffset[0], GUNOFFSET_SCALE),
    encodeFixed16(from.gunoffset[1], GUNOFFSET_SCALE),
    encodeFixed16(from.gunoffset[2], GUNOFFSET_SCALE),
  ];
  if (toGunoffset[0] !== fromGunoffset[0] || toGunoffset[1] !== fromGunoffset[1] || toGunoffset[2] !== fromGunoffset[2]) extraflags |= EPS_GUNOFFSET;

  const toGunangles = [encodeFixed16(to.gunangles[0], GUNANGLE_SCALE), encodeFixed16(to.gunangles[1], GUNANGLE_SCALE), encodeFixed16(to.gunangles[2], GUNANGLE_SCALE)];
  const fromGunangles = [
    encodeFixed16(from.gunangles[0], GUNANGLE_SCALE),
    encodeFixed16(from.gunangles[1], GUNANGLE_SCALE),
    encodeFixed16(from.gunangles[2], GUNANGLE_SCALE),
  ];
  if (toGunangles[0] !== fromGunangles[0] || toGunangles[1] !== fromGunangles[1] || toGunangles[2] !== fromGunangles[2]) extraflags |= EPS_GUNANGLES;

  // 64-wide statbits mask (bigint, not number: bit 31 would otherwise force
  // `1 << i` into JS's 32-bit signed bitwise-op domain and go negative at
  // i=31, corrupting every higher bit). Matches q2proto_proto_q2repro.c's
  // wire format exactly: one delta pass over Q2PROTO_STATS (64) slots
  // setting BIT_ULL(i) per changed stat (q2proto_proto_q2repro.c:1624-1629),
  // one u64 statbits field, then one i16 per set bit -- see writeBody below.
  let statbits = 0n;
  for (let i = 0; i < to.stats.length; i++) if (to.stats[i] !== from.stats[i]) statbits |= 1n << BigInt(i);
  if (statbits !== 0n) extraflags |= EPS_STATS;

  const gunrateChanged = to.gunrate !== from.gunrate;
  if (gunrateChanged) extraflags |= EPS_GUNRATE;
  // EPS_CLIENTNUM: never set -- no PlayerStateT.clientnum field, and
  // q2proto gates it behind an opt-in servercontext feature this port
  // doesn't enable (q2proto_struct_svc.h:458).

  return {
    flags,
    extraflags,
    writeFlags(msg: SizeBuf): void {
      MSG_WriteShort(msg, flags);
    },
    writeBody(msg: SizeBuf): void {
      if (flags & PS_M_TYPE) MSG_WriteByte(msg, to.pmove.pm_type);
      if (flags & PS_M_ORIGIN) {
        MSG_WriteFloat(msg, toOriginF[0]);
        MSG_WriteFloat(msg, toOriginF[1]);
      }
      if (extraflags & EPS_M_ORIGIN2) MSG_WriteFloat(msg, toOriginF[2]);
      if (flags & PS_M_VELOCITY) {
        MSG_WriteFloat(msg, toVelF[0]);
        MSG_WriteFloat(msg, toVelF[1]);
      }
      if (extraflags & EPS_M_VELOCITY2) MSG_WriteFloat(msg, toVelF[2]);
      if (flags & PS_M_TIME) MSG_WriteShort(msg, to.pmove.pm_time);
      if (flags & PS_M_FLAGS) MSG_WriteShort(msg, to.pmove.pm_flags);
      if (flags & PS_M_GRAVITY) MSG_WriteShort(msg, to.pmove.gravity);
      if (flags & PS_M_DELTA_ANGLES) {
        MSG_WriteShort(msg, to.pmove.delta_angles[0]);
        MSG_WriteShort(msg, to.pmove.delta_angles[1]);
        MSG_WriteShort(msg, to.pmove.delta_angles[2]);
      }

      if (flags & PS_VIEWOFFSET) {
        MSG_WriteShort(msg, toViewoffset[0]);
        MSG_WriteShort(msg, toViewoffset[1]);
        MSG_WriteShort(msg, toViewoffset[2]);
      }
      if (flags & PS_VIEWANGLES) {
        MSG_WriteShort(msg, toViewangleShort[0]);
        MSG_WriteShort(msg, toViewangleShort[1]);
      }
      if (extraflags & EPS_VIEWANGLE2) MSG_WriteShort(msg, toViewangleShort[2]);

      if (flags & PS_KICKANGLES) {
        MSG_WriteShort(msg, toKick[0]);
        MSG_WriteShort(msg, toKick[1]);
        MSG_WriteShort(msg, toKick[2]);
      }

      if (flags & PS_WEAPONINDEX) {
        const gunIndexAndSkin = (to.gunindex & 0xffff) | ((to.gunskin << Q2PRO_GUNINDEX_BITS) & 0xffff);
        MSG_WriteShort(msg, gunIndexAndSkin);
      }
      if (flags & PS_WEAPONFRAME) MSG_WriteShort(msg, to.gunframe);
      if (extraflags & EPS_GUNOFFSET) {
        MSG_WriteShort(msg, toGunoffset[0]);
        MSG_WriteShort(msg, toGunoffset[1]);
        MSG_WriteShort(msg, toGunoffset[2]);
      }
      if (extraflags & EPS_GUNANGLES) {
        MSG_WriteShort(msg, toGunangles[0]);
        MSG_WriteShort(msg, toGunangles[1]);
        MSG_WriteShort(msg, toGunangles[2]);
      }

      if (flags & PS_BLEND) {
        MSG_WriteByte(msg, (blendBits & 0xf) | ((damageBlendBits & 0xf) << 4));
        for (let i = 0; i < 4; i++) if (blendBits & (1 << i)) MSG_WriteByte(msg, byteColor(to.blend[i]));
        for (let i = 0; i < 4; i++) if (damageBlendBits & (1 << i)) MSG_WriteByte(msg, byteColor(to.damage_blend[i]));
      }
      if (flags & PS_FOV) MSG_WriteByte(msg, to.fov);
      if (flags & PS_RDFLAGS) MSG_WriteByte(msg, to.rdflags);

      if (extraflags & EPS_STATS) {
        // q2proto_proto_q2repro.c:2183-2190: one WRITE_CHECKED(..., u64, statbits)
        // (a single 8-byte op, not two 32-bit halves), then one i16 per set bit,
        // 0..63. MSG_WriteLong64 is the same wire shape mvd.ts's own 64-wide
        // stats codec already uses (see that file for the precedent).
        MSG_WriteLong64(msg, statbits);
        for (let i = 0; i < to.stats.length; i++) if (statbits & (1n << BigInt(i))) MSG_WriteShort(msg, to.stats[i]);
      }

      if (extraflags & EPS_GUNRATE) MSG_WriteByte(msg, to.gunrate);

      // q2proto_proto_q2repro.c:2196-2197: i8, immediately after gunrate and
      // before EPS_CLIENTNUM (which this codec never sets).
      if (flags & PS_RR_VIEWHEIGHT) MSG_WriteChar(msg, to.pmove.viewheight);
    },
  };
}

// Public op (unchanged wire format from before the frame-envelope refactor --
// still a self-contained svc_playerinfo-tagged message; golden-tested by
// test/protocol_q2repro.test.ts). Reproduces the exact opcode/flags/
// extraflags/fields order encodePlayerStateDelta's split now computes
// separately.
function writePlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const enc = encodePlayerStateDelta(from, to);
  MSG_WriteByte(msg, SvcOpsT.svc_playerinfo);
  enc.writeFlags(msg);
  MSG_WriteByte(msg, enc.extraflags);
  enc.writeBody(msg);
}

// ---------------------------------------------------------------------------
// client -> server write / server-side read (usercmd)
// ---------------------------------------------------------------------------

// q2repro_client_write_move_delta, q2repro.c:1099-1148. See file header's
// "KNOWN GAP: usercmd upmove" -- bit values/order/field widths for
// angle/forward/side/buttons/impulse/msec/lightlevel are IDENTICAL to
// vanilla's MSG_WriteDeltaUsercmd (q2proto's CM_* constants share vanilla's
// bit positions exactly), so this delegates to the same primitive after
// asserting the one field 1038's non-batched format cannot carry is absent.
function writeDeltaUsercmd(msg: SizeBuf, from: UsercmdT, cmd: UsercmdT): void {
  if (cmd.upmove !== from.upmove) {
    throw new ComError(
      ERR_DROP,
      "q2repro (1038) non-batched clc_move cannot encode upmove changes (Q2P_ERR_BAD_DATA in q2proto_proto_q2repro.c:1112-1113/2578-2579); batched clc_batch_move is required for vertical movement and is not implemented (see q2repro.ts file header)",
    );
  }
  MSG_WriteDeltaUsercmd(msg, from, cmd);
}

function readDeltaUsercmd(msg: SizeBuf, from: UsercmdT, move: UsercmdT): void {
  // Symmetric with writeDeltaUsercmd: a real q2repro peer never sets CM_UP
  // on this message type, so vanilla's read (which simply no-ops when CM_UP
  // is unset) is already correct for every byte stream this codec's write
  // side -- or a real q2repro client's -- can produce.
  MSG_ReadDeltaUsercmd(msg, from, move);
}

// ---------------------------------------------------------------------------
// clc_q2pro_move_batched / clc_q2pro_move_nodelta / clc_q2pro_userinfo_delta
// (phase-8 q2repro interop unit -- see clc_batch_move.ts's file header for
// the full citation trail and the "upmove never applied"/"lightlevel never
// applied" findings this decode relies on).
// ---------------------------------------------------------------------------

// q2repro_server_read_batch_move_delta, q2proto_proto_q2repro.c:2620-2677.
// CM_UP is a hard protocol violation on this codec (q2repro.c:2662-2663
// returns Q2P_ERR_BAD_DATA the instant the bit is set) -- real q2repro
// clients never set it under 1038 (see clc_batch_move.ts's "upmove" finding:
// even q2pro's plain-tier format, which CAN carry the bit, never has it
// applied server-side, so a real client sending vertical movement here would
// gain nothing and 1038's own encoder simply never emits it).
function decodeQ2ReproBatchCmd(br: BitReader, prev: UsercmdT | null): UsercmdT {
  const cmd = seedFromPrev(prev);

  const hasContents = br.readUnsigned(1);
  if (!hasContents) return cmd; // angles/forwardmove/sidemove/buttons/msec all inherit from prev (or zero) -- see seedFromPrev

  const bits = br.readUnsigned(8);
  if (bits & CM_ANGLE1) cmd.angles[0] = readBatchMoveAngleComponent(br, prev ? prev.angles[0] : 0);
  if (bits & CM_ANGLE2) cmd.angles[1] = readBatchMoveAngleComponent(br, prev ? prev.angles[1] : 0);
  if (bits & CM_ANGLE3) cmd.angles[2] = br.readSigned(16); // no delta form for roll (q2repro.c:2646-2650)

  if (bits & CM_FORWARD) cmd.forwardmove = br.readSigned(10);
  if (bits & CM_SIDE) cmd.sidemove = br.readSigned(10);
  if (bits & CM_UP) {
    throw new ClcBatchMoveError(
      "clc_q2pro_move_batched (1038): CM_UP bit set -- q2repro's own decoder rejects this (Q2P_ERR_BAD_DATA, q2proto_proto_q2repro.c:2662-2663)",
    );
  }

  if (bits & CM_BUTTONS) cmd.buttons = br.readUnsigned(8); // full byte, unlike Q2PRO's 3-bit remap -- see q2pro.ts's decodeCmd

  // CM_IMPULSE is reused as "an explicit msec byte follows" in the batched
  // format -- there is no impulse field at all here (q2repro.c:2670-2675).
  if (bits & CM_IMPULSE) cmd.msec = br.readUnsigned(8);
  else cmd.msec = prev ? prev.msec : 0;

  return cmd;
}

// Client-side encode mirror of decodeQ2ReproBatchCmd above (the write half
// of q2proto's q2repro move-delta pair). Field choices are the always-valid
// forms the decoder accepts: hasContents always 1; angles always in their
// full 16-bit absolute form (delta flag 0 -- pitch/yaw's 8-bit delta form is
// an optional compression, not a requirement); CM_IMPULSE (the "explicit
// msec byte follows" reuse) always set so msec never relies on prev
// inheritance; CM_UP never set (the decoder rejects it per
// q2proto_proto_q2repro.c:2662-2663 -- vertical intent travels as
// BUTTON_JUMP/BUTTON_CROUCH in the kex usercmd, matching q2repro's own
// client input.c:824-827).
function encodeQ2ReproBatchCmd(bw: BitWriter, cmd: UsercmdT, prev: UsercmdT | null): void {
  bw.writeUnsigned(1, 1); // hasContents

  let bits = CM_IMPULSE; // msec byte always explicit
  const p0 = prev ? prev.angles[0] : 0;
  const p1 = prev ? prev.angles[1] : 0;
  const p2 = prev ? prev.angles[2] : 0;
  if (cmd.angles[0] !== p0) bits |= CM_ANGLE1;
  if (cmd.angles[1] !== p1) bits |= CM_ANGLE2;
  if (cmd.angles[2] !== p2) bits |= CM_ANGLE3;
  if (cmd.forwardmove !== (prev ? prev.forwardmove : 0)) bits |= CM_FORWARD;
  if (cmd.sidemove !== (prev ? prev.sidemove : 0)) bits |= CM_SIDE;
  if (cmd.buttons !== (prev ? prev.buttons : 0)) bits |= CM_BUTTONS;
  bw.writeUnsigned(bits, 8);

  if (bits & CM_ANGLE1) {
    bw.writeUnsigned(0, 1); // full 16-bit form
    bw.writeSigned(cmd.angles[0], 16);
  }
  if (bits & CM_ANGLE2) {
    bw.writeUnsigned(0, 1);
    bw.writeSigned(cmd.angles[1], 16);
  }
  if (bits & CM_ANGLE3) bw.writeSigned(cmd.angles[2], 16);
  // signed 10-bit range is +/-511; kex movement speeds (walk 200/run 400,
  // plus the game's own clamps) stay inside it, but clamp defensively so a
  // config-forced cl_forwardspeed can never corrupt the bitstream.
  if (bits & CM_FORWARD) bw.writeSigned(Math.max(-512, Math.min(511, cmd.forwardmove)), 10);
  if (bits & CM_SIDE) bw.writeSigned(Math.max(-512, Math.min(511, cmd.sidemove)), 10);
  if (bits & CM_BUTTONS) bw.writeUnsigned(cmd.buttons, 8);
  bw.writeUnsigned(cmd.msec, 8); // CM_IMPULSE's msec byte
}

// Write half of readBatchMove below: opcode byte is the CALLER's (nodelta
// selects CLC_Q2PRO_MOVE_NODELTA and passes lastframe null). numDups =
// frames.length - 1; lightlevel byte written 0 (the read side discards it).
function writeBatchMove(msg: SizeBuf, lastframe: number | null, frames: ClcBatchMoveFrameT[]): void {
  if (lastframe !== null) MSG_WriteLong(msg, lastframe);
  MSG_WriteByte(msg, frames.length - 1);
  MSG_WriteByte(msg, 0); // lightlevel
  const bw = new BitWriter(msg);
  writeBatchMoveFrames(bw, frames, encodeQ2ReproBatchCmd);
}

// q2repro_server_read_batch_move, q2proto_proto_q2repro.c:2679-2709.
function readBatchMove(msg: SizeBuf, nodelta: boolean, _opcodeExtra: number): ClcBatchMoveT {
  const lastframe = nodelta ? -1 : MSG_ReadLong(msg);

  const numDups = MSG_ReadByte(msg);
  if (numDups < 0) throw new ClcBatchMoveError("clc_q2pro_move_batched (1038): truncated message (num_dups)");
  if (numDups >= MAX_CLC_BATCH_MOVE_FRAMES - 1) {
    throw new ClcBatchMoveError("clc_q2pro_move_batched (1038): num_dups out of range (Q2P_ERR_BAD_DATA, q2proto_proto_q2repro.c:2687-2688)");
  }

  const lightlevel = MSG_ReadByte(msg); // decoded, never applied -- see clc_batch_move.ts's file header finding
  if (lightlevel < 0) throw new ClcBatchMoveError("clc_q2pro_move_batched (1038): truncated message (lightlevel)");

  const br = new BitReader(msg);
  const frames = readBatchMoveFrames(br, numDups, decodeQ2ReproBatchCmd);
  return { lastframe, numDups, frames };
}

// q2repro_server_read_userinfo_delta, q2proto_proto_q2repro.c:2718-2724.
function readUserinfoDelta(msg: SizeBuf): ClcUserinfoDeltaT {
  const name = MSG_ReadString(msg);
  const value = MSG_ReadString(msg);
  return { name, value };
}

// q2repro_server_read_setting, q2proto_proto_q2repro.c:2711-2716 (phase-8
// interop finding -- see codec.ts's ClcClientSettingT doc comment: a real
// q2repro client sends clc_r1q2_setting immediately after entering the game,
// before any movement packet). Both fields are genuinely SIGNED
// (q2proto_proto_q2repro.c:2712-2713's `READ_CHECKED(..., setting->index,
// i16)` / `..., setting->value, i16)`), matching MSG_ReadShort exactly.
function readClientSetting(msg: SizeBuf): ClcClientSettingT {
  const index = MSG_ReadShort(msg);
  const value = MSG_ReadShort(msg);
  return { index, value };
}

// ---------------------------------------------------------------------------
// client-side reads (net_message singleton -- see codec.ts's asymmetry note)
// ---------------------------------------------------------------------------

// q2proto_q2repro_continue_serverdata, q2proto_proto_q2repro.c:122-166 (the
// wire-read half; feature-flag/context bookkeeping the C does afterward has
// no counterpart here -- this engine advertises none of q2pro's extended
// protocol features either, per writeServerData's file header note, so there
// is nothing for a real q2repro server's response to turn on). Field order
// after the already-consumed leading protocol-number long matches
// writeServerData's own byte order exactly (both were derived from the same
// q2proto source): i32 servercount, bool attractloop, string gamedir, i16
// clientnum, string levelname, u16 protocol_version (q2pro extended minor
// version -- this engine has no minor-version concept to react to, so it is
// read to stay byte-aligned and then discarded, same treatment
// writeServerData gives it on the write side by always emitting 0), u8
// q2pro.server_state (kept -- ServerDataReadResultT.serverState), u16
// q2repro_flags (q2proto_proto_q2repro.c:133-143 unpacks this into six
// separate q2pro/q2repro extension booleans this engine implements none of;
// discarded whole, matching writeServerData always emitting 0 for it), u8
// server_fps (q2proto_proto_q2repro.c:144 -- real q2repro clients resync
// their logic-tick rate from this; this engine's client, like its server
// side, runs prediction/interpolation on a fixed-tick assumption until
// ARCHITECTURE.md phase 3's tick-rate binding lands -- server.ts's own
// framerate/frametime doc comment documents the same pre-existing gap on the
// write side -- so it is read to stay byte-aligned and then discarded).
//
// Signed/unsigned audit (.orch/followups.md's signed/unsigned follow-up):
// clientnum is read via MSG_ReadShort (SIGNED), matching its cited i16 type
// exactly (q2repro_client_read_serverdata's serverdata->clientnum). The two
// discarded u16 reads (protocol_version, q2repro_flags below) are left on
// MSG_ReadShort rather than MSG_ReadWord -- the value is thrown away
// unread, so sign has no observable effect either way; converting them
// would be a no-op change made only for its own sake.
function readServerData(): ServerDataReadResultT {
  const servercount = MSG_ReadLong(net_message);
  const attractloop = MSG_ReadByte(net_message) !== 0;
  const gamedir = MSG_ReadString(net_message);
  const clientnum = MSG_ReadShort(net_message);
  const levelname = MSG_ReadString(net_message);
  MSG_ReadShort(net_message); // protocol_version (q2pro extended minor version): unused
  const serverState = MSG_ReadByte(net_message);
  MSG_ReadShort(net_message); // q2repro_flags: no q2pro/q2repro extension this engine acts on
  MSG_ReadByte(net_message); // server_fps: see doc comment above -- fixed-tick assumption, discarded
  return { servercount, attractloop, gamedir, clientnum, levelname, serverState };
}

function readEntityBits(): { number: number; bits: number } {
  return readEntityBitsWide();
}

function copyEntityState(dst: EntityStateT, src: EntityStateT): void {
  dst.number = src.number;
  dst.origin.set(src.origin);
  dst.angles.set(src.angles);
  dst.old_origin.set(src.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.morefx = src.morefx;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
  dst.alpha = src.alpha;
  dst.scale = src.scale;
  dst.loop_volume = src.loop_volume;
  dst.loop_attenuation = src.loop_attenuation;
}

function readDeltaEntity(from: EntityStateT, to: EntityStateT, number: number, bits: number): void {
  copyEntityState(to, from);
  to.old_origin.set(from.origin);
  to.number = number;

  // Every 16-bit entity field below is read UNSIGNED (MSG_ReadWord), matching
  // q2repro src/common/msg.c:2185-2220's own MSG_ReadWord() calls and
  // q2proto_proto_q2repro.c:444/476/485/494's `READ_CHECKED(..., u16)`.
  // This is load-bearing, not cosmetic: writeDeltaEntity above sizes these
  // fields with `widthOf(x, /*uint16Safe=*/true)` (q2repro msg.c:633's
  // `mask = 0xffff0000`), so any value in 0x8000..0xffff rides the 16-bit
  // wire -- a signed read sign-extends bit 15 across bits 16..31. For
  // renderfx that turns the rerelease game's near-universal
  // RF_IR_VISIBLE (0x8000, set on every spawned entity by g_spawn.cpp)
  // into 0xffff8000, which lights up RF_SHELL_DOUBLE|RF_SHELL_HALF_DAM and
  // makes ref_gl draw the model as an untextured yellow shell blob.
  const model16 = (bits & U_MODEL16) !== 0;
  if (bits & U_MODEL) to.modelindex = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);
  if (bits & U_MODEL2) to.modelindex2 = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);
  if (bits & U_MODEL3) to.modelindex3 = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);
  if (bits & U_MODEL4) to.modelindex4 = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);

  if (bits & U_FRAME16) to.frame = MSG_ReadWord(net_message);
  else if (bits & U_FRAME8) to.frame = MSG_ReadByte(net_message);

  if ((bits & (U_SKIN8 | U_SKIN16)) === (U_SKIN8 | U_SKIN16)) to.skinnum = MSG_ReadLong(net_message);
  else if (bits & U_SKIN16) to.skinnum = MSG_ReadWord(net_message);
  else if (bits & U_SKIN8) to.skinnum = MSG_ReadByte(net_message);

  if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) to.effects = MSG_ReadLong(net_message);
  else if (bits & U_EFFECTS16) to.effects = MSG_ReadWord(net_message);
  else if (bits & U_EFFECTS8) to.effects = MSG_ReadByte(net_message);

  if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) to.renderfx = MSG_ReadLong(net_message);
  else if (bits & U_RENDERFX16) to.renderfx = MSG_ReadWord(net_message);
  else if (bits & U_RENDERFX8) to.renderfx = MSG_ReadByte(net_message);

  if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadFloat(net_message);
  if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadFloat(net_message);
  if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadFloat(net_message);

  // U_ANGLE16 is always set alongside any angle bit on this protocol's write
  // side (see writeDeltaEntity); read supports the 8-bit branch too since a
  // real peer's bit stream is authoritative, not just this codec's own.
  // SIGNED by design (q2proto_internal_io.h:213-218's
  // READ_CHECKED_VAR_ANGLES_COMP_16 -- `int16_t a; READ_CHECKED(..., a, i16)`),
  // matching MSG_ReadShort exactly: SHORT2ANGLE's own -32768..32767 domain
  // needs the negative half to represent angles past 180 degrees.
  if (bits & U_ANGLE16) {
    if (bits & U_ANGLE1) to.angles[0] = SHORT2ANGLE(MSG_ReadShort(net_message));
    if (bits & U_ANGLE2) to.angles[1] = SHORT2ANGLE(MSG_ReadShort(net_message));
    if (bits & U_ANGLE3) to.angles[2] = SHORT2ANGLE(MSG_ReadShort(net_message));
  } else {
    if (bits & U_ANGLE1) to.angles[0] = MSG_ReadByte(net_message) * (360.0 / 256);
    if (bits & U_ANGLE2) to.angles[1] = MSG_ReadByte(net_message) * (360.0 / 256);
    if (bits & U_ANGLE3) to.angles[2] = MSG_ReadByte(net_message) * (360.0 / 256);
  }

  if (bits & U_OLDORIGIN) {
    to.old_origin[0] = MSG_ReadFloat(net_message);
    to.old_origin[1] = MSG_ReadFloat(net_message);
    to.old_origin[2] = MSG_ReadFloat(net_message);
  }

  if (bits & U_SOUND) {
    // Unsigned (q2proto_proto_q2repro.c:546-547's `uint16_t sound_word;
    // READ_CHECKED(..., u16)`). A signed read happened to be harmless here
    // (SOUND_FLAG_VOLUME/ATTENUATION are bits 14/15 and `to.sound`'s own
    // 0x3fff mask only ever touches bits 0-13, all below the sign-extension
    // boundary), but MSG_ReadWord is used anyway to match the wire type
    // exactly rather than rely on that coincidence.
    const soundWord = MSG_ReadWord(net_message);
    to.sound = soundWord & 0x3fff;
    if (soundWord & SOUND_FLAG_VOLUME) to.loop_volume = decodeLoopVolume(MSG_ReadByte(net_message));
    if (soundWord & SOUND_FLAG_ATTENUATION) to.loop_attenuation = decodeLoopAttenuation(MSG_ReadByte(net_message));
  }

  if (bits & U_EVENT) to.event = MSG_ReadByte(net_message);
  else to.event = 0;

  if (bits & U_SOLID) to.solid = MSG_ReadLong(net_message);

  if (bitsHasHi(bits, HI_MOREFX16) && bits & U_MOREFX8) to.morefx = MSG_ReadLong(net_message);
  else if (bitsHasHi(bits, HI_MOREFX16)) to.morefx = MSG_ReadWord(net_message); // unsigned: q2repro msg.c:2264-2270, same widthOf(...,true) writer
  else if (bits & U_MOREFX8) to.morefx = MSG_ReadByte(net_message);

  if (bits & U_ALPHA) to.alpha = decodeAlpha(MSG_ReadByte(net_message));
  if (bitsHasHi(bits, HI_SCALE)) to.scale = decodeScale(MSG_ReadByte(net_message));
}

// Mirror of encodePlayerStateDelta's write-side split: reads the field body
// given an already-known `flags`/`extraflags` pair, WITHOUT reading them
// from `msg` itself (their wire position differs between the standalone
// svc_playerinfo message and the 1038 frame envelope -- see readFrame's
// comment below for where the frame envelope reads them from instead).
function readPlayerStateFields(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT, flags: number, extraflags: number): void {
  to.pmove.pm_type = from.pmove.pm_type;
  to.pmove.origin.set(from.pmove.origin);
  to.pmove.velocity.set(from.pmove.velocity);
  to.pmove.originF.set(from.pmove.originF);
  to.pmove.velocityF.set(from.pmove.velocityF);
  to.pmove.pm_flags = from.pmove.pm_flags;
  to.pmove.pm_time = from.pmove.pm_time;
  to.pmove.gravity = from.pmove.gravity;
  to.pmove.delta_angles.set(from.pmove.delta_angles);
  to.pmove.viewheight = from.pmove.viewheight;
  to.viewangles.set(from.viewangles);
  to.viewoffset.set(from.viewoffset);
  to.kick_angles.set(from.kick_angles);
  to.gunangles.set(from.gunangles);
  to.gunoffset.set(from.gunoffset);
  to.gunindex = from.gunindex;
  to.gunskin = from.gunskin;
  to.gunframe = from.gunframe;
  to.gunrate = from.gunrate;
  to.blend.set(from.blend);
  to.damage_blend.set(from.damage_blend);
  to.fov = from.fov;
  to.rdflags = from.rdflags;
  to.stats.set(from.stats);

  if (flags & PS_M_TYPE) to.pmove.pm_type = MSG_ReadByte(msg);

  // FLOAT PMOVE STATE END TO END (.orch/followups.md): q2repro.c's own
  // svc_playerstate reads pm_origin/pm_velocity as full IEEE-754 floats
  // (q2proto_proto_q2repro.c:636-653) -- `originF`/`velocityF` below carry
  // that value through with NO narrowing, matching the wire exactly. The
  // legacy `origin`/`velocity` Int16Array fields are ALSO kept in sync (12.3
  // fixed, same `pmFloatToShort` formula as before this fix) purely for the
  // family-generic client consumers that still read them (cl_ents.ts's
  // interpolation teleport check and non-predicting render path,
  // CL_CheckPredictionError's debug compare) -- neither of those needs the
  // extra precision, and this keeps them byte-for-byte unchanged.
  let originX = to.pmove.originF[0];
  let originY = to.pmove.originF[1];
  let originZ = to.pmove.originF[2];
  if (flags & PS_M_ORIGIN) {
    originX = MSG_ReadFloat(msg);
    originY = MSG_ReadFloat(msg);
  }
  if (extraflags & EPS_M_ORIGIN2) originZ = MSG_ReadFloat(msg);
  if (flags & PS_M_ORIGIN || extraflags & EPS_M_ORIGIN2) {
    to.pmove.originF[0] = originX;
    to.pmove.originF[1] = originY;
    to.pmove.originF[2] = originZ;
    to.pmove.origin[0] = pmFloatToShort(originX);
    to.pmove.origin[1] = pmFloatToShort(originY);
    to.pmove.origin[2] = pmFloatToShort(originZ);
  }

  let velX = to.pmove.velocityF[0];
  let velY = to.pmove.velocityF[1];
  let velZ = to.pmove.velocityF[2];
  if (flags & PS_M_VELOCITY) {
    velX = MSG_ReadFloat(msg);
    velY = MSG_ReadFloat(msg);
  }
  if (extraflags & EPS_M_VELOCITY2) velZ = MSG_ReadFloat(msg);
  if (flags & PS_M_VELOCITY || extraflags & EPS_M_VELOCITY2) {
    to.pmove.velocityF[0] = velX;
    to.pmove.velocityF[1] = velY;
    to.pmove.velocityF[2] = velZ;
    to.pmove.velocity[0] = pmFloatToShort(velX);
    to.pmove.velocity[1] = pmFloatToShort(velY);
    to.pmove.velocity[2] = pmFloatToShort(velZ);
  }

  // pm_time/pm_flags: UNSIGNED (q2proto_proto_q2repro.c:656/659's
  // `READ_CHECKED(..., playerstate->pm_time, u16)` /
  // `READ_CHECKED(..., playerstate->pm_flags, u16)`). This was a real
  // mismatch: pm_time is stored and used as a millisecond magnitude
  // (pmove.ts's countdown/expiry checks), so a signed read would go negative
  // -- and stay wrong -- for any value >= 0x8000 instead of wrapping the way
  // the C `uint16_t` field does. pm_flags is bitwise-only downstream today,
  // so the earlier signed read never actually corrupted a flag test (no
  // PMF_* bit this port sets is >= bit 16), but MSG_ReadWord is used anyway
  // to match the wire type exactly.
  if (flags & PS_M_TIME) to.pmove.pm_time = MSG_ReadWord(msg);
  if (flags & PS_M_FLAGS) to.pmove.pm_flags = MSG_ReadWord(msg);
  // gravity: genuinely SIGNED (q2proto_proto_q2repro.c:662's
  // `READ_CHECKED(..., playerstate->pm_gravity, i16)`) -- kex/q2repro support
  // negative and zero gravity (low-gravity/moon/reverse-gravity settings), so
  // this is intentionally left as MSG_ReadShort, not a missed case.
  if (flags & PS_M_GRAVITY) to.pmove.gravity = MSG_ReadShort(msg);
  // delta_angles: SIGNED (q2proto_internal_io.h:228-234's read_var_angles16,
  // itself READ_CHECKED_VAR_ANGLES_COMP_16 -> i16) -- angle deltas are
  // legitimately negative, matching MSG_ReadShort exactly.
  if (flags & PS_M_DELTA_ANGLES) {
    to.pmove.delta_angles[0] = MSG_ReadShort(msg);
    to.pmove.delta_angles[1] = MSG_ReadShort(msg);
    to.pmove.delta_angles[2] = MSG_ReadShort(msg);
  }

  // viewoffset: SIGNED (q2proto_internal_io.h:269-274's
  // READ_CHECKED_VIEWOFFSET_COMP_Q2REPRO -> i16) -- a crouching/dead player's
  // eye offset goes negative.
  if (flags & PS_VIEWOFFSET) {
    to.viewoffset[0] = MSG_ReadShort(msg) / VIEWOFFSET_SCALE;
    to.viewoffset[1] = MSG_ReadShort(msg) / VIEWOFFSET_SCALE;
    to.viewoffset[2] = MSG_ReadShort(msg) / VIEWOFFSET_SCALE;
  }

  // viewangles: SIGNED (q2proto_internal_io.h:213-218's
  // READ_CHECKED_VAR_ANGLES_COMP_16 -> i16), same SHORT2ANGLE domain as the
  // entity-delta angle16 case above.
  if (flags & PS_VIEWANGLES) {
    to.viewangles[0] = SHORT2ANGLE(MSG_ReadShort(msg));
    to.viewangles[1] = SHORT2ANGLE(MSG_ReadShort(msg));
  }
  if (extraflags & EPS_VIEWANGLE2) to.viewangles[2] = SHORT2ANGLE(MSG_ReadShort(msg));

  // kick_angles: SIGNED (q2proto_internal_io.h:317-322's
  // READ_CHECKED_KICK_ANGLES_COMP_Q2REPRO -> i16) -- kick angles oscillate
  // around zero.
  if (flags & PS_KICKANGLES) {
    to.kick_angles[0] = MSG_ReadShort(msg) / KICK_ANGLE_SCALE;
    to.kick_angles[1] = MSG_ReadShort(msg) / KICK_ANGLE_SCALE;
    to.kick_angles[2] = MSG_ReadShort(msg) / KICK_ANGLE_SCALE;
  }

  // gun_index_and_skin: UNSIGNED (q2proto_proto_q2repro.c:688-689's
  // `uint16_t gun_index_and_skin; READ_CHECKED(..., u16)`). This one WAS a
  // live bug, not just a type nit: `>>> Q2PRO_GUNINDEX_BITS` (13) pulls bits
  // 13-31 into gunskin, and a signed MSG_ReadShort sign-extends bit 15 across
  // bits 16-31 before the shift -- any gunskin value with its own top bit set
  // (skin index 4-7 of the 3-bit field) produced a gunskin in the hundreds of
  // thousands instead of 4-7. gunindex itself (`& Q2PRO_GUNINDEX_MASK`, bits
  // 0-12) was never affected, since sign extension never touches bits 0-15.
  if (flags & PS_WEAPONINDEX) {
    const gunIndexAndSkin = MSG_ReadWord(msg);
    to.gunindex = gunIndexAndSkin & Q2PRO_GUNINDEX_MASK;
    to.gunskin = gunIndexAndSkin >>> Q2PRO_GUNINDEX_BITS;
  }
  // gunframe: UNSIGNED (q2proto_proto_q2repro.c:697's
  // `READ_CHECKED(..., playerstate->gunframe, u16)`) -- an animation-frame
  // magnitude, same class of bug as pm_time above.
  if (flags & PS_WEAPONFRAME) to.gunframe = MSG_ReadWord(msg);
  // gunoffset/gunangles: SIGNED (q2proto_proto_q2repro.c:61-89's
  // read_short_gunoffset/read_short_gunangles -> i16 each) -- offsets/angles
  // oscillate around zero during weapon bob/kick.
  if (extraflags & EPS_GUNOFFSET) {
    to.gunoffset[0] = MSG_ReadShort(msg) / GUNOFFSET_SCALE;
    to.gunoffset[1] = MSG_ReadShort(msg) / GUNOFFSET_SCALE;
    to.gunoffset[2] = MSG_ReadShort(msg) / GUNOFFSET_SCALE;
  }
  if (extraflags & EPS_GUNANGLES) {
    to.gunangles[0] = MSG_ReadShort(msg) / GUNANGLE_SCALE;
    to.gunangles[1] = MSG_ReadShort(msg) / GUNANGLE_SCALE;
    to.gunangles[2] = MSG_ReadShort(msg) / GUNANGLE_SCALE;
  }

  if (flags & PS_BLEND) {
    const blendBits = MSG_ReadByte(msg);
    for (let i = 0; i < 4; i++) if (blendBits & (1 << i)) to.blend[i] = MSG_ReadByte(msg) / 255;
    for (let i = 0; i < 4; i++) if (blendBits & (1 << (i + 4))) to.damage_blend[i] = MSG_ReadByte(msg) / 255;
  }

  if (flags & PS_FOV) to.fov = MSG_ReadByte(msg);
  if (flags & PS_RDFLAGS) to.rdflags = MSG_ReadByte(msg);

  if (extraflags & EPS_STATS) {
    // q2proto_proto_q2repro.c:721-728: one READ_CHECKED(..., u64, statbits)
    // (a single 8-byte op), then one i16 per set bit, 0..63 -- mirrors the
    // write side above exactly. PlayerStateT.stats is MAX_STATS_STORAGE=64-
    // wide (q_shared.ts), so all 64 bits now have a real slot to land in.
    const statbits = MSG_ReadLong64(msg);
    for (let i = 0; i < to.stats.length; i++) if (statbits & (1n << BigInt(i))) to.stats[i] = MSG_ReadShort(msg);
  }

  if (extraflags & EPS_GUNRATE) to.gunrate = MSG_ReadByte(msg);

  // q2proto_proto_q2repro.c:734-735: i8 (SIGNED -- a dead player's viewheight
  // goes negative), read right after gunrate.
  if (flags & PS_RR_VIEWHEIGHT) to.pmove.viewheight = MSG_ReadChar(msg);
}

// Public op (unchanged wire format): reads flags(u16)+extraflags(u8) from
// `msg` itself, then delegates to the shared field-reading body. flags is
// UNSIGNED (q2proto_proto_q2repro.c:617-618's `uint16_t flags;
// READ_CHECKED(..., u16)`) -- bitwise-only downstream (delta_bits_check
// against PS_* constants, all < bit 16), so a signed read was never
// exploitable here, but MSG_ReadWord matches the wire type exactly.
function readPlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const flags = MSG_ReadWord(msg);
  const extraflags = MSG_ReadByte(msg);
  readPlayerStateFields(msg, from, to, flags, extraflags);
}

// ---------------------------------------------------------------------------
// frame envelope (q2repro_server_write_frame / q2repro_client_read_frame,
// q2proto_proto_q2repro.c:2206-2242 / :751-784). See this file's header
// "KNOWN GAP: frame envelope" note -- this is that follow-up.
// ---------------------------------------------------------------------------

// q2proto_struct_svc.h:546's `q2pro_frame_flags` (masked to 0x0F on read,
// q2repro.c:770) reuses q2pro's older FF_* frame-flags namespace
// (qsrc/q2repro/inc/common/protocol.h:468-471 -- NOT the same bits as
// Q2PRO_PF_* handshake flags in ServerDataParamsT/writeServerData). Real
// q2repro (qsrc/q2repro/src/server/entities.c:394 `message.frame.q2pro_frame_flags
// = client->frameflags`, set from send.c:81,881 `client->frameflags |=
// FF_SUPPRESSED`) only ever sets FF_SUPPRESSED from this engine's
// equivalent mechanism (client.surpressCount, a rate-drop counter). This
// port has no client-drop/client-prediction-suppression state to map to
// FF_CLIENTDROP(2)/FF_CLIENTPRED(4) (r1q2/q2pro extended-protocol features
// this engine never implemented -- see codec.ts's "excluded" list), so
// those bits are never set; FF_RESERVED(8) is, per its name, always 0.
const FF_SUPPRESSED = 1 << 0;

// q2repro's `suppress_count` struct field (q2proto_struct_svc.h:541) is
// never actually read off the wire by q2repro_client_read_frame (q2repro.c:
// 751-784 has no suppress_count read at all -- confirmed by grep) or written
// by q2repro_server_write_frame (q2repro.c:2196-2242 never writes it
// either), so this codec can only reconstruct the boolean fact "at least one
// packet was suppressed" from FF_SUPPRESSED, not the real multi-drop count
// vanilla's byte carries. cl_scrn.ts's only consumer (a debug netgraph loop,
// `for (i = 0; i < cl.surpressCount; i++)`) is cosmetic, so collapsing to
// 0-or-1 here is a safe, documented simplification.
function encodeFrameFlags(surpressCount: number): number {
  return surpressCount !== 0 ? FF_SUPPRESSED : 0;
}
function decodeFrameFlags(frameFlags: number): number {
  return frameFlags & FF_SUPPRESSED ? 1 : 0;
}

function writePacketEntitiesBegin(_msg: SizeBuf): void {
  // 1038 has no svc_packetentities opcode: entity deltas follow the
  // playerstate delta directly (q2proto_struct_svc.h:530-536's
  // Q2P_SVC_FRAME_ENTITY_DELTA "pseudo-message" doc comment -- there is no
  // real per-message header on the wire, only a reader-side abstraction).
}

// q2repro_server_write_frame, q2repro.c:2206-2242.
function writeFrame(msg: SizeBuf, params: FrameWriteParamsT, writeEntities: (msg: SizeBuf) => void): void {
  MSG_WriteByte(msg, SvcOpsT.svc_frame);

  // we don't need full 32bits for framenum - 27 gives enough for 155 days on
  // the same map :) (q2repro.c:2199-2200's comment, preserved)
  const deltaframe = params.lastframe;
  const offset = deltaframe === -1 ? 31 : params.framenum - deltaframe; // 31: special case (q2repro.c:2210-2213)
  const encodedFrame = (params.framenum & 0x07ffffff) | (offset << 27);
  MSG_WriteLong(msg, encodedFrame);

  MSG_WriteByte(msg, encodeFrameFlags(params.surpressCount));

  // The reserved extraflags byte (q2repro.c:2219-2221's
  // q2protoio_write_reserve_raw + later patch): this engine has no
  // reserve/patch primitive, but since JS evaluation order is caller-
  // controlled (unlike C writing sequentially into a fixed stream), the same
  // byte VALUE is available immediately by computing the playerstate delta
  // now and simply writing extraflags at its real wire position (right here,
  // before areabits) instead of patching it in later. `enc.writeFlags`/
  // `enc.writeBody` (called after areabits, matching q2repro.c's actual call
  // site for q2repro_server_write_playerstate) land `flags`/the field bytes
  // at their correct, later position.
  const enc = encodePlayerStateDelta(params.psFrom ?? new PlayerStateT(), params.psTo);
  MSG_WriteByte(msg, enc.extraflags);

  // write areabits
  MSG_WriteByte(msg, params.areabytes);
  SZ_Write(msg, params.areabits, params.areabytes);

  enc.writeFlags(msg);
  enc.writeBody(msg);

  // delta encode the entities (q2repro_server_write_frame_entity_delta,
  // q2repro.c:2244-2260 -- no leading opcode, see writePacketEntitiesBegin)
  writeEntities(msg);
}

// Carries q2repro's frame-embedded extraflags byte from readFrameHeader to
// the immediately-following readFramePlayerstate call -- the read-side
// mirror of writeFrame's "no reserve/patch primitive" note above, and a
// faithful (if simpler) stand-in for q2proto's own context-carried state
// machine (q2repro_client_read_frame hands off via
// `context->client_read = q2repro_client_read_delta_entities`). Safe because
// message parsing is synchronous and single-message-at-a-time (same
// assumption net_message's own singleton already relies on).
let pendingFrameExtraflags = 0;

// q2repro_client_read_frame, q2repro.c:751-784 (the header/areabits half;
// the playerstate half is readFramePlayerstate below).
function readFrameHeader(areabits: Uint8Array, _readSuppressByte: boolean): FrameHeaderT {
  const encodedFrame = MSG_ReadLong(net_message);
  const offset = encodedFrame >>> 27; // top 5 bits, unsigned (q2repro.c:757-758)
  const serverframe = encodedFrame & 0x07ffffff;
  const deltaframe = offset === 31 ? -1 : serverframe - offset;

  const frameFlags = MSG_ReadByte(net_message) & 0x0f;
  pendingFrameExtraflags = MSG_ReadByte(net_message);

  const len = MSG_ReadByte(net_message);
  MSG_ReadData(net_message, areabits, len);

  return { serverframe, deltaframe, surpressCount: decodeFrameFlags(frameFlags) };
}

// q2repro_client_read_frame's playerstate call (q2repro.c:780), using the
// extraflags byte readFrameHeader already consumed. flags is UNSIGNED, same
// citation/reasoning as readPlayerStateDelta's own flags read above
// (q2proto_proto_q2repro.c:617-618).
function readFramePlayerstate(from: PlayerStateT, to: PlayerStateT): void {
  const flags = MSG_ReadWord(net_message);
  readPlayerStateFields(net_message, from, to, flags, pendingFrameExtraflags);
}

function readPacketEntitiesBegin(): void {
  // no opcode to consume -- see writePacketEntitiesBegin.
}

// q2proto_q2repro_client_read_fog, q2proto_proto_q2repro.c:818-882: the
// svc_fog message body (the leading svc_fog opcode byte itself is consumed
// by the caller, matching every other read* function in this file). NOT
// part of the ProtocolCodec interface -- like svc_damage/svc_poi/etc, this
// is a one-off auxiliary server command with a single, protocol-version-
// independent wire shape (not an entity/playerstate delta encoding that
// genuinely varies per protocol), so it follows the same
// write-it-directly-with-gi/read-it-directly-with-MSG_Read* convention
// those messages already use elsewhere in this port line rather than
// growing the codec seam for a single message type.
//
// Exported so qcommon/protocol/kexdemo.ts's KEX-native demo codec can reuse
// it verbatim -- q2proto_proto_kex.c:266-267 does exactly this on the C
// side (`case Q2P_SVC_FOG: return q2proto_q2repro_client_read_fog(...)`):
// the KEX-native demo format's own svc_fog carries the identical byte
// layout as protocol 1038's network svc_fog, because kex.c's demo reader
// never defines its own fog decoder -- it calls straight into q2repro's.
//
// Byte layout (matches this file's own p_view.ts-facing write side,
// src/kexgame/p_view.ts's sendFogTransition, field-for-field and in the
// same order): bits (u8), + a second bits byte (u8, shifted left 8 and
// OR'd in) iff BIT_MORE_BITS is set; then, only for each set bit:
// BIT_DENSITY -> density(float) + skyfactor(u8); BIT_R/G/B -> one u8 each;
// BIT_TIME -> u16; BIT_HEIGHTFOG_FALLOFF/DENSITY -> float each;
// BIT_HEIGHTFOG_START_R/G/B -> one u8 each; BIT_HEIGHTFOG_START_DIST ->
// i32 (unscaled, q2proto_var_coord_set_int_unscaled); BIT_HEIGHTFOG_END_*
// mirror the START_* fields exactly.
export function readFog(): SvcFogDataT {
  let bits = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_MORE_BITS) {
    bits |= MSG_ReadByte(net_message) << 8;
  }

  const fog: SvcFogDataT = {
    bits,
    density: 0,
    skyfactor: 0,
    red: 0,
    green: 0,
    blue: 0,
    time: 0,
    hf_falloff: 0,
    hf_density: 0,
    hf_start_r: 0,
    hf_start_g: 0,
    hf_start_b: 0,
    hf_start_dist: 0,
    hf_end_r: 0,
    hf_end_g: 0,
    hf_end_b: 0,
    hf_end_dist: 0,
  };

  if (bits & SvcFogDataBitsT.BIT_DENSITY) {
    fog.density = MSG_ReadFloat(net_message);
    fog.skyfactor = MSG_ReadByte(net_message);
  }
  if (bits & SvcFogDataBitsT.BIT_R) fog.red = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_G) fog.green = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_B) fog.blue = MSG_ReadByte(net_message);
  // Unsigned (q2proto_proto_q2repro.c:845's `READ_CHECKED(...,
  // fog->global.time, u16)`) -- a transition-duration magnitude in
  // milliseconds, same class of bug as pm_time/gunframe above: a signed read
  // would go negative for any transition >= 32768ms (~32.7s), corrupting the
  // fade timer.
  if (bits & SvcFogDataBitsT.BIT_TIME) fog.time = MSG_ReadWord(net_message);

  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_FALLOFF) fog.hf_falloff = MSG_ReadFloat(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_DENSITY) fog.hf_density = MSG_ReadFloat(net_message);

  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_R) fog.hf_start_r = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_G) fog.hf_start_g = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_B) fog.hf_start_b = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_DIST) fog.hf_start_dist = MSG_ReadLong(net_message);

  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_R) fog.hf_end_r = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_G) fog.hf_end_g = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_B) fog.hf_end_b = MSG_ReadByte(net_message);
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_DIST) fog.hf_end_dist = MSG_ReadLong(net_message);

  return fog;
}

export const Q2REPRO_CODEC: ProtocolCodec = {
  name: "q2repro",
  writeServerData,
  writeDeltaEntity,
  writeEntityRemove,
  writePacketEntitiesEnd,
  writeSpawnBaseline,
  writePlayerStateDelta,
  writePacketEntitiesBegin,
  writeFrame,
  writeDeltaUsercmd,
  readDeltaUsercmd,
  readServerData,
  readEntityBits,
  readDeltaEntity,
  readFrameHeader,
  readFramePlayerstate,
  readPacketEntitiesBegin,
  readPlayerStateDelta,
  readBatchMove,
  writeBatchMove,
  readUserinfoDelta,
  readClientSetting,
};

// Q2REPRO_CLASSIC_CODEC -- the SAME wire format as Q2REPRO_CODEC above, with
// one byte-level difference: svc_serverdata announces
// PROTOCOL_VERSION_RERELEASE_CLASSIC (4038) instead of 1038. Selected by the
// server when a CLASSIC-module session has escalated to the wide configstring
// layout (sv_init.ts's SV_WidenConfigstringSpace) and by the client when it
// reads that number back (cl_parse.ts's selectServerCodec). Every other
// function is shared by reference with Q2REPRO_CODEC -- there is deliberately
// no second implementation to keep in sync, because there is no second wire
// format: see PROTOCOL_VERSION_RERELEASE_CLASSIC's doc comment in qcommon.ts
// for why the number alone has to differ.
export const Q2REPRO_CLASSIC_CODEC: ProtocolCodec = {
  ...Q2REPRO_CODEC,
  name: "q2repro-classic",
  writeServerData: writeServerDataClassic,
};
