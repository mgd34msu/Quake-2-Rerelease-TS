/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_insane.c (GNU GPL v2 or later).
*/
/*
==============================================================================

insane

==============================================================================
*/
// m_insane.c
//
// rogue/m_insane.c vs baseq2/m_insane.c: banner swap only, no other delta --
// copied from src/game/m_insane.ts with sibling imports repointed at the
// flat src/rogue/ layout.

import { type Vec3, VectorSet } from "../shared/math";
import { ATTN_IDLE, CHAN_VOICE, va } from "../shared/q_shared";
import { ai_move, ai_stand, ai_walk } from "./g_ai";
import {
  AI_GOOD_GUY,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_FLY,
  FL_NO_KNOCKBACK,
  GIB_ORGANIC,
  gameCvars,
  gi,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
} from "./g_local";
import { ThrowGib, ThrowHead } from "./g_misc";
import { flymonster_start, walkmonster_start } from "./g_monster";
import { G_FreeEdict } from "./g_utils";
import { SolidT, SVF_DEADMONSTER } from "./game";
import {
  FRAME_cr_death10,
  FRAME_cr_death16,
  FRAME_cr_pain10,
  FRAME_cr_pain2,
  FRAME_crawl1,
  FRAME_crawl9,
  FRAME_cross1,
  FRAME_cross15,
  FRAME_cross16,
  FRAME_cross30,
  FRAME_st_death18,
  FRAME_st_death2,
  FRAME_st_pain12,
  FRAME_st_pain2,
  FRAME_stand1,
  FRAME_stand100,
  FRAME_stand160,
  FRAME_stand40,
  FRAME_stand41,
  FRAME_stand59,
  FRAME_stand60,
  FRAME_stand65,
  FRAME_stand94,
  FRAME_stand96,
  FRAME_stand99,
  FRAME_walk1,
  FRAME_walk26,
  FRAME_walk27,
  FRAME_walk39,
  MODEL_SCALE,
} from "./m_insane_frames";

// Per-file local mirroring g_items.ts's own cvarNum (module-local there too,
// so not exported).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// Local struct-literal sugar standing in for C's `{aifunc, dist, thinkfunc}`
// mframe_t initializers.
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

let sound_fist = 0;
let sound_shake = 0;
let sound_moan = 0;
const sound_scream: number[] = new Array(8).fill(0);

function insane_fist(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_fist, 1, ATTN_IDLE, 0);
}

function insane_shake(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_shake, 1, ATTN_IDLE, 0);
}

function insane_moan(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_moan, 1, ATTN_IDLE, 0);
}

function insane_scream(self: EdictT): void {
  // C: `sound_scream[rand()%8]` -- house idiom for raw rand() % N.
  const idx = Math.floor(Math.random() * 8);
  gi.sound(self, CHAN_VOICE, sound_scream[idx], 1, ATTN_IDLE, 0);
}

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order.

const insane_frames_stand_normal: MframeT[] = [
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, insane_checkdown),
];
const insane_move_stand_normal = mmove(FRAME_stand60, FRAME_stand65, insane_frames_stand_normal, insane_stand);

const insane_frames_stand_insane: MframeT[] = [
  mframe(ai_stand, 0, insane_shake),
  ...Array.from({ length: 28 }, () => mframe(ai_stand, 0)),
  mframe(ai_stand, 0, insane_checkdown),
];
const insane_move_stand_insane = mmove(FRAME_stand65, FRAME_stand94, insane_frames_stand_insane, insane_stand);

const insane_frames_uptodown: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, insane_moan),
  mframe(ai_move, 0),
  mframe(ai_move, 0),

  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),

  mframe(ai_move, 2.7),
  mframe(ai_move, 4.1),
  mframe(ai_move, 6),
  mframe(ai_move, 7.6),
  mframe(ai_move, 3.6),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, insane_fist),
  mframe(ai_move, 0),
  mframe(ai_move, 0),

  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, insane_fist),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
];
const insane_move_uptodown = mmove(FRAME_stand1, FRAME_stand40, insane_frames_uptodown, insane_onground);

