// sv_ccmds.c -- operator console commands
//
// These commands can only be entered from stdin or by a remote operator
// datagram (OPERATOR CONSOLE ONLY COMMANDS, per the C header comment).
//
// File-I/O: files.ts now exports write primitives (FS_WriteFile,
// FS_RemoveFile, FS_ReadRawFile, FS_FOpenFileWrite, FS_Write) alongside its
// original read primitives, so every C fwrite()/remove()/fopen(...,"wb")
// call below (SV_WipeSavegame's remove(), CopyFile's fwrite loop,
// SV_WriteLevelFile's and SV_WriteServerFile's fopen(...,"wb"),
// SV_ServerRecord_f's demo file) now does the real thing instead of a
// logged no-op. SV_WriteLevelFile/SV_WriteServerFile/SV_ServerRecord_f still
// call through to `ge.WriteLevel`/`WriteGame`/(SV_ReadServerFile's
// `ge.ReadGame`), implemented by g_save.ts (a sibling
// unit's concurrent work, not touched here) -- that remains the actually-
// blocking reason `save`/`load` cannot complete end-to-end yet, not a
// file-I/O gap.

import { Com_sprintf, MAX_OSPATH, MAX_TOKEN_CHARS, MAX_QPATH, CS_NAME, STAT_HEALTH, STAT_FRAGS, PRINT_HIGH, PRINT_CHAT, CVAR_LATCH, PlayerStateT, BigShort, MAX_CONFIGSTRINGS } from "../shared/q_shared";
import { SysError, NetadrT, NetsrcT, PORT_MASTER, SvcOpsT, PROTOCOL_VERSION } from "../qcommon/qcommon";
import { Com_Printf, Com_DPrintf, Info_Print, dedicated } from "../qcommon/common";
import { Cvar_Set, Cvar_VariableValue, Cvar_VariableString, Cvar_ForceSet, Cvar_Serverinfo, cvar_vars } from "../qcommon/cvar";
import { Cmd_Argc, Cmd_Argv, Cmd_Args, Cmd_AddCommand } from "../qcommon/cmd";
import { FS_Gamedir, FS_CreatePath, FS_FOpenFile, FS_FCloseFile, FS_Read, FS_ReadRaw, FS_ListFiles, FS_LoadFile, FS_WriteFile, FS_RemoveFile, FS_ReadRawFile, FS_FOpenFileWrite, FS_Write } from "../qcommon/files";
import { SizeBuf, SZ_Init, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteString } from "../qcommon/sizebuf";
import { CM_WritePortalState, CM_ReadPortalState } from "../qcommon/cmodel";
import { MAX_MAP_AREAPORTALS } from "../qcommon/qfiles";
import { Netchan_OutOfBandPrint } from "../qcommon/net_chan";
import { NET_StringToAdr, NET_AdrToString, NET_Config } from "../platform/net_udp";
import type { GameExports } from "../game/game";
import { sv, svs, master_adr, MAX_MASTERS, ServerStateT, ClientStateT, ClientT, maxclients, svClientHolder, svPlayerHolder } from "./server";
import { geHolder } from "./sv_game";
import { SV_DropClient, SV_Shutdown } from "./sv_main";
import { SV_BroadcastPrintf, SV_ClientPrintf } from "./sv_send";
import { SV_Map, SV_InitGame } from "./sv_init";

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_ccmds: ge used before SV_InitGameProgs");
  return ge;
}

function requireSvClient(): ClientT {
  const cl = svClientHolder.sv_client;
  if (!cl) throw new SysError("sv_ccmds: sv_client used before being set");
  return cl;
}

// game.h's gclient_s server-visible prefix (`{ player_state_t ps; int
// ping; }`); duplicated from sv_main.ts's identical module-private helper
// (not exported there) -- see that file's report for the suggested real fix
// (a `GClientPublic` interface alongside `Edict` in game.ts).
interface GClientPublic {
  ps: PlayerStateT;
  ping: number;
}
function isGClientPublic(client: unknown): client is GClientPublic {
  if (typeof client !== "object" || client === null) return false;
  if (!("ps" in client) || !("ping" in client)) return false;
  return client.ps instanceof PlayerStateT && typeof client.ping === "number";
}

