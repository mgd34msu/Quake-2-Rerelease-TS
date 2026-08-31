/*
MVD/GTV subsystem tests.

SOURCES: see src/qcommon/protocol/mvd.ts, src/server/sv_mvd.ts, and
src/server/mvd/{client,parse,game,gtv_client}.ts's own header comments for
full GPLv2 q2repro citations (src/server/mvd.c, src/server/mvd/{client,
game,parse}.{c,h}, inc/common/protocol.h, inc/server/mvd/protocol.h).

Server code (and these tests) touch edicts only through the `Edict`
interface (PORTING.md/test/sv_world.test.ts's own precedent), never the game
module's private EdictT -- makeEdict below fabricates plain objects.
*/

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_Gamedir } from "../src/qcommon/files";
import { SizeBuf, SZ_Init, MSG_WriteByte, MSG_WriteLong, MSG_WriteShort, MSG_WriteString } from "../src/qcommon/sizebuf";
import { net_message, net_message_buffer } from "../src/qcommon/net_chan";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { SvcOpsT } from "../src/qcommon/qcommon";
import { CS_REMAP_OLD } from "../src/shared/cs_remap";
import { EntityStateT, PlayerStateT, PmTypeT, MAX_EDICTS, STAT_HEALTH, STAT_FRAGS, MulticastT, PRINT_HIGH, CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE } from "../src/shared/q_shared";
import { vec3, VectorCopy } from "../src/shared/math";
import { type Edict, LinkT, MAX_ENT_CLUSTERS, SolidT, type GameExports } from "../src/game/game";
import { sv, svs, ClientT, ClientStateT, ServerStateT, setMaxclients } from "../src/server/server";
import { geHolder } from "../src/server/sv_game";
import {
  MVD_MAGIC,
  CLIENTNUM_NONE,
  PROTOCOL_VERSION_MVD,
  PROTOCOL_VERSION_MVD_DEFAULT,
  mvd_serverdata,
  MSG_WriteDeltaMvdPlayerstate,
  MSG_ReadDeltaMvdPlayerstate,
  MSG_WriteMvdPlayersEnd,
  MSG_ValidMvdClientNumber,
} from "../src/qcommon/protocol/mvd";
import { MVD_NewChannel, MVD_ClearState, MvdChannelStateT } from "../src/server/mvd/client";
import { MVD_LoadFile } from "../src/server/mvd/parse";
import { MVD_Snapshot } from "../src/server/mvd/game";
import { MVD_GtvConnect, MVD_GtvPump, GtvClientLinkStateT } from "../src/server/mvd/gtv_client";
import { SV_MvdRecord_f, SV_MvdStop_f, SV_MvdBeginFrame, SV_MvdEndFrame, SV_MvdResetForTests, SV_MvdIsActive, SV_MvdRunGtv, SV_MvdSetGtvListenerForTests, SV_MvdMapChanged } from "../src/server/sv_mvd";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { TCP_Listen, TCP_ListenerPort } from "../src/platform/net_tcp";
import { SV_Multicast, SV_StartSound } from "../src/server/sv_send";
import { PF_Unicast } from "../src/server/sv_game";

