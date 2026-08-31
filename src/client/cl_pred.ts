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
import { pmFloatToShort } from "../qcommon/protocol/q2repro";
import { type Vec3, vec3, vec3_origin, VectorClear, VectorCopy } from "../shared/math";
import { PmoveT, PmoveStateT, UsercmdT, TraceT, CplaneT, MASK_PLAYERSOLID, PMF_NO_PREDICTION, PMF_ON_GROUND, SHORT2ANGLE, type EntityStateT } from "../shared/q_shared";
import type { KexPmoveT, KexTraceT, KexEdictT } from "../kexapi/game";
import { ContentsT, WaterLevelT, RefdefFlagsT, PmflagsT } from "../kexapi/game";
import { cl, cls, ConnstateT, clCvars, cl_parse_entities, CMD_BACKUP, MAX_PARSE_ENTITIES } from "./client";
import {
  CG_GetActiveCgamePmove,
  CL_KexTraceEntity,
  kexTraceFromEngine,
  copyKexTrace,
  kexUsercmdFromClassic,
  kexPmoveStateViewFromClassic,
  type CgamePmoveFn,
} from "./cgame/host";

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

// The collision hull an entity_state_t's `solid` field describes, resolved
// exactly as cl_pred.c always resolved it inline. Extracted (identical
// arithmetic, identical "no clip model -> skip this entity" outcome, which the
// callers express as `continue`) only so the kex-family sweep below can share
// it rather than restate the packing. Both families pack `solid` the same way
// in this port -- sv_world.ts:190-210 writes the 5/5/6 bbox encoding and the
// 31 bmodel sentinel regardless of which game module is loaded -- so one
// decoder is correct for both.
function CL_HullForEntityState(ent: EntityStateT): { headnode: number; angles: Vec3 } | null {
  if (ent.solid === 31) {
    // special value for bmodel
    const cmodel = cl.model_clip[ent.modelindex];
    if (!cmodel) return null;
    return { headnode: cmodel.headnode, angles: ent.angles };
  }

  // encoded bbox
  const x = 8 * (ent.solid & 31);
  const zd = 8 * ((ent.solid >> 5) & 31);
  const zu = 8 * ((ent.solid >> 10) & 63) - 32;

  const bmins = vec3(-x, -x, -zd);
  const bmaxs = vec3(x, x, zu);

  return { headnode: CM_HeadnodeForBox(bmins, bmaxs), angles: vec3_origin }; // boxes don't rotate
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

    const hull = CL_HullForEntityState(ent);
    if (!hull) continue;
    const headnode = hull.headnode;
    const angles = hull.angles;

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

/*
=============================================================================

KEX-FAMILY PREDICTION

q2repro src/client/predict.c. The three callbacks below are its CL_PMTrace /
CL_Clip / CL_PointContents: contentmask-aware (the classic trio above is
hardwired to MASK_PLAYERSOLID, because the vanilla Pmove never passes a mask
at all), returning KexTraceT, and reporting the entity a trace hit as one of
cgame/host.ts's identity tokens.

They are written against sv_world.ts -- SV_Trace, SV_Clip, SV_PointContents,
the exact functions server/bindings/kex.ts hands the kex game as gi.trace /
gi.clip / gi.pointcontents -- rather than against q2repro's client, because
prediction is only correct when the client's collision answers match the
SERVER'S. Where the two references disagree the server wins; every such spot
is called out below.

=============================================================================
*/

/** SV_ClipMoveToEntities (sv_world.ts), over the entities the client actually
 *  has. The rules the client cannot evaluate are the ones that need server
 *  state it never receives: SVF_DEADMONSTER (no svflags on the wire) and the
 *  owner/passedict exclusions (the local player is excluded by number, which
 *  is the case that matters for a player's own movement). q2repro's own
 *  CL_ClipMoveToEntities has exactly the same three gaps. */
function CL_KexClipMoveToEntities(tr: KexTraceT, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, contentmask: number): void {
  // [Paril-KEX] PM_Trace strips CONTENTS_PLAYER from the mask when
  // PMF_IGNORE_PLAYER_COLLISION is set (p_move.ts:582); other players are the
  // only entities the client can identify as carrying it, and it identifies
  // them by number the way q2repro's own `ent->current.number <= cl.maxclients`
  // test does. An absent/unparsable maxclients configstring yields 0, which
  // simply means no entity is treated as a player -- the pre-existing
  // behavior, never a wrong skip.
  const maxclients = atof(cl.configstrings[cls.csr.maxclients]);

  for (let i = 0; i < cl.frame.num_entities; i++) {
    const num = (cl.frame.parse_entities + i) & (MAX_PARSE_ENTITIES - 1);
    const ent: EntityStateT = cl_parse_entities[num];

    if (!ent.solid) continue;
    if (ent.number === cl.playernum + 1) continue;
    if (ent.number <= maxclients && !(contentmask & ContentsT.CONTENTS_PLAYER)) continue;

    const hull = CL_HullForEntityState(ent);
    if (!hull) continue;

    if (tr.allsolid) return;

    const trace = CM_TransformedBoxTrace(start, end, mins, maxs, hull.headnode, contentmask, ent.origin, hull.angles);

    if (trace.allsolid || trace.startsolid || trace.fraction < tr.fraction) {
      const wasStartsolid = tr.startsolid;
      copyKexTrace(tr, kexTraceFromEngine(trace, CL_KexTraceEntity(ent.number)));
      if (wasStartsolid) tr.startsolid = true;
    } else if (trace.startsolid) {
      tr.startsolid = true;
    }
  }
}

/** SV_Trace (sv_world.ts), including its `tr.ent = world` seeding and its
 *  `fraction === 0` "blocked by the world" early out. `passent` is the kex
 *  game's own player edict, which has no client-side counterpart -- the local
 *  player is excluded by number inside CL_KexClipMoveToEntities instead, which
 *  is the only exclusion a predicting client's own move needs. */
function CL_KexTrace(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, _passent: KexEdictT | null, contentmask: number): KexTraceT {
  const realMins = mins ?? vec3_origin;
  const realMaxs = maxs ?? vec3_origin;

  const tr = kexTraceFromEngine(CM_BoxTrace(start, end, realMins, realMaxs, 0, contentmask), CL_KexTraceEntity(0));
  if (tr.fraction === 0) return tr; // blocked by the world

  CL_KexClipMoveToEntities(tr, start, realMins, realMaxs, end, contentmask);
  return tr;
}

/** [Paril-KEX] world-only clip. SV_Clip (sv_world.ts) against the world edict
 *  reduces to exactly this CM_BoxTrace, and that is the only form the kex
 *  movement code ever asks for: p_client.ts's SV_PM_Clip passes g_edicts[0]. */
function CL_KexClip(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, contentmask: number): KexTraceT {
  const trace = CM_BoxTrace(start, end, mins ?? vec3_origin, maxs ?? vec3_origin, 0, contentmask);
  return kexTraceFromEngine(trace, CL_KexTraceEntity(0));
}

/** CL_PMpointcontents above is already family-neutral -- world contents OR'd
 *  with every inline bmodel's -- and matches what SV_PointContents produces
 *  for the brush entities a client can see. q2repro's kex-only mins/maxs
 *  prefilter is deliberately NOT reproduced: SV_PointContents has no such
 *  prefilter, so adding one client-side would CREATE divergence rather than
 *  remove it. */
function CL_KexPointContents(point: Vec3): number {
  return CL_PMpointcontents(point);
}

/** predict.c:270-294. The pmove state stays FLOAT for the whole replay: it is
 *  seeded once from the snapshot -- host.ts's kexPmoveStateViewFromClassic
 *  reads PmoveStateT's own float mirror (`originF`/`velocityF`,
 *  q_shared.ts), which the 1038 codec (qcommon/protocol/q2repro.ts)
 *  populates with the genuine, un-narrowed wire value (FLOAT PMOVE STATE END
 *  TO END, .orch/followups.md) -- and then carried forward across every
 *  replayed command without being re-quantized, exactly as the server
 *  carries its own float pmove state forward across frames. Quantizing per
 *  replayed frame instead would inject a fresh rounding error on every one
 *  of them.
 *
 *  pm_time needs no conversion in either direction: kexgame/p_move.ts compares
 *  it directly against cmd.msec in MILLISECONDS (p_move.ts:1447-1452) and
 *  server/bindings/kex.ts copies it through raw, so the value the client holds
 *  is already in the units this Pmove expects. (The classic path's 8ms units
 *  live entirely inside qcommon/pmove.ts and never meet this code.) */
function CL_PredictMovementKex(cgamePmove: CgamePmoveFn): void {
  const ack = cls.netchan.incoming_acknowledged;
  const current = cls.netchan.outgoing_sequence;

  // if we are too far out of date, just freeze
  if (current - ack >= CMD_BACKUP) {
    if (clCvars.cl_showmiss && clCvars.cl_showmiss.value) Com_Printf("exceeded CMD_BACKUP\n");
    return;
  }

  const ps = cl.frame.playerstate;

  const pm: KexPmoveT = {
    s: kexPmoveStateViewFromClassic(ps.pmove),
    cmd: kexUsercmdFromClassic(new UsercmdT(), cl.frame.serverframe),
    // predict.c:292: set for the first replayed command and cleared after it.
    // The server sets it whenever the state moved outside pmove
    // (p_client.ts:3497); a client replaying from a fresh snapshot is always
    // in that situation on its first frame.
    snapinitial: true,
    touch: { num: 0, traces: [] },
    viewangles: vec3(),
    mins: vec3(),
    maxs: vec3(),
    groundentity: null,
    groundplane: new CplaneT(),
    watertype: ContentsT.CONTENTS_NONE,
    waterlevel: WaterLevelT.WATER_NONE,
    // The kex player edict; see CL_KexTrace's own note on why the client has
    // no counterpart and needs none.
    player: null,
    trace: CL_KexTrace,
    clip: CL_KexClip,
    pointcontents: CL_KexPointContents,
    // predict.c:280: `VectorCopy(cl.frame.ps.viewoffset, pm.viewoffset);` --
    // PM_ScreenEffects reads it to place the eye point for the underwater
    // screen blend, so a zero here would sample contents at the player's feet.
    viewoffset: vec3(ps.viewoffset[0], ps.viewoffset[1], ps.viewoffset[2]),
    screen_blend: new Float32Array(4),
    rdflags: RefdefFlagsT.RDF_NONE,
    jump_sound: false,
    step_clip: false,
    impact_delta: 0,
  };

  let a = ack;
  let frame = 0;

  // run frames
  for (;;) {
    a++;
    if (!(a < current)) break;

    frame = a & (CMD_BACKUP - 1);
    pm.cmd = kexUsercmdFromClassic(cl.cmds[frame], cl.frame.serverframe);
    cgamePmove(pm);
    pm.snapinitial = false;

    // save for debug checking. cl.predicted_origins is the 12.3 fixed-point
    // domain CL_CheckPredictionError compares in (it subtracts the snapshot's
    // own Int16Array origin from it), so the float result is narrowed with the
    // 1038 codec's own pmFloatToShort -- the exact quantization the server's
    // value went through on its way here.
    cl.predicted_origins[frame][0] = pmFloatToShort(pm.s.origin[0]);
    cl.predicted_origins[frame][1] = pmFloatToShort(pm.s.origin[1]);
    cl.predicted_origins[frame][2] = pmFloatToShort(pm.s.origin[2]);
  }

  const oldframe = (a - 2) & (CMD_BACKUP - 1);
  const oldz = cl.predicted_origins[oldframe][2];
  const step = pmFloatToShort(pm.s.origin[2]) - oldz;
  if (step > 63 && step < 160 && pm.s.pm_flags & PmflagsT.PMF_ON_GROUND) {
    cl.predicted_step = step * 0.125;
    cl.predicted_step_time = cls.realtime - cls.frametime * 500;
  }

  // copy results out for rendering. No `* 0.125` here, unlike the classic
  // path: kex pmove state is already in world units.
  cl.predicted_origin[0] = pm.s.origin[0];
  cl.predicted_origin[1] = pm.s.origin[1];
  cl.predicted_origin[2] = pm.s.origin[2];

  VectorCopy(pm.viewangles, cl.predicted_angles);
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

  // predict.c:283 replays every backed-up command through `cgame->Pmove` --
  // the same movement code the server's game module runs. A kex session's
  // cgame owns its movement (kexgame/cgame/cg_main.ts:169); the classic cgame
  // does not, because v3.19 had no cgame at all and Pmove was engine-side.
  // A null here IS the classic family, and falls through to the original
  // vanilla path below untouched.
  const cgamePmove = CG_GetActiveCgamePmove();
  if (cgamePmove) {
    CL_PredictMovementKex(cgamePmove);
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
