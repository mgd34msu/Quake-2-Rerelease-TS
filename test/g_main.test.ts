import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import {
  CheckDMRules,
  ClientEndServerFrames,
  CreateTargetChangeLevel,
  EndDMLevel,
  ExitLevel,
  GetGameAPI,
  G_RunFrame,
} from "../src/game/g_main";
import { type GameImports, type GTraceT, GAME_API_VERSION } from "../src/game/game";
import { EdictT, FRAMETIME, gameCvars, game, GClientT, gi, globals, level, SetGEdicts } from "../src/game/g_local";
import { DF_SAME_LEVEL } from "../src/shared/q_shared";

// --- a minimal fake GameImports: methods record calls, trace returns a
// fraction-1 GTraceT, cvar returns a fabricated CvarT. ---

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

interface RecordedCalls {
  bprintf: Array<[number, string]>;
  AddCommandString: string[];
}

function buildFakeImports(calls: RecordedCalls): GameImports {
  const trace: GTraceT = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };

  return {
    bprintf: (printlevel: number, fmt: string) => {
      calls.bprintf.push([printlevel, fmt]);
    },
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string) => {
      throw new Error(fmt);
    },
    modelindex: () => 0,
    soundindex: () => 0,
    imageindex: () => 0,
    setmodel: () => {},
    trace: () => trace,
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
    cvar: () => fakeCvar(0),
    cvar_set: () => fakeCvar(0),
    cvar_forceset: () => fakeCvar(0),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: (text: string) => {
      calls.AddCommandString.push(text);
    },
    DebugGraph: () => {},
  };
}

function resetGameCvars(): void {
  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
}

describe("GetGameAPI", () => {
  test("returns exports with apiversion GAME_API_VERSION and sets gi afterward", () => {
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    const imports = buildFakeImports(calls);

    const exports = GetGameAPI(imports);

    expect(exports.apiversion).toBe(GAME_API_VERSION);
    expect(exports.num_edicts).toBe(0);
    expect(exports.max_edicts).toBe(0);
    expect(exports.edicts).toEqual([]);

    // gi is set afterward (g_local.ts's bare `export let gi`, live-bound)
    expect(gi).toBe(imports);
    expect(globals).toBe(exports);
  });
});

describe("G_RunFrame", () => {
  test("advances level.framenum/level.time and completes a full frame now that g_ai.c has landed", () => {
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));
    resetGameCvars();
    game.clear(); // maxclients=0, so AI_SetSightClient's client scan is a no-op
    level.clear();

    const edicts = [new EdictT(), new EdictT(), new EdictT()];
    for (const e of edicts) e.inuse = false;
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    const beforeFrame = level.framenum;

    // AI_SetSightClient (g_ai.c) used to be an unconditional PendingPort
    // stub, blocking G_RunFrame before it reached the entity loop. Now that
    // g_ai.c is a real port, G_RunFrame runs end-to-end over this fabricated
    // (all non-inuse) world without throwing.
    expect(() => G_RunFrame()).not.toThrow();

    expect(level.framenum).toBe(beforeFrame + 1);
    expect(level.time).toBeCloseTo((beforeFrame + 1) * FRAMETIME);
    expect(level.sight_client).toBeNull(); // no clients exist to pick (maxclients=0)
  });
});

describe("CheckDMRules", () => {
  test("returns immediately when an intermission is already running (no cvars needed)", () => {
    level.clear();
    level.intermissiontime = 12345;
    expect(() => CheckDMRules()).not.toThrow();
  });

  test("returns immediately when deathmatch is off", () => {
    resetGameCvars();
    level.clear();
    gameCvars.deathmatch = fakeCvar(0);
    expect(() => CheckDMRules()).not.toThrow();
  });

  test("fraglimit set but no client over the limit does not end the level", () => {
    resetGameCvars();
    level.clear();
    gameCvars.deathmatch = fakeCvar(1);
    gameCvars.timelimit = fakeCvar(0);
    gameCvars.fraglimit = fakeCvar(10);
    gameCvars.maxclients = fakeCvar(2);

    game.clients = [new GClientT(), new GClientT()];
    game.clients[0].resp.score = 3;
    game.clients[1].resp.score = 4;

    const edicts = [new EdictT(), new EdictT(), new EdictT()];
    edicts[1].inuse = true;
    edicts[2].inuse = true;
    SetGEdicts(edicts);

    expect(() => CheckDMRules()).not.toThrow();
  });

  test("timelimit hit calls gi.bprintf and runs EndDMLevel through BeginIntermission", () => {
    resetGameCvars();
    level.clear();
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));

    gameCvars.deathmatch = fakeCvar(1);
    gameCvars.timelimit = fakeCvar(1); // 1 minute
    level.time = 61; // >= 1*60
    level.mapname = "base1";
    const spot = new EdictT();
    spot.inuse = true;
    spot.classname = "info_player_intermission";
    const edicts = [new EdictT(), new EdictT(), spot];
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    expect(() => CheckDMRules()).not.toThrow();
    expect(calls.bprintf).toEqual([[2, "Timelimit hit.\n"]]);
    expect(level.intermissiontime).toBe(61);
  });

  test("fraglimit hit calls gi.bprintf and runs EndDMLevel through BeginIntermission", () => {
    resetGameCvars();
    level.clear();
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));

    gameCvars.deathmatch = fakeCvar(1);
    gameCvars.timelimit = fakeCvar(0);
    gameCvars.fraglimit = fakeCvar(5);
    gameCvars.maxclients = fakeCvar(1);
    level.mapname = "base1";

    game.clients = [new GClientT()];
    game.clients[0].resp.score = 5;
    level.time = 5;

    // world, the one player slot (inuse), a free slot for G_Spawn, and an
    // intermission spot for BeginIntermission.
    const spot = new EdictT();
    spot.inuse = true;
    spot.classname = "info_player_intermission";
    const edicts = [new EdictT(), new EdictT(), new EdictT(), spot];
    edicts[1].inuse = true;
    edicts[1].client = new GClientT();
    // BeginIntermission respawns dead clients first (C behavior); keep the
    // fabricated player alive so the test stays on the intermission path.
    edicts[1].health = 1;
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    expect(() => CheckDMRules()).not.toThrow();
    expect(calls.bprintf).toEqual([[2, "Fraglimit hit.\n"]]);
    expect(level.intermissiontime).toBe(5);
  });
});

