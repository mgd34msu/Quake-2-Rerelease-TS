// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
// Ported from rogue/m_stalker.c (GNU GPL v2 or later).
/*
==============================================================================

stalker

==============================================================================
*/
//
// Porting notes / deliberate deviations (PORTING.md rule 3):
// - m_stalker.c's own `calcJumpAngle` shadows the standard math PI with a
//   locally #define'd, lower-precision `PI 3.14159` used only by its
//   RAD2DEG/DEG2RAD macros (m_stalker.c:625-627). Kept as STALKER_PI below
//   rather than reusing q_shared.ts's M_PI, to preserve the (very slightly)
//   different jump-trajectory arithmetic bug-for-bug.
// - C's `abs()` from <stdlib.h> takes an `int` parameter; the four call
//   sites in stalker_ok_to_transition and stalker_do_pounce pass a `float`
//   expression, which C implicitly truncates toward zero before taking the
//   absolute value. Reproduced with the local `cAbsTruncated` helper
//   (`Math.abs(x | 0)`) rather than `Math.abs` on the untruncated float.
// - `stalker_swing_check_l`/`stalker_swing_check_r` are forward-declared at
//   the top of the C file (and named in two frame-table comments) but never
//   defined or referenced anywhere in the translation unit; not ported
//   (nothing to call).
// - `extern qboolean SV_PointCloseEnough` and `extern void drawbbox` are
//   declared at the top of the C file; SV_PointCloseEnough is never called,
//   and the one `drawbbox(self)` call site (stalker_dead) is commented out
//   in the source. Neither is ported.
// - `monster_jump_finished`'s C body has no `return` on the "not yet timed
//   out" path (g_newai.c) -- that is a g_newai.c defect outside this file's
//   SCOPE, not something to fix here; this file just calls it.
//
import {
  AngleVectors,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
  type Vec3,
} from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_SOLID,
  EF_BLASTER,
  MASK_MONSTERSOLID,
  MASK_SHOT,
  MASK_SOLID,
  MASK_WATER,
  MZ2_STALKER_BLASTER,
  type CvarT,
  YAW,
} from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, FoundTarget, visible } from "./g_ai";
import {
  AI_SPAWNED_WIDOW,
  AI_STAND_GROUND,
  AI_WALK_WALLS,
  AS_SLIDING,
  AS_STRAIGHT,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FRAMETIME,
  gameCvars,
  GIB_ORGANIC,
  gi,
  level,
  MELEE_DISTANCE,
  g_edicts,
  MframeT,
  MmoveT,
  MovetypeT,
  world,
} from "./g_local";
import type { Edict, GTraceT } from "./game";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { G_FreeEdict, G_ProjectSource, vectoangles2 } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { monster_done_dodge, monster_fire_blaster2, walkmonster_start } from "./g_monster";
import { blocked_checkjump, blocked_checkplat, blocked_checkshot, has_valid_enemy, monster_jump_finished, monster_jump_start } from "./g_newai";
import { M_ChangeYaw } from "./m_move2";
import * as F from "./m_stalker_frames";

// mirrors g_monster.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function mkframe(
  aifunc: ((self: EdictT, dist: number) => void) | null,
  dist: number,
  thinkfunc: ((self: EdictT) => void) | null = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mkmove(
  firstframe: number,
  lastframe: number,
  frame: MframeT[],
  endfunc: ((self: EdictT) => void) | null = null,
): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// trace_t.ent recovery idiom (see m_move2.ts's/g_monster.ts's own copy):
// sv_world.c defaults an unset trace.ent to the world edict, never NULL, so
// a null GTraceT.ent here falls back to g_edicts[0] the same way.
// Module-local per PORTING.md (each ported file that needs it keeps its own
// copy).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// C's `abs()` (<stdlib.h>, `int abs(int)`) truncates its float argument to
// an int *before* negating, at the four call sites in this file
// (stalker_ok_to_transition x4, stalker_do_pounce x1). Reproduced exactly
// rather than `Math.abs` on the untruncated float -- see file header.
function cAbsTruncated(x: number): number {
  return Math.abs(x | 0);
}

// m_stalker.c:625-627 -- a local, lower-precision PI shadowing the
// standard math constant, used only by RAD2DEG/DEG2RAD below. See file
// header for why this isn't q_shared.ts's M_PI.
const STALKER_PI = 3.14159;
const FAUX_GRAVITY = 800.0;

function RAD2DEG(x: number): number {
  return x * (180.0 / STALKER_PI);
}

function DEG2RAD(x: number): number {
  return x * (STALKER_PI / 180.0);
}

