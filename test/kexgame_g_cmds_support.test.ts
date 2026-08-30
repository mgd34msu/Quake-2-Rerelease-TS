/*
Unit tests for the kex g_cmds.cpp / g_svcmds.cpp / g_chase.cpp / p_trail.cpp
ports (src/kexgame/g_cmds.ts, g_svcmds.ts, g_chase.ts, p_trail.ts).

Self-sufficient per .orch/preferences.md rule 13: wires its own fake
KexGameImports/KexGameExports and a full GClientT fixture. The
KexGameImports fake and the GClientT fixture (ClientPersistantT/
ClientRespawnT/KexPmoveStateT/KexPlayerStateT/KexUsercmdT/
makeClient/makePlayerEdict) are copied from test/kexgame_g_ai.test.ts's own
fixture (itself copied from test/kexgame_g_combat.test.ts's), since no
defaultGClient() factory exists anywhere in src/kexgame/ yet. `game.clients`
wiring (a separate array from `g_edicts[i].client`, read directly by
ChaseNext/ChasePrev/PlayerSort/Cmd_Players_f) is copied from
test/kexgame_p_client.test.ts's own `setupWorld`/`wireClient` precedent.

Scope (18 cases, each citing the exact C++ line range it exercises):
  - Cmd_Give_f (g_cmds.cpp:141-295): health with/without an explicit amount,
    the "ammo" bulk path (Add_Ammo across every IF_AMMO item), the "weapons"
    bulk path, the "armor" path (IT_ARMOR_BODY set to armor_info.max_count),
    an unknown item name (no state change), and the cheat gate itself
    (G_CheatCheck, g_cmds.cpp:104-113) both blocking and allowing.
  - Cmd_God_f / Cmd_Notarget_f / Cmd_Noclip_f (g_cmds.cpp:342-356,
    518-532, 583-602): FL_GODMODE/FL_NOTARGET toggle on then off (bigint
    XOR), MOVETYPE_WALK<->MOVETYPE_NOCLIP toggle.
  - CheckFlood (g_cmds.cpp:1180-1211): the ring-buffer window math via
    GTime -- first message passes and stamps flood_when, a message inside
    the flood_persecond window locks flood_locktill, a message after
    flood_locktill has elapsed passes again, and flood_msgs=0 disables the
    whole mechanism unconditionally.
  - SV_FilterPacket / SVCmd_AddIP_f / SVCmd_RemoveIP_f (g_svcmds.cpp:63-203):
    a full-octet mask filtering an exact address, a partial ("192.246.40")
    mask matching every last octet (StringToFilter's octet-by-octet
    255-or-0 mask build), removeip un-filtering a previously added address,
    and the filterban=0 whitelist-mode inversion.
  - ChaseNext / ChasePrev / GetChaseTarget (g_chase.cpp:99-171): next/prev
    wraparound across spectators mixed with non-spectators, GetChaseTarget
    acquiring the first non-spectator client, and its "no players to chase"
    message-throttling path when every client is a spectator.
  - PlayerTrail_Add / PlayerTrail_Pick / PlayerTrail_Destroy
    (p_trail.cpp:30-153): the visible-head-skips-a-new-marker gate, the
    dead/noclip/no-ground/intermission guards, ring growth linking
    (chain/enemy pointers), the TRAIL_LENGTH=8 tail-reuse-as-new-head
    identity swap, Pick's trail_time skip-forward + visibility-walk rule
    (next=false) and its closest-marker-then-advance-one rule (next=true),
    Pick's two early-null guards, and Destroy's per-owner vs. global (null)
    scope.
*/

import { describe, test, expect, afterEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION, ContentsT, SolidT, MAX_STATS } from "../src/kexapi/game";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  EntFlagsT,
  ItemIdT,
  AmmoT,
  MovetypeT,
  bodyarmor_info,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_from_sec, Gtime_add, GTIME_ZERO, type GTime } from "../src/kexgame/gtime";
import { Cmd_Give_f, Cmd_God_f, Cmd_Notarget_f, Cmd_Noclip_f, CheckFlood } from "../src/kexgame/g_cmds";
import { SV_FilterPacket, SVCmd_AddIP_f, SVCmd_RemoveIP_f } from "../src/kexgame/g_svcmds";
import { ChaseNext, ChasePrev, GetChaseTarget } from "../src/kexgame/g_chase";
import { PlayerTrail_Add, PlayerTrail_Pick, PlayerTrail_Destroy } from "../src/kexgame/p_trail";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied from
// test/kexgame_g_ai.test.ts's own fixture; see file header)
// ---------------------------------------------------------------------------

