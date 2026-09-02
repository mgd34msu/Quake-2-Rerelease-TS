/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from xatrix/m_gladb.c (GNU GPL v2 or later).

m_gladb.c is a renamed near-copy of game/m_gladiator.c (gladb_* instead of
gladiator_*) with real deltas from the diff against game/m_gladiator.c:
  - gladb_idle uses ATTN_IDLE (gladiator_idle uses ATTN_NORM)
  - the ranged attack fires fire_plasma(self, start, dir, 100, 725, 60, 60)
    (xatrix/g_weapon.c) instead of monster_fire_railgun -- a plasma weapon,
    not a railgun, despite reusing MZ2_GLADIATOR_RAILGUN_1 purely as the
    muzzle flash offset index. gladb_frames_attack_gun fires it on frames 3
    and 6 (1-based) plus a conditional "gladbGun_check" on the last frame
    that only fires on skill 3 (nightmare) -- gladiator_attack_gun fires
    once via GladiatorGun on frame 4.
  - health 800 (vs 400), mass 350 (vs 400); model "gladb" (vs "gladiatr")
  - RAFAEL: SP_monster_gladb sets monsterinfo.power_armor_type/power
    (shield, 400) -- gladiator has none
  - gladb_pain has NO "if (skill->value == 3) return -- no pain anims in
    nightmare" guard that gladiator_pain has, verified against both C files
    side by side. Ported bug-for-bug.
  - sound_gun is "weapons/plasshot.wav" (a placeholder per the C's own
    "note to self / need to change to PHALANX sound" comment) instead of
    "gladiator/railgun.wav"
This file adapts ../game (src/game)'s m_gladiator.ts port rather than
fresh-porting, per the diff-driven strategy for pack files that copy a
baseq2 source.
*/
/*
==============================================================================

	GLADIATOR BOSS

==============================================================================
*/

import { AngleVectors, vec3, VectorCopy, VectorLength, VectorNormalize, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, CHAN_AUTO, CHAN_VOICE, CHAN_WEAPON, type CvarT, MZ2_GLADIATOR_RAILGUN_1 } from "../shared/q_shared";
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
  POWER_ARMOR_SHIELD,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit, fire_plasma } from "./g_weapon";
import { walkmonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import * as F from "./m_gladb_frames";

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

function gladb_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function gladb_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function gladb_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

function gladb_cleaver_swing(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_cleaver_swing, 1, ATTN_NORM, 0);
}

const gladb_frames_stand: MframeT[] = Array.from({ length: 7 }, () => mf(ai_stand, 0, null));
const gladb_move_stand = new MmoveT();
gladb_move_stand.firstframe = F.FRAME_stand1;
gladb_move_stand.lastframe = F.FRAME_stand7;
gladb_move_stand.frame = gladb_frames_stand;
gladb_move_stand.endfunc = null;

function gladb_stand(self: EdictT): void {
  self.monsterinfo.currentmove = gladb_move_stand;
}

const gladb_frames_walk: MframeT[] = [
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
const gladb_move_walk = new MmoveT();
gladb_move_walk.firstframe = F.FRAME_walk1;
gladb_move_walk.lastframe = F.FRAME_walk16;
gladb_move_walk.frame = gladb_frames_walk;
gladb_move_walk.endfunc = null;

function gladb_walk(self: EdictT): void {
  self.monsterinfo.currentmove = gladb_move_walk;
}

const gladb_frames_run: MframeT[] = [
  mf(ai_run, 23),
  mf(ai_run, 14),
  mf(ai_run, 14),
  mf(ai_run, 21),
  mf(ai_run, 12),
  mf(ai_run, 13),
];
const gladb_move_run = new MmoveT();
gladb_move_run.firstframe = F.FRAME_run1;
gladb_move_run.lastframe = F.FRAME_run6;
gladb_move_run.frame = gladb_frames_run;
gladb_move_run.endfunc = null;

function gladb_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = gladb_move_stand;
  else self.monsterinfo.currentmove = gladb_move_run;
}

function GladbMelee(self: EdictT): void {
  const aim: Vec3 = vec3(MELEE_DISTANCE, self.mins[0], -4);
  if (fire_hit(self, aim, 20 + Math.floor(Math.random() * 5), 300)) {
    gi.sound(self, CHAN_AUTO, sound_cleaver_hit, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_AUTO, sound_cleaver_miss, 1, ATTN_NORM, 0);
  }
}

const gladb_frames_attack_melee: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladb_cleaver_swing),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, GladbMelee),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladb_cleaver_swing),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, GladbMelee),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
];
const gladb_move_attack_melee = new MmoveT();
gladb_move_attack_melee.firstframe = F.FRAME_melee1;
gladb_move_attack_melee.lastframe = F.FRAME_melee17;
gladb_move_attack_melee.frame = gladb_frames_attack_melee;
gladb_move_attack_melee.endfunc = gladb_run;

function gladb_melee(self: EdictT): void {
  self.monsterinfo.currentmove = gladb_move_attack_melee;
}

function gladbGun(self: EdictT): void {
  const start = vec3();
  const dir = vec3();
  const forward = vec3();
  const right = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_GLADIATOR_RAILGUN_1], forward, right, start);

  // calc direction to where we targted [sic, matches C source's comment typo]
  VectorSubtract(self.pos1, start, dir);
  VectorNormalize(dir);

  fire_plasma(self, start, dir, 100, 725, 60, 60);
}

function gladbGun_check(self: EdictT): void {
  if (cvarNum(gameCvars.skill) === 3) gladbGun(self);
}

