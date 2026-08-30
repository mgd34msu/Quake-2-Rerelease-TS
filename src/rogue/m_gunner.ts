/*
Copyright (C) 1997-2001 Id Software, Inc.
*/
/*
==============================================================================

GUNNER

rogue/m_gunner.c vs baseq2/m_gunner.c: the pack rewires the gunner's dodge/
duck/jump AI onto the new shared g_newai.ts helpers (M_MonsterDodge,
monster_duck_down/hold/up, monster_jump_start/finished, blocked_checkshot/
checkplat/checkjump) and monster_done_dodge from g_monster.ts, adds a
gunner_blocked callback so the gunner can jump over low obstacles, adds
blindfire support (gunner_grenade_check/gunner_blind_check, AS_BLIND handling
in gunner_attack, monsterinfo.blindfire = true), and reworks GunnerGrenade to
aim (pitch/spread) at a blind-fire target when manually steered. The original
gunner_dodge function is left as dead, fully commented-out C source in rogue/
m_gunner.c as dead, fully commented-out C source -- dropped here per
PORTING.md's "#if 0 blocks are dropped silently" rule; monsterinfo.dodge is
wired directly to the imported M_MonsterDodge instead.

==============================================================================
*/

import {
  AngleVectors,
  random,
  VectorCompare,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorSet,
  VectorSubtract,
  vec3,
  vec3_origin,
  type Vec3,
} from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_VOICE,
  MASK_SHOT,
  MZ2_GUNNER_GRENADE_1,
  MZ2_GUNNER_GRENADE_2,
  MZ2_GUNNER_GRENADE_3,
  MZ2_GUNNER_GRENADE_4,
  MZ2_GUNNER_MACHINEGUN_1,
} from "../shared/q_shared";
import {
  AI_DODGING,
  AI_DUCKED,
  AI_MANUAL_STEERING,
  AI_STAND_GROUND,
  AS_BLIND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_MELEE,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range, visible } from "./g_ai";
import { monster_done_dodge, monster_fire_bullet, monster_fire_grenade, walkmonster_start } from "./g_monster";
import {
  blocked_checkjump,
  blocked_checkplat,
  blocked_checkshot,
  M_MonsterDodge,
  monster_duck_hold,
  monster_duck_up,
  monster_jump_finished,
  monster_jump_start,
} from "./g_newai";
import { G_FreeEdict, G_ProjectSource, vectoyaw } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_gunner_frames";

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD (each monster/weapon module
// that fires bullets keeps its own module-local copy; not centralized).
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

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

let sound_pain = 0;
let sound_pain2 = 0;
let sound_death = 0;
let sound_idle = 0;
let sound_open = 0;
let sound_search = 0;
let sound_sight = 0;

function gunner_idlesound(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function gunner_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function gunner_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

//
// stand / fidget
//

const gunner_frames_fidget: MframeT[] = [
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, gunner_idlesound),
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
// C declares this move over FRAME_stand31..FRAME_stand70 (40 frames) but the
// frame array above has 49 rows; the engine only ever reads the first
// (lastframe - firstframe + 1) entries, so the trailing 9 rows are inert in
// the original game too. Transcribed in full for a faithful port.
const gunner_move_fidget = mkmove(FRAME.FRAME_stand31, FRAME.FRAME_stand70, gunner_frames_fidget, gunner_stand, true);

function gunner_fidget(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) return;
  if (random() <= 0.05) self.monsterinfo.currentmove = gunner_move_fidget;
}

const gunner_frames_stand: MframeT[] = [
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, gunner_fidget),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, gunner_fidget),

  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0, gunner_fidget),
];
const gunner_move_stand = mkmove(FRAME.FRAME_stand01, FRAME.FRAME_stand30, gunner_frames_stand, null);

function gunner_stand(self: EdictT): void {
  self.monsterinfo.currentmove = gunner_move_stand;
}

//
// walk
//

const gunner_frames_walk: MframeT[] = [
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 4),
];
const gunner_move_walk = mkmove(FRAME.FRAME_walk07, FRAME.FRAME_walk19, gunner_frames_walk, null);

function gunner_walk(self: EdictT): void {
  self.monsterinfo.currentmove = gunner_move_walk;
}

//
// run
//

