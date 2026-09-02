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
// - CL_RequestNextDownload is now ported in full, including the alias-model
//   skin-scanning inner block (dmdl_t.num_skins/ofs_skins, read via
//   qfiles.ts's readMd2SkinNames -- see that function's doc comment for why
//   the header reader lives there instead of duplicating ref_gl/ref_soft's
//   private full-model parsers) and the CS_PLAYERSKINS-phase model/skin
//   downloads. One deliberate addition beyond vanilla: q2repro's
//   download.c check_player() sexed-sound downloads (files like
//   "*pain100_1.wav" resolved to "players/<model>/pain100_1.wav" per
//   player) are ported too -- vanilla cl_main.c never downloads these at
//   all, but real interop against q2repro/Q2PRO servers expects them
//   (fidelity razor, .orch/preferences.md rule 17: functional interop
//   outranks literal vanilla-only preservation). See the function's own
//   comments for exactly where this splices into the vanilla per-player
//   case 0..4 fallthrough without disturbing its numbering.
//   CL_RequestNextDownload's texture-download phase (CS_MODELS+MAX_MODELS+13
//   -area, "textures/<name>.wal" for every BSP texinfo) also now runs, via
//   two new additive accessors on cmodel.ts (CM_NumTexinfo/CM_TexinfoName)
//   standing in for vanilla's `extern int numtexinfo; extern mapsurface_t
//   map_surfaces[];`. The CS_MODELS model-registration loop deliberately
//   does NOT special-case KEX's MODELINDEX_PLAYER gap (q2repro's `i !=
//   MODELINDEX_PLAYER`) -- cl_view.ts's CL_PrepRefresh model loop, the only
//   other place in this port that walks the same CS_MODELS array, already
//   made that same vanilla-only choice, and this stays consistent with it.
// - rcon_client_password/rcon_address/adr0-8/cl_timeout/cl_maxfps/
//   info_password/info_spectator/name/skin/rate/fov/msg/hand/gender/
//   gender_auto/precache_*/cheatvars are cl_main.c file-scope globals that
//   client.ts's clCvars holder did not anticipate (it mirrors CL_InitLocal's
//   registrations but omits these); hosted as module-private state here
//   instead of adding fields to client.ts (out of SCOPE).

