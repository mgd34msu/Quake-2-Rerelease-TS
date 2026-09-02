// sv_main.c

import {
  NetsrcT,
  NetadrT,
  SysError,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_RERELEASE_CLASSIC,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_R1Q2_MINIMUM,
  PROTOCOL_VERSION_R1Q2_CURRENT,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_Q2PRO_MINIMUM,
  PROTOCOL_VERSION_Q2PRO_CURRENT,
  VERSION,
  SvcOpsT,
  MAX_MSGLEN,
  ERR_DROP,
} from "../qcommon/qcommon";
import type { ProtocolCodec } from "../qcommon/protocol/codec";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../qcommon/protocol/q2repro";
import { createR1Q2Codec } from "../qcommon/protocol/r1q2";
import { createQ2ProCodec } from "../qcommon/protocol/q2pro";
import {
  Netchan_OutOfBandPrint,
  Netchan_Setup,
  Netchan_Process,
  Netchan_Transmit,
  net_message_buffer,
  NETCHAN_OLD,
  NETCHAN_NEW,
  MAX_PACKETLEN_WRITABLE,
  MAX_PACKETLEN_WRITABLE_DEFAULT,
  MIN_PACKETLEN,
  PACKET_HEADER,
  MAX_FRAGMENT_MSGLEN,
} from "../qcommon/net_chan";
import { NET_CompareBaseAdr, NET_AdrToString, NET_IsLocalAddress, NET_GetPacket } from "../platform/net_udp";
import { MSG_BeginReading, MSG_ReadLong, MSG_ReadStringLine, MSG_WriteByte, MSG_WriteString, SZ_Init, SZ_Clear } from "../qcommon/sizebuf";
import { Cmd_TokenizeString, Cmd_Argv, Cmd_Argc, Cmd_ExecuteString } from "../qcommon/cmd";
import { Cvar_Get, Cvar_Serverinfo } from "../qcommon/cvar";
import { Com_Printf, Com_DPrintf, Com_Error, Com_BeginRedirect, Com_EndRedirect, Com_SetServerState, comTiming, dedicated, host_speeds } from "../qcommon/common";
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
  CVAR_PRIVATE,
  CVAR_ROM,
  CVAR_CHEAT,
  DF_INSTANT_ITEMS,
  type CvarT,
  MAX_MODELS,
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
import { geHolder, SV_ShutdownGameProgs, SV_RunGamePostFrameHook } from "./sv_game";
import { SV_BroadcastPrintf, SV_SendClientMessages, SV_FlushRedirect } from "./sv_send";
import { SV_ExecuteClientMessage } from "./sv_user";
import { SV_RecordDemoMessage } from "./sv_ents";
import { SV_InitOperatorCommands } from "./sv_ccmds";
import { Nav_Init, Nav_Unload, Nav_Frame } from "./nav";
import { SV_MvdRegister, SV_MvdBeginFrame, SV_MvdEndFrame } from "./sv_mvd";
import { SV_RunLocalSeatThinks } from "./sv_seats";

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
  // that: a session that demands one protocol advertises exactly that one
  // (the kex family's 1038 -- SVC_DirectConnect's own gate already accepts
  // nothing else -- or PROTOCOL_VERSION_RERELEASE_CLASSIC for a classic
  // session that had to widen its configstring space for the map); a session
  // that negotiates advertises 34/35/36 ascending, matching
  // q2proto_get_challenge_extras' qsort-ascending order, so real q2proto
  // clients can negotiate any of the three instead of falling into the same
  // broken implicit-vanilla path.
  const protocolExtras = svs.sessionProtocol !== 0
    ? `p=${svs.sessionProtocol}`
    : `p=${PROTOCOL_VERSION},${PROTOCOL_VERSION_R1Q2},${PROTOCOL_VERSION_Q2PRO}`;

  // send it back
  Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, net_from, "challenge %i %s", svs.challenges[i].challenge, protocolExtras);
}

