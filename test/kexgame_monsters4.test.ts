/*
Unit tests for the kex m_boss2.cpp/m_boss3.cpp/m_boss31.cpp/m_boss32.cpp/
m_guncmdr.cpp ports (src/kexgame/m_boss2.ts, m_boss3.ts, m_boss31.ts,
m_boss32.ts, m_guncmdr.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. The fixture (fake gi/game/level fixture, mutable
per-test `traceImpl` hook, `makeMonster`/`setupWorld`/`stepFrame`/
`pendingOrActiveMove`/`requireMmove` helpers) is copied verbatim from
test/kexgame_monsters2.test.ts's own established module-private pattern
(itself copied from test/kexgame_monsters1.test.ts / test/kexgame_g_monster.test.ts).

Design note on reaching per-file internals without new exports: frame-level
thinkfuncs (Boss2Rocket, jorgBFG, makronBFG, GunnerCmdrGrenade,
guncmdr_fire_chain, etc.) are plain module-private functions, not
save-registry-typed (per g_local_types.ts, only prethink/think/touch/use/
pain/die/mmove/monsterinfo-* fields are save-registered). This suite reaches
them exactly the way the real per-frame move engine does: stage the real,
registry-fetched (or directly exported) mmove_t via M_SetAnimation and step
M_MoveFrame (forcing next_move_time to GTIME_ZERO each step, exactly like
kexgame_monsters2.test.ts's `stepFrame`), which runs the real frame chain
rather than reimplementing any AI. Attack constants are then read off the
REAL entity the fire helper spawned (fire_bfg/fire_rocket/fire_grenade set
`radius_dmg`/`dmg`/`dmg_radius`/`speed`/`classname` directly on the spawned
projectile edict, per g_weapon.ts) -- not asserted by re-deriving them.

Scope (17 cases, each citing the exact C++ line(s) it exercises):

  BOSS2 (m_boss2.cpp):
    - mmove sanity (import-time validation): boss2_move_death's frame array
      satisfies lastframe-firstframe+1 (49 frames, FRAME_death2..death50).
    - animation transition: boss2_stand -> boss2_run (no AI_STAND_GROUND)
      changes active_move from boss2_move_stand to boss2_move_run
      (m_boss2.cpp's boss2_run early-return-on-AI_STAND_GROUND pattern).
    - attack constant (DISTINCTIVE quirk): Boss2Rocket's non-predictive
      branch -- reached deterministically when `enemy->client` is null (a
      non-player enemy), since `self->enemy->client && frandom() < 0.9`
      short-circuits false (m_boss2.cpp:76) -- fires 4 "rocket" edicts at a
      HARDCODED speed of 500 (m_boss2.cpp:93,102,111,120), NOT the
      `BOSS2_ROCKET_SPEED` constant (750, m_boss2.cpp:37) which is reserved
      for the player-only `Boss2PredictiveRocket` burst (m_boss2.cpp:39-66).
      Verified directly against the C++ source (not just the porting
      report) before writing this test.

  JORG (m_boss31.cpp):
    - mmove sanity: jorg_move_attack2's frame array satisfies
      lastframe-firstframe+1 (13 frames, FRAME_attak201..213).
    - animation transition: jorg_stand -> jorg_run (no AI_STAND_GROUND)
      changes active_move from jorg_move_stand to jorg_move_run.
    - attack constant: jorgBFG's monster_fire_bfg call, damage=50 speed=300
      kick=100 damage_radius=200 (m_boss31.ts's jorgBFG, wired at
      jorg_move_attack2's 7th frame, 0-indexed 6).

  MAKRON (m_boss32.cpp):
    - mmove sanity: makron_move_death2's frame array satisfies
      lastframe-firstframe+1 (95 frames, FRAME_death201..295 -- the biggest
      table in this whole 5-file batch).
    - animation transition (die): makron_die (non-gib branch, m_boss32.cpp)
      sets deadflag/SVF_DEADMONSTER and calls
      `M_SetAnimation(self, &makron_move_death2, true)`.
    - attack constant: makronBFG's monster_fire_bfg call, damage=50 speed=300
      kick=100 damage_radius=300 (m_boss32.ts's makronBFG, wired at
      makron_move_attack3's 4th frame, 0-indexed 3) -- a genuine
      damage_radius DIFFERENCE from Jorg's identical-looking BFG shot (200
      vs 300), both ported exactly matching their own C++ source line.
    - DISTINCTIVE (REQUIRED): the death-head toss. `MakronToss` (called from
      `m_boss31.ts`'s `jorg_dead` when Jorg finally dies) spawns a fresh
      "monster_makron" edict, carries Jorg's `enemy`/`target`/origin over to
      it, and immediately calls `MakronSpawn` on it, which full-spawns
      Makron (`SP_monster_makron`) then launches him airborne at the
      player: horizontal velocity toward the enemy at speed 400, vertical
      velocity hardcoded to 200, `groundentity` cleared, and
      `s.frame`/`monsterinfo.nextframe` forced to `FRAME_active01`
      (m_boss32.cpp's `MakronToss`/`MakronSpawn`, "FIXME: why????" comment
      preserved verbatim).

  GUNCMDR (m_guncmdr.cpp, no legacy 3.21 precedent -- KEX-only monster):
    - mmove sanity: guncmdr_move_attack_mortar's frame array satisfies
      lastframe-firstframe+1 (21 frames, FRAME_c_attack201..221).
    - animation transition: guncmdr_fire_chain (m_guncmdr.cpp:1172-1178),
      reached as guncmdr_move_attack_chain's endfunc, picks
      guncmdr_move_fire_chain (not the "_run" variant) when `self.enemy`
      is null -- deterministic, since `self.enemy !== null` short-circuits
      the whole `range_to > RANGE_CHAINGUN_RUN(400)` condition false.
    - attack constant: GunnerCmdrGrenade's MORTAR branch (self.s.frame ===
      FRAME_c_attack205, reached at guncmdr_move_attack_mortar's 5th frame)
      spawns a "grenade" edict with dmg=50, speed=MORTAR_SPEED=850
      (m_guncmdr.cpp:853,995, RANGE_GRENADE_MORTAR gate at m_guncmdr.cpp:1134).
    - KEX-specific pattern constant (DISTINCTIVE): GunnerCmdrGrenade's FRONT
      branch (self.s.frame === FRAME_c_attack304, reached at
      guncmdr_move_attack_grenade_back's 3rd frame) spawns a "grenade" edict
      at GRENADE_SPEED=600, not MORTAR_SPEED=850 (m_guncmdr.cpp:854,997) --
      the isMortar? ternary's non-mortar path, which also carries the
      FRONT-only `pitch -= 0.05f` aim adjustment (m_guncmdr.cpp:964-965) with
      no m_gunner.ts analog (gunner has no over-the-shoulder front-toss
      pattern at all).
    - DISTINCTIVE: SP_monster_guncmdr wires `monsterinfo.dodge` to the SAME
      `M_MonsterDodge` function m_soldier.ts registers once under
      "M_MonsterDodge" -- proving guncmdr reuses the shared rogue-newai
      dodge infrastructure rather than re-registering its own copy (which
      would throw a duplicate-registration error the instant both files
      loaded together, exactly as m_soldier.ts's own header documents).

  BOSS3 (m_boss3.cpp, the pre-Makron statue prop-shell):
    - SP_monster_boss3_stand wires self.use=Use_Boss3, self.think=
      Think_Boss3Stand, self.s.frame=FRAME_stand201 (m_boss3.cpp:34-63).
    - Think_Boss3Stand cycles s.frame from FRAME_stand201 up to
      FRAME_stand260 then wraps back to FRAME_stand201 (m_boss3.cpp:25-32).
    - Use_Boss3 hides the statue (SVF_NOCLIENT set, solid -> SOLID_NOT)
      without freeing the edict, so it can be re-triggered (m_boss3.cpp:15-23).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, type ModT, ModIdT, MonsterAiFlagsT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { vec3_length } from "../src/kexgame/q_vec3";
import { M_SetAnimation, M_MoveFrame } from "../src/kexgame/g_monster";
import {
  LookupMmove,
  LookupMonsterinfoStand,
  LookupMonsterinfoRun,
  LookupMonsterinfoDodge,
} from "../src/kexgame/g_save_registry";

// importing these five modules runs every MmoveT constructor in them; a
// throw here would fail the whole file before any test runs (the same
// "successful import IS an assertion" idiom kexgame_monsters1/2.test.ts use).
import { boss2_move_run, boss2_move_stand } from "../src/kexgame/m_boss2";
import { SP_monster_boss3_stand, Use_Boss3, Think_Boss3Stand } from "../src/kexgame/m_boss3";
import { jorg_move_run, jorg_move_stand } from "../src/kexgame/m_boss31";
import { makron_die, FRAME_active01, FRAME_stand201, FRAME_stand260 } from "../src/kexgame/m_boss32";
import { MakronToss } from "../src/kexgame/m_boss32";
import {
  SP_monster_guncmdr,
  guncmdr_move_attack_mortar,
  guncmdr_move_attack_grenade_back,
  guncmdr_move_fire_chain,
} from "../src/kexgame/m_guncmdr";
import { M_MonsterDodge } from "../src/kexgame/m_soldier";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied from
// test/kexgame_monsters2.test.ts's own module-private fixture)
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

/** Preallocates 32 blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < 32; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 4;
  game.maxentities = 32;
  level.time = GTIME_ZERO;
  level.gravity = 800;
  level.total_monsters = 0;
  level.killed_monsters = 0;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;
  rec = { soundCalls: [] };

  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, 1));

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

/** Fetches a save-registered handler by its exact C++ name, failing the
 *  test immediately (not silently skipping) if the name isn't registered. */
