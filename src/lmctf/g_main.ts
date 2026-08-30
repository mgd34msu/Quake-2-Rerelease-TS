// Ports a SUBSET of lmctf60/g_main.c and lmctf60/g_save.c's InitGame
// (diff of g_main.c vs quake-2/ctf/g_main.c is 785 lines of 858 total;
// InitGame itself lives in g_save.c per this pack's file layout, same as
// ctf's).
//
// STATUS: GetGameAPI, ShutdownGame, and a bounded InitGame are ported --
// enough to construct a GameExports object and register the cvars/edict
// array the offhand-hook priority feature's tests need (critically,
// `ctfflags`). ClientCommand below is a minimal hand-written dispatcher
// covering ONLY "hook"/"unhook" (lmctf60/g_cmds.c's real ClientCommand is a
// ~90-branch Q_stricmp chain against argv(0), not ported here).
//
// NOT PORTED, and reported explicitly rather than silently stubbed:
//   - G_RunFrame (the server frame loop: level.framenum/time advance,
//     per-entity think dispatch, end-of-frame client processing) --
//     RunFrame throws.
//   - SpawnEntities (map entity-string parsing via g_spawn.c) -- throws.
//   - ClientConnect/ClientBegin/ClientUserinfoChanged/ClientDisconnect/
//     ClientThink (p_client.c, not touched by this unit) -- throw.
//   - WriteGame/ReadGame/WriteLevel/ReadLevel (g_save.c save/load) -- throw.
//   - ServerCommand (g_svcmds.c) -- throws.
//   - InitGame's maplist.txt/motd.txt file I/O and StdLog/gslog
//     initialization (lmctf60 g_save.c's InitGame reads
//     `<gamedir>/<maplist_file>` and calls `ctf_SetLogName`/`sl_Logging`) --
//     not reproduced; this port's InitGame registers cvars and allocates
//     g_edicts/game.clients only.
//   - InitItems (g_items.c) -- g_items.ts's own InitItems() only
//     re-asserts `game.num_items` against its already-built (partial)
//     ITEMLIST; it does not precache models/sounds/images the way the C
//     source's InitItems does (no precache pipeline exists in this unit).
//
// Because RunFrame/SpawnEntities/ClientConnect all throw, a server booted
// through this GetGameAPI cannot reach "Server Initialization" the way a
// real game boot does -- see this unit's final report for what a real
// lmctf boot needs beyond this file.

import { CVAR_ARCHIVE, CVAR_LATCH, CVAR_NOSET, CVAR_SERVERINFO, CVAR_USERINFO } from "../shared/q_shared";
import { Cmd_Hook_f, Cmd_Unhook_f } from "./g_cmds";
import { InitItems } from "./g_items";
import { type Edict, GAME_API_VERSION, type GameExports, type GameImports } from "./game";
import {
  EdictT,
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
} from "./g_local";

function cvarNum(c: ReturnType<typeof gi.cvar>): number {
  return c === null ? 0 : c.value;
}

export function ShutdownGame(): void {
  gi.dprintf("==== ShutdownGame ====\n");
  // gi.FreeTags(TAG_LEVEL)/gi.FreeTags(TAG_GAME) dropped -- no tag-based
  // allocator on this side of the port, same as every other family.
}

function notPorted(name: string): () => never {
  return () => {
    throw new Error(`lmctf ${name}: not ported in this unit -- see g_main.ts's file header`);
  };
}

/*
=================
InitGame (lmctf60/g_save.c:141) -- PARTIAL, see file header.

Registers the cvar set the offhand-hook feature and its tests need
(critically `ctfflags`, gated by CTF_OFFHAND_HOOK/CTF_NO_GRAP_DAMAGE/
CTF_TEAM_NOTEAMS/CTF_TEAM_ARMOR_PROTECT/CTF_DM_POWER_ARMOR_STRENGTH -- see
g_local.ts/g_combat.ts/g_cmds.ts), plus the always-present baseq2 set.
Skips: the LM_CTF-only cvars this unit's ported files never read
(runes/refset/skinset/hostname/gamedir/motd_file/maplist_file/etc, all
declared but unused by anything in src/lmctf so far), the maplist.txt file
read, and StdLog/gslog initialization.
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

  gameCvars.sv_maplist = gi.cvar("sv_maplist", "", 0);

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

/*
=================
ClientCommand (lmctf60/g_cmds.c's real dispatch table, lines 2626/2628 for
the two entries reproduced here) -- MINIMAL, see file header. Dispatches
only "hook" and "unhook" (case-insensitive, matching Q_stricmp); every
other of the ~90 real commands falls through to nothing.
=================
*/
export function ClientCommand(ent: Edict): void {
  const cmd = gi.argv(0).toLowerCase();
  const fullEdict = g_edicts[ent.s.number];
  if (fullEdict === undefined) return;

  if (cmd === "hook") {
    Cmd_Hook_f(fullEdict);
  } else if (cmd === "unhook") {
    Cmd_Unhook_f(fullEdict);
  }
  // every other lmctf60/g_cmds.c command: not ported, see file header.
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
    SpawnEntities: notPorted("SpawnEntities"),

    WriteGame: notPorted("WriteGame"),
    ReadGame: notPorted("ReadGame"),
    WriteLevel: notPorted("WriteLevel"),
    ReadLevel: notPorted("ReadLevel"),

    ClientConnect: notPorted("ClientConnect"),
    ClientBegin: notPorted("ClientBegin"),
    ClientUserinfoChanged: notPorted("ClientUserinfoChanged"),
    ClientDisconnect: notPorted("ClientDisconnect"),
    ClientCommand,
    ClientThink: notPorted("ClientThink"),

    RunFrame: notPorted("RunFrame"),

    ServerCommand: notPorted("ServerCommand"),

    edicts: [],
    num_edicts: 0,
    max_edicts: 0,
  };

  SetGameExports(exportsObj);
  return exportsObj;
}