// Wraps an async command handler for Cmd_AddCommand, whose handler type is
// synchronous (`(() => void) | null`); rejections are reported via
// Com_Printf instead of becoming an unhandled promise rejection.
function fireAndForget(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      Com_Printf("%s: %s\n", name, msg);
    });
  };
}

/*
===============================================================================

OPERATOR CONSOLE ONLY COMMANDS

These commands can only be entered from stdin or by a remote operator datagram
===============================================================================
*/

/*
====================
SV_SetMaster_f

Specify a list of master servers
====================
*/
function SV_SetMaster_f(): void {
  // only dedicated servers send heartbeats
  if (!dedicated || !dedicated.value) {
    Com_Printf("Only dedicated servers use masters.\n");
    return;
  }

  // make sure the server is listed public
  Cvar_Set("public", "1");

  for (let i = 1; i < MAX_MASTERS; i++) master_adr[i] = new NetadrT();

  let slot = 1; // slot 0 will always contain the id master
  const argc = Cmd_Argc();
  for (let i = 1; i < argc; i++) {
    if (slot === MAX_MASTERS) break;

    // C writes into master_adr[i] but reads back master_adr[slot] below --
    // preserved bug-for-bug (see PORTING.md's faithful-port rule).
    if (!NET_StringToAdr(Cmd_Argv(i), master_adr[i])) {
      Com_Printf("Bad address: %s\n", Cmd_Argv(i));
      continue;
    }
    if (master_adr[slot].port === 0) master_adr[slot].port = BigShort(PORT_MASTER);

    Com_Printf("Master server at %s\n", NET_AdrToString(master_adr[slot]));
    Com_Printf("Sending a ping.\n");

    Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, master_adr[slot], "ping");

    slot++;
  }

  svs.last_heartbeat = -9999999;
}

/*
==================
SV_SetPlayer

Sets sv_client and sv_player to the player with idnum Cmd_Argv(1)
==================
*/
function SV_SetPlayer(): boolean {
  if (Cmd_Argc() < 2) return false;

  const s = Cmd_Argv(1);

  // numeric values are just slot numbers
  const c0 = s.charCodeAt(0);
  if (c0 >= 48 /* '0' */ && c0 <= 57 /* '9' */) {
    const idnum = atoi(s);
    const maxc = maxclients ? maxclients.value : 0;
    if (idnum < 0 || idnum >= maxc) {
      Com_Printf("Bad client slot: %i\n", idnum);
      return false;
    }

    const cl = svs.clients[idnum];
    svClientHolder.sv_client = cl;
    svPlayerHolder.sv_player = cl.edict;
    if (!cl.state) {
      Com_Printf("Client %i is not active\n", idnum);
      return false;
    }
    return true;
  }

  // check for a name match
  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl.state) continue;
    if (cl.name === s) {
      svClientHolder.sv_client = cl;
      svPlayerHolder.sv_player = cl.edict;
      return true;
    }
  }

  Com_Printf("Userid %s is not on the server\n", s);
  return false;
}

/*
===============================================================================

SAVEGAME FILES

===============================================================================
*/

/*
=====================
SV_WipeSavegame

Delete save/<XXX>/
=====================
*/
function SV_WipeSavegame(savename: string): void {
  Com_DPrintf("SV_WipeSaveGame(%s)\n", savename);

  const dir = `${FS_Gamedir()}/save/${savename}`;
  FS_RemoveFile(`${dir}/server.ssv`);
  FS_RemoveFile(`${dir}/game.ssv`);

  // Sys_FindFirst/Sys_FindNext glob-delete loops become FS_ListFiles +
  // FS_RemoveFile per match.
  for (const path of FS_ListFiles(`${dir}/*.sav`) ?? []) FS_RemoveFile(path);
  for (const path of FS_ListFiles(`${dir}/*.sv2`) ?? []) FS_RemoveFile(path);
}

