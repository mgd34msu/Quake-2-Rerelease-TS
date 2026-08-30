// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_monster.c -- ROGUE mission pack monster-support additions (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_monster.cpp
// (108 lines, C++17) in full: the `monster_fire_blaster2`/
// `monster_fire_tracker`/`monster_fire_heatbeam` muzzleflash wrappers, the
// `stationarymonster_*` family (used by the turret/carrier/stalker/widow
// monsters -- concurrent rogue-monster units' territory, but the bodies
// live in this source file, so they are ported here), `monster_done_dodge`,
// and `M_SlotsLeft`.
//
// ============================================================================
// monster_done_dodge / M_SlotsLeft -- re-exported, not re-implemented
// ============================================================================
// m_soldier.ts already ports `monster_done_dodge` for real (exported,
// registered under save name "monster_done_dodge" via its own dodge/duck
// infrastructure -- see its file header). m_medic.ts already ports
// `M_SlotsLeft` for real (see its "THE REINFORCEMENTS FINDING" section).
// Both functions' declared C++ home is this file
// (rogue/g_rogue_monster.cpp:98-108); per this port line's "import, don't
// duplicate" rule, they are re-exported from here rather than re-registered
// a second time under the same save name (which would throw at
// module-init: g_save_registry.ts's Register* functions reject duplicate
// names).
//
// ============================================================================
// STUB SWAP: m_medic.ts's / m_hover.ts's monster_fire_blaster2 are now real
// imports from here
// ============================================================================
// Both files declared a local, unexported, throwing stub for
// `monster_fire_blaster2`, cited to this file + g_rogue_newweap.cpp's
// `fire_blaster2`. Both stubs are now deleted; both files import the real
// function from here instead. `monster_fire_blaster2` itself imports
// `fire_blaster2` from g_rogue_newweap.ts (this file's own real,
// three-line body just calls it and calls `monster_muzzleflash`) --
// verified not a cycle (g_rogue_newweap.ts does not import anything from
// this file).
//
// ============================================================================
// monster_fire_tracker / monster_fire_heatbeam -- ported for real, unused by
// any monster landed in this unit's scope
// ============================================================================
// Both are thin wrappers exactly like `monster_fire_blaster2` (call the
// underlying `fire_tracker`/`fire_heatbeam` primitive from
// g_rogue_newweap.ts, then `monster_muzzleflash`). Their only C++ callers
// are the widow/widow2 boss monsters (m_rogue_widow.cpp/m_rogue_widow2.cpp)
// -- out of this unit's scope (a concurrent rogue-monster unit owns them).
// Ported for real anyway since the bodies are trivial and this file is
// their declared home; when the widow units land, they can import these
// directly with zero further work here.

import type { Vec3 } from "../../shared/math";
import { type EdictT, EntFlagsT, MovetypeT } from "../g_local";
import { SPAWNFLAG_MONSTER_TRIGGER_SPAWN, SPAWNFLAG_MONSTER_AMBUSH } from "../g_local";
import { SpawnFlags_has, SpawnFlags_and, SpawnFlags_not } from "../spawnflags";
import { type MonsterMuzzleflashIdT, type EffectsT, SolidT, SvflagsT } from "../../kexapi/game";
import { gi, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, GTIME_ZERO } from "../gtime";
import type { ThinkFn, UseFn } from "../g_local_types";
import { RegisterThink, RegisterUse } from "../g_save_registry";
import { KillBox } from "../g_utils";
import { monster_muzzleflash, monster_start, monster_start_go, monster_use } from "../g_monster";
import { FoundTarget } from "../g_ai";
import { fire_blaster2, fire_tracker, fire_heatbeam } from "./g_rogue_newweap";

// m_soldier.ts and m_medic.ts are reached lazily (via Bun's synchronous
// require, not a static top-level import): both are full monster modules
// whose own top-level frame-table construction reads g_ai.ts's `export
// const ai_stand`/etc directly at module-evaluation time (m_soldier.ts
// directly; m_medic.ts transitively via its own static import of
// `blocked_checkplat` from m_supertank.ts). A static import of either here
// risks the same `ReferenceError: Cannot access 'ai_stand' before
// initialization` load-order hazard documented in
// rogue/g_rogue_newai.ts's own "IMPORT CYCLE" header note -- caught by
// running `bun test`, not `tsc`. Matches that file's `mMedicMod()`
// precedent exactly.
import type * as MSoldierModule from "../m_soldier";
import type * as MMedicModule from "../m_medic";
function mSoldierMod(): typeof MSoldierModule {
  return require("../m_soldier");
}
function mMedicMod(): typeof MMedicModule {
  return require("../m_medic");
}

