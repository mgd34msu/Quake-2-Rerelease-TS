// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_func.c -- the mover framework (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/g_func.cpp
// (3,003 lines, C++17): the Move_Calc/AngleMove_Calc constant- and
// accelerated-movement machinery (including the [Paril-KEX] curve-based
// rewrite for tick rates other than 10hz), func_plat (+ Use_Plat/
// plat_blocked/plat_spawn_inside_trigger), func_rotating (+ the [Paril-KEX]
// ACCEL/DECEL spawnflag), func_spinning ([Paril-KEX]), func_button,
// func_door/func_door_rotating/func_water (+ the ROGUE "smart water" branch),
// func_train (+ path-corner following, teleport path-corners, and the
// MOVE_TEAMCHAIN sibling-piece follow), trigger_elevator, func_timer,
// func_conveyor, func_door_secret, func_killbox, and func_eye
// ([Paril-KEX]) -- every SP_* the C++ file declares. Behavioral code, ported
// bug-for-bug per PORTING.md.
//
// ============================================================================
// SPAWN-FUNCTION INVENTORY: 14 SP_* in the C++ source, 14 exported here
// ============================================================================
// Verified by `grep -c '^void SP_' g_func.cpp` against this file's own
// `export function SP_*` count: SP_func_plat, SP_func_rotating,
// SP_func_spinning, SP_func_button, SP_func_door, SP_func_door_rotating,
// SP_func_water, SP_func_train, SP_trigger_elevator, SP_func_timer,
// SP_func_conveyor, SP_func_door_secret, SP_func_killbox, SP_func_eye.
//
// ============================================================================
// STUB SWAP: g_misc.ts's train_use/func_train_find throwing stubs are now
// real imports from here
// ============================================================================
// g_misc.ts's header ("CROSS-DEPENDENCIES NOT YET PORTED") named exactly
// two functions it could not port faithfully because this file did not exist
// yet: `func_train_find` (g_func.cpp:2349) and `train_use` (g_func.cpp:2390),
// both save-registered under those exact names as throwing stubs so
// misc_viper_use/misc_strogg_ship_use (the only call sites reached by that
// file's own test suite -- neither exercises them) would fail loudly if ever
// invoked instead of silently doing nothing. Both are real exports below;
// g_misc.ts's own two local throwing stubs and their save-registrations are
// REMOVED as part of this unit (the registry throws on duplicate-name
// registration, so the old stubs cannot coexist with these real
// implementations under the same names) -- see that file's own diff. This
// creates a real, sanctioned import cycle: g_misc.ts now imports
// `train_use`/`func_train_find` from here, while this file imports
// `BecomeExplosion1` from g_misc.ts (every MOVEINFO_BLOCKED handler below
// that "nukes" a non-monster/non-client obstacle calls it, exactly like the
// C++ source's own g_func.cpp<->g_misc.cpp relationship through the shared
// g_local.h header). Exactly the same shape as the already-sanctioned
// g_phys.ts<->g_monster.ts and g_utils.ts<->g_phys.ts cycles: every
// cross-module symbol on both sides is either a hoisted `export function`
// declaration (`BecomeExplosion1`, g_misc.ts:658) or a top-level `const`
// whose value is only READ inside a closure body that isn't invoked until a
// real game callback fires (`train_use`/`func_train_find`, both referenced
// only from inside misc_viper_use/misc_strogg_ship_use/SP_misc_viper/
// SP_misc_strogg_ship's own closures in g_misc.ts, never at that file's
// top level). No TDZ hazard either direction. Verified end-to-end by
// `bunx tsc --noEmit` and `bun test` actually importing both files together.
//
// ============================================================================
// THE plat2 BOUNDARY -- func_plat2 itself is NOT in this file's scope, but
// plat_go_up/plat_hit_bottom's plat2_spawn_danger_area/plat2_kill_danger_area
// call sites ARE reached by every ordinary func_plat, not just plat2 entities
// ============================================================================
// g_func.cpp calls `plat2_kill_danger_area(ent)` (plat_hit_bottom,
// g_func.cpp:541) and `plat2_spawn_danger_area(ent)` (plat_go_up,
// g_func.cpp:573) -- both forward-declared in g_local.h:2580-2581 but NEVER
// DEFINED anywhere in g_func.cpp itself. Their one real definition each is
// rerelease/rogue/g_rogue_func.cpp:18 (plat2_spawn_danger_area) and :29
// (plat2_kill_danger_area) -- the ROGUE mission-pack's OWN separate
// translation unit, not g_func.cpp. `plat2flags_t`/`PLAT2_*`/
// `edict_t::plat2flags` are save-compat-only in THIS file's scope (pure
// types in g_local.ts/g_local_types.ts) -- no plat2-SPECIFIC behavior
// (`func_plat2` itself, or its CALLED/MOVING/WAITING state machine) is
// reachable from anything in g_func.cpp.
//
// `plat2_kill_danger_area` was ALREADY a real, faithful local implementation
// here (needs only `G_FindByString`/`G_FreeEdict`, both already imported by
// this file) -- unaffected by this swap, still exported to
// rogue/g_rogue_func.ts's `plat2_hit_bottom` as a second call site (see that
// file's own header for why it keeps its own copy rather than importing
// this one). `plat2_spawn_danger_area` used to be a documented NO-OP: its
// real body (g_rogue_func.cpp:18-26) calls `SpawnBadArea`, whose own real
// home (rerelease/rogue/g_rogue_newai.cpp) had no src/kexgame/ port at the
// time this file landed. rogue/g_rogue_newai.ts has since landed with a
// real, exported `SpawnBadArea`, and rogue/g_rogue_func.ts now exports a
// real `plat2_spawn_danger_area` built on top of it (g_rogue_func.cpp:
// 18-26, ported verbatim). This file's own local no-op function and its
// explanatory comment are DELETED; `plat_go_up` below now calls the real
// import instead. Behaviorally this closes the one known gap the old
// comment flagged: monsters now get a "don't path under this platform right
// now" hint for the ~2-5 second window a func_plat spends mid-cycle, for
// every SOLID_BSP-moving func_plat, plat2 or not -- exactly matching the
// C++ source's own unconditional call site. Nothing about the plat's own
// mechanical behavior (movement math, blocked handling, state transitions)
// changes; `plat2_kill_danger_area`'s cleanup loop, previously guaranteed to
// find nothing (spawn was a no-op), now actually has matching `bad_area`
// entities to clean up.
//
// This creates a new import edge, g_func.ts -> rogue/g_rogue_func.ts, the
// first cross into src/kexgame/rogue/ from a non-rogue file in this port
// line -- one-way (rogue/g_rogue_func.ts already imports several symbols
// FROM this file -- `Move_Calc`/`G_SetMoveinfoSounds`/
// `plat_spawn_inside_trigger` -- for its own `SP_func_plat2`/`plat2_activate`,
// making this a two-way module cycle). Safe: `plat2_spawn_danger_area` is a
// hoisted top-level `export function` declaration on rogue/g_rogue_func.ts's
// side, referenced here only inside `plat_go_up`'s function body (never at
// this file's own module-eval time), and vice versa for this file's three
// exports read inside rogue/g_rogue_func.ts's own function bodies -- no TDZ
// hazard either direction. Verified end-to-end by `bunx tsc --noEmit`
// succeeding with both files importing each other.
//
// ============================================================================
// `st` (spawn_temp_t) -- a real-shaped, permanently-default placeholder
// ============================================================================
// Same precedent g_misc.ts's own header already established for itself: no
// src/kexgame/g_spawn.ts exists yet, so there is no shared global `st` to
// import. This file reads `st.lip`/`st.height`/`st.distance`/`st.noise`/
// `st.noise_start`/`st.noise_middle`/`st.noise_end`/`st.pausetime`/
// `st.keys_specified` (`st.was_key_specified(key)` inlined as
// `st.keys_specified.has(key)`, the real method body -- see
// g_local_types.ts's own SpawnTempT comment), so a full, real `SpawnTempT`
// object is built here too, all-zero/all-null, identical in shape to
// g_misc.ts's own placeholder. CONSEQUENCE, stated plainly: every "lip
// defaults to 8/4" etc. fallback below always takes the "unset" branch until
// a future g_spawn.ts lands and wires a real per-entity `st` through
// SpawnEntities. A future unit should delete this placeholder and import
// the real one.
//
// ============================================================================
// FRAME_TIME_S / cvarOrDefault / edictFmt / anglemod / active_players --
// local copies, not shared, per established precedent
// ============================================================================
// - `FRAME_TIME_S`/`FRAME_TIME_MS` (g_local.h externs, set once in a
//   not-yet-ported InitGame) don't exist as real globals yet -- g_phys.ts's/
//   g_monster.ts's/g_misc.ts's own headers already flag this gap and work
//   around it with a local `frameTimeAsGtime()` reading `gi.frame_time_ms`
//   per-call; this file's copy is the same workaround, used everywhere the
//   C++ source adds `FRAME_TIME_S`/`FRAME_TIME_MS` to `nextthink`.
// - `cvarOrDefault(name, default)` is copied from g_phys.ts's/g_monster.ts's
//   own local, unexported helper (same `gi.cvar(...)` wrapper, throwing if
//   `gi.cvar` ever returns null) -- used for `deathmatch` (SP_func_door's
//   `if (deathmatch->integer) ent->speed *= 2;`).
// - `edictFmt(ent)` replicates g_local.h's `fmt::formatter<edict_t>` just
//   enough to back the handful of `gi.Com_PrintFmt("{} ...", *ent)` call
//   sites this file has (train_next's bad-target warnings,
//   SP_func_door_rotating's distance/SAFE_OPEN warnings, SP_func_train's
//   no-target warning, trigger_elevator_*'s bad-target warnings), same as
//   g_misc.ts's own copy -- called from plain `gi.Com_Print(...)` template
//   literals (`gi.Com_Print` takes a plain string, not a format string).
// - `anglemod` (q_std.h) is q_std.ts's own explicitly-deferred function;
//   func_eye_think is this file's only caller, copied locally again,
//   verbatim, same as g_misc.ts's/m_move.ts's own copies.
// - `active_players()` (g_local.h:3426-3437) is g_trigger.ts's/g_target.ts's
//   own local, unexported generator, copied here verbatim for
//   func_eye_think's target-tracking loop -- not shared/exported anywhere in
//   this port line.
//
// ============================================================================
// `mod()` -- a small local helper, not present in the C++ source
// ============================================================================
// Every MOVEINFO_BLOCKED handler in this file builds a fresh `mod_t{id,
// false, false}` at each T_Damage call site (plat_blocked/door_blocked/
// rotating_blocked/train_blocked/smart_water_blocked/door_secret_blocked --
// six call sites, all MOD_CRUSH except smart_water_blocked's MOD_LAVA). The
// C++ source relies on `mod_t`'s own implicit-conversion-from-`mod_id_t`
// constructor (`mod_t(mod_id_t id) : id(id) {}`, g_local.h:1085) to write
// `MOD_CRUSH` directly as a `mod_t` argument; TS has no implicit-constructor
// equivalent, so `mod(ModIdT.MOD_CRUSH)` stands in for that conversion at
// every call site -- a literal transcription of the same defaulted
// `friendly_fire = false, no_point_loss = false`, not a behavior choice.
//
// ============================================================================
// SAVE-REGISTERED FUNCTIONS (via g_save_registry.ts)
// ============================================================================
// Every THINK/USE/TOUCH/DIE/MOVEINFO_ENDFUNC/MOVEINFO_BLOCKED-macro-wrapped
// C++ function is registered under its exact C++ name: Move_Done, Move_Final,
// Move_Begin, Think_AccelMove_New, Think_AccelMove, AngleMove_Done,
// AngleMove_Final, AngleMove_Begin, plat_hit_top, plat_hit_bottom,
// plat_go_down, plat_blocked, Use_Plat, Touch_Plat_Center, rotating_accel,
// rotating_decel, rotating_blocked, rotating_touch, rotating_use,
// func_spinning_think, button_done, button_return, button_wait, button_use,
// button_touch, button_killed, door_hit_top, door_hit_bottom, door_go_down,
// smart_water_go_up, door_use, Touch_DoorTrigger, Think_CalcMoveSpeed,
// Think_SpawnDoorTrigger, door_blocked, door_killed, door_touch,
// Think_DoorActivateAreaPortal, Door_Activate, smart_water_blocked,
// train_blocked, train_wait, train_piece_wait, train_next, func_train_find,
// train_use (the latter two are stub-swap targets, see above),
// trigger_elevator_use, trigger_elevator_init, func_timer_think,
// func_timer_use, func_conveyor_use, door_secret_move1-6, door_secret_done,
// door_secret_blocked, door_secret_die, door_secret_use, use_killbox,
// func_eye_think, func_eye_setup. Plain, unwrapped C++ functions (no
// SAVE_FUNC_* macro) are plain functions instead, matching the C++ source's
// own lack of a save wrapper on them. None of these are C++ `static`
// EXCEPT G_GetMoveinfoSoundIndex and door_play_sound (both file-local in
// the C++ TU, kept unexported here); every other one has ordinary C++
// external linkage, so it is exported here too -- including
// `AccelerationDistance`/`plat_CalcAcceleratedMove`/`plat_Accelerate`/
// `Think_AccelMove_MoveInfo` (the accelerated-move math the test file hand-
// verifies directly against the C++ formulas, without needing a full
// physics-integration harness): G_SetMoveinfoSounds, AccelerationDistance,
// Move_Calc, plat_CalcAcceleratedMove, plat_Accelerate,
// Think_AccelMove_MoveInfo, AngleMove_Calc. `Move_Regular`, `plat_go_up`,
// `plat_spawn_inside_trigger`, `door_use_areaportals`, `door_go_up`,
// `train_resume`, `button_fire` are also plain, non-static C++ functions,
// but are only ever reached indirectly through an already-exported SP_*/
// Move_Calc/AngleMove_Calc entry point or a registered think/use/blocked
// handler in this port, so they stay unexported (nothing outside this file
// calls them directly in the C++ source either -- g_func.cpp is the only
// translation unit that references them).
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `door_secret_use`'s "make sure we're not already moving" guard reads
//   `if (self->s.origin) return;` -- checking the ORIGIN, not velocity or
//   moveinfo.state, via vec3_t's `operator bool()` (any component nonzero).
//   Ported literally as `vec3_any_nonzero(self.s.origin)`; this is a genuine
//   C++ source oddity (a secret door not spawned exactly at the world
//   origin will simply refuse to ever open a second time from this guard
//   alone -- in practice `door_secret_done`'s own `Move_Calc(self,
//   vec3_origin, door_secret_done)` final leg always returns it to (0,0,0)
//   first, which is what makes the guard work at all), not a porting error.
// - Every `strcmp(self->classname, "func_door") == 0 || ...` classname
//   dispatch (door_go_up/door_go_down's Move_Calc-vs-AngleMove_Calc branch,
//   door_use's func_water/SAFE_OPEN checks, trigger_elevator_init's
//   func_train check) ports as plain `===` string comparison.
// - `Move_Calc`'s [Paril-KEX] curve-based rewrite (the `gi.tick_rate !== 10`
//   branch) runs plat_CalcAcceleratedMove/plat_Accelerate in a tight
//   "simulate 10hz movement" precompute loop that mutates `ent.moveinfo`'s
//   `remaining_distance`/`current_speed`/`move_speed`/`decel_distance`/
//   `next_speed` fields as a SIDE EFFECT of building the `curve_positions`
//   table -- their post-loop values are stale/meaningless (the real
//   per-frame movement afterward is driven entirely by
//   `curve_frame`/`curve_positions`, never by `remaining_distance` again
//   until the next `Move_Calc` call). Ported exactly as-is, including the
//   staleness -- not "cleaned up" after the loop, since the C++ source
//   doesn't either.
// - `vec3_t`-valued struct-to-struct field copies (`ent->pos1 =
//   ent->s.origin;`, `ent->moveinfo.dest = dest;`, etc.) use `VectorCopy(src,
//   dst)` throughout, per this port line's established Float32Array-aliasing
//   rule (shared/math.ts: `Vec3 = Float32Array`, so a bare `=` would alias
//   the same backing array instead of copying its values) -- see g_phys.ts's
//   own header for the precedent this file follows.

