/*
Copyright (C) 1997-2001 Id Software, Inc.
Copyright (c) ZeniMax Media Inc.
Ported from xatrix/m_soldier.c (GNU GPL v2 or later), which is baseq2's
m_soldier.c plus a RAFAEL 13-APR-98 addendum: the "soldierh" variant used
by the hyperblaster/lasergun/ripper soldier reskins. The addendum reuses
the base file's module-scope sound_* variables, blaster_flash/
shotgun_flash/machinegun_flash tables, and cvarNum() helper as-is (same
translation unit in C).
*/
/*
==============================================================================

SOLDIER

==============================================================================
*/

import { AngleVectors, crandom, random, VectorCopy, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  ATTN_STATIC,
  CHAN_AUTO,
  CHAN_VOICE,
  CHAN_WEAPON,
  EF_BLASTER,
  EF_BLUEHYPERBLASTER,
  EF_IONRIPPER,
  MZ_BLUEHYPERBLASTER,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_BLASTER_2,
  MZ2_SOLDIER_BLASTER_3,
  MZ2_SOLDIER_BLASTER_4,
  MZ2_SOLDIER_BLASTER_5,
  MZ2_SOLDIER_BLASTER_6,
  MZ2_SOLDIER_BLASTER_7,
  MZ2_SOLDIER_BLASTER_8,
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_SOLDIER_MACHINEGUN_2,
  MZ2_SOLDIER_MACHINEGUN_3,
  MZ2_SOLDIER_MACHINEGUN_4,
  MZ2_SOLDIER_MACHINEGUN_5,
  MZ2_SOLDIER_MACHINEGUN_6,
  MZ2_SOLDIER_MACHINEGUN_7,
  MZ2_SOLDIER_MACHINEGUN_8,
  MZ2_SOLDIER_SHOTGUN_1,
  MZ2_SOLDIER_SHOTGUN_2,
  MZ2_SOLDIER_SHOTGUN_3,
  MZ2_SOLDIER_SHOTGUN_4,
  MZ2_SOLDIER_SHOTGUN_5,
  MZ2_SOLDIER_SHOTGUN_6,
  MZ2_SOLDIER_SHOTGUN_7,
  MZ2_SOLDIER_SHOTGUN_8,
} from "../shared/q_shared";
import {
  AI_DUCKED,
  AI_HOLD_FRAME,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FRAMETIME,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_MELEE,
  RANGE_MID,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range } from "./g_ai";
import { monster_fire_blaster, monster_fire_bullet, monster_fire_shotgun, walkmonster_start } from "./g_monster";
import { monster_dabeam, monster_fire_blueblaster, monster_fire_ionripper } from "./g_weapon";
import { G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_soldier_frames";
// RAFAEL 13-APR-98: pack-only frames header for the soldierh variant --
// see m_soldierh.ts's header comment for why this is a *separate* module
// from ./m_soldier_frames even though the two headers' FRAME_* values are
// numerically identical.
import * as FRAMEH from "./m_soldierh";

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD and DEFAULT_*SHOTGUN* family
// (p_weapon.ts and m_tank.ts each keep their own module-local copy too; not
// centralized anywhere in the header modules).
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;
const DEFAULT_SHOTGUN_HSPREAD = 1000;
const DEFAULT_SHOTGUN_VSPREAD = 500;
const DEFAULT_SHOTGUN_COUNT = 12;

// mirrors g_monster.ts's/g_items.ts's own `cvarNum` (module-local there too,
// so not exported and duplicated here).
function cvarNum(c: { value: number } | null): number {
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

function mkmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: ((self: EdictT) => void) | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_idle = 0;
let sound_sight1 = 0;
let sound_sight2 = 0;
let sound_pain_light = 0;
let sound_pain = 0;
let sound_pain_ss = 0;
let sound_death_light = 0;
let sound_death = 0;
let sound_death_ss = 0;
let sound_cock = 0;

function soldier_idle(self: EdictT): void {
  if (random() > 0.8) gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function soldier_cock(self: EdictT): void {
  if (self.s.frame === FRAME.FRAME_stand322) gi.sound(self, CHAN_WEAPON, sound_cock, 1, ATTN_IDLE, 0);
  else gi.sound(self, CHAN_WEAPON, sound_cock, 1, ATTN_NORM, 0);
}

// STAND

const soldier_frames_stand1: MframeT[] = Array.from({ length: 30 }, (_, i) => mkframe(ai_stand, 0, i === 0 ? soldier_idle : null));
const soldier_move_stand1 = mkmove(FRAME.FRAME_stand101, FRAME.FRAME_stand130, soldier_frames_stand1, soldier_stand);

const soldier_frames_stand3: MframeT[] = Array.from({ length: 39 }, (_, i) => mkframe(ai_stand, 0, i === 21 ? soldier_cock : null));
const soldier_move_stand3 = mkmove(FRAME.FRAME_stand301, FRAME.FRAME_stand339, soldier_frames_stand3, soldier_stand);

// soldier_frames_stand4/soldier_move_stand4 (C: `#if 0` block, FRAME_stand401
// through FRAME_stand452) dropped -- dead code, never referenced.

function soldier_stand(self: EdictT): void {
  if (self.monsterinfo.currentmove === soldier_move_stand3 || random() < 0.8) self.monsterinfo.currentmove = soldier_move_stand1;
  else self.monsterinfo.currentmove = soldier_move_stand3;
}

//
// WALK
//

function soldier_walk1_random(self: EdictT): void {
  if (random() > 0.1) self.monsterinfo.nextframe = FRAME.FRAME_walk101;
}

const soldier_frames_walk1: MframeT[] = [
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, -1, soldier_walk1_random),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
];
const soldier_move_walk1 = mkmove(FRAME.FRAME_walk101, FRAME.FRAME_walk133, soldier_frames_walk1);

const soldier_frames_walk2: MframeT[] = [
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 7),
];
const soldier_move_walk2 = mkmove(FRAME.FRAME_walk209, FRAME.FRAME_walk218, soldier_frames_walk2);

function soldier_walk(self: EdictT): void {
  if (random() < 0.5) self.monsterinfo.currentmove = soldier_move_walk1;
  else self.monsterinfo.currentmove = soldier_move_walk2;
}

//
// RUN
//

const soldier_frames_start_run: MframeT[] = [mkframe(ai_run, 7), mkframe(ai_run, 5)];
const soldier_move_start_run = mkmove(FRAME.FRAME_run01, FRAME.FRAME_run02, soldier_frames_start_run, soldier_run);

const soldier_frames_run: MframeT[] = [
  mkframe(ai_run, 10),
  mkframe(ai_run, 11),
  mkframe(ai_run, 11),
  mkframe(ai_run, 16),
  mkframe(ai_run, 10),
  mkframe(ai_run, 15),
];
const soldier_move_run = mkmove(FRAME.FRAME_run03, FRAME.FRAME_run08, soldier_frames_run);

function soldier_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    self.monsterinfo.currentmove = soldier_move_stand1;
    return;
  }

  if (
    self.monsterinfo.currentmove === soldier_move_walk1 ||
    self.monsterinfo.currentmove === soldier_move_walk2 ||
    self.monsterinfo.currentmove === soldier_move_start_run
  ) {
    self.monsterinfo.currentmove = soldier_move_run;
  } else {
    self.monsterinfo.currentmove = soldier_move_start_run;
  }
}