const gunner_frames_run: MframeT[] = [
  mkframe(ai_run, 26),
  mkframe(ai_run, 9),
  mkframe(ai_run, 9),
  // ROGUE: this frame's thinkfunc gains monster_done_dodge (rogue/m_gunner.c:185)
  mkframe(ai_run, 9, monster_done_dodge),
  mkframe(ai_run, 15),
  mkframe(ai_run, 10),
  mkframe(ai_run, 13),
  mkframe(ai_run, 6),
];
const gunner_move_run = mkmove(FRAME.FRAME_run01, FRAME.FRAME_run08, gunner_frames_run, null);

function gunner_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = gunner_move_stand;
  else self.monsterinfo.currentmove = gunner_move_run;
}

const gunner_frames_runandshoot: MframeT[] = [
  mkframe(ai_run, 32),
  mkframe(ai_run, 15),
  mkframe(ai_run, 10),
  mkframe(ai_run, 18),
  mkframe(ai_run, 8),
  mkframe(ai_run, 20),
];
const gunner_move_runandshoot = mkmove(FRAME.FRAME_runs01, FRAME.FRAME_runs06, gunner_frames_runandshoot, null);

// Unused in the original game: no monsterinfo hook ever assigns
// gunner_runandshoot, so this move is dead code in id's source too.
function gunner_runandshoot(self: EdictT): void {
  self.monsterinfo.currentmove = gunner_move_runandshoot;
}

//
// pain
//

const gunner_frames_pain3: MframeT[] = [mkframe(ai_move, -3), mkframe(ai_move, 1), mkframe(ai_move, 1), mkframe(ai_move, 0), mkframe(ai_move, 1)];
const gunner_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain305, gunner_frames_pain3, gunner_run);

const gunner_frames_pain2: MframeT[] = [
  mkframe(ai_move, -2),
  mkframe(ai_move, 11),
  mkframe(ai_move, 6),
  mkframe(ai_move, 2),
  mkframe(ai_move, -1),
  mkframe(ai_move, -7),
  mkframe(ai_move, -2),
  mkframe(ai_move, -7),
];
const gunner_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain208, gunner_frames_pain2, gunner_run);

const gunner_frames_pain1: MframeT[] = [
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, -5),
  mkframe(ai_move, 3),
  mkframe(ai_move, -1),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const gunner_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain118, gunner_frames_pain1, gunner_run);

function gunner_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  // ROGUE
  monster_done_dodge(self);

  if (self.groundentity === null) {
    return;
  }
  // ROGUE

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  // C: rand()&1 -> Math.floor(Math.random()*2)&1 per house style (g_misc.ts,
  // m_move.ts already establish this mapping for raw rand() calls).
  if ((Math.floor(Math.random() * 2) & 1) !== 0) gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (damage <= 10) self.monsterinfo.currentmove = gunner_move_pain3;
  else if (damage <= 25) self.monsterinfo.currentmove = gunner_move_pain2;
  else self.monsterinfo.currentmove = gunner_move_pain1;

  // ROGUE
  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;

  // PMM - clear duck flag
  if (self.monsterinfo.aiflags & AI_DUCKED) monster_duck_up(self);
  // ROGUE
}

//
// death
//

function gunner_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const gunner_frames_death: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -7),
  mkframe(ai_move, -3),
  mkframe(ai_move, -5),
  mkframe(ai_move, 8),
  mkframe(ai_move, 6),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const gunner_move_death = mkmove(FRAME.FRAME_death01, FRAME.FRAME_death11, gunner_frames_death, gunner_dead);

function gunner_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
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
  self.monsterinfo.currentmove = gunner_move_death;
}

//
// duck
//
// PMM - changed to duck code for new dodge; this is specific to the gunner,
// leave it be -- monster_duck_hold/monster_duck_up (g_newai.ts) replace the
// old local gunner_duck_hold/gunner_duck_up.
//

function gunner_duck_down(self: EdictT): void {
  self.monsterinfo.aiflags |= AI_DUCKED;
  if (cvarNum(gameCvars.skill) >= 2) {
    if (random() > 0.5) GunnerGrenade(self);
  }

  self.maxs[2] = self.monsterinfo.base_height - 32;
  self.takedamage = DamageT.DAMAGE_YES;
  if (self.monsterinfo.duck_wait_time < level.time) self.monsterinfo.duck_wait_time = level.time + 1;
  gi.linkentity(self);
}