const insane_frames_downtoup: MframeT[] = [
  mframe(ai_move, -0.7), // 41
  mframe(ai_move, -1.2), // 42
  mframe(ai_move, -1.5), // 43
  mframe(ai_move, -4.5), // 44
  mframe(ai_move, -3.5), // 45
  mframe(ai_move, -0.2), // 46
  mframe(ai_move, 0), // 47
  mframe(ai_move, -1.3), // 48
  mframe(ai_move, -3), // 49
  mframe(ai_move, -2), // 50
  mframe(ai_move, 0), // 51
  mframe(ai_move, 0), // 52
  mframe(ai_move, 0), // 53
  mframe(ai_move, -3.3), // 54
  mframe(ai_move, -1.6), // 55
  mframe(ai_move, -0.3), // 56
  mframe(ai_move, 0), // 57
  mframe(ai_move, 0), // 58
  mframe(ai_move, 0), // 59
];
const insane_move_downtoup = mmove(FRAME_stand41, FRAME_stand59, insane_frames_downtoup, insane_stand);

const insane_frames_jumpdown: MframeT[] = [
  mframe(ai_move, 0.2),
  mframe(ai_move, 11.5),
  mframe(ai_move, 5.1),
  mframe(ai_move, 7.1),
  mframe(ai_move, 0),
];
const insane_move_jumpdown = mmove(FRAME_stand96, FRAME_stand100, insane_frames_jumpdown, insane_onground);

const insane_frames_down: MframeT[] = [
  mframe(ai_move, 0), // 100
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0), // 110
  mframe(ai_move, -1.7),
  mframe(ai_move, -1.6),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, insane_fist),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0), // 120
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0), // 130
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, insane_moan),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0), // 140
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0), // 150
  mframe(ai_move, 0.5),
  mframe(ai_move, 0),
  mframe(ai_move, -0.2, insane_scream),
  mframe(ai_move, 0),
  mframe(ai_move, 0.2),
  mframe(ai_move, 0.4),
  mframe(ai_move, 0.6),
  mframe(ai_move, 0.8),
  mframe(ai_move, 0.7),
  mframe(ai_move, 0, insane_checkup), // 160
];
const insane_move_down = mmove(FRAME_stand100, FRAME_stand160, insane_frames_down, insane_onground);

const insane_frames_walk_normal: MframeT[] = [
  mframe(ai_walk, 0, insane_scream),
  mframe(ai_walk, 2.5),
  mframe(ai_walk, 3.5),
  mframe(ai_walk, 1.7),
  mframe(ai_walk, 2.3),
  mframe(ai_walk, 2.4),
  mframe(ai_walk, 2.2),
  mframe(ai_walk, 4.2),
  mframe(ai_walk, 5.6),
  mframe(ai_walk, 3.3),
  mframe(ai_walk, 2.4),
  mframe(ai_walk, 0.9),
  mframe(ai_walk, 0),
];
const insane_move_walk_normal = mmove(FRAME_walk27, FRAME_walk39, insane_frames_walk_normal, insane_walk);
const insane_move_run_normal = mmove(FRAME_walk27, FRAME_walk39, insane_frames_walk_normal, insane_run);

