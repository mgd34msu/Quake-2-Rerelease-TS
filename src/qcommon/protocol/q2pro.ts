// Protocol 36 ("Q2PRO") codec -- v1.0.0 wire cluster (task board #23), Mike's
// ruling: our server accepts classic community clients and our client joins
// classic community servers. Ported from q2proto's reference implementation
// (~/Projects/q2proto/src/q2proto_proto_q2pro.c).
//
// SCOPE CUT (deliberate, already ruled on -- do not relitigate): this codec
// implements Q2PRO's "plain" wire tier only, i.e. the tier a client gets when
// the server advertises NO extensions (q2proto's game_api ==
// Q2PROTO_GAME_VANILLA). NOT implemented: U_ANGLE16/U_MODEL16/U_MOREFX8/
// U_MOREFX16/U_ALPHA/U_SCALE entity-delta extensions, EPS_CLIENTNUM/
// PS_MOREBITS/PS_Q2PRO_PLAYERFOG playerstate extensions, the 23-bit packed
// (q2pro_i23) coordinate encoding, svc_q2pro_gamestate/configstringstream/
// baselinestream bulk-transfer opcodes, and the q2pro_flags word (only exists
// at PROTOCOL_VERSION_Q2PRO_EXTENDED_LIMITS=1024 and above -- negotiated
// minor versions are clamped below that ceiling, see qcommon.ts's
// PROTOCOL_VERSION_Q2PRO_CURRENT doc comment). A real Q2PRO client is
// designed to fall back to this exact plain format when the server's
// serverdata announces no extensions -- that is the entire mechanism this
// port relies on for correctness within its scope.
//
// UPDATE (phase-8 q2repro interop unit): clc_q2pro_move_batched/move_nodelta/
// userinfo_delta, listed above as NOT implemented, now ARE -- see this file's
// readBatchMove/decodeQ2ProBatchCmd/readUserinfoDelta below and
// clc_batch_move.ts's file header. This was the confirmed live-interop
// blocker (a real q2repro client sends batched move for ALL movement under
// this protocol too, not just 1038 -- .orch/followups.md's phase-8 ledger).
//
// Within the plain tier, verified directly against q2proto_proto_q2pro.c:
//   - U_SOLID is ALWAYS a u32 (q2pro.c:133 `context->features.has_solid32 =
//     true;`, unconditional -- no minor-version gate, unlike R1Q2's
//     PROTOCOL_VERSION_R1Q2_LONG_SOLID). Confirmed at both the entity-delta
//     read (q2pro.c:555-556) and write (q2pro.c:1776-1777) sites.
//   - clc_move's move-delta encoding (q2pro_client_write_move_delta,
//     q2pro.c:1061-1108) is BYTE-IDENTICAL to vanilla's
//     MSG_WriteDeltaUsercmd/MSG_ReadDeltaUsercmd -- no DBLFORWARD/DBL_ANGLE1
//     byte-shortening (that is an R1Q2-only optimization, confirmed absent
//     here: q2pro.c's move-delta write function has no such branch, unlike
//     r1q2.c's clc_move path).
//   - The player_state_t "extraflags" mechanism (EPS_GUNOFFSET/EPS_GUNANGLES/
//     EPS_M_VELOCITY2/EPS_M_ORIGIN2/EPS_VIEWANGLE2/EPS_STATS -- constants
//     already defined in qcommon.ts, shared with r1q2.ts) is inherited
//     unchanged from R1Q2 (q2proto_proto_q2pro.c's playerstate read/write
//     functions use the identical bit layout as q2proto_proto_r1q2.c's).
//     Notably this REPLACES vanilla's unconditional 4-byte statbits field:
//     stats are only sent at all when EPS_STATS is set (q2pro.c's playerstate
//     read never touches statbits/stats unless `extraflags & EPS_STATS`) --
//     verified at q2pro_client_read_playerstate's stats block (mirrors
//     q2proto_proto_r1q2.c:510-515, which q2pro.c's own playerstate function
//     matches field-for-field for every bit this port implements).
//   - The frame envelope smuggles the 7-bit extraflags value through the
//     svc_frame opcode byte's top 3 bits plus the suppress_count byte's top
//     nibble (q2pro.c:2138-2176's q2pro_server_write_frame, verified exact
//     bit math): `command_byte = svc_frame | ((extraflags & 0x70) << 1)`,
//     `suppress_count_byte = (real_suppress_count & 0x0F) | ((extraflags &
//     0x0F) << 4)`. Read side inverts this identically
//     (q2pro_client_read_frame, q2pro.c:840-870). This means there is NO
//     dedicated extraflags byte on the wire at all for this protocol -- unlike
//     q2repro.ts's 1038 codec, which (per that file's own writeFrame comment)
//     writes extraflags as its own explicit byte. Q2PRO's frame envelope also
//     has NO svc_playerinfo/svc_packetentities sub-opcodes (confirmed:
//     q2pro_client_read_frame goes directly from areabits to
//     q2pro_client_read_playerstate, then hands off to
//     q2pro_client_read_delta_entities with no opcode byte in between) --
//     same "no opcode" shape codec.ts already documents for q2repro.ts's
//     writePacketEntitiesBegin/readPacketEntitiesBegin.
//
// INTEGRATION GAP (not fixed by this file -- out of scope, flagged for
// whoever wires cl_parse.ts's dispatch loop): the extraflags-in-opcode-bits
// scheme above requires the RAW opcode byte's top 3 bits (`cmd & 0xE0`)
// before cl_parse.ts's dispatch masks it down to `cmd & 0x1F` for the switch.
// codec.ts's readFrameHeader is only ever invoked AFTER that byte has already
// been consumed and dispatched on, so it cannot see those bits itself. This
// file does NOT change the ProtocolCodec interface to solve this (that would
// force every other codec -- vanilla/q2repro/kexdemo -- to grow a parameter
// they never use). Instead, exactly mirroring q2repro.ts's own
// `pendingFrameExtraflags` module-level-variable precedent (see that file's
// readFrameHeader/readFramePlayerstate comment) for the piece that genuinely
// is internal to this module (frame-header -> frame-playerstate handoff),
// PLUS one new exported setter for the piece that is NOT internal (the raw
// opcode bits only cl_parse.ts's dispatch loop can see):
//
//   export function noteQ2ProFrameOpcodeExtrabits(extrabits: number): void
//
// cl_parse.ts's dispatch loop must, when `cls.codec.name === "q2pro"`, before
// switching on the just-read command byte: compute `extrabits = cmd & 0xE0`,
// mask `cmd &= 0x1F`, and call `noteQ2ProFrameOpcodeExtrabits(extrabits)`
// (harmless no-op call for every opcode except svc_frame, since a real Q2PRO
// peer only ever sets those bits when encoding svc_frame's own opcode byte --
// verified: every other q2pro.c write call site ORs its opcode literal with
// nothing). This file's readFrameHeader reads the value that setter stashed.
// Not implemented here because it requires editing cl_parse.ts, which is
// outside this file's SCOPE.
//
// zpacket (svc_r1q2_zpacket, opcode 21, shared with R1Q2) and connect-time
// has_zlib negotiation are explicitly OUT OF SCOPE for this file -- owned by
// the transport layer (net_chan.ts/cl_parse.ts), not the codec.
//
// Structure mirrors vanilla.ts (this port's template): same import surface,
// same "extracted verbatim" discipline where a body matches an existing
// pattern, same duplicated copyEntityState/copyPlayerStateFields helpers
// (q2repro.ts already establishes that duplicating these per-codec, rather
// than sharing one copy, is this port line's convention).

