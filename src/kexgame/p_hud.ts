// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_hud.c -- intermission / HUD stats / scoreboard / help computer (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/p_hud.cpp (1,134 lines, C++17):
// MoveClientToIntermission/BeginIntermission, G_EndOfUnitMessage,
// G_ReportMatchDetails, DeathmatchScoreboardMessage/DeathmatchScoreboard,
// Cmd_Score_f/Cmd_Help_f/HelpComputer, G_SetStats (incl. the KEX wheel/stat
// layout), G_SetCoopStats, G_CheckChaseStats, G_SetSpectatorStats.
//
// ============================================================================
// STAT-LAYOUT FINDINGS (per brief: "which STAT_* slots the KEX source uses
// vs legacy")
// ============================================================================
// bg_local.h:196-263 declares `enum player_stat_t` -- NOT ported anywhere in
// this port line before this unit (grepped src/kexapi/ and src/kexgame/ for
// `player_stat_t`/`PlayerStatT`: zero matches; g_statusbar.ts's own header
// already recorded this exact gap and deliberately left the enum uninvented,
// per PORTING.md's "the brief's placement wins, report the mismatch, don't
// move it"). Placed here (`PlayerStatT`, exported) since G_SetStats is this
// enum's primary real consumer and this is the first unit that needs it for
// real; p_view.ts imports the two members it needs (STAT_FLASHES) from here.
// A future unit that also needs it should import from here rather than
// re-inventing it a third time; bg_local.ts remains the more "correct" C
// header home if a future pass wants to relocate it (out of this unit's file
// scope: p_view.ts/p_hud.ts/the test file only).
//
// DIFFS from the legacy/vanilla port's `q_shared.ts` stat layout (32 slots,
// STAT_LAYOUTS at a different index, no wheel/key/coop-respawn/hit-marker/
// health-bar slots at all):
//   - KEX widens the table to MAX_STATS=64 (legacy: 32) and inserts an
//     entire CTF stat block (STAT_CTF_TEAM1_PIC..STAT_CTF_TEAMINFO, 18-31)
//     BETWEEN STAT_SPECTATOR (17) and the weapon-wheel block -- the legacy
//     table has no such gap; CTF's own layout there is a totally different,
//     ctf.c-owned overlay on top of the SAME 32 slots.
//   - KEX adds, past the CTF block: STAT_WEAPONS_OWNED_1/2 (weapon-wheel
//     bitmask, 32/33), a compressed multi-slot AMMO_INFO run (34..40, width
//     computed from `NUM_AMMO_STATS`), a compressed POWERUP_INFO run
//     (41..43, width from `NUM_POWERUP_STATS`), STAT_KEY_A/B/C (44-46),
//     STAT_ACTIVE_WHEEL_WEAPON (47), STAT_COOP_RESPAWN (48), STAT_LIVES
//     (49), STAT_HIT_MARKER (50), STAT_SELECTED_ITEM_NAME (51),
//     STAT_HEALTH_BARS (52), STAT_ACTIVE_WEAPON (53) -- all [Paril-KEX]
//     additions with no legacy-port equivalent index at all.
//   - `NUM_AMMO_STATS`/`NUM_POWERUP_STATS` are themselves computed, not
//     literals: `num_of_type_for_bits<uint16_t>(bits_per_value * COUNT)`,
//     packing `AMMO_MAX` (12) ammo types at 9 bits each and `POWERUP_MAX`
//     (23) powerup types at 2 bits each into as few `int16_t` stat slots as
//     possible via `set_compressed_integer`/`get_compressed_integer` (a
//     byte-addressed bitfield write that can straddle two adjacent stat
//     slots' bytes). Ported below as `G_SetAmmoStat`/`G_GetAmmoStat`/
//     `G_SetPowerupStat`/`G_GetPowerupStat` using a `DataView` over
//     `ps.stats`'s backing buffer at the stat-index byte offset -- the
//     natural TS translation of "reinterpret a `uint16_t*` at a byte
//     offset as another `uint16_t*`" (`AmmoT`/`PowerupT`'s `AMMO_MAX`/
//     `POWERUP_MAX` sentinels, already ported in g_local.ts, drive the
//     computation instead of hand-copied magic numbers, so this stays
//     correct if either enum ever grows).
//
// ============================================================================
// DROPPED (real values intentionally left zero -- see each site's own
// comment for the exact citation; PORTING.md: "a function you cannot port
// faithfully is a reported deviation, not a TODO")
// ============================================================================
//   - G_SetStats's weapon-wheel bitmask (STAT_WEAPONS_OWNED_1/2), the
//     AMMO_INFO wheel-fill loop, the POWERUP_INFO wheel-fill loop, and
//     STAT_ACTIVE_WHEEL_WEAPON/STAT_ACTIVE_WEAPON's `weapon_wheel_index`
//     reads: all resolve items via `GetItemByIndex`/`GetItemByAmmo`/
//     `GetItemByPowerup` against the GLOBAL `itemlist[]` (g_items.cpp,
//     genuinely not ported anywhere in src/kexgame/ -- confirmed by
//     grepping the whole tree) AND run UNCONDITIONALLY on every
//     G_SetStats call (no cvar/flag guards at all), so per g_combat.ts's
//     own "an unconditionally-reached unported dep can't be a throwing
//     stub" rule, these are left at the exact zero/`-1` value the C
//     source's own `memset`/no-op-default state already produces before
//     attempting to fill them, cited here rather than guessed at -- same
//     shape as g_combat.ts's own dropped `STAT_HIT_MARKER` write.
//   - STAT_SELECTED_ICON / STAT_KEY_A/B/C: also `itemlist[]`-dependent
//     (icon lookup by id / an `IF_KEY`-flag scan over the whole itemlist)
//     and reached whenever `pers.selected_item !== IT_NULL` / always (key
//     display isn't cvar-guarded, only deathmatch-gated) -- dropped to 0
//     for the same reason.
//   - `SetCTFStats`'s tech-icon loop and its `if (ctf->integer) {...}`
//     team-logo block: see the STUB INVENTORY section below.
//
// ============================================================================
// STUB INVENTORY (throw, cited; each one's guard is documented at its own
// call site)
// ============================================================================
//   - STAT_AMMO_ICON / STAT_ARMOR_ICON's plain (non-wheel, non-power-armor)
//     icon resolution: `GetItemByIndex(id).icon` -- reached only when a real
//     weapon/ammo/armor item is actually held (this unit's own test suite
//     exercises the power-armor-flash and no-armor/no-weapon branches
//     instead, which are itemlist-free -- see the test file for citations).
//   - SetCTFStats's tech-icon loop: reached only if a `tech_ids` item is
//     actually held (default inventory is always zero).
//   - SetCTFStats's `if (ctf->integer) {...}` team-logo block: reached only
//     with the `ctf` cvar enabled (default 0).
//   - DeathmatchScoreboardMessage/G_ReportMatchDetails's
//     `CTFScoreboardMessage`/`CTFCalcRankings` branches: reached only when
//     `G_TeamplayEnabled()` is true (default: both `ctf`/`teamplay` cvars 0).
//   - BeginIntermission's `if (ctf->integer) CTFCalcScores();`: same guard.
//   - BeginIntermission's coop key-stripping itemlist scan
//     (`for (n : IT_TOTAL) if (itemlist[n].flags & IF_KEY) ...`): reached
//     only in `coop` with a `*`-suffixed changemap (unit-transition maps);
//     itemlist-dependent, same reasoning as the STAT_KEY_A/B/C drop above.
//   - BeginIntermission's `respawn(client)` (p_client.cpp:1621) /
//     `P_UseCoopInstancedItems()` (p_client.cpp:90): STUB SWAP -- both are
//     now real imports from src/kexgame/p_client.ts (their genuine C++ home,
//     landed after this unit). This closes a real, sanctioned import cycle
//     with p_client.ts (which imports Cmd_Help_f/MoveClientToIntermission/
//     PlayerTrail_Destroy from THIS file) -- same shape and safety argument
//     as this file's own "IMPORT CYCLE: p_view.ts <-> p_hud.ts" precedent
//     below (both imports used only inside function bodies, never at
//     module-eval time). Reached only when respawning a DEAD client at
//     intermission -- this unit's own test fixtures keep clients alive to
//     exercise the rest of the function, so neither import is exercised by
//     this file's own test suite even now that it's real.
//
// ============================================================================
// REAL despite living in another not-yet-landed C++ file (same
// "self-contained, port it here" precedent g_combat.ts set for
// ArmorIndex/PowerArmorType, applied throughout this port line since)
// ============================================================================
//   - PlayerTrail_Destroy (p_trail.cpp:65-75): pure `g_edicts`/`classname`/
//     `G_FreeEdict` scan; no `player_trail`-classname entity is ever
//     spawned anywhere in this port line yet (`PlayerTrail_Add`/`_Spawn`,
//     p_trail.cpp, not ported), so the free-branch is unreachable today but
//     ported for real rather than assumed away.
//   - G_CheckInfiniteAmmo (p_weapon.cpp:25-31): pure cvar + item-flags read.
//
// ============================================================================
// IMPORT CYCLE: p_view.ts <-> p_hud.ts (real, sanctioned -- see g_utils.ts's/
// g_phys.ts's identical precedent comment for the general rule)
// ============================================================================
// p_view.ts imports `PlayerStatT`/`G_SetStats`/`G_SetCoopStats`/
// `G_SetSpectatorStats`/`G_CheckChaseStats`/`DeathmatchScoreboardMessage`
// from this file (ClientEndServerFrame's own call sites, straight off the
// C source); this file imports `G_TeamplayEnabled` back from p_view.ts
// (ported there per that file's own header, since `SkipViewModifiers` needs
// it too). Both imports are used only inside function bodies, never at
// module-eval time, so the live-binding cycle never observes a
// not-yet-initialized value -- safe per PORTING.md's cycle rule.

