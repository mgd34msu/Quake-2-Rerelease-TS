/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from xatrix/m_infantry.c (GNU GPL v2 or later), diffed against the
baseq2 port at src/game/m_infantry.ts.
*/
/*
==============================================================================

INFANTRY

==============================================================================
*/

import { AngleVectors, random, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_BODY,
  CHAN_VOICE,
  CHAN_WEAPON,
  MZ2_INFANTRY_MACHINEGUN_1,
  MZ2_INFANTRY_MACHINEGUN_2,
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
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_MELEE,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range } from "./g_ai";
import { M_FlyCheck, monster_fire_bullet, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_infantry_frames";

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD (m_tank.ts/p_weapon.ts each
// keep their own module-local copy too; not centralized anywhere in the
// header modules).
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_die1 = 0;
let sound_die2 = 0;

let sound_gunshot = 0;
let sound_weapon_cock = 0;
let sound_punch_swing = 0;
let sound_punch_hit = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_idle = 0;

function mkframe(aifunc: ((self: EdictT, dist: number) => void) | null, dist: number, thinkfunc: ((self: EdictT) => void) | null = null): MframeT {
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

const infantry_frames_stand: MframeT[] = [
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
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
];
const infantry_move_stand = mkmove(FRAME.FRAME_stand50, FRAME.FRAME_stand71, infantry_frames_stand);

export function infantry_stand(self: EdictT): void {
  self.monsterinfo.currentmove = infantry_move_stand;
}

const infantry_frames_fidget: MframeT[] = [
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 3),
  mkframe(ai_stand, 6),
  mkframe(ai_stand, 3),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -2),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, -1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -1),
  mkframe(ai_stand, -1),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -3),
  mkframe(ai_stand, -2),
  mkframe(ai_stand, -3),
  mkframe(ai_stand, -3),
  mkframe(ai_stand, -2),
];
const infantry_move_fidget = mkmove(FRAME.FRAME_stand01, FRAME.FRAME_stand49, infantry_frames_fidget, infantry_stand);

function infantry_fidget(self: EdictT): void {
  self.monsterinfo.currentmove = infantry_move_fidget;
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

const infantry_frames_walk: MframeT[] = [
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 5),
];
const infantry_move_walk = mkmove(FRAME.FRAME_walk03, FRAME.FRAME_walk14, infantry_frames_walk);

function infantry_walk(self: EdictT): void {
  self.monsterinfo.currentmove = infantry_move_walk;
}

const infantry_frames_run: MframeT[] = [
  mkframe(ai_run, 10),
  mkframe(ai_run, 20),
  mkframe(ai_run, 5),
  mkframe(ai_run, 7),
  mkframe(ai_run, 30),
  mkframe(ai_run, 35),
  mkframe(ai_run, 2),
  mkframe(ai_run, 6),
];
const infantry_move_run = mkmove(FRAME.FRAME_run01, FRAME.FRAME_run08, infantry_frames_run);

function infantry_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = infantry_move_stand;
  else self.monsterinfo.currentmove = infantry_move_run;
}

const infantry_frames_pain1: MframeT[] = [
  mkframe(ai_move, -3),
  mkframe(ai_move, -2),
  mkframe(ai_move, -1),
  mkframe(ai_move, -2),
  mkframe(ai_move, -1),
  mkframe(ai_move, 1),
  mkframe(ai_move, -1),
  mkframe(ai_move, 1),
  mkframe(ai_move, 6),
  mkframe(ai_move, 2),
];
const infantry_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain110, infantry_frames_pain1, infantry_run);

const infantry_frames_pain2: MframeT[] = [
  mkframe(ai_move, -3),
  mkframe(ai_move, -3),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 5),
  mkframe(ai_move, 2),
];
const infantry_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain210, infantry_frames_pain2, infantry_run);

