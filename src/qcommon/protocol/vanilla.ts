// Protocol 34 ("vanilla") codec: the wire-encoding behavior our engine has
// always hardcoded, now exposed behind the ProtocolCodec seam (codec.ts).
// See codec.ts's header comment for the full op inventory and what was
// deliberately excluded.
//
// EXTRACTIONS (verbatim cut-paste, flagged per .orch/phase5-design.md's
// instruction to call each one out):
//
//   1. writeEntityRemove / writePacketEntitiesEnd -- the "entity present in
//      the old frame but absent from the new one" branch and the
//      packetentities terminator, both previously inlined in
//      src/server/sv_ents.ts's SV_EmitPacketEntities.
//   2. writePlayerStateDelta -- the full body of src/server/sv_ents.ts's
//      (private, unexported) SV_WritePlayerstateToClient. Adapted to take
//      the two PlayerStateT values directly instead of the ClientFrameT
//      wrappers SV_WritePlayerstateToClient took; the `ops = from ? from.ps
//      : new PlayerStateT()` null-coalescing that used to live inside the
//      function now happens at the sv_ents.ts call site instead (equivalent:
//      the value passed in is identical either way).
//   3. readEntityBits / readDeltaEntity -- the full bodies of
//      src/client/cl_ents.ts's (exported) CL_ParseEntityBits and
//      CL_ParseDelta, including CL_ParseEntityBits's file-local `bitcounts`
//      profiling counter (nothing outside that function ever read it).
//      cl_ents.ts's CL_ParseEntityBits/CL_ParseDelta become thin delegators
//      to `cls.codec` so the existing test suite's direct imports
//      (test/cl_parse.test.ts) keep working unchanged.
//   4. readPlayerStateDelta -- the full body of src/client/cl_ents.ts's
//      (private) CL_ParsePlayerstate, MINUS the `cl.attractloop -> PM_FREEZE`
//      override and MINUS the oldframe-null branching. The attractloop
//      override is not wire decoding (it doesn't consume bytes; it just
//      stomps a value after the fact) and depends on the client's global
//      `cl` singleton, which this codec module does not import, so it stays
//      in cl_ents.ts's CL_ParsePlayerstate wrapper, applied immediately after
//      this function returns. Verified behavior-preserving: nothing later in
//      the original function body ever read pmove.pm_type back, so moving
//      the override to "right after the read finishes" instead of "partway
//      through it" cannot change the final PlayerStateT contents.
//      The oldframe-null branch's `copyPlayerState(target, oldframe.ps)` step
//      moves inside this function (called unconditionally on `from`/`to`);
//      when there was no oldframe, the original skipped the copy and used a
//      fresh `new PlayerStateT()` as target, which is behaviorally identical
//      to copying one freshly-defaulted PlayerStateT onto another (every
//      field is already at its zero/default value on both sides).
//
// WRAPPED, NOT MOVED (call the existing standalone function unchanged):
//   writeDeltaEntity    -> qcommon/sizebuf.ts MSG_WriteDeltaEntity
//   writeDeltaUsercmd   -> qcommon/sizebuf.ts MSG_WriteDeltaUsercmd
//   readDeltaUsercmd    -> qcommon/sizebuf.ts MSG_ReadDeltaUsercmd
//
// This module deliberately imports nothing from src/server/server.ts or
// src/client/client.ts (only qcommon-layer leaves: sizebuf.ts, qcommon.ts,
// net_chan.ts, and shared/q_shared.ts + shared/math.ts) so that
// server.ts/client.ts can import VANILLA_CODEC as their default `codec`
// field without an import cycle back through this file.

