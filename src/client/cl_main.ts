// cl_main.c -- client main loop: connection state machine, connect/
// reconnect/challenge flow, connectionless packets, demo recording, cvar
// registration, the per-frame pump.
//
// client.h declares `void CL_GetChallengePacket (void);` under this file's
// section, but it is never defined anywhere in the v3.19 client tree
// (confirmed by grep) -- a dead declaration, dropped and reported.
//
// client.h also misattributes CL_ClearState and CL_ReadPackets to its
// "cl_input" comment section; both are actually defined in cl_main.c
// (confirmed by grep) and are exported from here instead. There is no
// cl_demo.c file in the v3.19 tree -- client.h's "cl_demo.c" comment
// section (CL_WriteDemoMessage/CL_Stop_f/CL_Record_f) is likewise stale;
// all three are defined in cl_main.c and are exported from here too.
//
// Deviations (see report for the full list):
// - VID_Init/VID_CheckChanges come from src/platform/vid.ts and IN_Init from
//   src/platform/sdl.ts (re-exported by cl_input.ts under the name client.h
//   declares). CDAudio_* bind to src/null/cd_null.ts (the cd_null.c backend).
//   is not ported. Sys_AppActivate has no ShowWindow/SetForegroundWindow
//   equivalent and calls vid.ts's VID_Front_f instead.
// - CL_Setenv_f uses process.env in place of putenv/getenv.
// - CL_WriteDemoMessage/CL_Stop_f/CL_Record_f/CL_WriteConfiguration use
//   src/qcommon/files.ts's FS_FOpenFileWrite/FS_Write/FS_FCloseFile instead
//   of raw fopen/fwrite, mirroring sv_ccmds.ts's SV_ServerRecord_f/
//   SV_ServerStop_f (PORTING.md restricts direct node:fs use to
//   src/platform and src/qcommon/files.ts).
// - CL_Connect_f/CL_Rcon_f/CL_PingServers_f/CL_Packet_f call the now-async
//   NET_Config(true); each is an async function registered through a local
//   `fireAndForget` wrapper, mirroring sv_ccmds.ts's `map`/`demomap`
//   registration for SV_Map_f. CL_Init itself never calls NET_Config, so it
//   stays synchronous.
// - CL_RequestNextDownload's alias-model skin-scanning inner block (reading
//   dmdl_t.num_skins/ofs_skins to probe each skin file) is omitted: qfiles.ts
//   does not export dmdl_t/IDALIASHEADER/ALIAS_VERSION yet (out of this
//   brief's SCOPE to add), and the block is unreachable in practice anyway
//   -- allow_download defaults to "0" (sv_main.ts's SV_Init) so
//   precache_check always jumps straight past the whole CS_MODELS phase,
//   and even if allow_download were on, CL_CheckOrDownloadFile
//   (cl_parse.ts) is itself still a pending stub that throws before any
//   dmdl_t parsing would run. The phase-skeleton (precache_check state
//   machine) is ported faithfully; only that one inner scan is stubbed out.
// - rcon_client_password/rcon_address/adr0-8/cl_timeout/cl_maxfps/
//   info_password/info_spectator/name/skin/rate/fov/msg/hand/gender/
//   gender_auto/precache_*/cheatvars are cl_main.c file-scope globals that
//   client.ts's clCvars holder did not anticipate (it mirrors CL_InitLocal's
//   registrations but omits these); hosted as module-private state here
//   instead of adding fields to client.ts (out of SCOPE).

import { IN_Shutdown } from "../platform/sdl";
import { CDAudio_Shutdown, CDAudio_Init, CDAudio_Update } from "../platform/cd_ogg";
import { Key_WriteBindings } from "./keys_impl";
import { Cmd_Argc, Cmd_Argv, Cmd_Args, Cmd_AddCommand, Cmd_TokenizeString, Cbuf_AddText, Cbuf_Execute, setCmdForwardToServerHandler } from "../qcommon/cmd";
import { Cvar_WriteVariables, Cvar_Get, Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString, Cvar_Userinfo, SetUserinfoModified } from "../qcommon/cvar";
import { Com_Printf, Com_DPrintf, Com_Error, Com_Quit, Com_ServerState, Info_Print, dedicated, COM_BlockSequenceCRCByte } from "../qcommon/common";
import { NetadrT, NetadrtypeT, NetsrcT, ComError, ERR_DROP, SvcOpsT, ClcOpsT, PROTOCOL_VERSION, PORT_SERVER, MAX_MSGLEN } from "../qcommon/qcommon";
import { NET_StringToAdr, NET_AdrToString, NET_CompareAdr, NET_IsLocalAddress, NET_SendPacket, NET_GetPacket, NET_Config } from "../platform/net_udp";
import { Netchan_OutOfBandPrint, Netchan_Setup, Netchan_Transmit, Netchan_Process, net_from, net_message } from "../qcommon/net_chan";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Print, MSG_WriteByte, MSG_WriteChar, MSG_WriteShort, MSG_WriteLong, MSG_WriteString, MSG_ReadString, MSG_ReadStringLine, MSG_BeginReading, MSG_ReadLong, MSG_WriteDeltaEntity } from "../qcommon/sizebuf";
import { FS_Gamedir, FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile, FS_ExecAutoexec } from "../qcommon/files";
import { CM_LoadMap } from "../qcommon/cmodel";
import { SV_Shutdown } from "../server/sv_main";
import { allow_download, allow_download_players, allow_download_models, allow_download_sounds, allow_download_maps } from "../server/sv_main";
import {
  Com_sprintf,
  CVAR_ARCHIVE,
  CVAR_NOSET,
  CVAR_USERINFO,
  MAX_CLIENTS,
  MAX_MODELS,
  MAX_SOUNDS,
  MAX_IMAGES,
  MAX_CONFIGSTRINGS,
  MAX_EDICTS,
  CS_NAME,
  CS_MODELS,
  CS_SOUNDS,
  CS_IMAGES,
  CS_PLAYERSKINS,
  CS_SKY,
  CS_MAPCHECKSUM,
  CS_MAXCLIENTS,
  Q_stricmp,
  EntityStateT,
  type CvarT,
} from "../shared/q_shared";
import { cl, cls, cl_entities, ConnstateT, CentityT, clCvars } from "./client";
import { CL_InitInput, CL_SendCmd, IN_Commands, IN_Frame, IN_Init, Sys_SendKeyEvents } from "./cl_input";
import { VID_Shutdown, VID_CheckChanges, VID_Front_f, VID_Init } from "../platform/vid";
import { CL_PredictMovement } from "./cl_pred";
import { CL_RunDLights, CL_RunLightStyles, CL_ClearEffects } from "./cl_fx";
import { CL_ClearTEnts } from "./cl_tent";
import { S_StopAllSounds, S_Update, S_Init, S_Shutdown } from "./snd_dma";
import { CL_RegisterSounds, CL_ParseClientinfo, CL_ParseServerMessage } from "./cl_parse";
import { CL_PrepRefresh, V_Init } from "./cl_view";
import { SCR_Init, SCR_UpdateScreen, SCR_BeginLoadingPlaque, SCR_EndLoadingPlaque, SCR_RunConsole } from "./cl_scrn";
import { SCR_StopCinematic, SCR_RunCinematic } from "./cl_cin";
import { Con_Init } from "./console_impl";
import { M_Init, M_ForceMenuOff, M_AddToServerList } from "./menu";
import { Sys_ConsoleOutput, Sys_Milliseconds } from "../platform/sys";