import { vec3, type Vec3, VectorCopy } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import {
  type KexTraceT,
  type ShadowLightDataT,
  ContentsT,
  SvflagsT,
  SolidT,
  SoundchanT,
  EffectsT,
  KexEntityEventT,
  ShadowLightTypeT,
  MASK_WATER,
  ATTN_STATIC,
  ATTN_NONE,
  ATTN_NORM,
  ATTN_LOOP_NONE,
  CvarFlagsT,
} from "../kexapi/game";
import {
  type EdictT,
  type ModT,
  type SpawnTempT,
  MovetypeT,
  EntFlagsT,
  MoveStateT,
  ModIdT,
  DamageflagsT,
  SPAWNFLAG_PATH_CORNER_TELEPORT,
  SPAWNFLAG_TRAIN_START_ON,
  SPAWNFLAG_WATER_SMART,
  SPAWNFLAG_TRAIN_MOVE_TEAMCHAIN,
  SPAWNFLAG_DOOR_REVERSE,
} from "./g_local";
import { gi, g_edicts, game, level } from "./g_main_globals";
import { type GTime, Gtime_add, Gtime_from_ms, Gtime_from_sec, Gtime_from_hz } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, SpawnFlags_and, SpawnFlags_not } from "./spawnflags";
import { crandom, frandom, brandom } from "./q_std";
import {
  vec3_origin,
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_divEqs,
  vec3_addEq,
  vec3_length,
  vec3_dot,
  vec3_any_nonzero,
  vec3_normalized,
  AngleVectors,
  vectoangles,
} from "./q_vec3";
import { G_Spawn, G_FreeEdict, G_PickTarget, G_UseTargets, G_SetMovedir, G_FindByString, KillBox } from "./g_utils";
import { T_Damage } from "./g_combat";
import { BecomeExplosion1 } from "./g_misc";
import {
  RegisterThink,
  RegisterTouch,
  RegisterUse,
  RegisterDie,
  RegisterMoveinfoEndfunc,
  RegisterMoveinfoBlocked,
  type ThinkFn,
  type TouchFn,
  type UseFn,
  type DieFn,
  type MoveinfoEndfuncFn,
  type MoveinfoBlockedFn,
} from "./g_save_registry";
import { plat2_spawn_danger_area } from "./rogue/g_rogue_func";

// ---------------------------------------------------------------------------
// small local helpers -- see file header
// ---------------------------------------------------------------------------

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) {
    throw new Error(`gi.cvar(${name}) returned null`);
  }
  return c;
}

function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

function edictFmt(ent: EdictT): string {
  const p = ent.linked ? vec3_muls(vec3_add(ent.absmax, ent.absmin), 0.5) : ent.s.origin;
  return `${ent.classname} @ (${p[0]} ${p[1]} ${p[2]})`;
}

/** q_std.h:185 -- kex's OWN anglemod (fmod-based); see file header. */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

