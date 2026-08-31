// R1Q2 protocol codec (protocol 35) -- v1.0.0 wire cluster (task board #23,
// Mike's ruling: our server accepts classic community clients and our client
// joins classic community servers). Ported from q2proto's reference
// implementation (~/Projects/q2proto/src/q2proto_proto_r1q2.c), a portable
// Quake 2 protocol library covering the real R1Q2 engine's wire format.
//
// R1Q2 is much closer to vanilla (protocol 34) than to q2repro (1038):
// entity-state deltas are byte-identical to vanilla except U_SOLID's width,
// and clc_move is byte-identical except an optional per-connection
// compression trick. The one genuinely new mechanism is an 8-bit
// player_state_t "extraflags" byte (EPS_*, qcommon.ts) that travels through
// the svc_frame envelope's opcode byte and suppress_count byte instead of
// getting its own MSG_WriteByte call -- see writeFrame/readFrameHeader below.
//
// PER-CONNECTION MINOR VERSION: R1Q2's wire behavior depends on a negotiated
// minor version (1903-1905, PROTOCOL_VERSION_R1Q2_* in qcommon.ts) that
// varies per connection, unlike every other codec in this seam (plain
// stateless singletons). `createR1Q2Codec(minorVersion)` returns a fresh
// ProtocolCodec closed over that connection's negotiated version; `R1Q2_CODEC`
// is a convenience default at the current ceiling for callers that don't
// need per-connection variance (golden-byte tests, mostly).
//
// INTEGRATION GAP (reported, not fixed here -- out of this file's scope):
// the svc_frame opcode byte's high 3 bits (`extrabits`) carry part of
// `extraflags` and MUST be read by cl_parse.ts's top-level dispatch switch
// BEFORE readFrameHeader runs -- that switch currently does
// `switch (cmd) { case SvcOpsT.svc_frame: ... }` on the UNMASKED byte, which
// only matches when extrabits happen to be zero. Whoever wires R1Q2_CODEC/
// Q2PRO_CODEC into cl_parse.ts must: (1) mask `cmd & 0x1F` before the switch
// when the active codec is R1Q2/Q2PRO, and (2) call
// `setR1Q2FrameExtrabits(cmd & 0xE0)` before dispatching to CL_ParseFrame.
// This mirrors q2repro.ts's own `pendingFrameExtraflags` module-level
// hand-off pattern (see that file), just carrying the raw opcode extrabits
// across the same seam instead of an explicit wire byte (R1Q2 has none).
//
// zpacket (svc_r1q2_zpacket) is explicitly OUT OF SCOPE here -- it is a
// transport-layer wrap/unwrap owned by qcommon/protocol/zpacket.ts and the
// connect-negotiation wiring, not a per-field codec op.

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
  MSG_WriteDeltaEntity,
  MSG_ReadDeltaUsercmd,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadString,
  MSG_ReadChar,
  MSG_ReadAngle16,
  MSG_ReadCoord,
  MSG_ReadAngle,
  MSG_ReadPos,
  MSG_ReadData,
  SZ_Write,
} from "../sizebuf";
import {
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_R1Q2_UCMD,
  PROTOCOL_VERSION_R1Q2_LONG_SOLID,
  PROTOCOL_VERSION_R1Q2_CURRENT,
  EPS_GUNOFFSET,
  EPS_GUNANGLES,
  EPS_M_VELOCITY2,
  EPS_M_ORIGIN2,
  EPS_VIEWANGLE2,
  EPS_STATS,
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
} from "../qcommon";
import { net_message } from "../net_chan";
import { EntityStateT, PlayerStateT, type UsercmdT, MAX_STATS, MAX_EDICTS, RF_BEAM } from "../../shared/q_shared";
import { VectorCopy } from "../../shared/math";
import { ComError, ERR_FATAL } from "../qcommon";
import type { ProtocolCodec, ServerDataParamsT, ServerDataReadResultT, FrameWriteParamsT, FrameHeaderT, ClcClientSettingT } from "./codec";

// ---------------------------------------------------------------------------
// server -> client writes
// ---------------------------------------------------------------------------

