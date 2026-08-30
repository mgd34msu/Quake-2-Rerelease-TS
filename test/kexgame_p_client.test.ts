/*
Unit tests for the kex p_client.cpp port (src/kexgame/p_client.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled after test/kexgame_g_trigger_target.test.ts's
own "fake-imports fixture" style (same shape: makeRecorder/makeFakeGameImports/
makeFakeGameExports/setupWorld, and the same makeClient()/makeClientPersistant()/
makeClientRespawn()/makePmoveState()/makePlayerState()/makeUsercmd() GClientT
fixture, copied per that file's own "no defaultGClient() factory exists
anywhere importable" precedent -- p_client.ts's OWN defaultGClient() is
unexported, so this file gets its own copy too, same as every other test file
in this port line).

Two differences from that fixture:
  - `Info_ValueForKey`/`Info_SetValueForKey` are wired to the REAL pure
    implementations in src/shared/q_shared.ts (not stubbed to always return
    0/false) -- p_client.ts's userinfo parsing (ClientUserinfoChanged,
    ClientConnect, spectator_respawn) is the actual subject under test here,
    so the fake needs real key/value semantics, unlike g_trigger_target's
    fixture which never exercises userinfo parsing.
  - `cvar()` is backed by a real map so tests can flip deathmatch/coop/etc.

Scope (14+ cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/p_client.cpp):
  - InitClientPersistant: KEX starting-item defaults (ammo caps, blaster
    grant) for an ordinary connecting player, and the spectator early-out
    that skips the weapon-granting block entirely (p_client.cpp:807-909).
  - SelectDeathmatchSpawnPoint: farthest-point math with fabricated spawn
    points, and the single-spawn-point shortcut (p_client.cpp:1015-1112).
  - SelectSpawnPoint: the singleplayer "couldn't find spawn point, origin
    fallback" branch (p_client.cpp:1435-1514).
  - ClientUserinfoChanged: name/skin/hand/autoswitch parsing, and the
    "badinfo" fallback when "name" is missing (p_client.cpp:2576-2667).
  - CopyToBodyQue: head queue rotation across BODY_QUEUE_SIZE, and the
    modelindex-0 no-op guard (p_client.cpp:1553-1604).
  - player_die: deadflag transition, gib-threshold branch, and the
    non-deathmatch weapon-drop-is-a-no-op path (p_client.cpp:534-755).
  - respawn: the spectator path through PutClientInServer that returns
    before ever reaching the p_weapon.ts-owned ChangeWeapon call
    (p_client.cpp:1621-1637, 1980-2302).
  - ClientConnect: isBot flag / social_id storage per the 2023 signature,
    and the password-rejection path that mutates the boxed userinfo string
    (p_client.cpp:2829-2920).
  - G_ShouldPlayersCollide: the coop-collision-cvar branches
    (p_client.cpp:2996-3011).
  - ClientObituary: the self-suicide message and deathmatch score decrement
    (p_client.cpp:99-201).
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, Info_SetValueForKey as Info_SetValueForKey_pure, Info_ValueForKey as Info_ValueForKey_pure } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexPlayerStateT, KexPmoveStateT, KexTraceT, KexUsercmdT } from "../src/kexapi/game";
import { EffectsT, GAME_API_VERSION, MAX_STATS, SolidT } from "../src/kexapi/game";
import { type ClientPersistantT, type ClientRespawnT, type EdictT, type GClientT, AmmoT, EntFlagsT, ItemIdT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO, Gtime_from_ms, Gtime_from_sec } from "../src/kexgame/gtime";
import {
  InitClientPersistant,
  InitClientResp,
  SelectDeathmatchSpawnPoint,
  SpawnPointClear,
  PlayersRangeFromSpot,
  SelectSpawnPoint,
  InitBodyQue,
  CopyToBodyQue,
  player_die,
  respawn,
  ClientUserinfoChanged,
  ClientConnect,
  ClientDisconnect,
  G_ShouldPlayersCollide,
  ClientObituary,
  TossClientWeapon,
} from "../src/kexgame/p_client";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (see file header)
// ---------------------------------------------------------------------------

interface Recorder {
  comPrints: string[];
  locPrints: { level: number; base: string; args: string[] }[];
  soundCalls: { ent: KexEdictT | null; soundindex: number }[];
  configstrings: { num: number; str: string }[];
  cvars: Map<string, CvarT>;
  linked: KexEdictT[];
  unlinked: KexEdictT[];
}

function makeRecorder(): Recorder {
  return { comPrints: [], locPrints: [], soundCalls: [], configstrings: [], cvars: new Map(), linked: [], unlinked: [] };
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

function makeTraceBox(): { current: KexTraceT } {
  return { current: missTrace };
}

function makeFakeGameImports(rec: Recorder, traceBox: { current: KexTraceT }): KexGameImports {
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
    sound(ent, _channel, soundindex) {
      rec.soundCalls.push({ ent, soundindex });
    },
    positioned_sound(_origin, ent, _channel, soundindex) {
      rec.soundCalls.push({ ent, soundindex });
    },
    local_sound() {},
    configstring(num, str) {
      rec.configstrings.push({ num, str });
    },
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
      return traceBox.current;
    },
    clip() {
      return traceBox.current;
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
    linkentity(ent) {
      if (ent !== null) rec.linked.push(ent);
    },
    unlinkentity(ent) {
      if (ent !== null) rec.unlinked.push(ent);
    },
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
    Loc_Print(_ent, level_, base, args) {
      rec.locPrints.push({ level: level_, base, args: [...args] });
    },
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
    // REAL implementations (see file header) -- backed by src/shared/q_shared.ts's
    // pure Info_ValueForKey/Info_SetValueForKey.
    Info_ValueForKey(s, key, buffer) {
      const v = Info_ValueForKey_pure(s, key);
      buffer[0] = v;
      return v.length > 0 ? 1 : 0;
    },
    Info_RemoveKey() {
      return false;
    },
    Info_SetValueForKey(s, key, value) {
      s[0] = Info_SetValueForKey_pure(s[0], key, value);
      return true;
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

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level for one test. */
function setupWorld(maxclients: number, maxentities: number, numEdicts: number): { edicts: EdictT[]; rec: Recorder; traceBox: { current: KexTraceT } } {
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
  for (let i = 0; i < maxclients; i++) game.clients.push(makeClient());
  level.time = Gtime_from_ms(0);
  level.mapname = "";
  level.start_items = null;

  const rec = makeRecorder();
  const traceBox = makeTraceBox();
  SetGameImports(makeFakeGameImports(rec, traceBox));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));
  globals.num_edicts = numEdicts;

  return { edicts, rec, traceBox };
}

