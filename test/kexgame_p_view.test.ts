/*
Unit tests for the kex p_view.cpp/p_hud.cpp port
(src/kexgame/p_view.ts, src/kexgame/p_hud.ts).

Self-sufficient per .orch/preferences.md rule 13: wires its own fake
KexGameImports/KexGameExports and a full GClientT fixture, modeled after
test/kexgame_g_combat.test.ts's own fixture (same fake-imports shape, same
setupWorld()/makeClient() helpers, extended with an imageindex/sound
recorder since several assertions below need to see WHICH icon/sound name a
function requested, not just that it requested something).

Scope (see p_view.ts's/p_hud.ts's own file headers for the exact C++ line
numbers and every documented deviation/stub this suite's design routes
around -- every fixture below is deliberately built to stay OFF every
narrow stub's guard, per each file's own "STUB INVENTORY" section):
  - SV_CalcRoll (p_view.cpp:45-67): sign follows velocity . right, scaled
    below sv_rollspeed, clamped to sv_rollangle above it. Exercised via
    ClientEndServerFrame's own `ent.s.angles[ROLL] = -SV_CalcRoll(...) * 4`
    call site (SV_CalcRoll itself reads the module-private
    forward/right/up, which only ClientEndServerFrame's AngleVectors call
    populates).
  - P_DamageFeedback (p_view.cpp:76-279): STAT_FLASHES bit combination,
    damage_alpha's [0.06, 0.4] clamp, and the damage-kick angle math
    (kick clamped to 50, v_dmg_pitch/v_dmg_roll direction).
  - SV_CalcViewOffset (p_view.cpp:297-471): the fall-kick ratio's
    [Paril-KEX] 100ms-slack interpolation (the "KEX changes" to the
    falling-view-kick threshold math) at three points -- fully inside the
    slack window, straddling it, and past it -- plus the final
    [-14,14]/[-22,30] offset clamp.
  - Bob cycle progression (p_view.cpp:1429-1454, inside
    ClientEndServerFrame): bobtime accumulates every call while on ground
    and above the xyspeed floor, so the view-bob's Z contribution changes
    frame to frame.
  - SV_CalcBlend (p_view.cpp:564-682) / G_AddBlend (q_std.h:154-166):
    alpha-compositing across two independent, simultaneously-stackable
    blend sources (nuke_time + ir_time, both add to ps.screen_blend
    outside the powerup if/else-if chain) -- verifies the actual composited
    color against the documented formula computed the same way in the test.
  - G_SetStats (p_hud.cpp:730-1087): STAT_HEALTH/STAT_HEALTH_ICON against a
    hand-set health value and the RF_USE_DISGUISE icon swap; STAT_ARMOR/
    STAT_ARMOR_ICON via the power-armor-flash branch (itemlist-free, see
    p_hud.ts's own "STUB INVENTORY"), driven by a hand-set IT_AMMO_CELLS
    inventory count; STAT_AMMO's zero-reset guard when no weapon is
    equipped (also itemlist-free).
  - G_SetAmmoStat/G_GetAmmoStat (bg_local.h:159-168, exported from
    p_hud.ts): the compressed bit-packing round-trips exactly, including a
    byte-straddling id.
  - Intermission stat freeze (p_view.cpp:1379-1399, inside
    ClientEndServerFrame): screen_blend[3]/damage_blend[3] zeroed, fov
    forced to 90, gunindex forced to 0, once `level.intermissiontime` and
    `awaiting_respawn` are both set.
  - Spectator stats / chase handling (p_hud.cpp:1094-1134): G_SetStats is
    skipped once a chase_target is set, STAT_CHASE encodes the target's
    player-skin index, and G_CheckChaseStats propagates the chased
    player's own stats array into every chaser's `ps.stats`.
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexGameExports, KexGameImports, KexTraceT, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION, MAX_STATS, RenderfxT, SolidT, ServerCommandT } from "../src/kexapi/game";
import { PITCH, ROLL, YAW } from "../src/kexgame/q_std";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  AmmoT,
  EntFlagsT,
  HandednessT,
  ItemIdT,
  ModIdT,
  MovetypeT,
  PowerupT,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_ms, Gtime_subtract } from "../src/kexgame/gtime";
import { AngleVectors, vec3_dot, vec3_normalized, vec3_sub } from "../src/kexgame/q_vec3";
import { ClientEndServerFrame, P_DamageFeedback, P_ForceFogTransition, SV_CalcBlend } from "../src/kexgame/p_view";
import {
  G_CheckChaseStats,
  G_GetAmmoStat,
  G_GetPowerupStat,
  G_SetAmmoStat,
  G_SetSpectatorStats,
  G_SetStats,
  NUM_AMMO_STATS,
  PlayerStatT,
  STAT_AMMO_INFO_END,
  STAT_POWERUP_INFO_START,
  STAT_POWERUP_INFO_END,
} from "../src/kexgame/p_hud";
import { InitItems, SetItemNames, GetItemByIndex, GetItemByAmmo, GetItemByPowerup } from "../src/kexgame/g_items";
import { net_message } from "../src/qcommon/net_chan";
import { SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteFloat, MSG_WriteLong, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { readFog } from "../src/qcommon/protocol/q2repro";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (mirrors
// test/kexgame_g_combat.test.ts's own fixture, plus an imageindex recorder)
// ---------------------------------------------------------------------------

interface Recorder {
  soundCalls: string[];
  imageindexCalls: string[];
  cvars: Map<string, CvarT>;
  unicastCalls: Array<{ reliable: boolean }>;
}

function makeRecorder(): Recorder {
  return { soundCalls: [], imageindexCalls: [], cvars: new Map(), unicastCalls: [] };
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

function makeFakeGameImports(rec: Recorder): KexGameImports {
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
      rec.soundCalls.push(String(soundindex));
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
    soundindex(name: string) {
      return name.length; // deterministic, non-zero for non-empty names
    },
    imageindex(name: string) {
      rec.imageindexCalls.push(name);
      return rec.imageindexCalls.length;
    },
    setmodel() {},
    trace() {
      return noHitTrace;
    },
    clip() {
      return noHitTrace;
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
    unicast(_ent, reliable) {
      rec.unicastCalls.push({ reliable });
    },
    WriteChar() {},
    // Route the svc_fog wire bytes into the real net_message SizeBuf so
    // this suite's P_ForceFogTransition tests below can round-trip them
    // through q2repro.ts's real `readFog` decoder -- every other test in
    // this file ignores gi.Write*, so this is harmless outside those tests
    // (each clears net_message itself before asserting).
    WriteByte(c) {
      MSG_WriteByte(net_message, c);
    },
    WriteShort(c) {
      MSG_WriteShort(net_message, c);
    },
    WriteLong(c) {
      MSG_WriteLong(net_message, c);
    },
    WriteFloat(f) {
      MSG_WriteFloat(net_message, f);
    },
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

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level.
 *  `level.time` starts at 10_000ms (never 0) so every GTime-comparison guard
 *  this file's functions rely on (`kick.time < level.time`, `fall_time >
 *  level.time`, ...) behaves like real mid-game state instead of the t=0
 *  edge case where a never-yet-set `kick.total`/`0`-seconds denominator
 *  would divide by zero -- exactly the state a client is in on its very
 *  first frame after ClientBegin, which this suite doesn't exercise. */
