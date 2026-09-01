// Per-family per-packet budget fidelity pin (.orch/followups.md Finding 3
// residual (a): "does q2repro/KEX use a larger per-packet budget for
// 1038-family datagrams than vanilla's 1400 MAX_MSGLEN?").
//
// VERDICT (citations below): NO protocol-family-keyed size increase exists
// -- R1Q2/Q2PRO/kex all negotiate off the exact same net_maxmsglen cvar
// (default 1390) vanilla is hardcoded to. The real axis is LOOPBACK vs
// NETWORK, not protocol family, and packet_length negotiation for that axis
// IS NOW IMPLEMENTED (task: "Implement q2repro's packet_length
// negotiation") -- see sv_main.ts's SV_ParsePacketLength / SVC_DirectConnect
// and cl_main.ts's CL_SendConnectPacket. This suite's first two tests still
// pin the protocol-agnostic constant ladder and Netchan_Setup's own default
// parameter; the third test (updated by this unit) now pins the NEW
// loopback-vs-network DIFFERENCE a real connect handshake produces, in
// place of the old "no negotiation implemented yet" placeholder pin.
//
// Evidence (q2repro checkout at ~/Projects/q2repro, q2proto at
// ~/Projects/q2proto):
//   - inc/common/net/net.h:29-34: MAX_PACKETLEN=4096 (hard ceiling),
//     PACKET_HEADER=10, MAX_PACKETLEN_DEFAULT=1400 ("default quake2 limit"),
//     MAX_PACKETLEN_WRITABLE_DEFAULT = 1400-10 = 1390, MAX_PACKETLEN_WRITABLE
//     = 4096-10 = 4086. This ladder is PROTOCOL-AGNOSTIC -- it is not
//     namespaced per protocol family.
//   - src/common/net/chan.c:130: `net_maxmsglen = Cvar_Get("net_maxmsglen",
//     va("%d", MAX_PACKETLEN_WRITABLE_DEFAULT), 0)` -- the single global
//     cvar governing negotiated packet length defaults to 1390 for EVERY
//     protocol family (vanilla has no negotiation at all and is hardcoded
//     1400; R1Q2/Q2PRO/kex all negotiate off this same cvar).
//   - src/client/main.c:458-462 (CL_CheckForResend): a real q2repro/kex
//     client requests `net_maxmsglen->integer` (1390 by default) as its
//     connect string's packet_length UNLESS the server address is loopback,
//     in which case it requests the full MAX_PACKETLEN_WRITABLE (4086).
//     This is a LOOPBACK-vs-NETWORK distinction, not a protocol-family one:
//     it applies identically to R1Q2/Q2PRO/kex connect strings (all three
//     carry a packet_length field per q2proto_proto_r1q2.c:55,
//     q2proto_proto_q2pro.c:77, q2proto_proto_q2repro.c:54, and all three
//     put it FIRST -- q2proto_server.c:158-166 parses it generically before
//     dispatching to the family-specific parser), and vanilla cannot
//     negotiate at all (no packet_length field in its connect verb;
//     q2proto_server.c:159 gates the token read on `protocol >=
//     Q2P_PROTOCOL_R1Q2`).
//   - src/server/main.c:746-767 (parse_packet_length): the server honors
//     whatever the client requests, capped by its own net_maxmsglen cvar
//     -- BUT ONLY for a non-local sender (`!NET_IsLocalAddress(&net_from) &&
//     net_maxmsglen->integer > 0`, main.c:756). A loopback sender's request
//     is honored up to MAX_PACKETLEN_WRITABLE (4086) uncapped. So over a
//     real network connection, a stock q2repro dedicated server serving a
//     stock q2repro/kex client settles on 1390 writable + 10-byte header =
//     1400 total (IDENTICAL to vanilla's MAX_MSGLEN); over loopback it
//     settles on 4086 writable + 10 = 4096 (MAX_PACKETLEN, the hard
//     ceiling) instead.
//   - inc/common/protocol.h:25's `MAX_MSGLEN 0x8000` (32 KiB) is a DIFFERENT
//     number for a different purpose: the reassembly buffer for a message
//     that already arrived as multiple NETCHAN_NEW fragments, not a single
//     datagram's budget. This port already models that distinction
//     correctly as net_chan.ts's MAX_FRAGMENT_MSGLEN (0x8000), separate
//     from qcommon.ts's MAX_MSGLEN (1400, the single-datagram limit) --
//     see net_chan.ts's own doc comment at MAX_FRAGMENT_MSGLEN's
//     declaration, written by a prior unit and independently confirmed
//     against the citations above.
//
// Self-sufficient per .orch/preferences.md rule 13: builds its own netchans
// (tests 1-2) or drives a real loopback connect handshake through its own
// server setup (test 3, copying protocol_negotiation_e2e.test.ts's
// driveConnect/setupServer fixtures rather than importing them, since that
// file exports none), touching no shared server/client global state beyond
// what SV_Init/the loopback net path themselves own.

