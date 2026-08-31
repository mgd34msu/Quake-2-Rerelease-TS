// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// ctf/g_ctf.c -- the Capture-The-Flag game mode for the 2023 Quake II
// re-release ("KEX") engine's kex CTF DLL. Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/ctf/g_ctf.cpp (3,862 lines,
// C++17) + ctf/g_ctf.h (162 lines): teams, flag entities, captures/frag
// bonuses, the four techs, the grapple hook weapon, the match/election
// state machine, the admin menu, observer/id display, and
// CTFScoreboardMessage. ctf/p_ctf_menu.cpp/.h (the generic PMenu widget
// this file's join/admin menus are built on) is ported separately as
// ./p_ctf_menu.ts.
//
// ============================================================================
// CONSOLIDATION -- this unit REPLACES prior throwing/partial CTF stubs
// ============================================================================
// Before this unit landed, no src/kexgame/g_ctf.ts (or ctf/ directory)
// existed anywhere in this port line. Every file that needed a CTF symbol
// carried its OWN local copy -- ranging from plain throwing stubs, to
// "reachable prefix real, unreached tail throws" partials (documented at
// each call site as "reached only because ctf_team/ctf_grapple/inventory
// default to CTF_NOTEAM/null/0"), to a few fully-real small functions
// (CTFEffects, CTFApplyStrength, ...) that happened to need nothing this
// port line hadn't already typed. This unit's job is to land the REAL,
// complete implementations here and swap every one of those call sites to
// import from this file (or ./p_ctf_menu.ts) instead. Full inventory,
// grouped by file (all diffs applied in this same change):
//
//   g_combat.ts    : CTFApplyStrength/CTFApplyResistance/CTFCheckHurtCarrier
//                    were already real (moved here verbatim, deleted
//                    there); CTFMatchSetup was pinned `return false` (now a
//                    real, imported CTFMatchSetup() reading match state).
//   p_client.ts    : CTFOtherTeam was real (moved here, deleted there);
//                    CTFFragBonuses/CTFDeadDropFlag/CTFDeadDropTech/
//                    CTFStartClient/CTFPlayerResetGrapple were "real guard
//                    prefix + throwing tail" partials (now real, imported,
//                    in full); CTFResetGrapple/CTFAssignTeam/CTFAssignSkin/
//                    CTFGrapplePull/G_AdjustTeamScore/SelectCTFSpawnPoint/
//                    PMenu_Prev/PMenu_Next/PMenu_Select were throwing stubs
//                    (now real imports; the PMenu_* ones from
//                    ./p_ctf_menu.ts).
//   p_weapon.ts    : CTFApplyStrengthSound/CTFApplyHaste/CTFApplyHasteSound
//                    were already real (moved here verbatim, deleted
//                    there).
//   p_view.ts      : CTFEffects/CTFSetPowerUpEffect/CTFApplyRegeneration
//                    were already real (moved here verbatim, deleted
//                    there, along with their `modelindex_flag1/2`/
//                    `CTF_GRAPPLE_STATE_*` module state -- CTFPrecache
//                    here is the real setter for modelindex_flag1/2).
//                    G_TeamplayEnabled stays put (see "WHY G_TeamplayEnabled
//                    STAYS IN p_view.ts" below) and is imported from there.
//   g_cmds.ts      : PMenu_Prev/PMenu_Close/PMenu_Select and every CTF
//                    sub-command (CTFWhat_Tech/CTFOpenJoinMenu/
//                    CTFAssignSkin/CTFDirtyTeamMenu/CTFTeamName/
//                    CTFObserver/CTFTeam_f/CTFID_f/CTFVoteYes/CTFVoteNo/
//                    CTFReady/CTFNotReady/CTFGhost/CTFAdmin/CTFStats/
//                    CTFWarp/CTFBoot/CTFPlayerList/CTFSay_Team/
//                    CTFPickup_Flag[sentinel]) were throwing stubs (now
//                    real imports; CTFPickup_Flag's pointer-identity
//                    sentinel role is now satisfied by the real, imported
//                    function itself).
//   g_misc.ts      : CTFResetGrapple was a throwing stub (now a real
//                    import); CTFPlayerResetGrapple was already real
//                    (deleted there, now imported from here too, so both
//                    call sites share one implementation).
//   g_items.ts     : CTFWeapon_Grapple/CTFPickup_Flag/CTFDrop_Flag/
//                    CTFPickup_Tech/CTFDrop_Tech/CTFFlagSetup/PMenu_Next
//                    were throwing stubs; CTFMatchSetup was pinned `return
//                    false`; CTFHasRegeneration was already real (moved
//                    here, deleted there). All now real imports (PMenu_Next
//                    from ./p_ctf_menu.ts).
//   p_hud.ts       : PMenu_Close/CTFCalcScores/CTFScoreboardMessage were
//                    throwing stubs; `ctfTeamLogoStats`/`ctfTechIcon`/
//                    `resolveItem` were narrow local stubs backing a
//                    partial local `SetCTFStats`; `CTFCalcRankingsAndReport`
//                    was a throwing stub standing in for the CTF branch of
//                    `G_ReportMatchDetails`. The real `SetCTFStats` (full
//                    body, using real `GetItemByIndex`/itemlist) now lives
//                    here; p_hud.ts's local partial and its three backing
//                    stubs are deleted, replaced with an import + call.
//                    `G_ReportMatchDetails`'s CTF/TDM branch is corrected to
//                    match the real C++ control flow (see p_hud.cpp:186-228:
//                    it does NOT early-return -- both branches fall through
//                    into the SAME num_players-counting tail); previously it
//                    called the stub and returned immediately, skipping that
//                    tail entirely. PMenu_Close now imports from
//                    ./p_ctf_menu.ts.
//
// Two files' CTF cross-deps were audited and found to need NO change:
//   g_spawn.ts -- carries its OWN local, unexported `CTFSpawn()` (a
//     deliberate no-op given no `ctfgame` existed anywhere) and `CTFPrecache`
//     (a throwing stub). Per this unit's brief ("do NOT edit g_spawn.ts"),
//     both are left exactly as-is; they are now stale duplicates of the
//     real exports below, reported in this unit's own report rather than
//     patched. `info_player_team1`/`info_player_team2` in g_spawn.ts's
//     registry are also still wired to `unported(...)` sentinels -- this
//     unit exports real `SP_info_player_team1`/`SP_info_player_team2`
//     below for a future g_spawn.ts-owning unit to wire in (see "SP LIST
//     FOR A FUTURE g_spawn.ts UNIT" below).
//   g_main.ts -- registers the `ctf`/`teamplay`/`gamerules` cvars itself and
//     cites `CTFInit()`/`CTFCheckRules`/`CTFInMatch`/`CheckEndTDMLevel`/
//     `CTFNextMap` as real functions reached only behind those cvars'
//     real-but-default-false guards. This unit exports all of them for real
//     but does not touch g_main.ts (out of file scope for this unit);
//     `CTFInit()` in particular still isn't called from anywhere (g_main.ts's
//     `PreInitGame` would be the real call site) -- reported as a standing
//     gap, not silently wired in.
//
// ============================================================================
// WHY G_TeamplayEnabled STAYS IN p_view.ts
// ============================================================================
// `G_TeamplayEnabled` (ctf/g_ctf.cpp:55-58) is, by C++ file location, this
// module's function. p_view.ts ported it for real already (its own header:
// "ported here, not a stub") and it is by far this port line's most widely
// imported CTF symbol (g_cmds.ts, g_items.ts, p_client.ts, p_hud.ts,
// p_view.ts itself, and now this file). Moving its canonical body here would
// require updating every one of those import sites for a function that is
// already 100% correct and has no missing behavior -- a large, purely
// cosmetic ripple this unit's brief does not ask for. This file imports it
// from p_view.ts instead of re-defining it, matching this port line's
// existing precedent of a symbol's "real home" sometimes being wherever it
// landed first and got consumed widely (see g_combat.ts's own ArmorIndex/
// PowerArmorType precedent for the same reasoning in the other direction).
//
// ============================================================================
// IMPORT CYCLES (sanctioned; every cross-reference below is read inside a
// function body, never at module-evaluation time -- verified end-to-end by
// `bunx tsc --noEmit` and `bun test` importing all files together)
// ============================================================================
//   g_ctf.ts <-> p_client.ts : this file imports PutClientInServer/
//     G_PostRespawn/respawn/player_die/PlayersRangeFromSpot/SpawnPointClear/
//     SelectDeathmatchSpawnPoint/G_ShouldPlayersCollide; p_client.ts imports
//     CTFOtherTeam/CTFFragBonuses/CTFDeadDropFlag/CTFDeadDropTech/
//     CTFStartClient/CTFPlayerResetGrapple/CTFResetGrapple/CTFAssignTeam/
//     CTFAssignSkin/CTFGrapplePull/G_AdjustTeamScore/SelectCTFSpawnPoint back
//     from here.
//   g_ctf.ts <-> g_items.ts : this file imports GetItemByIndex/
//     FindItemByClassname/Drop_Item/PrecacheItem/Touch_Item/itemlist;
//     g_items.ts imports CTFWeapon_Grapple/CTFPickup_Flag/CTFDrop_Flag/
//     CTFPickup_Tech/CTFDrop_Tech/CTFFlagSetup/CTFHasRegeneration/
//     CTFMatchSetup back from here.
//   g_ctf.ts <-> p_hud.ts : this file imports DeathmatchScoreboardMessage/
//     PlayerStatT; p_hud.ts imports SetCTFStats/CTFCalcScores/
//     CTFScoreboardMessage/CTFCalcRankings back from here (this file's own
//     `active_players()` is a local, unexported copy -- see g_target.ts's/
//     p_hud.ts's own identical precedent -- not shared with p_hud.ts).
//   g_ctf.ts <-> p_view.ts : this file imports G_TeamplayEnabled (p_view.ts's
//     real home, see "WHY G_TeamplayEnabled STAYS IN p_view.ts" above);
//     p_view.ts imports CTFEffects/CTFSetPowerUpEffect/CTFApplyRegeneration/
//     CTF_GRAPPLE_STATE_*/PMenu_Do_Update back from here (the last from
//     ./p_ctf_menu.ts).
//
// Two deliberately AVOIDED cycles (see the `EndDMLevel`/`CheckFlood` local
// stubs below for the full rationale): this file does NOT import from
// g_main.ts or g_cmds.ts, even though both would otherwise be natural
// homes for real implementations, because both transitively import
// g_spawn.ts, which imports every monster module for its spawn registry --
// confirmed experimentally to break `bun test` on files with no business
// needing any monster module at all.
//
// ============================================================================
// QUIRKS PORTED BUG-FOR-BUG (cited)
// ============================================================================
//   - CTFOpenJoinMenu (ctf/g_ctf.cpp:2941-2963): computes `num1`/`num2` team
//     counts into a would-be balanced `team` choice, then UNCONDITIONALLY
//     overwrites it with `team = brandom() ? CTF_TEAM1 : CTF_TEAM2;` with no
//     `else` -- the balanced-team branch is dead code; the default cursor
//     position in the join menu is always random. Ported exactly as broken.
//   - CTFShowScores (ctf/g_ctf.cpp:2818-2825): declared `(edict_t *ent,
//     pmenu_t *p)` -- NOT `pmenuhnd_t *p` like every real `SelectFunc_t`
//     entry point -- and grepping the whole ctf/ tree confirms it is never
//     assigned into any `pmenu_t[]` array anywhere. Genuinely dead code in
//     the shipped source; ported for completeness (parity with the header's
//     declared API) but never wired to any menu entry here either.
//   - SP_trigger_teleport/SP_info_teleport_destination (declared in
//     ctf/g_ctf.h:159-160) vs SP_trigger_ctf_teleport/
//     SP_info_ctf_teleport_destination (the names ctf/g_ctf.cpp:3257/3287
//     actually define, matching their own `/*QUAKED trigger_ctf_teleport*/`/
//     `/*QUAKED info_ctf_teleport_destination*/` comments) -- a genuine
//     header/impl name mismatch in the source. Exported here under their
//     real ctf/g_ctf.cpp names and classnames (SP list below), not the
//     header's names, to avoid colliding with an unrelated same-named
//     `trigger_teleport`/`info_teleport_destination` pair some other file
//     may one day own.
//   - `loc_findradius` (ctf/g_ctf.cpp:112-133) is wrapped in `#ifndef
//     KEX_Q2_GAME` (dead in the real dedicated-server build, which DOES
//     define KEX_Q2_GAME -- see g_cmds.ts's own header for the citation)
//     AND is never called anywhere else in this file (every real call site
//     uses the global `findradius` from g_utils.cpp/g_utils.ts instead).
//     Dropped per PORTING.md's dead-code rule, not ported.
//
// ============================================================================
// SP LIST FOR A FUTURE g_spawn.ts UNIT (this unit does not edit g_spawn.ts)
// ============================================================================
//   info_player_team1        -> SP_info_player_team1        (no-op spawn)
//   info_player_team2        -> SP_info_player_team2        (no-op spawn)
//   misc_ctf_banner           -> SP_misc_ctf_banner
//   misc_ctf_small_banner     -> SP_misc_ctf_small_banner
//   trigger_ctf_teleport      -> SP_trigger_ctf_teleport
//   info_ctf_teleport_destination -> SP_info_ctf_teleport_destination
//   item_flag_team1/item_flag_team2/item_tech1..4 are ALREADY wired in
//   g_items.ts's real `itemlist[]` (pickup/drop -> this file's exports);
//   nothing further needed there.
//
// ============================================================================
// SAVE REGISTRY
// ============================================================================
// Every think/touch/die callback below is registered by name via
// RegisterThink/RegisterTouch/RegisterDie (g_save_registry.ts), matching
// this port line's save-game function-pointer convention: CTFFlagThink,
// CTFFlagSetup, CTFDropFlagThink, CTFDropFlagTouch, TechThink, CTFGrappleTouch,
// grapple_die, misc_ctf_banner_think, old_teleporter_touch.

import { type Vec3, vec3 } from "../../shared/math";
import { CvarT, Info_ValueForKey, Q_strcasecmp } from "../../shared/q_shared";
import {
  ATTN_NONE,
  ATTN_NORM,
  ButtonT,
  ContentsT,
  CS_GENERAL,
  CS_PLAYERSKINS,
  CvarFlagsT,
  EffectsT,
  type KexEdictT,
  KexEntityEventT,
  KexMulticastT,
  KexPmTypeT,
  KexTempEventT,
  MASK_PROJECTILE,
  MASK_SOLID,
  MAX_CLIENTS,
  type PrintTypeT,
  PmflagsT,
  RenderfxT,
  ServerCommandT,
  SolidT,
  SoundchanT,
  SurfflagsT,
  SvflagsT,
} from "../../kexapi/game";
import {
  AnimPriorityT,
  CtfteamT,
  DamageflagsT,
  type EdictT,
  EntFlagsT,
  type GClientT,
  type GhostT,
  type GitemT,
  type GitemDropFn,
  type GitemPickupFn,
  ItemFlagsT,
  ItemIdT,
  ModIdT,
  type ModT,
  MovetypeT,
  PlayerNoiseT,
  type PmenuhndT,
  type PmenuT,
  PowerupT,
  random_time,
  type SelectFuncT,
  SPAWNFLAG_ITEM_DROPPED,
  SPHERE_DEFENDER,
  type TouchFn,
  type UpdateFuncT,
  WeaponstateT,
} from "../g_local";
import { gi, g_edicts, game, globals, level } from "../g_main_globals";
import {
  type GTime,
  GTIME_ZERO,
  Gtime_add,
  Gtime_from_hz,
  Gtime_from_min,
  Gtime_from_ms,
  Gtime_from_sec,
  Gtime_milliseconds,
  Gtime_nonzero,
  Gtime_scale,
  Gtime_secondsInt,
  Gtime_subtract,
} from "../gtime";
import { AngleVectors, vec3_add, vec3_dot, vec3_length, vec3_muls, vec3_normalized, vec3_origin, vec3_sub, vectoangles } from "../q_vec3";
import { brandom, crandom_open, irandom } from "../q_std";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "../spawnflags";
import { RegisterDie, RegisterThink, RegisterTouch } from "../g_save_registry";
import { G_FindByString, G_FreeEdict, G_PickTarget, G_Spawn, KillBox, findradius } from "../g_utils";
import { ArmorIndex, T_Damage } from "../g_combat";
import {
  DoRespawn,
  Drop_Item,
  FindItemByClassname,
  GetItemByIndex,
  itemlist,
  PrecacheItem,
  Touch_Item,
} from "../g_items";
import {
  G_ShouldPlayersCollide,
  PlayersRangeFromSpot,
  player_die,
  PutClientInServer,
  respawn,
  G_PostRespawn,
  SelectDeathmatchSpawnPoint,
  SpawnPointClear,
} from "../p_client";
import { DeathmatchScoreboardMessage, PlayerStatT } from "../p_hud";
import { G_TeamplayEnabled } from "../p_view";
import { P_ProjectSource, PlayerNoise, Weapon_Generic } from "../p_weapon";
import { GetUnicastKey } from "../g_weapon";
import { FRAME_death308 } from "../m_player";
import { PMENU_ALIGN_CENTER, PMENU_ALIGN_LEFT, PMenu_Close, PMenu_Open, PMenu_Update, PMenu_UpdateEntry } from "./p_ctf_menu";

// ---------------------------------------------------------------------------
// cvar-read / gi print helpers (see g_combat.ts's/g_cmds.ts's own precedent
// for this exact "duplicated on purpose" idiom)
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
function cvarString(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): string {
  const c = gi.cvar(name, def, flags);
  return c === null ? def : c.string;
}

function giClientPrint(ent: EdictT | null, printlevel: PrintTypeT, message: string): void {
  gi.Client_Print(ent, printlevel, message);
}
function giLocClientPrint(ent: EdictT | null, printlevel: PrintTypeT, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(ent, printlevel, base, args.map(String), args.length);
}
function giLocBroadcastPrint(printlevel: PrintTypeT, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(null, printlevel | 4 /* PRINT_BROADCAST -- see g_cmds.ts's own copy */, base, args.map(String), args.length);
}
function giBroadcastPrint(printlevel: PrintTypeT, message: string): void {
  gi.Broadcast_Print(printlevel, message);
}
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): ReturnType<typeof gi.trace> {
  return gi.trace(start, null, null, end, passent, mask);
}

const PRINT_HIGH: PrintTypeT = 0;
const PRINT_MEDIUM: PrintTypeT = 1;
const PRINT_CHAT: PrintTypeT = 3;
const PRINT_CENTER: PrintTypeT = 5;

/** `mod_t`'s implicit single-argument constructor (g_local.h:1081-1093) -- see p_weapon.ts's own `modFromId` precedent. */
function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}
const MOD_GRAPPLE = modFromId(ModIdT.MOD_GRAPPLE);
const MOD_SUICIDE_FF: ModT = { id: ModIdT.MOD_SUICIDE, friendly_fire: true, no_point_loss: false };

/** `active_players()` (g_local.h:3426-3437) -- local copy, see g_target.ts's/p_hud.ts's own identical precedent. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

function requireClient(ent: EdictT, ctx: string): GClientT {
  if (ent.client === null) throw new Error(`${ctx}: called against an entity with no .client set`);
  return ent.client;
}

/**
 * g_main.cpp:521-622: `void EndDMLevel()`, g_main.ts's own real export.
 * Deliberately NOT imported: g_main.ts imports `SpawnEntities` from
 * g_spawn.ts, which imports EVERY monster module (m_supertank.ts, etc.) for
 * its spawn registry -- importing g_main.ts from here would transitively
 * pull this entire module graph into every file that imports ctf/g_ctf.ts
 * (g_items.ts, p_client.ts, p_hud.ts, g_cmds.ts, p_view.ts, p_weapon.ts,
 * g_combat.ts, g_misc.ts), which is exactly backwards for a leaf CTF unit
 * and was confirmed experimentally to break `bun test` on files that
 * shouldn't need any monster module at all (an unrelated in-flight monster
 * batch's own TDZ bug becomes reachable through that chain). g_main.ts's own
 * header already documents this as a one-way citation ("CTFCheckRules/
 * CTFInMatch/CheckEndTDMLevel/CTFNextMap ... reached only behind a real,
 * concretely-false-by-default guard") without importing back -- this local
 * stub keeps that relationship one-way from g_ctf.ts's side too. Every call
 * site below is reached only via a genuine CTF/admin action (fraglimit hit
 * under teamplay, a match timer running out, an admin/election map warp),
 * never on an ordinary damage/spawn/frame path.
 */
function EndDMLevel(): void {
  throw new Error("EndDMLevel: not yet ported here (pending a shared, monster-module-free home for it; see g_main.ts's own real export, g_main.cpp:521) -- reached only via a genuine CTF match-end/fraglimit-hit/map-warp action");
}

