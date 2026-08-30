/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_move.c (GNU GPL v2 or later).
*/
// m_move.c -- monster movement

import { anglemod, vec3, vec3_origin, type Vec3, VectorAdd, VectorCopy } from "../shared/math";
import { CONTENTS_SOLID, M_PI, MASK_MONSTERSOLID, MASK_WATER, YAW } from "../shared/q_shared";
import { AI_NOSTEP, FL_FLY, FL_PARTIALGROUND, FL_SWIM, g_edicts, gi, type EdictT } from "./g_local";
import type { Edict } from "./game";
import { G_TouchTriggers } from "./g_utils";

const STEPSIZE = 18;

// `int c_yes, c_no;` -- file-scope debug counters. Nothing else in baseq2
// reads them (confirmed by grep across game/*.c); kept as module-private
// state rather than dropped, since they are still incremented by the ported
// logic below.
let c_yes = 0;
let c_no = 0;

// trace_t.ent recovery idiom (see g_phys.ts's traceEdict): sv_world.c
// defaults an unset trace.ent to the world edict, never NULL, so a null
// GTraceT.ent here falls back to g_edicts[0] the same way.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/*
=============
M_CheckBottom

Returns false if any part of the bottom of the entity is off an edge that
is not a staircase.

=============
*/
export function M_CheckBottom(ent: EdictT): boolean {
  const mins = vec3();
  const maxs = vec3();
  const start = vec3();
  const stop = vec3();

  VectorAdd(ent.s.origin, ent.mins, mins);
  VectorAdd(ent.s.origin, ent.maxs, maxs);

  // if all of the points under the corners are solid world, don't bother
  // with the tougher checks
  // the corners must be within 16 of the midpoint
  start[2] = mins[2] - 1;
  let allCornersSolid = true;
  for (let x = 0; x <= 1 && allCornersSolid; x++) {
    for (let y = 0; y <= 1 && allCornersSolid; y++) {
      start[0] = x ? maxs[0] : mins[0];
      start[1] = y ? maxs[1] : mins[1];
      if (gi.pointcontents(start) !== CONTENTS_SOLID) {
        allCornersSolid = false;
      }
    }
  }

  if (allCornersSolid) {
    c_yes++;
    return true; // we got out easy
  }

  c_no++;
  //
  // check it for real...
  //
  start[2] = mins[2];

  // the midpoint must be within 16 of the bottom
  start[0] = (mins[0] + maxs[0]) * 0.5;
  stop[0] = start[0];
  start[1] = (mins[1] + maxs[1]) * 0.5;
  stop[1] = start[1];
  stop[2] = start[2] - 2 * STEPSIZE;
  let trace = gi.trace(start, vec3_origin, vec3_origin, stop, ent, MASK_MONSTERSOLID);

  if (trace.fraction === 1.0) return false;
  let bottom = trace.endpos[2];
  const mid = bottom;

  // the corners must be within 16 of the midpoint
  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      start[0] = x ? maxs[0] : mins[0];
      stop[0] = start[0];
      start[1] = y ? maxs[1] : mins[1];
      stop[1] = start[1];

      trace = gi.trace(start, vec3_origin, vec3_origin, stop, ent, MASK_MONSTERSOLID);

      if (trace.fraction !== 1.0 && trace.endpos[2] > bottom) bottom = trace.endpos[2];
      if (trace.fraction === 1.0 || mid - trace.endpos[2] > STEPSIZE) return false;
    }
  }

  c_yes++;
  return true;
}

