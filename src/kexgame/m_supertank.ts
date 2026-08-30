// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_supertank.cpp / m_supertank.h -- SUPERTANK (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_supertank.cpp (731 lines,
// C++17) and m_supertank.h (265 lines, 254-entry frame enum plus
// MODEL_SCALE). Behavioral code, ported bug-for-bug per PORTING.md.
//
// Frame constants below are a straight transcription of m_supertank.h's
// anonymous enum (single block, strictly sequential) -- generated
// mechanically from the header and spot-checked against the source. Note
// the header does not name every one of the model's 47 death frames
// individually (death_25..30 and death_34..44 have no symbolic constant);
// this is a pre-existing gap in the C++ header, not a transcription error,
// and does not affect supertank_move_death, which only spans FRAME_death_1
// through FRAME_death_24.
//
// ============================================================================
// SHARED "ROGUE-tree" HELPERS, PORTED HERE (placement mismatch)
// ============================================================================
// Four functions this file calls -- `blocked_checkplat`, `PredictAim`,
// `M_CalculatePitchToFire`, and `monster_fire_heat`/its private `fire_heat`
// weapon -- are declared in g_local.h but their real bodies live in the KEX
// source tree's ROGUE-mission-pack files (rogue/g_rogue_newai.cpp's
// blocked_checkplat/PredictAim/M_CalculatePitchToFire; xatrix/
// g_xatrix_weapon.cpp's fire_heat, wrapped by xatrix/g_xatrix_monster.cpp's
// monster_fire_heat) -- because the KEX rerelease links baseq2, xatrix, and
// rogue into ONE game module, so a base monster can freely call a
// mission-pack function. None of these are gated behind a flag that's never
// set in this port line -- they're called unconditionally from this file's
// own attack/pain/blocked handlers -- so per PORTING.md's "a stub that
// breaks every caller isn't a stub, it's a landmine" precedent (already
// established by g_ai.ts's `monsterlost_checkhint`), they are ported here as
// real logic, not throwing stubs. `blocked_checkplat` is exported for reuse
// by this task's other five monster files (m_tank.ts, m_chick.ts,
// m_parasite.ts, m_mutant.ts all call it too); `PredictAim` and
// `monster_fire_heat` are exported for m_tank.ts/m_chick.ts's rocket
// attacks. This mirrors this same file's own legacy-port precedent for
// `BossExplode` (src/game/m_supertank.ts: "Defined once here ... reused by
// m_boss2.c and m_boss31.c") -- one canonical body, imported by importers,
// rather than duplicated per file.
//
// `BossExplode` itself has the identical placement mismatch one level over:
// declared in g_local.h, its KEX body lives in rogue/g_rogue_newai.cpp
// (completely rewritten from the vanilla-Q2 multi-case switch this
// directory's legacy src/game/m_supertank.ts ported -- KEX's version spawns
// a short-lived "exploder" entity that thinks a random burst of
// TE_EXPLOSION1/TE_EXPLOSION1_NL puffs at random points inside the owner's
// bounding box every 50-200ms until the owner is gone, then frees itself).
// Ported here for the same reason and with the same reuse plan as the four
// functions above.
//
// ============================================================================
// KEX-only content vs. the legacy (vanilla Q2) src/game/m_supertank.ts port
// ============================================================================
// - Powershield (RAFAEL/xatrix): SPAWNFLAG_SUPERTANK_POWERSHIELD (8) makes
//   supertankRocket fire a homing monster_fire_heat bolt instead of a
//   PredictAim'd monster_fire_rocket, and grants IT_ITEM_POWER_SHIELD/400
//   power (unless the map already specified power_armor_type/power). The
//   SP_monster_boss5 entry point (m_supertank.cpp:725-731) always sets this
//   flag before delegating to SP_monster_supertank, then re-skins to 2 and
//   precaches the railgun sound (used by boss5's map scripting, not by any
//   code in this file).
// - N64 long-death (SPAWNFLAG_SUPERTANK_LONG_DEATH, 16, "// n64" comment):
//   when `level.is_n64`, SP_monster_supertank force-sets this flag and
//   self.count = 10; BossLoop (the death table's last-frame thinkfunc) then
//   holds the animation at FRAME_death_19 for 10 extra think-frames via
//   monsterinfo.nextframe before letting the death table finish and call
//   supertank_dead, instead of finishing immediately.
// - Attack selection (supertank_attack) is a full KEX rewrite using
//   M_CheckClearShot per weapon (chaingun/rocket/grenade) and range/height
//   heuristics -- entirely different from the legacy port's plain
//   `range <= 160 ? attack1 : attack2` two-way branch (there is no grenade
//   attack, no clear-shot gating, at all in the vanilla source).
// - AI_IGNORE_SHOTS is set unconditionally after walkmonster_start (PMM
//   comment) -- absent from the vanilla port.
// - `monsterinfo.blocked = supertank_blocked` (PGM) is new; the vanilla port
//   has no blocked callback at all.