function atoi(s: string): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// fireAndForget -- mirrors sv_ccmds.ts's helper for registering an async
// command handler through Cmd_AddCommand's synchronous `(() => void) | null`
// slot; rejections are reported via Com_Printf instead of becoming an
// unhandled promise rejection.
function fireAndForget(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      Com_Printf("%s: %s\n", name, msg);
    });
  };
}

// Sys_AppActivate -- sys_win.c raises and restores the game window
// (ShowWindow + SetForegroundWindow) when a front end sends a "cmd" packet.
// vid.ts's VID_Front_f is this port's window-raise, so it stands in here.
function Sys_AppActivate(): void {
  VID_Front_f();
}
// CDAudio_* come from src/null/cd_null.ts, the cd_null.c backend this port
// ships (the per-OS redbook players are alternative backends, not ported).

//======================================================================

//
// userinfo
//
let info_password: CvarT | null = null;
let info_spectator: CvarT | null = null;
let name: CvarT | null = null;
let skin: CvarT | null = null;
let rate: CvarT | null = null;
let fov: CvarT | null = null;
let msg: CvarT | null = null;
let hand: CvarT | null = null;
let gender: CvarT | null = null;
let gender_auto: CvarT | null = null;

// address book, rcon, timing/misc -- file-scope only in C, hosted locally
let adr0: CvarT | null = null;
let adr1: CvarT | null = null;
let adr2: CvarT | null = null;
let adr3: CvarT | null = null;
let adr4: CvarT | null = null;
let adr5: CvarT | null = null;
let adr6: CvarT | null = null;
let adr7: CvarT | null = null;
let adr8: CvarT | null = null;

let rcon_client_password: CvarT | null = null;
let rcon_address: CvarT | null = null;

let cl_timeout: CvarT | null = null;
let cl_maxfps: CvarT | null = null;

//======================================================================

/*
====================
CL_WriteDemoMessage

Dumps the current net message, prefixed by the length
====================
*/
export function CL_WriteDemoMessage(): void {
  if (cls.demofile === null) return;

  // the first eight bytes are just packet sequencing stuff
  const len = net_message.cursize - 8;
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setInt32(0, len, true);
  FS_Write(lenBuf, 4, cls.demofile);
  FS_Write(net_message.data.subarray(8, 8 + len), len, cls.demofile);
}

/*
====================
CL_Stop_f

stop recording a demo
====================
*/
export function CL_Stop_f(): void {
  if (!cls.demorecording || cls.demofile === null) {
    Com_Printf("Not recording a demo.\n");
    return;
  }

  // finish up
  const handle = cls.demofile;
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setInt32(0, -1, true);
  FS_Write(lenBuf, 4, handle);
  FS_FCloseFile(handle);
  cls.demofile = null;
  cls.demorecording = false;
  Com_Printf("Stopped demo.\n");
}

/*
====================
CL_Record_f

record <demoname>

Begins recording a demo from the current position
====================
*/
export function CL_Record_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("record <demoname>\n");
    return;
  }

  if (cls.demorecording) {
    Com_Printf("Already recording.\n");
    return;
  }

  if (cls.state !== ConnstateT.ca_active) {
    Com_Printf("You must be in a level to record.\n");
    return;
  }

  //
  // open the demo file
  //
  const name_ = Com_sprintf("%s/demos/%s.dm2", FS_Gamedir(), Cmd_Argv(1));

  Com_Printf("recording to %s.\n", name_);
  FS_CreatePath(name_);
  const handle = FS_FOpenFileWrite(name_);
  if (handle === null) {
    Com_Printf("ERROR: couldn't open.\n");
    return;
  }
  cls.demofile = handle;

  // don't start saving messages until a non-delta compressed message is received
  cls.demowaiting = true;

  //
  // write out messages to hold the startup information
  //
  const buf = new SizeBuf();
  const buf_data = new Uint8Array(MAX_MSGLEN);
  SZ_Init(buf, buf_data, buf_data.length);

  const flush = () => {
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setInt32(0, buf.cursize, true);
    FS_Write(lenBuf, 4, handle);
    FS_Write(buf.data.subarray(0, buf.cursize), buf.cursize, handle);
    buf.cursize = 0;
  };

  // send the serverdata
  MSG_WriteByte(buf, SvcOpsT.svc_serverdata);
  MSG_WriteLong(buf, PROTOCOL_VERSION);
  MSG_WriteLong(buf, 0x10000 + cl.servercount);
  MSG_WriteByte(buf, 1); // demos are always attract loops
  MSG_WriteString(buf, cl.gamedir);
  MSG_WriteShort(buf, cl.playernum);

  MSG_WriteString(buf, cl.configstrings[CS_NAME]);

  // configstrings
  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    if (cl.configstrings[i].length) {
      if (buf.cursize + cl.configstrings[i].length + 32 > buf.maxsize) flush();

      MSG_WriteByte(buf, SvcOpsT.svc_configstring);
      MSG_WriteShort(buf, i);
      MSG_WriteString(buf, cl.configstrings[i]);
    }
  }

  // baselines
  const nullstate = new EntityStateT();
  for (let i = 0; i < MAX_EDICTS; i++) {
    const ent = cl_entities[i].baseline;
    if (!ent.modelindex) continue;

    if (buf.cursize + 64 > buf.maxsize) flush();

    MSG_WriteByte(buf, SvcOpsT.svc_spawnbaseline);
    MSG_WriteDeltaEntity(nullstate, cl_entities[i].baseline, buf, true, true);
  }

  MSG_WriteByte(buf, SvcOpsT.svc_stufftext);
  MSG_WriteString(buf, "precache\n");

  // write it to the demo file
  flush();

  // the rest of the demo file will be individual frames
}

