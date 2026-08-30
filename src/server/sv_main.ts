// sv_main.c

import {
  NetsrcT,
  NetadrT,
  SysError,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_RERELEASE,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_R1Q2_MINIMUM,
  PROTOCOL_VERSION_R1Q2_CURRENT,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_Q2PRO_MINIMUM,
  PROTOCOL_VERSION_Q2PRO_CURRENT,
  VERSION,
  SvcOpsT,
  MAX_MSGLEN,
} from "../qcommon/qcommon";
import type { ProtocolCodec } from "../qcommon/protocol/codec";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../qcommon/protocol/q2repro";
import { createR1Q2Codec } from "../qcommon/protocol/r1q2";
import { createQ2ProCodec } from "../qcommon/protocol/q2pro";
import { CS_REMAP_RERELEASE } from "../shared/cs_remap";
import { Netchan_OutOfBandPrint, Netchan_Setup, Netchan_Process, Netchan_Transmit, net_message_buffer, NETCHAN_OLD, NETCHAN_NEW } from "../qcommon/net_chan";
import { NET_CompareBaseAdr, NET_AdrToString, NET_IsLocalAddress, NET_GetPacket } from "../platform/net_udp";
import { MSG_BeginReading, MSG_ReadLong, MSG_ReadStringLine, MSG_WriteByte, MSG_WriteString, SZ_Init, SZ_Clear } from "../qcommon/sizebuf";
import { Cmd_TokenizeString, Cmd_Argv, Cmd_Argc, Cmd_ExecuteString } from "../qcommon/cmd";
import { Cvar_Get, Cvar_Serverinfo } from "../qcommon/cvar";
import { Com_Printf, Com_DPrintf, Com_BeginRedirect, Com_EndRedirect, Com_SetServerState, comTiming, dedicated, host_speeds } from "../qcommon/common";
import { FS_FreeFile, FS_FCloseFile } from "../qcommon/files";
import { Sys_Milliseconds } from "../platform/sys";
import {
  Com_sprintf,
  PRINT_HIGH,
  MAX_INFO_STRING,
  STAT_FRAGS,
  PlayerStateT,
  Info_ValueForKey,
  Info_SetValueForKey,
  CVAR_ARCHIVE,
  CVAR_LATCH,
  CVAR_SERVERINFO,
  CVAR_NOSET,
  DF_INSTANT_ITEMS,
  type CvarT,
} from "../shared/q_shared";
import type { GameExports } from "../game/game";
import {
  sv,
  svs,
  master_adr,
  ClientStateT,
  ClientT,
  MAX_CHALLENGES,
  MAX_MASTERS,
  LATENCY_COUNTS,
  RedirectT,
  SV_OUTPUTBUF_LENGTH,
  svClientHolder,
  net_from,
  net_message,
  sv_paused,
  maxclients,
  setSvPaused,
  setMaxclients,
  setSvNoreload,
  setSvAiraccelerate,
  setSvEnforcetime,
  setSvTickRate,
} from "./server";
import { geHolder, SV_ShutdownGameProgs } from "./sv_game";
import { SV_BroadcastPrintf, SV_SendClientMessages, SV_FlushRedirect } from "./sv_send";
import { SV_ExecuteClientMessage } from "./sv_user";
import { SV_RecordDemoMessage } from "./sv_ents";
import { SV_InitOperatorCommands } from "./sv_ccmds";
import { Nav_Init, Nav_Unload, Nav_Frame } from "./nav";
import { SV_MvdRegister, SV_MvdBeginFrame, SV_MvdEndFrame } from "./sv_mvd";

//============================================================================

export let sv_timedemo: CvarT | null = null;

export let timeout: CvarT | null = null; // seconds without any message
export let zombietime: CvarT | null = null; // seconds to sink messages after disconnect

export let rcon_password: CvarT | null = null; // password for remote server commands

export let allow_download: CvarT | null = null;
export let allow_download_players: CvarT | null = null;
export let allow_download_models: CvarT | null = null;
export let allow_download_sounds: CvarT | null = null;
export let allow_download_maps: CvarT | null = null;

export let sv_showclamp: CvarT | null = null;

export let hostname: CvarT | null = null;
export let public_server: CvarT | null = null; // should heartbeats be sent

export let sv_reconnect_limit: CvarT | null = null; // minimum seconds between connect messages

// task #24: HTTP download server advertisement (Q2PRO src/server/main.c:
// "sv_downloadserver = Cvar_Get("sv_downloadserver", "", 0);"). When set,
// appended to the "client_connect" out-of-band reply below so clients can
// negotiate an HTTP dlserver exactly as Q2PRO's send_connect_packet does.
export let sv_downloadserver: CvarT | null = null;

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function copyNetadr(a: NetadrT): NetadrT {
  const c = new NetadrT();
  c.type = a.type;
  c.ip = new Uint8Array(a.ip);
  c.ipx = new Uint8Array(a.ipx);
  c.port = a.port;
  return c;
}

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_main: ge used before SV_InitGameProgs");
  return ge;
}

// game.h's gclient_s server-visible prefix (`{ player_state_t ps; int
// ping; }`) is not represented in game.ts's `Edict.client: unknown` (game.ts
// documents GClientT as private to the game module). SV_StatusString and
// SV_CalcPings need this prefix the same way the C server code reaches
// through `cl->edict->client->ps`/`->ping`; narrowed here with a real type
// guard instead of a cast. See report -- ideally game.ts grows a
// `GClientPublic` interface alongside `Edict` for this.
interface GClientPublic {
  ps: PlayerStateT;
  ping: number;
}

