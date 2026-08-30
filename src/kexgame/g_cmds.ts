// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_cmds.c -- client console command dispatch (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_cmds.cpp (1,753 lines,
// C++17): SelectNextItem/SelectPrevItem/ValidateSelectedItem,
// give/god/immortal/notarget/novisible/noclip/use/drop/inven/invuse/
// invdrop/weapnext/weapprev/weaplast/kill/kill_ai/where/clear_ai_enemy/
// putaway/wave (incl. the KEX wave-to-nearby-teammate ping logic)/say/
// say_team/players/playerlist/switchteam, the KEX dev cheats
// (spawn/teleport/setpoi/checkpoi/target/alertall/listmonsters), and the
// full `ClientCommand` dispatch table (incl. the CTF sub-commands).
// Behavioral code, ported bug-for-bug per this port line's house
// conventions (see g_monster.ts/g_utils.ts headers).
//
// ============================================================================
// SelectNextItem / ValidateSelectedItem -- ALREADY REAL in g_items.ts, NOT
// re-implemented here
// ============================================================================
// g_items.ts's own file header ("SMALL CROSS-FILE FUNCTIONS PORTED HERE FOR
// REAL") already ported real, exported `SelectNextItem(ent, itflags, menu =
// true)` (g_cmds.cpp:6) and `ValidateSelectedItem(ent)` (g_cmds.cpp:90) --
// `Touch_Item` needs `ValidateSelectedItem` on every pickup, and g_items.ts
// landed first. Both are imported from there rather than re-implemented,
// avoiding a second, divergence-prone copy of the same loop. g_items.ts's
// own copy of `SelectNextItem` calls two of ITS OWN local throwing stubs for
// the `menu`/chase-target branches (`PMenu_Next`, cited to
// ctf/p_ctf_menu.cpp; `ChaseNext`, cited to "p_hud.ts/g_chase.cpp") -- the
// `ChaseNext` one is now STALE (this unit's own g_chase.ts landed a real,
// exported `ChaseNext`), but g_items.ts is not in this unit's file list, so
// that stub is left exactly as-is and reported as a finding for a future
// unit to swap, mirroring g_monster.ts's own "not swapped here, future
// unit's job" precedent for g_utils.ts's G_MonsterKilled stub.
//
// ============================================================================
// SelectPrevItem -- genuinely new here (not landed anywhere else)
// ============================================================================
// Unlike `SelectNextItem`, no other file needed `SelectPrevItem`
// (g_cmds.cpp:48) before this unit, so it is ported fresh, right here (its
// real, only C++ home). It calls `PMenu_Prev` (stub, ctf/p_ctf_menu.cpp)
// and `ChasePrev` (REAL import from this unit's own new g_chase.ts).
//
// ============================================================================
// p_client.cpp / p_weapon.cpp cross-dependencies -- ALWAYS throwing stubs,
// regardless of on-disk state
// ============================================================================
// p_client.ts and p_weapon.ts are owned by a concurrent agent in this same
// porting round and are explicitly out of this unit's write scope. Per this
// unit's own brief, every function whose real C++ home is p_client.cpp or
// p_weapon.cpp is treated as an unported cross-dependency and stubbed
// locally, EVEN where that file's current on-disk snapshot happens to carry
// a real implementation already -- the snapshot is not stable to build
// against mid-round (p_client.ts's own file already demonstrates this: its
// local `FindItemByClassname` stub is stale relative to g_items.ts's real,
// landed one, a live example of exactly the divergence this rule avoids).
// Stubbed here: `P_ProjectSource` (p_weapon.cpp:91), `player_die`
// (p_client.cpp, g_local.h:2423), `respawn` (p_client.cpp:1621),
// `PutClientInServer` (p_client.cpp:1980), `G_PostRespawn`
// (p_client.cpp:1606), `RemoveAttackingPainDaemons` (p_client.cpp:3838).
//
// ============================================================================
// STUB SWAP: ED_ParseField/ED_CallSpawn/`st` -- now real imports from
// src/kexgame/g_spawn.ts
// ============================================================================
// This file used to carry two local throwing stubs for `ED_ParseField`/
// `ED_CallSpawn` (g_spawn.cpp) and a permanently-`{ item: null }`-shaped
// narrow local `st` placeholder (only ever reset via `st.item = null`,
// never read meaningfully), since no src/kexgame/g_spawn.ts existed yet --
// the same gap g_monster.ts's/g_trigger.ts's/g_target.ts's own headers
// documented for their own `st` placeholders. `Cmd_Spawn_f` (the "spawn
// <classname> [key value]..." dev cheat) reaches `ED_ParseField`/
// `ED_CallSpawn` UNCONDITIONALLY on every invocation, so it genuinely
// always threw before this swap. src/kexgame/g_spawn.ts has now landed
// with real, exported `ED_ParseField`/`ED_CallSpawn` and the real, shared
// `st` global (mutated in place by `ClearSpawnTemp()`/`ED_ParseField`);
// this file's own stub definitions and narrow `st` placeholder are DELETED
// and replaced with `import { ED_ParseField, ED_CallSpawn, ClearSpawnTemp }
// from "./g_spawn"` (this file never reads `st` directly -- its own
// `st = {};` reset becomes a `ClearSpawnTemp()` call instead). `Cmd_Spawn_f`
// now genuinely spawns an entity (subject to
// whatever real spawn function `spawns[]` resolves the given classname
// to -- including this port line's own registered throwing stubs for
// still-unported classnames, e.g. any `monster_*` name), rather than
// always throwing.
//
// g_spawn.ts does not import anything from this file, so this is an
// ordinary one-directional dependency, not a cycle.
//
// ============================================================================
// CTF (ctf/g_ctf.cpp, ctf/p_ctf_menu.cpp) -- throwing stubs, unreachable by
// default
// ============================================================================
// This entire subsystem (ctf/g_ctf.cpp: CTFTeamName, CTFAssignSkin, CTFID_f,
// CTFDirtyTeamMenu, CTFTeam_f, CTFWhat_Tech, CTFSay_Team, CTFVoteYes,
// CTFVoteNo, CTFReady, CTFNotReady, CTFGhost, CTFOpenJoinMenu, CTFObserver,
// CTFAdmin, CTFStats, CTFPlayerList, CTFWarp, CTFBoot; ctf/p_ctf_menu.cpp:
// PMenu_Next, PMenu_Prev, PMenu_Close, PMenu_Select) is not ported anywhere
// in this port line (no `src/kexgame/g_ctf.ts`/`p_ctf_menu.ts` exists;
// confirmed by directory listing) -- matching p_client.ts's own established
// precedent for the identical subsystem (its header: "not yet ported
// (pending g_ctf.ts, see ctf/g_ctf.cpp:...); ctf/teamplay cvars default to
// 0"). Every CTF-family `ClientCommand` sub-command
// (team/id/yes/no/ready/notready/ghost/admin/stats/warp/boot/playerlist/
// observer) is genuinely reachable from a real client typing that command,
// so these are NOT provably-unreachable stubs the way some other cited gaps
// in this port line are -- they are reported as a real, standing gap,
// exactly matching p_client.ts's own "CTFStartClient" honesty about this
// same subsystem.
//
// ============================================================================
// #ifndef KEX_Q2_GAME / Cmd_Say_f -- PORTED DESPITE the real build excluding
// it (deliberate, per brief)
// ============================================================================
// g_cmds.cpp's own `Cmd_Say_f` and its two `ClientCommand` call sites
// ("say"/"say_team"/"steam", and the final chat-fallback `else`) are wrapped
// in `#ifndef KEX_Q2_GAME` -- and the real rerelease DLL DOES define
// `KEX_Q2_GAME` for the actual game build (verified: `game.vcxproj`'s
// `PreprocessorDefinitions` includes `KEX_Q2_GAME`), meaning the genuine KEX
// dedicated-server build compiles `Cmd_Say_f` OUT entirely and replaces the
// final `ClientCommand` fallback with `gi.LocClient_Print(ent, PRINT_HIGH,
// "invalid game command \"{}\"\n", gi.argv(0))` instead of calling it. This
// unit's own brief explicitly lists "say/say_team with flood protection" as
// in-scope to port ("port everything"), so `Cmd_Say_f` IS ported here (the
// `#ifndef KEX_Q2_GAME` branch's code, not the `#else` branch), and
// `ClientCommand`'s dispatch below wires up the non-KEX_Q2_GAME behavior
// (`say`/`say_team` route to it; the unmatched-command fallback calls
// `Cmd_Say_f(ent, true)`) -- reported here as a deliberate, brief-directed
// deviation from what the real 2023 rerelease KEX dedicated server actually
// ships, not an oversight. `say_team`'s `G_TeamplayEnabled()`-gated
// `CTFSay_Team` branch is a real, reachable CTF stub per the section above
// (default-unreachable since `ctf`/`teamplay` cvars both default to 0).
//
// ============================================================================
// REACHABILITY NOTES for specific stub-touching commands
// ============================================================================
// - `Cmd_Wave_f` calls `P_ProjectSource` (a p_weapon.cpp cross-dep, always
//   stubbed per this file's own rule above) unconditionally, before its own
//   gesture-`switch`. This means `Cmd_Wave_f` throws on every invocation
//   today, regardless of which gesture was requested -- an honest
//   consequence of the p_weapon.ts stub policy, not a narrower bug. A
//   future unit with write access to p_weapon.ts should replace this
//   file's local stub with a real import once that lands.
// - `Cmd_Switchteam_f` bails immediately (`if (!G_TeamplayEnabled())
//   return;`) before touching ANY of its CTF/p_client stubs. Since
//   `ctf`/`teamplay` both default to 0, this command is a genuine no-op
//   (not a throw) under this port line's default configuration -- the
//   stubs inside are unreachable by any test that doesn't first flip one
//   of those cvars, mirroring p_view.ts's own `G_TeamplayEnabled` guard
//   precedent used throughout this port line.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - `qsort(index, count, sizeof(index[0]), PlayerSort)` (Cmd_Players_f):
//   ported as `Array.prototype.sort` with a numeric comparator over client
//   indices, matching `PlayerSort`'s exact `STAT_FRAGS` ascending-then-
//   the-C++-does-ascending-not-descending comparison (`anum < bnum -> -1`)
//   bug-for-bug (this is genuinely ascending-by-frags, not the usual
//   leaderboard descending order -- the C++ source itself sorts this way).
// - `fmt::format_to`/`std::string` scratch buffers (Cmd_Players_f,
//   Cmd_PlayerList_f, Cmd_Where_f): ported as plain template-literal string
//   building; the `MAX_IDEAL_PACKET_SIZE - 50` truncation-loop and
//   trailing-newline-trim behavior are preserved exactly.
// - `gi.Com_PrintFmt` (Cmd_CheckPOI_f, Cmd_ListMonsters_f -- plain
//   non-localized console prints, no `gi` counterpart in this port's
//   `KexGameImports`): ported via `gi.Com_Print` with the string built at
//   the call site, matching g_utils.ts's/g_items.ts's own established
//   `LocClient_Print` "no localization backend, thin pass-through"
//   treatment for the analogous `gi.LocClient_Print` gap.
// - `gi.LocClient_Print`/`gi.LocBroadcast_Print`/`gi.LocCenter_Print`: this
//   port's `gi` only has `Client_Print`/`Loc_Print`; every `$`-prefixed loc
//   key call routes through local `giLocClientPrint`/`giLocBroadcastPrint`
//   helpers built on `gi.Loc_Print`, duplicated per-file exactly like
//   p_client.ts's/g_trigger.ts's own identical copies (see g_utils.ts's file
//   header for the general "no shared module for this" rule).
// - `null_trace` (g_local.h:627): g_utils.ts's own copy is NOT exported;
//   duplicated locally here too (same "duplicate the tiny unexported
//   constant" convention already used for `LocClient_Print` itself).
// - `PlayerSort`'s `qsort`-style raw index array and `Cmd_Players_f`'s
//   `int index[MAX_CLIENTS]`: ported as a plain `number[]` built by
//   filtering `game.clients` for `.pers.connected`, then sorted in place.

