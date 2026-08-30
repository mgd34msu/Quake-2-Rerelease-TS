// sv_init.c

import { SysError, SvcOpsT, PORT_MASTER, UPDATE_BACKUP } from "../qcommon/qcommon";
import { CM_LoadMap, CM_InlineModel, CM_NumInlineModels, CM_EntityString } from "../qcommon/cmodel";
import { Cvar_Set, Cvar_FullSet, Cvar_VariableValue, Cvar_GetLatchedVars } from "../qcommon/cvar";
import { CL_DropHook, SCR_BeginLoadingPlaqueHook, Com_Printf, Com_DPrintf, Com_Error, Com_SetServerState, dedicated } from "../qcommon/common";
import { FS_FOpenFile, FS_FCloseFile } from "../qcommon/files";
import { NET_Config, NET_StringToAdr } from "../platform/net_udp";
import { Cbuf_CopyToDefer } from "../qcommon/cmd";
import { SZ_Clear, SZ_Init, MSG_WriteChar, MSG_WriteShort, MSG_WriteString } from "../qcommon/sizebuf";
import {
  Com_sprintf,
  ERR_DROP,
  MAX_CLIENTS,
  CS_NAME,
  MulticastT,
  CVAR_SERVERINFO,
  CVAR_LATCH,
  CVAR_NOSET,
  EntityStateT,
  UsercmdT,
  Q_stricmp,
} from "../shared/q_shared";
import { vec3_origin, VectorCopy } from "../shared/math";
import { cloneEntityState } from "../shared/state_copy";
import type { GameExports } from "../game/game";
import { sv, svs, master_adr, ServerStateT, ClientStateT, ClientT, sv_airaccelerate, sv_noreload, maxclients, sv_tick_rate } from "./server";
import { SV_Shutdown } from "./sv_main";
import { SV_Multicast, SV_BroadcastCommand, SV_SendClientMessages } from "./sv_send";
import { geHolder, SV_InitGameProgs, currentGameFamily } from "./sv_game";
import { SV_ReadLevelFile } from "./sv_ccmds";
import { SV_ClearWorld } from "./sv_world";
import { SetPmAirAccelerate } from "../qcommon/pmove";
import { Nav_Load, Nav_Unload } from "./nav";

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_init: ge used before SV_InitGameProgs");
  return ge;
}

/*
================
SV_FindIndex

================
*/
export function SV_FindIndex(name: string, start: number, max: number, create: boolean): number {
  if (!name || !name.length) return 0;

  let i = 1;
  for (; i < max && sv.configstrings[start + i].length; i++) {
    if (sv.configstrings[start + i] === name) return i;
  }

  if (!create) return 0;

  if (i === max) Com_Error(ERR_DROP, "*Index: overflow");

  sv.configstrings[start + i] = name;

  if (sv.state !== ServerStateT.ss_loading) {
    // send the update to everyone
    SZ_Clear(sv.multicast);
    MSG_WriteChar(sv.multicast, SvcOpsT.svc_configstring);
    MSG_WriteShort(sv.multicast, start + i);
    MSG_WriteString(sv.multicast, name);
    SV_Multicast(vec3_origin, MulticastT.MULTICAST_ALL_R);
  }

  return i;
}

export function SV_ModelIndex(name: string): number {
  return SV_FindIndex(name, svs.csr.models, svs.csr.max_models, true);
}

export function SV_SoundIndex(name: string): number {
  return SV_FindIndex(name, svs.csr.sounds, svs.csr.max_sounds, true);
}

export function SV_ImageIndex(name: string): number {
  return SV_FindIndex(name, svs.csr.images, svs.csr.max_images, true);
}

/*
================
SV_CreateBaseline

Entity baselines are used to compress the update messages
to the clients -- only the fields that differ from the
baseline will be transmitted
================
*/
export function SV_CreateBaseline(): void {
  const ge = requireGe();
  for (let entnum = 1; entnum < ge.num_edicts; entnum++) {
    const svent = ge.edicts[entnum];
    if (!svent.inuse) continue;
    if (!svent.s.modelindex && !svent.s.sound && !svent.s.effects) continue;
    svent.s.number = entnum;

    // take current state as baseline
    VectorCopy(svent.s.origin, svent.s.old_origin);
    // `sv.baselines[entnum] = svent.s;` is a struct copy in C; TS objects are
    // references, so cloning is required here or the baseline would alias
    // the live entity and "differ from baseline" comparisons would always
    // see zero delta.
    sv.baselines[entnum] = cloneEntityState(svent.s);
  }
}

