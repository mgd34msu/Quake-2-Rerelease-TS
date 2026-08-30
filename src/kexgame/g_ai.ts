// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_ai.c -- monster AI targeting/movement dispatch (2023 Quake II re-release
// / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_ai.cpp (1,808 lines, C++17):
// AI_GetSightClient, ai_move/ai_stand/ai_walk/ai_charge/ai_turn (the
// mframe_t aifunc family), range_to/visible/infront (real-distance/PVS-trace
// gating), HuntTarget/FoundTarget, AI_GetMonsterAlertedByPlayers/
// AI_GetSoundClient/G_MonsterSourceVisible (indirect-alert helpers),
// FindTarget (the big sight/sound acquisition function), FacingIdeal,
// M_CheckAttack_Base/M_CheckAttack (the melee/missile/blindfire decision
// table), ai_run_melee/ai_run_missile/ai_run_slide/ai_checkattack/ai_run
// (the chase orchestrator). Behavioral code, ported bug-for-bug per
// PORTING.md.
//
// ============================================================================
// STUB SWAP: g_monster.ts's FoundTarget/M_CheckAttack, g_combat.ts's
// visible/FoundTarget are now real imports from here
// ============================================================================
// g_monster.ts's header ("CROSS-DEPENDENCIES NOT YET PORTED") named
// FoundTarget and M_CheckAttack as local throwing stubs pending this file.
// Both are now real imports from here; g_monster.ts's own two local stubs
// and the "M_CheckAttack ... swap this stub" note are removed. M_CheckAttack
// keeps registering under its real save name via RegisterMonsterinfoCheckattack
// (SAVE_FUNC_MONSTERINFO_CHECKATTACK("M_CheckAttack") in the C++ source) --
// the registration now happens in THIS file instead of g_monster.ts, but the
// registered name is identical, so no save-compat break.
//
// g_combat.ts's header similarly named `visible` and `FoundTarget` as local
// throwing stubs pending this file (reached by M_ReactToDamage). Both are
// now real imports from here; g_combat.ts's own two local stubs are removed.
// g_combat.ts's `MarkTeslaArea`/`TargetTesla`/`cleanupHealTarget` stubs are
// untouched (ROGUE mission-pack files, out of this unit's scope).
//
// This creates one new import edge: g_monster.ts and g_combat.ts now import
// from g_ai.ts. Neither of those two is a cycle (g_ai.ts imports nothing
// back from either, verified by reading the whole of g_ai.cpp).
//
// ============================================================================
// STUB SWAP: PlayerTrail_Pick is now a real import from p_trail.ts (a real,
// sanctioned, TWO-WAY cycle -- unlike the g_monster.ts/g_combat.ts edges
// above)
// ============================================================================
// This file's own local, unexported throwing stub for `PlayerTrail_Pick`
// (cited "pending p_trail.ts, see p_trail.cpp:103" -- reached only from
// `ai_run`'s "just lost sight, pick a pursuit marker" branch, gated behind
// `AI_PURSUE_NEXT`) is deleted and replaced with a real import from
// src/kexgame/p_trail.ts, now landed. Unlike the g_monster.ts/g_combat.ts
// edge above, this one is a genuine two-way cycle: p_trail.ts's own
// `PlayerTrail_Pick` calls `visible` (THIS file's export) for its
// "find the first marker we can see" branch. Both cross-module symbols
// (`visible` here, `PlayerTrail_Pick` in p_trail.ts) are hoisted `export
// function` declarations, never a top-level `const` evaluated at
// module-init time, and both are only ever called from inside another
// function's body at real game-frame time -- no TDZ hazard, matching the
// shape and safety argument of every other sanctioned cycle in this port
// line (g_utils.ts<->g_phys.ts, g_utils.ts<->g_combat.ts,
// g_utils.ts<->p_client.ts, g_phys.ts<->g_monster.ts). Verified end-to-end
// by `bunx tsc --noEmit` and `bun test` actually importing both files
// together. `ai_run`'s call site itself is unchanged: still reached only
// when a monster's bounding box reaches its last-known-sighting spot (a
// real, common-in-actual-play branch, but not reached by this unit's own
// scripted single-call tests, which avoid placing `self` already at
// `monsterinfo.last_sighting`, mirroring g_combat.ts's "stay clear of the
// gap" pattern for everything except one deliberate documentation case).
//
// ============================================================================
// STUB SWAP: hintpath_stop / monsterlost_checkhint are now real imports;
// monster_done_dodge is a local duplicate, NOT an import (see IMPORT CYCLE
// note below)
// ============================================================================
// This file previously carried three local throwing stubs (`hintpath_stop`,
// `monster_done_dodge`) plus one narrowly-pinned partial port
// (`monsterlost_checkhint`, hard-coded to its own first line's early
// return since no `hint_path` entity could ever exist in this port line).
//   - `hintpath_stop`/`monsterlost_checkhint` (rogue/g_rogue_newai.cpp:379,
//     414) -> real imports from "./rogue/g_rogue_newai", now landed.
//   - `monster_done_dodge` (rogue/g_rogue_monster.cpp:98) -> a local,
//     trivial two-line duplicate (see below), NOT an import. It IS ported
//     for real elsewhere (m_soldier.ts, re-exported by g_rogue_monster.ts),
//     but importing it here would close a THREE-module import cycle
//     (g_ai.ts -> m_soldier.ts -> g_ai.ts) through m_soldier.ts's top-level
//     frame-table construction (`const soldier_frames_stand1: MframeT[] =
//     [...]`, which reads this file's `export const ai_stand`/`ai_walk`/etc
//     directly at module-evaluation time, not from inside a function body)
//     -- see "IMPORT CYCLE" note immediately below for why that specific
//     shape breaks at load time, unlike the sanctioned cycles this file
//     already carries.
//
// `monsterlost_checkhint`'s real body's very first line is exactly the
// pinned early return this file used to hard-code
// (`if (!hint_paths_present) return false;`), reading g_rogue_newai.ts's
// own mutable `hint_paths_present` (set true by `InitHintPaths`, which
// itself is exported but not yet wired into any caller -- see
// g_rogue_newai.ts's own "SP LIST" header section for the pending
// g_spawn.ts integration point). Until that wiring lands, this stays
// behaviorally identical to the old pin; once it lands, the rest of the
// hint-chain search activates with zero further changes in this file.
//
// This creates one new two-way import cycle: g_ai.ts <-> rogue/g_rogue_newai.ts.
// Safe by the same argument as the p_trail.ts cycle documented above: every
// cross-imported symbol on both sides is a hoisted `export function`
// declaration, never a top-level `const` evaluated at module-init time, and
// every call site reads them from inside another function's body at real
// game-frame time. Verified end-to-end: `bun test` actually loading this
// file, rogue/g_rogue_newai.ts, and a monster file together (a prior draft
// of this swap DID import `monster_done_dodge` from "./m_soldier" directly
// and crashed at load with `ReferenceError: Cannot access 'ai_stand' before
// initialization` -- the three-module cycle above; caught by running the
// actual test suite, not just `tsc`, which is silent on this class of bug).
//
// ============================================================================
// KEX PATHING HOOKS -- none exist in this file
// ============================================================================
// This port line's unit brief anticipated "KEX pathing hooks calling
// gi.Bot_*/GetPathToGoal-adjacent logic" in this file. Grepping the entire
// 1,808-line source (not just skimming) finds no call to any `gi.Bot_*` or
// `gi.GetPathToGoal` anywhere in g_ai.cpp -- the only KEX-pathing-flavored
// code here is plain `AI_PATHING`/`AI_NO_PATH_FINDING` monsterinfo.aiflags
// bit checks (`FacingIdeal`'s looser turn tolerance, `ai_run`'s "don't
// override AS_STRAIGHT while pathing" and "don't auto-set AI_PURSUE_NEXT
// while pathing" branches). Those flag checks are ported faithfully below;
// no `gi.Bot_*`/`GetPathToGoal` stub was needed because none is called.
//
// ============================================================================
// `visible`'s THIRD PARAMETER DEFAULTS TO true, NOT false
// ============================================================================
// g_local.h:2307: `bool visible(edict_t *self, edict_t *other, bool
// through_glass = true);` -- confirmed against the header, not assumed.
// Every 2-argument call site in this file (all of them; g_ai.cpp never
// passes a third argument to `visible`) therefore runs with
// `through_glass=true`, which means `mask |= CONTENTS_WINDOW` is SKIPPED
// (`if (!through_glass) mask |= CONTENTS_WINDOW;`) -- i.e. monsters see
// THROUGH window glass by default when this file calls `visible(a, b)`.
// This reads backwards from the intuitive "can't see through glass by
// default" expectation; preserved exactly as declared, not "fixed". Ported
// as `through_glass: boolean = true`, matching the header default.
//
// ============================================================================
// `ai_checkattack`'s unused `dist` parameter
// ============================================================================
// `bool ai_checkattack(edict_t *self, float dist)` never reads `dist`
// anywhere in its body (verified by reading the whole function) -- a dead
// parameter kept only so `ai_stand(self, 0)` / `ai_run(self, dist)`'s call
// sites compile. Ported with the same signature (for call-site fidelity),
// parameter kept unused.
//
// ============================================================================
// GTime/Vec3/EdictT-null conventions reused from this port line
// ============================================================================
// - GTime comparisons use plain `<`/`>`/`<=`/`>=` (it's `number & brand`,
//   per gtime.ts).
// - Every "value" Vec3 assignment into a persistent field (monsterinfo.
//   last_sighting/saved_goal, tempgoal.s.origin, ...) goes through this
//   file's own `copyVec3` (identical helper to m_move.ts's own, duplicated
//   per that file's own precedent -- no shared export exists) to avoid the
//   Float32Array-aliasing trap q_vec3.ts's header documents; never a bare
//   `x = y.s.origin` for anything that outlives the current statement.
// - Places where the C++ source dereferences `self->enemy`/monsterinfo
//   function pointers with NO null check (implicitly assuming an invariant
//   that always holds in real play) are ported as explicit THROWING null
//   checks, never a silent `!`/`as` narrow -- matching g_monster.ts's own
//   `M_ProcessPain` precedent. Each is commented at its call site.
//
// ============================================================================
// m_move.ts's OWN visible/FoundTarget/FacingIdeal/range_to STUBS ARE NOT
// SWAPPED HERE
// ============================================================================
// m_move.ts (already landed) carries its own four local, unexported
// throwing stubs for exactly these four functions (used internally by
// SV_StepDirection/M_MoveToPath/SV_alternate_flystep). This unit's file
// scope is g_ai.ts + g_monster.ts's stub swap + g_combat.ts's stub swap +
// this test file -- m_move.ts is explicitly off-limits (a concurrent unit
// may be landing it). A future unit should replace m_move.ts's four local
// stubs with real imports from this file, mirroring exactly the g_monster.ts/
// g_combat.ts swaps done here. Until then, m_move.ts's own internal call
// paths to its copies of these four functions still throw regardless of
// this file's real implementations -- a known, documented gap, not a bug
// introduced by this unit.

