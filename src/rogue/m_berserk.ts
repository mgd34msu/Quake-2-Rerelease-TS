/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.
Ported from rogue/m_berserk.c.

rogue/m_berserk.c vs baseq2/m_berserk.c (ported at src/game/m_berserk.ts):
  - berserk_run/berserk_melee/berserk_pain now call monster_done_dodge(self)
    first (m_berserk.c:145/236/316) to cancel any in-progress dodge, and the
    last frame of berserk_frames_run1 (FRAME_run4, dist 25) gets
    monster_done_dodge as its thinkfunc instead of NULL (m_berserk.c:138).
  - New ROGUE jump-attack: berserk_jump_now/berserk_jump2_now (launch via
    monster_jump_start + an AngleVectors-relative velocity kick),
    berserk_jump_wait_land (holds the animation on the current frame until
    monster_jump_finished), berserk_move_jump/berserk_move_jump2 (both use
    the same FRAME_jump1..FRAME_jump9 range, differing only in per-frame
    ai_move distances and thinkfuncs), berserk_jump (picks jump vs jump2
    based on whether the enemy is above or below), and berserk_blocked
    (monsterinfo.blocked -- tries blocked_checkjump then blocked_checkplat).
  - New berserk_sidestep (monsterinfo.sidestep): falls through to
    berserk_move_run1 unless a jump animation is already playing.
  - SP_monster_berserk wires monsterinfo.dodge = M_MonsterDodge (was NULL),
    monsterinfo.sidestep = berserk_sidestep, and monsterinfo.blocked =
    berserk_blocked (all new fields on rogue's widened MonsterInfoT).
*/
/*
==============================================================================

BERSERK

==============================================================================
*/

import { AngleVectors, vec3, VectorMA, VectorSet, type Vec3 } from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, CHAN_VOICE, CHAN_WEAPON, type CvarT } from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk } from "./g_ai";
import {
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  GIB_ORGANIC,
  MELEE_DISTANCE,
  gi,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { G_FreeEdict } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { monster_done_dodge, walkmonster_start } from "./g_monster";
import { blocked_checkjump, blocked_checkplat, M_MonsterDodge, monster_jump_finished, monster_jump_start } from "./g_newai";
import * as F from "./m_berserk_frames";

// mirrors g_monster.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function mf(
  aifunc: ((self: EdictT, dist: number) => void) | null,
  dist: number,
  thinkfunc: ((self: EdictT) => void) | null = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

let sound_pain = 0;
let sound_die = 0;
let sound_idle = 0;
let sound_punch = 0;
let sound_sight = 0;
let sound_search = 0;

function berserk_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function berserk_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

//
// STAND
//

function berserk_fidget(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) return;
  if (Math.random() > 0.15) return;

  self.monsterinfo.currentmove = berserk_move_stand_fidget;
  gi.sound(self, CHAN_WEAPON, sound_idle, 1, ATTN_IDLE, 0);
}

const berserk_frames_stand: MframeT[] = [
  mf(ai_stand, 0, berserk_fidget),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
];
const berserk_move_stand = new MmoveT();
berserk_move_stand.firstframe = F.FRAME_stand1;
berserk_move_stand.lastframe = F.FRAME_stand5;
berserk_move_stand.frame = berserk_frames_stand;
berserk_move_stand.endfunc = null;

function berserk_stand(self: EdictT): void {
  self.monsterinfo.currentmove = berserk_move_stand;
}

// 20 identical `ai_stand, 0, NULL` rows (FRAME_standb1..FRAME_standb20)
const berserk_frames_stand_fidget: MframeT[] = Array.from({ length: 20 }, () => mf(ai_stand, 0, null));
const berserk_move_stand_fidget = new MmoveT();
berserk_move_stand_fidget.firstframe = F.FRAME_standb1;
berserk_move_stand_fidget.lastframe = F.FRAME_standb20;
berserk_move_stand_fidget.frame = berserk_frames_stand_fidget;
berserk_move_stand_fidget.endfunc = berserk_stand;

//
// WALK
//