function infantry_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // C: `n = rand() % 2;` -- see g_utils.ts's G_PickTarget comment on the
  // raw-rand()-modulo idiom mapping to Math.floor(Math.random() * N).
  const n = Math.floor(Math.random() * 2);
  if (n === 0) {
    self.monsterinfo.currentmove = infantry_move_pain1;
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.currentmove = infantry_move_pain2;
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  }
}

// C declares this global (not `static`) but no other translation unit
// references it via an `extern` declaration, so it stays module-private here.
const aimangles: readonly Vec3[] = fixedLength("aimangles", 12, [
  vec3(0.0, 5.0, 0.0),
  vec3(10.0, 15.0, 0.0),
  vec3(20.0, 25.0, 0.0),
  vec3(25.0, 35.0, 0.0),
  vec3(30.0, 40.0, 0.0),
  vec3(30.0, 45.0, 0.0),
  vec3(25.0, 50.0, 0.0),
  vec3(20.0, 40.0, 0.0),
  vec3(15.0, 35.0, 0.0),
  vec3(40.0, 35.0, 0.0),
  vec3(70.0, 35.0, 0.0),
  vec3(90.0, 35.0, 0.0),
]);

function InfantryMachineGun(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  let flash_number: number;

  // xatrix/m_infantry.c:250 -- the muzzle-flash dispatch checks
  // FRAME_attak103 here instead of baseq2's FRAME_attak111, matching the
  // restructured infantry_frames_attack1 table below (infantry_fire is now
  // called from the table's 3rd row instead of its 11th).
  if (self.s.frame === FRAME.FRAME_attak103) {
    flash_number = MZ2_INFANTRY_MACHINEGUN_1;
    AngleVectors(self.s.angles, forward, right, null);
    G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

    if (self.enemy) {
      const target = vec3();
      VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);
      target[2] += self.enemy.viewheight;
      VectorSubtract(target, start, forward);
      VectorNormalize(forward);
    } else {
      AngleVectors(self.s.angles, forward, right, null);
    }
  } else {
    flash_number = MZ2_INFANTRY_MACHINEGUN_2 + (self.s.frame - FRAME.FRAME_death211);

    AngleVectors(self.s.angles, forward, right, null);
    G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

    const vec = vec3();
    VectorSubtract(self.s.angles, aimangles[flash_number - MZ2_INFANTRY_MACHINEGUN_2] ?? vec3(), vec);
    AngleVectors(vec, forward, null, null);
  }

  monster_fire_bullet(self, start, forward, 3, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_number);
}

function infantry_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_sight, 1, ATTN_NORM, 0);
}

function infantry_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  gi.linkentity(self);

  M_FlyCheck(self);
}

const infantry_frames_death1: MframeT[] = [
  mkframe(ai_move, -4),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -4),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move, 1),
  mkframe(ai_move, -2),
  mkframe(ai_move, 2),
  mkframe(ai_move, 2),
  mkframe(ai_move, 9),
  mkframe(ai_move, 9),
  mkframe(ai_move, 5),
  mkframe(ai_move, -3),
  mkframe(ai_move, -3),
];
const infantry_move_death1 = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death120, infantry_frames_death1, infantry_dead);

// Off with his head
const infantry_frames_death2: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 5),
  mkframe(ai_move, -1),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 1),
  mkframe(ai_move, 4),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2, InfantryMachineGun),
  mkframe(ai_move, -2, InfantryMachineGun),
  mkframe(ai_move, -3, InfantryMachineGun),
  mkframe(ai_move, -1, InfantryMachineGun),
  mkframe(ai_move, -2, InfantryMachineGun),
  mkframe(ai_move, 0, InfantryMachineGun),
  mkframe(ai_move, 2, InfantryMachineGun),
  mkframe(ai_move, 2, InfantryMachineGun),
  mkframe(ai_move, 3, InfantryMachineGun),
  mkframe(ai_move, -10, InfantryMachineGun),
  mkframe(ai_move, -7, InfantryMachineGun),
  mkframe(ai_move, -8, InfantryMachineGun),
  mkframe(ai_move, -6),
  mkframe(ai_move, 4),
  mkframe(ai_move, 0),
];
const infantry_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death225, infantry_frames_death2, infantry_dead);