import type { SizeBuf } from "../sizebuf";
import {
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteString,
  MSG_WriteAngle16,
  MSG_WriteCoord,
  MSG_WriteAngle,
  MSG_WriteDeltaUsercmd,
  MSG_ReadDeltaUsercmd,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadWord,
  MSG_ReadLong,
  MSG_ReadString,
  MSG_ReadChar,
  MSG_ReadAngle,
  MSG_ReadAngle16,
  MSG_ReadCoord,
  MSG_ReadPos,
  MSG_ReadData,
  SZ_Write,
} from "../sizebuf";
import {
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_Q2PRO_CURRENT,
  U_REMOVE,
  U_NUMBER16,
  U_MOREBITS1,
  U_MOREBITS2,
  U_MOREBITS3,
  U_MODEL,
  U_MODEL2,
  U_MODEL3,
  U_MODEL4,
  U_FRAME8,
  U_FRAME16,
  U_SKIN8,
  U_SKIN16,
  U_EFFECTS8,
  U_EFFECTS16,
  U_RENDERFX8,
  U_RENDERFX16,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_OLDORIGIN,
  U_SOUND,
  U_EVENT,
  U_SOLID,
  SvcOpsT,
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
  EPS_GUNOFFSET,
  EPS_GUNANGLES,
  EPS_M_VELOCITY2,
  EPS_M_ORIGIN2,
  EPS_VIEWANGLE2,
  EPS_STATS,
  CM_ANGLE1,
  CM_ANGLE2,
  CM_ANGLE3,
  CM_FORWARD,
  CM_SIDE,
  CM_UP,
  CM_BUTTONS,
  CM_IMPULSE,
  ComError,
  ERR_FATAL,
} from "../qcommon";
import { net_message } from "../net_chan";
import { EntityStateT, PlayerStateT, type UsercmdT, MAX_STATS, MAX_EDICTS, RF_BEAM } from "../../shared/q_shared";
import { VectorCopy } from "../../shared/math";
import type { ProtocolCodec, ServerDataParamsT, ServerDataReadResultT, FrameWriteParamsT, FrameHeaderT, ClcBatchMoveT, ClcUserinfoDeltaT, ClcClientSettingT } from "./codec";
import { BitReader, readBatchMoveAngleComponent, readBatchMoveFrames, seedFromPrev, ClcBatchMoveError, MAX_CLC_BATCH_MOVE_FRAMES } from "./clc_batch_move";

const NULL_ENTITY_STATE = new EntityStateT();

// ---------------------------------------------------------------------------
// server -> client writes
// ---------------------------------------------------------------------------

// q2proto_q2pro_continue_serverdata's write-side mirror (q2proto_proto_q2pro.c
// ~line 1478-1508), restricted to the protocol_version < 1024 branch this
// port's PROTOCOL_VERSION_Q2PRO_CURRENT ceiling always selects: after the
// common fields, u16 protocol_version, u8 server_state (unconditional --
// found no version gate on this specific field in q2proto's read path), then
// three separate bool bytes strafejump_hack/qw_mode/waterjump_hack (the
// q2pro_flags single-word form only exists at EXTENDED_LIMITS=1024+, out of
// this port's scope).
function makeWriteServerData(minorVersion: number) {
  return function writeServerData(msg: SizeBuf, params: ServerDataParamsT): void {
    MSG_WriteByte(msg, SvcOpsT.svc_serverdata);
    MSG_WriteLong(msg, PROTOCOL_VERSION_Q2PRO);
    MSG_WriteLong(msg, params.servercount);
    MSG_WriteByte(msg, params.attractloop ? 1 : 0);
    MSG_WriteString(msg, params.gamedir);
    MSG_WriteShort(msg, params.clientnum);
    MSG_WriteString(msg, params.levelname);

    MSG_WriteShort(msg, params.q2proVersion ?? minorVersion);
    MSG_WriteByte(msg, params.serverState);
    MSG_WriteByte(msg, params.q2proStrafejumpHack ? 1 : 0);
    MSG_WriteByte(msg, params.q2proQwMode ? 1 : 0);
    MSG_WriteByte(msg, params.q2proWaterjumpHack ? 1 : 0);
  };
}

