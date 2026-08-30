/*
Unit tests for the kex g_monster.cpp port (src/kexgame/g_monster.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled after test/kexgame_g_phys.test.ts's own
fake-imports fixture (mutable per-test `traceImpl`/`pointcontentsImpl` hooks),
extended with a `soundindex`/`sound` recorder (distinct ids per sound name, so
watr_in.wav vs watr_out.wav vs lava1.wav are individually assertable) and a
`Center_Print` recorder for G_MonsterKilled's debug-mode branch.

Scope (24 cases, each citing the exact C++ line range it exercises):
  - M_CheckGround (g_monster.cpp:140-188): FL_SWIM/FL_FLY early return; the
    velocity*gravityVector.z < -100 PGM early-out; the shallow-plane
    (normal.z < 0.7) clear; the solid-ground set (groundentity + velocity.z=0).
  - M_CatagorizePosition (g_monster.cpp:190-225): WATER_NONE/FEET/WAIST/UNDER
    at the three sample heights (base, +26, +48).
  - M_WorldEffects (g_monster.cpp:235-333): air_finished refresh while not
    fully submerged; the drowning damage formula + 1s pain_debounce_time
    cadence gate (gtime math); lava damage every 100ms scaled by
    10*waterlevel; the FL_INWATER sound-and-flag transition on enter/exit.
  - M_droptofloor / M_droptofloor_generic (g_monster.cpp:335-391): snaps to
    the trace endpos when a floor exists; returns false when none is found
    within the drop distance.
  - M_ProcessPain (g_monster.cpp:649-744): no-ops on an empty queue; the
    alive path (pain() + queue reset); the death path (die() +
    monster_death_use + touch cleared); queue fields always reset after
    processing regardless of path.
  - M_SetAnimation / M_MoveFrame (g_monster.cpp:465-611): instant=true swaps
    active_move immediately and frees stale beams; instant=false only stages
    next_move; M_MoveFrame promotes a staged next_move and snaps s.frame to
    its firstframe.
  - monster_death_use (g_monster.cpp:1144-1182): fires self.target via
    G_UseTargets with enemy as activator; deathtarget overrides target;
    healthtarget fires as a second, separate G_UseTargets call.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, ContentsT, SvflagsT, SolidT, WaterLevelT } from "../src/kexapi/game";
import { type EdictT, type MframeT, MmoveT, MovetypeT, EntFlagsT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import {
  M_CheckGround,
  M_CatagorizePosition,
  M_WorldEffects,
  M_droptofloor,
  M_droptofloor_generic,
  M_ProcessPain,
  M_SetAnimation,
  M_MoveFrame,
  monster_death_use,
} from "../src/kexgame/g_monster";

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

let traceImpl: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: number) => KexTraceT =
  (_start, _mins, _maxs, end) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;

interface Recorder {
  soundCalls: string[]; // resolved sound names, in call order
  centerPrints: string[];
}
let rec: Recorder;

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

  const soundNamesById: string[] = [""];
  function soundindex(name: string): number {
    let idx = soundNamesById.indexOf(name);
    if (idx === -1) {
      idx = soundNamesById.length;
      soundNamesById.push(name);
    }
    return idx;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print() {},
    Client_Print() {},
    Center_Print(_ent, message) {
      rec.centerPrints.push(message);
    },
    sound(_ent, _channel, soundIdx) {
      rec.soundCalls.push(soundNamesById[soundIdx] ?? `#${soundIdx}`);
    },
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
    soundindex,
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
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 4;
  game.maxentities = 16;
  level.time = Gtime_from_ms(0);
  level.gravity = 800;
  level.total_monsters = 0;
  level.killed_monsters = 0;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;
  rec = { soundCalls: [], centerPrints: [] };

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
  e.solid = SolidT.SOLID_BBOX;
  return e;
}

/** A live SVF_MONSTER entity, takedamage on, with sane health for T_Damage. */
function makeMonster(index: number): EdictT {
  const e = makeLiveEdict(index);
  e.svflags |= SvflagsT.SVF_MONSTER;
  e.takedamage = true;
  e.health = 100;
  e.max_health = 100;
  return e;
}

function makeMove(firstframe: number, lastframe: number): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  const frames: MframeT[] = [];
  for (let i = firstframe; i <= lastframe; i++) {
    frames.push({ aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 });
  }
  m.frame = frames;
  return m;
}

// ---------------------------------------------------------------------------
// M_CheckGround (g_monster.cpp:140-188)
// ---------------------------------------------------------------------------