describe("EndDMLevel", () => {
  test("DF_SAME_LEVEL branch spawns the changelevel target and begins intermission", () => {
    resetGameCvars();
    level.clear();
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));

    gameCvars.dmflags = fakeCvar(DF_SAME_LEVEL);
    level.mapname = "base1";
    level.time = 3;
    const spot = new EdictT();
    spot.inuse = true;
    spot.classname = "info_player_intermission";
    const edicts = [new EdictT(), new EdictT(), spot];
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    expect(() => EndDMLevel()).not.toThrow();
    expect(edicts[1].classname).toBe("target_changelevel");
    expect(level.nextmap).toBe(level.mapname);
    expect(level.intermissiontime).toBe(3);
  });

  test("finds an existing target_changelevel edict via G_Find and hands it to BeginIntermission", () => {
    resetGameCvars();
    level.clear();
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));

    level.mapname = "base1";
    level.time = 7;
    const changelevelEnt = new EdictT();
    changelevelEnt.inuse = true;
    changelevelEnt.classname = "target_changelevel";
    changelevelEnt.map = "base2";
    const spot = new EdictT();
    spot.inuse = true;
    spot.classname = "info_player_intermission";
    const edicts = [new EdictT(), changelevelEnt, spot];
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    expect(() => EndDMLevel()).not.toThrow();
    expect(level.intermissiontime).toBe(7);
    expect(level.changemap).toBe("base2");
  });
});

describe("CreateTargetChangeLevel", () => {
  test("spawns a target_changelevel edict and points it at the given map (G_Spawn, g_utils.c, already ported)", () => {
    resetGameCvars();
    level.clear();
    const edicts = [new EdictT(), new EdictT()];
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    const ent = CreateTargetChangeLevel("base3");

    expect(ent).toBe(edicts[1]);
    expect(ent.classname).toBe("target_changelevel");
    expect(level.nextmap).toBe("base3");
    expect(ent.map).toBe("base3");
  });
});

describe("ClientEndServerFrames", () => {
  test("skips edicts that are not in use or have no client, without throwing", () => {
    resetGameCvars();
    gameCvars.maxclients = fakeCvar(2);
    const world = new EdictT();
    const notInUse = new EdictT();
    const noClient = new EdictT();
    noClient.inuse = true;
    noClient.client = null;
    SetGEdicts([world, notInUse, noClient]);

    expect(() => ClientEndServerFrames()).not.toThrow();
  });

  test("runs ClientEndServerFrame for an active client edict", () => {
    resetGameCvars();
    gameCvars.maxclients = fakeCvar(1);
    const world = new EdictT();
    const player = new EdictT();
    player.inuse = true;
    player.client = new GClientT();
    SetGEdicts([world, player]);

    expect(() => ClientEndServerFrames()).not.toThrow();
  });
});

describe("ExitLevel", () => {
  test("issues the gamemap command and resets intermission state when no client needs end-of-frame work", () => {
    resetGameCvars();
    level.clear();
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));

    // maxclients 0 means ClientEndServerFrames's loop (and ExitLevel's own
    // health-clamp loop) never iterates, so nothing here depends on the
    // still-pending ClientEndServerFrame stub.
    gameCvars.maxclients = fakeCvar(0);
    level.changemap = "base2";
    level.exitintermission = 1;
    level.intermissiontime = 999;
    SetGEdicts([new EdictT()]);

    expect(() => ExitLevel()).not.toThrow();

    expect(calls.AddCommandString).toEqual(['gamemap "base2"\n']);
    expect(level.changemap).toBeNull();
    expect(level.exitintermission).toBe(0);
    expect(level.intermissiontime).toBe(0);
  });

  test("health-clamp loop clamps player health to max after ClientEndServerFrame runs", () => {
    resetGameCvars();
    level.clear();
    const calls: RecordedCalls = { bprintf: [], AddCommandString: [] };
    GetGameAPI(buildFakeImports(calls));

    gameCvars.maxclients = fakeCvar(1);
    level.changemap = "base2";
    level.exitintermission = 1;
    level.intermissiontime = 999;

    const world = new EdictT();
    const player = new EdictT();
    player.inuse = true;
    player.client = new GClientT();
    player.client.pers.max_health = 100;
    player.health = 150;
    SetGEdicts([world, player]);

    expect(() => ExitLevel()).not.toThrow();
    expect(calls.AddCommandString).toEqual(['gamemap "base2"\n']);
    expect(level.changemap).toBeNull();
    expect(level.exitintermission).toBe(0);
    expect(level.intermissiontime).toBe(0);
    expect(player.health).toBe(100); // clamp loop ran
  });
});
