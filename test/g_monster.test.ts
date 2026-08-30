import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, YAW } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  AI_HOLD_FRAME,
  EdictT,
  FL_FLY,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  MframeT,
  MmoveT,
  SetGEdicts,
} from "../src/game/g_local";
import { AttackFinished, M_CheckGround, monster_think } from "../src/game/g_monster";
import { M_ChangeYaw, M_walkmove } from "../src/game/m_move";

// ---------------------------------------------------------------------------
// fake GameImports: a per-test trace function, everything else a no-op.
// Modeled after test/g_spawn.test.ts's buildFakeImports/setupWorld.
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

const MAXENTITIES = 16;

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
}

// ---------------------------------------------------------------------------

describe("M_ChangeYaw", () => {
  test("converges toward ideal_yaw, clamped by yaw_speed", () => {
    setupWorld();
    const ent = new EdictT();
    ent.s.angles[YAW] = 10;
    ent.ideal_yaw = 100;
    ent.yaw_speed = 30;

    M_ChangeYaw(ent);

    // anglemod quantizes to a 16-bit angle (360/65536 per step), so this is
    // "clamped by yaw_speed" (move=90 clamped to 30, 10+30=40) within that step.
    expect(ent.s.angles[YAW]).toBeCloseTo(40, 1);
  });

  test("wraps around the 0/360 boundary taking the shorter path", () => {
    setupWorld();
    const ent = new EdictT();
    ent.s.angles[YAW] = 350;
    ent.ideal_yaw = 10;
    ent.yaw_speed = 100; // large enough to reach ideal in one step

    M_ChangeYaw(ent);

    expect(ent.s.angles[YAW]).toBeCloseTo(10, 1); // shorter path is +20 through 360, not -340
  });

  test("is a no-op once current equals ideal_yaw", () => {
    setupWorld();
    const ent = new EdictT();
    // 90 is an exact multiple of anglemod's 360/65536 quantization step, so
    // anglemod(90) === 90 and the current === ideal early-return actually fires.
    ent.s.angles[YAW] = 90;
    ent.ideal_yaw = 90;
    ent.yaw_speed = 45;

    M_ChangeYaw(ent);

    expect(ent.s.angles[YAW]).toBe(90);
  });
});

describe("M_CheckGround", () => {
  test("airborne (velocity[2] > 100) clears groundentity without tracing", () => {
    setupWorld();
    const ent = new EdictT();
    ent.groundentity = g_edicts[1];
    ent.velocity[2] = 150;

    M_CheckGround(ent);

    expect(ent.groundentity).toBeNull();
  });

  test("a shallow-normal (steep slope) trace clears groundentity", () => {
    setupWorld((_start, _mins, _maxs, end) => ({
      allsolid: false,
      startsolid: false,
      fraction: 0.5,
      endpos: vec3(end[0], end[1], end[2]),
      plane: (() => {
        const p = new CplaneT();
        p.normal[2] = 0.5; // steeper than the 0.7 cutoff
        return p;
      })(),
      surface: null,
      contents: 0,
      ent: null,
    }));
    const ent = new EdictT();
    ent.groundentity = g_edicts[1];

    M_CheckGround(ent);

    expect(ent.groundentity).toBeNull();
  });

  test("a flat floor trace sets groundentity, snaps origin to endpos, and zeroes vertical velocity", () => {
    setupWorld((_start, _mins, _maxs, end) => ({
      allsolid: false,
      startsolid: false,
      fraction: 0.9,
      endpos: vec3(end[0], end[1], end[2] + 0.25), // cancels the -0.25 probe offset back to origin height
      plane: (() => {
        const p = new CplaneT();
        p.normal[2] = 1;
        return p;
      })(),
      surface: null,
      contents: 0,
      ent: g_edicts[2],
    }));
    g_edicts[2].linkcount = 5;

    const ent = new EdictT();
    ent.s.origin.set([10, 20, 30]);
    ent.velocity[2] = -40;

    M_CheckGround(ent);

    expect(ent.groundentity).toBe(g_edicts[2]);
    expect(ent.groundentity_linkcount).toBe(5);
    expect(ent.velocity[2]).toBe(0);
    expect(Array.from(ent.s.origin)).toEqual([10, 20, 30]);
  });
});

