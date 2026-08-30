// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_misc.c -- miscellaneous entities (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_misc.cpp (2,536 lines, C++17):
// gibs (ThrowGib/ThrowClientHead/BecomeExplosion1-2/ClipGibVelocity/
// VelocityForDamage plus the KEX gib_type_t flag family), func_areaportal,
// path_corner/point_combat, info_null/info_notnull, shadow-light setup
// (GetShadowLightData/setup_shadow_lights/G_LoadShadowLights/
// setup_dynamic_light), light/dynamic_light, func_wall/func_animation/
// func_object/func_explosive, misc_explobox (the barrel_* family), the
// misc_blackhole/eastertank/easterchick/easterchick2/monster_commander_body/
// misc_banner novelty entities, misc_deadsoldier, misc_viper/bigviper/
// viper_bomb, misc_strogg_ship, misc_satellite_dish, light_mine1/2,
// misc_gib_arm/leg/head, target_character/target_string, func_clock (the
// whole clock state machine), misc_teleporter + dest (teleporter_touch),
// misc_flare, misc_hologram, misc_lavaball (fire_touch/fire_fly),
// info_landmark, info_world_text, misc_player_mannequin, and misc_model --
// every SP_* the C++ file declares. Behavioral code, ported bug-for-bug per
// PORTING.md.
//
// ============================================================================
// SPAWN-FUNCTION INVENTORY: 41 SP_* in the C++ source, 41 exported here
// ============================================================================
// Verified by `grep -c '^void SP_' g_misc.cpp` against this file's own
// `export function SP_*` count: SP_func_areaportal, SP_path_corner,
// SP_point_combat, SP_info_null, SP_info_notnull, SP_dynamic_light, SP_light,
// SP_func_wall, SP_func_animation, SP_func_object, SP_func_explosive,
// SP_misc_explobox, SP_misc_blackhole, SP_misc_eastertank,
// SP_misc_easterchick, SP_misc_easterchick2, SP_monster_commander_body,
// SP_misc_banner, SP_misc_deadsoldier, SP_misc_viper, SP_misc_bigviper,
// SP_misc_viper_bomb, SP_misc_strogg_ship, SP_misc_satellite_dish,
// SP_light_mine1, SP_light_mine2, SP_misc_gib_arm, SP_misc_gib_leg,
// SP_misc_gib_head, SP_target_character, SP_target_string, SP_func_clock,
// SP_misc_teleporter, SP_misc_teleporter_dest, SP_misc_flare,
// SP_misc_hologram, SP_misc_lavaball, SP_info_landmark, SP_info_world_text,
// SP_misc_player_mannequin, SP_misc_model. These will be referenced by the
// future g_spawn.ts registry (does not exist yet in src/kexgame/), matching
// each C++ name exactly as this port's other spawn-owning files do.
//
// ============================================================================
// STUB SWAP (done): train_use/func_train_find are now real imports from
// g_func.ts
// ============================================================================
// `train_use`/`func_train_find` (g_func.cpp:2390/2349) used to be local
// throwing stubs here (see prior revisions of this header) -- both were
// THINK/USE-macro-wrapped in the C++ source, so per this port's "a
// save-registered function you cannot port faithfully is still
// save-registered under its real name" precedent, they were registered via
// RegisterThink("func_train_find", ...)/RegisterUse("train_use", ...)
// throwing stubs until g_func.ts landed. Now that it has, both local stubs
// are REMOVED and this file imports the real `train_use`/`func_train_find`
// from "./g_func" instead (used, unchanged in call shape, by
// misc_viper_use/misc_strogg_ship_use/SP_misc_viper/SP_misc_strogg_ship,
// none of which this unit's own test suite exercises) -- mirroring
// g_phys.ts's M_CheckGround/etc swap against g_monster.ts. This makes a
// real, sanctioned import cycle: this file now imports `train_use`/
// `func_train_find` from g_func.ts, while g_func.ts imports
// `BecomeExplosion1` (below) from this file. Every cross-module symbol on
// both sides is either a hoisted `export function` declaration
// (`BecomeExplosion1`) or a top-level `const` only read inside a closure
// that isn't invoked until a real game callback fires (`train_use`/
// `func_train_find`, referenced only inside misc_viper_use/
// misc_strogg_ship_use/SP_misc_viper/SP_misc_strogg_ship's own closures
// here, never at this file's top level) -- no TDZ hazard either direction.
// Verified end-to-end by `bunx tsc --noEmit` and `bun test` actually
// importing both files together. See g_func.ts's own header for the full
// writeup of this cycle from its side.
//
// ============================================================================
// STUB SWAP (xatrix unit): misc_viper_use / misc_strogg_ship_use now exported
// ============================================================================
// Both were real, already-ported, already-`RegisterUse`d local `const`
// bindings -- just not `export`ed, since nothing outside this file needed
// them before. g_xatrix_misc.ts's own `SP_misc_crashviper`/
// `SP_misc_transport` (xatrix/g_xatrix_misc.cpp:9/85) reuse them exactly the
// way the shipped C++ does: `ent->use = misc_viper_use;` /
// `ent->use = misc_strogg_ship_use;` on a freshly-spawned xatrix entity, with
// no behavior change here -- only the `export` keyword was added to each
// declaration.
// - `CTFPlayerResetGrapple` -> grepped the ENTIRE quake2-rerelease-dll tree:
//   declared in rerelease/ctf/g_ctf.h:111, defined in
//   rerelease/ctf/g_ctf.cpp:1222 -- a file with no src/kexgame/ port yet.
//   IMPORTANT: this is NOT the same owning file as src/ctf/g_ctf.ts, which
//   already exports a same-named `CTFPlayerResetGrapple` -- that module is a
//   port of the ORIGINAL, pre-rerelease Zoid CTF mod
//   (quake2-rerelease-dll/original/ctf/g_ctf.c), a completely different,
//   incompatible type system (confirmed by reading src/ctf/g_misc.ts's own
//   `teleporter_touch`, which takes the legacy `(self, other, plane,
//   surf)` touch shape, not this port's `TouchFn`/`KexTraceT` shape).
//   Importing from src/ctf/ here would silently wire the wrong entity model
//   in. IMPORTANTLY, `CTFPlayerResetGrapple` is called UNCONDITIONALLY by
//   teleporter_touch with no `#ifdef` anywhere in the KEX rerelease source
//   (grepped -- CTF is baked into the base rerelease binary, not optional),
//   so a plain throwing stub here would break every single-player/non-CTF
//   teleporter touch, which is far too broad a regression for a function
//   whose own real body (rerelease/ctf/g_ctf.cpp:1222-1226) is trivial:
//   `if (ent->client && ent->client->ctf_grapple) CTFResetGrapple(...)`.
//   Ported as a REAL, faithful implementation of exactly that guard --
//   `ctf_grapple` is null for every player without an active grapple hook
//   out (the overwhelming common case, and GClientT's own default/rest
//   state) -- with the actual grapple-release call (`CTFResetGrapple`,
//   rerelease/ctf/g_ctf.cpp:1230, a much deeper CTF-weapon-specific
//   function: sound effects, releasing the grapple entity, etc.) left as a
//   local, unexported throwing stub, reached only on the genuinely
//   CTF/grapple-specific path this file has no business implementing.
//
// ============================================================================
// STUB SWAP: `st` (spawn_temp_t) -- now a real import from src/kexgame/g_spawn.ts
// ============================================================================
// This file used to carry a full, real-shaped `SpawnTempT` object as a
// local, permanently-defaulted placeholder (all-zero/all-null, matching
// what ED_ParseField would leave an unset spawn_temp_t with) -- covering
// every field this file reads (sl/image/radius/fade_start_dist/
// fade_end_dist/height/goals/distance/keys_specified), since no shared `st`
// global existed anywhere in this port line yet. src/kexgame/g_spawn.ts has
// now landed with the real, shared `SpawnTempT` global (exported as `st`,
// mutated in place by `ED_ParseField`/`ClearSpawnTemp` during real entity
// spawning); this file's own local placeholder is DELETED and replaced with
// `import { st } from "./g_spawn"`.
//
// Cross-checking this file's own placeholder defaults against g_spawn.ts's
// canonical ones (which g_spawn.ts itself verified line-by-line against the
// real g_local.h/game.h struct declarations) turned up ONE real fix: this
// file's own placeholder used `skyautorotate: 0`, but the real C++ default
// (g_local.h:1274, `int32_t skyautorotate = 1;`) is 1 -- g_target.ts's/
// g_trigger.ts's own placeholders already had this one right. This file's
// `fade_start_dist`/`fade_end_dist`/`health_multiplier`/
// `sl.data.intensity` defaults were ALSO wrong (0 instead of the real
// 96/384/1.0/1 -- see g_spawn.ts's own header for the full citation), the
// same latent bug independently repeated across every placeholder in this
// port line; importing the shared `st` fixes all of these for this file at
// once. `st.was_key_specified(key)` (g_local.h, a method on the real
// spawn_temp_t) stays inlined as `st.keys_specified.has(key)` at its two
// call sites (misc_player_mannequin), unchanged by the swap -- the real
// `SpawnTempT.keys_specified` is genuinely populated now (by real spawning
// through ED_ParseField), where the old placeholder's was permanently
// empty, so dynamic/shadow-light spawning, misc_flare's custom skin/fade-
// distance overrides, misc_light's early-out, info_world_text's custom
// text size, and misc_player_mannequin's per-map selection are all now
// genuinely reachable for the first time in this port line, not dead code.
//
// This creates a two-way module cycle with g_spawn.ts (which imports this
// file's own `setup_shadow_lights` for SpawnEntities/SP_worldspawn, and
// several of this file's SP_* functions for its registry) -- safe, since
// `st` is only ever read inside function bodies here (never at this file's
// own module top level); see g_spawn.ts's own header, "Two-way circular
// imports," for the full rationale this file now shares.
//
// ============================================================================
// ThrowGibs / gib_def_t -- placement-mismatch, ported locally
// ============================================================================
// Declared in g_local.h:3439-3519 (an `inline void ThrowGibs(...)` plus an
// 8-overload `gib_def_t` constructor set), not g_misc.cpp itself -- but
// every real call site needing it (func_explosive_explode, barrel_explode,
// misc_deadsoldier_die) is squarely in this file's own scope. Ported here
// per PORTING.md's "the brief's placement wins; report the mismatch, don't
// move it" precedent (already invoked by g_utils.ts's G_FindByString note
// and g_monster.ts's G_PowerUpExpiring note). The 8 C++ constructor
// overloads (every combination of count/gibname/scale/type, with
// count=1/scale=1.0/type=GIB_NONE as the omitted defaults) collapse to one
// `GibDefT` object-literal type with three OPTIONAL fields, matching this
// port's established "C constructor overload sets collapse to one function/
// type with optional parameters" idiom.
//
// ============================================================================
// fmt::formatter<edict_t> / anglemod / FRAME_TIME_S -- local copies, not
// shared, per already-established precedent
// ============================================================================
// - g_local.h:3534-3549's `fmt::formatter<edict_t>` ("{}" prints
//   "classname @ midpoint-or-origin") backs nearly every `gi.Com_PrintFmt("{}
//   ...", *self)` call in the C++ source. q_std.ts's own header explicitly
//   leaves G_Fmt/fmtlib out of this port's scope ("replace G_Fmt at every
//   call site"), so this file's own small local `edictFmt(ent)` helper
//   replicates just that one formatter, called from plain
//   `gi.Com_Print(...)` template-literal call sites (gi.Com_Print takes a
//   plain string, not a format string).
// - `anglemod` (q_std.h) is q_std.ts's own explicitly-deferred function
//   ("kex's OWN copy... lives here instead of q_std.ts" -- m_move.ts's own
//   header already made this exact call for its own copy). info_world_text_think
//   is this file's only caller; copied locally again, verbatim.
// - `FRAME_TIME_S`/`FRAME_TIME_MS` (g_local.h externs, set once in a not-yet-
//   ported InitGame) don't exist as real globals yet -- g_phys.ts's and
//   g_monster.ts's own headers already flag this gap and work around it by
//   reading `gi.frame_time_ms` per-call instead. This file's local
//   `frameTimeAsGtime()` is the same workaround, used everywhere the C++
//   source adds `FRAME_TIME_S`/`FRAME_TIME_MS` to `nextthink`.
// - `cvarOrDefault(name, default)` is copied from g_monster.ts's own local,
//   unexported helper (not shared anywhere) -- same `gi.cvar(...)` wrapper,
//   throwing if `gi.cvar` ever returns null.
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `G_LoadShadowLights`'s semicolon-tokenized configstring re-parse
//   (COM_ParseEx with ";" as the sole delimiter) is ported via plain
//   `String.split(";")` -- behaviorally identical for this purely-numeric,
//   no-embedded-punctuation payload; the general-purpose tokenizer isn't
//   needed for this one fixed 12-field format.
// - `func_clock`'s `clock_message` field is a plain, unbounded TS `string`
//   here (EdictT's own field type), not the fixed `char[CLOCK_MESSAGE_SIZE =
//   9]` buffer `G_FmtTo` writes into in C++ -- no silent truncation at 9
//   characters can occur. Unreachable in practice (styles 0/1/2 all produce
//   strings well under 9 characters for any realistic clock value), but
//   documented as an honest deviation, not silently "fixed."
// - `target_string_use`'s out-of-range read: the C++ reads one past the
//   message's `strlen()` into its NUL terminator (`c == '\0'`, which matches
//   none of the digit/'-'/':' cases and falls to `else -> frame 12`); TS's
//   `msg[n]` for the same out-of-range `n` returns `undefined`, which also
//   matches none of the cases and falls to the same `else -> frame 12`.
//   Same OBSERVABLE result, different underlying reason -- not a behavior
//   change.
// - `func_explosive_explode`'s FL_TEAMSLAVE teamchain unlink walk is ported
//   as the exact same loop shape (including advancing `master =
//   master.teamchain` in the very same iteration that finds and unlinks
//   `self`), but a `master === null` mid-walk (which the C++ source would
//   dereference as undefined behavior on malformed team data) throws
//   instead of crashing/hanging -- matching this port's established
//   "surface invariant violations loudly, never silently corrupt or hang"
//   convention (already used by g_monster.ts's M_ProcessPain null-checks).
// - Several handlers call through a `... | null`-typed field the C++ source
//   calls through UNCHECKED (a real null there is memory-unsafe UB in the
//   original, never actually null for a correctly-authored map/spawn order):
//   `other.monsterinfo.stand` (path_corner_touch/point_combat_touch),
//   `enemy.use`/`self.think` (func_clock_think/func_clock_use),
//   `self.owner` (teleporter_touch's `self.owner.s.event` assignment --
//   always set by SP_misc_teleporter's own trig spawn), `self.activator` as
//   T_RadiusDamage's non-null `attacker` param (barrel_explode -- always set
//   by barrel_delay first), and the `misc_viper` lookup in
//   misc_viper_bomb_use. Each such call site gets an explicit `if (x ===
//   null) throw` immediately before the dereference, per the same
//   M_ProcessPain precedent.
// - `func_explosive_use`'s `activator: EdictT | null` forwarded into
//   `func_explosive_explode`'s non-null `attacker: EdictT` DieFn parameter
//   gets the same explicit null-check-and-throw treatment (the C++ passes
//   `activator` unchecked; a real USE call always supplies one for this
//   entity type in practice).
// - `gi.setmodel(self, self.model)` call sites (func_wall/func_animation/
//   func_object/func_explosive/target_character) guard `self.model !== null`
//   first rather than throwing, matching the exact idiom the concurrently-
//   landing src/kexgame/g_trigger.ts already uses for this same C++ pattern
//   (read there for reference only; not edited by this unit).
// - `SPAWNFLAG_TEMEPORTER_N64_EFFECT`'s misspelling ("TEMEPORTER") is
//   preserved verbatim from the C++ source's own constant name -- an
//   internal identifier only, not player-visible, kept for line-by-line
//   auditability against g_misc.cpp:2066.
//
// ============================================================================
// SAVE-REGISTERED FUNCTIONS (via g_save_registry.ts)
// ============================================================================
// Every THINK/USE/TOUCH/DIE/PRETHINK-macro-wrapped C++ function is
// registered under its exact C++ name: Use_Areaportal, gib_die, gib_touch,
// path_corner_touch, point_combat_touch, light_use, dynamic_light_use,
// func_wall_use, func_animation_use, func_object_touch/release/use,
// func_explosive_explode/use/activate/spawn, barrel_touch/explode/burn/
// delay/think/start, misc_blackhole_use/think, misc_eastertank_think,
// misc_easterchick_think, misc_easterchick2_think, commander_body_think/
// use/drop, misc_banner_think, misc_deadsoldier_die, misc_viper_use,
// misc_viper_bomb_touch/prethink/use, misc_strogg_ship_use,
// misc_satellite_dish_think/use, target_string_use, func_clock_think/use,
// teleporter_touch, misc_flare_use, misc_hologram_think, fire_touch,
// fire_fly, info_world_text_use/think, misc_player_mannequin_use/think.
// (func_train_find/train_use are now imported from g_func.ts -- see this
// file's header "STUB SWAP (done)" section above -- not registered here.)
// Plain `void`-returning functions with no macro wrapper (ThrowGib,
// ThrowClientHead, BecomeExplosion1/2, VelocityForDamage, ClipGibVelocity,
// ThrowGibs, GetShadowLightData, setup_shadow_lights, G_LoadShadowLights,
// setup_dynamic_light, func_clock_reset, func_clock_format_countdown,
// SetupMannequinModel, and every SP_*) are plain exported (or, for the two
// C++ `static` functions setup_dynamic_light/func_clock_reset/
// func_clock_format_countdown, unexported local) functions, matching the C++
// source's own lack of a SAVE_FUNC_* wrapper on them.