import { vec3, VectorCopy, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_BODY, CHAN_WEAPON, ATTN_NORM, PITCH, SURF_SKY } from "../shared/q_shared";
import {
  SvflagsT,
  SolidT,
  ContentsT,
  EffectsT,
  KexMulticastT,
  ServerCommandT,
  KexTempEventT,
  MASK_SOLID,
  MASK_MONSTERSOLID,
  MASK_PROJECTILE,
  MASK_SHOT,
} from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type ThinkFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MoveStateT,
  MovetypeT,
  ModIdT,
  GibTypeT,
  ItemIdT,
  EntFlagsT,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  SPAWNFLAG_MONSTER_DEAD,
  random_time,
} from "./g_local";
import { gi, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, type GTime } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, SpawnFlags_and, SpawnFlags_not } from "./spawnflags";
import { frandom, crandom_open, YAW } from "./q_std";
import {
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_dot,
  vec3_normalized,
  vec3_length,
  vec3_lengthSquared,
  AngleVectors_destructured,
  vectoangles,
  ClipVelocity,
  slerp,
} from "./q_vec3";
import { G_FreeEdict, G_Spawn, findradius } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_run, ai_walk, ai_charge, ai_move, range_to, visible } from "./g_ai";
import {
  M_SetAnimation,
  M_AllowSpawn,
  M_ShouldReactToPain,
  M_ProjectFlashSource,
  M_CheckClearShot,
  monster_fire_bullet,
  monster_fire_rocket,
  monster_fire_grenade,
  monster_muzzleflash,
  walkmonster_start,
} from "./g_monster";
import { rocket_touch } from "./g_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import { MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  RegisterThink,
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_supertank.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_attak1_1 = 0;
export const FRAME_attak1_2 = 1;
export const FRAME_attak1_3 = 2;
export const FRAME_attak1_4 = 3;
export const FRAME_attak1_5 = 4;
export const FRAME_attak1_6 = 5;
export const FRAME_attak1_7 = 6;
export const FRAME_attak1_8 = 7;
export const FRAME_attak1_9 = 8;
export const FRAME_attak1_10 = 9;
export const FRAME_attak1_11 = 10;
export const FRAME_attak1_12 = 11;
export const FRAME_attak1_13 = 12;
export const FRAME_attak1_14 = 13;
export const FRAME_attak1_15 = 14;
export const FRAME_attak1_16 = 15;
export const FRAME_attak1_17 = 16;
export const FRAME_attak1_18 = 17;
export const FRAME_attak1_19 = 18;
export const FRAME_attak1_20 = 19;
export const FRAME_attak2_1 = 20;
export const FRAME_attak2_2 = 21;
export const FRAME_attak2_3 = 22;
export const FRAME_attak2_4 = 23;
export const FRAME_attak2_5 = 24;
export const FRAME_attak2_6 = 25;
export const FRAME_attak2_7 = 26;
export const FRAME_attak2_8 = 27;
export const FRAME_attak2_9 = 28;
export const FRAME_attak2_10 = 29;
export const FRAME_attak2_11 = 30;
export const FRAME_attak2_12 = 31;
export const FRAME_attak2_13 = 32;
export const FRAME_attak2_14 = 33;
export const FRAME_attak2_15 = 34;
export const FRAME_attak2_16 = 35;
export const FRAME_attak2_17 = 36;
export const FRAME_attak2_18 = 37;
export const FRAME_attak2_19 = 38;
export const FRAME_attak2_20 = 39;
export const FRAME_attak2_21 = 40;
export const FRAME_attak2_22 = 41;
export const FRAME_attak2_23 = 42;
export const FRAME_attak2_24 = 43;
export const FRAME_attak2_25 = 44;
export const FRAME_attak2_26 = 45;
export const FRAME_attak2_27 = 46;
export const FRAME_attak3_1 = 47;
export const FRAME_attak3_2 = 48;
export const FRAME_attak3_3 = 49;
export const FRAME_attak3_4 = 50;
export const FRAME_attak3_5 = 51;
export const FRAME_attak3_6 = 52;
export const FRAME_attak3_7 = 53;
export const FRAME_attak3_8 = 54;
export const FRAME_attak3_9 = 55;
export const FRAME_attak3_10 = 56;
export const FRAME_attak3_11 = 57;
export const FRAME_attak3_12 = 58;
export const FRAME_attak3_13 = 59;
export const FRAME_attak3_14 = 60;
export const FRAME_attak3_15 = 61;
export const FRAME_attak3_16 = 62;
export const FRAME_attak3_17 = 63;
export const FRAME_attak3_18 = 64;
export const FRAME_attak3_19 = 65;
export const FRAME_attak3_20 = 66;
export const FRAME_attak3_21 = 67;
export const FRAME_attak3_22 = 68;
export const FRAME_attak3_23 = 69;
export const FRAME_attak3_24 = 70;
export const FRAME_attak3_25 = 71;
export const FRAME_attak3_26 = 72;
export const FRAME_attak3_27 = 73;
export const FRAME_attak4_1 = 74;
export const FRAME_attak4_2 = 75;
export const FRAME_attak4_3 = 76;
export const FRAME_attak4_4 = 77;
export const FRAME_attak4_5 = 78;
export const FRAME_attak4_6 = 79;
export const FRAME_backwd_1 = 80;
export const FRAME_backwd_2 = 81;
export const FRAME_backwd_3 = 82;
export const FRAME_backwd_4 = 83;
export const FRAME_backwd_5 = 84;
export const FRAME_backwd_6 = 85;
export const FRAME_backwd_7 = 86;
export const FRAME_backwd_8 = 87;
export const FRAME_backwd_9 = 88;
export const FRAME_backwd_10 = 89;
export const FRAME_backwd_11 = 90;
export const FRAME_backwd_12 = 91;
export const FRAME_backwd_13 = 92;
export const FRAME_backwd_14 = 93;
export const FRAME_backwd_15 = 94;
export const FRAME_backwd_16 = 95;
export const FRAME_backwd_17 = 96;
export const FRAME_backwd_18 = 97;
export const FRAME_death_1 = 98;
export const FRAME_death_2 = 99;
export const FRAME_death_3 = 100;
export const FRAME_death_4 = 101;
export const FRAME_death_5 = 102;
export const FRAME_death_6 = 103;
export const FRAME_death_7 = 104;
export const FRAME_death_8 = 105;
export const FRAME_death_9 = 106;
export const FRAME_death_10 = 107;
export const FRAME_death_11 = 108;
export const FRAME_death_12 = 109;
export const FRAME_death_13 = 110;
export const FRAME_death_14 = 111;
export const FRAME_death_15 = 112;
export const FRAME_death_16 = 113;
export const FRAME_death_17 = 114;
export const FRAME_death_18 = 115;
export const FRAME_death_19 = 116;
export const FRAME_death_20 = 117;
export const FRAME_death_21 = 118;
export const FRAME_death_22 = 119;
export const FRAME_death_23 = 120;
export const FRAME_death_24 = 121;
export const FRAME_death_31 = 122;
export const FRAME_death_32 = 123;
export const FRAME_death_33 = 124;
export const FRAME_death_45 = 125;
export const FRAME_death_46 = 126;
export const FRAME_death_47 = 127;
export const FRAME_forwrd_1 = 128;
export const FRAME_forwrd_2 = 129;
export const FRAME_forwrd_3 = 130;
export const FRAME_forwrd_4 = 131;
export const FRAME_forwrd_5 = 132;
export const FRAME_forwrd_6 = 133;
export const FRAME_forwrd_7 = 134;
export const FRAME_forwrd_8 = 135;
export const FRAME_forwrd_9 = 136;
export const FRAME_forwrd_10 = 137;
export const FRAME_forwrd_11 = 138;
export const FRAME_forwrd_12 = 139;
export const FRAME_forwrd_13 = 140;
export const FRAME_forwrd_14 = 141;
export const FRAME_forwrd_15 = 142;
export const FRAME_forwrd_16 = 143;
export const FRAME_forwrd_17 = 144;
export const FRAME_forwrd_18 = 145;
export const FRAME_left_1 = 146;
export const FRAME_left_2 = 147;
export const FRAME_left_3 = 148;
export const FRAME_left_4 = 149;
export const FRAME_left_5 = 150;
export const FRAME_left_6 = 151;
export const FRAME_left_7 = 152;
export const FRAME_left_8 = 153;
export const FRAME_left_9 = 154;
export const FRAME_left_10 = 155;
export const FRAME_left_11 = 156;
export const FRAME_left_12 = 157;
export const FRAME_left_13 = 158;
export const FRAME_left_14 = 159;
export const FRAME_left_15 = 160;
export const FRAME_left_16 = 161;
export const FRAME_left_17 = 162;
export const FRAME_left_18 = 163;
export const FRAME_pain1_1 = 164;
export const FRAME_pain1_2 = 165;
export const FRAME_pain1_3 = 166;
export const FRAME_pain1_4 = 167;
export const FRAME_pain2_5 = 168;
export const FRAME_pain2_6 = 169;
export const FRAME_pain2_7 = 170;
export const FRAME_pain2_8 = 171;
export const FRAME_pain3_9 = 172;
export const FRAME_pain3_10 = 173;
export const FRAME_pain3_11 = 174;
export const FRAME_pain3_12 = 175;
export const FRAME_right_1 = 176;
export const FRAME_right_2 = 177;
export const FRAME_right_3 = 178;
export const FRAME_right_4 = 179;
export const FRAME_right_5 = 180;
export const FRAME_right_6 = 181;
export const FRAME_right_7 = 182;
export const FRAME_right_8 = 183;
export const FRAME_right_9 = 184;
export const FRAME_right_10 = 185;
export const FRAME_right_11 = 186;
export const FRAME_right_12 = 187;
export const FRAME_right_13 = 188;
export const FRAME_right_14 = 189;
export const FRAME_right_15 = 190;
export const FRAME_right_16 = 191;
export const FRAME_right_17 = 192;
export const FRAME_right_18 = 193;
export const FRAME_stand_1 = 194;
export const FRAME_stand_2 = 195;
export const FRAME_stand_3 = 196;
export const FRAME_stand_4 = 197;
export const FRAME_stand_5 = 198;
export const FRAME_stand_6 = 199;
export const FRAME_stand_7 = 200;
export const FRAME_stand_8 = 201;
export const FRAME_stand_9 = 202;
export const FRAME_stand_10 = 203;
export const FRAME_stand_11 = 204;
export const FRAME_stand_12 = 205;
export const FRAME_stand_13 = 206;
export const FRAME_stand_14 = 207;
export const FRAME_stand_15 = 208;
export const FRAME_stand_16 = 209;
export const FRAME_stand_17 = 210;
export const FRAME_stand_18 = 211;
export const FRAME_stand_19 = 212;
export const FRAME_stand_20 = 213;
export const FRAME_stand_21 = 214;
export const FRAME_stand_22 = 215;
export const FRAME_stand_23 = 216;
export const FRAME_stand_24 = 217;
export const FRAME_stand_25 = 218;
export const FRAME_stand_26 = 219;
export const FRAME_stand_27 = 220;
export const FRAME_stand_28 = 221;
export const FRAME_stand_29 = 222;
export const FRAME_stand_30 = 223;
export const FRAME_stand_31 = 224;
export const FRAME_stand_32 = 225;
export const FRAME_stand_33 = 226;
export const FRAME_stand_34 = 227;
export const FRAME_stand_35 = 228;
export const FRAME_stand_36 = 229;
export const FRAME_stand_37 = 230;
export const FRAME_stand_38 = 231;
export const FRAME_stand_39 = 232;
export const FRAME_stand_40 = 233;
export const FRAME_stand_41 = 234;
export const FRAME_stand_42 = 235;
export const FRAME_stand_43 = 236;
export const FRAME_stand_44 = 237;
export const FRAME_stand_45 = 238;
export const FRAME_stand_46 = 239;
export const FRAME_stand_47 = 240;
export const FRAME_stand_48 = 241;
export const FRAME_stand_49 = 242;
export const FRAME_stand_50 = 243;
export const FRAME_stand_51 = 244;
export const FRAME_stand_52 = 245;
export const FRAME_stand_53 = 246;
export const FRAME_stand_54 = 247;
export const FRAME_stand_55 = 248;
export const FRAME_stand_56 = 249;
export const FRAME_stand_57 = 250;
export const FRAME_stand_58 = 251;
export const FRAME_stand_59 = 252;
export const FRAME_stand_60 = 253;

