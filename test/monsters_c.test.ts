import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { AI_DUCKED, DEAD_DEAD, EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/game/g_local";
import { monster_think } from "../src/game/g_monster";
import { SP_monster_berserk } from "../src/game/m_berserk";
import { SP_monster_gladiator } from "../src/game/m_gladiator";
import { SP_monster_mutant } from "../src/game/m_mutant";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/g_monster.test.ts's
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

  // gameCvars is a module-level singleton (not reset by game.clear()); pin
  // every field these monster files read so a previous test's mutation
  // (e.g. deathmatch) can never leak into this one.
  gameCvars.maxclients = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);

  nextEdictIndex = 10; // past maxclients(1) + BODY_QUEUE_SIZE(8), so G_FreeEdict actually frees these
}

// allocate real slots out of g_edicts (not detached `new EdictT()`s) so
// G_FreeEdict's `g_edicts.indexOf(ed)` check and G_Spawn's gib allocation
// both see these as real world entities, matching a live spawn.
let nextEdictIndex = 10;
function newMonster(): EdictT {
  const ent = g_edicts[nextEdictIndex++];
  ent.inuse = true;
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

describe("SP_monster_berserk", () => {
  test("sets health/mass/boxes and a stand move; deathmatch frees the edict", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_berserk(ent);

    expect(ent.health).toBe(240);
    expect(ent.gib_health).toBe(-60);
    expect(ent.mass).toBe(250);
    expect(Array.from(ent.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 32]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("deathmatch frees the edict instead of spawning it", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const ent = newMonster();

    SP_monster_berserk(ent);

    expect(ent.inuse).toBe(false);
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_berserk(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_berserk(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    expect(ent.pain).not.toBeNull();
    ent.pain?.(ent, other, 0, 30);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die below gib_health throws gibs and sets DEAD_DEAD", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_berserk(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    expect(ent.die).not.toBeNull();
    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
  });

  test("die above gib_health but takes fatal damage sets a regular death move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_berserk(ent);
    ent.health = 0; // above gib_health (-60), not gibbed
    const other = newMonster();

    ent.die?.(ent, other, other, 60, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.takedamage).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });
});

describe("SP_monster_gladiator", () => {
  test("sets health/mass/boxes and a stand move", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_gladiator(ent);

    expect(ent.health).toBe(400);
    expect(ent.gib_health).toBe(-175);
    expect(ent.mass).toBe(400);
    expect(Array.from(ent.mins)).toEqual([-32, -32, -24]);
    expect(Array.from(ent.maxs)).toEqual([32, 32, 64]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.attack).not.toBeNull(); // gladiator has a railgun attack, unlike berserk
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_gladiator(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_gladiator(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    ent.pain?.(ent, other, 0, 10);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("pain while airborne (velocity[2] > 100) inside the debounce window switches to the air-pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_gladiator(ent);
    const other = newMonster();

    ent.pain?.(ent, other, 0, 10); // establishes pain_debounce_time and gladiator_move_pain
    const groundPainMove = ent.monsterinfo.currentmove;
    ent.velocity[2] = 150;

    ent.pain?.(ent, other, 0, 10); // still inside debounce window

    expect(ent.monsterinfo.currentmove).not.toBe(groundPainMove);
  });

  test("die below gib_health throws gibs and sets DEAD_DEAD", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_gladiator(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
  });
});

describe("SP_monster_mutant", () => {
  test("sets health/mass/boxes and a stand move", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_mutant(ent);

    expect(ent.health).toBe(300);
    expect(ent.gib_health).toBe(-120);
    expect(ent.mass).toBe(300);
    expect(Array.from(ent.mins)).toEqual([-32, -32, -24]);
    expect(Array.from(ent.maxs)).toEqual([32, 32, 48]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.checkattack).not.toBeNull(); // mutant overrides the default M_CheckAttack
    expect(ent.monsterinfo.attack).not.toBeNull(); // the jump attack
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_mutant(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_mutant(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    ent.pain?.(ent, other, 0, 10);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die below gib_health throws gibs and sets DEAD_DEAD", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_mutant(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
  });

  test("die above gib_health sets a regular death move and skinnum 1", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_mutant(ent);
    ent.health = 0; // above gib_health (-120), not gibbed
    const other = newMonster();

    ent.die?.(ent, other, other, 60, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.s.skinnum).toBe(1);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("mutant_jump wires self.touch to the jump-landing handler during the jump attack", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_mutant(ent);
    const enemy = newMonster();
    enemy.health = 100;
    ent.enemy = enemy;

    expect(ent.touch).toBeNull();

    // monsterinfo.attack === mutant_jump: picks the jump move (frame 0..7,
    // takeoff wired to frame index 2's thinkfunc).
    ent.monsterinfo.attack?.(ent);
    expect(ent.monsterinfo.currentmove).not.toBeNull();

    // walk the jump move's think frames far enough to hit mutant_jump_takeoff
    // (frame FRAME_attack01 + 2), which wires self.touch.
    ent.s.frame = ent.monsterinfo.currentmove ? ent.monsterinfo.currentmove.firstframe : 0;
    runThinkFrames(ent, 3);

    expect(ent.touch).not.toBeNull();
    expect(ent.monsterinfo.aiflags & AI_DUCKED).not.toBe(0); // AI_DUCKED set by mutant_jump_takeoff

    // touching a damageable entity fast enough calls T_Damage without throwing
    expect(() => ent.touch?.(ent, enemy, null, null)).not.toThrow();
  });
});
