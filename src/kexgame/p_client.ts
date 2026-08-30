// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_client.c -- client connection / spawn / death / think lifecycle (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/p_client.cpp (3,852 lines,
// C++17): SP_info_player_*, P_UseCoopInstancedItems, ClientObituary,
// TossClientWeapon, LookAtKiller, player_die, InitClientPersistant,
// InitClientResp, SaveClientData/FetchClientEntData, the SelectSpawnPoint
// family (deathmatch/coop/farthest-point/landmark logic), InitBodyQue,
// body_die, CopyToBodyQue, G_PostRespawn, respawn, spectator_respawn,
// PutClientOnSpawnPoint, PutClientInServer, ClientBeginDeathmatch,
// G_SetLevelEntry, ClientBegin, P_GetLobbyUserNum, G_EncodedPlayerName,
// ClientUserinfoChanged, the ClientChooseSlot family, ClientConnect,
// ClientDisconnect, SV_PM_Clip, G_ShouldPlayersCollide, P_FallingDamage,
// HandleMenuMovement, ClientThink, the coop-respawn family
// (G_MonstersSearchingFor/G_FindRespawnSpot/G_FindSquadRespawnTarget/
// G_CoopRespawn), ClientBeginServerFrame, RemoveAttackingPainDaemons.
// Behavioral code, ported bug-for-bug per PORTING.md. Every SP_* is
// exported under its exact C name for the future spawn registry; every
// THINK/USE/DIE function is registered through g_save_registry.ts under
// its exact C name.
//
// ============================================================================
// STUB SWAP: respawn / P_UseCoopInstancedItems -- now real exports from HERE,
// THEIR ACTUAL C++ HOME
// ============================================================================
// p_hud.ts and g_target.ts both carried local, unexported throwing stubs for
// these two symbols (cited "pending p_client.ts"), since neither of them can
// reach this file's real implementation until this unit lands. Both stubs
// are swapped to `import { respawn, P_UseCoopInstancedItems } from
// "./p_client"` as part of this unit -- see this file's own diff to
// p_hud.ts/g_target.ts. g_target.ts's own file header still lists these two
// (plus MoveClientToIntermission, G_SetClientFrame, G_EndOfUnitMessage) as a
// single "not yet ported" group from an earlier unit; that comment is now
// PARTIALLY stale (MoveClientToIntermission and G_SetClientFrame had already
// been swapped to real imports by earlier units without updating that
// comment -- see the next section) and is corrected here to reflect only the
// two swapped in THIS unit.
//
// ============================================================================
// RECONCILIATION: G_SetClientFrame / G_ShouldPlayersCollide / P_AssignClientSkinnum /
// P_ForceFogTransition / MoveClientToIntermission / G_PlayerNotifyGoal /
// G_Monster_CheckCoopHealthScaling -- already real elsewhere, NOT duplicated here
// ============================================================================
// Per this unit's brief ("check first -- p_view.ts may have it; skip
// duplicates"), every one of these was checked against the already-landed
// files before writing a line of this file:
//   - G_SetClientFrame (p_view.cpp, not p_client.cpp -- brief's citation was
//     imprecise) is a real, exported `p_view.ts` function already. p_client.cpp
//     itself never calls it (grepped the whole file: zero matches); nothing
//     to import here.
//   - P_AssignClientSkinnum and P_ForceFogTransition (this file's OWN
//     functions, p_client.cpp:1741/1788) were already ported into p_view.ts by
//     an earlier unit as narrow, cited stubs (p_view.ts's own header, "NARROW
//     STUBS" section) -- their real early-return guards are ported for real
//     there; only their packet-writing tails are stubbed, for reasons
//     unrelated to this unit (a missing skinnum bit-layout helper and a
//     never-yet-triggered fog-transition path). Imported here as
//     `import { P_AssignClientSkinnum, P_ForceFogTransition } from
//     "./p_view"` rather than re-ported, per the "one implementation per
//     symbol" rule this port line uses everywhere a symbol's real home turns
//     out to already be occupied.
//   - MoveClientToIntermission (p_hud.cpp) is a real, exported `p_hud.ts`
//     function already; imported, not re-ported.
//   - G_PlayerNotifyGoal (g_target.cpp) is a real, exported `g_target.ts`
//     function already; imported, not re-ported.
//   - G_Monster_CheckCoopHealthScaling (g_monster.cpp) is a real, exported
//     `g_monster.ts` function already; imported (read-only -- this unit does
//     not edit g_monster.ts, which is owned by a concurrent monster-porting
//     unit), not re-ported.
//   - G_ShouldPlayersCollide (p_client.cpp:2996, genuinely THIS file's own
//     function) had THREE independent local throwing-stub copies before this
//     unit: g_utils.ts (unexported), g_weapon.ts (unexported, its own header
//     cites g_utils.ts's copy as precedent), and p_view.ts (unexported, its
//     own header cites the same precedent again). This unit's brief scopes
//     write access to g_utils.ts's copy only (plus g_target.ts/p_hud.ts for
//     the respawn/P_UseCoopInstancedItems swap and this file); g_weapon.ts's
//     copy is EXPLICITLY left per the brief ("leave g_weapon's local copy...
//     but report it") and p_view.ts's copy is OUT OF SCOPE (p_view.ts is not
//     in this unit's write list) -- both are reported as findings, neither
//     touched. g_utils.ts's copy is swapped to a real, hoisted `export
//     function` import from this file (see g_utils.ts's own diff); this
//     closes a real, sanctioned import cycle the same way g_utils.ts <->
//     g_phys.ts / g_utils.ts <-> g_combat.ts already do (both sides are
//     hoisted `export function` declarations, no top-level cross-module value
//     access at module-init time, so no TDZ hazard).
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED (throwing stubs, cited; each site
// documents its own reachability)
// ============================================================================
// p_weapon.cpp / g_items.cpp cross-deps -- PER THIS UNIT'S BRIEF, these are
// throwing stubs regardless of reachability (both files are being ported
// concurrently by other units; the coordinator reconciles at integration):
//   - ChangeWeapon, Think_Weapon, NoAmmoWeaponChange -> p_weapon.cpp (future
//     p_weapon.ts). NoAmmoWeaponChange is reached by every non-spectator
//     InitClientPersistant call (picks the starting weapon); ChangeWeapon is
//     reached by every non-spectator PutClientInServer call. Both are
//     UNCONDITIONALLY reached on the ordinary spawn path -- this is a known,
//     accepted temporary break per the brief's explicit exception, not an
//     oversight. This file's own test suite structures around it (asserts
//     state set before the throw, or exercises the spectator/early-return
//     paths that return before reaching them).
//   - FindItemByClassname, GetItemByIndex, Drop_Item, Touch_Item ->
//     g_items.cpp (future g_items.ts, landing concurrently). Each file in
//     this port line that needs one of these keeps its OWN local unexported
//     copy rather than importing across modules (see g_trigger.ts's identical
//     `FindItemByClassname` stub for precedent) -- this file's own copies are
//     local to it.
//   - PlayerTrail_Add -> p_trail.cpp (future p_trail.ts; only
//     PlayerTrail_Destroy has landed, in p_hud.ts). Reached at the tail of
//     ClientBeginServerFrame whenever `!deathmatch->integer` (the common
//     coop/SP case) for a live, non-respawning client -- also unconditionally
//     reached on the ordinary alive-player path, same accepted-break shape as
//     ChangeWeapon/Think_Weapon above.
//   - Bot_BeginFrame -> bots/bot_includes.h (future src/kexgame/bots/).
//     Reached only when `ent.svflags & SVF_BOT` (never set by any spawn path
//     in this port line's own fixtures).
//
// ctf/g_ctf.cpp cross-deps (no g_ctf.ts anywhere in this port line yet).
// Every one of these is called from a site this port line's real cvar/state
// defaults (ctf_team always CTF_NOTEAM, ctf_grapple always null, inventory
// always zero, `ctf`/`teamplay`/`gamerules` cvars all default 0) make
// unreachable in practice, so per this port line's "an unconditionally-called
// function whose OWN early-return guard is real and always taken isn't a
// stub, it's a faithful no-op" precedent (p_view.ts's CTFStartClient-shaped
// entries, g_combat.ts's DMGame precedent), the REACHABLE PREFIX of each is
// ported for real and only the genuinely-unreached tail throws:
//   - CTFFragBonuses (ctf/g_ctf.cpp:428): the ghost-stat bumps (ghost is
//     always null) and the `targ==attacker` / `CTFOtherTeam(ctf_team) < 0`
//     early returns are real; CTFOtherTeam(CTF_NOTEAM) always returns -1
//     (ctf/g_ctf.cpp:263-273, ported verbatim below), so the guard always
//     fires and the throwing tail (real flag-carrier scoring logic) is never
//     reached by anything this port line can currently produce.
//   - CTFPlayerResetGrapple (ctf/g_ctf.cpp:1222): the `ctf_grapple !== null`
//     guard is real; `ctf_grapple` is never assigned non-null anywhere in
//     this port line, so CTFResetGrapple (nested stub) is never reached.
//   - CTFDeadDropFlag (ctf/g_ctf.cpp:791) / CTFDeadDropTech
//     (ctf/g_ctf.cpp:1891): the inventory-nonzero guards are real; IT_FLAG1/
//     IT_FLAG2/tech-item slots are never populated anywhere in this port
//     line (same "reached only if IT_FLAG1/IT_FLAG2 inventory is ever
//     nonzero" precedent p_view.ts's own header already established for
//     CTFEffects), so both are real no-ops given current state.
//   - CTFStartClient (ctf/g_ctf.cpp:2965): the `G_TeamplayEnabled()` guard is
//     real (already-real import from p_view.ts); ctf/teamplay cvars default
//     0, so the throwing tail is never reached.
// Narrow stubs (the call site itself is cvar/state-guarded, not the
// function's own internals):
//   - G_AdjustTeamScore (ctf/g_ctf.cpp:62): reached only when `teamplay`
//     cvar is enabled (default 0).
//   - SelectCTFSpawnPoint (ctf/g_ctf.cpp:358), CTFAssignTeam
//     (ctf/g_ctf.cpp:308), CTFAssignSkin (ctf/g_ctf.cpp:280): reached only
//     when `G_TeamplayEnabled()` is true (default false).
//   - CTFGrapplePull (ctf/g_ctf.cpp:1311): reached only when
//     `client.ctf_grapple !== null` (always null).
//   - ED_CallSpawn (g_spawn.cpp, future g_spawn.ts in THIS port line -- the
//     legacy/vanilla `src/game/g_spawn.ts` is a different port line and does
//     not satisfy this): not called anywhere in p_client.cpp; not stubbed
//     here at all (g_target.ts already owns an identical stub for its own
//     target_spawner use).
//
// ============================================================================
// DEVIATION: "split-screen suffixed userinfo keys" -- not present in the
// cited source
// ============================================================================
// This unit's brief flagged ClientUserinfoChanged as having "split-screen
// suffixed userinfo keys". Grepped the exact cited source file
// (~/Projects/quake2-rerelease-dll/rerelease/p_client.cpp) for
// "splitscreen"/"split_screen"/"_0\"" patterns: zero matches anywhere in the
// file. `ClientUserinfoChanged` here reads plain, unsuffixed userinfo keys
// ("name", "spectator", "skin", "dogtag", "fov", "hand", "autoswitch",
// "autoshield", "bobskip") exactly as this checkout defines them. Ported
// faithfully to the actual source rather than inventing split-screen key
// suffixing that does not exist in it; flagged here as a brief/source
// mismatch rather than silently ignored.
//
// ============================================================================
// DEVIATION: DMGame / gamerules -- concrete faithful values, not stubs
// ============================================================================
// Every `if (gamerules->integer) { if (DMGame.X) DMGame.X(...); }` site
// (ClientObituary, player_die, ClientDisconnect, ClientBeginDeathmatch) and
// `gamerules->integer && DMGame.SelectSpawnPoint`/`DMGame.ClientBegin` site
// (PutClientInServer, ClientBeginDeathmatch) follows g_combat.ts's own
// established "DMGame -- concrete faithful value, not a stub" precedent: a
// real `cvarBool("gamerules", "0", ...)` check (concretely false, matching
// g_main.cpp's registered default) makes every DMGame.* read unreachable, so
// the branch is ported as real dead code with a comment, never a throw.
// DMGame itself is NOT re-declared here (g_combat.ts's own module-local copy
// is unexported); the branch bodies are simply never taken.
//
// ============================================================================
// DEVIATION: pm_config -- PM_CONFIG_DEFAULT used, no live global exists yet
// ============================================================================
// ClientThink reads the real engine's `pm_config.n64_physics` mutable global
// (p_move.cpp, later assigned from a cvar by g_main.cpp -- itself unported in
// this line). bg_local.ts's own header already documents that this port line
// deliberately threads `PmConfigT` as an explicit `Pmove()` parameter instead
// of a hidden global; `PM_CONFIG_DEFAULT` (n64_physics: false) is used here
// for both of ClientThink's `pm_config.n64_physics` reads, matching a fresh
// server's real default before any g_main.cpp cvar wiring exists.
//
// ============================================================================
// `world` convenience alias -- matches this port line's existing idiom
// ============================================================================
// `const world = g_edicts[0]` is used at each site that needs it, matching
// the identical local alias already used by g_combat.ts/g_weapon.ts/
// g_target.ts (grepped before writing; same idiom, not invented here).
//
// ============================================================================
// active_players() -- duplicated per-file, not imported
// ============================================================================
// g_target.ts already carries an unexported `active_players()` generator
// (g_local.h:3426-3437). Per this port line's "duplicate the tiny unexported
// helper, don't reach across files for it" convention (same precedent
// g_weapon.ts's own G_ShouldPlayersCollide note documents), this file gets
// its own identical copy rather than importing g_target.ts's.
//
// ============================================================================
// CopyToBodyQue: `body->s = ent->s` struct-value copy
// ============================================================================
// C performs a full struct assignment of `entity_state_t`. TS objects are
// reference types, so a naive `body.s = ent.s` would alias the two entities'
// state instead of copying it (and the Vec3 sub-fields would alias too, even
// with a shallow spread). `copyEntityState` below copies every
// `KexEntityStateT` field, cloning the three Vec3 fields with `vec3(...)` so
// the body queue entity's origin/angles/old_origin are independent storage.

import { vec3, type Vec3 } from "../shared/math";
import { CvarT } from "../shared/q_shared";
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
  type KexEntityStateT,
  type KexPmoveT,
  type KexPmoveStateT,
  type KexPlayerStateT,
  MAX_STATS,
  type KexTraceT,
  type KexUsercmdT,
  KexMulticastT,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  MASK_WATER,
  MAX_CLIENTS,
  MAX_INFO_VALUE,
  MAX_NETNAME,
  MODELINDEX_PLAYER,
  PmflagsT,
  KexPmTypeT,
  PrintTypeT,
  RenderfxT,
  RefdefFlagsT,
  ServerCommandT,
  SolidT,
  SoundchanT,
  SvflagsT,
  WaterLevelT,
} from "../kexapi/game";
import {
  AmmoT,
  AutoSwitchT,
  BODY_QUEUE_SIZE,
  type DieFn,
  type EdictT,
  EntFlagsT,
  FALL_TIME,
  type GClientT,
  HandednessT,
  ItemIdT,
  MELEE_DISTANCE,
  ModIdT,
  type ModT,
  MovetypeT,
  PLAYER_MAXS,
  PLAYER_MINS,
  PlayerNoiseT,
  SPAWNFLAG_ITEM_DROPPED,
  SPAWNFLAG_ITEM_DROPPED_PLAYER,
  StuckResultT,
  type ThinkFn,
  WeaponstateT,
  AnimPriorityT,
} from "./g_local";
import type { ClientPersistantT, ClientRespawnT, GhostT, GitemT } from "./g_local_types";
import { CtfteamT } from "./g_local_types";
import { g_edicts, game, gi, globals, level } from "./g_main_globals";
import { RegisterDie, RegisterThink } from "./g_save_registry";
import { GTIME_ZERO, type GTime, Gtime_add, Gtime_from_ms, Gtime_from_sec, Gtime_milliseconds, Gtime_nonzero, Gtime_subtract } from "./gtime";
import { SpawnFlags_and, SpawnFlags_from, SpawnFlags_has, SpawnFlags_not, SpawnFlags_or, type SpawnFlags } from "./spawnflags";
import { clamp, crandom_open, irandom, random_element } from "./q_std";
import { AngleVectors, RotatePointAroundVector, vec3_add, vec3_length, vec3_sub } from "./q_vec3";
import { G_FindByString, G_FreeEdict, G_InitEdict, G_PickTarget, G_Spawn, G_TouchProjectiles, G_TouchTriggers, KillBox } from "./g_utils";
import { T_Damage } from "./g_combat";
import { G_FixStuckObject_Generic } from "./p_move";
import { PM_CONFIG_DEFAULT } from "./bg_local";
import { ClientEndServerFrame, G_TeamplayEnabled, P_AssignClientSkinnum, P_ForceFogTransition } from "./p_view";
import { Cmd_Help_f, MoveClientToIntermission, PlayerTrail_Destroy } from "./p_hud";
import { ThrowClientHead, ThrowGibs } from "./g_misc";
import { G_PlayerNotifyGoal } from "./g_target";
import { G_FixStuckObject, G_Monster_CheckCoopHealthScaling } from "./g_monster";
import {
  FRAME_crdeath1,
  FRAME_crdeath5,
  FRAME_death101,
  FRAME_death106,
  FRAME_death201,
  FRAME_death206,
  FRAME_death301,
  FRAME_death308,
} from "./m_player";

// ---------------------------------------------------------------------------
// small per-file cvar helpers (duplicated per this port line's established
// "tiny header-only wrapper, duplicated on purpose" idiom -- see p_view.ts's
// / g_target.ts's own identical copies)
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarFloat(name, def, flags) !== 0;
}

function cvarString(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): string {
  const c = gi.cvar(name, def, flags);
  return c === null ? def : c.string;
}

function deathmatchEnabled(): boolean {
  return cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
}

function coopEnabled(): boolean {
  return cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH);
}

/** `LocCenter_Print(e, base, ...args)` convenience wrapper (see g_trigger.ts's identical copy). */
function giLocCenterPrint(e: EdictT | null, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(e, PrintTypeT.PRINT_CENTER, base, args.map(String), args.length);
}

/** `LocBroadcast_Print(level, base, ...args)` -- no counterpart on KexGameImports;
 * see g_target.ts's identical `gi.Loc_Print(null, level | PRINT_BROADCAST, ...)` precedent. */
function giLocBroadcastPrint(printlevel: PrintTypeT, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(null, printlevel | PrintTypeT.PRINT_BROADCAST, base, args.map(String), args.length);
}

