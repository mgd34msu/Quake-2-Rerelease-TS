import { describe, expect, test } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { DamageT, DEAD_DEAD, EdictT, FL_IMMUNE_LASER, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/game/g_local";
import { monster_think } from "../src/game/g_monster";
import { SP_monster_tank } from "../src/game/m_tank";
import * as TANK_FRAME from "../src/game/m_tank_frames";
import { BossExplode, SP_monster_supertank } from "../src/game/m_supertank";
import * as SUPERTANK_FRAME from "../src/game/m_supertank_frames";
import { SP_monster_boss2 } from "../src/game/m_boss2";
import * as BOSS2_FRAME from "../src/game/m_boss2_frames";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/g_monster.test.ts's buildFakeImports.
// ---------------------------------------------------------------------------

function defaultTrace(end: Vec3): GTraceT {
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
    trace: (_start: Vec3, _mins: Vec3 | null, _maxs: Vec3 | null, end: Vec3, _passent: Edict | null) => defaultTrace(end),
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

// Large enough that BossExplode's gib-throwing branch (up to 14 ThrowGib/
// ThrowHead calls, each needing a free G_Spawn slot) never runs out.
const MAXENTITIES = 32;

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
}

function stepFrames(ent: EdictT, n: number): void {
  for (let i = 0; i < n; i++) {
    monster_think(ent);
    expect(Number.isFinite(ent.s.frame)).toBe(true);
    expect(Number.isNaN(ent.s.frame)).toBe(false);
  }
}

// ---------------------------------------------------------------------------

describe("SP_monster_tank", () => {
  test("sets health/mass/boxes and the stand move", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_tank";

    SP_monster_tank(self);

    expect(self.health).toBe(750);
    expect(self.gib_health).toBe(-200);
    expect(self.mass).toBe(500);
    expect(Array.from(self.mins)).toEqual([-32, -32, -16]);
    expect(Array.from(self.maxs)).toEqual([32, 32, 72]);
    expect(self.monsterinfo.currentmove).not.toBeNull();
    expect(self.monsterinfo.currentmove?.firstframe).toBe(TANK_FRAME.FRAME_stand01);
    expect(self.monsterinfo.currentmove?.lastframe).toBe(TANK_FRAME.FRAME_stand30);
  });

  test("monster_tank_commander classname raises health/gib_health and sets skinnum", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_tank_commander";

    SP_monster_tank(self);

    expect(self.health).toBe(1000);
    expect(self.gib_health).toBe(-225);
    expect(self.s.skinnum).toBe(2);
  });

  test("5 think frames advance s.frame without NaN", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_tank";
    SP_monster_tank(self);

    stepFrames(self, 5);
  });

  test("pain runs and toggles skinnum bit below half health", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_tank";
    SP_monster_tank(self);
    const other = g_edicts[2];

    self.health = self.max_health / 2 - 1;
    expect(self.pain).not.toBeNull();
    self.pain?.(self, other, 10, 40);

    expect(self.s.skinnum & 1).toBe(1);
    expect(self.monsterinfo.currentmove?.firstframe).toBe(TANK_FRAME.FRAME_pain201); // 30 < damage(40) <= 60
  });

  test("die at or below gib_health marks DEAD_DEAD but skips the death move (early return)", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_tank";
    SP_monster_tank(self);
    const standMove = self.monsterinfo.currentmove;

    self.health = self.gib_health; // <= gib_health triggers the gib branch
    expect(self.die).not.toBeNull();
    self.die?.(self, self, self, 500, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    // C's gib branch returns before assigning tank_move_death -- currentmove
    // is left exactly as it was.
    expect(self.monsterinfo.currentmove).toBe(standMove);
  });

  test("die above gib_health plays the death move and marks takedamage YES", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_tank";
    SP_monster_tank(self);

    self.health = self.gib_health + 1; // above gib_health: regular death path
    self.die?.(self, self, self, 20, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_YES);
    expect(self.monsterinfo.currentmove?.firstframe).toBe(TANK_FRAME.FRAME_death101);
  });
});

