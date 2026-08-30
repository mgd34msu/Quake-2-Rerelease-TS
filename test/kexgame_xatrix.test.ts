/*
Unit tests for the xatrix (Ground Zero mission pack) porting unit: the nine
src/kexgame/{g,p,m}_xatrix_*.ts modules. Self-sufficient per PORTING.md/
.orch/preferences.md rule 13: wires its own fake KexGameImports/
KexGameExports/edict pool, modeled directly after test/kexgame_g_weapon.test.ts's
"fake-imports fixture" style and test/kexgame_monsters3.test.ts's "manual
wiring, not SP_monster_X" convention (LookupMmove/LookupMonsterinfoStand
fetch registered handlers by name instead of driving the full
walkmonster_start/flymonster_start spawn pipeline).

Scope (16 cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/xatrix/*.cpp):
  - fire_ionripper: projectile spawn fields -- MOVETYPE_WALLBOUNCE, dmg_radius
    100, EF_IONRIPPER effect bit, FL_DODGE (g_xatrix_weapon.cpp:91-129).
  - ionripper_touch: direct hit applies MOD_RIPPER damage and frees the
    projectile (g_xatrix_weapon.cpp:64-88).
  - fire_blueblaster: projectile spawn fields -- MOVETYPE_FLYMISSILE,
    style=MOD_BLUEBLASTER, skinnum=1, classname="bolt" (g_xatrix_weapon.cpp:
    6-42).
  - fire_plasma: projectile spawn fields -- EF_PLASMA|EF_ANIM_ALLFAST,
    dmg/radius_dmg/dmg_radius (g_xatrix_weapon.cpp:280-312).
  - fire_trap: spawn fields -- health 20, FL_DAMAGEABLE|FL_MECHANICAL|FL_TRAP,
    teammaster=self, classname="food_cube_trap" (g_xatrix_weapon.cpp:559-605).
  - Trap_Think "suck": a valid, in-range, not-yet-close target gets pulled
    toward the trap by velocity, clamped to [64, max_speed]
    (g_xatrix_weapon.cpp:486-501).
  - Trap_Think "eat": a close (<48 units), light (<400 mass) target takes
    100000 damage, and the trap enters its frame-5 digestion state
    (g_xatrix_weapon.cpp:503-526).
  - Trap_Think frame 7->8: advances to the "spawn food cube" branch, which
    spawns a real item_foodcube entity and schedules the trap's own freeing
    (g_xatrix_weapon.cpp:397-421).
  - dabeam_update: a monster hit along the beam path takes MOD_TARGET_LASER
    damage every call (g_xatrix_monster.cpp:84-98).
  - dabeam_update: a clear beam (nothing hit) damages nothing and still
    updates `s.old_origin` (g_xatrix_monster.cpp:96).
  - monster_fire_dabeam: creates the beam entity on the first call and
    REUSES the exact same entity on a second call (no duplicate G_Spawn)
    (g_xatrix_monster.cpp:112-142).
  - monster_fire_ionripper: wraps fire_ionripper + monster_muzzleflash
    (g_xatrix_monster.cpp:14-18).
  - gekk_stand: WATER_WAIST+ sets FL_SWIM and switches to the underwater
    stand animation; below WATER_WAIST uses the land stand animation
    (m_xatrix_gekk.cpp:429-441).
  - gekk frame-table validation: gekk_move_stand spans FRAME_stand_01..
    FRAME_stand_39 (39 frames), matching m_xatrix_gekk.h's enum layout.
  - gekk land_to_water (reached via gekk_move_stand's own last-frame
    thinkfunc, gekk_check_underwater): sets FL_SWIM, viewheight/yaw_speed,
    and swim-shaped mins/maxs (m_xatrix_gekk.cpp:802-806, 1675-1686).
  - fixbot_search (reached via fixbot_move_stand's own last-frame thinkfunc,
    change_to_roam): finds a dead, visible SVF_MONSTER within 1024 units and
    marks AI_MEDIC + healer (m_xatrix_fixbot.cpp:60-147).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { ContentsT, EffectsT, GAME_API_VERSION, ServerCommandT, SolidT, SvflagsT, WaterLevelT, MonsterMuzzleflashIdT } from "../src/kexapi/game";
import { type EdictT, DamageflagsT, EntFlagsT, type ModT, ModIdT, MonsterAiFlagsT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { LookupMmove, LookupMonsterinfoStand } from "../src/kexgame/g_save_registry";
import { G_FreeEdict } from "../src/kexgame/g_utils";

import { fire_ionripper, fire_blueblaster, fire_plasma, fire_trap } from "../src/kexgame/g_xatrix_weapon";
import { dabeam_update, monster_fire_dabeam, monster_fire_ionripper } from "../src/kexgame/g_xatrix_monster";
import { SP_monster_gekk } from "../src/kexgame/m_xatrix_gekk";
import { SP_monster_fixbot } from "../src/kexgame/m_xatrix_fixbot";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (see file header)
// ---------------------------------------------------------------------------

interface Recorder {
  comPrints: string[];
  writeBytes: number[];
  linked: EdictT[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { comPrints: [], writeBytes: [], linked: [], cvars: new Map() };
}

const missTrace: KexTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 1,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: 0,
  ent: null,
  plane2: new CplaneT(),
  surface2: null,
};

type TraceFn = (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: ContentsT) => KexTraceT;

function makeTraceBox(): { fn: TraceFn } {
  return { fn: () => missTrace };
}

function makeFakeGameImports(rec: Recorder, traceBox: { fn: TraceFn }, pointContentsBox: { value: ContentsT }): KexGameImports {
  function getCvar(name: string, value: string): CvarT {
    let c = rec.cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value);
      rec.cvars.set(name, c);
    }
    return c;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print(msg) {
      rec.comPrints.push(msg);
    },
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
      return 1;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(start, mins, maxs, end, passent, mask) {
      return traceBox.fn(start, mins, maxs, end, passent, mask);
    },
    clip() {
      return missTrace;
    },
    pointcontents() {
      return pointContentsBox.value;
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
      rec.linked.push(g_edicts[(ent as KexEdictT).s.number]!);
    },
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte(b) {
      rec.writeBytes.push(b);
    },
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

/** Preallocates `maxentities` blank edicts (`numEdicts` already "in the
 *  world") and wires up gi/globals/g_edicts/game/level for one test. */