import { vec3, type Vec3 } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import {
  type KexTraceT,
  ContentsT,
  MASK_SOLID,
  MASK_WATER,
  MASK_MONSTERSOLID,
  MASK_SHOT,
  SvflagsT,
  SolidT,
  EffectsT,
  EF_FIREBALL,
  RenderfxT,
  WaterLevelT,
  CvarFlagsT,
  SoundchanT,
  KexMulticastT,
  ServerCommandT,
  KexTempEventT,
  KexEntityEventT,
  PmflagsT,
  ATTN_NORM,
  rgba_red,
  rgba_blue,
  rgba_green,
  rgba_yellow,
  rgba_white,
  rgba_black,
  rgba_cyan,
  rgba_orange,
  type RgbaT,
  GestureType,
  MODELINDEX_PLAYER,
  MAX_CLIENTS,
  MAX_SHADOW_LIGHTS,
  ShadowLightTypeT,
  type ShadowLightDataT,
  CS_LIGHTS,
  CS_SHADOWLIGHTS,
  CS_PLAYERSKINS,
} from "../kexapi/game";
import {
  type EdictT,
  type ModT,
  type TouchFn,
  type DieFn,
  type PrethinkFn,
  MovetypeT,
  EntFlagsT,
  MonsterAiFlagsT,
  ModIdT,
  DamageflagsT,
  GibTypeT,
  AnimPriorityT,
  HOLD_FOREVER,
  HACKFLAG_END_CUTSCENE,
  SPAWNFLAG_PATH_CORNER_TELEPORT,
  SPAWNFLAG_POINT_COMBAT_HOLD,
  random_time,
} from "./g_local";
import { gi, g_edicts, level } from "./g_main_globals";
import { type GTime, GTIME_ZERO, Gtime_add, Gtime_subtract, Gtime_from_ms, Gtime_from_sec, Gtime_from_hz, Gtime_seconds } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, SpawnFlags_and, SpawnFlags_not } from "./spawnflags";
import { YAW, clamp, frandom, crandom, irandom, brandom } from "./q_std";
import { vec3_origin, vec3_add, vec3_sub, vec3_muls, vec3_scaled, vec3_normalize, AngleVectors, vectoyaw, vectoangles, closest_point_to_box } from "./q_vec3";
import { G_Spawn, G_FreeEdict, G_FindByString, G_PickTarget, G_UseTargets, KillBox } from "./g_utils";
import { T_Damage, T_RadiusDamage } from "./g_combat";
import { M_walkmove, M_ChangeYaw } from "./m_move";
import { M_droptofloor, M_CatagorizePositionSelf, M_WorldEffects } from "./g_monster";
import { train_use, func_train_find } from "./g_func";
import { CTFPlayerResetGrapple } from "./ctf/g_ctf";
import {
  FRAME_flip01,
  FRAME_flip12,
  FRAME_salute01,
  FRAME_salute11,
  FRAME_taunt01,
  FRAME_taunt17,
  FRAME_wave01,
  FRAME_wave11,
  FRAME_point01,
  FRAME_point12,
  FRAME_stand01,
  FRAME_stand40,
} from "./m_player";
import { RegisterThink, RegisterTouch, RegisterUse, RegisterDie, RegisterPrethink } from "./g_save_registry";
import { st } from "./g_spawn";

// ---------------------------------------------------------------------------
// small local helpers -- see file header for each
// ---------------------------------------------------------------------------

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) {
    throw new Error(`gi.cvar(${name}) returned null`);
  }
  return c;
}

/** See g_phys.ts's/g_monster.ts's own "FRAME_TIME_S" note -- same gap, same workaround. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/** g_local.h:3534-3549's `fmt::formatter<edict_t>` -- "{classname} @ {midpoint
 *  or origin}" -- replicated locally since gi.Com_Print takes a plain
 *  string, not a format string (q_std.ts's own header leaves G_Fmt/fmtlib
 *  out of this port's scope). */
function edictFmt(ent: EdictT): string {
  const p = ent.linked ? vec3_muls(vec3_add(ent.absmax, ent.absmin), 0.5) : ent.s.origin;
  return `${ent.classname} @ (${p[0]} ${p[1]} ${p[2]})`;
}

/** q_std.h:185 -- kex's OWN anglemod (fmod-based). See m_move.ts's own copy
 *  and header note for why this isn't shared via q_std.ts. */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** fmtlib's `{:width}` (space-padded) / `{:0width}` (zero-padded) integer
 *  formatting, as used by func_clock_format_countdown/func_clock_think's
 *  time-of-day branch. */
function padWidth(n: number, width: number, padChar: string): string {
  const s = String(n);
  return s.length >= width ? s : padChar.repeat(width - s.length) + s;
}

// ---------------------------------------------------------------------------
// st (spawn_temp_t) -- see file header's "a real-shaped, permanently-default
// placeholder" note
// ---------------------------------------------------------------------------

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


// ---------------------------------------------------------------------------
// CROSS-DEPENDENCY -- CTFPlayerResetGrapple/CTFResetGrapple -- REAL imports
// from src/kexgame/ctf/g_ctf.ts (this file's own former real, local
// CTFPlayerResetGrapple copy and its throwing CTFResetGrapple stub are gone;
// see ctf/g_ctf.ts's own header for the full consolidation inventory). Note
// this is the KEX rerelease `CTFPlayerResetGrapple` (ctf/g_ctf.cpp), NOT
// src/ctf/g_ctf.ts's same-named export for the unrelated legacy Zoid CTF
// mod -- see this file's own header for that distinction.
// ---------------------------------------------------------------------------

//=====================================================
// func_group is editor-only (no runtime behavior); nothing to port.
//=====================================================

const Use_Areaportal = RegisterUse("Use_Areaportal", (ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  ent.count ^= 1; // toggle state
  gi.SetAreaPortalState(ent.style, ent.count !== 0);
});

/*QUAKED func_areaportal (0 0 0) ?
This is a non-visible object that divides the world into
areas that are seperated when this portal is not activated.
Usually enclosed in the middle of a door. */
export function SP_func_areaportal(ent: EdictT): void {
  ent.use = Use_Areaportal;
  ent.count = 0; // always start closed
}

//=====================================================
// Misc functions
//=====================================================

function VelocityForDamage(damage: number, v: Vec3): void {
  v[0] = 100.0 * crandom();
  v[1] = 100.0 * crandom();
  v[2] = frandom(200.0, 300.0);

  if (damage < 50) {
    v[0] *= 0.7;
    v[1] *= 0.7;
    v[2] *= 0.7;
  } else {
    v[0] *= 1.2;
    v[1] *= 1.2;
    v[2] *= 1.2;
  }
}

function ClipGibVelocity(ent: EdictT): void {
  if (ent.velocity[0] < -300) ent.velocity[0] = -300;
  else if (ent.velocity[0] > 300) ent.velocity[0] = 300;
  if (ent.velocity[1] < -300) ent.velocity[1] = -300;
  else if (ent.velocity[1] > 300) ent.velocity[1] = 300;
  if (ent.velocity[2] < 200) ent.velocity[2] = 200; // always some upwards
  else if (ent.velocity[2] > 500) ent.velocity[2] = 500;
}

//=====================================================
// gibs
//=====================================================

const gib_die = RegisterDie("gib_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
  if (mod.id === ModIdT.MOD_CRUSH) G_FreeEdict(self);
});