/*
================
CopyFile
================
*/
function CopyFile(src: string, dst: string): void {
  Com_DPrintf("CopyFile (%s, %s)\n", src, dst);

  // fopen(src,"rb") + fopen(dst,"wb") + fread/fwrite loop. src/dst are
  // already fully-qualified filesystem paths (built off FS_Gamedir()), not
  // filenames to resolve through the virtual quake search path, so the raw
  // (non-virtual) FS_ReadRawFile/FS_WriteFile pair is used rather than
  // FS_LoadFile/FS_FOpenFile.
  const data = FS_ReadRawFile(src);
  if (data === null) return; // f1 = fopen(src,"rb"); if (!f1) return;
  FS_WriteFile(dst, data);
}

/*
================
SV_CopySaveGame
================
*/
function SV_CopySaveGame(src: string, dst: string): void {
  Com_DPrintf("SV_CopySaveGame(%s, %s)\n", src, dst);

  SV_WipeSavegame(dst);

  // copy the savegame over
  const name = `${FS_Gamedir()}/save/${src}/server.ssv`;
  const name2 = `${FS_Gamedir()}/save/${dst}/server.ssv`;
  FS_CreatePath(name2);
  CopyFile(name, name2);

  CopyFile(`${FS_Gamedir()}/save/${src}/game.ssv`, `${FS_Gamedir()}/save/${dst}/game.ssv`);

  const srcDir = `${FS_Gamedir()}/save/${src}`;
  const found = FS_ListFiles(`${srcDir}/*.sav`) ?? [];
  for (const path of found) {
    const base = path.slice(srcDir.length + 1);

    CopyFile(path, `${FS_Gamedir()}/save/${dst}/${base}`);

    // change sav to sv2
    const sv2Base = `${base.slice(0, -3)}sv2`;
    CopyFile(`${srcDir}/${sv2Base}`, `${FS_Gamedir()}/save/${dst}/${sv2Base}`);
  }
}

// char configstrings[MAX_CONFIGSTRINGS][MAX_QPATH] -- the fixed-width C
// on-disk layout SV_WriteLevelFile/SV_ReadLevelFile fwrite/FS_Read as one
// giant blob. sv.configstrings here is a `string[]`, so round-tripping the
// same byte layout needs an explicit encode/decode pair.
function decodeConfigstringsBlock(buf: Uint8Array): void {
  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    const base = i * MAX_QPATH;
    let s = "";
    for (let j = 0; j < MAX_QPATH; j++) {
      const b = buf[base + j];
      if (!b) break;
      s += String.fromCharCode(b);
    }
    sv.configstrings[i] = s;
  }
}

// Reverse of decodeConfigstringsBlock: packs sv.configstrings back into the
// same fixed-width (MAX_CONFIGSTRINGS * MAX_QPATH), null-padded byte layout
// fwrite(sv.configstrings, sizeof(sv.configstrings), 1, f) produces in C.
function encodeConfigstringsBlock(): Uint8Array {
  const buf = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH);
  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    const base = i * MAX_QPATH;
    const s = sv.configstrings[i];
    for (let j = 0; j < s.length && j < MAX_QPATH; j++) {
      buf[base + j] = s.charCodeAt(j) & 0xff;
    }
  }
  return buf;
}

/*
==============
SV_WriteLevelFile

==============
*/
function SV_WriteLevelFile(): void {
  Com_DPrintf("SV_WriteLevelFile()\n");

  const name = `${FS_Gamedir()}/save/current/${sv.name}.sv2`;
  // fopen(name,"wb") + fwrite(sv.configstrings) + CM_WritePortalState(f)
  const portalState = CM_WritePortalState();
  const combined = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH + portalState.length);
  combined.set(encodeConfigstringsBlock(), 0);
  combined.set(portalState, MAX_CONFIGSTRINGS * MAX_QPATH);
  FS_WriteFile(name, combined);

  const savename = `${FS_Gamedir()}/save/current/${sv.name}.sav`;
  requireGe().WriteLevel(savename);
}

