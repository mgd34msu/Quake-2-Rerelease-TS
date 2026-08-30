// MVD/GTV wire-format constants and the MVD-specific "packet players" delta
// codec.
//
// SOURCES (GPLv2, q2repro):
//   inc/common/protocol.h        -- MVD_MAGIC, PROTOCOL_VERSION_MVD*,
//                                    mvd_serverdata/mvd_frame op values,
//                                    MVF_* flags, PPS_* flags
//   inc/server/mvd/protocol.h    -- GTV_PROTOCOL_VERSION, GTF_*, gtv_serverop_t
//                                    (GTS_*), gtv_clientop_t (GTC_*),
//                                    MAX_GTS_MSGLEN/MAX_GTC_MSGLEN
//   src/common/msg.c:1482-1682   -- MSG_WriteDeltaPlayerstate_Packet (the
//                                    CLIENTNUM-prefixed multi-player delta
//                                    used only by the MVD stream)
//
// SCOPE (legacy family only -- see this file's "KEX GAP" note below): this
// module ports the non-extended, non-rerelease branch of
// MSG_WriteDeltaPlayerstate_Packet/MSG_ReadDeltaPlayerstate_Packet only
// (`flags` is always treated as 0: MSG_PS_EXTENSIONS/MSG_PS_RERELEASE/
// MSG_PS_EXTENSIONS_2 never set). This matches PROTOCOL_VERSION_MVD_DEFAULT
// (2010), the wire format q2pro/q2repro use for MVD demos recorded against a
// classic (non-kex) game DLL -- which is the only family this engine's own
// server can run today (src/server/sv_game.ts's `currentGameFamily()` still
// gates svs.codec between VANILLA_CODEC and Q2REPRO_CODEC only for the LIVE
// per-client protocol; nothing in this port negotiates the separate
// PROTOCOL_VERSION_MVD_RERELEASE=3038 MVD sub-protocol msg.c's rerelease
// branch would require -- `MSG_PS_RERELEASE` writes viewoffset/kick_angles/
// gunoffset/gunangles as scaled shorts instead of chars, adds `gunrate`, and
// widens stats to MAX_STATS_NEW=64 with a different bit-length encoding).
//
// KEX GAP (documented per PORTING.md/.orch/preferences.md rule 17 and the
// task brief's "otherwise legacy-family MVD first with the kex gap
// documented"): recording while `currentGameFamily() === "kex"` is refused
// by sv_mvd.ts's SV_MvdRecord_f with an explicit error rather than emitting
// bytes that claim rerelease compatibility. Porting the rerelease branch is
// real, scoped follow-up work (a second `flags`-aware code path through
// every function below), not attempted here.
//
// ENTITY DELTA REUSE (no separate "packed" entity format is ported here):
// msg.c's MSG_PackEntity/MSG_WriteDeltaEntity(entity_packed_t) operate on a
// pre-quantized copy of entity_state_t whose only real quantization step
// (beyond what MSG_WriteCoord/MSG_WriteAngle already do at write time) is
// angle packing -- origin is `VectorCopy`'d verbatim, never pre-rounded. Our
// engine's own VANILLA_CODEC.writeDeltaEntity (qcommon/protocol/vanilla.ts)
// already operates directly on EntityStateT with the identical U_* bit
// scheme (protocol 34's subset: no U_MOREFX/U_ALPHA/U_SCALE/U_MODEL16,
// which MSG_ES_EXTENSIONS-gated code never sets on the legacy path either)
// and does not need a redundant pre-pack step, so sv_mvd.ts calls
// VANILLA_CODEC's entity ops directly instead of duplicating them here. This
// is the one deliberate reuse-not-reimplement decision in the MVD unit;
// MSG_ES_FIRSTPERSON's bandwidth-only optimization (suppressing origin/angle
// bits for a player's own first-person entity, since the observer can
// recover them from the playerstate instead) is not reproduced -- entities
// simply carry a few more delta bytes than the original when this applies,
// which is a byte-count difference, not an observable state difference.

import type { SizeBuf } from "../sizebuf";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteChar, MSG_WriteLong, MSG_WriteLong64, MSG_ReadByte, MSG_ReadShort, MSG_ReadChar, MSG_ReadLong, MSG_ReadLong64 } from "../sizebuf";
import { ANGLE2SHORT, SHORT2ANGLE, PlayerStateT } from "../../shared/q_shared";

// ---------------------------------------------------------------------------
// inc/common/protocol.h
// ---------------------------------------------------------------------------

// MakeRawLong('M','V','D','2') = 'M' | ('V'<<8) | ('D'<<16) | ('2'<<24):
// 'M'=0x4d,'V'=0x56,'D'=0x44,'2'=0x32 -> 0x3244564d. Read back with
// DataView.getUint32(offset, true) (little-endian), this decodes byte-for-
// byte as ASCII "MVD2".
export const MVD_MAGIC = 0x3244564d >>> 0;

export const PROTOCOL_VERSION_MVD = 37;
export const PROTOCOL_VERSION_MVD_MINIMUM = 2009;
export const PROTOCOL_VERSION_MVD_DEFAULT = 2010;
export const PROTOCOL_VERSION_MVD_EXTENDED_LIMITS = 2011;
export const PROTOCOL_VERSION_MVD_EXTENDED_LIMITS_2 = 2012;
export const PROTOCOL_VERSION_MVD_CURRENT = 2013;
export const PROTOCOL_VERSION_MVD_RERELEASE = 3038;

export const SVCMD_BITS = 5;
export const SVCMD_MASK = (1 << SVCMD_BITS) - 1;

