/*
Copyright (C) 1997-2001 Id Software, Inc. -- cl_pred.c, movement prediction
against the local Pmove. CL_ClipMoveToEntities/CL_PMTrace/CL_PMpointcontents
are internal to cl_pred.c (used only as Pmove trace/pointcontents callbacks,
never extern-declared in any header) and stay module-private here too.

client.h also declares `void CL_InitPrediction (void);` and
`void CL_PredictMove (void);` under this file's section, but neither is
defined anywhere in the v3.19 client tree (confirmed by grep) -- dead
declarations, dropped and reported. `CL_PredictMovement` (a distinct, real
function) is declared separately, later in client.h, and is the one
exported below.
*/

import { Com_Printf } from "../qcommon/common";
import { CM_BoxTrace, CM_TransformedBoxTrace, CM_HeadnodeForBox, CM_PointContents, CM_TransformedPointContents } from "../qcommon/cmodel";
import { Pmove, SetPmAirAccelerate } from "../qcommon/pmove";
import { type Vec3, vec3, vec3_origin, VectorClear, VectorCopy } from "../shared/math";
import { PmoveT, PmoveStateT, UsercmdT, TraceT, MASK_PLAYERSOLID, PMF_NO_PREDICTION, PMF_ON_GROUND, SHORT2ANGLE, type EntityStateT } from "../shared/q_shared";
import { cl, cls, ConnstateT, clCvars, cl_parse_entities, CMD_BACKUP, MAX_PARSE_ENTITIES } from "./client";

function atof(s: string): number {
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

/*
===================
CL_CheckPredictionError
===================
*/
export function CL_CheckPredictionError(): void {
  if (!(clCvars.cl_predict && clCvars.cl_predict.value) || cl.frame.playerstate.pmove.pm_flags & PMF_NO_PREDICTION) return;

  // calculate the last usercmd_t we sent that the server has processed
  const frame = cls.netchan.incoming_acknowledged & (CMD_BACKUP - 1);

  // compare what the server returned with what we had predicted it to be
  const delta = [0, 0, 0];
  for (let i = 0; i < 3; i++) delta[i] = cl.frame.playerstate.pmove.origin[i] - cl.predicted_origins[frame][i];

  // save the prediction error for interpolation
  const len = Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]);
  if (len > 640) {
    // a teleport or something
    VectorClear(cl.prediction_error);
  } else {
    if (clCvars.cl_showmiss && clCvars.cl_showmiss.value && (delta[0] || delta[1] || delta[2])) {
      Com_Printf("prediction miss on %i: %i\n", cl.frame.serverframe, delta[0] + delta[1] + delta[2]);
    }

    for (let i = 0; i < 3; i++) cl.predicted_origins[frame][i] = cl.frame.playerstate.pmove.origin[i];

    // save for error itnerpolation
    for (let i = 0; i < 3; i++) cl.prediction_error[i] = delta[i] * 0.125;
  }
}

/*
====================
CL_ClipMoveToEntities

====================
*/
function CL_ClipMoveToEntities(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, tr: TraceT): void {
  for (let i = 0; i < cl.frame.num_entities; i++) {
    const num = (cl.frame.parse_entities + i) & (MAX_PARSE_ENTITIES - 1);
    const ent: EntityStateT = cl_parse_entities[num];

    if (!ent.solid) continue;
    if (ent.number === cl.playernum + 1) continue;

    let headnode: number;
    let angles: Vec3;

    if (ent.solid === 31) {
      // special value for bmodel
      const cmodel = cl.model_clip[ent.modelindex];
      if (!cmodel) continue;
      headnode = cmodel.headnode;
      angles = ent.angles;
    } else {
      // encoded bbox
      const x = 8 * (ent.solid & 31);
      const zd = 8 * ((ent.solid >> 5) & 31);
      const zu = 8 * ((ent.solid >> 10) & 63) - 32;

      const bmins = vec3(-x, -x, -zd);
      const bmaxs = vec3(x, x, zu);

      headnode = CM_HeadnodeForBox(bmins, bmaxs);
      angles = vec3_origin; // boxes don't rotate
    }

    if (tr.allsolid) return;

    const trace = CM_TransformedBoxTrace(start, end, mins, maxs, headnode, MASK_PLAYERSOLID, ent.origin, angles);

    if (trace.allsolid || trace.startsolid || trace.fraction < tr.fraction) {
      trace.ent = ent;
      const wasStartsolid = tr.startsolid;
      copyTrace(tr, trace);
      if (wasStartsolid) tr.startsolid = true;
    } else if (trace.startsolid) {
      tr.startsolid = true;
    }
  }
}

