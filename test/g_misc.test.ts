// Tests for src/game/g_misc.ts, exercised through the real GetGameAPI(...)
// boundary (g_main.ts) with a fake GameImports, per .orch/preferences.md
// rule 13. Every describe block calls setupWorld() itself; nothing here
// depends on another test file having run first.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GetGameAPI } from "../src/game/g_main";
import { type Edict, GAME_API_VERSION, type GameExports, type GameImports, type GTraceT, SolidT, SVF_NOCLIENT } from "../src/game/game";
import {
  DamageT,
  EdictT,
  GIB_METALLIC,
  GIB_ORGANIC,
  MovetypeT,
  SetGEdicts,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  svc_temp_entity,
} from "../src/game/g_local";
import { crandom, random, vec3 } from "../src/shared/math";
import { CplaneT, TempEventT } from "../src/shared/q_shared";
import { BecomeExplosion1, SP_func_areaportal, SP_misc_explobox, SP_path_corner, ThrowGib } from "../src/game/g_misc";

// ---------------------------------------------------------------------------
// fake GameImports -- modeled after test/g_combat.test.ts's Recorder pattern.
// ---------------------------------------------------------------------------

interface Recorder {
  writeByte: number[];
  multicast: number;
  dprintf: string[];
  setmodel: Array<{ ent: Edict; name: string }>;
  areaportal: Array<{ portalnum: number; open: boolean }>;
}

function makeRecorder(): Recorder {
  return { writeByte: [], multicast: 0, dprintf: [], setmodel: [], areaportal: [] };
}

function defaultTrace(): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