const berserk_frames_walk: MframeT[] = [
  mf(ai_walk, 9.1),
  mf(ai_walk, 6.3),
  mf(ai_walk, 4.9),
  mf(ai_walk, 6.7),
  mf(ai_walk, 6.0),
  mf(ai_walk, 8.2),
  mf(ai_walk, 7.2),
  mf(ai_walk, 6.1),
  mf(ai_walk, 4.9),
  mf(ai_walk, 4.7),
  mf(ai_walk, 4.7),
  mf(ai_walk, 4.8),
];
// C: mmove_t spans FRAME_walkc1..FRAME_walkc11 (11 frames) but the frame[]
// table above has 12 rows -- an off-by-one in the original data. Preserved
// bug-for-bug: M_MoveFrame only ever indexes firstframe..lastframe, so the
// 12th row is unreachable at runtime exactly as in the C build.
const berserk_move_walk = new MmoveT();
berserk_move_walk.firstframe = F.FRAME_walkc1;
berserk_move_walk.lastframe = F.FRAME_walkc11;
berserk_move_walk.allowFrameCountMismatch = true;
berserk_move_walk.frame = berserk_frames_walk;
berserk_move_walk.endfunc = null;

function berserk_walk(self: EdictT): void {
  self.monsterinfo.currentmove = berserk_move_walk;
}

//
// RUN
//

/*

  *****************************
  SKIPPED THIS FOR NOW!
  *****************************

   Running -> Arm raised in air

void()	berserk_runb1	=[	$r_att1 ,	berserk_runb2	] {ai_run(21);};
void()	berserk_runb2	=[	$r_att2 ,	berserk_runb3	] {ai_run(11);};
void()	berserk_runb3	=[	$r_att3 ,	berserk_runb4	] {ai_run(21);};
void()	berserk_runb4	=[	$r_att4 ,	berserk_runb5	] {ai_run(25);};
void()	berserk_runb5	=[	$r_att5 ,	berserk_runb6	] {ai_run(18);};
void()	berserk_runb6	=[	$r_att6 ,	berserk_runb7	] {ai_run(19);};
// running with arm in air : start loop
void()	berserk_runb7	=[	$r_att7 ,	berserk_runb8	] {ai_run(21);};
void()	berserk_runb8	=[	$r_att8 ,	berserk_runb9	] {ai_run(11);};
void()	berserk_runb9	=[	$r_att9 ,	berserk_runb10	] {ai_run(21);};
void()	berserk_runb10	=[	$r_att10 ,	berserk_runb11	] {ai_run(25);};
void()	berserk_runb11	=[	$r_att11 ,	berserk_runb12	] {ai_run(18);};
void()	berserk_runb12	=[	$r_att12 ,	berserk_runb7	] {ai_run(19);};
// running with arm in air : end loop
*/

const berserk_frames_run1: MframeT[] = [
  mf(ai_run, 21),
  mf(ai_run, 11),
  mf(ai_run, 21),
  // PMM .. from NULL
  mf(ai_run, 25, monster_done_dodge),
  mf(ai_run, 18),
  mf(ai_run, 19),
];
const berserk_move_run1 = new MmoveT();
berserk_move_run1.firstframe = F.FRAME_run1;
berserk_move_run1.lastframe = F.FRAME_run6;
berserk_move_run1.frame = berserk_frames_run1;
berserk_move_run1.endfunc = null;

function berserk_run(self: EdictT): void {
  monster_done_dodge(self);
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = berserk_move_stand;
  else self.monsterinfo.currentmove = berserk_move_run1;
}

//
// MELEE
//

function berserk_attack_spike(self: EdictT): void {
  const aim: Vec3 = vec3(MELEE_DISTANCE, 0, -24); // static vec3_t aim = {MELEE_DISTANCE, 0, -24}
  fire_hit(self, aim, 15 + Math.floor(Math.random() * 6), 400); // Faster attack -- upwards and backwards
}

function berserk_swing(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_punch, 1, ATTN_NORM, 0);
}

const berserk_frames_attack_spike: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, berserk_swing),
  mf(ai_charge, 0, berserk_attack_spike),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
];
const berserk_move_attack_spike = new MmoveT();
berserk_move_attack_spike.firstframe = F.FRAME_att_c1;
berserk_move_attack_spike.lastframe = F.FRAME_att_c8;
berserk_move_attack_spike.frame = berserk_frames_attack_spike;
berserk_move_attack_spike.endfunc = berserk_run;