import { Q_strcasecmp, Info_ValueForKey } from "../shared/q_shared";
import {
  ATTN_NONE,
  ATTN_NORM,
  ContentsT,
  type KexTraceT,
  MASK_SHOT,
  MASK_SOLID,
  MAX_ITEMS,
  PmflagsT,
  PrintTypeT,
  ServerCommandT,
  ServerFlagsT,
  SoundchanT,
  SvcPoiFlagsT,
  SvflagsT,
  SolidT,
  CS_ITEMS,
  CvarFlagsT,
  GestureType,
} from "../kexapi/game";
import {
  type EdictT,
  type GitemT,
  CtfteamT,
  EntFlagsT,
  ItemFlagsT,
  ItemIdT,
  ModIdT,
  AnimPriorityT,
  MonsterAiFlagsT,
  MovetypeT,
  POI_OBJECTIVE,
  POI_PING,
} from "./g_local";
import { g_edicts, game, gi, globals, level } from "./g_main_globals";
import { GTIME_ZERO, Gtime_add, Gtime_from_sec, Gtime_nonzero, Gtime_subtract, type GTime } from "./gtime";
import { AngleVectors, vec3_add, vec3_muls, vec3_dot, vec3_sub, vec3_normalize } from "./q_vec3";
import { vec3, type Vec3 } from "../shared/math";
import { CplaneT } from "../shared/q_shared";
import { G_FreeEdict, G_Spawn, G_UseTargets, findradius } from "./g_utils";
import { OnSameTeam } from "./g_combat";
import { FoundTarget } from "./g_ai";
import { GetUnicastKey } from "./g_weapon";
import { G_TeamplayEnabled } from "./p_view";
import { Cmd_Help_f, Cmd_Score_f, PlayerStatT } from "./p_hud";
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
} from "./m_player";
import { ChaseNext, ChasePrev } from "./g_chase";
import {
  Add_Ammo,
  FindItem,
  FindItemByClassname,
  G_CheckPowerArmor,
  GetItemByIndex,
  itemlist,
  SelectNextItem,
  SpawnItem,
  Touch_Item,
  ValidateSelectedItem,
} from "./g_items";
import { P_ProjectSource } from "./p_weapon";
import { player_die, respawn, PutClientInServer, G_PostRespawn, RemoveAttackingPainDaemons } from "./p_client";
import { ED_ParseField, ED_CallSpawn, ClearSpawnTemp } from "./g_spawn";

// ---------------------------------------------------------------------------
// atoi/atof -- see src/game/g_cmds.ts's identical `atoiC` precedent (this
// port line's own vanilla-track sibling of this exact file)
// ---------------------------------------------------------------------------

function atoiC(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function atofC(s: string): number {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// cvar access -- duplicated per-file per this port line's own convention
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? 0 : c.value;
}

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? 0 : c.value;
}

function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0", CvarFlagsT.CVAR_LATCH) !== 0;
}

// ---------------------------------------------------------------------------
// gi.LocClient_Print / LocBroadcast_Print / Client_Print -- placement
// mismatch local helpers, see file header
// ---------------------------------------------------------------------------

function giClientPrint(ent: EdictT | null, printlevel: PrintTypeT, message: string): void {
  gi.Client_Print(ent, printlevel, message);
}

function giLocClientPrint(ent: EdictT | null, printlevel: PrintTypeT, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(ent, printlevel, base, args.map(String), args.length);
}

function giLocBroadcastPrint(printlevel: PrintTypeT, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(null, printlevel | PrintTypeT.PRINT_BROADCAST, base, args.map(String), args.length);
}

/** g_local.h:627: `constexpr trace_t null_trace {};` -- see file header. */
const null_trace: KexTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 0,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: ContentsT.CONTENTS_NONE,
  ent: null,
  plane2: new CplaneT(),
  surface2: null,
};

/** g_local.h:136-139 `game_import_t::traceline` -- see file header. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players.
 *  Duplicated per-file -- see g_utils.ts's own file header for the general
 *  "duplicate the tiny unexported helper" rule this repeats. */
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

// ED_ParseField/ED_CallSpawn/`st`: formerly local throwing stubs (and a
// narrow local `st` placeholder) here -- src/kexgame/g_spawn.ts has landed
// with real exports of all three; see this file's own header, "STUB SWAP:
// ED_ParseField/ED_CallSpawn/`st`".

// ctf/p_ctf_menu.cpp -- see file header
function PMenu_Prev(_ent: EdictT): void {
  throw new Error("PMenu_Prev: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp:222)");
}

