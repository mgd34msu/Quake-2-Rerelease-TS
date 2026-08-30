// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_xatrix_gekk.cpp / m_xatrix_gekk.h -- the GEKK monster (xatrix / Ground
// Zero mission pack, 2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/m_xatrix_gekk.cpp (1,686
// lines, C++17) and m_xatrix_gekk.h (362 lines, 350-entry frame enum plus
// MODEL_SCALE). Behavioral code, ported bug-for-bug per PORTING.md. An
// amphibious melee monster: a claw-swipe melee (two variants), an
// underwater bite/claw combo, a leaping pounce attack (land AND water
// takeoff variants), a ranged acid "loogie" spit, and separate land/water
// stand/idle/run/pain/death animation sets driven by `self.waterlevel`.
//
// ============================================================================
// FRAME_ constants -- only identifiers the .cpp itself names are declared
// ============================================================================
// Per the leaner "only declare the FRAME_ constants actually referenced by
// identifier" style established by m_gladiator.ts/m_guncmdr.ts (frames
// referenced only by POSITION inside an `mframe_t[]` array need no name),
// the ~39 boundary/comparison constants this 1,686-line .cpp names by
// identifier are declared below, computed by hand from m_xatrix_gekk.h's
// single sequential anonymous enum (0-based, strictly sequential, 350
// total entries: stand 0-38, run 39-44, clawatk3 45-53, clawatk4 54-61,
// clawatk5 62-70, leapatk 71-89, pain3 90-100, pain4 101-113, death1
// 114-123, death2 124-134, death3 135-141, death4 142-176, rduck 177-189,
// lduck 190-202, idle 203-234, spit 235-241, amb 242-245, wdeath 246-290,
// swim 291-322, attack 323-343, pain 344-349) -- cross-checked against
// every `mframe_t[]` array's own element count in the .cpp before writing
// this file (e.g. `gekk_frames_stand[]` has exactly 39 entries, matching
// `FRAME_stand_01`..`FRAME_stand_39`).
//
// ============================================================================
// blocked_checkjump / gekk_jump_up / gekk_jump_down / gekk_jump_wait_land /
// gekk_jump_updown -- ROGUE mission-pack primitive, out of scope (stub)
// ============================================================================
// `gekk_blocked` calls `blocked_checkjump(self, dist)`
// (rogue/g_rogue_newai.cpp:123), whose only body anywhere in the source
// tree is rogue (Ground Zero's sibling mission pack), genuinely out of THIS
// unit's scope -- identical citation and identical local, unexported,
// throwing-stub treatment already landed in m_berserk.ts, m_guncmdr.ts,
// m_infantry.ts, m_mutant.ts, and m_parasite.ts. `gekk_jump_up`/
// `gekk_jump_down`/`gekk_jump_wait_land`/`gekk_jump_updown` (the code that
// stub would drive) ARE ported for real below anyway, matching those same
// five files' "port for real code that is only reachable via a
// currently-stubbed path, not deleted" precedent -- `blocked_checkplat`
// (also called from `gekk_blocked`, rogue-newai but with a REAL home in
// m_supertank.ts) is imported for real and DOES fire today; only the
// ledge-jump half of `gekk_blocked` is a genuine gap.
// `monster_jump_finished` (rogue/g_rogue_newai.cpp:101-117) is ported for
// real, duplicated locally exactly like m_parasite.ts's/m_guncmdr.ts's own
// copy (same body, same "small unexported helper duplicated per file"
// convention) -- `gekk_jump_wait_land` calls it directly.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG
// ============================================================================
// - `gekk_check_jump`'s distance check has a dead middle branch: `if
//   (distance < 100) return false; if (distance > 100) { ... }` -- when
//   `distance === 100` EXACTLY, neither branch fires and the function falls
//   through to `return true` at the bottom. Preserved verbatim (not
//   collapsed to `<=`/`>=`).
// - `gekk_swim`'s condition is IDENTICAL in both branches of its outer `if`
//   (`gekk_checkattack(self)` true or false, both ultimately reachable paths
//   funnel into water_to_land or gekk_move_swim_start the same way except
//   for one extra water_to_land case on the true branch) -- preserved
//   exactly as written, not simplified.
// - `gekk_die`'s `M_CheckGib` uses the SAME local `M_CheckGib(self, mod)`
//   helper convention every other monster file duplicates from g_local.h.
// - `isgibfest`'s 90% chance to SKIP gibbing (`frandom() > 0.9f`) is
//   deliberately inverted-sounding but correct: gibbing is the RARE event on
//   several death4 frames, not the common one.

import { vec3, type Vec3 } from "../shared/math";
import { ATTN_NORM, SurfflagsT, RenderfxT, SvflagsT, SolidT, SoundchanT, WaterLevelT, MASK_PROJECTILE, EffectsT, type KexTraceT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type ThinkFn,
  type TouchFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MovetypeT,
  EntFlagsT,
  DamageflagsT,
  ModIdT,
  GibTypeT,
  BlockedJumpResultT,
  MELEE_DISTANCE,
  RANGE_MELEE,
  RANGE_NEAR,
  RANGE_MID,
  SPAWNFLAG_MONSTER_AMBUSH,
  PlayerNoiseT,
} from "./g_local";
import { RegisterThink, RegisterTouch, RegisterDie, RegisterPain, RegisterMonsterinfoStand, RegisterMonsterinfoWalk, RegisterMonsterinfoRun, RegisterMonsterinfoSearch, RegisterMonsterinfoSight, RegisterMonsterinfoIdle, RegisterMonsterinfoMelee, RegisterMonsterinfoAttack, RegisterMonsterinfoCheckattack, RegisterMonsterinfoSetskin, RegisterMonsterinfoDodge, RegisterMonsterinfoBlocked, RegisterMmove } from "./g_save_registry";
import { gi, level, g_edicts } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, GTIME_ZERO, type GTime } from "./gtime";
import { frandom, irandom } from "./q_std";
import { random_time } from "./g_local";
import { vec3_add, vec3_sub, vec3_muls, vec3_dot, vec3_normalized, AngleVectors_destructured, vectoangles } from "./q_vec3";
import { G_Spawn, G_FreeEdict } from "./g_utils";
import { ai_stand, ai_run, ai_walk, ai_move, ai_charge, range_to, visible } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, M_ProjectFlashSource, monster_dead, walkmonster_start } from "./g_monster";
import { M_CheckBottom } from "./m_move";
import { blocked_checkplat } from "./m_supertank";
import { fire_hit } from "./g_weapon";
import { T_Damage } from "./g_combat";
import { PlayerNoise } from "./p_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { st } from "./g_spawn";
import { SpawnFlags_from, SpawnFlags_has, SpawnFlags_and, SpawnFlags_not, type SpawnFlags } from "./spawnflags";
import { blocked_checkjump as RealBlockedCheckjump } from "./rogue/g_rogue_newai";