import { type Vec3, vec3, VectorCopy } from "../shared/math";
import {
  CS_GENERAL,
  CS_PLAYERSKINS,
  ContentsT,
  CvarFlagsT,
  EffectsT,
  KexEntityEventT,
  KexMulticastT,
  KexPmTypeT,
  MAX_CLIENTS,
  MAX_GENERAL,
  PmflagsT,
  RefdefFlagsT,
  RenderfxT,
  ServerCommandT,
  ServerFlagsT,
  SolidT,
} from "../kexapi/game";
import {
  AmmoT,
  CoopRespawnT,
  CtfteamT,
  type EdictT,
  type GClientT,
  type GitemT,
  HandednessT,
  ItemFlagsT,
  ItemIdT,
  MAX_HEALTH_BARS,
  MAX_LEVELS_PER_UNIT,
  MonsterAiFlagsT,
  MovetypeT,
  PowerupT,
  SPAWNFLAG_CHANGELEVEL_CLEAR_INVENTORY,
  SPAWNFLAG_CHANGELEVEL_FADE_OUT,
  SPAWNFLAG_CHANGELEVEL_IMMEDIATE_LEAVE,
  SPAWNFLAG_CHANGELEVEL_NO_END_OF_UNIT,
  SPAWNFLAG_HEALTHBAR_PVS_ONLY,
  SPHERE_DEFENDER,
  SPHERE_HUNTER,
  SPHERE_VENGEANCE,
} from "./g_local";
import { gi, g_edicts, game, globals, level } from "./g_main_globals";
import {
  type GTime,
  Gtime_add,
  Gtime_frames,
  Gtime_from_min,
  Gtime_from_ms,
  Gtime_from_sec,
  Gtime_milliseconds,
  Gtime_minutesInt,
  Gtime_nonzero,
  Gtime_seconds,
  Gtime_subtract,
  GTIME_ZERO,
} from "./gtime";
import { G_FindByString, G_FreeEdict } from "./g_utils";
import { irandom } from "./q_std";
import { SpawnFlags_has } from "./spawnflags";
import { ArmorIndex, PowerArmorType } from "./g_combat";
import { G_TeamplayEnabled } from "./p_view";
import { respawn, P_UseCoopInstancedItems } from "./p_client";

// bg_local.h's `LAYOUTS_*` bit flags live in game.h (kexapi/game.ts) as
// `LayoutFlagsT`, not bg_local.h itself.
import { LayoutFlagsT } from "../kexapi/game";

// ---------------------------------------------------------------------------
// cvar-read helpers (see g_combat.ts's own precedent for this exact idiom)
// ---------------------------------------------------------------------------

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  return Math.trunc(cvarFloat(name, def, flags));
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarInt(name, def, flags) !== 0;
}

// ---------------------------------------------------------------------------
// player_stat_t (bg_local.h:196-263) -- see file header "STAT-LAYOUT FINDINGS"
// ---------------------------------------------------------------------------

/** bg_local.h:150-157: `num_of_type_for_bits<TI>(num_bits)`, specialized to
 *  `uint16_t` (the only instantiation this header uses). */
function numOfUint16ForBits(numBits: number): number {
  const bitsPerElement = 16;
  return Math.trunc((numBits + bitsPerElement - 1) / (bitsPerElement + 1));
}

/** bg_local.h:144: `constexpr size_t NUM_BITS_FOR_AMMO = 9;` */
const NUM_BITS_FOR_AMMO = 9;
/** bg_local.h:145: `constexpr size_t NUM_AMMO_STATS = num_of_type_for_bits<uint16_t>(NUM_BITS_FOR_AMMO * AMMO_MAX);` */
export const NUM_AMMO_STATS = numOfUint16ForBits(NUM_BITS_FOR_AMMO * AmmoT.AMMO_MAX);
/** bg_local.h:146-147: `constexpr uint16_t AMMO_VALUE_INFINITE = bit_v<NUM_BITS_FOR_AMMO> - 1;` */
export const AMMO_VALUE_INFINITE = (1 << NUM_BITS_FOR_AMMO) - 1;

/** bg_local.h:180: `constexpr size_t NUM_BITS_PER_POWERUP = 2;` */
const NUM_BITS_PER_POWERUP = 2;
/** bg_local.h:181: `constexpr size_t NUM_POWERUP_STATS = num_of_type_for_bits<uint16_t>(NUM_BITS_PER_POWERUP * POWERUP_MAX);` */
export const NUM_POWERUP_STATS = numOfUint16ForBits(NUM_BITS_PER_POWERUP * PowerupT.POWERUP_MAX);

/** bg_local.h:196-263: `enum player_stat_t`. See file header. */
export enum PlayerStatT {
  STAT_HEALTH_ICON = 0,
  STAT_HEALTH = 1,
  STAT_AMMO_ICON = 2,
  STAT_AMMO = 3,
  STAT_ARMOR_ICON = 4,
  STAT_ARMOR = 5,
  STAT_SELECTED_ICON = 6,
  STAT_PICKUP_ICON = 7,
  STAT_PICKUP_STRING = 8,
  STAT_TIMER_ICON = 9,
  STAT_TIMER = 10,
  STAT_HELPICON = 11,
  STAT_SELECTED_ITEM = 12,
  STAT_LAYOUTS = 13,
  STAT_FRAGS = 14,
  STAT_FLASHES = 15, // cleared each frame, 1 = health, 2 = armor
  STAT_CHASE = 16,
  STAT_SPECTATOR = 17,

  STAT_CTF_TEAM1_PIC = 18,
  STAT_CTF_TEAM1_CAPS = 19,
  STAT_CTF_TEAM2_PIC = 20,
  STAT_CTF_TEAM2_CAPS = 21,
  STAT_CTF_FLAG_PIC = 22,
  STAT_CTF_JOINED_TEAM1_PIC = 23,
  STAT_CTF_JOINED_TEAM2_PIC = 24,
  STAT_CTF_TEAM1_HEADER = 25,
  STAT_CTF_TEAM2_HEADER = 26,
  STAT_CTF_TECH = 27,
  STAT_CTF_ID_VIEW = 28,
  STAT_CTF_MATCH = 29,
  STAT_CTF_ID_VIEW_COLOR = 30,
  STAT_CTF_TEAMINFO = 31,

  // [Kex] More stats for weapon wheel
  STAT_WEAPONS_OWNED_1 = 32,
  STAT_WEAPONS_OWNED_2 = 33,
  STAT_AMMO_INFO_START = 34,
  // computed offsets below (TS enums can't reference sibling computed
  // constants inside the enum body the way C++'s `constexpr` can; assigned
  // after the enum instead, see STAT_LAST assertion below).
  STAT_KEY_A = 44,
  STAT_KEY_B = 45,
  STAT_KEY_C = 46,