/*
==============
SV_ReadLevelFile

==============
*/
function SV_ReadLevelFile(): void {
  Com_DPrintf("SV_ReadLevelFile()\n");

  const name = `save/current/${sv.name}.sv2`;
  const open = FS_FOpenFile(name);
  if (!open) {
    Com_Printf("Failed to open %s\n", `${FS_Gamedir()}/${name}`);
  } else {
    const buf = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH);
    FS_Read(buf, buf.length, open.handle);
    decodeConfigstringsBlock(buf);
    const portalBuf = new Uint8Array(MAX_MAP_AREAPORTALS);
    FS_Read(portalBuf, portalBuf.length, open.handle);
    CM_ReadPortalState(portalBuf);
    FS_FCloseFile(open.handle);
  }

  const savename = `${FS_Gamedir()}/save/current/${sv.name}.sav`;
  requireGe().ReadLevel(savename);
}

function bytesToNulString(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    if (!buf[i]) break;
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

// Reverse of bytesToNulString: packs a string into a fixed-width,
// null-padded byte buffer, matching a C `memset(buf, 0, sizeof(buf));
// strcpy(buf, s);` pair ahead of an fwrite(buf, 1, sizeof(buf), f).
function stringToFixedBuf(s: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < s.length && i < len; i++) buf[i] = s.charCodeAt(i) & 0xff;
  return buf;
}

/*
==============
SV_WriteServerFile

==============
*/
function SV_WriteServerFile(autosave: boolean): void {
  Com_DPrintf("SV_WriteServerFile(%s)\n", autosave ? "true" : "false");

  const name = `${FS_Gamedir()}/save/current/server.ssv`;

  // write the comment field
  let comment: string;
  if (!autosave) {
    const d = new Date();
    comment = Com_sprintf("%2i:%i%i %2i/%2i  ", d.getHours(), Math.floor(d.getMinutes() / 10), d.getMinutes() % 10, d.getMonth() + 1, d.getDate());
    comment += sv.configstrings[CS_NAME].slice(0, Math.max(0, 31 - comment.length));
  } else {
    // autosaved
    comment = Com_sprintf("ENTERING %s", sv.configstrings[CS_NAME]);
  }

  // fopen(name,"wb") + fwrite(comment)/fwrite(svs.mapcmd)/fwrite(each
  // CVAR_LATCH cvar's name+value)
  const parts: Uint8Array[] = [stringToFixedBuf(comment, 32), stringToFixedBuf(svs.mapcmd, MAX_TOKEN_CHARS)];

  let latchedCount = 0;
  for (const v of cvar_vars.values()) {
    if (!(v.flags & CVAR_LATCH)) continue;
    if (v.name.length >= MAX_OSPATH - 1 || v.string.length >= 128 - 1) {
      Com_Printf("Cvar too long: %s = %s\n", v.name, v.string);
      continue;
    }
    parts.push(stringToFixedBuf(v.name, MAX_OSPATH));
    parts.push(stringToFixedBuf(v.string, 128));
    latchedCount++;
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }
  FS_WriteFile(name, combined);
  Com_DPrintf("SV_WriteServerFile: wrote comment=\"%s\" mapcmd=\"%s\" %i latched cvar(s)\n", comment, svs.mapcmd, latchedCount);

  // write game state
  const gameName = `${FS_Gamedir()}/save/current/game.ssv`;
  requireGe().WriteGame(gameName, autosave);
}