export const MODEL_SCALE = 1.0;

const SPAWNFLAG_SUPERTANK_POWERSHIELD: SpawnFlags = SpawnFlags_from(8);
// n64
const SPAWNFLAG_SUPERTANK_LONG_DEATH: SpawnFlags = SpawnFlags_from(16);

// ---------------------------------------------------------------------------
// M_CheckGib -- placement-mismatch helper, ported locally (see g_ai.ts/
// g_monster.ts convention for g_local.h inlines; see this file's own header
// section on placement-mismatch helpers for the four ROGUE-tree functions)
// ---------------------------------------------------------------------------

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/** Fresh-copy helper for by-value `vec3_t` locals (as opposed to
 *  `VectorCopy`'s C-style out-param mutation) -- matches g_ai.ts's own
 *  local `copyVec3`. */
function copyVec3(v: Vec3): Vec3 {
  return vec3(v[0], v[1], v[2]);
}

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_flipper.ts for rationale)
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
// blocked_checkplat (rogue/g_rogue_newai.cpp:14-84) -- exported, shared with
// m_tank.ts/m_chick.ts/m_parasite.ts/m_mutant.ts (see file header)
// ---------------------------------------------------------------------------

export function blocked_checkplat(self: EdictT, dist: number): boolean {
  if (self.enemy === null) return false;

  // check player's relative altitude
  let playerPosition: number;
  if (self.enemy.absmin[2] >= self.absmax[2]) playerPosition = 1;
  else if (self.enemy.absmax[2] <= self.absmin[2]) playerPosition = -1;
  else playerPosition = 0;

  // if we're close to the same position, don't bother trying plats.
  if (playerPosition === 0) return false;

  const world = g_edicts[0];
  let plat: EdictT | null = null;

  // see if we're already standing on a plat.
  if (self.groundentity !== null && self.groundentity !== world) {
    if (self.groundentity.classname !== null && self.groundentity.classname.startsWith("func_pla")) {
      plat = self.groundentity;
    }
  }

  // if we're not, check to see if we'll step onto one with this move
  if (plat === null) {
    const { forward } = AngleVectors_destructured(self.s.angles);
    const pt1 = vec3_add(self.s.origin, vec3_muls(forward, dist));
    const pt2 = copyVec3(pt1);
    pt2[2] -= 384;

    const trace = gi.trace(pt1, null, null, pt2, self, MASK_MONSTERSOLID);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid && trace.ent !== null) {
      const traceEnt = g_edicts[trace.ent.s.number];
      if (traceEnt !== undefined && traceEnt.classname !== null && traceEnt.classname.startsWith("func_pla")) {
        plat = traceEnt;
      }
    }
  }

  // if we've found a plat, trigger it.
  if (plat !== null && plat.use !== null) {
    if (playerPosition === 1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === MoveStateT.STATE_BOTTOM) ||
        (self.groundentity !== plat && plat.moveinfo.state === MoveStateT.STATE_TOP)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    } else if (playerPosition === -1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === MoveStateT.STATE_TOP) ||
        (self.groundentity !== plat && plat.moveinfo.state === MoveStateT.STATE_BOTTOM)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// PredictAim (rogue/g_rogue_newai.cpp:1083-1132) -- exported, shared with