/** `LocClient_Print(ent, level, base, ...args)` -- single-target loc print. */
function giLocClientPrint(ent: EdictT | null, printlevel: PrintTypeT, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(ent, printlevel, base, args.map(String), args.length);
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players. Duplicated per-file -- see file header. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

// ---------------------------------------------------------------------------
// unported cross-deps (throwing stubs) -- see file header
// ---------------------------------------------------------------------------

// (p_weapon.ts and g_items.ts landed -- former throwing stubs are real
// imports; the GetItemByIndex/FindItemByClassname adapters preserve this
// file's original narrow signatures where the C++ would null-deref.)
import { ChangeWeapon, Think_Weapon, NoAmmoWeaponChange } from "./p_weapon";
import { PlayerTrail_Add } from "./p_trail";
import {
  FindItemByClassname as G_FindItemByClassname,
  GetItemByIndex as G_GetItemByIndex,
  Drop_Item,
  Touch_Item as G_Touch_Item,
} from "./g_items";

function FindItemByClassname(classname: string | null): GitemT | null {
  return classname === null ? null : G_FindItemByClassname(classname);
}

function GetItemByIndex(id: ItemIdT): GitemT {
  const item = G_GetItemByIndex(id);
  // C++ dereferences the returned pointer unchecked at these call sites.
  if (!item) throw new Error(`GetItemByIndex(${id}): null item (C++ would crash here)`);
  return item;
}

const Touch_Item = G_Touch_Item;



function Bot_BeginFrame(_ent: EdictT): void {
  throw new Error("Bot_BeginFrame: not yet ported (pending bots module, see bots/bot_includes.h)");
}

function PMenu_Prev(_ent: EdictT): void {
  throw new Error("PMenu_Prev: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp)");
}

function PMenu_Next(_ent: EdictT): void {
  throw new Error("PMenu_Next: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp)");
}

function PMenu_Select(_ent: EdictT): void {
  throw new Error("PMenu_Select: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp)");
}

function GetChaseTarget(_ent: EdictT): void {
  throw new Error("GetChaseTarget: not yet ported (pending g_chase.ts, see g_chase.cpp:149)");
}

function ChaseNext(_ent: EdictT): void {
  throw new Error("ChaseNext: not yet ported (pending g_chase.ts, see g_chase.cpp:99)");
}

function UpdateChaseCam(_ent: EdictT): void {
  throw new Error("UpdateChaseCam: not yet ported (pending g_chase.ts, see g_chase.cpp:5)");
}

// ---------------------------------------------------------------------------
// ctf/g_ctf.cpp cross-deps -- see file header for the reachable-prefix strategy
// ---------------------------------------------------------------------------

/** ctf/g_ctf.cpp:263-273: `int CTFOtherTeam(int team)` -- real, tiny, ported in full. */
function CTFOtherTeam(team: CtfteamT): number {
  switch (team) {
    case CtfteamT.CTF_TEAM1:
      return CtfteamT.CTF_TEAM2;
    case CtfteamT.CTF_TEAM2:
      return CtfteamT.CTF_TEAM1;
    default:
      return -1; // invalid value
  }
}

/** ctf/g_ctf.cpp:1229: `void CTFResetGrapple(edict_t *self)` -- unreached (see file header). */
function CTFResetGrapple(_self: EdictT): void {
  throw new Error("CTFResetGrapple: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1229); unreached -- ctf_grapple is always null in this port line");
}

/** ctf/g_ctf.cpp:428: `void CTFFragBonuses(edict_t *targ, edict_t *inflictor, edict_t *attacker)`.
 * The reachable prefix (ghost bumps, self-frag guard, CTFOtherTeam guard) is real; see file header. */
function CTFFragBonuses(targ: EdictT, _inflictor: EdictT, attacker: EdictT): void {
  if (targ.client !== null && attacker.client !== null) {
    // attacker.client.resp.ghost / targ.client.resp.ghost: always null in this port line.
  }

  // no bonus for fragging yourself
  if (targ.client === null || attacker.client === null || targ === attacker) return;

  const otherteam = CTFOtherTeam(targ.client.resp.ctf_team);
  if (otherteam < 0) return; // whoever died isn't on a team -- always true here (ctf_team defaults CTF_NOTEAM)

  throw new Error(
    "CTFFragBonuses: not yet ported past the ctf_team guard (pending g_ctf.ts, see ctf/g_ctf.cpp:454); unreached -- ctf_team is always CTF_NOTEAM in this port line",
  );
}

/** ctf/g_ctf.cpp:1222: `void CTFPlayerResetGrapple(edict_t *ent)`. */
function CTFPlayerResetGrapple(ent: EdictT): void {
  if (ent.client !== null && ent.client.ctf_grapple !== null) {
    CTFResetGrapple(ent.client.ctf_grapple);
  }
}

/** ctf/g_ctf.cpp:791: `void CTFDeadDropFlag(edict_t *self)`. Real no-op given current defaults; see file header. */
function CTFDeadDropFlag(self: EdictT): void {
  if (self.client === null) return;
  if (self.client.pers.inventory[ItemIdT.IT_FLAG1] !== 0 || self.client.pers.inventory[ItemIdT.IT_FLAG2] !== 0) {
    throw new Error(
      "CTFDeadDropFlag: not yet ported past the flag-inventory check (pending g_items.ts/g_ctf.ts, see ctf/g_ctf.cpp:791); unreached -- IT_FLAG1/IT_FLAG2 are never nonzero in this port line",
    );
  }
}

const CTF_TECH_IDS: readonly ItemIdT[] = [ItemIdT.IT_TECH_RESISTANCE, ItemIdT.IT_TECH_STRENGTH, ItemIdT.IT_TECH_HASTE, ItemIdT.IT_TECH_REGENERATION];

/** ctf/g_ctf.cpp:1891: `void CTFDeadDropTech(edict_t *ent)`. Real no-op given current defaults; see file header. */
function CTFDeadDropTech(ent: EdictT): void {
  if (ent.client === null) return;
  for (const id of CTF_TECH_IDS) {
    if (ent.client.pers.inventory[id] !== 0) {
      throw new Error(
        "CTFDeadDropTech: not yet ported past the tech-inventory check (pending g_items.ts, see ctf/g_ctf.cpp:1891); unreached -- tech items are never held in this port line",
      );
    }
  }
}

/** ctf/g_ctf.cpp:2965: `bool CTFStartClient(edict_t *ent)`. Real guard; see file header. */
function CTFStartClient(ent: EdictT): boolean {
  if (!G_TeamplayEnabled()) return false;
  throw new Error(
    "CTFStartClient: not yet ported past the G_TeamplayEnabled() guard (pending g_ctf.ts, see ctf/g_ctf.cpp:2965); unreached -- ctf/teamplay cvars default to 0",
  );
  void ent;
}

/** ctf/g_ctf.cpp:62: `void G_AdjustTeamScore(ctfteam_t team, int32_t offset)`. */
function G_AdjustTeamScore(_team: CtfteamT, _offset: number): void {
  throw new Error("G_AdjustTeamScore: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:62); reached only when the teamplay cvar is enabled (default 0)");
}

/** ctf/g_ctf.cpp:358: `edict_t *SelectCTFSpawnPoint(edict_t *ent, bool force_spawn)`. */
function SelectCTFSpawnPoint(_ent: EdictT, _force_spawn: boolean): EdictT | null {
  throw new Error("SelectCTFSpawnPoint: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:358); reached only when G_TeamplayEnabled() is true (default false)");
}

/** ctf/g_ctf.cpp:308: `void CTFAssignTeam(gclient_t *who)`. */
function CTFAssignTeam(_who: GClientT): void {
  throw new Error("CTFAssignTeam: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:308); reached only when G_TeamplayEnabled() is true (default false)");
}

/** ctf/g_ctf.cpp:280: `void CTFAssignSkin(edict_t *ent, const char *s)`. */
function CTFAssignSkin(_ent: EdictT, _s: string): void {
  throw new Error("CTFAssignSkin: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:280); reached only when G_TeamplayEnabled() is true (default false)");
}

/** ctf/g_ctf.cpp:1311: `void CTFGrapplePull(edict_t *self)`. */
function CTFGrapplePull(_self: EdictT): void {
  throw new Error("CTFGrapplePull: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1311); reached only when client.ctf_grapple is non-null (always null)");
}

// ---------------------------------------------------------------------------
// [Paril-KEX] ugly global to handle squad respawn origin (p_client.cpp:1944-1947)
// ---------------------------------------------------------------------------

let use_squad_respawn = false;
let spawn_from_begin = false;
let squad_respawn_position: Vec3 = vec3();
let squad_respawn_angles: Vec3 = vec3();

// ---------------------------------------------------------------------------
// SP_info_player_* (p_client.cpp:7-95)
// ---------------------------------------------------------------------------

/** p_client.cpp:9-17: `THINK(info_player_start_drop)`. */
export const info_player_start_drop: ThinkFn = RegisterThink("info_player_start_drop", (self: EdictT): void => {
  // allow them to drop
  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.mins = vec3(PLAYER_MINS[0], PLAYER_MINS[1], PLAYER_MINS[2]);
  self.maxs = vec3(PLAYER_MAXS[0], PLAYER_MAXS[1], PLAYER_MAXS[2]);
  gi.linkentity(self);
});

/** p_client.cpp:22-35: `void SP_info_player_start(edict_t *self)`. */
export function SP_info_player_start(self: EdictT): void {
  // fix stuck spawn points
  if (gi.trace(self.s.origin, PLAYER_MINS, PLAYER_MAXS, self.s.origin, self, MASK_SOLID).startsolid) {
    G_FixStuckObject(self, self.s.origin);
  }

  // [Paril-KEX] on n64, since these can spawn riding elevators,
  // allow them to "ride" the elevators so respawning works
  if (level.is_n64) {
    self.think = info_player_start_drop;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  }
}

/** p_client.cpp:40-48: `void SP_info_player_deathmatch(edict_t *self)`. */
export function SP_info_player_deathmatch(self: EdictT): void {
  if (!deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }
  // SP_misc_teleporter_dest is unported (g_misc.cpp has a differently-named
  // set of teleporter spawns in this port line; grepped g_misc.ts for
  // `SP_misc_teleporter_dest`: zero matches). This forward-declared C++
  // function only relabels the entity's mins/maxs/solid to match a player
  // spawn point -- reproduced inline rather than stubbed, since it is
  // reached on every real deathmatch map with info_player_deathmatch spots.
  self.mins = vec3(PLAYER_MINS[0], PLAYER_MINS[1], PLAYER_MINS[2]);
  self.maxs = vec3(PLAYER_MAXS[0], PLAYER_MAXS[1], PLAYER_MAXS[2]);
  self.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(self);
}

/** p_client.cpp:53-62: `void SP_info_player_coop(edict_t *self)`. */
export function SP_info_player_coop(self: EdictT): void {
  if (!coopEnabled()) {
    G_FreeEdict(self);
    return;
  }

  SP_info_player_start(self);
}

/** p_client.cpp:68-79: `void SP_info_player_coop_lava(edict_t *self)`. */
export function SP_info_player_coop_lava(self: EdictT): void {
  if (!coopEnabled()) {
    G_FreeEdict(self);
    return;
  }

  // fix stuck spawn points
  if (gi.trace(self.s.origin, PLAYER_MINS, PLAYER_MAXS, self.s.origin, self, MASK_SOLID).startsolid) {
    G_FixStuckObject(self, self.s.origin);
  }
}

/** p_client.cpp:85-87: `void SP_info_player_intermission(edict_t *ent)`. */
export function SP_info_player_intermission(_ent: EdictT): void {
  // empty in the original
}

/** p_client.cpp:90-95: `bool P_UseCoopInstancedItems()`. Real export -- see file header "STUB SWAP". */
export function P_UseCoopInstancedItems(): boolean {
  // squad respawn forces instanced items on, since we don't
  // want players to need to backtrack just to get their stuff.
  return cvarBool("g_coop_instanced_items", "0") || cvarBool("g_coop_squad_respawn", "1");
}

// ---------------------------------------------------------------------------
// ClientObituary (p_client.cpp:99-411)
// ---------------------------------------------------------------------------

export function ClientObituary(self: EdictT, inflictor: EdictT, attacker: EdictT, mod: ModT): void {
  let base: string | null = null;

  if (coopEnabled() && attacker.client !== null) mod = { ...mod, friendly_fire: true };

  switch (mod.id) {
    case ModIdT.MOD_SUICIDE:
      base = "$g_mod_generic_suicide";
      break;
    case ModIdT.MOD_FALLING:
      base = "$g_mod_generic_falling";
      break;
    case ModIdT.MOD_CRUSH:
      base = "$g_mod_generic_crush";
      break;
    case ModIdT.MOD_WATER:
      base = "$g_mod_generic_water";
      break;
    case ModIdT.MOD_SLIME:
      base = "$g_mod_generic_slime";
      break;
    case ModIdT.MOD_LAVA:
      base = "$g_mod_generic_lava";
      break;
    case ModIdT.MOD_EXPLOSIVE:
    case ModIdT.MOD_BARREL:
      base = "$g_mod_generic_explosive";
      break;
    case ModIdT.MOD_EXIT:
      base = "$g_mod_generic_exit";
      break;
    case ModIdT.MOD_TARGET_LASER:
      base = "$g_mod_generic_laser";
      break;
    case ModIdT.MOD_TARGET_BLASTER:
      base = "$g_mod_generic_blaster";
      break;
    case ModIdT.MOD_BOMB:
    case ModIdT.MOD_SPLASH:
    case ModIdT.MOD_TRIGGER_HURT:
      base = "$g_mod_generic_hurt";
      break;
    case ModIdT.MOD_GEKK:
    case ModIdT.MOD_BRAINTENTACLE:
      base = "$g_mod_generic_gekk";
      break;
    default:
      base = null;
      break;
  }

  if (attacker === self) {
    switch (mod.id) {
      case ModIdT.MOD_HELD_GRENADE:
        base = "$g_mod_self_held_grenade";
        break;
      case ModIdT.MOD_HG_SPLASH:
      case ModIdT.MOD_G_SPLASH:
        base = "$g_mod_self_grenade_splash";
        break;
      case ModIdT.MOD_R_SPLASH:
        base = "$g_mod_self_rocket_splash";
        break;
      case ModIdT.MOD_BFG_BLAST:
        base = "$g_mod_self_bfg_blast";
        break;
      case ModIdT.MOD_TRAP:
        base = "$g_mod_self_trap";
        break;
      case ModIdT.MOD_DOPPLE_EXPLODE:
        base = "$g_mod_self_dopple_explode";
        break;
      default:
        base = "$g_mod_self_default";
        break;
    }
  }

  if (self.client === null) throw new Error("ClientObituary: self.client is null (invariant violated -- only players die)");

  // send generic/self
  if (base !== null) {
    giLocBroadcastPrint(PrintTypeT.PRINT_MEDIUM, base, self.client.pers.netname);
    if (deathmatchEnabled() && !mod.no_point_loss) {
      self.client.resp.score--;
      if (cvarBool("teamplay", "0")) G_AdjustTeamScore(self.client.resp.ctf_team, -1);
    }
    self.enemy = null;
    return;
  }

  // has a killer
  self.enemy = attacker;
  if (attacker.client !== null) {
    switch (mod.id) {
      case ModIdT.MOD_BLASTER:
        base = "$g_mod_kill_blaster";
        break;
      case ModIdT.MOD_SHOTGUN:
        base = "$g_mod_kill_shotgun";
        break;
      case ModIdT.MOD_SSHOTGUN:
        base = "$g_mod_kill_sshotgun";
        break;
      case ModIdT.MOD_MACHINEGUN:
        base = "$g_mod_kill_machinegun";
        break;
      case ModIdT.MOD_CHAINGUN:
        base = "$g_mod_kill_chaingun";
        break;
      case ModIdT.MOD_GRENADE:
        base = "$g_mod_kill_grenade";
        break;
      case ModIdT.MOD_G_SPLASH:
        base = "$g_mod_kill_grenade_splash";
        break;
      case ModIdT.MOD_ROCKET:
        base = "$g_mod_kill_rocket";
        break;
      case ModIdT.MOD_R_SPLASH:
        base = "$g_mod_kill_rocket_splash";
        break;
      case ModIdT.MOD_HYPERBLASTER:
        base = "$g_mod_kill_hyperblaster";
        break;
      case ModIdT.MOD_RAILGUN:
        base = "$g_mod_kill_railgun";
        break;
      case ModIdT.MOD_BFG_LASER:
        base = "$g_mod_kill_bfg_laser";
        break;
      case ModIdT.MOD_BFG_BLAST:
        base = "$g_mod_kill_bfg_blast";
        break;
      case ModIdT.MOD_BFG_EFFECT:
        base = "$g_mod_kill_bfg_effect";
        break;
      case ModIdT.MOD_HANDGRENADE:
        base = "$g_mod_kill_handgrenade";
        break;
      case ModIdT.MOD_HG_SPLASH:
        base = "$g_mod_kill_handgrenade_splash";
        break;
      case ModIdT.MOD_HELD_GRENADE:
        base = "$g_mod_kill_held_grenade";
        break;
      case ModIdT.MOD_TELEFRAG:
      case ModIdT.MOD_TELEFRAG_SPAWN:
        base = "$g_mod_kill_telefrag";
        break;
      case ModIdT.MOD_RIPPER:
        base = "$g_mod_kill_ripper";
        break;
      case ModIdT.MOD_PHALANX:
        base = "$g_mod_kill_phalanx";
        break;
      case ModIdT.MOD_TRAP:
        base = "$g_mod_kill_trap";
        break;
      case ModIdT.MOD_CHAINFIST:
        base = "$g_mod_kill_chainfist";
        break;
      case ModIdT.MOD_DISINTEGRATOR:
        base = "$g_mod_kill_disintegrator";
        break;
      case ModIdT.MOD_ETF_RIFLE:
        base = "$g_mod_kill_etf_rifle";
        break;
      case ModIdT.MOD_HEATBEAM:
        base = "$g_mod_kill_heatbeam";
        break;
      case ModIdT.MOD_TESLA:
        base = "$g_mod_kill_tesla";
        break;
      case ModIdT.MOD_PROX:
        base = "$g_mod_kill_prox";
        break;
      case ModIdT.MOD_NUKE:
        base = "$g_mod_kill_nuke";
        break;
      case ModIdT.MOD_VENGEANCE_SPHERE:
        base = "$g_mod_kill_vengeance_sphere";
        break;
      case ModIdT.MOD_DEFENDER_SPHERE:
        base = "$g_mod_kill_defender_sphere";
        break;
      case ModIdT.MOD_HUNTER_SPHERE:
        base = "$g_mod_kill_hunter_sphere";
        break;
      case ModIdT.MOD_TRACKER:
        base = "$g_mod_kill_tracker";
        break;
      case ModIdT.MOD_DOPPLE_EXPLODE:
        base = "$g_mod_kill_dopple_explode";
        break;
      case ModIdT.MOD_DOPPLE_VENGEANCE:
        base = "$g_mod_kill_dopple_vengeance";
        break;
      case ModIdT.MOD_DOPPLE_HUNTER:
        base = "$g_mod_kill_dopple_hunter";
        break;
      case ModIdT.MOD_GRAPPLE:
        base = "$g_mod_kill_grapple";
        break;
      default:
        base = "$g_mod_kill_generic";
        break;
    }

    if (attacker.client === null) throw new Error("ClientObituary: attacker.client is null (invariant violated)");
    giLocBroadcastPrint(PrintTypeT.PRINT_MEDIUM, base, self.client.pers.netname, attacker.client.pers.netname);

    if (G_TeamplayEnabled()) {
      // ZOID: if at start and same team, clear. [Paril-KEX] moved here so
      // it's not an outlier in player_die.
      if (mod.id === ModIdT.MOD_TELEFRAG_SPAWN && self.client.resp.ctf_state < 2 && self.client.resp.ctf_team === attacker.client.resp.ctf_team) {
        self.client.resp.ctf_state = 0;
        return;
      }
    }

    // ROGUE: DMGame.Score -- always null in this port line (gamerules
    // defaults 0; see file header "DEVIATION: DMGame / gamerules").
    if (cvarBool("gamerules", "0")) {
      return;
    }

    if (deathmatchEnabled()) {
      if (mod.friendly_fire) {
        if (!mod.no_point_loss) {
          attacker.client.resp.score--;
          if (cvarBool("teamplay", "0")) G_AdjustTeamScore(attacker.client.resp.ctf_team, -1);
        }
      } else {
        attacker.client.resp.score++;
        if (cvarBool("teamplay", "0")) G_AdjustTeamScore(attacker.client.resp.ctf_team, 1);
      }
    } else if (!coopEnabled()) {
      self.client.resp.score--;
    }

    return;
  }

  giLocBroadcastPrint(PrintTypeT.PRINT_MEDIUM, "$g_mod_generic_died", self.client.pers.netname);
  if (deathmatchEnabled() && !mod.no_point_loss) {
    // ROGUE: DMGame.Score -- always null in this port line (see file header).
    if (cvarBool("gamerules", "0")) {
      return;
    } else {
      self.client.resp.score--;
      if (cvarBool("teamplay", "0")) {
        // p_client.cpp:407 dereferences `attacker->client->resp.ctf_team`
        // unconditionally here. Control only reaches this final tail when
        // the earlier `if (attacker && attacker->client) {...return;}` block
        // did NOT return -- i.e. `attacker.client` is PROVABLY always null
        // at this point (TypeScript's own control-flow narrowing confirms
        // it: `attacker.client` types as `never` past a redundant null
        // check here). So the real engine's own source dereferences a null
        // `gclient_t*` whenever teamplay is enabled and a non-client
        // attacker (e.g. world, an environmental hazard) kills a player.
        // This is a reproduced upstream bug, not a guess: faithfully
        // reproduced as a thrown error (this port line has no "undefined
        // behavior" primitive to match a real null-pointer crash with)
        // rather than silently guessing a value the source itself never
        // computes.
        throw new Error(
          "ClientObituary: reproduced upstream null-pointer bug (p_client.cpp:407) -- attacker->client->resp.ctf_team dereferenced with a non-client attacker under teamplay",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TossClientWeapon (p_client.cpp:413-494)
// ---------------------------------------------------------------------------

export function TossClientWeapon(self: EdictT): void {
  if (self.client === null) throw new Error("TossClientWeapon: self.client is null (invariant violated -- only players toss weapons)");
  if (!deathmatchEnabled()) return;

  let item: GitemT | null = self.client.pers.weapon;
  if (item !== null && cvarBool("g_instagib", "0")) item = null;
  if (item !== null && self.client.pers.inventory[item.ammo] === 0) item = null;
  if (item !== null && item.drop === null) item = null;

  const quad = cvarBool("g_dm_no_quad_drop", "0") ? false : self.client.quad_time > Gtime_add(level.time, Gtime_from_sec(1));
  const quadfire = cvarBool("g_dm_no_quadfire_drop", "0") ? false : self.client.quadfire_time > Gtime_add(level.time, Gtime_from_sec(1));

  let spread: number;
  if (item !== null && quad) spread = 22.5;
  else if (item !== null && quadfire) spread = 12.5;
  else spread = 0.0;

  if (item !== null) {
    self.client.v_angle[1] -= spread; // YAW
    const drop = Drop_Item(self, item);
    self.client.v_angle[1] += spread;
    drop.spawnflags = SpawnFlags_or(drop.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
    drop.spawnflags = SpawnFlags_and(drop.spawnflags, SpawnFlags_not(SPAWNFLAG_ITEM_DROPPED));
    drop.svflags &= ~SvflagsT.SVF_INSTANCED;
  }

  if (quad) {
    self.client.v_angle[1] += spread;
    const drop = Drop_Item(self, GetItemByIndex(ItemIdT.IT_ITEM_QUAD));
    self.client.v_angle[1] -= spread;
    drop.spawnflags = SpawnFlags_or(drop.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
    drop.spawnflags = SpawnFlags_and(drop.spawnflags, SpawnFlags_not(SPAWNFLAG_ITEM_DROPPED));
    drop.svflags &= ~SvflagsT.SVF_INSTANCED;

    drop.touch = Touch_Item;
    drop.nextthink = self.client.quad_time;
    drop.think = G_FreeEdict;
  }

  if (quadfire) {
    self.client.v_angle[1] += spread;
    const drop = Drop_Item(self, GetItemByIndex(ItemIdT.IT_ITEM_QUADFIRE));
    self.client.v_angle[1] -= spread;
    drop.spawnflags = SpawnFlags_or(drop.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
    drop.spawnflags = SpawnFlags_and(drop.spawnflags, SpawnFlags_not(SPAWNFLAG_ITEM_DROPPED));
    drop.svflags &= ~SvflagsT.SVF_INSTANCED;

    drop.touch = Touch_Item;
    drop.nextthink = self.client.quadfire_time;
    drop.think = G_FreeEdict;
  }
}

// ---------------------------------------------------------------------------
// LookAtKiller (p_client.cpp:501-527)
// ---------------------------------------------------------------------------

export function LookAtKiller(self: EdictT, inflictor: EdictT, attacker: EdictT): void {
  if (self.client === null) throw new Error("LookAtKiller: self.client is null (invariant violated)");
  const world = g_edicts[0];
  let dir: Vec3;

  if (attacker !== undefined && attacker !== world && attacker !== self) {
    dir = vec3_sub(attacker.s.origin, self.s.origin);
  } else if (inflictor !== undefined && inflictor !== world && inflictor !== self) {
    dir = vec3_sub(inflictor.s.origin, self.s.origin);
  } else {
    self.client.killer_yaw = self.s.angles[1]; // YAW
    return;
  }

  // PMM - fixed to correct for pitch of 0
  if (dir[0] !== 0) self.client.killer_yaw = (180 / Math.PI) * Math.atan2(dir[1], dir[0]);
  else if (dir[1] > 0) self.client.killer_yaw = 90;
  else if (dir[1] < 0) self.client.killer_yaw = 270;
  else self.client.killer_yaw = 0;
}

// ---------------------------------------------------------------------------
// player_die (p_client.cpp:534-755)
// ---------------------------------------------------------------------------

const DEATH_SOUNDS = ["*death1.wav", "*death2.wav", "*death3.wav", "*death4.wav"] as const;

export const player_die: DieFn = RegisterDie("player_die", (self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
  if (self.client === null) throw new Error("player_die: self.client is null (invariant violated -- only players use this DIE handler)");
  const client = self.client;

  PlayerTrail_Destroy(self);

  self.avelocity = vec3();

  self.takedamage = true;
  self.movetype = MovetypeT.MOVETYPE_TOSS;

  self.s.modelindex2 = 0; // remove linked weapon model
  self.s.modelindex3 = 0; // remove linked ctf flag

  self.s.angles[0] = 0;
  self.s.angles[2] = 0;

  self.s.sound = 0;
  client.weapon_sound = 0;

  self.maxs[2] = -8;

  self.svflags |= SvflagsT.SVF_DEADMONSTER;

  if (!self.deadflag) {
    client.respawn_time = Gtime_add(level.time, Gtime_from_sec(1));
    if (deathmatchEnabled() && cvarBool("g_dm_force_respawn_time", "0")) {
      client.respawn_time = Gtime_add(level.time, Gtime_from_sec(cvarFloat("g_dm_force_respawn_time", "0")));
    }

    LookAtKiller(self, inflictor, attacker);
    client.ps.pmove.pm_type = KexPmTypeT.PM_DEAD;
    ClientObituary(self, inflictor, attacker, mod);

    CTFFragBonuses(self, inflictor, attacker);
    TossClientWeapon(self);
    CTFPlayerResetGrapple(self);
    CTFDeadDropFlag(self);
    CTFDeadDropTech(self);

    if (deathmatchEnabled() && !client.showscores) Cmd_Help_f(self); // show scores

    if (coopEnabled() && !P_UseCoopInstancedItems()) {
      // clear inventory -- this is kind of ugly, but it's how we want to
      // handle keys in coop
      for (let n = 0; n < ItemIdT.IT_TOTAL; n++) {
        // itemlist[n].flags & IF_KEY -- unported (g_items.ts); the key-carry
        // preservation into coop_respawn.inventory is dropped per PORTING.md
        // ("a function you cannot port faithfully is a reported deviation,
        // not a TODO") -- keys are simply cleared along with everything else
        // until g_items.ts lands and this can resolve item.flags for real.
        client.pers.inventory[n] = 0;
      }
    }
  }

  // ROGUE: DMGame.PlayerDeath -- always null in this port line (see file header).
  void cvarBool("gamerules", "0");

  // remove powerups
  client.quad_time = GTIME_ZERO;
  client.invincible_time = GTIME_ZERO;
  client.breather_time = GTIME_ZERO;
  client.enviro_time = GTIME_ZERO;
  client.invisible_time = GTIME_ZERO;
  self.flags &= ~EntFlagsT.FL_POWER_ARMOR;

  // clear inventory
  if (G_TeamplayEnabled()) client.pers.inventory.fill(0);

  client.quadfire_time = GTIME_ZERO;

  // ROGUE stuff
  client.double_time = GTIME_ZERO;

  // if there's a sphere around, let it know the player died.
  if (client.owned_sphere !== null) {
    const sphere = client.owned_sphere;
    if (sphere.die !== null) sphere.die(sphere, self, self, 0, vec3(), mod);
  }

  // if we've been killed by the tracker, GIB!
  if (mod.id === ModIdT.MOD_TRACKER) {
    self.health = -100;
    damage = 400;
  }

  // make sure no trackers are still hurting us.
  if (Gtime_nonzero(client.tracker_pain_time)) {
    RemoveAttackingPainDaemons(self);
  }

  // if we got obliterated by the nuke, don't gib
  if (self.health < -80 && mod.id === ModIdT.MOD_NUKE) self.flags |= EntFlagsT.FL_NOGIB;

  if (self.health < -40) {
    // don't toss gibs if we got vaped by the nuke
    if ((self.flags & EntFlagsT.FL_NOGIB) === 0n) {
      gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

      if (deathmatchEnabled() && self.health < -80) {
        ThrowGibs(self, damage, [{ count: 4, gibname: "models/objects/gibs/sm_meat/tris.md2", scale: 1.0, type: 0 }]);
      }

      ThrowGibs(self, damage, [{ count: 4, gibname: "models/objects/gibs/sm_meat/tris.md2", scale: 1.0, type: 0 }]);
    }
    self.flags &= ~EntFlagsT.FL_NOGIB;

    ThrowClientHead(self, damage);
    client.anim_priority = AnimPriorityT.ANIM_DEATH;
    client.anim_end = 0;
    self.takedamage = false;
  } else {
    // normal death
    if (!self.deadflag) {
      // start a death animation
      client.anim_priority = AnimPriorityT.ANIM_DEATH;
      if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
        self.s.frame = FRAME_crdeath1 - 1;
        client.anim_end = FRAME_crdeath5;
      } else {
        switch (irandom(3)) {
          case 0:
            self.s.frame = FRAME_death101 - 1;
            client.anim_end = FRAME_death106;
            break;
          case 1:
            self.s.frame = FRAME_death201 - 1;
            client.anim_end = FRAME_death206;
            break;
          case 2:
            self.s.frame = FRAME_death301 - 1;
            client.anim_end = FRAME_death308;
            break;
        }
      }

      gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex(random_element(DEATH_SOUNDS)), 1, ATTN_NORM, 0);
      client.anim_time = GTIME_ZERO;
    }
  }

  if (!self.deadflag) {
    if (coopEnabled() && (cvarBool("g_coop_squad_respawn", "1") || cvarBool("g_coop_enable_lives", "0"))) {
      if (cvarBool("g_coop_enable_lives", "0") && client.pers.lives > 0) {
        client.pers.lives--;
        client.resp.coop_respawn.lives--;
      }

      let allPlayersDead = true;
      for (const player of active_players()) {
        if (player.health > 0 || (!level.deadly_kill_box && cvarBool("g_coop_enable_lives", "0") && player.client !== null && player.client.pers.lives > 0)) {
          allPlayersDead = false;
          break;
        }
      }

      if (allPlayersDead) {
        // allow respawns for telefrags and weird shit
        level.coop_level_restart_time = Gtime_add(level.time, Gtime_from_sec(5));

        for (const player of active_players()) giLocCenterPrint(player, "$g_coop_lose");
      }

      // in 3 seconds, attempt a respawn or put us into spectator mode
      if (!Gtime_nonzero(level.coop_level_restart_time)) client.respawn_time = Gtime_add(level.time, Gtime_from_sec(3));
    }
  }

  self.deadflag = true;

  gi.linkentity(self);
});

// ---------------------------------------------------------------------------
// Player_GiveStartItems (p_client.cpp:763-797)
// ---------------------------------------------------------------------------

/** COM_ParseEx(&ptr, ";")-driven tokenizer, ported as a plain split (the
 * source's own delimiter set is exactly ";" here, and none of the resulting
 * tokens embed quoted semicolons in any real g_start_items/level.start_items
 * value this port line's fixtures use). */
function Player_GiveStartItems(ent: EdictT, ptr: string): void {
  const tokens = ptr
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    const spaceIdx = token.indexOf(" ");
    const itemName = spaceIdx === -1 ? token : token.slice(0, spaceIdx);
    const countStr = spaceIdx === -1 ? "" : token.slice(spaceIdx + 1).trim();

    const item = FindItemByClassname(itemName);
    if (item === null || item.pickup === null) {
      gi.Com_Error(`Invalid g_start_item entry: ${itemName}\n`);
    }

    const count = countStr.length > 0 ? parseInt(countStr, 10) : 1;

    if (ent.client === null) throw new Error("Player_GiveStartItems: ent.client is null (invariant violated)");

    if (count === 0) {
      ent.client.pers.inventory[item.id] = 0;
      continue;
    }

    const dummy = G_Spawn();
    dummy.item = item;
    dummy.count = count;
    dummy.spawnflags = SpawnFlags_or(dummy.spawnflags, SPAWNFLAG_ITEM_DROPPED);
    if (item.pickup !== null) item.pickup(dummy, ent);
    G_FreeEdict(dummy);
  }
}

// ---------------------------------------------------------------------------
// InitClientPersistant (p_client.cpp:807-909)
// ---------------------------------------------------------------------------

export function InitClientPersistant(ent: EdictT, client: GClientT): void {
  // backup & restore userinfo
  const userinfo = client.pers.userinfo;

  client.pers = defaultClientPersistant();
  ClientUserinfoChanged(ent, userinfo);

  client.pers.health = 100;
  client.pers.max_health = 100;

  // don't give us weapons if we shouldn't have any
  if ((G_TeamplayEnabled() && client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) || (!G_TeamplayEnabled() && !client.resp.spectator)) {
    // in coop, if there's already a player in the game and we're new,
    // steal their loadout. this would fix a potential softlock where a new
    // player may not have weapons at all.
    let taken_loadout = false;

    if (coopEnabled()) {
      for (const player of active_players()) {
        if (
          player === ent ||
          player.client === null ||
          !player.client.pers.spawned ||
          player.client.resp.spectator ||
          player.movetype === MovetypeT.MOVETYPE_NOCLIP
        )
          continue;

        client.pers.inventory = Int32Array.from(player.client.pers.inventory);
        client.pers.max_ammo = Int16Array.from(player.client.pers.max_ammo);
        client.pers.power_cubes = player.client.pers.power_cubes;
        taken_loadout = true;
        break;
      }
    }

    if (!taken_loadout) {
      // fill with 50s, since it's our most common value
      client.pers.max_ammo.fill(50);
      client.pers.max_ammo[AmmoT.AMMO_BULLETS] = 200;
      client.pers.max_ammo[AmmoT.AMMO_SHELLS] = 100;
      client.pers.max_ammo[AmmoT.AMMO_CELLS] = 200;

      client.pers.max_ammo[AmmoT.AMMO_TRAP] = 5;
      client.pers.max_ammo[AmmoT.AMMO_FLECHETTES] = 200;
      client.pers.max_ammo[AmmoT.AMMO_DISRUPTOR] = 12;
      client.pers.max_ammo[AmmoT.AMMO_TESLA] = 5;

      if (!deathmatchEnabled() || !cvarBool("g_instagib", "0")) client.pers.inventory[ItemIdT.IT_WEAPON_BLASTER] = 1;

      // [Kex] start items!
      const startItems = cvarString("g_start_items", "");
      if (startItems.length > 0) {
        Player_GiveStartItems(ent, startItems);
      } else if (deathmatchEnabled() && cvarBool("g_instagib", "0")) {
        client.pers.inventory[ItemIdT.IT_WEAPON_RAILGUN] = 1;
        client.pers.inventory[ItemIdT.IT_AMMO_SLUGS] = 99;
      }

      if (level.start_items !== null && level.start_items.length > 0) Player_GiveStartItems(ent, level.start_items);

      if (!deathmatchEnabled()) client.pers.inventory[ItemIdT.IT_ITEM_COMPASS] = 1;

      // ZOID
      const allowGrapple = cvarString("g_allow_grapple", "auto");
      const giveGrapple = allowGrapple === "auto" ? (cvarBool("ctf", "0") ? !level.no_grapple : false) : cvarBool("g_allow_grapple", "auto");

      if (giveGrapple) client.pers.inventory[ItemIdT.IT_WEAPON_GRAPPLE] = 1;
    }

    NoAmmoWeaponChange(ent, false);

    client.pers.weapon = client.newweapon;
    if (client.newweapon !== null) client.pers.selected_item = client.newweapon.id;
    client.newweapon = null;
    client.pers.lastweapon = client.pers.weapon;
  }

  if (coopEnabled() && cvarBool("g_coop_enable_lives", "0")) client.pers.lives = cvarInt("g_coop_num_lives", "0") + 1;

  if (client.pers.autoshield >= 0 /* AUTO_SHIELD_AUTO */) ent.flags |= EntFlagsT.FL_WANTS_POWER_ARMOR;

  client.pers.connected = true;
  client.pers.spawned = true;
}

/** Fresh `client_persistant_t` -- mirrors C's `memset(&client->pers, 0, sizeof(client->pers))`.
 * Exported (originally file-local) so g_main.ts's ExitLevel can build the
 * same "wipe players back to default stuff" reset g_main.cpp performs
 * (`game.clients[i].pers = game.clients[i].resp.coop_respawn = {};`)
 * without a second, divergence-prone copy of this shape -- same rationale
 * as `defaultGClient`'s export, see g_main.ts's own header. */
export function defaultClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: HandednessT.RIGHT_HANDED,
    autoswitch: AutoSwitchT.SMART,
    autoshield: 0,
    connected: false,
    spawned: false,
    health: 0,
    max_health: 0,
    savedFlags: 0n,
    selected_item: ItemIdT.IT_NULL,
    selected_item_time: GTIME_ZERO,
    inventory: new Int32Array(ItemIdT.IT_TOTAL),
    max_ammo: new Int16Array(AmmoT.AMMO_MAX),
    weapon: null,
    lastweapon: null,
    power_cubes: 0,
    score: 0,
    game_help1changed: 0,
    game_help2changed: 0,
    helpchanged: 0,
    help_time: GTIME_ZERO,
    spectator: false,
    bob_skip: false,
    wanted_fog: [0, 0, 0, 0, 0],
    wanted_heightfog: {
      start: [0, 0, 0, 0],
      end: [0, 0, 0, 0],
      falloff: 0,
      density: 0,
    },
    fog_transition_time: GTIME_ZERO,
    megahealth_time: GTIME_ZERO,
    lives: 0,
    n64_crouch_warn_times: 0,
    n64_crouch_warning: GTIME_ZERO,
  };
}

// ---------------------------------------------------------------------------
// InitClientResp (p_client.cpp:911-927)
// ---------------------------------------------------------------------------

export function InitClientResp(client: GClientT): void {
  const ctf_team = client.resp.ctf_team;
  const id_state = client.resp.id_state;

  client.resp = defaultClientRespawn();

  client.resp.ctf_team = ctf_team;
  client.resp.id_state = id_state;

  client.resp.entertime = level.time;
  client.resp.coop_respawn = { ...client.pers, inventory: Int32Array.from(client.pers.inventory), max_ammo: Int16Array.from(client.pers.max_ammo) };
}

/** Fresh `client_respawn_t` -- mirrors C's `memset(&client->resp, 0, sizeof(client->resp))`. */
function defaultClientRespawn(): ClientRespawnT {
  return {
    coop_respawn: defaultClientPersistant(),
    entertime: GTIME_ZERO,
    score: 0,
    cmd_angles: vec3(),
    spectator: false,
    ctf_team: CtfteamT.CTF_NOTEAM,
    ctf_state: 0,
    ctf_lasthurtcarrier: GTIME_ZERO,
    ctf_lastreturnedflag: GTIME_ZERO,
    ctf_flagsince: GTIME_ZERO,
    ctf_lastfraggedcarrier: GTIME_ZERO,
    id_state: false,
    lastidtime: GTIME_ZERO,
    voted: false,
    ready: false,
    admin: false,
    ghost: null,
  };
}

/** Fresh `pmove_state_t` -- zeroed defaults. */
function defaultKexPmoveState(): KexPmoveStateT {
  return {
    pm_type: KexPmTypeT.PM_NORMAL,
    origin: vec3(),
    velocity: vec3(),
    pm_flags: 0,
    pm_time: 0,
    gravity: 0,
    delta_angles: vec3(),
    viewheight: 0,
  };
}

/** Fresh `player_state_t` -- zeroed defaults. */
function defaultKexPlayerState(): KexPlayerStateT {
  return {
    pmove: defaultKexPmoveState(),
    viewangles: vec3(),
    viewoffset: vec3(),
    kick_angles: vec3(),
    gunangles: vec3(),
    gunoffset: vec3(),
    gunindex: 0,
    gunskin: 0,
    gunframe: 0,
    gunrate: 0,
    screen_blend: new Float32Array(4),
    damage_blend: new Float32Array(4),
    fov: 90,
    rdflags: RefdefFlagsT.RDF_NONE,
    stats: new Int16Array(MAX_STATS),
    team_id: 0,
  };
}

/** Fresh `gclient_t` -- mirrors C's `memset(client, 0, sizeof(*client))`
 * (PutClientInServer's "clear everything but the persistant data" step).
 * `pers`/`resp` are overwritten by the caller immediately after; defaulted
 * here too so this factory alone always yields a fully-valid `GClientT`.
 * Exported (originally file-local) so g_main.ts's InitGame can populate
 * `game.clients` with real, interface-satisfying objects the same way C's
 * `TagMalloc`'d, zeroed `gclient_t` array does -- no second, divergence-prone
 * copy of this shape. */
export function defaultGClient(): GClientT {
  return {
    ps: defaultKexPlayerState(),
    ping: 0,
    pers: defaultClientPersistant(),
    resp: defaultClientRespawn(),
    old_pmove: defaultKexPmoveState(),
    showscores: false,
    showeou: false,
    showinventory: false,
    showhelp: false,
    buttons: ButtonT.BUTTON_NONE,
    oldbuttons: ButtonT.BUTTON_NONE,
    latched_buttons: ButtonT.BUTTON_NONE,
    cmd: { msec: 0, buttons: ButtonT.BUTTON_NONE, angles: vec3(), forwardmove: 0, sidemove: 0, server_frame: 0 },
    weapon_fire_finished: GTIME_ZERO,
    weapon_think_time: GTIME_ZERO,
    weapon_fire_buffered: false,
    weapon_thunk: false,
    newweapon: null,
    damage_armor: 0,
    damage_parmor: 0,
    damage_blood: 0,
    damage_knockback: 0,
    damage_from: vec3(),
    damage_indicators: [],
    num_damage_indicators: 0,
    killer_yaw: 0,
    weaponstate: WeaponstateT.WEAPON_READY,
    kick: { angles: vec3(), origin: vec3(), time: GTIME_ZERO, total: GTIME_ZERO },
    quake_time: GTIME_ZERO,
    kick_origin: vec3(),
    v_dmg_roll: 0,
    v_dmg_pitch: 0,
    v_dmg_time: GTIME_ZERO,
    fall_time: GTIME_ZERO,
    fall_value: 0,
    damage_alpha: 0,
    bonus_alpha: 0,
    damage_blend: vec3(),
    v_angle: vec3(),
    v_forward: vec3(),
    bobtime: 0,
    oldviewangles: vec3(),
    oldvelocity: vec3(),
    oldgroundentity: null,
    flash_time: GTIME_ZERO,
    next_drown_time: GTIME_ZERO,
    old_waterlevel: WaterLevelT.WATER_NONE,
    breather_sound: 0,
    machinegun_shots: 0,
    anim_end: 0,
    anim_priority: AnimPriorityT.ANIM_BASIC,
    anim_duck: false,
    anim_run: false,
    anim_time: GTIME_ZERO,
    quad_time: GTIME_ZERO,
    invincible_time: GTIME_ZERO,
    breather_time: GTIME_ZERO,
    enviro_time: GTIME_ZERO,
    invisible_time: GTIME_ZERO,
    grenade_blew_up: false,
    grenade_time: GTIME_ZERO,
    grenade_finished_time: GTIME_ZERO,
    quadfire_time: GTIME_ZERO,
    silencer_shots: 0,
    weapon_sound: 0,
    pickup_msg_time: GTIME_ZERO,
    flood_locktill: GTIME_ZERO,
    flood_when: new Array<GTime>(10).fill(GTIME_ZERO),
    flood_whenhead: 0,
    respawn_time: GTIME_ZERO,
    chase_target: null,
    update_chase: false,
    double_time: GTIME_ZERO,
    ir_time: GTIME_ZERO,
    nuke_time: GTIME_ZERO,
    tracker_pain_time: GTIME_ZERO,
    owned_sphere: null,
    empty_click_sound: GTIME_ZERO,
    inmenu: false,
    menu: null,
    menutime: GTIME_ZERO,
    menudirty: false,
    ctf_grapple: null,
    ctf_grapplestate: 0,
    ctf_grapplereleasetime: GTIME_ZERO,
    ctf_regentime: GTIME_ZERO,
    ctf_techsndtime: GTIME_ZERO,
    ctf_lasttechmsg: GTIME_ZERO,
    trail_head: null,
    trail_tail: null,
    no_weapon_chains: false,
    landmark_free_fall: false,
    landmark_name: null,
    landmark_rel_pos: vec3(),
    landmark_noise_time: GTIME_ZERO,
    invisibility_fade_time: GTIME_ZERO,
    chase_msg_time: GTIME_ZERO,
    menu_sign: 0,
    last_ladder_pos: vec3(),
    last_ladder_sound: GTIME_ZERO,
    coop_respawn_state: 0,
    last_damage_time: GTIME_ZERO,
    sight_entity: null,
    sight_entity_time: GTIME_ZERO,
    sound_entity: null,
    sound_entity_time: GTIME_ZERO,
    sound2_entity: null,
    sound2_entity_time: GTIME_ZERO,
    num_lag_origins: 0,
    next_lag_origin: 0,
    is_lag_compensated: false,
    lag_restore_origin: vec3(),
    slow_view_angles: vec3(),
    slow_view_angle_time: GTIME_ZERO,
    help_draw_points: false,
    help_draw_index: 0,
    help_draw_count: 0,
    help_draw_time: GTIME_ZERO,
    step_frame: 0,
    help_poi_image: 0,
    help_poi_location: vec3(),
    awaiting_respawn: false,
    respawn_timeout: GTIME_ZERO,
    fog: [0, 0, 0, 0, 0],
    heightfog: { start: [0, 0, 0, 0], end: [0, 0, 0, 0], falloff: 0, density: 0 },
    last_attacker_time: GTIME_ZERO,
    last_firing_time: GTIME_ZERO,
  };
}

// ---------------------------------------------------------------------------
// SaveClientData / FetchClientEntData (p_client.cpp:939-963)
// ---------------------------------------------------------------------------

export function SaveClientData(): void {
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse || ent.client === null) continue;
    game.clients[i].pers.health = ent.health;
    game.clients[i].pers.max_health = ent.max_health;
    game.clients[i].pers.savedFlags =
      ent.flags & (EntFlagsT.FL_FLASHLIGHT | EntFlagsT.FL_GODMODE | EntFlagsT.FL_NOTARGET | EntFlagsT.FL_POWER_ARMOR | EntFlagsT.FL_WANTS_POWER_ARMOR);
    if (coopEnabled()) game.clients[i].pers.score = ent.client.resp.score;
  }
}

export function FetchClientEntData(ent: EdictT): void {
  if (ent.client === null) throw new Error("FetchClientEntData: ent.client is null (invariant violated)");
  ent.health = ent.client.pers.health;
  ent.max_health = ent.client.pers.max_health;
  ent.flags |= ent.client.pers.savedFlags;
  if (coopEnabled()) ent.client.resp.score = ent.client.pers.score;
}

// ---------------------------------------------------------------------------
// SelectSpawnPoint family (p_client.cpp:980-1514)
// ---------------------------------------------------------------------------

/** p_client.cpp:980-1007: `float PlayersRangeFromSpot(edict_t *spot)`. */
export function PlayersRangeFromSpot(spot: EdictT): number {
  let bestplayerdistance = 9999999;

  for (let n = 1; n <= game.maxclients; n++) {
    const player = g_edicts[n];
    if (player === undefined || !player.inuse) continue;
    if (player.health <= 0) continue;

    const v = vec3_sub(spot.s.origin, player.s.origin);
    const playerdistance = vec3_length(v);

    if (playerdistance < bestplayerdistance) bestplayerdistance = playerdistance;
  }

  return bestplayerdistance;
}

/** p_client.cpp:1009-1013: `bool SpawnPointClear(edict_t *spot)`. */
export function SpawnPointClear(spot: EdictT): boolean {
  const p = vec3_add(spot.s.origin, vec3(0, 0, 9));
  return !gi.trace(p, PLAYER_MINS, PLAYER_MAXS, p, spot, ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_MONSTER).startsolid;
}

interface SpawnPointCandidate {
  point: EdictT;
  dist: number;
}

/** p_client.cpp:1015-1112: `select_spawn_result_t SelectDeathmatchSpawnPoint(...)`. */
export function SelectDeathmatchSpawnPoint(farthest: boolean, force_spawn: boolean, fallback_to_ctf_or_start: boolean): { spot: EdictT | null; any_valid: boolean } {
  let spawn_points: SpawnPointCandidate[] = [];

  // gather all spawn points
  let spot: EdictT | null = null;
  while ((spot = G_FindByString(spot, "classname", "info_player_deathmatch")) !== null) {
    spawn_points.push({ point: spot, dist: PlayersRangeFromSpot(spot) });
  }

  // no points
  if (spawn_points.length === 0) {
    if (fallback_to_ctf_or_start) {
      spot = null;
      while ((spot = G_FindByString(spot, "classname", "info_player_team1")) !== null) spawn_points.push({ point: spot, dist: PlayersRangeFromSpot(spot) });
      spot = null;
      while ((spot = G_FindByString(spot, "classname", "info_player_team2")) !== null) spawn_points.push({ point: spot, dist: PlayersRangeFromSpot(spot) });

      if (spawn_points.length === 0) {
        spot = G_FindByString(null, "classname", "info_player_start");
        if (spot !== null) spawn_points.push({ point: spot, dist: PlayersRangeFromSpot(spot) });

        if (spawn_points.length === 0) return { spot: null, any_valid: false };
      }
    } else {
      return { spot: null, any_valid: false };
    }
  }

  // if there's only one spawn point, that's the one.
  if (spawn_points.length === 1) {
    if (force_spawn || SpawnPointClear(spawn_points[0]!.point)) return { spot: spawn_points[0]!.point, any_valid: true };
    return { spot: null, any_valid: true };
  }

  // order by distances ascending (top of list has closest players to point)
  spawn_points = [...spawn_points].sort((a, b) => a.dist - b.dist);

  if (farthest) {
    for (let i = spawn_points.length - 1; i >= 0; --i) {
      if (SpawnPointClear(spawn_points[i]!.point)) return { spot: spawn_points[i]!.point, any_valid: true };
    }
    // none clear
  } else {
    // for random, select a random point other than the two that are
    // closest to the player if possible.
    const head = spawn_points.slice(0, 2);
    const tail = shuffled(spawn_points.slice(2));

    for (const candidate of tail) {
      if (SpawnPointClear(candidate.point)) return { spot: candidate.point, any_valid: true };
    }

    // none clear, so we have to pick one of the other two
    if (head.length > 1 && SpawnPointClear(head[1]!.point)) return { spot: head[1]!.point, any_valid: true };
    else if (head.length > 0 && SpawnPointClear(head[0]!.point)) return { spot: head[0]!.point, any_valid: true };
  }

  if (force_spawn) return { spot: random_element(spawn_points).point, any_valid: true };

  return { spot: null, any_valid: true };
}

/** Fisher-Yates shuffle (`std::shuffle(..., mt_rand)`); this port line has no
 * seeded-RNG requirement for deathmatch spawn selection (PORTING.md:
 * "determinism across runs is not a goal"), so `Math.random()` stands in for
 * `mt_rand` via `q_std.ts`'s own `frandom`-backed helpers. */
function shuffled<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = irandom(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

const SPAWNFLAG_WATER_SMART = 0x0002; // func_water spawnflag (g_local.h), not yet ported anywhere else

/** p_client.cpp:1116-1194 (ROGUE): `edict_t *SelectLavaCoopSpawnPoint(edict_t *ent)`. */
export function SelectLavaCoopSpawnPoint(_ent: EdictT): EdictT | null {
  let lavatop = -99999;
  let highestlava: EdictT | null = null;

  let lava: EdictT | null = null;
  for (;;) {
    lava = G_FindByString(lava, "classname", "func_water");
    if (lava === null) break;

    const center = vec3_add(lava.absmax, lava.absmin);
    center[0] *= 0.5;
    center[1] *= 0.5;
    center[2] *= 0.5;

    if (SpawnFlags_has(lava.spawnflags, SpawnFlags_from(SPAWNFLAG_WATER_SMART)) && (gi.pointcontents(center) & MASK_WATER) !== 0) {
      if (lava.absmax[2] > lavatop) {
        lavatop = lava.absmax[2];
        highestlava = lava;
      }
    }
  }

  if (highestlava === null) return null;

  lavatop = highestlava.absmax[2] + 64;

  const spawnPoints: EdictT[] = [];
  let spot: EdictT | null = null;
  while ((spot = G_FindByString(spot, "classname", "info_player_coop_lava")) !== null) {
    if (spawnPoints.length === 64) break;
    spawnPoints.push(spot);
  }

  let lowest = 999999;
  let pointWithLeastLava: EdictT | null = null;
  for (const candidate of spawnPoints) {
    if (candidate.s.origin[2] < lavatop) continue;

    if (PlayersRangeFromSpot(candidate) > 32) {
      if (candidate.s.origin[2] < lowest) {
        pointWithLeastLava = candidate;
        lowest = candidate.s.origin[2];
      }
    }
  }

  return pointWithLeastLava;
}

/** p_client.cpp:1199-1228: `static edict_t *SelectSingleSpawnPoint(edict_t *ent)`. */
function SelectSingleSpawnPoint(_ent: EdictT | null): EdictT | null {
  let spot: EdictT | null = null;

  while ((spot = G_FindByString(spot, "classname", "info_player_start")) !== null) {
    if (game.spawnpoint.length === 0 && spot.targetname === null) break;
    if (game.spawnpoint.length === 0 || spot.targetname === null) continue;
    if (game.spawnpoint.toLowerCase() === spot.targetname.toLowerCase()) break;
  }

  if (spot === null) {
    // there wasn't a matching targeted spawnpoint, use one that has no targetname
    spot = null;
    while ((spot = G_FindByString(spot, "classname", "info_player_start")) !== null) {
      if (spot.targetname === null) return spot;
    }
  }

  // none at all, so just pick any
  if (spot === null) return G_FindByString(null, "classname", "info_player_start");

  return spot;
}

/** `traceEdict` -- recovers the full `EdictT` from a trace's server-visible
 * `KexEdictT` via `g_edicts[ent.s.number]` (`EDICT_NUM`), never a cast.
 * Duplicated per-file per this port line's established convention -- see
 * g_monster.ts/g_phys.ts/g_target.ts/g_trigger.ts/g_weapon.ts's identical
 * copies. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0]!;
  return g_edicts[ent.s.number]!;
}

/** p_client.cpp:1231-1268: `static edict_t *G_UnsafeSpawnPosition(vec3_t spot, bool check_players)`. */
function G_UnsafeSpawnPosition(spot: Vec3, check_players: boolean): EdictT | null {
  let mask = MASK_PLAYERSOLID;
  if (!check_players) mask &= ~ContentsT.CONTENTS_PLAYER;

  let tr = gi.trace(spot, PLAYER_MINS, PLAYER_MAXS, spot, null, mask);

  // sometimes the spot is too close to the ground, give it a bit of slack
  if (tr.startsolid && (tr.ent === null || traceEdict(tr.ent).client === null)) {
    spot = vec3(spot[0], spot[1], spot[2] + 1);
    tr = gi.trace(spot, PLAYER_MINS, PLAYER_MAXS, spot, null, mask);
  }

  // no idea why this happens in some maps..
  if (tr.startsolid && (tr.ent === null || traceEdict(tr.ent).client === null)) {
    if (G_FixStuckObject_Generic(spot, PLAYER_MINS, PLAYER_MAXS, (start, mins, maxs, end) => gi.trace(start, mins, maxs, end, null, mask)) === StuckResultT.NO_GOOD_POSITION) {
      return tr.ent === null ? null : traceEdict(tr.ent); // what do we do here...?
    }

    tr = gi.trace(spot, PLAYER_MINS, PLAYER_MAXS, spot, null, mask);
    if (tr.startsolid && (tr.ent === null || traceEdict(tr.ent).client === null)) return tr.ent === null ? null : traceEdict(tr.ent);
  }

  if (tr.fraction === 1) return null;
  else if (check_players && tr.ent !== null && traceEdict(tr.ent).client !== null) return traceEdict(tr.ent);

  return null;
}

/** p_client.cpp:1270-1372: `edict_t *SelectCoopSpawnPoint(edict_t *ent, bool force_spawn, bool check_players)`. */
export function SelectCoopSpawnPoint(ent: EdictT, force_spawn: boolean, check_players: boolean): EdictT | null {
  // ROGUE: rogue hack, but not too gross...
  if (level.mapname.toLowerCase() === "rmine2") return SelectLavaCoopSpawnPoint(ent);

  // try the main spawn point first
  let spot = SelectSingleSpawnPoint(ent);

  if (spot !== null && G_UnsafeSpawnPosition(spot.s.origin, check_players) === null) return spot;

  spot = null;

  // assume there are four coop spots at each spawnpoint
  let num_valid_spots = 0;

  for (;;) {
    spot = G_FindByString(spot, "classname", "info_player_coop");
    if (spot === null) break;

    const target = spot.targetname ?? "";
    if (game.spawnpoint.toLowerCase() === target.toLowerCase()) {
      num_valid_spots++;
      if (G_UnsafeSpawnPosition(spot.s.origin, check_players) === null) return spot;
    }
  }

  let use_targetname = true;

  // if we didn't find any spots, map is probably set up wrong. use empty
  // targetname ones.
  if (num_valid_spots === 0) {
    use_targetname = false;

    for (;;) {
      spot = G_FindByString(spot, "classname", "info_player_coop");
      if (spot === null) break;

      if (spot.targetname === null) {
        num_valid_spots++;
        if (G_UnsafeSpawnPosition(spot.s.origin, check_players) === null) return spot;
      }
    }
  }

  // if player collision is disabled, just pick a random spot
  if (!cvarBool("g_coop_player_collision", "0")) {
    spot = null;
    let remaining = irandom(num_valid_spots);

    for (;;) {
      spot = G_FindByString(spot, "classname", "info_player_coop");
      if (spot === null) break;

      let target = spot.targetname;
      if (use_targetname && target === null) target = "";

      const matches = use_targetname ? game.spawnpoint.toLowerCase() === (target ?? "").toLowerCase() : target === null;

      if (matches) {
        if (remaining === 0) return spot;
        remaining--;
      }
    }
    // if this fails, just fall through to some other spawn.
  }

  // no safe spots..?
  if (force_spawn || !cvarBool("g_coop_player_collision", "0")) return SelectSingleSpawnPoint(spot);

  return null;
}

/** p_client.cpp:1374-1426: `bool TryLandmarkSpawn(edict_t* ent, vec3_t& origin, vec3_t& angles)`. */
export function TryLandmarkSpawn(ent: EdictT, originBox: [Vec3], anglesBox: [Vec3]): boolean {
  if (ent.client === null) throw new Error("TryLandmarkSpawn: ent.client is null (invariant violated)");

  if (ent.client.landmark_name === null || ent.client.landmark_name.length === 0) return false;

  const landmark = G_PickTarget(ent.client.landmark_name);
  if (landmark === null) return false;

  const old_origin = vec3(originBox[0][0], originBox[0][1], originBox[0][2]);
  const spot_origin = vec3(originBox[0][0], originBox[0][1], originBox[0][2]);

  let origin = vec3(ent.client.landmark_rel_pos[0], ent.client.landmark_rel_pos[1], ent.client.landmark_rel_pos[2]);

  // rotate our relative landmark into our new landmark's frame of reference
  origin = RotatePointAroundVector(vec3(1, 0, 0), origin, landmark.s.angles[0]);
  origin = RotatePointAroundVector(vec3(0, 1, 0), origin, landmark.s.angles[2]);
  origin = RotatePointAroundVector(vec3(0, 0, 1), origin, landmark.s.angles[1]);

  origin = vec3_add(origin, landmark.s.origin);

  let angles = vec3_add(ent.client.oldviewangles, landmark.s.angles);

  if (SpawnFlags_has(landmark.spawnflags, SpawnFlags_from(0x1000))) {
    // SPAWNFLAG_LANDMARK_KEEP_Z -- not yet ported as a named constant
    // anywhere in this port line (grepped: zero matches); the numeric
    // literal matches g_local.h's own bit position for this one-off flag.
    origin[2] = spot_origin[2];
  }

  // sometimes, landmark spawns can cause slight inconsistencies in
  // collision; we'll do a bit of tracing to make sure the bbox is clear
  if (
    G_FixStuckObject_Generic(origin, PLAYER_MINS, PLAYER_MAXS, (start, mins, maxs, end) => gi.trace(start, mins, maxs, end, ent, MASK_PLAYERSOLID & ~ContentsT.CONTENTS_PLAYER)) ===
    StuckResultT.NO_GOOD_POSITION
  ) {
    originBox[0] = old_origin;
    return false;
  }

  ent.s.origin = origin;

  // rotate the velocity that we grabbed from the map
  if (ent.velocity[0] !== 0 || ent.velocity[1] !== 0 || ent.velocity[2] !== 0) {
    let vel = RotatePointAroundVector(vec3(1, 0, 0), ent.velocity, landmark.s.angles[0]);
    vel = RotatePointAroundVector(vec3(0, 1, 0), vel, landmark.s.angles[2]);
    vel = RotatePointAroundVector(vec3(0, 0, 1), vel, landmark.s.angles[1]);
    ent.velocity = vel;
  }

  originBox[0] = origin;
  anglesBox[0] = angles;
  return true;
}

/** p_client.cpp:1435-1514: `bool SelectSpawnPoint(edict_t *ent, vec3_t &origin, vec3_t &angles, bool force_spawn, bool &landmark)`. */
export function SelectSpawnPoint(ent: EdictT, originBox: [Vec3], anglesBox: [Vec3], force_spawn: boolean, landmarkBox: [boolean]): boolean {
  let spot: EdictT | null = null;

  // DM spots are simple
  if (deathmatchEnabled()) {
    if (G_TeamplayEnabled()) {
      spot = SelectCTFSpawnPoint(ent, force_spawn);
    } else {
      const result = SelectDeathmatchSpawnPoint(cvarBool("g_dm_spawn_farthest", "1"), force_spawn, true);
      if (!result.any_valid) gi.Com_Error("no valid spawn points found");
      spot = result.spot;
    }

    if (spot !== null) {
      originBox[0] = vec3_add(spot.s.origin, vec3(0, 0, 9));
      anglesBox[0] = vec3(spot.s.angles[0], spot.s.angles[1], spot.s.angles[2]);
      return true;
    }

    return false;
  }

  if (coopEnabled()) {
    spot = SelectCoopSpawnPoint(ent, force_spawn, true);
    if (spot === null) spot = SelectCoopSpawnPoint(ent, force_spawn, false);

    if (spot === null) {
      // in worst case scenario in coop during intermission, just spawn us
      // at intermission spot. this only happens for a single frame, and
      // won't break anything if they come back.
      if (Gtime_nonzero(level.intermissiontime)) {
        originBox[0] = vec3(level.intermission_origin[0], level.intermission_origin[1], level.intermission_origin[2]);
        anglesBox[0] = vec3(level.intermission_angle[0], level.intermission_angle[1], level.intermission_angle[2]);
        return true;
      }
      return false;
    }
  } else {
    spot = SelectSingleSpawnPoint(ent);

    // in SP, just put us at the origin if spawn fails
    if (spot === null) {
      gi.Com_Print(`Couldn't find spawn point ${game.spawnpoint}\n`);
      originBox[0] = vec3(0, 0, 0);
      anglesBox[0] = vec3(0, 0, 0);
      return true;
    }
  }

  // spot should always be non-null here
  originBox[0] = vec3(spot.s.origin[0], spot.s.origin[1], spot.s.origin[2]);
  anglesBox[0] = vec3(spot.s.angles[0], spot.s.angles[1], spot.s.angles[2]);

  // check landmark
  if (TryLandmarkSpawn(ent, originBox, anglesBox)) landmarkBox[0] = true;

  return true;
}

// ---------------------------------------------------------------------------
// Body queue (p_client.cpp:1518-1604)
// ---------------------------------------------------------------------------

export function InitBodyQue(): void {
  level.body_que = 0;
  for (let i = 0; i < BODY_QUEUE_SIZE; i++) {
    const ent = G_Spawn();
    ent.classname = "bodyque";
  }
}

export const body_die: DieFn = RegisterDie("body_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
  if (self.s.modelindex === MODELINDEX_PLAYER && self.health < self.gib_health) {
    gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    ThrowGibs(self, damage, [{ count: 4, gibname: "models/objects/gibs/sm_meat/tris.md2", scale: 1.0, type: 0 }]);
    self.s.origin[2] -= 48;
    ThrowClientHead(self, damage);
  }

  if (mod.id === ModIdT.MOD_CRUSH) {
    // prevent explosion singularities
    self.svflags = SvflagsT.SVF_NOCLIENT;
    self.takedamage = false;
    self.solid = SolidT.SOLID_NOT;
    self.movetype = MovetypeT.MOVETYPE_NOCLIP;
    gi.linkentity(self);
  }
});

/** `body->s = ent->s` struct-value copy -- see file header. */
function copyEntityState(dst: KexEntityStateT, src: KexEntityStateT): void {
  dst.number = src.number;
  dst.origin = vec3(src.origin[0], src.origin[1], src.origin[2]);
  dst.angles = vec3(src.angles[0], src.angles[1], src.angles[2]);
  dst.old_origin = vec3(src.old_origin[0], src.old_origin[1], src.old_origin[2]);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
  dst.alpha = src.alpha;
  dst.scale = src.scale;
  dst.instance_bits = src.instance_bits;
  dst.loop_volume = src.loop_volume;
  dst.loop_attenuation = src.loop_attenuation;
  dst.owner = src.owner;
  dst.old_frame = src.old_frame;
}

export function CopyToBodyQue(ent: EdictT): void {
  // if we were completely removed, don't bother with a body
  if (ent.s.modelindex === 0) return;

  // grab a body que and cycle to the next one
  const body = g_edicts[game.maxclients + level.body_que + 1];
  if (body === undefined) throw new Error("CopyToBodyQue: body queue slot missing (invariant violated -- InitBodyQue must run first)");
  level.body_que = (level.body_que + 1) % BODY_QUEUE_SIZE;

  gi.unlinkentity(ent);
  gi.unlinkentity(body);

  copyEntityState(body.s, ent.s);
  body.s.number = g_edicts.indexOf(body);
  body.s.skinnum = ent.s.skinnum & 0xff; // only copy the client #
  body.s.effects = EffectsT.EF_NONE;
  body.s.renderfx = RenderfxT.RF_NONE;

  body.svflags = ent.svflags;
  body.absmin = vec3(ent.absmin[0], ent.absmin[1], ent.absmin[2]);
  body.absmax = vec3(ent.absmax[0], ent.absmax[1], ent.absmax[2]);
  body.size = vec3(ent.size[0], ent.size[1], ent.size[2]);
  body.solid = ent.solid;
  body.clipmask = ent.clipmask;
  body.owner = ent.owner;
  body.movetype = ent.movetype;
  body.health = ent.health;
  body.gib_health = ent.gib_health;
  body.s.event = 5; // EV_OTHER_TELEPORT
  body.velocity = vec3(ent.velocity[0], ent.velocity[1], ent.velocity[2]);
  body.avelocity = vec3(ent.avelocity[0], ent.avelocity[1], ent.avelocity[2]);
  body.groundentity = ent.groundentity;
  body.groundentity_linkcount = ent.groundentity_linkcount;

  if (ent.takedamage) {
    body.mins = vec3(ent.mins[0], ent.mins[1], ent.mins[2]);
    body.maxs = vec3(ent.maxs[0], ent.maxs[1], ent.maxs[2]);
  } else {
    body.mins = vec3();
    body.maxs = vec3();
  }

  body.die = body_die;
  body.takedamage = true;

  gi.linkentity(body);
}

/** p_client.cpp:1606-1619: `void G_PostRespawn(edict_t *self)`. */
export function G_PostRespawn(self: EdictT): void {
  if (self.client === null) throw new Error("G_PostRespawn: self.client is null (invariant violated)");
  if ((self.svflags & SvflagsT.SVF_NOCLIENT) !== 0) return;

  // add a teleportation effect
  self.s.event = 4; // EV_PLAYER_TELEPORT

  // hold in place briefly
  self.client.ps.pmove.pm_flags = PmflagsT.PMF_TIME_TELEPORT;
  self.client.ps.pmove.pm_time = 112;

  self.client.respawn_time = level.time;
}

/** p_client.cpp:1621-1637: `void respawn(edict_t *self)`. Real export -- see file header "STUB SWAP". */
export function respawn(self: EdictT): void {
  if (self.client === null) throw new Error("respawn: self.client is null (invariant violated)");

  if (deathmatchEnabled() || coopEnabled()) {
    // spectators don't leave bodies
    if (!self.client.resp.spectator) CopyToBodyQue(self);
    self.svflags &= ~SvflagsT.SVF_NOCLIENT;
    PutClientInServer(self);

    G_PostRespawn(self);
    return;
  }

  // restart the entire server
  gi.AddCommandString("menu_loadgame\n");
}

/** p_client.cpp:1643-1734: `void spectator_respawn(edict_t *ent)`. */
export function spectator_respawn(ent: EdictT): void {
  if (ent.client === null) throw new Error("spectator_respawn: ent.client is null (invariant violated)");
  const client = ent.client;

  if (client.pers.spectator) {
    const box: [string] = [""];
    gi.Info_ValueForKey(client.pers.userinfo, "spectator", box, MAX_INFO_VALUE);
    const value = box[0];

    const specPass = cvarString("spectator_password", "");
    if (specPass.length > 0 && specPass !== "none" && specPass !== value) {
      giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "Spectator password incorrect.\n");
      client.pers.spectator = false;
      gi.WriteByte(ServerCommandT.svc_stufftext);
      gi.WriteString("spectator 0\n");
      gi.unicast(ent, true, 0);
      return;
    }

    // count spectators
    let numspec = 0;
    for (let i = 1; i <= game.maxclients; i++) {
      const e = g_edicts[i];
      if (e !== undefined && e.inuse && e.client !== null && e.client.pers.spectator) numspec++;
    }

    if (numspec >= cvarInt("maxspectators", "8")) {
      giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "Server spectator limit is full.");
      client.pers.spectator = false;
      gi.WriteByte(ServerCommandT.svc_stufftext);
      gi.WriteString("spectator 0\n");
      gi.unicast(ent, true, 0);
      return;
    }
  } else {
    // he was a spectator and wants to join the game -- he must have the
    // right password
    const box: [string] = [""];
    gi.Info_ValueForKey(client.pers.userinfo, "password", box, MAX_INFO_VALUE);
    const value = box[0];

    const pass = cvarString("password", "");
    if (pass.length > 0 && pass !== "none" && pass !== value) {
      giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "Password incorrect.\n");
      client.pers.spectator = true;
      gi.WriteByte(ServerCommandT.svc_stufftext);
      gi.WriteString("spectator 1\n");
      gi.unicast(ent, true, 0);
      return;
    }
  }

  // clear score on respawn
  client.resp.score = client.pers.score = 0;

  // move us to no team
  client.resp.ctf_team = CtfteamT.CTF_NOTEAM;

  // change spectator mode
  client.resp.spectator = client.pers.spectator;

  ent.svflags &= ~SvflagsT.SVF_NOCLIENT;
  PutClientInServer(ent);

  // add a teleportation effect
  if (!client.pers.spectator) {
    gi.WriteByte(ServerCommandT.svc_muzzleflash);
    gi.WriteEntity(ent);
    gi.WriteByte(9); // MZ_LOGIN
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

    client.ps.pmove.pm_flags = PmflagsT.PMF_TIME_TELEPORT;
    client.ps.pmove.pm_time = 112;
  }

  client.respawn_time = level.time;

  if (client.pers.spectator) giLocBroadcastPrint(PrintTypeT.PRINT_HIGH, "$g_observing", client.pers.netname);
  else giLocBroadcastPrint(PrintTypeT.PRINT_HIGH, "$g_joined_game", client.pers.netname);
}

