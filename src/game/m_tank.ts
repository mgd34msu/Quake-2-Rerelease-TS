/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_tank.c (GNU GPL v2 or later).
*/
/*
==============================================================================

TANK

==============================================================================
*/

import { AngleVectors, random, VectorCopy, VectorLength, VectorNormalize, VectorScale, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_BODY,
  CHAN_VOICE,
  CHAN_WEAPON,
  EF_BLASTER,
  MZ2_TANK_BLASTER_1,
  MZ2_TANK_BLASTER_2,
  MZ2_TANK_BLASTER_3,
  MZ2_TANK_MACHINEGUN_1,
  MZ2_TANK_ROCKET_1,
  MZ2_TANK_ROCKET_2,
  MZ2_TANK_ROCKET_3,
  MulticastT,
  TempEventT,
} from "../shared/q_shared";
import {
  AI_BRUTAL,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FRAMETIME,
  gameCvars,
  gi,
  GIB_METALLIC,
  GIB_ORGANIC,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, visible } from "./g_ai";
import { monster_fire_blaster, monster_fire_bullet, monster_fire_rocket, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource, vectoangles } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_tank_frames";

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD (p_weapon.ts keeps its own
// module-local copy too; not centralized anywhere in the header modules).
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

let sound_thud = 0;
let sound_pain = 0;
let sound_idle = 0;
let sound_die = 0;
let sound_step = 0;
let sound_sight = 0;
let sound_windup = 0;
let sound_strike = 0;

//
// misc
//

function tank_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function tank_footstep(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step, 1, ATTN_NORM, 0);
}

function tank_thud(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_thud, 1, ATTN_NORM, 0);
}

function tank_windup(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_windup, 1, ATTN_NORM, 0);
}

function tank_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

//
// stand
//

const tank_frames_stand: MframeT[] = Array.from({ length: 30 }, () => {
  const f = new MframeT();
  f.aifunc = ai_stand;
  return f;
});
const tank_move_stand = new MmoveT();
tank_move_stand.firstframe = FRAME.FRAME_stand01;
tank_move_stand.lastframe = FRAME.FRAME_stand30;
tank_move_stand.frame = tank_frames_stand;

function tank_stand(self: EdictT): void {
  self.monsterinfo.currentmove = tank_move_stand;
}

//
// walk
//

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

const tank_frames_start_walk: MframeT[] = [
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 11, tank_footstep),
];
const tank_move_start_walk = mkmove(FRAME.FRAME_walk01, FRAME.FRAME_walk04, tank_frames_start_walk, tank_walk);

const tank_frames_walk: MframeT[] = [
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 4, tank_footstep),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 6, tank_footstep),
];
const tank_move_walk = mkmove(FRAME.FRAME_walk05, FRAME.FRAME_walk20, tank_frames_walk);

const tank_frames_stop_walk: MframeT[] = [
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 4, tank_footstep),
];
const tank_move_stop_walk = mkmove(FRAME.FRAME_walk21, FRAME.FRAME_walk25, tank_frames_stop_walk, tank_stand);

function tank_walk(self: EdictT): void {
  self.monsterinfo.currentmove = tank_move_walk;
}

//
// run
//

const tank_frames_start_run: MframeT[] = [
  mkframe(ai_run, 0),
  mkframe(ai_run, 6),
  mkframe(ai_run, 6),
  mkframe(ai_run, 11, tank_footstep),
];
const tank_move_start_run = mkmove(FRAME.FRAME_walk01, FRAME.FRAME_walk04, tank_frames_start_run, tank_run);