let sound_pain = 0;
let sound_die = 0;
let sound_sight = 0;
let sound_punch_hit1 = 0;
let sound_punch_hit2 = 0;
let sound_idle = 0;

// `#define STALKER_ON_CEILING(ent) (ent->gravityVector[2] > 0 ? 1 : 0)`
function STALKER_ON_CEILING(ent: EdictT): boolean {
  return ent.gravityVector[2] > 0;
}

//=========================
//=========================
function stalker_ok_to_transition(self: EdictT): boolean {
  let max_dist: number;
  let margin: number;

  if (STALKER_ON_CEILING(self)) {
    max_dist = -384;
    margin = self.mins[2] - 8;
  } else {
    // her stalkers are just better
    if (self.monsterinfo.aiflags & AI_SPAWNED_WIDOW) max_dist = 256;
    else max_dist = 180;
    margin = self.maxs[2] + 8;
  }

  const pt = vec3();
  const start = vec3();
  VectorCopy(self.s.origin, pt);
  pt[2] += max_dist;
  let trace = gi.trace(self.s.origin, self.mins, self.maxs, pt, self, MASK_MONSTERSOLID);

  if (trace.fraction === 1.0 || (trace.contents & CONTENTS_SOLID) === 0 || traceEdict(trace.ent) !== world()) {
    if (STALKER_ON_CEILING(self)) {
      if (trace.plane.normal[2] < 0.9) return false;
    } else {
      if (trace.plane.normal[2] > -0.9) return false;
    }
  }

  const end_height = trace.endpos[2];

  // check the four corners, tracing only to the endpoint of the center trace (vertically).
  pt[0] = self.absmin[0];
  pt[1] = self.absmin[1];
  pt[2] = trace.endpos[2] + margin; // give a little margin of error to allow slight inclines
  VectorCopy(pt, start);
  start[2] = self.s.origin[2];
  trace = gi.trace(start, vec3_origin, vec3_origin, pt, self, MASK_MONSTERSOLID);
  if (trace.fraction === 1.0 || (trace.contents & CONTENTS_SOLID) === 0 || traceEdict(trace.ent) !== world()) {
    return false;
  }
  if (cAbsTruncated(end_height + margin - trace.endpos[2]) > 8) return false;

  pt[0] = self.absmax[0];
  pt[1] = self.absmin[1];
  VectorCopy(pt, start);
  start[2] = self.s.origin[2];
  trace = gi.trace(start, vec3_origin, vec3_origin, pt, self, MASK_MONSTERSOLID);
  if (trace.fraction === 1.0 || (trace.contents & CONTENTS_SOLID) === 0 || traceEdict(trace.ent) !== world()) {
    return false;
  }
  if (cAbsTruncated(end_height + margin - trace.endpos[2]) > 8) return false;

  pt[0] = self.absmax[0];
  pt[1] = self.absmax[1];
  VectorCopy(pt, start);
  start[2] = self.s.origin[2];
  trace = gi.trace(start, vec3_origin, vec3_origin, pt, self, MASK_MONSTERSOLID);
  if (trace.fraction === 1.0 || (trace.contents & CONTENTS_SOLID) === 0 || traceEdict(trace.ent) !== world()) {
    return false;
  }
  if (cAbsTruncated(end_height + margin - trace.endpos[2]) > 8) return false;

  pt[0] = self.absmin[0];
  pt[1] = self.absmax[1];
  VectorCopy(pt, start);
  start[2] = self.s.origin[2];
  trace = gi.trace(start, vec3_origin, vec3_origin, pt, self, MASK_MONSTERSOLID);
  if (trace.fraction === 1.0 || (trace.contents & CONTENTS_SOLID) === 0 || traceEdict(trace.ent) !== world()) {
    return false;
  }
  if (cAbsTruncated(end_height + margin - trace.endpos[2]) > 8) return false;

  return true;
}

//=========================
//=========================
function stalker_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_sight, 1, ATTN_NORM, 0);
}

// ******************
// IDLE
// ******************

function stalker_idle_noise(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_idle, 0.5, ATTN_IDLE, 0);
}

const stalker_frames_idle: MframeT[] = [
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, stalker_idle_noise),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
];
const stalker_move_idle = mkmove(F.FRAME_idle01, F.FRAME_idle21, stalker_frames_idle, stalker_stand);

const stalker_frames_idle2: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_stand, 0));
const stalker_move_idle2 = mkmove(F.FRAME_idle201, F.FRAME_idle213, stalker_frames_idle2, stalker_stand);

