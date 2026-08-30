// sv_user.c -- server code for moving users
//
// sv_client and sv_player will be valid inside every function below (set by
// SV_ExecuteClientMessage/SV_ExecuteUserCommand before dispatch), matching
// the C file's own header comment; ported here as server.ts's
// svClientHolder/svPlayerHolder mutable holders (see that module's header
// comment for the rationale) instead of bare reassignable globals.

import { Com_sprintf } from "../shared/q_shared";
import { UsercmdT, MAX_INFO_STRING, MAX_EDICTS, EntityStateT, CS_NAME } from "../shared/q_shared";
import { SysError, ClcOpsT, SvcOpsT, PROTOCOL_VERSION, MAX_MSGLEN, ERR_DROP, UPDATE_MASK } from "../qcommon/qcommon";
import { Com_Printf, Com_DPrintf, Com_Error, COM_BlockSequenceCRCByte, Info_Print } from "../qcommon/common";
import { Cmd_TokenizeString, Cmd_Argv, Cmd_Argc, Cbuf_AddText, Cbuf_InsertFromDefer } from "../qcommon/cmd";
import { Cvar_VariableString, Cvar_Set, Cvar_VariableValue, Cvar_Serverinfo } from "../qcommon/cvar";
import { FS_FOpenFile, FS_FreeFile, FS_LoadFile, file_from_pak } from "../qcommon/files";
import { MSG_WriteByte, MSG_WriteLong, MSG_WriteShort, MSG_WriteString, MSG_ReadByte, MSG_ReadLong, MSG_ReadString, MSG_ReadDeltaUsercmd, MSG_WriteDeltaEntity, SZ_Write } from "../qcommon/sizebuf";
import type { GameExports } from "../game/game";
import {
  sv,
  svs,
  ServerStateT,
  ClientT,
  ClientStateT,
  LATENCY_COUNTS,
  svClientHolder,
  svPlayerHolder,
  net_message,
  sv_paused,
  sv_enforcetime,
} from "./server";
import { geHolder } from "./sv_game";
import { SV_DropClient, SV_UserinfoChanged, allow_download, allow_download_players, allow_download_models, allow_download_sounds, allow_download_maps } from "./sv_main";

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_user: ge used before SV_InitGameProgs");
  return ge;
}

function requireSvClient(): ClientT {
  const cl = svClientHolder.sv_client;
  if (!cl) throw new SysError("sv_user: sv_client used before being set");
  return cl;
}

/*
============================================================

USER STRINGCMD EXECUTION

sv_client and sv_player will be valid.
============================================================
*/

/*
==================
SV_BeginDemoServer
==================
*/
export function SV_BeginDemoserver(): void {
  const name = Com_sprintf("demos/%s", sv.name);
  const open = FS_FOpenFile(name);
  if (!open) Com_Error(ERR_DROP, "Couldn't open %s\n", name);
  sv.demofile = open.handle;
}

/*
================
SV_New_f

Sends the first message from the server to a connected client.
This will be sent on the initial connection and upon each server load.
================
*/
export function SV_New_f(): void {
  const cl = requireSvClient();
  Com_DPrintf("New() from %s\n", cl.name);

  if (cl.state !== ClientStateT.cs_connected) {
    Com_Printf("New not valid -- already spawned\n");
    return;
  }

  // demo servers just dump the file message
  if (sv.state === ServerStateT.ss_demo) {
    SV_BeginDemoserver();
    return;
  }

  //
  // serverdata needs to go over for all types of servers
  // to make sure the protocol is right, and to set the gamedir
  //
  const gamedir = Cvar_VariableString("gamedir");

  // send the serverdata
  MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_serverdata);
  MSG_WriteLong(cl.netchan.message, PROTOCOL_VERSION);
  MSG_WriteLong(cl.netchan.message, svs.spawncount);
  MSG_WriteByte(cl.netchan.message, sv.attractloop ? 1 : 0);
  MSG_WriteString(cl.netchan.message, gamedir);

  let playernum: number;
  if (sv.state === ServerStateT.ss_cinematic || sv.state === ServerStateT.ss_pic) playernum = -1;
  else playernum = svs.clients.indexOf(cl); // sv_client - svs.clients
  MSG_WriteShort(cl.netchan.message, playernum);

  // send full levelname
  MSG_WriteString(cl.netchan.message, sv.configstrings[CS_NAME]);

  //
  // game server
  //
  if (sv.state === ServerStateT.ss_game) {
    // set up the entity for the client
    const ge = requireGe();
    const ent = ge.edicts[playernum + 1];
    ent.s.number = playernum + 1;
    cl.edict = ent;
    cl.lastcmd = new UsercmdT();

    // begin fetching configstrings
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(cl.netchan.message, Com_sprintf("cmd configstrings %i 0\n", svs.spawncount));
  }
}