// ctf/g_ctf.cpp -- see file header
function CTFWhat_Tech(_ent: EdictT): GitemT | null {
  throw new Error("CTFWhat_Tech: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1823)");
}
function CTFOpenJoinMenu(_ent: EdictT): void {
  throw new Error("CTFOpenJoinMenu: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2941)");
}
function CTFAssignSkin(_ent: EdictT, _s: string): void {
  throw new Error("CTFAssignSkin: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:280)");
}
function CTFDirtyTeamMenu(): void {
  throw new Error("CTFDirtyTeamMenu: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1507)");
}
function CTFTeamName(_team: CtfteamT): string {
  throw new Error("CTFTeamName: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:237)");
}
function CTFObserver(_ent: EdictT): void {
  throw new Error("CTFObserver: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2991)");
}
function CTFTeam_f(_ent: EdictT): void {
  throw new Error("CTFTeam_f: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1517)");
}
function CTFID_f(_ent: EdictT): void {
  throw new Error("CTFID_f: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:932)");
}
function CTFVoteYes(_ent: EdictT): void {
  throw new Error("CTFVoteYes: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2480)");
}
function CTFVoteNo(_ent: EdictT): void {
  throw new Error("CTFVoteNo: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2512)");
}
function CTFReady(_ent: EdictT): void {
  throw new Error("CTFReady: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2537)");
}
function CTFNotReady(_ent: EdictT): void {
  throw new Error("CTFNotReady: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2588)");
}
function CTFGhost(_ent: EdictT): void {
  throw new Error("CTFGhost: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2619)");
}
function CTFAdmin(_ent: EdictT): void {
  throw new Error("CTFAdmin: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:3630)");
}
function CTFStats(_ent: EdictT): void {
  throw new Error("CTFStats: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:3661)");
}
function CTFWarp(_ent: EdictT): void {
  throw new Error("CTFWarp: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:3775)");
}
function CTFBoot(_ent: EdictT): void {
  throw new Error("CTFBoot: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:3815)");
}
function CTFPlayerList(_ent: EdictT): void {
  throw new Error("CTFPlayerList: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:3738)");
}
function CTFSay_Team(_who: EdictT, _msg: string): void {
  throw new Error("CTFSay_Team: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:2133)");
}

// ---------------------------------------------------------------------------
// SelectPrevItem (g_cmds.cpp:48-88) -- see file header, genuinely new here
// ---------------------------------------------------------------------------

export function SelectPrevItem(ent: EdictT, itflags: ItemFlagsT): void {
  const client = ent.client;
  if (client === null) throw new Error("SelectPrevItem: called against an entity with no .client set");

  if (client.menu !== null) {
    PMenu_Prev(ent);
    return;
  } else if (client.chase_target !== null) {
    ChasePrev(ent);
    return;
  }

  for (let i = ItemIdT.IT_NULL + 1; i <= ItemIdT.IT_TOTAL; i++) {
    const index = (client.pers.selected_item + ItemIdT.IT_TOTAL - i) % ItemIdT.IT_TOTAL;
    if (client.pers.inventory[index] === 0) continue;
    const it = itemlist[index];
    if (it === undefined || it.use === null) continue;
    if ((it.flags & itflags) === 0) continue;

    client.pers.selected_item = index;
    client.pers.selected_item_time = Gtime_add(level.time, Gtime_from_sec(2));
    client.ps.stats[PlayerStatT.STAT_SELECTED_ITEM_NAME] = CS_ITEMS + index;
    return;
  }

  client.pers.selected_item = ItemIdT.IT_NULL;
}

// ---------------------------------------------------------------------------
// G_CheatCheck (g_cmds.cpp:104-113)
// ---------------------------------------------------------------------------

function G_CheatCheck(ent: EdictT): boolean {
  if (game.maxclients > 1 && cvarInt("sv_cheats", "0") === 0) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_need_cheats");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SpawnAndGiveItem (g_cmds.cpp:115-132)
// ---------------------------------------------------------------------------

function SpawnAndGiveItem(ent: EdictT, id: ItemIdT): void {
  const it = GetItemByIndex(id);
  if (it === null) return;

  const it_ent = G_Spawn();
  it_ent.classname = it.classname;
  SpawnItem(it_ent, it);

  if (it_ent.inuse) {
    Touch_Item(it_ent, ent, null_trace, true);
    if (it_ent.inuse) G_FreeEdict(it_ent);
  }
}

// ---------------------------------------------------------------------------
// Cmd_Give_f (g_cmds.cpp:141-295)
// ---------------------------------------------------------------------------

export function Cmd_Give_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Give_f: called against an entity with no .client set");

  if (!G_CheatCheck(ent)) return;

  let name = gi.args();
  const give_all = Q_strcasecmp(name, "all") === 0;

  if (give_all || Q_strcasecmp(gi.argv(1), "health") === 0) {
    if (gi.argc() === 3) ent.health = atoiC(gi.argv(2));
    else ent.health = ent.max_health;
    if (!give_all) return;
  }

  if (give_all || Q_strcasecmp(name, "weapons") === 0) {
    for (let i = 0; i < ItemIdT.IT_TOTAL; i++) {
      const it = itemlist[i];
      if (it === undefined || it.pickup === null) continue;
      if ((it.flags & ItemFlagsT.IF_WEAPON) === 0) continue;
      client.pers.inventory[i] += 1;
    }
    if (!give_all) return;
  }

  if (give_all || Q_strcasecmp(name, "ammo") === 0) {
    if (give_all) SpawnAndGiveItem(ent, ItemIdT.IT_ITEM_PACK);

    for (let i = 0; i < ItemIdT.IT_TOTAL; i++) {
      const it = itemlist[i];
      if (it === undefined || it.pickup === null) continue;
      if ((it.flags & ItemFlagsT.IF_AMMO) === 0) continue;
      Add_Ammo(ent, it, 1000);
    }
    if (!give_all) return;
  }

  if (give_all || Q_strcasecmp(name, "armor") === 0) {
    client.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = 0;
    client.pers.inventory[ItemIdT.IT_ARMOR_COMBAT] = 0;
    const body = GetItemByIndex(ItemIdT.IT_ARMOR_BODY);
    if (body === null || body.armor_info === null) throw new Error("Cmd_Give_f: IT_ARMOR_BODY has no armor_info -- the C++ source dereferences it unconditionally here");
    client.pers.inventory[ItemIdT.IT_ARMOR_BODY] = body.armor_info.max_count;

    if (!give_all) return;
  }

  if (give_all) {
    SpawnAndGiveItem(ent, ItemIdT.IT_ITEM_POWER_SHIELD);
  }

  if (give_all) {
    for (let i = 0; i < ItemIdT.IT_TOTAL; i++) {
      const it = itemlist[i];
      if (it === undefined || it.pickup === null) continue;
      if ((it.flags & (ItemFlagsT.IF_ARMOR | ItemFlagsT.IF_WEAPON | ItemFlagsT.IF_AMMO | ItemFlagsT.IF_NOT_GIVEABLE | ItemFlagsT.IF_TECH)) !== 0) continue;
      else if (it.pickup === CTFPickup_Flag) continue;
      else if ((it.flags & ItemFlagsT.IF_HEALTH) !== 0 && it.use === null) continue;
      client.pers.inventory[i] = (it.flags & ItemFlagsT.IF_KEY) !== 0 ? 8 : 1;
    }

    G_CheckPowerArmor(ent);
    client.pers.power_cubes = 0xff;
    return;
  }

  let it = FindItem(name);
  if (it === null) {
    name = gi.argv(1);
    it = FindItem(name);
  }
  if (it === null) it = FindItemByClassname(name);

  if (it === null) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_unknown_item");
    return;
  }

  if ((it.flags & ItemFlagsT.IF_NOT_GIVEABLE) !== 0) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_not_giveable");
    return;
  }

  const index = it.id;

  if (it.pickup === null) {
    client.pers.inventory[index] = 1;
    return;
  }

  if ((it.flags & ItemFlagsT.IF_AMMO) !== 0) {
    if (gi.argc() === 3) client.pers.inventory[index] = atoiC(gi.argv(2));
    else client.pers.inventory[index] += it.quantity;
  } else {
    const it_ent = G_Spawn();
    it_ent.classname = it.classname;
    SpawnItem(it_ent, it);
    if (!it_ent.inuse) return;
    Touch_Item(it_ent, ent, null_trace, true);
    if (it_ent.inuse) G_FreeEdict(it_ent);
  }
}

/** `CTFPickup_Flag` is referenced by pointer-identity in `Cmd_Give_f`'s
 *  "give all" branch (`it->pickup == CTFPickup_Flag`) -- this port line has
 *  no ported `CTFPickup_Flag` anywhere (ctf/g_ctf.cpp, unported, see file
 *  header). A stable, never-registered sentinel function is used purely for
 *  the identity comparison: since no real `itemlist` entry's `.pickup` can
 *  ever equal it (nothing assigns this exact reference anywhere), the
 *  branch's `continue` is simply never taken for that reason today -- an
 *  honest consequence of CTF being unported, not a silent behavior change
 *  (the flags are also excluded via `IF_NOT_GIVEABLE`/similar in the real
 *  itemlist for the flag items, so this is not the only guard). */
