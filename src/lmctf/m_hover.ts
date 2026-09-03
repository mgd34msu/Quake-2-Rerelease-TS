/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_hover.c (GNU GPL v2 or later).

rogue/m_hover.c vs baseq2/m_hover.c: this file now spawns two classnames
("monster_hover" and the pack's new "monster_daedalus", an upgraded hover
distinguished by self.mass < 225 at every sound/attack branch and by
self.classname === "monster_daedalus" in SP_monster_hover), adds a
circle-strafe attack pair (hover_move_start_attack2/attack2/end_attack2,
chosen by hover_attack's skill-scaled chance, "the daedalus strafes more"),
lets hover_reattack pick between the straight and circle-strafe attack move
per monsterinfo.attack_state, gives the daedalus its own blaster2 muzzle
(monster_fire_blaster2/MZ2_DAEDALUS_BLASTER when mass >= 200) and sounds,
wires up hover_blocked (blocked_checkshot from g_newai.ts), reworks
hover_pain's damage>25 branch into a skill-scaled pain1/pain2 split ("pain
sequence is WAY too long"), changes the pain-skin flag from `= 1` to `|= 1`
("support for skins 2 & 3"), and resets self.s.effects/monsterinfo.
power_armor_type on death. rogue/m_hover.c itself wraps
hover_move_stop1/stop2/hover_move_takeoff/hover_move_land/
hover_move_forward/hover_move_backward (and their frame tables) inside C
block comments -- genuinely dead, uncompiled code in the source, unlike the
base port's "defined but never wired" live-but-unused tables -- so none of
those five tables, nor the frame constants only they used
(FRAME_stop101/109, FRAME_stop201/208, FRAME_takeof01/30, FRAME_land01,
FRAME_backwd01/24), are ported here, matching the source's own inert state.
*/
/*
==============================================================================

hover

==============================================================================
*/
// m_hover.c

import { AngleVectors, random, vec3, VectorCopy, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import { ATTN_NORM, CHAN_VOICE, EF_BLASTER, EF_HYPERBLASTER, MZ2_DAEDALUS_BLASTER, MZ2_HOVER_BLASTER_1 } from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, visible } from "./g_ai";
import {
  AI_STAND_GROUND,
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
  MframeT,
  MmoveT,
  MovetypeT,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
} from "./g_local";
import { BecomeExplosion1, ThrowGib, ThrowHead } from "./g_misc";
import { flymonster_start, monster_fire_blaster, monster_fire_blaster2 } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { SolidT } from "./game";
import { monsterFlashOffset } from "./m_flash";
// ROGUE -- the pack's shared blocked-check AI helper (g_newai.c -- RG-systems' SCOPE)
import { blocked_checkshot } from "./g_newai";
import {
  FRAME_attak101,
  FRAME_attak103,
  FRAME_attak104,
  FRAME_attak106,
  FRAME_attak107,
  FRAME_attak108,
  FRAME_death101,
  FRAME_death111,
  FRAME_forwrd01,
  FRAME_forwrd35,
  FRAME_pain101,
  FRAME_pain128,
  FRAME_pain201,
  FRAME_pain212,
  FRAME_pain301,
  FRAME_pain309,
  FRAME_stand01,
  FRAME_stand30,
  MODEL_SCALE,
} from "./m_hover_frames";

// Per-file local mirroring g_items.ts's own cvarNum (module-local there too,
// so not exported).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

function mframe(
  aifunc: MframeT["aifunc"],
  dist: number,
  thinkfunc: MframeT["thinkfunc"] = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveT["endfunc"] = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_death1 = 0;
let sound_death2 = 0;
let sound_sight = 0;
let sound_search1 = 0;
let sound_search2 = 0;

// ROGUE -- daedalus sounds
let daed_sound_pain1 = 0;
let daed_sound_pain2 = 0;
let daed_sound_death1 = 0;
let daed_sound_death2 = 0;
let daed_sound_sight = 0;
let daed_sound_search1 = 0;
let daed_sound_search2 = 0;
// ROGUE

function hover_sight(self: EdictT, _other: EdictT): void {
  // ROGUE -- daedalus sounds
  if (self.mass < 225) gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, daed_sound_sight, 1, ATTN_NORM, 0);
}

function hover_search(self: EdictT): void {
  // ROGUE -- daedalus sounds
  if (self.mass < 225) {
    if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NORM, 0);
    else gi.sound(self, CHAN_VOICE, sound_search2, 1, ATTN_NORM, 0);
  } else {
    if (random() < 0.5) gi.sound(self, CHAN_VOICE, daed_sound_search1, 1, ATTN_NORM, 0);
    else gi.sound(self, CHAN_VOICE, daed_sound_search2, 1, ATTN_NORM, 0);
  }
}

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order (unlike the C forward decls that
// are only needed to satisfy the compiler's declare-before-use rule).

const hover_frames_stand: MframeT[] = Array.from({ length: 30 }, () => mframe(ai_stand, 0));
const hover_move_stand = mmove(FRAME_stand01, FRAME_stand30, hover_frames_stand, null);

const hover_frames_pain3: MframeT[] = Array.from({ length: 9 }, () => mframe(ai_move, 0));
const hover_move_pain3 = mmove(FRAME_pain301, FRAME_pain309, hover_frames_pain3, hover_run);

const hover_frames_pain2: MframeT[] = Array.from({ length: 12 }, () => mframe(ai_move, 0));
const hover_move_pain2 = mmove(FRAME_pain201, FRAME_pain212, hover_frames_pain2, hover_run);

const hover_frames_pain1: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 2),
  mframe(ai_move, -8),
  mframe(ai_move, -4),
  mframe(ai_move, -6),
  mframe(ai_move, -4),
  mframe(ai_move, -3),
  mframe(ai_move, 1),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 3),
  mframe(ai_move, 1),
  mframe(ai_move, 0),
  mframe(ai_move, 2),
  mframe(ai_move, 3),
  mframe(ai_move, 2),
  mframe(ai_move, 7),
  mframe(ai_move, 1),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 2),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 5),
  mframe(ai_move, 3),
  mframe(ai_move, 4),
];
const hover_move_pain1 = mmove(FRAME_pain101, FRAME_pain128, hover_frames_pain1, hover_run);

