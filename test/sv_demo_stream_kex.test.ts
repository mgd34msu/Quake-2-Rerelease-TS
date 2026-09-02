// The REAL `demomap` path, end to end, for a re-release (kex, protocol 2022
// = PROTOCOL_KEX_DEMOS) demo: the demo SERVER reads one length-prefixed
// `.dm2` block per server frame off disk (sv_send.ts's SV_SendClientMessages,
// vanilla sv_send.c:501-527), hands it to the loopback netchan, and the
// in-process client reassembles it (Netchan_Process) and parses it with the
// codec its svc_serverdata selected (CL_ParseServerMessage).
//
// This is deliberately NOT the path test/cl_demo_retail.test.ts covers.
// That file drives cl_demo.ts's CL_PlayDemoFromBuffer, which parses the
// file's blocks directly in-process with no netchan in the middle at all --
// and it passed for this exact demo the entire time the live `demomap
// demo1.dm2` command was failing with:
//
//     Delta from invalid frame (not supposed to happen!).
//     Delta frame too old.
//     U_REMOVE: oldnum != newnum
//     ERROR: CL_ParseServerMessage: Illegible server message
//
// REGRESSION PINNED. The retail attract-loop demo's block 0 (svc_serverdata
// + configstrings + baselines) is 19104 bytes against a loopback kex
// channel's negotiated maxpacketlen of 4086, so it goes out as 5 fragments;
// the other 1610 blocks have a median of 217 bytes and never fragment.
// Netchan_Transmit's first statement (net_chan.ts, chan.c:456-458) is "if
// this channel still has fragments in flight, send the next fragment and
// DROP this call's payload". The ss_demo branch of SV_SendClientMessages
// read the next block off disk on each of the next four server frames and
// fed every one of them straight into that short-circuit: blocks 1 (944 B),
// 2 (148 B), 3 (95 B) and 4 (139 B) were consumed from the file and never
// transmitted. The client saw block 0 and then block 5, i.e. the first four
// svc_frames of the recording simply did not exist -- hence the delta
// cascade above.
//
// The fix (sv_send.ts) is the reference's own rule, which the ss_demo branch
// was the only sender not applying: "don't write any frame data until all
// fragments are sent" (q2pro/q2repro src/server/send.c). A demo block is not
// a droppable unreliable datagram -- it is one irreplaceable element of a
// recorded stream whose file cursor has already advanced -- so the read
// itself is gated, not just the write.
//
// Retail-gated: skips itself when the retail install isn't present, exactly
// as test/cl_demo_retail.test.ts does. No retail content enters this
// repository: the demo is extracted from the user's own local pak0.pak at
// run time into a mkdtemp scratch directory that afterAll deletes. (Unlike
// cl_demo_retail.test.ts this file cannot keep the bytes purely in memory --
// SV_BeginDemoserver opens the demo through FS_FOpenFile by name, which is
// the whole point of exercising the real server path.)

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients } from "../src/server/server";
import { SV_Init, SVC_GetChallenge, SVC_DirectConnect } from "../src/server/sv_main";
import { SV_SendClientMessages } from "../src/server/sv_send";
import { SV_BeginDemoserver } from "../src/server/sv_user";
import { geHolder } from "../src/server/sv_game";
import { NetadrT, NetadrtypeT, NetsrcT, PROTOCOL_VERSION_RERELEASE } from "../src/qcommon/qcommon";
import {
  net_from,
  net_message,
  net_message_buffer,
  MAX_PACKETLEN_WRITABLE,
  NetchanT,
  Netchan_Setup,
  Netchan_Process,
  NETCHAN_NEW,
} from "../src/qcommon/net_chan";
import { NET_CompareBaseAdr, NET_ClearLoopback, NET_GetPacket } from "../src/platform/net_udp";
import { Cbuf_Init, Cmd_TokenizeString } from "../src/qcommon/cmd";
import { SZ_Init } from "../src/qcommon/sizebuf";
import { SetConPrintHandler } from "../src/qcommon/common";
import { Cvar_FullSet, Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_SetGamedir, FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { EntityStateT, PlayerStateT, CVAR_LATCH, CVAR_SERVERINFO } from "../src/shared/q_shared";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { vec3 } from "../src/shared/math";
import { CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { cl, cls, clCvars, ConnstateT, setRe } from "../src/client/client";
import { CL_ParseServerMessage } from "../src/client/cl_parse";
import { PROTOCOL_KEX_DEMOS, KEX_DEMO_CODEC } from "../src/qcommon/protocol/kexdemo";
import { CG_GetActiveCgameKind, CG_SetActiveCgameKind, type CgameKind } from "../src/client/cgame/host";

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const DEMO_ENTRY = "demos/demo1.dm2";
const DEMO_NAME = "demo1.dm2";
const BASEDIRNAME = "baseq2";

/** Minimal classic id PACK reader -- a copy of test/cl_demo_retail.test.ts's
 *  own private helper (rule 13: that file exports none of its fixtures, and
 *  routing this through the engine's FS_* would mutate the process-wide
 *  fs_searchpaths singleton other suites in this process rely on). */
function extractFromPak(pakPath: string, entryName: string): Uint8Array | null {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return null;
  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  for (let i = 0; i < dirlen / 64; i++) {
    const entryOffset = dirofs + i * 64;
    const name = data.toString("ascii", entryOffset, entryOffset + 56).replace(/\0.*$/, "");
    if (name !== entryName) continue;
    const filepos = data.readInt32LE(entryOffset + 56);
    const filelen = data.readInt32LE(entryOffset + 60);
    return new Uint8Array(data.subarray(filepos, filepos + filelen));
  }
  return null;
}

// ---- server fixtures (copies of test/sv_send_overflow_loopback_kex.test.ts's
// own private fixtures -- see that file's header for why these are copies) --

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

function makeFakeGameExports(gclient: unknown): GameExports {
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
    edicts: [makeEdict(null), makeEdict(gclient)],
    num_edicts: 2,
    max_edicts: 2,
  };
}

/** A real "getchallenge"+"connect" handshake for a loopback kex client that
 *  requests the full MAX_PACKETLEN_WRITABLE (4086) budget, i.e. exactly what
 *  cl_main.ts's CL_SendConnectPacket sends for a local `demomap` session --
 *  so the netchan under test is the genuine NETCHAN_NEW/4086 one, the only
 *  configuration in which a 19104-byte demo block fragments. */
function driveKexLoopbackConnect(): ClientT {
  net_from.type = NetadrtypeT.NA_LOOPBACK;
  net_from.ip.fill(0);
  net_from.port = 0;

  Cmd_TokenizeString("getchallenge", false);
  SVC_GetChallenge();
  const entry = svs.challenges.find((c) => NET_CompareBaseAdr(net_from, c.adr));
  if (!entry) throw new Error("SVC_GetChallenge did not record a challenge for this address");

  // q2proto_q2repro_connect_tail: "<packet_length> <has_zlib>".
  Cmd_TokenizeString(`connect ${PROTOCOL_VERSION_RERELEASE} 3000 ${entry.challenge} "\\name\\DemoStream" ${MAX_PACKETLEN_WRITABLE} 0`, false);
  SVC_DirectConnect();

  const connected = svs.clients.find((c) => c.state === ClientStateT.cs_connected);
  if (!connected) throw new Error("SVC_DirectConnect did not produce a connected client");
  return connected;
}

const havePak = existsSync(PAK_PATH);

let tmpRoot = "";
let fsSnapshot: FsSearchPathSnapshotT;
let preTestBasedir = "";
let preTestGamedir = "";
let preTestMaxclients = "";
let savedCgameKind: CgameKind;

beforeAll(() => {
  savedCgameKind = CG_GetActiveCgameKind();
  preTestBasedir = Cvar_VariableString("basedir");
  preTestGamedir = Cvar_VariableString("game");
  preTestMaxclients = Cvar_VariableString("maxclients");
  fsSnapshot = FS_TestSnapshotSearchPaths();

  tmpRoot = mkdtempSync(join(tmpdir(), "q2demostream-"));
  mkdirSync(join(tmpRoot, BASEDIRNAME, "demos"), { recursive: true });

  if (havePak) {
    const bytes = extractFromPak(PAK_PATH, DEMO_ENTRY);
    if (bytes) writeFileSync(join(tmpRoot, BASEDIRNAME, "demos", DEMO_NAME), bytes);
  }

  Cvar_ForceSet("basedir", tmpRoot);
  FS_InitFilesystem();
  FS_SetGamedir(BASEDIRNAME);

  // svc_stufftext ("precache\n" and friends) reaches Cbuf_AddText during
  // playback -- without an initialized command buffer every one of those
  // prints "Cbuf_AddText: overflow" (test/cl_demo_roundtrip.test.ts's own
  // beforeAll does the same for the same reason).
  Cbuf_Init();
});

// rule 13: this file fabricates a whole server (ss_demo, an open demo file
// handle, a latched maxclients, one hand-built ClientT, a loopback challenge)
// plus a connected client state, and repoints basedir/gamedir at a scratch
// tree. A leftover non-zero sv.state alone is enough to break later suites --
// see test/sv_send_overflow_loopback_kex.test.ts's afterAll for the concrete
// case (cl_main.test.ts's "connect localhost").
afterAll(() => {
  geHolder.ge = null;
  sv.clear();
  svs.clear();
  cl.clear();
  cls.clear();
  setRe(null);
  NET_ClearLoopback();
  CG_SetActiveCgameKind(savedCgameKind);
  Cvar_FullSet("maxclients", preTestMaxclients, CVAR_SERVERINFO | CVAR_LATCH);
  FS_TestRestoreSearchPaths(fsSnapshot);
  Cvar_ForceSet("basedir", preTestBasedir);
  FS_InitFilesystem();
  if (preTestGamedir.length) FS_SetGamedir(preTestGamedir);
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  SetConPrintHandler(() => {});
  // CL_ParseServerMessage runs against whatever buffer Netchan_Process last
  // repointed net_message at; put the real one back for later suites (same
  // reason test/cl_demo_retail.test.ts does).
  SZ_Init(net_message, net_message_buffer, net_message_buffer.length);
});

interface StreamResultT {
  parsed: number;
  serverFrames: number;
  warnings: string[];
  thrown: unknown;
}

/**
 * Runs the genuine demomap loop: SV_SendClientMessages() once per server
 * frame, then drain every datagram the loopback holds through the client's
 * netchan and CL_ParseServerMessage, exactly as SV_Frame + CL_ReadPackets do
 * in a live process. Stops when the requested number of complete server
 * messages has been parsed, when the demo file runs out, or on the first
 * thrown error (which is itself the failure being pinned).
 */
function streamDemoThroughDemomapPath(wantMessages: number): StreamResultT {
  const gclient = { ps: new PlayerStateT(), ping: 0 };

  Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
  sv.state = ServerStateT.ss_dead;
  svs.initialized = false;
  SV_Init();
  if (!maxclients) throw new Error("maxclients not initialized");
  maxclients.value = 1;
  svs.csr = CS_REMAP_RERELEASE;
  svs.sessionProtocol = PROTOCOL_VERSION_RERELEASE;
  svs.clients = [new ClientT()];
  svs.demofile = null;
  sv.state = ServerStateT.ss_game;
  geHolder.ge = makeFakeGameExports(gclient);

  NET_ClearLoopback();
  SZ_Init(net_message, net_message_buffer, net_message_buffer.length);

  const client = driveKexLoopbackConnect();
  expect(client.netchan.type).toBe(NETCHAN_NEW);
  expect(client.netchan.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE);

  // the receiving half of the same loopback pair (cl_main.ts's CL_Connect_f
  // ends up here after the "client_connect" reply)
  const adr = new NetadrT();
  adr.type = NetadrtypeT.NA_LOOPBACK;
  cl.clear();
  cls.clear();
  Netchan_Setup(NetsrcT.NS_CLIENT, cls.netchan, adr, 3000, NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, MAX_PACKETLEN_WRITABLE);
  cls.state = ConnstateT.ca_connected;
  clCvars.cl_shownet = null;

  // sv_ccmds.ts's `demomap` lands here: SV_SpawnServer(..., ss_demo) then
  // SV_New_f -> SV_BeginDemoserver on the client's first "new".
  sv.name = DEMO_NAME;
  sv.state = ServerStateT.ss_demo;
  SV_BeginDemoserver();
  expect(sv.demofile).not.toBeNull();

  const warnings: string[] = [];
  SetConPrintHandler((msg) => warnings.push(msg));

  let parsed = 0;
  let serverFrames = 0;
  let thrown: unknown = null;

  try {
    while (parsed < wantMessages && sv.demofile !== null && serverFrames < wantMessages * 10) {
      SV_SendClientMessages();
      serverFrames++;
      while (NET_GetPacket(NetsrcT.NS_CLIENT, net_from, net_message)) {
        if (!Netchan_Process(cls.netchan, net_message)) continue; // incomplete fragment
        parsed++;
        CL_ParseServerMessage();
      }
    }
  } catch (e) {
    thrown = e;
  } finally {
    SetConPrintHandler(() => {});
  }

  return { parsed, serverFrames, warnings, thrown };
}

const DELTA_WARNINGS = ["Delta from invalid frame", "Delta frame too old", "U_REMOVE: oldnum != newnum"];

describe("demomap streaming path -- retail KEX demo through the demo server, loopback netchan and real client parser (skipped without the retail install)", () => {
  test.skipIf(!havePak)("demo1.dm2 reaches ca_active and streams 250 server messages with no delta warnings and no error", () => {
    const { parsed, warnings, thrown } = streamDemoThroughDemomapPath(250);

    expect(thrown).toBeNull();
    expect(parsed).toBeGreaterThanOrEqual(250);

    // the demo's own svc_serverdata drove codec selection through the netchan,
    // not through cl_demo.ts's direct reader
    expect(cls.serverProtocol).toBe(PROTOCOL_KEX_DEMOS);
    expect(cls.codec).toBe(KEX_DEMO_CODEC);
    expect(cls.state).toBe(ConnstateT.ca_active);
    expect(cl.frame.valid).toBe(true);

    const offending = warnings.filter((w) => DELTA_WARNINGS.some((needle) => w.includes(needle)));
    expect(offending).toEqual([]);
  });

  test.skipIf(!havePak)("the 19104-byte first block is fragmented and NO demo block is consumed while those fragments drain", () => {
    // The direct proof of the defect's mechanism, independent of the symptom
    // above: block 0 needs ceil(19104 / 4086) = 5 datagrams, so the first
    // complete message must not arrive before the 5th server frame, and the
    // 2nd complete message (block 1, 944 bytes) must arrive on the 6th --
    // i.e. blocks 1..4 were NOT read-and-dropped during the drain.
    const gclient = { ps: new PlayerStateT(), ping: 0 };

    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    sv.state = ServerStateT.ss_dead;
    svs.initialized = false;
    SV_Init();
    if (!maxclients) throw new Error("maxclients not initialized");
    maxclients.value = 1;
    svs.csr = CS_REMAP_RERELEASE;
    svs.sessionProtocol = PROTOCOL_VERSION_RERELEASE;
    svs.clients = [new ClientT()];
    svs.demofile = null;
    sv.state = ServerStateT.ss_game;
    geHolder.ge = makeFakeGameExports(gclient);

    NET_ClearLoopback();
    SZ_Init(net_message, net_message_buffer, net_message_buffer.length);

    const client = driveKexLoopbackConnect();
    expect(client.netchan.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE);
    const adr = new NetadrT();
    adr.type = NetadrtypeT.NA_LOOPBACK;
    const rx = new NetchanT();
    Netchan_Setup(NetsrcT.NS_CLIENT, rx, adr, 3000, NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE, MAX_PACKETLEN_WRITABLE);

    sv.name = DEMO_NAME;
    sv.state = ServerStateT.ss_demo;
    SV_BeginDemoserver();

    // drain the connect handshake's own reliable traffic first
    while (NET_GetPacket(NetsrcT.NS_CLIENT, net_from, net_message)) Netchan_Process(rx, net_message);

    // sizes of the complete messages the client reassembles, in order, and
    // the server frame each one completed on
    const completed: Array<{ frame: number; size: number }> = [];
    for (let frame = 1; frame <= 8; frame++) {
      SV_SendClientMessages();
      while (NET_GetPacket(NetsrcT.NS_CLIENT, net_from, net_message)) {
        if (Netchan_Process(rx, net_message)) completed.push({ frame, size: net_message.cursize - net_message.readcount });
      }
    }

    expect(completed.length).toBeGreaterThanOrEqual(4);
    // block 0: 19104 bytes over 5 fragments
    expect(completed[0]!.frame).toBe(5);
    expect(completed[0]!.size).toBe(19104);
    // block 1 lands on the very next frame -- it was NOT eaten by the drain
    expect(completed[1]!.frame).toBe(6);
    expect(completed[1]!.size).toBe(944);
    expect(completed[2]!.size).toBe(148);
    expect(completed[3]!.size).toBe(95);
  });
});
