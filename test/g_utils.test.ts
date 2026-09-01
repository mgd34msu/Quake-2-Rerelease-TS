import { describe, expect, test } from "bun:test";
import type { Edict, GameExports, GTraceT } from "../src/game/game";
import { GAME_API_VERSION, SolidT, SVF_MONSTER } from "../src/game/game";
import {
  BODY_QUEUE_SIZE,
  EdictT,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  MOD_TELEFRAG,
  SetGameExports,
  SetGameImports,
  SetGEdicts,
} from "../src/game/g_local";
import type { GameImports } from "../src/game/game";
import {
  findradius,
  G_CopyString,
  G_Find,
  G_FreeEdict,
  G_InitEdict,
  G_PickTarget,
  G_ProjectSource,
  G_SetMovedir,
  G_Spawn,
  G_TouchTriggers,
  G_UseTargets,
  KillBox,
  Think_Delay,
  tv,
  vectoangles,
  vectoyaw,
  vtos,
} from "../src/game/g_utils";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports: records calls, BoxEdicts returns empty, trace defaults
// to fraction 1 / no hit, unlinkentity/linkentity no-op (but recorded).
// ---------------------------------------------------------------------------

interface Recorder {
  dprintf: string[];
  centerprintf: Array<{ ent: Edict; fmt: string }>;
  sound: Array<{ ent: Edict; channel: number; soundindex: number }>;
  unlinkentity: Edict[];
  linkentity: Edict[];
  boxEdicts: number;
  trace: number;
  error: string[];
}

function makeRecorder(): Recorder {
  return {
    dprintf: [],
    centerprintf: [],
    sound: [],
    unlinkentity: [],
    linkentity: [],
    boxEdicts: 0,
    trace: 0,
    error: [],
  };
}

// mutable so individual tests can script a hit; reset by setupWorld()
let traceResult: GTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 1,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: 0,
  ent: null,
};

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf(fmt) {
      rec.dprintf.push(fmt);
    },
    cprintf() {},
    centerprintf(ent, fmt) {
      rec.centerprintf.push({ ent, fmt });
    },
    sound(ent, channel, soundindex) {
      rec.sound.push({ ent, channel, soundindex });
    },
    positioned_sound() {},
    configstring() {},
    error(fmt): never {
      rec.error.push(fmt);
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 0;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      rec.trace++;
      return traceResult;
    },
    pointcontents() {
      return 0;
    },
    inPVS() {
      return false;
    },
    inPHS() {
      return false;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return false;
    },
    linkentity(ent) {
      rec.linkentity.push(ent);
    },
    unlinkentity(ent) {
      rec.unlinkentity.push(ent);
    },
    BoxEdicts() {
      rec.boxEdicts++;
      return 0; // "BoxEdicts returns empty" per brief
    },
    Pmove() {},
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte() {},
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString() {},
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    cvar() {
      return null;
    },
    cvar_set() {
      return null;
    },
    cvar_forceset() {
      return null;
    },
    argc() {
      return 0;
    },
    argv() {
      return "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
  };
}

function makeFakeGameExports(edicts: EdictT[], numEdicts: number): GameExports {
  return {
    apiversion: GAME_API_VERSION,
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
    edicts,
    num_edicts: numEdicts,
    max_edicts: edicts.length,
  };
}

// fabricated array of default EdictT instances: maxclients=1, maxentities=32
const MAXCLIENTS = 1;
const MAXENTITIES = 32;

function setupWorld(): Recorder {
  const rec = makeRecorder();
  SetGameImports(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;

  level.clear();

  const maxclientsCvar = new CvarT();
  maxclientsCvar.value = MAXCLIENTS;
  gameCvars.maxclients = maxclientsCvar;

  SetGameExports(makeFakeGameExports(edicts, MAXCLIENTS + 1));

  traceResult = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };

  return rec;
}

// ---------------------------------------------------------------------------

