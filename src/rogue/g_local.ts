// g_local.h -- local definitions for game module
//
// rogue/g_local.h vs baseq2/g_local.h: rogue's diff is much larger than
// ctf's -- new AI flags for wall-walking/dodging/hint-paths, a widened
// aiflags field (unsigned, "since we're close to the max"), a `dodge`
// callback that gains a trace_t parameter, a large block of new
// monsterinfo_t fields (blocked/duck/unduck/sidestep callbacks, hint-path
// state, blindfire state, spawner slot accounting, sphere-owner powerup
// timers), new ammo/weapon/means-of-death constants for the pack's new
// weapons, and doppelganger/sphere/deathmatch-game-rules types shared with
// the sibling units that implement them (g_sphere.c, g_newdm.c, dm_tag.c,
// dm_ball.c -- outside this unit's SCOPE, which owns only the type
// declarations g_local.h carries).
//
// The C header does `#define GAME_INCLUDE` before including game.h so that
// game.h's short server-visible edict_t/gclient_t are skipped and the full
// versions below are used instead. In this port that's just "g_local.ts
// defines the full EdictT/GClientT classes; game.ts's Edict interface is
// the short, server-visible shape EdictT implements."
//
// Dropped/not re-declared here (see file for exact spots):
// - `#ifndef _WIN32 #include <nan.h> ... #endif` and the `min`/`max`/
//   `_isnan` compat macros: portable-path platform compat per PORTING.md's
//   "#ifdef WIN32/__linux__ -> take the portable path", nothing to port.
// - `#define KILL_DISRUPTOR 1`: rogue.exe ships with this branch always
//   taken (id's own comment: "id killed this weapon"), so AmmoT below has
//   no AMMO_DISRUPTOR member and ClientPersistantT has no max_rounds field
//   -- the #else branches are dead code in the shipped binary.
// - The giant "ROGUE PROTOTYPES" block (g_newweap.c/g_newai.c/g_sphere.c/
//   g_newdm.c/g_spawn.c/p_client.c function declarations) and the smaller
//   per-file prototype additions (g_utils.c's G_ProjectSource2/vectoyaw2/
//   vectoangles2/findradius2, g_combat.c's T_RadiusNukeDamage/
//   T_RadiusClassDamage/cleanupHealTarget, g_weapon.c's monster_fire_*)
//   are C forward declarations; TS modules import these functions directly
//   from the .ts file that implements them instead of re-declaring them in
//   the header module.
// - `ENT_SLOTS_LEFT`/`SELF_SLOTS_LEFT` macros: call-site expressions
//   (`ent->monsterinfo.monster_slots - ent->monsterinfo.monster_used`), not
//   struct fields -- inlined at each call site per PORTING.md's FOFS-style
//   "macro dies at the call site" convention, not exported here.
// - `extern cvar_t *needpass;`: rogue's g_local.h drops this extern
//   entirely and no rogue .c file references a "needpass" cvar (grep
//   confirms), so it is dropped from gameCvars below too -- reported
//   deviation, not an oversight.

import { vec3, type Vec3 } from "../shared/math";
import {
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  EntityStateT,
  MAX_ITEMS,
  PlayerStateT,
  PmoveStateT,
} from "../shared/q_shared";
import {
  type Edict,
  type GameExports,
  type GameImports,
  type GTraceT,
  LinkT,
  MAX_ENT_CLUSTERS,
  SolidT,
} from "./game";

// the "gameversion" client command will print this plus compile date.
// Bug-for-bug fidelity: rogue/g_local.h:14 still literally reads
// `#define GAMEVERSION "baseq2"` -- id/Xatrix never updated this constant
// when branching the mission pack, so `gamename`/g_svcmds.c's listip.cfg
// path both stay "baseq2" in the real shipped binary. Preserved as-is
// rather than "corrected" to "rogue".
export const GAMEVERSION = "baseq2";

// protocol bytes that can be directly added to messages
export const svc_muzzleflash = 1;
export const svc_muzzleflash2 = 2;
export const svc_temp_entity = 3;
export const svc_layout = 4;
export const svc_inventory = 5;
export const svc_stufftext = 11;

//==================================================================

// view pitching times
export const DAMAGE_TIME = 0.5;
export const FALL_TIME = 0.3;

// edict->spawnflags
// these are set with checkboxes on each entity in the map editor
export const SPAWNFLAG_NOT_EASY = 0x00000100;
export const SPAWNFLAG_NOT_MEDIUM = 0x00000200;
export const SPAWNFLAG_NOT_HARD = 0x00000400;
export const SPAWNFLAG_NOT_DEATHMATCH = 0x00000800;
export const SPAWNFLAG_NOT_COOP = 0x00001000;

// edict->flags
export const FL_FLY = 0x00000001;
export const FL_SWIM = 0x00000002; // implied immunity to drowining
export const FL_IMMUNE_LASER = 0x00000004;
export const FL_INWATER = 0x00000008;
export const FL_GODMODE = 0x00000010;
export const FL_NOTARGET = 0x00000020;
export const FL_IMMUNE_SLIME = 0x00000040;
export const FL_IMMUNE_LAVA = 0x00000080;
export const FL_PARTIALGROUND = 0x00000100; // not all corners are valid
export const FL_WATERJUMP = 0x00000200; // player jumping out of water
export const FL_TEAMSLAVE = 0x00000400; // not the first on the team
export const FL_NO_KNOCKBACK = 0x00000800;
export const FL_POWER_ARMOR = 0x00001000; // power armor (if any) is active
export const FL_RESPAWN = 0x80000000; // used for item respawning

// ROGUE
export const FL_MECHANICAL = 0x00002000; // entity is mechanical, use sparks not blood
export const FL_SAM_RAIMI = 0x00004000; // entity is in sam raimi cam mode
export const FL_DISGUISED = 0x00008000; // entity is in disguise, monsters will not recognize.
export const FL_NOGIB = 0x00010000; // player has been vaporized by a nuke, drop no gibs
// ROGUE

export const FRAMETIME = 0.1;

// damage flags (g_combat.c's T_Damage `dflags` parameter -- not edict->flags)
export const DAMAGE_RADIUS = 0x00000001; // damage was indirect
export const DAMAGE_NO_ARMOR = 0x00000002; // armour does not protect from this damage
export const DAMAGE_ENERGY = 0x00000004; // damage is from an energy based weapon
export const DAMAGE_NO_KNOCKBACK = 0x00000008; // do not affect velocity, just view angles
export const DAMAGE_BULLET = 0x00000010; // damage is from a bullet (used for ricochets)
export const DAMAGE_NO_PROTECTION = 0x00000020; // armor, shields, invulnerability, and godmode have no effect
// ROGUE
export const DAMAGE_DESTROY_ARMOR = 0x00000040; // damage is done to armor and health.
export const DAMAGE_NO_REG_ARMOR = 0x00000080; // damage skips regular armor
export const DAMAGE_NO_POWER_ARMOR = 0x00000100; // damage skips power armor
// ROGUE

// Memory tags (TAG_GAME / TAG_LEVEL) are DROPPED per PORTING.md: "Z_Malloc/
// Z_Free/Hunk_*/Z_TagMalloc -> plain allocation; tag-freeing loops become
// explicit list clears." There is no tag-scoped allocator on this side of
// the port, so nothing carries tag semantics; when g_save.c is ported,
// "clear on level load" becomes an explicit reset of the owning collection.

export const MELEE_DISTANCE = 80;

export const BODY_QUEUE_SIZE = 8;

