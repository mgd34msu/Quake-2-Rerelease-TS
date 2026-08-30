// g_func.c
//
// rogue/g_func.c vs baseq2/g_func.c: a large delta layered onto the base
// port (src/game/g_func.ts) rather than a from-scratch port. Real changes:
// - `func_plat`/new `func_plat2`: rogue adds a "danger area" concept (a
//   temporary bad_area edict spawned while a plat is rising, so monster AI
//   avoids walking under it) via `SpawnBadArea`/`plat2_kill_danger_area`.
//   `SpawnBadArea` is implemented in g_newai.c (RG-systems' SCOPE, outside
//   this unit) -- imported here as `./g_newai`. `func_plat2` is an entirely
//   new entity type (toggle/box-lift/trigger-top/trigger-bottom variants);
//   `plat_spawn_inside_trigger` changes return type from void to the
//   spawned trigger edict so func_plat2's spawn function can further adjust
//   its bounds and touch function.
// - `func_rotating` gains optional acceleration/deceleration (spawnflag
//   8192) via new `rotating_accel`/`rotating_decel` helpers, and now fires
//   G_UseTargets on every start/stop (base only did this implicitly via the
//   plat/door idiom, base func_rotating never called G_UseTargets at all).
// - `func_door`/`func_door_rotating` gain `Door_Activate` (spawnflag
//   DOOR_INACTIVE = 8192: door starts inert until triggered) and
//   `func_door`'s `door_use` special-cases "smart water" (a func_water
//   with the SMART spawnflag, which reassigns its own classname to
//   "func_door" and reuses door_use/door_blocked): if the door's center is
//   inside a water/lava volume and spawnflag bit 2 is set, `door_use`
//   dispatches to the new `smart_water_go_up`/`smart_water_blocked`
//   instead of the normal door-pair trigger loop.
// - `func_train` pieces can now be linked via `team` so slave pieces move
//   in lockstep with the master (`train_next`'s new team-sync block,
//   `train_piece_wait` no-op endfunc for slaves); a path_corner's own
//   "speed"/"accel"/"decel" can now override the train's moveinfo per-leg;
//   `train_wait`'s TRAIN_TOGGLE branch no longer calls `train_next()`
//   directly -- it clears `target_ent` and lets the next `train_use` call
//   pick up from `train_resume`'s null-target_ent fallback (train_next).
// - `Think_AccelMove` unconditionally recalculates the accelerated-move
//   profile every frame instead of only when `current_speed === 0`
//   (rogue/g_func.c comments out the `if` -- "PGM 04/21/98 - this should
//   fix sthoms' sinking drop pod"), a genuine rogue behavior change from
//   base, preserved bug-for-bug.
// - `AngleMove_Begin`/`AngleMove_Calc` gain the same kind of acceleration
//   support as plats (`ent.accel` ramps `ent.moveinfo.speed` up to
//   `ent.speed` before switching from re-thinking every frame to a single
//   final-frame think), used by accelerating `func_door_rotating`s.
// - Four blocked-callbacks (`plat_blocked`, `door_blocked`, `train_blocked`,
//   `door_secret_blocked`) add an `other.inuse` check before calling
//   `BecomeExplosion1` (the earlier `T_Damage` call may have already freed
//   `other`); `plat2_blocked`/`smart_water_blocked` are new and carry the
//   same check from the start.
//
// registerSaveFunction/registerSaveMmove calls are dropped for this pack
// port, matching src/ctf/g_func.ts's convention (rogue's g_save.ts is not
// yet ported by any unit; no sibling rogue file in this effort registers
// save functions either).

import {
  AddPointToBounds,
  AngleVectors,
  DotProduct,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCompare,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNegate,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
  crandom,
} from "../shared/math";
import {
  ATTN_NORM,
  ATTN_STATIC,
  CHAN_AUTO,
  CHAN_NO_PHS_ADD,
  CHAN_VOICE,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  EF_ANIM01,
  EF_ANIM23,
  EF_ANIM_ALL,
  EF_ANIM_ALLFAST,
  EntityEventT,
  MASK_WATER,
  Q_stricmp,
} from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { SolidT, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  DamageT,
  type EdictT,
  FL_TEAMSLAVE,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
  MOD_CRUSH,
  MOD_LAVA,
  type MoveinfoT,
  MovetypeT,
  st,
} from "./g_local";
import { BecomeExplosion1 } from "./g_misc";
import { SpawnBadArea } from "./g_newai";
import { G_Find, G_FreeEdict, G_PickTarget, G_SetMovedir, G_Spawn, G_UseTargets, KillBox, vtos } from "./g_utils";

const PLAT_LOW_TRIGGER = 1;

// ROGUE
const PLAT2_TOGGLE = 2;
const PLAT2_TOP = 4;
const PLAT2_TRIGGER_TOP = 8;
const PLAT2_TRIGGER_BOTTOM = 16;
const PLAT2_BOX_LIFT = 32;
// PLAT2_TRIGGER_TOP/PLAT2_TRIGGER_BOTTOM are declared in rogue/g_func.c and
// documented on func_plat2's QUAKED line but never actually tested anywhere
// in the shipped .c file (plat2_hit_top/plat2_hit_bottom always call
// G_UseTargets unconditionally) -- dead editor flags, preserved bug-for-bug.
// ROGUE

const STATE_TOP = 0;
const STATE_BOTTOM = 1;
const STATE_UP = 2;
const STATE_DOWN = 3;

const DOOR_START_OPEN = 1;
const DOOR_REVERSE = 2;
const DOOR_CRUSHER = 4;
const DOOR_NOMONSTER = 8;
const DOOR_TOGGLE = 32;
const DOOR_X_AXIS = 64;
const DOOR_Y_AXIS = 128;
// ROGUE
const DOOR_INACTIVE = 8192;
// ROGUE

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

//
// Support routines for movement (changes in origin using velocity)
//

function Move_Done(ent: EdictT): void {
  VectorClear(ent.velocity);
  if (ent.moveinfo.endfunc) ent.moveinfo.endfunc(ent);
}

function Move_Final(ent: EdictT): void {
  if (ent.moveinfo.remaining_distance === 0) {
    Move_Done(ent);
    return;
  }

  VectorScale(ent.moveinfo.dir, ent.moveinfo.remaining_distance / FRAMETIME, ent.velocity);

  ent.think = Move_Done;
  ent.nextthink = level.time + FRAMETIME;
}

function Move_Begin(ent: EdictT): void {
  if (ent.moveinfo.speed * FRAMETIME >= ent.moveinfo.remaining_distance) {
    Move_Final(ent);
    return;
  }
  VectorScale(ent.moveinfo.dir, ent.moveinfo.speed, ent.velocity);
  const frames = Math.floor(ent.moveinfo.remaining_distance / ent.moveinfo.speed / FRAMETIME);
  ent.moveinfo.remaining_distance -= frames * ent.moveinfo.speed * FRAMETIME;
  ent.nextthink = level.time + frames * FRAMETIME;
  ent.think = Move_Final;
}

export function Move_Calc(ent: EdictT, dest: Vec3, func: (self: EdictT) => void): void {
  VectorClear(ent.velocity);
  VectorSubtract(dest, ent.s.origin, ent.moveinfo.dir);
  ent.moveinfo.remaining_distance = VectorNormalize(ent.moveinfo.dir);
  ent.moveinfo.endfunc = func;

  if (ent.moveinfo.speed === ent.moveinfo.accel && ent.moveinfo.speed === ent.moveinfo.decel) {
    if (level.current_entity === ((ent.flags & FL_TEAMSLAVE) !== 0 ? ent.teammaster : ent)) {
      Move_Begin(ent);
    } else {
      ent.nextthink = level.time + FRAMETIME;
      ent.think = Move_Begin;
    }
  } else {
    // accelerative
    ent.moveinfo.current_speed = 0;
    ent.think = Think_AccelMove;
    ent.nextthink = level.time + FRAMETIME;
  }
}

//
// Support routines for angular movement (changes in angle using avelocity)
//

function AngleMove_Done(ent: EdictT): void {
  VectorClear(ent.avelocity);
  if (ent.moveinfo.endfunc) ent.moveinfo.endfunc(ent);
}

function AngleMove_Final(ent: EdictT): void {
  const move = vec3();

  if (ent.moveinfo.state === STATE_UP) VectorSubtract(ent.moveinfo.end_angles, ent.s.angles, move);
  else VectorSubtract(ent.moveinfo.start_angles, ent.s.angles, move);

  if (VectorCompare(move, vec3_origin) !== 0) {
    AngleMove_Done(ent);
    return;
  }

  VectorScale(move, 1.0 / FRAMETIME, ent.avelocity);

  ent.think = AngleMove_Done;
  ent.nextthink = level.time + FRAMETIME;
}

function AngleMove_Begin(ent: EdictT): void {
  const destdelta = vec3();

  // ROGUE -- accelerate as needed
  if (ent.moveinfo.speed < ent.speed) {
    ent.moveinfo.speed += ent.accel;
    if (ent.moveinfo.speed > ent.speed) ent.moveinfo.speed = ent.speed;
  }
  // ROGUE

  // set destdelta to the vector needed to move
  if (ent.moveinfo.state === STATE_UP) VectorSubtract(ent.moveinfo.end_angles, ent.s.angles, destdelta);
  else VectorSubtract(ent.moveinfo.start_angles, ent.s.angles, destdelta);

  // calculate length of vector
  const len = VectorLength(destdelta);

  // divide by speed to get time to reach dest
  const traveltime = len / ent.moveinfo.speed;

  if (traveltime < FRAMETIME) {
    AngleMove_Final(ent);
    return;
  }

  const frames = Math.floor(traveltime / FRAMETIME);

  // scale the destdelta vector by the time spent traveling to get velocity
  VectorScale(destdelta, 1.0 / traveltime, ent.avelocity);

  // ROGUE -- if we're done accelerating, act as a normal rotation
  if (ent.moveinfo.speed >= ent.speed) {
    // set nextthink to trigger a think when dest is reached
    ent.nextthink = level.time + frames * FRAMETIME;
    ent.think = AngleMove_Final;
  } else {
    ent.nextthink = level.time + FRAMETIME;
    ent.think = AngleMove_Begin;
  }
  // ROGUE
}

