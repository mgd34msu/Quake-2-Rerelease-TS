/*
Copyright (C) 1997-2001 Id Software, Inc.
*/
/*
==============================================================================

MEDIC

==============================================================================
*/

import { AngleVectors, random, VectorCopy, VectorLength, VectorMA, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_VOICE,
  CHAN_WEAPON,
  EF_BLASTER,
  EF_HYPERBLASTER,
  MASK_SHOT,
  MulticastT,
  MZ2_MEDIC_BLASTER_1,
  TempEventT,
} from "../shared/q_shared";
import {
  AI_DUCKED,
  AI_GOOD_GUY,
  AI_HOLD_FRAME,
  AI_MEDIC,
  AI_RESURRECTING,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  g_edicts,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { type Edict, SolidT, SVF_DEADMONSTER, SVF_MONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, FoundTarget, M_CheckAttack, visible } from "./g_ai";
import { monster_fire_blaster, walkmonster_start } from "./g_monster";
import { findradius, G_FreeEdict, G_ProjectSource, vectoangles } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { ED_CallSpawn } from "./g_spawn";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_medic_frames";

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

// Recovers the game-private EdictT from a trace's game-visible Edict, per
// PORTING.md's EDICT_NUM idiom (g_edicts[ent.s.number]), never a cast; this
// module-private helper is duplicated per-file across the codebase
// (g_weapon.ts, m_parasite.ts, m_boss2.ts, ...), not centralized.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

let sound_idle1 = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_die = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_hook_launch = 0;
let sound_hook_hit = 0;
let sound_hook_heal = 0;
let sound_hook_retract = 0;

function medic_FindDeadMonster(self: EdictT): EdictT | null {
  let ent: EdictT | null = null;
  let best: EdictT | null = null;

  while ((ent = findradius(ent, self.s.origin, 1024)) !== null) {
    if (ent === self) continue;
    if (!(ent.svflags & SVF_MONSTER)) continue;
    if (ent.monsterinfo.aiflags & AI_GOOD_GUY) continue;
    if (ent.owner !== null) continue;
    if (ent.health > 0) continue;
    if (ent.nextthink !== 0) continue;
    if (!visible(self, ent)) continue;
    if (best === null) {
      best = ent;
      continue;
    }
    if (ent.max_health <= best.max_health) continue;
    best = ent;
  }

  return best;
}

function medic_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle1, 1, ATTN_IDLE, 0);

  const ent = medic_FindDeadMonster(self);
  if (ent !== null) {
    self.enemy = ent;
    self.enemy.owner = self;
    self.monsterinfo.aiflags |= AI_MEDIC;
    FoundTarget(self);
  }
}

function medic_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_IDLE, 0);

  if (self.oldenemy === null) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      self.enemy.owner = self;
      self.monsterinfo.aiflags |= AI_MEDIC;
      FoundTarget(self);
    }
  }
}

function medic_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

const medic_frames_stand: MframeT[] = [
  mkframe(ai_stand, 0, medic_idle),
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
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
];
const medic_move_stand = mkmove(FRAME.FRAME_wait1, FRAME.FRAME_wait90, medic_frames_stand, null);

function medic_stand(self: EdictT): void {
  self.monsterinfo.currentmove = medic_move_stand;
}

const medic_frames_walk: MframeT[] = [
  mkframe(ai_walk, 6.2),
  mkframe(ai_walk, 18.1),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 11),
  mkframe(ai_walk, 11.6),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 9.9),
  mkframe(ai_walk, 14),
  mkframe(ai_walk, 9.3),
];
const medic_move_walk = mkmove(FRAME.FRAME_walk1, FRAME.FRAME_walk12, medic_frames_walk, null);

function medic_walk(self: EdictT): void {
  self.monsterinfo.currentmove = medic_move_walk;
}

const medic_frames_run: MframeT[] = [
  mkframe(ai_run, 18),
  mkframe(ai_run, 22.5),
  mkframe(ai_run, 25.4),
  mkframe(ai_run, 23.4),
  mkframe(ai_run, 24),
  mkframe(ai_run, 35.6),
];
const medic_move_run = mkmove(FRAME.FRAME_run1, FRAME.FRAME_run6, medic_frames_run, null);

function medic_run(self: EdictT): void {
  if (!(self.monsterinfo.aiflags & AI_MEDIC)) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      self.enemy.owner = self;
      self.monsterinfo.aiflags |= AI_MEDIC;
      FoundTarget(self);
      return;
    }
  }

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = medic_move_stand;
  else self.monsterinfo.currentmove = medic_move_run;
}

const medic_frames_pain1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const medic_move_pain1 = mkmove(FRAME.FRAME_paina1, FRAME.FRAME_paina8, medic_frames_pain1, medic_run);

const medic_frames_pain2: MframeT[] = [
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
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const medic_move_pain2 = mkmove(FRAME.FRAME_painb1, FRAME.FRAME_painb15, medic_frames_pain2, medic_run);

function medic_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (random() < 0.5) {
    self.monsterinfo.currentmove = medic_move_pain1;
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.currentmove = medic_move_pain2;
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  }
}