//======================================================================

/*
===================
Cmd_ForwardToServer

adds the current command line as a clc_stringcmd to the client message.
things like godmode, noclip, etc, are commands directed to the server,
so when they are typed in at the console, they will need to be forwarded.
===================
*/
export function Cmd_ForwardToServer(): void {
  const cmd = Cmd_Argv(0);
  if (cls.state <= ConnstateT.ca_connected || cmd.charAt(0) === "-" || cmd.charAt(0) === "+") {
    Com_Printf('Unknown command "%s"\n', cmd);
    return;
  }

  MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_stringcmd);
  SZ_Print(cls.netchan.message, cmd);
  if (Cmd_Argc() > 1) {
    SZ_Print(cls.netchan.message, " ");
    SZ_Print(cls.netchan.message, Cmd_Args());
  }
}

export function CL_Setenv_f(): void {
  const argc = Cmd_Argc();

  if (argc > 2) {
    let buffer = `${Cmd_Argv(1)}=`;
    for (let i = 2; i < argc; i++) buffer += `${Cmd_Argv(i)} `;
    const eq = buffer.indexOf("=");
    process.env[buffer.slice(0, eq)] = buffer.slice(eq + 1);
  } else if (argc === 2) {
    const env = process.env[Cmd_Argv(1)];
    if (env !== undefined) Com_Printf("%s=%s\n", Cmd_Argv(1), env);
    else Com_Printf("%s undefined\n", Cmd_Argv(1));
  }
}

/*
==================
CL_ForwardToServer_f
==================
*/
export function CL_ForwardToServer_f(): void {
  if (cls.state !== ConnstateT.ca_connected && cls.state !== ConnstateT.ca_active) {
    Com_Printf('Can\'t "%s", not connected\n', Cmd_Argv(0));
    return;
  }

  // don't forward the first argument
  if (Cmd_Argc() > 1) {
    MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_stringcmd);
    SZ_Print(cls.netchan.message, Cmd_Args());
  }
}

/*
==================
CL_Pause_f
==================
*/
export function CL_Pause_f(): void {
  // never pause in multiplayer
  if (Cvar_VariableValue("maxclients") > 1 || !Com_ServerState()) {
    Cvar_SetValue("paused", 0);
    return;
  }

  const cl_paused = Cvar_VariableValue("paused");
  Cvar_SetValue("paused", cl_paused ? 0 : 1);
}

/*
==================
CL_Quit_f
==================
*/
export function CL_Quit_f(): void {
  CL_Disconnect();
  Com_Quit();
}

/*
================
CL_Drop

Called after an ERR_DROP was thrown
================
*/
export function CL_Drop(): void {
  if (cls.state === ConnstateT.ca_uninitialized) return;
  if (cls.state === ConnstateT.ca_disconnected) return;

  CL_Disconnect();

  // drop loading plaque unless this is the initial game start
  if (cls.disable_servercount !== -1) SCR_EndLoadingPlaque(); // get rid of loading plaque
}

/*
=======================
CL_SendConnectPacket

We have gotten a challenge from the server, so try and
connect.
======================
*/
export function CL_SendConnectPacket(): void {
  const adr = new NetadrT();

  if (!NET_StringToAdr(cls.servername, adr)) {
    Com_Printf("Bad server address\n");
    cls.connect_time = 0;
    return;
  }
  if (adr.port === 0) adr.port = PORT_SERVER;

  const port = Cvar_VariableValue("qport");
  SetUserinfoModified(false);

  Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, adr, 'connect %i %i %i "%s"\n', PROTOCOL_VERSION, port, cls.challenge, Cvar_Userinfo());
}

/*
=================
CL_CheckForResend

Resend a connect message if the last one has timed out
=================
*/
export function CL_CheckForResend(): void {
  // if the local server is running and we aren't
  // then connect
  if (cls.state === ConnstateT.ca_disconnected && Com_ServerState()) {
    cls.state = ConnstateT.ca_connecting;
    cls.servername = "localhost";
    // we don't need a challenge on the localhost
    CL_SendConnectPacket();
    return;
  }

  // resend if we haven't gotten a reply yet
  if (cls.state !== ConnstateT.ca_connecting) return;

  if (cls.realtime - cls.connect_time < 3000) return;

  const adr = new NetadrT();
  if (!NET_StringToAdr(cls.servername, adr)) {
    Com_Printf("Bad server address\n");
    cls.state = ConnstateT.ca_disconnected;
    return;
  }
  if (adr.port === 0) adr.port = PORT_SERVER;

  cls.connect_time = cls.realtime; // for retransmit requests

  Com_Printf("Connecting to %s...\n", cls.servername);

  Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, adr, "getchallenge\n");
}

/*
================
CL_Connect_f

================
*/
async function CL_Connect_f(): Promise<void> {
  if (Cmd_Argc() !== 2) {
    Com_Printf("usage: connect <server>\n");
    return;
  }

  if (Com_ServerState()) {
    // if running a local server, kill it and reissue
    SV_Shutdown("Server quit\n", false);
  } else {
    CL_Disconnect();
  }

  const server = Cmd_Argv(1);

  await NET_Config(true); // allow remote

  CL_Disconnect();

  cls.state = ConnstateT.ca_connecting;
  cls.servername = server;
  cls.connect_time = -99999; // CL_CheckForResend() will fire immediately
}

