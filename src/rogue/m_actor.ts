/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_actor.c (GNU GPL v2 or later).
*/
// g_actor.c
//
// rogue/m_actor.c vs baseq2/m_actor.c: banner swap only, no other delta --
// ported by copying src/game/m_actor.ts and repointing the sibling imports
// at the flat src/rogue/ layout (./g_local, ./game, ./g_ai, ./g_monster,
// ./g_utils, ./g_misc, ./m_flash, ./m_actor_frames, ./g_save).

import { AngleVectors, random, VectorCopy, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3 } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import { ATTN_NORM, CHAN_VOICE, CplaneT, CsurfaceT, MZ2_ACTOR_MACHINEGUN_1, PRINT_CHAT, YAW } from "../shared/q_shared";
import {
  AI_BRUTAL,
  AI_GOOD_GUY,
  AI_HOLD_FRAME,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  GIB_ORGANIC,
  gi,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  st,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER, SVF_NOCLIENT } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_turn, ai_walk } from "./g_ai";
import { monster_fire_bullet, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_PickTarget, G_ProjectSource, G_SetMovedir, G_UseTargets, vectoyaw, vtos } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_actor_frames";

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

const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

const MAX_ACTOR_NAMES = 8;
const actor_names: string[] = fixedLength("actor_names", 8, ["Hellrot", "Tokay", "Killme", "Disruptor", "Adrianator", "Rambear", "Titus", "Bitterman"]);

const messages: string[] = ["Watch it", "#$@*&", "Idiot", "Check your targets"];

const actor_frames_stand: MframeT[] = Array.from({ length: 40 }, () => mkframe(ai_stand, 0));
const actor_move_stand = mkmove(FRAME.FRAME_stand101, FRAME.FRAME_stand140, actor_frames_stand);

function actor_stand(self: EdictT): void {
  self.monsterinfo.currentmove = actor_move_stand;

  // randomize on startup
  if (level.time < 1.0) {
    const currentmove = self.monsterinfo.currentmove;
    if (currentmove !== null) {
      // C: `rand() % (lastframe - firstframe + 1)` -- house idiom for raw rand() % N.
      self.s.frame = currentmove.firstframe + Math.floor(Math.random() * (currentmove.lastframe - currentmove.firstframe + 1));
    }
  }
}

const actor_frames_walk: MframeT[] = [
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
];
// C bug, not a porting error: rogue/m_actor.c's actor_frames_walk[] has 11
// rows (rogue/m_actor.c:80-93) but actor_move_walk = {FRAME_walk01,
// FRAME_walk08, ...} only spans 8 frames (rogue/m_actor.c:94 vs.
// rogue/m_actor.h FRAME_walk01=251/FRAME_walk08=258, unchanged from
// baseq2). Same id-bug preserved in the pack; the engine only ever reads
// indices firstframe..lastframe, so the extra three rows are dead here too;
// preserved byte-for-byte with the same allowFrameCountMismatch exemption
// as src/game/m_actor.ts's actor_move_walk.
const actor_move_walk = mkmove(FRAME.FRAME_walk01, FRAME.FRAME_walk08, actor_frames_walk, null, true);

function actor_walk(self: EdictT): void {
  self.monsterinfo.currentmove = actor_move_walk;
}

const actor_frames_run: MframeT[] = [
  mkframe(ai_run, 4),
  mkframe(ai_run, 15),
  mkframe(ai_run, 15),
  mkframe(ai_run, 8),
  mkframe(ai_run, 20),
  mkframe(ai_run, 15),
  mkframe(ai_run, 8),
  mkframe(ai_run, 17),
  mkframe(ai_run, 12),
  mkframe(ai_run, -2),
  mkframe(ai_run, -2),
  mkframe(ai_run, -1),
];
// C bug, not a porting error: rogue/m_actor.c's actor_frames_run[] has 12
// rows (rogue/m_actor.c:102-116) but actor_move_run = {FRAME_run02,
// FRAME_run07, ...} only spans 6 frames (rogue/m_actor.c:117 vs.
// rogue/m_actor.h FRAME_run02=93/FRAME_run07=98, unchanged from baseq2).
// Same id-bug preserved in the pack; the engine only ever reads indices
// firstframe..lastframe, so the extra six rows are dead here too; preserved
// byte-for-byte with the same allowFrameCountMismatch exemption as
// src/game/m_actor.ts's actor_move_run.
const actor_move_run = mkmove(FRAME.FRAME_run02, FRAME.FRAME_run07, actor_frames_run, null, true);