const tank_frames_run: MframeT[] = [
  mkframe(ai_run, 4),
  mkframe(ai_run, 5),
  mkframe(ai_run, 3),
  mkframe(ai_run, 2),
  mkframe(ai_run, 5),
  mkframe(ai_run, 5),
  mkframe(ai_run, 4),
  mkframe(ai_run, 4, tank_footstep),
  mkframe(ai_run, 3),
  mkframe(ai_run, 5),
  mkframe(ai_run, 4),
  mkframe(ai_run, 5),
  mkframe(ai_run, 7),
  mkframe(ai_run, 7),
  mkframe(ai_run, 6),
  mkframe(ai_run, 6, tank_footstep),
];
const tank_move_run = mkmove(FRAME.FRAME_walk05, FRAME.FRAME_walk20, tank_frames_run);

const tank_frames_stop_run: MframeT[] = [
  mkframe(ai_run, 3),
  mkframe(ai_run, 3),
  mkframe(ai_run, 2),
  mkframe(ai_run, 2),
  mkframe(ai_run, 4, tank_footstep),
];
const tank_move_stop_run = mkmove(FRAME.FRAME_walk21, FRAME.FRAME_walk25, tank_frames_stop_run, tank_walk);

function tank_run(self: EdictT): void {
  if (self.enemy && self.enemy.client) self.monsterinfo.aiflags |= AI_BRUTAL;
  else self.monsterinfo.aiflags &= ~AI_BRUTAL;

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    self.monsterinfo.currentmove = tank_move_stand;
    return;
  }

  if (self.monsterinfo.currentmove === tank_move_walk || self.monsterinfo.currentmove === tank_move_start_run) {
    self.monsterinfo.currentmove = tank_move_run;
  } else {
    self.monsterinfo.currentmove = tank_move_start_run;
  }
}

//
// pain
//

const tank_frames_pain1: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0)];
const tank_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain104, tank_frames_pain1, tank_run);

const tank_frames_pain2: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const tank_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain205, tank_frames_pain2, tank_run);

const tank_frames_pain3: MframeT[] = [
  mkframe(ai_move, -7),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, tank_footstep),
];
const tank_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain316, tank_frames_pain3, tank_run);

function tank_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;

  if (damage <= 10) return;

  if (level.time < self.pain_debounce_time) return;

  if (damage <= 30) {
    if (random() > 0.2) return;
  }

  const skill = cvarNum(gameCvars.skill);
  // If hard or nightmare, don't go into pain while attacking
  if (skill >= 2) {
    if (self.s.frame >= FRAME.FRAME_attak301 && self.s.frame <= FRAME.FRAME_attak330) return;
    if (self.s.frame >= FRAME.FRAME_attak101 && self.s.frame <= FRAME.FRAME_attak116) return;
  }

  self.pain_debounce_time = level.time + 3;
  gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (skill === 3) return; // no pain anims in nightmare

  if (damage <= 30) self.monsterinfo.currentmove = tank_move_pain1;
  else if (damage <= 60) self.monsterinfo.currentmove = tank_move_pain2;
  else self.monsterinfo.currentmove = tank_move_pain3;
}

//
// attacks
//

function TankBlaster(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const end = vec3();
  const dir = vec3();
  let flash_number: number;

  if (self.s.frame === FRAME.FRAME_attak110) flash_number = MZ2_TANK_BLASTER_1;
  else if (self.s.frame === FRAME.FRAME_attak113) flash_number = MZ2_TANK_BLASTER_2;
  else flash_number = MZ2_TANK_BLASTER_3;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  monster_fire_blaster(self, start, dir, 30, 800, flash_number, EF_BLASTER);
}

function TankStrike(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_strike, 1, ATTN_NORM, 0);
}

function TankRocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();
  let flash_number: number;

  if (self.s.frame === FRAME.FRAME_attak324) flash_number = MZ2_TANK_ROCKET_1;
  else if (self.s.frame === FRAME.FRAME_attak327) flash_number = MZ2_TANK_ROCKET_2;
  else flash_number = MZ2_TANK_ROCKET_3;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);

  monster_fire_rocket(self, start, dir, 50, 550, flash_number);
}