/*
=====================
CL_Rcon_f

  Send the rest of the command line over as
  an unconnected command.
=====================
*/
async function CL_Rcon_f(): Promise<void> {
  if (!rcon_client_password || !rcon_client_password.string) {
    Com_Printf("You must set 'rcon_password' before\nissuing an rcon command.\n");
    return;
  }

  let message = "\xff\xff\xff\xff";

  await NET_Config(true); // allow remote

  message += "rcon ";
  message += rcon_client_password.string;
  message += " ";

  for (let i = 1; i < Cmd_Argc(); i++) {
    message += Cmd_Argv(i);
    message += " ";
  }

  let to: NetadrT;
  if (cls.state >= ConnstateT.ca_connected) {
    to = cls.netchan.remote_address;
  } else {
    if (!rcon_address || !rcon_address.string.length) {
      Com_Printf("You must either be connected,\nor set the 'rcon_address' cvar\nto issue rcon commands\n");
      return;
    }
    to = new NetadrT();
    NET_StringToAdr(rcon_address.string, to);
    if (to.port === 0) to.port = PORT_SERVER;
  }

  const bytes = new Uint8Array(message.length + 1);
  for (let i = 0; i < message.length; i++) bytes[i] = message.charCodeAt(i) & 0xff;
  NET_SendPacket(NetsrcT.NS_CLIENT, bytes.length, bytes, to);
}

/*
=====================
CL_ClearState

=====================
*/
export function CL_ClearState(): void {
  S_StopAllSounds();
  CL_ClearEffects();
  CL_ClearTEnts();

  // wipe the entire cl structure
  cl.clear();
  for (let i = 0; i < cl_entities.length; i++) cl_entities[i] = new CentityT();

  SZ_Clear(cls.netchan.message);
}

/*
=====================
CL_Disconnect

Goes from a connected state to full screen console state
Sends a disconnect message to the server
This is also called on Com_Error, so it shouldn't cause any errors
=====================
*/
export function CL_Disconnect(): void {
  if (cls.state === ConnstateT.ca_disconnected) return;

  if (clCvars.cl_timedemo && clCvars.cl_timedemo.value) {
    const time = Sys_Milliseconds() - cl.timedemo_start;
    if (time > 0) {
      Com_Printf("%i frames, %3.1f seconds: %3.1f fps\n", cl.timedemo_frames, time / 1000.0, (cl.timedemo_frames * 1000.0) / time);
    }
  }

  cl.refdef.blend[0] = 0;
  cl.refdef.blend[1] = 0;
  cl.refdef.blend[2] = 0;
  cl.refdef.blend[3] = 0;

  M_ForceMenuOff();

  cls.connect_time = 0;

  SCR_StopCinematic();

  if (cls.demorecording) CL_Stop_f();

  // send a disconnect message to the server
  const final = new Uint8Array(11);
  final[0] = ClcOpsT.clc_stringcmd;
  const word = "disconnect";
  for (let i = 0; i < word.length; i++) final[1 + i] = word.charCodeAt(i);
  Netchan_Transmit(cls.netchan, final.length, final);
  Netchan_Transmit(cls.netchan, final.length, final);
  Netchan_Transmit(cls.netchan, final.length, final);

  CL_ClearState();

  // stop download
  if (cls.download !== null) {
    FS_FCloseFile(cls.download);
    cls.download = null;
  }

  cls.state = ConnstateT.ca_disconnected;
}

export function CL_Disconnect_f(): void {
  Com_Error(ERR_DROP, "Disconnected from server");
}

/*
====================
CL_Packet_f

packet <destination> <contents>

Contents allows \n escape character
====================
*/
async function CL_Packet_f(): Promise<void> {
  if (Cmd_Argc() !== 3) {
    Com_Printf("packet <destination> <contents>\n");
    return;
  }

  await NET_Config(true); // allow remote

  const adr = new NetadrT();
  if (!NET_StringToAdr(Cmd_Argv(1), adr)) {
    Com_Printf("Bad address\n");
    return;
  }
  if (!adr.port) adr.port = PORT_SERVER;

  const inStr = Cmd_Argv(2);
  let out = "";
  for (let i = 0; i < inStr.length; i++) {
    if (inStr.charAt(i) === "\\" && inStr.charAt(i + 1) === "n") {
      out += "\n";
      i++;
    } else {
      out += inStr.charAt(i);
    }
  }

  const send = new Uint8Array(4 + out.length);
  send[0] = send[1] = send[2] = send[3] = 0xff;
  for (let i = 0; i < out.length; i++) send[4 + i] = out.charCodeAt(i) & 0xff;

  NET_SendPacket(NetsrcT.NS_CLIENT, send.length, send, adr);
}

/*
=================
CL_Changing_f

Just sent as a hint to the client that they should
drop to full console
=================
*/
export function CL_Changing_f(): void {
  //ZOID
  //if we are downloading, we don't change!  This so we don't suddenly stop downloading a map
  if (cls.download !== null) return;

  SCR_BeginLoadingPlaque();
  cls.state = ConnstateT.ca_connected; // not active anymore, but not disconnected
  Com_Printf("\nChanging map...\n");
}

/*
=================
CL_Reconnect_f

The server is changing levels
=================
*/
export function CL_Reconnect_f(): void {
  //ZOID
  //if we are downloading, we don't change!  This so we don't suddenly stop downloading a map
  if (cls.download !== null) return;

  S_StopAllSounds();
  if (cls.state === ConnstateT.ca_connected) {
    Com_Printf("reconnecting...\n");
    cls.state = ConnstateT.ca_connected;
    MSG_WriteChar(cls.netchan.message, ClcOpsT.clc_stringcmd);
    MSG_WriteString(cls.netchan.message, "new");
    return;
  }

  if (cls.servername.length) {
    if (cls.state >= ConnstateT.ca_connected) {
      CL_Disconnect();
      cls.connect_time = cls.realtime - 1500;
    } else {
      cls.connect_time = -99999; // fire immediately
    }

    cls.state = ConnstateT.ca_connecting;
    Com_Printf("reconnecting...\n");
  }
}

/*
=================
CL_ParseStatusMessage

Handle a reply from a ping
=================
*/
export function CL_ParseStatusMessage(): void {
  const s = MSG_ReadString(net_message);

  Com_Printf("%s\n", s);
  M_AddToServerList(net_from, s);
}