/*
==================
SV_Configstrings_f
==================
*/
export function SV_Configstrings_f(): void {
  const cl = requireSvClient();
  Com_DPrintf("Configstrings() from %s\n", cl.name);

  if (cl.state !== ClientStateT.cs_connected) {
    Com_Printf("configstrings not valid -- already spawned\n");
    return;
  }

  // handle the case of a level changing while a client was connecting
  if (atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Com_Printf("SV_Configstrings_f from different level\n");
    SV_New_f();
    return;
  }

  let start = atoi(Cmd_Argv(2));

  // write a packet full of data
  while (cl.netchan.message.cursize < MAX_MSGLEN / 2 && start < svs.csr.end) {
    if (sv.configstrings[start].length) {
      MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_configstring);
      MSG_WriteShort(cl.netchan.message, start);
      MSG_WriteString(cl.netchan.message, sv.configstrings[start]);
    }
    start++;
  }

  // send next command
  if (start === svs.csr.end) {
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(cl.netchan.message, Com_sprintf("cmd baselines %i 0\n", svs.spawncount));
  } else {
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(cl.netchan.message, Com_sprintf("cmd configstrings %i %i\n", svs.spawncount, start));
  }
}

/*
==================
SV_Baselines_f
==================
*/
export function SV_Baselines_f(): void {
  const cl = requireSvClient();
  Com_DPrintf("Baselines() from %s\n", cl.name);

  if (cl.state !== ClientStateT.cs_connected) {
    Com_Printf("baselines not valid -- already spawned\n");
    return;
  }

  // handle the case of a level changing while a client was connecting
  if (atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Com_Printf("SV_Baselines_f from different level\n");
    SV_New_f();
    return;
  }

  let start = atoi(Cmd_Argv(2));

  const nullstate = new EntityStateT();

  // write a packet full of data
  while (cl.netchan.message.cursize < MAX_MSGLEN / 2 && start < MAX_EDICTS) {
    const base = sv.baselines[start];
    if (base.modelindex || base.sound || base.effects) {
      MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_spawnbaseline);
      MSG_WriteDeltaEntity(nullstate, base, cl.netchan.message, true, true);
    }
    start++;
  }

  // send next command
  if (start === MAX_EDICTS) {
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(cl.netchan.message, Com_sprintf("precache %i\n", svs.spawncount));
  } else {
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(cl.netchan.message, Com_sprintf("cmd baselines %i %i\n", svs.spawncount, start));
  }
}

/*
==================
SV_Begin_f
==================
*/
export function SV_Begin_f(): void {
  const cl = requireSvClient();
  Com_DPrintf("Begin() from %s\n", cl.name);

  // handle the case of a level changing while a client was connecting
  if (atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Com_Printf("SV_Begin_f from different level\n");
    SV_New_f();
    return;
  }

  cl.state = ClientStateT.cs_spawned;

  // call the game begin function
  const player = svPlayerHolder.sv_player;
  if (!player) throw new SysError("SV_Begin_f: sv_player is null");
  requireGe().ClientBegin(player);

  Cbuf_InsertFromDefer();
}

//=============================================================================

/*
==================
SV_NextDownload_f
==================
*/
export function SV_NextDownload_f(): void {
  const cl = requireSvClient();
  if (!cl.download) return;

  let r = cl.downloadsize - cl.downloadcount;
  if (r > 1024) r = 1024;

  MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_download);
  MSG_WriteShort(cl.netchan.message, r);

  cl.downloadcount += r;
  let size = cl.downloadsize;
  if (!size) size = 1;
  const percent = ((cl.downloadcount * 100) / size) | 0;
  MSG_WriteByte(cl.netchan.message, percent);
  SZ_Write(cl.netchan.message, cl.download.subarray(cl.downloadcount - r, cl.downloadcount), r);

  if (cl.downloadcount !== cl.downloadsize) return;

  FS_FreeFile(cl.download);
  cl.download = null;
}

// strncmp(a, b, n) === 0, byte-faithful including the NUL-terminator
// short-circuit: a real character compared against a NUL past a shorter
// string's end differs (never "equal"), matching C's strncmp exactly. This
// matters below: SV_BeginDownload_f's original literal `strncmp(name,
// "players/", 6)` etc. use an n shorter than several of the actual prefixes
// (a well-known upstream id Software bug), which is preserved bug-for-bug
// per PORTING.md rather than "fixed" into a `startsWith` check.
function strncmpEq(a: string, b: string, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    if (ca !== cb) return false;
    if (ca === 0) return true;
  }
  return true;
}