// m_tank.ts/m_chick.ts/m_parasite.ts
// ---------------------------------------------------------------------------

export function PredictAim(
  self: EdictT,
  target: EdictT | null,
  start: Vec3,
  bolt_speed: number,
  eye_height: boolean,
  offset: number,
  aimdir: Vec3 | null,
  aimpoint: Vec3 | null,
): void {
  if (target === null || !target.inuse) {
    if (aimdir !== null) {
      aimdir[0] = 0;
      aimdir[1] = 0;
      aimdir[2] = 0;
    }
    return;
  }

  let eh = eye_height;
  let dir = vec3_sub(target.s.origin, start);
  if (eh) dir[2] += target.viewheight;
  let dist = vec3_length(dir);

  // [Paril-KEX] if our current attempt is blocked, try the opposite one
  const tr = gi.trace(start, null, null, vec3_add(start, dir), self, MASK_PROJECTILE);

  if (tr.ent === null || g_edicts[tr.ent.s.number] !== target) {
    eh = !eh;
    dir = vec3_sub(target.s.origin, start);
    if (eh) dir[2] += target.viewheight;
    dist = vec3_length(dir);
  }

  const time = bolt_speed !== 0 ? dist / bolt_speed : 0;

  let vec = vec3_add(target.s.origin, vec3_muls(target.velocity, time - offset));

  // went backwards...
  if (vec3_dot(vec3_normalized(dir), vec3_normalized(vec3_sub(vec, start))) < 0) {
    vec = copyVec3(target.s.origin);
  } else {
    // if the shot is going to impact a nearby wall from our prediction, just fire it straight.
    if (gi.trace(start, null, null, vec, null, MASK_SOLID).fraction < 0.9) {
      vec = copyVec3(target.s.origin);
    }
  }

  if (eh) vec[2] += target.viewheight;

  if (aimdir !== null) VectorCopy(vec3_normalized(vec3_sub(vec, start)), aimdir);
  if (aimpoint !== null) VectorCopy(vec, aimpoint);
}

// ---------------------------------------------------------------------------
// M_CalculatePitchToFire (rogue/g_rogue_newai.cpp:1136-1196) -- exported,
// shared with m_supertank.ts's own supertankGrenade
// ---------------------------------------------------------------------------