// ---------------------------------------------------------------------------
// PutClientOnSpawnPoint / PutClientInServer (p_client.cpp:1949-2302)
// ---------------------------------------------------------------------------

/** p_client.cpp:1949-1970: `inline void PutClientOnSpawnPoint(...)`. */
function PutClientOnSpawnPoint(ent: EdictT, spawn_origin: Vec3, spawn_angles: Vec3): void {
  if (ent.client === null) throw new Error("PutClientOnSpawnPoint: ent.client is null (invariant violated)");
  const client = ent.client;

  client.ps.pmove.origin = vec3(spawn_origin[0], spawn_origin[1], spawn_origin[2]);

  ent.s.origin = vec3(spawn_origin[0], spawn_origin[1], spawn_origin[2]);
  if (!use_squad_respawn) ent.s.origin[2] += 1; // make sure off ground
  ent.s.old_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);

  // set the delta angle
  client.ps.pmove.delta_angles = vec3_sub(spawn_angles, client.resp.cmd_angles);

  ent.s.angles = vec3(spawn_angles[0], spawn_angles[1], spawn_angles[2]);
  ent.s.angles[0] /= 3; // PITCH

  client.ps.viewangles = vec3(ent.s.angles[0], ent.s.angles[1], ent.s.angles[2]);
  client.v_angle = vec3(ent.s.angles[0], ent.s.angles[1], ent.s.angles[2]);

  AngleVectors(client.v_angle, client.v_forward, null, null);
}

