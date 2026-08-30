/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from xatrix/m_brain.c (GNU GPL v2 or later), diffed against the
baseq2 port at src/game/m_brain.ts.
*/
/*
==============================================================================

brain

==============================================================================
*/

import {
  AngleVectors,
  random,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorMA,
  VectorScale,
  VectorSet,
  VectorSubtract,
  VectorLength,
  type Vec3,
} from "../shared/math";
import { fixedLength } from "../shared/fixed";
import { ATTN_IDLE, ATTN_NORM, ATTN_STATIC, CHAN_AUTO, CHAN_BODY, CHAN_VOICE, CHAN_WEAPON, MASK_SHOT, MulticastT, TempEventT } from "../shared/q_shared";
import {
  AI_DUCKED,
  AI_HOLD_FRAME,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  g_edicts,
  gi,
  GIB_ORGANIC,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
  MOD_BRAINTENTACLE,
  DAMAGE_NO_KNOCKBACK,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
  RANGE_NEAR,
  svc_temp_entity,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER, type Edict } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range, visible } from "./g_ai";
import { fire_hit } from "./g_weapon";
import { monster_dabeam, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { T_Damage } from "./g_combat";
import * as FRAME from "./m_brain_frames";

// C's raw `#define` spawnflags bit brain_chest_open/brain_tentacle_attack/
// brain_chest_closed use directly (65536); not part of the shared spawnflags
// table so it stays a module-local literal, matching the C source's own
// unexplained magic number.
const BRAIN_CHEST_OPEN_FLAG = 65536;

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// trace_t.ent recovery idiom (see g_ai.ts's/g_monster.ts's/g_phys.ts's own
// copies of this same helper): sv_world.c defaults an unset trace.ent to the
// world edict, never NULL, so a null GTraceT.ent here falls back to
// g_edicts[0] the same way. Module-local per PORTING.md.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
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

let sound_chest_open = 0;
let sound_tentacles_extend = 0;
let sound_tentacles_retract = 0;
let sound_death = 0;
let sound_idle1 = 0;
let sound_idle2 = 0;
let sound_idle3 = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_melee1 = 0;
let sound_melee2 = 0;
let sound_melee3 = 0;

function brain_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function brain_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

//
// STAND
//

const brain_frames_stand: MframeT[] = [
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
const brain_move_stand = mkmove(FRAME.FRAME_stand01, FRAME.FRAME_stand30, brain_frames_stand, null);

function brain_stand(self: EdictT): void {
  self.monsterinfo.currentmove = brain_move_stand;
}

//
// IDLE
//

const brain_frames_idle: MframeT[] = [
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
const brain_move_idle = mkmove(FRAME.FRAME_stand31, FRAME.FRAME_stand60, brain_frames_idle, brain_stand);

function brain_idle(self: EdictT): void {
  gi.sound(self, CHAN_AUTO, sound_idle3, 1, ATTN_IDLE, 0);
  self.monsterinfo.currentmove = brain_move_idle;
}

//
// WALK
//

const brain_frames_walk1: MframeT[] = [
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, -4),
  mkframe(ai_walk, -1),
  mkframe(ai_walk, 2),
];
const brain_move_walk1 = mkmove(FRAME.FRAME_walk101, FRAME.FRAME_walk111, brain_frames_walk1, null);

// walk2 is FUBAR, do not use -- dropped with the C source's own #if 0 block
// (brain_walk2_cycle / brain_frames_walk2 / brain_move_walk2).

function brain_walk(self: EdictT): void {
  // if (random() <= 0.5)
  self.monsterinfo.currentmove = brain_move_walk1;
  // else
  // 	self->monsterinfo.currentmove = &brain_move_walk2;
}

const brain_frames_defense: MframeT[] = [
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
// C declares brain_move_defense but nothing in this file (or SP_monster_brain)
// ever assigns it to monsterinfo.currentmove; dead code in the original too.
// It also carries a second C bug independent of that: m_brain.c's
// brain_frames_defense[] has 9 rows but FRAME_defens01(154)..FRAME_defens08(161)
// only spans 8 (game/m_brain.c:244-256). Preserved byte-for-byte.
const brain_move_defense = mkmove(FRAME.FRAME_defens01, FRAME.FRAME_defens08, brain_frames_defense, null, true);

const brain_frames_pain3: MframeT[] = [
  mkframe(ai_move, -2),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 0),
  mkframe(ai_move, -4),
];
const brain_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain306, brain_frames_pain3, brain_run);

const brain_frames_pain2: MframeT[] = [
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move, -2),
];
const brain_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain208, brain_frames_pain2, brain_run);