const insane_frames_walk_insane: MframeT[] = [
  mframe(ai_walk, 0, insane_scream), // walk 1
  mframe(ai_walk, 3.4), // walk 2
  mframe(ai_walk, 3.6), // 3
  mframe(ai_walk, 2.9), // 4
  mframe(ai_walk, 2.2), // 5
  mframe(ai_walk, 2.6), // 6
  mframe(ai_walk, 0), // 7
  mframe(ai_walk, 0.7), // 8
  mframe(ai_walk, 4.8), // 9
  mframe(ai_walk, 5.3), // 10
  mframe(ai_walk, 1.1), // 11
  mframe(ai_walk, 2), // 12
  mframe(ai_walk, 0.5), // 13
  mframe(ai_walk, 0), // 14
  mframe(ai_walk, 0), // 15
  mframe(ai_walk, 4.9), // 16
  mframe(ai_walk, 6.7), // 17
  mframe(ai_walk, 3.8), // 18
  mframe(ai_walk, 2), // 19
  mframe(ai_walk, 0.2), // 20
  mframe(ai_walk, 0), // 21
  mframe(ai_walk, 3.4), // 22
  mframe(ai_walk, 6.4), // 23
  mframe(ai_walk, 5), // 24
  mframe(ai_walk, 1.8), // 25
  mframe(ai_walk, 0), // 26
];
const insane_move_walk_insane = mmove(FRAME_walk1, FRAME_walk26, insane_frames_walk_insane, insane_walk);
const insane_move_run_insane = mmove(FRAME_walk1, FRAME_walk26, insane_frames_walk_insane, insane_run);

const insane_frames_stand_pain: MframeT[] = Array.from({ length: 11 }, () => mframe(ai_move, 0));
const insane_move_stand_pain = mmove(FRAME_st_pain2, FRAME_st_pain12, insane_frames_stand_pain, insane_run);

const insane_frames_stand_death: MframeT[] = Array.from({ length: 17 }, () => mframe(ai_move, 0));
const insane_move_stand_death = mmove(FRAME_st_death2, FRAME_st_death18, insane_frames_stand_death, insane_dead);

const insane_frames_crawl: MframeT[] = [
  mframe(ai_walk, 0, insane_scream),
  mframe(ai_walk, 1.5),
  mframe(ai_walk, 2.1),
  mframe(ai_walk, 3.6),
  mframe(ai_walk, 2),
  mframe(ai_walk, 0.9),
  mframe(ai_walk, 3),
  mframe(ai_walk, 3.4),
  mframe(ai_walk, 2.4),
];
const insane_move_crawl = mmove(FRAME_crawl1, FRAME_crawl9, insane_frames_crawl, null);
const insane_move_runcrawl = mmove(FRAME_crawl1, FRAME_crawl9, insane_frames_crawl, null);

const insane_frames_crawl_pain: MframeT[] = Array.from({ length: 9 }, () => mframe(ai_move, 0));
const insane_move_crawl_pain = mmove(FRAME_cr_pain2, FRAME_cr_pain10, insane_frames_crawl_pain, insane_run);

const insane_frames_crawl_death: MframeT[] = Array.from({ length: 7 }, () => mframe(ai_move, 0));
const insane_move_crawl_death = mmove(FRAME_cr_death10, FRAME_cr_death16, insane_frames_crawl_death, insane_dead);

const insane_frames_cross: MframeT[] = [
  mframe(ai_move, 0, insane_moan),
  ...Array.from({ length: 14 }, () => mframe(ai_move, 0)),
];
const insane_move_cross = mmove(FRAME_cross1, FRAME_cross15, insane_frames_cross, insane_cross);

const insane_frames_struggle_cross: MframeT[] = [
  mframe(ai_move, 0, insane_scream),
  ...Array.from({ length: 14 }, () => mframe(ai_move, 0)),
];
const insane_move_struggle_cross = mmove(FRAME_cross16, FRAME_cross30, insane_frames_struggle_cross, insane_cross);

function insane_cross(self: EdictT): void {
  if (Math.random() < 0.8) self.monsterinfo.currentmove = insane_move_cross;
  else self.monsterinfo.currentmove = insane_move_struggle_cross;
}

function insane_walk(self: EdictT): void {
  if (self.spawnflags & 16)
    // Hold Ground?
    if (self.s.frame === FRAME_cr_pain10) {
      self.monsterinfo.currentmove = insane_move_down;
      return;
    }
  if (self.spawnflags & 4) self.monsterinfo.currentmove = insane_move_crawl;
  else if (Math.random() <= 0.5) self.monsterinfo.currentmove = insane_move_walk_normal;
  else self.monsterinfo.currentmove = insane_move_walk_insane;
}