// r1q2_server_write_serverdata / q2proto_r1q2_continue_serverdata
// (q2proto_proto_r1q2.c:937-951 / :72-97). Field order after the common
// levelname string: r1q2.enhanced(bool/u8), protocol_version(u16), a
// hardcoded placeholder byte ("advanced deltas", never functional in this
// library -- written as a literal 0 on the write side, skipped-not-stored on
// the read side), then strafejump_hack(bool/u8).
function writeServerData(msg: SizeBuf, params: ServerDataParamsT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_serverdata);
  MSG_WriteLong(msg, PROTOCOL_VERSION_R1Q2);
  MSG_WriteLong(msg, params.servercount);
  MSG_WriteByte(msg, params.attractloop ? 1 : 0);
  MSG_WriteString(msg, params.gamedir);
  MSG_WriteShort(msg, params.clientnum);
  MSG_WriteString(msg, params.levelname);
  // r1q2.enhanced (q2proto_proto_r1q2.c:946). RULE-17 FIX (protocol-35 spawn
  // diagnosis): this byte announces the R1Q2 "Enhanced" server variant and
  // its proprietary protocol extensions, none of which this engine
  // implements. A real q2repro client refuses such a server outright --
  // src/client/parse.c:636-638, `if (serverdata->r1q2.enhanced)
  // Com_Error(ERR_DROP, "'Enhanced' R1Q2 servers are not supported")` -- so
  // reporting 1 here made every protocol-35 session die the instant our
  // serverdata was parsed, with the same reasoning that already keeps
  // r1q2StrafejumpHack advertised off (sv_user.ts's SV_New_f): the wire must
  // describe what this server actually does.
  MSG_WriteByte(msg, 0);
  MSG_WriteShort(msg, params.r1q2Version ?? PROTOCOL_VERSION_R1Q2_CURRENT);
  MSG_WriteByte(msg, 0); // "advanced deltas" -- hardcoded placeholder, q2proto_proto_r1q2.c:948
  MSG_WriteByte(msg, params.r1q2StrafejumpHack ? 1 : 0);
}

function readServerData(): ServerDataReadResultT {
  const servercount = MSG_ReadLong(net_message);
  const attractloop = MSG_ReadByte(net_message) !== 0;
  const gamedir = MSG_ReadString(net_message);
  const clientnum = MSG_ReadShort(net_message);
  const levelname = MSG_ReadString(net_message);
  MSG_ReadByte(net_message); // r1q2.enhanced -- not consumed by anything downstream
  const r1q2Version = MSG_ReadShort(net_message);
  MSG_ReadByte(net_message); // "advanced deltas" placeholder -- always 0, discarded (q2proto_r1q2_continue_serverdata's own "skip advanced deltas" comment)
  const r1q2StrafejumpHack = MSG_ReadByte(net_message) !== 0;
  return { servercount, attractloop, gamedir, clientnum, levelname, serverState: 0, r1q2Version, r1q2StrafejumpHack };
}