const brain_frames_pain1: MframeT[] = [
  mkframe(ai_move, -6),
  mkframe(ai_move, -2),
  mkframe(ai_move, -6),
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
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 7),
  mkframe(ai_move, 0),
  mkframe(ai_move, 3),
  mkframe(ai_move, -1),
];
const brain_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain121, brain_frames_pain1, brain_run);

//
// DUCK
//

function brain_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  gi.linkentity(self);
}

function brain_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

function brain_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

const brain_frames_duck: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, -2, brain_duck_down),
  mkframe(ai_move, 17, brain_duck_hold),
  mkframe(ai_move, -3),
  mkframe(ai_move, -1, brain_duck_up),
  mkframe(ai_move, -5),
  mkframe(ai_move, -6),
  mkframe(ai_move, -6),
];
const brain_move_duck = mkmove(FRAME.FRAME_duck01, FRAME.FRAME_duck08, brain_frames_duck, brain_run);

function brain_dodge(self: EdictT, attacker: EdictT, eta: number): void {
  if (random() > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  self.monsterinfo.pausetime = level.time + eta + 0.5;
  self.monsterinfo.currentmove = brain_move_duck;
}

const brain_frames_death2: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 9), mkframe(ai_move, 0)];
const brain_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death205, brain_frames_death2, brain_dead);

const brain_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, 9),
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
const brain_move_death1 = mkmove(FRAME.FRAME_death101, FRAME.FRAME_death118, brain_frames_death1, brain_dead);

//
// MELEE
//

function brain_swing_right(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_melee1, 1, ATTN_NORM, 0);
}

function brain_hit_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, 15 + (Math.floor(Math.random() * 5) % 5), 40)) gi.sound(self, CHAN_WEAPON, sound_melee3, 1, ATTN_NORM, 0);
}

function brain_swing_left(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_melee2, 1, ATTN_NORM, 0);
}

function brain_hit_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, 15 + (Math.floor(Math.random() * 5) % 5), 40)) gi.sound(self, CHAN_WEAPON, sound_melee3, 1, ATTN_NORM, 0);
}

const brain_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -3, brain_swing_right),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -5),
  mkframe(ai_charge, -7, brain_hit_right),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 6, brain_swing_left),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 2, brain_hit_left),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -11),
];
const brain_move_attack1 = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak118, brain_frames_attack1, brain_run);

function brain_chest_open(self: EdictT): void {
  self.spawnflags &= ~BRAIN_CHEST_OPEN_FLAG;
  self.monsterinfo.power_armor_type = POWER_ARMOR_NONE;
  gi.sound(self, CHAN_BODY, sound_chest_open, 1, ATTN_NORM, 0);
}

function brain_tentacle_attack(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 8);
  if (fire_hit(self, aim, 10 + (Math.floor(Math.random() * 5) % 5), -600) && cvarNum(gameCvars.skill) > 0) self.spawnflags |= BRAIN_CHEST_OPEN_FLAG;
  gi.sound(self, CHAN_WEAPON, sound_tentacles_retract, 1, ATTN_NORM, 0);
}

function brain_chest_closed(self: EdictT): void {
  self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
  if (self.spawnflags & BRAIN_CHEST_OPEN_FLAG) {
    self.spawnflags &= ~BRAIN_CHEST_OPEN_FLAG;
    self.monsterinfo.currentmove = brain_move_attack1;
  }
}

const brain_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 5),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 0, brain_chest_open),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 13, brain_tentacle_attack),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, -9, brain_chest_closed),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, -6),
];
const brain_move_attack2 = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak217, brain_frames_attack2, brain_run);

function brain_melee(self: EdictT): void {
  if (random() <= 0.5) self.monsterinfo.currentmove = brain_move_attack1;
  else self.monsterinfo.currentmove = brain_move_attack2;
}

// xatrix/m_brain.c:494-731 -- ranged tongue-lunge / tentacle / laser-beam
// attack behavior added for the mission pack, gated behind
// monsterinfo.attack (commented out in baseq2, wired below in
// SP_monster_brain).

function brain_tounge_attack_ok(start: Vec3, end: Vec3): boolean {
  const dir = vec3();
  const angles = vec3();

  // check for max distance
  VectorSubtract(start, end, dir);
  if (VectorLength(dir) > 512) return false;

  // check for min/max pitch
  vectoangles(dir, angles);
  if (angles[0] < -180) angles[0] += 360;
  if (Math.abs(angles[0]) > 30) return false;

  return true;
}

