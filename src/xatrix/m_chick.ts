/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from xatrix/m_chick.c (GNU GPL v2 or later), diffed against the
baseq2 port at src/game/m_chick.ts.
*/
/*
==============================================================================

chick

==============================================================================
*/

import { AngleVectors, random, VectorCopy, VectorNormalize, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, CHAN_VOICE, CHAN_WEAPON, MZ2_CHICK_ROCKET_1 } from "../shared/q_shared";
import {
  AI_DUCKED,
  AI_HOLD_FRAME,
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
  RANGE_MELEE,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range, visible } from "./g_ai";
import { fire_hit } from "./g_weapon";
import { monster_fire_heat, monster_fire_rocket, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_chick_frames";

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

let sound_missile_prelaunch = 0;
let sound_missile_launch = 0;
let sound_melee_swing = 0;
let sound_melee_hit = 0;
let sound_missile_reload = 0;
let sound_death1 = 0;
let sound_death2 = 0;
let sound_fall_down = 0;
let sound_idle1 = 0;
let sound_idle2 = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_sight = 0;
let sound_search = 0;

function ChickMoan(self: EdictT): void {
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_idle1, 1, ATTN_IDLE, 0);
  else gi.sound(self, CHAN_VOICE, sound_idle2, 1, ATTN_IDLE, 0);
}

const chick_frames_fidget: MframeT[] = [
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, ChickMoan),
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
const chick_move_fidget = mkmove(FRAME.FRAME_stand201, FRAME.FRAME_stand230, chick_frames_fidget, chick_stand);

function chick_fidget(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) return;
  if (random() <= 0.3) self.monsterinfo.currentmove = chick_move_fidget;
}

const chick_frames_stand: MframeT[] = [
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
  mkframe(ai_stand, 0, chick_fidget),
];
const chick_move_stand = mkmove(FRAME.FRAME_stand101, FRAME.FRAME_stand130, chick_frames_stand, null);

function chick_stand(self: EdictT): void {
  self.monsterinfo.currentmove = chick_move_stand;
}

const chick_frames_start_run: MframeT[] = [
  mkframe(ai_run, 1),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, -1),
  mkframe(ai_run, -1),
  mkframe(ai_run, 0),
  mkframe(ai_run, 1),
  mkframe(ai_run, 3),
  mkframe(ai_run, 6),
  mkframe(ai_run, 3),
];
const chick_move_start_run = mkmove(FRAME.FRAME_walk01, FRAME.FRAME_walk10, chick_frames_start_run, chick_run);

const chick_frames_run: MframeT[] = [
  mkframe(ai_run, 6),
  mkframe(ai_run, 8),
  mkframe(ai_run, 13),
  mkframe(ai_run, 5),
  mkframe(ai_run, 7),
  mkframe(ai_run, 4),
  mkframe(ai_run, 11),
  mkframe(ai_run, 5),
  mkframe(ai_run, 9),
  mkframe(ai_run, 7),
];
const chick_move_run = mkmove(FRAME.FRAME_walk11, FRAME.FRAME_walk20, chick_frames_run, null);

const chick_frames_walk: MframeT[] = [
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 13),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 11),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 7),
];
const chick_move_walk = mkmove(FRAME.FRAME_walk11, FRAME.FRAME_walk20, chick_frames_walk, null);

function chick_walk(self: EdictT): void {
  self.monsterinfo.currentmove = chick_move_walk;
}

function chick_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    self.monsterinfo.currentmove = chick_move_stand;
    return;
  }

  if (self.monsterinfo.currentmove === chick_move_walk || self.monsterinfo.currentmove === chick_move_start_run) {
    self.monsterinfo.currentmove = chick_move_run;
  } else {
    self.monsterinfo.currentmove = chick_move_start_run;
  }
}

const chick_frames_pain1: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0)];
const chick_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain105, chick_frames_pain1, chick_run);

const chick_frames_pain2: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0)];
const chick_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain205, chick_frames_pain2, chick_run);

const chick_frames_pain3: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -6),
  mkframe(ai_move, 3),
  mkframe(ai_move, 11),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 4),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, -3),
  mkframe(ai_move, -4),
  mkframe(ai_move, 5),
  mkframe(ai_move, 7),
  mkframe(ai_move, -2),
  mkframe(ai_move, 3),
  mkframe(ai_move, -5),
  mkframe(ai_move, -2),
  mkframe(ai_move, -8),
  mkframe(ai_move, 2),
];
const chick_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain321, chick_frames_pain3, chick_run);

function chick_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  const r = random();
  if (r < 0.33) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else if (r < 0.66) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NORM, 0);

  // xatrix/m_chick.c drops baseq2's "no pain anims in nightmare" early
  // return here (game/m_chick.c:283-284 vs xatrix/m_chick.c) -- nightmare
  // skill now plays pain animations for this monster.

  if (damage <= 10) self.monsterinfo.currentmove = chick_move_pain1;
  else if (damage <= 25) self.monsterinfo.currentmove = chick_move_pain2;
  else self.monsterinfo.currentmove = chick_move_pain3;
}

