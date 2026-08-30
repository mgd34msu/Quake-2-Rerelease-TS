/*
Unit tests for the kex g_trigger.cpp / g_target.cpp port
(src/kexgame/g_trigger.ts, src/kexgame/g_target.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled after test/kexgame_g_utils.test.ts's own
"fake-imports fixture" style (same shape: makeRecorder/makeFakeGameImports/
makeFakeGameExports/setupWorld), adapted for trigger/target coverage.

Scope (14+ cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/g_trigger.cpp /
~/Projects/quake2-rerelease-dll/rerelease/g_target.cpp):
  - trigger_multiple: wait/retrigger timing via gtime (multi_trigger,
    g_trigger.cpp:37-56).
  - trigger_counter: countdown message vs. sequence-completed message and
    the final G_UseTargets fire (g_trigger.cpp:413-437).
  - trigger_key: item consumption in single-player, and the insufficient-key
    debounced message (g_trigger.cpp:286-366).
  - trigger_hurt: damage cadence (10hz debounce) and the NO_PROTECTION
    spawnflag's effect on a godmoded target (g_trigger.cpp:687-731).
  - trigger_push: velocity set to movedir*speed*10 on touch
    (g_trigger.cpp:485-520).
  - trigger_gravity: per-entity gravity override on touch
    (g_trigger.cpp:788-799).
  - target_explosion: delayed vs. immediate detonation
    (g_target.cpp:361-390).
  - target_laser: think activation applies damage once per debounce window
    (g_target.cpp:679-768).
  - target_lightramp: the 'a'..'z' style-character interpolation string math
    (g_target.cpp:902-924).
  - target_earthquake: shake cadence (client quake_time bump + sound
    debounce) and the ONE_SHOT branch (g_target.cpp:1006-1073).
  - target_changelevel: the already-activated guard, the single-player
    dead-check guard, and the deathmatch noexit-damage branch -- the three
    unit-testable branches of use_target_changelevel; BeginIntermission
    itself is an unported p_client.cpp stub (g_target.cpp:403-464).
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexPlayerStateT, KexPmoveStateT, KexTraceT, KexUsercmdT } from "../src/kexapi/game";
import { EffectsT, GAME_API_VERSION, MAX_STATS, SolidT } from "../src/kexapi/game";
import { type ClientPersistantT, type ClientRespawnT, type EdictT, type GClientT, type GitemT, AmmoT, EntFlagsT, ItemFlagsT, ItemIdT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO, Gtime_add, Gtime_from_ms, Gtime_from_sec } from "../src/kexgame/gtime";
import { SpawnFlags_from } from "../src/kexgame/spawnflags";
import {
  multi_trigger,
  multi_wait,
  trigger_counter_use,
  SP_trigger_counter,
  trigger_key_use,
  SP_trigger_key,
  hurt_touch,
  SP_trigger_hurt,
  trigger_push_touch,
  SP_trigger_push,
  trigger_gravity_touch,
} from "../src/kexgame/g_trigger";
import {
  target_explosion_explode,
  use_target_explosion,
  SP_target_explosion,
  target_laser_think,
  target_lightramp_think,
  target_earthquake_think,
  target_earthquake_use,
  use_target_changelevel,
  SP_target_changelevel,
} from "../src/kexgame/g_target";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (see file header)
// ---------------------------------------------------------------------------

interface Recorder {
  comPrints: string[];
  locPrints: { level: number; base: string; args: string[] }[];
  soundCalls: { ent: KexEdictT | null; soundindex: number }[];
  configstrings: { num: number; str: string }[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { comPrints: [], locPrints: [], soundCalls: [], configstrings: [], cvars: new Map() };
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

/** Mutable box so individual tests can swap in a custom trace result. */
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
  level.time = Gtime_from_ms(0);

  const rec = makeRecorder();
  const traceBox = makeTraceBox();
  SetGameImports(makeFakeGameImports(rec, traceBox));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));
  globals.num_edicts = numEdicts;

  return { edicts, rec, traceBox };
}

// ---------------------------------------------------------------------------
// full GClientT fixture -- no defaultGClient() factory exists yet anywhere in
// src/kexgame/ (same situation test/kexgame_g_combat.test.ts's own header
// documents); copied from that file's own makeClient()/makeClientPersistant()/
// makeClientRespawn()/makePmoveState()/makePlayerState()/makeUsercmd() so
// trigger_key_use/target_earthquake's client-touching paths have a real
// GClientT to read/write, per this file's own "self-sufficient" rule.
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
// trigger_multiple: wait/retrigger timing (g_trigger.cpp:29-56)
// ---------------------------------------------------------------------------

