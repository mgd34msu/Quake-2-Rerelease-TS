// The configstring space and index widths are a property of the SESSION, not
// of the game module. Gate for that split:
//
//   - sv_init.ts's SV_WidenConfigstringSpace / SV_ModelIndex escalation: a
//     classic-module session that runs out of the classic family's 256 model
//     slots relocates itself onto the wide (rerelease) configstring layout
//     mid-spawn and keeps going, instead of dying on "*Index: overflow".
//   - sv_main.ts's SVC_GetChallenge / SVC_DirectConnect: which protocols such
//     a session offers and accepts, and -- the fidelity half -- that a
//     classic session which never had to widen still advertises and accepts
//     34/35/36 exactly as it always did.
//   - cl_parse.ts's selectServerCodec: the client reads
//     PROTOCOL_VERSION_RERELEASE_CLASSIC back as "wide layout, CLASSIC game
//     module", which is what keeps the classic monster-flash table and the
//     classic HUD selected on a widened session.
//   - bindings/legacy.ts's PF_LegacyConfigstring: a frozen legacy game tree
//     computes raw CS_* indices against the classic layout always, so the
//     engine/module boundary translates them to whichever layout is live.
//
// Fixtures are private copies rather than imports (.orch/preferences.md rule
// 13, self-sufficient test files), following test/protocol_negotiation_e2e.
// test.ts's own harness shape for the loopback connect drive.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients } from "../src/server/server";
import { SV_Init, SV_ConnectionlessPacket } from "../src/server/sv_main";
import { SV_ModelIndex, SV_WidenConfigstringSpace } from "../src/server/sv_init";
import { geHolder } from "../src/server/sv_game";
import { BuildLegacyImports } from "../src/server/bindings/legacy";
import { selectServerCodec } from "../src/client/cl_parse";
import { NetadrT, NetadrtypeT, NetsrcT, PROTOCOL_VERSION, PROTOCOL_VERSION_RERELEASE, PROTOCOL_VERSION_RERELEASE_CLASSIC } from "../src/qcommon/qcommon";
import { net_from, net_message } from "../src/qcommon/net_chan";
import { NET_ClearLoopback, NET_SendPacket, NET_GetPacket } from "../src/platform/net_udp";
import { MSG_BeginReading, MSG_ReadLong } from "../src/qcommon/sizebuf";
import { Cvar_FullSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { CVAR_LATCH, CVAR_SERVERINFO, EntityStateT, CS_NAME, CS_MODELS, CS_ITEMS, MAX_MODELS } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";

// ---- fixtures ------------------------------------------------------------

function loopbackAdr(): NetadrT {
  const a = new NetadrT();
  a.type = NetadrtypeT.NA_LOOPBACK;
  return a;
}

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

// Rule 13 teardown: every piece of process-global server/session state this
// suite drives (sv/svs, the game-exports holder, the latched maxclients cvar,
// the loopback rings, the session layout/protocol) is restored, so the
// engine-boot suites that run after this file in a clean checkout's order
// (boot, protocol_q2repro_boot, cl_main, cvar_parity, savegame_kex_e2e) see
// the same pristine process they would have seen running alone.
const preTestMaxclients = Cvar_VariableString("maxclients") || "8";
afterAll(() => {
  geHolder.ge = null;
  sv.clear();
  svs.clear();
  svs.csr = CS_REMAP_OLD;
  svs.sessionProtocol = 0;
  sv.state = ServerStateT.ss_dead;
  svs.initialized = false;
  NET_ClearLoopback();
  Cvar_FullSet("maxclients", preTestMaxclients, CVAR_SERVERINFO | CVAR_LATCH);
});

// A freshly-spawned CLASSIC-module session, mid-map-load: the exact state
// SV_ModelIndex is called from while the game module spawns entities.
function setupClassicLoadingServer(): void {
  Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
  sv.state = ServerStateT.ss_dead;
  svs.initialized = false;
  SV_Init();
  if (!maxclients) throw new Error("maxclients not initialized");
  maxclients.value = 1;
  sv.clear();
  svs.clients = [new ClientT()];
  geHolder.ge = makeFakeGameExports();

  // What sv_game.ts's SV_InitGameProgs leaves behind for the classic family.
  svs.csr = CS_REMAP_OLD;
  svs.sessionProtocol = 0;
  sv.state = ServerStateT.ss_loading;
}

// Sends one connectionless packet and runs the server's handler on it.
function sendOob(text: string): void {
  const adr = loopbackAdr();
  const bytes = new Uint8Array(4 + text.length);
  bytes.set([0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < text.length; i++) bytes[4 + i] = text.charCodeAt(i);
  NET_SendPacket(NetsrcT.NS_CLIENT, bytes.length, bytes, adr);
  expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
  SV_ConnectionlessPacket();
}

// Reads the server's next reply to the client as text (past the -1 header).
function readOobReply(): string {
  const from = new NetadrT();
  if (!NET_GetPacket(NetsrcT.NS_CLIENT, from, net_message)) return "";
  MSG_BeginReading(net_message);
  MSG_ReadLong(net_message);
  return new TextDecoder().decode(net_message.data.slice(net_message.readcount, net_message.cursize));
}

function getChallenge(): { text: string; challenge: number } {
  NET_ClearLoopback();
  sendOob("getchallenge");
  const text = readOobReply();
  const challenge = Number.parseInt(text.slice("challenge ".length), 10);
  return { text, challenge };
}

// Drives a connect for `protocol` and returns the connected ClientT, or null
// when the server refused (plus the refusal text it printed).
function driveConnect(protocol: number, tail: string): { client: ClientT | null; reply: string } {
  const { challenge } = getChallenge();
  expect(Number.isNaN(challenge)).toBe(false);
  sendOob(`connect ${protocol} 3000 ${challenge} "\\name\\Tester"${tail}`);
  const reply = readOobReply();
  const client = svs.clients.find((c) => c.state === ClientStateT.cs_connected) ?? null;
  return { client, reply };
}

// Fills the classic model block right up to its last usable slot without
// tripping the overflow: SV_FindIndex hands out 1..max-1, so max-1 distinct
// names is exactly full.
function fillClassicModelBlock(): void {
  for (let i = 1; i < MAX_MODELS; i++) SV_ModelIndex(`models/filler${i}/tris.md2`);
}

describe("classic-module session: widening the configstring space", () => {
  beforeEach(() => {
    setupClassicLoadingServer();
  });

  test("a session that fits the classic limits never widens -- layout, codec and protocol all unchanged", () => {
    for (let i = 1; i < 200; i++) SV_ModelIndex(`models/fits${i}/tris.md2`);

    expect(svs.csr).toBe(CS_REMAP_OLD);
    expect(svs.codec.name).toBe("vanilla");
    expect(svs.sessionProtocol).toBe(0);
    // Indices are the plain classic ones, in allocation order.
    expect(SV_ModelIndex("models/fits1/tris.md2")).toBe(1);
    expect(SV_ModelIndex("models/fits199/tris.md2")).toBe(199);
  });

  test("filling the classic model block escalates the session to the wide layout instead of erroring", () => {
    fillClassicModelBlock();
    expect(svs.csr).toBe(CS_REMAP_OLD); // exactly full is not yet an overflow

    // The next distinct model is the one the classic layout has no room for.
    const idx = SV_ModelIndex("models/overflowing/tris.md2");

    expect(svs.csr).toBe(CS_REMAP_RERELEASE);
    expect(svs.codec.name).toBe("q2repro-classic");
    expect(svs.sessionProtocol).toBe(PROTOCOL_VERSION_RERELEASE_CLASSIC);
    expect(idx).toBe(MAX_MODELS); // 256 -- the first index the classic family could not express
  });

  test("indices already handed out stay valid across the widening, and keep growing past the classic ceiling", () => {
    fillClassicModelBlock();
    SV_ModelIndex("models/overflowing/tris.md2"); // triggers the widening

    // A name precached BEFORE the widening still resolves to the same index.
    expect(SV_ModelIndex("models/filler7/tris.md2")).toBe(7);
    // ...and its configstring travelled with it, into the wide layout's block.
    expect(sv.configstrings[CS_REMAP_RERELEASE.models + 7]).toBe("models/filler7/tris.md2");

    // Allocation continues well past 256, which is the whole point.
    for (let i = 0; i < 500; i++) SV_ModelIndex(`models/after${i}/tris.md2`);
    expect(SV_ModelIndex("models/after499/tris.md2")).toBe(MAX_MODELS + 500);
  });

  test("relocation moves the blocks that differ and leaves the shared low indices alone", () => {
    sv.configstrings[CS_NAME] = "mgu4m1";
    sv.configstrings[CS_MODELS + 3] = "maps/mgu4m1.bsp";
    sv.configstrings[CS_REMAP_OLD.mapchecksum] = "12345";

    expect(SV_WidenConfigstringSpace()).toBe(true);

    // CS_NAME is below `airaccel`; both families agree on it, so it stays put.
    expect(sv.configstrings[CS_NAME]).toBe("mgu4m1");
    // The model and mapchecksum entries moved to their wide-layout homes and
    // their classic slots were vacated.
    expect(sv.configstrings[CS_REMAP_RERELEASE.models + 3]).toBe("maps/mgu4m1.bsp");
    expect(sv.configstrings[CS_MODELS + 3]).toBe("");
    expect(sv.configstrings[CS_REMAP_RERELEASE.mapchecksum]).toBe("12345");
  });

  test("widening is refused once the map is live, so a late overflow stays the hard error it always was", () => {
    // Precache during load, exactly as a real map does (SV_FindIndex only
    // broadcasts svc_configstring once the server has left ss_loading).
    fillClassicModelBlock();

    sv.state = ServerStateT.ss_game; // clients have now been told the classic layout
    expect(SV_WidenConfigstringSpace()).toBe(false);
    expect(svs.csr).toBe(CS_REMAP_OLD);

    expect(() => SV_ModelIndex("models/toolate/tris.md2")).toThrow(/overflow/);
  });

  test("an already-wide session does not widen again", () => {
    svs.csr = CS_REMAP_RERELEASE;
    expect(SV_WidenConfigstringSpace()).toBe(false);
  });
});

describe("classic-module session: what the legacy game module's raw configstring indices become", () => {
  beforeEach(() => {
    setupClassicLoadingServer();
  });

  test("unwidened: a raw CS_ITEMS write lands on exactly the classic index, byte-for-byte as before", () => {
    BuildLegacyImports().configstring(CS_ITEMS + 4, "a Blaster");
    expect(sv.configstrings[CS_ITEMS + 4]).toBe("a Blaster");
  });

  test("widened: the same raw write is translated into the wide layout's items block", () => {
    SV_WidenConfigstringSpace();
    BuildLegacyImports().configstring(CS_ITEMS + 4, "a Blaster");

    expect(sv.configstrings[CS_REMAP_RERELEASE.items + 4]).toBe("a Blaster");
    // Untranslated, this index would have landed in the wide layout's SOUNDS
    // block and clobbered a precached sound name.
    expect(sv.configstrings[CS_ITEMS + 4]).toBe("");
  });
});

describe("classic-module session: protocol negotiation", () => {
  beforeEach(() => {
    setupClassicLoadingServer();
  });

  test("FIDELITY: a classic session that never widened still offers and accepts protocol 34 for a vanilla-only client", () => {
    sv.state = ServerStateT.ss_game;

    const { text } = getChallenge();
    expect(text).toContain("p=34,35,36");
    expect(text).not.toContain("4038");

    const { client } = driveConnect(PROTOCOL_VERSION, "");
    expect(client).not.toBeNull();
    expect(client?.codec.name).toBe("vanilla");
  });

  test("a widened session offers only its own protocol", () => {
    SV_WidenConfigstringSpace();
    sv.state = ServerStateT.ss_game;

    const { text } = getChallenge();
    expect(text).toContain(`p=${PROTOCOL_VERSION_RERELEASE_CLASSIC}`);
    expect(text).not.toContain("p=34");
  });

  test("a widened session refuses a vanilla-only client cleanly, saying why, instead of corrupting it", () => {
    SV_WidenConfigstringSpace();
    sv.state = ServerStateT.ss_game;

    const { client, reply } = driveConnect(PROTOCOL_VERSION, "");
    expect(client).toBeNull();
    expect(reply).toContain("models/sounds/images");
    expect(reply).toContain(String(PROTOCOL_VERSION_RERELEASE_CLASSIC));
  });

  test("a widened session accepts its own protocol and hands that client the wide codec", () => {
    SV_WidenConfigstringSpace();
    sv.state = ServerStateT.ss_game;

    const { client } = driveConnect(PROTOCOL_VERSION_RERELEASE_CLASSIC, " 1400 0");
    expect(client).not.toBeNull();
    expect(client?.codec.name).toBe("q2repro-classic");
  });
});

describe("client: reading the session's protocol back", () => {
  test("PROTOCOL_VERSION_RERELEASE_CLASSIC selects the wide layout with the CLASSIC game family", () => {
    const sel = selectServerCodec(PROTOCOL_VERSION_RERELEASE_CLASSIC);
    expect(sel.codec.name).toBe("q2repro-classic");
    expect(sel.csr).toBe(CS_REMAP_RERELEASE);
    // The whole reason the number exists: wide indices, classic game module,
    // so cl_fx.ts keeps the classic monster-flash table and cl_parse.ts keeps
    // the classic cgame/HUD.
    expect(sel.gameFamily).toBe("classic");
    // ...and the wide bounds really are in force.
    expect(sel.csr.max_models).toBe(CS_REMAP_RERELEASE.max_models);
    // csr.extended is the WIRE's capability flag, and it must be on: it gates
    // the client paths that read fields only a wide protocol can carry --
    // RF_FLARE / misc_flare and target_light (cl_ents.ts's modelindex-1 skip,
    // without which a rerelease flare resolves to the world model),
    // s.alpha/s.scale, shadow lights, and the subdir+extension asset names
    // rerelease content uses (cl_parse.ts's CL_RegisterImage). A classic
    // session only ever widens because it is carrying rerelease content, so
    // these must be live for it exactly as they are for the kex family.
    expect(sel.csr.extended).toBe(true);
  });

  test("1038 still selects the rerelease game family, unchanged", () => {
    const sel = selectServerCodec(PROTOCOL_VERSION_RERELEASE);
    expect(sel.codec.name).toBe("q2repro");
    expect(sel.csr).toBe(CS_REMAP_RERELEASE);
    expect(sel.gameFamily).toBe("kex");
  });

  test("34 still selects vanilla on the classic layout, unchanged", () => {
    const sel = selectServerCodec(PROTOCOL_VERSION);
    expect(sel.codec.name).toBe("vanilla");
    expect(sel.csr).toBe(CS_REMAP_OLD);
    expect(sel.gameFamily).toBe("classic");
  });
});