function gEdict(index: number): EdictT {
  return g_edicts[index];
}

// ---------------------------------------------------------------------------
// m_xatrix_gekk.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

const FRAME_stand_01 = 0;
const FRAME_stand_39 = 38;
const FRAME_run_01 = 39;
const FRAME_run_06 = 44;
const FRAME_clawatk3_01 = 45;
const FRAME_clawatk3_09 = 53;
const FRAME_clawatk5_01 = 62;
const FRAME_clawatk5_09 = 70;
const FRAME_leapatk_01 = 71;
const FRAME_leapatk_04 = 74;
const FRAME_leapatk_11 = 81;
const FRAME_leapatk_12 = 82;
const FRAME_leapatk_19 = 89;
const FRAME_pain3_01 = 90;
const FRAME_pain3_11 = 100;
const FRAME_pain4_01 = 101;
const FRAME_pain4_13 = 113;
const FRAME_death1_01 = 114;
const FRAME_death1_10 = 123;
const FRAME_death3_01 = 135;
const FRAME_death3_07 = 141;
const FRAME_death4_01 = 142;
const FRAME_death4_35 = 176;
const FRAME_rduck_01 = 177;
const FRAME_rduck_13 = 189;
const FRAME_lduck_01 = 190;
const FRAME_lduck_13 = 202;
const FRAME_idle_01 = 203;
const FRAME_idle_32 = 234;
const FRAME_spit_01 = 235;
const FRAME_spit_07 = 241;
const FRAME_wdeath_01 = 246;
const FRAME_wdeath_45 = 290;
const FRAME_swim_01 = 291;
const FRAME_swim_32 = 322;
const FRAME_attack_01 = 323;
const FRAME_attack_21 = 343;
const FRAME_pain_01 = 344;
const FRAME_pain_06 = 349;

const MODEL_SCALE = 1.0;

const SPAWNFLAG_GEKK_CHANT: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_GEKK_NOJUMPING: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_GEKK_NOSWIM: SpawnFlags = SpawnFlags_from(32);

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_supertank.ts/m_flipper.ts for
// rationale)
// ---------------------------------------------------------------------------

function frame(aifunc: MframeAifuncFn | null, dist = 0, thinkfunc: MframeThinkfuncFn | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function move(firstframe: number, lastframe: number, frames: MframeT[], endfunc: MmoveEndfuncFn | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frames;
  m.endfunc = endfunc;
  return m;
}

// ---------------------------------------------------------------------------
// blocked_checkjump: formerly a local throwing stub here -- rogue/
// g_rogue_newai.ts has since landed with a real, exported version; swapped
// for a delegating import (2026-08-30 stale-comment sweep).
// ---------------------------------------------------------------------------

function blocked_checkjump(self: EdictT, dist: number): BlockedJumpResultT {
  return RealBlockedCheckjump(self, dist);
}

/** `bool monster_jump_finished(edict_t*)` (rogue/g_rogue_newai.cpp:101-117)
 *  -- duplicated locally, see file header. */
function monster_jump_finished(self: EdictT): boolean {
  const { forward } = AngleVectors_destructured(self.s.angles);
  const forward_velocity = vec3_muls(forward, vec3_dot(self.velocity, forward));

  if (Math.hypot(forward_velocity[0], forward_velocity[1], forward_velocity[2]) < 150) {
    const z_velocity = self.velocity[2];
    self.velocity = vec3_muls(forward, 150);
    self.velocity[2] = z_velocity;
  }

  return self.monsterinfo.jump_time < level.time;
}

let sound_swing = 0;
let sound_hit = 0;
let sound_hit2 = 0;
let sound_speet = 0;
let loogie_hit = 0;
let sound_death = 0;
let sound_pain1 = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_step1 = 0;
let sound_step2 = 0;
let sound_step3 = 0;
let sound_thud = 0;
let sound_chantlow = 0;
let sound_chantmid = 0;
let sound_chanthigh = 0;

// ---------------------------------------------------------------------------
// forward-referenced move tables -- see m_soldier.ts's own convention for
// this exact C++ forward-declaration shape (hoisted `let`, assigned once
// below, all consumers reference the SAME binding by closure)
// ---------------------------------------------------------------------------

let gekk_move_attack1: MmoveT;
let gekk_move_attack2: MmoveT;
let gekk_move_chant: MmoveT;
let gekk_move_swim_start: MmoveT;
let gekk_move_swim_loop: MmoveT;
let gekk_move_spit: MmoveT;
let gekk_move_run_start: MmoveT;
let gekk_move_run: MmoveT;
let gekk_move_idle2: MmoveT;
let gekk_move_leapatk: MmoveT;
let gekk_move_leapatk2: MmoveT;

// ---------------------------------------------------------------------------
// CHECKATTACK (m_xatrix_gekk.cpp:59-152)
// ---------------------------------------------------------------------------

function gekk_check_melee(self: EdictT): boolean {
  if (self.enemy === null || self.enemy.health <= 0 || self.monsterinfo.melee_debounce_time > level.time) return false;
  return range_to(self, self.enemy) <= RANGE_MELEE;
}

function gekk_check_jump(self: EdictT): boolean {
  if (self.enemy === null) return false;
  if (self.absmin[2] + 125 < self.enemy.absmin[2]) return false;

  const v = vec3(self.s.origin[0] - self.enemy.s.origin[0], self.s.origin[1] - self.enemy.s.origin[1], 0);
  const distance = Math.hypot(v[0], v[1], v[2]);

  if (distance < 100) return false;
  if (distance > 100) {
    if (frandom() < (self.waterlevel >= WaterLevelT.WATER_WAIST ? 0.2 : 0.9)) return false;
  }

  return true;
}

function gekk_check_jump_close(self: EdictT): boolean {
  if (self.enemy === null) return false;
  const v = vec3(self.s.origin[0] - self.enemy.s.origin[0], self.s.origin[1] - self.enemy.s.origin[1], 0);
  const distance = Math.hypot(v[0], v[1], v[2]);

  if (distance < 100) {
    // don't do this if our head is below their feet
    if (self.absmax[2] <= self.enemy.absmin[2]) return false;
  }

  return true;
}

const gekk_checkattack = RegisterMonsterinfoCheckattack("gekk_checkattack", (self: EdictT): boolean => {
  if (self.enemy === null || self.enemy.health <= 0) return false;

  if (gekk_check_melee(self)) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MELEE;
    return true;
  }

  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_STRAIGHT && self.monsterinfo.attack_finished > level.time) {
    // keep running fool
    return false;
  }

  if (visible(self, self.enemy, false)) {
    if (gekk_check_jump(self)) {
      self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
      return true;
    }

    if (gekk_check_jump_close(self) && (self.flags & EntFlagsT.FL_SWIM) === 0n) {
      self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
      return true;
    }
  }

  return false;
});

