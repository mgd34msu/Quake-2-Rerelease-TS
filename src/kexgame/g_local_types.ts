// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Struct half of g_local.h (2023 Quake II re-release / "KEX" engine),
// ~/Projects/quake2-rerelease-dll/rerelease/g_local.h (3,648 lines, C++17).
// Split out of g_local.ts per this unit's brief ("split into a second file
// ... if one file exceeds ~4k lines; keep declaration order within each").
// This file holds every struct-as-interface/class shape; g_local.ts holds
// every enum and constant and re-exports from here. See g_local.ts's file
// header for the full provenance/deviations discussion shared by both
// files; only struct-specific deviations are repeated here.
//
// TYPES-ONLY PORT: no game logic. The one exception is `MmoveT`'s
// frame-count validation (see its own comment below) -- a structural
// invariant check, not game behavior, and explicitly requested by this
// unit's brief as "mirror a validation helper" against the precedent in
// src/game/g_local.ts's `MmoveT`.
//
// ============================================================================
// COMPOSITION-BY-LAYOUT (GAME_INCLUDE) -- gclient_t / edict_t
// ============================================================================
// The C header does `#define GAME_INCLUDE` before including game.h so that
// game.h's short server-visible `gclient_t`/`edict_t` are skipped and the
// full versions in THIS file are compiled instead; both views share the same
// leading fields ("shared with server; do not touch members until the
// 'private' section" -- g_local.h's own comment on both structs). That is
// modeled here as TS interface extension: `GClientT extends KexGclientT` and
// `EdictT extends KexEdictT` (both stubs imported from ../kexapi/game.ts).
// Interface extension in TS produces a single FLAT field set at the type
// level (no nested `.shared` sub-object), which is exactly the C layout
// relationship -- "flatten, don't nest" per the brief. Fields that KexEdictT/
// KexGclientT already declare with a *narrower* type in the full struct
// (`client: GClientT | null` instead of `KexGclientT | null`; `owner`/
// `target_ent`/... : `EdictT | null` instead of `KexEdictT | null`) are
// redeclared here with the narrower type, which TS permits because the
// narrower type is still assignable to the stub's declared type (covariant
// override), matching the same relationship the legacy port's
// `EdictT`/`Edict` (src/game/g_local.ts / src/game/game.ts) already uses.
//
// ============================================================================
// INTERFACES, NOT CLASSES (except MmoveT)
// ============================================================================
// kexapi/game.ts's convention for this port line is plain interfaces with
// C++ default member initializers preserved only as comments (interfaces
// carry no values) -- see that file's header, "OTHER DEVIATIONS". This file
// follows the same convention for every struct EXCEPT `MmoveT`: unlike the
// vanilla/legacy game module (src/game/g_local.ts), which models structs as
// classes with real field defaults, this kex-line module has no constructor
// call sites of its own yet (a future behavior-porting unit owns those), so
// there is nothing for class field defaults to serve here. `MmoveT` is the
// sole exception because it carries a genuine runtime invariant (a monster's
// frame table length must equal `lastframe - firstframe + 1`) that only a
// validating setter can enforce -- see its own comment below.
//
// ============================================================================
// FUNCTION-POINTER FIELDS -> registry-typed function types
// ============================================================================
// Every field the C header wraps in a `save_*_t` template (the
// `SAVE_FUNC_*`/`SAVE_DATA_MMOVE` family, g_local.h:1330-1770) is typed here
// as `SomeFn | null` using the function-type aliases declared just below
// (`ThinkFn`, `UseFn`, `MonsterinfoDodgeFn`, ...). `../g_save_registry.ts`
// imports these SAME aliases to build one typed name<->function registry per
// alias -- see that file for the registry design. Frame-table function
// pointers (`mframe_t.aifunc`/`thinkfunc`) are NOT part of the save registry
// in the C++ source either (no `SAVE_FUNC_*` wraps them; only the whole
// `mmove_t` table is registered, via `MMOVE_T`), so they stay plain
// `Fn | null` fields with no registry involvement, matching the C source.
//
// ============================================================================
// CTF SCOPE NOTE (client_respawn_t.ctf_team / .ghost, gclient_t.menu)
// ============================================================================
// g_local.h itself `#include`s "ctf/g_ctf.h" and "ctf/p_ctf_menu.h" at
// g_local.h:2651-2652, and `client_respawn_t`/`gclient_t` (both squarely
// in this unit's scope) directly embed types from those headers
// (`ctfteam_t`, `ghost_t *`, `pmenuhnd_t *`). A full CTF port is out of
// scope for this unit, but since these fields are structurally part of the
// in-scope structs, minimal shapes are ported here too (`CtfteamT`,
// `GhostT`, `PmenuT`, `PmenuhndT`, `UpdateFuncT`, `SelectFuncT`) direct from
// ctf/g_ctf.h and ctf/p_ctf_menu.h, verbatim field-for-field. Nothing else
// from those two headers is ported.
//
// ============================================================================
// DEADFLAG (edict_t.deadflag) -- verified NOT an enum in this source
// ============================================================================
// The legacy/vanilla game module's `deadflag` is an int with four named
// values (DEAD_NO/DEAD_DYING/DEAD_DEAD/DEAD_RESPAWNABLE). Grepped the full
// rerelease/ tree for those names: zero matches anywhere. g_local.h:3127
// declares `edict_t::deadflag` as a plain `bool`, and no DEAD_* constants
// exist in this codebase at all -- ported faithfully as `boolean`, not as
// the legacy 4-value enum.
//
// ============================================================================
// MEMORY TAGS / DYNAMIC ALLOCATION
// ============================================================================
// `savable_allocated_memory_t<float, TAG_LEVEL>` (moveinfo_t.curve_positions)
// is a tag-scoped dynamic array wrapper; per PORTING.md ("Z_Malloc/Z_Free/
// Hunk_*/Z_TagMalloc -> plain allocation") and the precedent already set in
// g_local.ts's own note on TAG_GAME/TAG_LEVEL, this ports as a plain
// nullable typed array (`Float32Array | null`), dropping the tag.
// `reinforcement_list_t.reinforcements` (a raw `reinforcement_t *` + count)
// ports as a plain array for the same reason.

