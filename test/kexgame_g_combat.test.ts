/*
Unit tests for the kex g_combat.cpp port (src/kexgame/g_combat.ts).

Self-sufficient per .orch/preferences.md rule 13: wires its own fake
KexGameImports/KexGameExports and a full GClientT fixture, modeled after
test/kexgame_g_utils.test.ts's own fixture (same fake-imports shape, same
setupWorld() helper), extended with a client factory since g_combat.ts's
armor/power-armor/damage-indicator paths need a fully-valued GClientT (no
defaultGClient() factory exists yet anywhere in src/kexgame/).

Scope (see g_combat.ts's own file header for the exact C++ line numbers and
every documented deviation/stub this suite's design routes around):
  - T_Damage: basic health subtraction, the !takedamage no-op, armor
    absorption math for jacket/combat/body armor (g_local_types.ts's
    jacketarmor_info/combatarmor_info/bodyarmor_info tables), energy vs.
    normal protection, DAMAGE_NO_ARMOR/DAMAGE_NO_REG_ARMOR/
    DAMAGE_NO_POWER_ARMOR bypasses, power-screen absorption's angle gate,
    power-shield absorption, godmode and invincibility gates (and
    DAMAGE_NO_PROTECTION overriding both), the monster surprise-damage
    bonus, and the inline (not CheckTeamDamage-routed) friendly-fire check.
  - T_RadiusDamage: the falloff formula against hand-computed values.
  - Killed: the KEX-specific SVF_MONSTER early-return (no die() call, no
    deadflag/gib handling -- this source doesn't touch either), the
    non-monster die()+setskin dispatch, and the -999 health clamp.
  - CheckTeamDamage / OnSameTeam: g_friendly_fire gate and coop's
    everyone-is-on-one-team rule. NOTE: the brief that seeded this file
    mentions "the relevant dmflag" -- this KEX source has no dmflags check
    in either function at all (see g_combat.ts's own CheckTeamDamage
    comment); the real gates are g_friendly_fire and coop.
  - One test exercising the FoundTarget/HuntTarget cross-dep for a fresh
    monster reacting to a client's first hit (src/kexgame/g_ai.ts has since
    landed and g_combat.ts's own `visible`/`FoundTarget` stubs were swapped
    for real imports from it -- this test used to assert a throw through the
    stub; it now asserts the real FoundTarget/HuntTarget side effects
    instead: `.enemy` set, the attacker's `sight_entity` woken up, and
    `monsterinfo.run` invoked).
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION, MAX_STATS, SolidT, SvflagsT } from "../src/kexapi/game";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  DamageflagsT,
  EntFlagsT,
  ItemIdT,
  AmmoT,
  ModIdT,
  MovetypeT,
  SPHERE_DEFENDER,
} from "../src/kexgame/g_local";
import { jacketarmor_info, combatarmor_info, bodyarmor_info } from "../src/kexgame/g_local_types";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms } from "../src/kexgame/gtime";
import { CanDamage, Killed, CheckArmor, CheckPowerArmor, CheckTeamDamage, OnSameTeam, T_Damage, T_RadiusDamage } from "../src/kexgame/g_combat";
import { PlayerStatT } from "../src/kexgame/p_hud";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (mirrors
// test/kexgame_g_utils.test.ts's own fixture)
// ---------------------------------------------------------------------------

interface Recorder {
  soundCalls: { soundindex: number }[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { soundCalls: [], cvars: new Map() };
}

const noHitTrace: KexTraceT = {
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

const blockedTrace: KexTraceT = { ...noHitTrace, fraction: 0.5 };

/** A single mutable "current trace result" so individual tests can flip
 *  between clear/blocked line-of-sight without rebuilding the whole fixture. */
function makeFakeGameImports(rec: Recorder, traceResult: { value: KexTraceT }): KexGameImports {
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
    Com_Print() {},
    Client_Print() {},
    Center_Print() {},
    sound(_ent, _channel, soundindex) {
      rec.soundCalls.push({ soundindex });
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
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      return traceResult.value;
    },
    clip() {
      return traceResult.value;
    },
    pointcontents() {
      return 0;
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
    linkentity() {},
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
function setupWorld(maxclients: number, maxentities: number, numEdicts: number): { edicts: EdictT[]; rec: Recorder; traceResult: { value: KexTraceT } } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = maxclients;
  game.maxentities = maxentities;
  level.time = Gtime_from_ms(0);

  const rec = makeRecorder();
  const traceResult = { value: noHitTrace };
  SetGameImports(makeFakeGameImports(rec, traceResult));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts, rec, traceResult };
}

