/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_float.c (GNU GPL v2 or later).
*/
/*
==============================================================================

floater

==============================================================================
*/
// m_float.c

import { AngleVectors, random, vec3, vec3_origin, VectorCopy, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_VOICE,
  CHAN_WEAPON,
  EF_HYPERBLASTER,
  MulticastT,
  MZ2_FLOAT_BLASTER_1,
  TempEventT,
} from "../shared/q_shared";
import { ai_charge, ai_move, ai_stand, ai_walk, ai_run } from "./g_ai";
import { T_Damage } from "./g_combat";
import {
  AI_STAND_GROUND,
  DAMAGE_ENERGY,
  type EdictT,
  gameCvars,
  gi,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MOD_UNKNOWN,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { BecomeExplosion1 } from "./g_misc";
import { flymonster_start, monster_fire_blaster } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { fire_hit } from "./g_weapon";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { monsterFlashOffset } from "./m_flash";
import {
  FRAME_actvat01,
  FRAME_actvat31,
  FRAME_attak101,
  FRAME_attak104,
  FRAME_attak107,
  FRAME_attak114,
  FRAME_attak201,
  FRAME_attak225,
  FRAME_attak301,
  FRAME_attak334,
  FRAME_death01,
  FRAME_death13,
  FRAME_pain101,
  FRAME_pain107,
  FRAME_pain201,
  FRAME_pain208,
  FRAME_pain301,
  FRAME_pain312,
  FRAME_stand101,
  FRAME_stand152,
  FRAME_stand201,
  FRAME_stand252,
  MODEL_SCALE,
} from "./m_float_frames";

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

function mmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveT["endfunc"] = null, allowFrameCountMismatch = false): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.allowFrameCountMismatch = allowFrameCountMismatch;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_attack2 = 0;
let sound_attack3 = 0;
let sound_death1 = 0;
let sound_idle = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_sight = 0;

function floater_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function floater_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function floater_fire_blaster(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const end = vec3();
  const dir = vec3();
  let effect: number;

  if (self.s.frame === FRAME_attak104 || self.s.frame === FRAME_attak107) effect = EF_HYPERBLASTER;
  else effect = 0;
  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_FLOAT_BLASTER_1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  monster_fire_blaster(self, start, dir, 1, 1000, MZ2_FLOAT_BLASTER_1, effect);
}

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order (unlike the C forward decls that
// are only needed to satisfy the compiler's declare-before-use rule).

const floater_frames_stand1: MframeT[] = Array.from({ length: 52 }, () => mframe(ai_stand, 0));
const floater_move_stand1 = mmove(FRAME_stand101, FRAME_stand152, floater_frames_stand1, null);

const floater_frames_stand2: MframeT[] = Array.from({ length: 52 }, () => mframe(ai_stand, 0));
const floater_move_stand2 = mmove(FRAME_stand201, FRAME_stand252, floater_frames_stand2, null);

function floater_stand(self: EdictT): void {
  if (random() <= 0.5) self.monsterinfo.currentmove = floater_move_stand1;
  else self.monsterinfo.currentmove = floater_move_stand2;
}

// Defined but never wired to a monsterinfo hook in the original C either --
// dead code kept for fidelity.
const floater_frames_activate: MframeT[] = Array.from({ length: 30 }, () => mframe(ai_move, 0));
// C bug, not a porting error: m_float.c's floater_frames_activate[] has 30
// rows but FRAME_actvat01(0)..FRAME_actvat31(30) spans 31 (game/m_float.c:205-238).
// Preserved byte-for-byte; already dead code in the original per the comment above.
const floater_move_activate = mmove(FRAME_actvat01, FRAME_actvat31, floater_frames_activate, null, true);

const floater_frames_attack1: MframeT[] = [
  mframe(ai_charge, 0), // Blaster attack
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0, floater_fire_blaster), // BOOM (0, -25.8, 32.5)	-- LOOP Starts
  mframe(ai_charge, 0, floater_fire_blaster),
  mframe(ai_charge, 0, floater_fire_blaster),
  mframe(ai_charge, 0, floater_fire_blaster),
  mframe(ai_charge, 0, floater_fire_blaster),
  mframe(ai_charge, 0, floater_fire_blaster),
  mframe(ai_charge, 0, floater_fire_blaster),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0), //							-- LOOP Ends
];
const floater_move_attack1 = mmove(FRAME_attak101, FRAME_attak114, floater_frames_attack1, floater_run);

