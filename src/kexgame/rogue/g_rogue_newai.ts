// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_newai.c -- the ROGUE mission pack's AI additions (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_newai.cpp
// (1,612 lines, C++17): plat-blocking, jump-blocking, the hint-path chain
// system, "bad area" avoidance zones, tesla targeting/marking, predictive
// aiming, the new dodge code, and a handful of small AI helpers
// (inback/realrange/face_wall/below/has_valid_enemy/CountPlayers/
// BossExplode).
//
// ============================================================================
// ALREADY REAL ELSEWHERE -- imported directly from their real home by
// consumers, NOT re-exported from here (see "IMPORT CYCLE" note)
// ============================================================================
// `blocked_checkplat`, `PredictAim`, `M_CalculatePitchToFire`,
// `M_MonsterDodge`, `monster_duck_down`, `monster_duck_hold`,
// `monster_duck_up` (rogue/g_rogue_newai.cpp:14, 1083, 1140, 1304, 1424,
// 1434, 1442) are already ported for real in m_supertank.ts/m_soldier.ts --
// see this port line's "m_supertank.ts owns PredictAim/blocked_checkplat" /
// "m_soldier.ts owns the duck/dodge infra" precedent. `realrange` and
// `PickCoopTarget` (rogue/g_rogue_newai.cpp:914, 1508) are already ported
// for real in m_medic.ts (see its "THE REINFORCEMENTS FINDING" section) and
// ARE re-exported below (m_medic.ts has no path back to this file, so no
// cycle risk).
//
// The other six are deliberately NOT re-exported from here, despite this
// file being their declared C++ home: an earlier draft of this file did
// import them from m_supertank.ts/m_soldier.ts and re-export them, which
// created a three-module import cycle (g_ai.ts -> this file -> m_supertank.ts
// -> g_ai.ts, and the m_soldier.ts equivalent) that crashes at load --
// m_supertank.ts's and m_soldier.ts's top-level frame-table construction
// (`const supertank_frames_stand: MframeT[] = Array.from(..., () =>
// frame(ai_stand))`, `const soldier_frames_stand1: MframeT[] = [...]`) reads
// g_ai.ts's `export const ai_stand`/`ai_walk`/etc directly at
// module-evaluation time, not from inside a function body, so if this
// file's own cycle with g_ai.ts (needed for `visible`/`FoundTarget`/
// `HuntTarget`/`FacingIdeal`) forces m_supertank.ts/m_soldier.ts to load
// before g_ai.ts finishes, those consts are still in their TDZ --
// `ReferenceError: Cannot access 'ai_stand' before initialization`, caught
// by actually running `bun test`, not `tsc` (which is silent on this class
// of bug). Every consumer of these six imports directly from their real
// home (m_supertank.ts / m_soldier.ts) instead of through this file.
//
// ============================================================================
// STUB SWAPS (files this unit edits; see each file's own header for the
// pre-edit stub text)
// ============================================================================
// - g_ai.ts: `hintpath_stop` (local throwing stub) -> real import from here.
//   `monsterlost_checkhint` (local partial port, pinned to its "no hint
//   paths on this port line" early return) -> deleted; `monsterlost_checkhint`
//   is now a real import from here. The real function's own first line
//   (`if (!hint_paths_present) return false;`) is exactly what g_ai.ts's
//   pin hard-coded -- now it reads this file's real, mutable
//   `hint_paths_present` (set true by `InitHintPaths` once any `hint_path`
//   entity exists), so the early-out becomes conditionally reachable for
//   the first time in this port line, and the rest of the hint-chain search
//   is live code, not dead code, as of this unit landing. `monster_done_dodge`
//   (rogue/g_rogue_monster.cpp:98) is a local duplicate in g_ai.ts, NOT an
//   import, for the same cycle reason as this file's own six non-re-exports
//   above -- see g_ai.ts's own header note.
// - g_combat.ts: `MarkTeslaArea`/`TargetTesla` (local throwing stubs) ->
//   real imports from here.
// - m_move.ts: `TargetTesla` (local throwing stub) -> real import from here.
// - m_mutant.ts, m_parasite.ts, m_infantry.ts, m_gunner.ts, m_berserk.ts,
//   m_guncmdr.ts: `blocked_checkjump` (six near-identical local throwing
//   stubs) -> real imports from here. `blocked_checkplat` (m_gunner.ts's/
//   m_gladiator.ts's own separate local stubs) and `PredictAim`/
//   `monster_jump_finished` (m_berserk.ts's own local stubs) -> real
//   imports from THEIR real home (m_supertank.ts/here respectively), never
//   routed through this file, per the cycle note above.
// - m_soldier.ts: `PredictAim` (local throwing stub, cited to this file, but
//   with a stale 7-parameter signature missing the real `aimpoint` out-param
//   -- see "PREDICTAIM SIGNATURE FIX" below) -> real import directly from
//   m_supertank.ts.
//
// ============================================================================
// PREDICTAIM SIGNATURE FIX (m_soldier.ts)
// ============================================================================
// m_soldier.ts's stub was `PredictAim(self, target, start, bolt_speed,
// eye_height, offset, aimdir)` -- 7 params. The real C++ signature
// (rogue/g_rogue_newai.cpp:1083, already ported for real in m_supertank.ts)
// is `PredictAim(self, target, start, bolt_speed, eye_height, offset,
// aimdir*, aimpoint*)` -- 8 params, two separate out-params. m_soldier.ts's
// one call site (`soldierh_laser_update`, `PredictAim(owner, owner.enemy,
// start, 0, false, crandom_local() * 0.05 + 0.15, aimdir)`) is updated to
// pass a throwaway `aim_point` local for the 8th argument, matching every
// other real call site in this port line (m_supertank.ts/m_tank.ts/
// m_chick.ts/m_gunner.ts/m_parasite.ts/m_mutant.ts all pass either a real
// aimpoint local or `null`).
//
// ============================================================================
// SP LIST (for the coordinator -- g_spawn.ts is not edited by this unit)
// ============================================================================
// g_spawn.ts's spawn table already carries:
//   { name: "hint_path", spawn: unported("SP_hint_path", "rogue/g_rogue_newai.cpp (future src/rogue/g_rogue_newai.ts)") },
// Swap that entry's `spawn` to `SP_hint_path` exported below.
//
// g_spawn.cpp:1262's `SpawnEntities` calls `InitHintPaths()` once, after all
// map entities have spawned, "to enable quick exits if valid" (this file's
// own comment on `InitHintPaths`). RESOLVED (2026-08-30, KEX demo playback
// unit): g_spawn.ts's `SpawnEntities` now imports `InitHintPaths` from here
// and calls it at the same placement as g_spawn.cpp:1262 (in the
// non-deathmatch branch, replacing g_spawn.ts's own former local partial
// port). `hint_paths_present` is now set for real on any map with a
// `hint_path` entity, so `monsterlost_checkhint`'s hint-chain search is
// live code, not dead code, as of this unit landing.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `CheckForBadArea`'s C++ body uses `gi.BoxEdicts`'s raw-pointer
//   `void *data` out-channel (`edict_t *&result = (edict_t *&) data`) to
//   smuggle a single result out of the filter callback. This port's
//   `gi.BoxEdicts` fills a `list` array up to `maxcount` instead (see
//   g_utils.ts's `G_TouchTriggers`/`KillBox` for the established idiom) --
//   ported as `maxcount = 1` with the filter itself doing the
//   `touch === badarea_touch` test (`Keep`/`Skip`, no `End` needed), then
//   reading `list[0]`. Observably identical: at most one bad_area entity is
//   ever linked to a given trigger box.
// - `drawbbox` (rogue/g_rogue_newai.cpp:1221-1289) is dead code in this
//   port's landed callers (nothing calls it yet -- it is a manual debug-draw
//   helper, never wired to a cvar or command in the C++ source either).
//   Ported for real anyway since the body is straightforward and this file
//   is its declared home.
// - `alloca`-based scratch arrays (`PickCoopTarget`'s C++ body, already real
//   in m_medic.ts) and `CountPlayers`'s C++ body use `game.maxclients` loops
//   over `g_edicts[1..maxclients]`; ported as plain `for` loops per this
//   port line's established precedent (see m_medic.ts's own `PickCoopTarget`).