/*
==============
SV_ReadServerFile

==============
*/
async function SV_ReadServerFile(): Promise<void> {
  Com_DPrintf("SV_ReadServerFile()\n");

  const name = "save/current/server.ssv";
  const open = FS_FOpenFile(name);
  if (!open) {
    Com_Printf("Couldn't read %s\n", `${FS_Gamedir()}/${name}`);
    return;
  }

  // read the comment field
  const commentBuf = new Uint8Array(32);
  FS_Read(commentBuf, 32, open.handle);

  // read the mapcmd
  const mapcmdBuf = new Uint8Array(MAX_TOKEN_CHARS);
  FS_Read(mapcmdBuf, MAX_TOKEN_CHARS, open.handle);
  const mapcmd = bytesToNulString(mapcmdBuf);

  // read all CVAR_LATCH cvars -- these will be things like coop, skill,
  // deathmatch, etc. C: `if (!fread (name, 1, sizeof(name), f)) break;` --
  // a clean EOF is the loop's exit, via FS_ReadRaw's fread semantics.
  for (;;) {
    const nameBuf = new Uint8Array(MAX_OSPATH);
    if (FS_ReadRaw(nameBuf, MAX_OSPATH, open.handle) !== MAX_OSPATH) break;

    const stringBuf = new Uint8Array(128);
    FS_ReadRaw(stringBuf, 128, open.handle);

    const cvarName = bytesToNulString(nameBuf);
    const cvarValue = bytesToNulString(stringBuf);
    Com_DPrintf("Set %s = %s\n", cvarName, cvarValue);
    Cvar_ForceSet(cvarName, cvarValue);
  }

  FS_FCloseFile(open.handle);

  // start a new game fresh with new cvars
  await SV_InitGame();
  svs.mapcmd = mapcmd;

  svs.mapcmd = mapcmd;

  // read game state
  const gameName = `${FS_Gamedir()}/save/current/game.ssv`;
  requireGe().ReadGame(gameName);
}

//=========================================================

/*
==================
SV_DemoMap_f

Puts the server in demo mode on a specific map/cinematic
==================
*/
async function SV_DemoMap_f(): Promise<void> {
  const map = Cmd_Argv(1); // capture before await (global tokenizer)
  await SV_Map(true, map, false);
}

/*
==================
SV_GameMap_f

Saves the state of the map just being exited and goes to a new map.

If the initial character of the map string is '*', the next map is
in a new unit, so the current savegame directory is cleared of
map files.
==================
*/
async function SV_GameMap_f(): Promise<void> {
  if (Cmd_Argc() !== 2) {
    Com_Printf("USAGE: gamemap <map>\n");
    return;
  }

  Com_DPrintf("SV_GameMap(%s)\n", Cmd_Argv(1));

  FS_CreatePath(`${FS_Gamedir()}/save/current/`);

  // check for clearing the current savegame
  const map = Cmd_Argv(1);
  if (map.charAt(0) === "*") {
    // wipe all the *.sav files
    SV_WipeSavegame("current");
  } else {
    // save the map just exited
    if (sv.state === ServerStateT.ss_game) {
      // clear all the client inuse flags before saving so that
      // when the level is re-entered, the clients will spawn
      // at spawn points instead of occupying body shells
      const maxc = maxclients ? maxclients.value : 0;
      const savedInuse: boolean[] = new Array(maxc).fill(false);
      for (let i = 0; i < maxc; i++) {
        const cl = svs.clients[i];
        if (!cl.edict) continue;
        savedInuse[i] = cl.edict.inuse;
        cl.edict.inuse = false;
      }

      SV_WriteLevelFile();

      // we must restore these for clients to transfer over correctly
      for (let i = 0; i < maxc; i++) {
        const cl = svs.clients[i];
        if (!cl.edict) continue;
        cl.edict.inuse = savedInuse[i];
      }
    }
  }

  // start up the next map -- `map` was captured before any await; the
  // command tokenizer is global and later commands retokenize it while an
  // async handler is suspended (the corrupted-mapcmd autosave bug)
  await SV_Map(false, map, false);

  // archive server state
  svs.mapcmd = map;

  // copy off the level to the autosave slot
  if (!dedicated || !dedicated.value) {
    SV_WriteServerFile(true);
    SV_CopySaveGame("current", "save0");
  }
}