function requireMmove(name: string) {
  const m = LookupMmove(name);
  if (m === null) throw new Error(`LookupMmove("${name}") returned null -- not registered`);
  return m;
}

/** Finds the first spawned edict with the given classname, scanning every
 *  slot the fixture preallocated. Fails loudly (not silently) if none
 *  exists, since a missing spawn means the fire helper never ran. */
function findSpawned(classname: string): EdictT {
  const found = g_edicts.find((e) => e.inuse && e.classname === classname);
  if (found === undefined) throw new Error(`no spawned edict with classname "${classname}" found`);
  return found;
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };

// ---------------------------------------------------------------------------
// BOSS2 (m_boss2.cpp)
// ---------------------------------------------------------------------------

describe("boss2", () => {
  test("mmove sanity (import-time validation): boss2_move_death's frame count matches lastframe-firstframe+1 (49 frames, FRAME_death2..death50)", () => {
    const m = requireMmove("boss2_move_death");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.frame.length).toBe(49);
  });

  test("animation transition: boss2_stand -> boss2_run (no AI_STAND_GROUND) changes active_move to boss2_move_run", () => {
    setupWorld();
    const self = makeMonster(5);
    self.monsterinfo.stand = LookupMonsterinfoStand("boss2_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("boss2_run")!;
    expect(self.monsterinfo.stand).not.toBeNull();
    expect(self.monsterinfo.run).not.toBeNull();

    self.monsterinfo.stand(self);
    expect(pendingOrActiveMove(self)).toBe(boss2_move_stand);

    self.monsterinfo.run(self);
    expect(pendingOrActiveMove(self)).toBe(boss2_move_run);
  });

  test("attack constant (quirk): Boss2Rocket's non-predictive branch (enemy.client===null) fires 4 rockets at hardcoded speed=500, NOT BOSS2_ROCKET_SPEED=750 (m_boss2.cpp:93,102,111,120 vs :37)", () => {
    setupWorld();
    const self = makeMonster(5, vec3(0, 0, 0));
    const enemy = makeMonster(6, vec3(200, 0, 0));
    self.enemy = enemy;
    // enemy.client stays null (default, non-player edict) -- deterministically
    // takes Boss2Rocket's non-predictive branch, m_boss2.cpp:76-84.
    expect(enemy.client).toBeNull();

    M_SetAnimation(self, requireMmove("boss2_move_attack_rocket"), true);
    stepFrame(self, 13); // reaches boss2_frames_attack_rocket's 13th element (0-indexed 12): { ai_move, -5, Boss2Rocket }

    const rocket = findSpawned("rocket");
    expect(rocket.dmg).toBe(50);
    expect(vec3_length(rocket.velocity)).toBeCloseTo(500, 0);
  });
});