import { describe, expect, test } from "bun:test";
import {
  NetadrT,
  NetadrtypeT,
  NetsrcT,
  MAX_MSGLEN,
  PACKET_HEADER as QCOMMON_PACKET_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_RERELEASE,
} from "../src/qcommon/qcommon";
import {
  NetchanT,
  Netchan_Setup,
  NETCHAN_OLD,
  NETCHAN_NEW,
  MAX_PACKETLEN,
  MAX_PACKETLEN_DEFAULT,
  MAX_PACKETLEN_WRITABLE_DEFAULT,
  MAX_PACKETLEN_WRITABLE,
  MAX_FRAGMENT_MSGLEN,
  net_from,
} from "../src/qcommon/net_chan";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients } from "../src/server/server";
import { SV_Init, SVC_GetChallenge, SVC_DirectConnect } from "../src/server/sv_main";
import { geHolder } from "../src/server/sv_game";
import { NET_CompareBaseAdr } from "../src/platform/net_udp";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { Cvar_FullSet } from "../src/qcommon/cvar";
import { CVAR_LATCH, CVAR_SERVERINFO, EntityStateT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { CS_REMAP_RERELEASE } from "../src/shared/cs_remap";

function netAdr(type: NetadrtypeT): NetadrT {
  const a = new NetadrT();
  a.type = type;
  return a;
}

// ---- copied fixtures (protocol_negotiation_e2e.test.ts's own precedent for
// why these are copies, not imports: that file exports none of them) -------

function makeEdict(): Edict {
  return {
    s: new EntityStateT(),
    client: null,
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
    edicts: [makeEdict(), makeEdict()],
    num_edicts: 2,
    max_edicts: 2,
  };
}

// Drives one full "getchallenge" + "connect" handshake, from a
// caller-supplied source address, and returns the resulting ClientT --
// specifically so this test can inspect client.netchan.maxpacketlen, the
// field SV_ParsePacketLength's negotiated value actually lands in
// (sv_main.ts's SVC_DirectConnect).
//
// This calls SVC_GetChallenge/SVC_DirectConnect directly (both exported)
// against a hand-set net_from, rather than routing through
// NET_SendPacket/NET_GetPacket's loopback simulation the way
// protocol_negotiation_e2e.test.ts's own driveConnect does: platform/
// net_udp.ts's NET_GetLoopPacket ALWAYS reports the receiver's own
// net_local_adr as the sender (line ~168), regardless of what address
// NET_SendPacket was told to send "to" -- there is no way to make that path
// observe a genuine non-loopback (NA_IP) sender for a unit test, and this
// test's whole point is comparing a loopback sender against a network one.
// net_from is a shared singleton every connectionless handler reads
// directly (net_chan.ts), so writing it here matches NET_GetPacket's own
// contract of mutating that same object in place.
function driveConnect(fromAdr: NetadrT, protocol: number, packetLength: number): ClientT {
  net_from.type = fromAdr.type;
  net_from.ip.set(fromAdr.ip);
  net_from.port = fromAdr.port;

  Cmd_TokenizeString("getchallenge", false);
  SVC_GetChallenge();
  const entry = svs.challenges.find((c) => NET_CompareBaseAdr(net_from, c.adr));
  if (!entry) throw new Error("SVC_GetChallenge did not record a challenge for this address");
  const challenge = entry.challenge;

  // q2proto_q2repro_connect_tail: "<packet_length> <has_zlib>" -- has_zlib
  // is irrelevant here (0), only packet_length (the field under test) is
  // varied by the caller.
  Cmd_TokenizeString(`connect ${protocol} 3000 ${challenge} "\\name\\Tester" ${packetLength} 0`, false);
  SVC_DirectConnect();

  const connected = svs.clients.find((c) => c.state === ClientStateT.cs_connected);
  if (!connected) throw new Error("SVC_DirectConnect did not produce a connected client");
  return connected;
}

describe("per-family per-packet budget parity (kex/1038 vs vanilla/34, R1Q2/35, Q2PRO/36)", () => {
  test("q2repro's own constant ladder matches what this port ported (net.h:29-34 citation)", () => {
    // MAX_PACKETLEN_DEFAULT (net_chan.ts) IS vanilla's MAX_MSGLEN (qcommon.ts)
    // under a different name -- both 1400, both "default quake2 limit".
    expect(MAX_PACKETLEN_DEFAULT).toBe(1400);
    expect(MAX_MSGLEN).toBe(1400);
    expect(MAX_PACKETLEN_DEFAULT).toBe(MAX_MSGLEN);

    // the writable default is the total minus the worst-case header, and it
    // is this number -- not MAX_PACKETLEN's 4096 ceiling -- that a stock
    // q2repro client/server settles on by default (chan.c:130's cvar
    // default), for every protocol family alike.
    expect(QCOMMON_PACKET_HEADER).toBe(10);
    expect(MAX_PACKETLEN_WRITABLE_DEFAULT).toBe(MAX_PACKETLEN_DEFAULT - QCOMMON_PACKET_HEADER);
    expect(MAX_PACKETLEN_WRITABLE_DEFAULT).toBe(1390);

    // the hard per-packet ceiling (4096) and the fragment-reassembly buffer
    // (32 KiB) are real reference numbers, but neither is the DEFAULT
    // per-datagram budget any family gets without explicit negotiation this
    // port does not implement (see file header).
    expect(MAX_PACKETLEN).toBe(4096);
    expect(MAX_FRAGMENT_MSGLEN).toBe(0x8000);
  });

  test("Netchan_Setup gives every protocol family the SAME default maxpacketlen (1390) -- no kex-only bump exists", () => {
    const families: Array<{ label: string; protocol: number; chanType: typeof NETCHAN_OLD | typeof NETCHAN_NEW }> = [
      { label: "vanilla (34)", protocol: PROTOCOL_VERSION, chanType: NETCHAN_OLD },
      { label: "R1Q2 (35)", protocol: PROTOCOL_VERSION_R1Q2, chanType: NETCHAN_OLD },
      { label: "Q2PRO (36)", protocol: PROTOCOL_VERSION_Q2PRO, chanType: NETCHAN_NEW },
      { label: "kex/rerelease (1038)", protocol: PROTOCOL_VERSION_RERELEASE, chanType: NETCHAN_NEW },
    ];

    const results = families.map(({ label, protocol, chanType }) => {
      const chan = new NetchanT();
      Netchan_Setup(NetsrcT.NS_SERVER, chan, netAdr(NetadrtypeT.NA_IP), 0, chanType, protocol);
      return { label, maxpacketlen: chan.maxpacketlen, messageBufLen: chan.message_buf.length, reliableBufLen: chan.reliable_buf.length };
    });

    for (const r of results) {
      expect(r.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE_DEFAULT);
      expect(r.messageBufLen).toBe(MAX_MSGLEN - 16);
      expect(r.reliableBufLen).toBe(MAX_MSGLEN - 16);
    }

    // explicit cross-family equality, not just each equal to the same
    // literal -- guards against a future edit that special-cases one
    // family's Netchan_Setup call site without updating this pin.
    const [vanilla, ...rest] = results;
    for (const r of rest) {
      expect(r.maxpacketlen).toBe(vanilla.maxpacketlen);
      expect(r.messageBufLen).toBe(vanilla.messageBufLen);
      expect(r.reliableBufLen).toBe(vanilla.reliableBufLen);
    }
  });

  function setupServer(): void {
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    sv.state = ServerStateT.ss_dead;
    svs.initialized = false;
    SV_Init();
    if (!maxclients) throw new Error("maxclients not initialized");
    maxclients.value = 1;
    svs.csr = CS_REMAP_RERELEASE; // kex family -- only 1038 is ever accepted
    svs.clients = [new ClientT()];
    geHolder.ge = makeFakeGameExports();
  }

  // UPDATED by this unit (was: "loopback connections are NOT special-cased
  // by this port either" -- the placeholder pin for the pre-negotiation
  // state). Packet_length negotiation now exists (sv_main.ts's
  // SV_ParsePacketLength), so this test now drives a REAL connect handshake
  // for both a loopback and a network sender requesting the SAME
  // client-side value a real q2repro client would request for each
  // (client/main.c:458-462): MAX_PACKETLEN_WRITABLE (4086) for loopback,
  // the net_maxmsglen default (1390) for network -- and pins that the
  // server now treats them differently (main.c:756's
  // `!NET_IsLocalAddress(&net_from)` guard skips the net_maxmsglen cap
  // entirely for the loopback sender), where before this unit both sides
  // always landed on the same hardcoded default regardless of what was
  // requested.
  test("loopback and network connections now negotiate DIFFERENT maxpacketlen values (main.c:756's loopback-skips-cap behavior)", () => {
    setupServer();
    const loopbackAdr = netAdr(NetadrtypeT.NA_LOOPBACK);
    const loopbackClient = driveConnect(loopbackAdr, PROTOCOL_VERSION_RERELEASE, MAX_PACKETLEN_WRITABLE);
    expect(loopbackClient.netchan.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE);
    expect(loopbackClient.netchan.maxpacketlen).toBe(4086);

    setupServer();
    // NOT netAdr(NA_IP)'s all-zero default: platform/net_udp.ts's
    // NET_IsLocalAddress delegates to NET_CompareAdr, which compares IP
    // bytes + port and (unlike the reference's `adr->type == NA_LOOPBACK`,
    // net.h:105) never actually checks `.type` -- an all-zero NA_IP address
    // matches net_local_adr's own all-zero default and would be
    // misclassified as local. A concrete non-zero address sidesteps that
    // pre-existing net_udp.ts quirk (out of this unit's territory) rather
    // than tripping over it.
    const networkAdr = netAdr(NetadrtypeT.NA_IP);
    networkAdr.ip.set([203, 0, 113, 5]);
    networkAdr.port = 27910;
    // A network client requesting the SAME 4086 a loopback client would --
    // if it were also honored uncapped, this test would be unable to tell
    // "no negotiation" from "negotiation but no loopback distinction". It
    // must come back capped to net_maxmsglen (1390) instead.
    const networkClient = driveConnect(networkAdr, PROTOCOL_VERSION_RERELEASE, MAX_PACKETLEN_WRITABLE);
    expect(networkClient.netchan.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE_DEFAULT);
    expect(networkClient.netchan.maxpacketlen).toBe(1390);

    // explicit cross-check, not just each equal to its own literal.
    expect(loopbackClient.netchan.maxpacketlen).not.toBe(networkClient.netchan.maxpacketlen);
    expect(loopbackClient.netchan.maxpacketlen).toBeGreaterThan(networkClient.netchan.maxpacketlen);
  });

  test("an out-of-range packet_length request is rejected ('Invalid maximum message length.', main.c:749-750) instead of silently clamped", () => {
    setupServer();
    const adr = netAdr(NetadrtypeT.NA_LOOPBACK);
    // MAX_PACKETLEN_WRITABLE (4086) + 1 -- one past main.c:749's own ceiling.
    // driveConnect throws when SVC_DirectConnect never produces a connected
    // client, which is exactly the expected outcome of a rejected connect.
    expect(() => driveConnect(adr, PROTOCOL_VERSION_RERELEASE, MAX_PACKETLEN_WRITABLE + 1)).toThrow();
    expect(svs.clients.some((c) => c.state === ClientStateT.cs_connected)).toBe(false);
  });
});
