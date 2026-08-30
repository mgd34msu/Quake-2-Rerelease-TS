/*
Unit tests for the kex coop-instanced-items mechanism: P_UseCoopInstancedItems
(src/kexgame/p_client.ts, p_client.cpp:90-95) and its full dependency closure
across src/kexgame/g_items.ts, src/kexgame/g_trigger.ts, and
src/kexgame/p_client.ts's own player_die.

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Fixture shape (Recorder/makeFakeGameImports/
makeFakeGameExports/setupWorld, and the GClientT fixture family
makeClient()/makeClientPersistant()/makeClientRespawn()/makePmoveState()/
makePlayerState()/makeUsercmd()) is modeled after test/kexgame_g_items.test.ts
and test/kexgame_g_trigger_target.test.ts's own identical copies (no shared
defaultGClient()/fake-imports factory exists anywhere importable in this
port line, per those files' own header notes).

Before this unit, P_UseCoopInstancedItems (p_client.cpp:90) had a real
implementation in p_client.ts, but g_items.ts still carried its OWN local
throwing stub (never swapped to the real import), making it a live throw on
any kex coop boot the instant a world item was touched. This unit swaps that
stub, and while auditing the full P_UseCoopInstancedItems call-site closure
against the cited C++ also found and fixed two real (non-throwing) behavior
gaps that had been silently dropped: g_trigger.ts's trigger_key_use was
missing the `!P_UseCoopInstancedItems()` guard around its
`resp.coop_respawn.*` resets (g_trigger.cpp:330-336, 351-354), and
p_client.ts's player_die had dropped the `itemlist[n].flags & IF_KEY`
key-carry-into-coop_respawn logic entirely (p_client.cpp:581-591) as a
reported PORTING.md deviation from before g_items.ts existed.

Scope (10 cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/p_client.cpp /
~/Projects/quake2-rerelease-dll/rerelease/g_items.cpp /
~/Projects/quake2-rerelease-dll/rerelease/g_trigger.cpp):
  - P_UseCoopInstancedItems cvar gating: g_coop_instanced_items on/off, and
    g_coop_squad_respawn forcing instanced items on even when
    g_coop_instanced_items is off (p_client.cpp:90-95's own comment), plus
    the real default-on behavior with no cvars pre-registered (regression
    test for this unit's own g_coop_instanced_items cvar-default fix,
    g_main.cpp:254).
  - Touch_Item (g_items.cpp:910-1020) instancing: first pickup marks
    ent.item_picked_up_by for that player and does NOT remove the entity: a
    second player can still pick up the same instanced item entity
    (Entity_IsVisibleToPlayer, g_items.cpp:900-903), and a third touch by the
    FIRST player again is a total no-op (g_items.cpp:921-926).
  - trigger_key_use (g_trigger.cpp:286-366): the coop_respawn reset guard
    for both the power-cube branch and the plain-key branch.
  - player_die (p_client.cpp:581-591): IF_KEY inventory is carried into
    resp.coop_respawn.inventory when instanced items are off; non-key
    inventory is cleared but never carried.
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexPlayerStateT, KexPmoveStateT, KexTraceT, KexUsercmdT } from "../src/kexapi/game";
import { EffectsT, GAME_API_VERSION, MAX_STATS, MAX_CLIENTS, SolidT } from "../src/kexapi/game";
import { type ClientPersistantT, type ClientRespawnT, type EdictT, type GClientT, AmmoT, AutoSwitchT, EntFlagsT, ItemFlagsT, ItemIdT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO, Gtime_from_ms, Gtime_from_sec } from "../src/kexgame/gtime";
import { GetItemByIndex, Touch_Item, Entity_IsVisibleToPlayer } from "../src/kexgame/g_items";
import { trigger_key_use } from "../src/kexgame/g_trigger";
import { P_UseCoopInstancedItems, player_die } from "../src/kexgame/p_client";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (see file header)
// ---------------------------------------------------------------------------

interface Recorder {
  comPrints: string[];
  soundCalls: { ent: KexEdictT | null; soundindex: number }[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { comPrints: [], soundCalls: [], cvars: new Map() };
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
      return missTrace;
    },
    clip() {
      return missTrace;
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
function setupWorld(maxclients: number, maxentities: number): { edicts: EdictT[]; rec: Recorder } {
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
  SetGameImports(makeFakeGameImports(rec));
  SetGameExports(makeFakeGameExports(edicts, maxentities));
  globals.num_edicts = maxentities;

  return { edicts, rec };
}

/** Sets both cvars P_UseCoopInstancedItems reads (p_client.cpp:90-95). */
function setInstancedItemsCvars(rec: Recorder, instanced: boolean, squadRespawn: boolean): void {
  rec.cvars.set("g_coop_instanced_items", Object.assign(new CvarT(), { name: "g_coop_instanced_items", string: instanced ? "1" : "0", value: instanced ? 1 : 0 }));
  rec.cvars.set("g_coop_squad_respawn", Object.assign(new CvarT(), { name: "g_coop_squad_respawn", string: squadRespawn ? "1" : "0", value: squadRespawn ? 1 : 0 }));
}