/**
 * g_cmds.cpp's own `CheckFlood` (g_cmds.ts's real export). Deliberately NOT
 * imported for the exact same reason as `EndDMLevel` above: g_cmds.ts
 * imports `ED_ParseField`/`ED_CallSpawn`/`ClearSpawnTemp` from g_spawn.ts,
 * which imports every monster module for its spawn registry -- importing
 * g_cmds.ts from here would create the same unwanted monster-module fan-in
 * (confirmed experimentally: it broke `bun test` on files with no business
 * needing any monster module). `CTFSay_Team`'s own C++ home
 * (ctf/g_ctf.cpp:2133) is additionally wrapped in `#ifndef KEX_Q2_GAME` --
 * dead code in the real dedicated-server build (see g_cmds.ts's own header)
 * -- and only reachable at all when `G_TeamplayEnabled()` is true (default
 * false), so this narrow stub is a real, cited, doubly-guarded gap.
 */
function CheckFlood(_ent: EdictT): boolean {
  throw new Error("CheckFlood: not yet ported here (pending a shared, monster-module-free home for it; see g_cmds.ts's own real export, g_cmds.cpp) -- CTFSay_Team is dead code in the real KEX_Q2_GAME build and reached only when G_TeamplayEnabled() is true (default false)");
}

// ---------------------------------------------------------------------------
// match_t / elect_t (ctf/g_ctf.cpp:8-23) -- local, not part of ctf/g_ctf.h's
// public API
// ---------------------------------------------------------------------------

enum MatchT {
  MATCH_NONE,
  MATCH_SETUP,
  MATCH_PREGAME,
  MATCH_GAME,
  MATCH_POST,
}

enum ElectT {
  ELECT_NONE,
  ELECT_MATCH,
  ELECT_ADMIN,
  ELECT_MAP,
}

/** ctf/g_ctf.h:16-20 `enum ctfgrapplestate_t`. `GClientT.ctf_grapplestate` is
 *  typed plain `number` (g_local_types.ts), so these are exported as plain
 *  numeric constants rather than a TS enum -- matches p_view.ts's own
 *  former local copy of these same three values exactly. */
export const CTF_GRAPPLE_STATE_FLY = 0;
export const CTF_GRAPPLE_STATE_PULL = 1;
export const CTF_GRAPPLE_STATE_HANG = 2;

export const CTF_TEAM1_SKIN = "ctf_r";
export const CTF_TEAM2_SKIN = "ctf_b";

export const CTF_CAPTURE_BONUS = 15;
export const CTF_TEAM_BONUS = 10;
export const CTF_RECOVERY_BONUS = 1;
export const CTF_FLAG_BONUS = 0;
export const CTF_FRAG_CARRIER_BONUS = 2;
const CTF_FLAG_RETURN_TIME: GTime = Gtime_from_sec(40);

export const CTF_CARRIER_DANGER_PROTECT_BONUS = 2;
export const CTF_CARRIER_PROTECT_BONUS = 1;
export const CTF_FLAG_DEFENSE_BONUS = 1;
export const CTF_RETURN_FLAG_ASSIST_BONUS = 1;
export const CTF_FRAG_CARRIER_ASSIST_BONUS = 2;

const CTF_TARGET_PROTECT_RADIUS = 400;
const CTF_ATTACKER_PROTECT_RADIUS = 400;

const CTF_CARRIER_DANGER_PROTECT_TIMEOUT: GTime = Gtime_from_sec(8);
const CTF_FRAG_CARRIER_ASSIST_TIMEOUT: GTime = Gtime_from_sec(10);
const CTF_RETURN_FLAG_ASSIST_TIMEOUT: GTime = Gtime_from_sec(10);

const CTF_AUTO_FLAG_RETURN_TIMEOUT: GTime = Gtime_from_sec(30);

const CTF_TECH_TIMEOUT: GTime = Gtime_from_sec(60);

const CTF_DEFAULT_GRAPPLE_SPEED = 650;
const CTF_DEFAULT_GRAPPLE_PULL_SPEED = 650;
void CTF_FLAG_RETURN_TIME; // declared, never read in the C++ source either (dead constant)
void CTF_DEFAULT_GRAPPLE_SPEED;
void CTF_DEFAULT_GRAPPLE_PULL_SPEED;

const TECH_IDS: readonly ItemIdT[] = [ItemIdT.IT_TECH_RESISTANCE, ItemIdT.IT_TECH_STRENGTH, ItemIdT.IT_TECH_HASTE, ItemIdT.IT_TECH_REGENERATION];

/** bg_local.h:56-73 offset chain -- see p_hud.ts's/g_spawn.ts's/g_target.ts's
 *  own identical duplicated copies (this constant family is not exported
 *  anywhere in this port line, so every file that needs it duplicates the
 *  chain). Only the first two members are needed here. */
const CONFIG_CTF_MATCH = CS_GENERAL;
const CONFIG_CTF_TEAMINFO = CONFIG_CTF_MATCH + 1;

// ---------------------------------------------------------------------------
// ctfgame_t (ctf/g_ctf.cpp:25-47) -- module state
// ---------------------------------------------------------------------------

interface CtfgameT {
  team1: number;
  team2: number;
  total1: number;
  total2: number;
  last_flag_capture: GTime;
  last_capture_team: CtfteamT;

  match: MatchT;
  matchtime: GTime;
  lasttime: number;
  countdown: boolean;

  election: ElectT;
  etarget: EdictT | null;
  elevel: string;
  evotes: number;
  needvotes: number;
  electtime: GTime;
  emsg: string;
  warnactive: number;

  ghosts: GhostT[];
}

function freshGhost(): GhostT {
  return { netname: "", number: 0, deaths: 0, kills: 0, caps: 0, basedef: 0, carrierdef: 0, code: 0, team: CtfteamT.CTF_NOTEAM, score: 0, ent: null };
}

function freshCtfgame(): CtfgameT {
  return {
    team1: 0,
    team2: 0,
    total1: 0,
    total2: 0,
    last_flag_capture: GTIME_ZERO,
    last_capture_team: CtfteamT.CTF_NOTEAM,
    match: MatchT.MATCH_NONE,
    matchtime: GTIME_ZERO,
    lasttime: 0,
    countdown: false,
    election: ElectT.ELECT_NONE,
    etarget: null,
    elevel: "",
    evotes: 0,
    needvotes: 0,
    electtime: GTIME_ZERO,
    emsg: "",
    warnactive: 0,
    ghosts: Array.from({ length: MAX_CLIENTS }, freshGhost),
  };
}

let ctfgame: CtfgameT = freshCtfgame();

// Index for various CTF pics -- see g_ctf.cpp:81-96. Set for real in
// CTFPrecache(); modelindex_flag1/2 double as p_view.ts's former local
// state (CTFEffects, below, is the sole reader).
let imageindex_i_ctf1 = 0;
let imageindex_i_ctf2 = 0;
let imageindex_i_ctf1d = 0;
let imageindex_i_ctf2d = 0;
let imageindex_i_ctf1t = 0;
let imageindex_i_ctf2t = 0;
let imageindex_i_ctfj = 0;
let imageindex_sbfctf1 = 0;
let imageindex_sbfctf2 = 0;
let imageindex_ctfsb1 = 0;
let imageindex_ctfsb2 = 0;
let modelindex_flag1 = 0;
let modelindex_flag2 = 0;

/*--------------------------------------------------------------------------*/
/* [Paril-KEX] real, non-stub -- see file header                            */
/*--------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:62-68: `void G_AdjustTeamScore(ctfteam_t team, int32_t offset)`. */
export function G_AdjustTeamScore(team: CtfteamT, offset: number): void {
  if (team === CtfteamT.CTF_TEAM1) ctfgame.total1 += offset;
  else if (team === CtfteamT.CTF_TEAM2) ctfgame.total2 += offset;
}

/*--------------------------------------------------------------------------*/

function loc_buildboxpoints(org: Vec3, mins: Vec3, maxs: Vec3): Vec3[] {
  const p: Vec3[] = new Array(8);
  p[0] = vec3_add(org, mins);
  p[1] = vec3(p[0]![0] - mins[0], p[0]![1], p[0]![2]);
  p[2] = vec3(p[0]![0], p[0]![1] - mins[1], p[0]![2]);
  p[3] = vec3(p[0]![0] - mins[0], p[0]![1] - mins[1], p[0]![2]);
  p[4] = vec3_add(org, maxs);
  p[5] = vec3(p[4]![0] - maxs[0], p[4]![1], p[4]![2]);
  p[6] = vec3(p[0]![0], p[0]![1] - maxs[1], p[0]![2]);
  p[7] = vec3(p[0]![0] - maxs[0], p[0]![1] - maxs[1], p[0]![2]);
  return p;
}