// ---------------------------------------------------------------------------
// GClientT fixture -- no defaultGClient() factory exists anywhere in
// src/kexgame/ yet, so this test file builds its own full one.
// ---------------------------------------------------------------------------

function makeClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: 0,
    autoswitch: 0,
    autoshield: -1, // AUTO_SHIELD_MANUAL
    connected: true,
    spawned: true,
    health: 100,
    max_health: 100,
    savedFlags: 0n,
    selected_item: ItemIdT.IT_NULL,
    selected_item_time: Gtime_from_ms(0),
    inventory: new Int32Array(ItemIdT.IT_TOTAL),
    max_ammo: new Int16Array(AmmoT.AMMO_MAX),
    weapon: null,
    lastweapon: null,
    power_cubes: 0,
    score: 0,
    game_help1changed: 0,
    game_help2changed: 0,
    helpchanged: 0,
    help_time: Gtime_from_ms(0),
    spectator: false,
    bob_skip: false,
    wanted_fog: [0, 0, 0, 0, 0],
    wanted_heightfog: { start: [0, 0, 0, 0], end: [0, 0, 0, 0], falloff: 0, density: 0 },
    fog_transition_time: Gtime_from_ms(0),
    megahealth_time: Gtime_from_ms(0),
    lives: 1,
    n64_crouch_warn_times: 0,
    n64_crouch_warning: Gtime_from_ms(0),
  };
}

function makeClientRespawn(): ClientRespawnT {
  return {
    coop_respawn: makeClientPersistant(),
    entertime: Gtime_from_ms(0),
    score: 0,
    cmd_angles: vec3(),
    spectator: false,
    ctf_team: 0,
    ctf_state: 0,
    ctf_lasthurtcarrier: Gtime_from_ms(0),
    ctf_lastreturnedflag: Gtime_from_ms(0),
    ctf_flagsince: Gtime_from_ms(0),
    ctf_lastfraggedcarrier: Gtime_from_ms(0),
    id_state: false,
    lastidtime: Gtime_from_ms(0),
    voted: false,
    ready: false,
    admin: false,
    ghost: null,
  };
}

function makePmoveState(): KexPmoveStateT {
  return {
    pm_type: 0,
    origin: vec3(),
    velocity: vec3(),
    pm_flags: 0,
    pm_time: 0,
    gravity: 0,
    delta_angles: vec3(),
    viewheight: 0,
  };
}

function makePlayerState(): KexPlayerStateT {
  return {
    pmove: makePmoveState(),
    viewangles: vec3(),
    viewoffset: vec3(),
    kick_angles: vec3(),
    gunangles: vec3(),
    gunoffset: vec3(),
    gunindex: 0,
    gunskin: 0,
    gunframe: 0,
    gunrate: 0,
    screen_blend: new Float32Array(4),
    damage_blend: new Float32Array(4),
    fov: 90,
    rdflags: 0,
    stats: new Int16Array(MAX_STATS),
    team_id: 0,
  };
}

function makeUsercmd(): KexUsercmdT {
  return { msec: 0, buttons: 0, angles: vec3(), forwardmove: 0, sidemove: 0, server_frame: 0 };
}

/** A fully-valued GClientT. `health`/`inventory`/`owned_sphere`/etc. are all
 *  the caller's responsibility to override per-test -- this is just "a
 *  memset(0)-ish player" with sane not-in-any-special-state defaults. */
