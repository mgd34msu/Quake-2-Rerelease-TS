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
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteChar, MSG_WriteLong, MSG_ReadByte, MSG_ReadShort, MSG_ReadChar, MSG_ReadLong } from "../sizebuf";
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

// mvd_ops_e (protocol.h ~line 205). Only the two values this port emits/reads
// are named; the rest of the family (mvd_multicast_all/mvd_unicast/
// mvd_configstring/mvd_print/mvd_stufftext/mvd_multicast_pvs/etc) live inside
// SV_Multicast/SV_Unicast/SV_Configstring/SV_BroadcastPrint's OWN prefix
// bytes on the real MVD stream; this port's simplified hook design (see
// sv_mvd.ts) does not reproduce that opcode family -- see sv_mvd.ts's header
// comment for the exact scoping of what SV_MvdMulticast/Unicast/Configstring/
// BroadcastPrint do instead.
export const mvd_serverdata = 0;
export const mvd_frame = 2;

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