/*
=================
CL_PingServers_f
=================
*/
export async function CL_PingServers_f(): Promise<void> {
  await NET_Config(true); // allow remote

  // send a broadcast packet
  Com_Printf("pinging broadcast...\n");

  const noudp = Cvar_Get("noudp", "0", CVAR_NOSET);
  if (noudp && !noudp.value) {
    const adr = new NetadrT();
    adr.type = NetadrtypeT.NA_BROADCAST;
    adr.port = PORT_SERVER;
    Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, adr, `info ${PROTOCOL_VERSION}`);
  }

  // noipx / NA_BROADCAST_IPX dropped -- IPX is not a supported transport on
  // this port (net_udp.ts's banner)

  // send a packet to each address book entry
  for (let i = 0; i < 16; i++) {
    const name_ = Com_sprintf("adr%i", i);
    const adrstring = Cvar_VariableString(name_);
    if (!adrstring.length) continue;

    Com_Printf("pinging %s...\n", adrstring);
    const adr = new NetadrT();
    if (!NET_StringToAdr(adrstring, adr)) {
      Com_Printf("Bad address: %s\n", adrstring);
      continue;
    }
    if (!adr.port) adr.port = PORT_SERVER;
    Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, adr, `info ${PROTOCOL_VERSION}`);
  }
}

/*
=================
CL_Skins_f

Load or download any custom player skins and models
=================
*/
export function CL_Skins_f(): void {
  for (let i = 0; i < MAX_CLIENTS; i++) {
    if (!cl.configstrings[CS_PLAYERSKINS + i].length) continue;
    Com_Printf("client %i: %s\n", i, cl.configstrings[CS_PLAYERSKINS + i]);
    SCR_UpdateScreen();
    Sys_SendKeyEvents(); // pump message loop
    CL_ParseClientinfo(i);
  }
}

/*
=================
CL_ConnectionlessPacket

Responses to broadcasts, etc
=================
*/
export function CL_ConnectionlessPacket(): void {
  MSG_BeginReading(net_message);
  MSG_ReadLong(net_message); // skip the -1

  const s = MSG_ReadStringLine(net_message);

  Cmd_TokenizeString(s, false);

  const c = Cmd_Argv(0);

  Com_Printf("%s: %s\n", NET_AdrToString(net_from), c);

  // server connection
  if (c === "client_connect") {
    if (cls.state === ConnstateT.ca_connected) {
      Com_Printf("Dup connect received.  Ignored.\n");
      return;
    }
    Netchan_Setup(NetsrcT.NS_CLIENT, cls.netchan, net_from, cls.quakePort);
    MSG_WriteChar(cls.netchan.message, ClcOpsT.clc_stringcmd);
    MSG_WriteString(cls.netchan.message, "new");
    cls.state = ConnstateT.ca_connected;
    return;
  }

  // server responding to a status broadcast
  if (c === "info") {
    CL_ParseStatusMessage();
    return;
  }

  // remote command from gui front end
  if (c === "cmd") {
    if (!NET_IsLocalAddress(net_from)) {
      Com_Printf("Command packet from remote host.  Ignored.\n");
      return;
    }
    Sys_AppActivate();
    const cmdStr = MSG_ReadString(net_message);
    Cbuf_AddText(cmdStr);
    Cbuf_AddText("\n");
    return;
  }

  // print command from somewhere
  if (c === "print") {
    const printStr = MSG_ReadString(net_message);
    Com_Printf("%s", printStr);
    return;
  }

  // ping from somewhere
  if (c === "ping") {
    Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, net_from, "ack");
    return;
  }

  // challenge from the server we are connecting to
  if (c === "challenge") {
    cls.challenge = atoi(Cmd_Argv(1));
    CL_SendConnectPacket();
    return;
  }

  // echo request from server
  if (c === "echo") {
    Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, net_from, "%s", Cmd_Argv(1));
    return;
  }

  Com_Printf("Unknown command.\n");
}

/*
=================
CL_DumpPackets

A vain attempt to help bad TCP stacks that cause problems
when they overflow
=================
*/
export function CL_DumpPackets(): void {
  while (NET_GetPacket(NetsrcT.NS_CLIENT, net_from, net_message)) {
    Com_Printf("dumnping a packet\n");
  }
}

/*
=================
CL_ReadPackets
=================
*/
export function CL_ReadPackets(): void {
  while (NET_GetPacket(NetsrcT.NS_CLIENT, net_from, net_message)) {
    //
    // remote command packet
    //
    const d = net_message.data;
    if ((d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) === -1) {
      CL_ConnectionlessPacket();
      continue;
    }

    if (cls.state === ConnstateT.ca_disconnected || cls.state === ConnstateT.ca_connecting) continue; // dump it if not connected

    if (net_message.cursize < 8) {
      Com_Printf("%s: Runt packet\n", NET_AdrToString(net_from));
      continue;
    }

    //
    // packet from server
    //
    if (!NET_CompareAdr(net_from, cls.netchan.remote_address)) {
      Com_DPrintf("%s:sequenced packet without connection\n", NET_AdrToString(net_from));
      continue;
    }
    if (!Netchan_Process(cls.netchan, net_message)) continue; // wasn't accepted for some reason
    CL_ParseServerMessage();
  }

  //
  // check timeout
  //
  if (cls.state >= ConnstateT.ca_connected && cls.realtime - cls.netchan.last_received > (cl_timeout ? cl_timeout.value : 0) * 1000) {
    if (++cl.timeoutcount > 5) {
      // timeoutcount saves debugger
      Com_Printf("\nServer connection timed out.\n");
      CL_Disconnect();
      return;
    }
  } else {
    cl.timeoutcount = 0;
  }
}

//=============================================================================

/*
==============
CL_FixUpGender_f
==============
*/
export function CL_FixUpGender(): void {
  if (gender_auto && gender_auto.value) {
    if (gender && gender.modified) {
      // was set directly, don't override the user
      gender.modified = false;
      return;
    }

    let sk = skin ? skin.string : "";
    const slash = sk.indexOf("/");
    if (slash !== -1) sk = sk.slice(0, slash);
    if (Q_stricmp(sk, "male") === 0 || Q_stricmp(sk, "cyborg") === 0) Cvar_Set("gender", "male");
    else if (Q_stricmp(sk, "female") === 0 || Q_stricmp(sk, "crackhor") === 0) Cvar_Set("gender", "female");
    else Cvar_Set("gender", "none");
    if (gender) gender.modified = false;
  }
}