function AngleMove_Calc(ent: EdictT, func: (self: EdictT) => void): void {
  VectorClear(ent.avelocity);
  ent.moveinfo.endfunc = func;

  // ROGUE -- if we're supposed to accelerate, this will tell AngleMove_Begin to do so
  if (ent.accel !== ent.speed) ent.moveinfo.speed = 0;
  // ROGUE

  if (level.current_entity === ((ent.flags & FL_TEAMSLAVE) !== 0 ? ent.teammaster : ent)) {
    AngleMove_Begin(ent);
  } else {
    ent.nextthink = level.time + FRAMETIME;
    ent.think = AngleMove_Begin;
  }
}

/*
==============
Think_AccelMove

The team has completed a frame of movement, so
change the speed for the next frame
==============
*/
function AccelerationDistance(target: number, rate: number): number {
  return (target * (target / rate + 1)) / 2;
}

function plat_CalcAcceleratedMove(moveinfo: MoveinfoT): void {
  moveinfo.move_speed = moveinfo.speed;

  if (moveinfo.remaining_distance < moveinfo.accel) {
    moveinfo.current_speed = moveinfo.remaining_distance;
    return;
  }

  const accel_dist = AccelerationDistance(moveinfo.speed, moveinfo.accel);
  let decel_dist = AccelerationDistance(moveinfo.speed, moveinfo.decel);

  if (moveinfo.remaining_distance - accel_dist - decel_dist < 0) {
    const f = (moveinfo.accel + moveinfo.decel) / (moveinfo.accel * moveinfo.decel);
    moveinfo.move_speed = (-2 + Math.sqrt(4 - 4 * f * (-2 * moveinfo.remaining_distance))) / (2 * f);
    decel_dist = AccelerationDistance(moveinfo.move_speed, moveinfo.decel);
  }

  moveinfo.decel_distance = decel_dist;
}

function plat_Accelerate(moveinfo: MoveinfoT): void {
  // are we decelerating?
  if (moveinfo.remaining_distance <= moveinfo.decel_distance) {
    if (moveinfo.remaining_distance < moveinfo.decel_distance) {
      if (moveinfo.next_speed) {
        moveinfo.current_speed = moveinfo.next_speed;
        moveinfo.next_speed = 0;
        return;
      }
      if (moveinfo.current_speed > moveinfo.decel) moveinfo.current_speed -= moveinfo.decel;
    }
    return;
  }

  // are we at full speed and need to start decelerating during this move?
  if (moveinfo.current_speed === moveinfo.move_speed) {
    if (moveinfo.remaining_distance - moveinfo.current_speed < moveinfo.decel_distance) {
      const p1_distance = moveinfo.remaining_distance - moveinfo.decel_distance;
      const p2_distance = moveinfo.move_speed * (1.0 - p1_distance / moveinfo.move_speed);
      const distance = p1_distance + p2_distance;
      moveinfo.current_speed = moveinfo.move_speed;
      moveinfo.next_speed = moveinfo.move_speed - moveinfo.decel * (p2_distance / distance);
      return;
    }
  }

  // are we accelerating?
  if (moveinfo.current_speed < moveinfo.speed) {
    const old_speed = moveinfo.current_speed;

    // figure simple acceleration up to move_speed
    moveinfo.current_speed += moveinfo.accel;
    if (moveinfo.current_speed > moveinfo.speed) moveinfo.current_speed = moveinfo.speed;

    // are we accelerating throughout this entire move?
    if (moveinfo.remaining_distance - moveinfo.current_speed >= moveinfo.decel_distance) return;

    // during this move we will accelrate from current_speed to move_speed
    // and cross over the decel_distance; figure the average speed for the
    // entire move
    const p1_distance = moveinfo.remaining_distance - moveinfo.decel_distance;
    const p1_speed = (old_speed + moveinfo.move_speed) / 2.0;
    const p2_distance = moveinfo.move_speed * (1.0 - p1_distance / p1_speed);
    const distance = p1_distance + p2_distance;
    moveinfo.current_speed = p1_speed * (p1_distance / distance) + moveinfo.move_speed * (p2_distance / distance);
    moveinfo.next_speed = moveinfo.move_speed - moveinfo.decel * (p2_distance / distance);
    return;
  }

  // we are at constant velocity (move_speed)
}

function Think_AccelMove(ent: EdictT): void {
  ent.moveinfo.remaining_distance -= ent.moveinfo.current_speed;

  // ROGUE -- PGM 04/21/98 - this should fix sthoms' sinking drop pod.
  // rogue/g_func.c comments out the `if (current_speed == 0)` guard here,
  // so the accelerated-move profile is now recalculated every frame
  // instead of only when starting/blocked.
  plat_CalcAcceleratedMove(ent.moveinfo);
  // ROGUE

  plat_Accelerate(ent.moveinfo);

  // will the entire move complete on next frame?
  if (ent.moveinfo.remaining_distance <= ent.moveinfo.current_speed) {
    Move_Final(ent);
    return;
  }

  VectorScale(ent.moveinfo.dir, ent.moveinfo.current_speed * 10, ent.velocity);
  ent.nextthink = level.time + FRAMETIME;
  ent.think = Think_AccelMove;
}

function plat_hit_top(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_TOP;

  ent.think = plat_go_down;
  ent.nextthink = level.time + 3;
}

function plat_hit_bottom(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_BOTTOM;

  plat2_kill_danger_area(ent); // PGM
}

function plat_go_down(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_DOWN;
  Move_Calc(ent, ent.moveinfo.end_origin, plat_hit_bottom);
}

function plat_go_up(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_UP;
  Move_Calc(ent, ent.moveinfo.start_origin, plat_hit_top);

  plat2_spawn_danger_area(ent); // PGM
}

function plat_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other); // PGM
    return;
  }

  // ROGUE -- gib dead things
  if (other.health < 1) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, 0, MOD_CRUSH);
  }
  // ROGUE

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);

  if (self.moveinfo.state === STATE_UP) plat_go_down(self);
  else if (self.moveinfo.state === STATE_DOWN) plat_go_up(self);
}

function Use_Plat(ent: EdictT, other: EdictT | null, _activator: EdictT | null): void {
  // ROGUE -- if a monster is using us, then allow the activity when stopped.
  if (other !== null && (other.svflags & SVF_MONSTER) !== 0) {
    if (ent.moveinfo.state === STATE_TOP) plat_go_down(ent);
    else if (ent.moveinfo.state === STATE_BOTTOM) plat_go_up(ent);
    return;
  }
  // ROGUE

  if (ent.think) return; // already down
  plat_go_down(ent);
}

function Touch_Plat_Center(ent: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.client === null) return;

  if (other.health <= 0) return;

  const plat = ent.enemy; // now point at the plat, not the trigger
  if (plat === null) return; // guards TS null-safety; always set by plat_spawn_inside_trigger
  if (plat.moveinfo.state === STATE_BOTTOM) plat_go_up(plat);
  else if (plat.moveinfo.state === STATE_TOP) plat.nextthink = level.time + 1; // the player is still on the plat, so delay going down
}

// PGM - plat2's change the trigger field, so this now returns the trigger it spawned.
function plat_spawn_inside_trigger(ent: EdictT): EdictT {
  //
  // middle trigger
  //
  const trigger = G_Spawn();
  trigger.touch = Touch_Plat_Center;
  trigger.movetype = MovetypeT.MOVETYPE_NONE;
  trigger.solid = SolidT.SOLID_TRIGGER;
  trigger.enemy = ent;

  const tmin = vec3();
  const tmax = vec3();

  tmin[0] = ent.mins[0] + 25;
  tmin[1] = ent.mins[1] + 25;
  tmin[2] = ent.mins[2];

  tmax[0] = ent.maxs[0] - 25;
  tmax[1] = ent.maxs[1] - 25;
  tmax[2] = ent.maxs[2] + 8;

  tmin[2] = tmax[2] - (ent.pos1[2] - ent.pos2[2] + st.lip);

  if ((ent.spawnflags & PLAT_LOW_TRIGGER) !== 0) tmax[2] = tmin[2] + 8;

  if (tmax[0] - tmin[0] <= 0) {
    tmin[0] = (ent.mins[0] + ent.maxs[0]) * 0.5;
    tmax[0] = tmin[0] + 1;
  }
  if (tmax[1] - tmin[1] <= 0) {
    tmin[1] = (ent.mins[1] + ent.maxs[1]) * 0.5;
    tmax[1] = tmin[1] + 1;
  }

  VectorCopy(tmin, trigger.mins);
  VectorCopy(tmax, trigger.maxs);

  gi.linkentity(trigger);

  return trigger; // PGM 11/17/97
}