/** p_client.cpp:1980-2302: `void PutClientInServer(edict_t *ent)`. */
export function PutClientInServer(ent: EdictT): void {
  if (ent.client === null) throw new Error("PutClientInServer: ent.client is null (invariant violated)");
  const world = g_edicts[0];
  if (world === undefined) throw new Error("PutClientInServer: g_edicts[0] (world) missing");

  const index = g_edicts.indexOf(ent) - 1;
  let client = ent.client;

  // clear velocity now, since landmark may change it
  ent.velocity = vec3();

  const keepVelocity = client.landmark_name !== null;
  if (keepVelocity) ent.velocity = vec3(client.oldvelocity[0], client.oldvelocity[1], client.oldvelocity[2]);

  // find a spawn point; do it before setting health back up, so farthest
  // ranging doesn't count this client
  let valid_spawn = false;
  const force_spawn = client.awaiting_respawn && level.time > client.respawn_timeout;
  const landmarkBox: [boolean] = [false];
  const originBox: [Vec3] = [vec3()];
  const anglesBox: [Vec3] = [vec3()];

  if (use_squad_respawn) {
    originBox[0] = vec3(squad_respawn_position[0], squad_respawn_position[1], squad_respawn_position[2]);
    anglesBox[0] = vec3(squad_respawn_angles[0], squad_respawn_angles[1], squad_respawn_angles[2]);
    valid_spawn = true;
  } else if (cvarBool("gamerules", "0")) {
    // DMGame.SelectSpawnPoint -- always null in this port line (see file header).
    valid_spawn = SelectSpawnPoint(ent, originBox, anglesBox, force_spawn, landmarkBox);
  } else {
    valid_spawn = SelectSpawnPoint(ent, originBox, anglesBox, force_spawn, landmarkBox);
  }

  const spawn_origin = originBox[0];
  const spawn_angles = anglesBox[0];

  // [Paril-KEX] if we didn't get a valid spawn, hold us in limbo for a
  // while until we do get one
  if (!valid_spawn) {
    if (!client.awaiting_respawn) {
      ClientUserinfoChanged(ent, client.pers.userinfo);
      client.respawn_timeout = Gtime_add(level.time, Gtime_from_sec(3));
    }

    if (!level.respawn_intermission) {
      let pt = G_FindByString(null, "classname", "info_player_intermission");
      if (pt === null) {
        pt = G_FindByString(null, "classname", "info_player_start");
        if (pt === null) pt = G_FindByString(null, "classname", "info_player_deathmatch");
      } else {
        // choose one of four spots
        let i = irandom(4);
        while (i--) {
          const next = G_FindByString(pt, "classname", "info_player_intermission");
          pt = next ?? G_FindByString(pt, "classname", "info_player_intermission");
        }
      }

      if (pt !== null) {
        level.intermission_origin = vec3(pt.s.origin[0], pt.s.origin[1], pt.s.origin[2]);
        level.intermission_angle = vec3(pt.s.angles[0], pt.s.angles[1], pt.s.angles[2]);
      }
      level.respawn_intermission = true;
    }

    ent.s.origin = vec3(level.intermission_origin[0], level.intermission_origin[1], level.intermission_origin[2]);
    client.ps.pmove.origin = vec3(level.intermission_origin[0], level.intermission_origin[1], level.intermission_origin[2]);
    client.ps.viewangles = vec3(level.intermission_angle[0], level.intermission_angle[1], level.intermission_angle[2]);

    client.awaiting_respawn = true;
    client.ps.pmove.pm_type = KexPmTypeT.PM_FREEZE;
    client.ps.rdflags = RefdefFlagsT.RDF_NONE;
    ent.deadflag = false;
    ent.solid = SolidT.SOLID_NOT;
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    ent.s.modelindex = 0;
    ent.svflags |= SvflagsT.SVF_NOCLIENT;
    client.ps.team_id = client.resp.ctf_team;
    gi.linkentity(ent);

    return;
  }

  client.resp.ctf_state++;

  const was_waiting_for_respawn = client.awaiting_respawn;

  if (client.awaiting_respawn) ent.svflags &= ~SvflagsT.SVF_NOCLIENT;

  client.awaiting_respawn = false;
  client.respawn_timeout = GTIME_ZERO;

  const social_id = client.pers.social_id;

  let resp: ClientRespawnT;

  // deathmatch wipes most client data every spawn
  if (deathmatchEnabled()) {
    client.pers.health = 0;
    resp = client.resp;
  } else {
    const userinfo = client.pers.userinfo;

    if (coopEnabled()) {
      resp = client.resp;

      if (!P_UseCoopInstancedItems()) {
        resp.coop_respawn.game_help1changed = client.pers.game_help1changed;
        resp.coop_respawn.game_help2changed = client.pers.game_help2changed;
        resp.coop_respawn.helpchanged = client.pers.helpchanged;
        client.pers = resp.coop_respawn;
      } else {
        // fix weapon
        if (client.pers.weapon === null) client.pers.weapon = client.pers.lastweapon;
      }
    } else {
      resp = defaultClientRespawn();
    }

    ClientUserinfoChanged(ent, userinfo);

    if (coopEnabled()) {
      if (resp.score > client.pers.score) client.pers.score = resp.score;
    } else {
      resp = defaultClientRespawn();
    }
  }

  // clear everything but the persistant data. `client` is the SAME object
  // as `game.clients[index]` (an invariant this port line's own
  // ClientConnect/ClientBegin establish, matching C's `ent->client`
  // always pointing into the `game.clients` array) -- mutating it in place
  // via `Object.assign` mirrors C's `memset(client, 0, sizeof(*client))`
  // exactly, preserving the aliasing that `game.clients[index]` elsewhere
  // in this function (and in SaveClientData/ClientBegin/etc.) depends on.
  // A fresh, disconnected `defaultGClient()` object assigned to the local
  // variable alone would NOT be visible through `game.clients[index]`.
  const saved = client.pers;
  Object.assign(client, defaultGClient());
  client.pers = saved;
  client.resp = resp;

  // on a new, fresh spawn (always in DM, clear inventory or new spawns in SP/coop)
  if (client.pers.health <= 0) InitClientPersistant(ent, client);

  // restore social ID
  client.pers.social_id = social_id;

  // fix level switch issue
  client.pers.connected = true;

  // slow time will be unset here
  globals.server_flags &= ~0x2; // SERVER_FLAG_SLOW_TIME

  // copy some data from the client to the entity
  FetchClientEntData(ent);

  // clear entity values
  ent.groundentity = null;
  ent.client = game.clients[index] ?? client;
  ent.takedamage = true;
  ent.movetype = MovetypeT.MOVETYPE_WALK;
  ent.viewheight = 22;
  ent.inuse = true;
  ent.classname = "player";
  ent.mass = 200;
  ent.solid = SolidT.SOLID_BBOX;
  ent.deadflag = false;
  ent.air_finished = Gtime_add(level.time, Gtime_from_sec(12));
  ent.clipmask = MASK_PLAYERSOLID;
  ent.model = "players/male/tris.md2";
  ent.die = player_die;
  ent.waterlevel = WaterLevelT.WATER_NONE;
  ent.watertype = ContentsT.CONTENTS_NONE;
  ent.flags &= ~(EntFlagsT.FL_NO_KNOCKBACK | EntFlagsT.FL_ALIVE_KNOCKBACK_ONLY | EntFlagsT.FL_NO_DAMAGE_EFFECTS);
  ent.svflags &= ~SvflagsT.SVF_DEADMONSTER;
  ent.svflags |= SvflagsT.SVF_PLAYER;
  ent.flags &= ~EntFlagsT.FL_SAM_RAIMI; // PGM - turn off sam raimi flag

  ent.mins = vec3(PLAYER_MINS[0], PLAYER_MINS[1], PLAYER_MINS[2]);
  ent.maxs = vec3(PLAYER_MAXS[0], PLAYER_MAXS[1], PLAYER_MAXS[2]);

  // clear playerstate values -- p_client.cpp:2181's own
  // `memset(&ent->client->ps, 0, sizeof(client->ps))` is genuinely redundant
  // with the earlier whole-struct `memset(client, 0, sizeof(*client))`
  // (nothing between the two writes into `ps`); ported faithfully anyway
  // rather than "fixed", matching PORTING.md's bug-for-bug mandate.
  if (ent.client === null) throw new Error("PutClientInServer: ent.client became null unexpectedly");
  ent.client.ps.pmove.pm_flags = 0;
  ent.client.ps.pmove.pm_time = 0;
  ent.client.ps.pmove.gravity = 0;
  ent.client.ps.pmove.delta_angles = vec3();
  ent.client.ps.viewangles = vec3();
  ent.client.ps.viewoffset = vec3();
  ent.client.ps.kick_angles = vec3();
  ent.client.ps.gunangles = vec3();
  ent.client.ps.gunoffset = vec3();
  ent.client.ps.gunframe = 0;
  ent.client.ps.rdflags = RefdefFlagsT.RDF_NONE;

  const fovBox: [string] = [""];
  gi.Info_ValueForKey(ent.client.pers.userinfo, "fov", fovBox, MAX_INFO_VALUE);
  ent.client.ps.fov = clamp(Number(fovBox[0]) || 0, 1, 160);

  ent.client.ps.pmove.viewheight = ent.viewheight;
  ent.client.ps.team_id = ent.client.resp.ctf_team;

  if (!G_ShouldPlayersCollide(false)) ent.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  if (ent.client.pers.weapon !== null) ent.client.ps.gunindex = gi.modelindex(ent.client.pers.weapon.view_model ?? "");
  else ent.client.ps.gunindex = 0;
  ent.client.ps.gunskin = 0;

  // clear entity state values
  ent.s.effects = EffectsT.EF_NONE;
  ent.s.modelindex = MODELINDEX_PLAYER; // will use the skin specified model
  ent.s.modelindex2 = MODELINDEX_PLAYER; // custom gun model
  P_AssignClientSkinnum(ent);

  ent.s.frame = 0;

  PutClientOnSpawnPoint(ent, spawn_origin, spawn_angles);

  // [Paril-KEX] set up world fog & send it instantly
  ent.client.pers.wanted_fog = [world.fog.density, world.fog.color[0], world.fog.color[1], world.fog.color[2], world.fog.sky_factor];
  ent.client.pers.wanted_heightfog = {
    start: [world.heightfog.start_color[0], world.heightfog.start_color[1], world.heightfog.start_color[2], world.heightfog.start_dist],
    end: [world.heightfog.end_color[0], world.heightfog.end_color[1], world.heightfog.end_color[2], world.heightfog.end_dist],
    falloff: world.heightfog.falloff,
    density: world.heightfog.density,
  };
  P_ForceFogTransition(ent, true);

  // ZOID
  if (CTFStartClient(ent)) return;

  // spawn a spectator
  if (client.pers.spectator) {
    client.chase_target = null;
    client.resp.spectator = true;

    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    ent.solid = SolidT.SOLID_NOT;
    ent.svflags |= SvflagsT.SVF_NOCLIENT;
    ent.client.ps.gunindex = 0;
    ent.client.ps.gunskin = 0;
    gi.linkentity(ent);
    return;
  }

  client.resp.spectator = false;

  // [Paril-KEX] a bit of a hack, but landmark spawns can sometimes cause
  // intersecting spawns, so we'll do a sanity check here...
  if (spawn_from_begin) {
    if (coopEnabled()) {
      const collision = G_UnsafeSpawnPosition(ent.s.origin, true);

      if (collision !== null) {
        gi.linkentity(ent);

        if (collision.client !== null) {
          // we spawned in somebody else, so we're going to change their spawn position
          const lm: [boolean] = [false];
          const collOriginBox: [Vec3] = [vec3()];
          const collAnglesBox: [Vec3] = [vec3()];
          SelectSpawnPoint(collision, collOriginBox, collAnglesBox, true, lm);
          PutClientOnSpawnPoint(collision, collOriginBox[0], collAnglesBox[0]);
        }
        // else, no choice but to accept where ever we spawned :(
      }
    }

    // give us one (1) free fall ticket even if we didn't spawn from landmark
    ent.client.landmark_free_fall = true;
  }

  gi.linkentity(ent);

  KillBox(ent, true, ModIdT.MOD_TELEFRAG_SPAWN);

  // my tribute to cash's level-specific hacks.
  if (level.mapname.toLowerCase() === "rboss") {
    // if you get on to rboss in single player or coop, ensure the player
    // has the nuke key (not in DM).
    if (!deathmatchEnabled()) client.pers.inventory[ItemIdT.IT_KEY_NUKE] = 1;
  }

  // force the current weapon up
  client.newweapon = client.pers.weapon;
  ChangeWeapon(ent);

  if (was_waiting_for_respawn) G_PostRespawn(ent);
}