function isGClientPublic(client: unknown): client is GClientPublic {
  if (typeof client !== "object" || client === null) return false;
  if (!("ps" in client) || !("ping" in client)) return false;
  return client.ps instanceof PlayerStateT && typeof client.ping === "number";
}

//============================================================================

/*
=====================
SV_DropClient

Called when the player is totally leaving the server, either willingly
or unwillingly.  This is NOT called if the entire server is quiting
or crashing.
=====================
*/
export function SV_DropClient(drop: ClientT): void {
  // add the disconnect
  MSG_WriteByte(drop.netchan.message, SvcOpsT.svc_disconnect);

  if (drop.state === ClientStateT.cs_spawned) {
    // call the prog function for removing a client
    // this will remove the body, among other things
    const ge = requireGe();
    if (!drop.edict) throw new SysError("SV_DropClient: drop.edict is null");
    ge.ClientDisconnect(drop.edict);
  }

  if (drop.download) {
    FS_FreeFile(drop.download);
    drop.download = null;
  }

  drop.state = ClientStateT.cs_zombie; // become free in a few seconds
  drop.name = "";
}

/*
==============================================================================

CONNECTIONLESS COMMANDS

==============================================================================
*/

/*
===============
SV_StatusString

Builds the string that is sent as heartbeats and status replies
===============
*/
export function SV_StatusString(): string {
  const STATUS_LIMIT = MAX_MSGLEN - 16;

  let status = `${Cvar_Serverinfo()}\n`;
  const maxc = maxclients ? maxclients.value : 0;

  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl) continue;
    if (cl.state === ClientStateT.cs_connected || cl.state === ClientStateT.cs_spawned) {
      let frags = 0;
      if (cl.edict) {
        const client = cl.edict.client;
        if (isGClientPublic(client)) frags = client.ps.stats[STAT_FRAGS];
      }
      const player = `${frags} ${cl.ping} "${cl.name}"\n`;
      if (status.length + player.length >= STATUS_LIMIT) break; // can't hold any more
      status += player;
    }
  }

  return status;
}

/*
================
SVC_Status

Responds with all the info that qplug or qspy can see
================
*/
export function SVC_Status(): void {
  Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, net_from, "print\n%s", SV_StatusString());
}

/*
================
SVC_Ack
================
*/
export function SVC_Ack(): void {
  Com_Printf("Ping acknowledge from %s\n", NET_AdrToString(net_from));
}

/*
================
SVC_Info

Responds with short info for broadcast scans
The second parameter should be the current protocol version number.
================
*/
export function SVC_Info(): void {
  if (maxclients && maxclients.value === 1) return; // ignore in single player

  const version = atoi(Cmd_Argv(1));

  let str: string;
  if (version !== PROTOCOL_VERSION) {
    str = Com_sprintf("%s: wrong version\n", hostname ? hostname.string : "");
  } else {
    let count = 0;
    const maxc = maxclients ? maxclients.value : 0;
    for (let i = 0; i < maxc; i++) if (svs.clients[i] && svs.clients[i].state >= ClientStateT.cs_connected) count++;

    str = Com_sprintf("%16s %8s %2i/%2i\n", hostname ? hostname.string : "", sv.name, count, maxc | 0);
  }

  Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, net_from, "info\n%s", str);
}

/*
================
SVC_Ping

Just responds with an acknowledgement
================
*/
export function SVC_Ping(): void {
  Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, net_from, "ack");
}

/*
=================
SVC_GetChallenge

Returns a challenge number that can be used
in a subsequent client_connect command.
We do this to prevent denial of service attacks that
flood the server with invalid connection IPs.  With a
challenge, they must give a valid IP address.
=================
*/
export function SVC_GetChallenge(): void {
  let oldest = 0;
  let oldestTime = 0x7fffffff;

  // see if we already have a challenge for this ip
  let i = 0;
  for (i = 0; i < MAX_CHALLENGES; i++) {
    if (NET_CompareBaseAdr(net_from, svs.challenges[i].adr)) break;
    if (svs.challenges[i].time < oldestTime) {
      oldestTime = svs.challenges[i].time;
      oldest = i;
    }
  }

  if (i === MAX_CHALLENGES) {
    // overwrite the oldest
    svs.challenges[oldest].challenge = Math.floor(Math.random() * 0x10000) & 0x7fff;
    svs.challenges[oldest].adr = copyNetadr(net_from); // struct copy -- net_from is a shared singleton, mutated by the next packet
    svs.challenges[oldest].time = svs.realtime;
    i = oldest;
  }

  // RULE-17 FINDING (phase-8 q2repro interop, matrix cell a): q2proto_client.c's
  // q2proto_parse_challenge (q2repro's real client wire code) only accepts a
  // bare "challenge %i" with no "p=" suffix as an IMPLICIT vanilla-protocol
  // offer, and that implicit path leaves cls.serverProtocol at its stale
  // default instead of resolving to PROTOCOL_VERSION_VANILLA -- confirmed by
  // capturing a real q2repro binary's client against this server: it printed
  // "Requesting connection... N" then immediately errored "Could not get
  // connect string (PROTOCOL_NOT_SUPPORTED)" from client/main.c's
  // CL_CheckForResend, because q2proto_complete_connect() rejects the
  // leftover protocol value. Real q2repro/q2proto SERVERS (src/server/main.c's
  // own SVC_GetChallenge) never send the bare form: they always append a
  // "p=<comma-separated netvers>" suffix via q2proto_get_challenge_extras(),
  // built from the exact protocol list that server instance accepts (q2repro's
  // own dedicated server hardcodes q2repro_accepted_protocols = {Q2P_PROTOCOL_
  // Q2REPRO} only -- it never serves vanilla/R1Q2/Q2PRO). This server mirrors
  // that: the kex family (svs.csr === CS_REMAP_RERELEASE) advertises only
  // 1038 (SVC_DirectConnect's own isKexFamily gate already only accepts
  // that version); the legacy family advertises 34/35/36 ascending, matching
  // q2proto_get_challenge_extras' qsort-ascending order, so real q2proto
  // clients can negotiate any of the three instead of falling into the same
  // broken implicit-vanilla path.
  const protocolExtras = svs.csr === CS_REMAP_RERELEASE
    ? `p=${PROTOCOL_VERSION_RERELEASE}`
    : `p=${PROTOCOL_VERSION},${PROTOCOL_VERSION_R1Q2},${PROTOCOL_VERSION_Q2PRO}`;

  // send it back
  Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, net_from, "challenge %i %s", svs.challenges[i].challenge, protocolExtras);
}