/*QUAKED func_plat (0 .5 .8) ? PLAT_LOW_TRIGGER
speed	default 150

Plats are always drawn in the extended position, so they will light correctly.

If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.

"speed"	overrides default 200.
"accel" overrides default 500
"lip"	overrides default 8 pixel lip

If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determoveinfoned by the model's height.

Set "sounds" to one of the following:
1) base fast
2) chain slow
*/
export function SP_func_plat(ent: EdictT): void {
  VectorClear(ent.s.angles);
  ent.solid = SolidT.SOLID_BSP;
  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = plat_blocked;

  if (!ent.speed) ent.speed = 20;
  else ent.speed *= 0.1;

  if (!ent.accel) ent.accel = 5;
  else ent.accel *= 0.1;

  if (!ent.decel) ent.decel = 5;
  else ent.decel *= 0.1;

  if (!ent.dmg) ent.dmg = 2;

  if (!st.lip) st.lip = 8;

  // pos1 is the top position, pos2 is the bottom
  VectorCopy(ent.s.origin, ent.pos1);
  VectorCopy(ent.s.origin, ent.pos2);
  if (st.height) ent.pos2[2] -= st.height;
  else ent.pos2[2] -= ent.maxs[2] - ent.mins[2] - st.lip;

  ent.use = Use_Plat;

  plat_spawn_inside_trigger(ent); // the "start moving" trigger

  if (ent.targetname !== null) {
    ent.moveinfo.state = STATE_UP;
  } else {
    VectorCopy(ent.pos2, ent.s.origin);
    gi.linkentity(ent);
    ent.moveinfo.state = STATE_BOTTOM;
  }

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  ent.moveinfo.sound_start = gi.soundindex("plats/pt1_strt.wav");
  ent.moveinfo.sound_middle = gi.soundindex("plats/pt1_mid.wav");
  ent.moveinfo.sound_end = gi.soundindex("plats/pt1_end.wav");
}

// ==========================================
// PLAT 2 -- ROGUE
// ==========================================
const PLAT2_CALLED = 1;
const PLAT2_MOVING = 2;
const PLAT2_WAITING = 4;

function plat2_spawn_danger_area(ent: EdictT): void {
  const mins = vec3(ent.mins[0], ent.mins[1], ent.mins[2]);
  const maxs = vec3(ent.maxs[0], ent.maxs[1], ent.maxs[2]);
  maxs[2] = ent.mins[2] + 64;

  SpawnBadArea(mins, maxs, 0, ent);
}

function plat2_kill_danger_area(ent: EdictT): void {
  let t: EdictT | null = null;
  while ((t = G_Find(t, "classname", "bad_area")) !== null) {
    if (t.owner === ent) G_FreeEdict(t);
  }
}

function plat2_hit_top(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_TOP;

  if ((ent.plat2flags & PLAT2_CALLED) !== 0) {
    ent.plat2flags = PLAT2_WAITING;
    if ((ent.spawnflags & PLAT2_TOGGLE) === 0) {
      ent.think = plat2_go_down;
      ent.nextthink = level.time + 5.0;
    }
    if (cvarNum(gameCvars.deathmatch) !== 0) ent.last_move_time = level.time - 1.0;
    else ent.last_move_time = level.time - 2.0;
  } else if ((ent.spawnflags & PLAT2_TOP) === 0 && (ent.spawnflags & PLAT2_TOGGLE) === 0) {
    ent.plat2flags = 0;
    ent.think = plat2_go_down;
    ent.nextthink = level.time + 2.0;
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = 0;
    ent.last_move_time = level.time;
  }

  G_UseTargets(ent, ent);
}

function plat2_hit_bottom(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_BOTTOM;

  if ((ent.plat2flags & PLAT2_CALLED) !== 0) {
    ent.plat2flags = PLAT2_WAITING;
    if ((ent.spawnflags & PLAT2_TOGGLE) === 0) {
      ent.think = plat2_go_up;
      ent.nextthink = level.time + 5.0;
    }
    if (cvarNum(gameCvars.deathmatch) !== 0) ent.last_move_time = level.time - 1.0;
    else ent.last_move_time = level.time - 2.0;
  } else if ((ent.spawnflags & PLAT2_TOP) !== 0 && (ent.spawnflags & PLAT2_TOGGLE) === 0) {
    ent.plat2flags = 0;
    ent.think = plat2_go_up;
    ent.nextthink = level.time + 2.0;
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = 0;
    ent.last_move_time = level.time;
  }

  plat2_kill_danger_area(ent);
  G_UseTargets(ent, ent);
}

function plat2_go_down(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_DOWN;
  ent.plat2flags |= PLAT2_MOVING;

  Move_Calc(ent, ent.moveinfo.end_origin, plat2_hit_bottom);
}

function plat2_go_up(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_UP;
  ent.plat2flags |= PLAT2_MOVING;

  plat2_spawn_danger_area(ent);

  Move_Calc(ent, ent.moveinfo.start_origin, plat2_hit_top);
}

function plat2_operate(triggerEnt: EdictT, other: EdictT): void {
  const trigger = triggerEnt;
  const plat = triggerEnt.enemy; // now point at the plat, not the trigger
  if (plat === null) return; // guards TS null-safety; always set when trigger.touch === Touch_Plat_Center2

  if ((plat.plat2flags & PLAT2_MOVING) !== 0) return;

  if (plat.last_move_time + 2 > level.time) return;

  const platCenter = (trigger.absmin[2] + trigger.absmax[2]) / 2;

  let otherState: number;
  if (plat.moveinfo.state === STATE_TOP) {
    otherState = STATE_TOP;
    if ((plat.spawnflags & PLAT2_BOX_LIFT) !== 0) {
      if (platCenter > other.s.origin[2]) otherState = STATE_BOTTOM;
    } else {
      if (trigger.absmax[2] > other.s.origin[2]) otherState = STATE_BOTTOM;
    }
  } else {
    otherState = STATE_BOTTOM;
    if (other.s.origin[2] > platCenter) otherState = STATE_TOP;
  }

  plat.plat2flags = PLAT2_MOVING;

  let pauseTime: number;
  if (cvarNum(gameCvars.deathmatch) !== 0) pauseTime = 0.3;
  else pauseTime = 0.5;

  if (plat.moveinfo.state !== otherState) {
    plat.plat2flags |= PLAT2_CALLED;
    pauseTime = 0.1;
  }

  plat.last_move_time = level.time;

  if (plat.moveinfo.state === STATE_BOTTOM) {
    plat.think = plat2_go_up;
    plat.nextthink = level.time + pauseTime;
  } else {
    plat.think = plat2_go_down;
    plat.nextthink = level.time + pauseTime;
  }
}

function Touch_Plat_Center2(ent: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  // this requires monsters to actively trigger plats, not just step on them.
  if (other.health <= 0) return;

  // PMM - don't let non-monsters activate plat2s
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) return;

  plat2_operate(ent, other);
}

function plat2_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  // gib dead things
  if (other.health < 1) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, 0, MOD_CRUSH);
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);

  if (self.moveinfo.state === STATE_UP) plat2_go_down(self);
  else if (self.moveinfo.state === STATE_DOWN) plat2_go_up(self);
}

function Use_Plat2(ent: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (ent.moveinfo.state > STATE_BOTTOM) return;
  if (ent.last_move_time + 2 > level.time) return;
  // plat2_operate unconditionally dereferences its `other` param (C would
  // crash on a NULL activator here too); guarded for TS's nullable `use`
  // signature rather than left as an unchecked dereference.
  if (activator === null) return;

  for (let i = 1; i < globals.num_edicts; i++) {
    const trigger = g_edicts[i];
    if (!trigger.inuse) continue;
    if (trigger.touch === Touch_Plat_Center2 && trigger.enemy === ent) {
      plat2_operate(trigger, activator);
      return;
    }
  }
}

function plat2_activate(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  ent.use = Use_Plat2;

  const trigger = plat_spawn_inside_trigger(ent); // the "start moving" trigger

  trigger.maxs[0] += 10;
  trigger.maxs[1] += 10;
  trigger.mins[0] -= 10;
  trigger.mins[1] -= 10;

  gi.linkentity(trigger);

  trigger.touch = Touch_Plat_Center2; // Override trigger touch function

  plat2_go_down(ent);
}

/*QUAKED func_plat2 (0 .5 .8) ? PLAT_LOW_TRIGGER PLAT2_TOGGLE PLAT2_TOP PLAT2_TRIGGER_TOP PLAT2_TRIGGER_BOTTOM BOX_LIFT
speed	default 150

PLAT_LOW_TRIGGER - creates a short trigger field at the bottom
PLAT2_TOGGLE - plat will not return to default position.
PLAT2_TOP - plat's default position will the the top.
PLAT2_TRIGGER_TOP - plat will trigger it's targets each time it hits top
PLAT2_TRIGGER_BOTTOM - plat will trigger it's targets each time it hits bottom
BOX_LIFT - this indicates that the lift is a box, rather than just a platform

Plats are always drawn in the extended position, so they will light correctly.

If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.

"speed"	overrides default 200.
"accel" overrides default 500
"lip"	no default

If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determoveinfoned by the model's height.
*/
export function SP_func_plat2(ent: EdictT): void {
  VectorClear(ent.s.angles);
  ent.solid = SolidT.SOLID_BSP;
  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = plat2_blocked;

  if (!ent.speed) ent.speed = 20;
  else ent.speed *= 0.1;

  if (!ent.accel) ent.accel = 5;
  else ent.accel *= 0.1;

  if (!ent.decel) ent.decel = 5;
  else ent.decel *= 0.1;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ent.speed *= 2;
    ent.accel *= 2;
    ent.decel *= 2;
  }

  // PMM Added to kill things it's being blocked by
  if (!ent.dmg) ent.dmg = 2;

  // pos1 is the top position, pos2 is the bottom
  VectorCopy(ent.s.origin, ent.pos1);
  VectorCopy(ent.s.origin, ent.pos2);

  if (st.height) ent.pos2[2] -= st.height - st.lip;
  else ent.pos2[2] -= ent.maxs[2] - ent.mins[2] - st.lip;

  ent.moveinfo.state = STATE_TOP;

  if (ent.targetname !== null) {
    ent.use = plat2_activate;
  } else {
    ent.use = Use_Plat2;

    const trigger = plat_spawn_inside_trigger(ent); // the "start moving" trigger

    // PGM - debugging??
    trigger.maxs[0] += 10;
    trigger.maxs[1] += 10;
    trigger.mins[0] -= 10;
    trigger.mins[1] -= 10;

    gi.linkentity(trigger);

    trigger.touch = Touch_Plat_Center2; // Override trigger touch function

    if ((ent.spawnflags & PLAT2_TOP) === 0) {
      VectorCopy(ent.pos2, ent.s.origin);
      ent.moveinfo.state = STATE_BOTTOM;
    }
  }

  gi.linkentity(ent);

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  ent.moveinfo.sound_start = gi.soundindex("plats/pt1_strt.wav");
  ent.moveinfo.sound_middle = gi.soundindex("plats/pt1_mid.wav");
  ent.moveinfo.sound_end = gi.soundindex("plats/pt1_end.wav");
}

