// cl_ents.c -- entity parsing and management

import { type Vec3, VectorCopy, VectorMA, AngleVectors, LerpAngle, anglemod } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  EntityStateT,
  PlayerStateT,
  PmTypeT,
  MAX_EDICTS,
  MAX_STATS,
  PMF_NO_PREDICTION,
  VIDREF_GL,
  EntityEventT,
  EF_TELEPORTER,
  EF_ROTATE,
  EF_GIB,
  EF_BLASTER,
  EF_ROCKET,
  EF_GRENADE,
  EF_HYPERBLASTER,
  EF_BFG,
  EF_COLOR_SHELL,
  EF_POWERSCREEN,
  EF_ANIM01,
  EF_ANIM23,
  EF_ANIM_ALL,
  EF_ANIM_ALLFAST,
  EF_FLIES,
  EF_QUAD,
  EF_PENT,
  EF_FLAG1,
  EF_FLAG2,
  EF_IONRIPPER,
  EF_GREENGIB,
  EF_BLUEHYPERBLASTER,
  EF_SPINNINGLIGHTS,
  EF_PLASMA,
  EF_TRAP,
  EF_TRACKER,
  EF_DOUBLE,
  EF_SPHERETRANS,
  EF_TAGTRAIL,
  EF_HALF_DAMAGE,
  EF_TRACKERTRAIL,
  RF_MINLIGHT,
  RF_VIEWERMODEL,
  RF_WEAPONMODEL,
  RF_DEPTHHACK,
  RF_TRANSLUCENT,
  RF_FRAMELERP,
  RF_BEAM,
  RF_SHELL_RED,
  RF_SHELL_GREEN,
  RF_SHELL_BLUE,
  RF_SHELL_DOUBLE,
  RF_SHELL_HALF_DAM,
  CS_PLAYERSKINS,
  CS_MODELS,
  Q_strcasecmp,
} from "../shared/q_shared";
import type { ModelS } from "./ref";
import { EntityT } from "./ref";
import { cl, cls, ConnstateT, cl_entities, cl_parse_entities, MAX_PARSE_ENTITIES, FrameT, clCvars, gun_frame, gun_model, MAX_CLIENTWEAPONMODELS, re, svc_strings } from "./client";
import { net_message } from "../qcommon/net_chan";
import { MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadChar, MSG_ReadCoord, MSG_ReadAngle, MSG_ReadAngle16, MSG_ReadPos, MSG_ReadData } from "../qcommon/sizebuf";
import {
  SvcOpsT,
  UPDATE_MASK,
  ERR_DROP,
  U_MOREBITS1,
  U_MOREBITS2,
  U_MOREBITS3,
  U_NUMBER16,
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
  U_REMOVE,
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
} from "../qcommon/qcommon";
import { Com_Error, Com_Printf } from "../qcommon/common";
import { SHOWNET } from "./cl_parse";
import {
  CL_RocketTrail,
  CL_DiminishingTrail,
  CL_FlyEffect,
  CL_BfgParticles,
  CL_TrapParticles,
  CL_FlagTrail,
  CL_EntityEvent,
  CL_TeleporterParticles,
  CL_IonripperTrail,
  CL_BlasterTrail,
  CL_AddParticles,
  CL_AddDLights,
  CL_AddLightStyles,
} from "./cl_fx";
import { CL_TrackerTrail, CL_Tracker_Shell, CL_TagTrail, CL_BlasterTrail2 } from "./cl_newfx";
import { CL_AddTEnts } from "./cl_tent";
import { CL_CheckPredictionError } from "./cl_pred";
import { V_AddEntity, V_AddLight } from "./cl_view";
import { SCR_EndLoadingPlaque } from "./cl_scrn";
import { Developer_searchpath } from "../qcommon/files";

//PGM -- extern in game/q_shared.h, defined here (confirmed by grep of the
// full v3.19 tree); set by win32/vid_dll.c, which per PORTING.md's platform
// mapping is not ported (only src/platform/vid.ts would be, and that module
// does not exist yet) -- reported gap. Stays 0 (VIDREF_OTHER's absence)
// until a future platform/vid.ts wires up the setter.
export let vidref_val = 0;
export function setVidrefVal(v: number): void {
  vidref_val = v;
}

// extern in cl_ents.c, defined in cl_tent.c (CL_RegisterTEntModels). That
// module is still a pending stub with no export for this symbol and is out
// of this unit's SCOPE -- reported gap; kept here (with a setter, mirroring
// client.ts's gun_frame/gun_model pattern) until cl_tent.ts is ported for
// real and can call setClModPowerscreen from CL_RegisterTEntModels.
export let cl_mod_powerscreen: ModelS | null = null;
export function setClModPowerscreen(v: ModelS | null): void {
  cl_mod_powerscreen = v;
}

/*
=================
CL_ParseEntityBits

Returns the entity number and the header bits
=================
*/
const bitcounts = new Int32Array(32); // just for protocol profiling