const gib_touch = RegisterTouch("gib_touch", (self: EdictT, _other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (tr.plane.normal[2] > 0.7) {
    self.s.angles[0] = clamp(self.s.angles[0], -5.0, 5.0);
    self.s.angles[2] = clamp(self.s.angles[2], -5.0, 5.0);
  }
});

export function ThrowGib(self: EdictT, gibname: string, damage: number, type: GibTypeT, scale: number): EdictT | null {
  let gib: EdictT;

  if ((type & GibTypeT.GIB_HEAD) !== 0) {
    gib = self;
    gib.s.event = KexEntityEventT.EV_OTHER_TELEPORT;
    // remove setskin so that it doesn't set the skin wrongly later
    self.monsterinfo.setskin = null;
  } else {
    gib = G_Spawn();
  }

  const size = vec3_muls(self.size, 0.5);
  // since absmin is bloated by 1, un-bloat it here
  const origin = vec3_add(vec3_add(self.absmin, vec3(1, 1, 1)), size);

  let i = 0;
  for (i = 0; i < 3; i++) {
    gib.s.origin = vec3_add(origin, vec3_scaled(vec3(crandom(), crandom(), crandom()), size));

    // try 3 times to get a good, non-solid position
    if ((gi.pointcontents(gib.s.origin) & MASK_SOLID) === 0) break;
  }

  if (i === 3) {
    // only free us if we're not being turned into the gib, otherwise
    // just spawn inside a wall
    if (gib !== self) {
      G_FreeEdict(gib);
      return null;
    }
  }

  gib.s.modelindex = gi.modelindex(gibname);
  gib.s.modelindex2 = 0;
  gib.s.scale = scale;
  gib.solid = SolidT.SOLID_NOT;
  gib.svflags |= SvflagsT.SVF_DEADMONSTER;
  gib.svflags &= ~SvflagsT.SVF_MONSTER;
  gib.clipmask = MASK_SOLID;
  gib.s.effects = EffectsT.EF_NONE;
  gib.s.renderfx = RenderfxT.RF_LOW_PRIORITY;
  gib.s.renderfx |= RenderfxT.RF_NOSHADOW;
  if ((type & GibTypeT.GIB_DEBRIS) === 0) {
    if ((type & GibTypeT.GIB_ACID) !== 0) gib.s.effects |= EffectsT.EF_GREENGIB;
    else gib.s.effects |= EffectsT.EF_GIB;
    gib.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  }
  gib.flags |= EntFlagsT.FL_NO_KNOCKBACK | EntFlagsT.FL_NO_DAMAGE_EFFECTS;
  gib.takedamage = true;
  gib.die = gib_die;
  gib.classname = "gib";
  if ((type & GibTypeT.GIB_SKINNED) !== 0) gib.s.skinnum = self.s.skinnum;
  else gib.s.skinnum = 0;
  gib.s.frame = 0;
  gib.mins = vec3(0, 0, 0);
  gib.maxs = vec3(0, 0, 0);
  gib.s.sound = 0;
  gib.monsterinfo.engine_sound = 0;

  let vscale: number;
  if ((type & GibTypeT.GIB_METALLIC) === 0) {
    gib.movetype = MovetypeT.MOVETYPE_TOSS;
    vscale = (type & GibTypeT.GIB_ACID) !== 0 ? 3.0 : 0.5;
  } else {
    gib.movetype = MovetypeT.MOVETYPE_BOUNCE;
    vscale = 1.0;
  }

  if ((type & GibTypeT.GIB_DEBRIS) !== 0) {
    const v = vec3(100 * crandom(), 100 * crandom(), 100 + 100 * crandom());
    gib.velocity = vec3_add(self.velocity, vec3_muls(v, damage));
  } else {
    const vd = vec3(0, 0, 0);
    VelocityForDamage(damage, vd);
    gib.velocity = vec3_add(self.velocity, vec3_muls(vd, vscale));
    ClipGibVelocity(gib);
  }

  if ((type & GibTypeT.GIB_UPRIGHT) !== 0) {
    gib.touch = gib_touch;
    gib.flags |= EntFlagsT.FL_ALWAYS_TOUCH;
  }

  gib.avelocity[0] = frandom(600);
  gib.avelocity[1] = frandom(600);
  gib.avelocity[2] = frandom(600);

  gib.s.angles[0] = frandom(359);
  gib.s.angles[1] = frandom(359);
  gib.s.angles[2] = frandom(359);

  gib.think = G_FreeEdict;

  const g_instagib = cvarOrDefault("g_instagib", "0");
  if (g_instagib.value !== 0) {
    gib.nextthink = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(5)));
  } else {
    gib.nextthink = Gtime_add(level.time, random_time(Gtime_from_sec(10), Gtime_from_sec(20)));
  }

  gi.linkentity(gib);

  gib.watertype = gi.pointcontents(gib.s.origin);

  if ((gib.watertype & MASK_WATER) !== 0) gib.waterlevel = WaterLevelT.WATER_FEET;
  else gib.waterlevel = WaterLevelT.WATER_NONE;

  return gib;
}

export function ThrowClientHead(self: EdictT, damage: number): void {
  const vd = vec3(0, 0, 0);
  let gibname: string;

  if (brandom()) {
    gibname = "models/objects/gibs/head2/tris.md2";
    self.s.skinnum = 1; // second skin is player
  } else {
    gibname = "models/objects/gibs/skull/tris.md2";
    self.s.skinnum = 0;
  }

  self.s.origin[2] += 32;
  self.s.frame = 0;
  gi.setmodel(self, gibname);
  self.mins = vec3(-16, -16, 0);
  self.maxs = vec3(16, 16, 16);

  self.takedamage = true; // [Paril-KEX] allow takedamage so we get crushed
  self.solid = SolidT.SOLID_TRIGGER; // [Paril-KEX] make 'trigger' so we still move but don't block shots/explode
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.s.effects = EffectsT.EF_GIB;
  self.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  self.s.sound = 0;
  self.flags |= EntFlagsT.FL_NO_KNOCKBACK | EntFlagsT.FL_NO_DAMAGE_EFFECTS;

  self.movetype = MovetypeT.MOVETYPE_BOUNCE;
  VelocityForDamage(damage, vd);
  self.velocity = vec3_add(self.velocity, vd);

  if (self.client !== null) {
    // bodies in the queue don't have a client anymore
    self.client.anim_priority = AnimPriorityT.ANIM_DEATH;
    self.client.anim_end = self.s.frame;
  } else {
    self.think = null;
    self.nextthink = GTIME_ZERO;
  }

  gi.linkentity(self);
}

export function BecomeExplosion1(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(self);
}

export function BecomeExplosion2(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION2);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(self);
}

/** g_local.h:3439-3509's `gib_def_t` overload set, collapsed -- see file
 *  header. `count` defaults to 1, `scale` to 1.0, `type` to GIB_NONE. */
export interface GibDefT {
  count?: number;
  gibname: string;
  scale?: number;
  type?: GibTypeT;
}

/** g_local.h:3514-3519's `ThrowGibs` -- see file header's placement-mismatch
 *  note. */
export function ThrowGibs(self: EdictT, damage: number, gibs: GibDefT[]): void {
  for (const gib of gibs) {
    const count = gib.count ?? 1;
    for (let i = 0; i < count; i++) {
      ThrowGib(self, gib.gibname, damage, gib.type ?? GibTypeT.GIB_NONE, (gib.scale ?? 1.0) * (self.s.scale !== 0 ? self.s.scale : 1));
    }
  }
}

/*QUAKED path_corner (.5 .3 0) (-8 -8 -8) (8 8 8) TELEPORT
Target: next path corner
Pathtarget: gets used when an entity that has
	this path_corner targeted touches it */

const path_corner_touch = RegisterTouch("path_corner_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.movetarget !== self) return;
  if (other.enemy !== null) return;

  if (self.pathtarget !== null) {
    const savetarget = self.target;
    self.target = self.pathtarget;
    G_UseTargets(self, other);
    self.target = savetarget;
  }

  // see m_move; this is just so we don't needlessly check it
  self.flags |= EntFlagsT.FL_PARTIALGROUND;

  let next: EdictT | null = self.target !== null ? G_PickTarget(self.target) : null;

  // [Paril-KEX] don't teleport to a point_combat, it means HOLD for them.
  if (next !== null && next.classname === "path_corner" && SpawnFlags_has(next.spawnflags, SPAWNFLAG_PATH_CORNER_TELEPORT)) {
    const v = vec3(next.s.origin[0], next.s.origin[1], next.s.origin[2] + next.mins[2] - other.mins[2]);
    other.s.origin = v;
    next = next.target !== null ? G_PickTarget(next.target) : null;
    other.s.event = KexEntityEventT.EV_OTHER_TELEPORT;
  }

  other.goalentity = next;
  other.movetarget = next;

  if (self.wait !== 0) {
    other.monsterinfo.pausetime = Gtime_add(level.time, Gtime_from_sec(self.wait));
    if (other.monsterinfo.stand === null) throw new Error("path_corner_touch: other.monsterinfo.stand is null (invariant violated)");
    other.monsterinfo.stand(other);
    return;
  }

  // equivalent to the C++'s `!other->movetarget` check -- movetarget was
  // just set to `next` two lines above.
  if (next === null) {
    // N64 cutscene behavior
    if ((other.hackflags & HACKFLAG_END_CUTSCENE) !== 0) {
      G_FreeEdict(other);
      return;
    }

    other.monsterinfo.pausetime = HOLD_FOREVER;
    if (other.monsterinfo.stand === null) throw new Error("path_corner_touch: other.monsterinfo.stand is null (invariant violated)");
    other.monsterinfo.stand(other);
  } else {
    const v = vec3_sub(next.s.origin, other.s.origin);
    other.ideal_yaw = vectoyaw(v);
  }
});

export function SP_path_corner(self: EdictT): void {
  if (self.targetname === null) {
    gi.Com_Print(`${edictFmt(self)} with no targetname\n`);
    G_FreeEdict(self);
    return;
  }

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = path_corner_touch;
  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  gi.linkentity(self);
}

/*QUAKED point_combat (0.5 0.3 0) (-8 -8 -8) (8 8 8) Hold
Makes this the target of a monster and it will head here
when first activated before going after the activator.  If
hold is selected, it will stay here. */
const point_combat_touch = RegisterTouch("point_combat_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  let activator: EdictT;

  if (other.movetarget !== self) return;

  if (self.target !== null) {
    other.target = self.target;
    const picked = G_PickTarget(other.target);
    other.goalentity = picked;
    other.movetarget = picked;
    if (other.goalentity === null) {
      gi.Com_Print(`${edictFmt(self)} target ${self.target} does not exist\n`);
      other.movetarget = self;
    }
    // [Paril-KEX] allow them to be re-used
    // self.target = null;
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_POINT_COMBAT_HOLD) && (other.flags & (EntFlagsT.FL_SWIM | EntFlagsT.FL_FLY)) === 0n) {
    // already standing
    if ((other.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) return;

    other.monsterinfo.pausetime = HOLD_FOREVER;
    other.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND | MonsterAiFlagsT.AI_REACHED_HOLD_COMBAT | MonsterAiFlagsT.AI_THIRD_EYE;
    if (other.monsterinfo.stand === null) throw new Error("point_combat_touch: other.monsterinfo.stand is null (invariant violated)");
    other.monsterinfo.stand(other);
  }

  if (other.movetarget === self) {
    // [Paril-KEX] if we're holding, keep movetarget set; we will use this
    // to make sure we haven't moved too far from where we want to "guard".
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_POINT_COMBAT_HOLD)) {
      other.target = null;
      other.movetarget = null;
    }

    other.goalentity = other.enemy;
    other.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_COMBAT_POINT;
  }

  if (self.pathtarget !== null) {
    const savetarget = self.target;
    self.target = self.pathtarget;
    if (other.enemy !== null && other.enemy.client !== null) activator = other.enemy;
    else if (other.oldenemy !== null && other.oldenemy.client !== null) activator = other.oldenemy;
    else if (other.activator !== null && other.activator.client !== null) activator = other.activator;
    else activator = other;
    G_UseTargets(self, activator);
    self.target = savetarget;
  }
});

export function SP_point_combat(self: EdictT): void {
  const deathmatch = cvarOrDefault("deathmatch", "0");
  if (deathmatch.value !== 0) {
    G_FreeEdict(self);
    return;
  }
  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = point_combat_touch;
  self.mins = vec3(-8, -8, -16);
  self.maxs = vec3(8, 8, 16);
  self.svflags = SvflagsT.SVF_NOCLIENT;
  gi.linkentity(self);
}