// ---------------------------------------------------------------------------
// JORG (m_boss31.cpp)
// ---------------------------------------------------------------------------

describe("jorg", () => {
  test("mmove sanity: jorg_move_attack2's frame count matches lastframe-firstframe+1 (13 frames, FRAME_attak201..213)", () => {
    const m = requireMmove("jorg_move_attack2");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.frame.length).toBe(13);
  });

  test("animation transition: jorg_stand -> jorg_run (no AI_STAND_GROUND) changes active_move to jorg_move_run", () => {
    setupWorld();
    const self = makeMonster(5);
    self.monsterinfo.stand = LookupMonsterinfoStand("jorg_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("jorg_run")!;

    self.monsterinfo.stand(self);
    expect(pendingOrActiveMove(self)).toBe(jorg_move_stand);

    self.monsterinfo.run(self);
    expect(pendingOrActiveMove(self)).toBe(jorg_move_run);
  });

  test("attack constant: jorgBFG's monster_fire_bfg call, damage=50 speed=300 kick=100 damage_radius=200", () => {
    setupWorld();
    const self = makeMonster(5, vec3(0, 0, 0));
    const enemy = makeMonster(6, vec3(300, 0, 0));
    self.enemy = enemy;

    M_SetAnimation(self, requireMmove("jorg_move_attack2"), true);
    stepFrame(self, 7); // reaches jorg_frames_attack2's 7th element (0-indexed 6): { ai_charge, 0, jorgBFG }

    const bfg = findSpawned("bfg blast");
    expect(bfg.radius_dmg).toBe(50);
    expect(bfg.dmg_radius).toBe(200);
    expect(vec3_length(bfg.velocity)).toBeCloseTo(300, 0);
  });
});