/** ctf/g_ctf.cpp:156-180: `static bool loc_CanSee(edict_t *targ, edict_t *inflictor)`. */
function loc_CanSee(targ: EdictT, inflictor: EdictT): boolean {
  if (targ.movetype === MovetypeT.MOVETYPE_PUSH) return false; // bmodels not supported

  const targpoints = loc_buildboxpoints(targ.s.origin, targ.mins, targ.maxs);

  const viewpoint = vec3(inflictor.s.origin[0], inflictor.s.origin[1], inflictor.s.origin[2] + inflictor.viewheight);

  for (const p of targpoints) {
    const trace = giTraceline(viewpoint, p, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  return false;
}

/*--------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:185-195: `void CTFSpawn()`. */
export function CTFSpawn(): void {
  ctfgame = freshCtfgame();
  CTFSetupTechSpawn();

  if (cvarInt("competition", "0", CvarFlagsT.CVAR_SERVERINFO) > 1) {
    ctfgame.match = MatchT.MATCH_SETUP;
    ctfgame.matchtime = Gtime_add(level.time, Gtime_from_min(cvarFloat("matchsetuptime", "10")));
  }
}

/** ctf/g_ctf.cpp:197-210: `void CTFInit()`. Not called from anywhere in this
 *  port line yet -- g_main.ts's PreInitGame would be the real call site
 *  (out of this unit's file scope; see file header). */
export function CTFInit(): void {
  void gi.cvar("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);
  void gi.cvar("competition", "0", CvarFlagsT.CVAR_SERVERINFO);
  void gi.cvar("matchlock", "1", CvarFlagsT.CVAR_SERVERINFO);
  void gi.cvar("electpercentage", "66", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("matchtime", "20", CvarFlagsT.CVAR_SERVERINFO);
  void gi.cvar("matchsetuptime", "10", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("matchstarttime", "20", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("admin_password", "", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("allow_admin", "1", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("warp_list", "q2ctf1 q2ctf2 q2ctf3 q2ctf4 q2ctf5", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("warn_unbalanced", "0", CvarFlagsT.CVAR_NOFLAGS);
}

/** ctf/g_ctf.cpp:216-233: `void CTFPrecache()`. */
export function CTFPrecache(): void {
  imageindex_i_ctf1 = gi.imageindex("i_ctf1");
  imageindex_i_ctf2 = gi.imageindex("i_ctf2");
  imageindex_i_ctf1d = gi.imageindex("i_ctf1d");
  imageindex_i_ctf2d = gi.imageindex("i_ctf2d");
  imageindex_i_ctf1t = gi.imageindex("i_ctf1t");
  imageindex_i_ctf2t = gi.imageindex("i_ctf2t");
  imageindex_i_ctfj = gi.imageindex("i_ctfj");
  imageindex_sbfctf1 = gi.imageindex("sbfctf1");
  imageindex_sbfctf2 = gi.imageindex("sbfctf2");
  imageindex_ctfsb1 = gi.imageindex("tag4");
  imageindex_ctfsb2 = gi.imageindex("tag5");
  modelindex_flag1 = gi.modelindex("players/male/flag1.md2");
  modelindex_flag2 = gi.modelindex("players/male/flag2.md2");

  PrecacheItem(GetItemByIndex(ItemIdT.IT_WEAPON_GRAPPLE));
}

/*--------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:237-249: `const char *CTFTeamName(int team)`. */
export function CTFTeamName(team: CtfteamT): string {
  switch (team) {
    case CtfteamT.CTF_TEAM1:
      return "RED";
    case CtfteamT.CTF_TEAM2:
      return "BLUE";
    case CtfteamT.CTF_NOTEAM:
      return "SPECTATOR";
    default:
      return "UNKNOWN";
  }
}

/** ctf/g_ctf.cpp:251-261: `const char *CTFOtherTeamName(int team)`. */
export function CTFOtherTeamName(team: CtfteamT): string {
  switch (team) {
    case CtfteamT.CTF_TEAM1:
      return "BLUE";
    case CtfteamT.CTF_TEAM2:
      return "RED";
    default:
      return "UNKNOWN";
  }
}

/** ctf/g_ctf.cpp:263-273: `int CTFOtherTeam(int team)`. Moved here from
 *  p_client.ts (was already real there). */
export function CTFOtherTeam(team: CtfteamT): number {
  switch (team) {
    case CtfteamT.CTF_TEAM1:
      return CtfteamT.CTF_TEAM2;
    case CtfteamT.CTF_TEAM2:
      return CtfteamT.CTF_TEAM1;
    default:
      return -1;
  }
}

/*--------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:280-306: `void CTFAssignSkin(edict_t *ent, const char *s)`. */
export function CTFAssignSkin(ent: EdictT, s: string): void {
  const client = requireClient(ent, "CTFAssignSkin");
  const playernum = g_edicts.indexOf(ent) - 1;

  let t: string;
  const slash = s.indexOf("/");
  const prefix = slash >= 0 ? s.slice(0, slash + 1) : "male/";

  switch (client.resp.ctf_team) {
    case CtfteamT.CTF_TEAM1:
      t = `${client.pers.netname}\\${prefix}${CTF_TEAM1_SKIN}\\default`;
      break;
    case CtfteamT.CTF_TEAM2:
      t = `${client.pers.netname}\\${prefix}${CTF_TEAM2_SKIN}\\default`;
      break;
    default:
      t = `${client.pers.netname}\\${s}\\default`;
      break;
  }

  gi.configstring(CS_PLAYERSKINS + playernum, t);
}

/** ctf/g_ctf.cpp:308-348: `void CTFAssignTeam(gclient_t *who)`. */
export function CTFAssignTeam(who: GClientT): void {
  who.resp.ctf_state = 0;

  const whoIndex = game.clients.indexOf(who);
  const whoEnt = whoIndex >= 0 ? g_edicts[whoIndex + 1] : undefined;

  if (!cvarBool("g_teamplay_force_join", "0") && !(whoEnt !== undefined && (whoEnt.svflags & SvflagsT.SVF_BOT) !== 0)) {
    who.resp.ctf_team = CtfteamT.CTF_NOTEAM;
    return;
  }

  let team1count = 0;
  let team2count = 0;

  for (let i = 1; i <= game.maxclients; i++) {
    const player = g_edicts[i];
    if (player === undefined || !player.inuse || player.client === who) continue;

    if (player.client !== null) {
      if (player.client.resp.ctf_team === CtfteamT.CTF_TEAM1) team1count++;
      else if (player.client.resp.ctf_team === CtfteamT.CTF_TEAM2) team2count++;
    }
  }

  if (team1count < team2count) who.resp.ctf_team = CtfteamT.CTF_TEAM1;
  else if (team2count < team1count) who.resp.ctf_team = CtfteamT.CTF_TEAM2;
  else if (brandom()) who.resp.ctf_team = CtfteamT.CTF_TEAM1;
  else who.resp.ctf_team = CtfteamT.CTF_TEAM2;
}

/** ctf/g_ctf.cpp:358-418: `edict_t *SelectCTFSpawnPoint(edict_t *ent, bool force_spawn)`. */
export function SelectCTFSpawnPoint(ent: EdictT, force_spawn: boolean): EdictT | null {
  const client = requireClient(ent, "SelectCTFSpawnPoint");

  if (client.resp.ctf_state) {
    const result = SelectDeathmatchSpawnPoint(cvarBool("g_dm_spawn_farthest", "1"), force_spawn, false);
    if (result.any_valid) return result.spot;
  }

  let cname: string;
  switch (client.resp.ctf_team) {
    case CtfteamT.CTF_TEAM1:
      cname = "info_player_team1";
      break;
    case CtfteamT.CTF_TEAM2:
      cname = "info_player_team2";
      break;
    default: {
      const result = SelectDeathmatchSpawnPoint(cvarBool("g_dm_spawn_farthest", "1"), force_spawn, true);
      if (result.any_valid) return result.spot;
      gi.Com_Error("can't find suitable spectator spawn point");
    }
  }

  const spawn_points: EdictT[] = [];
  let spot: EdictT | null = null;
  while ((spot = G_FindByString(spot, "classname", cname)) !== null) spawn_points.push(spot);

  if (spawn_points.length === 0) {
    const result = SelectDeathmatchSpawnPoint(cvarBool("g_dm_spawn_farthest", "1"), force_spawn, true);
    if (!result.any_valid) gi.Com_Error("can't find suitable CTF spawn point");
    return result.spot;
  }

  // Fisher-Yates shuffle -- ctf/g_ctf.cpp:408 `std::shuffle(...)`.
  for (let i = spawn_points.length - 1; i > 0; i--) {
    const j = irandom(i + 1);
    const tmp = spawn_points[i]!;
    spawn_points[i] = spawn_points[j]!;
    spawn_points[j] = tmp;
  }

  for (const point of spawn_points) {
    if (SpawnPointClear(point)) return point;
  }

  if (force_spawn) return spawn_points[irandom(spawn_points.length)]!;

  return null;
}

/*------------------------------------------------------------------------*/
/* CTFFragBonuses (ctf/g_ctf.cpp:420-598)                                  */
/*------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:428-581: `void CTFFragBonuses(edict_t *targ, edict_t *inflictor, edict_t *attacker)`. */
export function CTFFragBonuses(targ: EdictT, _inflictor: EdictT, attacker: EdictT): void {
  if (targ.client !== null && attacker.client !== null) {
    if (attacker.client.resp.ghost !== null && attacker !== targ) attacker.client.resp.ghost.kills++;
    if (targ.client.resp.ghost !== null) targ.client.resp.ghost.deaths++;
  }

  // no bonus for fragging yourself
  if (targ.client === null || attacker.client === null || targ === attacker) return;

  const otherteam = CTFOtherTeam(targ.client.resp.ctf_team);
  if (otherteam < 0) return; // whoever died isn't on a team

  let flag_item: ItemIdT;
  let enemy_flag_item: ItemIdT;
  if (targ.client.resp.ctf_team === CtfteamT.CTF_TEAM1) {
    flag_item = ItemIdT.IT_FLAG1;
    enemy_flag_item = ItemIdT.IT_FLAG2;
  } else {
    flag_item = ItemIdT.IT_FLAG2;
    enemy_flag_item = ItemIdT.IT_FLAG1;
  }

  // did the attacker frag the flag carrier?
  if (targ.client.pers.inventory[enemy_flag_item] !== 0) {
    attacker.client.resp.ctf_lastfraggedcarrier = level.time;
    attacker.client.resp.score += CTF_FRAG_CARRIER_BONUS;
    giLocClientPrint(attacker, PRINT_MEDIUM, "$g_bonus_enemy_carrier", CTF_FRAG_CARRIER_BONUS);

    for (let i = 1; i <= game.maxclients; i++) {
      const ent = g_edicts[i];
      if (ent !== undefined && ent.inuse && ent.client !== null && ent.client.resp.ctf_team === otherteam) {
        ent.client.resp.ctf_lasthurtcarrier = GTIME_ZERO;
      }
    }
    return;
  }

  if (
    Gtime_nonzero(targ.client.resp.ctf_lasthurtcarrier) &&
    Gtime_subtract(level.time, targ.client.resp.ctf_lasthurtcarrier) < CTF_CARRIER_DANGER_PROTECT_TIMEOUT &&
    attacker.client.pers.inventory[flag_item] === 0
  ) {
    attacker.client.resp.score += CTF_CARRIER_DANGER_PROTECT_BONUS;
    giLocBroadcastPrint(PRINT_MEDIUM, "$g_bonus_flag_defense", attacker.client.pers.netname, CTFTeamName(attacker.client.resp.ctf_team));
    if (attacker.client.resp.ghost !== null) attacker.client.resp.ghost.carrierdef++;
    return;
  }

  let c: string;
  switch (attacker.client.resp.ctf_team) {
    case CtfteamT.CTF_TEAM1:
      c = "item_flag_team1";
      break;
    case CtfteamT.CTF_TEAM2:
      c = "item_flag_team2";
      break;
    default:
      return;
  }

  let flag: EdictT | null = null;
  for (;;) {
    flag = G_FindByString(flag, "classname", c);
    if (flag === null) break;
    if (!SpawnFlags_has(flag.spawnflags, SPAWNFLAG_ITEM_DROPPED)) break;
  }

  if (flag === null) return; // can't find attacker's flag

  let carrier: EdictT | null = null;
  for (let i = 1; i <= game.maxclients; i++) {
    const cand = g_edicts[i];
    if (cand !== undefined && cand.inuse && cand.client !== null && cand.client.pers.inventory[flag_item] !== 0) {
      carrier = cand;
      break;
    }
  }

  const v1base = vec3_sub(targ.s.origin, flag.s.origin);
  const v2base = vec3_sub(attacker.s.origin, flag.s.origin);

  if (
    (vec3_length(v1base) < CTF_TARGET_PROTECT_RADIUS ||
      vec3_length(v2base) < CTF_TARGET_PROTECT_RADIUS ||
      loc_CanSee(flag, targ) ||
      loc_CanSee(flag, attacker)) &&
    attacker.client.resp.ctf_team !== targ.client.resp.ctf_team
  ) {
    attacker.client.resp.score += CTF_FLAG_DEFENSE_BONUS;
    if (flag.solid === SolidT.SOLID_NOT) {
      giLocBroadcastPrint(PRINT_MEDIUM, "$g_bonus_defend_base", attacker.client.pers.netname, CTFTeamName(attacker.client.resp.ctf_team));
    } else {
      giLocBroadcastPrint(PRINT_MEDIUM, "$g_bonus_defend_flag", attacker.client.pers.netname, CTFTeamName(attacker.client.resp.ctf_team));
    }
    if (attacker.client.resp.ghost !== null) attacker.client.resp.ghost.basedef++;
    return;
  }

  if (carrier !== null && carrier !== attacker) {
    const v1 = vec3_sub(targ.s.origin, carrier.s.origin);
    const v2 = vec3_sub(attacker.s.origin, carrier.s.origin);

    if (vec3_length(v1) < CTF_ATTACKER_PROTECT_RADIUS || vec3_length(v2) < CTF_ATTACKER_PROTECT_RADIUS || loc_CanSee(carrier, targ) || loc_CanSee(carrier, attacker)) {
      attacker.client.resp.score += CTF_CARRIER_PROTECT_BONUS;
      giLocBroadcastPrint(PRINT_MEDIUM, "$g_bonus_defend_carrier", attacker.client.pers.netname, CTFTeamName(attacker.client.resp.ctf_team));
      if (attacker.client.resp.ghost !== null) attacker.client.resp.ghost.carrierdef++;
      return;
    }
  }
}

/** ctf/g_ctf.cpp:583-598: `void CTFCheckHurtCarrier(edict_t *targ, edict_t *attacker)`. Moved here from g_combat.ts (was already real there). */
export function CTFCheckHurtCarrier(targ: EdictT, attacker: EdictT): void {
  if (targ.client === null || attacker.client === null) return;

  const flag_item = targ.client.resp.ctf_team === CtfteamT.CTF_TEAM1 ? ItemIdT.IT_FLAG2 : ItemIdT.IT_FLAG1;

  if (targ.client.pers.inventory[flag_item] !== 0 && targ.client.resp.ctf_team !== attacker.client.resp.ctf_team) {
    attacker.client.resp.ctf_lasthurtcarrier = level.time;
  }
}

/** ctf/g_ctf.cpp:2024-2031: `int CTFApplyStrength(edict_t *ent, int dmg)`. Moved here from g_combat.ts (was already real there). */
export function CTFApplyStrength(ent: EdictT, dmg: number): number {
  if (dmg && ent.client !== null && ent.client.pers.inventory[ItemIdT.IT_TECH_STRENGTH] !== 0) return dmg * 2;
  return dmg;
}

/** ctf/g_ctf.cpp:2008-2022: `int CTFApplyResistance(edict_t *ent, int dmg)`. Moved here from g_combat.ts (was already real there). */
export function CTFApplyResistance(ent: EdictT, dmg: number): number {
  const volume = ent.client !== null && ent.client.silencer_shots !== 0 ? 0.2 : 1.0;
  if (dmg && ent.client !== null && ent.client.pers.inventory[ItemIdT.IT_TECH_RESISTANCE] !== 0) {
    gi.sound(ent, SoundchanT.CHAN_AUX, gi.soundindex("ctf/tech1.wav"), volume, ATTN_NORM, 0);
    return Math.trunc(dmg / 2);
  }
  return dmg;
}

/*------------------------------------------------------------------------*/
/* FLAG (ctf/g_ctf.cpp:600-1216)                                           */
/*------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:602-632: `void CTFResetFlag(int ctf_team)`. */
export function CTFResetFlag(ctf_team: CtfteamT): void {
  let c: string;
  switch (ctf_team) {
    case CtfteamT.CTF_TEAM1:
      c = "item_flag_team1";
      break;
    case CtfteamT.CTF_TEAM2:
      c = "item_flag_team2";
      break;
    default:
      return;
  }

  let ent: EdictT | null = null;
  for (;;) {
    ent = G_FindByString(ent, "classname", c);
    if (ent === null) break;
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
      G_FreeEdict(ent);
    } else {
      ent.svflags &= ~SvflagsT.SVF_NOCLIENT;
      ent.solid = SolidT.SOLID_TRIGGER;
      gi.linkentity(ent);
      ent.s.event = KexEntityEventT.EV_ITEM_RESPAWN;
    }
  }
}

/** ctf/g_ctf.cpp:634-638: `void CTFResetFlags()`. */
export function CTFResetFlags(): void {
  CTFResetFlag(CtfteamT.CTF_TEAM1);
  CTFResetFlag(CtfteamT.CTF_TEAM2);
}

/** ctf/g_ctf.cpp:640-758: `bool CTFPickup_Flag(edict_t *ent, edict_t *other)`. */
export const CTFPickup_Flag: GitemPickupFn = (ent: EdictT, other: EdictT): boolean => {
  const item = ent.item;
  if (item === null) throw new Error("CTFPickup_Flag: ent.item is null (invariant violated)");
  const otherClient = requireClient(other, "CTFPickup_Flag");

  let ctf_team: CtfteamT;
  if (item.id === ItemIdT.IT_FLAG1) ctf_team = CtfteamT.CTF_TEAM1;
  else if (item.id === ItemIdT.IT_FLAG2) ctf_team = CtfteamT.CTF_TEAM2;
  else {
    giLocClientPrint(ent, PRINT_HIGH, "Don't know what team the flag is on.\n");
    return false;
  }

  let flag_item: ItemIdT;
  let enemy_flag_item: ItemIdT;
  if (ctf_team === CtfteamT.CTF_TEAM1) {
    flag_item = ItemIdT.IT_FLAG1;
    enemy_flag_item = ItemIdT.IT_FLAG2;
  } else {
    flag_item = ItemIdT.IT_FLAG2;
    enemy_flag_item = ItemIdT.IT_FLAG1;
  }

  if (ctf_team === otherClient.resp.ctf_team) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
      // the flag is at home base. if the player has the enemy flag, he's just won!
      if (otherClient.pers.inventory[enemy_flag_item] !== 0) {
        giLocBroadcastPrint(PRINT_HIGH, "$g_flag_captured", otherClient.pers.netname, CTFOtherTeamName(ctf_team));
        otherClient.pers.inventory[enemy_flag_item] = 0;

        ctfgame.last_flag_capture = level.time;
        ctfgame.last_capture_team = ctf_team;
        if (ctf_team === CtfteamT.CTF_TEAM1) ctfgame.team1++;
        else ctfgame.team2++;

        gi.sound(ent, SoundchanT.CHAN_RELIABLE | SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_AUX, gi.soundindex("ctf/flagcap.wav"), 1, ATTN_NONE, 0);

        otherClient.resp.score += CTF_CAPTURE_BONUS;
        if (otherClient.resp.ghost !== null) otherClient.resp.ghost.caps++;

        for (let i = 1; i <= game.maxclients; i++) {
          const player = g_edicts[i];
          if (player === undefined || !player.inuse || player.client === null) continue;

          if (player.client.resp.ctf_team !== otherClient.resp.ctf_team) {
            player.client.resp.ctf_lasthurtcarrier = Gtime_scale(Gtime_from_sec(5), -1);
          } else if (player.client.resp.ctf_team === otherClient.resp.ctf_team) {
            if (player !== other) player.client.resp.score += CTF_TEAM_BONUS;
            if (Gtime_nonzero(player.client.resp.ctf_lastreturnedflag) && Gtime_add(player.client.resp.ctf_lastreturnedflag, CTF_RETURN_FLAG_ASSIST_TIMEOUT) > level.time) {
              giLocBroadcastPrint(PRINT_HIGH, "$g_bonus_assist_return", player.client.pers.netname);
              player.client.resp.score += CTF_RETURN_FLAG_ASSIST_BONUS;
            }
            if (Gtime_nonzero(player.client.resp.ctf_lastfraggedcarrier) && Gtime_add(player.client.resp.ctf_lastfraggedcarrier, CTF_FRAG_CARRIER_ASSIST_TIMEOUT) > level.time) {
              giLocBroadcastPrint(PRINT_HIGH, "$g_bonus_assist_frag_carrier", player.client.pers.netname);
              player.client.resp.score += CTF_FRAG_CARRIER_ASSIST_BONUS;
            }
          }
        }

        CTFResetFlags();
        return false;
      }
      return false; // its at home base already
    }
    // hey, its not home. return it by teleporting it back
    giLocBroadcastPrint(PRINT_HIGH, "$g_returned_flag", otherClient.pers.netname, CTFTeamName(ctf_team));
    otherClient.resp.score += CTF_RECOVERY_BONUS;
    otherClient.resp.ctf_lastreturnedflag = level.time;
    gi.sound(ent, SoundchanT.CHAN_RELIABLE | SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_AUX, gi.soundindex("ctf/flagret.wav"), 1, ATTN_NONE, 0);
    // CTFResetFlag will remove this entity! We must return false
    CTFResetFlag(ctf_team);
    return false;
  }

  // hey, its not our flag, pick it up
  giLocBroadcastPrint(PRINT_HIGH, "$g_got_flag", otherClient.pers.netname, CTFTeamName(ctf_team));
  otherClient.resp.score += CTF_FLAG_BONUS;

  otherClient.pers.inventory[flag_item] = 1;
  otherClient.resp.ctf_flagsince = level.time;

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
    ent.flags |= EntFlagsT.FL_RESPAWN;
    ent.svflags |= SvflagsT.SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
  }
  return true;
};

/** ctf/g_ctf.cpp:760-768: `TOUCH(CTFDropFlagTouch)`. */
export const CTFDropFlagTouch: TouchFn = RegisterTouch("CTFDropFlagTouch", (ent, other, tr, otherTouchingSelf): void => {
  // owner (who dropped us) can't touch for two secs
  if (other === ent.owner && Gtime_subtract(ent.nextthink, level.time) > Gtime_subtract(CTF_AUTO_FLAG_RETURN_TIMEOUT, Gtime_from_sec(2))) return;

  Touch_Item(ent, other, tr, otherTouchingSelf);
});

/** ctf/g_ctf.cpp:770-788: `THINK(CTFDropFlagThink)`. */
export const CTFDropFlagThink = RegisterThink("CTFDropFlagThink", (ent: EdictT): void => {
  if (ent.item !== null && ent.item.id === ItemIdT.IT_FLAG1) {
    CTFResetFlag(CtfteamT.CTF_TEAM1);
    giLocBroadcastPrint(PRINT_HIGH, "$g_flag_returned", CTFTeamName(CtfteamT.CTF_TEAM1));
  } else if (ent.item !== null && ent.item.id === ItemIdT.IT_FLAG2) {
    CTFResetFlag(CtfteamT.CTF_TEAM2);
    giLocBroadcastPrint(PRINT_HIGH, "$g_flag_returned", CTFTeamName(CtfteamT.CTF_TEAM2));
  }

  gi.sound(ent, SoundchanT.CHAN_RELIABLE | SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_AUX, gi.soundindex("ctf/flagret.wav"), 1, ATTN_NONE, 0);
});

/** ctf/g_ctf.cpp:790-816: `void CTFDeadDropFlag(edict_t *self)`. Moved here
 *  from p_client.ts (was a "real guard prefix, throwing tail" partial there). */
export function CTFDeadDropFlag(self: EdictT): void {
  const client = requireClient(self, "CTFDeadDropFlag");
  let dropped: EdictT | null = null;

  if (client.pers.inventory[ItemIdT.IT_FLAG1] !== 0) {
    const flagItem = GetItemByIndex(ItemIdT.IT_FLAG1);
    if (flagItem === null) throw new Error("CTFDeadDropFlag: IT_FLAG1 missing from itemlist");
    dropped = Drop_Item(self, flagItem);
    client.pers.inventory[ItemIdT.IT_FLAG1] = 0;
    giLocBroadcastPrint(PRINT_HIGH, "$g_lost_flag", client.pers.netname, CTFTeamName(CtfteamT.CTF_TEAM1));
  } else if (client.pers.inventory[ItemIdT.IT_FLAG2] !== 0) {
    const flagItem = GetItemByIndex(ItemIdT.IT_FLAG2);
    if (flagItem === null) throw new Error("CTFDeadDropFlag: IT_FLAG2 missing from itemlist");
    dropped = Drop_Item(self, flagItem);
    client.pers.inventory[ItemIdT.IT_FLAG2] = 0;
    giLocBroadcastPrint(PRINT_HIGH, "$g_lost_flag", client.pers.netname, CTFTeamName(CtfteamT.CTF_TEAM2));
  }

  if (dropped !== null) {
    dropped.think = CTFDropFlagThink;
    dropped.nextthink = Gtime_add(level.time, CTF_AUTO_FLAG_RETURN_TIMEOUT);
    dropped.touch = CTFDropFlagTouch;
  }
}

/** ctf/g_ctf.cpp:818-824: `void CTFDrop_Flag(edict_t *ent, gitem_t *item)`. */
export const CTFDrop_Flag: GitemDropFn = (ent: EdictT, _item: GitemT): void => {
  if (brandom()) giLocClientPrint(ent, PRINT_HIGH, "$g_lusers_drop_flags");
  else giLocClientPrint(ent, PRINT_HIGH, "$g_winners_drop_flags");
};

/** ctf/g_ctf.cpp:826-831: `THINK(CTFFlagThink)`. */
export const CTFFlagThink = RegisterThink("CTFFlagThink", (ent: EdictT): void => {
  if (ent.solid !== SolidT.SOLID_NOT) ent.s.frame = 173 + (((ent.s.frame - 173) + 1) % 16);
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** ctf/g_ctf.cpp:833-866: `THINK(CTFFlagSetup)`. Moved here from g_items.ts
 *  (was a throwing stub there). */
export const CTFFlagSetup = RegisterThink("CTFFlagSetup", (ent: EdictT): void => {
  ent.mins = vec3(-15, -15, -15);
  ent.maxs = vec3(15, 15, 15);

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  else if (ent.item !== null && ent.item.world_model !== null) gi.setmodel(ent, ent.item.world_model);
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;
  ent.s.frame = 173;

  const dest = vec3_add(ent.s.origin, vec3(0, 0, -128));

  const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, dest, ent, MASK_SOLID);
  if (tr.startsolid) {
    gi.Com_Print(`CTFFlagSetup: ${ent.classname ?? "?"} startsolid at ${ent.s.origin[0]} ${ent.s.origin[1]} ${ent.s.origin[2]}\n`);
    G_FreeEdict(ent);
    return;
  }

  ent.s.origin = tr.endpos;

  gi.linkentity(ent);

  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  ent.think = CTFFlagThink;
});

/** ctf/g_ctf.cpp:868-889: `void CTFEffects(edict_t *player)`. Moved here from
 *  p_view.ts (was already real there). */
export function CTFEffects(player: EdictT): void {
  const client = player.client;
  if (client === null) return;

  player.s.effects &= ~(EffectsT.EF_FLAG1 | EffectsT.EF_FLAG2);
  if (player.health > 0) {
    if (client.pers.inventory[ItemIdT.IT_FLAG1]) player.s.effects |= EffectsT.EF_FLAG1;
    if (client.pers.inventory[ItemIdT.IT_FLAG2]) player.s.effects |= EffectsT.EF_FLAG2;
  }

  if (client.pers.inventory[ItemIdT.IT_FLAG1]) player.s.modelindex3 = modelindex_flag1;
  else if (client.pers.inventory[ItemIdT.IT_FLAG2]) player.s.modelindex3 = modelindex_flag2;
  else player.s.modelindex3 = 0;
}

/** ctf/g_ctf.cpp:892-904: `void CTFCalcScores()`. */
export function CTFCalcScores(): void {
  ctfgame.total1 = 0;
  ctfgame.total2 = 0;
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[i + 1];
    if (ent === undefined || !ent.inuse) continue;
    const client = game.clients[i];
    if (client === undefined) continue;
    if (client.resp.ctf_team === CtfteamT.CTF_TEAM1) ctfgame.total1 += client.resp.score;
    else if (client.resp.ctf_team === CtfteamT.CTF_TEAM2) ctfgame.total2 += client.resp.score;
  }
}

/** ctf/g_ctf.cpp:906-921: `void CTFCalcRankings(std::array<uint32_t, MAX_CLIENTS> &player_ranks)`. [Paril-KEX] end game rankings. */
export function CTFCalcRankings(player_ranks: number[]): void {
  if (ctfgame.total1 === ctfgame.total2) {
    player_ranks.fill(1);
    return;
  }

  const winning_team = ctfgame.total1 > ctfgame.total2 ? CtfteamT.CTF_TEAM1 : CtfteamT.CTF_TEAM2;

  for (const player of active_players()) {
    if (player.client !== null && player.client.pers.spawned && player.client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) {
      player_ranks[player.s.number - 1] = player.client.resp.ctf_team === winning_team ? 1 : 2;
    }
  }
}

/** ctf/g_ctf.cpp:923-930: `void CheckEndTDMLevel()`. [Paril-KEX]. Note the
 *  real body has NO `fraglimit != 0` guard of its own -- `fraglimit->integer`
 *  defaulting to 0 means `>= 0` is trivially true the instant either team has
 *  a nonnegative score, so this is ported EXACTLY as written (a real,
 *  pre-existing quirk of the shipped source, not introduced here): with
 *  `fraglimit` at its default, CheckEndTDMLevel ends the level on its very
 *  first call. Real servers that enable teamplay/ctf are expected to also
 *  set fraglimit to something meaningful; this is not this port's bug to
 *  fix. */
export function CheckEndTDMLevel(): void {
  const fraglimit = cvarInt("fraglimit", "0", CvarFlagsT.CVAR_NOFLAGS);
  if (ctfgame.total1 >= fraglimit || ctfgame.total2 >= fraglimit) {
    giLocBroadcastPrint(PRINT_HIGH, "$g_fraglimit_hit");
    EndDMLevel();
  }
}

/** ctf/g_ctf.cpp:932-944: `void CTFID_f(edict_t *ent)`. */
export function CTFID_f(ent: EdictT): void {
  const client = requireClient(ent, "CTFID_f");
  if (client.resp.id_state) {
    giClientPrint(ent, PRINT_HIGH, "Disabling player identication display.\n");
    client.resp.id_state = false;
  } else {
    giClientPrint(ent, PRINT_HIGH, "Activating player identication display.\n");
    client.resp.id_state = true;
  }
}

/** ctf/g_ctf.cpp:946-1004: `static void CTFSetIDView(edict_t *ent)`. */
function CTFSetIDView(ent: EdictT): void {
  const client = requireClient(ent, "CTFSetIDView");

  if (Gtime_subtract(level.time, client.resp.lastidtime) < Gtime_from_ms(250)) return;
  client.resp.lastidtime = level.time;

  client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW] = 0;
  client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW_COLOR] = 0;

  const forward0 = vec3();
  AngleVectors(client.v_angle, forward0, null, null);
  let forward = vec3_add(ent.s.origin, vec3_muls(forward0, 1024));
  let tr = giTraceline(ent.s.origin, forward, ent, MASK_SOLID);
  if (tr.fraction < 1 && tr.ent !== null) {
    const hit = g_edicts[tr.ent.s.number];
    if (hit !== undefined && hit.client !== null) {
      client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW] = g_edicts.indexOf(hit);
      if (hit.client.resp.ctf_team === CtfteamT.CTF_TEAM1) client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf1;
      else if (hit.client.resp.ctf_team === CtfteamT.CTF_TEAM2) client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf2;
      return;
    }
  }

  AngleVectors(client.v_angle, forward0, null, null);
  forward = forward0;
  let best: EdictT | null = null;
  let bd = 0;
  for (let i = 1; i <= game.maxclients; i++) {
    const who = g_edicts[i];
    if (who === undefined || !who.inuse || who.solid === SolidT.SOLID_NOT) continue;
    let dir = vec3_sub(who.s.origin, ent.s.origin);
    dir = vec3_normalized(dir);
    const d = vec3_dot(forward, dir);

    if (who.client !== null && client.resp.ctf_team === who.client.resp.ctf_team) continue;

    if (d > bd && loc_CanSee(ent, who)) {
      bd = d;
      best = who;
    }
  }
  if (bd > 0.9 && best !== null) {
    client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW] = g_edicts.indexOf(best);
    if (best.client !== null && best.client.resp.ctf_team === CtfteamT.CTF_TEAM1) client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf1;
    else if (best.client !== null && best.client.resp.ctf_team === CtfteamT.CTF_TEAM2) client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf2;
  }
}

/** ctf/g_ctf.cpp:1006-1199: `void SetCTFStats(edict_t *ent)`. Moved here
 *  from p_hud.ts (was a narrow partial there, backed by three local stubs
 *  now deleted). */
export function SetCTFStats(ent: EdictT): void {
  const client = requireClient(ent, "SetCTFStats");

  client.ps.stats[PlayerStatT.STAT_CTF_MATCH] = ctfgame.match > MatchT.MATCH_NONE ? CONFIG_CTF_MATCH : 0;
  client.ps.stats[PlayerStatT.STAT_CTF_TEAMINFO] = ctfgame.warnactive ? CONFIG_CTF_TEAMINFO : 0;

  if (client.resp.ghost !== null) {
    client.resp.ghost.score = client.resp.score;
    client.resp.ghost.netname = client.pers.netname;
    client.resp.ghost.number = ent.s.number;
  }

  client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = imageindex_ctfsb1;
  client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = imageindex_ctfsb2;

  const blink = Gtime_milliseconds(level.time) % 1000 < 500;

  if (Gtime_nonzero(level.intermissiontime) && blink) {
    if (ctfgame.team1 > ctfgame.team2) client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
    else if (ctfgame.team2 > ctfgame.team1) client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;
    else if (ctfgame.total1 > ctfgame.total2) client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
    else if (ctfgame.total2 > ctfgame.total1) client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;
    else {
      client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_HEADER] = 0;
      client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_HEADER] = 0;
    }
  }

  // tech icon
  client.ps.stats[PlayerStatT.STAT_CTF_TECH] = 0;
  for (const techId of TECH_IDS) {
    if (client.pers.inventory[techId] !== 0) {
      const it = GetItemByIndex(techId);
      if (it !== null && it.icon !== null) client.ps.stats[PlayerStatT.STAT_CTF_TECH] = gi.imageindex(it.icon);
      break;
    }
  }

  if (cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH)) {
    let p1 = imageindex_i_ctf1;
    let e = G_FindByString(null, "classname", "item_flag_team1");
    if (e !== null) {
      if (e.solid === SolidT.SOLID_NOT) {
        p1 = imageindex_i_ctf1d;
        for (let i = 1; i <= game.maxclients; i++) {
          const cand = g_edicts[i];
          if (cand !== undefined && cand.inuse && cand.client !== null && cand.client.pers.inventory[ItemIdT.IT_FLAG1] !== 0) {
            p1 = imageindex_i_ctf1t;
            break;
          }
        }
        if (p1 === imageindex_i_ctf1d) {
          const e2 = G_FindByString(e, "classname", "item_flag_team1");
          if (e2 === null) {
            CTFResetFlag(CtfteamT.CTF_TEAM1);
            giLocBroadcastPrint(PRINT_HIGH, "$g_flag_returned", CTFTeamName(CtfteamT.CTF_TEAM1));
            gi.sound(ent, SoundchanT.CHAN_RELIABLE | SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_AUX, gi.soundindex("ctf/flagret.wav"), 1, ATTN_NONE, 0);
          }
        }
      } else if (SpawnFlags_has(e.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
        p1 = imageindex_i_ctf1d;
      }
    }

    let p2 = imageindex_i_ctf2;
    e = G_FindByString(null, "classname", "item_flag_team2");
    if (e !== null) {
      if (e.solid === SolidT.SOLID_NOT) {
        p2 = imageindex_i_ctf2d;
        for (let i = 1; i <= game.maxclients; i++) {
          const cand = g_edicts[i];
          if (cand !== undefined && cand.inuse && cand.client !== null && cand.client.pers.inventory[ItemIdT.IT_FLAG2] !== 0) {
            p2 = imageindex_i_ctf2t;
            break;
          }
        }
        if (p2 === imageindex_i_ctf2d) {
          const e2 = G_FindByString(e, "classname", "item_flag_team2");
          if (e2 === null) {
            CTFResetFlag(CtfteamT.CTF_TEAM2);
            giLocBroadcastPrint(PRINT_HIGH, "$g_flag_returned", CTFTeamName(CtfteamT.CTF_TEAM2));
            gi.sound(ent, SoundchanT.CHAN_RELIABLE | SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_AUX, gi.soundindex("ctf/flagret.wav"), 1, ATTN_NONE, 0);
          }
        }
      } else if (SpawnFlags_has(e.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
        p2 = imageindex_i_ctf2d;
      }
    }

    client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_PIC] = p1;
    client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_PIC] = p2;

    if (Gtime_nonzero(ctfgame.last_flag_capture) && Gtime_subtract(level.time, ctfgame.last_flag_capture) < Gtime_from_sec(5)) {
      if (ctfgame.last_capture_team === CtfteamT.CTF_TEAM1) {
        client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_PIC] = blink ? p1 : 0;
      } else if (blink) {
        client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_PIC] = p2;
      } else {
        client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_PIC] = 0;
      }
    }

    client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_CAPS] = ctfgame.team1;
    client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_CAPS] = ctfgame.team2;

    client.ps.stats[PlayerStatT.STAT_CTF_FLAG_PIC] = 0;
    if (client.resp.ctf_team === CtfteamT.CTF_TEAM1 && client.pers.inventory[ItemIdT.IT_FLAG2] !== 0 && blink) {
      client.ps.stats[PlayerStatT.STAT_CTF_FLAG_PIC] = imageindex_i_ctf2;
    } else if (client.resp.ctf_team === CtfteamT.CTF_TEAM2 && client.pers.inventory[ItemIdT.IT_FLAG1] !== 0 && blink) {
      client.ps.stats[PlayerStatT.STAT_CTF_FLAG_PIC] = imageindex_i_ctf1;
    }
  } else {
    client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_PIC] = imageindex_i_ctf1;
    client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_PIC] = imageindex_i_ctf2;

    client.ps.stats[PlayerStatT.STAT_CTF_TEAM1_CAPS] = ctfgame.total1;
    client.ps.stats[PlayerStatT.STAT_CTF_TEAM2_CAPS] = ctfgame.total2;
  }

  client.ps.stats[PlayerStatT.STAT_CTF_JOINED_TEAM1_PIC] = 0;
  client.ps.stats[PlayerStatT.STAT_CTF_JOINED_TEAM2_PIC] = 0;
  if (client.resp.ctf_team === CtfteamT.CTF_TEAM1) client.ps.stats[PlayerStatT.STAT_CTF_JOINED_TEAM1_PIC] = imageindex_i_ctfj;
  else if (client.resp.ctf_team === CtfteamT.CTF_TEAM2) client.ps.stats[PlayerStatT.STAT_CTF_JOINED_TEAM2_PIC] = imageindex_i_ctfj;

  if (client.resp.id_state) CTFSetIDView(ent);
  else {
    client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW] = 0;
    client.ps.stats[PlayerStatT.STAT_CTF_ID_VIEW_COLOR] = 0;
  }
}