const hover_frames_walk: MframeT[] = Array.from({ length: 35 }, () => mframe(ai_walk, 4));
const hover_move_walk = mmove(FRAME_forwrd01, FRAME_forwrd35, hover_frames_walk, null);

const hover_frames_run: MframeT[] = Array.from({ length: 35 }, () => mframe(ai_run, 10));
const hover_move_run = mmove(FRAME_forwrd01, FRAME_forwrd35, hover_frames_run, null);

const hover_frames_death1: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, -10),
  mframe(ai_move, 3),
  mframe(ai_move, 5),
  mframe(ai_move, 4),
  mframe(ai_move, 7),
];
const hover_move_death1 = mmove(FRAME_death101, FRAME_death111, hover_frames_death1, hover_dead);

const hover_frames_start_attack: MframeT[] = Array.from({ length: 3 }, () => mframe(ai_charge, 1));
const hover_move_start_attack = mmove(FRAME_attak101, FRAME_attak103, hover_frames_start_attack, hover_attack);

const hover_frames_attack1: MframeT[] = [
  mframe(ai_charge, -10, hover_fire_blaster),
  mframe(ai_charge, -10, hover_fire_blaster),
  mframe(ai_charge, 0, hover_reattack),
];
const hover_move_attack1 = mmove(FRAME_attak104, FRAME_attak106, hover_frames_attack1, null);

const hover_frames_end_attack: MframeT[] = Array.from({ length: 2 }, () => mframe(ai_charge, 1));
const hover_move_end_attack = mmove(FRAME_attak107, FRAME_attak108, hover_frames_end_attack, hover_run);

