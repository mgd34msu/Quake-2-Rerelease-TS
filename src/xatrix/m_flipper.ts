/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_flipper.c (GNU GPL v2 or later).
*/
/*
==============================================================================

FLIPPER

==============================================================================
*/
// m_flipper.c

import { vec3, type Vec3, VectorSet } from "../shared/math";
import { ATTN_NORM, CHAN_VOICE, CHAN_WEAPON } from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk } from "./g_ai";
import {
  DamageT,
  DEAD_DEAD,
  type EdictT,
  GIB_ORGANIC,
  gameCvars,
  gi,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
} from "./g_local";
import { ThrowGib, ThrowHead } from "./g_misc";
import { swimmonster_start } from "./g_monster";
import { G_FreeEdict } from "./g_utils";
import { fire_hit } from "./g_weapon";
import { SolidT, SVF_DEADMONSTER } from "./game";
import {
  FRAME_flpbit01,
  FRAME_flpbit20,
  FRAME_flpdth01,
  FRAME_flpdth56,
  FRAME_flphor01,
  FRAME_flphor05,
  FRAME_flphor24,
  FRAME_flppn101,
  FRAME_flppn105,
  FRAME_flppn201,
  FRAME_flppn205,
  FRAME_flpver01,
  FRAME_flpver06,
  FRAME_flpver29,
  MODEL_SCALE,
} from "./m_flipper_frames";

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

let sound_chomp = 0;
let sound_attack = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_death = 0;
let sound_idle = 0;
let sound_search = 0;
let sound_sight = 0;

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order (unlike the C forward decls that
// are only needed to satisfy the compiler's declare-before-use rule).

const flipper_frames_stand: MframeT[] = [mframe(ai_stand, 0)];
const flipper_move_stand = mmove(FRAME_flphor01, FRAME_flphor01, flipper_frames_stand, null);

function flipper_stand(self: EdictT): void {
  self.monsterinfo.currentmove = flipper_move_stand;
}

const FLIPPER_RUN_SPEED = 24;

const flipper_frames_run: MframeT[] = Array.from({ length: 24 }, () => mframe(ai_run, FLIPPER_RUN_SPEED));
const flipper_move_run_loop = mmove(FRAME_flpver06, FRAME_flpver29, flipper_frames_run, null);

function flipper_run_loop(self: EdictT): void {
  self.monsterinfo.currentmove = flipper_move_run_loop;
}

const flipper_frames_run_start: MframeT[] = Array.from({ length: 6 }, () => mframe(ai_run, 8));
const flipper_move_run_start = mmove(FRAME_flpver01, FRAME_flpver06, flipper_frames_run_start, flipper_run_loop);

function flipper_run(self: EdictT): void {
  self.monsterinfo.currentmove = flipper_move_run_start;
}

/* Standard Swimming */
const flipper_frames_walk: MframeT[] = Array.from({ length: 24 }, () => mframe(ai_walk, 4));
const flipper_move_walk = mmove(FRAME_flphor01, FRAME_flphor24, flipper_frames_walk, null);

function flipper_walk(self: EdictT): void {
  self.monsterinfo.currentmove = flipper_move_walk;
}

const flipper_frames_start_run: MframeT[] = [
  mframe(ai_run, 8),
  mframe(ai_run, 8),
  mframe(ai_run, 8),
  mframe(ai_run, 8),
  mframe(ai_run, 8, flipper_run),
];
const flipper_move_start_run = mmove(FRAME_flphor01, FRAME_flphor05, flipper_frames_start_run, null);

function flipper_start_run(self: EdictT): void {
  self.monsterinfo.currentmove = flipper_move_start_run;
}

const flipper_frames_pain2: MframeT[] = Array.from({ length: 5 }, () => mframe(ai_move, 0));
const flipper_move_pain2 = mmove(FRAME_flppn101, FRAME_flppn105, flipper_frames_pain2, flipper_run);

const flipper_frames_pain1: MframeT[] = Array.from({ length: 5 }, () => mframe(ai_move, 0));
const flipper_move_pain1 = mmove(FRAME_flppn201, FRAME_flppn205, flipper_frames_pain1, flipper_run);

function flipper_bite(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  fire_hit(self, aim, 5, 0);
}

function flipper_preattack(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_chomp, 1, ATTN_NORM, 0);
}