/*QUAKED info_null (0 0.5 0) (-4 -4 -4) (4 4 4)
Used as a positional target for spotlights, etc. */
export function SP_info_null(self: EdictT): void {
  G_FreeEdict(self);
}

/*QUAKED info_notnull (0 0.5 0) (-4 -4 -4) (4 4 4)
Used as a positional target for lightning. */
export function SP_info_notnull(self: EdictT): void {
  self.absmin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  self.absmax = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
}

/*QUAKED light (0 1 0) (-8 -8 -8) (8 8 8) START_OFF ALLOW_IN_DM
Non-displayed light.
Default light value is 300.
Default style is 0.
If targeted, will toggle between on and off.
Default _cone value is 10 (used to set size of light for spotlights) */

const SPAWNFLAG_LIGHT_START_OFF: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_LIGHT_ALLOW_IN_DM: SpawnFlags = SpawnFlags_from(2);

const light_use = RegisterUse("light_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LIGHT_START_OFF)) {
    gi.configstring(CS_LIGHTS + self.style, self.style_on ?? "");
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_LIGHT_START_OFF));
  } else {
    gi.configstring(CS_LIGHTS + self.style, self.style_off ?? "");
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_LIGHT_START_OFF);
  }
});

// ---------------------------------------------------------------------------
// [Sam-KEX] shadow light tracking (g_misc.cpp:507-622)
// ---------------------------------------------------------------------------

interface ShadowLightInfoT {
  entity_number: number;
  shadowlight: ShadowLightDataT;
}

// TODO move to level_locals_t (matches the C++ source's own TODO)
const shadowlightinfo: ShadowLightInfoT[] = Array.from({ length: MAX_SHADOW_LIGHTS }, () => ({
  entity_number: 0,
  shadowlight: defaultShadowLightData(),
}));

export function GetShadowLightData(entity_number: number): ShadowLightDataT | null {
  for (let i = 0; i < level.shadow_light_count; i++) {
    const info = shadowlightinfo[i];
    if (info !== undefined && info.entity_number === entity_number) return info.shadowlight;
  }
  return null;
}

export function setup_shadow_lights(): void {
  for (let i = 0; i < level.shadow_light_count; i++) {
    const info = shadowlightinfo[i];
    if (info === undefined) continue;
    const self = g_edicts[info.entity_number];
    if (self === undefined) continue;

    info.shadowlight.lighttype = ShadowLightTypeT.point;
    info.shadowlight.conedirection = vec3(0, 0, 0);

    if (self.target !== null) {
      const target = G_FindByString(null, "targetname", self.target);
      if (target !== null) {
        const dir = vec3_sub(target.s.origin, self.s.origin);
        vec3_normalize(dir);
        info.shadowlight.conedirection = dir;
        info.shadowlight.lighttype = ShadowLightTypeT.cone;
      }
    }

    if (self.itemtarget !== null) {
      const target = G_FindByString(null, "targetname", self.itemtarget);
      if (target !== null) info.shadowlight.lightstyle = target.style;
    }

    gi.configstring(
      CS_SHADOWLIGHTS + i,
      `${self.s.number};${info.shadowlight.lighttype};${info.shadowlight.radius};${info.shadowlight.resolution};` +
        `${info.shadowlight.intensity};${info.shadowlight.fade_start};${info.shadowlight.fade_end};` +
        `${info.shadowlight.lightstyle};${info.shadowlight.coneangle};${info.shadowlight.conedirection[0]};` +
        `${info.shadowlight.conedirection[1]};${info.shadowlight.conedirection[2]}`,
    );
  }
}

// fix an oversight in shadow light code that causes lights to be ordered
// wrong on return levels if the spawn functions are changed. This will work
// without changing the save/load code.
export function G_LoadShadowLights(): void {
  for (let i = 0; i < level.shadow_light_count; i++) {
    const cstr = gi.get_configstring(CS_SHADOWLIGHTS + i);
    const parts = cstr.split(";"); // see file header's COM_ParseEx note
    const token0 = parts[0];
    if (token0 !== undefined && token0 !== "") {
      const info = shadowlightinfo[i];
      if (info === undefined) continue;
      info.entity_number = parseInt(token0, 10);
      info.shadowlight.lighttype = parseInt(parts[1] ?? "0", 10) as ShadowLightTypeT;
      info.shadowlight.radius = parseFloat(parts[2] ?? "0");
      info.shadowlight.resolution = parseInt(parts[3] ?? "0", 10);
      info.shadowlight.intensity = parseFloat(parts[4] ?? "0");
      info.shadowlight.fade_start = parseFloat(parts[5] ?? "0");
      info.shadowlight.fade_end = parseFloat(parts[6] ?? "0");
      info.shadowlight.lightstyle = parseInt(parts[7] ?? "0", 10);
      info.shadowlight.coneangle = parseFloat(parts[8] ?? "0");
      info.shadowlight.conedirection[0] = parseFloat(parts[9] ?? "0");
      info.shadowlight.conedirection[1] = parseFloat(parts[10] ?? "0");
      info.shadowlight.conedirection[2] = parseFloat(parts[11] ?? "0");
    }
  }
}

// ---------------------------------------------------------------------------

function setup_dynamic_light(self: EdictT): void {
  // [Sam-KEX] Shadow stuff
  if (st.sl.data.radius > 0) {
    self.s.renderfx = RenderfxT.RF_CASTSHADOW;
    self.itemtarget = st.sl.lightstyletarget;

    const info = shadowlightinfo[level.shadow_light_count];
    if (info === undefined) throw new Error("setup_dynamic_light: shadow light count exceeds MAX_SHADOW_LIGHTS");
    info.entity_number = self.s.number;
    info.shadowlight = { ...st.sl.data, conedirection: vec3(st.sl.data.conedirection[0], st.sl.data.conedirection[1], st.sl.data.conedirection[2]) };
    level.shadow_light_count++;

    self.mins = vec3(0, 0, 0);
    self.maxs = vec3(0, 0, 0);

    gi.linkentity(self);
  }
}

const dynamic_light_use = RegisterUse("dynamic_light_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.svflags ^= SvflagsT.SVF_NOCLIENT;
});

export function SP_dynamic_light(self: EdictT): void {
  setup_dynamic_light(self);

  if (self.targetname !== null) {
    self.use = dynamic_light_use;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LIGHT_START_OFF)) self.svflags ^= SvflagsT.SVF_NOCLIENT;
}

export function SP_light(self: EdictT): void {
  const deathmatch = cvarOrDefault("deathmatch", "0");
  // no targeted lights in deathmatch, because they cause global messages
  if ((self.targetname === null || (deathmatch.value !== 0 && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_LIGHT_ALLOW_IN_DM))) && st.sl.data.radius === 0) {
    G_FreeEdict(self);
    return;
  }

  if (self.style >= 32) {
    self.use = light_use;

    if (self.style_on === null || self.style_on === "") self.style_on = "m";
    else if (self.style_on[0] !== undefined && self.style_on[0] >= "0" && self.style_on[0] <= "9") self.style_on = gi.get_configstring(CS_LIGHTS + parseInt(self.style_on, 10));
    if (self.style_off === null || self.style_off === "") self.style_off = "a";
    else if (self.style_off[0] !== undefined && self.style_off[0] >= "0" && self.style_off[0] <= "9") self.style_off = gi.get_configstring(CS_LIGHTS + parseInt(self.style_off, 10));

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LIGHT_START_OFF)) gi.configstring(CS_LIGHTS + self.style, self.style_off);
    else gi.configstring(CS_LIGHTS + self.style, self.style_on);
  }

  setup_dynamic_light(self);
}

/*QUAKED func_wall (0 .5 .8) ? TRIGGER_SPAWN TOGGLE START_ON ANIMATED ANIMATED_FAST
This is just a solid wall if not inhibited

TRIGGER_SPAWN	the wall will not be present until triggered
				it will then blink in to existance; it will
				kill anything that was in it's way

TOGGLE			only valid for TRIGGER_SPAWN walls
				this allows the wall to be turned on and off

START_ON		only valid for TRIGGER_SPAWN walls
				the wall will initially be present */

const SPAWNFLAG_WALL_TRIGGER_SPAWN: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_WALL_TOGGLE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_WALL_START_ON: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_WALL_ANIMATED: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_WALL_ANIMATED_FAST: SpawnFlags = SpawnFlags_from(16);

const func_wall_use = RegisterUse("func_wall_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (self.solid === SolidT.SOLID_NOT) {
    self.solid = SolidT.SOLID_BSP;
    self.svflags &= ~SvflagsT.SVF_NOCLIENT;
    gi.linkentity(self);
    KillBox(self, false);
  } else {
    self.solid = SolidT.SOLID_NOT;
    self.svflags |= SvflagsT.SVF_NOCLIENT;
    gi.linkentity(self);
  }

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_TOGGLE)) self.use = null;
});

export function SP_func_wall(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  if (self.model !== null) gi.setmodel(self, self.model);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_ANIMATED)) self.s.effects |= EffectsT.EF_ANIM_ALL;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_ANIMATED_FAST)) self.s.effects |= EffectsT.EF_ANIM_ALLFAST;

  // just a wall
  const anyTriggerFlags = SpawnFlags_or(SpawnFlags_or(SPAWNFLAG_WALL_TRIGGER_SPAWN, SPAWNFLAG_WALL_TOGGLE), SPAWNFLAG_WALL_START_ON);
  if (!SpawnFlags_has(self.spawnflags, anyTriggerFlags)) {
    self.solid = SolidT.SOLID_BSP;
    gi.linkentity(self);
    return;
  }

  // it must be TRIGGER_SPAWN
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_TRIGGER_SPAWN)) {
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_WALL_TRIGGER_SPAWN);
  }

  // yell if the spawnflags are odd
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_START_ON)) {
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_TOGGLE)) {
      gi.Com_Print("func_wall START_ON without TOGGLE\n");
      self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_WALL_TOGGLE);
    }
  }

  self.use = func_wall_use;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WALL_START_ON)) {
    self.solid = SolidT.SOLID_BSP;
  } else {
    self.solid = SolidT.SOLID_NOT;
    self.svflags |= SvflagsT.SVF_NOCLIENT;
  }
  gi.linkentity(self);
}

// [Paril-KEX]
/*QUAKED func_animation (0 .5 .8) ? START_ON
Similar to func_wall, but triggering it will toggle animation
state rather than going on/off.

START_ON		will start in alterate animation */

const SPAWNFLAG_ANIMATION_START_ON: SpawnFlags = SpawnFlags_from(1);

const func_animation_use = RegisterUse("func_animation_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.bmodel_anim.alternate = !self.bmodel_anim.alternate;
});

export function SP_func_animation(self: EdictT): void {
  if (!self.bmodel_anim.enabled) {
    gi.Com_Print(`${edictFmt(self)} has no animation data\n`);
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  if (self.model !== null) gi.setmodel(self, self.model);
  self.solid = SolidT.SOLID_BSP;

  self.use = func_animation_use;
  self.bmodel_anim.alternate = SpawnFlags_has(self.spawnflags, SPAWNFLAG_ANIMATION_START_ON);

  if (self.bmodel_anim.alternate) self.s.frame = self.bmodel_anim.alt_start;
  else self.s.frame = self.bmodel_anim.start;

  gi.linkentity(self);
}

/*QUAKED func_object (0 .5 .8) ? TRIGGER_SPAWN ANIMATED ANIMATED_FAST
This is solid bmodel that will fall if it's support it removed. */

const SPAWNFLAGS_OBJECT_TRIGGER_SPAWN: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAGS_OBJECT_ANIMATED: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAGS_OBJECT_ANIMATED_FAST: SpawnFlags = SpawnFlags_from(4);

const func_object_touch = RegisterTouch("func_object_touch", (self: EdictT, other: EdictT, tr: KexTraceT, otherTouchingSelf: boolean): void => {
  // only squash thing we fall on top of
  if (otherTouchingSelf) return;
  if (tr.plane.normal[2] < 1.0) return;
  if (!other.takedamage) return;
  if (other.damage_debounce_time > level.time) return;
  T_Damage(other, self, self, vec3_origin, closest_point_to_box(other.s.origin, self.absmin, self.absmax), tr.plane.normal, self.dmg, 1, DamageflagsT.DAMAGE_NONE, {
    id: ModIdT.MOD_CRUSH,
    friendly_fire: false,
    no_point_loss: false,
  });
  other.damage_debounce_time = Gtime_add(level.time, Gtime_from_hz(10));
});

const func_object_release = RegisterThink("func_object_release", (self: EdictT): void => {
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.touch = func_object_touch;
});

const func_object_use = RegisterUse("func_object_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.solid = SolidT.SOLID_BSP;
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.use = null;
  func_object_release(self);
  KillBox(self, false);
});

