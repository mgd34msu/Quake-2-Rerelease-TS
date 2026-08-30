/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_mutant.c (GNU GPL v2 or later).
*/
/*
==============================================================================

mutant

==============================================================================
*/

import { AngleVectors, vec3, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorScale, VectorSet, type Vec3 } from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, CHAN_VOICE, CHAN_WEAPON, type CplaneT, type CsurfaceT, type CvarT } from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range } from "./g_ai";
import {
  AI_DUCKED,
  AI_STAND_GROUND,
  AS_MELEE,
  AS_MISSILE,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  GIB_ORGANIC,
  gi,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
  MOD_UNKNOWN,
  RANGE_MELEE,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { G_FreeEdict } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { M_CheckBottom } from "./m_move";
import { M_FlyCheck, walkmonster_start } from "./g_monster";
import { T_Damage } from "./g_combat";
import * as F from "./m_mutant_frames";

// mirrors g_monster.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function mf(
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

let sound_swing = 0;
let sound_hit = 0;
let sound_hit2 = 0;
let sound_death = 0;
let sound_idle = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_step1 = 0;
let sound_step2 = 0;
let sound_step3 = 0;
let sound_thud = 0;

//
// SOUNDS
//

function mutant_step(self: EdictT): void {
  // C: `n = (rand() + 1) % 3;` -- rand()/random() map to Math.random() per
  // PORTING.md; the `+1` offset on C's rand() range doesn't survive the
  // switch to a different RNG and has no effect on the uniform 0/1/2 draw,
  // so this reduces to the house `Math.floor(Math.random() * N)` idiom.
  const n = Math.floor(Math.random() * 3);
  if (n === 0) gi.sound(self, CHAN_VOICE, sound_step1, 1, ATTN_NORM, 0);
  else if (n === 1) gi.sound(self, CHAN_VOICE, sound_step2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_step3, 1, ATTN_NORM, 0);
}

function mutant_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function mutant_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

// C declares `mutant_swing` but never calls it (confirmed by grep across
// m_mutant.c); kept module-private to match the dead code in the original
// source rather than dropped as "unused".
function mutant_swing(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_swing, 1, ATTN_NORM, 0);
}

//
// STAND
//

// 51 identical `ai_stand, 0, NULL` rows (FRAME_stand101..FRAME_stand151)
const mutant_frames_stand: MframeT[] = Array.from({ length: 51 }, () => mf(ai_stand, 0, null));
const mutant_move_stand = new MmoveT();
mutant_move_stand.firstframe = F.FRAME_stand101;
mutant_move_stand.lastframe = F.FRAME_stand151;
mutant_move_stand.frame = mutant_frames_stand;
mutant_move_stand.endfunc = null;

function mutant_stand(self: EdictT): void {
  self.monsterinfo.currentmove = mutant_move_stand;
}

//
// IDLE
//

function mutant_idle_loop(self: EdictT): void {
  if (Math.random() < 0.75) self.monsterinfo.nextframe = F.FRAME_stand155;
}

const mutant_frames_idle: MframeT[] = [
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null), // scratch loop start
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, mutant_idle_loop), // scratch loop end
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
];
const mutant_move_idle = new MmoveT();
mutant_move_idle.firstframe = F.FRAME_stand152;
mutant_move_idle.lastframe = F.FRAME_stand164;
mutant_move_idle.frame = mutant_frames_idle;
mutant_move_idle.endfunc = mutant_stand;