/** g_local.h:1085's `mod_t(mod_id_t)` implicit conversion -- see file header. */
function mod(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** g_misc.ts's own `defaultShadowLightData()`, copied verbatim -- part of
 *  this file's own local `st` placeholder (see file header). */
function defaultShadowLightData(): ShadowLightDataT {
  return {
    lighttype: ShadowLightTypeT.point,
    radius: 0,
    resolution: 0,
    intensity: 0,
    fade_start: 0,
    fade_end: 0,
    lightstyle: -1,
    coneangle: 45,
    conedirection: vec3(0, 0, 0),
  };
}

const st: SpawnTempT = {
  sky: null,
  skyrotate: 0,
  skyaxis: vec3(0, 0, 0),
  skyautorotate: 0,
  nextmap: null,
  lip: 0,
  distance: 0,
  height: 0,
  noise: null,
  pausetime: 0,
  item: null,
  gravity: null,
  minyaw: 0,
  maxyaw: 0,
  minpitch: 0,
  maxpitch: 0,
  sl: { data: defaultShadowLightData(), lightstyletarget: null },
  music: null,
  instantitems: 0,
  radius: 0,
  hub_map: false,
  achievement: null,
  goals: null,
  image: null,
  fade_start_dist: 0,
  fade_end_dist: 0,
  start_items: null,
  no_grapple: 0,
  health_multiplier: 1.0,
  reinforcements: null,
  noise_start: null,
  noise_middle: null,
  noise_end: null,
  loop_count: 0,
  keys_specified: new Set<string>(),
};

// ---------------------------------------------------------------------------
// support routines for movement (changes in origin using velocity)
// ---------------------------------------------------------------------------

function G_GetMoveinfoSoundIndex(_self: EdictT, default_value: string | null, wanted_value: string | null): number {
  if (wanted_value === null) {
    if (default_value !== null) return gi.soundindex(default_value);
    return 0;
  } else if (wanted_value === "" || wanted_value === "0" || wanted_value === " ") {
    return 0;
  }
  return gi.soundindex(wanted_value);
}

export function G_SetMoveinfoSounds(self: EdictT, default_start: string | null, default_mid: string | null, default_end: string | null): void {
  self.moveinfo.sound_start = G_GetMoveinfoSoundIndex(self, default_start, st.noise_start);
  self.moveinfo.sound_middle = G_GetMoveinfoSoundIndex(self, default_mid, st.noise_middle);
  self.moveinfo.sound_end = G_GetMoveinfoSoundIndex(self, default_end, st.noise_end);
}

const Move_Done: ThinkFn = RegisterThink("Move_Done", (ent: EdictT): void => {
  VectorCopy(vec3_origin, ent.velocity);
  if (ent.moveinfo.endfunc === null) throw new Error("Move_Done: moveinfo.endfunc is null (g_func.cpp:81, unchecked in source)");
  ent.moveinfo.endfunc(ent);
});

const Move_Final: ThinkFn = RegisterThink("Move_Final", (ent: EdictT): void => {
  if (ent.moveinfo.remaining_distance === 0) {
    Move_Done(ent);
    return;
  }

  // [Paril-KEX] use exact remaining distance
  VectorCopy(vec3_muls(vec3_sub(ent.moveinfo.dest, ent.s.origin), 1 / gi.frame_time_s), ent.velocity);

  ent.think = Move_Done;
  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

const Move_Begin: ThinkFn = RegisterThink("Move_Begin", (ent: EdictT): void => {
  if (ent.moveinfo.speed * gi.frame_time_s >= ent.moveinfo.remaining_distance) {
    Move_Final(ent);
    return;
  }
  VectorCopy(vec3_muls(ent.moveinfo.dir, ent.moveinfo.speed), ent.velocity);
  const frames = Math.floor(ent.moveinfo.remaining_distance / ent.moveinfo.speed / gi.frame_time_s);
  ent.moveinfo.remaining_distance -= frames * ent.moveinfo.speed * gi.frame_time_s;
  ent.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms * frames));
  ent.think = Move_Final;
});

export function AccelerationDistance(target: number, rate: number): number {
  return (target * (target / rate + 1)) / 2;
}

function Move_Regular(ent: EdictT): void {
  const teamAnchor = (ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n ? ent.teammaster : ent;
  if (level.current_entity === teamAnchor) {
    Move_Begin(ent);
  } else {
    ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    ent.think = Move_Begin;
  }
}

export function plat_CalcAcceleratedMove(moveinfo: EdictT["moveinfo"]): void {
  if (moveinfo.remaining_distance < moveinfo.accel) {
    moveinfo.move_speed = moveinfo.speed;
    moveinfo.current_speed = moveinfo.remaining_distance;
    return;
  }

  const accel_dist = AccelerationDistance(moveinfo.speed, moveinfo.accel);
  let decel_dist = AccelerationDistance(moveinfo.speed, moveinfo.decel);

  if (moveinfo.remaining_distance - accel_dist - decel_dist < 0) {
    const f = (moveinfo.accel + moveinfo.decel) / (moveinfo.accel * moveinfo.decel);
    moveinfo.move_speed = moveinfo.current_speed = (-2 + Math.sqrt(4 - 4 * f * (-2 * moveinfo.remaining_distance))) / (2 * f);
    decel_dist = AccelerationDistance(moveinfo.move_speed, moveinfo.decel);
  } else {
    moveinfo.move_speed = moveinfo.speed;
  }

  moveinfo.decel_distance = decel_dist;
}

export function plat_Accelerate(moveinfo: EdictT["moveinfo"]): void {
  // are we decelerating?
  if (moveinfo.remaining_distance <= moveinfo.decel_distance) {
    if (moveinfo.remaining_distance < moveinfo.decel_distance) {
      if (moveinfo.next_speed) {
        moveinfo.current_speed = moveinfo.next_speed;
        moveinfo.next_speed = 0;
        return;
      }
      if (moveinfo.current_speed > moveinfo.decel) {
        moveinfo.current_speed -= moveinfo.decel;

        // [Paril-KEX] fix platforms in xdm6, etc
        if (Math.abs(moveinfo.current_speed) < 0.01) {
          moveinfo.current_speed = moveinfo.remaining_distance + 1;
        }
      }
    }
    return;
  }

  // are we at full speed and need to start decelerating during this move?
  if (moveinfo.current_speed === moveinfo.move_speed && moveinfo.remaining_distance - moveinfo.current_speed < moveinfo.decel_distance) {
    const p1_distance = moveinfo.remaining_distance - moveinfo.decel_distance;
    const p2_distance = moveinfo.move_speed * (1.0 - p1_distance / moveinfo.move_speed);
    const distance = p1_distance + p2_distance;
    moveinfo.current_speed = moveinfo.move_speed;
    moveinfo.next_speed = moveinfo.move_speed - moveinfo.decel * (p2_distance / distance);
    return;
  }

  // are we accelerating?
  if (moveinfo.current_speed < moveinfo.speed) {
    const old_speed = moveinfo.current_speed;

    // figure simple acceleration up to move_speed
    moveinfo.current_speed += moveinfo.accel;
    if (moveinfo.current_speed > moveinfo.speed) moveinfo.current_speed = moveinfo.speed;

    // are we accelerating throughout this entire move?
    if (moveinfo.remaining_distance - moveinfo.current_speed >= moveinfo.decel_distance) return;

    // during this move we will accelerate from current_speed to move_speed
    // and cross over the decel_distance; figure the average speed for the
    // entire move
    const p1_distance = moveinfo.remaining_distance - moveinfo.decel_distance;
    const p1_speed = (old_speed + moveinfo.move_speed) / 2.0;
    const p2_distance = moveinfo.move_speed * (1.0 - p1_distance / p1_speed);
    const distance = p1_distance + p2_distance;
    moveinfo.current_speed = p1_speed * (p1_distance / distance) + moveinfo.move_speed * (p2_distance / distance);
    moveinfo.next_speed = moveinfo.move_speed - moveinfo.decel * (p2_distance / distance);
    return;
  }

  // we are at constant velocity (move_speed)
}

export function Think_AccelMove_MoveInfo(moveinfo: EdictT["moveinfo"]): boolean {
  if (moveinfo.current_speed === 0) plat_CalcAcceleratedMove(moveinfo); // starting or blocked

  plat_Accelerate(moveinfo);

  // will the entire move complete on next frame?
  return moveinfo.remaining_distance > moveinfo.current_speed;
}

/** Paril: old acceleration code; here only to support old save games. */
const Think_AccelMove: ThinkFn = RegisterThink("Think_AccelMove", (ent: EdictT): void => {
  // [Paril-KEX] calculate distance dynamically
  if (ent.moveinfo.state === MoveStateT.STATE_UP) {
    ent.moveinfo.remaining_distance = vec3_length(vec3_sub(ent.moveinfo.start_origin, ent.s.origin));
  } else {
    ent.moveinfo.remaining_distance = vec3_length(vec3_sub(ent.moveinfo.end_origin, ent.s.origin));
  }

  // will the entire move complete on next frame?
  if (!Think_AccelMove_MoveInfo(ent.moveinfo)) {
    Move_Final(ent);
    return;
  }

  if (ent.moveinfo.remaining_distance <= ent.moveinfo.current_speed) {
    Move_Final(ent);
    return;
  }

  VectorCopy(vec3_muls(ent.moveinfo.dir, ent.moveinfo.current_speed * 10), ent.velocity);
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  ent.think = Think_AccelMove;
});

const Think_AccelMove_New: ThinkFn = RegisterThink("Think_AccelMove_New", (ent: EdictT): void => {
  let t = 0;
  let target_dist: number;
  const curve = ent.moveinfo.curve_positions;
  if (curve === null) throw new Error("Think_AccelMove_New: curve_positions is null (only reachable via Move_Calc's own setup)");

  if (ent.moveinfo.num_subframes) {
    if (ent.moveinfo.subframe === ent.moveinfo.num_subframes + 1) {
      ent.moveinfo.subframe = 0;
      ent.moveinfo.curve_frame++;

      if (ent.moveinfo.curve_frame === curve.length) {
        Move_Final(ent);
        return;
      }
    }

    t = (ent.moveinfo.subframe + 1) / (ent.moveinfo.num_subframes + 1);

    const from = curve[ent.moveinfo.curve_frame - 1];
    const to = curve[ent.moveinfo.curve_frame];
    target_dist = from + (to - from) * t;
    ent.moveinfo.subframe++;
  } else {
    if (ent.moveinfo.curve_frame === curve.length) {
      Move_Final(ent);
      return;
    }

    target_dist = curve[ent.moveinfo.curve_frame++];
  }

  ent.moveinfo.num_frames_done++;
  const target_pos = vec3_add(ent.moveinfo.curve_ref, vec3_muls(ent.moveinfo.dir, target_dist));
  VectorCopy(vec3_muls(vec3_sub(target_pos, ent.s.origin), 1 / gi.frame_time_s), ent.velocity);
  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

export function Move_Calc(ent: EdictT, dest: Vec3, endfunc: MoveinfoEndfuncFn): void {
  VectorCopy(vec3_origin, ent.velocity);
  VectorCopy(dest, ent.moveinfo.dest);
  VectorCopy(vec3_sub(dest, ent.s.origin), ent.moveinfo.dir);
  ent.moveinfo.remaining_distance = vec3_length(ent.moveinfo.dir);
  // normalize in place, matching vec3_t::normalize()'s mutate-and-return-length contract
  if (ent.moveinfo.remaining_distance) {
    const invLen = 1 / ent.moveinfo.remaining_distance;
    ent.moveinfo.dir[0] *= invLen;
    ent.moveinfo.dir[1] *= invLen;
    ent.moveinfo.dir[2] *= invLen;
  }
  ent.moveinfo.endfunc = endfunc;

  if (ent.moveinfo.speed === ent.moveinfo.accel && ent.moveinfo.speed === ent.moveinfo.decel) {
    Move_Regular(ent);
  } else {
    // accelerative
    ent.moveinfo.current_speed = 0;

    if (gi.tick_rate === 10) {
      ent.think = Think_AccelMove;
    } else {
      // [Paril-KEX] rewritten to work better at higher tickrates
      ent.moveinfo.curve_frame = 0;
      ent.moveinfo.num_subframes = 0.1 / gi.frame_time_s - 1;

      const total_dist = ent.moveinfo.remaining_distance;
      const distances: number[] = [];

      if (ent.moveinfo.num_subframes) {
        distances.push(0);
        ent.moveinfo.curve_frame = 1;
      } else {
        ent.moveinfo.curve_frame = 0;
      }

      // simulate 10hz movement
      while (ent.moveinfo.remaining_distance) {
        if (!Think_AccelMove_MoveInfo(ent.moveinfo)) break;

        ent.moveinfo.remaining_distance -= ent.moveinfo.current_speed;
        distances.push(total_dist - ent.moveinfo.remaining_distance);
      }

      if (ent.moveinfo.num_subframes) distances.push(total_dist);

      ent.moveinfo.subframe = 0;
      VectorCopy(ent.s.origin, ent.moveinfo.curve_ref);
      ent.moveinfo.curve_positions = Float32Array.from(distances);

      ent.moveinfo.num_frames_done = 0;

      ent.think = Think_AccelMove_New;
    }

    ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  }
}

// ---------------------------------------------------------------------------
// support routines for angular movement (changes in angle using avelocity)
// ---------------------------------------------------------------------------

const AngleMove_Done: ThinkFn = RegisterThink("AngleMove_Done", (ent: EdictT): void => {
  VectorCopy(vec3_origin, ent.avelocity);
  if (ent.moveinfo.endfunc === null) throw new Error("AngleMove_Done: moveinfo.endfunc is null (g_func.cpp:249, unchecked in source)");
  ent.moveinfo.endfunc(ent);
});

const AngleMove_Final: ThinkFn = RegisterThink("AngleMove_Final", (ent: EdictT): void => {
  let move: Vec3;

  if (ent.moveinfo.state === MoveStateT.STATE_UP) {
    move = ent.moveinfo.reversing ? vec3_sub(ent.moveinfo.end_angles_reversed, ent.s.angles) : vec3_sub(ent.moveinfo.end_angles, ent.s.angles);
  } else {
    move = vec3_sub(ent.moveinfo.start_angles, ent.s.angles);
  }

  if (!vec3_any_nonzero(move)) {
    AngleMove_Done(ent);
    return;
  }

  VectorCopy(vec3_muls(move, 1.0 / gi.frame_time_s), ent.avelocity);

  ent.think = AngleMove_Done;
  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

const AngleMove_Begin: ThinkFn = RegisterThink("AngleMove_Begin", (ent: EdictT): void => {
  // PGM accelerate as needed
  if (ent.moveinfo.speed < ent.speed) {
    ent.moveinfo.speed += ent.accel;
    if (ent.moveinfo.speed > ent.speed) ent.moveinfo.speed = ent.speed;
  }

  // set destdelta to the vector needed to move
  let destdelta: Vec3;
  if (ent.moveinfo.state === MoveStateT.STATE_UP) {
    destdelta = ent.moveinfo.reversing ? vec3_sub(ent.moveinfo.end_angles_reversed, ent.s.angles) : vec3_sub(ent.moveinfo.end_angles, ent.s.angles);
  } else {
    destdelta = vec3_sub(ent.moveinfo.start_angles, ent.s.angles);
  }

  // calculate length of vector
  const len = vec3_length(destdelta);

  // divide by speed to get time to reach dest
  const traveltime = len / ent.moveinfo.speed;

  if (traveltime < gi.frame_time_s) {
    AngleMove_Final(ent);
    return;
  }

  const frames = Math.floor(traveltime / gi.frame_time_s);

  // scale the destdelta vector by the time spent traveling to get velocity
  VectorCopy(vec3_muls(destdelta, 1.0 / traveltime), ent.avelocity);

  // PGM if we're done accelerating, act as a normal rotation
  if (ent.moveinfo.speed >= ent.speed) {
    ent.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms * frames));
    ent.think = AngleMove_Final;
  } else {
    ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    ent.think = AngleMove_Begin;
  }
});

export function AngleMove_Calc(ent: EdictT, endfunc: MoveinfoEndfuncFn): void {
  VectorCopy(vec3_origin, ent.avelocity);
  ent.moveinfo.endfunc = endfunc;

  // PGM if we're supposed to accelerate, this will tell AngleMove_Begin to do so
  if (ent.accel !== ent.speed) ent.moveinfo.speed = 0;

  const teamAnchor = (ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n ? ent.teammaster : ent;
  if (level.current_entity === teamAnchor) {
    AngleMove_Begin(ent);
  } else {
    ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    ent.think = AngleMove_Begin;
  }
}

/*
=========================================================
  PLATS
=========================================================
*/

const SPAWNFLAG_PLAT_LOW_TRIGGER: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_PLAT_NO_MONSTER: SpawnFlags = SpawnFlags_from(2);

/** Real implementation -- see file header "THE plat2 BOUNDARY". Runs
 *  unconditionally for every func_plat (rerelease/rogue/g_rogue_func.cpp:
 *  29-35 checks nothing plat2-specific either); a no-op today since
 *  plat2_spawn_danger_area below never actually creates a "bad_area"
 *  entity, but the correct, forward-compatible cleanup walk regardless. */
function plat2_kill_danger_area(ent: EdictT): void {
  let t: EdictT | null = null;
  for (;;) {
    t = G_FindByString(t, "classname", "bad_area");
    if (t === null) break;
    if (t.owner === ent) G_FreeEdict(t);
  }
}

const plat_go_down: ThinkFn = RegisterThink("plat_go_down", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_start) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }

  ent.s.sound = ent.moveinfo.sound_middle;

  ent.moveinfo.state = MoveStateT.STATE_DOWN;
  Move_Calc(ent, ent.moveinfo.end_origin, plat_hit_bottom);
});

const plat_hit_top: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("plat_hit_top", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_end) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
  }
  ent.s.sound = 0;
  ent.moveinfo.state = MoveStateT.STATE_TOP;

  ent.think = plat_go_down;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(3));
});

const plat_hit_bottom: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("plat_hit_bottom", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_end) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
  }
  ent.s.sound = 0;
  ent.moveinfo.state = MoveStateT.STATE_BOTTOM;

  // ROGUE
  plat2_kill_danger_area(ent);
  // ROGUE
});