const PITCH_TABLE = [-80, -70, -60, -50, -40, -30, -20, -10, -5];

export function M_CalculatePitchToFire(
  self: EdictT,
  target: Vec3,
  start: Vec3,
  aim: Vec3,
  speed: number,
  time_remaining: number,
  mortar: boolean,
  destroy_on_touch = false,
): boolean {
  let best_pitch = 0;
  let best_dist = Infinity;

  const SIM_TIME = 0.1;
  const pitched_aim = vectoangles(aim);

  for (const pitch of PITCH_TABLE) {
    if (mortar && pitch >= -30) break;

    pitched_aim[PITCH] = pitch;
    const { forward: fwd } = AngleVectors_destructured(pitched_aim);

    let velocity = vec3_muls(fwd, speed);
    let origin = copyVec3(start);

    let t = time_remaining;

    while (t > 0) {
      velocity = vec3_add(velocity, vec3_muls(vec3(0, 0, -1), level.gravity * SIM_TIME));

      const end = vec3_add(origin, vec3_muls(velocity, SIM_TIME));
      const tr = gi.trace(origin, null, null, end, null, MASK_SHOT);

      origin = copyVec3(tr.endpos);

      if (tr.fraction < 1.0) {
        if (tr.surface !== null && (tr.surface.flags & SURF_SKY) !== 0) break;

        origin = vec3_add(origin, tr.plane.normal);
        velocity = ClipVelocity(velocity, tr.plane.normal, 1.6);

        const dist = vec3_lengthSquared(vec3_sub(origin, target));
        const trEnt = tr.ent !== null ? g_edicts[tr.ent.s.number] : undefined;

        if (
          trEnt === self.enemy ||
          (tr.ent !== null && tr.ent.client !== null) ||
          (tr.plane.normal[2] >= 0.7 && dist < 128 * 128 && dist < best_dist)
        ) {
          best_pitch = pitch;
          best_dist = dist;
        }

        if (destroy_on_touch || (tr.contents & (ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER)) !== 0) {
          break;
        }
      }

      t -= SIM_TIME;
    }
  }

  if (Number.isFinite(best_dist)) {
    pitched_aim[PITCH] = best_pitch;
    VectorCopy(AngleVectors_destructured(pitched_aim).forward, aim);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// fire_heat / heat_think / monster_fire_heat (xatrix/g_xatrix_weapon.cpp:
// 136-232, xatrix/g_xatrix_monster.cpp:19-24) -- exported (monster_fire_heat
// only), shared with m_tank.ts/m_chick.ts
// ---------------------------------------------------------------------------

const heat_think: ThinkFn = RegisterThink("heat_think", (self: EdictT): void => {
  let acquire: EdictT | null = null;
  let oldlen = 0;
  let olddot = 1;

  const { forward: fwd } = AngleVectors_destructured(self.s.angles);

  // acquire new target
  let target: EdictT | null = null;
  for (;;) {
    target = findradius(target, self.s.origin, 1024);
    if (target === null) break;
    if (self.owner === target) continue;
    if (target.client === null) continue;
    if (target.health <= 0) continue;
    if (!visible(self, target)) continue;

    const vec = vec3_sub(self.s.origin, target.s.origin);
    const len = vec3_length(vec);
    const dot = vec3_dot(vec3_normalized(vec), fwd);

    // targets that require us to turn less are preferred
    if (dot >= olddot) continue;

    if (acquire === null || dot < olddot || len < oldlen) {
      acquire = target;
      oldlen = len;
      olddot = dot;
    }
  }

  if (acquire !== null) {
    const vec = vec3_normalized(vec3_sub(acquire.s.origin, self.s.origin));
    const t = self.accel;

    const d = vec3_dot(self.movedir, vec);

    const turnVec = d < 0.45 && d > -0.45 ? vec3_muls(vec, -1) : vec;

    self.movedir = vec3_normalized(slerp(self.movedir, turnVec, t));
    VectorCopy(vectoangles(self.movedir), self.s.angles);

    if (self.enemy === null) {
      gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/railgr1a.wav"), 1.0, 0.25, 0);
      self.enemy = acquire;
    }
  } else {
    self.enemy = null;
  }

  self.velocity = vec3_muls(self.movedir, self.speed);
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

function fire_heat(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  damage_radius: number,
  radius_damage: number,
  turn_fraction: number,
): void {
  const heat = G_Spawn();
  heat.s.origin = copyVec3(start);
  heat.movedir = copyVec3(dir);
  heat.s.angles = vectoangles(dir);
  heat.velocity = vec3_muls(dir, speed);
  heat.flags |= EntFlagsT.FL_DODGE;
  heat.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  heat.svflags |= SvflagsT.SVF_PROJECTILE;
  heat.clipmask = MASK_PROJECTILE;
  heat.solid = SolidT.SOLID_BBOX;
  heat.s.effects |= EffectsT.EF_ROCKET;
  heat.s.modelindex = gi.modelindex("models/objects/rocket/tris.md2");
  heat.owner = self;
  heat.touch = rocket_touch;
  heat.speed = speed;
  heat.accel = turn_fraction;

  heat.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  heat.think = heat_think;

  heat.dmg = damage;
  heat.radius_dmg = radius_damage;
  heat.dmg_radius = damage_radius;
  heat.s.sound = gi.soundindex("weapons/rockfly.wav");

  gi.linkentity(heat);
}

/** [Paril-KEX] see file header. */
export function monster_fire_heat(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
  turn_fraction: number,
): void {
  fire_heat(self, start, dir, damage, speed, damage, damage, turn_fraction);
  monster_muzzleflash(self, start, flashtype);
}

// ---------------------------------------------------------------------------
// BossExplode / BossExplode_think (rogue/g_rogue_newai.cpp:1575-1610) --
// exported (see file header)
// ---------------------------------------------------------------------------

const BossExplode_think: ThinkFn = RegisterThink("BossExplode_think", (self: EdictT): void => {
  const owner = self.owner;

  // owner gone or changed
  if (owner === null || !owner.inuse || owner.s.modelindex !== self.style || self.count !== owner.spawn_count) {
    G_FreeEdict(self);
    return;
  }

  const org = vec3_add(owner.s.origin, owner.mins);
  org[0] += frandom() * owner.size[0];
  org[1] += frandom() * owner.size[1];
  org[2] += frandom() * owner.size[2];

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(self.viewheight % 3 === 0 ? KexTempEventT.TE_EXPLOSION1 : KexTempEventT.TE_EXPLOSION1_NL);
  gi.WritePosition(org);
  gi.multicast(org, KexMulticastT.MULTICAST_PVS, false);

  self.viewheight++;

  self.nextthink = Gtime_add(level.time, random_time(Gtime_from_ms(50), Gtime_from_ms(200)));
});

export function BossExplode(self: EdictT): void {
  // no blowy on deady
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD)) return;

  const exploder = G_Spawn();
  exploder.owner = self;
  exploder.count = self.spawn_count;
  exploder.style = self.s.modelindex;
  exploder.think = BossExplode_think;
  exploder.nextthink = Gtime_add(level.time, random_time(Gtime_from_ms(75), Gtime_from_ms(250)));
  exploder.viewheight = 0;
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_death = 0;
let sound_search1 = 0;
let sound_search2 = 0;

let tread_sound = 0;

function TreadSound(self: EdictT): void {
  gi.sound(self, CHAN_BODY, tread_sound, 1, ATTN_NORM, 0);
}

const supertank_search = RegisterMonsterinfoSearch("supertank_search", (self: EdictT): void => {
  if (frandom() < 0.5) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_search2, 1, ATTN_NORM, 0);
});

// ---------------------------------------------------------------------------
// stand (m_supertank.cpp:50-117)
// ---------------------------------------------------------------------------

const supertank_frames_stand: MframeT[] = Array.from({ length: 60 }, () => frame(ai_stand));
const supertank_move_stand = RegisterMmove("supertank_move_stand", move(FRAME_stand_1, FRAME_stand_60, supertank_frames_stand));

const supertank_stand = RegisterMonsterinfoStand("supertank_stand", (self: EdictT): void => {
  M_SetAnimation(self, supertank_move_stand, true);
});

const supertank_frames_run: MframeT[] = [
  frame(ai_run, 12, TreadSound),
  ...Array.from({ length: 17 }, () => frame(ai_run, 12)),
];
const supertank_move_run = RegisterMmove("supertank_move_run", move(FRAME_forwrd_1, FRAME_forwrd_18, supertank_frames_run));

// ---------------------------------------------------------------------------
// walk (m_supertank.cpp:141-183)
// ---------------------------------------------------------------------------

const supertank_frames_forward: MframeT[] = [
  frame(ai_walk, 4, TreadSound),
  ...Array.from({ length: 17 }, () => frame(ai_walk, 4)),
];
const supertank_move_forward = RegisterMmove("supertank_move_forward", move(FRAME_forwrd_1, FRAME_forwrd_18, supertank_frames_forward));

function supertank_forward(self: EdictT): void {
  M_SetAnimation(self, supertank_move_forward, true);
}
void supertank_forward; // m_supertank.cpp:167-170: declared, never called from anywhere in this file (pre-existing dead code, preserved)

const supertank_walk = RegisterMonsterinfoWalk("supertank_walk", (self: EdictT): void => {
  M_SetAnimation(self, supertank_move_forward, true);
});

const supertank_run = RegisterMonsterinfoRun("supertank_run", (self: EdictT): void => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, supertank_move_stand, true);
  else M_SetAnimation(self, supertank_move_run, true);
});