// Full reimplementation of sizebuf.ts's MSG_WriteDeltaEntity (not a delegate
// like vanilla.ts's writeDeltaEntity) -- every bit-flag decision is identical
// EXCEPT U_SOLID, which this protocol always writes as a u32 (see file header
// citation). Duplicated rather than parameterizing the shared primitive,
// matching this port line's established per-codec duplication convention.
function writeDeltaEntityQ2Pro(from: EntityStateT, to: EntityStateT, msg: SizeBuf, force: boolean, newentity: boolean): void {
  if (!to.number) throw new ComError(ERR_FATAL, "Unset entity number");
  if (to.number >= MAX_EDICTS) throw new ComError(ERR_FATAL, "Entity number >= MAX_EDICTS");

  let bits = 0;

  if (to.number >= 256) bits |= U_NUMBER16;

  if (to.origin[0] !== from.origin[0]) bits |= U_ORIGIN1;
  if (to.origin[1] !== from.origin[1]) bits |= U_ORIGIN2;
  if (to.origin[2] !== from.origin[2]) bits |= U_ORIGIN3;

  if (to.angles[0] !== from.angles[0]) bits |= U_ANGLE1;
  if (to.angles[1] !== from.angles[1]) bits |= U_ANGLE2;
  if (to.angles[2] !== from.angles[2]) bits |= U_ANGLE3;

  if (to.skinnum !== from.skinnum) {
    if ((to.skinnum >>> 0) < 256) bits |= U_SKIN8;
    else if ((to.skinnum >>> 0) < 0x10000) bits |= U_SKIN16;
    else bits |= U_SKIN8 | U_SKIN16;
  }

  if (to.frame !== from.frame) {
    if (to.frame < 256) bits |= U_FRAME8;
    else bits |= U_FRAME16;
  }

  // FIXED (.orch/followups.md post-1.0 follow-up): effects/renderfx used to
  // gate their 16-bit-only path at `< 0x8000`, asymmetric with skinnum's
  // `< 0x10000` above. Q2PRO's OWN reference
  // (q2proto_proto_q2pro.c:1596/1606/1617, all three calling
  // q2proto_common_choose_width_flags(..., /*uint16_safe=*/true)) treats
  // skinnum/effects/renderfx UNIFORMLY -- uint16_safe=true means the
  // 16-bit-only path is safe up to 0xffff (q2proto_internal_common.h's
  // helper), not just 0x7fff. This port's readDeltaEntity below already
  // reads effects/renderfx's 16-bit path as MSG_ReadWord (unsigned), so
  // raising the gate to match is a pure wire-format correctness fix, not a
  // read-side risk: a value in [0x8000, 0xffff) now goes out 2 bytes
  // shorter (U_EFFECTS16/U_RENDERFX16 alone) instead of the 4-byte 32-bit
  // combined form, matching what a real Q2PRO server would send.
  if (to.effects !== from.effects) {
    if (to.effects < 256) bits |= U_EFFECTS8;
    else if (to.effects < 0x10000) bits |= U_EFFECTS16;
    else bits |= U_EFFECTS8 | U_EFFECTS16;
  }

  if (to.renderfx !== from.renderfx) {
    if (to.renderfx < 256) bits |= U_RENDERFX8;
    else if (to.renderfx < 0x10000) bits |= U_RENDERFX16;
    else bits |= U_RENDERFX8 | U_RENDERFX16;
  }

  if (to.solid !== from.solid) bits |= U_SOLID;

  if (to.event) bits |= U_EVENT;

  if (to.modelindex !== from.modelindex) bits |= U_MODEL;
  if (to.modelindex2 !== from.modelindex2) bits |= U_MODEL2;
  if (to.modelindex3 !== from.modelindex3) bits |= U_MODEL3;
  if (to.modelindex4 !== from.modelindex4) bits |= U_MODEL4;

  if (to.sound !== from.sound) bits |= U_SOUND;

  if (newentity || to.renderfx & RF_BEAM) bits |= U_OLDORIGIN;

  if (!bits && !force) return;

  if (bits & 0xff000000) bits |= U_MOREBITS3 | U_MOREBITS2 | U_MOREBITS1;
  else if (bits & 0x00ff0000) bits |= U_MOREBITS2 | U_MOREBITS1;
  else if (bits & 0x0000ff00) bits |= U_MOREBITS1;

  MSG_WriteByte(msg, bits & 255);

  if (bits & 0xff000000) {
    MSG_WriteByte(msg, (bits >> 8) & 255);
    MSG_WriteByte(msg, (bits >> 16) & 255);
    MSG_WriteByte(msg, (bits >> 24) & 255);
  } else if (bits & 0x00ff0000) {
    MSG_WriteByte(msg, (bits >> 8) & 255);
    MSG_WriteByte(msg, (bits >> 16) & 255);
  } else if (bits & 0x0000ff00) {
    MSG_WriteByte(msg, (bits >> 8) & 255);
  }

  if (bits & U_NUMBER16) MSG_WriteShort(msg, to.number);
  else MSG_WriteByte(msg, to.number);

  if (bits & U_MODEL) MSG_WriteByte(msg, to.modelindex);
  if (bits & U_MODEL2) MSG_WriteByte(msg, to.modelindex2);
  if (bits & U_MODEL3) MSG_WriteByte(msg, to.modelindex3);
  if (bits & U_MODEL4) MSG_WriteByte(msg, to.modelindex4);

  if (bits & U_FRAME8) MSG_WriteByte(msg, to.frame);
  if (bits & U_FRAME16) MSG_WriteShort(msg, to.frame);

  if (bits & U_SKIN8 && bits & U_SKIN16) MSG_WriteLong(msg, to.skinnum);
  else if (bits & U_SKIN8) MSG_WriteByte(msg, to.skinnum);
  else if (bits & U_SKIN16) MSG_WriteShort(msg, to.skinnum);

  if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) MSG_WriteLong(msg, to.effects);
  else if (bits & U_EFFECTS8) MSG_WriteByte(msg, to.effects);
  else if (bits & U_EFFECTS16) MSG_WriteShort(msg, to.effects);

  if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) MSG_WriteLong(msg, to.renderfx);
  else if (bits & U_RENDERFX8) MSG_WriteByte(msg, to.renderfx);
  else if (bits & U_RENDERFX16) MSG_WriteShort(msg, to.renderfx);

  if (bits & U_ORIGIN1) MSG_WriteCoord(msg, to.origin[0]);
  if (bits & U_ORIGIN2) MSG_WriteCoord(msg, to.origin[1]);
  if (bits & U_ORIGIN3) MSG_WriteCoord(msg, to.origin[2]);

  if (bits & U_ANGLE1) MSG_WriteAngle(msg, to.angles[0]);
  if (bits & U_ANGLE2) MSG_WriteAngle(msg, to.angles[1]);
  if (bits & U_ANGLE3) MSG_WriteAngle(msg, to.angles[2]);

  if (bits & U_OLDORIGIN) {
    MSG_WriteCoord(msg, to.old_origin[0]);
    MSG_WriteCoord(msg, to.old_origin[1]);
    MSG_WriteCoord(msg, to.old_origin[2]);
  }

  if (bits & U_SOUND) MSG_WriteByte(msg, to.sound);
  if (bits & U_EVENT) MSG_WriteByte(msg, to.event);

  // The one wire divergence from sizebuf.ts's MSG_WriteDeltaEntity: always a
  // u32, never a u16 (file header citation).
  if (bits & U_SOLID) MSG_WriteLong(msg, to.solid);
}