function setupWorld(maxentities: number, numEdicts: number): { edicts: EdictT[]; rec: Recorder; traceBox: { fn: TraceFn }; pointContentsBox: { value: ContentsT } } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = 0;
  game.maxentities = maxentities;
  level.time = GTIME_ZERO;
  level.gravity = 800;

  const rec = makeRecorder();
  const traceBox = makeTraceBox();
  const pointContentsBox = { value: ContentsT.CONTENTS_NONE as ContentsT };
  SetGameImports(makeFakeGameImports(rec, traceBox, pointContentsBox));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));
  globals.num_edicts = numEdicts;

  return { edicts, rec, traceBox, pointContentsBox };
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };
void MOD_UNKNOWN;

// ---------------------------------------------------------------------------
// fire_ionripper (g_xatrix_weapon.cpp:91-129)
// ---------------------------------------------------------------------------

describe("fire_ionripper", () => {
  test("spawn fields: MOVETYPE_WALLBOUNCE, dmg_radius 100, EF_IONRIPPER, FL_DODGE", () => {
    const { edicts, rec } = setupWorld(8, 4);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);

    fire_ionripper(shooter, vec3(0, 0, 0), vec3(1, 0, 0), 50, 500, EffectsT.EF_IONRIPPER);

    // G_Spawn (g_utils.ts:546-575) reuses the lowest-index free edict, not
    // edicts[numEdicts]; read the spawned entity back via rec.linked.at(-1),
    // same as kexgame_g_weapon.test.ts's own "spawn fields" tests.
    const ion = rec.linked.at(-1)!;
    expect(ion.inuse).toBe(true);
    expect(ion.movetype).toBe(MovetypeT.MOVETYPE_WALLBOUNCE);
    expect(ion.dmg).toBe(50);
    expect(ion.dmg_radius).toBe(100);
    expect((ion.s.effects & EffectsT.EF_IONRIPPER) !== 0n).toBe(true);
    expect((ion.flags & EntFlagsT.FL_DODGE) !== 0n).toBe(true);
    expect(ion.owner).toBe(shooter);
  });

  test("ionripper_touch: direct hit on a takedamage target applies MOD_RIPPER damage and frees the projectile", () => {
    // G_FreeEdict (g_utils.ts:582-599) no-ops on any index <= game.maxclients
    // + BODY_QUEUE_SIZE (8 here), so the spawned ion must land past that
    // "special edict" range for the "frees the projectile" assertion below
    // to mean anything -- indices 1..8 are pre-occupied so G_Spawn's scan
    // runs past them, same concern as kexgame_g_weapon.test.ts's own
    // fire_blaster/blaster_touch test.
    const { edicts, rec, traceBox } = setupWorld(12, 9);
    const shooter = edicts[0]!;
    const target = edicts[1]!;
    target.inuse = true;
    for (let i = 2; i < 9; i++) edicts[i]!.inuse = true;
    shooter.s.origin = vec3(0, 0, 0);
    target.takedamage = true;
    target.health = 100;

    traceBox.fn = () => missTrace; // clear line to the spawn point itself
    fire_ionripper(shooter, vec3(0, 0, 0), vec3(1, 0, 0), 50, 500, EffectsT.EF_IONRIPPER);
    const ion = rec.linked.at(-1)!;
    expect(ion.inuse).toBe(true);

    const hitTrace: KexTraceT = { ...missTrace, fraction: 0.5, ent: target, plane: { ...new CplaneT(), normal: vec3(0, 0, 1) } };
    ion.touch!(ion, target, hitTrace, false);

    expect(target.health).toBe(50); // 100 - 50 dmg
    expect(ion.inuse).toBe(false); // G_FreeEdict frees it
  });
});

