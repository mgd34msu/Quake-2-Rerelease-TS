// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
// Ported from rogue/m_widow.c (GNU GPL v2 or later).
/*
==============================================================================

black widow

==============================================================================
*/

// self.timestamp is used to prevent rapid fire of the railgun (base EdictT
// field). self.plat2flags is declared in the C header comment as "used for
// fire count (flashes)" but no code in m_widow.c ever reads or writes it --
// grep of the whole file confirms zero live references, so it is not
// touched here either (kept as the rogue-only EdictT field it already is,
// for the benefit of any future code that keys off it).
// self.monsterinfo.pausetime is used for timing of blaster shots.
//
// Deviations from a literal transliteration, documented per PORTING.md:
// - `BossExplode` is forward-declared at the top of m_widow.c (matching the
//   other rogue boss files, m_boss2.c/m_boss31.c/m_carrier.c/m_supertank.c,
//   which each define and use it locally) but m_widow.c itself never
//   defines a body for it and never assigns it to any think/die/endfunc --
//   grep of the file confirms only the forward declaration exists. Not
//   ported: there is nothing to port, and inventing a body would not be a
//   translation of this C file.
// - `drawbbox` and `showme` are fully defined in m_widow.c but every call
//   site is inside a `/* ... */` block comment (m_widow.c:239-252,
//   322-337) or behind the `DRAWBBOX`/`SHOWME` macros which are themselves
//   `#define`d to NULL (m_widow.c:25-26) -- both functions are dead code in
//   the shipped binary. Ported verbatim anyway (they have real bodies) but
//   never wired to anything, matching the original.
// - `widow_dead`, `widow_start_run_5`, `widow_start_run_10` are fully
//   defined and forward-declared but never assigned or called anywhere in
//   m_widow.c (grep confirms each name appears exactly twice: its forward
//   declaration and its own definition). Ported verbatim as dead code,
//   matching the original binary.
// - `sound_sight` (`static int sound_sight;`) is declared but its one
//   assignment in SP_monster_widow and its one read in widow_sight are both
//   commented out in the C -- dropped entirely (nothing live references it).
// - Several `self->enemy->`/`other->client->` dereferences in the C assume
//   a non-null pointer without checking (target_angle, WidowSaveLoc,
//   widow_attack_kick, WidowPowerups, WidowRespondPowerup); EdictT.enemy and
//   EdictT.client are nullable types here, so each such site gets a
//   type-narrowing guard at the actual dereference point (landmine #4)
//   instead of an unchecked access. This only matters if the invariant the
//   C silently relies on (enemy/client is already set by the caller) is
//   ever violated; behavior is identical whenever it holds, which is always
//   in the C's own call graph.
// - `WidowTorso`'s enemy_yaw ladder and `WidowRail`'s `flash` selection each
//   have a C code path with no corresponding return/assignment (the C
//   compiler accepted this; falling through returns garbage). Both are
//   provably unreachable given the surrounding guards (see the inline
//   comments at each site) -- TypeScript requires a value on every path, so
//   each gets the same safe sentinel the surrounding code already treats as
//   "did not happen" (WidowTorso: 0, the same sentinel its caller already
//   substitutes self.s.frame for; WidowRail: MZ2_WIDOW_RAIL, the plain
//   version of the three flashes it's choosing between).
// - `widow_move_run`'s mmove_t literally spans {FRAME_walk01, FRAME_walk13}
//   in the C (m_widow.c:543), not {FRAME_run01, FRAME_run08} despite the
//   frame array being named `widow_frames_run` -- kept exactly as written,
//   not a transcription error on this port's part.
// - `stalker_mins`/`stalker_maxs` are non-static globals in the C (unlike
//   every other module-scope table in this file) because rogue/m_widow2.c
//   references them via `extern vec3_t stalker_mins, stalker_maxs;` --
//   exported here for that reason.

import { AngleVectors, random, vec3, VectorClear, VectorCopy, VectorMA, VectorNormalize, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_BODY,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  type CvarT,
  EF_BLASTER,
  EF_DOUBLE,
  EF_PENT,
  EF_QUAD,
  MulticastT,
  MZ2_WIDOW_BLASTER_0,
  MZ2_WIDOW_BLASTER_100,
  MZ2_WIDOW_BLASTER_SWEEP1,
  MZ2_WIDOW_RAIL,
  MZ2_WIDOW_RAIL_LEFT,
  MZ2_WIDOW_RAIL_RIGHT,
  MZ2_WIDOW_RUN_1,
  PITCH,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, FoundTarget, infront, range } from "./g_ai";
