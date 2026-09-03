/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.
Ported from rogue/m_move2.c (GNU GPL v2 or later), via src/rogue/m_move2.ts.

rogue/m_move2.c is a modified copy of baseq2/m_move.c, and a near-duplicate
sibling of rogue/m_move.c (ported at src/game/m_move.ts) -- both files define
the same-named M_ChangeYaw/M_MoveToGoal/M_walkmove/etc. functions, but as
separate modules the carrier/widow/stalker-family monsters import from this
one specifically. Deltas applied on top of the base m_move.c port:
  - M_CheckBottom: gravity-relative probe direction (still only handles
    the +/-Z gravity vectors the C FIXME calls out).
  - SV_movestep: CheckForBadArea() tesla-avoidance wrapper around the whole
    step, a carrier-specific minheight of 104 (vs 40) for airborne monsters
    tracking a client goalentity, gravity-relative step trace, and a second
    CheckForBadArea() re-check after the point-trace lands plus tesla
    dprintf diagnostics gated on g_showlogic.
  - SV_StepDirection: `monster_widow*` classnames skip the "didn't turn far
    enough" undo.
  - SV_NewChaseDir: falls through to monsterinfo.blocked(actor, dist) when
    no cardinal direction works, and AI_CHARGING monsters never deflect
    randomly -- both are rogue-only hooks.

This file is entirely new (not merged into src/game/m_move.ts), and is only
imported by this porting round's carrier/widow/stalker files, so none of the
above interacts with classic monster movement at all.

Deviation: the C's `else if (!strcmp(ent->enemy->classname, "telsa"))` is a
genuine id/Rogue typo -- "telsa" never matches "tesla", so that branch is
unreachable in the shipped binary. Preserved dead, per PORTING.md's
bug-for-bug fidelity rule, rather than "fixed" to "tesla".
*/
// m_move.c -- monster movement

import { anglemod, vec3, vec3_origin, type Vec3, VectorAdd, VectorCopy, VectorMA, VectorScale } from "../shared/math";
import { CONTENTS_SOLID, M_PI, MASK_MONSTERSOLID, MASK_WATER, YAW } from "../shared/q_shared";
import { AI_CHARGING, AI_NOSTEP, FL_FLY, FL_PARTIALGROUND, FL_SWIM, g_edicts, gameCvars, gi, type EdictT } from "./g_local";
import type { Edict } from "./game";
import { CheckForBadArea } from "./g_newai";
import { FoundTarget, visible } from "./g_ai";
import { G_TouchTriggers } from "./g_utils";

const STEPSIZE = 18;

// `int c_yes, c_no;` -- file-scope debug counters. Nothing else in rogue
// reads them (mirrors src/game/m_move.ts's identical finding for baseq2);
// kept as module-private state rather than dropped, since they are still
// incremented by the ported logic below.
let c_yes = 0;
let c_no = 0;