/*
==================
SV_Map_f

Goes directly to a given map without any savegame archiving.
For development work
==================
*/
async function SV_Map_f(): Promise<void> {
  // if not a pcx, demo, or cinematic, check to make sure the level exists
  const map = Cmd_Argv(1);
  if (!map.includes(".")) {
    const expanded = `maps/${map}.bsp`;
    if (FS_LoadFile(expanded) === null) {
      Com_Printf("Can't find %s\n", expanded);
      return;
    }
  }

  sv.state = ServerStateT.ss_dead; // don't save current level when changing
  SV_WipeSavegame("current");
  await SV_GameMap_f();
}

/*
=====================================================================

  SAVEGAMES

=====================================================================
*/

/*
==============
SV_Loadgame_f

==============
*/
async function SV_Loadgame_f(): Promise<void> {
  if (Cmd_Argc() !== 2) {
    Com_Printf("USAGE: loadgame <directory>\n");
    return;
  }

  Com_Printf("Loading game...\n");

  const dir = Cmd_Argv(1);
  if (dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
    Com_Printf("Bad savedir.\n");
  }

  // make sure the server.ssv file exists
  const name = `save/${dir}/server.ssv`;
  const open = FS_FOpenFile(name);
  if (!open) {
    Com_Printf("No such savegame: %s\n", `${FS_Gamedir()}/${name}`);
    return;
  }
  FS_FCloseFile(open.handle);

  SV_CopySaveGame(dir, "current");

  await SV_ReadServerFile();

  // go to the map
  sv.state = ServerStateT.ss_dead; // don't save current level when changing
  await SV_Map(false, svs.mapcmd, true);
}