import {
  AI_BLOCKED,
  AI_DO_NOT_COUNT,
  AI_HOLD_FRAME,
  AI_IGNORE_SHOTS,
  AI_MANUAL_STEERING,
  AI_SPAWNED_WIDOW,
  AI_STAND_GROUND,
  AI_TARGET_ANGER,
  AS_BLIND,
  AS_MELEE,
  AS_MISSILE,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_IMMUNE_LASER,
  game,
  gameCvars,
  g_edicts,
  gi,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MovetypeT,
  POWER_ARMOR_SHIELD,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
  svc_temp_entity,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { CountPlayers, PickCoopTarget, PredictAim, blocked_checkshot, realrange } from "./g_newai";
import { G_FreeEdict, G_ProjectSource, G_ProjectSource2, vectoangles2, vectoyaw2 } from "./g_utils";
import { CreateGroundMonster, FindSpawnPoint, SpawnGrow_Spawn, Widowlegs_Spawn } from "./g_spawn";
import { fire_hit } from "./g_weapon";
import { monster_fire_blaster2, monster_fire_railgun, walkmonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import * as F from "./m_widow_frames";

// mirrors m_gladiator.ts's own `cvarNum` (module-local there too, so not
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

// max # of stalkers she can spawn -- not read anywhere else in m_widow.c
// (the actual spawn loops below are hardcoded `for (i=0; i<2; i++)` over
// the two spawnpoints), preserved for documentation as the C's own #define.
const NUM_STALKERS_SPAWNED = 6;

const RAIL_TIME = 3;
const BLASTER_TIME = 2;
const BLASTER2_DAMAGE = 10;
const WIDOW_RAIL_DAMAGE = 50;
const VARIANCE = 15.0;

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_search1 = 0;
let sound_rail = 0;

let shotsfired = 0;

const spawnpoints: readonly Vec3[] = fixedLength("spawnpoints", 2, [vec3(30, 100, 16), vec3(30, -100, 16)]);

const beameffects: readonly Vec3[] = fixedLength("beameffects", 2, [
  vec3(12.58, -43.71, 68.88),
  vec3(3.43, 58.72, 68.41),
]);

// sweep_angles[] -- the C keeps the original hand-tuned row (32.0, 26.0,
// 20.0, 11.5, 3.0, -8.0, -13.0, -27.0, -41.0) commented out directly above
// the live array; only the live row below is ported.
const sweep_angles: readonly number[] = fixedLength("sweep_angles", 9, [
  32.0, 26.0, 20.0, 10.0, 0.0, -6.5, -13.0, -27.0, -41.0,
]);

// non-static in the C -- rogue/m_widow2.c references both via `extern`.
export const stalker_mins: Vec3 = vec3(-28, -28, -18);
export const stalker_maxs: Vec3 = vec3(28, 28, 18);

let widow_damage_multiplier = 0;

function showme(self: EdictT): void {
  gi.dprintf(`frame ${self.s.frame}\n`);
}

function widow_search(_self: EdictT): void {
  // C body is fully commented out (`if (random() < 0.5) gi.sound(...)`).
}

function widow_sight(self: EdictT, _other: EdictT): void {
  self.monsterinfo.pausetime = 0;
}

function target_angle(self: EdictT): number {
  const enemy = self.enemy;
  if (enemy === null) return 0; // C assumes self->enemy is set at every call site

  const target = vec3();
  VectorSubtract(self.s.origin, enemy.s.origin, target);
  let enemy_yaw = self.s.angles[YAW] - vectoyaw2(target);
  if (enemy_yaw < 0) enemy_yaw += 360.0;

  // this gets me 0 degrees = forward
  enemy_yaw -= 180.0;
  // positive is to right, negative to left

  return enemy_yaw;
}

function WidowTorso(self: EdictT): number {
  const enemy_yaw = target_angle(self);

  if (enemy_yaw >= 105) {
    self.monsterinfo.currentmove = widow_move_attack_post_blaster_r;
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    return 0;
  }

  if (enemy_yaw <= -75.0) {
    self.monsterinfo.currentmove = widow_move_attack_post_blaster_l;
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    return 0;
  }

  if (enemy_yaw >= 95) return F.FRAME_fired03;
  if (enemy_yaw >= 85) return F.FRAME_fired04;
  if (enemy_yaw >= 75) return F.FRAME_fired05;
  if (enemy_yaw >= 65) return F.FRAME_fired06;
  if (enemy_yaw >= 55) return F.FRAME_fired07;
  if (enemy_yaw >= 45) return F.FRAME_fired08;
  if (enemy_yaw >= 35) return F.FRAME_fired09;
  if (enemy_yaw >= 25) return F.FRAME_fired10;
  if (enemy_yaw >= 15) return F.FRAME_fired11;
  if (enemy_yaw >= 5) return F.FRAME_fired12;
  if (enemy_yaw >= -5) return F.FRAME_fired13;
  if (enemy_yaw >= -15) return F.FRAME_fired14;
  if (enemy_yaw >= -25) return F.FRAME_fired15;
  if (enemy_yaw >= -35) return F.FRAME_fired16;
  if (enemy_yaw >= -45) return F.FRAME_fired17;
  if (enemy_yaw >= -55) return F.FRAME_fired18;
  if (enemy_yaw >= -65) return F.FRAME_fired19;
  if (enemy_yaw >= -75) return F.FRAME_fired20;

  // C has no trailing return here (falls through the else-if ladder);
  // unreachable given the two early guards above bound enemy_yaw to the
  // open interval (-75, 105), which this ladder covers exhaustively in
  // steps of 10 down to -75. 0 matches the sentinel WidowBlaster's caller
  // already substitutes self.s.frame for (m_widow.c:264-265).
  return 0;
}

function WidowBlaster(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  shotsfired++;
  const effect = shotsfired % 4 === 0 ? EF_BLASTER : 0;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  const start = vec3();

  if (self.s.frame >= F.FRAME_spawn05 && self.s.frame <= F.FRAME_spawn13) {
    // sweep
    const flashnum = MZ2_WIDOW_BLASTER_SWEEP1 + self.s.frame - F.FRAME_spawn05;
    G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);
    const target = vec3();
    VectorSubtract(enemy.s.origin, start, target);
    const targ_angles = vec3();
    vectoangles2(target, targ_angles);

    const vec = vec3();
    VectorCopy(self.s.angles, vec);

    vec[PITCH] += targ_angles[PITCH];
    vec[YAW] -= sweep_angles[flashnum - MZ2_WIDOW_BLASTER_SWEEP1];

    AngleVectors(vec, forward, null, null);
    monster_fire_blaster2(self, start, forward, BLASTER2_DAMAGE * widow_damage_multiplier, 1000, flashnum, effect);
  } else if (self.s.frame >= F.FRAME_fired02a && self.s.frame <= F.FRAME_fired20) {
    self.monsterinfo.aiflags |= AI_MANUAL_STEERING;

    self.monsterinfo.nextframe = WidowTorso(self);
    if (!self.monsterinfo.nextframe) self.monsterinfo.nextframe = self.s.frame;

    const flashnum =
      self.s.frame === F.FRAME_fired02a ? MZ2_WIDOW_BLASTER_0 : MZ2_WIDOW_BLASTER_100 + self.s.frame - F.FRAME_fired03;

    G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);

    PredictAim(enemy, start, 1000, true, random() * 0.1 - 0.05, forward, null);

    // clamp it to within 10 degrees of the aiming angle (where she's facing)
    const angles = vec3();
    vectoangles2(forward, angles);
    // give me 100 -> -70
    let aim_angle = 100 - 10 * (flashnum - MZ2_WIDOW_BLASTER_100);
    if (aim_angle <= 0) aim_angle += 360;
    // renamed from the C's `target_angle` local (which shadows this file's
    // top-level target_angle() function -- legal in C, not attempted here).
    let targetAngleDeg = self.s.angles[YAW] - angles[YAW];
    if (targetAngleDeg <= 0) targetAngleDeg += 360;

    const error = aim_angle - targetAngleDeg;

    // positive error is to entity's left, aka positive direction in engine
    // unfortunately, I decided that for the aim_angle, positive was right.
    if (error > VARIANCE) {
      angles[YAW] = self.s.angles[YAW] - aim_angle + VARIANCE;
      AngleVectors(angles, forward, null, null);
    } else if (error < -VARIANCE) {
      angles[YAW] = self.s.angles[YAW] - aim_angle - VARIANCE;
      AngleVectors(angles, forward, null, null);
    }

    monster_fire_blaster2(self, start, forward, BLASTER2_DAMAGE * widow_damage_multiplier, 1000, flashnum, effect);
  } else if (self.s.frame >= F.FRAME_run01 && self.s.frame <= F.FRAME_run08) {
    const flashnum = MZ2_WIDOW_RUN_1 + self.s.frame - F.FRAME_run01;
    G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);

    const target = vec3();
    VectorSubtract(enemy.s.origin, start, target);
    target[2] += enemy.viewheight;

    monster_fire_blaster2(self, start, target, BLASTER2_DAMAGE * widow_damage_multiplier, 1000, flashnum, effect);
  }
}