function stalker_idle(self: EdictT): void {
  if (Math.random() < 0.35) self.monsterinfo.currentmove = stalker_move_idle;
  else self.monsterinfo.currentmove = stalker_move_idle2;
}

// ******************
// STAND
// ******************

const stalker_frames_stand: MframeT[] = [
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, stalker_idle_noise),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),

  mkframe(ai_stand, 0),
];
const stalker_move_stand = mkmove(F.FRAME_idle01, F.FRAME_idle21, stalker_frames_stand, stalker_stand);

function stalker_stand(self: EdictT): void {
  if (Math.random() < 0.25) self.monsterinfo.currentmove = stalker_move_stand;
  else self.monsterinfo.currentmove = stalker_move_idle2;
}

// ******************
// RUN
// ******************

const stalker_frames_run: MframeT[] = [mkframe(ai_run, 13), mkframe(ai_run, 17), mkframe(ai_run, 21), mkframe(ai_run, 18)];
const stalker_move_run = mkmove(F.FRAME_run01, F.FRAME_run04, stalker_frames_run, null);

function stalker_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = stalker_move_stand;
  else self.monsterinfo.currentmove = stalker_move_run;
}

// ******************
// WALK
// ******************

const stalker_frames_walk: MframeT[] = [
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 5),

  mkframe(ai_walk, 4),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 4),
];
const stalker_move_walk = mkmove(F.FRAME_walk01, F.FRAME_walk08, stalker_frames_walk, stalker_walk);

function stalker_walk(self: EdictT): void {
  self.monsterinfo.currentmove = stalker_move_walk;
}

// ******************
// false death
// ******************
const stalker_frames_reactivate: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const stalker_move_false_death_end = mkmove(F.FRAME_reactive01, F.FRAME_reactive04, stalker_frames_reactivate, stalker_run);

function stalker_reactivate(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_STAND_GROUND;
  self.monsterinfo.currentmove = stalker_move_false_death_end;
}

function stalker_heal(self: EdictT): void {
  const skill = cvarNum(gameCvars.skill);
  if (skill === 2) self.health += 2;
  else if (skill === 3) self.health += 3;
  else self.health++;

  if (self.health > ((self.max_health / 2) | 0)) self.s.skinnum = 0;

  if (self.health >= self.max_health) {
    self.health = self.max_health;
    stalker_reactivate(self);
  }
}

const stalker_frames_false_death: MframeT[] = Array.from({ length: 10 }, () => mkframe(ai_move, 0, stalker_heal));
const stalker_move_false_death = mkmove(F.FRAME_twitch01, F.FRAME_twitch10, stalker_frames_false_death, stalker_false_death);

function stalker_false_death(self: EdictT): void {
  self.monsterinfo.currentmove = stalker_move_false_death;
}

const stalker_frames_false_death_start: MframeT[] = Array.from({ length: 9 }, () => mkframe(ai_move, 0));
const stalker_move_false_death_start = mkmove(F.FRAME_death01, F.FRAME_death09, stalker_frames_false_death_start, stalker_false_death);

function stalker_false_death_start(self: EdictT): void {
  self.s.angles[2] = 0;
  VectorSet(self.gravityVector, 0, 0, -1);

  self.monsterinfo.aiflags |= AI_STAND_GROUND;
  self.monsterinfo.currentmove = stalker_move_false_death_start;
}

// ******************
// PAIN
// ******************

const stalker_frames_pain: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const stalker_move_pain = mkmove(F.FRAME_pain01, F.FRAME_pain04, stalker_frames_pain, stalker_run);

function stalker_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.deadflag === DEAD_DEAD) return;

  if (self.health < ((self.max_health / 2) | 0)) {
    self.s.skinnum = 1;
  }

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (self.groundentity === null) return;

  // if we're reactivating or false dying, ignore the pain.
  if (self.monsterinfo.currentmove === stalker_move_false_death_end || self.monsterinfo.currentmove === stalker_move_false_death_start) return;

  if (self.monsterinfo.currentmove === stalker_move_false_death) {
    stalker_reactivate(self);
    return;
  }

  if (self.health > 0 && self.health < ((self.max_health / 4) | 0)) {
    if (Math.random() < 0.2 * cvarNum(gameCvars.skill)) {
      if (!STALKER_ON_CEILING(self) || stalker_ok_to_transition(self)) {
        stalker_false_death_start(self);
        return;
      }
    }
  }

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (damage > 10) {
    // don't react unless the damage was significant
    // stalker should dodge jump periodically to help avoid damage.
    if (self.groundentity && Math.random() < 0.5) stalker_dodge_jump(self);
    else self.monsterinfo.currentmove = stalker_move_pain;

    gi.sound(self, CHAN_WEAPON, sound_pain, 1, ATTN_NORM, 0);
  }
}

