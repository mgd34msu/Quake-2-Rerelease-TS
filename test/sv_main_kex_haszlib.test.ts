// .orch/followups.md post-1.0 follow-up: the kex/1038 connect string's
// has_zlib tail token (q2proto_q2repro_connect_tail: "<packet_length>
// <has_zlib>", q2proto_proto_q2repro.c:54) was parsed and written by the
// client (cl_main.ts's CL_SendConnectPacket) but silently left unread on
// the server side (sv_main.ts's SVC_DirectConnect isKexFamily branch used
// to comment "has_zlib stays unread here -- out of scope for this unit").
//
// Reference behavior (q2proto_proto_q2repro.c):
//   - q2proto_q2repro_parse_connect (line 33-39): `parsed_connect->has_zlib
//     = q2pstol(&zlib_token, 10) != 0` -- the flag IS read off the wire.
//   - q2proto_q2repro_init_servercontext (line 1353-1360): `context->
//     features.enable_deflate = connect_info->has_zlib;` AND `context->
//     zpacket_cmd = svc_q2repro_zpacket` -- a real q2repro server both
//     honors the flag and, when it does compress, uses ITS OWN opcode
//     (svc_q2repro_zpacket), distinct from the svc_r1q2_zpacket/SVC_ZPACKET
//     opcode shared by the R1Q2 and Q2PRO families.
//
// This port's qcommon/protocol/zpacket.ts only ever implements the shared
// R1Q2/Q2PRO opcode (SVC_ZPACKET=21) -- svc_q2repro_zpacket's own write side
// does not exist anywhere in this codebase. Wiring a parsed has_zlib=1
// straight into ClientT.netchan.compress the way the Q2PRO branch does
// would make net_chan.ts's Netchan_Transmit choke point wrap large kex-
// family reliable bursts in the WRONG opcode for a real q2repro client to
// decode -- an interop-breaking regression, strictly worse than the
// previous "field silently skipped" state.
//
// The fix (sv_main.ts's SVC_DirectConnect): the token IS now read (both "0"
// and "1" take different, deliberate code paths -- no longer unconditionally
// skipped), but a "1" request never flips netchan.compress, and instead
// prints an honest Com_DPrintf diagnostic that this server will not
// compress kex-family traffic. This suite pins both halves: the flag no
// longer silently vanishes, AND the wire-compatibility-preserving choice not
// to act on a "1" request.
//
// Self-sufficient per .orch/preferences.md rule 13: builds its own server
// state and drives SVC_GetChallenge/SVC_DirectConnect directly, copying
// test/net_chan_maxpacketlen_parity.test.ts's own driveConnect/setupServer
// fixtures (that file exports none of them) rather than importing them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NetadrT, NetadrtypeT, NetsrcT, PROTOCOL_VERSION_RERELEASE } from "../src/qcommon/qcommon";
import { net_from } from "../src/qcommon/net_chan";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients, RedirectT } from "../src/server/server";
import { SV_Init, SVC_GetChallenge, SVC_DirectConnect } from "../src/server/sv_main";
import { geHolder } from "../src/server/sv_game";
import { NET_CompareBaseAdr } from "../src/platform/net_udp";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { Cvar_FullSet, Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";
import type { CvarT } from "../src/shared/q_shared";
import { Com_BeginRedirect, Com_EndRedirect, developer, setDeveloper } from "../src/qcommon/common";
import { CVAR_LATCH, CVAR_SERVERINFO, EntityStateT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { CS_REMAP_RERELEASE } from "../src/shared/cs_remap";

// developer=1 so Com_DPrintf's own "if (!developer || !developer.value)
// return" guard doesn't swallow the diagnostic before this suite can see it.
//
// Rule 13: "developer" is a process-wide cvar shared with every other suite
// in the same `bun test` process (test/cvar_parity.test.ts boots the whole
// engine and asserts it still reads its q2repro default "0"), so this is
// registered with the parity-correct "0" default, raised only for the
// duration of this file's tests, and put back to whatever it was before --
// rather than force-set once at module scope where it would outlive the
// file. common.ts's `developer` holder is pointed at the same CvarT object
// Qcommon_Init would install, so restoring the value is enough; the holder
// is restored too for the case where this file ran before any boot.
const developerCvar = Cvar_Get("developer", "0", 0);
let priorDeveloperValue = "0";
let priorDeveloperHolder: CvarT | null = null;

beforeAll(() => {
  priorDeveloperValue = developerCvar ? developerCvar.string : "0";
  priorDeveloperHolder = developer;
  setDeveloper(developerCvar);
  Cvar_ForceSet("developer", "1");
});

afterAll(() => {
  Cvar_ForceSet("developer", priorDeveloperValue);
  setDeveloper(priorDeveloperHolder);
});

function netAdr(type: NetadrtypeT): NetadrT {
  const a = new NetadrT();
  a.type = type;
  return a;
}

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

function setupServer(): void {
  Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
  sv.state = ServerStateT.ss_dead;
  svs.initialized = false;
  SV_Init();
  if (!maxclients) throw new Error("maxclients not initialized");
  maxclients.value = 1;
  svs.csr = CS_REMAP_RERELEASE; // kex family -- only 1038 is ever accepted
  // The kex family also demands one specific wire protocol; since the
  // configstring width became a SESSION property (server.ts's
  // ServerStaticT.sessionProtocol), that demand lives on its own field
  // rather than being inferred from svs.csr -- a classic-module session
  // can be wide too. Set both, the way SV_InitGameProgs does.
  svs.sessionProtocol = PROTOCOL_VERSION_RERELEASE;
  svs.clients = [new ClientT()];
  geHolder.ge = makeFakeGameExports();
}

// Drives one full "getchallenge" + "connect" handshake for the kex family
// (protocol 1038), with a caller-supplied has_zlib tail token, and returns
// the resulting ClientT.
function driveKexConnect(hasZlibToken: string): ClientT {
  const fromAdr = netAdr(NetadrtypeT.NA_IP);
  fromAdr.ip.set([203, 0, 113, 9]);
  fromAdr.port = 27910;
  net_from.type = fromAdr.type;
  net_from.ip.set(fromAdr.ip);
  net_from.port = fromAdr.port;

  Cmd_TokenizeString("getchallenge", false);
  SVC_GetChallenge();
  const entry = svs.challenges.find((c) => NET_CompareBaseAdr(net_from, c.adr));
  if (!entry) throw new Error("SVC_GetChallenge did not record a challenge for this address");
  const challenge = entry.challenge;

  // q2proto_q2repro_connect_tail: "<packet_length> <has_zlib>".
  Cmd_TokenizeString(`connect ${PROTOCOL_VERSION_RERELEASE} 3000 ${challenge} "\\name\\Tester" 1390 ${hasZlibToken}`, false);
  SVC_DirectConnect();

  const connected = svs.clients.find((c) => c.state === ClientStateT.cs_connected);
  if (!connected) throw new Error("SVC_DirectConnect did not produce a connected client");
  return connected;
}

/** Captures every Com_Printf line emitted during `fn`, via qcommon's own
 * rcon-style redirect seam (Com_BeginRedirect/Com_EndRedirect). */
function captureComPrintf(fn: () => void): string {
  let out = "";
  Com_BeginRedirect(RedirectT.RD_PACKET, 4096, (_target, buffer) => {
    out += buffer;
  });
  try {
    fn();
  } finally {
    Com_EndRedirect();
  }
  return out;
}

describe("kex/1038 connect tail: has_zlib is read, never silently skipped", () => {
  test("has_zlib=1 is parsed (diagnostic fires) but does NOT enable netchan.compress -- no svc_q2repro_zpacket write side exists", () => {
    setupServer();
    let client!: ClientT;
    const printed = captureComPrintf(() => {
      client = driveKexConnect("1");
    });

    expect(client.netchan.compress).toBe(false);
    expect(printed).toContain("has_zlib=1");
    expect(printed).toContain("svc_q2repro_zpacket");
  });

  test("has_zlib=0 is parsed too -- connects identically, no diagnostic (this is the already-correct branch)", () => {
    setupServer();
    let client!: ClientT;
    const printed = captureComPrintf(() => {
      client = driveKexConnect("0");
    });

    expect(client.netchan.compress).toBe(false);
    expect(printed).not.toContain("has_zlib=1");
  });

  test("an omitted has_zlib token (Cmd_Argv(6) === \"\") reads as 0, matching atoi(\"\") === 0 -- no diagnostic, no throw", () => {
    setupServer();
    let client!: ClientT;
    const printed = captureComPrintf(() => {
      client = driveKexConnect("");
    });

    expect(client.netchan.compress).toBe(false);
    expect(printed).not.toContain("has_zlib=1");
  });
});