function WidowSpawn(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = vec3();
    VectorCopy(spawnpoints[i], offset);

    const startpoint = vec3();
    G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

    const spawnpoint = vec3();
    if (!FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, spawnpoint, 64)) continue;

    const ent = CreateGroundMonster(spawnpoint, self.s.angles, stalker_mins, stalker_maxs, "monster_stalker", 256);
    if (ent === null) continue;

    self.monsterinfo.monster_used++;
    ent.monsterinfo.commander = self;

    ent.nextthink = level.time;
    if (ent.think !== null) ent.think(ent);

    ent.monsterinfo.aiflags |= AI_SPAWNED_WIDOW | AI_DO_NOT_COUNT | AI_IGNORE_SHOTS;

    let designated_enemy: EdictT | null;
    if (cvarNum(gameCvars.coop) === 0) {
      designated_enemy = self.enemy;
    } else {
      designated_enemy = PickCoopTarget(ent);
      if (designated_enemy !== null) {
        // try to avoid using my enemy
        if (designated_enemy === self.enemy) {
          designated_enemy = PickCoopTarget(ent);
          if (designated_enemy === null) {
            designated_enemy = self.enemy;
          }
        }
      } else {
        designated_enemy = self.enemy;
      }
    }

    if (designated_enemy !== null && designated_enemy.inuse && designated_enemy.health > 0) {
      ent.enemy = designated_enemy;
      FoundTarget(ent);
      if (ent.monsterinfo.attack !== null) ent.monsterinfo.attack(ent);
    }
  }
}

function widow_spawn_check(self: EdictT): void {
  WidowBlaster(self);
  WidowSpawn(self);
}

function widow_ready_spawn(self: EdictT): void {
  WidowBlaster(self);
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = vec3();
    VectorCopy(spawnpoints[i], offset);
    const startpoint = vec3();
    G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);
    const spawnpoint = vec3();
    if (FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, spawnpoint, 64)) {
      SpawnGrow_Spawn(spawnpoint, 1);
    }
  }
}

function widow_step(self: EdictT): void {
  gi.sound(self, CHAN_BODY, gi.soundindex("widow/bwstep3.wav"), 1, ATTN_NORM, 0);
}

const widow_frames_stand: MframeT[] = Array.from({ length: 11 }, () => mf(ai_stand, 0, null));
const widow_move_stand = mkmove(F.FRAME_idle01, F.FRAME_idle11, widow_frames_stand, null);

// hand-generated numbers commented out in the C (a slower, hand-tuned set of
// distances) in favor of the auto-generated set actually shipped -- only the
// live values are ported.
const widow_frames_walk: MframeT[] = [
  mf(ai_walk, 2.79, widow_step),
  mf(ai_walk, 2.77, null),
  mf(ai_walk, 3.53, null),
  mf(ai_walk, 3.97, null),
  mf(ai_walk, 4.13, null),
  mf(ai_walk, 4.09, null),
  mf(ai_walk, 3.84, null),
  mf(ai_walk, 3.62, widow_step),
  mf(ai_walk, 3.29, null),
  mf(ai_walk, 6.08, null),
  mf(ai_walk, 6.94, null),
  mf(ai_walk, 5.73, null),
  mf(ai_walk, 2.85, null),
];
const widow_move_walk = mkmove(F.FRAME_walk01, F.FRAME_walk13, widow_frames_walk, null);

const widow_frames_run: MframeT[] = [
  mf(ai_run, 2.79, widow_step),
  mf(ai_run, 2.77, null),
  mf(ai_run, 3.53, null),
  mf(ai_run, 3.97, null),
  mf(ai_run, 4.13, null),
  mf(ai_run, 4.09, null),
  mf(ai_run, 3.84, null),
  mf(ai_run, 3.62, widow_step),
  mf(ai_run, 3.29, null),
  mf(ai_run, 6.08, null),
  mf(ai_run, 6.94, null),
  mf(ai_run, 5.73, null),
  mf(ai_run, 2.85, null),
];
// C bug, not a porting error: m_widow.c:543's widow_move_run mmove_t
// literally spans {FRAME_walk01, FRAME_walk13}, not {FRAME_run01,
// FRAME_run08}, even though the frame array above is named
// widow_frames_run -- preserved byte-for-byte.
const widow_move_run = mkmove(F.FRAME_walk01, F.FRAME_walk13, widow_frames_run, null);

function widow_stepshoot(self: EdictT): void {
  gi.sound(self, CHAN_BODY, gi.soundindex("widow/bwstep2.wav"), 1, ATTN_NORM, 0);
  WidowBlaster(self);
}

const widow_frames_run_attack: MframeT[] = [
  mf(ai_charge, 13, widow_stepshoot),
  mf(ai_charge, 11.72, WidowBlaster),
  mf(ai_charge, 18.04, WidowBlaster),
  mf(ai_charge, 14.58, WidowBlaster),
  mf(ai_charge, 13, widow_stepshoot),
  mf(ai_charge, 12.12, WidowBlaster),
  mf(ai_charge, 19.63, WidowBlaster),
  mf(ai_charge, 11.37, WidowBlaster),
];
const widow_move_run_attack = mkmove(F.FRAME_run01, F.FRAME_run08, widow_frames_run_attack, widow_run);

//
// These three allow specific entry into the run sequence
//

function widow_start_run_5(self: EdictT): void {
  self.monsterinfo.currentmove = widow_move_run;
  self.monsterinfo.nextframe = F.FRAME_walk05;
}

function widow_start_run_10(self: EdictT): void {
  self.monsterinfo.currentmove = widow_move_run;
  self.monsterinfo.nextframe = F.FRAME_walk10;
}

function widow_start_run_12(self: EdictT): void {
  self.monsterinfo.currentmove = widow_move_run;
  self.monsterinfo.nextframe = F.FRAME_walk12;
}

function widow_attack_blaster(self: EdictT): void {
  self.monsterinfo.pausetime = level.time + 1.0 + 2.0 * random();
  self.monsterinfo.currentmove = widow_move_attack_blaster;
  self.monsterinfo.nextframe = WidowTorso(self);
}