function berserk_attack_club(self: EdictT): void {
  const aim: Vec3 = vec3(MELEE_DISTANCE, self.mins[0], -4);
  fire_hit(self, aim, 5 + Math.floor(Math.random() * 6), 400); // Slower attack
}

const berserk_frames_attack_club: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, berserk_swing),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, berserk_attack_club),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
];
const berserk_move_attack_club = new MmoveT();
berserk_move_attack_club.firstframe = F.FRAME_att_c9;
berserk_move_attack_club.lastframe = F.FRAME_att_c20;
berserk_move_attack_club.frame = berserk_frames_attack_club;
berserk_move_attack_club.endfunc = berserk_run;

function berserk_strike(_self: EdictT): void {
  // FIXME play impact sound
}

const berserk_frames_attack_strike: MframeT[] = [
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, berserk_swing),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, berserk_strike),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 9.7, null),
  mf(ai_move, 13.6, null),
];
const berserk_move_attack_strike = new MmoveT();
berserk_move_attack_strike.firstframe = F.FRAME_att_c21;
berserk_move_attack_strike.lastframe = F.FRAME_att_c34;
berserk_move_attack_strike.frame = berserk_frames_attack_strike;
berserk_move_attack_strike.endfunc = berserk_run;

// berserk_move_attack_strike/berserk_frames_attack_strike are dead data in
// the original C too -- berserk_melee only ever picks between spike and
// club, nothing else in m_berserk.c references the strike move. Kept
// module-private rather than dropped, matching the C source's own unused code.

function berserk_melee(self: EdictT): void {
  monster_done_dodge(self);

  if (Math.floor(Math.random() * 2) === 0) self.monsterinfo.currentmove = berserk_move_attack_spike;
  else self.monsterinfo.currentmove = berserk_move_attack_club;
}

/*
void() 	berserk_atke1	=[	$r_attb1,	berserk_atke2	] {ai_run(9);};
void() 	berserk_atke2	=[	$r_attb2,	berserk_atke3	] {ai_run(6);};
void() 	berserk_atke3	=[	$r_attb3,	berserk_atke4	] {ai_run(18.4);};
void() 	berserk_atke4	=[	$r_attb4,	berserk_atke5	] {ai_run(25);};
void() 	berserk_atke5	=[	$r_attb5,	berserk_atke6	] {ai_run(14);};
void() 	berserk_atke6	=[	$r_attb6,	berserk_atke7	] {ai_run(20);};
void() 	berserk_atke7	=[	$r_attb7,	berserk_atke8	] {ai_run(8.5);};
void() 	berserk_atke8	=[	$r_attb8,	berserk_atke9	] {ai_run(3);};
void() 	berserk_atke9	=[	$r_attb9,	berserk_atke10	] {ai_run(17.5);};
void() 	berserk_atke10	=[	$r_attb10,	berserk_atke11	] {ai_run(17);};
void() 	berserk_atke11	=[	$r_attb11,	berserk_atke12	] {ai_run(9);};
void() 	berserk_atke12	=[	$r_attb12,	berserk_atke13	] {ai_run(25);};
void() 	berserk_atke13	=[	$r_attb13,	berserk_atke14	] {ai_run(3.7);};
void() 	berserk_atke14	=[	$r_attb14,	berserk_atke15	] {ai_run(2.6);};
void() 	berserk_atke15	=[	$r_attb15,	berserk_atke16	] {ai_run(19);};
void() 	berserk_atke16	=[	$r_attb16,	berserk_atke17	] {ai_run(25);};
void() 	berserk_atke17	=[	$r_attb17,	berserk_atke18	] {ai_run(19.6);};
void() 	berserk_atke18	=[	$r_attb18,	berserk_run1	] {ai_run(7.8);};
*/

//
// PAIN
//