function CTFPickup_Flag(_ent: EdictT, _other: EdictT): boolean {
  throw new Error("CTFPickup_Flag: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:640) -- sentinel identity only, never actually invoked");
}

// ---------------------------------------------------------------------------
// Cmd_SetPOI_f / Cmd_CheckPOI_f (g_cmds.cpp:297-320)
// ---------------------------------------------------------------------------

export function Cmd_SetPOI_f(self: EdictT): void {
  if (!G_CheatCheck(self)) return;

  level.current_poi[0] = self.s.origin[0];
  level.current_poi[1] = self.s.origin[1];
  level.current_poi[2] = self.s.origin[2];
  level.valid_poi = true;
}

export function Cmd_CheckPOI_f(self: EdictT): void {
  if (!G_CheatCheck(self)) return;
  if (!level.valid_poi) return;

  const visible_pvs = gi.inPVS(self.s.origin, level.current_poi, false) ? "y" : "n";
  const visible_pvs_portals = gi.inPVS(self.s.origin, level.current_poi, true) ? "y" : "n";
  const visible_phs = gi.inPHS(self.s.origin, level.current_poi, false) ? "y" : "n";
  const visible_phs_portals = gi.inPHS(self.s.origin, level.current_poi, true) ? "y" : "n";

  gi.Com_Print(`pvs ${visible_pvs} + portals ${visible_pvs_portals}, phs ${visible_phs} + portals ${visible_phs_portals}\n`);
}

// ---------------------------------------------------------------------------
// Cmd_Target_f (g_cmds.cpp:323-331) -- `static`, not exported in C++
// ---------------------------------------------------------------------------

function Cmd_Target_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  ent.target = gi.argv(1);
  G_UseTargets(ent, ent);
  ent.target = null;
}

// ---------------------------------------------------------------------------
// Cmd_God_f (g_cmds.cpp:342-356)
// ---------------------------------------------------------------------------

export function Cmd_God_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  ent.flags ^= EntFlagsT.FL_GODMODE;
  const msg = (ent.flags & EntFlagsT.FL_GODMODE) === 0n ? "godmode OFF\n" : "godmode ON\n";
  giClientPrint(ent, PrintTypeT.PRINT_HIGH, msg);
}

// ---------------------------------------------------------------------------
// Cmd_Immortal_f (g_cmds.cpp:368-382)
// ---------------------------------------------------------------------------

export function Cmd_Immortal_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  ent.flags ^= EntFlagsT.FL_IMMORTAL;
  const msg = (ent.flags & EntFlagsT.FL_IMMORTAL) === 0n ? "immortal OFF\n" : "immortal ON\n";
  giClientPrint(ent, PrintTypeT.PRINT_HIGH, msg);
}

// ---------------------------------------------------------------------------
// Cmd_Spawn_f (g_cmds.cpp:396-465) -- see file header, always throws today
// ---------------------------------------------------------------------------

export function Cmd_Spawn_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  const client = ent.client;
  if (client === null) throw new Error("Cmd_Spawn_f: called against an entity with no .client set");

  const backup = ent.solid;
  ent.solid = SolidT.SOLID_NOT;
  gi.linkentity(ent);

  const other = G_Spawn();
  other.classname = gi.argv(1);

  const facingForward = vec3();
  AngleVectors(ent.s.angles, facingForward, null, null);
  other.s.origin[0] = ent.s.origin[0] + facingForward[0] * 24;
  other.s.origin[1] = ent.s.origin[1] + facingForward[1] * 24;
  other.s.origin[2] = ent.s.origin[2] + facingForward[2] * 24;
  other.s.angles[1] = ent.s.angles[1];

  // `st = {};` -- a full reset now that `st` is the real shared global
  // (see file header), not the narrow `st.item = null` this file used
  // before the stub swap.
  ClearSpawnTemp();

  if (gi.argc() > 3) {
    for (let i = 2; i < gi.argc(); i += 2) {
      ED_ParseField(gi.argv(i), gi.argv(i + 1), other);
    }
  }

  ED_CallSpawn(other);

  if (other.inuse) {
    const forward = vec3();
    AngleVectors(client.v_angle, forward, null, null);
    const end = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + ent.viewheight);
    end[0] += forward[0] * 8192;
    end[1] += forward[1] * 8192;
    end[2] += forward[2] * 8192;

    const traceStart = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + ent.viewheight);
    const tr = giTraceline(traceStart, end, other, MASK_SHOT | ContentsT.CONTENTS_MONSTERCLIP);
    other.s.origin[0] = tr.endpos[0];
    other.s.origin[1] = tr.endpos[1];
    other.s.origin[2] = tr.endpos[2];

    for (let i = 0; i < 3; i++) {
      if (tr.plane.normal[i] > 0) other.s.origin[i] -= other.mins[i] * tr.plane.normal[i];
      else other.s.origin[i] += other.maxs[i] * -tr.plane.normal[i];
    }

    while (gi.trace(other.s.origin, other.mins, other.maxs, other.s.origin, other, MASK_SHOT | ContentsT.CONTENTS_MONSTERCLIP).startsolid) {
      const dx = other.mins[0] - other.maxs[0];
      const dy = other.mins[1] - other.maxs[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      other.s.origin[0] -= forward[0] * dist;
      other.s.origin[1] -= forward[1] * dist;
      other.s.origin[2] -= forward[2] * dist;

      const diff = vec3_sub(other.s.origin, ent.s.origin);
      if (vec3_dot(diff, forward) < 0) {
        giClientPrint(ent, PrintTypeT.PRINT_HIGH, "Couldn't find a suitable spawn location\n");
        G_FreeEdict(other);
        break;
      }
    }

    if (other.inuse) gi.linkentity(other);

    if ((other.svflags & SvflagsT.SVF_MONSTER) !== 0 && other.think !== null) other.think(other);
  }

  ent.solid = backup;
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// Cmd_Teleport_f (g_cmds.cpp:479-507)
// ---------------------------------------------------------------------------

export function Cmd_Teleport_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  if (gi.argc() < 4) {
    giClientPrint(ent, PrintTypeT.PRINT_HIGH, "Not enough args; teleport x y z\n");
    return;
  }

  const client = ent.client;
  if (client === null) throw new Error("Cmd_Teleport_f: called against an entity with no .client set");

  ent.s.origin[0] = atofC(gi.argv(1));
  ent.s.origin[1] = atofC(gi.argv(2));
  ent.s.origin[2] = atofC(gi.argv(3));

  if (gi.argc() >= 4) {
    const pitch = atofC(gi.argv(4));
    const yaw = atofC(gi.argv(5));
    const roll = atofC(gi.argv(6));

    client.ps.pmove.delta_angles[0] = pitch - client.resp.cmd_angles[0];
    client.ps.pmove.delta_angles[1] = yaw - client.resp.cmd_angles[1];
    client.ps.pmove.delta_angles[2] = roll - client.resp.cmd_angles[2];
    client.ps.viewangles[0] = 0;
    client.ps.viewangles[1] = 0;
    client.ps.viewangles[2] = 0;
    client.v_angle[0] = 0;
    client.v_angle[1] = 0;
    client.v_angle[2] = 0;
  }

  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// Cmd_Notarget_f / Cmd_Novisible_f (g_cmds.cpp:518-557)
// ---------------------------------------------------------------------------

export function Cmd_Notarget_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  ent.flags ^= EntFlagsT.FL_NOTARGET;
  const msg = (ent.flags & EntFlagsT.FL_NOTARGET) === 0n ? "notarget OFF\n" : "notarget ON\n";
  giClientPrint(ent, PrintTypeT.PRINT_HIGH, msg);
}

export function Cmd_Novisible_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  ent.flags ^= EntFlagsT.FL_NOVISIBLE;
  const msg = (ent.flags & EntFlagsT.FL_NOVISIBLE) === 0n ? "novisible OFF\n" : "novisible ON\n";
  giClientPrint(ent, PrintTypeT.PRINT_HIGH, msg);
}

// ---------------------------------------------------------------------------
// Cmd_AlertAll_f (g_cmds.cpp:559-574)
// ---------------------------------------------------------------------------

export function Cmd_AlertAll_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  for (let i = 0; i < globals.num_edicts; i++) {
    const t = g_edicts[i];
    if (t === undefined || !t.inuse || t.health <= 0 || (t.svflags & SvflagsT.SVF_MONSTER) === 0) continue;

    t.enemy = ent;
    FoundTarget(t);
  }
}