/*
==================
SVC_DirectConnect

A connection request that did not come from the master
==================
*/
export function SVC_DirectConnect(): void {
  // adr = net_from -- net_from is a shared singleton mutated by every future
  // NET_GetPacket call, and this address gets handed to Netchan_Setup below
  // (which keeps whatever reference it's given, per net_chan.ts), so a real
  // copy is required here, unlike the C `netadr_t adr = net_from;` struct
  // copy that came for free.
  const adr = copyNetadr(net_from);

  Com_DPrintf("SVC_DirectConnect ()\n");

  // v1.0.0 wire cluster (task board #23), Mike's ruling: our server accepts
  // classic community clients. Family gate first (matches q2repro's own
  // rejection -- svs.csr === CS_REMAP_RERELEASE, set once at game-library
  // init by sv_game.ts's SV_InitGameProgs, means "kex family": only 1038 is
  // ever accepted there, no per-client variance). The "legacy" family
  // (svs.csr === CS_REMAP_OLD) now accepts 34, 35 (R1Q2), or 36 (Q2PRO) and
  // negotiates per CLIENT (not per server, unlike svs.codec's own family-
  // default role -- see server.ts's ClientT.codec doc comment), because a
  // single legacy-family server can serve a mix of vanilla/R1Q2/Q2PRO clients
  // at once.
  const version = atoi(Cmd_Argv(1));
  const isKexFamily = svs.csr === CS_REMAP_RERELEASE;

  // RULE-17 FINDING (phase-8 q2repro interop): a real client speaking kex
  // (1038) or Q2PRO (36) always transmits with NETCHAN_NEW framing (single
  // conditional-byte qport, fragmentation bit) rather than this port's
  // pre-existing NETCHAN_OLD-only header -- see net_chan.ts's NETCHAN_NEW
  // doc comment for the exact wire difference and how it was confirmed
  // against the real q2repro binary (matrix cell a). Vanilla and R1Q2 stay
  // NETCHAN_OLD, matching q2repro's own client/main.c CL_CheckForResend.
  const chanType = isKexFamily || version === PROTOCOL_VERSION_Q2PRO ? NETCHAN_NEW : NETCHAN_OLD;

  let negotiatedCodec: ProtocolCodec;
  let negotiatedMinorVersion = 0;
  let negotiatedCompress = false;

  if (isKexFamily) {
    if (version !== PROTOCOL_VERSION_RERELEASE) {
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nServer is version %4.2f.\n", VERSION);
      Com_DPrintf("    rejected connect from version %i\n", version);
      return;
    }
    negotiatedCodec = Q2REPRO_CODEC;
  } else if (version === PROTOCOL_VERSION) {
    negotiatedCodec = VANILLA_CODEC;
  } else if (version === PROTOCOL_VERSION_R1Q2) {
    // Connect-string tail (q2proto_r1q2_connect_tail): "<packet_length>
    // <minor version>" after the four standard fields (Cmd_Argv(5)/(6)).
    // packet_length is read-and-ignored -- this port's netchan
    // (qcommon/net_chan.ts) never implements R1Q2's alternate fragmentation,
    // only the classic/unfragmented framing every protocol here shares.
    const rawVersion = Cmd_Argv(6);
    let minor = rawVersion === "" ? PROTOCOL_VERSION_R1Q2_MINIMUM : atoi(rawVersion);
    if (minor < PROTOCOL_VERSION_R1Q2_MINIMUM) minor = PROTOCOL_VERSION_R1Q2_MINIMUM;
    if (minor > PROTOCOL_VERSION_R1Q2_CURRENT) minor = PROTOCOL_VERSION_R1Q2_CURRENT;
    negotiatedCodec = createR1Q2Codec(minor);
    negotiatedMinorVersion = minor;
    // R1Q2 supports svc_r1q2_zpacket unconditionally (q2proto_proto_r1q2.c:39,
    // `parsed_connect->has_zlib = true` -- not client-negotiated for this
    // family, unlike Q2PRO below).
    negotiatedCompress = true;
  } else if (version === PROTOCOL_VERSION_Q2PRO) {
    // Connect-string tail (q2proto_q2pro_connect_tail): "<packet_length>
    // <netchan_type> <has_zlib> <minor version>" (Cmd_Argv(5)..(8)).
    // netchan_type is read-and-ignored for the same reason packet_length is
    // above (this port only ever runs the classic netchan framing --
    // requesting NETCHAN_OLD is the honest ask, but this server does not
    // actually branch on what the client requested here, matching the
    // client-side symmetric scope cut documented in cl_main.ts's
    // CL_SendConnectPacket).
    const zlibRaw = Cmd_Argv(7);
    negotiatedCompress = zlibRaw !== "" && atoi(zlibRaw) !== 0;
    const rawVersion = Cmd_Argv(8);
    let minor = rawVersion === "" ? PROTOCOL_VERSION_Q2PRO_MINIMUM : atoi(rawVersion);
    if (minor < PROTOCOL_VERSION_Q2PRO_MINIMUM) minor = PROTOCOL_VERSION_Q2PRO_MINIMUM;
    if (minor > PROTOCOL_VERSION_Q2PRO_CURRENT) minor = PROTOCOL_VERSION_Q2PRO_CURRENT;
    negotiatedCodec = createQ2ProCodec(minor);
    negotiatedMinorVersion = minor;
  } else {
    Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nServer is version %4.2f.\n", VERSION);
    Com_DPrintf("    rejected connect from version %i\n", version);
    return;
  }

  const qport = atoi(Cmd_Argv(2));
  const challenge = atoi(Cmd_Argv(3));

  let userinfo = Cmd_Argv(4);
  if (userinfo.length > MAX_INFO_STRING - 1) userinfo = userinfo.slice(0, MAX_INFO_STRING - 1);

  // force the IP key/value pair so the game can filter based on ip
  userinfo = Info_SetValueForKey(userinfo, "ip", NET_AdrToString(net_from));

  // attractloop servers are ONLY for local clients
  if (sv.attractloop) {
    if (!NET_IsLocalAddress(adr)) {
      Com_Printf("Remote connect in attract loop.  Ignored.\n");
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nConnection refused.\n");
      return;
    }
  }

  // see if the challenge is valid
  if (!NET_IsLocalAddress(adr)) {
    let i = 0;
    for (i = 0; i < MAX_CHALLENGES; i++) {
      if (NET_CompareBaseAdr(net_from, svs.challenges[i].adr)) {
        if (challenge === svs.challenges[i].challenge) break; // good
        Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nBad challenge.\n");
        return;
      }
    }
    if (i === MAX_CHALLENGES) {
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nNo challenge for address.\n");
      return;
    }
  }

  const maxc = maxclients ? maxclients.value : 0;

  let newcl: ClientT | null = null;
  let newclIndex = -1;

  // if there is already a slot for this ip, reuse it
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (cl.state === ClientStateT.cs_free) continue;
    if (NET_CompareBaseAdr(adr, cl.netchan.remote_address) && (cl.netchan.qport === qport || adr.port === cl.netchan.remote_address.port)) {
      if (!NET_IsLocalAddress(adr) && svs.realtime - cl.lastconnect < (sv_reconnect_limit ? sv_reconnect_limit.value : 0) * 1000) {
        Com_DPrintf("%s:reconnect rejected : too soon\n", NET_AdrToString(adr));
        return;
      }
      Com_Printf("%s:reconnect\n", NET_AdrToString(adr));
      newcl = cl;
      newclIndex = i;
      break;
    }
  }

  if (!newcl) {
    // find a free client slot
    for (let i = 0; i < maxc; i++) {
      if (svs.clients[i].state === ClientStateT.cs_free) {
        newcl = svs.clients[i];
        newclIndex = i;
        break;
      }
    }
    if (!newcl) {
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nServer is full.\n");
      Com_DPrintf("Rejected a connection.\n");
      return;
    }
  }

  // build a new connection -- accept the new client; this is the only place
  // a client_t is ever (re-)initialized
  newcl.clear();
  newcl.codec = negotiatedCodec;
  newcl.protocolMinorVersion = negotiatedMinorVersion;
  svClientHolder.sv_client = newcl;
  const edictnum = newclIndex + 1;
  const ge = requireGe();
  const ent = ge.edicts[edictnum];
  newcl.edict = ent;
  newcl.challenge = challenge; // save challenge for checksumming

  // get the game a chance to reject this connection or modify the userinfo.
  // C mutates `userinfo` in place (the game DLL injects a "rejmsg" key on
  // rejection); this port returns the mutated string alongside the verdict.
  const connect = ge.ClientConnect(ent, userinfo);
  userinfo = connect.userinfo;
  if (!connect.allowed) {
    const rejmsg = Info_ValueForKey(userinfo, "rejmsg");
    if (rejmsg.length) Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\n%s\nConnection refused.\n", rejmsg);
    else Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nConnection refused.\n");
    Com_DPrintf("Game rejected a connection.\n");
    return;
  }

  // parse some info from the info strings
  newcl.userinfo = userinfo;
  SV_UserinfoChanged(newcl);

  // send the connect packet to the client. task #24: advertise the HTTP
  // dlserver URL (if configured) via the same out-of-band string Q2PRO's
  // send_connect_packet appends " dlserver=<url>" to -- cl_main.ts's
  // "client_connect" handler parses this token back out.
  if (sv_downloadserver && sv_downloadserver.string.length) {
    Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "client_connect dlserver=%s", sv_downloadserver.string);
  } else {
    Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "client_connect");
  }

  Netchan_Setup(NetsrcT.NS_SERVER, newcl.netchan, adr, qport, chanType);
  // svc_zpacket eligibility for this connection (qcommon/protocol/
  // zpacket.ts) -- set after Netchan_Setup since that call replaces
  // newcl.netchan wholesale via Netchan_Setup's own chan mutation (not a
  // fresh object), but newcl.clear() above DOES replace it with a fresh
  // NetchanT (compress defaults false), so this must run after clear().
  newcl.netchan.compress = negotiatedCompress;

  newcl.state = ClientStateT.cs_connected;

  SZ_Init(newcl.datagram, newcl.datagram_buf, newcl.datagram_buf.length);
  newcl.datagram.allowoverflow = true;
  newcl.lastmessage = svs.realtime; // don't timeout
  newcl.lastconnect = svs.realtime;
}

