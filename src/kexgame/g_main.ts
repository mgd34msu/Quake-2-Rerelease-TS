// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_main.c -- the module spine (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/g_main.cpp (1,054
// lines, C++17): the whole `g_*`/`sv_*`/`ai_*`/`bot_debug_*` cvar
// registration block, PreInitGame, InitGame, ShutdownGame, GetGameAPI,
// ClientEndServerFrames, CreateTargetChangeLevel, EndDMLevel, CheckNeedPass,
// CheckDMRules, ExitLevel, G_CheckCvars, G_RunFrame_/G_RunFrame, G_PrepFrame,
// and G_GetExtension. Behavioral code, ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/g_utils.ts headers).
//
// ============================================================================
// GetGameAPI wiring -- SetGameImports/SetGameExports (g_main_globals.ts)
// ============================================================================
// g_main_globals.ts's own header documents the exact expectation this file
// fulfills: "gi, globals, g_edicts are bare `export let` globals ... assigned
// via SetGameImports/SetGameExports/SetGEdicts from GetGameAPI/InitGame."
// `GetGameAPI` calls `SetGameImports(imports)` as its literal first
// statement (matching C's `gi = *import;`, the first line of the real
// function), then builds the full `KexGameExports` object and calls
// `SetGameExports(exportsTable)` immediately once it exists -- the earliest
// point analogous to C's `return &globals;` returning the same struct every
// other function in this file mutates by reference (`globals.num_edicts =
// ...` inside `InitGame`, `globals.server_flags &= ...` inside
// `G_PrepFrame`) -- because `globals` (the g_main_globals.ts singleton) and
// `exportsTable` are, from that call forward, literally the same object.
//
// ============================================================================
// KexEdictT <-> EdictT recovery -- PORTING.md's EDICT_NUM idiom, never a cast
// ============================================================================
// Every exported function slot in `KexGameExports` types its edict
// parameters as the short, engine-facing `KexEdictT | null` (game.ts's own
// convention: "Names with no pre-existing counterpart... keep short/
// server-visible shape"). This file's own game logic needs the full,
// game-private `EdictT` (`EdictT extends KexEdictT`, g_local_types.ts:1161).
// PORTING.md's precedent for the identical problem in the legacy/vanilla
// port line is explicit: "game code recovers its full `EdictT` with the C
// idiom `g_edicts[ent.s.number]` (EDICT_NUM), never a cast" -- the exact
// technique g_phys.ts's own `traceEdict` helper already uses for the same
// reason. `resolveEdict` below is that idiom, applied at every GetGameAPI
// export-slot boundary. A `null` input throws (mirroring the real C++
// call sites, which dereference every one of these pointers unconditionally
// with no null guard of their own).
//
// ============================================================================
// SpawnEntities / WriteGameJson / ReadGameJson / WriteLevelJson /
// ReadLevelJson / CanSave -- throwing stubs (no g_spawn.ts/g_save.ts yet)
// ============================================================================
// Per this unit's brief: these six slots are being ported by concurrent
// agents (g_spawn.ts / g_save.ts) and this file must not create those two
// modules. Confirmed by directory listing: neither file exists yet. Every
// slot throws a cited "not yet ported" error naming its real future home.
//
// ============================================================================
// Bot_SetWeapon / Bot_TriggerEdict / Bot_UseItem / Bot_GetItemID /
// Bot_PickedUpItem / Edict_ForceLookAtPoint -- throwing stubs (bots/ subsystem)
// ============================================================================
// These six `KexGameExports` slots are implemented in the real DLL's
// `bots/` directory (bot_commands.cpp et al.), a subsystem with no
// src/kexgame/ port anywhere in this codebase (confirmed by directory
// listing -- no bot_*.ts file exists). Cited throwing stubs, matching this
// port line's established treatment of the equally-unported CTF subsystem
// (g_cmds.ts's own header: "not yet ported anywhere in this port line...
// reported as a real, standing gap").
//
// ============================================================================
// Entity_UpdateState family -- REAL port, despite living in bots/bot_utils.cpp
// ============================================================================
// `Entity_UpdateState`/`Player_UpdateState`/`Monster_UpdateState`/
// `Item_UpdateState`/`Trap_UpdateState`/`Edict_UpdateState` are, by C++ file
// location, ALSO part of the unported `bots/` subsystem (bots/bot_utils.cpp)
// -- but unlike the six slots above, `Entity_UpdateState` is called
// UNCONDITIONALLY, once per in-use entity, every server frame, directly from
// `G_RunFrame_` (g_main.cpp:940) -- a call site squarely inside this unit's
// explicit scope. A throwing stub here would make `G_RunFrame` throw on
// frame one for literally any populated `g_edicts` slot (including the
// world entity itself), which is not a defensible "honest gap" the way an
// unreachable-by-default CTF command is -- it would make the very function
// this unit is chartered to port untestable. Every field these five
// functions touch (`sv.*` on `SvEntityT`, `SVFL_*` on `SvEntFlagsT`,
// `KexPlayerSkinnumT`'s packed `skinnum`) was already fully typed by earlier
// units specifically for this purpose (confirmed: `SvEntFlagsT`/`SVFL_*` in
// kexapi/game.ts, `armor_info`/`inventory`/every other `SvEntityT` field in
// g_main_globals.ts's `defaultSvEntity()`), so this file ports the real
// bodies rather than stubbing them. Their only observable effect is
// populating `edict.sv.*` -- read exclusively by the (still entirely
// unported) bot subsystem itself, so this is inert bookkeeping from the
// perspective of every other landed kexgame module, but it is real,
// faithful bookkeeping, not a placeholder.
//
// ============================================================================
// CTF / teamplay / gamerules(DMGame) -- concrete faithful values, not stubs
// ============================================================================
// Matching g_combat.ts's/p_client.ts's own established "concrete faithful
// value, not a stub" precedent: `ctf`/`teamplay`/`gamerules` are registered
// and read as real cvars defaulting to `"0"`, exactly like every other
// landed module already does. `CTFInit()` (ctf/g_ctf.cpp) itself is not
// ported (it only registers CTF-specific cvars/commands, all irrelevant
// while `ctf` stays at its registered default); `CTFCheckRules`/
// `CTFInMatch`/`CheckEndTDMLevel`/`CTFNextMap`/`DMGame.CheckDMRules`/
// `InitGameRules` are each cited at their real call site, reached only
// behind a real, concretely-false-by-default guard (`ctf->integer`,
// `teamplay->integer`, `gamerules->integer`) -- unreachable today, not
// silently skipped.
//
// ============================================================================
// Cvar_WasModified -- CvarT has no `modified_count` (documented type gap)
// ============================================================================
// game.ts's own file header already documents this port's `CvarT` (reused
// from q_shared.ts) lacking the kex `cvar_t`'s `modified_count: int32_t`
// field (a boolean `modified` flag stands in its place; "fixing this
// mismatch means editing q_shared.ts, which is out of scope here... a phase
// 2 job"). `Cvar_WasModified(cvar, modified_count)` compares the cvar's
// change-counter against a caller-owned shadow value and updates the shadow
// on a mismatch -- this file reproduces the same OBSERVABLE effect (detect
// "did this setting actually change since I last looked") by shadowing the
// cvar's own numeric/string VALUE instead of a counter that does not exist
// in this port's `CvarT`: `G_CheckCvars` shadows `sv_airaccelerate`/
// `sv_gravity`'s numeric `.value` in `game.airacceleration_modified`/
// `game.gravity_modified` (the exact fields C's own `game_locals_t` already
// carries for this purpose, g_local.h:1143); `CheckNeedPass` shadows
// `password`/`spectator_password`'s `.string` in two module-local trackers.
// Both detect a real change; only the mechanism (value-shadow vs.
// counter-shadow) differs, an honest consequence of the underlying type gap.
//
// ============================================================================
// pm_config -- module-local mutable object, not a cast-through global
// ============================================================================
// bg_local.ts's own header documents `pm_config` as deliberately NOT a
// mutable module-global in this port line (`Pmove()` takes it as an explicit
// parameter instead, mirroring the trace-function seam). Since
// `KexGameExports.Pmove(pmove)` has no `config` parameter of its own, this
// file -- the natural owner of "the state g_main's init code assigns a cvar
// into" per that same header note -- keeps a small local mutable `pmConfig:
// PmConfigT`, updated by `G_CheckCvars` (the same function that updates it
// in the real C++) and threaded through the `Pmove` export wrapper.
// `n64_physics` has no live call site in this port yet (only ever set by
// `g_spawn.cpp`'s `SpawnEntities`/`SP_worldspawn`, both pending g_spawn.ts)
// and stays at `PM_CONFIG_DEFAULT`'s `false` until that unit lands.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `mt_rand.seed(...)` (C++ Mersenne Twister RNG seeding): this port's RNG
//   (`irandom`/`frandom`, q_std.ts) owns its own source; there is no
//   equivalent seed-injection point, and none is needed -- omitted.
// - `InitSave()` (g_save.cpp, pending): its real body wires up the
//   `save_data_list_t` registry; this port's equivalent
//   (g_save_registry.ts) is populated by each behavior module's own
//   top-level `RegisterX(...)` calls at import time, not through an
//   explicit init call -- omitted as a documented no-op, not a stub.
// - `sv_cheats`'s `#if defined(_DEBUG) "1" #else "0" #endif` default: this
//   port has no build-time debug/release distinction, so the release-path
//   default (`"0"`) is used unconditionally, matching this codebase's
//   established `#ifdef _DEBUG` omission convention (g_utils.ts's header).
// - `game = {};` / `game.level_entries = {};` (C++ struct-literal resets):
//   `game`/`level.level_entries` cannot be reassigned (the imported `game`
//   binding is `const`, per g_main_globals.ts's "eager singleton" design;
//   `level_entries` is itself a fixed-length array field). Ported as
//   `resetGameLocals()`/`resetLevelEntries()`, which mutate every field to
//   its zero value in place, preserving identity exactly like `G_FreeEdict`'s
//   own `Object.assign`-based memset already does for `EdictT` -- see
//   g_main_globals.ts's file header for the precedent.
// - `TagMalloc`-backed allocations (`g_edicts`, `game.clients`,
//   `game.lag_origins`) become plain `Array.from({length}, factory)` calls;
//   `gi.FreeTags(...)` in `ShutdownGame` has nothing to free under this
//   scheme (PORTING.md: "Z_Malloc/Z_Free/Hunk_*/Z_TagMalloc -> plain
//   allocation"; g_local.ts's own identical `TAG_GAME`/`TAG_LEVEL`-dropped
//   note) -- `ShutdownGame` ports only the real, observable `Com_Print` log
//   line.
// - `str_split`/`join_strings`/`COM_ParseEx(&str, " ")` (EndDMLevel's
//   space-delimited map-list tokenizer): ported as a plain
//   `.split(/\s+/).filter(Boolean)` / `.join(" ")`, matching g_misc.ts's/
//   p_client.ts's own established "COM_ParseEx with a single delimiter ->
//   plain split" substitution precedent.
// - `std::shuffle(..., mt_rand)` (EndDMLevel's map-list reshuffle): ported as
//   a plain in-place Fisher-Yates using this port's own `irandom()` (see the
//   `mt_rand` note above) -- a different RNG source, not a different
//   shuffle algorithm; both produce a uniform random permutation.
// - `defaultGClient` (p_client.ts): was file-local; exported (one-line,
//   non-behavioral change) so `InitGame` can populate `game.clients` with
//   real, interface-satisfying objects instead of a second, divergence-prone
//   copy of `GClientT`'s zero shape. Flagged explicitly in this unit's report.
// - `player_skinnum_t`'s packed `team_index` nibble (`Player_UpdateState`/
//   `Trap_UpdateState`): unpacked via explicit shift/mask
//   (`(skinnum >>> 24) & 0x0f`), matching PORTING.md's "portable
//   little-endian C path" convention (g_svcmds.ts's identical
//   `StringToFilter` precedent) rather than a byte-array reinterpretation.