function setCoop(rec: Recorder, on: boolean): void {
  rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: on ? "1" : "0", value: on ? 1 : 0 }));
}

// ---------------------------------------------------------------------------
// GClientT fixture -- same shape as test/kexgame_g_items.test.ts's own (no
// shared defaultGClient() factory exists anywhere in src/kexgame/ yet)
// ---------------------------------------------------------------------------

function makeClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: 0,
    autoswitch: AutoSwitchT.SMART,
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
  return { pm_type: 0, origin: vec3(), velocity: vec3(), pm_flags: 0, pm_time: 0, gravity: 0, delta_angles: vec3(), viewheight: 0 };
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

/** A fully-valued GClientT. `health`/`inventory`/etc are the caller's
 *  responsibility to override per-test. */
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

function makePlayerEdict(edicts: EdictT[], index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "player";
  e.health = 100;
  e.max_health = 100;
  e.movetype = MovetypeT.MOVETYPE_WALK;
  e.solid = SolidT.SOLID_BBOX;
  e.client = makeClient();
  return e;
}

/** A world item entity (`ent.item` set, no client) at the given itemlist index. */
function makeItemEdict(edicts: EdictT[], index: number, itemId: ItemIdT): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  const item = GetItemByIndex(itemId);
  if (item === null) throw new Error(`test fixture: bad itemId ${itemId}`);
  e.item = item;
  e.classname = item.classname;
  return e;
}

// ---------------------------------------------------------------------------
// P_UseCoopInstancedItems cvar gating (p_client.cpp:90-95)
// ---------------------------------------------------------------------------