// ---------------------------------------------------------------------------
// SOUNDS (m_xatrix_gekk.cpp:154-217)
// ---------------------------------------------------------------------------

function gekk_step(self: EdictT): void {
  const n = irandom(3);
  if (n === 0) gi.sound(self, SoundchanT.CHAN_VOICE, sound_step1, 1, ATTN_NORM, 0);
  else if (n === 1) gi.sound(self, SoundchanT.CHAN_VOICE, sound_step2, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_step3, 1, ATTN_NORM, 0);
}

const gekk_sight = RegisterMonsterinfoSight("gekk_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const gekk_search = RegisterMonsterinfoSearch("gekk_search", (self: EdictT): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_CHANT)) {
    const r = frandom();
    if (r < 0.33) gi.sound(self, SoundchanT.CHAN_VOICE, sound_chantlow, 1, ATTN_NORM, 0);
    else if (r < 0.66) gi.sound(self, SoundchanT.CHAN_VOICE, sound_chantmid, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, sound_chanthigh, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, SoundchanT.CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
  }

  self.health += irandom(10, 20);
  if (self.health > self.max_health) self.health = self.max_health;

  self.monsterinfo.setskin?.(self);
});

const gekk_setskin = RegisterMonsterinfoSetskin("gekk_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 4) self.s.skinnum = 2;
  else if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

function gekk_swing(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_swing, 1, ATTN_NORM, 0);
}

function gekk_face(self: EdictT): void {
  M_SetAnimation(self, gekk_move_run, true);
}

// ---------------------------------------------------------------------------
// STAND (m_xatrix_gekk.cpp:219-441)
// ---------------------------------------------------------------------------

function ai_stand_gekk(self: EdictT, dist: number): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_CHANT)) {
    ai_move(self, dist);
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH) && self.monsterinfo.idle !== null && level.time > self.monsterinfo.idle_time) {
      if (self.monsterinfo.idle_time !== GTIME_ZERO) {
        self.monsterinfo.idle(self);
        self.monsterinfo.idle_time = Gtime_add(level.time, random_time(Gtime_from_sec(15), Gtime_from_sec(30)));
      } else {
        self.monsterinfo.idle_time = Gtime_add(level.time, random_time(Gtime_from_sec(15)));
      }
    }
  } else {
    ai_stand(self, dist);
  }
}

const gekk_frames_stand: MframeT[] = [...Array.from({ length: 38 }, () => frame(ai_stand_gekk)), frame(ai_stand_gekk, 0, gekk_check_underwater)];
const gekk_move_stand = RegisterMmove("gekk_move_stand", move(FRAME_stand_01, FRAME_stand_39, gekk_frames_stand, null));

const GEKK_UNDERWATER_DISTS = [14, 14, 14, 14, 16, 16, 16, 18, 18, 18, 20, 20, 22, 22, 24, 24, 26, 26, 24, 24, 22, 22, 22, 22, 22, 22, 22, 22, 18, 18, 18, 18];

const gekk_frames_standunderwater: MframeT[] = GEKK_UNDERWATER_DISTS.map((d) => frame(ai_stand_gekk, d));
const gekk_move_standunderwater = RegisterMmove("gekk_move_standunderwater", move(FRAME_swim_01, FRAME_swim_32, gekk_frames_standunderwater, null));

function gekk_swim_loop(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  self.flags |= EntFlagsT.FL_SWIM;
  M_SetAnimation(self, gekk_move_swim_loop, true);
}

const gekk_frames_swim: MframeT[] = GEKK_UNDERWATER_DISTS.map((d) => frame(ai_run, d));
gekk_move_swim_loop = RegisterMmove("gekk_move_swim_loop", move(FRAME_swim_01, FRAME_swim_32, gekk_frames_swim, gekk_swim_loop));

const gekk_frames_swim_start: MframeT[] = GEKK_UNDERWATER_DISTS.map((d, i) => {
  if (i === 8) return frame(ai_run, d, gekk_hit_left);
  if (i === 14) return frame(ai_run, d, gekk_hit_right);
  if (i === 20) return frame(ai_run, d, gekk_bite);
  return frame(ai_run, d);
});
gekk_move_swim_start = RegisterMmove("gekk_move_swim_start", move(FRAME_swim_01, FRAME_swim_32, gekk_frames_swim_start, gekk_swim_loop));

function gekk_swim(self: EdictT): void {
  if (gekk_checkattack(self)) {
    if (self.enemy !== null && self.enemy.waterlevel < WaterLevelT.WATER_WAIST && frandom() > 0.7) water_to_land(self);
    else M_SetAnimation(self, gekk_move_swim_start, true);
  } else {
    M_SetAnimation(self, gekk_move_swim_start, true);
  }
}
void gekk_swim; // m_xatrix_gekk.cpp:416-427: declared, never referenced from anywhere else in this file (pre-existing dead code, preserved -- see m_supertank.ts's `supertank_forward` precedent for this exact shape)

const gekk_stand = RegisterMonsterinfoStand("gekk_stand", (self: EdictT): void => {
  if (self.waterlevel >= WaterLevelT.WATER_WAIST) {
    self.flags |= EntFlagsT.FL_SWIM;
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
    M_SetAnimation(self, gekk_move_standunderwater, true);
  } else if (self.monsterinfo.active_move !== gekk_move_chant) {
    // Don't break out of the chant loop, which is initiated in the spawn function
    M_SetAnimation(self, gekk_move_stand, true);
  }
});

