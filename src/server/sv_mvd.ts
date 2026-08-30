// server/mvd.c -- "GTV server and local MVD recorder": a dummy observer that
// watches every connected player's state and every active entity each
// server frame, and either writes that stream to a local .mvd2 file
// (mvdrecord/mvdstop) or streams it live to connected GTV clients.
//
// SOURCES (GPLv2, q2repro): src/server/mvd.c (player_is_active/
// entity_is_active/build_gamestate/emit_gamestate/emit_frame/rec_start/
// rec_write/rec_frame/rec_stop/SV_MvdRecord_f/SV_MvdStop_f/
// SV_MvdBeginFrame/SV_MvdEndFrame/accept_client/parse_hello/
// parse_stream_start/parse_stream_stop/write_message/SV_MvdRunClients),
// inc/common/protocol.h + inc/server/mvd/protocol.h (wire constants, ported
// to qcommon/protocol/mvd.ts).
//
// SCOPE (see qcommon/protocol/mvd.ts's header for the legacy-vs-kex family
// split, cited again at SV_MvdRecord_f below). Updated for the MVD
// completion sweep (.orch/followups.md's "MVD COMPLETION" entry) -- items
// 1/2/3/4 below are now ported; remaining gaps are called out per item:
//
//   1. SV_MvdMulticast/SV_MvdUnicast/SV_MvdStartSound (below) are wired into
//      SV_Multicast (sv_send.ts), PF_Unicast (sv_game.ts), and SV_StartSound
//      (sv_send.ts) respectively, buffering into mvd.message (reliable) /
//      mvd.datagram (unreliable) and flushed once per frame by
//      SV_MvdEndFrame alongside the frame delta -- see MvdRecorderStateT's
//      own comment and each hook's doc comment for the exact mvd.c
//      citations. SV_MvdConfigstring is NOT wired (not named in the task
//      brief for this sweep; its call site would be a PF_Configstring-style
//      wrapper this port does not have a dedicated hook point for).
//   2. MVD DUMMY CLIENT: dummyCreate/dummyRun/dummyDestroy below drive a
//      real synthetic client through GameExports.ClientConnect/ClientBegin/
//      ClientThink/ClientDisconnect, gated by the `sv_mvd_spawn_dummy` cvar
//      (default "1", matching mvd.c's own default) and by the game module
//      actually accepting the connect -- see dummyCreate's own comment for
//      the full mvd.c citations and the one deliberate scope trim (no
//      console-command-forwarding path; this unit has no live spectator
//      networking to forward those commands over regardless).
//   3. GTV HARDENING: password auth (authGtvClient/handleGtvHello, gated by
//      `sv_mvd_password`), a connection-count cap (`sv_mvd_maxclients`,
//      checked in SV_MvdRunGtv's accept loop), and GTF_DEFLATE compression
//      (via Bun's built-in zlib bindings, one independent raw-deflate block
//      per GTS_STREAM_DATA message rather than the C's single continuous
//      per-connection zlib stream -- see writeGtvMessage's own comment for
//      why) are all now ported. NOT ported: IP whitelist/blacklist
//      (gtv_white_list/gtv_black_list) and the per-source-IP connection
//      limit (sv_iplimit) -- general-purpose mechanisms outside "the auth
//      handshake (password)" this sweep's brief actually asked for, and
//      net_tcp.ts's connection object does not expose a peer address today.
//   4. KEX/RERELEASE FAMILY: SV_MvdRecord_f no longer refuses under
//      `currentGameFamily() === "kex"`. Player-state deltas switch to
//      MSG_WriteDeltaMvdPlayerstateRerelease/MSG_ReadDeltaMvdPlayerstateRerelease
//      (qcommon/protocol/mvd.ts) whenever a recording starts under kex,
//      emitting PROTOCOL_VERSION_MVD_RERELEASE(3038) instead of
//      PROTOCOL_VERSION_MVD_DEFAULT. Entity deltas still go through
//      VANILLA_CODEC regardless of family (the task brief's field list names
//      player-state fields only; rerelease entity-delta extensions --
//      MSG_ES_LONGSOLID/SHORTANGLES/EXTENSIONS -- are a separate, larger,
//      not-requested unit). See qcommon/protocol/mvd.ts's header for the
//      exact field-by-field citations and the stats-widening truncation gap
//      (PlayerStateT.stats is still MAX_STATS=32, a pre-existing tracked gap
//      outside this file's scope).

import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteString } from "../qcommon/sizebuf";
import { FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile } from "../qcommon/files";
import { FS_Gamedir } from "../qcommon/files";
import { Cmd_Argc, Cmd_Argv, Cmd_AddCommand } from "../qcommon/cmd";
import { Com_Printf } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import { CM_WritePortalBits } from "../qcommon/cmodel";
import { SvcOpsT } from "../qcommon/qcommon";
import {
  MVD_MAGIC,
  mvd_serverdata,
  mvd_frame,
  mvd_unicast,
  mvd_unicast_r,
  mvd_multicast_all,
  mvd_multicast_all_r,
  mvd_sound,
  mvd_print,
  PROTOCOL_VERSION_MVD,
  PROTOCOL_VERSION_MVD_DEFAULT,
  PROTOCOL_VERSION_MVD_RERELEASE,
  CLIENTNUM_NONE,
  MSG_WriteDeltaMvdPlayerstate,
  MSG_WriteDeltaMvdPlayerstateRerelease,
  MSG_WriteMvdPlayersEnd,
  MSG_WriteMvdCmd,
} from "../qcommon/protocol/mvd";
import { EntityStateT, PlayerStateT, PmTypeT, PMF_NO_PREDICTION, MAX_EDICTS, MAX_CLIENTS, MulticastT, CHAN_NO_PHS_ADD, CHAN_RELIABLE, UsercmdT } from "../shared/q_shared";
import { clonePlayerState, cloneEntityStateInto } from "../shared/state_copy";
import { sv, svs, maxclients, ClientT, ClientStateT, ServerStateT } from "./server";
import { geHolder, currentGameFamily } from "./sv_game";
import { SVF_NOCLIENT, type Edict } from "../game/game";
import { TCP_Listen, TCP_Accept, TCP_Read, TCP_Write, TCP_Close, TCP_IsClosed, TCP_StopListening } from "../platform/net_tcp";
import { GtvServerOpT, GtvClientOpT, GTV_PROTOCOL_VERSION, GTF_DEFLATE } from "../qcommon/protocol/mvd";
// SND_* flag bits: defined in sv_send.ts (this module's own hook target),
// re-imported here for SV_MvdStartSound's flags parameter. sv_send.ts
// imports SV_MvdBroadcastPrint from this module already, so this is an
// existing two-way module relationship, not a new cycle risk -- both sides
// only touch the other's exports from inside function bodies, never at
// module-init time.
import { SND_VOLUME, SND_ATTENUATION, SND_OFFSET } from "./sv_send";