type Vec3AsArg = Float32Array;

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

let traceImpl: (
  start: Vec3AsArg,
  mins: Vec3AsArg | null,
  maxs: Vec3AsArg | null,
  end: Vec3AsArg,
  passent: KexEdictT | null,
  mask: number,
) => KexTraceT = (_start, _mins, _maxs, end) => noHitTrace(end);

let argvValues: string[] = [];

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
      return true;
    },
    inPHS() {
      return true;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return true;
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
      return argvValues.length;
    },
    argv(n: number) {
      return argvValues[n] ?? "";
    },
    args() {
      return argvValues.slice(1).join(" ");
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
  for (let i = 0; i < 32; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = maxclients;
  game.maxentities = 32;
  game.clients = [];
  for (let i = 0; i < maxclients; i++) game.clients.push(makeClient());
  level.time = Gtime_from_ms(0);
  level.intermissiontime = GTIME_ZERO;
  level.pic_ping = 0;
  level.current_poi = vec3();
  level.valid_poi = false;

  traceImpl = (_s, _mn, _mx, end) => noHitTrace(end);
  argvValues = [];

  const cvars = new Map<string, CvarT>();
  SetGameImports(makeFakeGameImports(cvars));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));
  globals.num_edicts = numEdicts;

  return { edicts, cvars };
}

function setCvar(cvars: Map<string, CvarT>, name: string, value: string): void {
  const c = new CvarT();
  c.name = name;
  c.string = value;
  c.value = Number(value);
  cvars.set(name, c);
}

function setArgv(...args: string[]): void {
  argvValues = args;
}

// ---------------------------------------------------------------------------
// GClientT fixture -- copied from test/kexgame_g_ai.test.ts's own fixture
// ---------------------------------------------------------------------------

function makeClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "player",
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
    // non-zero so Add_Ammo's G_AddAmmoAndCap (g_items.cpp) has real headroom
    // to add into -- a real player always has a nonzero starting cap.
    max_ammo: new Int16Array(AmmoT.AMMO_MAX).fill(999),
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

/** A player edict (index in [1, game.maxclients]) with 100/100 health,
 *  wired to `game.clients[index-1]` (matching the ClientConnect/ClientBegin
 *  invariant, per test/kexgame_p_client.test.ts's own `wireClient`
 *  precedent). */
function makePlayerEdict(edicts: EdictT[], index: number, origin: Vec3AsArg = vec3(0, 0, 0)): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "player";
  e.health = 100;
  e.max_health = 100;
  e.solid = SolidT.SOLID_BBOX;
  e.s.origin = vec3(origin[0], origin[1], origin[2]);
  e.s.old_origin = vec3(origin[0], origin[1], origin[2]);
  e.mins = vec3(-16, -16, -16);
  e.maxs = vec3(16, 16, 16);
  e.absmin = vec3(origin[0] - 16, origin[1] - 16, origin[2] - 16);
  e.absmax = vec3(origin[0] + 16, origin[1] + 16, origin[2] + 16);
  e.movetype = MovetypeT.MOVETYPE_WALK;
  e.groundentity = edicts[0]!;
  e.client = game.clients[index - 1]!;
  return e;
}

const realMathRandom = Math.random;
afterEach(() => {
  Math.random = realMathRandom;
});

// ---------------------------------------------------------------------------
// Cmd_Give_f (g_cmds.cpp:141-295)
// ---------------------------------------------------------------------------