// ******************
// STALKER ATTACK
// ******************

function stalker_shoot_attack(self: EdictT): void {
  if (!has_valid_enemy(self) || self.enemy === null) return;
  const enemy = self.enemy;

  if (self.groundentity && Math.random() < 0.33) {
    const dir = vec3();
    VectorSubtract(enemy.s.origin, self.s.origin, dir);
    const dist = VectorLength(dir);

    if (dist > 256 || Math.random() < 0.5) stalker_do_pounce(self, enemy.s.origin);
    else stalker_jump_straightup(self);
  }

  const f = vec3();
  const r = vec3();
  const offset = vec3();
  const start = vec3();
  AngleVectors(self.s.angles, f, r, null);
  VectorSet(offset, 24, 0, 6);
  G_ProjectSource(self.s.origin, offset, f, r, start);

  const dir = vec3();
  const end = vec3();
  VectorSubtract(enemy.s.origin, start, dir);
  if (Math.random() < 0.2 + 0.1 * cvarNum(gameCvars.skill)) {
    const dist = VectorLength(dir);
    const time = dist / 1000;
    VectorMA(enemy.s.origin, time, enemy.velocity, end);
    VectorSubtract(end, start, dir);
  } else {
    VectorCopy(enemy.s.origin, end);
  }

  const trace = gi.trace(start, vec3_origin, vec3_origin, end, self, MASK_SHOT);
  const hit = traceEdict(trace.ent);
  if (hit === enemy || hit === world()) monster_fire_blaster2(self, start, dir, 15, 800, MZ2_STALKER_BLASTER, EF_BLASTER);
}

function stalker_shoot_attack2(self: EdictT): void {
  if (Math.random() < 0.4 + 0.1 * cvarNum(gameCvars.skill)) stalker_shoot_attack(self);
}

const stalker_frames_shoot: MframeT[] = [
  mkframe(ai_charge, 13),
  mkframe(ai_charge, 17, stalker_shoot_attack),
  mkframe(ai_charge, 21),
  mkframe(ai_charge, 18, stalker_shoot_attack2),
];
const stalker_move_shoot = mkmove(F.FRAME_run01, F.FRAME_run04, stalker_frames_shoot, stalker_run);

function stalker_attack_ranged(self: EdictT): void {
  if (!has_valid_enemy(self)) return;

  // PMM - circle strafe stuff
  if (Math.random() > 1.0 - 0.5 / cvarNum(gameCvars.skill)) {
    self.monsterinfo.attack_state = AS_STRAIGHT;
  } else {
    if (Math.random() <= 0.5) self.monsterinfo.lefty = 1 - self.monsterinfo.lefty; // switch directions
    self.monsterinfo.attack_state = AS_SLIDING;
  }
  self.monsterinfo.currentmove = stalker_move_shoot;
}

// ******************
// close combat
// ******************

function stalker_swing_attack(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  if (fire_hit(self, aim, 5 + Math.floor(Math.random() * 5), 50)) {
    if (self.s.frame < F.FRAME_attack08) gi.sound(self, CHAN_WEAPON, sound_punch_hit2, 1, ATTN_NORM, 0);
    else gi.sound(self, CHAN_WEAPON, sound_punch_hit1, 1, ATTN_NORM, 0);
  }
}

const stalker_frames_swing_l: MframeT[] = [
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 10),

  mkframe(ai_charge, 5, stalker_swing_attack),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 5), // stalker_swing_check_l
];
const stalker_move_swing_l = mkmove(F.FRAME_attack01, F.FRAME_attack08, stalker_frames_swing_l, stalker_run);

const stalker_frames_swing_r: MframeT[] = [
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 6, stalker_swing_attack),
  mkframe(ai_charge, 10),
  mkframe(ai_charge, 5), // stalker_swing_check_r
];
const stalker_move_swing_r = mkmove(F.FRAME_attack11, F.FRAME_attack15, stalker_frames_swing_r, stalker_run);

function stalker_attack_melee(self: EdictT): void {
  if (!has_valid_enemy(self)) return;

  if (Math.random() < 0.5) self.monsterinfo.currentmove = stalker_move_swing_l;
  else self.monsterinfo.currentmove = stalker_move_swing_r;
}

// ******************
// POUNCE
// ******************