const gladb_frames_attack_gun: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladbGun),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladbGun),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gladbGun_check),
];
const gladb_move_attack_gun = new MmoveT();
gladb_move_attack_gun.firstframe = F.FRAME_attack1;
gladb_move_attack_gun.lastframe = F.FRAME_attack9;
gladb_move_attack_gun.frame = gladb_frames_attack_gun;
gladb_move_attack_gun.endfunc = gladb_run;

function gladb_attack(self: EdictT): void {
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
  self.monsterinfo.currentmove = gladb_move_attack_gun;
}

const gladb_frames_pain: MframeT[] = Array.from({ length: 6 }, () => mf(ai_move, 0, null));
const gladb_move_pain = new MmoveT();
gladb_move_pain.firstframe = F.FRAME_pain1;
gladb_move_pain.lastframe = F.FRAME_pain6;
gladb_move_pain.frame = gladb_frames_pain;
gladb_move_pain.endfunc = gladb_run;

const gladb_frames_pain_air: MframeT[] = Array.from({ length: 7 }, () => mf(ai_move, 0, null));
const gladb_move_pain_air = new MmoveT();
gladb_move_pain_air.firstframe = F.FRAME_painup1;
gladb_move_pain_air.lastframe = F.FRAME_painup7;
gladb_move_pain_air.frame = gladb_frames_pain_air;
gladb_move_pain_air.endfunc = gladb_run;

function gladb_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) {
    if (self.velocity[2] > 100 && self.monsterinfo.currentmove === gladb_move_pain) {
      self.monsterinfo.currentmove = gladb_move_pain_air;
    }
    return;
  }

  self.pain_debounce_time = level.time + 3;

  if (Math.random() < 0.5) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  // Note: unlike gladiator_pain, gladb_pain has no
  // "if (skill->value == 3) return" nightmare guard -- verified against
  // xatrix/m_gladb.c, a genuine gameplay difference from m_gladiator.c.

  if (self.velocity[2] > 100) self.monsterinfo.currentmove = gladb_move_pain_air;
  else self.monsterinfo.currentmove = gladb_move_pain;
}

function gladb_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const gladb_frames_death: MframeT[] = Array.from({ length: 22 }, () => mf(ai_move, 0, null));
const gladb_move_death = new MmoveT();
gladb_move_death.firstframe = F.FRAME_death1;
gladb_move_death.lastframe = F.FRAME_death22;
gladb_move_death.frame = gladb_frames_death;
gladb_move_death.endfunc = gladb_dead;

function gladb_die(
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

  self.monsterinfo.currentmove = gladb_move_death;
}

/*QUAKED monster_gladb (1 .5 0) (-32 -32 -24) (32 32 64) Ambush Trigger_Spawn Sight
*/
export function SP_monster_gladb(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("gladiator/pain.wav");
  sound_pain2 = gi.soundindex("gladiator/gldpain2.wav");
  sound_die = gi.soundindex("gladiator/glddeth2.wav");
  // note to self
  // need to change to PHALANX sound
  sound_gun = gi.soundindex("weapons/plasshot.wav");

  sound_cleaver_swing = gi.soundindex("gladiator/melee1.wav");
  sound_cleaver_hit = gi.soundindex("gladiator/melee2.wav");
  sound_cleaver_miss = gi.soundindex("gladiator/melee3.wav");
  sound_idle = gi.soundindex("gladiator/gldidle1.wav");
  sound_search = gi.soundindex("gladiator/gldsrch1.wav");
  sound_sight = gi.soundindex("gladiator/sight.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/gladb/tris.md2");
  VectorSet(self.mins, -32, -32, -24);
  VectorSet(self.maxs, 32, 32, 64);

  self.health = 800;
  self.gib_health = -175;
  self.mass = 350;

  self.pain = gladb_pain;
  self.die = gladb_die;

  self.monsterinfo.stand = gladb_stand;
  self.monsterinfo.walk = gladb_walk;
  self.monsterinfo.run = gladb_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = gladb_attack;
  self.monsterinfo.melee = gladb_melee;
  self.monsterinfo.sight = gladb_sight;
  self.monsterinfo.idle = gladb_idle;
  self.monsterinfo.search = gladb_search;

  gi.linkentity(self);
  self.monsterinfo.currentmove = gladb_move_stand;
  self.monsterinfo.scale = F.MODEL_SCALE;

  self.monsterinfo.power_armor_type = POWER_ARMOR_SHIELD;
  self.monsterinfo.power_armor_power = 400;

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

registerSaveFunction("m_gladb:gladb_pain", gladb_pain);
registerSaveFunction("m_gladb:gladb_die", gladb_die);
registerSaveFunction("m_gladb:gladb_stand", gladb_stand);
registerSaveFunction("m_gladb:gladb_walk", gladb_walk);
registerSaveFunction("m_gladb:gladb_run", gladb_run);
registerSaveFunction("m_gladb:gladb_attack", gladb_attack);
registerSaveFunction("m_gladb:gladb_melee", gladb_melee);
registerSaveFunction("m_gladb:gladb_sight", gladb_sight);
registerSaveFunction("m_gladb:gladb_idle", gladb_idle);
registerSaveFunction("m_gladb:gladb_search", gladb_search);
registerSaveMmove("m_gladb:gladb_move_stand", gladb_move_stand);
registerSaveMmove("m_gladb:gladb_move_walk", gladb_move_walk);
registerSaveMmove("m_gladb:gladb_move_run", gladb_move_run);
registerSaveMmove("m_gladb:gladb_move_attack_melee", gladb_move_attack_melee);
registerSaveMmove("m_gladb:gladb_move_attack_gun", gladb_move_attack_gun);
registerSaveMmove("m_gladb:gladb_move_pain", gladb_move_pain);
registerSaveMmove("m_gladb:gladb_move_pain_air", gladb_move_pain_air);
registerSaveMmove("m_gladb:gladb_move_death", gladb_move_death);
