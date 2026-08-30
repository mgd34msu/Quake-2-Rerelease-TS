// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// The kex-line equivalent of the legacy/vanilla port's global-injection
// section of src/game/g_local.ts (`gi`/`globals`/`g_edicts`, injected via
// `SetGameImports`/`SetGameExports`/`SetGEdicts`; see that file's own
// "Game-track conventions" note, also recorded in PORTING.md: "gi, globals,
// g_edicts are bare `export let` globals ... assigned via SetGameImports/
// SetGameExports/SetGEdicts from GetGameAPI/InitGame. Call sites keep the C
// shape (gi.dprintf(...), g_edicts[i]). No holders, no null-checks;
// undefined-before-load matches the C global's lifetime.").
//
// No such holder existed anywhere in src/kexgame/ before this unit (g_utils
// is the first behavior-porting unit for this port line) -- confirmed by
// grepping src/kexgame/ for `export let gi`/`SetGameImports`/`g_main_globals`
// before writing this file. `g_local.ts`/`g_local_types.ts` are explicitly
// scoped "TYPES-ONLY PORT" and say so themselves (g_local_types.ts's own
// header: "this kex-line module has no constructor call sites of its own
// yet (a future behavior-porting unit owns those)" -- this file is that
// future unit, for exactly the pieces g_utils.ts needs.
//
// ============================================================================
// gi / globals / g_edicts -- mirrors the legacy pattern exactly
// ============================================================================
// `gi: KexGameImports` <-> C `extern game_import_t gi;` (g_local.h:1782, via
// `#include "game.h"`). `globals: KexGameExports` <-> C `extern
// game_export_t globals;` (g_local.h:1779). `g_edicts: EdictT[]` <-> C
// `extern edict_t *g_edicts;` (g_local.h:1782) -- a SEPARATE pointer from
// `globals.edicts` (which is typed `KexEdictT[]`, the short server-visible
// shape) for the same reason the legacy port keeps `g_edicts: EdictT[]`
// distinct from `GameExports.edicts: Edict[]`: game code needs the full
// local shape, the engine-facing struct only needs the short one. None of
// the three get default values: like the legacy port, "undefined-before-
// load matches the C global's lifetime" -- a caller (a test fixture today;
// a future InitGame/GetGameAPI unit eventually) must call the matching
// `SetX` before any g_utils.ts function runs.
//
// ============================================================================
// game / level -- DIFFERENT from gi/globals/g_edicts: eager singletons
// ============================================================================
// The legacy port instantiates `game`/`level` eagerly at module scope
// (`export const game: GameLocalsT = new GameLocalsT();`) rather than
// injecting them via a setter, because `GameLocalsT`/`LevelLocalsT` are
// CLASSES there with real field defaults -- `new GameLocalsT()` is already
// a valid, immediately usable, zeroed instance, unlike `GameImports`
// (function pointers with no sensible default body) or `g_edicts` (sized by
// the map, no universal default length).
//
// This port line's `GameLocalsT`/`LevelLocalsT` (g_local_types.ts) are
// plain INTERFACES, not classes (that file's own documented convention),
// but they have exactly the same property the legacy classes have: every
// field has an obvious "level just started" zero value. So the same
// eager-singleton treatment applies here too, just built via a factory
// function instead of `new`: `defaultGameLocals()`/`defaultLevelLocals()`
// below, mirroring the `makeGibDef()` factory-function precedent
// g_local_types.ts itself already established for a struct-shaped value.
//
// ============================================================================
// defaultEdict() -- why this exists, and its scope
// ============================================================================
// `EdictT` (g_local_types.ts) is a plain interface with no constructor and
// no `.clear()` method (unlike the legacy port's class-based `EdictT`,
// which has both). Two things in this unit need a concrete, fully-valued
// "blank" edict:
//   1. G_FreeEdict's `memset(ed, 0, sizeof(*ed))` (g_utils.cpp:397-404) --
//      ported here as "assign every field of a fresh `defaultEdict()` onto
//      the SAME object reference" (`Object.assign`), preserving identity
//      for any other edict still holding a direct reference to this one
//      (`chain`/`enemy`/`teammaster`/...), exactly like the real memset
//      preserves the pointer address while zeroing its contents.
//   2. Test/future-InitGame fixtures that need to preallocate `g_edicts`
//      with real, interface-satisfying objects before G_Spawn's reuse scan
//      can run over them.
// Every field is set to the same "zeroed" value C's memset would produce:
// `0`/`false`/`null` for scalars and pointers, a fresh zero `Vec3` for
// vectors (never a shared reference -- see q_vec3.ts's aliasing-hazard
// note), a fresh zero-valued nested struct for non-nullable struct fields
// (`s`, `sv`, `moveinfo`, `monsterinfo`, `fog`, `heightfog`, `bmodel_anim`,
// `lastMOD`). `GClientT` (the `client` field) is NOT defaulted to a zeroed
// struct -- it is `EdictT | null`-nullable and C's real edict_t layout
// only has an in-place `gclient_t` for the first `maxclients` slots (a
// separate allocation the engine wires up), so `null` is the correct "not a
// player slot" default, matching every real edict past the client range.
// `GitemT`/`MmoveT`/other nullable struct-typed fields are left `null` for
// the same reason: C's original pointer is genuinely null until something
// assigns it.
//
// Two fields deliberately differ from their POST-G_InitEdict value, to
// match the true PRE-init (freshly memset) state: `classname` is `null`
// here (G_InitEdict sets `"noclass"`; G_FreeEdict sets `"freed"` --  both
// AFTER the zero-fill, exactly like the real C sequence), and `gravity`/
// `gravityVector` are `0`/`(0,0,0)` here (G_InitEdict sets `1.0`/`(0,0,-1)`
// afterward). See g_utils.ts's own `G_InitEdict`/`G_FreeEdict` for where
// those post-zero assignments happen.