/*
=============
SV_movestep

Called by monster program code.
The move will be adjusted for slopes and stairs, but if the move isn't
possible, no move is done, false is returned, and
pr_global_struct->trace_normal is set to the normal of the blocking wall
=============
*/
// FIXME since we need to test end position contents here, can we avoid doing
// it again later in catagorize position?
function SV_movestep(ent: EdictT, move: Vec3, relink: boolean): boolean {
  const oldorg = vec3();
  const neworg = vec3();
  const end = vec3();
  const test = vec3();

  // try the move
  VectorCopy(ent.s.origin, oldorg);
  VectorAdd(ent.s.origin, move, neworg);

  // flying monsters don't step up
  if (ent.flags & (FL_SWIM | FL_FLY)) {
    // try one move with vertical motion, then one without
    for (let i = 0; i < 2; i++) {
      VectorAdd(ent.s.origin, move, neworg);
      if (i === 0 && ent.enemy) {
        if (!ent.goalentity) ent.goalentity = ent.enemy;
        const dz = ent.s.origin[2] - ent.goalentity.s.origin[2];
        if (ent.goalentity.client) {
          if (dz > 40) neworg[2] -= 8;
          if (!(ent.flags & FL_SWIM && ent.waterlevel < 2)) if (dz < 30) neworg[2] += 8;
        } else if (ent.classname === "monster_fixbot") {
          // xatrix/m_move.c: `// RAFAEL` -- fixbot uses a wider vertical
          // step tolerance while flying, keyed off its current anim frame
          // (m_fixbot.ts, owned by the sibling XA-monsters unit).
          if (ent.s.frame >= 105 && ent.s.frame <= 120) {
            if (dz > 12) neworg[2] -= 1;
            else if (dz < -12) neworg[2] += 1;
          } else if (ent.s.frame >= 31 && ent.s.frame <= 88) {
            if (dz > 12) neworg[2] -= 12;
            else if (dz < -12) neworg[2] += 12;
          } else {
            if (dz > 12) neworg[2] -= 8;
            else if (dz < -12) neworg[2] += 8;
          }
        } else {
          if (dz > 8) neworg[2] -= 8;
          else if (dz > 0) neworg[2] -= dz;
          else if (dz < -8) neworg[2] += 8;
          else neworg[2] += dz;
        }
      }
      const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, neworg, ent, MASK_MONSTERSOLID);

      // fly monsters don't enter water voluntarily
      if (ent.flags & FL_FLY) {
        if (!ent.waterlevel) {
          test[0] = trace.endpos[0];
          test[1] = trace.endpos[1];
          test[2] = trace.endpos[2] + ent.mins[2] + 1;
          const contents = gi.pointcontents(test);
          if (contents & MASK_WATER) return false;
        }
      }

      // swim monsters don't exit water voluntarily
      if (ent.flags & FL_SWIM) {
        if (ent.waterlevel < 2) {
          test[0] = trace.endpos[0];
          test[1] = trace.endpos[1];
          test[2] = trace.endpos[2] + ent.mins[2] + 1;
          const contents = gi.pointcontents(test);
          if (!(contents & MASK_WATER)) return false;
        }
      }

      if (trace.fraction === 1) {
        VectorCopy(trace.endpos, ent.s.origin);
        if (relink) {
          gi.linkentity(ent);
          G_TouchTriggers(ent);
        }
        return true;
      }

      if (!ent.enemy) break;
    }

    return false;
  }

  // push down from a step height above the wished position
  const stepsize = ent.monsterinfo.aiflags & AI_NOSTEP ? 1 : STEPSIZE;

  neworg[2] += stepsize;
  VectorCopy(neworg, end);
  end[2] -= stepsize * 2;

  let trace = gi.trace(neworg, ent.mins, ent.maxs, end, ent, MASK_MONSTERSOLID);

  if (trace.allsolid) return false;

  if (trace.startsolid) {
    neworg[2] -= stepsize;
    trace = gi.trace(neworg, ent.mins, ent.maxs, end, ent, MASK_MONSTERSOLID);
    if (trace.allsolid || trace.startsolid) return false;
  }

  // don't go in to water
  if (ent.waterlevel === 0) {
    test[0] = trace.endpos[0];
    test[1] = trace.endpos[1];
    test[2] = trace.endpos[2] + ent.mins[2] + 1;
    const contents = gi.pointcontents(test);

    if (contents & MASK_WATER) return false;
  }

  if (trace.fraction === 1) {
    // if monster had the ground pulled out, go ahead and fall
    if (ent.flags & FL_PARTIALGROUND) {
      VectorAdd(ent.s.origin, move, ent.s.origin);
      if (relink) {
        gi.linkentity(ent);
        G_TouchTriggers(ent);
      }
      ent.groundentity = null;
      return true;
    }

    return false; // walked off an edge
  }

  // check point traces down for dangling corners
  VectorCopy(trace.endpos, ent.s.origin);

  if (!M_CheckBottom(ent)) {
    if (ent.flags & FL_PARTIALGROUND) {
      // entity had floor mostly pulled out from underneath it
      // and is trying to correct
      if (relink) {
        gi.linkentity(ent);
        G_TouchTriggers(ent);
      }
      return true;
    }
    VectorCopy(oldorg, ent.s.origin);
    return false;
  }

  if (ent.flags & FL_PARTIALGROUND) {
    ent.flags &= ~FL_PARTIALGROUND;
  }
  ent.groundentity = traceEdict(trace.ent);
  ent.groundentity_linkcount = ent.groundentity.linkcount;

  // the move is ok
  if (relink) {
    gi.linkentity(ent);
    G_TouchTriggers(ent);
  }
  return true;
}

/*
======================
SV_StepDirection

Turns to the movement direction, and walks the current distance if
facing it.

======================
*/
function SV_StepDirection(ent: EdictT, yawIn: number, dist: number): boolean {
  const oldorigin = vec3();

  ent.ideal_yaw = yawIn;
  M_ChangeYaw(ent);

  const yaw = (yawIn * M_PI * 2) / 360;
  const move = vec3(Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0);

  VectorCopy(ent.s.origin, oldorigin);
  if (SV_movestep(ent, move, false)) {
    const delta = ent.s.angles[YAW] - ent.ideal_yaw;
    if (delta > 45 && delta < 315) {
      // not turned far enough, so don't take the step
      VectorCopy(oldorigin, ent.s.origin);
    }
    gi.linkentity(ent);
    G_TouchTriggers(ent);
    return true;
  }
  gi.linkentity(ent);
  G_TouchTriggers(ent);
  return false;
}