export enum DamageT {
  DAMAGE_NO,
  DAMAGE_YES, // will take damage if hit
  DAMAGE_AIM, // auto targeting recognizes this
}

export enum WeaponstateT {
  WEAPON_READY,
  WEAPON_ACTIVATING,
  WEAPON_DROPPING,
  WEAPON_FIRING,
}

// rogue/g_local.h: KILL_DISRUPTOR is unconditionally defined, so the
// AMMO_PROX/AMMO_DISRUPTOR #ifdef takes the AMMO_PROX-only branch -- there
// is no AMMO_DISRUPTOR member in the shipped binary.
export enum AmmoT {
  AMMO_BULLETS,
  AMMO_SHELLS,
  AMMO_ROCKETS,
  AMMO_GRENADES,
  AMMO_CELLS,
  AMMO_SLUGS,
  // ROGUE
  AMMO_FLECHETTES,
  AMMO_TESLA,
  AMMO_PROX,
  // ROGUE
}

// deadflag
export const DEAD_NO = 0;
export const DEAD_DYING = 1;
export const DEAD_DEAD = 2;
export const DEAD_RESPAWNABLE = 3;

// range
export const RANGE_MELEE = 0;
export const RANGE_NEAR = 1;
export const RANGE_MID = 2;
export const RANGE_FAR = 3;

// gib types
export const GIB_ORGANIC = 0;
export const GIB_METALLIC = 1;

// monster ai flags
export const AI_STAND_GROUND = 0x00000001;
export const AI_TEMP_STAND_GROUND = 0x00000002;
export const AI_SOUND_TARGET = 0x00000004;
export const AI_LOST_SIGHT = 0x00000008;
export const AI_PURSUIT_LAST_SEEN = 0x00000010;
export const AI_PURSUE_NEXT = 0x00000020;
export const AI_PURSUE_TEMP = 0x00000040;
export const AI_HOLD_FRAME = 0x00000080;
export const AI_GOOD_GUY = 0x00000100;
export const AI_BRUTAL = 0x00000200;
export const AI_NOSTEP = 0x00000400;
export const AI_DUCKED = 0x00000800;
export const AI_COMBAT_POINT = 0x00001000;
export const AI_MEDIC = 0x00002000;
export const AI_RESURRECTING = 0x00004000;

// ROGUE
export const AI_WALK_WALLS = 0x00008000;
export const AI_MANUAL_STEERING = 0x00010000;
export const AI_TARGET_ANGER = 0x00020000;
export const AI_DODGING = 0x00040000;
export const AI_CHARGING = 0x00080000;
export const AI_HINT_PATH = 0x00100000;
export const AI_IGNORE_SHOTS = 0x00200000;
// PMM - FIXME - last second added for E3 .. there's probably a better way to do this, but
// this works
export const AI_DO_NOT_COUNT = 0x00400000; // set for healed monsters
export const AI_SPAWNED_CARRIER = 0x00800000; // both do_not_count and spawned are set for spawned monsters
export const AI_SPAWNED_MEDIC_C = 0x01000000; // both do_not_count and spawned are set for spawned monsters
export const AI_SPAWNED_WIDOW = 0x02000000; // both do_not_count and spawned are set for spawned monsters
export const AI_SPAWNED_MASK = 0x03800000; // mask to catch all three flavors of spawned
export const AI_BLOCKED = 0x04000000; // used by blocked_checkattack: set to say I'm attacking while blocked
// (prevents run-attacks)
// ROGUE

// monster attack state
export const AS_STRAIGHT = 1;
export const AS_SLIDING = 2;
export const AS_MELEE = 3;
export const AS_MISSILE = 4;
export const AS_BLIND = 5; // PMM - used by boss code to do nasty things even if it can't see you

// armor types
export const ARMOR_NONE = 0;
export const ARMOR_JACKET = 1;
export const ARMOR_COMBAT = 2;
export const ARMOR_BODY = 3;
export const ARMOR_SHARD = 4;

// power armor types
export const POWER_ARMOR_NONE = 0;
export const POWER_ARMOR_SCREEN = 1;
export const POWER_ARMOR_SHIELD = 2;

// handedness values
export const RIGHT_HANDED = 0;
export const LEFT_HANDED = 1;
export const CENTER_HANDED = 2;

// game.serverflags values
export const SFL_CROSS_TRIGGER_1 = 0x00000001;
export const SFL_CROSS_TRIGGER_2 = 0x00000002;
export const SFL_CROSS_TRIGGER_3 = 0x00000004;
export const SFL_CROSS_TRIGGER_4 = 0x00000008;
export const SFL_CROSS_TRIGGER_5 = 0x00000010;
export const SFL_CROSS_TRIGGER_6 = 0x00000020;
export const SFL_CROSS_TRIGGER_7 = 0x00000040;
export const SFL_CROSS_TRIGGER_8 = 0x00000080;
export const SFL_CROSS_TRIGGER_MASK = 0x000000ff;

// noise types for PlayerNoise
export const PNOISE_SELF = 0;
export const PNOISE_WEAPON = 1;
export const PNOISE_IMPACT = 2;

// edict->movetype values
export enum MovetypeT {
  MOVETYPE_NONE, // never moves
  MOVETYPE_NOCLIP, // origin and angles change with no interaction
  MOVETYPE_PUSH, // no clip to world, push on box contact
  MOVETYPE_STOP, // no clip to world, stops on box contact

  MOVETYPE_WALK, // gravity
  MOVETYPE_STEP, // gravity, special edge handling
  MOVETYPE_FLY,
  MOVETYPE_TOSS, // gravity
  MOVETYPE_FLYMISSILE, // extra size to monsters
  MOVETYPE_BOUNCE,
  MOVETYPE_NEWTOSS, // PGM - for deathball
}

export class GitemArmorT {
  base_count = 0;
  max_count = 0;
  normal_protection = 0;
  energy_protection = 0;
  armor = 0;
}

// gitem_t->flags
export const IT_WEAPON = 0x00000001; // use makes active weapon
export const IT_AMMO = 0x00000002;
export const IT_ARMOR = 0x00000004;
export const IT_STAY_COOP = 0x00000008;
export const IT_KEY = 0x00000010;
export const IT_POWERUP = 0x00000020;

// ROGUE
export const IT_MELEE = 0x00000040;
export const IT_NOT_GIVEABLE = 0x00000080; // item can not be given
// ROGUE

// ctf/g_local.h: `#define IT_TECH 64` (gitem_t->flags).
// RENUMBERED 0x40 -> 0x100 for this module, exactly as our sibling
// src/game/g_local.ts renumbers it: rogue's IT_MELEE already claims 0x40 (and
// IT_NOT_GIVEABLE 0x80) in the same gitem_t->flags word. gitem_t.flags is a
// compile-time property of the static itemlist[] -- not parsed from map files,
// not sent over the wire -- so the bit choice is free.
export const IT_TECH = 0x00000100;

// gitem_t->weapmodel for weapons indicates model index
export const WEAP_BLASTER = 1;
export const WEAP_SHOTGUN = 2;
export const WEAP_SUPERSHOTGUN = 3;
export const WEAP_MACHINEGUN = 4;
export const WEAP_CHAINGUN = 5;
export const WEAP_GRENADES = 6;
export const WEAP_GRENADELAUNCHER = 7;
export const WEAP_ROCKETLAUNCHER = 8;
export const WEAP_HYPERBLASTER = 9;
export const WEAP_RAILGUN = 10;
export const WEAP_BFG = 11;
// PGM
export const WEAP_DISRUPTOR = 12;
export const WEAP_ETFRIFLE = 13;
export const WEAP_PLASMA = 14;
export const WEAP_PROXLAUNCH = 15;
export const WEAP_CHAINFIST = 16;

