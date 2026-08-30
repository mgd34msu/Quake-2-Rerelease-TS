/*
Unit tests for the ROGUE mission pack "system" modules ported under
src/kexgame/rogue/ (2023 Quake II re-release / "KEX" engine, GPLv2).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Fixture modeled after test/kexgame_g_phys.test.ts's
own fake-imports fixture (same shape: mutable `traceImpl`/`pointcontentsImpl`
per-test hooks, `linkentity` recomputes absmin/absmax from origin+mins/maxs).
The default `traceImpl` (`noHitTrace`) always returns `fraction: 1`, which
makes g_ai.ts's `visible(a, b)` return true for any two entities unless a
test overrides `traceImpl` -- used throughout the hint-path tests below so
"is X visible to Y" is never the accidental reason a case fails.

Cases (grouped by source module, each citing the exact C++ line range it
exercises):

  rogue/g_rogue_phys.ts (SV_Physics_NewToss, rogue/g_rogue_phys.cpp:16-118):
    - a 1-frame free-fall arc under gravity with no ground under it.
    - a resting entity on flat ground with zero velocity returns without
      moving (the "sitting on something flat" early-out).
    - a water-transition sound fires exactly once crossing into water.

  rogue/g_rogue_newai.ts hint paths (rogue/g_rogue_newai.cpp:259-891):
    - SP_hint_path (790-811): sets up solid/touch/mins/maxs/svflags on a
      valid (targetname-or-target-having) entity; frees an unlinked one.
    - InitHintPaths (816-891): links a 2-node target/targetname chain into
      hint_path_start[0] via `.hint_chain`, sets hint_chain_id on both.
    - monsterlost_checkhint (414-715): finds a valid hint chain when both
      the monster and its enemy can see chain nodes within 512 units, sets
      monsterinfo.goal_hint, and drives the monster onto the chain via
      hintpath_go (self.goalentity/movetarget set, AI_HINT_PATH flag set,
      monsterinfo.run invoked); returns false with no hint paths spawned
      (the exact early-out this port line's g_ai.ts used to hard-code
      before this file landed); returns false when the monster has no
      enemy.
    - hintpath_stop (379-406): clears AI_HINT_PATH/goalentity/movetarget
      and re-hunts a still-valid, visible enemy via FoundTarget.

  rogue/g_rogue_newai.ts tesla / bad-area (rogue/g_rogue_newai.cpp:947-1073):
    - SpawnBadArea (955-985): spawns a "bad_area" trigger volume centered
      between mins/maxs, offset mins/maxs relative to that center, with an
      auto-free think when given a nonzero lifespan.
    - CheckForBadArea (1000-1015): finds a bad_area entity via the real
      `touch === badarea_touch` identity filter (not a classname guess).
    - MarkTeslaArea (1019-1073): spawns a bad_area around a tesla's
      teamchain trigger (using the trigger's own absmin/absmax) and links
      it onto the tesla's team chain; returns false without spawning a
      second one if a bad_area is already team-linked.
    - TargetTesla (1472-1503): redirects a monster's `.enemy` onto the
      tesla and invokes monsterinfo.attack.

  rogue/g_rogue_monster.ts / rogue/g_rogue_misc.ts / rogue/g_rogue_combat.ts
  (small full-file ports):
    - misc_nuke_core_use (rogue/g_rogue_misc.cpp:8-14): toggles SVF_NOCLIENT.
    - M_SlotsLeft (rogue/g_rogue_monster.cpp:105-108, re-exported from
      m_medic.ts): monster_slots - monster_used.
    - T_RadiusClassDamage (rogue/g_rogue_combat.cpp:114-143): damages an
      entity in radius while exempting one whose classname matches
      `ignoreClass`.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, MonsterAiFlagsT, ModIdT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { SpawnFlags_from } from "../src/kexgame/spawnflags";

import { SV_Physics_NewToss } from "../src/kexgame/rogue/g_rogue_phys";
import {
  SP_hint_path,
  InitHintPaths,
  monsterlost_checkhint,
  hintpath_stop,
  SpawnBadArea,
  CheckForBadArea,
  MarkTeslaArea,
  TargetTesla,
  badarea_touch,
} from "../src/kexgame/rogue/g_rogue_newai";
import { misc_nuke_core_use } from "../src/kexgame/rogue/g_rogue_misc";
import { M_SlotsLeft } from "../src/kexgame/rogue/g_rogue_monster";
import { T_RadiusClassDamage } from "../src/kexgame/rogue/g_rogue_combat";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (modeled on
// test/kexgame_g_phys.test.ts's own fixture)
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

let traceImpl: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: number) => KexTraceT = (
  _start,
  _mins,
  _maxs,
  end,
) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;
let boxEdictsImpl: (mins: Vec3, maxs: Vec3, list: (KexEdictT | null)[], maxcount: number, areatype: number) => number = () => 0;
const soundLog: string[] = [];

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
    positioned_sound(_origin, _ent, _chan, soundIndex) {
      soundLog.push(`sound:${soundIndex}`);
    },
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
    soundindex(name) {
      return name === "misc/h2ohit1.wav" ? 42 : 1;
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
    BoxEdicts(mins, maxs, list, maxcount, areatype) {
      return boxEdictsImpl(mins, maxs, list, maxcount, areatype);
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

const RAW_EDICT_SLOTS = 32;

/** Preallocates a fixed pool of raw edict slots (matching
 *  test/kexgame_g_phys.test.ts's own fixture -- G_Spawn (g_utils.ts) starts
 *  its free-slot search at `game.maxclients + 1` and needs headroom beyond
 *  `numEdicts` to find a slot); `numEdicts` only sets the logical starting
 *  `globals.num_edicts`. Wires up gi/globals/g_edicts/game/level. */
