import { describe, expect, test } from "bun:test";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GAME_API_VERSION, SolidT, SVF_MONSTER } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  EdictT,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  MOD_MACHINEGUN,
  MovetypeT,
  SetGEdicts,
  svc_temp_entity,
} from "../src/game/g_local";
import { G_FreeEdict } from "../src/game/g_utils";
import {
  bfg_explode,
  blaster_touch,
  fire_bfg,
  fire_blaster,
  fire_bullet,
  fire_rail,
  Grenade_Explode,
} from "../src/game/g_weapon";
import {
  monsterFlashOffset,
} from "../src/game/m_flash";
import { vec3 } from "../src/shared/math";
import type { Vec3 } from "../src/shared/math";
import {
  CplaneT,
  CsurfaceT,
  CvarT,
  MZ2_JORG_BFG_1,
  MZ2_TANK_BLASTER_1,
  MZ2_WIDOW2_BEAM_SWEEP_11,
  TempEventT,
} from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports: queued trace results (so tests can script multi-trace
// weapon paths like fire_lead's two-pass trace or fire_rail's pierce loop),
// plus recorders for WriteByte/sound/multicast. Modeled after
// test/g_combat.test.ts and test/g_spawn.test.ts's GetGameAPI-based setup.
// ---------------------------------------------------------------------------

interface Recorder {
  writeByte: number[];
  sound: Array<{ ent: Edict; soundindex: number }>;
  multicast: number;
  linkentity: Edict[];
}

function makeRecorder(): Recorder {
  return { writeByte: [], sound: [], multicast: 0, linkentity: [] };
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

let traceQueue: GTraceT[] = [];

function nextTrace(): GTraceT {
  const queued = traceQueue.shift();
  if (queued !== undefined) return queued;
  return defaultTrace();
}

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf() {},
    centerprintf() {},
    sound(ent, _channel, soundindex) {
      rec.sound.push({ ent, soundindex });
    },
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
    setmodel() {},
    trace() {
      return nextTrace();
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

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 16;

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

  level.clear();

  gameCvars.maxclients = fakeCvar(1);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.coop = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;

  traceQueue = [];

  return rec;
}

function wallSurface(): CsurfaceT {
  const s = new CsurfaceT();
  s.name = "wall";
  s.flags = 0;
  return s;
}

// ---------------------------------------------------------------------------

describe("fire_bullet / fire_lead", () => {
  test("queued hit trace on a damageable target drops health via real T_Damage", () => {
    const rec = setupWorld();
    const self = g_edicts[1];
    const target = g_edicts[2];
    target.takedamage = 1;
    target.health = 100;
    target.movetype = MovetypeT.MOVETYPE_NONE;

    // trace 1: muzzle-embedded check misses (clean start point)
    traceQueue.push({ ...defaultTrace(), fraction: 1 });
    // trace 2: the actual shot trace hits the target
    traceQueue.push({ ...defaultTrace(), fraction: 0.5, ent: target, contents: 0, surface: wallSurface() });

    fire_bullet(self, vec3(0, 0, 0), vec3(1, 0, 0), 10, 0, 0, 0, MOD_MACHINEGUN);

    expect(target.health).toBe(90);
    // takedamage branch never writes fire_lead's own TE_GUNSHOT bytes (only
    // T_Damage's internal SpawnDamage blood/sparks effect does)
    expect(rec.writeByte).not.toContain(TempEventT.TE_GUNSHOT);
  });

  test("wall hit (surface flags 0) records the TE gunshot byte sequence", () => {
    const rec = setupWorld();
    const self = g_edicts[1];
    const wall = g_edicts[2];
    wall.takedamage = 0;

    traceQueue.push({ ...defaultTrace(), fraction: 1 });
    traceQueue.push({ ...defaultTrace(), fraction: 0.5, ent: wall, contents: 0, surface: wallSurface() });

    fire_bullet(self, vec3(0, 0, 0), vec3(1, 0, 0), 10, 0, 0, 0, MOD_MACHINEGUN);

    expect(rec.writeByte).toEqual([svc_temp_entity, TempEventT.TE_GUNSHOT]);
  });
});

describe("fire_blaster", () => {
  test("spawns a bolt: MOVETYPE_FLYMISSILE, speed-scaled velocity, touch set", () => {
    setupWorld();
    const self = g_edicts[1];

    fire_blaster(self, vec3(0, 0, 0), vec3(1, 0, 0), 15, 500, 0, false);

    const bolt = g_edicts[2];
    expect(bolt.inuse).toBe(true);
    expect(bolt.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
    expect(Array.from(bolt.velocity)).toEqual([500, 0, 0]);
    expect(bolt.touch).toBe(blaster_touch);
    expect(bolt.dmg).toBe(15);
  });
});

describe("Grenade_Explode", () => {
  test("radius-damages a planted edict and records TE_GRENADE_EXPLOSION (water variant via waterlevel)", () => {
    const rec = setupWorld();
    const attacker = g_edicts[1];
    attacker.client = null;

    const grenade = g_edicts[2];
    grenade.owner = attacker;
    grenade.enemy = null;
    grenade.dmg = 100;
    grenade.dmg_radius = 200;
    grenade.groundentity = g_edicts[0];
    grenade.waterlevel = 0;

    const target = g_edicts[3];
    target.inuse = true;
    target.takedamage = 1;
    target.health = 100;
    target.solid = SolidT.SOLID_BBOX;

    Grenade_Explode(grenade);

    expect(target.health).toBeLessThan(100);
    expect(rec.writeByte).toContain(TempEventT.TE_GRENADE_EXPLOSION);

    // water variant: same shape, waterlevel set, far from `target` so the
    // second explosion doesn't re-damage it and muddy the byte sequence.
    rec.writeByte.length = 0;
    const grenade2 = g_edicts[4];
    grenade2.owner = attacker;
    grenade2.enemy = null;
    grenade2.dmg = 50;
    grenade2.dmg_radius = 50;
    grenade2.groundentity = g_edicts[0];
    grenade2.waterlevel = 1;
    grenade2.s.origin[0] = 10000;

    Grenade_Explode(grenade2);

    expect(rec.writeByte).toContain(TempEventT.TE_GRENADE_EXPLOSION_WATER);
  });
});

describe("fire_rail", () => {
  test("two queued traces pierce both targets", () => {
    setupWorld();
    const self = g_edicts[1];
    self.client = null;

    const monster = g_edicts[2];
    monster.svflags = SVF_MONSTER;
    monster.takedamage = 1;
    monster.health = 100;

    const wall = g_edicts[3];
    wall.takedamage = 1;
    wall.health = 100;

    traceQueue.push({ ...defaultTrace(), fraction: 0.5, ent: monster, contents: 0, endpos: vec3(10, 0, 0) });
    traceQueue.push({ ...defaultTrace(), fraction: 0.5, ent: wall, contents: 0, endpos: vec3(20, 0, 0) });

    fire_rail(self, vec3(0, 0, 0), vec3(1, 0, 0), 50, 10);

    expect(monster.health).toBe(50);
    expect(wall.health).toBe(50);
    expect(traceQueue.length).toBe(0);
  });
});

describe("bfg_explode", () => {
  test("stages across 5 frames, then hands off to G_FreeEdict", () => {
    setupWorld();
    const self = g_edicts[1];
    self.owner = g_edicts[2];
    self.dmg_radius = 100;
    self.radius_dmg = 100;
    self.s.frame = 0;

    for (let i = 0; i < 4; i++) {
      bfg_explode(self);
      expect(self.s.frame).toBe(i + 1);
      expect(self.think).not.toBe(G_FreeEdict);
    }

    bfg_explode(self);
    expect(self.s.frame).toBe(5);
    expect(self.think).toBe(G_FreeEdict);
  });
});

describe("monster_flash_offset (m_flash.c)", () => {
  test("table includes one row per MZ2_* index plus the leading unused row and a trailing all-zero pad row", () => {
    const table = monsterFlashOffset();
    // The C array literal ends with an explicit "end of table" 0,0,0 row
    // after MZ2_WIDOW2_BEAM_SWEEP_11 (210), one past "highest index + 1";
    // kept faithful to the C source (see report -- deviation from a length
    // of exactly highest+1).
    expect(table.length).toBe(MZ2_WIDOW2_BEAM_SWEEP_11 + 2);
  });

  function expectVec3CloseTo(v: Vec3, x: number, y: number, z: number): void {
    expect(v[0]).toBeCloseTo(x, 2);
    expect(v[1]).toBeCloseTo(y, 2);
    expect(v[2]).toBeCloseTo(z, 2);
  }

  test("spot-checks 3 rows against the C source", () => {
    const table = monsterFlashOffset();
    expectVec3CloseTo(table[0], 0, 0, 0);
    expectVec3CloseTo(table[MZ2_TANK_BLASTER_1], 20.7, -18.5, 28.7);
    expectVec3CloseTo(table[MZ2_JORG_BFG_1], 6.3, -9, 111.2);
  });
});