import { vec3, type Vec3, VectorCopy } from "../../shared/math";
import type { CvarT } from "../../shared/q_shared";
import { vec3_add, vec3_sub, vec3_muls, vec3_length, vec3_scaled, vec3_normalized, vec3_dot, AngleVectors, vectoyaw, vectoangles } from "../q_vec3";
import { type EdictT, MonsterAiFlagsT, BlockedJumpResultT, MovetypeT, HOLD_FOREVER, random_time, SPAWNFLAG_MONSTER_DEAD } from "../g_local";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "../spawnflags";
import {
  type KexTraceT,
  type KexEdictT,
  SolidT,
  SvflagsT,
  SolidityAreaT,
  BoxEdictsResultT,
  MASK_MONSTERSOLID,
  MASK_SOLID,
  MASK_WATER,
  ContentsT,
  WaterLevelT,
  PathReturnCode,
  STEPSIZE,
  CvarFlagsT,
  ServerCommandT,
  KexTempEventT,
  KexMulticastT,
} from "../../kexapi/game";
import { gi, g_edicts, level, game } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, Gtime_nonzero, type GTime, GTIME_ZERO } from "../gtime";
import { frandom } from "../q_std";
import type { ThinkFn, TouchFn } from "../g_local_types";
import { RegisterThink, RegisterTouch } from "../g_save_registry";
import { G_Spawn, G_FreeEdict, G_FindByString } from "../g_utils";
import { visible, FoundTarget, HuntTarget, FacingIdeal } from "../g_ai";
import { M_ChangeYaw } from "../m_move";
import { M_CatagorizePosition } from "../g_monster";
import type * as MMedicModule from "../m_medic";

// m_medic.ts is reached lazily (via Bun's synchronous require, not a static
// top-level import) -- a static import here closes a cycle through
// m_medic.ts's own static import of `blocked_checkplat` from m_supertank.ts,
// which reads THIS module's importers' `export const ai_stand`/etc (from
// g_ai.ts) directly at module-evaluation time in their own top-level frame
// tables. Any file that statically imports this one (m_move.ts, g_combat.ts,
// every monster file swapped onto `blocked_checkjump`, etc.) would then
// transitively trigger m_supertank.ts to load before g_ai.ts finishes,
// throwing `ReferenceError: Cannot access 'ai_stand' before initialization`
// -- caught by running `bun test`, not `tsc` (silent on this class of bug).
// Fixing this ONE edge (rather than every consumer's edge into this file)
// is the single choke point: `m_medic.ts -> m_supertank.ts -> g_ai.ts` is
// the actual "poisonous" segment, and it is only ever reached through this
// file. `import type` above is compile-time only (erased), so it adds no
// runtime edge. Matches src/qcommon/files.ts's own `cvarMod()`/`cmdMod()`
// precedent (PORTING.md's sanctioned require() escape hatch).
function mMedicMod(): typeof MMedicModule {
  return require("../m_medic");
}

