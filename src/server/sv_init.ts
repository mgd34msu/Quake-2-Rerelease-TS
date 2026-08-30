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
  MAX_MODELS,
  MAX_SOUNDS,
  MAX_IMAGES,
  CS_NAME,
  CS_AIRACCEL,
  CS_MAPCHECKSUM,
  CS_MODELS,
  CS_SOUNDS,
  CS_IMAGES,
  MulticastT,
  CVAR_SERVERINFO,
  CVAR_LATCH,
  CVAR_NOSET,
  EntityStateT,
  UsercmdT,
  Q_stricmp,
} from "../shared/q_shared";
import { vec3_origin, VectorCopy } from "../shared/math";
import type { GameExports } from "../game/game";
import { sv, svs, master_adr, ServerStateT, ClientStateT, ClientT, sv_airaccelerate, sv_noreload, maxclients } from "./server";
import { SV_Shutdown } from "./sv_main";
import { SV_Multicast, SV_BroadcastCommand, SV_SendClientMessages } from "./sv_send";
import { geHolder, SV_InitGameProgs } from "./sv_game";
import { SV_ReadLevelFile } from "./sv_ccmds";
import { SV_ClearWorld } from "./sv_world";
import { SetPmAirAccelerate } from "../qcommon/pmove";

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
  return SV_FindIndex(name, CS_MODELS, MAX_MODELS, true);
}

export function SV_SoundIndex(name: string): number {
  return SV_FindIndex(name, CS_SOUNDS, MAX_SOUNDS, true);
}

export function SV_ImageIndex(name: string): number {
  return SV_FindIndex(name, CS_IMAGES, MAX_IMAGES, true);
}

function cloneEntityState(s: EntityStateT): EntityStateT {
  const c = new EntityStateT();
  c.number = s.number;
  VectorCopy(s.origin, c.origin);
  VectorCopy(s.angles, c.angles);
  VectorCopy(s.old_origin, c.old_origin);
  c.modelindex = s.modelindex;
  c.modelindex2 = s.modelindex2;
  c.modelindex3 = s.modelindex3;
  c.modelindex4 = s.modelindex4;
  c.frame = s.frame;
  c.skinnum = s.skinnum;
  c.effects = s.effects;
  c.renderfx = s.renderfx;
  c.solid = s.solid;
  c.sound = s.sound;
  c.event = s.event;
  return c;
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

  if (!sv.loadgame) {
    // coming back to a level after being in a different level, so run it
    // for ten seconds

    // rlava2 was sending too many lightstyles, and overflowing the reliable
    // data. temporarily changing the server state to loading prevents these
    // from being passed down.
    const previousState = sv.state;
    sv.state = ServerStateT.ss_loading;
    const ge = requireGe();
    for (let i = 0; i < 100; i++) ge.RunFrame();
    sv.state = previousState;
  }
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

  // wipe the entire per-level structure
  sv.clear();
  svs.realtime = 0;
  sv.loadgame = loadgame;
  sv.attractloop = attractloop;

  // save name for levels that don't set message
  sv.configstrings[CS_NAME] = server;
  if (Cvar_VariableValue("deathmatch")) {
    sv.configstrings[CS_AIRACCEL] = Com_sprintf("%g", sv_airaccelerate ? sv_airaccelerate.value : 0);
    SetPmAirAccelerate(sv_airaccelerate ? sv_airaccelerate.value : 0);
  } else {
    sv.configstrings[CS_AIRACCEL] = "0";
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
    sv.configstrings[CS_MODELS + 1] = `maps/${server}.bsp`;
    const loaded = CM_LoadMap(sv.configstrings[CS_MODELS + 1], false);
    sv.models[1] = loaded.model;
    checksum = loaded.checksum;
  }
  sv.configstrings[CS_MAPCHECKSUM] = `${checksum}`;

  // clear physics interaction links
  SV_ClearWorld();

  const numInline = CM_NumInlineModels();
  for (let i = 1; i < numInline; i++) {
    sv.configstrings[CS_MODELS + 1 + i] = `*${i}`;
    sv.models[i + 1] = CM_InlineModel(sv.configstrings[CS_MODELS + 1 + i]);
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