//
// PAIN
//

const soldier_frames_pain1: MframeT[] = [mkframe(ai_move, -3), mkframe(ai_move, 4), mkframe(ai_move, 1), mkframe(ai_move, 1), mkframe(ai_move, 0)];
const soldier_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain105, soldier_frames_pain1, soldier_run);

const soldier_frames_pain2: MframeT[] = [
  mkframe(ai_move, -13),
  mkframe(ai_move, -1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 4),
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
];
const soldier_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain207, soldier_frames_pain2, soldier_run);

const soldier_frames_pain3: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, 10),
  mkframe(ai_move, -4),
  mkframe(ai_move, -1),
  mkframe(ai_move, -3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 4),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
];
const soldier_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain318, soldier_frames_pain3, soldier_run);

const soldier_frames_pain4: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -10),
  mkframe(ai_move, -6),
  mkframe(ai_move, 8),
  mkframe(ai_move, 4),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 5),
  mkframe(ai_move, 2),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
];
const soldier_move_pain4 = mkmove(FRAME.FRAME_pain401, FRAME.FRAME_pain417, soldier_frames_pain4, soldier_run);

function soldier_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  let r: number;
  let n: number;

  if (self.health < self.max_health / 2) self.s.skinnum |= 1;

  if (level.time < self.pain_debounce_time) {
    if (
      self.velocity[2] > 100 &&
      (self.monsterinfo.currentmove === soldier_move_pain1 ||
        self.monsterinfo.currentmove === soldier_move_pain2 ||
        self.monsterinfo.currentmove === soldier_move_pain3)
    ) {
      self.monsterinfo.currentmove = soldier_move_pain4;
    }
    return;
  }

  self.pain_debounce_time = level.time + 3;

  n = self.s.skinnum | 1;
  if (n === 1) gi.sound(self, CHAN_VOICE, sound_pain_light, 1, ATTN_NORM, 0);
  else if (n === 3) gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain_ss, 1, ATTN_NORM, 0);

  if (self.velocity[2] > 100) {
    self.monsterinfo.currentmove = soldier_move_pain4;
    return;
  }

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  r = random();

  if (r < 0.33) self.monsterinfo.currentmove = soldier_move_pain1;
  else if (r < 0.66) self.monsterinfo.currentmove = soldier_move_pain2;
  else self.monsterinfo.currentmove = soldier_move_pain3;
}

//
// ATTACK
//

const blaster_flash = [
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_BLASTER_2,
  MZ2_SOLDIER_BLASTER_3,
  MZ2_SOLDIER_BLASTER_4,
  MZ2_SOLDIER_BLASTER_5,
  MZ2_SOLDIER_BLASTER_6,
  MZ2_SOLDIER_BLASTER_7,
  MZ2_SOLDIER_BLASTER_8,
];
const shotgun_flash = [
  MZ2_SOLDIER_SHOTGUN_1,
  MZ2_SOLDIER_SHOTGUN_2,
  MZ2_SOLDIER_SHOTGUN_3,
  MZ2_SOLDIER_SHOTGUN_4,
  MZ2_SOLDIER_SHOTGUN_5,
  MZ2_SOLDIER_SHOTGUN_6,
  MZ2_SOLDIER_SHOTGUN_7,
  MZ2_SOLDIER_SHOTGUN_8,
];
const machinegun_flash = [
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_SOLDIER_MACHINEGUN_2,
  MZ2_SOLDIER_MACHINEGUN_3,
  MZ2_SOLDIER_MACHINEGUN_4,
  MZ2_SOLDIER_MACHINEGUN_5,
  MZ2_SOLDIER_MACHINEGUN_6,
  MZ2_SOLDIER_MACHINEGUN_7,
  MZ2_SOLDIER_MACHINEGUN_8,
];

function soldier_fire(self: EdictT, flash_number: number): void {
  const start: Vec3 = vec3();
  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();
  const aim: Vec3 = vec3();
  const dir: Vec3 = vec3();
  const end: Vec3 = vec3();
  let r: number;
  let u: number;
  let flash_index: number;

  if (self.s.skinnum < 2) flash_index = blaster_flash[flash_number];
  else if (self.s.skinnum < 4) flash_index = shotgun_flash[flash_number];
  else flash_index = machinegun_flash[flash_number];

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_index], forward, right, start);

  if (flash_number === 5 || flash_number === 6) {
    VectorCopy(forward, aim);
  } else {
    if (self.enemy === null) return; // C assumes self->enemy is set here
    VectorCopy(self.enemy.s.origin, end);
    end[2] += self.enemy.viewheight;
    VectorSubtract(end, start, aim);
    vectoangles(aim, dir);
    AngleVectors(dir, forward, right, up);

    r = crandom() * 1000;
    u = crandom() * 500;
    VectorMA(start, 8192, forward, end);
    VectorMA(end, r, right, end);
    VectorMA(end, u, up, end);

    VectorSubtract(end, start, aim);
    VectorNormalize(aim);
  }

  if (self.s.skinnum <= 1) {
    monster_fire_blaster(self, start, aim, 5, 600, flash_index, EF_BLASTER);
  } else if (self.s.skinnum <= 3) {
    monster_fire_shotgun(self, start, aim, 2, 1, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SHOTGUN_COUNT, flash_index);
  } else {
    if (!(self.monsterinfo.aiflags & AI_HOLD_FRAME)) {
      self.monsterinfo.pausetime = level.time + (3 + Math.floor(Math.random() * 8)) * FRAMETIME;
    }

    monster_fire_bullet(self, start, aim, 2, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_index);

    if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
    else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
  }
}

// ATTACK1 (blaster/shotgun)

function soldier_fire1(self: EdictT): void {
  soldier_fire(self, 0);
}

function soldier_attack1_refire1(self: EdictT): void {
  if (self.s.skinnum > 1) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAME.FRAME_attak102;
  else self.monsterinfo.nextframe = FRAME.FRAME_attak110;
}

function soldier_attack1_refire2(self: EdictT): void {
  if (self.s.skinnum < 2) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAME.FRAME_attak102;
}

const soldier_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_fire1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_attack1_refire1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_cock),
  mkframe(ai_charge, 0, soldier_attack1_refire2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldier_move_attack1 = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak112, soldier_frames_attack1, soldier_run);

