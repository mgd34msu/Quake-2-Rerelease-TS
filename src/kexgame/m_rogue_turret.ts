// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_rogue_turret.c -- the ROGUE mission-pack TURRET monster ("monster_turret",
// 2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/m_rogue_turret.cpp
// (1,070 lines) + m_rogue_turret.h (27 lines, 16 FRAME_ constants +
// MODEL_SCALE), C++17. Behavioral code ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/m_medic.ts headers).
//
// This is a wholly different entity from src/kexgame/g_turret.ts's
// turret_breach/turret_driver/turret_base/turret_brain (the base game's
// manned-gun turret used in tank-command sequences) -- no relationship, no
// shared classnames, no import between the two files.
//
// ============================================================================
// WALL-MOUNT DEPLOYMENT -- the turret is TWO entities when SPAWNFLAG_WALL_UNIT
// is set (cpp:648-805)
// ============================================================================
// `turret_wall_spawn` (cpp:648-704) spawns a second, separate "wall section"
// edict (a flat plate model sized/oriented off `self.s.angles`), links the
// two via `teammaster`/`teamchain`/`FL_TEAMMASTER`/`FL_TEAMSLAVE` (the same
// generic team-chain fields other push-group entities use), and leaves both
// entities MOVETYPE_NONE/SOLID_NOT (invisible/inert) until a `use` trigger
// fires `turret_activate` (cpp:747-805). Activation flips both entities to
// MOVETYPE_PUSH and slides each 32 units along the wall's facing direction
// via `Move_Calc` (g_func.ts) with `turret_wake` (cpp:706-745) as the
// shared move-end callback: the wall section's copy of `turret_wake` is a
// near-total no-op (guarded by `FL_TEAMSLAVE`, cpp:710-714 -- "easiest way
// to have a null function"), while the turret's own copy wires up its real
// monsterinfo callbacks, calls `stationarymonster_start`, and re-enables
// kill counting (it was `AI_DO_NOT_COUNT` while dormant so the wall-mount
// spawn itself never inflated `level.total_monsters`).
//
// ============================================================================
// OTHER NOTES
// ============================================================================
// - `TurretAim`'s per-mount-orientation pitch/yaw clamps (cpp:82-168) key off
//   `self.offset` (== the spawn-time raw `s.angles`, stashed before
//   `SP_monster_turret` rewrites `s.angles`/`s.origin` for ceiling/floor/wall
//   mounts, cpp:981-1009) -- ported verbatim, six-way switch included.
// - `TurretAim`'s lasersight (cpp:245-281, "Paril: improved turrets") spawns
//   a `classname: "turret_lasersight"` beam entity on first use and re-traces
//   twice with a per-frame sinusoidal jitter on the endpoint -- ported as-is.
// - `cached_soundindex sound_moved, sound_moving` (cpp:31) -- ported as
//   plain module-level `let` numbers assigned once in `SP_monster_turret`,
//   matching this port line's established `cached_soundindex` idiom (see
//   m_soldier.ts's own precedent).
// - `gi.traceline`/`cvarOrDefault`/`mkframe`/`mkMove`/`Aifunc`/`Thinkfunc` are
//   local unexported per-file duplicates, matching every other monster file
//   in this port line (g_monster.ts's own `giTraceline`, m_medic.ts's own
//   `mkframe`/`mkMove`/`cvarOrDefault`).
// - `SPAWNFLAG_TURRET_NO_LASERSIGHT = 18_spawnflag_bit` (cpp:20) is a
//   1-indexed spawnflag-bit literal, i.e. `1 << (18 - 1)` = `0x20000` --
//   ported as `SpawnFlags_from(1 << 17)`; not exercised by any test in this
//   unit (no map in this test harness sets bit 18), flagged here as an
//   inference rather than a cross-checked value.
// - `turret_pain` (cpp:582-584) and `turret_sight`/`turret_search`
//   (cpp:284-290) are genuinely empty C++ bodies -- ported as empty
//   registered functions, not stubs (there is nothing missing; the C++
//   itself does nothing here).
// - Grepped the full 1,070-line source for fire_prox/fire_tesla/
//   monster_fire_blaster2/hint_path: no hits. Every weapon this monster
//   fires (monster_fire_blaster/monster_fire_bullet/monster_fire_rocket) is
//   already ported and exported from g_monster.ts; no rogue-systems stub
//   was needed in this file.
// - `DEFAULT_BULLET_HSPREAD`/`DEFAULT_BULLET_VSPREAD` imported from
//   g_local.ts (already exported there), matching m_actor.ts's precedent,
//   rather than re-duplicated locally (m_infantry.ts's own local copies
//   predate g_local.ts exporting these and are a separate file's concern).