function writeDeltaEntity(msg: SizeBuf, from: EntityStateT, to: EntityStateT, force: boolean, newentity: boolean): void {
  writeDeltaEntityQ2Pro(from, to, msg, force, newentity);
}

function writeEntityRemove(msg: SizeBuf, oldnum: number): void {
  let bits = U_REMOVE;
  if (oldnum >= 256) bits |= U_NUMBER16 | U_MOREBITS1;

  MSG_WriteByte(msg, bits & 255);
  if (bits & 0x0000ff00) MSG_WriteByte(msg, (bits >> 8) & 255);

  if (bits & U_NUMBER16) MSG_WriteShort(msg, oldnum);
  else MSG_WriteByte(msg, oldnum);
}

function writePacketEntitiesEnd(msg: SizeBuf): void {
  MSG_WriteShort(msg, 0);
}

// No leading opcode -- Q2PRO's frame envelope has no svc_packetentities
// sub-opcode (file header citation).
function writePacketEntitiesBegin(_msg: SizeBuf): void {}

function writeSpawnBaseline(msg: SizeBuf, base: EntityStateT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_spawnbaseline);
  writeDeltaEntityQ2Pro(NULL_ENTITY_STATE, base, msg, true, true);
}

interface PlayerStateDeltaEncoding {
  flags: number;
  extraflags: number;
  writeBody(msg: SizeBuf): void;
}

// q2pro_server_write_playerstate (q2proto_proto_q2pro.c), restricted to this
// port's plain-tier field set. Computes flags/extraflags/body separately so
// writeFrame can smuggle extraflags into the opcode+suppress-count bytes
// (file header citation) before the body's own bytes are written -- same
// split q2repro.ts's own encodePlayerStateDelta helper already uses for the
// analogous "need the value before its real wire position" problem.
function encodePlayerStateDelta(from: PlayerStateT, to: PlayerStateT): PlayerStateDeltaEncoding {
  const ps = to;
  const ops = from;

  let flags = 0;
  let extraflags = 0;

  if (ps.pmove.pm_type !== ops.pmove.pm_type) flags |= PS_M_TYPE;

  if (ps.pmove.origin[0] !== ops.pmove.origin[0] || ps.pmove.origin[1] !== ops.pmove.origin[1]) flags |= PS_M_ORIGIN;
  if (ps.pmove.origin[2] !== ops.pmove.origin[2]) extraflags |= EPS_M_ORIGIN2;

  if (ps.pmove.velocity[0] !== ops.pmove.velocity[0] || ps.pmove.velocity[1] !== ops.pmove.velocity[1]) flags |= PS_M_VELOCITY;
  if (ps.pmove.velocity[2] !== ops.pmove.velocity[2]) extraflags |= EPS_M_VELOCITY2;

  if (ps.pmove.pm_time !== ops.pmove.pm_time) flags |= PS_M_TIME;
  if (ps.pmove.pm_flags !== ops.pmove.pm_flags) flags |= PS_M_FLAGS;
  if (ps.pmove.gravity !== ops.pmove.gravity) flags |= PS_M_GRAVITY;

  if (
    ps.pmove.delta_angles[0] !== ops.pmove.delta_angles[0] ||
    ps.pmove.delta_angles[1] !== ops.pmove.delta_angles[1] ||
    ps.pmove.delta_angles[2] !== ops.pmove.delta_angles[2]
  )
    flags |= PS_M_DELTA_ANGLES;

  if (ps.viewoffset[0] !== ops.viewoffset[0] || ps.viewoffset[1] !== ops.viewoffset[1] || ps.viewoffset[2] !== ops.viewoffset[2])
    flags |= PS_VIEWOFFSET;

  if (ps.viewangles[0] !== ops.viewangles[0] || ps.viewangles[1] !== ops.viewangles[1]) flags |= PS_VIEWANGLES;
  if (ps.viewangles[2] !== ops.viewangles[2]) extraflags |= EPS_VIEWANGLE2;

  if (ps.kick_angles[0] !== ops.kick_angles[0] || ps.kick_angles[1] !== ops.kick_angles[1] || ps.kick_angles[2] !== ops.kick_angles[2])
    flags |= PS_KICKANGLES;

  // Vanilla quirk preserved unconditionally (vanilla.ts's writePlayerStateDelta
  // does the same, unguarded by a change check) -- nothing in
  // q2proto_proto_q2pro.c's plain-tier path suggests Q2PRO's server gates
  // gunindex on change either.
  flags |= PS_WEAPONINDEX;

  if (ps.gunframe !== ops.gunframe) flags |= PS_WEAPONFRAME;

  if (ps.gunoffset[0] !== ops.gunoffset[0] || ps.gunoffset[1] !== ops.gunoffset[1] || ps.gunoffset[2] !== ops.gunoffset[2])
    extraflags |= EPS_GUNOFFSET;
  if (ps.gunangles[0] !== ops.gunangles[0] || ps.gunangles[1] !== ops.gunangles[1] || ps.gunangles[2] !== ops.gunangles[2])
    extraflags |= EPS_GUNANGLES;

  if (ps.blend[0] !== ops.blend[0] || ps.blend[1] !== ops.blend[1] || ps.blend[2] !== ops.blend[2] || ps.blend[3] !== ops.blend[3])
    flags |= PS_BLEND;

  if (ps.fov !== ops.fov) flags |= PS_FOV;
  if (ps.rdflags !== ops.rdflags) flags |= PS_RDFLAGS;

  let statbits = 0;
  for (let i = 0; i < MAX_STATS; i++) if (ps.stats[i] !== ops.stats[i]) statbits |= 1 << i;
  // Divergence from vanilla (file header citation): stats are opt-in via
  // EPS_STATS, not an unconditional 4-byte field. No bytes at all are written
  // for stats when nothing changed.
  if (statbits !== 0) extraflags |= EPS_STATS;

  function writeBody(msg: SizeBuf): void {
    if (flags & PS_M_TYPE) MSG_WriteByte(msg, ps.pmove.pm_type);

    if (flags & PS_M_ORIGIN) {
      MSG_WriteShort(msg, ps.pmove.origin[0]);
      MSG_WriteShort(msg, ps.pmove.origin[1]);
    }
    if (extraflags & EPS_M_ORIGIN2) MSG_WriteShort(msg, ps.pmove.origin[2]);

    if (flags & PS_M_VELOCITY) {
      MSG_WriteShort(msg, ps.pmove.velocity[0]);
      MSG_WriteShort(msg, ps.pmove.velocity[1]);
    }
    if (extraflags & EPS_M_VELOCITY2) MSG_WriteShort(msg, ps.pmove.velocity[2]);

    if (flags & PS_M_TIME) MSG_WriteByte(msg, ps.pmove.pm_time);
    if (flags & PS_M_FLAGS) MSG_WriteByte(msg, ps.pmove.pm_flags);
    if (flags & PS_M_GRAVITY) MSG_WriteShort(msg, ps.pmove.gravity);

    if (flags & PS_M_DELTA_ANGLES) {
      MSG_WriteShort(msg, ps.pmove.delta_angles[0]);
      MSG_WriteShort(msg, ps.pmove.delta_angles[1]);
      MSG_WriteShort(msg, ps.pmove.delta_angles[2]);
    }

    if (flags & PS_VIEWOFFSET) {
      MSG_WriteChar(msg, ps.viewoffset[0] * 4);
      MSG_WriteChar(msg, ps.viewoffset[1] * 4);
      MSG_WriteChar(msg, ps.viewoffset[2] * 4);
    }

    if (flags & PS_VIEWANGLES) {
      MSG_WriteAngle16(msg, ps.viewangles[0]);
      MSG_WriteAngle16(msg, ps.viewangles[1]);
    }
    if (extraflags & EPS_VIEWANGLE2) MSG_WriteAngle16(msg, ps.viewangles[2]);

    if (flags & PS_KICKANGLES) {
      MSG_WriteChar(msg, ps.kick_angles[0] * 4);
      MSG_WriteChar(msg, ps.kick_angles[1] * 4);
      MSG_WriteChar(msg, ps.kick_angles[2] * 4);
    }

    if (flags & PS_WEAPONINDEX) MSG_WriteByte(msg, ps.gunindex);
    if (flags & PS_WEAPONFRAME) MSG_WriteByte(msg, ps.gunframe);

    // Decoupled from PS_WEAPONFRAME (file header citation) -- unlike
    // vanilla's bundled gunoffset/gunangles-with-gunframe.
    if (extraflags & EPS_GUNOFFSET) {
      MSG_WriteChar(msg, ps.gunoffset[0] * 4);
      MSG_WriteChar(msg, ps.gunoffset[1] * 4);
      MSG_WriteChar(msg, ps.gunoffset[2] * 4);
    }
    if (extraflags & EPS_GUNANGLES) {
      MSG_WriteChar(msg, ps.gunangles[0] * 4);
      MSG_WriteChar(msg, ps.gunangles[1] * 4);
      MSG_WriteChar(msg, ps.gunangles[2] * 4);
    }

    if (flags & PS_BLEND) {
      MSG_WriteByte(msg, ps.blend[0] * 255);
      MSG_WriteByte(msg, ps.blend[1] * 255);
      MSG_WriteByte(msg, ps.blend[2] * 255);
      MSG_WriteByte(msg, ps.blend[3] * 255);
    }
    if (flags & PS_FOV) MSG_WriteByte(msg, ps.fov);
    if (flags & PS_RDFLAGS) MSG_WriteByte(msg, ps.rdflags);

    if (extraflags & EPS_STATS) {
      MSG_WriteLong(msg, statbits);
      for (let i = 0; i < MAX_STATS; i++) if (statbits & (1 << i)) MSG_WriteShort(msg, ps.stats[i]);
    }
  }

  return { flags, extraflags, writeBody };
}

