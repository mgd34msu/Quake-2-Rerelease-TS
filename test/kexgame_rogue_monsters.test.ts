/*
Unit tests for the kex m_rogue_stalker.cpp/m_rogue_turret.cpp/
m_rogue_carrier.cpp/m_rogue_widow.cpp/m_rogue_widow2.cpp ports
(src/kexgame/m_rogue_stalker.ts, m_rogue_turret.ts, m_rogue_carrier.ts,
m_rogue_widow.ts, m_rogue_widow2.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. The fixture (fake gi/game/level fixture, mutable
per-test `traceImpl` hook, `makeMonster`/`setupWorld`/`stepFrame`/
`pendingOrActiveMove`/`requireMmove` helpers) is copied verbatim from
test/kexgame_monsters5.test.ts's own established pattern (itself copied from
test/kexgame_monsters2.test.ts / test/kexgame_monsters1.test.ts /
test/kexgame_g_monster.test.ts), kept module-private per that same
precedent.

Design note on reaching per-file internals without new exports: several of
the mmove tables and per-frame thinkfuncs this suite exercises
(stalker_swing_attack, TurretFire, CarrierGrenade, WidowSaveLoc/WidowRail,
Widow2Crunch, and the non-exported `*_move_stand`/`*_move_run`/
`*_move_attack_*` MmoveT constants) are module-private in their own files.
This suite reaches all of it through the SAME save-registry the real game
uses for save/load -- `LookupMmove` by the literal C++ function name each
file registered it under -- exactly like kexgame_monsters5.test.ts's own
"Design note". No new exports were added to any of the five files for
testability alone.

Scope (16 cases, each citing the exact C++/TS line(s) it exercises):

  STALKER (m_rogue_stalker.cpp) -- ceiling-walk monster:
    - mmove sanity: stalker_move_run's frame array satisfies
      lastframe-firstframe+1, and SP_monster_stalker is a function.
    - animation transition: stalker_run w/ AI_STAND_GROUND picks
      stalker_move_stand instead of stalker_move_run (m_rogue_stalker.cpp:
      887-897 region context; transition itself at the `stalker_run`
      definition mirroring every other monster's stand/run split).
    - attack constant: stalker_swing_attack's fire_hit call, damage
      irandom(5,10) kick=50 (m_rogue_stalker.cpp:? -- ported at
      src/kexgame/m_rogue_stalker.ts's own `stalker_swing_attack`, reached
      via stalker_move_swing_l's fifth frame).
    - distinctive: stalker_physics_change flips gravityVector[2] to -1 and
      adds 180 (with wraparound) to s.angles[2] when knocked off the
      ceiling with no groundentity (m_rogue_stalker.cpp:886-896, the
      `STALKER_ON_CEILING`/`MONSTERINFO_PHYSCHANGED` hook g_phys.ts calls
      whenever groundentity truthiness flips across a frame).

  TURRET (m_rogue_turret.cpp) -- wall-mount deployable monster:
    - mmove sanity: turret_move_fire's frame array satisfies
      lastframe-firstframe+1, and SP_monster_turret is a function.
    - animation transition: turret_run w/ s.frame >= FRAME_run01 picks
      turret_move_run instead of calling turret_ready_gun
      (m_rogue_turret.cpp's `turret_run`, ported verbatim).
    - attack constant: TurretFire's machinegun path (SPAWNFLAG_TURRET_
      MACHINEGUN = 0x0010) requires two calls spaced >1s apart (a spin-up
      gate) before it calls monster_fire_bullet with damage=
      TURRET_BULLET_DAMAGE=2, kick=0.

  CARRIER (m_rogue_carrier.cpp) -- flyer/kamikaze-spawning monster:
    - mmove sanity + regression guard: carrier_move_attack_gren is
      save-registered (LookupMmove resolves it -- this file's `mkMove(...)`
      calls were NOT wrapped in RegisterMmove before this unit's fix; all
      15 of carrier.ts's own MmoveT tables would have been unreachable by
      name to the JSON save system, unlike every other ported monster file)
      and its frame array satisfies lastframe-firstframe+1;
      SP_monster_carrier is a function.
    - animation transition: carrier_attack w/ bad_area set and the enemy
      behind picks carrier_move_attack_rocket (m_rogue_carrier.cpp:
      729-746).
    - attack constant: CarrierGrenade calls monster_fire_grenade with
      damage=50 speed=600 (m_rogue_carrier.cpp:402-447 / cpp:133-197),
      observed via the spawned "grenade" edict's `dmg` field.

  WIDOW (m_rogue_widow.cpp) -- reinforcement-spawning boss, first form:
    - mmove sanity: widow_move_attack_rail's frame array satisfies
      lastframe-firstframe+1, and SP_monster_widow is a function.
    - animation transition: widow_run w/ AI_STAND_GROUND picks
      widow_move_stand instead of widow_move_run.
    - attack constant: WidowRail's monster_fire_railgun call, damage=
      WIDOW_RAIL_DAMAGE(50)*widow_damage_multiplier(1)=50, kick=100
      (m_rogue_widow.cpp:494-538), reached via widow_move_attack_rail's
      WidowSaveLoc/WidowRail frame pair.

  WIDOW2 (m_rogue_widow2.cpp) -- beam-attack boss, second form:
    - THE POST-BEAM FRAME TABLE FINDING (distinctive): unlike the legacy
      1997/2003 source's genuine 3-row/2-frame mismatch (m_widow2.c:
      339-345, preserved as a documented exemption in this repo's OLDER
      port line at src/rogue/m_widow2.ts:392-405), the KEX C++ source
      (m_rogue_widow2.cpp:288-292) FIXED the bug: a clean 2-row array for
      the 2-frame FRAME_fireb06..FRAME_fireb07 span. Asserted here as a
      clean LookupMmove("widow2_move_attack_post_beam") with
      frame.length === lastframe-firstframe+1 === 2 and no null aifunc
      slots (also a regression guard: every frame in this file originally
      had `aifunc: null` instead of the correct ai_stand/ai_walk/ai_run/
      ai_charge/ai_move, a real behavioral bug fixed in this unit).
    - animation transition: widow2_run w/ AI_STAND_GROUND picks
      widow2_move_stand instead of widow2_move_run.
    - attack constant: Widow2Crunch's fire_hit call, damage irandom(20,26)
      (m_rogue_widow2.cpp:1009-1022), reached via widow2_move_tongs'
      seventh frame (FRAME_tongs07).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, MonsterAiFlagsT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { M_SetAnimation, M_MoveFrame } from "../src/kexgame/g_monster";
import { SpawnFlags_from } from "../src/kexgame/spawnflags";
import { LookupMmove } from "../src/kexgame/g_save_registry";

// TDZ workaround (documented in .orch/followups.md: "importing batch-3
// monster modules first triggers 'Cannot access ai_stand before
// initialization' via the g_ai<->m_soldier<->g_monster cycle"). This suite
// additionally pulls in m_supertank.ts (PredictAim/BossExplode) transitively
// through the five rogue monster files below, which independently trips the
// same class of cycle through m_soldier.ts -- importing it explicitly first,
// matching test/kexgame_monsters2.test.ts's own "m_flipper before
// m_supertank" precedent, resolves it before any rogue monster file loads.
import "../src/kexgame/m_soldier";

// importing these five modules runs every MmoveT constructor in them; a
// throw here would fail the whole file before any test runs (the same
// "successful import IS an assertion" idiom kexgame_monsters1.test.ts uses
// for infantry's un-exported tables).
import { SP_monster_stalker, stalker_run, stalker_move_stand, stalker_move_run, stalker_move_swing_l, stalker_physics_change } from "../src/kexgame/m_rogue_stalker";
import { SP_monster_turret, turret_run, turret_move_run, turret_move_fire, FRAME_run01 } from "../src/kexgame/m_rogue_turret";
import { SP_monster_carrier, carrier_attack } from "../src/kexgame/m_rogue_carrier";
import { SP_monster_widow, widow_run } from "../src/kexgame/m_rogue_widow";
import { SP_monster_widow2, widow2_run } from "../src/kexgame/m_rogue_widow2";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied verbatim from
// test/kexgame_monsters5.test.ts's own module-private fixture)
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

/** A "hit" trace against `target`, for tests that need gi.trace to resolve
 *  to a specific live entity (melee/rail hitscans). */