import type { SizeBuf } from "../sizebuf";
import {
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteString,
  MSG_WriteAngle16,
  MSG_WriteDeltaEntity,
  MSG_WriteDeltaUsercmd,
  MSG_ReadDeltaUsercmd,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadChar,
  MSG_ReadAngle,
  MSG_ReadAngle16,
  MSG_ReadCoord,
  MSG_ReadPos,
} from "../sizebuf";
import { PROTOCOL_VERSION } from "../qcommon";
import {
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
import { EntityStateT, PlayerStateT, type UsercmdT, MAX_STATS } from "../../shared/q_shared";
import { VectorCopy } from "../../shared/math";
import type { ProtocolCodec, ServerDataParamsT } from "./codec";

// Reused across writeSpawnBaseline calls (MSG_WriteDeltaEntity only ever
// reads `from`'s fields, never writes them, so one shared zero-valued
// instance is safe -- matches sv_user.ts's/cl_main.ts's original call sites,
// each of which allocated their own single `nullstate` outside a loop and
// reused it across iterations).
const NULL_ENTITY_STATE = new EntityStateT();

// ---------------------------------------------------------------------------
// server -> client writes
// ---------------------------------------------------------------------------

// Extracted verbatim (byte-for-byte) from src/server/sv_user.ts's SV_New_f --
// the six MSG_Write* calls that used to write the svc_serverdata message
// inline. q2repro-only ServerDataParamsT fields (serverState) are simply
// unread here, matching protocol 34's handshake shape exactly.
function writeServerData(msg: SizeBuf, params: ServerDataParamsT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_serverdata);
  MSG_WriteLong(msg, PROTOCOL_VERSION);
  MSG_WriteLong(msg, params.servercount);
  MSG_WriteByte(msg, params.attractloop ? 1 : 0);
  MSG_WriteString(msg, params.gamedir);
  MSG_WriteShort(msg, params.clientnum);
  MSG_WriteString(msg, params.levelname);
}

function writeDeltaEntity(msg: SizeBuf, from: EntityStateT, to: EntityStateT, force: boolean, newentity: boolean): void {
  MSG_WriteDeltaEntity(from, to, msg, force, newentity);
}

// Extracted from src/server/sv_ents.ts's SV_EmitPacketEntities (the
// "oldnum isn't present in the new message" branch).
function writeEntityRemove(msg: SizeBuf, oldnum: number): void {
  let bits = U_REMOVE;
  if (oldnum >= 256) bits |= U_NUMBER16 | U_MOREBITS1;

  MSG_WriteByte(msg, bits & 255);
  if (bits & 0x0000ff00) MSG_WriteByte(msg, (bits >> 8) & 255);

  if (bits & U_NUMBER16) MSG_WriteShort(msg, oldnum);
  else MSG_WriteByte(msg, oldnum);
}

// Extracted from src/server/sv_ents.ts's SV_EmitPacketEntities (the trailing
// `MSG_WriteShort(msg, 0)` after the diff loop).
function writePacketEntitiesEnd(msg: SizeBuf): void {
  MSG_WriteShort(msg, 0);
}

// Extracted from the two-line pattern duplicated in src/server/sv_user.ts's
// SV_Baselines_f and src/client/cl_main.ts's demo-serverdata writer.
function writeSpawnBaseline(msg: SizeBuf, base: EntityStateT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_spawnbaseline);
  MSG_WriteDeltaEntity(NULL_ENTITY_STATE, base, msg, true, true);
}