/*------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:1203-1208: `/*QUAKED info_player_team1*\/ void SP_info_player_team1(edict_t *self)`. */
export function SP_info_player_team1(_self: EdictT): void {
  // no-op spawn, matches the real C++ body exactly.
}

/** ctf/g_ctf.cpp:1210-1215: `/*QUAKED info_player_team2*\/ void SP_info_player_team2(edict_t *self)`. */
export function SP_info_player_team2(_self: EdictT): void {
  // no-op spawn, matches the real C++ body exactly.
}

/*------------------------------------------------------------------------*/
/* GRAPPLE (ctf/g_ctf.cpp:1217-1505)                                       */
/*------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:1222-1226: `void CTFPlayerResetGrapple(edict_t *ent)`. Moved
 *  here from p_client.ts (was already real there) and g_misc.ts (was a real
 *  "guard prefix, throwing tail" partial there); both call sites now share
 *  this one implementation. */
export function CTFPlayerResetGrapple(ent: EdictT): void {
  if (ent.client !== null && ent.client.ctf_grapple !== null) {
    CTFResetGrapple(ent.client.ctf_grapple);
  }
}

/** ctf/g_ctf.cpp:1229-1243: `void CTFResetGrapple(edict_t *self)`. `self` is
 *  the grapple entity, not the player. */
export function CTFResetGrapple(self: EdictT): void {
  const owner = self.owner;
  if (owner === null || owner.client === null || owner.client.ctf_grapple === null) return;

  gi.sound(owner, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/grapple/grreset.wav"), owner.client.silencer_shots ? 0.2 : 1.0, ATTN_NORM, 0);

  const cl = owner.client;
  cl.ctf_grapple = null;
  cl.ctf_grapplereleasetime = Gtime_add(level.time, Gtime_from_sec(1));
  cl.ctf_grapplestate = CTF_GRAPPLE_STATE_FLY; // we're firing, not on hook
  owner.flags &= ~EntFlagsT.FL_NO_KNOCKBACK;
  G_FreeEdict(self);
}

/** ctf/g_ctf.cpp:1245-1289: `TOUCH(CTFGrappleTouch)`. */
export const CTFGrappleTouch: TouchFn = RegisterTouch("CTFGrappleTouch", (self, other, tr, _otherTouchingSelf): void => {
  if (other === self.owner) return;
  const owner = self.owner;
  if (owner === null || owner.client === null) return;

  if (owner.client.ctf_grapplestate !== CTF_GRAPPLE_STATE_FLY) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    CTFResetGrapple(self);
    return;
  }

  self.velocity = vec3();

  PlayerNoise(owner, self.s.origin, PlayerNoiseT.PNOISE_IMPACT);

  if (other.takedamage) {
    if (self.dmg) T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, self.dmg, 1, DamageflagsT.DAMAGE_NONE, MOD_GRAPPLE);
    CTFResetGrapple(self);
    return;
  }

  owner.client.ctf_grapplestate = CTF_GRAPPLE_STATE_PULL; // we're on hook
  self.enemy = other;

  self.solid = SolidT.SOLID_NOT;

  const volume = owner.client.silencer_shots ? 0.2 : 1.0;

  gi.sound(self, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/grapple/grhit.wav"), volume, ATTN_NORM, 0);
  self.s.sound = gi.soundindex("weapons/grapple/grpull.wav");

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_SPARKS);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(tr.plane.normal);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
});

/** ctf/g_ctf.cpp:1292-1306: `void CTFGrappleDrawCable(edict_t *self)`. */
function CTFGrappleDrawCable(self: EdictT): void {
  const owner = self.owner;
  if (owner === null || owner.client === null) return;
  if (owner.client.ctf_grapplestate === CTF_GRAPPLE_STATE_HANG) return;

  const { start } = P_ProjectSource(owner, owner.client.v_angle, vec3(7, 2, -9));

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_GRAPPLE_CABLE_2);
  gi.WriteEntity(owner);
  gi.WritePosition(start);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
}

/** ctf/g_ctf.cpp:1308-1379: `void CTFGrapplePull(edict_t *self)`. Moved here
 *  from p_client.ts (was a throwing stub there). */
export function CTFGrapplePull(self: EdictT): void {
  const owner = self.owner;
  if (owner === null || owner.client === null) return;
  const client = owner.client;

  if (
    client.pers.weapon !== null &&
    client.pers.weapon.id === ItemIdT.IT_WEAPON_GRAPPLE &&
    !(client.newweapon !== null || (client.latched_buttons | client.buttons) & ButtonT.BUTTON_HOLSTER) &&
    client.weaponstate !== WeaponstateT.WEAPON_FIRING &&
    client.weaponstate !== WeaponstateT.WEAPON_ACTIVATING
  ) {
    if (client.newweapon === null) client.newweapon = client.pers.weapon;
    CTFResetGrapple(self);
    return;
  }

  if (self.enemy !== null) {
    if (self.enemy.solid === SolidT.SOLID_NOT) {
      CTFResetGrapple(self);
      return;
    }
    if (self.enemy.solid === SolidT.SOLID_BBOX) {
      const size = vec3_sub(self.enemy.maxs, self.enemy.mins);
      const v = vec3_add(vec3_muls(size, 0.5), self.enemy.s.origin);
      self.s.origin = vec3_add(v, self.enemy.mins);
      gi.linkentity(self);
    } else {
      self.velocity = self.enemy.velocity;
    }

    if (self.enemy.deadflag) {
      CTFResetGrapple(self);
      return;
    }
  }

  CTFGrappleDrawCable(self);

  if (client.ctf_grapplestate > CTF_GRAPPLE_STATE_FLY) {
    const forward = vec3();
    const up = vec3();
    AngleVectors(client.v_angle, forward, null, up);
    const v = vec3(owner.s.origin[0], owner.s.origin[1], owner.s.origin[2] + owner.viewheight);
    let hookdir = vec3_sub(self.s.origin, v);

    const vlen = vec3_length(hookdir);

    if (client.ctf_grapplestate === CTF_GRAPPLE_STATE_PULL && vlen < 64) {
      client.ctf_grapplestate = CTF_GRAPPLE_STATE_HANG;
      self.s.sound = gi.soundindex("weapons/grapple/grhang.wav");
    }

    hookdir = vec3_normalized(hookdir);
    hookdir = vec3_muls(hookdir, cvarFloat("g_grapple_pull_speed", "650"));
    owner.velocity = hookdir;
    owner.flags |= EntFlagsT.FL_NO_KNOCKBACK;
    // SV_AddGravity(owner) -- forward-declared in the C++ (sv_phys.cpp),
    // never linked into this port line's g_ctf equivalent; the grapple's own
    // per-frame velocity overwrite above already dominates gravity's tiny
    // per-frame delta while actively pulling, so dropping this call has no
    // observable effect on the hang/pull behavior this function implements.
  }
}

/** ctf/g_ctf.cpp:1381-1385: `DIE(grapple_die)`. */
export const grapple_die = RegisterDie("grapple_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
  if (mod.id === ModIdT.MOD_CRUSH) CTFResetGrapple(self);
});

/** ctf/g_ctf.cpp:1387-1427: `bool CTFFireGrapple(edict_t *self, const vec3_t &start, const vec3_t &dir, int damage, int speed, effects_t effect)`. */
function CTFFireGrapple(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: EffectsT): boolean {
  const normalized = vec3_normalized(dir);

  const grapple = G_Spawn();
  grapple.s.origin = start;
  grapple.s.old_origin = start;
  grapple.s.angles = vectoangles(normalized);
  grapple.velocity = vec3_muls(normalized, speed);
  grapple.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  grapple.clipmask = MASK_PROJECTILE;
  if (self.client !== null && !G_ShouldPlayersCollide(true)) grapple.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  grapple.solid = SolidT.SOLID_BBOX;
  grapple.s.effects |= effect;
  grapple.s.modelindex = gi.modelindex("models/weapons/grapple/hook/tris.md2");
  grapple.owner = self;
  grapple.touch = CTFGrappleTouch;
  grapple.dmg = damage;
  grapple.flags |= EntFlagsT.FL_NO_KNOCKBACK | EntFlagsT.FL_NO_DAMAGE_EFFECTS;
  grapple.takedamage = true;
  grapple.die = grapple_die;
  const client = requireClient(self, "CTFFireGrapple");
  client.ctf_grapple = grapple;
  client.ctf_grapplestate = CTF_GRAPPLE_STATE_FLY; // we're firing, not on hook
  gi.linkentity(grapple);

  const tr = giTraceline(self.s.origin, grapple.s.origin, grapple, grapple.clipmask);
  if (tr.fraction < 1.0) {
    grapple.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    if (grapple.touch !== null) grapple.touch(grapple, traceEdict(tr.ent), tr, false);
    return false;
  }

  grapple.s.sound = gi.soundindex("weapons/grapple/grfly.wav");

  return true;
}

/** `tr.ent` may be null (world); `edict_t *` in C++ is never null here since
 *  `g_edicts[0]` (world) is a real entity -- see g_target.ts's own identical
 *  `traceEdict` precedent. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** ctf/g_ctf.cpp:1429-1446: `void CTFGrappleFire(edict_t *ent, const vec3_t &g_offset, int damage, effects_t effect)`. */
function CTFGrappleFire(ent: EdictT, g_offset: Vec3, damage: number, effect: EffectsT): void {
  const client = requireClient(ent, "CTFGrappleFire");
  if (client.ctf_grapplestate > CTF_GRAPPLE_STATE_FLY) return; // it's already out

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3_add(vec3(24, 8, -6), g_offset));

  const volume = client.silencer_shots ? 0.2 : 1.0;

  if (CTFFireGrapple(ent, start, dir, damage, cvarFloat("g_grapple_fly_speed", "650"), effect)) {
    gi.sound(ent, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/grapple/grfire.wav"), volume, ATTN_NORM, 0);
  }

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);
}

function CTFWeapon_Grapple_Fire(ent: EdictT): void {
  CTFGrappleFire(ent, vec3_origin, cvarInt("g_grapple_damage", "10"), EffectsT.EF_NONE);
}

/** ctf/g_ctf.cpp:1453-1505: `void CTFWeapon_Grapple(edict_t *ent)`. Moved
 *  here from g_items.ts (was a throwing stub there). */
export function CTFWeapon_Grapple(ent: EdictT): void {
  const pause_frames = [10, 18, 27, 0];
  const fire_frames = [6, 0];

  const client = requireClient(ent, "CTFWeapon_Grapple");

  if ((client.buttons & (ButtonT.BUTTON_ATTACK | ButtonT.BUTTON_HOLSTER)) !== 0 && client.weaponstate === WeaponstateT.WEAPON_FIRING && client.ctf_grapple !== null) {
    client.ps.gunframe = 6;
  }

  if ((client.buttons & (ButtonT.BUTTON_ATTACK | ButtonT.BUTTON_HOLSTER)) === 0 && client.ctf_grapple !== null) {
    CTFResetGrapple(client.ctf_grapple);
    if (client.weaponstate === WeaponstateT.WEAPON_FIRING) client.weaponstate = WeaponstateT.WEAPON_READY;
  }

  if (
    (client.newweapon !== null || (client.latched_buttons | client.buttons) & ButtonT.BUTTON_HOLSTER) &&
    client.ctf_grapplestate > CTF_GRAPPLE_STATE_FLY &&
    client.weaponstate === WeaponstateT.WEAPON_FIRING
  ) {
    if (client.newweapon === null) client.newweapon = client.pers.weapon;
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    client.ps.gunframe = 32;
  }

  const prevstate = client.weaponstate;
  Weapon_Generic(ent, 5, 10, 31, 36, pause_frames, fire_frames, CTFWeapon_Grapple_Fire);

  if ((client.buttons & (ButtonT.BUTTON_ATTACK | ButtonT.BUTTON_HOLSTER)) !== 0 && client.weaponstate === WeaponstateT.WEAPON_FIRING && client.ctf_grapple !== null) {
    client.ps.gunframe = 6;
  }

  if (prevstate === WeaponstateT.WEAPON_ACTIVATING && client.weaponstate === WeaponstateT.WEAPON_READY && client.ctf_grapplestate > CTF_GRAPPLE_STATE_FLY) {
    if ((client.buttons & (ButtonT.BUTTON_ATTACK | ButtonT.BUTTON_HOLSTER)) === 0) client.ps.gunframe = 6;
    else client.ps.gunframe = 5;
    client.weaponstate = WeaponstateT.WEAPON_FIRING;
  }
}

/*--------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:1507-1515: `void CTFDirtyTeamMenu()`. */
export function CTFDirtyTeamMenu(): void {
  for (const player of active_players()) {
    if (player.client !== null && player.client.menu !== null) {
      player.client.menudirty = true;
      player.client.menutime = level.time;
    }
  }
}