function gekk_chant(self: EdictT): void {
  M_SetAnimation(self, gekk_move_chant, true);
}

// ---------------------------------------------------------------------------
// IDLE (m_xatrix_gekk.cpp:448-544)
// ---------------------------------------------------------------------------

function gekk_idle_loop(self: EdictT): void {
  if (frandom() > 0.75 && self.health < self.max_health) self.monsterinfo.nextframe = FRAME_idle_01;
}

const gekk_frames_idle: MframeT[] = [
  frame(ai_stand_gekk, 0, gekk_search),
  ...Array.from({ length: 30 }, () => frame(ai_stand_gekk)),
  frame(ai_stand_gekk, 0, gekk_idle_loop),
];
const gekk_move_idle = RegisterMmove("gekk_move_idle", move(FRAME_idle_01, FRAME_idle_32, gekk_frames_idle, gekk_stand));
gekk_move_idle2 = RegisterMmove("gekk_move_idle2", move(FRAME_idle_01, FRAME_idle_32, gekk_frames_idle, gekk_face));

const gekk_frames_idle2: MframeT[] = [
  frame(ai_move, 0, gekk_search),
  ...Array.from({ length: 30 }, () => frame(ai_move)),
  frame(ai_move, 0, gekk_idle_loop),
];
gekk_move_chant = RegisterMmove("gekk_move_chant", move(FRAME_idle_01, FRAME_idle_32, gekk_frames_idle2, gekk_chant));

const gekk_idle = RegisterMonsterinfoIdle("gekk_idle", (self: EdictT): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_NOSWIM) || self.waterlevel < WaterLevelT.WATER_WAIST) M_SetAnimation(self, gekk_move_idle, true);
  else M_SetAnimation(self, gekk_move_swim_start, true);
});

// ---------------------------------------------------------------------------
// WALK (m_xatrix_gekk.cpp:546-564)
// ---------------------------------------------------------------------------

const GEKK_STEP_DISTS = [3.849, 19.606, 25.583, 34.625, 27.365, 28.48];

const gekk_frames_walk: MframeT[] = GEKK_STEP_DISTS.map((d, i) => (i === 0 ? frame(ai_walk, d, gekk_check_underwater) : i === 3 ? frame(ai_walk, d, gekk_step) : frame(ai_walk, d)));
const gekk_move_walk = RegisterMmove("gekk_move_walk", move(FRAME_run_01, FRAME_run_06, gekk_frames_walk, null));

const gekk_walk = RegisterMonsterinfoWalk("gekk_walk", (self: EdictT): void => {
  M_SetAnimation(self, gekk_move_walk, true);
});

// ---------------------------------------------------------------------------
// RUN (m_xatrix_gekk.cpp:566-613)
// ---------------------------------------------------------------------------

const gekk_run_start = RegisterMonsterinfoRun("gekk_run_start", (self: EdictT): void => {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_NOSWIM) && self.waterlevel >= WaterLevelT.WATER_WAIST) M_SetAnimation(self, gekk_move_swim_start, true);
  else M_SetAnimation(self, gekk_move_run_start, true);
});

function gekk_run(self: EdictT): void {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_NOSWIM) && self.waterlevel >= WaterLevelT.WATER_WAIST) {
    M_SetAnimation(self, gekk_move_swim_start, true);
    return;
  }
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, gekk_move_stand, true);
  else M_SetAnimation(self, gekk_move_run, true);
}

const gekk_frames_run: MframeT[] = GEKK_STEP_DISTS.map((d, i) => (i === 0 ? frame(ai_run, d, gekk_check_underwater) : i === 3 ? frame(ai_run, d, gekk_step) : frame(ai_run, d)));
gekk_move_run = RegisterMmove("gekk_move_run", move(FRAME_run_01, FRAME_run_06, gekk_frames_run, null));

const gekk_frames_run_st: MframeT[] = [frame(ai_run, 0.212), frame(ai_run, 19.753)];
gekk_move_run_start = RegisterMmove("gekk_move_run_start", move(FRAME_stand_01, FRAME_stand_01 + 1, gekk_frames_run_st, gekk_run));

// ---------------------------------------------------------------------------
// MELEE (m_xatrix_gekk.cpp:615-914)
// ---------------------------------------------------------------------------

function gekk_hit_left(self: EdictT): void {
  if (self.enemy === null) return;
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, irandom(5, 10), 100)) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_hit, 1, ATTN_NORM, 0);
  else {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_ms(1500));
  }
}

function gekk_hit_right(self: EdictT): void {
  if (self.enemy === null) return;
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, irandom(5, 10), 100)) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_hit2, 1, ATTN_NORM, 0);
  else {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_ms(1500));
  }
}

function gekk_check_refire(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse || self.enemy.health <= 0) return;

  if (range_to(self, self.enemy) <= RANGE_MELEE && self.monsterinfo.melee_debounce_time <= level.time) {
    if (self.s.frame === FRAME_clawatk3_09) M_SetAnimation(self, gekk_move_attack2, true);
    else if (self.s.frame === FRAME_clawatk5_09) M_SetAnimation(self, gekk_move_attack1, true);
  }
}

/** `TOUCH(loogie_touch)` (m_xatrix_gekk.cpp:664-685). */
const loogie_touch: TouchFn = RegisterTouch("loogie_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  const owner = self.owner;
  if (owner !== null && owner.client !== null) PlayerNoise(owner, self.s.origin, PlayerNoiseT.PNOISE_IMPACT);

  if (other.takedamage) {
    T_Damage(other, self, owner ?? self, self.velocity, self.s.origin, tr.plane.normal, self.dmg, 1, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_GEKK));
  }

  gi.sound(self, SoundchanT.CHAN_AUTO, loogie_hit, 1.0, ATTN_NORM, 0);

  G_FreeEdict(self);
});

/** `void fire_loogie(edict_t*, const vec3_t&, const vec3_t&, int, int)`
 *  (m_xatrix_gekk.cpp:687-719). */