// Extracted verbatim from src/server/sv_ents.ts's (private)
// SV_WritePlayerstateToClient -- see this file's header comment for the
// from/to vs ClientFrameT adaptation note.
function writePlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  const ps = to;
  const ops = from;

  let pflags = 0;

  if (ps.pmove.pm_type !== ops.pmove.pm_type) pflags |= PS_M_TYPE;

  if (ps.pmove.origin[0] !== ops.pmove.origin[0] || ps.pmove.origin[1] !== ops.pmove.origin[1] || ps.pmove.origin[2] !== ops.pmove.origin[2])
    pflags |= PS_M_ORIGIN;

  if (
    ps.pmove.velocity[0] !== ops.pmove.velocity[0] ||
    ps.pmove.velocity[1] !== ops.pmove.velocity[1] ||
    ps.pmove.velocity[2] !== ops.pmove.velocity[2]
  )
    pflags |= PS_M_VELOCITY;

  if (ps.pmove.pm_time !== ops.pmove.pm_time) pflags |= PS_M_TIME;

  if (ps.pmove.pm_flags !== ops.pmove.pm_flags) pflags |= PS_M_FLAGS;

  if (ps.pmove.gravity !== ops.pmove.gravity) pflags |= PS_M_GRAVITY;

  if (
    ps.pmove.delta_angles[0] !== ops.pmove.delta_angles[0] ||
    ps.pmove.delta_angles[1] !== ops.pmove.delta_angles[1] ||
    ps.pmove.delta_angles[2] !== ops.pmove.delta_angles[2]
  )
    pflags |= PS_M_DELTA_ANGLES;

  if (ps.viewoffset[0] !== ops.viewoffset[0] || ps.viewoffset[1] !== ops.viewoffset[1] || ps.viewoffset[2] !== ops.viewoffset[2])
    pflags |= PS_VIEWOFFSET;

  if (ps.viewangles[0] !== ops.viewangles[0] || ps.viewangles[1] !== ops.viewangles[1] || ps.viewangles[2] !== ops.viewangles[2])
    pflags |= PS_VIEWANGLES;

  if (ps.kick_angles[0] !== ops.kick_angles[0] || ps.kick_angles[1] !== ops.kick_angles[1] || ps.kick_angles[2] !== ops.kick_angles[2])
    pflags |= PS_KICKANGLES;

  if (
    ps.blend[0] !== ops.blend[0] ||
    ps.blend[1] !== ops.blend[1] ||
    ps.blend[2] !== ops.blend[2] ||
    ps.blend[3] !== ops.blend[3]
  )
    pflags |= PS_BLEND;

  if (ps.fov !== ops.fov) pflags |= PS_FOV;

  if (ps.rdflags !== ops.rdflags) pflags |= PS_RDFLAGS;

  if (ps.gunframe !== ops.gunframe) pflags |= PS_WEAPONFRAME;

  pflags |= PS_WEAPONINDEX;

  //
  // write it
  //
  MSG_WriteByte(msg, SvcOpsT.svc_playerinfo);
  MSG_WriteShort(msg, pflags);

  //
  // write the pmove_state_t
  //
  if (pflags & PS_M_TYPE) MSG_WriteByte(msg, ps.pmove.pm_type);

  if (pflags & PS_M_ORIGIN) {
    MSG_WriteShort(msg, ps.pmove.origin[0]);
    MSG_WriteShort(msg, ps.pmove.origin[1]);
    MSG_WriteShort(msg, ps.pmove.origin[2]);
  }

  if (pflags & PS_M_VELOCITY) {
    MSG_WriteShort(msg, ps.pmove.velocity[0]);
    MSG_WriteShort(msg, ps.pmove.velocity[1]);
    MSG_WriteShort(msg, ps.pmove.velocity[2]);
  }

  if (pflags & PS_M_TIME) MSG_WriteByte(msg, ps.pmove.pm_time);

  if (pflags & PS_M_FLAGS) MSG_WriteByte(msg, ps.pmove.pm_flags);

  if (pflags & PS_M_GRAVITY) MSG_WriteShort(msg, ps.pmove.gravity);

  if (pflags & PS_M_DELTA_ANGLES) {
    MSG_WriteShort(msg, ps.pmove.delta_angles[0]);
    MSG_WriteShort(msg, ps.pmove.delta_angles[1]);
    MSG_WriteShort(msg, ps.pmove.delta_angles[2]);
  }

  //
  // write the rest of the player_state_t
  //
  if (pflags & PS_VIEWOFFSET) {
    MSG_WriteChar(msg, ps.viewoffset[0] * 4);
    MSG_WriteChar(msg, ps.viewoffset[1] * 4);
    MSG_WriteChar(msg, ps.viewoffset[2] * 4);
  }

  if (pflags & PS_VIEWANGLES) {
    MSG_WriteAngle16(msg, ps.viewangles[0]);
    MSG_WriteAngle16(msg, ps.viewangles[1]);
    MSG_WriteAngle16(msg, ps.viewangles[2]);
  }

  if (pflags & PS_KICKANGLES) {
    MSG_WriteChar(msg, ps.kick_angles[0] * 4);
    MSG_WriteChar(msg, ps.kick_angles[1] * 4);
    MSG_WriteChar(msg, ps.kick_angles[2] * 4);
  }

  if (pflags & PS_WEAPONINDEX) {
    MSG_WriteByte(msg, ps.gunindex);
  }

  if (pflags & PS_WEAPONFRAME) {
    MSG_WriteByte(msg, ps.gunframe);
    MSG_WriteChar(msg, ps.gunoffset[0] * 4);
    MSG_WriteChar(msg, ps.gunoffset[1] * 4);
    MSG_WriteChar(msg, ps.gunoffset[2] * 4);
    MSG_WriteChar(msg, ps.gunangles[0] * 4);
    MSG_WriteChar(msg, ps.gunangles[1] * 4);
    MSG_WriteChar(msg, ps.gunangles[2] * 4);
  }

  if (pflags & PS_BLEND) {
    MSG_WriteByte(msg, ps.blend[0] * 255);
    MSG_WriteByte(msg, ps.blend[1] * 255);
    MSG_WriteByte(msg, ps.blend[2] * 255);
    MSG_WriteByte(msg, ps.blend[3] * 255);
  }
  if (pflags & PS_FOV) MSG_WriteByte(msg, ps.fov);
  if (pflags & PS_RDFLAGS) MSG_WriteByte(msg, ps.rdflags);

  // send stats
  let statbits = 0;
  for (let i = 0; i < MAX_STATS; i++) if (ps.stats[i] !== ops.stats[i]) statbits |= 1 << i;
  MSG_WriteLong(msg, statbits);
  for (let i = 0; i < MAX_STATS; i++) if (statbits & (1 << i)) MSG_WriteShort(msg, ps.stats[i]);
}