// Standalone fallback only. Q2PRO's real wire format never carries
// extraflags in a self-contained message -- it only ever rides the svc_frame
// opcode/suppress-count bytes (see writeFrame). No engine call site invokes
// this ProtocolCodec member directly today (grepped `.writePlayerStateDelta(`
// across src/ -- only vanilla.ts/q2repro.ts/codec.ts/kexdemo.ts reference it,
// all from within their own writeFrame). Kept internally consistent
// (round-trips with readPlayerStateDelta below) rather than matching a real
// wire capture, which cannot exist for this exact op on this protocol --
// same choice q2repro.ts already made for the same reason.
function writePlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const enc = encodePlayerStateDelta(from, to);
  MSG_WriteByte(msg, SvcOpsT.svc_playerinfo);
  MSG_WriteShort(msg, enc.flags);
  MSG_WriteByte(msg, enc.extraflags);
  enc.writeBody(msg);
}

// q2pro_server_write_frame (q2proto_proto_q2pro.c:2138-2176) -- see file
// header for the exact opcode/suppress-count bit-packing citation. Computes
// the playerstate encoding FIRST (need extraflags before the opcode byte can
// be written) rather than q2proto's own "reserve then patch" I/O trick,
// matching q2repro.ts's writeFrame's own documented rationale for the same
// substitution (JS evaluation order is caller-controlled).
function writeFrame(msg: SizeBuf, params: FrameWriteParamsT, writeEntities: (msg: SizeBuf) => void): void {
  const enc = encodePlayerStateDelta(params.psFrom ?? new PlayerStateT(), params.psTo);

  const extrabits = (enc.extraflags & 0x70) << 1;
  MSG_WriteByte(msg, SvcOpsT.svc_frame | extrabits);

  const deltaframe = params.lastframe;
  const offset = deltaframe === -1 ? 31 : params.framenum - deltaframe;
  const encodedFrame = (params.framenum & 0x07ffffff) | (offset << 27);
  MSG_WriteLong(msg, encodedFrame);

  const suppressByte = (params.surpressCount & 0x0f) | ((enc.extraflags & 0x0f) << 4);
  MSG_WriteByte(msg, suppressByte);

  MSG_WriteByte(msg, params.areabytes);
  SZ_Write(msg, params.areabits, params.areabytes);

  // No opcode -- Q2PRO's frame envelope has no svc_playerinfo sub-opcode
  // (file header citation).
  MSG_WriteShort(msg, enc.flags);
  enc.writeBody(msg);

  writeEntities(msg);
}

// ---------------------------------------------------------------------------
// client -> server write / server-side read (usercmd)
// ---------------------------------------------------------------------------

