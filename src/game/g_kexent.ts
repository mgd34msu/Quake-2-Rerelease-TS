// g_kexent.ts -- shared scaffolding for the KEX-ONLY world entities hosted by
// the classic (3.21) game module.
//
// The 27 classnames in this slice exist ONLY in the 2023 re-release game DLL
// (src/kexgame/). They are TRANSLATED here, not copied: src/kexgame/ uses a
// millisecond GTime, a branded spawnflags type, enum-wrapped svflags/renderfx,
// an ItemIdT item table and a RegisterUse/RegisterThink callback registry,
// none of which the classic module has. This file holds the handful of pieces
// every translated file needs:
//
//   * the level-scoped state the rerelease keeps in level_locals_t but the
//     classic LevelLocalsT does not declare (POI bookkeeping, health bars,
//     autosave throttle, story flag, per-level gravity) and the game-scoped
//     cross_unit_flags the classic GameLocalsT does not declare;
//   * the small q_std.h random helpers (frandom/brandom/irandom/random_time)
//     the rerelease uses and shared/math.ts does not export;
//   * an active_players() equivalent;
//   * the classic deathmatch/coop cvar idioms;
//   * two entity flag bits and one model index the rerelease declares and the
//     classic g_local.ts does not.
//
// Everything here is module-local ON PURPOSE: per this port's file-ownership
// split, g_local.ts / g_save.ts / g_spawn.ts are owned elsewhere. The exact
// declarations that would be better placed there are listed in the port
// report; nothing in this file needs them to work.

import { vec3, type Vec3 } from "../shared/math";
import { MAX_CLIENTS } from "../shared/q_shared";
import { type EdictT, game, gameCvars, g_edicts, level } from "./g_local";

// ---------------------------------------------------------------------------
// Entity flags the rerelease declares (rerelease/game.h ent_flags_t) that the
// classic g_local.ts does not. Both values are picked from the free bits above
// the highest classic/mission-pack flag (FL_NOGIB = 0x00010000) and below
// FL_RESPAWN = 0x80000000, so they cannot collide with anything the classic
// module already tests.
// ---------------------------------------------------------------------------

/**
 * rerelease game.h's `FL_FLASHLIGHT`. Toggled by trigger_flashlight through
 * P_ToggleFlashlight (g_items.cpp:2164 in this port's src/kexgame/g_items.ts).
 * DEGRADATION: the classic module has no flashlight item and the classic
 * p_view.ts never emits the per-frame TE_FLASHLIGHT the rerelease view code
 * does, so the bit flips (and the on/off sounds play) but no beam is drawn.
 */
export const FL_KEX_FLASHLIGHT = 0x00020000;

/**
 * rerelease game.h's `FL_LOCKED`. Toggled by info_nav_lock
 * (bots/bot_utils.cpp:382). DEGRADATION: no classic door code tests it, so
 * the toggle is inert under the classic ruleset.
 */
export const FL_KEX_LOCKED = 0x00040000;

/** rerelease game.h's `MODELINDEX_PLAYER` -- p_client.ts writes the same 255. */
export const MODELINDEX_PLAYER = 255;

// ---------------------------------------------------------------------------
// q_std.h random helpers (src/kexgame/q_std.ts) -- shared/math.ts exports only
// random()/crandom(), so the three the rerelease entities in this slice call
// are re-declared here with identical semantics.
// ---------------------------------------------------------------------------

/** q_std.ts frandom(min_inclusive, max_exclusive) -- uniform float [a, b). */
export function kexFrandom(min_inclusive: number, max_exclusive: number): number {
  return min_inclusive + Math.random() * (max_exclusive - min_inclusive);
}

/** q_std.ts irandom(max_exclusive) -- uniform int [0, n). */
export function kexIrandom(max_exclusive: number): number {
  if (max_exclusive <= 0) return 0;
  return Math.floor(Math.random() * max_exclusive);
}

/** q_std.ts brandom() -- `irandom(2) == 0`. */
export function kexBrandom(): boolean {
  return kexIrandom(2) === 0;
}

/**
 * g_local.ts's `random_time(a)` -- a uniform random DURATION in
 * `[0, a]` milliseconds, inclusive on both ends
 * (`Gtime_from_ms(irandom(Gtime_ms(a) + 1))`). The classic module keeps
 * durations in plain seconds, so the millisecond quantization is preserved
 * exactly and the result converted back to seconds.
 */
