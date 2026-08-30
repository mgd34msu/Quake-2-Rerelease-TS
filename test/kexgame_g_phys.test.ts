/*
Unit tests for the kex g_phys.cpp port (src/kexgame/g_phys.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled after test/kexgame_g_utils.test.ts's own
fake-imports fixture, adapted for physics: the `trace`/`pointcontents`
functions are mutable per-test hooks (`traceImpl`/`pointcontentsImpl`) so each
test can script exactly the collision results its scenario needs, and
`linkentity` recomputes absmin/absmax from origin+mins/maxs like the real
engine (SV_Push's bounding-box overlap test depends on it).

Scope (12+ cases, each citing the exact C++ line range it exercises):
  - G_GetClipMask (g_phys.cpp:30-56): default/monster/projectile masks, and
    the SOLID_NOT contents-stripping branch.
  - SV_TestEntityPosition (g_phys.cpp:64-74): startsolid -> world edict;
    clear -> null.
  - SV_CheckVelocity (g_phys.cpp:81-90): magnitude-based rescale (NOT the
    legacy per-axis clamp) at sv_maxvelocity.
  - SV_RunThink (g_phys.cpp:99-113): fires exactly at nextthink (not before),
    and clears nextthink to 0 afterward.
  - G_Impact (g_phys.cpp:117-131): touch fires on both sides; FL_ALWAYS_TOUCH
    override for a SOLID_NOT entity.
  - SV_AddGravity (g_phys.cpp:180-183): gravity*level.gravity*frametime along
    gravityVector, through gtime's gi.frame_time_s.
  - SV_Physics_Toss (g_phys.cpp:515-687): a 2-frame free-fall arc, hand-
    integrated against the exact algorithm (gravity-then-push, single
    sub-step per frame since the mock trace never partially hits).
  - SV_Physics_Toss bounce backoff (g_phys.cpp:603-615): MOVETYPE_BOUNCE's
    1.6 constant and MOVETYPE_WALLBOUNCE's 2.0 constant, verified against
    the exact ClipVelocity formula (q_vec3.h:424-434) by hand.
  - SV_FlyMove (g_phys.cpp:140-172): wall-slide via SlideClipVelocity with a
    45-degree plane (delegates to p_move.ts's PM_StepSlideMove_Generic), and
    groundentity assignment when a touched plane's normal.z > 0.7.
  - SV_Physics_Pusher / SV_Push (g_phys.cpp:258-464): a MOVETYPE_PUSH pusher
    moves a standing rider by the same delta; a blocked pusher calls its
    moveinfo.blocked handler with the obstacle and leaves the pusher in
    place.
  - G_RunEntity (g_phys.cpp:947-1041): dispatches by movetype, and throws on
    an unhandled movetype (the `default:` branch).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, ContentsT, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, type GitemT, MovetypeT, EntFlagsT, ItemFlagsT, ItemIdT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms } from "../src/kexgame/gtime";
import { SpawnFlags_from } from "../src/kexgame/spawnflags";
import {
  G_GetClipMask,
  SV_TestEntityPosition,
  SV_CheckVelocity,
  SV_RunThink,
  G_Impact,
  SV_AddGravity,
  SV_FlyMove,
  SV_Physics_Toss,
  SV_Physics_Pusher,
  G_RunEntity,
} from "../src/kexgame/g_phys";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture
// ---------------------------------------------------------------------------

function noHitTrace(end: Vec3): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

/** Mutable per-test collision hooks; reset in beforeEach-equivalent (setupWorld). */
let traceImpl: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: number) => KexTraceT =
  (_start, _mins, _maxs, end) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;