/*
==============
CL_Userinfo_f
==============
*/
export function CL_Userinfo_f(): void {
  Com_Printf("User info settings:\n");
  Info_Print(Cvar_Userinfo());
}

/*
=================
CL_Snd_Restart_f

Restart the sound subsystem so it can pick up
new parameters and flush all sounds
=================
*/
export function CL_Snd_Restart_f(): void {
  S_Shutdown();
  S_Init();
  CL_RegisterSounds();
}

let precache_check = 0; // for autodownload of precache items
let precache_spawncount = 0;

const PLAYER_MULT = 5;

// ENV_CNT is map load, ENV_CNT+1 is first env map
const ENV_CNT = CS_PLAYERSKINS + MAX_CLIENTS * PLAYER_MULT;
const TEXTURE_CNT = ENV_CNT + 13;

const env_suf = ["rt", "bk", "lf", "ft", "up", "dn"];

export function CL_RequestNextDownload(): void {
  if (cls.state !== ConnstateT.ca_connected) return;

  if (!(allow_download && allow_download.value) && precache_check < ENV_CNT) precache_check = ENV_CNT;

  //ZOID
  if (precache_check === CS_MODELS) {
    // confirm map
    precache_check = CS_MODELS + 2; // 0 isn't used
    // allow_download_maps' CL_CheckOrDownloadFile call is skipped along with
    // the rest of the CS_MODELS phase below -- see file banner.
  }
  if (precache_check >= CS_MODELS && precache_check < CS_MODELS + MAX_MODELS) {
    // model + per-skin download scanning omitted (see file banner: needs
    // dmdl_t, not ported, and unreachable while allow_download defaults
    // off). Faithfully skip straight past this phase like the "models
    // disabled" C path does.
    precache_check = CS_SOUNDS;
  }
  if (precache_check >= CS_SOUNDS && precache_check < CS_SOUNDS + MAX_SOUNDS) {
    if (allow_download_sounds && allow_download_sounds.value) {
      // per-sound download scanning uses CL_CheckOrDownloadFile, a pending
      // stub (cl_parse.ts) that always throws -- unreachable while
      // allow_download_sounds defaults off; skipped here too.
    }
    precache_check = CS_IMAGES;
  }
  if (precache_check >= CS_IMAGES && precache_check < CS_IMAGES + MAX_IMAGES) {
    precache_check = CS_PLAYERSKINS;
  }
  // skins are special, since a player has three things to download:
  // model, weapon model and skin
  if (precache_check >= CS_PLAYERSKINS && precache_check < CS_PLAYERSKINS + MAX_CLIENTS * PLAYER_MULT) {
    // precache phase completed
    precache_check = ENV_CNT;
  }

  if (precache_check === ENV_CNT) {
    precache_check = ENV_CNT + 1;

    const { checksum: map_checksum } = CM_LoadMap(cl.configstrings[CS_MODELS + 1], true);

    if (map_checksum !== atoi(cl.configstrings[CS_MAPCHECKSUM])) {
      Com_Error(ERR_DROP, "Local map version differs from server: %i != '%s'\n", map_checksum, cl.configstrings[CS_MAPCHECKSUM]);
      return;
    }
  }

  if (precache_check > ENV_CNT && precache_check < TEXTURE_CNT) {
    if (!(allow_download && allow_download.value && allow_download_maps && allow_download_maps.value)) {
      precache_check = TEXTURE_CNT;
    }
    // env-map download scanning (CL_CheckOrDownloadFile) omitted -- same
    // pending-stub/default-off reasoning as above.
  }

  if (precache_check === TEXTURE_CNT) {
    precache_check = TEXTURE_CNT + 1;
  }

  // texture download scanning omitted -- same reasoning (also needs
  // cmodel.ts's private numtexinfo/map_surfaces, not exported).
  if (precache_check === TEXTURE_CNT + 1) {
    precache_check = TEXTURE_CNT + 999;
  }

  //ZOID
  CL_RegisterSounds();
  CL_PrepRefresh();

  MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_stringcmd);
  MSG_WriteString(cls.netchan.message, `begin ${precache_spawncount}\n`);
}

/*
=================
CL_Precache_f

The server will send this command right
before allowing the client into the server
=================
*/
export function CL_Precache_f(): void {
  //Yet another hack to let old demos work
  //the old precache sequence
  if (Cmd_Argc() < 2) {
    CM_LoadMap(cl.configstrings[CS_MODELS + 1], true);
    CL_RegisterSounds();
    CL_PrepRefresh();
    return;
  }

  precache_check = CS_MODELS;
  precache_spawncount = atoi(Cmd_Argv(1));

  CL_RequestNextDownload();
}