const NULL_ENTITY_STATE = new EntityStateT();

// Backing size for mvd.message/mvd.datagram (see MvdRecorderStateT below) and
// for the combined per-frame stream buffer SV_MvdEndFrame builds from them --
// generous relative to mvd.c's own MAX_MSGLEN-bound buffers since this port's
// hooks have no per-call 2048-byte cap enforcement gap to worry about (see
// SV_MvdMulticast/SV_MvdUnicast below, which DO enforce mvd.c's own
// 2048-byte-per-call overflow guard on top of this).
const MAX_MVD_MESSAGE_SIZE = 65536;

// ---------------------------------------------------------------------------
// recording / delta-compressor state
// ---------------------------------------------------------------------------

interface MvdRecorderStateT {
  active: boolean; // at least one consumer (file or GTV client) wants frames
  recording: number | null; // FS handle, or null when not writing to a file
  players: Array<PlayerStateT | null>;
  entities: Array<EntityStateT | null>;
  numframes: number;
  rerelease: boolean; // recording started under game=kex -- see mvdEnable()
  // mvd.message / mvd.datagram (mvd.c's own names): reliable and unreliable
  // out-of-band buffers the SV_Mvd{Multicast,Unicast,StartSound} hooks below
  // accumulate into over the course of one server frame. Flushed together
  // with the frame delta (emitFrameInto's output) by SV_MvdEndFrame, exactly
  // once per frame, matching mvd.c:1000-1071's SV_MvdEndFrame ordering
  // (message, then msg_write/the frame body, then datagram).
  message: SizeBuf;
  datagram: SizeBuf;
}

const mvd: MvdRecorderStateT = {
  active: false,
  recording: null,
  players: new Array(MAX_CLIENTS).fill(null),
  entities: new Array(MAX_EDICTS).fill(null),
  numframes: 0,
  rerelease: false,
  message: new SizeBuf(),
  datagram: new SizeBuf(),
};
SZ_Init(mvd.message, new Uint8Array(MAX_MVD_MESSAGE_SIZE), MAX_MVD_MESSAGE_SIZE);
SZ_Init(mvd.datagram, new Uint8Array(MAX_MVD_MESSAGE_SIZE), MAX_MVD_MESSAGE_SIZE);

// ---------------------------------------------------------------------------
// dummy MVD client (mvd.c's "DUMMY MVD CLIENT" section) -- a fake, server-
// side-only spectator client driven directly through the game module's
// ClientConnect/ClientBegin/ClientThink/ClientDisconnect exports, exactly
// like a real connecting client. Fixes the gap this file's header used to
// document under scope note 1: without it, `playerIsActive`'s "always
// capture dummy" special case has nothing to special-case, and any map with
// zero real players (e.g. warm-up, or a GTV relay watching an empty server)
// records/streams NOTHING -- no baseline, no frames, nothing for a GTV
// client's PVS-dependent capture to observe at all.
//
// SCOPE: this ports dummy_create/dummy_spawn/dummy_run's CORE client-
// lifecycle drive (connect, begin, per-frame think so the game module never
// times it out) and player_is_active's special case. NOT ported: the
// console-command forwarding path (dummy_forward_f/dummy_exec_string/
// dummy_buffer's cbuf, mvd.c:141-268) that lets operators run
// mvdstuff/scoreboard commands "through" the dummy, and sv_mvd_begincmd's
// auto-exec-on-spawn hook -- both are real-networking/console conveniences,
// not part of what makes the RECORDING itself complete, and this port's MVD
// unit has no live spectator networking to forward those commands over
// regardless (see client.ts's own header).
interface MvdDummyStateT {
  clientIndex: number | null;
  edict: Edict | null;
}

const mvdDummy: MvdDummyStateT = { clientIndex: null, edict: null };

function svMvdSpawnDummyCvar(): number {
  const v = Cvar_Get("sv_mvd_spawn_dummy", "1", 0);
  return v ? v.value : 0;
}

// Ported cvars for GTV hardening (item 5): password-gated auth and a bound
// on the number of simultaneously connected GTV clients. See
// handleGtvHello/SV_MvdRunGtv below for where these are consulted.
function svMvdPasswordCvar(): string {
  const v = Cvar_Get("sv_mvd_password", "", 0);
  return v ? v.string : "";
}

function svMvdMaxClientsCvar(): number {
  const v = Cvar_Get("sv_mvd_maxclients", "8", 0);
  const n = v ? v.value : 8;
  return Math.max(1, Math.min(MAX_CLIENTS, Math.trunc(n) || 8));
}

// mvd.c:2461's real default ("1" -- always attempt unless the game module
// declines the connect). A dedicated free client slot is required, so this
// harmlessly no-ops (matching dummy_create's own "no slot"/"rejected by
// game" graceful-failure paths, mvd.c:400-409/905-909) on a full server or
// against a game module that rejects the connect.
function findFreeClientSlot(): number | null {
  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl || cl.state === ClientStateT.cs_free) return i;
  }
  return null;
}

const MVD_DUMMY_USERINFO = '\\name\\[MVDSPEC]\\skin\\male/grunt\\spectator\\1\\mvdspec\\1';

// mvd.c:347-409 (dummy_create) + mvd.c:296-314 (dummy_spawn), collapsed into
// one function since this port's GameExports.ClientConnect is synchronous
// and has no separate "reject with rejmsg" side channel worth threading
// through two steps.
function dummyCreate(): void {
  if (mvdDummy.clientIndex !== null) return; // already created
  if (svMvdSpawnDummyCvar() <= 0) return;

  const ge = geHolder.ge;
  if (!ge) return;

  const slot = findFreeClientSlot();
  if (slot === null) {
    Com_Printf("No slot for dummy MVD client\n");
    return;
  }

  const edict = ge.edicts[slot + 1];
  if (!edict) return;

  const result = ge.ClientConnect(edict, MVD_DUMMY_USERINFO);
  if (!result.allowed) {
    Com_Printf("Dummy MVD client rejected by game\n");
    return;
  }

  const cl = new ClientT();
  cl.state = ClientStateT.cs_connected;
  cl.edict = edict;
  cl.name = "[MVDSPEC]";
  cl.userinfo = result.userinfo;
  svs.clients[slot] = cl;

  ge.ClientBegin(edict);
  cl.state = ClientStateT.cs_spawned;

  mvdDummy.clientIndex = slot;
  mvdDummy.edict = edict;
}