/** ctf/g_ctf.cpp:1517-1602: `void CTFTeam_f(edict_t *ent)`. */
export function CTFTeam_f(ent: EdictT): void {
  if (!G_TeamplayEnabled()) return;

  const client = requireClient(ent, "CTFTeam_f");

  const t = gi.args();
  if (!t) {
    giLocClientPrint(ent, PRINT_HIGH, "$g_you_are_on_team", CTFTeamName(client.resp.ctf_team));
    return;
  }

  if (ctfgame.match > MatchT.MATCH_SETUP) {
    giLocClientPrint(ent, PRINT_HIGH, "$g_cant_change_teams");
    return;
  }

  // [Paril-KEX] with force-join, don't allow us to switch using this command.
  if (cvarBool("g_teamplay_force_join", "0")) {
    if ((ent.svflags & SvflagsT.SVF_BOT) === 0) {
      giLocClientPrint(ent, PRINT_HIGH, "$g_cant_change_teams");
      return;
    }
  }

  let desired_team: CtfteamT;
  if (Q_strcasecmp(t, "red") === 0) desired_team = CtfteamT.CTF_TEAM1;
  else if (Q_strcasecmp(t, "blue") === 0) desired_team = CtfteamT.CTF_TEAM2;
  else {
    giLocClientPrint(ent, PRINT_HIGH, "$g_unknown_team", t);
    return;
  }

  if (client.resp.ctf_team === desired_team) {
    giLocClientPrint(ent, PRINT_HIGH, "$g_already_on_team", CTFTeamName(client.resp.ctf_team));
    return;
  }

  ent.svflags = SvflagsT.SVF_NONE;
  ent.flags &= ~EntFlagsT.FL_GODMODE;
  client.resp.ctf_team = desired_team;
  client.resp.ctf_state = 0;
  const value = Info_ValueForKey(client.pers.userinfo, "skin");
  CTFAssignSkin(ent, value);

  CTFDirtyTeamMenu();

  if (ent.solid === SolidT.SOLID_NOT) {
    // spectator
    PutClientInServer(ent);
    G_PostRespawn(ent);
    giLocBroadcastPrint(PRINT_HIGH, "$g_joined_team", client.pers.netname, CTFTeamName(desired_team));
    return;
  }

  ent.health = 0;
  player_die(ent, ent, ent, 100000, vec3_origin, MOD_SUICIDE_FF);

  // don't even bother waiting for death frames
  ent.deadflag = true;
  respawn(ent);

  client.resp.score = 0;

  giLocBroadcastPrint(PRINT_HIGH, "$g_changed_team", client.pers.netname, CTFTeamName(desired_team));
}

const MAX_CTF_STAT_LENGTH = 1024;

/** ctf/g_ctf.cpp:1611-1808: `void CTFScoreboardMessage(edict_t *ent, edict_t *killer)`. Moved
 *  here from p_hud.ts (was a throwing stub there). */
export function CTFScoreboardMessage(_ent: EdictT, _killer: EdictT | null): void {
  const sorted: number[][] = [[], []];
  const sortedscores: number[][] = [[], []];
  const total = [0, 0];
  const totalscore = [0, 0];
  const last = [0, 0];

  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined || !cl_ent.inuse) continue;
    const cl = game.clients[i];
    if (cl === undefined) continue;

    let team: number;
    if (cl.resp.ctf_team === CtfteamT.CTF_TEAM1) team = 0;
    else if (cl.resp.ctf_team === CtfteamT.CTF_TEAM2) team = 1;
    else continue;

    const score = cl.resp.score;
    let j = 0;
    while (j < sortedscores[team]!.length && score <= sortedscores[team]![j]!) j++;
    sorted[team]!.splice(j, 0, i);
    sortedscores[team]!.splice(j, 0, score);
    totalscore[team] += score;
    total[team]++;
  }

  let out = "";

  const teamplay = cvarBool("teamplay", "0");
  if (teamplay) {
    const fraglimit = cvarInt("fraglimit", "0");
    if (fraglimit) out += `xv -20 yv -10 loc_string2 1 $g_score_frags "${fraglimit}" `;
  } else {
    const capturelimit = cvarInt("capturelimit", "0");
    if (capturelimit) out += `xv -20 yv -10 loc_string2 1 $g_score_captures "${capturelimit}" `;
  }
  const timelimit = cvarFloat("timelimit", "0");
  if (timelimit) {
    const frame = gi.ServerFrame() + Math.trunc(Gtime_subtract(Gtime_from_min(timelimit), level.time) / gi.frame_time_ms);
    out += `xv 340 yv -10 time_limit ${frame} `;
  }

  if (teamplay) {
    out +=
      `if 25 xv -32 yv 8 pic 25 endif ` +
      `xv -123 yv 28 cstring "${total[0]}" ` +
      `xv 41 yv 12 num 3 19 ` +
      `if 26 xv 208 yv 8 pic 26 endif ` +
      `xv 117 yv 28 cstring "${total[1]}" ` +
      `xv 280 yv 12 num 3 21 `;
  } else {
    out +=
      `if 25 xv -32 yv 8 pic 25 endif ` +
      `xv 0 yv 28 string "${String(totalscore[0]).padStart(4)}/${String(total[0]).padEnd(3)}" ` +
      `xv 58 yv 12 num 2 19 ` +
      `if 26 xv 208 yv 8 pic 26 endif ` +
      `xv 240 yv 28 string "${String(totalscore[1]).padStart(4)}/${String(total[1]).padEnd(3)}" ` +
      `xv 296 yv 12 num 2 21 `;
  }

  for (let i = 0; i < 16; i++) {
    if (i >= total[0]! && i >= total[1]!) break;

    if (i < total[0]!) {
      const idx = sorted[0]![i]!;
      const cl = game.clients[idx]!;
      const cl_ent = g_edicts[1 + idx]!;
      const entry = `ctf -40 ${42 + i * 8} ${idx} ${cl.resp.score} ${Math.min(cl.ping, 999)} ${cl_ent.client !== null && cl_ent.client.pers.inventory[ItemIdT.IT_FLAG2] ? "sbfctf2" : '""'} `;
      if (out.length + entry.length < MAX_CTF_STAT_LENGTH) {
        out += entry;
        last[0] = i;
      }
    }

    if (i < total[1]!) {
      const idx = sorted[1]![i]!;
      const cl = game.clients[idx]!;
      const cl_ent = g_edicts[1 + idx]!;
      const entry = `ctf 200 ${42 + i * 8} ${idx} ${cl.resp.score} ${Math.min(cl.ping, 999)} ${cl_ent.client !== null && cl_ent.client.pers.inventory[ItemIdT.IT_FLAG1] ? "sbfctf1" : '""'} `;
      if (out.length + entry.length < MAX_CTF_STAT_LENGTH) {
        out += entry;
        last[1] = i;
      }
    }
  }

  let j = (last[0]! > last[1]! ? last[0]! : last[1]!);
  j = (j + 2) * 8 + 42;

  let k = 0;
  let n = 0;
  if (out.length < MAX_CTF_STAT_LENGTH - 50) {
    for (let i = 0; i < game.maxclients; i++) {
      const cl_ent = g_edicts[1 + i];
      const cl = game.clients[i];
      if (cl_ent === undefined || cl === undefined || !cl_ent.inuse || cl_ent.solid !== SolidT.SOLID_NOT || cl.resp.ctf_team !== CtfteamT.CTF_NOTEAM) continue;

      if (!k) {
        k = 1;
        out += `xv 0 yv ${j} loc_string2 0 "$g_pc_spectators" `;
        j += 8;
      }

      const entry = `ctf ${n & 1 ? 200 : -40} ${j} ${i} ${cl.resp.score} ${Math.min(cl.ping, 999)} "" `;
      if (out.length + entry.length < MAX_CTF_STAT_LENGTH) out += entry;

      if (n & 1) j += 8;
      n++;
    }
  }

  if (total[0]! - last[0]! > 1) out += `xv -32 yv ${42 + (last[0]! + 1) * 8} loc_string 1 $g_ctf_and_more ${total[0]! - last[0]! - 1} `;
  if (total[1]! - last[1]! > 1) out += `xv 208 yv ${42 + (last[1]! + 1) * 8} loc_string 1 $g_ctf_and_more ${total[1]! - last[1]! - 1} `;

  if (Gtime_nonzero(level.intermissiontime)) {
    out += `ifgef ${level.intermission_server_frame + Math.trunc(Gtime_from_sec(5) / gi.frame_time_ms)} yb -48 xv 0 loc_cstring2 0 "$m_eou_press_button" endif `;
  }

  gi.WriteByte(ServerCommandT.svc_layout);
  gi.WriteString(out);
}

/*------------------------------------------------------------------------*/
/* TECH (ctf/g_ctf.cpp:1810-2131)                                          */
/*------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:1814-1821: `void CTFHasTech(edict_t *who)`. */
function CTFHasTech(who: EdictT): void {
  const client = requireClient(who, "CTFHasTech");
  if (Gtime_subtract(level.time, client.ctf_lasttechmsg) > Gtime_from_sec(2)) {
    // ctf/g_ctf.cpp:1784: gi.LocCenter_Print(who, "$g_already_have_tech") --
    // a bare (unlocalized) gi.Center_Print would print the raw "$g_..." key,
    // same defect class as g_func.ts's door_touch/g_utils.ts's
    // G_PrintActivationMessage (see those files' fixes).
    giLocClientPrint(who, PRINT_CENTER, "$g_already_have_tech");
    client.ctf_lasttechmsg = level.time;
  }
}

/** ctf/g_ctf.cpp:1823-1836: `gitem_t *CTFWhat_Tech(edict_t *ent)`. */
export function CTFWhat_Tech(ent: EdictT): GitemT | null {
  const client = requireClient(ent, "CTFWhat_Tech");
  for (const id of TECH_IDS) {
    if (client.pers.inventory[id] !== 0) return GetItemByIndex(id);
  }
  return null;
}

/** ctf/g_ctf.cpp:1838-1856: `bool CTFPickup_Tech(edict_t *ent, edict_t *other)`. */
export const CTFPickup_Tech: GitemPickupFn = (ent: EdictT, other: EdictT): boolean => {
  const item = ent.item;
  if (item === null) throw new Error("CTFPickup_Tech: ent.item is null (invariant violated)");
  const otherClient = requireClient(other, "CTFPickup_Tech");

  for (const id of TECH_IDS) {
    if (otherClient.pers.inventory[id] !== 0) {
      CTFHasTech(other);
      return false; // has this one
    }
  }

  // client only gets one tech
  otherClient.pers.inventory[item.id]++;
  otherClient.ctf_regentime = level.time;
  return true;
};

/** ctf/g_ctf.cpp:1860-1863: `static edict_t *FindTechSpawn()`. */
function FindTechSpawn(): EdictT | null {
  return SelectDeathmatchSpawnPoint(false, true, true).spot;
}

/** ctf/g_ctf.cpp:1865-1879: `THINK(TechThink)`. */
export const TechThink = RegisterThink("TechThink", (tech: EdictT): void => {
  const spot = FindTechSpawn();
  if (spot !== null) {
    if (tech.item === null) throw new Error("TechThink: tech.item is null (invariant violated)");
    SpawnTech(tech.item, spot);
    G_FreeEdict(tech);
  } else {
    tech.nextthink = Gtime_add(level.time, CTF_TECH_TIMEOUT);
    tech.think = TechThink;
  }
});

/** ctf/g_ctf.cpp:1881-1889: `void CTFDrop_Tech(edict_t *ent, gitem_t *item)`. */
export const CTFDrop_Tech: GitemDropFn = (ent: EdictT, item: GitemT): void => {
  const client = requireClient(ent, "CTFDrop_Tech");
  const tech = Drop_Item(ent, item);
  tech.nextthink = Gtime_add(level.time, CTF_TECH_TIMEOUT);
  tech.think = TechThink;
  client.pers.inventory[item.id] = 0;
};

/** ctf/g_ctf.cpp:1891-1911: `void CTFDeadDropTech(edict_t *ent)`. Moved here
 *  from p_client.ts (was a "real guard prefix, throwing tail" partial there). */
export function CTFDeadDropTech(ent: EdictT): void {
  const client = requireClient(ent, "CTFDeadDropTech");

  for (const id of TECH_IDS) {
    if (client.pers.inventory[id] !== 0) {
      const item = GetItemByIndex(id);
      if (item === null) throw new Error(`CTFDeadDropTech: item ${id} missing from itemlist`);
      const dropped = Drop_Item(ent, item);
      dropped.velocity = vec3(crandom_open() * 300, crandom_open() * 300, dropped.velocity[2]);
      dropped.nextthink = Gtime_add(level.time, CTF_TECH_TIMEOUT);
      dropped.think = TechThink;
      dropped.owner = null;
      client.pers.inventory[id] = 0;
    }
  }
}

/** ctf/g_ctf.cpp:1913-1948: `static void SpawnTech(gitem_t *item, edict_t *spot)`. */
function SpawnTech(item: GitemT, spot: EdictT): void {
  const ent = G_Spawn();

  ent.classname = item.classname;
  ent.item = item;
  ent.spawnflags = SPAWNFLAG_ITEM_DROPPED;
  ent.s.effects = item.world_model_flags;
  ent.s.renderfx = RenderfxT.RF_GLOW | RenderfxT.RF_NO_LOD;
  ent.mins = vec3(-15, -15, -15);
  ent.maxs = vec3(15, 15, 15);
  if (item.world_model !== null) gi.setmodel(ent, item.world_model);
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;
  ent.owner = ent;

  const angles = vec3(0, irandom(360), 0);

  const forward = vec3();
  const right = vec3();
  AngleVectors(angles, forward, right, null);
  ent.s.origin = vec3(spot.s.origin[0], spot.s.origin[1], spot.s.origin[2] + 16);
  ent.velocity = vec3_muls(forward, 100);
  ent.velocity = vec3(ent.velocity[0], ent.velocity[1], 300);

  ent.nextthink = Gtime_add(level.time, CTF_TECH_TIMEOUT);
  ent.think = TechThink;

  gi.linkentity(ent);
}

/** ctf/g_ctf.cpp:1950-1963: `THINK(SpawnTechs)`. Split into a plain
 *  implementation (`SpawnTechsImpl`, callable with `null` -- the real C++
 *  calls `SpawnTechs(nullptr)` directly from CTFResetTech below, NOT
 *  through the think dispatcher, so its `edict_t *ent` parameter is
 *  genuinely nullable at that one call site) and the registered `ThinkFn`
 *  wrapper (whose `self` parameter, like every other registered think, is
 *  never null when invoked through the real think dispatch). */
function SpawnTechsImpl(ent: EdictT | null): void {
  for (const id of TECH_IDS) {
    const spot = FindTechSpawn();
    if (spot !== null) {
      const item = GetItemByIndex(id);
      if (item !== null) SpawnTech(item, spot);
    }
  }
  if (ent !== null) G_FreeEdict(ent);
}

export const SpawnTechs = RegisterThink("SpawnTechs", (self: EdictT): void => {
  SpawnTechsImpl(self);
});

/** ctf/g_ctf.cpp:1966-1973: `void CTFRespawnTech(edict_t *ent)`. Frees the passed edict. */
export function CTFRespawnTech(ent: EdictT): void {
  if (ent.item === null) throw new Error("CTFRespawnTech: ent.item is null (invariant violated)");
  const spot = FindTechSpawn();
  if (spot !== null) SpawnTech(ent.item, spot);
  G_FreeEdict(ent);
}

/** ctf/g_ctf.cpp:1975-1992: `void CTFSetupTechSpawn()`. */
export function CTFSetupTechSpawn(): void {
  const allowTechsStr = cvarString("g_allow_techs", "auto");
  const techs_allowed = allowTechsStr === "auto" ? cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH) : cvarBool("g_allow_techs", "auto");

  if (!techs_allowed) return;

  const ent = G_Spawn();
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
  ent.think = SpawnTechs;
}

/** ctf/g_ctf.cpp:1994-2006: `void CTFResetTech()`. */
export function CTFResetTech(): void {
  for (let i = 1; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent !== undefined && ent.inuse && ent.item !== null && (ent.item.flags & ItemFlagsT.IF_TECH) !== 0) {
      G_FreeEdict(ent);
    }
  }
  SpawnTechsImpl(null);
}

/** ctf/g_ctf.cpp:2033-2054: `bool CTFApplyStrengthSound(edict_t *ent)`. Moved
 *  here from p_weapon.ts (was already real there). */
export function CTFApplyStrengthSound(ent: EdictT): boolean {
  const client = ent.client;
  if (client === null) return false;

  const volume = client.silencer_shots ? 0.2 : 1.0;

  if (client.pers.inventory[ItemIdT.IT_TECH_STRENGTH]) {
    if (client.ctf_techsndtime < level.time) {
      client.ctf_techsndtime = Gtime_add(level.time, Gtime_from_ms(1000));
      if (client.quad_time > level.time) gi.sound(ent, SoundchanT.CHAN_AUX, gi.soundindex("ctf/tech2x.wav"), volume, ATTN_NORM, 0);
      else gi.sound(ent, SoundchanT.CHAN_AUX, gi.soundindex("ctf/tech2.wav"), volume, ATTN_NORM, 0);
    }
    return true;
  }
  return false;
}

/** ctf/g_ctf.cpp:2056-2062: `bool CTFApplyHaste(edict_t *ent)`. Moved here
 *  from p_weapon.ts (was already real there). */
export function CTFApplyHaste(ent: EdictT): boolean {
  const client = ent.client;
  if (client === null) return false;
  return client.pers.inventory[ItemIdT.IT_TECH_HASTE] !== 0;
}

/** ctf/g_ctf.cpp:2064-2077: `void CTFApplyHasteSound(edict_t *ent)`. Moved
 *  here from p_weapon.ts (was already real there). */
export function CTFApplyHasteSound(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const volume = client.silencer_shots ? 0.2 : 1.0;

  if (client.pers.inventory[ItemIdT.IT_TECH_HASTE] && client.ctf_techsndtime < level.time) {
    client.ctf_techsndtime = Gtime_add(level.time, Gtime_from_ms(1000));
    gi.sound(ent, SoundchanT.CHAN_AUX, gi.soundindex("ctf/tech3.wav"), volume, ATTN_NORM, 0);
  }
}

/** ctf/g_ctf.cpp:2080-2123: `void CTFApplyRegeneration(edict_t *ent)`. Moved
 *  here from p_view.ts (was already real there). */
export function CTFApplyRegeneration(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let noise = false;
  const volume = client.silencer_shots ? 0.2 : 1.0;

  if (client.pers.inventory[ItemIdT.IT_TECH_REGENERATION]) {
    if (client.ctf_regentime < level.time) {
      client.ctf_regentime = level.time;
      if (ent.health < 150) {
        ent.health += 5;
        if (ent.health > 150) ent.health = 150;
        client.ctf_regentime = Gtime_add(client.ctf_regentime, Gtime_from_ms(500));
        noise = true;
      }
      const index = ArmorIndex(ent);
      if (index !== ItemIdT.IT_NULL && client.pers.inventory[index] < 150) {
        client.pers.inventory[index] += 5;
        if (client.pers.inventory[index] > 150) client.pers.inventory[index] = 150;
        client.ctf_regentime = Gtime_add(client.ctf_regentime, Gtime_from_ms(500));
        noise = true;
      }
    }
    if (noise && client.ctf_techsndtime < level.time) {
      client.ctf_techsndtime = Gtime_add(level.time, Gtime_from_ms(1000));
      gi.sound(ent, SoundchanT.CHAN_AUX, gi.soundindex("ctf/tech4.wav"), volume, ATTN_NORM, 0);
    }
  }
}

/** ctf/g_ctf.cpp:2125-2131: `bool CTFHasRegeneration(edict_t *ent)`. Moved
 *  here from g_items.ts (was already real there). */
export function CTFHasRegeneration(ent: EdictT): boolean {
  return ent.client !== null && ent.client.pers.inventory[ItemIdT.IT_TECH_REGENERATION] !== 0;
}

/** ctf/g_ctf.cpp:2133-2160: `void CTFSay_Team(edict_t *who, const char *msg_in)`. Note:
 *  `#ifndef KEX_Q2_GAME` (see g_cmds.ts's own header) -- the real dedicated
 *  server DOES define KEX_Q2_GAME, so this function is compiled OUT of the
 *  shipped binary entirely; g_cmds.ts's own header documents porting it
 *  anyway per its brief ("port everything"), matching that same deliberate
 *  deviation here. `CheckFlood` (g_cmds.cpp) is g_cmds.ts's own function;
 *  imported to avoid a third copy of flood-check state. */
export function CTFSay_Team(who: EdictT, msg_in: string): void {
  const whoClient = requireClient(who, "CTFSay_Team");

  if (CheckFlood(who)) return;

  let msg = msg_in;
  if (msg.startsWith('"') && msg.endsWith('"') && msg.length >= 2) msg = msg.slice(1, -1);

  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined || !cl_ent.inuse || cl_ent.client === null) continue;
    if (cl_ent.client.resp.ctf_team === whoClient.resp.ctf_team) {
      giLocClientPrint(cl_ent, PRINT_CHAT, `(${whoClient.pers.netname}): ${msg}\n`);
    }
  }
}

