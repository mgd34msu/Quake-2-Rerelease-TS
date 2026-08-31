// Family-aware client prediction (q2repro src/client/predict.c:230-243,
// 270-294): a kex session replays its backed-up usercmds through the kex
// cgame's own Pmove -- the same movement code kexgame/p_client.ts's
// ClientThink runs server-side -- while a classic session keeps predicting
// through the engine's vanilla qcommon/pmove.ts exactly as v3.19 did.
//
// Four groups:
//   A. the type bridge cl_pred.ts needs to cross into KexPmoveT
//      (cgame/host.ts): trace conversion, trace-result merge, usercmd
//      conversion, and the world/entity identity tokens.
//   B. the dispatch seam -- which cgame owns movement.
//   C. deterministic replay: the client path's positions against the kex
//      game's own Pmove driven with the same seed and the same commands, the
//      way kexgame/p_client.ts's runPmoveAndApplyResults drives it.
//   D. classic-path regression pins: the vanilla path still produces the
//      vanilla Pmove's own 12.3 fixed-point results, and nothing about the
//      kex work reaches it.
//
// Self-sufficient per preferences.md rule 13: every test sets the cgame kind,
// the cls/cl state and the cvars it depends on, and restores the module
// default ("classic") afterward. Groups C and D load a synthetic box-room BSP
// (test/support/bsp_builder.ts -- no copyrighted map data) through the real
// CM_LoadMap, following test/cmodel_map.test.ts's precedent, because a replay
// against an EMPTY collision model proves nothing: with no map loaded
// CM_BoxTrace returns before it ever fills endpos, so every move would collapse
// to the origin. With a real room the reference side can reproduce the client's
// collision callbacks exactly -- world-only CM_BoxTrace against headnode 0,
// which is what CL_KexTrace reduces to when the frame carries no entities.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CG_GetActiveCgamePmove,
  CG_GetActiveCgameKind,
  CG_SetActiveCgameKind,
  CL_KexTraceEntity,
  kexTraceFromEngine,
  copyKexTrace,
  kexUsercmdFromClassic,
  kexPmoveStateViewFromClassic,
} from "../src/client/cgame/host";
import { CL_PredictMovement } from "../src/client/cl_pred";
import { cl, cls, clCvars, ConnstateT, CMD_BACKUP } from "../src/client/client";
import { Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap, CM_BoxTrace, CM_PointContents } from "../src/qcommon/cmodel";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import { CplaneT, CsurfaceT, TraceT, UsercmdT, PmTypeT, ANGLE2SHORT, SHORT2ANGLE, MASK_PLAYERSOLID } from "../src/shared/q_shared";
import { vec3, vec3_origin, type Vec3 } from "../src/shared/math";
import type { KexPmoveT, KexTraceT } from "../src/kexapi/game";
import { ContentsT, WaterLevelT, RefdefFlagsT, PmflagsT, KexPmTypeT } from "../src/kexapi/game";
import { Pmove as KexPmove } from "../src/kexgame/p_move";
import { PM_CONFIG_DEFAULT } from "../src/kexgame/bg_local";
import { Pmove as VanillaPmove } from "../src/qcommon/pmove";
import { PmoveT } from "../src/shared/q_shared";

/** clCvars is populated by CL_InitLocal in a real client; a test file that
 *  drives CL_PredictMovement directly registers the two cvars it reads. */
function setPredictionCvars(predictValue: number): void {
  const predict = Cvar_Get("cl_predict", "1", 0);
  if (!predict) throw new Error("cl_predict could not be registered");
  predict.value = predictValue;
  clCvars.cl_predict = predict;

  const paused = Cvar_Get("cl_paused", "0", 0);
  if (!paused) throw new Error("cl_paused could not be registered");
  paused.value = 0;
  clCvars.cl_paused = paused;
}

function makeTrace(over: Partial<TraceT>): TraceT {
  const t = new TraceT();
  t.fraction = 1;
  Object.assign(t, over);
  return t;
}

// ---------------------------------------------------------------------------
// A. the type bridge
// ---------------------------------------------------------------------------