export function monster_done_dodge(self: EdictT): void {
  mSoldierMod().monster_done_dodge(self);
}
export function M_SlotsLeft(self: EdictT): number {
  return mMedicMod().M_SlotsLeft(self);
}

/** rogue/g_rogue_monster.cpp:7-11 `void monster_fire_blaster2(...)`. */
export function monster_fire_blaster2(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, flashtype: MonsterMuzzleflashIdT, effect: EffectsT): void {
  fire_blaster2(self, start, dir, damage, speed, effect, false);
  monster_muzzleflash(self, start, flashtype);
}

/** rogue/g_rogue_monster.cpp:13-17 `void monster_fire_tracker(...)`. */
export function monster_fire_tracker(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, enemy: EdictT | null, flashtype: MonsterMuzzleflashIdT): void {
  fire_tracker(self, start, dir, damage, speed, enemy);
  monster_muzzleflash(self, start, flashtype);
}

/** rogue/g_rogue_monster.cpp:19-23 `void monster_fire_heatbeam(...)`. */
export function monster_fire_heatbeam(self: EdictT, start: Vec3, dir: Vec3, offset: Vec3, damage: number, kick: number, flashtype: MonsterMuzzleflashIdT): void {
  fire_heatbeam(self, start, dir, offset, damage, kick, true);
  monster_muzzleflash(self, start, flashtype);
}

// ---------------------------------------------------------------------------
// stationarymonster_* (rogue/g_rogue_monster.cpp:28-96) -- turret support
// ---------------------------------------------------------------------------

/** rogue/g_rogue_monster.cpp:77-86 `THINK(stationarymonster_start_go)`.
 *  Forward-declared before `stationarymonster_triggered_spawn` in the C++
 *  source (used by it); declared first here since TS function declarations
 *  don't need forward decls, but kept as its own named export in the same
 *  relative order for citation clarity. */
export const stationarymonster_start_go: ThinkFn = RegisterThink("stationarymonster_start_go", (self: EdictT): void => {
  if (self.yaw_speed === 0) self.yaw_speed = 20;

  monster_start_go(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_TRIGGER_SPAWN)) {
    stationarymonster_triggered_start(self);
  }
});

/** rogue/g_rogue_monster.cpp:30-56 `THINK(stationarymonster_triggered_spawn)`. */
export const stationarymonster_triggered_spawn: ThinkFn = RegisterThink("stationarymonster_triggered_spawn", (self: EdictT): void => {
  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.air_finished = Gtime_add(level.time, Gtime_from_sec(12));
  gi.linkentity(self);

  KillBox(self, false);

  // FIXME - why doesn't this happen with real monsters?
  self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_MONSTER_TRIGGER_SPAWN));

  stationarymonster_start_go(self);

  if (self.enemy !== null && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH) && (self.enemy.flags & EntFlagsT.FL_NOTARGET) === 0n) {
    if ((self.enemy.flags & EntFlagsT.FL_DISGUISED) === 0n) {
      FoundTarget(self);
    } else {
      // PMM - just in case, make sure to clear the enemy so FindTarget
      // doesn't get confused
      self.enemy = null;
    }
  } else {
    self.enemy = null;
  }
});

/** rogue/g_rogue_monster.cpp:58-66 `USE(stationarymonster_triggered_spawn_use)`. */
export const stationarymonster_triggered_spawn_use: UseFn = RegisterUse("stationarymonster_triggered_spawn_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  // we have a one frame delay here so we don't telefrag the guy who activated us
  self.think = stationarymonster_triggered_spawn;
  // FRAME_TIME_S -- see g_phys.ts's/g_monster.ts's/g_misc.ts's own
  // "no InitGame-set FRAME_TIME_S global" note; one-frame delay via
  // gi.frame_time_ms, same workaround.
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  if (activator !== null && activator.client !== null) self.enemy = activator;
  self.use = monster_use;
});

/** rogue/g_rogue_monster.cpp:68-75 `void stationarymonster_triggered_start(edict_t *self)`. */
export function stationarymonster_triggered_start(self: EdictT): void {
  self.solid = SolidT.SOLID_NOT;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.nextthink = GTIME_ZERO;
  self.use = stationarymonster_triggered_spawn_use;
}

/** rogue/g_rogue_monster.cpp:88-96 `void stationarymonster_start(edict_t *self)`. */
export function stationarymonster_start(self: EdictT): void {
  self.flags |= EntFlagsT.FL_STATIONARY;
  self.think = stationarymonster_start_go;
  monster_start(self);

  // fix viewheight
  self.viewheight = 0;
}