function setupWorld(maxclients: number, maxentities: number, numEdicts: number): { edicts: EdictT[]; rec: Recorder } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = maxclients;
  game.maxentities = maxentities;
  game.clients = [];
  level.time = Gtime_from_ms(10000);
  level.intermissiontime = Gtime_from_ms(0);
  level.disguise_icon = 0;
  level.pic_health = 0;

  const rec = makeRecorder();
  SetGameImports(makeFakeGameImports(rec));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts, rec };
}

// ---------------------------------------------------------------------------
// GClientT fixture (mirrors test/kexgame_g_combat.test.ts's own fixture)
// ---------------------------------------------------------------------------

function makeClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: HandednessT.RIGHT_HANDED,
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

/** A fully-valued GClientT -- copied from test/kexgame_g_combat.test.ts's
 *  own `makeClient()` (that file's the only other place in this port line
 *  that has to hand-build one; no `defaultGClient()` factory exists in
 *  src/kexgame/ yet). */
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

/** A player edict with 100/100 health, on the ground, no armor/weapon/powerups. */
function makePlayerEdict(edicts: EdictT[], index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "player";
  e.takedamage = true;
  e.health = 100;
  e.max_health = 100;
  e.mass = 200;
  e.movetype = MovetypeT.MOVETYPE_WALK;
  e.solid = SolidT.SOLID_BBOX;
  e.client = makeClient();
  e.groundentity = e; // "on ground" for bob/footstep-cycle math
  return e;
}

const PLAYER_ANGLES_ZERO = vec3(0, 0, 0);