function makeClient(): GClientT {
  return {
    ps: makePlayerState(),
    ping: 0,
    pers: makeClientPersistant(),
    resp: makeClientRespawn(),
    old_pmove: makePmoveState(),
    showscores: false,
    showeou: false,
    showinventory: false,
    showhelp: false,
    buttons: 0,
    oldbuttons: 0,
    latched_buttons: 0,
    cmd: makeUsercmd(),
    weapon_fire_finished: Gtime_from_ms(0),
    weapon_think_time: Gtime_from_ms(0),
    weapon_fire_buffered: false,
    weapon_thunk: false,
    newweapon: null,
    damage_armor: 0,
    damage_parmor: 0,
    damage_blood: 0,
    damage_knockback: 0,
    damage_from: vec3(),
    damage_indicators: [
      { from: vec3(), health: 0, armor: 0, power: 0 },
      { from: vec3(), health: 0, armor: 0, power: 0 },
      { from: vec3(), health: 0, armor: 0, power: 0 },
      { from: vec3(), health: 0, armor: 0, power: 0 },
    ],
    num_damage_indicators: 0,
    killer_yaw: 0,
    weaponstate: 0,
    kick: { angles: vec3(), origin: vec3(), time: Gtime_from_ms(0), total: Gtime_from_ms(0) },
    quake_time: Gtime_from_ms(0),
    kick_origin: vec3(),
    v_dmg_roll: 0,
    v_dmg_pitch: 0,
    v_dmg_time: Gtime_from_ms(0),
    fall_time: Gtime_from_ms(0),
    fall_value: 0,
    damage_alpha: 0,
    bonus_alpha: 0,
    damage_blend: vec3(),
    v_angle: vec3(),
    v_forward: vec3(),
    bobtime: 0,
    oldviewangles: vec3(),
    oldvelocity: vec3(),
    oldgroundentity: null,
    flash_time: Gtime_from_ms(0),
    next_drown_time: Gtime_from_ms(0),
    old_waterlevel: 0,
    breather_sound: 0,
    machinegun_shots: 0,
    anim_end: 0,
    anim_priority: 0,
    anim_duck: false,
    anim_run: false,
    anim_time: Gtime_from_ms(0),
    quad_time: Gtime_from_ms(0),
    invincible_time: Gtime_from_ms(0),
    breather_time: Gtime_from_ms(0),
    enviro_time: Gtime_from_ms(0),
    invisible_time: Gtime_from_ms(0),
    grenade_blew_up: false,
    grenade_time: Gtime_from_ms(0),
    grenade_finished_time: Gtime_from_ms(0),
    quadfire_time: Gtime_from_ms(0),
    silencer_shots: 0,
    weapon_sound: 0,
    pickup_msg_time: Gtime_from_ms(0),
    flood_locktill: Gtime_from_ms(0),
    flood_when: new Array(10).fill(Gtime_from_ms(0)),
    flood_whenhead: 0,
    respawn_time: Gtime_from_ms(0),
    chase_target: null,
    update_chase: false,
    double_time: Gtime_from_ms(0),
    ir_time: Gtime_from_ms(0),
    nuke_time: Gtime_from_ms(0),
    tracker_pain_time: Gtime_from_ms(0),
    owned_sphere: null,
    empty_click_sound: Gtime_from_ms(0),
    inmenu: false,
    menu: null,
    menutime: Gtime_from_ms(0),
    menudirty: false,
    ctf_grapple: null,
    ctf_grapplestate: 0,
    ctf_grapplereleasetime: Gtime_from_ms(0),
    ctf_regentime: Gtime_from_ms(0),
    ctf_techsndtime: Gtime_from_ms(0),
    ctf_lasttechmsg: Gtime_from_ms(0),
    trail_head: null,
    trail_tail: null,
    no_weapon_chains: false,
    landmark_free_fall: false,
    landmark_name: null,
    landmark_rel_pos: vec3(),
    landmark_noise_time: Gtime_from_ms(0),
    invisibility_fade_time: Gtime_from_ms(0),
    chase_msg_time: Gtime_from_ms(0),
    menu_sign: 0,
    last_ladder_pos: vec3(),
    last_ladder_sound: Gtime_from_ms(0),
    coop_respawn_state: 0,
    last_damage_time: Gtime_from_ms(0),
    sight_entity: null,
    sight_entity_time: Gtime_from_ms(0),
    sound_entity: null,
    sound_entity_time: Gtime_from_ms(0),
    sound2_entity: null,
    sound2_entity_time: Gtime_from_ms(0),
    num_lag_origins: 0,
    next_lag_origin: 0,
    is_lag_compensated: false,
    lag_restore_origin: vec3(),
    slow_view_angles: vec3(),
    slow_view_angle_time: Gtime_from_ms(0),
    help_draw_points: false,
    help_draw_index: 0,
    help_draw_count: 0,
    help_draw_time: Gtime_from_ms(0),
    step_frame: 0,
    help_poi_image: 0,
    help_poi_location: vec3(),
    awaiting_respawn: false,
    respawn_timeout: Gtime_from_ms(0),
    fog: [0, 0, 0, 0, 0],
    heightfog: { start: [0, 0, 0, 0], end: [0, 0, 0, 0], falloff: 0, density: 0 },
    last_attacker_time: Gtime_from_ms(0),
    last_firing_time: Gtime_from_ms(0),
  };
}

/** A player edict with 100/100 health, no armor, no powerups, takedamage on. */
function makePlayerEdict(edicts: EdictT[], index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "player";
  e.takedamage = true;
  e.health = 100;
  e.max_health = 100;
  e.mass = 200;
  e.movetype = MovetypeT.MOVETYPE_WALK;
  e.solid = SolidT.SOLID_BBOX; // findradius() skips SOLID_NOT (its own default) entirely
  e.client = makeClient();
  return e;
}

