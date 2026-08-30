// Tests for src/game/m_float.ts, m_flyer.ts, m_hover.ts, exercised through
// the real GetGameAPI(...) boundary (g_main.ts) with a fake GameImports, per
// .orch/preferences.md rule 13. Every describe block calls setupWorld()
// itself; nothing here depends on another test file having run first.
// Internal mmove_t/mframe_t statics are module-private, so moves are
// identified observably (currentmove identity comparisons within a single
// test, or move-table equality via a captured reference) rather than by
// importing them.

import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { SolidT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { DEAD_DEAD, EdictT, FL_FLY, g_edicts, game, gameCvars, globals, level, MovetypeT, SetGEdicts } from "../src/game/g_local";
import { monster_think } from "../src/game/g_monster";
import { SP_monster_floater } from "../src/game/m_float";
import { SP_monster_flyer } from "../src/game/m_flyer";
import { SP_monster_hover } from "../src/game/m_hover";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/monsters_c.test.ts's
// buildFakeImports/setupWorld. Self-sufficient per rule 13 -- every test
// below calls setupWorld() itself.
// ---------------------------------------------------------------------------

type TraceFn = (
  start: import("../src/shared/math").Vec3,
  mins: import("../src/shared/math").Vec3 | null,
  maxs: import("../src/shared/math").Vec3 | null,
  end: import("../src/shared/math").Vec3,
  passent: Edict | null,
) => GTraceT;

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

function buildFakeImports(traceFn?: TraceFn): GameImports {
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
    trace: (start, mins, maxs, end, passent) => (traceFn ? traceFn(start, mins, maxs, end, passent) : defaultTrace(end)),
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

function setupWorld(traceFn?: TraceFn): void {
  GetGameAPI(buildFakeImports(traceFn));

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

  gameCvars.maxclients = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);

  nextEdictIndex = 10; // past maxclients(1) + BODY_QUEUE_SIZE(8), so G_FreeEdict actually frees these
}

let nextEdictIndex = 10;
function newMonster(): EdictT {
  const ent = g_edicts[nextEdictIndex++];
  ent.inuse = true;
  ent.solid = SolidT.SOLID_BBOX;
  globals.num_edicts = Math.max(globals.num_edicts, nextEdictIndex);
  return ent;
}

function assertNoNaN(ent: EdictT): void {
  expect(Number.isNaN(ent.s.origin[0])).toBe(false);
  expect(Number.isNaN(ent.s.origin[1])).toBe(false);
  expect(Number.isNaN(ent.s.origin[2])).toBe(false);
  expect(Number.isFinite(ent.s.frame)).toBe(true);
}

function runThinkFrames(ent: EdictT, n: number): void {
  for (let i = 0; i < n; i++) {
    monster_think(ent);
    assertNoNaN(ent);
  }
}

// ---------------------------------------------------------------------------

describe("SP_monster_floater", () => {
  test("sets health/mass/boxes/stand and FL_FLY via flymonster_start", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_floater(ent);

    expect(ent.health).toBe(200);
    expect(ent.gib_health).toBe(-80);
    expect(ent.mass).toBe(300);
    expect(Array.from(ent.mins)).toEqual([-24, -24, -24]);
    expect(Array.from(ent.maxs)).toEqual([24, 24, 32]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.melee).not.toBeNull();
    expect(ent.monsterinfo.currentmove).not.toBeNull();

    runThinkFrames(ent, 1); // drive flymonster_start's deferred think (flymonster_start_go)
    expect((ent.flags & FL_FLY) !== 0).toBe(true);
  });

  test("deathmatch frees the edict instead of spawning it", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const ent = newMonster();

    SP_monster_floater(ent);

    expect(ent.inuse).toBe(false);
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_floater(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_floater(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    expect(ent.pain).not.toBeNull();
    ent.pain?.(ent, other, 0, 30);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die frees the edict via BecomeExplosion1 (floater_die has no gib path)", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_floater(ent);
    const other = newMonster();

    expect(ent.die).not.toBeNull();
    ent.die?.(ent, other, other, 999, vec3());

    expect(ent.inuse).toBe(false);
  });
});

describe("SP_monster_flyer", () => {
  test("sets health/mass/boxes/stand and FL_FLY via flymonster_start", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_flyer(ent);

    expect(ent.health).toBe(50);
    expect(ent.mass).toBe(50);
    expect(Array.from(ent.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 32]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.melee).not.toBeNull();
    expect(ent.monsterinfo.attack).not.toBeNull();
    expect(ent.monsterinfo.currentmove).not.toBeNull();

    runThinkFrames(ent, 1); // drive flymonster_start's deferred think (flymonster_start_go)
    expect((ent.flags & FL_FLY) !== 0).toBe(true);
  });

  test("deathmatch frees the edict instead of spawning it", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const ent = newMonster();

    SP_monster_flyer(ent);

    expect(ent.inuse).toBe(false);
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_flyer(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_flyer(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    expect(ent.pain).not.toBeNull();
    ent.pain?.(ent, other, 0, 10);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die frees the edict via BecomeExplosion1", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_flyer(ent);
    const other = newMonster();

    expect(ent.die).not.toBeNull();
    ent.die?.(ent, other, other, 999, vec3());

    expect(ent.inuse).toBe(false);
  });
});

describe("SP_monster_hover", () => {
  test("sets health/mass/boxes/stand and FL_FLY via flymonster_start", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_hover(ent);

    expect(ent.health).toBe(240);
    expect(ent.gib_health).toBe(-100);
    expect(ent.mass).toBe(150);
    expect(Array.from(ent.mins)).toEqual([-24, -24, -24]);
    expect(Array.from(ent.maxs)).toEqual([24, 24, 32]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.melee).toBeNull(); // hover has no melee attack, unlike floater/flyer
    expect(ent.monsterinfo.attack).not.toBeNull();
    expect(ent.monsterinfo.search).not.toBeNull();
    expect(ent.monsterinfo.currentmove).not.toBeNull();

    runThinkFrames(ent, 1); // drive flymonster_start's deferred think (flymonster_start_go)
    expect((ent.flags & FL_FLY) !== 0).toBe(true);
  });

  test("deathmatch frees the edict instead of spawning it", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const ent = newMonster();

    SP_monster_hover(ent);

    expect(ent.inuse).toBe(false);
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_hover(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_hover(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    expect(ent.pain).not.toBeNull();
    ent.pain?.(ent, other, 0, 10);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die below gib_health throws gibs and sets DEAD_DEAD without freeing the edict", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_hover(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    expect(ent.die).not.toBeNull();
    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.inuse).toBe(true);
  });

  test("die above gib_health floats the corpse (hover_deadthink) before exploding", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_hover(ent);
    ent.health = 0; // above gib_health (-100), not gibbed
    const other = newMonster();

    ent.die?.(ent, other, other, 60, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.takedamage).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBeNull();

    // Simulate the death animation reaching its last frame: hover_move_death1's
    // endfunc is hover_dead, which arms the floating-corpse deadthink.
    ent.monsterinfo.currentmove?.endfunc?.(ent);

    expect(ent.movetype).toBe(MovetypeT.MOVETYPE_TOSS);
    expect(ent.groundentity).toBeNull();
    expect(ent.timestamp).toBeGreaterThan(level.time);
    expect(ent.think).not.toBeNull();

    // Airborne and still within the 15-second float window: deadthink just
    // reschedules itself, the edict stays alive.
    ent.think?.(ent);
    expect(ent.inuse).toBe(true);

    // Once the float window elapses, deadthink calls BecomeExplosion1 and
    // frees the edict.
    level.time = ent.timestamp + 1;
    ent.think?.(ent);
    expect(ent.inuse).toBe(false);
  });
});