import { vec3, type Vec3 } from "../shared/math";
import { AngleVectors, vec3_sub, vec3_add, vec3_muls, vec3_length, vec3_normalized, vec3_dot } from "./q_vec3";
import { type CvarT } from "../shared/q_shared";
import {
  MonsterMuzzleflashIdT,
  EffectsT,
  ATTN_NORM,
  MASK_SOLID,
  MASK_PROJECTILE,
  ServerCommandT,
  KexMulticastT,
  KexTempEventT,
  RenderfxT,
  MODELINDEX_WORLD,
  ContentsT,
  SvflagsT,
  SoundchanT,
  type KexTraceT,
} from "../kexapi/game";
import type { ModT, MonsterinfoSightFn, MonsterinfoSearchFn } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn, PainFn, DieFn, UseFn, MoveinfoEndfuncFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterUse,
  RegisterMoveinfoEndfunc,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoCheckattack,
} from "./g_save_registry";
import { type EdictT, MonsterAiFlagsT, MonsterAttackStateT, EntFlagsT, GibTypeT, MovetypeT, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, ItemIdT, random_time } from "./g_local";
import { gi, level, g_edicts } from "./g_main_globals";
import { SolidT } from "../kexapi/game";
import { SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, SpawnFlags_and, SpawnFlags_not, type SpawnFlags } from "./spawnflags";
import { ai_stand, ai_walk, ai_run, visible, FindTarget } from "./g_ai";
import { monster_fire_blaster, monster_fire_bullet, monster_fire_rocket, M_SetAnimation, M_AllowSpawn, stationarymonster_start } from "./g_monster";
import { ThrowGibs, ThrowGib } from "./g_misc";
import { G_Spawn, G_FreeEdict, G_UseTargets } from "./g_utils";
import { st } from "./g_spawn";
import { Move_Calc } from "./g_func";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, Gtime_seconds, type GTime } from "./gtime";
import { frandom } from "./q_std";
import { vectoangles } from "./q_vec3";
import { PredictAim } from "./m_supertank";

// ---------------------------------------------------------------------------
// m_rogue_turret.h frame-index enum (16 frames) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_stand01 = 0;
export const FRAME_stand02 = 1;
export const FRAME_active01 = 2;
export const FRAME_active02 = 3;
export const FRAME_active03 = 4;
export const FRAME_active04 = 5;
export const FRAME_active05 = 6;
export const FRAME_active06 = 7;
export const FRAME_run01 = 8;
export const FRAME_run02 = 9;
export const FRAME_pow01 = 10;
export const FRAME_pow02 = 11;
export const FRAME_pow03 = 12;
export const FRAME_pow04 = 13;
export const FRAME_death01 = 14;
export const FRAME_death02 = 15;

export const MODEL_SCALE = 3.5;

// ---------------------------------------------------------------------------
// Local per-file idioms (cvarOrDefault/mkframe/mkMove/Aifunc/Thinkfunc/
// giTraceline) -- see file header.
// ---------------------------------------------------------------------------

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, 0);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
}

type Aifunc = (self: EdictT, dist: number) => void;
type Thinkfunc = (self: EdictT) => void;

function mkframe(aifunc: Aifunc | null, dist = 0, thinkfunc: Thinkfunc | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}

function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveEndfuncFn | null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** q_std.h's kex-own fmod-based `anglemod` -- local unexported copy, matching
 *  g_ai.ts's/m_move.ts's/g_misc.ts's/g_func.ts's own local copies (see
 *  m_medic.ts's file header for this port line's established idiom). */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** m_rogue_newai.cpp skill->integer worked around the same way as
 *  m_medic.ts's skillValue() (CvarT has no cached `.integer`). */
function skillInteger(): number {
  return Math.trunc(cvarOrDefault("skill", "1").value);
}
function skillValue(): number {
  return cvarOrDefault("skill", "1").value;
}

// ---------------------------------------------------------------------------
// cpp:14-20 spawnflags
// ---------------------------------------------------------------------------

const SPAWNFLAG_TURRET_BLASTER: SpawnFlags = SpawnFlags_from(0x0008);
const SPAWNFLAG_TURRET_MACHINEGUN: SpawnFlags = SpawnFlags_from(0x0010);
const SPAWNFLAG_TURRET_ROCKET: SpawnFlags = SpawnFlags_from(0x0020);
const SPAWNFLAG_TURRET_HEATBEAM: SpawnFlags = SpawnFlags_from(0x0040);
const SPAWNFLAG_TURRET_WEAPONCHOICE: SpawnFlags = SpawnFlags_from(
  SPAWNFLAG_TURRET_HEATBEAM | SPAWNFLAG_TURRET_ROCKET | SPAWNFLAG_TURRET_MACHINEGUN | SPAWNFLAG_TURRET_BLASTER,
);
const SPAWNFLAG_TURRET_WALL_UNIT: SpawnFlags = SpawnFlags_from(0x0080);
/** `18_spawnflag_bit` -- see file header note. */
const SPAWNFLAG_TURRET_NO_LASERSIGHT: SpawnFlags = SpawnFlags_from(1 << 17);

let sound_moved = 0;
let sound_moving = 0;

const MZ2_TURRET_MACHINEGUN = MonsterMuzzleflashIdT.MZ2_TURRET_MACHINEGUN;
const MZ2_TURRET_ROCKET = MonsterMuzzleflashIdT.MZ2_TURRET_ROCKET;
const MZ2_TURRET_BLASTER = MonsterMuzzleflashIdT.MZ2_TURRET_BLASTER;