export function kexRandomTimeSec(max_seconds: number): number {
  const maxMs = Math.round(max_seconds * 1000);
  return kexIrandom(maxMs + 1) / 1000;
}

// ---------------------------------------------------------------------------
// Cvar idioms
// ---------------------------------------------------------------------------

/** The classic `deathmatch->value` idiom (see g_misc.ts's SP_misc_teleporter). */
export function kexDeathmatch(): number {
  return gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
}

/** The classic `coop->value` idiom. */
export function kexCoop(): number {
  return gameCvars.coop === null ? 0 : gameCvars.coop.value;
}

/** g_local.h:3426-3437's `active_players()` -- inuse, connected players. */
export function* kexActivePlayers(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

// ---------------------------------------------------------------------------
// Lightstyle string table
//
// target_light_think (g_target.cpp:1453) reads back the CURRENT lightstyle
// string with `gi.get_configstring(CS_LIGHTS + self->style)`. The classic
// GameImports (src/game/game.ts) has `configstring()` but NO
// `get_configstring()` -- vanilla 3.21's game import table never had one --
// so the read is served from a local mirror of the exact table
// SP_worldspawn writes (src/game/g_spawn.ts:1071-1109).
//
// DEVIATION (documented, and moot in practice): styles 32-62 are assigned at
// runtime by SP_light / light_use and are NOT mirrored here, so a target_light
// pointed at a switchable style reads "m" (full brightness) instead of the
// live string. It is moot because target_light's only output is a packed RGB
// in s.skinnum consumed by the client's RF_CUSTOM_LIGHT branch, and that
// branch is gated behind `cls.csr.extended`, which is false for protocol 34 --
// see the degradation note on SP_target_light in g_kextarg.ts.
// ---------------------------------------------------------------------------

const KEX_LIGHTSTYLES: readonly string[] = [
  "m", // 0 normal
  "mmnmmommommnonmmonqnmmo", // 1 FLICKER (first variety)
  "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba", // 2 SLOW STRONG PULSE
  "mmmmmaaaaammmmmaaaaaabcdefgabcdefg", // 3 CANDLE (first variety)
  "mamamamamama", // 4 FAST STROBE
  "jklmnopqrstuvwxyzyxwvutsrqponmlkj", // 5 GENTLE PULSE 1
  "nmonqnmomnmomomno", // 6 FLICKER (second variety)
  "mmmaaaabcdefgmmmmaaaammmaamm", // 7 CANDLE (second variety)
  "mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa", // 8 CANDLE (third variety)
  "aaaaaaaazzzzzzzz", // 9 SLOW STROBE (fourth variety)
  "mmamammmmammamamaaamammma", // 10 FLUORESCENT FLICKER
  "abcdefghijklmnopqrrqponmlkjihgfedcba", // 11 SLOW PULSE NOT FADE TO BLACK
];

export function kexLightStyleString(style: number): string {
  if (style === 63) return "a"; // 63 testing (g_spawn.ts:1109)
  const s = KEX_LIGHTSTYLES[style];
  return s === undefined ? "m" : s;
}

// ---------------------------------------------------------------------------
// Level- and game-scoped state
//
// The rerelease keeps all of this in level_locals_t / game_locals_t. The
// classic LevelLocalsT / GameLocalsT do not declare it and this port does not
// own g_local.ts, so it lives here.
//
// LIFETIME: the classic module clears `level` inside SpawnEntities
// (g_spawn.ts) and this file cannot hook that. Instead the state carries the
// mapname it was built for and resets itself the first time it is read after
// `level.mapname` changes -- which is exactly the moment level.clear() would
// have wiped it. `game`-scoped state (cross_unit_flags) deliberately does NOT
// reset per level, matching game_locals_t's cross-level lifetime.
//
// SAVEGAMES: none of this is serialized (g_save.ts walks LevelLocalsT, and
// this port does not own g_save.ts). A save/load mid-level therefore restores
// the POI/health-bar/story bookkeeping to its level-start values. Listed in
// the port report as the declarations to move into LevelLocalsT.
// ---------------------------------------------------------------------------

/** MAX_HEALTH_BARS (src/kexgame/g_local.ts:724). */
export const MAX_HEALTH_BARS = 2;

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
  /** level_locals_t::health_bar_entities[MAX_HEALTH_BARS] */
  health_bar_entities: (EdictT | null)[] = new Array<EdictT | null>(MAX_HEALTH_BARS).fill(null);
  /** level_locals_t::next_auto_save (seconds on the classic clock) */
  next_auto_save = 0;
  /** level_locals_t::story_active */
  story_active = false;
  /** level_locals_t::gravity -- target_gravity's mirror of sv_gravity */
  gravity = 0;
  /** level_locals_t::level_intermission_set -- set by update_target_camera */
  level_intermission_set = false;
  /**
   * CS_SKYROTATE mirror. use_target_sky (g_target.cpp:1933) reads the live
   * sky rotate/autorotate pair back out of the configstring before rewriting
   * it; the classic GameImports has no get_configstring, so the last value
   * WRITTEN BY THIS MODULE is mirrored here instead.
   *
   * DEVIATION: worldspawn's own CS_SKYROTATE write (g_spawn.ts) is not seen
   * by this mirror, so a target_sky that sets ONLY skyautorotate emits
   * "0 <autorotate>" rather than preserving worldspawn's rotate speed. A
   * target_sky that sets skyrotate (or both) is unaffected.
   */
  sky_rotate_mirror = 0;
  sky_autorotate_mirror = 0;
}