let traceImpl: () => GTraceT = () => defaultTrace();

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf(fmt) {
      rec.dprintf.push(fmt);
    },
    cprintf() {},
    centerprintf() {},
    sound() {},
    positioned_sound() {},
    configstring() {},
    error(fmt): never {
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
    setmodel(ent, name) {
      rec.setmodel.push({ ent, name });
    },
    trace() {
      return traceImpl();
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
    SetAreaPortalState(portalnum, open) {
      rec.areaportal.push({ portalnum, open });
    },
    AreasConnected() {
      return false;
    },
    linkentity() {},
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    Pmove() {},
    multicast() {
      rec.multicast++;
    },
    unicast() {},
    WriteChar() {},
    WriteByte(c) {
      rec.writeByte.push(c);
    },
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

const MAXENTITIES = 40;

// maxclients = 1 for every test in this file, so G_FreeEdict actually frees
// (clears + inuse=false) any edict at index > maxclients + BODY_QUEUE_SIZE
// (1 + 8 = 9); indices 20+ are used below for entities meant to be freed.
function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;
  gameCvars.maxclients = null; // treated as 0 by the cvar-or-0 idiom used throughout g_utils.ts

  level.clear();

  globals.num_edicts = MAXENTITIES;
  globals.max_edicts = MAXENTITIES;
  globals.edicts = edicts;

  traceImpl = () => defaultTrace();

  return rec;
}

// ---------------------------------------------------------------------------
// ThrowGib
// ---------------------------------------------------------------------------

describe("ThrowGib", () => {
  let realRandom: () => number;

  beforeEach(() => {
    realRandom = Math.random;
  });

  afterEach(() => {
    Math.random = realRandom;
  });

  test("GIB_ORGANIC: MOVETYPE_TOSS + gib_touch, velocity = 0.5 * VelocityForDamage(damage<50 -> 0.7 inner scale), z clamped to 200", () => {
    setupWorld();
    Math.random = () => 0.3;

    // Reproduce VelocityForDamage's formula with the same random()/crandom()
    // helpers the implementation calls, under the same mocked Math.random.
    const c = crandom();
    // vscale(organic)=0.5, VelocityForDamage inner scale for damage<50 is 0.7:
    // x/y = 0.5 * 0.7 * 100 * crandom() = 35 * crandom(); z's raw value
    // (0.5*0.7*(200+100*random()) = 70..105) is always below ClipGibVelocity's
    // 200 floor, so it always clamps to exactly 200.
    const expectedX = 35 * c;
    const expectedY = 35 * c;

    const self = new EdictT();
    self.absmin.set([0, 0, 0]);
    self.size.set([0, 0, 0]);
    self.velocity.set([0, 0, 0]);

    ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", 10, GIB_ORGANIC);

    // Fresh world: G_Spawn's first allocation (maxclients+1) lands at index 1.
    const gib = g_edicts[1];
    expect(gib).toBeDefined();
    if (gib === undefined) return;

    expect(gib.movetype).toBe(MovetypeT.MOVETYPE_TOSS);
    expect(typeof gib.touch).toBe("function");
    expect(gib.solid).toBe(SolidT.SOLID_NOT);
    expect(gib.takedamage).toBe(DamageT.DAMAGE_YES);
    expect(gib.velocity[0]).toBeCloseTo(expectedX, 5);
    expect(gib.velocity[1]).toBeCloseTo(expectedY, 5);
    expect(gib.velocity[2]).toBeCloseTo(200, 5);
  });

  test("GIB_METALLIC: MOVETYPE_BOUNCE + no touch, velocity = 1.0 * VelocityForDamage(damage>=50 -> 1.2 inner scale), no clamp needed", () => {
    setupWorld();
    Math.random = () => 0.3;

    const c = crandom();
    const r = random();
    // vscale(metallic)=1.0, inner scale for damage>=50 is 1.2:
    const expectedX = 1.2 * 100 * c;
    const expectedY = 1.2 * 100 * c;
    const expectedZ = 1.2 * (200 + 100 * r); // in [240, 360], never clamped

    const self = new EdictT();
    self.absmin.set([0, 0, 0]);
    self.size.set([0, 0, 0]);
    self.velocity.set([0, 0, 0]);

    ThrowGib(self, "models/objects/gibs/chunk/tris.md2", 80, GIB_METALLIC);

    const gib = g_edicts[1];
    expect(gib).toBeDefined();
    if (gib === undefined) return;

    expect(gib.movetype).toBe(MovetypeT.MOVETYPE_BOUNCE);
    expect(gib.touch).toBeNull();
    expect(gib.velocity[0]).toBeCloseTo(expectedX, 5);
    expect(gib.velocity[1]).toBeCloseTo(expectedY, 5);
    expect(gib.velocity[2]).toBeCloseTo(expectedZ, 5);
  });

  test("setmodel is called with the caller-supplied gibname regardless of gib type", () => {
    const rec = setupWorld();
    const self = new EdictT();

    ThrowGib(self, "models/objects/gibs/bone/tris.md2", 10, GIB_ORGANIC);

    expect(rec.setmodel.some((c) => c.name === "models/objects/gibs/bone/tris.md2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BecomeExplosion1
// ---------------------------------------------------------------------------

describe("BecomeExplosion1", () => {
  test("writes svc_temp_entity + TE_EXPLOSION1 + multicasts, then frees the entity", () => {
    const rec = setupWorld();
    const self = g_edicts[20];
    if (self === undefined) throw new Error("fixture edict missing");
    self.inuse = true;
    self.s.origin.set([1, 2, 3]);

    BecomeExplosion1(self);

    expect(rec.writeByte).toEqual([svc_temp_entity, TempEventT.TE_EXPLOSION1]);
    expect(rec.multicast).toBe(1);
    expect(self.inuse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SP_path_corner
// ---------------------------------------------------------------------------

describe("SP_path_corner", () => {
  test("with a targetname: sets touch, mins/maxs, SOLID_TRIGGER, SVF_NOCLIENT", () => {
    setupWorld();
    const self = new EdictT();
    self.targetname = "pc1";

    SP_path_corner(self);

    expect(typeof self.touch).toBe("function");
    expect(Array.from(self.mins)).toEqual([-8, -8, -8]);
    expect(Array.from(self.maxs)).toEqual([8, 8, 8]);
    expect(self.solid).toBe(SolidT.SOLID_TRIGGER);
    expect(self.svflags & SVF_NOCLIENT).not.toBe(0);
  });

  test("without a targetname: logs and frees the entity instead of linking it", () => {
    const rec = setupWorld();
    const self = g_edicts[21];
    if (self === undefined) throw new Error("fixture edict missing");
    self.inuse = true;
    self.targetname = null;

    SP_path_corner(self);

    expect(rec.dprintf.some((m) => m.includes("path_corner with no targetname"))).toBe(true);
    expect(self.inuse).toBe(false);
    expect(self.touch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// misc_explobox -> barrel_delay -> barrel_explode, against a real
// T_RadiusDamage/CanDamage chain and a planted damageable target.
// ---------------------------------------------------------------------------

describe("misc_explobox barrel_explode chain", () => {
  test("real T_RadiusDamage damages a planted in-radius target, throws 14 debris chunks, and becomes a TE_EXPLOSION1", () => {
    const rec = setupWorld();
    traceImpl = () => ({ ...defaultTrace(), fraction: 1 }); // clear line of sight for CanDamage

    const barrel = g_edicts[30];
    const attacker = g_edicts[3];
    const target = g_edicts[5];
    if (barrel === undefined || attacker === undefined || target === undefined) {
      throw new Error("fixture edict missing");
    }
    barrel.inuse = true;
    attacker.inuse = true;

    SP_misc_explobox(barrel);
    // SP_misc_explobox defaults: mass=400, health=10, dmg=150, die=barrel_delay,
    // think=M_droptofloor (not exercised here -- we drive straight from the
    // die callback, as a real T_Damage(barrel, ...) call would).
    expect(barrel.dmg).toBe(150);
    expect(typeof barrel.die).toBe("function");

    target.inuse = true;
    target.solid = SolidT.SOLID_BBOX;
    target.takedamage = DamageT.DAMAGE_YES;
    target.health = 100;
    target.s.origin.set([10, 0, 0]); // distance 10 from the barrel's origin (0,0,0)

    // Drive the die -> barrel_delay -> think(barrel_explode) sequence exactly
    // as T_Damage would when the barrel's health reaches 0.
    barrel.die?.(barrel, attacker, attacker, 10, vec3());
    expect(barrel.think).not.toBeNull();
    barrel.think?.(barrel);

    // T_RadiusDamage(barrel, attacker, 150, null, 190, MOD_BARREL):
    // points = damage(150) - 0.5*distance(10) = 145 -> health 100 - 145 = -45.
    expect(target.health).toBe(-45);

    // barrel_explode always throws exactly 2 debris1 + 4 debris3 + 8 debris2
    // chunks (fixed counts, unlike func_explosive_explode's mass-scaled counts).
    const debrisCalls = rec.setmodel.filter((c) => c.name.includes("debris"));
    expect(debrisCalls.length).toBe(14);
    expect(debrisCalls.filter((c) => c.name.includes("debris1")).length).toBe(2);
    expect(debrisCalls.filter((c) => c.name.includes("debris2")).length).toBe(8);
    expect(debrisCalls.filter((c) => c.name.includes("debris3")).length).toBe(4);

    // groundentity is null on this fixture -> BecomeExplosion1, not 2.
    expect(rec.writeByte.slice(-2)).toEqual([svc_temp_entity, TempEventT.TE_EXPLOSION1]);
    expect(barrel.inuse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// func_areaportal
// ---------------------------------------------------------------------------

describe("SP_func_areaportal / Use_Areaportal toggling", () => {
  test("starts closed (count=0) and toggles SetAreaPortalState open/closed on successive uses", () => {
    const rec = setupWorld();
    const ent = new EdictT();
    ent.style = 5;

    SP_func_areaportal(ent);
    expect(ent.count).toBe(0);
    expect(typeof ent.use).toBe("function");

    ent.use?.(ent, null, null);
    ent.use?.(ent, null, null);

    expect(rec.areaportal).toEqual([
      { portalnum: 5, open: true },
      { portalnum: 5, open: false },
    ]);
  });
});