function mutant_idle(self: EdictT): void {
  self.monsterinfo.currentmove = mutant_move_idle;
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

//
// WALK
//

const mutant_frames_walk: MframeT[] = [
  mf(ai_walk, 3),
  mf(ai_walk, 1),
  mf(ai_walk, 5),
  mf(ai_walk, 10),
  mf(ai_walk, 13),
  mf(ai_walk, 10),
  mf(ai_walk, 0),
  mf(ai_walk, 5),
  mf(ai_walk, 6),
  mf(ai_walk, 16),
  mf(ai_walk, 15),
  mf(ai_walk, 6),
];
const mutant_move_walk = new MmoveT();
mutant_move_walk.firstframe = F.FRAME_walk05;
mutant_move_walk.lastframe = F.FRAME_walk16;
mutant_move_walk.frame = mutant_frames_walk;
mutant_move_walk.endfunc = null;

function mutant_walk_loop(self: EdictT): void {
  self.monsterinfo.currentmove = mutant_move_walk;
}

const mutant_frames_start_walk: MframeT[] = [mf(ai_walk, 5), mf(ai_walk, 5), mf(ai_walk, -2), mf(ai_walk, 1)];
const mutant_move_start_walk = new MmoveT();
mutant_move_start_walk.firstframe = F.FRAME_walk01;
mutant_move_start_walk.lastframe = F.FRAME_walk04;
mutant_move_start_walk.frame = mutant_frames_start_walk;
mutant_move_start_walk.endfunc = mutant_walk_loop;

function mutant_walk(self: EdictT): void {
  self.monsterinfo.currentmove = mutant_move_start_walk;
}

//
// RUN
//

const mutant_frames_run: MframeT[] = [
  mf(ai_run, 40, null),
  mf(ai_run, 40, mutant_step),
  mf(ai_run, 24, null),
  mf(ai_run, 5, mutant_step),
  mf(ai_run, 17, null),
  mf(ai_run, 10, null),
];
const mutant_move_run = new MmoveT();
mutant_move_run.firstframe = F.FRAME_run03;
mutant_move_run.lastframe = F.FRAME_run08;
mutant_move_run.frame = mutant_frames_run;
mutant_move_run.endfunc = null;

function mutant_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = mutant_move_stand;
  else self.monsterinfo.currentmove = mutant_move_run;
}

//
// MELEE
//

function mutant_hit_left(self: EdictT): void {
  const aim: Vec3 = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, 10 + Math.floor(Math.random() * 5), 100)) {
    gi.sound(self, CHAN_WEAPON, sound_hit, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
  }
}

function mutant_hit_right(self: EdictT): void {
  const aim: Vec3 = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, 10 + Math.floor(Math.random() * 5), 100)) {
    gi.sound(self, CHAN_WEAPON, sound_hit2, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
  }
}

function mutant_check_refire(self: EdictT): void {
  if (!self.enemy || !self.enemy.inuse || self.enemy.health <= 0) return;

  if ((cvarNum(gameCvars.skill) === 3 && Math.random() < 0.5) || range(self, self.enemy) === RANGE_MELEE) {
    self.monsterinfo.nextframe = F.FRAME_attack09;
  }
}

const mutant_frames_attack: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, mutant_hit_left),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, mutant_hit_right),
  mf(ai_charge, 0, mutant_check_refire),
];
const mutant_move_attack = new MmoveT();
mutant_move_attack.firstframe = F.FRAME_attack09;
mutant_move_attack.lastframe = F.FRAME_attack15;
mutant_move_attack.frame = mutant_frames_attack;
mutant_move_attack.endfunc = mutant_run;

function mutant_melee(self: EdictT): void {
  self.monsterinfo.currentmove = mutant_move_attack;
}

//
// ATTACK
//

function mutant_jump_touch(
  self: EdictT,
  other: EdictT,
  _plane: CplaneT | null,
  _surf: CsurfaceT | null,
): void {
  if (self.health <= 0) {
    self.touch = null;
    return;
  }

  if (other.takedamage) {
    if (VectorLength(self.velocity) > 400) {
      const normal = vec3();
      VectorCopy(self.velocity, normal);
      VectorNormalize(normal);
      const point = vec3();
      VectorMA(self.s.origin, self.maxs[0], normal, point);
      const damage = 40 + Math.floor(10 * Math.random());
      T_Damage(other, self, self, self.velocity, point, normal, damage, damage, 0, MOD_UNKNOWN);
    }
  }

  if (!M_CheckBottom(self)) {
    if (self.groundentity) {
      self.monsterinfo.nextframe = F.FRAME_attack02;
      self.touch = null;
    }
    return;
  }

  self.touch = null;
}

function mutant_jump_takeoff(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  self.s.origin[2] += 1;
  VectorScale(forward, 600, self.velocity);
  self.velocity[2] = 250;
  self.groundentity = null;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.monsterinfo.attack_finished = level.time + 3;
  self.touch = mutant_jump_touch;
}

function mutant_check_landing(self: EdictT): void {
  if (self.groundentity) {
    gi.sound(self, CHAN_WEAPON, sound_thud, 1, ATTN_NORM, 0);
    self.monsterinfo.attack_finished = 0;
    self.monsterinfo.aiflags &= ~AI_DUCKED;
    return;
  }

  if (level.time > self.monsterinfo.attack_finished) self.monsterinfo.nextframe = F.FRAME_attack02;
  else self.monsterinfo.nextframe = F.FRAME_attack05;
}