function TankMachineGun(self: EdictT): void {
  const dir = vec3();
  const vec = vec3();
  const start = vec3();
  const forward = vec3();
  const right = vec3();

  const flash_number = MZ2_TANK_MACHINEGUN_1 + (self.s.frame - FRAME.FRAME_attak406);

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  if (self.enemy) {
    VectorCopy(self.enemy.s.origin, vec);
    vec[2] += self.enemy.viewheight;
    VectorSubtract(vec, start, vec);
    vectoangles(vec, vec);
    dir[0] = vec[0];
  } else {
    dir[0] = 0;
  }
  if (self.s.frame <= FRAME.FRAME_attak415) dir[1] = self.s.angles[1] - 8 * (self.s.frame - FRAME.FRAME_attak411);
  else dir[1] = self.s.angles[1] + 8 * (self.s.frame - FRAME.FRAME_attak419);
  dir[2] = 0;

  AngleVectors(dir, forward, null, null);

  monster_fire_bullet(self, start, forward, 20, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_number);
}

const tank_frames_attack_blast: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankBlaster), // 10
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankBlaster),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankBlaster), // 16
];
const tank_move_attack_blast = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak116, tank_frames_attack_blast, tank_reattack_blaster);

const tank_frames_reattack_blast: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankBlaster),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankBlaster), // 16
];
const tank_move_reattack_blast = mkmove(FRAME.FRAME_attak111, FRAME.FRAME_attak116, tank_frames_reattack_blast, tank_reattack_blaster);

const tank_frames_attack_post_blast: MframeT[] = [
  mkframe(ai_move, 0), // 17
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
  mkframe(ai_move, -2, tank_footstep), // 22
];
const tank_move_attack_post_blast = mkmove(FRAME.FRAME_attak117, FRAME.FRAME_attak122, tank_frames_attack_post_blast, tank_run);

function tank_reattack_blaster(self: EdictT): void {
  if (cvarNum(gameCvars.skill) >= 2 && self.enemy !== null) {
    if (visible(self, self.enemy)) {
      if (self.enemy.health > 0) {
        if (random() <= 0.6) {
          self.monsterinfo.currentmove = tank_move_reattack_blast;
          return;
        }
      }
    }
  }
  self.monsterinfo.currentmove = tank_move_attack_post_blast;
}

function tank_poststrike(self: EdictT): void {
  self.enemy = null;
  tank_run(self);
}

const tank_frames_attack_strike: MframeT[] = [
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 6),
  mkframe(ai_move, 7),
  mkframe(ai_move, 9, tank_footstep),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 2, tank_footstep),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0, tank_windup),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, TankStrike),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -3),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -2),
  mkframe(ai_move, -3),
  mkframe(ai_move, -2, tank_footstep),
];
const tank_move_attack_strike = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak238, tank_frames_attack_strike, tank_poststrike);

const tank_frames_attack_pre_rocket: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0), // 10
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 7),
  mkframe(ai_charge, 7),
  mkframe(ai_charge, 7, tank_footstep),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0), // 20
  mkframe(ai_charge, -3),
];
const tank_move_attack_pre_rocket = mkmove(FRAME.FRAME_attak301, FRAME.FRAME_attak321, tank_frames_attack_pre_rocket, tank_doattack_rocket);

const tank_frames_attack_fire_rocket: MframeT[] = [
  mkframe(ai_charge, -3), // Loop Start 22
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankRocket), // 24
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, TankRocket),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -1, TankRocket), // 30 Loop End
];
const tank_move_attack_fire_rocket = mkmove(FRAME.FRAME_attak322, FRAME.FRAME_attak330, tank_frames_attack_fire_rocket, tank_refire_rocket);

const tank_frames_attack_post_rocket: MframeT[] = [
  mkframe(ai_charge, 0), // 31
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0), // 40
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -9),
  mkframe(ai_charge, -8),
  mkframe(ai_charge, -7),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -1, tank_footstep),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0), // 50
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const tank_move_attack_post_rocket = mkmove(FRAME.FRAME_attak331, FRAME.FRAME_attak353, tank_frames_attack_post_rocket, tank_run);

