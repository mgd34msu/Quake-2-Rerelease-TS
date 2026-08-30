// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_local.h -- local definitions for game module (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_local.h (3,648 lines, C++17).
//
// TYPES-ONLY PORT: enums, constants, struct-as-interface shapes, and the
// save-function-pointer registry design (see ../g_save_registry.ts). No game
// logic is ported here -- every free function declared in g_local.h (the
// long "g_cmds.c" / "g_items.c" / ... prototype sections starting around
// line 2006) is behavior and is intentionally NOT ported; those belong to
// the future units that port g_cmds.ts/g_items.ts/g_monster.ts/etc. for this
// kex line, mirroring how src/game/*.ts already split g_local.h's vanilla
// counterpart across many files.
//
// This module is split into two files per this unit's brief ("split into a
// second file if one file exceeds ~4k lines; keep declaration order within
// each"):
//   - g_local.ts (this file): every enum, every constant, file-level
//     provenance/deviations discussion.
//   - g_local_types.ts: every struct-as-interface/class shape
//     (moveinfo_t/mmove_t/monsterinfo_t/gclient_t/edict_t/level_locals_t/
//     game_locals_t/spawn_temp_t/gitem_t/...).
// g_local.ts re-exports everything from g_local_types.ts so a single
// `import ... from "./g_local"` mirrors `#include "g_local.h"`.
//
// Foundation units this port builds on (read their own headers for their
// own deviations, not repeated here):
//   - ../kexapi/game.ts: the kex game API types (KexEdictT/KexGclientT
//     server-visible stubs, KexEntityStateT, KexPlayerStateT, KexTraceT,
//     ContentsT, SvflagsT, ButtonT, WaterLevelT, EffectsT (bigint), ...).
//   - ./gtime.ts: `GTime`, a branded-number port of `gtime_t`.
//   - ./spawnflags.ts: `SpawnFlags`, a branded-number port of the generic
//     `spawnflags_t` wrapper. The RESERVED bits it deferred
//     (SPAWNFLAG_NOT_EASY/MEDIUM/HARD/DEATHMATCH/COOP, RESERVED1/2,
//     COOP_ONLY, EDITOR_MASK) are ported below, per that file's own
//     "Scope note".
//   - ./q_vec3.ts / ./q_std.ts: `Vec3` value-semantics helpers and the
//     `frandom`/`crandom`/`irandom`/`random_index`/`random_element`/
//     `brandom` family (g_local.h declares these too, per q_std.ts's own
//     documented scope mismatch -- `random_time` below is the one member of
//     that family not yet ported anywhere, so it lands here instead).
//
// ============================================================================
// ENUM BIT-WIDTH AUDIT (every MAKE_ENUM_BITFLAGS(T) enum in this header)
// ============================================================================
//   gib_type_t          (no explicit type, defaults int32)      -> number
//   monster_ai_flags_t  : uint64_t                               -> BIGINT
//   ent_flags_t         : uint64_t                                -> BIGINT
//   item_flags_t        : uint32_t                                -> number
//   damageflags_t       (no explicit type, defaults int32)       -> number
//   anim_priority_t     (no explicit type, defaults int32)       -> number
//   plat2flags_t        (no explicit type, defaults int32)       -> number
// Only `monster_ai_flags_t` and `ent_flags_t` are declared 64-bit (and both
// actually use bits past 31: AI_THIRD_EYE is bit 38; FL_IMMORTAL is bit 34),
// so only `MonsterAiFlagsT`/`EntFlagsT` use `bigint` here, matching the same
// `bit(n)`/`bitBig(n)` convention kexapi/game.ts established (`bit(n)` = `2
// ** n` for the 32-bit tables, since JS's `<<` operates on signed int32 and
// would produce negative values past bit 30; `bitBig(n)` = `1n << BigInt(n)`
// for the two 64-bit tables).
//
// ============================================================================
// SCOPE-MISMATCH NOTE: ammo_t / powerup_t / stuck_result_t / coop_respawn_t
// ============================================================================
// Per the brief's enumerated scope, `ammo_t` and `powerup_t` are ported
// below -- but they are NOT actually declared in g_local.h itself; grepping
// confirmed both live in bg_local.h (lines 79 and 101 respectively), a
// sibling header g_local.h does not even include (game.h does, transitively,
// via `#define GAME_INCLUDE` + `#include "game.h"` in bg_local.h). Likewise
// `stuck_result_t` and `coop_respawn_t` (needed by `GClientT.coop_respawn_state`)
// are declared in bg_local.h, not g_local.h. Per PORTING.md's "the brief's
// placement wins; report the mismatch, don't move it" precedent (already
// invoked once in this module family by q_std.ts's own `frandom`/`irandom`
// scope note), all four are ported here anyway since the brief names them
// explicitly and/or an in-scope g_local.h struct field needs them.
//
// ============================================================================
// SFL_CROSS_TRIGGER_* -- narrower than the vanilla/legacy port
// ============================================================================
// The vanilla/legacy game module (src/game/g_local.ts) has eight individual
// `SFL_CROSS_TRIGGER_1..8` bit constants plus a `0xff` mask. This KEX header
// has ONLY the mask, computed differently: `constexpr uint32_t
// SFL_CROSS_TRIGGER_MASK = (0xffffffffu & ~SPAWNFLAG_EDITOR_MASK.value);`
// (g_local.h:733) -- i.e. "every bit NOT reserved by the spawnflags editor
// mask", not a fixed 8-bit range. Grepped the full header for
// `SFL_CROSS_TRIGGER` a second time to confirm: exactly one match, the mask
// itself. Ported faithfully as a single computed constant, no per-bit names.
//
// ============================================================================
// RANGE_MELEE/NEAR/MID -- semantics changed from the vanilla/legacy port
// ============================================================================
// Vanilla/legacy `RANGE_MELEE`/`RANGE_NEAR`/`RANGE_MID`/`RANGE_FAR` are
// ordinal enum values (0/1/2/3) describing a monster's range *bucket*. This
// KEX header redefines them as actual float distances in world units
// (g_local.h:2296-2298: `RANGE_MELEE = 20`, `RANGE_NEAR = 440`, `RANGE_MID =
// 940`) -- there is no `RANGE_FAR` constant at all anymore (`range_to()`'s
// own doc comment: "[Paril-KEX] adjusted to return an actual distance,
// measured in a way that is consistent regardless of what is fighting
// what"). Ported faithfully as three plain distance constants; no `RANGE_FAR`.
//
// ============================================================================
// DROPPED: memory tags, save_data_tag_t, extern cvar_t* globals, itemlist[]
// ============================================================================
// - `TAG_GAME`/`TAG_LEVEL` (memory tags): dropped per PORTING.md ("Z_Malloc/
//   Z_Free/Hunk_*/Z_TagMalloc -> plain allocation"), matching the identical
//   precedent already set in the vanilla/legacy g_local.ts for the same two
//   names.
// - `save_data_tag_t` (the C registry's integrity-check tag enum, g_local.h:
//   489-520): NOT ported. This unit's registry design (../g_save_registry.ts)
//   uses one distinct `Map` per function-pointer KIND instead of one shared
//   tagged-union list, so there is no runtime tag value to carry -- TS's
//   static typing (a distinct exported register/lookup function pair per
//   kind) plays the tag's role at compile time instead.
// - `extern cvar_t *deathmatch; ...` (g_local.h:1881-1987) and `extern
//   gitem_t itemlist[IT_TOTAL];`: runtime GLOBALS (behavior/state), not
//   types, out of scope for this unit -- see g_local_types.ts's closing note.
//
// ============================================================================
// NOT FOUND: FFL_* (field-flags)
// ============================================================================
// Grepped the entire rerelease/ tree for `FFL_` (the vanilla/legacy field-
// flags family, e.g. `FFL_NOSPAWN`, referenced by the legacy port's own
// src/game/g_save.ts comment on its FIELDS table): zero matches anywhere in
// this codebase. This KEX header has no `field_t`/`FFL_*`/`ED_ParseField`
// machinery in g_local.h at all (that lives in g_spawn.c, a different file,
// out of scope for this unit either way, and even there the constant family
// is spelled differently). Nothing to port under this name.

