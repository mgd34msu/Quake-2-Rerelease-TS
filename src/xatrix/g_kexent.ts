// g_kexent.ts -- shared scaffolding for the KEX-ONLY world entities hosted by
// The Reckoning (Xatrix) game module.
//
// The five classnames in this slice (dynamic_light, info_landmark, target_poi,
// info_nav_lock, trigger_fog) exist ONLY in the 2023 re-release game DLL, and
// the xatrix campaign maps in the re-release pak place all five. This module
// is a HARD FORK of src/game -- it has its own EdictT, its own g_local.ts and
// its own spawn table, and there is no cross-module import anywhere in the
// tree -- so these entities are PORTED IN here, exactly as commit 288484f
// ported the sibling modules' entities into src/game.
//
// SOURCE: src/game/g_kexent.ts, which is itself the classic-module translation
// of the rerelease scaffolding (level_locals_t POI bookkeeping, the q_std.h
// random helpers, the deathmatch/coop cvar idioms, and the two entity flag
// bits the classic g_local.ts does not declare). Only the pieces the five
// xatrix classnames actually need are carried across; the health-bar,
// autosave, story, sky-mirror and lightstyle-table members of src/game's
// KexLevelStateT belong to target_healthbar / target_autosave / target_story /
// target_sky / target_light, none of which any xatrix map places.
//
// Everything here is module-local ON PURPOSE, matching src/game/g_kexent.ts:
// the level-scoped POI state would ideally live in LevelLocalsT and be walked
// by g_save.ts's level serializer, but the classic module clears `level`
// inside SpawnEntities and this state resets itself on the mapname change
// instead (see kexLevel below).

import { vec3, type Vec3 } from "../shared/math";
import { type EdictT, gameCvars, level } from "./g_local";

// ---------------------------------------------------------------------------
// Entity flags the rerelease declares (rerelease/game.h ent_flags_t) that the
// xatrix g_local.ts does not. The value is picked from the free bits above the
// highest classic/Xatrix flag (FL_NOGIB = 0x00010000) and below
// FL_RESPAWN = 0x80000000, so it cannot collide with anything this module
// already tests. Same bit src/game/g_kexent.ts uses, for cross-module
// readability -- the two modules never share a value at runtime.
// ---------------------------------------------------------------------------

/**
 * rerelease game.h's `FL_LOCKED`. Toggled by info_nav_lock
 * (bots/bot_utils.cpp:382). DEGRADATION: no Xatrix door code tests it -- the
 * Xatrix func_door is vanilla 3.21's, which has no lock concept at all -- so
 * the toggle is inert under this ruleset. The entity still spawns, validates
 * its targetname/target pair, and its use wiring works.
 */
export const FL_KEX_LOCKED = 0x00040000;

// ---------------------------------------------------------------------------
// Cvar idioms
// ---------------------------------------------------------------------------

/** The classic `deathmatch->value` idiom (see g_misc.ts's SP_misc_teleporter). */
export function kexDeathmatch(): number {
  return gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
}

// ---------------------------------------------------------------------------
// Level-scoped state
//
// The rerelease keeps this in level_locals_t. The Xatrix LevelLocalsT does not
// declare it (it is vanilla 3.21's plus Xatrix's own additions), so it lives
// here.
//
// LIFETIME: SpawnEntities (g_spawn.ts) clears `level` wholesale; this state
// carries the mapname it was built for and resets itself the first time it is
// read after `level.mapname` changes -- exactly the moment level.clear() would
// have wiped it.
//
// SAVEGAMES: not serialized (g_save.ts walks LevelLocalsT). A save/load
// mid-level restores the POI bookkeeping to its level-start values. Harmless
// here: nothing under protocol 34 presents a POI (see SP_target_poi).
// ---------------------------------------------------------------------------

class KexLevelStateT {
  /** level_locals_t::valid_poi */
  valid_poi = false;
  /** level_locals_t::current_poi */
  current_poi: Vec3 = vec3();
  /** level_locals_t::current_poi_image */
  current_poi_image = 0;
  /** level_locals_t::current_poi_stage */
  current_poi_stage = 0;
  /** level_locals_t::current_dynamic_poi */
  current_dynamic_poi: EdictT | null = null;
}

const kexLevelState = new KexLevelStateT();

let kexLevelStateMapname: string | null = null;

/** Level-scoped kex state, auto-reset on the first read of a new level. */
export function kexLevel(): KexLevelStateT {
  if (kexLevelStateMapname !== level.mapname) {
    kexLevelStateMapname = level.mapname;
    Object.assign(kexLevelState, new KexLevelStateT());
  }
  return kexLevelState;
}

/**
 * Explicit reset seam, for a caller (SpawnEntities, or a test) that wants the
 * kex level state cleared without waiting for a mapname change.
 */
export function KexResetLevelState(): void {
  kexLevelStateMapname = level.mapname;
  Object.assign(kexLevelState, new KexLevelStateT());
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** q_std.h's `clamp`. */
export function kexClamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** rerelease `G_Fmt("{}", *ent)` -- "classname @ (x y z)". */
export function kexEdictFmt(ent: EdictT): string {
  return `${ent.classname ?? "?"} @ (${ent.s.origin[0]} ${ent.s.origin[1]} ${ent.s.origin[2]})`;
}