const berserk_frames_pain1: MframeT[] = [mf(ai_move, 0), mf(ai_move, 0), mf(ai_move, 0), mf(ai_move, 0)];
const berserk_move_pain1 = new MmoveT();
berserk_move_pain1.firstframe = F.FRAME_painc1;
berserk_move_pain1.lastframe = F.FRAME_painc4;
berserk_move_pain1.frame = berserk_frames_pain1;
berserk_move_pain1.endfunc = berserk_run;

// 20 identical `ai_move, 0, NULL` rows (FRAME_painb1..FRAME_painb20)
const berserk_frames_pain2: MframeT[] = Array.from({ length: 20 }, () => mf(ai_move, 0, null));
const berserk_move_pain2 = new MmoveT();
berserk_move_pain2.firstframe = F.FRAME_painb1;
berserk_move_pain2.lastframe = F.FRAME_painb20;
berserk_move_pain2.frame = berserk_frames_pain2;
berserk_move_pain2.endfunc = berserk_run;

function berserk_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  monster_done_dodge(self);

  if (damage < 20 || Math.random() < 0.5) self.monsterinfo.currentmove = berserk_move_pain1;
  else self.monsterinfo.currentmove = berserk_move_pain2;
}

//
// DEATH
//

function berserk_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const berserk_frames_death1: MframeT[] = Array.from({ length: 13 }, () => mf(ai_move, 0, null));
const berserk_move_death1 = new MmoveT();
berserk_move_death1.firstframe = F.FRAME_death1;
berserk_move_death1.lastframe = F.FRAME_death13;
berserk_move_death1.frame = berserk_frames_death1;
berserk_move_death1.endfunc = berserk_dead;

const berserk_frames_death2: MframeT[] = Array.from({ length: 8 }, () => mf(ai_move, 0, null));
const berserk_move_death2 = new MmoveT();
berserk_move_death2.firstframe = F.FRAME_deathc1;
berserk_move_death2.lastframe = F.FRAME_deathc8;
berserk_move_death2.frame = berserk_frames_death2;
berserk_move_death2.endfunc = berserk_dead;

function berserk_die(
  self: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  damage: number,
  _point: Vec3,
): void {
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  if (damage >= 50) self.monsterinfo.currentmove = berserk_move_death1;
  else self.monsterinfo.currentmove = berserk_move_death2;
}

//===========
//PGM
// ROGUE -- jump attack

function berserk_jump_now(self: EdictT): void {
  const forward = vec3();
  const up = vec3();

  monster_jump_start(self);

  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 100, forward, self.velocity);
  VectorMA(self.velocity, 300, up, self.velocity);
}

function berserk_jump2_now(self: EdictT): void {
  const forward = vec3();
  const up = vec3();

  monster_jump_start(self);

  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 150, forward, self.velocity);
  VectorMA(self.velocity, 400, up, self.velocity);
}

function berserk_jump_wait_land(self: EdictT): void {
  if (self.groundentity === null) {
    self.monsterinfo.nextframe = self.s.frame;

    if (monster_jump_finished(self)) self.monsterinfo.nextframe = self.s.frame + 1;
  } else {
    self.monsterinfo.nextframe = self.s.frame + 1;
  }
}

const berserk_frames_jump: MframeT[] = [
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, berserk_jump_now),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, berserk_jump_wait_land),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
];
const berserk_move_jump = new MmoveT();
berserk_move_jump.firstframe = F.FRAME_jump1;
berserk_move_jump.lastframe = F.FRAME_jump9;
berserk_move_jump.frame = berserk_frames_jump;
berserk_move_jump.endfunc = berserk_run;

const berserk_frames_jump2: MframeT[] = [
  mf(ai_move, -8, null),
  mf(ai_move, -4, null),
  mf(ai_move, -4, null),
  mf(ai_move, 0, berserk_jump_now),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, berserk_jump_wait_land),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
];
const berserk_move_jump2 = new MmoveT();
berserk_move_jump2.firstframe = F.FRAME_jump1;
berserk_move_jump2.lastframe = F.FRAME_jump9;
berserk_move_jump2.frame = berserk_frames_jump2;
berserk_move_jump2.endfunc = berserk_run;