describe("multi_trigger (trigger_multiple's core retrigger machinery)", () => {
  test("wait > 0: fires targets once, then schedules multi_wait via gtime and blocks re-entry", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    const targetEnt = edicts[4]!;
    targetEnt.targetname = "tgt";
    targetEnt.inuse = true;
    let fired = 0;
    targetEnt.use = () => {
      fired++;
    };
    self.target = "tgt";
    self.wait = 2; // seconds
    level.time = Gtime_from_ms(1000);

    multi_trigger(self);

    expect(fired).toBe(1);
    expect(self.think).toBe(multi_wait);
    expect(self.nextthink).toBe(Gtime_add(level.time, Gtime_from_sec(2))); // g_trigger.cpp:47

    // re-entry while nextthink is still set is a no-op (g_trigger.cpp:39-40)
    multi_trigger(self);
    expect(fired).toBe(1);
  });

  test("multi_wait resets nextthink to 0, allowing the next multi_trigger to fire again", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    const targetEnt = edicts[4]!;
    targetEnt.targetname = "tgt";
    targetEnt.inuse = true;
    let fired = 0;
    targetEnt.use = () => {
      fired++;
    };
    self.target = "tgt";
    self.wait = 1;
    level.time = Gtime_from_ms(0);

    multi_trigger(self);
    expect(fired).toBe(1);

    multi_wait(self); // g_trigger.cpp:29-32
    expect(self.nextthink).toBe(GTIME_ZERO);

    multi_trigger(self);
    expect(fired).toBe(2);
  });

  test("wait <= 0: frees itself immediately via a one-frame G_FreeEdict think (g_trigger.cpp:49-55)", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    self.wait = -1; // trigger_once's convention (SP_trigger_once sets wait = -1)
    level.time = Gtime_from_ms(500);

    multi_trigger(self);

    expect(self.touch).toBeNull();
    expect(self.nextthink).toBe(Gtime_add(level.time, Gtime_from_ms(100))); // gi.frame_time_ms fixture value
  });
});

// ---------------------------------------------------------------------------
// trigger_counter (g_trigger.cpp:413-446)
// ---------------------------------------------------------------------------

