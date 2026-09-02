/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_supertank.c (GNU GPL v2 or later).
*/
/*
==============================================================================

SUPERTANK

==============================================================================
*/

import { AngleVectors, random, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_VOICE,
  MulticastT,
  MZ2_SUPERTANK_MACHINEGUN_1,
  MZ2_SUPERTANK_ROCKET_1,
  MZ2_SUPERTANK_ROCKET_2,
  MZ2_SUPERTANK_ROCKET_3,
  TempEventT,
} from "../shared/q_shared";
import {
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  gi,
  GIB_METALLIC,
  GIB_ORGANIC,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  POWER_ARMOR_SHIELD,
  svc_temp_entity,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, visible } from "./g_ai";
import { monster_fire_bullet, monster_fire_rocket, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_supertank_frames";

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

function mkmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: ((self: EdictT) => void) | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_death = 0;
let sound_search1 = 0;
let sound_search2 = 0;

let tread_sound = 0;

function TreadSound(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, tread_sound, 1, ATTN_NORM, 0);
}

function supertank_search(self: EdictT): void {
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_search2, 1, ATTN_NORM, 0);
}

//
// stand
//

const supertank_frames_stand: MframeT[] = Array.from({ length: 60 }, () => mkframe(ai_stand, 0));
const supertank_move_stand = mkmove(FRAME.FRAME_stand_1, FRAME.FRAME_stand_60, supertank_frames_stand);

function supertank_stand(self: EdictT): void {
  self.monsterinfo.currentmove = supertank_move_stand;
}

const supertank_frames_run: MframeT[] = [
  mkframe(ai_run, 12, TreadSound),
  ...Array.from({ length: 17 }, () => mkframe(ai_run, 12)),
];
const supertank_move_run = mkmove(FRAME.FRAME_forwrd_1, FRAME.FRAME_forwrd_18, supertank_frames_run);

//
// walk
//

const supertank_frames_forward: MframeT[] = [
  mkframe(ai_walk, 4, TreadSound),
  ...Array.from({ length: 17 }, () => mkframe(ai_walk, 4)),
];
const supertank_move_forward = mkmove(FRAME.FRAME_forwrd_1, FRAME.FRAME_forwrd_18, supertank_frames_forward);

function supertank_forward(self: EdictT): void {
  self.monsterinfo.currentmove = supertank_move_forward;
}

function supertank_walk(self: EdictT): void {
  self.monsterinfo.currentmove = supertank_move_forward;
}

function supertank_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = supertank_move_stand;
  else self.monsterinfo.currentmove = supertank_move_run;
}

const supertank_frames_turn_right: MframeT[] = [
  mkframe(ai_move, 0, TreadSound),
  ...Array.from({ length: 17 }, () => mkframe(ai_move, 0)),
];
const supertank_move_turn_right = mkmove(FRAME.FRAME_right_1, FRAME.FRAME_right_18, supertank_frames_turn_right, supertank_run);

const supertank_frames_turn_left: MframeT[] = [
  mkframe(ai_move, 0, TreadSound),
  ...Array.from({ length: 17 }, () => mkframe(ai_move, 0)),
];
const supertank_move_turn_left = mkmove(FRAME.FRAME_left_1, FRAME.FRAME_left_18, supertank_frames_turn_left, supertank_run);

const supertank_frames_pain3: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const supertank_move_pain3 = mkmove(FRAME.FRAME_pain3_9, FRAME.FRAME_pain3_12, supertank_frames_pain3, supertank_run);

const supertank_frames_pain2: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const supertank_move_pain2 = mkmove(FRAME.FRAME_pain2_5, FRAME.FRAME_pain2_8, supertank_frames_pain2, supertank_run);

const supertank_frames_pain1: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const supertank_move_pain1 = mkmove(FRAME.FRAME_pain1_1, FRAME.FRAME_pain1_4, supertank_frames_pain1, supertank_run);

const supertank_frames_death1: MframeT[] = [
  ...Array.from({ length: 23 }, () => mkframe(ai_move, 0)),
  mkframe(ai_move, 0, BossExplode),
];
const supertank_move_death = mkmove(FRAME.FRAME_death_1, FRAME.FRAME_death_24, supertank_frames_death1, supertank_dead);

const supertank_frames_backward: MframeT[] = [
  mkframe(ai_walk, 0, TreadSound),
  ...Array.from({ length: 17 }, () => mkframe(ai_walk, 0)),
];
const supertank_move_backward = mkmove(FRAME.FRAME_backwd_1, FRAME.FRAME_backwd_18, supertank_frames_backward);

const supertank_frames_attack4: MframeT[] = Array.from({ length: 6 }, () => mkframe(ai_move, 0));
const supertank_move_attack4 = mkmove(FRAME.FRAME_attak4_1, FRAME.FRAME_attak4_6, supertank_frames_attack4, supertank_run);