const TURRET_BLASTER_DAMAGE = 8;
const TURRET_BULLET_DAMAGE = 2;

// ---------------------------------------------------------------------------
// TurretAim (cpp:33-282)
// ---------------------------------------------------------------------------

function TurretAim(self: EdictT): void {
  if (self.enemy === null || self.enemy === g_edicts[0]) {
    if (!FindTarget(self)) return;
  }
  const enemy = self.enemy;
  if (enemy === null) return;

  // if turret is still in inactive mode, ready the gun, but don't aim
  if (self.s.frame < FRAME_active01) {
    turret_ready_gun(self);
    return;
  }
  // if turret is still readying, don't aim.
  if (self.s.frame < FRAME_run01) return;

  let end: Vec3;
  // PMM - blindfire aiming here
  if (self.monsterinfo.active_move === turret_move_fire_blind) {
    end = vec3(self.monsterinfo.blind_fire_target[0], self.monsterinfo.blind_fire_target[1], self.monsterinfo.blind_fire_target[2]);
    if (enemy.s.origin[2] < self.monsterinfo.blind_fire_target[2]) end[2] += enemy.viewheight + 10;
    else end[2] += enemy.mins[2] - 10;
  } else {
    end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
    if (enemy.client !== null) end[2] += enemy.viewheight;
  }

  const dir = vec3_sub(end, self.s.origin);
  const ang = vectoangles(dir);

  // Clamp first
  let idealPitch = ang[0]; // PITCH
  let idealYaw = ang[1]; // YAW

  const orientation = Math.trunc(self.offset[1]);
  switch (orientation) {
    case -1: // up pitch: 0 to 90
      if (idealPitch < -90) idealPitch += 360;
      if (idealPitch > -5) idealPitch = -5;
      break;
    case -2: // down pitch: -180 to -360
      if (idealPitch > -90) idealPitch -= 360;
      if (idealPitch < -355) idealPitch = -355;
      else if (idealPitch > -185) idealPitch = -185;
      break;
    case 0: // +X
      if (idealPitch < -180) idealPitch += 360;
      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;
      if (idealYaw > 180) idealYaw -= 360;
      if (idealYaw > 85) idealYaw = 85;
      else if (idealYaw < -85) idealYaw = -85;
      break;
    case 90: // +Y
      if (idealPitch < -180) idealPitch += 360;
      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;
      if (idealYaw > 270) idealYaw -= 360;
      if (idealYaw > 175) idealYaw = 175;
      else if (idealYaw < 5) idealYaw = 5;
      break;
    case 180: // -X
      if (idealPitch < -180) idealPitch += 360;
      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;
      if (idealYaw > 265) idealYaw = 265;
      else if (idealYaw < 95) idealYaw = 95;
      break;
    case 270: // -Y
      if (idealPitch < -180) idealPitch += 360;
      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;
      if (idealYaw < 90) idealYaw += 360;
      if (idealYaw > 355) idealYaw = 355;
      else if (idealYaw < 185) idealYaw = 185;
      break;
    default:
      break;
  }

  // adjust pitch
  let current = self.s.angles[0];
  const speed = self.yaw_speed / (gi.tick_rate / 10);

  if (idealPitch !== current) {
    let move = idealPitch - current;

    while (move >= 360) move -= 360;
    if (move >= 90) move = move - 360;

    while (move <= -360) move += 360;
    if (move <= -90) move = move + 360;

    if (move > 0) {
      if (move > speed) move = speed;
    } else {
      if (move < -speed) move = -speed;
    }

    self.s.angles[0] = anglemod(current + move);
  }

  // adjust yaw
  current = self.s.angles[1];

  if (idealYaw !== current) {
    let move = idealYaw - current;

    if (move >= 180) move = move - 360;
    if (move <= -180) move = move + 360;

    if (move > 0) {
      if (move > speed) move = speed;
    } else {
      if (move < -speed) move = -speed;
    }

    self.s.angles[1] = anglemod(current + move);
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_NO_LASERSIGHT)) return;

  // Paril: improved turrets; draw lasersight
  if (self.target_ent === null) {
    const laser = G_Spawn();
    laser.s.modelindex = MODELINDEX_WORLD;
    laser.s.renderfx = RenderfxT.RF_BEAM;
    laser.s.frame = 1;
    laser.s.skinnum = 0xf0f0f0f0;
    laser.classname = "turret_lasersight";
    laser.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
    self.target_ent = laser;
  }

  const { forward: fwd0 } = AngleVectors_destructured(self.s.angles);
  let end2 = vec3_add(self.s.origin, vec3_muls(fwd0, 8192));
  let tr = giTraceline(self.s.origin, end2, self, MASK_SOLID);

  let scan_range = 64.0;
  if (visible(self, enemy)) scan_range = 12.0;

  const jittered = vec3(
    tr.endpos[0] + Math.sin(Gtime_seconds(level.time) + self.s.number) * scan_range,
    tr.endpos[1] + Math.cos((Gtime_seconds(level.time) - self.s.number) * 3.0) * scan_range,
    tr.endpos[2] + Math.sin((Gtime_seconds(level.time) - self.s.number) * 2.5) * scan_range,
  );

  const fwd1 = vec3_normalized(vec3_sub(jittered, self.s.origin));
  end2 = vec3_add(self.s.origin, vec3_muls(fwd1, 8192));
  tr = giTraceline(self.s.origin, end2, self, MASK_SOLID);

  const target_ent = self.target_ent;
  if (target_ent !== null) {
    target_ent.s.old_origin = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
    gi.linkentity(target_ent);
  }
}