function Rcon_Validate(): boolean {
  if (!rcon_password || !rcon_password.string.length) return false;
  if (Cmd_Argv(1) !== rcon_password.string) return false;
  return true;
}

// C prints `net_message.data+4` (the raw OOB payload after the 4-byte -1
// marker) as a null-terminated string; matches MSG_ReadString's byte->char
// convention (`String.fromCharCode(b & 0xff)`).
function cstrFromOffset(data: Uint8Array, offset: number, limit: number): string {
  let s = "";
  for (let i = offset; i < limit; i++) {
    const b = data[i];
    if (b === 0) break;
    s += String.fromCharCode(b & 0xff);
  }
  return s;
}

/*
===============
SVC_RemoteCommand

A client issued an rcon command.
Shift down the remaining args
Redirect all printfs
===============
*/
export function SVC_RemoteCommand(): void {
  const raw = cstrFromOffset(net_message.data, 4, net_message.cursize);

  if (!Rcon_Validate()) {
    Com_Printf("Bad rcon from %s:\n%s\n", NET_AdrToString(net_from), raw);
  } else {
    Com_Printf("Rcon from %s:\n%s\n", NET_AdrToString(net_from), raw);
  }

  Com_BeginRedirect(RedirectT.RD_PACKET, SV_OUTPUTBUF_LENGTH, SV_FlushRedirect);

  if (!Rcon_Validate()) {
    Com_Printf("Bad rcon_password.\n");
  } else {
    let remaining = "";
    const argc = Cmd_Argc();
    for (let i = 2; i < argc; i++) {
      remaining += Cmd_Argv(i);
      remaining += " ";
    }
    Cmd_ExecuteString(remaining);
  }

  Com_EndRedirect();
}