// m_supertank.cpp:185-229: `#if 0`-guarded supertank_move_turn_right/_left
// frame tables -- dropped per PORTING.md's "#if 0 blocks are dropped
// silently."

const supertank_frames_pain3: MframeT[] = Array.from({ length: 4 }, () => frame(ai_move));
const supertank_move_pain3 = RegisterMmove("supertank_move_pain3", move(FRAME_pain3_9, FRAME_pain3_12, supertank_frames_pain3, supertank_run));

const supertank_frames_pain2: MframeT[] = Array.from({ length: 4 }, () => frame(ai_move));
const supertank_move_pain2 = RegisterMmove("supertank_move_pain2", move(FRAME_pain2_5, FRAME_pain2_8, supertank_frames_pain2, supertank_run));

const supertank_frames_pain1: MframeT[] = Array.from({ length: 4 }, () => frame(ai_move));
const supertank_move_pain1 = RegisterMmove("supertank_move_pain1", move(FRAME_pain1_1, FRAME_pain1_4, supertank_frames_pain1, supertank_run));

function BossLoop(self: EdictT): void {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_SUPERTANK_LONG_DEATH)) return;

  if (self.count) self.count--;
  else self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_SUPERTANK_LONG_DEATH));

  self.monsterinfo.nextframe = FRAME_death_19;
}

function supertankGrenade(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const flash_number = self.s.frame === FRAME_attak4_1 ? MonsterMuzzleflashIdT.MZ2_SUPERTANK_GRENADE_1 : MonsterMuzzleflashIdT.MZ2_SUPERTANK_GRENADE_2;

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  const aim_point = vec3();
  const forwardOut = copyVec3(forward);
  PredictAim(self, self.enemy, start, 0, false, crandom_open() * 0.1, forwardOut, aim_point);

  for (let speed = 500; speed < 1000; speed += 100) {
    if (!M_CalculatePitchToFire(self, aim_point, start, forwardOut, speed, 2.5, true)) continue;

    monster_fire_grenade(self, start, forwardOut, 50, speed, flash_number, 0, 0);
    break;
  }
}