import { vec3, type Vec3 } from "../shared/math";
import { CplaneT, type CvarT } from "../shared/q_shared";
import {
  type KexEdictT,
  type KexTraceT,
  ContentsT,
  SvflagsT,
  SolidT,
  ServerFlagsT,
  CvarFlagsT,
  MASK_SOLID,
  MASK_PLAYERSOLID,
} from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MonsterinfoCheckattackFn,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  EntFlagsT,
  HOLD_FOREVER,
  HACKFLAG_ATTACK_PLAYER,
  HACKFLAG_END_CUTSCENE,
  SPAWNFLAG_MONSTER_AMBUSH,
  RANGE_MELEE,
  RANGE_NEAR,
  RANGE_MID,
  random_time,
} from "./g_local";
import { gi, globals, g_edicts, game, level } from "./g_main_globals";
import { GTIME_ZERO, Gtime_add, Gtime_subtract, Gtime_from_ms, Gtime_from_sec, Gtime_from_hz, Gtime_nonzero, type GTime } from "./gtime";
import { SpawnFlags_has } from "./spawnflags";
import {
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_dot,
  vec3_length,
  vec3_normalized,
  boxes_intersect,
  distance_between_boxes,
  closest_point_to_box,
  AngleVectors,
  vectoyaw,
  G_ProjectSource,
} from "./q_vec3";
import { YAW, frandom } from "./q_std";
import { G_Spawn, G_FreeEdict, G_PickTarget } from "./g_utils";
import { M_walkmove, M_ChangeYaw, M_MoveToGoal, SV_CloseEnough } from "./m_move";
import { RegisterMonsterinfoCheckattack } from "./g_save_registry";
import { PlayerTrail_Pick } from "./p_trail";
import type * as GRogueNewaiModule from "./rogue/g_rogue_newai";

// rogue/g_rogue_newai.ts is reached lazily (via Bun's synchronous require,
// not a static top-level import) -- see this file's own "IMPORT CYCLE"
// header note: a static import here closes a cycle through m_medic.ts
// (which g_rogue_newai.ts needs for realrange/PickCoopTarget/
// cleanupHealTarget) into m_supertank.ts, which reads this file's
// `export const ai_stand`/etc directly at ITS OWN module top level
// (`const supertank_frames_stand: MframeT[] = Array.from(..., () =>
// frame(ai_stand))`) -- a `ReferenceError: Cannot access 'ai_stand' before
// initialization` at load, caught by running `bun test`, not `tsc`.
// `import type` above is compile-time only (erased), so it adds no runtime
// edge. Matches src/qcommon/files.ts's own `cvarMod()`/`cmdMod()` precedent
// exactly (PORTING.md's sanctioned require() escape hatch for cycles that
// break module init).
function rogueNewaiMod(): typeof GRogueNewaiModule {
  return require("./rogue/g_rogue_newai");
}

// ---------------------------------------------------------------------------
// module-scope statics (g_ai.cpp:10-16: `bool enemy_vis; bool
// enemy_infront; float enemy_yaw;` -- genuine cross-call persistent globals,
// not per-monster state; also `constexpr float MAX_SIDESTEP = 8.0f;`)
// ---------------------------------------------------------------------------

let enemy_vis = false;
let enemy_infront = false;
let enemy_yaw = 0;

const MAX_SIDESTEP = 8.0;

// ---------------------------------------------------------------------------
// small local helpers -- see file header for each
// ---------------------------------------------------------------------------

function copyVec3(v: Vec3): Vec3 {
  return vec3(v[0], v[1], v[2]);
}

function edictFrom(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0]!;
  return g_edicts[ent.s.number]!;
}

/** g_local.h:136-139 `game_import_t::traceline` -- see g_monster.ts's
 *  identical helper/header note; duplicated here per that file's own
 *  precedent (no shared export exists for this trivial header wrapper). */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) {
    throw new Error(`gi.cvar(${name}) returned null`);
  }
  return c;
}

/** `coop->integer`, worked around per g_utils.ts's own `coopEnabled()`
 *  precedent (`CvarT` has no `.integer` field in this port). */
function coopEnabled(): boolean {
  return cvarOrDefault("coop", "0").value !== 0;
}

/** g_local.h:468-469's `FRAME_TIME_S`, worked around per g_phys.ts's/
 *  m_move.ts's identical `frameTimeAsGtime()` precedent (no InitGame-set
 *  global exists yet in this port line). */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/** q_std.h:185 -- kex's OWN `anglemod` (fmod-based), needed by
 *  `FacingIdeal`. See m_move.ts's identical helper/header note ("anglemod /
 *  LerpAngle") for why this isn't in q_std.ts; duplicated here since
 *  m_move.ts doesn't export it and this unit may not edit m_move.ts. */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** g_local.h:3434 `active_players()` -- an `entity_iterable_t` over
 *  `g_edicts[1..game.maxclients]` filtered to `inuse && client &&
 *  client->pers.connected`. Ported as a plain array (this port line has no
 *  lazy entity-iterable abstraction anywhere yet), same filter, same
 *  iteration order. */
function activePlayers(): EdictT[] {
  const out: EdictT[] = [];
  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (e !== undefined && e.inuse && e.client !== null && e.client.pers.connected) {
      out.push(e);
    }
  }
  return out;
}

/** g_local.h:3534 `fmt::formatter<edict_t>` -- see g_monster.ts-adjacent
 *  placement-mismatch precedent (declared in the header, needed here first
 *  for `FoundTarget`'s diagnostic print). `"{} @ {}"` formats
 *  `classname`/origin (linked entities use their bounds' center instead;
 *  not reproduced here since this print is diagnostic-only, not gameplay). */
function formatEdictForPrint(e: EdictT): string {
  return `${e.classname ?? "?"} @ (${e.s.origin[0]}, ${e.s.origin[1]}, ${e.s.origin[2]})`;
}

// ---------------------------------------------------------------------------
// hintpath_stop / monsterlost_checkhint are now real imports -- see file
// header's "STUB SWAP" section (top of file). monster_done_dodge is a
// local, trivial two-line duplicate (see below) rather than an import --
// see file header's "IMPORT CYCLE" note.
// ---------------------------------------------------------------------------

/** rogue/g_rogue_monster.cpp:98-103 `void monster_done_dodge(edict_t
 *  *self)`. Real home is m_soldier.ts's re-export of g_rogue_monster.ts's
 *  version -- duplicated locally here (not imported) purely to avoid a
 *  three-module import cycle through m_soldier.ts's top-level frame-table
 *  construction (see file header's "IMPORT CYCLE" note); identical
 *  two-line body, no behavioral difference. */