import { vec3, type Vec3 } from "../shared/math";
import type { KexGameExports, KexGameImports, KexEntityStateT, SvEntityT, ArmorInfoT, PathInfo } from "../kexapi/game";
import {
  KexEntityEventT,
  MAX_CLIENTS,
  MAX_EDICTS,
  MAX_ITEMS,
  Max_Armor_Types,
  MAX_SPLIT_PLAYERS,
  PathLinkType,
  PathReturnCode,
  SolidT,
  SvflagsT,
  ContentsT,
  WaterLevelT,
} from "../kexapi/game";
import {
  type EdictT,
  type GameLocalsT,
  type LevelLocalsT,
  type LevelEntryT,
  type MoveinfoT,
  type MonsterinfoT,
  type ModT,
  type BmodelAnimT,
  MovetypeT,
  MoveStateT,
  MonsterAttackStateT,
  CombatStyleT,
  BmodelAnimstyleT,
  ItemIdT,
  ModIdT,
  MAX_HEALTH_BARS,
  MAX_LEVELS_PER_UNIT,
  MAX_REINFORCEMENTS,
} from "./g_local";
import { SPAWNFLAGS_NONE } from "./spawnflags";
import { GTIME_ZERO } from "./gtime";

// ---------------------------------------------------------------------------
// gi / globals / g_edicts
// ---------------------------------------------------------------------------

export let gi: KexGameImports;
export let globals: KexGameExports;
export let g_edicts: EdictT[] = [];

export function SetGameImports(v: KexGameImports): void {
  gi = v;
}
export function SetGameExports(v: KexGameExports): void {
  globals = v;
}
export function SetGEdicts(v: EdictT[]): void {
  g_edicts = v;
}

// ---------------------------------------------------------------------------
// default-value factories (see file header)
// ---------------------------------------------------------------------------

function defaultModT(): ModT {
  return { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };
}

function defaultPathInfo(): PathInfo {
  return {
    numPathPoints: 0,
    pathDistSqr: 0,
    firstMovePoint: vec3(),
    secondMovePoint: vec3(),
    pathLinkType: PathLinkType.Walk,
    returnCode: PathReturnCode.StartPathErrors,
  };
}

function defaultBmodelAnim(): BmodelAnimT {
  return {
    start: 0,
    end: 0,
    style: BmodelAnimstyleT.BMODEL_ANIM_FORWARDS,
    speed: 0,
    nowrap: false,
    alt_start: 0,
    alt_end: 0,
    alt_style: BmodelAnimstyleT.BMODEL_ANIM_FORWARDS,
    alt_speed: 0,
    alt_nowrap: false,
    enabled: false,
    alternate: false,
    currently_alternate: false,
    next_tick: GTIME_ZERO,
  };
}

function defaultMoveinfo(): MoveinfoT {
  return {
    start_origin: vec3(),
    start_angles: vec3(),
    end_origin: vec3(),
    end_angles: vec3(),
    end_angles_reversed: vec3(),
    sound_start: 0,
    sound_middle: 0,
    sound_end: 0,
    accel: 0,
    speed: 0,
    decel: 0,
    distance: 0,
    wait: 0,
    state: MoveStateT.STATE_TOP,
    reversing: false,
    dir: vec3(),
    dest: vec3(),
    current_speed: 0,
    move_speed: 0,
    next_speed: 0,
    remaining_distance: 0,
    decel_distance: 0,
    endfunc: null,
    blocked: null,
    curve_ref: vec3(),
    curve_positions: null,
    curve_frame: 0,
    subframe: 0,
    num_subframes: 0,
    num_frames_done: 0,
  };
}