const supertank_frames_death1: MframeT[] = [
  frame(ai_move, 0, BossExplode),
  ...Array.from({ length: 22 }, () => frame(ai_move)),
  frame(ai_move, 0, BossLoop),
];
const supertank_move_death = RegisterMmove(
  "supertank_move_death",
  move(FRAME_death_1, FRAME_death_24, supertank_frames_death1, (self: EdictT): void => supertank_dead(self)),
);

const supertank_frames_attack4: MframeT[] = [
  frame(ai_move, 0, supertankGrenade),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, supertankGrenade),
  frame(ai_move),
  frame(ai_move),
];
const supertank_move_attack4 = RegisterMmove("supertank_move_attack4", move(FRAME_attak4_1, FRAME_attak4_6, supertank_frames_attack4, supertank_run));

const supertank_frames_attack2: MframeT[] = [
  ...Array.from({ length: 7 }, () => frame(ai_charge)),
  frame(ai_charge, 0, supertankRocket),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, supertankRocket),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, supertankRocket),
  ...Array.from({ length: 7 }, () => frame(ai_charge)),
  ...Array.from({ length: 6 }, () => frame(ai_move)),
];
const supertank_move_attack2 = RegisterMmove("supertank_move_attack2", move(FRAME_attak2_1, FRAME_attak2_27, supertank_frames_attack2, supertank_run));

const supertank_frames_attack1: MframeT[] = Array.from({ length: 6 }, () => frame(ai_charge, 0, supertankMachineGun));
const supertank_move_attack1 = RegisterMmove(
  "supertank_move_attack1",
  move(FRAME_attak1_1, FRAME_attak1_6, supertank_frames_attack1, (self: EdictT): void => supertank_reattack1(self)),
);

const supertank_frames_end_attack1: MframeT[] = Array.from({ length: 14 }, () => frame(ai_move));
const supertank_move_end_attack1 = RegisterMmove(
  "supertank_move_end_attack1",
  move(FRAME_attak1_7, FRAME_attak1_20, supertank_frames_end_attack1, supertank_run),
);

function supertank_reattack1(self: EdictT): void {
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (self.timestamp >= level.time || frandom() < 0.3) M_SetAnimation(self, supertank_move_attack1, true);
    else M_SetAnimation(self, supertank_move_end_attack1, true);
  } else {
    M_SetAnimation(self, supertank_move_end_attack1, true);
  }
}

const supertank_pain = RegisterPain("supertank_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  // Lessen the chance of him going into his pain frames
  if (mod.id !== ModIdT.MOD_CHAINFIST) {
    if (damage <= 25 && frandom() < 0.2) return;

    // Don't go into pain if he's firing his rockets
    if (self.s.frame >= FRAME_attak2_1 && self.s.frame <= FRAME_attak2_14) return;
  }

  if (damage <= 10) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else if (damage <= 25) gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (damage <= 10) M_SetAnimation(self, supertank_move_pain1, true);
  else if (damage <= 25) M_SetAnimation(self, supertank_move_pain2, true);
  else M_SetAnimation(self, supertank_move_pain3, true);
});

const supertank_setskin = RegisterMonsterinfoSetskin("supertank_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
});

function supertankRocket(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  let flash_number: MonsterMuzzleflashIdT;
  if (self.s.frame === FRAME_attak2_8) flash_number = MonsterMuzzleflashIdT.MZ2_SUPERTANK_ROCKET_1;
  else if (self.s.frame === FRAME_attak2_11) flash_number = MonsterMuzzleflashIdT.MZ2_SUPERTANK_ROCKET_2;
  else flash_number = MonsterMuzzleflashIdT.MZ2_SUPERTANK_ROCKET_3;

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_SUPERTANK_POWERSHIELD)) {
    const vec = copyVec3(self.enemy.s.origin);
    vec[2] += self.enemy.viewheight;
    const dir = vec3_normalized(vec3_sub(vec, start));
    monster_fire_heat(self, start, dir, 40, 500, flash_number, 0.075);
  } else {
    const forwardOut = copyVec3(forward);
    PredictAim(self, self.enemy, start, 750, false, 0, forwardOut, null);
    monster_fire_rocket(self, start, forwardOut, 50, 750, flash_number);
  }
}

function supertankMachineGun(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const flash_number: MonsterMuzzleflashIdT = MonsterMuzzleflashIdT.MZ2_SUPERTANK_MACHINEGUN_1 + (self.s.frame - FRAME_attak1_1);

  const dir = vec3(0, self.s.angles[YAW], 0);

  const { forward, right } = AngleVectors_destructured(dir);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);
  const forwardOut = copyVec3(forward);
  PredictAim(self, self.enemy, start, 0, true, -0.1, forwardOut, null);
  monster_fire_bullet(self, start, forwardOut, 6, 4, DEFAULT_BULLET_HSPREAD * 3, DEFAULT_BULLET_VSPREAD * 3, flash_number);
}

