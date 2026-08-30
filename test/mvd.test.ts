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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_Gamedir } from "../src/qcommon/files";
import { SizeBuf, SZ_Init, MSG_WriteByte, MSG_WriteLong, MSG_WriteShort, MSG_WriteString } from "../src/qcommon/sizebuf";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { CS_REMAP_OLD } from "../src/shared/cs_remap";
import { EntityStateT, PlayerStateT, PmTypeT, MAX_EDICTS, STAT_HEALTH, STAT_FRAGS } from "../src/shared/q_shared";
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
import { SV_MvdRecord_f, SV_MvdStop_f, SV_MvdBeginFrame, SV_MvdEndFrame, SV_MvdResetForTests, SV_MvdIsActive, SV_MvdRunGtv, SV_MvdSetGtvListenerForTests } from "../src/server/sv_mvd";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { TCP_Listen, TCP_ListenerPort } from "../src/platform/net_tcp";

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
    ClientConnect: throwStub("ClientConnect"),
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