import type * as MSupertankModule from "../m_supertank";
function mSupertankMod(): typeof MSupertankModule {
  return require("../m_supertank");
}

export function realrange(self: EdictT, other: EdictT): number {
  return mMedicMod().realrange(self, other);
}
export function PickCoopTarget(self: EdictT): EdictT | null {
  return mMedicMod().PickCoopTarget(self);
}
export function cleanupHealTarget(ent: EdictT): void {
  mMedicMod().cleanupHealTarget(ent);
}

function must<T>(fn: T | null, name: string, self: EdictT): T {
  if (fn === null) throw new Error(`g_rogue_newai: ${name} is null for ${self.classname ?? "?"}`);
  return fn;
}

function edictFmt(ent: EdictT): string {
  const p = ent.linked ? vec3_muls(vec3_add(ent.absmax, ent.absmin), 0.5) : ent.s.origin;
  return `${ent.classname} @ (${p[0]} ${p[1]} ${p[2]})`;
}

function coopEnabled(): boolean {
  const c: CvarT | null = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

function deathmatchEnabled(): boolean {
  const c: CvarT | null = gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

function skillInt(): number {
  const c: CvarT | null = gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
  return c === null ? 1 : Math.trunc(c.value);
}

// ---------------------------------------------------------------------------
// JUMPING AIDS (rogue/g_rogue_newai.cpp:90-257)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_newai.cpp:94-99 `inline void monster_jump_start(edict_t *self)`. */
export function monster_jump_start(self: EdictT): void {
  monster_done_dodge_local(self);
  self.monsterinfo.jump_time = Gtime_add(level.time, Gtime_from_sec(3));
}

// `monster_done_dodge` (rogue/g_rogue_monster.cpp:98) is real in
// g_rogue_monster.ts, which itself imports fire_blaster2 etc. from THIS
// file's sibling g_rogue_newweap.ts -- importing g_rogue_monster.ts from
// here would risk a real import cycle (g_rogue_monster.ts -> here for
// nothing today, but future-fragile). Since `monster_done_dodge`'s real
// body lives in m_soldier.ts (re-exported by g_rogue_monster.ts, not
// reimplemented), this file imports it directly from m_soldier.ts instead,
// under a local alias, to stay a one-way leaf dependency.
import { monster_done_dodge as monster_done_dodge_local } from "../m_soldier";

/** rogue/g_rogue_newai.cpp:101-118 `bool monster_jump_finished(edict_t *self)`. */
export function monster_jump_finished(self: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);

  const forward_velocity = vec3_scaled(self.velocity, forward);

  if (vec3_length(forward_velocity) < 150) {
    const z_velocity = self.velocity[2];
    VectorCopy(vec3_muls(forward, 150), self.velocity);
    self.velocity[2] = z_velocity;
  }

  return self.monsterinfo.jump_time < level.time;
}

/**
 * rogue/g_rogue_newai.cpp:123-257 `blocked_jump_result_t
 * blocked_checkjump(edict_t *self, float dist)`. `dist`: how far the
 * monster is trying to walk. `self.monsterinfo.drop_height`/`jump_height`:
 * how far a jump will be allowed in that direction (0 disables it).
 */
export function blocked_checkjump(self: EdictT, dist: number): BlockedJumpResultT {
  if (!self.monsterinfo.can_jump) return BlockedJumpResultT.NO_JUMP;
  if (self.enemy === null) return BlockedJumpResultT.NO_JUMP;

  if (self.monsterinfo.jump_time > level.time) return BlockedJumpResultT.NO_JUMP;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) !== 0n) {
    if (self.monsterinfo.nav_path.returnCode !== PathReturnCode.TraversalPending) return BlockedJumpResultT.NO_JUMP;

    const yawDir = vec3_normalized(vec3_sub(self.monsterinfo.nav_path.firstMovePoint, self.monsterinfo.nav_path.secondMovePoint));
    let yaw = vectoyaw(yawDir);
    self.ideal_yaw = yaw + 180;
    if (self.ideal_yaw > 360) self.ideal_yaw -= 360;

    if (!FacingIdeal(self)) {
      M_ChangeYaw(self);
      return BlockedJumpResultT.JUMP_TURN;
    }

    monster_jump_start(self);

    if (self.monsterinfo.nav_path.secondMovePoint[2] > self.monsterinfo.nav_path.firstMovePoint[2]) {
      return BlockedJumpResultT.JUMP_JUMP_UP;
    }
    return BlockedJumpResultT.JUMP_JUMP_DOWN;
  }

  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);

  let playerPosition: number;
  // NOTE: the C++ source checks `AI_PATHING` again here (dead code -- this
  // branch is only reached when AI_PATHING is NOT set, per the early
  // return above) -- kept as the equivalent always-false condition would
  // be, i.e. this port always takes the `else` (self.enemy) branch here,
  // matching the C++'s actual runtime behavior bug-for-bug.
  if (self.enemy.absmin[2] > self.absmin[2] + STEPSIZE) playerPosition = 1;
  else if (self.enemy.absmin[2] < self.absmin[2] - STEPSIZE) playerPosition = -1;
  else playerPosition = 0;

  if (playerPosition === -1 && self.monsterinfo.drop_height !== 0) {
    const pt1 = vec3_add(self.s.origin, vec3_muls(forward, 48));
    const groundTrace: KexTraceT = gi.trace(self.s.origin, self.mins, self.maxs, pt1, self, MASK_MONSTERSOLID);
    if (groundTrace.fraction < 1) return BlockedJumpResultT.NO_JUMP;

    const pt2 = vec3(pt1[0], pt1[1], self.absmin[2] - self.monsterinfo.drop_height - 1);

    const trace: KexTraceT = gi.trace(pt1, null, null, pt2, self, MASK_MONSTERSOLID | MASK_WATER);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid) {
      if ((trace.contents & ContentsT.CONTENTS_WATER) !== 0) {
        const deep = gi.trace(trace.endpos, null, null, pt2, self, MASK_MONSTERSOLID);
        const { waterlevel } = M_CatagorizePosition(self, deep.endpos);
        if (waterlevel > WaterLevelT.WATER_WAIST) return BlockedJumpResultT.NO_JUMP;
      }

      if (self.absmin[2] - trace.endpos[2] >= 24 && (trace.contents & (MASK_SOLID | ContentsT.CONTENTS_WATER)) !== 0) {
        if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) !== 0n) {
          if (self.monsterinfo.nav_path.secondMovePoint[2] - trace.endpos[2] > 32) return BlockedJumpResultT.NO_JUMP;
        } else {
          if (self.enemy.absmin[2] - trace.endpos[2] > 32) return BlockedJumpResultT.NO_JUMP;
          if (trace.plane.normal[2] < 0.9) return BlockedJumpResultT.NO_JUMP;
        }

        monster_jump_start(self);
        return BlockedJumpResultT.JUMP_JUMP_DOWN;
      }
    }
  } else if (playerPosition === 1 && self.monsterinfo.jump_height !== 0) {
    const pt2 = vec3_add(self.s.origin, vec3_muls(forward, 48));
    const pt1 = vec3(pt2[0], pt2[1], self.absmax[2] + self.monsterinfo.jump_height);

    const trace: KexTraceT = gi.trace(pt1, null, null, pt2, self, MASK_MONSTERSOLID | MASK_WATER);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid) {
      if (trace.endpos[2] - self.absmin[2] <= self.monsterinfo.jump_height && (trace.contents & (MASK_SOLID | ContentsT.CONTENTS_WATER)) !== 0) {
        face_wall(self);
        monster_jump_start(self);
        return BlockedJumpResultT.JUMP_JUMP_UP;
      }
    }
  }

  return BlockedJumpResultT.NO_JUMP;
}