import { vec3, type Vec3 } from "../shared/math";
import {
  type KexGameExports,
  type KexGameImports,
  type KexEdictT,
  type KexUsercmdT,
  type KexPmoveT,
  type ShadowLightDataT,
  type Vec4,
  PrintTypeT,
  CvarFlagsT,
  ServerFlagsT,
  GAME_API_VERSION,
  MAX_SPLIT_PLAYERS,
  MAX_EDICTS,
  MAX_NETNAME,
  MAX_QPATH,
  CS_AIRACCEL,
  CS_PLAYERSKINS,
  RenderfxT,
  SvflagsT,
  SolidT,
  PmflagsT,
  SvEntFlagsT,
} from "../kexapi/game";
import {
  type EdictT,
  type GameLocalsT,
  type LevelEntryT,
  EntFlagsT,
  MonsterAiFlagsT,
  MovetypeT,
  CoopRespawnT,
  AnimPriorityT,
  GAMEVERSION,
  BODY_QUEUE_SIZE,
  MAX_LEVELS_PER_UNIT,
  bodyarmor_info,
  combatarmor_info,
  jacketarmor_info,
} from "./g_local";
import { gi, globals, g_edicts, game, level, SetGameImports, SetGameExports, SetGEdicts, defaultEdict } from "./g_main_globals";
import { GTIME_ZERO, type GTime, Gtime_add, Gtime_subtract, Gtime_from_ms, Gtime_from_sec, Gtime_from_min, Gtime_seconds } from "./gtime";
import { clamp, Q_strcasecmp, Q_strncasecmp, Q_strlcpy } from "./q_std";
import { G_Spawn, G_FindByString } from "./g_utils";
import { G_GetClipMask, G_RunEntity } from "./g_phys";
import { M_CheckGround, M_ProcessPain } from "./g_monster";
import { ClientEndServerFrame } from "./p_view";
import { BeginIntermission, G_ReportMatchDetails } from "./p_hud";
import {
  ClientBegin,
  ClientUserinfoChanged,
  ClientChooseSlot,
  ClientConnect,
  ClientDisconnect,
  ClientThink,
  ClientBeginServerFrame,
  P_GetLobbyUserNum,
  defaultGClient,
  defaultClientPersistant,
} from "./p_client";
import { ClientCommand } from "./g_cmds";
import { ServerCommand } from "./g_svcmds";
import { Entity_IsVisibleToPlayer, InitItems } from "./g_items";
import { ArmorIndex } from "./g_combat";
import { GetShadowLightData } from "./g_misc";
import { Pmove } from "./p_move";
import { type PmConfigT, PM_CONFIG_DEFAULT } from "./bg_local";
import { FRAME_flip12, FRAME_salute11, FRAME_taunt17, FRAME_wave11, FRAME_point12 } from "./m_player";
import { irandom } from "./q_std";

// ---------------------------------------------------------------------------
// small local helpers -- duplicated per-file, see other landed modules'
// identical established precedent (g_func.ts/g_phys.ts headers)
// ---------------------------------------------------------------------------

function mustCvar(name: string, def: string, flags: CvarFlagsT): import("../shared/q_shared").CvarT {
  const c = gi.cvar(name, def, flags);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
}

function cvarTrue(c: import("../shared/q_shared").CvarT): boolean {
  return Math.trunc(c.value) !== 0;
}

function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

/** PORTING.md's EDICT_NUM idiom -- see file header. Throws on a null input
 *  or an out-of-range index, matching the real C++ call sites' unconditional
 *  pointer dereference (no null/bounds guard of their own). */
function resolveEdict(ent: KexEdictT, ctx: string): EdictT {
  const real = g_edicts[ent.s.number];
  if (real === undefined) throw new Error(`${ctx}: no g_edicts slot at index ${ent.s.number}`);
  return real;
}

function mustResolveEdict(ent: KexEdictT | null, ctx: string): EdictT {
  if (ent === null) throw new Error(`${ctx}: called with a null edict -- the C++ source dereferences it unconditionally here`);
  return resolveEdict(ent, ctx);
}

// ---------------------------------------------------------------------------
// cvar registration -- module-scope `let`s mirroring g_main.cpp's file-scope
// `cvar_t *x;` globals. Only cvars this file's own functions read again
// later are stored; every other cvar is registered via a bare `gi.cvar(...)`
// call (still a real registration with the exact C++ name/default/flags --
// see file header). Definite-assignment (`!`) matches the real C pointer's
// own "undefined until PreInitGame/InitGame runs" lifetime.
// ---------------------------------------------------------------------------