import type { Vec3 } from "../shared/math";
import { vec3 } from "../shared/math";
import { MAX_CLIENTS, MAX_EDICTS } from "../kexapi/game";
import { type GTime, Gtime_from_ms, Gtime_add, Gtime_subtract } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_or, SpawnFlags_value } from "./spawnflags";
import { irandom } from "./q_std";

export * from "./g_local_types";

// Computes 2**n / 1n<<BigInt(n) for the bitflag tables below -- see the
// bit-width audit above. Not exported: local plumbing only, mirroring
// kexapi/game.ts's identical `bit`/`bitBig` helpers (not re-exported from
// there either).
const bit = (n: number): number => 2 ** n;
const bitBig = (n: number): bigint => 1n << BigInt(n);

//==================================================================

/** g_local.h:10: `constexpr const char *GAMEVERSION = "baseq2";` */
export const GAMEVERSION = "baseq2";

/** g_local.h:14-15. */
export const PLAYER_MINS: Vec3 = vec3(-16, -16, -24);
export const PLAYER_MAXS: Vec3 = vec3(16, 16, 32);

// ---------------------------------------------------------------------------
// gtime_t-derived view pitching times (g_local.h:467-485)
// ---------------------------------------------------------------------------
// `SERVER_TICK_RATE`/`FRAME_TIME_S`/`FRAME_TIME_MS` are runtime globals set
// from `gi.tick_rate` (behavior, not ported). Per the identical precedent
// `Gtime_frames` already set in gtime.ts, these take `frameTimeMs` as an
// explicit parameter instead of reaching for a global that does not exist
// in this port line yet.

/** g_local.h: `DAMAGE_TIME_SLACK() { return (100_ms - FRAME_TIME_MS); }` */
export function DAMAGE_TIME_SLACK(frameTimeMs: GTime): GTime {
  return Gtime_subtract(Gtime_from_ms(100), frameTimeMs);
}

/** g_local.h: `DAMAGE_TIME() { return 500_ms + DAMAGE_TIME_SLACK(); }` */
export function DAMAGE_TIME(frameTimeMs: GTime): GTime {
  return Gtime_add(Gtime_from_ms(500), DAMAGE_TIME_SLACK(frameTimeMs));
}

/** g_local.h: `FALL_TIME() { return 300_ms + DAMAGE_TIME_SLACK(); }` */
export function FALL_TIME(frameTimeMs: GTime): GTime {
  return Gtime_add(Gtime_from_ms(300), DAMAGE_TIME_SLACK(frameTimeMs));
}

// ---------------------------------------------------------------------------
// reserved spawnflag bits deferred from spawnflags.ts (g_local.h:249-282)
// ---------------------------------------------------------------------------

/** these spawnflags affect every entity; the first 8 bits are reserved and
 *  should never be used by any entity (power cubes in coop use these after
 *  spawning as well). */
export const SPAWNFLAG_NOT_EASY: SpawnFlags = SpawnFlags_from(0x00000100);
export const SPAWNFLAG_NOT_MEDIUM: SpawnFlags = SpawnFlags_from(0x00000200);
export const SPAWNFLAG_NOT_HARD: SpawnFlags = SpawnFlags_from(0x00000400);
export const SPAWNFLAG_NOT_DEATHMATCH: SpawnFlags = SpawnFlags_from(0x00000800);
export const SPAWNFLAG_NOT_COOP: SpawnFlags = SpawnFlags_from(0x00001000);
export const SPAWNFLAG_RESERVED1: SpawnFlags = SpawnFlags_from(0x00002000);
export const SPAWNFLAG_COOP_ONLY: SpawnFlags = SpawnFlags_from(0x00004000);
export const SPAWNFLAG_RESERVED2: SpawnFlags = SpawnFlags_from(0x00008000);

export const SPAWNFLAG_EDITOR_MASK: SpawnFlags = SpawnFlags_or(
  SpawnFlags_or(
    SpawnFlags_or(SpawnFlags_or(SPAWNFLAG_NOT_EASY, SPAWNFLAG_NOT_MEDIUM), SpawnFlags_or(SPAWNFLAG_NOT_HARD, SPAWNFLAG_NOT_DEATHMATCH)),
    SPAWNFLAG_NOT_COOP,
  ),
  SpawnFlags_or(SpawnFlags_or(SPAWNFLAG_RESERVED1, SPAWNFLAG_COOP_ONLY), SPAWNFLAG_RESERVED2),
);