// mvd.c's dummy_run: called once per server frame (from SV_MvdEndFrame,
// mirroring mvd.c:1016) so the game module never times the dummy out the way
// it would a client that stopped sending commands.
function dummyRun(): void {
  if (mvdDummy.clientIndex === null || !mvdDummy.edict) return;
  const ge = geHolder.ge;
  if (!ge) return;
  const cmd = new UsercmdT();
  ge.ClientThink(mvdDummy.edict, cmd);
}

// mvd.c's mvd_disable's dummy teardown (mvc.c:2170-2172, `SV_RemoveClient`).
function dummyDestroy(): void {
  if (mvdDummy.clientIndex === null) return;
  const ge = geHolder.ge;
  const edict = mvdDummy.edict;
  const slot = mvdDummy.clientIndex;
  mvdDummy.clientIndex = null;
  mvdDummy.edict = null;
  if (ge && edict) ge.ClientDisconnect(edict);
  const cl = svs.clients[slot];
  if (cl) cl.state = ClientStateT.cs_free;
}

interface EdictClientPs {
  ps: PlayerStateT;
}
function hasPlayerState(client: unknown): client is EdictClientPs {
  if (typeof client !== "object" || client === null) return false;
  if (!("ps" in client)) return false;
  return client.ps instanceof PlayerStateT;
}

// mvd.c:480-551, minus the "always capture dummy" special case (no dummy --
// see this file's header) and the GMF_PROPERINUSE/sv_mvd_capture_flags gates
// (this port has no game-feature-flags negotiation and always applies the
// default capture policy: connected+spawned, non-spectator, non-frozen,
// prediction-enabled players only).
function playerIsActive(ent: Edict, num: number): boolean {
  if (!ent.client || !hasPlayerState(ent.client)) return false;

  const client = svs.clients[num];
  if (!client || client.state !== ClientStateT.cs_spawned) return false;

  const ps = ent.client.ps;
  if (!ps.fov) return false;

  // mvd.c:517-519: always capture the dummy MVD client, bypassing the
  // spectator/freeze/no-prediction exclusions below (the dummy is itself a
  // spectator by construction -- see dummyCreate's userinfo).
  if (mvdDummy.clientIndex !== null && num === mvdDummy.clientIndex) return true;

  if (ps.pmove.pm_type === PmTypeT.PM_SPECTATOR) return false;
  if (ps.pmove.pm_type === PmTypeT.PM_FREEZE) return false;
  if (ps.pmove.pm_flags & PMF_NO_PREDICTION) return false;

  return true;
}

// mvd.c:553-564, minus the RF_CASTSHADOW clause in HAS_EFFECTS (server.h:754)
// -- RF_CASTSHADOW is a KEX-only render flag this port's EntityStateT.renderfx
// never sets under the legacy family, so the clause can never fire here.
function entityIsActive(ent: Edict): boolean {
  if (ent.svflags & SVF_NOCLIENT) return false;
  return ent.s.modelindex !== 0 || ent.s.effects !== 0 || ent.s.sound !== 0 || ent.s.event !== 0;
}

function activeClientCount(): number {
  return maxclients ? maxclients.value : 0;
}

// mvd.c:567-598 (build_gamestate): (re)establishes the delta-compressor's
// baseline. Called once when recording/streaming transitions from inactive
// to active.
function buildGamestate(): void {
  const n = activeClientCount();
  mvd.players = new Array(MAX_CLIENTS).fill(null);
  mvd.entities = new Array(MAX_EDICTS).fill(null);

  const ge = geHolder.ge;
  if (!ge) return;

  for (let i = 0; i < n; i++) {
    const ent = ge.edicts[i + 1];
    if (!ent || !playerIsActive(ent, i)) continue;
    if (ent.client && hasPlayerState(ent.client)) {
      mvd.players[i] = clonePlayerState(ent.client.ps);
    }
  }

  for (let i = 1; i < ge.num_edicts; i++) {
    const ent = ge.edicts[i];
    if (!ent || !entityIsActive(ent)) continue;
    const copy = new EntityStateT();
    cloneEntityStateInto(ent.s, copy);
    copy.number = i;
    mvd.entities[i] = copy;
  }
}

// mvd.c:602-693 (emit_gamestate), minus MSG_ES_FIRSTPERSON's bandwidth-only
// origin/angle suppression (see qcommon/protocol/mvd.ts's header) and minus
// the MVF_NOMSGS dummy-only flag (no dummy in this port).
function emitGamestateInto(msg: SizeBuf): void {
  MSG_WriteByte(msg, mvd_serverdata);
  MSG_WriteLong(msg, PROTOCOL_VERSION_MVD);
  MSG_WriteShort(msg, mvd.rerelease ? PROTOCOL_VERSION_MVD_RERELEASE : PROTOCOL_VERSION_MVD_DEFAULT);
  MSG_WriteLong(msg, svs.spawncount);
  MSG_WriteString(msg, FS_Gamedir());
  MSG_WriteShort(msg, mvdDummy.clientIndex !== null ? mvdDummy.clientIndex : -1);

  let i = 0;
  for (; i < svs.csr.end; i++) {
    const s = sv.configstrings[i];
    if (!s.length) continue;
    MSG_WriteShort(msg, i);
    MSG_WriteString(msg, s);
  }
  MSG_WriteShort(msg, i);

  const portalbits = CM_WritePortalBits();
  MSG_WriteByte(msg, portalbits.length);
  msg.data.set(portalbits, msg.cursize);
  msg.cursize += portalbits.length;

  const n = activeClientCount();
  const writePlayer = mvd.rerelease ? MSG_WriteDeltaMvdPlayerstateRerelease : MSG_WriteDeltaMvdPlayerstate;
  for (let c = 0; c < n; c++) {
    const ps = mvd.players[c] ?? new PlayerStateT();
    writePlayer(msg, null, ps, c, false);
  }
  MSG_WriteMvdPlayersEnd(msg);

  const ge = geHolder.ge;
  const numEdicts = ge ? ge.num_edicts : 1;
  for (let e = 1; e < numEdicts; e++) {
    const es = mvd.entities[e];
    if (!es) continue;
    // NOT writeSpawnBaseline: that helper prefixes an svc_spawnbaseline
    // opcode byte (vanilla.ts's own writeSpawnBaseline body), which has no
    // place in the MVD wire format -- emit_gamestate's C equivalent
    // (`MSG_WriteDeltaEntity(NULL, es, flags)`) writes the bits/number delta
    // directly with no leading opcode, exactly like a packetentities delta.
    VANILLA_CODEC.writeDeltaEntity(msg, NULL_ENTITY_STATE, es, true, true);
  }
  VANILLA_CODEC.writePacketEntitiesEnd(msg);
}

