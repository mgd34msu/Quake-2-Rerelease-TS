// sv_game.c / sv_user.c / sv_ccmds.c -- server<->game boundary + user/console
// command dispatch. Self-sufficient per PORTING.md/preferences.md rule 13:
// every global this suite reads is initialized here, not assumed from
// another test file's run order.
//
// SV_InitGameProgs's final step (`ge.Init()`) calls into g_main.ts's
// InitGame, which still throws PendingPort("g_save.c:InitGame") because
// g_save.c has not landed yet (see .orch/followups.md). That happens *after*
// geHolder.ge has already been assigned and after GetGameAPI has already
// called SetGameImports, so this suite verifies what it can up to that
// point and asserts the PendingPort throw explicitly rather than skipping
// the whole function. Anything that needs a spawned map (SV_Begin_f's
// ge.ClientBegin, SV_GameMap_f's real level save/load round-trip,
// SV_ExecuteClientMessage's clc_move path) is out of reach without a real
// BSP + game session and is not exercised here.

import { beforeAll, describe, expect, test } from "bun:test";
import { GAME_API_VERSION } from "../src/game/game";
import { ComError } from "../src/qcommon/qcommon";
import { NetadrT, NetsrcT } from "../src/qcommon/qcommon";
import { Netchan_Setup } from "../src/qcommon/net_chan";
import { Cmd_Argc, Cmd_Args, Cmd_Argv, Cmd_TokenizeString } from "../src/qcommon/cmd";
import { Cvar_Get } from "../src/qcommon/cvar";
import { PRINT_HIGH } from "../src/shared/q_shared";
import { EdictT, gi } from "../src/game/g_local";
import {
  ClientStateT,
  ClientT,
  ServerStateT,
  setMaxclients,
  sv,
  svClientHolder,
  svPlayerHolder,
  svs,
} from "../src/server/server";
import { geHolder, PF_Configstring, PF_cprintf, SV_InitGameProgs } from "../src/server/sv_game";
import { SV_ExecuteUserCommand } from "../src/server/sv_user";

// Read a mutable field back through a function-call boundary rather than
// as `cl.state`/`svPlayerHolder.sv_player` directly: TS's control-flow
// narrowing on a dotted property access is not invalidated by an
// intervening opaque call (SV_ExecuteUserCommand mutates these globals
// internally, which tsc cannot see), so a literal assigned above would
// otherwise pin the property's apparent type and reject a `.toBe()` of any
// other member.
function currentClientState(c: ClientT): ClientStateT {
  return c.state;
}
function currentSvPlayer(): ClientT["edict"] {
  return svPlayerHolder.sv_player;
}

// g_save.ts's InitGame is real now: SV_InitGameProgs runs end-to-end,
// registering game cvars through the real Cvar_Get and allocating
// g_edicts/game.clients.
function initGameProgsExpectingPendingInit(): void {
  expect(() => SV_InitGameProgs()).not.toThrow();
}

describe("SV_InitGameProgs", () => {
  beforeAll(() => {
    initGameProgsExpectingPendingInit();
  });

  test("builds GameImports and calls the real GetGameAPI, populating geHolder.ge", () => {
    expect(geHolder.ge).not.toBeNull();
    expect(geHolder.ge?.apiversion).toBe(GAME_API_VERSION);
  });

  test("wires GameImports.Pmove/argc/argv/args through to gi (SetGameImports ran before Init threw)", () => {
    expect(gi).toBeDefined();
    expect(typeof gi.argc).toBe("function");
    expect(typeof gi.argv).toBe("function");
    expect(typeof gi.args).toBe("function");
  });

  test("gi.args/argv round-trip via Cmd_TokenizeString", () => {
    Cmd_TokenizeString('say "hello world" 42', true);

    expect(gi.argc()).toBe(Cmd_Argc());
    expect(gi.argc()).toBe(3);
    expect(gi.argv(0)).toBe("say");
    expect(gi.argv(1)).toBe("hello world");
    expect(gi.argv(2)).toBe("42");
    expect(gi.argv(0)).toBe(Cmd_Argv(0));
    expect(gi.args()).toBe(Cmd_Args());
  });
});

describe("PF_Configstring", () => {
  test("writes sv.configstrings at the given index", () => {
    sv.state = ServerStateT.ss_loading; // skip the SV_Multicast broadcast path
    PF_Configstring(7, "maps/q2dm1.bsp");
    expect(sv.configstrings[7]).toBe("maps/q2dm1.bsp");
  });

  test("rejects an out-of-range index the way Com_Error(ERR_DROP, ...) does", () => {
    expect(() => PF_Configstring(-1, "x")).toThrow(ComError);
  });
});

