// Ports a SUBSET of lmctf60/g_main.c and lmctf60/g_save.c's InitGame
// (diff of g_main.c vs quake-2/ctf/g_main.c is 785 lines of 858 total;
// InitGame itself lives in g_save.c per this pack's file layout, same as
// ctf's).
//
// STATUS (this unit's second pass): GetGameAPI now wires every entry point
// this unit built a real implementation for -- SpawnEntities (g_spawn.ts),
// ClientConnect/ClientBegin/ClientUserinfoChanged/ClientDisconnect/
// ClientThink (p_client.ts), WriteGame/ReadGame/WriteLevel/ReadLevel
// (g_save.ts), ServerCommand (g_svcmds.ts), and a new RunFrame/EndDMLevel/
// ExitLevel/CreateTargetChangeLevel/CheckDMRules/ClientEndServerFrames
// group (ported below, same shape as src/ctf/g_main.ts's G_RunFrame family
// with CTF-specific match/capture rules dropped -- see RunFrame's own doc
// comment). ClientCommand's real ~90-branch dispatch table now lives in
// g_cmds.ts (imported/re-exported here for GetGameAPI) -- see that file's
// own header for exactly which commands are ported.
//
// STILL NOT PORTED, reported explicitly:
//   - InitGame's maplist.txt/motd.txt/help.txt file I/O and StdLog/gslog
//     initialization -- not reproduced; InitGame registers cvars and
//     allocates g_edicts/game.clients only.
//   - InitItems (g_items.c) -- g_items.ts's own InitItems() only
//     re-asserts `game.num_items` against its already-built (partial)
//     ITEMLIST; no precache pipeline exists in this unit.
//   - RunFrame drops AI_SetSightClient and the groundentity-moved
//     M_CheckGround re-check (both monster-only; no monster subsystem
//     exists in this port, see g_phys.ts's own SV_Physics_Step citation)
//     and CTFNextMap/CTFCheckRules/CTFInMatch (ctf/g_ctf.c-specific match
//     logic with no LM_CTF equivalent ported -- g_tourney.ts now has a real
//     match-flow system (StartMatch/KillMatch/SetPause/SpawnTourneyClock/
//     Tourney_Think/Match_Start/Victory/Match_End), but nothing in this
//     RunFrame calls into it (that's g_cmds.ts's "startmatch"/"stopmatch"
//     client commands and g_menu.ts's referee menu, not a per-frame
//     RunFrame check in the C source either), so a capture-limit or
//     match-timer-driven level end still cannot be reached through this
//     RunFrame; only plain fraglimit/timelimit/DF_SAME_LEVEL/maplist
//     rotation work, matching base game's non-CTF EndDMLevel).

import { Com_sprintf, CVAR_ARCHIVE, CVAR_LATCH, CVAR_NOSET, CVAR_SERVERINFO, CVAR_USERINFO, PRINT_HIGH, Q_stricmp } from "../shared/q_shared";
import { ClientCommand } from "./g_cmds";
import { InitItems } from "./g_items";
import { type Edict, GAME_API_VERSION, type GameExports, type GameImports } from "./game";
import {
  EdictT,
  FRAMETIME,
  GAMEVERSION,
  GClientT,
  SetGEdicts,
  SetGameExports,
  SetGameImports,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
} from "./g_local";
import { G_Spawn } from "./g_utils";
import { G_RunEntity } from "./g_phys";
import { BeginIntermission } from "./p_hud";
import {
  ClientBegin,
  ClientBeginServerFrame,
  ClientConnect,
  ClientDisconnect,
  ClientThink,
  ClientUserinfoChanged,
} from "./p_client";
import { ClientEndServerFrame } from "./p_view";
import { ReadGame, ReadLevel, WriteGame, WriteLevel } from "./g_save";
import { ServerCommand } from "./g_svcmds";
import { SpawnEntities } from "./g_spawn";

function cvarNum(c: ReturnType<typeof gi.cvar>): number {
  return c === null ? 0 : c.value;
}
function cvarStr(c: ReturnType<typeof gi.cvar>): string {
  return c === null ? "" : c.string;
}