function copyTrace(dst: TraceT, src: TraceT): void {
  dst.allsolid = src.allsolid;
  dst.startsolid = src.startsolid;
  dst.fraction = src.fraction;
  VectorCopy(src.endpos, dst.endpos);
  dst.plane = src.plane;
  dst.surface = src.surface;
  dst.contents = src.contents;
  dst.ent = src.ent;
}

/*
================
CL_PMTrace
================
*/
function CL_PMTrace(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): TraceT {
  // check against world
  const t = CM_BoxTrace(start, end, mins, maxs, 0, MASK_PLAYERSOLID);
  if (t.fraction < 1.0) t.ent = 1;

  // check all other solid models
  CL_ClipMoveToEntities(start, mins, maxs, end, t);

  return t;
}

function CL_PMpointcontents(point: Vec3): number {
  let contents = CM_PointContents(point, 0);

  for (let i = 0; i < cl.frame.num_entities; i++) {
    const num = (cl.frame.parse_entities + i) & (MAX_PARSE_ENTITIES - 1);
    const ent = cl_parse_entities[num];

    if (ent.solid !== 31) continue; // special value for bmodel

    const cmodel = cl.model_clip[ent.modelindex];
    if (!cmodel) continue;

    contents |= CM_TransformedPointContents(point, cmodel.headnode, ent.origin, ent.angles);
  }

  return contents;
}

function copyPmoveState(dst: PmoveStateT, src: PmoveStateT): void {
  dst.pm_type = src.pm_type;
  dst.origin.set(src.origin);
  dst.velocity.set(src.velocity);
  dst.pm_flags = src.pm_flags;
  dst.pm_time = src.pm_time;
  dst.gravity = src.gravity;
  dst.delta_angles.set(src.delta_angles);
  dst.viewheight = src.viewheight;
}

function copyUsercmd(dst: UsercmdT, src: UsercmdT): void {
  dst.msec = src.msec;
  dst.buttons = src.buttons;
  dst.angles.set(src.angles);
  dst.forwardmove = src.forwardmove;
  dst.sidemove = src.sidemove;
  dst.upmove = src.upmove;
  dst.impulse = src.impulse;
  dst.lightlevel = src.lightlevel;
}

/*
=================
CL_PredictMovement

Sets cl.predicted_origin and cl.predicted_angles
=================
*/
export function CL_PredictMovement(): void {
  if (cls.state !== ConnstateT.ca_active) return;

  if (clCvars.cl_paused && clCvars.cl_paused.value) return;

  if (!(clCvars.cl_predict && clCvars.cl_predict.value) || cl.frame.playerstate.pmove.pm_flags & PMF_NO_PREDICTION) {
    // just set angles
    for (let i = 0; i < 3; i++) {
      cl.predicted_angles[i] = cl.viewangles[i] + SHORT2ANGLE(cl.frame.playerstate.pmove.delta_angles[i]);
    }
    return;
  }

  const ack = cls.netchan.incoming_acknowledged;
  const current = cls.netchan.outgoing_sequence;

  // if we are too far out of date, just freeze
  if (current - ack >= CMD_BACKUP) {
    if (clCvars.cl_showmiss && clCvars.cl_showmiss.value) Com_Printf("exceeded CMD_BACKUP\n");
    return;
  }

  // copy current state to pmove
  const pm = new PmoveT();
  pm.trace = CL_PMTrace;
  pm.pointcontents = CL_PMpointcontents;

  SetPmAirAccelerate(atof(cl.configstrings[cls.csr.airaccel]));

  copyPmoveState(pm.s, cl.frame.playerstate.pmove);

  let a = ack;
  let frame = 0;

  // run frames
  for (;;) {
    a++;
    if (!(a < current)) break;

    frame = a & (CMD_BACKUP - 1);
    const cmd = cl.cmds[frame];

    copyUsercmd(pm.cmd, cmd);
    Pmove(pm);

    // save for debug checking
    for (let i = 0; i < 3; i++) cl.predicted_origins[frame][i] = pm.s.origin[i];
  }

  const oldframe = (a - 2) & (CMD_BACKUP - 1);
  const oldz = cl.predicted_origins[oldframe][2];
  const step = pm.s.origin[2] - oldz;
  if (step > 63 && step < 160 && pm.s.pm_flags & PMF_ON_GROUND) {
    cl.predicted_step = step * 0.125;
    cl.predicted_step_time = cls.realtime - cls.frametime * 500;
  }

  // copy results out for rendering
  cl.predicted_origin[0] = pm.s.origin[0] * 0.125;
  cl.predicted_origin[1] = pm.s.origin[1] * 0.125;
  cl.predicted_origin[2] = pm.s.origin[2] * 0.125;

  VectorCopy(pm.viewangles, cl.predicted_angles);
}
