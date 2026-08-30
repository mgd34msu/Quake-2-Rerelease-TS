/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.
Ported from rogue/m_brain.c.

rogue/m_brain.c vs baseq2/m_brain.c: brain_duck_down/brain_duck_hold/
brain_duck_up (this file's own duck-animation callbacks) are replaced by the
shared monster_duck_down/monster_duck_hold/monster_duck_up helpers (rogue/
g_newai.c, ported at src/rogue/g_newai.ts -- RG-systems' SCOPE), used
directly in brain_frames_duck. The old random-chance brain_dodge is entirely
wrapped in a C block comment in the source (m_brain.c:308-355) and dropped
per PORTING.md's "#if 0 blocks are dropped silently" rule; monsterinfo.dodge
is now the shared M_MonsterDodge dispatcher (also g_newai.c/g_newai.ts),
which takes the widened 4-argument dodge signature (g_local.ts's
MonsterInfoT.dodge). A new brain_duck(self, eta) function (m_brain.c:624-637)
is wired to the new monsterinfo.duck field, and monsterinfo.unduck is wired
to monster_duck_up. brain_pain gains a "clear duck flag" step that calls
monster_duck_up when AI_DUCKED is set (m_brain.c:574-575).
*/
/*
==============================================================================

brain

==============================================================================
*/

import { random, vec3, VectorSet, type Vec3 } from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, CHAN_AUTO, CHAN_BODY, CHAN_VOICE, CHAN_WEAPON } from "../shared/q_shared";
import {
  AI_DUCKED,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk } from "./g_ai";
import { fire_hit } from "./g_weapon";
import { walkmonster_start } from "./g_monster";
import { G_FreeEdict } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { M_MonsterDodge, monster_duck_down, monster_duck_hold, monster_duck_up } from "./g_newai";
import * as FRAME from "./m_brain_frames";

// C's raw `#define` spawnflags bit brain_chest_open/brain_tentacle_attack/
// brain_chest_closed use directly (65536); not part of the shared spawnflags
// table so it stays a module-local literal, matching the C source's own
// unexplained magic number.
const BRAIN_CHEST_OPEN_FLAG = 65536;

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

function mkframe(aifunc: ((self: EdictT, dist: number) => void) | null, dist: number, thinkfunc: ((self: EdictT) => void) | null = null): MframeT {
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
  allowFrameCountMismatch = false,
): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.allowFrameCountMismatch = allowFrameCountMismatch;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_chest_open = 0;
let sound_tentacles_extend = 0;
let sound_tentacles_retract = 0;
let sound_death = 0;
let sound_idle1 = 0;
let sound_idle2 = 0;
let sound_idle3 = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_melee1 = 0;
let sound_melee2 = 0;
let sound_melee3 = 0;

function brain_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function brain_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

//
// STAND
//

const brain_frames_stand: MframeT[] = [
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
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
];
const brain_move_stand = mkmove(FRAME.FRAME_stand01, FRAME.FRAME_stand30, brain_frames_stand, null);

function brain_stand(self: EdictT): void {
  self.monsterinfo.currentmove = brain_move_stand;
}

//
// IDLE
//

const brain_frames_idle: MframeT[] = [
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
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
];
const brain_move_idle = mkmove(FRAME.FRAME_stand31, FRAME.FRAME_stand60, brain_frames_idle, brain_stand);

function brain_idle(self: EdictT): void {
  gi.sound(self, CHAN_AUTO, sound_idle3, 1, ATTN_IDLE, 0);
  self.monsterinfo.currentmove = brain_move_idle;
}

//
// WALK
//

const brain_frames_walk1: MframeT[] = [
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, -4),
  mkframe(ai_walk, -1),
  mkframe(ai_walk, 2),
];
const brain_move_walk1 = mkmove(FRAME.FRAME_walk101, FRAME.FRAME_walk111, brain_frames_walk1, null);

// walk2 is FUBAR, do not use -- dropped with the C source's own #if 0 block
// (brain_walk2_cycle / brain_frames_walk2 / brain_move_walk2).

function brain_walk(self: EdictT): void {
  // if (random() <= 0.5)
  self.monsterinfo.currentmove = brain_move_walk1;
  // else
  // 	self->monsterinfo.currentmove = &brain_move_walk2;
}

const brain_frames_defense: MframeT[] = [
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
// C declares brain_move_defense but nothing in this file (or SP_monster_brain)
// ever assigns it to monsterinfo.currentmove; dead code in the original too.
// It also carries a second C bug independent of that: m_brain.c's
// brain_frames_defense[] has 9 rows but FRAME_defens01(154)..FRAME_defens08(161)
// only spans 8 (rogue/m_brain.c:244-256, unchanged from baseq2). Preserved
// byte-for-byte.
const brain_move_defense = mkmove(FRAME.FRAME_defens01, FRAME.FRAME_defens08, brain_frames_defense, null, true);

const brain_frames_pain3: MframeT[] = [
  mkframe(ai_move, -2),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, -4),
];
const brain_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain306, brain_frames_pain3, brain_run);