function medic_fire_blaster(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const end = vec3();
  const dir = vec3();
  let effect: number;

  if (self.s.frame === FRAME.FRAME_attack9 || self.s.frame === FRAME.FRAME_attack12) effect = EF_BLASTER;
  else if (
    self.s.frame === FRAME.FRAME_attack19 ||
    self.s.frame === FRAME.FRAME_attack22 ||
    self.s.frame === FRAME.FRAME_attack25 ||
    self.s.frame === FRAME.FRAME_attack28
  )
    effect = EF_HYPERBLASTER;
  else effect = 0;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_MEDIC_BLASTER_1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here

  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  monster_fire_blaster(self, start, dir, 2, 1000, MZ2_MEDIC_BLASTER_1, effect);
}

function medic_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const medic_frames_death: MframeT[] = [
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
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const medic_move_death = mkmove(FRAME.FRAME_death1, FRAME.FRAME_death30, medic_frames_death, medic_dead);

function medic_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // if we had a pending patient, free him up for another medic
  if (self.enemy !== null && self.enemy.owner === self) self.enemy.owner = null;

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
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  self.monsterinfo.currentmove = medic_move_death;
}

function medic_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.pausetime = level.time + 1;
  gi.linkentity(self);
}

function medic_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

function medic_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

const medic_frames_duck: MframeT[] = [
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1, medic_duck_down),
  mkframe(ai_move, -1, medic_duck_hold),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1, medic_duck_up),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
];
const medic_move_duck = mkmove(FRAME.FRAME_duck1, FRAME.FRAME_duck16, medic_frames_duck, medic_run);

function medic_dodge(self: EdictT, attacker: EdictT, _eta: number): void {
  if (random() > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  self.monsterinfo.currentmove = medic_move_duck;
}

const medic_frames_attackHyperBlaster: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
];
const medic_move_attackHyperBlaster = mkmove(FRAME.FRAME_attack15, FRAME.FRAME_attack30, medic_frames_attackHyperBlaster, medic_run);

function medic_continue(self: EdictT): void {
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (random() <= 0.95) self.monsterinfo.currentmove = medic_move_attackHyperBlaster;
  }
}

const medic_frames_attackBlaster: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_continue), // Change to medic_continue... Else, go to frame 32
];
const medic_move_attackBlaster = mkmove(FRAME.FRAME_attack1, FRAME.FRAME_attack14, medic_frames_attackBlaster, medic_run);

function medic_hook_launch(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_hook_launch, 1, ATTN_NORM, 0);
}

const medic_cable_offsets: readonly Vec3[] = fixedLength("medic_cable_offsets", 10, [
  vec3(45.0, -9.2, 15.5),
  vec3(48.4, -9.7, 15.2),
  vec3(47.8, -9.8, 15.8),
  vec3(47.3, -9.3, 14.3),
  vec3(45.4, -10.1, 13.1),
  vec3(41.9, -12.7, 12.0),
  vec3(37.8, -15.8, 11.2),
  vec3(34.3, -18.4, 10.7),
  vec3(32.7, -19.7, 10.4),
  vec3(32.7, -19.7, 10.4),
]);

function medic_cable_attack(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return; // C assumes self->enemy is set here
  if (!enemy.inuse) return;

  const f = vec3();
  const r = vec3();
  const start = vec3();
  const end = vec3();
  const dir = vec3();
  const angles = vec3();

  AngleVectors(self.s.angles, f, r, null);
  const offset = medic_cable_offsets[self.s.frame - FRAME.FRAME_attack42];
  G_ProjectSource(self.s.origin, offset, f, r, start);

  // check for max distance
  VectorSubtract(start, enemy.s.origin, dir);
  const distance = VectorLength(dir);
  if (distance > 256) return;

  // check for min/max pitch
  vectoangles(dir, angles);
  if (angles[0] < -180) angles[0] += 360;
  if (Math.abs(angles[0]) > 45) return;

  const tr = gi.trace(start, null, null, enemy.s.origin, self, MASK_SHOT);
  if (tr.fraction !== 1.0 && traceEdict(tr.ent) !== enemy) return;

  if (self.s.frame === FRAME.FRAME_attack43) {
    gi.sound(enemy, CHAN_AUTO, sound_hook_hit, 1, ATTN_NORM, 0);
    enemy.monsterinfo.aiflags |= AI_RESURRECTING;
  } else if (self.s.frame === FRAME.FRAME_attack50) {
    enemy.spawnflags = 0;
    enemy.monsterinfo.aiflags = 0;
    enemy.target = null;
    enemy.targetname = null;
    enemy.combattarget = null;
    enemy.deathtarget = null;
    enemy.owner = self;
    ED_CallSpawn(enemy);
    enemy.owner = null;
    if (enemy.think !== null) {
      enemy.nextthink = level.time;
      enemy.think(enemy);
    }
    enemy.monsterinfo.aiflags |= AI_RESURRECTING;
    if (self.oldenemy !== null && self.oldenemy.client !== null) {
      enemy.enemy = self.oldenemy;
      FoundTarget(enemy);
    }
  } else {
    if (self.s.frame === FRAME.FRAME_attack44) gi.sound(self, CHAN_WEAPON, sound_hook_heal, 1, ATTN_NORM, 0);
  }

  // adjust start for beam origin being in middle of a segment
  VectorMA(start, 8, f, start);

  // adjust end z for end spot since the monster is currently dead
  VectorCopy(enemy.s.origin, end);
  end[2] = enemy.absmin[2] + enemy.size[2] / 2;

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_MEDIC_CABLE_ATTACK);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