describe("SP_monster_supertank", () => {
  test("sets health/mass/boxes and the stand move", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_supertank";

    SP_monster_supertank(self);

    expect(self.health).toBe(1500);
    expect(self.gib_health).toBe(-500);
    expect(self.mass).toBe(800);
    expect(Array.from(self.mins)).toEqual([-64, -64, 0]);
    expect(Array.from(self.maxs)).toEqual([64, 64, 112]);
    expect(self.monsterinfo.currentmove?.firstframe).toBe(SUPERTANK_FRAME.FRAME_stand_1);
    expect(self.monsterinfo.currentmove?.lastframe).toBe(SUPERTANK_FRAME.FRAME_stand_60);
  });

  test("5 think frames advance s.frame without NaN", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_supertank";
    SP_monster_supertank(self);

    stepFrames(self, 5);
  });

  test("pain runs and picks the light-damage move", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_supertank";
    SP_monster_supertank(self);
    const other = g_edicts[2];

    // damage<=25 rolls `random()<0.2` to skip pain entirely; pin Math.random
    // high so this run deterministically falls through to the pain1 move.
    const origRandom = Math.random;
    Math.random = () => 0.9;
    try {
      self.pain?.(self, other, 5, 10); // damage <= 10 -> pain1
    } finally {
      Math.random = origRandom;
    }

    expect(self.monsterinfo.currentmove?.firstframe).toBe(SUPERTANK_FRAME.FRAME_pain1_1);
  });

  test("die sets DEAD_DEAD/DAMAGE_NO and the death move regardless of gib_health", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_supertank";
    SP_monster_supertank(self);

    self.health = self.gib_health; // C's supertank_die does not branch on gib_health
    self.die?.(self, self, self, 500, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_NO);
    expect(self.count).toBe(0);
    expect(self.monsterinfo.currentmove?.firstframe).toBe(SUPERTANK_FRAME.FRAME_death_1);
  });

  test("BossExplode's case-8 gib branch fires once count reaches 8, marking DEAD_DEAD", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_supertank";
    SP_monster_supertank(self);
    self.count = 8;

    BossExplode(self);

    expect(self.deadflag).toBe(DEAD_DEAD);
  });
});

describe("SP_monster_boss2", () => {
  test("sets health/mass/boxes, FL_IMMUNE_LASER, and the stand move", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_boss2";

    SP_monster_boss2(self);

    expect(self.health).toBe(2000);
    expect(self.gib_health).toBe(-200);
    expect(self.mass).toBe(1000);
    expect(Array.from(self.mins)).toEqual([-56, -56, 0]);
    expect(Array.from(self.maxs)).toEqual([56, 56, 80]);
    expect(self.flags & FL_IMMUNE_LASER).toBe(FL_IMMUNE_LASER);
    expect(self.monsterinfo.currentmove?.firstframe).toBe(BOSS2_FRAME.FRAME_stand30);
    expect(self.monsterinfo.currentmove?.lastframe).toBe(BOSS2_FRAME.FRAME_stand50);
  });

  test("5 think frames advance s.frame without NaN", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_boss2";
    SP_monster_boss2(self);

    stepFrames(self, 5);
  });

  test("pain runs and picks the heavy-damage move at damage >= 30", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_boss2";
    SP_monster_boss2(self);
    const other = g_edicts[2];

    self.pain?.(self, other, 5, 30);

    expect(self.monsterinfo.currentmove?.firstframe).toBe(BOSS2_FRAME.FRAME_pain2);
  });

  test("die sets DEAD_DEAD/DAMAGE_NO and the death move regardless of gib_health (C's gib branch is #if 0'd out)", () => {
    setupWorld();
    const self = g_edicts[1];
    self.classname = "monster_boss2";
    SP_monster_boss2(self);

    self.health = self.gib_health;
    self.die?.(self, self, self, 500, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_NO);
    expect(self.count).toBe(0);
    expect(self.monsterinfo.currentmove?.firstframe).toBe(BOSS2_FRAME.FRAME_death2);
  });
});
