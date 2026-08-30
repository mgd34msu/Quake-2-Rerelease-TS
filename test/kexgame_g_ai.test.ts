/*
Unit tests for the kex g_ai.cpp port (src/kexgame/g_ai.ts).

Self-sufficient per .orch/preferences.md rule 13: wires its own fake
KexGameImports/KexGameExports and a full GClientT fixture. The
KexGameImports fake is modeled after test/kexgame_g_monster.test.ts's own
fixture (mutable `traceImpl` hook); the GClientT fixture (ClientPersistantT/
ClientRespawnT/KexPmoveStateT/KexPlayerStateT/KexUsercmdT/makeClient) is
copied from test/kexgame_g_combat.test.ts's own fixture, since g_ai.ts's
FindTarget/AI_GetSightClient/AI_GetSoundClient need real player-with-client
edicts and no defaultGClient() factory exists anywhere in src/kexgame/ yet.

Randomness-testing approach (task brief: "randomness isn't seedable"):
`frandom()`/`irandom()` (src/kexgame/q_std.ts) are direct, unmodified
wrappers over `Math.random()`. Rather than stubbing q_std.ts (out of this
unit's file scope) or asserting nothing about probability-driven branches,
tests that need a specific probability roll temporarily replace the GLOBAL
`Math.random` with a fixed function (saved/restored per-test, never left
mocked across tests) -- e.g. `Math.random = () => 0` guarantees
`frandom() < chance` is true for any `chance > 0`, and `Math.random = () =>
0.999999` guarantees it's false. Every other test avoids relying on a
specific roll entirely, either by using a `chance` of exactly 0 (M_CheckAttack's
far_chance, a real, deterministic gate regardless of Math.random) or by
asserting only on GTime *ranges* for `random_time(...)`-derived fields
(`>= level.time`, `<= level.time + upperBoundMs`) rather than exact values.

Scope (20 cases, each citing the exact g_ai.cpp line range it exercises):
  - range_to (g_ai.cpp:380-383): real bounding-box distance, not a RANGE_*
    bucket.
  - visible (g_ai.cpp:392-438): trace fraction===1, a blocked trace, the
    PGM "trace ends exactly on `other`" carve-out, FL_NOVISIBLE's
    no-trace-at-all short circuit, and the `through_glass` default-true
    quirk (g_local.h:2307) gating whether CONTENTS_WINDOW is added to the
    trace mask.
  - infront (g_ai.cpp:447-464): the normal -0.30 dot threshold and the
    tighter 0.15 threshold an ambush monster with no enemy/trail_time uses
    instead.
  - FacingIdeal (g_ai.cpp:895-903): the normal 45/315 tolerance and
    AI_PATHING's tighter 5/355 tolerance.
  - ai_stand (g_ai.cpp:83-194): the idle-acquisition attempt cadence (first
    call arms idle_time without firing idle(); a later call past idle_time
    fires idle() and reschedules into [15s,30s]).
  - FindTarget (g_ai.cpp:649-885): the sight path (AI_GetSightClient),
    the sound path (AI_GetSoundClient(direct) + gi.inPHS's `portals=true`
    argument), SPAWNFLAG_MONSTER_AMBUSH gating indirect alert/sound
    sources, FL_NOTARGET excluding a player from the sight scan, and the
    `client === self.enemy` early-return (skip_found) path.
  - ai_checkattack / M_CheckAttack (g_ai.cpp:907-1394): melee vs. missile
    selection against scripted ranges, the far-range chance===0 gate
    (deterministic regardless of Math.random), and the blind-fire branch.
*/

import { describe, test, expect, afterEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION, ContentsT, SvflagsT, SolidT, MAX_STATS } from "../src/kexapi/game";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  EntFlagsT,
  ItemIdT,
  AmmoT,
  SPAWNFLAG_MONSTER_AMBUSH,
  RANGE_MELEE,
  RANGE_NEAR,
  RANGE_MID,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_from_sec, Gtime_add, GTIME_ZERO } from "../src/kexgame/gtime";