// ---------------------------------------------------------------------------
// MAKRON (m_boss32.cpp)
// ---------------------------------------------------------------------------

describe("makron", () => {
  test("mmove sanity: makron_move_death2's frame count matches lastframe-firstframe+1 (95 frames, FRAME_death201..295 -- the batch's biggest table)", () => {
    const m = requireMmove("makron_move_death2");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.frame.length).toBe(95);
  });

  test("animation transition (die): makron_die's non-gib branch sets deadflag/SVF_DEADMONSTER and switches active_move to makron_move_death2", () => {
    setupWorld();
    const self = makeMonster(5);
    expect(self.health).toBeGreaterThan(self.gib_health); // non-gib branch (M_CheckGib false)
    expect(self.deadflag).toBeFalsy();

    makron_die(self, self, self, 40, vec3(0, 0, 0), MOD_UNKNOWN);

    expect(self.deadflag).toBeTruthy();
    expect((self.svflags & SvflagsT.SVF_DEADMONSTER) !== 0).toBe(true);
    expect(self.monsterinfo.active_move).toBe(requireMmove("makron_move_death2"));
  });

  test("attack constant: makronBFG's monster_fire_bfg call, damage=50 speed=300 kick=100 damage_radius=300 (DIFFERS from Jorg's 200)", () => {
    setupWorld();
    const self = makeMonster(5, vec3(0, 0, 0));
    const enemy = makeMonster(6, vec3(300, 0, 0));
    self.enemy = enemy;

    M_SetAnimation(self, requireMmove("makron_move_attack3"), true);
    stepFrame(self, 4); // reaches makron_frames_attack3's 4th element (0-indexed 3): { ai_charge, 0, makronBFG }

    const bfg = findSpawned("bfg blast");
    expect(bfg.radius_dmg).toBe(50);
    expect(bfg.dmg_radius).toBe(300);
    expect(vec3_length(bfg.velocity)).toBeCloseTo(300, 0);
  });

  test("DISTINCTIVE (REQUIRED): MakronToss (Jorg's death-head toss) spawns monster_makron, carries enemy over, and launches him airborne (velocity[2]=200, horizontal speed 400, groundentity cleared, FRAME_active01)", () => {
    setupWorld();
    const jorg = makeMonster(5, vec3(0, 0, 0));
    const player = makeMonster(6, vec3(400, 0, 0));
    player.health = 100;
    jorg.enemy = player;

    MakronToss(jorg);

    const makron = findSpawned("monster_makron");
    expect(makron.enemy).toBe(player);
    expect(makron.groundentity).toBeNull();
    expect(makron.velocity[2]).toBeCloseTo(200, 0); // hardcoded vertical kick, m_boss32.cpp MakronSpawn
    expect(Math.hypot(makron.velocity[0], makron.velocity[1])).toBeCloseTo(400, 0); // dir * 400 toward the player
    expect(makron.s.frame).toBe(FRAME_active01);
    expect(makron.monsterinfo.nextframe).toBe(FRAME_active01);
  });
});

// ---------------------------------------------------------------------------
// GUNCMDR (m_guncmdr.cpp, KEX-only, no legacy 3.21 precedent)
// ---------------------------------------------------------------------------