import type { Vec3 } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import type {
  ButtonT,
  ContentsT,
  EffectsT,
  KexEdictT,
  KexEntityStateT,
  KexGclientT,
  KexPlayerStateT,
  KexPmoveStateT,
  KexTraceT,
  KexUsercmdT,
  PathInfo,
  ShadowLightDataT,
  Vec4,
  WaterLevelT,
} from "../kexapi/game";
import type { GTime } from "./gtime";
import type { SpawnFlags } from "./spawnflags";
import type {
  AmmoT,
  AnimPriorityT,
  AutoSwitchT,
  BmodelAnimstyleT,
  CombatStyleT,
  CoopRespawnT,
  EntFlagsT,
  HandednessT,
  ItemFlagsT,
  ItemIdT,
  ModIdT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MoveStateT,
  MovetypeT,
  Plat2flagsT,
  WeaponstateT,
} from "./g_local";

// ---------------------------------------------------------------------------
// mod_t -- means-of-death wrapper (g_local.h:1081-1093)
// ---------------------------------------------------------------------------

export interface ModT {
  id: ModIdT;
  friendly_fire: boolean; // default false
  no_point_loss: boolean; // default false
}

// ---------------------------------------------------------------------------
// gitem_armor_t (g_local.h:743-753)
// ---------------------------------------------------------------------------

export interface GitemArmorT {
  base_count: number;
  max_count: number;
  normal_protection: number;
  energy_protection: number;
}

/** g_local.h: `static constexpr gitem_armor_t jacketarmor_info = { 25, 50, .30f, .00f };` */
export const jacketarmor_info: GitemArmorT = { base_count: 25, max_count: 50, normal_protection: 0.3, energy_protection: 0.0 };
/** g_local.h: `static constexpr gitem_armor_t combatarmor_info = { 50, 100, .60f, .30f };` */
export const combatarmor_info: GitemArmorT = { base_count: 50, max_count: 100, normal_protection: 0.6, energy_protection: 0.3 };
/** g_local.h: `static constexpr gitem_armor_t bodyarmor_info = { 100, 200, .80f, .60f };` */
export const bodyarmor_info: GitemArmorT = { base_count: 100, max_count: 200, normal_protection: 0.8, energy_protection: 0.6 };

// ---------------------------------------------------------------------------
// gitem_t (g_local.h:964-1009)
// ---------------------------------------------------------------------------
// Function-pointer fields (`pickup`/`use`/`drop`/`weaponthink`) are NOT part
// of the save registry in the C++ source (no SAVE_FUNC_* wraps them -- items
// are re-resolved by classname/id on load, never serialized as raw function
// pointers), so they stay plain nullable function types with no registry
// involvement.

export type GitemPickupFn = (ent: EdictT, other: EdictT) => boolean;
export type GitemUseFn = (ent: EdictT, item: GitemT) => void;
export type GitemDropFn = (ent: EdictT, item: GitemT) => void;
export type GitemWeaponthinkFn = (ent: EdictT) => void;

export interface GitemT {
  id: ItemIdT; // matches item list index
  classname: string | null; // spawning name
  pickup: GitemPickupFn | null;
  use: GitemUseFn | null;
  drop: GitemDropFn | null;
  weaponthink: GitemWeaponthinkFn | null;
  pickup_sound: string | null;
  world_model: string | null;
  world_model_flags: EffectsT;
  view_model: string | null;

  // client side info
  icon: string | null;
  use_name: string | null; // for use command, english only
  pickup_name: string | null; // for printing on pickup
  pickup_name_definite: string | null; // definite article version for languages that need it

  quantity: number; // default 0; for ammo how much, for weapons how much is used per shot
  ammo: ItemIdT; // default IT_NULL; for weapons
  chain: ItemIdT; // default IT_NULL; weapon chain root
  flags: ItemFlagsT; // default IF_NONE

  vwep_model: string | null; // default null; vwep model string (for weapons)

  armor_info: GitemArmorT | null; // default null
  tag: number; // default 0

  precaches: string | null; // default null; models/sounds/images this item will use

  sort_id: number; // default 0; used by some items to control their sorting
  quantity_warn: number; // default 5; when to warn on low ammo

  // set in InitItems, don't set by hand
  chain_next: GitemT | null; // default null; circular list of chained weapons
  // set in SP_worldspawn, don't set by hand
  vwep_index: number; // default 0; model index for vwep
  // set in SetItemNames, don't set by hand
  ammo_wheel_index: number; // default -1
  weapon_wheel_index: number; // default -1
  powerup_wheel_index: number; // default -1
}

// ---------------------------------------------------------------------------
// level_entry_t (g_local.h:1099-1114)
// ---------------------------------------------------------------------------

export interface LevelEntryT {
  map_name: string; // char[MAX_QPATH]
  pretty_name: string; // char[MAX_QPATH]
  total_secrets: number;
  found_secrets: number;
  total_monsters: number;
  killed_monsters: number;
  time: GTime; // total time spent in the level, for end screen
  visit_order: number; // the order we visited levels in
}

// ---------------------------------------------------------------------------
// game_locals_t (g_local.h:1121-1147)
// ---------------------------------------------------------------------------

export interface GameLocalsT {
  helpmessage1: string; // char[MAX_TOKEN_CHARS]
  helpmessage2: string; // char[MAX_TOKEN_CHARS]
  help1changed: number;
  help2changed: number;

  clients: GClientT[]; // [maxclients]

  spawnpoint: string; // char[MAX_TOKEN_CHARS]; needed for coop respawns

  maxclients: number; // uint32_t
  maxentities: number; // uint32_t

  cross_level_flags: number; // uint32_t
  cross_unit_flags: number; // uint32_t

  autosaved: boolean;

  // [Paril-KEX]
  airacceleration_modified: number;
  gravity_modified: number;
  level_entries: LevelEntryT[]; // length MAX_LEVELS_PER_UNIT
  max_lag_origins: number;
  lag_origins: Vec3[] | null; // maxclients * max_lag_origins
}

// ---------------------------------------------------------------------------
// shadow_light_temp_t / spawn_temp_t (g_local.h:1255-1320)
// ---------------------------------------------------------------------------

export interface ShadowLightTempT {
  data: ShadowLightDataT;
  lightstyletarget: string | null; // default null
}

// C++ `std::unordered_set<const char *> keys_specified` plus the
// `was_key_specified(key)` member. The member is a trivial, side-effect-free
// accessor (`keys_specified.find(key) != keys_specified.end()`); per this
// unit's "types, constants, registry only" scope it is NOT ported as a
// function -- call sites can inline `st.keys_specified.has(key)` directly
// once spawn-parsing logic is ported.
export interface SpawnTempT {
  // world vars
  sky: string | null;
  skyrotate: number;
  skyaxis: Vec3;
  skyautorotate: number; // default 1
  nextmap: string | null;