// r1q2_server_write_entity_state_delta / r1q2_client_read_entity_delta
// (q2proto_proto_r1q2.c:953-.../:305-393). Byte-identical to vanilla's
// MSG_WriteDeltaEntity/vanilla.ts's readDeltaEntity for every field except
// U_SOLID, which widens from a u16 cmodel-index short to a u32 packed bbox at
// PROTOCOL_VERSION_R1Q2_LONG_SOLID (context->features.has_solid32,
// q2proto_proto_r1q2.c:94). Duplicated in full (not delegated to
// sizebuf.ts's MSG_WriteDeltaEntity/vanilla.ts's readDeltaEntity) because
// neither of those can be parametrized by minor version without changing a
// shared file outside this codec's scope -- same duplication precedent as
// q2repro.ts's own from-scratch entity-delta implementation.
function makeEntityDeltaCodec(minorVersion: number) {
  const longSolid = minorVersion >= PROTOCOL_VERSION_R1Q2_LONG_SOLID;

  function writeDeltaEntity(msg: SizeBuf, from: EntityStateT, to: EntityStateT, force: boolean, newentity: boolean): void {
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

    if (to.effects !== from.effects) {
      if (to.effects < 256) bits |= U_EFFECTS8;
      else if (to.effects < 0x8000) bits |= U_EFFECTS16;
      else bits |= U_EFFECTS8 | U_EFFECTS16;
    }

    if (to.renderfx !== from.renderfx) {
      if (to.renderfx < 256) bits |= U_RENDERFX8;
      else if (to.renderfx < 0x8000) bits |= U_RENDERFX16;
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
    if (bits & U_SOLID) {
      if (longSolid) MSG_WriteLong(msg, to.solid);
      else MSG_WriteShort(msg, to.solid);
    }
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
    if (bits & U_FRAME16) to.frame = MSG_ReadShort(net_message);

    if (bits & U_SKIN8 && bits & U_SKIN16) to.skinnum = MSG_ReadLong(net_message);
    else if (bits & U_SKIN8) to.skinnum = MSG_ReadByte(net_message);
    else if (bits & U_SKIN16) to.skinnum = MSG_ReadShort(net_message);

    if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) to.effects = MSG_ReadLong(net_message);
    else if (bits & U_EFFECTS8) to.effects = MSG_ReadByte(net_message);
    else if (bits & U_EFFECTS16) to.effects = MSG_ReadShort(net_message);

    if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) to.renderfx = MSG_ReadLong(net_message);
    else if (bits & U_RENDERFX8) to.renderfx = MSG_ReadByte(net_message);
    else if (bits & U_RENDERFX16) to.renderfx = MSG_ReadShort(net_message);

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

    if (bits & U_SOLID) to.solid = longSolid ? MSG_ReadLong(net_message) : MSG_ReadShort(net_message);
  }

  return { writeDeltaEntity, readDeltaEntity };
}

// Extracted from src/server/sv_ents.ts's SV_EmitPacketEntities (the "entity
// removed"/terminator branches) via vanilla.ts -- byte-identical on R1Q2:
// q2proto_proto_r1q2.c's remove branch calls the same
// q2proto_common_server_write_entity_bits helper vanilla's write path uses,
// and the terminator is two zero bytes either way (q2proto_proto_r1q2.c's
// `WRITE_CHECKED(...,u8,0); WRITE_CHECKED(...,u8,0);` vs vanilla's
// MSG_WriteShort(msg, 0) -- both little-endian-zero, byte-identical).
import { VANILLA_CODEC } from "./vanilla";
const writeEntityRemove = VANILLA_CODEC.writeEntityRemove;
const writePacketEntitiesEnd = VANILLA_CODEC.writePacketEntitiesEnd;

// R1Q2's svc_frame envelope has no leading svc_packetentities opcode --
// entity deltas follow the playerstate delta directly
// (r1q2_client_read_frame hands off straight to
// r1q2_client_read_delta_entities, q2proto_proto_r1q2.c:538-541 -- same
// "pseudo-message, no real per-message header" shape as q2repro/1038; see
// q2repro.ts's writePacketEntitiesBegin doc comment for the citation this
// mirrors).
function writePacketEntitiesBegin(_msg: SizeBuf): void {}
function readPacketEntitiesBegin(): void {}

const NULL_ENTITY_STATE = new EntityStateT();

// ---------------------------------------------------------------------------
// player_state_t delta encode/decode -- shared bit-computation core for both
// writeFrame (which needs `extraflags` BEFORE it can finish the opcode/
// suppress_count bytes) and the standalone writePlayerStateDelta interface
// op. Mirrors q2repro.ts's encodePlayerStateDelta split, adapted to R1Q2's
// vanilla-style (not q2repro's float-based) field encoding
// (r1q2_server_write_playerstate, q2proto_proto_r1q2.c:1137-1323).
// ---------------------------------------------------------------------------

interface PlayerStateDeltaEncodedT {
  flags: number;
  extraflags: number;
  writeBody(msg: SizeBuf): void;
}