describe("trigger_counter_use", () => {
  test("counts down with a 'more to go' message until the final use fires targets", () => {
    const { edicts, rec } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    const targetEnt = edicts[4]!;
    targetEnt.targetname = "tgt";
    targetEnt.inuse = true;
    let fired = 0;
    targetEnt.use = () => {
      fired++;
    };
    self.target = "tgt";
    SP_trigger_counter(self); // count defaults to 2, wait = -1 (g_trigger.cpp:439-446)
    expect(self.count).toBe(2);

    trigger_counter_use(self, self, self);
    expect(self.count).toBe(1);
    expect(fired).toBe(0);
    expect(rec.locPrints.at(-1)?.base).toBe("$g_more_to_go");

    trigger_counter_use(self, self, self);
    expect(self.count).toBe(0);
    expect(rec.locPrints.at(-1)?.base).toBe("$g_sequence_completed");
    expect(fired).toBe(1); // multi_trigger -> G_UseTargets, g_trigger.cpp:435-436
  });

  test("count already 0: a further use is a total no-op (g_trigger.cpp:415-416)", () => {
    const { edicts, rec } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    self.count = 0;

    trigger_counter_use(self, self, self);

    expect(self.count).toBe(0);
    expect(rec.locPrints.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// trigger_key (g_trigger.cpp:286-366)
// ---------------------------------------------------------------------------

describe("trigger_key_use", () => {
  function makeKeyItem(id: ItemIdT): GitemT {
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

  test("single-player: consumes exactly one inventory copy of the key and fires targets", () => {
    const { edicts } = setupWorld(1, 16, 5);
    const self = edicts[3]!;
    const player = edicts[1]!;
    const targetEnt = edicts[4]!;
    targetEnt.targetname = "tgt";
    targetEnt.inuse = true;
    let fired = 0;
    targetEnt.use = () => {
      fired++;
    };

    self.target = "tgt";
    self.item = makeKeyItem(7);
    // Build a minimal but real GClientT via the same defaultEdict() factory
    // used everywhere else in this port line's test suites.
    player.client = makeClient();
    if (player.client === null) throw new Error("test setup: defaultEdict() did not provide a client");
    player.client.pers.inventory[7] = 1;

    trigger_key_use(self, null, player);

    expect(player.client.pers.inventory[7]).toBe(0);
    expect(fired).toBe(1);
    expect(self.use).toBeNull(); // g_trigger.cpp:365
  });

  test("missing key: prints the debounced 'you need' message and does not fire targets", () => {
    const { edicts, rec } = setupWorld(1, 16, 5);
    const self = edicts[3]!;
    const player = edicts[1]!;
    const targetEnt = edicts[4]!;
    targetEnt.targetname = "tgt";
    targetEnt.inuse = true;
    let fired = 0;
    targetEnt.use = () => {
      fired++;
    };
    self.target = "tgt";
    self.item = makeKeyItem(7);
    self.use = trigger_key_use; // as SP_trigger_key would set it, so "untouched" below is meaningful

    player.client = makeClient();
    if (player.client === null) throw new Error("test setup: defaultEdict() did not provide a client");
    player.client.pers.inventory[7] = 0; // doesn't have the key

    trigger_key_use(self, null, player);

    expect(fired).toBe(0);
    expect(rec.locPrints.at(-1)?.base).toBe("$g_you_need"); // g_trigger.cpp:301
    expect(self.use).not.toBeNull(); // untouched -- the key was never consumed
  });
});

// ---------------------------------------------------------------------------
// trigger_hurt (g_trigger.cpp:653-755)
// ---------------------------------------------------------------------------

describe("hurt_touch", () => {
  function makeHurtVictim(edicts: EdictT[], idx: number): EdictT {
    const v = edicts[idx]!;
    v.classname = "misc_explobox"; // satisfies hurt_touch's takedamage-class guard, g_trigger.cpp:693
    v.takedamage = true;
    v.health = 100;
    v.max_health = 100;
    return v;
  }

  test("damages once per 10hz debounce window, not on an immediate second touch", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    SP_trigger_hurt(self); // dmg defaults to 5 (g_trigger.cpp:740-741)
    const victim = makeHurtVictim(edicts, 4);
    level.time = Gtime_from_ms(0);

    hurt_touch(self, victim, missTrace, false);
    expect(victim.health).toBe(95);

    // still within the 100ms (10hz) debounce window -- g_trigger.cpp:700-701/711-714
    hurt_touch(self, victim, missTrace, false);
    expect(victim.health).toBe(95);

    level.time = Gtime_add(level.time, Gtime_from_ms(150));
    hurt_touch(self, victim, missTrace, false);
    expect(victim.health).toBe(90);
  });

  test("NO_PROTECTION spawnflag bypasses godmode; without it, a godmoded victim takes no damage", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const protectedSelf = edicts[3]!;
    SP_trigger_hurt(protectedSelf);
    const victim = makeHurtVictim(edicts, 4);
    victim.flags |= EntFlagsT.FL_GODMODE;

    hurt_touch(protectedSelf, victim, missTrace, false);
    expect(victim.health).toBe(100); // g_combat.ts T_Damage: FL_GODMODE blocks non-NO_PROTECTION damage

    const noProtectSelf = edicts[2]!;
    noProtectSelf.spawnflags = SpawnFlags_from(8); // SPAWNFLAG_HURT_NO_PROTECTION, g_trigger.cpp:669
    SP_trigger_hurt(noProtectSelf);
    level.time = Gtime_add(level.time, Gtime_from_ms(500));

    hurt_touch(noProtectSelf, victim, missTrace, false);
    expect(victim.health).toBe(95); // NO_PROTECTION ignores FL_GODMODE, g_trigger.cpp:725-730
  });
});

// ---------------------------------------------------------------------------
// trigger_push (g_trigger.cpp:475-643)
// ---------------------------------------------------------------------------

describe("trigger_push_touch", () => {
  test("sets the toucher's velocity to movedir * speed * 10 (g_trigger.cpp:499-501)", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    SP_trigger_push(self);
    self.speed = 100;
    self.movedir = vec3(0, 0, 1);

    const other = edicts[4]!;
    other.classname = "monster_soldier";
    other.health = 50;

    trigger_push_touch(self, other, missTrace, false);

    expect(other.velocity[0]).toBeCloseTo(0);
    expect(other.velocity[1]).toBeCloseTo(0);
    expect(other.velocity[2]).toBeCloseTo(1000); // 100 * 10
  });
});

// ---------------------------------------------------------------------------
// trigger_gravity (g_trigger.cpp:757-831) -- bonus coverage
// ---------------------------------------------------------------------------

describe("trigger_gravity_touch", () => {
  test("overrides the toucher's per-entity gravity multiplier (g_trigger.cpp:798)", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    self.gravity = 0.5;
    const other = edicts[4]!;
    other.gravity = 1.0;

    trigger_gravity_touch(self, other, missTrace, false);

    expect(other.gravity).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// target_explosion (g_target.cpp:355-396)
// ---------------------------------------------------------------------------

describe("target_explosion", () => {
  test("delay > 0: schedules target_explosion_explode instead of detonating immediately", () => {
    const { edicts } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    SP_target_explosion(self);
    self.delay = 3;
    level.time = Gtime_from_ms(1000);

    use_target_explosion(self, null, self);

    expect(self.think).toBe(target_explosion_explode);
    expect(self.nextthink).toBe(Gtime_add(level.time, Gtime_from_sec(3))); // g_target.cpp:388-389
  });

  test("delay == 0: detonates immediately, radius-damaging nearby entities and firing targets", () => {
    const { edicts } = setupWorld(0, 16, 6);
    const self = edicts[3]!;
    SP_target_explosion(self);
    self.dmg = 40;
    self.s.origin = vec3(0, 0, 0);

    const victim = edicts[4]!;
    victim.inuse = true;
    victim.solid = SolidT.SOLID_BBOX; // findradius skips SOLID_NOT entities, g_utils.ts's findradius
    victim.classname = "misc_explobox";
    victim.takedamage = true;
    victim.health = 100;
    victim.max_health = 100;
    victim.s.origin = vec3(10, 0, 0);

    const targetEnt = edicts[5]!;
    targetEnt.targetname = "tgt";
    targetEnt.inuse = true;
    let fired = 0;
    targetEnt.use = () => {
      fired++;
    };
    self.target = "tgt";

    use_target_explosion(self, null, self);

    expect(victim.health).toBeLessThan(100); // T_RadiusDamage hit it, g_target.cpp:370
    expect(fired).toBe(1); // G_UseTargets, g_target.cpp:374
    expect(self.delay).toBe(0); // save/restore around the G_UseTargets call, g_target.cpp:372-375
  });
});

// ---------------------------------------------------------------------------
// target_laser (g_target.cpp:730-768)
// ---------------------------------------------------------------------------

describe("target_laser_think", () => {
  test("applies damage to a hit entity once, then withholds it during the debounce window", () => {
    const { edicts, traceBox } = setupWorld(0, 16, 6);
    const self = edicts[3]!;
    self.dmg = 10;
    self.activator = self;
    self.movedir = vec3(1, 0, 0);
    self.s.origin = vec3(0, 0, 0);

    const hit = edicts[4]!;
    hit.takedamage = true;
    hit.health = 50;
    hit.max_health = 50;

    traceBox.current = {
      allsolid: false,
      startsolid: false,
      fraction: 0.5,
      endpos: vec3(10, 0, 0),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: hit,
      plane2: new CplaneT(),
      surface2: null,
    };
    level.time = Gtime_from_ms(0);

    target_laser_think(self);
    expect(hit.health).toBe(40); // dmg=10, no armor/protection in play

    // still inside the 10hz (100ms) damage_debounce_time window
    target_laser_think(self);
    expect(hit.health).toBe(40); // g_target.cpp:697/764

    level.time = Gtime_add(level.time, Gtime_from_ms(150));
    target_laser_think(self);
    expect(hit.health).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// target_lightramp (g_target.cpp:895-990)
// ---------------------------------------------------------------------------

describe("target_lightramp_think", () => {
  test("computes the style character from 'a' + movedir[0] (+ ramp progress * movedir[2])", () => {
    const { edicts, rec } = setupWorld(0, 16, 5);
    const self = edicts[3]!;
    const light = edicts[4]!;
    light.style = 2;
    self.enemy = light;
    self.movedir = vec3(2, 0, 0); // mid-ramp state, no time-based contribution (movedir[2] = 0)
    self.timestamp = level.time; // diff = 0 -- isolates the pure movedir[0] term
    self.speed = 10; // ramp not yet finished (diff.seconds() = 0 < 10)

    target_lightramp_think(self);

    // g_target.cpp:906: style[0] = (char)('a' + movedir[0] + diff/frame_time_s * movedir[2])
    // = 'a' + 2 + 0*0 = 'c'
    const call = rec.configstrings.at(-1);
    expect(call?.str).toBe("c");
    expect(self.nextthink).toBe(Gtime_add(level.time, Gtime_from_ms(100))); // ramp still running, g_target.cpp:912-913
  });
});

// ---------------------------------------------------------------------------
// target_earthquake (g_target.cpp:994-1098)
// ---------------------------------------------------------------------------

describe("target_earthquake", () => {
  test("use (non-toggle): schedules the shake and think() bumps every client's quake_time", () => {
    const { edicts } = setupWorld(2, 16, 5);
    const self = edicts[3]!;
    self.count = 5; // duration seconds
    self.spawnflags = SpawnFlags_from(0); // no SILENT/TOGGLE/ONE_SHOT
    self.noise_index = 9;
    level.time = Gtime_from_ms(0);

    const p1 = edicts[1]!;
    p1.inuse = true;
    p1.client = makeClient();

    target_earthquake_use(self, null, p1);

    expect(self.timestamp).toBe(Gtime_add(level.time, Gtime_from_sec(5))); // g_target.cpp:1055
    expect(self.nextthink).toBe(Gtime_add(level.time, Gtime_from_ms(100))); // gi.frame_time_ms fixture value

    target_earthquake_think(self);

    if (p1.client === null) throw new Error("test setup");
    expect(p1.client.quake_time).toBe(Gtime_add(level.time, Gtime_from_ms(1000))); // g_target.cpp:1027
  });

  test("ONE_SHOT: sets every client's damage-kick pitch/time proportional to speed", () => {
    const { edicts } = setupWorld(1, 16, 5);
    const self = edicts[3]!;
    self.speed = 200;
    self.spawnflags = SpawnFlags_from(8); // SPAWNFLAGS_EARTHQUAKE_ONE_SHOT, g_target.cpp:1004
    level.time = Gtime_from_ms(0);

    const p1 = edicts[1]!;
    p1.inuse = true;
    p1.client = makeClient();

    target_earthquake_use(self, null, p1);

    if (p1.client === null) throw new Error("test setup");
    expect(p1.client.v_dmg_pitch).toBeCloseTo(-20); // -speed * 0.1, g_target.cpp:1048
  });
});

// ---------------------------------------------------------------------------
// target_changelevel (g_target.cpp:403-477) -- unit-testable branches only;
// BeginIntermission itself is an unported p_client.cpp stub (see file header)
// ---------------------------------------------------------------------------

describe("use_target_changelevel", () => {
  test("already-activated guard: a nonzero level.intermissiontime is a total no-op", () => {
    const { edicts } = setupWorld(1, 16, 5);
    const self = edicts[3]!;
    SP_target_changelevel(self);
    level.intermissiontime = Gtime_from_ms(500);

    // would throw (BeginIntermission stub) if the guard didn't short-circuit first
    expect(() => use_target_changelevel(self, null, null)).not.toThrow();
  });

  test("single-player dead-check guard: player 1 with health <= 0 blocks the level change", () => {
    const { edicts } = setupWorld(1, 16, 5);
    const self = edicts[3]!;
    SP_target_changelevel(self);
    level.intermissiontime = Gtime_from_ms(0);
    edicts[1]!.health = 0;

    expect(() => use_target_changelevel(self, null, null)).not.toThrow();
  });

  test("deathmatch noexit: damages a non-world `other` for 10x max_health instead of changing level", () => {
    const { edicts, rec } = setupWorld(1, 16, 5);
    const self = edicts[3]!;
    SP_target_changelevel(self);
    level.intermissiontime = Gtime_from_ms(0);
    rec.cvars.set("deathmatch", Object.assign(new CvarT(), { name: "deathmatch", string: "1", value: 1 }));
    // g_dm_allow_exit defaults to "0" (g_main.cpp:338) -- fixture's cvar() lazily
    // creates it at that default on first read, so noexit is active here.

    const other = edicts[4]!;
    other.takedamage = true;
    other.health = 100;
    other.max_health = 10;

    use_target_changelevel(self, other, null);

    expect(other.health).toBeLessThanOrEqual(0); // 10 * max_health(10) = 100 damage, g_target.cpp:417
  });
});
