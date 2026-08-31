// Per-family per-packet budget fidelity pin (.orch/followups.md Finding 3
// residual (a): "does q2repro/KEX use a larger per-packet budget for
// 1038-family datagrams than vanilla's 1400 MAX_MSGLEN?").
//
// VERDICT (citations below): NO. The reference's own DEFAULT per-datagram
// budget for the kex/rerelease (1038) family is byte-identical to vanilla's
// 1400 over a real (non-loopback) connection. There is no protocol-family-
// keyed size increase to port, so this suite pins the CURRENT (correct)
// behavior against a regression rather than proving a new larger buffer.
//
// Evidence (q2repro checkout at ~/Projects/q2repro, q2proto at
// ~/Projects/q2proto):
//   - inc/common/net/net.h:29-34: MAX_PACKETLEN=4096 (hard ceiling),
//     PACKET_HEADER=10, MAX_PACKETLEN_DEFAULT=1400 ("default quake2 limit"),
//     MAX_PACKETLEN_WRITABLE_DEFAULT = 1400-10 = 1390. This ladder is
//     PROTOCOL-AGNOSTIC -- it is not namespaced per protocol family.
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
//     q2proto_proto_q2pro.c:77, q2proto_proto_q2repro.c:54), and vanilla
//     cannot negotiate at all (no packet_length field in its connect verb).
//   - src/server/main.c:746-767 (parse_packet_length): the server honors
//     whatever the client requests, capped by its own net_maxmsglen cvar
//     (same 1390 default) -- so over a real network connection, a stock
//     q2repro dedicated server serving a stock q2repro/kex client settles
//     on 1390 writable + 10-byte header = 1400 total, IDENTICAL to
//     vanilla's MAX_MSGLEN.
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
// This port never parses a client-supplied packet_length for ANY protocol
// family (sv_main.ts's SVC_DirectConnect documents R1Q2's and Q2PRO's tails
// as "read-and-ignored", and never attempts kex's equivalent tail at all),
// so every client's netchan.maxpacketlen is Netchan_Setup's own default
// (MAX_PACKETLEN_WRITABLE_DEFAULT, 1390) regardless of family -- which
// happens to already match the reference's own real-network default
// exactly. Per the standing brief for this finding: the reference also
// uses 1400 for 1038, so no size constant changes; this suite documents
// that with an executable pin instead of prose alone.
//
// Self-sufficient per .orch/preferences.md rule 13: builds its own netchans,
// touches no shared server/client global state.

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
  MAX_FRAGMENT_MSGLEN,
} from "../src/qcommon/net_chan";

function netAdr(type: NetadrtypeT): NetadrT {
  const a = new NetadrT();
  a.type = type;
  return a;
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

  test("loopback connections are NOT special-cased by this port either (matches the 'no negotiation implemented' scope cut, not the reference's loopback bump)", () => {
    // The reference DOES bump loopback connections to MAX_PACKETLEN_WRITABLE
    // (4086) client-side (client/main.c:460-462) -- but that requires this
    // port to (a) parse a client-supplied packet_length for kex's connect
    // tail and (b) have the client request it for loopback, neither of
    // which sv_main.ts's SVC_DirectConnect or cl_main.ts's CL_SendConnectPacket
        // implement (see sv_main.ts's own "read-and-ignored" citations for
    // R1Q2/Q2PRO, and the total absence of an equivalent kex-tail parse).
    // This test pins that OUR loopback and OUR network connections get the
    // identical default today, so a future partial implementation of one
    // side (e.g. client requests bigger, server still ignores it) is caught
    // as a behavior change here rather than discovered live.
    const loopbackChan = new NetchanT();
    Netchan_Setup(
      NetsrcT.NS_SERVER,
      loopbackChan,
      netAdr(NetadrtypeT.NA_LOOPBACK),
      0,
      NETCHAN_NEW,
      PROTOCOL_VERSION_RERELEASE,
    );

    const networkChan = new NetchanT();
    Netchan_Setup(NetsrcT.NS_SERVER, networkChan, netAdr(NetadrtypeT.NA_IP), 0, NETCHAN_NEW, PROTOCOL_VERSION_RERELEASE);

    expect(loopbackChan.maxpacketlen).toBe(networkChan.maxpacketlen);
    expect(loopbackChan.maxpacketlen).toBe(MAX_PACKETLEN_WRITABLE_DEFAULT);
  });
});