describe("P_UseCoopInstancedItems", () => {
  test("g_coop_instanced_items=1, g_coop_squad_respawn=0: instanced items on", () => {
    const { rec } = setupWorld(2, 4);
    setInstancedItemsCvars(rec, true, false);
    expect(P_UseCoopInstancedItems()).toBe(true);
  });

  test("both cvars 0: instanced items off", () => {
    const { rec } = setupWorld(2, 4);
    setInstancedItemsCvars(rec, false, false);
    expect(P_UseCoopInstancedItems()).toBe(false);
  });

  test("g_coop_instanced_items=0 but g_coop_squad_respawn=1: squad respawn forces instanced items on (p_client.cpp:92-94's own comment: 'squad respawn forces instanced items on, since we don't want players to need to backtrack just to get their stuff')", () => {
    const { rec } = setupWorld(2, 4);
    setInstancedItemsCvars(rec, false, true);
    expect(P_UseCoopInstancedItems()).toBe(true);
  });

  test("no cvars pre-registered: defaults to true (g_main.cpp:254's `gi.cvar(\"g_coop_instanced_items\", \"1\", CVAR_LATCH)` -- regression test for this unit's cvar-default fix from \"0\" to \"1\")", () => {
    setupWorld(2, 4);
    expect(P_UseCoopInstancedItems()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Touch_Item instancing (g_items.cpp:900-926, 959-973, 994-1019) -- formerly
// unreachable: g_items.ts's own local P_UseCoopInstancedItems stub threw the
// instant Touch_Item ran in coop, on every kex coop boot.
// ---------------------------------------------------------------------------

describe("Touch_Item / Entity_IsVisibleToPlayer coop-instanced marking", () => {
  test("first pickup marks item_picked_up_by for that player and does not free the entity (g_items.cpp:959-973, 998-1007: SPAWNFLAG_ITEM_DROPPED_PLAYER only)", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, true, false);

    const item = makeItemEdict(edicts, 3, ItemIdT.IT_HEALTH_SMALL); // HEALTH_IGNORE_MAX -- pickup always succeeds
    const player1 = makePlayerEdict(edicts, 1);

    Touch_Item(item, player1, missTrace, false);

    expect(item.item_picked_up_by[player1.s.number - 1]).toBe(true);
    expect(item.inuse).toBe(true); // not freed -- stays for other players
    expect(player1.health).toBe(102); // Pickup_Health writes ent.health, quantity 2
  });

  test("a second player can still pick up the same instanced item entity (Entity_IsVisibleToPlayer, g_items.cpp:900-903)", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, true, false);

    const item = makeItemEdict(edicts, 3, ItemIdT.IT_HEALTH_SMALL);
    const player1 = makePlayerEdict(edicts, 1);
    const player2 = makePlayerEdict(edicts, 2);

    Touch_Item(item, player1, missTrace, false);
    expect(Entity_IsVisibleToPlayer(item, player2)).toBe(true); // not yet claimed by player2

    Touch_Item(item, player2, missTrace, false);

    expect(item.item_picked_up_by[player2.s.number - 1]).toBe(true);
    expect(player2.health).toBe(102); // player2 got the pickup too
    expect(Entity_IsVisibleToPlayer(item, player1)).toBe(false); // already claimed by player1
  });

  test("the same player touching an already-claimed instanced item again is a total no-op (g_items.cpp:921-926)", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, true, false);

    const item = makeItemEdict(edicts, 3, ItemIdT.IT_HEALTH_SMALL);
    const player1 = makePlayerEdict(edicts, 1);

    Touch_Item(item, player1, missTrace, false);
    expect(player1.health).toBe(102);

    Touch_Item(item, player1, missTrace, false); // already got this instanced item

    expect(player1.health).toBe(102); // unchanged -- Pickup_Health never ran again
  });
});

// ---------------------------------------------------------------------------
// trigger_key_use coop_respawn guard (g_trigger.cpp:286-366)
// ---------------------------------------------------------------------------

describe("trigger_key_use coop_respawn reset guard", () => {
  function makeKeyItem(id: ItemIdT): { id: ItemIdT; classname: string; pickup: null; use: null; drop: null; weaponthink: null; pickup_sound: null; world_model: null; world_model_flags: EffectsT; view_model: null; icon: null; use_name: null; pickup_name: null; pickup_name_definite: string; quantity: number; ammo: ItemIdT; chain: ItemIdT; flags: ItemFlagsT; vwep_model: null; armor_info: null; tag: number; precaches: null; sort_id: number; quantity_warn: number; chain_next: null; vwep_index: number; ammo_wheel_index: number; weapon_wheel_index: number; powerup_wheel_index: number } {
    return {
      id,
      classname: "item_key_test",
      pickup: null,
      use: null,
      drop: null,
      weaponthink: null,
      pickup_sound: null,
      world_model: null,
      world_model_flags: EffectsT.EF_NONE,
      view_model: null,
      icon: null,
      use_name: null,
      pickup_name: null,
      pickup_name_definite: "the key",
      quantity: 0,
      ammo: ItemIdT.IT_NULL,
      chain: ItemIdT.IT_NULL,
      flags: ItemFlagsT.IF_NONE,
      vwep_model: null,
      armor_info: null,
      tag: 0,
      precaches: null,
      sort_id: 0,
      quantity_warn: 5,
      chain_next: null,
      vwep_index: 0,
      ammo_wheel_index: -1,
      weapon_wheel_index: -1,
      powerup_wheel_index: -1,
    };
  }

  const KEY_INDEX = ItemIdT.IT_KEY_BLUE_KEY;

  test("instanced items ON: resp.coop_respawn.inventory is preserved, not zeroed (g_trigger.cpp:349-354)", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, true, false);

    const self = edicts[3]!;
    self.item = makeKeyItem(KEY_INDEX);

    const player1 = makePlayerEdict(edicts, 1);
    player1.client!.pers.inventory[KEY_INDEX] = 1;
    player1.client!.resp.coop_respawn.inventory[KEY_INDEX] = 1;

    trigger_key_use(self, null, player1);

    expect(player1.client!.pers.inventory[KEY_INDEX]).toBe(0); // consumed live
    expect(player1.client!.resp.coop_respawn.inventory[KEY_INDEX]).toBe(1); // NOT reset -- instanced items on
  });

  test("instanced items OFF: resp.coop_respawn.inventory is also zeroed (g_trigger.cpp:349-354)", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, false, false);

    const self = edicts[3]!;
    self.item = makeKeyItem(KEY_INDEX);

    const player1 = makePlayerEdict(edicts, 1);
    player1.client!.pers.inventory[KEY_INDEX] = 1;
    player1.client!.resp.coop_respawn.inventory[KEY_INDEX] = 1;

    trigger_key_use(self, null, player1);

    expect(player1.client!.pers.inventory[KEY_INDEX]).toBe(0);
    expect(player1.client!.resp.coop_respawn.inventory[KEY_INDEX]).toBe(0); // reset -- instanced items off
  });
});

