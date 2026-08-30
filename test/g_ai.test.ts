import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, YAW } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI, G_RunFrame } from "../src/game/g_main";
import {
  AI_STAND_GROUND,
  EdictT,
  FL_NOTARGET,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
  SetGEdicts,
} from "../src/game/g_local";
import { AI_SetSightClient, ai_checkattack, ai_stand, infront, range, visible } from "../src/game/g_ai";

// ---------------------------------------------------------------------------
// fake GameImports: a per-test trace function, everything else a no-op.
// Modeled after test/g_monster.test.ts's buildFakeImports/setupWorld (see
// .orch/preferences.md rule 13: every suite initializes its own globals via
// GetGameAPI(fakeImports), never relying on another test file having run).
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

const MAXENTITIES = 16;

function setupWorld(traceFn?: TraceFn): void {
  GetGameAPI(buildFakeImports(traceFn));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 4;
  game.maxentities = MAXENTITIES;

  level.clear();

  // gameCvars is a shared module-level singleton across every test file in
  // this run; reset it so a cvar set by an earlier-run file (e.g.
  // gameCvars.maxclients) can't leak into G_RunFrame's client-range check.
  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }

  globals.num_edicts = MAXENTITIES;
}

// ---------------------------------------------------------------------------

describe("range", () => {
  test("bands distance into RANGE_MELEE/NEAR/MID/FAR", () => {
    setupWorld();
    const self = new EdictT();
    const other = new EdictT();

    self.s.origin.set([0, 0, 0]);

    other.s.origin.set([50, 0, 0]); // < MELEE_DISTANCE (80)
    expect(range(self, other)).toBe(RANGE_MELEE);

    other.s.origin.set([200, 0, 0]); // < 500
    expect(range(self, other)).toBe(RANGE_NEAR);

    other.s.origin.set([700, 0, 0]); // < 1000
    expect(range(self, other)).toBe(RANGE_MID);

    other.s.origin.set([1500, 0, 0]); // >= 1000
    expect(range(self, other)).toBe(RANGE_FAR);
  });
});

describe("infront", () => {
  test("true for a target ahead of self's facing (dot > 0.3)", () => {
    setupWorld();
    const self = new EdictT();
    self.s.origin.set([0, 0, 0]);
    self.s.angles.set([0, 0, 0]); // facing +X

    const other = new EdictT();
    other.s.origin.set([100, 0, 0]); // straight ahead

    expect(infront(self, other)).toBe(true);
  });

  test("false for a target behind self's facing", () => {
    setupWorld();
    const self = new EdictT();
    self.s.origin.set([0, 0, 0]);
    self.s.angles.set([0, 0, 0]); // facing +X

    const other = new EdictT();
    other.s.origin.set([-100, 0, 0]); // directly behind

    expect(infront(self, other)).toBe(false);
  });
});

describe("visible", () => {
  test("true when the trace reaches the target unobstructed (fraction 1)", () => {
    setupWorld(() => ({
      allsolid: false,
      startsolid: false,
      fraction: 1,
      endpos: vec3(),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: null,
    }));
    const self = new EdictT();
    const other = new EdictT();
    other.s.origin.set([500, 0, 0]);

    expect(visible(self, other)).toBe(true);
  });

  test("false when the trace is blocked (fraction < 1)", () => {
    setupWorld(() => ({
      allsolid: false,
      startsolid: false,
      fraction: 0.4,
      endpos: vec3(),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: null,
    }));
    const self = new EdictT();
    const other = new EdictT();
    other.s.origin.set([500, 0, 0]);

    expect(visible(self, other)).toBe(false);
  });
});

describe("AI_SetSightClient", () => {
  test("picks the first inuse client with health > 0 that isn't notarget", () => {
    setupWorld();
    // g_edicts[1..4] are the clients (game.maxclients = 4).
    for (let i = 1; i <= 4; i++) {
      g_edicts[i].inuse = true;
      g_edicts[i].health = 100;
    }
    g_edicts[1].health = 0; // dead, skipped
    g_edicts[2].flags |= FL_NOTARGET; // notarget, skipped
    // g_edicts[3] is the first eligible candidate.

    level.sight_client = null;

    AI_SetSightClient();

    expect(level.sight_client === g_edicts[3]).toBe(true);
  });

  test("skips a notarget client even if it is the only other candidate", () => {
    setupWorld();
    for (let i = 1; i <= 4; i++) {
      g_edicts[i].inuse = false;
    }
    g_edicts[2].inuse = true;
    g_edicts[2].health = 50;
    g_edicts[2].flags |= FL_NOTARGET;

    level.sight_client = null;

    AI_SetSightClient();

    expect(level.sight_client).toBeNull();
  });

  test("leaves sight_client null when nobody is eligible", () => {
    setupWorld();
    level.sight_client = null;

    AI_SetSightClient();

    expect(level.sight_client).toBeNull();
  });
});