function monster_done_dodge(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_DODGING;
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  }
}

// ---------------------------------------------------------------------------
// AI_GetSightClient (g_ai.cpp:29-58)
// ---------------------------------------------------------------------------

export function AI_GetSightClient(self: EdictT): EdictT | null {
  if (Gtime_nonzero(level.intermissiontime)) return null;

  const visible_players: EdictT[] = [];

  for (const player of activePlayers()) {
    if (player.health <= 0 || player.deadflag || player.solid === SolidT.SOLID_NOT) continue;
    else if ((player.flags & (EntFlagsT.FL_NOTARGET | EntFlagsT.FL_DISGUISED)) !== 0n) continue;

    if (!boxes_intersect(self.absmin, self.absmax, player.absmin, player.absmax)) {
      if (
        ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_THIRD_EYE) === 0n && !infront(self, player)) ||
        !visible(self, player)
      ) {
        continue;
      }
    }

    visible_players.push(player);
  }

  if (visible_players.length === 0) return null;

  return visible_players[Math.floor(frandom() * visible_players.length)]!;
}

// ---------------------------------------------------------------------------
// ai_move / ai_stand / ai_walk / ai_charge / ai_turn (g_ai.cpp:60-340)
// ---------------------------------------------------------------------------

// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_move(self: EdictT, dist: number): void {
  M_walkmove(self, self.s.angles[YAW], dist);
}

// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_stand(self: EdictT, dist: number): void {
  if (dist !== 0 || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n) {
    M_walkmove(self, self.s.angles[YAW], dist);
  }

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    // [Paril-KEX] check if we've been pushed out of our point_combat
    if (
      (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TEMP_STAND_GROUND) === 0n &&
      self.movetarget !== null &&
      self.movetarget.classname === "point_combat"
    ) {
      if (!boxes_intersect(self.absmin, self.absmax, self.movetarget.absmin, self.movetarget.absmax)) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_STAND_GROUND;
        self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_COMBAT_POINT;
        self.goalentity = self.movetarget;
        if (self.monsterinfo.run === null) {
          throw new Error(`ai_stand: monsterinfo.run is null for ${self.classname ?? "?"}`);
        }
        self.monsterinfo.run(self);
        return;
      }
    }

    if (self.enemy !== null && self.enemy.classname !== "player_noise") {
      const v = vec3_sub(self.enemy.s.origin, self.s.origin);
      self.ideal_yaw = vectoyaw(v);
      if (!FacingIdeal(self) && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TEMP_STAND_GROUND) !== 0n) {
        self.monsterinfo.aiflags &= ~(MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_TEMP_STAND_GROUND);
        if (self.monsterinfo.run === null) {
          throw new Error(`ai_stand: monsterinfo.run is null for ${self.classname ?? "?"}`);
        }
        self.monsterinfo.run(self);
      }
      if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);

      const retval = ai_checkattack(self, 0);

      if (self.enemy !== null && self.enemy.inuse) {
        if (visible(self, self.enemy)) {
          self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;
          self.monsterinfo.last_sighting = copyVec3(self.enemy.s.origin);
          self.monsterinfo.saved_goal = copyVec3(self.enemy.s.origin);
          self.monsterinfo.blind_fire_target = vec3_add(self.monsterinfo.last_sighting, vec3_muls(self.enemy.velocity, -0.1));
          self.monsterinfo.trail_time = level.time;
          self.monsterinfo.blind_fire_delay = GTIME_ZERO;
        } else {
          if (FindTarget(self)) return;
          self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_LOST_SIGHT;
        }

        // Paril: fixes rare cases of a stand ground monster being stuck
        // aiming at a sound target that they can still see
        if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) !== 0n && !retval) {
          if (FindTarget(self)) return;
        }
      } else if (!retval) {
        FindTarget(self);
        return;
      }
    } else {
      FindTarget(self);
    }
    return;
  }

  // Paril: this fixes a bug somewhere else that sometimes causes a monster
  // to be given an enemy without ever calling HuntTarget.
  if (self.enemy !== null && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) === 0n) {
    HuntTarget(self);
    return;
  }

  if (FindTarget(self)) return;

  if (level.time > self.monsterinfo.pausetime) {
    if (self.monsterinfo.walk === null) {
      throw new Error(`ai_stand: monsterinfo.walk is null for ${self.classname ?? "?"}`);
    }
    self.monsterinfo.walk(self);
    return;
  }

  if (
    !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH) &&
    self.monsterinfo.idle !== null &&
    level.time > self.monsterinfo.idle_time
  ) {
    if (Gtime_nonzero(self.monsterinfo.idle_time)) {
      self.monsterinfo.idle(self);
      self.monsterinfo.idle_time = Gtime_add(level.time, random_time(Gtime_from_sec(15), Gtime_from_sec(30)));
    } else {
      self.monsterinfo.idle_time = Gtime_add(level.time, random_time(Gtime_from_sec(15)));
    }
  }
}

// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_walk(self: EdictT, dist: number): void {
  let temp_goal: EdictT | null = null;

  if (self.goalentity === null && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) {
    const fwd = vec3();
    AngleVectors(self.s.angles, fwd, null, null);

    temp_goal = G_Spawn();
    temp_goal.s.origin = vec3_add(self.s.origin, vec3_muls(fwd, 64));
    self.goalentity = temp_goal;
  }

  M_MoveToGoal(self, dist);

  if (temp_goal !== null) {
    G_FreeEdict(temp_goal);
    self.goalentity = null;
  }

  // check for noticing a player
  if (FindTarget(self)) return;

  if (self.monsterinfo.search !== null && level.time > self.monsterinfo.idle_time) {
    if (Gtime_nonzero(self.monsterinfo.idle_time)) {
      self.monsterinfo.search(self);
      self.monsterinfo.idle_time = Gtime_add(level.time, random_time(Gtime_from_sec(15), Gtime_from_sec(30)));
    } else {
      self.monsterinfo.idle_time = Gtime_add(level.time, random_time(Gtime_from_sec(15)));
    }
  }
}

// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_charge(self: EdictT, distArg: number): void {
  let dist = distArg;

  // This is put in there so monsters won't move towards the origin after
  // killing a tesla. This could be problematic, so keep an eye on it.
  if (self.enemy === null || !self.enemy.inuse) return;

  // PMM - save blindfire target
  if (visible(self, self.enemy)) {
    self.monsterinfo.blind_fire_target = vec3_add(self.enemy.s.origin, vec3_muls(self.enemy.velocity, -0.1));
  }

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) {
    const v = vec3_sub(self.enemy.s.origin, self.s.origin);
    self.ideal_yaw = vectoyaw(v);
  }
  M_ChangeYaw(self);

  if (dist !== 0 || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_CHARGING) !== 0n) {
      M_MoveToGoal(self, dist);
      return;
    }
    // circle strafe support
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) {
      let ofs: number;
      if (self.enemy !== null && self.enemy.classname === "tesla_mine") {
        ofs = 0;
      } else if (self.monsterinfo.lefty) {
        ofs = 90;
      } else {
        ofs = -90;
      }

      if (self.monsterinfo.active_move === null) {
        throw new Error(`ai_charge: monsterinfo.active_move is null while attack_state===AS_SLIDING for ${self.classname ?? "?"}`);
      }
      dist *= self.monsterinfo.active_move.sidestep_scale;

      if (M_walkmove(self, self.ideal_yaw + ofs, dist)) return;

      self.monsterinfo.lefty = !self.monsterinfo.lefty;
      M_walkmove(self, self.ideal_yaw - ofs, dist);
    } else {
      M_walkmove(self, self.s.angles[YAW], dist);
    }
  }

  // [Paril-KEX] if our enemy is literally right next to us, give us more
  // rotational speed so we don't get circled
  if (range_to(self, self.enemy) <= RANGE_MELEE * 2.5) M_ChangeYaw(self);
}

// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_turn(self: EdictT, dist: number): void {
  if (dist !== 0 || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n) {
    M_walkmove(self, self.s.angles[YAW], dist);
  }

  if (FindTarget(self)) return;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);
}

// ---------------------------------------------------------------------------
// range_to / visible / infront (g_ai.cpp:368-464)
// ---------------------------------------------------------------------------

export function range_to(self: EdictT, other: EdictT): number {
  return distance_between_boxes(self.absmin, self.absmax, other.absmin, other.absmax);
}