export function CL_ParseEntityBits(): { number: number; bits: number } {
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

// struct-copy helper (PORTING.md: "struct copies need explicit clone
// helpers"). sv_ents.ts/sv_init.ts each keep a private unexported copy of
// the same field set; duplicated here for the same reason.
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

/*
==================
CL_ParseDelta

Can go from either a baseline or a previous packet_entity
==================
*/
export function CL_ParseDelta(from: EntityStateT, to: EntityStateT, number: number, bits: number): void {
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

// C's abs() takes an int; passing float origin deltas to it implicitly
// truncates toward zero before taking the absolute value. Preserved
// bug-for-bug rather than using a float-precision Math.abs.
function absInt(x: number): number {
  return Math.abs(Math.trunc(x));
}

/*
==================
CL_DeltaEntity

Parses deltas from the given base and adds the resulting entity
to the current frame
==================
*/
function CL_DeltaEntity(frame: FrameT, newnum: number, old: EntityStateT, bits: number): void {
  const ent = cl_entities[newnum];

  const state = cl_parse_entities[cl.parse_entities & (MAX_PARSE_ENTITIES - 1)];
  cl.parse_entities++;
  frame.num_entities++;

  CL_ParseDelta(old, state, newnum, bits);

  // some data changes will force no lerping
  if (
    state.modelindex !== ent.current.modelindex ||
    state.modelindex2 !== ent.current.modelindex2 ||
    state.modelindex3 !== ent.current.modelindex3 ||
    state.modelindex4 !== ent.current.modelindex4 ||
    absInt(state.origin[0] - ent.current.origin[0]) > 512 ||
    absInt(state.origin[1] - ent.current.origin[1]) > 512 ||
    absInt(state.origin[2] - ent.current.origin[2]) > 512 ||
    state.event === EntityEventT.EV_PLAYER_TELEPORT ||
    state.event === EntityEventT.EV_OTHER_TELEPORT
  ) {
    ent.serverframe = -99;
  }

  if (ent.serverframe !== cl.frame.serverframe - 1) {
    // wasn't in last update, so initialize some things
    ent.trailcount = 1024; // for diminishing rocket / grenade trails
    // duplicate the current state so lerping doesn't hurt anything
    copyEntityState(ent.prev, state);
    if (state.event === EntityEventT.EV_OTHER_TELEPORT) {
      VectorCopy(state.origin, ent.prev.origin);
      VectorCopy(state.origin, ent.lerp_origin);
    } else {
      VectorCopy(state.old_origin, ent.prev.origin);
      VectorCopy(state.old_origin, ent.lerp_origin);
    }
  } else {
    // shuffle the last state to previous
    copyEntityState(ent.prev, ent.current);
  }

  ent.serverframe = cl.frame.serverframe;
  copyEntityState(ent.current, state);
}

/*
==================
CL_ParsePacketEntities

An svc_packetentities has just been parsed, deal with the
rest of the data stream.
==================
*/
function CL_ParsePacketEntities(oldframe: FrameT | null, newframe: FrameT): void {
  newframe.parse_entities = cl.parse_entities;
  newframe.num_entities = 0;

  // delta from the entities present in oldframe
  let oldindex = 0;
  let oldstate: EntityStateT | null = null;
  let oldnum: number;
  if (!oldframe) {
    oldnum = 99999;
  } else if (oldindex >= oldframe.num_entities) {
    oldnum = 99999;
  } else {
    oldstate = cl_parse_entities[(oldframe.parse_entities + oldindex) & (MAX_PARSE_ENTITIES - 1)];
    oldnum = oldstate.number;
  }

  // repeated four times verbatim in the original; folded into one helper
  // (mirrors PORTING.md's "goto -> restructure" idiom, not an algorithm change)
  function advanceOld(): void {
    oldindex++;
    if (!oldframe || oldindex >= oldframe.num_entities) {
      oldnum = 99999;
      oldstate = null;
    } else {
      oldstate = cl_parse_entities[(oldframe.parse_entities + oldindex) & (MAX_PARSE_ENTITIES - 1)];
      oldnum = oldstate.number;
    }
  }

  for (;;) {
    const { number: newnum, bits } = CL_ParseEntityBits();
    if (newnum >= MAX_EDICTS) {
      Com_Error(ERR_DROP, "CL_ParsePacketEntities: bad number:%i", newnum);
    }

    if (net_message.readcount > net_message.cursize) {
      Com_Error(ERR_DROP, "CL_ParsePacketEntities: end of message");
    }

    if (!newnum) break;

    while (oldnum < newnum) {
      // one or more entities from the old packet are unchanged
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   unchanged: %i\n", oldnum);
      if (oldstate) CL_DeltaEntity(newframe, oldnum, oldstate, 0);

      advanceOld();
    }

    if (bits & U_REMOVE) {
      // the entity present in oldframe is not in the current frame
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   remove: %i\n", newnum);
      if (oldnum !== newnum) Com_Printf("U_REMOVE: oldnum != newnum\n");

      advanceOld();
      continue;
    }

    if (oldnum === newnum) {
      // delta from previous state
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   delta: %i\n", newnum);
      if (oldstate) CL_DeltaEntity(newframe, newnum, oldstate, bits);

      advanceOld();
      continue;
    }

    if (oldnum > newnum) {
      // delta from baseline
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   baseline: %i\n", newnum);
      CL_DeltaEntity(newframe, newnum, cl_entities[newnum].baseline, bits);
      continue;
    }
  }

  // any remaining entities in the old frame are copied over
  while (oldnum !== 99999) {
    // one or more entities from the old packet are unchanged
    if (clCvars.cl_shownet?.value === 3) Com_Printf("   unchanged: %i\n", oldnum);
    if (oldstate) CL_DeltaEntity(newframe, oldnum, oldstate, 0);

    advanceOld();
  }
}

// struct-copy helper for player_state_t (mirrors sv_ents.ts's
// clonePlayerState, but copies into an existing destination rather than
// allocating a new one).
function copyPlayerState(dst: PlayerStateT, src: PlayerStateT): void {
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

/*
===================
CL_ParsePlayerstate
===================
*/
function CL_ParsePlayerstate(oldframe: FrameT | null, newframe: FrameT): void {
  // clear to old value before delta parsing
  let target: PlayerStateT;
  if (oldframe) {
    target = newframe.playerstate;
    copyPlayerState(target, oldframe.playerstate);
  } else {
    target = new PlayerStateT();
    newframe.playerstate = target;
  }

  const flags = MSG_ReadShort(net_message);

  //
  // parse the pmove_state_t
  //
  if (flags & PS_M_TYPE) target.pmove.pm_type = MSG_ReadByte(net_message);

  if (flags & PS_M_ORIGIN) {
    target.pmove.origin[0] = MSG_ReadShort(net_message);
    target.pmove.origin[1] = MSG_ReadShort(net_message);
    target.pmove.origin[2] = MSG_ReadShort(net_message);
  }

  if (flags & PS_M_VELOCITY) {
    target.pmove.velocity[0] = MSG_ReadShort(net_message);
    target.pmove.velocity[1] = MSG_ReadShort(net_message);
    target.pmove.velocity[2] = MSG_ReadShort(net_message);
  }

  if (flags & PS_M_TIME) target.pmove.pm_time = MSG_ReadByte(net_message);

  if (flags & PS_M_FLAGS) target.pmove.pm_flags = MSG_ReadByte(net_message);

  if (flags & PS_M_GRAVITY) target.pmove.gravity = MSG_ReadShort(net_message);

  if (flags & PS_M_DELTA_ANGLES) {
    target.pmove.delta_angles[0] = MSG_ReadShort(net_message);
    target.pmove.delta_angles[1] = MSG_ReadShort(net_message);
    target.pmove.delta_angles[2] = MSG_ReadShort(net_message);
  }

  if (cl.attractloop) target.pmove.pm_type = PmTypeT.PM_FREEZE; // demo playback

  //
  // parse the rest of the player_state_t
  //
  if (flags & PS_VIEWOFFSET) {
    target.viewoffset[0] = MSG_ReadChar(net_message) * 0.25;
    target.viewoffset[1] = MSG_ReadChar(net_message) * 0.25;
    target.viewoffset[2] = MSG_ReadChar(net_message) * 0.25;
  }

  if (flags & PS_VIEWANGLES) {
    target.viewangles[0] = MSG_ReadAngle16(net_message);
    target.viewangles[1] = MSG_ReadAngle16(net_message);
    target.viewangles[2] = MSG_ReadAngle16(net_message);
  }

  if (flags & PS_KICKANGLES) {
    target.kick_angles[0] = MSG_ReadChar(net_message) * 0.25;
    target.kick_angles[1] = MSG_ReadChar(net_message) * 0.25;
    target.kick_angles[2] = MSG_ReadChar(net_message) * 0.25;
  }

  if (flags & PS_WEAPONINDEX) {
    target.gunindex = MSG_ReadByte(net_message);
  }

  if (flags & PS_WEAPONFRAME) {
    target.gunframe = MSG_ReadByte(net_message);
    target.gunoffset[0] = MSG_ReadChar(net_message) * 0.25;
    target.gunoffset[1] = MSG_ReadChar(net_message) * 0.25;
    target.gunoffset[2] = MSG_ReadChar(net_message) * 0.25;
    target.gunangles[0] = MSG_ReadChar(net_message) * 0.25;
    target.gunangles[1] = MSG_ReadChar(net_message) * 0.25;
    target.gunangles[2] = MSG_ReadChar(net_message) * 0.25;
  }

  if (flags & PS_BLEND) {
    target.blend[0] = MSG_ReadByte(net_message) / 255.0;
    target.blend[1] = MSG_ReadByte(net_message) / 255.0;
    target.blend[2] = MSG_ReadByte(net_message) / 255.0;
    target.blend[3] = MSG_ReadByte(net_message) / 255.0;
  }

  if (flags & PS_FOV) target.fov = MSG_ReadByte(net_message);

  if (flags & PS_RDFLAGS) target.rdflags = MSG_ReadByte(net_message);

  // parse stats
  const statbits = MSG_ReadLong(net_message);
  for (let i = 0; i < MAX_STATS; i++) if (statbits & (1 << i)) target.stats[i] = MSG_ReadShort(net_message);
}

/*
==================
CL_FireEntityEvents
==================
*/
function CL_FireEntityEvents(frame: FrameT): void {
  for (let pnum = 0; pnum < frame.num_entities; pnum++) {
    const num = (frame.parse_entities + pnum) & (MAX_PARSE_ENTITIES - 1);
    const s1 = cl_parse_entities[num];
    if (s1.event) CL_EntityEvent(s1);

    // EF_TELEPORTER acts like an event, but is not cleared each frame
    if (s1.effects & EF_TELEPORTER) CL_TeleporterParticles(s1);
  }
}

/*
================
CL_ParseFrame
================
*/
export function CL_ParseFrame(): void {
  // memset(&cl.frame, 0, sizeof(cl.frame)) -- cl.frame may be aliased into
  // cl.frames[] from a previous call, so it is replaced with a fresh
  // instance rather than mutated in place (mirrors ClStateT.clear()'s same
  // convention for the identical reason).
  cl.frame = new FrameT();

  cl.frame.serverframe = MSG_ReadLong(net_message);
  cl.frame.deltaframe = MSG_ReadLong(net_message);
  cl.frame.servertime = cl.frame.serverframe * 100;

  // BIG HACK to let old demos continue to work
  if (cls.serverProtocol !== 26) cl.surpressCount = MSG_ReadByte(net_message);

  if (clCvars.cl_shownet?.value === 3) Com_Printf("   frame:%i  delta:%i\n", cl.frame.serverframe, cl.frame.deltaframe);

  // If the frame is delta compressed from data that we
  // no longer have available, we must suck up the rest of
  // the frame, but not use it, then ask for a non-compressed
  // message
  let old: FrameT | null;
  if (cl.frame.deltaframe <= 0) {
    cl.frame.valid = true; // uncompressed frame
    old = null;
    cls.demowaiting = false; // we can start recording now
  } else {
    old = cl.frames[cl.frame.deltaframe & UPDATE_MASK];
    if (!old.valid) {
      // should never happen
      Com_Printf("Delta from invalid frame (not supposed to happen!).\n");
    }
    if (old.serverframe !== cl.frame.deltaframe) {
      // The frame that the server did the delta from
      // is too old, so we can't reconstruct it properly.
      Com_Printf("Delta frame too old.\n");
    } else if (cl.parse_entities - old.parse_entities > MAX_PARSE_ENTITIES - 128) {
      Com_Printf("Delta parse_entities too old.\n");
    } else {
      cl.frame.valid = true; // valid delta parse
    }
  }

  // clamp time
  if (cl.time > cl.frame.servertime) cl.time = cl.frame.servertime;
  else if (cl.time < cl.frame.servertime - 100) cl.time = cl.frame.servertime - 100;

  // read areabits
  const len = MSG_ReadByte(net_message);
  MSG_ReadData(net_message, cl.frame.areabits, len);

  // read playerinfo
  let cmd = MSG_ReadByte(net_message);
  SHOWNET(svc_strings[cmd] ?? "");
  if (cmd !== SvcOpsT.svc_playerinfo) Com_Error(ERR_DROP, "CL_ParseFrame: not playerinfo");
  CL_ParsePlayerstate(old, cl.frame);

  // read packet entities
  cmd = MSG_ReadByte(net_message);
  SHOWNET(svc_strings[cmd] ?? "");
  if (cmd !== SvcOpsT.svc_packetentities) Com_Error(ERR_DROP, "CL_ParseFrame: not packetentities");
  CL_ParsePacketEntities(old, cl.frame);

  // save the frame off in the backup array for later delta comparisons
  cl.frames[cl.frame.serverframe & UPDATE_MASK] = cl.frame;

  if (cl.frame.valid) {
    // getting a valid frame message ends the connection process
    if (cls.state !== ConnstateT.ca_active) {
      cls.state = ConnstateT.ca_active;
      cl.force_refdef = true;
      cl.predicted_origin[0] = cl.frame.playerstate.pmove.origin[0] * 0.125;
      cl.predicted_origin[1] = cl.frame.playerstate.pmove.origin[1] * 0.125;
      cl.predicted_origin[2] = cl.frame.playerstate.pmove.origin[2] * 0.125;
      VectorCopy(cl.frame.playerstate.viewangles, cl.predicted_angles);
      if (cls.disable_servercount !== cl.servercount && cl.refresh_prepped) {
        SCR_EndLoadingPlaque(); // get rid of loading plaque
      }
    }
    cl.sound_prepped = true; // can start mixing ambient sounds

    // fire entity events
    CL_FireEntityEvents(cl.frame);
    CL_CheckPredictionError();
  }
}

/*
==========================================================================

INTERPOLATE BETWEEN FRAMES TO GET RENDERING PARMS

==========================================================================
*/

// Defined but never called anywhere in the v3.19 tree (confirmed by grep) --
// dead code in the original engine. Ported anyway for fidelity since it is
// cheap and self-contained; not exported (matches its C linkage: file-local,
// no header declares it).
function S_RegisterSexedModel(ent: EntityStateT, base: string): ModelS | null {
  // determine what model the client is using
  let model = "";
  const n = CS_PLAYERSKINS + ent.number - 1;
  const cs = cl.configstrings[n] ?? "";
  if (cs) {
    const bs = cs.indexOf("\\");
    if (bs !== -1) {
      model = cs.slice(bs + 1);
      const slash = model.indexOf("/");
      if (slash !== -1) model = model.slice(0, slash);
    }
  }
  // if we can't figure it out, they're male
  if (!model) model = "male";

  let mdl = re?.RegisterModel(`players/${model}/${base.slice(1)}`) ?? null;
  if (!mdl) {
    // not found, try default weapon model
    mdl = re?.RegisterModel(`players/${model}/weapon.md2`) ?? null;
    if (!mdl) {
      // no, revert to the male model
      mdl = re?.RegisterModel(`players/male/${base.slice(1)}`) ?? null;
      if (!mdl) {
        // last try, default male weapon.md2
        mdl = re?.RegisterModel("players/male/weapon.md2") ?? null;
      }
    }
  }

  return mdl;
}

/*
===============
CL_AddPacketEntities
===============
*/
function CL_AddPacketEntities(frame: FrameT): void {
  const ent = new EntityT();

  // bonus items rotate at a fixed rate
  const autorotate = anglemod(cl.time / 10);

  // brush models can auto animate their frames
  const autoanim = Math.trunc((2 * cl.time) / 1000);

  for (let pnum = 0; pnum < frame.num_entities; pnum++) {
    const s1 = cl_parse_entities[(frame.parse_entities + pnum) & (MAX_PARSE_ENTITIES - 1)];

    const cent = cl_entities[s1.number];

    let effects = s1.effects;
    let renderfx = s1.renderfx;

    // reset per-entity transient fields (mirrors `memset(&ent, 0, sizeof(ent))`
    // being run once before the loop in C -- fields not explicitly set below
    // must not leak the previous iteration's values)
    ent.model = null;
    ent.skin = null;
    ent.skinnum = 0;
    ent.alpha = 0;
    ent.flags = 0;

    // set frame
    if (effects & EF_ANIM01) ent.frame = autoanim & 1;
    else if (effects & EF_ANIM23) ent.frame = 2 + (autoanim & 1);
    else if (effects & EF_ANIM_ALL) ent.frame = autoanim;
    else if (effects & EF_ANIM_ALLFAST) ent.frame = Math.trunc(cl.time / 100);
    else ent.frame = s1.frame;

    // quad and pent can do different things on client
    if (effects & EF_PENT) {
      effects &= ~EF_PENT;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_RED;
    }

    if (effects & EF_QUAD) {
      effects &= ~EF_QUAD;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_BLUE;
    }

    // PMM
    if (effects & EF_DOUBLE) {
      effects &= ~EF_DOUBLE;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_DOUBLE;
    }

    if (effects & EF_HALF_DAMAGE) {
      effects &= ~EF_HALF_DAMAGE;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_HALF_DAM;
    }
    // pmm

    ent.oldframe = cent.prev.frame;
    ent.backlerp = 1.0 - cl.lerpfrac;

    if (renderfx & (RF_FRAMELERP | RF_BEAM)) {
      // step origin discretely, because the frames
      // do the animation properly
      VectorCopy(cent.current.origin, ent.origin);
      VectorCopy(cent.current.old_origin, ent.oldorigin);
    } else {
      // interpolate origin
      for (let i = 0; i < 3; i++) {
        ent.origin[i] = ent.oldorigin[i] = cent.prev.origin[i] + cl.lerpfrac * (cent.current.origin[i] - cent.prev.origin[i]);
      }
    }

    // create a new entity

    // tweak the color of beams
    if (renderfx & RF_BEAM) {
      // the four beam colors are encoded in 32 bits of skinnum (hack)
      ent.alpha = 0.3;
      ent.skinnum = (s1.skinnum >> (Math.floor(Math.random() * 4) * 8)) & 0xff;
      ent.model = null;
    } else {
      // set skin
      if (s1.modelindex === 255) {
        // use custom player skin
        ent.skinnum = 0;
        const ci = cl.clientinfo[s1.skinnum & 0xff];
        ent.skin = ci.skin;
        ent.model = ci.model;
        if (!ent.skin || !ent.model) {
          ent.skin = cl.baseclientinfo.skin;
          ent.model = cl.baseclientinfo.model;
        }

        // PGM: RF_USE_DISGUISE reinterprets ent.skin (a char* image name) as
        // a string via strncmp -- undefined behavior against an opaque
        // renderer handle (ImageS = unknown per ref.ts) and unportable as
        // written. Dropped; reported as a deviation.
      } else {
        ent.skinnum = s1.skinnum;
        ent.skin = null;
        ent.model = cl.model_draw[s1.modelindex];
      }
    }

    // only used for black hole model right now, FIXME: do better
    if (renderfx === RF_TRANSLUCENT) ent.alpha = 0.7;

    // render effects (fullbright, translucent, etc)
    if (effects & EF_COLOR_SHELL) ent.flags = 0; // renderfx go on color shell entity
    else ent.flags = renderfx;

    // calculate angles
    if (effects & EF_ROTATE) {
      // some bonus items auto-rotate
      ent.angles[0] = 0;
      ent.angles[1] = autorotate;
      ent.angles[2] = 0;
    } else if (effects & EF_SPINNINGLIGHTS) {
      // RAFAEL
      ent.angles[0] = 0;
      ent.angles[1] = anglemod(cl.time / 2) + s1.angles[1];
      ent.angles[2] = 180;
      {
        const forward: Vec3 = new Float32Array(3);
        const start: Vec3 = new Float32Array(3);
        AngleVectors(ent.angles, forward, null, null);
        VectorMA(ent.origin, 64, forward, start);
        V_AddLight(start, 100, 1, 0, 0);
      }
    } else {
      // interpolate angles
      for (let i = 0; i < 3; i++) {
        const a1 = cent.current.angles[i];
        const a2 = cent.prev.angles[i];
        ent.angles[i] = LerpAngle(a2, a1, cl.lerpfrac);
      }
    }

    if (s1.number === cl.playernum + 1) {
      ent.flags |= RF_VIEWERMODEL; // only draw from mirrors
      // FIXME: still pass to refresh

      if (effects & EF_FLAG1) V_AddLight(ent.origin, 225, 1.0, 0.1, 0.1);
      else if (effects & EF_FLAG2) V_AddLight(ent.origin, 225, 0.1, 0.1, 1.0);
      else if (effects & EF_TAGTRAIL) V_AddLight(ent.origin, 225, 1.0, 1.0, 0.0); // PGM
      else if (effects & EF_TRACKERTRAIL) V_AddLight(ent.origin, 225, -1.0, -1.0, -1.0); // PGM

      continue;
    }

    // if set to invisible, skip
    if (!s1.modelindex) continue;

    if (effects & EF_BFG) {
      ent.flags |= RF_TRANSLUCENT;
      ent.alpha = 0.3;
    }

    // RAFAEL
    if (effects & EF_PLASMA) {
      ent.flags |= RF_TRANSLUCENT;
      ent.alpha = 0.6;
    }

    if (effects & EF_SPHERETRANS) {
      ent.flags |= RF_TRANSLUCENT;
      // PMM - *sigh* yet more EF overloading
      if (effects & EF_TRACKERTRAIL) ent.alpha = 0.6;
      else ent.alpha = 0.3;
    }
    //pmm

    // add to refresh list
    V_AddEntity(ent);

    // color shells generate a seperate entity for the main model
    if (effects & EF_COLOR_SHELL) {
      // PMM - at this point, all of the shells have been handled
      // if we're in the rogue pack, set up the custom mixing, otherwise just
      // keep going
      // all of the solo colors are fine.  we need to catch any of the combinations that look bad
      // (double & half) and turn them into the appropriate color, and make double/quad something special
      if (renderfx & RF_SHELL_HALF_DAM) {
        if (Developer_searchpath(2) === 2) {
          // ditch the half damage shell if any of red, blue, or double are on
          if (renderfx & (RF_SHELL_RED | RF_SHELL_BLUE | RF_SHELL_DOUBLE)) renderfx &= ~RF_SHELL_HALF_DAM;
        }
      }

      if (renderfx & RF_SHELL_DOUBLE) {
        if (Developer_searchpath(2) === 2) {
          // lose the yellow shell if we have a red, blue, or green shell
          if (renderfx & (RF_SHELL_RED | RF_SHELL_BLUE | RF_SHELL_GREEN)) renderfx &= ~RF_SHELL_DOUBLE;
          // if we have a red shell, turn it to purple by adding blue
          if (renderfx & RF_SHELL_RED) renderfx |= RF_SHELL_BLUE;
          // if we have a blue shell (and not a red shell), turn it to cyan by adding green
          else if (renderfx & RF_SHELL_BLUE) {
            // go to green if it's on already, otherwise do cyan (flash green)
            if (renderfx & RF_SHELL_GREEN) renderfx &= ~RF_SHELL_BLUE;
            else renderfx |= RF_SHELL_GREEN;
          }
        }
      }
      // pmm
      ent.flags = renderfx | RF_TRANSLUCENT;
      ent.alpha = 0.3;
      V_AddEntity(ent);
    }

    ent.skin = null; // never use a custom skin on others
    ent.skinnum = 0;
    ent.flags = 0;
    ent.alpha = 0;

    // duplicate for linked models
    if (s1.modelindex2) {
      if (s1.modelindex2 === 255) {
        // custom weapon
        const ci = cl.clientinfo[s1.skinnum & 0xff];
        let i = s1.skinnum >> 8; // 0 is default weapon model
        if (!clCvars.cl_vwep?.value || i > MAX_CLIENTWEAPONMODELS - 1) i = 0;
        ent.model = ci.weaponmodel[i];
        if (!ent.model) {
          if (i !== 0) ent.model = ci.weaponmodel[0];
          if (!ent.model) ent.model = cl.baseclientinfo.weaponmodel[0];
        }
      } else {
        ent.model = cl.model_draw[s1.modelindex2];
      }

      // PMM - check for the defender sphere shell .. make it translucent
      // replaces the previous version which used the high bit on modelindex2 to determine transparency
      if (Q_strcasecmp(cl.configstrings[CS_MODELS + s1.modelindex2] ?? "", "models/items/shell/tris.md2") === 0) {
        ent.alpha = 0.32;
        ent.flags = RF_TRANSLUCENT;
      }
      // pmm

      V_AddEntity(ent);

      //PGM - make sure these get reset.
      ent.flags = 0;
      ent.alpha = 0;
      //PGM
    }
    if (s1.modelindex3) {
      ent.model = cl.model_draw[s1.modelindex3];
      V_AddEntity(ent);
    }
    if (s1.modelindex4) {
      ent.model = cl.model_draw[s1.modelindex4];
      V_AddEntity(ent);
    }

    if (effects & EF_POWERSCREEN) {
      ent.model = cl_mod_powerscreen;
      ent.oldframe = 0;
      ent.frame = 0;
      ent.flags |= RF_TRANSLUCENT | RF_SHELL_GREEN;
      ent.alpha = 0.3;
      V_AddEntity(ent);
    }

    // add automatic particle trails
    if (effects & ~EF_ROTATE) {
      if (effects & EF_ROCKET) {
        CL_RocketTrail(cent.lerp_origin, ent.origin, cent);
        V_AddLight(ent.origin, 200, 1, 1, 0);
      } else if (effects & EF_BLASTER) {
        // PGM - Do not reorder EF_BLASTER and EF_HYPERBLASTER.
        // EF_BLASTER | EF_TRACKER is a special case for EF_BLASTER2... Cheese!
        if (effects & EF_TRACKER) {
          // lame... problematic?
          CL_BlasterTrail2(cent.lerp_origin, ent.origin);
          V_AddLight(ent.origin, 200, 0, 1, 0);
        } else {
          CL_BlasterTrail(cent.lerp_origin, ent.origin);
          V_AddLight(ent.origin, 200, 1, 1, 0);
        }
        //PGM
      } else if (effects & EF_HYPERBLASTER) {
        if (effects & EF_TRACKER)
          V_AddLight(ent.origin, 200, 0, 1, 0); // PGM overloaded for blaster2.
        else V_AddLight(ent.origin, 200, 1, 1, 0); // PGM
      } else if (effects & EF_GIB) {
        CL_DiminishingTrail(cent.lerp_origin, ent.origin, cent, effects);
      } else if (effects & EF_GRENADE) {
        CL_DiminishingTrail(cent.lerp_origin, ent.origin, cent, effects);
      } else if (effects & EF_FLIES) {
        CL_FlyEffect(cent, ent.origin);
      } else if (effects & EF_BFG) {
        const bfg_lightramp = fixedLength("bfg_lightramp", 6, [300, 400, 600, 300, 150, 75]);

        let i: number;
        if (effects & EF_ANIM_ALLFAST) {
          CL_BfgParticles(ent);
          i = 200;
        } else {
          i = bfg_lightramp[s1.frame] ?? 0;
        }
        V_AddLight(ent.origin, i, 0, 1, 0);
      } else if (effects & EF_TRAP) {
        // RAFAEL
        ent.origin[2] += 32;
        CL_TrapParticles(ent);
        const i = Math.floor(Math.random() * 100) + 100;
        V_AddLight(ent.origin, i, 1, 0.8, 0.1);
      } else if (effects & EF_FLAG1) {
        CL_FlagTrail(cent.lerp_origin, ent.origin, 242);
        V_AddLight(ent.origin, 225, 1, 0.1, 0.1);
      } else if (effects & EF_FLAG2) {
        CL_FlagTrail(cent.lerp_origin, ent.origin, 115);
        V_AddLight(ent.origin, 225, 0.1, 0.1, 1);
      } else if (effects & EF_TAGTRAIL) {
        //ROGUE
        CL_TagTrail(cent.lerp_origin, ent.origin, 220);
        V_AddLight(ent.origin, 225, 1.0, 1.0, 0.0);
      } else if (effects & EF_TRACKERTRAIL) {
        if (effects & EF_TRACKER) {
          const intensity = 50 + 500 * (Math.sin(cl.time / 500.0) + 1.0);
          // FIXME - check out this effect in rendition
          if (vidref_val === VIDREF_GL) V_AddLight(ent.origin, intensity, -1.0, -1.0, -1.0);
          else V_AddLight(ent.origin, -1.0 * intensity, 1.0, 1.0, 1.0);
        } else {
          CL_Tracker_Shell(cent.lerp_origin);
          V_AddLight(ent.origin, 155, -1.0, -1.0, -1.0);
        }
      } else if (effects & EF_TRACKER) {
        CL_TrackerTrail(cent.lerp_origin, ent.origin, 0);
        // FIXME - check out this effect in rendition
        if (vidref_val === VIDREF_GL) V_AddLight(ent.origin, 200, -1, -1, -1);
        else V_AddLight(ent.origin, -200, 1, 1, 1);
        //ROGUE
      } else if (effects & EF_GREENGIB) {
        // RAFAEL
        CL_DiminishingTrail(cent.lerp_origin, ent.origin, cent, effects);
      } else if (effects & EF_IONRIPPER) {
        // RAFAEL
        CL_IonripperTrail(cent.lerp_origin, ent.origin);
        V_AddLight(ent.origin, 100, 1, 0.5, 0.5);
      } else if (effects & EF_BLUEHYPERBLASTER) {
        // RAFAEL
        V_AddLight(ent.origin, 200, 0, 0, 1);
      } else if (effects & EF_PLASMA) {
        // RAFAEL
        if (effects & EF_ANIM_ALLFAST) CL_BlasterTrail(cent.lerp_origin, ent.origin);
        V_AddLight(ent.origin, 130, 1, 0.5, 0.5);
      }
    }

    VectorCopy(ent.origin, cent.lerp_origin);
  }
}

/*
==============
CL_AddViewWeapon
==============
*/
function CL_AddViewWeapon(ps: PlayerStateT, ops: PlayerStateT): void {
  // allow the gun to be completely removed
  if (!clCvars.cl_gun?.value) return;

  // don't draw gun if in wide angle view
  if (ps.fov > 90) return;

  const gun = new EntityT();

  if (gun_model) gun.model = gun_model; // development tool
  else gun.model = cl.model_draw[ps.gunindex];
  if (!gun.model) return;

  // set up gun position
  for (let i = 0; i < 3; i++) {
    gun.origin[i] = cl.refdef.vieworg[i] + ops.gunoffset[i] + cl.lerpfrac * (ps.gunoffset[i] - ops.gunoffset[i]);
    gun.angles[i] = cl.refdef.viewangles[i] + LerpAngle(ops.gunangles[i], ps.gunangles[i], cl.lerpfrac);
  }

  if (gun_frame) {
    gun.frame = gun_frame; // development tool
    gun.oldframe = gun_frame; // development tool
  } else {
    gun.frame = ps.gunframe;
    if (gun.frame === 0) gun.oldframe = 0; // just changed weapons, don't lerp from old
    else gun.oldframe = ops.gunframe;
  }

  gun.flags = RF_MINLIGHT | RF_DEPTHHACK | RF_WEAPONMODEL;
  gun.backlerp = 1.0 - cl.lerpfrac;
  VectorCopy(gun.origin, gun.oldorigin); // don't lerp at all
  V_AddEntity(gun);
}

/*
===============
CL_CalcViewValues

Sets cl.refdef view values
===============
*/
function CL_CalcViewValues(): void {
  // find the previous frame to interpolate from
  const ps = cl.frame.playerstate;
  const i = (cl.frame.serverframe - 1) & UPDATE_MASK;
  let oldframe = cl.frames[i];
  if (oldframe.serverframe !== cl.frame.serverframe - 1 || !oldframe.valid) oldframe = cl.frame; // previous frame was dropped or invalid
  let ops = oldframe.playerstate;

  // see if the player entity was teleported this frame
  if (
    Math.abs(ops.pmove.origin[0] - ps.pmove.origin[0]) > 256 * 8 ||
    absInt(ops.pmove.origin[1] - ps.pmove.origin[1]) > 256 * 8 ||
    absInt(ops.pmove.origin[2] - ps.pmove.origin[2]) > 256 * 8
  )
    ops = ps; // don't interpolate

  const lerp = cl.lerpfrac;

  // calculate the origin
  if (clCvars.cl_predict?.value && !(cl.frame.playerstate.pmove.pm_flags & PMF_NO_PREDICTION)) {
    // use predicted values
    const backlerp = 1.0 - lerp;
    for (let i2 = 0; i2 < 3; i2++) {
      cl.refdef.vieworg[i2] = cl.predicted_origin[i2] + ops.viewoffset[i2] + cl.lerpfrac * (ps.viewoffset[i2] - ops.viewoffset[i2]) - backlerp * cl.prediction_error[i2];
    }

    // smooth out stair climbing
    const delta = cls.realtime - cl.predicted_step_time;
    if (delta < 100) cl.refdef.vieworg[2] -= cl.predicted_step * (100 - delta) * 0.01;
  } else {
    // just use interpolated values
    for (let i2 = 0; i2 < 3; i2++)
      cl.refdef.vieworg[i2] =
        ops.pmove.origin[i2] * 0.125 + ops.viewoffset[i2] + lerp * (ps.pmove.origin[i2] * 0.125 + ps.viewoffset[i2] - (ops.pmove.origin[i2] * 0.125 + ops.viewoffset[i2]));
  }

  // if not running a demo or on a locked frame, add the local angle movement
  if (cl.frame.playerstate.pmove.pm_type < PmTypeT.PM_DEAD) {
    // use predicted values
    for (let i2 = 0; i2 < 3; i2++) cl.refdef.viewangles[i2] = cl.predicted_angles[i2];
  } else {
    // just use interpolated values
    for (let i2 = 0; i2 < 3; i2++) cl.refdef.viewangles[i2] = LerpAngle(ops.viewangles[i2], ps.viewangles[i2], lerp);
  }

  for (let i2 = 0; i2 < 3; i2++) cl.refdef.viewangles[i2] += LerpAngle(ops.kick_angles[i2], ps.kick_angles[i2], lerp);

  AngleVectors(cl.refdef.viewangles, cl.v_forward, cl.v_right, cl.v_up);

  // interpolate field of view
  cl.refdef.fov_x = ops.fov + lerp * (ps.fov - ops.fov);

  // don't interpolate blend color
  for (let i2 = 0; i2 < 4; i2++) cl.refdef.blend[i2] = ps.blend[i2];

  // add the weapon
  CL_AddViewWeapon(ps, ops);
}

/*
===============
CL_AddEntities

Emits all entities, particles, and lights to the refresh
===============
*/
export function CL_AddEntities(): void {
  if (cls.state !== ConnstateT.ca_active) return;

  if (cl.time > cl.frame.servertime) {
    if (clCvars.cl_showclamp?.value) Com_Printf("high clamp %i\n", cl.time - cl.frame.servertime);
    cl.time = cl.frame.servertime;
    cl.lerpfrac = 1.0;
  } else if (cl.time < cl.frame.servertime - 100) {
    if (clCvars.cl_showclamp?.value) Com_Printf("low clamp %i\n", cl.frame.servertime - 100 - cl.time);
    cl.time = cl.frame.servertime - 100;
    cl.lerpfrac = 0;
  } else {
    cl.lerpfrac = 1.0 - (cl.frame.servertime - cl.time) * 0.01;
  }

  if (clCvars.cl_timedemo?.value) cl.lerpfrac = 1.0;

  CL_CalcViewValues();
  // PMM - moved this here so the heat beam has the right values for the vieworg, and can lock the beam to the gun
  CL_AddPacketEntities(cl.frame);
  CL_AddTEnts();
  CL_AddParticles();
  CL_AddDLights();
  CL_AddLightStyles();
}

/*
===============
CL_GetEntitySoundOrigin

Called to get the sound spatialization origin
===============
*/
export function CL_GetEntitySoundOrigin(ent: number, org: Vec3): void {
  if (ent < 0 || ent >= MAX_EDICTS) {
    Com_Error(ERR_DROP, "CL_GetEntitySoundOrigin: bad ent");
  }
  const old = cl_entities[ent];
  VectorCopy(old.lerp_origin, org);

  // FIXME: bmodel issues...
}