function hitTrace(end: Vec3, target: EdictT, fraction = 0.5): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: target,
    plane2: new CplaneT(),
    surface2: null,
  };
}

let traceImpl: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: number) => KexTraceT =
  (_start, _mins, _maxs, end) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;

interface Recorder {
  soundCalls: string[];
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
    Center_Print() {},
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
    clip(_entity, _start, _mins, _maxs, end) {
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

/** Preallocates 16 blank edicts and wires up gi/globals/g_edicts/game/level. */
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
  level.time = GTIME_ZERO;
  level.gravity = 800;
  level.total_monsters = 0;
  level.killed_monsters = 0;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;
  rec = { soundCalls: [] };

  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts };
}

/** A live, non-world monster entity with sane physics defaults, a typical
 *  monster bbox, and takedamage on. */
function makeMonster(index: number, origin: Vec3 = vec3(0, 0, 0)): EdictT {
  const e = g_edicts[index]!;
  e.inuse = true;
  e.gravity = 1;
  e.gravityVector = vec3(0, 0, -1);
  e.classname = "test_monster";
  e.solid = SolidT.SOLID_BBOX;
  e.movetype = MovetypeT.MOVETYPE_STEP;
  e.svflags |= SvflagsT.SVF_MONSTER;
  e.takedamage = true;
  e.health = 100;
  e.max_health = 100;
  e.mins = vec3(-16, -16, -24);
  e.maxs = vec3(16, 16, 32);
  e.s.origin = vec3(origin[0], origin[1], origin[2]);
  e.monsterinfo.stand = () => {};
  e.monsterinfo.run = () => {};
  gi.linkentity(e);
  return e;
}