describe("Cmd_Give_f", () => {
  test("G_CheatCheck blocks give when maxclients > 1 and sv_cheats is 0 (g_cmds.cpp:104-113)", () => {
    const { edicts, cvars } = setupWorld(4, 4);
    setCvar(cvars, "sv_cheats", "0");
    const p = makePlayerEdict(edicts, 1);
    setArgv("give", "health", "50");

    Cmd_Give_f(p);

    expect(p.health).toBe(100); // unchanged -- cheat check rejected the command
  });

  test("G_CheatCheck allows give when sv_cheats is 1 even with maxclients > 1 (g_cmds.cpp:104-113)", () => {
    const { edicts, cvars } = setupWorld(4, 4);
    setCvar(cvars, "sv_cheats", "1");
    const p = makePlayerEdict(edicts, 1);
    p.health = 10;
    setArgv("give", "health", "50");

    Cmd_Give_f(p);

    expect(p.health).toBe(50);
  });

  test("give health <amount> sets health to the explicit amount (g_cmds.cpp:160-168)", () => {
    const { edicts } = setupWorld(2, 1); // maxclients===1 -> cheat check always passes
    const p = makePlayerEdict(edicts, 1);
    p.health = 10;
    setArgv("give", "health", "77");

    Cmd_Give_f(p);

    expect(p.health).toBe(77);
  });

  test("give health with no amount sets health to max_health (g_cmds.cpp:162-165)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    p.health = 10;
    p.max_health = 150;
    setArgv("give", "health");

    Cmd_Give_f(p);

    expect(p.health).toBe(150);
  });

  test("give ammo bulk-fills every IF_AMMO item via Add_Ammo (g_cmds.cpp:185-201)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    expect(p.client!.pers.inventory[ItemIdT.IT_AMMO_SHELLS]).toBe(0);
    setArgv("give", "ammo");

    Cmd_Give_f(p);

    expect(p.client!.pers.inventory[ItemIdT.IT_AMMO_SHELLS]).toBeGreaterThan(0);
    expect(p.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS]).toBeGreaterThan(0);
  });

  test("give weapons bulk-increments every IF_WEAPON item's inventory count (g_cmds.cpp:170-183)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    expect(p.client!.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN]).toBe(0);
    setArgv("give", "weapons");

    Cmd_Give_f(p);

    expect(p.client!.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN]).toBe(1);
  });

  test("give armor sets IT_ARMOR_BODY to armor_info.max_count and clears jacket/combat (g_cmds.cpp:203-211)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    p.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = 5;
    setArgv("give", "armor");

    Cmd_Give_f(p);

    expect(p.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(0);
    expect(p.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY]).toBe(bodyarmor_info.max_count);
  });

  test("give <unknown item name> leaves inventory/health untouched (g_cmds.cpp:244-257)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    p.health = 42;
    setArgv("give", "not_a_real_item_xyz");

    Cmd_Give_f(p);

    expect(p.health).toBe(42);
    expect(p.client!.pers.inventory.every((n) => n === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cmd_God_f / Cmd_Notarget_f / Cmd_Noclip_f (g_cmds.cpp:342-356, 518-532, 583-602)
// ---------------------------------------------------------------------------

describe("cheat flag toggles", () => {
  test("Cmd_God_f XORs FL_GODMODE on then off (g_cmds.cpp:342-356)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    expect(p.flags & EntFlagsT.FL_GODMODE).toBe(0n);

    Cmd_God_f(p);
    expect(p.flags & EntFlagsT.FL_GODMODE).toBe(EntFlagsT.FL_GODMODE);

    Cmd_God_f(p);
    expect(p.flags & EntFlagsT.FL_GODMODE).toBe(0n);
  });

  test("Cmd_Notarget_f XORs FL_NOTARGET on then off (g_cmds.cpp:518-532)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);

    Cmd_Notarget_f(p);
    expect(p.flags & EntFlagsT.FL_NOTARGET).toBe(EntFlagsT.FL_NOTARGET);

    Cmd_Notarget_f(p);
    expect(p.flags & EntFlagsT.FL_NOTARGET).toBe(0n);
  });

  test("Cmd_Noclip_f toggles MOVETYPE_WALK <-> MOVETYPE_NOCLIP (g_cmds.cpp:583-602)", () => {
    const { edicts } = setupWorld(2, 1);
    const p = makePlayerEdict(edicts, 1);
    expect(p.movetype).toBe(MovetypeT.MOVETYPE_WALK);

    Cmd_Noclip_f(p);
    expect(p.movetype).toBe(MovetypeT.MOVETYPE_NOCLIP);

    Cmd_Noclip_f(p);
    expect(p.movetype).toBe(MovetypeT.MOVETYPE_WALK);
  });
});

// ---------------------------------------------------------------------------
// CheckFlood (g_cmds.cpp:1180-1211)
// ---------------------------------------------------------------------------

describe("CheckFlood", () => {
  test("flood_msgs=0 disables the mechanism unconditionally", () => {
    const { edicts, cvars } = setupWorld(2, 1);
    setCvar(cvars, "flood_msgs", "0");
    const p = makePlayerEdict(edicts, 1);

    expect(CheckFlood(p)).toBe(false);
    expect(CheckFlood(p)).toBe(false);
  });

  // The ring buffer is `client.flood_when` (length 10, all-zero at rest).
  // Each call reads slot `(head - flood_msgs + 1) mod 10` BEFORE advancing
  // `head` -- with flood_msgs=4, that slot only holds a REAL prior
  // timestamp once at least 5 calls have happened (4 to fill slots
  // 7,8,9,0, a 5th to finally re-read slot 1, written by the very first
  // call) -- exactly `flood_msgs + 1` messages, matching the C++ ring math
  // bug-for-bug. `level.time` starts at a non-zero base (1000ms) so a
  // legitimately-written "time zero" timestamp is never confused with an
  // unwritten (`Gtime_nonzero` false) slot.
  test("a message inside the flood_persecond window locks flood_locktill (g_cmds.cpp:1195-1206)", () => {
    const { edicts, cvars } = setupWorld(2, 1);
    setCvar(cvars, "flood_msgs", "4");
    setCvar(cvars, "flood_persecond", "4");
    setCvar(cvars, "flood_waitdelay", "10");
    const p = makePlayerEdict(edicts, 1);

    for (const t of [1000, 1100, 1200, 1300]) {
      level.time = Gtime_from_ms(t);
      expect(CheckFlood(p)).toBe(false); // ring not full yet -- always passes
    }

    level.time = Gtime_from_ms(1400); // 5th message, 400ms after the 1st -- inside the 4s window
    expect(CheckFlood(p)).toBe(true);
    expect(p.client!.flood_locktill).toEqual(Gtime_add(level.time, Gtime_from_sec(10)));
  });

  test("a message after flood_locktill has elapsed passes again (g_cmds.cpp:1189-1194)", () => {
    const { edicts, cvars } = setupWorld(2, 1);
    setCvar(cvars, "flood_msgs", "4");
    setCvar(cvars, "flood_persecond", "4");
    setCvar(cvars, "flood_waitdelay", "10");
    const p = makePlayerEdict(edicts, 1);

    for (const t of [1000, 1100, 1200, 1300]) {
      level.time = Gtime_from_ms(t);
      expect(CheckFlood(p)).toBe(false);
    }
    level.time = Gtime_from_ms(1400);
    expect(CheckFlood(p)).toBe(true); // locks: flood_locktill = 1400 + 10000 = 11400

    level.time = Gtime_from_ms(2000);
    expect(CheckFlood(p)).toBe(true); // still inside flood_locktill -- the EARLY guard, not the ring check

    // jump well past flood_locktill (11400) AND past the ring window relative to slot 1 (t=1000)
    level.time = Gtime_add(p.client!.flood_locktill, Gtime_from_ms(100));
    expect(CheckFlood(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SV_FilterPacket / SVCmd_AddIP_f / SVCmd_RemoveIP_f (g_svcmds.cpp:63-221)
// ---------------------------------------------------------------------------

describe("IP filtering (g_svcmds.ts)", () => {
  test("addip with a full address filters an exact match, filterban=1 default (g_svcmds.cpp:110-172)", () => {
    setupWorld(2, 1);
    setArgv("sv", "addip", "10.0.0.5");

    SVCmd_AddIP_f();

    expect(SV_FilterPacket("10.0.0.5:27910")).toBe(true); // exact match -> filtered (default filterban=1)
    expect(SV_FilterPacket("10.0.0.6:27910")).toBe(false); // no match -> allowed
  });

  test("addip with a partial address ('192.246.40') masks only the specified octets (g_svcmds.cpp:63-103)", () => {
    setupWorld(2, 1);
    setArgv("sv", "addip", "192.246.40");

    SVCmd_AddIP_f();

    // every last octet should match the 3-octet mask
    expect(SV_FilterPacket("192.246.40.1")).toBe(true);
    expect(SV_FilterPacket("192.246.40.254")).toBe(true);
    expect(SV_FilterPacket("192.246.41.1")).toBe(false);
  });

  // `ipfilters`/`numipfilters` (g_svcmds.ts) are module-level state with no
  // reset hook -- each test below uses an address family no other test in
  // this file touches, so tests remain independent regardless of run order
  // (see g_svcmds.ts's own file header: "the tail past numipfilters is
  // simply unused", i.e. entries accumulate for the process lifetime).
  test("removeip un-filters a previously added exact address (g_svcmds.cpp:179-203)", () => {
    const { cvars } = setupWorld(2, 1);
    setCvar(cvars, "filterban", "1");
    setArgv("sv", "addip", "203.0.113.6");
    SVCmd_AddIP_f();
    expect(SV_FilterPacket("203.0.113.6:0")).toBe(true);

    setArgv("sv", "removeip", "203.0.113.6");
    SVCmd_RemoveIP_f();

    expect(SV_FilterPacket("203.0.113.6:0")).toBe(false);
  });

  test("filterban=0 inverts to whitelist mode (g_svcmds.cpp:135-139)", () => {
    const { cvars } = setupWorld(2, 1);
    setCvar(cvars, "filterban", "0");
    setArgv("sv", "addip", "203.0.113.7");
    SVCmd_AddIP_f();

    expect(SV_FilterPacket("203.0.113.7:0")).toBe(false); // listed -> allowed under whitelist mode
    expect(SV_FilterPacket("203.0.113.9:0")).toBe(true); // unlisted -> blocked under whitelist mode
  });
});

// ---------------------------------------------------------------------------
// ChaseNext / ChasePrev / GetChaseTarget (g_chase.cpp:99-171)
// ---------------------------------------------------------------------------

describe("chase target acquisition/next/prev (g_chase.ts)", () => {
  test("ChaseNext skips spectators and wraps from the last client back to the first (g_chase.cpp:99-122)", () => {
    const { edicts } = setupWorld(6, 4);
    const p1 = makePlayerEdict(edicts, 1);
    const p2 = makePlayerEdict(edicts, 2);
    p2.client!.resp.spectator = true; // skipped
    const p3 = makePlayerEdict(edicts, 3);
    const spectator = makePlayerEdict(edicts, 4);
    spectator.client!.resp.spectator = true;
    spectator.client!.chase_target = p3; // the chaser starts on p3

    ChaseNext(spectator);
    // i starts at p3's index (3): 3->4 hits the chaser itself (a spectator,
    // not a break, and not equal to the loop-exit target p3) -> continues;
    // 4->wraps to 1 -> p1 (not a spectator) -> break.
    expect(spectator.client!.chase_target).toBe(p1);
  });

  test("ChasePrev wraps from the first client back to the last (g_chase.cpp:124-147)", () => {
    const { edicts } = setupWorld(6, 4);
    const p1 = makePlayerEdict(edicts, 1);
    makePlayerEdict(edicts, 2);
    const p3 = makePlayerEdict(edicts, 3);
    const spectator = makePlayerEdict(edicts, 4);
    spectator.client!.resp.spectator = true;
    spectator.client!.chase_target = p1;

    ChasePrev(spectator);

    // i starts at p1's index (1): 1->0 wraps to maxclients(4) -> hits the
    // chaser itself (a spectator, not a break, not equal to the loop-exit
    // target p1) -> continues; 4->3 -> p3 (not a spectator) -> break.
    expect(spectator.client!.chase_target).toBe(p3);
  });

  test("GetChaseTarget acquires the first non-spectator client (g_chase.cpp:149-171)", () => {
    const { edicts } = setupWorld(6, 3);
    makePlayerEdict(edicts, 1).client!.resp.spectator = true;
    const p2 = makePlayerEdict(edicts, 2);
    const spectator = makePlayerEdict(edicts, 3);
    spectator.client!.resp.spectator = true;
    spectator.groundentity = edicts[0]!;

    GetChaseTarget(spectator);

    expect(spectator.client!.chase_target).toBe(p2);
    expect(spectator.client!.update_chase).toBe(true);
  });

  test("GetChaseTarget's no-players-to-chase branch stamps chase_msg_time and does not throw (g_chase.cpp:166-170)", () => {
    const { edicts } = setupWorld(6, 2);
    const spectator = makePlayerEdict(edicts, 1);
    spectator.client!.resp.spectator = true;
    makePlayerEdict(edicts, 2).client!.resp.spectator = true;

    level.time = Gtime_from_ms(1000);
    spectator.client!.chase_msg_time = GTIME_ZERO;

    GetChaseTarget(spectator);

    expect(spectator.client!.chase_target).toBeNull();
    expect(spectator.client!.chase_msg_time).toEqual(Gtime_add(level.time, Gtime_from_sec(5)));
  });
});

// ---------------------------------------------------------------------------
// PlayerTrail_Add / PlayerTrail_Pick / PlayerTrail_Destroy (p_trail.cpp:30-153)
// ---------------------------------------------------------------------------

describe("PlayerTrail (p_trail.ts)", () => {
  test("PlayerTrail_Add spawns a first marker as both head and tail (p_trail.cpp:85-99)", () => {
    const { edicts } = setupWorld(8, 1);
    const p = makePlayerEdict(edicts, 1, vec3(10, 20, 30));
    p.s.old_origin = vec3(10, 20, 30);
    level.time = Gtime_from_ms(500);

    PlayerTrail_Add(p);

    expect(p.client!.trail_head).not.toBeNull();
    expect(p.client!.trail_head).toBe(p.client!.trail_tail);
    expect(p.client!.trail_head!.owner).toBe(p);
    expect(p.client!.trail_head!.timestamp).toEqual(Gtime_from_ms(500));
    expect(p.client!.trail_head!.s.origin[0]).toBe(10);
  });

  test("PlayerTrail_Add skips adding a new marker while the current head is still visible (p_trail.cpp:87-89)", () => {
    const { edicts } = setupWorld(8, 1);
    const p = makePlayerEdict(edicts, 1);
    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end); // fraction===1 -> visible
    PlayerTrail_Add(p);
    const head = p.client!.trail_head;

    PlayerTrail_Add(p); // still visible -> no-op

    expect(p.client!.trail_head).toBe(head);
  });

  test("PlayerTrail_Add's guards: dead, noclip, no ground, and intermission all skip (p_trail.cpp:90-93)", () => {
    const { edicts } = setupWorld(8, 1);

    const dead = makePlayerEdict(edicts, 1);
    dead.health = 0;
    PlayerTrail_Add(dead);
    expect(dead.client!.trail_head).toBeNull();

    const noclip = makePlayerEdict(edicts, 1);
    noclip.movetype = MovetypeT.MOVETYPE_NOCLIP;
    PlayerTrail_Add(noclip);
    expect(noclip.client!.trail_head).toBeNull();

    const noGround = makePlayerEdict(edicts, 1);
    noGround.groundentity = null;
    PlayerTrail_Add(noGround);
    expect(noGround.client!.trail_head).toBeNull();

    const duringIntermission = makePlayerEdict(edicts, 1);
    level.intermissiontime = Gtime_from_ms(1);
    PlayerTrail_Add(duringIntermission);
    expect(duringIntermission.client!.trail_head).toBeNull();
    level.intermissiontime = GTIME_ZERO;
  });

  test("ring growth links chain (next) / enemy (prev) pointers correctly (p_trail.cpp:55-59)", () => {
    const { edicts } = setupWorld(8, 1);
    const p = makePlayerEdict(edicts, 1);
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0 }); // always blocked -> always add

    PlayerTrail_Add(p);
    const first = p.client!.trail_head!;
    PlayerTrail_Add(p);
    const second = p.client!.trail_head!;

    expect(second).not.toBe(first);
    expect(second.enemy).toBe(first); // new head's "prev" is the old head
    expect(first.chain).toBe(second); // old head's "next" is the new head
    expect(p.client!.trail_tail).toBe(first); // tail unchanged, only 2 nodes
  });

  test("the ring caps at TRAIL_LENGTH=8 by reusing the old tail edict as the new head (p_trail.cpp:38-47)", () => {
    const { edicts } = setupWorld(16, 1);
    const p = makePlayerEdict(edicts, 1);
    traceImpl = (_s, _mn, _mx, end) => ({ ...noHitTrace(end), fraction: 0 }); // always blocked -> always add

    for (let i = 0; i < 8; i++) PlayerTrail_Add(p);

    let len = 0;
    for (let m: EdictT | null = p.client!.trail_tail; m !== null; m = m.chain) len++;
    expect(len).toBe(8);

    const oldTail = p.client!.trail_tail;
    const oldTailsNext = oldTail!.chain; // will become the new tail

    PlayerTrail_Add(p); // 9th add -- must recycle the tail, not spawn fresh

    expect(p.client!.trail_head).toBe(oldTail); // same object, reused as new head
    expect(p.client!.trail_tail).toBe(oldTailsNext);

    len = 0;
    for (let m: EdictT | null = p.client!.trail_tail; m !== null; m = m.chain) len++;
    expect(len).toBe(8); // still capped at TRAIL_LENGTH
  });

  test("PlayerTrail_Pick returns null when the hunted enemy has no client or no trail (p_trail.cpp:105-107)", () => {
    const { edicts } = setupWorld(8, 1);
    const self = edicts[2]!;
    self.inuse = true;

    const noClientEnemy = edicts[3]!;
    noClientEnemy.inuse = true;
    self.enemy = noClientEnemy;
    expect(PlayerTrail_Pick(self, false)).toBeNull();

    const p = makePlayerEdict(edicts, 1); // client, but trail_head still null
    self.enemy = p;
    expect(PlayerTrail_Pick(self, false)).toBeNull();
  });

  // NOTE on the "skip forward" loop (p_trail.cpp:113-119): timestamps are
  // strictly non-increasing from `trail_head` (newest) to `trail_tail`
  // (oldest) by construction (PlayerTrail_Spawn always stamps a fresh node
  // with the CURRENT level.time and links it in as the new head). Since the
  // walk starts at `trail_head` and skips only while `marker.timestamp <=
  // trail_time`, the only two possible outcomes are "stop immediately at
  // trail_head" (whenever trail_time is below the head's own timestamp --
  // the overwhelmingly common real-game case) or "skip every node and land
  // on null" (whenever trail_time is at or above the head's timestamp, an
  // edge case covered by its own test below). A trail_time strictly between
  // two markers' timestamps can NEVER select a non-head, non-null starting
  // marker -- verified by exhaustively tracing the loop, not assumed.
  test("PlayerTrail_Pick (next=false) starts at trail_head, walks .enemy to the first visible marker (p_trail.cpp:109-119, 145-150)", () => {
    const { edicts } = setupWorld(16, 2);
    const p = makePlayerEdict(edicts, 1);
    const self = makePlayerEdict(edicts, 2);
    self.enemy = p;

    // build a 3-node trail manually: head(t=300) -> mid(t=200) -> tail(t=100)
    const head = edicts[10]!;
    const mid = edicts[11]!;
    const tail = edicts[12]!;
    for (const m of [head, mid, tail]) {
      m.inuse = true;
      m.classname = "player_trail";
      m.owner = p;
    }
    head.timestamp = Gtime_from_ms(300);
    mid.timestamp = Gtime_from_ms(200);
    tail.timestamp = Gtime_from_ms(100);
    head.s.origin = vec3(10, 0, 0);
    mid.s.origin = vec3(20, 0, 0);
    tail.s.origin = vec3(30, 0, 0);
    head.enemy = mid;
    mid.enemy = tail;
    tail.enemy = null;
    mid.chain = head;
    tail.chain = mid;
    head.chain = null;
    p.client!.trail_head = head;
    p.client!.trail_tail = tail;

    // marker.timestamp <= trail_time is SKIPPED. trail_time=150 skips only
    // `tail` (100<=150); the walk-forward loop's very first non-skipped
    // marker is `head` (300>150), so the starting marker is `head`.
    self.monsterinfo.trail_time = Gtime_from_ms(150);

    // From that starting marker, walk `.enemy` until one is visible: block
    // the trace for `head`, clear it for `mid` (and everything past it).
    traceImpl = (_s, _mn, _mx, end) => {
      const blockedForHead = end[0] === head.s.origin[0] && end[1] === head.s.origin[1] && end[2] === head.s.origin[2];
      return { ...noHitTrace(end), fraction: blockedForHead ? 0.1 : 1 };
    };

    const picked = PlayerTrail_Pick(self, false);
    expect(picked).toBe(mid);
  });

  test("PlayerTrail_Pick's skip-forward loop lands on null once trail_time reaches trail_head's own timestamp (p_trail.cpp:113-119)", () => {
    const { edicts } = setupWorld(16, 2);
    const p = makePlayerEdict(edicts, 1);
    const self = makePlayerEdict(edicts, 2);
    self.enemy = p;

    const head = edicts[10]!;
    head.inuse = true;
    head.classname = "player_trail";
    head.owner = p;
    head.timestamp = Gtime_from_ms(300);
    head.enemy = null;
    head.chain = null;
    p.client!.trail_head = head;
    p.client!.trail_tail = head;

    self.monsterinfo.trail_time = Gtime_from_ms(300); // >= head's own timestamp -> skipped too

    expect(PlayerTrail_Pick(self, false)).toBeNull();
    expect(PlayerTrail_Pick(self, true)).toBeNull(); // "should never happen" guard, p_trail.cpp:138-140
  });

  test("PlayerTrail_Pick (next=true) picks the closest marker from the start point, then advances one via .chain (p_trail.cpp:121-144)", () => {
    const { edicts } = setupWorld(16, 2);
    const p = makePlayerEdict(edicts, 1);
    const self = makePlayerEdict(edicts, 2, vec3(0, 0, 0));

    self.enemy = p;

    const head = edicts[10]!;
    const mid = edicts[11]!;
    const tail = edicts[12]!;
    for (const m of [head, mid, tail]) {
      m.inuse = true;
      m.classname = "player_trail";
      m.owner = p;
    }
    head.timestamp = Gtime_from_ms(300);
    mid.timestamp = Gtime_from_ms(200);
    tail.timestamp = Gtime_from_ms(100);
    head.s.origin = vec3(100, 0, 0); // far from self
    mid.s.origin = vec3(5, 0, 0); // closest to self at (0,0,0)
    tail.s.origin = vec3(50, 0, 0);
    head.enemy = mid;
    mid.enemy = tail;
    tail.enemy = null;
    mid.chain = head;
    tail.chain = mid;
    head.chain = null;
    p.client!.trail_head = head;
    p.client!.trail_tail = tail;

    self.monsterinfo.trail_time = GTIME_ZERO; // nothing skipped; start marker is `head`

    const picked = PlayerTrail_Pick(self, true);

    // closest-to-self among {head, mid, tail} is `mid`; "next" is mid.chain === head
    expect(picked).toBe(head);
  });

  test("PlayerTrail_Destroy(player) frees only that player's markers and clears only their head/tail (p_trail.cpp:70-81)", () => {
    const { edicts } = setupWorld(16, 2);
    const p1 = makePlayerEdict(edicts, 1);
    const p2 = makePlayerEdict(edicts, 2);

    // indices > maxclients(2) + BODY_QUEUE_SIZE(8) = 10, or G_FreeEdict's
    // own "tried to free special edict" guard (g_utils.ts) silently no-ops.
    const m1 = edicts[12]!;
    m1.inuse = true;
    m1.classname = "player_trail";
    m1.owner = p1;
    p1.client!.trail_head = m1;
    p1.client!.trail_tail = m1;

    const m2 = edicts[13]!;
    m2.inuse = true;
    m2.classname = "player_trail";
    m2.owner = p2;
    p2.client!.trail_head = m2;
    p2.client!.trail_tail = m2;

    PlayerTrail_Destroy(p1);

    expect(m1.inuse).toBe(false); // p1's marker freed
    expect(m2.inuse).toBe(true); // p2's marker untouched
    expect(p1.client!.trail_head).toBeNull();
    expect(p1.client!.trail_tail).toBeNull();
    expect(p2.client!.trail_head).toBe(m2);
  });

  test("PlayerTrail_Destroy(null) frees every marker and clears every client's head/tail (p_trail.cpp:77-80)", () => {
    const { edicts } = setupWorld(16, 2);
    const p1 = makePlayerEdict(edicts, 1);
    const p2 = makePlayerEdict(edicts, 2);

    const m1 = edicts[12]!;
    m1.inuse = true;
    m1.classname = "player_trail";
    m1.owner = p1;
    p1.client!.trail_head = m1;
    p1.client!.trail_tail = m1;

    const m2 = edicts[13]!;
    m2.inuse = true;
    m2.classname = "player_trail";
    m2.owner = p2;
    p2.client!.trail_head = m2;
    p2.client!.trail_tail = m2;

    PlayerTrail_Destroy(null);

    expect(m1.inuse).toBe(false);
    expect(m2.inuse).toBe(false);
    expect(game.clients[0]!.trail_head).toBeNull();
    expect(game.clients[1]!.trail_head).toBeNull();
  });
});