/*
=================
SV_CheckForSavegame
=================
*/
export function SV_CheckForSavegame(): void {
  if (sv_noreload && sv_noreload.value) return;
  if (Cvar_VariableValue("deathmatch")) return;

  // C: fopen(FS_Gamedir() + "/save/current/" + sv.name + ".sav", "rb") just
  // to test existence. node:fs is restricted to platform/ and
  // qcommon/files.ts per PORTING.md (outside this unit's SCOPE), so this
  // goes through FS_FOpenFile's search-path lookup instead of a raw
  // absolute-path fopen. See report.
  const open = FS_FOpenFile(`save/current/${sv.name}.sav`);
  if (!open) return; // no savegame
  FS_FCloseFile(open.handle);

  SV_ClearWorld();

  // get configstrings and areaportals
  SV_ReadLevelFile(); // sv_ccmds.ts pending stub -- throws if a savegame is actually found; see report

  // q2repro save.c's SV_CheckForSavegame(cmd): LOAD_NORMAL (loading an
  // explicit savegame via the `load` command -- sv.loadgame is set true by
  // SV_Loadgame_f's own SV_Map(false, svs.mapcmd, true) call) runs only 2
  // frames ("called from SV_Loadgame_f" -- the savegame already captured a
  // fully-settled state, so this just lets one-shot post-load bookkeeping
  // run). LOAD_LEVEL_START (sv.loadgame false -- a normal level transition
  // reading back the autosave written at this level's own start) runs a
  // full ten seconds' worth so monsters/thinks that depend on elapsed time
  // catch up naturally. Vanilla's sv_init.c has no LOAD_NORMAL case at all
  // (always 0 frames when sv.loadgame is true); this distinction is a
  // q2repro-era addition -- ARCHITECTURE.md names q2repro the reference
  // specification for engine behavior generally, and this file already
  // family-dispatches other engine behavior (SV_ComputeFramerate) the same
  // way against the same reference.
  const frames = sv.loadgame ? 2 : 10 * sv.framerate;

  // rlava2 was sending too many lightstyles, and overflowing the reliable
  // data. temporarily changing the server state to loading prevents these
  // from being passed down. Applied to both branches here (q2repro's own
  // SV_CheckForSavegame doesn't carry this trick at all, but it is
  // unconditionally safe protective behavior against exactly the kind of
  // reliable-buffer overflow the SZ_GetSpace investigation in
  // .orch/followups.md is about) -- vanilla only guards the ten-second
  // branch since it never ran the 2-frame one at all.
  const previousState = sv.state;
  sv.state = ServerStateT.ss_loading;
  const ge = requireGe();
  for (let i = 0; i < frames; i++) ge.RunFrame();
  sv.state = previousState;
}

/*
================
SV_ComputeFramerate

Mirrors q2repro's set_frame_time() family dispatch (src/server/init.c:
136-148): the kex family honors `sv_tick_rate` (clamped to
Com_ComputeFrametime's Q_clip(rate/BASE_FRAMERATE, 1, MAX_FRAMEDIV=6)
range, i.e. BASE_FRAMERATE(10) * 1..6 = 10..60); every legacy family
(baseq2/ctf/xatrix/rogue -- still hardcoded to FRAMETIME = 0.1s in
g_local.ts) is pinned to BASE_FRAMERATE(10) regardless of what the cvar
holds. Split out of SV_SpawnServer as its own exported function so the
family-dispatch decision is directly unit-testable without spinning up a
full map load.
================
*/
export function SV_ComputeFramerate(): number {
  const tickRate = Math.min(60, Math.max(10, sv_tick_rate ? sv_tick_rate.value : 10));
  return currentGameFamily() === "kex" ? tickRate : 10;
}