describe("G_Spawn", () => {
  test("returns the first free slot past maxclients and initializes it", () => {
    setupWorld();
    const e = G_Spawn();
    expect(e).toBe(g_edicts[MAXCLIENTS + 1]);
    expect(e.inuse).toBe(true);
    expect(e.classname).toBe("noclass");
    expect(e.gravity).toBe(1);
    expect(e.s.number).toBe(MAXCLIENTS + 1);
    expect(globals.num_edicts).toBe(MAXCLIENTS + 2);
  });

  test("reuses a freed slot once it is past the level.time+0.5 relax window", () => {
    setupWorld();
    globals.num_edicts = 10;
    // occupy every slot ahead of the target so the scan has to pass them
    for (let i = MAXCLIENTS + 1; i < 5; i++) g_edicts[i].inuse = true;
    const stale = g_edicts[5];
    stale.inuse = false;
    stale.freetime = 2.5; // >= 2, so the freetime+0.5 rule applies
    level.time = 10; // 10 - 2.5 = 7.5 > 0.5

    const e = G_Spawn();
    expect(e).toBe(stale);
    expect(e.inuse).toBe(true);
  });

  test("skips a slot freed too recently (within the 0.5s relax window)", () => {
    setupWorld();
    globals.num_edicts = 10;
    for (let i = MAXCLIENTS + 1; i < 5; i++) g_edicts[i].inuse = true;
    const recentlyFreed = g_edicts[5];
    recentlyFreed.inuse = false;
    recentlyFreed.freetime = 9.8;
    level.time = 10; // 10 - 9.8 = 0.2, not > 0.5

    const e = G_Spawn();
    expect(e).not.toBe(recentlyFreed);
  });
});

describe("G_FreeEdict", () => {
  test("marks free, sets freetime, and unlinks", () => {
    const rec = setupWorld();
    const target = g_edicts[15];
    target.inuse = true;
    target.classname = "monster_soldier";
    level.time = 12.25;

    G_FreeEdict(target);

    expect(target.inuse).toBe(false);
    expect(target.classname).toBe("freed");
    expect(target.freetime).toBe(12.25);
    expect(rec.unlinkentity).toContain(target);
  });

  test("refuses to actually free a special edict (clients + BODY_QUEUE_SIZE range)", () => {
    const rec = setupWorld();
    const special = g_edicts[MAXCLIENTS + BODY_QUEUE_SIZE]; // index <= maxclients + BODY_QUEUE_SIZE
    special.inuse = true;
    special.classname = "player";

    G_FreeEdict(special);

    expect(special.inuse).toBe(true);
    expect(special.classname).toBe("player");
    expect(rec.unlinkentity).toContain(special); // gi.unlinkentity still runs first
  });
});

describe("G_Find", () => {
  test("finds a planted edict by targetname and skips non-inuse ones", () => {
    setupWorld();
    globals.num_edicts = MAXENTITIES;
    g_edicts[5].inuse = false;
    g_edicts[5].targetname = "door1";
    g_edicts[6].inuse = true;
    g_edicts[6].targetname = "door1";

    const found = G_Find(null, "targetname", "door1");
    expect(found).toBe(g_edicts[6]);
  });

  test("resumes the search after `from` by array position, not by content", () => {
    setupWorld();
    globals.num_edicts = MAXENTITIES;
    g_edicts[10].inuse = true;
    g_edicts[10].targetname = "switch1";

    // searching after g_edicts[10] itself should not find it again
    const found = G_Find(g_edicts[10], "targetname", "switch1");
    expect(found).toBeNull();
  });

  test("returns null when nothing matches", () => {
    setupWorld();
    globals.num_edicts = MAXENTITIES;
    expect(G_Find(null, "targetname", "nope")).toBeNull();
  });
});

describe("findradius", () => {
  test("finds an entity within the sphere and skips SOLID_NOT / far entities", () => {
    setupWorld();
    globals.num_edicts = MAXENTITIES;

    const far = g_edicts[4];
    far.inuse = true;
    far.solid = SolidT.SOLID_BBOX;
    far.s.origin[0] = 1000;

    const near = g_edicts[5];
    near.inuse = true;
    near.solid = SolidT.SOLID_BBOX;
    near.s.origin.set([10, 0, 0]);

    const found = findradius(null, vec3(0, 0, 0), 50);
    expect(found).toBe(near);
  });
});