// ---------------------------------------------------------------------------
// ClientBeginDeathmatch / G_SetLevelEntry / ClientBegin (p_client.cpp:2312-2538)
// ---------------------------------------------------------------------------

export function ClientBeginDeathmatch(ent: EdictT): void {
  G_InitEdict(ent);

  // make sure we have a known default
  ent.svflags |= SvflagsT.SVF_PLAYER;

  if (ent.client === null) throw new Error("ClientBeginDeathmatch: ent.client is null (invariant violated)");
  InitClientResp(ent.client);

  // ZOID
  if (G_TeamplayEnabled() && ent.client.resp.ctf_team < CtfteamT.CTF_TEAM1) CTFAssignTeam(ent.client);

  // PGM: DMGame.ClientBegin -- always null in this port line (see file header).
  void cvarBool("gamerules", "0");

  // locate ent at a spawn point
  PutClientInServer(ent);

  if (Gtime_nonzero(level.intermissiontime)) {
    MoveClientToIntermission(ent);
  } else {
    if ((ent.svflags & SvflagsT.SVF_NOCLIENT) === 0) {
      gi.WriteByte(ServerCommandT.svc_muzzleflash);
      gi.WriteEntity(ent);
      gi.WriteByte(9); // MZ_LOGIN
      gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);
    }
  }

  giLocBroadcastPrint(PrintTypeT.PRINT_HIGH, "$g_entered_game", ent.client.pers.netname);

  // make sure all view stuff is valid
  ClientEndServerFrame(ent);
}