// ====================
// ====================
function calcJumpAngle(start: Vec3, end: Vec3, velocity: number, angles: Vec3): void {
  const dist = vec3();
  VectorSubtract(end, start, dist);
  const distH = Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1]);
  let distV = dist[2];
  if (distV < 0) distV = 0 - distV;

  if (distV) {
    const l = Math.sqrt(distH * distH + distV * distV);
    let U = Math.atan(distV / distH);
    if (dist[2] > 0) U = 0.0 - U;

    angles[2] = 0.0;

    const cosU = Math.cos(U);
    let one = l * FAUX_GRAVITY * (cosU * cosU);
    one = one / (velocity * velocity);
    one = one - Math.sin(U);
    angles[0] = Math.asin(one);
    if (Number.isNaN(angles[0])) angles[2] = 1.0;
    angles[1] = STALKER_PI - angles[0];
    if (Number.isNaN(angles[1])) angles[2] = 1.0;

    angles[0] = RAD2DEG((angles[0] - U) / 2.0);
    angles[1] = RAD2DEG((angles[1] - U) / 2.0);
  } else {
    const l = Math.sqrt(distH * distH + distV * distV);

    angles[2] = 0.0;

    let one = l * FAUX_GRAVITY;
    one = one / (velocity * velocity);
    angles[0] = Math.asin(one);
    if (Number.isNaN(angles[0])) angles[2] = 1.0;
    angles[1] = STALKER_PI - angles[0];
    if (Number.isNaN(angles[1])) angles[2] = 1.0;

    angles[0] = RAD2DEG(angles[0] / 2.0);
    angles[1] = RAD2DEG(angles[1] / 2.0);
  }
}

// ====================
// ====================
function stalker_check_lz(self: EdictT, target: EdictT, dest: Vec3): boolean {
  if ((gi.pointcontents(dest) & MASK_WATER) !== 0 || target.waterlevel !== 0) {
    return false;
  }

  if (!target.groundentity) {
    return false;
  }

  // self->enemy === target at the only call site (stalker_do_pounce always
  // passes self.enemy); guarded separately here for the type checker.
  const enemy = self.enemy;
  if (enemy === null) return false;

  // check under the player's four corners
  // if they're not solid, bail.
  const jumpLZ = vec3();
  jumpLZ[0] = enemy.mins[0];
  jumpLZ[1] = enemy.mins[1];
  jumpLZ[2] = enemy.mins[2] - 0.25;
  if ((gi.pointcontents(jumpLZ) & MASK_SOLID) === 0) return false;

  jumpLZ[0] = enemy.maxs[0];
  jumpLZ[1] = enemy.mins[1];
  if ((gi.pointcontents(jumpLZ) & MASK_SOLID) === 0) return false;

  jumpLZ[0] = enemy.maxs[0];
  jumpLZ[1] = enemy.maxs[1];
  if ((gi.pointcontents(jumpLZ) & MASK_SOLID) === 0) return false;

  jumpLZ[0] = enemy.mins[0];
  jumpLZ[1] = enemy.maxs[1];
  if ((gi.pointcontents(jumpLZ) & MASK_SOLID) === 0) return false;

  return true;
}

// ====================
// ====================
function stalker_do_pounce(self: EdictT, dest: Vec3): boolean {
  const velocityStart = 400.1;

  // don't pounce when we're on the ceiling
  if (STALKER_ON_CEILING(self)) return false;

  // self->enemy is dereferenced unconditionally below, exactly like the C;
  // every call site (stalker_shoot_attack, stalker_blocked) has already
  // checked has_valid_enemy(self), so this is a type-checker guard only.
  const enemy = self.enemy;
  if (enemy === null) return false;

  if (!stalker_check_lz(self, enemy, dest)) return false;

  const dist = vec3();
  VectorSubtract(dest, self.s.origin, dist);

  // make sure we're pointing in that direction 15deg margin of error.
  const jumpAngles = vec3();
  vectoangles2(dist, jumpAngles);
  if (cAbsTruncated(jumpAngles[YAW] - self.s.angles[YAW]) > 45) return false; // not facing the player...

  self.ideal_yaw = jumpAngles[YAW];
  M_ChangeYaw(self);

  const length = VectorLength(dist);
  if (length > 450) return false; // can't jump that far...

  const jumpLZ = vec3();
  VectorCopy(dest, jumpLZ);

  let preferHighJump = false;

  // if we're having to jump up a distance, jump a little too high to compensate.
  if (dist[2] >= 32.0) {
    preferHighJump = true;
    jumpLZ[2] += 32;
  }

  const trace = gi.trace(self.s.origin, vec3_origin, vec3_origin, dest, self, MASK_MONSTERSOLID);
  if (trace.fraction < 1 && traceEdict(trace.ent) !== enemy) {
    preferHighJump = true;
  }

  // find a valid angle/velocity combination
  let velocity = velocityStart;
  while (velocity <= 800) {
    calcJumpAngle(self.s.origin, jumpLZ, velocity, jumpAngles);
    if (!Number.isNaN(jumpAngles[0]) || !Number.isNaN(jumpAngles[1])) break;

    velocity += 200;
  }

  const sv_gravity = cvarNum(gameCvars.sv_gravity);

  if (!preferHighJump && !Number.isNaN(jumpAngles[0])) {
    const forward = vec3();
    const right = vec3();
    AngleVectors(self.s.angles, forward, right, null);
    VectorNormalize(forward);

    VectorScale(forward, velocity * Math.cos(DEG2RAD(jumpAngles[0])), self.velocity);
    self.velocity[2] = velocity * Math.sin(DEG2RAD(jumpAngles[0])) + 0.5 * sv_gravity * FRAMETIME;
    return true;
  }

  if (!Number.isNaN(jumpAngles[1])) {
    const forward = vec3();
    const right = vec3();
    AngleVectors(self.s.angles, forward, right, null);
    VectorNormalize(forward);

    VectorScale(forward, velocity * Math.cos(DEG2RAD(jumpAngles[1])), self.velocity);
    self.velocity[2] = velocity * Math.sin(DEG2RAD(jumpAngles[1])) + 0.5 * sv_gravity * FRAMETIME;
    return true;
  }

  return false;
}