function berserk_jump(self: EdictT): void {
  if (!self.enemy) return;

  monster_done_dodge(self);

  if (self.enemy.s.origin[2] > self.s.origin[2]) self.monsterinfo.currentmove = berserk_move_jump2;
  else self.monsterinfo.currentmove = berserk_move_jump;
}

function berserk_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkjump(self, dist, 256, 40)) {
    berserk_jump(self);
    return true;
  }

  if (blocked_checkplat(self, dist)) return true;

  return false;
}
//PGM
//===========

function berserk_sidestep(self: EdictT): void {
  // if we're jumping, don't dodge
  if (self.monsterinfo.currentmove === berserk_move_jump || self.monsterinfo.currentmove === berserk_move_jump2) {
    return;
  }

  // don't check for attack; the eta should suffice for melee monsters

  if (self.monsterinfo.currentmove !== berserk_move_run1) self.monsterinfo.currentmove = berserk_move_run1;
}

/*QUAKED monster_berserk (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_berserk(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // pre-caches
  sound_pain = gi.soundindex("berserk/berpain2.wav");
  sound_die = gi.soundindex("berserk/berdeth2.wav");
  sound_idle = gi.soundindex("berserk/beridle1.wav");
  sound_punch = gi.soundindex("berserk/attack.wav");
  sound_search = gi.soundindex("berserk/bersrch1.wav");
  sound_sight = gi.soundindex("berserk/sight.wav");

  self.s.modelindex = gi.modelindex("models/monsters/berserk/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = 240;
  self.gib_health = -60;
  self.mass = 250;

  self.pain = berserk_pain;
  self.die = berserk_die;

  self.monsterinfo.stand = berserk_stand;
  self.monsterinfo.walk = berserk_walk;
  self.monsterinfo.run = berserk_run;
  // pmm
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.sidestep = berserk_sidestep;
  // pmm
  self.monsterinfo.attack = null;
  self.monsterinfo.melee = berserk_melee;
  self.monsterinfo.sight = berserk_sight;
  self.monsterinfo.search = berserk_search;
  self.monsterinfo.blocked = berserk_blocked; //PGM

  self.monsterinfo.currentmove = berserk_move_stand;
  self.monsterinfo.scale = F.MODEL_SCALE;

  gi.linkentity(self);

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

registerSaveFunction("m_berserk:berserk_pain", berserk_pain);
registerSaveFunction("m_berserk:berserk_die", berserk_die);
registerSaveFunction("m_berserk:berserk_stand", berserk_stand);
registerSaveFunction("m_berserk:berserk_walk", berserk_walk);
registerSaveFunction("m_berserk:berserk_run", berserk_run);
registerSaveFunction("m_berserk:berserk_melee", berserk_melee);
registerSaveFunction("m_berserk:berserk_sight", berserk_sight);
registerSaveFunction("m_berserk:berserk_search", berserk_search);
registerSaveFunction("m_berserk:berserk_sidestep", berserk_sidestep);
registerSaveFunction("m_berserk:berserk_blocked", berserk_blocked);
registerSaveMmove("m_berserk:berserk_move_stand", berserk_move_stand);
registerSaveMmove("m_berserk:berserk_move_stand_fidget", berserk_move_stand_fidget);
registerSaveMmove("m_berserk:berserk_move_walk", berserk_move_walk);
registerSaveMmove("m_berserk:berserk_move_run1", berserk_move_run1);
registerSaveMmove("m_berserk:berserk_move_attack_spike", berserk_move_attack_spike);
registerSaveMmove("m_berserk:berserk_move_attack_club", berserk_move_attack_club);
registerSaveMmove("m_berserk:berserk_move_attack_strike", berserk_move_attack_strike);
registerSaveMmove("m_berserk:berserk_move_pain1", berserk_move_pain1);
registerSaveMmove("m_berserk:berserk_move_pain2", berserk_move_pain2);
registerSaveMmove("m_berserk:berserk_move_death1", berserk_move_death1);
registerSaveMmove("m_berserk:berserk_move_death2", berserk_move_death2);
registerSaveMmove("m_berserk:berserk_move_jump", berserk_move_jump);
registerSaveMmove("m_berserk:berserk_move_jump2", berserk_move_jump2);