/*
================
SV_SpawnServer

Change the server to a new map, taking all connected
clients along with it.
================
*/
export function SV_SpawnServer(server: string, spawnpoint: string, serverstate: ServerStateT, attractloop: boolean, loadgame: boolean): void {
  if (attractloop) Cvar_Set("paused", "0");

  Com_Printf("------- Server Initialization -------\n");

  Com_DPrintf("SpawnServer: %s\n", server);
  if (sv.demofile !== null) FS_FCloseFile(sv.demofile);

  svs.spawncount++; // any partially connected client will be restarted
  sv.state = ServerStateT.ss_dead;
  Com_SetServerState(sv.state);

  // free current level's nav data (init.c:124-125: "CM_FreeMap(&sv.cm);
  // Nav_Unload();", right before the memset `sv.clear()` mirrors below).
  // Idempotent (a no-op if nothing is loaded), so it's safe here regardless
  // of whether the previous level ever called Nav_Load at all.
  Nav_Unload();

  // wipe the entire per-level structure
  sv.clear();
  svs.realtime = 0;
  sv.loadgame = loadgame;
  sv.attractloop = attractloop;

  // set framerate parameters -- mirrors q2repro's set_frame_time() dispatch
  // (src/server/init.c:136-148), called right after the same memset there.
  // sv.clear() just re-asserted the 10Hz defaults (see its own comment);
  // SV_ComputeFramerate re-derives them from the latched cvar the same way
  // maxclients' already-latched value is read directly below
  // (`maxclients.value`, no extra Cvar_GetLatchedVars() call needed here --
  // SV_InitGame already settled it before SV_SpawnServer runs).
  sv.framerate = SV_ComputeFramerate();
  sv.frametime = 1000 / sv.framerate;

  // save name for levels that don't set message
  sv.configstrings[CS_NAME] = server;
  if (Cvar_VariableValue("deathmatch")) {
    sv.configstrings[svs.csr.airaccel] = Com_sprintf("%g", sv_airaccelerate ? sv_airaccelerate.value : 0);
    SetPmAirAccelerate(sv_airaccelerate ? sv_airaccelerate.value : 0);
  } else {
    sv.configstrings[svs.csr.airaccel] = "0";
    SetPmAirAccelerate(0);
  }

  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);

  sv.name = server;

  // leave slots at start for clients only
  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl) continue;
    if (cl.state > ClientStateT.cs_connected) cl.state = ClientStateT.cs_connected;
    cl.lastframe = -1;
  }

  sv.time = 1000;

  sv.name = server;
  sv.configstrings[CS_NAME] = server;

  let checksum: number;
  if (serverstate !== ServerStateT.ss_game) {
    const loaded = CM_LoadMap("", false); // no real map
    sv.models[1] = loaded.model;
    checksum = loaded.checksum;
  } else {
    sv.configstrings[svs.csr.models + 1] = `maps/${server}.bsp`;
    const loaded = CM_LoadMap(sv.configstrings[svs.csr.models + 1], false);
    sv.models[1] = loaded.model;
    checksum = loaded.checksum;

    // init.c:165-166: "sv.cm = cmd->cm; Nav_Load(cmd->server);" -- only on
    // the real-map (ss_game) path, never for the cinematic/demo/pic
    // fake-map branch above. Missing bots/navigation/<map>.nav is the
    // common case and is handled gracefully inside Nav_Load itself (see
    // nav.ts's header): it does not throw or block server startup.
    Nav_Load(server);
  }
  sv.configstrings[svs.csr.mapchecksum] = `${checksum}`;

  // clear physics interaction links
  SV_ClearWorld();

  const numInline = CM_NumInlineModels();
  for (let i = 1; i < numInline; i++) {
    sv.configstrings[svs.csr.models + 1 + i] = `*${i}`;
    sv.models[i + 1] = CM_InlineModel(sv.configstrings[svs.csr.models + 1 + i]);
  }

  //
  // spawn the rest of the entities on the map
  //

  // precache and static commands can be issued during map initialization
  sv.state = ServerStateT.ss_loading;
  Com_SetServerState(sv.state);

  // load and spawn all other entities
  const ge = requireGe();
  ge.SpawnEntities(sv.name, CM_EntityString(), spawnpoint);

  // run two frames to allow everything to settle
  ge.RunFrame();
  ge.RunFrame();

  // all precaches are complete
  sv.state = serverstate;
  Com_SetServerState(sv.state);

  // create a baseline for more efficient communications
  SV_CreateBaseline();

  // check for a savegame
  SV_CheckForSavegame();

  // set serverinfo variable
  Cvar_FullSet("mapname", sv.name, CVAR_SERVERINFO | CVAR_NOSET);

  Com_Printf("-------------------------------------\n");
}