function makeFakeGameImports(): KexGameImports {
  const cvars = new Map<string, CvarT>();
  function getCvar(name: string, value: string): CvarT {
    let c = cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value);
      cvars.set(name, c);
    }
    return c;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print() {},
    Client_Print() {},
    Center_Print() {},
    sound() {},
    positioned_sound() {},
    local_sound() {},
    configstring() {},
    get_configstring() {
      return "";
    },
    Com_Error(message): never {
      throw new Error(`gi.Com_Error: ${message}`);
    },
    modelindex() {
      return 0;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(start, mins, maxs, end, passent, mask) {
      return traceImpl(start, mins, maxs, end, passent, mask);
    },
    clip(_entity, start, _mins, _maxs, end) {
      return noHitTrace(end);
    },
    pointcontents(point) {
      return pointcontentsImpl(point);
    },
    inPVS() {
      return false;
    },
    inPHS() {
      return false;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return false;
    },
    linkentity(ent) {
      if (ent === null) return;
      const full = g_edicts[ent.s.number];
      if (full === undefined) return;
      for (let i = 0; i < 3; i++) {
        full.absmin[i] = full.s.origin[i] + full.mins[i];
        full.absmax[i] = full.s.origin[i] + full.maxs[i];
      }
    },
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte() {},
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString() {},
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    WriteEntity() {},
    TagMalloc() {
      return null;
    },
    TagFree() {},
    FreeTags() {},
    cvar(var_name, value) {
      return getCvar(var_name, value ?? "0");
    },
    cvar_set(var_name, value) {
      return getCvar(var_name, value);
    },
    cvar_forceset(var_name, value) {
      return getCvar(var_name, value);
    },
    argc() {
      return 0;
    },
    argv() {
      return "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
    GetExtension() {
      return null;
    },
    Bot_RegisterEdict() {},
    Bot_UnRegisterEdict() {},
    Bot_MoveToPoint() {
      return 0;
    },
    Bot_FollowActor() {
      return 0;
    },
    GetPathToGoal() {
      return false;
    },
    Loc_Print() {},
    Draw_Line() {},
    Draw_Point() {},
    Draw_Circle() {},
    Draw_Bounds() {},
    Draw_Sphere() {},
    Draw_OrientedWorldText() {},
    Draw_StaticWorldText() {},
    Draw_Cylinder() {},
    Draw_Ray() {},
    Draw_Arrow() {},
    ReportMatchDetails_Multicast() {},
    ServerFrame() {
      return 0;
    },
    SendToClipBoard() {},
    Info_ValueForKey() {
      return 0;
    },
    Info_RemoveKey() {
      return false;
    },
    Info_SetValueForKey() {
      return false;
    },
  };
}

function makeFakeGameExports(edicts: EdictT[], numEdicts: number): KexGameExports {
  return {
    apiversion: GAME_API_VERSION,
    PreInit() {},
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGameJson() {
      return null;
    },
    ReadGameJson() {},
    WriteLevelJson() {
      return null;
    },
    ReadLevelJson() {},
    CanSave() {
      return true;
    },
    ClientChooseSlot() {
      return null;
    },
    ClientConnect() {
      return false;
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    PrepFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: numEdicts,
    max_edicts: edicts.length,
    server_flags: 0,
    Pmove() {},
    GetExtension() {
      return null;
    },
    Bot_SetWeapon() {},
    Bot_TriggerEdict() {},
    Bot_UseItem() {},
    Bot_GetItemID() {
      return 0;
    },
    Edict_ForceLookAtPoint() {},
    Bot_PickedUpItem() {
      return false;
    },
    Entity_IsVisibleToPlayer() {
      return false;
    },
    GetShadowLightData() {
      return null;
    },
  };
}

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(numEdicts: number): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < 16; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  // the world edict (index 0) is always `inuse` in a running server
  // (SpawnEntities spawns it first); a not-inuse world edict makes
  // SV_PushEntity's "the entity we hit went away" recursive-retry branch
  // misfire on every trace whose `.ent` defaults to null/world, which is a
  // real infinite-recursion trap, not a g_phys.ts bug -- see traceEdict()'s
  // own doc comment on the world-edict fallback.
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 4;
  game.maxentities = 16;
  level.time = Gtime_from_ms(0);
  level.gravity = 800;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;

  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts };
}

/** A live, non-world entity with sane physics defaults (gravity=1, down vector). */
function makeLiveEdict(index: number): EdictT {
  const e = g_edicts[index]!;
  e.inuse = true;
  e.gravity = 1;
  e.gravityVector = vec3(0, 0, -1);
  e.classname = "test_ent";
  return e;
}

/** A minimal, fully-valid GitemT with IF_KEY set (g_local_types.ts's own
 *  interface has ~30 fields; every one is given its documented "default"
 *  value except `id`/`flags`, which the "dropped key in slime/lava" test
 *  cares about). */