/** A generic non-client, non-monster damageable entity (e.g. a breakable) --
 *  used to exercise T_Damage without tripping the monster-AI paths
 *  (M_ReactToDamage's FoundTarget/visible cross-deps -- see file header). */
function makeBreakableEdict(edicts: EdictT[], index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "func_explosive";
  e.takedamage = true;
  e.health = 50;
  e.max_health = 50;
  e.mass = 200;
  e.movetype = MovetypeT.MOVETYPE_NONE;
  e.solid = SolidT.SOLID_BBOX; // findradius() skips SOLID_NOT (its own default) entirely
  return e;
}

const ORIGIN = vec3(0, 0, 0);
const NORMAL = vec3(0, 0, 1);
const MOD_UNKNOWN = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };

// ---------------------------------------------------------------------------
// T_Damage -- basic health subtraction
// ---------------------------------------------------------------------------

describe("T_Damage: basic health subtraction", () => {
  test("g_combat.cpp:538-539 -- !takedamage is a hard no-op", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.takedamage = false;
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 25, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(50);
  });

  test("g_combat.cpp:748-762 -- unarmored, unprotected target loses exactly `damage` health", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(20); // 50 - 30
  });

  test("g_combat.cpp:762-777 -- health <= 0 dispatches to Killed() and stops (no further pain/indicator bookkeeping)", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makeBreakableEdict(edicts, 2);
    let died = false;
    targ.die = () => {
      died = true;
    };

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 999, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBeLessThanOrEqual(0);
    expect(died).toBe(true); // Killed() -> non-monster -> targ.die(...)
  });
});

// ---------------------------------------------------------------------------
// T_Damage -- armor absorption math (g_combat.cpp:271-320, CheckArmor)
// ---------------------------------------------------------------------------