/** g_local.h:2307: `through_glass` defaults to `true` -- see file header. */
export function visible(self: EdictT, other: EdictT, through_glass: boolean = true): boolean {
  // never visible
  if ((other.flags & EntFlagsT.FL_NOVISIBLE) !== 0n) return false;

  // [Paril-KEX] bit of a hack, but we'll tweak monster-player visibility if
  // they have the invisibility powerup.
  if (other.client !== null) {
    // always visible in rtest
    if ((self.hackflags & HACKFLAG_ATTACK_PLAYER) !== 0) return self.inuse;

    // fix intermission
    if (other.solid === SolidT.SOLID_NOT) return false;

    if (other.client.invisible_time > level.time) {
      // can't see us at all after this time
      if (other.client.invisibility_fade_time <= level.time) return false;

      // otherwise, throw in some randomness
      if (frandom() > other.s.alpha) return false;
    }
  }

  const spot1 = copyVec3(self.s.origin);
  spot1[2] += self.viewheight;
  const spot2 = copyVec3(other.s.origin);
  spot2[2] += other.viewheight;

  // MASK_OPAQUE = CONTENTS_SOLID | CONTENTS_SLIME | CONTENTS_LAVA (no
  // CONTENTS_WINDOW) -- computed explicitly rather than imported, since
  // kexapi/game.ts's own MASK_OPAQUE constant isn't in this file's import
  // list; recomputed to the exact same bits.
  let mask: ContentsT = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA;

  if (!through_glass) mask |= ContentsT.CONTENTS_WINDOW;

  const trace = giTraceline(spot1, spot2, self, mask);
  return trace.fraction === 1.0 || edictFrom(trace.ent) === other; // PGM
}

export function infront(self: EdictT, other: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const vec = vec3_normalized(vec3_sub(other.s.origin, self.s.origin));
  const dot = vec3_dot(vec, forward);

  // [Paril-KEX] if we're an ambush monster, reduce our cone of vision to
  // not ruin surprises, unless we already had an enemy.
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH) && !Gtime_nonzero(self.monsterinfo.trail_time) && self.enemy === null) {
    return dot > 0.15;
  }

  return dot > -0.3;
}

// ---------------------------------------------------------------------------
// HuntTarget / FoundTarget (g_ai.cpp:468-550)
// ---------------------------------------------------------------------------

export function HuntTarget(self: EdictT, animate_state: boolean = true): void {
  self.goalentity = self.enemy;

  if (animate_state) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
      if (self.monsterinfo.stand === null) throw new Error(`HuntTarget: monsterinfo.stand is null for ${self.classname ?? "?"}`);
      self.monsterinfo.stand(self);
    } else {
      if (self.monsterinfo.run === null) throw new Error(`HuntTarget: monsterinfo.run is null for ${self.classname ?? "?"}`);
      self.monsterinfo.run(self);
    }
  }

  if (self.enemy === null) throw new Error(`HuntTarget: self.enemy is null for ${self.classname ?? "?"}`);
  const vec = vec3_sub(self.enemy.s.origin, self.s.origin);
  self.ideal_yaw = vectoyaw(vec);
}

export function FoundTarget(self: EdictT): void {
  if (self.enemy === null) throw new Error(`FoundTarget: self.enemy is null for ${self.classname ?? "?"}`);
  const enemy = self.enemy;

  // let other monsters see this monster for a while
  if (enemy.client !== null) {
    if ((enemy.flags & EntFlagsT.FL_DISGUISED) !== 0n) enemy.flags &= ~EntFlagsT.FL_DISGUISED;

    enemy.client.sight_entity = self;
    enemy.client.sight_entity_time = level.time;

    enemy.show_hostile = Gtime_add(level.time, Gtime_from_sec(1)); // wake up other monsters
  }

  // [Paril-KEX] the first time we spot something, give us a bit of a grace
  // period on firing
  if (!Gtime_nonzero(self.monsterinfo.trail_time)) {
    self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_ms(600));
  }

  // give easy/medium a little more reaction time
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  self.monsterinfo.attack_finished = Gtime_add(
    self.monsterinfo.attack_finished,
    skillInt === 0 ? Gtime_from_ms(400) : skillInt === 1 ? Gtime_from_ms(200) : GTIME_ZERO,
  );

  self.monsterinfo.last_sighting = copyVec3(enemy.s.origin);
  self.monsterinfo.saved_goal = copyVec3(enemy.s.origin);
  self.monsterinfo.trail_time = level.time;
  self.monsterinfo.blind_fire_target = vec3_add(self.monsterinfo.last_sighting, vec3_muls(enemy.velocity, -0.1));
  self.monsterinfo.blind_fire_delay = GTIME_ZERO;
  // [Paril-KEX] for alternate fly, pick a new position immediately
  self.monsterinfo.fly_position_time = GTIME_ZERO;

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_THIRD_EYE;

  // Paril: if we're heading to a combat point/path corner, don't hunt the
  // new target yet.
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_COMBAT_POINT) !== 0n) return;

  if (self.combattarget === null) {
    HuntTarget(self);
    return;
  }

  self.goalentity = self.movetarget = G_PickTarget(self.combattarget);
  if (self.movetarget === null) {
    self.goalentity = self.movetarget = enemy;
    HuntTarget(self);
    gi.Com_Print(`${formatEdictForPrint(self)}: combattarget ${self.combattarget} not found\n`);
    return;
  }

  // clear out our combattarget, these are a one shot deal
  self.combattarget = null;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_COMBAT_POINT;

  self.monsterinfo.pausetime = GTIME_ZERO;

  // run for it
  if (self.monsterinfo.run === null) throw new Error(`FoundTarget: monsterinfo.run is null for ${self.classname ?? "?"}`);
  self.monsterinfo.run(self);
}

// ---------------------------------------------------------------------------
// AI_GetMonsterAlertedByPlayers / AI_GetSoundClient / G_MonsterSourceVisible
// (g_ai.cpp:552-630)
// ---------------------------------------------------------------------------

export function AI_GetMonsterAlertedByPlayers(self: EdictT): EdictT | null {
  for (const player of activePlayers()) {
    if (player.health <= 0 || player.deadflag || player.solid === SolidT.SOLID_NOT) continue;
    if (player.client === null) continue;

    if (player.client.sight_entity === null || !(player.client.sight_entity_time >= Gtime_subtract(level.time, frameTimeAsGtime()))) {
      continue;
    }

    if (!visible(self, player.client.sight_entity)) continue;

    return player.client.sight_entity;
  }

  return null;
}

export function AI_GetSoundClient(self: EdictT, direct: boolean): EdictT | null {
  let best_sound: EdictT | null = null;
  let best_distance = Number.MAX_VALUE;

  for (const player of activePlayers()) {
    if (player.health <= 0 || player.deadflag || player.solid === SolidT.SOLID_NOT) continue;
    if (player.client === null) continue;

    const sound = direct ? player.client.sound_entity : player.client.sound2_entity;
    if (sound === null) continue;

    const time = direct ? player.client.sound_entity_time : player.client.sound2_entity_time;
    if (!(time >= Gtime_subtract(level.time, frameTimeAsGtime()))) continue;

    const dist = vec3_length(vec3_sub(self.s.origin, sound.s.origin));

    if (best_sound === null || dist < best_distance) {
      best_distance = dist;
      best_sound = sound;
    }
  }

  return best_sound;
}

export function G_MonsterSourceVisible(self: EdictT, client: EdictT): boolean {
  // this is where we would check invisibility
  const r = range_to(self, client);

  if (r > RANGE_MID) return false;

  // Paril: revised so that monsters can be woken up by players 'seen' and
  // attacked at by other monsters if they are close enough. they don't have
  // to be visible.
  return (
    (r <= RANGE_NEAR && client.show_hostile >= level.time && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH)) ||
    (visible(self, client) && (r <= RANGE_MELEE || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_THIRD_EYE) !== 0n || infront(self, client)))
  );
}

// ---------------------------------------------------------------------------
// FindTarget (g_ai.cpp:632-885)
// ---------------------------------------------------------------------------

