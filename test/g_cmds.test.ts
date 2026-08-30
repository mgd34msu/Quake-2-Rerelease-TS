import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, DF_MODELTEAMS, DF_SKINTEAMS } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { ClientCommand, Cmd_Give_f, Cmd_Say_f, OnSameTeam } from "../src/game/g_cmds";
import {
  EdictT,
  FL_GODMODE,
  FL_NOTARGET,
  g_edicts,
  game,
  gameCvars,
  GClientT,
  globals,
  level,
  SetGEdicts,
} from "../src/game/g_local";

// ---------------------------------------------------------------------------
// fake GameImports, self-contained per .orch/preferences.md rule 13. argc /
// argv / args are backed by a mutable holder so each test can script the
// console-command arguments ClientCommand/Cmd_*_f read via gi.
// ---------------------------------------------------------------------------

interface FakeArgs {
  argv: string[]; // argv[0] is the command name
}

interface RecordedPrints {
  bprintf: Array<[number, string]>;
  cprintf: Array<[Edict | null, number, string]>;
}

function defaultTrace(end: import("../src/shared/math").Vec3): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

function buildFakeImports(args: FakeArgs, recorded: RecordedPrints): GameImports {
  return {
    bprintf: (printlevel, fmt) => {
      recorded.bprintf.push([printlevel, fmt]);
    },
    dprintf: () => {},
    cprintf: (ent, printlevel, fmt) => {
      recorded.cprintf.push([ent, printlevel, fmt]);
    },
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 0,
    soundindex: () => 0,
    imageindex: () => 0,
    setmodel: () => {},
    trace: (_start, _mins, _maxs, end) => defaultTrace(end),
    pointcontents: () => 0,
    inPVS: () => true,
    inPHS: () => true,
    SetAreaPortalState: () => {},
    AreasConnected: () => true,
    linkentity: () => {},
    unlinkentity: () => {},
    BoxEdicts: () => 0,
    Pmove: () => {},
    multicast: () => {},
    unicast: () => {},
    WriteChar: () => {},
    WriteByte: () => {},
    WriteShort: () => {},
    WriteLong: () => {},
    WriteFloat: () => {},
    WriteString: () => {},
    WritePosition: () => {},
    WriteDir: () => {},
    WriteAngle: () => {},
    cvar: () => null,
    cvar_set: () => null,
    cvar_forceset: () => null,
    argc: () => args.argv.length,
    argv: (n) => args.argv[n] ?? "",
    args: () => args.argv.slice(1).join(" "),
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

const MAXENTITIES = 16;

function setupWorld(args: FakeArgs, recorded: RecordedPrints): void {
  GetGameAPI(buildFakeImports(args, recorded));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 4;
  game.maxentities = MAXENTITIES;

  level.clear();

  globals.num_edicts = MAXENTITIES;

  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
}

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

function makeClientEnt(index: number, netname: string, userinfo: string): EdictT {
  const ent = g_edicts[index];
  ent.inuse = true;
  const client = new GClientT();
  client.pers.netname = netname;
  client.pers.userinfo = userinfo;
  ent.client = client;
  return ent;
}

// ---------------------------------------------------------------------------

describe("OnSameTeam", () => {
  test("false when dmflags has neither DF_MODELTEAMS nor DF_SKINTEAMS set", () => {
    const args: FakeArgs = { argv: [] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);
    // dmflags left null (== 0 via cvarNum), matching "deathmatch/coop unset"

    const ent1 = makeClientEnt(1, "red guy", "\\skin\\male/red");
    const ent2 = makeClientEnt(2, "other red guy", "\\skin\\female/red");

    expect(OnSameTeam(ent1, ent2)).toBe(false);
  });

  test("skin-based teams: same skin suffix under DF_SKINTEAMS is the same team", () => {
    const args: FakeArgs = { argv: [] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);
    gameCvars.dmflags = fakeCvar(DF_SKINTEAMS);

    const ent1 = makeClientEnt(1, "red guy", "\\skin\\male/red");
    const ent2 = makeClientEnt(2, "other red guy", "\\skin\\female/red");
    const ent3 = makeClientEnt(3, "blue guy", "\\skin\\male/blue");

    expect(OnSameTeam(ent1, ent2)).toBe(true); // both "red"
    expect(OnSameTeam(ent1, ent3)).toBe(false); // "red" vs "blue"
  });

  test("model-based teams: same model prefix under DF_MODELTEAMS is the same team", () => {
    const args: FakeArgs = { argv: [] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);
    gameCvars.dmflags = fakeCvar(DF_MODELTEAMS);

    const ent1 = makeClientEnt(1, "a", "\\skin\\male/red");
    const ent2 = makeClientEnt(2, "b", "\\skin\\male/blue");

    expect(OnSameTeam(ent1, ent2)).toBe(true); // both "male"
  });
});

describe("Cmd_Give_f", () => {
  test("grants health when sv_cheats is enabled outside deathmatch gating", () => {
    const args: FakeArgs = { argv: ["give", "health"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);
    gameCvars.deathmatch = fakeCvar(0);
    gameCvars.sv_cheats = fakeCvar(1);

    const ent = makeClientEnt(1, "player", "\\skin\\male/grunt");
    ent.health = 10;
    ent.max_health = 100;

    Cmd_Give_f(ent);

    expect(ent.health).toBe(100);
  });

  test("refuses in deathmatch when sv_cheats is not enabled", () => {
    const args: FakeArgs = { argv: ["give", "health"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);
    gameCvars.deathmatch = fakeCvar(1);
    gameCvars.sv_cheats = fakeCvar(0);

    const ent = makeClientEnt(1, "player", "\\skin\\male/grunt");
    ent.health = 10;
    ent.max_health = 100;

    Cmd_Give_f(ent);

    expect(ent.health).toBe(10); // unchanged
    expect(recorded.cprintf.length).toBe(1);
    expect(recorded.cprintf[0][2]).toContain("cheats 1");
  });
});

describe("Cmd_Say_f", () => {
  test("builds the chat string with the speaker's name prefix and broadcasts via cprintf", () => {
    const args: FakeArgs = { argv: ["say", "hello", "world"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);

    const ent = makeClientEnt(1, "Mike", "\\skin\\male/grunt");
    makeClientEnt(2, "Other", "\\skin\\male/grunt");

    Cmd_Say_f(ent, false, false);

    expect(recorded.cprintf.length).toBeGreaterThan(0);
    const messages = recorded.cprintf.map((c) => c[2]);
    expect(messages.some((m) => m.startsWith("Mike: hello world"))).toBe(true);
  });
});

describe("ClientCommand", () => {
  test("dispatches to Cmd_Notarget_f based on gi.argv(0) and toggles FL_NOTARGET", () => {
    const args: FakeArgs = { argv: ["notarget"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);

    const ent = makeClientEnt(1, "player", "\\skin\\male/grunt");
    expect(ent.flags & FL_NOTARGET).toBe(0);

    ClientCommand(ent);

    expect(ent.flags & FL_NOTARGET).toBe(FL_NOTARGET);
  });

  test("dispatches to Cmd_God_f based on gi.argv(0) and toggles FL_GODMODE", () => {
    const args: FakeArgs = { argv: ["god"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);

    const ent = makeClientEnt(1, "player", "\\skin\\male/grunt");
    expect(ent.flags & FL_GODMODE).toBe(0);

    ClientCommand(ent);

    expect(ent.flags & FL_GODMODE).toBe(FL_GODMODE);
  });

  test("unrecognized commands fall through to a chat message (arg0 say)", () => {
    const args: FakeArgs = { argv: ["gg"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);

    const ent = makeClientEnt(1, "Mike", "\\skin\\male/grunt");

    ClientCommand(ent);

    const messages = recorded.cprintf.map((c) => c[2]);
    expect(messages.some((m) => m.startsWith("Mike: gg"))).toBe(true);
  });

  test("does nothing when ent.client is null (not fully in game yet)", () => {
    const args: FakeArgs = { argv: ["notarget"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);

    const ent = g_edicts[1];
    ent.client = null;

    expect(() => ClientCommand(ent)).not.toThrow();
    expect(ent.flags & FL_NOTARGET).toBe(0);
  });

  test("recovers the correct client edict by identity when s.number is stale-zero, not world", () => {
    // Models a just-connected client slot: g_spawn.ts's SpawnEntities
    // .clear()s every edict (including reserved player slots) on map load,
    // and sv_user.ts's SV_New_f hasn't run yet to re-sync s.number. A boundary
    // Edict reaching ClientCommand pre-spawn can therefore still read
    // s.number === 0 even though it really lives at g_edicts[2]. The old
    // g_edicts[edict.s.number] lookup would silently resolve that to world
    // (g_edicts[0], client === null) and bail out instead of dispatching to
    // the real client.
    const args: FakeArgs = { argv: ["notarget"] };
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld(args, recorded);

    const ent = g_edicts[2];
    ent.s.number = 0; // stale-zero, not yet re-synced by SV_New_f
    ent.inuse = true;
    const client = new GClientT();
    client.pers.netname = "player";
    client.pers.userinfo = "\\skin\\male/grunt";
    ent.client = client;

    expect(ent.flags & FL_NOTARGET).toBe(0);

    ClientCommand(ent);

    // Dispatched to the real client at g_edicts[2], not world.
    expect(ent.flags & FL_NOTARGET).toBe(FL_NOTARGET);
    expect(g_edicts[0].flags & FL_NOTARGET).toBe(0);
  });
});