// ---------------------------------------------------------------------------
// client -> server write / server-side read
// ---------------------------------------------------------------------------

function writeDeltaUsercmd(msg: SizeBuf, from: UsercmdT, cmd: UsercmdT): void {
  MSG_WriteDeltaUsercmd(msg, from, cmd);
}

function readDeltaUsercmd(msg: SizeBuf, from: UsercmdT, move: UsercmdT): void {
  MSG_ReadDeltaUsercmd(msg, from, move);
}

// ---------------------------------------------------------------------------
// client-side reads (net_message singleton -- see codec.ts's asymmetry note)
// ---------------------------------------------------------------------------

// Extracted verbatim from src/client/cl_ents.ts's CL_ParseEntityBits,
// including its file-local bit-count profiling counter.
const bitcounts = new Int32Array(32); // just for protocol profiling

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

  // count the bits for net profiling
  for (let i = 0; i < 32; i++) if (total & (1 << i)) bitcounts[i]++;

  let number: number;
  if (total & U_NUMBER16) number = MSG_ReadShort(net_message);
  else number = MSG_ReadByte(net_message);

  return { number, bits: total >>> 0 };
}

// Duplicated struct-copy helper (same rationale as cl_ents.ts's own private
// copy: "sv_ents.ts/sv_init.ts each keep a private unexported copy of the
// same field set; duplicated here for the same reason").
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

// Extracted verbatim from src/client/cl_ents.ts's CL_ParseDelta.
function readDeltaEntity(from: EntityStateT, to: EntityStateT, number: number, bits: number): void {
  // set everything to the state we are delta'ing from
  copyEntityState(to, from);

  VectorCopy(from.origin, to.old_origin);
  to.number = number;

  if (bits & U_MODEL) to.modelindex = MSG_ReadByte(net_message);
  if (bits & U_MODEL2) to.modelindex2 = MSG_ReadByte(net_message);
  if (bits & U_MODEL3) to.modelindex3 = MSG_ReadByte(net_message);
  if (bits & U_MODEL4) to.modelindex4 = MSG_ReadByte(net_message);

  if (bits & U_FRAME8) to.frame = MSG_ReadByte(net_message);
  if (bits & U_FRAME16) to.frame = MSG_ReadShort(net_message);

  if (bits & U_SKIN8 && bits & U_SKIN16)
    // used for laser colors
    to.skinnum = MSG_ReadLong(net_message);
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

  if (bits & U_SOLID) to.solid = MSG_ReadShort(net_message);
}