export function FindTarget(self: EdictT): boolean {
  let heardit = false;
  let ignore_sight_sound = false;

  // [Paril-KEX] if we're in a level transition, don't worry about enemies
  if ((globals.server_flags & ServerFlagsT.SERVER_FLAG_LOADING) !== 0) return false;

  // N64 cutscene behavior
  if ((self.hackflags & HACKFLAG_END_CUTSCENE) !== 0) return false;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) {
    if (self.goalentity !== null && self.goalentity.inuse && self.goalentity.classname === "target_actor") {
      return false;
    }
    // FIXME look for monsters?
    return false;
  }

  // if we're going to a combat point, just proceed
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_COMBAT_POINT) !== 0n) return false;

  // Paril: revised so that monsters will first try to consider the current
  // sight client immediately if they can see it. this fixes them dancing in
  // front of you if you fire every frame.
  let client: EdictT | null = AI_GetSightClient(self);
  if (client !== null) {
    if (client === self.enemy) return false;
  }

  // check indirect sources
  if (client === null) {
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH)) {
      const alerted = AI_GetMonsterAlertedByPlayers(self);
      if (alerted !== null) client = alerted;
    }

    if (client !== null) {
      // KEX_FIXME: when does this happen?
      // [Paril-KEX] adjusted to clear the client so we can try other things
      if (client.enemy === self.enemy || !G_MonsterSourceVisible(self, client)) {
        client = null;
      }
    }

    if (client === null) {
      if (level.disguise_violation_time > level.time) {
        client = level.disguise_violator;
      } else {
        const soundDirect = AI_GetSoundClient(self, true);
        if (soundDirect !== null) {
          client = soundDirect;
          heardit = true;
        } else if (self.enemy === null && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH)) {
          const soundIndirect = AI_GetSoundClient(self, false);
          if (soundIndirect !== null) {
            client = soundIndirect;
            heardit = true;
          }
        }
      }
    }
  }

  if (client === null) return false; // no clients to get mad at

  // if the entity went away, forget it
  if (!client.inuse) return false;

  if (client === self.enemy) {
    let skip_found = true;

    // [Paril-KEX] slight special behavior if we are currently going to a
    // sound and we hear a new one; because player noises are re-used, this
    // can leave us with the "same" enemy even though it's a different noise.
    if (heardit && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) !== 0n) {
      const temp = vec3_sub(client.s.origin, self.s.origin);
      self.ideal_yaw = vectoyaw(temp);

      if (!FacingIdeal(self)) skip_found = false;
      else if (!SV_CloseEnough(self, client, 8)) skip_found = false;

      if (!skip_found && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TEMP_STAND_GROUND) !== 0n) {
        self.monsterinfo.aiflags &= ~(MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_TEMP_STAND_GROUND);
      }
    }

    if (skip_found) return true; // JDC false;
  }

  // ROGUE - hintpath coop fix
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HINT_PATH) !== 0n && coopEnabled()) heardit = false;

  if ((client.svflags & SvflagsT.SVF_MONSTER) !== 0) {
    if (client.enemy === null) return false;
    if ((client.enemy.flags & EntFlagsT.FL_NOTARGET) !== 0n) return false;
  } else if (heardit) {
    // pgm - a little more paranoia won't hurt....
    if (client.owner !== null && (client.owner.flags & EntFlagsT.FL_NOTARGET) !== 0n) return false;
  } else if (client.client === null) {
    return false;
  }

  if (!heardit) {
    // this is where we would check invisibility
    const r = range_to(self, client);

    if (r > RANGE_MID) return false;

    // Paril: revised so that monsters can be woken up by players 'seen' and
    // attacked at by other monsters if they are close enough. they don't
    // have to be visible.
    const is_visible =
      (r <= RANGE_NEAR && client.show_hostile >= level.time && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH)) ||
      (visible(self, client) && (r <= RANGE_MELEE || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_THIRD_EYE) !== 0n || infront(self, client)));

    if (!is_visible) return false;

    self.enemy = client;

    if (self.enemy.classname !== "player_noise") {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_SOUND_TARGET;

      if (self.enemy.client === null) {
        self.enemy = self.enemy.enemy;
        if (self.enemy === null || self.enemy.client === null) {
          self.enemy = null;
          return false;
        }
      }
    }

    if (
      self.enemy.client !== null &&
      self.enemy.client.invisible_time > level.time &&
      self.enemy.client.invisibility_fade_time <= level.time
    ) {
      self.enemy = null;
      return false;
    }

    if (self.monsterinfo.close_sight_tripped) {
      ignore_sight_sound = true;
    } else {
      self.monsterinfo.close_sight_tripped = true;
    }
  } else {
    // heardit
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH)) {
      if (!visible(self, client)) return false;
    } else {
      if (!gi.inPHS(self.s.origin, client.s.origin, true)) return false;
    }

    const temp = vec3_sub(client.s.origin, self.s.origin);

    if (vec3_length(temp) > 1000) return false; // too far to hear

    // check area portals - if they are different and not connected then we
    // can't hear it
    if (client.areanum !== self.areanum) {
      if (!gi.AreasConnected(self.areanum, client.areanum)) return false;
    }

    self.ideal_yaw = vectoyaw(temp);
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);

    // hunt the sound for a bit; hopefully find the real player
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_SOUND_TARGET;
    self.enemy = client;
  }

  //
  // got one
  //
  // ROGUE - if we got an enemy, we need to bail out of hint paths, so take
  // over here
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HINT_PATH) !== 0n) {
    rogueNewaiMod().hintpath_stop(self); // this calls foundtarget for us
  } else {
    FoundTarget(self);
  }

  // ROGUE
  if (
    (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) === 0n &&
    self.monsterinfo.sight !== null &&
    // Paril: adjust to prevent monsters getting stuck in sight loops
    !ignore_sight_sound
  ) {
    if (self.enemy === null) throw new Error(`FindTarget: self.enemy is null before sight callback for ${self.classname ?? "?"}`);
    self.monsterinfo.sight(self, self.enemy);
  }

  return true;
}

// ---------------------------------------------------------------------------
// FacingIdeal (g_ai.cpp:889-903)
// ---------------------------------------------------------------------------

export function FacingIdeal(self: EdictT): boolean {
  const delta = anglemod(self.s.angles[YAW] - self.ideal_yaw);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) !== 0n) return !(delta > 5 && delta < 355);

  return !(delta > 45 && delta < 315);
}

// ---------------------------------------------------------------------------
// M_CheckAttack_Base / M_CheckAttack (g_ai.cpp:907-1096)
// ---------------------------------------------------------------------------

// [Paril-KEX] split this out so we can use it for the other bosses
export function M_CheckAttack_Base(
  self: EdictT,
  stand_ground_chance: number,
  melee_chance: number,
  near_chance: number,
  mid_chance: number,
  far_chance: number,
  strafe_scalar: number,
): boolean {
  if (self.enemy === null) throw new Error(`M_CheckAttack_Base: self.enemy is null for ${self.classname ?? "?"}`);
  const enemy = self.enemy;

  if ((enemy.flags & EntFlagsT.FL_NOVISIBLE) !== 0n) return false;

  if (enemy.health > 0) {
    if (enemy.client !== null) {
      if (enemy.client.invisible_time > level.time) {
        // can't see us at all after this time
        if (enemy.client.invisibility_fade_time <= level.time) return false;
      }
    }

    const spot1 = copyVec3(self.s.origin);
    spot1[2] += self.viewheight;

    let tr: KexTraceT;
    // see if any entities are in the way of the shot
    if (enemy.client === null || enemy.solid !== SolidT.SOLID_NOT) {
      const spot2 = copyVec3(enemy.s.origin);
      spot2[2] += enemy.viewheight;

      tr = giTraceline(
        spot1,
        spot2,
        self,
        MASK_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA,
      );
    } else {
      // deterministic stand-in for the C++ source's uninitialized `trace_t
      // tr;` with only `.ent`/`.fraction` set -- see file header's Vec3/
      // trace conventions note. Nothing downstream reads any other field of
      // this particular `tr` before it is either used (ent/fraction only)
      // or overwritten by a fresh `gi.traceline` call in the blindfire
      // branch below.
      tr = {
        allsolid: false,
        startsolid: false,
        fraction: 0,
        endpos: copyVec3(spot1),
        plane: new CplaneT(),
        surface: null,
        contents: ContentsT.CONTENTS_NONE,
        ent: null, // world
        plane2: new CplaneT(),
        surface2: null,
      };
    }

    // do we have a clear shot?
    const trEnt = edictFrom(tr.ent);
    if ((self.hackflags & HACKFLAG_ATTACK_PLAYER) === 0 && trEnt !== enemy && (trEnt.svflags & SvflagsT.SVF_PLAYER) === 0) {
      // ROGUE - we want them to go ahead and shoot at info_notnulls if they
      // can.
      if (enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) {
        // PMM - if we can't see our target, and we're not blocked by a
        // monster, go into blind fire if available. Paril - *and* we have
        // at least seen them once
        if ((trEnt.svflags & SvflagsT.SVF_MONSTER) === 0 && !visible(self, enemy) && self.monsterinfo.had_visibility) {
          if (self.monsterinfo.blindfire && self.monsterinfo.blind_fire_delay <= Gtime_from_sec(20)) {
            if (level.time < self.monsterinfo.attack_finished) {
              // ROGUE
              return false;
            }
            // ROGUE
            if (level.time < Gtime_add(self.monsterinfo.trail_time, self.monsterinfo.blind_fire_delay)) {
              // wait for our time
              return false;
            }
            // make sure we're not going to shoot a monster
            const tr2 = giTraceline(spot1, self.monsterinfo.blind_fire_target, self, ContentsT.CONTENTS_MONSTER);
            if (tr2.allsolid || tr2.startsolid || (tr2.fraction < 1.0 && edictFrom(tr2.ent) !== enemy)) return false;

            self.monsterinfo.attack_state = MonsterAttackStateT.AS_BLIND;
            return true;
          }
        }
        // pmm
        return false;
      }
    }
  }
  // ROGUE

  const enemy_range = range_to(self, enemy);

  // melee attack
  if (enemy_range <= RANGE_MELEE) {
    if (self.monsterinfo.melee !== null && self.monsterinfo.melee_debounce_time <= level.time) {
      self.monsterinfo.attack_state = MonsterAttackStateT.AS_MELEE;
    } else {
      self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    }
    return true;
  }

  // if we were in melee just before this but we're too far away, get out of
  // melee state now
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_MELEE && self.monsterinfo.melee_debounce_time > level.time) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
  }

  // missile attack
  if (self.monsterinfo.attack === null) {
    // ROGUE - fix for melee only monsters & strafing
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
    // ROGUE
    return false;
  }

  if (level.time < self.monsterinfo.attack_finished) return false;

  let chance: number;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    chance = stand_ground_chance;
  } else if (enemy_range <= RANGE_MELEE) {
    chance = melee_chance;
  } else if (enemy_range <= RANGE_NEAR) {
    chance = near_chance;
  } else if (enemy_range <= RANGE_MID) {
    chance = mid_chance;
  } else {
    chance = far_chance;
  }

  // PGM - go ahead and shoot every time if it's a info_notnull
  if ((enemy.client === null && enemy.solid === SolidT.SOLID_NOT) || frandom() < chance) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    self.monsterinfo.attack_finished = level.time;
    return true;
  }

  // ROGUE - daedalus should strafe more .. this can be done here or in a
  // customized check_attack code for the hover.
  if ((self.flags & EntFlagsT.FL_FLY) !== 0n) {
    if (self.monsterinfo.strafe_check_time <= level.time) {
      // originally, just 0.3
      let strafe_chance = self.classname === "monster_daedalus" ? 0.8 : 0.6;

      // if enemy is tesla, never strafe
      if (enemy.classname === "tesla_mine") {
        strafe_chance = 0;
      } else {
        strafe_chance *= strafe_scalar;
      }

      if (strafe_chance !== 0) {
        let new_state = MonsterAttackStateT.AS_STRAIGHT;

        if (frandom() < strafe_chance) new_state = MonsterAttackStateT.AS_SLIDING;

        if (new_state !== self.monsterinfo.attack_state) {
          self.monsterinfo.strafe_check_time = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(3)));
          self.monsterinfo.attack_state = new_state;
        }
      }
    }
  }
  // do we want the monsters strafing?
  // [Paril-KEX] no, we don't
  // [Paril-KEX] if we're pathing, don't immediately reset us to straight;
  // this allows us to turn to fire and not jerk back and forth.
  else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) === 0n) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  }
  // ROGUE

  return false;
}