  lip: number;
  distance: number;
  height: number;
  noise: string | null;
  pausetime: number;
  item: string | null;
  gravity: string | null;

  minyaw: number;
  maxyaw: number;
  minpitch: number;
  maxpitch: number;

  sl: ShadowLightTempT; // [Sam-KEX]
  music: string | null; // [Edward-KEX]
  instantitems: number;
  radius: number; // [Paril-KEX]
  hub_map: boolean; // [Paril-KEX]
  achievement: string | null; // [Paril-KEX]

  goals: string | null; // [Paril-KEX]
  image: string | null; // [Paril-KEX]

  fade_start_dist: number; // default 96
  fade_end_dist: number; // default 384
  start_items: string | null;
  no_grapple: number; // default 0
  health_multiplier: number; // default 1.0

  reinforcements: string | null; // [Paril-KEX]
  noise_start: string | null; // [Paril-KEX]
  noise_middle: string | null; // [Paril-KEX]
  noise_end: string | null; // [Paril-KEX]
  loop_count: number; // [Paril-KEX]

  keys_specified: Set<string>;
}

// ---------------------------------------------------------------------------
// level_locals_t (g_local.h:1155-1253)
// ---------------------------------------------------------------------------

export interface LevelLocalsT {
  in_frame: boolean;
  time: GTime;

  level_name: string; // char[MAX_QPATH]; descriptive name (Outer Base, etc)
  mapname: string; // char[MAX_QPATH]; server name (base1, etc)
  nextmap: string; // char[MAX_QPATH]; go here when fraglimit is hit
  forcemap: string; // char[MAX_QPATH]; go here

  // intermission state
  intermissiontime: GTime; // time the intermission was started
  changemap: string | null;
  achievement: string | null;
  exitintermission: boolean;
  intermission_eou: boolean;
  intermission_clear: boolean; // [Paril-KEX] clear inventory on switch
  level_intermission_set: boolean; // [Paril-KEX] for target_camera switches; don't find intermission point
  intermission_fade: boolean; // [Paril-KEX] fade on exit instead of immediately leaving
  intermission_fading: boolean;
  intermission_fade_time: GTime;
  intermission_origin: Vec3;
  intermission_angle: Vec3;
  respawn_intermission: boolean; // only set once for respawning players

  pic_health: number;
  pic_ping: number;

  total_secrets: number;
  found_secrets: number;

  total_goals: number;
  found_goals: number;

  total_monsters: number;
  monsters_registered: (EdictT | null)[]; // length MAX_EDICTS; only for debug
  killed_monsters: number;

  current_entity: EdictT | null; // entity running from G_RunFrame
  body_que: number; // dead bodies

  power_cubes: number; // ugly necessity for coop

  // ROGUE
  disguise_violator: EdictT | null;
  disguise_violation_time: GTime;
  disguise_icon: number; // [Paril-KEX]
  // ROGUE

  shadow_light_count: number; // [Sam-KEX]
  is_n64: boolean;
  coop_level_restart_time: GTime; // restart the level after this time
  instantitems: boolean; // instantitems 1 set in worldspawn

  // N64 goal stuff
  goals: string | null; // null if no goals in world
  goal_num: number; // current relative goal number, increased with each target_goal

  // offset for the first vwep model, for skinnum encoding
  vwep_offset: number;

  // coop health scaling factor; this percentage of health is added
  // to the monster's health per player.
  coop_health_scaling: number;
  // number of players currently active in the level, compared against
  // monsters' individual scale # (not saved in the save file)
  coop_scale_players: number;

  entry: LevelEntryT | null; // [Paril-KEX] current level entry

  // [Paril-KEX] current poi
  valid_poi: boolean;
  current_poi: Vec3;
  current_poi_image: number;
  current_poi_stage: number;
  current_dynamic_poi: EdictT | null;
  poi_points: (Vec3 | null)[]; // length MAX_SPLIT_PLAYERS; temporary storage for POIs in coop

  start_items: string | null;
  no_grapple: boolean; // disable grappling hook

  gravity: number; // saved gravity
  hub_map: boolean; // level is a hub map, shouldn't be included in EOU stuff
  health_bar_entities: (EdictT | null)[]; // length MAX_HEALTH_BARS
  intermission_server_frame: number;
  deadly_kill_box: boolean;
  story_active: boolean;
  next_auto_save: GTime;
  next_match_report: GTime;
}

// ---------------------------------------------------------------------------
// moveinfo_t (g_local.h:1423-1461) -- function-type aliases first
// ---------------------------------------------------------------------------

export type MoveinfoEndfuncFn = (self: EdictT) => void;
export type MoveinfoBlockedFn = (self: EdictT, other: EdictT) => void;

export interface MoveinfoT {
  // fixed data
  start_origin: Vec3;
  start_angles: Vec3;
  end_origin: Vec3;
  end_angles: Vec3;
  end_angles_reversed: Vec3;

  sound_start: number;
  sound_middle: number;
  sound_end: number;

  accel: number;
  speed: number;
  decel: number;
  distance: number;

  wait: number;

  // state data
  state: MoveStateT;
  reversing: boolean;
  dir: Vec3;
  dest: Vec3;
  current_speed: number;
  move_speed: number;
  next_speed: number;
  remaining_distance: number;
  decel_distance: number;
  endfunc: MoveinfoEndfuncFn | null;
  blocked: MoveinfoBlockedFn | null;

  // [Paril-KEX] new accel state
  curve_ref: Vec3;
  curve_positions: Float32Array | null; // savable_allocated_memory_t<float, TAG_LEVEL>; see file header
  curve_frame: number; // size_t
  subframe: number; // uint8_t
  num_subframes: number; // uint8_t
  num_frames_done: number; // size_t
}

// ---------------------------------------------------------------------------
// mframe_t / mmove_t (g_local.h:1463-1513)
// ---------------------------------------------------------------------------
// Frame-function fields are plain (not save-registry-typed): see file header.

export type MframeAifuncFn = (self: EdictT, dist: number) => void;
export type MframeThinkfuncFn = (self: EdictT) => void;