describe("M_CheckGround", () => {
  test("FL_SWIM/FL_FLY entities are skipped entirely (g_monster.cpp:145-146)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.flags |= EntFlagsT.FL_FLY;
    e.groundentity = e; // sentinel: if M_CheckGround touched it, this would change
    let traced = false;
    traceImpl = (_s, _mn, _mx, end) => {
      traced = true;
      return noHitTrace(end);
    };
    M_CheckGround(e, ContentsT.CONTENTS_SOLID);
    expect(traced).toBe(false);
    expect(e.groundentity).toBe(e);
  });

  test("velocity*gravityVector.z < -100 clears groundentity without a full ground check (PGM, g_monster.cpp:148-152)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.groundentity = e;
    e.velocity = vec3(0, 0, 101); // 101 * -1 = -101, < -100
    let traced = false;
    traceImpl = (_s, _mn, _mx, end) => {
      traced = true;
      return noHitTrace(end);
    };
    M_CheckGround(e, ContentsT.CONTENTS_SOLID);
    expect(e.groundentity).toBeNull();
    expect(traced).toBe(false); // early-out happens before the down-trace
  });

  test("clears groundentity when the down-trace plane is shallower than 0.7 (normal gravity, g_monster.cpp:163-170)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.groundentity = e;
    e.velocity = vec3(0, 0, 0);
    traceImpl = (_s, _mn, _mx, end) => {
      const t = noHitTrace(end);
      t.plane.normal = vec3(0.5, 0, 0.5); // z = 0.5 < 0.7
      return t;
    };
    M_CheckGround(e, ContentsT.CONTENTS_SOLID);
    expect(e.groundentity).toBeNull();
  });

  test("sets groundentity and zeroes velocity.z when solid ground is found (g_monster.cpp:181-187)", () => {
    const { edicts } = setupWorld(2);
    const e = makeMonster(1);
    const ground = makeLiveEdict(2);
    e.velocity = vec3(3, 4, -50);
    traceImpl = (_s, _mn, _mx, end) => {
      const t = noHitTrace(end);
      t.plane.normal = vec3(0, 0, 1);
      t.ent = ground;
      return t;
    };
    M_CheckGround(e, ContentsT.CONTENTS_SOLID);
    expect(e.groundentity).toBe(ground);
    expect(e.velocity[2]).toBe(0);
    expect(e.velocity[0]).toBeCloseTo(3); // untouched
    void edicts;
  });
});

// ---------------------------------------------------------------------------
// M_CatagorizePosition (g_monster.cpp:190-225)
// ---------------------------------------------------------------------------

describe("M_CatagorizePosition", () => {
  test("WATER_NONE when the base sample point isn't in water (g_monster.cpp:206-211)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.mins = vec3(-16, -16, -24);
    e.maxs = vec3(16, 16, 32);
    pointcontentsImpl = () => 0;
    M_CatagorizePosition(e, e.s.origin);
    expect(e.waterlevel).toBe(WaterLevelT.WATER_NONE);
    expect(e.watertype).toBe(ContentsT.CONTENTS_NONE);
  });

  test("WATER_FEET when only the base point is submerged (g_monster.cpp:213-218)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.mins = vec3(-16, -16, -24);
    e.maxs = vec3(16, 16, 32);
    // base sample = origin.z + mins.z + 1 = -23; +26 = 3 (must NOT be water).
    pointcontentsImpl = (p) => (p[2] < -10 ? ContentsT.CONTENTS_WATER : 0);
    M_CatagorizePosition(e, e.s.origin);
    expect(e.waterlevel).toBe(WaterLevelT.WATER_FEET);
    expect(e.watertype).toBe(ContentsT.CONTENTS_WATER);
  });

  test("WATER_WAIST when the point 26 units above the base is also submerged (g_monster.cpp:220-224)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.mins = vec3(-16, -16, -24);
    e.maxs = vec3(16, 16, 32);
    // base sample = origin.z + mins.z + 1 = -23; +26 = 3; +22 = 25
    pointcontentsImpl = (p) => (p[2] < 10 ? ContentsT.CONTENTS_WATER : 0);
    M_CatagorizePosition(e, e.s.origin);
    expect(e.waterlevel).toBe(WaterLevelT.WATER_WAIST);
  });

  test("WATER_UNDER when the point 48 units above the base is also submerged (g_monster.cpp:222-224)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.mins = vec3(-16, -16, -24);
    e.maxs = vec3(16, 16, 32);
    pointcontentsImpl = () => ContentsT.CONTENTS_WATER; // fully submerged everywhere
    M_CatagorizePosition(e, e.s.origin);
    expect(e.waterlevel).toBe(WaterLevelT.WATER_UNDER);
  });
});