export function ShutdownGame(): void {
  gi.dprintf("==== ShutdownGame ====\n");
  // gi.FreeTags(TAG_LEVEL)/gi.FreeTags(TAG_GAME) dropped -- no tag-based
  // allocator on this side of the port, same as every other family.
}

/*
=================
InitGame (lmctf60/g_save.c:141) -- PARTIAL, see file header.

Registers the cvar set the offhand-hook feature and its tests need
(critically `ctfflags`, gated by CTF_OFFHAND_HOOK/CTF_NO_GRAP_DAMAGE/
CTF_TEAM_NOTEAMS/CTF_TEAM_ARMOR_PROTECT/CTF_DM_POWER_ARMOR_STRENGTH -- see
g_local.ts/g_combat.ts/g_cmds.ts) plus `refset`/`skinset` (now read by
g_ctffunc.ts's ctf_flagtouch), plus the always-present baseq2 set. Skips:
the remaining LM_CTF-only cvars this unit's ported files never read
(runes/hostname/gamedir/motd_file/maplist_file/etc, all declared but
unused by anything in src/lmctf so far), the maplist.txt file read, and
StdLog/gslog initialization.
=================
*/
export function InitGame(): void {
  gi.dprintf(`==== InitGame ${GAMEVERSION} ====\n`);

  gameCvars.sv_gravity = gi.cvar("sv_gravity", "800", 0);
  gameCvars.sv_maxvelocity = gi.cvar("sv_maxvelocity", "2000", 0);
  gameCvars.gun_x = gi.cvar("gun_x", "0", 0);
  gameCvars.gun_y = gi.cvar("gun_y", "0", 0);
  gameCvars.gun_z = gi.cvar("gun_z", "0", 0);
  gameCvars.sv_rollspeed = gi.cvar("sv_rollspeed", "200", 0);
  gameCvars.sv_rollangle = gi.cvar("sv_rollangle", "2", 0);

  gameCvars.dedicated = gi.cvar("dedicated", "0", CVAR_NOSET);

  gameCvars.sv_cheats = gi.cvar("cheats", "0", CVAR_SERVERINFO | CVAR_LATCH);
  gi.cvar("gamename", GAMEVERSION, CVAR_SERVERINFO | CVAR_LATCH);

  gameCvars.maxclients = gi.cvar("maxclients", "4", CVAR_SERVERINFO | CVAR_LATCH);
  gameCvars.maxspectators = gi.cvar("maxspectators", "24", CVAR_SERVERINFO); // -bat
  gameCvars.deathmatch = gi.cvar("deathmatch", "0", CVAR_LATCH);
  gameCvars.coop = gi.cvar("coop", "0", CVAR_LATCH);
  gameCvars.skill = gi.cvar("skill", "1", CVAR_LATCH);
  gameCvars.maxentities = gi.cvar("maxentities", "1024", CVAR_LATCH);

  gameCvars.dmflags = gi.cvar("dmflags", "0", CVAR_SERVERINFO);
  gameCvars.fraglimit = gi.cvar("fraglimit", "0", CVAR_SERVERINFO);
  gameCvars.timelimit = gi.cvar("timelimit", "0", CVAR_SERVERINFO);
  gameCvars.password = gi.cvar("password", "", CVAR_USERINFO);
  gameCvars.spectator_password = gi.cvar("spectator_password", "", CVAR_USERINFO);
  gameCvars.filterban = gi.cvar("filterban", "1", 0);

  gameCvars.g_select_empty = gi.cvar("g_select_empty", "0", CVAR_ARCHIVE);

  gameCvars.run_pitch = gi.cvar("run_pitch", "0.002", 0);
  gameCvars.run_roll = gi.cvar("run_roll", "0.005", 0);
  gameCvars.bob_up = gi.cvar("bob_up", "0.005", 0);
  gameCvars.bob_pitch = gi.cvar("bob_pitch", "0.002", 0);
  gameCvars.bob_roll = gi.cvar("bob_roll", "0.002", 0);

  // lmctf60/g_save.c: `ctfflags = gi.cvar("ctfflags", "0", CVAR_SERVERINFO);`
  gameCvars.ctfflags = gi.cvar("ctfflags", "0", CVAR_SERVERINFO);
  // lmctf60/g_save.c:210/214 -- needed by g_ctffunc.ts's ctf_flagtouch now
  // that the flag capture chain is ported.
  gameCvars.refset = gi.cvar("refset", "0", CVAR_SERVERINFO);
  gameCvars.skinset = gi.cvar("skinset", "0", CVAR_SERVERINFO);
  // lmctf60/g_save.c:237 -- `flag_init = gi.cvar("flag_init", "0", 0);`
  gameCvars.flag_init = gi.cvar("flag_init", "0", 0);
  // lmctf60/g_save.c:208 -- `runes = gi.cvar("runes", "15", CVAR_SERVERINFO);`
  // 15 = RUNE_DAMAGE|RUNE_RESIST|RUNE_HASTE|RUNE_REGEN (not RUNE_VAMP).
  gameCvars.runes = gi.cvar("runes", "15", CVAR_SERVERINFO);
  // lmctf60/g_save.c:223-224 -- match-flow cvars g_tourney.ts's
  // SetPause/KillMatch/StartMatch/SpawnTourneyClock read.
  gameCvars.autolock = gi.cvar("autolock", "0", 0);
  gameCvars.countdown_time = gi.cvar("countdown_time", "15", 0);
  // lmctf60/g_save.c:194 -- `railtime = gi.cvar("railtime", "0", CVAR_SERVERINFO);`
  gameCvars.railtime = gi.cvar("railtime", "0", CVAR_SERVERINFO);
  // lmctf60/g_save.c -- `fastswitch = gi.cvar("fastswitch", "0", 0);`
  gameCvars.fastswitch = gi.cvar("fastswitch", "0", 0);

  gameCvars.sv_maplist = gi.cvar("sv_maplist", "", 0);

  // RERELEASE CONTENT PORT (rogue/g_save.c's InitGame): the alternate
  // deathmatch ruleset selector the ported dm_tag content reads. CVAR_LATCH
  // matches rogue -- the ruleset may only change between levels. Default 0
  // is vanilla deathmatch, so nothing about classic LM-CTF play changes.
  /*
  RERELEASE CONTENT PORT -- registered WITHOUT CVAR_LATCH, deliberately, and
  this is the one place this module's registration differs from rogue's
  (rogue/g_save.ts registers the same cvar with CVAR_LATCH).

  WHY IT MUST EXIST AT ALL: SP_dm_tag_token and Tag_PickupToken both guard on
  `gamerules !== 2`, and a null cvar makes that guard FALSE -- which would
  leave a Tag token alive in a module that has no Tag ruleset to run it.
  Registered at its "0" default, the guard reads 0 !== 2 and frees the token,
  which is the correct behavior here.

  WHY IT MUST NOT BE LATCHED: the engine writes the latched-cvar list into
  the server save file (sv_init.ts's SV_WriteServerFile, which prints its own
  count). Latching this one takes that count from 31 to 32 on EVERY session,
  including a 1997-content one, which is a change a 1997 session can observe.
  Measured directly on q2ctf1: the developer log went from "31 latched
  cvar(s)" to "32 latched cvar(s)" and nothing else. The latch flag buys
  nothing here -- rogue needs it because rogue's InitGameRules samples
  gamerules once at level load to pick a DMGame, and this module has no
  InitGameRules; its only readers are the two Tag guards above, which read it
  live. So the flag is dropped and the 1997 serverfile stays byte-identical.
  */
  gameCvars.gamerules = gi.cvar("gamerules", "0", 0);
  gameCvars.g_showlogic = gi.cvar("g_showlogic", "0", 0);
  /*
  RERELEASE CONTENT PORT -- registered with NO flags, where rogue and the
  classic module use CVAR_SERVERINFO | CVAR_LATCH. Same reasoning as the
  `gamerules` registration above: the latched-cvar list goes into the server
  save file and CVAR_SERVERINFO goes onto the wire, so either flag would be
  observable to a 1997-content session under this ruleset. Measured on
  lmctf09: latching it took the developer log's count from 29 to 30 latched
  cvars. Its only reader is g_sphere.ts's hunter chase camera, which reads it
  live, so neither flag is load-bearing here.
  */
  gameCvars.huntercam = gi.cvar("huntercam", "1", 0);
  gameCvars.strong_mines = gi.cvar("strong_mines", "0", 0);
  gameCvars.randomrespawn = gi.cvar("randomrespawn", "0", 0);

  // items -- re-asserts game.num_items (see g_items.ts's InitItems comment:
  // a shared `game` singleton reset elsewhere, e.g. a test's game.clear(),
  // would otherwise silently invalidate FindItem/GetItemByIndex).
  InitItems();

  game.helpmessage1 = "";
  game.helpmessage2 = "";

  const numEntities = Math.floor(cvarNum(gameCvars.maxentities));
  game.maxentities = numEntities;
  SetGEdicts(makeEdicts(numEntities));
  globals.edicts = g_edicts;
  globals.max_edicts = numEntities;

  const numClients = Math.floor(cvarNum(gameCvars.maxclients));
  game.maxclients = numClients;
  game.clients = Array.from({ length: numClients }, () => new GClientT());

  globals.num_edicts = numClients + 1;
}