function plat_go_up(ent: EdictT): void {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_start) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }

  ent.s.sound = ent.moveinfo.sound_middle;

  ent.moveinfo.state = MoveStateT.STATE_UP;
  Move_Calc(ent, ent.moveinfo.start_origin, plat_hit_top);

  // ROGUE
  plat2_spawn_danger_area(ent);
  // ROGUE
}

const plat_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("plat_blocked", (self: EdictT, other: EdictT): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
    // if it's still there, nuke it
    if (other.inuse && other.solid !== SolidT.SOLID_NOT) BecomeExplosion1(other);
    return;
  }

  // PGM gib dead things
  if (other.health < 1) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));

  // [Paril-KEX] killed the thing, so don't switch directions
  if (!other.inuse || other.solid === SolidT.SOLID_NOT) return;

  if (self.moveinfo.state === MoveStateT.STATE_UP) plat_go_down(self);
  else if (self.moveinfo.state === MoveStateT.STATE_DOWN) plat_go_up(self);
});

const Use_Plat: UseFn = RegisterUse("Use_Plat", (ent: EdictT, other: EdictT | null, _activator: EdictT | null): void => {
  // ROGUE: if a monster is using us, then allow the activity when stopped.
  if (other !== null && (other.svflags & SvflagsT.SVF_MONSTER) !== 0 && !SpawnFlags_has(ent.spawnflags, SPAWNFLAG_PLAT_NO_MONSTER)) {
    if (ent.moveinfo.state === MoveStateT.STATE_TOP) plat_go_down(ent);
    else if (ent.moveinfo.state === MoveStateT.STATE_BOTTOM) plat_go_up(ent);
    return;
  }

  if (ent.think !== null) return; // already down
  plat_go_down(ent);
});

const Touch_Plat_Center: TouchFn = RegisterTouch("Touch_Plat_Center", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.client === null) return;
  if (other.health <= 0) return;

  const plat = self.enemy; // now point at the plat, not the trigger
  if (plat === null) throw new Error("Touch_Plat_Center: self.enemy is null (always the plat, set by plat_spawn_inside_trigger)");
  if (plat.moveinfo.state === MoveStateT.STATE_BOTTOM) plat_go_up(plat);
  else if (plat.moveinfo.state === MoveStateT.STATE_TOP) plat.nextthink = Gtime_add(level.time, Gtime_from_sec(1)); // still on the plat, delay going down
});

/** PGM - plat2's change the trigger field. Exported (rogue/g_rogue_func.ts
 *  unit): `plat2_activate`/`SP_func_plat2` (rerelease/rogue/g_rogue_func.cpp)
 *  call this exact function -- a one-word visibility change, no logic
 *  touched. See rogue/g_rogue_func.ts's own header, "`plat_spawn_inside_trigger`"
 *  section, for the full rationale. */
export function plat_spawn_inside_trigger(ent: EdictT): EdictT {
  const trigger = G_Spawn();
  trigger.touch = Touch_Plat_Center;
  trigger.movetype = MovetypeT.MOVETYPE_NONE;
  trigger.solid = SolidT.SOLID_TRIGGER;
  trigger.enemy = ent;

  const tmin = vec3(ent.mins[0] + 25, ent.mins[1] + 25, ent.mins[2]);
  const tmax = vec3(ent.maxs[0] - 25, ent.maxs[1] - 25, ent.maxs[2] + 8);

  tmin[2] = (tmax[2]) - ((ent.pos1[2]) - (ent.pos2[2]) + st.lip);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_PLAT_LOW_TRIGGER)) {
    tmax[2] = (tmin[2]) + 8;
  }

  if ((tmax[0]) - (tmin[0]) <= 0) {
    tmin[0] = ((ent.mins[0]) + (ent.maxs[0])) * 0.5;
    tmax[0] = (tmin[0]) + 1;
  }
  if ((tmax[1]) - (tmin[1]) <= 0) {
    tmin[1] = ((ent.mins[1]) + (ent.maxs[1])) * 0.5;
    tmax[1] = (tmin[1]) + 1;
  }

  VectorCopy(tmin, trigger.mins);
  VectorCopy(tmax, trigger.maxs);

  gi.linkentity(trigger);

  return trigger; // PGM 11/17/97
}

export function SP_func_plat(ent: EdictT): void {
  VectorCopy(vec3_origin, ent.s.angles);
  ent.solid = SolidT.SOLID_BSP;
  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  if (ent.model !== null) gi.setmodel(ent, ent.model);

  ent.moveinfo.blocked = plat_blocked;

  if (!ent.speed) ent.speed = 20;
  else ent.speed *= 0.1;

  if (!ent.accel) ent.accel = 5;
  else ent.accel *= 0.1;

  if (!ent.decel) ent.decel = 5;
  else ent.decel *= 0.1;

  if (!ent.dmg) ent.dmg = 2;

  if (!st.lip) st.lip = 8;

  // pos1 is the top position, pos2 is the bottom
  VectorCopy(ent.s.origin, ent.pos1);
  VectorCopy(ent.s.origin, ent.pos2);
  if (st.height) ent.pos2[2] -= st.height;
  else ent.pos2[2] -= (ent.maxs[2]) - (ent.mins[2]) - st.lip;

  ent.use = Use_Plat;

  plat_spawn_inside_trigger(ent); // the "start moving" trigger

  if (ent.targetname) {
    ent.moveinfo.state = MoveStateT.STATE_UP;
  } else {
    VectorCopy(ent.pos2, ent.s.origin);
    gi.linkentity(ent);
    ent.moveinfo.state = MoveStateT.STATE_BOTTOM;
  }

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  G_SetMoveinfoSounds(ent, "plats/pt1_strt.wav", "plats/pt1_mid.wav", "plats/pt1_end.wav");
}

// ---------------------------------------------------------------------------
// func_rotating / func_spinning
// ---------------------------------------------------------------------------

const SPAWNFLAG_ROTATING_START_ON: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_ROTATING_REVERSE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_ROTATING_X_AXIS: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_ROTATING_Y_AXIS: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_ROTATING_TOUCH_PAIN: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_ROTATING_STOP: SpawnFlags = SpawnFlags_from(32);
const SPAWNFLAG_ROTATING_ANIMATED: SpawnFlags = SpawnFlags_from(64);
const SPAWNFLAG_ROTATING_ANIMATED_FAST: SpawnFlags = SpawnFlags_from(128);
const SPAWNFLAG_ROTATING_ACCEL: SpawnFlags = SpawnFlags_from(0x00010000);

const rotating_accel: ThinkFn = RegisterThink("rotating_accel", (self: EdictT): void => {
  const current_speed = vec3_length(self.avelocity);
  if (current_speed >= self.speed - self.accel) {
    // done
    VectorCopy(vec3_muls(self.movedir, self.speed), self.avelocity);
    G_UseTargets(self, self);
  } else {
    const next_speed = current_speed + self.accel;
    VectorCopy(vec3_muls(self.movedir, next_speed), self.avelocity);
    self.think = rotating_accel;
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  }
});

const rotating_decel: ThinkFn = RegisterThink("rotating_decel", (self: EdictT): void => {
  const current_speed = vec3_length(self.avelocity);
  if (current_speed <= self.decel) {
    // done
    VectorCopy(vec3_origin, self.avelocity);
    G_UseTargets(self, self);
    self.touch = null;
  } else {
    const next_speed = current_speed - self.decel;
    VectorCopy(vec3_muls(self.movedir, next_speed), self.avelocity);
    self.think = rotating_decel;
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  }
});

const rotating_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("rotating_blocked", (self: EdictT, other: EdictT): void => {
  if (!self.dmg) return;
  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = Gtime_add(level.time, Gtime_from_hz(10));
  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
});

const rotating_touch: TouchFn = RegisterTouch("rotating_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (vec3_any_nonzero(self.avelocity)) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
  }
});

const rotating_use: UseFn = RegisterUse("rotating_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (vec3_any_nonzero(self.avelocity)) {
    self.s.sound = 0;
    // PGM
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_ACCEL)) {
      // Decelerate
      rotating_decel(self);
    } else {
      VectorCopy(vec3_origin, self.avelocity);
      G_UseTargets(self, self);
      self.touch = null;
    }
  } else {
    self.s.sound = self.moveinfo.sound_middle;
    // PGM
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_ACCEL)) {
      // accelerate
      rotating_accel(self);
    } else {
      VectorCopy(vec3_muls(self.movedir, self.speed), self.avelocity);
      G_UseTargets(self, self);
    }
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_TOUCH_PAIN)) self.touch = rotating_touch;
  }
});

export function SP_func_rotating(ent: EdictT): void {
  ent.solid = SolidT.SOLID_BSP;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_STOP)) ent.movetype = MovetypeT.MOVETYPE_STOP;
  else ent.movetype = MovetypeT.MOVETYPE_PUSH;

  if (st.noise !== null) {
    ent.moveinfo.sound_middle = gi.soundindex(st.noise);

    // [Paril-KEX] for rhangar1 doors
    if (!st.keys_specified.has("attenuation")) {
      ent.attenuation = ATTN_STATIC;
    } else {
      if (ent.attenuation === -1) {
        ent.s.loop_attenuation = ATTN_LOOP_NONE;
        ent.attenuation = ATTN_NONE;
      } else {
        ent.s.loop_attenuation = ent.attenuation;
      }
    }
  }

  // set the axis of rotation
  VectorCopy(vec3_origin, ent.movedir);
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_X_AXIS)) ent.movedir[2] = 1.0;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_Y_AXIS)) ent.movedir[0] = 1.0;
  else ent.movedir[1] = 1.0; // Z_AXIS

  // check for reverse rotation
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_REVERSE)) {
    ent.movedir[0] = -ent.movedir[0];
    ent.movedir[1] = -ent.movedir[1];
    ent.movedir[2] = -ent.movedir[2];
  }

  if (!ent.speed) ent.speed = 100;
  if (!st.keys_specified.has("dmg")) ent.dmg = 2;

  ent.use = rotating_use;
  if (ent.dmg) ent.moveinfo.blocked = rotating_blocked;

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_START_ON)) {
    if (ent.use === null) throw new Error("SP_func_rotating: ent.use is null immediately after assignment");
    ent.use(ent, null, null);
  }

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_ANIMATED)) ent.s.effects |= EffectsT.EF_ANIM_ALL;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_ANIMATED_FAST)) ent.s.effects |= EffectsT.EF_ANIM_ALLFAST;

  // PGM
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ROTATING_ACCEL)) {
    // Accelerate / Decelerate
    if (!ent.accel) ent.accel = 1;
    else if (ent.accel > ent.speed) ent.accel = ent.speed;

    if (!ent.decel) ent.decel = 1;
    else if (ent.decel > ent.speed) ent.decel = ent.speed;
  }

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  gi.linkentity(ent);
}

/** [Paril-KEX] */
const func_spinning_think: ThinkFn = RegisterThink("func_spinning_think", (ent: EdictT): void => {
  if (ent.timestamp <= level.time) {
    ent.timestamp = Gtime_add(level.time, /* random_time(1_sec, 6_sec) */ Gtime_from_ms(1000 + Math.trunc(Math.random() * 5000)));
    const spread = ent.speed - ent.decel;
    ent.movedir[0] = ent.decel + frandom(spread);
    ent.movedir[1] = ent.decel + frandom(spread);
    ent.movedir[2] = ent.decel + frandom(spread);

    for (let i = 0; i < 3; i++) {
      if (brandom()) ent.movedir[i] = -(ent.movedir[i]);
    }
  }

  for (let i = 0; i < 3; i++) {
    if (ent.avelocity[i] === ent.movedir[i]) continue;

    if ((ent.avelocity[i]) < (ent.movedir[i])) {
      ent.avelocity[i] = Math.min(ent.movedir[i], (ent.avelocity[i]) + ent.accel);
    } else {
      ent.avelocity[i] = Math.max(ent.movedir[i], (ent.avelocity[i]) - ent.accel);
    }
  }

  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

/** [Paril-KEX] */
export function SP_func_spinning(ent: EdictT): void {
  ent.solid = SolidT.SOLID_BSP;

  if (!ent.speed) ent.speed = 100;
  if (!ent.dmg) ent.dmg = 2;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  ent.timestamp = Gtime_from_ms(0);
  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  ent.think = func_spinning_think;

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// func_button
// ---------------------------------------------------------------------------

const button_done: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("button_done", (self: EdictT): void => {
  self.moveinfo.state = MoveStateT.STATE_BOTTOM;
  if (!self.bmodel_anim.enabled) {
    if (level.is_n64) self.s.frame = 0;
    else self.s.effects &= ~EffectsT.EF_ANIM23;
    self.s.effects |= EffectsT.EF_ANIM01;
  } else {
    self.bmodel_anim.alternate = false;
  }
});

const button_return: ThinkFn = RegisterThink("button_return", (self: EdictT): void => {
  self.moveinfo.state = MoveStateT.STATE_DOWN;

  Move_Calc(self, self.moveinfo.start_origin, button_done);

  if (self.health) self.takedamage = true;
});

const button_wait: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("button_wait", (self: EdictT): void => {
  self.moveinfo.state = MoveStateT.STATE_TOP;

  if (!self.bmodel_anim.enabled) {
    self.s.effects &= ~EffectsT.EF_ANIM01;
    if (level.is_n64) self.s.frame = 2;
    else self.s.effects |= EffectsT.EF_ANIM23;
  } else {
    self.bmodel_anim.alternate = true;
  }

  G_UseTargets(self, self.activator);

  if (self.moveinfo.wait >= 0) {
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.moveinfo.wait));
    self.think = button_return;
  }
});

function button_fire(self: EdictT): void {
  if (self.moveinfo.state === MoveStateT.STATE_UP || self.moveinfo.state === MoveStateT.STATE_TOP) return;

  self.moveinfo.state = MoveStateT.STATE_UP;
  if (self.moveinfo.sound_start && (self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }
  Move_Calc(self, self.moveinfo.end_origin, button_wait);
}

const button_use: UseFn = RegisterUse("button_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.activator = activator;
  button_fire(self);
});

const button_touch: TouchFn = RegisterTouch("button_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.client === null) return;
  if (other.health <= 0) return;

  self.activator = other;
  button_fire(self);
});