// mvd_ops_e (protocol.h ~line 199-224), full family now that
// SV_MvdMulticast/SV_MvdUnicast/SV_MvdStartSound are ported (sv_mvd.ts) and
// MVD_ParseMessage (server/mvd/parse.ts) dispatches on every op a recording
// can contain, not just the two this unit originally emitted.
export const mvd_bad = 0;
export const mvd_nop = 1;
export const mvd_disconnect = 2; // reserved -- never emitted by this port
export const mvd_reconnect = 3; // reserved -- never emitted by this port
export const mvd_serverdata = 4;
export const mvd_configstring = 5; // reserved -- SV_MvdConfigstring is not wired (not in this unit's scope; see sv_mvd.ts's header)
export const mvd_frame = 6;
export const mvd_frame_nodelta = 7; // reserved -- never emitted by this port
export const mvd_unicast = 8;
export const mvd_unicast_r = 9;
// must match MulticastT's ALL/PHS/PVS order (shared/q_shared.ts)
export const mvd_multicast_all = 10;
export const mvd_multicast_phs = 11;
export const mvd_multicast_pvs = 12;
export const mvd_multicast_all_r = 13;
export const mvd_multicast_phs_r = 14;
export const mvd_multicast_pvs_r = 15;
export const mvd_sound = 16;
export const mvd_print = 17;
export const mvd_stufftext = 18; // reserved -- never emitted by this port

// Command-byte + extrabits packing for ops that carry a small side-channel
// of flag/length bits (mvd_sound's CHAN_NO_PHS_ADD/CHAN_RELIABLE bits,
// mvd_multicast_*'s payload-length overflow bits for payloads >255 bytes).
//
// DEVIATION FROM THE LITERAL C BYTES (documented, not a faithfulness gap):
// mvd.c's SV_MvdMulticast writes `op | (bits ? 128 : 0)` plus a CONDITIONAL
// extra byte carrying the raw 0-7 "bits" value (mvd.c:1136-1139), but
// MVD_ParseMessage's generic dispatch loop only ever computes
// `extrabits = cmd >> SVCMD_BITS` from the SAME byte (parse.c:1093-1094) --
// for that bit-7-flag layout this always yields exactly 0 or 4, never the
// real 0-7 value, and the conditional extra byte is never consumed by the
// dispatcher at all. mvd_sound's write (`mvd_sound | extrabits`, mvd.c:1285)
// has the opposite problem: it ORs a 0-3 value into bits 0-1 of the SAME
// byte, which collides with mvd_print(17)/mvd_stufftext(18)'s own op values
// (mvd_sound=16, 16|1=17=mvd_print, 16|2=18=mvd_stufftext). Both read as
// latent bugs in this exact q2repro snapshot, not a wire format this unit
// needs to reproduce byte-for-byte -- this MVD unit has never claimed real
// .mvd2/GTV tool interop (see this file's KEX GAP note and sv_mvd.ts's
// header). This port instead packs extrabits into bits 5-7 UNIFORMLY
// (`op | (extrabits << SVCMD_BITS)`), matching mvd_serverdata's own
// genuinely self-consistent convention (mvd.c:624, `mvd_serverdata | (flags
// << SVCMD_BITS)`) and exactly what the generic dispatcher's
// `cmd >> SVCMD_BITS` extraction correctly recovers, with room for 3 bits
// (0-7) of extrabits alongside the 5-bit (0-31) op space -- an exact 8-bit
// fit, and enough range for multicast payloads up to 2047 bytes.
export function MSG_WriteMvdCmd(msg: SizeBuf, op: number, extrabits: number): void {
  MSG_WriteByte(msg, (op | (extrabits << SVCMD_BITS)) & 0xff);
}

export interface MvdCmdT {
  op: number;
  extrabits: number;
}

export function MSG_ReadMvdCmd(msg: SizeBuf): MvdCmdT {
  const byte = MSG_ReadByte(msg);
  return { op: byte & SVCMD_MASK, extrabits: (byte & 0xff) >>> SVCMD_BITS };
}

export const MVF_NOMSGS = 1 << 0;
export const MVF_EXTLIMITS = 1 << 2;
export const MVF_EXTLIMITS_2 = 1 << 3;

export const CLIENTNUM_NONE = 255; // MAX_CLIENTS(256) - 1

// PPS_* -- player_packed_t delta flags (msg.c's "packet players" format).
// Distinct bit layout from PS_* (qcommon.ts), which is the per-client
// svc_playerinfo format used by the live protocol.
export const PPS_M_TYPE = 1 << 0;
export const PPS_M_ORIGIN = 1 << 1;
export const PPS_M_ORIGIN2 = 1 << 2;
export const PPS_VIEWOFFSET = 1 << 3;
export const PPS_VIEWANGLES = 1 << 4;
export const PPS_VIEWANGLE2 = 1 << 5;
export const PPS_KICKANGLES = 1 << 6;
export const PPS_BLEND = 1 << 7;
export const PPS_FOV = 1 << 8;
export const PPS_WEAPONINDEX = 1 << 9;
export const PPS_WEAPONFRAME = 1 << 10;
export const PPS_GUNOFFSET = 1 << 11;
export const PPS_GUNANGLES = 1 << 12;
export const PPS_RDFLAGS = 1 << 13;
export const PPS_STATS = 1 << 14;
export const PPS_MOREBITS = 1 << 15; // read one additional byte; also the "remove" marker word

// ---------------------------------------------------------------------------
// inc/server/mvd/protocol.h (GTV)
// ---------------------------------------------------------------------------