describe("G_PickTarget", () => {
  test("returns one of the matching edicts (seed-independent)", () => {
    setupWorld();
    globals.num_edicts = MAXENTITIES;
    const matches = [g_edicts[3], g_edicts[4], g_edicts[5]];
    for (const m of matches) {
      m.inuse = true;
      m.targetname = "grp";
    }

    const picked = G_PickTarget("grp");
    expect(picked).not.toBeNull();
    if (picked !== null) {
      expect(matches).toContain(picked);
    }
  });

  test("returns null and logs when nothing matches", () => {
    const rec = setupWorld();
    globals.num_edicts = MAXENTITIES;
    expect(G_PickTarget("nope")).toBeNull();
    expect(rec.dprintf.some((m) => m.includes("not found"))).toBe(true);
  });

  test("handles a null targetname (a real call-site input via EdictT.target)", () => {
    const rec = setupWorld();
    expect(G_PickTarget(null)).toBeNull();
    expect(rec.dprintf.some((m) => m.includes("NULL targetname"))).toBe(true);
  });
});

describe("G_UseTargets / Think_Delay", () => {
  test("spawns a DelayedUse edict when ent.delay is set", () => {
    setupWorld();
    // ent itself occupies g_edicts[MAXCLIENTS+1]; bump num_edicts past it so
    // G_Spawn's scan doesn't alias `t` back onto `ent`.
    globals.num_edicts = MAXCLIENTS + 2;
    const ent = g_edicts[MAXCLIENTS + 1];
    ent.inuse = true;
    ent.delay = 5;
    ent.message = "hi";
    ent.target = "t1";
    ent.killtarget = "k1";
    level.time = 100;
    const activator = g_edicts[1];

    G_UseTargets(ent, activator);

    const spawned = g_edicts[MAXCLIENTS + 2];
    expect(spawned.classname).toBe("DelayedUse");
    expect(spawned.nextthink).toBe(105);
    expect(spawned.think).toBe(Think_Delay);
    expect(spawned.activator).toBe(activator);
    expect(spawned.message).toBe("hi");
    expect(spawned.target).toBe("t1");
    expect(spawned.killtarget).toBe("k1");
  });

  test("prints the message, fires killtargets, and fires targets", () => {
    const rec = setupWorld();
    globals.num_edicts = MAXENTITIES;

    const ent = g_edicts[2];
    ent.inuse = true;
    ent.message = "boom";
    ent.killtarget = "kill1";
    ent.target = "use1";

    const activator = g_edicts[1];
    activator.inuse = true;
    activator.svflags = 0;

    const killVictim = g_edicts[15]; // outside the special client/BODY_QUEUE range
    killVictim.inuse = true;
    killVictim.targetname = "kill1";

    // a holder object, not a bare `let`: TS narrows a `let` reassigned only
    // inside a not-immediately-invoked closure to its last direct
    // assignment (`null`) at read sites in the outer scope, which would
    // make `expect(usedWith)` below type as `Expect<null>`. A property on
    // an object isn't narrowed that way.
    const usedWith: { value: EdictT | null } = { value: null };
    const useTarget = g_edicts[16];
    useTarget.inuse = true;
    useTarget.targetname = "use1";
    useTarget.classname = "func_wall";
    useTarget.use = (_self, _other, act) => {
      usedWith.value = act;
    };

    G_UseTargets(ent, activator);

    expect(killVictim.inuse).toBe(false); // freed via killtarget
    expect(usedWith.value).toBe(activator);
    expect(rec.centerprintf).toHaveLength(1);
    expect(rec.centerprintf[0]?.fmt).toBe("boom");
    expect(rec.sound).toHaveLength(1);
  });
});

describe("G_TouchTriggers", () => {
  test("skips dead monsters/clients without calling BoxEdicts", () => {
    const rec = setupWorld();
    const ent = g_edicts[2];
    ent.svflags = SVF_MONSTER;
    ent.health = 0;
    const before = rec.boxEdicts;

    G_TouchTriggers(ent);

    expect(rec.boxEdicts).toBe(before);
  });

  test("calls BoxEdicts and no-ops when it returns no matches", () => {
    const rec = setupWorld();
    const ent = g_edicts[2];
    ent.health = 100;

    expect(() => G_TouchTriggers(ent)).not.toThrow();
    expect(rec.boxEdicts).toBeGreaterThan(0);
  });
});