export function SP_func_object(self: EdictT): void {
  if (self.model !== null) gi.setmodel(self, self.model);

  self.mins[0] += 1;
  self.mins[1] += 1;
  self.mins[2] += 1;
  self.maxs[0] -= 1;
  self.maxs[1] -= 1;
  self.maxs[2] -= 1;

  if (self.dmg === 0) self.dmg = 100;

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAGS_OBJECT_TRIGGER_SPAWN)) {
    self.solid = SolidT.SOLID_BSP;
    self.movetype = MovetypeT.MOVETYPE_PUSH;
    self.think = func_object_release;
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(20));
  } else {
    self.solid = SolidT.SOLID_NOT;
    self.movetype = MovetypeT.MOVETYPE_PUSH;
    self.use = func_object_use;
    self.svflags |= SvflagsT.SVF_NOCLIENT;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_OBJECT_ANIMATED)) self.s.effects |= EffectsT.EF_ANIM_ALL;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_OBJECT_ANIMATED_FAST)) self.s.effects |= EffectsT.EF_ANIM_ALLFAST;

  self.clipmask = MASK_MONSTERSOLID;
  self.flags |= EntFlagsT.FL_NO_STANDING;

  gi.linkentity(self);
}

/*QUAKED func_explosive (0 .5 .8) ? Trigger_Spawn ANIMATED ANIMATED_FAST INACTIVE ALWAYS_SHOOTABLE
Any brush that you want to explode or break apart.  If you want an
ex0plosion, set dmg and it will do a radius explosion of that amount
at the center of the bursh.

If targeted it will not be shootable.

INACTIVE - specifies that the entity is not explodable until triggered. If you use this you must
target the entity you want to trigger it. This is the only entity approved to activate it.

health defaults to 100.

mass defaults to 75.  This determines how much debris is emitted when
it explodes.  You get one large chunk per 100 of mass (up to 8) and
one small chunk per 25 of mass (up to 16).  So 800 gives the most. */

const SPAWNFLAGS_EXPLOSIVE_TRIGGER_SPAWN: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAGS_EXPLOSIVE_ANIMATED: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAGS_EXPLOSIVE_ANIMATED_FAST: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAGS_EXPLOSIVE_INACTIVE: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAGS_EXPLOSIVE_ALWAYS_SHOOTABLE: SpawnFlags = SpawnFlags_from(16);

const func_explosive_explode = RegisterDie(
  "func_explosive_explode",
  (self: EdictT, inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    self.takedamage = false;

    if (self.dmg !== 0) {
      T_RadiusDamage(self, attacker, self.dmg, null, self.dmg + 40, DamageflagsT.DAMAGE_NONE, { id: ModIdT.MOD_EXPLOSIVE, friendly_fire: false, no_point_loss: false });
    }

    self.velocity = vec3_sub(inflictor.s.origin, self.s.origin);
    vec3_normalize(self.velocity);
    self.velocity = vec3_muls(self.velocity, 150);

    let mass = self.mass;
    if (mass === 0) mass = 75;

    // big chunks
    if (mass >= 100) {
      let count = Math.floor(mass / 100);
      if (count > 8) count = 8;
      ThrowGibs(self, 1, [{ count, gibname: "models/objects/debris1/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS }]);
    }

    // small chunks
    let smallCount = Math.floor(mass / 25);
    if (smallCount > 16) smallCount = 16;
    ThrowGibs(self, 2, [{ count: smallCount, gibname: "models/objects/debris2/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS }]);

    // PMM - if we're part of a train, clean ourselves out of it
    if ((self.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) {
      if (self.teammaster !== null) {
        let master: EdictT | null = self.teammaster;
        // because mappers (other than jim (usually)) are stupid....
        if (master !== null && master.inuse) {
          let done = false;
          while (!done) {
            if (master === null) {
              throw new Error("func_explosive_explode: walked off the end of a team chain looking for self (malformed team data)");
            }
            if (master.teamchain === self) {
              master.teamchain = self.teamchain;
              done = true;
            }
            master = master.teamchain;
          }
        }
      }
    }

    G_UseTargets(self, attacker);

    self.s.origin = vec3_muls(vec3_add(self.absmin, self.absmax), 0.5);

    if (self.noise_index !== 0) {
      gi.positioned_sound(self.s.origin, self, SoundchanT.CHAN_AUTO, self.noise_index, 1, ATTN_NORM, 0);
    }

    if (self.dmg !== 0) BecomeExplosion1(self);
    else G_FreeEdict(self);
  },
);

const func_explosive_use = RegisterUse("func_explosive_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  // Paril: pass activator to explode as attacker. this fixes "strike" trying
  // to centerprint to the relay. Should be a safe change.
  if (activator === null) {
    throw new Error("func_explosive_use: activator is null (invariant violated -- C++ passes it unchecked to func_explosive_explode's non-null attacker param)");
  }
  func_explosive_explode(self, self, activator, self.health, vec3_origin, { id: ModIdT.MOD_EXPLOSIVE, friendly_fire: false, no_point_loss: false });
});

// PGM
const func_explosive_activate = RegisterUse("func_explosive_activate", (self: EdictT, other: EdictT | null, activator: EdictT | null): void => {
  let approved = false;
  // PMM - looked like target and targetname were flipped here
  if (other !== null && other.target !== null) {
    if (other.target === self.targetname) approved = true;
  }
  if (!approved && activator !== null && activator.target !== null) {
    if (activator.target === self.targetname) approved = true;
  }

  if (!approved) return;

  self.use = func_explosive_use;
  if (self.health === 0) self.health = 100;
  self.die = func_explosive_explode;
  self.takedamage = true;
});
// PGM

const func_explosive_spawn = RegisterUse("func_explosive_spawn", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.solid = SolidT.SOLID_BSP;
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.use = null;
  gi.linkentity(self);
  KillBox(self, false);
});

export function SP_func_explosive(self: EdictT): void {
  const deathmatch = cvarOrDefault("deathmatch", "0");
  if (deathmatch.value !== 0) {
    // auto-remove for deathmatch
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;

  gi.modelindex("models/objects/debris1/tris.md2");
  gi.modelindex("models/objects/debris2/tris.md2");

  if (self.model !== null) gi.setmodel(self, self.model);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EXPLOSIVE_TRIGGER_SPAWN)) {
    self.svflags |= SvflagsT.SVF_NOCLIENT;
    self.solid = SolidT.SOLID_NOT;
    self.use = func_explosive_spawn;
  }
  // PGM
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EXPLOSIVE_INACTIVE)) {
    self.solid = SolidT.SOLID_BSP;
    if (self.targetname !== null) self.use = func_explosive_activate;
  }
  // PGM
  else {
    self.solid = SolidT.SOLID_BSP;
    if (self.targetname !== null) self.use = func_explosive_use;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EXPLOSIVE_ANIMATED)) self.s.effects |= EffectsT.EF_ANIM_ALL;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EXPLOSIVE_ANIMATED_FAST)) self.s.effects |= EffectsT.EF_ANIM_ALLFAST;

  // PGM
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EXPLOSIVE_ALWAYS_SHOOTABLE) || (self.use !== func_explosive_use && self.use !== func_explosive_activate)) {
    // PGM
    if (self.health === 0) self.health = 100;
    self.die = func_explosive_explode;
    self.takedamage = true;
  }

  if (self.sounds !== 0) {
    if (self.sounds === 1) self.noise_index = gi.soundindex("world/brkglas.wav");
    else gi.Com_Print(`${edictFmt(self)}: invalid "sounds" ${self.sounds}\n`);
  }

  gi.linkentity(self);
}

/*QUAKED misc_explobox (0 .5 .8) (-16 -16 0) (16 16 40)
Large exploding box.  You can override its mass (100),
health (80), and dmg (150). */

const barrel_touch = RegisterTouch("barrel_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, otherTouchingSelf: boolean): void => {
  if (other.groundentity === null || other.groundentity === self) return;
  else if (!otherTouchingSelf) return;

  const ratio = other.mass / self.mass;
  const v = vec3_sub(self.s.origin, other.s.origin);
  M_walkmove(self, vectoyaw(v), 20 * ratio * gi.frame_time_s);
});