// `operator "" _spawnflag` / `operator "" _spawnflag_bit` (the literal
// operators that validate a spawnflag value against SPAWNFLAG_EDITOR_MASK
// and throw on collision) have no TS user-defined-literal equivalent; per
// spawnflags.ts's own "Scope note", every `N_spawnflag`/`N_spawnflag_bit`
// call site below is simply `SpawnFlags_from(N)` / `SpawnFlags_from(1 <<
// N)`, with the reserved-bit check omitted (none of the values below
// actually collide with SPAWNFLAG_EDITOR_MASK -- verified against every
// constant transcribed here).

// ---------------------------------------------------------------------------
// misc top-level constants (g_local.h:615-624)
// ---------------------------------------------------------------------------

/** g_local.h:622: `constexpr float MELEE_DISTANCE = 50;` (NOT 80 -- that is
 *  the vanilla/legacy value; this KEX header uses 50). */
export const MELEE_DISTANCE = 50;

export const BODY_QUEUE_SIZE = 8;

// ---------------------------------------------------------------------------
// weaponstate_t (g_local.h:629-635)
// ---------------------------------------------------------------------------

export enum WeaponstateT {
  WEAPON_READY,
  WEAPON_ACTIVATING,
  WEAPON_DROPPING,
  WEAPON_FIRING,
}

// ---------------------------------------------------------------------------
// gib_type_t (g_local.h:638-648) -- bitflags, default int32 -> number
// ---------------------------------------------------------------------------

export const GibTypeT = {
  GIB_NONE: 0, // no flags (organic)
  GIB_METALLIC: bit(0), // bouncier
  GIB_ACID: bit(1), // acidic (gekk)
  GIB_HEAD: bit(2), // head gib; the input entity will transform into this
  GIB_DEBRIS: bit(3), // explode outwards rather than in velocity, no blood
  GIB_SKINNED: bit(4), // use skinnum
  GIB_UPRIGHT: bit(5), // stay upright on ground
} as const;
export type GibTypeT = number;

// ---------------------------------------------------------------------------
// monster_ai_flags_t (g_local.h:651-704) -- bitflags, uint64_t -> BIGINT
// ---------------------------------------------------------------------------

export const MonsterAiFlagsT = {
  AI_NONE: 0n,
  AI_STAND_GROUND: bitBig(0),
  AI_TEMP_STAND_GROUND: bitBig(1),
  AI_SOUND_TARGET: bitBig(2),
  AI_LOST_SIGHT: bitBig(3),
  AI_PURSUIT_LAST_SEEN: bitBig(4),
  AI_PURSUE_NEXT: bitBig(5),
  AI_PURSUE_TEMP: bitBig(6),
  AI_HOLD_FRAME: bitBig(7),
  AI_GOOD_GUY: bitBig(8),
  AI_BRUTAL: bitBig(9),
  AI_NOSTEP: bitBig(10),
  AI_DUCKED: bitBig(11),
  AI_COMBAT_POINT: bitBig(12),
  AI_MEDIC: bitBig(13),
  AI_RESURRECTING: bitBig(14),

  // ROGUE
  AI_MANUAL_STEERING: bitBig(15),
  AI_TARGET_ANGER: bitBig(16),
  AI_DODGING: bitBig(17),
  AI_CHARGING: bitBig(18),
  AI_HINT_PATH: bitBig(19),
  AI_IGNORE_SHOTS: bitBig(20),
  // PMM - FIXME - last second added for E3 .. there's probably a better way
  // to do this, but this works
  AI_DO_NOT_COUNT: bitBig(21), // set for healed monsters
  AI_SPAWNED_CARRIER: bitBig(22), // both do_not_count and spawned are set for spawned monsters
  AI_SPAWNED_MEDIC_C: bitBig(23), // both do_not_count and spawned are set for spawned monsters
  AI_SPAWNED_WIDOW: bitBig(24), // both do_not_count and spawned are set for spawned monsters
  AI_BLOCKED: bitBig(25), // used by blocked_checkattack: set to say I'm attacking while blocked (prevents run-attacks)
  // ROGUE
  AI_SPAWNED_ALIVE: bitBig(26), // [Paril-KEX] for spawning dead
  AI_SPAWNED_DEAD: bitBig(27),
  AI_HIGH_TICK_RATE: bitBig(28), // not limited by 10hz actions
  AI_NO_PATH_FINDING: bitBig(29), // don't try nav nodes for path finding
  AI_PATHING: bitBig(30), // using nav nodes currently
  AI_STINKY: bitBig(31), // spawn flies
  AI_STUNK: bitBig(32), // already spawned files

  AI_ALTERNATE_FLY: bitBig(33), // use alternate flying mechanics; see monsterinfo.fly_xxx
  AI_TEMP_MELEE_COMBAT: bitBig(34), // temporarily switch to the melee combat style
  AI_FORGET_ENEMY: bitBig(35), // forget the current enemy
  AI_DOUBLE_TROUBLE: bitBig(36), // JORG only
  AI_REACHED_HOLD_COMBAT: bitBig(37),
  AI_THIRD_EYE: bitBig(38),
} as const;
export type MonsterAiFlagsT = bigint;

/** mask to catch all three flavors of spawned */
export const AI_SPAWNED_MASK: MonsterAiFlagsT =
  MonsterAiFlagsT.AI_SPAWNED_CARRIER | MonsterAiFlagsT.AI_SPAWNED_MEDIC_C | MonsterAiFlagsT.AI_SPAWNED_WIDOW;

// ---------------------------------------------------------------------------
// monster_attack_state_t (g_local.h:707-715)
// ---------------------------------------------------------------------------

export enum MonsterAttackStateT {
  AS_NONE,
  AS_STRAIGHT,
  AS_SLIDING,
  AS_MELEE,
  AS_MISSILE,
  AS_BLIND, // PMM - used by boss code to do nasty things even if it can't see you
}