  // [Paril-KEX] currently active wheel weapon (or one we're switching to)
  STAT_ACTIVE_WHEEL_WEAPON = 47,
  // [Paril-KEX] top of screen coop respawn state
  STAT_COOP_RESPAWN = 48,
  // [Paril-KEX] respawns remaining
  STAT_LIVES = 49,
  // [Paril-KEX] hit marker; # of damage we successfully landed
  STAT_HIT_MARKER = 50,
  // [Paril-KEX]
  STAT_SELECTED_ITEM_NAME = 51,
  // [Paril-KEX]
  STAT_HEALTH_BARS = 52, // two health bar values; 7 bits for value, 1 bit for active
  // [Paril-KEX]
  STAT_ACTIVE_WEAPON = 53,

  STAT_LAST = 54,
}

// bg_local.h:216-219: `STAT_AMMO_INFO_END = STAT_AMMO_INFO_START + NUM_AMMO_STATS - 1;
//  STAT_POWERUP_INFO_START; STAT_POWERUP_INFO_END = STAT_POWERUP_INFO_START + NUM_POWERUP_STATS - 1;`
// -- computed here (not enum members) since NUM_AMMO_STATS/NUM_POWERUP_STATS
// are runtime `const`s, not enum-body-visible compile-time literals in TS.
export const STAT_AMMO_INFO_END = PlayerStatT.STAT_AMMO_INFO_START + NUM_AMMO_STATS - 1;
export const STAT_POWERUP_INFO_START = STAT_AMMO_INFO_END + 1;
export const STAT_POWERUP_INFO_END = STAT_POWERUP_INFO_START + NUM_POWERUP_STATS - 1;

// bg_local.h:264: `static_assert(STAT_LAST <= MAX_STATS + 1, "stats list overflow");`
// -- STAT_KEY_A(44) must equal STAT_POWERUP_INFO_END + 1 for the hand-placed
// enum literals above to match the C source's actually-computed offsets;
// this assertion catches AMMO_MAX/POWERUP_MAX drift at import time instead
// of silently mis-laying out the stats array.
if (STAT_POWERUP_INFO_END + 1 !== PlayerStatT.STAT_KEY_A) {
  throw new Error(
    `p_hud.ts: PlayerStatT layout drift -- STAT_POWERUP_INFO_END+1 (${STAT_POWERUP_INFO_END + 1}) !== STAT_KEY_A (${PlayerStatT.STAT_KEY_A}); AMMO_MAX/POWERUP_MAX changed without updating the hand-placed enum literals`,
  );
}

// ---------------------------------------------------------------------------
// G_SetAmmoStat / G_GetAmmoStat / G_SetPowerupStat / G_GetPowerupStat
// (bg_local.h:156-193) -- see file header "STAT-LAYOUT FINDINGS"
// ---------------------------------------------------------------------------

/** bg_local.h:139-142/159-172: `set_compressed_integer<bits_per_value>(uint16_t *start, uint8_t id, uint16_t count)`. */
function setCompressedInteger(stats: Int16Array, startIndex: number, bitsPerValue: number, id: number, count: number): void {
  const view = new DataView(stats.buffer, stats.byteOffset + startIndex * 2, (stats.length - startIndex) * 2);
  const bitOffset = bitsPerValue * id;
  const byteOffset = bitOffset >> 3;
  const bitShift = bitOffset & 7;
  const mask = ((1 << bitsPerValue) - 1) << bitShift;
  const cur = view.getUint16(byteOffset, true);
  const next = (cur & ~mask) | ((count << bitShift) & mask);
  view.setUint16(byteOffset, next & 0xffff, true);
}

/** bg_local.h:139-142/174-181: `get_compressed_integer<bits_per_value>(uint16_t *start, uint8_t id)`. */
function getCompressedInteger(stats: Int16Array, startIndex: number, bitsPerValue: number, id: number): number {
  const view = new DataView(stats.buffer, stats.byteOffset + startIndex * 2, (stats.length - startIndex) * 2);
  const bitOffset = bitsPerValue * id;
  const byteOffset = bitOffset >> 3;
  const bitShift = bitOffset & 7;
  const mask = ((1 << bitsPerValue) - 1) << bitShift;
  const cur = view.getUint16(byteOffset, true);
  return (cur & mask) >>> bitShift;
}

/**
 * bg_local.h:159-163: `constexpr void G_SetAmmoStat(uint16_t *start, uint8_t ammo_id, uint16_t count)`.
 * `start` (a raw pointer into `ps.stats`) becomes `(stats, startIndex)`: the
 * backing `Int16Array` plus the stat index `start` pointed at
 * (`STAT_AMMO_INFO_START` at every real call site).
 */
export function G_SetAmmoStat(stats: Int16Array, startIndex: number, ammoId: number, count: number): void {
  setCompressedInteger(stats, startIndex, NUM_BITS_FOR_AMMO, ammoId, count);
}

/** bg_local.h:165-168: `constexpr uint16_t G_GetAmmoStat(uint16_t *start, uint8_t ammo_id)`. */
export function G_GetAmmoStat(stats: Int16Array, startIndex: number, ammoId: number): number {
  return getCompressedInteger(stats, startIndex, NUM_BITS_FOR_AMMO, ammoId);
}

/** bg_local.h:187-190: `constexpr void G_SetPowerupStat(uint16_t *start, uint8_t powerup_id, uint16_t count)`. */
export function G_SetPowerupStat(stats: Int16Array, startIndex: number, powerupId: number, count: number): void {
  setCompressedInteger(stats, startIndex, NUM_BITS_PER_POWERUP, powerupId, count);
}

/** bg_local.h:192-195: `constexpr uint16_t G_GetPowerupStat(uint16_t *start, uint8_t powerup_id)`. */
export function G_GetPowerupStat(stats: Int16Array, startIndex: number, powerupId: number): number {
  return getCompressedInteger(stats, startIndex, NUM_BITS_PER_POWERUP, powerupId);
}

// ---------------------------------------------------------------------------
// reserved general CS ranges (bg_local.h:56-73)
// ---------------------------------------------------------------------------

const CONFIG_CTF_MATCH = CS_GENERAL;
const CONFIG_CTF_TEAMINFO = CONFIG_CTF_MATCH + 1;
const CONFIG_CTF_PLAYER_NAME = CONFIG_CTF_TEAMINFO + 1;
const CONFIG_CTF_PLAYER_NAME_END = CONFIG_CTF_PLAYER_NAME + MAX_CLIENTS;
const CONFIG_COOP_RESPAWN_STRING = CONFIG_CTF_PLAYER_NAME_END + 1;
// bg_local.h:45: `COOP_RESPAWN_TOTAL` sentinel -- g_local.ts's ported `CoopRespawnT` enum.
const CONFIG_COOP_RESPAWN_STRING_END = CONFIG_COOP_RESPAWN_STRING + (CoopRespawnT.COOP_RESPAWN_TOTAL - 1);
const CONFIG_N64_PHYSICS = CONFIG_COOP_RESPAWN_STRING_END + 1;
const CONFIG_HEALTH_BAR_NAME = CONFIG_N64_PHYSICS + 1;
const CONFIG_STORY = CONFIG_HEALTH_BAR_NAME + 1;
const CONFIG_LAST = CONFIG_STORY + 1;

if (CONFIG_LAST > CS_GENERAL + MAX_GENERAL) {
  throw new Error("p_hud.ts: CONFIG_LAST overflows MAX_GENERAL -- bg_local.h:73's static_assert would fail");
}

// ---------------------------------------------------------------------------
// G_CheckInfiniteAmmo -- ported here, not a stub (see file header)
// ---------------------------------------------------------------------------

/** p_weapon.cpp:25-31: `[Kex] bool G_CheckInfiniteAmmo(gitem_t *item)`. */
export function G_CheckInfiniteAmmo(item: GitemT): boolean {
  if ((item.flags & ItemFlagsT.IF_NO_INFINITE_AMMO) !== 0) return false;
  return cvarBool("g_infinite_ammo", "0", CvarFlagsT.CVAR_LATCH) || (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("g_instagib", "0", CvarFlagsT.CVAR_NOFLAGS));
}

// ---------------------------------------------------------------------------
// unported cross-deps (throwing stubs) -- see file header
// ---------------------------------------------------------------------------

function PMenu_Close(_ent: EdictT): void {
  throw new Error("PMenu_Close: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp)");
}

function CTFCalcScores(): void {
  throw new Error("CTFCalcScores: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:892)");
}

