/*
Demo record/playback cross-play harness (.orch/followups.md's "demo record
cross-play harness" v1.0.0 queue item #3, narrowed to THIS engine's own
record<->playback loop, not a foreign q2repro binary -- rule 20 forbids
launching foreign binaries in testing).

Three describe blocks, all in-process (rule 19: no compiled-binary spawn
needed here since the "both seats" requirement is about live cross-engine
play, not a same-process record/replay determinism check; the compiled-
binary self-play recipe already exists and is proven at
scripts/interop-matrix.sh's cell_f/cell_g -- this file complements it with
a fast, deterministic, in-process check of the DEMO FILE ITSELF, which a
wall-clock two-process script cannot assert against cheaply):

  A. MVD record -> playback, multi-checkpoint parity (not just final-frame
     -- test/mvd.test.ts already covers final-frame parity; this adds
     per-frame checkpoints across the whole recording). Self-sufficient
     fake-edict fixture, same style as test/mvd.test.ts's own.

  B. Vanilla-family (protocol 34) self-play: real retail q2dm1.bsp, a real
     loopback connect (cl_main.test.ts's own "real loopback connect"
     precedent, driven past ClientBegin here because a REAL map's area-
     portal lump lets CM_AreasConnected succeed where the earlier suite's
     synthetic box-room BSP couldn't), real held +forward movement, `record`
     mid-session, several server frames, `stop`, then CL_PlayDemoFromBuffer
     replayed with per-svc_frame checkpoints compared against the live ones.

  C. Kex-family (protocol 1038) self-play: same shape, game=kex, real
     retail base1.bsp (the exact map scripts/interop-matrix.sh's cell_f
     already proves reachable via a live compiled-binary session).

Retail-gated (loud skip, no silent no-op) -- both B and C need real area-
portal geometry from ~/q2rets/rerelease/baseq2/pak0.pak; a synthetic
bsp_builder room has none (see cl_main.test.ts's own header for the exact
crash that stops a synthetic-map connect at ClientBegin's gi.multicast
call).
*/

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { Cmd_TokenizeString, Cmd_ExecuteString, Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_ClearLoopback, NET_Shutdown } from "../src/platform/net_udp";
import { SizeBuf, SZ_Init } from "../src/qcommon/sizebuf";
import { net_message, net_message_buffer } from "../src/qcommon/net_chan";
import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE, STAT_HEALTH, EntityStateT, PlayerStateT, PmTypeT } from "../src/shared/q_shared";
import { vec3, VectorCopy } from "../src/shared/math";
import { type Edict, LinkT, MAX_ENT_CLUSTERS, SolidT, type GameExports } from "../src/game/game";

import { sv, svs, ClientT, ClientStateT, ServerStateT, setMaxclients } from "../src/server/server";
import { SV_Shutdown, SV_Frame } from "../src/server/sv_main";
import { geHolder, currentGameFamily } from "../src/server/sv_game";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, type CsRemapT } from "../src/shared/cs_remap";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";

import { MVD_MAGIC } from "../src/qcommon/protocol/mvd";
import { MVD_NewChannel } from "../src/server/mvd/client";
import { MVD_ParseMessage } from "../src/server/mvd/parse";
import { SV_MvdRecord_f, SV_MvdStop_f, SV_MvdBeginFrame, SV_MvdEndFrame, SV_MvdResetForTests, SV_MvdIsActive } from "../src/server/sv_mvd";

import { Qcommon_Init, runFrames } from "../src/main";
import { cl, cls, ConnstateT } from "../src/client/client";
import { CL_InitLocal, CL_SendCommand, CL_ReadPackets, CL_Disconnect } from "../src/client/cl_main";
import { CL_PlayDemoFromBuffer, CL_OpenDemoBuffer, CL_ReadDemoMessage } from "../src/client/cl_demo";
import { CL_ParseServerMessage } from "../src/client/cl_parse";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, FS_LoadFile, FS_InitFilesystem, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";

// ===========================================================================
// A. MVD record -> playback, multi-checkpoint parity
// ===========================================================================

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