function encodePlayerStateDelta(from: PlayerStateT, to: PlayerStateT): PlayerStateDeltaEncodedT {
  const ps = to;
  const ops = from;

  let flags = 0;
  let extraflags = 0;

  if (ps.pmove.pm_type !== ops.pmove.pm_type) flags |= PS_M_TYPE;

  const originXYChanged = ps.pmove.origin[0] !== ops.pmove.origin[0] || ps.pmove.origin[1] !== ops.pmove.origin[1];
  const originZChanged = ps.pmove.origin[2] !== ops.pmove.origin[2];
  if (originXYChanged) flags |= PS_M_ORIGIN;
  if (originZChanged) extraflags |= EPS_M_ORIGIN2;

  const velXYChanged = ps.pmove.velocity[0] !== ops.pmove.velocity[0] || ps.pmove.velocity[1] !== ops.pmove.velocity[1];
  const velZChanged = ps.pmove.velocity[2] !== ops.pmove.velocity[2];
  if (velXYChanged) flags |= PS_M_VELOCITY;
  if (velZChanged) extraflags |= EPS_M_VELOCITY2;

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

  const viewangleXYChanged = ps.viewangles[0] !== ops.viewangles[0] || ps.viewangles[1] !== ops.viewangles[1];
  const viewangleZChanged = ps.viewangles[2] !== ops.viewangles[2];
  if (viewangleXYChanged) flags |= PS_VIEWANGLES;
  if (viewangleZChanged) extraflags |= EPS_VIEWANGLE2;

  if (ps.kick_angles[0] !== ops.kick_angles[0] || ps.kick_angles[1] !== ops.kick_angles[1] || ps.kick_angles[2] !== ops.kick_angles[2])
    flags |= PS_KICKANGLES;

  if (ps.blend[0] !== ops.blend[0] || ps.blend[1] !== ops.blend[1] || ps.blend[2] !== ops.blend[2] || ps.blend[3] !== ops.blend[3])
    flags |= PS_BLEND;

  if (ps.fov !== ops.fov) flags |= PS_FOV;
  if (ps.rdflags !== ops.rdflags) flags |= PS_RDFLAGS;

  flags |= PS_WEAPONINDEX; // vanilla-inherited quirk: always sent, see vanilla.ts's writePlayerStateDelta

  if (ps.gunframe !== ops.gunframe) flags |= PS_WEAPONFRAME;

  const gunoffsetChanged = ps.gunoffset[0] !== ops.gunoffset[0] || ps.gunoffset[1] !== ops.gunoffset[1] || ps.gunoffset[2] !== ops.gunoffset[2];
  if (gunoffsetChanged) extraflags |= EPS_GUNOFFSET;

  const gunanglesChanged = ps.gunangles[0] !== ops.gunangles[0] || ps.gunangles[1] !== ops.gunangles[1] || ps.gunangles[2] !== ops.gunangles[2];
  if (gunanglesChanged) extraflags |= EPS_GUNANGLES;

  let statbits = 0;
  for (let i = 0; i < MAX_STATS; i++) if (ps.stats[i] !== ops.stats[i]) statbits |= 1 << i;
  if (statbits !== 0) extraflags |= EPS_STATS;

  return {
    flags,
    extraflags,
    writeBody(msg: SizeBuf): void {
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
    },
  };
}

// Public, standalone-message op (test/golden-byte use; never called by
// writeFrame, which needs `extraflags` before it can finish patching the
// opcode/suppress_count bytes -- see writeFrame below, and never called by
// production code either -- grepped, only vanilla.ts's/q2repro.ts's own
// writeFrame call their in-file equivalent). Real R1Q2 traffic never sends a
// playerstate delta outside a svc_frame envelope, so there is no genuine
// "standalone wire format" to match here (unlike vanilla's real
// svc_playerinfo opcode or q2repro's adjacent flags+extraflags bytes) --
// extraflags only means anything smuggled into the frame's opcode/
// suppress_count bytes, which don't exist for a standalone call. To keep this
// op self-consistent (write, then read, round-trips) it writes an explicit
// extraflags byte between flags and the fields -- a layout writeFrame does
// NOT use (see writeFrame's real embedded layout below), invented purely so
// this interface member has a coherent standalone meaning.
function writePlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const enc = encodePlayerStateDelta(from, to);
  MSG_WriteShort(msg, enc.flags);
  MSG_WriteByte(msg, enc.extraflags);
  enc.writeBody(msg);
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

// r1q2_client_read_playerstate, q2proto_proto_r1q2.c:409-518.
function readPlayerStateFields(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT, flags: number, extraflags: number): void {
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

// Public, standalone-message read op mirroring writePlayerStateDelta above --
// reads flags(u16), then the invented extraflags(u8) byte that function
// writes for standalone self-consistency (NOT how a real frame envelope
// carries it -- readFramePlayerstate below is the real per-frame path, and
// sources extraflags from readFrameHeader's opcode/suppress_count decode
// instead).
function readPlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const flags = MSG_ReadShort(msg);
  const extraflags = MSG_ReadByte(msg); // mirrors writePlayerStateDelta's own invented extraflags byte -- see that function's doc comment
  readPlayerStateFields(msg, from, to, flags, extraflags);
}