/** p_client.cpp:2358-2458: `static void G_SetLevelEntry()`. */
function G_SetLevelEntry(): void {
  if (deathmatchEnabled()) return;
  // map is a hub map, so we shouldn't bother tracking any of this. the
  // next map will pick up as the start.
  if (level.hub_map) return;

  let found_entry = null;
  let highest_order = 0;

  for (let i = 0; i < game.level_entries.length; i++) {
    const entry = game.level_entries[i];
    if (entry === undefined) continue;
    highest_order = Math.max(highest_order, entry.visit_order);

    if (entry.map_name === level.mapname || entry.map_name.length === 0) {
      found_entry = entry;
      break;
    }
  }

  if (found_entry === null) {
    gi.Com_Print(`WARNING: more than ${game.level_entries.length} maps in unit, can't track the rest\n`);
    return;
  }

  level.entry = found_entry;
  found_entry.map_name = level.mapname;

  // we're visiting this map for the first time, so mark it in our order as
  // being recent
  if (found_entry.pretty_name.length === 0) {
    found_entry.pretty_name = level.level_name;
    found_entry.visit_order = highest_order + 1;

    // give all of the clients an extra life back
    if (cvarBool("g_coop_enable_lives", "0")) {
      for (let i = 0; i < game.maxclients; i++) {
        const c = game.clients[i];
        if (c === undefined) continue;
        c.pers.lives = Math.min(cvarInt("g_coop_num_lives", "0") + 1, c.pers.lives + 1);
      }
    }
  }

  // scan for all new maps we can go to, for secret levels
  let changelevel: EdictT | null = null;
  while ((changelevel = G_FindByString(changelevel, "classname", "target_changelevel")) !== null) {
    if (changelevel.map === null || changelevel.map.length === 0) continue;

    // next unit map, don't count it
    if (changelevel.map.includes("*")) continue;

    const plusIdx = changelevel.map.indexOf("+");
    let mapLevel = plusIdx === -1 ? changelevel.map : changelevel.map.slice(plusIdx + 1);

    // don't include end screen levels
    if (mapLevel.includes(".cin") || mapLevel.includes(".pcx")) continue;

    const dollarIdx = mapLevel.indexOf("$");
    if (dollarIdx !== -1) mapLevel = mapLevel.slice(0, dollarIdx);

    // make an entry for this level that we may or may not visit
    let entryForLevel = null;
    for (let i = 0; i < game.level_entries.length; i++) {
      const entry = game.level_entries[i];
      if (entry === undefined) continue;
      if (entry.map_name.length === 0 || entry.map_name.startsWith(mapLevel)) {
        entryForLevel = entry;
        break;
      }
    }

    if (entryForLevel === null) {
      gi.Com_Print(`WARNING: more than ${game.level_entries.length} maps in unit, can't track the rest\n`);
      return;
    }

    entryForLevel.map_name = mapLevel;
  }
}

export function ClientBegin(ent: EdictT): void {
  const idx = g_edicts.indexOf(ent) - 1;
  ent.client = game.clients[idx] ?? null;
  if (ent.client === null) throw new Error("ClientBegin: no game.clients slot for this entity");

  ent.client.awaiting_respawn = false;
  ent.client.respawn_timeout = GTIME_ZERO;

  // [Paril-KEX] we're always connected by this point...
  ent.client.pers.connected = true;

  if (deathmatchEnabled()) {
    ClientBeginDeathmatch(ent);
    return;
  }

  // [Paril-KEX] set enter time now, so we can send messages slightly after
  // somebody first joins
  ent.client.resp.entertime = level.time;
  ent.client.pers.spawned = true;

  if (ent.inuse) {
    // the client has cleared the client side viewangles upon connecting to
    // the server, which is different than the state when the game is
    // saved, so we need to compensate with deltaangles
    ent.client.ps.pmove.delta_angles = vec3(ent.client.ps.viewangles[0], ent.client.ps.viewangles[1], ent.client.ps.viewangles[2]);
  } else {
    // a spawn point will completely reinitialize the entity except for the
    // persistant data that was initialized at ClientConnect() time
    G_InitEdict(ent);
    ent.classname = "player";
    InitClientResp(ent.client);
    spawn_from_begin = true;
    PutClientInServer(ent);
    spawn_from_begin = false;
  }

  // make sure we have a known default
  ent.svflags |= SvflagsT.SVF_PLAYER;

  if (Gtime_nonzero(level.intermissiontime)) {
    MoveClientToIntermission(ent);
  } else {
    // send effect if in a multiplayer game
    if (game.maxclients > 1 && (ent.svflags & SvflagsT.SVF_NOCLIENT) === 0) {
      giLocBroadcastPrint(PrintTypeT.PRINT_HIGH, "$g_entered_game", ent.client.pers.netname);
    }
  }

  level.coop_scale_players++;
  G_Monster_CheckCoopHealthScaling();

  // make sure all view stuff is valid
  ClientEndServerFrame(ent);

  // [Paril-KEX] send them goal, if needed
  G_PlayerNotifyGoal(ent);

  // [Paril-KEX] we're going to set this here just to be certain that the
  // level entry timer only starts when a player is actually *in* the level
  G_SetLevelEntry();
}

// ---------------------------------------------------------------------------
// P_GetLobbyUserNum / G_EncodedPlayerName (p_client.cpp:2545-2567)
// ---------------------------------------------------------------------------

export function P_GetLobbyUserNum(player: EdictT): number {
  const idx = g_edicts.indexOf(player);
  if (idx <= 0) return 0;
  let playerNum = idx - 1;
  if (playerNum >= MAX_CLIENTS) playerNum = 0;
  return playerNum;
}

export function G_EncodedPlayerName(player: EdictT): string {
  const playernum = P_GetLobbyUserNum(player);
  return `##P${playernum}`;
}

// ---------------------------------------------------------------------------
// ClientUserinfoChanged (p_client.cpp:2576-2667)
// ---------------------------------------------------------------------------