const flipper_frames_attack: MframeT[] = [
  mframe(ai_charge, 0, flipper_preattack),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0, flipper_bite),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0, flipper_bite),
  mframe(ai_charge, 0),
];
const flipper_move_attack = mmove(FRAME_flpbit01, FRAME_flpbit20, flipper_frames_attack, flipper_run);

function flipper_melee(self: EdictT): void {
  self.monsterinfo.currentmove = flipper_move_attack;
}

function flipper_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // C: `n = (rand() + 1) % 2;` -- a uniform coin flip; ported via the house
  // `Math.floor(Math.random() * N)` idiom for raw rand() (see PORTING.md).
  const n = Math.floor(Math.random() * 2);
  if (n === 0) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = flipper_move_pain1;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = flipper_move_pain2;
  }
}

function flipper_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const flipper_frames_death: MframeT[] = Array.from({ length: 56 }, () => mframe(ai_move, 0));
const flipper_move_death = mmove(FRAME_flpdth01, FRAME_flpdth56, flipper_frames_death, flipper_dead);

function flipper_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function flipper_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
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
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.currentmove = flipper_move_death;
}

/*QUAKED monster_flipper (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_flipper(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("flipper/flppain1.wav");
  sound_pain2 = gi.soundindex("flipper/flppain2.wav");
  sound_death = gi.soundindex("flipper/flpdeth1.wav");
  sound_chomp = gi.soundindex("flipper/flpatck1.wav");
  sound_attack = gi.soundindex("flipper/flpatck2.wav");
  sound_idle = gi.soundindex("flipper/flpidle1.wav");
  sound_search = gi.soundindex("flipper/flpsrch1.wav");
  sound_sight = gi.soundindex("flipper/flpsght1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/flipper/tris.md2");
  VectorSet(self.mins, -16, -16, 0);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 50;
  self.gib_health = -30;
  self.mass = 100;

  self.pain = flipper_pain;
  self.die = flipper_die;

  self.monsterinfo.stand = flipper_stand;
  self.monsterinfo.walk = flipper_walk;
  self.monsterinfo.run = flipper_start_run;
  self.monsterinfo.melee = flipper_melee;
  self.monsterinfo.sight = flipper_sight;

  gi.linkentity(self);

  self.monsterinfo.currentmove = flipper_move_stand;
  self.monsterinfo.scale = MODEL_SCALE;

  swimmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_flipper:flipper_pain", flipper_pain);
registerSaveFunction("m_flipper:flipper_die", flipper_die);
registerSaveFunction("m_flipper:flipper_stand", flipper_stand);
registerSaveFunction("m_flipper:flipper_walk", flipper_walk);
registerSaveFunction("m_flipper:flipper_start_run", flipper_start_run);
registerSaveFunction("m_flipper:flipper_melee", flipper_melee);
registerSaveFunction("m_flipper:flipper_sight", flipper_sight);
registerSaveMmove("m_flipper:flipper_move_stand", flipper_move_stand);
registerSaveMmove("m_flipper:flipper_move_run_loop", flipper_move_run_loop);
registerSaveMmove("m_flipper:flipper_move_run_start", flipper_move_run_start);
registerSaveMmove("m_flipper:flipper_move_walk", flipper_move_walk);
registerSaveMmove("m_flipper:flipper_move_start_run", flipper_move_start_run);
registerSaveMmove("m_flipper:flipper_move_pain2", flipper_move_pain2);
registerSaveMmove("m_flipper:flipper_move_pain1", flipper_move_pain1);
registerSaveMmove("m_flipper:flipper_move_attack", flipper_move_attack);
registerSaveMmove("m_flipper:flipper_move_death", flipper_move_death);