let deathmatch!: import("../shared/q_shared").CvarT;
let coop!: import("../shared/q_shared").CvarT;
let teamplay!: import("../shared/q_shared").CvarT;
let maxclients!: import("../shared/q_shared").CvarT;
let maxentities!: import("../shared/q_shared").CvarT;
let gamerules!: import("../shared/q_shared").CvarT;
let fraglimit!: import("../shared/q_shared").CvarT;
let timelimit!: import("../shared/q_shared").CvarT;
let password!: import("../shared/q_shared").CvarT;
let spectator_password!: import("../shared/q_shared").CvarT;
let g_dm_same_level!: import("../shared/q_shared").CvarT;
let g_map_list!: import("../shared/q_shared").CvarT;
let g_map_list_shuffle!: import("../shared/q_shared").CvarT;
let sv_airaccelerate!: import("../shared/q_shared").CvarT;
let sv_gravity!: import("../shared/q_shared").CvarT;
let g_coop_enable_lives!: import("../shared/q_shared").CvarT;
let g_coop_squad_respawn!: import("../shared/q_shared").CvarT;
let g_coop_num_lives!: import("../shared/q_shared").CvarT;
let g_frames_per_frame!: import("../shared/q_shared").CvarT;

/** `pm_config` -- see file header. */
let pmConfig: PmConfigT = { ...PM_CONFIG_DEFAULT };

/** `CheckNeedPass`'s `Cvar_WasModified` shadow trackers -- see file header. */
let lastPasswordString: string | null = null;
let lastSpectatorPasswordString: string | null = null;

// ---------------------------------------------------------------------------
// PreInitGame (g_main.cpp:169-208)
// ---------------------------------------------------------------------------