/** Forces exactly one M_MoveFrame animation step regardless of level.time
 *  pacing. */
function stepFrame(self: EdictT, times = 1): void {
  for (let i = 0; i < times; i++) {
    self.monsterinfo.next_move_time = GTIME_ZERO;
    M_MoveFrame(self);
  }
}

/** The move a monsterinfo.stand/run/etc. handler just selected, whether
 *  M_SetAnimation used instant=true (active_move updates synchronously) or
 *  instant=false (only next_move is staged). */
function pendingOrActiveMove(self: EdictT) {
  return self.monsterinfo.next_move ?? self.monsterinfo.active_move;
}

/** Fetches a save-registered mmove table by its exact C++ name, failing the
 *  test immediately (not silently skipping) if the name isn't registered. */
function requireMmove(name: string) {
  const m = LookupMmove(name);
  if (m === null) throw new Error(`LookupMmove("${name}") returned null -- not registered`);
  return m;
}

// ---------------------------------------------------------------------------
// STALKER (m_rogue_stalker.cpp)
// ---------------------------------------------------------------------------

describe("stalker", () => {
  test("mmove sanity: stalker_move_run's frame count matches lastframe-firstframe+1; SP_monster_stalker is a function", () => {
    expect(stalker_move_run.frame.length).toBe(stalker_move_run.lastframe - stalker_move_run.firstframe + 1);
    expect(stalker_move_run.allowFrameCountMismatch).toBe(false);
    expect(typeof SP_monster_stalker).toBe("function");
  });

  test("animation transition: stalker_run w/ AI_STAND_GROUND picks stalker_move_stand instead of stalker_move_run", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;

    stalker_run(self);

    expect(pendingOrActiveMove(self)).toBe(stalker_move_stand);
  });

  test("attack constant: stalker_swing_attack's fire_hit call, damage irandom(5,10) kick=50 (stalker_move_swing_l's 5th frame)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(40, 0, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    const swingAttack = stalker_move_swing_l.frame[4]?.thinkfunc ?? null;
    expect(swingAttack).not.toBeNull();
    swingAttack!(self);

    expect(enemy.health).toBeGreaterThanOrEqual(90); // 100 - damage(10 max)
    expect(enemy.health).toBeLessThanOrEqual(95); // 100 - damage(5 min)
  });

  test("distinctive: stalker_physics_change flips gravityVector[2] to -1 and adds 180 (w/ wraparound) to s.angles[2] when off the ceiling with no groundentity (m_rogue_stalker.cpp:886-896)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.gravityVector = vec3(0, 0, 1); // on the ceiling
    self.groundentity = null;
    self.s.angles = vec3(0, 0, 250);

    stalker_physics_change(self);

    expect(self.gravityVector[2]).toBe(-1);
    expect(self.s.angles[2]).toBeCloseTo(70, 5); // 250 + 180 = 430, wraps to 70

    // no-op when still on the ceiling but grounded (groundentity truthy)
    const self2 = makeMonster(2);
    self2.gravityVector = vec3(0, 0, 1);
    self2.groundentity = self; // any truthy edict
    self2.s.angles = vec3(0, 0, 10);
    stalker_physics_change(self2);
    expect(self2.gravityVector[2]).toBe(1);
    expect(self2.s.angles[2]).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// TURRET (m_rogue_turret.cpp)
// ---------------------------------------------------------------------------

describe("turret", () => {
  test("mmove sanity: turret_move_fire's frame count matches lastframe-firstframe+1; SP_monster_turret is a function", () => {
    expect(turret_move_fire.frame.length).toBe(turret_move_fire.lastframe - turret_move_fire.firstframe + 1);
    expect(turret_move_fire.allowFrameCountMismatch).toBe(false);
    expect(typeof SP_monster_turret).toBe("function");
  });

  test("animation transition: turret_run w/ s.frame >= FRAME_run01 picks turret_move_run instead of calling turret_ready_gun", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.s.frame = FRAME_run01;

    turret_run(self);

    expect(pendingOrActiveMove(self)).toBe(turret_move_run);
  });

  test("attack constant: TurretFire's machinegun path fires monster_fire_bullet with damage=TURRET_BULLET_DAMAGE=2 only after a >1s spin-up gate", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(500, 0, 0));
    self.enemy = enemy;
    self.spawnflags = SpawnFlags_from(0x0010); // SPAWNFLAG_TURRET_MACHINEGUN
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    const turretFire = turret_move_fire.frame[0]?.thinkfunc ?? null;
    expect(turretFire).not.toBeNull();

    turretFire!(self); // first call: arms the spin-up gate, does not fire
    expect(enemy.health).toBe(100);

    level.time = Gtime_add(level.time, Gtime_from_sec(1.1));
    turretFire!(self); // second call: gate elapsed, fires

    expect(enemy.health).toBe(98); // 100 - damage(2)
  });
});