// ******************
// DODGE
// ******************

//===================
// stalker_jump_straightup
//===================
function stalker_jump_straightup(self: EdictT): void {
  if (self.deadflag === DEAD_DEAD) return;

  if (STALKER_ON_CEILING(self)) {
    if (stalker_ok_to_transition(self)) {
      self.gravityVector[2] = -1;
      self.s.angles[2] += 180.0;
      if (self.s.angles[2] > 360.0) self.s.angles[2] -= 360.0;
      self.groundentity = null;
    }
  } else if (self.groundentity) {
    // make sure we're standing on SOMETHING...
    self.velocity[0] += Math.random() * 10 - 5;
    self.velocity[1] += Math.random() * 10 - 5;
    self.velocity[2] += -400 * self.gravityVector[2];
    if (stalker_ok_to_transition(self)) {
      self.gravityVector[2] = 1;
      self.s.angles[2] = 180.0;
      self.groundentity = null;
    }
  }
}

const stalker_frames_jump_straightup: MframeT[] = [
  mkframe(ai_move, 1, stalker_jump_straightup),
  mkframe(ai_move, 1, stalker_jump_wait_land),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
];

const stalker_move_jump_straightup = mkmove(F.FRAME_jump04, F.FRAME_jump07, stalker_frames_jump_straightup, stalker_run);

//===================
// stalker_dodge_jump - abstraction so pain function can trigger a dodge jump too without
//		faking the inputs to stalker_dodge
//===================
function stalker_dodge_jump(self: EdictT): void {
  self.monsterinfo.currentmove = stalker_move_jump_straightup;
}

const stalker_frames_dodge_run: MframeT[] = [
  mkframe(ai_run, 13),
  mkframe(ai_run, 17),
  mkframe(ai_run, 21),
  mkframe(ai_run, 18, monster_done_dodge),
];
const stalker_move_dodge_run = mkmove(F.FRAME_run01, F.FRAME_run04, stalker_frames_dodge_run, null);

function stalker_dodge(self: EdictT, attacker: EdictT, eta: number, _tr: GTraceT): void {
  if (!self.groundentity || self.health <= 0) return;

  if (!self.enemy) {
    self.enemy = attacker;
    FoundTarget(self);
    return;
  }

  // PMM - don't bother if it's going to hit anyway; fix for weird in-your-face etas (I was
  // seeing numbers like 13 and 14)
  if (eta < 0.1 || eta > 5) return;

  // this will override the foundtarget call of stalker_run
  stalker_dodge_jump(self);
}

// ******************
// Jump onto / off of things
// ******************

//===================
//===================
function stalker_jump_down(self: EdictT): void {
  monster_jump_start(self);

  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 100, forward, self.velocity);
  VectorMA(self.velocity, 300, up, self.velocity);
}

//===================
//===================
function stalker_jump_up(self: EdictT): void {
  monster_jump_start(self);

  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 200, forward, self.velocity);
  VectorMA(self.velocity, 450, up, self.velocity);
}