const gunner_frames_duck: MframeT[] = [
  mkframe(ai_move, 1, gunner_duck_down),
  mkframe(ai_move, 1),
  mkframe(ai_move, 1, monster_duck_hold),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, 0, monster_duck_up),
  mkframe(ai_move, -1),
];
const gunner_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck08, gunner_frames_duck, gunner_run);

// ROGUE: the old gunner_dodge (random() > 0.25 duck-in-place check) is left
// as dead, fully-commented-out C source in rogue/m_gunner.c -- dropped per
// PORTING.md's "#if 0 blocks are dropped silently" rule. monsterinfo.dodge
// is wired directly to M_MonsterDodge (g_newai.ts) in SP_monster_gunner
// instead of a per-monster wrapper.

//
// attacks
//

function gunner_opengun(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_open, 1, ATTN_IDLE, 0);
}

function GunnerFire(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const aim = vec3();

  // ROGUE
  if (self.enemy === null || !self.enemy.inuse) return;
  // ROGUE

  const flash_number = MZ2_GUNNER_MACHINEGUN_1 + (self.s.frame - FRAME.FRAME_attak216);

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  // project enemy back a bit and target there
  VectorCopy(self.enemy.s.origin, target);
  VectorMA(target, -0.2, self.enemy.velocity, target);
  target[2] += self.enemy.viewheight;

  VectorSubtract(target, start, aim);
  VectorNormalize(aim);
  monster_fire_bullet(self, start, aim, 3, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_number);
}

// ROGUE
function gunner_grenade_check(self: EdictT): boolean {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const dir = vec3();

  if (self.enemy === null) return false;

  // if the player is above my head, use machinegun.

  // check for flag telling us that we're blindfiring
  if (self.monsterinfo.aiflags & AI_MANUAL_STEERING) {
    if (self.s.origin[2] + self.viewheight < self.monsterinfo.blind_fire_target[2]) {
      return false;
    }
  } else if (self.absmax[2] <= self.enemy.absmin[2]) {
    return false;
  }

  // check to see that we can trace to the player before we start
  // tossing grenades around.
  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_GUNNER_GRENADE_1], forward, right, start);

  // pmm - check for blindfire flag
  if (self.monsterinfo.aiflags & AI_MANUAL_STEERING) VectorCopy(self.monsterinfo.blind_fire_target, target);
  else VectorCopy(self.enemy.s.origin, target);

  // see if we're too close
  VectorSubtract(self.s.origin, target, dir);

  if (VectorLength(dir) < 100) return false;

  const tr = gi.trace(start, vec3_origin, vec3_origin, target, self, MASK_SHOT);
  if (tr.ent === self.enemy || tr.fraction === 1) return true;

  return false;
}
// ROGUE

function GunnerGrenade(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const aim = vec3();
  let flash_number: number;
  let spread: number;
  // ROGUE: `pitch` is only ever read inside the `if (self->enemy)` block
  // below, which always runs (self.enemy is already known non-null from the
  // early-return guard) -- `let pitch = 0` supplies TS's required initial
  // value without changing behavior.
  let pitch = 0;
  const target = vec3();
  // ROGUE: C declares `qboolean blindfire;` uninitialized and only assigns
  // it true when AI_MANUAL_STEERING is set -- reading it uninitialized in
  // the other branch is a latent id/Rogue bug. Initialized to false here
  // (the deterministic value the flag represents when not manually
  // steered) instead of replicating undefined stack-garbage behavior.
  let blindfire = false;

  if (self.enemy === null || !self.enemy.inuse) return;

  if (self.monsterinfo.aiflags & AI_MANUAL_STEERING) blindfire = true;

  if (self.s.frame === FRAME.FRAME_attak105) {
    spread = 0.02;
    flash_number = MZ2_GUNNER_GRENADE_1;
  } else if (self.s.frame === FRAME.FRAME_attak108) {
    spread = 0.05;
    flash_number = MZ2_GUNNER_GRENADE_2;
  } else if (self.s.frame === FRAME.FRAME_attak111) {
    spread = 0.08;
    flash_number = MZ2_GUNNER_GRENADE_3;
  } else {
    // (self.s.frame === FRAME_attak114)
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    spread = 0.11;
    flash_number = MZ2_GUNNER_GRENADE_4;
  }

  // pmm
  // if we're shooting blind and we still can't see our enemy
  if (blindfire && !visible(self, self.enemy)) {
    // and we have a valid blind_fire_target
    if (VectorCompare(self.monsterinfo.blind_fire_target, vec3_origin) !== 0) return;

    VectorCopy(self.monsterinfo.blind_fire_target, target);
  } else VectorCopy(self.s.origin, target);
  // pmm

  AngleVectors(self.s.angles, forward, right, up); //PGM
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  //PGM
  if (self.enemy !== null) {
    VectorSubtract(target, self.s.origin, aim);
    const dist = VectorLength(aim);

    // aim up if they're on the same level as me and far away.
    if (dist > 512 && aim[2] < 64 && aim[2] > -64) {
      aim[2] += dist - 512;
    }

    VectorNormalize(aim);
    pitch = aim[2];
    if (pitch > 0.4) {
      pitch = 0.4;
    } else if (pitch < -0.5) pitch = -0.5;
  }
  //PGM

  //FIXME : do a spread -225 -75 75 225 degrees around forward
  VectorMA(forward, spread, right, aim);
  VectorMA(aim, pitch, up, aim);

  monster_fire_grenade(self, start, aim, 50, 600, flash_number);
}