function makeEdict(origin: readonly [number, number, number], client: { ps: PlayerStateT } | null): Edict {
  const s = new EntityStateT();
  VectorCopy(vec3(origin[0], origin[1], origin[2]), s.origin);
  return {
    s,
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

function makePlayerState(origin: readonly [number, number, number], fov: number, health: number, frags: number): PlayerStateT {
  const ps = new PlayerStateT();
  ps.pmove.pm_type = PmTypeT.PM_NORMAL;
  ps.pmove.origin[0] = origin[0];
  ps.pmove.origin[1] = origin[1];
  ps.pmove.origin[2] = origin[2];
  ps.fov = fov;
  ps.stats[STAT_HEALTH] = health;
  ps.stats[STAT_FRAGS] = frags;
  return ps;
}

function throwStub(name: string): () => never {
  return () => {
    throw new Error(`${name}: not implemented in this MVD test's fake GameExports`);
  };
}

// ClientConnect/ClientBegin/ClientThink/ClientDisconnect default to graceful
// no-ops/rejection rather than throwStub: sv_mvd.ts's dummyCreate() (item 2,
// the MVD dummy client) now calls ClientConnect whenever recording/streaming
// activates (mvdEnable()), and a rejection ({allowed:false}) is exactly how
// a real game module that doesn't want a spectator-only fake connect would
// respond -- dummyCreate() handles that gracefully (mvd.ts's own header),
// so every existing test below that never cared about the dummy keeps
// passing unmodified. Tests that DO want to exercise the dummy pass a
// dedicated fake via makeFakeGameExportsWithDummy instead.
function makeFakeGameExports(edicts: Edict[]): GameExports {
  return {
    apiversion: 3,
    Init: () => {},
    Shutdown: () => {},
    SpawnEntities: throwStub("SpawnEntities"),
    WriteGame: throwStub("WriteGame"),
    ReadGame: throwStub("ReadGame"),
    WriteLevel: throwStub("WriteLevel"),
    ReadLevel: throwStub("ReadLevel"),
    ClientConnect: () => ({ allowed: false, userinfo: "" }),
    ClientBegin: throwStub("ClientBegin"),
    ClientUserinfoChanged: throwStub("ClientUserinfoChanged"),
    ClientDisconnect: throwStub("ClientDisconnect"),
    ClientCommand: throwStub("ClientCommand"),
    ClientThink: throwStub("ClientThink"),
    RunFrame: () => {},
    ServerCommand: throwStub("ServerCommand"),
    edicts,
    num_edicts: edicts.length,
    max_edicts: MAX_EDICTS,
  };
}

// A fake GameExports that actually accepts the MVD dummy client connect, for
// tests exercising dummyCreate/dummyRun/the "always capture dummy" special
// case in playerIsActive.
function makeFakeGameExportsWithDummy(edicts: Edict[], dummyPs: PlayerStateT): GameExports {
  return {
    ...makeFakeGameExports(edicts),
    ClientConnect: (ent: Edict) => {
      ent.client = { ps: dummyPs };
      return { allowed: true, userinfo: "" };
    },
    ClientBegin: () => {},
    ClientThink: () => {},
    ClientDisconnect: () => {},
  };
}

// rule 13 (whole-file scope, not per-describe): net_message (src/qcommon/
// net_chan.ts) is a process-wide SizeBuf singleton. MVD_ParseMessage
// (src/server/mvd/parse.ts, exercised via MVD_LoadFile all over this file)
// calls SZ_Init(net_message, data, data.length) on whatever buffer it was
// handed -- almost always much smaller than the real net_message_buffer
// (MAX_MSGLEN) -- and never restores it. Left alone, this repoints
// net_message at a shrunk buffer for the rest of the `bun test` process;
// any later test expecting the full-size buffer (e.g.
// test/net_chan_fragment.test.ts's NET_GetPacket calls) overflows. A
// single top-level afterAll (once, after every test in this file has
// finished -- NOT afterEach, which was tried first and broke
// test/cl_main.test.ts's own loopback handshake when both files ran in
// the same process: an afterEach here would interleave with several
// describe blocks' OWN afterEach hooks that still need net_message in
// ITS mid-test state for their own cleanup, e.g. draining a live MVD
// recording or GTV stream) covers every describe block in this file
// (many of them call MVD_LoadFile) rather than repeating this in each one.
afterAll(() => {
  SZ_Init(net_message, net_message_buffer, net_message_buffer.length);
});

// ---------------------------------------------------------------------------
// A. qcommon/protocol/mvd.ts -- the "packet players" delta codec
// ---------------------------------------------------------------------------

describe("qcommon/protocol/mvd.ts -- MVD wire-format constants", () => {
  test("MVD_MAGIC encodes 'MVD2' little-endian (inc/common/protocol.h's MakeRawLong('M','V','D','2'))", () => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, MVD_MAGIC, true);
    expect(String.fromCharCode(...buf)).toBe("MVD2");
  });

  test("MSG_ValidMvdClientNumber rejects negative numbers and CLIENTNUM_NONE itself", () => {
    expect(MSG_ValidMvdClientNumber(0)).toBe(true);
    expect(MSG_ValidMvdClientNumber(CLIENTNUM_NONE - 1)).toBe(true);
    expect(MSG_ValidMvdClientNumber(CLIENTNUM_NONE)).toBe(false);
    expect(MSG_ValidMvdClientNumber(-1)).toBe(false);
  });
});

describe("MSG_WriteDeltaMvdPlayerstate / MSG_ReadDeltaMvdPlayerstate", () => {
  function roundTrip(from: PlayerStateT | null, to: PlayerStateT | null, number: number, force: boolean) {
    const buf = new SizeBuf();
    const data = new Uint8Array(1024);
    SZ_Init(buf, data, data.length);
    MSG_WriteDeltaMvdPlayerstate(buf, from, to, number, force);
    buf.readcount = 0;
    return MSG_ReadDeltaMvdPlayerstate(buf, from);
  }

  test("a full update from a null baseline round-trips origin, viewangles, fov, and stats", () => {
    const to = makePlayerState([100, 200, -50], 90, 75, 3);
    const result = roundTrip(null, to, 5, true);

    expect(result.removed).toBe(false);
    expect(result.number).toBe(5);
    expect(result.ps.pmove.origin[0]).toBe(100);
    expect(result.ps.pmove.origin[1]).toBe(200);
    expect(result.ps.pmove.origin[2]).toBe(-50);
    expect(result.ps.fov).toBe(90);
    expect(result.ps.stats[STAT_HEALTH]).toBe(75);
    expect(result.ps.stats[STAT_FRAGS]).toBe(3);
  });

  test("delta compression: fields unchanged between `from` and `to` are not re-sent, and the reader merges them from `from`", () => {
    const from = makePlayerState([10, 10, 10], 90, 100, 0);
    const to = makePlayerState([10, 10, 10], 90, 55, 0); // only health changed

    const buf = new SizeBuf();
    const data = new Uint8Array(1024);
    SZ_Init(buf, data, data.length);
    MSG_WriteDeltaMvdPlayerstate(buf, from, to, 2, false);
    const bytesForHealthOnlyChange = buf.cursize;

    // A second write changing origin too should need strictly more bytes,
    // proving the first write did not redundantly encode the unchanged origin.
    const to2 = makePlayerState([99, 10, 10], 90, 55, 0);
    const buf2 = new SizeBuf();
    const data2 = new Uint8Array(1024);
    SZ_Init(buf2, data2, data2.length);
    MSG_WriteDeltaMvdPlayerstate(buf2, from, to2, 2, false);
    expect(buf2.cursize).toBeGreaterThan(bytesForHealthOnlyChange);

    buf.readcount = 0;
    const result = MSG_ReadDeltaMvdPlayerstate(buf, from);
    expect(result.ps.pmove.origin[0]).toBe(10); // merged from `from`, not re-sent
    expect(result.ps.stats[STAT_HEALTH]).toBe(55);
  });

  test("an unforced write of two identical states emits zero bytes (nothing to send)", () => {
    const ps = makePlayerState([1, 2, 3], 90, 100, 0);
    const buf = new SizeBuf();
    const data = new Uint8Array(256);
    SZ_Init(buf, data, data.length);
    MSG_WriteDeltaMvdPlayerstate(buf, ps, ps, 0, false);
    expect(buf.cursize).toBe(0);
  });

  test("to === null writes a remove marker the reader reports as `removed: true`", () => {
    const from = makePlayerState([1, 2, 3], 90, 100, 0);
    const result = roundTrip(from, null, 7, false);
    expect(result.removed).toBe(true);
    expect(result.number).toBe(7);
  });

  test("MSG_WriteMvdPlayersEnd writes the CLIENTNUM_NONE terminator byte", () => {
    const buf = new SizeBuf();
    const data = new Uint8Array(4);
    SZ_Init(buf, data, data.length);
    MSG_WriteMvdPlayersEnd(buf);
    expect(buf.cursize).toBe(1);
    expect(buf.data[0]).toBe(CLIENTNUM_NONE);
  });
});