// ---------------------------------------------------------------------------
// handedness_t (g_local.h:718-723)
// ---------------------------------------------------------------------------

export enum HandednessT {
  RIGHT_HANDED,
  LEFT_HANDED,
  CENTER_HANDED,
}

// ---------------------------------------------------------------------------
// auto_switch_t (g_local.h:725-731) -- `enum class`
// ---------------------------------------------------------------------------

export enum AutoSwitchT {
  SMART,
  ALWAYS,
  ALWAYS_NO_AMMO,
  NEVER,
}

/** g_local.h:733: `constexpr uint32_t SFL_CROSS_TRIGGER_MASK = (0xffffffffu &
 *  ~SPAWNFLAG_EDITOR_MASK.value);` -- see file header "SFL_CROSS_TRIGGER_*". */
export const SFL_CROSS_TRIGGER_MASK = (0xffffffff & ~SpawnFlags_value(SPAWNFLAG_EDITOR_MASK)) >>> 0;

// ---------------------------------------------------------------------------
// player_noise_t (g_local.h:736-741)
// ---------------------------------------------------------------------------

export enum PlayerNoiseT {
  PNOISE_SELF,
  PNOISE_WEAPON,
  PNOISE_IMPACT,
}

// ---------------------------------------------------------------------------
// movetype_t (g_local.h:756-774)
// ---------------------------------------------------------------------------

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
  // RAFAEL
  MOVETYPE_WALLBOUNCE,
  // RAFAEL
  // ROGUE
  MOVETYPE_NEWTOSS, // PGM - for deathball
  // ROGUE
}

// ---------------------------------------------------------------------------
// ent_flags_t (g_local.h:777-822) -- bitflags, uint64_t -> BIGINT
// ---------------------------------------------------------------------------

export const EntFlagsT = {
  FL_NONE: 0n, // no flags
  FL_FLY: bitBig(0),
  FL_SWIM: bitBig(1), // implied immunity to drowning
  FL_IMMUNE_LASER: bitBig(2),
  FL_INWATER: bitBig(3),
  FL_GODMODE: bitBig(4),
  FL_NOTARGET: bitBig(5),
  FL_IMMUNE_SLIME: bitBig(6),
  FL_IMMUNE_LAVA: bitBig(7),
  FL_PARTIALGROUND: bitBig(8), // not all corners are valid
  FL_WATERJUMP: bitBig(9), // player jumping out of water
  FL_TEAMSLAVE: bitBig(10), // not the first on the team
  FL_NO_KNOCKBACK: bitBig(11),
  FL_POWER_ARMOR: bitBig(12), // power armor (if any) is active

  // ROGUE
  FL_MECHANICAL: bitBig(13), // entity is mechanical, use sparks not blood
  FL_SAM_RAIMI: bitBig(14), // entity is in sam raimi cam mode
  FL_DISGUISED: bitBig(15), // entity is in disguise, monsters will not recognize.
  FL_NOGIB: bitBig(16), // player has been vaporized by a nuke, drop no gibs
  FL_DAMAGEABLE: bitBig(17),
  FL_STATIONARY: bitBig(18),
  // ROGUE

  FL_ALIVE_KNOCKBACK_ONLY: bitBig(19), // only apply knockback if alive or on same frame as death
  FL_NO_DAMAGE_EFFECTS: bitBig(20),

  // [Paril-KEX] gets scaled by coop health scaling
  FL_COOP_HEALTH_SCALE: bitBig(21),
  FL_FLASHLIGHT: bitBig(22), // enable flashlight
  FL_KILL_VELOCITY: bitBig(23), // for berserker slam
  FL_NOVISIBLE: bitBig(24), // super invisibility
  FL_DODGE: bitBig(25), // monster should try to dodge this
  FL_TEAMMASTER: bitBig(26), // is a team master (only here so that entities abusing teammaster/teamchain for stuff don't break)
  FL_LOCKED: bitBig(27), // entity is locked for the purposes of navigation
  FL_ALWAYS_TOUCH: bitBig(28), // always touch, even if we normally wouldn't
  FL_NO_STANDING: bitBig(29), // don't allow "standing" on non-brush entities
  FL_WANTS_POWER_ARMOR: bitBig(30), // for players, auto-shield

  FL_RESPAWN: bitBig(31), // used for item respawning
  FL_TRAP: bitBig(32), // entity is a trap of some kind
  FL_TRAP_LASER_FIELD: bitBig(33), // enough of a special case to get it's own flag...
  FL_IMMORTAL: bitBig(34), // never go below 1hp
} as const;
export type EntFlagsT = bigint;

// ---------------------------------------------------------------------------
// item_flags_t (g_local.h:825-852) -- bitflags, uint32_t -> number
// ---------------------------------------------------------------------------

export const ItemFlagsT = {
  IF_NONE: 0,
  IF_WEAPON: bit(0), // use makes active weapon
  IF_AMMO: bit(1),
  IF_ARMOR: bit(2),
  IF_STAY_COOP: bit(3),
  IF_KEY: bit(4),
  IF_POWERUP: bit(5),
  // ROGUE
  IF_NOT_GIVEABLE: bit(6), // item can not be given
  // ROGUE
  IF_HEALTH: bit(7),
  // ZOID
  IF_TECH: bit(8),
  IF_NO_HASTE: bit(9),
  // ZOID

  IF_NO_INFINITE_AMMO: bit(10), // [Paril-KEX] don't allow infinite ammo to affect
  IF_POWERUP_WHEEL: bit(11), // [Paril-KEX] item should be in powerup wheel
  IF_POWERUP_ONOFF: bit(12), // [Paril-KEX] for wheel; can't store more than one, show on/off state

  IF_NOT_RANDOM: bit(13), // [Paril-KEX] item never shows up in randomizations

  IF_ANY: 0xffffffff,
} as const;
export type ItemFlagsT = number;

// ---------------------------------------------------------------------------
// health edict_t->style (g_local.h:854-859) -- unnamed C enum
// ---------------------------------------------------------------------------

export const HEALTH_IGNORE_MAX = 1;
export const HEALTH_TIMED = 2;