export const GTV_PROTOCOL_VERSION = 0xed04;

export const MAX_GTC_MSGLEN = 256;

export const GTF_DEFLATE = 1; // not implemented by this port -- see sv_mvd.ts
export const GTF_STRINGCMDS = 2;

export enum GtvServerOpT {
  GTS_HELLO,
  GTS_PONG,
  GTS_STREAM_START,
  GTS_STREAM_STOP,
  GTS_STREAM_DATA,
  GTS_ERROR,
  GTS_BADREQUEST,
  GTS_NOACCESS,
  GTS_DISCONNECT,
  GTS_RECONNECT,
}

export enum GtvClientOpT {
  GTC_HELLO,
  GTC_PING,
  GTC_STREAM_START,
  GTC_STREAM_STOP,
  GTC_STRINGCMD,
}

// ---------------------------------------------------------------------------
// MSG_WriteDeltaPlayerstate_Packet / MSG_ReadDeltaPlayerstate_Packet
// (legacy/non-extended/non-rerelease branch only -- see file header)
// ---------------------------------------------------------------------------

export const MAX_STATS_OLD = 32;

// msg.c:1491: `if (number < 0 || number >= CLIENTNUM_NONE)`.
export function MSG_ValidMvdClientNumber(number: number): boolean {
  return number >= 0 && number < CLIENTNUM_NONE;
}

// Writes the CLIENTNUM_NONE terminator used at the end of a packetplayers
// section (emit_gamestate/emit_frame's `MSG_WriteByte(CLIENTNUM_NONE)`).
export function MSG_WriteMvdPlayersEnd(msg: SizeBuf): void {
  MSG_WriteByte(msg, CLIENTNUM_NONE);
}

// `to === null` is the msg.c `!to` remove branch: writes just
// `number, PPS_MOREBITS` (the "MOREBITS == REMOVE for old demos" marker).
// This port drops the old-format-compat extra byte
// (`if (flags & MSG_PS_MOREBITS) MSG_WriteByte(PPS_REMOVE >> 16)`) -- that
// byte only exists to keep pre-2010-protocol MVD *readers* working, which
// this engine's own MVD_ParseMessage (src/server/mvd/parse.ts) never needs
// to be, since it always reads its own writer's output.
export function MSG_WriteDeltaMvdPlayerstate(msg: SizeBuf, from: PlayerStateT | null, to: PlayerStateT | null, number: number, force: boolean): void {
  if (!MSG_ValidMvdClientNumber(number)) {
    throw new Error(`MSG_WriteDeltaMvdPlayerstate: bad number: ${number}`);
  }

  if (!to) {
    MSG_WriteByte(msg, number);
    MSG_WriteShort(msg, PPS_MOREBITS);
    return;
  }

  const f = from ?? new PlayerStateT();

  let pflags = 0;

  if (to.pmove.pm_type !== f.pmove.pm_type) pflags |= PPS_M_TYPE;

  if (to.pmove.origin[0] !== f.pmove.origin[0] || to.pmove.origin[1] !== f.pmove.origin[1]) pflags |= PPS_M_ORIGIN;
  if (to.pmove.origin[2] !== f.pmove.origin[2]) pflags |= PPS_M_ORIGIN2;

  if (to.viewoffset[0] !== f.viewoffset[0] || to.viewoffset[1] !== f.viewoffset[1] || to.viewoffset[2] !== f.viewoffset[2]) pflags |= PPS_VIEWOFFSET;

  // viewangles are delta-compared post-quantization (ANGLE2SHORT), matching
  // msg.c's player_packed_t.viewangles (pre-packed via MSG_PackPlayer before
  // any delta compare ever runs) -- avoids spurious deltas from float jitter
  // that quantizes to the same wire short.
  const toYaw0 = ANGLE2SHORT(to.viewangles[0]);
  const toYaw1 = ANGLE2SHORT(to.viewangles[1]);
  const toYaw2 = ANGLE2SHORT(to.viewangles[2]);
  const fromYaw0 = ANGLE2SHORT(f.viewangles[0]);
  const fromYaw1 = ANGLE2SHORT(f.viewangles[1]);
  const fromYaw2 = ANGLE2SHORT(f.viewangles[2]);
  if (toYaw0 !== fromYaw0 || toYaw1 !== fromYaw1) pflags |= PPS_VIEWANGLES;
  if (toYaw2 !== fromYaw2) pflags |= PPS_VIEWANGLE2;

  if (to.kick_angles[0] !== f.kick_angles[0] || to.kick_angles[1] !== f.kick_angles[1] || to.kick_angles[2] !== f.kick_angles[2]) pflags |= PPS_KICKANGLES;

  if (to.blend[0] !== f.blend[0] || to.blend[1] !== f.blend[1] || to.blend[2] !== f.blend[2] || to.blend[3] !== f.blend[3]) pflags |= PPS_BLEND;

  if (to.fov !== f.fov) pflags |= PPS_FOV;
  if (to.rdflags !== f.rdflags) pflags |= PPS_RDFLAGS;

  if (to.gunindex !== f.gunindex) pflags |= PPS_WEAPONINDEX;
  if (to.gunframe !== f.gunframe) pflags |= PPS_WEAPONFRAME;
  if (to.gunoffset[0] !== f.gunoffset[0] || to.gunoffset[1] !== f.gunoffset[1] || to.gunoffset[2] !== f.gunoffset[2]) pflags |= PPS_GUNOFFSET;
  if (to.gunangles[0] !== f.gunangles[0] || to.gunangles[1] !== f.gunangles[1] || to.gunangles[2] !== f.gunangles[2]) pflags |= PPS_GUNANGLES;

  let statbits = 0;
  for (let i = 0; i < MAX_STATS_OLD; i++) {
    if (to.stats[i] !== f.stats[i]) statbits |= 1 << i;
  }
  if (statbits) pflags |= PPS_STATS;

  if (!pflags && !force) return;

  MSG_WriteByte(msg, number);
  MSG_WriteShort(msg, pflags & 0xffff);

  if (pflags & PPS_M_TYPE) MSG_WriteByte(msg, to.pmove.pm_type);

  if (pflags & PPS_M_ORIGIN) {
    MSG_WriteShort(msg, to.pmove.origin[0]);
    MSG_WriteShort(msg, to.pmove.origin[1]);
  }
  if (pflags & PPS_M_ORIGIN2) MSG_WriteShort(msg, to.pmove.origin[2]);

  if (pflags & PPS_VIEWOFFSET) {
    MSG_WriteChar(msg, Math.trunc(to.viewoffset[0] * 4));
    MSG_WriteChar(msg, Math.trunc(to.viewoffset[1] * 4));
    MSG_WriteChar(msg, Math.trunc(to.viewoffset[2] * 4));
  }

  if (pflags & PPS_VIEWANGLES) {
    MSG_WriteShort(msg, toYaw0);
    MSG_WriteShort(msg, toYaw1);
  }
  if (pflags & PPS_VIEWANGLE2) MSG_WriteShort(msg, toYaw2);

  if (pflags & PPS_KICKANGLES) {
    MSG_WriteChar(msg, Math.trunc(to.kick_angles[0] * 4));
    MSG_WriteChar(msg, Math.trunc(to.kick_angles[1] * 4));
    MSG_WriteChar(msg, Math.trunc(to.kick_angles[2] * 4));
  }

  if (pflags & PPS_WEAPONINDEX) MSG_WriteByte(msg, to.gunindex);
  if (pflags & PPS_WEAPONFRAME) MSG_WriteByte(msg, to.gunframe);

  if (pflags & PPS_GUNOFFSET) {
    MSG_WriteChar(msg, Math.trunc(to.gunoffset[0] * 4));
    MSG_WriteChar(msg, Math.trunc(to.gunoffset[1] * 4));
    MSG_WriteChar(msg, Math.trunc(to.gunoffset[2] * 4));
  }
  if (pflags & PPS_GUNANGLES) {
    MSG_WriteChar(msg, Math.trunc(to.gunangles[0] * 4));
    MSG_WriteChar(msg, Math.trunc(to.gunangles[1] * 4));
    MSG_WriteChar(msg, Math.trunc(to.gunangles[2] * 4));
  }

  if (pflags & PPS_BLEND) {
    MSG_WriteByte(msg, Math.trunc(to.blend[0] * 255));
    MSG_WriteByte(msg, Math.trunc(to.blend[1] * 255));
    MSG_WriteByte(msg, Math.trunc(to.blend[2] * 255));
    MSG_WriteByte(msg, Math.trunc(to.blend[3] * 255));
  }

  if (pflags & PPS_FOV) MSG_WriteByte(msg, to.fov);
  if (pflags & PPS_RDFLAGS) MSG_WriteByte(msg, to.rdflags);

  if (pflags & PPS_STATS) {
    MSG_WriteLong(msg, statbits);
    for (let i = 0; i < MAX_STATS_OLD; i++) {
      if (statbits & (1 << i)) MSG_WriteShort(msg, to.stats[i]);
    }
  }
}