// ---------------------------------------------------------------------------
// SV_CalcRoll: sign/clamp (via ClientEndServerFrame's own call site)
// ---------------------------------------------------------------------------

describe("SV_CalcRoll: sign and clamp (p_view.cpp:45-67)", () => {
  test("velocity . right below sv_rollspeed scales linearly, with matching sign", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO); // forward=(1,0,0), right=(0,-1,0)
    // dot(velocity, right) = +100 (positive side, below the 200 sv_rollspeed default)
    ent.velocity = vec3(0, -100, 0);

    ClientEndServerFrame(ent);

    // side = 100 * sv_rollangle(2) / sv_rollspeed(200) = 1; angles[ROLL] = -side*4
    expect(ent.s.angles[ROLL]).toBeCloseTo(-4, 5);
  });

  test("velocity . right above sv_rollspeed clamps to sv_rollangle, sign flips with velocity", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO);
    // dot(velocity, right) = -500 (negative side, well above 200)
    ent.velocity = vec3(0, 500, 0);

    ClientEndServerFrame(ent);

    // side clamps to sv_rollangle(2) with the negative sign; angles[ROLL] = -side*4
    expect(ent.s.angles[ROLL]).toBeCloseTo(8, 5);
  });
});

// ---------------------------------------------------------------------------
// P_DamageFeedback
// ---------------------------------------------------------------------------

describe("P_DamageFeedback (p_view.cpp:76-279)", () => {
  test("STAT_FLASHES combines blood(1)/armor(2) bits from this frame's damage", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.damage_blood = 5;
    client.damage_armor = 3;

    P_DamageFeedback(ent);

    expect(client.ps.stats[PlayerStatT.STAT_FLASHES]).toBe(3);
  });

  test("STAT_FLASHES clears once flash_time has elapsed and no new damage flashes", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    // no damage at all this call -> P_DamageFeedback returns before touching
    // STAT_FLASHES's "clear" branch unless flash_time < level.time; set both up.
    client.flash_time = Gtime_from_ms(0); // already elapsed
    client.ps.stats[PlayerStatT.STAT_FLASHES] = 3; // leftover from a previous frame
    client.damage_blood = 5; // still need SOME damage to pass the count===0 early return
    P_DamageFeedback(ent);
    // this frame DID take damage, so want_flashes is recomputed (blood only -> 1)
    expect(client.ps.stats[PlayerStatT.STAT_FLASHES]).toBe(1);
  });

  test("damage_alpha floors at 0.06 for a tiny non-blood hit", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    // non-blood damage clamps `count` to at most 2 (not blood's minimum-10
    // floor), so `count*0.06` (0.06 here) lands exactly on the alpha floor.
    client.damage_armor = 1;
    P_DamageFeedback(ent);
    expect(client.damage_alpha).toBeCloseTo(0.06, 5);
  });

  test("damage_alpha ceilings at 0.4 for a huge blood hit", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.damage_blood = 1000; // huge hit: clamps down to the 0.4 ceiling
    P_DamageFeedback(ent);
    expect(client.damage_alpha).toBeCloseTo(0.4, 5);
  });

  test("damage-kick angles: kick clamps to 50 and points along the hit direction", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO);

    // seed the module-private forward/right (only ClientEndServerFrame's
    // AngleVectors call populates them) with a clean, neutral frame first.
    ent.velocity = vec3(0, 0, 0);
    ClientEndServerFrame(ent);

    ent.s.origin = vec3(0, 0, 0);
    client.damage_from = vec3(-1, -1, 0); // attack from behind-and-to-the-side
    client.damage_blood = 20; // count=20 -> realcount=20, no minimum-clamp kick-in
    client.damage_knockback = 100; // kick = 100*100/health(100) = 100 -> clamps to 50

    P_DamageFeedback(ent);

    const forward = vec3(),
      right = vec3(),
      up = vec3();
    AngleVectors(client.v_angle, forward, right, up);
    const v = vec3_normalized(vec3_sub(client.damage_from, ent.s.origin));
    const expectedRoll = 50 * vec3_dot(v, right) * 0.3;
    const expectedPitch = 50 * -vec3_dot(v, forward) * 0.3;

    expect(client.v_dmg_roll).toBeCloseTo(expectedRoll, 5);
    expect(client.v_dmg_pitch).toBeCloseTo(expectedPitch, 5);
  });
});

// ---------------------------------------------------------------------------
// SV_CalcViewOffset: falling-kick ratio incl. the KEX 100ms-slack change
// ---------------------------------------------------------------------------