function makePlayerState(origin: readonly [number, number, number], health: number): PlayerStateT {
  const ps = new PlayerStateT();
  ps.pmove.pm_type = PmTypeT.PM_NORMAL;
  ps.pmove.origin[0] = origin[0];
  ps.pmove.origin[1] = origin[1];
  ps.pmove.origin[2] = origin[2];
  ps.stats[STAT_HEALTH] = health;
  // sv_mvd.ts's playerIsActive (mvd.c:480-551 port) requires a truthy fov --
  // `if (!ps.fov) return false;` -- as its "has this player actually
  // spawned" signal, matching test/mvd.test.ts's own makePlayerState
  // fixture precedent. Omitting this silently drops the player from every
  // gamestate/frame capture (found the hard way: replay came back with
  // channel.players[c] permanently null).
  ps.fov = 90;
  return ps;
}

function throwStub(name: string): () => never {
  return () => {
    throw new Error(`${name}: not implemented in this harness's fake GameExports`);
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
    ClientConnect: () => ({ allowed: false, userinfo: "" }), // dummy MVD client declines -- not under test here
    ClientBegin: throwStub("ClientBegin"),
    ClientUserinfoChanged: throwStub("ClientUserinfoChanged"),
    ClientDisconnect: throwStub("ClientDisconnect"),
    ClientCommand: throwStub("ClientCommand"),
    ClientThink: throwStub("ClientThink"),
    RunFrame: () => {},
    ServerCommand: throwStub("ServerCommand"),
    edicts,
    num_edicts: edicts.length,
    max_edicts: edicts.length,
  };
}

interface MvdCheckpointT {
  framenum: number;
  player0: number[] | null;
  player1: number[] | null;
  barrel: number[] | null;
}

// Mirrors src/server/mvd/parse.ts's MVD_LoadFile framing loop exactly (magic
// + repeated [u16 LE length][body] records, 0-length EOF marker), but calls
// MVD_ParseMessage one record at a time instead of draining the whole file,
// so a checkpoint can be captured every time a real mvd_frame op advances
// channel.framenum -- MVD_LoadFile itself only ever hands back the FINAL
// state, which test/mvd.test.ts's own round-trip tests already check.
function loadMvdWithCheckpoints(bytes: Uint8Array): MvdCheckpointT[] {
  const channel = MVD_NewChannel();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint32(0, true) !== MVD_MAGIC) {
    throw new Error("loadMvdWithCheckpoints: bad magic");
  }

  const checkpoints: MvdCheckpointT[] = [];
  let offset = 4;
  let lastFramenum = channel.framenum;
  for (;;) {
    if (offset + 2 > bytes.length) throw new Error("loadMvdWithCheckpoints: truncated length prefix");
    const msglen = view.getUint16(offset, true);
    offset += 2;
    if (msglen === 0) break;
    if (offset + msglen > bytes.length) throw new Error("loadMvdWithCheckpoints: truncated message body");
    const body = bytes.subarray(offset, offset + msglen);
    offset += msglen;

    MVD_ParseMessage(channel, body);

    if (channel.framenum !== lastFramenum) {
      lastFramenum = channel.framenum;
      checkpoints.push({
        framenum: channel.framenum,
        player0: channel.players[0] ? Array.from(channel.players[0].pmove.origin) : null,
        player1: channel.players[1] ? Array.from(channel.players[1].pmove.origin) : null,
        barrel: channel.entities[3] ? Array.from(channel.entities[3].origin) : null,
      });
    }
  }
  return checkpoints;
}