// ---------------------------------------------------------------------------
// frame envelope (r1q2_server_write_frame / r1q2_client_read_frame,
// q2proto_proto_r1q2.c:1323-1364 / :523-541)
// ---------------------------------------------------------------------------

// Opcode-extrabits hand-off for the read side -- see this file's header
// comment "INTEGRATION GAP" for why this must be set by the dispatch caller
// (cl_parse.ts) before readFrameHeader runs, and q2repro.ts's own
// `pendingFrameExtraflags` for the precedent this mirrors.
let pendingFrameExtrabits = 0;
export function setR1Q2FrameExtrabits(extrabits: number): void {
  pendingFrameExtrabits = extrabits;
}

// Carries the reconstructed extraflags value from readFrameHeader to the
// immediately-following readFramePlayerstate call (q2repro.ts's
// `pendingFrameExtraflags` precedent, same synchronous-single-message
// assumption).
let pendingFrameExtraflags = 0;

function writeFrame(msg: SizeBuf, params: FrameWriteParamsT, writeEntities: (msg: SizeBuf) => void): void {
  // Compute the playerstate delta FIRST so `extraflags` is known before the
  // opcode/suppress_count bytes are written -- q2proto_proto_r1q2.c instead
  // reserves those two bytes and patches them in after the fact
  // (q2protoio_write_reserve_raw), a C idiom for a single sequential output
  // stream. JS evaluation order is caller-controlled, so computing first and
  // writing the final byte value once produces byte-identical output without
  // needing a reserve/patch primitive (same dodge q2repro.ts's writeFrame
  // documents for its own extraflags byte).
  const enc = encodePlayerStateDelta(params.psFrom ?? new PlayerStateT(), params.psTo);

  // command_byte = svc_frame | ((extraflags & 0xF0) << 1) (q2proto_proto_r1q2.c:1358-1360).
  // extraflags only ever has bits 0-5 set here (EPS_CLIENTNUM/EPS_GUNRATE,
  // bits 6-7, are Q2PRO-only and never computed by encodePlayerStateDelta
  // above), so this can never overflow the byte.
  MSG_WriteByte(msg, SvcOpsT.svc_frame | ((enc.extraflags & 0xf0) << 1));

  const offset = params.lastframe === -1 ? 31 : params.framenum - params.lastframe; // 31: special case (q2proto_proto_r1q2.c:1335-1338)
  const encodedFrame = (params.framenum & 0x07ffffff) | (offset << 27);
  MSG_WriteLong(msg, encodedFrame);

  // suppress_count byte = suppress_count | ((extraflags & 0x0F) << 4) (q2proto_proto_r1q2.c:1361).
  MSG_WriteByte(msg, (params.surpressCount & 0x0f) | ((enc.extraflags & 0x0f) << 4));

  MSG_WriteByte(msg, params.areabytes);
  SZ_Write(msg, params.areabits, params.areabytes);

  MSG_WriteShort(msg, enc.flags);
  enc.writeBody(msg);

  writeEntities(msg);
}

function readFrameHeader(areabits: Uint8Array, _readSuppressByte: boolean): FrameHeaderT {
  const encodedFrame = MSG_ReadLong(net_message);
  const offset = encodedFrame >>> 27; // top 5 bits, unsigned (q2proto_proto_r1q2.c:526-527)
  const serverframe = encodedFrame & 0x07ffffff;
  const deltaframe = offset === 31 ? -1 : serverframe - offset;

  // extraflags = (opcode extrabits >> 1) | ((suppress_count high nibble) >> 4)
  // (q2proto_proto_r1q2.c:534-537); suppress_count itself keeps only its low
  // nibble.
  let extraflags = pendingFrameExtrabits >> 1;
  const suppressByte = MSG_ReadByte(net_message);
  extraflags |= (suppressByte & 0xf0) >> 4;
  pendingFrameExtraflags = extraflags;
  const surpressCount = suppressByte & 0x0f;

  const len = MSG_ReadByte(net_message);
  MSG_ReadData(net_message, areabits, len);

  return { serverframe, deltaframe, surpressCount };
}