describe("kex prediction bridge -- trace conversion", () => {
  test("carries every engine trace field across, and adopts the supplied entity", () => {
    const plane = new CplaneT();
    plane.normal[2] = 1;
    plane.dist = 64;
    const surf = new CsurfaceT();
    surf.name = "e1u1/floor";
    surf.flags = 0x10;
    surf.value = 7;

    const engine = makeTrace({
      allsolid: false,
      startsolid: true,
      fraction: 0.25,
      endpos: vec3(1, 2, 3),
      plane,
      surface: surf,
      contents: ContentsT.CONTENTS_SOLID,
    });

    const world = CL_KexTraceEntity(0);
    const kex = kexTraceFromEngine(engine, world);

    expect(kex.allsolid).toBe(false);
    expect(kex.startsolid).toBe(true);
    expect(kex.fraction).toBe(0.25);
    expect(Array.from(kex.endpos)).toEqual([1, 2, 3]);
    expect(kex.plane).toBe(plane);
    expect(kex.contents).toBe(ContentsT.CONTENTS_SOLID);
    expect(kex.ent).toBe(world);
    // KexCsurfaceT widens CsurfaceT with id/material, which the collision
    // model does not carry -- filled the same way server/bindings/kex.ts's
    // toKexTrace fills them, so both sides of a trace see identical data.
    expect(kex.surface).toEqual({ name: "e1u1/floor", flags: 0x10, value: 7, id: 0, material: "" });
  });

  test("a null engine surface stays null, and plane2 is never left undefined", () => {
    const engine = makeTrace({ surface: null });
    engine.plane2 = undefined;
    engine.surface2 = undefined;

    const kex = kexTraceFromEngine(engine, null);

    expect(kex.surface).toBeNull();
    expect(kex.surface2).toBeNull();
    expect(kex.plane2).toBeInstanceOf(CplaneT);
    expect(kex.ent).toBeNull();
  });

  test("copyKexTrace overwrites every member of the destination", () => {
    const dst = kexTraceFromEngine(makeTrace({ fraction: 1 }), null);
    const srcEnt = CL_KexTraceEntity(12);
    const src = kexTraceFromEngine(
      makeTrace({ allsolid: true, startsolid: true, fraction: 0.5, endpos: vec3(9, 9, 9), contents: ContentsT.CONTENTS_WINDOW }),
      srcEnt,
    );

    copyKexTrace(dst, src);

    expect(dst.allsolid).toBe(true);
    expect(dst.startsolid).toBe(true);
    expect(dst.fraction).toBe(0.5);
    expect(Array.from(dst.endpos)).toEqual([9, 9, 9]);
    expect(dst.contents).toBe(ContentsT.CONTENTS_WINDOW);
    expect(dst.ent).toBe(srcEnt);
  });
});

describe("kex prediction bridge -- world/entity identity tokens", () => {
  test("the same entity number always yields the same object", () => {
    expect(CL_KexTraceEntity(0)).toBe(CL_KexTraceEntity(0));
    expect(CL_KexTraceEntity(37)).toBe(CL_KexTraceEntity(37));
    // Identity across replayed frames is the whole point: p_move.ts compares
    // pm.groundentity and touch entries by identity, never by value.
    expect(CL_KexTraceEntity(0)).not.toBe(CL_KexTraceEntity(37));
  });

  test("entity 0 is the world, and the token is self-describing but otherwise blank", () => {
    const world = CL_KexTraceEntity(0);
    expect(world.s.number).toBe(0);
    expect(CL_KexTraceEntity(37).s.number).toBe(37);
    expect(world.client).toBeNull();
    expect(world.owner).toBeNull();
    expect(world.inuse).toBe(false);
    expect(world.linked).toBe(false);
    expect(Array.from(world.mins)).toEqual([0, 0, 0]);
  });
});