describe("guncmdr", () => {
  test("mmove sanity: guncmdr_move_attack_mortar's frame count matches lastframe-firstframe+1 (21 frames, FRAME_c_attack201..221)", () => {
    expect(guncmdr_move_attack_mortar.frame.length).toBe(guncmdr_move_attack_mortar.lastframe - guncmdr_move_attack_mortar.firstframe + 1);
    expect(guncmdr_move_attack_mortar.frame.length).toBe(21);
  });

  test("animation transition: guncmdr_fire_chain (endfunc) picks guncmdr_move_fire_chain, not the _run variant, when self.enemy is null (m_guncmdr.cpp:1172-1178)", () => {
    setupWorld();
    const self = makeMonster(5);
    self.enemy = null;

    M_SetAnimation(self, requireMmove("guncmdr_move_attack_chain"), true);
    stepFrame(self, 7); // 6 frames of guncmdr_move_attack_chain, then the endfunc fires on the 7th step

    expect(self.monsterinfo.active_move).toBe(guncmdr_move_fire_chain);
  });

  test("attack constant: GunnerCmdrGrenade's MORTAR branch spawns a grenade, dmg=50 speed=MORTAR_SPEED=850 (m_guncmdr.cpp:853,995, RANGE_GRENADE_MORTAR gate at :1134)", () => {
    setupWorld();
    const self = makeMonster(5, vec3(0, 0, 0));
    const enemy = makeMonster(6, vec3(600, 0, 0));
    self.enemy = enemy;

    M_SetAnimation(self, guncmdr_move_attack_mortar, true);
    stepFrame(self, 5); // reaches self.s.frame === FRAME_c_attack205, GunnerCmdrGrenade's MORTAR_1 branch

    const grenade = findSpawned("grenade");
    expect(grenade.dmg).toBe(50);
    expect(grenade.speed).toBe(850);
  });

  test("KEX-specific pattern constant (DISTINCTIVE): GunnerCmdrGrenade's FRONT branch spawns a grenade at GRENADE_SPEED=600, not MORTAR_SPEED=850 (m_guncmdr.cpp:854,997; FRONT-only pitch-=0.05 at :964-965, no m_gunner.ts analog)", () => {
    setupWorld();
    const self = makeMonster(5, vec3(0, 0, 0));
    const enemy = makeMonster(6, vec3(200, 0, 0));
    self.enemy = enemy;

    M_SetAnimation(self, guncmdr_move_attack_grenade_back, true);
    stepFrame(self, 3); // reaches self.s.frame === FRAME_c_attack304, GunnerCmdrGrenade's FRONT_1 branch

    const grenade = findSpawned("grenade");
    expect(grenade.dmg).toBe(50);
    expect(grenade.speed).toBe(600);
  });

  test("DISTINCTIVE: SP_monster_guncmdr reuses m_soldier.ts's shared M_MonsterDodge instead of re-registering its own copy", () => {
    setupWorld();
    const self = makeMonster(5);

    SP_monster_guncmdr(self);

    expect(self.monsterinfo.dodge).toBe(M_MonsterDodge);
    expect(LookupMonsterinfoDodge("M_MonsterDodge")).toBe(M_MonsterDodge);
  });
});

// ---------------------------------------------------------------------------
// BOSS3 (m_boss3.cpp, the pre-Makron statue prop-shell)
// ---------------------------------------------------------------------------

describe("boss3 stand", () => {
  test("SP_monster_boss3_stand wires use/think and starts on FRAME_stand201 (m_boss3.cpp:34-63)", () => {
    setupWorld();
    const self = makeMonster(5);

    SP_monster_boss3_stand(self);

    expect(self.use).toBe(Use_Boss3);
    expect(self.think).toBe(Think_Boss3Stand);
    expect(self.s.frame).toBe(FRAME_stand201);
  });

  test("Think_Boss3Stand cycles s.frame from FRAME_stand201 up to FRAME_stand260 then wraps back to FRAME_stand201 (m_boss3.cpp:25-32)", () => {
    setupWorld();
    const self = makeMonster(5);
    self.s.frame = FRAME_stand260;

    Think_Boss3Stand(self);
    expect(self.s.frame).toBe(FRAME_stand201);

    Think_Boss3Stand(self);
    expect(self.s.frame).toBe(FRAME_stand201 + 1);
  });

  test("Use_Boss3 hides the statue (SVF_NOCLIENT set, solid -> SOLID_NOT) without freeing the edict (m_boss3.cpp:15-23)", () => {
    setupWorld();
    const self = makeMonster(5); // makeMonster already sets solid = SolidT.SOLID_BBOX

    Use_Boss3(self, null, null);

    expect((self.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(true);
    expect(self.solid === SolidT.SOLID_NOT).toBe(true);
    expect(self.inuse).toBe(true); // hidden, not freed -- can be re-triggered
  });
});