// server/main.c:746-767's parse_packet_length. Only the three negotiating
// families (R1Q2/Q2PRO/kex-q2repro) ever call this -- vanilla's connect verb
// carries no packet_length field at all (q2proto_server.c:159's `if
// (parsed_connect->protocol >= Q2P_PROTOCOL_R1Q2)` guard), so it stays at
// MAX_PACKETLEN_WRITABLE_DEFAULT (1390) unconditionally in SVC_DirectConnect
// below. `rawToken` is the tail's first field (Cmd_Argv(5) for every
// negotiating family, per q2proto_proto_r1q2.c:55, q2proto_proto_q2pro.c:77,
// q2proto_proto_q2repro.c:54 all putting packet_length first); an empty
// string (missing/short connect string, this port's Cmd_Argv convention for
// "not present") is treated the same as an explicit 0 -- "highest available"
// -- matching q2proto_server.c:158's `packet_length_value =
// server_info->default_packet_length` fallback used when the token is
// present but empty. Returns null to signal the connection must be rejected
// ("Invalid maximum message length.", main.c:750).
function SV_ParsePacketLength(rawToken: string, isLocal: boolean): number | null {
  let maxlength = rawToken === "" ? 0 : atoi(rawToken);
  if (maxlength < 0 || maxlength > MAX_PACKETLEN_WRITABLE) return null;

  // 0 means highest available
  if (!maxlength) maxlength = MAX_PACKETLEN_WRITABLE;

  // chan.c:130's global cvar, default MAX_PACKETLEN_WRITABLE_DEFAULT (1390).
  // Looked up (not cached) so this works regardless of whether net_chan.ts's
  // Netchan_Init has run yet in this process -- Cvar_Get is idempotent by
  // name, so whichever of Netchan_Init/this call runs first wins and the
  // other just gets the same CvarT back.
  const netMaxmsglenCvar = Cvar_Get("net_maxmsglen", "1390", 0);
  const netMaxmsglen = netMaxmsglenCvar ? netMaxmsglenCvar.value : MAX_PACKETLEN_WRITABLE_DEFAULT;

  if (!isLocal && netMaxmsglen > 0) {
    // cap to server defined maximum value -- but NOT for local (loopback)
    // connections, main.c:756's `!NET_IsLocalAddress(&net_from) &&
    // net_maxmsglen->integer > 0` -- a loopback client's request is honored
    // up to MAX_PACKETLEN_WRITABLE regardless of the server's own cvar.
    if (maxlength > netMaxmsglen) maxlength = netMaxmsglen;
  }

  // don't allow too small packets
  if (maxlength < MIN_PACKETLEN) maxlength = MIN_PACKETLEN;

  return maxlength;
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
  // classic community clients. SESSION gate first (server.ts's
  // ServerStaticT.sessionProtocol doc comment has the three-value table):
  // a session that demands one specific protocol accepts only that one, with
  // no per-client variance -- the kex family (1038, matching q2repro's own
  // rejection) and a classic session that had to widen its configstring
  // space to fit the map (PROTOCOL_VERSION_RERELEASE_CLASSIC). A session
  // demanding nothing (sessionProtocol 0 -- the classic family on the classic
  // layout) accepts 34, 35 (R1Q2), or 36 (Q2PRO) and negotiates per CLIENT
  // (not per server, unlike svs.codec's own family-default role -- see
  // server.ts's ClientT.codec doc comment), because one such server can serve
  // a mix of vanilla/R1Q2/Q2PRO clients at once. That path is completely
  // untouched by the widening work: a classic map that fits the classic
  // limits negotiates exactly as it always did.
  const version = atoi(Cmd_Argv(1));
  const requiredProtocol = svs.sessionProtocol;
  const isWideSession = requiredProtocol !== 0;

  // RULE-17 FINDING (phase-8 q2repro interop): a real client speaking kex
  // (1038) or Q2PRO (36) always transmits with NETCHAN_NEW framing (single
  // conditional-byte qport, fragmentation bit) rather than this port's
  // pre-existing NETCHAN_OLD-only header -- see net_chan.ts's NETCHAN_NEW
  // doc comment for the exact wire difference and how it was confirmed
  // against the real q2repro binary (matrix cell a). Vanilla and R1Q2 stay
  // NETCHAN_OLD, matching q2repro's own client/main.c CL_CheckForResend.
  const chanType = isWideSession || version === PROTOCOL_VERSION_Q2PRO ? NETCHAN_NEW : NETCHAN_OLD;

  // main.c:756's `NET_IsLocalAddress(&net_from)` -- computed once, read by
  // SV_ParsePacketLength for every negotiating family below.
  const isLocalAdr = NET_IsLocalAddress(adr);

  let negotiatedCodec: ProtocolCodec;
  let negotiatedMinorVersion = 0;
  let negotiatedCompress = false;
  // Vanilla (34) has no packet_length field to negotiate (q2proto_server.c:159
  // gates the token read on `protocol >= Q2P_PROTOCOL_R1Q2`), so it always
  // gets the plain default -- same value every family got before this unit,
  // and the only value vanilla can ever get.
  let negotiatedPacketLength: number = MAX_PACKETLEN_WRITABLE_DEFAULT;

  if (isWideSession) {
    if (version !== requiredProtocol) {
      // Refuse clearly rather than corrupt. A widened classic session is the
      // interesting case: the client asked for a protocol whose model/sound/
      // image index fields are too narrow to carry this map at all (protocol
      // 34 sends modelindex as a single byte), so there is no degraded mode
      // to fall back to -- say why, in the one line the out-of-band print
      // gives us, instead of letting the client connect and then read
      // truncated indices.
      if (requiredProtocol === PROTOCOL_VERSION_RERELEASE_CLASSIC) {
        Netchan_OutOfBandPrint(
          NetsrcT.NS_SERVER,
          adr,
          "print\nThis map needs more than %i models/sounds/images, so the server is running protocol %i. Your client speaks protocol %i, whose indices are too narrow to carry it.\n",
          MAX_MODELS,
          requiredProtocol,
          version,
        );
      } else {
        Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nServer is version %4.2f.\n", VERSION);
      }
      Com_DPrintf("    rejected connect from version %i (session requires %i)\n", version, requiredProtocol);
      return;
    }
    // Same wire format either way; the codec differs only in the protocol
    // number it announces in svc_serverdata (q2repro.ts's
    // Q2REPRO_CLASSIC_CODEC).
    negotiatedCodec = svs.codec;
    // Connect-string tail (q2proto_q2repro_connect_tail): "<packet_length>
    // <has_zlib>" after the four standard fields (Cmd_Argv(5)/(6)).
    // has_zlib (Cmd_Argv(6)) IS now parsed (q2proto_q2repro_parse_connect:
    // `parsed_connect->has_zlib = q2pstol(&zlib_token, 10) != 0`) instead of
    // silently skipped -- but deliberately NOT wired into negotiatedCompress/
    // ClientT.netchan.compress the way R1Q2/Q2PRO's has_zlib is below: the
    // real q2repro server gates this on its OWN opcode, svc_q2repro_zpacket
    // (q2proto_proto_q2repro.c:1357 `enable_deflate = connect_info->has_zlib`,
    // then `context->zpacket_cmd = svc_q2repro_zpacket`), a distinct byte
    // value from the shared svc_r1q2_zpacket/SVC_ZPACKET(21) this port's
    // qcommon/protocol/zpacket.ts implements for the R1Q2/Q2PRO families
    // only. Flipping netchan.compress true here with no svc_q2repro_zpacket
    // write-side would make net_chan.ts's Netchan_Transmit choke point wrap
    // large kex-family reliable bursts in the WRONG opcode for a real
    // q2repro client to decode -- worse than never compressing at all. So a
    // client requesting has_zlib=1 gets an honest diagnostic that this
    // server will not compress its traffic (both values now genuinely read
    // and acted on -- "acted on" meaning "correctly never engages
    // compression for this family", not "ignored").
    const kexHasZlib = atoi(Cmd_Argv(6)) !== 0;
    if (kexHasZlib) {
      Com_DPrintf("    kex-family connect requested has_zlib=1; svc_q2repro_zpacket is not implemented, traffic will not be compressed\n");
    }
    const packetLength = SV_ParsePacketLength(Cmd_Argv(5), isLocalAdr);
    if (packetLength === null) {
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nInvalid maximum message length.\n");
      Com_DPrintf("    rejected connect from invalid packet_length\n");
      return;
    }
    negotiatedPacketLength = packetLength;
  } else if (version === PROTOCOL_VERSION) {
    negotiatedCodec = VANILLA_CODEC;
  } else if (version === PROTOCOL_VERSION_R1Q2) {
    // Connect-string tail (q2proto_r1q2_connect_tail): "<packet_length>
    // <minor version>" after the four standard fields (Cmd_Argv(5)/(6)).
    const packetLength = SV_ParsePacketLength(Cmd_Argv(5), isLocalAdr);
    if (packetLength === null) {
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nInvalid maximum message length.\n");
      Com_DPrintf("    rejected connect from invalid packet_length\n");
      return;
    }
    negotiatedPacketLength = packetLength;
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
    // netchan_type (Cmd_Argv(6)) is read-and-ignored -- this port only ever
    // runs the classic netchan framing (requesting NETCHAN_OLD is the honest
    // ask, but this server does not actually branch on what the client
    // requested here, matching the client-side symmetric scope cut
    // documented in cl_main.ts's CL_SendConnectPacket). packet_length
    // (Cmd_Argv(5)) IS now parsed -- that field's negotiation is this unit's
    // whole point and applies uniformly across families, unlike netchan_type.
    const packetLength = SV_ParsePacketLength(Cmd_Argv(5), isLocalAdr);
    if (packetLength === null) {
      Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, adr, "print\nInvalid maximum message length.\n");
      Com_DPrintf("    rejected connect from invalid packet_length\n");
      return;
    }
    negotiatedPacketLength = packetLength;
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

  // `version` (the negotiated major protocol) is load-bearing, not
  // decorative: it is what selects the qport field's WIDTH for NETCHAN_OLD
  // connections, and R1Q2/35 is NETCHAN_OLD with a one-byte qport -- see
  // net_chan.ts's NETCHAN_NEW doc comment for the live capture that proved
  // it, and why protocol 35 never spawned before this was threaded through.
  // `negotiatedPacketLength` is this unit's own addition: the per-connection
  // maxpacketlen this SVC_DirectConnect call just negotiated above (chan.c's
  // own Netchan_Setup signature takes this exact `maxpacketlen` parameter,
  // chan.h:79).
  Netchan_Setup(NetsrcT.NS_SERVER, newcl.netchan, adr, qport, chanType, version, negotiatedPacketLength);
  // svc_zpacket eligibility for this connection (qcommon/protocol/
  // zpacket.ts) -- set after Netchan_Setup since that call replaces
  // newcl.netchan wholesale via Netchan_Setup's own chan mutation (not a
  // fresh object), but newcl.clear() above DOES replace it with a fresh
  // NetchanT (compress defaults false), so this must run after clear().
  newcl.netchan.compress = negotiatedCompress;

  newcl.state = ClientStateT.cs_connected;

  // client.datagram is this port's stand-in for q2pro's per-client
  // msg_unreliable_list (q2repro's server.h dropped the flat per-client
  // datagram buffer in favor of a linked message list -- sv_send.ts's own
  // doc comments already track that divergence), so it has no reference
  // field to copy a size formula from directly. It is sized the same way
  // sv_send.ts's SV_SendClientDatagram sizes its per-call `msg` scratch
  // buffer, and for the same reason, so the two limits agree:
  //
  //   - NETCHAN_OLD (vanilla/34, R1Q2/35): one datagram is all this channel
  //     can ever send, so the accumulated unreliable payload is capped at
  //     the negotiated packet length + the packet header. Unchanged.
  //   - NETCHAN_NEW (Q2PRO/36, kex/1038, engine-local 4038): the frame is
  //     allowed to grow past one datagram because Netchan_Transmit splits it
  //     into fragments the receiver reassembles (chan.c:475-487), so the cap
  //     is the fragment-message capacity (q2pro's MAX_MSGLEN, 0x8000 --
  //     net_chan.ts's MAX_FRAGMENT_MSGLEN) exactly as write_datagram_new
  //     bounds its own unreliable payload by msg_write.maxsize rather than
  //     by netchan.maxpacketlen.
  //
  // Without the NETCHAN_NEW arm, Call of the Machine's mgu5m1/mgu5m2 filled
  // this buffer mid-frame ("WARNING: datagram overflowed for %s") or blew
  // out SV_SendClientDatagram's msg one layer up, and the client never got a
  // complete frame -- a black screen, with the fragmentation path below
  // unreachable.
  const requiredDatagramCapacity = chanType === NETCHAN_NEW ? MAX_FRAGMENT_MSGLEN : negotiatedPacketLength + PACKET_HEADER;
  if (newcl.datagram_buf.length < requiredDatagramCapacity) {
    newcl.datagram_buf = new Uint8Array(requiredDatagramCapacity);
  }
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
    // depends on the matched client's own connection (a single conditional
    // byte under NETCHAN_NEW, and under NETCHAN_OLD from R1Q2/35 up; an
    // unconditional 16-bit short only below R1Q2 -- see net_chan.ts's
    // NETCHAN_NEW doc comment), so it cannot be read generically before
    // knowing which client a packet belongs to. This matches by BASE ADDRESS
    // first and peeks the qport bytes per-candidate, mirroring q2repro's own
    // real dispatcher (src/server/main.c's SV_PacketEvent, lines 1467-1487:
    // address match, then `if (netchan->qport) { qport = msg_read.data[8];
    // ... }`). q2repro can peek a bare data[8] there because its own server
    // accepts protocol 1038 and nothing else (main.c's parse_basic_params
    // rejects every other version outright), so the one-byte form is the
    // only one it can ever see; this server really does serve 34/35/36/1038
    // side by side, so the width has to be derived per client.
    const d2 = net_message.data;

    // check for packets from connected clients
    for (let i = 0; i < maxc; i++) {
      const cl = svs.clients[i];
      if (cl.state === ClientStateT.cs_free) continue;
      if (!NET_CompareBaseAdr(net_from, cl.netchan.remote_address)) continue;

      if (cl.netchan.qport) {
        const oneByteQport = cl.netchan.type === NETCHAN_NEW || cl.netchan.protocol >= PROTOCOL_VERSION_R1Q2;
        const qportSize = oneByteQport ? 1 : 2;
        if (net_message.cursize < 8 + qportSize) continue;
        const qport = oneByteQport ? d2[8] : d2[8] | (d2[9] << 8);
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
    SV_RunGamePostFrameHook();

    // never get more than one tic behind
    if (sv.time < svs.realtime) {
      if (sv_showclamp && sv_showclamp.value) Com_Printf("sv highclamp\n");
      svs.realtime = sv.time;
    }
  }

  if (host_speeds && host_speeds.value) comTiming.time_after_game = Sys_Milliseconds();

  // main.c:1736-1744, verbatim in intent: the game module writes message
  // bytes through gi.WriteByte/WriteString/... into the shared multicast
  // buffer (sv.multicast here, msg_write there) and is expected to flush
  // them with a multicast/unicast before returning. The re-release game does
  // NOT always do that -- G_ReportMatchDetails (kexgame/p_hud.ts) writes a
  // whole scoreboard and then hands it to gi.ReportMatchDetails_Multicast,
  // a console-platform hook with no wire form. If those bytes survive the
  // frame they prepend the NEXT multicast and the receiving client parses
  // garbage. The binding clears the buffer itself (bindings/kex.ts's
  // ReportMatchDetails_Multicast, matching q2repro's PF_ReportMatchDetails_
  // Multicast at server/game.c:892-899); this is the reference's own
  // second line of defence for every other game module that might leak.
  if (sv.multicast.overflowed) Com_Error(ERR_DROP, "SV_RunGameFrame: message buffer overflowed");
  if (sv.multicast.cursize) {
    Com_Printf("WARNING: Game left %i bytes in multicast buffer, cleared.\n", sv.multicast.cursize);
    SZ_Clear(sv.multicast);
  }
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

  // LOCAL SPLITSCREEN (sv_seats.ts): the extra local seats' moves. Placed
  // here, immediately after the point where a real client's move is executed
  // (SV_ReadPackets -> SV_ExecuteClientMessage -> SV_ClientThink), so a
  // seat's think is inside the same frame that flushes whatever the game
  // wrote during it -- see SV_RunLocalSeatThinks. No-op with no seats.
  SV_RunLocalSeatThinks();

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
  SV_RecordDemoMessage(); // sv_ents.ts is a real implementation now (no longer a throwing stub)

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

  // common.c:956 -- CVAR_PRIVATE (this fixes the sv-side registration only;
  // client-side rcon_password in cl_main.ts is handled by a different unit).
  rcon_password = Cvar_Get("rcon_password", "", CVAR_PRIVATE);
  // q2repro src/server/main.c:2108 flags skill CVAR_LATCH (cvar-parity fix).
  Cvar_Get("skill", "1", CVAR_LATCH);
  // q2repro src/server/main.c:2109 flags deathmatch CVAR_SERVERINFO too
  // (cvar-parity fix).
  Cvar_Get("deathmatch", "0", CVAR_LATCH | CVAR_SERVERINFO);
  Cvar_Get("coop", "0", CVAR_LATCH);
  Cvar_Get("dmflags", `${DF_INSTANT_ITEMS}`, CVAR_SERVERINFO);
  Cvar_Get("fraglimit", "0", CVAR_SERVERINFO);
  Cvar_Get("timelimit", "0", CVAR_SERVERINFO);
  Cvar_Get("cheats", "0", CVAR_SERVERINFO | CVAR_LATCH);
  // main.c:2106 -- CVAR_ROM (was CVAR_NOSET; ROM now exists in q_shared.ts).
  Cvar_Get("protocol", `${PROTOCOL_VERSION}`, CVAR_SERVERINFO | CVAR_ROM);
  // main.c:2116 -- C default is "8", not "1".
  setMaxclients(Cvar_Get("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH));

  // main.c:2117
  Cvar_Get("sv_reserved_slots", "0", CVAR_LATCH);

  // mirrors q2repro's sv_tick_rate (src/server/main.c ~line 2211, default
  // "40", CVAR_LATCH). Family dispatch (sv_init.ts's SV_SpawnServer, via
  // sv_game.ts's currentGameFamily()) now exists to pin legacy trees back to
  // BASE_FRAMERATE(10) regardless of this value -- see server.ts's
  // sv_tick_rate declaration for the history of why the default used to be
  // "10" instead. Latched like maxclients -- SV_InitGame reads the settled
  // value the same way it reads maxclients (Cvar_GetLatchedVars).
  setSvTickRate(Cvar_Get("sv_tick_rate", "40", CVAR_LATCH));

  hostname = Cvar_Get("hostname", "noname", CVAR_SERVERINFO | CVAR_ARCHIVE);
  // main.c:2122 -- C default is "90", not "125".
  timeout = Cvar_Get("timeout", "90", 0);
  zombietime = Cvar_Get("zombietime", "2", 0);
  // main.c:2128
  Cvar_Get("sv_ghostime", "6", 0);
  // main.c:2131
  Cvar_Get("sv_idlekick", "0", 0);
  sv_showclamp = Cvar_Get("showclamp", "0", 0);
  setSvPaused(Cvar_Get("paused", "0", 0));
  // q2repro src/common/common.c:933 flags timedemo CVAR_CHEAT (cvar-parity
  // fix; cl_main.ts's own "timedemo" registration is fixed alongside this).
  sv_timedemo = Cvar_Get("timedemo", "0", CVAR_CHEAT);
  // main.c:2134 -- C default is "1", not "0".
  setSvEnforcetime(Cvar_Get("sv_enforcetime", "1", 0));
  // main.c:2135, :2138, :2139, :2140
  Cvar_Get("sv_timescale_time", "16", 0);
  Cvar_Get("sv_timescale_warn", "0", 0);
  Cvar_Get("sv_timescale_kick", "0", 0);
  Cvar_Get("sv_allow_nodelta", "1", 0);
  // main.c:2141, :2142, :2143
  Cvar_Get("sv_fps", "40", CVAR_LATCH);
  Cvar_Get("sv_force_reconnect", "", CVAR_LATCH);
  Cvar_Get("sv_show_name_changes", "0", 0);
  // main.c:2146
  Cvar_Get("sv_qwmod", "0", CVAR_LATCH);
  allow_download = Cvar_Get("allow_download", "1", CVAR_ARCHIVE);
  // common.c:948 -- C default is "1", not "0".
  allow_download_players = Cvar_Get("allow_download_players", "1", CVAR_ARCHIVE);
  allow_download_models = Cvar_Get("allow_download_models", "1", CVAR_ARCHIVE);
  allow_download_sounds = Cvar_Get("allow_download_sounds", "1", CVAR_ARCHIVE);
  allow_download_maps = Cvar_Get("allow_download_maps", "1", CVAR_ARCHIVE);
  // main.c:2148, :2149, :2150, :2151
  Cvar_Get("sv_password", "", CVAR_PRIVATE);
  Cvar_Get("sv_reserved_password", "", CVAR_PRIVATE);
  Cvar_Get("sv_locked", "0", 0);
  Cvar_Get("sv_novis", "0", 0);
  // main.c:2153
  Cvar_Get("sv_redirect_address", "", 0);
  // chan.c:130 -- the SAME global cvar net_chan.ts's Netchan_Init and
  // cl_main.ts's CL_InitLocal register (idempotent by name; whichever call
  // runs first wins). Registered here too so it shows up under `cvarlist`
  // on a dedicated server that never runs client Init. SV_ParsePacketLength
  // (this file) reads it directly rather than caching it, so this
  // registration is not load-bearing for correctness -- only for listing.
  Cvar_Get("net_maxmsglen", "1390", 0);
  // main.c:2156, :2157 -- USE_DEBUG-gated upstream; registered unconditionally
  // here (this port has no separate debug/release build split for cvars).
  Cvar_Get("sv_debug", "0", 0);
  Cvar_Get("sv_pad_packets", "0", 0);
  // main.c:2159, :2160, :2161
  Cvar_Get("sv_lan_force_rate", "0", CVAR_LATCH);
  Cvar_Get("sv_min_rate", "15000", CVAR_LATCH);
  Cvar_Get("sv_max_rate", "60000", CVAR_LATCH);
  // main.c:2164, :2165, :2166, :2167, :2168, :2169
  Cvar_Get("sv_calcpings_method", "2", 0);
  Cvar_Get("sv_changemapcmd", "", 0);
  Cvar_Get("sv_max_download_size", "8388608", 0);
  Cvar_Get("sv_max_packet_entities", "0", 0);
  Cvar_Get("sv_trunc_packet_entities", "1", 0);
  Cvar_Get("sv_prioritize_entities", "0", 0);
  // main.c:2171, :2172
  Cvar_Get("sv_strafejump_hack", "1", CVAR_LATCH);
  Cvar_Get("sv_waterjump_hack", "1", CVAR_LATCH);
  // main.c:2175 -- USE_PACKETDUP-gated upstream; registered unconditionally.
  Cvar_Get("sv_packetdup_hack", "0", 0);
  // main.c:2178 -- C default is `COM_DEDICATED ? "0" : "1"`, and
  // COM_DEDICATED itself is `dedicated->integer != 0` on this port's
  // USE_CLIENT build (inc/common/common.h:116-120 -- the non-DEDICATED_ONLY
  // branch, which is the branch this port takes per main.ts's header
  // comment). Mirrored as a runtime read of the same `dedicated` cvar rather
  // than a hardcoded default.
  Cvar_Get("sv_allow_map", dedicated && dedicated.value !== 0 ? "0" : "1", 0);
  // main.c:2179
  Cvar_Get("sv_cinematics", "1", 0);
  // main.c:2182 -- USE_SERVER-gated upstream; registered unconditionally.
  Cvar_Get("sv_recycle", "0", 0);
  // main.c:2185, :2187, :2189, :2191, :2194
  Cvar_Get("sv_enhanced_setplayer", "0", 0);
  Cvar_Get("sv_iplimit", "3", 0);
  Cvar_Get("sv_status_show", "2", 0);
  Cvar_Get("sv_status_limit", "15", 0);
  Cvar_Get("sv_uptime", "0", 0);
  // main.c:2196, :2199, :2202, :2205, :2207
  Cvar_Get("sv_auth_limit", "1", 0);
  Cvar_Get("sv_rcon_limit", "1", 0);
  Cvar_Get("sv_namechange_limit", "5/min", 0);
  Cvar_Get("sv_allow_unconnected_cmds", "0", 0);
  Cvar_Get("lrcon_password", "", CVAR_PRIVATE);
  // main.c:2209 -- SV_FEATURES (server.h:93-97) is a compile-time bitmask of
  // GMF_CLIENTNUM|GMF_PROPERINUSE|GMF_MVDSPEC|GMF_WANT_ALL_DISCONNECTS|
  // GMF_ENHANCED_SAVEGAMES|SV_GMF_VARIABLE_FPS|GMF_EXTRA_USERINFO|
  // GMF_IPV6_ADDRESS_AWARE|GMF_ALLOW_INDEX_OVERFLOW|GMF_PROTOCOL_EXTENSIONS --
  // each bit asserts a specific engine-side contract (e.g. "edict_s.inuse is
  // maintained correctly", "PF_FindIndex overflow returns 0") that this port
  // has not audited bit-by-bit. Registered, consumer unported: default "0"
  // rather than guessing a bitmask this port hasn't verified it actually
  // satisfies.
  Cvar_Get("sv_features", "0", CVAR_ROM);
  // main.c:2213 -- mirrors whichever game module is loaded reporting its own
  // supported-features bitmask (mvd/game.c:1767's `Cvar_Set("g_features",
  // va("%d", MVD_FEATURES))` is one real q2repro caller). This port's gi/ge
  // interface (kexapi/game.ts, server/bindings/kex.ts and legacy.ts) has no
  // feature-flags negotiation surface to read from -- searched for GMF_/
  // feature-flag handling and found none. Registered, consumer unported.
  Cvar_Get("g_features", "0", CVAR_ROM);

  // ac.c:1721-1737 (AC_Register) -- the r1ch.net anti-cheat client-
  // verification subsystem (external anticheat-server queries, client binary
  // validation, kick/ban on violations) is entirely unported in this port
  // (no src/server/ac.ts exists). All 10 cvars below are registered only, so
  // setting them at the console does not fail as "unknown command"; none of
  // them have a consumer.
  Cvar_Get("sv_anticheat_required", "0", CVAR_LATCH); // ac.c:1723
  Cvar_Get("sv_anticheat_server_address", "anticheat.r1ch.net", CVAR_LATCH); // ac.c:1724
  Cvar_Get("sv_anticheat_error_action", "0", 0); // ac.c:1725
  Cvar_Get(
    "sv_anticheat_message",
    "This server requires the r1ch.net anticheat module. Please see http://antiche.at/ for more details.",
    0,
  ); // ac.c:1726-1728
  Cvar_Get("sv_anticheat_badfile_action", "0", 0); // ac.c:1729
  Cvar_Get("sv_anticheat_badfile_message", "", 0); // ac.c:1730
  Cvar_Get("sv_anticheat_badfile_max", "0", 0); // ac.c:1731
  Cvar_Get("sv_anticheat_show_violation_reason", "0", 0); // ac.c:1732
  Cvar_Get("sv_anticheat_client_disconnect_action", "0", 0); // ac.c:1733
  Cvar_Get("sv_anticheat_disable_play", "0", 0); // ac.c:1734

  setSvNoreload(Cvar_Get("sv_noreload", "0", 0));

  // main.c:2227 (inside this same function): Nav_Init() only registers the
  // nav_debug/nav_debug_range cvars in q2repro, both USE_REF-gated (no
  // renderer on this headless port) -- see nav.ts's header. Called here
  // anyway so the lifecycle call graph (SV_Init -> Nav_Init) stays visible
  // and documented rather than silently dropped.
  Nav_Init();

  setSvAiraccelerate(Cvar_Get("sv_airaccelerate", "0", CVAR_LATCH));

  // main.c:2147 -- CVAR_LATCH was missing.
  public_server = Cvar_Get("public", "0", CVAR_LATCH);

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
  // sv_game.ts's SV_ShutdownGameProgs is a real implementation now (no
  // longer a throwing stub); SV_Shutdown can be exercised end-to-end.
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
