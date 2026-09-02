/*
Unit tests for the POI (point-of-interest) seam identified by the phase-6
coverage audit: P_SendLevelPOI (p_client.cpp:1771-1782), Compass_Update /
Use_Compass (g_items.cpp:1499-1624), and target_poi_use's poi-field writes
(g_target.cpp:1623-1731).

Self-sufficient per .orch/preferences.md rule 13: wires its own fake
KexGameImports/KexGameExports and a full GClientT fixture, copied from
test/kexgame_g_items.test.ts's own makeClient()/makeClientPersistant()/
makeClientRespawn()/makePmoveState()/makePlayerState()/makeUsercmd() (no
shared defaultGClient() factory exists anywhere in src/kexgame/ yet).

Scope (11 cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/p_client.cpp /
~/Projects/quake2-rerelease-dll/rerelease/g_items.cpp /
~/Projects/quake2-rerelease-dll/rerelease/g_target.cpp):
  - P_SendLevelPOI: the exact svc_poi write sequence + unicast (p_client.cpp:
    1771-1782), and its `!level.valid_poi` early return.
  - Use_Compass: the "$no_valid_poi" guard (g_items.cpp:1547-1551), the
    dynamic-POI use() call ordering (g_items.cpp:1552-1553), the
    GetPathToGoal-false branch (unreachable-path fallback, g_items.cpp:
    1617-1623 -- this is what the real kex binding always does today, see
    src/server/bindings/kex.ts's `GetPathToGoal: () => false`), and the
    GetPathToGoal-true branch's help_draw_* state + poi_points buffer
    population (g_items.cpp:1580-1600).
  - Compass_Update: the "deleted for some reason" null-buffer guard
    (g_items.cpp:1501-1503), the out-of-PHS/too-far guard
    (g_items.cpp:1509-1514), the mid-path svc_help_path write + advance
    (g_items.cpp:1516-1530), and the last-point write + stop
    (g_items.cpp:1522-1524, 1533-1535).
  - target_poi_use: confirms its poi-field writes (valid_poi/current_poi/
    current_poi_image) already match the real field shape and never touch
    poi_points (g_target.cpp:1712-1714) -- the phase-6 audit's "leaning on
    the st placeholder" concern turned out not to be a mismatch: target_poi
    never reads/writes poi_points at all, only Compass_Update/Use_Compass
    do.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexTraceT, KexGameExports, KexGameImports, KexPlayerStateT, KexPmoveStateT, KexUsercmdT, PathInfo, PathRequest } from "../src/kexapi/game";
import { GAME_API_VERSION, MAX_STATS, PathLinkType, PathReturnCode, ServerCommandT, SvcPoiFlagsT } from "../src/kexapi/game";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  type UseFn,
  ItemIdT,
  AmmoT,
  AutoSwitchT,
  MovetypeT,
  POI_OBJECTIVE,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms } from "../src/kexgame/gtime";
import { SpawnFlags_from } from "../src/kexgame/spawnflags";
import { itemlist, Compass_Update } from "../src/kexgame/g_items";
import { P_SendLevelPOI } from "../src/kexgame/p_client";
import { target_poi_use } from "../src/kexgame/g_target";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (mirrors
// test/kexgame_g_items.test.ts's own fixture, extended with recorders this
// suite's assertions need: ordered svc writes, unicast calls, local_sound
// calls, Loc_Print calls, and mutable inPHS/GetPathToGoal results)
// ---------------------------------------------------------------------------

type Write = { op: string; args: unknown[] };

interface Recorder {
  writes: Write[];
  unicastCalls: { ent: EdictT | null; reliable: boolean; key: number }[];
  localSoundCalls: { target: EdictT | null; origin: Vec3 | null; ent: EdictT | null; soundindex: number }[];
  locPrints: { level: number; base: string; args: string[] }[];
  clientPrints: { level: number; message: string }[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { writes: [], unicastCalls: [], localSoundCalls: [], locPrints: [], clientPrints: [], cvars: new Map() };
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

/** Mutable boxes so individual tests can swap in custom results. */
function makeControlBoxes() {
  return {
    inPHS: { current: true },
    pathResult: { current: false as boolean, points: [] as Vec3[], numPathPoints: 0 },
  };
}

