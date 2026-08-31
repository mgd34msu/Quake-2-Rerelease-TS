// Repro for Mike's live-session finding (.orch/followups.md finding 3 +
// addendum, 2026-08-31): blowing up an explosive barrel produced
// "WARNING: msg overflowed for <client>" + "SZ_GetSpace: overflow"
// alternating EVERY FRAME FOREVER instead of vanilla's one-shot recovery.
//
// Vanilla contract (server/sv_send.c:395-432's SV_SendClientDatagram,
// server/sv_main.c:407-408's client->datagram SZ_Init/allowoverflow=true,
// qcommon/common.c:876-910's SZ_Init/SZ_Clear/SZ_GetSpace):
//   - client->datagram and the per-call local `msg` sizebuf both have
//     allowoverflow=true, so an oversized write never Com_Errors -- it
//     prints "SZ_GetSpace: overflow", SZ_Clear()s the buffer (cursize=0,
//     overflowed=false), then sets overflowed=true.
//   - SV_SendClientDatagram checks client->datagram.overflowed BEFORE
//     copying it into msg (skipping the copy, printing "WARNING: datagram
//     overflowed for %s" instead), then unconditionally SZ_Clear()s
//     client->datagram again (which also resets overflowed back to false)
//     -- so client->datagram starts every frame clean regardless of what
//     happened the frame before.
//   - `msg` itself (byte msg_buf[MAX_MSGLEN]; sizebuf_t msg;) is a fresh
//     stack-local buffer, SZ_Init'd from scratch on every single call --
//     there is no carried state across frames for it to leak through. If
//     msg.overflowed is set, SV_SendClientDatagram prints "WARNING: msg
//     overflowed for %s" and SZ_Clear()s it too, then transmits whatever
//     is left (possibly a zero-length datagram) and returns.
// So a one-shot oversized burst (explosion temp-entities + gib spawns) can
// overflow at most the frame(s) the burst's bytes are still resident in
// client->datagram/msg; once the burst stops, subsequent frames' payload
// shrinks back under MAX_MSGLEN and the warnings stop firing.
//
// This suite drives src/server/sv_send.ts's real SV_SendClientDatagram
// across a simulated 20-frame window with a one-frame injected multicast
// burst, and asserts the port matches that recovery contract: the warning
// prints a bounded number of times (not once per frame for 20 frames), and
// client.datagram/msg both come back clean afterward.

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients } from "../src/server/server";
import { SV_Init } from "../src/server/sv_main";
import { SV_SendClientDatagram, SV_Multicast } from "../src/server/sv_send";
import { geHolder } from "../src/server/sv_game";
import { NetadrT, NetadrtypeT, NetsrcT } from "../src/qcommon/qcommon";
import { NET_ClearLoopback } from "../src/platform/net_udp";
import { SZ_Init, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { SetConPrintHandler } from "../src/qcommon/common";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { MulticastT, EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { vec3 } from "../src/shared/math";
import { buildBoxRoomBspQbsp } from "./support/bsp_builder";

// ---- fixtures (mirrors test/server_core.test.ts's makeEdict/makeClient) ---

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

function makeClient(state: ClientStateT): ClientT {
  const cl = new ClientT();
  cl.state = state;
  cl.name = "GLTest";
  SZ_Init(cl.datagram, cl.datagram_buf, cl.datagram_buf.length);
  cl.datagram.allowoverflow = true;
  SZ_Init(cl.netchan.message, cl.netchan.message_buf, cl.netchan.message_buf.length);
  cl.netchan.message.allowoverflow = true;
  cl.netchan.sock = NetsrcT.NS_SERVER;
  cl.netchan.remote_address = new NetadrT();
  cl.netchan.remote_address.type = NetadrtypeT.NA_LOOPBACK;
  return cl;
}

function makeFakeGameExports(numEdicts: number): GameExports {
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
    num_edicts: numEdicts,
    max_edicts: numEdicts,
  };
}

// writes `n` bytes of dummy payload into sv.multicast and fans it out via
// SV_Multicast(MULTICAST_ALL) -- standing in for the barrel explosion's
// burst of BecomeExplosion1/ThrowGibs-style gi.multicast calls, each one a
// single SZ_Write against client.datagram (server/sv_send.c:236-239's
// `SZ_Write (&client->datagram, sv.multicast.data, sv.multicast.cursize)`).
function injectMulticastBurst(n: number): void {
  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
  sv.multicast.allowoverflow = true;
  for (let i = 0; i < n; i++) MSG_WriteByte(sv.multicast, 0x42);
  SV_Multicast(null, MulticastT.MULTICAST_ALL);
}

afterEach(() => {
  SetConPrintHandler(() => {});
  NET_ClearLoopback();
});

// SV_BuildClientFrame (called inside SV_SendClientDatagram) drives
// CM_PointLeafnum/CM_BoxLeafnums/CM_WriteAreaBits/CM_ClusterPVS/PHS -- all of
// which need a real loaded map (test/sv_world.test.ts's own established
// pattern: a synthetic BSP built by test/support/bsp_builder.ts, no
// copyrighted map data). Without this, CM_PointLeafnum_r walks an empty/
// undefined node tree and throws. The classic (non-Qbsp) buildBoxRoomBsp
// fixture only emits a 1-entry AREAS lump (area 0, reserved for solid
// leaves) -- a real occupiable leaf's area index of 1 is then out of range
// for CM_LeafArea/FloodAreaConnections's map_areas[area] lookups. The Qbsp
// fixture (test/cmodel_qbsp.test.ts's own established choice for
// area-lookup coverage) emits the 2-entry AREAS lump area-based code
// actually needs.
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "q2so-"));
  const baseq2Dir = join(tmpRoot, "baseq2");
  const mapsDir = join(baseq2Dir, "maps");
  mkdirSync(baseq2Dir);
  mkdirSync(mapsDir);
  writeFileSync(join(mapsDir, "testroom.bsp"), buildBoxRoomBspQbsp());

  Cvar_ForceSet("basedir", tmpRoot);
  FS_InitFilesystem();

  const { model } = CM_LoadMap("maps/testroom.bsp", false);
  sv.models[1] = model;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("SV_SendClientDatagram overflow recovery (barrel-explosion repro)", () => {
  test("a one-frame oversized multicast burst overflows client.datagram at most once, then every later frame sends clean (client.datagram overflow path)", () => {
    NET_ClearLoopback();
    SV_Init();
    if (!maxclients) throw new Error("maxclients not initialized");
    maxclients.value = 1;

    const client = makeClient(ClientStateT.cs_spawned);
    const gclient = { ps: new PlayerStateT(), ping: 0 };
    client.edict = makeEdict(gclient);
    svs.clients = [client];
    svs.demofile = null;
    sv.state = ServerStateT.ss_game;

    // world only -- isolates the repro to the datagram burst instead of
    // entity-list growth (a different, already-audited code path).
    geHolder.ge = makeFakeGameExports(1);

    SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
    sv.multicast.allowoverflow = true;

    const printed: string[] = [];
    SetConPrintHandler((msg) => printed.push(msg));

    const FRAMES = 20;
    const datagramOverflowFrames: number[] = [];
    const szGetSpaceOverflowFrames: number[] = [];

    for (let frame = 1; frame <= FRAMES; frame++) {
      sv.framenum = frame;
      printed.length = 0;

      if (frame === 1) {
        // burst: several temp-entity/sound multicasts in the SAME frame,
        // cumulatively larger than client.datagram_buf's MAX_MSGLEN (1400)
        // capacity -- mirrors a barrel's BecomeExplosion + 14 ThrowGibs
        // events landing in one server tick.
        injectMulticastBurst(500);
        injectMulticastBurst(500);
        injectMulticastBurst(500); // 1500 cumulative > 1400 -- must overflow
      }

      expect(() => SV_SendClientDatagram(client)).not.toThrow();

      if (printed.some((m) => m.includes("datagram overflowed"))) datagramOverflowFrames.push(frame);
      if (printed.some((m) => m.includes("SZ_GetSpace: overflow"))) szGetSpaceOverflowFrames.push(frame);

      // recovery contract: client.datagram is clean after EVERY call,
      // whether or not this frame overflowed (server/sv_send.c:417's
      // unconditional `SZ_Clear (&client->datagram);` runs on both the
      // overflowed and non-overflowed branches).
      expect(client.datagram.cursize).toBe(0);
      expect(client.datagram.overflowed).toBe(false);
    }

    // bounded, not "every frame forever": only frame 1 (the burst) should
    // have printed either warning.
    expect(datagramOverflowFrames).toEqual([1]);
    expect(szGetSpaceOverflowFrames).toEqual([1]);
    expect(datagramOverflowFrames.length).toBeLessThan(FRAMES);
  });

  test("a burst sized to survive client.datagram but overflow the per-call msg buffer reproduces the exact 'msg overflowed'/'SZ_GetSpace: overflow' pair Mike saw, then recovers next frame", () => {
    NET_ClearLoopback();
    SV_Init();
    if (!maxclients) throw new Error("maxclients not initialized");
    maxclients.value = 1;

    const client = makeClient(ClientStateT.cs_spawned);
    const gclient = { ps: new PlayerStateT(), ping: 0 };
    client.edict = makeEdict(gclient);
    svs.clients = [client];
    svs.demofile = null;
    sv.state = ServerStateT.ss_game;

    geHolder.ge = makeFakeGameExports(1);

    SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
    sv.multicast.allowoverflow = true;

    const printed: string[] = [];
    SetConPrintHandler((msg) => printed.push(msg));

    const FRAMES = 20;
    const msgOverflowFrames: number[] = [];

    for (let frame = 1; frame <= FRAMES; frame++) {
      sv.framenum = frame;
      printed.length = 0;

      if (frame === 1) {
        // 1390 bytes fits inside client.datagram_buf (1400) on its own, so
        // client.datagram itself does NOT overflow -- but once
        // SV_WriteFrameToClient's svc_frame envelope + playerstate +
        // packetentities terminator is added on top inside the local `msg`
        // buffer, the combined write exceeds msg's own MAX_MSGLEN and
        // SZ_GetSpace overflows `msg` instead, matching the exact strings
        // in Mike's screenshot ("WARNING: Msg overflowed for GLTest" /
        // "SZ_GetSpace: overflow"), not the "datagram overflowed" message.
        injectMulticastBurst(1390);
      }

      expect(() => SV_SendClientDatagram(client)).not.toThrow();

      if (printed.some((m) => m.includes("msg overflowed"))) msgOverflowFrames.push(frame);

      // recovery contract: even after a `msg` overflow, client.datagram
      // itself was clean going in and is cleared again unconditionally.
      expect(client.datagram.cursize).toBe(0);
      expect(client.datagram.overflowed).toBe(false);
    }

    expect(msgOverflowFrames).toEqual([1]);
    expect(msgOverflowFrames.length).toBeLessThan(FRAMES);
  });
});