/** SAVE_FUNC_MONSTERINFO_CHECKATTACK("M_CheckAttack") -- see file header
 *  (this is the stub swap for g_monster.ts's former local stub of the same
 *  registered name). */
export const M_CheckAttack: MonsterinfoCheckattackFn = RegisterMonsterinfoCheckattack("M_CheckAttack", (self: EdictT): boolean => {
  return M_CheckAttack_Base(self, 0.7, 0.4, 0.25, 0.06, 0, 1.0);
});

// ---------------------------------------------------------------------------
// ai_run_melee / ai_run_missile / ai_run_slide / ai_checkattack / ai_run
// (g_ai.cpp:1098-1808)
// ---------------------------------------------------------------------------

export function ai_run_melee(self: EdictT): void {
  self.ideal_yaw = enemy_yaw;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);

  if (FacingIdeal(self)) {
    if (self.monsterinfo.melee === null) throw new Error(`ai_run_melee: monsterinfo.melee is null for ${self.classname ?? "?"}`);
    self.monsterinfo.melee(self);
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  }
}

export function ai_run_missile(self: EdictT): void {
  self.ideal_yaw = enemy_yaw;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);

  if (FacingIdeal(self)) {
    if (self.monsterinfo.attack !== null) {
      self.monsterinfo.attack(self);
      self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(2)));
    }

    // ROGUE
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_MISSILE || self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
      // ROGUE
      self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
    }
  }
}

// ROGUE
// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_run_slide(self: EdictT, distance: number): void {
  let dist = distance;

  self.ideal_yaw = enemy_yaw;

  const angle = 90;
  const ofs = self.monsterinfo.lefty ? angle : -angle;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);

  // PMM - clamp maximum sideways move for non flyers to make them look less
  // jerky
  if ((self.flags & EntFlagsT.FL_FLY) === 0n) {
    dist = Math.min(dist, MAX_SIDESTEP / (gi.frame_time_ms / 10));
  }
  if (M_walkmove(self, self.ideal_yaw + ofs, dist)) return;
  // PMM - if we're dodging, give up on it and go straight
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DODGING) !== 0n) {
    monster_done_dodge(self);
    // by setting as_straight, caller will know to try straight move
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
    return;
  }

  self.monsterinfo.lefty = !self.monsterinfo.lefty;
  if (M_walkmove(self, self.ideal_yaw - ofs, dist)) return;
  // PMM - if we're dodging, give up on it and go straight
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DODGING) !== 0n) monster_done_dodge(self);

  // PMM - the move failed, so signal the caller (ai_run) to try going
  // straight
  self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
}
// ROGUE

/** `dist` is genuinely unused in the C++ body -- see file header. */
export function ai_checkattack(self: EdictT, _dist: number): boolean {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TEMP_STAND_GROUND) !== 0n) {
    self.monsterinfo.aiflags &= ~(MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_TEMP_STAND_GROUND);
  }

  // this causes monsters to run blindly to the combat point w/o firing
  if (self.goalentity !== null) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_COMBAT_POINT) !== 0n) {
      if (self.enemy !== null && range_to(self, self.enemy) > 100) return false;
    }

    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) !== 0n) {
      if (self.enemy === null) {
        throw new Error(`ai_checkattack: AI_SOUND_TARGET set with goalentity but self.enemy is null for ${self.classname ?? "?"}`);
      }
      if (Gtime_subtract(level.time, self.enemy.teleport_time) > Gtime_from_sec(5)) {
        if (self.goalentity === self.enemy) {
          self.goalentity = self.movetarget !== null ? self.movetarget : null;
        }
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_SOUND_TARGET;
      } else {
        self.enemy.show_hostile = Gtime_add(level.time, Gtime_from_sec(1));
        return false;
      }
    }
  }

  enemy_vis = false;

  // see if the enemy is dead
  let hesDeadJim = false;
  if (self.enemy === null || !self.enemy.inuse) {
    hesDeadJim = true;
  } else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_FORGET_ENEMY) !== 0n) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_FORGET_ENEMY;
    hesDeadJim = true;
  } else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    if (!self.enemy.inuse || self.enemy.health > 0) hesDeadJim = true;
  } else {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_BRUTAL) === 0n) {
      if (self.enemy.health <= 0) hesDeadJim = true;
    }

    // [Paril-KEX] if our enemy was invisible, lose sight now
    if (
      self.enemy.client !== null &&
      self.enemy.client.invisible_time > level.time &&
      self.enemy.client.invisibility_fade_time <= level.time &&
      (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PURSUE_NEXT) !== 0n
    ) {
      hesDeadJim = true;
    }
  }

  if (hesDeadJim && (self.hackflags & HACKFLAG_ATTACK_PLAYER) === 0) {
    // ROGUE
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
    // ROGUE
    self.enemy = null;
    self.goalentity = null;
    self.monsterinfo.close_sight_tripped = false;
    // FIXME: look all around for other targets
    if (self.oldenemy !== null && self.oldenemy.health > 0) {
      self.enemy = self.oldenemy;
      self.oldenemy = null;
      HuntTarget(self);
    }
    // ROGUE - multiple teslas make monsters lose track of the player.
    else if (self.monsterinfo.last_player_enemy !== null && self.monsterinfo.last_player_enemy.health > 0) {
      self.enemy = self.monsterinfo.last_player_enemy;
      self.oldenemy = null;
      self.monsterinfo.last_player_enemy = null;
      HuntTarget(self);
    }
    // ROGUE
    else {
      if (self.movetarget !== null && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n) {
        self.goalentity = self.movetarget;
        if (self.monsterinfo.walk === null) throw new Error(`ai_checkattack: monsterinfo.walk is null for ${self.classname ?? "?"}`);
        self.monsterinfo.walk(self);
      } else {
        // we need the pausetime otherwise the stand code will just revert
        // to walking with no target and the monsters will wonder around
        // aimlessly trying to hunt the world entity
        self.monsterinfo.pausetime = HOLD_FOREVER;
        if (self.monsterinfo.stand === null) throw new Error(`ai_checkattack: monsterinfo.stand is null for ${self.classname ?? "?"}`);
        self.monsterinfo.stand(self);

        if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TEMP_STAND_GROUND) !== 0n) {
          self.monsterinfo.aiflags &= ~(MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_TEMP_STAND_GROUND);
        }
      }
      return true;
    }
  }

  if (self.enemy === null) {
    throw new Error(`ai_checkattack: self.enemy is null past the hesDeadJim gate for ${self.classname ?? "?"}`);
  }

  // check knowledge of enemy
  enemy_vis = visible(self, self.enemy);
  if (enemy_vis) {
    self.monsterinfo.had_visibility = true;
    self.enemy.show_hostile = Gtime_add(level.time, Gtime_from_sec(1)); // wake up other monsters
    self.monsterinfo.search_time = Gtime_add(level.time, Gtime_from_sec(5));
    self.monsterinfo.last_sighting = copyVec3(self.enemy.s.origin);
    self.monsterinfo.saved_goal = copyVec3(self.enemy.s.origin);
    // ROGUE
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) !== 0n) {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;

      if (self.monsterinfo.move_block_change_time < level.time) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT;
      }
    }
    self.monsterinfo.trail_time = level.time;
    self.monsterinfo.blind_fire_target = vec3_add(self.monsterinfo.last_sighting, vec3_muls(self.enemy.velocity, -0.1));
    self.monsterinfo.blind_fire_delay = GTIME_ZERO;
    // ROGUE
  }

  enemy_infront = infront(self, self.enemy);
  const temp = vec3_sub(self.enemy.s.origin, self.s.origin);
  enemy_yaw = vectoyaw(temp);

  // PMM -- reordered so the monster specific checkattack is called before
  // the run_missle/melee/checkvis stuff .. this allows for, among other
  // things, circle strafing and attacking while in ai_run
  let retval = false;

  if (self.monsterinfo.checkattack_time <= level.time) {
    self.monsterinfo.checkattack_time = Gtime_add(level.time, Gtime_from_ms(100));
    if (self.monsterinfo.checkattack === null) {
      throw new Error(`ai_checkattack: monsterinfo.checkattack is null for ${self.classname ?? "?"}`);
    }
    retval = self.monsterinfo.checkattack(self);
  }

  if (retval || self.monsterinfo.attack_state >= MonsterAttackStateT.AS_MISSILE) {
    // PMM
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_MISSILE) {
      ai_run_missile(self);
      return true;
    }
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_MELEE) {
      ai_run_melee(self);
      return true;
    }
    // PMM -- added so monsters can shoot blind
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
      ai_run_missile(self);
      return true;
    }
    // pmm

    // if enemy is not currently visible, we will never attack
    if (!enemy_vis) return false;
    // PMM
  }

  return retval;
  // PMM
}