function CTFScoreboardMessage(_ent: EdictT, _killer: EdictT | null): void {
  throw new Error("CTFScoreboardMessage: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1611)");
}

function CTFCalcRankingsAndReport(_isEnd: boolean): void {
  throw new Error("CTFCalcRankings/gi.ReportMatchDetails_Multicast (team path): not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:907)");
}

function stripCoopKeys(): void {
  throw new Error("BeginIntermission coop key-strip: not yet ported -- itemlist IF_KEY scan needs g_items.ts (see p_hud.cpp:322-327)");
}

/** `GetItemByIndex(id)`: not yet ported (pending g_items.ts, see g_items.cpp).
 *  Returns the full `GitemT` (not just `.icon`) since callers also need
 *  `.flags` for `G_CheckInfiniteAmmo`. */
function resolveItem(_id: ItemIdT): GitemT {
  throw new Error("GetItemByIndex(...): not yet ported (pending g_items.ts, see g_items.cpp)");
}

function ctfTeamLogoStats(_ent: EdictT): void {
  throw new Error("SetCTFStats team-logo block: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1068-...)");
}

function ctfTechIcon(_id: ItemIdT): string {
  throw new Error("SetCTFStats tech-icon GetItemByIndex(...).icon: not yet ported (pending g_items.ts, see ctf/g_ctf.cpp:1054-1063)");
}

// ---------------------------------------------------------------------------
// activePlayers -- local copy (see p_view.ts's identical
// `activePlayers()`/g_ai.ts's `activePlayers()` precedent: each consuming
// file ports its own copy; this port line has no shared entity-iterable
// abstraction).
// ---------------------------------------------------------------------------

/** g_local.h:3426-3437 `active_players()`. */
function activePlayers(): EdictT[] {
  const out: EdictT[] = [];
  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (e !== undefined && e.inuse && e.client !== null && e.client.pers.connected) {
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// G_SetCoopStats
// ---------------------------------------------------------------------------

/** p_hud.cpp:694-706: `[Paril-KEX] void G_SetCoopStats(edict_t *ent)`. */
export function G_SetCoopStats(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("g_coop_enable_lives", "0", CvarFlagsT.CVAR_LATCH)) {
    client.ps.stats[PlayerStatT.STAT_LIVES] = client.pers.lives + 1;
  } else {
    client.ps.stats[PlayerStatT.STAT_LIVES] = 0;
  }

  // stat for text on what we're doing for respawn
  if (client.coop_respawn_state !== CoopRespawnT.COOP_RESPAWN_NONE) {
    client.ps.stats[PlayerStatT.STAT_COOP_RESPAWN] = CONFIG_COOP_RESPAWN_STRING + (client.coop_respawn_state - CoopRespawnT.COOP_RESPAWN_IN_COMBAT);
  } else {
    client.ps.stats[PlayerStatT.STAT_COOP_RESPAWN] = 0;
  }
}

// ---------------------------------------------------------------------------
// SetCTFStats -- real CTF-independent prefix, narrow stubs for the
// itemlist/ctf-cvar-gated tails (see file header)
// ---------------------------------------------------------------------------

/** ctf/g_ctf.cpp:98: `constexpr item_id_t tech_ids[] = { ... };` */
const TECH_IDS: readonly ItemIdT[] = [ItemIdT.IT_TECH_RESISTANCE, ItemIdT.IT_TECH_STRENGTH, ItemIdT.IT_TECH_HASTE, ItemIdT.IT_TECH_REGENERATION];

/** ctf/g_ctf.cpp:1006-1... : `void SetCTFStats(edict_t *ent)`. */
function SetCTFStats(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // `ctfgame.match`/`ctfgame.warnactive` -- CTF match-state global, never
  // populated anywhere in this port line (no g_ctf.ts unit has landed yet);
  // concrete default (MATCH_NONE / not warning), matching g_combat.ts's
  // CTFMatchSetup/DMGame "concrete faithful value, not a stub" precedent.
  client.ps.stats[PlayerStatT.STAT_CTF_MATCH] = 0;
  client.ps.stats[PlayerStatT.STAT_CTF_TEAMINFO] = 0;

  // ghosting
  if (client.resp.ghost !== null) {
    client.resp.ghost.score = client.resp.score;
    client.resp.ghost.netname = client.pers.netname;
    client.resp.ghost.number = ent.s.number;
  }

  // logo headers for the frag display -- `imageindex_ctfsb1/2` are CTF
  // module globals set by PrecacheItem (not ported); concrete default 0,
  // same reasoning as p_view.ts's `modelindex_flag1/2`.
  client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
  client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;

  const blink = Gtime_milliseconds(level.time) % 1000 < 500;

  // if during intermission, blink the team header of the winning team.
  // `ctfgame.team1/team2/total1/total2` are always 0 (see above), so this
  // always lands on the "tie game" branch (both headers 0) -- ported
  // faithfully rather than special-cased so a future g_ctf.ts landing that
  // starts populating `ctfgame` needs no changes here.
  if (Gtime_nonzero(level.intermissiontime) && blink) {
    const team1 = 0;
    const team2 = 0;
    const total1 = 0;
    const total2 = 0;
    if (team1 > team2) client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
    else if (team2 > team1) client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;
    else if (total1 > total2) client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
    else if (total2 > total1) client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;
    else {
      client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
      client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;
    }
  }

  // tech icon
  client.ps.stats[PlayerStatT.STAT_CTF_TECH] = 0;
  for (const techId of TECH_IDS) {
    if (client.pers.inventory[techId]) {
      client.ps.stats[PlayerStatT.STAT_CTF_TECH] = gi.imageindex(ctfTechIcon(techId)); // narrow stub, see file header
      break;
    }
  }

  if (cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH)) {
    ctfTeamLogoStats(ent); // narrow stub, see file header
  }
}

// ---------------------------------------------------------------------------
// G_SetStats -- see file header "STAT-LAYOUT FINDINGS" / "DROPPED" / "STUB
// INVENTORY" for exactly what's real vs dropped vs stubbed below
// ---------------------------------------------------------------------------

interface PowerupTableEntryT {
  item: ItemIdT;
  getTime: ((client: GClientT) => GTime) | null;
  getCount: ((client: GClientT) => number) | null;
}

/** p_hud.cpp:708-723: `powerup_info_t powerup_table[]`. */
const POWERUP_TABLE: readonly PowerupTableEntryT[] = [
  { item: ItemIdT.IT_ITEM_QUAD, getTime: (c) => c.quad_time, getCount: null },
  { item: ItemIdT.IT_ITEM_QUADFIRE, getTime: (c) => c.quadfire_time, getCount: null },
  { item: ItemIdT.IT_ITEM_DOUBLE, getTime: (c) => c.double_time, getCount: null },
  { item: ItemIdT.IT_ITEM_INVULNERABILITY, getTime: (c) => c.invincible_time, getCount: null },
  { item: ItemIdT.IT_ITEM_INVISIBILITY, getTime: (c) => c.invisible_time, getCount: null },
  { item: ItemIdT.IT_ITEM_ENVIROSUIT, getTime: (c) => c.enviro_time, getCount: null },
  { item: ItemIdT.IT_ITEM_REBREATHER, getTime: (c) => c.breather_time, getCount: null },
  { item: ItemIdT.IT_ITEM_IR_GOGGLES, getTime: (c) => c.ir_time, getCount: null },
  { item: ItemIdT.IT_ITEM_SILENCER, getTime: null, getCount: (c) => c.silencer_shots },
];