// ---------------------------------------------------------------------------
// Cmd_Noclip_f (g_cmds.cpp:583-602)
// ---------------------------------------------------------------------------

export function Cmd_Noclip_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;

  let msg: string;
  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) {
    ent.movetype = MovetypeT.MOVETYPE_WALK;
    msg = "noclip OFF\n";
  } else {
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    msg = "noclip ON\n";
  }

  giClientPrint(ent, PrintTypeT.PRINT_HIGH, msg);
}

// ---------------------------------------------------------------------------
// Cmd_Use_f (g_cmds.cpp:611-657)
// ---------------------------------------------------------------------------

export function Cmd_Use_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Use_f: called against an entity with no .client set");

  if (ent.health <= 0 || ent.deadflag) return;

  const s = gi.args();
  const cmd = gi.argv(0);

  let it: GitemT | null;
  if (Q_strcasecmp(cmd, "use_index") === 0 || Q_strcasecmp(cmd, "use_index_only") === 0) {
    it = GetItemByIndex(atoiC(s));
  } else {
    it = FindItem(s);
  }

  if (it === null) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_unknown_item_name", s);
    return;
  }
  if (it.use === null) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_item_not_usable");
    return;
  }
  const index = it.id;

  if ((it.flags & ItemFlagsT.IF_WEAPON) === 0 && client.pers.inventory[index] === 0) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_out_of_item", it.pickup_name ?? "");
    return;
  }

  client.no_weapon_chains = Q_strcasecmp(gi.argv(0), "use") !== 0 && Q_strcasecmp(gi.argv(0), "use_index") !== 0;

  it.use(ent, it);

  ValidateSelectedItem(ent);
}

// ---------------------------------------------------------------------------
// Cmd_Drop_f (g_cmds.cpp:666-723)
// ---------------------------------------------------------------------------

export function Cmd_Drop_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Drop_f: called against an entity with no .client set");

  if (ent.health <= 0 || ent.deadflag) return;

  if (Q_strcasecmp(gi.args(), "tech") === 0) {
    const it = CTFWhat_Tech(ent);
    if (it !== null && it.drop !== null) {
      it.drop(ent, it);
      ValidateSelectedItem(ent);
    }
    return;
  }

  const s = gi.args();
  const cmd = gi.argv(0);

  let it: GitemT | null;
  if (Q_strcasecmp(cmd, "drop_index") === 0) {
    it = GetItemByIndex(atoiC(s));
  } else {
    it = FindItem(s);
  }

  if (it === null) {
    giClientPrint(ent, PrintTypeT.PRINT_HIGH, `Unknown item : ${s}\n`);
    return;
  }
  if (it.drop === null) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_item_not_droppable");
    return;
  }
  const index = it.id;
  if (client.pers.inventory[index] === 0) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_out_of_item", it.pickup_name ?? "");
    return;
  }

  it.drop(ent, it);

  ValidateSelectedItem(ent);
}

// ---------------------------------------------------------------------------
// Cmd_Inven_f (g_cmds.cpp:730-773)
// ---------------------------------------------------------------------------

export function Cmd_Inven_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Inven_f: called against an entity with no .client set");

  client.showscores = false;
  client.showhelp = false;

  globals.server_flags &= ~ServerFlagsT.SERVER_FLAG_SLOW_TIME;

  if (client.menu !== null) {
    PMenu_Close(ent);
    client.update_chase = true;
    return;
  }

  if (client.showinventory) {
    client.showinventory = false;
    return;
  }

  if (G_TeamplayEnabled() && client.resp.ctf_team === CtfteamT.CTF_NOTEAM) {
    CTFOpenJoinMenu(ent);
    return;
  }

  client.showinventory = true;

  gi.WriteByte(ServerCommandT.svc_inventory);
  let i = 0;
  for (i = 0; i < ItemIdT.IT_TOTAL; i++) gi.WriteShort(client.pers.inventory[i]);
  for (; i < MAX_ITEMS; i++) gi.WriteShort(0);
  gi.unicast(ent, true, GetUnicastKey());
}

/** ctf/p_ctf_menu.cpp:63 -- see file header. */
function PMenu_Close(_ent: EdictT): void {
  throw new Error("PMenu_Close: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp:63)");
}

// ---------------------------------------------------------------------------
// Cmd_InvUse_f (g_cmds.cpp:780-815)
// ---------------------------------------------------------------------------

/** ctf/p_ctf_menu.cpp:262 -- see file header. */
function PMenu_Select(_ent: EdictT): void {
  throw new Error("PMenu_Select: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp:262)");
}

export function Cmd_InvUse_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_InvUse_f: called against an entity with no .client set");

  if (client.menu !== null) {
    PMenu_Select(ent);
    return;
  }

  if (ent.health <= 0 || ent.deadflag) return;

  ValidateSelectedItem(ent);

  if (client.pers.selected_item === ItemIdT.IT_NULL) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_no_item_to_use");
    return;
  }

  const it = itemlist[client.pers.selected_item];
  if (it === undefined || it.use === null) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_item_not_usable");
    return;
  }

  client.no_weapon_chains = true;
  it.use(ent, it);

  ValidateSelectedItem(ent);
}

// ---------------------------------------------------------------------------
// Cmd_WeapPrev_f / Cmd_WeapNext_f / Cmd_WeapLast_f (g_cmds.cpp:822-937)
// ---------------------------------------------------------------------------

export function Cmd_WeapPrev_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_WeapPrev_f: called against an entity with no .client set");

  if (ent.health <= 0 || ent.deadflag) return;
  if (client.pers.weapon === null) return;

  client.no_weapon_chains = true;

  const selected_weapon = client.pers.weapon.id;

  for (let i = ItemIdT.IT_NULL + 1; i <= ItemIdT.IT_TOTAL; i++) {
    const index = (selected_weapon + ItemIdT.IT_TOTAL - i) % ItemIdT.IT_TOTAL;
    if (client.pers.inventory[index] === 0) continue;
    const it = itemlist[index];
    if (it === undefined || it.use === null) continue;
    if ((it.flags & ItemFlagsT.IF_WEAPON) === 0) continue;
    it.use(ent, it);
    if (client.newweapon === it) return;
  }
}

export function Cmd_WeapNext_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_WeapNext_f: called against an entity with no .client set");

  if (ent.health <= 0 || ent.deadflag) return;
  if (client.pers.weapon === null) return;

  client.no_weapon_chains = true;

  const selected_weapon = client.pers.weapon.id;

  for (let i = ItemIdT.IT_NULL + 1; i <= ItemIdT.IT_TOTAL; i++) {
    const index = (selected_weapon + i) % ItemIdT.IT_TOTAL;
    if (client.pers.inventory[index] === 0) continue;
    const it = itemlist[index];
    if (it === undefined || it.use === null) continue;
    if ((it.flags & ItemFlagsT.IF_WEAPON) === 0) continue;
    it.use(ent, it);
    if (client.newweapon === it) return;
  }
}

export function Cmd_WeapLast_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_WeapLast_f: called against an entity with no .client set");

  if (ent.health <= 0 || ent.deadflag) return;
  if (client.pers.weapon === null || client.pers.lastweapon === null) return;

  client.no_weapon_chains = true;

  const index = client.pers.lastweapon.id;
  if (client.pers.inventory[index] === 0) return;
  const it = itemlist[index];
  if (it === undefined || it.use === null) return;
  if ((it.flags & ItemFlagsT.IF_WEAPON) === 0) return;
  it.use(ent, it);
}

// ---------------------------------------------------------------------------
// Cmd_InvDrop_f (g_cmds.cpp:944-968)
// ---------------------------------------------------------------------------

export function Cmd_InvDrop_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_InvDrop_f: called against an entity with no .client set");

  if (ent.health <= 0 || ent.deadflag) return;

  ValidateSelectedItem(ent);

  if (client.pers.selected_item === ItemIdT.IT_NULL) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_no_item_to_drop");
    return;
  }

  const it = itemlist[client.pers.selected_item];
  if (it === undefined || it.drop === null) {
    giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_item_not_droppable");
    return;
  }
  it.drop(ent, it);

  ValidateSelectedItem(ent);
}

// ---------------------------------------------------------------------------
// Cmd_Kill_f (g_cmds.cpp:975-1002)
// ---------------------------------------------------------------------------