function AngleVectors_destructured(angles: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = vec3();
  AngleVectors(angles, forward, null, null);
  return { forward, right: vec3(), up: vec3() };
}

// ---------------------------------------------------------------------------
// SIGHT/SEARCH (cpp:284-290) -- genuinely empty C++ bodies.
// ---------------------------------------------------------------------------

export const turret_sight: MonsterinfoSightFn = RegisterMonsterinfoSight("turret_sight", (_self: EdictT, _other: EdictT): void => {});
export const turret_search: MonsterinfoSearchFn = RegisterMonsterinfoSearch("turret_search", (_self: EdictT): void => {});

// ---------------------------------------------------------------------------
// STAND (cpp:292-306)
// ---------------------------------------------------------------------------

const turret_frames_stand: MframeT[] = [mkframe(ai_stand), mkframe(ai_stand)];
export const turret_move_stand = RegisterMmove("turret_move_stand", mkMove(FRAME_stand01, FRAME_stand02, turret_frames_stand, null));

export const turret_stand = RegisterMonsterinfoStand("turret_stand", (self: EdictT): void => {
  M_SetAnimation(self, turret_move_stand, true);
  if (self.target_ent !== null) {
    G_FreeEdict(self.target_ent);
    self.target_ent = null;
  }
});

// ---------------------------------------------------------------------------
// READY GUN / SEEK / RUN (cpp:308-365)
//
// C++ forward-declares `turret_ready_gun`/`turret_run` at file scope
// (cpp:24-26) so `MMOVE_T(turret_move_ready_gun)`/`MMOVE_T(turret_move_run)`
// can embed a not-yet-defined function pointer, resolved by the linker.
// TS `const` bindings have no such forward declaration -- `turret_run` (the
// monsterinfo callback) is defined FIRST here so the two `MmoveT` objects
// that reference it as their `endfunc` can do so after it already exists;
// `turret_run`'s own body references `turret_move_run`/`turret_move_ready_gun`
// only inside its closure (evaluated on first call, long after module load),
// so the reverse reference is safe. Same ordering trick as m_medic.ts's
// stand/walk/run-before-pain/attack section order.
// ---------------------------------------------------------------------------

export const turret_run = RegisterMonsterinfoRun("turret_run", (self: EdictT): void => {
  if (self.s.frame < FRAME_run01) {
    turret_ready_gun(self);
  } else {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HIGH_TICK_RATE;
    M_SetAnimation(self, turret_move_run, true);

    if (self.monsterinfo.weapon_sound !== 0) {
      self.monsterinfo.weapon_sound = 0;
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_moved, 1.0, ATTN_NORM, 0);
    }
  }
});

const turret_frames_run: MframeT[] = [mkframe(ai_run, 0, TurretAim), mkframe(ai_run, 0, TurretAim)];
export const turret_move_run = RegisterMmove("turret_move_run", mkMove(FRAME_run01, FRAME_run02, turret_frames_run, turret_run));

const turret_frames_ready_gun: MframeT[] = [mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand)];
export const turret_move_ready_gun = RegisterMmove("turret_move_ready_gun", mkMove(FRAME_active01, FRAME_run01, turret_frames_ready_gun, turret_run));

function turret_ready_gun(self: EdictT): void {
  if (self.monsterinfo.active_move !== turret_move_ready_gun) {
    M_SetAnimation(self, turret_move_ready_gun, true);
    self.monsterinfo.weapon_sound = sound_moving;
  }
}

const turret_frames_seek: MframeT[] = [mkframe(ai_walk, 0, TurretAim), mkframe(ai_walk, 0, TurretAim)];
export const turret_move_seek = RegisterMmove("turret_move_seek", mkMove(FRAME_run01, FRAME_run02, turret_frames_seek, null));

export const turret_walk = RegisterMonsterinfoWalk("turret_walk", (self: EdictT): void => {
  if (self.s.frame < FRAME_run01) turret_ready_gun(self);
  else M_SetAnimation(self, turret_move_seek, true);
});


// ---------------------------------------------------------------------------
// ATTACK (cpp:376-576)
// ---------------------------------------------------------------------------

