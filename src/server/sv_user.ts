// sv_user.c -- server code for moving users
//
// sv_client and sv_player will be valid inside every function below (set by
// SV_ExecuteClientMessage/SV_ExecuteUserCommand before dispatch), matching
// the C file's own header comment; ported here as server.ts's
// svClientHolder/svPlayerHolder mutable holders (see that module's header
// comment for the rationale) instead of bare reassignable globals.

import { Com_sprintf } from "../shared/q_shared";
import { UsercmdT, MAX_INFO_STRING, MAX_EDICTS, CS_NAME, Info_SetValueForKey } from "../shared/q_shared";
import { ClcBatchMoveError } from "../qcommon/protocol/clc_batch_move";
import { SysError, ClcOpsT, SvcOpsT, MAX_MSGLEN, ERR_DROP, UPDATE_MASK } from "../qcommon/qcommon";
import { Com_Printf, Com_DPrintf, Com_Error, COM_BlockSequenceCRCByte, Info_Print } from "../qcommon/common";
import { Cmd_TokenizeString, Cmd_Argv, Cmd_Argc, Cbuf_AddText, Cbuf_InsertFromDefer } from "../qcommon/cmd";
import { Cvar_VariableString, Cvar_Set, Cvar_VariableValue, Cvar_Serverinfo } from "../qcommon/cvar";
import { FS_FOpenFile, FS_FreeFile, FS_LoadFile, file_from_pak } from "../qcommon/files";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteString, MSG_ReadByte, MSG_ReadLong, MSG_ReadString, SZ_Write } from "../qcommon/sizebuf";
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

  let playernum: number;
  if (sv.state === ServerStateT.ss_cinematic || sv.state === ServerStateT.ss_pic) playernum = -1;
  else playernum = svs.clients.indexOf(cl); // sv_client - svs.clients

  // send the serverdata (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md:
  // routed through cl.codec so the 1038/R1Q2/Q2PRO codecs' handshake shapes
  // can differ -- see codec.ts's writeServerData doc comment). cl.codec, not
  // svs.codec: v1.0.0 wire cluster (task board #23) negotiates protocol
  // 34/35/36 per client for the legacy family -- see server.ts's
  // ClientT.codec doc comment.
  //
  // r1q2StrafejumpHack/q2proStrafejumpHack/q2proQwMode/q2proWaterjumpHack are
  // always advertised disabled: this port implements none of the
  // corresponding pmove behavior changes, and FIDELITY RAZOR (.orch/
  // preferences.md rule 17) means observable behavior must match what a real
  // client is told, not just what the wire field COULD say -- advertising
  // "on" here would make a real R1Q2/Q2PRO client apply client-side movement
  // prediction this server's game/pmove code never performs, causing
  // mispredicts. cl.protocolMinorVersion is set by sv_main.ts's
  // SVC_DirectConnect once it parses the connect string's protocol-specific
  // tail tokens.
  cl.codec.writeServerData(cl.netchan.message, {
    servercount: svs.spawncount,
    attractloop: sv.attractloop,
    gamedir,
    clientnum: playernum,
    levelname: sv.configstrings[CS_NAME],
    serverState: sv.state,
    r1q2Version: cl.protocolMinorVersion,
    r1q2StrafejumpHack: false,
    q2proVersion: cl.protocolMinorVersion,
    q2proStrafejumpHack: false,
    q2proQwMode: false,
    q2proWaterjumpHack: false,
  });

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

  // write a packet full of data
  while (cl.netchan.message.cursize < MAX_MSGLEN / 2 && start < MAX_EDICTS) {
    const base = sv.baselines[start];
    if (base.modelindex || base.sound || base.effects) {
      cl.codec.writeSpawnBaseline(cl.netchan.message, base);
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

    // Q2PRO stuffs some extra info (num_dups for clc_q2pro_move_batched/
    // move_nodelta) into the raw command byte's upper 3 bits
    // (q2proto_proto_q2pro.c:2317-2320's "Q2PRO stuffs some extra info into
    // upper 3 command bits" -- see codec.ts's readBatchMove doc comment).
    // Masking unconditionally is safe for every OTHER opcode this port
    // implements (clc_bad/nop/move/userinfo/stringcmd are all < 32, and
    // q2repro's own clc_q2pro_* values never set these bits either -- only a
    // real Q2PRO client's batched-move opcode byte ever has them nonzero), so
    // there is no need to gate this on which protocol/codec is active.
    const rawCmd = MSG_ReadByte(net_message);
    if (rawCmd === -1) break;
    const opcodeExtra = rawCmd >> 5;
    const c = rawCmd & 0x1f;

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
        // SV_OldClientExecuteMove (qsrc/q2repro/src/server/user.c:1072-1077)
        // drops the offender instead of silently ignoring the second move:
        // `SV_DropClient(sv_client, "multiple clc_move commands in packet")`.
        // Brought in line with the reference here (RULE-17: the reference
        // engine's observable behavior wins over id's original bare `return`).
        // This port's SV_DropClient takes no reason string, so the reason is
        // printed alongside it the way this file's other drop paths do.
        if (moveIssued) {
          Com_Printf("%s: multiple clc_move commands in packet\n", cl.name);
          SV_DropClient(cl);
          return; // someone is trying to cheat...
        }
        moveIssued = true;

        // id's leading sequence-checksum byte exists on the wire only for
        // vanilla/34 -- see codec.ts's clcMoveHasChecksum doc comment for the
        // three q2proto read paths and the live protocol-35 capture that
        // caught this. checksumIndex is only meaningful when the byte is
        // actually present.
        const hasChecksum = cl.codec.clcMoveHasChecksum === true;
        const checksumIndex = net_message.readcount;
        const checksum = hasChecksum ? MSG_ReadByte(net_message) : 0;
        const lastframe = MSG_ReadLong(net_message);

        const nullcmd = new UsercmdT();
        const oldest = new UsercmdT();
        const oldcmd = new UsercmdT();
        const newcmd = new UsercmdT();
        cl.codec.readDeltaUsercmd(net_message, nullcmd, oldest);
        cl.codec.readDeltaUsercmd(net_message, oldest, oldcmd);
        cl.codec.readDeltaUsercmd(net_message, oldcmd, newcmd);

        // SV_OldClientExecuteMove checks the spawned state FIRST and forces
        // lastframe to -1 without ever touching the real one (user.c:
        // 1082-1087, then SV_SetLastFrame(move->lastframe) at 1087 only on
        // the spawned path). id's original updated cl->lastframe/frame_latency
        // before this check; brought in line with the reference here, so the
        // ordering now matches the sibling batched-move case below.
        if (cl.state !== ClientStateT.cs_spawned) {
          cl.lastframe = -1;
          break;
        }

        if (lastframe !== cl.lastframe) {
          cl.lastframe = lastframe;
          if (cl.lastframe > 0) {
            cl.frame_latency[cl.lastframe & (LATENCY_COUNTS - 1)] = svs.realtime - cl.frames[cl.lastframe & UPDATE_MASK].senttime;
          }
        }

        // if the checksum fails, ignore the rest of the packet
        if (hasChecksum) {
          const calculatedChecksum = COM_BlockSequenceCRCByte(
            net_message.data.subarray(checksumIndex + 1),
            net_message.readcount - checksumIndex - 1,
            cl.netchan.incoming_sequence,
          );

          if (calculatedChecksum !== checksum) {
            Com_DPrintf("Failed command checksum for %s (%d != %d)/%d\n", cl.name, calculatedChecksum, checksum, cl.netchan.incoming_sequence);
            return;
          }
        }

        // developer-gated diagnostic, the non-batch twin of the
        // SV_NewClientExecuteMove line in the batched case below -- the
        // interop matrix's cell (c) counts these to prove protocol 34/35
        // movement is being decoded and applied continuously across a live
        // session rather than once at spawn.
        Com_DPrintf("SV_OldClientExecuteMove: %s lastframe=%d msec=%d fwd=%d side=%d\n", cl.name, lastframe, newcmd.msec, newcmd.forwardmove, newcmd.sidemove);

        // sv_paused gate: KEPT, and mirrored onto the batched-move case
        // below. Real q2repro has no per-move pause gate, but that is because
        // its pause lives one level up in the frame loop and is far broader
        // than this port's: src/server/main.c:1883's `if (svs.initialized &&
        // !check_paused())` skips SV_CheckTimeouts, SV_CalcPings,
        // SV_GiveMsec, SV_RunGameFrame, SV_SendClientMessages and
        // SV_MasterHeartbeat wholesale, and check_paused itself (main.c:
        // 1669-1703) can only ever return true on a NON-dedicated build with
        // cl_paused set, no timedemo running, exactly one client
        // (LIST_SINGLE(&sv_clientlist)) and no MVD/GTV viewers. This port has
        // no check_paused: sv_main.ts's SV_Frame runs SV_ReadPackets,
        // SV_GiveMsec and SV_SendClientMessages unconditionally and only
        // SV_RunGameFrame carries id's narrower `!sv_paused || maxclients > 1`
        // gate. Dropping the gate here would therefore NOT reproduce
        // q2repro's behavior -- it would let a paused listen server's player
        // pmove around a frozen world, which neither engine does. See report.
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

      // clc_q2pro_move_batched / clc_q2pro_move_nodelta (phase-8 q2repro
      // interop unit): the wire body is protocol-dependent (see
      // q2repro.ts's/q2pro.ts's own readBatchMove), but the apply/backfill
      // logic below is not -- ported from qsrc/q2repro/src/server/user.c's
      // SV_NewClientExecuteMove (lines 1119-1200), which both protocols'
      // servers share verbatim.
      case ClcOpsT.clc_q2pro_move_nodelta:
      case ClcOpsT.clc_q2pro_move_batched: {
        // SV_NewClientExecuteMove (user.c:1126-1131), same drop as the
        // non-batch sibling above now performs.
        if (moveIssued) {
          Com_Printf("%s: multiple clc_move commands in packet\n", cl.name);
          SV_DropClient(cl);
          return; // someone is trying to cheat...
        }
        moveIssued = true;

        const readBatchMove = cl.codec.readBatchMove;
        if (!readBatchMove) {
          Com_Printf("SV_ReadClientMessage: unknown command char\n");
          SV_DropClient(cl);
          return;
        }

        let batch;
        try {
          batch = readBatchMove(net_message, c === ClcOpsT.clc_q2pro_move_nodelta, opcodeExtra);
        } catch (e) {
          if (e instanceof ClcBatchMoveError) {
            Com_DPrintf("SV_ReadClientMessage: bad client message (%s)\n", e.message);
            SV_DropClient(cl);
            return;
          }
          throw e;
        }

        // SV_NewClientExecuteMove: state check BEFORE recording lastframe
        // (user.c:1160-1165) -- unlike this port's pre-existing non-batch
        // clc_move case above, which records lastframe/frame_latency before
        // its own spawned check. New code, ported against the real current
        // reference order rather than preserving that sibling's order.
        if (cl.state !== ClientStateT.cs_spawned) {
          cl.lastframe = -1;
          break;
        }

        if (batch.lastframe !== cl.lastframe) {
          cl.lastframe = batch.lastframe;
          if (cl.lastframe > 0) {
            cl.frame_latency[cl.lastframe & (LATENCY_COUNTS - 1)] = svs.realtime - cl.frames[cl.lastframe & UPDATE_MASK].senttime;
          }
        }

        let lastcmd: UsercmdT | null = null;
        for (const frame of batch.frames) for (const cmd of frame.cmds) lastcmd = cmd;
        if (!lastcmd) break; // every frame was empty -- user.c's q_unlikely(!lastcmd) guard

        // developer-gated diagnostic (matches this file's existing
        // Com_DPrintf convention, e.g. SV_ClientThink's "commandMsec
        // underflow" line above) -- phase-8 interop evidence that batched
        // move packets are being decoded and applied CONTINUOUSLY across a
        // live session, not just once on the first packet.
        Com_DPrintf(
          "SV_NewClientExecuteMove: %s numDups=%d newFrameCmds=%d lastframe=%d fwd=%d side=%d\n",
          cl.name,
          batch.numDups,
          batch.frames[batch.numDups].cmds.length,
          batch.lastframe,
          lastcmd.forwardmove,
          lastcmd.sidemove,
        );

        // sv_paused gate, matching the non-batch sibling above. Real
        // q2repro's SV_NewClientExecuteMove has no such gate because its
        // pause is a whole-frame skip in SV_Frame (main.c:1883's
        // check_paused) that this port does not have -- the full reasoning
        // and citations live on the clc_move case above.
        const paused = sv_paused ? sv_paused.value !== 0 : false;
        if (!paused) {
          let net_drop = cl.netchan.dropped;
          if (net_drop < 20) {
            while (net_drop > batch.numDups) {
              SV_ClientThink(cl, cl.lastcmd);
              net_drop--;
            }
            while (net_drop > 0) {
              const backfillFrame = batch.frames[batch.numDups - net_drop];
              for (const cmd of backfillFrame.cmds) SV_ClientThink(cl, cmd);
              net_drop--;
            }
          }
          for (const cmd of batch.frames[batch.numDups].cmds) SV_ClientThink(cl, cmd);
        }

        cl.lastcmd = lastcmd;
        break;
      }

      // clc_r1q2_setting (phase-8 interop finding, not in this unit's
      // original brief -- discovered live: a real q2repro client sends this
      // immediately after entering the game, BEFORE any movement packet, so
      // it blocked cell (a)/(c) exactly like the three named opcodes did.
      // See codec.ts's ClcClientSettingT / SV_ParseClientSetting citation.
      case ClcOpsT.clc_r1q2_setting: {
        const readClientSetting = cl.codec.readClientSetting;
        if (!readClientSetting) {
          Com_Printf("SV_ReadClientMessage: unknown command char\n");
          SV_DropClient(cl);
          return;
        }

        const setting = readClientSetting(net_message);
        if (setting.index >= 0 && setting.index < cl.settings.length) {
          cl.settings[setting.index] = setting.value;
        }
        break;
      }

      case ClcOpsT.clc_q2pro_userinfo_delta: {
        const readUserinfoDelta = cl.codec.readUserinfoDelta;
        if (!readUserinfoDelta) {
          Com_Printf("SV_ReadClientMessage: unknown command char\n");
          SV_DropClient(cl);
          return;
        }

        let delta;
        try {
          delta = readUserinfoDelta(net_message);
        } catch (e) {
          if (e instanceof ClcBatchMoveError) {
            Com_DPrintf("SV_ReadClientMessage: bad client message (%s)\n", e.message);
            SV_DropClient(cl);
            return;
          }
          throw e;
        }

        cl.userinfo = Info_SetValueForKey(cl.userinfo, delta.name, delta.value);
        SV_UserinfoChanged(cl);
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
        Com_Printf("SV_ReadClientMessage: unknown command char (raw=%d masked=%d extra=%d)\n", rawCmd, c, opcodeExtra);
        SV_DropClient(cl);
        return;
    }
  }
}