describe("T_Damage: armor absorption (CheckArmor, jacket/combat/body tables)", () => {
  test("jacket armor: normal_protection 0.30 -- 100 dmg absorbs ceil(0.30*100)=30, take=70", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.health = 100;
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = jacketarmor_info.max_count;
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(30); // 100 - (100-30)
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(jacketarmor_info.max_count - 30);
  });

  test("combat armor: normal_protection 0.60 -- 100 dmg absorbs 60, take=40", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.health = 100;
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT] = combatarmor_info.max_count;
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(60); // 100 - (100-60)
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT]).toBe(combatarmor_info.max_count - 60);
  });

  test("body armor: normal_protection 0.80 -- 100 dmg absorbs 80, take=20", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.health = 100;
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY] = bodyarmor_info.max_count;
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(80); // 100 - (100-80)
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY]).toBe(bodyarmor_info.max_count - 80);
  });

  test("ArmorIndex priority: jacket beats combat/body when the player carries more than one", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = 10;
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT] = 100;
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY] = 100;

    expect(CheckArmor(targ, ORIGIN, NORMAL, 10, 0, DamageflagsT.DAMAGE_NONE)).toBe(3); // ceil(0.30*10)=3, jacket only
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(7);
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT]).toBe(100); // untouched
  });

  test("DAMAGE_ENERGY uses energy_protection instead of normal_protection (combat armor: 0.30)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT] = combatarmor_info.max_count;

    const save = CheckArmor(targ, ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_ENERGY);

    expect(save).toBe(30); // ceil(0.30*100), NOT ceil(0.60*100)=60
  });

  test("DAMAGE_NO_ARMOR bypasses CheckArmor entirely (save=0, inventory untouched)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY] = bodyarmor_info.max_count;

    const save = CheckArmor(targ, ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_NO_ARMOR);

    expect(save).toBe(0);
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY]).toBe(bodyarmor_info.max_count);
  });

  test("DAMAGE_NO_REG_ARMOR (ROGUE) also bypasses CheckArmor", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = jacketarmor_info.max_count;

    expect(CheckArmor(targ, ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_NO_REG_ARMOR)).toBe(0);
  });

  test("armor absorption never exceeds the remaining pool (save clamped to *power)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = 5; // less than ceil(0.30*100)=30

    const save = CheckArmor(targ, ORIGIN, NORMAL, 100, 0, DamageflagsT.DAMAGE_NONE);

    expect(save).toBe(5);
    expect(targ.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CheckPowerArmor -- power screen (angle-gated) vs. power shield
// ---------------------------------------------------------------------------

describe("CheckPowerArmor: power screen angle gate and power shield math (g_combat.cpp:155-269)", () => {
  test("power screen: damage point in front (dot > 0.3) absorbs damage/3 at 1 cell per point", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.flags |= EntFlagsT.FL_POWER_ARMOR;
    targ.client!.pers.inventory[ItemIdT.IT_ITEM_POWER_SCREEN] = 1;
    targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 100;
    targ.s.angles = vec3(0, 0, 0); // facing +X
    const point = vec3(10, 0, 0); // damage arriving from directly in front (dot=1 > 0.3)

    const save = CheckPowerArmor(targ, point, NORMAL, 30, DamageflagsT.DAMAGE_NONE);

    expect(save).toBe(10); // damage/3 = 10, save=min(power*1,10)=10
    expect(targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS]).toBe(90); // power_used = 10/1 = 10 cells
  });

  test("power screen: damage point behind/beside (dot <= 0.3) absorbs nothing", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.flags |= EntFlagsT.FL_POWER_ARMOR;
    targ.client!.pers.inventory[ItemIdT.IT_ITEM_POWER_SCREEN] = 1;
    targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 100;
    targ.s.angles = vec3(0, 0, 0); // facing +X
    const point = vec3(-10, 0, 0); // damage arriving from directly behind (dot=-1 <= 0.3)

    const save = CheckPowerArmor(targ, point, NORMAL, 30, DamageflagsT.DAMAGE_NONE);

    expect(save).toBe(0);
    expect(targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS]).toBe(100); // untouched
  });

  test("power shield: damagePerCell=2, absorbs 2*damage/3 (no angle gate)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.flags |= EntFlagsT.FL_POWER_ARMOR;
    targ.client!.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] = 1;
    targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 100;
    const point = vec3(-999, -999, -999); // any point -- shield has no angle gate

    const save = CheckPowerArmor(targ, point, NORMAL, 30, DamageflagsT.DAMAGE_NONE);

    expect(save).toBe(20); // (2*30)/3 = 20, save=min(power*2, 20)=20
    expect(targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS]).toBe(90); // power_used = 20/2 = 10 cells
  });

  test("DAMAGE_NO_POWER_ARMOR bypasses power armor entirely", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.flags |= EntFlagsT.FL_POWER_ARMOR;
    targ.client!.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] = 1;
    targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 100;

    expect(CheckPowerArmor(targ, ORIGIN, NORMAL, 30, DamageflagsT.DAMAGE_NO_POWER_ARMOR)).toBe(0);
  });

  test("no cells means no power-armor type at all (PowerArmorType returns IT_NULL)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.flags |= EntFlagsT.FL_POWER_ARMOR;
    targ.client!.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] = 1;
    targ.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 0; // *power is the cells count -- zero means "no power" too

    expect(CheckPowerArmor(targ, ORIGIN, NORMAL, 30, DamageflagsT.DAMAGE_NONE)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T_Damage -- godmode / invincibility gates
// ---------------------------------------------------------------------------

describe("T_Damage: godmode / invincibility gates (g_combat.cpp:652-674)", () => {
  test("FL_GODMODE takes zero damage", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.flags |= EntFlagsT.FL_GODMODE;
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 40, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(50); // unchanged
  });

  test("DAMAGE_NO_PROTECTION overrides FL_GODMODE -- damage goes through", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.flags |= EntFlagsT.FL_GODMODE;
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 40, 0, DamageflagsT.DAMAGE_NO_PROTECTION, MOD_UNKNOWN);

    expect(targ.health).toBe(10); // 50-40
  });

  test("client invincible_time > level.time takes zero damage", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makePlayerEdict(edicts, 0);
    targ.client!.invincible_time = Gtime_from_ms(5000);
    level.time = Gtime_from_ms(1000);
    const attacker = makeBreakableEdict(edicts, 2);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 40, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(100); // unchanged
  });
});

// ---------------------------------------------------------------------------
// T_Damage -- monster surprise-damage bonus and the still-unported
// FoundTarget cross-dep (documented gap)
// ---------------------------------------------------------------------------