function defaultMonsterinfo(): MonsterinfoT {
  return {
    active_move: null,
    next_move: null,
    aiflags: 0n,
    nextframe: 0,
    scale: 0,

    stand: null,
    idle: null,
    search: null,
    walk: null,
    run: null,
    dodge: null,
    attack: null,
    melee: null,
    sight: null,
    checkattack: null,
    setskin: null,
    physics_change: null,

    pausetime: GTIME_ZERO,
    attack_finished: GTIME_ZERO,
    fire_wait: GTIME_ZERO,

    saved_goal: vec3(),
    search_time: GTIME_ZERO,
    trail_time: GTIME_ZERO,
    last_sighting: vec3(),
    attack_state: MonsterAttackStateT.AS_NONE,
    lefty: false,
    idle_time: GTIME_ZERO,
    linkcount: 0,

    power_armor_type: ItemIdT.IT_NULL,
    power_armor_power: 0,

    initial_power_armor_type: ItemIdT.IT_NULL,
    max_power_armor_power: 0,
    weapon_sound: 0,
    engine_sound: 0,

    blocked: null,
    last_hint_time: GTIME_ZERO,
    goal_hint: null,
    medicTries: 0,
    badMedic1: null,
    badMedic2: null,
    healer: null,
    duck: null,
    unduck: null,
    sidestep: null,
    base_height: 0,
    next_duck_time: GTIME_ZERO,
    duck_wait_time: GTIME_ZERO,
    last_player_enemy: null,
    blindfire: false,
    can_jump: false,
    had_visibility: false,
    drop_height: 0,
    jump_height: 0,
    blind_fire_delay: GTIME_ZERO,
    blind_fire_target: vec3(),
    monster_slots: 0,
    monster_used: 0,
    commander: null,
    quad_time: GTIME_ZERO,
    invincible_time: GTIME_ZERO,
    double_time: GTIME_ZERO,

    surprise_time: GTIME_ZERO,
    armor_type: ItemIdT.IT_NULL,
    armor_power: 0,
    close_sight_tripped: false,
    melee_debounce_time: GTIME_ZERO,
    strafe_check_time: GTIME_ZERO,
    base_health: 0,
    health_scaling: 0,
    next_move_time: GTIME_ZERO,
    bad_move_time: GTIME_ZERO,
    bump_time: GTIME_ZERO,
    random_change_time: GTIME_ZERO,
    path_blocked_counter: GTIME_ZERO,
    path_wait_time: GTIME_ZERO,
    nav_path: defaultPathInfo(),
    nav_path_cache_time: GTIME_ZERO,
    combat_style: CombatStyleT.COMBAT_UNKNOWN,

    damage_attacker: null,
    damage_inflictor: null,
    damage_blood: 0,
    damage_knockback: 0,
    damage_from: vec3(),
    damage_mod: defaultModT(),

    fly_max_distance: 0,
    fly_min_distance: 0,
    fly_acceleration: 0,
    fly_speed: 0,
    fly_ideal_position: vec3(),
    fly_position_time: GTIME_ZERO,
    fly_buzzard: false,
    fly_above: false,
    fly_pinned: false,
    fly_thrusters: false,
    fly_recovery_time: GTIME_ZERO,
    fly_recovery_dir: vec3(),

    checkattack_time: GTIME_ZERO,
    start_frame: 0,
    dodge_time: GTIME_ZERO,
    move_block_counter: 0,
    move_block_change_time: GTIME_ZERO,
    react_to_damage_time: GTIME_ZERO,

    reinforcements: { reinforcements: [] },
    chosen_reinforcements: new Uint8Array(MAX_REINFORCEMENTS).fill(255),

    jump_time: GTIME_ZERO,
  };
}

function defaultKexEntityState(): KexEntityStateT {
  return {
    number: 0,
    origin: vec3(),
    angles: vec3(),
    old_origin: vec3(),
    modelindex: 0,
    modelindex2: 0,
    modelindex3: 0,
    modelindex4: 0,
    frame: 0,
    skinnum: 0,
    effects: 0n,
    renderfx: 0,
    solid: 0,
    sound: 0,
    event: KexEntityEventT.EV_NONE,
    alpha: 0,
    scale: 0,
    instance_bits: 0,
    loop_volume: 0,
    loop_attenuation: 0,
    owner: 0,
    old_frame: 0,
  };
}