const tank_frames_attack_chain: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(null, 0, TankMachineGun),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const tank_move_attack_chain = mkmove(FRAME.FRAME_attak401, FRAME.FRAME_attak429, tank_frames_attack_chain, tank_run);

function tank_refire_rocket(self: EdictT): void {
  // Only on hard or nightmare
  if (cvarNum(gameCvars.skill) >= 2 && self.enemy !== null) {
    if (self.enemy.health > 0) {
      if (visible(self, self.enemy)) {
        if (random() <= 0.4) {
          self.monsterinfo.currentmove = tank_move_attack_fire_rocket;
          return;
        }
      }
    }
  }
  self.monsterinfo.currentmove = tank_move_attack_post_rocket;
}

function tank_doattack_rocket(self: EdictT): void {
  self.monsterinfo.currentmove = tank_move_attack_fire_rocket;
}

function tank_attack(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  if (self.enemy.health < 0) {
    self.monsterinfo.currentmove = tank_move_attack_strike;
    self.monsterinfo.aiflags &= ~AI_BRUTAL;
    return;
  }

  const vec = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, vec);
  const range = VectorLength(vec);

  const r = random();

  if (range <= 125) {
    if (r < 0.4) self.monsterinfo.currentmove = tank_move_attack_chain;
    else self.monsterinfo.currentmove = tank_move_attack_blast;
  } else if (range <= 250) {
    if (r < 0.5) self.monsterinfo.currentmove = tank_move_attack_chain;
    else self.monsterinfo.currentmove = tank_move_attack_blast;
  } else {
    if (r < 0.33) self.monsterinfo.currentmove = tank_move_attack_chain;
    else if (r < 0.66) {
      self.monsterinfo.currentmove = tank_move_attack_pre_rocket;
      self.pain_debounce_time = level.time + 5.0; // no pain for a while
    } else self.monsterinfo.currentmove = tank_move_attack_blast;
  }
}

//
// death
//

function tank_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -16);
  VectorSet(self.maxs, 16, 16, -0);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const tank_frames_death1: MframeT[] = [
  mkframe(ai_move, -7),
  mkframe(ai_move, -2),
  mkframe(ai_move, -2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 6),
  mkframe(ai_move, 1),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -3),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -4),
  mkframe(ai_move, -6),
  mkframe(ai_move, -4),
  mkframe(ai_move, -5),
  mkframe(ai_move, -7),
  mkframe(ai_move, -15, tank_thud),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const tank_move_death = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death132, tank_frames_death1, tank_dead);

function tank_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 1 /*4*/; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_metal/tris.md2", damage, GIB_METALLIC);
    ThrowGib(self, "models/objects/gibs/chest/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/gear/tris.md2", damage, GIB_METALLIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  self.monsterinfo.currentmove = tank_move_death;
}

//
// monster_tank
//