const supertank_attack = RegisterMonsterinfoAttack("supertank_attack", (self: EdictT): void => {
  if (self.enemy === null) return;

  const vec = vec3_sub(self.enemy.s.origin, self.s.origin);
  const rangeVal = range_to(self, self.enemy);

  // Attack 1 == Chaingun
  // Attack 2 == Rocket Launcher
  // Attack 3 == Grenade Launcher
  const chaingun_good = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SUPERTANK_MACHINEGUN_1]);
  const rocket_good = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SUPERTANK_ROCKET_1]);
  const grenade_good = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SUPERTANK_GRENADE_1]);

  // fire rockets more often at distance
  if (chaingun_good && (!rocket_good || rangeVal <= 540 || frandom() < 0.3)) {
    // prefer grenade if the enemy is above us
    if (grenade_good && (rangeVal >= 350 || vec[2] > 120 || frandom() < 0.2)) {
      M_SetAnimation(self, supertank_move_attack4, true);
    } else {
      M_SetAnimation(self, supertank_move_attack1, true);
      self.timestamp = Gtime_add(level.time, random_time(Gtime_from_ms(1500), Gtime_from_ms(2700)));
    }
  } else if (rocket_good) {
    // prefer grenade if the enemy is above us
    if (grenade_good && (vec[2] > 120 || frandom() < 0.2)) M_SetAnimation(self, supertank_move_attack4, true);
    else M_SetAnimation(self, supertank_move_attack2, true);
  } else if (grenade_good) {
    M_SetAnimation(self, supertank_move_attack4, true);
  }
});

// ---------------------------------------------------------------------------
// death (m_supertank.cpp:550-614)
// ---------------------------------------------------------------------------

function supertank_gib(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  self.s.sound = 0;
  self.s.skinnum = Math.trunc(self.s.skinnum / 2);

  const gibs: GibDefT[] = [
    { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 2 },
    { gibname: "models/objects/gibs/sm_metal/tris.md2", count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: "models/monsters/boss1/gibs/cgun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC },
    { gibname: "models/monsters/boss1/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/boss1/gibs/core.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/boss1/gibs/ltread.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss1/gibs/rgun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss1/gibs/rtread.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss1/gibs/tube.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss1/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD },
  ];
  ThrowGibs(self, 500, gibs);
}

function supertank_dead(self: EdictT): void {
  // no blowy on deady
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
    self.deadflag = false;
    self.takedamage = true;
    return;
  }

  supertank_gib(self);
}

const supertank_die = RegisterDie(
  "supertank_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
      // check for gib
      if (M_CheckGib(self, mod)) {
        supertank_gib(self);
        self.deadflag = true;
        return;
      }

      if (self.deadflag) return;
    } else {
      gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
      self.deadflag = true;
      self.takedamage = false;
    }

    M_SetAnimation(self, supertank_move_death, true);
  },
);

// ===========
// PGM
const supertank_blocked = RegisterMonsterinfoBlocked("supertank_blocked", (self: EdictT, dist: number): boolean => {
  return blocked_checkplat(self, dist);
});
// PGM
// ===========

// ---------------------------------------------------------------------------
// monster_supertank / monster_boss5 (m_supertank.cpp:634-731)
// ---------------------------------------------------------------------------

/**
 * QUAKED monster_supertank (1 .5 0) (-64 -64 0) (64 64 72) Ambush
 * Trigger_Spawn Sight Powershield LongDeath
 */
export function SP_monster_supertank(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("bosstank/btkpain1.wav");
  sound_pain2 = gi.soundindex("bosstank/btkpain2.wav");
  sound_pain3 = gi.soundindex("bosstank/btkpain3.wav");
  sound_death = gi.soundindex("bosstank/btkdeth1.wav");
  sound_search1 = gi.soundindex("bosstank/btkunqv1.wav");
  sound_search2 = gi.soundindex("bosstank/btkunqv2.wav");

  tread_sound = gi.soundindex("bosstank/btkengn1.wav");

  gi.soundindex("gunner/gunatck3.wav");
  gi.soundindex("infantry/infatck1.wav");
  gi.soundindex("tank/rocket.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss1/tris.md2");

  gi.modelindex("models/monsters/boss1/gibs/cgun.md2");
  gi.modelindex("models/monsters/boss1/gibs/chest.md2");
  gi.modelindex("models/monsters/boss1/gibs/core.md2");
  gi.modelindex("models/monsters/boss1/gibs/head.md2");
  gi.modelindex("models/monsters/boss1/gibs/ltread.md2");
  gi.modelindex("models/monsters/boss1/gibs/rgun.md2");
  gi.modelindex("models/monsters/boss1/gibs/rtread.md2");
  gi.modelindex("models/monsters/boss1/gibs/tube.md2");

  self.mins = vec3(-64, -64, 0);
  self.maxs = vec3(64, 64, 112);

  self.health = Math.trunc(1500 * st.health_multiplier);
  self.gib_health = -500;
  self.mass = 800;

  self.pain = supertank_pain;
  self.die = supertank_die;
  self.monsterinfo.stand = supertank_stand;
  self.monsterinfo.walk = supertank_walk;
  self.monsterinfo.run = supertank_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = supertank_attack;
  self.monsterinfo.search = supertank_search;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;
  self.monsterinfo.blocked = supertank_blocked; // PGM
  self.monsterinfo.setskin = supertank_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, supertank_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  // RAFAEL
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_SUPERTANK_POWERSHIELD)) {
    if (!st.keys_specified.has("power_armor_type")) self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;
    if (!st.keys_specified.has("power_armor_power")) self.monsterinfo.power_armor_power = 400;
  }
  // RAFAEL

  walkmonster_start(self);

  // PMM
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;
  // pmm

  if (level.is_n64) {
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_SUPERTANK_LONG_DEATH);
    self.count = 10;
  }
}

/**
 * QUAKED monster_boss5 (1 .5 0) (-64 -64 0) (64 64 72) Ambush Trigger_Spawn
 * Sight
 */
export function SP_monster_boss5(self: EdictT): void {
  self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_SUPERTANK_POWERSHIELD);
  SP_monster_supertank(self);
  gi.soundindex("weapons/railgr1a.wav");
  self.s.skinnum = 2;
}