/** g_main.cpp:169-208: `void PreInitGame()`. */
export function PreInitGame(): void {
  maxclients = mustCvar("maxclients", `${MAX_SPLIT_PLAYERS}`, CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);
  deathmatch = mustCvar("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
  coop = mustCvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  teamplay = mustCvar("teamplay", "0", CvarFlagsT.CVAR_LATCH);

  // ZOID: CTFInit() -- not yet ported (pending g_ctf.ts, see
  // ctf/g_ctf.cpp). See file header's "CTF / teamplay / gamerules" note.
  const ctf = mustCvar("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);

  // ZOID: this gamemode only supports deathmatch
  if (cvarTrue(ctf)) {
    if (!cvarTrue(deathmatch)) {
      gi.Com_Print("Forcing deathmatch.\n");
      gi.cvar_set("deathmatch", "1");
    }
    // force coop off
    if (cvarTrue(coop)) gi.cvar_set("coop", "0");
    // force tdm off
    if (cvarTrue(teamplay)) gi.cvar_set("teamplay", "0");
  }
  if (cvarTrue(teamplay)) {
    if (!cvarTrue(deathmatch)) {
      gi.Com_Print("Forcing deathmatch.\n");
      gi.cvar_set("deathmatch", "1");
    }
    // force coop off
    if (cvarTrue(coop)) gi.cvar_set("coop", "0");
  }
  // ZOID
}

// ---------------------------------------------------------------------------
// InitGame (g_main.cpp:217-381)
// ---------------------------------------------------------------------------

function defaultLevelEntry(): LevelEntryT {
  return { map_name: "", pretty_name: "", total_secrets: 0, found_secrets: 0, total_monsters: 0, killed_monsters: 0, time: GTIME_ZERO, visit_order: 0 };
}

/** `game = {};` -- see file header's "DEVIATIONS" note. */
function resetGameLocals(g: GameLocalsT): void {
  g.helpmessage1 = "";
  g.helpmessage2 = "";
  g.help1changed = 0;
  g.help2changed = 0;
  g.clients = [];
  g.spawnpoint = "";
  g.maxclients = 0;
  g.maxentities = 0;
  g.cross_level_flags = 0;
  g.cross_unit_flags = 0;
  g.autosaved = false;
  g.airacceleration_modified = 0;
  g.gravity_modified = 0;
  g.level_entries = Array.from({ length: MAX_LEVELS_PER_UNIT }, defaultLevelEntry);
  g.max_lag_origins = 0;
  g.lag_origins = null;
}

/** g_main.cpp:217-381: `void InitGame()`. */
export function InitGame(): void {
  gi.Com_Print("==== InitGame ====\n");

  // InitSave() / mt_rand.seed(...) -- see file header's "DEVIATIONS" note.

  void gi.cvar("gun_x", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("gun_y", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("gun_z", "0", CvarFlagsT.CVAR_NOFLAGS);

  // FIXME: sv_ prefix is wrong for these
  void gi.cvar("sv_rollspeed", "200", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("sv_rollangle", "2", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("sv_maxvelocity", "2000", CvarFlagsT.CVAR_NOFLAGS);
  sv_gravity = mustCvar("sv_gravity", "800", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_skipViewModifiers", "0", CvarFlagsT.CVAR_NOSET);

  void gi.cvar("sv_stopspeed", "100", CvarFlagsT.CVAR_NOFLAGS); // PGM - was #define in g_phys.c

  // ROGUE
  void gi.cvar("huntercam", "1", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);
  void gi.cvar("g_dm_strong_mines", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_random_items", "0", CvarFlagsT.CVAR_NOFLAGS);
  // ROGUE

  // [Kex] Instagib
  void gi.cvar("g_instagib", "0", CvarFlagsT.CVAR_NOFLAGS);

  // [Paril-KEX]
  void gi.cvar("g_coop_player_collision", "0", CvarFlagsT.CVAR_LATCH);
  g_coop_squad_respawn = mustCvar("g_coop_squad_respawn", "1", CvarFlagsT.CVAR_LATCH);
  g_coop_enable_lives = mustCvar("g_coop_enable_lives", "0", CvarFlagsT.CVAR_LATCH);
  g_coop_num_lives = mustCvar("g_coop_num_lives", "2", CvarFlagsT.CVAR_LATCH);
  void gi.cvar("g_coop_instanced_items", "1", CvarFlagsT.CVAR_LATCH);
  void gi.cvar("g_allow_grapple", "auto", CvarFlagsT.CVAR_NOFLAGS);
  // ctf/g_ctf.h: CTF_DEFAULT_GRAPPLE_SPEED / CTF_DEFAULT_GRAPPLE_PULL_SPEED
  // (both 650) -- not ported (ctf/g_ctf.h has no src/kexgame/ home yet);
  // literal defaults reproduced here, cited.
  void gi.cvar("g_grapple_fly_speed", "650", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_grapple_pull_speed", "650", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_grapple_damage", "10", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_debug_monster_paths", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_debug_monster_kills", "0", CvarFlagsT.CVAR_LATCH);

  void gi.cvar("bot_debug_follow_actor", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("bot_debug_move_to_point", "0", CvarFlagsT.CVAR_NOFLAGS);

  // noset vars
  void gi.cvar("dedicated", "0", CvarFlagsT.CVAR_NOSET);

  // latched vars -- see file header's sv_cheats deviation note
  void gi.cvar("cheats", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);
  void gi.cvar("gamename", GAMEVERSION, CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);

  void gi.cvar("maxspectators", "4", CvarFlagsT.CVAR_SERVERINFO);
  void gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
  maxentities = mustCvar("maxentities", `${MAX_EDICTS}`, CvarFlagsT.CVAR_LATCH);
  gamerules = mustCvar("gamerules", "0", CvarFlagsT.CVAR_LATCH); // PGM

  // change anytime vars
  fraglimit = mustCvar("fraglimit", "0", CvarFlagsT.CVAR_SERVERINFO);
  timelimit = mustCvar("timelimit", "0", CvarFlagsT.CVAR_SERVERINFO);
  // ZOID
  void gi.cvar("capturelimit", "0", CvarFlagsT.CVAR_SERVERINFO);
  void gi.cvar("g_quick_weapon_switch", "1", CvarFlagsT.CVAR_LATCH);
  void gi.cvar("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_LATCH);
  // ZOID
  password = mustCvar("password", "", CvarFlagsT.CVAR_USERINFO);
  spectator_password = mustCvar("spectator_password", "", CvarFlagsT.CVAR_USERINFO);
  void gi.cvar("needpass", "0", CvarFlagsT.CVAR_SERVERINFO);
  void gi.cvar("filterban", "1", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_select_empty", "0", CvarFlagsT.CVAR_ARCHIVE);

  void gi.cvar("run_pitch", "0.002", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("run_roll", "0.005", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("bob_up", "0.005", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("bob_pitch", "0.002", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("bob_roll", "0.002", CvarFlagsT.CVAR_NOFLAGS);

  // flood control
  void gi.cvar("flood_msgs", "4", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("flood_persecond", "4", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("flood_waitdelay", "10", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_strict_saves", "1", CvarFlagsT.CVAR_NOFLAGS);

  sv_airaccelerate = mustCvar("sv_airaccelerate", "0", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_damage_scale", "1", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_disable_player_collision", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("ai_damage_scale", "1", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("ai_model_scale", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("ai_allow_dm_spawn", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("ai_movement_disabled", "0", CvarFlagsT.CVAR_NOFLAGS);

  g_frames_per_frame = mustCvar("g_frames_per_frame", "1", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_coop_health_scaling", "0", CvarFlagsT.CVAR_LATCH);
  void gi.cvar("g_weapon_respawn_time", "30", CvarFlagsT.CVAR_NOFLAGS);

  // dm "flags"
  void gi.cvar("g_no_health", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_no_items", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_no_fall_damage", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_instant_items", "1", CvarFlagsT.CVAR_NOFLAGS);
  g_dm_same_level = mustCvar("g_dm_same_level", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_friendly_fire", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_force_respawn", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_force_respawn_time", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_spawn_farthest", "1", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_no_armor", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_allow_exit", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_infinite_ammo", "0", CvarFlagsT.CVAR_LATCH);
  void gi.cvar("g_dm_no_quad_drop", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_no_quadfire_drop", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_no_mines", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_dm_no_stack_double", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_no_nukes", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_no_spheres", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_teamplay_force_join", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_teamplay_armor_protect", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_allow_techs", "auto", CvarFlagsT.CVAR_NOFLAGS);

  void gi.cvar("g_start_items", "", CvarFlagsT.CVAR_LATCH);
  g_map_list = mustCvar("g_map_list", "", CvarFlagsT.CVAR_NOFLAGS);
  g_map_list_shuffle = mustCvar("g_map_list_shuffle", "0", CvarFlagsT.CVAR_NOFLAGS);
  void gi.cvar("g_lag_compensation", "1", CvarFlagsT.CVAR_NOFLAGS);

  // items
  InitItems();

  resetGameLocals(game);

  // initialize all entities for this game
  game.maxentities = Math.trunc(maxentities.value);
  SetGEdicts(Array.from({ length: game.maxentities }, () => defaultEdict()));
  globals.edicts = g_edicts;
  globals.max_edicts = game.maxentities;

  // initialize all clients for this game
  game.maxclients = Math.trunc(maxclients.value);
  game.clients = Array.from({ length: game.maxclients }, () => defaultGClient());
  globals.num_edicts = game.maxclients + 1;

  //======
  // ROGUE
  if (cvarTrue(gamerules)) InitGameRules(); // if there are game rules to set up, do so now.
  // ROGUE
  //======

  // how far back we should support lag origins for
  game.max_lag_origins = Math.trunc(20 * (0.1 / gi.frame_time_s));
  game.lag_origins = Array.from({ length: game.maxclients * game.max_lag_origins }, () => vec3());
}

/** ROGUE `InitGameRules()` (rogue/g_rogue_*.cpp) -- rogue mission-pack, not
 *  ported (excluded content dir). Reached only when `gamerules` is nonzero,
 *  a real, concretely-false-by-default guard (see file header). */
function InitGameRules(): void {
  throw new Error("InitGameRules: not yet ported (ROGUE mission pack, no src/kexgame/ home); reached only when gamerules is nonzero (default 0)");
}

// ---------------------------------------------------------------------------
// ShutdownGame (g_main.cpp:385-391)
// ---------------------------------------------------------------------------

/** g_main.cpp:385-391: `void ShutdownGame()`. See file header's TagMalloc deviation note. */
export function ShutdownGame(): void {
  gi.Com_Print("==== ShutdownGame ====\n");
}

// ---------------------------------------------------------------------------
// G_GetExtension (g_main.cpp:393-396)
// ---------------------------------------------------------------------------

function G_GetExtension(_name: string): unknown {
  return null;
}

// ---------------------------------------------------------------------------
// Entity_UpdateState family (bots/bot_utils.cpp) -- see file header
// ---------------------------------------------------------------------------

/** game.h:1363-1374 `union player_skinnum_t` -- little-endian unpack of just
 *  the `team_index` nibble (the only field this family reads). See file
 *  header's DEVIATIONS note. */
function unpackTeamIndex(skinnum: number): number {
  const byte3 = (skinnum >>> 24) & 0xff;
  return byte3 & 0x0f;
}

const Team_Coop_Monster = 0;
const Team_None = 0;
const Item_UnknownRespawnTime = 2147483647;

/** bots/bot_utils.cpp:15-165: `void Player_UpdateState(edict_t *player)`. */
function Player_UpdateState(player: EdictT): void {
  if (player.client === null) throw new Error("Player_UpdateState: player.client is null -- the C++ source dereferences it unconditionally here");
  const client = player.client;
  const persistant = client.pers;

  let ent_flags = SvEntFlagsT.SVFL_NONE;
  if (player.groundentity !== null || (player.flags & EntFlagsT.FL_PARTIALGROUND) !== 0n) {
    ent_flags |= SvEntFlagsT.SVFL_ONGROUND;
  } else {
    if (client.ps.pmove.pm_flags & PmflagsT.PMF_JUMP_HELD) ent_flags |= SvEntFlagsT.SVFL_IS_JUMPING;
  }

  if (client.ps.pmove.pm_flags & PmflagsT.PMF_ON_LADDER) ent_flags |= SvEntFlagsT.SVFL_ON_LADDER;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) ent_flags |= SvEntFlagsT.SVFL_IS_CROUCHING;

  if (client.quad_time > level.time || client.quadfire_time > level.time || client.double_time > level.time) {
    ent_flags |= SvEntFlagsT.SVFL_HAS_DMG_BOOST;
  }
  if (client.invincible_time > level.time) ent_flags |= SvEntFlagsT.SVFL_HAS_PROTECTION;
  if (client.invisible_time > level.time) ent_flags |= SvEntFlagsT.SVFL_HAS_INVISIBILITY;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_TIME_TELEPORT) !== 0) ent_flags |= SvEntFlagsT.SVFL_HAS_TELEPORTED;

  if (player.takedamage) ent_flags |= SvEntFlagsT.SVFL_TAKES_DAMAGE;
  if (player.solid === SolidT.SOLID_NOT) ent_flags |= SvEntFlagsT.SVFL_IS_HIDDEN;
  if ((player.flags & EntFlagsT.FL_INWATER) !== 0n && player.waterlevel >= 2 /* WATER_WAIST */) ent_flags |= SvEntFlagsT.SVFL_IN_WATER;
  if ((player.flags & EntFlagsT.FL_NOTARGET) !== 0n) ent_flags |= SvEntFlagsT.SVFL_NO_TARGET;
  if ((player.flags & EntFlagsT.FL_GODMODE) !== 0n) ent_flags |= SvEntFlagsT.SVFL_GOD_MODE;
  if (player.movetype === MovetypeT.MOVETYPE_NOCLIP) ent_flags |= SvEntFlagsT.SVFL_IS_NOCLIP;

  if (client.anim_end === FRAME_flip12) ent_flags |= SvEntFlagsT.SVFL_IS_FLIPPING_OFF;
  if (client.anim_end === FRAME_salute11) ent_flags |= SvEntFlagsT.SVFL_IS_SALUTING;
  if (client.anim_end === FRAME_taunt17) ent_flags |= SvEntFlagsT.SVFL_IS_TAUNTING;
  if (client.anim_end === FRAME_wave11) ent_flags |= SvEntFlagsT.SVFL_IS_WAVING;
  if (client.anim_end === FRAME_point12) ent_flags |= SvEntFlagsT.SVFL_IS_POINTING;

  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) === 0 && client.anim_priority <= AnimPriorityT.ANIM_WAVE) ent_flags |= SvEntFlagsT.SVFL_CAN_GESTURE;

  if (player.lastMOD.id === 26 /* MOD_TELEFRAG */ || player.lastMOD.id === 27 /* MOD_TELEFRAG_SPAWN */) ent_flags |= SvEntFlagsT.SVFL_WAS_TELEFRAGGED;
  if (client.resp.spectator) ent_flags |= SvEntFlagsT.SVFL_IS_SPECTATOR;

  player.sv.ent_flags = ent_flags;

  player.sv.team = unpackTeamIndex(player.s.skinnum);
  player.sv.buttons = client.buttons;

  const armorType = ArmorIndex(player);
  player.sv.armor_type = armorType;
  player.sv.armor_value = persistant.inventory[armorType] ?? 0;

  player.sv.health = !player.deadflag ? player.health : -1;
  player.sv.weapon = persistant.weapon !== null ? persistant.weapon.id : 0 /* IT_NULL */;

  player.sv.last_attackertime = Gtime_milliseconds_safe(client.last_attacker_time);
  player.sv.respawntime = Gtime_milliseconds_safe(client.respawn_time);
  player.sv.waterlevel = player.waterlevel;
  player.sv.viewheight = player.viewheight;

  player.sv.viewangles = vec3(client.v_angle[0], client.v_angle[1], client.v_angle[2]);
  player.sv.viewforward = vec3(client.v_forward[0], client.v_forward[1], client.v_forward[2]);
  player.sv.velocity = vec3(player.velocity[0], player.velocity[1], player.velocity[2]);

  player.sv.ground_entity = player.groundentity;
  player.sv.enemy = player.enemy;

  player.sv.inventory.set(persistant.inventory);

  if (!player.sv.init) {
    player.sv.init = true;
    player.sv.classname = player.classname;
    player.sv.targetname = player.targetname;
    player.sv.lobby_usernum = P_GetLobbyUserNum(player);
    player.sv.starting_health = player.health;
    player.sv.max_health = player.max_health;

    player.sv.armor_info[0] = { item_id: 0 /* IT_ARMOR_BODY placeholder id, see below */, max_count: bodyarmor_info.max_count };
    player.sv.armor_info[1] = { item_id: 0 /* IT_ARMOR_COMBAT */, max_count: combatarmor_info.max_count };
    player.sv.armor_info[2] = { item_id: 0 /* IT_ARMOR_JACKET */, max_count: jacketarmor_info.max_count };

    const netnameBox: [string] = [""];
    gi.Info_ValueForKey(client.pers.userinfo, "name", netnameBox, MAX_NETNAME);
    player.sv.netname = netnameBox[0];

    gi.Bot_RegisterEdict(player);
  }
}

/** bots/bot_utils.cpp:172-222: `void Monster_UpdateState(edict_t *monster)`. */
function Monster_UpdateState(monster: EdictT): void {
  let ent_flags = SvEntFlagsT.SVFL_NONE;
  if (monster.groundentity !== null) ent_flags |= SvEntFlagsT.SVFL_ONGROUND;
  if (monster.takedamage) ent_flags |= SvEntFlagsT.SVFL_TAKES_DAMAGE;
  if (monster.solid === SolidT.SOLID_NOT || monster.movetype === MovetypeT.MOVETYPE_NONE) ent_flags |= SvEntFlagsT.SVFL_IS_HIDDEN;
  if ((monster.flags & EntFlagsT.FL_INWATER) !== 0n) ent_flags |= SvEntFlagsT.SVFL_IN_WATER;
  monster.sv.ent_flags = ent_flags;

  monster.sv.team = cvarTrue(coop) ? Team_Coop_Monster : Team_None; // TODO: CTF/TDM/etc...

  monster.sv.health = !monster.deadflag ? monster.health : -1;
  monster.sv.waterlevel = monster.waterlevel;
  monster.sv.enemy = monster.enemy;
  monster.sv.ground_entity = monster.groundentity;

  let viewHeight = monster.viewheight;
  if (monster.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) viewHeight = Math.trunc(monster.maxs[2] - 4.0);
  monster.sv.viewheight = viewHeight;

  monster.sv.viewangles = vec3(monster.s.angles[0], monster.s.angles[1], monster.s.angles[2]);

  const forward = vec3();
  AngleVectorsForward(monster.s.angles, forward);
  monster.sv.viewforward = forward;

  monster.sv.velocity = vec3(monster.velocity[0], monster.velocity[1], monster.velocity[2]);

  if (!monster.sv.init) {
    monster.sv.init = true;
    monster.sv.classname = monster.classname;
    monster.sv.targetname = monster.targetname;
    monster.sv.starting_health = monster.health;
    monster.sv.max_health = monster.max_health;

    gi.Bot_RegisterEdict(monster);
  }
}

/** bots/bot_utils.cpp:229-268: `void Item_UpdateState(edict_t *item)`. */
function Item_UpdateState(item: EdictT): void {
  if (item.item === null) throw new Error("Item_UpdateState: item.item is null -- the C++ source dereferences it unconditionally here");

  let ent_flags = SvEntFlagsT.SVFL_IS_ITEM;
  item.sv.respawntime = 0;

  if (item.team !== null) ent_flags |= SvEntFlagsT.SVFL_IN_TEAM;

  if (item.solid === SolidT.SOLID_NOT) {
    ent_flags |= SvEntFlagsT.SVFL_IS_HIDDEN;

    if (item.nextthink > GTIME_ZERO) {
      if ((item.svflags & SvflagsT.SVF_RESPAWNING) !== 0) {
        item.sv.respawntime = Gtime_milliseconds_safe(Gtime_subtract(item.nextthink, level.time));
      } else {
        item.sv.respawntime = Item_UnknownRespawnTime;
      }
    }
  }

  if (item.item.id === 27 /* IT_FLAG1 */ || item.item.id === 28 /* IT_FLAG2 */) {
    ent_flags |= SvEntFlagsT.SVFL_IS_OBJECTIVE;
  }

  item.sv.ent_flags = ent_flags;
  item.sv.classname = item.classname;
  item.sv.item_id = item.item.id;

  if (!item.sv.init) {
    item.sv.init = true;
    item.sv.targetname = item.targetname;
    gi.Bot_RegisterEdict(item);
  }
}

/** bots/bot_utils.cpp:275-307: `void Trap_UpdateState(edict_t *danger)`. */
function Trap_UpdateState(danger: EdictT): void {
  let ent_flags = SvEntFlagsT.SVFL_TRAP_DANGER;
  danger.sv.velocity = vec3(danger.velocity[0], danger.velocity[1], danger.velocity[2]);

  if (danger.owner !== null && danger.owner.client !== null) {
    danger.sv.team = unpackTeamIndex(danger.owner.s.skinnum);
  }

  if (danger.groundentity !== null) ent_flags |= SvEntFlagsT.SVFL_ONGROUND;

  if ((danger.flags & EntFlagsT.FL_TRAP_LASER_FIELD) === 0n) {
    ent_flags |= SvEntFlagsT.SVFL_ACTIVE; // non-lasers are always active
  } else {
    danger.sv.start_origin = vec3(danger.s.origin[0], danger.s.origin[1], danger.s.origin[2]);
    danger.sv.end_origin = vec3(danger.s.old_origin[0], danger.s.old_origin[1], danger.s.old_origin[2]);
    if ((danger.svflags & SvflagsT.SVF_NOCLIENT) === 0 && (danger.s.renderfx & RenderfxT.RF_BEAM) !== 0) {
      ent_flags |= SvEntFlagsT.SVFL_ACTIVE; // lasers are active!!
    }
  }

  danger.sv.ent_flags = ent_flags;

  if (!danger.sv.init) {
    danger.sv.init = true;
    danger.sv.classname = danger.classname;
    gi.Bot_RegisterEdict(danger);
  }
}

/** bots/bot_utils.cpp:314-361: `void Edict_UpdateState(edict_t *edict)`. */
function Edict_UpdateState(edict: EdictT): void {
  let ent_flags = SvEntFlagsT.SVFL_NONE;
  edict.sv.health = edict.health;

  if (edict.takedamage) ent_flags |= SvEntFlagsT.SVFL_TAKES_DAMAGE;

  const isDoor = (edict.svflags & SvflagsT.SVF_DOOR) !== 0;
  // SPAWNFLAG_DOOR_REVERSE (g_func.ts:287, `2_spawnflag`) -- see file header
  const isReversedDoor = isDoor && (edict.spawnflags & 2) !== 0;

  if (isDoor && !isReversedDoor) {
    if (edict.moveinfo.state === 0 /* STATE_TOP */) ent_flags |= SvEntFlagsT.SVFL_MOVESTATE_BOTTOM;
    else if (edict.moveinfo.state === 1 /* STATE_BOTTOM */) ent_flags |= SvEntFlagsT.SVFL_MOVESTATE_TOP;
  } else {
    if (edict.moveinfo.state === 0 /* STATE_TOP */) ent_flags |= SvEntFlagsT.SVFL_MOVESTATE_TOP;
    else if (edict.moveinfo.state === 1 /* STATE_BOTTOM */) ent_flags |= SvEntFlagsT.SVFL_MOVESTATE_BOTTOM;
  }

  if (edict.moveinfo.state === 2 /* STATE_UP */ || edict.moveinfo.state === 3 /* STATE_DOWN */) ent_flags |= SvEntFlagsT.SVFL_MOVESTATE_MOVING;

  edict.sv.start_origin = vec3(edict.moveinfo.start_origin[0], edict.moveinfo.start_origin[1], edict.moveinfo.start_origin[2]);
  edict.sv.end_origin = vec3(edict.moveinfo.end_origin[0], edict.moveinfo.end_origin[1], edict.moveinfo.end_origin[2]);

  if ((edict.svflags & SvflagsT.SVF_DOOR) !== 0 && (edict.flags & EntFlagsT.FL_LOCKED) !== 0n) {
    ent_flags |= SvEntFlagsT.SVFL_IS_LOCKED_DOOR;
  }

  edict.sv.ent_flags = ent_flags;
}

/** bots/bot_utils.cpp:368-380: `void Entity_UpdateState(edict_t *edict)`. */
function Entity_UpdateState(edict: EdictT): void {
  if (edict.svflags & SvflagsT.SVF_MONSTER) Monster_UpdateState(edict);
  else if ((edict.flags & (EntFlagsT.FL_TRAP | EntFlagsT.FL_TRAP_LASER_FIELD)) !== 0n) Trap_UpdateState(edict);
  else if (edict.item !== null) Item_UpdateState(edict);
  else if (edict.client !== null) Player_UpdateState(edict);
  else Edict_UpdateState(edict);
}

/** `gtime_t::milliseconds()` truncated to a plain int32-shaped number,
 *  matching the C++ `static_cast<int32_t>(...)` sites this family uses. */
function Gtime_milliseconds_safe(t: GTime): number {
  return Math.trunc(t);
}

/** `AngleVectors(angles, forward, nullptr, nullptr)` -- duplicated tiny
 *  forward-only projection so this file does not need a full q_vec3.ts
 *  import solely for Monster_UpdateState's one call site. */
function AngleVectorsForward(angles: Vec3, out: Vec3): void {
  const DEG2RAD = Math.PI / 180;
  const yaw = angles[1] * DEG2RAD;
  const pitch = angles[0] * DEG2RAD;
  out[0] = Math.cos(pitch) * Math.cos(yaw);
  out[1] = Math.cos(pitch) * Math.sin(yaw);
  out[2] = -Math.sin(pitch);
}

// ---------------------------------------------------------------------------
// ClientEndServerFrames (g_main.cpp:467-480)
// ---------------------------------------------------------------------------

/** g_main.cpp:467-480: `void ClientEndServerFrames()`. */
export function ClientEndServerFrames(): void {
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse || ent.client === null) continue;
    ClientEndServerFrame(ent);
  }
}

// ---------------------------------------------------------------------------
// CreateTargetChangeLevel (g_main.cpp:489-498)
// ---------------------------------------------------------------------------

/** g_main.cpp:489-498: `edict_t *CreateTargetChangeLevel(const char *map)`. */
export function CreateTargetChangeLevel(map: string): EdictT {
  const ent = G_Spawn();
  ent.classname = "target_changelevel";
  const { result } = Q_strlcpy(map, MAX_QPATH);
  level.nextmap = result;
  ent.map = level.nextmap;
  return ent;
}

// ---------------------------------------------------------------------------
// EndDMLevel (g_main.cpp:514-622)
// ---------------------------------------------------------------------------

/** Fisher-Yates in place -- see file header's `std::shuffle`/`mt_rand` deviation note. */
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = irandom(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** g_main.cpp:521-622: `void EndDMLevel()`. */
export function EndDMLevel(): void {
  // stay on same level flag
  if (cvarTrue(g_dm_same_level)) {
    BeginIntermission(CreateTargetChangeLevel(level.mapname));
    return;
  }

  if (level.forcemap !== "") {
    BeginIntermission(CreateTargetChangeLevel(level.forcemap));
    return;
  }

  // see if it's in the map list -- see file header's COM_ParseEx deviation note
  if (g_map_list.string !== "") {
    const tokens = g_map_list.string.split(/\s+/).filter((t) => t.length > 0);
    let firstMap = "";
    for (let i = 0; i < tokens.length; i++) {
      const map = tokens[i]!;
      if (Q_strcasecmp(map, level.mapname) === 0) {
        if (i + 1 < tokens.length) {
          BeginIntermission(CreateTargetChangeLevel(tokens[i + 1]!));
          return;
        }
        // end of list, go to first one
        if (firstMap === "") {
          // there isn't a first one, same level
          BeginIntermission(CreateTargetChangeLevel(level.mapname));
          return;
        }
        // [Paril-KEX] re-shuffle if necessary
        if (cvarTrue(g_map_list_shuffle)) {
          if (tokens.length === 1) {
            BeginIntermission(CreateTargetChangeLevel(level.mapname));
            return;
          }
          const values = [...tokens];
          shuffleInPlace(values);
          // if the current map is the map at the front, push it to the end
          if (values[0] === level.mapname) {
            const last = values.length - 1;
            const tmp = values[0]!;
            values[0] = values[last]!;
            values[last] = tmp;
          }
          gi.cvar_forceset("g_map_list", values.join(" "));
          BeginIntermission(CreateTargetChangeLevel(values[0]!));
          return;
        }
        BeginIntermission(CreateTargetChangeLevel(firstMap));
        return;
      }
      if (firstMap === "") firstMap = map;
    }
  }

  if (level.nextmap !== "") {
    // go to a specific map
    BeginIntermission(CreateTargetChangeLevel(level.nextmap));
    return;
  }

  // search for a changelevel
  const ent = G_FindByString(null, "classname", "target_changelevel");

  if (ent === null) {
    // the map designer didn't include a changelevel,
    // so create a fake ent that goes back to the same level
    BeginIntermission(CreateTargetChangeLevel(level.mapname));
    return;
  }

  BeginIntermission(ent);
}

// ---------------------------------------------------------------------------
// CheckNeedPass (g_main.cpp:629-647)
// ---------------------------------------------------------------------------

/** g_main.cpp:629-647: `void CheckNeedPass()`. See file header's
 *  Cvar_WasModified deviation note. */
export function CheckNeedPass(): void {
  let changed = false;
  if (password.string !== lastPasswordString) {
    lastPasswordString = password.string;
    changed = true;
  }
  if (spectator_password.string !== lastSpectatorPasswordString) {
    lastSpectatorPasswordString = spectator_password.string;
    changed = true;
  }
  if (!changed) return;

  let need = 0;
  if (password.string !== "" && Q_strcasecmp(password.string, "none") !== 0) need |= 1;
  if (spectator_password.string !== "" && Q_strcasecmp(spectator_password.string, "none") !== 0) need |= 2;

  gi.cvar_set("needpass", `${need}`);
}

// ---------------------------------------------------------------------------
// CheckDMRules (g_main.cpp:654-717)
// ---------------------------------------------------------------------------

/** g_main.cpp:654-717: `void CheckDMRules()`. */
export function CheckDMRules(): void {
  if (Gtime_nonzero_local(level.intermissiontime)) return;
  if (!cvarTrue(deathmatch)) return;

  // ZOID: ctf->integer && CTFCheckRules() / CTFInMatch() -- CTF not ported;
  // ctf defaults 0, so both are unreachable here (see file header).

  //=======
  // ROGUE: gamerules->integer && DMGame.CheckDMRules -- DMGame is always
  // null in this port line (g_combat.ts's own precedent); gamerules
  // defaults 0 either way.
  // ROGUE
  //=======

  if (timelimit.value) {
    if (level.time >= Gtime_from_min(timelimit.value)) {
      gi.Broadcast_Print(PrintTypeT.PRINT_HIGH, "Timelimit hit.\n");
      EndDMLevel();
      return;
    }
  }

  if (Math.trunc(fraglimit.value)) {
    // [Paril-KEX]
    if (cvarTrue(teamplay)) {
      // CheckEndTDMLevel() -- teamplay-only, not ported (ctf/teamplay
      // subsystem, no src/kexgame/ home); teamplay defaults 0, so
      // unreachable here.
      return;
    }

    for (let i = 0; i < game.maxclients; i++) {
      const cl = game.clients[i];
      const ent = g_edicts[i + 1];
      if (cl === undefined || ent === undefined || !ent.inuse) continue;

      if (cl.resp.score >= Math.trunc(fraglimit.value)) {
        gi.Broadcast_Print(PrintTypeT.PRINT_HIGH, "Fraglimit hit.\n");
        EndDMLevel();
        return;
      }
    }
  }
}

function Gtime_nonzero_local(t: GTime): boolean {
  return t !== 0;
}

// ---------------------------------------------------------------------------
// ExitLevel (g_main.cpp:724-791)
// ---------------------------------------------------------------------------

/** g_main.cpp:724-791: `void ExitLevel()`. */
export function ExitLevel(): void {
  // [Paril-KEX] N64 fade
  if (level.intermission_fade) {
    level.intermission_fade_time = Gtime_add(level.time, Gtime_from_ms(1300));
    level.intermission_fading = true;
    return;
  }

  ClientEndServerFrames();

  level.exitintermission = false;
  level.intermissiontime = GTIME_ZERO;

  // [Paril-KEX] support for intermission completely wiping players
  // back to default stuff
  if (level.intermission_clear) {
    level.intermission_clear = false;

    for (let i = 0; i < game.maxclients; i++) {
      const client = game.clients[i];
      const ent = g_edicts[i + 1];
      if (client === undefined || ent === undefined) continue;

      const userinfo = client.pers.userinfo;
      client.pers = client.resp.coop_respawn = defaultClientPersistant();
      ent.health = 0; // this should trip the power armor, etc to reset as well
      client.pers.userinfo = userinfo;
      client.resp.coop_respawn.userinfo = userinfo;
    }
  }

  // [Paril-KEX] end of unit, so clear level trackers
  if (level.intermission_eou) {
    game.level_entries = Array.from({ length: MAX_LEVELS_PER_UNIT }, defaultLevelEntry);

    // give all players their lives back
    if (cvarTrue(g_coop_enable_lives)) {
      for (const player of active_players()) {
        if (player.client === null) continue;
        player.client.pers.lives = Math.trunc(g_coop_num_lives.value) + 1;
      }
    }
  }

  // ZOID: CTFNextMap() -- not yet ported (ctf/g_ctf.cpp); ctf defaults 0,
  // so the real body's own guard always short-circuits false here.

  if (level.changemap === null) {
    gi.Com_Error("Got null changemap when trying to exit level. Was a trigger_changelevel configured correctly?");
    return;
  }

  // for N64 mainly, but if we're directly changing to "victorXXX.pcx" then
  // end game
  const startOffset = level.changemap.startsWith("*") ? 1 : 0;
  const rest = level.changemap.slice(startOffset);

  if (rest.length > 6 && Q_strncasecmp(rest, "victor", 6) === 0 && Q_strncasecmp(rest.slice(-4), ".pcx", 4) === 0) {
    gi.AddCommandString(`endgame "${rest}"\n`);
  } else {
    gi.AddCommandString(`gamemap "${level.changemap}"\n`);
  }

  level.changemap = null;
}

// ---------------------------------------------------------------------------
// G_CheckCvars (g_main.cpp:793-805)
// ---------------------------------------------------------------------------

/** g_main.cpp:793-805: `static void G_CheckCvars()`. See file header's
 *  Cvar_WasModified deviation note. */
function G_CheckCvars(): void {
  const airaccel = Math.trunc(sv_airaccelerate.value);
  if (airaccel !== game.airacceleration_modified) {
    game.airacceleration_modified = airaccel;
    gi.configstring(CS_AIRACCEL, `${airaccel}`);
    pmConfig = { ...pmConfig, airaccel };
  }

  if (sv_gravity.value !== game.gravity_modified) {
    game.gravity_modified = sv_gravity.value;
    level.gravity = sv_gravity.value;
  }
}

// ---------------------------------------------------------------------------
// G_AnyDeadPlayersWithoutLives / G_AnyPlayerSpawned (g_main.cpp:807-814, 1002-1009)
// ---------------------------------------------------------------------------

function G_AnyDeadPlayersWithoutLives(): boolean {
  for (const player of active_players()) {
    if (player.client !== null && player.health <= 0 && player.client.pers.lives === 0) return true;
  }
  return false;
}

function G_AnyPlayerSpawned(): boolean {
  for (const player of active_players()) {
    if (player.client !== null && player.client.pers.spawned) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// G_RunFrame_ / G_RunFrame (g_main.cpp:823-1031)
// ---------------------------------------------------------------------------

/** g_main.cpp:823-1000: `inline void G_RunFrame_(bool main_loop)`. */
function G_RunFrame_(_main_loop: boolean): void {
  level.in_frame = true;

  G_CheckCvars();

  // Bot_UpdateDebug() -- bots subsystem not ported (no src/kexgame/ home);
  // genuine no-op, matching the six Bot_* KexGameExports stubs' citation.

  level.time = Gtime_add(level.time, frameTimeAsGtime());

  if (level.intermission_fading) {
    if (level.intermission_fade_time > level.time) {
      const alpha = clamp(1.0 - Gtime_seconds(Gtime_subtract(Gtime_subtract(level.intermission_fade_time, level.time), Gtime_from_ms(300))), 0, 1);
      for (const player of active_players()) {
        if (player.client === null) continue;
        player.client.ps.screen_blend = Float32Array.from([0, 0, 0, alpha]) as Vec4;
      }
    } else {
      level.intermission_fade = false;
      level.intermission_fading = false;
      ExitLevel();
    }

    level.in_frame = false;
    return;
  }

  // exit intermissions
  if (level.exitintermission) {
    ExitLevel();
    level.in_frame = false;
    return;
  }

  // reload the map start save if restart time is set (all players are dead)
  if (level.coop_level_restart_time > GTIME_ZERO && level.time > level.coop_level_restart_time) {
    ClientEndServerFrames();
    gi.AddCommandString("restart_level\n");
  }

  // clear client coop respawn states; this is done early since it may be
  // set multiple times for different players
  if (cvarTrue(coop) && (cvarTrue(g_coop_enable_lives) || cvarTrue(g_coop_squad_respawn))) {
    for (const player of active_players()) {
      if (player.client === null) continue;
      const client = player.client;
      if (client.respawn_time >= level.time) client.coop_respawn_state = CoopRespawnT.COOP_RESPAWN_WAITING;
      else if (cvarTrue(g_coop_enable_lives) && player.health <= 0 && client.pers.lives === 0) client.coop_respawn_state = CoopRespawnT.COOP_RESPAWN_NO_LIVES;
      else if (cvarTrue(g_coop_enable_lives) && G_AnyDeadPlayersWithoutLives()) client.coop_respawn_state = CoopRespawnT.COOP_RESPAWN_NO_LIVES;
      else client.coop_respawn_state = CoopRespawnT.COOP_RESPAWN_NONE;
    }
  }

  //
  // treat each object in turn -- even the world gets a chance to think
  //
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined) continue;

    if (!ent.inuse) {
      // defer removing client info so that disconnected, etc works
      if (i > 0 && i <= game.maxclients) {
        if (ent.timestamp !== GTIME_ZERO && level.time < ent.timestamp) {
          const playernum = i - 1;
          gi.configstring(CS_PLAYERSKINS + playernum, "");
          ent.timestamp = GTIME_ZERO;
        }
      }
      continue;
    }

    level.current_entity = ent;

    // Paril: RF_BEAM entities update their old_origin by hand.
    if ((ent.s.renderfx & RenderfxT.RF_BEAM) === 0) ent.s.old_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);

    // if the ground entity moved, make sure we are still on it
    if (ent.groundentity !== null && ent.groundentity.linkcount !== ent.groundentity_linkcount) {
      const ground = ent.groundentity;
      const mask = G_GetClipMask(ent);

      if ((ent.flags & (EntFlagsT.FL_SWIM | EntFlagsT.FL_FLY)) === 0n && (ent.svflags & SvflagsT.SVF_MONSTER) !== 0) {
        ent.groundentity = null;
        M_CheckGround(ent, mask);
      } else {
        const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, vec3(ent.s.origin[0] + ent.gravityVector[0], ent.s.origin[1] + ent.gravityVector[1], ent.s.origin[2] + ent.gravityVector[2]), ent, mask);
        if (tr.startsolid || tr.allsolid || tr.ent !== ground) ent.groundentity = null;
        else ent.groundentity_linkcount = ground.linkcount;
      }
    }

    Entity_UpdateState(ent);

    if (i > 0 && i <= game.maxclients) {
      ClientBeginServerFrame(ent);
      continue;
    }

    G_RunEntity(ent);
  }

  // see if it is time to end a deathmatch
  CheckDMRules();

  // see if needpass needs updated
  CheckNeedPass();

  if (cvarTrue(coop) && (cvarTrue(g_coop_enable_lives) || cvarTrue(g_coop_squad_respawn))) {
    // rarely, we can see a flash of text if all players respawned on some
    // other player, so if everybody is now alive we'll reset back to empty
    let resetCoopRespawn = true;
    for (const player of active_players()) {
      if (player.health >= 0) {
        resetCoopRespawn = false;
        break;
      }
    }
    if (resetCoopRespawn) {
      for (const player of active_players()) {
        if (player.client !== null) player.client.coop_respawn_state = CoopRespawnT.COOP_RESPAWN_NONE;
      }
    }
  }

  // build the playerstate_t structures for all players
  ClientEndServerFrames();

  // [Paril-KEX] if not in intermission and player 1 is loaded in the game
  // as an entity, increase timer on current entry
  const player1 = g_edicts[1];
  if (level.entry !== null && !Gtime_nonzero_local(level.intermissiontime) && player1 !== undefined && player1.inuse && player1.client !== null && player1.client.pers.connected) {
    level.entry.time = Gtime_add(level.entry.time, frameTimeAsGtime());
  }

  // [Paril-KEX] run monster pains now
  for (let i = 0; i < globals.num_edicts + 1 + game.maxclients + BODY_QUEUE_SIZE; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse || (e.svflags & SvflagsT.SVF_MONSTER) === 0) continue;
    M_ProcessPain(e);
  }

  level.in_frame = false;
}

/** g_main.cpp:1011-1031: `void G_RunFrame(bool main_loop)`. */
export function G_RunFrame(main_loop: boolean): void {
  if (main_loop && !G_AnyPlayerSpawned()) return;

  for (let i = 0; i < Math.trunc(g_frames_per_frame.value); i++) {
    G_RunFrame_(main_loop);
  }

  // match details.. only bother if there's at least 1 player in-game and
  // not already end of game
  if (G_AnyPlayerSpawned() && !Gtime_nonzero_local(level.intermissiontime)) {
    const MATCH_REPORT_TIME = Gtime_from_sec(45);
    if (level.time - level.next_match_report > MATCH_REPORT_TIME) {
      level.next_match_report = Gtime_add(level.time, MATCH_REPORT_TIME);
      G_ReportMatchDetails(false);
    }
  }
}

// ---------------------------------------------------------------------------
// G_PrepFrame (g_main.cpp:1041-1054)
// ---------------------------------------------------------------------------

const STAT_HIT_MARKER = 50; // p_hud.ts's own local copy of this constant (bg_local.h's player_stat_t)

/** g_main.cpp:1041-1054: `void G_PrepFrame()`. */
export function G_PrepFrame(): void {
  for (let i = 0; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e !== undefined) e.s.event = 0; // EV_NONE
  }

  for (const player of active_players()) {
    if (player.client !== null) player.client.ps.stats[STAT_HIT_MARKER] = 0;
  }

  globals.server_flags &= ~ServerFlagsT.SERVER_FLAG_INTERMISSION;
  if (Gtime_nonzero_local(level.intermissiontime)) {
    globals.server_flags |= ServerFlagsT.SERVER_FLAG_INTERMISSION;
  }
}

// ---------------------------------------------------------------------------
// GetGameAPI (g_main.cpp:411-458)
// ---------------------------------------------------------------------------

/** g_main.cpp:411-458: `Q2GAME_API game_export_t *GetGameAPI(game_import_t *import)`. */
export function GetGameAPI(imports: KexGameImports): KexGameExports {
  SetGameImports(imports);

  const exportsTable: KexGameExports = {
    apiversion: GAME_API_VERSION,

    PreInit: PreInitGame,
    Init: InitGame,
    Shutdown: ShutdownGame,

    SpawnEntities: (_mapname: string, _entstring: string, _spawnpoint: string): void => {
      throw new Error("SpawnEntities: not yet ported (pending g_spawn.ts, see g_spawn.cpp)");
    },

    WriteGameJson: (_autosave: boolean, _out_size: [number]): string | null => {
      throw new Error("WriteGameJson: not yet ported (pending g_save.ts, see g_main.cpp:146 / g_save.cpp)");
    },
    ReadGameJson: (_json: string): void => {
      throw new Error("ReadGameJson: not yet ported (pending g_save.ts, see g_main.cpp:147 / g_save.cpp)");
    },
    WriteLevelJson: (_transition: boolean, _out_size: [number]): string | null => {
      throw new Error("WriteLevelJson: not yet ported (pending g_save.ts, see g_main.cpp:148 / g_save.cpp)");
    },
    ReadLevelJson: (_json: string): void => {
      throw new Error("ReadLevelJson: not yet ported (pending g_save.ts, see g_main.cpp:149 / g_save.cpp)");
    },
    CanSave: (): boolean => {
      throw new Error("CanSave: not yet ported (pending g_save.ts, see g_main.cpp:150 G_CanSave)");
    },

    ClientChooseSlot: (userinfo: string, social_id: string, isBot: boolean, ignore: (KexEdictT | null)[], num_ignore: number, cinematic: boolean): KexEdictT | null => {
      const realIgnore: EdictT[] = ignore
        .slice(0, num_ignore)
        .filter((e): e is KexEdictT => e !== null)
        .map((e) => resolveEdict(e, "ClientChooseSlot"));
      return ClientChooseSlot(userinfo, social_id, isBot, realIgnore, cinematic);
    },
    ClientConnect: (ent: KexEdictT | null, userinfo: [string], social_id: string, isBot: boolean): boolean => {
      return ClientConnect(mustResolveEdict(ent, "ClientConnect"), userinfo, social_id, isBot);
    },
    ClientBegin: (ent: KexEdictT | null): void => {
      ClientBegin(mustResolveEdict(ent, "ClientBegin"));
    },
    ClientUserinfoChanged: (ent: KexEdictT | null, userinfo: string): void => {
      ClientUserinfoChanged(mustResolveEdict(ent, "ClientUserinfoChanged"), userinfo);
    },
    ClientDisconnect: (ent: KexEdictT | null): void => {
      ClientDisconnect(mustResolveEdict(ent, "ClientDisconnect"));
    },
    ClientCommand: (ent: KexEdictT | null): void => {
      ClientCommand(mustResolveEdict(ent, "ClientCommand"));
    },
    ClientThink: (ent: KexEdictT | null, cmd: KexUsercmdT | null): void => {
      const real = mustResolveEdict(ent, "ClientThink");
      if (cmd === null) throw new Error("ClientThink: called with a null usercmd -- the C++ source dereferences it unconditionally here");
      ClientThink(real, cmd);
    },

    RunFrame: G_RunFrame,
    PrepFrame: G_PrepFrame,

    ServerCommand: ServerCommand,

    edicts: g_edicts,
    num_edicts: 0,
    max_edicts: 0,

    server_flags: ServerFlagsT.SERVER_FLAGS_NONE,

    Pmove: (pmove: KexPmoveT | null): void => {
      if (pmove === null) throw new Error("Pmove: called with a null pmove -- the C++ source dereferences it unconditionally here");
      Pmove(pmove, pmConfig);
    },

    GetExtension: G_GetExtension,

    Bot_SetWeapon: (_botEdict: KexEdictT | null, _weaponIndex: number, _instantSwitch: boolean): void => {
      throw new Error("Bot_SetWeapon: not yet ported (bots/ subsystem, no src/kexgame/ home)");
    },
    Bot_TriggerEdict: (_botEdict: KexEdictT | null, _edict: KexEdictT | null): void => {
      throw new Error("Bot_TriggerEdict: not yet ported (bots/ subsystem, no src/kexgame/ home)");
    },
    Bot_UseItem: (_botEdict: KexEdictT | null, _itemID: number): void => {
      throw new Error("Bot_UseItem: not yet ported (bots/ subsystem, no src/kexgame/ home)");
    },
    Bot_GetItemID: (_classname: string): number => {
      throw new Error("Bot_GetItemID: not yet ported (bots/ subsystem, no src/kexgame/ home)");
    },
    Edict_ForceLookAtPoint: (_edict: KexEdictT | null, _point: Vec3): void => {
      throw new Error("Edict_ForceLookAtPoint: not yet ported (bots/ subsystem, no src/kexgame/ home)");
    },
    Bot_PickedUpItem: (_botEdict: KexEdictT | null, _itemEdict: KexEdictT | null): boolean => {
      throw new Error("Bot_PickedUpItem: not yet ported (bots/ subsystem, no src/kexgame/ home)");
    },

    Entity_IsVisibleToPlayer: (ent: KexEdictT | null, player: KexEdictT | null): boolean => {
      return Entity_IsVisibleToPlayer(mustResolveEdict(ent, "Entity_IsVisibleToPlayer"), mustResolveEdict(player, "Entity_IsVisibleToPlayer"));
    },

    GetShadowLightData: (entity_number: number): ShadowLightDataT | null => {
      return GetShadowLightData(entity_number);
    },
  };

  SetGameExports(exportsTable);
  return exportsTable;
}