/*
==================
SV_BeginDownload_f
==================
*/
export function SV_BeginDownload_f(): void {
  const cl = requireSvClient();
  const name = Cmd_Argv(1);

  let offset = 0;
  if (Cmd_Argc() > 2) offset = atoi(Cmd_Argv(2)); // downloaded offset

  const allowDownloadOk = allow_download ? allow_download.value !== 0 : false;
  const allowPlayers = allow_download_players ? allow_download_players.value !== 0 : false;
  const allowModels = allow_download_models ? allow_download_models.value !== 0 : false;
  const allowSounds = allow_download_sounds ? allow_download_sounds.value !== 0 : false;
  const allowMaps = allow_download_maps ? allow_download_maps.value !== 0 : false;

  // hacked by zoid to allow more conrol over download
  // first off, no .. or global allow check
  if (
    name.includes("..") ||
    !allowDownloadOk ||
    // leading dot is no good
    name.charAt(0) === "." ||
    // leading slash bad as well, must be in subdir
    name.charAt(0) === "/" ||
    // next up, skin check
    (strncmpEq(name, "players/", 6) && !allowPlayers) ||
    // now models
    (strncmpEq(name, "models/", 6) && !allowModels) ||
    // now sounds
    (strncmpEq(name, "sound/", 6) && !allowSounds) ||
    // now maps (note special case for maps, must not be in pak)
    (strncmpEq(name, "maps/", 6) && !allowMaps) ||
    // MUST be in a subdirectory
    !name.includes("/")
  ) {
    // don't allow anything with .. path
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_download);
    MSG_WriteShort(cl.netchan.message, -1);
    MSG_WriteByte(cl.netchan.message, 0);
    return;
  }

  if (cl.download) FS_FreeFile(cl.download);

  const loaded = FS_LoadFile(name);
  cl.download = loaded;
  cl.downloadsize = loaded ? loaded.length : -1;
  cl.downloadcount = offset;

  if (offset > cl.downloadsize) cl.downloadcount = cl.downloadsize;

  if (
    !cl.download ||
    // special check for maps, if it came from a pak file, don't allow
    // download  ZOID
    (name.startsWith("maps/") && file_from_pak)
  ) {
    Com_DPrintf("Couldn't download %s to %s\n", name, cl.name);
    if (cl.download) {
      FS_FreeFile(cl.download);
      cl.download = null;
    }

    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_download);
    MSG_WriteShort(cl.netchan.message, -1);
    MSG_WriteByte(cl.netchan.message, 0);
    return;
  }

  SV_NextDownload_f();
  Com_DPrintf("Downloading %s to %s\n", name, cl.name);
}

//============================================================================

/*
=================
SV_Disconnect_f

The client is going to disconnect, so remove the connection immediately
=================
*/
export function SV_Disconnect_f(): void {
  SV_DropClient(requireSvClient());
}

/*
==================
SV_ShowServerinfo_f

Dumps the serverinfo info string
==================
*/
export function SV_ShowServerinfo_f(): void {
  Info_Print(Cvar_Serverinfo());
}

export function SV_Nextserver(): void {
  //ZOID, ss_pic can be nextserver'd in coop mode
  if (sv.state === ServerStateT.ss_game || (sv.state === ServerStateT.ss_pic && !Cvar_VariableValue("coop"))) {
    return; // can't nextserver while playing a normal game
  }

  svs.spawncount++; // make sure another doesn't sneak in
  const v = Cvar_VariableString("nextserver");
  if (!v.length) Cbuf_AddText("killserver\n");
  else {
    Cbuf_AddText(v);
    Cbuf_AddText("\n");
  }
  Cvar_Set("nextserver", "");
}

/*
==================
SV_Nextserver_f

A cinematic has completed or been aborted by a client, so move
to the next server,
==================
*/
export function SV_Nextserver_f(): void {
  const cl = requireSvClient();
  if (atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Com_DPrintf("Nextserver() from wrong level, from %s\n", cl.name);
    return; // leftover from last server
  }

  Com_DPrintf("Nextserver() from %s\n", cl.name);

  SV_Nextserver();
}

interface UcmdT {
  name: string;
  func: () => void;
}

const ucmds: UcmdT[] = [
  // auto issued
  { name: "new", func: SV_New_f },
  { name: "configstrings", func: SV_Configstrings_f },
  { name: "baselines", func: SV_Baselines_f },
  { name: "begin", func: SV_Begin_f },

  { name: "nextserver", func: SV_Nextserver_f },

  { name: "disconnect", func: SV_Disconnect_f },

  // issued by hand at client consoles
  { name: "info", func: SV_ShowServerinfo_f },

  { name: "download", func: SV_BeginDownload_f },
  { name: "nextdl", func: SV_NextDownload_f },
];