export interface MframeT {
  aifunc: MframeAifuncFn | null; // default null
  dist: number; // default 0
  thinkfunc: MframeThinkfuncFn | null; // default null
  lerp_frame: number; // default -1
}

export type MmoveEndfuncFn = (self: EdictT) => void;

/**
 * mmove_t (g_local.h:1479-1500). Ported as a class, unlike every other
 * struct in this file (see file header "INTERFACES, NOT CLASSES"): this is
 * the one type carrying a genuine runtime invariant the C++ source itself
 * enforces at compile time via `COMPILE_TIME_MOVE_CHECK`'s constructor
 * (`if ((lastframe - firstframe + 1) != N) throw ...; "bad animation
 * frames; check your numbers!"`). TS has no array-length template
 * parameter to check this at compile time, so it is enforced at
 * construction/assignment time instead -- mirroring the identical
 * validating-setter precedent already established for the vanilla/legacy
 * port's `MmoveT` (src/game/g_local.ts:396-444), right down to the
 * `allowFrameCountMismatch` escape hatch for any C source table that itself
 * declares a longer frame array than `lastframe - firstframe + 1` (a
 * pre-existing id Software bug, not a porting error, per that file's
 * comment on `m_actor.ts`'s `actor_move_walk`).
 */
export class MmoveT {
  #firstframe = 0;
  #lastframe = 0;
  #frame: MframeT[] = [];
  endfunc: MmoveEndfuncFn | null = null;
  sidestep_scale = 0;

  allowFrameCountMismatch = false;

  get firstframe(): number {
    return this.#firstframe;
  }

  set firstframe(value: number) {
    this.#firstframe = value;
  }

  get lastframe(): number {
    return this.#lastframe;
  }

  set lastframe(value: number) {
    this.#lastframe = value;
  }

  get frame(): MframeT[] {
    return this.#frame;
  }

  set frame(value: MframeT[]) {
    const expected = this.#lastframe - this.#firstframe + 1;
    if (value.length !== expected && !this.allowFrameCountMismatch) {
      throw new Error(
        `MmoveT: firstframe=${this.#firstframe} lastframe=${this.#lastframe} expects ${expected} frames (lastframe-firstframe+1), got ${value.length}`,
      );
    }
    this.#frame = value;
  }
}

// ---------------------------------------------------------------------------
// reinforcement_t / reinforcement_list_t (g_local.h:1588-1601)
// ---------------------------------------------------------------------------

export interface ReinforcementT {
  classname: string | null;
  strength: number;
  mins: Vec3;
  maxs: Vec3;
}

export interface ReinforcementListT {
  reinforcements: ReinforcementT[]; // reinforcement_t* + num_reinforcements, flattened to a plain array
}

// ---------------------------------------------------------------------------
// monsterinfo_t (g_local.h:1605-1732) -- function-type aliases first
// ---------------------------------------------------------------------------
// Every alias below corresponds 1:1 to a `save_monsterinfo_*_t`/
// `save_data_t<...>` field in the C source and is imported by
// g_save_registry.ts to build that field's typed registry.

export type MonsterinfoStandFn = (self: EdictT) => void;
export type MonsterinfoIdleFn = (self: EdictT) => void;
export type MonsterinfoSearchFn = (self: EdictT) => void;
export type MonsterinfoWalkFn = (self: EdictT) => void;
export type MonsterinfoRunFn = (self: EdictT) => void;
export type MonsterinfoDodgeFn = (self: EdictT, attacker: EdictT, eta: GTime, tr: KexTraceT | null, gravity: boolean) => void;
export type MonsterinfoAttackFn = (self: EdictT) => void;
export type MonsterinfoMeleeFn = (self: EdictT) => void;
export type MonsterinfoSightFn = (self: EdictT, other: EdictT) => void;
export type MonsterinfoCheckattackFn = (self: EdictT) => boolean;
export type MonsterinfoSetskinFn = (self: EdictT) => void;
export type MonsterinfoBlockedFn = (self: EdictT, dist: number) => boolean;
export type MonsterinfoPhyschangedFn = (self: EdictT) => void;
export type MonsterinfoDuckFn = (self: EdictT, eta: GTime) => boolean;
export type MonsterinfoUnduckFn = (self: EdictT) => void;
export type MonsterinfoSidestepFn = (self: EdictT) => boolean;

export interface MonsterinfoT {
  // [Paril-KEX] allow some moves to be done instantaneously, but others can
  // wait the full frame. NB: always use `M_SetAnimation` (behavior, not
  // ported here) as it handles edge cases.
  active_move: MmoveT | null;
  next_move: MmoveT | null;
  aiflags: MonsterAiFlagsT; // bigint
  nextframe: number; // if next_move is set, this is ignored until a frame is ran
  scale: number;

  stand: MonsterinfoStandFn | null;
  idle: MonsterinfoIdleFn | null;
  search: MonsterinfoSearchFn | null;
  walk: MonsterinfoWalkFn | null;
  run: MonsterinfoRunFn | null;
  dodge: MonsterinfoDodgeFn | null;
  attack: MonsterinfoAttackFn | null;
  melee: MonsterinfoMeleeFn | null;
  sight: MonsterinfoSightFn | null;
  checkattack: MonsterinfoCheckattackFn | null;
  setskin: MonsterinfoSetskinFn | null;
  physics_change: MonsterinfoPhyschangedFn | null;

  pausetime: GTime;
  attack_finished: GTime;
  fire_wait: GTime;

  saved_goal: Vec3;
  search_time: GTime;
  trail_time: GTime;
  last_sighting: Vec3;
  attack_state: MonsterAttackStateT;
  lefty: boolean;
  idle_time: GTime;
  linkcount: number;

  power_armor_type: ItemIdT;
  power_armor_power: number;

  // for monster revive
  initial_power_armor_type: ItemIdT;
  max_power_armor_power: number;
  weapon_sound: number;
  engine_sound: number;