//====================================================================

/*QUAKED func_rotating (0 .5 .8) ? START_ON REVERSE X_AXIS Y_AXIS TOUCH_PAIN STOP ANIMATED ANIMATED_FAST EAST MED HARD DM COOP ACCEL
You need to have an origin brush as part of this entity.  The center of that brush will be
the point around which it is rotated. It will rotate around the Z axis by default.  You can
check either the X_AXIS or Y_AXIS box to change that.

func_rotating will use it's targets when it stops and starts.

"speed" determines how fast it moves; default value is 100.
"dmg"	damage to inflict when blocked (2 default)
"accel" if specified, is how much the rotation speed will increase per .1sec.

REVERSE will cause the it to rotate in the opposite direction.
STOP mean it will stop moving instead of pushing entities
ACCEL means it will accelerate to it's final speed and decelerate when shutting down.
*/

// ROGUE
function rotating_accel(self: EdictT): void {
  const current_speed = VectorLength(self.avelocity);
  if (current_speed >= self.speed - self.accel) {
    // done
    VectorScale(self.movedir, self.speed, self.avelocity);
    G_UseTargets(self, self);
  } else {
    const next_speed = current_speed + self.accel;
    VectorScale(self.movedir, next_speed, self.avelocity);
    self.think = rotating_accel;
    self.nextthink = level.time + FRAMETIME;
  }
}

function rotating_decel(self: EdictT): void {
  const current_speed = VectorLength(self.avelocity);
  if (current_speed <= self.decel) {
    // done
    VectorClear(self.avelocity);
    G_UseTargets(self, self);
    self.touch = null;
  } else {
    const next_speed = current_speed - self.decel;
    VectorScale(self.movedir, next_speed, self.avelocity);
    self.think = rotating_decel;
    self.nextthink = level.time + FRAMETIME;
  }
}
// ROGUE

function rotating_blocked(self: EdictT, other: EdictT): void {
  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);
}

function rotating_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (self.avelocity[0] || self.avelocity[1] || self.avelocity[2]) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);
  }
}

function rotating_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (VectorCompare(self.avelocity, vec3_origin) === 0) {
    self.s.sound = 0;
    // ROGUE
    if ((self.spawnflags & 8192) !== 0) {
      // Decelerate
      rotating_decel(self);
    } else {
      VectorClear(self.avelocity);
      G_UseTargets(self, self);
      self.touch = null;
    }
    // ROGUE
  } else {
    self.s.sound = self.moveinfo.sound_middle;
    // ROGUE
    if ((self.spawnflags & 8192) !== 0) {
      // accelerate
      rotating_accel(self);
    } else {
      VectorScale(self.movedir, self.speed, self.avelocity);
      G_UseTargets(self, self);
    }
    // ROGUE
    if ((self.spawnflags & 16) !== 0) self.touch = rotating_touch;
  }
}

export function SP_func_rotating(ent: EdictT): void {
  ent.solid = SolidT.SOLID_BSP;
  if ((ent.spawnflags & 32) !== 0) ent.movetype = MovetypeT.MOVETYPE_STOP;
  else ent.movetype = MovetypeT.MOVETYPE_PUSH;

  // set the axis of rotation
  VectorClear(ent.movedir);
  if ((ent.spawnflags & 4) !== 0) ent.movedir[2] = 1.0;
  else if ((ent.spawnflags & 8) !== 0) ent.movedir[0] = 1.0;
  else ent.movedir[1] = 1.0; // Z_AXIS

  // check for reverse rotation
  if ((ent.spawnflags & 2) !== 0) VectorNegate(ent.movedir, ent.movedir);

  if (!ent.speed) ent.speed = 100;
  if (!ent.dmg) ent.dmg = 2;

  // ent->moveinfo.sound_middle = "doors/hydro1.wav";

  ent.use = rotating_use;
  if (ent.dmg) ent.blocked = rotating_blocked;

  if ((ent.spawnflags & 1) !== 0) {
    if (ent.use) ent.use(ent, null, null);
  }

  if ((ent.spawnflags & 64) !== 0) ent.s.effects |= EF_ANIM_ALL;
  if ((ent.spawnflags & 128) !== 0) ent.s.effects |= EF_ANIM_ALLFAST;

  // ROGUE
  if ((ent.spawnflags & 8192) !== 0) {
    // Accelerate / Decelerate
    if (!ent.accel) ent.accel = 1;
    else if (ent.accel > ent.speed) ent.accel = ent.speed;

    if (!ent.decel) ent.decel = 1;
    else if (ent.decel > ent.speed) ent.decel = ent.speed;
  }
  // ROGUE

  gi.setmodel(ent, ent.model ?? "");
  gi.linkentity(ent);
}

/*
======================================================================

BUTTONS

======================================================================
*/

/*QUAKED func_button (0 .5 .8) ?
When a button is touched, it moves some distance in the direction of it's angle, triggers all of it's targets, waits some time, then returns to it's original position where it can be triggered again.

"angle"		determines the opening direction
"target"	all entities with a matching targetname will be used
"speed"		override the default 40 speed
"wait"		override the default 1 second wait (-1 = never return)
"lip"		override the default 4 pixel lip remaining at end of move
"health"	if set, the button must be killed instead of touched
"sounds"
1) silent
2) steam metal
3) wooden clunk
4) metallic click
5) in-out
*/

function button_done(self: EdictT): void {
  self.moveinfo.state = STATE_BOTTOM;
  self.s.effects &= ~EF_ANIM23;
  self.s.effects |= EF_ANIM01;
}

function button_return(self: EdictT): void {
  self.moveinfo.state = STATE_DOWN;

  Move_Calc(self, self.moveinfo.start_origin, button_done);

  self.s.frame = 0;

  if (self.health) self.takedamage = DamageT.DAMAGE_YES;
}

function button_wait(self: EdictT): void {
  self.moveinfo.state = STATE_TOP;
  self.s.effects &= ~EF_ANIM01;
  self.s.effects |= EF_ANIM23;

  G_UseTargets(self, self.activator);
  self.s.frame = 1;
  if (self.moveinfo.wait >= 0) {
    self.nextthink = level.time + self.moveinfo.wait;
    self.think = button_return;
  }
}

function button_fire(self: EdictT): void {
  if (self.moveinfo.state === STATE_UP || self.moveinfo.state === STATE_TOP) return;

  self.moveinfo.state = STATE_UP;
  if (self.moveinfo.sound_start && (self.flags & FL_TEAMSLAVE) === 0) {
    gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }
  Move_Calc(self, self.moveinfo.end_origin, button_wait);
}

function button_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  self.activator = activator;
  button_fire(self);
}

function button_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.client === null) return;

  if (other.health <= 0) return;

  self.activator = other;
  button_fire(self);
}

function button_killed(self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3): void {
  self.activator = attacker;
  self.health = self.max_health;
  self.takedamage = DamageT.DAMAGE_NO;
  button_fire(self);
}

export function SP_func_button(ent: EdictT): void {
  G_SetMovedir(ent.s.angles, ent.movedir);
  ent.movetype = MovetypeT.MOVETYPE_STOP;
  ent.solid = SolidT.SOLID_BSP;
  gi.setmodel(ent, ent.model ?? "");

  if (ent.sounds !== 1) ent.moveinfo.sound_start = gi.soundindex("switches/butn2.wav");

  if (!ent.speed) ent.speed = 40;
  if (!ent.accel) ent.accel = ent.speed;
  if (!ent.decel) ent.decel = ent.speed;

  if (!ent.wait) ent.wait = 3;
  if (!st.lip) st.lip = 4;

  VectorCopy(ent.s.origin, ent.pos1);
  const abs_movedir = vec3(Math.abs(ent.movedir[0]), Math.abs(ent.movedir[1]), Math.abs(ent.movedir[2]));
  const dist = abs_movedir[0] * ent.size[0] + abs_movedir[1] * ent.size[1] + abs_movedir[2] * ent.size[2] - st.lip;
  VectorMA(ent.pos1, dist, ent.movedir, ent.pos2);

  ent.use = button_use;
  ent.s.effects |= EF_ANIM01;

  if (ent.health) {
    ent.max_health = ent.health;
    ent.die = button_killed;
    ent.takedamage = DamageT.DAMAGE_YES;
  } else if (ent.targetname === null) {
    ent.touch = button_touch;
  }

  ent.moveinfo.state = STATE_BOTTOM;

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  gi.linkentity(ent);
}

