/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_hover.c (GNU GPL v2 or later).
*/
/*
==============================================================================

hover

==============================================================================
*/
// m_hover.c

import { AngleVectors, random, vec3, VectorCopy, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import { ATTN_NORM, CHAN_VOICE, EF_HYPERBLASTER, MZ2_HOVER_BLASTER_1 } from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, visible } from "./g_ai";
import {
  AI_STAND_GROUND,
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
} from "./g_local";
import { BecomeExplosion1, ThrowGib, ThrowHead } from "./g_misc";
import { flymonster_start, monster_fire_blaster } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { SolidT } from "./game";
import { monsterFlashOffset } from "./m_flash";
import {
  FRAME_attak101,
  FRAME_attak103,
  FRAME_attak104,
  FRAME_attak106,
  FRAME_attak107,
  FRAME_attak108,
  FRAME_backwd01,
  FRAME_backwd24,
  FRAME_death101,
  FRAME_death111,
  FRAME_forwrd01,
  FRAME_forwrd35,
  FRAME_land01,
  FRAME_pain101,
  FRAME_pain128,
  FRAME_pain201,
  FRAME_pain212,
  FRAME_pain301,
  FRAME_pain309,
  FRAME_stand01,
  FRAME_stand30,
  FRAME_stop101,
  FRAME_stop109,
  FRAME_stop201,
  FRAME_stop208,
  FRAME_takeof01,
  FRAME_takeof30,
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

function hover_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function hover_search(self: EdictT): void {
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_search2, 1, ATTN_NORM, 0);
}

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order (unlike the C forward decls that
// are only needed to satisfy the compiler's declare-before-use rule).

const hover_frames_stand: MframeT[] = Array.from({ length: 30 }, () => mframe(ai_stand, 0));
const hover_move_stand = mmove(FRAME_stand01, FRAME_stand30, hover_frames_stand, null);

// Defined but never wired to a monsterinfo hook in the original C either --
// dead code kept for fidelity.
const hover_frames_stop1: MframeT[] = Array.from({ length: 9 }, () => mframe(ai_move, 0));
const hover_move_stop1 = mmove(FRAME_stop101, FRAME_stop109, hover_frames_stop1, null);

const hover_frames_stop2: MframeT[] = Array.from({ length: 8 }, () => mframe(ai_move, 0));
const hover_move_stop2 = mmove(FRAME_stop201, FRAME_stop208, hover_frames_stop2, null);

const hover_frames_takeoff: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, -2),
  mframe(ai_move, 5),
  mframe(ai_move, -1),
  mframe(ai_move, 1),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, -1),
  mframe(ai_move, -1),
  mframe(ai_move, -1),
  mframe(ai_move, 0),
  mframe(ai_move, 2),
  mframe(ai_move, 2),
  mframe(ai_move, 1),
  mframe(ai_move, 1),
  mframe(ai_move, -6),
  mframe(ai_move, -9),
  mframe(ai_move, 1),
  mframe(ai_move, 0),
  mframe(ai_move, 2),
  mframe(ai_move, 2),
  mframe(ai_move, 1),
  mframe(ai_move, 1),
  mframe(ai_move, 1),
  mframe(ai_move, 2),
  mframe(ai_move, 0),
  mframe(ai_move, 2),
  mframe(ai_move, 3),
  mframe(ai_move, 2),
  mframe(ai_move, 0),
];
const hover_move_takeoff = mmove(FRAME_takeof01, FRAME_takeof30, hover_frames_takeoff, null);

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

// Defined but never wired to a monsterinfo hook in the original C either --
// dead code kept for fidelity.
const hover_frames_land: MframeT[] = [mframe(ai_move, 0)];
const hover_move_land = mmove(FRAME_land01, FRAME_land01, hover_frames_land, null);

const hover_frames_forward: MframeT[] = Array.from({ length: 35 }, () => mframe(ai_move, 0));
const hover_move_forward = mmove(FRAME_forwrd01, FRAME_forwrd35, hover_frames_forward, null);

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

// Defined but never wired to a monsterinfo hook in the original C either --
// dead code kept for fidelity.
const hover_frames_backward: MframeT[] = Array.from({ length: 24 }, () => mframe(ai_move, 0));
const hover_move_backward = mmove(FRAME_backwd01, FRAME_backwd24, hover_frames_backward, null);

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

function hover_reattack(self: EdictT): void {
  if (self.enemy !== null && self.enemy.health > 0 && visible(self, self.enemy) && random() <= 0.6) {
    self.monsterinfo.currentmove = hover_move_attack1;
    return;
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

  if (self.s.frame === FRAME_attak104) effect = EF_HYPERBLASTER;
  else effect = 0;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_HOVER_BLASTER_1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  monster_fire_blaster(self, start, dir, 1, 1000, MZ2_HOVER_BLASTER_1, effect);
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

function hover_attack(self: EdictT): void {
  self.monsterinfo.currentmove = hover_move_attack1;
}

function hover_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (damage <= 25) {
    if (random() < 0.5) {
      gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = hover_move_pain3;
    } else {
      gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = hover_move_pain2;
    }
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
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_death1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_death2, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.currentmove = hover_move_death1;
}

/*QUAKED monster_hover (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_hover(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("hover/hovpain1.wav");
  sound_pain2 = gi.soundindex("hover/hovpain2.wav");
  sound_death1 = gi.soundindex("hover/hovdeth1.wav");
  sound_death2 = gi.soundindex("hover/hovdeth2.wav");
  sound_sight = gi.soundindex("hover/hovsght1.wav");
  sound_search1 = gi.soundindex("hover/hovsrch1.wav");
  sound_search2 = gi.soundindex("hover/hovsrch2.wav");

  gi.soundindex("hover/hovatck1.wav");

  self.s.sound = gi.soundindex("hover/hovidle1.wav");

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

  gi.linkentity(self);

  self.monsterinfo.currentmove = hover_move_stand;
  self.monsterinfo.scale = MODEL_SCALE;

  flymonster_start(self);
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
registerSaveMmove("m_hover:hover_move_stand", hover_move_stand);
registerSaveMmove("m_hover:hover_move_stop1", hover_move_stop1);
registerSaveMmove("m_hover:hover_move_stop2", hover_move_stop2);
registerSaveMmove("m_hover:hover_move_takeoff", hover_move_takeoff);
registerSaveMmove("m_hover:hover_move_pain3", hover_move_pain3);
registerSaveMmove("m_hover:hover_move_pain2", hover_move_pain2);
registerSaveMmove("m_hover:hover_move_pain1", hover_move_pain1);
registerSaveMmove("m_hover:hover_move_land", hover_move_land);
registerSaveMmove("m_hover:hover_move_forward", hover_move_forward);
registerSaveMmove("m_hover:hover_move_walk", hover_move_walk);
registerSaveMmove("m_hover:hover_move_run", hover_move_run);
registerSaveMmove("m_hover:hover_move_death1", hover_move_death1);
registerSaveMmove("m_hover:hover_move_backward", hover_move_backward);
registerSaveMmove("m_hover:hover_move_start_attack", hover_move_start_attack);
registerSaveMmove("m_hover:hover_move_attack1", hover_move_attack1);
registerSaveMmove("m_hover:hover_move_end_attack", hover_move_end_attack);