const widow_frames_attack_pre_blaster: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_attack_blaster),
];
const widow_move_attack_pre_blaster = mkmove(F.FRAME_fired01, F.FRAME_fired02a, widow_frames_attack_pre_blaster, null);

function widow_reattack_blaster(self: EdictT): void {
  WidowBlaster(self);

  // if WidowBlaster bailed us out of the frames, just bail
  if (self.monsterinfo.currentmove === widow_move_attack_post_blaster_l || self.monsterinfo.currentmove === widow_move_attack_post_blaster_r) {
    return;
  }

  // if we're not done with the attack, don't leave the sequence
  if (self.monsterinfo.pausetime >= level.time) return;

  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;

  self.monsterinfo.currentmove = widow_move_attack_post_blaster;
}

// Loop this
const widow_frames_attack_blaster: MframeT[] = [
  mf(ai_charge, 0, widow_reattack_blaster), // straight ahead
  mf(ai_charge, 0, widow_reattack_blaster), // 100 degrees right
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster), // 50 degrees right
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster), // straight
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster), // 50 degrees left
  mf(ai_charge, 0, widow_reattack_blaster),
  mf(ai_charge, 0, widow_reattack_blaster), // 70 degrees left
];
const widow_move_attack_blaster = mkmove(F.FRAME_fired02a, F.FRAME_fired20, widow_frames_attack_blaster, null);

const widow_frames_attack_post_blaster: MframeT[] = [mf(ai_charge, 0, null), mf(ai_charge, 0, null)];
const widow_move_attack_post_blaster = mkmove(F.FRAME_fired21, F.FRAME_fired22, widow_frames_attack_post_blaster, widow_run);

const widow_frames_attack_post_blaster_r: MframeT[] = [
  mf(ai_charge, -2, null),
  mf(ai_charge, -10, null),
  mf(ai_charge, -2, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_start_run_12),
];
const widow_move_attack_post_blaster_r = mkmove(F.FRAME_transa01, F.FRAME_transa05, widow_frames_attack_post_blaster_r, null);

const widow_frames_attack_post_blaster_l: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 14, null),
  mf(ai_charge, -2, null),
  mf(ai_charge, 10, null),
  mf(ai_charge, 10, widow_start_run_12),
];
const widow_move_attack_post_blaster_l = mkmove(F.FRAME_transb01, F.FRAME_transb05, widow_frames_attack_post_blaster_l, null);

function WidowRail(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  let flash: number;
  if (self.monsterinfo.currentmove === widow_move_attack_rail) flash = MZ2_WIDOW_RAIL;
  else if (self.monsterinfo.currentmove === widow_move_attack_rail_l) flash = MZ2_WIDOW_RAIL_LEFT;
  else if (self.monsterinfo.currentmove === widow_move_attack_rail_r) flash = MZ2_WIDOW_RAIL_RIGHT;
  // C leaves `flash` uninitialized if none of the three match; unreachable
  // since WidowRail only ever runs as a thinkfunc inside one of these three
  // move tables, so currentmove is always one of them at call time.
  else flash = MZ2_WIDOW_RAIL;

  const start = vec3();
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash], forward, right, start);

  // calc direction to where we targeted
  const dir = vec3();
  VectorSubtract(self.pos1, start, dir);
  VectorNormalize(dir);

  monster_fire_railgun(self, start, dir, WIDOW_RAIL_DAMAGE * widow_damage_multiplier, 100, flash);
  self.timestamp = level.time + RAIL_TIME;
}

function WidowSaveLoc(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(enemy.s.origin, self.pos1); // save for aiming the shot
  self.pos1[2] += enemy.viewheight;
}

function widow_start_rail(self: EdictT): void {
  self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
}

function widow_rail_done(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
}

const widow_frames_attack_pre_rail: MframeT[] = [
  mf(ai_charge, 0, widow_start_rail),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_attack_rail),
];
const widow_move_attack_pre_rail = mkmove(F.FRAME_transc01, F.FRAME_transc04, widow_frames_attack_pre_rail, null);

const widow_frames_attack_rail: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, WidowSaveLoc),
  mf(ai_charge, -10, WidowRail),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_rail_done),
];
const widow_move_attack_rail = mkmove(F.FRAME_firea01, F.FRAME_firea09, widow_frames_attack_rail, widow_run);

const widow_frames_attack_rail_r: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, WidowSaveLoc),
  mf(ai_charge, -10, WidowRail),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_rail_done),
];
const widow_move_attack_rail_r = mkmove(F.FRAME_fireb01, F.FRAME_fireb09, widow_frames_attack_rail_r, widow_run);

const widow_frames_attack_rail_l: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, WidowSaveLoc),
  mf(ai_charge, -10, WidowRail),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_rail_done),
];
const widow_move_attack_rail_l = mkmove(F.FRAME_firec01, F.FRAME_firec09, widow_frames_attack_rail_l, widow_run);

function widow_attack_rail(self: EdictT): void {
  const enemy_angle = target_angle(self);

  if (enemy_angle < -15) self.monsterinfo.currentmove = widow_move_attack_rail_l;
  else if (enemy_angle > 15) self.monsterinfo.currentmove = widow_move_attack_rail_r;
  else self.monsterinfo.currentmove = widow_move_attack_rail;
}

// exported: rogue/m_widow2.c forward-declares this and calls it without a
// body of its own (m_widow2.c:51,446) -- the real definition is here, and
// m_widow2.ts's SP_monster_widow2 (etc.) imports it from this module.
export function widow_start_spawn(self: EdictT): void {
  self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
}

function widow_done_spawn(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
}

const widow_frames_spawn: MframeT[] = [
  mf(ai_charge, 0, null), // 1
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_start_spawn),
  mf(ai_charge, 0, null), // 5
  mf(ai_charge, 0, WidowBlaster), // 6
  mf(ai_charge, 0, widow_ready_spawn), // 7
  mf(ai_charge, 0, WidowBlaster),
  mf(ai_charge, 0, WidowBlaster), // 9
  mf(ai_charge, 0, widow_spawn_check),
  mf(ai_charge, 0, WidowBlaster), // 11
  mf(ai_charge, 0, WidowBlaster),
  mf(ai_charge, 0, WidowBlaster), // 13
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, widow_done_spawn),
];
const widow_move_spawn = mkmove(F.FRAME_spawn01, F.FRAME_spawn18, widow_frames_spawn, widow_run);

const widow_frames_pain_heavy: MframeT[] = Array.from({ length: 13 }, () => mf(ai_move, 0, null));
const widow_move_pain_heavy = mkmove(F.FRAME_pain01, F.FRAME_pain13, widow_frames_pain_heavy, widow_run);