// Duplicated struct-copy helper (same rationale as copyEntityState above);
// mirrors cl_ents.ts's private copyPlayerState -- a deliberate SUBSET of
// PlayerStateT's fields (the ones protocol 34 actually transmits/predicts),
// not shared/state_copy.ts's clonePlayerState (which also carries the newer
// KEX-only fields that have no wire representation here).
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

// Extracted from src/client/cl_ents.ts's (private) CL_ParsePlayerstate --
// see this file's header comment for the attractloop/copy adaptation note.
function readPlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  copyPlayerStateFields(to, from);

  const target = to;
  const flags = MSG_ReadShort(msg);

  //
  // parse the pmove_state_t
  //
  if (flags & PS_M_TYPE) target.pmove.pm_type = MSG_ReadByte(msg);

  if (flags & PS_M_ORIGIN) {
    target.pmove.origin[0] = MSG_ReadShort(msg);
    target.pmove.origin[1] = MSG_ReadShort(msg);
    target.pmove.origin[2] = MSG_ReadShort(msg);
  }

  if (flags & PS_M_VELOCITY) {
    target.pmove.velocity[0] = MSG_ReadShort(msg);
    target.pmove.velocity[1] = MSG_ReadShort(msg);
    target.pmove.velocity[2] = MSG_ReadShort(msg);
  }

  if (flags & PS_M_TIME) target.pmove.pm_time = MSG_ReadByte(msg);

  if (flags & PS_M_FLAGS) target.pmove.pm_flags = MSG_ReadByte(msg);

  if (flags & PS_M_GRAVITY) target.pmove.gravity = MSG_ReadShort(msg);

  if (flags & PS_M_DELTA_ANGLES) {
    target.pmove.delta_angles[0] = MSG_ReadShort(msg);
    target.pmove.delta_angles[1] = MSG_ReadShort(msg);
    target.pmove.delta_angles[2] = MSG_ReadShort(msg);
  }

  // NOTE: cl.attractloop's `target.pmove.pm_type = PmTypeT.PM_FREEZE` demo-
  // playback override is applied by the caller (cl_ents.ts's
  // CL_ParsePlayerstate) immediately after this function returns -- see this
  // file's header comment for why, and codec.ts's readPlayerStateDelta doc
  // comment for the interface-level note.

  //
  // parse the rest of the player_state_t
  //
  if (flags & PS_VIEWOFFSET) {
    target.viewoffset[0] = MSG_ReadChar(msg) * 0.25;
    target.viewoffset[1] = MSG_ReadChar(msg) * 0.25;
    target.viewoffset[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (flags & PS_VIEWANGLES) {
    target.viewangles[0] = MSG_ReadAngle16(msg);
    target.viewangles[1] = MSG_ReadAngle16(msg);
    target.viewangles[2] = MSG_ReadAngle16(msg);
  }

  if (flags & PS_KICKANGLES) {
    target.kick_angles[0] = MSG_ReadChar(msg) * 0.25;
    target.kick_angles[1] = MSG_ReadChar(msg) * 0.25;
    target.kick_angles[2] = MSG_ReadChar(msg) * 0.25;
  }

  if (flags & PS_WEAPONINDEX) {
    target.gunindex = MSG_ReadByte(msg);
  }

  if (flags & PS_WEAPONFRAME) {
    target.gunframe = MSG_ReadByte(msg);
    target.gunoffset[0] = MSG_ReadChar(msg) * 0.25;
    target.gunoffset[1] = MSG_ReadChar(msg) * 0.25;
    target.gunoffset[2] = MSG_ReadChar(msg) * 0.25;
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

  // parse stats
  const statbits = MSG_ReadLong(msg);
  for (let i = 0; i < MAX_STATS; i++) if (statbits & (1 << i)) target.stats[i] = MSG_ReadShort(msg);
}

export const VANILLA_CODEC: ProtocolCodec = {
  name: "vanilla",
  writeServerData,
  writeDeltaEntity,
  writeEntityRemove,
  writePacketEntitiesEnd,
  writeSpawnBaseline,
  writePlayerStateDelta,
  writeDeltaUsercmd,
  readDeltaUsercmd,
  readEntityBits,
  readDeltaEntity,
  readPlayerStateDelta,
};