/*
=================
SV_ConnectionlessPacket

A connectionless packet has four leading 0xff
characters to distinguish it from a game channel.
Clients that are in the game can still send
connectionless packets.
=================
*/
export function SV_ConnectionlessPacket(): void {
  MSG_BeginReading(net_message);
  MSG_ReadLong(net_message); // skip the -1 marker

  const s = MSG_ReadStringLine(net_message);

  Cmd_TokenizeString(s, false);

  const c = Cmd_Argv(0);
  Com_DPrintf("Packet %s : %s\n", NET_AdrToString(net_from), c);

  if (c === "ping") SVC_Ping();
  else if (c === "ack") SVC_Ack();
  else if (c === "status") SVC_Status();
  else if (c === "info") SVC_Info();
  else if (c === "getchallenge") SVC_GetChallenge();
  else if (c === "connect") SVC_DirectConnect();
  else if (c === "rcon") SVC_RemoteCommand();
  else Com_Printf("bad connectionless packet from %s:\n%s\n", NET_AdrToString(net_from), s);
}

//============================================================================

/*
===================
SV_CalcPings

Updates the cl->ping variables
===================
*/
export function SV_CalcPings(): void {
  const maxc = maxclients ? maxclients.value : 0;

  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl || cl.state !== ClientStateT.cs_spawned) continue;

    let total = 0;
    let count = 0;
    for (let j = 0; j < LATENCY_COUNTS; j++) {
      if (cl.frame_latency[j] > 0) {
        count++;
        total += cl.frame_latency[j];
      }
    }
    if (!count) cl.ping = 0;
    else cl.ping = (total / count) | 0;

    // let the game dll know about the ping
    if (cl.edict) {
      const client = cl.edict.client;
      if (isGClientPublic(client)) client.ping = cl.ping;
    }
  }
}

/*
===================
SV_GiveMsec

Every few frames, gives all clients an allotment of milliseconds
for their command moves.  If they exceed it, assume cheating.
===================
*/
export function SV_GiveMsec(): void {
  if (sv.framenum & 15) return;

  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl || cl.state === ClientStateT.cs_free) continue;

    cl.commandMsec = 1800; // 1600 + some slop
  }
}