const button_killed: DieFn = RegisterDie(
  "button_killed",
  (self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    self.activator = attacker;
    self.health = self.max_health;
    self.takedamage = false;
    button_fire(self);
  },
);

export function SP_func_button(ent: EdictT): void {
  const movedir = vec3(0, 0, 0);
  G_SetMovedir(ent.s.angles, movedir);
  VectorCopy(movedir, ent.movedir);
  ent.movetype = MovetypeT.MOVETYPE_STOP;
  ent.solid = SolidT.SOLID_BSP;
  if (ent.model !== null) gi.setmodel(ent, ent.model);

  if (ent.sounds !== 1) G_SetMoveinfoSounds(ent, "switches/butn2.wav", null, null);
  else G_SetMoveinfoSounds(ent, null, null, null);

  if (!ent.speed) ent.speed = 40;
  if (!ent.accel) ent.accel = ent.speed;
  if (!ent.decel) ent.decel = ent.speed;

  if (!ent.wait) ent.wait = 3;
  if (!st.lip) st.lip = 4;

  VectorCopy(ent.s.origin, ent.pos1);
  const abs_movedir = vec3(Math.abs(ent.movedir[0]), Math.abs(ent.movedir[1]), Math.abs(ent.movedir[2]));
  const dist =
    (abs_movedir[0]) * (ent.size[0]) + (abs_movedir[1]) * (ent.size[1]) + (abs_movedir[2]) * (ent.size[2]) - st.lip;
  VectorCopy(vec3_add(ent.pos1, vec3_muls(ent.movedir, dist)), ent.pos2);

  ent.use = button_use;

  if (!ent.bmodel_anim.enabled) ent.s.effects |= EffectsT.EF_ANIM01;

  if (ent.health) {
    ent.max_health = ent.health;
    ent.die = button_killed;
    ent.takedamage = true;
  } else if (!ent.targetname) {
    ent.touch = button_touch;
  }

  ent.moveinfo.state = MoveStateT.STATE_BOTTOM;

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// doors: func_door / func_door_rotating / func_water (+ ROGUE smart water)
// ---------------------------------------------------------------------------

const SPAWNFLAG_DOOR_START_OPEN: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_DOOR_CRUSHER: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_DOOR_NOMONSTER: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_DOOR_ANIMATED: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_DOOR_TOGGLE: SpawnFlags = SpawnFlags_from(32);
const SPAWNFLAG_DOOR_ANIMATED_FAST: SpawnFlags = SpawnFlags_from(64);

const SPAWNFLAG_DOOR_ROTATING_X_AXIS: SpawnFlags = SpawnFlags_from(64);
const SPAWNFLAG_DOOR_ROTATING_Y_AXIS: SpawnFlags = SpawnFlags_from(128);
const SPAWNFLAG_DOOR_ROTATING_INACTIVE: SpawnFlags = SpawnFlags_from(0x10000);
const SPAWNFLAG_DOOR_ROTATING_SAFE_OPEN: SpawnFlags = SpawnFlags_from(0x20000);

/** g_utils.ts's `G_FindByString(from, "targetname", value)`, walked to
 *  exhaustion -- mirrors the C++ `while ((t =
 *  G_FindByString<&edict_t::targetname>(t, self->target)))`. */
function door_use_areaportals(self: EdictT, open: boolean): void {
  if (self.target === null) return;

  let t: EdictT | null = null;
  for (;;) {
    t = G_FindByString(t, "targetname", self.target);
    if (t === null) break;
    if (t.classname === "func_areaportal") gi.SetAreaPortalState(t.style, open);
  }
}

function door_play_sound(self: EdictT, sound: number): void {
  if (self.teammaster === null) {
    gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, sound, 1, self.attenuation, 0);
    return;
  }

  const p = vec3(0, 0, 0);
  let c = 0;

  for (let t: EdictT | null = self.teammaster; t !== null; t = t.teamchain) {
    vec3_addEq(p, vec3_muls(vec3_add(t.absmin, t.absmax), 0.5));
    c++;
  }

  if (c === 1) {
    gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, sound, 1, self.attenuation, 0);
    return;
  }

  vec3_divEqs(p, c);

  if ((gi.pointcontents(p) & ContentsT.CONTENTS_SOLID) !== 0) {
    gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, sound, 1, self.attenuation, 0);
    return;
  }

  gi.positioned_sound(p, self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, sound, 1, self.attenuation, 0);
}

const door_hit_top: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("door_hit_top", (self: EdictT): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (self.moveinfo.sound_end) door_play_sound(self, self.moveinfo.sound_end);
  }
  self.s.sound = 0;
  self.moveinfo.state = MoveStateT.STATE_TOP;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_TOGGLE)) return;
  if (self.moveinfo.wait >= 0) {
    self.think = door_go_down;
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.moveinfo.wait));
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) door_use_areaportals(self, false);
});

const door_hit_bottom: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("door_hit_bottom", (self: EdictT): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (self.moveinfo.sound_end) door_play_sound(self, self.moveinfo.sound_end);
  }
  self.s.sound = 0;
  self.moveinfo.state = MoveStateT.STATE_BOTTOM;

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) door_use_areaportals(self, false);
});

const door_go_down: ThinkFn = RegisterThink("door_go_down", (self: EdictT): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (self.moveinfo.sound_start) door_play_sound(self, self.moveinfo.sound_start);
  }

  self.s.sound = self.moveinfo.sound_middle;

  if (self.max_health) {
    self.takedamage = true;
    self.health = self.max_health;
  }

  self.moveinfo.state = MoveStateT.STATE_DOWN;
  if (self.classname === "func_door" || self.classname === "func_water" || self.classname === "func_door_secret") {
    Move_Calc(self, self.moveinfo.start_origin, door_hit_bottom);
  } else if (self.classname === "func_door_rotating") {
    AngleMove_Calc(self, door_hit_bottom);
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) door_use_areaportals(self, true);
});

function door_go_up(self: EdictT, activator: EdictT | null): void {
  if (self.moveinfo.state === MoveStateT.STATE_UP) return; // already going up

  if (self.moveinfo.state === MoveStateT.STATE_TOP) {
    // reset top wait time
    if (self.moveinfo.wait >= 0) self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.moveinfo.wait));
    return;
  }

  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (self.moveinfo.sound_start) door_play_sound(self, self.moveinfo.sound_start);
  }

  self.s.sound = self.moveinfo.sound_middle;

  self.moveinfo.state = MoveStateT.STATE_UP;
  if (self.classname === "func_door" || self.classname === "func_water" || self.classname === "func_door_secret") {
    Move_Calc(self, self.moveinfo.end_origin, door_hit_top);
  } else if (self.classname === "func_door_rotating") {
    AngleMove_Calc(self, door_hit_top);
  }

  G_UseTargets(self, activator);

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) door_use_areaportals(self, true);
}

// PGM
const smart_water_go_up: ThinkFn = RegisterThink("smart_water_go_up", (self: EdictT): void => {
  if (self.moveinfo.state === MoveStateT.STATE_TOP) {
    // reset top wait time
    if (self.moveinfo.wait >= 0) self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.moveinfo.wait));
    return;
  }

  if (self.health) {
    if ((self.absmax[2]) >= self.health) {
      VectorCopy(vec3_origin, self.velocity);
      self.nextthink = Gtime_from_ms(0);
      self.moveinfo.state = MoveStateT.STATE_TOP;
      return;
    }
  }

  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (self.moveinfo.sound_start) gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }

  self.s.sound = self.moveinfo.sound_middle;

  // find the lowest player point.
  let lowestPlayerPt = 999999;
  let lowestPlayer: EdictT | null = null;
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined) continue;

    // don't count dead or unused player slots
    if (ent.inuse && ent.health > 0) {
      if ((ent.absmin[2]) < lowestPlayerPt) {
        lowestPlayerPt = ent.absmin[2];
        lowestPlayer = ent;
      }
    }
  }

  if (lowestPlayer === null) return;

  const distance = lowestPlayerPt - (self.absmax[2]);

  // for the calculations, make sure we intend to go up at least a little.
  if (distance < self.accel) {
    self.moveinfo.speed = 5;
  } else {
    self.moveinfo.speed = distance / self.accel;
  }

  if (self.moveinfo.speed < 5) self.moveinfo.speed = 5;
  else if (self.moveinfo.speed > self.speed) self.moveinfo.speed = self.speed;

  // FIXME - should this allow any movement other than straight up?
  VectorCopy(vec3(0, 0, 1), self.moveinfo.dir);
  VectorCopy(vec3_muls(self.moveinfo.dir, self.moveinfo.speed), self.velocity);
  self.moveinfo.remaining_distance = distance < self.accel ? 100 : distance;

  if (self.moveinfo.state !== MoveStateT.STATE_UP) {
    G_UseTargets(self, lowestPlayer);
    door_use_areaportals(self, true);
    self.moveinfo.state = MoveStateT.STATE_UP;
  }

  self.think = smart_water_go_up;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

const door_use: UseFn = RegisterUse("door_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return;

  if (
    self.classname === "func_door_rotating" &&
    SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_ROTATING_SAFE_OPEN) &&
    (self.moveinfo.state === MoveStateT.STATE_BOTTOM || self.moveinfo.state === MoveStateT.STATE_DOWN)
  ) {
    if (vec3_any_nonzero(self.moveinfo.dir)) {
      if (activator === null) throw new Error("door_use: SAFE_OPEN reversing check needs a non-null activator (unchecked in source)");
      const forward = vec3_normalized(vec3_sub(activator.s.origin, self.s.origin));
      self.moveinfo.reversing = vec3_dot(forward, self.moveinfo.dir) > 0;
    }
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_TOGGLE)) {
    if (self.moveinfo.state === MoveStateT.STATE_UP || self.moveinfo.state === MoveStateT.STATE_TOP) {
      // trigger all paired doors
      for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
        ent.message = null;
        ent.touch = null;
        door_go_down(ent);
      }
      return;
    }
  }

  // PGM smart water is different
  const center = vec3_muls(vec3_add(self.mins, self.maxs), 0.5);
  if (self.classname === "func_water" && (gi.pointcontents(center) & MASK_WATER) !== 0 && SpawnFlags_has(self.spawnflags, SPAWNFLAG_WATER_SMART)) {
    self.message = null;
    self.touch = null;
    self.enemy = activator;
    smart_water_go_up(self);
    return;
  }

  // trigger all paired doors
  for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
    ent.message = null;
    ent.touch = null;
    door_go_up(ent, activator);
  }
});

const Touch_DoorTrigger: TouchFn = RegisterTouch("Touch_DoorTrigger", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.health <= 0) return;

  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) return;

  if (self.owner === null) throw new Error("Touch_DoorTrigger: self.owner is null (always the door, set by Think_SpawnDoorTrigger)");
  if (SpawnFlags_has(self.owner.spawnflags, SPAWNFLAG_DOOR_NOMONSTER) && (other.svflags & SvflagsT.SVF_MONSTER) !== 0) return;

  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = Gtime_add(level.time, Gtime_from_sec(1));

  door_use(self.owner, other, other);
});