export function Cmd_Kill_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Kill_f: called against an entity with no .client set");

  if (client.resp.spectator) return;

  if (Gtime_subtract(level.time, client.respawn_time) < Gtime_from_sec(5)) return;

  ent.flags &= ~EntFlagsT.FL_GODMODE;
  ent.health = 0;

  if (Gtime_nonzero(client.tracker_pain_time)) RemoveAttackingPainDaemons(ent);

  if (client.owned_sphere !== null) {
    G_FreeEdict(client.owned_sphere);
    client.owned_sphere = null;
  }

  player_die(ent, ent, ent, 100000, vec3(0, 0, 0), { id: ModIdT.MOD_SUICIDE, friendly_fire: cvarInt("teamplay", "0") !== 0, no_point_loss: false });
}

// ---------------------------------------------------------------------------
// Cmd_Kill_AI_f (g_cmds.cpp:1009-1040)
// ---------------------------------------------------------------------------

export function Cmd_Kill_AI_f(ent: EdictT): void {
  if (cvarInt("sv_cheats", "0") === 0) {
    giClientPrint(ent, PrintTypeT.PRINT_HIGH, "Kill_AI: Cheats Must Be Enabled!\n");
    return;
  }

  const client = ent.client;
  if (client === null) throw new Error("Cmd_Kill_AI_f: called against an entity with no .client set");

  const start = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + ent.viewheight);
  const end = vec3(start[0] + client.v_forward[0] * 1024, start[1] + client.v_forward[1] * 1024, start[2] + client.v_forward[2] * 1024);

  const looked_at = giTraceline(start, end, ent, MASK_SHOT).ent;

  const numEdicts = globals.num_edicts;
  for (let edictIdx = 1; edictIdx < numEdicts; edictIdx++) {
    const edict = g_edicts[edictIdx];
    if (edict === undefined || !edict.inuse || edict === looked_at) continue;
    if ((edict.svflags & SvflagsT.SVF_MONSTER) === 0) continue;

    G_FreeEdict(edict);
  }

  giClientPrint(ent, PrintTypeT.PRINT_HIGH, "Kill_AI: All AI Are Dead...\n");
}

// ---------------------------------------------------------------------------
// Cmd_Where_f (g_cmds.cpp:1047-1058)
// ---------------------------------------------------------------------------

export function Cmd_Where_f(ent: EdictT | null): void {
  if (ent === null || ent.client === null) return;

  const origin = ent.s.origin;
  const location = `${origin[0].toFixed(1)} ${origin[1].toFixed(1)} ${origin[2].toFixed(1)} ${ent.client.ps.viewangles[0].toFixed(1)} ${ent.client.ps.viewangles[1].toFixed(1)} ${ent.client.ps.viewangles[2].toFixed(1)}\n`;
  giClientPrint(ent, PrintTypeT.PRINT_HIGH, `Location: ${location}\n`);
  gi.SendToClipBoard(location);
}

// ---------------------------------------------------------------------------
// Cmd_Clear_AI_Enemy_f (g_cmds.cpp:1065-1086)
// ---------------------------------------------------------------------------

export function Cmd_Clear_AI_Enemy_f(ent: EdictT): void {
  if (cvarInt("sv_cheats", "0") === 0) {
    giClientPrint(ent, PrintTypeT.PRINT_HIGH, "Cmd_Clear_AI_Enemy: Cheats Must Be Enabled!\n");
    return;
  }

  const numEdicts = globals.num_edicts;
  for (let edictIdx = 1; edictIdx < numEdicts; edictIdx++) {
    const edict = g_edicts[edictIdx];
    if (edict === undefined || !edict.inuse) continue;
    if ((edict.svflags & SvflagsT.SVF_MONSTER) === 0) continue;

    edict.monsterinfo.aiflags |= MonsterAiFlagsT.AI_FORGET_ENEMY;
  }

  giClientPrint(ent, PrintTypeT.PRINT_HIGH, "Cmd_Clear_AI_Enemy: Clear All AI Enemies...\n");
}

// ---------------------------------------------------------------------------
// Cmd_PutAway_f (g_cmds.cpp:1093-1106)
// ---------------------------------------------------------------------------

export function Cmd_PutAway_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_PutAway_f: called against an entity with no .client set");

  client.showscores = false;
  client.showhelp = false;
  client.showinventory = false;

  globals.server_flags &= ~ServerFlagsT.SERVER_FLAG_SLOW_TIME;

  if (client.menu !== null) PMenu_Close(ent);
  client.update_chase = true;
}

// ---------------------------------------------------------------------------
// PlayerSort / Cmd_Players_f (g_cmds.cpp:1108-1178)
// ---------------------------------------------------------------------------

function PlayerSort(a: number, b: number): number {
  const anum = game.clients[a].ps.stats[PlayerStatT.STAT_FRAGS];
  const bnum = game.clients[b].ps.stats[PlayerStatT.STAT_FRAGS];
  if (anum < bnum) return -1;
  if (anum > bnum) return 1;
  return 0;
}

const MAX_IDEAL_PACKET_SIZE = 1024;

export function Cmd_Players_f(ent: EdictT): void {
  const index: number[] = [];

  for (let i = 0; i < game.maxclients; i++) {
    if (game.clients[i].pers.connected) index.push(i);
  }

  index.sort(PlayerSort);

  let large = "";
  if (index.length > 0) {
    for (let i = 0; i < index.length; i++) {
      const frags = game.clients[index[i]].ps.stats[PlayerStatT.STAT_FRAGS];
      const small = `${frags} ${game.clients[index[i]].pers.netname}\n`;

      if (small.length + large.length > MAX_IDEAL_PACKET_SIZE - 50) {
        large += "...\n";
        break;
      }

      large += small;
    }

    // remove the last newline
    if (large.endsWith("\n")) large = large.slice(0, -1);
  }

  giLocClientPrint(ent, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_NO_NOTIFY, "$g_players", large, index.length);
}

// ---------------------------------------------------------------------------
// CheckFlood (g_cmds.cpp:1180-1211)
// ---------------------------------------------------------------------------