function makeKeyItem(): GitemT {
  return {
    id: ItemIdT.IT_NULL,
    classname: "item_key_test",
    pickup: null,
    use: null,
    drop: null,
    weaponthink: null,
    pickup_sound: null,
    world_model: null,
    world_model_flags: 0n,
    view_model: null,
    icon: null,
    use_name: null,
    pickup_name: null,
    pickup_name_definite: null,
    quantity: 0,
    ammo: ItemIdT.IT_NULL,
    chain: ItemIdT.IT_NULL,
    flags: ItemFlagsT.IF_KEY,
    vwep_model: null,
    armor_info: null,
    tag: 0,
    precaches: null,
    sort_id: 0,
    quantity_warn: 5,
    chain_next: null,
    vwep_index: 0,
    ammo_wheel_index: -1,
    weapon_wheel_index: -1,
    powerup_wheel_index: -1,
  };
}

// ---------------------------------------------------------------------------
// G_GetClipMask (g_phys.cpp:30-56)
// ---------------------------------------------------------------------------

describe("G_GetClipMask", () => {
  test("default (non-monster, non-projectile) mask is MASK_SHOT minus CONTENTS_DEADMONSTER", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.solid = SolidT.SOLID_BBOX;
    const mask = G_GetClipMask(e);
    expect(mask & ContentsT.CONTENTS_DEADMONSTER).toBe(0);
    expect(mask & ContentsT.CONTENTS_SOLID).not.toBe(0);
    expect(mask & ContentsT.CONTENTS_MONSTER).not.toBe(0);
  });

  test("SVF_MONSTER entities default to MASK_MONSTERSOLID", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.svflags |= SvflagsT.SVF_MONSTER;
    e.solid = SolidT.SOLID_BBOX;
    const mask = G_GetClipMask(e);
    expect(mask & ContentsT.CONTENTS_MONSTERCLIP).not.toBe(0);
  });

  test("SVF_PROJECTILE entities default to MASK_PROJECTILE", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.svflags |= SvflagsT.SVF_PROJECTILE;
    e.solid = SolidT.SOLID_BBOX;
    const mask = G_GetClipMask(e);
    expect(mask & ContentsT.CONTENTS_PROJECTILECLIP).not.toBe(0);
  });

  test("SOLID_NOT strips CONTENTS_MONSTER/CONTENTS_PLAYER from the mask", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.solid = SolidT.SOLID_NOT;
    const mask = G_GetClipMask(e);
    expect(mask & ContentsT.CONTENTS_MONSTER).toBe(0);
    expect(mask & ContentsT.CONTENTS_PLAYER).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SV_TestEntityPosition (g_phys.cpp:64-74)
// ---------------------------------------------------------------------------

describe("SV_TestEntityPosition", () => {
  test("returns the world edict when the trace starts solid", () => {
    const { edicts } = setupWorld(1);
    const e = makeLiveEdict(1);
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), startsolid: true });
    expect(SV_TestEntityPosition(e)).toBe(edicts[0]);
  });

  test("returns null when the position is clear", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    expect(SV_TestEntityPosition(e)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SV_CheckVelocity (g_phys.cpp:81-90) -- magnitude rescale, not per-axis clamp
// ---------------------------------------------------------------------------

describe("SV_CheckVelocity", () => {
  test("leaves velocity under sv_maxvelocity untouched", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.velocity = vec3(100, 0, 0);
    SV_CheckVelocity(e);
    expect(e.velocity[0]).toBeCloseTo(100);
  });

  test("rescales by MAGNITUDE, preserving direction, when the length exceeds sv_maxvelocity", () => {
    setupWorld(1);
    gi.cvar("sv_maxvelocity", "1000", 0); // registers the cvar at 1000
    const e = makeLiveEdict(1);
    // length = sqrt(3000^2 + 4000^2) = 5000 -- classic 3-4-5 triangle scaled.
    e.velocity = vec3(3000, 4000, 0);
    SV_CheckVelocity(e);
    const len = Math.sqrt(e.velocity[0] * e.velocity[0] + e.velocity[1] * e.velocity[1]);
    expect(len).toBeCloseTo(1000);
    // direction preserved: still a 3:4 ratio.
    expect(e.velocity[0] / e.velocity[1]).toBeCloseTo(3000 / 4000);
    expect(e.velocity[0]).toBeCloseTo(600); // 3000/5000 * 1000
    expect(e.velocity[1]).toBeCloseTo(800); // 4000/5000 * 1000
  });

  test("a diagonal velocity within magnitude but exceeding sv_maxvelocity on no single axis is still clamped (the legacy per-axis clamp would have missed this)", () => {
    setupWorld(1);
    gi.cvar("sv_maxvelocity", "100", 0);
    const e = makeLiveEdict(1);
    e.velocity = vec3(90, 90, 0); // each axis < 100, but length ~= 127.3
    SV_CheckVelocity(e);
    const len = Math.sqrt(e.velocity[0] * e.velocity[0] + e.velocity[1] * e.velocity[1]);
    expect(len).toBeCloseTo(100);
  });
});

// ---------------------------------------------------------------------------
// SV_RunThink (g_phys.cpp:99-113)
// ---------------------------------------------------------------------------

describe("SV_RunThink", () => {
  test("does not fire before nextthink and returns true (no-op)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    let fired = false;
    e.think = () => {
      fired = true;
    };
    e.nextthink = Gtime_from_ms(500);
    level.time = Gtime_from_ms(100);
    const result = SV_RunThink(e);
    expect(result).toBe(true);
    expect(fired).toBe(false);
    expect(e.nextthink).toBe(Gtime_from_ms(500)); // untouched
  });

  test("fires exactly at nextthink and clears it to 0", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    let fired = false;
    e.think = () => {
      fired = true;
    };
    e.nextthink = Gtime_from_ms(500);
    level.time = Gtime_from_ms(500); // exact match -- gtime is exact-integer, no epsilon needed
    const result = SV_RunThink(e);
    expect(result).toBe(false);
    expect(fired).toBe(true);
    expect(e.nextthink).toBe(Gtime_from_ms(0));
  });

  test("a zero/negative nextthink is treated as no think pending", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    let fired = false;
    e.think = () => {
      fired = true;
    };
    e.nextthink = Gtime_from_ms(0);
    level.time = Gtime_from_ms(1000);
    expect(SV_RunThink(e)).toBe(true);
    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G_Impact (g_phys.cpp:117-131)
// ---------------------------------------------------------------------------

describe("G_Impact", () => {
  test("fires touch on both sides for ordinary solid entities", () => {
    const { edicts } = setupWorld(2);
    const e1 = makeLiveEdict(1);
    e1.solid = SolidT.SOLID_BBOX;
    const e2 = makeLiveEdict(2);
    e2.solid = SolidT.SOLID_BBOX;

    const calls: string[] = [];
    e1.touch = () => calls.push("e1");
    e2.touch = () => calls.push("e2");

    const trace = { ...noHitTrace(vec3()), ent: e2 };
    G_Impact(e1, trace);

    expect(calls).toContain("e1");
    expect(calls).toContain("e2");
    void edicts;
  });

  test("SOLID_NOT normally suppresses touch, but FL_ALWAYS_TOUCH re-enables it", () => {
    setupWorld(2);
    const e1 = makeLiveEdict(1);
    e1.solid = SolidT.SOLID_NOT;
    const e2 = makeLiveEdict(2);
    e2.solid = SolidT.SOLID_BBOX;

    let e1Touched = false;
    e1.touch = () => {
      e1Touched = true;
    };

    const trace = { ...noHitTrace(vec3()), ent: e2 };
    G_Impact(e1, trace);
    expect(e1Touched).toBe(false); // SOLID_NOT, no FL_ALWAYS_TOUCH -- suppressed

    e1.flags |= EntFlagsT.FL_ALWAYS_TOUCH;
    G_Impact(e1, trace);
    expect(e1Touched).toBe(true); // FL_ALWAYS_TOUCH overrides the SOLID_NOT suppression
  });
});

// ---------------------------------------------------------------------------
// SV_AddGravity (g_phys.cpp:180-183)
// ---------------------------------------------------------------------------

describe("SV_AddGravity", () => {
  test("adds gravity*level.gravity*frametime along gravityVector", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.velocity = vec3(0, 0, 0);
    // frame_time_s = 0.1, level.gravity = 800, ent.gravity = 1, gravityVector = (0,0,-1)
    SV_AddGravity(e);
    expect(e.velocity[2]).toBeCloseTo(-80); // 1 * 800 * 0.1
    expect(e.velocity[0]).toBeCloseTo(0);
    expect(e.velocity[1]).toBeCloseTo(0);
  });

  test("a non-default gravityVector redirects the fall entirely (gravity-flip entities)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.gravityVector = vec3(1, 0, 0); // sideways "gravity"
    e.velocity = vec3(0, 0, 0);
    SV_AddGravity(e);
    expect(e.velocity[0]).toBeCloseTo(80);
    expect(e.velocity[2]).toBeCloseTo(0);
  });

  test("a per-entity gravity multiplier scales the effect", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.gravity = 0.5;
    e.velocity = vec3(0, 0, 0);
    SV_AddGravity(e);
    expect(e.velocity[2]).toBeCloseTo(-40);
  });
});