const barrel_explode = RegisterThink("barrel_explode", (self: EdictT): void => {
  self.takedamage = false;

  if (self.activator === null) {
    throw new Error("barrel_explode: self.activator is null (invariant violated -- barrel_delay always sets it before switching to this think)");
  }
  T_RadiusDamage(self, self.activator, self.dmg, null, self.dmg + 40, DamageflagsT.DAMAGE_NONE, { id: ModIdT.MOD_BARREL, friendly_fire: false, no_point_loss: false });

  ThrowGibs(self, (1.5 * self.dmg) / 200, [
    { count: 2, gibname: "models/objects/debris1/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS },
    { count: 4, gibname: "models/objects/debris3/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS },
    { count: 8, gibname: "models/objects/debris2/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS },
  ]);

  if (self.groundentity !== null) BecomeExplosion2(self);
  else BecomeExplosion1(self);
});

const barrel_burn = RegisterThink("barrel_burn", (self: EdictT): void => {
  if (level.time >= self.timestamp) self.think = barrel_explode;

  self.s.effects |= EffectsT.EF_BARREL_EXPLODING;
  self.s.sound = gi.soundindex("weapons/bfg__l1a.wav");
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

const barrel_delay = RegisterDie("barrel_delay", (self: EdictT, _inflictor: EdictT, attacker: EdictT, damage: number, _point: Vec3, _mod: ModT): void => {
  // allow "dead" barrels waiting to explode to still receive knockback
  if (self.think === barrel_burn || self.think === barrel_explode) return;

  // allow big booms to immediately blow up barrels (rockets, rail, other
  // explosions) because it feels good and powerful
  if (damage >= 90) {
    self.think = barrel_explode;
    self.activator = attacker;
  } else {
    self.timestamp = Gtime_add(level.time, Gtime_from_ms(750));
    self.think = barrel_burn;
    self.activator = attacker;
  }
});

//=========
// PGM  - change so barrels will think and hence, blow up
const barrel_think = RegisterThink("barrel_think", (self: EdictT): void => {
  // the think needs to be first since later stuff may override.
  self.think = barrel_think;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  M_CatagorizePositionSelf(self, self.s.origin);
  self.flags |= EntFlagsT.FL_IMMUNE_SLIME;
  self.air_finished = Gtime_add(level.time, Gtime_from_sec(100));
  M_WorldEffects(self);
});

const barrel_start = RegisterThink("barrel_start", (self: EdictT): void => {
  M_droptofloor(self);
  self.think = barrel_think;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});
// PGM
//=========

export function SP_misc_explobox(self: EdictT): void {
  const deathmatch = cvarOrDefault("deathmatch", "0");
  if (deathmatch.value !== 0) {
    // auto-remove for deathmatch
    G_FreeEdict(self);
    return;
  }

  gi.modelindex("models/objects/debris1/tris.md2");
  gi.modelindex("models/objects/debris2/tris.md2");
  gi.modelindex("models/objects/debris3/tris.md2");
  gi.soundindex("weapons/bfg__l1a.wav");

  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_STEP;

  self.model = "models/objects/barrels/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  self.mins = vec3(-16, -16, 0);
  self.maxs = vec3(16, 16, 40);

  if (self.mass === 0) self.mass = 50;
  if (self.health === 0) self.health = 10;
  if (self.dmg === 0) self.dmg = 150;

  self.die = barrel_delay;
  self.takedamage = true;
  self.flags |= EntFlagsT.FL_TRAP;

  self.touch = barrel_touch;

  // PGM - change so barrels will think and hence, blow up
  self.think = barrel_start;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(20));
  // PGM

  gi.linkentity(self);
}

//
// miscellaneous specialty items
//

/*QUAKED misc_blackhole (1 .5 0) (-8 -8 -8) (8 8 8) AUTO_NOISE
model="models/objects/black/tris.md2" */

const SPAWNFLAG_BLACKHOLE_AUTO_NOISE: SpawnFlags = SpawnFlags_from(1);

const misc_blackhole_use = RegisterUse("misc_blackhole_use", (ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  G_FreeEdict(ent);
});

const misc_blackhole_think = RegisterThink("misc_blackhole_think", (self: EdictT): void => {
  if (self.timestamp <= level.time) {
    self.s.frame++;
    if (self.s.frame >= 19) self.s.frame = 0;

    self.timestamp = Gtime_add(level.time, Gtime_from_hz(10));
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_BLACKHOLE_AUTO_NOISE)) {
    self.s.angles[0] += 50.0 * gi.frame_time_s;
    self.s.angles[1] += 50.0 * gi.frame_time_s;
  }

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

export function SP_misc_blackhole(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.mins = vec3(-64, -64, 0);
  ent.maxs = vec3(64, 64, 8);
  ent.s.modelindex = gi.modelindex("models/objects/black/tris.md2");
  ent.s.renderfx = RenderfxT.RF_TRANSLUCENT;
  ent.use = misc_blackhole_use;
  ent.think = misc_blackhole_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(20));

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_BLACKHOLE_AUTO_NOISE)) {
    ent.s.sound = gi.soundindex("world/blackhole.wav");
    ent.s.loop_attenuation = ATTN_NORM;
  }

  gi.linkentity(ent);
}

/*QUAKED misc_eastertank (1 .5 0) (-32 -32 -16) (32 32 32) */

const misc_eastertank_think = RegisterThink("misc_eastertank_think", (self: EdictT): void => {
  self.s.frame++;
  if (self.s.frame < 293) {
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  } else {
    self.s.frame = 254;
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

export function SP_misc_eastertank(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.mins = vec3(-32, -32, -16);
  ent.maxs = vec3(32, 32, 32);
  ent.s.modelindex = gi.modelindex("models/monsters/tank/tris.md2");
  ent.s.frame = 254;
  ent.think = misc_eastertank_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(20));
  gi.linkentity(ent);
}

/*QUAKED misc_easterchick (1 .5 0) (-32 -32 0) (32 32 32) */

const misc_easterchick_think = RegisterThink("misc_easterchick_think", (self: EdictT): void => {
  self.s.frame++;
  if (self.s.frame < 247) {
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  } else {
    self.s.frame = 208;
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

export function SP_misc_easterchick(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.mins = vec3(-32, -32, 0);
  ent.maxs = vec3(32, 32, 32);
  ent.s.modelindex = gi.modelindex("models/monsters/bitch/tris.md2");
  ent.s.frame = 208;
  ent.think = misc_easterchick_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(20));
  gi.linkentity(ent);
}

/*QUAKED misc_easterchick2 (1 .5 0) (-32 -32 0) (32 32 32) */

const misc_easterchick2_think = RegisterThink("misc_easterchick2_think", (self: EdictT): void => {
  self.s.frame++;
  if (self.s.frame < 287) {
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  } else {
    self.s.frame = 248;
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

export function SP_misc_easterchick2(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.mins = vec3(-32, -32, 0);
  ent.maxs = vec3(32, 32, 32);
  ent.s.modelindex = gi.modelindex("models/monsters/bitch/tris.md2");
  ent.s.frame = 248;
  ent.think = misc_easterchick2_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(20));
  gi.linkentity(ent);
}

/*QUAKED monster_commander_body (1 .5 0) (-32 -32 0) (32 32 48)
Not really a monster, this is the Tank Commander's decapitated body.
There should be a item_commander_head that has this as it's target. */

const commander_body_think = RegisterThink("commander_body_think", (self: EdictT): void => {
  self.s.frame++;
  if (self.s.frame < 24) self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  else self.nextthink = GTIME_ZERO;

  if (self.s.frame === 22) gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("tank/thud.wav"), 1, ATTN_NORM, 0);
});

const commander_body_use = RegisterUse("commander_body_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.think = commander_body_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("tank/pain.wav"), 1, ATTN_NORM, 0);
});

const commander_body_drop = RegisterThink("commander_body_drop", (self: EdictT): void => {
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.s.origin[2] += 2;
});

export function SP_monster_commander_body(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_BBOX;
  self.model = "models/monsters/commandr/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  self.mins = vec3(-32, -32, 0);
  self.maxs = vec3(32, 32, 48);
  self.use = commander_body_use;
  self.takedamage = true;
  self.flags = EntFlagsT.FL_GODMODE;
  gi.linkentity(self);

  gi.soundindex("tank/thud.wav");
  gi.soundindex("tank/pain.wav");

  self.think = commander_body_drop;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(50));
}

/*QUAKED misc_banner (1 .5 0) (-4 -4 -4) (4 4 4)
The origin is the bottom of the banner.
The banner is 128 tall.
model="models/objects/banner/tris.md2" */
const misc_banner_think = RegisterThink("misc_banner_think", (ent: EdictT): void => {
  ent.s.frame = (ent.s.frame + 1) % 16;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

export function SP_misc_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/objects/banner/tris.md2");
  ent.s.frame = irandom(16);
  gi.linkentity(ent);

  ent.think = misc_banner_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
}

/*QUAKED misc_deadsoldier (1 .5 0) (-16 -16 0) (16 16 16) ON_BACK ON_STOMACH BACK_DECAP FETAL_POS SIT_DECAP IMPALED
This is the dead player model. Comes in 6 exciting different poses! */

const SPAWNFLAGS_DEADSOLDIER_ON_BACK: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAGS_DEADSOLDIER_ON_STOMACH: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAGS_DEADSOLDIER_BACK_DECAP: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAGS_DEADSOLDIER_FETAL_POS: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAGS_DEADSOLDIER_SIT_DECAP: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAGS_DEADSOLDIER_IMPALED: SpawnFlags = SpawnFlags_from(32);

const misc_deadsoldier_die = RegisterDie(
  "misc_deadsoldier_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, _mod: ModT): void => {
    if (self.health > -30) return;

    gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    ThrowGibs(self, damage, [
      { count: 4, gibname: "models/objects/gibs/sm_meat/tris.md2" },
      { gibname: "models/objects/gibs/head2/tris.md2", type: GibTypeT.GIB_HEAD },
    ]);
  },
);

export function SP_misc_deadsoldier(ent: EdictT): void {
  const deathmatch = cvarOrDefault("deathmatch", "0");
  if (deathmatch.value !== 0) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.s.modelindex = gi.modelindex("models/deadbods/dude/tris.md2");

  // Defaults to frame 0
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_DEADSOLDIER_ON_STOMACH)) ent.s.frame = 1;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_DEADSOLDIER_BACK_DECAP)) ent.s.frame = 2;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_DEADSOLDIER_FETAL_POS)) ent.s.frame = 3;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_DEADSOLDIER_SIT_DECAP)) ent.s.frame = 4;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_DEADSOLDIER_IMPALED)) ent.s.frame = 5;
  else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_DEADSOLDIER_ON_BACK)) ent.s.frame = 0;
  else ent.s.frame = 0;

  ent.mins = vec3(-16, -16, 0);
  ent.maxs = vec3(16, 16, 16);
  ent.deadflag = true;
  ent.takedamage = true;
  // nb: SVF_MONSTER is here so it bleeds
  ent.svflags |= SvflagsT.SVF_MONSTER | SvflagsT.SVF_DEADMONSTER;
  ent.die = misc_deadsoldier_die;
  ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_GOOD_GUY | MonsterAiFlagsT.AI_DO_NOT_COUNT;

  gi.linkentity(ent);
}

/*QUAKED misc_viper (1 .5 0) (-16 -16 0) (16 16 32)
This is the Viper for the flyby bombing.
It is trigger_spawned, so you must have something use it for it to show up.
There must be a path for it to follow once it is activated.

"speed"		How fast the Viper should fly */

export const misc_viper_use = RegisterUse("misc_viper_use", (self: EdictT, other: EdictT | null, activator: EdictT | null): void => {
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.use = train_use;
  train_use(self, other, activator);
});

export function SP_misc_viper(ent: EdictT): void {
  if (ent.target === null) {
    gi.Com_Print(`${edictFmt(ent)} without a target\n`);
    G_FreeEdict(ent);
    return;
  }

  if (ent.speed === 0) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/viper/tris.md2");
  ent.mins = vec3(-16, -16, 0);
  ent.maxs = vec3(16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  ent.use = misc_viper_use;
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.moveinfo.accel = ent.speed;
  ent.moveinfo.decel = ent.speed;
  ent.moveinfo.speed = ent.speed;

  gi.linkentity(ent);
}

/*QUAKED misc_bigviper (1 .5 0) (-176 -120 -24) (176 120 72)
This is a large stationary viper as seen in Paul's intro */
export function SP_misc_bigviper(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.mins = vec3(-176, -120, -24);
  ent.maxs = vec3(176, 120, 72);
  ent.s.modelindex = gi.modelindex("models/ships/bigviper/tris.md2");
  gi.linkentity(ent);
}

/*QUAKED misc_viper_bomb (1 0 0) (-8 -8 -8) (8 8 8)
"dmg"	how much boom should the bomb make? */
const misc_viper_bomb_touch = RegisterTouch("misc_viper_bomb_touch", (self: EdictT, _other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  G_UseTargets(self, self.activator);

  self.s.origin[2] = self.absmin[2] + 1;
  T_RadiusDamage(self, self, self.dmg, null, self.dmg + 40, DamageflagsT.DAMAGE_NONE, { id: ModIdT.MOD_BOMB, friendly_fire: false, no_point_loss: false });
  BecomeExplosion2(self);
});

const misc_viper_bomb_prethink = RegisterPrethink("misc_viper_bomb_prethink", (self: EdictT): void => {
  self.groundentity = null;

  let diff = Gtime_seconds(Gtime_subtract(self.timestamp, level.time));
  if (diff < -1.0) diff = -1.0;

  const v = vec3_muls(self.moveinfo.dir, 1.0 + diff);
  v[2] = diff;

  const prevZ = self.s.angles[2];
  self.s.angles = vectoangles(v);
  self.s.angles[2] = (prevZ ?? 0) + 10;
});

const misc_viper_bomb_use = RegisterUse("misc_viper_bomb_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.solid = SolidT.SOLID_BBOX;
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.s.effects |= EffectsT.EF_ROCKET;
  self.use = null;
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.prethink = misc_viper_bomb_prethink;
  self.touch = misc_viper_bomb_touch;
  self.activator = activator;

  const viper = G_FindByString(null, "classname", "misc_viper");
  if (viper === null) throw new Error("misc_viper_bomb_use: no misc_viper found (invariant violated -- viper bombs require a live misc_viper)");
  self.velocity = vec3_muls(viper.moveinfo.dir, viper.moveinfo.speed);

  self.timestamp = level.time;
  self.moveinfo.dir = vec3(viper.moveinfo.dir[0], viper.moveinfo.dir[1], viper.moveinfo.dir[2]);
});

export function SP_misc_viper_bomb(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);

  self.s.modelindex = gi.modelindex("models/objects/bomb/tris.md2");

  if (self.dmg === 0) self.dmg = 1000;

  self.use = misc_viper_bomb_use;
  self.svflags |= SvflagsT.SVF_NOCLIENT;

  gi.linkentity(self);
}

/*QUAKED misc_strogg_ship (1 .5 0) (-16 -16 0) (16 16 32)
This is a Storgg ship for the flybys.
It is trigger_spawned, so you must have something use it for it to show up.
There must be a path for it to follow once it is activated.

"speed"		How fast it should fly */
export const misc_strogg_ship_use = RegisterUse("misc_strogg_ship_use", (self: EdictT, other: EdictT | null, activator: EdictT | null): void => {
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.use = train_use;
  train_use(self, other, activator);
});