// ---------------------------------------------------------------------------
// item_id_t (g_local.h:862-962) -- must match itemlist order EXACTLY
// ---------------------------------------------------------------------------
// `#if 0 IT_WEAPON_DISINTEGRATOR #endif` (g_local.h:894-896) is dead code in
// the C source itself (compiled out) and is correctly omitted here too --
// omitting it does not shift any later ordinal, since the `#if 0` block sits
// between two enumerators with no intervening comma-less gap.

export enum ItemIdT {
  IT_NULL, // must always be zero

  IT_ARMOR_BODY,
  IT_ARMOR_COMBAT,
  IT_ARMOR_JACKET,
  IT_ARMOR_SHARD,

  IT_ITEM_POWER_SCREEN,
  IT_ITEM_POWER_SHIELD,

  IT_WEAPON_GRAPPLE,
  IT_WEAPON_BLASTER,
  IT_WEAPON_CHAINFIST,
  IT_WEAPON_SHOTGUN,
  IT_WEAPON_SSHOTGUN,
  IT_WEAPON_MACHINEGUN,
  IT_WEAPON_ETF_RIFLE,
  IT_WEAPON_CHAINGUN,
  IT_AMMO_GRENADES,
  IT_AMMO_TRAP,
  IT_AMMO_TESLA,
  IT_WEAPON_GLAUNCHER,
  IT_WEAPON_PROXLAUNCHER,
  IT_WEAPON_RLAUNCHER,
  IT_WEAPON_HYPERBLASTER,
  IT_WEAPON_IONRIPPER,
  IT_WEAPON_PLASMABEAM,
  IT_WEAPON_RAILGUN,
  IT_WEAPON_PHALANX,
  IT_WEAPON_BFG,
  IT_WEAPON_DISRUPTOR,

  IT_AMMO_SHELLS,
  IT_AMMO_BULLETS,
  IT_AMMO_CELLS,
  IT_AMMO_ROCKETS,
  IT_AMMO_SLUGS,
  IT_AMMO_MAGSLUG,
  IT_AMMO_FLECHETTES,
  IT_AMMO_PROX,
  IT_AMMO_NUKE,
  IT_AMMO_ROUNDS,

  IT_ITEM_QUAD,
  IT_ITEM_QUADFIRE,
  IT_ITEM_INVULNERABILITY,
  IT_ITEM_INVISIBILITY,
  IT_ITEM_SILENCER,
  IT_ITEM_REBREATHER,
  IT_ITEM_ENVIROSUIT,
  IT_ITEM_ANCIENT_HEAD,
  IT_ITEM_LEGACY_HEAD,
  IT_ITEM_ADRENALINE,
  IT_ITEM_BANDOLIER,
  IT_ITEM_PACK,
  IT_ITEM_IR_GOGGLES,
  IT_ITEM_DOUBLE,
  IT_ITEM_SPHERE_VENGEANCE,
  IT_ITEM_SPHERE_HUNTER,
  IT_ITEM_SPHERE_DEFENDER,
  IT_ITEM_DOPPELGANGER,
  IT_ITEM_TAG_TOKEN,

  IT_KEY_DATA_CD,
  IT_KEY_POWER_CUBE,
  IT_KEY_EXPLOSIVE_CHARGES,
  IT_KEY_YELLOW,
  IT_KEY_POWER_CORE,
  IT_KEY_PYRAMID,
  IT_KEY_DATA_SPINNER,
  IT_KEY_PASS,
  IT_KEY_BLUE_KEY,
  IT_KEY_RED_KEY,
  IT_KEY_GREEN_KEY,
  IT_KEY_COMMANDER_HEAD,
  IT_KEY_AIRSTRIKE,
  IT_KEY_NUKE_CONTAINER,
  IT_KEY_NUKE,

  IT_HEALTH_SMALL,
  IT_HEALTH_MEDIUM,
  IT_HEALTH_LARGE,
  IT_HEALTH_MEGA,

  IT_FLAG1,
  IT_FLAG2,

  IT_TECH_RESISTANCE,
  IT_TECH_STRENGTH,
  IT_TECH_HASTE,
  IT_TECH_REGENERATION,

  IT_ITEM_FLASHLIGHT,
  IT_ITEM_COMPASS,

  IT_TOTAL,
}

// ---------------------------------------------------------------------------
// mod_id_t (g_local.h:1012-1079) -- means of death, uint8_t
// ---------------------------------------------------------------------------

export enum ModIdT {
  MOD_UNKNOWN,
  MOD_BLASTER,
  MOD_SHOTGUN,
  MOD_SSHOTGUN,
  MOD_MACHINEGUN,
  MOD_CHAINGUN,
  MOD_GRENADE,
  MOD_G_SPLASH,
  MOD_ROCKET,
  MOD_R_SPLASH,
  MOD_HYPERBLASTER,
  MOD_RAILGUN,
  MOD_BFG_LASER,
  MOD_BFG_BLAST,
  MOD_BFG_EFFECT,
  MOD_HANDGRENADE,
  MOD_HG_SPLASH,
  MOD_WATER,
  MOD_SLIME,
  MOD_LAVA,
  MOD_CRUSH,
  MOD_TELEFRAG,
  MOD_TELEFRAG_SPAWN,
  MOD_FALLING,
  MOD_SUICIDE,
  MOD_HELD_GRENADE,
  MOD_EXPLOSIVE,
  MOD_BARREL,
  MOD_BOMB,
  MOD_EXIT,
  MOD_SPLASH,
  MOD_TARGET_LASER,
  MOD_TRIGGER_HURT,
  MOD_HIT,
  MOD_TARGET_BLASTER,
  // RAFAEL 14-APR-98
  MOD_RIPPER,
  MOD_PHALANX,
  MOD_BRAINTENTACLE,
  MOD_BLASTOFF,
  MOD_GEKK,
  MOD_TRAP,
  // END 14-APR-98
  // ROGUE
  MOD_CHAINFIST,
  MOD_DISINTEGRATOR,
  MOD_ETF_RIFLE,
  MOD_BLASTER2,
  MOD_HEATBEAM,
  MOD_TESLA,
  MOD_PROX,
  MOD_NUKE,
  MOD_VENGEANCE_SPHERE,
  MOD_HUNTER_SPHERE,
  MOD_DEFENDER_SPHERE,
  MOD_TRACKER,
  MOD_DBALL_CRUSH,
  MOD_DOPPLE_EXPLODE,
  MOD_DOPPLE_VENGEANCE,
  MOD_DOPPLE_HUNTER,
  // ROGUE
  MOD_GRAPPLE,
  MOD_BLUEBLASTER,
}