// ---------------------------------------------------------------------------
// SV_Physics_Toss (g_phys.cpp:515-687) -- 2-frame free-fall arc
// ---------------------------------------------------------------------------

describe("SV_Physics_Toss", () => {
  test("hand-integrated 2-frame free-fall arc (no collisions)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_TOSS;
    e.s.origin = vec3(0, 0, 100);
    e.velocity = vec3(50, 0, 0);

    // frame 1: velocity += gravity (0,0,-80) -> (50,0,-80); origin += velocity*0.1 -> (5,0,92)
    SV_Physics_Toss(e);
    expect(e.velocity[0]).toBeCloseTo(50);
    expect(e.velocity[2]).toBeCloseTo(-80);
    expect(e.s.origin[0]).toBeCloseTo(5);
    expect(e.s.origin[2]).toBeCloseTo(92);

    // frame 2: velocity += gravity -> (50,0,-160); origin += velocity*0.1 -> (10,0,76)
    SV_Physics_Toss(e);
    expect(e.velocity[0]).toBeCloseTo(50);
    expect(e.velocity[2]).toBeCloseTo(-160);
    expect(e.s.origin[0]).toBeCloseTo(10);
    expect(e.s.origin[2]).toBeCloseTo(76);
  });

  test("resting on ground with gravity > 0 returns without moving", () => {
    setupWorld(2);
    const e = makeLiveEdict(1);
    const ground = makeLiveEdict(2);
    e.movetype = MovetypeT.MOVETYPE_TOSS;
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(0, 0, 0);
    e.groundentity = ground;
    SV_Physics_Toss(e);
    expect(e.s.origin[2]).toBeCloseTo(0);
  });

  test("MOVETYPE_BOUNCE applies the 1.6 backoff constant on impact (g_phys.cpp:612)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_BOUNCE;
    e.gravity = 0; // isolate the bounce math from gravity's own contribution
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(100, 0, 0);

    // A vertical wall (normal.z = 0, so the "resting" branch never triggers)
    // stops the entity halfway through its move.
    traceImpl = (start, _mn, _mx, end) => {
      const half = vec3((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2);
      const t = noHitTrace(half);
      t.fraction = 0.5;
      t.plane.normal = vec3(-1, 0, 0);
      return t;
    };

    SV_Physics_Toss(e);

    // ClipVelocity((100,0,0), (-1,0,0), 1.6): dot=-100;
    // out = in + normal*(-2*dot) = (100,0,0)+(-1,0,0)*200 = (-100,0,0);
    // out *= (1.6-1) = 0.6 -> (-60,0,0).
    expect(e.velocity[0]).toBeCloseTo(-60);
    expect(e.velocity[1]).toBeCloseTo(0);
    expect(e.velocity[2]).toBeCloseTo(0);
  });

  test("MOVETYPE_WALLBOUNCE applies the 2.0 backoff constant and re-derives s.angles (g_phys.cpp:608-609,618-619)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_WALLBOUNCE;
    e.gravity = 0;
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(100, 0, 0);

    traceImpl = (start, _mn, _mx, end) => {
      const half = vec3((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2);
      const t = noHitTrace(half);
      t.fraction = 0.5;
      t.plane.normal = vec3(-1, 0, 0);
      return t;
    };

    SV_Physics_Toss(e);

    // ClipVelocity((100,0,0), (-1,0,0), 2.0): dot=-100;
    // out = (100,0,0)+(-1,0,0)*200 = (-100,0,0); out *= (2.0-1) = 1.0 -> (-100,0,0).
    expect(e.velocity[0]).toBeCloseTo(-100);
    // vectoangles((-100,0,0)): yaw = atan2(0,-100)*180/PI = 180; pitch = atan2(0,100)=0 -> (0,180,0)
    expect(e.s.angles[0]).toBeCloseTo(0);
    expect(e.s.angles[1]).toBeCloseTo(180);
  });

  test("a dropped key in slime/lava gets a random relaunch impulse to prevent a softlock (g_phys.cpp:676-679)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_TOSS;
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(0, 0, 0);
    e.groundentity = null;
    e.item = makeKeyItem();
    e.spawnflags = SpawnFlags_from(0x00010000); // SPAWNFLAG_ITEM_DROPPED
    pointcontentsImpl = () => ContentsT.CONTENTS_SLIME;

    SV_Physics_Toss(e);

    // relaunched upward with a randomized velocity -- exact values are
    // Math.random()-seeded (q_std.ts's crandom_open, not deterministic), so
    // only the qualitative "got a strong upward+lateral kick" shape is
    // checked, not exact numbers.
    expect(e.velocity[2]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SV_FlyMove (g_phys.cpp:140-172) -- delegates to PM_StepSlideMove_Generic
// ---------------------------------------------------------------------------

describe("SV_FlyMove", () => {
  test("wall-slide via SlideClipVelocity against a 45-degree plane", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(0, 0, -100);

    const sqrt2over2 = Math.SQRT1_2;
    let call = 0;
    traceImpl = (start, _mn, _mx, end) => {
      call++;
      if (call === 1) {
        const half = vec3((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2);
        const t = noHitTrace(half);
        t.fraction = 0.5;
        t.plane.normal = vec3(sqrt2over2, 0, sqrt2over2);
        return t;
      }
      return noHitTrace(end); // subsequent bumps: fully unobstructed, ends the slide loop
    };

    SV_FlyMove(e, 0.1, ContentsT.CONTENTS_SOLID);

    // SlideClipVelocity((0,0,-100), (sqrt2/2,0,sqrt2/2), 1.01):
    // dot = -100*sqrt2/2 ~= -70.7107; backoff = dot*1.01 ~= -71.4178
    // out = in - normal*backoff = (0,0,-100) - (sqrt2/2,0,sqrt2/2)*(-71.4178)
    //     ~= (50.506, 0, -49.494)
    const dot = -100 * sqrt2over2;
    const backoff = dot * 1.01;
    const expectedX = 0 - sqrt2over2 * backoff;
    const expectedZ = -100 - sqrt2over2 * backoff;
    expect(e.velocity[0]).toBeCloseTo(expectedX, 3);
    expect(e.velocity[2]).toBeCloseTo(expectedZ, 3);
  });

  test("sets groundentity when a touched plane's normal.z > 0.7", () => {
    const { edicts } = setupWorld(1);
    const e = makeLiveEdict(1);
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(0, 0, -100);

    let call = 0;
    traceImpl = (start, _mn, _mx, end) => {
      call++;
      if (call === 1) {
        const half = vec3((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2);
        const t = noHitTrace(half);
        t.fraction = 0.5;
        t.plane.normal = vec3(0, 0, 1); // flat floor
        return t;
      }
      return noHitTrace(end);
    };

    SV_FlyMove(e, 0.1, ContentsT.CONTENTS_SOLID);

    expect(e.groundentity).toBe(edicts[0]); // trace.ent defaults to null -> world edict
  });

  test("FL_KILL_VELOCITY zeroes velocity and clears the flag after a touched impact", () => {
    setupWorld(2);
    const e = makeLiveEdict(1);
    const other = makeLiveEdict(2);
    other.solid = SolidT.SOLID_BBOX;
    e.s.origin = vec3(0, 0, 0);
    e.velocity = vec3(0, 0, -100);
    e.flags |= EntFlagsT.FL_KILL_VELOCITY;

    let call = 0;
    traceImpl = (start, _mn, _mx, end) => {
      call++;
      if (call === 1) {
        const half = vec3((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2);
        const t = noHitTrace(half);
        t.fraction = 0.5;
        t.plane.normal = vec3(0, 0, 1);
        t.ent = other;
        return t;
      }
      return noHitTrace(end);
    };

    SV_FlyMove(e, 0.1, ContentsT.CONTENTS_SOLID);

    expect(e.velocity[0]).toBe(0);
    expect(e.velocity[1]).toBe(0);
    expect(e.velocity[2]).toBe(0);
    expect((e.flags & EntFlagsT.FL_KILL_VELOCITY) === 0n).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV_Physics_Pusher / SV_Push (g_phys.cpp:258-464)
// ---------------------------------------------------------------------------

describe("SV_Physics_Pusher", () => {
  test("a MOVETYPE_PUSH pusher moves a standing rider by the same delta", () => {
    const { edicts } = setupWorld(3);
    globals.num_edicts = 3;

    const pusher = makeLiveEdict(1);
    pusher.movetype = MovetypeT.MOVETYPE_PUSH;
    pusher.mins = vec3(-32, -32, -8);
    pusher.maxs = vec3(32, 32, 8);
    pusher.s.origin = vec3(0, 0, 0);
    pusher.velocity = vec3(50, 0, 0);
    gi.linkentity(pusher);

    const rider = makeLiveEdict(2);
    rider.movetype = MovetypeT.MOVETYPE_TOSS;
    rider.linked = true;
    rider.mins = vec3(-16, -16, -24);
    rider.maxs = vec3(16, 16, 32);
    rider.s.origin = vec3(0, 0, 8);
    rider.groundentity = pusher;
    gi.linkentity(rider);

    SV_Physics_Pusher(pusher);

    expect(pusher.s.origin[0]).toBeCloseTo(5); // 50 * frame_time_s(0.1)
    expect(rider.s.origin[0]).toBeCloseTo(5); // rider carried along by the same delta
    void edicts;
  });

  test("a blocked pusher calls moveinfo.blocked with the obstacle and reverts its own move", () => {
    setupWorld(3);
    globals.num_edicts = 3;

    const pusher = makeLiveEdict(1);
    pusher.movetype = MovetypeT.MOVETYPE_PUSH;
    pusher.mins = vec3(-32, -32, -8);
    pusher.maxs = vec3(32, 32, 8);
    pusher.s.origin = vec3(0, 0, 0);
    pusher.velocity = vec3(50, 0, 0);
    gi.linkentity(pusher);

    const obstacleEnt = makeLiveEdict(2);
    obstacleEnt.movetype = MovetypeT.MOVETYPE_TOSS;
    obstacleEnt.linked = true;
    obstacleEnt.mins = vec3(-16, -16, -24);
    obstacleEnt.maxs = vec3(16, 16, 32);
    obstacleEnt.s.origin = vec3(0, 0, 8);
    obstacleEnt.groundentity = pusher; // shortcut past the AABB pre-check
    gi.linkentity(obstacleEnt);

    // Any position-test trace issued FOR the obstacle itself reports it
    // permanently stuck (can never be pushed clear); every other trace
    // (the pusher's own moves) is unobstructed.
    traceImpl = (_start, _mn, _mx, end, passent) => {
      if (passent === (obstacleEnt)) {
        return { ...noHitTrace(end), startsolid: true };
      }
      return noHitTrace(end);
    };

    const blockedCall: { with: EdictT | null } = { with: null };
    pusher.moveinfo.blocked = (_self, other) => {
      blockedCall.with = other;
    };

    SV_Physics_Pusher(pusher);

    expect(blockedCall.with).toBe(obstacleEnt);
    // the pusher itself gets moved back to its pre-push position
    expect(pusher.s.origin[0]).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------
// G_RunEntity (g_phys.cpp:947-1041)
// ---------------------------------------------------------------------------

describe("G_RunEntity", () => {
  test("dispatches MOVETYPE_NONE to SV_Physics_None (just runs think)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_NONE;
    let fired = false;
    e.think = () => {
      fired = true;
    };
    e.nextthink = Gtime_from_ms(0);
    level.time = Gtime_from_ms(0);
    // nextthink <= 0 means "no think pending" -- verify the dispatch itself
    // doesn't throw and doesn't fire when there's nothing scheduled.
    G_RunEntity(e);
    expect(fired).toBe(false);
  });

  test("runs prethink and postthink around the movetype dispatch", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_NONE;
    const order: string[] = [];
    e.prethink = () => order.push("pre");
    e.postthink = () => order.push("post");
    G_RunEntity(e);
    expect(order).toEqual(["pre", "post"]);
  });

  test("throws (via gi.Com_Error) on an unhandled movetype", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.movetype = MovetypeT.MOVETYPE_WALK; // not handled by G_RunEntity's switch
    expect(() => G_RunEntity(e)).toThrow();
  });
});
