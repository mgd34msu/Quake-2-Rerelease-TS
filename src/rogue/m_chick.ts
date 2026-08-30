/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_chick.c (GNU GPL v2 or later).

rogue/m_chick.c vs baseq2/m_chick.c: wires the chick into the pack's new
dodge/duck/sidestep/blindfire AI (monsterinfo.dodge = M_MonsterDodge from
g_newai.ts, custom chick_duck/chick_sidestep/chick_blocked, blindfire = true),
clears the dodge bit via monster_done_dodge at the start of chick_run/
chick_pain/chick_attack and on one run-frame callback, clears AI_DUCKED via
monster_duck_up on pain if currently ducked, clears AI_MANUAL_STEERING
(blindfire signal) on pain and at the top of chick_rerocket, adds a blind-fire
branch to chick_attack (checked via monsterinfo.attack_state === AS_BLIND),
and rewrites ChickRocket with blindfire targeting/leading and a
trace-then-shift-left-then-shift-right retry ladder against MASK_SHOT. The
model changes from "models/monsters/bitch/tris.md2" to
"models/monsters/bitch2/tris.md2". The pack's own custom chick_dodge
function is left inside a C block comment in rogue/m_chick.c (dead code,
entirely superseded by M_MonsterDodge) and a dead `#define LEAD_TARGET 1` --
neither is ported, matching the source's own inert state.
*/
/*
==============================================================================

chick

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
import { ATTN_IDLE, ATTN_NORM, CHAN_VOICE, CHAN_WEAPON, MASK_SHOT, MZ2_CHICK_ROCKET_1 } from "../shared/q_shared";
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
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_MELEE,
  g_edicts,
  world,
} from "./g_local";
import { type Edict, SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range, visible } from "./g_ai";
import { fire_hit } from "./g_weapon";
import { monster_done_dodge, monster_fire_rocket, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
// ROGUE -- the pack's shared dodge/duck AI helpers (g_newai.c -- RG-systems' SCOPE)
import { blocked_checkplat, blocked_checkshot, M_MonsterDodge, monster_duck_down, monster_duck_hold, monster_duck_up } from "./g_newai";
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

// trace_t.ent recovery idiom (see g_monster.ts's traceEdict): sv_world.c
// defaults an unset trace.ent to the world edict, never NULL, so a null
// GTraceT.ent here falls back to g_edicts[0] the same way. Module-local per
// PORTING.md (each ported file that needs it keeps its own copy).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
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

// ROGUE: one run frame now clears the dodge bit ("make sure to clear dodge bit")
const chick_frames_run: MframeT[] = [
  mkframe(ai_run, 6),
  mkframe(ai_run, 8),
  mkframe(ai_run, 13),
  mkframe(ai_run, 5, monster_done_dodge),
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
  // ROGUE
  monster_done_dodge(self);
  // ROGUE

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
  // ROGUE
  monster_done_dodge(self);
  // ROGUE

  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  const r = random();
  if (r < 0.33) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else if (r < 0.66) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NORM, 0);

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // ROGUE -- clear this from blindfire
  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
  // ROGUE

  if (damage <= 10) self.monsterinfo.currentmove = chick_move_pain1;
  else if (damage <= 25) self.monsterinfo.currentmove = chick_move_pain2;
  else self.monsterinfo.currentmove = chick_move_pain3;

  // ROGUE -- clear duck flag
  if (self.monsterinfo.aiflags & AI_DUCKED) monster_duck_up(self);
  // ROGUE
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

// ROGUE -- PMM - changes to duck code for new dodge
const chick_frames_duck: MframeT[] = [
  mkframe(ai_move, 0, monster_duck_down),
  mkframe(ai_move, 1),
  mkframe(ai_move, 4, monster_duck_hold),
  mkframe(ai_move, -4),
  mkframe(ai_move, -5, monster_duck_up),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
];
const chick_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck07, chick_frames_duck, chick_run);

// rogue/m_chick.c's own custom chick_dodge (edict_t*, edict_t*, float, trace_t*)
// is left entirely inside a `/* ... */` C block comment -- dead code, never
// compiled, fully superseded by g_newai.c's generic M_MonsterDodge (wired in
// SP_monster_chick below). Not ported, matching the source's own inert state.

function ChickSlash(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 10);
  gi.sound(self, CHAN_WEAPON, sound_melee_swing, 1, ATTN_NORM, 0);
  fire_hit(self, aim, 10 + (Math.floor(Math.random() * 6) % 6), 100);
}

// ROGUE -- rewritten with blindfire targeting/leading and a trace-then-shift
// retry ladder (see file header comment).
function ChickRocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();
  const target = vec3();

  const blindfire = (self.monsterinfo.aiflags & AI_MANUAL_STEERING) !== 0;

  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CHICK_ROCKET_1], forward, right, start);

  // PGM rock & roll.... :)
  const rocketSpeed = (500 + 100 * cvarNum(gameCvars.skill)) | 0;

  // PMM
  if (blindfire) VectorCopy(self.monsterinfo.blind_fire_target, target);
  else VectorCopy(self.enemy.s.origin, target);
  // pmm

  // PMM - blindfire shooting
  if (blindfire) {
    VectorCopy(target, vec);
    VectorSubtract(vec, start, dir);
  } else if (random() < 0.33 || start[2] < self.enemy.absmin[2]) {
    // don't shoot at feet if they're above where i'm shooting from.
    VectorCopy(target, vec);
    vec[2] += self.enemy.viewheight;
    VectorSubtract(vec, start, dir);
  } else {
    VectorCopy(target, vec);
    vec[2] = self.enemy.absmin[2];
    VectorSubtract(vec, start, dir);
  }

  // PMM - lead target (not when blindfiring)
  // 20, 35, 50, 65 chance of leading
  if (!blindfire && random() < 0.2 + (3 - cvarNum(gameCvars.skill)) * 0.15) {
    const dist = VectorLength(dir);
    const time = dist / rocketSpeed;
    VectorMA(vec, time, self.enemy.velocity, vec);
    VectorSubtract(vec, start, dir);
  }
  // PMM - lead target

  VectorNormalize(dir);

  // pmm blindfire doesn't check target (done in checkattack)
  // paranoia, make sure we're not shooting a target right next to us
  let trace = gi.trace(start, vec3_origin, vec3_origin, vec, self, MASK_SHOT);
  if (blindfire) {
    // blindfire has different fail criteria for the trace
    if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
      monster_fire_rocket(self, start, dir, 50, rocketSpeed, MZ2_CHICK_ROCKET_1);
    } else {
      // geez, this is bad.  she's avoiding about 80% of her blindfires due to hitting things.
      // hunt around for a good shot
      // try shifting the target to the left a little (to help counter her large offset)
      VectorCopy(target, vec);
      VectorMA(vec, -10, right, vec);
      VectorSubtract(vec, start, dir);
      VectorNormalize(dir);
      trace = gi.trace(start, vec3_origin, vec3_origin, vec, self, MASK_SHOT);
      if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
        monster_fire_rocket(self, start, dir, 50, rocketSpeed, MZ2_CHICK_ROCKET_1);
      } else {
        // ok, that failed.  try to the right
        VectorCopy(target, vec);
        VectorMA(vec, 10, right, vec);
        VectorSubtract(vec, start, dir);
        VectorNormalize(dir);
        trace = gi.trace(start, vec3_origin, vec3_origin, vec, self, MASK_SHOT);
        if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
          monster_fire_rocket(self, start, dir, 50, rocketSpeed, MZ2_CHICK_ROCKET_1);
        }
      }
    }
  } else {
    trace = gi.trace(start, vec3_origin, vec3_origin, vec, self, MASK_SHOT);
    const hitEnt = traceEdict(trace.ent);
    if (hitEnt === self.enemy || hitEnt === world()) {
      if (trace.fraction > 0.5 || hitEnt.client !== null) {
        monster_fire_rocket(self, start, dir, 50, rocketSpeed, MZ2_CHICK_ROCKET_1);
      }
    }
  }
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
  // ROGUE
  if (self.monsterinfo.aiflags & AI_MANUAL_STEERING) {
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    self.monsterinfo.currentmove = chick_move_end_attack1;
    return;
  }
  // ROGUE

  if (self.enemy !== null && self.enemy.health > 0) {
    if (range(self, self.enemy) > RANGE_MELEE) {
      if (visible(self, self.enemy)) {
        // ROGUE: skill-scaled reattack chance (was a flat 0.6)
        if (random() <= 0.6 + 0.05 * cvarNum(gameCvars.skill)) {
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
    self.monsterinfo.blind_fire_delay += 4.0 + 1.5 + random();

    // don't shoot at the origin
    if (VectorCompare(self.monsterinfo.blind_fire_target, vec3_origin) !== 0) return;

    // don't shoot if the dice say not to
    if (r > chance) return;

    // turn on manual steering to signal both manual steering and blindfire
    self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
    self.monsterinfo.currentmove = chick_move_start_attack1;
    self.monsterinfo.attack_finished = level.time + 2 * random();
    return;
  }
  // pmm
  // ROGUE

  self.monsterinfo.currentmove = chick_move_start_attack1;
}

function chick_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

// ROGUE
//===========
//PGM
function chick_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  if (blocked_checkplat(self, dist)) return true;

  return false;
}
//PGM
//===========

function chick_duck(self: EdictT, eta: number): void {
  if (self.monsterinfo.currentmove === chick_move_start_attack1 || self.monsterinfo.currentmove === chick_move_attack1) {
    // if we're shooting, and not on easy, don't dodge
    if (cvarNum(gameCvars.skill) !== 0) {
      self.monsterinfo.aiflags &= ~AI_DUCKED;
      return;
    }
  }

  if (cvarNum(gameCvars.skill) === 0) {
    // PMM - stupid dodge
    self.monsterinfo.duck_wait_time = level.time + eta + 1;
  } else {
    self.monsterinfo.duck_wait_time = level.time + eta + 0.1 * (3 - cvarNum(gameCvars.skill));
  }

  // has to be done immediately otherwise she can get stuck
  monster_duck_down(self);

  self.monsterinfo.nextframe = FRAME.FRAME_duck01;
  self.monsterinfo.currentmove = chick_move_duck;
}

function chick_sidestep(self: EdictT): void {
  if (self.monsterinfo.currentmove === chick_move_start_attack1 || self.monsterinfo.currentmove === chick_move_attack1) {
    // if we're shooting, and not on easy, don't dodge
    if (cvarNum(gameCvars.skill) !== 0) {
      self.monsterinfo.aiflags &= ~AI_DODGING;
      return;
    }
  }

  if (self.monsterinfo.currentmove !== chick_move_run) self.monsterinfo.currentmove = chick_move_run;
}
// ROGUE

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
  // ROGUE: "bitch/tris.md2" -> "bitch2/tris.md2"
  self.s.modelindex = gi.modelindex("models/monsters/bitch2/tris.md2");
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
  // ROGUE -- pmm
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = chick_duck;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = chick_sidestep;
  // ROGUE
  self.monsterinfo.attack = chick_attack;
  self.monsterinfo.melee = chick_melee;
  self.monsterinfo.sight = chick_sight;
  self.monsterinfo.blocked = chick_blocked; // PGM

  gi.linkentity(self);

  self.monsterinfo.currentmove = chick_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  // ROGUE -- PMM
  self.monsterinfo.blindfire = true;
  // ROGUE

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

registerSaveFunction("m_chick:chick_pain", chick_pain);
registerSaveFunction("m_chick:chick_die", chick_die);
registerSaveFunction("m_chick:chick_stand", chick_stand);
registerSaveFunction("m_chick:chick_walk", chick_walk);
registerSaveFunction("m_chick:chick_run", chick_run);
registerSaveFunction("m_chick:chick_attack", chick_attack);
registerSaveFunction("m_chick:chick_melee", chick_melee);
registerSaveFunction("m_chick:chick_sight", chick_sight);
registerSaveFunction("m_chick:chick_blocked", chick_blocked);
registerSaveFunction("m_chick:chick_duck", chick_duck);
registerSaveFunction("m_chick:chick_sidestep", chick_sidestep);
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