const Think_CalcMoveSpeed: ThinkFn = RegisterThink("Think_CalcMoveSpeed", (self: EdictT): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return; // only the team master does this

  // find the smallest distance any member of the team will be moving
  let min = Math.abs(self.moveinfo.distance);
  for (let ent: EdictT | null = self.teamchain; ent !== null; ent = ent.teamchain) {
    const dist = Math.abs(ent.moveinfo.distance);
    if (dist < min) min = dist;
  }

  const time = min / self.moveinfo.speed;

  // adjust speeds so they will all complete at the same time
  for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
    const newspeed = Math.abs(ent.moveinfo.distance) / time;
    const ratio = newspeed / ent.moveinfo.speed;
    if (ent.moveinfo.accel === ent.moveinfo.speed) ent.moveinfo.accel = newspeed;
    else ent.moveinfo.accel *= ratio;
    if (ent.moveinfo.decel === ent.moveinfo.speed) ent.moveinfo.decel = newspeed;
    else ent.moveinfo.decel *= ratio;
    ent.moveinfo.speed = newspeed;
  }
});

const Think_SpawnDoorTrigger: ThinkFn = RegisterThink("Think_SpawnDoorTrigger", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return; // only the team leader spawns a trigger

  const mins = vec3(ent.absmin[0], ent.absmin[1], ent.absmin[2]);
  const maxs = vec3(ent.absmax[0], ent.absmax[1], ent.absmax[2]);

  for (let other: EdictT | null = ent.teamchain; other !== null; other = other.teamchain) {
    addPointToBoundsLocal(other.absmin, mins, maxs);
    addPointToBoundsLocal(other.absmax, mins, maxs);
  }

  // expand
  mins[0] -= 60;
  mins[1] -= 60;
  maxs[0] += 60;
  maxs[1] += 60;

  const other = G_Spawn();
  VectorCopy(mins, other.mins);
  VectorCopy(maxs, other.maxs);
  other.owner = ent;
  other.solid = SolidT.SOLID_TRIGGER;
  other.movetype = MovetypeT.MOVETYPE_NONE;
  other.touch = Touch_DoorTrigger;
  gi.linkentity(other);

  Think_CalcMoveSpeed(ent);
});

function addPointToBoundsLocal(v: Vec3, mins: Vec3, maxs: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if ((v[i]) < (mins[i])) mins[i] = v[i];
    if ((v[i]) > (maxs[i])) maxs[i] = v[i];
  }
}

const door_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("door_blocked", (self: EdictT, other: EdictT): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  if (self.dmg && !(level.time < self.touch_debounce_time)) {
    self.touch_debounce_time = Gtime_add(level.time, Gtime_from_hz(10));
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
  }

  // [Paril-KEX] don't allow wait -1 doors to return
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_CRUSHER) || self.wait === -1) return;

  // if a door has a negative wait, it would never come back if blocked,
  // so let it just squash the object to death real fast
  if (self.moveinfo.wait >= 0) {
    if (self.moveinfo.state === MoveStateT.STATE_DOWN) {
      for (let ent: EdictT | null = self.teammaster; ent !== null; ent = ent.teamchain) door_go_up(ent, ent.activator);
    } else {
      for (let ent: EdictT | null = self.teammaster; ent !== null; ent = ent.teamchain) door_go_down(ent);
    }
  }
});

const door_killed: DieFn = RegisterDie(
  "door_killed",
  (self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    for (let ent: EdictT | null = self.teammaster; ent !== null; ent = ent.teamchain) {
      ent.health = ent.max_health;
      ent.takedamage = false;
    }
    if (self.teammaster === null) throw new Error("door_killed: self.teammaster is null (every SP_func_door* ensures a team of at least one)");
    door_use(self.teammaster, attacker, attacker);
  },
);

const door_touch: TouchFn = RegisterTouch("door_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.client === null) return;

  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = Gtime_add(level.time, Gtime_from_sec(5));

  gi.Center_Print(other, self.message ?? "");
  gi.sound(other, SoundchanT.CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
});

const Think_DoorActivateAreaPortal: ThinkFn = RegisterThink("Think_DoorActivateAreaPortal", (ent: EdictT): void => {
  door_use_areaportals(ent, true);

  if (ent.health || ent.targetname) Think_CalcMoveSpeed(ent);
  else Think_SpawnDoorTrigger(ent);
});

export function SP_func_door(ent: EdictT): void {
  if (ent.sounds !== 1) G_SetMoveinfoSounds(ent, "doors/dr1_strt.wav", "doors/dr1_mid.wav", "doors/dr1_end.wav");
  else G_SetMoveinfoSounds(ent, null, null, null);

  // [Paril-KEX] for rhangar1 doors
  if (!st.keys_specified.has("attenuation")) {
    ent.attenuation = ATTN_STATIC;
  } else {
    if (ent.attenuation === -1) {
      ent.s.loop_attenuation = ATTN_LOOP_NONE;
      ent.attenuation = ATTN_NONE;
    } else {
      ent.s.loop_attenuation = ent.attenuation;
    }
  }

  const movedir = vec3(0, 0, 0);
  G_SetMovedir(ent.s.angles, movedir);
  VectorCopy(movedir, ent.movedir);
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  ent.svflags |= SvflagsT.SVF_DOOR;
  if (ent.model !== null) gi.setmodel(ent, ent.model);

  ent.moveinfo.blocked = door_blocked;
  ent.use = door_use;

  if (!ent.speed) ent.speed = 100;
  if (cvarOrDefault("deathmatch", "0").value !== 0) ent.speed *= 2;

  if (!ent.accel) ent.accel = ent.speed;
  if (!ent.decel) ent.decel = ent.speed;

  if (!ent.wait) ent.wait = 3;
  if (!st.lip) st.lip = 8;
  if (!ent.dmg) ent.dmg = 2;

  // calculate second position
  VectorCopy(ent.s.origin, ent.pos1);
  const abs_movedir = vec3(Math.abs(ent.movedir[0]), Math.abs(ent.movedir[1]), Math.abs(ent.movedir[2]));
  ent.moveinfo.distance =
    (abs_movedir[0]) * (ent.size[0]) + (abs_movedir[1]) * (ent.size[1]) + (abs_movedir[2]) * (ent.size[2]) - st.lip;
  VectorCopy(vec3_add(ent.pos1, vec3_muls(ent.movedir, ent.moveinfo.distance)), ent.pos2);

  // if it starts open, switch the positions
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) {
    VectorCopy(ent.pos2, ent.s.origin);
    const tmp = vec3(ent.pos1[0], ent.pos1[1], ent.pos1[2]);
    VectorCopy(ent.pos2, ent.pos1);
    VectorCopy(tmp, ent.pos2);
    VectorCopy(ent.s.origin, ent.pos1);
  }

  ent.moveinfo.state = MoveStateT.STATE_BOTTOM;

  if (ent.health) {
    ent.takedamage = true;
    ent.die = door_killed;
    ent.max_health = ent.health;
  } else if (ent.targetname) {
    if (ent.message !== null) {
      gi.soundindex("misc/talk.wav");
      ent.touch = door_touch;
    }
    ent.flags |= EntFlagsT.FL_LOCKED;
  }

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ANIMATED)) ent.s.effects |= EffectsT.EF_ANIM_ALL;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ANIMATED_FAST)) ent.s.effects |= EffectsT.EF_ANIM_ALLFAST;

  // to simplify logic elsewhere, make non-teamed doors into a team of one
  if (!ent.team) ent.teammaster = ent;

  gi.linkentity(ent);

  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) ent.think = Think_DoorActivateAreaPortal;
  else if (ent.health || ent.targetname) ent.think = Think_CalcMoveSpeed;
  else ent.think = Think_SpawnDoorTrigger;
}

// PGM
const Door_Activate: UseFn = RegisterUse("Door_Activate", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.use = null;

  if (self.health) {
    self.takedamage = true;
    self.die = door_killed;
    self.max_health = self.health;
  }

  if (self.health) self.think = Think_CalcMoveSpeed;
  else self.think = Think_SpawnDoorTrigger;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

export function SP_func_door_rotating(ent: EdictT): void {
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ROTATING_SAFE_OPEN)) G_SetMovedir(ent.s.angles, ent.moveinfo.dir);

  VectorCopy(vec3_origin, ent.s.angles);

  // set the axis of rotation
  VectorCopy(vec3_origin, ent.movedir);
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ROTATING_X_AXIS)) ent.movedir[2] = 1.0;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ROTATING_Y_AXIS)) ent.movedir[0] = 1.0;
  else ent.movedir[1] = 1.0; // Z_AXIS

  // check for reverse rotation
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_REVERSE)) {
    ent.movedir[0] = -ent.movedir[0];
    ent.movedir[1] = -ent.movedir[1];
    ent.movedir[2] = -ent.movedir[2];
  }

  if (!st.distance) {
    gi.Com_Print(`${edictFmt(ent)}: no distance set\n`);
    st.distance = 90;
  }

  VectorCopy(ent.s.angles, ent.pos1);
  VectorCopy(vec3_add(ent.s.angles, vec3_muls(ent.movedir, st.distance)), ent.pos2);
  VectorCopy(vec3_add(ent.s.angles, vec3_muls(ent.movedir, -st.distance)), ent.pos3);
  ent.moveinfo.distance = st.distance;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  ent.svflags |= SvflagsT.SVF_DOOR;
  if (ent.model !== null) gi.setmodel(ent, ent.model);

  ent.moveinfo.blocked = door_blocked;
  ent.use = door_use;

  if (!ent.speed) ent.speed = 100;
  if (!ent.accel) ent.accel = ent.speed;
  if (!ent.decel) ent.decel = ent.speed;

  if (!ent.wait) ent.wait = 3;
  if (!ent.dmg) ent.dmg = 2;

  if (ent.sounds !== 1) G_SetMoveinfoSounds(ent, "doors/dr1_strt.wav", "doors/dr1_mid.wav", "doors/dr1_end.wav");
  else G_SetMoveinfoSounds(ent, null, null, null);

  // [Paril-KEX] for rhangar1 doors
  if (!st.keys_specified.has("attenuation")) {
    ent.attenuation = ATTN_STATIC;
  } else {
    if (ent.attenuation === -1) {
      ent.s.loop_attenuation = ATTN_LOOP_NONE;
      ent.attenuation = ATTN_NONE;
    } else {
      ent.s.loop_attenuation = ent.attenuation;
    }
  }

  // if it starts open, switch the positions
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) {
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ROTATING_SAFE_OPEN)) {
      ent.spawnflags = SpawnFlags_and(ent.spawnflags, SpawnFlags_not(SPAWNFLAG_DOOR_ROTATING_SAFE_OPEN));
      gi.Com_Print(`${edictFmt(ent)}: SAFE_OPEN is not compatible with START_OPEN\n`);
    }

    VectorCopy(ent.pos2, ent.s.angles);
    const tmp = vec3(ent.pos1[0], ent.pos1[1], ent.pos1[2]);
    VectorCopy(ent.pos2, ent.pos1);
    VectorCopy(tmp, ent.pos2);
    VectorCopy(ent.s.angles, ent.pos1);
    ent.movedir[0] = -ent.movedir[0];
    ent.movedir[1] = -ent.movedir[1];
    ent.movedir[2] = -ent.movedir[2];
  }

  if (ent.health) {
    ent.takedamage = true;
    ent.die = door_killed;
    ent.max_health = ent.health;
  }

  if (ent.targetname && ent.message !== null) {
    gi.soundindex("misc/talk.wav");
    ent.touch = door_touch;
  }

  ent.moveinfo.state = MoveStateT.STATE_BOTTOM;
  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.s.origin, ent.moveinfo.start_origin);
  VectorCopy(ent.pos1, ent.moveinfo.start_angles);
  VectorCopy(ent.s.origin, ent.moveinfo.end_origin);
  VectorCopy(ent.pos2, ent.moveinfo.end_angles);
  VectorCopy(ent.pos3, ent.moveinfo.end_angles_reversed);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ANIMATED)) ent.s.effects |= EffectsT.EF_ANIM_ALL;

  // to simplify logic elsewhere, make non-teamed doors into a team of one
  if (!ent.team) ent.teammaster = ent;

  gi.linkentity(ent);

  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  if (ent.health || ent.targetname) ent.think = Think_CalcMoveSpeed;
  else ent.think = Think_SpawnDoorTrigger;

  // PGM
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_DOOR_ROTATING_INACTIVE)) {
    ent.takedamage = false;
    ent.die = null;
    ent.think = null;
    ent.nextthink = Gtime_from_ms(0);
    ent.use = Door_Activate;
  }
}