// C declares this array as 8 rows of ai_charge,0,NULL preceded by a
// commented-out block of 8 more ai_charge,0,NULL rows (dead source, never
// compiled). Only the live 7-row tail is ported: it matches this move's own
// FRAME_attak209..FRAME_attak215 span (7 frames) exactly.
const gunner_frames_attack_chain: MframeT[] = [
  mkframe(ai_charge, 0, gunner_opengun),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const gunner_move_attack_chain = mkmove(FRAME.FRAME_attak209, FRAME.FRAME_attak215, gunner_frames_attack_chain, gunner_fire_chain);

const gunner_frames_fire_chain: MframeT[] = [
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
  mkframe(ai_charge, 0, GunnerFire),
];
const gunner_move_fire_chain = mkmove(FRAME.FRAME_attak216, FRAME.FRAME_attak223, gunner_frames_fire_chain, gunner_refire_chain);

const gunner_frames_endfire_chain: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const gunner_move_endfire_chain = mkmove(FRAME.FRAME_attak224, FRAME.FRAME_attak230, gunner_frames_endfire_chain, gunner_run);

// ROGUE
function gunner_blind_check(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_MANUAL_STEERING) {
    const aim = vec3();
    VectorSubtract(self.monsterinfo.blind_fire_target, self.s.origin, aim);
    self.ideal_yaw = vectoyaw(aim);
  }
}
// ROGUE

const gunner_frames_attack_grenade: MframeT[] = [
  mkframe(ai_charge, 0, gunner_blind_check),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, GunnerGrenade),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, GunnerGrenade),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, GunnerGrenade),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, GunnerGrenade),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
];
const gunner_move_attack_grenade = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak121, gunner_frames_attack_grenade, gunner_run);

function gunner_attack(self: EdictT): void {
  // ROGUE
  monster_done_dodge(self);

  // PMM
  if (self.monsterinfo.attack_state === AS_BLIND) {
    // setup shot probabilities
    let chance: number;
    if (self.monsterinfo.blind_fire_delay < 1.0) chance = 1.0;
    else if (self.monsterinfo.blind_fire_delay < 7.5) chance = 0.4;
    else chance = 0.1;

    const r = random();

    // minimum of 2 seconds, plus 0-3, after the shots are done
    self.monsterinfo.blind_fire_delay += 2.1 + 2.0 + random() * 3.0;

    // don't shoot at the origin
    if (VectorCompare(self.monsterinfo.blind_fire_target, vec3_origin) !== 0) return;

    // don't shoot if the dice say not to
    if (r > chance) {
      return;
    }

    // turn on manual steering to signal both manual steering and blindfire
    self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
    if (gunner_grenade_check(self)) {
      // if the check passes, go for the attack
      self.monsterinfo.currentmove = gunner_move_attack_grenade;
      self.monsterinfo.attack_finished = level.time + 2 * random();
    }

    // turn off blindfire flag
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    return;
  }
  // pmm

  if (self.enemy === null) return; // C assumes self->enemy is set here

  // PGM - gunner needs to use his chaingun if he's being attacked by a tesla.
  if (range(self, self.enemy) === RANGE_MELEE || self.bad_area !== null) {
    self.monsterinfo.currentmove = gunner_move_attack_chain;
  } else {
    if (random() <= 0.5 && gunner_grenade_check(self)) self.monsterinfo.currentmove = gunner_move_attack_grenade;
    else self.monsterinfo.currentmove = gunner_move_attack_chain;
  }
  // ROGUE
}