// ---------------------------------------------------------------------------
// player_die key-carry into resp.coop_respawn (p_client.cpp:581-591)
// ---------------------------------------------------------------------------

describe("player_die coop inventory clear + IF_KEY carry", () => {
  function makeAlivePlayer(edicts: EdictT[], slot: number): EdictT {
    const ent = makePlayerEdict(edicts, slot);
    ent.health = 50; // above the -40 gib threshold
    ent.deadflag = false;
    ent.client!.pers.netname = "Victim";
    return ent;
  }

  test("IF_KEY inventory is carried into resp.coop_respawn.inventory when instanced items are off", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, false, false); // !P_UseCoopInstancedItems() -- the branch under test

    const self = makeAlivePlayer(edicts, 1);
    const world = edicts[0]!;
    self.client!.pers.inventory[ItemIdT.IT_KEY_POWER_CUBE] = 1; // IF_KEY item, g_items.ts:3262

    player_die(self, world, world, 10, vec3(), { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.client!.pers.inventory[ItemIdT.IT_KEY_POWER_CUBE]).toBe(0); // cleared live
    expect(self.client!.resp.coop_respawn.inventory[ItemIdT.IT_KEY_POWER_CUBE]).toBe(1); // carried
  });

  test("non-key inventory is cleared but never carried into resp.coop_respawn.inventory", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, false, false);

    const self = makeAlivePlayer(edicts, 1);
    const world = edicts[0]!;
    self.client!.pers.inventory[ItemIdT.IT_HEALTH_SMALL] = 3; // not IF_KEY

    player_die(self, world, world, 10, vec3(), { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.client!.pers.inventory[ItemIdT.IT_HEALTH_SMALL]).toBe(0);
    expect(self.client!.resp.coop_respawn.inventory[ItemIdT.IT_HEALTH_SMALL]).toBe(0); // never carried
  });

  test("when instanced items are ON, the whole clear-and-carry block is skipped entirely (p_client.cpp:581: `if (coop->integer && !P_UseCoopInstancedItems())`)", () => {
    const { edicts, rec } = setupWorld(2, 8);
    setCoop(rec, true);
    setInstancedItemsCvars(rec, true, false); // P_UseCoopInstancedItems() true -- guard not taken

    const self = makeAlivePlayer(edicts, 1);
    const world = edicts[0]!;
    self.client!.pers.inventory[ItemIdT.IT_KEY_POWER_CUBE] = 1;

    player_die(self, world, world, 10, vec3(), { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.client!.pers.inventory[ItemIdT.IT_KEY_POWER_CUBE]).toBe(1); // untouched -- guard skipped
  });
});