import { SpawnFlags_or } from "../src/kexgame/spawnflags";
import {
  range_to,
  visible,
  infront,
  FacingIdeal,
  FoundTarget,
  HuntTarget,
  AI_GetSightClient,
  AI_GetSoundClient,
  FindTarget,
  ai_stand,
  ai_checkattack,
  M_CheckAttack,
  M_CheckAttack_Base,
} from "../src/kexgame/g_ai";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (mirrors
// test/kexgame_g_monster.test.ts's own fixture)
// ---------------------------------------------------------------------------

function noHitTrace(end: Vec3AsArg): KexTraceT {
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

type Vec3AsArg = Float32Array;

let traceImpl: (
  start: Vec3AsArg,
  mins: Vec3AsArg | null,
  maxs: Vec3AsArg | null,
  end: Vec3AsArg,
  passent: KexEdictT | null,
  mask: number,
) => KexTraceT = (_start, _mins, _maxs, end) => noHitTrace(end);

interface InPHSCall {
  p1: Vec3AsArg;
  p2: Vec3AsArg;
  portals: boolean;
}
let inPHSResult = false;
let inPHSCalls: InPHSCall[] = [];
let areasConnectedResult = true;

function makeFakeGameImports(cvars: Map<string, CvarT>): KexGameImports {
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
    pointcontents() {
      return 0;
    },
    inPVS() {
      return false;
    },
    inPHS(p1, p2, portals) {
      inPHSCalls.push({ p1, p2, portals });
      return inPHSResult;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return areasConnectedResult;
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
function setupWorld(numEdicts: number, maxclients: number): { edicts: EdictT[]; cvars: Map<string, CvarT> } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < 16; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = maxclients;
  game.maxentities = 16;
  level.time = Gtime_from_ms(0);
  level.intermissiontime = GTIME_ZERO;
  level.disguise_violation_time = GTIME_ZERO;
  level.disguise_violator = null;

  traceImpl = (_s, _mn, _mx, end) => noHitTrace(end);
  inPHSResult = false;
  inPHSCalls = [];
  areasConnectedResult = true;

  const cvars = new Map<string, CvarT>();
  SetGameImports(makeFakeGameImports(cvars));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts, cvars };
}

/** A live, non-world entity with a small (-16..16) bounding box, absmin/absmax
 *  set directly (this fixture never calls gi.linkentity). */
function makeLiveEdict(index: number, origin: Vec3AsArg = vec3(0, 0, 0)): EdictT {
  const e = g_edicts[index]!;
  e.inuse = true;
  e.classname = "test_ent";
  e.solid = SolidT.SOLID_BBOX;
  e.s.origin = vec3(origin[0], origin[1], origin[2]);
  e.mins = vec3(-16, -16, -16);
  e.maxs = vec3(16, 16, 16);
  e.absmin = vec3(origin[0] - 16, origin[1] - 16, origin[2] - 16);
  e.absmax = vec3(origin[0] + 16, origin[1] + 16, origin[2] + 16);
  e.health = 100;
  e.max_health = 100;
  return e;
}

function makeMonster(index: number, origin: Vec3AsArg = vec3(0, 0, 0)): EdictT {
  const e = makeLiveEdict(index, origin);
  e.svflags |= SvflagsT.SVF_MONSTER;
  e.takedamage = true;
  return e;
}

// ---------------------------------------------------------------------------
// GClientT fixture -- copied from test/kexgame_g_combat.test.ts's own
// fixture (no defaultGClient() factory exists anywhere in src/kexgame/).
// ---------------------------------------------------------------------------

function makeClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: 0,
    autoswitch: 0,
    autoshield: -1,
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

/** A player edict (index in [1, game.maxclients]) with 100/100 health, no
 *  powerups, connected -- eligible for activePlayers()/AI_Get*Client. */
function makePlayerEdict(edicts: EdictT[], index: number, origin: Vec3AsArg = vec3(0, 0, 0)): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "player";
  e.takedamage = true;
  e.health = 100;
  e.max_health = 100;
  e.solid = SolidT.SOLID_BBOX;
  e.s.origin = vec3(origin[0], origin[1], origin[2]);
  e.mins = vec3(-16, -16, -16);
  e.maxs = vec3(16, 16, 16);
  e.absmin = vec3(origin[0] - 16, origin[1] - 16, origin[2] - 16);
  e.absmax = vec3(origin[0] + 16, origin[1] + 16, origin[2] + 16);
  e.client = makeClient();
  return e;
}

// ---------------------------------------------------------------------------
// Math.random control (see file header's "Randomness-testing approach")
// ---------------------------------------------------------------------------

const realMathRandom = Math.random;
afterEach(() => {
  Math.random = realMathRandom;
});

function forceFrandomLow(): void {
  Math.random = () => 0;
}
function forceFrandomHigh(): void {
  Math.random = () => 0.999999;
}

// ---------------------------------------------------------------------------
// range_to (g_ai.cpp:380-383)
// ---------------------------------------------------------------------------

describe("range_to", () => {
  test("returns the real gap between two bounding boxes, not a RANGE_* bucket (g_ai.cpp:380-383)", () => {
    setupWorld(2, 0);
    const a = makeLiveEdict(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(100, 0, 0));
    // both boxes are +-16 half-extent; centers 100 apart => gap = 100-16-16=68
    expect(range_to(a, b)).toBeCloseTo(68, 5);
  });

  test("overlapping boxes return 0, not a negative distance (g_ai.cpp:380-383 via distance_between_boxes)", () => {
    setupWorld(2, 0);
    const a = makeLiveEdict(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(10, 0, 0));
    expect(range_to(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// visible (g_ai.cpp:392-438)
// ---------------------------------------------------------------------------

describe("visible", () => {
  test("a trace reaching fraction===1 (nothing in the way) is visible (g_ai.cpp:436-437)", () => {
    setupWorld(2, 0);
    const a = makeMonster(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(200, 0, 0));
    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end);
    expect(visible(a, b)).toBe(true);
  });

  test("a trace blocked by an unrelated entity (fraction<1, ent!==other) is NOT visible (g_ai.cpp:437)", () => {
    setupWorld(2, 0);
    const a = makeMonster(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(200, 0, 0));
    const wall = g_edicts[3]!;
    wall.s.number = 3;
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.5, ent: wall as unknown as KexEdictT });
    expect(visible(a, b)).toBe(false);
  });

  test("a trace ending exactly on `other` still counts as visible even at fraction<1 (PGM, g_ai.cpp:437)", () => {
    setupWorld(2, 0);
    const a = makeMonster(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(200, 0, 0));
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.9, ent: b as unknown as KexEdictT });
    expect(visible(a, b)).toBe(true);
  });

  test("FL_NOVISIBLE short-circuits to false without ever tracing (g_ai.cpp:394-396)", () => {
    setupWorld(2, 0);
    const a = makeMonster(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(200, 0, 0));
    b.flags |= EntFlagsT.FL_NOVISIBLE;
    let traced = false;
    traceImpl = (_s, _mn, _mx, end) => {
      traced = true;
      return noHitTrace(end);
    };
    expect(visible(a, b)).toBe(false);
    expect(traced).toBe(false);
  });

  test("through_glass defaults to true (g_local.h:2307), so CONTENTS_WINDOW is NOT added to the default trace mask", () => {
    setupWorld(2, 0);
    const a = makeMonster(1, vec3(0, 0, 0));
    const b = makeLiveEdict(2, vec3(200, 0, 0));
    let seenMask = -1;
    traceImpl = (_s, _mn, _mx, end, _passent, mask) => {
      seenMask = mask;
      return noHitTrace(end);
    };
    visible(a, b); // no third argument -- through_glass defaults to true
    expect((seenMask & ContentsT.CONTENTS_WINDOW) === 0).toBe(true);

    visible(a, b, false); // explicit through_glass=false adds CONTENTS_WINDOW
    expect((seenMask & ContentsT.CONTENTS_WINDOW) !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// infront (g_ai.cpp:447-464)
// ---------------------------------------------------------------------------

describe("infront", () => {
  test("directly ahead (dot~1) is in front; directly behind (dot~-1) is not, for a normal (non-ambush) monster (g_ai.cpp:463)", () => {
    setupWorld(2, 0);
    const self = makeMonster(1, vec3(0, 0, 0));
    self.s.angles = vec3(0, 0, 0); // facing +X
    const ahead = makeLiveEdict(2, vec3(100, 0, 0));
    expect(infront(self, ahead)).toBe(true);

    const behind = g_edicts[3]!;
    behind.inuse = true;
    behind.s.origin = vec3(-100, 0, 0);
    expect(infront(self, behind)).toBe(false);
  });

  test("an ambush monster with no enemy and trail_time===0 uses the tighter 0.15 dot threshold instead of -0.30 (g_ai.cpp:460-461)", () => {
    setupWorld(2, 0);
    const self = makeMonster(1, vec3(0, 0, 0));
    self.s.angles = vec3(0, 0, 0); // facing +X
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH);
    self.enemy = null;
    self.monsterinfo.trail_time = GTIME_ZERO;

    // place `other` at a shallow angle whose dot is between -0.30 and 0.15:
    // dot = cos(theta); pick theta=80deg => dot ~ 0.174 (still > 0.15, so this
    // one IS infront under either threshold -- use a slightly wider angle
    // instead, theta=85deg => dot ~ 0.087, which is < 0.15 but > -0.30).
    const rad = (85 * Math.PI) / 180;
    const other = g_edicts[3]!;
    other.inuse = true;
    other.s.origin = vec3(Math.cos(rad) * 100, Math.sin(rad) * 100, 0);

    // ambush gating: NOT infront (0.087 < 0.15)
    expect(infront(self, other)).toBe(false);

    // the same geometry, without the ambush gate (enemy set), uses the loose
    // -0.30 threshold and IS infront (0.087 > -0.30)
    self.enemy = other;
    expect(infront(self, other)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FacingIdeal (g_ai.cpp:895-903)
// ---------------------------------------------------------------------------

describe("FacingIdeal", () => {
  test("normal monster: within 45deg of ideal_yaw is facing; 90deg off is not (g_ai.cpp:902)", () => {
    setupWorld(1, 0);
    const self = makeMonster(1);
    self.s.angles = vec3(0, 10, 0);
    self.ideal_yaw = 0;
    expect(FacingIdeal(self)).toBe(true);

    self.s.angles = vec3(0, 90, 0);
    expect(FacingIdeal(self)).toBe(false);
  });

  test("AI_PATHING tightens the tolerance to 5deg (g_ai.cpp:899-900)", () => {
    setupWorld(1, 0);
    const self = makeMonster(1);
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_PATHING;
    self.ideal_yaw = 0;

    self.s.angles = vec3(0, 10, 0); // within the normal 45deg tolerance...
    expect(FacingIdeal(self)).toBe(false); // ...but NOT within AI_PATHING's 5deg

    self.s.angles = vec3(0, 3, 0);
    expect(FacingIdeal(self)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ai_stand (g_ai.cpp:83-194) -- idle acquisition attempt cadence
// ---------------------------------------------------------------------------

describe("ai_stand: idle acquisition cadence (g_ai.cpp:181-193)", () => {
  test("first call (idle_time===0) arms idle_time WITHOUT invoking idle(); a later call past idle_time invokes idle() and reschedules into [15s,30s]", () => {
    setupWorld(1, 0);
    const self = makeMonster(1);
    // level.time must be > 0 before the first call: g_ai.cpp's own gate is
    // `level.time > idle_time`, and idle_time starts at 0 too -- `0 > 0` is
    // false, so a monster spawned at level.time===0 would never arm its
    // first idle_time until at least one frame has elapsed.
    level.time = Gtime_from_ms(1);
    // pausetime is set far in the future so `level.time > pausetime` never
    // trips the walk() branch, even after this test advances level.time.
    self.monsterinfo.pausetime = Gtime_from_sec(9999);
    let idleCalls = 0;
    self.monsterinfo.idle = () => {
      idleCalls++;
    };

    ai_stand(self, 0);
    expect(idleCalls).toBe(0);
    expect(self.monsterinfo.idle_time >= level.time).toBe(true);
    expect(self.monsterinfo.idle_time <= Gtime_add(level.time, Gtime_from_sec(15))).toBe(true);

    // advance time past the armed idle_time, call again
    level.time = Gtime_add(self.monsterinfo.idle_time, Gtime_from_ms(1));
    const afterIdleTime = self.monsterinfo.idle_time;
    ai_stand(self, 0);
    expect(idleCalls).toBe(1);
    expect(self.monsterinfo.idle_time >= Gtime_add(afterIdleTime, Gtime_from_sec(14))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FindTarget (g_ai.cpp:649-885)
// ---------------------------------------------------------------------------

describe("FindTarget", () => {
  test("sight path: a visible, non-notarget player is acquired via AI_GetSightClient, sets .enemy, and runs FoundTarget->HuntTarget->run (g_ai.cpp:690-696, 787-832)", () => {
    setupWorld(3, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.s.angles = vec3(0, 0, 0);
    const p = makePlayerEdict(g_edicts, 1, vec3(100, 0, 0));

    const runRecorder: { self: EdictT | null } = { self: null };
    self.monsterinfo.run = (s) => {
      runRecorder.self = s;
    };

    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end); // clear line of sight

    const found = FindTarget(self);
    expect(found).toBe(true);
    expect(self.enemy).toBe(p);
    expect(runRecorder.self).toBe(self);
  });

  test("sound path: no sight, AI_GetSoundClient(direct) finds a player's sound_entity, sets AI_SOUND_TARGET, and calls gi.inPHS with portals=true (g_ai.cpp:720-722, 843-846)", () => {
    setupWorld(3, 1);
    const self = makeMonster(3, vec3(0, 0, 0));
    self.s.angles = vec3(0, 0, 0);
    const p = makePlayerEdict(g_edicts, 1, vec3(500, 0, 0));

    const noiseEnt = makeLiveEdict(2, vec3(500, 0, 0));
    noiseEnt.classname = "player_noise";
    p.client!.sound_entity = noiseEnt;
    p.client!.sound_entity_time = level.time; // "just now"

    // no direct sight: AI_GetSightClient sees nobody (block visible() via a
    // wall so infront+visible never succeeds for the sight scan)
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.1, ent: null });

    inPHSResult = true;
    areasConnectedResult = true;

    // heard targets still run through FoundTarget->HuntTarget (g_ai.cpp:876,
    // 524-528), which needs a real monsterinfo.run.
    self.monsterinfo.run = () => {};

    const found = FindTarget(self);
    expect(found).toBe(true);
    expect(self.enemy).toBe(noiseEnt);
    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SOUND_TARGET) !== 0n).toBe(true);
    expect(inPHSCalls.length).toBeGreaterThan(0);
    expect(inPHSCalls[0]!.portals).toBe(true);
  });

  test("SPAWNFLAG_MONSTER_AMBUSH blocks the indirect sound source (AI_GetSoundClient(false)) but not a direct one (g_ai.cpp:724-728)", () => {
    setupWorld(3, 1);
    const self = makeMonster(3, vec3(0, 0, 0));
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH);
    const p = makePlayerEdict(g_edicts, 1, vec3(500, 0, 0));

    const noiseEnt = makeLiveEdict(2, vec3(500, 0, 0));
    noiseEnt.classname = "player_noise";
    // only the INDIRECT (sound2) slot is populated -- direct is empty
    p.client!.sound2_entity = noiseEnt;
    p.client!.sound2_entity_time = level.time;

    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.1, ent: null });
    inPHSResult = true;

    // AI_GetSoundClient(false) is only tried when `!self.enemy &&
    // !ambush` -- with ambush set, it's skipped entirely, so no target
    // is ever found.
    const found = FindTarget(self);
    expect(found).toBe(false);
    expect(self.enemy).toBe(null);
  });

  test("FL_NOTARGET players are excluded from AI_GetSightClient's candidate scan (g_ai.cpp:41-42)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.s.angles = vec3(0, 0, 0);
    const p = makePlayerEdict(g_edicts, 1, vec3(100, 0, 0));
    p.flags |= EntFlagsT.FL_NOTARGET;

    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end);

    expect(AI_GetSightClient(self)).toBe(null);
  });

  test("client === self.enemy short-circuits FindTarget's sight branch to `return false` immediately (g_ai.cpp:692-696)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.s.angles = vec3(0, 0, 0);
    const p = makePlayerEdict(g_edicts, 1, vec3(100, 0, 0));
    self.enemy = p;

    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end);

    // AI_GetSightClient finds `p` again; since it equals self.enemy already,
    // FindTarget returns false without re-running FoundTarget.
    expect(FindTarget(self)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ai_checkattack / M_CheckAttack (g_ai.cpp:907-1394)
// ---------------------------------------------------------------------------

describe("ai_checkattack / M_CheckAttack: melee vs. missile selection against scripted ranges", () => {
  test("enemy within RANGE_MELEE with melee ready selects AS_MELEE and returns true (g_ai.cpp:992-999)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.monsterinfo.melee = () => {};
    self.monsterinfo.melee_debounce_time = GTIME_ZERO;

    const enemy = g_edicts[1]!;
    enemy.inuse = true;
    enemy.classname = "player";
    enemy.solid = SolidT.SOLID_BBOX;
    enemy.health = 100;
    enemy.s.origin = vec3(RANGE_MELEE - 5, 0, 0); // well within melee range
    enemy.mins = vec3(-16, -16, -16);
    enemy.maxs = vec3(16, 16, 16);
    enemy.absmin = vec3(enemy.s.origin[0] - 16, -16, -16);
    enemy.absmax = vec3(enemy.s.origin[0] + 16, 16, 16);
    enemy.client = makeClient();

    self.enemy = enemy;
    // A real, unblocked traceline from self to enemy stops AT the enemy's
    // own CONTENTS_MONSTER/CONTENTS_PLAYER bounding box (fraction<1,
    // ent===enemy) -- it does not reach fraction===1, since the enemy's own
    // solidity is part of the trace mask. See visible()'s own
    // `fraction===1 || edictFrom(ent)===other` check for the same duality.
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.9, ent: enemy });

    // Called directly (not through ai_checkattack) so the AS_MELEE selection
    // itself is observable -- ai_checkattack's own dispatch tail immediately
    // calls ai_run_melee, which fires melee() and resets attack_state back
    // to AS_STRAIGHT in the same tick (g_ai.cpp:1113-1117), which would
    // otherwise mask the selection this test is about.
    const result = M_CheckAttack_Base(self, 0.7, 0.4, 0.25, 0.06, 0, 1.0);
    expect(result).toBe(true);
    expect(self.monsterinfo.attack_state).toBe(MonsterAttackStateT.AS_MELEE);
  });

  test("enemy beyond melee range with a forced-low frandom roll selects AS_MISSILE and stamps attack_finished=level.time (g_ai.cpp:1021-1044)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.monsterinfo.attack = () => {};
    self.monsterinfo.attack_finished = GTIME_ZERO;

    const enemy = g_edicts[1]!;
    enemy.inuse = true;
    enemy.classname = "player";
    enemy.solid = SolidT.SOLID_BBOX;
    enemy.health = 100;
    enemy.s.origin = vec3(RANGE_NEAR - 10, 0, 0); // near range, not melee
    enemy.mins = vec3(-16, -16, -16);
    enemy.maxs = vec3(16, 16, 16);
    enemy.absmin = vec3(enemy.s.origin[0] - 16, -16, -16);
    enemy.absmax = vec3(enemy.s.origin[0] + 16, 16, 16);
    enemy.client = makeClient();

    self.enemy = enemy;
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.9, ent: enemy });

    forceFrandomLow(); // guarantees frandom() < near_chance (0.25)

    // Called directly, same rationale as the melee test above --
    // ai_checkattack's dispatch tail (ai_run_missile) would immediately
    // overwrite both attack_state and attack_finished again after firing.
    const result = M_CheckAttack_Base(self, 0.7, 0.4, 0.25, 0.06, 0, 1.0);
    expect(result).toBe(true);
    expect(self.monsterinfo.attack_state).toBe(MonsterAttackStateT.AS_MISSILE);
    expect(self.monsterinfo.attack_finished).toBe(level.time);
  });

  test("far range's chance is exactly 0 in M_CheckAttack's own table, so it never auto-fires regardless of the frandom roll (g_ai.cpp:1095, deterministic gate)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.monsterinfo.checkattack = M_CheckAttack;
    self.monsterinfo.attack = () => {};
    self.monsterinfo.attack_finished = GTIME_ZERO;

    const enemy = g_edicts[1]!;
    enemy.inuse = true;
    enemy.classname = "player";
    enemy.solid = SolidT.SOLID_BBOX;
    enemy.health = 100;
    enemy.s.origin = vec3(RANGE_MID + 50, 0, 0); // beyond RANGE_MID -> far bucket
    enemy.mins = vec3(-16, -16, -16);
    enemy.maxs = vec3(16, 16, 16);
    enemy.absmin = vec3(enemy.s.origin[0] - 16, -16, -16);
    enemy.absmax = vec3(enemy.s.origin[0] + 16, 16, 16);
    enemy.client = makeClient();

    self.enemy = enemy;
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.9, ent: enemy });

    forceFrandomLow(); // even at the lowest possible roll, chance===0 means false

    const result = M_CheckAttack_Base(self, 0.7, 0.4, 0.25, 0.06, 0, 1.0);
    expect(result).toBe(false);
  });

  test("ai_checkattack's full dispatch tail fires melee() and resets attack_state back to AS_STRAIGHT in the same call (g_ai.cpp:1359-1394 dispatch, g_ai.cpp:1113-1117 ai_run_melee)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.monsterinfo.checkattack = M_CheckAttack;
    self.monsterinfo.melee_debounce_time = GTIME_ZERO;
    const meleeRecorder: { called: boolean } = { called: false };
    self.monsterinfo.melee = () => {
      meleeRecorder.called = true;
    };

    const enemy = g_edicts[1]!;
    enemy.inuse = true;
    enemy.classname = "player";
    enemy.solid = SolidT.SOLID_BBOX;
    enemy.health = 100;
    enemy.s.origin = vec3(RANGE_MELEE - 5, 0, 0); // well within melee range, directly ahead
    enemy.mins = vec3(-16, -16, -16);
    enemy.maxs = vec3(16, 16, 16);
    enemy.absmin = vec3(enemy.s.origin[0] - 16, -16, -16);
    enemy.absmax = vec3(enemy.s.origin[0] + 16, 16, 16);
    enemy.client = makeClient();

    self.enemy = enemy;
    self.s.angles = vec3(0, 0, 0); // already facing the enemy (yaw 0 == vectoyaw((1,0,0)))
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0.9, ent: enemy });

    const result = ai_checkattack(self, 0);
    expect(result).toBe(true);
    expect(meleeRecorder.called).toBe(true);
    // ai_run_melee's own post-fire reset (g_ai.cpp:1116-1117) -- the
    // transient AS_MELEE selection never survives past this same call.
    expect(self.monsterinfo.attack_state).toBe(MonsterAttackStateT.AS_STRAIGHT);
  });

  test("blocked line of sight + had_visibility + blindfire eligible enters AS_BLIND (g_ai.cpp:952-980)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    self.monsterinfo.blindfire = true;
    self.monsterinfo.blind_fire_delay = GTIME_ZERO;
    self.monsterinfo.had_visibility = true;
    self.monsterinfo.attack_finished = GTIME_ZERO; // already past
    self.monsterinfo.trail_time = GTIME_ZERO;
    self.monsterinfo.blind_fire_target = vec3(50, 0, 0);
    level.time = Gtime_from_sec(1); // > attack_finished and > trail_time+delay

    const enemy = g_edicts[1]!;
    enemy.inuse = true;
    enemy.classname = "player";
    enemy.solid = SolidT.SOLID_BBOX;
    enemy.health = 100;
    enemy.s.origin = vec3(300, 0, 0);
    enemy.mins = vec3(-16, -16, -16);
    enemy.maxs = vec3(16, 16, 16);
    enemy.absmin = vec3(284, -16, -16);
    enemy.absmax = vec3(316, 16, 16);
    enemy.client = makeClient();

    self.enemy = enemy;

    // Two tracelines see the "blocked" result: M_CheckAttack_Base's own
    // self->enemy check (call 1), and the `!visible(self, enemy)` check
    // inside its blindfire gate, which re-traces independently (call 2).
    // The third call is the blind-fire sanity trace (self->blind_fire_target,
    // CONTENTS_MONSTER only) -- clear (fraction===1), passing the "not
    // shooting a monster" check.
    let call = 0;
    traceImpl = (_s, _mn, _mx, end) => {
      call++;
      if (call <= 2) {
        return { ...noHitTrace(end), fraction: 0.3, ent: null }; // blocked, ent=world
      }
      return noHitTrace(end); // blind-fire sanity trace: clear
    };

    const result = M_CheckAttack_Base(self, 0.7, 0.4, 0.25, 0.06, 0, 1.0);
    expect(result).toBe(true);
    expect(self.monsterinfo.attack_state).toBe(MonsterAttackStateT.AS_BLIND);
  });
});

// ---------------------------------------------------------------------------
// FoundTarget / HuntTarget (g_ai.cpp:468-550) -- direct unit coverage
// ---------------------------------------------------------------------------

describe("FoundTarget / HuntTarget", () => {
  test("with no combattarget, FoundTarget delegates straight to HuntTarget (goalentity=enemy, run() called, ideal_yaw points at the enemy) (g_ai.cpp:524-528)", () => {
    setupWorld(2, 1);
    const self = makeMonster(2, vec3(0, 0, 0));
    const enemy = g_edicts[1]!;
    enemy.inuse = true;
    enemy.classname = "player";
    enemy.s.origin = vec3(100, 0, 0);
    enemy.client = makeClient();
    self.enemy = enemy;
    self.combattarget = null;

    const runRecorder: { self: EdictT | null } = { self: null };
    self.monsterinfo.run = (s) => {
      runRecorder.self = s;
    };

    FoundTarget(self);

    expect(self.goalentity).toBe(enemy);
    expect(runRecorder.self).toBe(self);
    expect(enemy.client!.sight_entity).toBe(self);
  });
});