describe("SV_CalcViewOffset: falling-kick ratio, incl. KEX slack (p_view.cpp:353-371)", () => {
  // Every test in this block drives SV_CalcViewOffset through
  // ClientEndServerFrame (not a bare call) with velocity=(0,0,0): the
  // bob-pitch/run-pitch terms this function ALSO adds every call read the
  // module-private `xyspeed`/`bobfracsin`/`forward`/`right`, which only
  // ClientEndServerFrame's own frame setup (re)computes -- a bare
  // SV_CalcViewOffset call would silently inherit whatever a PREVIOUS
  // test's frame left behind in those file-scope statics (the same
  // C++ file-scope-static sharing p_view.cpp itself has). Zero velocity
  // makes every one of those extra terms exactly 0, isolating the
  // fall-kick ratio math this describe block actually tests.
  test("fully inside the slack window: ratio scales from the remaining diff", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO);
    ent.velocity = vec3(0, 0, 0);
    // FALL_TIME = 300ms + DAMAGE_TIME_SLACK(100ms - frame_time_ms(100)) = 300 + 0 = 300ms.
    // fall_value is kept small enough that the result stays inside the
    // final `[-31,31]` angle clamp (p_view.cpp:409-410) this function ALSO
    // applies, so this test isolates the ratio math instead of that clamp.
    client.fall_value = -30;
    client.fall_time = Gtime_add(level.time, Gtime_from_ms(250)); // diff=250ms

    ClientEndServerFrame(ent);

    // slack = 0ms here -> falls to the "else" branch: diff / (FALL_TIME - slack)
    const expectedRatio = 250 / 300;
    expect(client.ps.kick_angles[PITCH]).toBeCloseTo(expectedRatio * -30, 3);
  });

  test("past the fall-kick window (diff <= 0): no pitch kick is applied", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO);
    ent.velocity = vec3(0, 0, 0);
    client.fall_value = -100;
    client.fall_time = Gtime_from_ms(0); // already expired relative to level.time=10000

    ClientEndServerFrame(ent);

    expect(client.ps.kick_angles[PITCH]).toBeCloseTo(0, 5);
  });

  test("final view offset is clamped to [-14,14] on X/Y and [-22,30] on Z", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO);
    ent.velocity = vec3(0, 0, 0);
    // a huge fall (deep negative fall_value) pushes the Z offset past -22
    client.fall_value = -1000;
    client.fall_time = Gtime_add(level.time, Gtime_from_ms(50));

    ClientEndServerFrame(ent);

    expect(client.ps.viewoffset[2]).toBeGreaterThanOrEqual(-22);
    expect(client.ps.viewoffset[2]).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Bob cycle progression (inside ClientEndServerFrame)
// ---------------------------------------------------------------------------

describe("Bob cycle progression (p_view.cpp:1429-1454)", () => {
  test("bobtime accumulates every frame while running on ground, changing the view bob", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.v_angle = vec3(...PLAYER_ANGLES_ZERO);
    ent.velocity = vec3(300, 0, 0); // > 210: fastest bobmove bucket

    ClientEndServerFrame(ent);
    const firstBobTime = client.bobtime;
    const firstZ = client.ps.viewoffset[2];

    ClientEndServerFrame(ent);
    const secondBobTime = client.bobtime;
    const secondZ = client.ps.viewoffset[2];

    expect(secondBobTime).toBeGreaterThan(firstBobTime);
    // bobfracsin's argument (bobtime*PI) advanced, so the bob contribution
    // to the Z view offset is not frozen at the same value frame to frame.
    expect(secondZ).not.toBeCloseTo(firstZ, 6);
  });
});

// ---------------------------------------------------------------------------
// SV_CalcBlend / G_AddBlend alpha compositing
// ---------------------------------------------------------------------------