export class GItemT {
  classname: string | null = null; // spawning name
  pickup: ((ent: EdictT, other: EdictT) => boolean) | null = null;
  use: ((ent: EdictT, item: GItemT) => void) | null = null;
  drop: ((ent: EdictT, item: GItemT) => void) | null = null;
  weaponthink: ((ent: EdictT) => void) | null = null;
  pickup_sound: string | null = null;
  world_model: string | null = null;
  world_model_flags = 0;
  view_model: string | null = null;

  // client side info
  icon: string | null = null;
  pickup_name: string | null = null; // for printing on pickup
  count_width = 0; // number of digits to display by icon

  quantity = 0; // for ammo how much, for weapons how much is used per shot
  ammo: string | null = null; // for weapons
  flags = 0; // IT_* flags

  weapmodel = 0; // weapon model index (for weapons)

  // `void *info` is never used by baseq2; kept as `unknown` (never `any`)
  // rather than dropped, since g_local.h declares it.
  info: unknown = null;
  tag = 0;

  precaches: string | null = null; // string of all models, sounds, and images this item will use
}

//
// this structure is left intact through an entire game
// it should be initialized at dll load time, and read/written to
// the server.ssv file for savegames
//
export class GameLocalsT {
  helpmessage1 = ""; // char[512]
  helpmessage2 = ""; // char[512]
  helpchanged = 0; // flash F1 icon if non 0, play sound
  // and increment only if 1, 2, or 3

  clients: GClientT[] = []; // [maxclients]

  // can't store spawnpoint in level, because
  // it would get overwritten by the savegame restore
  spawnpoint = ""; // char[512] -- needed for coop respawns

  // store latched cvars here that we want to get at often
  maxclients = 0;
  maxentities = 0;

  // cross level triggers
  serverflags = 0;

  // RE-RELEASE CONTENT PORT: game_locals_t::cross_unit_flags from
  // src/kexgame/. Distinct from `serverflags` above, which is the classic
  // CROSS_LEVEL flag word: cross_unit_flags is the re-release's separate
  // CROSS_UNIT word, set by target_crossunit_trigger and tested by
  // target_crossunit_target. It lives on GameLocalsT rather than
  // LevelLocalsT precisely because it must survive a level change -- that
  // cross-unit lifetime is the entity pair's whole purpose -- and it is
  // serialized alongside serverflags in g_save.ts so it also survives a
  // save/load.
  cross_unit_flags = 0;

  // items
  num_items = 0;

  autosaved = false;

  clear(): void {
    Object.assign(this, new GameLocalsT());
  }
}

//
// this structure is cleared as each map is entered
// it is read/written to the level.sav file for savegames
//
export class LevelLocalsT {
  framenum = 0;
  time = 0;

  level_name = ""; // char[MAX_QPATH] -- the descriptive name (Outer Base, etc)
  mapname = ""; // char[MAX_QPATH] -- the server name (base1, etc)
  nextmap = ""; // char[MAX_QPATH] -- go here when fraglimit is hit

  // intermission state
  intermissiontime = 0; // time the intermission was started
  changemap: string | null = null;
  exitintermission = 0;
  intermission_origin: Vec3 = vec3();
  intermission_angle: Vec3 = vec3();

  sight_client: EdictT | null = null; // changed once each frame for coop games

  sight_entity: EdictT | null = null;
  sight_entity_framenum = 0;
  sound_entity: EdictT | null = null;
  sound_entity_framenum = 0;
  sound2_entity: EdictT | null = null;
  sound2_entity_framenum = 0;

  pic_health = 0;

  total_secrets = 0;
  found_secrets = 0;

  total_goals = 0;
  found_goals = 0;

  total_monsters = 0;
  killed_monsters = 0;

  current_entity: EdictT | null = null; // entity running from G_RunFrame
  body_que = 0; // dead bodies

  power_cubes = 0; // ugly necessity for coop

  // ROGUE
  disguise_violator: EdictT | null = null;
  disguise_violation_framenum = 0;
  // ROGUE

  clear(): void {
    Object.assign(this, new LevelLocalsT());
  }
}

// spawn_temp_t is only used to hold entity field values that
// can be set from the editor, but aren't actualy present
// in edict_t during gameplay
// =========================================================================
// RE-RELEASE CONTENT PORT -- the three sub-structs the 2023 re-release
// entity set hangs off an edict. Ported into this module from our own
// sibling src/game/g_local.ts (which itself translated them from
// src/kexgame/g_local_types.ts), the same way commit 288484f ported Ground
// Zero's own additions the other direction. There is no cross-module import
// anywhere in this tree -- every module owns its own EdictT -- so "shared"
// here means "transcribed", not "referenced".
//
// Ground Zero's shipped maps need these: rmine2/rlava2 place trigger_fog
// (and rlava2's `fog_values` info_notnull holds the height-fog payload it
// reads), and rware1/rhangar2/rsewer2 place func_animation.
//
// PROTOCOL NOTE (the degradations are real and deliberate): the fog and
// heightfog blocks are parsed and updated server-side exactly as the
// re-release updates them -- trigger_fog fires, targets, and holds correct
// state -- but the re-release ships fog to the client through a KEX-only
// per-client fog message that protocol 34 does not have, so the view is
// unfogged. Nothing is dropped. BmodelAnimT by contrast DOES present under
// protocol 34: it drives `s.frame` on a brush model, and s.frame is in the
// baseline entity state every protocol carries.
// =========================================================================
export class FogT {
  color: Vec3 = vec3();
  density = 0;
  sky_factor = 0;
  color_off: Vec3 = vec3();
  density_off = 0;
  sky_factor_off = 0;
}

export class HeightFogT {
  falloff = 0;
  density = 0;
  start_color: Vec3 = vec3();
  start_dist = 0;
  end_color: Vec3 = vec3();
  end_dist = 0;
  falloff_off = 0;
  density_off = 0;
  start_color_off: Vec3 = vec3();
  start_dist_off = 0;
  end_color_off: Vec3 = vec3();
  end_dist_off = 0;
}

export class BmodelAnimT {
  // range, inclusive
  start = 0;
  end = 0;
  style = 0;
  speed = 0; // in milliseconds
  nowrap = false;

  alt_start = 0;
  alt_end = 0;
  alt_style = 0;
  alt_speed = 0; // in milliseconds
  alt_nowrap = false;

  // game-only
  enabled = false;
  alternate = false;
  currently_alternate = false;
  // gtime_t in the re-release; this module keeps level.time in plain
  // seconds, so this is a seconds float on the same clock.
  next_tick = 0;
}

export class SpawnTempT {
  // world vars
  sky: string | null = null;
  skyrotate = 0;
  skyaxis: Vec3 = vec3();
  nextmap: string | null = null;

  lip = 0;
  distance = 0;
  height = 0;
  noise: string | null = null;
  pausetime = 0;
  item: string | null = null;
  gravity: string | null = null;

  minyaw = 0;
  maxyaw = 0;
  minpitch = 0;
  maxpitch = 0;