// ---------------------------------------------------------------------------
// fire_blueblaster (g_xatrix_weapon.cpp:6-42)
// ---------------------------------------------------------------------------

describe("fire_blueblaster", () => {
  test("spawn fields: MOVETYPE_FLYMISSILE, style=MOD_BLUEBLASTER, skinnum=1, classname bolt", () => {
    const { edicts, rec } = setupWorld(8, 4);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);

    fire_blueblaster(shooter, vec3(0, 0, 0), vec3(1, 0, 0), 10, 600, EffectsT.EF_BLUEHYPERBLASTER);

    const bolt = rec.linked.at(-1)!;
    expect(bolt.inuse).toBe(true);
    expect(bolt.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
    expect(bolt.style).toBe(ModIdT.MOD_BLUEBLASTER);
    expect(bolt.s.skinnum).toBe(1);
    expect(bolt.classname).toBe("bolt");
    expect(bolt.dmg).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// fire_plasma (g_xatrix_weapon.cpp:280-312) -- the Phalanx's projectile
// ---------------------------------------------------------------------------

describe("fire_plasma", () => {
  test("spawn fields: EF_PLASMA|EF_ANIM_ALLFAST, dmg/radius_dmg/dmg_radius", () => {
    const { edicts, rec } = setupWorld(8, 4);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);

    fire_plasma(shooter, vec3(0, 0, 0), vec3(1, 0, 0), 75, 725, 120, 30);

    const plasma = rec.linked.at(-1)!;
    expect(plasma.inuse).toBe(true);
    expect(plasma.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
    expect((plasma.s.effects & (EffectsT.EF_PLASMA | EffectsT.EF_ANIM_ALLFAST)) === (EffectsT.EF_PLASMA | EffectsT.EF_ANIM_ALLFAST)).toBe(true);
    expect(plasma.dmg).toBe(75);
    expect(plasma.radius_dmg).toBe(30);
    expect(plasma.dmg_radius).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// fire_trap / Trap_Think (g_xatrix_weapon.cpp:314-605)
// ---------------------------------------------------------------------------

describe("fire_trap", () => {
  test("spawn fields: health 20, FL_DAMAGEABLE|FL_MECHANICAL|FL_TRAP, teammaster=self, classname", () => {
    const { edicts, rec } = setupWorld(8, 4);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);

    fire_trap(shooter, vec3(0, 0, 0), vec3(1, 0, 0), 500);

    const trap = rec.linked.at(-1)!;
    expect(trap.inuse).toBe(true);
    expect(trap.health).toBe(20);
    expect(trap.takedamage).toBe(true);
    expect(trap.teammaster).toBe(shooter);
    expect(trap.classname).toBe("food_cube_trap");
    const wantFlags = EntFlagsT.FL_DAMAGEABLE | EntFlagsT.FL_MECHANICAL | EntFlagsT.FL_TRAP;
    expect((trap.flags & wantFlags) === wantFlags).toBe(true);
  });

  test("Trap_Think 'suck': pulls a valid in-range target toward the trap by velocity", () => {
    const { edicts, rec } = setupWorld(8, 5);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);
    // marked inuse before fire_trap's own G_Spawn call so it isn't handed
    // out as the trap itself (G_Spawn reuses the lowest-index free edict)
    const target = edicts[1]!;
    target.inuse = true;

    fire_trap(shooter, vec3(0, 0, 0), vec3(0, 0, 1), 0);
    const trap = rec.linked.at(-1)!;
    trap.s.frame = 4; // past the initial 0-4 opening-frame ramp
    trap.groundentity = shooter; // "if (!ent->groundentity) return;" guard

    target.solid = SolidT.SOLID_BBOX;
    target.svflags |= SvflagsT.SVF_MONSTER;
    target.health = 100;
    target.mass = 200;
    target.s.origin = vec3(100, 0, 0); // 100 units away: in the 256-unit find radius, outside the 48-unit eat radius
    target.velocity = vec3(0, 0, 0);

    trap.think!(trap);

    expect(target.velocity[0]).toBeLessThan(0); // pulled back toward the trap at origin
    expect(trap.s.frame).toBe(4); // not close enough to eat yet
  });

  test("Trap_Think 'eat': a close, light target takes 100000 damage and the trap enters digestion", () => {
    const { edicts, rec } = setupWorld(8, 5);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);
    const target = edicts[1]!;
    target.inuse = true;

    fire_trap(shooter, vec3(0, 0, 0), vec3(0, 0, 1), 0);
    const trap = rec.linked.at(-1)!;
    trap.s.frame = 4;
    trap.groundentity = shooter;

    target.solid = SolidT.SOLID_BBOX;
    target.svflags |= SvflagsT.SVF_MONSTER;
    target.takedamage = true; // T_Damage (g_combat.ts:762) no-ops without this
    target.health = 100;
    target.mass = 200; // < 400: eatable
    target.s.origin = vec3(10, 0, 0); // well within the 48-unit eat radius

    trap.think!(trap);

    expect(target.health).toBe(-999); // 100 - 100000, floor-clamped by Killed() (g_combat.cpp:86-87)
    expect(trap.s.frame).toBe(5);
    expect(trap.wait).toBe(64);
    expect(trap.enemy).toBe(target);
    expect(trap.mass).toBe(20); // Math.trunc(200 / 10), non-deathmatch divisor
  });

  test("Trap_Think frame 7 -> 8: spawns a real item_foodcube and schedules the trap's own freeing", () => {
    const { edicts, rec } = setupWorld(12, 5);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);
    // pre-occupy every other edict slot so both G_Spawn calls below (the
    // trap itself, then the foodcube) are forced into globals.num_edicts's
    // grow-the-array branch (g_utils.ts:559-574) instead of quietly reusing
    // one of these free slots -- otherwise `numBefore`/`num_edicts` below
    // would never actually observe a new allocation.
    for (let i = 1; i < 5; i++) edicts[i]!.inuse = true;
    fire_trap(shooter, vec3(0, 0, 0), vec3(0, 0, 1), 0);
    const trap = rec.linked.at(-1)!;
    trap.groundentity = shooter;
    trap.s.frame = 7;
    trap.mass = 50;
    trap.accel = 200;

    const numBefore = globals.num_edicts;
    trap.think!(trap);

    expect(trap.s.frame).toBe(8);
    expect(trap.think).toBe(G_FreeEdict);
    expect(globals.num_edicts).toBeGreaterThan(numBefore); // a new foodcube entity was spawned

    const foodcube = edicts.find((e) => e.classname === "item_foodcube");
    expect(foodcube).toBeDefined();
    expect(foodcube!.count).toBe(50); // best.count = ent.mass
  });
});

// ---------------------------------------------------------------------------
// dabeam_update / monster_fire_dabeam (g_xatrix_monster.cpp:84-142)
// ---------------------------------------------------------------------------

describe("dabeam_update", () => {
  test("damages a monster hit along the beam path every call (MOD_TARGET_LASER)", () => {
    const { edicts, traceBox } = setupWorld(8, 4);
    const owner = edicts[0]!;
    const beam = edicts[1]!;
    const target = edicts[2]!;

    beam.owner = owner;
    beam.dmg = 25;
    beam.s.origin = vec3(0, 0, 0);
    beam.movedir = vec3(1, 0, 0);

    target.svflags |= SvflagsT.SVF_MONSTER;
    target.takedamage = true;
    target.health = 100;

    // dabeam_update (g_xatrix_monster.ts:212-227) seeds pierce.tr with an
    // initial self-trace (start->start, matching g_weapon.ts's identical
    // PierceArgsT.tr init idiom) BEFORE pierce_trace's own loop runs, so the
    // first gi.trace call is that throwaway seed, not the real beam trace;
    // the real trace is call 2, and the post-mark retrace that ends the
    // pierce loop is call 3.
    let calls = 0;
    traceBox.fn = () => {
      calls++;
      if (calls === 2) return { ...missTrace, fraction: 0.5, ent: target, endpos: vec3(50, 0, 0), plane: { ...new CplaneT(), normal: vec3(-1, 0, 0) } };
      return missTrace; // seed self-trace (call 1) and post-mark retrace (call 3) both sail past
    };

    dabeam_update(beam, true);

    expect(target.health).toBe(75); // 100 - 25 dmg
  });

  test("a clear beam (nothing hit) damages nothing and still updates s.old_origin", () => {
    const { edicts, traceBox } = setupWorld(8, 4);
    const owner = edicts[0]!;
    const beam = edicts[1]!;
    beam.owner = owner;
    beam.dmg = 25;
    beam.s.origin = vec3(0, 0, 0);
    beam.movedir = vec3(1, 0, 0);

    // real gi.trace sets endpos to the requested end point on a full miss;
    // the shared missTrace fixture hardcodes endpos to the origin, so it
    // must be overridden here to reflect the actual traced segment.
    traceBox.fn = (_start, _mins, _maxs, end) => ({ ...missTrace, endpos: end });

    dabeam_update(beam, true);

    expect(beam.s.old_origin[0]).toBeCloseTo(2048, 0); // start + movedir*2048, clear line
  });
});

describe("monster_fire_dabeam", () => {
  test("creates the beam entity once and reuses the SAME entity on a second call", () => {
    const { edicts, traceBox } = setupWorld(8, 4);
    const owner = edicts[0]!;
    owner.s.origin = vec3(0, 0, 0);
    owner.s.angles = vec3(0, 0, 0);
    traceBox.fn = () => missTrace;

    let updateCalls = 0;
    const updateFn = (self: EdictT): void => {
      updateCalls++;
      self.movedir = vec3(1, 0, 0);
    };

    monster_fire_dabeam(owner, 10, false, updateFn);
    const firstBeam = owner.beam;
    expect(firstBeam).not.toBeNull();
    expect(firstBeam!.dmg).toBe(10);
    expect(updateCalls).toBe(1);

    monster_fire_dabeam(owner, 10, false, updateFn);
    expect(owner.beam).toBe(firstBeam); // no second G_Spawn
    expect(updateCalls).toBe(2);
  });
});

describe("monster_fire_ionripper", () => {
  test("wraps fire_ionripper and writes a monster muzzleflash", () => {
    const { edicts, rec } = setupWorld(8, 4);
    const shooter = edicts[0]!;
    shooter.s.origin = vec3(0, 0, 0);

    monster_fire_ionripper(shooter, vec3(0, 0, 0), vec3(1, 0, 0), 5, 600, MonsterMuzzleflashIdT.MZ2_GUNNER_GRENADE_1, EffectsT.EF_IONRIPPER);

    const ion = rec.linked.at(-1)!;
    expect(ion.inuse).toBe(true);
    expect(ion.owner).toBe(shooter);
    expect(rec.writeBytes).toContain(ServerCommandT.svc_muzzleflash2);
  });
});

// ---------------------------------------------------------------------------
// gekk (m_xatrix_gekk.cpp) -- swim/land transitions + frame validation
// ---------------------------------------------------------------------------

describe("gekk", () => {
  test("gekk_stand: WATER_WAIST+ sets FL_SWIM and switches to the underwater stand animation", () => {
    const { edicts } = setupWorld(4, 4);
    const self = edicts[0]!;
    SP_monster_gekk(self);

    self.waterlevel = WaterLevelT.WATER_WAIST;
    const gekkStand = LookupMonsterinfoStand("gekk_stand")!;
    gekkStand(self);

    expect((self.flags & EntFlagsT.FL_SWIM) !== 0n).toBe(true);
    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n).toBe(true);
    expect(self.monsterinfo.active_move).toBe(LookupMmove("gekk_move_standunderwater"));
  });

  test("gekk_stand: below WATER_WAIST uses the land stand animation", () => {
    const { edicts } = setupWorld(4, 4);
    const self = edicts[0]!;
    SP_monster_gekk(self);

    self.waterlevel = WaterLevelT.WATER_NONE;
    const gekkStand = LookupMonsterinfoStand("gekk_stand")!;
    gekkStand(self);

    const activeMove: unknown = self.monsterinfo.active_move;
    expect(activeMove).toBe(LookupMmove("gekk_move_stand"));
  });

  test("gekk_move_stand frame table: FRAME_stand_01..FRAME_stand_39 (39 entries)", () => {
    setupWorld(4, 4);
    const move = LookupMmove("gekk_move_stand")!;
    expect(move.firstframe).toBe(0);
    expect(move.lastframe).toBe(38);
    expect(move.frame.length).toBe(39);
  });

  test("land_to_water (via gekk_move_stand's own last-frame thinkfunc, gekk_check_underwater)", () => {
    const { edicts } = setupWorld(4, 4);
    const self = edicts[0]!;
    SP_monster_gekk(self);
    self.waterlevel = WaterLevelT.WATER_WAIST;

    const standMove = LookupMmove("gekk_move_stand")!;
    const lastFrame = standMove.frame[standMove.frame.length - 1]!;
    lastFrame.thinkfunc!(self);

    expect((self.flags & EntFlagsT.FL_SWIM) !== 0n).toBe(true);
    expect(self.viewheight).toBe(10);
    expect(self.yaw_speed).toBe(10);
    expect(self.maxs[2]).toBe(16); // land_to_water's swim-shaped maxs
    expect(self.monsterinfo.active_move).toBe(LookupMmove("gekk_move_swim_start"));
  });
});

// ---------------------------------------------------------------------------
// fixbot (m_xatrix_fixbot.cpp) -- goal logic basics
// ---------------------------------------------------------------------------

describe("fixbot", () => {
  test("fixbot_search (via fixbot_move_stand's own last-frame thinkfunc, change_to_roam): finds a dead monster and marks AI_MEDIC", () => {
    const { edicts } = setupWorld(6, 4);
    const self = edicts[0]!;
    self.s.origin = vec3(0, 0, 0);
    SP_monster_fixbot(self);

    const deadMonster = edicts[1]!;
    deadMonster.inuse = true;
    deadMonster.solid = SolidT.SOLID_BBOX;
    deadMonster.svflags |= SvflagsT.SVF_MONSTER;
    deadMonster.health = -10; // dead
    deadMonster.max_health = 100;
    deadMonster.s.origin = vec3(50, 0, 0); // within the 1024-unit search radius
    deadMonster.think = null;
    deadMonster.nextthink = GTIME_ZERO;

    const fixbotStand = LookupMonsterinfoStand("fixbot_stand")!;
    fixbotStand(self);
    const standMove = LookupMmove("fixbot_move_stand")!;
    const lastFrame = standMove.frame[standMove.frame.length - 1]!;
    lastFrame.thinkfunc!(self); // change_to_roam -> fixbot_search -> fixbot_FindDeadMonster

    expect(self.enemy).toBe(deadMonster);
    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n).toBe(true);
    expect(deadMonster.monsterinfo.healer).toBe(self);
  });

  test("fixbot_search: a no-op (returns 0) when self.enemy is already set", () => {
    const { edicts } = setupWorld(6, 4);
    const self = edicts[0]!;
    self.s.origin = vec3(0, 0, 0);
    SP_monster_fixbot(self);

    const alreadyTargeted = edicts[2]!;
    self.enemy = alreadyTargeted;

    const deadMonster = edicts[1]!;
    deadMonster.inuse = true;
    deadMonster.solid = SolidT.SOLID_BBOX;
    deadMonster.svflags |= SvflagsT.SVF_MONSTER;
    deadMonster.health = -10;
    deadMonster.s.origin = vec3(50, 0, 0);

    const fixbotStand = LookupMonsterinfoStand("fixbot_stand")!;
    fixbotStand(self);
    const standMove = LookupMmove("fixbot_move_stand")!;
    const lastFrame = standMove.frame[standMove.frame.length - 1]!;
    lastFrame.thinkfunc!(self);

    // fixbot_search's `if (!self->enemy)` guard means the dead monster above
    // is never picked up while self.enemy is already non-null.
    expect(self.enemy).toBe(alreadyTargeted);
    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n).toBe(false);
  });
});