function gunner_fire_chain(self: EdictT): void {
  self.monsterinfo.currentmove = gunner_move_fire_chain;
}

function gunner_refire_chain(self: EdictT): void {
  if (self.enemy !== null) {
    if (self.enemy.health > 0) {
      if (visible(self, self.enemy)) {
        if (random() <= 0.5) {
          self.monsterinfo.currentmove = gunner_move_fire_chain;
          return;
        }
      }
    }
  }
  self.monsterinfo.currentmove = gunner_move_endfire_chain;
}

// ROGUE
function gunner_jump_now(self: EdictT): void {
  const forward = vec3();
  const up = vec3();

  monster_jump_start(self);

  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 100, forward, self.velocity);
  VectorMA(self.velocity, 300, up, self.velocity);
}

function gunner_jump2_now(self: EdictT): void {
  const forward = vec3();
  const up = vec3();

  monster_jump_start(self);

  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 150, forward, self.velocity);
  VectorMA(self.velocity, 400, up, self.velocity);
}

function gunner_jump_wait_land(self: EdictT): void {
  if (self.groundentity === null) {
    self.monsterinfo.nextframe = self.s.frame;

    if (monster_jump_finished(self)) self.monsterinfo.nextframe = self.s.frame + 1;
  } else self.monsterinfo.nextframe = self.s.frame + 1;
}

const gunner_frames_jump: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, gunner_jump_now),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, gunner_jump_wait_land),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const gunner_move_jump = mkmove(FRAME.FRAME_jump01, FRAME.FRAME_jump10, gunner_frames_jump, gunner_run);

const gunner_frames_jump2: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, -4),
  mkframe(ai_move, -4),
  mkframe(ai_move, 0, gunner_jump_now),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, gunner_jump_wait_land),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const gunner_move_jump2 = mkmove(FRAME.FRAME_jump01, FRAME.FRAME_jump10, gunner_frames_jump2, gunner_run);

function gunner_jump(self: EdictT): void {
  if (self.enemy === null) return;

  monster_done_dodge(self);

  if (self.enemy.s.origin[2] > self.s.origin[2]) self.monsterinfo.currentmove = gunner_move_jump2;
  else self.monsterinfo.currentmove = gunner_move_jump;
}

//===========
//PGM
function gunner_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  if (blocked_checkplat(self, dist)) return true;

  if (blocked_checkjump(self, dist, 192, 40)) {
    gunner_jump(self);
    return true;
  }

  return false;
}
//PGM
//===========

// PMM - new duck code
function gunner_duck(self: EdictT, eta: number): void {
  if (self.monsterinfo.currentmove === gunner_move_jump2 || self.monsterinfo.currentmove === gunner_move_jump) {
    return;
  }

  if (
    self.monsterinfo.currentmove === gunner_move_attack_chain ||
    self.monsterinfo.currentmove === gunner_move_fire_chain ||
    self.monsterinfo.currentmove === gunner_move_attack_grenade
  ) {
    // if we're shooting, and not on easy, don't dodge
    if (cvarNum(gameCvars.skill) !== 0) {
      self.monsterinfo.aiflags &= ~AI_DUCKED;
      return;
    }
  }

  if (cvarNum(gameCvars.skill) === 0)
    // PMM - stupid dodge
    self.monsterinfo.duck_wait_time = level.time + eta + 1;
  else self.monsterinfo.duck_wait_time = level.time + eta + 0.1 * (3 - cvarNum(gameCvars.skill));

  // has to be done immediately otherwise he can get stuck
  gunner_duck_down(self);

  self.monsterinfo.nextframe = FRAME.FRAME_duck01;
  self.monsterinfo.currentmove = gunner_move_duck;
}