  // =====================================================================
  // RE-RELEASE CONTENT PORT -- spawn_temp_t keys Ground Zero's own shipped
  // maps carry once loaded from the 2023 re-release data.
  //
  // These are parse-time-only scratch keys: ED_ParseField writes them into
  // the single shared `st` and the spawn function reads them before `st` is
  // cleared for the next entity, so adding them costs nothing at runtime
  // and changes no Ground Zero behavior (no 1998-era rogue entity names any
  // of these keys).
  //
  // Without them every one is logged as "<key> is not a field" and -- worse
  // -- the entity that needed the value silently spawns wrong. Verified
  // against the entity lump of every shipped rogue .bsp: rmine1/rware1/
  // rware2's dynamic_light entities carry all eight shadowlight* keys.
  //
  // `image` is read by SP_target_poi (g_kextarg.ts) for its compass icon.
  // No shipped rogue map sets it -- every rogue target_poi takes the
  // "friend" default -- but the key is parsed so a map that does set it is
  // not silently dropped.
  // =====================================================================
  image: string | null = null;
  // g_local.h:1274 declares `int32_t skyautorotate = 1;` (default 1, not 0).
  // A worldspawn that never explicitly sets skyautorotate (the overwhelmingly
  // common case) must default to "spin continuously", matching the re-release
  // game DLL; see SP_worldspawn's CS_SKYROTATE write in g_spawn.ts.
  skyautorotate = 1;
  // target_camera / target_healthbar / misc_flare / SP_target_poi radius, and
  // the re-release's achievement + POI goal keys.
  radius = 0;
  achievement: string | null = null;
  goals: string | null = null;
  // misc_flare's distance fade, and NOT 0: the re-release declares these with
  // real defaults (src/kexgame/g_local_types.ts:319-320, itself g_local.h's
  // `int32_t fade_start_dist = 96; int32_t fade_end_dist = 384;`), and every
  // shipped misc_flare relies on them -- none of the flares in mgu2m3 spells
  // either key. They ride the wire in s.modelindex2/s.modelindex3 and the
  // client's RF_FLARE branch (cl_ents.ts) computes the flare's alpha from
  // them: with both at 0 the ramp collapses to "always fully opaque", so the
  // flare that should fade in with distance is drawn at full strength from
  // any range. No effect on any 1998-era entity -- these are re-release-only
  // spawn keys read only by SP_misc_flare.
  fade_start_dist = 96;
  fade_end_dist = 384;
  // Default 1.0, NOT 0 -- kexgame/g_spawn.ts:707 (`health_multiplier: 1.0`,
  // itself g_local.h:1306's `float health_multiplier = 1.0f`). Every ported
  // re-release monster sets its health as
  // `Math.trunc(<base> * st.health_multiplier)`, so a 0 default would give
  // every one of them 0 health on any map that does not explicitly write the
  // key -- i.e. almost all of them. SpawnTempT.clear() restores this default
  // per entity via `new SpawnTempT()`, matching the C's memset-then-initialize
  // of the aggregate.
  health_multiplier = 1.0;
  // Shadow-light keys. This module's renderer path has no shadow-light pass
  // and protocol 34 has no message that could carry one, so these are
  // parsed and stored (so the entity spawns complete and a future renderer
  // can read them) but have no visual effect -- see SP_dynamic_light's
  // degradation note in g_kexmisc.ts.
  shadowlightradius = 0;
  shadowlightresolution = 0;
  shadowlightintensity = 0;
  shadowlightstartfadedistance = 0;
  shadowlightendfadedistance = 0;
  shadowlightstyle = 0;
  shadowlightconeangle = 0;
  shadowlightstyletarget: string | null = null;

  clear(): void {
    Object.assign(this, new SpawnTempT());
  }
}

export class MoveinfoT {
  // fixed data
  start_origin: Vec3 = vec3();
  start_angles: Vec3 = vec3();
  end_origin: Vec3 = vec3();
  end_angles: Vec3 = vec3();

  sound_start = 0;
  sound_middle = 0;
  sound_end = 0;

  accel = 0;
  speed = 0;
  decel = 0;
  distance = 0;

  wait = 0;

  // state data
  state = 0;
  dir: Vec3 = vec3();
  current_speed = 0;
  move_speed = 0;
  next_speed = 0;
  remaining_distance = 0;
  decel_distance = 0;
  endfunc: ((self: EdictT) => void) | null = null;
}

export class MframeT {
  aifunc: ((self: EdictT, dist: number) => void) | null = null;
  dist = 0;
  thinkfunc: ((self: EdictT) => void) | null = null;
}

export class MmoveT {
  #firstframe = 0;
  #lastframe = 0;
  #frame: MframeT[] = [];
  endfunc: ((self: EdictT) => void) | null = null;

  // Escape hatch for the rare table where the original C source itself
  // declares a frame array longer than lastframe-firstframe+1 (id Software
  // bug, not a porting error). Must be set to true before assigning `frame`
  // and requires a comment at the call site citing the C evidence -- see
  // src/game/m_actor.ts's actor_move_walk for the one known instance.
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

  // Every construction site in the codebase (the per-monster-file mkmove()/
  // mmove() helpers, and the inline `const x = new MmoveT(); x.firstframe =
  // ...; x.lastframe = ...; x.frame = ...; x.endfunc = ...;` pattern used by
  // a few monster files) assigns frame after firstframe/lastframe are
  // already final, so validating here catches a bad table at module load
  // (boot) instead of the first time that monster's frame table runs.
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

export class MonsterInfoT {
  currentmove: MmoveT | null = null;
  // rogue/g_local.h: "unsigned int aiflags; // PGM - unsigned, since we're
  // close to the max" -- JS numbers have no signed/unsigned distinction;
  // the AI_* bit constants above stay within the safe-integer bitwise range,
  // so this stays a plain `number`.
  aiflags = 0;
  nextframe = 0;
  scale = 0;

  stand: ((self: EdictT) => void) | null = null;
  idle: ((self: EdictT) => void) | null = null;
  search: ((self: EdictT) => void) | null = null;
  walk: ((self: EdictT) => void) | null = null;
  run: ((self: EdictT) => void) | null = null;
  // rogue/g_local.h widens dodge to take the trace_t from the shot that
  // triggered it (M_MonsterDodge in g_newai.c -- RG-systems' SCOPE -- passes
  // it through); GTraceT is the game-facing trace shape from game.ts.
  dodge: ((self: EdictT, other: EdictT, eta: number, tr: GTraceT) => void) | null = null;
  attack: ((self: EdictT) => void) | null = null;
  melee: ((self: EdictT) => void) | null = null;
  sight: ((self: EdictT, other: EdictT) => void) | null = null;
  checkattack: ((self: EdictT) => boolean) | null = null;

  pausetime = 0;
  attack_finished = 0;

  saved_goal: Vec3 = vec3();
  search_time = 0;
  trail_time = 0;
  last_sighting: Vec3 = vec3();
  attack_state = 0;
  lefty = 0;
  idle_time = 0;
  linkcount = 0;

  power_armor_type = 0;
  power_armor_power = 0;