function defaultArmorInfo(): ArmorInfoT {
  return { item_id: 0, max_count: 0 };
}

function defaultSvEntity(): SvEntityT {
  return {
    init: false,
    ent_flags: 0n,
    buttons: 0,
    spawnflags: 0,
    item_id: 0,
    armor_type: 0,
    armor_value: 0,
    health: 0,
    max_health: 0,
    starting_health: 0,
    weapon: 0,
    team: 0,
    lobby_usernum: 0,
    respawntime: 0,
    viewheight: 0,
    last_attackertime: 0,
    waterlevel: WaterLevelT.WATER_NONE,
    viewangles: vec3(),
    viewforward: vec3(),
    velocity: vec3(),
    start_origin: vec3(),
    end_origin: vec3(),
    enemy: null,
    ground_entity: null,
    classname: null,
    targetname: null,
    netname: "",
    inventory: new Int32Array(MAX_ITEMS),
    armor_info: Array.from({ length: Max_Armor_Types }, defaultArmorInfo),
  };
}

/** See file header "defaultEdict() -- why this exists, and its scope". */
export function defaultEdict(): EdictT {
  const zeroVec = (): Vec3 => vec3();
  return {
    // KexEdictT base fields
    s: defaultKexEntityState(),
    client: null,
    sv: defaultSvEntity(),
    inuse: false,
    linked: false,
    linkcount: 0,
    areanum: 0,
    areanum2: 0,
    svflags: SvflagsT.SVF_NONE,
    mins: zeroVec(),
    maxs: zeroVec(),
    absmin: zeroVec(),
    absmax: zeroVec(),
    size: zeroVec(),
    solid: SolidT.SOLID_NOT,
    clipmask: ContentsT.CONTENTS_NONE,
    owner: null,

    // EdictT's own fields
    spawn_count: 0,
    movetype: MovetypeT.MOVETYPE_NONE,
    flags: 0n,

    model: null,
    freetime: GTIME_ZERO,

    message: null,
    classname: null,
    spawnflags: SPAWNFLAGS_NONE,

    timestamp: GTIME_ZERO,

    angle: 0,
    target: null,
    targetname: null,
    killtarget: null,
    team: null,
    pathtarget: null,
    deathtarget: null,
    healthtarget: null,
    itemtarget: null,
    combattarget: null,
    target_ent: null,

    speed: 0,
    accel: 0,
    decel: 0,
    movedir: zeroVec(),
    pos1: zeroVec(),
    pos2: zeroVec(),
    pos3: zeroVec(),

    velocity: zeroVec(),
    avelocity: zeroVec(),
    mass: 0,
    air_finished: GTIME_ZERO,
    gravity: 0,

    goalentity: null,
    movetarget: null,
    yaw_speed: 0,
    ideal_yaw: 0,

    nextthink: GTIME_ZERO,
    prethink: null,
    postthink: null,
    think: null,
    touch: null,
    use: null,
    pain: null,
    die: null,

    touch_debounce_time: GTIME_ZERO,
    pain_debounce_time: GTIME_ZERO,
    damage_debounce_time: GTIME_ZERO,
    fly_sound_debounce_time: GTIME_ZERO,
    last_move_time: GTIME_ZERO,

    health: 0,
    max_health: 0,
    gib_health: 0,
    show_hostile: GTIME_ZERO,

    powerarmor_time: GTIME_ZERO,

    map: null,

    viewheight: 0,
    deadflag: false,
    takedamage: false,
    dmg: 0,
    radius_dmg: 0,
    dmg_radius: 0,
    sounds: 0,
    count: 0,

    chain: null,
    enemy: null,
    oldenemy: null,
    activator: null,
    groundentity: null,
    groundentity_linkcount: 0,
    teamchain: null,
    teammaster: null,

    mynoise: null,
    mynoise2: null,

    noise_index: 0,
    noise_index2: 0,
    volume: 0,
    attenuation: 0,

    wait: 0,
    delay: 0,
    random: 0,

    teleport_time: GTIME_ZERO,

    watertype: ContentsT.CONTENTS_NONE,
    waterlevel: WaterLevelT.WATER_NONE,

    move_origin: zeroVec(),
    move_angles: zeroVec(),

    style: 0,

    item: null,

    moveinfo: defaultMoveinfo(),
    monsterinfo: defaultMonsterinfo(),

    plat2flags: 0,
    offset: zeroVec(),
    gravityVector: zeroVec(),
    bad_area: null,
    hint_chain: null,
    monster_hint_chain: null,
    target_hint_chain: null,
    hint_chain_id: 0,

    clock_message: "",

    dead_time: GTIME_ZERO,
    beam: null,
    beam2: null,
    proboscus: null,
    disintegrator: null,
    disintegrator_time: GTIME_ZERO,
    hackflags: 0,

    fog: {
      color: zeroVec(),
      density: 0,
      sky_factor: 0,
      color_off: zeroVec(),
      density_off: 0,
      sky_factor_off: 0,
    },

    heightfog: {
      falloff: 0,
      density: 0,
      start_color: zeroVec(),
      start_dist: 0,
      end_color: zeroVec(),
      end_dist: 0,
      falloff_off: 0,
      density_off: 0,
      start_color_off: zeroVec(),
      start_dist_off: 0,
      end_color_off: zeroVec(),
      end_dist_off: 0,
    },

    item_picked_up_by: new Array<boolean>(MAX_CLIENTS).fill(false),
    slime_debounce_time: GTIME_ZERO,

    bmodel_anim: defaultBmodelAnim(),

    lastMOD: defaultModT(),
    style_on: null,
    style_off: null,
    crosslevel_flags: 0,
  };
}