/*
======================
SV_FixCheckBottom

======================
*/
function SV_FixCheckBottom(ent: EdictT): void {
  ent.flags |= FL_PARTIALGROUND;
}

/*
================
SV_NewChaseDir

================
*/
const DI_NODIR = -1;

function SV_NewChaseDir(actor: EdictT, enemy: EdictT | null, dist: number): void {
  // FIXME: how did we get here with no enemy
  if (!enemy) return;

  const olddir = anglemod(Math.trunc(actor.ideal_yaw / 45) * 45);
  const turnaround = anglemod(olddir - 180);

  const deltax = enemy.s.origin[0] - actor.s.origin[0];
  const deltay = enemy.s.origin[1] - actor.s.origin[1];
  const d: [number, number, number] = [0, 0, 0];
  if (deltax > 10) d[1] = 0;
  else if (deltax < -10) d[1] = 180;
  else d[1] = DI_NODIR;
  if (deltay < -10) d[2] = 270;
  else if (deltay > 10) d[2] = 90;
  else d[2] = DI_NODIR;

  // try direct route
  if (d[1] !== DI_NODIR && d[2] !== DI_NODIR) {
    let tdir: number;
    if (d[1] === 0) tdir = d[2] === 90 ? 45 : 315;
    else tdir = d[2] === 90 ? 135 : 215;

    if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist)) return;
  }

  // try other directions
  if ((Math.floor(Math.random() * 4) & 1) !== 0 || Math.abs(deltay) > Math.abs(deltax)) {
    const tdir = d[1];
    d[1] = d[2];
    d[2] = tdir;
  }

  if (d[1] !== DI_NODIR && d[1] !== turnaround && SV_StepDirection(actor, d[1], dist)) return;

  if (d[2] !== DI_NODIR && d[2] !== turnaround && SV_StepDirection(actor, d[2], dist)) return;

  /* there is no direct path to the player, so pick another direction */

  if (olddir !== DI_NODIR && SV_StepDirection(actor, olddir, dist)) return;

  if (Math.floor(Math.random() * 2) & 1) {
    /* randomly determine direction of search */
    for (let tdir = 0; tdir <= 315; tdir += 45) {
      if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist)) return;
    }
  } else {
    for (let tdir = 315; tdir >= 0; tdir -= 45) {
      if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist)) return;
    }
  }

  if (turnaround !== DI_NODIR && SV_StepDirection(actor, turnaround, dist)) return;

  actor.ideal_yaw = olddir; // can't move

  // if a bridge was pulled out from underneath a monster, it may not have
  // a valid standing position at all

  if (!M_CheckBottom(actor)) SV_FixCheckBottom(actor);
}

/*
======================
SV_CloseEnough

======================
*/
function SV_CloseEnough(ent: EdictT, goal: EdictT, dist: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (goal.absmin[i] > ent.absmax[i] + dist) return false;
    if (goal.absmax[i] < ent.absmin[i] - dist) return false;
  }
  return true;
}

/*
======================
M_MoveToGoal
======================
*/
export function M_MoveToGoal(ent: EdictT, dist: number): void {
  const goal = ent.goalentity;

  if (!ent.groundentity && !(ent.flags & (FL_FLY | FL_SWIM))) return;

  // if the next step hits the enemy, return immediately
  if (ent.enemy && SV_CloseEnough(ent, ent.enemy, dist)) return;

  // bump around...
  if (Math.floor(Math.random() * 4) === 1 || !SV_StepDirection(ent, ent.ideal_yaw, dist)) {
    if (ent.inuse) SV_NewChaseDir(ent, goal, dist);
  }
}

/*
===============
M_ChangeYaw

===============
*/
export function M_ChangeYaw(ent: EdictT): void {
  const current = anglemod(ent.s.angles[YAW]);
  const ideal = ent.ideal_yaw;

  if (current === ideal) return;

  let move = ideal - current;
  const speed = ent.yaw_speed;
  if (ideal > current) {
    if (move >= 180) move = move - 360;
  } else {
    if (move <= -180) move = move + 360;
  }
  if (move > 0) {
    if (move > speed) move = speed;
  } else {
    if (move < -speed) move = -speed;
  }

  ent.s.angles[YAW] = anglemod(current + move);
}

/*
===============
M_walkmove
===============
*/
export function M_walkmove(ent: EdictT, yawIn: number, dist: number): boolean {
  if (!ent.groundentity && !(ent.flags & (FL_FLY | FL_SWIM))) return false;

  const yaw = (yawIn * M_PI * 2) / 360;

  const move = vec3(Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0);

  return SV_movestep(ent, move, true);
}