/*
=================
SV_ReadPackets
=================
*/
export function SV_ReadPackets(): void {
  const maxc = maxclients ? maxclients.value : 0;

  while (NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)) {
    // check for connectionless packet (0xffffffff) first
    const d = net_message.data;
    if (net_message.cursize >= 4 && (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) === -1) {
      SV_ConnectionlessPacket();
      continue;
    }

    // RULE-17 FINDING (phase-8 q2repro interop): the qport field's WIDTH
    // depends on the matched client's own netchan type (NETCHAN_NEW's is a
    // single conditional byte; NETCHAN_OLD's is an unconditional 16-bit
    // short -- see net_chan.ts's NETCHAN_NEW doc comment), so it cannot be
    // read generically before knowing which client a packet belongs to.
    // This now matches by BASE ADDRESS first and peeks the qport bytes
    // per-candidate, mirroring q2repro's own real dispatcher exactly
    // (src/server/main.c's SV_PacketEvent, lines 1467-1487: address match,
    // then `if (netchan->qport) { qport = msg_read.data[8]; ... }`).
    const d2 = net_message.data;

    // check for packets from connected clients
    for (let i = 0; i < maxc; i++) {
      const cl = svs.clients[i];
      if (cl.state === ClientStateT.cs_free) continue;
      if (!NET_CompareBaseAdr(net_from, cl.netchan.remote_address)) continue;

      if (cl.netchan.qport) {
        const qportSize = cl.netchan.type === NETCHAN_NEW ? 1 : 2;
        if (net_message.cursize < 8 + qportSize) continue;
        const qport = cl.netchan.type === NETCHAN_NEW ? d2[8] : d2[8] | (d2[9] << 8);
        if (cl.netchan.qport !== qport) continue;
      } else if (cl.netchan.remote_address.port !== net_from.port) {
        continue;
      }

      if (cl.netchan.remote_address.port !== net_from.port) {
        Com_Printf("SV_ReadPackets: fixing up a translated port\n");
        cl.netchan.remote_address.port = net_from.port;
      }

      if (Netchan_Process(cl.netchan, net_message)) {
        // this is a valid, sequenced packet, so process it
        if (cl.state !== ClientStateT.cs_zombie) {
          cl.lastmessage = svs.realtime; // don't timeout
          SV_ExecuteClientMessage(cl);
        }
      }
      break;
    }
  }
}

/*
==================
SV_CheckTimeouts

If a packet has not been received from a client for timeout->value
seconds, drop the conneciton.  Server frames are used instead of
realtime to avoid dropping the local client while debugging.

When a client is normally dropped, the client_t goes into a zombie state
for a few seconds to make sure any final reliable message gets resent
if necessary
==================
*/
export function SV_CheckTimeouts(): void {
  const droppoint = svs.realtime - 1000 * (timeout ? timeout.value : 0);
  const zombiepoint = svs.realtime - 1000 * (zombietime ? zombietime.value : 0);

  for (const cl of svs.clients) {
    // message times may be wrong across a changelevel
    if (cl.lastmessage > svs.realtime) cl.lastmessage = svs.realtime;

    if (cl.state === ClientStateT.cs_zombie && cl.lastmessage < zombiepoint) {
      cl.state = ClientStateT.cs_free; // can now be reused
      continue;
    }
    if ((cl.state === ClientStateT.cs_connected || cl.state === ClientStateT.cs_spawned) && cl.lastmessage < droppoint) {
      SV_BroadcastPrintf(PRINT_HIGH, "%s timed out\n", cl.name);
      SV_DropClient(cl);
      cl.state = ClientStateT.cs_free; // don't bother with zombie state
    }
  }
}

/*
================
SV_PrepWorldFrame

This has to be done before the world logic, because
player processing happens outside RunWorldFrame
================
*/
export function SV_PrepWorldFrame(): void {
  const ge = requireGe();
  for (let i = 0; i < ge.num_edicts; i++) {
    const ent = ge.edicts[i];
    // events only last for a single message
    ent.s.event = 0;
  }
}

/*
=================
SV_RunGameFrame
=================
*/
export function SV_RunGameFrame(): void {
  // main.c:1727: "run nav stuff before frame runs" -- Nav_Frame() runs
  // unconditionally, every time this function does (q2repro's own snippet
  // has no pause guard around either Nav_Frame() or the ge->RunFrame(true)
  // that follows it), unlike the `!paused` gate below that guards only the
  // engine's own ge.RunFrame() call.
  Nav_Frame();

  if (host_speeds && host_speeds.value) comTiming.time_before_game = Sys_Milliseconds();

  // we always need to bump framenum, even if we
  // don't run the world, otherwise the delta
  // compression can get confused when a client
  // has the "current" frame
  sv.framenum++;
  sv.time = sv.framenum * sv.frametime;

  // don't run if paused
  const paused = sv_paused ? sv_paused.value !== 0 : false;
  if (!paused || (maxclients ? maxclients.value > 1 : false)) {
    const ge = requireGe();
    ge.RunFrame();

    // never get more than one tic behind
    if (sv.time < svs.realtime) {
      if (sv_showclamp && sv_showclamp.value) Com_Printf("sv highclamp\n");
      svs.realtime = sv.time;
    }
  }

  if (host_speeds && host_speeds.value) comTiming.time_after_game = Sys_Milliseconds();
}