// ---------------------------------------------------------------------------
// HINT PATHS (rogue/g_rogue_newai.cpp:259-891)
// ---------------------------------------------------------------------------

const SPAWNFLAG_HINT_ENDPOINT: SpawnFlags = SpawnFlags_from(0x0001);
const MAX_HINT_CHAINS = 100;

let hint_paths_present = false;
let hint_path_start: (EdictT | null)[] = new Array(MAX_HINT_CHAINS).fill(null);
let num_hint_paths = 0;

/** rogue/g_rogue_newai.cpp:277-313 `edict_t *hintpath_findstart(edict_t *ent)`. */
export function hintpath_findstart(ent: EdictT): EdictT | null {
  let last: EdictT | null = null; // null stands in for `world` (g_edicts[0])
  let e: EdictT | null;

  if (ent.target !== null) {
    e = G_FindByString(null, "targetname", ent.target);
    while (e !== null) {
      last = e;
      if (e.target === null) break;
      e = G_FindByString(null, "targetname", e.target);
    }
  } else {
    e = G_FindByString(null, "target", ent.targetname ?? "");
    while (e !== null) {
      last = e;
      if (e.targetname === null) break;
      e = G_FindByString(null, "target", e.targetname);
    }
  }

  if (last === null) return null; // last stayed `world` the whole time
  if (!SpawnFlags_has(last.spawnflags, SPAWNFLAG_HINT_ENDPOINT)) return null;

  return last;
}

/** rogue/g_rogue_newai.cpp:318-354 `edict_t *hintpath_other_end(edict_t *ent)`.
 *  Identical body to `hintpath_findstart` in the C++ source (both walk the
 *  target/targetname chain to its far end) -- ported as its own function to
 *  match the C++ source's two separate declarations, not collapsed into one,
 *  per this port line's "preserve original function names" mandate. */
export function hintpath_other_end(ent: EdictT): EdictT | null {
  return hintpath_findstart(ent);
}

/** rogue/g_rogue_newai.cpp:360-374 `void hintpath_go(edict_t *self, edict_t *point)`. */
export function hintpath_go(self: EdictT, point: EdictT): void {
  const dir = vec3_sub(point.s.origin, self.s.origin);

  self.ideal_yaw = vectoyaw(dir);
  self.goalentity = point;
  self.movetarget = point;
  self.monsterinfo.pausetime = GTIME_ZERO;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HINT_PATH;
  self.monsterinfo.aiflags &= ~(MonsterAiFlagsT.AI_SOUND_TARGET | MonsterAiFlagsT.AI_PURSUIT_LAST_SEEN | MonsterAiFlagsT.AI_PURSUE_NEXT | MonsterAiFlagsT.AI_PURSUE_TEMP);
  self.monsterinfo.search_time = level.time;
  must(self.monsterinfo.run, "monsterinfo.run", self)(self);
}