// ATTACK2 (blaster/shotgun)

function soldier_fire2(self: EdictT): void {
  soldier_fire(self, 1);
}

function soldier_attack2_refire1(self: EdictT): void {
  if (self.s.skinnum > 1) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAME.FRAME_attak204;
  else self.monsterinfo.nextframe = FRAME.FRAME_attak216;
}

function soldier_attack2_refire2(self: EdictT): void {
  if (self.s.skinnum < 2) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAME.FRAME_attak204;
}

const soldier_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_fire2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_attack2_refire1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_cock),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_attack2_refire2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldier_move_attack2 = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak218, soldier_frames_attack2, soldier_run);

// ATTACK3 (duck and shoot)

function soldier_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.pausetime = level.time + 1;
  gi.linkentity(self);
}

function soldier_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

function soldier_fire3(self: EdictT): void {
  soldier_duck_down(self);
  soldier_fire(self, 2);
}

function soldier_attack3_refire(self: EdictT): void {
  if (level.time + 0.4 < self.monsterinfo.pausetime) self.monsterinfo.nextframe = FRAME.FRAME_attak303;
}

const soldier_frames_attack3: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_fire3),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_attack3_refire),
  mkframe(ai_charge, 0, soldier_duck_up),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldier_move_attack3 = mkmove(FRAME.FRAME_attak301, FRAME.FRAME_attak309, soldier_frames_attack3, soldier_run);

// ATTACK4 (machinegun)

function soldier_fire4(self: EdictT): void {
  soldier_fire(self, 3);
  //
  //	if (self->enemy->health <= 0)
  //		return;
  //
  //	if ( ((skill->value == 3) && (random() < 0.5)) || (range(self, self->enemy) == RANGE_MELEE) )
  //		self->monsterinfo.nextframe = FRAME_attak402;
}

const soldier_frames_attack4: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldier_fire4),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldier_move_attack4 = mkmove(FRAME.FRAME_attak401, FRAME.FRAME_attak406, soldier_frames_attack4, soldier_run);

// soldier_frames_attack5/soldier_move_attack5 and soldier_fire5/
// soldier_attack5_refire (C: `#if 0` block, ATTACK5 "prone") dropped -- dead
// code, never referenced.

// ATTACK6 (run & shoot)

function soldier_fire8(self: EdictT): void {
  soldier_fire(self, 7);
}

function soldier_attack6_refire(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if (range(self, self.enemy) < RANGE_MID) return;

  if (cvarNum(gameCvars.skill) === 3) self.monsterinfo.nextframe = FRAME.FRAME_runs03;
}

const soldier_frames_attack6: MframeT[] = [
  mkframe(ai_charge, 10),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 12),
  mkframe(ai_charge, 11, soldier_fire8),
  mkframe(ai_charge, 13),
  mkframe(ai_charge, 18),
  mkframe(ai_charge, 15),
  mkframe(ai_charge, 14),
  mkframe(ai_charge, 11),
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 11),
  mkframe(ai_charge, 12),
  mkframe(ai_charge, 12),
  mkframe(ai_charge, 17, soldier_attack6_refire),
];
const soldier_move_attack6 = mkmove(FRAME.FRAME_runs01, FRAME.FRAME_runs14, soldier_frames_attack6, soldier_run);

function soldier_attack(self: EdictT): void {
  if (self.s.skinnum < 4) {
    if (random() < 0.5) self.monsterinfo.currentmove = soldier_move_attack1;
    else self.monsterinfo.currentmove = soldier_move_attack2;
  } else {
    self.monsterinfo.currentmove = soldier_move_attack4;
  }
}

//
// SIGHT
//

function soldier_sight(self: EdictT, _other: EdictT): void {
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_sight1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_sight2, 1, ATTN_NORM, 0);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (cvarNum(gameCvars.skill) > 0 && range(self, self.enemy) >= RANGE_MID) {
    if (random() > 0.5) self.monsterinfo.currentmove = soldier_move_attack6;
  }
}

//
// DUCK
//

function soldier_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

const soldier_frames_duck: MframeT[] = [
  mkframe(ai_move, 5, soldier_duck_down),
  mkframe(ai_move, -1, soldier_duck_hold),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0, soldier_duck_up),
  mkframe(ai_move, 5),
];
const soldier_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck05, soldier_frames_duck, soldier_run);

function soldier_dodge(self: EdictT, attacker: EdictT, eta: number): void {
  let r: number;

  r = random();
  if (r > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  if (cvarNum(gameCvars.skill) === 0) {
    self.monsterinfo.currentmove = soldier_move_duck;
    return;
  }

  self.monsterinfo.pausetime = level.time + eta + 0.3;
  r = random();

  if (cvarNum(gameCvars.skill) === 1) {
    if (r > 0.33) self.monsterinfo.currentmove = soldier_move_duck;
    else self.monsterinfo.currentmove = soldier_move_attack3;
    return;
  }

  if (cvarNum(gameCvars.skill) >= 2) {
    if (r > 0.66) self.monsterinfo.currentmove = soldier_move_duck;
    else self.monsterinfo.currentmove = soldier_move_attack3;
    return;
  }

  self.monsterinfo.currentmove = soldier_move_attack3;
}

//
// DEATH
//

function soldier_fire6(self: EdictT): void {
  soldier_fire(self, 5);
}

function soldier_fire7(self: EdictT): void {
  soldier_fire(self, 6);
}

function soldier_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const soldier_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, soldier_fire6),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, soldier_fire7),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const soldier_move_death1 = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death136, soldier_frames_death1, soldier_dead);

const soldier_frames_death2: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const soldier_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death235, soldier_frames_death2, soldier_dead);

const soldier_frames_death3: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const soldier_move_death3 = mkmove(FRAME.FRAME_death301, FRAME.FRAME_death345, soldier_frames_death3, soldier_dead);

const soldier_frames_death4: MframeT[] = Array.from({ length: 53 }, () => mkframe(ai_move, 0));
const soldier_move_death4 = mkmove(FRAME.FRAME_death401, FRAME.FRAME_death453, soldier_frames_death4, soldier_dead);

const soldier_frames_death5: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const soldier_move_death5 = mkmove(FRAME.FRAME_death501, FRAME.FRAME_death524, soldier_frames_death5, soldier_dead);

const soldier_frames_death6: MframeT[] = Array.from({ length: 10 }, () => mkframe(ai_move, 0));
const soldier_move_death6 = mkmove(FRAME.FRAME_death601, FRAME.FRAME_death610, soldier_frames_death6, soldier_dead);