// ---------------------------------------------------------------------------
// B. server/mvd/{client,parse}.ts -- channel state + message parsing
// ---------------------------------------------------------------------------

describe("MVD_LoadFile / MVD_ParseMessage -- hand-built .mvd2 buffers", () => {
  function buildMinimalMvd2(entity: EntityStateT | null): Uint8Array {
    const body = new SizeBuf();
    const bodyData = new Uint8Array(4096);
    SZ_Init(body, bodyData, bodyData.length);

    MSG_WriteByte(body, mvd_serverdata);
    MSG_WriteLong(body, PROTOCOL_VERSION_MVD);
    MSG_WriteShort(body, PROTOCOL_VERSION_MVD_DEFAULT);
    MSG_WriteLong(body, 42); // servercount
    MSG_WriteString(body, "baseq2");
    MSG_WriteShort(body, -1); // no dummy client

    MSG_WriteShort(body, CS_REMAP_OLD.end); // no configstrings -> immediate terminator

    MSG_WriteByte(body, 0); // zero portal bytes

    MSG_WriteMvdPlayersEnd(body); // no active players

    if (entity) {
      // NOT writeSpawnBaseline -- see sv_mvd.ts's emitGamestateInto comment:
      // that helper's leading svc_spawnbaseline opcode byte has no place in
      // the MVD wire format's entity section.
      VANILLA_CODEC.writeDeltaEntity(body, new EntityStateT(), entity, true, true);
    }
    VANILLA_CODEC.writePacketEntitiesEnd(body);

    const magic = new Uint8Array(4);
    new DataView(magic.buffer).setUint32(0, MVD_MAGIC, true);

    const lenPrefix = new Uint8Array(2);
    new DataView(lenPrefix.buffer).setUint16(0, body.cursize, true);

    const eof = new Uint8Array(2); // zero -- EOF marker

    const out = new Uint8Array(magic.length + lenPrefix.length + body.cursize + eof.length);
    out.set(magic, 0);
    out.set(lenPrefix, magic.length);
    out.set(body.data.subarray(0, body.cursize), magic.length + lenPrefix.length);
    out.set(eof, magic.length + lenPrefix.length + body.cursize);
    return out;
  }

  test("parses gamedir/servercount and an entity baseline from a hand-built single-message file", () => {
    const entity = new EntityStateT();
    entity.number = 5;
    entity.modelindex = 200;
    entity.origin[0] = 10;
    entity.origin[1] = 20;
    entity.origin[2] = 30;

    const bytes = buildMinimalMvd2(entity);
    const channel = MVD_LoadFile(bytes);

    expect(channel.state).toBe(MvdChannelStateT.MVD_READING);
    expect(channel.gamedir).toBe("baseq2");
    expect(channel.servercount).toBe(42);
    expect(channel.entities[5]).not.toBeNull();
    expect(channel.entities[5]?.modelindex).toBe(200);
    expect(channel.entities[5]?.origin[0]).toBe(10);
    expect(channel.entities[5]?.origin[2]).toBe(30);
  });

  test("throws on a bad magic number", () => {
    const bytes = buildMinimalMvd2(null);
    bytes[0] = 0xff; // corrupt the magic
    expect(() => MVD_LoadFile(bytes)).toThrow(/not a MVD2 file/);
  });

  test("throws on a truncated message body", () => {
    const bytes = buildMinimalMvd2(null);
    expect(() => MVD_LoadFile(bytes.subarray(0, bytes.length - 3))).toThrow();
  });

  function setChannelState(channel: { state: MvdChannelStateT }, state: MvdChannelStateT): void {
    channel.state = state;
  }

  test("MVD_ClearState resets a channel back to MVD_DEAD with empty player/entity arrays", () => {
    const channel = MVD_NewChannel();
    setChannelState(channel, MvdChannelStateT.MVD_READING);
    channel.entities[5] = new EntityStateT();
    MVD_ClearState(channel);
    expect(channel.state).toBe(MvdChannelStateT.MVD_DEAD);
    expect(channel.entities[5]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. server/mvd/game.ts -- observation snapshot
// ---------------------------------------------------------------------------

describe("MVD_Snapshot", () => {
  test("summarizes active players and entities from a channel, skipping inactive slots", () => {
    const channel = MVD_NewChannel();
    channel.configstrings[0] = "q2dm1";
    channel.players[0] = makePlayerState([1, 2, 3], 90, 80, 5);
    channel.players[1] = null; // inactive slot
    channel.entities[10] = (() => {
      const es = new EntityStateT();
      es.number = 10;
      es.modelindex = 42;
      es.origin[0] = 7;
      return es;
    })();

    const snap = MVD_Snapshot(channel);
    expect(snap.mapname).toBe("q2dm1");
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0].clientNum).toBe(0);
    expect(snap.players[0].health).toBe(80);
    expect(snap.players[0].frags).toBe(5);
    expect(snap.entities).toHaveLength(1);
    expect(snap.entities[0].number).toBe(10);
    expect(snap.entities[0].modelindex).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// D. sv_mvd.ts -- recording integration (mvdrecord/mvdstop e2e)
// ---------------------------------------------------------------------------

describe("SV_MvdRecord_f / SV_MvdStop_f -- live dedicated-server recording e2e", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mvd-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    FS_InitFilesystem();

    const maxclients = Cvar_Get("maxclients", "2", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 2;
    }

    sv.state = ServerStateT.ss_game;
    svs.spawncount = 1;
    sv.configstrings[0] = "e2eroom";

    SV_MvdResetForTests();
  });

  afterEach(() => {
    SV_MvdResetForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
    sv.state = ServerStateT.ss_dead;
    geHolder.ge = null;
    svs.clients = [];
  });

  test("refuses to record when no server is running", () => {
    sv.state = ServerStateT.ss_dead;
    Cmd_TokenizeString("mvdrecord e2etest", false);
    SV_MvdRecord_f();
    expect(SV_MvdIsActive()).toBe(false);
  });

  test("SV_MvdStop_f reports nothing to do when not recording", () => {
    expect(() => SV_MvdStop_f()).not.toThrow();
    expect(SV_MvdIsActive()).toBe(false);
  });

  test("records N frames of two moving players plus one entity, then a parsed reload matches the live final state", () => {
    const ps0 = makePlayerState([0, 0, 0], 90, 100, 0);
    const ps1 = makePlayerState([50, 0, 0], 90, 100, 0);
    const player0 = makeEdict([0, 0, 0], { ps: ps0 });
    const player1 = makeEdict([50, 0, 0], { ps: ps1 });
    player0.s.number = 1;
    player1.s.number = 2;

    const barrel = makeEdict([5, 5, 5], null);
    barrel.s.number = 3;
    barrel.s.modelindex = 77;

    const edicts: Edict[] = [makeEdict([0, 0, 0], null), player0, player1, barrel];
    geHolder.ge = makeFakeGameExports(edicts);

    const cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0;
    const cl1 = new ClientT();
    cl1.state = ClientStateT.cs_spawned;
    cl1.edict = player1;
    svs.clients = [cl0, cl1];

    Cmd_TokenizeString("mvdrecord e2etest", false);
    SV_MvdRecord_f();
    expect(SV_MvdIsActive()).toBe(true);

    const FRAME_COUNT = 5;
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      ps0.pmove.origin[0] = frame * 10;
      ps1.pmove.origin[1] = frame * 4;
      barrel.s.origin[2] = 5 + frame;

      SV_MvdBeginFrame();
      SV_MvdEndFrame();
    }

    SV_MvdStop_f();
    expect(SV_MvdIsActive()).toBe(false);

    const filePath = `${FS_Gamedir()}/demos/e2etest.mvd2`;
    const bytes = new Uint8Array(readFileSync(filePath));
    const channel = MVD_LoadFile(bytes);

    expect(channel.state).toBe(MvdChannelStateT.MVD_READING);
    // final frame values: frame index FRAME_COUNT-1
    const lastFrame = FRAME_COUNT - 1;
    expect(channel.players[0]).not.toBeNull();
    expect(channel.players[0]?.pmove.origin[0]).toBe(lastFrame * 10);
    expect(channel.players[1]).not.toBeNull();
    expect(channel.players[1]?.pmove.origin[1]).toBe(lastFrame * 4);

    const barrelEntity = channel.entities[3];
    expect(barrelEntity).not.toBeNull();
    expect(barrelEntity?.origin[2]).toBe(5 + lastFrame);
    expect(barrelEntity?.modelindex).toBe(77);

    const snap = MVD_Snapshot(channel);
    expect(snap.players).toHaveLength(2);
    expect(snap.mapname).toBe("e2eroom");
  });

  test("a player who disconnects mid-recording is removed from the parsed channel", () => {
    const ps0 = makePlayerState([1, 1, 1], 90, 100, 0);
    const player0 = makeEdict([1, 1, 1], { ps: ps0 });
    player0.s.number = 1;

    const edicts: Edict[] = [makeEdict([0, 0, 0], null), player0];
    geHolder.ge = makeFakeGameExports(edicts);

    const cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0;
    svs.clients = [cl0];

    const maxclients = Cvar_Get("maxclients", "2", 0);
    if (maxclients) maxclients.value = 1;

    Cmd_TokenizeString("mvdrecord disconnecttest", false);
    SV_MvdRecord_f();

    SV_MvdBeginFrame();
    SV_MvdEndFrame(); // player active

    cl0.state = ClientStateT.cs_free; // simulate disconnect
    SV_MvdBeginFrame();
    SV_MvdEndFrame(); // player removed

    SV_MvdStop_f();

    const filePath = `${FS_Gamedir()}/demos/disconnecttest.mvd2`;
    const bytes = new Uint8Array(readFileSync(filePath));
    const channel = MVD_LoadFile(bytes);

    expect(channel.players[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E. GTV handshake over real local TCP sockets
// ---------------------------------------------------------------------------

describe("GTV handshake and live stream relay over local TCP", () => {
  afterEach(() => {
    SV_MvdResetForTests();
  });

  test("a GTV client connects, completes the hello/stream-start handshake, and receives the gamestate", async () => {
    // sv.state must be ss_game and a fake game must be present for
    // mvdEnable()'s buildGamestate() call (triggered by GTC_STREAM_START) to
    // succeed without throwing.
    sv.state = ServerStateT.ss_game;
    geHolder.ge = makeFakeGameExports([makeEdict([0, 0, 0], null)]);
    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 1;
    }
    svs.clients = [];

    const listenerId = await TCP_Listen("127.0.0.1", 0);
    expect(listenerId).not.toBeNull();
    if (listenerId === null) return;
    SV_MvdSetGtvListenerForTests(listenerId);

    const port = TCP_ListenerPort(listenerId);
    const link = await MVD_GtvConnect("127.0.0.1", port);
    expect(link).not.toBeNull();
    if (!link) return;

    // Drive both sides (server's accept/parse loop, client's handshake
    // state machine) until the client reaches STREAMING or a timeout.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && link.state !== GtvClientLinkStateT.STREAMING) {
      SV_MvdRunGtv();
      MVD_GtvPump(link);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(link.state).toBe(GtvClientLinkStateT.STREAMING);
    expect(link.channel.state).toBe(MvdChannelStateT.MVD_READING);
  }, 5000);
});

// ---------------------------------------------------------------------------
// F. SV_MvdMulticast/SV_MvdUnicast/SV_MvdStartSound capture hooks (item 1)
// ---------------------------------------------------------------------------

describe("SV_MvdMulticast/SV_MvdUnicast/SV_MvdStartSound capture hooks", () => {
  let tmpRoot: string;
  let player0: Edict;
  let cl0: ClientT;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mvd-hooks-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    FS_InitFilesystem();

    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 1;
    }
    Cvar_Get("sv_mvd_spawn_dummy", "1", 0)!.value = 0; // dummy client is a separate unit (section G)

    sv.state = ServerStateT.ss_game;
    svs.spawncount = 1;
    sv.configstrings[0] = "hookroom";
    // Normally SV_SpawnServer's job (sv_init.ts); these tests call
    // SV_Multicast/PF_Unicast/SV_StartSound directly without spinning up a
    // full server, so sv.multicast needs its backing buffer set up by hand.
    SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);

    const ps0 = makePlayerState([1, 1, 1], 90, 100, 0);
    player0 = makeEdict([1, 1, 1], { ps: ps0 });
    player0.s.number = 1;
    geHolder.ge = makeFakeGameExports([makeEdict([0, 0, 0], null), player0]);

    cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0;
    // Normally set up by SV_DirectConnect; SV_Multicast/PF_Unicast write
    // straight into these buffers, so they need real backing storage.
    SZ_Init(cl0.netchan.message, cl0.netchan.message_buf, cl0.netchan.message_buf.length);
    SZ_Init(cl0.datagram, cl0.datagram_buf, cl0.datagram_buf.length);
    svs.clients = [cl0];

    SV_MvdResetForTests();
  });

  afterEach(() => {
    SV_MvdResetForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
    sv.state = ServerStateT.ss_dead;
    geHolder.ge = null;
    svs.clients = [];
  });

  function recordOneFrameAndLoad(name: string): ReturnType<typeof MVD_LoadFile> {
    Cmd_TokenizeString(`mvdrecord ${name}`, false);
    SV_MvdRecord_f();
    expect(SV_MvdIsActive()).toBe(true);
    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();
    const filePath = `${FS_Gamedir()}/demos/${name}.mvd2`;
    return MVD_LoadFile(new Uint8Array(readFileSync(filePath)));
  }

  test("a reliable SV_Multicast(MULTICAST_ALL_R) lands in the recording as a decodable multicast segment", () => {
    Cmd_TokenizeString("mvdrecord multicasttest", false);
    SV_MvdRecord_f();

    MSG_WriteByte(sv.multicast, SvcOpsT.svc_print);
    MSG_WriteByte(sv.multicast, PRINT_HIGH);
    MSG_WriteString(sv.multicast, "hi\n");
    SV_Multicast(null, MulticastT.MULTICAST_ALL_R);

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/multicasttest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    const events = channel.events.filter((e) => e.kind === "multicast");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ kind: "multicast", base: 0, reliable: true });
  });

  test("PF_Unicast delivers a reliable print to an active player as a decodable unicast segment", () => {
    Cmd_TokenizeString("mvdrecord unicasttest", false);
    SV_MvdRecord_f();

    MSG_WriteByte(sv.multicast, SvcOpsT.svc_print);
    MSG_WriteByte(sv.multicast, PRINT_HIGH);
    MSG_WriteString(sv.multicast, "hi\n");
    PF_Unicast(player0, true);

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/unicasttest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    const events = channel.events.filter((e) => e.kind === "unicast");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "unicast", reliable: true, clientNum: 0 });
  });

  test("PF_Unicast discards a plain stufftext (not a play-sound hack)", () => {
    Cmd_TokenizeString("mvdrecord stufftexttest", false);
    SV_MvdRecord_f();

    MSG_WriteByte(sv.multicast, SvcOpsT.svc_stufftext);
    MSG_WriteString(sv.multicast, "kick\n");
    PF_Unicast(player0, true);

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/stufftexttest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    expect(channel.events.filter((e) => e.kind === "unicast")).toHaveLength(0);
  });

  test("PF_Unicast keeps a 'play <sound>' stufftext hack", () => {
    Cmd_TokenizeString("mvdrecord playhacktest", false);
    SV_MvdRecord_f();

    MSG_WriteByte(sv.multicast, SvcOpsT.svc_stufftext);
    MSG_WriteString(sv.multicast, "play sound/misc/hit.wav\n");
    PF_Unicast(player0, true);

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/playhacktest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    expect(channel.events.filter((e) => e.kind === "unicast")).toHaveLength(1);
  });

  test("PF_Unicast discards traffic addressed to a non-active (unspawned) player", () => {
    cl0.state = ClientStateT.cs_connected; // never reached cs_spawned
    Cmd_TokenizeString("mvdrecord inactiveunicasttest", false);
    SV_MvdRecord_f();

    MSG_WriteByte(sv.multicast, SvcOpsT.svc_print);
    MSG_WriteByte(sv.multicast, PRINT_HIGH);
    MSG_WriteString(sv.multicast, "hi\n");
    PF_Unicast(player0, true);

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/inactiveunicasttest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    expect(channel.events.filter((e) => e.kind === "unicast")).toHaveLength(0);
  });

  test("SV_StartSound lands in the recording as a decodable sound segment", () => {
    const barrel = makeEdict([1, 2, 3], null);
    barrel.s.number = 1;

    const channel = recordOneFrameAndLoadWithSound(barrel);
    const events = channel.events.filter((e) => e.kind === "sound");
    expect(events.length).toBeGreaterThan(0);
  });

  function recordOneFrameAndLoadWithSound(entity: Edict): ReturnType<typeof MVD_LoadFile> {
    Cmd_TokenizeString("mvdrecord soundtest", false);
    SV_MvdRecord_f();
    // attenuation 0 (ATTN_NONE) routes through MULTICAST_ALL instead of
    // MULTICAST_PHS, avoiding a dependency on a real loaded collision model
    // (CM_ClusterPVS) this lightweight test setup does not have.
    SV_StartSound(null, entity, 0, 5, 1.0, 0, 0);
    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();
    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/soundtest.mvd2`));
    return MVD_LoadFile(bytes);
  }
});

// ---------------------------------------------------------------------------
// G. MVD dummy client (item 2)
// ---------------------------------------------------------------------------

describe("MVD dummy client", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mvd-dummy-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    FS_InitFilesystem();

    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 1;
    }
    Cvar_Get("sv_mvd_spawn_dummy", "1", 0)!.value = 1;

    sv.state = ServerStateT.ss_game;
    svs.spawncount = 1;
    sv.configstrings[0] = "dummyroom";
    svs.clients = [];

    SV_MvdResetForTests();
  });

  afterEach(() => {
    SV_MvdResetForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
    sv.state = ServerStateT.ss_dead;
    geHolder.ge = null;
    svs.clients = [];
  });

  test("dummyCreate connects and spawns a dummy client when recording starts, captured despite PM_SPECTATOR", () => {
    const dummyPs = makePlayerState([0, 0, 0], 90, 0, 0);
    dummyPs.pmove.pm_type = PmTypeT.PM_SPECTATOR;
    const worldEdict = makeEdict([0, 0, 0], null);
    const dummyEdict = makeEdict([0, 0, 0], null);
    geHolder.ge = makeFakeGameExportsWithDummy([worldEdict, dummyEdict], dummyPs);

    Cmd_TokenizeString("mvdrecord dummytest", false);
    SV_MvdRecord_f();
    expect(SV_MvdIsActive()).toBe(true);
    expect(svs.clients[0]?.state).toBe(ClientStateT.cs_spawned);

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/dummytest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    expect(channel.clientNum).toBe(0); // gamestate's dummy client slot
    expect(channel.players[0]).not.toBeNull(); // captured despite being a spectator
  });

  test("no free client slot leaves recording working without a dummy (graceful failure)", () => {
    const dummyPs = makePlayerState([0, 0, 0], 90, 0, 0);
    const worldEdict = makeEdict([0, 0, 0], null);
    const player0Edict = makeEdict([2, 2, 2], { ps: makePlayerState([2, 2, 2], 90, 100, 0) });
    player0Edict.s.number = 1;
    geHolder.ge = makeFakeGameExportsWithDummy([worldEdict, player0Edict], dummyPs);

    const cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0Edict;
    svs.clients = [cl0]; // the server's one slot is already taken

    Cmd_TokenizeString("mvdrecord fulltest", false);
    expect(() => SV_MvdRecord_f()).not.toThrow();
    expect(SV_MvdIsActive()).toBe(true);
    SV_MvdStop_f();
  });

  test("the dummy client slot is freed once recording stops and no GTV client needs it", () => {
    const dummyPs = makePlayerState([0, 0, 0], 90, 0, 0);
    const worldEdict = makeEdict([0, 0, 0], null);
    const dummyEdict = makeEdict([0, 0, 0], null);
    geHolder.ge = makeFakeGameExportsWithDummy([worldEdict, dummyEdict], dummyPs);

    Cmd_TokenizeString("mvdrecord teardowntest", false);
    SV_MvdRecord_f();
    expect(svs.clients[0]?.state).toBe(ClientStateT.cs_spawned);

    SV_MvdStop_f();
    expect(svs.clients[0]?.state).toBe(ClientStateT.cs_free);
  });
});

// ---------------------------------------------------------------------------
// H. SV_MvdMapChanged wiring (item 3)
// ---------------------------------------------------------------------------

describe("SV_MvdMapChanged", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mvd-mapchange-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    FS_InitFilesystem();

    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 1;
    }
    Cvar_Get("sv_mvd_spawn_dummy", "1", 0)!.value = 0;

    sv.state = ServerStateT.ss_game;
    svs.spawncount = 1;
    sv.configstrings[0] = "maproom";

    SV_MvdResetForTests();
  });

  afterEach(() => {
    SV_MvdResetForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
    sv.state = ServerStateT.ss_dead;
    geHolder.ge = null;
    svs.clients = [];
  });

  test("rebuilds the delta-compressor baseline while recording is active, forcing a full re-send next frame", () => {
    const ps0 = makePlayerState([9, 9, 9], 90, 100, 0);
    const player0 = makeEdict([9, 9, 9], { ps: ps0 });
    player0.s.number = 1;
    geHolder.ge = makeFakeGameExports([makeEdict([0, 0, 0], null), player0]);

    const cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0;
    svs.clients = [cl0];

    Cmd_TokenizeString("mvdrecord mapchangetest", false);
    SV_MvdRecord_f();
    SV_MvdBeginFrame();
    SV_MvdEndFrame(); // baseline now includes player0 at [9,9,9]

    // SV_SpawnServer's client loop would downgrade every connected client
    // (cl0 included) below cs_spawned here; simulate that, then verify
    // SV_MvdMapChanged (now wired into SV_SpawnServer, sv_init.ts) both
    // rebuilds the baseline AND is what a real map change relies on to keep
    // capturing this player at all.
    SV_MvdMapChanged();

    // Unchanged origin, but the baseline was wiped -- the next frame must
    // still emit a full player record (proving buildGamestate() actually
    // reran), not "nothing changed, skip".
    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/mapchangetest.mvd2`));
    const channel = MVD_LoadFile(bytes);
    expect(channel.players[0]).not.toBeNull();
    expect(channel.players[0]?.pmove.origin[0]).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// I. Kex/rerelease MVD sub-protocol (item 4)
// ---------------------------------------------------------------------------

describe("Kex/rerelease MVD sub-protocol", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mvd-kex-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    // Pre-register with the engine's real default+flags (files.ts:1189) so
    // this throwaway override can never become the cvar's default_string via
    // Cvar_Get's first-registration-wins contract (the pristine-order
    // pollution class the order-independence pass closed).
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "kex");
    FS_InitFilesystem();

    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 1;
    }
    Cvar_Get("sv_mvd_spawn_dummy", "1", 0)!.value = 0;

    sv.state = ServerStateT.ss_game;
    svs.spawncount = 1;
    sv.configstrings[0] = "kexroom";

    SV_MvdResetForTests();
  });

  afterEach(() => {
    SV_MvdResetForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
    sv.state = ServerStateT.ss_dead;
    geHolder.ge = null;
    svs.clients = [];
    Cvar_ForceSet("game", "");
  });

  test("mvdrecord no longer refuses under game=kex, and rerelease playerstate fields round-trip", () => {
    const ps0 = makePlayerState([10, 20, 30], 90, 100, 5);
    ps0.viewoffset[0] = 7.5;
    ps0.viewoffset[1] = -3.25;
    ps0.viewoffset[2] = 1;
    ps0.gunframe = 300; // exceeds a byte -- proves the short (not char) encoding is in play
    ps0.damage_blend[0] = 0.5;
    ps0.damage_blend[1] = 0.25;
    ps0.damage_blend[2] = 0;
    ps0.damage_blend[3] = 1;
    ps0.stats[10] = 777;

    const player0 = makeEdict([10, 20, 30], { ps: ps0 });
    player0.s.number = 1;
    geHolder.ge = makeFakeGameExports([makeEdict([0, 0, 0], null), player0]);

    const cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0;
    svs.clients = [cl0];

    Cmd_TokenizeString("mvdrecord kextest", false);
    SV_MvdRecord_f();
    expect(SV_MvdIsActive()).toBe(true); // no longer refuses under game=kex

    SV_MvdBeginFrame();
    SV_MvdEndFrame();
    SV_MvdStop_f();

    const bytes = new Uint8Array(readFileSync(`${FS_Gamedir()}/demos/kextest.mvd2`));
    const channel = MVD_LoadFile(bytes);

    expect(channel.rerelease).toBe(true);
    const ps = channel.players[0];
    expect(ps).not.toBeNull();
    expect(ps?.viewoffset[0]).toBeCloseTo(7.5, 3);
    expect(ps?.viewoffset[1]).toBeCloseTo(-3.25, 3);
    expect(ps?.gunframe).toBe(300);
    expect(ps?.damage_blend[0]).toBeCloseTo(0.5, 2);
    expect(ps?.damage_blend[3]).toBeCloseTo(1, 2);
    expect(ps?.stats[10]).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// J. GTV hardening: auth handshake and connection cap (item 5)
// ---------------------------------------------------------------------------

describe("GTV hardening: auth handshake and connection cap", () => {
  beforeEach(() => {
    Cvar_Get("sv_mvd_password", "", 0)!.string = "";
    Cvar_Get("sv_mvd_maxclients", "8", 0)!.value = 8;
  });

  afterEach(() => {
    SV_MvdResetForTests();
    Cvar_Get("sv_mvd_password", "", 0)!.string = "";
    Cvar_Get("sv_mvd_maxclients", "8", 0)!.value = 8;
  });

  async function driveUntil(link: { state: GtvClientLinkStateT }, target: GtvClientLinkStateT, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && link.state !== target) {
      SV_MvdRunGtv();
      MVD_GtvPump(link as Parameters<typeof MVD_GtvPump>[0]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function setupServer(): Promise<number> {
    sv.state = ServerStateT.ss_game;
    geHolder.ge = makeFakeGameExports([makeEdict([0, 0, 0], null)]);
    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) {
      setMaxclients(maxclients);
      maxclients.value = 1;
    }
    svs.clients = [];
    const listenerId = await TCP_Listen("127.0.0.1", 0);
    expect(listenerId).not.toBeNull();
    SV_MvdSetGtvListenerForTests(listenerId);
    return TCP_ListenerPort(listenerId as number);
  }

  test("a GTV client with the wrong password is rejected", async () => {
    Cvar_Get("sv_mvd_password", "", 0)!.string = "secret";
    const port = await setupServer();

    const link = await MVD_GtvConnect("127.0.0.1", port, { password: "wrong" });
    expect(link).not.toBeNull();
    if (!link) return;

    await driveUntil(link, GtvClientLinkStateT.CLOSED);
    expect(link.state).toBe(GtvClientLinkStateT.CLOSED);
  }, 5000);

  test("a GTV client with the correct password streams normally", async () => {
    Cvar_Get("sv_mvd_password", "", 0)!.string = "secret";
    const port = await setupServer();

    const link = await MVD_GtvConnect("127.0.0.1", port, { password: "secret" });
    expect(link).not.toBeNull();
    if (!link) return;

    await driveUntil(link, GtvClientLinkStateT.STREAMING);
    expect(link.state).toBe(GtvClientLinkStateT.STREAMING);
  }, 5000);

  test("an empty sv_mvd_password allows any (or no) password", async () => {
    const port = await setupServer();

    const link = await MVD_GtvConnect("127.0.0.1", port, { password: "anything" });
    expect(link).not.toBeNull();
    if (!link) return;

    await driveUntil(link, GtvClientLinkStateT.STREAMING);
    expect(link.state).toBe(GtvClientLinkStateT.STREAMING);
  }, 5000);

  test("sv_mvd_maxclients bounds the number of simultaneously connected GTV clients", async () => {
    Cvar_Get("sv_mvd_maxclients", "8", 0)!.value = 1;
    const port = await setupServer();

    const link1 = await MVD_GtvConnect("127.0.0.1", port);
    expect(link1).not.toBeNull();
    if (!link1) return;
    await driveUntil(link1, GtvClientLinkStateT.STREAMING);
    expect(link1.state).toBe(GtvClientLinkStateT.STREAMING);

    const link2 = await MVD_GtvConnect("127.0.0.1", port);
    expect(link2).not.toBeNull();
    if (!link2) return;
    await driveUntil(link2, GtvClientLinkStateT.CLOSED);
    expect(link2.state).toBe(GtvClientLinkStateT.CLOSED);
  }, 8000);

  test("GTF_DEFLATE: a client requesting compression gets a working compressed stream", async () => {
    const port = await setupServer();

    const link = await MVD_GtvConnect("127.0.0.1", port, { requestDeflate: true });
    expect(link).not.toBeNull();
    if (!link) return;

    await driveUntil(link, GtvClientLinkStateT.STREAMING);
    expect(link.state).toBe(GtvClientLinkStateT.STREAMING);
    expect(link.deflate).toBe(true);
    // The gamestate payload only decoded successfully if inflate ran (a
    // still-deflated buffer would fail MVD_ParseMessage's opcode checks).
    expect(link.channel.state).toBe(MvdChannelStateT.MVD_READING);
  }, 5000);
});