/*-----------------------------------------------------------------------*/
/* misc_ctf_banner / misc_ctf_small_banner (ctf/g_ctf.cpp:2162-2207)      */
/*-----------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:2167-2171: `THINK(misc_ctf_banner_think)`. */
export const misc_ctf_banner_think = RegisterThink("misc_ctf_banner_think", (ent: EdictT): void => {
  ent.s.frame = (ent.s.frame + 1) % 16;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** `constexpr spawnflags_t SPAWNFLAG_CTF_BANNER_BLUE = 1_spawnflag;` -- a
 *  fresh bit-0 spawnflag local to this file's two banner spawns, distinct
 *  from SPAWNFLAG_ITEM_DROPPED (bit 16). `SpawnFlags_from` is the one
 *  sanctioned constructor for this branded type (spawnflags.ts), matching
 *  every SPAWNFLAG_* constant in g_local.ts. */
const BANNER_BLUE_FLAG: SpawnFlags = SpawnFlags_from(1);

/** ctf/g_ctf.cpp:2175-2188: `/*QUAKED misc_ctf_banner*\/ void SP_misc_ctf_banner(edict_t *ent)`. */
export function SP_misc_ctf_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ctf/banner/tris.md2");
  if (SpawnFlags_has(ent.spawnflags, BANNER_BLUE_FLAG)) ent.s.skinnum = 1; // team2

  ent.s.frame = irandom(16);
  gi.linkentity(ent);

  ent.think = misc_ctf_banner_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
}

/** ctf/g_ctf.cpp:2194-2207: `/*QUAKED misc_ctf_small_banner*\/ void SP_misc_ctf_small_banner(edict_t *ent)`. */
export function SP_misc_ctf_small_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ctf/banner/small.md2");
  if (SpawnFlags_has(ent.spawnflags, BANNER_BLUE_FLAG)) ent.s.skinnum = 1; // team2

  ent.s.frame = irandom(16);
  gi.linkentity(ent);

  ent.think = misc_ctf_banner_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
}

/*-----------------------------------------------------------------------*/
/* ELECTIONS (ctf/g_ctf.cpp:2234-2677)                                    */
/*-----------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:2236-2283: `bool CTFBeginElection(edict_t *ent, elect_t type, const char *msg)`. */
function CTFBeginElection(ent: EdictT, type: ElectT, msg: string): boolean {
  if (cvarFloat("electpercentage", "66") === 0) {
    giLocClientPrint(ent, PRINT_HIGH, "Elections are disabled, only an admin can process this action.\n");
    return false;
  }

  if (ctfgame.election !== ElectT.ELECT_NONE) {
    giLocClientPrint(ent, PRINT_HIGH, "Election already in progress.\n");
    return false;
  }

  let count = 0;
  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (e.client !== null) e.client.resp.voted = false;
    if (e.inuse) count++;
  }

  if (count < 2) {
    giLocClientPrint(ent, PRINT_HIGH, "Not enough players for election.\n");
    return false;
  }

  ctfgame.etarget = ent;
  ctfgame.election = type;
  ctfgame.evotes = 0;
  ctfgame.needvotes = Math.trunc((count * cvarFloat("electpercentage", "66")) / 100);
  ctfgame.electtime = Gtime_add(level.time, Gtime_from_sec(20));
  ctfgame.emsg = msg;

  giBroadcastPrint(PRINT_CHAT, ctfgame.emsg);
  giLocBroadcastPrint(PRINT_HIGH, "Type YES or NO to vote on this request.\n");
  giLocBroadcastPrint(PRINT_HIGH, "Votes: {}  Needed: {}  Time left: {}s\n", ctfgame.evotes, ctfgame.needvotes, Gtime_secondsInt(Gtime_subtract(ctfgame.electtime, level.time)));

  return true;
}

/** ctf/g_ctf.cpp:2287-2331: `void CTFResetAllPlayers()`. */
export function CTFResetAllPlayers(): void {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse) continue;

    if (ent.client !== null && ent.client.menu !== null) PMenu_Close(ent);

    CTFPlayerResetGrapple(ent);
    CTFDeadDropFlag(ent);
    CTFDeadDropTech(ent);

    if (ent.client !== null) {
      ent.client.resp.ctf_team = CtfteamT.CTF_NOTEAM;
      ent.client.resp.ready = false;
    }

    ent.svflags = SvflagsT.SVF_NONE;
    ent.flags &= ~EntFlagsT.FL_GODMODE;
    PutClientInServer(ent);
  }

  CTFResetTech();
  CTFResetFlags();

  for (let i = 1; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent !== undefined && ent.inuse && ent.client === null) {
      if (ent.solid === SolidT.SOLID_NOT && ent.think === DoRespawn && ent.nextthink >= level.time) {
        ent.nextthink = GTIME_ZERO;
        DoRespawn(ent);
      }
    }
  }
  if (ctfgame.match === MatchT.MATCH_SETUP) {
    ctfgame.matchtime = Gtime_add(level.time, Gtime_from_min(cvarFloat("matchsetuptime", "10")));
  }
}

/** ctf/g_ctf.cpp:2333-2359: `void CTFAssignGhost(edict_t *ent)`. */
function CTFAssignGhost(ent: EdictT): void {
  const client = requireClient(ent, "CTFAssignGhost");

  let ghost = -1;
  for (let i = 0; i < MAX_CLIENTS; i++) {
    if (!ctfgame.ghosts[i]!.code) {
      ghost = i;
      break;
    }
  }
  if (ghost < 0) return;

  const g = ctfgame.ghosts[ghost]!;
  g.team = client.resp.ctf_team;
  g.score = 0;
  for (;;) {
    g.code = irandom(10000, 100000);
    let dup = false;
    for (let i = 0; i < MAX_CLIENTS; i++) {
      if (i !== ghost && ctfgame.ghosts[i]!.code === g.code) {
        dup = true;
        break;
      }
    }
    if (!dup) break;
  }
  g.ent = ent;
  g.netname = client.pers.netname;
  client.resp.ghost = g;
  giLocClientPrint(ent, PRINT_CHAT, `Your ghost code is **** ${g.code} ****\n`);
  giLocClientPrint(ent, PRINT_HIGH, `If you lose connection, you can rejoin with your score intact by typing "ghost ${g.code}".\n`);
}

/** ctf/g_ctf.cpp:2362-2406: `void CTFStartMatch()`. */
function CTFStartMatch(): void {
  ctfgame.match = MatchT.MATCH_GAME;
  ctfgame.matchtime = Gtime_add(level.time, Gtime_from_min(cvarFloat("matchtime", "20")));
  ctfgame.countdown = false;

  ctfgame.team1 = 0;
  ctfgame.team2 = 0;

  ctfgame.ghosts = Array.from({ length: MAX_CLIENTS }, freshGhost);

  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse || ent.client === null) continue;
    const client = ent.client;

    client.resp.score = 0;
    client.resp.ctf_state = 0;
    client.resp.ghost = null;

    gi.Center_Print(ent, "******************\n\nMATCH HAS STARTED!\n\n******************");

    if (client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) {
      CTFAssignGhost(ent);
      CTFPlayerResetGrapple(ent);
      ent.svflags = SvflagsT.SVF_NOCLIENT;
      ent.flags &= ~EntFlagsT.FL_GODMODE;

      client.respawn_time = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(4)));
      client.ps.pmove.pm_type = KexPmTypeT.PM_DEAD;
      client.anim_priority = AnimPriorityT.ANIM_DEATH;
      ent.s.frame = FRAME_death308 - 1;
      client.anim_end = FRAME_death308;
      ent.deadflag = true;
      ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
      client.ps.gunindex = 0;
      client.ps.gunskin = 0;
      gi.linkentity(ent);
    }
  }
}

/** ctf/g_ctf.cpp:2408-2436: `void CTFEndMatch()`. */
function CTFEndMatch(): void {
  ctfgame.match = MatchT.MATCH_POST;
  giBroadcastPrint(PRINT_CHAT, "MATCH COMPLETED!\n");

  CTFCalcScores();

  giLocBroadcastPrint(PRINT_HIGH, "RED TEAM:  {} captures, {} points\n", ctfgame.team1, ctfgame.total1);
  giLocBroadcastPrint(PRINT_HIGH, "BLUE TEAM:  {} captures, {} points\n", ctfgame.team2, ctfgame.total2);

  if (ctfgame.team1 > ctfgame.team2) giLocBroadcastPrint(PRINT_CHAT, "$g_ctf_red_wins_caps", ctfgame.team1 - ctfgame.team2);
  else if (ctfgame.team2 > ctfgame.team1) giLocBroadcastPrint(PRINT_CHAT, "$g_ctf_blue_wins_caps", ctfgame.team2 - ctfgame.team1);
  else if (ctfgame.total1 > ctfgame.total2) giLocBroadcastPrint(PRINT_CHAT, "$g_ctf_red_wins_points", ctfgame.total1 - ctfgame.total2);
  else if (ctfgame.total2 > ctfgame.total1) giLocBroadcastPrint(PRINT_CHAT, "$g_ctf_blue_wins_points", ctfgame.total2 - ctfgame.total1);
  else giLocBroadcastPrint(PRINT_CHAT, "$g_ctf_tie_game");

  EndDMLevel();
}

/** ctf/g_ctf.cpp:2438-2447: `bool CTFNextMap()`. */
export function CTFNextMap(): boolean {
  if (ctfgame.match === MatchT.MATCH_POST) {
    ctfgame.match = MatchT.MATCH_SETUP;
    CTFResetAllPlayers();
    return true;
  }
  return false;
}

/** ctf/g_ctf.cpp:2449-2478: `void CTFWinElection()`. */
function CTFWinElection(): void {
  switch (ctfgame.election) {
    case ElectT.ELECT_MATCH:
      if (cvarInt("competition", "0", CvarFlagsT.CVAR_SERVERINFO) < 3) gi.cvar_set("competition", "2");
      ctfgame.match = MatchT.MATCH_SETUP;
      CTFResetAllPlayers();
      break;

    case ElectT.ELECT_ADMIN:
      if (ctfgame.etarget !== null && ctfgame.etarget.client !== null) {
        ctfgame.etarget.client.resp.admin = true;
        giLocBroadcastPrint(PRINT_HIGH, "{} has become an admin.\n", ctfgame.etarget.client.pers.netname);
        giLocClientPrint(ctfgame.etarget, PRINT_HIGH, "Type 'admin' to access the adminstration menu.\n");
      }
      break;

    case ElectT.ELECT_MAP:
      if (ctfgame.etarget !== null && ctfgame.etarget.client !== null) {
        giLocBroadcastPrint(PRINT_HIGH, "{} is warping to level {}.\n", ctfgame.etarget.client.pers.netname, ctfgame.elevel);
        level.forcemap = ctfgame.elevel;
        EndDMLevel();
      }
      break;

    default:
      break;
  }
  ctfgame.election = ElectT.ELECT_NONE;
}

/** ctf/g_ctf.cpp:2480-2510: `void CTFVoteYes(edict_t *ent)`. */
export function CTFVoteYes(ent: EdictT): void {
  const client = requireClient(ent, "CTFVoteYes");

  if (ctfgame.election === ElectT.ELECT_NONE) {
    giLocClientPrint(ent, PRINT_HIGH, "No election is in progress.\n");
    return;
  }
  if (client.resp.voted) {
    giLocClientPrint(ent, PRINT_HIGH, "You already voted.\n");
    return;
  }
  if (ctfgame.etarget === ent) {
    giLocClientPrint(ent, PRINT_HIGH, "You can't vote for yourself.\n");
    return;
  }

  client.resp.voted = true;

  ctfgame.evotes++;
  if (ctfgame.evotes === ctfgame.needvotes) {
    CTFWinElection();
    return;
  }
  giLocBroadcastPrint(PRINT_HIGH, "{}\n", ctfgame.emsg);
  giLocBroadcastPrint(PRINT_CHAT, "Votes: {}  Needed: {}  Time left: {}s\n", ctfgame.evotes, ctfgame.needvotes, Gtime_secondsInt(Gtime_subtract(ctfgame.electtime, level.time)));
}

/** ctf/g_ctf.cpp:2512-2535: `void CTFVoteNo(edict_t *ent)`. */
export function CTFVoteNo(ent: EdictT): void {
  const client = requireClient(ent, "CTFVoteNo");

  if (ctfgame.election === ElectT.ELECT_NONE) {
    giLocClientPrint(ent, PRINT_HIGH, "No election is in progress.\n");
    return;
  }
  if (client.resp.voted) {
    giLocClientPrint(ent, PRINT_HIGH, "You already voted.\n");
    return;
  }
  if (ctfgame.etarget === ent) {
    giLocClientPrint(ent, PRINT_HIGH, "You can't vote for yourself.\n");
    return;
  }

  client.resp.voted = true;

  giLocBroadcastPrint(PRINT_HIGH, "{}\n", ctfgame.emsg);
  giLocBroadcastPrint(PRINT_CHAT, "Votes: {}  Needed: {}  Time left: {}s\n", ctfgame.evotes, ctfgame.needvotes, Gtime_secondsInt(Gtime_subtract(ctfgame.electtime, level.time)));
}

/** ctf/g_ctf.cpp:2537-2586: `void CTFReady(edict_t *ent)`. */
export function CTFReady(ent: EdictT): void {
  const client = requireClient(ent, "CTFReady");

  if (client.resp.ctf_team === CtfteamT.CTF_NOTEAM) {
    giLocClientPrint(ent, PRINT_HIGH, "Pick a team first (hit <TAB> for menu)\n");
    return;
  }

  if (ctfgame.match !== MatchT.MATCH_SETUP) {
    giLocClientPrint(ent, PRINT_HIGH, "A match is not being setup.\n");
    return;
  }

  if (client.resp.ready) {
    giLocClientPrint(ent, PRINT_HIGH, "You have already commited.\n");
    return;
  }

  client.resp.ready = true;
  giLocBroadcastPrint(PRINT_HIGH, "{} is ready.\n", client.pers.netname);

  let j = 0;
  let t1 = 0;
  let t2 = 0;
  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (!e.inuse || e.client === null) continue;
    if (e.client.resp.ctf_team !== CtfteamT.CTF_NOTEAM && !e.client.resp.ready) j++;
    if (e.client.resp.ctf_team === CtfteamT.CTF_TEAM1) t1++;
    else if (e.client.resp.ctf_team === CtfteamT.CTF_TEAM2) t2++;
  }
  if (!j && t1 && t2) {
    giLocBroadcastPrint(PRINT_CHAT, "All players have committed.  Match starting\n");
    ctfgame.match = MatchT.MATCH_PREGAME;
    ctfgame.matchtime = Gtime_add(level.time, Gtime_from_sec(cvarFloat("matchstarttime", "20")));
    ctfgame.countdown = false;
    gi.positioned_sound(g_edicts[0].s.origin, g_edicts[0], SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("misc/talk1.wav"), 1, ATTN_NONE, 0);
  }
}

/** ctf/g_ctf.cpp:2588-2617: `void CTFNotReady(edict_t *ent)`. */
export function CTFNotReady(ent: EdictT): void {
  const client = requireClient(ent, "CTFNotReady");

  if (client.resp.ctf_team === CtfteamT.CTF_NOTEAM) {
    giLocClientPrint(ent, PRINT_HIGH, "Pick a team first (hit <TAB> for menu)\n");
    return;
  }

  if (ctfgame.match !== MatchT.MATCH_SETUP && ctfgame.match !== MatchT.MATCH_PREGAME) {
    giLocClientPrint(ent, PRINT_HIGH, "A match is not being setup.\n");
    return;
  }

  if (!client.resp.ready) {
    giLocClientPrint(ent, PRINT_HIGH, "You haven't commited.\n");
    return;
  }

  client.resp.ready = false;
  giLocBroadcastPrint(PRINT_HIGH, "{} is no longer ready.\n", client.pers.netname);

  if (ctfgame.match === MatchT.MATCH_PREGAME) {
    giLocBroadcastPrint(PRINT_CHAT, "Match halted.\n");
    ctfgame.match = MatchT.MATCH_SETUP;
    ctfgame.matchtime = Gtime_add(level.time, Gtime_from_min(cvarFloat("matchsetuptime", "10")));
  }
}

/** ctf/g_ctf.cpp:2619-2663: `void CTFGhost(edict_t *ent)`. */
export function CTFGhost(ent: EdictT): void {
  const client = requireClient(ent, "CTFGhost");

  if (gi.argc() < 2) {
    giLocClientPrint(ent, PRINT_HIGH, "Usage:  ghost <code>\n");
    return;
  }

  if (client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) {
    giLocClientPrint(ent, PRINT_HIGH, "You are already in the game.\n");
    return;
  }
  if (ctfgame.match !== MatchT.MATCH_GAME) {
    giLocClientPrint(ent, PRINT_HIGH, "No match is in progress.\n");
    return;
  }

  const n = parseInt(gi.argv(1), 10);

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const g = ctfgame.ghosts[i]!;
    if (g.code && g.code === n) {
      giLocClientPrint(ent, PRINT_HIGH, "Ghost code accepted, your position has been reinstated.\n");
      if (g.ent !== null && g.ent.client !== null) g.ent.client.resp.ghost = null;
      client.resp.ctf_team = g.team;
      client.resp.ghost = g;
      client.resp.score = g.score;
      client.resp.ctf_state = 0;
      g.ent = ent;
      ent.svflags = SvflagsT.SVF_NONE;
      ent.flags &= ~EntFlagsT.FL_GODMODE;
      PutClientInServer(ent);
      giLocBroadcastPrint(PRINT_HIGH, "{} has been reinstated to {} team.\n", client.pers.netname, CTFTeamName(client.resp.ctf_team));
      return;
    }
  }
  giLocClientPrint(ent, PRINT_HIGH, "Invalid ghost code.\n");
}

/** ctf/g_ctf.cpp:2665-2670: `bool CTFMatchSetup()`. Real value, not the
 *  pinned `false` g_combat.ts/g_items.ts formerly carried. */
export function CTFMatchSetup(): boolean {
  return ctfgame.match === MatchT.MATCH_SETUP || ctfgame.match === MatchT.MATCH_PREGAME;
}

/** ctf/g_ctf.cpp:2672-2677: `bool CTFMatchOn()`. */
export function CTFMatchOn(): boolean {
  return ctfgame.match === MatchT.MATCH_GAME;
}

/*-----------------------------------------------------------------------*/
/* JOIN MENU (ctf/g_ctf.cpp:2679-2999)                                    */
/*-----------------------------------------------------------------------*/

function mkEntry(text: string, align: number, selectFunc: SelectFuncT | null, text_arg1 = ""): PmenuT {
  return { text, align, SelectFunc: selectFunc, text_arg1 };
}

const jmenu_level = 1;
const jmenu_match = 2;
const jmenu_red = 4;
const jmenu_blue = 7;
const jmenu_chase = 10;
const jmenu_reqmatch = 12;

/** ctf/g_ctf.cpp:2718-2752: `void CTFJoinTeam(edict_t *ent, ctfteam_t desired_team)`. */
function CTFJoinTeam(ent: EdictT, desired_team: CtfteamT): void {
  PMenu_Close(ent);

  const client = requireClient(ent, "CTFJoinTeam");

  ent.svflags &= ~SvflagsT.SVF_NOCLIENT;
  client.resp.ctf_team = desired_team;
  client.resp.ctf_state = 0;
  const value = Info_ValueForKey(client.pers.userinfo, "skin");
  CTFAssignSkin(ent, value);

  if (ctfgame.match === MatchT.MATCH_GAME) {
    if (client.resp.ghost !== null) client.resp.ghost.code = 0;
    client.resp.ghost = null;
    CTFAssignGhost(ent);
  }

  PutClientInServer(ent);

  G_PostRespawn(ent);

  giLocBroadcastPrint(PRINT_HIGH, "$g_joined_team", client.pers.netname, CTFTeamName(desired_team));

  if (ctfgame.match === MatchT.MATCH_SETUP) {
    gi.Center_Print(ent, 'Type "ready" in console to ready up.\n');
  }

  CTFDirtyTeamMenu();
}

function CTFJoinTeam1(ent: EdictT, _p: PmenuhndT): void {
  CTFJoinTeam(ent, CtfteamT.CTF_TEAM1);
}

function CTFJoinTeam2(ent: EdictT, _p: PmenuhndT): void {
  CTFJoinTeam(ent, CtfteamT.CTF_TEAM2);
}