// ---------------------------------------------------------------------------
// M_WorldEffects (g_monster.cpp:235-333)
// ---------------------------------------------------------------------------

describe("M_WorldEffects", () => {
  test("refreshes air_finished to level.time+12s while not fully submerged (g_monster.cpp:243-246)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.waterlevel = WaterLevelT.WATER_FEET;
    level.time = Gtime_from_ms(5000);
    M_WorldEffects(e);
    expect(e.air_finished).toBe(Gtime_from_ms(5000 + 12000));
  });

  test("drowning: damage formula scales with elapsed seconds past air_finished, capped, gated at 1s cadence (g_monster.cpp:247-258)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.waterlevel = WaterLevelT.WATER_UNDER;
    e.air_finished = Gtime_from_ms(0);
    level.time = Gtime_from_ms(2500); // 2.5s past air_finished -> floor(2.5)=2 -> dmg=2+2*2=6

    M_WorldEffects(e);

    expect(e.health).toBe(94); // 100 - 6
    expect(e.monsterinfo.damage_blood).toBe(6);
    expect(e.pain_debounce_time).toBe(Gtime_from_ms(2500 + 1000));

    // cadence gate: a second call at the SAME level.time must not re-apply
    // damage (pain_debounce_time is no longer < level.time).
    M_WorldEffects(e);
    expect(e.health).toBe(94);
    expect(e.monsterinfo.damage_blood).toBe(6);
  });

  test("lava damage applies every 100ms, scaled by 10*waterlevel -- with a documented first-entry quirk (g_monster.cpp:291-299, 310-331)", () => {
    // On the VERY FIRST frame an entity enters lava, the lava-damage block
    // (g_monster.cpp:291-299) sets damage_debounce_time to level.time+100ms,
    // but the FL_INWATER transition block that runs immediately afterward
    // in the SAME call (g_monster.cpp:310-331, reached because FL_INWATER
    // wasn't set yet) unconditionally resets damage_debounce_time back to
    // 0_ms. The debounce timer only actually "sticks" starting on the
    // SECOND call, once FL_INWATER is already latched. Verified by reading
    // the C++ source's block order twice; preserved exactly, not "fixed".
    setupWorld(1);
    const e = makeMonster(1);
    e.waterlevel = WaterLevelT.WATER_WAIST; // 2
    e.watertype = ContentsT.CONTENTS_LAVA;
    e.air_finished = Gtime_from_ms(100000); // avoid tripping the drowning branch
    level.time = Gtime_from_ms(1000);

    M_WorldEffects(e); // first entry
    expect(e.health).toBe(100 - 10 * 2);
    expect(e.damage_debounce_time).toBe(GTIME_ZERO); // clobbered by the FL_INWATER transition
    expect((e.flags & EntFlagsT.FL_INWATER) !== 0n).toBe(true);

    M_WorldEffects(e); // FL_INWATER already latched -> debounce isn't clobbered this time
    expect(e.health).toBe(100 - 10 * 2 * 2);
    expect(e.damage_debounce_time).toBe(Gtime_from_ms(1000 + 100));

    M_WorldEffects(e); // still within the 100ms window -> gated
    expect(e.health).toBe(100 - 10 * 2 * 2);

    level.time = Gtime_from_ms(1101); // strictly past the 1100 debounce (comparison is `<`, not `<=`)
    M_WorldEffects(e);
    expect(e.health).toBe(100 - 10 * 2 * 3);
  });

  test("FL_INWATER flag and watr_in/watr_out sounds toggle on the water-level transition (g_monster.cpp:281-332)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.air_finished = Gtime_from_ms(100000);
    level.time = Gtime_from_ms(0);

    // enter water
    e.waterlevel = WaterLevelT.WATER_FEET;
    e.watertype = ContentsT.CONTENTS_WATER;
    M_WorldEffects(e);
    expect((e.flags & EntFlagsT.FL_INWATER) !== 0n).toBe(true);
    expect(rec.soundCalls).toContain("player/watr_in.wav");

    // leave water
    e.waterlevel = WaterLevelT.WATER_NONE;
    M_WorldEffects(e);
    expect((e.flags & EntFlagsT.FL_INWATER) !== 0n).toBe(false);
    expect(rec.soundCalls).toContain("player/watr_out.wav");
  });
});

// ---------------------------------------------------------------------------
// M_droptofloor / M_droptofloor_generic (g_monster.cpp:335-391)
// ---------------------------------------------------------------------------

