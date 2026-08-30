import { describe, expect, test } from "bun:test";
import {
  ClipVelocity,
  SV_AddGravity,
  SV_CheckVelocity,
  SV_FlyMove,
  SV_Physics_Pusher,
  SV_Physics_Step,
  SV_Physics_Toss,
  SV_RunThink,
} from "../src/game/g_phys";
import { EdictT, FRAMETIME, MovetypeT, SetGameExports, SetGameImports, SetGEdicts, gameCvars, level } from "../src/game/g_local";
import { LinkT, SolidT, type Edict, type GameExports, type GameImports, type GTraceT } from "../src/game/game";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { type Vec3, vec3 } from "../src/shared/math";

// ---------------------------------------------------------------------------
// A fabricated GameImports: gi.trace defaults to "fraction 1, nothing hit"
// unless a per-test trace function is supplied; gi.linkentity records every
// call; gi.pointcontents defaults to CONTENTS_EMPTY (0).
// ---------------------------------------------------------------------------

type TraceFn = (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: Edict | null) => GTraceT;

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

function makeFakeGameImports(traceFn?: TraceFn): { gi: GameImports; linkCalls: Edict[] } {
  const linkCalls: Edict[] = [];
  const fakeGi: GameImports = {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string) => {
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
    linkentity: (ent) => {
      linkCalls.push(ent);
    },
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
  return { gi: fakeGi, linkCalls };
}

function makeFakeGameExports(edicts: EdictT[]): GameExports {
  return {
    apiversion: 3,
    Init: () => {},
    Shutdown: () => {},
    SpawnEntities: () => {},
    WriteGame: () => {},
    ReadGame: () => {},
    WriteLevel: () => {},
    ReadLevel: () => {},
    ClientConnect: (_ent: Edict, userinfo: string) => ({ allowed: true, userinfo }),
    ClientBegin: () => {},
    ClientUserinfoChanged: () => {},
    ClientDisconnect: () => {},
    ClientCommand: () => {},
    ClientThink: () => {},
    RunFrame: () => {},
    ServerCommand: () => {},
    edicts,
    num_edicts: edicts.length,
    max_edicts: edicts.length,
  };
}

function setCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

describe("SV_CheckVelocity", () => {
  test("clamps velocity to sv_maxvelocity in both the positive and negative direction", () => {
    gameCvars.sv_maxvelocity = setCvar(2000);

    const ent = new EdictT();
    ent.velocity[0] = 5000;
    ent.velocity[1] = -5000;
    ent.velocity[2] = 100; // within range, untouched

    SV_CheckVelocity(ent);

    expect(ent.velocity[0]).toBe(2000);
    expect(ent.velocity[1]).toBe(-2000);
    expect(ent.velocity[2]).toBe(100);
  });
});

describe("SV_AddGravity", () => {
  test("lowers velocity[2] by ent.gravity * sv_gravity.value * FRAMETIME", () => {
    gameCvars.sv_gravity = setCvar(800);

    const ent = new EdictT();
    ent.gravity = 1;
    ent.velocity[2] = 0;

    SV_AddGravity(ent);

    expect(ent.velocity[2]).toBeCloseTo(-800 * FRAMETIME, 5);
  });

  test("scales by the entity's own gravity multiplier", () => {
    gameCvars.sv_gravity = setCvar(800);

    const ent = new EdictT();
    ent.gravity = 0.5;
    ent.velocity[2] = 0;

    SV_AddGravity(ent);

    expect(ent.velocity[2]).toBeCloseTo(-400 * FRAMETIME, 5);
  });
});

describe("SV_RunThink", () => {
  test("invokes think() and clears nextthink once level.time reaches it", () => {
    level.time = 10;
    const ent = new EdictT();
    ent.nextthink = 10;
    const calledWith: { value: EdictT | null } = { value: null };
    ent.think = (self) => {
      calledWith.value = self;
    };

    const result = SV_RunThink(ent);

    expect(result).toBe(false);
    expect(calledWith.value).toBe(ent);
    expect(ent.nextthink).toBe(0);
  });

  test("does nothing and returns true when nextthink is still in the future", () => {
    level.time = 10;
    const ent = new EdictT();
    ent.nextthink = 20;
    ent.think = () => {
      throw new Error("think should not run yet");
    };

    const result = SV_RunThink(ent);

    expect(result).toBe(true);
    expect(ent.nextthink).toBe(20);
  });

  test("does nothing and returns true when nextthink <= 0", () => {
    level.time = 10;
    const ent = new EdictT();
    ent.nextthink = 0;

    expect(SV_RunThink(ent)).toBe(true);
  });
});

describe("SV_FlyMove", () => {
  test("a floor-plane hit sets groundentity (for a SOLID_BSP hit) and zeroes downward velocity", () => {
    const worldEdict = new EdictT();
    const groundEdict = new EdictT();
    groundEdict.s.number = 1;
    groundEdict.solid = SolidT.SOLID_BSP;
    groundEdict.linkcount = 7;
    SetGEdicts([worldEdict, groundEdict]);

    const floorPlane = new CplaneT();
    floorPlane.normal[2] = 1;

    const { gi: fakeGi } = makeFakeGameImports((_start, _mins, _maxs, end) => ({
      allsolid: false,
      startsolid: false,
      fraction: 0,
      endpos: vec3(end[0], end[1], end[2]),
      plane: floorPlane,
      surface: null,
      contents: 0,
      ent: groundEdict,
    }));
    SetGameImports(fakeGi);

    const ent = new EdictT();
    ent.inuse = true;
    ent.velocity[2] = -100;

    const blocked = SV_FlyMove(ent, FRAMETIME, 1);

    expect(blocked & 1).toBe(1); // floor
    expect(ent.groundentity).toBe(groundEdict);
    expect(ent.velocity[2]).toBe(0);
  });

  test("a full-fraction trace (nothing hit) leaves velocity untouched and returns unblocked", () => {
    SetGEdicts([new EdictT()]);
    const { gi: fakeGi } = makeFakeGameImports();
    SetGameImports(fakeGi);

    const ent = new EdictT();
    ent.velocity[0] = 50;

    const blocked = SV_FlyMove(ent, FRAMETIME, 1);

    expect(blocked).toBe(0);
    expect(ent.velocity[0]).toBe(50);
    expect(ent.s.origin[0]).toBeCloseTo(50 * FRAMETIME, 5);
  });
});

describe("ClipVelocity", () => {
  test("zeroes the component into a floor plane and flags 'floor'", () => {
    const out = vec3();
    const blocked = ClipVelocity(vec3(0, 0, -100), vec3(0, 0, 1), out, 1);

    expect(blocked & 1).toBe(1);
    expect(out[2]).toBe(0);
  });
});

describe("SV_Physics_Toss", () => {
  function setupWorld(traceFn?: TraceFn): void {
    const { gi: fakeGi } = makeFakeGameImports(traceFn);
    SetGameImports(fakeGi);
    SetGEdicts([new EdictT()]);
    gameCvars.sv_maxvelocity = setCvar(2000);
    gameCvars.sv_gravity = setCvar(800);
  }

  test("integrates position linearly along velocity when the push trace never hits anything", () => {
    setupWorld();
    const ent = new EdictT();
    ent.inuse = true; // a live toss entity; exercises SV_PushEntity's G_TouchTriggers call too
    ent.movetype = MovetypeT.MOVETYPE_FLY; // no gravity, isolates the integration math
    ent.velocity[0] = 100;

    SV_Physics_Toss(ent);

    expect(ent.s.origin[0]).toBeCloseTo(100 * FRAMETIME, 5);
  });

  test("MOVETYPE_TOSS gains gravity in a single frame, MOVETYPE_FLY does not", () => {
    setupWorld();

    const tossEnt = new EdictT();
    tossEnt.inuse = true;
    tossEnt.movetype = MovetypeT.MOVETYPE_TOSS;
    tossEnt.gravity = 1;
    SV_Physics_Toss(tossEnt);
    expect(tossEnt.velocity[2]).toBeLessThan(0);

    const flyEnt = new EdictT();
    flyEnt.inuse = true;
    flyEnt.movetype = MovetypeT.MOVETYPE_FLY;
    flyEnt.gravity = 1;
    SV_Physics_Toss(flyEnt);
    expect(flyEnt.velocity[2]).toBe(0);
  });
});

describe("SV_Physics_Step", () => {
  test("a falling MOVETYPE_STEP monster gains groundentity and zeroes vertical velocity when M_CheckGround's floor trace hits solid ground", () => {
    const worldEdict = new EdictT();
    const groundEdict = new EdictT();
    groundEdict.s.number = 1;
    groundEdict.linkcount = 3;
    SetGEdicts([worldEdict, groundEdict]);

    const floorPlane = new CplaneT();
    floorPlane.normal[2] = 1;

    const { gi: fakeGi } = makeFakeGameImports((_start, _mins, _maxs, end) => ({
      allsolid: false,
      startsolid: false,
      fraction: 0,
      endpos: vec3(end[0], end[1], end[2]),
      plane: floorPlane,
      surface: null,
      contents: 0,
      ent: groundEdict,
    }));
    SetGameImports(fakeGi);
    SetGameExports(makeFakeGameExports([worldEdict, groundEdict]));
    gameCvars.sv_maxvelocity = setCvar(2000);
    gameCvars.sv_gravity = setCvar(800);

    const ent = new EdictT();
    ent.inuse = true;
    ent.movetype = MovetypeT.MOVETYPE_STEP;
    // ent.groundentity starts null (EdictT's default), which forces the
    // "airborn monsters should always check for ground" M_CheckGround call
    ent.velocity[2] = -50; // falling

    SV_Physics_Step(ent);

    expect(ent.groundentity).toBe(groundEdict);
    expect(ent.velocity[2]).toBe(0);
  });
});

describe("SV_Physics_Pusher", () => {
  test("a pusher blocked by a stationary obstacle calls the pusher's blocked() with that obstacle", () => {
    const worldEdict = new EdictT();

    const pusher = new EdictT();
    pusher.movetype = MovetypeT.MOVETYPE_PUSH;
    pusher.velocity[0] = 10;
    pusher.absmin = vec3(-16, -16, -16);
    pusher.absmax = vec3(16, 16, 16);

    // A solid, non-moving obstacle in the pusher's path. MOVETYPE_TOSS (not
    // MOVETYPE_NONE) so SV_Push's movetype filter doesn't skip it outright.
    const check = new EdictT();
    check.inuse = true;
    check.movetype = MovetypeT.MOVETYPE_TOSS;
    check.area.prev = new LinkT();
    check.absmin = vec3(-1, -1, -1);
    check.absmax = vec3(1, 1, 1);

    SetGEdicts([worldEdict, pusher, check]);
    SetGameExports(makeFakeGameExports([worldEdict, pusher, check]));

    // Every SV_TestEntityPosition trace reports startsolid, so `check` is
    // always found blocked, wherever it's tentatively placed.
    const { gi: fakeGi } = makeFakeGameImports(() => ({
      allsolid: false,
      startsolid: true,
      fraction: 0,
      endpos: vec3(),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: null,
    }));
    SetGameImports(fakeGi);

    const blockedCalls: Array<{ self: EdictT; other: EdictT }> = [];
    pusher.blocked = (self, other) => {
      blockedCalls.push({ self, other });
    };

    SV_Physics_Pusher(pusher);

    expect(blockedCalls).toHaveLength(1);
    expect(blockedCalls[0]?.self).toBe(pusher);
    expect(blockedCalls[0]?.other).toBe(check);
    // the failed push must be backed out
    expect(pusher.s.origin[0]).toBe(0);
  });
});
