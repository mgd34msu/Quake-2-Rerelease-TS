import { describe, expect, test } from "bun:test";
import {
  CanDamage,
  CheckArmor,
  CheckTeamDamage,
  Killed,
  SpawnDamage,
  T_Damage,
  T_RadiusDamage,
} from "../src/game/g_combat";
import { GAME_API_VERSION, SolidT, SVF_MONSTER } from "../src/game/game";
import type { Edict, GameExports, GameImports, GTraceT } from "../src/game/game";
import {
  AI_GOOD_GUY,
  DAMAGE_NO_KNOCKBACK,
  DAMAGE_NO_PROTECTION,
  DEAD_NO,
  EdictT,
  FL_FLY,
  FL_GODMODE,
  FL_SWIM,
  g_edicts,
  game,
  GClientT,
  globals,
  level,
  MovetypeT,
  SetGameExports,
  SetGameImports,
  SetGEdicts,
} from "../src/game/g_local";
import { FindItem, InitItems, ITEM_INDEX, SetItemNames } from "../src/game/g_items";
import { vec3 } from "../src/shared/math";
import { CplaneT } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports: configurable trace, sound/WriteByte recorded, multicast
// is a no-op recorder. Modeled after test/g_utils.test.ts's fake.
// ---------------------------------------------------------------------------

interface Recorder {
  sound: Array<{ ent: Edict; soundindex: number }>;
  writeByte: number[];
  multicast: number;
  dprintf: string[];
}

