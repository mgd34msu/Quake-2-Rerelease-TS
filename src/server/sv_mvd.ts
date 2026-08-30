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
// split, cited again at SV_MvdRecord_f below):
//
//   1. NO MVD DUMMY CLIENT. The real engine spawns a fake connected client +
//      edict ("mvd.dummy") that the game DLL treats as a real spectator, so
//      operators can run mvdstuff/scoreboard commands through it and the
//      recording always has an always-active default observer. Standing one
//      up means driving ClientConnect/ClientBegin against a live
//      GameExports for a synthetic client -- real integration risk (fake
//      player counts, spawn-point consumption) for a feature (admin
//      stringcmd forwarding into the recording) this unit's tests don't
//      exercise. Recording instead captures every REAL connected player's
//      state directly; `player_is_active`'s "always capture dummy" special
//      case is simply absent (there is nothing to special-case).
//   2. NO SV_MvdMulticast/SV_MvdUnicast/SV_MvdStartSound hooks into
//      SV_Multicast/SV_Unicast/SV_StartSound (sv_send.ts). Those forward
//      arbitrary out-of-band game bytes (muzzle flashes, temp entities,
//      positioned sounds sent via PF_multicast rather than baked into
//      entity_state_t) into the MVD stream's reliable/unreliable buffers.
//      The round-trip fidelity this unit proves is entity/player STATE
//      (position, angles, stats) each frame, which does not depend on
//      those hooks. SV_MvdBroadcastPrint (below) IS wired, since
//      SV_BroadcastPrintf's hook site is a single call and broadcast prints
//      are genuinely useful/testable observer output.
//   3. NO GTV auth (sv_mvd_password/whitelist/blacklist), NO zlib stream
//      compression (GTF_DEFLATE is always masked off, matching the C's own
//      `#if !USE_ZLIB` build path), NO connection-count cap. GTV here is an
//      open relay with an unbounded client pool -- acceptable for what this
//      unit proves (the handshake and live frame relay work end to end);
//      revisit before any real network exposure.
//   4. KEX/RERELEASE FAMILY: SV_MvdRecord_f refuses with an explicit error
//      when `currentGameFamily() === "kex"` rather than emitting bytes that
//      claim PROTOCOL_VERSION_MVD_RERELEASE compatibility no code here
//      actually implements (see qcommon/protocol/mvd.ts's header).

import { SizeBuf, SZ_Init, SZ_Clear, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteString } from "../qcommon/sizebuf";
import { FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile } from "../qcommon/files";
import { FS_Gamedir } from "../qcommon/files";
import { Cmd_Argc, Cmd_Argv, Cmd_AddCommand } from "../qcommon/cmd";
import { Com_Printf } from "../qcommon/common";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import { CM_WritePortalBits } from "../qcommon/cmodel";
import {
  MVD_MAGIC,
  mvd_serverdata,
  mvd_frame,
  PROTOCOL_VERSION_MVD,
  PROTOCOL_VERSION_MVD_DEFAULT,
  CLIENTNUM_NONE,
  MSG_WriteDeltaMvdPlayerstate,
  MSG_WriteMvdPlayersEnd,
} from "../qcommon/protocol/mvd";
import { EntityStateT, PlayerStateT, PmTypeT, PMF_NO_PREDICTION, MAX_EDICTS, MAX_CLIENTS } from "../shared/q_shared";
import { clonePlayerState, cloneEntityStateInto } from "../shared/state_copy";
import { sv, svs, maxclients, ClientStateT, ServerStateT } from "./server";
import { geHolder, currentGameFamily } from "./sv_game";
import { SVF_NOCLIENT, type Edict } from "../game/game";
import { TCP_Listen, TCP_Accept, TCP_Read, TCP_Write, TCP_Close, TCP_IsClosed, TCP_StopListening } from "../platform/net_tcp";
import { GtvServerOpT, GtvClientOpT, GTV_PROTOCOL_VERSION } from "../qcommon/protocol/mvd";

const NULL_ENTITY_STATE = new EntityStateT();

// ---------------------------------------------------------------------------
// recording / delta-compressor state
// ---------------------------------------------------------------------------

interface MvdRecorderStateT {
  active: boolean; // at least one consumer (file or GTV client) wants frames
  recording: number | null; // FS handle, or null when not writing to a file
  players: Array<PlayerStateT | null>;
  entities: Array<EntityStateT | null>;
  numframes: number;
}