const widow_frames_pain_light: MframeT[] = Array.from({ length: 3 }, () => mf(ai_move, 0, null));
const widow_move_pain_light = mkmove(F.FRAME_pain201, F.FRAME_pain203, widow_frames_pain_light, widow_run);

function spawn_out_start(self: EdictT): void {
  self.wait = level.time + 2.0;

  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  const startpoint = vec3();
  G_ProjectSource2(self.s.origin, beameffects[0], f, r, u, startpoint);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WIDOWBEAMOUT);
  gi.WriteShort(20001);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, MulticastT.MULTICAST_ALL);

  G_ProjectSource2(self.s.origin, beameffects[1], f, r, u, startpoint);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WIDOWBEAMOUT);
  gi.WriteShort(20002);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, MulticastT.MULTICAST_ALL);

  gi.sound(self, CHAN_VOICE, gi.soundindex("misc/bwidowbeamout.wav"), 1, ATTN_NORM, 0);
}

function spawn_out_do(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  const startpoint = vec3();
  G_ProjectSource2(self.s.origin, beameffects[0], f, r, u, startpoint);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WIDOWSPLASH);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, MulticastT.MULTICAST_ALL);

  G_ProjectSource2(self.s.origin, beameffects[1], f, r, u, startpoint);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WIDOWSPLASH);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, MulticastT.MULTICAST_ALL);

  VectorCopy(self.s.origin, startpoint);
  startpoint[2] += 36;
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_BOSSTPORT);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, MulticastT.MULTICAST_PVS);

  Widowlegs_Spawn(self.s.origin, self.s.angles);

  G_FreeEdict(self);
}

const widow_frames_death: MframeT[] = [
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null), // 5
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, spawn_out_start), // 10
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null), // 15
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null), // 20
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null), // 25
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null), // 30
  mf(ai_move, 0, spawn_out_do),
];
const widow_move_death = mkmove(F.FRAME_death01, F.FRAME_death31, widow_frames_death, null);

function widow_attack_kick(self: EdictT): void {
  const aim = vec3();
  VectorSet(aim, 100, 0, 4);
  const enemy = self.enemy;
  if (enemy === null) return; // C assumes self->enemy is set here
  if (enemy.groundentity !== null) {
    fire_hit(self, aim, 50 + Math.floor(Math.random() * 6), 500);
  } else {
    // not as much kick if they're in the air .. makes it harder to land on her head
    fire_hit(self, aim, 50 + Math.floor(Math.random() * 6), 250);
  }
}

const widow_frames_attack_kick: MframeT[] = [
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, widow_attack_kick),
  mf(ai_move, 0, null), // 5
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
  mf(ai_move, 0, null),
];
const widow_move_attack_kick = mkmove(F.FRAME_kick01, F.FRAME_kick08, widow_frames_attack_kick, widow_run);

function widow_stand(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, gi.soundindex("widow/laugh.wav"), 1, ATTN_NORM, 0);
  self.monsterinfo.currentmove = widow_move_stand;
}

function widow_run(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = widow_move_stand;
  else self.monsterinfo.currentmove = widow_move_run;
}

function widow_walk(self: EdictT): void {
  self.monsterinfo.currentmove = widow_move_walk;
}

function widow_attack(self: EdictT): void {
  let blocked = false;
  let anger = false;

  self.movetarget = null;

  if (self.monsterinfo.aiflags & AI_BLOCKED) {
    blocked = true;
    self.monsterinfo.aiflags &= ~AI_BLOCKED;
  }

  if (self.monsterinfo.aiflags & AI_TARGET_ANGER) {
    anger = true;
    self.monsterinfo.aiflags &= ~AI_TARGET_ANGER;
  }

  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return;

  if (self.bad_area !== null) {
    if (random() < 0.1 || level.time < self.timestamp) {
      self.monsterinfo.currentmove = widow_move_attack_pre_blaster;
    } else {
      gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = widow_move_attack_pre_rail;
    }
    return;
  }

  // frames FRAME_walk13, FRAME_walk01, FRAME_walk02, FRAME_walk03 are rail gun start frames
  // frames FRAME_walk09, FRAME_walk10, FRAME_walk11, FRAME_walk12 are spawn & blaster start frames
  let rail_frames = false;
  let blaster_frames = false;

  if (self.s.frame === F.FRAME_walk13 || (self.s.frame >= F.FRAME_walk01 && self.s.frame <= F.FRAME_walk03)) {
    rail_frames = true;
  }

  if (self.s.frame >= F.FRAME_walk09 && self.s.frame <= F.FRAME_walk12) {
    blaster_frames = true;
  }

  WidowCalcSlots(self);

  // ENT_SLOTS_LEFT/SELF_SLOTS_LEFT dies at the call site (see g_local.ts's
  // header comment) -- inlined here as monster_slots - monster_used.
  const slotsLeft = self.monsterinfo.monster_slots - self.monsterinfo.monster_used;

  // if we can't see the target, spawn stuff regardless of frame
  if (self.monsterinfo.attack_state === AS_BLIND && slotsLeft >= 2) {
    self.monsterinfo.currentmove = widow_move_spawn;
    return;
  }

  // accept bias towards spawning regardless of frame
  if (blocked && slotsLeft >= 2) {
    self.monsterinfo.currentmove = widow_move_spawn;
    return;
  }

  if (realrange(self, enemy) > 300 && !anger && random() < 0.5 && !blocked) {
    self.monsterinfo.currentmove = widow_move_run_attack;
    return;
  }

  if (blaster_frames) {
    if (slotsLeft >= 2) {
      self.monsterinfo.currentmove = widow_move_spawn;
      return;
    } else if (self.monsterinfo.pausetime + BLASTER_TIME <= level.time) {
      self.monsterinfo.currentmove = widow_move_attack_pre_blaster;
      return;
    }
  }

  if (rail_frames) {
    if (!(level.time < self.timestamp)) {
      gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = widow_move_attack_pre_rail;
    }
  }

  if (rail_frames || blaster_frames) return;

  const luck = random();
  if (slotsLeft >= 2) {
    if (luck <= 0.4 && self.monsterinfo.pausetime + BLASTER_TIME <= level.time) {
      self.monsterinfo.currentmove = widow_move_attack_pre_blaster;
    } else if (luck <= 0.7 && !(level.time < self.timestamp)) {
      gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = widow_move_attack_pre_rail;
    } else {
      self.monsterinfo.currentmove = widow_move_spawn;
    }
  } else {
    if (level.time < self.timestamp) {
      self.monsterinfo.currentmove = widow_move_attack_pre_blaster;
    } else if (luck <= 0.5 || level.time + BLASTER_TIME >= self.monsterinfo.pausetime) {
      gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = widow_move_attack_pre_rail;
    } else {
      // holdout to blaster
      self.monsterinfo.currentmove = widow_move_attack_pre_blaster;
    }
  }
}