function chick_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, 0);
  VectorSet(self.maxs, 16, 16, 16);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const chick_frames_death2: MframeT[] = [
  mkframe(ai_move, -6),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 10),
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move, -3),
  mkframe(ai_move, -5),
  mkframe(ai_move, 4),
  mkframe(ai_move, 15),
  mkframe(ai_move, 14),
  mkframe(ai_move, 1),
];
const chick_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death223, chick_frames_death2, chick_dead);

const chick_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -7),
  mkframe(ai_move, 4),
  mkframe(ai_move, 11),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const chick_move_death1 = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death112, chick_frames_death1, chick_dead);

function chick_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
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

  // C: `n = rand() % 2;` -- Quake's raw rand(), per house style (m_gunner.ts,
  // m_move.ts already establish this mapping for raw rand() calls).
  const n = Math.floor(Math.random() * 2) % 2;
  if (n === 0) {
    self.monsterinfo.currentmove = chick_move_death1;
    gi.sound(self, CHAN_VOICE, sound_death1, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.currentmove = chick_move_death2;
    gi.sound(self, CHAN_VOICE, sound_death2, 1, ATTN_NORM, 0);
  }
}

function chick_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.pausetime = level.time + 1;
  gi.linkentity(self);
}

function chick_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

function chick_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

const chick_frames_duck: MframeT[] = [
  mkframe(ai_move, 0, chick_duck_down),
  mkframe(ai_move, 1),
  mkframe(ai_move, 4, chick_duck_hold),
  mkframe(ai_move, -4),
  mkframe(ai_move, -5, chick_duck_up),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
];
const chick_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck07, chick_frames_duck, chick_run);

function chick_dodge(self: EdictT, attacker: EdictT, _eta: number): void {
  if (random() > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  self.monsterinfo.currentmove = chick_move_duck;
}

function ChickSlash(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 10);
  gi.sound(self, CHAN_WEAPON, sound_melee_swing, 1, ATTN_NORM, 0);
  fire_hit(self, aim, 10 + (Math.floor(Math.random() * 6) % 6), 100);
}

function ChickRocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CHICK_ROCKET_1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here

  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);

  // xatrix/m_chick.c: skinnum > 1 marks the "heat-seeking" chick variant
  // (SP_monster_chick_heat sets skinnum = 3) -- fires a heat-seeking round
  // instead of a dumb rocket.
  if (self.s.skinnum > 1) monster_fire_heat(self, start, dir, 50, 500, MZ2_CHICK_ROCKET_1);
  else monster_fire_rocket(self, start, dir, 50, 500, MZ2_CHICK_ROCKET_1);
}

function Chick_PreAttack1(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_missile_prelaunch, 1, ATTN_NORM, 0);
}

function ChickReload(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_missile_reload, 1, ATTN_NORM, 0);
}

const chick_frames_start_attack1: MframeT[] = [
  mkframe(ai_charge, 0, Chick_PreAttack1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 7),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, chick_attack1),
];
const chick_move_start_attack1 = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak113, chick_frames_start_attack1, null);

const chick_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 19, ChickRocket),
  mkframe(ai_charge, -6),
  mkframe(ai_charge, -5),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -7),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 10, ChickReload),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 3, chick_rerocket),
];
const chick_move_attack1 = mkmove(FRAME.FRAME_attak114, FRAME.FRAME_attak127, chick_frames_attack1, null);

const chick_frames_end_attack1: MframeT[] = [
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -6),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -2),
];
const chick_move_end_attack1 = mkmove(FRAME.FRAME_attak128, FRAME.FRAME_attak132, chick_frames_end_attack1, chick_run);

function chick_rerocket(self: EdictT): void {
  if (self.enemy !== null && self.enemy.health > 0) {
    if (range(self, self.enemy) > RANGE_MELEE) {
      if (visible(self, self.enemy)) {
        if (random() <= 0.6) {
          self.monsterinfo.currentmove = chick_move_attack1;
          return;
        }
      }
    }
  }
  self.monsterinfo.currentmove = chick_move_end_attack1;
}

function chick_attack1(self: EdictT): void {
  self.monsterinfo.currentmove = chick_move_attack1;
}

const chick_frames_slash: MframeT[] = [
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 7, ChickSlash),
  mkframe(ai_charge, -7),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, -2, chick_reslash),
];
const chick_move_slash = mkmove(FRAME.FRAME_attak204, FRAME.FRAME_attak212, chick_frames_slash, null);

const chick_frames_end_slash: MframeT[] = [mkframe(ai_charge, -6), mkframe(ai_charge, -1), mkframe(ai_charge, -6), mkframe(ai_charge, 0)];
const chick_move_end_slash = mkmove(FRAME.FRAME_attak213, FRAME.FRAME_attak216, chick_frames_end_slash, chick_run);