function fire_loogie(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number): void {
  const loogie = G_Spawn();
  loogie.s.origin = vec3(start[0], start[1], start[2]);
  loogie.s.old_origin = vec3(start[0], start[1], start[2]);
  loogie.s.angles = vectoangles(dir);
  loogie.velocity = vec3_muls(dir, speed);
  loogie.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  loogie.clipmask = MASK_PROJECTILE;
  loogie.solid = SolidT.SOLID_BBOX;
  // Paril: this was originally the wrong effect, but it makes it look more acid-y.
  loogie.s.effects |= EffectsT.EF_BLASTER;
  loogie.s.renderfx |= RenderfxT.RF_FULLBRIGHT;
  loogie.s.modelindex = gi.modelindex("models/objects/loogy/tris.md2");
  loogie.owner = self;
  loogie.touch = loogie_touch;
  loogie.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
  loogie.think = G_FreeEdict;
  loogie.dmg = damage;
  loogie.svflags |= SvflagsT.SVF_PROJECTILE;
  gi.linkentity(loogie);

  const tr = gi.trace(self.s.origin, null, null, loogie.s.origin, loogie, MASK_PROJECTILE);
  if (tr.fraction < 1.0) {
    loogie.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    loogie.touch?.(loogie, tr.ent !== null ? gEdict(tr.ent.s.number) : gEdict(0), tr, false);
  }
}

function loogie(self: EdictT): void {
  if (self.enemy === null || self.enemy.health <= 0) return;

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const gekkoffset = vec3(-18, -0.8, 24);
  let start = M_ProjectFlashSource(self, gekkoffset, forward, right);
  const { up } = AngleVectors_destructured(self.s.angles);
  start = vec3_add(start, vec3_muls(up, 2));

  const end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dir = vec3_normalized(vec3_sub(end, start));

  fire_loogie(self, start, dir, 5, 550);

  gi.sound(self, SoundchanT.CHAN_BODY, sound_speet, 1.0, ATTN_NORM, 0);
}

function reloogie(self: EdictT): void {
  if (frandom() > 0.8 && self.health < self.max_health) {
    M_SetAnimation(self, gekk_move_idle2, true);
    return;
  }

  if (self.enemy !== null && self.enemy.health >= 0) {
    if (frandom() > 0.7 && range_to(self, self.enemy) <= RANGE_NEAR) M_SetAnimation(self, gekk_move_spit, true);
  }
}

const gekk_frames_spit: MframeT[] = [frame(ai_charge), frame(ai_charge), frame(ai_charge), frame(ai_charge), frame(ai_charge), frame(ai_charge, 0, loogie), frame(ai_charge, 0, reloogie)];
gekk_move_spit = RegisterMmove("gekk_move_spit", move(FRAME_spit_01, FRAME_spit_07, gekk_frames_spit, gekk_run_start));

const gekk_frames_attack1: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, gekk_hit_left),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, gekk_check_refire),
];
gekk_move_attack1 = RegisterMmove("gekk_move_attack1", move(FRAME_clawatk3_01, FRAME_clawatk3_09, gekk_frames_attack1, gekk_run_start));

const gekk_frames_attack2: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, gekk_hit_left),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, gekk_hit_right),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, gekk_check_refire),
];
gekk_move_attack2 = RegisterMmove("gekk_move_attack2", move(FRAME_clawatk5_01, FRAME_clawatk5_09, gekk_frames_attack2, gekk_run_start));

function gekk_check_underwater(self: EdictT): void {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_NOSWIM) && self.waterlevel >= WaterLevelT.WATER_WAIST) land_to_water(self);
}

const GEKK_LEAPATK_DISTS = [0, -0.387, -1.113, -0.237, 6.72, 6.414, 0.163, 28.316, 24.198, 31.742, 35.977, 12.303, 20.122, -1.042, 2.556, 0.544, 1.862, 1.224, -0.457];

const gekk_frames_leapatk: MframeT[] = GEKK_LEAPATK_DISTS.map((d, i) => {
  if (i === 4) return frame(ai_charge, d, gekk_jump_takeoff);
  if (i === 10) return frame(ai_charge, d, gekk_check_landing);
  if (i >= 11 && i <= 17) return frame(ai_charge, d, gekk_stop_skid);
  if (i === 18) return frame(ai_charge, d, gekk_check_underwater);
  return frame(ai_charge, d);
});
gekk_move_leapatk = RegisterMmove("gekk_move_leapatk", move(FRAME_leapatk_01, FRAME_leapatk_19, gekk_frames_leapatk, gekk_run_start));

const gekk_frames_leapatk2: MframeT[] = GEKK_LEAPATK_DISTS.map((d, i) => {
  if (i === 4) return frame(ai_charge, d, gekk_jump_takeoff2);
  if (i === 10) return frame(ai_charge, d, gekk_check_landing);
  if (i >= 11 && i <= 17) return frame(ai_charge, d, gekk_stop_skid);
  if (i === 18) return frame(ai_charge, d, gekk_check_underwater);
  return frame(ai_charge, d);
});
gekk_move_leapatk2 = RegisterMmove("gekk_move_leapatk2", move(FRAME_leapatk_01, FRAME_leapatk_19, gekk_frames_leapatk2, gekk_run_start));

function gekk_bite(self: EdictT): void {
  if (self.enemy === null) return;
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  fire_hit(self, aim, 5, 0);
}

function gekk_preattack(_self: EdictT): void {
  // underwater attack sound -- commented out in the shipped source, preserved as a no-op
}

const gekk_frames_attack: MframeT[] = [
  frame(ai_charge, 16, gekk_preattack),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16, gekk_bite),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16, gekk_bite),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16, gekk_hit_left),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
  frame(ai_charge, 16, gekk_hit_right),
  frame(ai_charge, 16),
  frame(ai_charge, 16),
];
const gekk_move_attack = RegisterMmove("gekk_move_attack", move(FRAME_attack_01, FRAME_attack_21, gekk_frames_attack, gekk_run_start));

const gekk_melee = RegisterMonsterinfoMelee("gekk_melee", (self: EdictT): void => {
  if (self.waterlevel >= WaterLevelT.WATER_WAIST) {
    M_SetAnimation(self, gekk_move_attack, true);
  } else {
    const r = frandom();
    if (r > 0.66) M_SetAnimation(self, gekk_move_attack1, true);
    else M_SetAnimation(self, gekk_move_attack2, true);
  }
});

// ---------------------------------------------------------------------------
// ATTACK (m_xatrix_gekk.cpp:916-1082)
// ---------------------------------------------------------------------------