function actor_run(self: EdictT): void {
  if (level.time < self.pain_debounce_time && self.enemy === null) {
    if (self.movetarget !== null) actor_walk(self);
    else actor_stand(self);
    return;
  }

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    actor_stand(self);
    return;
  }

  self.monsterinfo.currentmove = actor_move_run;
}

const actor_frames_pain1: MframeT[] = [mkframe(ai_move, -5), mkframe(ai_move, 4), mkframe(ai_move, 1)];
const actor_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain103, actor_frames_pain1, actor_run);

const actor_frames_pain2: MframeT[] = [mkframe(ai_move, -4), mkframe(ai_move, 4), mkframe(ai_move, 0)];
const actor_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain203, actor_frames_pain2, actor_run);

const actor_frames_pain3: MframeT[] = [mkframe(ai_move, -1), mkframe(ai_move, 1), mkframe(ai_move, 0)];
const actor_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain303, actor_frames_pain3, actor_run);

const actor_frames_flipoff: MframeT[] = Array.from({ length: 14 }, () => mkframe(ai_turn, 0));
const actor_move_flipoff = mkmove(FRAME.FRAME_flip01, FRAME.FRAME_flip14, actor_frames_flipoff, actor_run);

const actor_frames_taunt: MframeT[] = Array.from({ length: 17 }, () => mkframe(ai_turn, 0));
const actor_move_taunt = mkmove(FRAME.FRAME_taunt01, FRAME.FRAME_taunt17, actor_frames_taunt, actor_run);

function actor_pain(self: EdictT, other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  // gi.sound (self, CHAN_VOICE, actor.sound_pain, 1, ATTN_NORM, 0);

  if (other.client !== null && random() < 0.4) {
    const v = vec3();
    VectorSubtract(other.s.origin, self.s.origin, v);
    self.ideal_yaw = vectoyaw(v);
    if (random() < 0.5) self.monsterinfo.currentmove = actor_move_flipoff;
    else self.monsterinfo.currentmove = actor_move_taunt;
    const name = actor_names[self.s.number % MAX_ACTOR_NAMES];
    // C: `rand()%3` -- house idiom for raw rand() % N.
    gi.cprintf(other, PRINT_CHAT, `${name}: ${messages[Math.floor(Math.random() * 3)]}!\n`);
    return;
  }

  // C: `rand() % 3` -- house idiom for raw rand() % N.
  const n = Math.floor(Math.random() * 3);
  if (n === 0) self.monsterinfo.currentmove = actor_move_pain1;
  else if (n === 1) self.monsterinfo.currentmove = actor_move_pain2;
  else self.monsterinfo.currentmove = actor_move_pain3;
}

function actorMachineGun(self: EdictT): void {
  const start = vec3();
  const target = vec3();
  const forward = vec3();
  const right = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_ACTOR_MACHINEGUN_1], forward, right, start);

  if (self.enemy !== null) {
    if (self.enemy.health > 0) {
      VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);
      target[2] += self.enemy.viewheight;
    } else {
      VectorCopy(self.enemy.absmin, target);
      target[2] += self.enemy.size[2] / 2;
    }
    VectorSubtract(target, start, forward);
    VectorNormalize(forward);
  } else {
    AngleVectors(self.s.angles, forward, null, null);
  }
  monster_fire_bullet(self, start, forward, 3, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MZ2_ACTOR_MACHINEGUN_1);
}

function actor_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const actor_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -13),
  mkframe(ai_move, 14),
  mkframe(ai_move, 3),
  mkframe(ai_move, -2),
  mkframe(ai_move, 1),
];
const actor_move_death1 = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death107, actor_frames_death1, actor_dead);