function brain_tounge_attack(self: EdictT): void {
  if (self.enemy === null) return; // C dereferences self->enemy unconditionally here

  const offset = vec3();
  const start = vec3();
  const f = vec3();
  const r = vec3();
  const end = vec3();
  const dir = vec3();

  AngleVectors(self.s.angles, f, r, null);
  // VectorSet (offset, 24, 0, 6);
  VectorSet(offset, 24, 0, 16);
  G_ProjectSource(self.s.origin, offset, f, r, start);

  VectorCopy(self.enemy.s.origin, end);
  if (!brain_tounge_attack_ok(start, end)) {
    end[2] = self.enemy.s.origin[2] + self.enemy.maxs[2] - 8;
    if (!brain_tounge_attack_ok(start, end)) {
      end[2] = self.enemy.s.origin[2] + self.enemy.mins[2] + 8;
      if (!brain_tounge_attack_ok(start, end)) return;
    }
  }
  VectorCopy(self.enemy.s.origin, end);

  const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
  if (traceEdict(tr.ent) !== self.enemy) return;

  const damage = 5;
  gi.sound(self, CHAN_WEAPON, sound_tentacles_retract, 1, ATTN_NORM, 0);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_PARASITE_ATTACK);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  VectorSubtract(start, end, dir);
  T_Damage(self.enemy, self, self, dir, self.enemy.s.origin, vec3_origin, damage, 0, DAMAGE_NO_KNOCKBACK, MOD_BRAINTENTACLE);

  // pull the enemy in
  {
    const forward = vec3();
    self.s.origin[2] += 1;
    AngleVectors(self.s.angles, forward, null, null);
    VectorScale(forward, -1200, self.enemy.velocity);
  }
}

// Brain right/left eye centers, per-frame offsets for the laser-beam attack
// (xatrix/m_brain.c's `struct r_eyeball`/`struct l_eyeball` are one-off
// anonymous structs used only for these two tables; ported as a shared
// plain-object shape instead of duplicating the struct).
interface EyeballOffset {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// Brian right eye center
const brain_reye: readonly EyeballOffset[] = fixedLength("brain_reye", 11, [
  { x: 0.7467, y: 0.23837, z: 34.16769 },
  { x: -1.07639, y: 0.23837, z: 33.386372 },
  { x: -1.3355, y: 5.3343, z: 32.17717 },
  { x: -0.17536, y: 8.84637, z: 30.635479 },
  { x: -2.75759, y: 7.80461, z: 30.15086 },
  { x: -5.57509, y: 5.15284, z: 30.05616 },
  { x: -7.01755, y: 3.26247, z: 30.552521 },
  { x: -7.91574, y: 0.6388, z: 33.176189 },
  { x: -3.91539, y: 8.28573, z: 33.976349 },
  { x: -0.91354, y: 10.93303, z: 34.141811 },
  { x: -0.3699, y: 8.9239, z: 34.189079 },
]);

// Brain left eye center
const brain_leye: readonly EyeballOffset[] = fixedLength("brain_leye", 11, [
  { x: -3.36471, y: 0.32775, z: 33.938381 },
  { x: -5.14045, y: 0.49348, z: 32.659851 },
  { x: -5.34198, y: 5.64698, z: 31.277901 },
  { x: -4.13448, y: 9.27744, z: 29.925621 },
  { x: -6.59834, y: 6.81509, z: 29.32262 },
  { x: -8.61084, y: 2.52965, z: 29.251591 },
  { x: -9.23136, y: 0.09328, z: 29.747959 },
  { x: -11.00411, y: 1.93693, z: 32.39526 },
  { x: -7.87831, y: 7.64819, z: 33.148151 },
  { x: -4.94737, y: 11.43005, z: 33.31361 },
  { x: -4.33282, y: 9.44457, z: 33.52634 },
]);

// note to self
// need to get an x,y,z offset for
// each frame of the run cycle
function brain_laserbeam(self: EdictT): void {
  if (self.enemy === null) return; // C dereferences self->enemy unconditionally here

  // RAFAEL
  // cant call sound this frequent
  if (random() > 0.8) gi.sound(self, CHAN_AUTO, gi.soundindex("misc/lasfly.wav"), 1, ATTN_STATIC, 0);

  // check for max distance

  const start = vec3();
  const end = vec3();
  const dir = vec3();
  const angles = vec3();
  const tempang = vec3();

  VectorCopy(self.s.origin, start);
  VectorCopy(self.enemy.s.origin, end);
  VectorSubtract(end, start, dir);
  vectoangles(dir, angles);

  const eyeFrame = self.s.frame - FRAME.FRAME_walk101;

  // dis is my right eye
  {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    const ent = G_Spawn();
    VectorCopy(self.s.origin, ent.s.origin);
    VectorCopy(angles, tempang);
    AngleVectors(tempang, forward, right, up);
    VectorCopy(tempang, ent.s.angles);
    VectorCopy(ent.s.origin, start);
    VectorMA(start, brain_reye[eyeFrame].x, right, start);
    VectorMA(start, brain_reye[eyeFrame].y, forward, start);
    VectorMA(start, brain_reye[eyeFrame].z, up, start);
    VectorCopy(start, ent.s.origin);
    ent.enemy = self.enemy;
    ent.owner = self;
    ent.dmg = 1;
    monster_dabeam(ent);
  }

  // dis is me left eye
  {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    const ent = G_Spawn();
    VectorCopy(self.s.origin, ent.s.origin);
    VectorCopy(angles, tempang);
    AngleVectors(tempang, forward, right, up);
    VectorCopy(tempang, ent.s.angles);
    VectorCopy(ent.s.origin, start);
    VectorMA(start, brain_leye[eyeFrame].x, right, start);
    VectorMA(start, brain_leye[eyeFrame].y, forward, start);
    VectorMA(start, brain_leye[eyeFrame].z, up, start);
    VectorCopy(start, ent.s.origin);
    ent.enemy = self.enemy;
    ent.owner = self;
    ent.dmg = 1;
    monster_dabeam(ent);
  }
}

function brain_laserbeam_reattack(self: EdictT): void {
  if (random() < 0.5) {
    if (self.enemy !== null && visible(self, self.enemy)) {
      if (self.enemy.health > 0) self.s.frame = FRAME.FRAME_walk101;
    }
  }
}

// Row count re-verified by hand against FRAME_attak201(71)..FRAME_attak217(87)
// = 17 frames -- matches, no allowFrameCountMismatch needed. Reuses the same
// frame range as brain_move_attack2's melee tentacle animation, with a
// different callback table (tongue-lunge interleaved with chest open/close).
const brain_frames_attack3: MframeT[] = [
  mkframe(ai_charge, 5),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 0, brain_chest_open),
  mkframe(ai_charge, 0, brain_tounge_attack),
  mkframe(ai_charge, 13),
  mkframe(ai_charge, 0, brain_tentacle_attack),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0, brain_tounge_attack),
  mkframe(ai_charge, -9, brain_chest_closed),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, -6),
];
const brain_move_attack3 = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak217, brain_frames_attack3, brain_run);