describe("kex prediction bridge -- usercmd conversion", () => {
  test("angles come back as degrees and the move axes pass through", () => {
    const cmd = new UsercmdT();
    cmd.msec = 25;
    cmd.buttons = 0x09;
    cmd.angles[0] = ANGLE2SHORT(12.5);
    cmd.angles[1] = ANGLE2SHORT(-90);
    cmd.angles[2] = ANGLE2SHORT(0);
    cmd.forwardmove = 300;
    cmd.sidemove = -200;

    const kex = kexUsercmdFromClassic(cmd, 4242);

    expect(kex.msec).toBe(25);
    expect(kex.buttons).toBe(0x09);
    expect(kex.forwardmove).toBe(300);
    expect(kex.sidemove).toBe(-200);
    expect(kex.server_frame).toBe(4242);
    expect(kex.angles[0]).toBeCloseTo(12.5, 2);
    expect(kex.angles[1]).toBeCloseTo(-90, 2);
    expect(kex.angles[0]).toBe(SHORT2ANGLE(cmd.angles[0]));
  });

  test("upmove is dropped, exactly as server/bindings/kex.ts's toKexUsercmd drops it", () => {
    const cmd = new UsercmdT();
    cmd.upmove = 400;
    // KexUsercmdT has no upmove member at all; vertical intent reaches the kex
    // movement code through BUTTON_JUMP/BUTTON_CROUCH (cl_input.ts:483-484).
    expect("upmove" in kexUsercmdFromClassic(cmd, 0)).toBe(false);
  });
});