function setupWorld(numEdicts: number): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < RAW_EDICT_SLOTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 4;
  game.maxentities = RAW_EDICT_SLOTS;
  level.time = Gtime_from_ms(0);
  level.gravity = 800;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;
  boxEdictsImpl = () => 0;
  soundLog.length = 0;

  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts };
}

function freeEdict(edicts: EdictT[], i: number): EdictT {
  const e = edicts[i]!;
  e.inuse = true;
  e.s.number = i;
  return e;
}

// ---------------------------------------------------------------------------
// SV_Physics_NewToss (rogue/g_rogue_phys.cpp:16-118)
// ---------------------------------------------------------------------------

describe("SV_Physics_NewToss (rogue/g_rogue_phys.cpp:16-118)", () => {
  test("free-falls under gravity for one frame with no ground under it", () => {
    const { edicts } = setupWorld(4);
    const ent = freeEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 100);
    ent.mins = vec3(-8, -8, -8);
    ent.maxs = vec3(8, 8, 8);
    ent.gravity = 1;
    ent.gravityVector = vec3(0, 0, -1);
    ent.velocity = vec3(0, 0, 0);
    ent.clipmask = 1; // MASK_SOLID-equivalent, unused by the no-hit trace fixture

    // no ground under the entity at any point in this test
    traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);

    SV_Physics_NewToss(ent);

    // gravity*level.gravity*frame_time_s = 1 * 800 * 0.1 = 80 units/s added
    // to velocity.z (SV_AddGravity), matching g_phys.ts's own SV_AddGravity
    // formula (this file imports the exact same function, not a copy). With
    // no groundentity, SV_Physics_NewToss then applies air friction to the
    // WHOLE velocity vector (not just horizontal components) before FlyMove
    // runs (rogue/g_rogue_phys.cpp:73-91: speed=80, newspeed=80-sv_friction(6)=74,
    // ent->velocity *= newspeed/speed), so the post-frame value is
    // -80 * (74/80) = -74, not the pre-friction -80.
    expect(ent.velocity[2]).toBeCloseTo(-74, 5);
    // the entity actually moved (SV_FlyMove ran) -- origin.z decreased.
    expect(ent.s.origin[2]).toBeLessThan(100);
  });

  test("a resting entity on flat ground with zero velocity does not move", () => {
    const { edicts } = setupWorld(4);
    const ground = freeEdict(edicts, 1);
    ground.s.origin = vec3(0, 0, 0);
    ground.inuse = true;

    const ent = freeEdict(edicts, 2);
    ent.s.origin = vec3(0, 0, 100);
    ent.mins = vec3(-8, -8, -8);
    ent.maxs = vec3(8, 8, 8);
    ent.velocity = vec3(0, 0, 0);
    ent.groundentity = ground;

    // the "find out what we're sitting on" probe hits flat ground (normal
    // straight up) directly under the entity.
    traceImpl = (_start, _mins, _maxs, end) => {
      const t = noHitTrace(end);
      t.fraction = 0.5;
      t.plane.normal = vec3(0, 0, 1);
      t.ent = ground;
      return t;
    };

    const before = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
    SV_Physics_NewToss(ent);

    expect(ent.s.origin[0]).toBe(before[0]);
    expect(ent.s.origin[1]).toBe(before[1]);
    expect(ent.s.origin[2]).toBe(before[2]);
  });

  test("fires the water-transition sound exactly once when crossing into water", () => {
    const { edicts } = setupWorld(4);
    const ent = freeEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 100);
    ent.mins = vec3(-8, -8, -8);
    ent.maxs = vec3(8, 8, 8);
    ent.velocity = vec3(0, 0, -10);
    ent.watertype = 0;
    ent.waterlevel = 0;

    traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
    // CONTENTS_WATER bit -- matches ContentsT.CONTENTS_WATER = bit(5) = 32.
    pointcontentsImpl = () => 32;

    SV_Physics_NewToss(ent);

    expect(soundLog).toEqual(["sound:42"]);
  });
});