  // ROGUE
  blocked: MonsterinfoBlockedFn | null;
  last_hint_time: GTime; // last time the monster checked for hintpaths.
  goal_hint: EdictT | null; // which hint_path we're trying to get to
  medicTries: number;
  badMedic1: EdictT | null; // these medics have declared this monster "unhealable"
  badMedic2: EdictT | null;
  healer: EdictT | null; // this is who is healing this monster
  duck: MonsterinfoDuckFn | null;
  unduck: MonsterinfoUnduckFn | null;
  sidestep: MonsterinfoSidestepFn | null;
  base_height: number;
  next_duck_time: GTime;
  duck_wait_time: GTime;
  last_player_enemy: EdictT | null;
  // blindfire stuff .. the boolean says whether the monster will do it, and
  // blind_fire_time is the timing (set in the monster) of the next shot
  blindfire: boolean; // will the monster blindfire?
  can_jump: boolean; // will the monster jump?
  had_visibility: boolean; // Paril: used for blindfire
  drop_height: number;
  jump_height: number;
  blind_fire_delay: GTime;
  blind_fire_target: Vec3;
  // used by the spawners to not spawn too much and keep track of #s of
  // monsters spawned
  monster_slots: number; // nb: for spawned monsters, this is how many slots we took from our commander
  monster_used: number;
  commander: EdictT | null;
  // powerup timers, used by widow, our friend
  quad_time: GTime;
  invincible_time: GTime;
  double_time: GTime;
  // ROGUE

  // Paril
  surprise_time: GTime;
  armor_type: ItemIdT;
  armor_power: number;
  close_sight_tripped: boolean;
  melee_debounce_time: GTime; // don't melee until this time has passed
  strafe_check_time: GTime; // time until we should reconsider strafing
  base_health: number; // health that we had on spawn, before any co-op adjustments
  health_scaling: number; // number of players we've been scaled up to
  next_move_time: GTime; // high tick rate
  bad_move_time: GTime; // don't try straight moves until this is over
  bump_time: GTime; // don't slide against walls for a bit
  random_change_time: GTime; // high tickrate
  path_blocked_counter: GTime; // break out of paths when > a certain time
  path_wait_time: GTime; // don't try nav nodes until this is over
  nav_path: PathInfo; // if AI_PATHING, this is where we are trying to reach
  nav_path_cache_time: GTime; // cache nav_path result for this much time
  combat_style: CombatStyleT; // pathing style

  damage_attacker: EdictT | null;
  damage_inflictor: EdictT | null;
  damage_blood: number;
  damage_knockback: number;
  damage_from: Vec3;
  damage_mod: ModT;

  // alternate flying mechanics
  fly_max_distance: number; // how far we should try to stay
  fly_min_distance: number;
  fly_acceleration: number; // accel/decel speed
  fly_speed: number; // max speed from flying
  fly_ideal_position: Vec3; // ideally where we want to end up to hover, relative to our target if not pinned
  fly_position_time: GTime; // if <= level.time, we can try changing positions
  fly_buzzard: boolean; // orbit around all sides of their enemy, not just the sides
  fly_above: boolean;
  fly_pinned: boolean; // whether we're currently pinned to ideal position (made absolute)
  fly_thrusters: boolean; // slightly different flight mechanics, for melee attacks
  fly_recovery_time: GTime; // time to try a new dir to get away from hazards
  fly_recovery_dir: Vec3;

  checkattack_time: GTime;
  start_frame: number;
  dodge_time: GTime;
  move_block_counter: number;
  move_block_change_time: GTime;
  react_to_damage_time: GTime;

  reinforcements: ReinforcementListT;
  chosen_reinforcements: Uint8Array; // length MAX_REINFORCEMENTS; readied for spawn; 255 = none

  jump_time: GTime;
}

// ---------------------------------------------------------------------------
// height_fog_t / bmodel_anim_t / damage_indicator_t (g_local.h:2673-2810)
// ---------------------------------------------------------------------------

export interface HeightFogT {
  start: [number, number, number, number]; // r g b dist
  end: [number, number, number, number];
  falloff: number;
  density: number;
}

export interface BmodelAnimT {
  // range, inclusive
  start: number;
  end: number;
  style: BmodelAnimstyleT;
  speed: number; // in milliseconds
  nowrap: boolean;

  alt_start: number;
  alt_end: number;
  alt_style: BmodelAnimstyleT;
  alt_speed: number; // in milliseconds
  alt_nowrap: boolean;

  // game-only
  enabled: boolean;
  alternate: boolean;
  currently_alternate: boolean;
  next_tick: GTime;
}

export const MAX_DAMAGE_INDICATORS = 4;

export interface DamageIndicatorT {
  from: Vec3;
  health: number;
  armor: number;
  power: number;
}

// ---------------------------------------------------------------------------
// CTF-derived types (see file header "CTF SCOPE NOTE")
// ---------------------------------------------------------------------------

/** ctf/g_ctf.h: `enum ctfteam_t { CTF_NOTEAM, CTF_TEAM1, CTF_TEAM2 };` */
export enum CtfteamT {
  CTF_NOTEAM,
  CTF_TEAM1,
  CTF_TEAM2,
}

/** ctf/g_ctf.h: `struct ghost_t`. */
export interface GhostT {
  netname: string; // char[MAX_NETNAME]
  number: number;

  // stats
  deaths: number;
  kills: number;
  caps: number;
  basedef: number;
  carrierdef: number;

  code: number; // ghost code
  team: CtfteamT;
  score: number; // frags at time of disconnect
  ent: EdictT | null;
}

/** ctf/p_ctf_menu.h: `using UpdateFunc_t = void (*)(edict_t *ent);` */
export type UpdateFuncT = (ent: EdictT) => void;
/** ctf/p_ctf_menu.h: `using SelectFunc_t = void (*)(edict_t *ent, pmenuhnd_t *hnd);` */
export type SelectFuncT = (ent: EdictT, hnd: PmenuhndT) => void;

/** ctf/p_ctf_menu.h: `struct pmenu_t`. */
export interface PmenuT {
  text: string; // char[64]
  align: number; // PMENU_ALIGN_LEFT/CENTER/RIGHT
  SelectFunc: SelectFuncT | null;
  text_arg1: string; // char[64]
}

/** ctf/p_ctf_menu.h: `struct pmenuhnd_t`. */
export interface PmenuhndT {
  entries: PmenuT[];
  cur: number;
  num: number;
  arg: unknown; // void*
  UpdateFunc: UpdateFuncT | null;
}

// ---------------------------------------------------------------------------
// client_persistant_t / client_respawn_t (g_local.h:2724-2797)
// ---------------------------------------------------------------------------

export interface ClientPersistantT {
  userinfo: string; // char[MAX_INFO_STRING]
  social_id: string; // char[MAX_INFO_VALUE]
  netname: string; // char[MAX_NETNAME]
  hand: HandednessT;
  autoswitch: AutoSwitchT;
  autoshield: number; // see AUTO_SHIELD_*