/** p_hud.cpp:730-1087: `void G_SetStats(edict_t *ent)`. */
export function G_SetStats(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  //
  // health
  //
  if ((ent.s.renderfx & RenderfxT.RF_USE_DISGUISE) !== 0) client.ps.stats[PlayerStatT.STAT_HEALTH_ICON] = level.disguise_icon;
  else client.ps.stats[PlayerStatT.STAT_HEALTH_ICON] = level.pic_health;
  client.ps.stats[PlayerStatT.STAT_HEALTH] = ent.health;

  //
  // weapons -- weapon-wheel bitmask/active-wheel-weapon: DROPPED (itemlist
  // `weapon_wheel_index`, see file header)
  //
  client.ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_1] = 0;
  client.ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_2] = 0;
  client.ps.stats[PlayerStatT.STAT_ACTIVE_WHEEL_WEAPON] = -1;
  client.ps.stats[PlayerStatT.STAT_ACTIVE_WEAPON] = -1;

  //
  // ammo
  //
  client.ps.stats[PlayerStatT.STAT_AMMO_ICON] = 0;
  client.ps.stats[PlayerStatT.STAT_AMMO] = 0;

  if (client.pers.weapon !== null && client.pers.weapon.ammo !== ItemIdT.IT_NULL) {
    const item = resolveItem(client.pers.weapon.ammo); // narrow stub, see file header
    if (!G_CheckInfiniteAmmo(item)) {
      client.ps.stats[PlayerStatT.STAT_AMMO_ICON] = gi.imageindex(item.icon ?? "");
      client.ps.stats[PlayerStatT.STAT_AMMO] = client.pers.inventory[client.pers.weapon.ammo];
    }
  }

  // ammo wheel fill: DROPPED (itemlist `GetItemByAmmo`, see file header) --
  // left at the zero state the C source's own `memset` produces.
  for (let i = PlayerStatT.STAT_AMMO_INFO_START; i <= STAT_AMMO_INFO_END; i++) client.ps.stats[i] = 0;

  //
  // armor
  //
  const power_armor_type = PowerArmorType(ent);
  let cells = 0;
  if (power_armor_type !== ItemIdT.IT_NULL) cells = client.pers.inventory[ItemIdT.IT_AMMO_CELLS];

  const index = ArmorIndex(ent);
  if (power_armor_type !== ItemIdT.IT_NULL && (index === ItemIdT.IT_NULL || Gtime_milliseconds(level.time) % 3000 < 1500)) {
    // flash between power armor and other armor icon
    client.ps.stats[PlayerStatT.STAT_ARMOR_ICON] = power_armor_type === ItemIdT.IT_ITEM_POWER_SHIELD ? gi.imageindex("i_powershield") : gi.imageindex("i_powerscreen");
    client.ps.stats[PlayerStatT.STAT_ARMOR] = cells;
  } else if (index !== ItemIdT.IT_NULL) {
    const item = resolveItem(index); // narrow stub, see file header
    client.ps.stats[PlayerStatT.STAT_ARMOR_ICON] = gi.imageindex(item.icon ?? "");
    client.ps.stats[PlayerStatT.STAT_ARMOR] = client.pers.inventory[index];
  } else {
    client.ps.stats[PlayerStatT.STAT_ARMOR_ICON] = 0;
    client.ps.stats[PlayerStatT.STAT_ARMOR] = 0;
  }

  //
  // pickup message
  //
  if (level.time > client.pickup_msg_time) {
    client.ps.stats[PlayerStatT.STAT_PICKUP_ICON] = 0;
    client.ps.stats[PlayerStatT.STAT_PICKUP_STRING] = 0;
  }

  // owned powerups wheel fill: DROPPED (itemlist `GetItemByPowerup`, see
  // file header) -- left at the zero state the C source's own `memset`
  // produces.
  for (let i = STAT_POWERUP_INFO_START; i <= STAT_POWERUP_INFO_END; i++) client.ps.stats[i] = 0;

  client.ps.stats[PlayerStatT.STAT_TIMER_ICON] = 0;
  client.ps.stats[PlayerStatT.STAT_TIMER] = 0;

  //
  // timers
  //
  // PGM
  if (client.owned_sphere !== null) {
    if (client.owned_sphere.spawnflags === SPHERE_DEFENDER) client.ps.stats[PlayerStatT.STAT_TIMER_ICON] = gi.imageindex("p_defender");
    else if (client.owned_sphere.spawnflags === SPHERE_HUNTER) client.ps.stats[PlayerStatT.STAT_TIMER_ICON] = gi.imageindex("p_hunter");
    else if (client.owned_sphere.spawnflags === SPHERE_VENGEANCE) client.ps.stats[PlayerStatT.STAT_TIMER_ICON] = gi.imageindex("p_vengeance");
    else client.ps.stats[PlayerStatT.STAT_TIMER_ICON] = gi.imageindex("i_fixme"); // error case

    client.ps.stats[PlayerStatT.STAT_TIMER] = Math.ceil(client.owned_sphere.wait - Gtime_seconds(level.time));
  } else {
    let best: PowerupTableEntryT | null = null;

    for (const entry of POWERUP_TABLE) {
      const powerupTime = entry.getTime !== null ? entry.getTime(client) : null;
      const powerupCount = entry.getCount !== null ? entry.getCount(client) : null;

      if (powerupTime !== null && powerupTime <= level.time) continue;
      if (powerupCount !== null && !powerupCount) continue;

      if (best === null) {
        best = entry;
        continue;
      }

      const bestTime = best.getTime !== null ? best.getTime(client) : null;

      if (powerupTime !== null && bestTime !== null && powerupTime < bestTime) {
        best = entry;
        continue;
      }
      if (powerupCount !== null && best.getTime === null) {
        best = entry;
        continue;
      }
    }

    if (best !== null) {
      const bestEntry = best;
      let value: number;

      if (bestEntry.getCount !== null) value = bestEntry.getCount(client);
      else if (bestEntry.getTime !== null) value = Math.ceil(Gtime_seconds(Gtime_subtract(bestEntry.getTime(client), level.time)));
      else value = 0; // unreachable: every table entry has exactly one of getTime/getCount

      client.ps.stats[PlayerStatT.STAT_TIMER_ICON] = gi.imageindex(resolveItem(bestEntry.item).icon ?? ""); // narrow stub, see file header
      client.ps.stats[PlayerStatT.STAT_TIMER] = value;
    }
  }
  // PGM

  //
  // selected item
  //
  client.ps.stats[PlayerStatT.STAT_SELECTED_ITEM] = client.pers.selected_item;

  if (client.pers.selected_item === ItemIdT.IT_NULL) {
    client.ps.stats[PlayerStatT.STAT_SELECTED_ICON] = 0;
  } else {
    // itemlist icon lookup: DROPPED (see file header)
    client.ps.stats[PlayerStatT.STAT_SELECTED_ICON] = 0;

    if (client.pers.selected_item_time < level.time) client.ps.stats[PlayerStatT.STAT_SELECTED_ITEM_NAME] = 0;
  }

  //
  // layouts
  //
  client.ps.stats[PlayerStatT.STAT_LAYOUTS] = 0;

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (client.pers.health <= 0 || Gtime_nonzero(level.intermissiontime) || client.showscores) client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_LAYOUT;
    if (client.showinventory && client.pers.health > 0) client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_INVENTORY;
  } else {
    if (client.showscores || client.showhelp || client.showeou) client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_LAYOUT;
    if (client.showinventory && client.pers.health > 0) client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_INVENTORY;

    if (client.showhelp) client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_HELP;
  }

  if (Gtime_nonzero(level.intermissiontime) || client.awaiting_respawn) {
    if (client.awaiting_respawn || level.intermission_eou || level.is_n64 || (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && Gtime_nonzero(level.intermissiontime))) {
      client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_HIDE_HUD;
    }

    // N64 always merges into one screen on level ends
    if (level.intermission_eou || level.is_n64 || (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && Gtime_nonzero(level.intermissiontime))) {
      client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_INTERMISSION;
    }
  }

  if (level.story_active) client.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_HIDE_CROSSHAIR;
  else client.ps.stats[PlayerStatT.STAT_LAYOUTS] &= ~LayoutFlagsT.LAYOUTS_HIDE_CROSSHAIR;

  // [Paril-KEX] key display -- itemlist IF_KEY scan: DROPPED (see file header)
  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    client.ps.stats[PlayerStatT.STAT_KEY_A] = 0;
    client.ps.stats[PlayerStatT.STAT_KEY_B] = 0;
    client.ps.stats[PlayerStatT.STAT_KEY_C] = 0;
  }

  //
  // frags
  //
  client.ps.stats[PlayerStatT.STAT_FRAGS] = client.resp.score;

  //
  // help icon / current weapon if not shown
  //
  if (client.pers.helpchanged >= 1 && client.pers.helpchanged <= 2 && Gtime_milliseconds(level.time) % 1000 < 500) {
    client.ps.stats[PlayerStatT.STAT_HELPICON] = gi.imageindex("i_help");
  } else if (client.pers.hand === HandednessT.CENTER_HANDED && client.pers.weapon !== null) {
    client.ps.stats[PlayerStatT.STAT_HELPICON] = gi.imageindex(client.pers.weapon.icon ?? "");
  } else {
    client.ps.stats[PlayerStatT.STAT_HELPICON] = 0;
  }

  client.ps.stats[PlayerStatT.STAT_SPECTATOR] = 0;

  // set & run the health bar stuff
  const healthBarsView = new DataView(client.ps.stats.buffer, client.ps.stats.byteOffset + PlayerStatT.STAT_HEALTH_BARS * 2, 2);
  for (let i = 0; i < MAX_HEALTH_BARS; i++) {
    let byteVal = 0;
    const hbEnt = level.health_bar_entities[i];

    if (hbEnt === null || hbEnt === undefined) {
      byteVal = 0;
    } else if (Gtime_nonzero(hbEnt.timestamp)) {
      if (hbEnt.timestamp < level.time) {
        level.health_bar_entities[i] = null;
        byteVal = 0;
      } else {
        byteVal = 0b10000000;
      }
    } else {
      const enemy = hbEnt.enemy;
      if (enemy === null || !enemy.inuse || enemy.health <= 0) {
        if (enemy !== null && (enemy.monsterinfo.aiflags & MonsterAiFlagsT.AI_DOUBLE_TROUBLE) !== 0n) {
          // hack for Makron
          byteVal = 0b10000000;
        } else if (hbEnt.delay) {
          hbEnt.timestamp = Gtime_add(level.time, Gtime_from_sec(hbEnt.delay));
          byteVal = 0b10000000;
        } else {
          level.health_bar_entities[i] = null;
          byteVal = 0;
        }
      } else if (SpawnFlags_has(hbEnt.spawnflags, SPAWNFLAG_HEALTHBAR_PVS_ONLY) && !gi.inPVS(ent.s.origin, enemy.s.origin, true)) {
        byteVal = 0;
      } else {
        const health_remaining = enemy.health / enemy.max_health;
        byteVal = (Math.trunc(health_remaining * 0b01111111) & 0xff) | 0b10000000;
      }
    }

    healthBarsView.setUint8(i, byteVal & 0xff);
  }

  // ZOID
  SetCTFStats(ent);
  // ZOID
}