// zero-initialized EdictT per slot, `s.number` set to its own index -- same
// as src/ctf/g_save.ts's makeEdicts.
function makeEdicts(count: number): EdictT[] {
  const list: EdictT[] = [];
  for (let i = 0; i < count; i++) {
    const e = new EdictT();
    e.s.number = i;
    list.push(e);
  }
  return list;
}

// ClientCommand (lmctf60/g_cmds.c's real ~90-branch dispatch table) now
// lives in g_cmds.ts (matching src/ctf/g_cmds.ts's own
// ClientCommand-lives-here convention); imported at this file's top and
// re-exported here for test/lmctf_client.test.ts's existing `import {
// ClientCommand } from "../src/lmctf/g_main"` -- see g_cmds.ts's own file
// header for exactly which commands are ported and which still fall
// through to its chat catch-all.
export { ClientCommand };

/*
=================
CreateTargetChangeLevel (lmctf60/g_main.c) -- byte-identical to
src/ctf/g_main.ts's CreateTargetChangeLevel.
=================
*/
export function CreateTargetChangeLevel(map: string): EdictT {
  const ent = G_Spawn();
  ent.classname = "target_changelevel";
  level.nextmap = Com_sprintf("%s", map);
  ent.map = level.nextmap;
  return ent;
}