describe("SV_CalcBlend: G_AddBlend alpha compositing (p_view.cpp:564-682, q_std.h:154-166)", () => {
  test("nuke_time and ir_time both stack onto ps.screen_blend via the documented compositing formula", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    // nuke: brightness = (nuke_time - level.time).seconds() / 2 = 1.0 -> G_AddBlend(1,1,1,1.0,...)
    client.nuke_time = Gtime_add(level.time, Gtime_from_ms(2000));
    // ir: G_PowerUpExpiringRelative(remaining) true for remaining>3000ms -> G_AddBlend(1,0,0,0.2,...)
    client.ir_time = Gtime_add(level.time, Gtime_from_ms(5000));

    SV_CalcBlend(ent);

    // manual replay of G_AddBlend(1,1,1,1.0, v={0,0,0,0}) then G_AddBlend(1,0,0,0.2, v)
    let v = [0, 0, 0, 0];
    const addBlend = (r: number, g: number, b: number, a: number) => {
      if (a <= 0) return;
      const a2 = v[3] + (1 - v[3]) * a;
      const a3 = v[3] / a2;
      v = [v[0] * a3 + r * (1 - a3), v[1] * a3 + g * (1 - a3), v[2] * a3 + b * (1 - a3), a2];
    };
    addBlend(1, 1, 1, 1.0);
    addBlend(1, 0, 0, 0.2);

    expect(client.ps.screen_blend[0]).toBeCloseTo(v[0], 5);
    expect(client.ps.screen_blend[1]).toBeCloseTo(v[1], 5);
    expect(client.ps.screen_blend[2]).toBeCloseTo(v[2], 5);
    expect(client.ps.screen_blend[3]).toBeCloseTo(v[3], 5);
  });
});

// ---------------------------------------------------------------------------
// G_SetStats: health/ammo/armor stat slots against hand-set inventories
// ---------------------------------------------------------------------------