function readFramePlayerstate(from: PlayerStateT, to: PlayerStateT): void {
  const flags = MSG_ReadShort(net_message);
  readPlayerStateFields(net_message, from, to, flags, pendingFrameExtraflags);
}

// ---------------------------------------------------------------------------
// client -> server write / server-side read (clc_move)
// ---------------------------------------------------------------------------

// stolen for r1q2 in the name of bandwidth (q2proto_proto_r1q2.c:640-648's
// own comment, preserved). R1Q2-private buttons-byte bits, distinct from
// shared/q_shared.ts's BUTTON_* (those are the game-visible button bits this
// engine already has; these are wire-only compression flags that never reach
// game code).
const BUTTON_UCMD_DBLFORWARD = 1 << 2;
const BUTTON_UCMD_DBLSIDE = 1 << 3;
const BUTTON_UCMD_DBLUP = 1 << 4;
const BUTTON_UCMD_DBL_ANGLE1 = 1 << 5;
const BUTTON_UCMD_DBL_ANGLE2 = 1 << 6;

function makeUsercmdCodec(minorVersion: number) {
  const compressedMovements = minorVersion >= PROTOCOL_VERSION_R1Q2_UCMD;

  // r1q2_client_write_move_delta, q2proto_proto_r1q2.c:650-742.
  function writeDeltaUsercmd(msg: SizeBuf, from: UsercmdT, cmd: UsercmdT): void {
    let bits = 0;
    if (cmd.angles[0] !== from.angles[0]) bits |= 1 << 0; // CM_ANGLE1
    if (cmd.angles[1] !== from.angles[1]) bits |= 1 << 1; // CM_ANGLE2
    if (cmd.angles[2] !== from.angles[2]) bits |= 1 << 2; // CM_ANGLE3
    if (cmd.forwardmove !== from.forwardmove) bits |= 1 << 3; // CM_FORWARD
    if (cmd.sidemove !== from.sidemove) bits |= 1 << 4; // CM_SIDE
    if (cmd.upmove !== from.upmove) bits |= 1 << 5; // CM_UP
    if (cmd.buttons !== from.buttons) bits |= 1 << 6; // CM_BUTTONS
    if (cmd.impulse !== from.impulse) bits |= 1 << 7; // CM_IMPULSE

    MSG_WriteByte(msg, bits);

    let buttons = bits & (1 << 6) ? cmd.buttons : 0;

    if (compressedMovements && bits & (1 << 6)) {
      if (bits & (1 << 3) && cmd.forwardmove % 5 === 0) buttons |= BUTTON_UCMD_DBLFORWARD;
      if (bits & (1 << 4) && cmd.sidemove % 5 === 0) buttons |= BUTTON_UCMD_DBLSIDE;
      if (bits & (1 << 5) && cmd.upmove % 5 === 0) buttons |= BUTTON_UCMD_DBLUP;
      if (bits & (1 << 0) && cmd.angles[0] % 64 === 0 && Math.abs(Math.trunc(cmd.angles[0] / 64)) < 128) buttons |= BUTTON_UCMD_DBL_ANGLE1;
      if (bits & (1 << 1) && cmd.angles[1] % 256 === 0) buttons |= BUTTON_UCMD_DBL_ANGLE2;

      MSG_WriteByte(msg, buttons);
    }

    if (bits & (1 << 0)) {
      if (buttons & BUTTON_UCMD_DBL_ANGLE1) MSG_WriteChar(msg, Math.trunc(cmd.angles[0] / 64));
      else MSG_WriteShort(msg, cmd.angles[0]);
    }
    if (bits & (1 << 1)) {
      if (buttons & BUTTON_UCMD_DBL_ANGLE2) MSG_WriteChar(msg, Math.trunc(cmd.angles[1] / 256));
      else MSG_WriteShort(msg, cmd.angles[1]);
    }
    if (bits & (1 << 2)) MSG_WriteShort(msg, cmd.angles[2]);

    if (bits & (1 << 3)) {
      if (buttons & BUTTON_UCMD_DBLFORWARD) MSG_WriteChar(msg, Math.trunc(cmd.forwardmove / 5));
      else MSG_WriteShort(msg, cmd.forwardmove);
    }
    if (bits & (1 << 4)) {
      if (buttons & BUTTON_UCMD_DBLSIDE) MSG_WriteChar(msg, Math.trunc(cmd.sidemove / 5));
      else MSG_WriteShort(msg, cmd.sidemove);
    }
    if (bits & (1 << 5)) {
      if (buttons & BUTTON_UCMD_DBLUP) MSG_WriteChar(msg, Math.trunc(cmd.upmove / 5));
      else MSG_WriteShort(msg, cmd.upmove);
    }

    if (!compressedMovements && bits & (1 << 6)) MSG_WriteByte(msg, cmd.buttons);
    if (bits & (1 << 7)) MSG_WriteByte(msg, cmd.impulse);

    MSG_WriteByte(msg, cmd.msec);
    MSG_WriteByte(msg, cmd.lightlevel);
  }

  // r1q2 never widens the SERVER's read of an incoming move beyond what
  // vanilla already decodes -- the byte-shortening above is a pure client
  // compression trick the wire format keeps self-describing (the DBL* bits
  // live in the same `buttons` byte vanilla already reads), so the existing
  // generic MSG_ReadDeltaUsercmd cannot be reused as-is (it doesn't know to
  // treat forward/side/up/angle1/angle2 as i8 when compressed_movements is
  // active) -- own implementation mirroring r1q2_server_read_move_delta.
  function readDeltaUsercmd(msg: SizeBuf, from: UsercmdT, move: UsercmdT): void {
    move.msec = from.msec;
    move.buttons = from.buttons;
    move.angles[0] = from.angles[0];
    move.angles[1] = from.angles[1];
    move.angles[2] = from.angles[2];
    move.forwardmove = from.forwardmove;
    move.sidemove = from.sidemove;
    move.upmove = from.upmove;
    move.impulse = from.impulse;
    move.lightlevel = from.lightlevel;

    const bits = MSG_ReadByte(msg);

    // `buttons` here is the RAW wire byte, which -- when compressed movements
    // are active -- has the BUTTON_UCMD_DBL* compression flags OR'd into the
    // real button state. Those flags must be masked back out before the
    // value is a usable buttons value (q2proto_proto_r1q2.c:1518-1520's
    // `move_delta->buttons = buttons & ~(...)`, applied unconditionally at
    // the end, below) -- they are consulted here only to decide field width.
    let buttons = 0;
    if (compressedMovements && bits & (1 << 6)) buttons = MSG_ReadByte(msg);

    if (bits & (1 << 0)) move.angles[0] = buttons & BUTTON_UCMD_DBL_ANGLE1 ? MSG_ReadChar(msg) * 64 : MSG_ReadShort(msg);
    if (bits & (1 << 1)) move.angles[1] = buttons & BUTTON_UCMD_DBL_ANGLE2 ? MSG_ReadChar(msg) * 256 : MSG_ReadShort(msg);
    if (bits & (1 << 2)) move.angles[2] = MSG_ReadShort(msg);

    if (bits & (1 << 3)) move.forwardmove = buttons & BUTTON_UCMD_DBLFORWARD ? MSG_ReadChar(msg) * 5 : MSG_ReadShort(msg);
    if (bits & (1 << 4)) move.sidemove = buttons & BUTTON_UCMD_DBLSIDE ? MSG_ReadChar(msg) * 5 : MSG_ReadShort(msg);
    if (bits & (1 << 5)) move.upmove = buttons & BUTTON_UCMD_DBLUP ? MSG_ReadChar(msg) * 5 : MSG_ReadShort(msg);

    if (!compressedMovements && bits & (1 << 6)) buttons = MSG_ReadByte(msg);
    if (bits & (1 << 7)) move.impulse = MSG_ReadByte(msg);

    move.msec = MSG_ReadByte(msg);
    move.lightlevel = MSG_ReadByte(msg);

    if (bits & (1 << 6)) {
      move.buttons = buttons & ~(BUTTON_UCMD_DBLFORWARD | BUTTON_UCMD_DBLSIDE | BUTTON_UCMD_DBLUP | BUTTON_UCMD_DBL_ANGLE1 | BUTTON_UCMD_DBL_ANGLE2);
    }
  }

  return { writeDeltaUsercmd, readDeltaUsercmd };
}

