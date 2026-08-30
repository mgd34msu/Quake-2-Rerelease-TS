/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_gladiator.c (GNU GPL v2 or later).
*/
/*
==============================================================================

GLADIATOR

==============================================================================
*/
//
// rogue/m_gladiator.c vs baseq2/m_gladiator.c: banner swap plus one addition
// -- a new gladiator_blocked function (rogue/m_gladiator.c:319-330, wrapped
// in "//PGM"/"//PGM" markers) wired to `self->monsterinfo.blocked` in
// SP_monster_gladiator (rogue/m_gladiator.c:369). blocked_checkshot and
// blocked_checkplat are defined in g_newai.c, owned by the RG-systems unit
// (outside this unit's SCOPE); imported as if that module already exists,
// per this batch's brief. Everything else is copied from
// src/game/m_gladiator.ts with sibling imports repointed at the flat
// src/rogue/ layout.

import { AngleVectors, vec3, VectorCopy, VectorLength, VectorNormalize, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import { ATTN_NORM, CHAN_AUTO, CHAN_VOICE, CHAN_WEAPON, type CvarT, MZ2_GLADIATOR_RAILGUN_1 } from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk } from "./g_ai";
import {
  AI_STAND_GROUND,
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
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { monster_fire_railgun, walkmonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { blocked_checkplat, blocked_checkshot } from "./g_newai";
import * as F from "./m_gladiator_frames";

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

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_die = 0;
let sound_gun = 0;
let sound_cleaver_swing = 0;
let sound_cleaver_hit = 0;
let sound_cleaver_miss = 0;
let sound_idle = 0;
let sound_search = 0;
let sound_sight = 0;

function gladiator_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_NORM, 0);
}

function gladiator_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function gladiator_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

function gladiator_cleaver_swing(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_cleaver_swing, 1, ATTN_NORM, 0);
}

const gladiator_frames_stand: MframeT[] = Array.from({ length: 7 }, () => mf(ai_stand, 0, null));
const gladiator_move_stand = new MmoveT();
gladiator_move_stand.firstframe = F.FRAME_stand1;
gladiator_move_stand.lastframe = F.FRAME_stand7;
gladiator_move_stand.frame = gladiator_frames_stand;
gladiator_move_stand.endfunc = null;

function gladiator_stand(self: EdictT): void {
  self.monsterinfo.currentmove = gladiator_move_stand;
}

const gladiator_frames_walk: MframeT[] = [
  mf(ai_walk, 15),
  mf(ai_walk, 7),
  mf(ai_walk, 6),
  mf(ai_walk, 5),
  mf(ai_walk, 2),
  mf(ai_walk, 0),
  mf(ai_walk, 2),
  mf(ai_walk, 8),
  mf(ai_walk, 12),
  mf(ai_walk, 8),
  mf(ai_walk, 5),
  mf(ai_walk, 5),
  mf(ai_walk, 2),
  mf(ai_walk, 2),
  mf(ai_walk, 1),
  mf(ai_walk, 8),
];
const gladiator_move_walk = new MmoveT();
gladiator_move_walk.firstframe = F.FRAME_walk1;
gladiator_move_walk.lastframe = F.FRAME_walk16;
gladiator_move_walk.frame = gladiator_frames_walk;
gladiator_move_walk.endfunc = null;

function gladiator_walk(self: EdictT): void {
  self.monsterinfo.currentmove = gladiator_move_walk;
}

const gladiator_frames_run: MframeT[] = [
  mf(ai_run, 23),
  mf(ai_run, 14),
  mf(ai_run, 14),
  mf(ai_run, 21),
  mf(ai_run, 12),
  mf(ai_run, 13),
];
const gladiator_move_run = new MmoveT();
gladiator_move_run.firstframe = F.FRAME_run1;
gladiator_move_run.lastframe = F.FRAME_run6;
gladiator_move_run.frame = gladiator_frames_run;
gladiator_move_run.endfunc = null;

function gladiator_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = gladiator_move_stand;
  else self.monsterinfo.currentmove = gladiator_move_run;
}