function gunner_sidestep(self: EdictT): void {
  if (self.monsterinfo.currentmove === gunner_move_jump2 || self.monsterinfo.currentmove === gunner_move_jump) {
    return;
  }

  if (
    self.monsterinfo.currentmove === gunner_move_attack_chain ||
    self.monsterinfo.currentmove === gunner_move_fire_chain ||
    self.monsterinfo.currentmove === gunner_move_attack_grenade
  ) {
    // if we're shooting, and not on easy, don't dodge
    if (cvarNum(gameCvars.skill) !== 0) {
      self.monsterinfo.aiflags &= ~AI_DODGING;
      return;
    }
  }

  if (self.monsterinfo.currentmove !== gunner_move_run) self.monsterinfo.currentmove = gunner_move_run;
}
// ROGUE

/*QUAKED monster_gunner (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_gunner(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_death = gi.soundindex("gunner/death1.wav");
  sound_pain = gi.soundindex("gunner/gunpain2.wav");
  sound_pain2 = gi.soundindex("gunner/gunpain1.wav");
  sound_idle = gi.soundindex("gunner/gunidle1.wav");
  sound_open = gi.soundindex("gunner/gunatck1.wav");
  sound_search = gi.soundindex("gunner/gunsrch1.wav");
  sound_sight = gi.soundindex("gunner/sight1.wav");

  gi.soundindex("gunner/gunatck2.wav");
  gi.soundindex("gunner/gunatck3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/gunner/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 175;
  self.gib_health = -70;
  self.mass = 200;

  self.pain = gunner_pain;
  self.die = gunner_die;

  self.monsterinfo.stand = gunner_stand;
  self.monsterinfo.walk = gunner_walk;
  self.monsterinfo.run = gunner_run;
  // pmm
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = gunner_duck;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = gunner_sidestep;
  // pmm
  self.monsterinfo.attack = gunner_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = gunner_sight;
  self.monsterinfo.search = gunner_search;
  self.monsterinfo.blocked = gunner_blocked; //PGM

  gi.linkentity(self);

  self.monsterinfo.currentmove = gunner_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  // PMM
  self.monsterinfo.blindfire = true;

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

registerSaveFunction("m_gunner:gunner_pain", gunner_pain);
registerSaveFunction("m_gunner:gunner_die", gunner_die);
registerSaveFunction("m_gunner:gunner_stand", gunner_stand);
registerSaveFunction("m_gunner:gunner_walk", gunner_walk);
registerSaveFunction("m_gunner:gunner_run", gunner_run);
registerSaveFunction("m_gunner:gunner_duck", gunner_duck);
registerSaveFunction("m_gunner:gunner_sidestep", gunner_sidestep);
registerSaveFunction("m_gunner:gunner_blocked", gunner_blocked);
registerSaveFunction("m_gunner:gunner_attack", gunner_attack);
registerSaveFunction("m_gunner:gunner_sight", gunner_sight);
registerSaveFunction("m_gunner:gunner_search", gunner_search);
registerSaveMmove("m_gunner:gunner_move_fidget", gunner_move_fidget);
registerSaveMmove("m_gunner:gunner_move_stand", gunner_move_stand);
registerSaveMmove("m_gunner:gunner_move_walk", gunner_move_walk);
registerSaveMmove("m_gunner:gunner_move_run", gunner_move_run);
registerSaveMmove("m_gunner:gunner_move_runandshoot", gunner_move_runandshoot);
registerSaveMmove("m_gunner:gunner_move_pain3", gunner_move_pain3);
registerSaveMmove("m_gunner:gunner_move_pain2", gunner_move_pain2);
registerSaveMmove("m_gunner:gunner_move_pain1", gunner_move_pain1);
registerSaveMmove("m_gunner:gunner_move_death", gunner_move_death);
registerSaveMmove("m_gunner:gunner_move_duck", gunner_move_duck);
registerSaveMmove("m_gunner:gunner_move_attack_chain", gunner_move_attack_chain);
registerSaveMmove("m_gunner:gunner_move_fire_chain", gunner_move_fire_chain);
registerSaveMmove("m_gunner:gunner_move_endfire_chain", gunner_move_endfire_chain);
registerSaveMmove("m_gunner:gunner_move_attack_grenade", gunner_move_attack_grenade);
registerSaveMmove("m_gunner:gunner_move_jump", gunner_move_jump);
registerSaveMmove("m_gunner:gunner_move_jump2", gunner_move_jump2);