const infantry_frames_death3: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -6),
  mkframe(ai_move, -11),
  mkframe(ai_move, -3),
  mkframe(ai_move, -11),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const infantry_move_death3 = mkmove(FRAME.FRAME_death301, FRAME.FRAME_death309, infantry_frames_death3, infantry_dead);

export function infantry_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
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
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  // C: `n = rand() % 3;` -- see g_utils.ts's G_PickTarget comment on the
  // raw-rand()-modulo idiom mapping to Math.floor(Math.random() * N).
  const n = Math.floor(Math.random() * 3);
  if (n === 0) {
    self.monsterinfo.currentmove = infantry_move_death1;
    gi.sound(self, CHAN_VOICE, sound_die2, 1, ATTN_NORM, 0);
  } else if (n === 1) {
    self.monsterinfo.currentmove = infantry_move_death2;
    gi.sound(self, CHAN_VOICE, sound_die1, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.currentmove = infantry_move_death3;
    gi.sound(self, CHAN_VOICE, sound_die2, 1, ATTN_NORM, 0);
  }
}

function infantry_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.pausetime = level.time + 1;
  gi.linkentity(self);
}

function infantry_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

function infantry_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

const infantry_frames_duck: MframeT[] = [
  mkframe(ai_move, -2, infantry_duck_down),
  mkframe(ai_move, -5, infantry_duck_hold),
  mkframe(ai_move, 3),
  mkframe(ai_move, 4, infantry_duck_up),
  mkframe(ai_move, 0),
];
const infantry_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck05, infantry_frames_duck, infantry_run);

function infantry_dodge(self: EdictT, attacker: EdictT, _eta: number): void {
  if (random() > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  self.monsterinfo.currentmove = infantry_move_duck;
}

// xatrix/m_infantry.c splits baseq2's infantry_cock_gun into two functions:
// infantry_set_firetime computes the post-burst pause timer, and
// infantry_cock_gun now only plays the cocking sound.
function infantry_set_firetime(self: EdictT): void {
  // C: `n = (rand() & 15) + 5;` -- `rand() & 15` is a uniform 0..15 pick,
  // ported via the same Math.floor(Math.random() * N) idiom used elsewhere
  // for raw-rand()-modulo (g_utils.ts's G_PickTarget comment).
  const n = Math.floor(Math.random() * 16) + 5;
  self.monsterinfo.pausetime = level.time + n * FRAMETIME;
}

function infantry_cock_gun(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_weapon_cock, 1, ATTN_NORM, 0);
}

function infantry_fire(self: EdictT): void {
  InfantryMachineGun(self);

  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

// xatrix/m_infantry.c:485-499 replaces baseq2's 15-row table with a
// differently-shaped 15-row table: the pause-timer/fire/cock-gun callbacks
// move to different frames (infantry_set_firetime on row 1, infantry_fire on
// row 3, infantry_cock_gun on row 9) with all-new per-frame move deltas.
// Row count re-verified by hand against FRAME_attak101(184)..FRAME_attak115(198)
// = 15 frames -- matches, no allowFrameCountMismatch needed.
const infantry_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 10, infantry_set_firetime),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 0, infantry_fire),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, -7),
  mkframe(ai_charge, -6),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, 0, infantry_cock_gun),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -1),
];
const infantry_move_attack1 = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak115, infantry_frames_attack1, infantry_run);

function infantry_swing(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_punch_swing, 1, ATTN_NORM, 0);
}