export function SP_misc_strogg_ship(ent: EdictT): void {
  if (ent.target === null) {
    gi.Com_Print(`${edictFmt(ent)} without a target\n`);
    G_FreeEdict(ent);
    return;
  }

  if (ent.speed === 0) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/strogg1/tris.md2");
  ent.mins = vec3(-16, -16, 0);
  ent.maxs = vec3(16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  ent.use = misc_strogg_ship_use;
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.moveinfo.accel = ent.speed;
  ent.moveinfo.decel = ent.speed;
  ent.moveinfo.speed = ent.speed;

  gi.linkentity(ent);
}

/*QUAKED misc_satellite_dish (1 .5 0) (-64 -64 0) (64 64 128)
model="models/objects/satellite/tris.md2" */
const misc_satellite_dish_think = RegisterThink("misc_satellite_dish_think", (self: EdictT): void => {
  self.s.frame++;
  if (self.s.frame < 38) self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

const misc_satellite_dish_use = RegisterUse("misc_satellite_dish_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.s.frame = 0;
  self.think = misc_satellite_dish_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

export function SP_misc_satellite_dish(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.mins = vec3(-64, -64, 0);
  ent.maxs = vec3(64, 64, 128);
  ent.s.modelindex = gi.modelindex("models/objects/satellite/tris.md2");
  ent.use = misc_satellite_dish_use;
  gi.linkentity(ent);
}

/*QUAKED light_mine1 (0 1 0) (-2 -2 -12) (2 2 12) */
export function SP_light_mine1(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.svflags = SvflagsT.SVF_DEADMONSTER;
  ent.s.modelindex = gi.modelindex("models/objects/minelite/light1/tris.md2");
  gi.linkentity(ent);
}

/*QUAKED light_mine2 (0 1 0) (-2 -2 -12) (2 2 12) */
export function SP_light_mine2(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.svflags = SvflagsT.SVF_DEADMONSTER;
  ent.s.modelindex = gi.modelindex("models/objects/minelite/light2/tris.md2");
  gi.linkentity(ent);
}

/*QUAKED misc_gib_arm (1 0 0) (-8 -8 -8) (8 8 8)
Intended for use with the target_spawner */
export function SP_misc_gib_arm(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/gibs/arm/tris.md2");
  ent.solid = SolidT.SOLID_NOT;
  ent.s.effects |= EffectsT.EF_GIB;
  ent.takedamage = true;
  ent.die = gib_die;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.deadflag = true;
  ent.avelocity[0] = frandom(200);
  ent.avelocity[1] = frandom(200);
  ent.avelocity[2] = frandom(200);
  ent.think = G_FreeEdict;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(10));
  gi.linkentity(ent);
}

/*QUAKED misc_gib_leg (1 0 0) (-8 -8 -8) (8 8 8)
Intended for use with the target_spawner */
export function SP_misc_gib_leg(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/gibs/leg/tris.md2");
  ent.solid = SolidT.SOLID_NOT;
  ent.s.effects |= EffectsT.EF_GIB;
  ent.takedamage = true;
  ent.die = gib_die;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.deadflag = true;
  ent.avelocity[0] = frandom(200);
  ent.avelocity[1] = frandom(200);
  ent.avelocity[2] = frandom(200);
  ent.think = G_FreeEdict;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(10));
  gi.linkentity(ent);
}

/*QUAKED misc_gib_head (1 0 0) (-8 -8 -8) (8 8 8)
Intended for use with the target_spawner */
export function SP_misc_gib_head(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/gibs/head/tris.md2");
  ent.solid = SolidT.SOLID_NOT;
  ent.s.effects |= EffectsT.EF_GIB;
  ent.takedamage = true;
  ent.die = gib_die;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.deadflag = true;
  ent.avelocity[0] = frandom(200);
  ent.avelocity[1] = frandom(200);
  ent.avelocity[2] = frandom(200);
  ent.think = G_FreeEdict;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(10));
  gi.linkentity(ent);
}

//=====================================================

/*QUAKED target_character (0 0 1) ?
used with target_string (must be on same "team")
"count" is position in the string (starts at 1) */

export function SP_target_character(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  if (self.model !== null) gi.setmodel(self, self.model);
  self.solid = SolidT.SOLID_BSP;
  self.s.frame = 12;
  gi.linkentity(self);
}

/*QUAKED target_string (0 0 1) (-8 -8 -8) (8 8 8) */

const target_string_use = RegisterUse("target_string_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (self.message === null) return;
  const msg = self.message;
  const l = msg.length;

  for (let e: EdictT | null = self.teammaster; e !== null; e = e.teamchain) {
    if (e.count === 0) continue;
    const n = e.count - 1;
    if (n > l) {
      e.s.frame = 12;
      continue;
    }

    // NOTE: the C++ source reads one PAST strlen() here (the NUL
    // terminator, `c == '\0'`), which falls to the `else` branch below --
    // TS's out-of-range `msg[n]` returns `undefined`, which also falls to
    // the same `else` branch. Same observable result. See file header.
    const c = msg[n];
    if (c !== undefined && c >= "0" && c <= "9") e.s.frame = c.charCodeAt(0) - "0".charCodeAt(0);
    else if (c === "-") e.s.frame = 10;
    else if (c === ":") e.s.frame = 11;
    else e.s.frame = 12;
  }
});

export function SP_target_string(self: EdictT): void {
  if (self.message === null) self.message = "";
  self.use = target_string_use;
}

/*QUAKED func_clock (0 0 1) (-8 -8 -8) (8 8 8) TIMER_UP TIMER_DOWN START_OFF MULTI_USE
target a target_string with this

The default is to be a time of day clock

TIMER_UP and TIMER_DOWN run for "count" seconds and then fire "pathtarget"
If START_OFF, this entity must be used before it starts

"style"		0 "xx"
			1 "xx:xx"
			2 "xx:xx:xx" */

const SPAWNFLAG_TIMER_UP: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_TIMER_DOWN: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_TIMER_START_OFF: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_TIMER_MULTI_USE: SpawnFlags = SpawnFlags_from(8);

function func_clock_reset(self: EdictT): void {
  self.activator = null;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_UP)) {
    self.health = 0;
    self.wait = self.count;
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_DOWN)) {
    self.health = self.count;
    self.wait = 0;
  }
}

function func_clock_format_countdown(self: EdictT): void {
  if (self.style === 0) {
    self.clock_message = padWidth(self.health, 2, " ");
    return;
  }

  if (self.style === 1) {
    self.clock_message = `${padWidth(Math.trunc(self.health / 60), 2, " ")}:${padWidth(self.health % 60, 2, "0")}`;
    return;
  }

  if (self.style === 2) {
    const hours = Math.trunc(self.health / 3600);
    const minutes = Math.trunc((self.health - hours * 3600) / 60);
    self.clock_message = `${padWidth(hours, 2, " ")}:${padWidth(minutes, 2, "0")}:${padWidth(self.health % 60, 2, "0")}`;
    return;
  }
}

const func_clock_think = RegisterThink("func_clock_think", (self: EdictT): void => {
  if (self.enemy === null) {
    if (self.target === null) throw new Error("func_clock_think: self.target is null (invariant violated -- SP_func_clock requires a target)");
    self.enemy = G_FindByString(null, "targetname", self.target);
    if (self.enemy === null) return;
  }
  const enemy = self.enemy;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_UP)) {
    func_clock_format_countdown(self);
    self.health++;
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_DOWN)) {
    func_clock_format_countdown(self);
    self.health--;
  } else {
    const now = new Date();
    self.clock_message = `${padWidth(now.getHours(), 2, " ")}:${padWidth(now.getMinutes(), 2, "0")}:${padWidth(now.getSeconds(), 2, "0")}`;
  }

  enemy.message = self.clock_message;
  if (enemy.use === null) throw new Error("func_clock_think: enemy.use is null (invariant violated)");
  enemy.use(enemy, self, self);

  if (
    (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_UP) && self.health > self.wait) ||
    (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_DOWN) && self.health < self.wait)
  ) {
    if (self.pathtarget !== null) {
      const savetarget = self.target;
      self.target = self.pathtarget;
      G_UseTargets(self, self.activator);
      self.target = savetarget;
    }

    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_MULTI_USE)) return;

    func_clock_reset(self);

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_START_OFF)) return;
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
});

const func_clock_use = RegisterUse("func_clock_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_MULTI_USE)) self.use = null;
  if (self.activator !== null) return;
  self.activator = activator;
  if (self.think === null) throw new Error("func_clock_use: self.think is null (invariant violated)");
  self.think(self);
});

export function SP_func_clock(self: EdictT): void {
  if (self.target === null) {
    gi.Com_Print(`${edictFmt(self)} with no target\n`);
    G_FreeEdict(self);
    return;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_DOWN) && self.count === 0) {
    gi.Com_Print(`${edictFmt(self)} with no count\n`);
    G_FreeEdict(self);
    return;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_UP) && self.count === 0) self.count = 60 * 60;

  func_clock_reset(self);

  self.think = func_clock_think;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TIMER_START_OFF)) self.use = func_clock_use;
  else self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
}

//=================================================================================

const SPAWNFLAG_TELEPORTER_NO_SOUND: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_TELEPORTER_NO_TELEPORT_EFFECT: SpawnFlags = SpawnFlags_from(2);

const teleporter_touch = RegisterTouch("teleporter_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  const client = other.client;
  if (client === null) return;

  if (self.target === null) {
    throw new Error("teleporter_touch: self.target is null (invariant violated -- SP_misc_teleporter only wires this touch when target is set)");
  }
  const dest = G_FindByString(null, "targetname", self.target);
  if (dest === null) {
    gi.Com_Print("Couldn't find destination\n");
    return;
  }

  // ZOID
  CTFPlayerResetGrapple(other);
  // ZOID

  // unlink to make sure it can't possibly interfere with KillBox
  gi.unlinkentity(other);

  other.s.origin = vec3(dest.s.origin[0], dest.s.origin[1], dest.s.origin[2] + 10);
  other.s.old_origin = vec3(dest.s.origin[0], dest.s.origin[1], dest.s.origin[2]);

  // clear the velocity and hold them in place briefly
  other.velocity = vec3(0, 0, 0);
  client.ps.pmove.pm_time = 160; // hold time
  client.ps.pmove.pm_flags |= PmflagsT.PMF_TIME_TELEPORT;

  if (self.owner === null) {
    throw new Error("teleporter_touch: self.owner is null (invariant violated -- SP_misc_teleporter always sets trig.owner)");
  }
  // draw the teleport splash at source and on the player
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TELEPORTER_NO_TELEPORT_EFFECT)) {
    self.owner.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;
    other.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;
  } else {
    self.owner.s.event = KexEntityEventT.EV_OTHER_TELEPORT;
    other.s.event = KexEntityEventT.EV_OTHER_TELEPORT;
  }

  // set angles
  client.ps.pmove.delta_angles = vec3_sub(dest.s.angles, client.resp.cmd_angles);

  other.s.angles = vec3(0, 0, 0);
  client.ps.viewangles = vec3(0, 0, 0);
  client.v_angle = vec3(0, 0, 0);
  AngleVectors(client.v_angle, client.v_forward, null, null);

  gi.linkentity(other);

  // kill anything at the destination
  KillBox(other, true);

  // [Paril-KEX] move sphere, if we own it
  if (client.owned_sphere !== null) {
    const sphere = client.owned_sphere;
    sphere.s.origin = vec3(other.s.origin[0], other.s.origin[1], other.absmax[2]);
    sphere.s.angles[YAW] = other.s.angles[YAW];
    gi.linkentity(sphere);
  }
});

/*QUAKED misc_teleporter (1 0 0) (-32 -32 -24) (32 32 -16) NO_SOUND NO_TELEPORT_EFFECT N64_EFFECT
Stepping onto this disc will teleport players to the targeted misc_teleporter_dest object. */
// NOTE: "TEMEPORTER" is a verbatim-preserved typo from g_misc.cpp:2066 -- see file header.
const SPAWNFLAG_TEMEPORTER_N64_EFFECT: SpawnFlags = SpawnFlags_from(4);

export function SP_misc_teleporter(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/dmspot/tris.md2");
  ent.s.skinnum = 1;
  if (level.is_n64 || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TEMEPORTER_N64_EFFECT)) ent.s.effects = EffectsT.EF_TELEPORTER2;
  else ent.s.effects = EffectsT.EF_TELEPORTER;
  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TELEPORTER_NO_SOUND)) ent.s.sound = gi.soundindex("world/amb10.wav");
  ent.solid = SolidT.SOLID_BBOX;

  ent.mins = vec3(-32, -32, -24);
  ent.maxs = vec3(32, 32, -16);
  gi.linkentity(ent);

  // N64 has some of these for visual effects
  if (ent.target === null) return;

  const trig = G_Spawn();
  trig.touch = teleporter_touch;
  trig.solid = SolidT.SOLID_TRIGGER;
  trig.target = ent.target;
  trig.owner = ent;
  trig.s.origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  trig.mins = vec3(-8, -8, 8);
  trig.maxs = vec3(8, 8, 24);
  gi.linkentity(trig);
}

/*QUAKED misc_teleporter_dest (1 0 0) (-32 -32 -24) (32 32 -16)
Point teleporters at these. */
export function SP_misc_teleporter_dest(ent: EdictT): void {
  // Paril-KEX N64 doesn't display these
  if (level.is_n64) return;

  gi.setmodel(ent, "models/objects/dmspot/tris.md2");
  ent.s.skinnum = 0;
  ent.solid = SolidT.SOLID_BBOX;
  ent.mins = vec3(-32, -32, -24);
  ent.maxs = vec3(32, 32, -16);
  gi.linkentity(ent);
}

/*QUAKED misc_flare (1.0 1.0 0.0) (-32 -32 -32) (32 32 32) RED GREEN BLUE LOCK_ANGLE
Creates a flare seen in the N64 version. */

const SPAWNFLAG_FLARE_RED: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_FLARE_GREEN: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_FLARE_BLUE: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_FLARE_LOCK_ANGLE: SpawnFlags = SpawnFlags_from(8);