describe("kex prediction bridge -- pmove state seeding", () => {
  test("12.3 fixed point becomes world units, and pm_time passes through unscaled", () => {
    const src = cl.frame.playerstate.pmove;
    src.origin[0] = 800; // 100 units
    src.origin[1] = -8; // -1 unit
    src.origin[2] = 3;  // 0.375 units
    src.velocity[0] = 2400; // 300 u/s
    src.pm_time = 800; // kex pm_time is MILLISECONDS, not vanilla's 8ms units
    src.gravity = 800;
    src.viewheight = 22;
    src.delta_angles[1] = ANGLE2SHORT(45);
    src.pm_type = PmTypeT.PM_NORMAL;

    const seed = kexPmoveStateViewFromClassic(src);

    expect(seed.origin[0]).toBe(100);
    expect(seed.origin[1]).toBe(-1);
    expect(seed.origin[2]).toBe(0.375);
    expect(seed.velocity[0]).toBe(300);
    expect(seed.pm_time).toBe(800);
    expect(seed.gravity).toBe(800);
    expect(seed.viewheight).toBe(22);
    expect(seed.delta_angles[1]).toBeCloseTo(45, 2);
    expect(seed.pm_type).toBe(KexPmTypeT.PM_NORMAL);
  });

  test("the seed is a copy -- writing through it cannot reach the snapshot", () => {
    const src = cl.frame.playerstate.pmove;
    src.origin[0] = 800;
    const seed = kexPmoveStateViewFromClassic(src);
    seed.origin[0] = 12345;
    expect(src.origin[0]).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// B. the dispatch seam
// ---------------------------------------------------------------------------

describe("prediction dispatch -- which cgame owns movement", () => {
  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  test("the classic cgame owns no movement code", () => {
    CG_SetActiveCgameKind("classic");
    expect(CG_GetActiveCgameKind()).toBe("classic");
    // v3.19 had no cgame; Pmove was engine-side and cl_pred.ts calls
    // qcommon/pmove.ts directly. A null here IS the classic path.
    expect(CG_GetActiveCgamePmove()).toBeNull();
  });

  test("the kex cgame exposes its own Pmove", () => {
    CG_SetActiveCgameKind("kex");
    const pmove = CG_GetActiveCgamePmove();
    expect(pmove).not.toBeNull();
    expect(typeof pmove).toBe("function");
  });

  test("switching kinds re-resolves the movement owner", () => {
    CG_SetActiveCgameKind("kex");
    expect(CG_GetActiveCgamePmove()).not.toBeNull();
    CG_SetActiveCgameKind("classic");
    expect(CG_GetActiveCgamePmove()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C / D. end-to-end replay
// ---------------------------------------------------------------------------

interface SeedT {
  origin: [number, number, number]; // 12.3 fixed point, as the wire carries it
  velocity: [number, number, number]; // 12.3 fixed point
  pm_flags: number;
  pm_time: number;
  gravity: number;
  viewheight: number;
}

// Inside the synthetic room (half-extent 64): feet at -48, head at +8, with
// 16 units of air below so gravity has somewhere to take the player.
const DEFAULT_SEED: SeedT = {
  origin: [0, 0, -192],
  velocity: [1600, 400, 0],
  pm_flags: 0,
  pm_time: 0,
  gravity: 800,
  viewheight: 22,
};

function buildCommands(count: number): UsercmdT[] {
  const cmds: UsercmdT[] = [];
  for (let i = 0; i < count; i++) {
    const c = new UsercmdT();
    c.msec = 25;
    c.forwardmove = 300;
    c.sidemove = i % 2 === 0 ? 200 : -200;
    c.buttons = i === 1 ? 0x08 /* BUTTON_JUMP */ : 0;
    c.angles[1] = ANGLE2SHORT(i * 3);
    cmds.push(c);
  }
  return cmds;
}

/** Drives the whole client path: seeds cl.frame.playerstate, parks the
 *  commands in cl.cmds where the replay loop reads them, and runs the real
 *  CL_PredictMovement. Returns cl.predicted_origin. */
function runClientPrediction(kind: "classic" | "kex", seed: SeedT, cmds: UsercmdT[]): [number, number, number] {
  CG_SetActiveCgameKind(kind);

  cls.state = ConnstateT.ca_active;
  cls.realtime = 0;
  cls.frametime = 0.025;
  cls.netchan.incoming_acknowledged = 0;
  cls.netchan.outgoing_sequence = cmds.length + 1;

  cl.playernum = 0;
  cl.frame.serverframe = 100;
  cl.frame.num_entities = 0;
  cl.frame.parse_entities = 0;
  cl.prediction_error[0] = 0;

  const ps = cl.frame.playerstate;
  ps.pmove.pm_type = PmTypeT.PM_NORMAL;
  ps.pmove.origin.set(seed.origin);
  ps.pmove.velocity.set(seed.velocity);
  ps.pmove.pm_flags = seed.pm_flags;
  ps.pmove.pm_time = seed.pm_time;
  ps.pmove.gravity = seed.gravity;
  ps.pmove.viewheight = seed.viewheight;
  ps.pmove.delta_angles.set([0, 0, 0]);
  ps.viewoffset.set([0, 0, 22]);

  for (let i = 0; i < cmds.length; i++) {
    const dst = cl.cmds[(i + 1) & (CMD_BACKUP - 1)];
    dst.msec = cmds[i].msec;
    dst.buttons = cmds[i].buttons;
    dst.angles.set(cmds[i].angles);
    dst.forwardmove = cmds[i].forwardmove;
    dst.sidemove = cmds[i].sidemove;
    dst.upmove = cmds[i].upmove;
  }

  CL_PredictMovement();
  return [cl.predicted_origin[0], cl.predicted_origin[1], cl.predicted_origin[2]];
}

/** The reference side: kexgame/p_move.ts driven exactly the way
 *  kexgame/p_client.ts's runPmoveAndApplyResults drives it on the server
 *  (p_client.ts:3456-3500) -- same struct assembly, same PM_CONFIG_DEFAULT,
 *  snapinitial on the first command. */
function runServerPmove(seed: SeedT, cmds: UsercmdT[]): [number, number, number] {
  // The exact reduction of cl_pred.ts's CL_KexTrace/CL_KexClip when the frame
  // carries no entities: a world-only CM_BoxTrace against headnode 0, with the
  // world identity token as trace.ent.
  const worldTrace = (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, mask: number): KexTraceT =>
    kexTraceFromEngine(CM_BoxTrace(start, end, mins ?? vec3_origin, maxs ?? vec3_origin, 0, mask), CL_KexTraceEntity(0));

  const pm: KexPmoveT = {
    s: {
      pm_type: KexPmTypeT.PM_NORMAL,
      origin: vec3(seed.origin[0] * 0.125, seed.origin[1] * 0.125, seed.origin[2] * 0.125),
      velocity: vec3(seed.velocity[0] * 0.125, seed.velocity[1] * 0.125, seed.velocity[2] * 0.125),
      pm_flags: seed.pm_flags,
      pm_time: seed.pm_time,
      gravity: seed.gravity,
      delta_angles: vec3(),
      viewheight: seed.viewheight,
    },
    cmd: kexUsercmdFromClassic(new UsercmdT(), 100),
    snapinitial: true,
    touch: { num: 0, traces: [] },
    viewangles: vec3(),
    mins: vec3(),
    maxs: vec3(),
    groundentity: null,
    groundplane: new CplaneT(),
    watertype: ContentsT.CONTENTS_NONE,
    waterlevel: WaterLevelT.WATER_NONE,
    player: null,
    trace: (start, mins, maxs, end, _passent, contentmask) => worldTrace(start, mins, maxs, end, contentmask),
    clip: (start, mins, maxs, end, contentmask) => worldTrace(start, mins, maxs, end, contentmask),
    pointcontents: (point) => CM_PointContents(point, 0),
    viewoffset: vec3(0, 0, 22),
    screen_blend: new Float32Array(4),
    rdflags: RefdefFlagsT.RDF_NONE,
    jump_sound: false,
    step_clip: false,
    impact_delta: 0,
  };

  for (const c of cmds) {
    pm.cmd = kexUsercmdFromClassic(c, 100);
    KexPmove(pm, PM_CONFIG_DEFAULT);
    pm.snapinitial = false;
  }

  return [pm.s.origin[0], pm.s.origin[1], pm.s.origin[2]];
}

// The synthetic room both replay groups run inside. Loaded once for the file;
// mirrors test/cmodel_map.test.ts's own fixture, which establishes that a
// test may point the filesystem at a temp basedir and load a map globally.
let mapRoot = "";

beforeAll(() => {
  mapRoot = mkdtempSync(join(tmpdir(), "q2pred-"));
  const mapsDir = join(mapRoot, "baseq2", "maps");
  mkdirSync(mapsDir, { recursive: true });
  writeFileSync(join(mapsDir, "predroom.bsp"), buildBoxRoomBsp());
  Cvar_ForceSet("basedir", mapRoot);
  FS_InitFilesystem();
  CM_LoadMap("maps/predroom.bsp", false);
});

afterAll(() => {
  rmSync(mapRoot, { recursive: true, force: true });
});

describe("kex prediction -- deterministic replay against the server game's own Pmove", () => {
  beforeEach(() => {
    setPredictionCvars(1);
  });

  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  test("a six-command replay lands exactly where the server game's Pmove does", () => {
    const cmds = buildCommands(6);
    const got = runClientPrediction("kex", DEFAULT_SEED, cmds);
    // Guard against a vacuous match: the replay has to have actually moved the
    // player off the seed, in every axis the commands push on.
    expect(Math.abs(got[0])).toBeGreaterThan(8);
    expect(Math.abs(got[1])).toBeGreaterThan(1);
    expect(got[2]).not.toBe(DEFAULT_SEED.origin[2] * 0.125);
    expect(got).toEqual(runServerPmove(DEFAULT_SEED, cmds));
  });

  test("still matches with a jump held, a ducked seed and a live pm_time", () => {
    const seed: SeedT = {
      ...DEFAULT_SEED,
      pm_flags: PmflagsT.PMF_DUCKED | PmflagsT.PMF_JUMP_HELD,
      // MILLISECONDS: kexgame/p_move.ts compares pm_time against cmd.msec
      // directly (p_move.ts:1447-1452). A vanilla-units reading of this value
      // would clear the timer eight times too early.
      pm_time: 120,
    };
    const cmds = buildCommands(4);
    for (const c of cmds) c.buttons = 0x08; // BUTTON_JUMP held throughout
    expect(runClientPrediction("kex", seed, cmds)).toEqual(runServerPmove(seed, cmds));
  });

  test("the prediction is float end to end -- a sub-1/8-unit result survives", () => {
    const cmds = buildCommands(3);
    const got = runClientPrediction("kex", DEFAULT_SEED, cmds);
    // The classic path's output is `pm.s.origin[i] * 0.125` off an Int16Array,
    // so it can only ever land on a 1/8 grid. The kex path carries float
    // state, so at least one axis is off-grid after a real move.
    expect(got.some((v) => v * 8 !== Math.round(v * 8))).toBe(true);
  });

  test("the replayed range is written into predicted_origins, quantized like the wire", () => {
    const cmds = buildCommands(5);
    runClientPrediction("kex", DEFAULT_SEED, cmds);
    for (let i = 1; i <= cmds.length; i++) {
      const rec = cl.predicted_origins[i & (CMD_BACKUP - 1)];
      expect(Number.isInteger(rec[0])).toBe(true);
    }
    // The last replayed command's record is the final predicted origin,
    // narrowed with the 1038 codec's own pmFloatToShort.
    const last = cl.predicted_origins[cmds.length & (CMD_BACKUP - 1)];
    expect(last[0]).toBe(Math.round(cl.predicted_origin[0] * 8));
    expect(last[1]).toBe(Math.round(cl.predicted_origin[1] * 8));
    expect(last[2]).toBe(Math.round(cl.predicted_origin[2] * 8));
  });
});

// ---------------------------------------------------------------------------
// D. classic-path regression pins
// ---------------------------------------------------------------------------

/** The vanilla path's own reference: qcommon/pmove.ts driven with the same
 *  12.3 fixed-point state cl_pred.ts hands it, and its own "hit nothing"
 *  callbacks. */
function runVanillaPmove(seed: SeedT, cmds: UsercmdT[]): [number, number, number] {
  const pm = new PmoveT();
  // cl_pred.ts's CL_PMTrace with an entity-free frame: world-only, hardwired
  // to MASK_PLAYERSOLID, `ent = 1` on any hit.
  pm.trace = (start, mins, maxs, end) => {
    const t = CM_BoxTrace(start, end, mins, maxs, 0, MASK_PLAYERSOLID);
    if (t.fraction < 1.0) t.ent = 1;
    return t;
  };
  pm.pointcontents = (point) => CM_PointContents(point, 0);
  pm.s.pm_type = PmTypeT.PM_NORMAL;
  pm.s.origin.set(seed.origin);
  pm.s.velocity.set(seed.velocity);
  pm.s.pm_flags = seed.pm_flags;
  pm.s.pm_time = seed.pm_time;
  pm.s.gravity = seed.gravity;
  pm.s.viewheight = seed.viewheight;

  for (const c of cmds) {
    pm.cmd.msec = c.msec;
    pm.cmd.buttons = c.buttons;
    pm.cmd.angles.set(c.angles);
    pm.cmd.forwardmove = c.forwardmove;
    pm.cmd.sidemove = c.sidemove;
    pm.cmd.upmove = c.upmove;
    VanillaPmove(pm);
  }

  return [pm.s.origin[0] * 0.125, pm.s.origin[1] * 0.125, pm.s.origin[2] * 0.125];
}

describe("classic prediction -- unchanged by the kex work", () => {
  beforeEach(() => {
    setPredictionCvars(1);
  });

  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  test("a classic session still predicts through the vanilla Pmove, byte for byte", () => {
    const cmds = buildCommands(6);
    expect(runClientPrediction("classic", DEFAULT_SEED, cmds)).toEqual(runVanillaPmove(DEFAULT_SEED, cmds));
  });

  test("the classic path's output stays on the 12.3 fixed-point grid", () => {
    const cmds = buildCommands(6);
    const got = runClientPrediction("classic", DEFAULT_SEED, cmds);
    for (const v of got) expect(v * 8).toBe(Math.round(v * 8));
    for (let i = 1; i <= cmds.length; i++) {
      const rec = cl.predicted_origins[i & (CMD_BACKUP - 1)];
      expect(Number.isInteger(rec[0])).toBe(true);
    }
  });

  test("the two families really do diverge -- the dispatch is not a no-op", () => {
    const cmds = buildCommands(6);
    const classic = runClientPrediction("classic", DEFAULT_SEED, cmds);
    const kex = runClientPrediction("kex", DEFAULT_SEED, cmds);
    expect(kex).not.toEqual(classic);
  });

  test("angle-only mode still runs when prediction is off, for both families", () => {
    for (const kind of ["classic", "kex"] as const) {
      CG_SetActiveCgameKind(kind);
      setPredictionCvars(0);
      cls.state = ConnstateT.ca_active;
      cl.viewangles.set([10, 20, 0]);
      cl.frame.playerstate.pmove.delta_angles.set([ANGLE2SHORT(5), 0, 0]);
      CL_PredictMovement();
      expect(cl.predicted_angles[0]).toBeCloseTo(15, 2);
      setPredictionCvars(1);
    }
  });
});