function TurretFire(self: EdictT): void {
  TurretAim(self);

  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return;

  let end: Vec3;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) !== 0n) end = vec3(self.monsterinfo.blind_fire_target[0], self.monsterinfo.blind_fire_target[1], self.monsterinfo.blind_fire_target[2]);
  else end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);

  let dir = vec3_normalized(vec3_sub(end, self.s.origin));
  const { forward } = AngleVectors_destructured(self.s.angles);
  const chanceDot = vec3_dot(dir, forward);
  if (chanceDot < 0.98) return;

  let rocketSpeed: number;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET)) rocketSpeed = 650;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BLASTER)) rocketSpeed = 800;
  else rocketSpeed = 0;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_MACHINEGUN) || visible(self, enemy)) {
    const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);

    // aim for the head.
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) === 0n) {
      if (enemy.client !== null) end[2] += enemy.viewheight;
      else end[2] += 22;
    }

    dir = vec3_sub(end, start);
    const dist = vec3_length(dir);

    // check for predictive fire
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) === 0n) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_MACHINEGUN)) {
        PredictAim(self, enemy, start, 0, true, 0.3, dir, null);
      } else if (frandom() < skillInteger() / 5.0) {
        PredictAim(self, enemy, start, rocketSpeed, true, frandom(3.0 - skillInteger()) / 3.0 - frandom(0.05 * (3.0 - skillInteger())), dir, null);
      }
    }

    dir = vec3_normalized(dir);
    const trace = giTraceline(start, end, self, MASK_PROJECTILE);
    const traceEnt = trace.ent !== null ? g_edicts[trace.ent.s.number] : g_edicts[0];
    if (traceEnt === enemy || traceEnt === g_edicts[0]) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BLASTER)) {
        monster_fire_blaster(self, start, dir, TURRET_BLASTER_DAMAGE, rocketSpeed, MZ2_TURRET_BLASTER, EffectsT.EF_BLASTER);
      } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_MACHINEGUN)) {
        if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HOLD_FRAME) === 0n) {
          self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
          self.monsterinfo.duck_wait_time = Gtime_add(level.time, Gtime_add(Gtime_from_sec(2), Gtime_from_sec(frandom(skillValue()))));
          self.monsterinfo.next_duck_time = Gtime_add(level.time, Gtime_from_sec(1));
          gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/chngnu1a.wav"), 1, ATTN_NORM, 0);
        } else {
          if (self.monsterinfo.next_duck_time < level.time && self.monsterinfo.melee_debounce_time <= level.time) {
            monster_fire_bullet(self, start, dir, TURRET_BULLET_DAMAGE, 0, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MZ2_TURRET_MACHINEGUN);
            self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_ms(100));
          }

          if (self.monsterinfo.duck_wait_time < level.time) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
        }
      } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET)) {
        if (dist * trace.fraction > 72) monster_fire_rocket(self, start, dir, 40, rocketSpeed, MZ2_TURRET_ROCKET);
      }
    }
  }
}

function TurretFireBlind(self: EdictT): void {
  TurretAim(self);

  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return;

  let dir = vec3_normalized(vec3_sub(self.monsterinfo.blind_fire_target, self.s.origin));
  const { forward } = AngleVectors_destructured(self.s.angles);
  const chance = vec3_dot(dir, forward);
  if (chance < 0.98) return;

  let rocketSpeed: number;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET)) rocketSpeed = 650;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BLASTER)) rocketSpeed = 800;
  else rocketSpeed = 0;

  const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  const end = vec3(self.monsterinfo.blind_fire_target[0], self.monsterinfo.blind_fire_target[1], self.monsterinfo.blind_fire_target[2]);

  if (enemy.s.origin[2] < self.monsterinfo.blind_fire_target[2]) end[2] += enemy.viewheight + 10;
  else end[2] += enemy.mins[2] - 10;

  dir = vec3_normalized(vec3_sub(end, start));

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BLASTER)) monster_fire_blaster(self, start, dir, TURRET_BLASTER_DAMAGE, rocketSpeed, MZ2_TURRET_BLASTER, EffectsT.EF_BLASTER);
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET)) monster_fire_rocket(self, start, dir, 40, rocketSpeed, MZ2_TURRET_ROCKET);
}

const turret_frames_fire: MframeT[] = [mkframe(ai_run, 0, TurretFire), mkframe(ai_run, 0, TurretAim), mkframe(ai_run, 0, TurretAim), mkframe(ai_run, 0, TurretAim)];
export const turret_move_fire = RegisterMmove("turret_move_fire", mkMove(FRAME_pow01, FRAME_pow04, turret_frames_fire, turret_run));

// the blind frames need to aim first
const turret_frames_fire_blind: MframeT[] = [mkframe(ai_run, 0, TurretAim), mkframe(ai_run, 0, TurretAim), mkframe(ai_run, 0, TurretAim), mkframe(ai_run, 0, TurretFireBlind)];
export const turret_move_fire_blind = RegisterMmove("turret_move_fire_blind", mkMove(FRAME_pow01, FRAME_pow04, turret_frames_fire_blind, turret_run));