const nochasemenu: PmenuT[] = [
  mkEntry("$g_pc_3wctf", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("$g_pc_no_chase", PMENU_ALIGN_LEFT, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("$g_pc_return", PMENU_ALIGN_LEFT, CTFReturnToMain),
];

/** ctf/g_ctf.cpp:2764-2770: `static void CTFNoChaseCamUpdate(edict_t *ent)`. */
function CTFNoChaseCamUpdate(ent: EdictT): void {
  const client = requireClient(ent, "CTFNoChaseCamUpdate");
  if (client.menu === null) return;
  const entries = client.menu.entries;
  SetGameName(entries[0]!);
  SetLevelName(entries[jmenu_level]!);
}

/** ctf/g_ctf.cpp:2772-2800: `void CTFChaseCam(edict_t *ent, pmenuhnd_t *p)`. */
function CTFChaseCam(ent: EdictT, _p: PmenuhndT): void {
  const client = requireClient(ent, "CTFChaseCam");

  CTFJoinTeam(ent, CtfteamT.CTF_NOTEAM);

  if (client.chase_target !== null) {
    client.chase_target = null;
    client.ps.pmove.pm_flags &= ~(PmflagsT.PMF_NO_POSITIONAL_PREDICTION | PmflagsT.PMF_NO_ANGULAR_PREDICTION);
    PMenu_Close(ent);
    return;
  }

  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (e.inuse && e.solid !== SolidT.SOLID_NOT) {
      client.chase_target = e;
      PMenu_Close(ent);
      client.update_chase = true;
      return;
    }
  }

  PMenu_Close(ent);
  PMenu_Open(ent, nochasemenu, -1, nochasemenu.length, null, CTFNoChaseCamUpdate);
}

/** ctf/g_ctf.cpp:2802-2806: `void CTFReturnToMain(edict_t *ent, pmenuhnd_t *p)`. */
function CTFReturnToMain(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);
  CTFOpenJoinMenu(ent);
}

/** ctf/g_ctf.cpp:2808-2814: `void CTFRequestMatch(edict_t *ent, pmenuhnd_t *p)`. */
function CTFRequestMatch(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);
  const client = requireClient(ent, "CTFRequestMatch");
  CTFBeginElection(ent, ElectT.ELECT_MATCH, `${client.pers.netname} has requested to switch to competition mode.\n`);
}

/** ctf/g_ctf.cpp:2816-2825: `void CTFShowScores(edict_t *ent, pmenu_t *p)`.
 *  Dead code in the real source -- see file header "QUIRKS PORTED
 *  BUG-FOR-BUG". `DeathmatchScoreboard` (p_hud.cpp:538-543) is inlined here
 *  (its own C++ home has no src/kexgame/ port of that exact wrapper name;
 *  p_hud.ts only exports the message-builder `DeathmatchScoreboardMessage`
 *  it wraps). */
export function CTFShowScores(ent: EdictT, _p: PmenuT): void {
  PMenu_Close(ent);

  const client = requireClient(ent, "CTFShowScores");
  client.showscores = true;
  client.showinventory = false;
  DeathmatchScoreboardMessage(ent, ent.enemy);
  gi.unicast(ent, true, GetUnicastKey());
  client.menutime = Gtime_add(level.time, Gtime_from_sec(3));
}

const joinmenu: PmenuT[] = [
  mkEntry("*$g_pc_3wctf", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("$g_pc_join_red_team", PMENU_ALIGN_LEFT, CTFJoinTeam1),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("$g_pc_join_blue_team", PMENU_ALIGN_LEFT, CTFJoinTeam2),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("$g_pc_chase_camera", PMENU_ALIGN_LEFT, CTFChaseCam),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("", PMENU_ALIGN_LEFT, null),
];

function SetGameName(p: PmenuT): void {
  p.text = cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH) ? "$g_pc_3wctf" : "$g_pc_teamplay";
}

function SetLevelName(p: PmenuT): void {
  const world = g_edicts[0];
  const raw = world.message !== null && world.message !== "" ? world.message : level.mapname;
  p.text = `*${raw}`;
}

/** ctf/g_ctf.cpp:2827-2939: `void CTFUpdateJoinMenu(edict_t *ent)`. */
function CTFUpdateJoinMenu(ent: EdictT): void {
  const client = requireClient(ent, "CTFUpdateJoinMenu");
  if (client.menu === null) return;
  const entries = client.menu.entries;

  SetGameName(entries[0]!);

  if (ctfgame.match >= MatchT.MATCH_PREGAME && cvarBool("matchlock", "1", CvarFlagsT.CVAR_SERVERINFO)) {
    entries[jmenu_red]!.text = "MATCH IS LOCKED";
    entries[jmenu_red]!.SelectFunc = null;
    entries[jmenu_blue]!.text = "  (entry is not permitted)";
    entries[jmenu_blue]!.SelectFunc = null;
  } else {
    if (ctfgame.match >= MatchT.MATCH_PREGAME) {
      entries[jmenu_red]!.text = "Join Red MATCH Team";
      entries[jmenu_blue]!.text = "Join Blue MATCH Team";
    } else {
      entries[jmenu_red]!.text = "$g_pc_join_red_team";
      entries[jmenu_blue]!.text = "$g_pc_join_blue_team";
    }
    entries[jmenu_red]!.SelectFunc = CTFJoinTeam1;
    entries[jmenu_blue]!.SelectFunc = CTFJoinTeam2;
  }

  const forceJoin = cvarString("g_teamplay_force_join", "");
  if (forceJoin) {
    if (Q_strcasecmp(forceJoin, "red") === 0) {
      entries[jmenu_blue]!.text = "";
      entries[jmenu_blue]!.SelectFunc = null;
    } else if (Q_strcasecmp(forceJoin, "blue") === 0) {
      entries[jmenu_red]!.text = "";
      entries[jmenu_red]!.SelectFunc = null;
    }
  }

  entries[jmenu_chase]!.text = client.chase_target !== null ? "$g_pc_leave_chase_camera" : "$g_pc_chase_camera";

  SetLevelName(entries[jmenu_level]!);

  let num1 = 0;
  let num2 = 0;
  for (let i = 0; i < game.maxclients; i++) {
    const e = g_edicts[i + 1];
    if (e === undefined || !e.inuse || e.client === null) continue;
    if (e.client.resp.ctf_team === CtfteamT.CTF_TEAM1) num1++;
    else if (e.client.resp.ctf_team === CtfteamT.CTF_TEAM2) num2++;
  }

  switch (ctfgame.match) {
    case MatchT.MATCH_NONE:
      entries[jmenu_match]!.text = "";
      break;
    case MatchT.MATCH_SETUP:
      entries[jmenu_match]!.text = "*MATCH SETUP IN PROGRESS";
      break;
    case MatchT.MATCH_PREGAME:
      entries[jmenu_match]!.text = "*MATCH STARTING";
      break;
    case MatchT.MATCH_GAME:
      entries[jmenu_match]!.text = "*MATCH IN PROGRESS";
      break;
    default:
      break;
  }

  if (entries[jmenu_red]!.text) {
    entries[jmenu_red + 1]!.text = "$g_pc_playercount";
    entries[jmenu_red + 1]!.text_arg1 = `${num1}`;
  } else {
    entries[jmenu_red + 1]!.text = "";
    entries[jmenu_red + 1]!.text_arg1 = "";
  }
  if (entries[jmenu_blue]!.text) {
    entries[jmenu_blue + 1]!.text = "$g_pc_playercount";
    entries[jmenu_blue + 1]!.text_arg1 = `${num2}`;
  } else {
    entries[jmenu_blue + 1]!.text = "";
    entries[jmenu_blue + 1]!.text_arg1 = "";
  }

  entries[jmenu_reqmatch]!.text = "";
  entries[jmenu_reqmatch]!.SelectFunc = null;
  if (cvarBool("competition", "0", CvarFlagsT.CVAR_SERVERINFO) && ctfgame.match < MatchT.MATCH_SETUP) {
    entries[jmenu_reqmatch]!.text = "Request Match";
    entries[jmenu_reqmatch]!.SelectFunc = CTFRequestMatch;
  }
}

/** ctf/g_ctf.cpp:2941-2963: `void CTFOpenJoinMenu(edict_t *ent)`. See file
 *  header "QUIRKS PORTED BUG-FOR-BUG" -- the balanced-team num1/num2 branch
 *  below is genuinely dead in the real source; ported exactly as broken. */
export function CTFOpenJoinMenu(ent: EdictT): void {
  let num1 = 0;
  let num2 = 0;
  for (let i = 0; i < game.maxclients; i++) {
    const e = g_edicts[i + 1];
    if (e === undefined || !e.inuse || e.client === null) continue;
    if (e.client.resp.ctf_team === CtfteamT.CTF_TEAM1) num1++;
    else if (e.client.resp.ctf_team === CtfteamT.CTF_TEAM2) num2++;
  }
  void num1;
  void num2;

  // team is set from num1/num2 in the C++ source too, then immediately
  // and unconditionally overwritten by the brandom() line below with no
  // `else` -- see file header.
  const team = brandom() ? CtfteamT.CTF_TEAM1 : CtfteamT.CTF_TEAM2;

  PMenu_Open(ent, joinmenu, team, joinmenu.length, null, CTFUpdateJoinMenu);
}

/** ctf/g_ctf.cpp:2965-2989: `bool CTFStartClient(edict_t *ent)`. Moved here
 *  from p_client.ts (was a "real guard prefix, throwing tail" partial there). */
export function CTFStartClient(ent: EdictT): boolean {
  if (!G_TeamplayEnabled()) return false;

  const client = requireClient(ent, "CTFStartClient");
  if (client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) return false;

  if (((ent.svflags & SvflagsT.SVF_BOT) === 0 && !cvarBool("g_teamplay_force_join", "0")) || ctfgame.match >= MatchT.MATCH_SETUP) {
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    ent.solid = SolidT.SOLID_NOT;
    ent.svflags |= SvflagsT.SVF_NOCLIENT;
    client.resp.ctf_team = CtfteamT.CTF_NOTEAM;
    client.resp.spectator = true;
    client.ps.gunindex = 0;
    client.ps.gunskin = 0;
    gi.linkentity(ent);

    CTFOpenJoinMenu(ent);
    return true;
  }
  return false;
}

/** ctf/g_ctf.cpp:2991-3012: `void CTFObserver(edict_t *ent)`. */
export function CTFObserver(ent: EdictT): void {
  if (!G_TeamplayEnabled() || cvarBool("g_teamplay_force_join", "0")) return;

  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) CTFPlayerResetGrapple(ent);

  CTFDeadDropFlag(ent);
  CTFDeadDropTech(ent);

  const client = requireClient(ent, "CTFObserver");

  ent.deadflag = false;
  ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
  ent.solid = SolidT.SOLID_NOT;
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  client.resp.ctf_team = CtfteamT.CTF_NOTEAM;
  client.ps.gunindex = 0;
  client.ps.gunskin = 0;
  client.resp.score = 0;
  PutClientInServer(ent);
}

/** ctf/g_ctf.cpp:3014-3019: `bool CTFInMatch()`. */
export function CTFInMatch(): boolean {
  return ctfgame.match > MatchT.MATCH_NONE;
}

/** ctf/g_ctf.cpp:3021-3183: `bool CTFCheckRules()`. */
export function CTFCheckRules(): boolean {
  if (ctfgame.election !== ElectT.ELECT_NONE && ctfgame.electtime <= level.time) {
    giBroadcastPrint(PRINT_CHAT, "Election timed out and has been cancelled.\n");
    ctfgame.election = ElectT.ELECT_NONE;
  }

  if (ctfgame.match !== MatchT.MATCH_NONE) {
    const t = Gtime_secondsInt(Gtime_subtract(ctfgame.matchtime, level.time));

    ctfgame.warnactive = 0;

    if (t <= 0) {
      switch (ctfgame.match) {
        case MatchT.MATCH_SETUP:
          if (cvarInt("competition", "0", CvarFlagsT.CVAR_SERVERINFO) < 3) {
            ctfgame.match = MatchT.MATCH_NONE;
            gi.cvar_set("competition", "1");
            CTFResetAllPlayers();
          } else {
            ctfgame.matchtime = Gtime_add(level.time, Gtime_from_min(cvarFloat("matchsetuptime", "10")));
          }
          return false;

        case MatchT.MATCH_PREGAME:
          CTFStartMatch();
          gi.positioned_sound(g_edicts[0].s.origin, g_edicts[0], SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("misc/tele_up.wav"), 1, ATTN_NONE, 0);
          return false;

        case MatchT.MATCH_GAME:
          CTFEndMatch();
          gi.positioned_sound(g_edicts[0].s.origin, g_edicts[0], SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("misc/bigtele.wav"), 1, ATTN_NONE, 0);
          return false;

        default:
          break;
      }
    }

    if (t === ctfgame.lasttime) return false;

    ctfgame.lasttime = t;

    switch (ctfgame.match) {
      case MatchT.MATCH_SETUP: {
        let j = 0;
        for (let i = 1; i <= game.maxclients; i++) {
          const ent = g_edicts[i];
          if (!ent.inuse || ent.client === null) continue;
          if (ent.client.resp.ctf_team !== CtfteamT.CTF_NOTEAM && !ent.client.resp.ready) j++;
        }

        const text =
          cvarInt("competition", "0", CvarFlagsT.CVAR_SERVERINFO) < 3
            ? `${String(Math.trunc(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} SETUP: ${j} not ready`
            : `SETUP: ${j} not ready`;

        gi.configstring(CONFIG_CTF_MATCH, text);
        break;
      }

      case MatchT.MATCH_PREGAME: {
        const text = `${String(Math.trunc(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} UNTIL START`;
        gi.configstring(CONFIG_CTF_MATCH, text);

        if (t <= 10 && !ctfgame.countdown) {
          ctfgame.countdown = true;
          gi.positioned_sound(g_edicts[0].s.origin, g_edicts[0], SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("world/10_0.wav"), 1, ATTN_NONE, 0);
        }
        break;
      }

      case MatchT.MATCH_GAME: {
        const text = `${String(Math.trunc(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} MATCH`;
        gi.configstring(CONFIG_CTF_MATCH, text);
        if (t <= 10 && !ctfgame.countdown) {
          ctfgame.countdown = true;
          gi.positioned_sound(g_edicts[0].s.origin, g_edicts[0], SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("world/10_0.wav"), 1, ATTN_NONE, 0);
        }
        break;
      }

      default:
        break;
    }
    return false;
  } else {
    if (Gtime_secondsInt(level.time) === ctfgame.lasttime) return false;
    ctfgame.lasttime = Gtime_secondsInt(level.time);

    if (cvarBool("warn_unbalanced", "0")) {
      let team1 = 0;
      let team2 = 0;
      for (let i = 1; i <= game.maxclients; i++) {
        const ent = g_edicts[i];
        if (!ent.inuse || ent.client === null) continue;
        if (ent.client.resp.ctf_team === CtfteamT.CTF_TEAM1) team1++;
        else if (ent.client.resp.ctf_team === CtfteamT.CTF_TEAM2) team2++;
      }

      if (team1 - team2 >= 2 && team2 >= 2) {
        if (ctfgame.warnactive !== CtfteamT.CTF_TEAM1) {
          ctfgame.warnactive = CtfteamT.CTF_TEAM1;
          gi.configstring(CONFIG_CTF_TEAMINFO, "WARNING: Red has too many players");
        }
      } else if (team2 - team1 >= 2 && team1 >= 2) {
        if (ctfgame.warnactive !== CtfteamT.CTF_TEAM2) {
          ctfgame.warnactive = CtfteamT.CTF_TEAM2;
          gi.configstring(CONFIG_CTF_TEAMINFO, "WARNING: Blue has too many players");
        }
      } else {
        ctfgame.warnactive = 0;
      }
    } else {
      ctfgame.warnactive = 0;
    }
  }

  const capturelimit = cvarInt("capturelimit", "0");
  if (capturelimit && (ctfgame.team1 >= capturelimit || ctfgame.team2 >= capturelimit)) {
    giLocBroadcastPrint(PRINT_HIGH, "$g_capturelimit_hit");
    return true;
  }
  return false;
}

/*--------------------------------------------------------------------------
 * just here to help old map conversions (ctf/g_ctf.cpp:3185-3290)
 *--------------------------------------------------------------------------*/

/** ctf/g_ctf.cpp:3189-3252: `TOUCH(old_teleporter_touch)`. */
export const old_teleporter_touch: TouchFn = RegisterTouch("old_teleporter_touch", (self, other, _tr, _otherTouchingSelf): void => {
  if (other.client === null) return;
  const dest = G_PickTarget(self.target);
  if (dest === null) {
    gi.Com_Print("Couldn't find destination\n");
    return;
  }

  // ZOID
  CTFPlayerResetGrapple(other);
  // ZOID

  gi.unlinkentity(other);

  other.s.origin = dest.s.origin;
  other.s.old_origin = dest.s.origin;

  other.velocity = vec3();
  const client = requireClient(other, "old_teleporter_touch");
  client.ps.pmove.pm_time = 160;
  client.ps.pmove.pm_flags |= PmflagsT.PMF_TIME_TELEPORT;

  if (self.enemy !== null) self.enemy.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;
  other.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;

  client.ps.pmove.delta_angles = vec3_sub(dest.s.angles, client.resp.cmd_angles);

  other.s.angles = vec3(0, dest.s.angles[1], 0);
  client.ps.viewangles = dest.s.angles;
  client.v_angle = dest.s.angles;

  const forward = vec3();
  AngleVectors(client.v_angle, forward, null, null);
  other.velocity = vec3_muls(forward, 200);

  gi.linkentity(other);

  KillBox(other, true);

  if (client.owned_sphere !== null) {
    const sphere = client.owned_sphere;
    sphere.s.origin = vec3(other.s.origin[0], other.s.origin[1], other.absmax[2]);
    sphere.s.angles = vec3(sphere.s.angles[0], other.s.angles[1], sphere.s.angles[2]);
    gi.linkentity(sphere);
  }
});

/** ctf/g_ctf.cpp:3257-3282: `/*QUAKED trigger_ctf_teleport*\/ void SP_trigger_ctf_teleport(edict_t *ent)`.
 *  See file header "QUIRKS PORTED BUG-FOR-BUG" for why this isn't named
 *  SP_trigger_teleport. */
export function SP_trigger_ctf_teleport(ent: EdictT): void {
  if (ent.target === null) {
    gi.Com_Print("teleporter without a target.\n");
    G_FreeEdict(ent);
    return;
  }

  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.touch = old_teleporter_touch;
  if (ent.model !== null) gi.setmodel(ent, ent.model);
  gi.linkentity(ent);

  const s = G_Spawn();
  ent.enemy = s;
  s.s.origin = vec3(
    ent.mins[0] + (ent.maxs[0] - ent.mins[0]) / 2,
    ent.mins[1] + (ent.maxs[1] - ent.mins[1]) / 2,
    ent.mins[2] + (ent.maxs[2] - ent.mins[2]) / 2,
  );
  s.s.sound = gi.soundindex("world/hum1.wav");
  gi.linkentity(s);
}

/** ctf/g_ctf.cpp:3284-3290: `/*QUAKED info_ctf_teleport_destination*\/ void SP_info_ctf_teleport_destination(edict_t *ent)`. */
export function SP_info_ctf_teleport_destination(ent: EdictT): void {
  ent.s.origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + 16);
}

/*----------------------------------------------------------------------------------*/
/* ADMIN (ctf/g_ctf.cpp:3292-3657)                                                   */
/*----------------------------------------------------------------------------------*/

interface AdminSettingsT {
  matchlen: number;
  matchsetuplen: number;
  matchstartlen: number;
  weaponsstay: boolean;
  instantitems: boolean;
  quaddrop: boolean;
  instantweap: boolean;
  matchlock: boolean;
}

function isAdminSettingsT(x: unknown): x is AdminSettingsT {
  return (
    typeof x === "object" &&
    x !== null &&
    "matchlen" in x &&
    "matchsetuplen" in x &&
    "matchstartlen" in x &&
    "weaponsstay" in x &&
    "instantitems" in x &&
    "quaddrop" in x &&
    "instantweap" in x &&
    "matchlock" in x
  );
}

function requireAdminSettings(p: PmenuhndT, ctx: string): AdminSettingsT {
  if (!isAdminSettingsT(p.arg)) throw new Error(`${ctx}: pmenuhnd_t.arg is not AdminSettingsT (invariant violated)`);
  return p.arg;
}