function soldier_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, point: Vec3): void {
  let n: number;

  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (n = 0; n < 3; n++) {
      ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    }
    ThrowGib(self, "models/objects/gibs/chest/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.s.skinnum |= 1;

  if (self.s.skinnum === 1) gi.sound(self, CHAN_VOICE, sound_death_light, 1, ATTN_NORM, 0);
  else if (self.s.skinnum === 3) gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_death_ss, 1, ATTN_NORM, 0); // (self->s.skinnum == 5)

  if (Math.abs(self.s.origin[2] + self.viewheight - point[2]) <= 4) {
    // head shot
    self.monsterinfo.currentmove = soldier_move_death3;
    return;
  }

  n = Math.floor(Math.random() * 5);
  if (n === 0) self.monsterinfo.currentmove = soldier_move_death1;
  else if (n === 1) self.monsterinfo.currentmove = soldier_move_death2;
  else if (n === 2) self.monsterinfo.currentmove = soldier_move_death4;
  else if (n === 3) self.monsterinfo.currentmove = soldier_move_death5;
  else self.monsterinfo.currentmove = soldier_move_death6;
}

//
// SPAWN
//

function SP_monster_soldier_x(self: EdictT): void {
  self.s.modelindex = gi.modelindex("models/monsters/soldier/tris.md2");
  self.monsterinfo.scale = FRAME.MODEL_SCALE;
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  sound_idle = gi.soundindex("soldier/solidle1.wav");
  sound_sight1 = gi.soundindex("soldier/solsght1.wav");
  sound_sight2 = gi.soundindex("soldier/solsrch1.wav");
  sound_cock = gi.soundindex("infantry/infatck3.wav");

  self.mass = 100;

  self.pain = soldier_pain;
  self.die = soldier_die;

  self.monsterinfo.stand = soldier_stand;
  self.monsterinfo.walk = soldier_walk;
  self.monsterinfo.run = soldier_run;
  self.monsterinfo.dodge = soldier_dodge;
  self.monsterinfo.attack = soldier_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = soldier_sight;

  gi.linkentity(self);

  if (self.monsterinfo.stand) self.monsterinfo.stand(self);

  walkmonster_start(self);
}