/*
==============
SV_InitGame

A brand new game has been started
==============
*/
export async function SV_InitGame(): Promise<void> {
  if (svs.initialized) {
    // cause any connected clients to reconnect
    SV_Shutdown("Server restarted\n", true);
  } else {
    // make sure the client is down
    CL_DropHook();
    SCR_BeginLoadingPlaqueHook();
  }

  // get any latched variable changes (maxclients, etc)
  Cvar_GetLatchedVars();

  // C sets svs.initialized here, at the top. It is set at the bottom instead
  // because this function is async (NET_Config has to await a socket bind):
  // svs.initialized is what SV_Frame tests before touching the game library,
  // so setting it before the await lets a frame reach SV_RunGameFrame while
  // SV_InitGameProgs has not run yet. Nothing between here and the bottom
  // reads svs.initialized, so the move is behaviour-preserving.

  if (Cvar_VariableValue("coop") && Cvar_VariableValue("deathmatch")) {
    Com_Printf("Deathmatch and Coop both set, disabling Coop\n");
    Cvar_FullSet("coop", "0", CVAR_SERVERINFO | CVAR_LATCH);
  }

  // dedicated servers are can't be single player and are usually DM
  // so unless they explicity set coop, force it to deathmatch
  if (dedicated && dedicated.value) {
    if (!Cvar_VariableValue("coop")) Cvar_FullSet("deathmatch", "1", CVAR_SERVERINFO | CVAR_LATCH);
  }

  // init clients
  if (Cvar_VariableValue("deathmatch")) {
    if (!maxclients || maxclients.value <= 1) Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    else if (maxclients.value > MAX_CLIENTS) Cvar_FullSet("maxclients", `${MAX_CLIENTS}`, CVAR_SERVERINFO | CVAR_LATCH);
  } else if (Cvar_VariableValue("coop")) {
    if (!maxclients || maxclients.value <= 1 || maxclients.value > 4) Cvar_FullSet("maxclients", "4", CVAR_SERVERINFO | CVAR_LATCH);
    // Sys_CopyProtect() under #ifdef COPYPROTECT -- dropped, dead in every
    // real build (PORTING.md's #ifdef rule).
  } else {
    // non-deathmatch, non-coop is one player
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    // Sys_CopyProtect() under #ifdef COPYPROTECT -- dropped, see above.
  }

  svs.spawncount = Math.floor(Math.random() * 0x7fffffff);
  const maxc = maxclients ? maxclients.value : 0;
  svs.clients = Array.from({ length: maxc }, () => new ClientT());
  svs.num_client_entities = maxc * UPDATE_BACKUP * 64;
  svs.client_entities = Array.from({ length: svs.num_client_entities }, () => new EntityStateT());

  // init network stuff
  await NET_Config(maxc > 1);

  // heartbeats will always be sent to the id master
  svs.last_heartbeat = -99999; // send immediately
  NET_StringToAdr(`192.246.40.37:${PORT_MASTER}`, master_adr[0]);

  // init game
  SV_InitGameProgs(); // sv_game.ts pending stub -- throws until that unit lands; see report

  const ge = requireGe();
  for (let i = 0; i < maxc; i++) {
    const ent = ge.edicts[i + 1];
    ent.s.number = i + 1;
    svs.clients[i].edict = ent;
    svs.clients[i].lastcmd = new UsercmdT();
  }

  svs.initialized = true;
}

/*
======================
SV_Map

  the full syntax is:

  map [*]<map>$<startspot>+<nextserver>

command from the console or progs.
Map can also be a.cin, .pcx, or .dm2 file
Nextserver is used to allow a cinematic to play, then proceed to
another level:

	map tram.cin+jail_e3
======================
*/
export async function SV_Map(attractloop: boolean, levelstring: string, loadgame: boolean): Promise<void> {
  sv.loadgame = loadgame;
  sv.attractloop = attractloop;

  if (sv.state === ServerStateT.ss_dead && !sv.loadgame) await SV_InitGame(); // the game is just starting

  let level = levelstring;

  // if there is a + in the map, set nextserver to the remainder
  const plus = level.indexOf("+");
  if (plus >= 0) {
    const rest = level.slice(plus + 1);
    level = level.slice(0, plus);
    Cvar_Set("nextserver", `gamemap "${rest}"`);
  } else {
    Cvar_Set("nextserver", "");
  }

  // ZOID special hack for end game screen in coop mode
  if (Cvar_VariableValue("coop") && Q_stricmp(level, "victory.pcx") === 0) {
    Cvar_Set("nextserver", 'gamemap "*base1"');
  }

  // if there is a $, use the remainder as a spawnpoint
  let spawnpoint = "";
  const dollar = level.indexOf("$");
  if (dollar >= 0) {
    spawnpoint = level.slice(dollar + 1);
    level = level.slice(0, dollar);
  }

  // skip the end-of-unit flag if necessary
  if (level.startsWith("*")) level = level.slice(1);

  const l = level.length;
  if (l > 4 && level.slice(l - 4) === ".cin") {
    SCR_BeginLoadingPlaqueHook(); // for local system
    SV_BroadcastCommand("changing\n");
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_cinematic, attractloop, loadgame);
  } else if (l > 4 && level.slice(l - 4) === ".dm2") {
    SV_BroadcastCommand("changing\n");
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_demo, attractloop, loadgame);
  } else if (l > 4 && level.slice(l - 4) === ".pcx") {
    SV_BroadcastCommand("changing\n");
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_pic, attractloop, loadgame);
  } else {
    SV_BroadcastCommand("changing\n");
    SV_SendClientMessages();
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_game, attractloop, loadgame);
    Cbuf_CopyToDefer();
  }

  SV_BroadcastCommand("reconnect\n");
}