/*
==============
SV_Savegame_f

==============
*/
function SV_Savegame_f(): void {
  if (sv.state !== ServerStateT.ss_game) {
    Com_Printf("You must be in a game to save.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Com_Printf("USAGE: savegame <directory>\n");
    return;
  }

  if (Cvar_VariableValue("deathmatch")) {
    Com_Printf("Can't savegame in a deathmatch\n");
    return;
  }

  if (Cmd_Argv(1) === "current") {
    Com_Printf("Can't save to 'current'\n");
    return;
  }

  if (maxclients && maxclients.value === 1) {
    const cl = svs.clients[0];
    const client = cl?.edict?.client;
    if (isGClientPublic(client) && client.ps.stats[STAT_HEALTH] <= 0) {
      Com_Printf("\nCan't savegame while dead!\n");
      return;
    }
  }

  const dir = Cmd_Argv(1);
  if (dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
    Com_Printf("Bad savedir.\n");
  }

  Com_Printf("Saving game...\n");

  // archive current level, including all client edicts.
  // when the level is reloaded, they will be shells awaiting
  // a connecting client
  SV_WriteLevelFile();

  // save server state
  SV_WriteServerFile(false);

  // copy it off
  SV_CopySaveGame("current", dir);

  Com_Printf("Done.\n");
}

//===============================================================

/*
==================
SV_Kick_f

Kick a user off of the server
==================
*/
function SV_Kick_f(): void {
  if (!svs.initialized) {
    Com_Printf("No server running.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Com_Printf("Usage: kick <userid>\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  const cl = requireSvClient();
  SV_BroadcastPrintf(PRINT_HIGH, "%s was kicked\n", cl.name);
  // print directly, because the dropped client won't get the
  // SV_BroadcastPrintf message
  SV_ClientPrintf(cl, PRINT_HIGH, "You were kicked from the game\n");
  SV_DropClient(cl);
  cl.lastmessage = svs.realtime; // min case there is a funny zombie
}

/*
================
SV_Status_f
================
*/
function SV_Status_f(): void {
  // `!svs.clients` in C is a null-pointer ("never allocated") check;
  // svs.clients here always starts as `[]` (ServerStaticT's default), so
  // the length is the faithful equivalent of "no server running".
  if (!svs.clients.length) {
    Com_Printf("No server running.\n");
    return;
  }

  Com_Printf("map              : %s\n", sv.name);

  Com_Printf("num score ping name            lastmsg address               qport \n");
  Com_Printf("--- ----- ---- --------------- ------- --------------------- ------\n");

  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl || !cl.state) continue;

    Com_Printf("%3i ", i);

    let frags = 0;
    if (cl.edict) {
      const client = cl.edict.client;
      if (isGClientPublic(client)) frags = client.ps.stats[STAT_FRAGS];
    }
    Com_Printf("%5i ", frags);

    if (cl.state === ClientStateT.cs_connected) Com_Printf("CNCT ");
    else if (cl.state === ClientStateT.cs_zombie) Com_Printf("ZMBI ");
    else {
      const ping = cl.ping < 9999 ? cl.ping : 9999;
      Com_Printf("%4i ", ping);
    }

    Com_Printf("%s", cl.name);
    let l = 16 - cl.name.length;
    for (let j = 0; j < l; j++) Com_Printf(" ");

    Com_Printf("%7i ", svs.realtime - cl.lastmessage);

    const s = NET_AdrToString(cl.netchan.remote_address);
    Com_Printf("%s", s);
    l = 22 - s.length;
    for (let j = 0; j < l; j++) Com_Printf(" ");

    Com_Printf("%5i", cl.netchan.qport);

    Com_Printf("\n");
  }
  Com_Printf("\n");
}

/*
==================
SV_ConSay_f
==================
*/
function SV_ConSay_f(): void {
  if (Cmd_Argc() < 2) return;

  let p = Cmd_Args();
  if (p.charAt(0) === '"') {
    // C: `p++; p[strlen(p)-1] = 0;` -- always strips the last character once
    // an opening quote is stripped, even if that last character isn't
    // itself a closing quote. Preserved bug-for-bug.
    p = p.slice(1);
    p = p.slice(0, -1);
  }

  const text = `console: ${p}`;

  const maxc = maxclients ? maxclients.value : 0;
  for (let j = 0; j < maxc; j++) {
    const client = svs.clients[j];
    if (!client || client.state !== ClientStateT.cs_spawned) continue;
    SV_ClientPrintf(client, PRINT_CHAT, "%s\n", text);
  }
}

/*
==================
SV_Heartbeat_f
==================
*/
function SV_Heartbeat_f(): void {
  svs.last_heartbeat = -9999999;
}

/*
===========
SV_Serverinfo_f

  Examine or change the serverinfo string
===========
*/
function SV_Serverinfo_f(): void {
  Com_Printf("Server info settings:\n");
  Info_Print(Cvar_Serverinfo());
}

/*
===========
SV_DumpUser_f

Examine all a users info strings
===========
*/
function SV_DumpUser_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("Usage: info <userid>\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  Com_Printf("userinfo\n");
  Com_Printf("--------\n");
  Info_Print(requireSvClient().userinfo);
}

/*
==============
SV_ServerRecord_f

Begins server demo recording.  Every entity and every message will be
recorded, but no playerinfo will be stored.  Primarily for demo merging.
==============
*/
function SV_ServerRecord_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("serverrecord <demoname>\n");
    return;
  }

  if (svs.demofile !== null) {
    Com_Printf("Already recording.\n");
    return;
  }

  if (sv.state !== ServerStateT.ss_game) {
    Com_Printf("You must be in a level to record.\n");
    return;
  }

  //
  // open the demo file
  //
  const name = `${FS_Gamedir()}/demos/${Cmd_Argv(1)}.dm2`;

  Com_Printf("recording to %s.\n", name);
  FS_CreatePath(name);
  const handle = FS_FOpenFileWrite(name);
  if (handle === null) {
    Com_Printf("ERROR: couldn't open.\n");
    return;
  }
  svs.demofile = handle;

  // setup a buffer to catch all multicasts
  SZ_Init(svs.demo_multicast, svs.demo_multicast_buf, svs.demo_multicast_buf.length);

  //
  // write a single giant fake message with all the startup info
  //
  const buf = new SizeBuf();
  const buf_data = new Uint8Array(32768);
  SZ_Init(buf, buf_data, buf_data.length);

  // serverdata needs to go over for all types of servers
  // to make sure the protocol is right, and to set the gamedir
  //
  // send the serverdata
  MSG_WriteByte(buf, SvcOpsT.svc_serverdata);
  MSG_WriteLong(buf, PROTOCOL_VERSION);
  MSG_WriteLong(buf, svs.spawncount);
  MSG_WriteByte(buf, 2); // demos are always attract loops
  MSG_WriteString(buf, Cvar_VariableString("gamedir"));
  MSG_WriteShort(buf, -1);
  // send full levelname
  MSG_WriteString(buf, sv.configstrings[CS_NAME]);

  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    if (sv.configstrings[i].length) {
      MSG_WriteByte(buf, SvcOpsT.svc_configstring);
      MSG_WriteShort(buf, i);
      MSG_WriteString(buf, sv.configstrings[i]);
    }
  }

  // write it to the demo file
  Com_DPrintf("signon message length: %i\n", buf.cursize);
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setInt32(0, buf.cursize, true);
  FS_Write(lenBuf, 4, svs.demofile);
  FS_Write(buf.data.subarray(0, buf.cursize), buf.cursize, svs.demofile);

  // the rest of the demo file will be individual frames
}