// ---------------------------------------------------------------------------
// CARRIER (m_rogue_carrier.cpp)
// ---------------------------------------------------------------------------

describe("carrier", () => {
  test("mmove sanity + regression guard: carrier_move_attack_gren is save-registered and its frame count matches lastframe-firstframe+1; SP_monster_carrier is a function", () => {
    const m = requireMmove("carrier_move_attack_gren");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
    expect(typeof SP_monster_carrier).toBe("function");
  });

  test("animation transition: carrier_attack w/ bad_area set and the enemy behind picks carrier_move_attack_rocket (m_rogue_carrier.cpp:729-746)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(-500, 0, 0)); // behind self (facing +X)
    self.enemy = enemy;
    self.bad_area = enemy; // any truthy EdictT satisfies `self->bad_area`

    carrier_attack(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("carrier_move_attack_rocket"));
  });

  test("attack constant: CarrierGrenade calls monster_fire_grenade with damage=50 speed=600 (m_rogue_carrier.cpp:402-447 / 133-197)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(500, 0, 0));
    self.enemy = enemy;

    const carrierGrenade = requireMmove("carrier_move_attack_gren").frame[0]?.thinkfunc ?? null;
    expect(carrierGrenade).not.toBeNull();
    carrierGrenade!(self);

    const grenade = g_edicts.find((e) => e.inuse && e.classname === "grenade");
    expect(grenade).not.toBeUndefined();
    expect(grenade!.dmg).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// WIDOW (m_rogue_widow.cpp) -- boss #1
// ---------------------------------------------------------------------------

describe("widow", () => {
  test("mmove sanity: widow_move_attack_rail's frame count matches lastframe-firstframe+1; SP_monster_widow is a function", () => {
    const m = requireMmove("widow_move_attack_rail");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
    expect(typeof SP_monster_widow).toBe("function");
  });

  test("animation transition: widow_run w/ AI_STAND_GROUND picks widow_move_stand instead of widow_move_run", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;

    widow_run(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("widow_move_stand"));
  });

  test("attack constant: WidowRail's monster_fire_railgun call, damage=WIDOW_RAIL_DAMAGE(50)*widow_damage_multiplier(1)=50 kick=100 (m_rogue_widow.cpp:494-538)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 1500, 0));
    self.enemy = enemy;
    // long-distance pierce-safe mock (matches kexgame_monsters5.test.ts's
    // arachnid_rail precedent): a naive "always hit" mock would let the
    // rail's own pierce loop re-hit the same phantom entity forever.
    traceImpl = (start, _mins, _maxs, end) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 1000 && enemy.solid !== SolidT.SOLID_NOT) return hitTrace(end, enemy);
      return noHitTrace(end);
    };

    const railFrames = requireMmove("widow_move_attack_rail");
    const widowSaveLoc = railFrames.frame[2]?.thinkfunc ?? null;
    const widowRail = railFrames.frame[3]?.thinkfunc ?? null;
    expect(widowSaveLoc).not.toBeNull();
    expect(widowRail).not.toBeNull();

    widowSaveLoc!(self); // sets self.pos1 from self.enemy
    widowRail!(self); // fires toward self.pos1

    expect(enemy.health).toBe(50); // 100 - damage(50)
  });
});