const smart_water_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("smart_water_blocked", (self: EdictT, other: EdictT): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_LAVA));
    // if it's still there, nuke it
    if (other.inuse && other.solid !== SolidT.SOLID_NOT) BecomeExplosion1(other);
    return;
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_LAVA));
});

export function SP_func_water(self: EdictT): void {
  const movedir = vec3(0, 0, 0);
  G_SetMovedir(self.s.angles, movedir);
  VectorCopy(movedir, self.movedir);
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  self.solid = SolidT.SOLID_BSP;
  if (self.model !== null) gi.setmodel(self, self.model);

  switch (self.sounds) {
    case 1: // water
    case 2: // lava
      G_SetMoveinfoSounds(self, "world/mov_watr.wav", null, "world/stp_watr.wav");
      break;
    default:
      G_SetMoveinfoSounds(self, null, null, null);
      break;
  }

  self.attenuation = ATTN_STATIC;

  // calculate second position
  VectorCopy(self.s.origin, self.pos1);
  const abs_movedir = vec3(Math.abs(self.movedir[0]), Math.abs(self.movedir[1]), Math.abs(self.movedir[2]));
  self.moveinfo.distance =
    (abs_movedir[0]) * (self.size[0]) +
    (abs_movedir[1]) * (self.size[1]) +
    (abs_movedir[2]) * (self.size[2]) -
    st.lip;
  VectorCopy(vec3_add(self.pos1, vec3_muls(self.movedir, self.moveinfo.distance)), self.pos2);

  // if it starts open, switch the positions
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DOOR_START_OPEN)) {
    VectorCopy(self.pos2, self.s.origin);
    const tmp = vec3(self.pos1[0], self.pos1[1], self.pos1[2]);
    VectorCopy(self.pos2, self.pos1);
    VectorCopy(tmp, self.pos2);
    VectorCopy(self.s.origin, self.pos1);
  }

  VectorCopy(self.pos1, self.moveinfo.start_origin);
  VectorCopy(self.s.angles, self.moveinfo.start_angles);
  VectorCopy(self.pos2, self.moveinfo.end_origin);
  VectorCopy(self.s.angles, self.moveinfo.end_angles);

  self.moveinfo.state = MoveStateT.STATE_BOTTOM;

  if (!self.speed) self.speed = 25;
  self.moveinfo.accel = self.moveinfo.decel = self.moveinfo.speed = self.speed;

  // ROGUE
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WATER_SMART)) {
    // smart water: self.accel is the divisor of the lowest player's
    // distance to determine speed; self.speed becomes the cap of the speed.
    if (!self.accel) self.accel = 20;
    self.moveinfo.blocked = smart_water_blocked;
  }

  if (!self.wait) self.wait = -1;
  self.moveinfo.wait = self.wait;

  self.use = door_use;

  if (self.wait === -1) self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_DOOR_TOGGLE);

  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// func_train (+ trigger_elevator)
// ---------------------------------------------------------------------------

const SPAWNFLAG_TRAIN_TOGGLE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_TRAIN_BLOCK_STOPS: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_TRAIN_FIX_OFFSET: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_TRAIN_USE_ORIGIN: SpawnFlags = SpawnFlags_from(32);

const train_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("train_blocked", (self: EdictT, other: EdictT): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
    // if it's still there, nuke it
    if (other.inuse && other.solid !== SolidT.SOLID_NOT) BecomeExplosion1(other);
    return;
  }

  if (level.time < self.touch_debounce_time) return;

  if (!self.dmg) return;
  self.touch_debounce_time = Gtime_add(level.time, Gtime_from_ms(500));
  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
});

const train_wait: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("train_wait", (self: EdictT): void => {
  const target_ent = self.target_ent;
  if (target_ent !== null && target_ent.pathtarget !== null) {
    const savetarget = target_ent.target;
    target_ent.target = target_ent.pathtarget;
    G_UseTargets(target_ent, self.activator);
    target_ent.target = savetarget;

    // make sure we didn't get killed by a killtarget
    if (!self.inuse) return;
  }

  if (self.moveinfo.wait) {
    if (self.moveinfo.wait > 0) {
      self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.moveinfo.wait));
      self.think = train_next;
    } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_TOGGLE)) {
      // PMM - clear target_ent, let train_next get called when we get used
      self.target_ent = null;
      self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TRAIN_START_ON));
      VectorCopy(vec3_origin, self.velocity);
      self.nextthink = Gtime_from_ms(0);
    }

    if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
      if (self.moveinfo.sound_end) gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, self.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    self.s.sound = 0;
  } else {
    train_next(self);
  }
});

// PGM
const train_piece_wait: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("train_piece_wait", (_self: EdictT): void => {});

const train_next: ThinkFn = RegisterThink("train_next", (self: EdictT): void => {
  let first = true;

  for (;;) {
    if (self.target === null) {
      self.s.sound = 0;
      return;
    }

    const ent = G_PickTarget(self.target);
    if (ent === null) {
      gi.Com_Print(`${edictFmt(self)}: train_next: bad target ${self.target}\n`);
      return;
    }

    self.target = ent.target;

    // check for a teleport path_corner
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_PATH_CORNER_TELEPORT)) {
      if (!first) {
        gi.Com_Print(`${edictFmt(ent)}: connected teleport path_corners\n`);
        return;
      }
      first = false;

      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_USE_ORIGIN)) {
        VectorCopy(ent.s.origin, self.s.origin);
      } else {
        VectorCopy(vec3_sub(ent.s.origin, self.mins), self.s.origin);

        if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_FIX_OFFSET)) {
          self.s.origin[0] -= 1;
          self.s.origin[1] -= 1;
          self.s.origin[2] -= 1;
        }
      }

      VectorCopy(self.s.origin, self.s.old_origin);
      self.s.event = KexEntityEventT.EV_OTHER_TELEPORT;
      gi.linkentity(self);
      continue; // goto again
    }

    // PGM
    if (ent.speed) {
      self.speed = ent.speed;
      self.moveinfo.speed = ent.speed;
      self.moveinfo.accel = ent.accel ? ent.accel : ent.speed;
      self.moveinfo.decel = ent.decel ? ent.decel : ent.speed;
      self.moveinfo.current_speed = 0;
    }

    self.moveinfo.wait = ent.wait;
    self.target_ent = ent;

    if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
      if (self.moveinfo.sound_start) gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }

    self.s.sound = self.moveinfo.sound_middle;

    let dest: Vec3;
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_USE_ORIGIN)) {
      dest = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
    } else {
      dest = vec3_sub(ent.s.origin, self.mins);
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_FIX_OFFSET)) {
        dest[0] -= 1;
        dest[1] -= 1;
        dest[2] -= 1;
      }
    }

    self.moveinfo.state = MoveStateT.STATE_TOP;
    VectorCopy(self.s.origin, self.moveinfo.start_origin);
    VectorCopy(dest, self.moveinfo.end_origin);
    Move_Calc(self, dest, train_wait);
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TRAIN_START_ON);

    // PGM
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_MOVE_TEAMCHAIN)) {
      const dir = vec3_sub(dest, self.s.origin);
      for (let e: EdictT | null = self.teamchain; e !== null; e = e.teamchain) {
        const dst = vec3_add(dir, e.s.origin);
        VectorCopy(e.s.origin, e.moveinfo.start_origin);
        VectorCopy(dst, e.moveinfo.end_origin);

        e.moveinfo.state = MoveStateT.STATE_TOP;
        e.speed = self.speed;
        e.moveinfo.speed = self.moveinfo.speed;
        e.moveinfo.accel = self.moveinfo.accel;
        e.moveinfo.decel = self.moveinfo.decel;
        e.movetype = MovetypeT.MOVETYPE_PUSH;
        Move_Calc(e, dst, train_piece_wait);
      }
    }

    return;
  }
});

function train_resume(self: EdictT): void {
  const ent = self.target_ent;
  if (ent === null) throw new Error("train_resume: self.target_ent is null (unchecked in source)");

  let dest: Vec3;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_USE_ORIGIN)) {
    dest = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  } else {
    dest = vec3_sub(ent.s.origin, self.mins);
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_FIX_OFFSET)) {
      dest[0] -= 1;
      dest[1] -= 1;
      dest[2] -= 1;
    }
  }

  self.s.sound = self.moveinfo.sound_middle;

  self.moveinfo.state = MoveStateT.STATE_TOP;
  VectorCopy(self.s.origin, self.moveinfo.start_origin);
  VectorCopy(dest, self.moveinfo.end_origin);
  Move_Calc(self, dest, train_wait);
  self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TRAIN_START_ON);
}

/** STUB SWAP TARGET -- see file header. Real port of g_func.cpp:2349's
 *  `THINK(func_train_find)`, replacing g_misc.ts's throwing stub. */
export const func_train_find: ThinkFn = RegisterThink("func_train_find", (self: EdictT): void => {
  if (self.target === null) {
    gi.Com_Print(`${edictFmt(self)}: train_find: no target\n`);
    return;
  }
  const ent = G_PickTarget(self.target);
  if (ent === null) {
    gi.Com_Print(`${edictFmt(self)}: train_find: target ${self.target} not found\n`);
    return;
  }
  self.target = ent.target;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_USE_ORIGIN)) {
    VectorCopy(ent.s.origin, self.s.origin);
  } else {
    VectorCopy(vec3_sub(ent.s.origin, self.mins), self.s.origin);

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_FIX_OFFSET)) {
      self.s.origin[0] -= 1;
      self.s.origin[1] -= 1;
      self.s.origin[2] -= 1;
    }
  }

  gi.linkentity(self);

  // if not triggered, start immediately
  if (!self.targetname) self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_TRAIN_START_ON);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_START_ON)) {
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    self.think = train_next;
    self.activator = self;
  }
});

/** STUB SWAP TARGET -- see file header. Real port of g_func.cpp:2390's
 *  `USE(train_use)`, replacing g_misc.ts's throwing stub. */
export const train_use: UseFn = RegisterUse("train_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.activator = activator;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_START_ON)) {
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_TOGGLE)) return;
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TRAIN_START_ON));
    VectorCopy(vec3_origin, self.velocity);
    self.nextthink = Gtime_from_ms(0);
  } else {
    if (self.target_ent !== null) train_resume(self);
    else train_next(self);
  }
});

export function SP_func_train(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_PUSH;

  VectorCopy(vec3_origin, self.s.angles);
  self.moveinfo.blocked = train_blocked;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRAIN_BLOCK_STOPS)) {
    self.dmg = 0;
  } else {
    if (!self.dmg) self.dmg = 100;
  }
  self.solid = SolidT.SOLID_BSP;
  if (self.model !== null) gi.setmodel(self, self.model);

  if (st.noise !== null) {
    self.moveinfo.sound_middle = gi.soundindex(st.noise);

    // [Paril-KEX] for rhangar1 doors
    if (!st.keys_specified.has("attenuation")) {
      self.attenuation = ATTN_STATIC;
    } else {
      if (self.attenuation === -1) {
        self.s.loop_attenuation = ATTN_LOOP_NONE;
        self.attenuation = ATTN_NONE;
      } else {
        self.s.loop_attenuation = self.attenuation;
      }
    }
  }

  if (!self.speed) self.speed = 100;

  self.moveinfo.speed = self.speed;
  self.moveinfo.accel = self.moveinfo.decel = self.moveinfo.speed;

  self.use = train_use;

  gi.linkentity(self);

  if (self.target !== null) {
    // start trains on the second frame, to make sure their targets have had
    // a chance to spawn
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    self.think = func_train_find;
  } else {
    gi.Com_Print(`${edictFmt(self)}: no target\n`);
  }
}

/*QUAKED trigger_elevator*/
const trigger_elevator_use: UseFn = RegisterUse("trigger_elevator_use", (self: EdictT, other: EdictT | null, _activator: EdictT | null): void => {
  const movetarget = self.movetarget;
  if (movetarget === null) throw new Error("trigger_elevator_use: self.movetarget is null (unchecked in source)");
  if (movetarget.nextthink) return;

  if (other === null || other.pathtarget === null) {
    gi.Com_Print(`${edictFmt(self)}: elevator used with no pathtarget\n`);
    return;
  }

  const target = G_PickTarget(other.pathtarget);
  if (target === null) {
    gi.Com_Print(`${edictFmt(self)}: elevator used with bad pathtarget: ${other.pathtarget}\n`);
    return;
  }

  movetarget.target_ent = target;
  train_resume(movetarget);
});