/*
=================
EndDMLevel (lmctf60/g_main.c) -- drops ctf's DF_SAME_LEVEL... no, keeps
DF_SAME_LEVEL and maplist rotation (both generic, no CTF dependency); drops
the `level.forcemap` branch entirely -- lmctf60's level_locals_t has no
forcemap field at all (confirmed dropped vs ctf/g_local.h's `char
forcemap[MAX_QPATH]`, see g_local.ts's LevelLocalsT comment), so that
branch cannot exist in this port, not just "not ported".
=================
*/
const DF_SAME_LEVEL = 0x00000020;
export function EndDMLevel(): void {
  if ((cvarNum(gameCvars.dmflags) & DF_SAME_LEVEL) !== 0) {
    BeginIntermission(CreateTargetChangeLevel(level.mapname));
    return;
  }

  const maplist = cvarStr(gameCvars.sv_maplist);
  if (maplist.length > 0) {
    const tokens = maplist.split(/[ ,\n\r]+/).filter((tok) => tok.length > 0);
    for (let idx = 0; idx < tokens.length; idx++) {
      const t = tokens[idx];
      if (t !== undefined && Q_stricmp(t, level.mapname) === 0) {
        const next = tokens[idx + 1];
        if (next === undefined) {
          const first = tokens[0];
          BeginIntermission(CreateTargetChangeLevel(first ?? level.mapname));
        } else {
          BeginIntermission(CreateTargetChangeLevel(next));
        }
        return;
      }
    }
  }

  // stay on same level (no maplist entry matched, no forcemap, no
  // DF_SAME_LEVEL flag -- same fallback base game's own EndDMLevel uses)
  BeginIntermission(CreateTargetChangeLevel(level.mapname));
}