// hoisted `function` (not const arrow): monster frame tables read these
// at module top level inside import cycles -- function declarations are
// TDZ-immune regardless of evaluation order (satisfies MframeAifuncFn).
export function ai_run(self: EdictT, distArg: number): void {
  let dist = distArg;
  let alreadyMoved = false;
  let gotcha = false;

  // if we're going to a combat point, just proceed
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_COMBAT_POINT) !== 0n) {
    ai_checkattack(self, dist);
    M_MoveToGoal(self, dist);

    if (self.movetarget !== null) {
      // nb: this is done from the centroid and not viewheight on purpose;
      const centroid = vec3_muls(vec3_add(self.absmax, self.absmin), 0.5);
      const tr = gi.trace(centroid, vec3(-2, -2, -2), vec3(2, 2, 2), self.movetarget.s.origin, self, ContentsT.CONTENTS_SOLID);

      // [Paril-KEX] special case: if we're stand ground & knocked way too
      // far away from our path_corner, or we can't see it any more, assume
      // all is lost.
      if (
        (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_REACHED_HOLD_COMBAT) !== 0n &&
        (vec3_length(vec3_sub(closest_point_to_box(self.movetarget.s.origin, self.absmin, self.absmax), self.movetarget.s.origin)) > 160 ||
          (tr.fraction < 1.0 && tr.plane.normal[2] <= 0.7)) // if we hit a climbable, ignore this result
      ) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_COMBAT_POINT;
        self.movetarget = null;
        self.target = null;
        self.goalentity = self.enemy;
      } else {
        return;
      }
    } else {
      return;
    }
  }

  // PMM
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n && self.monsterinfo.unduck !== null) {
    self.monsterinfo.unduck(self);
  }

  //==========
  // PGM
  // if we're currently looking for a hint path
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HINT_PATH) !== 0n) {
    // determine direction to our destination hintpath.
    M_MoveToGoal(self, dist);
    if (!self.inuse) return;

    // first off, make sure we're looking for the player, not a noise he made
    let realEnemy: EdictT;
    if (self.enemy !== null) {
      if (self.enemy.inuse) {
        if (self.enemy.classname !== "player_noise") {
          realEnemy = self.enemy;
        } else if (self.enemy.owner !== null) {
          realEnemy = self.enemy.owner;
        } else {
          // uh oh, can't figure out enemy, bail
          self.enemy = null;
          rogueNewaiMod().hintpath_stop(self);
          return;
        }
      } else {
        self.enemy = null;
        rogueNewaiMod().hintpath_stop(self);
        return;
      }
    } else {
      rogueNewaiMod().hintpath_stop(self);
      return;
    }

    if (coopEnabled()) {
      // if we're in coop, check my real enemy first .. if I SEE him, set
      // gotcha to true
      if (self.enemy !== null && visible(self, realEnemy)) {
        gotcha = true;
      } else {
        // otherwise, let FindTarget bump us out of hint paths, if
        // appropriate
        FindTarget(self);
      }
    } else {
      if (self.enemy !== null && visible(self, realEnemy)) gotcha = true;
    }

    // if we see the player, stop following hintpaths.
    if (gotcha) {
      // disconnect from hintpaths and start looking normally for players.
      rogueNewaiMod().hintpath_stop(self);
    }

    return;
  }
  // PGM
  //==========

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) !== 0n) {
    // PMM - paranoia checking
    // (`v = self->s.origin - self->enemy->s.origin;` in the C++ source is a
    // dead store -- computed but never read afterward; not ported)

    // the C++ source dereferences `self->enemy` unconditionally here (via
    // SV_CloseEnough) even though the very next line checks `!self->enemy`
    // -- an implicit non-null invariant, never actually violated in real
    // play since AI_SOUND_TARGET is only ever set together with a non-null
    // self.enemy. Ported as an explicit throw, not a silent narrow.
    if (self.enemy === null) {
      throw new Error(`ai_run: AI_SOUND_TARGET set but self.enemy is null for ${self.classname ?? "?"}`);
    }
    const soundEnemy = self.enemy;

    const touching_noise = SV_CloseEnough(self, soundEnemy, dist * (gi.tick_rate / 10));

    if (touching_noise && FacingIdeal(self)) {
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_TEMP_STAND_GROUND;
      self.s.angles[YAW] = self.ideal_yaw;
      if (self.monsterinfo.stand === null) throw new Error(`ai_run: monsterinfo.stand is null for ${self.classname ?? "?"}`);
      self.monsterinfo.stand(self);
      self.monsterinfo.close_sight_tripped = false;
      return;
    }

    // if we're close to the goal, just turn
    if (touching_noise) M_ChangeYaw(self);
    else M_MoveToGoal(self, dist);

    // ROGUE - prevent double moves for sound_targets
    alreadyMoved = true;

    if (!self.inuse) return; // PGM - g_touchtrigger free problem
    // ROGUE

    if (!FindTarget(self)) return;
  }

  // PMM -- moved ai_checkattack up here so the monsters can attack while
  // strafing or charging

  // PMM -- if we're dodging, make sure to keep the attack_state AS_SLIDING
  const retval = ai_checkattack(self, dist);

  // PMM - don't strafe if we can't see our enemy
  if (!enemy_vis && self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  }
  // unless we're dodging (dodging out of view looks smart)
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DODGING) !== 0n) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;
  }
  // pmm

  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) {
    // PMM - protect against double moves
    if (!alreadyMoved) ai_run_slide(self, dist);
    // PMM
    // we're using attack_state as the return value out of ai_run_slide to
    // indicate whether or not the move succeeded. If the move succeeded,
    // and we're still sliding, we're done in here (since we've had our
    // chance to shoot in ai_checkattack, and have moved). if the move
    // failed, our state is as_straight, and it will be taken care of below
    if (!retval && self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) return;
  } else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_CHARGING) !== 0n) {
    self.ideal_yaw = enemy_yaw;
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) M_ChangeYaw(self);
  }
  if (retval) {
    // PMM - is this useful? Monsters attacking usually call the ai_charge
    // routine.. the only monster this affects should be the soldier
    if (
      (dist !== 0 || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n) &&
      !alreadyMoved &&
      self.monsterinfo.attack_state === MonsterAttackStateT.AS_STRAIGHT &&
      (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n
    ) {
      M_MoveToGoal(self, dist);
    }
    if (self.enemy !== null && self.enemy.inuse && enemy_vis) {
      if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) !== 0n) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;

        if (self.monsterinfo.move_block_change_time < level.time) {
          self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT;
        }
      }
      self.monsterinfo.last_sighting = copyVec3(self.enemy.s.origin);
      self.monsterinfo.saved_goal = copyVec3(self.enemy.s.origin);
      self.monsterinfo.trail_time = level.time;
      // PMM
      self.monsterinfo.blind_fire_target = vec3_add(self.monsterinfo.last_sighting, vec3_muls(self.enemy.velocity, -0.1));
      self.monsterinfo.blind_fire_delay = GTIME_ZERO;
      // pmm
    }
    return;
  }
  // PMM

  // PGM - added a little paranoia checking here... 9/22/98
  if (self.enemy !== null && self.enemy.inuse && enemy_vis) {
    // PMM - check for alreadyMoved
    if (!alreadyMoved) M_MoveToGoal(self, dist);
    if (!self.inuse) return; // PGM - g_touchtrigger free problem

    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) !== 0n) {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;

      if (self.monsterinfo.move_block_change_time < level.time) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT;
      }
    }
    self.monsterinfo.last_sighting = copyVec3(self.enemy.s.origin);
    self.monsterinfo.saved_goal = copyVec3(self.enemy.s.origin);
    self.monsterinfo.trail_time = level.time;
    // PMM
    self.monsterinfo.blind_fire_target = vec3_add(self.monsterinfo.last_sighting, vec3_muls(self.enemy.velocity, -0.1));
    self.monsterinfo.blind_fire_delay = GTIME_ZERO;
    // pmm

    // [Paril-KEX] if our enemy is literally right next to us, give us more
    // rotational speed so we don't get circled
    if (range_to(self, self.enemy) <= RANGE_MELEE * 2.5) M_ChangeYaw(self);

    return;
  }

  //=======
  // PGM
  // if we've been looking (unsuccessfully) for the player for 10 seconds
  // PMM - reduced to 5, makes them much nastier
  if (Gtime_add(self.monsterinfo.trail_time, Gtime_from_sec(5)) <= level.time) {
    // and we haven't checked for valid hint paths in the last 10 seconds
    if (Gtime_add(self.monsterinfo.last_hint_time, Gtime_from_sec(10)) <= level.time) {
      // check for hint_paths.
      self.monsterinfo.last_hint_time = level.time;
      if (rogueNewaiMod().monsterlost_checkhint(self)) return;
    }
  }
  // PGM
  //=======

  // PMM - moved down here to allow monsters to get on hint paths
  // coop will change to another enemy if visible
  if (coopEnabled()) FindTarget(self);
  // pmm

  if (Gtime_nonzero(self.monsterinfo.search_time) && level.time > Gtime_add(self.monsterinfo.search_time, Gtime_from_sec(20))) {
    // PMM - double move protection
    if (!alreadyMoved) M_MoveToGoal(self, dist);
    self.monsterinfo.search_time = GTIME_ZERO;
    return;
  }

  const save = self.goalentity;
  const tempgoal = G_Spawn();
  self.goalentity = tempgoal;

  let newEnemy = false;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) === 0n) {
    // just lost sight of the player, decide where to go first
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_LOST_SIGHT | MonsterAiFlagsT.AI_PURSUIT_LAST_SEEN;
    self.monsterinfo.aiflags &= ~(MonsterAiFlagsT.AI_PURSUE_NEXT | MonsterAiFlagsT.AI_PURSUE_TEMP);
    newEnemy = true;

    // immediately try paths
    self.monsterinfo.path_blocked_counter = GTIME_ZERO;
    self.monsterinfo.path_wait_time = GTIME_ZERO;
  }

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PURSUE_NEXT) !== 0n) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_PURSUE_NEXT;

    // give ourself more time since we got this far
    self.monsterinfo.search_time = Gtime_add(level.time, Gtime_from_sec(5));

    let marker: EdictT | null;
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PURSUE_TEMP) !== 0n) {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_PURSUE_TEMP;
      marker = null;
      self.monsterinfo.last_sighting = copyVec3(self.monsterinfo.saved_goal);
      newEnemy = true;
    } else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PURSUIT_LAST_SEEN) !== 0n) {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_PURSUIT_LAST_SEEN;
      marker = PlayerTrail_Pick(self, false);
    } else {
      marker = PlayerTrail_Pick(self, true);
    }

    if (marker !== null) {
      self.monsterinfo.last_sighting = copyVec3(marker.s.origin);
      self.monsterinfo.trail_time = marker.timestamp;
      self.s.angles[YAW] = self.ideal_yaw = marker.s.angles[YAW];

      newEnemy = true;
    }
  }

  if (
    (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) === 0n &&
    boxes_intersect(
      self.monsterinfo.last_sighting,
      self.monsterinfo.last_sighting,
      vec3_add(self.s.origin, self.mins),
      vec3_add(self.s.origin, self.maxs),
    )
  ) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_PURSUE_NEXT;
    dist = Math.min(dist, vec3_length(vec3_sub(self.s.origin, self.monsterinfo.last_sighting)));
    // [Paril-KEX] this helps them navigate corners when two next pursuits
    // are really close together
    self.monsterinfo.random_change_time = Gtime_add(level.time, Gtime_from_hz(10));
  }

  tempgoal.s.origin = copyVec3(self.monsterinfo.last_sighting);

  if (newEnemy) {
    let tr = gi.trace(self.s.origin, self.mins, self.maxs, self.monsterinfo.last_sighting, self, MASK_PLAYERSOLID);
    if (tr.fraction < 1) {
      let v = vec3_sub(tempgoal.s.origin, self.s.origin);
      const d1 = vec3_length(v);
      let center = tr.fraction;
      const d2 = d1 * ((center + 1) / 2);
      const backup_yaw = self.s.angles[YAW];
      self.s.angles[YAW] = self.ideal_yaw = vectoyaw(v);
      const v_forward = vec3();
      const v_right = vec3();
      AngleVectors(self.s.angles, v_forward, v_right, null);

      v = vec3(d2, -16, 0);
      let left_target = G_ProjectSource(self.s.origin, v, v_forward, v_right);
      tr = gi.trace(self.s.origin, self.mins, self.maxs, left_target, self, MASK_PLAYERSOLID);
      const left = tr.fraction;

      v = vec3(d2, 16, 0);
      let right_target = G_ProjectSource(self.s.origin, v, v_forward, v_right);
      tr = gi.trace(self.s.origin, self.mins, self.maxs, right_target, self, MASK_PLAYERSOLID);
      const right = tr.fraction;

      center = (d1 * center) / d2;
      if (left >= center && left > right) {
        if (left < 1) {
          v = vec3(d2 * left * 0.5, -16, 0);
          left_target = G_ProjectSource(self.s.origin, v, v_forward, v_right);
        }
        self.monsterinfo.saved_goal = copyVec3(self.monsterinfo.last_sighting);
        self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_PURSUE_TEMP;
        tempgoal.s.origin = copyVec3(left_target);
        self.monsterinfo.last_sighting = copyVec3(left_target);
        v = vec3_sub(tempgoal.s.origin, self.s.origin);
        self.ideal_yaw = vectoyaw(v);
      } else if (right >= center && right > left) {
        if (right < 1) {
          v = vec3(d2 * right * 0.5, 16, 0);
          right_target = G_ProjectSource(self.s.origin, v, v_forward, v_right);
        }
        self.monsterinfo.saved_goal = copyVec3(self.monsterinfo.last_sighting);
        self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_PURSUE_TEMP;
        tempgoal.s.origin = copyVec3(right_target);
        self.monsterinfo.last_sighting = copyVec3(right_target);
        v = vec3_sub(tempgoal.s.origin, self.s.origin);
        self.ideal_yaw = vectoyaw(v);
      }
      self.s.angles[YAW] = backup_yaw;
    }
  }

  M_MoveToGoal(self, dist);

  G_FreeEdict(tempgoal);

  if (!self.inuse) return; // PGM - g_touchtrigger free problem

  // C++'s trailing `if (self) self->goalentity = save;` -- `self` is a
  // non-nullable TS parameter (never becomes null), so the check is always
  // true here; dropped as dead, per PORTING.md's "meaningless C idiom when
  // semantically identical" precedent.
  self.goalentity = save;
}