/** rogue/g_rogue_newai.cpp:379-406 `void hintpath_stop(edict_t *self)`. */
export function hintpath_stop(self: EdictT): void {
  self.goalentity = null;
  self.movetarget = null;
  self.monsterinfo.last_hint_time = level.time;
  self.monsterinfo.goal_hint = null;
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HINT_PATH;

  if (has_valid_enemy(self)) {
    if (self.enemy !== null && visible(self, self.enemy)) {
      FoundTarget(self);
      return;
    }
    HuntTarget(self);
    return;
  }

  self.enemy = null;
  self.monsterinfo.pausetime = HOLD_FOREVER;
  must(self.monsterinfo.stand, "monsterinfo.stand", self)(self);
}

/**
 * rogue/g_rogue_newai.cpp:414-715 `bool monsterlost_checkhint(edict_t
 * *self)`. The monster (`self`) checks around for valid hint paths -- a
 * valid hint path is one where both endpoints of a chain can see both the
 * monster and its enemy. See file header's "STUB SWAP" note: this function
 * used to be pinned to its own first line (`hint_paths_present` always
 * false); it is now the real search, gated the same way, reachable once
 * `InitHintPaths` is wired in by the coordinator.
 */
export function monsterlost_checkhint(self: EdictT): boolean {
  if (!hint_paths_present) return false;
  if (self.enemy === null) return false;

  // [Paril-KEX] don't do hint paths if we're using nav nodes
  if ((self.monsterinfo.aiflags & (MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_PATHING)) !== 0n) return false;

  if (self.classname === "monster_turret") return false;

  // find all the hint_paths, linked via a scratch `monster_hint_chain` list
  let monster_pathchain: EdictT | null = null;
  let checkpoint: EdictT | null = null;

  for (let i = 0; i < num_hint_paths; i++) {
    let e = hint_path_start[i] ?? null;
    while (e !== null) {
      if (e.monster_hint_chain !== null) e.monster_hint_chain = null;

      if (monster_pathchain !== null && checkpoint !== null) {
        checkpoint.monster_hint_chain = e;
        checkpoint = e;
      } else {
        monster_pathchain = e;
        checkpoint = e;
      }
      e = e.hint_chain;
    }
  }

  // filter by distance and visibility to the monster
  let e: EdictT | null = monster_pathchain;
  checkpoint = null;
  let count5 = 0;
  while (e !== null) {
    const r = mMedicMod().realrange(self, e);
    const fails = r > 512 || !visible(self, e);

    if (fails) {
      if (checkpoint !== null) {
        checkpoint.monster_hint_chain = e.monster_hint_chain;
        e.monster_hint_chain = null;
        e = checkpoint.monster_hint_chain;
        continue;
      }
      const next = e.monster_hint_chain;
      e.monster_hint_chain = null;
      monster_pathchain = next;
      e = next;
      continue;
    }

    count5++;
    checkpoint = e;
    e = e.monster_hint_chain;
  }

  if (count5 === 0) return false;

  const hint_path_represented: boolean[] = new Array(num_hint_paths).fill(false);

  e = monster_pathchain;
  while (e !== null) {
    if (e.hint_chain_id < 0 || e.hint_chain_id > num_hint_paths) return false;
    hint_path_represented[e.hint_chain_id] = true;
    e = e.monster_hint_chain;
  }

  count5 = 0;

  // build target_pathchain: every node on any chain represented above
  let target_pathchain: EdictT | null = null;
  checkpoint = null;
  for (let i = 0; i < num_hint_paths; i++) {
    if (!hint_path_represented[i]) continue;
    let node = hint_path_start[i] ?? null;
    while (node !== null) {
      if (target_pathchain !== null && checkpoint !== null) {
        checkpoint.target_hint_chain = node;
        checkpoint = node;
      } else {
        target_pathchain = node;
        checkpoint = node;
      }
      node = node.hint_chain;
    }
  }

  // filter target_pathchain by distance/visibility to the enemy
  e = target_pathchain;
  checkpoint = null;
  while (e !== null) {
    const r = mMedicMod().realrange(self.enemy, e);
    const fails = r > 512 || !visible(self.enemy, e);

    if (fails) {
      if (checkpoint !== null) {
        checkpoint.target_hint_chain = e.target_hint_chain;
        e.target_hint_chain = null;
        e = checkpoint.target_hint_chain;
        continue;
      }
      const next = e.target_hint_chain;
      e.target_hint_chain = null;
      target_pathchain = next;
      e = next;
      continue;
    }

    count5++;
    checkpoint = e;
    e = e.target_hint_chain;
  }

  if (count5 === 0) return false;

  const target_represented: boolean[] = new Array(num_hint_paths).fill(false);
  e = target_pathchain;
  while (e !== null) {
    if (e.hint_chain_id < 0 || e.hint_chain_id > num_hint_paths) return false;
    target_represented[e.hint_chain_id] = true;
    e = e.target_hint_chain;
  }

  // pick the closest "monster valid" node whose chain is also "target valid"
  let closest: EdictT | null = null;
  let closest_range = 1000000;
  e = monster_pathchain;
  while (e !== null) {
    if (!target_represented[e.hint_chain_id]) {
      e = e.monster_hint_chain;
      continue;
    }
    const r = mMedicMod().realrange(self, e);
    if (r < closest_range) {
      closest = e;
      closest_range = r;
    }
    e = e.monster_hint_chain;
  }

  if (closest === null) return false;

  const start = closest;

  // find the destination: the closest same-chain target-valid node to the monster
  closest = null;
  closest_range = 10000000;
  e = target_pathchain;
  while (e !== null) {
    if (start.hint_chain_id === e.hint_chain_id) {
      const r = mMedicMod().realrange(self, e);
      if (r < closest_range) {
        closest = e;
        closest_range = r;
      }
    }
    e = e.target_hint_chain;
  }

  if (closest === null) return false;

  self.monsterinfo.goal_hint = closest;
  hintpath_go(self, start);

  return true;
}