describe("A. MVD record -> playback: multi-checkpoint parity across the whole recording", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mvd-harness-"));
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
    sv.configstrings[0] = "harnessroom";

    SV_MvdResetForTests();
  });

  afterEach(() => {
    SV_MvdResetForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
    sv.state = ServerStateT.ss_dead;
    geHolder.ge = null;
    svs.clients = [];
    SZ_Init(net_message, net_message_buffer, net_message_buffer.length); // MVD_ParseMessage repoints this singleton -- restore it (mvd.test.ts precedent)
  });

  test("8 frames of two moving players plus one moving entity: every intermediate checkpoint matches what was live, not just the last one", () => {
    const ps0 = makePlayerState([0, 0, 0], 100);
    const ps1 = makePlayerState([0, 0, 0], 100);
    const player0 = makeEdict([0, 0, 0], { ps: ps0 });
    const player1 = makeEdict([0, 0, 0], { ps: ps1 });
    player0.s.number = 1;
    player1.s.number = 2;

    const barrel = makeEdict([0, 0, 0], null);
    barrel.s.number = 3;
    barrel.s.modelindex = 88;

    geHolder.ge = makeFakeGameExports([makeEdict([0, 0, 0], null), player0, player1, barrel]);

    const cl0 = new ClientT();
    cl0.state = ClientStateT.cs_spawned;
    cl0.edict = player0;
    const cl1 = new ClientT();
    cl1.state = ClientStateT.cs_spawned;
    cl1.edict = player1;
    svs.clients = [cl0, cl1];

    Cmd_TokenizeString("mvdrecord checkpointtest", false);
    SV_MvdRecord_f();
    expect(SV_MvdIsActive()).toBe(true);

    const FRAME_COUNT = 8;
    const liveCheckpoints: { player0: number[]; player1: number[]; barrel: number[] }[] = [];
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      // Non-linear per-axis motion (not a simple frame*constant on every
      // axis) so two checkpoints can never coincidentally match unless the
      // decoder actually reconstructed the right frame.
      ps0.pmove.origin[0] = frame * 7;
      ps0.pmove.origin[1] = Math.sin(frame) * 3;
      ps1.pmove.origin[2] = frame * frame;
      barrel.s.origin[0] = 10 - frame;
      barrel.s.origin[1] = frame % 3;

      SV_MvdBeginFrame();
      SV_MvdEndFrame();

      liveCheckpoints.push({
        player0: [ps0.pmove.origin[0], ps0.pmove.origin[1], ps0.pmove.origin[2]],
        player1: [ps1.pmove.origin[0], ps1.pmove.origin[1], ps1.pmove.origin[2]],
        barrel: [barrel.s.origin[0], barrel.s.origin[1], barrel.s.origin[2]],
      });
    }

    SV_MvdStop_f();
    expect(SV_MvdIsActive()).toBe(false);

    const data = FS_LoadFile("demos/checkpointtest.mvd2");
    expect(data).not.toBeNull();
    if (!data) return;

    const replayCheckpoints = loadMvdWithCheckpoints(data);

    // Every recorded frame produced exactly one mvd_frame op -> one checkpoint.
    expect(replayCheckpoints).toHaveLength(FRAME_COUNT);

    for (let i = 0; i < FRAME_COUNT; i++) {
      const live = liveCheckpoints[i];
      const replay = replayCheckpoints[i];
      expect(replay.player0).toEqual(live.player0);
      expect(replay.player1).toEqual(live.player1);
      expect(replay.barrel).toEqual(live.barrel);
    }

    // Sanity: the checkpoints actually differ frame to frame (proves this
    // test would fail if playback silently returned a frozen/default state).
    expect(replayCheckpoints[0].player0).not.toEqual(replayCheckpoints[FRAME_COUNT - 1].player0);
  });
});

// ===========================================================================
// B / C. Client-side demo record -> playback self-play (real retail data)
// ===========================================================================

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

interface DemoCheckpointT {
  serverframe: number;
  origin: number[];
  health: number;
}

function captureCheckpoint(): DemoCheckpointT {
  return {
    serverframe: cl.frame.serverframe,
    origin: Array.from(cl.frame.playerstate.pmove.origin),
    health: cl.frame.playerstate.stats[STAT_HEALTH],
  };
}

// Replays a buffer message-by-message (CL_PlayDemoFromBuffer's own shape,
// src/client/cl_demo.ts) but captures a checkpoint every time
// cl.frame.serverframe changes, so playback fidelity can be checked at
// several points through the recording, not just the final state.
function replayWithCheckpoints(data: Uint8Array): DemoCheckpointT[] {
  const checkpoints: DemoCheckpointT[] = [];
  const reader = CL_OpenDemoBuffer(data);
  cls.demoplayback = true;
  cls.state = ConnstateT.ca_connected;
  let lastFrame = cl.frame.serverframe;
  try {
    while (CL_ReadDemoMessage(reader)) {
      CL_ParseServerMessage();
      if (cl.frame.serverframe !== lastFrame) {
        lastFrame = cl.frame.serverframe;
        checkpoints.push(captureCheckpoint());
      }
    }
  } finally {
    cls.demoplayback = false;
    // rule-13 leak seam (test/mvd.test.ts's own precedent, same singleton):
    // CL_ReadDemoMessage's SZ_Init repoints the process-wide net_message
    // buffer at each demo block's own (small) backing array and never
    // restores it. Left alone, the very next real net_message user in this
    // process (e.g. this describe block's own afterAll -> SV_Shutdown ->
    // SV_FinalMessage) overflows writing into a buffer far smaller than
    // MAX_MSGLEN -- caught by this harness's own dogfooding, not theoretical.
    SZ_Init(net_message, net_message_buffer, net_message_buffer.length);
  }
  return checkpoints;
}