// Byte-identical to vanilla's shape (file header citation) -- delegates to
// the same shared primitive vanilla.ts uses.
function writeDeltaUsercmd(msg: SizeBuf, from: UsercmdT, cmd: UsercmdT): void {
  MSG_WriteDeltaUsercmd(msg, from, cmd);
}

function readDeltaUsercmd(msg: SizeBuf, from: UsercmdT, move: UsercmdT): void {
  MSG_ReadDeltaUsercmd(msg, from, move);
}

// ---------------------------------------------------------------------------
// clc_q2pro_move_batched / clc_q2pro_move_nodelta / clc_q2pro_userinfo_delta
// (phase-8 q2repro interop unit -- this port's SCOPE CUT note at the top of
// this file previously excluded these three opcodes; that exclusion is
// narrowed to exactly what remains unimplemented, see readBatchMove's own
// note on num_dups/opcodeExtra). See clc_batch_move.ts's file header for the
// shared citation trail and the "upmove/lightlevel decoded-but-never-
// applied" findings this decode relies on.
// ---------------------------------------------------------------------------

// q2pro_server_read_batch_move_delta, q2proto_proto_q2pro.c:2415-2475. Two
// real divergences from q2repro.ts's decodeCmd (both verified against the
// reference source, not assumed to match): CM_UP is a real, decodable -10-bit
// field here (q2pro.c:2457-2461) -- unlike 1038, this plain-tier format never
// rejects it -- but it is still never copied into the resolved usercmd_t
// (qsrc/q2repro/src/server/user.c's apply_usercmd_delta has no upmove
// assignment on ANY protocol; see clc_batch_move.ts's file header), so it is
// decoded here purely to stay byte-aligned and then discarded. CM_BUTTONS
// reads only 3 raw bits and remaps them (q2pro.c:2465-2466: `(buttons_value &
// 3) | ((buttons_value & 4) << 5)`) rather than q2repro's full 8-bit byte.
function decodeQ2ProBatchCmd(br: BitReader, prev: UsercmdT | null): UsercmdT {
  const cmd = seedFromPrev(prev);

  const hasContents = br.readUnsigned(1);
  if (!hasContents) return cmd;

  const bits = br.readUnsigned(8);
  if (bits & CM_ANGLE1) cmd.angles[0] = readBatchMoveAngleComponent(br, prev ? prev.angles[0] : 0);
  if (bits & CM_ANGLE2) cmd.angles[1] = readBatchMoveAngleComponent(br, prev ? prev.angles[1] : 0);
  if (bits & CM_ANGLE3) cmd.angles[2] = br.readSigned(16); // no delta form for roll (q2pro.c:2441-2445)

  if (bits & CM_FORWARD) cmd.forwardmove = br.readSigned(10);
  if (bits & CM_SIDE) cmd.sidemove = br.readSigned(10);
  if (bits & CM_UP) {
    // Decoded for wire-alignment parity with a real Q2PRO peer; never
    // applied (file header citation) -- deliberately discarded, not stored
    // on `cmd` at all (matches upstream's own apply_usercmd_delta exactly:
    // NOT even a "decoded but unused" struct field survives past this read).
    br.readSigned(10);
  }

  if (bits & CM_BUTTONS) {
    const raw = br.readUnsigned(3);
    cmd.buttons = (raw & 3) | ((raw & 4) << 5);
  }

  // CM_IMPULSE is reused as "an explicit msec byte follows" here too
  // (q2pro.c:2468-2473), same convention as q2repro.ts's batch decode.
  if (bits & CM_IMPULSE) cmd.msec = br.readUnsigned(8);
  else cmd.msec = prev ? prev.msec : 0;

  return cmd;
}

// q2pro_server_read_batch_move, q2proto_proto_q2pro.c:2477-2515. Unlike
// q2repro's 1038 format, Q2PRO smuggles num_dups in the raw clc opcode
// byte's top 3 bits ("Q2PRO stuffs some extra info into upper 3 command
// bits", q2pro.c:2317-2320) instead of an explicit stream byte -- the caller
// (sv_user.ts) extracts that value from the just-read opcode byte and passes
// it as `opcodeExtra` BEFORE this function reads anything else.
function readBatchMove(msg: SizeBuf, nodelta: boolean, opcodeExtra: number): ClcBatchMoveT {
  const numDups = opcodeExtra;
  if (numDups >= MAX_CLC_BATCH_MOVE_FRAMES - 1) {
    throw new ClcBatchMoveError("clc_q2pro_move_batched (36): num_dups out of range (Q2P_ERR_BAD_DATA, q2proto_proto_q2pro.c:2481-2482)");
  }

  const lastframe = nodelta ? -1 : MSG_ReadLong(msg);

  const lightlevel = MSG_ReadByte(msg); // decoded, never applied -- see clc_batch_move.ts's file header finding
  if (lightlevel < 0) throw new ClcBatchMoveError("clc_q2pro_move_batched (36): truncated message (lightlevel)");

  const br = new BitReader(msg);
  const frames = readBatchMoveFrames(br, numDups, decodeQ2ProBatchCmd);
  return { lastframe, numDups, frames };
}

// q2pro_server_read_userinfo_delta, q2proto_proto_q2pro.c:2517-2522 --
// byte-identical shape to q2repro.ts's readUserinfoDelta (both wrap the same
// two-string q2proto_string_t pair).
function readUserinfoDelta(msg: SizeBuf): ClcUserinfoDeltaT {
  const name = MSG_ReadString(msg);
  const value = MSG_ReadString(msg);
  return { name, value };
}

// q2pro_server_read_setting (q2proto_proto_q2pro.c, byte-identical shape to
// q2repro's -- both just read two i16 shorts). Phase-8 interop finding: see
// codec.ts's ClcClientSettingT doc comment.
function readClientSetting(msg: SizeBuf): ClcClientSettingT {
  const index = MSG_ReadShort(msg);
  const value = MSG_ReadShort(msg);
  return { index, value };
}

// ---------------------------------------------------------------------------
// client-side reads (net_message singleton -- see codec.ts's asymmetry note)
// ---------------------------------------------------------------------------

