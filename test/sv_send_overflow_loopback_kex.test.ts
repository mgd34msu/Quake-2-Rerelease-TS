// Proof case (Mike, packet_length negotiation task): a loopback kex/1038
// connection that actually negotiated the full MAX_PACKETLEN_WRITABLE
// (4086) budget -- via a REAL "getchallenge"+"connect" handshake through
// sv_main.ts's SVC_DirectConnect / SV_ParsePacketLength, exactly the path a
// genuine q2repro client drives (client/main.c:458-462's "use maximum
// allowed msglen for loopback") -- absorbs the SAME barrel-class multicast
// burst that test/sv_send_overflow.test.ts proves overflows a
// network-default (1390/1400) channel, WITHOUT overflowing.
//
// This is the other half of that file's own repro: sv_send_overflow.test.ts
// pins that a network-default channel's client.datagram/msg DO overflow on
// an oversized burst (and recover cleanly) -- unmodified by this unit, per
// brief ("the existing overflow test must stay green UNMODIFIED for
// network-default channels"). This file pins that the SAME shape of burst,
// sized to fit under the LARGER negotiated budget instead, produces no
// overflow warning at all, proving:
//   - sv_main.ts's SVC_DirectConnect actually threads the negotiated
//     packet_length into Netchan_Setup's maxpacketlen AND resizes
//     client.datagram_buf to match (this file's own doc comment on
//     `requiredDatagramCapacity`).
//   - sv_send.ts's SV_SendClientDatagram sizes its per-call `msg` scratch
//     buffer off client.netchan.maxpacketlen, not a flat MAX_MSGLEN.
//   - net_chan.ts's Netchan_Transmit no longer truncates the outgoing
//     packet at a hardcoded MAX_MSGLEN (1400) scratch buffer (the send_buf
//     fix, now MAX_PACKETLEN/4096 -- chan.c's own `byte
//     send_buf[MAX_PACKETLEN]`).
//
// Self-sufficient per .orch/preferences.md rule 13: copies (not imports)
// sv_send_overflow.test.ts's makeEdict/makeFakeGameExports/
// injectMulticastBurst fixtures and its BSP-loading beforeAll/afterAll (that
// file exports none of them), and net_chan_maxpacketlen_parity.test.ts's
// driveConnect approach (direct SVC_GetChallenge/SVC_DirectConnect calls
// against a hand-set net_from, not the loopback NET_SendPacket/NET_GetPacket
// simulation -- see that file's own comment for why the loopback simulation
// path cannot be used to distinguish a "loopback" from a "network" sender in
// a unit test).

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients } from "../src/server/server";
import { SV_Init, SVC_GetChallenge, SVC_DirectConnect } from "../src/server/sv_main";
import { SV_SendClientDatagram, SV_Multicast } from "../src/server/sv_send";
import { geHolder } from "../src/server/sv_game";
import { NetadrT, NetadrtypeT, PROTOCOL_VERSION_RERELEASE } from "../src/qcommon/qcommon";
import { net_from, MAX_PACKETLEN_WRITABLE, MAX_PACKETLEN_WRITABLE_DEFAULT } from "../src/qcommon/net_chan";
import { NET_CompareBaseAdr } from "../src/platform/net_udp";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { SZ_Init, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { SetConPrintHandler } from "../src/qcommon/common";
import { Cvar_FullSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { MulticastT, EntityStateT, PlayerStateT, CVAR_LATCH, CVAR_SERVERINFO } from "../src/shared/q_shared";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { vec3 } from "../src/shared/math";
import { buildBoxRoomBspQbsp } from "./support/bsp_builder";
import { CS_REMAP_RERELEASE } from "../src/shared/cs_remap";

// ---- fixtures (copies of test/sv_send_overflow.test.ts's own private
// fixtures -- see that file's header for why these are copies, not
// imports) ------------------------------------------------------------

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

// edicts[0] is the reserved world edict; edicts[1] is the sole client's
// (maxclients=1, so SVC_DirectConnect's edictnum is always newclIndex+1=1)
// -- pre-populated with `gclient` so the connected client's own `.edict`
// already has a playerstate SV_BuildClientFrame can read, with no
// post-connect mutation needed.
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

// writes `n` bytes of dummy payload into sv.multicast and fans it out via
// SV_Multicast(MULTICAST_ALL) -- standing in for a barrel explosion's burst
// of BecomeExplosion1/ThrowGibs-style gi.multicast calls, each one a single
// SZ_Write against client.datagram (server/sv_send.c:236-239's `SZ_Write
// (&client->datagram, sv.multicast.data, sv.multicast.cursize)`).
function injectMulticastBurst(n: number): void {
  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
  sv.multicast.allowoverflow = true;
  for (let i = 0; i < n; i++) MSG_WriteByte(sv.multicast, 0x42);
  SV_Multicast(null, MulticastT.MULTICAST_ALL);
}

// Drives a real "getchallenge"+"connect" handshake by calling
// SVC_GetChallenge/SVC_DirectConnect directly against a hand-set net_from
// (net_chan_maxpacketlen_parity.test.ts's own approach -- see that file's
// comment on why platform/net_udp.ts's loopback NET_SendPacket/NET_GetPacket
// simulation cannot be used here: NET_GetLoopPacket always reports the
// receiver's own net_local_adr as sender, regardless of what address
// NET_SendPacket was told to send "to"). `packetLength` is the connect
// string's packet_length field -- what a real q2repro/kex client requests
// for a loopback destination (client/main.c:461's MAX_PACKETLEN_WRITABLE).
function driveKexLoopbackConnect(packetLength: number): ClientT {
  const loopbackAdr = new NetadrT();
  loopbackAdr.type = NetadrtypeT.NA_LOOPBACK;

  net_from.type = loopbackAdr.type;
  net_from.ip.set(loopbackAdr.ip);
  net_from.port = loopbackAdr.port;

  Cmd_TokenizeString("getchallenge", false);
  SVC_GetChallenge();
  const entry = svs.challenges.find((c) => NET_CompareBaseAdr(net_from, c.adr));
  if (!entry) throw new Error("SVC_GetChallenge did not record a challenge for this address");
  const challenge = entry.challenge;

  // q2proto_q2repro_connect_tail: "<packet_length> <has_zlib>".
  Cmd_TokenizeString(`connect ${PROTOCOL_VERSION_RERELEASE} 3000 ${challenge} "\\name\\GLTest" ${packetLength} 0`, false);
  SVC_DirectConnect();

  const connected = svs.clients.find((c) => c.state === ClientStateT.cs_connected);
  if (!connected) throw new Error("SVC_DirectConnect did not produce a connected client");
  return connected;
}

afterEach(() => {
  SetConPrintHandler(() => {});
});

// SV_BuildClientFrame (called inside SV_SendClientDatagram) needs a real
// loaded map -- test/sv_send_overflow.test.ts's own precedent (see that
// file's comment for why the Qbsp fixture specifically, over the classic
// buildBoxRoomBsp one). The fixture name is unique to THIS suite for the
// same reason sv_send_overflow.test.ts's is -- see that file's comment:
// CM_LoadMap's same-map early-out keys on the map NAME alone, so sharing
// "maps/testroom.bsp" with the classic-fixture suites let whichever ran
// first in the shared process decide which BSP every later suite got.
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "q2solk-"));
  const baseq2Dir = join(tmpRoot, "baseq2");
  const mapsDir = join(baseq2Dir, "maps");
  mkdirSync(baseq2Dir);
  mkdirSync(mapsDir);
  writeFileSync(join(mapsDir, "sv_send_overflow_kex_room.bsp"), buildBoxRoomBspQbsp());

  Cvar_FullSet("basedir", tmpRoot, 0);
  FS_InitFilesystem();

  const { model } = CM_LoadMap("maps/sv_send_overflow_kex_room.bsp", false);
  sv.models[1] = model;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupServer(gclient: unknown): void {
  Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
  sv.state = ServerStateT.ss_dead;
  svs.initialized = false;
  SV_Init();
  if (!maxclients) throw new Error("maxclients not initialized");
  maxclients.value = 1;
  svs.csr = CS_REMAP_RERELEASE; // kex family -- only 1038 is accepted, matches driveKexLoopbackConnect
  svs.clients = [new ClientT()];
  svs.demofile = null;
  sv.state = ServerStateT.ss_game;
  geHolder.ge = makeFakeGameExports(gclient);
}