const mutant_frames_jump: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 17, null),
  mf(ai_charge, 15, mutant_jump_takeoff),
  mf(ai_charge, 15, null),
  mf(ai_charge, 15, mutant_check_landing),
  mf(ai_charge, 0, null),
  mf(ai_charge, 3, null),
  mf(ai_charge, 0, null),
];
const mutant_move_jump = new MmoveT();
mutant_move_jump.firstframe = F.FRAME_attack01;
mutant_move_jump.lastframe = F.FRAME_attack08;
mutant_move_jump.frame = mutant_frames_jump;
mutant_move_jump.endfunc = mutant_run;

function mutant_jump(self: EdictT): void {
  self.monsterinfo.currentmove = mutant_move_jump;
}

//
// CHECKATTACK
//

function mutant_check_melee(self: EdictT): boolean {
  if (self.enemy === null) return false; // C assumes self->enemy is set here
  return range(self, self.enemy) === RANGE_MELEE;
}

function mutant_check_jump(self: EdictT): boolean {
  const enemy = self.enemy;
  if (enemy === null) return false; // C assumes self->enemy is set here

  if (self.absmin[2] > enemy.absmin[2] + 0.75 * enemy.size[2]) return false;

  if (self.absmax[2] < enemy.absmin[2] + 0.25 * enemy.size[2]) return false;

  const v = vec3(self.s.origin[0] - enemy.s.origin[0], self.s.origin[1] - enemy.s.origin[1], 0);
  const distance = VectorLength(v);

  if (distance < 100) return false;
  if (distance > 100) {
    if (Math.random() < 0.9) return false;
  }

  return true;
}

function mutant_checkattack(self: EdictT): boolean {
  if (!self.enemy || self.enemy.health <= 0) return false;

  if (mutant_check_melee(self)) {
    self.monsterinfo.attack_state = AS_MELEE;
    return true;
  }

  if (mutant_check_jump(self)) {
    self.monsterinfo.attack_state = AS_MISSILE;
    // FIXME play a jump sound here
    return true;
  }

  return false;
}

//
// PAIN
//

const mutant_frames_pain1: MframeT[] = [mf(ai_move, 4), mf(ai_move, -3), mf(ai_move, -8), mf(ai_move, 2), mf(ai_move, 5)];
const mutant_move_pain1 = new MmoveT();
mutant_move_pain1.firstframe = F.FRAME_pain101;
mutant_move_pain1.lastframe = F.FRAME_pain105;
mutant_move_pain1.frame = mutant_frames_pain1;
mutant_move_pain1.endfunc = mutant_run;

const mutant_frames_pain2: MframeT[] = [
  mf(ai_move, -24),
  mf(ai_move, 11),
  mf(ai_move, 5),
  mf(ai_move, -2),
  mf(ai_move, 6),
  mf(ai_move, 4),
];
const mutant_move_pain2 = new MmoveT();
mutant_move_pain2.firstframe = F.FRAME_pain201;
mutant_move_pain2.lastframe = F.FRAME_pain206;
mutant_move_pain2.frame = mutant_frames_pain2;
mutant_move_pain2.endfunc = mutant_run;

const mutant_frames_pain3: MframeT[] = [
  mf(ai_move, -22),
  mf(ai_move, 3),
  mf(ai_move, 3),
  mf(ai_move, 2),
  mf(ai_move, 1),
  mf(ai_move, 1),
  mf(ai_move, 6),
  mf(ai_move, 3),
  mf(ai_move, 2),
  mf(ai_move, 0),
  mf(ai_move, 1),
];
const mutant_move_pain3 = new MmoveT();
mutant_move_pain3.firstframe = F.FRAME_pain301;
mutant_move_pain3.lastframe = F.FRAME_pain311;
mutant_move_pain3.frame = mutant_frames_pain3;
mutant_move_pain3.endfunc = mutant_run;

function mutant_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  const r = Math.random();
  if (r < 0.33) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = mutant_move_pain1;
  } else if (r < 0.66) {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = mutant_move_pain2;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = mutant_move_pain3;
  }
}

//
// DEATH
//

function mutant_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  gi.linkentity(self);

  M_FlyCheck(self);
}

const mutant_frames_death1: MframeT[] = Array.from({ length: 9 }, () => mf(ai_move, 0, null));
const mutant_move_death1 = new MmoveT();
mutant_move_death1.firstframe = F.FRAME_death101;
mutant_move_death1.lastframe = F.FRAME_death109;
mutant_move_death1.frame = mutant_frames_death1;
mutant_move_death1.endfunc = mutant_dead;