  connected: boolean;
  spawned: boolean; // a loadgame will leave valid entities that just don't have a connection yet

  // values saved and restored from edicts when changing levels
  health: number;
  max_health: number;
  savedFlags: EntFlagsT; // bigint

  selected_item: ItemIdT;
  selected_item_time: GTime;
  inventory: Int32Array; // length IT_TOTAL

  // ammo capacities
  max_ammo: Int16Array; // length AMMO_MAX

  weapon: GitemT | null;
  lastweapon: GitemT | null;

  power_cubes: number; // used for tracking the cubes in coop games
  score: number; // for calculating total unit score in coop games

  game_help1changed: number;
  game_help2changed: number;
  helpchanged: number; // flash F1 icon if non 0, play sound and increment only if 1, 2, or 3
  help_time: GTime;

  spectator: boolean; // client wants to be a spectator
  bob_skip: boolean; // [Paril-KEX] client wants no movement bob

  // [Paril-KEX] fog that we want to achieve; density rgb skyfogfactor
  wanted_fog: [number, number, number, number, number];
  wanted_heightfog: HeightFogT;
  // relative time value, copied from last touched trigger
  fog_transition_time: GTime;
  megahealth_time: GTime; // relative megahealth time value
  lives: number; // player lives left (1 = no respawns remaining)
  n64_crouch_warn_times: number;
  n64_crouch_warning: GTime;
}

export interface ClientRespawnT {
  coop_respawn: ClientPersistantT; // what to set client->pers to on a respawn
  entertime: GTime; // level.time the client entered the game
  score: number; // frags, etc
  cmd_angles: Vec3; // angles sent over in the last command

  spectator: boolean; // client is a spectator

  // ZOID
  ctf_team: CtfteamT;
  ctf_state: number;
  ctf_lasthurtcarrier: GTime;
  ctf_lastreturnedflag: GTime;
  ctf_flagsince: GTime;
  ctf_lastfraggedcarrier: GTime;
  id_state: boolean;
  lastidtime: GTime;
  voted: boolean; // for elections
  ready: boolean;
  admin: boolean;
  ghost: GhostT | null; // for ghost codes
  // ZOID
}

// ---------------------------------------------------------------------------
// gclient_t (g_local.h:2823-3009)
// ---------------------------------------------------------------------------
// Extends the server-visible stub (see file header "COMPOSITION-BY-LAYOUT").

export interface GClientT extends KexGclientT {
  pers: ClientPersistantT;
  resp: ClientRespawnT;
  old_pmove: KexPmoveStateT; // for detecting out-of-pmove changes

  showscores: boolean; // set layout stat
  showeou: boolean; // end of unit screen
  showinventory: boolean; // set layout stat
  showhelp: boolean;

  buttons: ButtonT;
  oldbuttons: ButtonT;
  latched_buttons: ButtonT;
  cmd: KexUsercmdT; // last CMD sent

  weapon_fire_finished: GTime; // weapon cannot fire until this time is up
  weapon_think_time: GTime; // time between processing individual animation frames
  // if we latched fire between server frames but before the weapon fire
  // finish has elapsed, we'll "press" it automatically when we have a chance
  weapon_fire_buffered: boolean;
  weapon_thunk: boolean;

  newweapon: GitemT | null;

  // sum up damage over an entire frame, so shotgun blasts give a single big kick
  damage_armor: number; // damage absorbed by armor
  damage_parmor: number; // damage absorbed by power armor
  damage_blood: number; // damage taken out of health
  damage_knockback: number; // impact damage
  damage_from: Vec3; // origin for vector calculation

  damage_indicators: DamageIndicatorT[]; // length MAX_DAMAGE_INDICATORS
  num_damage_indicators: number;

  killer_yaw: number; // when dead, look at killer

  weaponstate: WeaponstateT;
  kick: { angles: Vec3; origin: Vec3; time: GTime; total: GTime };
  quake_time: GTime;
  kick_origin: Vec3;
  v_dmg_roll: number;
  v_dmg_pitch: number;
  v_dmg_time: GTime; // damage kicks
  fall_time: GTime;
  fall_value: number; // for view drop on fall
  damage_alpha: number;
  bonus_alpha: number;
  damage_blend: Vec3;
  v_angle: Vec3;
  v_forward: Vec3; // aiming direction
  bobtime: number; // so off-ground doesn't change it
  oldviewangles: Vec3;
  oldvelocity: Vec3;
  oldgroundentity: EdictT | null; // [Paril-KEX]
  flash_time: GTime; // [Paril-KEX] for high tickrate

  next_drown_time: GTime;
  old_waterlevel: WaterLevelT;
  breather_sound: number;

  machinegun_shots: number; // for weapon raising

  // animation vars
  anim_end: number;
  anim_priority: AnimPriorityT;
  anim_duck: boolean;
  anim_run: boolean;
  anim_time: GTime;

  // powerup timers
  quad_time: GTime;
  invincible_time: GTime;
  breather_time: GTime;
  enviro_time: GTime;
  invisible_time: GTime;

  grenade_blew_up: boolean;
  grenade_time: GTime;
  grenade_finished_time: GTime;
  // RAFAEL
  quadfire_time: GTime;
  // RAFAEL
  silencer_shots: number;
  weapon_sound: number;

  pickup_msg_time: GTime;

  flood_locktill: GTime; // locked from talking
  flood_when: GTime[]; // length 10; when messages were said
  flood_whenhead: number; // head pointer for when said

  respawn_time: GTime; // can respawn when time > this

  chase_target: EdictT | null; // player we are chasing
  update_chase: boolean; // need to update chase info?

  //=======
  // ROGUE
  double_time: GTime;
  ir_time: GTime;
  nuke_time: GTime;
  tracker_pain_time: GTime;

  owned_sphere: EdictT | null; // this points to the player's sphere
  // ROGUE
  //=======

  empty_click_sound: GTime;

  // ZOID
  inmenu: boolean; // in menu
  menu: PmenuhndT | null; // current menu
  menutime: GTime; // time to update menu
  menudirty: boolean;
  ctf_grapple: EdictT | null; // entity of grapple
  ctf_grapplestate: number; // true if pulling
  ctf_grapplereleasetime: GTime; // time of grapple release
  ctf_regentime: GTime; // regen tech
  ctf_techsndtime: GTime;
  ctf_lasttechmsg: GTime;
  // ZOID