  // ROGUE
  blocked: ((self: EdictT, dist: number) => boolean) | null = null;
  // C: `edict_t *last_hint;` is commented out in the struct itself ("last
  // hint_path the monster touched") -- not ported, matches the C's own
  // dead field.
  last_hint_time = 0; // last time the monster checked for hintpaths.
  goal_hint: EdictT | null = null; // which hint_path we're trying to get to
  medicTries = 0;
  badMedic1: EdictT | null = null; // these medics have declared this monster "unhealable"
  badMedic2: EdictT | null = null;
  healer: EdictT | null = null; // this is who is healing this monster
  duck: ((self: EdictT, eta: number) => void) | null = null;
  unduck: ((self: EdictT) => void) | null = null;
  sidestep: ((self: EdictT) => void) | null = null;
  // while abort_duck would be nice, only monsters which duck but don't
  // sidestep would use it .. only the brain, not really worth it. sidestep
  // is an implied abort_duck (C: `abort_duck` field itself is commented out)
  base_height = 0;
  next_duck_time = 0;
  duck_wait_time = 0;
  last_player_enemy: EdictT | null = null;
  // blindfire stuff .. the boolean says whether the monster will do it, and
  // blind_fire_time is the timing (set in the monster) of the next shot
  blindfire = false; // will the monster blindfire?
  blind_fire_delay = 0;
  blind_fire_target: Vec3 = vec3();
  // used by the spawners to not spawn too much and keep track of #s of
  // monsters spawned
  monster_slots = 0;
  monster_used = 0;
  commander: EdictT | null = null;
  // powerup timers, used by widow, our friend
  quad_framenum = 0;
  invincible_framenum = 0;
  double_framenum = 0;
  // ROGUE
}

// ROGUE
// this determines how long to wait after a duck to duck again.  this needs
// to be longer than the time after the monster_duck_up in all of the
// animation sequences
export const DUCK_INTERVAL = 0.5;
// ROGUE

// means of death
export const MOD_UNKNOWN = 0;
export const MOD_BLASTER = 1;
export const MOD_SHOTGUN = 2;
export const MOD_SSHOTGUN = 3;
export const MOD_MACHINEGUN = 4;
export const MOD_CHAINGUN = 5;
export const MOD_GRENADE = 6;
export const MOD_G_SPLASH = 7;
export const MOD_ROCKET = 8;
export const MOD_R_SPLASH = 9;
export const MOD_HYPERBLASTER = 10;
export const MOD_RAILGUN = 11;
export const MOD_BFG_LASER = 12;
export const MOD_BFG_BLAST = 13;
export const MOD_BFG_EFFECT = 14;
export const MOD_HANDGRENADE = 15;
export const MOD_HG_SPLASH = 16;
export const MOD_WATER = 17;
export const MOD_SLIME = 18;
export const MOD_LAVA = 19;
export const MOD_CRUSH = 20;
export const MOD_TELEFRAG = 21;
export const MOD_FALLING = 22;
export const MOD_SUICIDE = 23;
export const MOD_HELD_GRENADE = 24;
export const MOD_EXPLOSIVE = 25;
export const MOD_BARREL = 26;
export const MOD_BOMB = 27;
export const MOD_EXIT = 28;
export const MOD_SPLASH = 29;
export const MOD_TARGET_LASER = 30;
export const MOD_TRIGGER_HURT = 31;
export const MOD_HIT = 32;
export const MOD_TARGET_BLASTER = 33;

// RE-RELEASE CONTENT PORT -- means-of-death values the re-release entity and
// monster set this module now hosts needs, taken with the SAME numbers our
// sibling src/game/g_local.ts uses (xatrix/g_local.h's `// RAFAEL 14-APR-98`
// block). 34-39 were the range xatrix claimed and rogue's own additions start
// at 40, so these slot in without renumbering anything Ground Zero owns.
// MOD_RIPPER is the gunner commander's ionripper, MOD_PHALANX the beta
// gladiator's plasma, MOD_BLASTOFF the fixbot's blastoff, MOD_GEKK the gekk's
// bite/claw and MOD_TRAP the trap. MOD_* values are internal to the game
// module (they pick an obituary string in ClientObituary) -- never written to
// the wire, never stored in a .bsp.
export const MOD_RIPPER = 34;
export const MOD_PHALANX = 35;
export const MOD_BLASTOFF = 37;
export const MOD_GEKK = 38;
export const MOD_TRAP = 39;
// ROGUE
export const MOD_CHAINFIST = 40;
export const MOD_DISINTEGRATOR = 41;
export const MOD_ETF_RIFLE = 42;
export const MOD_BLASTER2 = 43;
export const MOD_HEATBEAM = 44;
export const MOD_TESLA = 45;
export const MOD_PROX = 46;
export const MOD_NUKE = 47;
export const MOD_VENGEANCE_SPHERE = 48;
export const MOD_HUNTER_SPHERE = 49;
export const MOD_DEFENDER_SPHERE = 50;
export const MOD_TRACKER = 51;
export const MOD_DBALL_CRUSH = 52;
export const MOD_DOPPLE_EXPLODE = 53;
export const MOD_DOPPLE_VENGEANCE = 54;
export const MOD_DOPPLE_HUNTER = 55;
// ROGUE
export const MOD_FRIENDLY_FIRE = 0x8000000;

// `extern int meansOfDeath;` -- a reassigned scalar global, not an object
// field; per PORTING.md ("C globals that are reassigned pointers... become
// fields on their owning singleton or a small exported holder object") it
// gets a one-field holder rather than a bare exported `let`.
export const meansOfDeathHolder: { meansOfDeath: number } = { meansOfDeath: MOD_UNKNOWN };

// item spawnflags
export const ITEM_TRIGGER_SPAWN = 0x00000001;
export const ITEM_NO_TOUCH = 0x00000002;
// 6 bits reserved for editor flags
// 8 bits used as power cube id bits for coop games
export const DROPPED_ITEM = 0x00010000;
export const DROPPED_PLAYER_ITEM = 0x00020000;
export const ITEM_TARGETS_USED = 0x00040000;

//
// fields are needed for spawning from the entity string
// and saving / loading games
//
export const FFL_SPAWNTEMP = 1;
export const FFL_NOSPAWN = 2;

export enum FieldtypeT {
  F_INT,
  F_FLOAT,
  F_LSTRING, // string on disk, pointer in memory, TAG_LEVEL
  F_GSTRING, // string on disk, pointer in memory, TAG_GAME
  F_VECTOR,
  F_ANGLEHACK,
  F_EDICT, // index on disk, pointer in memory
  F_ITEM, // index on disk, pointer in memory
  F_CLIENT, // index on disk, pointer in memory
  F_FUNCTION,
  F_MMOVE,
  F_IGNORE,
}

// `field_t.ofs` is `(int)&(((edict_t*)0)->x)` in C -- a byte offset used by
// g_save.c to read/write fields by raw memory layout. There is no TS
// equivalent (no struct memory layout to take the address of), so `ofs` is
// dropped; the future g_save.ts port must address fields by property name
// (`keyof EdictT`-style) instead of an offset. The FOFS/STOFS/LLOFS/CLOFS
// macros that computed these offsets are dropped for the same reason. The
// `fields[]` table itself is g_save.c's data and is not ported here.
export class FieldT {
  name = "";
  type: FieldtypeT = FieldtypeT.F_IGNORE;
  flags = 0;
}

//============================================================================

// client_t->anim_priority
export const ANIM_BASIC = 0; // stand / run
export const ANIM_WAVE = 1;
export const ANIM_JUMP = 2;
export const ANIM_PAIN = 3;
export const ANIM_ATTACK = 4;
export const ANIM_DEATH = 5;
export const ANIM_REVERSE = 6;

// client data that stays across multiple level loads
export class ClientPersistantT {
  userinfo = ""; // char[MAX_INFO_STRING]
  netname = ""; // char[16]
  hand = 0;

  connected = false; // a loadgame will leave valid entities that
  // just don't have a connection yet

  // values saved and restored from edicts when changing levels
  health = 0;
  max_health = 0;
  savedFlags = 0;

  selected_item = 0;
  inventory: Int32Array = new Int32Array(MAX_ITEMS);