// ---------------------------------------------------------------------------
// entity-bits prefix (readEntityBits) -- byte-identical to vanilla
// (q2proto_common_client_read_entity_bits is the SAME shared helper vanilla's
// CL_ParseEntityBits ports; R1Q2's own U_MOREBITS4 rejection,
// q2proto_proto_r1q2.c:274-275, is unreachable here since this engine never
// sets that bit on the write side either -- see codec.ts's U_* constant list,
// which has no U_MOREBITS4/4th-extension-byte at all).
// ---------------------------------------------------------------------------

function readEntityBits(): { number: number; bits: number } {
  let total = MSG_ReadByte(net_message);
  if (total & U_MOREBITS1) total |= MSG_ReadByte(net_message) << 8;
  if (total & U_MOREBITS2) total |= MSG_ReadByte(net_message) << 16;
  if (total & U_MOREBITS3) total |= MSG_ReadByte(net_message) << 24;

  let number: number;
  if (total & U_NUMBER16) number = MSG_ReadShort(net_message);
  else number = MSG_ReadByte(net_message);

  return { number, bits: total >>> 0 };
}

// r1q2_server_read_setting (q2proto_proto_r1q2.c:1538-1542): two i16 shorts,
// index then value -- the same shape q2pro.ts and q2repro.ts already read,
// and the opcode this protocol is NAMED after (clc_r1q2_setting, opcode 5).
// A real q2repro client sends it under protocol 35 as soon as it enters the
// game: CL_UpdateGunSetting and CL_UpdateRecordingSetting are both gated on
// `cls.netchan.protocol < PROTOCOL_VERSION_R1Q2` (src/client/main.c:192,
// 270), i.e. they fire for 35 and up. Confirmed live once the qport-width fix
// let protocol 35 reach spawn at all: the first post-spawn packet was
// opcode 5 and sv_user.ts dropped the client with "unknown command char".
//
// There is deliberately NO readBatchMove here. R1Q2 has no batched-move
// opcode: r1q2_server_read (q2proto_proto_r1q2.c:1415-1450) dispatches
// exactly clc_nop, clc_move, clc_userinfo, clc_stringcmd and
// clc_r1q2_setting, and returns Q2P_ERR_BAD_COMMAND for anything else.
// clc_q2pro_move_batched/move_nodelta first appear in q2pro_server_read
// (protocol 36) and q2repro_server_read (1038). All protocol-35 movement
// goes through the three-usercmd clc_move that makeUsercmdCodec's
// readDeltaUsercmd above already decodes, including R1Q2's compressed
// BUTTON_UCMD_DBL* form.
function readClientSetting(msg: SizeBuf): ClcClientSettingT {
  const index = MSG_ReadShort(msg);
  const value = MSG_ReadShort(msg);
  return { index, value };
}

