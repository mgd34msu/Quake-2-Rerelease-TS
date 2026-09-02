// g_kexent.ts -- shared scaffolding for the RE-RELEASE-ERA world entities
// hosted by the Ground Zero (rogue) game module.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT AN IMPORT
// ------------------------------------------------
// src/game, src/xatrix, src/rogue, src/ctf and src/lmctf are hard forks of
// each other: each owns its own EdictT, its own g_local.ts and its own spawn
// table, and there is no cross-module import anywhere in the tree. So the
// six classnames landed by this file's siblings (g_kexmisc.ts, g_kextarg.ts,
// g_kextrig.ts) are TRANSLATED into this module, exactly the way commit
// 288484f ported Ground Zero's own entities into src/game -- "ported from our
// own sibling modules", not referenced across a module boundary.
//
// The immediate source is our sibling src/game/g_kexent.ts, which itself
// translated src/kexgame/ (this repo's port of quake2-rerelease-dll). The
// re-release uses a millisecond GTime, a branded spawnflags type,
// enum-wrapped svflags/renderfx and a RegisterUse/RegisterThink callback
// registry, none of which this module has; every such construct is rewritten
// to this module's idioms rather than copied.
//
// NAMING: this module already splits its own 1998-era Ground Zero additions
// into g_newfnc.ts / g_newtarg.ts / g_newtrig.ts / g_newai.ts, mirroring
// rogue's C source layout. The `g_kex*` prefix keeps the RE-RELEASE-ERA
// additions a visibly separate family from those, so nobody mistakes a 2023
// entity for something rogue/g_new*.c ever shipped.
//
// SCOPE: only the pieces the six ported classnames actually need are here.
// The sibling src/game/g_kexent.ts carries a much larger surface (health
// bars, story flags, lightstyle mirror, autosave throttle, the q_std random
// helpers) because src/game hosts 104 re-release classnames; this module
// hosts six, and a scaffolding file full of state nothing reads would be
// dead weight.

import { vec3, type Vec3 } from "../shared/math";
import { type EdictT, gameCvars, level } from "./g_local";

// ---------------------------------------------------------------------------
// Entity flags
// ---------------------------------------------------------------------------

/**
 * re-release game.h's `FL_LOCKED`, toggled by info_nav_lock
 * (bots/bot_utils.cpp:382). Picked on the same free bit our sibling
 * src/game/g_kexent.ts uses -- above rogue's highest declared flag
 * (FL_NOGIB = 0x00010000, g_local.ts) and below FL_RESPAWN = 0x80000000 --
 * so it cannot collide with anything this module already tests.
 *
 * DEGRADATION: no Ground Zero door code tests a locked flag (rogue's
 * func_door has no lock concept at all), so the toggle is inert. The entity
 * spawns, validates, and its use wiring works.
 */
export const FL_KEX_LOCKED = 0x00040000;

// ---------------------------------------------------------------------------
// Cvar idioms
// ---------------------------------------------------------------------------

/** The `deathmatch->value` idiom (see g_misc.ts's SP_misc_teleporter). */
export function kexDeathmatch(): number {
  return gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** q_std.h's `clamp`. */
export function kexClamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** re-release `G_Fmt("{}", *ent)` -- "classname @ (x y z)". */
export function kexEdictFmt(ent: EdictT): string {
  return `${ent.classname ?? "?"} @ (${ent.s.origin[0]} ${ent.s.origin[1]} ${ent.s.origin[2]})`;
}

// ---------------------------------------------------------------------------
// Level-scoped state
//
// The re-release keeps the POI bookkeeping below in level_locals_t. Ground
// Zero's LevelLocalsT does not declare it, and rogue/g_local.h is a faithful
// transcription of the 1998 header that this port does not want to grow with
// 2023 fields, so it lives here.
//
// LIFETIME: SpawnEntities (g_spawn.ts) clears `level` and this file cannot
// hook that. Instead the state carries the mapname it was built for and
// resets itself the first time it is read after `level.mapname` changes --
// exactly the moment level.clear() would have wiped it.
//
// SAVEGAMES: not serialized. g_save.ts's hand-written JSON walk covers
// LevelLocalsT, and this state is not part of it, so a save/load mid-level
// restores the POI bookkeeping to its level-start values. Since the POI has
// no presentation under protocol 34 (see SP_target_poi), nothing visible
// changes; noted here so the omission is deliberate and findable.
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