function chick_reslash(self: EdictT): void {
  if (self.enemy !== null && self.enemy.health > 0) {
    if (range(self, self.enemy) === RANGE_MELEE) {
      if (random() <= 0.9) {
        self.monsterinfo.currentmove = chick_move_slash;
        return;
      } else {
        self.monsterinfo.currentmove = chick_move_end_slash;
        return;
      }
    }
  }
  self.monsterinfo.currentmove = chick_move_end_slash;
}

function chick_slash(self: EdictT): void {
  self.monsterinfo.currentmove = chick_move_slash;
}

const chick_frames_start_slash: MframeT[] = [mkframe(ai_charge, 1), mkframe(ai_charge, 8), mkframe(ai_charge, 3)];
const chick_move_start_slash = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak203, chick_frames_start_slash, chick_slash);

function chick_melee(self: EdictT): void {
  self.monsterinfo.currentmove = chick_move_start_slash;
}

function chick_attack(self: EdictT): void {
  self.monsterinfo.currentmove = chick_move_start_attack1;
}

function chick_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

/*QUAKED monster_chick (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_chick(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_missile_prelaunch = gi.soundindex("chick/chkatck1.wav");
  sound_missile_launch = gi.soundindex("chick/chkatck2.wav");
  sound_melee_swing = gi.soundindex("chick/chkatck3.wav");
  sound_melee_hit = gi.soundindex("chick/chkatck4.wav");
  sound_missile_reload = gi.soundindex("chick/chkatck5.wav");
  sound_death1 = gi.soundindex("chick/chkdeth1.wav");
  sound_death2 = gi.soundindex("chick/chkdeth2.wav");
  sound_fall_down = gi.soundindex("chick/chkfall1.wav");
  sound_idle1 = gi.soundindex("chick/chkidle1.wav");
  sound_idle2 = gi.soundindex("chick/chkidle2.wav");
  sound_pain1 = gi.soundindex("chick/chkpain1.wav");
  sound_pain2 = gi.soundindex("chick/chkpain2.wav");
  sound_pain3 = gi.soundindex("chick/chkpain3.wav");
  sound_sight = gi.soundindex("chick/chksght1.wav");
  sound_search = gi.soundindex("chick/chksrch1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/bitch/tris.md2");
  VectorSet(self.mins, -16, -16, 0);
  VectorSet(self.maxs, 16, 16, 56);

  self.health = 175;
  self.gib_health = -70;
  self.mass = 200;

  self.pain = chick_pain;
  self.die = chick_die;

  self.monsterinfo.stand = chick_stand;
  self.monsterinfo.walk = chick_walk;
  self.monsterinfo.run = chick_run;
  self.monsterinfo.dodge = chick_dodge;
  self.monsterinfo.attack = chick_attack;
  self.monsterinfo.melee = chick_melee;
  self.monsterinfo.sight = chick_sight;

  gi.linkentity(self);

  self.monsterinfo.currentmove = chick_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);
}

/*QUAKED monster_chick_heat (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_chick_heat(self: EdictT): void {
  SP_monster_chick(self);
  self.s.skinnum = 3;
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_chick:chick_pain", chick_pain);
registerSaveFunction("m_chick:chick_die", chick_die);
registerSaveFunction("m_chick:chick_stand", chick_stand);
registerSaveFunction("m_chick:chick_walk", chick_walk);
registerSaveFunction("m_chick:chick_run", chick_run);
registerSaveFunction("m_chick:chick_dodge", chick_dodge);
registerSaveFunction("m_chick:chick_attack", chick_attack);
registerSaveFunction("m_chick:chick_melee", chick_melee);
registerSaveFunction("m_chick:chick_sight", chick_sight);
registerSaveMmove("m_chick:chick_move_fidget", chick_move_fidget);
registerSaveMmove("m_chick:chick_move_stand", chick_move_stand);
registerSaveMmove("m_chick:chick_move_start_run", chick_move_start_run);
registerSaveMmove("m_chick:chick_move_run", chick_move_run);
registerSaveMmove("m_chick:chick_move_walk", chick_move_walk);
registerSaveMmove("m_chick:chick_move_pain1", chick_move_pain1);
registerSaveMmove("m_chick:chick_move_pain2", chick_move_pain2);
registerSaveMmove("m_chick:chick_move_pain3", chick_move_pain3);
registerSaveMmove("m_chick:chick_move_death2", chick_move_death2);
registerSaveMmove("m_chick:chick_move_death1", chick_move_death1);
registerSaveMmove("m_chick:chick_move_duck", chick_move_duck);
registerSaveMmove("m_chick:chick_move_start_attack1", chick_move_start_attack1);
registerSaveMmove("m_chick:chick_move_attack1", chick_move_attack1);
registerSaveMmove("m_chick:chick_move_end_attack1", chick_move_end_attack1);
registerSaveMmove("m_chick:chick_move_slash", chick_move_slash);
registerSaveMmove("m_chick:chick_move_end_slash", chick_move_end_slash);
registerSaveMmove("m_chick:chick_move_start_slash", chick_move_start_slash);