const misc_flare_use = RegisterUse("misc_flare_use", (ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  ent.svflags ^= SvflagsT.SVF_NOCLIENT;
  gi.linkentity(ent);
});

export function SP_misc_flare(ent: EdictT): void {
  ent.s.modelindex = 1;
  ent.s.renderfx = RenderfxT.RF_FLARE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.scale = st.radius;

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_FLARE_RED)) ent.s.renderfx |= RenderfxT.RF_SHELL_RED;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_FLARE_GREEN)) ent.s.renderfx |= RenderfxT.RF_SHELL_GREEN;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_FLARE_BLUE)) ent.s.renderfx |= RenderfxT.RF_SHELL_BLUE;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_FLARE_LOCK_ANGLE)) ent.s.renderfx |= RenderfxT.RF_FLARE_LOCK_ANGLE;

  if (st.image !== null && st.image !== "") {
    ent.s.renderfx |= RenderfxT.RF_CUSTOMSKIN;
    ent.s.frame = gi.imageindex(st.image);
  }

  ent.mins = vec3(-32, -32, -32);
  ent.maxs = vec3(32, 32, 32);

  ent.s.modelindex2 = st.fade_start_dist;
  ent.s.modelindex3 = st.fade_end_dist;

  if (ent.targetname !== null) ent.use = misc_flare_use;

  gi.linkentity(ent);
}

const misc_hologram_think = RegisterThink("misc_hologram_think", (ent: EdictT): void => {
  ent.s.angles[1] += 100 * gi.frame_time_s;
  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  ent.s.alpha = frandom(0.2, 0.6);
});

/*QUAKED misc_hologram (1.0 1.0 0.0) (-16 -16 0) (16 16 32)
Ship hologram seen in the N64 version. */
export function SP_misc_hologram(ent: EdictT): void {
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/strogg1/tris.md2");
  ent.mins = vec3(-16, -16, 0);
  ent.maxs = vec3(16, 16, 32);
  ent.s.effects = EffectsT.EF_HOLOGRAM;
  ent.think = misc_hologram_think;
  ent.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  ent.s.alpha = frandom(0.2, 0.6);
  ent.s.scale = 0.75;
  gi.linkentity(ent);
}

/*QUAKED misc_fireball (0 .5 .8) (-8 -8 -8) (8 8 8) NO_EXPLODE
Lava Balls. Shamelessly copied from Quake 1, like N64 guys probably did too. */

const SPAWNFLAG_LAVABALL_NO_EXPLODE: SpawnFlags = SpawnFlags_from(1);

const fire_touch = RegisterTouch("fire_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LAVABALL_NO_EXPLODE)) {
    G_FreeEdict(self);
    return;
  }

  if (other.takedamage) {
    T_Damage(other, self, self, vec3_origin, self.s.origin, vec3_origin, 20, 0, DamageflagsT.DAMAGE_NONE, {
      id: ModIdT.MOD_EXPLOSIVE,
      friendly_fire: false,
      no_point_loss: false,
    });
  }

  if ((gi.pointcontents(self.s.origin) & ContentsT.CONTENTS_LAVA) !== 0) G_FreeEdict(self);
  else BecomeExplosion1(self);
});

const fire_fly = RegisterThink("fire_fly", (self: EdictT): void => {
  const fireball = G_Spawn();
  fireball.s.effects = EF_FIREBALL;
  fireball.s.renderfx = RenderfxT.RF_MINLIGHT;
  fireball.solid = SolidT.SOLID_BBOX;
  fireball.movetype = MovetypeT.MOVETYPE_TOSS;
  fireball.clipmask = MASK_SHOT;
  fireball.velocity = vec3(crandom() * 50, crandom() * 50, self.speed * 1.75 + frandom() * 200);
  fireball.avelocity = vec3(crandom() * 360, crandom() * 360, crandom() * 360);
  fireball.classname = "fireball";
  gi.setmodel(fireball, "models/objects/gibs/sm_meat/tris.md2");
  fireball.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  fireball.nextthink = Gtime_add(level.time, Gtime_from_sec(5));
  fireball.think = G_FreeEdict;
  fireball.touch = fire_touch;
  fireball.spawnflags = self.spawnflags;
  gi.linkentity(fireball);
  self.nextthink = Gtime_add(level.time, random_time(Gtime_from_sec(5)));
});

export function SP_misc_lavaball(self: EdictT): void {
  self.classname = "fireball";
  self.nextthink = Gtime_add(level.time, random_time(Gtime_from_sec(5)));
  self.think = fire_fly;
  if (self.speed === 0) self.speed = 185;
}

export function SP_info_landmark(self: EdictT): void {
  self.absmin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  self.absmax = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
}

const SPAWNFLAG_WORLD_TEXT_START_OFF: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_WORLD_TEXT_TRIGGER_ONCE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_WORLD_TEXT_REMOVE_ON_TRIGGER: SpawnFlags = SpawnFlags_from(4);

const info_world_text_use = RegisterUse("info_world_text_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (self.activator === null) {
    self.activator = activator;
    if (self.think === null) throw new Error("info_world_text_use: self.think is null (invariant violated)");
    self.think(self);
  } else {
    self.nextthink = GTIME_ZERO;
    self.activator = null;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WORLD_TEXT_TRIGGER_ONCE)) {
    self.use = null;
  }

  if (self.target !== null) {
    const target = G_PickTarget(self.target);
    if (target !== null && target.inuse) {
      if (target.use !== null) target.use(target, self, self);
    }
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_WORLD_TEXT_REMOVE_ON_TRIGGER)) {
    G_FreeEdict(self);
  }
});

const info_world_text_think = RegisterThink("info_world_text_think", (self: EdictT): void => {
  let color: RgbaT = rgba_white;

  switch (self.sounds) {
    case 0:
      color = rgba_white;
      break;
    case 1:
      color = rgba_red;
      break;
    case 2:
      color = rgba_blue;
      break;
    case 3:
      color = rgba_green;
      break;
    case 4:
      color = rgba_yellow;
      break;
    case 5:
      color = rgba_black;
      break;
    case 6:
      color = rgba_cyan;
      break;
    case 7:
      color = rgba_orange;
      break;
    default:
      color = rgba_white;
      gi.Com_Print(`${edictFmt(self)}: invalid color\n`);
      break;
  }

  if (self.message === null) throw new Error("info_world_text_think: self.message is null (invariant violated -- SP_info_world_text requires a message)");

  if (self.s.angles[YAW] === -3.0) {
    gi.Draw_OrientedWorldText(self.s.origin, self.message, color, self.size[2], Gtime_seconds(frameTimeAsGtime()), true);
  } else {
    const textAngle = vec3(0, 0, 0);
    textAngle[YAW] = anglemod(self.s.angles[YAW]) + 180;
    if (textAngle[YAW] > 360.0) textAngle[YAW] -= 360.0;
    gi.Draw_StaticWorldText(self.s.origin, textAngle, self.message, color, self.size[2], Gtime_seconds(frameTimeAsGtime()), true);
  }
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

/*QUAKED info_world_text (1.0 1.0 0.0) (-16 -16 0) (16 16 32)
designer placed in world text for debugging. */
export function SP_info_world_text(self: EdictT): void {
  if (self.message === null) {
    gi.Com_Print(`${edictFmt(self)}: no message\n`);
    G_FreeEdict(self);
    return; // not much point without something to print...
  }

  self.think = info_world_text_think;
  self.use = info_world_text_use;
  self.size[2] = st.radius !== 0 ? st.radius : 0.2;

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_WORLD_TEXT_START_OFF)) {
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    self.activator = self;
  }
}

const misc_player_mannequin_use = RegisterUse("misc_player_mannequin_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_TARGET_ANGER;
  self.enemy = activator;

  switch (self.count) {
    case GestureType.GESTURE_FLIP_OFF:
      self.s.frame = FRAME_flip01;
      self.monsterinfo.nextframe = FRAME_flip12;
      break;

    case GestureType.GESTURE_SALUTE:
      self.s.frame = FRAME_salute01;
      self.monsterinfo.nextframe = FRAME_salute11;
      break;

    case GestureType.GESTURE_TAUNT:
      self.s.frame = FRAME_taunt01;
      self.monsterinfo.nextframe = FRAME_taunt17;
      break;

    case GestureType.GESTURE_WAVE:
      self.s.frame = FRAME_wave01;
      self.monsterinfo.nextframe = FRAME_wave11;
      break;

    case GestureType.GESTURE_POINT:
      self.s.frame = FRAME_point01;
      self.monsterinfo.nextframe = FRAME_point12;
      break;

    default:
      break;
  }
});

const misc_player_mannequin_think = RegisterThink("misc_player_mannequin_think", (self: EdictT): void => {
  if (self.teleport_time <= level.time) {
    self.s.frame++;

    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TARGET_ANGER) === 0n) {
      if (self.s.frame > FRAME_stand40) {
        self.s.frame = FRAME_stand01;
      }
    } else {
      if (self.s.frame > self.monsterinfo.nextframe) {
        self.s.frame = FRAME_stand01;
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TARGET_ANGER;
        self.enemy = null;
      }
    }

    self.teleport_time = Gtime_add(level.time, Gtime_from_hz(10));
  }

  if (self.enemy !== null) {
    const vec = vec3_sub(self.enemy.s.origin, self.s.origin);
    self.ideal_yaw = vectoyaw(vec);
    M_ChangeYaw(self);
  }

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

export function SetupMannequinModel(self: EdictT, modelType: number, weapon: string | null, skin: string | null): void {
  let modelName: string | null = null;
  let defaultSkin: string | null = null;

  switch (modelType) {
    case 1: {
      self.s.skinnum = MAX_CLIENTS - 1;
      modelName = "female";
      defaultSkin = "venus";
      break;
    }

    case 2: {
      self.s.skinnum = MAX_CLIENTS - 2;
      modelName = "male";
      defaultSkin = "rampage";
      break;
    }

    case 3: {
      self.s.skinnum = MAX_CLIENTS - 3;
      modelName = "cyborg";
      defaultSkin = "oni911";
      break;
    }

    default: {
      self.s.skinnum = MAX_CLIENTS - 1;
      modelName = "female";
      defaultSkin = "venus";
      break;
    }
  }

  if (modelName !== null) {
    self.model = `players/${modelName}/tris.md2`;

    const weaponName = weapon !== null ? `players/${modelName}/${weapon}.md2` : `players/${modelName}/w_hyperblaster.md2`;
    self.s.modelindex2 = gi.modelindex(weaponName);

    const skinName = skin !== null ? `mannequin\\${modelName}/${skin}` : `mannequin\\${modelName}/${defaultSkin}`;
    gi.configstring(CS_PLAYERSKINS + self.s.skinnum, skinName);
  }
}

/*QUAKED misc_player_mannequin (1.0 1.0 0.0) (-32 -32 -32) (32 32 32)
	Creates a player mannequin that stands around.

	NOTE: this is currently very limited, and only allows one unique model
	from each of the three player model types.

 "distance"		- Sets the type of gesture mannequin when use when triggered
 "height"		- Sets the type of model to use ( valid numbers: 1 - 3 )
 "goals"		- Name of the weapon to use.
 "image"		- Name of the player skin to use.
 "radius"		- How much to scale the model in-game */
export function SP_misc_player_mannequin(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_BBOX;
  if (!st.keys_specified.has("effects")) self.s.effects = EffectsT.EF_NONE;
  if (!st.keys_specified.has("renderfx")) self.s.renderfx = RenderfxT.RF_MINLIGHT;
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 32);
  self.yaw_speed = 30;
  self.ideal_yaw = 0;
  self.teleport_time = Gtime_add(level.time, Gtime_from_hz(10));
  self.s.modelindex = MODELINDEX_PLAYER;
  self.count = st.distance;

  SetupMannequinModel(self, st.height, st.goals, st.image);

  self.s.scale = 1.0;
  const ai_model_scale = cvarOrDefault("ai_model_scale", "0");
  if (ai_model_scale.value > 0.0) {
    self.s.scale = ai_model_scale.value;
  } else if (st.radius > 0.0) {
    self.s.scale = st.radius;
  }

  self.mins = vec3_muls(self.mins, self.s.scale);
  self.maxs = vec3_muls(self.maxs, self.s.scale);

  self.think = misc_player_mannequin_think;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  if (self.targetname !== null) {
    self.use = misc_player_mannequin_use;
  }

  gi.linkentity(self);
}

/*QUAKED misc_model (1 0 0) (-8 -8 -8) (8 8 8) */
export function SP_misc_model(ent: EdictT): void {
  if (ent.model !== null) gi.setmodel(ent, ent.model);
  gi.linkentity(ent);
}