const brain_frames_pain2: MframeT[] = [
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move, -2),
];
const brain_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain208, brain_frames_pain2, brain_run);

const brain_frames_pain1: MframeT[] = [
  mkframe(ai_move, -6),
  mkframe(ai_move, -2),
  mkframe(ai_move, -6),
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
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 7),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, -1),
];
const brain_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain121, brain_frames_pain1, brain_run);

//
// DUCK
//
// brain_duck_down/brain_duck_hold/brain_duck_up are gone from this file --
// rogue's m_brain.c uses the shared monster_duck_down/monster_duck_hold/
// monster_duck_up frame callbacks (g_newai.c) directly in the frame table
// below instead of file-local wrappers.

const brain_frames_duck: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, -2, monster_duck_down),
  mkframe(ai_move, 17, monster_duck_hold),
  mkframe(ai_move, -3),
  mkframe(ai_move, -1, monster_duck_up),
  mkframe(ai_move, -5),
  mkframe(ai_move, -6),
  mkframe(ai_move, -6),
];
const brain_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck08, brain_frames_duck, brain_run);

// ROGUE: the old random-chance brain_dodge(self, attacker, eta) is entirely
// commented out in rogue/m_brain.c (lines 308-355) -- monsterinfo.dodge is
// wired to the shared M_MonsterDodge (g_newai.c) in SP_monster_brain below
// instead. Per PORTING.md's "#if 0 blocks are dropped silently" rule, the
// old function is not re-declared here.

function brain_duck(self: EdictT, eta: number): void {
  // has to be done immediately otherwise he can get stuck
  monster_duck_down(self);

  if (cvarNum(gameCvars.skill) === 0) {
    // PMM - stupid dodge
    self.monsterinfo.duck_wait_time = level.time + eta + 1;
  } else {
    self.monsterinfo.duck_wait_time = level.time + eta + 0.1 * (3 - cvarNum(gameCvars.skill));
  }

  self.monsterinfo.currentmove = brain_move_duck;
  self.monsterinfo.nextframe = FRAME.FRAME_duck01;
}

const brain_frames_death2: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 9), mkframe(ai_move, 0)];
const brain_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death205, brain_frames_death2, brain_dead);

const brain_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, 9),
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
const brain_move_death1 = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death118, brain_frames_death1, brain_dead);

//
// MELEE
//

function brain_swing_right(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_melee1, 1, ATTN_NORM, 0);
}

function brain_hit_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, 15 + (Math.floor(Math.random() * 5) % 5), 40)) gi.sound(self, CHAN_WEAPON, sound_melee3, 1, ATTN_NORM, 0);
}

function brain_swing_left(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_melee2, 1, ATTN_NORM, 0);
}

function brain_hit_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, 15 + (Math.floor(Math.random() * 5) % 5), 40)) gi.sound(self, CHAN_WEAPON, sound_melee3, 1, ATTN_NORM, 0);
}

const brain_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -3, brain_swing_right),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -5),
  mkframe(ai_charge, -7, brain_hit_right),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 6, brain_swing_left),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 2, brain_hit_left),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -11),
];
const brain_move_attack1 = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak118, brain_frames_attack1, brain_run);

function brain_chest_open(self: EdictT): void {
  self.spawnflags &= ~BRAIN_CHEST_OPEN_FLAG;
  self.monsterinfo.power_armor_type = POWER_ARMOR_NONE;
  gi.sound(self, CHAN_BODY, sound_chest_open, 1, ATTN_NORM, 0);
}

function brain_tentacle_attack(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 8);
  if (fire_hit(self, aim, 10 + (Math.floor(Math.random() * 5) % 5), -600) && cvarNum(gameCvars.skill) > 0) self.spawnflags |= BRAIN_CHEST_OPEN_FLAG;
  gi.sound(self, CHAN_WEAPON, sound_tentacles_retract, 1, ATTN_NORM, 0);
}

function brain_chest_closed(self: EdictT): void {
  self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
  if (self.spawnflags & BRAIN_CHEST_OPEN_FLAG) {
    self.spawnflags &= ~BRAIN_CHEST_OPEN_FLAG;
    self.monsterinfo.currentmove = brain_move_attack1;
  }
}

const brain_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 5),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 0, brain_chest_open),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 13, brain_tentacle_attack),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -9, brain_chest_closed),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, -6),
];
const brain_move_attack2 = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak217, brain_frames_attack2, brain_run);

function brain_melee(self: EdictT): void {
  if (random() <= 0.5) self.monsterinfo.currentmove = brain_move_attack1;
  else self.monsterinfo.currentmove = brain_move_attack2;
}

//
// RUN
//