// Row count re-verified by hand against FRAME_walk101(0)..FRAME_walk111(10)
// = 11 frames -- matches, no allowFrameCountMismatch needed. Reuses the same
// frame range as the walk/run cycle, firing the eye-beam every frame.
const brain_frames_attack4: MframeT[] = [
  mkframe(ai_charge, 9, brain_laserbeam),
  mkframe(ai_charge, 2, brain_laserbeam),
  mkframe(ai_charge, 3, brain_laserbeam),
  mkframe(ai_charge, 3, brain_laserbeam),
  mkframe(ai_charge, 1, brain_laserbeam),
  mkframe(ai_charge, 0, brain_laserbeam),
  mkframe(ai_charge, 0, brain_laserbeam),
  mkframe(ai_charge, 10, brain_laserbeam),
  mkframe(ai_charge, -4, brain_laserbeam),
  mkframe(ai_charge, -1, brain_laserbeam),
  mkframe(ai_charge, 2, brain_laserbeam_reattack),
];
const brain_move_attack4 = mkmove(FRAME.FRAME_walk101, FRAME.FRAME_walk111, brain_frames_attack4, brain_run);

// RAFAEL
function brain_attack(self: EdictT): void {
  if (self.enemy === null) return; // C dereferences self->enemy unconditionally here

  if (random() < 0.8) {
    const r = range(self, self.enemy);
    if (r === RANGE_NEAR) {
      if (random() < 0.5) self.monsterinfo.currentmove = brain_move_attack3;
      else self.monsterinfo.currentmove = brain_move_attack4;
    } else if (r > RANGE_NEAR) {
      self.monsterinfo.currentmove = brain_move_attack4;
    }
  }
}

//
// RUN
//

const brain_frames_run: MframeT[] = [
  mkframe(ai_run, 9),
  mkframe(ai_run, 2),
  mkframe(ai_run, 3),
  mkframe(ai_run, 3),
  mkframe(ai_run, 1),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, 10),
  mkframe(ai_run, -4),
  mkframe(ai_run, -1),
  mkframe(ai_run, 2),
];
const brain_move_run = mkmove(FRAME.FRAME_walk101, FRAME.FRAME_walk111, brain_frames_run, null);