import { Haptics_Frame } from "../platform/haptics";
import { IN_Shutdown } from "../platform/sdl";
import { CDAudio_Shutdown, CDAudio_Init, CDAudio_Update } from "../platform/cd_ogg";
import { Key_WriteBindings } from "./keys_impl";
import { Cmd_Argc, Cmd_Argv, Cmd_Args, Cmd_AddCommand, Cmd_TokenizeString, Cbuf_AddText, Cbuf_Execute, setCmdForwardToServerHandler } from "../qcommon/cmd";
import { Cvar_WriteVariables, Cvar_Get, Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString, Cvar_Userinfo, SetUserinfoModified } from "../qcommon/cvar";
import { Com_Printf, Com_DPrintf, Com_Error, Com_Quit, Com_ServerState, Com_ServerConnectProtocol, Info_Print, dedicated, COM_BlockSequenceCRCByte } from "../qcommon/common";
import {
  NetadrT,
  NetadrtypeT,
  NetsrcT,
  ComError,
  ERR_DROP,
  SvcOpsT,
  ClcOpsT,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_R1Q2_CURRENT,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_Q2PRO_CURRENT,
  PROTOCOL_VERSION_RERELEASE,
  PROTOCOL_VERSION_RERELEASE_CLASSIC,
  PORT_SERVER,
  MAX_MSGLEN,
} from "../qcommon/qcommon";
import { NET_StringToAdr, NET_AdrToString, NET_CompareAdr, NET_IsLocalAddress, NET_SendPacket, NET_GetPacket, NET_Config } from "../platform/net_udp";
import {
  Netchan_OutOfBandPrint,
  Netchan_Setup,
  Netchan_Transmit,
  Netchan_Process,
  net_from,
  net_message,
  NETCHAN_OLD,
  NETCHAN_NEW,
  MAX_PACKETLEN_WRITABLE,
} from "../qcommon/net_chan";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Print, MSG_WriteByte, MSG_WriteChar, MSG_WriteShort, MSG_WriteLong, MSG_WriteString, MSG_ReadString, MSG_ReadStringLine, MSG_BeginReading, MSG_ReadLong } from "../qcommon/sizebuf";
import { FS_Gamedir, FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile, FS_ExecAutoexec, FS_LoadFile } from "../qcommon/files";
import { CM_LoadMap, CM_NumTexinfo, CM_TexinfoName } from "../qcommon/cmodel";
import { readMd2SkinNames } from "../qcommon/qfiles";
import { COM_FileExtension } from "../shared/math";
import { SV_Shutdown } from "../server/sv_main";
import { CG_SetActiveCgameKind } from "./cgame/host";
import { allow_download, allow_download_players, allow_download_models, allow_download_sounds, allow_download_maps } from "../server/sv_main";
import {
  Com_sprintf,
  CVAR_ARCHIVE,
  CVAR_NOSET,
  CVAR_USERINFO,
  CVAR_CHEAT,
  CVAR_PRIVATE,
  MAX_CLIENTS,
  CS_NAME,
  CS_SKY,
  Q_stricmp,
  type CvarT,
} from "../shared/q_shared";
import { cl, cls, cl_entities, ConnstateT, CentityT, clCvars } from "./client";
import { CL_InitInput, CL_SendCmd, IN_Commands, IN_Frame, IN_Init, Sys_SendKeyEvents } from "./cl_input";
import { CL_Seats_Init, CL_Seats_Reconcile, CL_Seats_SendCmds, CL_Seats_DrainServerMessages, CL_Seats_Shutdown } from "./cl_seats";
import { VID_Shutdown, VID_CheckChanges, VID_Front_f, VID_Init } from "../platform/vid";
import { CL_PredictMovement } from "./cl_pred";
import { CL_RunDLights, CL_RunLightStyles, CL_ClearEffects } from "./cl_fx";
import { CL_ClearTEnts } from "./cl_tent";
import { S_StopAllSounds, S_Update, S_Init, S_Shutdown } from "./snd_dma";
import { CL_RegisterSounds, CL_ParseClientinfo, CL_ParseServerMessage, CL_StartUdpDownload, CL_CheckOrDownloadFile as CL_CheckOrDownloadFileRemote } from "./cl_parse";
import { HTTP_Init, HTTP_SetServer, HTTP_SetCallbacks, HTTP_CleanupDownloads, HTTP_RunDownloads } from "./cl_http";
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
// cvar-parity audit additions -- see CL_InitLocal, CL_Disconnect, CL_Changing_f
let cl_disconnectcmd: CvarT | null = null;
let cl_changemapcmd: CvarT | null = null;

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
  // vanilla cl_main.c CL_Record_f: `cls.demorecording = true;` right after
  // the file opens. This line was dropped in the port, and since
  // cl_parse.ts's per-frame write gate is `demorecording && !demowaiting`,
  // its absence meant no .dm2 ever contained a single frame message (found
  // by the demo cross-play harness).
  cls.demorecording = true;

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

  // send the serverdata -- through the NEGOTIATED family's codec, not a
  // hand-written vanilla-shaped block. The old code hardcoded
  // PROTOCOL_VERSION (34) and the six vanilla fields while the
  // configstring/baseline loops below use the live cls.csr/cls.codec, so
  // every non-vanilla recording carried a header its own body contradicted:
  // replay's selectServerCodec picked the narrow vanilla codec and threw
  // "configstring > MAX_CONFIGSTRINGS" (and, once past that, 1038's extra
  // serverdata fields were simply missing from the stream). Found by the
  // demo cross-play harness. Vanilla sessions are byte-identical to before
  // (vanilla.ts's writeServerData emits exactly the old shape).
  cls.codec.writeServerData(buf, {
    // vanilla cl_main.c CL_Record_f writes `0x10000 + cl.servercount` as
    // the demo's servercount marker; q2pro's demo.c does the same.
    servercount: 0x10000 + cl.servercount,
    attractloop: true, // demos are always attract loops
    gamedir: cl.gamedir,
    clientnum: cl.playernum,
    levelname: cl.configstrings[CS_NAME],
    // ss_game: recording requires ca_active, which only exists against a
    // running game server. Read-side, this port's own CL_ParseServerData
    // discards the byte (no client consumer), so the literal matches
    // sv_ccmds.ts's server-side demo-record precedent without importing
    // the server's ServerStateT enum into client code.
    serverState: 2,
  });

  // configstrings
  for (let i = 0; i < cls.csr.end; i++) {
    if (cl.configstrings[i].length) {
      if (buf.cursize + cl.configstrings[i].length + 32 > buf.maxsize) flush();

      MSG_WriteByte(buf, SvcOpsT.svc_configstring);
      MSG_WriteShort(buf, i);
      MSG_WriteString(buf, cl.configstrings[i]);
    }
  }

  // baselines
  // q2repro demo.c:593/1022 `for (i = 1; i < cl.csr.max_edicts; i++)` -- family-
  // active bound (was the vanilla-only MAX_EDICTS constant) and starts at
  // entity 1, skipping the world entity exactly like the reference (harmless
  // either way here since entity 0's baseline.modelindex is always 0, but
  // matching upstream's own loop bounds now that this is being touched).
  for (let i = 1; i < cls.csr.max_edicts; i++) {
    const ent = cl_entities[i].baseline;
    if (!ent.modelindex) continue;

    if (buf.cursize + 64 > buf.maxsize) flush();

    cls.codec.writeSpawnBaseline(buf, cl_entities[i].baseline);
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
// Protocols this client can actually speak, for challenge p= negotiation
// (see the "challenge" connectionless case): vanilla 34, R1Q2 35, Q2PRO 36,
// kex/q2repro 1038.
const SUPPORTED_CONNECT_PROTOCOLS = [
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_RERELEASE,
  // This engine's own number for a classic-module session that widened its
  // configstring space (qcommon.ts's PROTOCOL_VERSION_RERELEASE_CLASSIC).
  // Listed so the challenge-driven selection below can pick it when such a
  // server advertises it; the loopback path takes it from the
  // Com_ServerConnectProtocol bridge instead.
  PROTOCOL_VERSION_RERELEASE_CLASSIC,
];
// The p= list from the most recent challenge reply; cleared when a new
// server connection begins (CL_Disconnect).
let challenge_protocols: number[] = [];

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

  // v1.0.0 wire cluster (task board #23): cl_protocol picks which protocol
  // this client requests (defaults to PROTOCOL_VERSION/34 -- see
  // clCvars.cl_protocol's doc comment in client.ts for why the default must
  // not change). R1Q2 (35) and Q2PRO (36) each append their own trailing
  // connect-string tokens after the standard four fields
  // (q2proto_r1q2_connect_tail / q2proto_q2pro_connect_tail); protocol 34
  // sends none, matching this engine's wire bytes exactly as before.
  let protocol = clCvars.cl_protocol ? clCvars.cl_protocol.value : PROTOCOL_VERSION;
  const localProtocol = Com_ServerConnectProtocol();
  if (cls.servername === "localhost" && Com_ServerState() && localProtocol) {
    // The integrated local server's family demands one specific protocol
    // (kex: 1038 only) and the localhost path never runs getchallenge, so
    // there is no p= list to negotiate from -- take the server's own word
    // via the Com_ServerConnectProtocol bridge. Without this, a client
    // defaulting to 34 was version-rejected by its own campaign server in
    // an endless connect loop.
    protocol = localProtocol;
  } else if (challenge_protocols.length > 0 && !challenge_protocols.includes(protocol)) {
    // Remote (or challenge-driven local) connect: the server advertised
    // which protocols it accepts and ours isn't among them -- pick the
    // best mutually-supported one instead of looping on rejection,
    // mirroring q2proto_parse_challenge's client-side selection. Protocol
    // numbers rank naturally (34 < 35 < 36 < 1038).
    const usable = challenge_protocols.filter((p) => SUPPORTED_CONNECT_PROTOCOLS.includes(p));
    if (usable.length > 0) protocol = Math.max(...usable);
  }
  // q2repro's own client-side packet_length request (client/main.c:458-462
  // CL_CheckForResend): "use maximum allowed msglen for loopback" --
  // MAX_PACKETLEN_WRITABLE (4086) for a loopback destination, or the
  // net_maxmsglen cvar (default 1390, chan.c:130) for a real network one.
  // All three negotiating families carry this as the FIRST tail token
  // (q2proto_proto_r1q2.c:55, q2proto_proto_q2pro.c:77,
  // q2proto_proto_q2repro.c:54); vanilla (34) has no such field, and the
  // `tail` assembly below leaves it out entirely for that protocol.
  // Cvar_Get (not a cached module var) so this is correct regardless of
  // whether CL_InitLocal's own registration below has run yet -- Cvar_Get
  // is idempotent by name.
  const netMaxmsglenCvar = Cvar_Get("net_maxmsglen", "1390", 0);
  const netMaxmsglen = netMaxmsglenCvar ? netMaxmsglenCvar.value : MAX_MSGLEN - 10;
  const packetLength = NET_IsLocalAddress(adr) ? MAX_PACKETLEN_WRITABLE : netMaxmsglen;
  let tail = "";
  if (protocol === PROTOCOL_VERSION_R1Q2) {
    tail = ` ${packetLength} ${PROTOCOL_VERSION_R1Q2_CURRENT}`;
  } else if (protocol === PROTOCOL_VERSION_Q2PRO) {
    // netchan_type=1 (NETCHAN_NEW): phase-8 q2repro interop (matrix cell b)
    // confirmed a real q2repro-family client/server always uses NETCHAN_NEW
    // framing at this protocol version (net_chan.ts's NETCHAN_NEW doc
    // comment has the exact wire difference and how it was found). This
    // port now implements NETCHAN_NEW's non-fragmented subset, so requesting
    // it here is what CL_SendConnectPacket's own Netchan_Setup call below
    // actually transmits -- no longer the "honest NETCHAN_OLD" this comment
    // used to describe back when the framing wasn't implemented at all.
    // has_zlib=1: this port DOES implement svc_r1q2_zpacket unwrap
    // (qcommon/protocol/zpacket.ts), so advertising support is accurate.
    tail = ` ${packetLength} 1 1 ${PROTOCOL_VERSION_Q2PRO_CURRENT}`;
  } else if (protocol === PROTOCOL_VERSION_RERELEASE || protocol === PROTOCOL_VERSION_RERELEASE_CLASSIC) {
    // q2repro's own connect tail for 1038 (q2proto_q2repro_connect_tail:
    // "%d %d" = packet_length, has_zlib) -- no netchan_type field at all,
    // because kex/1038 always implies NETCHAN_NEW unconditionally on both
    // ends (this port's sv_main.ts SVC_DirectConnect mirrors this: the kex
    // family always selects NETCHAN_NEW with no per-client negotiation,
    // matching q2repro's own hardcoded client-side behavior).
    tail = ` ${packetLength} 1`;
  }

  // q2proto masks the advertised qport to 8 bits for every protocol whose
  // netchan writes it as a single byte -- q2proto_proto_r1q2.c:49,
  // q2proto_proto_q2pro.c:71 and q2proto_proto_q2repro.c:47 all run
  // `connect->qport &= 0xff;` inside q2proto_complete_connect, and q2repro's
  // client then keeps THAT value as cls.quakePort (src/client/main.c:478).
  // Without the mask this client told the server a 16-bit qport while its
  // netchan transmitted only the low byte, so the server's per-client qport
  // comparison rejected every post-connect packet and the session died at
  // "client_connect" -- caught by the self-play interop cells, which stalled
  // there for every random qport >= 256 and completed the full handshake the
  // moment `+set qport 100` forced an 8-bit-safe value.
  const advertisedPort = protocol >= PROTOCOL_VERSION_R1Q2 ? port & 0xff : port;
  cls.quakePort = advertisedPort;
  // cls.serverProtocol was previously never assigned anywhere in this port
  // (see client.ts's doc comment on the field). q2repro sets it during the
  // challenge/connect exchange and then branches real wire behavior on it --
  // CL_ParsePlayerSkin's dogtag field is gated on `cls.serverProtocol ==
  // PROTOCOL_VERSION_RERELEASE` (src/client/download.c:549) -- so record what
  // this connect string actually requested.
  cls.serverProtocol = protocol;

  Netchan_OutOfBandPrint(NetsrcT.NS_CLIENT, adr, `connect ${protocol} ${advertisedPort} ${cls.challenge} "${Cvar_Userinfo()}"${tail}\n`);
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

  // Local splitscreen seats are server clients of the game this connection
  // was playing (src/server/sv_seats.ts); they go with it. CL_Seats_Reconcile
  // would tear them down on the next frame anyway, but leaving occupied
  // player slots behind across a disconnect would make the NEXT session
  // start short of slots.
  CL_Seats_Shutdown();

  // A fresh connection negotiates from its own challenge reply -- never
  // from the previous server's advertised list.
  challenge_protocols = [];

  // q2repro src/client/main.c:731 -- EXEC_TRIGGER(cl_disconnectcmd), gated
  // on cls.state > ca_disconnected (guaranteed by the guard above) and
  // !cls.demo.playback.
  if (!cls.demoplayback && cl_disconnectcmd && cl_disconnectcmd.string) {
    Cbuf_AddText(cl_disconnectcmd.string);
    Cbuf_AddText("\n");
  }

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

  // task #24: mirrors Q2PRO's CL_CleanupDownloads calling HTTP_CleanupDownloads
  HTTP_CleanupDownloads();

  cls.state = ConnstateT.ca_disconnected;

  // Revert to the default cgame (host.ts's CG_SetActiveCgameKind own doc
  // comment): a disconnect ends this connection's family entirely, so the
  // next connect() (whatever family it turns out to be) should not inherit
  // a stale "kex" selection left over from this one. CL_ParseServerData
  // re-selects the correct kind for the new connection regardless, but
  // leaving the OLD kind active in between (e.g. while sitting at the
  // console, disconnected) would mean CG_DrawHUD -- if ever called in that
  // state -- runs the wrong cgame.
  CG_SetActiveCgameKind("classic");
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

  // q2repro src/client/main.c:1017-1019 -- EXEC_TRIGGER(cl_changemapcmd);
  // "#cl_enterlevel"-style trigger aliases are not ported, only the cvar.
  if (!cls.demoplayback && cl_changemapcmd && cl_changemapcmd.string) {
    Cbuf_AddText(cl_changemapcmd.string);
    Cbuf_AddText("\n");
  }
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
    if (!cl.configstrings[cls.csr.playerskins + i].length) continue;
    Com_Printf("client %i: %s\n", i, cl.configstrings[cls.csr.playerskins + i]);
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

    // task #24 dlserver negotiation: ported from Q2PRO src/client/main.c's
    // "client_connect" handler, which scans the extra space-separated
    // parameters appended to this same out-of-band string for a
    // "dlserver=<url>" token (see src/server/main.c's send_connect_packet,
    // mirrored on our server side in sv_main.ts's SV_ConnectionlessPacket).
    // This is plain connectionless-packet string handling in cl_main.c's
    // own file in the original -- no wire-protocol/codec change, so it
    // needs no touch to src/qcommon/protocol/ (which this brief is scoped
    // away from). Only "dlserver=" is ported; Q2PRO's other tokens on this
    // same line (ac=/nc=/map=) belong to netchan-type/anticheat negotiation
    // outside this brief's scope and are left untouched.
    let dlserver: string | null = null;
    for (let i = 1; i < Cmd_Argc(); i++) {
      const arg = Cmd_Argv(i);
      if (arg.slice(0, 9) === "dlserver=") {
        dlserver = arg.slice(9);
        break;
      }
    }
    HTTP_SetServer(dlserver, NET_IsLocalAddress(net_from));

    // phase-8 q2repro interop (matrix cell b): must match whatever netchan
    // framing CL_SendConnectPacket actually requested for this protocol
    // (net_chan.ts's NETCHAN_NEW doc comment). CL_SendConnectPacket records
    // its ACTUAL choice in cls.serverProtocol -- which, since challenge p=
    // negotiation and the local-server protocol bridge landed, can differ
    // from cl_protocol's cvar value (the campaign-start fix: an integrated
    // kex server forces 1038 regardless of the cvar). Re-deriving from the
    // cvar here left the netchan in OLD framing while the server spoke NEW,
    // shifting every payload byte -- the post-connect "unknown command
    // char" reconnect loop.
    const connectProtocol = cls.serverProtocol || (clCvars.cl_protocol ? clCvars.cl_protocol.value : PROTOCOL_VERSION);
    // PROTOCOL_VERSION_RERELEASE_CLASSIC is 1038's wire under a different
    // number (qcommon.ts), so it takes 1038's framing too -- sv_main.ts's
    // SVC_DirectConnect picks NETCHAN_NEW for every wide session, this side
    // has to agree or every payload byte shifts.
    const chanType =
      connectProtocol === PROTOCOL_VERSION_RERELEASE ||
      connectProtocol === PROTOCOL_VERSION_RERELEASE_CLASSIC ||
      connectProtocol === PROTOCOL_VERSION_Q2PRO
        ? NETCHAN_NEW
        : NETCHAN_OLD;
    // connectProtocol is load-bearing beyond chanType: under NETCHAN_OLD the
    // qport field is a 16-bit short below R1Q2 and a single byte from R1Q2 up
    // (net_chan.ts's NETCHAN_NEW doc comment), so protocol 35 needs it to pick
    // the right width.
    Netchan_Setup(NetsrcT.NS_CLIENT, cls.netchan, net_from, cls.quakePort, chanType, connectProtocol);
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
    // q2proto_parse_challenge: tokens after the challenge number may carry
    // "p=<proto>,<proto>,..." -- the server's advertised protocol list (our
    // own SVC_GetChallenge sends p=1038 for the kex family, p=34,35,36 for
    // legacy; real q2repro/q2proto servers always send it). Record it so
    // CL_SendConnectPacket can pick a mutually-supported protocol instead
    // of blindly requesting cl_protocol's value at a server that rejects
    // it (the kex family accepts ONLY 1038).
    challenge_protocols = [];
    for (let i = 2; i < Cmd_Argc(); i++) {
      const tok = Cmd_Argv(i);
      if (tok.startsWith("p=")) {
        for (const p of tok.slice(2).split(",")) {
          const n = atoi(p);
          if (n > 0) challenge_protocols.push(n);
        }
      }
    }
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

// CS_MODELS-phase inner state (vanilla cl_main.c's precache_model/
// precache_model_skin globals). precache_model_skinnames holds the *parsed*
// skin name list for the model currently being scanned instead of the raw
// dmdl_t bytes + a live pointer into them -- this port has no Hunk memory to
// keep the raw buffer pinned across suspended calls, and the download walk
// only ever needs the skin filenames, never the model geometry. null means
// "no model loaded/parsed for the current precache_check index yet", exactly
// like vanilla's `if (!precache_model)` gate.
let precache_model_skinnames: string[] | null = null;
let precache_model_skin = 0;

// CS_PLAYERSKINS-phase sexed-sound resume index (see the phase's own
// comment below for why this needs a resumable cursor of its own).
let precache_sexed_sounds: number[] = [];
let precache_sexed_check = 0;

// Per-player-slot latches for the two CS_PLAYERSKINS sub-steps that share the
// `base + 4` resume index with the sexed-sound loop (skin_i and the
// rerelease dogtag). Without them a file the server does not have is
// re-requested forever -- see the skin_i block in CL_RequestNextDownload.
let precache_player_skin_i_done = false;
let precache_player_dogtag_done = false;

// TEXTURE_CNT+1-phase resume index (vanilla cl_main.c's precache_tex).
let precache_tex = 0;

const PLAYER_MULT = 5;

// ENV_CNT is map load, ENV_CNT+1 is first env map. These were originally
// module-level constants (`CS_PLAYERSKINS + MAX_CLIENTS * PLAYER_MULT`), but
// CS_PLAYERSKINS now varies per connection (cls.csr.playerskins -- classic
// vs kex/rerelease configstring-index layout, shared/cs_remap.ts), so they
// are computed off the ACTIVE csr instead of being fixed at module load.
function envCnt(): number {
  return cls.csr.playerskins + MAX_CLIENTS * PLAYER_MULT;
}
function textureCnt(): number {
  return envCnt() + 13;
}

const env_suf = ["rt", "bk", "lf", "ft", "up", "dn"];

// Isolates model/skin/dogtag from a CS_PLAYERSKINS configstring, ported from
// q2repro's CL_ParsePlayerSkin (src/client/precache.c:70-135), which its own
// check_player (src/client/download.c:544-551) calls with `parse_dogtag =
// cls.serverProtocol == PROTOCOL_VERSION_RERELEASE`.
//
// The classic configstring is "name\model/skin"; the rerelease game appends a
// THIRD backslash-separated field, the dogtag -- kexgame/p_client.ts:2783
// writes `${netname}\\${skin}\\${dogtag}` verbatim. Parsing that with the
// two-field rule leaves the dogtag glued to the skin, so a default kex
// loadout ("unnamed\male/grunt\default") asked the server for
// `players/male/grunt\default_i.pcx` -- a path with a literal backslash in
// it that can never exist. Caught by the self-play matrix cells (cell f):
// the client wedged in precache, re-requesting that one file forever.
//
// The C's `if (!t && !parse_dogtag) t = strchr(model, '\\')` fallback reads
// the OUTPUT buffer `model` rather than `model_str`, which at that point
// holds whatever the caller's stack had. This port searches the string that
// was actually being parsed (RULE-17: an uninitialized read cannot be
// reproduced faithfully here, so match the evidently intended behavior --
// which is also what the surrounding comment in precache.c describes).
function parsePlayerSkinConfigstring(s: string, parseDogtag: boolean): { model: string; skin: string; dogtag: string } {
  let rest = s;
  const bs = rest.indexOf("\\");
  if (bs !== -1) rest = rest.slice(bs + 1);

  let model = rest;
  let skin: string | null = null;
  let slash = model.indexOf("/");
  if (slash === -1 && !parseDogtag) slash = model.indexOf("\\");
  if (slash !== -1) {
    skin = model.slice(slash + 1);
    model = model.slice(0, slash);
  }

  // isolate the dogtag name (precache.c:111-119)
  let dogtag = "";
  if (parseDogtag) {
    const search = skin !== null ? skin : model;
    const t = search.indexOf("\\");
    if (t !== -1) {
      dogtag = search.slice(t + 1);
      if (skin !== null) skin = search.slice(0, t);
      else model = search.slice(0, t);
    }
  }

  // fix empty model to male (precache.c:126-129)
  if (!model.length) model = "male";
  if (!dogtag.length) dogtag = "default";
  return { model, skin: skin ?? "", dogtag };
}

// Set once per precache walk, so the "not downloading from ourselves" note
// is printed at most once per connection instead of once per missing file.
let precache_local_notice = false;

/*
===============
CL_ServerIsOurOwn

"The server we are downloading from is this same process." q2repro spells
this `NET_IsLocalAddress(&cls.serverAddress)`, where cls.serverAddress.type
is set to NA_LOOPBACK only in CL_CheckForResend's listen-server branch
(q2repro src/client/main.c:412-416).

This port has no cls.serverAddress field, and neither obvious substitute
works alone:

  - net_udp.ts's NET_IsLocalAddress now IS q2repro's own `type == NA_LOOPBACK`
    macro (fixed post-1.0 -- it used to delegate to vanilla's own
    NET_CompareAdr(adr, net_local_adr), a value compare against a
    never-assigned zeroed global that could misclassify an all-zero NA_IP
    address as local; see net_udp.ts's own NET_IsLocalAddress comment). Using
    it here directly would still work today, but this function keeps its own
    explicit `.type` check below rather than importing it, for the second
    reason:

  - the NA_LOOPBACK type test alone is unsafe here because NetadrT.type
    DEFAULTS to NA_LOOPBACK (qcommon.ts's NetadrT initializer), so a netchan
    that has not been set up yet reads as "local" and would silently disable
    downloads against a genuinely remote server.

So both halves are required: Com_ServerState() answers "is this process
running a server at all" unambiguously, and the NA_LOOPBACK test then
distinguishes that server's own loopback client from any other peer.
===============
*/
function CL_ServerIsOurOwn(): boolean {
  return Com_ServerState() !== 0 && cls.netchan.remote_address.type === NetadrtypeT.NA_LOOPBACK;
}

/*
===============
CL_CheckOrDownloadFile (precache-walk wrapper)

q2repro gates its ENTIRE download walk on the server being remote
(src/client/download.c:627, the first substantive statement of
CL_RequestNextDownload):

    if (allow_download->integer <= 0 || NET_IsLocalAddress(&cls.serverAddress)) {
        if (precache_check <= PRECACHE_MAP)
            CL_RegisterBspModels();
        CL_Begin();
        return;
    }

with NET_IsLocalAddress(adr) == ((adr)->type == NA_LOOPBACK)
(q2repro inc/common/net/net.h:105). Vanilla has no such check
(quake-2-c/client/cl_main.c:1117-1128 tests only allow_download), so this is
a q2repro-era addition, adopted here for the reason Mike hit on 2026-09-01:
a LISTEN server cannot serve a file it does not itself have, so every one of
those requests is guaranteed to fail, and a ruleset whose asset set the
mounted data tree does not cover turns that into hundreds of doomed
"Downloading ..." lines.

Ported as a per-file skip rather than q2repro's whole-walk early return:
this port's walk does registration work along the way that its ENV_CNT/
TEXTURE_CNT phases depend on, and it has no CL_RegisterBspModels/CL_Begin
pair to jump to (rule 17 -- the observable behavior q2repro produces, no
download attempts and no per-file spam on a local server, is what is
preserved; the internal route to it differs because the surrounding walk
does).

Returning true means "treat as present" -- exactly what the walk does for a
file that already resolved -- so it advances to the next item instead of
stalling on a request that will never be answered. The explicit `download`
console command (cl_parse.ts's CL_Download_f) is deliberately NOT routed
through here: an operator asking for a specific file by hand should still
get the attempt and its error.
===============
*/
function CL_CheckOrDownloadFile(filename: string, type: Parameters<typeof CL_CheckOrDownloadFileRemote>[1] = "single"): boolean {
  if (CL_ServerIsOurOwn()) {
    if (!precache_local_notice) {
      precache_local_notice = true;
      Com_DPrintf("Local server: skipping downloads for missing files\n");
    }
    return true;
  }
  return CL_CheckOrDownloadFileRemote(filename, type);
}

export function CL_RequestNextDownload(): void {
  if (cls.state !== ConnstateT.ca_connected) return;

  const ENV_CNT = envCnt();
  const TEXTURE_CNT = textureCnt();

  if (!(allow_download && allow_download.value) && precache_check < ENV_CNT) precache_check = ENV_CNT;

  //ZOID
  if (precache_check === cls.csr.models) {
    // confirm map
    precache_check = cls.csr.models + 2; // 0 isn't used
    if (allow_download_maps && allow_download_maps.value) {
      if (!CL_CheckOrDownloadFile(cl.configstrings[cls.csr.models + 1], "model")) return; // started a download
    }
  }
  if (precache_check >= cls.csr.models && precache_check < cls.csr.models + cls.csr.max_models) {
    if (allow_download_models && allow_download_models.value) {
      while (precache_check < cls.csr.models + cls.csr.max_models && cl.configstrings[precache_check][0]) {
        const name = cl.configstrings[precache_check];
        if (name[0] === "*" || name[0] === "#") {
          precache_check++;
          continue;
        }

        if (precache_model_skin === 0) {
          if (!CL_CheckOrDownloadFile(name, "model")) {
            precache_model_skin = 1;
            return; // started a download
          }
          precache_model_skin = 1;
        }

        // checking for skins in the model
        if (precache_model_skinnames === null) {
          const data = FS_LoadFile(name);
          if (data === null) {
            precache_model_skin = 0;
            precache_check++;
            continue; // couldn't load it
          }
          const names = readMd2SkinNames(data);
          if (names === null) {
            // not an alias model, or a bad/unsupported version
            precache_model_skin = 0;
            precache_check++;
            continue;
          }
          precache_model_skinnames = names;
        }

        while (precache_model_skin - 1 < precache_model_skinnames.length) {
          if (!CL_CheckOrDownloadFile(precache_model_skinnames[precache_model_skin - 1], "skin")) {
            precache_model_skin++;
            return; // started a download
          }
          precache_model_skin++;
        }
        precache_model_skinnames = null;
        precache_model_skin = 0;
        precache_check++;
      }
    }
    precache_check = cls.csr.sounds;
  }
  if (precache_check >= cls.csr.sounds && precache_check < cls.csr.sounds + cls.csr.max_sounds) {
    if (allow_download_sounds && allow_download_sounds.value) {
      if (precache_check === cls.csr.sounds) precache_check++; // zero is blank
      while (precache_check < cls.csr.sounds + cls.csr.max_sounds && cl.configstrings[precache_check][0]) {
        if (cl.configstrings[precache_check][0] === "*") {
          precache_check++;
          continue;
        }
        const fn = `sound/${cl.configstrings[precache_check]}`;
        precache_check++;
        if (!CL_CheckOrDownloadFile(fn, "sound")) return; // started a download
      }
    }
    precache_check = cls.csr.images;
  }
  if (precache_check >= cls.csr.images && precache_check < cls.csr.images + cls.csr.max_images) {
    if (precache_check === cls.csr.images) precache_check++; // zero is blank
    while (precache_check < cls.csr.images + cls.csr.max_images && cl.configstrings[precache_check][0]) {
      const name = cl.configstrings[precache_check];
      precache_check++;

      // q2repro's CL_RequestNextDownload (src/client/download.c, CS_IMAGES
      // phase): a bare CS_IMAGES entry always means "pics/<name>.pcx", but
      // under the rerelease's extended configstring layout an entry can
      // instead be a full path the caller already gave an extension --
      // misc_flare's `image` entity key (kexgame/g_misc.ts's SP_misc_flare)
      // writes straight through to gi.imageindex() and can be e.g.
      // "sprites/flare_01.tga". APPENDING ".pcx" to that (the old
      // unconditional `pics/${name}.pcx` below) built
      // "pics/sprites/flare_01.tga.pcx" -- a name that can never exist
      // locally or on any server, spamming a doomed download every time
      // this phase ran. A leading '/' or '\\' is the existing escape syntax
      // (name used verbatim, no "pics/" prefix, no forced extension); an
      // extended-family subdir+extension name is a sprite/skin the renderer
      // resolves directly (cl_parse.ts's CL_RegisterImage) and is never
      // downloaded through this convention at all -- skipped entirely,
      // exactly like q2repro's own `continue` for that case.
      let fn: string;
      if (name[0] === "/" || name[0] === "\\") {
        fn = name.slice(1);
      } else if (cls.csr.extended && COM_FileExtension(name) !== "" && name.includes("/")) {
        continue;
      } else {
        fn = `pics/${name}.pcx`;
      }
      if (!CL_CheckOrDownloadFile(fn, "single")) return; // started a download
    }
    precache_check = cls.csr.playerskins;
  }
  // skins are special, since a player has three things to download:
  // model, weapon model and skin
  if (precache_check >= cls.csr.playerskins && precache_check < cls.csr.playerskins + MAX_CLIENTS * PLAYER_MULT) {
    if (allow_download_players && allow_download_players.value) {
      while (precache_check < cls.csr.playerskins + MAX_CLIENTS * PLAYER_MULT) {
        const i = Math.floor((precache_check - cls.csr.playerskins) / PLAYER_MULT);
        let n = (precache_check - cls.csr.playerskins) % PLAYER_MULT;

        const csEntry = cl.configstrings[cls.csr.playerskins + i];
        if (!csEntry[0]) {
          precache_check = cls.csr.playerskins + (i + 1) * PLAYER_MULT;
          precache_player_skin_i_done = false;
          precache_player_dogtag_done = false;
          precache_sexed_check = 0;
          continue;
        }

        // parse_dogtag mirrors q2repro download.c:549 -- the rerelease
        // protocol is the only one whose CS_PLAYERSKINS carries a dogtag.
        const { model, skin, dogtag } = parsePlayerSkinConfigstring(csEntry, cls.serverProtocol === PROTOCOL_VERSION_RERELEASE);
        const base = cls.csr.playerskins + i * PLAYER_MULT;

        if (n === 0) {
          // model
          if (!CL_CheckOrDownloadFile(`players/${model}/tris.md2`, "model")) {
            precache_check = base + 1;
            return; // started a download
          }
          n++;
        }
        if (n === 1) {
          // weapon model
          if (!CL_CheckOrDownloadFile(`players/${model}/weapon.md2`, "model")) {
            precache_check = base + 2;
            return; // started a download
          }
          n++;
        }
        if (n === 2) {
          // weapon skin
          if (!CL_CheckOrDownloadFile(`players/${model}/weapon.pcx`, "skin")) {
            precache_check = base + 3;
            return; // started a download
          }
          n++;
        }
        if (n === 3) {
          // skin
          if (!CL_CheckOrDownloadFile(`players/${model}/${skin}.pcx`, "skin")) {
            precache_check = base + 4;
            return; // started a download
          }
          n++;
        }
        // n === 4: skin_i, then (deviation from vanilla -- see file banner)
        // q2repro download.c check_player()'s sexed-sound downloads for
        // this player's model. Recomputing precache_sexed_sounds on every
        // pass through this phase is idempotent (configstrings don't
        // change mid-precache) and keeps this block self-contained rather
        // than needing its own separate "have I scanned yet" state.
        // Vanilla resumes at `CS_PLAYERSKINS + i * PLAYER_MULT + 5` here --
        // PLAYER_MULT is 5, so that is the NEXT PLAYER, and a skin_i the
        // server does not have is therefore never asked for twice. This port
        // interposes q2repro's sexed-sound and dogtag downloads at the same
        // base + 4 resume index, so it cannot use base + 5, and resuming at
        // base + 4 alone re-derived n === 4 and re-queued the identical file
        // on every pass -- an unbreakable precache loop (self-play cell f
        // sat on one `_i.pcx` for the entire session and never spawned).
        // Latches instead, cleared when this player slot is finished.
        if (!precache_player_skin_i_done) {
          precache_player_skin_i_done = true;
          if (!CL_CheckOrDownloadFile(`players/${model}/${skin}_i.pcx`, "skin")) {
            precache_check = base + 4;
            return; // started a download
          }
        }

        // dogtag (q2repro download.c:575-576's `Q_concat(fn, ..., "tags/",
        // dogtag, ".pcx")`), same latching reason as skin_i above.
        if (!precache_player_dogtag_done) {
          precache_player_dogtag_done = true;
          if (!CL_CheckOrDownloadFile(`tags/${dogtag}.pcx`, "skin")) {
            precache_check = base + 4;
            return; // started a download
          }
        }

        precache_sexed_sounds = [];
        for (let s = 1; s < cls.csr.max_sounds; s++) {
          if (cl.configstrings[cls.csr.sounds + s][0] === "*") precache_sexed_sounds.push(s);
        }
        while (precache_sexed_check < precache_sexed_sounds.length) {
          const soundName = cl.configstrings[cls.csr.sounds + precache_sexed_sounds[precache_sexed_check]];
          if (!CL_CheckOrDownloadFile(`players/${model}/${soundName.slice(1)}`, "sound")) {
            precache_check = base + 4;
            return; // started a download
          }
          precache_sexed_check++;
        }
        precache_sexed_check = 0;
        precache_player_skin_i_done = false;
        precache_player_dogtag_done = false;
        precache_check = base + PLAYER_MULT;
      }
    }
    // precache phase completed
    precache_check = ENV_CNT;
  }

  if (precache_check === ENV_CNT) {
    precache_check = ENV_CNT + 1;

    const { checksum: map_checksum } = CM_LoadMap(cl.configstrings[cls.csr.models + 1], true);

    if (map_checksum !== atoi(cl.configstrings[cls.csr.mapchecksum])) {
      Com_Error(ERR_DROP, "Local map version differs from server: %i != '%s'\n", map_checksum, cl.configstrings[cls.csr.mapchecksum]);
      return;
    }
  }

  if (precache_check > ENV_CNT && precache_check < TEXTURE_CNT) {
    if (allow_download && allow_download.value && allow_download_maps && allow_download_maps.value) {
      while (precache_check < TEXTURE_CNT) {
        const n = precache_check - ENV_CNT - 1;
        precache_check++;
        const sky = cl.configstrings[CS_SKY];
        const suf = env_suf[Math.floor(n / 2)];
        const fn = n & 1 ? `env/${sky}${suf}.pcx` : `env/${sky}${suf}.tga`;
        if (!CL_CheckOrDownloadFile(fn, "single")) return; // started a download
      }
    }
    precache_check = TEXTURE_CNT;
  }

  if (precache_check === TEXTURE_CNT) {
    precache_check = TEXTURE_CNT + 1;
    precache_tex = 0;
  }

  // confirm existance of textures, download any that don't exist
  if (precache_check === TEXTURE_CNT + 1) {
    if (allow_download && allow_download.value && allow_download_maps && allow_download_maps.value) {
      const numtexinfo = CM_NumTexinfo();
      while (precache_tex < numtexinfo) {
        const fn = `textures/${CM_TexinfoName(precache_tex)}.wal`;
        precache_tex++;
        if (!CL_CheckOrDownloadFile(fn, "single")) return; // started a download
      }
    }
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
    CM_LoadMap(cl.configstrings[cls.csr.models + 1], true);
    CL_RegisterSounds();
    CL_PrepRefresh();
    return;
  }

  precache_check = cls.csr.models;
  precache_spawncount = atoi(Cmd_Argv(1));
  precache_model_skinnames = null;
  precache_model_skin = 0;
  precache_sexed_check = 0;
  // The local-server download-skip notice is per walk, so the next
  // connection gets its own single line rather than staying silent because
  // an earlier session already printed one.
  precache_local_notice = false;
  // The per-player skin_i/dogtag resume latches must reset with the rest of
  // the walk cursor state: a reconnect (or the next server) starting a fresh
  // precache sequence otherwise inherits latches from the previous session's
  // interrupted walk and silently skips those downloads.
  precache_player_skin_i_done = false;
  precache_player_dogtag_done = false;
  precache_player_skin_i_done = false;
  precache_player_dogtag_done = false;

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
  // cl_seats/cl_splitscreen_layout (src/client/cl_seats.ts) -- registered
  // beside CL_InitInput because seats are an input concept first: a seat is
  // a controller and a viewport, and the cvar has to exist before the New
  // Game screen's seat selector reads it.
  CL_Seats_Init();

  // q2repro src/client/main.c:2724 (CL_InitLocal) calls CL_InitDemos() here
  // (src/client/demo.c:1577-1581); registered inline instead of importing
  // from cl_demo.ts to avoid an import cycle (see that file's header
  // comment). Registered, consumer unported -- see audit report.
  Cvar_Get("cl_demosnaps", "10", 0);
  Cvar_Get("cl_demomsglen", "1390", 0); // MAX_PACKETLEN_WRITABLE_DEFAULT (inc/common/net/net.h:31-34)
  // chan.c:130 -- the SAME global cvar net_chan.ts's Netchan_Init registers
  // (this call is idempotent with that one, whichever runs first wins); the
  // client reads it here to build CL_SendConnectPacket's packet_length
  // request (client/main.c:459).
  Cvar_Get("net_maxmsglen", "1390", 0);
  Cvar_Get("cl_demowait", "0", 0);
  Cvar_Get("cl_demosuspendtoggle", "1", 0);
  Cvar_Get("cl_demo_protocol_kex", "1", 0);

  // q2repro's CL_InitTEnts (src/client/tent.c:1735-1750) and CL_InitEffects
  // (src/client/effects.c:1905-1908) are also called from CL_InitLocal in
  // the C original; neither exists as a function in this port's cl_tent.ts/
  // cl_fx.ts (nothing there currently needs init besides these cvars), so
  // they're registered here instead. cl_shadowlights (effects.c:1908) is
  // already registered above. CL_RailTrail (cl_fx.ts) is this port's
  // existing vanilla particle-spiral rail effect -- q2repro's
  // type/color/width-configurable polygon-beam rail renderer these cvars
  // drive is a different rendering model entirely, not a drop-in parameter
  // substitution, so all but cl_muzzleflashes below are registered,
  // consumer unported. cl_muzzleflashes (tent.c:1735) now has a real
  // consumer -- CL_AddMuzzleFX/CL_AddWeaponMuzzleFX in cl_tent.ts -- so its
  // return value is captured into clCvars like cl_footsteps above.
  clCvars.cl_muzzleflashes = Cvar_Get("cl_muzzleflashes", "1", 0); // tent.c:1735
  Cvar_Get("cl_railtrail_type", "0", 0); // tent.c:1736
  Cvar_Get("cl_railtrail_time", "1.0", 0); // tent.c:1737
  Cvar_Get("cl_railcore_color", "red", 0); // tent.c:1740
  Cvar_Get("cl_railcore_width", "2", 0); // tent.c:1744
  Cvar_Get("cl_railspiral_color", "blue", 0); // tent.c:1745
  Cvar_Get("cl_railspiral_radius", "3", 0); // tent.c:1749
  Cvar_Get("cl_compass_time", "10", 0); // tent.c:1750
  Cvar_Get("cl_lerp_lightstyles", "1", 0); // effects.c:1905
  Cvar_Get("cl_rerelease_effects", "1", 0); // effects.c:1906
  Cvar_Get("cl_muzzlelight_time", "100", 0); // effects.c:1907

  // task #24: HTTP downloads (cl_http.ts). Callbacks wire the HTTP queue
  // back to this file's existing UDP download state machine: a per-file
  // HTTP failure retries over UDP (CL_StartUdpDownload), and every settled
  // HTTP entry re-drives the precache walk exactly like Q2PRO's
  // process_downloads()/abort_downloads() both ending in
  // CL_RequestNextDownload().
  HTTP_Init();
  HTTP_SetCallbacks({
    udpFallback: (path) => CL_StartUdpDownload(path),
    onSettled: () => CL_RequestNextDownload(),
  });

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
  clCvars.cl_shadowlights = Cvar_Get("cl_shadowlights", "1", 0);
  clCvars.cl_gun = Cvar_Get("cl_gun", "1", 0);
  clCvars.cl_footsteps = Cvar_Get("cl_footsteps", "1", 0);
  clCvars.cl_noskins = Cvar_Get("cl_noskins", "0", 0);
  clCvars.cl_autoskins = Cvar_Get("cl_autoskins", "0", 0);
  clCvars.cl_predict = Cvar_Get("cl_predict", "1", 0);
  // q2repro src/client/main.c:2756 defaults cl_maxfps to "62", not "90" --
  // cvar-parity audit fix (was a divergence from this port's engine spec).
  cl_maxfps = Cvar_Get("cl_maxfps", "62", 0);

  clCvars.cl_upspeed = Cvar_Get("cl_upspeed", "200", 0);
  clCvars.cl_forwardspeed = Cvar_Get("cl_forwardspeed", "200", 0);
  clCvars.cl_sidespeed = Cvar_Get("cl_sidespeed", "200", 0);
  clCvars.cl_yawspeed = Cvar_Get("cl_yawspeed", "140", 0);
  // q2repro src/client/input.c:771 flags cl_pitchspeed CVAR_CHEAT.
  clCvars.cl_pitchspeed = Cvar_Get("cl_pitchspeed", "150", CVAR_CHEAT);
  // q2repro src/client/input.c:772 flags cl_anglespeedkey CVAR_CHEAT.
  clCvars.cl_anglespeedkey = Cvar_Get("cl_anglespeedkey", "1.5", CVAR_CHEAT);

  // q2repro src/client/input.c:773 defaults cl_run to "1" (cvar-parity fix).
  clCvars.cl_run = Cvar_Get("cl_run", "1", CVAR_ARCHIVE);
  // q2repro src/client/input.c:775 defaults freelook to "1" (cvar-parity
  // fix; src/platform/sdl.ts also registers this name and is fixed to match).
  clCvars.freelook = Cvar_Get("freelook", "1", CVAR_ARCHIVE);
  clCvars.lookspring = Cvar_Get("lookspring", "0", CVAR_ARCHIVE);
  clCvars.lookstrafe = Cvar_Get("lookstrafe", "0", CVAR_ARCHIVE);
  clCvars.sensitivity = Cvar_Get("sensitivity", "3", CVAR_ARCHIVE);

  clCvars.m_pitch = Cvar_Get("m_pitch", "0.022", CVAR_ARCHIVE);
  clCvars.m_yaw = Cvar_Get("m_yaw", "0.022", 0);
  clCvars.m_forward = Cvar_Get("m_forward", "1", 0);
  clCvars.m_side = Cvar_Get("m_side", "1", 0);

  clCvars.cl_protocol = Cvar_Get("cl_protocol", `${PROTOCOL_VERSION}`, 0);
  clCvars.cl_shownet = Cvar_Get("cl_shownet", "0", 0);
  clCvars.cl_showmiss = Cvar_Get("cl_showmiss", "0", 0);
  clCvars.cl_showclamp = Cvar_Get("showclamp", "0", 0);
  cl_timeout = Cvar_Get("cl_timeout", "120", 0);
  clCvars.cl_paused = Cvar_Get("paused", "0", 0);
  // q2repro src/common/common.c:933 flags timedemo CVAR_CHEAT (cvar-parity fix).
  clCvars.cl_timedemo = Cvar_Get("timedemo", "0", CVAR_CHEAT);

  // q2repro src/common/common.c:956 and src/client/main.c:2784 flag both
  // rcon_password and rcon_address CVAR_PRIVATE (cvar-parity fix).
  rcon_client_password = Cvar_Get("rcon_password", "", CVAR_PRIVATE);
  rcon_address = Cvar_Get("rcon_address", "", CVAR_PRIVATE);

  clCvars.cl_lightlevel = Cvar_Get("r_lightlevel", "0", 0);

  //
  // userinfo
  //
  info_password = Cvar_Get("password", "", CVAR_USERINFO);
  info_spectator = Cvar_Get("spectator", "0", CVAR_USERINFO);
  name = Cvar_Get("name", "unnamed", CVAR_USERINFO | CVAR_ARCHIVE);
  skin = Cvar_Get("skin", "male/grunt", CVAR_USERINFO | CVAR_ARCHIVE);
  // q2repro src/client/main.c:2839 defaults rate to "15000" (cvar-parity
  // fix -- resolves the FIXME this line used to carry).
  rate = Cvar_Get("rate", "15000", CVAR_USERINFO | CVAR_ARCHIVE);
  msg = Cvar_Get("msg", "1", CVAR_USERINFO | CVAR_ARCHIVE);
  hand = Cvar_Get("hand", "0", CVAR_USERINFO | CVAR_ARCHIVE);
  fov = Cvar_Get("fov", "90", CVAR_USERINFO | CVAR_ARCHIVE);
  gender = Cvar_Get("gender", "male", CVAR_USERINFO | CVAR_ARCHIVE);
  gender_auto = Cvar_Get("gender_auto", "1", CVAR_ARCHIVE);
  if (gender) gender.modified = false; // clear this so we know when user sets it manually
  // q2repro src/client/main.c:2837/2846 -- dogtag/uf join the same generic
  // userinfo scan as name/skin/rate/etc above (cvar-parity audit addition).
  Cvar_Get("dogtag", "default", CVAR_USERINFO | CVAR_ARCHIVE);
  Cvar_Get("uf", "", CVAR_USERINFO);
  // name/info_password/info_spectator/rate/msg/hand/fov/adr0-8/dogtag/uf are,
  // exactly as in the C original, registered here and never read directly
  // again -- their values reach the network purely through Cvar_Userinfo()/
  // the console, which scan the whole CVAR_USERINFO-flagged cvar set
  // generically.

  clCvars.cl_vwep = Cvar_Get("cl_vwep", "1", CVAR_ARCHIVE);

  // --- cvar-parity audit: client/main.c cvars with no consumer ported yet ---
  // Each is registered so the console no longer reports "unknown command";
  // see the audit report for the "registered, consumer unported" list this
  // batch feeds. Gun-offset/thirdperson/gib/flare-style visual features
  // below have no existing implementation anywhere in src/client/*.ts (this
  // port's renderer path is still vanilla q2 shaped) -- confirmed by
  // grepping for their C consumer's behavior, not just the cvar name.
  Cvar_Get("cl_gunalpha", "1", 0); // src/client/main.c:2743
  Cvar_Get("cl_gunfov", "90", 0); // src/client/main.c:2744, consumer src/client/tent.c
  Cvar_Get("cl_gun_x", "0", 0); // src/client/main.c:2745, consumer src/client/entities.c
  Cvar_Get("cl_gun_y", "0", 0); // src/client/main.c:2746, consumer src/client/entities.c
  Cvar_Get("cl_gun_z", "0", 0); // src/client/main.c:2747, consumer src/client/entities.c
  Cvar_Get("cl_kickangles", "1", CVAR_CHEAT); // src/client/main.c:2754, consumer src/client/entities.c
  Cvar_Get("cl_warn_on_fps_rounding", "1", 0); // src/client/main.c:2755
  Cvar_Get("cl_async", "1", 0); // src/client/main.c:2758 -- q2repro's async input/render decoupling (cl_sync_changed) is not ported; this port's CL_Frame always ties both to cl_maxfps
  Cvar_Get("r_maxfps", "0", 0); // src/client/main.c:2760 -- same async-render-cap feature as cl_async, not ported
  Cvar_Get("cl_autopause", "1", 0); // src/client/main.c:2762
  Cvar_Get("cl_rollhack", "1", 0); // src/client/main.c:2763, consumer src/client/entities.c
  Cvar_Get("cl_noglow", "0", 0); // src/client/main.c:2764, consumer src/client/entities.c
  Cvar_Get("cl_nobob", "0", 0); // src/client/main.c:2765, consumer src/client/entities.c
  Cvar_Get("cl_nolerp", "0", 0); // src/client/main.c:2766, consumer src/client/entities.c
  Cvar_Get("cl_hit_markers", "2", 0); // src/client/main.c:2767
  Cvar_Get("cl_thirdperson", "0", CVAR_CHEAT); // src/client/main.c:2787, consumer src/client/entities.c (no chase-cam view in this port)
  Cvar_Get("cl_thirdperson_angle", "0", 0); // src/client/main.c:2788
  Cvar_Get("cl_thirdperson_range", "60", 0); // src/client/main.c:2789
  Cvar_Get("cl_disable_particles", "0", 0); // src/client/main.c:2791, consumer src/client/tent.c + entities.c
  Cvar_Get("cl_disable_explosions", "0", 0); // src/client/main.c:2792, consumer src/client/tent.c
  Cvar_Get("cl_dlight_hacks", "0", 0); // src/client/main.c:2793, consumer src/client/tent.c + entities.c + effects.c
  Cvar_Get("cl_smooth_explosions", "1", 0); // src/client/main.c:2794, consumer src/client/tent.c + entities.c
  Cvar_Get("cl_gibs", "1", 0); // src/client/main.c:2796, consumer src/client/entities.c
  Cvar_Get("cl_flares", "1", 0); // src/client/main.c:2799, consumer src/client/entities.c
  Cvar_Get("cl_updaterate", "0", 0); // src/client/main.c:2803
  Cvar_Get("cl_cgame_notify", "1", 0); // src/client/main.c:2807, consumer src/client/parse.c (cl_parse.ts is off-limits this pass)
  Cvar_Get("cl_chat_notify", "1", 0); // src/client/main.c:2808, consumer src/client/parse.c (cl_parse.ts is off-limits this pass)
  Cvar_Get("cl_chat_sound", "1", 0); // src/client/main.c:2809, consumer src/client/parse.c (cl_parse.ts is off-limits this pass)
  Cvar_Get("cl_chat_filter", "0", 0); // src/client/main.c:2812, consumer src/client/parse.c (cl_parse.ts is off-limits this pass)
  // cl_disconnectcmd/cl_changemapcmd are wired below (CL_Disconnect/
  // CL_Changing_f); cl_beginmapcmd's consumer is src/client/entities.c, wired
  // in cl_ents.ts instead (see that file).
  cl_disconnectcmd = Cvar_Get("cl_disconnectcmd", "", 0); // src/client/main.c:2814, wired below in CL_Disconnect
  cl_changemapcmd = Cvar_Get("cl_changemapcmd", "", 0); // src/client/main.c:2815, wired below in CL_Changing_f
  Cvar_Get("cl_beginmapcmd", "", 0); // src/client/main.c:2816, wired in src/client/cl_ents.ts
  // cl_ignore_stufftext's filter (allow_stufftext()) lives in q2repro's
  // src/client/main.c but is called from the svc_stufftext handler in
  // src/client/parse.c -- cl_parse.ts is off-limits this pass, so only the
  // registration lands here; wiring the filter into cl_parse.ts's
  // svc_stufftext case is a PLACE AFTER MERGE follow-up (see audit report).
  Cvar_Get("cl_ignore_stufftext", "0", 0); // src/client/main.c:2818
  // cl_allow_vid_restart's consumer in q2repro (CL_RestartRefresh_f, src/
  // client/main.c:2504-2523) warns and ignores manual `vid_restart` unless
  // this is set, because q2repro auto-applies most video-setting changes
  // without a restart. This port's VID_Restart_f (src/platform/vid.ts) does
  // NOT auto-apply settings the same way, so copying that guard verbatim
  // would break the existing manual vid_restart workflow -- judgment call:
  // registered only, consumer intentionally left unported (see audit report).
  Cvar_Get("cl_allow_vid_restart", "0", 0); // src/client/main.c:2819

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
  if (cl.configstrings[cls.csr.maxclients] === "1" || !cl.configstrings[cls.csr.maxclients].length) return; // single player can cheat

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

  // LOCAL SPLITSCREEN (src/client/cl_seats.ts): bring the seat table in line
  // with cl_seats/the connection state, then run each extra seat's move.
  // After CL_SendCmd, not before: seat 0's move is the one that goes over
  // the wire and sets this frame's tempo, and a seat added here must not
  // change the player slot the primary connection already holds.
  CL_Seats_Reconcile();
  CL_Seats_SendCmds();
  // ...then read back what the server said TO each seat since the last frame
  // (its centerprints, its private sounds), which nothing transmits because a
  // seat has no netchan -- see CL_Seats_DrainServerMessages.
  CL_Seats_DrainServerMessages();

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

  // task #24: pump the HTTP download queue (see cl_http.ts's HTTP_RunDownloads doc comment)
  HTTP_RunDownloads();

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
  Haptics_Frame(cls.realtime); // advance the rumble pattern scheduler

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