export function ClientUserinfoChanged(ent: EdictT, userinfo: string): void {
  if (ent.client === null) throw new Error("ClientUserinfoChanged: ent.client is null (invariant violated)");
  const client = ent.client;

  // set name
  const nameBox: [string] = [""];
  const nameFound = gi.Info_ValueForKey(userinfo, "name", nameBox, MAX_NETNAME);
  client.pers.netname = nameFound !== 0 ? nameBox[0] : "badinfo";

  // set spectator
  const specBox: [string] = [""];
  gi.Info_ValueForKey(userinfo, "spectator", specBox, MAX_INFO_VALUE);
  const specVal = specBox[0];

  // spectators are only supported in deathmatch
  client.pers.spectator = deathmatchEnabled() && !G_TeamplayEnabled() && specVal.length > 0 && specVal !== "0";

  // set skin
  const skinBox: [string] = [""];
  const skinFound = gi.Info_ValueForKey(userinfo, "skin", skinBox, MAX_INFO_VALUE);
  const skin = skinFound !== 0 ? skinBox[0] : "male/grunt";

  const playernum = g_edicts.indexOf(ent) - 1;

  // combine name and skin into a configstring
  // ZOID
  if (G_TeamplayEnabled()) {
    CTFAssignSkin(ent, skin);
  } else {
    // set dogtag
    const dogtagBox: [string] = [""];
    gi.Info_ValueForKey(userinfo, "dogtag", dogtagBox, MAX_INFO_VALUE);
    const dogtag = dogtagBox[0];

    gi.configstring(CS_PLAYERSKINS + playernum, `${client.pers.netname}\\${skin}\\${dogtag}`);
  }

  // ZOID: set player name field (used in id_state view)
  gi.configstring(CS_GENERAL + 2 + playernum, client.pers.netname);

  // [Kex] netname is used for a couple of other things, so we update this after those.
  if ((ent.svflags & SvflagsT.SVF_BOT) === 0) {
    client.pers.netname = G_EncodedPlayerName(ent);
  }

  // fov
  const fovBox: [string] = [""];
  gi.Info_ValueForKey(userinfo, "fov", fovBox, MAX_INFO_VALUE);
  client.ps.fov = clamp(Number(fovBox[0]) || 0, 1, 160);

  // handedness
  const handBox: [string] = [""];
  if (gi.Info_ValueForKey(userinfo, "hand", handBox, MAX_INFO_VALUE) !== 0) {
    client.pers.hand = clamp(parseInt(handBox[0], 10) || 0, HandednessT.RIGHT_HANDED, HandednessT.CENTER_HANDED);
  } else {
    client.pers.hand = HandednessT.RIGHT_HANDED;
  }

  // [Paril-KEX] auto-switch
  const autoswitchBox: [string] = [""];
  if (gi.Info_ValueForKey(userinfo, "autoswitch", autoswitchBox, MAX_INFO_VALUE) !== 0) {
    client.pers.autoswitch = clamp(parseInt(autoswitchBox[0], 10) || 0, AutoSwitchT.SMART, AutoSwitchT.NEVER);
  } else {
    client.pers.autoswitch = AutoSwitchT.SMART;
  }

  const autoshieldBox: [string] = [""];
  if (gi.Info_ValueForKey(userinfo, "autoshield", autoshieldBox, MAX_INFO_VALUE) !== 0) {
    client.pers.autoshield = parseInt(autoshieldBox[0], 10) || 0;
  } else {
    client.pers.autoshield = -1;
  }

  // [Paril-KEX] wants bob
  const bobskipBox: [string] = [""];
  if (gi.Info_ValueForKey(userinfo, "bobskip", bobskipBox, MAX_INFO_VALUE) !== 0) {
    client.pers.bob_skip = bobskipBox[0][0] === "1";
  } else {
    client.pers.bob_skip = false;
  }

  // save off the userinfo in case we want to check something later
  client.pers.userinfo = userinfo;
}

// ---------------------------------------------------------------------------
// ClientChooseSlot family (p_client.cpp:2669-2815)
// ---------------------------------------------------------------------------

function IsSlotIgnored(slot: EdictT, ignore: readonly EdictT[]): boolean {
  return ignore.includes(slot);
}

function ClientChooseSlot_Any(ignore: readonly EdictT[]): EdictT | null {
  for (let i = 0; i < game.maxclients; i++) {
    const slot = g_edicts[i + 1];
    if (slot !== undefined && !IsSlotIgnored(slot, ignore) && slot.client !== null && !slot.client.pers.connected) return slot;
  }
  return null;
}

/** p_client.cpp:2687-2803: `inline edict_t *ClientChooseSlot_Coop(...)`.
 * [Kex] for coop, we want to try to ensure that players will always get
 * their proper slot back when they connect. */
function ClientChooseSlot_Coop(userinfo: string, social_id: string, ignore: readonly EdictT[]): EdictT | null {
  const nameBox: [string] = [""];
  gi.Info_ValueForKey(userinfo, "name", nameBox, MAX_INFO_VALUE);
  const name = nameBox[0];

  // the host should always occupy slot 0
  {
    let num_players = 0;
    for (let i = 0; i < game.maxclients; i++) {
      const slot = g_edicts[i + 1];
      if (slot !== undefined && (IsSlotIgnored(slot, ignore) || (slot.client !== null && slot.client.pers.connected))) num_players++;
    }

    if (num_players === 0) {
      gi.Com_Print(`coop slot 1 is host ${name}+${social_id}\n`);
      const first = g_edicts[1];
      if (first !== undefined) return first;
    }
  }

  const MATCH_USERNAME = 1;
  const MATCH_SOCIAL = 2;
  const matches: { slot: EdictT | null; total: number }[] = [
    { slot: null, total: 0 },
    { slot: null, total: 0 },
    { slot: null, total: 0 },
    { slot: null, total: 0 },
  ];

  for (let i = 0; i < game.maxclients; i++) {
    const slot = g_edicts[i + 1];
    if (slot === undefined || IsSlotIgnored(slot, ignore) || (slot.client !== null && slot.client.pers.connected)) continue;
    if (slot.client === null) continue;

    const checkNameBox: [string] = [""];
    gi.Info_ValueForKey(slot.client.pers.userinfo, "name", checkNameBox, MAX_INFO_VALUE);

    const username_match = slot.client.pers.userinfo.length > 0 && checkNameBox[0] === name;
    const social_match = social_id.length > 0 && slot.client.pers.social_id.length > 0 && slot.client.pers.social_id === social_id;

    let type = 0;
    if (username_match) type |= MATCH_USERNAME;
    if (social_match) type |= MATCH_SOCIAL;
    if (type === 0) continue;

    const bucket = matches[type];
    if (bucket !== undefined) {
      bucket.slot = slot;
      bucket.total++;
    }
  }

  for (let i = 2; i >= 0; i--) {
    const bucket = matches[i];
    if (bucket !== undefined && bucket.total === 1 && bucket.slot !== null) {
      const slot = bucket.slot;
      const slotIdx = g_edicts.indexOf(slot);
      gi.Com_Print(`coop slot ${slotIdx} restored for ${name}+${social_id}\n`);

      if (!slot.inuse) {
        slot.s.modelindex = MODELINDEX_PLAYER;
        slot.solid = SolidT.SOLID_BBOX;

        G_InitEdict(slot);
        slot.classname = "player";
        if (slot.client === null) throw new Error("ClientChooseSlot_Coop: slot.client is null after G_InitEdict");
        InitClientResp(slot.client);
        spawn_from_begin = true;
        PutClientInServer(slot);
        spawn_from_begin = false;

        slot.svflags |= SvflagsT.SVF_PLAYER;

        slot.sv.init = false;
        slot.classname = "player";
        slot.client.pers.connected = true;
        slot.client.pers.spawned = true;
        P_AssignClientSkinnum(slot);
        gi.linkentity(slot);
      }

      return slot;
    }
  }

  // in the case where we can't find a match, we're probably a new player,
  // so pick a slot that hasn't been occupied yet
  for (let i = 0; i < game.maxclients; i++) {
    const slot = g_edicts[i + 1];
    if (slot !== undefined && !IsSlotIgnored(slot, ignore) && slot.client !== null && slot.client.pers.userinfo.length === 0) {
      gi.Com_Print(`coop slot ${i + 1} issuing new for ${name}+${social_id}\n`);
      return slot;
    }
  }

  // all slots have some player data in them, we're forced to replace one.
  const any_slot = ClientChooseSlot_Any(ignore);
  gi.Com_Print(`coop slot ${any_slot === null ? -1 : g_edicts.indexOf(any_slot)} any slot for ${name}+${social_id}\n`);
  return any_slot;
}

export function ClientChooseSlot(userinfo: string, social_id: string, isBot: boolean, ignore: readonly EdictT[], cinematic: boolean): EdictT | null {
  // coop and non-bots is the only thing that we need to do special behavior on
  if (!cinematic && coopEnabled() && !isBot) return ClientChooseSlot_Coop(userinfo, social_id, ignore);

  // just find any free slot
  return ClientChooseSlot_Any(ignore);
}

// ---------------------------------------------------------------------------
// ClientConnect / ClientDisconnect (p_client.cpp:2829-2987)
// ---------------------------------------------------------------------------

export function ClientConnect(ent: EdictT, userinfoBox: [string], social_id: string, isBot: boolean): boolean {
  const userinfo = userinfoBox[0];

  // check for a spectator
  const specBox: [string] = [""];
  gi.Info_ValueForKey(userinfo, "spectator", specBox, MAX_INFO_VALUE);
  const specVal = specBox[0];

  if (deathmatchEnabled() && specVal.length > 0 && specVal !== "0") {
    const specPass = cvarString("spectator_password", "");
    if (specPass.length > 0 && specPass !== "none" && specPass !== specVal) {
      userinfoBox[0] = setInfoValue(userinfoBox[0], "rejmsg", "Spectator password required or incorrect.");
      return false;
    }

    let numspec = 0;
    for (let i = 0; i < game.maxclients; i++) {
      const e = g_edicts[i + 1];
      if (e !== undefined && e.inuse && e.client !== null && e.client.pers.spectator) numspec++;
    }

    if (numspec >= cvarInt("maxspectators", "8")) {
      userinfoBox[0] = setInfoValue(userinfoBox[0], "rejmsg", "Server spectator limit is full.");
      return false;
    }
  } else {
    // check for a password (if not a bot!)
    const passBox: [string] = [""];
    gi.Info_ValueForKey(userinfo, "password", passBox, MAX_INFO_VALUE);
    const passVal = passBox[0];

    const pass = cvarString("password", "");
    if (!isBot && pass.length > 0 && pass !== "none" && pass !== passVal) {
      userinfoBox[0] = setInfoValue(userinfoBox[0], "rejmsg", "Password required or incorrect.");
      return false;
    }
  }

  // they can connect
  const idx = g_edicts.indexOf(ent) - 1;
  ent.client = game.clients[idx] ?? null;
  if (ent.client === null) throw new Error("ClientConnect: no game.clients slot for this entity");

  // set up userinfo early
  ClientUserinfoChanged(ent, userinfoBox[0]);

  if (!ent.inuse) {
    // clear the respawning variables
    // ZOID -- force team join
    ent.client.resp.ctf_team = CtfteamT.CTF_NOTEAM;
    ent.client.resp.id_state = true;
    InitClientResp(ent.client);
    if (!game.autosaved || ent.client.pers.weapon === null) InitClientPersistant(ent, ent.client);
  }

  // make sure we start with known default(s)
  ent.svflags = SvflagsT.SVF_PLAYER;
  if (isBot) ent.svflags |= SvflagsT.SVF_BOT;

  ent.client.pers.social_id = social_id;

  if (game.maxclients > 1) {
    // [Paril-KEX] fetch name because now netname is kinda unsuitable
    const nameBox: [string] = [""];
    gi.Info_ValueForKey(userinfoBox[0], "name", nameBox, MAX_INFO_VALUE);
    giLocClientPrint(null, PrintTypeT.PRINT_HIGH, "$g_player_connected", nameBox[0]);
  }

  ent.client.pers.connected = true;

  // [Paril-KEX] force a state update
  ent.sv.init = false;
  return true;
}

/** `Info_SetValueForKey` wrapper matching this port line's boxed-string convention. */
function setInfoValue(s: string, key: string, value: string): string {
  const box: [string] = [s];
  gi.Info_SetValueForKey(box, key, value);
  return box[0];
}

export function ClientDisconnect(ent: EdictT): void {
  if (ent.client === null) return;

  // ZOID
  CTFDeadDropFlag(ent);
  CTFDeadDropTech(ent);

  PlayerTrail_Destroy(ent);

  // ROGUE: make sure no trackers are still hurting us.
  if (Gtime_nonzero(ent.client.tracker_pain_time)) RemoveAttackingPainDaemons(ent);

  if (ent.client.owned_sphere !== null) {
    if (ent.client.owned_sphere.inuse) G_FreeEdict(ent.client.owned_sphere);
    ent.client.owned_sphere = null;
  }

  // ROGUE: DMGame.PlayerDisconnect -- always null in this port line (see file header).
  void cvarBool("gamerules", "0");

  // send effect
  if ((ent.svflags & SvflagsT.SVF_NOCLIENT) === 0) {
    gi.WriteByte(ServerCommandT.svc_muzzleflash);
    gi.WriteEntity(ent);
    gi.WriteByte(10); // MZ_LOGOUT
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);
  }

  gi.unlinkentity(ent);
  ent.s.modelindex = 0;
  ent.solid = SolidT.SOLID_NOT;
  ent.inuse = false;
  ent.sv.init = false;
  ent.classname = "disconnected";
  ent.client.pers.connected = false;
  ent.client.pers.spawned = false;
  ent.timestamp = Gtime_add(level.time, Gtime_from_sec(1));

  // update active scoreboards
  if (deathmatchEnabled()) {
    for (const player of active_players()) {
      if (player.client !== null && player.client.showscores) player.client.menutime = level.time;
    }
  }
}

// ---------------------------------------------------------------------------
// SV_PM_Clip / G_ShouldPlayersCollide (p_client.cpp:2991-3011)
// ---------------------------------------------------------------------------

/** p_client.cpp:2991-2994: `trace_t SV_PM_Clip(...)`. */
export function SV_PM_Clip(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, mask: ContentsT): KexTraceT {
  const world = g_edicts[0] ?? null;
  return gi.clip(world, start, mins, maxs, end, mask);
}

/** p_client.cpp:2996-3011: `bool G_ShouldPlayersCollide(bool weaponry)`. Real export -- see file header "RECONCILIATION". */
export function G_ShouldPlayersCollide(weaponry: boolean): boolean {
  if (cvarBool("g_disable_player_collision", "0")) return false; // only for debugging.

  // always collide on dm
  if (!coopEnabled()) return true;

  // weaponry collides if friendly fire is enabled
  if (weaponry && cvarBool("g_friendly_fire", "0")) return true;

  // check collision cvar
  return cvarBool("g_coop_player_collision", "0");
}

// ---------------------------------------------------------------------------
// P_FallingDamage (p_client.cpp:3021-3104)
// ---------------------------------------------------------------------------

export function P_FallingDamage(ent: EdictT, pm: KexPmoveT): void {
  if (ent.client === null) throw new Error("P_FallingDamage: ent.client is null (invariant violated)");
  const client = ent.client;
  const world = g_edicts[0];
  if (world === undefined) throw new Error("P_FallingDamage: g_edicts[0] (world) missing");

  // dead stuff can't crater
  if (ent.health <= 0 || ent.deadflag) return;
  if (ent.s.modelindex !== MODELINDEX_PLAYER) return; // not in the player model
  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) return;

  // never take falling damage if completely underwater
  if (pm.waterlevel === WaterLevelT.WATER_UNDER) return;

  // ZOID: never take damage if just release grapple or on grapple
  if (client.ctf_grapplereleasetime >= level.time || (client.ctf_grapple !== null && client.ctf_grapplestate > 0 /* CTF_GRAPPLE_STATE_FLY */)) return;

  let delta = pm.s.pm_time; // impact_delta placeholder -- see note below
  // NOTE: `pmove_t::impact_delta` (the fall-speed-at-impact scalar the C
  // engine's Pmove() fills in) has no equivalent field anywhere on
  // `KexPmoveT`/`KexPmoveStateT` in this port line (grepped both interfaces
  // in src/kexapi/game.ts: zero matches for "impact_delta"). The vertical
  // speed change across this move (start_velocity.z vs the post-move
  // velocity) is the closest faithful substitute available from ported
  // state; `p_move.ts`'s own `PmlT.start_velocity` is module-private, so it
  // is reconstructed here from `pm.s.velocity` before/after is not
  // observable post-Pmove() either. This is a genuine, reported gap: see
  // "DROPPED" note below.
  delta = ent.velocity[2] < 0 ? -ent.velocity[2] : 0;

  delta = delta * delta * 0.0001;

  if (pm.waterlevel === WaterLevelT.WATER_WAIST) delta *= 0.25;
  if (pm.waterlevel === WaterLevelT.WATER_FEET) delta *= 0.5;

  if (delta < 1) return;

  // restart footstep timer
  client.bobtime = 0;

  if (client.landmark_free_fall) {
    delta = Math.min(30, delta);
    client.landmark_free_fall = false;
    client.landmark_noise_time = Gtime_add(level.time, Gtime_from_ms(100));
  }

  if (delta < 15) {
    if ((pm.s.pm_flags & PmflagsT.PMF_ON_LADDER) === 0) ent.s.event = 3; // EV_FOOTSTEP
    return;
  }

  client.fall_value = delta * 0.5;
  if (client.fall_value > 40) client.fall_value = 40;
  client.fall_time = Gtime_add(level.time, FALL_TIME(Gtime_from_ms(gi.frame_time_ms)));

  if (delta > 30) {
    ent.s.event = delta >= 55 ? 2 /* EV_FALLFAR */ : 1 /* EV_FALL */;

    ent.pain_debounce_time = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
    let damage = Math.trunc((delta - 30) / 2);
    if (damage < 1) damage = 1;
    const dir = vec3(0, 0, 1);

    if (!deathmatchEnabled() || !cvarBool("g_dm_no_fall_damage", "0")) {
      T_Damage(ent, world, world, dir, ent.s.origin, vec3(), damage, 0, 0, modFromId(ModIdT.MOD_FALLING));
    }
  } else {
    ent.s.event = 0; // EV_FALLSHORT
  }

  // Paril: falling damage noises alert monsters
  if (ent.health > 0) PlayerNoise(ent, pm.s.origin, PlayerNoiseT.PNOISE_SELF);
}

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** p_view.cpp:148-227: real, small, ported here per this port line's
 * "small self-contained function" precedent (see p_view.ts's own identical
 * treatment of PlayerNoise for its own call sites) -- duplicated locally
 * rather than imported since p_view.ts's copy is unexported. Only the
 * MONSTER-alerting side effect matters for P_FallingDamage's caller; the
 * bulk of PlayerNoise's real body (monster sight/sound-radius bookkeeping)
 * already lives for real wherever it was first ported. Since a grep of
 * src/kexgame for an EXPORTED `PlayerNoise` found p_view.ts's own real,
 * exported copy (p_view.ts:291), this file imports that one directly
 * instead of re-declaring it -- see the import list above. This comment
 * documents that decision at the one call site that uses it.
 */
import { PlayerNoise } from "./p_view";

// ---------------------------------------------------------------------------
// HandleMenuMovement (p_client.cpp:3106-3137)
// ---------------------------------------------------------------------------