function floater_wham(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  gi.sound(self, CHAN_WEAPON, sound_attack3, 1, ATTN_NORM, 0);
  fire_hit(self, aim, 5 + Math.floor(Math.random() * 6), -50);
}

const floater_frames_attack2: MframeT[] = [
  mframe(ai_charge, 0), // Claws
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
  mframe(ai_charge, 0, floater_wham), // WHAM (0, -45, 29.6)		-- LOOP Starts
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0), //							-- LOOP Ends
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
];
const floater_move_attack2 = mmove(FRAME_attak201, FRAME_attak225, floater_frames_attack2, floater_run);

function floater_zap(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const origin = vec3();
  const dir = vec3();

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorSubtract(self.enemy.s.origin, self.s.origin, dir);

  AngleVectors(self.s.angles, forward, right, null);
  // FIXME use a flash and replace these two lines with the commented one
  const offset = vec3(18.5, -0.9, 10);
  G_ProjectSource(self.s.origin, offset, forward, right, origin);
  //	G_ProjectSource (self->s.origin, monster_flash_offset[flash_number], forward, right, origin);

  gi.sound(self, CHAN_WEAPON, sound_attack2, 1, ATTN_NORM, 0);

  // FIXME use the flash, Luke
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_SPLASH);
  gi.WriteByte(32);
  gi.WritePosition(origin);
  gi.WriteDir(dir);
  gi.WriteByte(1); // sparks
  gi.multicast(origin, MulticastT.MULTICAST_PVS);

  T_Damage(self.enemy, self, self, dir, self.enemy.s.origin, vec3_origin, 5 + Math.floor(Math.random() * 6), -10, DAMAGE_ENERGY, MOD_UNKNOWN);
}

const floater_frames_attack3: MframeT[] = [
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0, floater_zap), //								-- LOOP Starts
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
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0), //								-- LOOP Ends
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
];
const floater_move_attack3 = mmove(FRAME_attak301, FRAME_attak334, floater_frames_attack3, floater_run);

const floater_frames_death: MframeT[] = Array.from({ length: 13 }, () => mframe(ai_move, 0));
const floater_move_death = mmove(FRAME_death01, FRAME_death13, floater_frames_death, floater_dead);

const floater_frames_pain1: MframeT[] = Array.from({ length: 7 }, () => mframe(ai_move, 0));
const floater_move_pain1 = mmove(FRAME_pain101, FRAME_pain107, floater_frames_pain1, floater_run);

const floater_frames_pain2: MframeT[] = Array.from({ length: 8 }, () => mframe(ai_move, 0));
const floater_move_pain2 = mmove(FRAME_pain201, FRAME_pain208, floater_frames_pain2, floater_run);

// Defined but never selected by floater_pain in the original C either
// (n = (rand() + 1) % 3 only ever branches to pain1 or pain2) -- dead code
// kept for fidelity.
const floater_frames_pain3: MframeT[] = Array.from({ length: 12 }, () => mframe(ai_move, 0));
const floater_move_pain3 = mmove(FRAME_pain301, FRAME_pain312, floater_frames_pain3, floater_run);

const floater_frames_walk: MframeT[] = Array.from({ length: 52 }, () => mframe(ai_walk, 5));
const floater_move_walk = mmove(FRAME_stand101, FRAME_stand152, floater_frames_walk, null);

const floater_frames_run: MframeT[] = Array.from({ length: 52 }, () => mframe(ai_run, 13));
const floater_move_run = mmove(FRAME_stand101, FRAME_stand152, floater_frames_run, null);