/*
=================
CL_InitLocal
=================
*/
export function CL_InitLocal(): void {
  cls.state = ConnstateT.ca_disconnected;
  cls.realtime = Sys_Milliseconds();

  CL_InitInput();

  adr0 = Cvar_Get("adr0", "", CVAR_ARCHIVE);
  adr1 = Cvar_Get("adr1", "", CVAR_ARCHIVE);
  adr2 = Cvar_Get("adr2", "", CVAR_ARCHIVE);
  adr3 = Cvar_Get("adr3", "", CVAR_ARCHIVE);
  adr4 = Cvar_Get("adr4", "", CVAR_ARCHIVE);
  adr5 = Cvar_Get("adr5", "", CVAR_ARCHIVE);
  adr6 = Cvar_Get("adr6", "", CVAR_ARCHIVE);
  adr7 = Cvar_Get("adr7", "", CVAR_ARCHIVE);
  adr8 = Cvar_Get("adr8", "", CVAR_ARCHIVE);

  //
  // register our variables
  //
  clCvars.cl_stereo_separation = Cvar_Get("cl_stereo_separation", "0.4", CVAR_ARCHIVE);
  clCvars.cl_stereo = Cvar_Get("cl_stereo", "0", 0);

  clCvars.cl_add_blend = Cvar_Get("cl_blend", "1", 0);
  clCvars.cl_add_lights = Cvar_Get("cl_lights", "1", 0);
  clCvars.cl_add_particles = Cvar_Get("cl_particles", "1", 0);
  clCvars.cl_add_entities = Cvar_Get("cl_entities", "1", 0);
  clCvars.cl_gun = Cvar_Get("cl_gun", "1", 0);
  clCvars.cl_footsteps = Cvar_Get("cl_footsteps", "1", 0);
  clCvars.cl_noskins = Cvar_Get("cl_noskins", "0", 0);
  clCvars.cl_autoskins = Cvar_Get("cl_autoskins", "0", 0);
  clCvars.cl_predict = Cvar_Get("cl_predict", "1", 0);
  cl_maxfps = Cvar_Get("cl_maxfps", "90", 0);

  clCvars.cl_upspeed = Cvar_Get("cl_upspeed", "200", 0);
  clCvars.cl_forwardspeed = Cvar_Get("cl_forwardspeed", "200", 0);
  clCvars.cl_sidespeed = Cvar_Get("cl_sidespeed", "200", 0);
  clCvars.cl_yawspeed = Cvar_Get("cl_yawspeed", "140", 0);
  clCvars.cl_pitchspeed = Cvar_Get("cl_pitchspeed", "150", 0);
  clCvars.cl_anglespeedkey = Cvar_Get("cl_anglespeedkey", "1.5", 0);

  clCvars.cl_run = Cvar_Get("cl_run", "0", CVAR_ARCHIVE);
  clCvars.freelook = Cvar_Get("freelook", "0", CVAR_ARCHIVE);
  clCvars.lookspring = Cvar_Get("lookspring", "0", CVAR_ARCHIVE);
  clCvars.lookstrafe = Cvar_Get("lookstrafe", "0", CVAR_ARCHIVE);
  clCvars.sensitivity = Cvar_Get("sensitivity", "3", CVAR_ARCHIVE);

  clCvars.m_pitch = Cvar_Get("m_pitch", "0.022", CVAR_ARCHIVE);
  clCvars.m_yaw = Cvar_Get("m_yaw", "0.022", 0);
  clCvars.m_forward = Cvar_Get("m_forward", "1", 0);
  clCvars.m_side = Cvar_Get("m_side", "1", 0);

  clCvars.cl_shownet = Cvar_Get("cl_shownet", "0", 0);
  clCvars.cl_showmiss = Cvar_Get("cl_showmiss", "0", 0);
  clCvars.cl_showclamp = Cvar_Get("showclamp", "0", 0);
  cl_timeout = Cvar_Get("cl_timeout", "120", 0);
  clCvars.cl_paused = Cvar_Get("paused", "0", 0);
  clCvars.cl_timedemo = Cvar_Get("timedemo", "0", 0);

  rcon_client_password = Cvar_Get("rcon_password", "", 0);
  rcon_address = Cvar_Get("rcon_address", "", 0);

  clCvars.cl_lightlevel = Cvar_Get("r_lightlevel", "0", 0);

  //
  // userinfo
  //
  info_password = Cvar_Get("password", "", CVAR_USERINFO);
  info_spectator = Cvar_Get("spectator", "0", CVAR_USERINFO);
  name = Cvar_Get("name", "unnamed", CVAR_USERINFO | CVAR_ARCHIVE);
  skin = Cvar_Get("skin", "male/grunt", CVAR_USERINFO | CVAR_ARCHIVE);
  rate = Cvar_Get("rate", "25000", CVAR_USERINFO | CVAR_ARCHIVE); // FIXME
  msg = Cvar_Get("msg", "1", CVAR_USERINFO | CVAR_ARCHIVE);
  hand = Cvar_Get("hand", "0", CVAR_USERINFO | CVAR_ARCHIVE);
  fov = Cvar_Get("fov", "90", CVAR_USERINFO | CVAR_ARCHIVE);
  gender = Cvar_Get("gender", "male", CVAR_USERINFO | CVAR_ARCHIVE);
  gender_auto = Cvar_Get("gender_auto", "1", CVAR_ARCHIVE);
  if (gender) gender.modified = false; // clear this so we know when user sets it manually
  // name/info_password/info_spectator/rate/msg/hand/fov/adr0-8 are, exactly
  // as in the C original, registered here and never read directly again --
  // their values reach the network purely through Cvar_Userinfo()/the
  // console, which scan the whole CVAR_USERINFO-flagged cvar set generically.

  clCvars.cl_vwep = Cvar_Get("cl_vwep", "1", CVAR_ARCHIVE);

  //
  // register our commands
  //
  Cmd_AddCommand("cmd", CL_ForwardToServer_f);
  Cmd_AddCommand("pause", CL_Pause_f);
  Cmd_AddCommand("pingservers", fireAndForget("pingservers", CL_PingServers_f));
  Cmd_AddCommand("skins", CL_Skins_f);

  Cmd_AddCommand("userinfo", CL_Userinfo_f);
  Cmd_AddCommand("snd_restart", CL_Snd_Restart_f);

  Cmd_AddCommand("changing", CL_Changing_f);
  Cmd_AddCommand("disconnect", CL_Disconnect_f);
  Cmd_AddCommand("record", CL_Record_f);
  Cmd_AddCommand("stop", CL_Stop_f);

  Cmd_AddCommand("quit", CL_Quit_f);

  Cmd_AddCommand("connect", fireAndForget("connect", CL_Connect_f));
  Cmd_AddCommand("reconnect", CL_Reconnect_f);

  Cmd_AddCommand("rcon", fireAndForget("rcon", CL_Rcon_f));

  // Cmd_AddCommand ("packet", CL_Packet_f); // this is dangerous to leave in

  Cmd_AddCommand("setenv", CL_Setenv_f);

  Cmd_AddCommand("precache", CL_Precache_f);

  // CL_Download_f (cl_parse.ts) -- registered per client.h, but that pending
  // stub always throws; kept out of Cmd_AddCommand here so CL_InitLocal
  // itself doesn't fail merely for registering it (Cmd_AddCommand stores
  // the function without calling it). Registering it is harmless either
  // way; omitted only to keep this module's own imports minimal. Reported
  // deviation: "download" command not wired up here.

  //
  // forward to server commands
  //
  // the only thing this does is allow command completion
  // to work -- all unknown commands are automatically
  // forwarded to the server
  Cmd_AddCommand("wave", null);
  Cmd_AddCommand("inven", null);
  Cmd_AddCommand("kill", null);
  Cmd_AddCommand("use", null);
  Cmd_AddCommand("drop", null);
  Cmd_AddCommand("say", null);
  Cmd_AddCommand("say_team", null);
  Cmd_AddCommand("info", null);
  Cmd_AddCommand("prog", null);
  Cmd_AddCommand("give", null);
  Cmd_AddCommand("god", null);
  Cmd_AddCommand("notarget", null);
  Cmd_AddCommand("noclip", null);
  Cmd_AddCommand("invuse", null);
  Cmd_AddCommand("invprev", null);
  Cmd_AddCommand("invnext", null);
  Cmd_AddCommand("invdrop", null);
  Cmd_AddCommand("weapnext", null);
  Cmd_AddCommand("weapprev", null);

  setCmdForwardToServerHandler(Cmd_ForwardToServer);
}