export function CheckFlood(ent: EdictT): boolean {
  const client = ent.client;
  if (client === null) throw new Error("CheckFlood: called against an entity with no .client set");

  const flood_msgs = cvarInt("flood_msgs", "4");

  if (flood_msgs !== 0) {
    if (level.time < client.flood_locktill) {
      giLocClientPrint(ent, PrintTypeT.PRINT_HIGH, "$g_flood_cant_talk", Math.trunc(Gtime_subtract(client.flood_locktill, level.time) / 1000));
      return true;
    }

    let i = client.flood_whenhead - flood_msgs + 1;
    if (i < 0) i = client.flood_when.length + i;
    if (i >= client.flood_when.length) i = 0;

    const flood_persecond = cvarFloat("flood_persecond", "4");
    const flood_waitdelay = cvarFloat("flood_waitdelay", "10");

    if (Gtime_nonzero(client.flood_when[i]) && Gtime_subtract(level.time, client.flood_when[i]) < Gtime_from_sec(flood_persecond)) {
      client.flood_locktill = Gtime_add(level.time, Gtime_from_sec(flood_waitdelay));
      giLocClientPrint(ent, PrintTypeT.PRINT_CHAT, "$g_flood_cant_talk", Math.trunc(flood_waitdelay));
      return true;
    }

    client.flood_whenhead = (client.flood_whenhead + 1) % client.flood_when.length;
    client.flood_when[client.flood_whenhead] = level.time;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cmd_Wave_f (g_cmds.cpp:1218-1386)
// ---------------------------------------------------------------------------

export function Cmd_Wave_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Wave_f: called against an entity with no .client set");

  const i = atoiC(gi.argv(1));

  if (ent.deadflag || ent.movetype === MovetypeT.MOVETYPE_NOCLIP) return;

  const do_animate = client.anim_priority <= AnimPriorityT.ANIM_WAVE && (client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) === 0;

  if (do_animate) client.anim_priority = AnimPriorityT.ANIM_WAVE;

  let other_notify_msg: string | null = null;
  let other_notify_none_msg: string | null = null;

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(0, 0, 0));
  void dir;

  let aiming_at: EdictT | null = null;
  let best_dist = -9999;

  for (const player of active_players()) {
    if (player === ent) continue;

    const cdir = vec3_sub(player.s.origin, start);
    const dist = vec3_normalize(cdir);

    const dot = vec3_dot(client.v_forward, cdir);

    if (dot < 0.97) continue;
    else if (dist < best_dist) continue;

    best_dist = dist;
    aiming_at = player;
  }

  switch (i) {
    case GestureType.GESTURE_FLIP_OFF:
      other_notify_msg = "$g_flipoff_other";
      other_notify_none_msg = "$g_flipoff_none";
      if (do_animate) {
        ent.s.frame = FRAME_flip01 - 1;
        client.anim_end = FRAME_flip12;
      }
      break;
    case GestureType.GESTURE_SALUTE:
      other_notify_msg = "$g_salute_other";
      other_notify_none_msg = "$g_salute_none";
      if (do_animate) {
        ent.s.frame = FRAME_salute01 - 1;
        client.anim_end = FRAME_salute11;
      }
      break;
    case GestureType.GESTURE_TAUNT:
      other_notify_msg = "$g_taunt_other";
      other_notify_none_msg = "$g_taunt_none";
      if (do_animate) {
        ent.s.frame = FRAME_taunt01 - 1;
        client.anim_end = FRAME_taunt17;
      }
      break;
    case GestureType.GESTURE_WAVE:
      other_notify_msg = "$g_wave_other";
      other_notify_none_msg = "$g_wave_none";
      if (do_animate) {
        ent.s.frame = FRAME_wave01 - 1;
        client.anim_end = FRAME_wave11;
      }
      break;
    case GestureType.GESTURE_POINT:
    default:
      other_notify_msg = "$g_point_other";
      other_notify_none_msg = "$g_point_none";
      if (do_animate) {
        ent.s.frame = FRAME_point01 - 1;
        client.anim_end = FRAME_point12;
      }
      break;
  }

  let has_a_target = false;

  if (i === GestureType.GESTURE_POINT) {
    for (const player of active_players()) {
      if (player === ent) continue;
      else if (!OnSameTeam(ent, player)) continue;

      has_a_target = true;
      break;
    }
  }

  if (i === GestureType.GESTURE_POINT && has_a_target) {
    if (CheckFlood(ent)) return;

    const traceEnd = vec3(start[0] + client.v_forward[0] * 2048, start[1] + client.v_forward[1] * 2048, start[2] + client.v_forward[2] * 2048);
    const tr = giTraceline(start, traceEnd, ent, MASK_SHOT & ~ContentsT.CONTENTS_WINDOW);
    other_notify_msg = "$g_point_other_ping";

    const key = GetUnicastKey();

    if (tr.fraction !== 1.0) {
      for (const player of active_players()) {
        if (player !== ent && !OnSameTeam(ent, player)) continue;

        gi.WriteByte(ServerCommandT.svc_poi);
        gi.WriteShort(POI_PING + (ent.s.number - 1));
        gi.WriteShort(5000);
        gi.WritePosition(tr.endpos);
        gi.WriteShort(level.pic_ping);
        gi.WriteByte(208);
        gi.WriteByte(SvcPoiFlagsT.POI_FLAG_NONE);
        gi.unicast(player, false, key);

        // g_local.h:172's `gi.local_sound(ent, channel, soundindex, volume, attn, timeofs, dupe_key = 0)`
        // convenience overload (`target = ent`, `origin = nullptr`, `ent = ent`) has no counterpart in
        // this port's KexGameImports (only the raw 9-arg game_import_t::local_sound exists there) --
        // called out directly, matching that overload's own forwarding body exactly.
        gi.local_sound(player, null, player, SoundchanT.CHAN_AUTO, gi.soundindex("misc/help_marker.wav"), 1.0, ATTN_NONE, 0.0, key);
        giLocClientPrint(player, PrintTypeT.PRINT_HIGH, other_notify_msg, client.pers.netname);
      }
    }
  } else {
    if (CheckFlood(ent)) return;

    let targ: EdictT | null = null;
    while ((targ = findradius(targ, ent.s.origin, 1024)) !== null) {
      if (ent === targ) continue;
      if (targ.client === null) continue;
      if (!gi.inPVS(ent.s.origin, targ.s.origin, false)) continue;

      if (aiming_at !== null && other_notify_msg !== null && aiming_at.client !== null) {
        giLocClientPrint(targ, PrintTypeT.PRINT_TTS, other_notify_msg, client.pers.netname, aiming_at.client.pers.netname);
      } else if (other_notify_none_msg !== null) {
        giLocClientPrint(targ, PrintTypeT.PRINT_TTS, other_notify_none_msg, client.pers.netname);
      }
    }

    if (aiming_at !== null && other_notify_msg !== null && aiming_at.client !== null) {
      giLocClientPrint(ent, PrintTypeT.PRINT_TTS, other_notify_msg, client.pers.netname, aiming_at.client.pers.netname);
    } else if (other_notify_none_msg !== null) {
      giLocClientPrint(ent, PrintTypeT.PRINT_TTS, other_notify_none_msg, client.pers.netname);
    }
  }

  client.anim_time = GTIME_ZERO;
}

// ---------------------------------------------------------------------------
// Cmd_Say_f (g_cmds.cpp:1396-1447) -- ported despite #ifndef KEX_Q2_GAME,
// see file header
// ---------------------------------------------------------------------------

export function Cmd_Say_f(ent: EdictT, arg0: boolean): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Say_f: called against an entity with no .client set");

  if (gi.argc() < 2 && !arg0) return;
  else if (CheckFlood(ent)) return;

  let text = `${client.pers.netname}: `;

  if (arg0) {
    text += gi.argv(0);
    text += " ";
    text += gi.args();
  } else {
    const p_in = gi.args();
    if (p_in.length >= 2 && p_in[0] === '"' && p_in[p_in.length - 1] === '"') {
      text += p_in.slice(1, -1);
    } else {
      text += p_in;
    }
  }

  // don't let text be too long for malicious reasons
  if (text.length > 150) text = text.slice(0, 150);

  if (!text.endsWith("\n")) text += "\n";

  if (cvarInt("sv_dedicated", "0") !== 0) giClientPrint(null, PrintTypeT.PRINT_CHAT, text);

  for (let j = 1; j <= game.maxclients; j++) {
    const other = g_edicts[j];
    if (other === undefined || !other.inuse) continue;
    if (other.client === null) continue;
    giClientPrint(other, PrintTypeT.PRINT_CHAT, text);
  }
}

// ---------------------------------------------------------------------------
// Cmd_PlayerList_f (g_cmds.cpp:1449-1479)
// ---------------------------------------------------------------------------