const brain_frames_run: MframeT[] = [
  mkframe(ai_run, 9),
  mkframe(ai_run, 2),
  mkframe(ai_run, 3),
  mkframe(ai_run, 3),
  mkframe(ai_run, 1),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, 10),
  mkframe(ai_run, -4),
  mkframe(ai_run, -1),
  mkframe(ai_run, 2),
];
const brain_move_run = mkmove(FRAME.FRAME_walk101, FRAME.FRAME_walk111, brain_frames_run, null);

function brain_run(self: EdictT): void {
  self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = brain_move_stand;
  else self.monsterinfo.currentmove = brain_move_run;
}

function brain_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  const r = random();
  if (r < 0.33) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = brain_move_pain1;
  } else if (r < 0.66) {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = brain_move_pain2;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = brain_move_pain3;
  }
  // PMM - clear duck flag
  if (self.monsterinfo.aiflags & AI_DUCKED) monster_duck_up(self);
}

function brain_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function brain_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  self.s.effects = 0;
  self.monsterinfo.power_armor_type = POWER_ARMOR_NONE;

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
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  if (random() <= 0.5) self.monsterinfo.currentmove = brain_move_death1;
  else self.monsterinfo.currentmove = brain_move_death2;
}

/*QUAKED monster_brain (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_brain(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_chest_open = gi.soundindex("brain/brnatck1.wav");
  sound_tentacles_extend = gi.soundindex("brain/brnatck2.wav");
  sound_tentacles_retract = gi.soundindex("brain/brnatck3.wav");
  sound_death = gi.soundindex("brain/brndeth1.wav");
  sound_idle1 = gi.soundindex("brain/brnidle1.wav");
  sound_idle2 = gi.soundindex("brain/brnidle2.wav");
  sound_idle3 = gi.soundindex("brain/brnlens1.wav");
  sound_pain1 = gi.soundindex("brain/brnpain1.wav");
  sound_pain2 = gi.soundindex("brain/brnpain2.wav");
  sound_sight = gi.soundindex("brain/brnsght1.wav");
  sound_search = gi.soundindex("brain/brnsrch1.wav");
  sound_melee1 = gi.soundindex("brain/melee1.wav");
  sound_melee2 = gi.soundindex("brain/melee2.wav");
  sound_melee3 = gi.soundindex("brain/melee3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/brain/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 300;
  self.gib_health = -150;
  self.mass = 400;

  self.pain = brain_pain;
  self.die = brain_die;

  self.monsterinfo.stand = brain_stand;
  self.monsterinfo.walk = brain_walk;
  self.monsterinfo.run = brain_run;
  // PMM
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = brain_duck;
  self.monsterinfo.unduck = monster_duck_up;
  // pmm
  // self.monsterinfo.attack = brain_attack; -- commented out in the C source too
  self.monsterinfo.melee = brain_melee;
  self.monsterinfo.sight = brain_sight;
  self.monsterinfo.search = brain_search;
  self.monsterinfo.idle = brain_idle;

  self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
  self.monsterinfo.power_armor_power = 100;

  gi.linkentity(self);

  self.monsterinfo.currentmove = brain_move_stand;
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

registerSaveFunction("m_brain:brain_pain", brain_pain);
registerSaveFunction("m_brain:brain_die", brain_die);
registerSaveFunction("m_brain:brain_stand", brain_stand);
registerSaveFunction("m_brain:brain_walk", brain_walk);
registerSaveFunction("m_brain:brain_run", brain_run);
registerSaveFunction("m_brain:brain_duck", brain_duck);
registerSaveFunction("m_brain:brain_melee", brain_melee);
registerSaveFunction("m_brain:brain_sight", brain_sight);
registerSaveFunction("m_brain:brain_search", brain_search);
registerSaveFunction("m_brain:brain_idle", brain_idle);
registerSaveMmove("m_brain:brain_move_stand", brain_move_stand);
registerSaveMmove("m_brain:brain_move_idle", brain_move_idle);
registerSaveMmove("m_brain:brain_move_walk1", brain_move_walk1);
registerSaveMmove("m_brain:brain_move_defense", brain_move_defense);
registerSaveMmove("m_brain:brain_move_pain3", brain_move_pain3);
registerSaveMmove("m_brain:brain_move_pain2", brain_move_pain2);
registerSaveMmove("m_brain:brain_move_pain1", brain_move_pain1);
registerSaveMmove("m_brain:brain_move_duck", brain_move_duck);
registerSaveMmove("m_brain:brain_move_death2", brain_move_death2);
registerSaveMmove("m_brain:brain_move_death1", brain_move_death1);
registerSaveMmove("m_brain:brain_move_attack1", brain_move_attack1);
registerSaveMmove("m_brain:brain_move_attack2", brain_move_attack2);
registerSaveMmove("m_brain:brain_move_run", brain_move_run);
