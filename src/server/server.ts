// server.h -- ports server_static_t/server_t/client_t/challenge_t and every
// SV_ constant shared across the server module. server.h itself includes
// qcommon.h and game.h; this module imports from qcommon.ts/q_shared.ts/
// qfiles.ts/net_chan.ts/game.ts the same way.

import { MAX_MSGLEN, NetadrT, UPDATE_BACKUP } from "../qcommon/qcommon";
import { NetchanT } from "../qcommon/net_chan";
import { SizeBuf } from "../qcommon/sizebuf";
import { MAX_EDICTS, MAX_MODELS, CmodelT, EntityStateT, PlayerStateT, UsercmdT, type CvarT } from "../shared/q_shared";
import { type Vec3, vec3 } from "../shared/math";
import { MAX_MAP_AREAS } from "../qcommon/qfiles";
import { type CsRemapT, CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../shared/cs_remap";
import type { Edict } from "../game/game";

// server_t.name/mapcmd, client_t.name/userinfo are fixed-size C char arrays
// (MAX_QPATH, MAX_TOKEN_CHARS, 32, MAX_INFO_STRING); ported as plain strings
// throughout per PORTING.md ("JS strings are immutable... return the new
// string instead"). Their C size limits are documented at each field above
// rather than enforced by a type, since nothing here needs the enforcement.

//=============================================================================

export const MAX_MASTERS = 8; // max recipients for heartbeat packets

// some qc commands are only valid before the server has finished
// initializing (precache commands, static sounds / objects, etc)
export enum ServerStateT {
  ss_dead, // no map loaded
  ss_loading, // spawning level edicts
  ss_game, // actively running
  ss_cinematic,
  ss_demo,
  ss_pic,
}

// mirrors q2repro's server_entity_t (src/server/server.h:120-140, guarded
// there by `#if USE_FPS`): an 8-slot ring of recent origins/framenums per
// edict, consumed by framediv interpolation (world.c's PF_LinkEdict records
// it; entities.c's fix_old_origin reads it back) to reconstruct where a low-
// framediv entity actually was on the logic sub-frames a client's send rate
// skips. ENT_HISTORY_SIZE must be > MAX_FRAMEDIV (q2repro allows framediv up
// to 6 -- see Com_ComputeFrametime); 8 matches upstream. Only the recording
// side is wired up so far (this file + sv_world.ts's SV_LinkEdict) -- nothing
// reads the ring yet, since the framediv send path itself is future work
// (.orch/phase3-design.md, sequencing item 3).
export const ENT_HISTORY_SIZE = 8;
export const ENT_HISTORY_MASK = ENT_HISTORY_SIZE - 1;

export class EntHistorySlotT {
  origin: Vec3 = vec3();
  framenum = 0;
}

// q2repro keeps server_entity_t as a member of solid/link bookkeeping
// (src/server/server.h's `edict_link_t`-adjacent struct) that lives in
// `server_entity_t entities[MAX_EDICTS]` on `server_t` itself (server.h:177,
// i.e. `sv.entities`, not `svs`) -- it is wiped by SV_SpawnServer's
// `memset(&sv, 0, sizeof(sv))` alongside everything else per-level. Placed
// on ServerT here for the same reason: this port's minimal cut only carries
// the history ring (no create_origin/create_framenum -- unused until the
// framediv read side lands).
export class ServerEntityT {
  history: EntHistorySlotT[] = Array.from({ length: ENT_HISTORY_SIZE }, () => new EntHistorySlotT());
}

export class ServerT {
  state: ServerStateT = ServerStateT.ss_dead; // precache commands are only valid during load

  attractloop = false; // running cinematics and demos for the local system only
  loadgame = false; // client begins should reuse existing entity

  // mirrors q2repro's SV_FRAMERATE/SV_FRAMETIME/SV_FRAMEDIV (src/server/server.h
  // in q2repro, ~line 148) becoming per-server variables instead of a fixed
  // BASE_FRAMERATE constant. Fixed at 10Hz/100ms/1 until the kex tick-rate
  // binding lands (ARCHITECTURE.md phase 3); nothing derives sv_tick_rate yet.
  framerate = 10; // logic ticks per second
  frametime = 100; // msec per logic tick (1000 / framerate)
  framediv = 1; // send-rate divisor relative to framerate; framediv > 1 unimplemented

  time = 0; // always sv.framenum * sv.frametime msec
  framenum = 0;

  name = ""; // map name, or cinematic name
  models: Array<CmodelT | null> = new Array(MAX_MODELS).fill(null);

  // Sized at the widest known family's configstring count (CS_REMAP_RERELEASE.end,
  // cs_remap.ts), not svs.csr.end: this mirrors q2repro's own `configstring_t
  // configstrings[MAX_MAX_CONFIGSTRINGS]` (inc/shared/shared.h:164,1607-1658),
  // a fixed array sized to the max across every family regardless of which
  // one is active at runtime. Every read/write of this array is bounds-
  // checked against svs.csr (e.g. sv_game.ts's PF_Configstring), so the
  // array's own size is not observable behavior -- it just has to be large
  // enough for whichever family svs.csr selects, and svs.csr is CS_REMAP_OLD
  // until family selection arrives with the kex binding.
  configstrings: string[] = new Array(CS_REMAP_RERELEASE.end).fill("");
  baselines: EntityStateT[] = Array.from({ length: MAX_EDICTS }, () => new EntityStateT());

  // per-edict framediv history ring; see ServerEntityT above. Sized to
  // MAX_EDICTS like `baselines`, indexed the same way (ent.s.number, this
  // port's NUM_FOR_EDICT substitute -- see the comment below).
  entities: ServerEntityT[] = Array.from({ length: MAX_EDICTS }, () => new ServerEntityT());

  // the multicast buffer is used to send a message to a set of clients
  // it is only used to marshall data until SV_Multicast is called
  multicast: SizeBuf = new SizeBuf();
  multicast_buf: Uint8Array = new Uint8Array(MAX_MSGLEN);

  // demo server information -- FILE* becomes a files.ts handle number
  demofile: number | null = null;
  timedemo = false; // don't time sync

  // mirrors `memset(&sv, 0, sizeof(sv))` (SV_SpawnServer/SV_Shutdown)
  clear(): void {
    this.state = ServerStateT.ss_dead;
    this.attractloop = false;
    this.loadgame = false;
    // framerate/frametime/framediv are not part of the C `memset(&sv, 0, ...)`
    // wipe's zeroing in spirit -- q2repro re-derives them via set_frame_time()
    // right after; we have no such call yet, so re-assert the fixed 10Hz
    // defaults here rather than zeroing (a 0 frametime would break every
    // sv.framenum * sv.frametime computation below).
    this.framerate = 10;
    this.frametime = 100;
    this.framediv = 1;
    this.time = 0;
    this.framenum = 0;
    this.name = "";
    this.models = new Array(MAX_MODELS).fill(null);
    this.configstrings = new Array(CS_REMAP_RERELEASE.end).fill("");
    this.baselines = Array.from({ length: MAX_EDICTS }, () => new EntityStateT());
    this.entities = Array.from({ length: MAX_EDICTS }, () => new ServerEntityT());
    this.multicast = new SizeBuf();
    this.multicast_buf = new Uint8Array(MAX_MSGLEN);
    this.demofile = null;
    this.timedemo = false;
  }
}

// EDICT_NUM(n)/NUM_FOR_EDICT(e) are pointer-arithmetic macros over
// `ge->edicts`/`ge->edict_size`; TypeScript arrays need no stride, so call
// sites index `geHolder.ge.edicts[n]` directly and compute NUM_FOR_EDICT via
// `edict.s.number` (set by SV_InitEdict/EDICT_NUM callers) instead of pointer
// subtraction. See sv_game.ts (pending) for `geHolder`.

export enum ClientStateT {
  cs_free, // can be reused for a new connection
  cs_zombie, // client has been disconnected, but don't reuse
  // connection for a couple seconds
  cs_connected, // has been assigned to a client_t, but not in game yet
  cs_spawned, // client is fully in game
}

export class ClientFrameT {
  areabytes = 0;
  areabits: Uint8Array = new Uint8Array(MAX_MAP_AREAS / 8); // portalarea visibility bits
  ps: PlayerStateT = new PlayerStateT();
  num_entities = 0;
  first_entity = 0; // into the circular sv_packet_entities[]
  senttime = 0; // for ping calculations
}

export const LATENCY_COUNTS = 16;
export const RATE_MESSAGES = 10;

export class ClientT {
  state: ClientStateT = ClientStateT.cs_free;

  userinfo = ""; // name, etc

  lastframe = 0; // for delta compression
  lastcmd: UsercmdT = new UsercmdT(); // for filling in big drops

  commandMsec = 0; // every seconds this is reset, if user
  // commands exhaust it, assume time cheating

  frame_latency: Int32Array = new Int32Array(LATENCY_COUNTS);
  ping = 0;

  message_size: Int32Array = new Int32Array(RATE_MESSAGES); // used to rate drop packets
  rate = 0;
  surpressCount = 0; // number of messages rate supressed

  edict: Edict | null = null; // EDICT_NUM(clientnum+1)
  name = ""; // extracted from userinfo, high bits masked
  messagelevel = 0; // for filtering printed messages

  // The datagram is written to by sound calls, prints, temp ents, etc.
  // It can be harmlessly overflowed.
  datagram: SizeBuf = new SizeBuf();
  datagram_buf: Uint8Array = new Uint8Array(MAX_MSGLEN);

  frames: ClientFrameT[] = Array.from({ length: UPDATE_BACKUP }, () => new ClientFrameT()); // updates can be delta'd from here

  download: Uint8Array | null = null; // file being downloaded
  downloadsize = 0; // total bytes (can't use EOF because of paks)
  downloadcount = 0; // bytes sent

  lastmessage = 0; // sv.framenum when packet was last received
  lastconnect = 0;

  challenge = 0; // challenge of this user, randomly generated

  netchan: NetchanT = new NetchanT();

  // mirrors `memset(newcl, 0, sizeof(client_t))` (SVC_DirectConnect's `temp`)
  clear(): void {
    this.state = ClientStateT.cs_free;
    this.userinfo = "";
    this.lastframe = 0;
    this.lastcmd = new UsercmdT();
    this.commandMsec = 0;
    this.frame_latency = new Int32Array(LATENCY_COUNTS);
    this.ping = 0;
    this.message_size = new Int32Array(RATE_MESSAGES);
    this.rate = 0;
    this.surpressCount = 0;
    this.edict = null;
    this.name = "";
    this.messagelevel = 0;
    this.datagram = new SizeBuf();
    this.datagram_buf = new Uint8Array(MAX_MSGLEN);
    this.frames = Array.from({ length: UPDATE_BACKUP }, () => new ClientFrameT());
    this.download = null;
    this.downloadsize = 0;
    this.downloadcount = 0;
    this.lastmessage = 0;
    this.lastconnect = 0;
    this.challenge = 0;
    this.netchan = new NetchanT();
  }
}

// a client can leave the server in one of four ways:
// dropping properly by quiting or disconnecting
// timing out if no valid messages are received for timeout.value seconds
// getting kicked off by the server operator
// a program error, like an overflowed reliable buffer

//=============================================================================

// MAX_CHALLENGES is made large to prevent a denial
// of service attack that could cycle all of them
// out before legitimate users connected
export const MAX_CHALLENGES = 1024;

export class ChallengeT {
  adr: NetadrT = new NetadrT();
  challenge = 0;
  time = 0;
}

export class ServerStaticT {
  initialized = false; // sv_init has completed
  realtime = 0; // always increasing, no clamping, etc

  // mirrors q2repro's svs.csr (src/server/init.c:478 `svs.csr = cs_remap_old;`,
  // set once at SV_Init and re-derived per game_api during game-library init
  // -- src/server/game.c:1139-1157). Selects which configstring-index layout
  // ("game family") is active: which CS_* block starts where, and how many
  // models/sounds/images/edicts/shadowlights/wheelitems that family allows.
  // Lives here (server-static), not on ServerT, because in q2repro it
  // survives across SV_SpawnServer's per-level sv.clear() and is only
  // re-chosen when the game library itself is (re)loaded. Fixed at
  // CS_REMAP_OLD (classic protocol 34 layout) until family selection
  // arrives with the kex binding; nothing chooses cs_remap_rerelease yet.
  csr: CsRemapT = CS_REMAP_OLD;

  mapcmd = ""; // ie: *intro.cin+base

  spawncount = 0; // incremented each server start
  // used to check late spawns

  clients: ClientT[] = []; // [maxclients->value]
  num_client_entities = 0; // maxclients->value*UPDATE_BACKUP*MAX_PACKET_ENTITIES
  next_client_entities = 0; // next client_entity to use
  client_entities: EntityStateT[] = []; // [num_client_entities]

  last_heartbeat = 0;

  challenges: ChallengeT[] = Array.from({ length: MAX_CHALLENGES }, () => new ChallengeT()); // to prevent invalid IPs from connecting

  // serverrecord values
  demofile: number | null = null;
  demo_multicast: SizeBuf = new SizeBuf();
  demo_multicast_buf: Uint8Array = new Uint8Array(MAX_MSGLEN);

  // mirrors `memset(&svs, 0, sizeof(svs))` (SV_Shutdown)
  clear(): void {
    this.initialized = false;
    this.realtime = 0;
    // Not part of the C `memset(&svs, 0, ...)` wipe's zeroing in spirit --
    // q2repro's SV_Init re-derives svs.csr to cs_remap_old right after
    // (src/server/init.c:478); re-asserting the same default here rather
    // than zeroing avoids a transient all-zero CsRemapT (which would make
    // every csr.end/csr.models/etc bound momentarily wrong).
    this.csr = CS_REMAP_OLD;
    this.mapcmd = "";
    this.spawncount = 0;
    this.clients = [];
    this.num_client_entities = 0;
    this.next_client_entities = 0;
    this.client_entities = [];
    this.last_heartbeat = 0;
    this.challenges = Array.from({ length: MAX_CHALLENGES }, () => new ChallengeT());
    this.demofile = null;
    this.demo_multicast = new SizeBuf();
    this.demo_multicast_buf = new Uint8Array(MAX_MSGLEN);
  }
}

//=============================================================================

// net_from/net_message live in qcommon/net_chan.ts (their true owning module
// per PORTING.md's report on that unit); re-exported here since server.h
// externs them for every server_*.c file.
export { net_from, net_message } from "../qcommon/net_chan";

export const master_adr: NetadrT[] = Array.from({ length: MAX_MASTERS }, () => new NetadrT()); // address of the master server

export const svs: ServerStaticT = new ServerStaticT(); // persistant server info
export const sv: ServerT = new ServerT(); // local server

// sv_paused/maxclients/sv_noreload/sv_airaccelerate/sv_enforcetime are the
// cvars server.h externs (owned/assigned by sv_main.ts's SV_Init); every
// other sv_main.c cvar (timeout, zombietime, rcon_password, ...) is private
// to sv_main.c and stays module-local there.
export let sv_paused: CvarT | null = null;
export let maxclients: CvarT | null = null;
export let sv_noreload: CvarT | null = null; // don't reload level state when reentering
export let sv_airaccelerate: CvarT | null = null; // development tool
export let sv_enforcetime: CvarT | null = null;

// mirrors q2repro's sv_tick_rate (src/server/main.c ~line 2211, default
// "40", CVAR_LATCH). Our default is "10", NOT 40: q2repro's dispatch
// (src/server/init.c:136-148) only ever honors this cvar for the rerelease
// ("kex") game family -- every other family is pinned to BASE_FRAMERATE
// (10) regardless of what the cvar holds, unless the game library
// advertises GMF_VARIABLE_FPS. This port has no kex family binding yet
// (ARCHITECTURE.md phase 3) -- every loadable game tree today is a legacy
// tree hardcoded to FRAMETIME = 0.1s (75 files) -- so defaulting to "40"
// would silently desync the engine's frame clock from every game tree's
// own assumption of 10Hz. The default flips to "40" (matching q2repro) once
// the kex binding lands and family dispatch actually exists to pin legacy
// trees back to 10 regardless of this value.
export let sv_tick_rate: CvarT | null = null;

export function setSvPaused(v: CvarT | null): void {
  sv_paused = v;
}
export function setMaxclients(v: CvarT | null): void {
  maxclients = v;
}
export function setSvNoreload(v: CvarT | null): void {
  sv_noreload = v;
}
export function setSvAiraccelerate(v: CvarT | null): void {
  sv_airaccelerate = v;
}
export function setSvEnforcetime(v: CvarT | null): void {
  sv_enforcetime = v;
}
export function setSvTickRate(v: CvarT | null): void {
  sv_tick_rate = v;
}

// `client_t *sv_client;`/`edict_t *sv_player;` are pointers reassigned from
// several server_*.c files (SVC_DirectConnect, SV_ExecuteClientMessage,
// SV_FlushRedirect, ...). A bare `export let` here could only ever be
// reassigned by this module (ES module bindings are read-only to importers),
// so -- per this unit's brief -- both become small mutable holder objects
// any module can write through, matching the `geHolder` pattern used by the
// sv_game.ts pending stub.
export const svClientHolder: { sv_client: ClientT | null } = { sv_client: null }; // current client
export const svPlayerHolder: { sv_player: Edict | null } = { sv_player: null };

//===========================================================

// sv_send.c
export enum RedirectT {
  RD_NONE,
  RD_CLIENT,
  RD_PACKET,
}
export const SV_OUTPUTBUF_LENGTH = MAX_MSGLEN - 16;

// `extern char sv_outputbuf[SV_OUTPUTBUF_LENGTH];` -- dead per the
// Com_BeginRedirect port: qcommon/common.ts's Com_BeginRedirect dropped the
// caller-owned `char *buffer` parameter entirely (JS strings can't be
// strcat'd in place; the accumulator is owned internally), so no call site
// ever needs this buffer. Not exported; see report.
