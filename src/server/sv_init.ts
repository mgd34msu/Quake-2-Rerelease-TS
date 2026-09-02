// sv_init.c

import { SysError, SvcOpsT, PORT_MASTER, UPDATE_BACKUP, PROTOCOL_VERSION_RERELEASE_CLASSIC } from "../qcommon/qcommon";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, remapLegacyConfigstringIndex } from "../shared/cs_remap";
import { Q2REPRO_CLASSIC_CODEC } from "../qcommon/protocol/q2repro";
import { CM_LoadMap, CM_InlineModel, CM_NumInlineModels, CM_EntityString } from "../qcommon/cmodel";
import { Cvar_Set, Cvar_FullSet, Cvar_VariableValue, Cvar_GetLatchedVars } from "../qcommon/cvar";
import { CL_DropHook, SCR_BeginLoadingPlaqueHook, Com_Printf, Com_DPrintf, Com_Error, Com_SetServerState, Com_SetServerConnectProtocol, dedicated } from "../qcommon/common";
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
import { sv, svs, master_adr, ServerStateT, ClientStateT, ClientT, ServerEntityT, SV_MaxModels, SV_MaxEdicts, sv_airaccelerate, sv_noreload, maxclients, sv_tick_rate } from "./server";
import { SV_Shutdown } from "./sv_main";
import { SV_Multicast, SV_BroadcastCommand, SV_SendClientMessages } from "./sv_send";
import { geHolder, SV_InitGameProgs, currentGameFamily, SV_RunGamePostFrameHook } from "./sv_game";
import { SV_ReadLevelFile } from "./sv_ccmds";
import { SV_ClearWorld } from "./sv_world";
import { SetPmAirAccelerate } from "../qcommon/pmove";
import { Nav_Load, Nav_Unload, Nav_LegacyLoadEnabled } from "./nav";
import { SV_MvdMapChanged } from "./sv_mvd";

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
export function SV_FindIndex(name: string, start: number, max: number, create: boolean, reportOverflow = true): number {
  if (!name || !name.length) return 0;

  let i = 1;
  for (; i < max && sv.configstrings[start + i].length; i++) {
    if (sv.configstrings[start + i] === name) return i;
  }

  if (!create) return 0;

  if (i === max) {
    // `reportOverflow = false` is the widening path's probe (see
    // SV_FindIndexWidening below): the caller wants to know the block is full
    // so it can try to widen the session and retry, not to kill the server.
    // Every pre-existing caller leaves the default true and gets the original
    // Com_Error verbatim.
    if (!reportOverflow) return -1;
    Com_Error(ERR_DROP, "*Index: overflow");
  }

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

/*
================
SV_WidenConfigstringSpace

Move this session from the classic configstring layout (CS_REMAP_OLD: 256
models, 256 sounds, 256 images, 1024 edicts) to the wide one
(CS_REMAP_RERELEASE: 8192/2048/512/8192), mid-spawn, and keep the classic
game module running on top of it.

WHY THIS EXISTS. The 256-model ceiling is a property of the classic
CONFIGSTRING LAYOUT and of protocol 34's byte-wide modelindex field -- not of
the classic game module. That module stores modelindex/sound/image as plain
numbers and never sees a CsRemapT at all (it is an engine-side concept). So
there is nothing in the module that stops the engine hosting it over the wide
layout when the CONTENT needs it, which is exactly what the Call of the
Machine maps need under the classic ruleset: mgu4m1 alone precaches ~730
distinct model paths and used to die on SV_FindIndex's "*Index: overflow".

WHY IT IS AN ESCALATION AND NOT A SETTING. Choosing the wide layout up front
for every classic session would change the wire format of every classic game
this engine plays, including the ones that fit in the classic limits
perfectly well -- protocol 34 demos, vanilla clients, the lot. Escalating only
at the moment a block actually fills means a session whose content fits is
byte-for-byte the session it always was (still CS_REMAP_OLD, still
VANILLA_CODEC, still negotiating 34/35/36 per client), and only a session that
genuinely cannot be expressed in the classic layout pays for the wide one.

WHAT MOVES AND WHAT DOES NOT. The two layouts agree on every index below
`airaccel` (CS_NAME..CS_STATUSBAR), so those stay put. Everything at or above
it lives in one of the named blocks whose START index differs between the
families (CS_MODELS is 32 classic / 62 wide, CS_ITEMS 1056 / 11326, ...), so
the already-written contents of those blocks are relocated here, descending by
source index -- every destination is >= its source, so a descending pass never
overwrites a slot it has not yet copied out.

Crucially, what the game module holds onto does NOT move: modelindex, sound
and image values are offsets WITHIN their block (1, 2, 3, ...), and the block
contents move together with their offsets, so every index the module already
handed out stays valid. The two places a classic tree does embed a RAW
configstring index in data rather than passing it to gi.configstring()
(g_items.ts's STAT_PICKUP_STRING and p_hud.ts's STAT_CHASE) are remapped by
bindings/legacy.ts's own per-frame fixup pass, the same shim
bindings/legacy_kex.ts already uses for LMCTF.

WHEN IT REFUSES. Only during map load (ss_loading/ss_dead), and only from the
classic layout. Once clients are connected they have been told the classic
layout, so a late overflow must stay the hard error it always was rather than
silently relocating the space out from under them.
================
*/
export function SV_WidenConfigstringSpace(): boolean {
  if (svs.csr !== CS_REMAP_OLD) return false; // already wide (kex family, or a previous escalation this level)
  if (sv.state !== ServerStateT.ss_loading && sv.state !== ServerStateT.ss_dead) return false;

  // Relocate every already-written configstring into its wide-layout home.
  // Descending source order; see the header for why that is collision-free.
  for (let i = CS_REMAP_OLD.end - 1; i >= CS_REMAP_OLD.airaccel; i--) {
    const value = sv.configstrings[i];
    const dst = remapLegacyConfigstringIndex(i, CS_REMAP_OLD, CS_REMAP_RERELEASE);
    if (dst === i) continue;
    sv.configstrings[i] = "";
    sv.configstrings[dst] = value;
  }

  svs.csr = CS_REMAP_RERELEASE;
  // The wire from here on is 1038's, announced under this engine's own
  // protocol number so the client knows the module producing these wide
  // indices is the classic one -- see qcommon.ts's
  // PROTOCOL_VERSION_RERELEASE_CLASSIC doc comment.
  svs.codec = Q2REPRO_CLASSIC_CODEC;
  svs.sessionProtocol = PROTOCOL_VERSION_RERELEASE_CLASSIC;

  // sv.models/baselines/entities were allocated for the classic family by
  // sv.clear() (server.ts, sized off SV_MaxModels()/SV_MaxEdicts(), which
  // both read the live svs.csr). Grow them to the family that is now active
  // rather than relying on JS arrays extending themselves on write -- a read
  // past the old length would hand back `undefined` where the element types
  // promise `CmodelT | null` / a real EntityStateT.
  for (let i = sv.models.length; i < SV_MaxModels(); i++) sv.models[i] = null;
  for (let i = sv.baselines.length; i < SV_MaxEdicts(); i++) sv.baselines[i] = new EntityStateT();
  for (let i = sv.entities.length; i < SV_MaxEdicts(); i++) sv.entities[i] = new ServerEntityT();

  Com_Printf("Map exceeds the classic configstring limits; widening this session (protocol %i).\n", PROTOCOL_VERSION_RERELEASE_CLASSIC);
  return true;
}

// Shared body of SV_ModelIndex/SV_SoundIndex/SV_ImageIndex: look the name up
// in its block and, if the block is full, try to widen the whole session once
// and look again in the (relocated, much larger) block. `pick` is re-invoked
// after the widening because the block's start index and size both change
// with svs.csr.
function SV_FindIndexWidening(name: string, pick: () => { start: number; max: number }): number {
  const first = pick();
  const found = SV_FindIndex(name, first.start, first.max, true, false);
  if (found >= 0) return found;

  if (!SV_WidenConfigstringSpace()) {
    // Not widenable (already wide, or clients are already live on this
    // layout) -- the original hard error, unchanged.
    Com_Error(ERR_DROP, "*Index: overflow");
  }

  const wide = pick();
  return SV_FindIndex(name, wide.start, wide.max, true);
}

export function SV_ModelIndex(name: string): number {
  return SV_FindIndexWidening(name, () => ({ start: svs.csr.models, max: svs.csr.max_models }));
}

export function SV_SoundIndex(name: string): number {
  return SV_FindIndexWidening(name, () => ({ start: svs.csr.sounds, max: svs.csr.max_sounds }));
}

export function SV_ImageIndex(name: string): number {
  return SV_FindIndexWidening(name, () => ({ start: svs.csr.images, max: svs.csr.max_images }));
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
  // q2repro save.c:652 advances sv.framenum alongside every catch-up
  // RunFrame(false) (`for (...; i++, sv.framenum++) ge->RunFrame(false)`);
  // divergence-audit finding #27: our loop used to leave sv.framenum
  // untouched, so nothing ever recorded that these frames ran.
  for (let i = 0; i < frames; i++) {
    ge.RunFrame(false); // savegame catch-up, same mainLoop=false as q2repro
    sv.framenum++;
  }
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
    //
    // FAMILY GATE (not in init.c -- see nav.ts's "A DELIBERATE, DOCUMENTED
    // DEVIATION" header comment for the full citation trail and Mike's
    // ruling): the kex family loads nav unconditionally, matching upstream
    // exactly; the legacy family only loads it when `sv_nav_legacy` is on,
    // default off.
    if (currentGameFamily() === "kex" || Nav_LegacyLoadEnabled()) {
      Nav_Load(server);
    }
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
  SV_RunGamePostFrameHook();

  // run two frames to allow everything to settle -- mainLoop=false per
  // q2repro init.c's explicit ge->RunFrame(false) here, bypassing the kex
  // game's no-player-spawned early-out (see game.ts RunFrame's doc comment;
  // hardcoded true in the binding meant these frames settled nothing).
  // init.c:202-203 also advances sv.framenum alongside each of these two
  // calls (`for (i = 0; i < 2; i++, sv.framenum++) ge->RunFrame(false);`).
  ge.RunFrame(false);
  SV_RunGamePostFrameHook();
  sv.framenum++;
  ge.RunFrame(false);
  SV_RunGamePostFrameHook();
  sv.framenum++;

  // all precaches are complete
  sv.state = serverstate;
  Com_SetServerState(sv.state);
  // Tell the in-process client which protocol this SESSION demands
  // (SVC_DirectConnect: kex accepts only 1038; a classic session that had to
  // widen accepts only PROTOCOL_VERSION_RERELEASE_CLASSIC; an unwidened
  // classic session negotiates per client, signaled as 0). The localhost
  // connect path skips getchallenge entirely, so this bridge is its only
  // source of that fact -- see Com_ServerConnectProtocol's doc comment for
  // the campaign-start connect loop this fixes.
  //
  // Read AFTER SpawnEntities and the two settle frames above, which is what
  // makes the escalation visible here: SV_WidenConfigstringSpace can only
  // fire while those are running, so svs.sessionProtocol is final by now.
  Com_SetServerConnectProtocol(svs.sessionProtocol);

  // create a baseline for more efficient communications
  SV_CreateBaseline();

  // check for a savegame
  SV_CheckForSavegame();

  // respawn dummy MVD client, rebuild the MVD delta-compressor's baseline,
  // etc. (init.c:216, right after SV_CheckForSavegame and before the
  // serverinfo update below -- matches the reference's ordering)
  SV_MvdMapChanged();

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
    // q2repro init.c:449-455 only floors coop maxclients to 4 when it's
    // <=1 (a config with no maxclients set at all); above that it's
    // clamped to MAX_CLIENTS like every other mode, not forced back down
    // to 4 -- the rerelease-era engine supports coop beyond 4 players.
    if (!maxclients || maxclients.value <= 1) Cvar_FullSet("maxclients", "4", CVAR_SERVERINFO | CVAR_LATCH);
    else if (maxclients.value > MAX_CLIENTS) Cvar_FullSet("maxclients", `${MAX_CLIENTS}`, CVAR_SERVERINFO | CVAR_LATCH);
    // Sys_CopyProtect() under #ifdef COPYPROTECT -- dropped, dead in every
    // real build (PORTING.md's #ifdef rule).
  } else {
    // non-deathmatch, non-coop is one player
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    // Sys_CopyProtect() under #ifdef COPYPROTECT -- dropped, see above.
  }

  const maxc = maxclients ? maxclients.value : 0;

  // init network stuff. This is the function's only await, and it must run
  // here, before any of svs' shared fields are touched below -- matching
  // q2repro's init.c:455-471, where NET_Config(NET_SERVER) runs before the
  // client pool (svs.client_pool) is allocated. q2repro's SV_InitGame is
  // fully synchronous end to end (init.c), so nothing there can ever be
  // observably interrupted mid-initialization; callers here (SV_Frame,
  // console commands, connectionless packet handling) can run in between
  // our awaits, and several of them read/mutate svs.clients without
  // checking svs.initialized (e.g. sv_ccmds.ts:1117's `!svs.clients.length`
  // free-slot scan, sv_main.ts's connectionless "connect" handler). Putting
  // the await before svs.clients/svs.spawncount/svs.num_client_entities/
  // svs.client_entities are (re)built means every one of those fields
  // changes in a single synchronous slice with no yield point in the
  // middle, so an interleaved caller either sees the fully-old state or
  // the fully-new state -- never a half-built svs.clients array with
  // unwired edicts.
  await NET_Config(maxc > 1);

  svs.spawncount = Math.floor(Math.random() * 0x7fffffff);
  svs.clients = Array.from({ length: maxc }, () => new ClientT());
  svs.num_client_entities = maxc * UPDATE_BACKUP * 64;
  svs.client_entities = Array.from({ length: svs.num_client_entities }, () => new EntityStateT());

  // heartbeats will always be sent to the id master
  svs.last_heartbeat = -99999; // send immediately
  NET_StringToAdr(`192.246.40.37:${PORT_MASTER}`, master_adr[0]);

  // init game
  SV_InitGameProgs(); // sv_game.ts is a real implementation now (no longer a throwing stub)

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