export const turret_attack = RegisterMonsterinfoAttack("turret_attack", (self: EdictT): void => {
  if (self.s.frame < FRAME_run01) {
    turret_ready_gun(self);
  } else if (self.monsterinfo.attack_state !== MonsterAttackStateT.AS_BLIND) {
    M_SetAnimation(self, turret_move_fire, true);
  } else {
    let chance: number;
    if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(1)) chance = 1.0;
    else if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(7.5)) chance = 0.4;
    else chance = 0.1;

    const r = frandom();

    // minimum of 3 seconds, plus 0-4, after the shots are done
    self.monsterinfo.blind_fire_delay = Gtime_add(self.monsterinfo.blind_fire_delay, random_time(Gtime_from_sec(3.4), Gtime_from_sec(7.4)));
    // don't shoot at the origin
    if (self.monsterinfo.blind_fire_target[0] === 0 && self.monsterinfo.blind_fire_target[1] === 0 && self.monsterinfo.blind_fire_target[2] === 0) return;

    // don't shoot if the dice say not to
    if (r > chance) return;

    M_SetAnimation(self, turret_move_fire_blind, true);
  }
});

// ---------------------------------------------------------------------------
// CHECKATTACK (cpp:807-904) -- "ignore range, just attack if available"
// ---------------------------------------------------------------------------

export const turret_checkattack = RegisterMonsterinfoCheckattack("turret_checkattack", (self: EdictT): boolean => {
  const enemy = self.enemy;
  if (enemy === null) return false;

  if (enemy.health > 0) {
    const spot1 = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + self.viewheight);
    const spot2 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);

    const blockMask: ContentsT =
      ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_WINDOW;
    let tr = giTraceline(spot1, spot2, self, blockMask);

    const trEnt = tr.ent !== null ? g_edicts[tr.ent.s.number] : g_edicts[0];

    // do we have a clear shot?
    if (trEnt !== enemy && (trEnt.svflags & SvflagsT.SVF_PLAYER) === 0) {
      if (enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) {
        // if we can't see our target, and we're not blocked by a monster, go into blind fire if available
        if ((trEnt.svflags & SvflagsT.SVF_MONSTER) === 0 && !visible(self, enemy)) {
          if (self.monsterinfo.blindfire && self.monsterinfo.blind_fire_delay <= Gtime_from_sec(10)) {
            if (level.time < self.monsterinfo.attack_finished) return false;
            if (level.time < Gtime_add(self.monsterinfo.trail_time, self.monsterinfo.blind_fire_delay)) return false;

            tr = giTraceline(spot1, self.monsterinfo.blind_fire_target, self, ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER);
            const tr2Ent = tr.ent !== null ? g_edicts[tr.ent.s.number] : g_edicts[0];
            if (tr.allsolid || tr.startsolid || (tr.fraction < 1.0 && tr2Ent !== enemy && (tr2Ent.svflags & SvflagsT.SVF_PLAYER) === 0)) {
              return false;
            }

            self.monsterinfo.attack_state = MonsterAttackStateT.AS_BLIND;
            self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_ms(500), Gtime_from_sec(2.5)));
            return true;
          }
        }
        return false;
      }
    }
  }

  if (level.time < self.monsterinfo.attack_finished) return false;

  let chance: number;
  let nexttime: import("./gtime").GTime;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET)) {
    chance = 0.1;
    nexttime = Gtime_add(Gtime_from_sec(1.8), Gtime_from_sec(-0.2 * skillInteger()));
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BLASTER)) {
    chance = 0.35;
    nexttime = Gtime_add(Gtime_from_sec(1.2), Gtime_from_sec(-0.2 * skillInteger()));
  } else {
    chance = 0.5;
    nexttime = Gtime_add(Gtime_from_sec(0.8), Gtime_from_sec(-0.1 * skillInteger()));
  }

  if (skillInteger() === 0) chance *= 0.5;
  else if (skillInteger() > 1) chance *= 2;

  if ((frandom() < chance && visible(self, enemy)) || enemy.solid === SolidT.SOLID_NOT) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    self.monsterinfo.attack_finished = Gtime_add(level.time, nexttime);
    return true;
  }

  self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  return false;
});

// ---------------------------------------------------------------------------
// PAIN (cpp:582-584) -- genuinely empty C++ body.
// ---------------------------------------------------------------------------