describe("ai_stand", () => {
  test("with no AI_STAND_GROUND, no enemy, and pausetime already passed, calls monsterinfo.walk", () => {
    setupWorld();
    const self = new EdictT();
    self.s.number = 5;
    g_edicts[5] = self;
    level.time = 10;
    self.monsterinfo.pausetime = 0; // level.time > pausetime

    let walked = false;
    self.monsterinfo.walk = () => {
      walked = true;
    };

    // FindTarget/ai_stand's non-heard/non-sight paths may reach into
    // p_trail.c-style sibling stubs in other AI functions, but ai_stand's
    // own "no enemy" branch only calls FindTarget then monsterinfo.walk --
    // assert-and-log the PendingPort case defensively in case a future
    // sibling wiring changes that.
    let threw: unknown;
    try {
      ai_stand(self, 0);
    } catch (err) {
      threw = err;
    }

    if (threw !== undefined) throw threw; // no pending stubs remain; any throw is a real bug
    expect(walked).toBe(true);
  });

  test("with AI_STAND_GROUND and an enemy, turns toward the enemy and runs ai_checkattack", () => {
    setupWorld();
    const self = new EdictT();
    self.s.number = 5;
    g_edicts[5] = self;
    self.monsterinfo.aiflags |= AI_STAND_GROUND;
    self.yaw_speed = 1000; // snap directly to ideal_yaw in one M_ChangeYaw step

    const enemy = new EdictT();
    enemy.s.number = 6;
    enemy.inuse = true;
    enemy.health = 100;
    enemy.s.origin.set([100, 0, 0]);
    g_edicts[6] = enemy;

    self.enemy = enemy;

    let threw: unknown;
    try {
      ai_stand(self, 0);
    } catch (err) {
      threw = err;
    }

    if (threw !== undefined) throw threw; // no pending stubs remain; any throw is a real bug
    {
      // ideal_yaw points from self (0,0,0) toward enemy (100,0,0): straight
      // along +X, i.e. yaw 0.
      expect(self.ideal_yaw).toBeCloseTo(0, 1);
      expect(self.s.angles[YAW]).toBeCloseTo(0, 1);
    }
  });
});

describe("ai_checkattack", () => {
  test("revives oldenemy via HuntTarget when the current enemy is dead (falls through, does not return early)", () => {
    setupWorld();
    const self = new EdictT();
    self.s.number = 5;
    g_edicts[5] = self;

    const deadEnemy = new EdictT();
    deadEnemy.inuse = true;
    deadEnemy.health = 0;
    self.enemy = deadEnemy;

    const oldenemy = new EdictT();
    oldenemy.inuse = true;
    oldenemy.health = 50;
    self.oldenemy = oldenemy;

    let ranHunt = false;
    self.monsterinfo.run = () => {
      ranHunt = true;
    };

    // C's hesDeadJim/oldenemy branch calls HuntTarget but does NOT return
    // early -- only the "no oldenemy" else branch returns true immediately.
    // Execution falls through to the visibility/attack-state checks below,
    // ending at `return self.monsterinfo.checkattack(self)` (false here,
    // since no checkattack callback is wired up).
    const result = ai_checkattack(self, 0);

    expect(result).toBe(false);
    expect(self.enemy).toBe(oldenemy);
    expect(self.oldenemy).toBeNull();
    expect(ranHunt).toBe(true);
  });

  test("returns true immediately and switches to walk/stand when the enemy is dead with no oldenemy to revive", () => {
    setupWorld();
    const self = new EdictT();
    self.s.number = 5;
    g_edicts[5] = self;

    const deadEnemy = new EdictT();
    deadEnemy.inuse = true;
    deadEnemy.health = 0;
    self.enemy = deadEnemy;
    self.oldenemy = null;

    let stood = false;
    self.monsterinfo.stand = () => {
      stood = true;
    };

    const result = ai_checkattack(self, 0);

    expect(result).toBe(true);
    expect(self.enemy).toBeNull();
    expect(stood).toBe(true);
    expect(self.monsterinfo.pausetime).toBeGreaterThan(level.time);
  });
});

describe("G_RunFrame end-to-end", () => {
  test("completes a full frame over a small fabricated world of non-monster, non-client edicts", () => {
    setupWorld();
    game.maxclients = 0; // no client-range edicts in this fabricated world

    const edicts: EdictT[] = Array.from({ length: 4 }, () => new EdictT());
    edicts.forEach((e, i) => {
      e.s.number = i;
      e.inuse = i !== 0; // world (0) stays not-inuse for this test
    });
    SetGEdicts(edicts);
    globals.num_edicts = edicts.length;

    const beforeFrame = level.framenum;

    expect(() => G_RunFrame()).not.toThrow();

    expect(level.framenum).toBe(beforeFrame + 1);
    expect(level.sight_client).toBeNull(); // no clients exist to pick
  });
});