  // ammo capacities
  max_bullets = 0;
  max_shells = 0;
  max_rockets = 0;
  max_grenades = 0;
  max_cells = 0;
  max_slugs = 0;

  weapon: GItemT | null = null;
  lastweapon: GItemT | null = null;

  power_cubes = 0; // used for tracking the cubes in coop games
  score = 0; // for calculating total unit score in coop games

  game_helpchanged = 0;
  helpchanged = 0;

  spectator = false; // client is a spectator

  // ROGUE
  max_tesla = 0;
  max_prox = 0;
  max_mines = 0;
  max_flechettes = 0;
  // (KILL_DISRUPTOR is always defined in the shipped rogue -- no max_rounds)
  // ROGUE
}

// client data that stays across deathmatch respawns
export class ClientRespawnT {
  coop_respawn: ClientPersistantT = new ClientPersistantT(); // what to set client->pers to on a respawn
  enterframe = 0; // level.framenum the client entered the game
  score = 0; // frags, etc
  cmd_angles: Vec3 = vec3(); // angles sent over in the last command

  spectator = false; // client is a spectator

  // RE-RELEASE CONTENT PORT -- CTF per-client respawn state, from
  // src/ctf/g_local.ts via our sibling src/game/g_local.ts. Backs the flag
  // entities (item_flag_team1/2) and the team spawn points this module now
  // hosts for the shipped CTF maps. `ctf_team` holds a ctfteam_t value
  // (CTF_NOTEAM/CTF_TEAM1/CTF_TEAM2) as a plain number, matching
  // src/ctf/g_local.ts's own note, so this file needs no value-import of the
  // ported g_ctf.ts. Every field defaults to what a non-CTF client already
  // leaves it at, so Ground Zero's own rules are untouched.
  ctf_team = 0;
  ctf_state = 0;
  ctf_lasthurtcarrier = 0;
  ctf_lastreturnedflag = 0;
  ctf_flagsince = 0;
  ctf_lastfraggedcarrier = 0;
  id_state = false;
  lastidtime = 0;
  voted = false; // for elections
  ready = false;
  admin = false;
  ghost: GhostT | null = null; // for ghost codes
}

// this structure is cleared on each PutClientInServer(),
// except for 'client->pers'
export class GClientT {
  // known to server
  ps: PlayerStateT = new PlayerStateT();
  ping = 0;

  // private to game
  pers: ClientPersistantT = new ClientPersistantT();
  resp: ClientRespawnT = new ClientRespawnT();
  old_pmove: PmoveStateT = new PmoveStateT(); // for detecting out-of-pmove changes

  showscores = false; // set layout stat
  showinventory = false; // set layout stat
  showhelp = false;
  showhelpicon = false;

  ammo_index = 0;

  buttons = 0;
  oldbuttons = 0;
  latched_buttons = 0;

  weapon_thunk = false;

  newweapon: GItemT | null = null;

  // sum up damage over an entire frame, so
  // shotgun blasts give a single big kick
  damage_armor = 0; // damage absorbed by armor
  damage_parmor = 0; // damage absorbed by power armor
  damage_blood = 0; // damage taken out of health
  damage_knockback = 0; // impact damage
  damage_from: Vec3 = vec3(); // origin for vector calculation

  killer_yaw = 0; // when dead, look at killer

  weaponstate: WeaponstateT = WeaponstateT.WEAPON_READY;
  kick_angles: Vec3 = vec3(); // weapon kicks
  kick_origin: Vec3 = vec3();
  v_dmg_roll = 0;
  v_dmg_pitch = 0;
  v_dmg_time = 0; // damage kicks
  fall_time = 0;
  fall_value = 0; // for view drop on fall
  damage_alpha = 0;
  bonus_alpha = 0;
  damage_blend: Vec3 = vec3();
  v_angle: Vec3 = vec3(); // aiming direction
  bobtime = 0; // so off-ground doesn't change it
  oldviewangles: Vec3 = vec3();
  oldvelocity: Vec3 = vec3();

  next_drown_time = 0;
  old_waterlevel = 0;
  breather_sound = 0;

  machinegun_shots = 0; // for weapon raising

  // animation vars
  anim_end = 0;
  anim_priority = 0;
  anim_duck = false;
  anim_run = false;

  // powerup timers
  quad_framenum = 0;
  invincible_framenum = 0;
  breather_framenum = 0;
  enviro_framenum = 0;

  grenade_blew_up = false;
  grenade_time = 0;
  silencer_shots = 0;
  weapon_sound = 0;

  pickup_msg_time = 0;

  flood_locktill = 0; // locked from talking
  flood_when: Float32Array = new Float32Array(10); // when messages were said
  flood_whenhead = 0; // head pointer for when said

  respawn_time = 0; // can respawn when time > this

  chase_target: EdictT | null = null; // player we are chasing
  update_chase = false; // need to update chase info?

  // ROGUE
  double_framenum = 0;
  ir_framenum = 0;
  // `float torch_framenum;` is commented out in the C struct -- not ported.
  nuke_framenum = 0;
  tracker_pain_framenum = 0;

  // RE-RELEASE CONTENT PORT -- the cloak (item_invisibility) timer, from
  // src/kexgame/ via our sibling src/game/g_local.ts. rdm14 places
  // item_invisibility. Counted in server frames like every other powerup
  // timer above rather than the re-release's gtime_t; cleared alongside them
  // in p_client.ts and drawn as RF_TRANSLUCENT in p_view.ts.
  invisible_framenum = 0;

  owned_sphere: EdictT | null = null; // this points to the player's sphere
  // ROGUE

  // RE-RELEASE CONTENT PORT -- CTF tech bookkeeping, from src/ctf/g_local.ts
  // via our sibling src/game/g_local.ts. Read and written only by the ported
  // g_ctf.ts tech code; zero for every client that never touches a tech, so
  // Ground Zero play is unchanged.
  ctf_regentime = 0; // regen tech
  ctf_techsndtime = 0;
  ctf_lasttechmsg = 0;

  // this structure is cleared on each PutClientInServer(), except for 'pers'
  clear(): void {
    const pers = this.pers;
    Object.assign(this, new GClientT());
    this.pers = pers;
  }
}

// DO NOT MODIFY THE FIELD ORDER ABOVE "game-only fields below this point" --
// the server expects gclient_s/edict_s's server-visible prefix in exactly
// this order (see game.h and the C comment reproduced below).
export class EdictT implements Edict {
  // === shared server<->game prefix (game.h's short edict_t) ===
  s: EntityStateT = new EntityStateT();
  client: GClientT | null = null; // NULL if not a player
  // the server expects the first part of gclient_s to be a player_state_t
  // but the rest of it is opaque
  inuse = false;
  linkcount = 0;

  // FIXME: move these fields to a server private sv_entity_t
  area: LinkT = new LinkT(); // linked to a division node or leaf

  num_clusters = 0; // if -1, use headnode instead
  clusternums: Int32Array = new Int32Array(MAX_ENT_CLUSTERS);
  headnode = 0; // unused if num_clusters != -1
  areanum = 0;
  areanum2 = 0;

  //================================

  svflags = 0;
  mins: Vec3 = vec3();
  maxs: Vec3 = vec3();
  absmin: Vec3 = vec3();
  absmax: Vec3 = vec3();
  size: Vec3 = vec3();
  solid: SolidT = SolidT.SOLID_NOT;
  clipmask = 0;
  owner: EdictT | null = null;

  // DO NOT MODIFY ANYTHING ABOVE THIS, THE SERVER
  // EXPECTS THE FIELDS IN THAT ORDER!