const actor_frames_death2: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 7),
  mkframe(ai_move, -6),
  mkframe(ai_move, -5),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, -2),
  mkframe(ai_move, -1),
  mkframe(ai_move, -9),
  mkframe(ai_move, -13),
  mkframe(ai_move, -13),
  mkframe(ai_move, 0),
];
const actor_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death213, actor_frames_death2, actor_dead);

function actor_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: import("../shared/math").Vec3): void {
  // check for gib
  if (self.health <= -80) {
    // gi.sound (self, CHAN_VOICE, actor.sound_gib, 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  // gi.sound (self, CHAN_VOICE, actor.sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  // C: `rand() % 2` -- house idiom for raw rand() % N.
  const n = Math.floor(Math.random() * 2);
  if (n === 0) self.monsterinfo.currentmove = actor_move_death1;
  else self.monsterinfo.currentmove = actor_move_death2;
}

function actor_fire(self: EdictT): void {
  actorMachineGun(self);

  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

const actor_frames_attack: MframeT[] = [mkframe(ai_charge, -2, actor_fire), mkframe(ai_charge, -2), mkframe(ai_charge, 3), mkframe(ai_charge, 2)];
const actor_move_attack = mkmove(FRAME.FRAME_attak01, FRAME.FRAME_attak04, actor_frames_attack, actor_run);

function actor_attack(self: EdictT): void {
  self.monsterinfo.currentmove = actor_move_attack;
  // C: `(rand() & 15) + 3 + 7` -- house idiom for raw rand() & N.
  const n = (Math.floor(Math.random() * 65536) & 15) + 3 + 7;
  self.monsterinfo.pausetime = level.time + n * FRAMETIME;
}

function actor_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const v = vec3();

  const target = G_PickTarget(self.target);
  self.goalentity = target;
  self.movetarget = target;
  if (target === null || target.classname !== "target_actor") {
    gi.dprintf(`${self.classname ?? ""} has bad target ${self.target ?? ""} at ${vtos(self.s.origin)}\n`);
    self.target = null;
    self.monsterinfo.pausetime = 100000000;
    self.monsterinfo.stand?.(self);
    return;
  }

  VectorSubtract(target.s.origin, self.s.origin, v);
  self.ideal_yaw = vectoyaw(v);
  self.s.angles[YAW] = self.ideal_yaw;
  self.monsterinfo.walk?.(self);
  self.target = null;
}

/*QUAKED misc_actor (1 .5 0) (-16 -16 -24) (16 16 32)
*/
export function SP_misc_actor(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  if (self.targetname === null) {
    gi.dprintf(`untargeted ${self.classname ?? ""} at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.target === null) {
    gi.dprintf(`${self.classname ?? ""} with no target at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("players/male/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  if (!self.health) self.health = 100;
  self.mass = 200;

  self.pain = actor_pain;
  self.die = actor_die;

  self.monsterinfo.stand = actor_stand;
  self.monsterinfo.walk = actor_walk;
  self.monsterinfo.run = actor_run;
  self.monsterinfo.attack = actor_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;

  self.monsterinfo.aiflags |= AI_GOOD_GUY;

  gi.linkentity(self);

  self.monsterinfo.currentmove = actor_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);

  // actors always start in a dormant state, they *must* be used to get going
  self.use = actor_use;
}

/*QUAKED target_actor (.5 .3 0) (-8 -8 -8) (8 8 8) JUMP SHOOT ATTACK x HOLD BRUTAL
JUMP			jump in set direction upon reaching this target
SHOOT			take a single shot at the pathtarget
ATTACK			attack pathtarget until it or actor is dead

"target"		next target_actor
"pathtarget"	target of any action to be taken at this point
"wait"			amount of time actor should pause at this point
"message"		actor will "say" this to the player

for JUMP only:
"speed"			speed thrown forward (default 200)
"height"		speed thrown upwards (default 200)
*/

function target_actor_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  const v = vec3();

  if (other.movetarget !== self) return;

  if (other.enemy !== null) return;

  other.goalentity = null;
  other.movetarget = null;

  if (self.message !== null) {
    for (let n = 1; n <= game.maxclients; n++) {
      const ent = g_edicts[n];
      if (!ent.inuse) continue;
      gi.cprintf(ent, PRINT_CHAT, `${actor_names[other.s.number % MAX_ACTOR_NAMES]}: ${self.message}\n`);
    }
  }

  if (self.spawnflags & 1) {
    // jump
    other.velocity[0] = self.movedir[0] * self.speed;
    other.velocity[1] = self.movedir[1] * self.speed;

    if (other.groundentity !== null) {
      other.groundentity = null;
      other.velocity[2] = self.movedir[2];
      gi.sound(other, CHAN_VOICE, gi.soundindex("player/male/jump1.wav"), 1, ATTN_NORM, 0);
    }
  }

  if (self.spawnflags & 2) {
    // shoot
  } else if (self.spawnflags & 4) {
    // attack
    other.enemy = G_PickTarget(self.pathtarget);
    if (other.enemy !== null) {
      other.goalentity = other.enemy;
      if (self.spawnflags & 32) other.monsterinfo.aiflags |= AI_BRUTAL;
      if (self.spawnflags & 16) {
        other.monsterinfo.aiflags |= AI_STAND_GROUND;
        actor_stand(other);
      } else {
        actor_run(other);
      }
    }
  }

  if (!(self.spawnflags & 6) && self.pathtarget !== null) {
    const savetarget = self.target;
    self.target = self.pathtarget;
    G_UseTargets(self, other);
    self.target = savetarget;
  }

  other.movetarget = G_PickTarget(self.target);

  if (other.goalentity === null) other.goalentity = other.movetarget;

  if (other.movetarget === null && other.enemy === null) {
    other.monsterinfo.pausetime = level.time + 100000000;
    other.monsterinfo.stand?.(other);
  } else if (other.movetarget === other.goalentity && other.movetarget !== null) {
    VectorSubtract(other.movetarget.s.origin, other.s.origin, v);
    other.ideal_yaw = vectoyaw(v);
  }
}

export function SP_target_actor(self: EdictT): void {
  if (self.targetname === null) gi.dprintf(`${self.classname ?? ""} with no targetname at ${vtos(self.s.origin)}\n`);

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = target_actor_touch;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);
  self.svflags = SVF_NOCLIENT;

  if (self.spawnflags & 1) {
    if (!self.speed) self.speed = 200;
    if (!st.height) st.height = 200;
    if (self.s.angles[YAW] === 0) self.s.angles[YAW] = 360;
    G_SetMovedir(self.s.angles, self.movedir);
    self.movedir[2] = st.height;
  }

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

registerSaveFunction("m_actor:actor_pain", actor_pain);
registerSaveFunction("m_actor:actor_die", actor_die);
registerSaveFunction("m_actor:actor_use", actor_use);
registerSaveFunction("m_actor:target_actor_touch", target_actor_touch);
registerSaveFunction("m_actor:actor_stand", actor_stand);
registerSaveFunction("m_actor:actor_walk", actor_walk);
registerSaveFunction("m_actor:actor_run", actor_run);
registerSaveFunction("m_actor:actor_attack", actor_attack);
registerSaveMmove("m_actor:actor_move_stand", actor_move_stand);
registerSaveMmove("m_actor:actor_move_walk", actor_move_walk);
registerSaveMmove("m_actor:actor_move_run", actor_move_run);
registerSaveMmove("m_actor:actor_move_pain1", actor_move_pain1);
registerSaveMmove("m_actor:actor_move_pain2", actor_move_pain2);
registerSaveMmove("m_actor:actor_move_pain3", actor_move_pain3);
registerSaveMmove("m_actor:actor_move_flipoff", actor_move_flipoff);
registerSaveMmove("m_actor:actor_move_taunt", actor_move_taunt);
registerSaveMmove("m_actor:actor_move_death1", actor_move_death1);
registerSaveMmove("m_actor:actor_move_death2", actor_move_death2);
registerSaveMmove("m_actor:actor_move_attack", actor_move_attack);