// this is used for communications out of SV_movestep to say what entity
// is blocking us. Nothing outside this file reads it in the C source; kept
// as module state for fidelity.
let new_bad: EdictT | null = null;

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
  //
  // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
  start[2] = mins[2] - 1;
  if (ent.gravityVector[2] > 0) start[2] = maxs[2] + 1;

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

  if (ent.gravityVector[2] < 0) {
    start[2] = mins[2];
    stop[2] = start[2] - STEPSIZE - STEPSIZE;
  } else {
    start[2] = maxs[2];
    stop[2] = start[2] + STEPSIZE + STEPSIZE;
  }

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

      // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
      if (ent.gravityVector[2] > 0) {
        if (trace.fraction !== 1.0 && trace.endpos[2] < bottom) bottom = trace.endpos[2];
        if (trace.fraction === 1.0 || trace.endpos[2] - mid > STEPSIZE) return false;
      } else {
        if (trace.fraction !== 1.0 && trace.endpos[2] > bottom) bottom = trace.endpos[2];
        if (trace.fraction === 1.0 || mid - trace.endpos[2] > STEPSIZE) return false;
      }
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

  //======
  //PGM
  const current_bad = CheckForBadArea(ent);
  if (current_bad) {
    ent.bad_area = current_bad;

    if (ent.enemy && ent.enemy.classname === "tesla") {
      VectorScale(move, -1, move);
    }
  } else if (ent.bad_area) {
    // if we're no longer in a bad area, get back to business.
    ent.bad_area = null;
    if (ent.oldenemy) {
      ent.enemy = ent.oldenemy;
      ent.goalentity = ent.oldenemy;
      FoundTarget(ent);
      return true;
    }
  }
  //PGM
  //======

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
          // we want the carrier to stay a certain distance off the ground, to help prevent him
          // from shooting his fliers, who spawn in below him
          const minheight = ent.classname === "monster_carrier" ? 104 : 40;
          if (dz > minheight) neworg[2] -= 8;
          if (!(ent.flags & FL_SWIM && ent.waterlevel < 2)) if (dz < minheight - 10) neworg[2] += 8;
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

      // PMM - changed from a bare `trace.fraction == 1` check to also
      // require !allsolid && !startsolid.
      if (trace.fraction === 1 && !trace.allsolid && !trace.startsolid) {
        VectorCopy(trace.endpos, ent.s.origin);
        //=====
        //PGM
        if (!current_bad && CheckForBadArea(ent)) {
          VectorCopy(oldorg, ent.s.origin);
        } else {
          if (relink) {
            gi.linkentity(ent);
            G_TouchTriggers(ent);
          }
          return true;
        }
        //PGM
        //=====
      }

      if (!ent.enemy) break;
    }

    return false;
  }

  // push down from a step height above the wished position
  const stepsize = ent.monsterinfo.aiflags & AI_NOSTEP ? 1 : STEPSIZE;

  // trace from 1 stepsize gravityUp to 2 stepsize gravityDown.
  VectorMA(neworg, -1 * stepsize, ent.gravityVector, neworg);
  VectorMA(neworg, 2 * stepsize, ent.gravityVector, end);

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
    test[2] = ent.gravityVector[2] > 0 ? trace.endpos[2] + ent.maxs[2] - 1 : trace.endpos[2] + ent.mins[2] + 1;
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

  //PGM
  new_bad = CheckForBadArea(ent);
  if (!current_bad && new_bad) {
    if (new_bad.owner) {
      const g_showlogic = gameCvars.g_showlogic;
      if (g_showlogic && g_showlogic.value) gi.dprintf("Blocked -");
      if (new_bad.owner.classname === "tesla") {
        if (g_showlogic && g_showlogic.value) gi.dprintf("it's a tesla -");
        if (!ent.enemy || !ent.enemy.inuse) {
          if (g_showlogic && g_showlogic.value) gi.dprintf("I don't have a valid enemy!\n");
        } else if (ent.enemy.classname === "telsa") {
          // C typo preserved: "telsa" never matches "tesla", so this
          // branch is dead in the original -- kept dead here too.
          if (g_showlogic && g_showlogic.value) gi.dprintf("but we're already mad at a tesla\n");
        } else if (ent.enemy && ent.enemy.client) {
          if (g_showlogic && g_showlogic.value) gi.dprintf("we have a player enemy -");
          if (visible(ent, ent.enemy)) {
            if (g_showlogic && g_showlogic.value) gi.dprintf("we can see him -");
          } else {
            if (g_showlogic && g_showlogic.value) gi.dprintf("can't see him, kill the tesla! -");
          }
        } else {
          if (g_showlogic && g_showlogic.value) gi.dprintf("the enemy isn't a player -");
        }
      }
    }
    gi.dprintf("\n");

    VectorCopy(oldorg, ent.s.origin);
    return false;
  }
  //PGM

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
======================
SV_StepDirection

Turns to the movement direction, and walks the current distance if
facing it.

======================
*/
function SV_StepDirection(ent: EdictT, yawIn: number, dist: number): boolean {
  const oldorigin = vec3();

  // PGM g_touchtrigger free problem
  if (!ent.inuse) return true;

  ent.ideal_yaw = yawIn;
  M_ChangeYaw(ent);

  const yaw = (yawIn * M_PI * 2) / 360;
  const move = vec3(Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0);

  VectorCopy(ent.s.origin, oldorigin);
  if (SV_movestep(ent, move, false)) {
    // PGM g_touchtrigger free problem
    if (!ent.inuse) return true;

    const delta = ent.s.angles[YAW] - ent.ideal_yaw;
    // widow bosses can turn as far as they need to without losing the step
    if (!(ent.classname !== null && ent.classname.startsWith("monster_widow"))) {
      if (delta > 45 && delta < 315) {
        // not turned far enough, so don't take the step
        VectorCopy(oldorigin, ent.s.origin);
      }
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

  //ROGUE
  if (actor.monsterinfo.blocked) {
    if (actor.monsterinfo.blocked(actor, dist)) return;
  }
  //ROGUE

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
  // PMM - charging monsters (AI_CHARGING) don't deflect unless they have to
  if (
    (Math.floor(Math.random() * 4) === 1 && !(ent.monsterinfo.aiflags & AI_CHARGING)) ||
    !SV_StepDirection(ent, ent.ideal_yaw, dist)
  ) {
    if (ent.inuse) SV_NewChaseDir(ent, goal, dist);
  }
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