// mvd.c:700-798 (emit_frame), same scoping notes as emitGamestateInto.
function emitFrameInto(msg: SizeBuf): void {
  MSG_WriteByte(msg, mvd_frame);

  const portalbits = CM_WritePortalBits();
  MSG_WriteByte(msg, portalbits.length);
  msg.data.set(portalbits, msg.cursize);
  msg.cursize += portalbits.length;

  const ge = geHolder.ge;
  const n = activeClientCount();
  const writePlayer = mvd.rerelease ? MSG_WriteDeltaMvdPlayerstateRerelease : MSG_WriteDeltaMvdPlayerstate;
  for (let i = 0; i < n; i++) {
    const ent = ge ? ge.edicts[i + 1] : null;
    const wasActive = mvd.players[i] !== null;

    if (!ent || !playerIsActive(ent, i)) {
      if (wasActive) {
        writePlayer(msg, null, null, i, false);
        mvd.players[i] = null;
      }
      continue;
    }

    const newps = ent.client && hasPlayerState(ent.client) ? clonePlayerState(ent.client.ps) : new PlayerStateT();
    writePlayer(msg, mvd.players[i], newps, i, !wasActive);
    mvd.players[i] = newps;
  }
  MSG_WriteMvdPlayersEnd(msg);

  const numEdicts = ge ? ge.num_edicts : 1;
  for (let e = 1; e < numEdicts; e++) {
    const ent = ge ? ge.edicts[e] : null;
    const oldes = mvd.entities[e];

    if (!ent || !entityIsActive(ent)) {
      if (oldes) {
        VANILLA_CODEC.writeEntityRemove(msg, e);
        mvd.entities[e] = null;
      }
      continue;
    }

    const newes = new EntityStateT();
    cloneEntityStateInto(ent.s, newes);
    newes.number = e;

    if (!oldes) {
      VANILLA_CODEC.writeDeltaEntity(msg, NULL_ENTITY_STATE, newes, true, true);
    } else {
      VANILLA_CODEC.writeDeltaEntity(msg, oldes, newes, false, false);
    }
    mvd.entities[e] = newes;
  }
  VANILLA_CODEC.writePacketEntitiesEnd(msg);
}

// ---------------------------------------------------------------------------
// local .mvd2 file recorder (mvd.c's rec_start/rec_write/rec_frame/rec_stop)
// ---------------------------------------------------------------------------

function writeU16LE(handle: number, value: number): void {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  FS_Write(buf, 2, handle);
}

function writeU32LE(handle: number, value: number): void {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  FS_Write(buf, 4, handle);
}

function recWriteMessage(handle: number, msg: SizeBuf): void {
  if (!msg.cursize) return;
  writeU16LE(handle, msg.cursize);
  FS_Write(msg.data.subarray(0, msg.cursize), msg.cursize, handle);
}

function recStop(): void {
  if (mvd.recording === null) return;
  writeU16LE(mvd.recording, 0); // EOF marker
  FS_FCloseFile(mvd.recording);
  mvd.recording = null;
}

function recStart(handle: number): void {
  mvd.recording = handle;
  mvd.numframes = 0;
  writeU32LE(handle, MVD_MAGIC);

  if (!mvd.active) return;

  const buf = new SizeBuf();
  const data = new Uint8Array(65536);
  SZ_Init(buf, data, data.length);
  emitGamestateInto(buf);
  recWriteMessage(handle, buf);
}

function mvdEnable(): boolean {
  if (!mvd.active) {
    mvd.rerelease = currentGameFamily() === "kex";
    buildGamestate();
    mvd.active = true;
    // mvd.c's mvd_enable(): create+spawn the dummy MVD client every time
    // recording/streaming transitions from idle to active. Deliberately NOT
    // gated on the dummy actually succeeding (mvd.c:897-899 aborts the whole
    // enable on `dummy_create() < 0`; this port always keeps recording real
    // player/entity state regardless -- see this file's header, scope note 1).
    dummyCreate();
  }
  return true;
}

function mvdDisableIfIdle(): void {
  if (mvd.recording === null && gtvActiveClients().length === 0) {
    mvd.active = false;
    dummyDestroy();
  }
}