/** rogue/g_rogue_newai.cpp:724-781 `TOUCH(hint_path_touch)`. */
export const hint_path_touch: TouchFn = RegisterTouch("hint_path_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.movetarget !== self) return;

  const goal = other.monsterinfo.goal_hint;

  if (goal === self) {
    hintpath_stop(other);
    return;
  }

  let next: EdictT | null = null;
  let goalFound = false;
  let e: EdictT | null = hint_path_start[self.hint_chain_id] ?? null;
  while (e !== null) {
    if (e === self) {
      next = e.hint_chain;
      break;
    }
    if (e === goal) goalFound = true;
    if (e.hint_chain === self && goalFound) {
      next = e;
      break;
    }
    e = e.hint_chain;
  }

  if (next === null) {
    hintpath_stop(other);
    return;
  }

  hintpath_go(other, next);

  if (self.wait !== 0) {
    other.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
  }
});

/*QUAKED hint_path (.5 .3 0) (-8 -8 -8) (8 8 8) END
Target: next hint path

END - set this flag on the endpoints of each hintpath.

"wait" - set this if you want the monster to freeze when they touch this hintpath
*/
/** rogue/g_rogue_newai.cpp:790-811 `void SP_hint_path(edict_t *self)`. */
export function SP_hint_path(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  if (self.targetname === null && self.target === null) {
    gi.Com_Print(`${edictFmt(self)}: unlinked\n`);
    G_FreeEdict(self);
    return;
  }

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = hint_path_touch;
  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  gi.linkentity(self);
}

/**
 * rogue/g_rogue_newai.cpp:816-891 `void InitHintPaths()`. Called by
 * `SpawnEntities` (g_spawn.cpp:1262) once per level, after all entities have
 * spawned -- wired in as a delegating import at g_spawn.ts's own
 * `InitHintPaths` call site (2026-08-30, KEX demo playback unit; see this
 * file's own header "SP LIST" section for the prior gap).
 */
export function InitHintPaths(): void {
  hint_paths_present = false;

  let e = G_FindByString(null, "classname", "hint_path");
  if (e === null) return;
  hint_paths_present = true;

  hint_path_start = new Array(MAX_HINT_CHAINS).fill(null);
  num_hint_paths = 0;

  while (e !== null) {
    if (SpawnFlags_has(e.spawnflags, SPAWNFLAG_HINT_ENDPOINT) && e.target !== null) {
      if (e.targetname !== null) {
        gi.Com_Print(`${edictFmt(e)}: marked as endpoint with both target (${e.target}) and targetname (${e.targetname})\n`);
      } else {
        if (num_hint_paths >= MAX_HINT_CHAINS) break;
        hint_path_start[num_hint_paths++] = e;
      }
    }
    e = G_FindByString(e, "classname", "hint_path");
  }

  for (let i = 0; i < num_hint_paths; i++) {
    let current = hint_path_start[i];
    if (current === null || current === undefined) continue;
    current.hint_chain_id = i;

    let next = current.target !== null ? G_FindByString(null, "targetname", current.target) : null;
    if (next !== null && current.target !== null && G_FindByString(next, "targetname", current.target) !== null) {
      gi.Com_Print(`${edictFmt(current)}: Forked path detected for chain ${num_hint_paths}, target ${current.target}\n`);
      const start = hint_path_start[i];
      if (start !== null && start !== undefined) start.hint_chain = null;
      continue;
    }

    while (next !== null) {
      if (next.hint_chain !== null) {
        gi.Com_Print(`${edictFmt(next)}: Circular path detected for chain ${num_hint_paths}, targetname ${next.targetname ?? ""}\n`);
        const start = hint_path_start[i];
        if (start !== null && start !== undefined) start.hint_chain = null;
        break;
      }
      current.hint_chain = next;
      current = next;
      current.hint_chain_id = i;
      if (current.target === null) break;

      const found = G_FindByString(null, "targetname", current.target);
      if (found !== null && G_FindByString(found, "targetname", current.target) !== null) {
        gi.Com_Print(`${edictFmt(current)}: Forked path detected for chain ${num_hint_paths}, target ${current.target}\n`);
        const start = hint_path_start[i];
        if (start !== null && start !== undefined) start.hint_chain = null;
        break;
      }
      next = found;
    }
  }
}

// ---------------------------------------------------------------------------
// MISCELLANEOUS STUFF (rogue/g_rogue_newai.cpp:893-1073)
// ---------------------------------------------------------------------------