/*QUAKED monster_soldier_light (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_light(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_x(self);

  sound_pain_light = gi.soundindex("soldier/solpain2.wav");
  sound_death_light = gi.soundindex("soldier/soldeth2.wav");
  gi.modelindex("models/objects/laser/tris.md2");
  gi.soundindex("misc/lasfly.wav");
  gi.soundindex("soldier/solatck2.wav");

  self.s.skinnum = 0;
  self.health = 20;
  self.gib_health = -30;
}

/*QUAKED monster_soldier (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_x(self);

  sound_pain = gi.soundindex("soldier/solpain1.wav");
  sound_death = gi.soundindex("soldier/soldeth1.wav");
  gi.soundindex("soldier/solatck1.wav");

  self.s.skinnum = 2;
  self.health = 30;
  self.gib_health = -30;
}

/*QUAKED monster_soldier_ss (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_ss(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_x(self);

  sound_pain_ss = gi.soundindex("soldier/solpain3.wav");
  sound_death_ss = gi.soundindex("soldier/soldeth3.wav");
  gi.soundindex("soldier/solatck3.wav");

  self.s.skinnum = 4;
  self.health = 40;
  self.gib_health = -30;
}

// ==============================================================================
//
// RAFAEL 13-APR-98
//
// The "soldierh" variant, used by the hyperblaster / lasergun / ripper
// soldier reskins. self.s.skinnum selects the weapon at runtime:
//   skinnum < 2  -> ripper (monster_fire_ionripper)
//   skinnum < 4  -> hyperblaster (monster_fire_blueblaster)
//   otherwise    -> lasergun (monster_dabeam beam entity)
//
// ==============================================================================

function soldierh_idle(self: EdictT): void {
  if (random() > 0.8) gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function soldierh_cock(self: EdictT): void {
  if (self.s.frame === FRAMEH.FRAME_stand322) gi.sound(self, CHAN_WEAPON, sound_cock, 1, ATTN_IDLE, 0);
  else gi.sound(self, CHAN_WEAPON, sound_cock, 1, ATTN_NORM, 0);
}

// STAND

const soldierh_frames_stand1: MframeT[] = Array.from({ length: 30 }, (_, i) => mkframe(ai_stand, 0, i === 0 ? soldierh_idle : null));
const soldierh_move_stand1 = mkmove(FRAMEH.FRAME_stand101, FRAMEH.FRAME_stand130, soldierh_frames_stand1, soldierh_stand);

const soldierh_frames_stand3: MframeT[] = Array.from({ length: 39 }, (_, i) => mkframe(ai_stand, 0, i === 21 ? soldierh_cock : null));
const soldierh_move_stand3 = mkmove(FRAMEH.FRAME_stand301, FRAMEH.FRAME_stand339, soldierh_frames_stand3, soldierh_stand);

function soldierh_stand(self: EdictT): void {
  if (self.monsterinfo.currentmove === soldierh_move_stand3 || random() < 0.8) self.monsterinfo.currentmove = soldierh_move_stand1;
  else self.monsterinfo.currentmove = soldierh_move_stand3;
}

//
// WALK
//

function soldierh_walk1_random(self: EdictT): void {
  if (random() > 0.1) self.monsterinfo.nextframe = FRAMEH.FRAME_walk101;
}

const soldierh_frames_walk1: MframeT[] = [
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, -1, soldierh_walk1_random),
  ...Array.from({ length: 23 }, () => mkframe(ai_walk, 0)),
];
const soldierh_move_walk1 = mkmove(FRAMEH.FRAME_walk101, FRAMEH.FRAME_walk133, soldierh_frames_walk1);

const soldierh_frames_walk2: MframeT[] = [
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 7),
];
const soldierh_move_walk2 = mkmove(FRAMEH.FRAME_walk209, FRAMEH.FRAME_walk218, soldierh_frames_walk2);

function soldierh_walk(self: EdictT): void {
  if (random() < 0.5) self.monsterinfo.currentmove = soldierh_move_walk1;
  else self.monsterinfo.currentmove = soldierh_move_walk2;
}

//
// RUN
//

const soldierh_frames_start_run: MframeT[] = [mkframe(ai_run, 7), mkframe(ai_run, 5)];
const soldierh_move_start_run = mkmove(FRAMEH.FRAME_run01, FRAMEH.FRAME_run02, soldierh_frames_start_run, soldierh_run);

const soldierh_frames_run: MframeT[] = [
  mkframe(ai_run, 10),
  mkframe(ai_run, 11),
  mkframe(ai_run, 11),
  mkframe(ai_run, 16),
  mkframe(ai_run, 10),
  mkframe(ai_run, 15),
];
const soldierh_move_run = mkmove(FRAMEH.FRAME_run03, FRAMEH.FRAME_run08, soldierh_frames_run);

function soldierh_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    self.monsterinfo.currentmove = soldierh_move_stand1;
    return;
  }

  if (
    self.monsterinfo.currentmove === soldierh_move_walk1 ||
    self.monsterinfo.currentmove === soldierh_move_walk2 ||
    self.monsterinfo.currentmove === soldierh_move_start_run
  ) {
    self.monsterinfo.currentmove = soldierh_move_run;
  } else {
    self.monsterinfo.currentmove = soldierh_move_start_run;
  }
}

//
// PAIN
//

const soldierh_frames_pain1: MframeT[] = [mkframe(ai_move, -3), mkframe(ai_move, 4), mkframe(ai_move, 1), mkframe(ai_move, 1), mkframe(ai_move, 0)];
const soldierh_move_pain1 = mkmove(FRAMEH.FRAME_pain101, FRAMEH.FRAME_pain105, soldierh_frames_pain1, soldierh_run);

const soldierh_frames_pain2: MframeT[] = [
  mkframe(ai_move, -13),
  mkframe(ai_move, -1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 4),
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
];
const soldierh_move_pain2 = mkmove(FRAMEH.FRAME_pain201, FRAMEH.FRAME_pain207, soldierh_frames_pain2, soldierh_run);

const soldierh_frames_pain3: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, 10),
  mkframe(ai_move, -4),
  mkframe(ai_move, -1),
  mkframe(ai_move, -3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 4),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
];
const soldierh_move_pain3 = mkmove(FRAMEH.FRAME_pain301, FRAMEH.FRAME_pain318, soldierh_frames_pain3, soldierh_run);

const soldierh_frames_pain4: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -10),
  mkframe(ai_move, -6),
  mkframe(ai_move, 8),
  mkframe(ai_move, 4),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 5),
  mkframe(ai_move, 2),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
];
const soldierh_move_pain4 = mkmove(FRAMEH.FRAME_pain401, FRAMEH.FRAME_pain417, soldierh_frames_pain4, soldierh_run);

function soldierh_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  let r: number;
  let n: number;

  if (self.health < self.max_health / 2) self.s.skinnum |= 1;

  if (level.time < self.pain_debounce_time) {
    if (
      self.velocity[2] > 100 &&
      (self.monsterinfo.currentmove === soldierh_move_pain1 ||
        self.monsterinfo.currentmove === soldierh_move_pain2 ||
        self.monsterinfo.currentmove === soldierh_move_pain3)
    ) {
      self.monsterinfo.currentmove = soldierh_move_pain4;
    }
    return;
  }

  self.pain_debounce_time = level.time + 3;

  n = self.s.skinnum | 1;
  if (n === 1) gi.sound(self, CHAN_VOICE, sound_pain_light, 1, ATTN_NORM, 0);
  else if (n === 3) gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain_ss, 1, ATTN_NORM, 0);

  if (self.velocity[2] > 100) {
    self.monsterinfo.currentmove = soldierh_move_pain4;
    return;
  }

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  r = random();

  if (r < 0.33) self.monsterinfo.currentmove = soldierh_move_pain1;
  else if (r < 0.66) self.monsterinfo.currentmove = soldierh_move_pain2;
  else self.monsterinfo.currentmove = soldierh_move_pain3;
}

//
// ATTACK
//

// C declares `extern void brain_dabeam (edict_t *self);` here but never
// calls it -- the actual laser beam entity is spawned via monster_dabeam
// (xatrix/g_monster.c), same as m_brain.c's tentacle beam. Dead
// declaration, not ported.

function soldierh_laserbeam(self: EdictT, flash_index: number): void {
  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();
  const tempang: Vec3 = vec3();
  const start: Vec3 = vec3();
  const dir: Vec3 = vec3();
  const angles: Vec3 = vec3();
  const end: Vec3 = vec3();
  const tempvec: Vec3 = vec3();

  // RAFAEL
  // this sound can't be called this frequent
  if (random() > 0.8) gi.sound(self, CHAN_AUTO, gi.soundindex("misc/lasfly.wav"), 1, ATTN_STATIC, 0);

  VectorCopy(self.s.origin, start);
  if (self.enemy === null) return; // C dereferences self->enemy unconditionally
  VectorCopy(self.enemy.s.origin, end);
  VectorSubtract(end, start, dir);
  vectoangles(dir, angles);
  VectorCopy(monsterFlashOffset()[flash_index], tempvec);

  const ent = G_Spawn();
  VectorCopy(self.s.origin, ent.s.origin);
  VectorCopy(angles, tempang);
  AngleVectors(tempang, forward, right, up);
  VectorCopy(tempang, ent.s.angles);
  VectorCopy(ent.s.origin, start);

  if (flash_index === 85) {
    VectorMA(start, tempvec[0] - 14, right, start);
    VectorMA(start, tempvec[2] + 8, up, start);
    VectorMA(start, tempvec[1], forward, start);
  } else {
    VectorMA(start, tempvec[0] + 2, right, start);
    VectorMA(start, tempvec[2] + 8, up, start);
    VectorMA(start, tempvec[1], forward, start);
  }

  VectorCopy(start, ent.s.origin);
  ent.enemy = self.enemy;
  ent.owner = self;

  ent.dmg = 1;

  monster_dabeam(ent);
}

function soldierh_fire(self: EdictT, flash_number: number): void {
  const start: Vec3 = vec3();
  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();
  const aim: Vec3 = vec3();
  const dir: Vec3 = vec3();
  const end: Vec3 = vec3();
  let r: number;
  let u: number;
  let flash_index: number;

  if (self.s.skinnum < 2) flash_index = blaster_flash[flash_number]; // ripper
  else if (self.s.skinnum < 4) flash_index = blaster_flash[flash_number]; // hyperblaster
  else flash_index = machinegun_flash[flash_number]; // laserbeam

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_index], forward, right, start);

  if (flash_number === 5 || flash_number === 6) {
    VectorCopy(forward, aim);
  } else {
    if (self.enemy === null) return; // C dereferences self->enemy unconditionally
    VectorCopy(self.enemy.s.origin, end);
    end[2] += self.enemy.viewheight;
    VectorSubtract(end, start, aim);
    vectoangles(aim, dir);
    AngleVectors(dir, forward, right, up);

    r = crandom() * 100;
    u = crandom() * 50;
    VectorMA(start, 8192, forward, end);
    VectorMA(end, r, right, end);
    VectorMA(end, u, up, end);

    VectorSubtract(end, start, aim);
    VectorNormalize(aim);
  }

  if (self.s.skinnum <= 1) {
    // RAFAEL 24-APR-98
    // droped the damage from 15 to 5
    monster_fire_ionripper(self, start, aim, 5, 600, flash_index, EF_IONRIPPER);
  } else if (self.s.skinnum <= 3) {
    monster_fire_blueblaster(self, start, aim, 1, 600, MZ_BLUEHYPERBLASTER, EF_BLUEHYPERBLASTER);
  } else {
    if (!(self.monsterinfo.aiflags & AI_HOLD_FRAME)) {
      self.monsterinfo.pausetime = level.time + (3 + Math.floor(Math.random() * 8)) * FRAMETIME;
    }

    soldierh_laserbeam(self, flash_index);

    if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
    else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
  }
}

// ATTACK1 (blaster/shotgun)

function soldierh_hyper_refire1(self: EdictT): void {
  if (self.s.skinnum < 2) return;
  else if (self.s.skinnum < 4) {
    if (random() < 0.7) self.s.frame = FRAMEH.FRAME_attak103;
    else gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/hyprbd1a.wav"), 1, ATTN_NORM, 0);
  }
}

function soldierh_ripper1(self: EdictT): void {
  if (self.s.skinnum < 2) soldierh_fire(self, 0);
  else if (self.s.skinnum < 4) soldierh_fire(self, 0);
}

function soldierh_fire1(self: EdictT): void {
  soldierh_fire(self, 0);
}

function soldierh_attack1_refire1(self: EdictT): void {
  if (self.s.skinnum > 1) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAMEH.FRAME_attak102;
  else self.monsterinfo.nextframe = FRAMEH.FRAME_attak110;
}

function soldierh_attack1_refire2(self: EdictT): void {
  if (self.s.skinnum < 2) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAMEH.FRAME_attak102;
}

function soldierh_hyper_sound(self: EdictT): void {
  if (self.s.skinnum < 2) return;
  else if (self.s.skinnum < 4) gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/hyprbl1a.wav"), 1, ATTN_NORM, 0);
  else return;
}

const soldierh_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_hyper_sound),
  mkframe(ai_charge, 0, soldierh_fire1),
  mkframe(ai_charge, 0, soldierh_ripper1),
  mkframe(ai_charge, 0, soldierh_ripper1),
  mkframe(ai_charge, 0, soldierh_attack1_refire1),
  mkframe(ai_charge, 0, soldierh_hyper_refire1),
  mkframe(ai_charge, 0, soldierh_cock),
  mkframe(ai_charge, 0, soldierh_attack1_refire2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldierh_move_attack1 = mkmove(FRAMEH.FRAME_attak101, FRAMEH.FRAME_attak112, soldierh_frames_attack1, soldierh_run);

// ATTACK2 (blaster/shotgun)

function soldierh_hyper_refire2(self: EdictT): void {
  if (self.s.skinnum < 2) return;
  else if (self.s.skinnum < 4) {
    if (random() < 0.7) self.s.frame = FRAMEH.FRAME_attak205;
    else gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/hyprbd1a.wav"), 1, ATTN_NORM, 0);
  }
}

function soldierh_ripper2(self: EdictT): void {
  if (self.s.skinnum < 2) soldierh_fire(self, 1);
  else if (self.s.skinnum < 4) soldierh_fire(self, 1);
}

function soldierh_fire2(self: EdictT): void {
  soldierh_fire(self, 1);
}

function soldierh_attack2_refire1(self: EdictT): void {
  if (self.s.skinnum > 1) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.nextframe = FRAMEH.FRAME_attak204;
  else self.monsterinfo.nextframe = FRAMEH.FRAME_attak216;
}

function soldierh_attack2_refire2(self: EdictT): void {
  if (self.s.skinnum < 2) return;

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  // C: `(A && B) || (C) && D` -- && binds tighter than || in both C and JS,
  // so this parses as `(A && B) || (C && D)`, meaning the skill-3 refire
  // branch fires regardless of self->s.skinnum. Preserved bug-for-bug from
  // xatrix/m_soldier.c's soldierh_attack2_refire2.
  if ((cvarNum(gameCvars.skill) === 3 && random() < 0.5) || (range(self, self.enemy) === RANGE_MELEE && self.s.skinnum < 4)) {
    self.monsterinfo.nextframe = FRAMEH.FRAME_attak204;
  }
}

const soldierh_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_hyper_sound),
  mkframe(ai_charge, 0, soldierh_fire2),
  mkframe(ai_charge, 0, soldierh_ripper2),
  mkframe(ai_charge, 0, soldierh_ripper2),
  mkframe(ai_charge, 0, soldierh_attack2_refire1),
  mkframe(ai_charge, 0, soldierh_hyper_refire2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_cock),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_attack2_refire2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldierh_move_attack2 = mkmove(FRAMEH.FRAME_attak201, FRAMEH.FRAME_attak218, soldierh_frames_attack2, soldierh_run);

// ATTACK3 (duck and shoot)

function soldierh_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.pausetime = level.time + 1;
  gi.linkentity(self);
}

function soldierh_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

function soldierh_fire3(self: EdictT): void {
  soldierh_duck_down(self);
  soldierh_fire(self, 2);
}

function soldierh_attack3_refire(self: EdictT): void {
  if (level.time + 0.4 < self.monsterinfo.pausetime) self.monsterinfo.nextframe = FRAMEH.FRAME_attak303;
}

const soldierh_frames_attack3: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_fire3),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_attack3_refire),
  mkframe(ai_charge, 0, soldierh_duck_up),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldierh_move_attack3 = mkmove(FRAMEH.FRAME_attak301, FRAMEH.FRAME_attak309, soldierh_frames_attack3, soldierh_run);

// ATTACK4 (machinegun)

function soldierh_fire4(self: EdictT): void {
  soldierh_fire(self, 3);
  //
  //	if (self->enemy->health <= 0)
  //		return;
  //
  //	if ( ((skill->value == 3) && (random() < 0.5)) || (range(self, self->enemy) == RANGE_MELEE) )
  //		self->monsterinfo.nextframe = FRAME_attak402;
}

const soldierh_frames_attack4: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, soldierh_fire4),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const soldierh_move_attack4 = mkmove(FRAMEH.FRAME_attak401, FRAMEH.FRAME_attak406, soldierh_frames_attack4, soldierh_run);

// soldierh_frames_attack5/soldierh_move_attack5 and soldierh_fire5/
// soldierh_attack5_refire (C: `#if 0` block, ATTACK5 "prone") dropped --
// dead code, never referenced.

// ATTACK6 (run & shoot)

function soldierh_fire8(self: EdictT): void {
  soldierh_fire(self, 7);
}

function soldierh_attack6_refire(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health <= 0) return;

  if (range(self, self.enemy) < RANGE_MID) return;

  if (cvarNum(gameCvars.skill) === 3) self.monsterinfo.nextframe = FRAMEH.FRAME_runs03;
}

const soldierh_frames_attack6: MframeT[] = [
  mkframe(ai_charge, 10),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 12),
  mkframe(ai_charge, 11, soldierh_fire8),
  mkframe(ai_charge, 13),
  mkframe(ai_charge, 18),
  mkframe(ai_charge, 15),
  mkframe(ai_charge, 14),
  mkframe(ai_charge, 11),
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 11),
  mkframe(ai_charge, 12),
  mkframe(ai_charge, 12),
  mkframe(ai_charge, 17, soldierh_attack6_refire),
];
const soldierh_move_attack6 = mkmove(FRAMEH.FRAME_runs01, FRAMEH.FRAME_runs14, soldierh_frames_attack6, soldierh_run);

function soldierh_attack(self: EdictT): void {
  if (self.s.skinnum < 4) {
    if (random() < 0.5) self.monsterinfo.currentmove = soldierh_move_attack1;
    else self.monsterinfo.currentmove = soldierh_move_attack2;
  } else {
    self.monsterinfo.currentmove = soldierh_move_attack4;
  }
}

//
// SIGHT
//

function soldierh_sight(self: EdictT, _other: EdictT): void {
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_sight1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_sight2, 1, ATTN_NORM, 0);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (cvarNum(gameCvars.skill) > 0 && range(self, self.enemy) >= RANGE_MID) {
    if (random() > 0.5) {
      if (self.s.skinnum < 4) self.monsterinfo.currentmove = soldierh_move_attack6;
      else self.monsterinfo.currentmove = soldierh_move_attack4;
    }
  }
}

//
// DUCK
//

function soldierh_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

const soldierh_frames_duck: MframeT[] = [
  mkframe(ai_move, 5, soldierh_duck_down),
  mkframe(ai_move, -1, soldierh_duck_hold),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0, soldierh_duck_up),
  mkframe(ai_move, 5),
];
const soldierh_move_duck = mkmove(FRAMEH.FRAME_duck01, FRAMEH.FRAME_duck05, soldierh_frames_duck, soldierh_run);

function soldierh_dodge(self: EdictT, attacker: EdictT, eta: number): void {
  let r: number;

  r = random();
  if (r > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  if (cvarNum(gameCvars.skill) === 0) {
    self.monsterinfo.currentmove = soldierh_move_duck;
    return;
  }

  self.monsterinfo.pausetime = level.time + eta + 0.3;
  r = random();

  if (cvarNum(gameCvars.skill) === 1) {
    if (r > 0.33) self.monsterinfo.currentmove = soldierh_move_duck;
    else self.monsterinfo.currentmove = soldierh_move_attack3;
    return;
  }

  if (cvarNum(gameCvars.skill) >= 2) {
    if (r > 0.66) self.monsterinfo.currentmove = soldierh_move_duck;
    else self.monsterinfo.currentmove = soldierh_move_attack3;
    return;
  }

  self.monsterinfo.currentmove = soldierh_move_attack3;
}

//
// DEATH
//

function soldierh_fire6(self: EdictT): void {
  // no fire laser
  if (self.s.skinnum < 4) soldierh_fire(self, 5);
}

function soldierh_fire7(self: EdictT): void {
  // no fire laser
  if (self.s.skinnum < 4) soldierh_fire(self, 6);
}

function soldierh_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const soldierh_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, soldierh_fire6),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, soldierh_fire7),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const soldierh_move_death1 = mkmove(FRAMEH.FRAME_death101, FRAMEH.FRAME_death136, soldierh_frames_death1, soldierh_dead);

const soldierh_frames_death2: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  ...Array.from({ length: 32 }, () => mkframe(ai_move, 0)),
];
const soldierh_move_death2 = mkmove(FRAMEH.FRAME_death201, FRAMEH.FRAME_death235, soldierh_frames_death2, soldierh_dead);

const soldierh_frames_death3: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  ...Array.from({ length: 42 }, () => mkframe(ai_move, 0)),
];
const soldierh_move_death3 = mkmove(FRAMEH.FRAME_death301, FRAMEH.FRAME_death345, soldierh_frames_death3, soldierh_dead);

const soldierh_frames_death4: MframeT[] = Array.from({ length: 53 }, () => mkframe(ai_move, 0));
const soldierh_move_death4 = mkmove(FRAMEH.FRAME_death401, FRAMEH.FRAME_death453, soldierh_frames_death4, soldierh_dead);

const soldierh_frames_death5: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  ...Array.from({ length: 21 }, () => mkframe(ai_move, 0)),
];
const soldierh_move_death5 = mkmove(FRAMEH.FRAME_death501, FRAMEH.FRAME_death524, soldierh_frames_death5, soldierh_dead);

const soldierh_frames_death6: MframeT[] = Array.from({ length: 10 }, () => mkframe(ai_move, 0));
const soldierh_move_death6 = mkmove(FRAMEH.FRAME_death601, FRAMEH.FRAME_death610, soldierh_frames_death6, soldierh_dead);

function soldierh_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, point: Vec3): void {
  let n: number;

  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (n = 0; n < 3; n++) {
      ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    }
    ThrowGib(self, "models/objects/gibs/chest/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.s.skinnum |= 1;

  if (self.s.skinnum === 1) gi.sound(self, CHAN_VOICE, sound_death_light, 1, ATTN_NORM, 0);
  else if (self.s.skinnum === 3) gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_death_ss, 1, ATTN_NORM, 0); // (self->s.skinnum == 5)

  if (Math.abs(self.s.origin[2] + self.viewheight - point[2]) <= 4) {
    // head shot
    self.monsterinfo.currentmove = soldierh_move_death3;
    return;
  }

  n = Math.floor(Math.random() * 5);
  if (n === 0) self.monsterinfo.currentmove = soldierh_move_death1;
  else if (n === 1) self.monsterinfo.currentmove = soldierh_move_death2;
  else if (n === 2) self.monsterinfo.currentmove = soldierh_move_death4;
  else if (n === 3) self.monsterinfo.currentmove = soldierh_move_death5;
  else self.monsterinfo.currentmove = soldierh_move_death6;
}

//
// SPAWN
//

function SP_monster_soldier_h(self: EdictT): void {
  self.s.modelindex = gi.modelindex("models/monsters/soldierh/tris.md2");
  self.monsterinfo.scale = FRAMEH.MODEL_SCALE;
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  sound_idle = gi.soundindex("soldier/solidle1.wav");
  sound_sight1 = gi.soundindex("soldier/solsght1.wav");
  sound_sight2 = gi.soundindex("soldier/solsrch1.wav");
  sound_cock = gi.soundindex("infantry/infatck3.wav");

  self.mass = 100;

  self.pain = soldierh_pain;
  self.die = soldierh_die;

  self.monsterinfo.stand = soldierh_stand;
  self.monsterinfo.walk = soldierh_walk;
  self.monsterinfo.run = soldierh_run;
  self.monsterinfo.dodge = soldierh_dodge;
  self.monsterinfo.attack = soldierh_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = soldierh_sight;

  gi.linkentity(self);

  // C leaves this call commented out (`// self->monsterinfo.stand (self);`)
  // -- soldierh relies solely on the explicit currentmove assignment below.
  self.monsterinfo.currentmove = soldierh_move_stand3;

  walkmonster_start(self);
}

/*QUAKED monster_soldier_ripper (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_ripper(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_h(self);

  sound_pain_light = gi.soundindex("soldier/solpain2.wav");
  sound_death_light = gi.soundindex("soldier/soldeth2.wav");

  gi.modelindex("models/objects/boomrang/tris.md2");
  gi.soundindex("misc/lasfly.wav");
  gi.soundindex("soldier/solatck2.wav");

  self.s.skinnum = 0;
  self.health = 50;
  self.gib_health = -30;
}

/*QUAKED monster_soldier_hypergun (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_hypergun(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_h(self);

  gi.modelindex("models/objects/blaser/tris.md2");
  sound_pain = gi.soundindex("soldier/solpain1.wav");
  sound_death = gi.soundindex("soldier/soldeth1.wav");
  gi.soundindex("soldier/solatck1.wav");

  self.s.skinnum = 2;
  self.health = 60;
  self.gib_health = -30;
}

/*QUAKED monster_soldier_lasergun (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_lasergun(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_h(self);

  sound_pain_ss = gi.soundindex("soldier/solpain3.wav");
  sound_death_ss = gi.soundindex("soldier/soldeth3.wav");
  gi.soundindex("soldier/solatck3.wav");

  self.s.skinnum = 4;
  self.health = 70;
  self.gib_health = -30;
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_soldier:soldier_pain", soldier_pain);
registerSaveFunction("m_soldier:soldier_die", soldier_die);
registerSaveFunction("m_soldier:soldier_stand", soldier_stand);
registerSaveFunction("m_soldier:soldier_walk", soldier_walk);
registerSaveFunction("m_soldier:soldier_run", soldier_run);
registerSaveFunction("m_soldier:soldier_dodge", soldier_dodge);
registerSaveFunction("m_soldier:soldier_attack", soldier_attack);
registerSaveFunction("m_soldier:soldier_sight", soldier_sight);
registerSaveMmove("m_soldier:soldier_move_stand1", soldier_move_stand1);
registerSaveMmove("m_soldier:soldier_move_stand3", soldier_move_stand3);
registerSaveMmove("m_soldier:soldier_move_walk1", soldier_move_walk1);
registerSaveMmove("m_soldier:soldier_move_walk2", soldier_move_walk2);
registerSaveMmove("m_soldier:soldier_move_start_run", soldier_move_start_run);
registerSaveMmove("m_soldier:soldier_move_run", soldier_move_run);
registerSaveMmove("m_soldier:soldier_move_pain1", soldier_move_pain1);
registerSaveMmove("m_soldier:soldier_move_pain2", soldier_move_pain2);
registerSaveMmove("m_soldier:soldier_move_pain3", soldier_move_pain3);
registerSaveMmove("m_soldier:soldier_move_pain4", soldier_move_pain4);
registerSaveMmove("m_soldier:soldier_move_attack1", soldier_move_attack1);
registerSaveMmove("m_soldier:soldier_move_attack2", soldier_move_attack2);
registerSaveMmove("m_soldier:soldier_move_attack3", soldier_move_attack3);
registerSaveMmove("m_soldier:soldier_move_attack4", soldier_move_attack4);
registerSaveMmove("m_soldier:soldier_move_attack6", soldier_move_attack6);
registerSaveMmove("m_soldier:soldier_move_duck", soldier_move_duck);
registerSaveMmove("m_soldier:soldier_move_death1", soldier_move_death1);
registerSaveMmove("m_soldier:soldier_move_death2", soldier_move_death2);
registerSaveMmove("m_soldier:soldier_move_death3", soldier_move_death3);
registerSaveMmove("m_soldier:soldier_move_death4", soldier_move_death4);
registerSaveMmove("m_soldier:soldier_move_death5", soldier_move_death5);
registerSaveMmove("m_soldier:soldier_move_death6", soldier_move_death6);

registerSaveFunction("m_soldier:soldierh_pain", soldierh_pain);
registerSaveFunction("m_soldier:soldierh_die", soldierh_die);
registerSaveFunction("m_soldier:soldierh_stand", soldierh_stand);
registerSaveFunction("m_soldier:soldierh_walk", soldierh_walk);
registerSaveFunction("m_soldier:soldierh_run", soldierh_run);
registerSaveFunction("m_soldier:soldierh_dodge", soldierh_dodge);
registerSaveFunction("m_soldier:soldierh_attack", soldierh_attack);
registerSaveFunction("m_soldier:soldierh_sight", soldierh_sight);
registerSaveMmove("m_soldier:soldierh_move_stand1", soldierh_move_stand1);
registerSaveMmove("m_soldier:soldierh_move_stand3", soldierh_move_stand3);
registerSaveMmove("m_soldier:soldierh_move_walk1", soldierh_move_walk1);
registerSaveMmove("m_soldier:soldierh_move_walk2", soldierh_move_walk2);
registerSaveMmove("m_soldier:soldierh_move_start_run", soldierh_move_start_run);
registerSaveMmove("m_soldier:soldierh_move_run", soldierh_move_run);
registerSaveMmove("m_soldier:soldierh_move_pain1", soldierh_move_pain1);
registerSaveMmove("m_soldier:soldierh_move_pain2", soldierh_move_pain2);
registerSaveMmove("m_soldier:soldierh_move_pain3", soldierh_move_pain3);
registerSaveMmove("m_soldier:soldierh_move_pain4", soldierh_move_pain4);
registerSaveMmove("m_soldier:soldierh_move_attack1", soldierh_move_attack1);
registerSaveMmove("m_soldier:soldierh_move_attack2", soldierh_move_attack2);
registerSaveMmove("m_soldier:soldierh_move_attack3", soldierh_move_attack3);
registerSaveMmove("m_soldier:soldierh_move_attack4", soldierh_move_attack4);
registerSaveMmove("m_soldier:soldierh_move_attack6", soldierh_move_attack6);
registerSaveMmove("m_soldier:soldierh_move_duck", soldierh_move_duck);
registerSaveMmove("m_soldier:soldierh_move_death1", soldierh_move_death1);
registerSaveMmove("m_soldier:soldierh_move_death2", soldierh_move_death2);
registerSaveMmove("m_soldier:soldierh_move_death3", soldierh_move_death3);
registerSaveMmove("m_soldier:soldierh_move_death4", soldierh_move_death4);
registerSaveMmove("m_soldier:soldierh_move_death5", soldierh_move_death5);
registerSaveMmove("m_soldier:soldierh_move_death6", soldierh_move_death6);