/*
======================================================================

DOORS

  spawn a trigger surrounding the entire team unless it is
  already targeted by another

======================================================================
*/

/*QUAKED func_door (0 .5 .8) ? START_OPEN x CRUSHER NOMONSTER ANIMATED TOGGLE ANIMATED_FAST
TOGGLE		wait in both the start and end states for a trigger event.
START_OPEN	the door to moves to its destination when spawned, and operate in reverse.  It is used to temporarily or permanently close off an area when triggered (not useful for touch or takedamage doors).
NOMONSTER	monsters will not trigger this door

"message"	is printed when the door is touched if it is a trigger door and it hasn't been fired yet
"angle"		determines the opening direction
"targetname" if set, no touch field will be spawned and a remote button or trigger field activates the door.
"health"	if set, door must be shot open
"speed"		movement speed (100 default)
"wait"		wait before returning (3 default, -1 = never return)
"lip"		lip remaining at end of move (8 default)
"dmg"		damage to inflict when blocked (2 default)
"sounds"
1)	silent
2)	light
3)	medium
4)	heavy
*/

function door_use_areaportals(self: EdictT, open: boolean): void {
  if (self.target === null) return;

  let t: EdictT | null = null;
  while ((t = G_Find(t, "targetname", self.target)) !== null) {
    if (t.classname !== null && Q_stricmp(t.classname, "func_areaportal") === 0) {
      gi.SetAreaPortalState(t.style, open);
    }
  }
}

function door_hit_top(self: EdictT): void {
  if ((self.flags & FL_TEAMSLAVE) === 0) {
    if (self.moveinfo.sound_end) {
      gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    self.s.sound = 0;
  }
  self.moveinfo.state = STATE_TOP;
  if ((self.spawnflags & DOOR_TOGGLE) !== 0) return;
  if (self.moveinfo.wait >= 0) {
    self.think = door_go_down;
    self.nextthink = level.time + self.moveinfo.wait;
  }
}

function door_hit_bottom(self: EdictT): void {
  if ((self.flags & FL_TEAMSLAVE) === 0) {
    if (self.moveinfo.sound_end) {
      gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    self.s.sound = 0;
  }
  self.moveinfo.state = STATE_BOTTOM;
  door_use_areaportals(self, false);
}

function door_go_down(self: EdictT): void {
  if ((self.flags & FL_TEAMSLAVE) === 0) {
    if (self.moveinfo.sound_start) {
      gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    self.s.sound = self.moveinfo.sound_middle;
  }
  if (self.max_health) {
    self.takedamage = DamageT.DAMAGE_YES;
    self.health = self.max_health;
  }

  self.moveinfo.state = STATE_DOWN;
  if (self.classname === "func_door") Move_Calc(self, self.moveinfo.start_origin, door_hit_bottom);
  else if (self.classname === "func_door_rotating") AngleMove_Calc(self, door_hit_bottom);
}

function door_go_up(self: EdictT, activator: EdictT | null): void {
  if (self.moveinfo.state === STATE_UP) return; // already going up

  if (self.moveinfo.state === STATE_TOP) {
    // reset top wait time
    if (self.moveinfo.wait >= 0) self.nextthink = level.time + self.moveinfo.wait;
    return;
  }

  if ((self.flags & FL_TEAMSLAVE) === 0) {
    if (self.moveinfo.sound_start) {
      gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    self.s.sound = self.moveinfo.sound_middle;
  }
  self.moveinfo.state = STATE_UP;
  if (self.classname === "func_door") Move_Calc(self, self.moveinfo.end_origin, door_hit_top);
  else if (self.classname === "func_door_rotating") AngleMove_Calc(self, door_hit_top);

  G_UseTargets(self, activator);
  door_use_areaportals(self, true);
}

// ROGUE
function smart_water_go_up(self: EdictT): void {
  if (self.moveinfo.state === STATE_TOP) {
    // reset top wait time
    if (self.moveinfo.wait >= 0) self.nextthink = level.time + self.moveinfo.wait;
    return;
  }

  if (self.health) {
    if (self.absmax[2] >= self.health) {
      VectorClear(self.velocity);
      self.nextthink = 0;
      self.moveinfo.state = STATE_TOP;
      return;
    }
  }

  if ((self.flags & FL_TEAMSLAVE) === 0) {
    if (self.moveinfo.sound_start) {
      gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    self.s.sound = self.moveinfo.sound_middle;
  }

  // find the lowest player point.
  let lowestPlayerPt = 999999;
  let lowestPlayer: EdictT | null = null;
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[1 + i];

    // don't count dead or unused player slots
    if (ent.inuse && ent.health > 0) {
      if (ent.absmin[2] < lowestPlayerPt) {
        lowestPlayerPt = ent.absmin[2];
        lowestPlayer = ent;
      }
    }
  }

  if (lowestPlayer === null) return;

  let distance = lowestPlayerPt - self.absmax[2];

  // for the calculations, make sure we intend to go up at least a little.
  if (distance < self.accel) {
    distance = 100;
    self.moveinfo.speed = 5;
  } else {
    self.moveinfo.speed = distance / self.accel;
  }

  if (self.moveinfo.speed < 5) self.moveinfo.speed = 5;
  else if (self.moveinfo.speed > self.speed) self.moveinfo.speed = self.speed;

  // FIXME - should this allow any movement other than straight up?
  VectorSet(self.moveinfo.dir, 0, 0, 1);
  VectorScale(self.moveinfo.dir, self.moveinfo.speed, self.velocity);
  self.moveinfo.remaining_distance = distance;

  if (self.moveinfo.state !== STATE_UP) {
    G_UseTargets(self, lowestPlayer);
    door_use_areaportals(self, true);
    self.moveinfo.state = STATE_UP;
  }

  self.think = smart_water_go_up;
  self.nextthink = level.time + FRAMETIME;
}
// ROGUE

function door_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if ((self.flags & FL_TEAMSLAVE) !== 0) return;

  if ((self.spawnflags & DOOR_TOGGLE) !== 0) {
    if (self.moveinfo.state === STATE_UP || self.moveinfo.state === STATE_TOP) {
      // trigger all paired doors
      for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
        ent.message = null;
        ent.touch = null;
        door_go_down(ent);
      }
      return;
    }
  }

  // ROGUE -- smart water is different
  const center = vec3();
  VectorAdd(self.mins, self.maxs, center);
  VectorScale(center, 0.5, center);
  if ((gi.pointcontents(center) & MASK_WATER) !== 0 && (self.spawnflags & 2) !== 0) {
    self.message = null;
    self.touch = null;
    self.enemy = activator;
    smart_water_go_up(self);
    return;
  }
  // ROGUE

  // trigger all paired doors
  for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
    ent.message = null;
    ent.touch = null;
    door_go_up(ent, activator);
  }
}

function Touch_DoorTrigger(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.health <= 0) return;

  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) return;

  // self.owner is always set by Think_SpawnDoorTrigger before this touch is
  // ever assigned; guarded here only to satisfy TS's nullable owner field.
  const owner = self.owner;
  if (owner !== null && (owner.spawnflags & DOOR_NOMONSTER) !== 0 && (other.svflags & SVF_MONSTER) !== 0) return;

  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = level.time + 1.0;

  if (owner !== null) door_use(owner, other, other);
}

function Think_CalcMoveSpeed(self: EdictT): void {
  if ((self.flags & FL_TEAMSLAVE) !== 0) return; // only the team master does this

  // find the smallest distance any member of the team will be moving
  let min = Math.abs(self.moveinfo.distance);
  for (let ent = self.teamchain; ent !== null; ent = ent.teamchain) {
    const dist = Math.abs(ent.moveinfo.distance);
    if (dist < min) min = dist;
  }

  const time = min / self.moveinfo.speed;

  // adjust speeds so they will all complete at the same time
  for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
    const newspeed = Math.abs(ent.moveinfo.distance) / time;
    const ratio = newspeed / ent.moveinfo.speed;
    if (ent.moveinfo.accel === ent.moveinfo.speed) ent.moveinfo.accel = newspeed;
    else ent.moveinfo.accel *= ratio;
    if (ent.moveinfo.decel === ent.moveinfo.speed) ent.moveinfo.decel = newspeed;
    else ent.moveinfo.decel *= ratio;
    ent.moveinfo.speed = newspeed;
  }
}

function Think_SpawnDoorTrigger(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) !== 0) return; // only the team leader spawns a trigger

  const mins = vec3(ent.absmin[0], ent.absmin[1], ent.absmin[2]);
  const maxs = vec3(ent.absmax[0], ent.absmax[1], ent.absmax[2]);

  for (let other = ent.teamchain; other !== null; other = other.teamchain) {
    AddPointToBounds(other.absmin, mins, maxs);
    AddPointToBounds(other.absmax, mins, maxs);
  }

  // expand
  mins[0] -= 60;
  mins[1] -= 60;
  maxs[0] += 60;
  maxs[1] += 60;

  const other = G_Spawn();
  VectorCopy(mins, other.mins);
  VectorCopy(maxs, other.maxs);
  other.owner = ent;
  other.solid = SolidT.SOLID_TRIGGER;
  other.movetype = MovetypeT.MOVETYPE_NONE;
  other.touch = Touch_DoorTrigger;
  gi.linkentity(other);

  if ((ent.spawnflags & DOOR_START_OPEN) !== 0) door_use_areaportals(ent, true);

  Think_CalcMoveSpeed(ent);
}