function insane_run(self: EdictT): void {
  if (self.spawnflags & 16)
    // Hold Ground?
    if (self.s.frame === FRAME_cr_pain10) {
      self.monsterinfo.currentmove = insane_move_down;
      return;
    }
  if (self.spawnflags & 4)
    // Crawling?
    self.monsterinfo.currentmove = insane_move_runcrawl;
  else if (Math.random() <= 0.5)
    // Else, mix it up
    self.monsterinfo.currentmove = insane_move_run_normal;
  else self.monsterinfo.currentmove = insane_move_run_insane;
}

function insane_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  // C: `r = 1 + (rand()&1);` -- a uniform 1-or-2 draw.
  const r = 1 + Math.floor(Math.random() * 2);
  let l: number;
  if (self.health < 25) l = 25;
  else if (self.health < 50) l = 50;
  else if (self.health < 75) l = 75;
  else l = 100;
  gi.sound(self, CHAN_VOICE, gi.soundindex(va("player/male/pain%i_%i.wav", l, r)), 1, ATTN_IDLE, 0);

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // Don't go into pain frames if crucified.
  if (self.spawnflags & 8) {
    self.monsterinfo.currentmove = insane_move_struggle_cross;
    return;
  }

  if (
    (self.s.frame >= FRAME_crawl1 && self.s.frame <= FRAME_crawl9) ||
    (self.s.frame >= FRAME_stand99 && self.s.frame <= FRAME_stand160)
  ) {
    self.monsterinfo.currentmove = insane_move_crawl_pain;
  } else self.monsterinfo.currentmove = insane_move_stand_pain;
}

function insane_onground(self: EdictT): void {
  self.monsterinfo.currentmove = insane_move_down;
}

function insane_checkdown(self: EdictT): void {
  if (self.spawnflags & 32) return; // Always stand
  if (Math.random() < 0.3)
    if (Math.random() < 0.5) self.monsterinfo.currentmove = insane_move_uptodown;
    else self.monsterinfo.currentmove = insane_move_jumpdown;
}

function insane_checkup(self: EdictT): void {
  // If Hold_Ground and Crawl are set
  if (self.spawnflags & 4 && self.spawnflags & 16) return;
  if (Math.random() < 0.5) self.monsterinfo.currentmove = insane_move_downtoup;
}

function insane_stand(self: EdictT): void {
  if (self.spawnflags & 8) {
    // If crucified
    self.monsterinfo.currentmove = insane_move_cross;
    self.monsterinfo.aiflags |= AI_STAND_GROUND;
  } else if (self.spawnflags & 4 && self.spawnflags & 16) {
    // If Hold_Ground and Crawl are set
    self.monsterinfo.currentmove = insane_move_down;
  } else if (Math.random() < 0.5) self.monsterinfo.currentmove = insane_move_stand_normal;
  else self.monsterinfo.currentmove = insane_move_stand_insane;
}