function readServerData(minorVersion: number): ServerDataReadResultT {
  const servercount = MSG_ReadLong(net_message);
  const attractloop = MSG_ReadByte(net_message) !== 0;
  const gamedir = MSG_ReadString(net_message);
  const clientnum = MSG_ReadShort(net_message);
  const levelname = MSG_ReadString(net_message);

  const q2proVersion = MSG_ReadShort(net_message);
  const serverState = MSG_ReadByte(net_message);
  const q2proStrafejumpHack = MSG_ReadByte(net_message) !== 0;
  const q2proQwMode = MSG_ReadByte(net_message) !== 0;
  const q2proWaterjumpHack = MSG_ReadByte(net_message) !== 0;

  return {
    servercount,
    attractloop,
    gamedir,
    clientnum,
    levelname,
    serverState,
    q2proVersion: q2proVersion || minorVersion,
    q2proStrafejumpHack,
    q2proQwMode,
    q2proWaterjumpHack,
  };
}

function readEntityBits(): { number: number; bits: number } {
  let total = MSG_ReadByte(net_message);
  if (total & U_MOREBITS1) {
    const b = MSG_ReadByte(net_message);
    total |= b << 8;
  }
  if (total & U_MOREBITS2) {
    const b = MSG_ReadByte(net_message);
    total |= b << 16;
  }
  if (total & U_MOREBITS3) {
    const b = MSG_ReadByte(net_message);
    total |= b << 24;
  }

  let number: number;
  if (total & U_NUMBER16) number = MSG_ReadShort(net_message);
  else number = MSG_ReadByte(net_message);

  return { number, bits: total >>> 0 };
}

function copyEntityState(dst: EntityStateT, src: EntityStateT): void {
  dst.number = src.number;
  VectorCopy(src.origin, dst.origin);
  VectorCopy(src.angles, dst.angles);
  VectorCopy(src.old_origin, dst.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
}

function readDeltaEntity(from: EntityStateT, to: EntityStateT, number: number, bits: number): void {
  copyEntityState(to, from);

  VectorCopy(from.origin, to.old_origin);
  to.number = number;

  if (bits & U_MODEL) to.modelindex = MSG_ReadByte(net_message);
  if (bits & U_MODEL2) to.modelindex2 = MSG_ReadByte(net_message);
  if (bits & U_MODEL3) to.modelindex3 = MSG_ReadByte(net_message);
  if (bits & U_MODEL4) to.modelindex4 = MSG_ReadByte(net_message);

  if (bits & U_FRAME8) to.frame = MSG_ReadByte(net_message);
  // RULE-17 FIX: q2proto_proto_q2pro.c reads frame/skinnum/effects/renderfx's
  // 16-bit-only path as `u16` (unsigned) -- q2pro.ts's own encoder above
  // writes frame's U_FRAME16 case unconditionally for any value >= 256 (no
  // 32-bit escape hatch exists for frame at all), so a signed MSG_ReadShort
  // here sign-extends any frame/skinnum/effects/renderfx value >= 0x8000
  // into a negative number -- same bug class as q2repro.ts's/kexdemo.ts's
  // cf4c673 fix and mvd.ts's Rerelease-codec gunframe fix.
  if (bits & U_FRAME16) to.frame = MSG_ReadWord(net_message);

  if (bits & U_SKIN8 && bits & U_SKIN16) to.skinnum = MSG_ReadLong(net_message);
  else if (bits & U_SKIN8) to.skinnum = MSG_ReadByte(net_message);
  else if (bits & U_SKIN16) to.skinnum = MSG_ReadWord(net_message);

  if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) to.effects = MSG_ReadLong(net_message);
  else if (bits & U_EFFECTS8) to.effects = MSG_ReadByte(net_message);
  else if (bits & U_EFFECTS16) to.effects = MSG_ReadWord(net_message);

  if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) to.renderfx = MSG_ReadLong(net_message);
  else if (bits & U_RENDERFX8) to.renderfx = MSG_ReadByte(net_message);
  else if (bits & U_RENDERFX16) to.renderfx = MSG_ReadWord(net_message);

  if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadCoord(net_message);
  if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadCoord(net_message);
  if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadCoord(net_message);

  if (bits & U_ANGLE1) to.angles[0] = MSG_ReadAngle(net_message);
  if (bits & U_ANGLE2) to.angles[1] = MSG_ReadAngle(net_message);
  if (bits & U_ANGLE3) to.angles[2] = MSG_ReadAngle(net_message);

  if (bits & U_OLDORIGIN) MSG_ReadPos(net_message, to.old_origin);

  if (bits & U_SOUND) to.sound = MSG_ReadByte(net_message);

  if (bits & U_EVENT) to.event = MSG_ReadByte(net_message);
  else to.event = 0;

  // The one wire divergence from vanilla.ts's readDeltaEntity (file header
  // citation): always a u32, never a u16.
  if (bits & U_SOLID) to.solid = MSG_ReadLong(net_message);
}

function copyPlayerStateFields(dst: PlayerStateT, src: PlayerStateT): void {
  dst.pmove.pm_type = src.pmove.pm_type;
  dst.pmove.origin.set(src.pmove.origin);
  dst.pmove.velocity.set(src.pmove.velocity);
  dst.pmove.pm_flags = src.pmove.pm_flags;
  dst.pmove.pm_time = src.pmove.pm_time;
  dst.pmove.gravity = src.pmove.gravity;
  dst.pmove.delta_angles.set(src.pmove.delta_angles);
  VectorCopy(src.viewangles, dst.viewangles);
  VectorCopy(src.viewoffset, dst.viewoffset);
  VectorCopy(src.kick_angles, dst.kick_angles);
  VectorCopy(src.gunangles, dst.gunangles);
  VectorCopy(src.gunoffset, dst.gunoffset);
  dst.gunindex = src.gunindex;
  dst.gunframe = src.gunframe;
  dst.blend.set(src.blend);
  dst.fov = src.fov;
  dst.rdflags = src.rdflags;
  dst.stats.set(src.stats);
}