describe("PF_cprintf", () => {
  function makeClient(): ClientT {
    const cl = new ClientT();
    Netchan_Setup(NetsrcT.NS_SERVER, cl.netchan, new NetadrT(), 0);
    return cl;
  }

  test("routes to Com_Printf (not a per-client write) when ent is null", () => {
    // no client array needed at all for the null-ent path; a throw here
    // would mean PF_cprintf tried to treat null as a client.
    expect(() => PF_cprintf(null, PRINT_HIGH, "console line\n")).not.toThrow();
  });

  test("routes to SV_ClientPrintf (writes into the client's netchan.message) when ent is a valid client", () => {
    const maxclients = Cvar_Get("maxclients", "4", 0);
    expect(maxclients).not.toBeNull();
    if (maxclients) setMaxclients(maxclients);
    if (maxclients) maxclients.value = 1;

    const cl = makeClient();
    svs.clients = [cl];

    const ent = new EdictT();
    ent.s.number = 1; // NUM_FOR_EDICT(ent) -> svs.clients[0]

    expect(cl.netchan.message.cursize).toBe(0);
    PF_cprintf(ent, PRINT_HIGH, "you scored a point\n");
    expect(cl.netchan.message.cursize).toBeGreaterThan(0);
  });

  test("Com_Error(ERR_DROP, ...) when ent's slot is outside [1, maxclients]", () => {
    const maxclients = Cvar_Get("maxclients", "1", 0);
    if (maxclients) setMaxclients(maxclients);
    if (maxclients) maxclients.value = 1;
    svs.clients = [new ClientT()];

    const ent = new EdictT();
    ent.s.number = 99; // well past maxclients

    expect(() => PF_cprintf(ent, PRINT_HIGH, "unreachable\n")).toThrow(ComError);
  });
});

describe("SV_ExecuteUserCommand", () => {
  test('dispatches a fabricated "disconnect" ucmd against a fabricated sv_client', () => {
    const cl = new ClientT();
    Netchan_Setup(NetsrcT.NS_SERVER, cl.netchan, new NetadrT(), 0);
    cl.state = ClientStateT.cs_connected; // not cs_spawned -- avoids ge.ClientDisconnect
    cl.edict = null;

    svClientHolder.sv_client = cl;
    svPlayerHolder.sv_player = null;

    expect(() => SV_ExecuteUserCommand("disconnect")).not.toThrow();

    // SV_Disconnect_f -> SV_DropClient(cl): writes svc_disconnect and zombifies
    expect(cl.netchan.message.cursize).toBeGreaterThan(0);
    expect(currentClientState(cl)).toBe(ClientStateT.cs_zombie);
    expect(cl.name).toBe("");
  });

  test("sets svPlayerHolder.sv_player from sv_client.edict before dispatch", () => {
    const cl = new ClientT();
    Netchan_Setup(NetsrcT.NS_SERVER, cl.netchan, new NetadrT(), 0);
    cl.state = ClientStateT.cs_connected;
    const ent = new EdictT();
    ent.s.number = 1;
    cl.edict = ent;

    svClientHolder.sv_client = cl;
    svPlayerHolder.sv_player = null;

    SV_ExecuteUserCommand("disconnect");

    expect(currentSvPlayer()).toBe(ent);
  });
});

// Needs a spawned map / real BSP + game session, out of reach for a unit
// test and skipped per this unit's brief:
//   - SV_New_f / SV_Configstrings_f / SV_Baselines_f / SV_Begin_f: require a
//     populated sv.state === ss_game with real ge.edicts and a live
//     ge.ClientBegin (still PendingPort via p_client.c).
//   - SV_ExecuteClientMessage's clc_move branch: requires a real
//     ge.ClientThink and a wire-format usercmd delta sequence.
//   - SV_GameMap_f / SV_Map_f / SV_Loadgame_f / SV_Savegame_f: require
//     SV_Map (loads an actual BSP via sv_init.ts) and g_save.c's
//     WriteGame/ReadGame/WriteLevel/ReadLevel, both still PendingPort.
//   - SV_ServerRecord_f: always takes the "couldn't open" branch on this
//     port (no write primitive on the sanctioned file-I/O surface -- see
//     sv_ccmds.ts's header comment), so there is no signon-message dump to
//     assert against.
