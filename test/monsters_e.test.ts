// Tests for src/game/m_chick.ts, m_brain.ts, m_medic.ts, exercised through
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
import { SolidT, SVF_MONSTER } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { AI_MEDIC, DEAD_DEAD, EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/game/g_local";
import { monster_think } from "../src/game/g_monster";
import { SP_monster_chick } from "../src/game/m_chick";
import { SP_monster_brain } from "../src/game/m_brain";
import { SP_monster_medic } from "../src/game/m_medic";

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

describe("SP_monster_chick", () => {
  test("sets health/mass/boxes and a stand move", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_chick(ent);

    expect(ent.health).toBe(175);
    expect(ent.gib_health).toBe(-70);
    expect(ent.mass).toBe(200);
    expect(Array.from(ent.mins)).toEqual([-16, -16, 0]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 56]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.melee).not.toBeNull(); // chick has a slash melee, unlike medic
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("deathmatch frees the edict instead of spawning it", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const ent = newMonster();

    SP_monster_chick(ent);

    expect(ent.inuse).toBe(false);
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_chick(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_chick(ent);
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
    SP_monster_chick(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    expect(ent.die).not.toBeNull();
    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
  });

  test("die above gib_health sets a regular death move and DAMAGE_YES", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_chick(ent);
    ent.health = 0; // above gib_health (-70), not gibbed
    const other = newMonster();

    ent.die?.(ent, other, other, 60, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.takedamage).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });
});

describe("SP_monster_brain", () => {
  test("sets health/mass/boxes, a stand move, and power-armor-screen defaults", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_brain(ent);

    expect(ent.health).toBe(300);
    expect(ent.gib_health).toBe(-150);
    expect(ent.mass).toBe(400);
    expect(Array.from(ent.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ent.maxs)).toEqual([16, 16, 32]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.attack).toBeNull(); // C leaves monsterinfo.attack commented out
    expect(ent.monsterinfo.melee).not.toBeNull();
    expect(ent.monsterinfo.power_armor_power).toBe(100);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_brain(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_brain(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    ent.pain?.(ent, other, 0, 10);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die below gib_health throws gibs and sets DEAD_DEAD", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_brain(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
  });

  test("die above gib_health sets a regular death move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_brain(ent);
    ent.health = 0; // above gib_health (-150), not gibbed
    const other = newMonster();

    ent.die?.(ent, other, other, 60, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.takedamage).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });
});

describe("SP_monster_medic", () => {
  test("sets health/mass/boxes and a stand move", () => {
    setupWorld();
    const ent = newMonster();

    SP_monster_medic(ent);

    expect(ent.health).toBe(300);
    expect(ent.gib_health).toBe(-130);
    expect(ent.mass).toBe(400);
    expect(Array.from(ent.mins)).toEqual([-24, -24, -24]);
    expect(Array.from(ent.maxs)).toEqual([24, 24, 32]);
    expect(ent.monsterinfo.stand).not.toBeNull();
    expect(ent.monsterinfo.melee).toBeNull(); // medic has no melee attack
    expect(ent.monsterinfo.checkattack).not.toBeNull(); // medic overrides M_CheckAttack for the cable attack
    expect(ent.monsterinfo.currentmove).not.toBeNull();
  });

  test("deathmatch frees the edict instead of spawning it", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const ent = newMonster();

    SP_monster_medic(ent);

    expect(ent.inuse).toBe(false);
  });

  test("5 think frames produce no NaN state", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_medic(ent);

    runThinkFrames(ent, 5);
  });

  test("pain sets pain_debounce_time and picks a pain move", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_medic(ent);
    const standMove = ent.monsterinfo.currentmove;
    const other = newMonster();

    ent.pain?.(ent, other, 0, 10);

    expect(ent.pain_debounce_time).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBe(standMove);
  });

  test("die below gib_health throws gibs and sets DEAD_DEAD", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_medic(ent);
    ent.health = ent.gib_health - 1;
    const other = newMonster();

    ent.die?.(ent, other, other, 40, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
  });

  test("die above gib_health sets a regular death move and frees a pending patient's owner", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_medic(ent);
    ent.health = 0; // above gib_health (-130), not gibbed
    const patient = newMonster();
    patient.owner = ent;
    ent.enemy = patient;
    const other = newMonster();

    ent.die?.(ent, other, other, 60, vec3());

    expect(ent.deadflag).toBe(DEAD_DEAD);
    expect(ent.takedamage).toBeGreaterThan(0);
    expect(ent.monsterinfo.currentmove).not.toBeNull();
    expect(patient.owner).toBeNull(); // medic_die frees the pending patient for another medic
  });

  test("medic_idle (monsterinfo.idle) finds a healable dead monster in radius and claims it via FoundTarget", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_medic(ent);

    // a fabricated corpse: a real monster (SVF_MONSTER), dead (health <= 0,
    // nextthink 0, not already owned), within medic_FindDeadMonster's 1024
    // unit radius, and visible under the fake trace (fraction 1 always).
    const corpse = newMonster();
    corpse.svflags |= SVF_MONSTER;
    corpse.health = -10;
    corpse.max_health = 100;
    corpse.nextthink = 0;
    corpse.owner = null;
    corpse.s.origin[0] = 100;

    expect(ent.monsterinfo.idle).not.toBeNull();
    ent.monsterinfo.idle?.(ent);

    expect(ent.enemy).toBe(corpse);
    expect(corpse.owner === ent).toBe(true);
    expect((ent.monsterinfo.aiflags & AI_MEDIC) !== 0).toBe(true);
  });

  test("medic_idle ignores a corpse outside the 1024 unit radius", () => {
    setupWorld();
    const ent = newMonster();
    SP_monster_medic(ent);

    const corpse = newMonster();
    corpse.svflags |= SVF_MONSTER;
    corpse.health = -10;
    corpse.max_health = 100;
    corpse.nextthink = 0;
    corpse.s.origin[0] = 2000; // outside medic_FindDeadMonster's 1024 radius

    ent.monsterinfo.idle?.(ent);

    expect(ent.enemy).toBeNull();
    expect((ent.monsterinfo.aiflags & AI_MEDIC) !== 0).toBe(false);
  });
});