/** `TOUCH(gekk_jump_touch)` (m_xatrix_gekk.cpp:920-956). */
const gekk_jump_touch: TouchFn = RegisterTouch("gekk_jump_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (self.health <= 0) {
    self.touch = null;
    return;
  }

  if (self.style === 1 && other.takedamage) {
    if (Math.hypot(self.velocity[0], self.velocity[1], self.velocity[2]) > 200) {
      const normal = vec3_normalized(vec3(self.velocity[0], self.velocity[1], self.velocity[2]));
      const point = vec3_add(self.s.origin, vec3_muls(normal, self.maxs[0]));
      const damage = irandom(10, 20);
      T_Damage(other, self, self, self.velocity, point, normal, damage, damage, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_GEKK));
      self.style = 0;
    }
  }

  if (!M_CheckBottom(self)) {
    if (self.groundentity !== null) {
      self.monsterinfo.nextframe = FRAME_leapatk_11;
      self.touch = null;
    }
    return;
  }

  self.touch = null;
});

function gekk_jump_takeoff(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  const { forward } = AngleVectors_destructured(self.s.angles);
  self.s.origin[2] += 1;

  // high jump
  if (gekk_check_jump(self)) {
    self.velocity = vec3_muls(forward, 700);
    self.velocity[2] = 250;
  } else {
    self.velocity = vec3_muls(forward, 250);
    self.velocity[2] = 400;
  }

  self.groundentity = null;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DUCKED;
  self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_sec(3));
  self.touch = gekk_jump_touch;
  self.style = 1;
}

function gekk_jump_takeoff2(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  const { forward } = AngleVectors_destructured(self.s.angles);
  if (self.enemy !== null) self.s.origin[2] = self.enemy.s.origin[2];

  if (gekk_check_jump(self)) {
    self.velocity = vec3_muls(forward, 300);
    self.velocity[2] = 250;
  } else {
    self.velocity = vec3_muls(forward, 150);
    self.velocity[2] = 300;
  }

  self.groundentity = null;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DUCKED;
  self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_sec(3));
  self.touch = gekk_jump_touch;
  self.style = 1;
}

function gekk_stop_skid(self: EdictT): void {
  if (self.groundentity !== null) self.velocity = vec3(0, 0, 0);
}

function gekk_check_landing(self: EdictT): void {
  if (self.groundentity !== null) {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_thud, 1, ATTN_NORM, 0);
    self.monsterinfo.attack_finished = GTIME_ZERO;

    self.monsterinfo.unduck?.(self);

    self.velocity = vec3(0, 0, 0);
    return;
  }

  // Paril: allow them to "pull" up ledges
  const { forward: fwd } = AngleVectors_destructured(self.s.angles);

  if (vec3_dot(fwd, self.velocity) < 200) self.velocity = vec3_add(self.velocity, vec3_muls(fwd, 200));

  // note to self: causing skid
  if (level.time > self.monsterinfo.attack_finished) self.monsterinfo.nextframe = FRAME_leapatk_11;
  else self.monsterinfo.nextframe = FRAME_leapatk_12;
}

const gekk_attack = RegisterMonsterinfoAttack("gekk_attack", (self: EdictT): void => {
  const r = self.enemy !== null ? range_to(self, self.enemy) : 0;

  if ((self.flags & EntFlagsT.FL_SWIM) !== 0n) {
    if (self.enemy !== null && self.enemy.waterlevel >= WaterLevelT.WATER_WAIST && r <= RANGE_NEAR) return;

    self.flags &= ~EntFlagsT.FL_SWIM;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_ALTERNATE_FLY;
    M_SetAnimation(self, gekk_move_leapatk, true);
    self.monsterinfo.nextframe = FRAME_leapatk_04 + 1; // FRAME_leapatk_05
  } else {
    if (r >= RANGE_MID) {
      if (frandom() > 0.5) M_SetAnimation(self, gekk_move_spit, true);
      else {
        M_SetAnimation(self, gekk_move_run_start, true);
        self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_sec(2));
      }
    } else if (frandom() > 0.7) {
      M_SetAnimation(self, gekk_move_spit, true);
    } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_NOJUMPING) || frandom() > 0.7) {
      M_SetAnimation(self, gekk_move_run_start, true);
      self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_ms(1400));
    } else {
      M_SetAnimation(self, gekk_move_leapatk, true);
    }
  }
});

// ---------------------------------------------------------------------------
// PAIN (m_xatrix_gekk.cpp:1084-1169)
// ---------------------------------------------------------------------------

const gekk_frames_pain: MframeT[] = Array.from({ length: 6 }, () => frame(ai_move));
const gekk_move_pain = RegisterMmove("gekk_move_pain", move(FRAME_pain_01, FRAME_pain_06, gekk_frames_pain, gekk_run_start));

const gekk_frames_pain1: MframeT[] = [...Array.from({ length: 10 }, () => frame(ai_move)), frame(ai_move, 0, gekk_check_underwater)];
const gekk_move_pain1 = RegisterMmove("gekk_move_pain1", move(FRAME_pain3_01, FRAME_pain3_11, gekk_frames_pain1, gekk_run_start));

const gekk_frames_pain2: MframeT[] = [...Array.from({ length: 12 }, () => frame(ai_move)), frame(ai_move, 0, gekk_check_underwater)];
const gekk_move_pain2 = RegisterMmove("gekk_move_pain2", move(FRAME_pain4_01, FRAME_pain4_13, gekk_frames_pain2, gekk_run_start));

const gekk_pain = RegisterPain("gekk_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_CHANT)) {
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_GEKK_CHANT));
    return;
  }

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);

  if (self.waterlevel >= WaterLevelT.WATER_WAIST) {
    if ((self.flags & EntFlagsT.FL_SWIM) === 0n) {
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
      self.flags |= EntFlagsT.FL_SWIM;
    }

    if (M_ShouldReactToPain(self, mod)) M_SetAnimation(self, gekk_move_pain, true);
  } else if (M_ShouldReactToPain(self, mod)) {
    const r = frandom();
    if (r > 0.5) M_SetAnimation(self, gekk_move_pain1, true);
    else M_SetAnimation(self, gekk_move_pain2, true);
  }
});

// ---------------------------------------------------------------------------
// DEATH (m_xatrix_gekk.cpp:1171-1361)
// ---------------------------------------------------------------------------

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag && mod.id === ModIdT.MOD_CRUSH) return true;
  return self.health <= self.gib_health;
}

function gekk_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  monster_dead(self);
}