/*QUAKED monster_tank (1 .5 0) (-32 -32 -16) (32 32 72) Ambush Trigger_Spawn Sight
*/
/*QUAKED monster_tank_commander (1 .5 0) (-32 -32 -16) (32 32 72) Ambush Trigger_Spawn Sight
*/
// Spawned under two classnames in g_spawn.c's spawn table ("monster_tank"
// and "monster_tank_commander"), both mapped to this same function.
export function SP_monster_tank(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.s.modelindex = gi.modelindex("models/monsters/tank/tris.md2");
  VectorSet(self.mins, -32, -32, -16);
  VectorSet(self.maxs, 32, 32, 72);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  sound_pain = gi.soundindex("tank/tnkpain2.wav");
  sound_thud = gi.soundindex("tank/tnkdeth2.wav");
  sound_idle = gi.soundindex("tank/tnkidle1.wav");
  sound_die = gi.soundindex("tank/death.wav");
  sound_step = gi.soundindex("tank/step.wav");
  sound_windup = gi.soundindex("tank/tnkatck4.wav");
  sound_strike = gi.soundindex("tank/tnkatck5.wav");
  sound_sight = gi.soundindex("tank/sight1.wav");

  gi.soundindex("tank/tnkatck1.wav");
  gi.soundindex("tank/tnkatk2a.wav");
  gi.soundindex("tank/tnkatk2b.wav");
  gi.soundindex("tank/tnkatk2c.wav");
  gi.soundindex("tank/tnkatk2d.wav");
  gi.soundindex("tank/tnkatk2e.wav");
  gi.soundindex("tank/tnkatck3.wav");

  if (self.classname === "monster_tank_commander") {
    self.health = 1000;
    self.gib_health = -225;
  } else {
    self.health = 750;
    self.gib_health = -200;
  }

  self.mass = 500;

  self.pain = tank_pain;
  self.die = tank_die;
  self.monsterinfo.stand = tank_stand;
  self.monsterinfo.walk = tank_walk;
  self.monsterinfo.run = tank_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = tank_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = tank_sight;
  self.monsterinfo.idle = tank_idle;

  gi.linkentity(self);

  self.monsterinfo.currentmove = tank_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);

  if (self.classname === "monster_tank_commander") self.s.skinnum = 2;
}

// =========================================================================
// RERELEASE CONTENT PORT -- monster_tank_stand (m_tank.cpp:1119-1164)
//
// PURELY ADDITIVE. Nothing above this line is touched: every vanilla 3.21
// tank / tank_commander behavior is byte-identical to what it was before.
//
// An N64-edition decorative easter egg: a scaled-up tank that just stands
// and cycles its stand animation in place until it is targeted, then
// teleports away. Translated from src/kexgame/m_tank.ts's own
// SP_monster_tank_stand / Think_TankStand (itself the port of the 2023
// re-release's m_tank.cpp:1119-1164).
//
// TRANSLATION NOTES (kexgame -> classic)
// - Gtime_add(level.time, Gtime_from_hz(10)) -> level.time + FRAMETIME (0.1s
//   is one server frame, i.e. exactly 10 Hz).
// - Use_Boss3 (m_boss3.cpp) is assigned as this entity's `use` in the C++.
//   The classic m_boss3.ts has that function but does NOT export it (it is
//   module-private there and already registered under "m_boss3:Use_Boss3"),
//   and m_boss3.ts is not owned by this unit, so the identical body is
//   duplicated here as `Use_TankStand` -- the established
//   "duplicated per-file, not imported" convention for un-exported helpers.
//   Registered under a distinct save name so it cannot collide with
//   m_boss3.ts's own registration.
//
// DOCUMENTED DEGRADATION (protocol 34): the re-release authors this entity
// at `self.s.scale = 1.5`. Protocol 34 -- the protocol the classic ruleset
// speaks -- has no per-entity scale field, so nothing about s.scale reaches
// the client and the model DRAWS at its native size. The value is still set
// faithfully and is still what sizes the bounding box below (mins/maxs are
// multiplied by it exactly as in the C++), so all server-side collision,
// blocking and trace behavior is correct; only the rendered size differs.
// The re-release's `if (!self.s.scale)` guard is preserved, so a map that
// sets its own scale key still wins.
// =========================================================================

/**
 * m_boss3.cpp `Use_Boss3` -- duplicated locally, see the block comment above.
 */
function Use_TankStand(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_BOSSTPORT);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  G_FreeEdict(ent);
}

function Think_TankStand(ent: EdictT): void {
  if (ent.s.frame === FRAME.FRAME_stand30) ent.s.frame = FRAME.FRAME_stand01;
  else ent.s.frame++;
  ent.nextthink = level.time + FRAMETIME;
}