function brain_run(self: EdictT): void {
  self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = brain_move_stand;
  else self.monsterinfo.currentmove = brain_move_run;
}

function brain_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  // xatrix/m_brain.c drops baseq2's "no pain anims in nightmare" early
  // return here (game/m_brain.c:764-765 vs xatrix/m_brain.c) -- nightmare
  // skill now plays pain animations for this monster.

  const r = random();
  if (r < 0.33) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = brain_move_pain1;
  } else if (r < 0.66) {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = brain_move_pain2;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = brain_move_pain3;
  }
}

function brain_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function brain_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  self.s.effects = 0;
  self.monsterinfo.power_armor_type = POWER_ARMOR_NONE;

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
  if (random() <= 0.5) self.monsterinfo.currentmove = brain_move_death1;
  else self.monsterinfo.currentmove = brain_move_death2;
}

/*QUAKED monster_brain (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_brain(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_chest_open = gi.soundindex("brain/brnatck1.wav");
  sound_tentacles_extend = gi.soundindex("brain/brnatck2.wav");
  sound_tentacles_retract = gi.soundindex("brain/brnatck3.wav");
  sound_death = gi.soundindex("brain/brndeth1.wav");
  sound_idle1 = gi.soundindex("brain/brnidle1.wav");
  sound_idle2 = gi.soundindex("brain/brnidle2.wav");
  sound_idle3 = gi.soundindex("brain/brnlens1.wav");
  sound_pain1 = gi.soundindex("brain/brnpain1.wav");
  sound_pain2 = gi.soundindex("brain/brnpain2.wav");
  sound_sight = gi.soundindex("brain/brnsght1.wav");
  sound_search = gi.soundindex("brain/brnsrch1.wav");
  sound_melee1 = gi.soundindex("brain/melee1.wav");
  sound_melee2 = gi.soundindex("brain/melee2.wav");
  sound_melee3 = gi.soundindex("brain/melee3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/brain/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 300;
  self.gib_health = -150;
  self.mass = 400;

  self.pain = brain_pain;
  self.die = brain_die;

  self.monsterinfo.stand = brain_stand;
  self.monsterinfo.walk = brain_walk;
  self.monsterinfo.run = brain_run;
  self.monsterinfo.dodge = brain_dodge;
  self.monsterinfo.attack = brain_attack;
  self.monsterinfo.melee = brain_melee;
  self.monsterinfo.sight = brain_sight;
  self.monsterinfo.search = brain_search;
  self.monsterinfo.idle = brain_idle;

  self.monsterinfo.power_armor_type = POWER_ARMOR_SCREEN;
  self.monsterinfo.power_armor_power = 100;

  gi.linkentity(self);

  self.monsterinfo.currentmove = brain_move_stand;
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

registerSaveFunction("m_brain:brain_pain", brain_pain);
registerSaveFunction("m_brain:brain_die", brain_die);
registerSaveFunction("m_brain:brain_stand", brain_stand);
registerSaveFunction("m_brain:brain_walk", brain_walk);
registerSaveFunction("m_brain:brain_run", brain_run);
registerSaveFunction("m_brain:brain_dodge", brain_dodge);
registerSaveFunction("m_brain:brain_attack", brain_attack);
registerSaveFunction("m_brain:brain_melee", brain_melee);
registerSaveFunction("m_brain:brain_sight", brain_sight);
registerSaveFunction("m_brain:brain_search", brain_search);
registerSaveFunction("m_brain:brain_idle", brain_idle);
registerSaveMmove("m_brain:brain_move_stand", brain_move_stand);
registerSaveMmove("m_brain:brain_move_idle", brain_move_idle);
registerSaveMmove("m_brain:brain_move_walk1", brain_move_walk1);
registerSaveMmove("m_brain:brain_move_defense", brain_move_defense);
registerSaveMmove("m_brain:brain_move_pain3", brain_move_pain3);
registerSaveMmove("m_brain:brain_move_pain2", brain_move_pain2);
registerSaveMmove("m_brain:brain_move_pain1", brain_move_pain1);
registerSaveMmove("m_brain:brain_move_duck", brain_move_duck);
registerSaveMmove("m_brain:brain_move_death2", brain_move_death2);
registerSaveMmove("m_brain:brain_move_death1", brain_move_death1);
registerSaveMmove("m_brain:brain_move_attack1", brain_move_attack1);
registerSaveMmove("m_brain:brain_move_attack2", brain_move_attack2);
registerSaveMmove("m_brain:brain_move_attack3", brain_move_attack3);
registerSaveMmove("m_brain:brain_move_attack4", brain_move_attack4);
registerSaveMmove("m_brain:brain_move_run", brain_move_run);