function medic_hook_retract(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_hook_retract, 1, ATTN_NORM, 0);
  if (self.enemy !== null) self.enemy.monsterinfo.aiflags &= ~AI_RESURRECTING;
}

const medic_frames_attackCable: MframeT[] = [
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 5),
  mkframe(ai_move, 4.4),
  mkframe(ai_charge, 4.7),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 0),
  mkframe(ai_move, 0, medic_hook_launch),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, -15, medic_hook_retract),
  mkframe(ai_move, -1.5),
  mkframe(ai_move, -1.2),
  mkframe(ai_move, -3),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0.3),
  mkframe(ai_move, 0.7),
  mkframe(ai_move, 1.2),
  mkframe(ai_move, 1.3),
];
const medic_move_attackCable = mkmove(FRAME.FRAME_attack33, FRAME.FRAME_attack60, medic_frames_attackCable, medic_run);

function medic_attack(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_MEDIC) self.monsterinfo.currentmove = medic_move_attackCable;
  else self.monsterinfo.currentmove = medic_move_attackBlaster;
}

function medic_checkattack(self: EdictT): boolean {
  if (self.monsterinfo.aiflags & AI_MEDIC) {
    medic_attack(self);
    return true;
  }

  return M_CheckAttack(self);
}

/*QUAKED monster_medic (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_medic(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_idle1 = gi.soundindex("medic/idle.wav");
  sound_pain1 = gi.soundindex("medic/medpain1.wav");
  sound_pain2 = gi.soundindex("medic/medpain2.wav");
  sound_die = gi.soundindex("medic/meddeth1.wav");
  sound_sight = gi.soundindex("medic/medsght1.wav");
  sound_search = gi.soundindex("medic/medsrch1.wav");
  sound_hook_launch = gi.soundindex("medic/medatck2.wav");
  sound_hook_hit = gi.soundindex("medic/medatck3.wav");
  sound_hook_heal = gi.soundindex("medic/medatck4.wav");
  sound_hook_retract = gi.soundindex("medic/medatck5.wav");

  gi.soundindex("medic/medatck1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/medic/tris.md2");
  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 32);

  self.health = 300;
  self.gib_health = -130;
  self.mass = 400;

  self.pain = medic_pain;
  self.die = medic_die;

  self.monsterinfo.stand = medic_stand;
  self.monsterinfo.walk = medic_walk;
  self.monsterinfo.run = medic_run;
  self.monsterinfo.dodge = medic_dodge;
  self.monsterinfo.attack = medic_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = medic_sight;
  self.monsterinfo.idle = medic_idle;
  self.monsterinfo.search = medic_search;
  self.monsterinfo.checkattack = medic_checkattack;

  gi.linkentity(self);

  self.monsterinfo.currentmove = medic_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

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

registerSaveFunction("m_medic:medic_pain", medic_pain);
registerSaveFunction("m_medic:medic_die", medic_die);
registerSaveFunction("m_medic:medic_stand", medic_stand);
registerSaveFunction("m_medic:medic_walk", medic_walk);
registerSaveFunction("m_medic:medic_run", medic_run);
registerSaveFunction("m_medic:medic_dodge", medic_dodge);
registerSaveFunction("m_medic:medic_attack", medic_attack);
registerSaveFunction("m_medic:medic_sight", medic_sight);
registerSaveFunction("m_medic:medic_idle", medic_idle);
registerSaveFunction("m_medic:medic_search", medic_search);
registerSaveFunction("m_medic:medic_checkattack", medic_checkattack);
registerSaveMmove("m_medic:medic_move_stand", medic_move_stand);
registerSaveMmove("m_medic:medic_move_walk", medic_move_walk);
registerSaveMmove("m_medic:medic_move_run", medic_move_run);
registerSaveMmove("m_medic:medic_move_pain1", medic_move_pain1);
registerSaveMmove("m_medic:medic_move_pain2", medic_move_pain2);
registerSaveMmove("m_medic:medic_move_death", medic_move_death);
registerSaveMmove("m_medic:medic_move_duck", medic_move_duck);
registerSaveMmove("m_medic:medic_move_attackHyperBlaster", medic_move_attackHyperBlaster);
registerSaveMmove("m_medic:medic_move_attackBlaster", medic_move_attackBlaster);
registerSaveMmove("m_medic:medic_move_attackCable", medic_move_attackCable);