// ---------------------------------------------------------------------------
// ammo_t / powerup_t (bg_local.h:79-130) -- see "SCOPE-MISMATCH NOTE" above
// ---------------------------------------------------------------------------

export enum AmmoT {
  AMMO_BULLETS,
  AMMO_SHELLS,
  AMMO_ROCKETS,
  AMMO_GRENADES,
  AMMO_CELLS,
  AMMO_SLUGS,
  // RAFAEL
  AMMO_MAGSLUG,
  AMMO_TRAP,
  // RAFAEL
  // ROGUE
  AMMO_FLECHETTES,
  AMMO_TESLA,
  AMMO_DISRUPTOR,
  AMMO_PROX,
  // ROGUE
  AMMO_MAX,
}

export enum PowerupT {
  POWERUP_SCREEN,
  POWERUP_SHIELD,

  POWERUP_AM_BOMB,

  POWERUP_QUAD,
  POWERUP_QUADFIRE,
  POWERUP_INVULNERABILITY,
  POWERUP_INVISIBILITY,
  POWERUP_SILENCER,
  POWERUP_REBREATHER,
  POWERUP_ENVIROSUIT,
  POWERUP_ADRENALINE,
  POWERUP_IR_GOGGLES,
  POWERUP_DOUBLE,
  POWERUP_SPHERE_VENGEANCE,
  POWERUP_SPHERE_HUNTER,
  POWERUP_SPHERE_DEFENDER,
  POWERUP_DOPPELGANGER,

  POWERUP_FLASHLIGHT,
  POWERUP_COMPASS,
  POWERUP_TECH1,
  POWERUP_TECH2,
  POWERUP_TECH3,
  POWERUP_TECH4,
  POWERUP_MAX,
}

// ---------------------------------------------------------------------------
// stuck_result_t / coop_respawn_t (bg_local.h:31-53) -- see "SCOPE-MISMATCH
// NOTE" above. `coop_respawn_t` is referenced by GClientT.coop_respawn_state.
// ---------------------------------------------------------------------------

export enum StuckResultT {
  GOOD_POSITION,
  FIXED,
  NO_GOOD_POSITION,
}

export enum CoopRespawnT {
  COOP_RESPAWN_NONE, // no message
  COOP_RESPAWN_IN_COMBAT, // player is in combat
  COOP_RESPAWN_BAD_AREA, // player not in a good spot
  COOP_RESPAWN_BLOCKED, // spawning was blocked by something
  COOP_RESPAWN_WAITING, // for players that are waiting to respawn
  COOP_RESPAWN_NO_LIVES, // out of lives, so need to wait until level switch
  COOP_RESPAWN_TOTAL,
}

// ---------------------------------------------------------------------------
// MAX_LEVELS_PER_UNIT / MAX_HEALTH_BARS (g_local.h:1097 / 1149)
// ---------------------------------------------------------------------------

export const MAX_LEVELS_PER_UNIT = 8;
export const MAX_HEALTH_BARS = 2;

// ---------------------------------------------------------------------------
// move_state_t (g_local.h:1322-1328)
// ---------------------------------------------------------------------------

export enum MoveStateT {
  STATE_TOP,
  STATE_BOTTOM,
  STATE_UP,
  STATE_DOWN,
}

// ---------------------------------------------------------------------------
// combat_style_t (g_local.h:1580-1586)
// ---------------------------------------------------------------------------

export enum CombatStyleT {
  COMBAT_UNKNOWN, // automatically choose based on attack functions
  COMBAT_MELEE, // should attempt to get up close for melee
  COMBAT_MIXED, // has mixed melee/ranged; runs to get up close if far enough away
  COMBAT_RANGED, // don't bother pathing if we can see the player
}

export const MAX_REINFORCEMENTS = 5; // max number of spawns we can do at once.

/** g_local.h:1603: `constexpr gtime_t HOLD_FOREVER =
 *  gtime_t::from_ms(std::numeric_limits<int64_t>::max());`. `GTime` is a
 *  branded JS `number`, not `bigint` (see gtime.ts's own deviations note),
 *  so the true C++ `int64_t` max (9223372036854775807) is not representable
 *  exactly; `Number.MAX_SAFE_INTEGER` (2^53-1, ~285,616 years of
 *  millisecond ticks) is used instead as an equally "effectively forever"
 *  sentinel -- see gtime.ts's own justification for never needing more
 *  precision than that anywhere in this port. */
