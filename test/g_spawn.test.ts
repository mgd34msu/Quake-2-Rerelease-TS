import { describe, expect, test } from "bun:test";
import type { ComParseState } from "../src/shared/math";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  EdictT,
  FL_TEAMSLAVE,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
  MovetypeT,
  SetGEdicts,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_EASY,
  st,
} from "../src/game/g_local";
import { SolidT } from "../src/game/game";
import {
  ED_CallSpawn,
  ED_NewString,
  ED_ParseEdict,
  G_FindTeams,
  SpawnEntities,
} from "../src/game/g_spawn";
import { InitItems } from "../src/game/g_items";

const MAXENTITIES = 64;
const MAXCLIENTS = 1;

interface Recorder {
  dprintf: string[];
  configstring: Array<{ num: number; str: string }>;
  modelindex: string[];
  soundindex: string[];
  imageindex: string[];
  cvar_set: Array<{ name: string; value: string }>;
  cvar_forceset: Array<{ name: string; value: string }>;
  error: string[];
}

function makeRecorder(): Recorder {
  return {
    dprintf: [],
    configstring: [],
    modelindex: [],
    soundindex: [],
    imageindex: [],
    cvar_set: [],
    cvar_forceset: [],
    error: [],
  };
}

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
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

  return {
    bprintf: () => {},
    dprintf: (fmt: string) => {
      rec.dprintf.push(fmt);
    },
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: (num: number, str: string) => {
      rec.configstring.push({ num, str });
    },
    error: (fmt: string): never => {
      rec.error.push(fmt);
      throw new Error(fmt);
    },
    modelindex: (name: string) => {
      rec.modelindex.push(name);
      return rec.modelindex.length;
    },
    soundindex: (name: string) => {
      rec.soundindex.push(name);
      return rec.soundindex.length;
    },
    imageindex: (name: string) => {
      rec.imageindex.push(name);
      return rec.imageindex.length;
    },
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
    cvar_set: (var_name: string, value: string) => {
      rec.cvar_set.push({ name: var_name, value });
      return fakeCvar(0, value);
    },
    cvar_forceset: (var_name: string, value: string) => {
      rec.cvar_forceset.push({ name: var_name, value });
      return fakeCvar(0, value);
    },
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

function resetGameCvars(): void {
  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
}

function setupWorld(rec: Recorder): void {
  GetGameAPI(buildFakeImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.num_items = 0; // ED_CallSpawn's item loop is skipped entirely (see g_spawn.ts comment)

  level.clear();
  st.clear();

  resetGameCvars();
  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.coop = fakeCvar(0);

  globals.num_edicts = MAXCLIENTS + 1;
}

// ---------------------------------------------------------------------------

describe("ED_NewString", () => {
  test("collapses \\n to a real newline and any other backslash escape to a bare backslash", () => {
    expect(ED_NewString("line1\\nline2")).toBe("line1\nline2");
    expect(ED_NewString("a\\tb")).toBe("a\\b"); // only \n is recognized; \t drops the 't'
    expect(ED_NewString("plain text")).toBe("plain text");
    expect(ED_NewString("trailing\\")).toBe("trailing\\"); // lone trailing backslash: no lookahead past end
  });
});

describe("ED_ParseEdict", () => {
  test("sets origin (F_VECTOR), the angle hack (F_ANGLEHACK -> s.angles[1]), ignores light (F_IGNORE), and routes spawntemp keys to st", () => {
    const rec = makeRecorder();
    setupWorld(rec);

    const raw =
      '"classname" "info_player_start" "origin" "10 20 30" "angle" "90" "light" "5" "sky" "unit1_" "lip" "8" }';
    const state: ComParseState = { data: raw, index: 0 };
    const ent = new EdictT();

    ED_ParseEdict(state, ent);

    expect(ent.classname).toBe("info_player_start");
    expect(Array.from(ent.s.origin)).toEqual([10, 20, 30]);
    // F_ANGLEHACK: angles[0]=0, angles[1]=yaw, angles[2]=0
    expect(Array.from(ent.s.angles)).toEqual([0, 90, 0]);
    // "light" is F_IGNORE: no property to check, but it must not raise
    // "is not a field" and must not throw.
    expect(rec.dprintf.some((m) => m.includes("light"))).toBe(false);
    // spawntemp key lands on the shared `st` global, not on the edict.
    expect(st.sky).toBe("unit1_");
    expect(st.lip).toBe(8);
  });

  test("an unknown key is reported via gi.dprintf and does not throw", () => {
    const rec = makeRecorder();
    setupWorld(rec);

    const raw = '"classname" "worldspawn" "totally_bogus_key" "1" }';
    const state: ComParseState = { data: raw, index: 0 };
    const ent = new EdictT();

    ED_ParseEdict(state, ent);

    expect(rec.dprintf).toContain("totally_bogus_key is not a field\n");
  });
});

describe("ED_CallSpawn", () => {
  test("a classname with no spawns[] entry is reported via dprintf and is NOT freed (bug-for-bug: this v3.19 source has no G_FreeEdict fallback here, only the spawnflags-inhibit path in SpawnEntities does that)", () => {
    const rec = makeRecorder();
    setupWorld(rec);

    const ent = new EdictT();
    ent.inuse = true;
    ent.classname = "totally_unknown_classname_xyz";

    ED_CallSpawn(ent);

    expect(rec.dprintf).toContain("totally_unknown_classname_xyz doesn't have a spawn function\n");
    expect(ent.inuse).toBe(true);
  });

  test("a classname resolved via spawns[] runs its real SP_ function", () => {
    const rec = makeRecorder();
    setupWorld(rec);

    const ent = new EdictT();
    ent.inuse = true;
    ent.classname = "info_player_start";

    expect(() => ED_CallSpawn(ent)).not.toThrow();
  });
});

describe("G_FindTeams", () => {
  test("chains matching-team edicts, sets teammaster/teamchain, and flags all but the first FL_TEAMSLAVE", () => {
    const rec = makeRecorder();
    setupWorld(rec);

    // g_edicts[0] is the world (no team). 1,2,3 share "red"; 4 has no team;
    // 5 shares "red" too but is already FL_TEAMSLAVE (must stay excluded
    // from becoming a new chain head); 6 is not inuse (excluded).
    const e1 = g_edicts[1];
    const e2 = g_edicts[2];
    const e3 = g_edicts[3];
    const e4 = g_edicts[4];
    const e5 = g_edicts[5];
    const e6 = g_edicts[6];
    for (const e of [e1, e2, e3, e4, e5, e6]) e.inuse = true;
    e1.team = "red";
    e2.team = "red";
    e3.team = "red";
    e4.team = null;
    e5.team = "red";
    e5.flags |= FL_TEAMSLAVE;
    e6.team = "red";
    e6.inuse = false;

    globals.num_edicts = 7;

    G_FindTeams();

    expect(e1.teammaster).toBe(e1);
    expect(e1.teamchain).toBe(e2);
    expect(e2.teammaster).toBe(e1);
    expect(e2.teamchain).toBe(e3);
    expect(e3.teammaster).toBe(e1);
    expect((e2.flags & FL_TEAMSLAVE) !== 0).toBe(true);
    expect((e3.flags & FL_TEAMSLAVE) !== 0).toBe(true);
    // e5 was already FL_TEAMSLAVE and must not be re-chained under e1
    expect(e5.teammaster).not.toBe(e1);

    expect(rec.dprintf).toContain("1 teams with 3 entities\n");
  });
});

describe("SpawnEntities", () => {
  test("clamps an out-of-range skill cvar via gi.cvar_forceset", () => {
    const rec = makeRecorder();
    setupWorld(rec);
    InitItems(); // InitGame's job in C (g_save.c); SP_worldspawn precaches items
    gameCvars.skill = fakeCvar(7.8);

    expect(() => SpawnEntities("q2dm1", '{ "classname" "worldspawn" }', "")).not.toThrow();
    expect(rec.cvar_forceset).toHaveLength(1);
    expect(rec.cvar_forceset[0]?.name).toBe("skill");
    expect(Number.parseFloat(rec.cvar_forceset[0]?.value ?? "")).toBeCloseTo(3);
  });

  test("parses the world entity end-to-end: worldspawn spawns, body queue inits, fields set", () => {
    const rec = makeRecorder();
    setupWorld(rec);
    InitItems();

    const entities = '{ "classname" "worldspawn" "message" "Base 1" } { "classname" "info_player_start" }';

    expect(() => SpawnEntities("q2dm1", entities, "start")).not.toThrow();

    const world = g_edicts[0];
    expect(world.inuse).toBe(true);
    expect(world.movetype).toBe(MovetypeT.MOVETYPE_PUSH);
    expect(world.solid).toBe(SolidT.SOLID_BSP);
    expect(world.s.modelindex).toBe(1);

    // level.mapname/game.spawnpoint are set unconditionally before the
    // parse loop even starts.
    expect(level.mapname).toBe("q2dm1");
    expect(game.spawnpoint).toBe("start");
  });
});