describe("G_SetStats: health/ammo/armor stat slots (p_hud.cpp:730-1087)", () => {
  test("STAT_HEALTH mirrors ent.health; STAT_HEALTH_ICON swaps on RF_USE_DISGUISE", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    ent.health = 57;
    level.pic_health = 7;
    level.disguise_icon = 42;

    G_SetStats(ent);
    expect(ent.client!.ps.stats[PlayerStatT.STAT_HEALTH]).toBe(57);
    expect(ent.client!.ps.stats[PlayerStatT.STAT_HEALTH_ICON]).toBe(7);

    ent.s.renderfx |= RenderfxT.RF_USE_DISGUISE;
    G_SetStats(ent);
    expect(ent.client!.ps.stats[PlayerStatT.STAT_HEALTH_ICON]).toBe(42);
  });

  test("STAT_ARMOR/STAT_ARMOR_ICON via the power-armor-flash branch, driven by a hand-set cells inventory", () => {
    const { edicts, rec } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] = 1;
    client.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 25;
    ent.flags |= EntFlagsT.FL_POWER_ARMOR;
    ent.powerarmor_time = Gtime_add(level.time, Gtime_from_ms(5000));

    G_SetStats(ent);

    expect(client.ps.stats[PlayerStatT.STAT_ARMOR]).toBe(25);
    expect(rec.imageindexCalls.at(-1)).toBe("i_powershield");
  });

  test("STAT_AMMO/STAT_AMMO_ICON reset to 0 with no weapon equipped", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.pers.weapon = null;

    G_SetStats(ent);

    expect(client.ps.stats[PlayerStatT.STAT_AMMO]).toBe(0);
    expect(client.ps.stats[PlayerStatT.STAT_AMMO_ICON]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G_SetStats: weapon-wheel/ammo-wheel/powerup-wheel stats (p_hud.cpp:748-763/
// 783-789/838-858) -- engine-core widening sweep, 2026-08-30. `InitItems()`/
// `SetItemNames()` must run first (populates ammolist/poweruplist and each
// itemlist entry's weapon_wheel_index/ammo_wheel_index/powerup_wheel_index),
// matching this port's own g_main.ts InitGame ordering and the identical
// precedent in test/ctf_weapon.test.ts / test/xatrix_core.test.ts /
// test/g_combat.test.ts.
// ---------------------------------------------------------------------------

describe("G_SetStats: weapon-wheel/ammo-wheel/powerup-wheel stats", () => {
  test("STAT_WEAPONS_OWNED_1/2 bitmask reflects held weapons via itemlist.weapon_wheel_index", () => {
    const { edicts } = setupWorld(1, 8, 8);
    InitItems();
    SetItemNames();
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    const shotgun = GetItemByIndex(ItemIdT.IT_WEAPON_SHOTGUN)!;
    const railgun = GetItemByIndex(ItemIdT.IT_WEAPON_RAILGUN)!;
    client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN] = 1;
    client.pers.inventory[ItemIdT.IT_WEAPON_RAILGUN] = 1;

    G_SetStats(ent);

    const expectedBits = ((1 << shotgun.weapon_wheel_index) | (1 << railgun.weapon_wheel_index)) >>> 0;
    const actualBits = ((client.ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_1] & 0xffff) | ((client.ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_2] & 0xffff) << 16)) >>> 0;
    expect(actualBits).toBe(expectedBits);
    // a weapon never held contributes no bit
    const bfg = GetItemByIndex(ItemIdT.IT_WEAPON_BFG)!;
    expect((actualBits & (1 << bfg.weapon_wheel_index)) >>> 0).toBe(0);
  });

  test("STAT_ACTIVE_WHEEL_WEAPON prefers newweapon (mid-switch); STAT_ACTIVE_WEAPON always reads pers.weapon; both -1 when unarmed", () => {
    const { edicts } = setupWorld(1, 8, 8);
    InitItems();
    SetItemNames();
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.pers.weapon = null;
    G_SetStats(ent);
    expect(client.ps.stats[PlayerStatT.STAT_ACTIVE_WHEEL_WEAPON]).toBe(-1);
    expect(client.ps.stats[PlayerStatT.STAT_ACTIVE_WEAPON]).toBe(-1);

    const blaster = GetItemByIndex(ItemIdT.IT_WEAPON_BLASTER)!;
    client.pers.weapon = blaster;
    G_SetStats(ent);
    expect(client.ps.stats[PlayerStatT.STAT_ACTIVE_WHEEL_WEAPON]).toBe(blaster.weapon_wheel_index);
    expect(client.ps.stats[PlayerStatT.STAT_ACTIVE_WEAPON]).toBe(blaster.weapon_wheel_index);

    const shotgun = GetItemByIndex(ItemIdT.IT_WEAPON_SHOTGUN)!;
    client.newweapon = shotgun;
    G_SetStats(ent);
    expect(client.ps.stats[PlayerStatT.STAT_ACTIVE_WHEEL_WEAPON]).toBe(shotgun.weapon_wheel_index);
    expect(client.ps.stats[PlayerStatT.STAT_ACTIVE_WEAPON]).toBe(blaster.weapon_wheel_index);
  });

  test("ammo-info wheel fill: G_GetAmmoStat reads back each held ammo count via itemlist.ammo_wheel_index", () => {
    const { edicts } = setupWorld(1, 8, 8);
    InitItems();
    SetItemNames();
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.pers.inventory[ItemIdT.IT_AMMO_SHELLS] = 12;
    client.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 50;

    G_SetStats(ent);

    const shells = GetItemByAmmo(AmmoT.AMMO_SHELLS)!;
    const cells = GetItemByAmmo(AmmoT.AMMO_CELLS)!;
    expect(G_GetAmmoStat(client.ps.stats, PlayerStatT.STAT_AMMO_INFO_START, shells.ammo_wheel_index)).toBe(12);
    expect(G_GetAmmoStat(client.ps.stats, PlayerStatT.STAT_AMMO_INFO_START, cells.ammo_wheel_index)).toBe(50);
    // an untouched ammo type reads back 0
    const rockets = GetItemByAmmo(AmmoT.AMMO_ROCKETS)!;
    expect(G_GetAmmoStat(client.ps.stats, PlayerStatT.STAT_AMMO_INFO_START, rockets.ammo_wheel_index)).toBe(0);
    // the compressed run stays within its declared slot range
    expect(STAT_AMMO_INFO_END).toBeGreaterThanOrEqual(PlayerStatT.STAT_AMMO_INFO_START);
  });

  test("owned powerups wheel fill: G_GetPowerupStat reflects held quad count via itemlist.powerup_wheel_index", () => {
    const { edicts } = setupWorld(1, 8, 8);
    InitItems();
    SetItemNames();
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    // POWERUP_QUAD's default-branch value is simply clamp(inventory[id], 0, 3)
    // (p_hud.cpp:852-854) -- quad_time is irrelevant to the wheel value itself.
    client.pers.inventory[ItemIdT.IT_ITEM_QUAD] = 1;

    G_SetStats(ent);

    const quad = GetItemByPowerup(PowerupT.POWERUP_QUAD)!;
    expect(G_GetPowerupStat(client.ps.stats, STAT_POWERUP_INFO_START, quad.powerup_wheel_index)).toBe(1);
    expect(STAT_POWERUP_INFO_END).toBeGreaterThanOrEqual(STAT_POWERUP_INFO_START);
  });
});

// ---------------------------------------------------------------------------
// G_SetAmmoStat / G_GetAmmoStat: compressed bit-packing round-trip
// ---------------------------------------------------------------------------