describe("SV_SendClientDatagram: a loopback kex channel with the negotiated 4086 budget absorbs the barrel-class burst without overflow", () => {
  test("negotiated maxpacketlen and client.datagram_buf capacity both land on MAX_PACKETLEN_WRITABLE (4086), not the network default (1390)", () => {
    const gclient = { ps: new PlayerStateT(), ping: 0 };
    setupServer(gclient);

    const client = driveKexLoopbackConnect(MAX_PACKETLEN_WRITABLE);

    expect(client.netchan.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE);
    expect(client.netchan.maxpacketlen).toBe(4086);
    expect(client.netchan.maxpacketlen).not.toBe(MAX_PACKETLEN_WRITABLE_DEFAULT);
    // datagram_buf must be able to hold at least maxpacketlen + the packet
    // header (sv_main.ts's `requiredDatagramCapacity`), not just MAX_MSGLEN.
    expect(client.datagram_buf.length).toBeGreaterThanOrEqual(MAX_PACKETLEN_WRITABLE + 10);
  });

  test("a burst too big for a network-default channel (proven by sv_send_overflow.test.ts) causes NO overflow warning over 20 frames on this negotiated 4086-budget loopback channel", () => {
    const gclient = { ps: new PlayerStateT(), ping: 0 };
    setupServer(gclient);

    const client = driveKexLoopbackConnect(MAX_PACKETLEN_WRITABLE);
    expect(client.netchan.maxpacketlen).toBe(4086);

    SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
    sv.multicast.allowoverflow = true;

    const printed: string[] = [];
    SetConPrintHandler((msg) => printed.push(msg));

    const FRAMES = 20;
    const overflowFrames: number[] = [];

    for (let frame = 1; frame <= FRAMES; frame++) {
      sv.framenum = frame;
      printed.length = 0;

      if (frame === 1) {
        // Same shape of burst as sv_send_overflow.test.ts's first repro
        // (several temp-entity/sound multicasts landing in one server
        // tick), scaled to comfortably exceed the 1390/1400 network-default
        // budget that DOES overflow there, while staying safely under this
        // channel's negotiated 4086.
        injectMulticastBurst(1300);
        injectMulticastBurst(1300);
        injectMulticastBurst(1300); // 3900 cumulative: > 1400, < 4086
      }

      expect(() => SV_SendClientDatagram(client)).not.toThrow();

      if (printed.some((m) => m.includes("overflow"))) overflowFrames.push(frame);

      // client.datagram is always clean after the call (SV_SendClientDatagram's
      // unconditional SZ_Clear), same recovery contract as the network-default
      // case -- but here there should be nothing to recover FROM.
      expect(client.datagram.cursize).toBe(0);
      expect(client.datagram.overflowed).toBe(false);
    }

    // the whole point: this negotiated-4086 channel never overflows on a
    // burst that DOES overflow a network-default (1390/1400) one.
    expect(overflowFrames).toEqual([]);
  });
});