  //================================
  movetype: MovetypeT = MovetypeT.MOVETYPE_NONE;
  flags = 0;

  model: string | null = null;
  freetime = 0; // sv.time when the object was freed

  //
  // only used locally in game, not by server
  //
  message: string | null = null;
  classname: string | null = null;
  spawnflags = 0;

  timestamp = 0;

  angle = 0; // set in qe3, -1 = up, -2 = down
  target: string | null = null;
  targetname: string | null = null;
  killtarget: string | null = null;
  team: string | null = null;
  pathtarget: string | null = null;
  deathtarget: string | null = null;
  combattarget: string | null = null;
  target_ent: EdictT | null = null;

  speed = 0;
  accel = 0;
  decel = 0;
  movedir: Vec3 = vec3();
  pos1: Vec3 = vec3();
  pos2: Vec3 = vec3();

  velocity: Vec3 = vec3();
  avelocity: Vec3 = vec3();
  mass = 0;
  air_finished = 0;
  gravity = 0; // per entity gravity multiplier (1.0 is normal)
  // use for lowgrav artifact, flares

  goalentity: EdictT | null = null;
  movetarget: EdictT | null = null;
  yaw_speed = 0;
  ideal_yaw = 0;

  nextthink = 0;
  prethink: ((ent: EdictT) => void) | null = null;
  think: ((self: EdictT) => void) | null = null;
  blocked: ((self: EdictT, other: EdictT) => void) | null = null; // move to moveinfo?
  touch: ((self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null) => void) | null = null;
  use: ((self: EdictT, other: EdictT | null, activator: EdictT | null) => void) | null = null;
  pain: ((self: EdictT, other: EdictT, kick: number, damage: number) => void) | null = null;
  die:
    | ((self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3) => void)
    | null = null;

  touch_debounce_time = 0; // are all these legit?  do we need more/less of them?
  pain_debounce_time = 0;
  damage_debounce_time = 0;
  fly_sound_debounce_time = 0; // move to clientinfo
  last_move_time = 0;

  health = 0;
  max_health = 0;
  gib_health = 0;
  deadflag = 0;
  // C declares `qboolean show_hostile` but g_ai.c stores a truncated
  // level.time timestamp in it (int-backed enum absorbs the float); typed
  // as the number it really is.
  show_hostile = 0;

  powerarmor_time = 0;

  map: string | null = null; // target_changelevel

  viewheight = 0; // height above origin where eyesight is determined
  takedamage = 0;
  dmg = 0;
  radius_dmg = 0;
  dmg_radius = 0;
  sounds = 0; // make this a spawntemp var?
  count = 0;

  chain: EdictT | null = null;
  enemy: EdictT | null = null;
  oldenemy: EdictT | null = null;
  activator: EdictT | null = null;
  groundentity: EdictT | null = null;
  groundentity_linkcount = 0;
  teamchain: EdictT | null = null;
  teammaster: EdictT | null = null;

  mynoise: EdictT | null = null; // can go in client only
  mynoise2: EdictT | null = null;

  noise_index = 0;
  noise_index2 = 0;
  volume = 0;
  attenuation = 0;

  // timing variables
  wait = 0;
  delay = 0; // before firing targets
  random = 0;

  teleport_time = 0;

  watertype = 0;
  waterlevel = 0;

  move_origin: Vec3 = vec3();
  move_angles: Vec3 = vec3();

  // move this to clientinfo?
  light_level = 0;

  style = 0; // also used as areaportal number

  item: GItemT | null = null; // for bonus items

  // common data blocks
  moveinfo: MoveinfoT = new MoveinfoT();
  monsterinfo: MonsterInfoT = new MonsterInfoT();

  // ROGUE
  plat2flags = 0;
  offset: Vec3 = vec3();
  // g_utils.c's G_Spawn() and g_spawn.c's ED_NewEdict()/ED_ParseEdict()
  // explicitly VectorSet this to (0,0,-1) right after allocation -- C's
  // memset-to-zero leaves it (0,0,0) only in the instant before that runs,
  // same as here.
  gravityVector: Vec3 = vec3();
  bad_area: EdictT | null = null;
  hint_chain: EdictT | null = null;
  monster_hint_chain: EdictT | null = null;
  target_hint_chain: EdictT | null = null;
  hint_chain_id = 0;
  // FIXME - debug help!
  lastMoveTime = 0;
  // ROGUE

  // --- RE-RELEASE CONTENT PORT -- edict fields the re-release entity set
  // Ground Zero's own maps place reads (src/kexgame/g_local_types.ts, via
  // our sibling src/game/g_local.ts). All default to the same null/0 a
  // 1998-era rogue entity would leave them at, so existing content is
  // unaffected.
  //
  // `itemtarget` names the entity whose `style` drives a dynamic_light
  // (g_kexmisc.ts's setup_dynamic_light). fog/heightfog are read and written
  // by trigger_fog (g_kextrig.ts) and parsed onto worldspawn and onto the
  // `fog_values` info_notnull rlava2 uses as a value store. bmodel_anim is
  // read by func_animation (g_kexmisc.ts).
  itemtarget: string | null = null;
  fog: FogT = new FogT();
  heightfog: HeightFogT = new HeightFogT();
  bmodel_anim: BmodelAnimT = new BmodelAnimT();
  // `hackflags` carries the re-release's per-entity HACKFLAG_* bits; the ones
  // this module reaches are target_light's (g_kextarg.ts), which use it to
  // remember the good/bad lightstyle a target_light toggles between.
  hackflags = 0;

  clear(): void {
    Object.assign(this, new EdictT());
  }
}

// ------------------- from src/ctf/g_local.ts -------------------
// ctf/g_ctf.h's `ghost_t` (`struct ghost_s`). g_local.h's `client_respawn_t`
// forward-references it (`struct ghost_s *ghost;`) via ctf/g_local.h's
// trailing `#include "g_ctf.h"`; declared here rather than in the ported
// g_ctf.ts so ClientRespawnT.ghost above does not need a reverse type-only
// import (the same "helper's true source file differs from the mapping table"
// case PORTING.md calls out for random()/crandom()).
export class GhostT {
  netname = ""; // char[16]
  number = 0;

  // stats
  deaths = 0;
  kills = 0;
  caps = 0;
  basedef = 0;
  carrierdef = 0;