// ---------------------------------------------------------------------------
// factory + default instance
// ---------------------------------------------------------------------------

export function createR1Q2Codec(minorVersion: number): ProtocolCodec {
  const { writeDeltaEntity, readDeltaEntity } = makeEntityDeltaCodec(minorVersion);
  const { writeDeltaUsercmd, readDeltaUsercmd } = makeUsercmdCodec(minorVersion);

  return {
    name: "r1q2",
    writeServerData,
    writeDeltaEntity,
    writeEntityRemove,
    writePacketEntitiesEnd,
    writeSpawnBaseline(msg: SizeBuf, base: EntityStateT): void {
      MSG_WriteByte(msg, SvcOpsT.svc_spawnbaseline);
      writeDeltaEntity(msg, NULL_ENTITY_STATE, base, true, true);
    },
    writePlayerStateDelta,
    writePacketEntitiesBegin,
    writeFrame,
    writeDeltaUsercmd,
    readDeltaUsercmd,
    readServerData,
    readEntityBits,
    readDeltaEntity,
    readPlayerStateDelta,
    readFrameHeader,
    readFramePlayerstate,
    readPacketEntitiesBegin,
    readClientSetting,
  };
}

export const R1Q2_CODEC: ProtocolCodec = createR1Q2Codec(PROTOCOL_VERSION_R1Q2_CURRENT);
