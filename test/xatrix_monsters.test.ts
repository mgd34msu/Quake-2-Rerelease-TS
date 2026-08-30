// Tests for src/xatrix/m_boss5.ts, m_gladb.ts, m_fixbot.ts, m_gekk.ts,
// exercised through the real GetGameAPI(...) boundary (src/xatrix/g_main.ts)
// with a fake GameImports, per .orch/preferences.md rule 13. Self-sufficient:
// this file builds its own fake world and never depends on another test file
// having run first (modeled on test/monsters_g.test.ts's setupWorld).
//
// "Validate every mmove table constructs cleanly" (per this unit's brief) is
// satisfied by the plain `import` statements below: MmoveT's `frame` setter
// (src/xatrix/g_local.ts, mirroring src/game/g_local.ts) validates
// frames.length === lastframe - firstframe + 1 the moment a table is
// assigned, which happens at module load for every mmove_t table declared in
// m_boss5.ts/m_gladb.ts/m_fixbot.ts/m_gekk.ts -- a bad table throws before
// any test body runs.

import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/xatrix/game";
import { GetGameAPI } from "../src/xatrix/g_main";
import { EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/xatrix/g_local";
import { monster_think } from "../src/xatrix/g_monster";
import { SP_monster_boss5 } from "../src/xatrix/m_boss5";
import { FRAME_death_1, FRAME_death_24 } from "../src/xatrix/m_boss5_frames";
import { SP_monster_gladb } from "../src/xatrix/m_gladb";
import { FRAME_stand1, FRAME_stand7 } from "../src/xatrix/m_gladb_frames";
import { SP_monster_fixbot } from "../src/xatrix/m_fixbot";
import { FRAME_ambient_01, FRAME_ambient_19 } from "../src/xatrix/m_fixbot_frames";
import { SP_monster_gekk } from "../src/xatrix/m_gekk";
import { FRAME_stand_01, FRAME_stand_39 } from "../src/xatrix/m_gekk_frames";

// ---------------------------------------------------------------------------
// fake GameImports: a fixed no-collision trace, everything else a no-op.
// Modeled after test/monsters_g.test.ts's buildFakeImports/setupWorld.
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
    soundindex: () => 1,
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

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 64;

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
  globals.max_edicts = MAXENTITIES;
  globals.edicts = edicts;

  // Self-sufficient per rule 13: never rely on another test file's cvar state.
  gameCvars.maxclients = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);

  nextEdictIndex = 10; // past maxclients(1) + BODY_QUEUE_SIZE(8)
}

function noNaN(v: Float32Array): boolean {
  return Array.from(v).every((n) => Number.isFinite(n));
}

// allocate real slots out of g_edicts (not detached `new EdictT()`s), matching
// a live spawn -- see test/monsters_g.test.ts's identical idiom.
let nextEdictIndex = 10;
function newSlot(): EdictT {
  const ent = g_edicts[nextEdictIndex++];
  ent.inuse = true;
  return ent;
}

// ---------------------------------------------------------------------------

describe("monster_boss5 (xatrix variant of supertank)", () => {
  test("SP_monster_boss5 sets health/mass/boxes/stand plus the RAFAEL power-armor fields supertank lacks", () => {
    setupWorld();
    const self = newSlot();

    SP_monster_boss5(self);

    expect(self.health).toBe(1500);
    expect(self.gib_health).toBe(-500);
    expect(self.mass).toBe(800);
    expect(Array.from(self.mins)).toEqual([-64, -64, 0]);
    expect(Array.from(self.maxs)).toEqual([64, 64, 112]);
    expect(self.monsterinfo.power_armor_type).toBe(2); // POWER_ARMOR_SHIELD
    expect(self.monsterinfo.power_armor_power).toBe(400);

    expect(self.monsterinfo.stand).not.toBeNull();
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
  });

  test("die sets the death move (FRAME_death_1..24)", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_boss5(self);

    self.die?.(self, self, self, 500, vec3());

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_death_1);
    expect(move.lastframe).toBe(FRAME_death_24);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_boss5(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("monster_gladb (xatrix variant of gladiator)", () => {
  test("SP_monster_gladb sets health/mass/boxes/stand plus the RAFAEL power-armor fields gladiator lacks", () => {
    setupWorld();
    const self = newSlot();

    SP_monster_gladb(self);

    expect(self.health).toBe(800); // gladiator is 400
    expect(self.gib_health).toBe(-175);
    expect(self.mass).toBe(350); // gladiator is 400
    expect(Array.from(self.mins)).toEqual([-32, -32, -24]);
    expect(Array.from(self.maxs)).toEqual([32, 32, 64]);
    expect(self.monsterinfo.power_armor_type).toBe(2); // POWER_ARMOR_SHIELD
    expect(self.monsterinfo.power_armor_power).toBe(400);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_stand1);
    expect(move.lastframe).toBe(FRAME_stand7);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_gladb(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("monster_fixbot", () => {
  test("SP_monster_fixbot sets health/mass/boxes/stand", () => {
    setupWorld();
    const self = newSlot();

    SP_monster_fixbot(self);

    expect(self.health).toBe(150);
    expect(self.mass).toBe(150);
    expect(Array.from(self.mins)).toEqual([-32, -32, -24]);
    expect(Array.from(self.maxs)).toEqual([32, 32, 24]);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_ambient_01);
    expect(move.lastframe).toBe(FRAME_ambient_19);
  });

  test("5 think frames produce no NaN in origin/angles (flymonster_start path)", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_fixbot(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("monster_gekk", () => {
  test("SP_monster_gekk sets health/mass/boxes/stand", () => {
    setupWorld();
    const self = newSlot();

    SP_monster_gekk(self);

    expect(self.health).toBe(125);
    expect(self.gib_health).toBe(-30);
    expect(self.mass).toBe(300);
    expect(Array.from(self.mins)).toEqual([-24, -24, -24]);
    expect(Array.from(self.maxs)).toEqual([24, 24, 24]);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_stand_01);
    expect(move.lastframe).toBe(FRAME_stand_39);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_gekk(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });
});