const mvd: MvdRecorderStateT = {
  active: false,
  recording: null,
  players: new Array(MAX_CLIENTS).fill(null),
  entities: new Array(MAX_EDICTS).fill(null),
  numframes: 0,
};

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
  MSG_WriteShort(msg, PROTOCOL_VERSION_MVD_DEFAULT);
  MSG_WriteLong(msg, svs.spawncount);
  MSG_WriteString(msg, FS_Gamedir());
  MSG_WriteShort(msg, -1); // no dummy client -- see file header

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
  for (let c = 0; c < n; c++) {
    const ps = mvd.players[c] ?? new PlayerStateT();
    MSG_WriteDeltaMvdPlayerstate(msg, null, ps, c, false);
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
  for (let i = 0; i < n; i++) {
    const ent = ge ? ge.edicts[i + 1] : null;
    const wasActive = mvd.players[i] !== null;

    if (!ent || !playerIsActive(ent, i)) {
      if (wasActive) {
        MSG_WriteDeltaMvdPlayerstate(msg, null, null, i, false);
        mvd.players[i] = null;
      }
      continue;
    }

    const newps = ent.client && hasPlayerState(ent.client) ? clonePlayerState(ent.client.ps) : new PlayerStateT();
    MSG_WriteDeltaMvdPlayerstate(msg, mvd.players[i], newps, i, !wasActive);
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
    buildGamestate();
    mvd.active = true;
  }
  return true;
}

function mvdDisableIfIdle(): void {
  if (mvd.recording === null && gtvActiveClients().length === 0) {
    mvd.active = false;
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

  if (currentGameFamily() === "kex") {
    Com_Printf("MVD recording for the kex/rerelease game family is not implemented (legacy-family only -- see qcommon/protocol/mvd.ts).\n");
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

function writeGtvMessage(id: number, op: GtvServerOpT, body: SizeBuf): void {
  const header = new Uint8Array(3);
  new DataView(header.buffer).setUint16(0, body.cursize + 1, true);
  header[2] = op;
  TCP_Write(id, header);
  if (body.cursize) TCP_Write(id, body.data.subarray(0, body.cursize));
}

function dropGtvClient(id: number): void {
  gtvClients.delete(id);
  TCP_Close(id);
  mvdDisableIfIdle();
}

function handleGtvHello(client: GtvClientConnT, msg: ByteCursorT): void {
  // GTC_HELLO body (post op-byte, already consumed by the caller): word
  // protocol, long flags, long unused, string name, string password, string
  // version (mvd.c:1460-1536). This port ignores name/password/version and
  // never authenticates (see file header).
  const protocol = readShortAt(msg);
  readLongAt(msg); // flags -- GTF_DEFLATE/GTF_STRINGCMDS both unsupported, ignored
  readLongAt(msg); // unused
  readStringAt(msg); // name
  readStringAt(msg); // password
  readStringAt(msg); // version

  if (protocol !== GTV_PROTOCOL_VERSION) {
    const empty = new SizeBuf();
    SZ_Init(empty, new Uint8Array(0), 0);
    writeGtvMessage(client.id, GtvServerOpT.GTS_BADREQUEST, empty);
    dropGtvClient(client.id);
    return;
  }

  client.state = GtvClientStateT.CS_PRIMED;

  const reply = new SizeBuf();
  const replyData = new Uint8Array(8);
  SZ_Init(reply, replyData, replyData.length);
  MSG_WriteLong(reply, 0); // flags echoed back -- always 0 (no deflate/stringcmds)
  writeGtvMessage(client.id, GtvServerOpT.GTS_HELLO, reply);
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
      gtvClients.set(accepted.id, {
        id: accepted.id,
        state: GtvClientStateT.CS_CONNECTED,
        recvBuf: new Uint8Array(0),
        gotMagic: false,
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
  SV_MvdRunGtv();

  if (!mvd.active) return;

  const msg = new SizeBuf();
  const data = new Uint8Array(65536);
  SZ_Init(msg, data, data.length);
  emitFrameInto(msg);

  for (const client of gtvActiveClients()) {
    writeGtvMessage(client.id, GtvServerOpT.GTS_STREAM_DATA, msg);
  }

  if (mvd.recording !== null) {
    recWriteMessage(mvd.recording, msg);
    mvd.numframes++;
  }

  SZ_Clear(msg);
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
  if (mvd.active) buildGamestate();
}

/*
==============
SV_MvdBroadcastPrint

Hook for SV_BroadcastPrintf (sv_send.ts). Appends a print message to every
GTV client's stream immediately (not buffered into a per-frame reliable
message like the real engine's `mvd.message` -- see file header's scope
note 2; this is simpler and sends prints promptly instead of batching them
until the next SV_MvdEndFrame).
==============
*/
export function SV_MvdBroadcastPrint(level: number, text: string): void {
  if (!mvd.active) return;
  const active = gtvActiveClients();
  if (active.length === 0) return;

  const buf = new SizeBuf();
  const data = new Uint8Array(text.length + 8);
  SZ_Init(buf, data, data.length);
  MSG_WriteByte(buf, level);
  MSG_WriteString(buf, text);

  for (const client of active) {
    writeGtvMessage(client.id, GtvServerOpT.GTS_STREAM_DATA, buf);
  }
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
  if (mvd.recording !== null) FS_FCloseFile(mvd.recording);
  mvd.recording = null;
  mvd.players = new Array(MAX_CLIENTS).fill(null);
  mvd.entities = new Array(MAX_EDICTS).fill(null);
  mvd.numframes = 0;
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