// ---------------------------------------------------------------------------
// WIDOW2 (m_rogue_widow2.cpp) -- boss #2
// ---------------------------------------------------------------------------

describe("widow2", () => {
  test("THE POST-BEAM FRAME TABLE FINDING: widow2_move_attack_post_beam is a CLEAN 2-row table for its 2-frame span, unlike the legacy 3-row bug (m_rogue_widow2.cpp:288-292 vs m_widow2.c:339-345 / src/rogue/m_widow2.ts:392-405)", () => {
    const m = requireMmove("widow2_move_attack_post_beam");

    expect(m.lastframe - m.firstframe + 1).toBe(2);
    expect(m.frame.length).toBe(2); // the legacy source's array had 3 rows for this same 2-frame span
    expect(m.allowFrameCountMismatch).toBe(false);

    // regression guard for a real porting bug this unit fixed: every frame
    // in this file originally carried `aifunc: null` instead of the C++'s
    // `ai_charge` (and ai_stand/ai_walk/ai_run/ai_move elsewhere in the
    // file), which would have frozen the boss's movement in every state.
    for (const frame of m.frame) {
      expect(frame.aifunc).not.toBeNull();
    }
  });

  test("animation transition: widow2_run w/ AI_STAND_GROUND picks widow2_move_stand instead of widow2_move_run", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;

    widow2_run(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("widow2_move_stand"));
  });

  test("attack constant: Widow2Crunch's fire_hit call, damage irandom(20,26) (m_rogue_widow2.cpp:1009-1022), reached via widow2_move_tongs' 7th frame (FRAME_tongs07)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(40, 0, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    const tongsMove = requireMmove("widow2_move_tongs");
    const crunch = tongsMove.frame[6]?.thinkfunc ?? null;
    expect(crunch).not.toBeNull();

    self.s.frame = tongsMove.firstframe + 6; // FRAME_tongs07 -- Crunch's own frame-index branch
    crunch!(self);

    expect(enemy.health).toBeGreaterThanOrEqual(74); // 100 - damage(26 max)
    expect(enemy.health).toBeLessThanOrEqual(80); // 100 - damage(20 min)
  });
});