function floater_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = floater_move_stand1;
  else self.monsterinfo.currentmove = floater_move_run;
}

function floater_walk(self: EdictT): void {
  self.monsterinfo.currentmove = floater_move_walk;
}

function floater_attack(self: EdictT): void {
  self.monsterinfo.currentmove = floater_move_attack1;
}

function floater_melee(self: EdictT): void {
  if (random() < 0.5) self.monsterinfo.currentmove = floater_move_attack3;
  else self.monsterinfo.currentmove = floater_move_attack2;
}

function floater_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // C: `n = (rand() + 1) % 3;` -- a uniform draw over {0,1,2}, ported via the
  // house `Math.floor(Math.random() * N)` idiom for raw rand() (see
  // PORTING.md; the constant +1 shift doesn't change the uniform mod-3
  // distribution).
  const n = Math.floor(Math.random() * 3);
  if (n === 0) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = floater_move_pain1;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = floater_move_pain2;
  }
}

function floater_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function floater_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_death1, 1, ATTN_NORM, 0);
  BecomeExplosion1(self);
}

/*QUAKED monster_floater (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_floater(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_attack2 = gi.soundindex("floater/fltatck2.wav");
  sound_attack3 = gi.soundindex("floater/fltatck3.wav");
  sound_death1 = gi.soundindex("floater/fltdeth1.wav");
  sound_idle = gi.soundindex("floater/fltidle1.wav");
  sound_pain1 = gi.soundindex("floater/fltpain1.wav");
  sound_pain2 = gi.soundindex("floater/fltpain2.wav");
  sound_sight = gi.soundindex("floater/fltsght1.wav");

  gi.soundindex("floater/fltatck1.wav");

  self.s.sound = gi.soundindex("floater/fltsrch1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/float/tris.md2");
  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 32);

  self.health = 200;
  self.gib_health = -80;
  self.mass = 300;

  self.pain = floater_pain;
  self.die = floater_die;

  self.monsterinfo.stand = floater_stand;
  self.monsterinfo.walk = floater_walk;
  self.monsterinfo.run = floater_run;
  self.monsterinfo.attack = floater_attack;
  self.monsterinfo.melee = floater_melee;
  self.monsterinfo.sight = floater_sight;
  self.monsterinfo.idle = floater_idle;

  gi.linkentity(self);

  if (random() <= 0.5) self.monsterinfo.currentmove = floater_move_stand1;
  else self.monsterinfo.currentmove = floater_move_stand2;

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

registerSaveFunction("m_float:floater_pain", floater_pain);
registerSaveFunction("m_float:floater_die", floater_die);
registerSaveFunction("m_float:floater_stand", floater_stand);
registerSaveFunction("m_float:floater_walk", floater_walk);
registerSaveFunction("m_float:floater_run", floater_run);
registerSaveFunction("m_float:floater_attack", floater_attack);
registerSaveFunction("m_float:floater_melee", floater_melee);
registerSaveFunction("m_float:floater_sight", floater_sight);
registerSaveFunction("m_float:floater_idle", floater_idle);
registerSaveMmove("m_float:floater_move_stand1", floater_move_stand1);
registerSaveMmove("m_float:floater_move_stand2", floater_move_stand2);
registerSaveMmove("m_float:floater_move_activate", floater_move_activate);
registerSaveMmove("m_float:floater_move_attack1", floater_move_attack1);
registerSaveMmove("m_float:floater_move_attack2", floater_move_attack2);
registerSaveMmove("m_float:floater_move_attack3", floater_move_attack3);
registerSaveMmove("m_float:floater_move_death", floater_move_death);
registerSaveMmove("m_float:floater_move_pain1", floater_move_pain1);
registerSaveMmove("m_float:floater_move_pain2", floater_move_pain2);
registerSaveMmove("m_float:floater_move_pain3", floater_move_pain3);
registerSaveMmove("m_float:floater_move_walk", floater_move_walk);
registerSaveMmove("m_float:floater_move_run", floater_move_run);