describe("M_droptofloor", () => {
  test("snaps origin to the trace endpos when a floor exists within range (g_monster.cpp:361-369, 386-388)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    e.mins = vec3(-16, -16, -24);
    e.maxs = vec3(16, 16, 32);
    e.s.origin = vec3(0, 0, 100);
    e.gravityVector = vec3(0, 0, -1);

    traceImpl = (_s, _mn, _mx, end) => {
      // pretend the floor is at z=10, regardless of the requested end
      const t = noHitTrace(vec3(end[0], end[1], 10));
      t.fraction = 0.5;
      t.plane.normal = vec3(0, 0, 1);
      return t;
    };

    const result = M_droptofloor(e);
    expect(result).toBe(true);
    expect(e.s.origin[2]).toBeCloseTo(10);
  });

  test("returns false when no floor is found within the 256-unit drop (g_monster.cpp:363-364)", () => {
    setupWorld(1);
    const origin = vec3(0, 0, 100);
    const mins = vec3(-16, -16, -24);
    const maxs = vec3(16, 16, 32);
    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end); // fraction stays 1 -- never hits anything
    const result = M_droptofloor_generic(origin, mins, maxs, false, null, ContentsT.CONTENTS_SOLID, true);
    expect(result).toBe(false);
    expect(origin[2]).toBeCloseTo(100); // untouched
  });
});

// ---------------------------------------------------------------------------
// M_ProcessPain (g_monster.cpp:649-744) -- the KEX deferred-pain queue drain
// ---------------------------------------------------------------------------