// Result of reading one packetplayers entry: `removed: true` means this
// client slot is no longer active (the `to === null` write branch);
// otherwise `ps` holds the fully-updated (copy-then-overwrite-delta)
// PlayerStateT, matching CL_ParsePlayerstate's copy-then-overwrite model.
export interface MvdPlayerReadResultT {
  number: number;
  removed: boolean;
  ps: PlayerStateT;
}

export function MSG_ReadDeltaMvdPlayerstate(msg: SizeBuf, from: PlayerStateT | null): MvdPlayerReadResultT {
  const number = MSG_ReadByte(msg);
  return MSG_ReadDeltaMvdPlayerstateBody(msg, from, number);
}

// Split out for callers (server/mvd/parse.ts's readPlayersSection) that must
// read `number` themselves first to test for the CLIENTNUM_NONE terminator
// before deciding whether a playerstate record follows at all.
export function MSG_ReadDeltaMvdPlayerstateBody(msg: SizeBuf, from: PlayerStateT | null, number: number): MvdPlayerReadResultT {
  const pflags = MSG_ReadShort(msg) & 0xffff;

  const ps = new PlayerStateT();
  if (from) {
    ps.pmove.pm_type = from.pmove.pm_type;
    ps.pmove.origin.set(from.pmove.origin);
    ps.viewoffset.set(from.viewoffset);
    ps.viewangles.set(from.viewangles);
    ps.kick_angles.set(from.kick_angles);
    ps.gunangles.set(from.gunangles);
    ps.gunoffset.set(from.gunoffset);
    ps.gunindex = from.gunindex;
    ps.gunframe = from.gunframe;
    ps.blend.set(from.blend);
    ps.fov = from.fov;
    ps.rdflags = from.rdflags;
    ps.stats.set(from.stats);
  }

  if (pflags === PPS_MOREBITS) {
    // remove marker (see MSG_WriteDeltaMvdPlayerstate's `to === null` branch)
    return { number, removed: true, ps };
  }

  if (pflags & PPS_M_TYPE) ps.pmove.pm_type = MSG_ReadByte(msg);

  if (pflags & PPS_M_ORIGIN) {
    ps.pmove.origin[0] = MSG_ReadShort(msg);
    ps.pmove.origin[1] = MSG_ReadShort(msg);
  }
  if (pflags & PPS_M_ORIGIN2) ps.pmove.origin[2] = MSG_ReadShort(msg);

  if (pflags & PPS_VIEWOFFSET) {
    ps.viewoffset[0] = MSG_ReadChar(msg) * 0.25;
    ps.viewoffset[1] = MSG_ReadChar(msg) * 0.25;
    ps.viewoffset[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (pflags & PPS_VIEWANGLES) {
    ps.viewangles[0] = SHORT2ANGLE(MSG_ReadShort(msg));
    ps.viewangles[1] = SHORT2ANGLE(MSG_ReadShort(msg));
  }
  if (pflags & PPS_VIEWANGLE2) ps.viewangles[2] = SHORT2ANGLE(MSG_ReadShort(msg));

  if (pflags & PPS_KICKANGLES) {
    ps.kick_angles[0] = MSG_ReadChar(msg) * 0.25;
    ps.kick_angles[1] = MSG_ReadChar(msg) * 0.25;
    ps.kick_angles[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (pflags & PPS_WEAPONINDEX) ps.gunindex = MSG_ReadByte(msg);
  if (pflags & PPS_WEAPONFRAME) ps.gunframe = MSG_ReadByte(msg);

  if (pflags & PPS_GUNOFFSET) {
    ps.gunoffset[0] = MSG_ReadChar(msg) * 0.25;
    ps.gunoffset[1] = MSG_ReadChar(msg) * 0.25;
    ps.gunoffset[2] = MSG_ReadChar(msg) * 0.25;
  }
  if (pflags & PPS_GUNANGLES) {
    ps.gunangles[0] = MSG_ReadChar(msg) * 0.25;
    ps.gunangles[1] = MSG_ReadChar(msg) * 0.25;
    ps.gunangles[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (pflags & PPS_BLEND) {
    ps.blend[0] = MSG_ReadByte(msg) / 255;
    ps.blend[1] = MSG_ReadByte(msg) / 255;
    ps.blend[2] = MSG_ReadByte(msg) / 255;
    ps.blend[3] = MSG_ReadByte(msg) / 255;
  }

  if (pflags & PPS_FOV) ps.fov = MSG_ReadByte(msg);
  if (pflags & PPS_RDFLAGS) ps.rdflags = MSG_ReadByte(msg);

  if (pflags & PPS_STATS) {
    const statbits = MSG_ReadLong(msg) >>> 0;
    for (let i = 0; i < MAX_STATS_OLD; i++) {
      if (statbits & (1 << i)) ps.stats[i] = MSG_ReadShort(msg);
    }
  }

  return { number, removed: false, ps };
}

// ---------------------------------------------------------------------------
// MSG_WriteDeltaPlayerstate_Packet / MSG_ReadDeltaPlayerstate_Packet --
// MSG_PS_RERELEASE branch (PROTOCOL_VERSION_MVD_RERELEASE=3038)
//
// SOURCES (GPLv2, q2repro): src/common/msg.c:1482-1690
// (MSG_WriteDeltaPlayerstate_Packet's `flags & MSG_PS_RERELEASE`/
// `MSG_PS_EXTENSIONS` branches), :881-906 (MSG_PackPlayer's rerelease
// scaled_short scale factors and gunindex/gunskin packing), :918-985
// (MSG_CalcStatBits/MSG_WriteStats/MSG_WriteDeltaBlend).
//
// SCOPE: this ports exactly the fields the task brief calls out --
// viewoffset/kick_angles/gunoffset/gunangles as scaled shorts (vs. legacy's
// scaled chars), gunframe/gunindex as shorts (vs. bytes; gunindex also
// folds in gunskin, matching MSG_PackPlayer's
// `gunindex | gunskin << GUNINDEX_BITS`), damage_blend (delta-compared
// alongside screen_blend via MSG_WriteDeltaBlend's 8-bit bflags byte), and
// 64-entry stats with a 64-bit statbits mask (MSG_WriteLong64/MSG_ReadLong64
// -- msg.c's rerelease branch of MSG_WriteStats, not the varint
// EXTENSIONS_2-only branch, which this port does not otherwise implement
// either). `gunrate` itself is NOT part of MSG_WriteDeltaPlayerstate_Packet
// in the reference (grep-verified: msg.c:1482-1690 never touches
// `to->gunrate`; the byte-per-frame gunrate write at msg.c:1461 belongs to
// the live per-CLIENT protocol's own delta writer, a different function
// this MVD unit does not port) -- not emitted here either, matching the
// actual reference rather than the brief's summary of it.
//
// STATS TRUNCATION GAP: PlayerStateT.stats (shared/q_shared.ts) is still
// sized MAX_STATS=32, a pre-existing, already-tracked gap (bindings/kex.ts's
// "TODO(phase-2b): widen PlayerStateT.stats to 64" note) outside this file's
// allowed scope. This codec still declares the CORRECT 64-entry/64-bit wire
// shape (so a real rerelease MVD reader parses our output correctly), but
// stat indices 32-63 always read back as 0 until that widening lands --
// `ps.stats[i] ?? 0` below documents exactly where.
//
// ENTITY DELTA GAP: only the player-state codec is ported here. Entity
// deltas in a kex/rerelease recording still go through VANILLA_CODEC (the
// legacy U_* bit scheme), not the rerelease entity extensions
// (MSG_ES_LONGSOLID/SHORTANGLES/EXTENSIONS) -- the task brief's field list
// names player-state fields only; entity-side rerelease encoding is a
// separate, larger unit not attempted here (see sv_mvd.ts's emitGamestateInto
// callers for where this is wired).

export const MAX_STATS_NEW = 64;
export const GUNINDEX_BITS = 13; // shared.h:1837 -- upper 3 bits of a packed gunindex are gunskin

export const RERELEASE_VIEWOFFSET_SCALE = 16;
export const RERELEASE_KICKANGLES_SCALE = 1024;
export const RERELEASE_GUNOFFSET_SCALE = 512;
export const RERELEASE_GUNANGLES_SCALE = 4096;

function scaledShort(x: number, scale: number): number {
  return Math.max(-32768, Math.min(32767, Math.trunc(x * scale)));
}

function blendByte(x: number): number {
  return Math.max(0, Math.min(255, Math.trunc(x * 255)));
}

function packedGunIndex(ps: PlayerStateT): number {
  return (ps.gunindex & 0x1fff) | ((ps.gunskin & 0x7) << GUNINDEX_BITS);
}

// msg.c:961-985 (MSG_WriteDeltaBlend): an 8-bit bflags byte (low nibble =
// screen_blend channels changed, high nibble = damage_blend channels
// changed), then one byte per changed channel across both vectors.
function writeDeltaBlend(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  let bflags = 0;
  for (let i = 0; i < 4; i++) {
    if (blendByte(to.blend[i]) !== blendByte(from.blend[i])) bflags |= 1 << i;
    if (blendByte(to.damage_blend[i]) !== blendByte(from.damage_blend[i])) bflags |= 1 << (4 + i);
  }
  MSG_WriteByte(msg, bflags);
  for (let i = 0; i < 4; i++) {
    if (bflags & (1 << i)) MSG_WriteByte(msg, blendByte(to.blend[i]));
  }
  for (let i = 0; i < 4; i++) {
    if (bflags & (1 << (4 + i))) MSG_WriteByte(msg, blendByte(to.damage_blend[i]));
  }
}

function readDeltaBlend(msg: SizeBuf, ps: PlayerStateT): void {
  const bflags = MSG_ReadByte(msg);
  for (let i = 0; i < 4; i++) {
    if (bflags & (1 << i)) ps.blend[i] = MSG_ReadByte(msg) / 255;
  }
  for (let i = 0; i < 4; i++) {
    if (bflags & (1 << (4 + i))) ps.damage_blend[i] = MSG_ReadByte(msg) / 255;
  }
}

// blend comparison for the rerelease PPS_BLEND flag: differs if either
// screen_blend OR damage_blend changed (msg.c:1528-1533's
// `if (!Vector4Compare(screen_blend)) ...; else if (rerelease && damage_blend
// differs) ...`).
function blendChanged(from: PlayerStateT, to: PlayerStateT): boolean {
  for (let i = 0; i < 4; i++) {
    if (blendByte(to.blend[i]) !== blendByte(from.blend[i])) return true;
    if (blendByte(to.damage_blend[i]) !== blendByte(from.damage_blend[i])) return true;
  }
  return false;
}

export function MSG_WriteDeltaMvdPlayerstateRerelease(msg: SizeBuf, from: PlayerStateT | null, to: PlayerStateT | null, number: number, force: boolean): void {
  if (!MSG_ValidMvdClientNumber(number)) {
    throw new Error(`MSG_WriteDeltaMvdPlayerstateRerelease: bad number: ${number}`);
  }

  if (!to) {
    MSG_WriteByte(msg, number);
    MSG_WriteShort(msg, PPS_MOREBITS);
    return;
  }

  const f = from ?? new PlayerStateT();

  let pflags = 0;

  if (to.pmove.pm_type !== f.pmove.pm_type) pflags |= PPS_M_TYPE;

  if (to.pmove.origin[0] !== f.pmove.origin[0] || to.pmove.origin[1] !== f.pmove.origin[1]) pflags |= PPS_M_ORIGIN;
  if (to.pmove.origin[2] !== f.pmove.origin[2]) pflags |= PPS_M_ORIGIN2;

  const toViewoffset: [number, number, number] = [scaledShort(to.viewoffset[0], RERELEASE_VIEWOFFSET_SCALE), scaledShort(to.viewoffset[1], RERELEASE_VIEWOFFSET_SCALE), scaledShort(to.viewoffset[2], RERELEASE_VIEWOFFSET_SCALE)];
  const fromViewoffset: [number, number, number] = [scaledShort(f.viewoffset[0], RERELEASE_VIEWOFFSET_SCALE), scaledShort(f.viewoffset[1], RERELEASE_VIEWOFFSET_SCALE), scaledShort(f.viewoffset[2], RERELEASE_VIEWOFFSET_SCALE)];
  if (toViewoffset[0] !== fromViewoffset[0] || toViewoffset[1] !== fromViewoffset[1] || toViewoffset[2] !== fromViewoffset[2]) pflags |= PPS_VIEWOFFSET;

  const toYaw0 = ANGLE2SHORT(to.viewangles[0]);
  const toYaw1 = ANGLE2SHORT(to.viewangles[1]);
  const toYaw2 = ANGLE2SHORT(to.viewangles[2]);
  const fromYaw0 = ANGLE2SHORT(f.viewangles[0]);
  const fromYaw1 = ANGLE2SHORT(f.viewangles[1]);
  const fromYaw2 = ANGLE2SHORT(f.viewangles[2]);
  if (toYaw0 !== fromYaw0 || toYaw1 !== fromYaw1) pflags |= PPS_VIEWANGLES;
  if (toYaw2 !== fromYaw2) pflags |= PPS_VIEWANGLE2;

  const toKick: [number, number, number] = [scaledShort(to.kick_angles[0], RERELEASE_KICKANGLES_SCALE), scaledShort(to.kick_angles[1], RERELEASE_KICKANGLES_SCALE), scaledShort(to.kick_angles[2], RERELEASE_KICKANGLES_SCALE)];
  const fromKick: [number, number, number] = [scaledShort(f.kick_angles[0], RERELEASE_KICKANGLES_SCALE), scaledShort(f.kick_angles[1], RERELEASE_KICKANGLES_SCALE), scaledShort(f.kick_angles[2], RERELEASE_KICKANGLES_SCALE)];
  if (toKick[0] !== fromKick[0] || toKick[1] !== fromKick[1] || toKick[2] !== fromKick[2]) pflags |= PPS_KICKANGLES;

  if (blendChanged(f, to)) pflags |= PPS_BLEND;

  if (to.fov !== f.fov) pflags |= PPS_FOV;
  if (to.rdflags !== f.rdflags) pflags |= PPS_RDFLAGS;

  const toGunIndex = packedGunIndex(to);
  const fromGunIndex = packedGunIndex(f);
  if (toGunIndex !== fromGunIndex) pflags |= PPS_WEAPONINDEX;
  if (to.gunframe !== f.gunframe) pflags |= PPS_WEAPONFRAME;

  const toGunoffset: [number, number, number] = [scaledShort(to.gunoffset[0], RERELEASE_GUNOFFSET_SCALE), scaledShort(to.gunoffset[1], RERELEASE_GUNOFFSET_SCALE), scaledShort(to.gunoffset[2], RERELEASE_GUNOFFSET_SCALE)];
  const fromGunoffset: [number, number, number] = [scaledShort(f.gunoffset[0], RERELEASE_GUNOFFSET_SCALE), scaledShort(f.gunoffset[1], RERELEASE_GUNOFFSET_SCALE), scaledShort(f.gunoffset[2], RERELEASE_GUNOFFSET_SCALE)];
  if (toGunoffset[0] !== fromGunoffset[0] || toGunoffset[1] !== fromGunoffset[1] || toGunoffset[2] !== fromGunoffset[2]) pflags |= PPS_GUNOFFSET;

  const toGunangles: [number, number, number] = [scaledShort(to.gunangles[0], RERELEASE_GUNANGLES_SCALE), scaledShort(to.gunangles[1], RERELEASE_GUNANGLES_SCALE), scaledShort(to.gunangles[2], RERELEASE_GUNANGLES_SCALE)];
  const fromGunangles: [number, number, number] = [scaledShort(f.gunangles[0], RERELEASE_GUNANGLES_SCALE), scaledShort(f.gunangles[1], RERELEASE_GUNANGLES_SCALE), scaledShort(f.gunangles[2], RERELEASE_GUNANGLES_SCALE)];
  if (toGunangles[0] !== fromGunangles[0] || toGunangles[1] !== fromGunangles[1] || toGunangles[2] !== fromGunangles[2]) pflags |= PPS_GUNANGLES;

  let statbits = 0n;
  for (let i = 0; i < MAX_STATS_NEW; i++) {
    const toStat = to.stats[i] ?? 0;
    const fromStat = f.stats[i] ?? 0;
    if (toStat !== fromStat) statbits |= 1n << BigInt(i);
  }
  if (statbits !== 0n) pflags |= PPS_STATS;

  if (!pflags && !force) return;

  MSG_WriteByte(msg, number);
  MSG_WriteShort(msg, pflags & 0xffff);

  if (pflags & PPS_M_TYPE) MSG_WriteByte(msg, to.pmove.pm_type);

  if (pflags & PPS_M_ORIGIN) {
    MSG_WriteShort(msg, to.pmove.origin[0]);
    MSG_WriteShort(msg, to.pmove.origin[1]);
  }
  if (pflags & PPS_M_ORIGIN2) MSG_WriteShort(msg, to.pmove.origin[2]);

  if (pflags & PPS_VIEWOFFSET) {
    MSG_WriteShort(msg, toViewoffset[0]);
    MSG_WriteShort(msg, toViewoffset[1]);
    MSG_WriteShort(msg, toViewoffset[2]);
  }

  if (pflags & PPS_VIEWANGLES) {
    MSG_WriteShort(msg, toYaw0);
    MSG_WriteShort(msg, toYaw1);
  }
  if (pflags & PPS_VIEWANGLE2) MSG_WriteShort(msg, toYaw2);

  if (pflags & PPS_KICKANGLES) {
    MSG_WriteShort(msg, toKick[0]);
    MSG_WriteShort(msg, toKick[1]);
    MSG_WriteShort(msg, toKick[2]);
  }

  if (pflags & PPS_WEAPONINDEX) MSG_WriteShort(msg, toGunIndex);
  if (pflags & PPS_WEAPONFRAME) MSG_WriteShort(msg, to.gunframe);

  if (pflags & PPS_GUNOFFSET) {
    MSG_WriteShort(msg, toGunoffset[0]);
    MSG_WriteShort(msg, toGunoffset[1]);
    MSG_WriteShort(msg, toGunoffset[2]);
  }
  if (pflags & PPS_GUNANGLES) {
    MSG_WriteShort(msg, toGunangles[0]);
    MSG_WriteShort(msg, toGunangles[1]);
    MSG_WriteShort(msg, toGunangles[2]);
  }

  if (pflags & PPS_BLEND) writeDeltaBlend(msg, f, to);

  if (pflags & PPS_FOV) MSG_WriteByte(msg, to.fov);
  if (pflags & PPS_RDFLAGS) MSG_WriteByte(msg, to.rdflags);

  if (pflags & PPS_STATS) {
    MSG_WriteLong64(msg, statbits);
    for (let i = 0; i < MAX_STATS_NEW; i++) {
      if (statbits & (1n << BigInt(i))) MSG_WriteShort(msg, to.stats[i] ?? 0);
    }
  }
}

export function MSG_ReadDeltaMvdPlayerstateRerelease(msg: SizeBuf, from: PlayerStateT | null): MvdPlayerReadResultT {
  const number = MSG_ReadByte(msg);
  return MSG_ReadDeltaMvdPlayerstateRereleaseBody(msg, from, number);
}

export function MSG_ReadDeltaMvdPlayerstateRereleaseBody(msg: SizeBuf, from: PlayerStateT | null, number: number): MvdPlayerReadResultT {
  const pflags = MSG_ReadShort(msg) & 0xffff;

  const ps = new PlayerStateT();
  if (from) {
    ps.pmove.pm_type = from.pmove.pm_type;
    ps.pmove.origin.set(from.pmove.origin);
    ps.viewoffset.set(from.viewoffset);
    ps.viewangles.set(from.viewangles);
    ps.kick_angles.set(from.kick_angles);
    ps.gunangles.set(from.gunangles);
    ps.gunoffset.set(from.gunoffset);
    ps.gunindex = from.gunindex;
    ps.gunskin = from.gunskin;
    ps.gunframe = from.gunframe;
    ps.blend.set(from.blend);
    ps.damage_blend.set(from.damage_blend);
    ps.fov = from.fov;
    ps.rdflags = from.rdflags;
    ps.stats.set(from.stats);
  }

  if (pflags === PPS_MOREBITS) {
    return { number, removed: true, ps };
  }

  if (pflags & PPS_M_TYPE) ps.pmove.pm_type = MSG_ReadByte(msg);

  if (pflags & PPS_M_ORIGIN) {
    ps.pmove.origin[0] = MSG_ReadShort(msg);
    ps.pmove.origin[1] = MSG_ReadShort(msg);
  }
  if (pflags & PPS_M_ORIGIN2) ps.pmove.origin[2] = MSG_ReadShort(msg);

  if (pflags & PPS_VIEWOFFSET) {
    ps.viewoffset[0] = MSG_ReadShort(msg) / RERELEASE_VIEWOFFSET_SCALE;
    ps.viewoffset[1] = MSG_ReadShort(msg) / RERELEASE_VIEWOFFSET_SCALE;
    ps.viewoffset[2] = MSG_ReadShort(msg) / RERELEASE_VIEWOFFSET_SCALE;
  }

  if (pflags & PPS_VIEWANGLES) {
    ps.viewangles[0] = SHORT2ANGLE(MSG_ReadShort(msg));
    ps.viewangles[1] = SHORT2ANGLE(MSG_ReadShort(msg));
  }
  if (pflags & PPS_VIEWANGLE2) ps.viewangles[2] = SHORT2ANGLE(MSG_ReadShort(msg));

  if (pflags & PPS_KICKANGLES) {
    ps.kick_angles[0] = MSG_ReadShort(msg) / RERELEASE_KICKANGLES_SCALE;
    ps.kick_angles[1] = MSG_ReadShort(msg) / RERELEASE_KICKANGLES_SCALE;
    ps.kick_angles[2] = MSG_ReadShort(msg) / RERELEASE_KICKANGLES_SCALE;
  }

  if (pflags & PPS_WEAPONINDEX) {
    const packed = MSG_ReadShort(msg) & 0xffff;
    ps.gunindex = packed & 0x1fff;
    ps.gunskin = (packed >>> GUNINDEX_BITS) & 0x7;
  }
  if (pflags & PPS_WEAPONFRAME) ps.gunframe = MSG_ReadShort(msg);

  if (pflags & PPS_GUNOFFSET) {
    ps.gunoffset[0] = MSG_ReadShort(msg) / RERELEASE_GUNOFFSET_SCALE;
    ps.gunoffset[1] = MSG_ReadShort(msg) / RERELEASE_GUNOFFSET_SCALE;
    ps.gunoffset[2] = MSG_ReadShort(msg) / RERELEASE_GUNOFFSET_SCALE;
  }
  if (pflags & PPS_GUNANGLES) {
    ps.gunangles[0] = MSG_ReadShort(msg) / RERELEASE_GUNANGLES_SCALE;
    ps.gunangles[1] = MSG_ReadShort(msg) / RERELEASE_GUNANGLES_SCALE;
    ps.gunangles[2] = MSG_ReadShort(msg) / RERELEASE_GUNANGLES_SCALE;
  }

  if (pflags & PPS_BLEND) readDeltaBlend(msg, ps);

  if (pflags & PPS_FOV) ps.fov = MSG_ReadByte(msg);
  if (pflags & PPS_RDFLAGS) ps.rdflags = MSG_ReadByte(msg);

  if (pflags & PPS_STATS) {
    const statbits = MSG_ReadLong64(msg);
    for (let i = 0; i < MAX_STATS_NEW; i++) {
      if (statbits & (1n << BigInt(i))) {
        const value = MSG_ReadShort(msg);
        if (i < ps.stats.length) ps.stats[i] = value;
      }
    }
  }

  return { number, removed: false, ps };
}