function makeFakeGameImports(rec: Recorder, boxes: ReturnType<typeof makeControlBoxes>): KexGameImports {
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
    Client_Print(_ent, printlevel, message) {
      rec.clientPrints.push({ level: printlevel, message });
    },
    Center_Print() {},
    sound() {},
    positioned_sound() {},
    local_sound(target, origin, ent, _channel, soundindex) {
      rec.localSoundCalls.push({ target: target as EdictT | null, origin, ent: ent as EdictT | null, soundindex });
    },
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
      return boxes.inPHS.current;
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
    unicast(ent, reliable, dupe_key) {
      rec.unicastCalls.push({ ent: ent as EdictT | null, reliable, key: dupe_key });
    },
    WriteChar() {},
    WriteByte(c) {
      rec.writes.push({ op: "WriteByte", args: [c] });
    },
    WriteShort(c) {
      rec.writes.push({ op: "WriteShort", args: [c] });
    },
    WriteLong() {},
    WriteFloat(f) {
      rec.writes.push({ op: "WriteFloat", args: [f] });
    },
    WriteString() {},
    WritePosition(pos) {
      rec.writes.push({ op: "WritePosition", args: [[...pos]] });
    },
    WriteDir(dir) {
      rec.writes.push({ op: "WriteDir", args: [[...dir]] });
    },
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
    GetPathToGoal(request: PathRequest, info: PathInfo) {
      if (!boxes.pathResult.current) return false;
      const arr = request.pathPoints.array;
      if (arr !== null) {
        for (let i = 0; i < boxes.pathResult.points.length && i < arr.length; i++) arr[i] = boxes.pathResult.points[i]!;
      }
      info.numPathPoints = boxes.pathResult.numPathPoints;
      return true;
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

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level.
 *  level.time is set to a nonzero value (5s) so Use_Compass's `help_draw_time
 *  = GTIME_ZERO` followed immediately by `Compass_Update(ent, true)` doesn't
 *  trip Compass_Update's own `help_draw_time >= level.time` rate-limit guard
 *  in the very same call (matches ordinary mid-level gameplay, where
 *  level.time is never still 0 by the time a player can use an item). */
function setupWorld(maxclients: number, maxentities: number): { edicts: EdictT[]; rec: Recorder; boxes: ReturnType<typeof makeControlBoxes> } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = maxclients;
  game.maxentities = maxentities;
  level.time = Gtime_from_ms(5000);
  level.poi_points = new Array(8).fill(null);

  const rec = makeRecorder();
  const boxes = makeControlBoxes();
  SetGameImports(makeFakeGameImports(rec, boxes));
  SetGameExports(makeFakeGameExports(edicts, maxentities));
  globals.num_edicts = maxentities;

  return { edicts, rec, boxes };
}

// ---------------------------------------------------------------------------
// GClientT fixture (copied from test/kexgame_g_items.test.ts's own copy)
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
    v_forward: vec3(1, 0, 0),
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
  e.client = makeClient();
  return e;
}

// ---------------------------------------------------------------------------
// P_SendLevelPOI (p_client.cpp:1771-1782)
// ---------------------------------------------------------------------------

describe("P_SendLevelPOI", () => {
  test("writes the exact svc_poi sequence and unicasts reliably", () => {
    const { edicts, rec } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    level.valid_poi = true;
    ent.client!.help_poi_location = vec3(10, 20, 30);
    ent.client!.help_poi_image = 7;

    P_SendLevelPOI(ent);

    expect(rec.writes).toEqual([
      { op: "WriteByte", args: [ServerCommandT.svc_poi] },
      { op: "WriteShort", args: [POI_OBJECTIVE] },
      { op: "WriteShort", args: [10000] },
      // POSITION AS THREE FLOATS, not WritePosition -- see p_client.ts's own
      // comment at the write site: q2repro's server-side PF_WritePos is
      // Q2P_PROTOCOL_MULTICAST_FLOAT, and kexdemo.ts's readPoiKex decodes
      // three MSG_ReadFloat. This engine's shared PF_WritePos writes the
      // classic three-shorts form, so gi.WritePosition here put 6 bytes
      // where the client reads 12.
      { op: "WriteFloat", args: [10] },
      { op: "WriteFloat", args: [20] },
      { op: "WriteFloat", args: [30] },
      { op: "WriteShort", args: [7] },
      { op: "WriteByte", args: [208] },
      { op: "WriteByte", args: [SvcPoiFlagsT.POI_FLAG_NONE] },
    ]);
    expect(rec.unicastCalls).toEqual([{ ent, reliable: true, key: 0 }]);
  });

  test("writes nothing when level.valid_poi is false", () => {
    const { edicts, rec } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    level.valid_poi = false;

    P_SendLevelPOI(ent);

    expect(rec.writes).toEqual([]);
    expect(rec.unicastCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Use_Compass (g_items.cpp:1546-1624, `static`, reached via itemlist's `use`)
// ---------------------------------------------------------------------------

describe("Use_Compass", () => {
  function useCompass(ent: EdictT): void {
    const item = itemlist[ItemIdT.IT_ITEM_COMPASS]!;
    expect(item.use).not.toBeNull();
    item.use!(ent, item);
  }

  test("prints $no_valid_poi and touches no state when level.valid_poi is false", () => {
    const { edicts, rec } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    level.valid_poi = false;

    useCompass(ent);

    // g_items.ts's LocClient_Print now goes through gi.Loc_Print (real
    // localization), not the bare (unlocalized) gi.Client_Print -- see
    // that file's header note and src/kexgame/g_utils.ts's own
    // G_PrintActivationMessage fix for the same defect class ($key reaching
    // the screen unexpanded). This test previously asserted the OLD,
    // buggy wiring (a raw "$no_valid_poi" landing in rec.clientPrints).
    expect(rec.clientPrints).toEqual([]);
    expect(rec.locPrints).toEqual([{ level: expect.any(Number), base: "$no_valid_poi", args: [] }]);
    expect(ent.client!.help_draw_points).toBe(false);
  });

  test("invokes current_dynamic_poi.use(poi, ent, ent) before copying help_poi_location", () => {
    const { edicts } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    level.valid_poi = true;
    level.current_poi = vec3(1, 2, 3);
    level.current_poi_image = 5;

    const calls: { self: EdictT; other: EdictT | null; activator: EdictT | null }[] = [];
    const dummy = defaultEdict();
    dummy.use = ((self, other, activator) => {
      calls.push({ self, other, activator });
    }) as UseFn;
    level.current_dynamic_poi = dummy;

    useCompass(ent);

    expect(calls).toEqual([{ self: dummy, other: ent, activator: ent }]);
    expect(ent.client!.help_poi_location).toEqual(vec3(1, 2, 3));
    expect(ent.client!.help_poi_image).toBe(5);
  });

  test("GetPathToGoal-false branch: still sends the level POI and plays the marker sound (target=ent, origin=null, ent=ent)", () => {
    const { edicts, rec, boxes } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    level.valid_poi = true;
    level.current_poi = vec3(100, 0, 0);
    boxes.pathResult.current = false; // matches the real kex binding's GetPathToGoal stub

    useCompass(ent);

    expect(rec.writes[0]).toEqual({ op: "WriteByte", args: [ServerCommandT.svc_poi] });
    expect(rec.localSoundCalls).toEqual([{ target: ent, origin: null, ent, soundindex: 1 }]);
    expect(ent.client!.help_draw_points).toBe(false);
  });

  test("GetPathToGoal-true branch: allocates the per-player point buffer and sets help_draw_* from the path result", () => {
    const { edicts, boxes } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 0);
    level.valid_poi = true;
    level.current_poi = vec3(500, 0, 0);

    boxes.pathResult.current = true;
    boxes.pathResult.numPathPoints = 3;
    boxes.pathResult.points = [vec3(300, 0, 0), vec3(400, 0, 0), vec3(500, 0, 0)];

    useCompass(ent);

    const buffer = level.poi_points[ent.s.number - 1];
    expect(buffer).not.toBeNull();
    expect(buffer![1]).toEqual(vec3(300, 0, 0));
    expect(buffer![2]).toEqual(vec3(400, 0, 0));
    expect(buffer![3]).toEqual(vec3(500, 0, 0));
    expect(ent.client!.help_draw_count).toBe(3);
    expect(ent.client!.help_draw_index).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Compass_Update (g_items.cpp:1499-1541)
// ---------------------------------------------------------------------------

describe("Compass_Update", () => {
  function primedClient(ent: EdictT, points: Vec3[], index: number, count: number): void {
    level.poi_points[ent.s.number - 1] = points;
    ent.client!.help_draw_points = true;
    ent.client!.help_draw_index = index;
    ent.client!.help_draw_count = count;
    ent.client!.help_draw_time = Gtime_from_ms(0); // < level.time (5000ms), guard passes
  }

  test("no-op when the player's poi_points slot is null ('deleted for some reason')", () => {
    const { edicts, rec } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    level.poi_points[ent.s.number - 1] = null;
    ent.client!.help_draw_points = true;

    Compass_Update(ent, false);

    expect(rec.writes).toEqual([]);
  });

  test("out-of-PHS/too-far guard clears help_draw_points and writes nothing", () => {
    const { edicts, rec, boxes } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 0);
    const points = Array.from({ length: 129 }, () => vec3());
    points[1] = vec3(1, 1, 1);
    primedClient(ent, points, 1, 2);
    boxes.inPHS.current = false;

    Compass_Update(ent, false);

    expect(rec.writes).toEqual([]);
    expect(ent.client!.help_draw_points).toBe(false);
  });

  test("mid-path: writes svc_help_path toward the NEXT point, calls P_SendLevelPOI + marker sound, and advances", () => {
    const { edicts, rec, boxes } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 0);
    level.valid_poi = true;
    boxes.inPHS.current = true;

    const points = Array.from({ length: 129 }, () => vec3());
    points[1] = vec3(10, 0, 0);
    points[2] = vec3(20, 0, 0);
    primedClient(ent, points, 1, 2); // index=1, count=2 -> NOT the last point (count-1=1... )

    // count=3 so index 1 is not the final index (count-1=2)
    ent.client!.help_draw_count = 3;

    Compass_Update(ent, true);

    expect(rec.writes[0]).toEqual({ op: "WriteByte", args: [ServerCommandT.svc_help_path] });
    expect(rec.writes[1]).toEqual({ op: "WriteByte", args: [1] }); // first=true
    expect(rec.writes[2]).toEqual({ op: "WriteFloat", args: [10] });
    expect(rec.writes[3]).toEqual({ op: "WriteFloat", args: [0] });
    expect(rec.writes[4]).toEqual({ op: "WriteFloat", args: [0] });
    expect(rec.writes[5]!.op).toBe("WriteDir"); // toward points[2], normalized
    // two unicasts: the compass path write itself (unreliable), then
    // P_SendLevelPOI's own (reliable) -- g_items.cpp:1516-1524's gi.unicast
    // followed immediately by P_SendLevelPOI(ent) at g_items.cpp:1528.
    expect(rec.unicastCalls[0]).toEqual({ ent, reliable: false, key: 0 });
    expect(rec.unicastCalls[1]).toEqual({ ent, reliable: true, key: 0 });
    expect(rec.localSoundCalls.length).toBe(1);
    // advanced past index 1, still drawing
    expect(ent.client!.help_draw_index).toBe(2);
    expect(ent.client!.help_draw_points).toBe(true);
  });

  test("last point: WriteDir points toward help_poi_location, then stops drawing (no further advance)", () => {
    const { edicts, rec, boxes } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 0);
    level.valid_poi = true;
    boxes.inPHS.current = true;

    const points = Array.from({ length: 129 }, () => vec3());
    points[1] = vec3(10, 0, 0);
    ent.client!.help_poi_location = vec3(10, 5, 0);
    primedClient(ent, points, 1, 2); // index=1 === count-1 (2-1=1) -> last point

    Compass_Update(ent, false);

    expect(rec.writes[5]!.op).toBe("WriteDir");
    // direction should be normalize(help_poi_location - points[1]) = normalize((0,5,0)) = (0,1,0)
    const dirArgs = rec.writes[5]!.args[0] as number[];
    expect(dirArgs[0]).toBeCloseTo(0);
    expect(dirArgs[1]).toBeCloseTo(1);
    expect(dirArgs[2]).toBeCloseTo(0);
    expect(ent.client!.help_draw_points).toBe(false);
    expect(ent.client!.help_draw_index).toBe(1); // not advanced past the last point
  });
});

// ---------------------------------------------------------------------------
// target_poi_use (g_target.cpp:1623-1731) -- confirms its poi-field writes
// already match the real field shape and never touch poi_points
// ---------------------------------------------------------------------------

describe("target_poi_use", () => {
  test("sets level.valid_poi/current_poi/current_poi_image on a plain (untamed) target_poi, and never touches poi_points", () => {
    const { edicts } = setupWorld(1, 8);
    const poi = edicts[2]!;
    poi.inuse = true;
    poi.classname = "target_poi";
    poi.spawnflags = SpawnFlags_from(0);
    poi.count = 0;
    poi.team = null;
    poi.noise_index = 99;
    poi.s.origin = vec3(64, 128, 256);

    const before = level.poi_points.slice();
    level.valid_poi = false;

    target_poi_use(poi, null, poi);

    expect(level.valid_poi).toBe(true);
    expect(level.current_poi).toEqual(vec3(64, 128, 256));
    expect(level.current_poi_image).toBe(99);
    expect(level.current_dynamic_poi).toBeNull();
    expect(level.poi_points).toEqual(before); // untouched, matches g_target.cpp's real field usage
  });
});