describe("T_Damage: monster-specific paths", () => {
  test("g_combat.cpp:608-614 -- surprise bonus doubles damage on a fresh monster's first hit from a client", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = edicts[1]!;
    targ.inuse = true;
    targ.classname = "monster_soldier";
    targ.takedamage = true;
    targ.health = 100;
    targ.max_health = 100;
    targ.mass = 200;
    targ.svflags |= 4; // SVF_MONSTER (kexapi/game.ts bit(2))
    targ.monsterinfo.aiflags |= 1n << 11n; // AI_DUCKED -- dodge the FoundTarget cross-dep (see file header)

    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 20, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(60); // 100 - 20*2
  });

  test("a fresh (non-AI_DUCKED) monster reacting to its first hit from a client runs the real FoundTarget/HuntTarget now that g_ai.ts has landed (g_ai.cpp:484) -- sets .enemy, wakes the attacker's sight_entity, and calls monsterinfo.run", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = edicts[1]!;
    targ.inuse = true;
    targ.classname = "monster_soldier";
    targ.takedamage = true;
    targ.health = 100;
    targ.max_health = 100;
    targ.mass = 200;
    targ.svflags |= 4; // SVF_MONSTER

    const runRecorder: { self: EdictT | null } = { self: null };
    targ.monsterinfo.run = (self) => {
      runRecorder.self = self;
    };

    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 5, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.enemy).toBe(attacker);
    expect(runRecorder.self).toBe(targ);
    expect(attacker.client!.sight_entity).toBe(targ);
  });

  test("a non-client, non-monster attacker (e.g. trigger_hurt) never reaches M_ReactToDamage's AI cross-deps", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = edicts[1]!;
    targ.inuse = true;
    targ.classname = "monster_soldier";
    targ.takedamage = true;
    targ.health = 100;
    targ.max_health = 100;
    targ.mass = 200;
    targ.svflags |= 4; // SVF_MONSTER
    const inflictor = makeBreakableEdict(edicts, 2); // neither .client nor SVF_MONSTER

    T_Damage(targ, inflictor, inflictor, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(70); // no surprise bonus (attacker.client is null), M_ReactToDamage's own first `return` fires
  });
});

// ---------------------------------------------------------------------------
// T_Damage -- inline friendly-fire check (NOT routed through CheckTeamDamage
// in this KEX source -- see g_combat.ts's own CheckTeamDamage comment)
// ---------------------------------------------------------------------------

describe("T_Damage: inline friendly-fire (g_combat.cpp:549-563)", () => {
  test("same-team hit with g_friendly_fire=0 zeroes damage and marks mod.friendly_fire (without mutating the caller's mod object)", () => {
    const { edicts, rec } = setupWorld(2, 8, 8);
    rec.cvars.set("g_friendly_fire", Object.assign(new CvarT(), { name: "g_friendly_fire", string: "0", value: 0 }));
    const targ = makePlayerEdict(edicts, 0);
    const attacker = makePlayerEdict(edicts, 1);
    // OnSameTeam requires coop or (ctf/teamplay + same ctf_team); simplest
    // reachable "same team" path for this port line is coop.
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));

    const callerMod = { id: ModIdT.MOD_BLASTER, friendly_fire: false, no_point_loss: false };
    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 40, 0, DamageflagsT.DAMAGE_NONE, callerMod);

    expect(targ.health).toBe(100); // damage zeroed
    expect(callerMod.friendly_fire).toBe(false); // by-value clone -- caller's object is untouched
  });
});

// ---------------------------------------------------------------------------
// T_Damage -- STAT_HIT_MARKER (g_combat.cpp:717-719, restored 2026-08-30)
// ---------------------------------------------------------------------------