// ROGUE -- PMM - circle strafing code
const hover_frames_start_attack2: MframeT[] = Array.from({ length: 3 }, () => mframe(ai_charge, 15));
const hover_move_start_attack2 = mmove(FRAME_attak101, FRAME_attak103, hover_frames_start_attack2, hover_attack);

const hover_frames_attack2: MframeT[] = [
  mframe(ai_charge, 10, hover_fire_blaster),
  mframe(ai_charge, 10, hover_fire_blaster),
  mframe(ai_charge, 10, hover_reattack),
];
const hover_move_attack2 = mmove(FRAME_attak104, FRAME_attak106, hover_frames_attack2, null);

const hover_frames_end_attack2: MframeT[] = Array.from({ length: 2 }, () => mframe(ai_charge, 15));
const hover_move_end_attack2 = mmove(FRAME_attak107, FRAME_attak108, hover_frames_end_attack2, hover_run);
// end of circle strafe
// ROGUE

function hover_reattack(self: EdictT): void {
  if (self.enemy !== null && self.enemy.health > 0 && visible(self, self.enemy) && random() <= 0.6) {
    // ROGUE -- circle-strafe attack state picks the matching reattack move
    if (self.monsterinfo.attack_state === AS_STRAIGHT) {
      self.monsterinfo.currentmove = hover_move_attack1;
      return;
    } else if (self.monsterinfo.attack_state === AS_SLIDING) {
      self.monsterinfo.currentmove = hover_move_attack2;
      return;
    } else {
      gi.dprintf(`hover_reattack: unexpected state ${self.monsterinfo.attack_state}\n`);
    }
    // ROGUE
  }
  self.monsterinfo.currentmove = hover_move_end_attack;
}

function hover_fire_blaster(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const end = vec3();
  const dir = vec3();
  let effect: number;

  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  if (self.s.frame === FRAME_attak104) effect = EF_HYPERBLASTER;
  else effect = 0;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_HOVER_BLASTER_1], forward, right, start);

  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  // PGM - daedalus fires blaster2 (fixme - different muzzle flash)
  if (self.mass < 200) monster_fire_blaster(self, start, dir, 1, 1000, MZ2_HOVER_BLASTER_1, effect);
  else monster_fire_blaster2(self, start, dir, 1, 1000, MZ2_DAEDALUS_BLASTER, EF_BLASTER);
}

function hover_stand(self: EdictT): void {
  self.monsterinfo.currentmove = hover_move_stand;
}

function hover_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = hover_move_stand;
  else self.monsterinfo.currentmove = hover_move_run;
}

function hover_walk(self: EdictT): void {
  self.monsterinfo.currentmove = hover_move_walk;
}

function hover_start_attack(self: EdictT): void {
  self.monsterinfo.currentmove = hover_move_start_attack;
}

// ROGUE -- circle-strafe chance replaces the base's unconditional attack1.
// rogue/m_hover.c applies this to BOTH monster_hover and monster_daedalus
// (they share this one hover_attack function) -- but that would change
// classic monster_hover's combat feel (always attack1 in vanilla 3.21) for
// every classic map, since monster_hover is one of baseq2's own classnames.
// RESTRICTED to monster_daedalus here; classic monster_hover keeps the
// original unconditional hover_move_attack1 below. See this file's porting
// report for the full rationale (same restriction pattern as g_ai.ts's
// ROGUE_MONSTER_CLASSNAMES gate).
function hover_attack(self: EdictT): void {
  if (self.classname !== "monster_daedalus") {
    self.monsterinfo.currentmove = hover_move_attack1;
    return;
  }

  let chance: number;
  // 0% chance of circle in easy
  // 50% chance in normal
  // 75% chance in hard
  // 86.67% chance in nightmare
  const skill = cvarNum(gameCvars.skill);
  if (skill === 0) chance = 0;
  else chance = 1.0 - 0.5 / skill;

  if (self.mass > 150) chance += 0.1; // the daedalus strafes more

  if (random() > chance) {
    self.monsterinfo.currentmove = hover_move_attack1;
    self.monsterinfo.attack_state = AS_STRAIGHT;
  } else {
    // circle strafe
    if (random() <= 0.5) self.monsterinfo.lefty = 1 - self.monsterinfo.lefty; // switch directions
    self.monsterinfo.currentmove = hover_move_attack2;
    self.monsterinfo.attack_state = AS_SLIDING;
  }
}
// ROGUE