function widow_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (level.time < self.pain_debounce_time) return;

  if (self.monsterinfo.pausetime === 100000000) self.monsterinfo.pausetime = 0;

  self.pain_debounce_time = level.time + 5;

  if (damage < 15) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NONE, 0);
  } else if (damage < 75) {
    if (cvarNum(gameCvars.skill) < 3 && random() < 0.6 - 0.2 * cvarNum(gameCvars.skill)) {
      self.monsterinfo.currentmove = widow_move_pain_light;
      self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    }
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NONE, 0);
  } else {
    if (cvarNum(gameCvars.skill) < 3 && random() < 0.75 - 0.1 * cvarNum(gameCvars.skill)) {
      self.monsterinfo.currentmove = widow_move_pain_heavy;
      self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    }
    gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NONE, 0);
  }
}

// defined and forward-declared in the C but never called anywhere in
// m_widow.c (widow_die sets currentmove to widow_move_death directly, and
// widow_move_death's endfunc is null -- the death sequence ends via
// spawn_out_do's G_FreeEdict instead). Ported verbatim as dead code.
function widow_dead(self: EdictT): void {
  VectorSet(self.mins, -56, -56, 0);
  VectorSet(self.maxs, 56, 56, 80);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function widow_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_NO;
  self.count = 0;
  self.monsterinfo.quad_framenum = 0;
  self.monsterinfo.double_framenum = 0;
  self.monsterinfo.invincible_framenum = 0;
  self.monsterinfo.currentmove = widow_move_death;
}

function widow_melee(self: EdictT): void {
  self.monsterinfo.currentmove = widow_move_attack_kick;
}

function WidowGoinQuad(self: EdictT, framenum: number): void {
  self.monsterinfo.quad_framenum = framenum;
  widow_damage_multiplier = 4;
}

function WidowDouble(self: EdictT, framenum: number): void {
  self.monsterinfo.double_framenum = framenum;
  widow_damage_multiplier = 2;
}

function WidowPent(self: EdictT, framenum: number): void {
  self.monsterinfo.invincible_framenum = framenum;
}

function WidowPowerArmor(self: EdictT): void {
  self.monsterinfo.power_armor_type = POWER_ARMOR_SHIELD;
  // I don't like this, but it works
  if (self.monsterinfo.power_armor_power <= 0) self.monsterinfo.power_armor_power += 250 * cvarNum(gameCvars.skill);
}

function WidowRespondPowerup(self: EdictT, other: EdictT): void {
  // `other->client->` is dereferenced unconditionally in the C; other is
  // effectively always a client here (these effect bits are only ever set
  // on player entities), but EdictT.client is nullable in this port, so
  // each dereference gets a narrowing guard at the point of use.
  if (other.s.effects & EF_QUAD) {
    if (cvarNum(gameCvars.skill) === 1) {
      if (other.client !== null) WidowDouble(self, other.client.quad_framenum);
    } else if (cvarNum(gameCvars.skill) === 2) {
      if (other.client !== null) WidowGoinQuad(self, other.client.quad_framenum);
    } else if (cvarNum(gameCvars.skill) === 3) {
      if (other.client !== null) WidowGoinQuad(self, other.client.quad_framenum);
      WidowPowerArmor(self);
    }
  } else if (other.s.effects & EF_DOUBLE) {
    if (cvarNum(gameCvars.skill) === 2) {
      if (other.client !== null) WidowDouble(self, other.client.double_framenum);
    } else if (cvarNum(gameCvars.skill) === 3) {
      if (other.client !== null) WidowDouble(self, other.client.double_framenum);
      WidowPowerArmor(self);
    }
  } else {
    widow_damage_multiplier = 1;
  }

  if (other.s.effects & EF_PENT) {
    if (cvarNum(gameCvars.skill) === 1) {
      WidowPowerArmor(self);
    } else if (cvarNum(gameCvars.skill) === 2) {
      if (other.client !== null) WidowPent(self, other.client.invincible_framenum);
    } else if (cvarNum(gameCvars.skill) === 3) {
      if (other.client !== null) WidowPent(self, other.client.invincible_framenum);
      WidowPowerArmor(self);
    }
  }
}

// exported: rogue/m_widow2.c forward-declares this and calls it without a
// body of its own (m_widow2.c:42,1020) -- the real definition is here.
export function WidowPowerups(self: EdictT): void {
  if (cvarNum(gameCvars.coop) === 0) {
    // C: WidowRespondPowerup(self, self->enemy) with no null check; the
    // one caller (Widow_CheckAttack) already verified self.enemy is set.
    if (self.enemy !== null) WidowRespondPowerup(self, self.enemy);
    return;
  }

  // in coop, check for pents, then quads, then doubles
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    if (ent.s.effects & EF_PENT) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    if (ent.s.effects & EF_QUAD) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    if (ent.s.effects & EF_DOUBLE) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }
}