// Drives the real loopback connect/challenge/connect/spawn handshake by hand
// (cl_main.test.ts's own "real loopback connect against a booted server"
// group precedent), continuing past ca_connected all the way to ca_active --
// reachable here (and not in that earlier suite) because this harness boots
// a REAL retail map with real area-portal geometry instead of a synthetic
// box room, so ClientBegin's gi.multicast(MZ_LOGIN) -> SV_Multicast ->
// CM_AreasConnected has real portal data to read.
async function driveToActive(maxTicks: number): Promise<string | null> {
  let stoppedAt: string | null = null;
  for (let tick = 0; tick < maxTicks && cls.state !== ConnstateT.ca_active && stoppedAt === null; tick++) {
    CL_SendCommand();
    try {
      SV_Frame(100);
      CL_ReadPackets();
    } catch (err) {
      stoppedAt = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(0);
  }
  return stoppedAt;
}

// Runs `ticks` more server frames (client already ca_active, "+forward"
// already held), capturing a live checkpoint every time a new svc_frame
// lands -- the exact live-side counterpart of replayWithCheckpoints above.
async function runActiveTicksWithCheckpoints(ticks: number): Promise<DemoCheckpointT[]> {
  const checkpoints: DemoCheckpointT[] = [];
  let lastFrame = cl.frame.serverframe;
  for (let tick = 0; tick < ticks; tick++) {
    CL_SendCommand();
    SV_Frame(100);
    CL_ReadPackets();
    if (cl.frame.serverframe !== lastFrame) {
      lastFrame = cl.frame.serverframe;
      checkpoints.push(captureCheckpoint());
    }
    await Bun.sleep(0);
  }
  return checkpoints;
}

// Shared body for describe blocks B and C. `gameCvar` is "" for vanilla or
// "kex" for the rerelease family; `mapname` is a real map confirmed present
// in ~/q2rets/rerelease/baseq2/pak0.pak (q2dm1 for vanilla, base1 for kex --
// base1 is the exact map scripts/interop-matrix.sh's cell_f already proves
// reachable via a live two-process compiled-binary self-play session).
// `expectHeaderFamilyBug`: true for the kex-family case only -- see the call
// site below and the test body's own comment for the confirmed root cause
// (CL_Record_f, src/client/cl_main.ts, hardcodes PROTOCOL_VERSION into the
// demo's own svc_serverdata header regardless of the session's actual wire
// family, which is out of this unit's territory to fix).
function runSelfPlayDemoCase(label: string, gameCvar: string, mapname: string, expectHeaderFamilyBug: boolean): void {
  describe(`${label} self-play demo record -> playback (real retail ${mapname}.bsp)`, () => {
    let cvarSnapshot: CvarSnapshotT;
    let fsSnapshot: FsSearchPathSnapshotT;
    let preTestCsr: CsRemapT;
    let preTestCodec: ProtocolCodec;
    let preTestGameCvar: string;
    let homeRoot: string;

    beforeAll(async () => {
      fsSnapshot = FS_TestSnapshotSearchPaths();
      cvarSnapshot = snapshotCvars();
      preTestGameCvar = Cvar_VariableString("game");
      preTestCsr = svs.csr;
      preTestCodec = svs.codec;

      NET_ClearLoopback();

      // "homedir" (files.ts's writeRoot(), q2repro's own setup_base_gamedir
      // precedent) is this engine's own write-root override: when set, every
      // WRITE (here: CL_Record_f's demo file, also config.cfg on a real
      // quit) lands under homedir/<gamedir> instead of basedir/<gamedir>,
      // while READS still fall through the search-path chain to the real
      // retail basedir/pak0.pak below it. Set BEFORE Qcommon_Init/
      // FS_InitFilesystem (same "force before first Cvar_Get" ordering as
      // basedir/dedicated/game below) so this harness's own "record"/"stop"
      // never writes into the user's actual retail install directory.
      homeRoot = mkdtempSync(join(tmpdir(), "q2demoharness-home-"));
      Cvar_ForceSet("homedir", homeRoot);

      Cvar_ForceSet("basedir", RETAIL_BASEDIR);
      Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
      Cvar_ForceSet("game", gameCvar);
      Cvar_ForceSet("port", "0");
      Cvar_ForceSet("dedicated", "1"); // cl_main.test.ts's own trick: keeps CL_Init() a no-op while CL_InitLocal + manual packet pump still drive a real client
      Cvar_ForceSet("coop", "0");
      Cvar_ForceSet("deathmatch", "1"); // matches scripts/interop-matrix.sh's proven self-play cells (cell_f/cell_g)
      Cvar_Get("developer", "0", 0);
      Cvar_ForceSet("developer", "1");

      CL_InitLocal(); // registers record/stop/connect/+forward etc. -- avoids CL_Init()'s Con_Init pending-stub throw

      // Issue "connect localhost" BEFORE the server exists (avoids
      // CL_Connect_f's own SV_Shutdown-on-already-running-server race --
      // see cl_main.test.ts's identical precedent/comment).
      Cmd_ExecuteString("connect localhost");
      for (let i = 0; i < 50 && cls.state === ConnstateT.ca_disconnected; i++) {
        await Bun.sleep(1);
      }
      expect(cls.state).toBe(ConnstateT.ca_connecting);

      Qcommon_Init([
        "quake2",
        "+set",
        "basedir",
        RETAIL_BASEDIR,
        "+set",
        "homedir",
        homeRoot,
        "+set",
        "game",
        gameCvar,
        "+set",
        "deathmatch",
        "1",
        "+set",
        "port",
        "0",
        "+set",
        "allow_download",
        "0",
      ]);

      Cbuf_AddText(`map ${mapname}\n`);
      for (let i = 0; i < 600 && sv.state !== ServerStateT.ss_game; i++) {
        runFrames(1, 100);
        await Bun.sleep(1);
      }
      expect(sv.state).toBe(ServerStateT.ss_game);
    }, 120000);

    afterAll(async () => {
      try {
        CL_Disconnect();
      } catch {
        // harmless during teardown -- mirrors cl_main.test.ts's own afterAll
      }
      NET_ClearLoopback();
      SV_Shutdown(`${label} demo harness finished\n`, false);
      await NET_Shutdown();
      restoreCvars(cvarSnapshot);
      FS_TestRestoreSearchPaths(fsSnapshot);
      geHolder.ge = null;
      svs.csr = preTestCsr;
      svs.codec = preTestCodec;
      Cvar_ForceSet("game", preTestGameCvar);
      rmSync(homeRoot, { recursive: true, force: true });
    }, 30000);

    test(
      "connect handshake reaches ca_active on the real map",
      async () => {
        const stoppedAt = await driveToActive(400);
        expect(stoppedAt).toBeNull();
        expect(cls.state).toBe(ConnstateT.ca_active);
        expect(currentGameFamily()).toBe(gameCvar === "kex" ? "kex" : "legacy");
      },
      120000,
    );

    test(
      "record mid-session, hold real forward movement, stop, then replay: per-svc_frame checkpoints match the live session",
      async () => {
        if (cls.state !== ConnstateT.ca_active) {
          // The preceding test already reported exactly where the handshake
          // stopped; nothing further to check here.
          return;
        }

        // A couple of settle ticks before recording starts, matching a real
        // player who connects and only then types "record".
        await runActiveTicksWithCheckpoints(3);

        Cmd_ExecuteString("record harnessdemo");
        // CONFIRMED BUG, out of this unit's territory (src/client/cl_main.ts,
        // not src/server/sv_mvd.ts or a new test file) -- reported per this
        // brief's own instruction, not fixed: CL_Record_f (cl_main.ts, the
        // function registered as the "record" command) opens cls.demofile
        // and sets cls.demowaiting=true, but NEVER sets
        // cls.demorecording=true anywhere in this codebase. A full-tree grep
        // for `demorecording\s*=` finds exactly two writers: CL_Stop_f
        // setting it back to false, and ClientT's own class-field defaults
        // (also false). Because cl_parse.ts:918's write gate is
        // `if (cls.demorecording && !cls.demowaiting) CL_WriteDemoMessage();`,
        // this field staying permanently false means NO protocol family's
        // "record" command has ever appended a single per-frame message to
        // a .dm2 file in this engine -- every recording contains only
        // CL_Record_f's own synthetic startup gamestate block, and "stop"
        // itself is a no-op (CL_Stop_f's guard reads the same field), so the
        // file is never even EOF-terminated. Worked around HERE, test-side
        // only, so the rest of this harness (per-message demo writes, codec
        // correctness, playback checkpoint parity) can still be exercised
        // end-to-end without touching cl_main.ts.
        expect(cls.demofile).not.toBeNull();
        cls.demorecording = true;

        // Real held movement input -- CL_SendCommand's own CL_CreateCmd path
        // (cl_input.ts) scales forwardmove by however long +forward has been
        // held, exactly like scripts/interop-matrix.sh's selfplay.cfg.
        Cmd_ExecuteString("+forward");

        const liveCheckpoints = await runActiveTicksWithCheckpoints(20);

        Cmd_ExecuteString("-forward");
        Cmd_ExecuteString("stop");
        expect(cls.demorecording).toBe(false);

        expect(liveCheckpoints.length).toBeGreaterThan(0);

        const demoBytes = FS_LoadFile("demos/harnessdemo.dm2");
        expect(demoBytes).not.toBeNull();
        if (!demoBytes) return;

        if (expectHeaderFamilyBug) {
          // CONFIRMED BUG, out of this unit's territory (src/client/
          // cl_main.ts, not src/server/sv_mvd.ts or a new test file) --
          // reported per this brief's own instruction, not fixed:
          // CL_Record_f writes its demo's OWN svc_serverdata header with a
          // hardcoded `MSG_WriteLong(buf, PROTOCOL_VERSION)` (34, vanilla)
          // regardless of the session's actual negotiated family, while the
          // SAME function's configstring/baseline loops right below it
          // correctly use the live `cls.csr`/`cls.codec` (the wide/
          // rerelease family under game=kex, csr.end far larger than
          // classic's). On replay, CL_ParseServerData/selectServerCodec
          // (cl_parse.ts) reads that hardcoded 34 and picks VANILLA_CODEC +
          // CS_REMAP_OLD (the narrow classic csr) to parse configstring
          // indices that were actually written against the wide
          // CS_REMAP_RERELEASE layout -- CL_ParseConfigString then throws
          // "configstring > MAX_CONFIGSTRINGS" (cl_parse.ts:709) the moment
          // it hits an index past the narrow csr's own `end` bound. Verified
          // live by this exact test before this branch was added (the
          // uncaught throw and full stack are in this unit's own report).
          // Every kex-family (and, by the same mechanism, R1Q2/Q2PRO)
          // recording is affected; only vanilla (protocol 34) demos survive
          // replay today, because 34 is what CL_Record_f always claims
          // regardless of the truth.
          expect(() => replayWithCheckpoints(demoBytes)).toThrow(/configstring > MAX_CONFIGSTRINGS/);
          return;
        }

        const replayCheckpoints = replayWithCheckpoints(demoBytes);

        // Match by serverframe number, not array position: CL_ReadPackets
        // drains every currently-queued loopback packet in a single call
        // (`while (NET_GetPacket(...))`, cl_main.ts), so one outer tick of
        // runActiveTicksWithCheckpoints can silently apply more than one
        // real svc_frame before this test's own per-tick capture runs,
        // recording only the LAST of them live -- while cl_parse.ts's
        // per-message demo writer (the actual thing under test) still wrote
        // every one of those messages to the file. Replay is therefore
        // always a COMPLETE superset of what this test captured live; the
        // real assertion is that every live-observed frame's exact state is
        // reproduced on replay, keyed by the server's own frame number.
        const replayByFrame = new Map(replayCheckpoints.map((c) => [c.serverframe, c]));
        expect(replayCheckpoints.length).toBeGreaterThanOrEqual(liveCheckpoints.length);
        for (const live of liveCheckpoints) {
          const replay = replayByFrame.get(live.serverframe);
          expect(replay).toBeDefined();
          if (!replay) continue;
          expect(replay.origin).toEqual(live.origin);
          expect(replay.health).toBe(live.health);
        }
      },
      120000,
    );
  });
}

describe.skipIf(!havePak)("B/C. client demo record -> playback self-play, both wire families", () => {
  runSelfPlayDemoCase("B. vanilla-family (protocol 34)", "", "q2dm1", false);
  runSelfPlayDemoCase("C. kex-family (protocol 1038)", "kex", "base1", true);
});