function door_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);

  if ((self.spawnflags & DOOR_CRUSHER) !== 0) return;

  // if a door has a negative wait, it would never come back if blocked,
  // so let it just squash the object to death real fast
  if (self.moveinfo.wait >= 0) {
    if (self.moveinfo.state === STATE_DOWN) {
      for (let ent = self.teammaster; ent !== null; ent = ent.teamchain) door_go_up(ent, ent.activator);
    } else {
      for (let ent = self.teammaster; ent !== null; ent = ent.teamchain) door_go_down(ent);
    }
  }
}

function door_killed(self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3): void {
  for (let ent = self.teammaster; ent !== null; ent = ent.teamchain) {
    ent.health = ent.max_health;
    ent.takedamage = DamageT.DAMAGE_NO;
  }
  const teammaster = self.teammaster;
  if (teammaster !== null) door_use(teammaster, attacker, attacker);
}

function door_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.client === null) return;

  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = level.time + 5.0;

  if (self.message !== null) gi.centerprintf(other, self.message);
  gi.sound(other, CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
}

export function SP_func_door(ent: EdictT): void {
  if (ent.sounds !== 1) {
    ent.moveinfo.sound_start = gi.soundindex("doors/dr1_strt.wav");
    ent.moveinfo.sound_middle = gi.soundindex("doors/dr1_mid.wav");
    ent.moveinfo.sound_end = gi.soundindex("doors/dr1_end.wav");
  }

  G_SetMovedir(ent.s.angles, ent.movedir);
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = door_blocked;
  ent.use = door_use;

  if (!ent.speed) ent.speed = 100;
  if (cvarNum(gameCvars.deathmatch) !== 0) ent.speed *= 2;

  if (!ent.accel) ent.accel = ent.speed;
  if (!ent.decel) ent.decel = ent.speed;

  if (!ent.wait) ent.wait = 3;
  if (!st.lip) st.lip = 8;
  if (!ent.dmg) ent.dmg = 2;

  // calculate second position
  VectorCopy(ent.s.origin, ent.pos1);
  const abs_movedir = vec3(Math.abs(ent.movedir[0]), Math.abs(ent.movedir[1]), Math.abs(ent.movedir[2]));
  ent.moveinfo.distance =
    abs_movedir[0] * ent.size[0] + abs_movedir[1] * ent.size[1] + abs_movedir[2] * ent.size[2] - st.lip;
  VectorMA(ent.pos1, ent.moveinfo.distance, ent.movedir, ent.pos2);

  // if it starts open, switch the positions
  if ((ent.spawnflags & DOOR_START_OPEN) !== 0) {
    VectorCopy(ent.pos2, ent.s.origin);
    VectorCopy(ent.pos1, ent.pos2);
    VectorCopy(ent.s.origin, ent.pos1);
  }

  ent.moveinfo.state = STATE_BOTTOM;

  if (ent.health) {
    ent.takedamage = DamageT.DAMAGE_YES;
    ent.die = door_killed;
    ent.max_health = ent.health;
  } else if (ent.targetname !== null && ent.message !== null) {
    gi.soundindex("misc/talk.wav");
    ent.touch = door_touch;
  }

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  if ((ent.spawnflags & 16) !== 0) ent.s.effects |= EF_ANIM_ALL;
  if ((ent.spawnflags & 64) !== 0) ent.s.effects |= EF_ANIM_ALLFAST;

  // to simplify logic elsewhere, make non-teamed doors into a team of one
  if (ent.team === null) ent.teammaster = ent;

  gi.linkentity(ent);

  ent.nextthink = level.time + FRAMETIME;
  if (ent.health || ent.targetname !== null) ent.think = Think_CalcMoveSpeed;
  else ent.think = Think_SpawnDoorTrigger;
}

// ROGUE
function Door_Activate(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.use = null;

  if (self.health) {
    self.takedamage = DamageT.DAMAGE_YES;
    self.die = door_killed;
    self.max_health = self.health;
  }

  if (self.health) self.think = Think_CalcMoveSpeed;
  else self.think = Think_SpawnDoorTrigger;
  self.nextthink = level.time + FRAMETIME;
}
// ROGUE

/*QUAKED func_door_rotating (0 .5 .8) ? START_OPEN REVERSE CRUSHER NOMONSTER ANIMATED TOGGLE X_AXIS Y_AXIS EASY MED HARD DM COOP INACTIVE
TOGGLE causes the door to wait in both the start and end states for a trigger event.

START_OPEN	the door to moves to its destination when spawned, and operate in reverse.  It is used to temporarily or permanently close off an area when triggered (not useful for touch or takedamage doors).
NOMONSTER	monsters will not trigger this door

You need to have an origin brush as part of this entity.  The center of that brush will be
the point around which it is rotated. It will rotate around the Z axis by default.  You can
check either the X_AXIS or Y_AXIS box to change that.

"distance" is how many degrees the door will be rotated.
"speed" determines how fast the door moves; default value is 100.
"accel" if specified,is how much the rotation speed will increase each .1 sec. (default: no accel)

REVERSE will cause the door to rotate in the opposite direction.
INACTIVE will cause the door to be inactive until triggered.

"message"	is printed when the door is touched if it is a trigger door and it hasn't been fired yet
"angle"		determines the opening direction
"targetname" if set, no touch field will be spawned and a remote button or trigger field activates the door.
"health"	if set, door must be shot open
"speed"		movement speed (100 default)
"wait"		wait before returning (3 default, -1 = never return)
"dmg"		damage to inflict when blocked (2 default)
"sounds"
1)	silent
2)	light
3)	medium
4)	heavy
*/

export function SP_func_door_rotating(ent: EdictT): void {
  VectorClear(ent.s.angles);

  // set the axis of rotation
  VectorClear(ent.movedir);
  if ((ent.spawnflags & DOOR_X_AXIS) !== 0) ent.movedir[2] = 1.0;
  else if ((ent.spawnflags & DOOR_Y_AXIS) !== 0) ent.movedir[0] = 1.0;
  else ent.movedir[1] = 1.0; // Z_AXIS

  // check for reverse rotation
  if ((ent.spawnflags & DOOR_REVERSE) !== 0) VectorNegate(ent.movedir, ent.movedir);

  if (!st.distance) {
    gi.dprintf(`${ent.classname} at ${vtos(ent.s.origin)} with no distance set\n`);
    st.distance = 90;
  }

  VectorCopy(ent.s.angles, ent.pos1);
  VectorMA(ent.s.angles, st.distance, ent.movedir, ent.pos2);
  ent.moveinfo.distance = st.distance;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = door_blocked;
  ent.use = door_use;

  if (!ent.speed) ent.speed = 100;
  if (!ent.accel) ent.accel = ent.speed;
  if (!ent.decel) ent.decel = ent.speed;

  if (!ent.wait) ent.wait = 3;
  if (!ent.dmg) ent.dmg = 2;

  if (ent.sounds !== 1) {
    ent.moveinfo.sound_start = gi.soundindex("doors/dr1_strt.wav");
    ent.moveinfo.sound_middle = gi.soundindex("doors/dr1_mid.wav");
    ent.moveinfo.sound_end = gi.soundindex("doors/dr1_end.wav");
  }

  // if it starts open, switch the positions
  if ((ent.spawnflags & DOOR_START_OPEN) !== 0) {
    VectorCopy(ent.pos2, ent.s.angles);
    VectorCopy(ent.pos1, ent.pos2);
    VectorCopy(ent.s.angles, ent.pos1);
    VectorNegate(ent.movedir, ent.movedir);
  }

  if (ent.health) {
    ent.takedamage = DamageT.DAMAGE_YES;
    ent.die = door_killed;
    ent.max_health = ent.health;
  }

  if (ent.targetname !== null && ent.message !== null) {
    gi.soundindex("misc/talk.wav");
    ent.touch = door_touch;
  }

  ent.moveinfo.state = STATE_BOTTOM;
  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.s.origin, ent.moveinfo.start_origin);
  VectorCopy(ent.pos1, ent.moveinfo.start_angles);
  VectorCopy(ent.s.origin, ent.moveinfo.end_origin);
  VectorCopy(ent.pos2, ent.moveinfo.end_angles);

  if ((ent.spawnflags & 16) !== 0) ent.s.effects |= EF_ANIM_ALL;

  // to simplify logic elsewhere, make non-teamed doors into a team of one
  if (ent.team === null) ent.teammaster = ent;

  gi.linkentity(ent);

  ent.nextthink = level.time + FRAMETIME;
  if (ent.health || ent.targetname !== null) ent.think = Think_CalcMoveSpeed;
  else ent.think = Think_SpawnDoorTrigger;

  // ROGUE
  if ((ent.spawnflags & DOOR_INACTIVE) !== 0) {
    ent.takedamage = DamageT.DAMAGE_NO;
    ent.die = null;
    ent.think = null;
    ent.nextthink = 0;
    ent.use = Door_Activate;
  }
  // ROGUE
}

// ROGUE
function smart_water_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_LAVA);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, 0, MOD_LAVA);
}
// ROGUE