describe("tv / vtos", () => {
  test("tv returns a temp vector with the given components", () => {
    expect(Array.from(tv(1, 2, 3))).toEqual([1, 2, 3]);
  });

  test("vtos formats like C's (int) truncation", () => {
    expect(vtos(vec3(1.9, -2.1, 3.999))).toBe("(1 -2 3)");
    expect(vtos(vec3(0, 0, 0))).toBe("(0 0 0)");
  });
});

describe("G_SetMovedir", () => {
  test("handles the VEC_UP special case", () => {
    const angles = vec3(0, -1, 0);
    const movedir = vec3();
    G_SetMovedir(angles, movedir);
    expect(Array.from(movedir)).toEqual([0, 0, 1]);
    expect(Array.from(angles)).toEqual([0, 0, 0]); // cleared
  });

  test("handles the VEC_DOWN special case", () => {
    const angles = vec3(0, -2, 0);
    const movedir = vec3();
    G_SetMovedir(angles, movedir);
    expect(Array.from(movedir)).toEqual([0, 0, -1]);
    expect(Array.from(angles)).toEqual([0, 0, 0]);
  });

  test("falls back to AngleVectors for a non-special angle", () => {
    const angles = vec3(0, 90, 0);
    const movedir = vec3();
    G_SetMovedir(angles, movedir);
    expect(movedir[0]).toBeCloseTo(0, 5);
    expect(movedir[1]).toBeCloseTo(1, 5);
    expect(Array.from(angles)).toEqual([0, 0, 0]);
  });
});

describe("vectoyaw / vectoangles", () => {
  test("vectoyaw matches the C special cases", () => {
    expect(vectoyaw(vec3(0, 5, 0))).toBe(90);
    expect(vectoyaw(vec3(0, -5, 0))).toBe(-90);
    expect(vectoyaw(vec3(0, 0, 0))).toBe(0);
  });

  test("vectoangles matches the straight-up special case", () => {
    const angles = vec3();
    vectoangles(vec3(0, 0, 5), angles);
    expect(angles[0]).toBe(-90); // angles[PITCH] = -pitch, pitch=90 when z>0
    expect(angles[1]).toBe(0);
    expect(angles[2]).toBe(0);
  });
});

describe("G_ProjectSource / G_InitEdict / G_CopyString", () => {
  test("G_ProjectSource combines point/forward/right/distance", () => {
    const result = vec3();
    G_ProjectSource(vec3(0, 0, 0), vec3(10, 5, 2), vec3(1, 0, 0), vec3(0, 1, 0), result);
    expect(Array.from(result)).toEqual([10, 5, 2]);
  });

  test("G_InitEdict sets inuse/classname/gravity/s.number from array identity", () => {
    setupWorld();
    const e = g_edicts[7];
    G_InitEdict(e);
    expect(e.inuse).toBe(true);
    expect(e.classname).toBe("noclass");
    expect(e.gravity).toBe(1);
    expect(e.s.number).toBe(7);
  });

  test("G_CopyString returns the same string value (JS strings are immutable)", () => {
    expect(G_CopyString("hello")).toBe("hello");
  });
});

describe("KillBox", () => {
  test("returns true immediately when the trace hits nothing", () => {
    setupWorld();
    const ent = g_edicts[2];
    expect(KillBox(ent)).toBe(true);
  });

  test("calls the real T_Damage (deals damage) when something blocks the spot", () => {
    setupWorld();
    const ent = g_edicts[2];
    ent.mins = vec3(-16, -16, -24);
    ent.maxs = vec3(16, 16, 32);

    const blocker = g_edicts[3];
    blocker.s.number = 3; // recovered via g_edicts[tr.ent.s.number], per PORTING.md EDICT_NUM idiom
    blocker.solid = SolidT.SOLID_BBOX;

    traceResult = {
      allsolid: false,
      startsolid: false,
      fraction: 0,
      endpos: vec3(),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: blocker,
    };

    blocker.takedamage = 1;
    blocker.inuse = true;
    blocker.health = 50;

    expect(MOD_TELEFRAG).toBe(21);
    expect(KillBox(ent)).toBe(false);
    expect(blocker.health).toBeLessThan(50);
  });
});