const trigger_elevator_init: ThinkFn = RegisterThink("trigger_elevator_init", (self: EdictT): void => {
  if (self.target === null) {
    gi.Com_Print(`${edictFmt(self)}: has no target\n`);
    return;
  }
  self.movetarget = G_PickTarget(self.target);
  if (self.movetarget === null) {
    gi.Com_Print(`${edictFmt(self)}: unable to find target ${self.target}\n`);
    return;
  }
  if (self.movetarget.classname !== "func_train") {
    gi.Com_Print(`${edictFmt(self)}: target ${self.target} is not a train\n`);
    return;
  }

  self.use = trigger_elevator_use;
  self.svflags = SvflagsT.SVF_NOCLIENT;
});

export function SP_trigger_elevator(self: EdictT): void {
  self.think = trigger_elevator_init;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
}

// ---------------------------------------------------------------------------
// func_timer
// ---------------------------------------------------------------------------

const SPAWNFLAG_TIMER_START_ON: SpawnFlags = SpawnFlags_from(1);

const func_timer_think: ThinkFn = RegisterThink("func_timer_think", (self: EdictT): void => {
  G_UseTargets(self, self.activator);
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait + crandom() * self.random));
});

const func_timer_use: UseFn = RegisterUse("func_timer_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.activator = activator;

  // if on, turn it off
  if (self.nextthink) {
    self.nextthink = Gtime_from_ms(0);
    return;
  }

  // turn it on
  if (self.delay) self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.delay));
  else func_timer_think(self);
});

export function SP_func_timer(self: EdictT): void {
  if (!self.wait) self.wait = 1.0;

  self.use = func_timer_use;
  self.think = func_timer_think;

  if (self.random >= self.wait) {
    self.random = self.wait - gi.frame_time_s;
    gi.Com_Print(`${edictFmt(self)}: random >= wait\n`);
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_START_ON)) {
    self.nextthink = Gtime_add(level.time, Gtime_add(Gtime_from_sec(1), Gtime_from_sec(st.pausetime + self.delay + self.wait + crandom() * self.random)));
    self.activator = self;
  }

  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// func_conveyor
// ---------------------------------------------------------------------------

const SPAWNFLAG_CONVEYOR_START_ON: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_CONVEYOR_TOGGLE: SpawnFlags = SpawnFlags_from(2);

const func_conveyor_use: UseFn = RegisterUse("func_conveyor_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_CONVEYOR_START_ON)) {
    self.speed = 0;
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_CONVEYOR_START_ON));
  } else {
    self.speed = self.count;
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_CONVEYOR_START_ON);
  }

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_CONVEYOR_TOGGLE)) self.count = 0;
});

export function SP_func_conveyor(self: EdictT): void {
  if (!self.speed) self.speed = 100;

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_CONVEYOR_START_ON)) {
    self.count = Math.trunc(self.speed);
    self.speed = 0;
  }

  self.use = func_conveyor_use;

  if (self.model !== null) gi.setmodel(self, self.model);
  self.solid = SolidT.SOLID_BSP;
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// func_door_secret
// ---------------------------------------------------------------------------

const SPAWNFLAG_SECRET_ALWAYS_SHOOT: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_SECRET_1ST_LEFT: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_SECRET_1ST_DOWN: SpawnFlags = SpawnFlags_from(4);

const door_secret_use: UseFn = RegisterUse("door_secret_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  // make sure we're not already moving
  if (vec3_any_nonzero(self.s.origin)) return;

  Move_Calc(self, self.pos1, door_secret_move1);
  door_use_areaportals(self, true);
});

const door_secret_move1: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("door_secret_move1", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  self.think = door_secret_move2;
});

const door_secret_move2: ThinkFn = RegisterThink("door_secret_move2", (self: EdictT): void => {
  Move_Calc(self, self.pos2, door_secret_move3);
});

const door_secret_move3: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("door_secret_move3", (self: EdictT): void => {
  if (self.wait === -1) return;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
  self.think = door_secret_move4;
});

const door_secret_move4: ThinkFn = RegisterThink("door_secret_move4", (self: EdictT): void => {
  Move_Calc(self, self.pos1, door_secret_move5);
});

const door_secret_move5: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("door_secret_move5", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  self.think = door_secret_move6;
});

const door_secret_move6: ThinkFn = RegisterThink("door_secret_move6", (self: EdictT): void => {
  Move_Calc(self, vec3_origin, door_secret_done);
});

const door_secret_done: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("door_secret_done", (self: EdictT): void => {
  if (!self.targetname || SpawnFlags_has(self.spawnflags, SPAWNFLAG_SECRET_ALWAYS_SHOOT)) {
    self.health = 0;
    self.takedamage = true;
  }
  door_use_areaportals(self, false);
});

const door_secret_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("door_secret_blocked", (self: EdictT, other: EdictT): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
    // if it's still there, nuke it
    if (other.inuse && other.solid !== SolidT.SOLID_NOT) BecomeExplosion1(other);
    return;
  }

  if (level.time < self.touch_debounce_time) return;
  self.touch_debounce_time = Gtime_add(level.time, Gtime_from_ms(500));

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
});

const door_secret_die: DieFn = RegisterDie(
  "door_secret_die",
  (self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    self.takedamage = false;
    door_secret_use(self, attacker, attacker);
  },
);

export function SP_func_door_secret(ent: EdictT): void {
  G_SetMoveinfoSounds(ent, "doors/dr1_strt.wav", "doors/dr1_mid.wav", "doors/dr1_end.wav");

  ent.attenuation = ATTN_STATIC;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  ent.svflags |= SvflagsT.SVF_DOOR;
  if (ent.model !== null) gi.setmodel(ent, ent.model);

  ent.moveinfo.blocked = door_secret_blocked;
  ent.use = door_secret_use;

  if (!ent.targetname || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SECRET_ALWAYS_SHOOT)) {
    ent.health = 0;
    ent.takedamage = true;
    ent.die = door_secret_die;
  }

  if (!ent.dmg) ent.dmg = 2;

  if (!ent.wait) ent.wait = 5;

  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = 50;

  // calculate positions
  const { forward, right, up } = AngleVectors_destructured_local(ent.s.angles);
  VectorCopy(vec3_origin, ent.s.angles);
  const side = 1.0 - (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SECRET_1ST_LEFT) ? 2 : 0);
  const width = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SECRET_1ST_DOWN) ? Math.abs(vec3_dot(up, ent.size)) : Math.abs(vec3_dot(right, ent.size));
  const length = Math.abs(vec3_dot(forward, ent.size));
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SECRET_1ST_DOWN)) {
    VectorCopy(vec3_add(ent.s.origin, vec3_muls(up, -1 * width)), ent.pos1);
  } else {
    VectorCopy(vec3_add(ent.s.origin, vec3_muls(right, side * width)), ent.pos1);
  }
  VectorCopy(vec3_add(ent.pos1, vec3_muls(forward, length)), ent.pos2);

  if (ent.health) {
    ent.takedamage = true;
    ent.die = door_killed;
    ent.max_health = ent.health;
  } else if (ent.targetname && ent.message !== null) {
    gi.soundindex("misc/talk.wav");
    ent.touch = door_touch;
  }

  gi.linkentity(ent);
}

function AngleVectors_destructured_local(angles: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  const up = vec3(0, 0, 0);
  AngleVectors(angles, forward, right, up);
  return { forward, right, up };
}

// ---------------------------------------------------------------------------
// func_killbox
// ---------------------------------------------------------------------------

const SPAWNFLAG_KILLBOX_DEADLY_COOP: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_KILLBOX_EXACT_COLLISION: SpawnFlags = SpawnFlags_from(4);

const use_killbox: UseFn = RegisterUse("use_killbox", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_KILLBOX_DEADLY_COOP)) level.deadly_kill_box = true;

  self.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(self);

  KillBox(self, false, ModIdT.MOD_TELEFRAG, SpawnFlags_has(self.spawnflags, SPAWNFLAG_KILLBOX_EXACT_COLLISION));

  self.solid = SolidT.SOLID_NOT;
  gi.linkentity(self);

  level.deadly_kill_box = false;
});

export function SP_func_killbox(ent: EdictT): void {
  if (ent.model !== null) gi.setmodel(ent, ent.model);
  ent.use = use_killbox;
  ent.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// func_eye [Paril-KEX]
// ---------------------------------------------------------------------------

const SPAWNFLAG_FUNC_EYE_FIRED_TARGETS: SpawnFlags = SpawnFlags_from(1 << 16); // 17_spawnflag_bit; internal use only

const func_eye_think: ThinkFn = RegisterThink("func_eye_think", (self: EdictT): void => {
  // find enemy to track
  let closest_dist = 0;
  let closest_player: EdictT | null = null;

  for (const player of active_players()) {
    const raw = vec3_sub(player.s.origin, self.s.origin);
    const dist = vec3_length(raw);
    const dir = vec3_normalized(raw);

    if (vec3_dot(dir, self.movedir) < self.yaw_speed) continue;
    if (dist >= self.dmg_radius) continue;

    if (closest_player === null || dist < closest_dist) {
      closest_player = player;
      closest_dist = dist;
    }
  }

  self.enemy = closest_player;

  // tracking player
  let wanted_angles: Vec3;

  const { forward: fwd, right: rgt, up } = AngleVectors_destructured_local(self.s.angles);

  const eye_pos = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  vec3_addEq(eye_pos, vec3_muls(fwd, self.move_origin[0]));
  vec3_addEq(eye_pos, vec3_muls(rgt, self.move_origin[1]));
  vec3_addEq(eye_pos, vec3_muls(up, self.move_origin[2]));

  if (self.enemy !== null) {
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_FUNC_EYE_FIRED_TARGETS)) {
      G_UseTargets(self, self.enemy);
      self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_FUNC_EYE_FIRED_TARGETS);
    }

    const dir = vec3_normalized(vec3_sub(self.enemy.s.origin, eye_pos));
    wanted_angles = vectoangles(dir);

    self.s.frame = 2;
    self.timestamp = Gtime_add(level.time, Gtime_from_sec(self.wait));
  } else {
    if (self.timestamp <= level.time) {
      // return to neutral
      wanted_angles = self.move_angles;
      self.s.frame = 0;
    } else {
      wanted_angles = self.s.angles;
    }
  }

  for (let i = 0; i < 2; i++) {
    const current = anglemod(self.s.angles[i]);
    const ideal = wanted_angles[i];

    if (current === ideal) continue;

    let move = ideal - current;

    if (ideal > current) {
      if (move >= 180) move = move - 360;
    } else {
      if (move <= -180) move = move + 360;
    }
    if (move > 0) {
      if (move > self.speed) move = self.speed;
    } else {
      if (move < -self.speed) move = -self.speed;
    }

    self.s.angles[i] = anglemod(current + move);
  }

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

const func_eye_setup: ThinkFn = RegisterThink("func_eye_setup", (self: EdictT): void => {
  const eye_pos = G_PickTarget(self.pathtarget);

  if (eye_pos === null) {
    gi.Com_Print(`${edictFmt(self)}: bad target\n`);
  } else {
    VectorCopy(vec3_sub(eye_pos.s.origin, self.s.origin), self.move_origin);
  }

  VectorCopy(vec3_normalized(self.move_origin), self.movedir);

  self.think = func_eye_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

export function SP_func_eye(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  if (ent.model !== null) gi.setmodel(ent, ent.model);

  if (!st.radius) ent.dmg_radius = 512;
  else ent.dmg_radius = st.radius;

  if (!ent.speed) ent.speed = 45;

  if (!ent.yaw_speed) ent.yaw_speed = 0.5;

  ent.speed *= gi.frame_time_s;
  VectorCopy(ent.s.angles, ent.move_angles);

  ent.wait = 1.0;

  if (ent.pathtarget !== null) {
    ent.think = func_eye_setup;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  } else {
    ent.think = func_eye_think;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));

    const { forward, right, up } = AngleVectors_destructured_local(ent.move_angles);
    VectorCopy(forward, ent.movedir);

    const move_origin = vec3(ent.move_origin[0], ent.move_origin[1], ent.move_origin[2]);
    VectorCopy(vec3_muls(ent.movedir, move_origin[0]), ent.move_origin);
    vec3_addEq(ent.move_origin, vec3_muls(right, move_origin[1]));
    vec3_addEq(ent.move_origin, vec3_muls(up, move_origin[2]));
  }

  gi.linkentity(ent);
}