/*
==================
SV_Frame
==================
*/
export function SV_Frame(msec: number): void {
  comTiming.time_before_game = 0;
  comTiming.time_after_game = 0;

  // if server is not active, do nothing
  if (!svs.initialized) return;

  svs.realtime += msec;

  // keep the random time dependent
  Math.random();

  // check timeouts
  SV_CheckTimeouts();

  // get packets from clients
  SV_ReadPackets();

  // move autonomous things around if enough time has passed
  if (!(sv_timedemo && sv_timedemo.value) && svs.realtime < sv.time) {
    // never let the time get too far off
    if (sv.time - svs.realtime > sv.frametime) {
      if (sv_showclamp && sv_showclamp.value) Com_Printf("sv lowclamp\n");
      svs.realtime = sv.time - sv.frametime;
    }
    // NET_Sleep(sv.time - svs.realtime) -- omitted: net_udp.ts's NET_Sleep
    // is itself omitted there (it would block the process in select()/
    // poll(), meaningless for a single-threaded event-loop host); no
    // substitute call here, SV_Frame just returns early as the original
    // does after the (dropped) sleep. See report.
    return;
  }

  // update ping based on the last known frame from all clients
  SV_CalcPings();

  // give the clients some timeslices
  SV_GiveMsec();

  // mvd.c's SV_MvdBeginFrame (see sv_mvd.ts for scope)
  SV_MvdBeginFrame();

  // let everything in the world think and move
  SV_RunGameFrame();

  // capture this frame's entity/player state into the MVD stream (mvd.c's
  // SV_MvdEndFrame), before SV_SendClientMessages/SV_RecordDemoMessage below
  // clear/reuse any per-frame scratch buffers they share with it
  SV_MvdEndFrame();

  // send messages back to the clients that had packets read this frame
  SV_SendClientMessages();

  // save the entire world state if recording a serverdemo
  SV_RecordDemoMessage(); // sv_ents.ts pending stub -- throws until that unit lands

  // send a heartbeat to the master if needed
  Master_Heartbeat();

  // clear teleport flags, etc for next frame
  SV_PrepWorldFrame();
}

//============================================================================

const HEARTBEAT_SECONDS = 300;

/*
================
Master_Heartbeat

Send a message to the master every few minutes to
let it know we are alive, and log information
================
*/
export function Master_Heartbeat(): void {
  if (!dedicated || !dedicated.value) return; // only dedicated servers send heartbeats
  if (!public_server || !public_server.value) return; // a private dedicated game

  // check for time wraparound
  if (svs.last_heartbeat > svs.realtime) svs.last_heartbeat = svs.realtime;

  if (svs.realtime - svs.last_heartbeat < HEARTBEAT_SECONDS * 1000) return; // not time to send yet

  svs.last_heartbeat = svs.realtime;

  // send the same string that we would give for a status OOB command
  const string = SV_StatusString();

  // send to group master
  for (let i = 0; i < MAX_MASTERS; i++) {
    if (master_adr[i].port) {
      Com_Printf("Sending heartbeat to %s\n", NET_AdrToString(master_adr[i]));
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, master_adr[i], "heartbeat\n%s", string);
    }
  }
}

/*
=================
Master_Shutdown

Informs all masters that this server is going down
=================
*/
export function Master_Shutdown(): void {
  if (!dedicated || !dedicated.value) return; // only dedicated servers send heartbeats
  if (!public_server || !public_server.value) return; // a private dedicated game

  // send to group master
  for (let i = 0; i < MAX_MASTERS; i++) {
    if (master_adr[i].port) {
      if (i > 0) Com_Printf("Sending heartbeat to %s\n", NET_AdrToString(master_adr[i]));
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, master_adr[i], "shutdown");
    }
  }
}

//============================================================================

/*
=================
SV_UserinfoChanged

Pull specific info from a newly changed userinfo string
into a more C freindly form.
=================
*/
export function SV_UserinfoChanged(cl: ClientT): void {
  // call prog code to allow overrides
  const ge = requireGe();
  if (!cl.edict) throw new SysError("SV_UserinfoChanged: cl.edict is null");
  ge.ClientUserinfoChanged(cl.edict, cl.userinfo);

  // name for C code -- sizeof(cl->name)-1 == 31
  let name = Info_ValueForKey(cl.userinfo, "name");
  if (name.length > 31) name = name.slice(0, 31);
  // mask off high bit
  let masked = "";
  for (let i = 0; i < name.length; i++) masked += String.fromCharCode(name.charCodeAt(i) & 127);
  cl.name = masked;

  // rate command
  const rateVal = Info_ValueForKey(cl.userinfo, "rate");
  if (rateVal.length) {
    let r = atoi(rateVal);
    if (r < 100) r = 100;
    if (r > 15000) r = 15000;
    cl.rate = r;
  } else {
    cl.rate = 5000;
  }

  // msg command
  const msgVal = Info_ValueForKey(cl.userinfo, "msg");
  if (msgVal.length) {
    cl.messagelevel = atoi(msgVal);
  }
}

//============================================================================