  // used for player trails.
  trail_head: EdictT | null;
  trail_tail: EdictT | null;
  no_weapon_chains: boolean; // whether to use weapon chains

  // seamless level transitions
  landmark_free_fall: boolean;
  landmark_name: string | null;
  landmark_rel_pos: Vec3; // position relative to landmark, un-rotated from landmark angle
  landmark_noise_time: GTime;

  invisibility_fade_time: GTime; // [Paril-KEX] at this time, the player will be mostly fully cloaked
  chase_msg_time: GTime; // to prevent CTF message spamming
  menu_sign: number; // menu sign
  last_ladder_pos: Vec3; // for ladder step sounds
  last_ladder_sound: GTime;
  coop_respawn_state: CoopRespawnT;
  last_damage_time: GTime;

  // [Paril-KEX] these are now per-player, to work better in coop
  sight_entity: EdictT | null;
  sight_entity_time: GTime;
  sound_entity: EdictT | null;
  sound_entity_time: GTime;
  sound2_entity: EdictT | null;
  sound2_entity_time: GTime;
  // saved positions for lag compensation
  num_lag_origins: number; // 0 to MAX_LAG_ORIGINS, how many we can go back
  next_lag_origin: number; // the next one to write to
  is_lag_compensated: boolean;
  lag_restore_origin: Vec3;
  // for high tickrate weapon angles
  slow_view_angles: Vec3;
  slow_view_angle_time: GTime;

  // not saved
  help_draw_points: boolean;
  help_draw_index: number;
  help_draw_count: number;
  help_draw_time: GTime;
  step_frame: number; // uint32_t
  help_poi_image: number;
  help_poi_location: Vec3;

  // only set temporarily
  awaiting_respawn: boolean;
  respawn_timeout: GTime; // after this time, force a respawn

  // [Paril-KEX] current active fog values; density rgb skyfogfactor
  fog: [number, number, number, number, number];
  heightfog: HeightFogT;

  last_attacker_time: GTime;
  // saved - for coop; last time we were in a firing state
  last_firing_time: GTime;
}

// ---------------------------------------------------------------------------
// pierce_args_t (g_local.h:2353-2376)
// ---------------------------------------------------------------------------
// The C++ struct is polymorphic (`virtual bool hit(...)`); each concrete
// piercing algorithm subclasses it. Ported here as the shared data shape
// only, with `hit` as a plain function-type field standing in for the
// virtual dispatch (no TS inheritance hierarchy to mirror -- concrete
// piercers are behavior, out of scope for this types-only unit).

export const MAX_PIERCE = 16;

export type PierceHitFn = (mask: [ContentsT], end: Vec3) => boolean;

export interface PierceArgsT {
  pierced: (EdictT | null)[]; // length MAX_PIERCE
  pierce_solidities: number[]; // length MAX_PIERCE; SolidT values
  num_pierced: number; // default 0
  tr: KexTraceT; // the last trace that was done, when piercing stopped
  hit: PierceHitFn;
}

// ---------------------------------------------------------------------------
// select_spawn_result_t (g_local.h:2411-2415)
// ---------------------------------------------------------------------------

export interface SelectSpawnResultT {
  spot: EdictT | null;
  any_valid: boolean; // default false; set if a spawn point was found, even if it was taken
}

// ---------------------------------------------------------------------------
// dm_game_rt (g_local.h:3259-3275) -- deathmatch game-rules vtable
// ---------------------------------------------------------------------------
// A plain function-pointer struct (not save-registered -- no persistence
// concern, it's re-assigned wholesale at game-mode init). Ported as an
// interface of plain nullable function types; no registry involvement.

export interface DmGameRt {
  GameInit: (() => void) | null;
  PostInitSetup: (() => void) | null;
  ClientBegin: ((ent: EdictT) => void) | null;
  SelectSpawnPoint: ((ent: EdictT, origin: Vec3, angles: Vec3, force_spawn: boolean) => boolean) | null;
  PlayerDeath: ((targ: EdictT, inflictor: EdictT, attacker: EdictT) => void) | null;
  Score: ((attacker: EdictT, victim: EdictT, scoreChange: number, mod: ModT) => void) | null;
  PlayerEffects: ((ent: EdictT) => void) | null;
  DogTag: ((ent: EdictT, killer: EdictT, pic: [string | null]) => void) | null;
  PlayerDisconnect: ((ent: EdictT) => void) | null;
  ChangeDamage: ((targ: EdictT, attacker: EdictT, damage: number, mod: ModT) => number) | null;
  ChangeKnockback: ((targ: EdictT, attacker: EdictT, knockback: number, mod: ModT) => number) | null;
  CheckDMRules: (() => number) | null;
}

// ---------------------------------------------------------------------------
// gib_def_t (g_local.h:3439-3509)
// ---------------------------------------------------------------------------
// Seven overloaded constructors in C++, all filling the same four fields
// with different defaults (count=1, scale=1.0, type=GIB_NONE when omitted).
// Ported as a single shape plus a factory function mirroring the overload
// defaults, rather than seven TS function overloads, since every field is
// independently optional-with-a-default (no positional ambiguity the way
// the C++ overload set has).

export interface GibDefT {
  count: number;
  gibname: string | null;
  scale: number;
  type: number; // GibTypeT
}

/** g_local.h's `gib_def_t` overload set, collapsed to one options-style factory. */
export function makeGibDef(gibname: string | null, options?: { count?: number; scale?: number; type?: number }): GibDefT {
  return {
    count: options?.count ?? 1,
    gibname,
    scale: options?.scale ?? 1.0,
    type: options?.type ?? 0, // GIB_NONE
  };
}

// ---------------------------------------------------------------------------
// edict_t (g_local.h:3026-3238)
// ---------------------------------------------------------------------------
// Extends the server-visible stub (see file header "COMPOSITION-BY-LAYOUT").
// `sv: SvEntityT` and the linkage fields (`linked`/`linkcount`/`areanum`/
// `areanum2`/`svflags`/`mins`/`maxs`/`absmin`/`absmax`/`size`/`solid`/
// `clipmask`/`owner`) already come from KexEdictT; only the "private to
// game" fields below (g_local.h:3057 onward) are new here.

export interface EdictT extends KexEdictT {
  client: GClientT | null; // null if not a player
  owner: EdictT | null;