function infantry_smack(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  // C: `(5 + (rand() % 5))` -- see g_utils.ts's G_PickTarget comment on the
  // raw-rand()-modulo idiom mapping to Math.floor(Math.random() * N).
  if (fire_hit(self, aim, 5 + Math.floor(Math.random() * 5), 50)) {
    gi.sound(self, CHAN_WEAPON, sound_punch_hit, 1, ATTN_NORM, 0);
  }
}

const infantry_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 0, infantry_swing),
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 8, infantry_smack),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 3),
];
const infantry_move_attack2 = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak208, infantry_frames_attack2, infantry_run);

function infantry_attack(self: EdictT): void {
  if (self.enemy !== null && range(self, self.enemy) === RANGE_MELEE) self.monsterinfo.currentmove = infantry_move_attack2;
  else self.monsterinfo.currentmove = infantry_move_attack1;
}

/*QUAKED monster_infantry (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_infantry(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("infantry/infpain1.wav");
  sound_pain2 = gi.soundindex("infantry/infpain2.wav");
  sound_die1 = gi.soundindex("infantry/infdeth1.wav");
  sound_die2 = gi.soundindex("infantry/infdeth2.wav");

  sound_gunshot = gi.soundindex("infantry/infatck1.wav");
  sound_weapon_cock = gi.soundindex("infantry/infatck3.wav");
  sound_punch_swing = gi.soundindex("infantry/infatck2.wav");
  sound_punch_hit = gi.soundindex("infantry/melee2.wav");

  sound_sight = gi.soundindex("infantry/infsght1.wav");
  sound_search = gi.soundindex("infantry/infsrch1.wav");
  sound_idle = gi.soundindex("infantry/infidle1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/infantry/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 100;
  self.gib_health = -40;
  self.mass = 200;

  self.pain = infantry_pain;
  self.die = infantry_die;

  self.monsterinfo.stand = infantry_stand;
  self.monsterinfo.walk = infantry_walk;
  self.monsterinfo.run = infantry_run;
  self.monsterinfo.dodge = infantry_dodge;
  self.monsterinfo.attack = infantry_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = infantry_sight;
  self.monsterinfo.idle = infantry_fidget;

  gi.linkentity(self);

  self.monsterinfo.currentmove = infantry_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

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

registerSaveFunction("m_infantry:infantry_pain", infantry_pain);
registerSaveFunction("m_infantry:infantry_die", infantry_die);
registerSaveFunction("m_infantry:infantry_stand", infantry_stand);
registerSaveFunction("m_infantry:infantry_walk", infantry_walk);
registerSaveFunction("m_infantry:infantry_run", infantry_run);
registerSaveFunction("m_infantry:infantry_dodge", infantry_dodge);
registerSaveFunction("m_infantry:infantry_attack", infantry_attack);
registerSaveFunction("m_infantry:infantry_sight", infantry_sight);
registerSaveFunction("m_infantry:infantry_fidget", infantry_fidget);
registerSaveMmove("m_infantry:infantry_move_stand", infantry_move_stand);
registerSaveMmove("m_infantry:infantry_move_fidget", infantry_move_fidget);
registerSaveMmove("m_infantry:infantry_move_walk", infantry_move_walk);
registerSaveMmove("m_infantry:infantry_move_run", infantry_move_run);
registerSaveMmove("m_infantry:infantry_move_pain1", infantry_move_pain1);
registerSaveMmove("m_infantry:infantry_move_pain2", infantry_move_pain2);
registerSaveMmove("m_infantry:infantry_move_death1", infantry_move_death1);
registerSaveMmove("m_infantry:infantry_move_death2", infantry_move_death2);
registerSaveMmove("m_infantry:infantry_move_death3", infantry_move_death3);
registerSaveMmove("m_infantry:infantry_move_duck", infantry_move_duck);
registerSaveMmove("m_infantry:infantry_move_attack1", infantry_move_attack1);
registerSaveMmove("m_infantry:infantry_move_attack2", infantry_move_attack2);