export const turret_pain: PainFn = RegisterPain("turret_pain", (_self: EdictT, _other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {});

// ---------------------------------------------------------------------------
// DEATH (cpp:590-642)
// ---------------------------------------------------------------------------

export const turret_die: DieFn = RegisterDie("turret_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, _mod: ModT): void => {
  const { forward } = AngleVectors_destructured(self.s.angles);
  self.s.origin = vec3_add(self.s.origin, forward);

  ThrowGibs(self, 2, [{ count: 2, gibname: "models/objects/debris1/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS }]);
  ThrowGibs(self, 1, [{ count: 2, gibname: "models/objects/debris1/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS }]);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_PLAIN_EXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  if (self.teamchain !== null) {
    const base = self.teamchain;
    base.solid = SolidT.SOLID_NOT;
    base.takedamage = false;
    base.movetype = MovetypeT.MOVETYPE_NONE;
    base.teammaster = base;
    base.teamchain = null;
    base.flags &= ~EntFlagsT.FL_TEAMSLAVE;
    base.flags |= EntFlagsT.FL_TEAMMASTER;
    gi.linkentity(base);

    self.teammaster = null;
    self.teamchain = null;
    self.flags &= ~(EntFlagsT.FL_TEAMSLAVE | EntFlagsT.FL_TEAMMASTER);
  }

  if (self.target !== null) {
    if (self.enemy !== null && self.enemy.inuse) G_UseTargets(self, self.enemy);
    else G_UseTargets(self, self);
  }

  if (self.target_ent !== null) {
    G_FreeEdict(self.target_ent);
    self.target_ent = null;
  }

  const gib = ThrowGib(self, "models/monsters/turret/tris.md2", damage, GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD | GibTypeT.GIB_DEBRIS, self.s.scale);
  if (gib !== null) gib.s.frame = 14;
});

// ---------------------------------------------------------------------------
// WALL SPAWN (cpp:648-745) -- see file header's "WALL-MOUNT DEPLOYMENT".
// ---------------------------------------------------------------------------

function turret_wall_spawn(turret: EdictT): void {
  const ent = G_Spawn();
  ent.s.origin = vec3(turret.s.origin[0], turret.s.origin[1], turret.s.origin[2]);
  ent.s.angles = vec3(turret.s.angles[0], turret.s.angles[1], turret.s.angles[2]);

  let angle = Math.trunc(ent.s.angles[1]);
  if (ent.s.angles[0] === 90) angle = -1;
  else if (ent.s.angles[0] === 270) angle = -2;

  switch (angle) {
    case -1:
      ent.mins = vec3(-16, -16, -8);
      ent.maxs = vec3(16, 16, 0);
      break;
    case -2:
      ent.mins = vec3(-16, -16, 0);
      ent.maxs = vec3(16, 16, 8);
      break;
    case 0:
      ent.mins = vec3(-8, -16, -16);
      ent.maxs = vec3(0, 16, 16);
      break;
    case 90:
      ent.mins = vec3(-16, -8, -16);
      ent.maxs = vec3(16, 0, 16);
      break;
    case 180:
      ent.mins = vec3(0, -16, -16);
      ent.maxs = vec3(8, 16, 16);
      break;
    case 270:
      ent.mins = vec3(-16, 0, -16);
      ent.maxs = vec3(16, 8, 16);
      break;
    default:
      break;
  }

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;

  ent.teammaster = turret;
  turret.flags |= EntFlagsT.FL_TEAMMASTER;
  turret.teammaster = turret;
  turret.teamchain = ent;
  ent.teamchain = null;
  ent.flags |= EntFlagsT.FL_TEAMSLAVE;
  ent.owner = turret;

  ent.s.modelindex = gi.modelindex("models/monsters/turretbase/tris.md2");

  gi.linkentity(ent);
}

export const turret_wake: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("turret_wake", (ent: EdictT): void => {
  // the wall section will call this when it stops moving.
  // just return without doing anything. easiest way to have a null function.
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) {
    ent.s.sound = 0;
    return;
  }

  ent.monsterinfo.stand = turret_stand;
  ent.monsterinfo.walk = turret_walk;
  ent.monsterinfo.run = turret_run;
  ent.monsterinfo.dodge = null;
  ent.monsterinfo.attack = turret_attack;
  ent.monsterinfo.melee = null;
  ent.monsterinfo.sight = turret_sight;
  ent.monsterinfo.search = turret_search;
  M_SetAnimation(ent, turret_move_stand, true);
  ent.takedamage = true;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  // prevent counting twice
  ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;

  gi.linkentity(ent);

  stationarymonster_start(ent);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TURRET_MACHINEGUN)) ent.s.skinnum = 1;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TURRET_ROCKET)) ent.s.skinnum = 2;

  // but we do want the death to count
  ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_DO_NOT_COUNT;
});

export const turret_activate: UseFn = RegisterUse("turret_activate", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  if (self.speed === 0) self.speed = 15;
  self.moveinfo.speed = self.speed;
  self.moveinfo.accel = self.speed;
  self.moveinfo.decel = self.speed;

  let forward = vec3(0, 0, 0);
  if (self.s.angles[0] === 270) forward = vec3(0, 0, 1);
  else if (self.s.angles[0] === 90) forward = vec3(0, 0, -1);
  else if (self.s.angles[1] === 0) forward = vec3(1, 0, 0);
  else if (self.s.angles[1] === 90) forward = vec3(0, 1, 0);
  else if (self.s.angles[1] === 180) forward = vec3(-1, 0, 0);
  else if (self.s.angles[1] === 270) forward = vec3(0, -1, 0);

  // start up the turret
  let endpos = vec3_add(self.s.origin, vec3_muls(forward, 32));
  Move_Calc(self, endpos, turret_wake);

  const base = self.teamchain;
  if (base !== null) {
    base.movetype = MovetypeT.MOVETYPE_PUSH;
    base.speed = self.speed;
    base.moveinfo.speed = base.speed;
    base.moveinfo.accel = base.speed;
    base.moveinfo.decel = base.speed;

    // start up the wall section
    endpos = vec3_add(base.s.origin, vec3_muls(forward, 32));
    Move_Calc(base, endpos, turret_wake);

    base.s.sound = sound_moving;
    base.s.loop_attenuation = ATTN_NORM;
  }
});