  // private to game
  spawn_count: number; // [Paril-KEX] used to differentiate different entities that may be in the same slot
  movetype: MovetypeT;
  flags: EntFlagsT; // bigint

  model: string | null;
  freetime: GTime; // sv.time when the object was freed

  // only used locally in game, not by server
  message: string | null;
  classname: string | null;
  spawnflags: SpawnFlags;

  timestamp: GTime;

  angle: number; // set in qe3, -1 = up, -2 = down
  target: string | null;
  targetname: string | null;
  killtarget: string | null;
  team: string | null;
  pathtarget: string | null;
  deathtarget: string | null;
  healthtarget: string | null; // [Paril-KEX]
  itemtarget: string | null; // [Paril-KEX]
  combattarget: string | null;
  target_ent: EdictT | null;

  speed: number;
  accel: number;
  decel: number;
  movedir: Vec3;
  pos1: Vec3;
  pos2: Vec3;
  pos3: Vec3;

  velocity: Vec3;
  avelocity: Vec3;
  mass: number;
  air_finished: GTime;
  gravity: number; // per entity gravity multiplier (1.0 is normal); use for lowgrav artifact, flares

  goalentity: EdictT | null;
  movetarget: EdictT | null;
  yaw_speed: number;
  ideal_yaw: number;

  nextthink: GTime;
  prethink: PrethinkFn | null;
  postthink: PrethinkFn | null; // save_prethink_t, same type as prethink
  think: ThinkFn | null;
  touch: TouchFn | null;
  use: UseFn | null;
  pain: PainFn | null;
  die: DieFn | null;

  touch_debounce_time: GTime; // are all these legit? do we need more/less of them?
  pain_debounce_time: GTime;
  damage_debounce_time: GTime;
  fly_sound_debounce_time: GTime; // move to clientinfo
  last_move_time: GTime;

  health: number;
  max_health: number;
  gib_health: number;
  show_hostile: GTime;

  powerarmor_time: GTime;

  map: string | null; // target_changelevel

  viewheight: number; // height above origin where eyesight is determined
  deadflag: boolean; // see file header "DEADFLAG"
  takedamage: boolean;
  dmg: number;
  radius_dmg: number;
  dmg_radius: number;
  sounds: number; // make this a spawntemp var?
  count: number;

  chain: EdictT | null;
  enemy: EdictT | null;
  oldenemy: EdictT | null;
  activator: EdictT | null;
  groundentity: EdictT | null;
  groundentity_linkcount: number;
  teamchain: EdictT | null;
  teammaster: EdictT | null;

  mynoise: EdictT | null; // can go in client only
  mynoise2: EdictT | null;

  noise_index: number;
  noise_index2: number;
  volume: number;
  attenuation: number;

  // timing variables
  wait: number;
  delay: number; // before firing targets
  random: number;

  teleport_time: GTime;

  watertype: ContentsT;
  waterlevel: WaterLevelT;

  move_origin: Vec3;
  move_angles: Vec3;

  style: number; // also used as areaportal number

  item: GitemT | null; // for bonus items

  // common data blocks
  moveinfo: MoveinfoT;
  monsterinfo: MonsterinfoT;

  //=========
  // ROGUE
  plat2flags: Plat2flagsT;
  offset: Vec3;
  gravityVector: Vec3;
  bad_area: EdictT | null;
  hint_chain: EdictT | null;
  monster_hint_chain: EdictT | null;
  target_hint_chain: EdictT | null;
  hint_chain_id: number;
  // ROGUE
  //=========

  clock_message: string; // char[CLOCK_MESSAGE_SIZE]

  // Paril: we died on this frame, apply knockback even if we're dead
  dead_time: GTime;
  // used for dabeam monsters
  beam: EdictT | null;
  beam2: EdictT | null;
  // proboscus for Parasite
  proboscus: EdictT | null;
  // for vooping things
  disintegrator: EdictT | null;
  disintegrator_time: GTime;
  hackflags: number; // n64

  // fog stuff
  fog: {
    color: Vec3;
    density: number;
    sky_factor: number;
    color_off: Vec3;
    density_off: number;
    sky_factor_off: number;
  };

  heightfog: {
    falloff: number;
    density: number;
    start_color: Vec3;
    start_dist: number;
    end_color: Vec3;
    end_dist: number;
    falloff_off: number;
    density_off: number;
    start_color_off: Vec3;
    start_dist_off: number;
    end_color_off: Vec3;
    end_dist_off: number;
  };

  // instanced coop items -- `std::bitset<MAX_CLIENTS>` ported as a plain
  // boolean array (no fixed-width bitset primitive in TS).
  item_picked_up_by: boolean[]; // length MAX_CLIENTS
  slime_debounce_time: GTime;

  // [Paril-KEX]
  bmodel_anim: BmodelAnimT;

  lastMOD: ModT;
  style_on: string | null;
  style_off: string | null;
  crosslevel_flags: number; // uint32_t
}

// ---------------------------------------------------------------------------
// non-monsterinfo save function-type aliases (g_local.h:1735-1769)
// ---------------------------------------------------------------------------
// Declared last since they reference `EdictT`/`ModT` above. Imported by
// g_save_registry.ts to build these fields' typed registries.

export type PrethinkFn = (self: EdictT) => void;
export type ThinkFn = (self: EdictT) => void;
export type TouchFn = (self: EdictT, other: EdictT, tr: KexTraceT, otherTouchingSelf: boolean) => void;
export type UseFn = (self: EdictT, other: EdictT | null, activator: EdictT | null) => void;
export type PainFn = (self: EdictT, other: EdictT, kick: number, damage: number, mod: ModT) => void;
export type DieFn = (self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3, mod: ModT) => void;

// ---------------------------------------------------------------------------
// cvar_t declarations (g_local.h:1881-1987)
// ---------------------------------------------------------------------------
// `extern cvar_t *deathmatch; extern cvar_t *coop; ...` are runtime GLOBALS
// (behavior/state), not types -- consistent with this unit's "types,
// constants, registry only" scope, they are not ported here. A future
// behavior-porting unit (this module's g_main.ts-equivalent) is responsible
// for the actual `gi.cvar(...)` registration calls, analogous to how
// src/game/g_save.ts's `InitGame()` populates the legacy `gameCvars` object.
// `CvarT` itself (the pointed-to type) is already available via
// `import type { CvarT } from "../shared/q_shared"` above for that future
// unit's use; re-exported here for convenience.
export type { CvarT };