export function HandleMenuMovement(ent: EdictT, ucmd: KexUsercmdT): boolean {
  if (ent.client === null) throw new Error("HandleMenuMovement: ent.client is null (invariant violated)");
  const client = ent.client;

  if (client.menu === null) return false;

  // [Paril-KEX] handle menu movement
  const menu_sign = ucmd.forwardmove > 0 ? 1 : ucmd.forwardmove < 0 ? -1 : 0;

  if (client.menu_sign !== menu_sign) {
    client.menu_sign = menu_sign;

    if (menu_sign > 0) {
      PMenu_Prev(ent);
      return true;
    } else if (menu_sign < 0) {
      PMenu_Next(ent);
      return true;
    }
  }

  if ((client.latched_buttons & (ButtonT.BUTTON_ATTACK | ButtonT.BUTTON_JUMP)) !== 0) {
    PMenu_Select(ent);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// ClientThink (p_client.cpp:3147-3437)
// ---------------------------------------------------------------------------

export function ClientThink(ent: EdictT, ucmd: KexUsercmdT): void {
  if (ent.client === null) throw new Error("ClientThink: ent.client is null (invariant violated)");

  level.current_entity = ent;
  const client = ent.client;

  // [Paril-KEX] pass buttons through even if we are in intermission or chasing.
  client.oldbuttons = client.buttons;
  client.buttons = ucmd.buttons;
  client.latched_buttons |= client.buttons & ~client.oldbuttons;
  client.cmd = ucmd;

  if ((ucmd.buttons & ButtonT.BUTTON_CROUCH) !== 0 && PM_CONFIG_DEFAULT.n64_physics) {
    if (client.pers.n64_crouch_warn_times < 12 && client.pers.n64_crouch_warning < level.time && ++client.pers.n64_crouch_warn_times % 3 === 0) {
      client.pers.n64_crouch_warning = Gtime_add(level.time, Gtime_from_sec(10));
      giLocClientPrint(ent, PrintTypeT.PRINT_CENTER, "$g_n64_crouching");
    }
  }

  if (Gtime_nonzero(level.intermissiontime) || ent.client.awaiting_respawn) {
    client.ps.pmove.pm_type = KexPmTypeT.PM_FREEZE;

    let n64_sp = false;

    if (Gtime_nonzero(level.intermissiontime)) {
      n64_sp = !deathmatchEnabled() && level.is_n64;

      // can exit intermission after five seconds
      if (
        level.changemap !== null &&
        (!n64_sp || level.level_intermission_set) &&
        level.time > Gtime_add(level.intermissiontime, Gtime_from_sec(5)) &&
        (ucmd.buttons & ButtonT.BUTTON_ANY) !== 0
      ) {
        level.exitintermission = true;
      }
    }

    if (!n64_sp) client.ps.pmove.viewheight = ent.viewheight = 22;
    else client.ps.pmove.viewheight = ent.viewheight = 0;
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    return;
  }

  if (ent.client.chase_target !== null) {
    client.resp.cmd_angles = vec3(ucmd.angles[0], ucmd.angles[1], ucmd.angles[2]);
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
  } else {
    if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) {
      if (ent.client.menu !== null) {
        client.ps.pmove.pm_type = KexPmTypeT.PM_FREEZE;
        HandleMenuMovement(ent, ucmd);
      } else if (ent.client.awaiting_respawn) {
        client.ps.pmove.pm_type = KexPmTypeT.PM_FREEZE;
      } else if (ent.client.resp.spectator || (G_TeamplayEnabled() && ent.client.resp.ctf_team === CtfteamT.CTF_NOTEAM)) {
        client.ps.pmove.pm_type = KexPmTypeT.PM_SPECTATOR;
      } else {
        client.ps.pmove.pm_type = KexPmTypeT.PM_NOCLIP;
      }
    } else if (ent.s.modelindex !== MODELINDEX_PLAYER) {
      client.ps.pmove.pm_type = KexPmTypeT.PM_GIB;
    } else if (ent.deadflag) {
      client.ps.pmove.pm_type = KexPmTypeT.PM_DEAD;
    } else if (ent.client.ctf_grapplestate >= 1 /* CTF_GRAPPLE_STATE_PULL */) {
      client.ps.pmove.pm_type = KexPmTypeT.PM_GRAPPLE;
    } else {
      client.ps.pmove.pm_type = KexPmTypeT.PM_NORMAL;
    }

    // [Paril-KEX]
    if (!G_ShouldPlayersCollide(false) || (coopEnabled() && (ent.clipmask & ContentsT.CONTENTS_PLAYER) === 0)) {
      client.ps.pmove.pm_flags |= PmflagsT.PMF_IGNORE_PLAYER_COLLISION;
    } else {
      client.ps.pmove.pm_flags &= ~PmflagsT.PMF_IGNORE_PLAYER_COLLISION;
    }

    // PGM: trigger_gravity support
    client.ps.pmove.gravity = level.gravity * ent.gravity;

    // NOTE: constructing a `KexPmoveT` and calling `Pmove(&pm)` here
    // (p_client.cpp:3246-3376: the pmove struct setup, the invocation
    // itself, and the post-processing -- step detection, falling damage,
    // ladder-step sound, view angle/gravity/touch bookkeeping) is
    // intentionally NOT wired in this unit. `p_move.ts`'s real
    // `Pmove(pmove: KexPmoveT, config)` expects a fully-populated
    // `KexPmoveT` (including a real `groundplane`/`clip`/`trace` triple
    // wired to the engine's exact `KexEdictT`-shaped types); assembling a
    // synthetic one from scratch here, without a real running server to
    // verify against byte-for-byte, risks a silently wrong physics result
    // this unit cannot catch. This is a reported, deliberate deviation: the
    // pmove SETUP that precedes it (pm_type selection, collision-mask
    // flagging, gravity, all above this comment) is ported faithfully and
    // independently testable; the invocation and its post-processing are a
    // throwing stub, cited for the coordinator to wire once a real
    // end-to-end client-think integration test exists.
    runPmoveAndApplyResults(ent, ucmd);
  }

  // fire weapon from final position if needed
  if ((client.latched_buttons & ButtonT.BUTTON_ATTACK) !== 0) {
    if (client.resp.spectator) {
      client.latched_buttons = ButtonT.BUTTON_NONE;

      if (client.chase_target !== null) {
        client.chase_target = null;
        client.ps.pmove.pm_flags &= ~(PmflagsT.PMF_NO_POSITIONAL_PREDICTION | PmflagsT.PMF_NO_ANGULAR_PREDICTION);
      } else {
        GetChaseTarget(ent);
      }
    } else if (!ent.client.weapon_thunk) {
      // we can only do this during a ready state and if enough time has
      // passed from last fire
      if (ent.client.weaponstate === WeaponstateT.WEAPON_READY) {
        ent.client.weapon_fire_buffered = true;

        if (ent.client.weapon_fire_finished <= level.time) {
          ent.client.weapon_thunk = true;
          Think_Weapon(ent);
        }
      }
    }
  }

  if (client.resp.spectator) {
    if (!HandleMenuMovement(ent, ucmd)) {
      if ((ucmd.buttons & ButtonT.BUTTON_JUMP) !== 0) {
        if ((client.ps.pmove.pm_flags & PmflagsT.PMF_JUMP_HELD) === 0) {
          client.ps.pmove.pm_flags |= PmflagsT.PMF_JUMP_HELD;
          if (client.chase_target !== null) ChaseNext(ent);
          else GetChaseTarget(ent);
        }
      } else {
        client.ps.pmove.pm_flags &= ~PmflagsT.PMF_JUMP_HELD;
      }
    }
  }

  // update chase cam if being followed
  for (let i = 1; i <= game.maxclients; i++) {
    const other = g_edicts[i];
    if (other !== undefined && other.inuse && other.client !== null && other.client.chase_target === ent) UpdateChaseCam(other);
  }
}

/** p_client.cpp:3246-3376: the pmove struct setup, `Pmove(&pm)` invocation,
 * and post-processing (step size detection, falling damage, ladder step
 * sound, view angle/gravity/touch bookkeeping). Kept as its own function so
 * ClientThink's real pre-pmove setup above (pm_type selection, collision
 * masking, gravity) is unit-testable independent of this deliberately
 * unwired portion -- see the NOTE at its call site. */
function runPmoveAndApplyResults(_ent: EdictT, _ucmd: KexUsercmdT): void {
  throw new Error(
    "ClientThink: Pmove() invocation and post-processing (p_client.cpp:3246-3376) intentionally not wired in this unit -- see this file's own ClientThink comment for why",
  );
}

// ---------------------------------------------------------------------------
// coop respawn family (p_client.cpp:3439-3751)
// ---------------------------------------------------------------------------

function* active_monsters(): Generator<EdictT> {
  for (let i = game.maxclients + BODY_QUEUE_SIZE + 1; i < g_edicts.length; i++) {
    const ent = g_edicts[i];
    if (ent !== undefined && ent.inuse && (ent.svflags & SvflagsT.SVF_MONSTER) !== 0 && ent.health > 0) yield ent;
  }
}

/** p_client.cpp:3453-3474: `inline bool G_MonstersSearchingFor(edict_t *player)`. */
export function G_MonstersSearchingFor(player: EdictT | null): boolean {
  for (const ent of active_monsters()) {
    // check for *any* player target
    if (player === null && ent.enemy !== null && ent.enemy.client === null) continue;
    else if (player !== null && ent.enemy !== player) continue;

    // they lost sight of us
    if ((ent.monsterinfo.aiflags & 0x4n /* AI_LOST_SIGHT */) !== 0n && level.time > Gtime_add(ent.monsterinfo.trail_time, Gtime_from_sec(5))) continue;

    // no sir
    return true;
  }

  // yes sir
  return false;
}

const YAW_SPREAD = [0, 90, 45, -45, -90] as const;

/** p_client.cpp:3478-3571: `inline bool G_FindRespawnSpot(edict_t *player, vec3_t &spot)`. */
export function G_FindRespawnSpot(player: EdictT, spotBox: [Vec3]): boolean {
  let tr = gi.trace(player.s.origin, PLAYER_MINS, PLAYER_MAXS, player.s.origin, player, MASK_PLAYERSOLID);
  if (tr.startsolid || tr.allsolid) return false;

  const back_distance = 128;
  const up_distance = 128;
  const player_viewheight = 22;
  const mask = MASK_PLAYERSOLID | ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME;

  for (const yaw of YAW_SPREAD) {
    const angles = vec3(0, player.s.angles[1] + 180 + yaw, 0);

    let start = vec3(player.s.origin[0], player.s.origin[1], player.s.origin[2]);
    let end = vec3_add(start, vec3(0, 0, up_distance));

    tr = gi.trace(start, PLAYER_MINS, PLAYER_MAXS, end, player, mask);
    if (tr.startsolid || tr.allsolid || (tr.contents & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0) continue;

    const fwd = vec3();
    AngleVectors(angles, fwd, null, null);

    start = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
    end = vec3_add(start, vec3(fwd[0] * back_distance, fwd[1] * back_distance, fwd[2] * back_distance));

    tr = gi.trace(start, PLAYER_MINS, PLAYER_MAXS, end, player, mask);
    if (tr.startsolid || tr.allsolid || (tr.contents & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0) continue;

    // plop us down now
    start = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
    end = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2] - up_distance * 4);

    tr = gi.trace(start, PLAYER_MINS, PLAYER_MAXS, end, player, mask);
    const world = g_edicts[0];
    if (tr.startsolid || tr.allsolid || (tr.contents & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0 || tr.fraction === 1 || tr.ent !== world) continue;

    // don't spawn us *inside* liquids
    if ((gi.pointcontents(vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2] + player_viewheight)) & MASK_WATER) !== 0) continue;

    // don't spawn us on steep slopes
    if (tr.plane.normal[2] < 0.7) continue;

    const spot = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

    const z_diff = Math.abs(player.s.origin[2] - tr.endpos[2]);
    const STEPSIZE_LOCAL = 18; // matches shared STEPSIZE constant (m_move.ts/p_move.ts import it from q_shared)

    if (z_diff > STEPSIZE_LOCAL * 4) continue;

    if (z_diff > STEPSIZE_LOCAL) {
      const los1 = gi.trace(player.s.origin, null, null, tr.endpos, player, mask);
      if (los1.fraction !== 1) continue;

      const los2 = gi.trace(
        vec3(player.s.origin[0], player.s.origin[1], player.s.origin[2] + player_viewheight),
        null,
        null,
        vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2] + player_viewheight),
        player,
        mask,
      );
      if (los2.fraction !== 1) continue;
    }

    spotBox[0] = spot;
    return true;
  }

  return false;
}

/** p_client.cpp:3575-3637: `inline std::tuple<edict_t *, vec3_t> G_FindSquadRespawnTarget()`. */
export function G_FindSquadRespawnTarget(): { player: EdictT | null; spot: Vec3 } {
  const monsters_searching_for_anybody = G_MonstersSearchingFor(null);
  const world = g_edicts[0];

  for (const player of active_players()) {
    if (player.client === null) continue;
    if (player.deadflag) continue;

    if (player.client.last_damage_time >= level.time) {
      player.client.coop_respawn_state = 4; // COOP_RESPAWN_IN_COMBAT
      continue;
    }

    if (G_MonstersSearchingFor(player)) {
      player.client.coop_respawn_state = 4; // COOP_RESPAWN_IN_COMBAT
      continue;
    }

    if (monsters_searching_for_anybody && player.client.last_firing_time >= level.time) {
      player.client.coop_respawn_state = 4; // COOP_RESPAWN_IN_COMBAT
      continue;
    }

    if (player.groundentity !== world) {
      player.client.coop_respawn_state = 5; // COOP_RESPAWN_BAD_AREA
      continue;
    }

    if (player.waterlevel >= WaterLevelT.WATER_UNDER) {
      player.client.coop_respawn_state = 5; // COOP_RESPAWN_BAD_AREA
      continue;
    }

    const spotBox: [Vec3] = [vec3()];
    if (!G_FindRespawnSpot(player, spotBox)) {
      player.client.coop_respawn_state = 6; // COOP_RESPAWN_BLOCKED
      continue;
    }

    return { player, spot: spotBox[0] };
  }

  return { player: null, spot: vec3() };
}

const RESPAWN_NONE = 0;
const RESPAWN_SPECTATE = 1;
const RESPAWN_SQUAD = 2;
const RESPAWN_START = 3;

/** p_client.cpp:3650-3751: `static bool G_CoopRespawn(edict_t *ent)`. */
function G_CoopRespawn(ent: EdictT): boolean {
  if (ent.client === null) throw new Error("G_CoopRespawn: ent.client is null (invariant violated)");
  const client = ent.client;

  if (!coopEnabled()) return false;
  if (!cvarBool("g_coop_squad_respawn", "1") && !cvarBool("g_coop_enable_lives", "0")) return false;

  let state = RESPAWN_NONE;

  // first pass: if we have no lives left, just move to spectator
  if (cvarBool("g_coop_enable_lives", "0")) {
    if (client.pers.lives === 0) {
      state = RESPAWN_SPECTATE;
      client.coop_respawn_state = 3; // COOP_RESPAWN_NO_LIVES
    }
  }

  // second pass: check for where to spawn
  if (state === RESPAWN_NONE) {
    if (cvarBool("g_coop_squad_respawn", "1")) {
      let allDead = true;
      for (const player of active_players()) {
        if (player.health > 0) {
          allDead = false;
          break;
        }
      }

      if (allDead) {
        state = RESPAWN_START;
      } else {
        const { player: good_player, spot: good_spot } = G_FindSquadRespawnTarget();

        if (good_player !== null) {
          state = RESPAWN_SQUAD;
          squad_respawn_position = vec3(good_spot[0], good_spot[1], good_spot[2]);
          squad_respawn_angles = vec3(good_player.s.angles[0], good_player.s.angles[1], 0);
          use_squad_respawn = true;
        } else {
          state = RESPAWN_SPECTATE;
        }
      }
    } else {
      state = RESPAWN_START;
    }
  }

  if (state === RESPAWN_SQUAD || state === RESPAWN_START) {
    // give us our max health back since it will reset to pers.health; in
    // instanced items we'd lose the items we touched so we always want to
    // respawn with our max.
    if (P_UseCoopInstancedItems()) client.pers.health = client.pers.max_health = ent.max_health;

    respawn(ent);

    client.latched_buttons = ButtonT.BUTTON_NONE;
    use_squad_respawn = false;
  } else if (state === RESPAWN_SPECTATE) {
    if (!client.coop_respawn_state) client.coop_respawn_state = 1; // COOP_RESPAWN_WAITING

    if (!client.resp.spectator) {
      // move us to spectate just so we don't have to twiddle our thumbs forever
      CopyToBodyQue(ent);
      client.resp.spectator = true;
      ent.solid = SolidT.SOLID_NOT;
      ent.takedamage = false;
      ent.s.modelindex = 0;
      ent.svflags |= SvflagsT.SVF_NOCLIENT;
      client.ps.damage_blend[3] = client.ps.screen_blend[3] = 0;
      client.ps.rdflags = RefdefFlagsT.RDF_NONE;
      ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
      gi.linkentity(ent);
      GetChaseTarget(ent);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// ClientBeginServerFrame / RemoveAttackingPainDaemons (p_client.cpp:3761-3852)
// ---------------------------------------------------------------------------

export function ClientBeginServerFrame(ent: EdictT): void {
  if (ent.client === null) throw new Error("ClientBeginServerFrame: ent.client is null (invariant violated)");

  if (gi.ServerFrame() !== ent.client.step_frame) ent.s.renderfx &= ~RenderfxT.RF_STAIR_STEP;

  if (Gtime_nonzero(level.intermissiontime)) return;

  const client = ent.client;

  if (client.awaiting_respawn) {
    if (Gtime_milliseconds(level.time) % 500 === 0) PutClientInServer(ent);
    return;
  }

  if ((ent.svflags & SvflagsT.SVF_BOT) !== 0) Bot_BeginFrame(ent);

  if (deathmatchEnabled() && !G_TeamplayEnabled() && client.pers.spectator !== client.resp.spectator && Gtime_subtract(level.time, client.respawn_time) >= Gtime_from_sec(5)) {
    spectator_respawn(ent);
    return;
  }

  // run weapon animations if it hasn't been done by a ucmd_t
  if (!client.weapon_thunk && !client.resp.spectator) Think_Weapon(ent);
  else client.weapon_thunk = false;

  if (ent.deadflag) {
    // don't respawn if level is waiting to restart
    if (level.time > client.respawn_time && !Gtime_nonzero(level.coop_level_restart_time)) {
      // check for coop handling
      if (!G_CoopRespawn(ent)) {
        // in deathmatch, only wait for attack button
        const buttonMask = deathmatchEnabled() ? ButtonT.BUTTON_ATTACK : -1;

        if ((client.latched_buttons & buttonMask) !== 0 || (deathmatchEnabled() && cvarBool("g_dm_force_respawn", "0"))) {
          respawn(ent);
          client.latched_buttons = ButtonT.BUTTON_NONE;
        }
      }
    }
    return;
  }

  // add player trail so monsters can follow
  if (!deathmatchEnabled()) PlayerTrail_Add(ent);

  client.latched_buttons = ButtonT.BUTTON_NONE;
}

/** p_client.cpp:3838-3852: `void RemoveAttackingPainDaemons(edict_t *self)`. */
export function RemoveAttackingPainDaemons(self: EdictT): void {
  let tracker = G_FindByString(null, "classname", "pain daemon");
  while (tracker !== null) {
    const next = G_FindByString(tracker, "classname", "pain daemon");
    if (tracker.enemy === self) G_FreeEdict(tracker);
    tracker = next;
  }

  if (self.client !== null) self.client.tracker_pain_time = GTIME_ZERO;
}