// ---------------------------------------------------------------------------
// SPAWN (cpp:910-1070)
// ---------------------------------------------------------------------------

/*QUAKED monster_turret (1 .5 0) (-16 -16 -16) (16 16 16) Ambush Trigger_Spawn Sight Blaster MachineGun Rocket Heatbeam WallUnit

The automated defense turret that mounts on walls.
Check the weapon you want it to use: blaster, machinegun, rocket, heatbeam.
Default weapon is blaster.
When activated, wall units move 32 units in the direction they're facing.
*/
export function SP_monster_turret(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  // pre-caches
  sound_moved = gi.soundindex("turret/moved.wav");
  sound_moving = gi.soundindex("turret/moving.wav");
  gi.modelindex("models/objects/debris1/tris.md2");

  self.s.modelindex = gi.modelindex("models/monsters/turret/tris.md2");

  self.mins = vec3(-12, -12, -12);
  self.maxs = vec3(12, 12, 12);
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_BBOX;

  self.health = 50 * st.health_multiplier;
  self.gib_health = -100;
  self.mass = 250;
  self.yaw_speed = 10 * skillInteger();

  self.monsterinfo.armor_type = ItemIdT.IT_ARMOR_COMBAT;
  self.monsterinfo.armor_power = 50;

  self.flags |= EntFlagsT.FL_MECHANICAL;

  self.pain = turret_pain;
  self.die = turret_die;

  // map designer didn't specify weapon type. set it now.
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_WEAPONCHOICE)) self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TURRET_BLASTER);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_HEATBEAM)) {
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TURRET_HEATBEAM));
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TURRET_BLASTER);
  }

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_WALL_UNIT)) {
    self.monsterinfo.stand = turret_stand;
    self.monsterinfo.walk = turret_walk;
    self.monsterinfo.run = turret_run;
    self.monsterinfo.dodge = null;
    self.monsterinfo.attack = turret_attack;
    self.monsterinfo.melee = null;
    self.monsterinfo.sight = turret_sight;
    self.monsterinfo.search = turret_search;
    M_SetAnimation(self, turret_move_stand, true);
  }

  // PMM
  self.monsterinfo.checkattack = turret_checkattack;

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;
  self.monsterinfo.scale = MODEL_SCALE;
  self.gravity = 0;

  self.offset = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
  const angle = Math.trunc(self.s.angles[1]);
  switch (angle) {
    case -1: // up
      self.s.angles[0] = 270;
      self.s.angles[1] = 0;
      self.s.origin[2] += 2;
      break;
    case -2: // down
      self.s.angles[0] = 90;
      self.s.angles[1] = 0;
      self.s.origin[2] -= 2;
      break;
    case 0:
      self.s.origin[0] += 2;
      break;
    case 90:
      self.s.origin[1] += 2;
      break;
    case 180:
      self.s.origin[0] -= 2;
      break;
    case 270:
      self.s.origin[1] -= 2;
      break;
    default:
      break;
  }

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_WALL_UNIT)) {
    if (self.targetname === null) {
      G_FreeEdict(self);
      return;
    }

    self.takedamage = false;
    self.use = turret_activate;
    turret_wall_spawn(self);
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) === 0n) {
      const g_debug_monster_kills = cvarOrDefault("g_debug_monster_kills", "0");
      if (g_debug_monster_kills.value !== 0) {
        level.monsters_registered[level.total_monsters] = self;
      }
      level.total_monsters++;
    }
  } else {
    stationarymonster_start(self);
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_MACHINEGUN)) {
    gi.soundindex("infantry/infatck1.wav");
    gi.soundindex("weapons/chngnu1a.wav");
    self.s.skinnum = 1;

    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TURRET_WEAPONCHOICE));
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TURRET_MACHINEGUN);
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET)) {
    gi.soundindex("weapons/rockfly.wav");
    gi.modelindex("models/objects/rocket/tris.md2");
    gi.soundindex("chick/chkatck2.wav");
    self.s.skinnum = 2;

    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TURRET_WEAPONCHOICE));
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TURRET_ROCKET);
  } else {
    gi.modelindex("models/objects/laser/tris.md2");
    gi.soundindex("misc/lasfly.wav");
    gi.soundindex("soldier/solatck2.wav");

    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TURRET_WEAPONCHOICE));
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TURRET_BLASTER);
  }

  // PMM  - turrets don't get mad at monsters, and visa versa
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;
  // PMM - blindfire
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_ROCKET) || SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BLASTER)) self.monsterinfo.blindfire = true;
}