const supertank_frames_attack3: MframeT[] = Array.from({ length: 27 }, () => mkframe(ai_move, 0));
const supertank_move_attack3 = mkmove(FRAME.FRAME_attak3_1, FRAME.FRAME_attak3_27, supertank_frames_attack3, supertank_run);

const supertank_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, supertankRocket),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, supertankRocket),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, supertankRocket),
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
const supertank_move_attack2 = mkmove(FRAME.FRAME_attak2_1, FRAME.FRAME_attak2_27, supertank_frames_attack2, supertank_run);

const supertank_frames_attack1: MframeT[] = Array.from({ length: 6 }, () => mkframe(ai_charge, 0, supertankMachineGun));
const supertank_move_attack1 = mkmove(FRAME.FRAME_attak1_1, FRAME.FRAME_attak1_6, supertank_frames_attack1, supertank_reattack1);

const supertank_frames_end_attack1: MframeT[] = Array.from({ length: 14 }, () => mkframe(ai_move, 0));
const supertank_move_end_attack1 = mkmove(FRAME.FRAME_attak1_7, FRAME.FRAME_attak1_20, supertank_frames_end_attack1, supertank_run);

function supertank_reattack1(self: EdictT): void {
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (random() < 0.9) self.monsterinfo.currentmove = supertank_move_attack1;
    else self.monsterinfo.currentmove = supertank_move_end_attack1;
  } else {
    self.monsterinfo.currentmove = supertank_move_end_attack1;
  }
}

function supertank_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  // Lessen the chance of him going into his pain frames
  if (damage <= 25) {
    if (random() < 0.2) return;
  }

  // Don't go into pain if he's firing his rockets
  if (cvarNum(gameCvars.skill) >= 2) {
    if (self.s.frame >= FRAME.FRAME_attak2_1 && self.s.frame <= FRAME.FRAME_attak2_14) return;
  }

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (damage <= 10) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = supertank_move_pain1;
  } else if (damage <= 25) {
    gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = supertank_move_pain2;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = supertank_move_pain3;
  }
}

function supertankRocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();
  let flash_number: number;

  if (self.s.frame === FRAME.FRAME_attak2_8) flash_number = MZ2_SUPERTANK_ROCKET_1;
  else if (self.s.frame === FRAME.FRAME_attak2_11) flash_number = MZ2_SUPERTANK_ROCKET_2;
  else flash_number = MZ2_SUPERTANK_ROCKET_3;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);

  monster_fire_rocket(self, start, dir, 50, 500, flash_number);
}

function supertankMachineGun(self: EdictT): void {
  const vec = vec3();
  const start = vec3();
  const forward = vec3();
  const right = vec3();

  const flash_number = MZ2_SUPERTANK_MACHINEGUN_1 + (self.s.frame - FRAME.FRAME_attak1_1);

  // FIXME!!!
  const dir = vec3(0, self.s.angles[1], 0);

  AngleVectors(dir, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  if (self.enemy) {
    VectorCopy(self.enemy.s.origin, vec);
    VectorMA(vec, 0, self.enemy.velocity, vec);
    vec[2] += self.enemy.viewheight;
    VectorSubtract(vec, start, forward);
    VectorNormalize(forward);
  }

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_number);
}

const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

function supertank_attack(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const vec = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, vec);
  const range = VectorLength(vec);

  // Attack 1 == Chaingun
  // Attack 2 == Rocket Launcher

  if (range <= 160) {
    self.monsterinfo.currentmove = supertank_move_attack1;
  } else {
    // fire rockets more often at distance
    if (random() < 0.3) self.monsterinfo.currentmove = supertank_move_attack1;
    else self.monsterinfo.currentmove = supertank_move_attack2;
  }
}

//
// death
//

function supertank_dead(self: EdictT): void {
  VectorSet(self.mins, -60, -60, 0);
  VectorSet(self.maxs, 60, 60, 72);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

// Defined once here (matching the C source: m_supertank.c owns the only
// non-forward-declared body of BossExplode) and reused by m_boss2.c and
// m_boss31.c via `void BossExplode (edict_t *self);` forward declarations
// that resolve to this same linked symbol -- so m_boss2.ts imports this
// export rather than re-implementing it.
export function BossExplode(self: EdictT): void {
  self.think = BossExplode;
  const org = vec3();
  VectorCopy(self.s.origin, org);
  org[2] += 24 + Math.floor(Math.random() * 16); // rand()&15

  switch (self.count++) {
    case 0:
      org[0] -= 24;
      org[1] -= 24;
      break;
    case 1:
      org[0] += 24;
      org[1] += 24;
      break;
    case 2:
      org[0] += 24;
      org[1] -= 24;
      break;
    case 3:
      org[0] -= 24;
      org[1] += 24;
      break;
    case 4:
      org[0] -= 48;
      org[1] -= 48;
      break;
    case 5:
      org[0] += 48;
      org[1] += 48;
      break;
    case 6:
      org[0] -= 48;
      org[1] += 48;
      break;
    case 7:
      org[0] += 48;
      org[1] -= 48;
      break;
    case 8: {
      self.s.sound = 0;
      for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", 500, GIB_ORGANIC);
      for (let n = 0; n < 8; n++) ThrowGib(self, "models/objects/gibs/sm_metal/tris.md2", 500, GIB_METALLIC);
      ThrowGib(self, "models/objects/gibs/chest/tris.md2", 500, GIB_ORGANIC);
      ThrowHead(self, "models/objects/gibs/gear/tris.md2", 500, GIB_METALLIC);
      self.deadflag = DEAD_DEAD;
      return;
    }
    default:
      break;
  }

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(org);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  self.nextthink = level.time + 0.1;
}

function supertank_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_NO;
  self.count = 0;
  self.monsterinfo.currentmove = supertank_move_death;
}