describe("M_ProcessPain", () => {
  test("no-ops when the queue (damage_blood) is empty (g_monster.cpp:651-652)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    let painCalled = false;
    e.pain = () => {
      painCalled = true;
    };
    e.monsterinfo.damage_blood = 0;
    M_ProcessPain(e);
    expect(painCalled).toBe(false);
  });

  test("alive path: calls pain() with the queued attacker/knockback/blood/mod, then resets the queue (g_monster.cpp:723-734)", () => {
    const { edicts } = setupWorld(2);
    const e = makeMonster(1);
    const attacker = makeLiveEdict(2);
    e.health = 50;
    e.monsterinfo.damage_blood = 12;
    e.monsterinfo.damage_knockback = 30;
    e.monsterinfo.damage_attacker = attacker;
    e.monsterinfo.damage_inflictor = attacker;

    const calls: { other: EdictT; kick: number; damage: number }[] = [];
    e.pain = (_self, other, kick, damage) => {
      calls.push({ other, kick, damage });
    };

    M_ProcessPain(e);

    expect(calls).toEqual([{ other: attacker, kick: 30, damage: 12 }]);
    expect(e.monsterinfo.damage_blood).toBe(0);
    expect(e.monsterinfo.damage_knockback).toBe(0);
    expect(e.monsterinfo.damage_attacker).toBeNull();
    expect(e.monsterinfo.damage_inflictor).toBeNull();
    void edicts;
  });

  test("death path: calls die() with the queued inflictor/attacker/blood, fires monster_death_use, clears touch (g_monster.cpp:669-701)", () => {
    setupWorld(2);
    const e = makeMonster(1);
    const attacker = makeLiveEdict(2);
    e.health = 0;
    e.deadflag = false;
    e.monsterinfo.damage_blood = 40;
    e.monsterinfo.damage_attacker = attacker;
    e.monsterinfo.damage_inflictor = attacker;
    e.touch = () => {};

    const dieCalls: { inflictor: EdictT; attacker: EdictT; damage: number }[] = [];
    e.die = (_self, inflictor, dieAttacker, damage) => {
      dieCalls.push({ inflictor, attacker: dieAttacker, damage });
    };

    M_ProcessPain(e);

    expect(dieCalls).toEqual([{ inflictor: attacker, attacker, damage: 40 }]);
    expect(e.touch).toBeNull(); // monster_death_use's target-firing ran before die(), but touch is cleared unconditionally on the death branch
    expect(e.enemy).toBe(attacker); // e.enemy = e.monsterinfo.damage_attacker (g_monster.cpp:671)
  });

  test("queue fields (damage_blood/knockback/attacker/inflictor) are always reset after processing, even on the death path", () => {
    setupWorld(2);
    const e = makeMonster(1);
    const attacker = makeLiveEdict(2);
    e.health = 0;
    e.monsterinfo.damage_blood = 999;
    e.monsterinfo.damage_knockback = 50;
    e.monsterinfo.damage_attacker = attacker;
    e.monsterinfo.damage_inflictor = attacker;
    e.die = () => {};

    M_ProcessPain(e);

    expect(e.monsterinfo.damage_blood).toBe(0);
    expect(e.monsterinfo.damage_knockback).toBe(0);
    expect(e.monsterinfo.damage_attacker).toBeNull();
    expect(e.monsterinfo.damage_inflictor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M_SetAnimation / M_MoveFrame (g_monster.cpp:465-611)
// ---------------------------------------------------------------------------

describe("M_SetAnimation", () => {
  test("instant=true swaps active_move immediately, clears next_move, and frees stale beams (g_monster.cpp:467-486)", () => {
    setupWorld(2);
    const e = makeLiveEdict(1);
    // index must be past G_FreeEdict's "special edict" reserved range
    // (maxclients(4) + BODY_QUEUE_SIZE(8) = 12, see g_utils.ts) or the free
    // silently no-ops.
    const beam = makeLiveEdict(13);
    e.beam = beam;
    const moveA = makeMove(0, 3);
    const moveB = makeMove(10, 12);
    e.monsterinfo.active_move = moveA;
    e.monsterinfo.next_move = moveA;

    M_SetAnimation(e, moveB, true);

    expect(e.monsterinfo.active_move).toBe(moveB);
    expect(e.monsterinfo.next_move).toBeNull();
    expect(e.beam).toBeNull();
    expect(beam.inuse).toBe(false); // G_FreeEdict reset it
  });

  test("instant=false only stages next_move; active_move is untouched (g_monster.cpp:488-490)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    const moveA = makeMove(0, 3);
    const moveB = makeMove(10, 12);
    e.monsterinfo.active_move = moveA;

    M_SetAnimation(e, moveB, false);

    expect(e.monsterinfo.active_move).toBe(moveA);
    expect(e.monsterinfo.next_move).toBe(moveB);
  });
});

describe("M_MoveFrame", () => {
  test("promotes a staged next_move and snaps s.frame to its firstframe (g_monster.cpp:507-511, 561-565)", () => {
    setupWorld(1);
    const e = makeLiveEdict(1);
    const moveA = makeMove(0, 3);
    const moveB = makeMove(10, 12);
    e.monsterinfo.active_move = moveA;
    e.monsterinfo.next_move = moveB;
    e.monsterinfo.next_move_time = GTIME_ZERO; // <= level.time -> run_frame true
    e.s.frame = 1; // inside moveA's range, outside moveB's

    M_MoveFrame(e);

    expect(e.monsterinfo.active_move).toBe(moveB);
    expect(e.monsterinfo.next_move).toBeNull();
    expect(e.s.frame).toBe(10); // move.firstframe
  });
});

// ---------------------------------------------------------------------------
// monster_death_use (g_monster.cpp:1144-1182)
// ---------------------------------------------------------------------------

describe("monster_death_use", () => {
  test("fires self.target's use() with the current enemy as activator (g_monster.cpp:1173-1174)", () => {
    const { edicts } = setupWorld(3);
    const self = makeLiveEdict(1);
    const enemy = makeLiveEdict(2);
    const targetEnt = g_edicts[3]!;
    targetEnt.inuse = true;
    targetEnt.targetname = "relay1";
    globals.num_edicts = 4;

    self.target = "relay1";
    self.enemy = enemy;

    const useCalls: { other: EdictT | null; activator: EdictT | null }[] = [];
    targetEnt.use = (_self, other, activator) => {
      useCalls.push({ other, activator });
    };

    monster_death_use(self);

    expect(useCalls).toEqual([{ other: self, activator: enemy }]);
    void edicts;
  });

  test("deathtarget overrides target before firing (g_monster.cpp:1170-1174)", () => {
    setupWorld(3);
    const self = makeLiveEdict(1);
    const targetEnt = g_edicts[2]!;
    targetEnt.inuse = true;
    targetEnt.targetname = "on_death";
    globals.num_edicts = 3;

    self.target = "ignored_target";
    self.deathtarget = "on_death";

    let fired = false;
    targetEnt.use = () => {
      fired = true;
    };

    monster_death_use(self);

    expect(fired).toBe(true);
    expect(self.target).toBe("on_death");
  });

  test("healthtarget fires as a second, separate G_UseTargets call after target (g_monster.cpp:1176-1181)", () => {
    setupWorld(4);
    const self = makeLiveEdict(1);
    const mainTarget = g_edicts[2]!;
    mainTarget.inuse = true;
    mainTarget.targetname = "main";
    const healthTarget = g_edicts[3]!;
    healthTarget.inuse = true;
    healthTarget.targetname = "onhealth";
    globals.num_edicts = 4;

    self.target = "main";
    self.healthtarget = "onhealth";

    const order: string[] = [];
    mainTarget.use = () => order.push("main");
    healthTarget.use = () => order.push("health");

    monster_death_use(self);

    expect(order).toEqual(["main", "health"]);
  });
});