/*
=================
CheckDMRules (lmctf60/g_main.c) -- fraglimit/timelimit only, see file
header for the dropped CTF capture-limit/match-timer branches.
=================
*/
export function CheckDMRules(): void {
  if (level.intermissiontime !== 0) return;
  if (cvarNum(gameCvars.deathmatch) === 0) return;

  const timelimit = cvarNum(gameCvars.timelimit);
  if (timelimit !== 0 && level.time >= timelimit * 60) {
    gi.bprintf(PRINT_HIGH, "Timelimit hit.\n");
    EndDMLevel();
    return;
  }

  const fraglimit = cvarNum(gameCvars.fraglimit);
  if (fraglimit !== 0) {
    const maxclients = cvarNum(gameCvars.maxclients);
    for (let i = 0; i < maxclients; i++) {
      const cl = game.clients[i];
      const ent = g_edicts[i + 1];
      if (cl === undefined || ent === undefined || !ent.inuse) continue;
      if (cl.resp.score >= fraglimit) {
        gi.bprintf(PRINT_HIGH, "Fraglimit hit.\n");
        EndDMLevel();
        return;
      }
    }
  }
}

/*
=================
ClientEndServerFrames (lmctf60/g_main.c) -- byte-identical to
src/ctf/g_main.ts's version, calling p_view.ts's (partial) ClientEndServerFrame.
=================
*/
export function ClientEndServerFrames(): void {
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse || ent.client === null) continue;
    ClientEndServerFrame(ent);
  }
}

/*
=================
ExitLevel (lmctf60/g_main.c) -- drops CTFNextMap (ctf/g_ctf.c-specific,
no LM_CTF equivalent ported), otherwise byte-identical to
src/ctf/g_main.ts's ExitLevel.
=================
*/
export function ExitLevel(): void {
  level.exitintermission = 0;
  level.intermissiontime = 0;

  const command = Com_sprintf('gamemap "%s"\n', level.changemap ?? "");
  gi.AddCommandString(command);
  ClientEndServerFrames();

  level.changemap = null;

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.client !== null && ent.health > ent.client.pers.max_health) {
      ent.health = ent.client.pers.max_health;
    }
  }
}

/*
=================
RunFrame (lmctf60/g_main.c's G_RunFrame) -- see file header for the dropped
AI_SetSightClient/M_CheckGround (monster-only, dead code in this port) and
CTF-specific match rules.
=================
*/
export function RunFrame(): void {
  level.framenum++;
  level.time = level.framenum * FRAMETIME;

  if (level.exitintermission !== 0) {
    ExitLevel();
    return;
  }

  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse) continue;

    level.current_entity = ent;

    ent.s.old_origin[0] = ent.s.origin[0];
    ent.s.old_origin[1] = ent.s.origin[1];
    ent.s.old_origin[2] = ent.s.origin[2];

    if (ent.groundentity !== null && ent.groundentity.linkcount !== ent.groundentity_linkcount) {
      ent.groundentity = null;
      // M_CheckGround(ent) -- monster-only, not ported (see file header);
      // SVF_MONSTER is never set by anything spawnable in this port, so
      // this branch's real-game monster re-grounding call would never
      // fire here regardless.
    }

    const maxclients = cvarNum(gameCvars.maxclients);
    if (i > 0 && i <= maxclients) {
      ClientBeginServerFrame(ent);
      continue;
    }

    G_RunEntity(ent);
  }

  CheckDMRules();

  ClientEndServerFrames();
}

/*
=================
GetGameAPI (lmctf60/g_main.c:156)
=================
*/
export function GetGameAPI(imports: GameImports): GameExports {
  SetGameImports(imports);

  const exportsObj: GameExports = {
    apiversion: GAME_API_VERSION,
    Init: InitGame,
    Shutdown: ShutdownGame,
    SpawnEntities,

    WriteGame,
    ReadGame,
    WriteLevel,
    ReadLevel,

    ClientConnect,
    ClientBegin,
    ClientUserinfoChanged,
    ClientDisconnect,
    ClientCommand,
    ClientThink,

    RunFrame,

    ServerCommand,

    edicts: [],
    num_edicts: 0,
    max_edicts: 0,
  };

  SetGameExports(exportsObj);
  return exportsObj;
}