function insane_dead(self: EdictT): void {
  if (self.spawnflags & 8) {
    self.flags |= FL_FLY;
  } else {
    VectorSet(self.mins, -16, -16, -24);
    VectorSet(self.maxs, 16, 16, -8);
    self.movetype = MovetypeT.MOVETYPE_TOSS;
  }
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function insane_die(
  self: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  damage: number,
  _point: Vec3,
): void {
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_IDLE, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // C: `(rand()%4)+1` -- house idiom for raw rand() % N.
  gi.sound(
    self,
    CHAN_VOICE,
    gi.soundindex(va("player/male/death%i.wav", Math.floor(Math.random() * 4) + 1)),
    1,
    ATTN_IDLE,
    0,
  );

  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  if (self.spawnflags & 8) {
    insane_dead(self);
  } else {
    if (
      (self.s.frame >= FRAME_crawl1 && self.s.frame <= FRAME_crawl9) ||
      (self.s.frame >= FRAME_stand99 && self.s.frame <= FRAME_stand160)
    )
      self.monsterinfo.currentmove = insane_move_crawl_death;
    else self.monsterinfo.currentmove = insane_move_stand_death;
  }
}

/*QUAKED misc_insane (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn CRAWL CRUCIFIED STAND_GROUND ALWAYS_STAND
*/
export function SP_misc_insane(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_fist = gi.soundindex("insane/insane11.wav");
  sound_shake = gi.soundindex("insane/insane5.wav");
  sound_moan = gi.soundindex("insane/insane7.wav");
  sound_scream[0] = gi.soundindex("insane/insane1.wav");
  sound_scream[1] = gi.soundindex("insane/insane2.wav");
  sound_scream[2] = gi.soundindex("insane/insane3.wav");
  sound_scream[3] = gi.soundindex("insane/insane4.wav");
  sound_scream[4] = gi.soundindex("insane/insane6.wav");
  sound_scream[5] = gi.soundindex("insane/insane8.wav");
  sound_scream[6] = gi.soundindex("insane/insane9.wav");
  sound_scream[7] = gi.soundindex("insane/insane10.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/insane/tris.md2");

  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 100;
  self.gib_health = -50;
  self.mass = 300;

  self.pain = insane_pain;
  self.die = insane_die;

  self.monsterinfo.stand = insane_stand;
  self.monsterinfo.walk = insane_walk;
  self.monsterinfo.run = insane_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = null;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;
  self.monsterinfo.aiflags |= AI_GOOD_GUY;

  gi.linkentity(self);

  if (self.spawnflags & 16)
    // Stand Ground
    self.monsterinfo.aiflags |= AI_STAND_GROUND;

  self.monsterinfo.currentmove = insane_move_stand_normal;

  self.monsterinfo.scale = MODEL_SCALE;

  if (self.spawnflags & 8) {
    // Crucified ?
    VectorSet(self.mins, -16, 0, 0);
    VectorSet(self.maxs, 16, 8, 32);
    self.flags |= FL_NO_KNOCKBACK;
    flymonster_start(self);
  } else {
    walkmonster_start(self);
    // C: `rand()%3` -- house idiom for raw rand() % N.
    self.s.skinnum = Math.floor(Math.random() * 3);
  }
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_insane:insane_pain", insane_pain);
registerSaveFunction("m_insane:insane_die", insane_die);
registerSaveFunction("m_insane:insane_stand", insane_stand);
registerSaveFunction("m_insane:insane_walk", insane_walk);
registerSaveFunction("m_insane:insane_run", insane_run);
registerSaveMmove("m_insane:insane_move_stand_normal", insane_move_stand_normal);
registerSaveMmove("m_insane:insane_move_stand_insane", insane_move_stand_insane);
registerSaveMmove("m_insane:insane_move_uptodown", insane_move_uptodown);
registerSaveMmove("m_insane:insane_move_downtoup", insane_move_downtoup);
registerSaveMmove("m_insane:insane_move_jumpdown", insane_move_jumpdown);
registerSaveMmove("m_insane:insane_move_down", insane_move_down);
registerSaveMmove("m_insane:insane_move_walk_normal", insane_move_walk_normal);
registerSaveMmove("m_insane:insane_move_run_normal", insane_move_run_normal);
registerSaveMmove("m_insane:insane_move_walk_insane", insane_move_walk_insane);
registerSaveMmove("m_insane:insane_move_run_insane", insane_move_run_insane);
registerSaveMmove("m_insane:insane_move_stand_pain", insane_move_stand_pain);
registerSaveMmove("m_insane:insane_move_stand_death", insane_move_stand_death);
registerSaveMmove("m_insane:insane_move_crawl", insane_move_crawl);
registerSaveMmove("m_insane:insane_move_runcrawl", insane_move_runcrawl);
registerSaveMmove("m_insane:insane_move_crawl_pain", insane_move_crawl_pain);
registerSaveMmove("m_insane:insane_move_crawl_death", insane_move_crawl_death);
registerSaveMmove("m_insane:insane_move_cross", insane_move_cross);
registerSaveMmove("m_insane:insane_move_struggle_cross", insane_move_struggle_cross);