/*
==================
SV_ExecuteUserCommand
==================
*/
export function SV_ExecuteUserCommand(s: string): void {
  Cmd_TokenizeString(s, true);
  const cl = requireSvClient();
  svPlayerHolder.sv_player = cl.edict;

  let matched = false;
  for (const u of ucmds) {
    if (Cmd_Argv(0) === u.name) {
      u.func();
      matched = true;
      break;
    }
  }

  if (!matched && sv.state === ServerStateT.ss_game) {
    const player = svPlayerHolder.sv_player;
    if (!player) throw new SysError("SV_ExecuteUserCommand: sv_player is null");
    requireGe().ClientCommand(player);
  }
}

/*
===========================================================================

USER CMD EXECUTION

===========================================================================
*/

export function SV_ClientThink(cl: ClientT, cmd: UsercmdT): void {
  cl.commandMsec -= cmd.msec;

  if (cl.commandMsec < 0 && sv_enforcetime && sv_enforcetime.value) {
    Com_DPrintf("commandMsec underflow from %s\n", cl.name);
    return;
  }

  if (!cl.edict) throw new SysError("SV_ClientThink: cl.edict is null");
  requireGe().ClientThink(cl.edict, cmd);
}

const MAX_STRINGCMDS = 8;

/*
===================
SV_ExecuteClientMessage

The current net_message is parsed for the given client
===================
*/
export function SV_ExecuteClientMessage(cl: ClientT): void {
  svClientHolder.sv_client = cl;
  svPlayerHolder.sv_player = cl.edict;

  // only allow one move command
  let moveIssued = false;
  let stringCmdCount = 0;

  for (;;) {
    if (net_message.readcount > net_message.cursize) {
      Com_Printf("SV_ReadClientMessage: badread\n");
      SV_DropClient(cl);
      return;
    }

    const c = MSG_ReadByte(net_message);
    if (c === -1) break;

    switch (c) {
      case ClcOpsT.clc_nop:
        break;

      case ClcOpsT.clc_userinfo: {
        let info = MSG_ReadString(net_message);
        if (info.length > MAX_INFO_STRING - 1) info = info.slice(0, MAX_INFO_STRING - 1);
        cl.userinfo = info;
        SV_UserinfoChanged(cl);
        break;
      }

      case ClcOpsT.clc_move: {
        if (moveIssued) return; // someone is trying to cheat...
        moveIssued = true;

        const checksumIndex = net_message.readcount;
        const checksum = MSG_ReadByte(net_message);
        const lastframe = MSG_ReadLong(net_message);
        if (lastframe !== cl.lastframe) {
          cl.lastframe = lastframe;
          if (cl.lastframe > 0) {
            cl.frame_latency[cl.lastframe & (LATENCY_COUNTS - 1)] = svs.realtime - cl.frames[cl.lastframe & UPDATE_MASK].senttime;
          }
        }

        const nullcmd = new UsercmdT();
        const oldest = new UsercmdT();
        const oldcmd = new UsercmdT();
        const newcmd = new UsercmdT();
        MSG_ReadDeltaUsercmd(net_message, nullcmd, oldest);
        MSG_ReadDeltaUsercmd(net_message, oldest, oldcmd);
        MSG_ReadDeltaUsercmd(net_message, oldcmd, newcmd);

        if (cl.state !== ClientStateT.cs_spawned) {
          cl.lastframe = -1;
          break;
        }

        // if the checksum fails, ignore the rest of the packet
        const calculatedChecksum = COM_BlockSequenceCRCByte(
          net_message.data.subarray(checksumIndex + 1),
          net_message.readcount - checksumIndex - 1,
          cl.netchan.incoming_sequence,
        );

        if (calculatedChecksum !== checksum) {
          Com_DPrintf("Failed command checksum for %s (%d != %d)/%d\n", cl.name, calculatedChecksum, checksum, cl.netchan.incoming_sequence);
          return;
        }

        const paused = sv_paused ? sv_paused.value !== 0 : false;
        if (!paused) {
          let net_drop = cl.netchan.dropped;
          if (net_drop < 20) {
            while (net_drop > 2) {
              SV_ClientThink(cl, cl.lastcmd);
              net_drop--;
            }
            if (net_drop > 1) SV_ClientThink(cl, oldest);
            if (net_drop > 0) SV_ClientThink(cl, oldcmd);
          }
          SV_ClientThink(cl, newcmd);
        }

        cl.lastcmd = newcmd;
        break;
      }

      case ClcOpsT.clc_stringcmd: {
        const cmdStr = MSG_ReadString(net_message);

        // malicious users may try using too many string commands
        stringCmdCount++;
        if (stringCmdCount < MAX_STRINGCMDS) SV_ExecuteUserCommand(cmdStr);

        if (cl.state === ClientStateT.cs_zombie) return; // disconnect command
        break;
      }

      default:
        Com_Printf("SV_ReadClientMessage: unknown command char\n");
        SV_DropClient(cl);
        return;
    }
  }
}