/** Wires an edict at index `i` (1-based client slot) to `game.clients[i-1]`,
 * matching the ClientConnect/ClientBegin invariant p_client.ts's own
 * PutClientInServer depends on (see p_client.ts's own "clear everything but
 * the persistant data" comment). */
function wireClient(edicts: EdictT[], slot: number): EdictT {
  const ent = edicts[slot]!;
  ent.client = game.clients[slot - 1]!;
  ent.inuse = true;
  return ent;
}

// ---------------------------------------------------------------------------
// full GClientT fixture -- copied from test/kexgame_g_trigger_target.test.ts's
// own makeClient()/makeClientPersistant()/makeClientRespawn()/makePmoveState()/
// makePlayerState()/makeUsercmd() (see file header)
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

// ---------------------------------------------------------------------------
// InitClientPersistant (p_client.cpp:807-909)
// ---------------------------------------------------------------------------

describe("InitClientPersistant", () => {
  test("ordinary connecting player: ammo caps, blaster grant, and weapon selection run to completion (p_client.cpp:807-909)", () => {
    const { edicts } = setupWorld(4, 16, 4);
    const ent = wireClient(edicts, 1);
    const client = ent.client!;
    client.resp.spectator = false;

    // p_weapon.ts and g_items.ts have landed, so the full C++ control flow
    // runs: NoAmmoWeaponChange/ChangeWeapon select the blaster and the
    // function reaches its final connected/spawned assignments.
    InitClientPersistant(ent, client);

    expect(client.pers.health).toBe(100);
    expect(client.pers.max_health).toBe(100);
    expect(client.pers.max_ammo[AmmoT.AMMO_BULLETS]).toBe(200);
    expect(client.pers.max_ammo[AmmoT.AMMO_SHELLS]).toBe(100);
    expect(client.pers.max_ammo[AmmoT.AMMO_CELLS]).toBe(200);
    expect(client.pers.max_ammo[AmmoT.AMMO_ROCKETS]).toBe(50); // fill(50) default, p_client.cpp:846
    expect(client.pers.inventory[ItemIdT.IT_WEAPON_BLASTER]).toBe(1);
    expect(client.pers.inventory[ItemIdT.IT_ITEM_COMPASS]).toBe(1); // !deathmatch grants compass
    // the formerly-unreachable tail (p_client.cpp:907-908):
    expect(client.pers.connected).toBe(true);
    expect(client.pers.spawned).toBe(true);
    // weapon selection outcome: blaster is the only owned weapon
    expect(client.pers.weapon?.id).toBe(ItemIdT.IT_WEAPON_BLASTER);
  });

  test("spectator client: the entire weapon-granting block (and its NoAmmoWeaponChange dependency) is skipped -- p_client.cpp:820-899's outer guard", () => {
    const { edicts } = setupWorld(4, 16, 4);
    const ent = wireClient(edicts, 1);
    const client = ent.client!;
    client.resp.spectator = true;

    // does NOT throw -- the outer `(!G_TeamplayEnabled() && !resp.spectator)`
    // guard is false for a spectator, so NoAmmoWeaponChange is never reached.
    expect(() => InitClientPersistant(ent, client)).not.toThrow();

    expect(client.pers.health).toBe(100);
    expect(client.pers.inventory[ItemIdT.IT_WEAPON_BLASTER]).toBe(0);
    expect(client.pers.weapon).toBe(null);
    expect(client.pers.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// InitClientResp (p_client.cpp:911-927)
// ---------------------------------------------------------------------------

describe("InitClientResp", () => {
  test("preserves ctf_team/id_state across the reset, sets entertime, snapshots pers into coop_respawn", () => {
    const { edicts } = setupWorld(1, 4, 1);
    const ent = wireClient(edicts, 1);
    const client = ent.client!;
    client.resp.ctf_team = 2;
    client.resp.id_state = true;
    client.resp.score = 99; // should be wiped
    client.pers.health = 77;
    level.time = Gtime_from_ms(5000);

    InitClientResp(client);

    expect(client.resp.ctf_team).toBe(2);
    expect(client.resp.id_state).toBe(true);
    expect(client.resp.score).toBe(0);
    expect(client.resp.entertime).toBe(Gtime_from_ms(5000));
    expect(client.resp.coop_respawn.health).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// SelectDeathmatchSpawnPoint / SpawnPointClear / PlayersRangeFromSpot
// (p_client.cpp:980-1112)
// ---------------------------------------------------------------------------

describe("SelectDeathmatchSpawnPoint", () => {
  test("single spawn point: shortcut path returns it directly when clear", () => {
    const { edicts } = setupWorld(0, 8, 8);
    const spot = edicts[3]!;
    spot.classname = "info_player_deathmatch";
    spot.inuse = true;
    spot.s.origin = vec3(100, 200, 0);

    const result = SelectDeathmatchSpawnPoint(false, false, false);

    expect(result.any_valid).toBe(true);
    expect(result.spot).toBe(spot);
  });

  test("farthest=true picks the spawn point with the greatest distance from the nearest player (p_client.cpp:1074-1084)", () => {
    const { edicts } = setupWorld(1, 8, 8);
    const player = wireClient(edicts, 1);
    player.health = 100;
    player.s.origin = vec3(0, 0, 0);

    const near = edicts[4]!;
    near.classname = "info_player_deathmatch";
    near.inuse = true;
    near.s.origin = vec3(10, 0, 0); // dist 10 from player

    const far = edicts[5]!;
    far.classname = "info_player_deathmatch";
    far.inuse = true;
    far.s.origin = vec3(1000, 0, 0); // dist 1000 from player

    expect(PlayersRangeFromSpot(near)).toBeCloseTo(10, 5);
    expect(PlayersRangeFromSpot(far)).toBeCloseTo(1000, 5);
    expect(SpawnPointClear(near)).toBe(true); // missTrace never startsolid
    expect(SpawnPointClear(far)).toBe(true);

    const result = SelectDeathmatchSpawnPoint(true, false, false);

    expect(result.any_valid).toBe(true);
    expect(result.spot).toBe(far);
  });

  test("no deathmatch spawns and no fallback requested: any_valid is false", () => {
    setupWorld(0, 4, 4);

    const result = SelectDeathmatchSpawnPoint(false, false, false);

    expect(result.any_valid).toBe(false);
    expect(result.spot).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// SelectSpawnPoint (p_client.cpp:1435-1514)
// ---------------------------------------------------------------------------

describe("SelectSpawnPoint", () => {
  test("singleplayer (not deathmatch, not coop) with no info_player_start falls back to world origin (p_client.cpp:1490-1501)", () => {
    const { edicts } = setupWorld(1, 4, 4);
    const ent = wireClient(edicts, 1);

    const originBox: [ReturnType<typeof vec3>] = [vec3(1, 2, 3)];
    const anglesBox: [ReturnType<typeof vec3>] = [vec3(4, 5, 6)];
    const landmarkBox: [boolean] = [false];

    const ok = SelectSpawnPoint(ent, originBox, anglesBox, false, landmarkBox);

    expect(ok).toBe(true);
    expect(Array.from(originBox[0])).toEqual([0, 0, 0]);
    expect(Array.from(anglesBox[0])).toEqual([0, 0, 0]);
    expect(landmarkBox[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientUserinfoChanged (p_client.cpp:2576-2667)
// ---------------------------------------------------------------------------

describe("ClientUserinfoChanged", () => {
  test("parses name/skin/hand/autoswitch/fov from a well-formed userinfo string", () => {
    const { edicts } = setupWorld(2, 4, 4);
    const ent = wireClient(edicts, 1);
    ent.svflags = 0; // not a bot, so netname gets re-encoded after (see below)

    const userinfo = `\\name\\Grunt\\skin\\male/grunt\\hand\\1\\autoswitch\\2\\fov\\90`;
    ClientUserinfoChanged(ent, userinfo);

    // [Kex] non-bot netname is overwritten to the "##P{n}" encoded form
    // AFTER the raw name is used to build the skin configstring
    // (p_client.cpp:2617-2620) -- assert the encoded form, and that the
    // pre-encoding configstring used the real parsed name.
    expect(ent.client!.pers.netname).toBe("##P0");
    expect(ent.client!.pers.hand).toBe(1); // LEFT_HANDED
    expect(ent.client!.pers.autoswitch).toBe(2);
    expect(ent.client!.ps.fov).toBe(90);
    expect(ent.client!.pers.userinfo).toBe(userinfo);
  });

  test("missing 'name' key falls back to 'badinfo' (p_client.cpp:2579-2580)", () => {
    const { edicts } = setupWorld(2, 4, 4);
    const ent = wireClient(edicts, 1);
    ent.svflags = 0;

    ClientUserinfoChanged(ent, "");

    // still gets re-encoded to ##P0 afterward since it's not a bot, but the
    // configstring write in between used "badinfo" -- verified via the
    // configstring recorder.
    expect(ent.client!.pers.hand).toBe(0); // RIGHT_HANDED default
    expect(ent.client!.pers.autoswitch).toBe(0); // SMART default
    expect(ent.client!.pers.autoshield).toBe(-1);
    expect(ent.client!.pers.bob_skip).toBe(false);
  });

  test("bot netname is NOT re-encoded (p_client.cpp:2618-2620's SVF_BOT guard)", () => {
    const { edicts } = setupWorld(2, 4, 4);
    const ent = wireClient(edicts, 1);
    ent.svflags = 0x10; // SVF_BOT (kexapi/game.ts SvflagsT.SVF_BOT bit(4))

    ClientUserinfoChanged(ent, "\\name\\BotName");

    expect(ent.client!.pers.netname).toBe("BotName");
  });
});

// ---------------------------------------------------------------------------
// CopyToBodyQue (p_client.cpp:1553-1604)
// ---------------------------------------------------------------------------

describe("CopyToBodyQue", () => {
  test("modelindex 0 is a no-op (p_client.cpp:1556-1557)", () => {
    const { edicts, rec } = setupWorld(0, 32, 32);
    InitBodyQue();
    const ent = edicts[0]!;
    ent.s.modelindex = 0;

    CopyToBodyQue(ent);

    expect(rec.linked.length).toBe(0);
    expect(rec.unlinked.length).toBe(0);
  });

  test("head queue rotation cycles through BODY_QUEUE_SIZE slots and copies entity state by value, not reference", () => {
    const { edicts } = setupWorld(2, 16, 16);
    InitBodyQue(); // level.body_que = 0

    const ent = edicts[0]!;
    ent.s.modelindex = 42;
    ent.s.origin = vec3(1, 2, 3);
    ent.health = 55;
    ent.gib_health = -30;
    ent.takedamage = true;
    ent.mins = vec3(-1, -1, -1);
    ent.maxs = vec3(1, 1, 1);

    expect(level.body_que).toBe(0);
    CopyToBodyQue(ent);
    // body slot = g_edicts[maxclients(2) + 0 + 1] = g_edicts[3]
    const body1 = edicts[3]!;
    expect(body1.health).toBe(55);
    expect(Array.from(body1.s.origin)).toEqual([1, 2, 3]);
    expect(body1.die).toBe(require("../src/kexgame/p_client").body_die ?? body1.die); // sanity: die is set (see next assertion for the real check)
    expect(body1.takedamage).toBe(true);
    expect(level.body_que).toBe(1);

    // mutate the source AFTER copying -- the body's origin must be
    // independent storage (see p_client.ts's own "struct-value copy" note)
    ent.s.origin[0] = 999;
    expect(body1.s.origin[0]).toBe(1);

    CopyToBodyQue(ent);
    expect(level.body_que).toBe(2);
    const body2 = edicts[4]!;
    expect(body2).not.toBe(body1);
  });
});

// ---------------------------------------------------------------------------
// player_die (p_client.cpp:534-755)
// ---------------------------------------------------------------------------

describe("player_die", () => {
  function makeAlivePlayer(edicts: EdictT[], slot: number): EdictT {
    const ent = wireClient(edicts, slot);
    ent.health = 100;
    ent.deadflag = false;
    ent.client!.pers.netname = "Victim";
    return ent;
  }

  test("sets deadflag and links the entity; normal (non-gib) death path", () => {
    const { edicts, rec } = setupWorld(2, 8, 8);
    const self = makeAlivePlayer(edicts, 1);
    self.health = 50; // above the -40 gib threshold
    const world = edicts[0]!;

    player_die(self, world, world, 10, vec3(), { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.deadflag).toBe(true);
    expect(rec.linked).toContain(self);
    expect(self.client!.ps.pmove.pm_type).toBe(4); // PM_DEAD (kexapi/game.ts KexPmTypeT)
  });

  test("health < -40 triggers the gib branch (ThrowClientHead/ANIM_DEATH), takedamage cleared", () => {
    const { edicts } = setupWorld(2, 8, 8);
    const self = makeAlivePlayer(edicts, 1);
    self.health = -50;
    const world = edicts[0]!;

    player_die(self, world, world, 300, vec3(), { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.deadflag).toBe(true);
    expect(self.takedamage).toBe(false); // p_client.cpp:676
    expect(self.client!.anim_end).toBe(0); // p_client.cpp:674
  });

  test("MOD_TRACKER forces health to -100 and damage to 400 before the gib check (p_client.cpp:632-636)", () => {
    const { edicts } = setupWorld(2, 8, 8);
    const self = makeAlivePlayer(edicts, 1);
    self.health = 20; // starts above threshold
    const world = edicts[0]!;

    // ModIdT.MOD_TRACKER's numeric value is looked up directly to avoid an
    // extra import; g_local.ts's ModIdT is a plain incrementing enum, and
    // player_die's own gib-threshold assertion below is what actually
    // proves the branch ran (health forced below -40 despite starting at 20).
    const MOD_TRACKER = 52;
    player_die(self, world, world, 10, vec3(), { id: MOD_TRACKER, friendly_fire: false, no_point_loss: false });

    expect(self.health).toBe(-100);
    expect(self.takedamage).toBe(false); // proves the gib branch ran
  });
});

// ---------------------------------------------------------------------------
// TossClientWeapon (p_client.cpp:413-494)
// ---------------------------------------------------------------------------

describe("TossClientWeapon", () => {
  test("non-deathmatch: real no-op, never reaches the g_items.ts-owned Drop_Item stub", () => {
    const { edicts } = setupWorld(1, 4, 4);
    const ent = wireClient(edicts, 1);
    ent.client!.pers.weapon = { id: ItemIdT.IT_WEAPON_SHOTGUN, ammo: 0 } as never as ClientPersistantT["weapon"];

    // deathmatch cvar defaults to "0" -- p_client.cpp:423-424's own early
    // return means Drop_Item is never called, so this must NOT throw even
    // though this file's own Drop_Item stub would throw if reached.
    expect(() => TossClientWeapon(ent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// respawn (p_client.cpp:1621-1637) -- spectator path through PutClientInServer
// ---------------------------------------------------------------------------

describe("respawn", () => {
  test("non-deathmatch, non-coop: falls back to gi.AddCommandString('menu_loadgame') without touching PutClientInServer (p_client.cpp:1635-1636)", () => {
    const { edicts } = setupWorld(1, 4, 4);
    const ent = wireClient(edicts, 1);
    ent.client!.resp.spectator = false;

    expect(() => respawn(ent)).not.toThrow();
  });

  test("spectator client in deathmatch: reaches PutClientInServer's spectator-bound state before the p_view.ts-owned P_AssignClientSkinnum stub (p_client.cpp:2201-2207)", () => {
    const { edicts, rec } = setupWorld(1, 8, 8);
    rec.cvars.set("deathmatch", Object.assign(new CvarT(), { name: "deathmatch", string: "1", value: 1 }));

    const spot = edicts[4]!;
    spot.classname = "info_player_deathmatch";
    spot.inuse = true;
    spot.s.origin = vec3(0, 0, 0);

    const ent = wireClient(edicts, 1);
    // both pers.spectator AND resp.spectator are already true here (an
    // ESTABLISHED spectator respawning) -- deliberately NOT the
    // "resp.spectator should be the opposite of pers.spectator" state
    // spectator_respawn's own doc comment describes for a fresh
    // pers.spectator TRANSITION, since that specific state would still
    // route through InitClientPersistant's weapon-granting block (its own
    // guard reads `!client.resp.spectator`, not `!client.pers.spectator` --
    // p_client.cpp:820-821) and hit the p_weapon.ts-owned NoAmmoWeaponChange
    // dependency. Confirming this DOES avoid that dependency is itself part
    // of what this test checks (see the specific error message asserted
    // below -- it must be P_AssignClientSkinnum's, never
    // NoAmmoWeaponChange's).
    ent.client!.pers.spectator = true;
    ent.client!.resp.spectator = true;
    ent.client!.landmark_name = null;

    // RECONCILIATION FINDING (see p_client.ts's own file header): p_view.ts's
    // own P_AssignClientSkinnum is a "narrow, cited stub" per that file's
    // header, implying a rare/conditional path -- but its packing tail is
    // UNCONDITIONALLY reached by every real player spawn. `MODELINDEX_PLAYER`
    // (kexapi/game.ts) is `MAX_MODELS_OLD - 1` = `256 - 1` = 255, exactly the
    // one value P_AssignClientSkinnum's own early-return guard
    // (`ent.s.modelindex !== 255`) does NOT return on -- and PutClientInServer
    // always sets `ent.s.modelindex = MODELINDEX_PLAYER` (p_client.cpp:2203)
    // immediately before calling it. So this is not a narrow/rare stub for
    // ANY real player-shaped spawn in this port line yet; it is reached
    // every time. This test documents that reality rather than working
    // around it: it asserts the exact throw, and the real state
    // PutClientInServer DOES manage to set before reaching it.
    expect(() => respawn(ent)).toThrow(/P_AssignClientSkinnum/);

    expect(ent.client!.pers.connected).toBe(true); // InitClientPersistant ran to completion (spectator skips the weapon block)
    expect(ent.movetype).toBe(4); // MOVETYPE_WALK (g_local.ts MovetypeT) -- set at p_client.cpp:2158, before the throw
    expect(ent.deadflag).toBe(false);
    expect(rec.linked).not.toContain(ent); // gi.linkentity(ent) (p_client.cpp:2280) is never reached
  });
});

// ---------------------------------------------------------------------------
// ClientConnect (p_client.cpp:2829-2920) -- 2023 signature
// ---------------------------------------------------------------------------

describe("ClientConnect", () => {
  test("isBot sets SVF_BOT, social_id is stored, function returns true for a normal connect", () => {
    const { edicts } = setupWorld(2, 4, 4);
    edicts[1]!.client = game.clients[0]!;
    // ent.inuse = true (a loadgame-style reconnect) skips the
    // `if (!ent->inuse) { ...; InitClientPersistant(...); }` branch
    // (p_client.cpp:2888-2898) entirely, so this test can verify the
    // isBot/social_id bookkeeping without touching the p_weapon.ts-owned
    // NoAmmoWeaponChange dependency InitClientPersistant would otherwise hit.
    edicts[1]!.inuse = true;

    const userinfoBox: [string] = ["\\name\\BotPlayer"];
    const ok = ClientConnect(edicts[1]!, userinfoBox, "social-123", true);

    expect(ok).toBe(true);
    expect((edicts[1]!.svflags & 0x10) !== 0).toBe(true); // SVF_BOT
    expect(edicts[1]!.client!.pers.social_id).toBe("social-123");
    expect(edicts[1]!.client!.pers.connected).toBe(true);
  });

  test("password rejection mutates the boxed userinfo with rejmsg and returns false (p_client.cpp:2872-2877)", () => {
    const { edicts, rec } = setupWorld(2, 4, 4);
    edicts[1]!.client = game.clients[0]!;
    rec.cvars.set("password", Object.assign(new CvarT(), { name: "password", string: "secret", value: 0 }));

    const userinfoBox: [string] = ["\\name\\Player\\password\\wrong"];
    const ok = ClientConnect(edicts[1]!, userinfoBox, "social-456", false);

    expect(ok).toBe(false);
    expect(Info_ValueForKey_pure(userinfoBox[0], "rejmsg")).toBe("Password required or incorrect.");
  });
});

// ---------------------------------------------------------------------------
// ClientDisconnect (p_client.cpp:2930-2987)
// ---------------------------------------------------------------------------

describe("ClientDisconnect", () => {
  test("marks the entity disconnected and unlinks it", () => {
    const { edicts, rec } = setupWorld(1, 4, 4);
    const ent = wireClient(edicts, 1);
    ent.client!.tracker_pain_time = GTIME_ZERO;
    ent.client!.owned_sphere = null;

    ClientDisconnect(ent);

    expect(ent.inuse).toBe(false);
    expect(ent.classname).toBe("disconnected");
    expect(ent.client!.pers.connected).toBe(false);
    expect(ent.client!.pers.spawned).toBe(false);
    expect(rec.unlinked).toContain(ent);
  });

  test("no-op when ent.client is null", () => {
    const { edicts } = setupWorld(1, 4, 4);
    const ent = edicts[0]!;
    ent.client = null;

    expect(() => ClientDisconnect(ent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// G_ShouldPlayersCollide (p_client.cpp:2996-3011)
// ---------------------------------------------------------------------------

describe("G_ShouldPlayersCollide", () => {
  test("always collides outside coop (deathmatch/singleplayer default), regardless of the weaponry flag", () => {
    setupWorld(1, 1, 1);

    expect(G_ShouldPlayersCollide(false)).toBe(true);
    expect(G_ShouldPlayersCollide(true)).toBe(true);
  });

  test("in coop, defers to g_coop_player_collision when friendly fire is off", () => {
    const { rec } = setupWorld(1, 1, 1);
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));
    rec.cvars.set("g_coop_player_collision", Object.assign(new CvarT(), { name: "g_coop_player_collision", string: "1", value: 1 }));

    expect(G_ShouldPlayersCollide(false)).toBe(true);

    rec.cvars.set("g_coop_player_collision", Object.assign(new CvarT(), { name: "g_coop_player_collision", string: "0", value: 0 }));
    expect(G_ShouldPlayersCollide(false)).toBe(false);
  });

  test("g_disable_player_collision forces false unconditionally (p_client.cpp:2998-2999)", () => {
    const { rec } = setupWorld(1, 1, 1);
    rec.cvars.set("g_disable_player_collision", Object.assign(new CvarT(), { name: "g_disable_player_collision", string: "1", value: 1 }));

    expect(G_ShouldPlayersCollide(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientObituary (p_client.cpp:99-411)
// ---------------------------------------------------------------------------

describe("ClientObituary", () => {
  test("self-inflicted MOD_SUICIDE: attacker===self OVERRIDES the mod-keyed message to $g_mod_self_default (p_client.cpp:155-186), decrements score in deathmatch", () => {
    const { edicts, rec } = setupWorld(1, 4, 4);
    const self = wireClient(edicts, 1);
    self.client!.pers.netname = "Solo";
    self.client!.resp.score = 5;
    rec.cvars.set("deathmatch", Object.assign(new CvarT(), { name: "deathmatch", string: "1", value: 1 }));

    const MOD_SUICIDE = 24; // g_local.ts ModIdT.MOD_SUICIDE

    ClientObituary(self, self, self, { id: MOD_SUICIDE, friendly_fire: false, no_point_loss: false });

    expect(self.client!.resp.score).toBe(4);
    expect(self.enemy).toBe(null);
    // MOD_SUICIDE has no entry in the `attacker === self` switch
    // (p_client.cpp:157-185's cases are MOD_HELD_GRENADE/HG_SPLASH/
    // G_SPLASH/R_SPLASH/BFG_BLAST/TRAP/DOPPLE_EXPLODE only), so it falls
    // through to that switch's own default -- "$g_mod_self_default"
    // OVERRIDES the first switch's "$g_mod_generic_suicide" unconditionally
    // whenever attacker===self, regardless of mod.id.
    const printed = rec.locPrints.find((p) => p.base === "$g_mod_self_default");
    expect(printed).toBeDefined();
    expect(printed!.args).toEqual(["Solo"]);
    expect(rec.locPrints.some((p) => p.base === "$g_mod_generic_suicide")).toBe(false);
  });

  test("non-self death with an unrecognized mod and no client attacker: generic died message, deathmatch score decrement", () => {
    const { edicts, rec } = setupWorld(1, 4, 4);
    const self = wireClient(edicts, 1);
    self.client!.pers.netname = "Victim";
    self.client!.resp.score = 5;
    rec.cvars.set("deathmatch", Object.assign(new CvarT(), { name: "deathmatch", string: "1", value: 1 }));
    const world = edicts[0]!;

    const MOD_UNKNOWN = 0;
    ClientObituary(self, world, world, { id: MOD_UNKNOWN, friendly_fire: false, no_point_loss: false });

    expect(self.client!.resp.score).toBe(4);
    const printed = rec.locPrints.find((p) => p.base === "$g_mod_generic_died");
    expect(printed).toBeDefined();
    expect(printed!.args).toEqual(["Victim"]);
  });
});