/*QUAKED func_water (0 .5 .8) ? START_OPEN SMART
func_water is a moveable water brush.  It must be targeted to operate.  Use a non-water texture at your own risk.

START_OPEN causes the water to move to its destination when spawned and operate in reverse.

SMART causes the water to adjust its speed depending on distance to player.
(speed = distance/accel, min 5, max self->speed)
"accel"		for smart water, the divisor to determine water speed. default 20 (smaller = faster)

"health"	maximum height of this water brush
"angle"		determines the opening direction (up or down only)
"speed"		movement speed (25 default)
"wait"		wait before returning (-1 default, -1 = TOGGLE)
"lip"		lip remaining at end of move (0 default)
"sounds"	(yes, these need to be changed)
0)	no sound
1)	water
2)	lava
*/

export function SP_func_water(self: EdictT): void {
  G_SetMovedir(self.s.angles, self.movedir);
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  self.solid = SolidT.SOLID_BSP;
  gi.setmodel(self, self.model ?? "");

  switch (self.sounds) {
    default:
      break;

    case 1: // water
      self.moveinfo.sound_start = gi.soundindex("world/mov_watr.wav");
      self.moveinfo.sound_end = gi.soundindex("world/stp_watr.wav");
      break;

    case 2: // lava
      self.moveinfo.sound_start = gi.soundindex("world/mov_watr.wav");
      self.moveinfo.sound_end = gi.soundindex("world/stp_watr.wav");
      break;
  }

  // calculate second position
  VectorCopy(self.s.origin, self.pos1);
  const abs_movedir = vec3(Math.abs(self.movedir[0]), Math.abs(self.movedir[1]), Math.abs(self.movedir[2]));
  self.moveinfo.distance =
    abs_movedir[0] * self.size[0] + abs_movedir[1] * self.size[1] + abs_movedir[2] * self.size[2] - st.lip;
  VectorMA(self.pos1, self.moveinfo.distance, self.movedir, self.pos2);

  // if it starts open, switch the positions
  if ((self.spawnflags & DOOR_START_OPEN) !== 0) {
    VectorCopy(self.pos2, self.s.origin);
    VectorCopy(self.pos1, self.pos2);
    VectorCopy(self.s.origin, self.pos1);
  }

  VectorCopy(self.pos1, self.moveinfo.start_origin);
  VectorCopy(self.s.angles, self.moveinfo.start_angles);
  VectorCopy(self.pos2, self.moveinfo.end_origin);
  VectorCopy(self.s.angles, self.moveinfo.end_angles);

  self.moveinfo.state = STATE_BOTTOM;

  if (!self.speed) self.speed = 25;
  self.moveinfo.accel = self.moveinfo.decel = self.moveinfo.speed = self.speed;

  // ROGUE -- smart water
  if ((self.spawnflags & 2) !== 0) {
    // this is actually the divisor of the lowest player's distance to determine speed.
    // self->speed then becomes the cap of the speed.
    if (!self.accel) self.accel = 20;
    self.blocked = smart_water_blocked;
  }
  // ROGUE

  if (!self.wait) self.wait = -1;
  self.moveinfo.wait = self.wait;

  self.use = door_use;

  if (self.wait === -1) self.spawnflags |= DOOR_TOGGLE;

  self.classname = "func_door";

  gi.linkentity(self);
}

const TRAIN_START_ON = 1;
const TRAIN_TOGGLE = 2;
const TRAIN_BLOCK_STOPS = 4;

/*QUAKED func_train (0 .5 .8) ? START_ON TOGGLE BLOCK_STOPS
Trains are moving platforms that players can ride.
The targets origin specifies the min point of the train at each corner.
The train spawns at the first target it is pointing at.
If the train is the target of a button or trigger, it will not begin moving until activated.
speed	default 100
dmg		default	2
noise	looping sound to play when the train is in motion

To have other entities move with the train, set all the piece's team value to the same thing. They will move in unison.
*/

function train_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  if (level.time < self.touch_debounce_time) return;

  if (!self.dmg) return;
  self.touch_debounce_time = level.time + 0.5;
  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);
}

function train_wait(self: EdictT): void {
  // self.target_ent is always set by train_next before it schedules
  // train_wait via Move_Calc; guarded here only for TS's nullable field.
  const target_ent = self.target_ent;
  if (target_ent !== null && target_ent.pathtarget !== null) {
    const ent = target_ent;
    const savetarget = ent.target;
    ent.target = ent.pathtarget;
    G_UseTargets(ent, self.activator);
    ent.target = savetarget;

    // make sure we didn't get killed by a killtarget
    if (!self.inuse) return;
  }

  if (self.moveinfo.wait) {
    if (self.moveinfo.wait > 0) {
      self.nextthink = level.time + self.moveinfo.wait;
      self.think = train_next;
    } else if ((self.spawnflags & TRAIN_TOGGLE) !== 0) {
      // ROGUE -- PMM - clear target_ent, let train_next get called when we
      // get used, instead of calling train_next directly here.
      self.target_ent = null;
      // ROGUE
      self.spawnflags &= ~TRAIN_START_ON;
      VectorClear(self.velocity);
      self.nextthink = 0;
    }

    if ((self.flags & FL_TEAMSLAVE) === 0) {
      if (self.moveinfo.sound_end) {
        gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_end, 1, ATTN_STATIC, 0);
      }
      self.s.sound = 0;
    }
  } else {
    train_next(self);
  }
}

// ROGUE -- no-op endfunc for slave train pieces synced via `team`
function train_piece_wait(_self: EdictT): void {}
// ROGUE

function train_next(self: EdictT): void {
  let first = true;

  for (;;) {
    if (self.target === null) {
      // gi.dprintf ("train_next: no next target\n");
      return;
    }

    const ent = G_PickTarget(self.target);
    if (ent === null) {
      gi.dprintf(`train_next: bad target ${self.target}\n`);
      return;
    }

    self.target = ent.target;

    // check for a teleport path_corner
    if ((ent.spawnflags & 1) !== 0) {
      if (!first) {
        gi.dprintf(`connected teleport path_corners, see ${ent.classname} at ${vtos(ent.s.origin)}\n`);
        return;
      }
      first = false;
      VectorSubtract(ent.s.origin, self.mins, self.s.origin);
      VectorCopy(self.s.origin, self.s.old_origin);
      self.s.event = EntityEventT.EV_OTHER_TELEPORT;
      gi.linkentity(self);
      continue; // goto again
    }

    // ROGUE -- a path_corner can override the train's speed/accel/decel
    if (ent.speed) {
      self.speed = ent.speed;
      self.moveinfo.speed = ent.speed;
      if (ent.accel) self.moveinfo.accel = ent.accel;
      else self.moveinfo.accel = ent.speed;
      if (ent.decel) self.moveinfo.decel = ent.decel;
      else self.moveinfo.decel = ent.speed;
      self.moveinfo.current_speed = 0;
    }
    // ROGUE

    self.moveinfo.wait = ent.wait;
    self.target_ent = ent;

    if ((self.flags & FL_TEAMSLAVE) === 0) {
      if (self.moveinfo.sound_start) {
        gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
      }
      self.s.sound = self.moveinfo.sound_middle;
    }

    const dest = vec3();
    VectorSubtract(ent.s.origin, self.mins, dest);
    self.moveinfo.state = STATE_TOP;
    VectorCopy(self.s.origin, self.moveinfo.start_origin);
    VectorCopy(dest, self.moveinfo.end_origin);
    Move_Calc(self, dest, train_wait);
    self.spawnflags |= TRAIN_START_ON;

    // ROGUE -- move any team-linked pieces in lockstep with the master
    if (self.team !== null) {
      const dir = vec3();
      const dst = vec3();

      VectorSubtract(dest, self.s.origin, dir);
      for (let e = self.teamchain; e !== null; e = e.teamchain) {
        VectorAdd(dir, e.s.origin, dst);
        VectorCopy(e.s.origin, e.moveinfo.start_origin);
        VectorCopy(dst, e.moveinfo.end_origin);

        e.moveinfo.state = STATE_TOP;
        e.speed = self.speed;
        e.moveinfo.speed = self.moveinfo.speed;
        e.moveinfo.accel = self.moveinfo.accel;
        e.moveinfo.decel = self.moveinfo.decel;
        e.movetype = MovetypeT.MOVETYPE_PUSH;
        Move_Calc(e, dst, train_piece_wait);
      }
    }
    // ROGUE

    return;
  }
}

function train_resume(self: EdictT): void {
  // self.target_ent is always set immediately before train_resume is
  // called (train_use, trigger_elevator_use); guarded for TS's nullable field.
  const ent = self.target_ent;
  if (ent === null) return;

  const dest = vec3();
  VectorSubtract(ent.s.origin, self.mins, dest);
  self.moveinfo.state = STATE_TOP;
  VectorCopy(self.s.origin, self.moveinfo.start_origin);
  VectorCopy(dest, self.moveinfo.end_origin);
  Move_Calc(self, dest, train_wait);
  self.spawnflags |= TRAIN_START_ON;
}

export function func_train_find(self: EdictT): void {
  if (self.target === null) {
    gi.dprintf("train_find: no target\n");
    return;
  }
  const ent = G_PickTarget(self.target);
  if (ent === null) {
    gi.dprintf(`train_find: target ${self.target} not found\n`);
    return;
  }
  self.target = ent.target;

  VectorSubtract(ent.s.origin, self.mins, self.s.origin);
  gi.linkentity(self);

  // if not triggered, start immediately
  if (self.targetname === null) self.spawnflags |= TRAIN_START_ON;

  if ((self.spawnflags & TRAIN_START_ON) !== 0) {
    self.nextthink = level.time + FRAMETIME;
    self.think = train_next;
    self.activator = self;
  }
}