// ---------------------------------------------------------------------------
// G_CheckChaseStats / G_SetSpectatorStats
// ---------------------------------------------------------------------------

/** p_hud.cpp:1094-1106: `void G_CheckChaseStats(edict_t *ent)`. */
export function G_CheckChaseStats(ent: EdictT): void {
  const entClient = ent.client;
  if (entClient === null) return; // defensive; C assumes ent->client valid for a chase target

  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    const cl = e.client;
    if (cl === null || cl.chase_target !== ent) continue;

    // struct-copy semantics: a fresh array, never aliased to `entClient.ps.stats`
    // (see q_vec3.ts's/this file's own aliasing-hazard convention).
    cl.ps.stats = new Int16Array(entClient.ps.stats);
    G_SetSpectatorStats(e);
  }
}

/** p_hud.cpp:1113-1134: `void G_SetSpectatorStats(edict_t *ent)`. */
export function G_SetSpectatorStats(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.chase_target === null) G_SetStats(ent);

  cl.ps.stats[PlayerStatT.STAT_SPECTATOR] = 1;

  // layouts are independant in spectator
  cl.ps.stats[PlayerStatT.STAT_LAYOUTS] = 0;
  if (cl.pers.health <= 0 || Gtime_nonzero(level.intermissiontime) || cl.showscores) cl.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_LAYOUT;
  if (cl.showinventory && cl.pers.health > 0) cl.ps.stats[PlayerStatT.STAT_LAYOUTS] |= LayoutFlagsT.LAYOUTS_INVENTORY;

  if (cl.chase_target !== null && cl.chase_target.inuse) {
    cl.ps.stats[PlayerStatT.STAT_CHASE] = CS_PLAYERSKINS + (cl.chase_target.s.number - 1);
  } else {
    cl.ps.stats[PlayerStatT.STAT_CHASE] = 0;
  }
}

// ---------------------------------------------------------------------------
// PlayerTrail_Destroy -- ported here, not a stub (see file header)
// ---------------------------------------------------------------------------