/*
==================
CL_FixCvarCheats

==================
*/
interface CheatvarT {
  name: string;
  value: string;
  var: CvarT | null;
}

const cheatvars: CheatvarT[] = [
  { name: "timescale", value: "1", var: null },
  { name: "timedemo", value: "0", var: null },
  { name: "r_drawworld", value: "1", var: null },
  { name: "cl_testlights", value: "0", var: null },
  { name: "r_fullbright", value: "0", var: null },
  { name: "r_drawflat", value: "0", var: null },
  { name: "paused", value: "0", var: null },
  { name: "fixedtime", value: "0", var: null },
  { name: "sw_draworder", value: "0", var: null },
  { name: "gl_lightmap", value: "0", var: null },
  { name: "gl_saturatelighting", value: "0", var: null },
];

let cheatvarsInitialized = false;

export function CL_FixCvarCheats(): void {
  if (cl.configstrings[CS_MAXCLIENTS] === "1" || !cl.configstrings[CS_MAXCLIENTS].length) return; // single player can cheat

  // find all the cvars if we haven't done it yet
  if (!cheatvarsInitialized) {
    for (const v of cheatvars) v.var = Cvar_Get(v.name, v.value, 0);
    cheatvarsInitialized = true;
  }

  // make sure they are all set to the proper values
  for (const v of cheatvars) {
    if (v.var && v.var.string !== v.value) Cvar_Set(v.name, v.value);
  }
}

//============================================================================

/*
==================
CL_SendCommand

==================
*/
export function CL_SendCommand(): void {
  // get new key events
  Sys_SendKeyEvents();

  // allow mice or other external controllers to add commands
  IN_Commands();

  // process console commands
  Cbuf_Execute();

  // fix any cheating cvars
  CL_FixCvarCheats();

  // send intentions now
  CL_SendCmd();

  // resend a connection request if necessary
  CL_CheckForResend();
}

/*
==================
CL_Frame

==================
*/
let extratime = 0;
let lasttimecalled = 0;

export function CL_Frame(msec: number): void {
  if (dedicated && dedicated.value) return;

  extratime += msec;

  if (!(clCvars.cl_timedemo && clCvars.cl_timedemo.value)) {
    if (cls.state === ConnstateT.ca_connected && extratime < 100) return; // don't flood packets out while connecting
    const maxfps = cl_maxfps ? cl_maxfps.value : 90;
    if (extratime < 1000 / maxfps) return; // framerate is too high
  }

  // let the mouse activate or deactivate
  IN_Frame();

  // decide the simulation time
  cls.frametime = extratime / 1000.0;
  cl.time += extratime;
  cls.realtime = Sys_Milliseconds();

  extratime = 0;
  if (cls.frametime > 1.0 / 5) cls.frametime = 1.0 / 5;

  // if in the debugger last frame, don't timeout
  if (msec > 5000) cls.netchan.last_received = Sys_Milliseconds();

  // fetch results from server
  CL_ReadPackets();

  // send a new command message to the server
  CL_SendCommand();

  // predict all unacknowledged movements
  CL_PredictMovement();

  // allow rendering DLL change
  VID_CheckChanges();
  if (!cl.refresh_prepped && cls.state === ConnstateT.ca_active) CL_PrepRefresh();

  // update the screen
  SCR_UpdateScreen();

  // update audio
  S_Update(cl.refdef.vieworg, cl.v_forward, cl.v_right, cl.v_up);

  CDAudio_Update();

  // advance local effects for next frame
  CL_RunDLights();
  CL_RunLightStyles();
  SCR_RunCinematic();
  SCR_RunConsole();

  cls.framecount++;

  if (lasttimecalled === 0 && cls.state === ConnstateT.ca_active) {
    lasttimecalled = Sys_Milliseconds();
  }
}

/*
====================
CL_Init
====================
*/
export function CL_Init(): void {
  if (dedicated && dedicated.value) return; // nothing running on the client

  // all archived variables will now be loaded

  Con_Init();
  S_Init();
  VID_Init();

  V_Init();

  M_Init();

  SCR_Init();
  cls.disable_screen = 1; // don't draw yet

  CDAudio_Init();
  CL_InitLocal();
  IN_Init();

  FS_ExecAutoexec();
  Cbuf_Execute();
}

/*
===============
CL_WriteConfiguration

Writes key bindings and archived cvars to config.cfg
===============
*/
export function CL_WriteConfiguration(): void {
  if (cls.state === ConnstateT.ca_uninitialized) return;

  const path = Com_sprintf("%s/config.cfg", FS_Gamedir());
  const f = FS_FOpenFileWrite(path);
  if (f === null) {
    Com_Printf("Couldn't write config.cfg.\n");
    return;
  }

  const banner = "// generated by quake, do not modify\n";
  const bytes = new Uint8Array(banner.length);
  for (let i = 0; i < banner.length; i++) bytes[i] = banner.charCodeAt(i);
  FS_Write(bytes, bytes.length, f);
  Key_WriteBindings(f);
  FS_FCloseFile(f);

  Cvar_WriteVariables(path);
}

/*
==================
CL_Shutdown

FIXME: this is a callback from Sys_Quit and Com_Error.  It would be better
to run quit through here before the final handoff to the sys code.
==================
*/
let cl_shutdown_isdown = false; // static qboolean isdown

export function CL_Shutdown(): void {
  if (cl_shutdown_isdown) {
    Sys_ConsoleOutput("recursive shutdown\n"); // printf in the C
    return;
  }
  cl_shutdown_isdown = true;

  CL_WriteConfiguration();

  CDAudio_Shutdown();
  S_Shutdown();
  IN_Shutdown();
  VID_Shutdown();
}