//===================
//===================
function stalker_jump_wait_land(self: EdictT): void {
  if (Math.random() < 0.3 + 0.1 * cvarNum(gameCvars.skill) && level.time >= self.monsterinfo.attack_finished) {
    self.monsterinfo.attack_finished = level.time + 0.3;
    stalker_shoot_attack(self);
  }

  if (self.groundentity === null) {
    self.gravity = 1.3;
    self.monsterinfo.nextframe = self.s.frame;

    if (monster_jump_finished(self)) {
      self.gravity = 1;
      self.monsterinfo.nextframe = self.s.frame + 1;
    }
  } else {
    self.gravity = 1;
    self.monsterinfo.nextframe = self.s.frame + 1;
  }
}

const stalker_frames_jump_up: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, -8),
  mkframe(ai_move, -8),
  mkframe(ai_move, -8),

  mkframe(ai_move, 0, stalker_jump_up),
  mkframe(ai_move, 0, stalker_jump_wait_land),
  mkframe(ai_move, 0),
];
const stalker_move_jump_up = mkmove(F.FRAME_jump01, F.FRAME_jump07, stalker_frames_jump_up, stalker_run);

const stalker_frames_jump_down: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),

  mkframe(ai_move, 0, stalker_jump_down),
  mkframe(ai_move, 0, stalker_jump_wait_land),
  mkframe(ai_move, 0),
];
const stalker_move_jump_down = mkmove(F.FRAME_jump01, F.FRAME_jump07, stalker_frames_jump_down, stalker_run);

//============
// stalker_jump - this is only used for jumping onto or off of things. for dodge jumping,
//		use stalker_dodge_jump
//============
function stalker_jump(self: EdictT): void {
  if (!self.enemy) return;

  if (self.enemy.s.origin[2] >= self.s.origin[2]) {
    self.monsterinfo.currentmove = stalker_move_jump_up;
  } else {
    self.monsterinfo.currentmove = stalker_move_jump_down;
  }
}

// ******************
// Blocked
// ******************

function stalker_blocked(self: EdictT, dist: number): boolean {
  if (!has_valid_enemy(self) || self.enemy === null) return false;
  const enemy = self.enemy;

  const onCeiling = self.gravityVector[2] > 0;

  if (!onCeiling) {
    if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) {
      return true;
    }

    if (visible(self, enemy)) {
      stalker_do_pounce(self, enemy.s.origin);
      return true;
    }

    if (blocked_checkjump(self, dist, 256, 68)) {
      stalker_jump(self);
      return true;
    }

    if (blocked_checkplat(self, dist)) return true;
  } else {
    if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) {
      return true;
    } else if (stalker_ok_to_transition(self)) {
      self.gravityVector[2] = -1;
      self.s.angles[2] += 180.0;
      if (self.s.angles[2] > 360.0) self.s.angles[2] -= 360.0;
      self.groundentity = null;

      return true;
    }
  }

  return false;
}

// ******************
// Death
// ******************

function stalker_dead(self: EdictT): void {
  VectorSet(self.mins, -28, -28, -18);
  VectorSet(self.maxs, 28, 28, -4);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const stalker_frames_death: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, -5),
  mkframe(ai_move, -10),
  mkframe(ai_move, -20),

  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),

  mkframe(ai_move, 0),
];
const stalker_move_death = mkmove(F.FRAME_death01, F.FRAME_death09, stalker_frames_death, stalker_dead);

function stalker_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // dude bit it, make him fall!
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.s.angles[2] = 0;
  VectorSet(self.gravityVector, 0, 0, -1);

  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.currentmove = stalker_move_death;
}

// ******************
// SPAWN
// ******************