/** p_trail.cpp:65-75: `void PlayerTrail_Destroy(edict_t *player)`. */
export function PlayerTrail_Destroy(player: EdictT | null): void {
  for (let i = 0; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e !== undefined && e.classname === "player_trail") {
      if (player === null || e.owner === player) G_FreeEdict(e);
    }
  }

  if (player !== null) {
    const client = player.client;
    if (client !== null) {
      client.trail_head = null;
      client.trail_tail = null;
    }
  } else {
    for (let i = 0; i < game.maxclients; i++) {
      const cl = game.clients[i];
      if (cl !== undefined) {
        cl.trail_head = null;
        cl.trail_tail = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MoveClientToIntermission
// ---------------------------------------------------------------------------

/** p_hud.cpp:16-75: `void MoveClientToIntermission(edict_t *ent)`. */
export function MoveClientToIntermission(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // [Paril-KEX]
  if (client.ps.pmove.pm_type !== KexPmTypeT.PM_FREEZE) ent.s.event = KexEntityEventT.EV_OTHER_TELEPORT;
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) client.showscores = true;

  VectorCopy(level.intermission_origin, ent.s.origin);
  VectorCopy(level.intermission_origin, client.ps.pmove.origin);
  VectorCopy(level.intermission_angle, client.ps.viewangles);
  client.ps.pmove.pm_type = KexPmTypeT.PM_FREEZE;
  client.ps.gunindex = 0;
  client.ps.gunskin = 0;
  client.ps.damage_blend[3] = 0;
  client.ps.screen_blend[3] = 0;
  client.ps.rdflags = RefdefFlagsT.RDF_NONE;

  // clean up powerup info
  client.quad_time = GTIME_ZERO;
  client.invincible_time = GTIME_ZERO;
  client.breather_time = GTIME_ZERO;
  client.enviro_time = GTIME_ZERO;
  client.invisible_time = GTIME_ZERO;
  client.grenade_blew_up = false;
  client.grenade_time = GTIME_ZERO;

  client.showhelp = false;
  client.showscores = false;

  globals.server_flags &= ~ServerFlagsT.SERVER_FLAG_SLOW_TIME;

  // RAFAEL
  client.quadfire_time = GTIME_ZERO;
  // RAFAEL
  // ROGUE
  client.ir_time = GTIME_ZERO;
  client.nuke_time = GTIME_ZERO;
  client.double_time = GTIME_ZERO;
  client.tracker_pain_time = GTIME_ZERO;
  // ROGUE

  ent.viewheight = 0;
  ent.s.modelindex = 0;
  ent.s.modelindex2 = 0;
  ent.s.modelindex3 = 0;
  ent.s.effects = EffectsT.EF_NONE;
  ent.s.sound = 0;
  ent.solid = SolidT.SOLID_NOT;
  ent.movetype = MovetypeT.MOVETYPE_NOCLIP;

  gi.linkentity(ent);

  // add the layout
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    DeathmatchScoreboard(ent);
    client.showscores = true;
  }
}

// ---------------------------------------------------------------------------
// G_UpdateLevelEntry / G_EndOfUnitMessage
// ---------------------------------------------------------------------------

/** p_hud.cpp:77-87: `[Paril-KEX] void G_UpdateLevelEntry()`. */
export function G_UpdateLevelEntry(): void {
  if (level.entry === null) return;

  level.entry.found_secrets = level.found_secrets;
  level.entry.total_secrets = level.total_secrets;
  level.entry.killed_monsters = level.killed_monsters;
  level.entry.total_monsters = level.total_monsters;
}

function pad(n: number, width: number): string {
  return Math.trunc(n).toString().padStart(width, "0");
}

interface LevelEntryLike {
  pretty_name: string;
  killed_monsters: number;
  total_monsters: number;
  found_secrets: number;
  total_secrets: number;
  time: GTime;
}

/** p_hud.cpp:89-109: `inline void G_EndOfUnitEntry(std::stringstream &layout, const int &y, const level_entry_t &entry)`. */
function G_EndOfUnitEntry(y: number, entry: LevelEntryLike): string {
  let layout = `yv ${y} `;

  // we didn't visit this level, so print it as an unknown entry
  if (entry.pretty_name === "") {
    layout += "table_row 1 ??? ";
    return layout;
  }

  layout += `table_row 4 "${entry.pretty_name}" `;
  layout += `${entry.killed_monsters}/${entry.total_monsters} `;
  layout += `${entry.found_secrets}/${entry.total_secrets} `;

  const totalMs = Gtime_milliseconds(entry.time);
  const minutes = Math.trunc(totalMs / 60000);
  const seconds = Math.trunc(totalMs / 1000) % 60;
  const milliseconds = totalMs % 1000;

  layout += `${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(milliseconds, 3)} `;

  return layout;
}

/** p_hud.cpp:111-171: `void G_EndOfUnitMessage()`. */
export function G_EndOfUnitMessage(): void {
  // [Paril-KEX] update game level entry
  G_UpdateLevelEntry();

  // sort entries (mutates `game.level_entries` in place, matching C's
  // `std::sort` over the same shared array).
  game.level_entries.sort((a, b) => {
    const aOrder = a.visit_order !== 0 ? a.visit_order : a.pretty_name !== "" ? MAX_LEVELS_PER_UNIT + 1 : MAX_LEVELS_PER_UNIT + 2;
    const bOrder = b.visit_order !== 0 ? b.visit_order : b.pretty_name !== "" ? MAX_LEVELS_PER_UNIT + 1 : MAX_LEVELS_PER_UNIT + 2;
    return aOrder - bOrder;
  });

  let layout = "start_table 4 $m_eou_level $m_eou_kills $m_eou_secrets $m_eou_time ";

  let y = 16;
  let totalsFoundSecrets = 0;
  let totalsKilledMonsters = 0;
  let totalsTime: GTime = GTIME_ZERO;
  let totalsTotalMonsters = 0;
  let totalsTotalSecrets = 0;
  let numRows = 0;

  for (const entry of game.level_entries) {
    if (entry.map_name === "") break;

    layout += G_EndOfUnitEntry(y, entry);

    y += 8;

    totalsFoundSecrets += entry.found_secrets;
    totalsKilledMonsters += entry.killed_monsters;
    totalsTime = Gtime_add(totalsTime, entry.time);
    totalsTotalMonsters += entry.total_monsters;
    totalsTotalSecrets += entry.total_secrets;

    if (entry.visit_order !== 0) numRows++;
  }

  y += 8;

  // make this a space so it prints totals
  if (numRows > 1) {
    layout += "table_row 0 "; // empty row to separate totals
    layout += G_EndOfUnitEntry(y, {
      pretty_name: " ",
      killed_monsters: totalsKilledMonsters,
      total_monsters: totalsTotalMonsters,
      found_secrets: totalsFoundSecrets,
      total_secrets: totalsTotalSecrets,
      time: totalsTime,
    });
  }

  layout += "xv 160 yt 0 draw_table ";

  layout += `ifgef ${level.intermission_server_frame + Gtime_frames(Gtime_from_ms(5000), gi.frame_time_ms)} yb -48 xv 0 loc_cstring2 0 "$m_eou_press_button" endif `;

  gi.WriteByte(ServerCommandT.svc_layout);
  gi.WriteString(layout);
  gi.multicast(vec3(), KexMulticastT.MULTICAST_ALL, true);

  for (const player of activePlayers()) {
    if (player.client !== null) player.client.showeou = true;
  }
}

// ---------------------------------------------------------------------------
// G_ReportMatchDetails
// ---------------------------------------------------------------------------

/** p_hud.cpp:186-266: `void G_ReportMatchDetails(bool is_end)`. */
export function G_ReportMatchDetails(isEnd: boolean): void {
  const player_ranks = new Array<number>(MAX_CLIENTS).fill(0);

  // CTF/TDM is simple
  if (cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH) || cvarBool("teamplay", "0", CvarFlagsT.CVAR_LATCH)) {
    CTFCalcRankingsAndReport(isEnd); // narrow stub, see file header
    return;
  }

  // sort players by score, then match everybody to the current highest
  // score downwards until we run out of players.
  const sortedPlayers = activePlayers().sort((a, b) => {
    const scoreA = a.client !== null ? a.client.resp.score : 0;
    const scoreB = b.client !== null ? b.client.resp.score : 0;
    return scoreB - scoreA;
  });

  gi.WriteByte(0);

  let currentScore = 0;
  let currentRank = 0;

  for (const player of sortedPlayers) {
    if (player.client === null) continue;
    if (currentRank === 0 || player.client.resp.score !== currentScore) {
      currentRank++;
      currentScore = player.client.resp.score;
    }
    player_ranks[player.s.number - 1] = currentRank;
  }

  let numPlayers = 0;
  for (const player of activePlayers()) {
    // leave spectators out of this data, they don't need to be seen.
    if (player.client !== null && player.client.pers.spawned && !player.client.resp.spectator) {
      if (G_TeamplayEnabled() && player.client.resp.ctf_team === CtfteamT.CTF_NOTEAM) continue;
      numPlayers++;
    }
  }

  gi.WriteByte(numPlayers);

  for (const player of activePlayers()) {
    if (player.client !== null && player.client.pers.spawned && !player.client.resp.spectator) {
      if (G_TeamplayEnabled() && player.client.resp.ctf_team === CtfteamT.CTF_NOTEAM) continue;

      gi.WriteByte(player.s.number - 1);
      gi.WriteLong(player.client.resp.score);
      gi.WriteByte(player_ranks[player.s.number - 1]);

      if (G_TeamplayEnabled()) gi.WriteByte(player.client.resp.ctf_team === CtfteamT.CTF_TEAM1 ? 0 : 1);
    }
  }

  gi.ReportMatchDetails_Multicast(isEnd);
}

// ---------------------------------------------------------------------------
// BeginIntermission
// ---------------------------------------------------------------------------

/** p_hud.cpp:268-397: `void BeginIntermission(edict_t *targ)`. */
export function BeginIntermission(targ: EdictT): void {
  if (Gtime_nonzero(level.intermissiontime)) return; // already activated

  // ZOID
  if (cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH)) CTFCalcScores(); // narrow stub, see file header
  // ZOID

  game.autosaved = false;

  level.intermissiontime = level.time;

  // respawn any dead clients
  for (let i = 0; i < game.maxclients; i++) {
    const client = g_edicts[1 + i];
    if (client === undefined || !client.inuse) continue;
    if (client.health <= 0) {
      // give us our max health back since it will reset to pers.health; in
      // instanced items we'd lose the items we touched so we always want
      // to respawn with our max.
      if (P_UseCoopInstancedItems()) {
        // real import from p_client.ts -- see file header "STUB SWAP"
        const c = client.client;
        if (c !== null) {
          c.pers.health = client.max_health;
          c.pers.max_health = client.max_health;
        }
      }

      respawn(client); // real import from p_client.ts -- see file header "STUB SWAP"
    }
  }

  level.intermission_server_frame = gi.ServerFrame();
  level.changemap = targ.map;
  level.intermission_clear = SpawnFlags_has(targ.spawnflags, SPAWNFLAG_CHANGELEVEL_CLEAR_INVENTORY);
  level.intermission_eou = false;
  level.intermission_fade = SpawnFlags_has(targ.spawnflags, SPAWNFLAG_CHANGELEVEL_FADE_OUT);

  // destroy all player trails
  PlayerTrail_Destroy(null);

  // [Paril-KEX] update game level entry
  G_UpdateLevelEntry();

  if (level.changemap !== null && level.changemap.includes("*")) {
    if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) {
      stripCoopKeys(); // narrow stub, see file header
    }

    if (level.achievement !== null && level.achievement !== "") {
      gi.WriteByte(ServerCommandT.svc_achievement);
      gi.WriteString(level.achievement);
      gi.multicast(vec3(), KexMulticastT.MULTICAST_ALL, true);
    }

    level.intermission_eou = true;

    // "no end of unit" maps handle intermission differently
    if (!SpawnFlags_has(targ.spawnflags, SPAWNFLAG_CHANGELEVEL_NO_END_OF_UNIT)) {
      G_EndOfUnitMessage();
    } else if (SpawnFlags_has(targ.spawnflags, SPAWNFLAG_CHANGELEVEL_IMMEDIATE_LEAVE) && !cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
      // Need to call this now
      G_ReportMatchDetails(true);
      level.exitintermission = true; // go immediately to the next level
      return;
    }
  } else {
    if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
      level.exitintermission = true; // go immediately to the next level
      return;
    }
  }

  // Call while intermission is running
  G_ReportMatchDetails(true);

  level.exitintermission = false;

  if (!level.level_intermission_set) {
    // find an intermission spot
    let ent = G_FindByString(null, "classname", "info_player_intermission");
    if (ent === null) {
      // the map creator forgot to put in an intermission point...
      ent = G_FindByString(null, "classname", "info_player_start");
      if (ent === null) ent = G_FindByString(null, "classname", "info_player_deathmatch");
    } else {
      // choose one of four spots
      let i = irandom(4);
      while (i--) {
        const next = G_FindByString(ent, "classname", "info_player_intermission");
        ent = next !== null ? next : G_FindByString(null, "classname", "info_player_intermission"); // wrap around the list
      }
    }

    if (ent !== null) {
      VectorCopy(ent.s.origin, level.intermission_origin);
      VectorCopy(ent.s.angles, level.intermission_angle);
    }
  }

  // move all clients to the intermission point
  for (let i = 0; i < game.maxclients; i++) {
    const client = g_edicts[1 + i];
    if (client === undefined || !client.inuse) continue;
    MoveClientToIntermission(client);
  }
}