describe("monster_think / M_MoveFrame", () => {
  test("walks frames, scales aifunc dist by monsterinfo.scale, and fires endfunc at lastframe before wrapping", () => {
    setupWorld();
    const ent = new EdictT();
    ent.health = 100; // keep M_WorldEffects/M_SetEffects on their harmless paths
    ent.monsterinfo.scale = 2;

    const aifuncCalls: number[] = [];
    const aifunc = (_self: EdictT, dist: number): void => {
      aifuncCalls.push(dist);
    };

    const f1 = new MframeT();
    f1.dist = 5;
    f1.aifunc = aifunc;
    const f2 = new MframeT();
    f2.dist = 7;
    f2.aifunc = aifunc;
    const f3 = new MframeT();
    f3.dist = 9;
    f3.aifunc = aifunc;

    let endfuncCalls = 0;
    const move = new MmoveT();
    move.firstframe = 1;
    move.lastframe = 3;
    move.frame = [f1, f2, f3];
    move.endfunc = () => {
      endfuncCalls++;
    };

    ent.monsterinfo.currentmove = move;
    ent.s.frame = move.firstframe;

    monster_think(ent); // frame 1 -> 2, aifunc(dist=7*2=14)
    expect(ent.s.frame).toBe(2);
    expect(aifuncCalls).toEqual([14]);
    expect(endfuncCalls).toBe(0);

    monster_think(ent); // frame 2 -> 3, aifunc(dist=9*2=18)
    expect(ent.s.frame).toBe(3);
    expect(aifuncCalls).toEqual([14, 18]);
    expect(endfuncCalls).toBe(0);

    monster_think(ent); // at lastframe: endfunc fires, then wraps 3->4->firstframe(1), aifunc(dist=5*2=10)
    expect(endfuncCalls).toBe(1);
    expect(ent.s.frame).toBe(1);
    expect(aifuncCalls).toEqual([14, 18, 10]);
  });

  test("AI_HOLD_FRAME holds the current frame and calls aifunc with dist 0", () => {
    setupWorld();
    const ent = new EdictT();
    ent.health = 100;
    ent.monsterinfo.scale = 3;
    ent.monsterinfo.aiflags = AI_HOLD_FRAME;

    const aifuncCalls: number[] = [];
    const f1 = new MframeT();
    f1.dist = 5;
    f1.aifunc = (_self, dist) => aifuncCalls.push(dist);

    const move = new MmoveT();
    move.firstframe = 1;
    move.lastframe = 1;
    move.frame = [f1];

    ent.monsterinfo.currentmove = move;
    ent.s.frame = 1;

    monster_think(ent);
    monster_think(ent);

    expect(ent.s.frame).toBe(1); // held, never advances
    expect(aifuncCalls).toEqual([0, 0]); // held frames call aifunc with dist 0, not dist*scale
  });
});

describe("M_walkmove", () => {
  test("returns false immediately when airborne and not flying/swimming", () => {
    setupWorld();
    const ent = new EdictT();
    ent.groundentity = null;

    expect(M_walkmove(ent, 0, 50)).toBe(false);
  });

  test("moves the entity along the given yaw/dist when the trace returns fraction 1 (flying monster)", () => {
    setupWorld((_start, _mins, _maxs, end) => ({
      allsolid: false,
      startsolid: false,
      fraction: 1,
      endpos: vec3(end[0], end[1], end[2]),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: null,
    }));
    const ent = new EdictT();
    ent.flags |= FL_FLY; // bypasses the groundentity requirement and takes the simple move-or-nothing path
    ent.s.origin.set([100, 100, 100]);

    const moved = M_walkmove(ent, 0, 50); // yaw 0 -> along +X

    expect(moved).toBe(true);
    expect(ent.s.origin[0]).toBeCloseTo(150, 5);
    expect(ent.s.origin[1]).toBeCloseTo(100, 5);
    expect(ent.s.origin[2]).toBeCloseTo(100, 5);
  });
});

describe("AttackFinished", () => {
  test("sets monsterinfo.attack_finished to level.time + time", () => {
    setupWorld();
    level.time = 12.5;
    const ent = new EdictT();

    AttackFinished(ent, 2.5);

    expect(ent.monsterinfo.attack_finished).toBe(15);
  });
});