export function train_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  self.activator = activator;

  if ((self.spawnflags & TRAIN_START_ON) !== 0) {
    if ((self.spawnflags & TRAIN_TOGGLE) === 0) return;
    self.spawnflags &= ~TRAIN_START_ON;
    VectorClear(self.velocity);
    self.nextthink = 0;
  } else {
    if (self.target_ent !== null) train_resume(self);
    else train_next(self);
  }
}

export function SP_func_train(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_PUSH;

  VectorClear(self.s.angles);
  self.blocked = train_blocked;
  if ((self.spawnflags & TRAIN_BLOCK_STOPS) !== 0) {
    self.dmg = 0;
  } else {
    if (!self.dmg) self.dmg = 100;
  }
  self.solid = SolidT.SOLID_BSP;
  gi.setmodel(self, self.model ?? "");

  if (st.noise !== null) self.moveinfo.sound_middle = gi.soundindex(st.noise);

  if (!self.speed) self.speed = 100;

  self.moveinfo.speed = self.speed;
  self.moveinfo.accel = self.moveinfo.decel = self.moveinfo.speed;

  self.use = train_use;

  gi.linkentity(self);

  if (self.target !== null) {
    // start trains on the second frame, to make sure their targets have had
    // a chance to spawn
    self.nextthink = level.time + FRAMETIME;
    self.think = func_train_find;
  } else {
    gi.dprintf(`func_train without a target at ${vtos(self.absmin)}\n`);
  }
}

/*QUAKED trigger_elevator (0.3 0.1 0.6) (-8 -8 -8) (8 8 8)
*/
function trigger_elevator_use(self: EdictT, other: EdictT | null, _activator: EdictT | null): void {
  const movetarget = self.movetarget;
  if (movetarget === null) return; // guards TS null-safety; init failure leaves this unset

  if (movetarget.nextthink) {
    // gi.dprintf("elevator busy\n");
    return;
  }

  if (other === null || other.pathtarget === null) {
    gi.dprintf("elevator used with no pathtarget\n");
    return;
  }

  const target = G_PickTarget(other.pathtarget);
  if (target === null) {
    gi.dprintf(`elevator used with bad pathtarget: ${other.pathtarget}\n`);
    return;
  }

  movetarget.target_ent = target;
  train_resume(movetarget);
}

function trigger_elevator_init(self: EdictT): void {
  if (self.target === null) {
    gi.dprintf("trigger_elevator has no target\n");
    return;
  }
  self.movetarget = G_PickTarget(self.target);
  if (self.movetarget === null) {
    gi.dprintf(`trigger_elevator unable to find target ${self.target}\n`);
    return;
  }
  if (self.movetarget.classname !== "func_train") {
    gi.dprintf(`trigger_elevator target ${self.target} is not a train\n`);
    return;
  }

  self.use = trigger_elevator_use;
  self.svflags = SVF_NOCLIENT;
}

export function SP_trigger_elevator(self: EdictT): void {
  self.think = trigger_elevator_init;
  self.nextthink = level.time + FRAMETIME;
}

/*QUAKED func_timer (0.3 0.1 0.6) (-8 -8 -8) (8 8 8) START_ON
"wait"			base time between triggering all targets, default is 1
"random"		wait variance, default is 0

so, the basic time between firing is a random time between
(wait - random) and (wait + random)

"delay"			delay before first firing when turned on, default is 0

"pausetime"		additional delay used only the very first time
				and only if spawned with START_ON

These can used but not touched.
*/
function func_timer_think(self: EdictT): void {
  G_UseTargets(self, self.activator);
  self.nextthink = level.time + self.wait + crandom() * self.random;
}

function func_timer_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  self.activator = activator;

  // if on, turn it off
  if (self.nextthink) {
    self.nextthink = 0;
    return;
  }

  // turn it on
  if (self.delay) self.nextthink = level.time + self.delay;
  else func_timer_think(self);
}

export function SP_func_timer(self: EdictT): void {
  if (!self.wait) self.wait = 1.0;

  self.use = func_timer_use;
  self.think = func_timer_think;

  if (self.random >= self.wait) {
    self.random = self.wait - FRAMETIME;
    gi.dprintf(`func_timer at ${vtos(self.s.origin)} has random >= wait\n`);
  }

  if ((self.spawnflags & 1) !== 0) {
    self.nextthink = level.time + 1.0 + st.pausetime + self.delay + self.wait + crandom() * self.random;
    self.activator = self;
  }

  self.svflags = SVF_NOCLIENT;
}

/*QUAKED func_conveyor (0 .5 .8) ? START_ON TOGGLE
Conveyors are stationary brushes that move what's on them.
The brush should be have a surface with at least one current content enabled.
speed	default 100
*/

function func_conveyor_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if ((self.spawnflags & 1) !== 0) {
    self.speed = 0;
    self.spawnflags &= ~1;
  } else {
    self.speed = self.count;
    self.spawnflags |= 1;
  }

  if ((self.spawnflags & 2) === 0) self.count = 0;
}

export function SP_func_conveyor(self: EdictT): void {
  if (!self.speed) self.speed = 100;

  if ((self.spawnflags & 1) === 0) {
    self.count = self.speed;
    self.speed = 0;
  }

  self.use = func_conveyor_use;

  gi.setmodel(self, self.model ?? "");
  self.solid = SolidT.SOLID_BSP;
  gi.linkentity(self);
}

/*QUAKED func_door_secret (0 .5 .8) ? always_shoot 1st_left 1st_down
A secret door.  Slide back and then to the side.

open_once		doors never closes
1st_left		1st move is left of arrow
1st_down		1st move is down from arrow
always_shoot	door is shootebale even if targeted

"angle"		determines the direction
"dmg"		damage to inflic when blocked (default 2)
"wait"		how long to hold in the open position (default 5, -1 means hold)
*/

const SECRET_ALWAYS_SHOOT = 1;
const SECRET_1ST_LEFT = 2;
const SECRET_1ST_DOWN = 4;

function door_secret_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  // make sure we're not already moving
  if (VectorCompare(self.s.origin, vec3_origin) === 0) return;

  Move_Calc(self, self.pos1, door_secret_move1);
  door_use_areaportals(self, true);
}

function door_secret_move1(self: EdictT): void {
  self.nextthink = level.time + 1.0;
  self.think = door_secret_move2;
}

function door_secret_move2(self: EdictT): void {
  Move_Calc(self, self.pos2, door_secret_move3);
}

function door_secret_move3(self: EdictT): void {
  if (self.wait === -1) return;
  self.nextthink = level.time + self.wait;
  self.think = door_secret_move4;
}

function door_secret_move4(self: EdictT): void {
  Move_Calc(self, self.pos1, door_secret_move5);
}

function door_secret_move5(self: EdictT): void {
  self.nextthink = level.time + 1.0;
  self.think = door_secret_move6;
}

function door_secret_move6(self: EdictT): void {
  Move_Calc(self, vec3_origin, door_secret_done);
}

function door_secret_done(self: EdictT): void {
  if (self.targetname === null || (self.spawnflags & SECRET_ALWAYS_SHOOT) !== 0) {
    self.health = 0;
    self.takedamage = DamageT.DAMAGE_YES;
  }
  door_use_areaportals(self, false);
}

function door_secret_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = level.time + 0.5;

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);
}

function door_secret_die(self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3): void {
  self.takedamage = DamageT.DAMAGE_NO;
  door_secret_use(self, attacker, attacker);
}

export function SP_func_door_secret(ent: EdictT): void {
  ent.moveinfo.sound_start = gi.soundindex("doors/dr1_strt.wav");
  ent.moveinfo.sound_middle = gi.soundindex("doors/dr1_mid.wav");
  ent.moveinfo.sound_end = gi.soundindex("doors/dr1_end.wav");

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = door_secret_blocked;
  ent.use = door_secret_use;

  if (ent.targetname === null || (ent.spawnflags & SECRET_ALWAYS_SHOOT) !== 0) {
    ent.health = 0;
    ent.takedamage = DamageT.DAMAGE_YES;
    ent.die = door_secret_die;
  }

  if (!ent.dmg) ent.dmg = 2;

  if (!ent.wait) ent.wait = 5;

  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = 50;

  // calculate positions
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(ent.s.angles, forward, right, up);
  VectorClear(ent.s.angles);
  const side = 1.0 - (ent.spawnflags & SECRET_1ST_LEFT);
  let width: number;
  if ((ent.spawnflags & SECRET_1ST_DOWN) !== 0) width = Math.abs(DotProduct(up, ent.size));
  else width = Math.abs(DotProduct(right, ent.size));
  const length = Math.abs(DotProduct(forward, ent.size));
  if ((ent.spawnflags & SECRET_1ST_DOWN) !== 0) VectorMA(ent.s.origin, -1 * width, up, ent.pos1);
  else VectorMA(ent.s.origin, side * width, right, ent.pos1);
  VectorMA(ent.pos1, length, forward, ent.pos2);

  if (ent.health) {
    ent.takedamage = DamageT.DAMAGE_YES;
    ent.die = door_killed;
    ent.max_health = ent.health;
  } else if (ent.targetname !== null && ent.message !== null) {
    gi.soundindex("misc/talk.wav");
    ent.touch = door_touch;
  }

  ent.classname = "func_door";

  gi.linkentity(ent);
}

/*QUAKED func_killbox (1 0 0) ?
Kills everything inside when fired, irrespective of protection.
*/
function use_killbox(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  KillBox(self);
}

export function SP_func_killbox(ent: EdictT): void {
  gi.setmodel(ent, ent.model ?? "");
  ent.use = use_killbox;
  ent.svflags = SVF_NOCLIENT;
}