const mutant_frames_death2: MframeT[] = Array.from({ length: 10 }, () => mf(ai_move, 0, null));
const mutant_move_death2 = new MmoveT();
mutant_move_death2.firstframe = F.FRAME_death201;
mutant_move_death2.lastframe = F.FRAME_death210;
mutant_move_death2.frame = mutant_frames_death2;
mutant_move_death2.endfunc = mutant_dead;

function mutant_die(
  self: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  damage: number,
  _point: Vec3,
): void {
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.s.skinnum = 1;

  if (Math.random() < 0.5) self.monsterinfo.currentmove = mutant_move_death1;
  else self.monsterinfo.currentmove = mutant_move_death2;
}

//
// SPAWN
//

/*QUAKED monster_mutant (1 .5 0) (-32 -32 -24) (32 32 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_mutant(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_swing = gi.soundindex("mutant/mutatck1.wav");
  sound_hit = gi.soundindex("mutant/mutatck2.wav");
  sound_hit2 = gi.soundindex("mutant/mutatck3.wav");
  sound_death = gi.soundindex("mutant/mutdeth1.wav");
  sound_idle = gi.soundindex("mutant/mutidle1.wav");
  sound_pain1 = gi.soundindex("mutant/mutpain1.wav");
  sound_pain2 = gi.soundindex("mutant/mutpain2.wav");
  sound_sight = gi.soundindex("mutant/mutsght1.wav");
  sound_search = gi.soundindex("mutant/mutsrch1.wav");
  sound_step1 = gi.soundindex("mutant/step1.wav");
  sound_step2 = gi.soundindex("mutant/step2.wav");
  sound_step3 = gi.soundindex("mutant/step3.wav");
  sound_thud = gi.soundindex("mutant/thud1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/mutant/tris.md2");
  VectorSet(self.mins, -32, -32, -24);
  VectorSet(self.maxs, 32, 32, 48);

  self.health = 300;
  self.gib_health = -120;
  self.mass = 300;

  self.pain = mutant_pain;
  self.die = mutant_die;

  self.monsterinfo.stand = mutant_stand;
  self.monsterinfo.walk = mutant_walk;
  self.monsterinfo.run = mutant_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = mutant_jump;
  self.monsterinfo.melee = mutant_melee;
  self.monsterinfo.sight = mutant_sight;
  self.monsterinfo.search = mutant_search;
  self.monsterinfo.idle = mutant_idle;
  self.monsterinfo.checkattack = mutant_checkattack;

  gi.linkentity(self);

  self.monsterinfo.currentmove = mutant_move_stand;

  self.monsterinfo.scale = F.MODEL_SCALE;
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

registerSaveFunction("m_mutant:mutant_jump_touch", mutant_jump_touch);
registerSaveFunction("m_mutant:mutant_pain", mutant_pain);
registerSaveFunction("m_mutant:mutant_die", mutant_die);
registerSaveFunction("m_mutant:mutant_stand", mutant_stand);
registerSaveFunction("m_mutant:mutant_walk", mutant_walk);
registerSaveFunction("m_mutant:mutant_run", mutant_run);
registerSaveFunction("m_mutant:mutant_jump", mutant_jump);
registerSaveFunction("m_mutant:mutant_melee", mutant_melee);
registerSaveFunction("m_mutant:mutant_sight", mutant_sight);
registerSaveFunction("m_mutant:mutant_search", mutant_search);
registerSaveFunction("m_mutant:mutant_idle", mutant_idle);
registerSaveFunction("m_mutant:mutant_checkattack", mutant_checkattack);
registerSaveMmove("m_mutant:mutant_move_stand", mutant_move_stand);
registerSaveMmove("m_mutant:mutant_move_idle", mutant_move_idle);
registerSaveMmove("m_mutant:mutant_move_walk", mutant_move_walk);
registerSaveMmove("m_mutant:mutant_move_start_walk", mutant_move_start_walk);
registerSaveMmove("m_mutant:mutant_move_run", mutant_move_run);
registerSaveMmove("m_mutant:mutant_move_attack", mutant_move_attack);
registerSaveMmove("m_mutant:mutant_move_jump", mutant_move_jump);
registerSaveMmove("m_mutant:mutant_move_pain1", mutant_move_pain1);
registerSaveMmove("m_mutant:mutant_move_pain2", mutant_move_pain2);
registerSaveMmove("m_mutant:mutant_move_pain3", mutant_move_pain3);
registerSaveMmove("m_mutant:mutant_move_death1", mutant_move_death1);
registerSaveMmove("m_mutant:mutant_move_death2", mutant_move_death2);