function defaultLevelEntry(): LevelEntryT {
  return {
    map_name: "",
    pretty_name: "",
    total_secrets: 0,
    found_secrets: 0,
    total_monsters: 0,
    killed_monsters: 0,
    time: GTIME_ZERO,
    visit_order: 0,
  };
}

function defaultGameLocals(): GameLocalsT {
  return {
    helpmessage1: "",
    helpmessage2: "",
    help1changed: 0,
    help2changed: 0,
    clients: [],
    spawnpoint: "",
    maxclients: 0,
    maxentities: 0,
    cross_level_flags: 0,
    cross_unit_flags: 0,
    autosaved: false,
    airacceleration_modified: 0,
    gravity_modified: 0,
    level_entries: Array.from({ length: MAX_LEVELS_PER_UNIT }, defaultLevelEntry),
    max_lag_origins: 0,
    lag_origins: null,
  };
}

function defaultLevelLocals(): LevelLocalsT {
  return {
    in_frame: false,
    time: GTIME_ZERO,

    level_name: "",
    mapname: "",
    nextmap: "",
    forcemap: "",

    intermissiontime: GTIME_ZERO,
    changemap: null,
    achievement: null,
    exitintermission: false,
    intermission_eou: false,
    intermission_clear: false,
    level_intermission_set: false,
    intermission_fade: false,
    intermission_fading: false,
    intermission_fade_time: GTIME_ZERO,
    intermission_origin: vec3(),
    intermission_angle: vec3(),
    respawn_intermission: false,

    pic_health: 0,
    pic_ping: 0,

    total_secrets: 0,
    found_secrets: 0,

    total_goals: 0,
    found_goals: 0,

    total_monsters: 0,
    monsters_registered: new Array<EdictT | null>(MAX_EDICTS).fill(null),
    killed_monsters: 0,

    current_entity: null,
    body_que: 0,

    power_cubes: 0,

    disguise_violator: null,
    disguise_violation_time: GTIME_ZERO,
    disguise_icon: 0,

    shadow_light_count: 0,
    is_n64: false,
    coop_level_restart_time: GTIME_ZERO,
    instantitems: false,

    goals: null,
    goal_num: 0,

    vwep_offset: 0,

    coop_health_scaling: 0,
    coop_scale_players: 0,

    entry: null,

    valid_poi: false,
    current_poi: vec3(),
    current_poi_image: 0,
    current_poi_stage: 0,
    current_dynamic_poi: null,
    poi_points: new Array<Vec3[] | null>(MAX_SPLIT_PLAYERS).fill(null),

    start_items: null,
    no_grapple: false,

    gravity: 0,
    hub_map: false,
    health_bar_entities: new Array<EdictT | null>(MAX_HEALTH_BARS).fill(null),
    intermission_server_frame: 0,
    deadly_kill_box: false,
    story_active: false,
    next_auto_save: GTIME_ZERO,
    next_match_report: GTIME_ZERO,
  };
}

// ---------------------------------------------------------------------------
// game / level singletons (see file header)
// ---------------------------------------------------------------------------

export const game: GameLocalsT = defaultGameLocals();
export const level: LevelLocalsT = defaultLevelLocals();