function gekk_gib(self: EdictT, damage: number): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

  const gibs: GibDefT[] = [
    { gibname: "models/objects/gekkgib/pelvis/tris.md2", type: GibTypeT.GIB_ACID },
    { gibname: "models/objects/gekkgib/arm/tris.md2", count: 2, type: GibTypeT.GIB_ACID },
    { gibname: "models/objects/gekkgib/torso/tris.md2", type: GibTypeT.GIB_ACID },
    { gibname: "models/objects/gekkgib/claw/tris.md2", type: GibTypeT.GIB_ACID },
    { gibname: "models/objects/gekkgib/leg/tris.md2", count: 2, type: GibTypeT.GIB_ACID },
    { gibname: "models/objects/gekkgib/head/tris.md2", type: GibTypeT.GIB_ACID | GibTypeT.GIB_HEAD },
  ];
  ThrowGibs(self, damage, gibs);
}

function gekk_gibfest(self: EdictT): void {
  gekk_gib(self, 20);
  self.deadflag = true;
}

function isgibfest(self: EdictT): void {
  if (frandom() > 0.9) gekk_gibfest(self);
}

function gekk_shrink(self: EdictT): void {
  self.maxs[2] = 0;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const GEKK_DEATH1_DISTS = [-5.151, -12.223, -11.484, -17.952, -6.953, -7.393, -10.713, -17.464, -11.678, -11.678];
const gekk_frames_death1: MframeT[] = GEKK_DEATH1_DISTS.map((d, i) => (i === 5 ? frame(ai_move, d, gekk_shrink) : frame(ai_move, d)));
const gekk_move_death1 = RegisterMmove("gekk_move_death1", move(FRAME_death1_01, FRAME_death1_10, gekk_frames_death1, gekk_dead));

const GEKK_DEATH3_DISTS = [0, 0.022, 0.169, -0.71, -13.446, -7.654, -31.951];
const gekk_frames_death3: MframeT[] = GEKK_DEATH3_DISTS.map((d, i) => (i === 5 ? frame(ai_move, d, isgibfest) : frame(ai_move, d)));
const gekk_move_death3 = RegisterMmove("gekk_move_death3", move(FRAME_death3_01, FRAME_death3_07, gekk_frames_death3, gekk_dead));

const GEKK_DEATH4_DISTS = [
  5.103, -4.808, -10.509, -9.899, 4.033, -5.197, -0.919, -8.821, -5.626, -8.865, -0.845, 1.986, 0.17, 1.339, -0.922, 0.818, -1.288, -1.408, -7.787, -3.995, -4.604, -1.715, -0.564, -0.597, 0.074,
  -0.309, -0.395, -0.501, -0.325, -0.931, -1.433, -1.626, 4.68, 0.56, -0.549,
];
const GEKK_DEATH4_GIBFEST_INDICES = new Set([4, 9, 13, 17, 21, 25, 29]);
const gekk_frames_death4: MframeT[] = GEKK_DEATH4_DISTS.map((d, i) => {
  if (i === 34) return frame(ai_move, d, gekk_gibfest);
  if (GEKK_DEATH4_GIBFEST_INDICES.has(i)) return frame(ai_move, d, isgibfest);
  return frame(ai_move, d);
});
const gekk_move_death4 = RegisterMmove("gekk_move_death4", move(FRAME_death4_01, FRAME_death4_35, gekk_frames_death4, gekk_dead));

const gekk_frames_wdeath: MframeT[] = Array.from({ length: 45 }, () => frame(ai_move));
const gekk_move_wdeath = RegisterMmove("gekk_move_wdeath", move(FRAME_wdeath_01, FRAME_wdeath_45, gekk_frames_wdeath, gekk_dead));

const gekk_die = RegisterDie("gekk_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
  if (M_CheckGib(self, mod)) {
    gekk_gib(self, damage);
    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = true;
  self.takedamage = true;

  if (self.waterlevel >= WaterLevelT.WATER_WAIST) {
    gekk_shrink(self);
    M_SetAnimation(self, gekk_move_wdeath, true);
  } else {
    const r = frandom();
    if (r > 0.66) M_SetAnimation(self, gekk_move_death1, true);
    else if (r > 0.33) M_SetAnimation(self, gekk_move_death3, true);
    else M_SetAnimation(self, gekk_move_death4, true);
  }
});

// ---------------------------------------------------------------------------
// duck (m_xatrix_gekk.cpp:1363-1481)
// ---------------------------------------------------------------------------

const gekk_frames_lduck: MframeT[] = Array.from({ length: 13 }, () => frame(ai_move));
const gekk_move_lduck = RegisterMmove("gekk_move_lduck", move(FRAME_lduck_01, FRAME_lduck_13, gekk_frames_lduck, gekk_run_start));

const gekk_frames_rduck: MframeT[] = Array.from({ length: 13 }, () => frame(ai_move));
const gekk_move_rduck = RegisterMmove("gekk_move_rduck", move(FRAME_rduck_01, FRAME_rduck_13, gekk_frames_rduck, gekk_run_start));
void gekk_move_lduck; // m_xatrix_gekk.cpp:1401-1481: only referenced from `gekk_dodge`'s `#if 0`-guarded body -- see below
void gekk_move_rduck;

// m_xatrix_gekk.cpp:1401-1481's ENTIRE `MONSTERINFO_DODGE(gekk_dodge)` body
// is wrapped in `#if 0` ("[Paril-KEX] this dodge is bad") -- dropped
// silently per PORTING.md's "#if 0 blocks are dropped silently" (the
// function itself still needs a real, empty body registered under its real
// save name, since `self.monsterinfo.dodge = gekk_dodge` is wired
// unconditionally in `SP_monster_gekk`).
const gekk_dodge = RegisterMonsterinfoDodge("gekk_dodge", (_self: EdictT, _attacker: EdictT, _eta: GTime, _tr: KexTraceT | null, _gravity: boolean): void => {
  // #if 0 in the shipped source -- intentionally empty, see file header.
});

// ---------------------------------------------------------------------------
// SPAWN (m_xatrix_gekk.cpp:1483-1660)
// ---------------------------------------------------------------------------

function gekk_set_fly_parameters(self: EdictT): void {
  self.monsterinfo.fly_thrusters = false;
  self.monsterinfo.fly_acceleration = 25.0;
  self.monsterinfo.fly_speed = 150.0;
  // only melee, so get in close
  self.monsterinfo.fly_min_distance = 10.0;
  self.monsterinfo.fly_max_distance = 10.0;
}

// ================
// ROGUE
function gekk_jump_down(self: EdictT): void {
  const { forward, up } = AngleVectors_destructured(self.s.angles);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 100));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 300));
}