// ---------------------------------------------------------------------------
// DeathmatchScoreboardMessage / DeathmatchScoreboard
// ---------------------------------------------------------------------------

const MAX_SCOREBOARD_SIZE = 1024;

/** p_hud.cpp:407-528: `void DeathmatchScoreboardMessage(edict_t *ent, edict_t *killer)`. */
export function DeathmatchScoreboardMessage(ent: EdictT, killer: EdictT | null): void {
  // ZOID
  if (G_TeamplayEnabled()) {
    CTFScoreboardMessage(ent, killer); // narrow stub, see file header
    return;
  }
  // ZOID

  // sort the clients by score
  const candidates: { index: number; client: GClientT }[] = [];
  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    const cl = game.clients[i];
    if (cl_ent === undefined || !cl_ent.inuse || cl === undefined || cl.resp.spectator) continue;
    candidates.push({ index: i, client: cl });
  }

  // stable sort (V8/Bun's Array.sort is stable, matching the C source's
  // stable insertion-sort-by-score).
  candidates.sort((a, b) => b.client.resp.score - a.client.resp.score);

  // add the clients in sorted order
  const total = Math.min(candidates.length, 16);

  let str = "";

  for (let i = 0; i < total; i++) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const { index, client: cl } = candidate;

    const x = i >= 8 ? 130 : -72;
    const y = 32 * (i % 8);

    // add a dogtag -- [Paril-KEX] use dynamic dogtags. `DMGame.DogTag` is
    // always null in this port line (see g_combat.ts's identical DMGame
    // precedent), so the plain `dogtag {index}` token is the only
    // reachable path.
    let entry = `xv ${x + 32} yv ${y} dogtag ${index} `;
    if (str.length + entry.length > MAX_SCOREBOARD_SIZE) break;
    str += entry;

    entry = `client ${x} ${y} ${index} ${cl.resp.score} ${cl.ping} ${Gtime_minutesInt(Gtime_subtract(level.time, cl.resp.entertime))} `;
    if (str.length + entry.length > MAX_SCOREBOARD_SIZE) break;
    str += entry;
  }

  // [Paril-KEX] time & frags
  const fraglimit = cvarInt("fraglimit", "0", CvarFlagsT.CVAR_SERVERINFO);
  if (fraglimit !== 0) {
    str += `xv -20 yv -10 loc_string2 1 $g_score_frags "${fraglimit}" `;
  }
  const timelimit = cvarFloat("timelimit", "0", CvarFlagsT.CVAR_SERVERINFO);
  if (timelimit !== 0 && !Gtime_nonzero(level.intermissiontime)) {
    const remainingMs = Gtime_milliseconds(Gtime_subtract(Gtime_from_min(timelimit), level.time));
    str += `xv 340 yv -10 time_limit ${gi.ServerFrame() + Math.trunc(remainingMs / gi.frame_time_ms)} `;
  }

  if (Gtime_nonzero(level.intermissiontime)) {
    str += `ifgef ${level.intermission_server_frame + Gtime_frames(Gtime_from_ms(5000), gi.frame_time_ms)} yb -48 xv 0 loc_cstring2 0 "$m_eou_press_button" endif `;
  }

  gi.WriteByte(ServerCommandT.svc_layout);
  gi.WriteString(str);
}

/** p_hud.cpp:538-543: `void DeathmatchScoreboard(edict_t *ent)`. */
export function DeathmatchScoreboard(ent: EdictT): void {
  DeathmatchScoreboardMessage(ent, ent.enemy);
  gi.unicast(ent, true, 0);
  if (ent.client !== null) ent.client.menutime = Gtime_add(level.time, Gtime_from_ms(3000));
}

// ---------------------------------------------------------------------------
// Cmd_Score_f
// ---------------------------------------------------------------------------

/** p_hud.cpp:552-579: `void Cmd_Score_f(edict_t *ent)`. */
export function Cmd_Score_f(ent: EdictT): void {
  if (Gtime_nonzero(level.intermissiontime)) return;

  const client = ent.client;
  if (client === null) return;

  client.showinventory = false;
  client.showhelp = false;

  globals.server_flags &= ~ServerFlagsT.SERVER_FLAG_SLOW_TIME;

  // ZOID
  if (client.menu !== null) PMenu_Close(ent); // narrow stub, see file header
  // ZOID

  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && !cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) return;

  if (client.showscores) {
    client.showscores = false;
    client.update_chase = true;
    return;
  }

  client.showscores = true;
  DeathmatchScoreboard(ent);
}

// ---------------------------------------------------------------------------
// HelpComputer / Cmd_Help_f
// ---------------------------------------------------------------------------

/** p_hud.cpp:588-651: `void HelpComputer(edict_t *ent)`. */
export function HelpComputer(ent: EdictT): void {
  const skillLevel = cvarInt("skill", "1", CvarFlagsT.CVAR_LATCH);
  let sk: string;
  if (skillLevel === 0) sk = "$m_easy";
  else if (skillLevel === 1) sk = "$m_medium";
  else if (skillLevel === 2) sk = "$m_hard";
  else sk = "$m_nightmare";

  // send the layout
  let helpString = `xv 32 yv 8 picn help xv 0 yv 25 cstring2 "${level.level_name}" `;

  if (level.is_n64) {
    helpString += `xv 0 yv 54 loc_cstring 1 "{}" "${game.helpmessage1}" `;
  } else {
    let y = 54;
    if (game.helpmessage1 !== "") {
      helpString += `xv 0 yv ${y} loc_cstring2 0 "$g_pc_primary_objective" xv 0 yv ${y + 11} loc_cstring 0 "${game.helpmessage1}" `;
      y += 58;
    }

    if (game.helpmessage2 !== "") {
      helpString += `xv 0 yv ${y} loc_cstring2 0 "$g_pc_secondary_objective" xv 0 yv ${y + 11} loc_cstring 0 "${game.helpmessage2}" `;
    }
  }

  helpString += `xv 55 yv 164 loc_string2 0 "${sk}" `;
  helpString += `xv 265 yv 164 loc_rstring2 1 "{}: ${level.found_goals}/${level.total_goals}" "$g_pc_goals" `;
  helpString += `xv 55 yv 172 loc_string2 1 "{}: ${level.killed_monsters}/${level.total_monsters}" "$g_pc_kills" `;
  helpString += `xv 265 yv 172 loc_rstring2 1 "{}: ${level.found_secrets}/${level.total_secrets}" "$g_pc_secrets" `;

  gi.WriteByte(ServerCommandT.svc_layout);
  gi.WriteString(helpString);
  gi.unicast(ent, true, 0);
}

/** p_hud.cpp:660-688: `void Cmd_Help_f(edict_t *ent)`. */
export function Cmd_Help_f(ent: EdictT): void {
  // this is for backwards compatability
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    Cmd_Score_f(ent);
    return;
  }

  if (Gtime_nonzero(level.intermissiontime)) return;

  const client = ent.client;
  if (client === null) return;

  client.showinventory = false;
  client.showscores = false;

  if (client.showhelp && (client.pers.game_help1changed === game.help1changed || client.pers.game_help2changed === game.help2changed)) {
    client.showhelp = false;
    globals.server_flags &= ~ServerFlagsT.SERVER_FLAG_SLOW_TIME;
    return;
  }

  client.showhelp = true;
  client.pers.helpchanged = 0;
  globals.server_flags |= ServerFlagsT.SERVER_FLAG_SLOW_TIME;
  HelpComputer(ent);
}