export const HOLD_FOREVER: GTime = Gtime_from_ms(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// anim_priority_t (g_local.h:2657-2670) -- bitflags, default int32 -> number
// ---------------------------------------------------------------------------

export const AnimPriorityT = {
  ANIM_BASIC: 0, // stand / run
  ANIM_WAVE: 1,
  ANIM_JUMP: 2,
  ANIM_PAIN: 3,
  ANIM_ATTACK: 4,
  ANIM_DEATH: 5,

  // flags
  ANIM_REVERSED: bit(8),
} as const;
export type AnimPriorityT = number;

export const SELECTED_ITEM_TIME: GTime = Gtime_from_ms(3000); // 3_sec

// ---------------------------------------------------------------------------
// bmodel_animstyle_t (g_local.h:2689-2694)
// ---------------------------------------------------------------------------

export enum BmodelAnimstyleT {
  BMODEL_ANIM_FORWARDS,
  BMODEL_ANIM_BACKWARDS,
  BMODEL_ANIM_RANDOM,
}

export const AUTO_SHIELD_MANUAL = -1; // never turn back shield on automatically; legacy behavior.
export const AUTO_SHIELD_AUTO = 0; // shield turns back on once we have this many cells, if possible.

export const INVISIBILITY_TIME: GTime = Gtime_from_ms(2000); // [Paril-KEX] 2_sec
export const LADDER_SOUND_TIME: GTime = Gtime_from_ms(300); // 300_ms
export const COOP_DAMAGE_RESPAWN_TIME: GTime = Gtime_from_ms(2000);
export const COOP_DAMAGE_FIRING_TIME: GTime = Gtime_from_ms(2500);

// ---------------------------------------------------------------------------
// plat2flags_t (g_local.h:3014-3022) -- bitflags, default int32 -> number
// ---------------------------------------------------------------------------

export const Plat2flagsT = {
  PLAT2_NONE: 0,
  PLAT2_CALLED: 1,
  PLAT2_MOVING: 2,
  PLAT2_WAITING: 4,
} as const;
export type Plat2flagsT = number;

// ---------------------------------------------------------------------------
// item / monster / laser / train / fixbot spawnflags (g_local.h:1993-2261,
// 2635, 2107, 2164-2170, 2216-2218, 2250-2261, 2275-2277, 2390-2393)
// ---------------------------------------------------------------------------

export const SPAWNFLAG_ITEM_TRIGGER_SPAWN: SpawnFlags = SpawnFlags_from(0x00000001);
export const SPAWNFLAG_ITEM_NO_TOUCH: SpawnFlags = SpawnFlags_from(0x00000002);
export const SPAWNFLAG_ITEM_TOSS_SPAWN: SpawnFlags = SpawnFlags_from(0x00000004);
export const SPAWNFLAG_ITEM_MAX: SpawnFlags = SpawnFlags_from(0x00000008);
// 8 bits reserved for editor flags & power cube bits (see SPAWNFLAG_NOT_EASY above)
export const SPAWNFLAG_ITEM_DROPPED: SpawnFlags = SpawnFlags_from(0x00010000);
export const SPAWNFLAG_ITEM_DROPPED_PLAYER: SpawnFlags = SpawnFlags_from(0x00020000);
export const SPAWNFLAG_ITEM_TARGETS_USED: SpawnFlags = SpawnFlags_from(0x00040000);

export const SPAWNFLAG_LASER_ON: SpawnFlags = SpawnFlags_from(0x0001);
export const SPAWNFLAG_LASER_RED: SpawnFlags = SpawnFlags_from(0x0002);
export const SPAWNFLAG_LASER_GREEN: SpawnFlags = SpawnFlags_from(0x0004);
export const SPAWNFLAG_LASER_BLUE: SpawnFlags = SpawnFlags_from(0x0008);
export const SPAWNFLAG_LASER_YELLOW: SpawnFlags = SpawnFlags_from(0x0010);
export const SPAWNFLAG_LASER_ORANGE: SpawnFlags = SpawnFlags_from(0x0020);
export const SPAWNFLAG_LASER_FAT: SpawnFlags = SpawnFlags_from(0x0040);
export const SPAWNFLAG_LASER_ZAP: SpawnFlags = SpawnFlags_from(0x80000000);
export const SPAWNFLAG_LASER_LIGHTNING: SpawnFlags = SpawnFlags_from(0x10000);

export const SPAWNFLAG_HEALTHBAR_PVS_ONLY: SpawnFlags = SpawnFlags_from(1);

export const DEFAULT_BULLET_HSPREAD = 300;
export const DEFAULT_BULLET_VSPREAD = 500;
export const DEFAULT_SHOTGUN_HSPREAD = 1000;
export const DEFAULT_SHOTGUN_VSPREAD = 500;
export const DEFAULT_DEATHMATCH_SHOTGUN_COUNT = 12;
export const DEFAULT_SHOTGUN_COUNT = 12;
export const DEFAULT_SSHOTGUN_COUNT = 20;

export const SPAWNFLAG_TRAIN_START_ON: SpawnFlags = SpawnFlags_from(1);
export const SPAWNFLAG_WATER_SMART: SpawnFlags = SpawnFlags_from(2);
export const SPAWNFLAG_TRAIN_MOVE_TEAMCHAIN: SpawnFlags = SpawnFlags_from(8);
export const SPAWNFLAG_DOOR_REVERSE: SpawnFlags = SpawnFlags_from(2);

export const HACKFLAG_ATTACK_PLAYER = 1; // Paril: used in N64. causes them to be mad at the player regardless of circumstance.
export const HACKFLAG_END_CUTSCENE = 4; // used in N64, appears to change their behavior for the end scene.

export const SPAWNFLAG_MONSTER_AMBUSH: SpawnFlags = SpawnFlags_from(1);
export const SPAWNFLAG_MONSTER_TRIGGER_SPAWN: SpawnFlags = SpawnFlags_from(2);
export const SPAWNFLAG_MONSTER_DEAD: SpawnFlags = SpawnFlags_from(1 << 16);
export const SPAWNFLAG_MONSTER_SUPER_STEP: SpawnFlags = SpawnFlags_from(1 << 17);
export const SPAWNFLAG_MONSTER_NO_DROP: SpawnFlags = SpawnFlags_from(1 << 18);
export const SPAWNFLAG_MONSTER_SCENIC: SpawnFlags = SpawnFlags_from(1 << 19);

export const SPAWNFLAG_FIXBOT_FIXIT: SpawnFlags = SpawnFlags_from(4);
export const SPAWNFLAG_FIXBOT_TAKEOFF: SpawnFlags = SpawnFlags_from(8);
export const SPAWNFLAG_FIXBOT_LANDING: SpawnFlags = SpawnFlags_from(16);
export const SPAWNFLAG_FIXBOT_WORKING: SpawnFlags = SpawnFlags_from(32);

export const SPAWNFLAG_PATH_CORNER_TELEPORT: SpawnFlags = SpawnFlags_from(1);
export const SPAWNFLAG_POINT_COMBAT_HOLD: SpawnFlags = SpawnFlags_from(1);

export const CLOCK_MESSAGE_SIZE = 9; // " 0:00:00" plus null terminator

// ---------------------------------------------------------------------------
// g_ai.c range constants (g_local.h:2296-2298) -- see file header
// "RANGE_MELEE/NEAR/MID" note
// ---------------------------------------------------------------------------

export const RANGE_MELEE = 20; // bboxes basically touching
export const RANGE_NEAR = 440;
export const RANGE_MID = 940;

export const SPAWNFLAG_CHANGELEVEL_CLEAR_INVENTORY: SpawnFlags = SpawnFlags_from(8);
export const SPAWNFLAG_CHANGELEVEL_NO_END_OF_UNIT: SpawnFlags = SpawnFlags_from(16);
export const SPAWNFLAG_CHANGELEVEL_FADE_OUT: SpawnFlags = SpawnFlags_from(32);
export const SPAWNFLAG_CHANGELEVEL_IMMEDIATE_LEAVE: SpawnFlags = SpawnFlags_from(64);

export const SPAWNFLAG_LANDMARK_KEEP_Z: SpawnFlags = SpawnFlags_from(1);

export const GRENADE_TIMER: GTime = Gtime_from_ms(3000); // 3_sec
export const GRENADE_MINSPEED = 400.0;
export const GRENADE_MAXSPEED = 800.0;

// ---------------------------------------------------------------------------
// damageflags_t (g_local.h:2110-2127) -- bitflags, default int32 -> number
// ---------------------------------------------------------------------------

export const DamageflagsT = {
  DAMAGE_NONE: 0, // no damage flags
  DAMAGE_RADIUS: 0x00000001, // damage was indirect
  DAMAGE_NO_ARMOR: 0x00000002, // armour does not protect from this damage
  DAMAGE_ENERGY: 0x00000004, // damage is from an energy based weapon
  DAMAGE_NO_KNOCKBACK: 0x00000008, // do not affect velocity, just view angles
  DAMAGE_BULLET: 0x00000010, // damage is from a bullet (used for ricochets)
  DAMAGE_NO_PROTECTION: 0x00000020, // armor, shields, invulnerability, and godmode have no effect
  // ROGUE
  DAMAGE_DESTROY_ARMOR: 0x00000040, // damage is done to armor and health.
  DAMAGE_NO_REG_ARMOR: 0x00000080, // damage skips regular armor
  DAMAGE_NO_POWER_ARMOR: 0x00000100, // damage skips power armor
  // ROGUE
  DAMAGE_NO_INDICATOR: 0x00000200, // for clients: no damage indicators
} as const;
export type DamageflagsT = number;

// ---------------------------------------------------------------------------
// blocked_jump_result_t (g_local.h:2546-2552) -- `enum class`
// ---------------------------------------------------------------------------

export enum BlockedJumpResultT {
  NO_JUMP,
  JUMP_TURN,
  JUMP_JUMP_UP,
  JUMP_JUMP_DOWN,
}

// ---------------------------------------------------------------------------
// SPHERE_* spawnflags (g_local.h:3242-3248)
// ---------------------------------------------------------------------------

export const SPHERE_DEFENDER: SpawnFlags = SpawnFlags_from(0x0001);
export const SPHERE_HUNTER: SpawnFlags = SpawnFlags_from(0x0002);
export const SPHERE_VENGEANCE: SpawnFlags = SpawnFlags_from(0x0004);
export const SPHERE_DOPPLEGANGER: SpawnFlags = SpawnFlags_from(0x10000);

export const SPHERE_TYPE: SpawnFlags = SpawnFlags_or(SpawnFlags_or(SPHERE_DEFENDER, SPHERE_HUNTER), SPHERE_VENGEANCE);
export const SPHERE_FLAGS: SpawnFlags = SPHERE_DOPPLEGANGER;

// ---------------------------------------------------------------------------
// deathmatch game rules (g_local.h:3253-3257) -- unnamed C enum
// ---------------------------------------------------------------------------

export const RDM_TAG = 2;
export const RDM_DEATHBALL = 3;

// ---------------------------------------------------------------------------
// pois_t (g_local.h:3552-3559) -- uint16_t; offsets from MAX_EDICTS, not
// sequential from zero, so ported as plain computed consts (matching
// kexapi/game.ts's CS_* configstring-offset convention) rather than a plain
// TS enum.
// ---------------------------------------------------------------------------

export const POI_OBJECTIVE = MAX_EDICTS; // current objective
export const POI_RED_FLAG = POI_OBJECTIVE + 1; // red flag/carrier
export const POI_BLUE_FLAG = POI_RED_FLAG + 1; // blue flag/carrier
export const POI_PING = POI_BLUE_FLAG + 1;
export const POI_PING_END = POI_PING + MAX_CLIENTS - 1;

// ---------------------------------------------------------------------------
// random_time (g_local.h:1806-1815) -- the one member of the frandom/
// crandom/irandom/brandom family q_std.ts's own scope note left unported,
// now that GTime exists to type it with.
// ---------------------------------------------------------------------------
// NOTE: despite the C++ doc comments reading "uniform time [min_inclusive,
// max_exclusive)", the actual implementation
// (`std::uniform_int_distribution<int64_t>(min.ms(), max.ms())`) is
// INCLUSIVE on both ends -- `std::uniform_int_distribution`'s two
// constructor arguments are always `[a, b]` inclusive, unlike
// `irandom(min, max)` elsewhere in this family, which is genuinely
// half-open. Ported bug-for-bug (inclusive-inclusive) to match the real
// behavior, not the misleading comment.

/** g_local.h: `random_time(min_inclusive, max_exclusive)` (actually
 *  inclusive-inclusive -- see note above) and the single-argument
 *  `random_time(max_exclusive)` overload (implicit `min_inclusive = 0`). */
export function random_time(a: GTime, b?: GTime): GTime {
  const minMs = b === undefined ? 0 : Gtime_ms(a);
  const maxMs = b === undefined ? Gtime_ms(a) : Gtime_ms(b);
  return Gtime_from_ms(minMs + irandom(maxMs - minMs + 1));
}

function Gtime_ms(t: GTime): number {
  return t;
}

// ---------------------------------------------------------------------------
// DUCK_INTERVAL (g_local.h:1774) -- ROGUE
// ---------------------------------------------------------------------------

/** this determines how long to wait after a duck to duck again; if we
 *  finish a duck-up, this gets cut in half. */
export const DUCK_INTERVAL: GTime = Gtime_from_ms(5000);