function GaldiatorMelee(self: EdictT): void {
  const aim: Vec3 = vec3(MELEE_DISTANCE, self.mins[0], -4);
  if (fire_hit(self, aim, 20 + Math.floor(Math.random() * 5), 300)) {
    gi.sound(self, CHAN_AUTO, sound_cleaver_hit, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_AUTO, sound_cleaver_miss, 1, ATTN_NORM, 0);
  }
}

const gladiator_frames_attack_melee: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladiator_cleaver_swing),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, GaldiatorMelee),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladiator_cleaver_swing),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, GaldiatorMelee),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
];
const gladiator_move_attack_melee = new MmoveT();
gladiator_move_attack_melee.firstframe = F.FRAME_melee1;
gladiator_move_attack_melee.lastframe = F.FRAME_melee17;
gladiator_move_attack_melee.frame = gladiator_frames_attack_melee;
gladiator_move_attack_melee.endfunc = gladiator_run;

function gladiator_melee(self: EdictT): void {
  self.monsterinfo.currentmove = gladiator_move_attack_melee;
}

function GladiatorGun(self: EdictT): void {
  const start = vec3();
  const dir = vec3();
  const forward = vec3();
  const right = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_GLADIATOR_RAILGUN_1], forward, right, start);

  // calc direction to where we targeted
  VectorSubtract(self.pos1, start, dir);
  VectorNormalize(dir);

  monster_fire_railgun(self, start, dir, 50, 100, MZ2_GLADIATOR_RAILGUN_1);
}

const gladiator_frames_attack_gun: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, GladiatorGun),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
];
const gladiator_move_attack_gun = new MmoveT();
gladiator_move_attack_gun.firstframe = F.FRAME_attack1;
gladiator_move_attack_gun.lastframe = F.FRAME_attack9;
gladiator_move_attack_gun.frame = gladiator_frames_attack_gun;
gladiator_move_attack_gun.endfunc = gladiator_run;

function gladiator_attack(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  // a small safe zone
  const v = vec3();
  VectorSubtract(self.s.origin, self.enemy.s.origin, v);
  const range = VectorLength(v);
  if (range <= MELEE_DISTANCE + 32) return;

  // charge up the railgun
  gi.sound(self, CHAN_WEAPON, sound_gun, 1, ATTN_NORM, 0);
  VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
  self.pos1[2] += self.enemy.viewheight;
  self.monsterinfo.currentmove = gladiator_move_attack_gun;
}

const gladiator_frames_pain: MframeT[] = Array.from({ length: 6 }, () => mf(ai_move, 0, null));
const gladiator_move_pain = new MmoveT();
gladiator_move_pain.firstframe = F.FRAME_pain1;
gladiator_move_pain.lastframe = F.FRAME_pain6;
gladiator_move_pain.frame = gladiator_frames_pain;
gladiator_move_pain.endfunc = gladiator_run;

const gladiator_frames_pain_air: MframeT[] = Array.from({ length: 7 }, () => mf(ai_move, 0, null));
const gladiator_move_pain_air = new MmoveT();
gladiator_move_pain_air.firstframe = F.FRAME_painup1;
gladiator_move_pain_air.lastframe = F.FRAME_painup7;
gladiator_move_pain_air.frame = gladiator_frames_pain_air;
gladiator_move_pain_air.endfunc = gladiator_run;

function gladiator_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) {
    if (self.velocity[2] > 100 && self.monsterinfo.currentmove === gladiator_move_pain) {
      self.monsterinfo.currentmove = gladiator_move_pain_air;
    }
    return;
  }

  self.pain_debounce_time = level.time + 3;

  if (Math.random() < 0.5) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (self.velocity[2] > 100) self.monsterinfo.currentmove = gladiator_move_pain_air;
  else self.monsterinfo.currentmove = gladiator_move_pain;
}

function gladiator_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const gladiator_frames_death: MframeT[] = Array.from({ length: 22 }, () => mf(ai_move, 0, null));
const gladiator_move_death = new MmoveT();
gladiator_move_death.firstframe = F.FRAME_death1;
gladiator_move_death.lastframe = F.FRAME_death22;
gladiator_move_death.frame = gladiator_frames_death;
gladiator_move_death.endfunc = gladiator_dead;