function Widow_CheckAttack(self: EdictT): boolean {
  const enemy = self.enemy;
  if (enemy === null) return false;

  WidowPowerups(self);

  if (self.monsterinfo.currentmove === widow_move_run) {
    // if we're in run, make sure we're in a good frame for attacking before doing anything else
    // frames 1,2,3,9,10,11,13 good to fire
    switch (self.s.frame) {
      case F.FRAME_walk04:
      case F.FRAME_walk05:
      case F.FRAME_walk06:
      case F.FRAME_walk07:
      case F.FRAME_walk08:
      case F.FRAME_walk12:
        return false;
      default:
        break;
    }
  }

  const slotsLeft = self.monsterinfo.monster_slots - self.monsterinfo.monster_used;

  // give a LARGE bias to spawning things when we have room
  // use AI_BLOCKED as a signal to attack to spawn
  if (random() < 0.8 && slotsLeft >= 2 && realrange(self, enemy) > 150) {
    self.monsterinfo.aiflags |= AI_BLOCKED;
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  if (enemy.health > 0) {
    // see if any entities are in the way of the shot
    const spot1 = vec3();
    VectorCopy(self.s.origin, spot1);
    spot1[2] += self.viewheight;
    const spot2 = vec3();
    VectorCopy(enemy.s.origin, spot2);
    spot2[2] += enemy.viewheight;

    const tr = gi.trace(spot1, null, null, spot2, self, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_SLIME | CONTENTS_LAVA);

    // do we have a clear shot?
    if (tr.ent !== enemy) {
      // go ahead and spawn stuff if we're mad a a client
      if (enemy.client !== null && slotsLeft >= 2) {
        self.monsterinfo.attack_state = AS_BLIND;
        return true;
      }

      // PGM - we want them to go ahead and shoot at info_notnulls if they can.
      if (enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) return false;
    }
  }

  // computed but never read afterward -- the same dead store exists in the
  // original C (m_widow.c:1486).
  const enemy_infront = infront(self, enemy);

  const enemy_range = range(self, enemy);
  const temp = vec3();
  VectorSubtract(enemy.s.origin, self.s.origin, temp);
  const enemy_yaw = vectoyaw2(temp);

  self.ideal_yaw = enemy_yaw;

  const real_enemy_range = realrange(self, enemy);

  // melee attack
  if (real_enemy_range <= MELEE_DISTANCE + 20) {
    // don't always melee in easy mode
    if (cvarNum(gameCvars.skill) === 0 && Math.floor(Math.random() * 4) !== 0) return false;
    if (self.monsterinfo.melee !== null) self.monsterinfo.attack_state = AS_MELEE;
    else self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  if (level.time < self.monsterinfo.attack_finished) return false;

  let chance = 0;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    chance = 0.4;
  } else if (enemy_range === RANGE_MELEE) {
    chance = 0.8;
  } else if (enemy_range === RANGE_NEAR) {
    chance = 0.7;
  } else if (enemy_range === RANGE_MID) {
    chance = 0.6;
  } else if (enemy_range === RANGE_FAR) {
    chance = 0.5;
  }

  // PGM - go ahead and shoot every time if it's a info_notnull
  if (random() < chance || enemy.solid === SolidT.SOLID_NOT) {
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  return false;
}

function widow_blocked(self: EdictT, dist: number): boolean {
  // if we get blocked while we're in our run/attack mode, turn on a
  // meaningless (in this context) AI flag, and call attack to get a new
  // attack sequence. make sure to turn it off when we're done.
  //
  // I'm using AI_TARGET_ANGER for this purpose
  if (self.monsterinfo.currentmove === widow_move_run_attack) {
    self.monsterinfo.aiflags |= AI_TARGET_ANGER;
    if (self.monsterinfo.checkattack !== null && self.monsterinfo.checkattack(self)) {
      if (self.monsterinfo.attack !== null) self.monsterinfo.attack(self);
    } else {
      if (self.monsterinfo.run !== null) self.monsterinfo.run(self);
    }
    return true;
  }

  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  return false;
}

// exported: rogue/m_widow2.c forward-declares this and calls it without a
// body of its own (m_widow2.c:41,800,1216) -- the real definition is here.
export function WidowCalcSlots(self: EdictT): void {
  switch (Math.trunc(cvarNum(gameCvars.skill))) {
    case 0:
    case 1:
      self.monsterinfo.monster_slots = 3;
      break;
    case 2:
      self.monsterinfo.monster_slots = 4;
      break;
    case 3:
      self.monsterinfo.monster_slots = 6;
      break;
    default:
      self.monsterinfo.monster_slots = 3;
      break;
  }
  if (cvarNum(gameCvars.coop) !== 0) {
    self.monsterinfo.monster_slots = Math.min(
      6,
      self.monsterinfo.monster_slots + cvarNum(gameCvars.skill) * (CountPlayers() - 1),
    );
  }
}

function WidowPrecache(): void {
  // cache in all of the stalker stuff, widow stuff, spawngro stuff, gibs
  gi.soundindex("stalker/pain.wav");
  gi.soundindex("stalker/death.wav");
  gi.soundindex("stalker/sight.wav");
  gi.soundindex("stalker/melee1.wav");
  gi.soundindex("stalker/melee2.wav");
  gi.soundindex("stalker/idle.wav");

  gi.soundindex("tank/tnkatck3.wav");
  gi.modelindex("models/proj/laser2/tris.md2");

  gi.modelindex("models/monsters/stalker/tris.md2");
  gi.modelindex("models/items/spawngro2/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");
  gi.modelindex("models/objects/gibs/gear/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib1/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib2/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib3/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib4/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib1/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib2/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib3/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib4/tris.md2");
  gi.modelindex("models/monsters/legs/tris.md2");
  gi.soundindex("misc/bwidowbeamout.wav");

  gi.soundindex("misc/bigtele.wav");
  gi.soundindex("widow/bwstep3.wav");
  gi.soundindex("widow/bwstep2.wav");
}

// drawbbox() and showme() are fully defined in the C but every call site is
// commented out or gated behind a DRAWBBOX/SHOWME macro that is itself
// #define'd to NULL (m_widow.c:25-26, 239-252, 322-337) -- dead code in the
// shipped binary. Ported verbatim; nothing in this file calls either.
function drawbbox(self: EdictT): void {
  const lines: readonly [number, number, number][] = [
    [1, 2, 4],
    [1, 2, 7],
    [1, 4, 5],
    [2, 4, 7],
  ];
  const starts: readonly number[] = [0, 3, 5, 6];

  const pt: Vec3[] = Array.from({ length: 8 }, () => vec3());
  const coords: [Vec3, Vec3] = [vec3(), vec3()];

  VectorCopy(self.absmin, coords[0]);
  VectorCopy(self.absmax, coords[1]);

  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= 1; j++) {
      for (let k = 0; k <= 1; k++) {
        pt[4 * i + 2 * j + k][0] = coords[i][0];
        pt[4 * i + 2 * j + k][1] = coords[j][1];
        pt[4 * i + 2 * j + k][2] = coords[k][2];
      }
    }
  }

  for (let i = 0; i <= 3; i++) {
    for (let j = 0; j <= 2; j++) {
      gi.WriteByte(svc_temp_entity);
      gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
      gi.WritePosition(pt[starts[i]]);
      gi.WritePosition(pt[lines[i][j]]);
      gi.multicast(pt[starts[i]], MulticastT.MULTICAST_ALL);
    }
  }

  const dir = vec3();
  vectoangles2(self.s.angles, dir);
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(dir, f, r, u);

  const newbox = vec3();
  VectorMA(self.s.origin, 50, f, newbox);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
  gi.WritePosition(self.s.origin);
  gi.WritePosition(newbox);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  VectorClear(newbox);

  VectorMA(self.s.origin, 50, r, newbox);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
  gi.WritePosition(self.s.origin);
  gi.WritePosition(newbox);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  VectorClear(newbox);

  VectorMA(self.s.origin, 50, u, newbox);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
  gi.WritePosition(self.s.origin);
  gi.WritePosition(newbox);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  VectorClear(newbox);
}