describe("T_Damage: STAT_HIT_MARKER write (g_combat.cpp:717-719)", () => {
  test("attacker with a client accumulates take+psave+asave into their own STAT_HIT_MARKER stat", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(20); // 50 - 30, unaffected by the stat write
    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(30); // take=30, psave=asave=0
  });

  test("accumulates across multiple hits rather than overwriting", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 10, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);
    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 15, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(25);
  });

  test("attacker with no client (e.g. a trap/trigger) does not write the stat (nothing to write into)", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makeBreakableEdict(edicts, 2); // no .client

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(20); // damage still applies; just no client to record the marker on
  });

  test("self-damage (targ === attacker) does not write the stat (g_combat.cpp:718's `targ != attacker` gate)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const self = makePlayerEdict(edicts, 0);

    T_Damage(self, self, self, vec3(1, 0, 0), ORIGIN, NORMAL, 20, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(self.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(0);
  });

  test("a killing blow still marks (health is read BEFORE this call's own subtraction -- g_combat.cpp checks `targ->health > 0` ahead of `targ->health -= take`)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 999, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBeLessThanOrEqual(0);
    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(999); // targ was alive (health=50>0) when the gate was checked
  });

  test("hitting an already-dead target (health <= 0 before this call) does not write the stat (g_combat.cpp:718's `targ->health > 0` gate)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.health = 0; // already dead before this hit
    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(0);
  });

  test("MOD_TARGET_LASER hits never mark (g_combat.cpp:718's `mod.id != MOD_TARGET_LASER` gate)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makePlayerEdict(edicts, 0);
    const laserMod = { id: ModIdT.MOD_TARGET_LASER, friendly_fire: false, no_point_loss: false };

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, laserMod);

    expect(targ.health).toBe(20);
    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(0);
  });

  test("a dead monster target (SVF_DEADMONSTER) does not write the stat", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.svflags |= SvflagsT.SVF_DEADMONSTER;
    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(0);
  });

  test("a target with FL_NO_DAMAGE_EFFECTS does not write the stat", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.flags |= EntFlagsT.FL_NO_DAMAGE_EFFECTS;
    const attacker = makePlayerEdict(edicts, 0);

    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), ORIGIN, NORMAL, 30, 0, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(attacker.client!.ps.stats[PlayerStatT.STAT_HIT_MARKER]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Killed
// ---------------------------------------------------------------------------

describe("Killed (g_combat.cpp:84-112)", () => {
  test("health below -999 clamps to exactly -999", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    targ.health = -5000;
    const attacker = makeBreakableEdict(edicts, 2);

    Killed(targ, attacker, attacker, 100, ORIGIN, MOD_UNKNOWN);

    expect(targ.health).toBe(-999);
  });

  test("SVF_MONSTER targets return immediately: enemy/lastMOD are set, but die() is NOT called and deadflag is untouched", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = edicts[1]!;
    targ.inuse = true;
    targ.classname = "monster_soldier";
    targ.svflags |= 4; // SVF_MONSTER
    targ.health = -10;
    targ.deadflag = false;
    let died = false;
    targ.die = () => {
      died = true;
    };
    const attacker = makeBreakableEdict(edicts, 2);

    Killed(targ, attacker, attacker, 50, ORIGIN, MOD_UNKNOWN);

    expect(targ.enemy).toBe(attacker);
    expect(targ.lastMOD.id).toBe(MOD_UNKNOWN.id);
    expect(died).toBe(false); // "[Paril-KEX] monsters call die in their damage handler" -- not here
    expect(targ.deadflag).toBe(false); // this KEX source never touches deadflag in Killed()
  });

  test("non-monster targets DO call die() and setskin()", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const captured: { damage: number | null } = { damage: null };
    targ.die = (_self, _inflictor, _attacker, damage) => {
      captured.damage = damage;
    };
    let setskinCalled = false;
    targ.monsterinfo.setskin = () => {
      setskinCalled = true;
    };
    const attacker = makeBreakableEdict(edicts, 2);

    Killed(targ, attacker, attacker, 33, ORIGIN, MOD_UNKNOWN);

    expect(captured.damage).toBe(33);
    expect(setskinCalled).toBe(true);
  });

  test("lastMOD is a by-value copy -- mutating the caller's mod object afterward doesn't affect targ.lastMOD", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const targ = makeBreakableEdict(edicts, 1);
    const attacker = makeBreakableEdict(edicts, 2);
    const callerMod = { id: ModIdT.MOD_ROCKET, friendly_fire: false, no_point_loss: false };

    Killed(targ, attacker, attacker, 33, ORIGIN, callerMod);
    callerMod.friendly_fire = true;

    expect(targ.lastMOD.friendly_fire).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CheckTeamDamage / OnSameTeam
// ---------------------------------------------------------------------------

describe("CheckTeamDamage / OnSameTeam (g_combat.cpp:493-525)", () => {
  test("g_friendly_fire enabled -> CheckTeamDamage always false, regardless of team", () => {
    const { edicts, rec } = setupWorld(2, 8, 8);
    rec.cvars.set("g_friendly_fire", Object.assign(new CvarT(), { name: "g_friendly_fire", string: "1", value: 1 }));
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));
    const targ = makePlayerEdict(edicts, 0);
    const attacker = makePlayerEdict(edicts, 1);

    expect(CheckTeamDamage(targ, attacker)).toBe(false);
  });

  test("g_friendly_fire disabled + coop -> every pair of clients is on the same team", () => {
    const { edicts, rec } = setupWorld(2, 8, 8);
    rec.cvars.set("g_friendly_fire", Object.assign(new CvarT(), { name: "g_friendly_fire", string: "0", value: 0 }));
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));
    const targ = makePlayerEdict(edicts, 0);
    const attacker = makePlayerEdict(edicts, 1);

    expect(CheckTeamDamage(targ, attacker)).toBe(true);
    expect(OnSameTeam(targ, attacker)).toBe(true);
  });

  test("OnSameTeam: monsters (no .client) are never on a team", () => {
    const { edicts, rec } = setupWorld(1, 8, 8);
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));
    const targ = edicts[1]!;
    targ.inuse = true;
    targ.svflags |= 4; // SVF_MONSTER, no .client
    const attacker = makePlayerEdict(edicts, 0);

    expect(OnSameTeam(targ, attacker)).toBe(false);
  });

  test("OnSameTeam: an entity is never on its own team (ent1 === ent2)", () => {
    const { edicts, rec } = setupWorld(1, 8, 8);
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));
    const targ = makePlayerEdict(edicts, 0);

    expect(OnSameTeam(targ, targ)).toBe(false);
  });

  test("no coop, no ctf/teamplay -> two clients are NOT on the same team by default", () => {
    const { edicts } = setupWorld(2, 8, 8); // fake cvar() defaults every unregistered cvar's value to "0"
    const targ = makePlayerEdict(edicts, 0);
    const attacker = makePlayerEdict(edicts, 1);

    expect(OnSameTeam(targ, attacker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T_RadiusDamage -- falloff formula (g_combat.cpp:867-911)
// ---------------------------------------------------------------------------

describe("T_RadiusDamage: falloff formula against hand-computed values", () => {
  test("points = damage - 0.5*distance; a target 40 units away from 100 splash damage takes 80", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const inflictor = makeBreakableEdict(edicts, 1);
    inflictor.s.origin = vec3(0, 0, 0);
    inflictor.linked = false; // uses s.origin directly, not absmin/absmax

    const targ = makeBreakableEdict(edicts, 2);
    targ.s.origin = vec3(40, 0, 0); // 40 units from the inflictor
    targ.mins = vec3(0, 0, 0);
    targ.maxs = vec3(0, 0, 0); // bbox center == s.origin
    targ.health = 1000;

    T_RadiusDamage(inflictor, inflictor, 100, null, 200, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    // points = 100 - 0.5*40 = 80 -- CanDamage()'s fake trace always reports
    // fraction=1 (clear line of sight), so the hit goes through in full.
    expect(targ.health).toBe(1000 - 80);
  });

  test("the attacker itself takes half the computed points (points *= 0.5)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const inflictor = makeBreakableEdict(edicts, 1);
    inflictor.s.origin = vec3(0, 0, 0);

    const attacker = makePlayerEdict(edicts, 0);
    attacker.s.origin = vec3(20, 0, 0); // 20 units away -- also the "attacker" of this blast
    attacker.mins = vec3(0, 0, 0);
    attacker.maxs = vec3(0, 0, 0);
    attacker.health = 1000;
    attacker.max_health = 1000;

    T_RadiusDamage(inflictor, attacker, 100, null, 200, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    // points = 100 - 0.5*20 = 90, then *0.5 (self-splash halving) = 45
    expect(attacker.health).toBe(1000 - 45);
  });

  test("`ignore` is skipped entirely, even if it would otherwise take damage", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const inflictor = makeBreakableEdict(edicts, 1);
    inflictor.s.origin = vec3(0, 0, 0);

    const ignored = makeBreakableEdict(edicts, 2);
    ignored.s.origin = vec3(10, 0, 0);
    ignored.health = 1000;

    T_RadiusDamage(inflictor, inflictor, 100, ignored, 200, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(ignored.health).toBe(1000); // untouched
  });

  test("targets beyond the point where falloff reaches zero take no damage", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const inflictor = makeBreakableEdict(edicts, 1);
    inflictor.s.origin = vec3(0, 0, 0);

    const targ = makeBreakableEdict(edicts, 2);
    targ.s.origin = vec3(199, 0, 0); // inside `radius` (findradius' own cutoff) but points = 100-0.5*199 < 0
    targ.health = 1000;

    T_RadiusDamage(inflictor, inflictor, 100, null, 200, DamageflagsT.DAMAGE_NONE, MOD_UNKNOWN);

    expect(targ.health).toBe(1000); // points <= 0 -> CanDamage()/T_Damage() never called
  });
});

// ---------------------------------------------------------------------------
// CanDamage (g_combat.cpp:15-77)
// ---------------------------------------------------------------------------

describe("CanDamage", () => {
  test("clear line of sight (trace.fraction === 1) returns true", () => {
    const { edicts, traceResult } = setupWorld(0, 8, 8);
    traceResult.value = noHitTrace;
    const targ = makeBreakableEdict(edicts, 1);
    const inflictor = makeBreakableEdict(edicts, 2);

    expect(CanDamage(targ, inflictor)).toBe(true);
  });

  test("every ray blocked (trace.fraction < 1) returns false", () => {
    const { edicts, traceResult } = setupWorld(0, 8, 8);
    traceResult.value = blockedTrace;
    const targ = makeBreakableEdict(edicts, 1);
    const inflictor = makeBreakableEdict(edicts, 2);

    expect(CanDamage(targ, inflictor)).toBe(false);
  });
});