function hover_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  // ROGUE: PGM support for skins 2 & 3 (was `= 1`)
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (damage <= 25) {
    if (random() < 0.5) {
      // ROGUE -- daedalus sounds
      if (self.mass < 225) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
      else gi.sound(self, CHAN_VOICE, daed_sound_pain1, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = hover_move_pain3;
    } else {
      // ROGUE -- daedalus sounds
      if (self.mass < 225) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
      else gi.sound(self, CHAN_VOICE, daed_sound_pain2, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = hover_move_pain2;
    }
  } else if (self.classname === "monster_daedalus") {
    // ROGUE -- PGM pain sequence is WAY too long: skill-scaled split
    // between pain1 and pain2 instead of always pain1. RESTRICTED to
    // monster_daedalus: rogue/m_hover.c applies this to monster_hover too,
    // but that changes classic hover's high-damage pain animation (always
    // pain1 in vanilla 3.21) for every classic map. See hover_attack's
    // porting note above for the same restriction pattern.
    if (random() < 0.45 - 0.1 * cvarNum(gameCvars.skill)) {
      gi.sound(self, CHAN_VOICE, daed_sound_pain1, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = hover_move_pain1;
    } else {
      gi.sound(self, CHAN_VOICE, daed_sound_pain2, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = hover_move_pain2;
    }
    // ROGUE
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = hover_move_pain1;
  }
}

function hover_deadthink(self: EdictT): void {
  if (!self.groundentity && level.time < self.timestamp) {
    self.nextthink = level.time + FRAMETIME;
    return;
  }
  BecomeExplosion1(self);
}

function hover_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.think = hover_deadthink;
  self.nextthink = level.time + FRAMETIME;
  self.timestamp = level.time + 15;
  gi.linkentity(self);
}

function hover_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // ROGUE
  self.s.effects = 0;
  self.monsterinfo.power_armor_type = POWER_ARMOR_NONE;
  // ROGUE

  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  // ROGUE -- daedalus sounds
  if (self.mass < 225) {
    if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_death1, 1, ATTN_NORM, 0);
    else gi.sound(self, CHAN_VOICE, sound_death2, 1, ATTN_NORM, 0);
  } else {
    if (random() < 0.5) gi.sound(self, CHAN_VOICE, daed_sound_death1, 1, ATTN_NORM, 0);
    else gi.sound(self, CHAN_VOICE, daed_sound_death2, 1, ATTN_NORM, 0);
  }
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.currentmove = hover_move_death1;
}

// ROGUE
//===========
//PGM
function hover_blocked(self: EdictT, _dist: number): boolean {
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  return false;
}
//PGM
//===========
// ROGUE