/*QUAKED monster_widow (1 .5 0) (-40 -40 0) (40 40 144) Ambush Trigger_Spawn Sight
*/
export function SP_monster_widow(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("widow/bw1pain1.wav");
  sound_pain2 = gi.soundindex("widow/bw1pain2.wav");
  sound_pain3 = gi.soundindex("widow/bw1pain3.wav");
  sound_search1 = gi.soundindex("bosshovr/bhvunqv1.wav");
  sound_rail = gi.soundindex("gladiator/railgun.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/blackwidow/tris.md2");
  VectorSet(self.mins, -40, -40, 0);
  VectorSet(self.maxs, 40, 40, 144);

  self.health = 2000 + 1000 * cvarNum(gameCvars.skill);
  if (cvarNum(gameCvars.coop) !== 0) self.health += 500 * cvarNum(gameCvars.skill);
  self.gib_health = -5000;
  self.mass = 1500;

  // C keeps the skill==2 power-armor branch inside a `/* ... */` comment
  // that also swallows the `else` (m_widow.c:1675-1681) -- only the live
  // skill==3 branch below is ported.
  if (cvarNum(gameCvars.skill) === 3) {
    self.monsterinfo.power_armor_type = POWER_ARMOR_SHIELD;
    self.monsterinfo.power_armor_power = 500;
  }

  self.yaw_speed = 30;

  self.flags |= FL_IMMUNE_LASER;
  self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;

  self.pain = widow_pain;
  self.die = widow_die;

  self.monsterinfo.melee = widow_melee;
  self.monsterinfo.stand = widow_stand;
  self.monsterinfo.walk = widow_walk;
  self.monsterinfo.run = widow_run;
  self.monsterinfo.attack = widow_attack;
  self.monsterinfo.search = widow_search;
  self.monsterinfo.checkattack = Widow_CheckAttack;
  self.monsterinfo.sight = widow_sight;

  self.monsterinfo.blocked = widow_blocked;

  gi.linkentity(self);

  self.monsterinfo.currentmove = widow_move_stand;
  self.monsterinfo.scale = F.MODEL_SCALE;

  WidowPrecache();
  WidowCalcSlots(self);
  widow_damage_multiplier = 1;

  walkmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/pain/die/blocked function or monsterinfo.currentmove object
// instead of null (see g_save.ts's registerSaveFunction/registerSaveMmove
// name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_widow:showme", showme);
registerSaveFunction("m_widow:widow_search", widow_search);
registerSaveFunction("m_widow:widow_sight", widow_sight);
registerSaveFunction("m_widow:WidowBlaster", WidowBlaster);
registerSaveFunction("m_widow:WidowSpawn", WidowSpawn);
registerSaveFunction("m_widow:widow_spawn_check", widow_spawn_check);
registerSaveFunction("m_widow:widow_ready_spawn", widow_ready_spawn);
registerSaveFunction("m_widow:widow_step", widow_step);
registerSaveFunction("m_widow:widow_stepshoot", widow_stepshoot);
registerSaveFunction("m_widow:widow_start_run_5", widow_start_run_5);
registerSaveFunction("m_widow:widow_start_run_10", widow_start_run_10);
registerSaveFunction("m_widow:widow_start_run_12", widow_start_run_12);
registerSaveFunction("m_widow:widow_attack_blaster", widow_attack_blaster);
registerSaveFunction("m_widow:widow_reattack_blaster", widow_reattack_blaster);
registerSaveFunction("m_widow:WidowRail", WidowRail);
registerSaveFunction("m_widow:WidowSaveLoc", WidowSaveLoc);
registerSaveFunction("m_widow:widow_start_rail", widow_start_rail);
registerSaveFunction("m_widow:widow_rail_done", widow_rail_done);
registerSaveFunction("m_widow:widow_attack_rail", widow_attack_rail);
registerSaveFunction("m_widow:widow_start_spawn", widow_start_spawn);
registerSaveFunction("m_widow:widow_done_spawn", widow_done_spawn);
registerSaveFunction("m_widow:spawn_out_start", spawn_out_start);
registerSaveFunction("m_widow:spawn_out_do", spawn_out_do);
registerSaveFunction("m_widow:widow_attack_kick", widow_attack_kick);
registerSaveFunction("m_widow:widow_stand", widow_stand);
registerSaveFunction("m_widow:widow_run", widow_run);
registerSaveFunction("m_widow:widow_walk", widow_walk);
registerSaveFunction("m_widow:widow_attack", widow_attack);
registerSaveFunction("m_widow:widow_pain", widow_pain);
registerSaveFunction("m_widow:widow_dead", widow_dead);
registerSaveFunction("m_widow:widow_die", widow_die);
registerSaveFunction("m_widow:widow_melee", widow_melee);
registerSaveFunction("m_widow:WidowPowerups", WidowPowerups);
registerSaveFunction("m_widow:Widow_CheckAttack", Widow_CheckAttack);
registerSaveFunction("m_widow:widow_blocked", widow_blocked);
registerSaveFunction("m_widow:drawbbox", drawbbox);

registerSaveMmove("m_widow:widow_move_stand", widow_move_stand);
registerSaveMmove("m_widow:widow_move_walk", widow_move_walk);
registerSaveMmove("m_widow:widow_move_run", widow_move_run);
registerSaveMmove("m_widow:widow_move_run_attack", widow_move_run_attack);
registerSaveMmove("m_widow:widow_move_attack_pre_blaster", widow_move_attack_pre_blaster);
registerSaveMmove("m_widow:widow_move_attack_blaster", widow_move_attack_blaster);
registerSaveMmove("m_widow:widow_move_attack_post_blaster", widow_move_attack_post_blaster);
registerSaveMmove("m_widow:widow_move_attack_post_blaster_r", widow_move_attack_post_blaster_r);
registerSaveMmove("m_widow:widow_move_attack_post_blaster_l", widow_move_attack_post_blaster_l);
registerSaveMmove("m_widow:widow_move_attack_pre_rail", widow_move_attack_pre_rail);
registerSaveMmove("m_widow:widow_move_attack_rail", widow_move_attack_rail);
registerSaveMmove("m_widow:widow_move_attack_rail_r", widow_move_attack_rail_r);
registerSaveMmove("m_widow:widow_move_attack_rail_l", widow_move_attack_rail_l);
registerSaveMmove("m_widow:widow_move_spawn", widow_move_spawn);
registerSaveMmove("m_widow:widow_move_pain_heavy", widow_move_pain_heavy);
registerSaveMmove("m_widow:widow_move_pain_light", widow_move_pain_light);
registerSaveMmove("m_widow:widow_move_death", widow_move_death);
registerSaveMmove("m_widow:widow_move_attack_kick", widow_move_attack_kick);