export function Cmd_PlayerList_f(ent: EdictT): void {
  let text = "";

  for (let i = 0; i < game.maxclients; i++) {
    const e2 = g_edicts[i + 1];
    if (e2 === undefined || !e2.inuse || e2.client === null) continue;

    const connectedMs = Gtime_subtract(level.time, e2.client.resp.entertime) / 1; // GTime is already ms-scale? see below
    const totalMs = Math.trunc(connectedMs);
    const minutes = Math.trunc(totalMs / 60000);
    const seconds = Math.trunc((totalMs % 60000) / 1000);

    const str = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} ${e2.client.ping} ${e2.client.resp.score} ${e2.client.pers.netname}${e2.client.resp.spectator ? " (spectator)" : ""}\n`;

    if (text.length + str.length > MAX_IDEAL_PACKET_SIZE - 50) {
      text += "...\n";
      break;
    }

    text += str;
  }

  if (text.length > 0) giClientPrint(ent, PrintTypeT.PRINT_HIGH, text);
}

// ---------------------------------------------------------------------------
// Cmd_Switchteam_f (g_cmds.cpp:1481-1568)
// ---------------------------------------------------------------------------

export function Cmd_Switchteam_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) throw new Error("Cmd_Switchteam_f: called against an entity with no .client set");

  if (!G_TeamplayEnabled()) return;

  if (cvarInt("g_teamplay_force_join", "0") !== 0) {
    let team1count = 0;
    let team2count = 0;

    for (let i = 1; i <= game.maxclients; i++) {
      const player = g_edicts[i];
      if (player === undefined || !player.inuse || player.client === null) continue;

      if (player.client.resp.ctf_team === CtfteamT.CTF_TEAM1) team1count++;
      else if (player.client.resp.ctf_team === CtfteamT.CTF_TEAM2) team2count++;
    }

    const best_team = team1count < team2count ? CtfteamT.CTF_TEAM1 : CtfteamT.CTF_TEAM2;

    if (client.resp.ctf_team !== best_team) {
      ent.svflags = SvflagsT.SVF_NONE;
      ent.flags &= ~EntFlagsT.FL_GODMODE;
      client.resp.ctf_team = best_team;
      client.resp.ctf_state = 0;
      const value = Info_ValueForKey(client.pers.userinfo, "skin");
      CTFAssignSkin(ent, value);

      CTFDirtyTeamMenu();

      if (ent.solid === SolidT.SOLID_NOT) {
        PutClientInServer(ent);
        G_PostRespawn(ent);

        giLocBroadcastPrint(PrintTypeT.PRINT_HIGH, "$g_joined_team", client.pers.netname, CTFTeamName(best_team));
        return;
      }

      ent.health = 0;
      player_die(ent, ent, ent, 100000, vec3(0, 0, 0), { id: ModIdT.MOD_SUICIDE, friendly_fire: true, no_point_loss: false });

      ent.deadflag = true;
      respawn(ent);

      client.resp.score = 0;

      giLocBroadcastPrint(PrintTypeT.PRINT_HIGH, "$g_changed_team", client.pers.netname, CTFTeamName(best_team));
    }

    return;
  }

  if (client.resp.ctf_team !== CtfteamT.CTF_NOTEAM) CTFObserver(ent);

  if (client.menu === null) CTFOpenJoinMenu(ent);
}

// ---------------------------------------------------------------------------
// Cmd_ListMonsters_f (g_cmds.cpp:1570-1590) -- `static`, not exported
// ---------------------------------------------------------------------------

function edictFmt(e: EdictT): string {
  const p = e.linked ? vec3_muls(vec3_add(e.absmax, e.absmin), 0.5) : e.s.origin;
  return `${e.classname ?? "?"} @ (${p[0]} ${p[1]} ${p[2]})`;
}

function Cmd_ListMonsters_f(ent: EdictT): void {
  if (!G_CheatCheck(ent)) return;
  else if (cvarInt("g_debug_monster_kills", "0") === 0) return;

  for (let i = 0; i < level.total_monsters; i++) {
    const e = level.monsters_registered[i];
    if (e === null || !e.inuse) continue;
    else if ((e.svflags & SvflagsT.SVF_MONSTER) === 0 || (e.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) !== 0n) continue;
    else if (e.deadflag) continue;

    gi.Com_Print(`${edictFmt(e)}\n`);
  }
}

// ---------------------------------------------------------------------------
// ClientCommand (g_cmds.cpp:1597-1753)
// ---------------------------------------------------------------------------

export function ClientCommand(ent: EdictT): void {
  if (ent.client === null) return; // not fully in game yet

  const cmd = gi.argv(0);

  if (Q_strcasecmp(cmd, "players") === 0) {
    Cmd_Players_f(ent);
    return;
  }
  // [Paril-KEX] these have to go through the lobby system -- ported despite
  // #ifndef KEX_Q2_GAME, see file header
  if (Q_strcasecmp(cmd, "say") === 0) {
    Cmd_Say_f(ent, false);
    return;
  }
  if (Q_strcasecmp(cmd, "say_team") === 0 || Q_strcasecmp(cmd, "steam") === 0) {
    if (G_TeamplayEnabled()) CTFSay_Team(ent, gi.args());
    else Cmd_Say_f(ent, false);
    return;
  }
  if (Q_strcasecmp(cmd, "score") === 0) {
    Cmd_Score_f(ent);
    return;
  }
  if (Q_strcasecmp(cmd, "help") === 0) {
    Cmd_Help_f(ent);
    return;
  }
  if (Q_strcasecmp(cmd, "listmonsters") === 0) {
    Cmd_ListMonsters_f(ent);
    return;
  }

  if (Gtime_nonzero(level.intermissiontime)) return;

  if (Q_strcasecmp(cmd, "target") === 0) Cmd_Target_f(ent);
  else if (Q_strcasecmp(cmd, "use") === 0 || Q_strcasecmp(cmd, "use_only") === 0 || Q_strcasecmp(cmd, "use_index") === 0 || Q_strcasecmp(cmd, "use_index_only") === 0) Cmd_Use_f(ent);
  else if (Q_strcasecmp(cmd, "drop") === 0 || Q_strcasecmp(cmd, "drop_index") === 0) Cmd_Drop_f(ent);
  else if (Q_strcasecmp(cmd, "give") === 0) Cmd_Give_f(ent);
  else if (Q_strcasecmp(cmd, "god") === 0) Cmd_God_f(ent);
  else if (Q_strcasecmp(cmd, "immortal") === 0) Cmd_Immortal_f(ent);
  else if (Q_strcasecmp(cmd, "setpoi") === 0) Cmd_SetPOI_f(ent);
  else if (Q_strcasecmp(cmd, "checkpoi") === 0) Cmd_CheckPOI_f(ent);
  else if (Q_strcasecmp(cmd, "spawn") === 0) Cmd_Spawn_f(ent);
  else if (Q_strcasecmp(cmd, "teleport") === 0) Cmd_Teleport_f(ent);
  else if (Q_strcasecmp(cmd, "notarget") === 0) Cmd_Notarget_f(ent);
  else if (Q_strcasecmp(cmd, "novisible") === 0) Cmd_Novisible_f(ent);
  else if (Q_strcasecmp(cmd, "alertall") === 0) Cmd_AlertAll_f(ent);
  else if (Q_strcasecmp(cmd, "noclip") === 0) Cmd_Noclip_f(ent);
  else if (Q_strcasecmp(cmd, "inven") === 0) Cmd_Inven_f(ent);
  else if (Q_strcasecmp(cmd, "invnext") === 0) SelectNextItem(ent, ItemFlagsT.IF_ANY);
  else if (Q_strcasecmp(cmd, "invprev") === 0) SelectPrevItem(ent, ItemFlagsT.IF_ANY);
  else if (Q_strcasecmp(cmd, "invnextw") === 0) SelectNextItem(ent, ItemFlagsT.IF_WEAPON);
  else if (Q_strcasecmp(cmd, "invprevw") === 0) SelectPrevItem(ent, ItemFlagsT.IF_WEAPON);
  else if (Q_strcasecmp(cmd, "invnextp") === 0) SelectNextItem(ent, ItemFlagsT.IF_POWERUP);
  else if (Q_strcasecmp(cmd, "invprevp") === 0) SelectPrevItem(ent, ItemFlagsT.IF_POWERUP);
  else if (Q_strcasecmp(cmd, "invuse") === 0) Cmd_InvUse_f(ent);
  else if (Q_strcasecmp(cmd, "invdrop") === 0) Cmd_InvDrop_f(ent);
  else if (Q_strcasecmp(cmd, "weapprev") === 0) Cmd_WeapPrev_f(ent);
  else if (Q_strcasecmp(cmd, "weapnext") === 0) Cmd_WeapNext_f(ent);
  else if (Q_strcasecmp(cmd, "weaplast") === 0 || Q_strcasecmp(cmd, "lastweap") === 0) Cmd_WeapLast_f(ent);
  else if (Q_strcasecmp(cmd, "kill") === 0) Cmd_Kill_f(ent);
  else if (Q_strcasecmp(cmd, "kill_ai") === 0) Cmd_Kill_AI_f(ent);
  else if (Q_strcasecmp(cmd, "where") === 0) Cmd_Where_f(ent);
  else if (Q_strcasecmp(cmd, "clear_ai_enemy") === 0) Cmd_Clear_AI_Enemy_f(ent);
  else if (Q_strcasecmp(cmd, "putaway") === 0) Cmd_PutAway_f(ent);
  else if (Q_strcasecmp(cmd, "wave") === 0) Cmd_Wave_f(ent);
  else if (Q_strcasecmp(cmd, "playerlist") === 0) Cmd_PlayerList_f(ent);
  else if (Q_strcasecmp(cmd, "team") === 0) CTFTeam_f(ent);
  else if (Q_strcasecmp(cmd, "id") === 0) CTFID_f(ent);
  else if (Q_strcasecmp(cmd, "yes") === 0) CTFVoteYes(ent);
  else if (Q_strcasecmp(cmd, "no") === 0) CTFVoteNo(ent);
  else if (Q_strcasecmp(cmd, "ready") === 0) CTFReady(ent);
  else if (Q_strcasecmp(cmd, "notready") === 0) CTFNotReady(ent);
  else if (Q_strcasecmp(cmd, "ghost") === 0) CTFGhost(ent);
  else if (Q_strcasecmp(cmd, "admin") === 0) CTFAdmin(ent);
  else if (Q_strcasecmp(cmd, "stats") === 0) CTFStats(ent);
  else if (Q_strcasecmp(cmd, "warp") === 0) CTFWarp(ent);
  else if (Q_strcasecmp(cmd, "boot") === 0) CTFBoot(ent);
  else if (Q_strcasecmp(cmd, "playerlist") === 0) CTFPlayerList(ent);
  else if (Q_strcasecmp(cmd, "observer") === 0) CTFObserver(ent);
  else if (Q_strcasecmp(cmd, "switchteam") === 0) Cmd_Switchteam_f(ent);
  else Cmd_Say_f(ent, true);
}