/*
==============
SV_ServerStop_f

Ends server demo recording
==============
*/
function SV_ServerStop_f(): void {
  if (svs.demofile === null) {
    Com_Printf("Not doing a serverrecord.\n");
    return;
  }
  FS_FCloseFile(svs.demofile);
  svs.demofile = null;
  Com_Printf("Recording completed.\n");
}

/*
===============
SV_KillServer_f

Kick everyone off, possibly in preparation for a new game

===============
*/
async function SV_KillServer_f(): Promise<void> {
  if (!svs.initialized) return;
  SV_Shutdown("Server was killed.\n", false);
  await NET_Config(false); // close network sockets
}

/*
===============
SV_ServerCommand_f

Let the game dll handle a command
===============
*/
function SV_ServerCommand_f(): void {
  if (!geHolder.ge) {
    Com_Printf("No game loaded.\n");
    return;
  }
  geHolder.ge.ServerCommand();
}

//===========================================================

/*
==================
SV_InitOperatorCommands
==================
*/
export function SV_InitOperatorCommands(): void {
  Cmd_AddCommand("heartbeat", SV_Heartbeat_f);
  Cmd_AddCommand("kick", SV_Kick_f);
  Cmd_AddCommand("status", SV_Status_f);
  Cmd_AddCommand("serverinfo", SV_Serverinfo_f);
  Cmd_AddCommand("dumpuser", SV_DumpUser_f);

  Cmd_AddCommand("map", fireAndForget("map", SV_Map_f));
  Cmd_AddCommand("demomap", fireAndForget("demomap", SV_DemoMap_f));
  Cmd_AddCommand("gamemap", fireAndForget("gamemap", SV_GameMap_f));
  Cmd_AddCommand("setmaster", SV_SetMaster_f);

  if (dedicated && dedicated.value) Cmd_AddCommand("say", SV_ConSay_f);

  Cmd_AddCommand("serverrecord", SV_ServerRecord_f);
  Cmd_AddCommand("serverstop", SV_ServerStop_f);

  Cmd_AddCommand("save", SV_Savegame_f);
  Cmd_AddCommand("load", fireAndForget("load", SV_Loadgame_f));

  Cmd_AddCommand("killserver", fireAndForget("killserver", SV_KillServer_f));

  Cmd_AddCommand("sv", SV_ServerCommand_f);
}

// SV_ReadLevelFile is the one function server.h exposes outside sv_ccmds.c
// (sv_init.ts's SV_CheckForSavegame calls it).
export { SV_ReadLevelFile };

// SV_Status_f is likewise re-exported: server.h's own comment block
// (mirrored in this file's original pending-stub header) singles it out
// alongside SV_ReadLevelFile as the two symbols other modules reach for.
export { SV_Status_f };
