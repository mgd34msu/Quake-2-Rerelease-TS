import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { SolidT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { DEAD_DEAD, EdictT, g_edicts, game, gameCvars, globals, level, MovetypeT, SetGEdicts } from "../src/game/g_local";
import { monster_think } from "../src/game/g_monster";
import { SP_monster_soldier, SP_monster_soldier_light, SP_monster_soldier_ss } from "../src/game/m_soldier";
import { SP_monster_infantry } from "../src/game/m_infantry";
import { SP_monster_gunner } from "../src/game/m_gunner";

// ---------------------------------------------------------------------------
// Self-sufficient fake GameImports, modeled after test/g_monster.test.ts's
// buildFakeImports/setupWorld -- an "open world" trace that never hits
// anything, so monster_think's frame stepping is exercised without depending
// on any other test file having run first (rule 13).
// ---------------------------------------------------------------------------

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

function buildFakeImports(): GameImports {
  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
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
    pointcontents: () => 0, // CONTENTS_EMPTY
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
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

const MAXENTITIES = 32;

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

function setupWorld(): void {
  GetGameAPI(buildFakeImports());

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;

  level.clear();

  globals.num_edicts = MAXENTITIES;

  // skill 1 (not deathmatch, not nightmare) so pain-anim branches run rather
  // than being skipped or aborting the spawn.
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
}

function freshEdict(index: number): EdictT {
  const e = new EdictT();
  e.s.number = index;
  g_edicts[index] = e;
  return e;
}

function expectFiniteOrigin(ent: EdictT): void {
  expect(Number.isFinite(ent.s.origin[0])).toBe(true);
  expect(Number.isFinite(ent.s.origin[1])).toBe(true);
  expect(Number.isFinite(ent.s.origin[2])).toBe(true);
}

function runFrames(ent: EdictT, count: number): void {
  for (let i = 0; i < count; i++) {
    monster_think(ent);
    expectFiniteOrigin(ent);
    // s.frame catches up to a currentmove switch on the NEXT think (C
    // behavior), and random fidget rolls can switch moves between the two
    // reads -- range-check only when the frame already belongs to the move.
    const move = ent.monsterinfo.currentmove;
    expect(Number.isFinite(ent.s.frame)).toBe(true);
    if (move && ent.s.frame >= move.firstframe) {
      expect(ent.s.frame).toBeLessThanOrEqual(move.lastframe);
    }
  }
}

// ---------------------------------------------------------------------------

describe("m_soldier", () => {
  test("SP_monster_soldier wires health/mass/movetype/mins/maxs and stands", () => {
    setupWorld();
    const ent = freshEdict(2);

    SP_monster_soldier(ent);

    expect(ent.health).toBe(30);
    expect(ent.gib_health).toBe(-30);
    expect(ent.mass).toBe(100);
    expect(ent.movetype).toBe(MovetypeT.MOVETYPE_STEP);
    expect(ent.solid).toBe(SolidT.SOLID_BBOX);
    expect(Array.from(ent.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 32]);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
    expect(ent.monsterinfo.stand).not.toBeNull();
  });

  test("the three soldier variants (light/soldier/ss) wire distinct health and gib_health", () => {
    setupWorld();
    const light = freshEdict(2);
    SP_monster_soldier_light(light);
    const regular = freshEdict(3);
    SP_monster_soldier(regular);
    const ss = freshEdict(4);
    SP_monster_soldier_ss(ss);

    expect(light.health).toBe(20);
    expect(regular.health).toBe(30);
    expect(ss.health).toBe(40);
    expect(light.gib_health).toBe(-30);
    expect(regular.gib_health).toBe(-30);
    expect(ss.gib_health).toBe(-30);
  });

  test("monster_think advances s.frame within the current move's range over 5 frames, no NaN", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_soldier(ent);

    runFrames(ent, 5);
  });

  test("pain callback runs without throwing", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_soldier(ent);
    const attacker = freshEdict(1);

    expect(() => ent.pain?.(ent, attacker, 10, 15)).not.toThrow();
  });

  test("die with gib-level damage sets deadflag to DEAD_DEAD", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_soldier(ent);
    const inflictor = freshEdict(1);
    const attacker = freshEdict(1);
    ent.health = ent.gib_health - 1;

    expect(() =>
      ent.die?.(ent, inflictor, attacker, 40, vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2])),
    ).not.toThrow();
    expect(ent.deadflag).toBe(DEAD_DEAD);
  });
});

describe("m_infantry", () => {
  test("SP_monster_infantry wires health/mass/movetype/mins/maxs and stands", () => {
    setupWorld();
    const ent = freshEdict(2);

    SP_monster_infantry(ent);

    expect(ent.health).toBe(100);
    expect(ent.gib_health).toBe(-40);
    expect(ent.mass).toBe(200);
    expect(ent.movetype).toBe(MovetypeT.MOVETYPE_STEP);
    expect(ent.solid).toBe(SolidT.SOLID_BBOX);
    expect(Array.from(ent.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 32]);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
    expect(ent.monsterinfo.stand).not.toBeNull();
  });

  test("monster_think advances s.frame within the current move's range over 5 frames, no NaN", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_infantry(ent);

    runFrames(ent, 5);
  });

  test("pain callback runs without throwing", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_infantry(ent);
    const attacker = freshEdict(1);

    expect(() => ent.pain?.(ent, attacker, 10, 15)).not.toThrow();
  });

  test("die with gib-level damage sets deadflag to DEAD_DEAD", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_infantry(ent);
    const inflictor = freshEdict(1);
    const attacker = freshEdict(1);
    ent.health = ent.gib_health - 1;

    expect(() =>
      ent.die?.(ent, inflictor, attacker, 40, vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2])),
    ).not.toThrow();
    expect(ent.deadflag).toBe(DEAD_DEAD);
  });
});

describe("m_gunner", () => {
  test("SP_monster_gunner wires health/mass/movetype/mins/maxs and stands", () => {
    setupWorld();
    const ent = freshEdict(2);

    SP_monster_gunner(ent);

    expect(ent.health).toBe(175);
    expect(ent.gib_health).toBe(-70);
    expect(ent.mass).toBe(200);
    expect(ent.movetype).toBe(MovetypeT.MOVETYPE_STEP);
    expect(ent.solid).toBe(SolidT.SOLID_BBOX);
    expect(Array.from(ent.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 32]);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
    expect(ent.monsterinfo.stand).not.toBeNull();
  });

  test("monster_think advances s.frame within the current move's range over 5 frames, no NaN", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_gunner(ent);

    runFrames(ent, 5);
  });

  test("pain callback runs without throwing", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_gunner(ent);
    const attacker = freshEdict(1);

    expect(() => ent.pain?.(ent, attacker, 10, 15)).not.toThrow();
  });

  test("die with gib-level damage sets deadflag to DEAD_DEAD", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_gunner(ent);
    const inflictor = freshEdict(1);
    const attacker = freshEdict(1);
    ent.health = ent.gib_health - 1;

    expect(() =>
      ent.die?.(ent, inflictor, attacker, 40, vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2])),
    ).not.toThrow();
    expect(ent.deadflag).toBe(DEAD_DEAD);
  });
});