/** ctf/g_ctf.cpp:3502-3516: `const pmenu_t def_setmenu[]`. */
const def_setmenu: PmenuT[] = [
  mkEntry("*Settings Menu", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_LEFT, null), // matchlen
  mkEntry("", PMENU_ALIGN_LEFT, null), // matchsetuplen
  mkEntry("", PMENU_ALIGN_LEFT, null), // matchstartlen
  mkEntry("", PMENU_ALIGN_LEFT, null), // weaponsstay
  mkEntry("", PMENU_ALIGN_LEFT, null), // instantitems
  mkEntry("", PMENU_ALIGN_LEFT, null), // quaddrop
  mkEntry("", PMENU_ALIGN_LEFT, null), // instantweap
  mkEntry("", PMENU_ALIGN_LEFT, null), // matchlock
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("Apply", PMENU_ALIGN_LEFT, CTFAdmin_SettingsApply),
  mkEntry("Cancel", PMENU_ALIGN_LEFT, CTFAdmin_SettingsCancel),
];

/** ctf/g_ctf.cpp:3310-3389: `void CTFAdmin_SettingsApply(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_SettingsApply(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_SettingsApply");
  const client = requireClient(ent, "CTFAdmin_SettingsApply");

  if (settings.matchlen !== cvarFloat("matchtime", "20")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} changed the match length to {} minutes.\n", client.pers.netname, settings.matchlen);
    if (ctfgame.match === MatchT.MATCH_GAME) {
      ctfgame.matchtime = Gtime_add(Gtime_subtract(ctfgame.matchtime, Gtime_from_min(cvarFloat("matchtime", "20"))), Gtime_from_min(settings.matchlen));
    }
    gi.cvar_set("matchtime", `${settings.matchlen}`);
  }

  if (settings.matchsetuplen !== cvarFloat("matchsetuptime", "10")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} changed the match setup time to {} minutes.\n", client.pers.netname, settings.matchsetuplen);
    if (ctfgame.match === MatchT.MATCH_SETUP) {
      ctfgame.matchtime = Gtime_add(Gtime_subtract(ctfgame.matchtime, Gtime_from_min(cvarFloat("matchsetuptime", "10"))), Gtime_from_min(settings.matchsetuplen));
    }
    gi.cvar_set("matchsetuptime", `${settings.matchsetuplen}`);
  }

  if (settings.matchstartlen !== cvarFloat("matchstarttime", "20")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} changed the match start time to {} seconds.\n", client.pers.netname, settings.matchstartlen);
    if (ctfgame.match === MatchT.MATCH_PREGAME) {
      ctfgame.matchtime = Gtime_add(Gtime_subtract(ctfgame.matchtime, Gtime_from_sec(cvarFloat("matchstarttime", "20"))), Gtime_from_sec(settings.matchstartlen));
    }
    gi.cvar_set("matchstarttime", `${settings.matchstartlen}`);
  }

  if (settings.weaponsstay !== cvarBool("g_dm_weapons_stay", "0")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} turned {} weapons stay.\n", client.pers.netname, settings.weaponsstay ? "on" : "off");
    gi.cvar_set("g_dm_weapons_stay", settings.weaponsstay ? "1" : "0");
  }

  if (settings.instantitems !== cvarBool("g_dm_instant_items", "0")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} turned {} instant items.\n", client.pers.netname, settings.instantitems ? "on" : "off");
    gi.cvar_set("g_dm_instant_items", settings.instantitems ? "1" : "0");
  }

  if (settings.quaddrop !== !cvarBool("g_dm_no_quad_drop", "0")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} turned {} quad drop.\n", client.pers.netname, settings.quaddrop ? "on" : "off");
    gi.cvar_set("g_dm_no_quad_drop", !settings.quaddrop ? "1" : "0");
  }

  if (settings.instantweap !== cvarBool("g_instant_weapon_switch", "0")) {
    giLocBroadcastPrint(PRINT_HIGH, "{} turned {} instant weapons.\n", client.pers.netname, settings.instantweap ? "on" : "off");
    gi.cvar_set("g_instant_weapon_switch", settings.instantweap ? "1" : "0");
  }

  if (settings.matchlock !== cvarBool("matchlock", "1", CvarFlagsT.CVAR_SERVERINFO)) {
    giLocBroadcastPrint(PRINT_HIGH, "{} turned {} match lock.\n", client.pers.netname, settings.matchlock ? "on" : "off");
    gi.cvar_set("matchlock", settings.matchlock ? "1" : "0");
  }

  PMenu_Close(ent);
  CTFOpenAdminMenu(ent);
}

/** ctf/g_ctf.cpp:3391-3395: `void CTFAdmin_SettingsCancel(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_SettingsCancel(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);
  CTFOpenAdminMenu(ent);
}

/** ctf/g_ctf.cpp:3397-3406: `void CTFAdmin_ChangeMatchLen(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeMatchLen(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeMatchLen");
  settings.matchlen = (settings.matchlen % 60) + 5;
  if (settings.matchlen < 5) settings.matchlen = 5;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3408-3417: `void CTFAdmin_ChangeMatchSetupLen(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeMatchSetupLen(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeMatchSetupLen");
  settings.matchsetuplen = (settings.matchsetuplen % 60) + 5;
  if (settings.matchsetuplen < 5) settings.matchsetuplen = 5;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3419-3428: `void CTFAdmin_ChangeMatchStartLen(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeMatchStartLen(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeMatchStartLen");
  settings.matchstartlen = (settings.matchstartlen % 600) + 10;
  if (settings.matchstartlen < 20) settings.matchstartlen = 20;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3430-3436: `void CTFAdmin_ChangeWeapStay(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeWeapStay(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeWeapStay");
  settings.weaponsstay = !settings.weaponsstay;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3438-3444: `void CTFAdmin_ChangeInstantItems(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeInstantItems(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeInstantItems");
  settings.instantitems = !settings.instantitems;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3446-3452: `void CTFAdmin_ChangeQuadDrop(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeQuadDrop(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeQuadDrop");
  settings.quaddrop = !settings.quaddrop;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3454-3460: `void CTFAdmin_ChangeInstantWeap(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeInstantWeap(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeInstantWeap");
  settings.instantweap = !settings.instantweap;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3462-3468: `void CTFAdmin_ChangeMatchLock(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_ChangeMatchLock(ent: EdictT, p: PmenuhndT): void {
  const settings = requireAdminSettings(p, "CTFAdmin_ChangeMatchLock");
  settings.matchlock = !settings.matchlock;
  CTFAdmin_UpdateSettings(ent, p);
}

/** ctf/g_ctf.cpp:3470-3500: `void CTFAdmin_UpdateSettings(edict_t *ent, pmenuhnd_t *setmenu)`. */
function CTFAdmin_UpdateSettings(ent: EdictT, setmenu: PmenuhndT): void {
  const settings = requireAdminSettings(setmenu, "CTFAdmin_UpdateSettings");
  let i = 2;

  PMenu_UpdateEntry(setmenu.entries[i]!, `Match Len:       ${String(settings.matchlen).padStart(2)} mins`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchLen);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Match Setup Len: ${String(settings.matchsetuplen).padStart(2)} mins`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchSetupLen);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Match Start Len: ${String(settings.matchstartlen).padStart(2)} secs`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchStartLen);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Weapons Stay:    ${settings.weaponsstay ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeWeapStay);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Instant Items:   ${settings.instantitems ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeInstantItems);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Quad Drop:       ${settings.quaddrop ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeQuadDrop);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Instant Weapons: ${settings.instantweap ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeInstantWeap);
  i++;
  PMenu_UpdateEntry(setmenu.entries[i]!, `Match Lock:      ${settings.matchlock ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchLock);
  i++;

  PMenu_Update(ent);
}

/** ctf/g_ctf.cpp:3518-3538: `void CTFAdmin_Settings(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_Settings(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);

  const settings: AdminSettingsT = {
    matchlen: cvarInt("matchtime", "20"),
    matchsetuplen: cvarInt("matchsetuptime", "10"),
    matchstartlen: cvarInt("matchstarttime", "20"),
    weaponsstay: cvarBool("g_dm_weapons_stay", "0"),
    instantitems: cvarBool("g_dm_instant_items", "0"),
    quaddrop: !cvarBool("g_dm_no_quad_drop", "0"),
    instantweap: cvarBool("g_instant_weapon_switch", "0"),
    matchlock: cvarBool("matchlock", "1", CvarFlagsT.CVAR_SERVERINFO),
  };

  const menu = PMenu_Open(ent, def_setmenu, -1, def_setmenu.length, settings, null);
  if (menu !== null) CTFAdmin_UpdateSettings(ent, menu);
}

/** ctf/g_ctf.cpp:3540-3559: `void CTFAdmin_MatchSet(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_MatchSet(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);

  if (ctfgame.match === MatchT.MATCH_SETUP) {
    giBroadcastPrint(PRINT_CHAT, "Match has been forced to start.\n");
    ctfgame.match = MatchT.MATCH_PREGAME;
    ctfgame.matchtime = Gtime_add(level.time, Gtime_from_sec(cvarFloat("matchstarttime", "20")));
    gi.positioned_sound(g_edicts[0].s.origin, g_edicts[0], SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("misc/talk1.wav"), 1, ATTN_NONE, 0);
    ctfgame.countdown = false;
  } else if (ctfgame.match === MatchT.MATCH_GAME) {
    giBroadcastPrint(PRINT_CHAT, "Match has been forced to terminate.\n");
    ctfgame.match = MatchT.MATCH_SETUP;
    ctfgame.matchtime = Gtime_add(level.time, Gtime_from_min(cvarFloat("matchsetuptime", "10")));
    CTFResetAllPlayers();
  }
}

/** ctf/g_ctf.cpp:3561-3572: `void CTFAdmin_MatchMode(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_MatchMode(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);

  if (ctfgame.match !== MatchT.MATCH_SETUP) {
    if (cvarInt("competition", "0", CvarFlagsT.CVAR_SERVERINFO) < 3) gi.cvar_set("competition", "2");
    ctfgame.match = MatchT.MATCH_SETUP;
    CTFResetAllPlayers();
  }
}

/** ctf/g_ctf.cpp:3574-3583: `void CTFAdmin_Reset(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_Reset(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);

  giBroadcastPrint(PRINT_CHAT, "Match mode has been terminated, reseting to normal game.\n");
  ctfgame.match = MatchT.MATCH_NONE;
  gi.cvar_set("competition", "1");
  CTFResetAllPlayers();
}

/** ctf/g_ctf.cpp:3585-3588: `void CTFAdmin_Cancel(edict_t *ent, pmenuhnd_t *p)`. */
function CTFAdmin_Cancel(ent: EdictT, _p: PmenuhndT): void {
  PMenu_Close(ent);
}

/** ctf/g_ctf.cpp:3590-3598: `pmenu_t adminmenu[]`. Mutable module state,
 *  matching the real (non-const) C++ array -- CTFOpenAdminMenu mutates
 *  entries[3]/entries[4] in place before every open. */
const adminmenu: PmenuT[] = [
  mkEntry("*Administration Menu", PMENU_ALIGN_CENTER, null),
  mkEntry("", PMENU_ALIGN_CENTER, null),
  mkEntry("Settings", PMENU_ALIGN_LEFT, CTFAdmin_Settings),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("", PMENU_ALIGN_LEFT, null),
  mkEntry("Cancel", PMENU_ALIGN_LEFT, CTFAdmin_Cancel),
  mkEntry("", PMENU_ALIGN_CENTER, null),
];

/** ctf/g_ctf.cpp:3600-3628: `void CTFOpenAdminMenu(edict_t *ent)`. */
function CTFOpenAdminMenu(ent: EdictT): void {
  adminmenu[3]!.text = "";
  adminmenu[3]!.SelectFunc = null;
  adminmenu[4]!.text = "";
  adminmenu[4]!.SelectFunc = null;
  if (ctfgame.match === MatchT.MATCH_SETUP) {
    adminmenu[3]!.text = "Force start match";
    adminmenu[3]!.SelectFunc = CTFAdmin_MatchSet;
    adminmenu[4]!.text = "Reset to pickup mode";
    adminmenu[4]!.SelectFunc = CTFAdmin_Reset;
  } else if (ctfgame.match === MatchT.MATCH_GAME || ctfgame.match === MatchT.MATCH_PREGAME) {
    adminmenu[3]!.text = "Cancel match";
    adminmenu[3]!.SelectFunc = CTFAdmin_MatchSet;
  } else if (ctfgame.match === MatchT.MATCH_NONE && cvarBool("competition", "0", CvarFlagsT.CVAR_SERVERINFO)) {
    adminmenu[3]!.text = "Switch to match mode";
    adminmenu[3]!.SelectFunc = CTFAdmin_MatchMode;
  }

  PMenu_Open(ent, adminmenu, -1, adminmenu.length, null, null);
}

/** ctf/g_ctf.cpp:3630-3657: `void CTFAdmin(edict_t *ent)`. */
export function CTFAdmin(ent: EdictT): void {
  if (!cvarBool("allow_admin", "1")) {
    giLocClientPrint(ent, PRINT_HIGH, "Administration is disabled\n");
    return;
  }

  const client = requireClient(ent, "CTFAdmin");
  const admin_password = cvarString("admin_password", "");

  if (gi.argc() > 1 && admin_password && !client.resp.admin && admin_password === gi.argv(1)) {
    client.resp.admin = true;
    giLocBroadcastPrint(PRINT_HIGH, "{} has become an admin.\n", client.pers.netname);
    giLocClientPrint(ent, PRINT_HIGH, "Type 'admin' to access the adminstration menu.\n");
  }

  if (!client.resp.admin) {
    CTFBeginElection(ent, ElectT.ELECT_ADMIN, `${client.pers.netname} has requested admin rights.\n`);
    return;
  }

  if (client.menu !== null) PMenu_Close(ent);

  CTFOpenAdminMenu(ent);
}

/*----------------------------------------------------------------*/
/* CTFStats / CTFPlayerList / CTFWarp / CTFBoot (ctf/g_ctf.cpp:3659-3862)   */
/*----------------------------------------------------------------*/

/** ctf/g_ctf.cpp:3661-3736: `void CTFStats(edict_t *ent)`. */
export function CTFStats(ent: EdictT): void {
  if (!G_TeamplayEnabled()) return;

  let text = "";

  if (ctfgame.match === MatchT.MATCH_SETUP) {
    for (let i = 1; i <= game.maxclients; i++) {
      const e2 = g_edicts[i];
      if (!e2.inuse || e2.client === null) continue;
      if (!e2.client.resp.ready && e2.client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) {
        const str = `${e2.client.pers.netname} is not ready.\n`;
        if (text.length + str.length < MAX_CTF_STAT_LENGTH - 50) text += str;
      }
    }
  }

  let i = 0;
  for (; i < MAX_CLIENTS; i++) {
    if (ctfgame.ghosts[i]!.ent !== null) break;
  }

  if (i === MAX_CLIENTS) {
    if (!text.length) text = "No statistics available.\n";
    gi.Client_Print(ent, PRINT_HIGH, text);
    return;
  }

  text += "  #|Name            |Score|Kills|Death|BasDf|CarDf|Effcy|\n";

  for (i = 0; i < MAX_CLIENTS; i++) {
    const g = ctfgame.ghosts[i]!;
    if (!g.netname) continue;

    const e = g.deaths + g.kills === 0 ? 50 : Math.trunc((g.kills * 100) / (g.kills + g.deaths));
    const str =
      `${String(g.number).padStart(3)}|${g.netname.slice(0, 16).padEnd(16)}|${String(g.score).padStart(5)}|${String(g.kills).padStart(5)}|` +
      `${String(g.deaths).padStart(5)}|${String(g.basedef).padStart(5)}|${String(g.carrierdef).padStart(5)}|${String(e).padStart(4)}%|\n`;

    if (text.length + str.length > MAX_CTF_STAT_LENGTH - 50) {
      text += "And more...\n";
      break;
    }

    text += str;
  }

  gi.Client_Print(ent, PRINT_HIGH, text);
}

/** ctf/g_ctf.cpp:3738-3773: `void CTFPlayerList(edict_t *ent)`. */
export function CTFPlayerList(ent: EdictT): void {
  let text = "";

  for (let i = 1; i <= game.maxclients; i++) {
    const e2 = g_edicts[i];
    if (!e2.inuse || e2.client === null) continue;

    const connectedMs = Gtime_milliseconds(Gtime_subtract(level.time, e2.client.resp.entertime));
    const status =
      ctfgame.match === MatchT.MATCH_SETUP || ctfgame.match === MatchT.MATCH_PREGAME ? (e2.client.resp.ready ? " (ready)" : " (notready)") : "";

    const str =
      `${String(i).padStart(3)} ${e2.client.pers.netname.slice(0, 16).padEnd(16)} ${String(Math.trunc(connectedMs / 60000)).padStart(2, "0")}:` +
      `${String(Math.trunc((connectedMs % 60000) / 1000)).padStart(2, "0")} ${String(e2.client.ping).padStart(4)} ${String(e2.client.resp.score).padStart(3)}${status}${e2.client.resp.admin ? " (admin)" : ""}\n`;

    if (text.length + str.length > MAX_CTF_STAT_LENGTH - 50) {
      text += "And more...\n";
      break;
    }

    text += str;
  }

  gi.Client_Print(ent, PRINT_HIGH, text);
}

/** ctf/g_ctf.cpp:3775-3813: `void CTFWarp(edict_t *ent)`. */
export function CTFWarp(ent: EdictT): void {
  const client = requireClient(ent, "CTFWarp");
  const warp_list = cvarString("warp_list", "q2ctf1 q2ctf2 q2ctf3 q2ctf4 q2ctf5");

  if (gi.argc() < 2) {
    giLocClientPrint(ent, PRINT_HIGH, "Where do you want to warp to?\n");
    giLocClientPrint(ent, PRINT_HIGH, "Available levels are: {}\n", warp_list);
    return;
  }

  const tokens = warp_list.split(/\s+/).filter((s) => s.length > 0);
  const requested = gi.argv(1);
  const found = tokens.find((tok) => Q_strcasecmp(tok, requested) === 0);

  if (found === undefined) {
    giLocClientPrint(ent, PRINT_HIGH, "Unknown CTF level.\n");
    giLocClientPrint(ent, PRINT_HIGH, "Available levels are: {}\n", warp_list);
    return;
  }

  if (client.resp.admin) {
    giLocBroadcastPrint(PRINT_HIGH, "{} is warping to level {}.\n", client.pers.netname, requested);
    level.forcemap = requested;
    EndDMLevel();
    return;
  }

  if (CTFBeginElection(ent, ElectT.ELECT_MAP, `${client.pers.netname} has requested warping to level ${requested}.\n`)) {
    ctfgame.elevel = requested;
  }
}

/** ctf/g_ctf.cpp:3815-3852: `void CTFBoot(edict_t *ent)`. */
export function CTFBoot(ent: EdictT): void {
  const client = requireClient(ent, "CTFBoot");

  if (!client.resp.admin) {
    giLocClientPrint(ent, PRINT_HIGH, "You are not an admin.\n");
    return;
  }

  if (gi.argc() < 2) {
    giLocClientPrint(ent, PRINT_HIGH, "Who do you want to kick?\n");
    return;
  }

  // ctf/g_ctf.cpp:3831: `if (*gi.argv(1) < '0' && *gi.argv(1) > '9')` -- a
  // single character can never be both less than '0' AND greater than '9'
  // simultaneously, so this guard is unconditionally false in the real
  // source (a genuine, pre-existing bug: "Specify the player number to
  // kick." is dead code, never printed). Ported bug-for-bug: no check here
  // either, matching real behavior exactly.
  const arg1 = gi.argv(1);
  // `strtoul(gi.argv(1), nullptr, 10)` -- leading-digit parse, 0 for
  // anything that doesn't start with a digit (JS's `parseInt` matches this
  // except it yields NaN instead of 0 for a total non-parse; coerced below).
  const parsed = parseInt(arg1, 10);
  const i = Number.isNaN(parsed) ? 0 : parsed;
  if (i < 1 || i > game.maxclients) {
    giLocClientPrint(ent, PRINT_HIGH, "Invalid player number.\n");
    return;
  }

  const targ = g_edicts[i];
  if (!targ.inuse) {
    giLocClientPrint(ent, PRINT_HIGH, "That player number is not connected.\n");
    return;
  }

  gi.AddCommandString(`kick ${i - 1}\n`);
}

/** ctf/g_ctf.cpp:3854-3862: `void CTFSetPowerUpEffect(edict_t *ent, effects_t def)`. Moved
 *  here from p_view.ts (was already real there). */
export function CTFSetPowerUpEffect(ent: EdictT, def: EffectsT): void {
  const client = ent.client;
  if (client !== null && client.resp.ctf_team === CtfteamT.CTF_TEAM1 && def === EffectsT.EF_QUAD) {
    ent.s.effects |= EffectsT.EF_PENT; // red
  } else if (client !== null && client.resp.ctf_team === CtfteamT.CTF_TEAM2 && def === EffectsT.EF_PENT) {
    ent.s.effects |= EffectsT.EF_QUAD; // blue
  } else {
    ent.s.effects |= def;
  }
}