function gekk_jump_up(self: EdictT): void {
  const { forward, up } = AngleVectors_destructured(self.s.angles);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 200));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 450));
}

function gekk_jump_wait_land(self: EdictT): void {
  if (!monster_jump_finished(self) && self.groundentity === null) self.monsterinfo.nextframe = self.s.frame;
  else self.monsterinfo.nextframe = self.s.frame + 1;
}

const gekk_frames_jump_up: MframeT[] = [
  frame(ai_move, -8, gekk_jump_up),
  frame(ai_move, -8),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, gekk_jump_wait_land),
  frame(ai_move),
];
const gekk_move_jump_up = RegisterMmove("gekk_move_jump_up", move(FRAME_leapatk_04, FRAME_leapatk_11, gekk_frames_jump_up, gekk_run));

const gekk_frames_jump_down: MframeT[] = [
  frame(ai_move, 0, gekk_jump_down),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, gekk_jump_wait_land),
  frame(ai_move),
];
const gekk_move_jump_down = RegisterMmove("gekk_move_jump_down", move(FRAME_leapatk_04, FRAME_leapatk_11, gekk_frames_jump_down, gekk_run));

function gekk_jump_updown(self: EdictT, result: BlockedJumpResultT): void {
  if (self.enemy === null) return;
  if (result === BlockedJumpResultT.JUMP_JUMP_UP) M_SetAnimation(self, gekk_move_jump_up, true);
  else M_SetAnimation(self, gekk_move_jump_down, true);
}

/**
 * Blocked (m_xatrix_gekk.cpp:1566-1579)
 */
const gekk_blocked = RegisterMonsterinfoBlocked("gekk_blocked", (self: EdictT, dist: number): boolean => {
  const result = blocked_checkjump(self, dist);
  if (result !== BlockedJumpResultT.NO_JUMP) {
    if (result !== BlockedJumpResultT.JUMP_TURN) gekk_jump_updown(self, result);
    return true;
  }

  if (blocked_checkplat(self, dist)) return true;

  return false;
});
// ROGUE
// ================

/**
 * QUAKED monster_gekk (1 .5 0) (-16 -16 -24) (16 16 24) Ambush Trigger_Spawn
 * Sight Chant NoJumping
 * `void SP_monster_gekk(edict_t *self)` (m_xatrix_gekk.cpp:1585-1660).
 */
export function SP_monster_gekk(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_swing = gi.soundindex("gek/gk_atck1.wav");
  sound_hit = gi.soundindex("gek/gk_atck2.wav");
  sound_hit2 = gi.soundindex("gek/gk_atck3.wav");
  sound_speet = gi.soundindex("gek/gk_atck4.wav");
  loogie_hit = gi.soundindex("gek/loogie_hit.wav");
  sound_death = gi.soundindex("gek/gk_deth1.wav");
  sound_pain1 = gi.soundindex("gek/gk_pain1.wav");
  sound_sight = gi.soundindex("gek/gk_sght1.wav");
  sound_search = gi.soundindex("gek/gk_idle1.wav");
  sound_step1 = gi.soundindex("gek/gk_step1.wav");
  sound_step2 = gi.soundindex("gek/gk_step2.wav");
  sound_step3 = gi.soundindex("gek/gk_step3.wav");
  sound_thud = gi.soundindex("mutant/thud1.wav");

  sound_chantlow = gi.soundindex("gek/gek_low.wav");
  sound_chantmid = gi.soundindex("gek/gek_mid.wav");
  sound_chanthigh = gi.soundindex("gek/gek_high.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/gekk/tris.md2");
  self.mins = vec3(-18, -18, -24);
  self.maxs = vec3(18, 18, 24);

  gi.modelindex("models/objects/gekkgib/pelvis/tris.md2");
  gi.modelindex("models/objects/gekkgib/arm/tris.md2");
  gi.modelindex("models/objects/gekkgib/torso/tris.md2");
  gi.modelindex("models/objects/gekkgib/claw/tris.md2");
  gi.modelindex("models/objects/gekkgib/leg/tris.md2");
  gi.modelindex("models/objects/gekkgib/head/tris.md2");

  self.health = Math.trunc(125 * st.health_multiplier);
  self.gib_health = -30;
  self.mass = 300;

  self.pain = gekk_pain;
  self.die = gekk_die;

  self.monsterinfo.stand = gekk_stand;

  self.monsterinfo.walk = gekk_walk;
  self.monsterinfo.run = gekk_run_start;
  self.monsterinfo.dodge = gekk_dodge;
  self.monsterinfo.attack = gekk_attack;
  self.monsterinfo.melee = gekk_melee;
  self.monsterinfo.sight = gekk_sight;
  self.monsterinfo.search = gekk_search;
  self.monsterinfo.idle = gekk_idle;
  self.monsterinfo.checkattack = gekk_checkattack;
  self.monsterinfo.setskin = gekk_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, gekk_move_stand, true);

  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_CHANT)) M_SetAnimation(self, gekk_move_chant, true);

  self.monsterinfo.can_jump = !SpawnFlags_has(self.spawnflags, SPAWNFLAG_GEKK_NOJUMPING);
  self.monsterinfo.drop_height = 256;
  self.monsterinfo.jump_height = 68;
  self.monsterinfo.blocked = gekk_blocked;

  gekk_set_fly_parameters(self);
}

function water_to_land(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_ALTERNATE_FLY;
  self.flags &= ~EntFlagsT.FL_SWIM;
  self.yaw_speed = 20;
  self.viewheight = 25;

  M_SetAnimation(self, gekk_move_leapatk2, true);

  self.mins = vec3(-18, -18, -24);
  self.maxs = vec3(18, 18, 24);
}

function land_to_water(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  self.flags |= EntFlagsT.FL_SWIM;
  self.yaw_speed = 10;
  self.viewheight = 10;

  M_SetAnimation(self, gekk_move_swim_start, true);

  self.mins = vec3(-18, -18, -24);
  self.maxs = vec3(18, 18, 16);
}

// ---------------------------------------------------------------------------
// small per-file helpers -- see file header convention note
// ---------------------------------------------------------------------------

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}