/*
===============
SV_Init

Only called at quake2.exe startup, not for each game
===============
*/
export function SV_Init(): void {
  SV_InitOperatorCommands();
  SV_MvdRegister();

  rcon_password = Cvar_Get("rcon_password", "", 0);
  Cvar_Get("skill", "1", 0);
  Cvar_Get("deathmatch", "0", CVAR_LATCH);
  Cvar_Get("coop", "0", CVAR_LATCH);
  Cvar_Get("dmflags", `${DF_INSTANT_ITEMS}`, CVAR_SERVERINFO);
  Cvar_Get("fraglimit", "0", CVAR_SERVERINFO);
  Cvar_Get("timelimit", "0", CVAR_SERVERINFO);
  Cvar_Get("cheats", "0", CVAR_SERVERINFO | CVAR_LATCH);
  Cvar_Get("protocol", `${PROTOCOL_VERSION}`, CVAR_SERVERINFO | CVAR_NOSET);
  setMaxclients(Cvar_Get("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH));

  // mirrors q2repro's sv_tick_rate (src/server/main.c ~line 2211, default
  // "40", CVAR_LATCH). Family dispatch (sv_init.ts's SV_SpawnServer, via
  // sv_game.ts's currentGameFamily()) now exists to pin legacy trees back to
  // BASE_FRAMERATE(10) regardless of this value -- see server.ts's
  // sv_tick_rate declaration for the history of why the default used to be
  // "10" instead. Latched like maxclients -- SV_InitGame reads the settled
  // value the same way it reads maxclients (Cvar_GetLatchedVars).
  setSvTickRate(Cvar_Get("sv_tick_rate", "40", CVAR_LATCH));

  hostname = Cvar_Get("hostname", "noname", CVAR_SERVERINFO | CVAR_ARCHIVE);
  timeout = Cvar_Get("timeout", "125", 0);
  zombietime = Cvar_Get("zombietime", "2", 0);
  sv_showclamp = Cvar_Get("showclamp", "0", 0);
  setSvPaused(Cvar_Get("paused", "0", 0));
  sv_timedemo = Cvar_Get("timedemo", "0", 0);
  setSvEnforcetime(Cvar_Get("sv_enforcetime", "0", 0));
  allow_download = Cvar_Get("allow_download", "1", CVAR_ARCHIVE);
  allow_download_players = Cvar_Get("allow_download_players", "0", CVAR_ARCHIVE);
  allow_download_models = Cvar_Get("allow_download_models", "1", CVAR_ARCHIVE);
  allow_download_sounds = Cvar_Get("allow_download_sounds", "1", CVAR_ARCHIVE);
  allow_download_maps = Cvar_Get("allow_download_maps", "1", CVAR_ARCHIVE);

  setSvNoreload(Cvar_Get("sv_noreload", "0", 0));

  // main.c:2227 (inside this same function): Nav_Init() only registers the
  // nav_debug/nav_debug_range cvars in q2repro, both USE_REF-gated (no
  // renderer on this headless port) -- see nav.ts's header. Called here
  // anyway so the lifecycle call graph (SV_Init -> Nav_Init) stays visible
  // and documented rather than silently dropped.
  Nav_Init();

  setSvAiraccelerate(Cvar_Get("sv_airaccelerate", "0", CVAR_LATCH));

  public_server = Cvar_Get("public", "0", 0);

  sv_reconnect_limit = Cvar_Get("sv_reconnect_limit", "3", CVAR_ARCHIVE);
  sv_downloadserver = Cvar_Get("sv_downloadserver", "", 0);

  SZ_Init(net_message, net_message_buffer, net_message_buffer.length);
}

/*
==================
SV_FinalMessage

Used by SV_Shutdown to send a final message to all
connected clients before the server goes down.  The messages are sent immediately,
not just stuck on the outgoing message list, because the server is going
to totally exit after returning from this function.
==================
*/
export function SV_FinalMessage(message: string, reconnect: boolean): void {
  SZ_Clear(net_message);
  MSG_WriteByte(net_message, SvcOpsT.svc_print);
  MSG_WriteByte(net_message, PRINT_HIGH);
  MSG_WriteString(net_message, message);

  if (reconnect) MSG_WriteByte(net_message, SvcOpsT.svc_reconnect);
  else MSG_WriteByte(net_message, SvcOpsT.svc_disconnect);

  // send it twice
  // stagger the packets to crutch operating system limited buffers
  for (const cl of svs.clients) if (cl.state >= ClientStateT.cs_connected) Netchan_Transmit(cl.netchan, net_message.cursize, net_message.data);
  for (const cl of svs.clients) if (cl.state >= ClientStateT.cs_connected) Netchan_Transmit(cl.netchan, net_message.cursize, net_message.data);
}

/*
================
SV_Shutdown

Called when each game quits,
before Sys_Quit or Sys_Error
================
*/
export function SV_Shutdown(finalmsg: string, reconnect: boolean): void {
  if (svs.clients.length) SV_FinalMessage(finalmsg, reconnect);

  Master_Shutdown();
  // SV_ShutdownGameProgs() -- sv_game.ts pending stub; always throws until
  // that unit lands. See report: SV_Shutdown cannot be exercised end-to-end
  // until then.
  SV_ShutdownGameProgs();

  // free current level (main.c:2328-2329: "CM_FreeMap(&sv.cm); Nav_Unload();"
  // right before the memset `sv.clear()` mirrors below)
  if (sv.demofile !== null) FS_FCloseFile(sv.demofile);
  Nav_Unload();
  sv.clear();
  Com_SetServerState(sv.state);

  // free server static data -- Z_Free(svs.clients)/Z_Free(svs.client_entities)
  // are omitted per PORTING.md ("Z_Malloc/Z_Free -> plain allocation");
  // nothing to free explicitly, svs.clear() drops the references.
  if (svs.demofile !== null) FS_FCloseFile(svs.demofile);
  svs.clear();
}
