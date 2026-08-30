import { describe, test, expect } from "bun:test";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients, sv_paused } from "../src/server/server";
import { SV_Init, SV_StatusString, SV_ConnectionlessPacket, SV_UserinfoChanged, SV_CalcPings, SV_GiveMsec } from "../src/server/sv_main";
import { SV_Multicast } from "../src/server/sv_send";
import { geHolder } from "../src/server/sv_game";
import { NetadrT, NetadrtypeT, NetsrcT } from "../src/qcommon/qcommon";
import { net_from, net_message } from "../src/qcommon/net_chan";
import { NET_ClearLoopback, NET_SendPacket, NET_GetPacket } from "../src/platform/net_udp";
import { SZ_Init, MSG_BeginReading, MSG_ReadLong } from "../src/qcommon/sizebuf";
import { Cvar_FullSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { CVAR_LATCH, CVAR_SERVERINFO } from "../src/shared/q_shared";
import { MulticastT, EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";

// ---- test fixtures ------------------------------------------------------

function loopbackAdr(): NetadrT {
  const a = new NetadrT();
  a.type = NetadrtypeT.NA_LOOPBACK;
  return a;
}

// Fabricates a fully-populated `Edict` (game.h's server-visible edict_t
// prefix) -- everything the interface declares, since server.ts's ClientT
// only ever holds a full `Edict`, never a partial one.
function makeEdict(client: unknown = null): Edict {
  return {
    s: new EntityStateT(),
    client,
    inuse: true,
    linkcount: 0,
    area: new LinkT(),
    num_clusters: 0,
    clusternums: new Int32Array(MAX_ENT_CLUSTERS),
    headnode: 0,
    areanum: 0,
    areanum2: 0,
    svflags: 0,
    mins: vec3(),
    maxs: vec3(),
    absmin: vec3(),
    absmax: vec3(),
    size: vec3(),
    solid: SolidT.SOLID_NOT,
    clipmask: 0,
    owner: null,
  };
}

// game.h's gclient_s server-visible prefix (`{ player_state_t ps; int
// ping; }`); a real type guard (no `as` cast) so tests can read back through
// the `unknown`-typed `Edict.client` field the same way sv_main.ts does.
interface FakeGClient {
  ps: PlayerStateT;
  ping: number;
}
function isFakeGClient(c: unknown): c is FakeGClient {
  return typeof c === "object" && c !== null && "ps" in c && "ping" in c;
}

// A synthetic client with its datagram/reliable buffers initialized the way
// SVC_DirectConnect initializes a real one (SZ_Init + allowoverflow), since
// nothing else in this unit spawns a client through the full connect path.
function makeClient(state: ClientStateT): ClientT {
  const cl = new ClientT();
  cl.state = state;
  SZ_Init(cl.datagram, cl.datagram_buf, cl.datagram_buf.length);
  cl.datagram.allowoverflow = true;
  SZ_Init(cl.netchan.message, cl.netchan.message_buf, cl.netchan.message_buf.length);
  cl.netchan.message.allowoverflow = true;
  return cl;
}

function makeFakeGameExports(): GameExports {
  return {
    apiversion: 3,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect(_ent: Edict, userinfo: string) {
      return { allowed: true, userinfo };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    ServerCommand() {},
    edicts: [],
    num_edicts: 0,
    max_edicts: 0,
  };
}

// ---- SV_Init -------------------------------------------------------------

describe("SV_Init", () => {
  test("registers cvars and sets initial server state", () => {
    // cvars persist process-wide exactly as in C; an earlier suite may have
    // changed maxclients, and Cvar_Get keeps the existing value. Reset to
    // the registration default so the assertion holds in any file order.
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    sv.state = ServerStateT.ss_dead;
    svs.initialized = false;
    SV_Init();

    expect(maxclients).not.toBeNull();
    expect(Cvar_VariableString("maxclients")).toBe("1");
    expect(sv_paused).not.toBeNull();
    expect(Cvar_VariableString("paused")).toBe("0");

    // SV_Init only registers cvars in this port (SV_InitOperatorCommands is
    // not called -- see sv_main.ts's report); server/client state are
    // otherwise untouched.
    expect(sv.state).toBe(ServerStateT.ss_dead);
    expect(svs.initialized).toBe(false);
  });
});

// ---- SV_StatusString -------------------------------------------------------

describe("SV_StatusString", () => {
  test("returns the serverinfo string terminated by a newline, plus one line per connected client", () => {
    SV_Init();
    svs.clients = [];

    const empty = SV_StatusString();
    expect(typeof empty).toBe("string");
    expect(empty.endsWith("\n")).toBe(true);

    if (!maxclients) throw new Error("maxclients not initialized");
    maxclients.value = 1;

    const client = makeClient(ClientStateT.cs_spawned);
    client.name = "Grunt";
    client.ping = 42;
    const gclient: FakeGClient = { ps: new PlayerStateT(), ping: 0 };
    gclient.ps.stats[14] = 7; // STAT_FRAGS
    client.edict = makeEdict(gclient);
    svs.clients = [client];

    const withPlayer = SV_StatusString();
    expect(withPlayer).toContain('7 42 "Grunt"\n');
  });
});

// ---- SVC_GetChallenge over the NS_SERVER loopback path --------------------

describe("SVC_GetChallenge", () => {
  test("issues a challenge and replies over the NS_SERVER loopback path", () => {
    NET_ClearLoopback(); // rule 13: earlier suites may have used the rings
    const adr = loopbackAdr();
    const text = "getchallenge";
    const bytes = new Uint8Array(4 + text.length);
    bytes.set([0xff, 0xff, 0xff, 0xff]);
    for (let i = 0; i < text.length; i++) bytes[4 + i] = text.charCodeAt(i);

    NET_SendPacket(NetsrcT.NS_CLIENT, bytes.length, bytes, adr);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);

    // dispatches to SVC_GetChallenge via the connectionless-packet router,
    // matching what SV_ReadPackets would do for a real inbound packet
    SV_ConnectionlessPacket();

    const replyFrom = new NetadrT();
    expect(NET_GetPacket(NetsrcT.NS_CLIENT, replyFrom, net_message)).toBe(true);
    MSG_BeginReading(net_message);
    expect(MSG_ReadLong(net_message)).toBe(-1);

    const rest = new TextDecoder().decode(net_message.data.slice(net_message.readcount, net_message.cursize));
    expect(rest.startsWith("challenge ")).toBe(true);
    const challengeNum = Number.parseInt(rest.slice("challenge ".length), 10);
    expect(Number.isNaN(challengeNum)).toBe(false);

    // re-requesting from the same address returns the same challenge (the
    // "already have a challenge for this ip" branch), not a new random one
    NET_SendPacket(NetsrcT.NS_CLIENT, bytes.length, bytes, adr);
    expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
    SV_ConnectionlessPacket();
    expect(NET_GetPacket(NetsrcT.NS_CLIENT, replyFrom, net_message)).toBe(true);
    MSG_BeginReading(net_message);
    MSG_ReadLong(net_message);
    const rest2 = new TextDecoder().decode(net_message.data.slice(net_message.readcount, net_message.cursize));
    expect(rest2).toBe(rest);
  });
});

// ---- SV_UserinfoChanged ---------------------------------------------------

describe("SV_UserinfoChanged", () => {
  test("clamps rate into [100, 15000] and extracts the name", () => {
    geHolder.ge = makeFakeGameExports();

    const cl = makeClient(ClientStateT.cs_connected);
    cl.edict = makeEdict({ ps: new PlayerStateT(), ping: 0 });

    cl.userinfo = "\\name\\Grunt\\rate\\99999";
    SV_UserinfoChanged(cl);
    expect(cl.name).toBe("Grunt");
    expect(cl.rate).toBe(15000); // clamped down from 99999

    cl.userinfo = "\\name\\Grunt\\rate\\1";
    SV_UserinfoChanged(cl);
    expect(cl.rate).toBe(100); // clamped up from 1

    cl.userinfo = "\\name\\Grunt\\rate\\5000";
    SV_UserinfoChanged(cl);
    expect(cl.rate).toBe(5000); // within range, unchanged

    cl.userinfo = "\\name\\Grunt";
    SV_UserinfoChanged(cl);
    expect(cl.rate).toBe(5000); // no rate key -- C default
  });
});

// ---- SV_CalcPings / SV_GiveMsec -------------------------------------------

describe("SV_CalcPings / SV_GiveMsec", () => {
  test("compute per-frame counters over synthetic clients", () => {
    if (!maxclients) throw new Error("maxclients not initialized");
    maxclients.value = 2;

    const spawned = makeClient(ClientStateT.cs_spawned);
    spawned.frame_latency[0] = 50;
    spawned.frame_latency[1] = 150;
    const gclient: FakeGClient = { ps: new PlayerStateT(), ping: 0 };
    spawned.edict = makeEdict(gclient);

    const free = makeClient(ClientStateT.cs_free);

    svs.clients = [spawned, free];

    SV_CalcPings();
    expect(spawned.ping).toBe(100); // (50+150)/2
    if (!isFakeGClient(spawned.edict.client)) throw new Error("bad fake gclient shape");
    expect(spawned.edict.client.ping).toBe(100); // written back to the game client

    sv.framenum = 16; // multiple of 16 -- SV_GiveMsec does not early-return
    spawned.commandMsec = 0;
    free.commandMsec = 0;
    SV_GiveMsec();
    expect(spawned.commandMsec).toBe(1800);
    expect(free.commandMsec).toBe(0); // cs_free is skipped

    sv.framenum = 1; // not a multiple of 16 -- SV_GiveMsec returns immediately
    spawned.commandMsec = 0;
    SV_GiveMsec();
    expect(spawned.commandMsec).toBe(0);
  });
});

// ---- SV_Multicast ----------------------------------------------------------

describe("SV_Multicast", () => {
  test("MULTICAST_ALL writes to every non-free/non-zombie client's datagram and clears sv.multicast", () => {
    SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
    sv.multicast.allowoverflow = true;

    const spawned = makeClient(ClientStateT.cs_spawned);
    const connected = makeClient(ClientStateT.cs_connected);
    const free = makeClient(ClientStateT.cs_free);
    const zombie = makeClient(ClientStateT.cs_zombie);

    svs.clients = [spawned, connected, free, zombie];
    svs.demofile = null;

    sv.multicast.data[0] = 0x2a;
    sv.multicast.cursize = 1;

    SV_Multicast(null, MulticastT.MULTICAST_ALL);

    // MULTICAST_ALL is unreliable: only clients whose state === cs_spawned
    // qualify (`client.state !== cs_spawned && !reliable` skips the rest).
    expect(spawned.datagram.cursize).toBe(1);
    expect(spawned.datagram.data[0]).toBe(0x2a);
    expect(connected.datagram.cursize).toBe(0);
    expect(free.datagram.cursize).toBe(0);
    expect(zombie.datagram.cursize).toBe(0);

    expect(sv.multicast.cursize).toBe(0); // cleared after multicasting
  });

  test("MULTICAST_ALL_R (reliable) reaches every non-free/non-zombie client's reliable message", () => {
    SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
    sv.multicast.allowoverflow = true;

    const spawned = makeClient(ClientStateT.cs_spawned);
    const connected = makeClient(ClientStateT.cs_connected);
    const free = makeClient(ClientStateT.cs_free);

    svs.clients = [spawned, connected, free];
    svs.demofile = null;

    sv.multicast.data[0] = 0x7b;
    sv.multicast.cursize = 1;

    SV_Multicast(null, MulticastT.MULTICAST_ALL_R);

    expect(spawned.netchan.message.cursize).toBe(1);
    expect(spawned.netchan.message.data[0]).toBe(0x7b);
    expect(connected.netchan.message.cursize).toBe(1); // reliable reaches cs_connected too
    expect(free.netchan.message.cursize).toBe(0); // cs_free never qualifies
  });
});