/*QUAKED monster_tank_stand (1 .5 0) (-32 -32 0) (32 32 90)

Just stands and cycles in one place until targeted, then teleports away.
N64 edition!
*/
export function SP_monster_tank_stand(self: EdictT): void {
  // kexgame's M_AllowSpawn: refuse in deathmatch unless ai_allow_dm_spawn is
  // set. (m_boss3.ts's SP_monster_boss3_stand -- this entity's vanilla
  // sibling -- uses the bare `deathmatch` check; the re-release routes every
  // monster spawn through M_AllowSpawn instead, so that is what is ported.)
  const ai_allow_dm_spawn = gi.cvar("ai_allow_dm_spawn", "0", 0);
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(ai_allow_dm_spawn) === 0) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.model = "models/monsters/tank/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  self.s.frame = FRAME.FRAME_stand01;
  self.s.skinnum = 2;

  gi.soundindex("misc/bigtele.wav");

  VectorSet(self.mins, -32, -32, -16);
  VectorSet(self.maxs, 32, 32, 64);

  // s.scale is stored and drives the bbox below; protocol 34 cannot carry it
  // to the client, so the model renders unscaled. See the block comment.
  if (!self.s.scale) self.s.scale = 1.5;

  VectorScale(self.mins, self.s.scale, self.mins);
  VectorScale(self.maxs, self.s.scale, self.maxs);

  self.use = Use_TankStand;
  self.think = Think_TankStand;
  self.nextthink = level.time + FRAMETIME;
  gi.linkentity(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_tank:tank_pain", tank_pain);
registerSaveFunction("m_tank:tank_die", tank_die);
registerSaveFunction("m_tank:tank_stand", tank_stand);
registerSaveFunction("m_tank:tank_walk", tank_walk);
registerSaveFunction("m_tank:tank_run", tank_run);
registerSaveFunction("m_tank:tank_attack", tank_attack);
registerSaveFunction("m_tank:tank_sight", tank_sight);
registerSaveFunction("m_tank:tank_idle", tank_idle);
registerSaveMmove("m_tank:tank_move_start_walk", tank_move_start_walk);
registerSaveMmove("m_tank:tank_move_walk", tank_move_walk);
registerSaveMmove("m_tank:tank_move_stop_walk", tank_move_stop_walk);
registerSaveMmove("m_tank:tank_move_start_run", tank_move_start_run);
registerSaveMmove("m_tank:tank_move_run", tank_move_run);
registerSaveMmove("m_tank:tank_move_stop_run", tank_move_stop_run);
registerSaveMmove("m_tank:tank_move_pain1", tank_move_pain1);
registerSaveMmove("m_tank:tank_move_pain2", tank_move_pain2);
registerSaveMmove("m_tank:tank_move_pain3", tank_move_pain3);
registerSaveMmove("m_tank:tank_move_attack_blast", tank_move_attack_blast);
registerSaveMmove("m_tank:tank_move_reattack_blast", tank_move_reattack_blast);
registerSaveMmove("m_tank:tank_move_attack_post_blast", tank_move_attack_post_blast);
registerSaveMmove("m_tank:tank_move_attack_strike", tank_move_attack_strike);
registerSaveMmove("m_tank:tank_move_attack_pre_rocket", tank_move_attack_pre_rocket);
registerSaveMmove("m_tank:tank_move_attack_fire_rocket", tank_move_attack_fire_rocket);
registerSaveMmove("m_tank:tank_move_attack_post_rocket", tank_move_attack_post_rocket);
registerSaveMmove("m_tank:tank_move_attack_chain", tank_move_attack_chain);
registerSaveMmove("m_tank:tank_move_death", tank_move_death);
registerSaveMmove("m_tank:tank_move_stand", tank_move_stand);
registerSaveFunction("m_tank:Use_TankStand", Use_TankStand);
registerSaveFunction("m_tank:Think_TankStand", Think_TankStand);