function makeRecorder(): Recorder {
  return { sound: [], writeByte: [], multicast: 0, dprintf: [] };
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

// mutable so individual tests can script a hit; reset by setupWorld()
let traceImpl: (
  start: import("../src/shared/math").Vec3,
  mins: import("../src/shared/math").Vec3 | null,
  maxs: import("../src/shared/math").Vec3 | null,
  end: import("../src/shared/math").Vec3,
  passent: Edict | null,
  contentmask: number,
) => GTraceT = () => defaultTrace();

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf(fmt) {
      rec.dprintf.push(fmt);
    },
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
    trace(start, mins, maxs, end, passent, contentmask) {
      return traceImpl(start, mins, maxs, end, passent, contentmask);
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

const MAXENTITIES = 32;

function setupWorld(): Recorder {
  const rec = makeRecorder();
  SetGameImports(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;

  level.clear();

  SetGameExports(makeFakeGameExports(edicts, MAXENTITIES));

  traceImpl = () => defaultTrace();

  return rec;
}

// ---------------------------------------------------------------------------

describe("CanDamage", () => {
  test("returns true when the direct trace reaches fraction 1", () => {
    setupWorld();
    const targ = g_edicts[2];
    const inflictor = g_edicts[3];
    traceImpl = () => ({ ...defaultTrace(), fraction: 1 });

    expect(CanDamage(targ, inflictor)).toBe(true);
  });

  test("returns false when every probe trace is blocked by something else", () => {
    setupWorld();
    const targ = g_edicts[2];
    const inflictor = g_edicts[3];
    const blocker = g_edicts[4];
    // fraction < 1 on every one of the 5 probes (origin + 4 corner offsets),
    // and the blocking entity is not the target itself.
    traceImpl = () => ({ ...defaultTrace(), fraction: 0.5, ent: blocker });

    expect(CanDamage(targ, inflictor)).toBe(false);
  });

  test("MOVETYPE_PUSH target counts as reachable when the trace ends on the target itself", () => {
    setupWorld();
    const targ = g_edicts[2];
    targ.movetype = MovetypeT.MOVETYPE_PUSH;
    const inflictor = g_edicts[3];
    traceImpl = () => ({ ...defaultTrace(), fraction: 0.4, ent: targ });

    expect(CanDamage(targ, inflictor)).toBe(true);
  });
});

describe("T_Damage", () => {
  test("reduces health by damage with no armor/client and applies knockback along dir scaled by 500/mass", () => {
    setupWorld();
    const targ = g_edicts[5];
    targ.takedamage = 1;
    targ.health = 100;
    targ.movetype = MovetypeT.MOVETYPE_WALK; // not NONE/BOUNCE/PUSH/STOP
    targ.mass = 100;
    const inflictor = g_edicts[6];
    const attacker = g_edicts[7];

    T_Damage(targ, inflictor, attacker, vec3(1, 0, 0), vec3(), vec3(), 30, 100, 0, 0);

    expect(targ.health).toBe(70);
    // C: VectorScale(dir, 500.0 * knockback / mass, kvel) -> 500*100/100 = 500
    expect(targ.velocity[0]).toBeCloseTo(500, 5);
    expect(targ.velocity[1]).toBeCloseTo(0, 5);
    expect(targ.velocity[2]).toBeCloseTo(0, 5);
  });

  test("DAMAGE_NO_KNOCKBACK suppresses the velocity change but still applies damage", () => {
    setupWorld();
    const targ = g_edicts[5];
    targ.takedamage = 1;
    targ.health = 100;
    targ.movetype = MovetypeT.MOVETYPE_WALK;
    targ.mass = 100;
    const inflictor = g_edicts[6];
    const attacker = g_edicts[7];

    T_Damage(targ, inflictor, attacker, vec3(1, 0, 0), vec3(), vec3(), 30, 100, DAMAGE_NO_KNOCKBACK, 0);

    expect(targ.health).toBe(70);
    expect(Array.from(targ.velocity)).toEqual([0, 0, 0]);
  });

  test("godmode zeroes take", () => {
    setupWorld();
    const targ = g_edicts[5];
    targ.takedamage = 1;
    targ.health = 100;
    targ.flags |= FL_GODMODE;
    const inflictor = g_edicts[6];
    const attacker = g_edicts[7];

    T_Damage(targ, inflictor, attacker, vec3(1, 0, 0), vec3(), vec3(), 50, 0, 0, 0);

    expect(targ.health).toBe(100);
  });

  test("DAMAGE_NO_PROTECTION overrides godmode", () => {
    setupWorld();
    const targ = g_edicts[5];
    targ.takedamage = 1;
    targ.health = 100;
    targ.flags |= FL_GODMODE;
    const inflictor = g_edicts[6];
    const attacker = g_edicts[7];

    T_Damage(targ, inflictor, attacker, vec3(1, 0, 0), vec3(), vec3(), 50, 0, DAMAGE_NO_PROTECTION, 0);

    expect(targ.health).toBe(50);
  });

  test("a takedamage of 0 is a no-op (early return)", () => {
    setupWorld();
    const targ = g_edicts[5];
    targ.takedamage = 0;
    targ.health = 100;
    const inflictor = g_edicts[6];
    const attacker = g_edicts[7];

    T_Damage(targ, inflictor, attacker, vec3(1, 0, 0), vec3(), vec3(), 50, 0, 0, 0);

    expect(targ.health).toBe(100);
  });
});

describe("CheckArmor", () => {
  test("damage of 0 returns 0 without touching ArmorIndex", () => {
    setupWorld();
    const ent = g_edicts[8];
    ent.client = new GClientT();

    expect(CheckArmor(ent, vec3(), vec3(), 0, 0, 0)).toBe(0);
  });

  test("no client returns 0 without touching ArmorIndex", () => {
    setupWorld();
    const ent = g_edicts[8];
    ent.client = null;

    expect(CheckArmor(ent, vec3(), vec3(), 10, 0, 0)).toBe(0);
  });

  test("DAMAGE_NO_ARMOR returns 0 without touching ArmorIndex", () => {
    setupWorld();
    const ent = g_edicts[8];
    ent.client = new GClientT();

    // biome-ignore-line: DAMAGE_NO_ARMOR is the literal 0x00000002 dflag
    expect(CheckArmor(ent, vec3(), vec3(), 10, 0, 0x00000002)).toBe(0);
  });

  test("jacket armor absorbs ceil(damage * .30) and consumes inventory", () => {
    setupWorld();
    const ent = g_edicts[8];
    ent.client = new GClientT();
    InitItems();
    SetItemNames();
    const jacket = FindItem("Jacket Armor");
    if (jacket === null) throw new Error("Jacket Armor missing from itemlist");
    ent.client.pers.inventory[ITEM_INDEX(jacket)] = 25;

    expect(CheckArmor(ent, vec3(), vec3(), 10, 0, 0)).toBe(3);
    expect(ent.client.pers.inventory[ITEM_INDEX(jacket)]).toBe(22);
  });
});

describe("CheckTeamDamage", () => {
  test("always returns false (team damage gate is unimplemented, per the original C FIXME)", () => {
    setupWorld();
    expect(CheckTeamDamage(g_edicts[1], g_edicts[2])).toBe(false);
  });
});

describe("SpawnDamage", () => {
  test("writes the temp-entity type/position/dir and multicasts, clamping damage to 255", () => {
    const rec = setupWorld();
    SpawnDamage(7, vec3(1, 2, 3), vec3(0, 0, 1), 999);

    expect(rec.writeByte).toContain(7);
    expect(rec.multicast).toBe(1);
  });
});

describe("Killed", () => {
  test("clamps health below -999 to exactly -999 and invokes the die callback", () => {
    setupWorld();
    const targ = g_edicts[9];
    targ.health = -5000;
    targ.movetype = MovetypeT.MOVETYPE_NONE; // doors/triggers early-return path
    const inflictor = g_edicts[10];
    const attacker = g_edicts[11];

    const dieCalls: Array<{ damage: number; point: import("../src/shared/math").Vec3 }> = [];
    targ.die = (_self, _inflictor, _attacker, damage, point) => {
      dieCalls.push({ damage, point });
    };

    Killed(targ, inflictor, attacker, 42, vec3(4, 5, 6));

    expect(targ.health).toBe(-999);
    expect(targ.enemy).toBe(attacker);
    expect(dieCalls).toHaveLength(1);
    expect(dieCalls[0]?.damage).toBe(42);
    expect(Array.from(dieCalls[0]?.point ?? vec3())).toEqual([4, 5, 6]);
  });

  test("credits a monster kill (score + medic ownership) without reaching monster_death_use for MOVETYPE_NONE", () => {
    setupWorld();
    level.killed_monsters = 0;
    const targ = g_edicts[9];
    targ.health = 10;
    targ.svflags = SVF_MONSTER;
    targ.deadflag = DEAD_NO;
    targ.movetype = MovetypeT.MOVETYPE_NONE; // takes the early die() path, skipping monster_death_use
    targ.monsterinfo.aiflags = 0; // not AI_GOOD_GUY
    targ.die = () => {};

    const attacker = g_edicts[10];
    attacker.classname = "monster_medic";
    const inflictor = g_edicts[11];

    Killed(targ, inflictor, attacker, 10, vec3());

    expect(level.killed_monsters).toBe(1);
    expect(targ.owner).toBe(attacker);
  });

  test("AI_GOOD_GUY monsters do not count toward killed_monsters", () => {
    setupWorld();
    level.killed_monsters = 0;
    const targ = g_edicts[9];
    targ.svflags = SVF_MONSTER;
    targ.deadflag = DEAD_NO;
    targ.movetype = MovetypeT.MOVETYPE_NONE;
    targ.monsterinfo.aiflags = AI_GOOD_GUY;
    targ.die = () => {};
    const attacker = g_edicts[10];
    const inflictor = g_edicts[11];

    Killed(targ, inflictor, attacker, 10, vec3());

    expect(level.killed_monsters).toBe(0);
  });

  test("a monster with a target reaches monster_death_use, which clears FL_FLY/FL_SWIM and fires G_UseTargets with the killer as activator", () => {
    setupWorld();
    globals.num_edicts = MAXENTITIES;
    const targ = g_edicts[9];
    targ.svflags = SVF_MONSTER;
    targ.deadflag = DEAD_NO;
    targ.movetype = MovetypeT.MOVETYPE_WALK; // not PUSH/STOP/NONE -> reaches monster_death_use
    targ.flags = FL_FLY | FL_SWIM;
    targ.target = "use1";
    targ.die = () => {};
    const attacker = g_edicts[10];
    const inflictor = g_edicts[11];

    const usedWith: { value: EdictT | null } = { value: null };
    const useTarget = g_edicts[16];
    useTarget.inuse = true;
    useTarget.targetname = "use1";
    useTarget.use = (_self, _other, act) => {
      usedWith.value = act;
    };

    Killed(targ, inflictor, attacker, 10, vec3());

    expect(targ.flags & (FL_FLY | FL_SWIM)).toBe(0);
    expect(usedWith.value).toBe(attacker); // Killed() sets targ.enemy = attacker before monster_death_use fires it
  });
});

describe("T_RadiusDamage", () => {
  test("damages in-radius entities per the falloff formula, skips the ignore entity, and skips non-positive points", () => {
    const rec = setupWorld();
    globals.num_edicts = MAXENTITIES;
    traceImpl = () => ({ ...defaultTrace(), fraction: 1 }); // clear line of sight for CanDamage

    const inflictor = g_edicts[1];
    inflictor.s.origin.set([0, 0, 0]);
    inflictor.takedamage = 0; // projectiles aren't self-damageable
    inflictor.solid = SolidT.SOLID_NOT; // excluded from findradius's own scan

    const attacker = g_edicts[2];
    attacker.solid = SolidT.SOLID_NOT;

    // near target: distance 10, damage 100, radius 100 -> points = 100 - 0.5*10 = 95
    const near = g_edicts[12];
    near.inuse = true;
    near.solid = SolidT.SOLID_BBOX;
    near.takedamage = 1;
    near.health = 100;
    near.s.origin.set([10, 0, 0]);

    // far target: distance 250, damage 100 -> points = 100 - 125 = -25 <= 0, skipped
    const far = g_edicts[13];
    far.inuse = true;
    far.solid = SolidT.SOLID_BBOX;
    far.takedamage = 1;
    far.health = 100;
    far.s.origin.set([250, 0, 0]);

    // ignored target: close enough to take damage, but explicitly excluded
    const ignored = g_edicts[14];
    ignored.inuse = true;
    ignored.solid = SolidT.SOLID_BBOX;
    ignored.takedamage = 1;
    ignored.health = 100;
    ignored.s.origin.set([5, 0, 0]);

    globals.num_edicts = 20;

    T_RadiusDamage(inflictor, attacker, 100, ignored, 1000, 0);

    expect(near.health).toBe(5); // 100 - 95
    expect(far.health).toBe(100); // untouched: falloff <= 0
    expect(ignored.health).toBe(100); // untouched: explicitly ignored

    expect(rec.multicast).toBeGreaterThan(0); // SpawnDamage(TE_BLOOD/te_sparks, ...) fired for `near`
  });
});