/** PMM - inback: is `other` behind `self` (not to the side)?
 *  rogue/g_rogue_newai.cpp:901-912 `bool inback(edict_t *self, edict_t *other)`. */
export function inback(self: EdictT, other: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const vecDir = vec3_normalized(vec3_sub(other.s.origin, self.s.origin));
  return vec3_dot(vecDir, forward) < -0.3;
}

/** rogue/g_rogue_newai.cpp:923-945 `bool face_wall(edict_t *self)`. */
export function face_wall(self: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const pt = vec3_add(self.s.origin, vec3_muls(forward, 64));
  const tr: KexTraceT = gi.trace(self.s.origin, null, null, pt, self, MASK_MONSTERSOLID);
  if (tr.fraction < 1 && !tr.allsolid && !tr.startsolid) {
    const ang = vectoangles(tr.plane.normal);
    self.ideal_yaw = ang[1] /* YAW */ + 180;
    if (self.ideal_yaw > 360) self.ideal_yaw -= 360;

    M_ChangeYaw(self);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Monster "Bad" Areas (rogue/g_rogue_newai.cpp:947-1073)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_newai.cpp:951-953 `TOUCH(badarea_touch)` -- deliberately
 *  empty in the C++ source (the trigger's only job is to BE a trigger;
 *  `CheckForBadArea`'s box query finds it by identity, `hit->touch ==
 *  badarea_touch`, never by anything this touch callback does). */
export const badarea_touch: TouchFn = RegisterTouch("badarea_touch", (_self: EdictT, _other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  // intentionally empty -- see doc comment above.
});

/**
 * rogue/g_rogue_newai.cpp:955-985 `edict_t *SpawnBadArea(const vec3_t
 * &mins, const vec3_t &maxs, gtime_t lifespan, edict_t *owner)`. Spawns a
 * `bad_area` trigger volume monsters avoid pathing through (tesla zap
 * radius, prox blast radius, etc). `lifespan` of `GTIME_ZERO` means the
 * area never auto-frees itself.
 */
export function SpawnBadArea(mins: Vec3, maxs: Vec3, lifespan: GTime, owner: EdictT | null): EdictT {
  const origin = vec3_muls(vec3_add(mins, maxs), 0.5);

  const badarea = G_Spawn();
  badarea.s.origin = origin;
  badarea.maxs = vec3_sub(maxs, origin);
  badarea.mins = vec3_sub(mins, origin);
  badarea.touch = badarea_touch;
  badarea.movetype = MovetypeT.MOVETYPE_NONE;
  badarea.solid = SolidT.SOLID_TRIGGER;
  badarea.classname = "bad_area";
  gi.linkentity(badarea);

  if (lifespan !== 0) {
    badarea.think = G_FreeEdict;
    badarea.nextthink = Gtime_add(level.time, lifespan);
  }
  if (owner !== null) {
    badarea.owner = owner;
  }

  return badarea;
}

function CheckForBadArea_BoxFilter(hit: KexEdictT | null): BoxEdictsResultT {
  if (hit === null) return BoxEdictsResultT.Skip;
  const full = g_edicts[hit.s.number];
  if (full === undefined || full.touch !== badarea_touch) return BoxEdictsResultT.Skip;
  return BoxEdictsResultT.Keep;
}

/**
 * rogue/g_rogue_newai.cpp:1000-1015 `edict_t *CheckForBadArea(edict_t
 * *ent)` -- a customized `G_TouchTriggers` that only checks for `bad_area`
 * triggers. See file header's "DEVIATIONS" note on the `gi.BoxEdicts`
 * result-channel difference.
 */
export function CheckForBadArea(ent: EdictT): EdictT | null {
  const mins = vec3_add(ent.s.origin, ent.mins);
  const maxs = vec3_add(ent.s.origin, ent.maxs);

  const list: (KexEdictT | null)[] = [null];
  const num = gi.BoxEdicts(mins, maxs, list, 1, SolidityAreaT.AREA_TRIGGERS, CheckForBadArea_BoxFilter, null);
  if (num === 0) return null;

  const raw = list[0];
  if (raw === null || raw === undefined) return null;
  const hit = g_edicts[raw.s.number];
  return hit === undefined ? null : hit;
}

const TESLA_DAMAGE_RADIUS = 128;

/**
 * rogue/g_rogue_newai.cpp:1019-1073 `bool MarkTeslaArea(edict_t *self,
 * edict_t *tesla)`. Spawns (or confirms the existence of) a `bad_area`
 * around a tesla trap, linked onto the tesla's team chain, so monster AI
 * avoids walking through the zap radius.
 */
export function MarkTeslaArea(self: EdictT | null, tesla: EdictT | null): boolean {
  if (tesla === null || self === null) return false;

  let area: EdictT | null = null;

  // make sure this tesla doesn't already have a bad area around it
  let e = tesla.teamchain;
  let tail = tesla;
  while (e !== null) {
    tail = tail.teamchain ?? tail;
    if (e.classname === "bad_area") return false;
    e = e.teamchain;
  }

  if (tesla.teamchain !== null && tesla.teamchain.inuse) {
    const trigger = tesla.teamchain;
    const mins = trigger.absmin;
    const maxs = trigger.absmax;

    area = SpawnBadArea(mins, maxs, Gtime_nonzero(tesla.air_finished) ? tesla.air_finished : tesla.nextthink, tesla);
  } else {
    const mins = vec3(-TESLA_DAMAGE_RADIUS, -TESLA_DAMAGE_RADIUS, tesla.mins[2]);
    const maxs = vec3(TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS);

    area = SpawnBadArea(mins, maxs, Gtime_from_sec(30), tesla);
  }

  if (area !== null) tail.teamchain = area;

  return true;
}

/** rogue/g_rogue_newai.cpp:1472-1503 `void TargetTesla(edict_t *self,
 *  edict_t *tesla)` -- redirects a monster's aggression onto a tesla trap. */
export function TargetTesla(self: EdictT | null, tesla: EdictT | null): void {
  if (self === null || tesla === null) return;

  // PMM - medic bails on healing things
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    if (self.enemy !== null) cleanupHealTarget(self.enemy);
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
  }

  // store the player enemy in case we lose track of him
  if (self.enemy !== null && self.enemy.client !== null) {
    self.monsterinfo.last_player_enemy = self.enemy;
  }

  if (self.enemy !== tesla) {
    self.oldenemy = self.enemy;
    self.enemy = tesla;
    if (self.monsterinfo.attack !== null) {
      if (self.health <= 0) return;
      self.monsterinfo.attack(self);
    } else {
      FoundTarget(self);
    }
  }
}

// ---------------------------------------------------------------------------
// small remaining helpers
// ---------------------------------------------------------------------------

/** rogue/g_rogue_newai.cpp:1205-1219 `bool below(edict_t *self, edict_t *other)`. */
export function below(self: EdictT, other: EdictT): boolean {
  const vecDir = vec3_normalized(vec3_sub(other.s.origin, self.s.origin));
  const down = vec3(0, 0, -1);
  return vec3_dot(vecDir, down) > 0.95;
}

/** rogue/g_rogue_newai.cpp:1221-1289 `void drawbbox(edict_t *self)` --
 *  see file header's "DEVIATIONS" note (dead code, ported anyway). */
export function drawbbox(self: EdictT): void {
  const coords: [Vec3, Vec3] = [self.absmin, self.absmax];
  const pt: Vec3[] = new Array(8);
  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= 1; j++) {
      for (let k = 0; k <= 1; k++) {
        pt[4 * i + 2 * j + k] = vec3(coords[i][0], coords[j][1], coords[k][2]);
      }
    }
  }

  const lines = [
    [1, 2, 4],
    [1, 2, 7],
    [1, 4, 5],
    [2, 4, 7],
  ];
  const starts = [0, 3, 5, 6];

  for (let i = 0; i <= 3; i++) {
    for (let j = 0; j <= 2; j++) {
      gi.WriteByte(ServerCommandT.svc_temp_entity);
      gi.WriteByte(KexTempEventT.TE_DEBUGTRAIL);
      gi.WritePosition(pt[starts[i]]);
      gi.WritePosition(pt[lines[i][j]]);
      gi.multicast(pt[starts[i]], KexMulticastT.MULTICAST_ALL, false);
    }
  }

  const dir = vectoangles(self.s.angles);
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(dir, f, r, u);

  for (const axis of [f, r, u]) {
    const newbox = vec3_add(self.s.origin, vec3_muls(axis, 50));
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_DEBUGTRAIL);
    gi.WritePosition(self.s.origin);
    gi.WritePosition(newbox);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
  }
}

/** rogue/g_rogue_newai.cpp:1292-1299 `inline bool G_SkillCheck(const
 *  std::initializer_list<float> &skills)`. */
export function G_SkillCheck(skills: number[]): boolean {
  const skill = skillInt();
  if (skills.length < skill) return true;

  const skill_switch = skills[skill];
  return skill_switch === 1.0 ? true : frandom() < skill_switch;
}

/** rogue/g_rogue_newai.cpp:1458-1470 `bool has_valid_enemy(edict_t *self)`. */
export function has_valid_enemy(self: EdictT): boolean {
  if (self.enemy === null) return false;
  if (!self.enemy.inuse) return false;
  if (self.enemy.health < 1) return false;
  return true;
}

/** rogue/g_rogue_newai.cpp:1541-1573 `int CountPlayers()` -- only meaningful
 *  in coop (returns 1 outside coop, matching the C++ source's early return). */
export function CountPlayers(): number {
  if (!coopEnabled()) return 1;

  let count = 0;
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.client === null) continue;
    count++;
  }
  return count;
}

// BossExplode / BossExplode_think (rogue/g_rogue_newai.cpp:1575-1612) --
// ALREADY ported for real in m_supertank.ts (its own header cites the exact
// same C++ line range -- this file's declared home matches, but the body
// already lives there, predating this unit). An earlier draft of this file
// duplicated both under the identical save name "BossExplode_think",
// which throws `g_save_registry: duplicate think registration` the moment
// both files are loaded together (invisible in this file's own isolated
// test, which never happened to load m_supertank.ts -- caught only once
// g_spawn.ts's full monster roster pulled both in at once). Re-exported
// from its real home via the same lazy require() as `mMedicMod()` above
// (not a static import/re-export), for the identical cycle reason: a
// static edge to m_supertank.ts here risks the same
// m_supertank.ts-reads-g_ai.ts-at-top-level hazard through any file that
// statically imports this one (m_move.ts, etc).
export function BossExplode(self: EdictT): void {
  mSupertankMod().BossExplode(self);
}