// Shared by readFramePlayerstate (frame envelope -- flags read separately,
// see below) and readPlayerStateDelta (standalone -- reads its own
// flags/extraflags first). Mirrors encodePlayerStateDelta's writeBody field
// order exactly.
function readPlayerStateBody(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT, flags: number, extraflags: number): void {
  copyPlayerStateFields(to, from);
  const target = to;

  if (flags & PS_M_TYPE) target.pmove.pm_type = MSG_ReadByte(msg);

  if (flags & PS_M_ORIGIN) {
    target.pmove.origin[0] = MSG_ReadShort(msg);
    target.pmove.origin[1] = MSG_ReadShort(msg);
  }
  if (extraflags & EPS_M_ORIGIN2) target.pmove.origin[2] = MSG_ReadShort(msg);

  if (flags & PS_M_VELOCITY) {
    target.pmove.velocity[0] = MSG_ReadShort(msg);
    target.pmove.velocity[1] = MSG_ReadShort(msg);
  }
  if (extraflags & EPS_M_VELOCITY2) target.pmove.velocity[2] = MSG_ReadShort(msg);

  if (flags & PS_M_TIME) target.pmove.pm_time = MSG_ReadByte(msg);
  if (flags & PS_M_FLAGS) target.pmove.pm_flags = MSG_ReadByte(msg);
  if (flags & PS_M_GRAVITY) target.pmove.gravity = MSG_ReadShort(msg);

  if (flags & PS_M_DELTA_ANGLES) {
    target.pmove.delta_angles[0] = MSG_ReadShort(msg);
    target.pmove.delta_angles[1] = MSG_ReadShort(msg);
    target.pmove.delta_angles[2] = MSG_ReadShort(msg);
  }

  if (flags & PS_VIEWOFFSET) {
    target.viewoffset[0] = MSG_ReadChar(msg) * 0.25;
    target.viewoffset[1] = MSG_ReadChar(msg) * 0.25;
    target.viewoffset[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (flags & PS_VIEWANGLES) {
    target.viewangles[0] = MSG_ReadAngle16(msg);
    target.viewangles[1] = MSG_ReadAngle16(msg);
  }
  if (extraflags & EPS_VIEWANGLE2) target.viewangles[2] = MSG_ReadAngle16(msg);

  if (flags & PS_KICKANGLES) {
    target.kick_angles[0] = MSG_ReadChar(msg) * 0.25;
    target.kick_angles[1] = MSG_ReadChar(msg) * 0.25;
    target.kick_angles[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (flags & PS_WEAPONINDEX) target.gunindex = MSG_ReadByte(msg);
  if (flags & PS_WEAPONFRAME) target.gunframe = MSG_ReadByte(msg);

  if (extraflags & EPS_GUNOFFSET) {
    target.gunoffset[0] = MSG_ReadChar(msg) * 0.25;
    target.gunoffset[1] = MSG_ReadChar(msg) * 0.25;
    target.gunoffset[2] = MSG_ReadChar(msg) * 0.25;
  }
  if (extraflags & EPS_GUNANGLES) {
    target.gunangles[0] = MSG_ReadChar(msg) * 0.25;
    target.gunangles[1] = MSG_ReadChar(msg) * 0.25;
    target.gunangles[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (flags & PS_BLEND) {
    target.blend[0] = MSG_ReadByte(msg) / 255.0;
    target.blend[1] = MSG_ReadByte(msg) / 255.0;
    target.blend[2] = MSG_ReadByte(msg) / 255.0;
    target.blend[3] = MSG_ReadByte(msg) / 255.0;
  }

  if (flags & PS_FOV) target.fov = MSG_ReadByte(msg);
  if (flags & PS_RDFLAGS) target.rdflags = MSG_ReadByte(msg);

  if (extraflags & EPS_STATS) {
    const statbits = MSG_ReadLong(msg);
    for (let i = 0; i < MAX_STATS; i++) if (statbits & (1 << i)) target.stats[i] = MSG_ReadShort(msg);
  }
}

function readPlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const flags = MSG_ReadShort(msg);
  const extraflags = MSG_ReadByte(msg);
  readPlayerStateBody(msg, from, to, flags, extraflags);
}

// See file header "INTEGRATION GAP" note: set by cl_parse.ts's dispatch loop
// (once wired) via noteQ2ProFrameOpcodeExtrabits BEFORE the svc_frame case
// invokes CL_ParseFrame -> readFrameHeader. Module-level, not per-codec-
// instance state, matching q2repro.ts's own pendingFrameExtraflags precedent
// (safe because message parsing is synchronous, one message at a time, exactly
// like net_message's own singleton).
let pendingOpcodeExtrabits = 0;
let pendingFrameExtraflags = 0;

// See file header "INTEGRATION GAP" note for the call-site contract.
export function noteQ2ProFrameOpcodeExtrabits(extrabits: number): void {
  pendingOpcodeExtrabits = extrabits;
}

// q2pro_client_read_frame (q2proto_proto_q2pro.c:840-870) -- see file header
// for the exact bit-recombination citation.
function readFrameHeader(areabits: Uint8Array, _readSuppressByte: boolean): FrameHeaderT {
  const encodedFrame = MSG_ReadLong(net_message);
  const offset = encodedFrame >>> 27;
  const serverframe = encodedFrame & 0x07ffffff;
  const deltaframe = offset === 31 ? -1 : serverframe - offset;

  const extraflagsHigh = (pendingOpcodeExtrabits >> 1) & 0x70;
  pendingOpcodeExtrabits = 0; // consumed -- next opcode byte's bits (if any) belong to a different message

  const suppressRaw = MSG_ReadByte(net_message);
  const surpressCount = suppressRaw & 0x0f;
  const extraflagsLow = (suppressRaw & 0xf0) >> 4;

  pendingFrameExtraflags = extraflagsHigh | extraflagsLow;

  const len = MSG_ReadByte(net_message);
  MSG_ReadData(net_message, areabits, len);

  return { serverframe, deltaframe, surpressCount };
}

function readFramePlayerstate(from: PlayerStateT, to: PlayerStateT): void {
  const flags = MSG_ReadShort(net_message);
  readPlayerStateBody(net_message, from, to, flags, pendingFrameExtraflags);
}

function readPacketEntitiesBegin(): void {
  // No opcode to consume -- see writePacketEntitiesBegin.
}

export function createQ2ProCodec(minorVersion: number): ProtocolCodec {
  const writeServerData = makeWriteServerData(minorVersion);
  return {
    name: "q2pro",
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
    readServerData: () => readServerData(minorVersion),
    readEntityBits,
    readDeltaEntity,
    readPlayerStateDelta,
    readFrameHeader,
    readFramePlayerstate,
    readPacketEntitiesBegin,
    readBatchMove,
    readUserinfoDelta,
    readClientSetting,
  };
}

export const Q2PRO_CODEC: ProtocolCodec = createQ2ProCodec(PROTOCOL_VERSION_Q2PRO_CURRENT);