/*QUAKED monster_stalker (1 .5 0) (-28 -28 -18) (28 28 18) Ambush Trigger_Spawn Sight OnRoof
Spider Monster

  ONROOF - Monster starts sticking to the roof.
*/
export function SP_monster_stalker(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain = gi.soundindex("stalker/pain.wav");
  sound_die = gi.soundindex("stalker/death.wav");
  sound_sight = gi.soundindex("stalker/sight.wav");
  sound_punch_hit1 = gi.soundindex("stalker/melee1.wav");
  sound_punch_hit2 = gi.soundindex("stalker/melee2.wav");
  sound_idle = gi.soundindex("stalker/idle.wav");

  // PMM - precache bolt2
  gi.modelindex("models/proj/laser2/tris.md2");

  self.s.modelindex = gi.modelindex("models/monsters/stalker/tris.md2");
  VectorSet(self.mins, -28, -28, -18);
  VectorSet(self.maxs, 28, 28, 18);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = 250;
  self.gib_health = -50; // FIXME
  self.mass = 250;

  self.pain = stalker_pain;
  self.die = stalker_die;

  self.monsterinfo.stand = stalker_stand;
  self.monsterinfo.walk = stalker_walk;
  self.monsterinfo.run = stalker_run;
  self.monsterinfo.attack = stalker_attack_ranged;
  self.monsterinfo.sight = stalker_sight;
  self.monsterinfo.idle = stalker_idle;
  self.monsterinfo.dodge = stalker_dodge;
  self.monsterinfo.blocked = stalker_blocked;
  self.monsterinfo.melee = stalker_attack_melee;

  gi.linkentity(self);

  self.monsterinfo.currentmove = stalker_move_stand;
  self.monsterinfo.scale = F.MODEL_SCALE;

  self.monsterinfo.aiflags |= AI_WALK_WALLS;

  if (self.spawnflags & 8) {
    // spawnflags & 8: the QUAKED comment's "OnRoof" checkbox
    self.s.angles[2] = 180;
    self.gravityVector[2] = 1;
  }

  walkmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_stalker:stalker_sight", stalker_sight);
registerSaveFunction("m_stalker:stalker_idle_noise", stalker_idle_noise);
registerSaveFunction("m_stalker:stalker_idle", stalker_idle);
registerSaveFunction("m_stalker:stalker_stand", stalker_stand);
registerSaveFunction("m_stalker:stalker_run", stalker_run);
registerSaveFunction("m_stalker:stalker_walk", stalker_walk);
registerSaveFunction("m_stalker:stalker_reactivate", stalker_reactivate);
registerSaveFunction("m_stalker:stalker_heal", stalker_heal);
registerSaveFunction("m_stalker:stalker_false_death", stalker_false_death);
registerSaveFunction("m_stalker:stalker_false_death_start", stalker_false_death_start);
registerSaveFunction("m_stalker:stalker_pain", stalker_pain);
registerSaveFunction("m_stalker:stalker_shoot_attack", stalker_shoot_attack);
registerSaveFunction("m_stalker:stalker_shoot_attack2", stalker_shoot_attack2);
registerSaveFunction("m_stalker:stalker_attack_ranged", stalker_attack_ranged);
registerSaveFunction("m_stalker:stalker_swing_attack", stalker_swing_attack);
registerSaveFunction("m_stalker:stalker_attack_melee", stalker_attack_melee);
registerSaveFunction("m_stalker:stalker_jump_straightup", stalker_jump_straightup);
registerSaveFunction("m_stalker:stalker_dodge_jump", stalker_dodge_jump);
registerSaveFunction("m_stalker:stalker_dodge", stalker_dodge);
registerSaveFunction("m_stalker:stalker_jump_down", stalker_jump_down);
registerSaveFunction("m_stalker:stalker_jump_up", stalker_jump_up);
registerSaveFunction("m_stalker:stalker_jump_wait_land", stalker_jump_wait_land);
registerSaveFunction("m_stalker:stalker_jump", stalker_jump);
registerSaveFunction("m_stalker:stalker_blocked", stalker_blocked);
registerSaveFunction("m_stalker:stalker_dead", stalker_dead);
registerSaveFunction("m_stalker:stalker_die", stalker_die);

registerSaveMmove("m_stalker:stalker_move_idle", stalker_move_idle);
registerSaveMmove("m_stalker:stalker_move_idle2", stalker_move_idle2);
registerSaveMmove("m_stalker:stalker_move_stand", stalker_move_stand);
registerSaveMmove("m_stalker:stalker_move_run", stalker_move_run);
registerSaveMmove("m_stalker:stalker_move_walk", stalker_move_walk);
registerSaveMmove("m_stalker:stalker_move_false_death_end", stalker_move_false_death_end);
registerSaveMmove("m_stalker:stalker_move_false_death", stalker_move_false_death);
registerSaveMmove("m_stalker:stalker_move_false_death_start", stalker_move_false_death_start);
registerSaveMmove("m_stalker:stalker_move_pain", stalker_move_pain);
registerSaveMmove("m_stalker:stalker_move_shoot", stalker_move_shoot);
registerSaveMmove("m_stalker:stalker_move_swing_l", stalker_move_swing_l);
registerSaveMmove("m_stalker:stalker_move_swing_r", stalker_move_swing_r);
registerSaveMmove("m_stalker:stalker_move_jump_straightup", stalker_move_jump_straightup);
registerSaveMmove("m_stalker:stalker_move_dodge_run", stalker_move_dodge_run);
registerSaveMmove("m_stalker:stalker_move_jump_up", stalker_move_jump_up);
registerSaveMmove("m_stalker:stalker_move_jump_down", stalker_move_jump_down);
registerSaveMmove("m_stalker:stalker_move_death", stalker_move_death);