//
// monster_supertank
//

/*QUAKED monster_supertank (1 .5 0) (-64 -64 0) (64 64 72) Ambush Trigger_Spawn Sight Powershield
*/
export function SP_monster_supertank(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("bosstank/btkpain1.wav");
  sound_pain2 = gi.soundindex("bosstank/btkpain2.wav");
  sound_pain3 = gi.soundindex("bosstank/btkpain3.wav");
  sound_death = gi.soundindex("bosstank/btkdeth1.wav");
  sound_search1 = gi.soundindex("bosstank/btkunqv1.wav");
  sound_search2 = gi.soundindex("bosstank/btkunqv2.wav");

  tread_sound = gi.soundindex("bosstank/btkengn1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss1/tris.md2");
  VectorSet(self.mins, -64, -64, 0);
  VectorSet(self.maxs, 64, 64, 112);

  self.health = 1500;
  self.gib_health = -500;
  self.mass = 800;

  self.pain = supertank_pain;
  self.die = supertank_die;
  self.monsterinfo.stand = supertank_stand;
  self.monsterinfo.walk = supertank_walk;
  self.monsterinfo.run = supertank_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = supertank_attack;
  self.monsterinfo.search = supertank_search;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;

  gi.linkentity(self);

  self.monsterinfo.currentmove = supertank_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  // xatrix/m_supertank.c: Powershield spawnflag (bit 8) grants power armor.
  if (self.spawnflags & 8) {
    self.monsterinfo.power_armor_type = POWER_ARMOR_SHIELD;
    self.monsterinfo.power_armor_power = 400;
  }

  walkmonster_start(self);
}

// supertank_forward, supertank_move_turn_left, supertank_move_turn_right,
// supertank_move_backward, supertank_move_attack3, and supertank_move_attack4
// are defined (matching the C source's tables and forward declarations) but
// never wired to a monsterinfo callback in m_supertank.c either -- dead code
// in the original, preserved faithfully rather than pruned.

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_supertank:BossExplode", BossExplode);
registerSaveFunction("m_supertank:supertank_pain", supertank_pain);
registerSaveFunction("m_supertank:supertank_die", supertank_die);
registerSaveFunction("m_supertank:supertank_stand", supertank_stand);
registerSaveFunction("m_supertank:supertank_walk", supertank_walk);
registerSaveFunction("m_supertank:supertank_run", supertank_run);
registerSaveFunction("m_supertank:supertank_attack", supertank_attack);
registerSaveFunction("m_supertank:supertank_search", supertank_search);
registerSaveMmove("m_supertank:supertank_move_stand", supertank_move_stand);
registerSaveMmove("m_supertank:supertank_move_run", supertank_move_run);
registerSaveMmove("m_supertank:supertank_move_forward", supertank_move_forward);
registerSaveMmove("m_supertank:supertank_move_turn_right", supertank_move_turn_right);
registerSaveMmove("m_supertank:supertank_move_turn_left", supertank_move_turn_left);
registerSaveMmove("m_supertank:supertank_move_pain3", supertank_move_pain3);
registerSaveMmove("m_supertank:supertank_move_pain2", supertank_move_pain2);
registerSaveMmove("m_supertank:supertank_move_pain1", supertank_move_pain1);
registerSaveMmove("m_supertank:supertank_move_death", supertank_move_death);
registerSaveMmove("m_supertank:supertank_move_backward", supertank_move_backward);
registerSaveMmove("m_supertank:supertank_move_attack4", supertank_move_attack4);
registerSaveMmove("m_supertank:supertank_move_attack3", supertank_move_attack3);
registerSaveMmove("m_supertank:supertank_move_attack2", supertank_move_attack2);
registerSaveMmove("m_supertank:supertank_move_attack1", supertank_move_attack1);
registerSaveMmove("m_supertank:supertank_move_end_attack1", supertank_move_end_attack1);