/**
 * The per-client POI/compass bookkeeping the rerelease keeps in gclient_t
 * (g_local.h's help_draw_points / help_draw_index / help_draw_count /
 * help_draw_time / help_poi_image / help_poi_location) and the classic
 * GClientT does not declare. Same ownership reason as KexLevelStateT above:
 * this port does not own g_local.ts.
 *
 * Indexed by client number (ent.s.number - 1), sized MAX_CLIENTS, and reset
 * with the level state -- the rerelease clears these in PutClientInServer,
 * which is once per level for a singleplayer/coop session.
 */
export class KexClientStateT {
  /** gclient_t::help_draw_points */
  help_draw_points = false;
  /** gclient_t::help_draw_index */
  help_draw_index = 0;
  /** gclient_t::help_draw_count */
  help_draw_count = 0;
  /** gclient_t::help_draw_time (seconds on the classic clock) */
  help_draw_time = 0;
  /** gclient_t::help_poi_image -- a CS_IMAGES index */
  help_poi_image = 0;
  /** gclient_t::help_poi_location */
  help_poi_location: Vec3 = vec3();
  /**
   * level_locals_t::poi_points[client] -- the walked path Use_Compass asks
   * the nav mesh for. `null` until a path is found, which is what
   * Compass_Update's own "deleted for some reason" guard tests
   * (g_items.cpp:1501-1503).
   */
  poi_points: Vec3[] | null = null;
}

const kexClientStates: KexClientStateT[] = Array.from({ length: MAX_CLIENTS }, () => new KexClientStateT());

/**
 * Per-client kex state for `ent`, auto-reset with the level (see kexLevel()).
 * Returns the slot for ent.s.number - 1; out-of-range callers get slot 0
 * rather than a crash, matching this file's other defensive lookups.
 */
export function kexClient(ent: EdictT): KexClientStateT {
  kexLevel(); // shares the level-change reset trigger
  const i = ent.s.number - 1;
  return kexClientStates[i >= 0 && i < MAX_CLIENTS ? i : 0];
}

class KexGameStateT {
  /** game_locals_t::cross_unit_flags -- distinct from the classic
   * game.serverflags, which is game_locals_t::cross_level_flags. */
  cross_unit_flags = 0;
}

const kexLevelState = new KexLevelStateT();
export const kexGameState = new KexGameStateT();

let kexLevelStateMapname: string | null = null;

/** Level-scoped kex state, auto-reset on the first read of a new level. */
export function kexLevel(): KexLevelStateT {
  if (kexLevelStateMapname !== level.mapname) {
    kexLevelStateMapname = level.mapname;
    Object.assign(kexLevelState, new KexLevelStateT());
    for (const c of kexClientStates) Object.assign(c, new KexClientStateT());
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
  for (const c of kexClientStates) Object.assign(c, new KexClientStateT());
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

/** The rerelease player-skin configstring base, sized off MAX_CLIENTS. */
export const KEX_MAX_CLIENTS = MAX_CLIENTS;