/*QUAKED monster_hover (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
/*QUAKED monster_daedalus (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
This is the improved icarus monster.
*/
export function SP_monster_hover(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/hover/tris.md2");
  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 32);

  self.health = 240;
  self.gib_health = -100;
  self.mass = 150;

  self.pain = hover_pain;
  self.die = hover_die;

  self.monsterinfo.stand = hover_stand;
  self.monsterinfo.walk = hover_walk;
  self.monsterinfo.run = hover_run;
  self.monsterinfo.attack = hover_start_attack;
  self.monsterinfo.sight = hover_sight;
  self.monsterinfo.search = hover_search;

  // ROGUE -- PGM: monster_daedalus is the same spawn function, distinguished
  // by classname; it overrides health/mass/yaw_speed/power armor and uses
  // its own sound set.
  if (self.classname === "monster_daedalus") {
    // monsterinfo.blocked wasn't set at all for classic monster_hover before
    // this port (rogue/m_hover.c sets it unconditionally for both
    // classnames); leaving it null for monster_hover keeps m_move.ts's new
    // SV_NewChaseDir blocked-fallback inert for that classic classname,
    // matching vanilla 3.21. See hover_attack's porting note above for the
    // same restriction pattern.
    self.monsterinfo.blocked = hover_blocked; // PGM
    self.health = 450;
    self.mass = 225;
    self.yaw_speed = 25;
    self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
    self.monsterinfo.power_armor_power = 100;
    // PMM - daedalus sounds
    self.s.sound = gi.soundindex("daedalus/daedidle1.wav");
    daed_sound_pain1 = gi.soundindex("daedalus/daedpain1.wav");
    daed_sound_pain2 = gi.soundindex("daedalus/daedpain2.wav");
    daed_sound_death1 = gi.soundindex("daedalus/daeddeth1.wav");
    daed_sound_death2 = gi.soundindex("daedalus/daeddeth2.wav");
    daed_sound_sight = gi.soundindex("daedalus/daedsght1.wav");
    daed_sound_search1 = gi.soundindex("daedalus/daedsrch1.wav");
    daed_sound_search2 = gi.soundindex("daedalus/daedsrch2.wav");
    gi.soundindex("tank/tnkatck3.wav");
  } else {
    sound_pain1 = gi.soundindex("hover/hovpain1.wav");
    sound_pain2 = gi.soundindex("hover/hovpain2.wav");
    sound_death1 = gi.soundindex("hover/hovdeth1.wav");
    sound_death2 = gi.soundindex("hover/hovdeth2.wav");
    sound_sight = gi.soundindex("hover/hovsght1.wav");
    sound_search1 = gi.soundindex("hover/hovsrch1.wav");
    sound_search2 = gi.soundindex("hover/hovsrch2.wav");
    gi.soundindex("hover/hovatck1.wav");

    self.s.sound = gi.soundindex("hover/hovidle1.wav");
  }
  // ROGUE

  gi.linkentity(self);

  self.monsterinfo.currentmove = hover_move_stand;
  self.monsterinfo.scale = MODEL_SCALE;

  flymonster_start(self);

  // ROGUE
  if (self.classname === "monster_daedalus") self.s.skinnum = 2;
  // ROGUE
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_hover:hover_deadthink", hover_deadthink);
registerSaveFunction("m_hover:hover_pain", hover_pain);
registerSaveFunction("m_hover:hover_die", hover_die);
registerSaveFunction("m_hover:hover_stand", hover_stand);
registerSaveFunction("m_hover:hover_walk", hover_walk);
registerSaveFunction("m_hover:hover_run", hover_run);
registerSaveFunction("m_hover:hover_start_attack", hover_start_attack);
registerSaveFunction("m_hover:hover_sight", hover_sight);
registerSaveFunction("m_hover:hover_search", hover_search);
registerSaveFunction("m_hover:hover_blocked", hover_blocked);
registerSaveMmove("m_hover:hover_move_stand", hover_move_stand);
registerSaveMmove("m_hover:hover_move_pain3", hover_move_pain3);
registerSaveMmove("m_hover:hover_move_pain2", hover_move_pain2);
registerSaveMmove("m_hover:hover_move_pain1", hover_move_pain1);
registerSaveMmove("m_hover:hover_move_walk", hover_move_walk);
registerSaveMmove("m_hover:hover_move_run", hover_move_run);
registerSaveMmove("m_hover:hover_move_death1", hover_move_death1);
registerSaveMmove("m_hover:hover_move_start_attack", hover_move_start_attack);
registerSaveMmove("m_hover:hover_move_attack1", hover_move_attack1);
registerSaveMmove("m_hover:hover_move_end_attack", hover_move_end_attack);
registerSaveMmove("m_hover:hover_move_start_attack2", hover_move_start_attack2);
registerSaveMmove("m_hover:hover_move_attack2", hover_move_attack2);
registerSaveMmove("m_hover:hover_move_end_attack2", hover_move_end_attack2);