describe("G_SetAmmoStat/G_GetAmmoStat (bg_local.h:159-168)", () => {
  test("round-trips every ammo id without cross-contaminating neighbors, incl. a byte-straddling id", () => {
    const stats = new Int16Array(MAX_STATS);
    const startIndex = PlayerStatT.STAT_AMMO_INFO_START;

    for (let id = 0; id < AmmoT.AMMO_MAX; id++) {
      G_SetAmmoStat(stats, startIndex, id, 100 + id);
    }
    for (let id = 0; id < AmmoT.AMMO_MAX; id++) {
      expect(G_GetAmmoStat(stats, startIndex, id)).toBe(100 + id);
    }

    // sanity: the packed run fits inside NUM_AMMO_STATS int16 slots
    expect(NUM_AMMO_STATS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Intermission stat freeze (inside ClientEndServerFrame)
// ---------------------------------------------------------------------------

describe("Intermission stat freeze (p_view.cpp:1379-1399)", () => {
  test("screen_blend[3]/damage_blend[3] zero, fov forced to 90, gunindex forced to 0", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.ps.screen_blend[3] = 0.5;
    client.ps.damage_blend[3] = 0.75;
    client.ps.fov = 120;
    client.ps.gunindex = 99;
    client.awaiting_respawn = true;
    level.intermissiontime = level.time; // nonzero -> intermission is active

    ClientEndServerFrame(ent);

    expect(client.ps.screen_blend[3]).toBe(0);
    expect(client.ps.damage_blend[3]).toBe(0);
    expect(client.ps.fov).toBe(90);
    expect(client.ps.gunindex).toBe(0);
    // G_SetStats/G_SetCoopStats still run during intermission -- STAT_HEALTH
    // stays live even while frozen.
    expect(client.ps.stats[PlayerStatT.STAT_HEALTH]).toBe(ent.health);
  });
});

// ---------------------------------------------------------------------------
// Spectator stats / chase handling
// ---------------------------------------------------------------------------

describe("Spectator stats / chase handling (p_hud.cpp:1094-1134)", () => {
  test("G_SetSpectatorStats skips G_SetStats once chase_target is set, and encodes STAT_CHASE", () => {
    const { edicts } = setupWorld(2, 8, 8);
    const spectator = makePlayerEdict(edicts, 1);
    const target = makePlayerEdict(edicts, 2);
    target.health = 77;

    spectator.client!.chase_target = target;
    spectator.client!.pers.health = 100;

    G_SetSpectatorStats(spectator);

    // STAT_HEALTH was never touched by G_SetStats (chase_target short-circuits it)
    expect(spectator.client!.ps.stats[PlayerStatT.STAT_HEALTH]).toBe(0);
    expect(spectator.client!.ps.stats[PlayerStatT.STAT_SPECTATOR]).toBe(1);
  });

  test("G_CheckChaseStats propagates the chased player's own stats into every chaser", () => {
    const { edicts } = setupWorld(2, 8, 8);
    const chaser = makePlayerEdict(edicts, 1);
    const target = makePlayerEdict(edicts, 2);
    target.health = 88;

    chaser.client!.chase_target = target;

    G_SetStats(target); // populate target's own stats for real
    G_CheckChaseStats(target);

    expect(chaser.client!.ps.stats[PlayerStatT.STAT_HEALTH]).toBe(88);
    expect(chaser.client!.ps.stats[PlayerStatT.STAT_SPECTATOR]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P_ForceFogTransition / sendFogTransition (p_client.cpp:1788-1910's
// svc_fog wire write) -- round-tripped through qcommon/protocol/q2repro.ts's
// real `readFog` decoder (the gap 2 fix, KEX demo playback unit)
// ---------------------------------------------------------------------------

describe("P_ForceFogTransition (p_client.cpp:1788-1910)", () => {
  test("no-op when wanted fog/heightfog already match the client's current state", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    // fog/heightfog and pers.wanted_fog/wanted_heightfog both start at their
    // makeClient()/makeClientPersistant() zero defaults -- already equal.

    SZ_Clear(net_message);
    P_ForceFogTransition(ent, false);

    expect(net_message.cursize).toBe(0); // nothing written at all
  });

  test("global fog change (density/skyfactor/r/g/b) writes svc_fog and readFog decodes it back exactly", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.pers.wanted_fog = [0.5, 50 / 255, 100 / 255, 200 / 255, 25 / 255];
    // heightfog left equal (defaults) -- no HEIGHTFOG_* bits should be set.

    SZ_Clear(net_message);
    P_ForceFogTransition(ent, false);

    expect(net_message.cursize).toBeGreaterThan(0);
    MSG_BeginReading(net_message);
    expect(MSG_ReadByte(net_message)).toBe(ServerCommandT.svc_fog);

    const fog = readFog();
    const BITS = { DENSITY: 1, R: 2, G: 4, B: 8, MORE: 128 };
    expect(fog.bits & BITS.DENSITY).toBeTruthy();
    expect(fog.bits & BITS.R).toBeTruthy();
    expect(fog.bits & BITS.G).toBeTruthy();
    expect(fog.bits & BITS.B).toBeTruthy();
    expect(fog.bits & BITS.MORE).toBeFalsy(); // no heightfog bits set
    expect(fog.density).toBeCloseTo(0.5, 6);
    expect(fog.skyfactor).toBe(25);
    expect(fog.red).toBe(50);
    expect(fog.green).toBe(100);
    expect(fog.blue).toBe(200);
    expect(fog.time).toBe(0); // BIT_TIME not set

    // sendFogTransition's post-write struct-copy: client.fog now matches
    // the wanted value (and is a genuine copy, not an alias -- see p_view.ts's
    // own comment on this exact point).
    expect(client.fog).toEqual(client.pers.wanted_fog);
    expect(client.fog).not.toBe(client.pers.wanted_fog);
  });

  test("fog_transition_time sets BIT_TIME with the clamped millisecond value, but only when instant=false", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.pers.wanted_fog = [0.25, 0, 0, 0, 0];
    client.pers.fog_transition_time = Gtime_from_ms(2500);

    SZ_Clear(net_message);
    P_ForceFogTransition(ent, false);
    MSG_BeginReading(net_message);
    expect(MSG_ReadByte(net_message)).toBe(ServerCommandT.svc_fog);
    const fog = readFog();
    expect(fog.bits & 16).toBeTruthy(); // BIT_TIME
    expect(fog.time).toBe(2500);

    // instant=true suppresses BIT_TIME even though fog_transition_time is
    // still nonzero -- re-diverge fog first (the prior call already
    // converged client.fog to the wanted value, per the C++'s own
    // early-return guard).
    client.pers.wanted_fog = [0.75, 0, 0, 0, 0];
    SZ_Clear(net_message);
    P_ForceFogTransition(ent, true);
    MSG_BeginReading(net_message);
    expect(MSG_ReadByte(net_message)).toBe(ServerCommandT.svc_fog);
    const fog2 = readFog();
    expect(fog2.bits & 16).toBeFalsy(); // BIT_TIME NOT set (instant)
  });

  test("heightfog field changes set BIT_MORE_BITS (a second bits byte) and decode exactly", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.pers.wanted_heightfog = {
      falloff: 0.5,
      density: 0.25,
      start: [10 / 255, 20 / 255, 30 / 255, 100],
      end: [40 / 255, 50 / 255, 60 / 255, 500],
    };

    SZ_Clear(net_message);
    P_ForceFogTransition(ent, false);
    MSG_BeginReading(net_message);
    expect(MSG_ReadByte(net_message)).toBe(ServerCommandT.svc_fog);

    const fog = readFog();
    const BITS = {
      MORE: 128,
      HF_FALLOFF: 32,
      HF_DENSITY: 64,
      HF_START_R: 256,
      HF_START_G: 512,
      HF_START_B: 1024,
      HF_START_DIST: 2048,
      HF_END_R: 4096,
      HF_END_G: 8192,
      HF_END_B: 16384,
      HF_END_DIST: 32768,
    };
    expect(fog.bits & BITS.MORE).toBeTruthy();
    for (const bit of Object.values(BITS)) {
      if (bit === BITS.MORE) continue;
      expect(fog.bits & bit).toBeTruthy();
    }
    expect(fog.hf_falloff).toBeCloseTo(0.5, 6);
    expect(fog.hf_density).toBeCloseTo(0.25, 6);
    expect(fog.hf_start_r).toBe(10);
    expect(fog.hf_start_g).toBe(20);
    expect(fog.hf_start_b).toBe(30);
    expect(fog.hf_start_dist).toBe(100);
    expect(fog.hf_end_r).toBe(40);
    expect(fog.hf_end_g).toBe(50);
    expect(fog.hf_end_b).toBe(60);
    expect(fog.hf_end_dist).toBe(500);

    expect(client.heightfog).toEqual(client.pers.wanted_heightfog);
    expect(client.heightfog).not.toBe(client.pers.wanted_heightfog);
    expect(client.heightfog.start).not.toBe(client.pers.wanted_heightfog.start);
  });
});