/*
==============
SV_MvdRecord_f

Begins server MVD recording. Every connected player's state and every
active entity will be recorded to `demos/<name>.mvd2`.
==============
*/
export function SV_MvdRecord_f(): void {
  if (sv.state !== ServerStateT.ss_game) {
    Com_Printf("No server running.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Com_Printf("mvdrecord <filename>\n");
    return;
  }

  if (mvd.recording !== null) {
    Com_Printf("Already recording a local MVD.\n");
    return;
  }

  const name = `${FS_Gamedir()}/demos/${Cmd_Argv(1)}.mvd2`;
  FS_CreatePath(name);
  const handle = FS_FOpenFileWrite(name);
  if (handle === null) {
    Com_Printf("ERROR: couldn't open.\n");
    return;
  }

  mvdEnable();
  Com_Printf("Recording local MVD to %s\n", name);
  recStart(handle);
}

/*
==============
SV_MvdStop_f

Ends server MVD recording.
==============
*/
export function SV_MvdStop_f(): void {
  if (mvd.recording === null) {
    Com_Printf("Not recording a local MVD.\n");
    return;
  }
  Com_Printf("Stopped local MVD recording.\n");
  recStop();
  mvdDisableIfIdle();
}

// ---------------------------------------------------------------------------
// GTV server (mvd.c's gtv_client_t / accept_client / parse_message family)
// ---------------------------------------------------------------------------

enum GtvClientStateT {
  CS_CONNECTED, // magic not yet validated
  CS_PRIMED, // hello accepted, no stream yet
  CS_STREAMING,
}

interface GtvClientConnT {
  id: number;
  state: GtvClientStateT;
  recvBuf: Uint8Array;
  gotMagic: boolean;
  // GTF_DEFLATE, negotiated in handleGtvHello: once true, every
  // GTS_STREAM_DATA payload sent to this client is compressed (see
  // writeGtvMessage below).
  deflate: boolean;
}

let gtvListenerId: number | null = null;
const gtvClients = new Map<number, GtvClientConnT>();

function gtvActiveClients(): GtvClientConnT[] {
  return [...gtvClients.values()].filter((c) => c.state === GtvClientStateT.CS_STREAMING);
}

function appendRecv(client: GtvClientConnT, data: Uint8Array): void {
  const merged = new Uint8Array(client.recvBuf.length + data.length);
  merged.set(client.recvBuf, 0);
  merged.set(data, client.recvBuf.length);
  client.recvBuf = merged;
}

// GTF_DEFLATE (item 5, GTV hardening): mvd.c streams a single ongoing zlib
// deflate context per client (Z_SYNC_FLUSH after every frame) so the
// dictionary carries across messages; this port instead deflates each
// GTS_STREAM_DATA payload as its own INDEPENDENT raw-deflate block via
// Bun's built-in zlib bindings (`Bun.deflateSync`/`Bun.inflateSync`, no
// Node `zlib` stream plumbing needed). Each block is self-contained and
// decodes correctly on its own -- exactly what Z_SYNC_FLUSH guarantees for
// the real continuous stream too -- at the cost of the cross-message
// dictionary reuse a persistent deflate context would give. This unit's
// scope has never claimed real .mvd2/GTV byte-for-byte tool interop (see
// qcommon/protocol/mvd.ts's header), so trading compression ratio for a
// much smaller, synchronous, per-message implementation is the right call
// here.
function writeGtvMessage(id: number, op: GtvServerOpT, body: SizeBuf): void {
  const client = gtvClients.get(id);
  let payload = body.data.subarray(0, body.cursize);
  if (client?.deflate && payload.length) {
    // `new Uint8Array(payload)` copies into a fresh ArrayBuffer-backed
    // typed array: `payload` here is a `.subarray()` view, whose TS type
    // (`Uint8Array<ArrayBufferLike>`) Bun's zlib bindings don't accept
    // directly (`Uint8Array<ArrayBuffer>` only).
    payload = Bun.deflateSync(new Uint8Array(payload));
  }

  const header = new Uint8Array(3);
  new DataView(header.buffer).setUint16(0, payload.length + 1, true);
  header[2] = op;
  TCP_Write(id, header);
  if (payload.length) TCP_Write(id, payload);
}

function dropGtvClient(id: number): void {
  gtvClients.delete(id);
  TCP_Close(id);
  mvdDisableIfIdle();
}

// mvd.c's auth_client, minus the whitelist/blacklist host-matching branches
// (SV_MatchAddress against gtv_white_list/gtv_black_list -- not requested by
// this unit's brief, which names "the auth handshake (password)"
// specifically; IP allow/deny lists are a separate, general-purpose
// mechanism this port's net_tcp.ts layer does not expose an address for
// today). Password-only: empty cvar allows anyone (mvd.c:1453's
// `*sv_mvd_password->string == 0` check), non-empty requires an exact match.
function authGtvClient(password: string): boolean {
  const required = svMvdPasswordCvar();
  if (required.length === 0) return true;
  return password === required;
}

function handleGtvHello(client: GtvClientConnT, msg: ByteCursorT): void {
  // GTC_HELLO body (post op-byte, already consumed by the caller): word
  // protocol, long flags, long unused, string name, string password, string
  // version (mvd.c:1460-1536).
  const protocol = readShortAt(msg);
  const flags = readLongAt(msg);
  readLongAt(msg); // unused
  readStringAt(msg); // name
  const password = readStringAt(msg);
  readStringAt(msg); // version

  if (protocol !== GTV_PROTOCOL_VERSION) {
    const empty = new SizeBuf();
    SZ_Init(empty, new Uint8Array(0), 0);
    writeGtvMessage(client.id, GtvServerOpT.GTS_BADREQUEST, empty);
    dropGtvClient(client.id);
    return;
  }

  if (!authGtvClient(password)) {
    const empty = new SizeBuf();
    SZ_Init(empty, new Uint8Array(0), 0);
    writeGtvMessage(client.id, GtvServerOpT.GTS_NOACCESS, empty);
    dropGtvClient(client.id);
    return;
  }

  client.state = GtvClientStateT.CS_PRIMED;
  // GTF_STRINGCMDS stays unsupported regardless of what the client asked
  // for (no dummy-forwarded console command path -- see dummyCreate's
  // header); GTF_DEFLATE is granted whenever the client requests it, since
  // Bun's built-in zlib bindings make it always available here (unlike the
  // C's `#if !USE_ZLIB` build-time gate).
  const grantDeflate = !!(flags & GTF_DEFLATE);

  const reply = new SizeBuf();
  const replyData = new Uint8Array(8);
  SZ_Init(reply, replyData, replyData.length);
  MSG_WriteLong(reply, grantDeflate ? GTF_DEFLATE : 0);
  // Sent in plaintext: the client cannot know to inflate this very reply
  // until AFTER it decodes the echoed flags inside it (mvd.c:1517-1531 --
  // deflateInit only runs once the hello reply has already been queued).
  writeGtvMessage(client.id, GtvServerOpT.GTS_HELLO, reply);
  client.deflate = grantDeflate;
}

function handleGtvStreamStart(client: GtvClientConnT): void {
  if (client.state !== GtvClientStateT.CS_PRIMED) {
    dropGtvClient(client.id);
    return;
  }

  mvdEnable();
  client.state = GtvClientStateT.CS_STREAMING;

  const ack = new SizeBuf();
  SZ_Init(ack, new Uint8Array(0), 0);
  writeGtvMessage(client.id, GtvServerOpT.GTS_STREAM_START, ack);

  const gamestate = new SizeBuf();
  const gamestateData = new Uint8Array(65536);
  SZ_Init(gamestate, gamestateData, gamestateData.length);
  emitGamestateInto(gamestate);
  writeGtvMessage(client.id, GtvServerOpT.GTS_STREAM_DATA, gamestate);
}

function handleGtvStreamStop(client: GtvClientConnT): void {
  client.state = GtvClientStateT.CS_PRIMED;
  const ack = new SizeBuf();
  SZ_Init(ack, new Uint8Array(0), 0);
  writeGtvMessage(client.id, GtvServerOpT.GTS_STREAM_STOP, ack);
}

// Small forward-only readers over a plain Uint8Array cursor object, used for
// the GTC message bodies above (these arrive over TCP_Read, not through the
// SizeBuf-based net_message singleton every other reader in this codebase
// uses -- see net_tcp.ts's header for why GTV needs its own byte-stream
// framing layer).
interface ByteCursorT {
  data: Uint8Array;
  pos: number;
}
function readShortAt(c: ByteCursorT): number {
  const v = (c.data[c.pos] | (c.data[c.pos + 1] << 8)) & 0xffff;
  c.pos += 2;
  return v;
}
function readLongAt(c: ByteCursorT): number {
  const v = (c.data[c.pos] | (c.data[c.pos + 1] << 8) | (c.data[c.pos + 2] << 16) | (c.data[c.pos + 3] << 24)) | 0;
  c.pos += 4;
  return v >>> 0;
}
function readStringAt(c: ByteCursorT): string {
  let s = "";
  while (c.pos < c.data.length && c.data[c.pos] !== 0) {
    s += String.fromCharCode(c.data[c.pos]);
    c.pos++;
  }
  c.pos++; // skip NUL
  return s;
}
// `SizeBuf` compatibility shim: the handlers above accept an object with a
// `.data`/`.pos` shape for their own reads while the module's outgoing
// writes still use the real qcommon SizeBuf -- kept as two distinct small
// interfaces rather than forcing every GTC parse through MSG_Read*'s
// net_message-singleton convention, since these bytes never touch
// net_message (they arrive from net_tcp.ts's own per-connection buffer).

function processGtvBytes(client: GtvClientConnT): void {
  for (;;) {
    if (!client.gotMagic) {
      if (client.recvBuf.length < 4) return;
      const magicBytes = client.recvBuf.slice(0, 4);
      const magic = new DataView(magicBytes.buffer, magicBytes.byteOffset, 4).getUint32(0, true);
      if (magic !== MVD_MAGIC) {
        dropGtvClient(client.id);
        return;
      }
      client.gotMagic = true;
      client.recvBuf = client.recvBuf.subarray(4);
      TCP_Write(client.id, magicBytes); // echo the magic back (mvd.c:1660)
      continue;
    }

    if (client.recvBuf.length < 2) return;
    const lenView = new DataView(client.recvBuf.buffer, client.recvBuf.byteOffset, 2);
    const msglen = lenView.getUint16(0, true);
    if (client.recvBuf.length < 2 + msglen) return;

    const body = client.recvBuf.subarray(2, 2 + msglen);
    client.recvBuf = client.recvBuf.subarray(2 + msglen);

    if (msglen === 0) {
      dropGtvClient(client.id);
      return;
    }

    const cursor: ByteCursorT = { data: body.subarray(1), pos: 0 };
    const op = body[0];
    switch (op) {
      case GtvClientOpT.GTC_HELLO:
        handleGtvHello(client, cursor);
        break;
      case GtvClientOpT.GTC_PING: {
        const pong = new SizeBuf();
        SZ_Init(pong, new Uint8Array(0), 0);
        writeGtvMessage(client.id, GtvServerOpT.GTS_PONG, pong);
        break;
      }
      case GtvClientOpT.GTC_STREAM_START:
        handleGtvStreamStart(client);
        break;
      case GtvClientOpT.GTC_STREAM_STOP:
        handleGtvStreamStop(client);
        break;
      default:
        dropGtvClient(client.id);
        return;
    }
  }
}

/*
==============
SV_MvdRunGtv

Polls the GTV listener for new connections and drains buffered bytes from
every connected client, driving the handshake state machine. Call once per
server frame (mirrors mvd.c's SV_MvdRunClients, minus its zlib inflate step
-- see file header).
==============
*/
export function SV_MvdRunGtv(): void {
  if (gtvListenerId !== null) {
    for (;;) {
      const accepted = TCP_Accept(gtvListenerId);
      if (!accepted) break;

      // mvd.c's find_slot(): a full GTV client pool rejects new connections
      // outright (accept_client's "no free slots" path, mvd.c:1763-1767)
      // rather than queuing them.
      if (gtvClients.size >= svMvdMaxClientsCvar()) {
        TCP_Close(accepted.id);
        continue;
      }

      gtvClients.set(accepted.id, {
        id: accepted.id,
        state: GtvClientStateT.CS_CONNECTED,
        recvBuf: new Uint8Array(0),
        gotMagic: false,
        deflate: false,
      });
    }
  }

  for (const client of [...gtvClients.values()]) {
    if (TCP_IsClosed(client.id)) {
      gtvClients.delete(client.id);
      mvdDisableIfIdle();
      continue;
    }
    const chunk = TCP_Read(client.id);
    if (chunk) appendRecv(client, chunk);
    processGtvBytes(client);
  }
}

/*
==============
SV_MvdGtvListen_f / SV_MvdGtvStop_f
==============
*/
async function SV_MvdGtvListen_f(): Promise<void> {
  if (gtvListenerId !== null) {
    Com_Printf("GTV server is already listening.\n");
    return;
  }
  if (Cmd_Argc() !== 2) {
    Com_Printf("gtv_listen <port>\n");
    return;
  }
  const port = Number.parseInt(Cmd_Argv(1), 10);
  const id = await TCP_Listen("0.0.0.0", port);
  if (id === null) {
    Com_Printf("GTV server: couldn't listen on port %d\n", port);
    return;
  }
  gtvListenerId = id;
  Com_Printf("GTV server listening on port %d\n", port);
}

function SV_MvdGtvStop_f(): void {
  if (gtvListenerId === null) {
    Com_Printf("GTV server is not listening.\n");
    return;
  }
  TCP_StopListening(gtvListenerId);
  gtvListenerId = null;
  for (const client of gtvClients.values()) TCP_Close(client.id);
  gtvClients.clear();
  mvdDisableIfIdle();
  Com_Printf("GTV server stopped.\n");
}

// Test-only accessor: the GTV listener's bound id, so test/mvd.test.ts can
// tear it down between cases without a console round-trip.
export function SV_MvdGtvListenerId(): number | null {
  return gtvListenerId;
}

// Test-only setter: lets test/mvd.test.ts hand SV_MvdRunGtv() a listener id
// obtained directly from net_tcp.ts's TCP_Listen (so the test can read back
// the OS-assigned ephemeral port via TCP_ListenerPort before SV_MvdRunGtv
// ever runs), without going through the async gtv_listen console command.
export function SV_MvdSetGtvListenerForTests(id: number | null): void {
  gtvListenerId = id;
}

// ---------------------------------------------------------------------------
// per-frame hooks (mvd.c's SV_MvdBeginFrame/SV_MvdEndFrame)
// ---------------------------------------------------------------------------

export function SV_MvdBeginFrame(): void {
  // mvd.c's check_clients_activity/check_players_activity (auto-suspend
  // when nobody is watching) are not ported -- see this file's header;
  // `mvd.active` is driven explicitly by mvdEnable/mvdDisableIfIdle instead.
}

export function SV_MvdEndFrame(): void {
  dummyRun();
  SV_MvdRunGtv();

  if (!mvd.active) return;

  if (mvd.message.overflowed) {
    Com_Printf("MVD reliable message overflowed\n");
    SZ_Clear(mvd.message);
    SZ_Clear(mvd.datagram);
    return;
  }
  if (mvd.datagram.overflowed) {
    Com_Printf("WARNING: Unreliable MVD datagram overflowed.\n");
    SZ_Clear(mvd.datagram);
  }

  const frame = new SizeBuf();
  const frameData = new Uint8Array(65536);
  SZ_Init(frame, frameData, frameData.length);
  emitFrameInto(frame);

  // mvd.c:1033-1071: one combined message per frame -- mvd.message (reliable
  // out-of-band: configstrings/prints/multicast_r/unicast_r, buffered by the
  // hooks above over the course of this frame), then the frame delta itself,
  // then mvd.datagram (unreliable out-of-band: multicast/unicast/sound).
  const total = mvd.message.cursize + frame.cursize + mvd.datagram.cursize;
  const combined = new SizeBuf();
  const combinedData = new Uint8Array(Math.max(total, 1));
  SZ_Init(combined, combinedData, combinedData.length);
  SZ_Write(combined, mvd.message.data.subarray(0, mvd.message.cursize), mvd.message.cursize);
  SZ_Write(combined, frame.data.subarray(0, frame.cursize), frame.cursize);
  SZ_Write(combined, mvd.datagram.data.subarray(0, mvd.datagram.cursize), mvd.datagram.cursize);

  for (const client of gtvActiveClients()) {
    writeGtvMessage(client.id, GtvServerOpT.GTS_STREAM_DATA, combined);
  }

  if (mvd.recording !== null) {
    recWriteMessage(mvd.recording, combined);
    mvd.numframes++;
  }

  SZ_Clear(mvd.message);
  SZ_Clear(mvd.datagram);
}

/*
==============
SV_MvdMapChanged

Resets the delta compressor on a level change (mvd.c's SV_MvdMapChanged).
Recording/streaming continues into the new map; the next frame rebuilds the
baseline from scratch.
==============
*/
export function SV_MvdMapChanged(): void {
  if (!mvd.active) return;
  buildGamestate();

  // SV_SpawnServer downgrades every connected client (including the dummy,
  // an entry in the same svs.clients array) from cs_spawned back to
  // cs_connected before respawning the level (sv_init.ts's own client loop);
  // real clients re-reach cs_spawned via their own reconnect/"begin" flow.
  // The dummy has no such flow of its own, so it needs the same explicit
  // re-spawn mvd.c's SV_MvdMapChanged gives it (dummy_create/dummy_spawn,
  // mvd.c:2002-2014) -- otherwise it would silently stop being captured
  // (playerIsActive's cs_spawned gate) after the very first map change.
  if (mvdDummy.clientIndex !== null && mvdDummy.edict) {
    const ge = geHolder.ge;
    const cl = svs.clients[mvdDummy.clientIndex];
    if (ge && cl) {
      ge.ClientBegin(mvdDummy.edict);
      cl.state = ClientStateT.cs_spawned;
    }
  } else {
    dummyCreate();
  }
}

/*
==============
SV_MvdBroadcastPrint

Hook for SV_BroadcastPrintf (sv_send.ts). Buffers a print message into
mvd.message (the reliable out-of-band buffer), flushed once per frame by
SV_MvdEndFrame alongside the frame delta and the multicast/unicast/sound
hooks below -- matches mvd.c:1249-1255 exactly now that this unit ports the
same per-frame accumulate-then-flush cycle those hooks need (previously this
function wrote straight to each GTV client's stream immediately; see git
history / this file's superseded header note for that earlier design).
==============
*/
export function SV_MvdBroadcastPrint(level: number, text: string): void {
  if (!mvd.active) return;
  MSG_WriteMvdCmd(mvd.message, mvd_print, 0);
  MSG_WriteByte(mvd.message, level);
  MSG_WriteString(mvd.message, text);
}

// mvd.c's filter_unicast_data: discards unicast payloads a real MVD viewer
// would just throw away, and (when a dummy exists) routes layout/print
// traffic the same way the real engine does. `SvcOpsT.svc_stufftext`'s
// "play " exception lets client-side sound-hack stufftexts (some mods stuff
// `play sound/foo.wav` instead of using gi.sound) still reach the recording.
const PLAY_PREFIX = [0x70, 0x6c, 0x61, 0x79, 0x20]; // "play "

function payloadStartsWithPlay(payload: Uint8Array): boolean {
  if (payload.length < 1 + PLAY_PREFIX.length) return false;
  for (let i = 0; i < PLAY_PREFIX.length; i++) {
    if (payload[1 + i] !== PLAY_PREFIX[i]) return false;
  }
  return true;
}

function svMvdNomsgsCvar(): boolean {
  const v = Cvar_Get("sv_mvd_nomsgs", "1", 0);
  return v ? v.value !== 0 : true;
}

function filterUnicastData(ent: Edict, payload: Uint8Array): boolean {
  if (payload.length === 0) return true;
  const cmd = payload[0];

  if (cmd === SvcOpsT.svc_stufftext) {
    return payloadStartsWithPlay(payload);
  }

  // if there is no dummy client, don't discard anything (mvd.c:1159-1161)
  if (!mvdDummy.edict) return true;

  if (cmd === SvcOpsT.svc_layout) {
    return ent === mvdDummy.edict; // discard layout updates to real players
  }
  if (cmd === SvcOpsT.svc_print) {
    if (ent !== mvdDummy.edict && svMvdNomsgsCvar()) return false;
  }

  return true;
}

/*
==============
SV_MvdMulticast

Hook for SV_Multicast (sv_send.ts). `to` must name a base MulticastT kind
(ALL/PHS/PVS or their _R reliable variants); `payload` is the multicast
buffer's contents (sv.multicast, read BEFORE the caller clears it).
==============
*/
export function SV_MvdMulticast(leafnum: number, to: MulticastT, payload: Uint8Array): void {
  if (!mvd.active) return;

  if (payload.length >= 2048) {
    Com_Printf("SV_MvdMulticast: overflow\n");
    return;
  }

  let baseKind: number;
  let reliable: boolean;
  switch (to) {
    case MulticastT.MULTICAST_ALL:
      baseKind = 0;
      reliable = false;
      break;
    case MulticastT.MULTICAST_ALL_R:
      baseKind = 0;
      reliable = true;
      break;
    case MulticastT.MULTICAST_PHS:
      baseKind = 1;
      reliable = false;
      break;
    case MulticastT.MULTICAST_PHS_R:
      baseKind = 1;
      reliable = true;
      break;
    case MulticastT.MULTICAST_PVS:
      baseKind = 2;
      reliable = false;
      break;
    case MulticastT.MULTICAST_PVS_R:
      baseKind = 2;
      reliable = true;
      break;
    default:
      return;
  }

  const buf = reliable ? mvd.message : mvd.datagram;
  const op = (reliable ? mvd_multicast_all_r : mvd_multicast_all) + baseKind;
  const extrabits = (payload.length >> 8) & 7;

  MSG_WriteMvdCmd(buf, op, extrabits);
  MSG_WriteByte(buf, payload.length & 0xff);
  if (baseKind !== 0) MSG_WriteShort(buf, leafnum & 0xffff);
  SZ_Write(buf, payload, payload.length);
}

/*
==============
SV_MvdUnicast

Hook for PF_Unicast (sv_game.ts). `payload` is the multicast buffer's
contents addressed to a single client (sv.multicast, read BEFORE the caller
clears it).
==============
*/
export function SV_MvdUnicast(ent: Edict, clientNum: number, reliable: boolean, payload: Uint8Array): void {
  if (!mvd.active) return;
  if (!playerIsActive(ent, clientNum)) return;
  if (!filterUnicastData(ent, payload)) return;

  if (payload.length >= 2048) {
    Com_Printf("SV_MvdUnicast: overflow\n");
    return;
  }

  const buf = reliable ? mvd.message : mvd.datagram;
  const op = reliable ? mvd_unicast_r : mvd_unicast;
  const extrabits = (payload.length >> 8) & 7;

  MSG_WriteMvdCmd(buf, op, extrabits);
  MSG_WriteByte(buf, payload.length & 0xff);
  MSG_WriteByte(buf, clientNum);
  SZ_Write(buf, payload, payload.length);
}

/*
==============
SV_MvdStartSound

Hook for SV_StartSound (sv_send.ts). `flags`/`volume`/`attenuation`/
`timeofs` are the already-quantized byte values SV_StartSound computed for
its own svc_sound multicast (mvd.c:1265-1291's FIXME about incorrect origin
on entities not captured this frame applies here too -- unchanged from the
reference).
==============
*/
export function SV_MvdStartSound(entnum: number, channel: number, flags: number, soundindex: number, volume: number, attenuation: number, timeofs: number): void {
  if (!mvd.active) return;

  let extrabits = 0;
  if (channel & CHAN_NO_PHS_ADD) extrabits |= 1;
  if (channel & CHAN_RELIABLE) extrabits |= 2;

  MSG_WriteMvdCmd(mvd.datagram, mvd_sound, extrabits);
  MSG_WriteByte(mvd.datagram, flags);
  MSG_WriteByte(mvd.datagram, soundindex);

  if (flags & SND_VOLUME) MSG_WriteByte(mvd.datagram, volume);
  if (flags & SND_ATTENUATION) MSG_WriteByte(mvd.datagram, attenuation);
  if (flags & SND_OFFSET) MSG_WriteByte(mvd.datagram, timeofs);

  const sendchan = (entnum << 3) | (channel & 7);
  MSG_WriteShort(mvd.datagram, sendchan);
}

/*
==============
SV_MvdRegister

Registers the mvdrecord/mvdstop/gtv_listen/gtv_stop console commands.
Called once from SV_Init (sv_main.ts).
==============
*/
export function SV_MvdRegister(): void {
  Cmd_AddCommand("mvdrecord", SV_MvdRecord_f);
  Cmd_AddCommand("mvdstop", SV_MvdStop_f);
  Cmd_AddCommand("gtv_listen", () => {
    void SV_MvdGtvListen_f();
  });
  Cmd_AddCommand("gtv_stop", SV_MvdGtvStop_f);
}

// Test-only reset: clears all module-level recorder/GTV state between test
// cases without needing a full process restart.
export function SV_MvdResetForTests(): void {
  mvd.active = false;
  mvd.rerelease = false;
  if (mvd.recording !== null) FS_FCloseFile(mvd.recording);
  mvd.recording = null;
  mvd.players = new Array(MAX_CLIENTS).fill(null);
  mvd.entities = new Array(MAX_EDICTS).fill(null);
  mvd.numframes = 0;
  SZ_Clear(mvd.message);
  SZ_Clear(mvd.datagram);
  mvdDummy.clientIndex = null;
  mvdDummy.edict = null;
  if (gtvListenerId !== null) {
    TCP_StopListening(gtvListenerId);
    gtvListenerId = null;
  }
  for (const client of gtvClients.values()) TCP_Close(client.id);
  gtvClients.clear();
}

// Test-only accessor: whether recording/streaming is currently active.
export function SV_MvdIsActive(): boolean {
  return mvd.active;
}