  code = 0; // ghost code
  team = 0; // team
  score = 0; // frags at time of disconnect
  ent: EdictT | null = null;
}

//===============================================================
// ROGUE -- deathmatch-game-rules and sphere/doppelganger shared types.
// g_local.h declares these (and the extern DMGame global); the sibling
// units g_sphere.c/g_newdm.c/dm_tag.c/dm_ball.c (outside this unit's
// SCOPE) implement the functions that populate them. This module owns only
// the type/constant declarations, matching the C split between the shared
// header and the .c files that define the actual behaviour.
//===============================================================

export const ROGUE_GRAVITY = 1;

export const SPHERE_DEFENDER = 0x0001;
export const SPHERE_HUNTER = 0x0002;
export const SPHERE_VENGEANCE = 0x0004;
export const SPHERE_DOPPLEGANGER = 0x0100;

export const SPHERE_TYPE = 0x00ff;
export const SPHERE_FLAGS = 0xff00;

//
// deathmatch games
//
export const RDM_TAG = 2;
export const RDM_DEATHBALL = 3;

// `dm_game_rt` (`struct dm_game_rs`): a table of function pointers selected
// by the `gamerules` cvar (RDM_TAG/RDM_DEATHBALL) at PostInitSetup and
// dispatched from g_main.c's per-frame/per-event hooks. `DogTag`'s C
// signature is `void (*)(edict_t *ent, edict_t *killer, char **pic)` -- an
// out-param string; per PORTING.md's "C helpers that mutate a char* in
// place... return the new string instead" idiom, it returns the pic path
// as a plain string here instead of writing through a pointer. `killer` is
// `EdictT | null`: p_hud.c's DeathmatchScoreboardMessage calls
// `DMGame.DogTag(cl_ent, killer, &tag)` unconditionally, including when
// `killer` is NULL (e.g. the local scoreboard entry for a player who died
// to the world), and leaves any NULL-handling to the dm_tag.c/dm_ball.c
// implementation (outside this unit's SCOPE) -- widened after a real
// call-site mismatch surfaced against p_hud.ts's port of that call.
export class DmGameRt {
  GameInit: (() => void) | null = null;
  PostInitSetup: (() => void) | null = null;
  ClientBegin: ((ent: EdictT) => void) | null = null;
  SelectSpawnPoint: ((ent: EdictT, origin: Vec3, angles: Vec3) => void) | null = null;
  PlayerDeath: ((targ: EdictT, inflictor: EdictT, attacker: EdictT) => void) | null = null;
  Score: ((attacker: EdictT, victim: EdictT, scoreChange: number) => void) | null = null;
  PlayerEffects: ((ent: EdictT) => void) | null = null;
  DogTag: ((ent: EdictT, killer: EdictT | null) => string) | null = null;
  PlayerDisconnect: ((ent: EdictT) => void) | null = null;
  ChangeDamage: ((targ: EdictT, attacker: EdictT, damage: number, mod: number) => number) | null = null;
  ChangeKnockback:
    | ((targ: EdictT, attacker: EdictT, knockback: number, mod: number) => number)
    | null = null;
  CheckDMRules: (() => number) | null = null;
}

// `extern dm_game_rt DMGame;` -- reassigned field-by-field (not a swapped
// pointer) by whichever of g_newdm.c/dm_tag.c/dm_ball.c's *_GameInit runs,
// so it stays a single mutable singleton instance, same treatment as
// `game`/`level`/`st` above.
export const DMGame: DmGameRt = new DmGameRt();

//===============================================================
// g_local.h externs: singletons, holders, and cross-module prototypes
//===============================================================

// `game`/`level`/`st` are shared mutable globals that are never reassigned
// (per PORTING.md); the C code memsets them, which becomes `clear()`.
export const game: GameLocalsT = new GameLocalsT();
export const level: LevelLocalsT = new LevelLocalsT();
export const st: SpawnTempT = new SpawnTempT();

// `gi`/`globals` are C globals assigned exactly once, at DLL load
// (GetGameApi), and read as bare globals at thousands of call sites.
// Declared without initializer: undefined-until-GetGameAPI matches the C
// global's uninitialized-until-load lifetime, and call sites keep the C
// shape `gi.dprintf(...)`. Assign only through the setters (imported
// bindings are read-only).
export let gi: GameImports;
export let globals: GameExports;
export function SetGameImports(v: GameImports): void {
  gi = v;
}
export function SetGameExports(v: GameExports): void {
  globals = v;
}

// `extern int sm_meat_index; extern int snd_fry; extern int
// jacket_armor_index; extern int combat_armor_index; extern int
// body_armor_index;` -- precached model/sound/item indices resolved once
// during InitItems/PrecacheItem and read thereafter.
export const gameIndices: {
  sm_meat_index: number;
  snd_fry: number;
  jacket_armor_index: number;
  combat_armor_index: number;
  body_armor_index: number;
} = { sm_meat_index: 0, snd_fry: 0, jacket_armor_index: 0, combat_armor_index: 0, body_armor_index: 0 };

// `extern edict_t *g_edicts;` -- reshaped the same way GameExports.edicts
// is in game.ts: a plain array instead of a pointer, sized once max_edicts
// is known at Init time.
export let g_edicts: EdictT[] = [];
export function SetGEdicts(v: EdictT[]): void {
  g_edicts = v;
}

// `#define world (&g_edicts[0])`
export function world(): EdictT {
  const w = g_edicts[0];
  if (w === undefined) {
    throw new Error("world: g_edicts is not initialized (edict 0 does not exist yet)");
  }
  return w;
}

// `random()`/`crandom()` are declared in g_local.h but PORTING.md names
// this exact pair as the case where the C source file and the TS mapping
// file differ: they belong in src/shared/math.ts, not here. Per this
// worker's SCOPE (src/rogue/ only), they are not re-declared in this
// module; callers import them from "../shared/math" once that unit
// provides them.

// console variables read by the game module; each is resolved once via
// gi.cvar() during InitGame and never reassigned afterward, hence a single
// holder object rather than one exported `let` per cvar.
//
// rogue/g_local.h drops `needpass` (dead in this pack -- no rogue .c file
// references it) and adds `sv_stopspeed` (promoted from a g_phys.c #define
// to a real cvar) plus the pack's own g_showlogic/gamerules/huntercam/
// strong_mines/randomrespawn cvars.
export const gameCvars: {
  maxentities: CvarT | null;
  deathmatch: CvarT | null;
  coop: CvarT | null;
  dmflags: CvarT | null;
  skill: CvarT | null;
  fraglimit: CvarT | null;
  timelimit: CvarT | null;
  password: CvarT | null;
  spectator_password: CvarT | null;
  g_select_empty: CvarT | null;
  dedicated: CvarT | null;
  filterban: CvarT | null;
  sv_gravity: CvarT | null;
  sv_maxvelocity: CvarT | null;
  gun_x: CvarT | null;
  gun_y: CvarT | null;
  gun_z: CvarT | null;
  sv_rollspeed: CvarT | null;
  sv_rollangle: CvarT | null;
  run_pitch: CvarT | null;
  run_roll: CvarT | null;
  bob_up: CvarT | null;
  bob_pitch: CvarT | null;
  bob_roll: CvarT | null;
  sv_cheats: CvarT | null;
  maxclients: CvarT | null;
  maxspectators: CvarT | null;
  flood_msgs: CvarT | null;
  flood_persecond: CvarT | null;
  flood_waitdelay: CvarT | null;
  sv_maplist: CvarT | null;
  sv_stopspeed: CvarT | null;
  g_showlogic: CvarT | null;
  gamerules: CvarT | null;
  huntercam: CvarT | null;
  strong_mines: CvarT | null;
  randomrespawn: CvarT | null;
} = {
  maxentities: null,
  deathmatch: null,
  coop: null,
  dmflags: null,
  skill: null,
  fraglimit: null,
  timelimit: null,
  password: null,
  spectator_password: null,
  g_select_empty: null,
  dedicated: null,
  filterban: null,
  sv_gravity: null,
  sv_maxvelocity: null,
  gun_x: null,
  gun_y: null,
  gun_z: null,
  sv_rollspeed: null,
  sv_rollangle: null,
  run_pitch: null,
  run_roll: null,
  bob_up: null,
  bob_pitch: null,
  bob_roll: null,
  sv_cheats: null,
  maxclients: null,
  maxspectators: null,
  flood_msgs: null,
  flood_persecond: null,
  flood_waitdelay: null,
  sv_maplist: null,
  sv_stopspeed: null,
  g_showlogic: null,
  gamerules: null,
  huntercam: null,
  strong_mines: null,
  randomrespawn: null,
};