// ---------------------------------------------------------------------------
// hint paths (rogue/g_rogue_newai.cpp:259-891)
// ---------------------------------------------------------------------------

const SPAWNFLAG_HINT_ENDPOINT = SpawnFlags_from(0x0001);

describe("hint paths (rogue/g_rogue_newai.cpp:259-891)", () => {
  test("SP_hint_path sets up a valid targetname/target entity as a trigger", () => {
    const { edicts } = setupWorld(4);
    const node = freeEdict(edicts, 1);
    node.targetname = "h_end";
    node.target = null;

    SP_hint_path(node);

    expect(node.inuse).toBe(true);
    expect(node.solid).toBe(SolidT.SOLID_TRIGGER);
    expect(node.touch).not.toBeNull();
    expect(node.mins).toEqual(vec3(-8, -8, -8));
    expect(node.maxs).toEqual(vec3(8, 8, 8));
    expect((node.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(true);
  });

  test("SP_hint_path frees an entity with neither targetname nor target", () => {
    const { edicts } = setupWorld(4);
    // G_FreeEdict (g_utils.ts, matching g_utils.cpp:387-393) refuses to
    // actually free "special" edicts at index <= maxclients + BODY_QUEUE_SIZE
    // (4 + 8 = 12 here) -- that reserved range covers player slots and the
    // body queue. Use an index above it so freeing is observable, unlike
    // this file's other fixture entities (indices 1-4), which never rely on
    // G_FreeEdict's inuse-flip.
    const node = freeEdict(edicts, 13);
    node.targetname = null;
    node.target = null;

    SP_hint_path(node);

    expect(node.inuse).toBe(false);
  });

  test("InitHintPaths links a 2-node target/targetname chain and sets hint_chain_id", () => {
    const { edicts } = setupWorld(4);

    const nodeA = freeEdict(edicts, 1);
    nodeA.classname = "hint_path";
    nodeA.target = "h_b";
    nodeA.targetname = null;
    nodeA.spawnflags = SPAWNFLAG_HINT_ENDPOINT;

    const nodeB = freeEdict(edicts, 2);
    nodeB.classname = "hint_path";
    nodeB.target = null;
    nodeB.targetname = "h_b";
    nodeB.spawnflags = SPAWNFLAG_HINT_ENDPOINT;

    InitHintPaths();

    expect(nodeA.hint_chain).toBe(nodeB);
    expect(nodeA.hint_chain_id).toBe(0);
    expect(nodeB.hint_chain_id).toBe(0);
  });

  test("monsterlost_checkhint returns false when no hint_path entities exist on the map", () => {
    const { edicts } = setupWorld(4);
    InitHintPaths();

    const self = freeEdict(edicts, 1);
    self.classname = "monster_test";
    self.enemy = freeEdict(edicts, 2);

    expect(monsterlost_checkhint(self)).toBe(false);
  });

  test("monsterlost_checkhint returns false when the monster has no enemy", () => {
    const { edicts } = setupWorld(4);

    const nodeA = freeEdict(edicts, 1);
    nodeA.classname = "hint_path";
    nodeA.target = "h_b";
    nodeA.spawnflags = SPAWNFLAG_HINT_ENDPOINT;
    const nodeB = freeEdict(edicts, 2);
    nodeB.classname = "hint_path";
    nodeB.targetname = "h_b";
    nodeB.spawnflags = SPAWNFLAG_HINT_ENDPOINT;
    InitHintPaths();

    const self = freeEdict(edicts, 3);
    self.classname = "monster_test";
    self.enemy = null;

    expect(monsterlost_checkhint(self)).toBe(false);
  });

  test("monsterlost_checkhint finds a valid chain, sets goal_hint, and drives the monster onto it", () => {
    const { edicts } = setupWorld(6);

    const nodeA = freeEdict(edicts, 1);
    nodeA.classname = "hint_path";
    nodeA.target = "h_b";
    nodeA.spawnflags = SPAWNFLAG_HINT_ENDPOINT;
    nodeA.s.origin = vec3(0, 0, 0);

    const nodeB = freeEdict(edicts, 2);
    nodeB.classname = "hint_path";
    nodeB.targetname = "h_b";
    nodeB.spawnflags = SPAWNFLAG_HINT_ENDPOINT;
    nodeB.s.origin = vec3(100, 0, 0);

    InitHintPaths();

    const self = freeEdict(edicts, 3);
    self.classname = "monster_test";
    self.s.origin = vec3(10, 0, 0);

    const enemy = freeEdict(edicts, 4);
    enemy.s.origin = vec3(90, 0, 0);
    self.enemy = enemy;

    let ranCalled = 0;
    self.monsterinfo.run = (): void => {
      ranCalled++;
    };

    // default traceImpl (no-hit) makes g_ai.ts's `visible` return true for
    // any pair of entities, so every distance/visibility filter in
    // monsterlost_checkhint passes based on realrange (<= 512) alone.
    const result = monsterlost_checkhint(self);

    expect(result).toBe(true);
    expect(self.monsterinfo.goal_hint).not.toBeNull();
    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HINT_PATH) !== 0n).toBe(true);
    expect(self.goalentity).not.toBeNull();
    expect(ranCalled).toBe(1);
  });

  test("hintpath_stop clears AI_HINT_PATH and re-hunts a still-valid enemy", () => {
    const { edicts } = setupWorld(4);
    const self = freeEdict(edicts, 1);
    self.monsterinfo.aiflags = MonsterAiFlagsT.AI_HINT_PATH;
    const priorGoal: EdictT | null = self;
    self.goalentity = priorGoal;
    self.movetarget = priorGoal;

    const enemy = freeEdict(edicts, 2);
    enemy.health = 100;
    self.enemy = enemy;

    let foundCalled = 0;
    self.monsterinfo.stand = (): void => {
      throw new Error("should not stand -- enemy is still valid and visible");
    };
    // FoundTarget (g_ai.ts) is the real function; it needs a few
    // monsterinfo fields wired to run without throwing.
    self.monsterinfo.run = (): void => {
      foundCalled++;
    };
    self.monsterinfo.aiflags = MonsterAiFlagsT.AI_HINT_PATH;

    hintpath_stop(self);

    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HINT_PATH) !== 0n).toBe(false);
    // FoundTarget (g_ai.cpp:524-528) has no self->combattarget here, so it
    // falls through to HuntTarget, which sets self->goalentity = self->enemy
    // (g_ai.cpp:472) -- "re-hunts" means goalentity ends up pointed at the
    // enemy, not cleared. self->movetarget is untouched by HuntTarget, so it
    // stays null from hintpath_stop's own reset (g_rogue_newai.cpp:382).
    expect(self.goalentity).toBe(enemy);
    expect(self.movetarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tesla / bad-area (rogue/g_rogue_newai.cpp:947-1073)
// ---------------------------------------------------------------------------

describe("tesla / bad-area (rogue/g_rogue_newai.cpp:947-1073)", () => {
  test("SpawnBadArea creates a bad_area centered between mins/maxs with offset bounds", () => {
    const { edicts } = setupWorld(4);
    void edicts;

    const mins = vec3(-10, -20, -30);
    const maxs = vec3(10, 20, 30);
    const area = SpawnBadArea(mins, maxs, GTIME_ZERO, null);

    expect(area.classname).toBe("bad_area");
    expect(area.s.origin[0]).toBeCloseTo(0, 5);
    expect(area.s.origin[1]).toBeCloseTo(0, 5);
    expect(area.s.origin[2]).toBeCloseTo(0, 5);
    expect(area.mins[0]).toBeCloseTo(-10, 5);
    expect(area.maxs[0]).toBeCloseTo(10, 5);
    expect(area.touch).toBe(badarea_touch);
  });

  test("SpawnBadArea with a nonzero lifespan schedules an auto-free think", () => {
    const { edicts } = setupWorld(4);
    void edicts;

    const area = SpawnBadArea(vec3(0, 0, 0), vec3(16, 16, 16), Gtime_from_sec(30), null);

    expect(area.think).not.toBeNull();
    expect(area.nextthink).toBe(Gtime_from_sec(30));
  });

  test("CheckForBadArea finds a bad_area entity by real touch-identity, not classname", () => {
    const { edicts } = setupWorld(4);

    const ent = freeEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 0);
    ent.mins = vec3(-16, -16, -16);
    ent.maxs = vec3(16, 16, 16);

    const area = SpawnBadArea(vec3(-8, -8, -8), vec3(8, 8, 8), GTIME_ZERO, null);
    boxEdictsImpl = (_mins, _maxs, list) => {
      list[0] = area;
      return 1;
    };

    const hit = CheckForBadArea(ent);
    expect(hit).toBe(area);
  });

  test("CheckForBadArea returns null when BoxEdicts finds nothing", () => {
    const { edicts } = setupWorld(4);
    const ent = freeEdict(edicts, 1);
    boxEdictsImpl = () => 0;

    expect(CheckForBadArea(ent)).toBeNull();
  });

  test("MarkTeslaArea spawns a bad_area around the tesla's teamchain trigger and links it", () => {
    const { edicts } = setupWorld(6);

    const tesla = freeEdict(edicts, 1);
    tesla.classname = "tesla_mine";
    tesla.mins = vec3(-16, -16, -16);

    const trigger = freeEdict(edicts, 2);
    trigger.absmin = vec3(-32, -32, -32);
    trigger.absmax = vec3(32, 32, 32);
    tesla.teamchain = trigger;

    const self = freeEdict(edicts, 3);

    const result = MarkTeslaArea(self, tesla);

    expect(result).toBe(true);
    expect(trigger.teamchain).not.toBeNull();
    expect(trigger.teamchain?.classname).toBe("bad_area");
  });

  test("MarkTeslaArea refuses to double-mark a tesla that already has a bad_area on its team chain", () => {
    const { edicts } = setupWorld(6);

    const tesla = freeEdict(edicts, 1);
    tesla.classname = "tesla_mine";

    const existingArea = freeEdict(edicts, 2);
    existingArea.classname = "bad_area";
    tesla.teamchain = existingArea;

    const self = freeEdict(edicts, 3);

    expect(MarkTeslaArea(self, tesla)).toBe(false);
  });

  test("TargetTesla redirects the monster's enemy onto the tesla and calls monsterinfo.attack", () => {
    const { edicts } = setupWorld(4);

    const self = freeEdict(edicts, 1);
    // TargetTesla (g_rogue_newai.cpp:1495-1497) bails out before calling
    // monsterinfo.attack when self->health <= 0 -- freeEdict's underlying
    // defaultEdict() defaults health to 0, so a live monster must say so.
    self.health = 100;
    const oldEnemy = freeEdict(edicts, 2);
    self.enemy = oldEnemy;

    const tesla = freeEdict(edicts, 3);
    tesla.classname = "tesla_mine";

    let attackCalled = 0;
    self.monsterinfo.attack = (): void => {
      attackCalled++;
    };

    TargetTesla(self, tesla);

    expect(self.enemy).toBe(tesla);
    expect(self.oldenemy).toBe(oldEnemy);
    expect(attackCalled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// small full-file rogue ports (misc / monster / combat)
// ---------------------------------------------------------------------------

describe("g_rogue_misc.ts / g_rogue_monster.ts / g_rogue_combat.ts", () => {
  test("misc_nuke_core_use toggles SVF_NOCLIENT", () => {
    const { edicts } = setupWorld(4);
    const core = freeEdict(edicts, 1);
    core.svflags = 0;

    misc_nuke_core_use(core, null, null);
    expect((core.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(true);

    misc_nuke_core_use(core, null, null);
    expect((core.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(false);
  });

  test("M_SlotsLeft returns monster_slots minus monster_used", () => {
    const { edicts } = setupWorld(4);
    const self = freeEdict(edicts, 1);
    self.monsterinfo.monster_slots = 5;
    self.monsterinfo.monster_used = 2;

    expect(M_SlotsLeft(self)).toBe(3);
  });

  test("T_RadiusClassDamage exempts an entity whose classname matches ignoreClass", () => {
    const { edicts } = setupWorld(4);

    const inflictor = freeEdict(edicts, 1);
    inflictor.s.origin = vec3(0, 0, 0);

    const attacker = freeEdict(edicts, 2);

    const spared = freeEdict(edicts, 3);
    spared.classname = "spared_kind";
    spared.s.origin = vec3(10, 0, 0);
    spared.takedamage = true;
    const spared_health_before = 100;
    spared.health = spared_health_before;

    boxEdictsImpl = () => 0; // not exercised by findradius (g_utils.ts), only relevant to BoxEdicts-based lookups

    T_RadiusClassDamage(inflictor, attacker, 50, "spared_kind", 128, { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false });

    // findradius (g_utils.ts) walks g_edicts directly, not via BoxEdicts, so
    // this exercises the real classname-exemption branch: `spared`'s health
    // is untouched because its classname matches ignoreClass.
    expect(spared.health).toBe(spared_health_before);
  });
});
