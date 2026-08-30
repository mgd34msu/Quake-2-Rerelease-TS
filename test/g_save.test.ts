import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  EdictT,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
  SetGEdicts,
} from "../src/game/g_local";
import {
  deserializeClientPersistant,
  deserializeGame,
  InitGame,
  ReadGame,
  ReadLevel,
  registerSaveFunction,
  serializeClientPersistant,
  serializeGame,
  WriteGame,
  WriteLevel,
} from "../src/game/g_save";
import { func_train_find } from "../src/game/g_func";
import { vec3 } from "../src/shared/math";

interface Recorder {
  dprintf: string[];
  cvar: Array<{ name: string; value: string | null; flags: number }>;
  error: string[];
}

function makeRecorder(): Recorder {
  return { dprintf: [], cvar: [], error: [] };
}

function buildFakeImports(rec: Recorder): GameImports {
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

  // Each gi.cvar() call gets its own live CvarT so InitGame's registrations
  // and this test's later cvar overrides don't fight over one shared
  // instance -- matches the real gi.cvar()'s per-name cvar_t contract.
  const cvars = new Map<string, CvarT>();
  function cvar(name: string, value: string | null, _flags: number): CvarT {
    let c = cvars.get(name);
    if (!c) {
      c = new CvarT();
      c.string = value ?? "";
      c.value = Number.parseFloat(c.string) || 0;
      cvars.set(name, c);
    }
    return c;
  }

  return {
    bprintf: () => {},
    dprintf: (fmt: string) => {
      rec.dprintf.push(fmt);
    },
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      rec.error.push(fmt);
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
    cvar,
    cvar_set: (var_name: string, value: string) => cvar(var_name, value, 0),
    cvar_forceset: (var_name: string, value: string) => cvar(var_name, value, 0),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

function tmpPath(name: string): string {
  return join(tmpdir(), `q2ts-g_save-test-${process.pid}-${name}.json`);
}

// ---------------------------------------------------------------------------

describe("InitGame", () => {
  test("registers cvars and allocates g_edicts/game.clients sized by maxclients/maxentities", () => {
    const rec = makeRecorder();
    const imports = buildFakeImports(rec);
    GetGameAPI(imports);

    // Force maxentities/maxclients to specific values before InitGame reads
    // them, the same way a real dedicated server's config would.
    imports.cvar("maxentities", "32", 0);
    imports.cvar("maxclients", "3", 0);

    InitGame();

    expect(rec.dprintf).toContain("==== InitGame ====\n");
    expect(gameCvars.maxentities).not.toBeNull();
    expect(gameCvars.maxclients).not.toBeNull();
    expect(gameCvars.deathmatch).not.toBeNull();
    expect(gameCvars.skill).not.toBeNull();
    expect(gameCvars.sv_gravity).not.toBeNull();

    expect(g_edicts.length).toBe(32);
    expect(g_edicts[5]?.s.number).toBe(5);
    expect(game.clients.length).toBe(3);
    expect(globals.edicts).toBe(g_edicts);
    expect(globals.max_edicts).toBe(32);
    expect(globals.num_edicts).toBe(4);
  });
});

describe("WriteLevel / ReadLevel", () => {
  test("round-trips level locals and inuse edicts, including a registered think function", () => {
    const rec = makeRecorder();
    GetGameAPI(buildFakeImports(rec));

    const edicts: EdictT[] = Array.from({ length: 16 }, (_unused, i) => {
      const e = new EdictT();
      e.s.number = i;
      return e;
    });
    SetGEdicts(edicts);
    globals.num_edicts = 16;

    game.clear();
    level.clear();
    level.mapname = "q2dm1";
    level.time = 12.3;
    level.framenum = 123;

    registerSaveFunction("func_train_find", func_train_find);

    const world = g_edicts[0];
    world.inuse = true;
    world.classname = "worldspawn";
    world.s.origin[0] = 1;
    world.s.origin[1] = 2;
    world.s.origin[2] = 3;

    const e1 = g_edicts[1];
    e1.inuse = true;
    e1.classname = "func_train";
    e1.s.origin[0] = 10;
    e1.s.origin[1] = 20;
    e1.s.origin[2] = 30;
    e1.health = 50;
    e1.think = func_train_find;
    e1.owner = world;

    const e2 = g_edicts[2];
    e2.inuse = false; // must NOT be written out
    e2.classname = "should_not_appear";

    const path = tmpPath("level");
    WriteLevel(path);

    // wipe everything so ReadLevel has to actually restore it, not just
    // observe values that were already there
    for (const e of g_edicts) e.clear();
    level.clear();
    globals.num_edicts = 1;

    ReadLevel(path);

    expect(level.mapname).toBe("q2dm1");
    expect(level.time).toBeCloseTo(12.3);
    expect(level.framenum).toBe(123);

    const restoredWorld = g_edicts[0];
    expect(restoredWorld.inuse).toBe(true);
    expect(restoredWorld.classname).toBe("worldspawn");
    expect(Array.from(restoredWorld.s.origin)).toEqual([1, 2, 3]);

    const restored1 = g_edicts[1];
    expect(restored1.inuse).toBe(true);
    expect(restored1.classname).toBe("func_train");
    expect(Array.from(restored1.s.origin)).toEqual([10, 20, 30]);
    expect(restored1.health).toBe(50);
    // function identity is restored via the name registry, not by reference
    // equality with the original closure -- calling it must dispatch to the
    // real registered function.
    expect(restored1.think).not.toBeNull();
    expect(() => restored1.think?.(restored1)).not.toThrow();
    expect(restored1.owner).toBe(restoredWorld);

    const restored2 = g_edicts[2];
    expect(restored2.inuse).toBe(false);
    expect(restored2.classname).toBeNull();
  });
});

describe("WriteGame / ReadGame", () => {
  test("round-trips per-client persistent inventory", () => {
    const rec = makeRecorder();
    GetGameAPI(buildFakeImports(rec));

    game.clear();
    game.maxclients = 2;
    game.helpmessage1 = "hi";
    game.spawnpoint = "start";

    const client0Pers = serializeClientPersistant(deserializeClientPersistant({
      userinfo: "",
      netname: "Player1",
      hand: 0,
      connected: true,
      health: 100,
      max_health: 100,
      savedFlags: 0,
      selected_item: 1,
      inventory: [3, 0, 5, 0, 0, 0],
      max_bullets: 200,
      max_shells: 100,
      max_rockets: 50,
      max_grenades: 50,
      max_cells: 200,
      max_slugs: 50,
      weapon: null,
      lastweapon: null,
      power_cubes: 0,
      score: 7,
      game_helpchanged: 0,
      helpchanged: 0,
      spectator: false,
    }));
    expect(client0Pers.netname).toBe("Player1");
    expect(client0Pers.inventory.slice(0, 6)).toEqual([3, 0, 5, 0, 0, 0]);

    // Build game.clients directly against the real GClientT shape via
    // deserializeGame, exercising the same path ReadGame uses.
    deserializeGame({
      stamp: "quake-2-ts:g_save:v1",
      autosaved: false,
      helpmessage1: "hi",
      helpmessage2: "",
      helpchanged: 0,
      spawnpoint: "start",
      maxclients: 2,
      maxentities: 16,
      serverflags: 0,
      num_items: 0,
      clients: [
        {
          userinfo: "",
          netname: "Player1",
          hand: 0,
          connected: true,
          health: 100,
          max_health: 100,
          savedFlags: 0,
          selected_item: 1,
          inventory: [3, 0, 5, 0, 0, 0],
          max_bullets: 200,
          max_shells: 100,
          max_rockets: 50,
          max_grenades: 50,
          max_cells: 200,
          max_slugs: 50,
          weapon: null,
          lastweapon: null,
          power_cubes: 0,
          score: 7,
          game_helpchanged: 0,
          helpchanged: 0,
          spectator: false,
        },
        {
          userinfo: "",
          netname: "Player2",
          hand: 1,
          connected: false,
          health: 75,
          max_health: 100,
          savedFlags: 0,
          selected_item: 0,
          inventory: [0, 1, 0, 0, 0, 0],
          max_bullets: 200,
          max_shells: 100,
          max_rockets: 50,
          max_grenades: 50,
          max_cells: 200,
          max_slugs: 50,
          weapon: null,
          lastweapon: null,
          power_cubes: 0,
          score: 2,
          game_helpchanged: 0,
          helpchanged: 0,
          spectator: false,
        },
      ],
    });

    expect(game.clients).toHaveLength(2);
    expect(game.clients[0]?.pers.netname).toBe("Player1");
    expect(game.clients[0]?.pers.inventory[0]).toBe(3);
    expect(game.clients[0]?.pers.inventory[2]).toBe(5);
    expect(game.clients[1]?.pers.netname).toBe("Player2");
    expect(game.clients[1]?.pers.score).toBe(2);

    // full file round-trip through WriteGame/ReadGame
    game.maxentities = 16;
    const edicts: EdictT[] = Array.from({ length: 16 }, (_unused, i) => {
      const e = new EdictT();
      e.s.number = i;
      return e;
    });
    SetGEdicts(edicts);
    globals.edicts = g_edicts;

    const path = tmpPath("game");
    WriteGame(path, true);

    game.clients = [];
    game.helpmessage1 = "";
    game.spawnpoint = "";

    ReadGame(path);

    expect(game.helpmessage1).toBe("hi");
    expect(game.spawnpoint).toBe("start");
    expect(game.clients).toHaveLength(2);
    expect(game.clients[0]?.pers.netname).toBe("Player1");
    expect(game.clients[0]?.pers.inventory[0]).toBe(3);
    expect(game.clients[0]?.pers.inventory[2]).toBe(5);
    expect(game.clients[1]?.pers.netname).toBe("Player2");
  });
});

describe("registerSaveFunction", () => {
  test("a function not in the registry serializes/deserializes as null instead of throwing", () => {
    const rec = makeRecorder();
    GetGameAPI(buildFakeImports(rec));

    const edicts: EdictT[] = Array.from({ length: 4 }, (_unused, i) => {
      const e = new EdictT();
      e.s.number = i;
      return e;
    });
    SetGEdicts(edicts);
    globals.num_edicts = 4;
    level.clear();

    const ent = g_edicts[1];
    ent.inuse = true;
    ent.classname = "unregistered_think_holder";
    ent.think = (_self: EdictT) => {
      /* never registered under any name */
    };

    const path = tmpPath("unregistered-fn");
    expect(() => WriteLevel(path)).not.toThrow();

    for (const e of g_edicts) e.clear();
    globals.num_edicts = 1;
    ReadLevel(path);

    expect(g_edicts[1]?.think).toBeNull();
  });
});