function gladiator_die(
  self: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  damage: number,
  _point: Vec3,
): void {
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

  self.monsterinfo.currentmove = gladiator_move_death;
}

// ROGUE (rogue/m_gladiator.c:319-330, "//PGM"/"//PGM")
function gladiator_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  if (blocked_checkplat(self, dist)) return true;

  return false;
}

/*QUAKED monster_gladiator (1 .5 0) (-32 -32 -24) (32 32 64) Ambush Trigger_Spawn Sight
*/
export function SP_monster_gladiator(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("gladiator/pain.wav");
  sound_pain2 = gi.soundindex("gladiator/gldpain2.wav");
  sound_die = gi.soundindex("gladiator/glddeth2.wav");
  sound_gun = gi.soundindex("gladiator/railgun.wav");
  sound_cleaver_swing = gi.soundindex("gladiator/melee1.wav");
  sound_cleaver_hit = gi.soundindex("gladiator/melee2.wav");
  sound_cleaver_miss = gi.soundindex("gladiator/melee3.wav");
  sound_idle = gi.soundindex("gladiator/gldidle1.wav");
  sound_search = gi.soundindex("gladiator/gldsrch1.wav");
  sound_sight = gi.soundindex("gladiator/sight.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/gladiatr/tris.md2");
  VectorSet(self.mins, -32, -32, -24);
  VectorSet(self.maxs, 32, 32, 64);

  self.health = 400;
  self.gib_health = -175;
  self.mass = 400;

  self.pain = gladiator_pain;
  self.die = gladiator_die;

  self.monsterinfo.stand = gladiator_stand;
  self.monsterinfo.walk = gladiator_walk;
  self.monsterinfo.run = gladiator_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = gladiator_attack;
  self.monsterinfo.melee = gladiator_melee;
  self.monsterinfo.sight = gladiator_sight;
  self.monsterinfo.idle = gladiator_idle;
  self.monsterinfo.search = gladiator_search;
  self.monsterinfo.blocked = gladiator_blocked; // ROGUE (rogue/m_gladiator.c:369, "// PGM")

  gi.linkentity(self);
  self.monsterinfo.currentmove = gladiator_move_stand;
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

registerSaveFunction("m_gladiator:gladiator_pain", gladiator_pain);
registerSaveFunction("m_gladiator:gladiator_die", gladiator_die);
registerSaveFunction("m_gladiator:gladiator_stand", gladiator_stand);
registerSaveFunction("m_gladiator:gladiator_walk", gladiator_walk);
registerSaveFunction("m_gladiator:gladiator_run", gladiator_run);
registerSaveFunction("m_gladiator:gladiator_attack", gladiator_attack);
registerSaveFunction("m_gladiator:gladiator_melee", gladiator_melee);
registerSaveFunction("m_gladiator:gladiator_sight", gladiator_sight);
registerSaveFunction("m_gladiator:gladiator_idle", gladiator_idle);
registerSaveFunction("m_gladiator:gladiator_search", gladiator_search);
registerSaveFunction("m_gladiator:gladiator_blocked", gladiator_blocked);
registerSaveMmove("m_gladiator:gladiator_move_stand", gladiator_move_stand);
registerSaveMmove("m_gladiator:gladiator_move_walk", gladiator_move_walk);
registerSaveMmove("m_gladiator:gladiator_move_run", gladiator_move_run);
registerSaveMmove("m_gladiator:gladiator_move_attack_melee", gladiator_move_attack_melee);
registerSaveMmove("m_gladiator:gladiator_move_attack_gun", gladiator_move_attack_gun);
registerSaveMmove("m_gladiator:gladiator_move_pain", gladiator_move_pain);
registerSaveMmove("m_gladiator:gladiator_move_pain_air", gladiator_move_pain_air);
registerSaveMmove("m_gladiator:gladiator_move_death", gladiator_move_death);
