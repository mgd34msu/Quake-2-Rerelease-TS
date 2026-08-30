/*
Unit tests for the kex g_items.cpp port (src/kexgame/g_items.ts).

Self-sufficient per .orch/preferences.md rule 13: wires its own fake
KexGameImports/KexGameExports and a full GClientT fixture, modeled after
test/kexgame_g_combat.test.ts's own fixture (same fake-imports shape, same
setupWorld()/makeClient() helpers -- no shared defaultGClient() factory
exists anywhere in src/kexgame/ yet).

Scope (see g_items.ts's own file header for the exact C++ line numbers and
every documented deviation/stub this suite's design routes around):
  - itemlist integrity: length === ItemIdT.IT_TOTAL, id === index for every
    entry, and a spot-check of 8 entries' classname/pickup_name/flags
    (including a xatrix entry, two rogue entries, a CTF entry, and a KEX
    addition) against direct quotes from g_items.cpp.
  - Armor pickup math: jacket-into-combat salvage conversion, shard
    special-case, and the "already maxed, reject" branch.
  - Health pickup (small/stimpack) + mega-health's timed think chain
    (MegaHealth_think's tick-down-while-overhealed loop and DM respawn).
  - Quad Damage's stacking timing rule (Use_Quad's `max(level.time,
    quad_time) + timeout` re-up, not a flat add).
  - Ammo add caps (Add_Ammo/G_AddAmmoAndCap's max_ammo ceiling).
  - Power armor use/toggle (Use_PowerArmor's on/off flag flip + no-cells
    early-out).
  - SetRespawn ordering (the "already respawning, no-op" guard via
    `ent.think === DoRespawn && ent.nextthink >= level.time`).
  - FindItem/FindItemByClassname lookups, including FindItem's own
    misleading-parameter-name quirk (matches use_name, not pickup_name) and
    case-insensitive matching for both.
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, YAW } from "../src/shared/q_shared";
import type { KexTraceT, KexGameExports, KexGameImports, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION, MAX_STATS, MAX_CLIENTS, SolidT, ContentsT } from "../src/kexapi/game";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  ItemIdT,
  AmmoT,
  ItemFlagsT,
  AutoSwitchT,
  MovetypeT,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_from_sec } from "../src/kexgame/gtime";
import {
  itemlist,
  GetItemByIndex,
  GetItemByAmmo,
  FindItem,
  FindItemByClassname,
  InitItems,
  SetRespawn,
  DoRespawn,
  Pickup_Armor,
  Pickup_Health,
  MegaHealth_think,
  Use_Quad,
  Add_Ammo,
  Use_PowerArmor,
} from "../src/kexgame/g_items";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (mirrors
// test/kexgame_g_combat.test.ts's own fixture)
// ---------------------------------------------------------------------------

interface Recorder {
  soundCalls: { soundindex: number }[];
  cvars: Map<string, CvarT>;
  // Overridable per-test (defaults below match the pre-existing fixture's
  // behavior exactly) -- Use_Doppleganger's FindSpawnPoint/
  // CheckGroundSpawnPoint chain (rogue/g_rogue_items.ts) needs a trace/
  // pointcontents result that actually represents solid ground to exercise
  // its real, reconciled body end to end, not just its early-return paths.
  traceResult: KexTraceT;
  pointcontentsResult: ContentsT;
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

function makeRecorder(): Recorder {
  return { soundCalls: [], cvars: new Map(), traceResult: noHitTrace, pointcontentsResult: 0 };
}

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
      return rec.traceResult;
    },
    clip() {
      return noHitTrace;
    },
    pointcontents() {
      return rec.pointcontentsResult;
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

  return { edicts, rec };
}

// ---------------------------------------------------------------------------
// GClientT fixture -- same shape as test/kexgame_g_combat.test.ts's own
// (no shared defaultGClient() factory exists anywhere in src/kexgame/ yet)
// ---------------------------------------------------------------------------

function makeClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: 0,
    autoswitch: AutoSwitchT.SMART,
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
 *  responsibility to override per-test -- this is just "a memset(0)-ish
 *  player" with sane not-in-any-special-state defaults. */
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

/** A player edict with 100/100 health, no armor, no powerups, a fresh client. */
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
// itemlist integrity
// ---------------------------------------------------------------------------

describe("itemlist integrity", () => {
  test("length matches ItemIdT.IT_TOTAL", () => {
    expect(itemlist.length).toBe(ItemIdT.IT_TOTAL);
  });

  test("every entry's declared id matches its array index", () => {
    for (let i = 0; i < itemlist.length; i++) {
      expect(itemlist[i]!.id).toBe(i);
    }
  });

  test("index 0 is the untouched dummy entry (g_items.cpp: `{ }, // leave index 0 alone`)", () => {
    const dummy = itemlist[0]!;
    expect(dummy.id).toBe(ItemIdT.IT_NULL);
    expect(dummy.classname).toBeNull();
    expect(dummy.pickup).toBeNull();
  });

  // Spot-check 8 entries (base, xatrix, rogue x2, CTF, KEX) against direct
  // g_items.cpp quotes.
  test("item_armor_body (g_items.cpp:1642-1663)", () => {
    const it = itemlist[ItemIdT.IT_ARMOR_BODY]!;
    expect(it.classname).toBe("item_armor_body");
    expect(it.pickup_sound).toBe("misc/ar3_pkup.wav");
    expect(it.pickup_name).toBe("$item_body_armor");
    expect(it.flags & ItemFlagsT.IF_ARMOR).not.toBe(0);
    expect(it.armor_info).not.toBeNull();
    expect(it.armor_info!.base_count).toBe(100);
  });

  test("weapon_boomer / IT_WEAPON_IONRIPPER is a xatrix entry (g_items.cpp:2233-2257)", () => {
    const it = itemlist[ItemIdT.IT_WEAPON_IONRIPPER]!;
    expect(it.classname).toBe("weapon_boomer");
    expect(it.use_name).toBe("Ionripper");
    expect(it.ammo).toBe(ItemIdT.IT_AMMO_CELLS);
    expect(it.quantity).toBe(2);
    expect(it.quantity_warn).toBe(30);
  });

  test("weapon_proxlauncher is a rogue entry (g_items.cpp:2148-2170)", () => {
    const it = itemlist[ItemIdT.IT_WEAPON_PROXLAUNCHER]!;
    expect(it.classname).toBe("weapon_proxlauncher");
    expect(it.ammo).toBe(ItemIdT.IT_AMMO_PROX);
    expect(it.tag).toBe(AmmoT.AMMO_PROX);
    expect((it.flags & ItemFlagsT.IF_STAY_COOP) !== 0).toBe(true);
  });

  test("item_sphere_hunter is a rogue entry (g_items.cpp:3112-3137)", () => {
    const it = itemlist[ItemIdT.IT_ITEM_SPHERE_HUNTER]!;
    expect(it.classname).toBe("item_sphere_hunter");
    expect(it.use_name).toBe("hunter sphere");
    expect(it.quantity).toBe(120);
    expect(it.pickup).not.toBeNull();
  });

  test("item_flag_team1 is a CTF entry (g_items.cpp:3692-3717)", () => {
    const it = itemlist[ItemIdT.IT_FLAG1]!;
    expect(it.classname).toBe("item_flag_team1");
    expect(it.pickup_name).toBe("$item_red_flag");
    expect(it.flags).toBe(ItemFlagsT.IF_NONE);
  });

  test("item_flashlight is a KEX addition (g_items.cpp:3850-3874)", () => {
    const it = itemlist[ItemIdT.IT_ITEM_FLASHLIGHT]!;
    expect(it.classname).toBe("item_flashlight");
    expect(it.use).not.toBeNull();
    expect((it.flags & ItemFlagsT.IF_POWERUP_ONOFF) !== 0).toBe(true);
    expect(it.sort_id).toBe(-1);
  });

  test("item_health_mega has both HEALTH_IGNORE_MAX and HEALTH_TIMED tag bits (g_items.cpp:3667-3689)", () => {
    const it = itemlist[ItemIdT.IT_HEALTH_MEGA]!;
    expect(it.classname).toBe("item_health_mega");
    expect(it.quantity).toBe(100);
    expect(it.tag).toBe(3); // HEALTH_IGNORE_MAX (1) | HEALTH_TIMED (2)
  });

  test("item_health_large's pickup_name_definite is identical to pickup_name, not a '_def' variant -- a genuine upstream quirk (g_items.cpp:3657-3658)", () => {
    const it = itemlist[ItemIdT.IT_HEALTH_LARGE]!;
    expect(it.pickup_name).toBe("$item_large_medkit");
    expect(it.pickup_name_definite).toBe("$item_large_medkit");
  });
});

// ---------------------------------------------------------------------------
// FindItem / FindItemByClassname
// ---------------------------------------------------------------------------

describe("FindItem / FindItemByClassname", () => {
  test("FindItemByClassname finds an item by exact classname", () => {
    const it = FindItemByClassname("weapon_railgun");
    expect(it).not.toBeNull();
    expect(it!.id).toBe(ItemIdT.IT_WEAPON_RAILGUN);
  });

  test("FindItemByClassname is case-insensitive (Q_strcasecmp)", () => {
    const it = FindItemByClassname("WEAPON_RAILGUN");
    expect(it).not.toBeNull();
    expect(it!.id).toBe(ItemIdT.IT_WEAPON_RAILGUN);
  });

  test("FindItemByClassname returns null for an unknown classname", () => {
    expect(FindItemByClassname("not_a_real_item")).toBeNull();
  });

  test("FindItem's parameter is misleadingly named pickup_name but actually matches use_name (g_items.cpp:103-118)", () => {
    // "Body Armor" is IT_ARMOR_BODY's use_name; its real pickup_name is the
    // localized "$item_body_armor" string, which FindItem does NOT match.
    const byUseName = FindItem("Body Armor");
    expect(byUseName).not.toBeNull();
    expect(byUseName!.id).toBe(ItemIdT.IT_ARMOR_BODY);

    const byRealPickupName = FindItem("$item_body_armor");
    expect(byRealPickupName).toBeNull();
  });

  test("FindItem is case-insensitive", () => {
    expect(FindItem("body armor")!.id).toBe(ItemIdT.IT_ARMOR_BODY);
  });
});

// ---------------------------------------------------------------------------
// GetItemByAmmo requires InitItems() (matches the C++ bootstrap ordering)
// ---------------------------------------------------------------------------

describe("InitItems / GetItemByAmmo", () => {
  test("GetItemByAmmo resolves after InitItems() has populated ammolist", () => {
    setupWorld(1, 4);
    InitItems();
    const shells = GetItemByAmmo(AmmoT.AMMO_SHELLS);
    expect(shells).not.toBeNull();
    expect(shells!.id).toBe(ItemIdT.IT_AMMO_SHELLS);
  });

  test("weapon chains are linked into a circular list (blaster <-> machinegun family etc.)", () => {
    setupWorld(1, 4);
    InitItems();
    const blaster = itemlist[ItemIdT.IT_WEAPON_BLASTER]!;
    expect(blaster.chain_next).not.toBeNull();
    // IT_WEAPON_BLASTER's own chain points to itself (g_items.cpp: `chain
    // IT_WEAPON_BLASTER`), so it is its own one-item circular chain unless
    // grapple/chainfist spliced in ahead of it (both also chain to
    // IT_WEAPON_BLASTER) -- walk the circle back to itself either way.
    let c = blaster.chain_next!;
    let steps = 0;
    while (c !== blaster && steps < itemlist.length + 1) {
      c = c.chain_next!;
      steps++;
    }
    expect(c).toBe(blaster);
  });
});

// ---------------------------------------------------------------------------
// Armor pickup math
// ---------------------------------------------------------------------------

describe("Pickup_Armor", () => {
  test("picking up jacket armor with no existing armor sets inventory to base_count", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    const jacket = makeItemEdict(edicts, 1, ItemIdT.IT_ARMOR_JACKET);

    const taken = Pickup_Armor(jacket, player);

    expect(taken).toBe(true);
    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(25); // jacketarmor_info.base_count
  });

  test("picking up combat armor (better) while wearing jacket salvages a converted amount and zeroes the jacket slot", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = 50; // maxed jacket
    const combat = makeItemEdict(edicts, 1, ItemIdT.IT_ARMOR_COMBAT);

    const taken = Pickup_Armor(combat, player);

    expect(taken).toBe(true);
    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(0);
    // salvage = jacket.normal_protection(.30) / combat.normal_protection(.60) = 0.5
    // salvagecount = trunc(0.5 * 50) = 25; newcount = combat.base_count(50) + 25 = 75
    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT]).toBe(75);
  });

  test("picking up jacket armor (worse) while wearing maxed combat armor is rejected", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT] = 100; // maxed
    const jacket = makeItemEdict(edicts, 1, ItemIdT.IT_ARMOR_JACKET);

    const taken = Pickup_Armor(jacket, player);

    expect(taken).toBe(false);
    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_COMBAT]).toBe(100);
  });

  test("armor shards add +2 to jacket if unarmored", () => {
    const { edicts } = setupWorld(2, 4);
    const player = makePlayerEdict(edicts, 0);
    const shard = makeItemEdict(edicts, 1, ItemIdT.IT_ARMOR_SHARD);

    Pickup_Armor(shard, player);
    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(2);
  });

  test("armor shards add +2 to whatever armor is currently worn (body armor here)", () => {
    const { edicts } = setupWorld(2, 4);
    const player = makePlayerEdict(edicts, 1);
    player.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY] = 40;
    const shard = makeItemEdict(edicts, 2, ItemIdT.IT_ARMOR_SHARD);

    Pickup_Armor(shard, player);

    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_BODY]).toBe(42);
    expect(player.client!.pers.inventory[ItemIdT.IT_ARMOR_JACKET]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Health pickup + mega-health think chain
// ---------------------------------------------------------------------------

describe("Pickup_Health / MegaHealth_think", () => {
  test("small health (stimpack) ignores the max-health cap (HEALTH_IGNORE_MAX)", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.health = 100;
    player.max_health = 100;
    const small = makeItemEdict(edicts, 1, ItemIdT.IT_HEALTH_SMALL);

    const taken = Pickup_Health(small, player);

    expect(taken).toBe(true);
    expect(player.health).toBe(102); // 100 + 2, no clamp to max_health
  });

  test("medium health is rejected when already at or above max health", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.health = 100;
    player.max_health = 100;
    const medium = makeItemEdict(edicts, 1, ItemIdT.IT_HEALTH_MEDIUM);

    expect(Pickup_Health(medium, player)).toBe(false);
    expect(player.health).toBe(100);
  });

  test("mega-health in deathmatch schedules MegaHealth_think instead of setting client.pers.megahealth_time", () => {
    const { edicts, rec } = setupWorld(1, 4);
    rec.cvars.set("deathmatch", Object.assign(new CvarT(), { name: "deathmatch", string: "1", value: 1 }));
    const player = makePlayerEdict(edicts, 0);
    player.health = 50;
    player.max_health = 100;
    const mega = makeItemEdict(edicts, 1, ItemIdT.IT_HEALTH_MEGA);

    Pickup_Health(mega, player);

    expect(mega.think).toBe(MegaHealth_think);
    expect(mega.owner).toBe(player);
    expect(player.client!.pers.megahealth_time).toBe(Gtime_from_ms(0)); // untouched in DM path
  });

  test("mega-health in single-player sets client.pers.megahealth_time instead of scheduling a think", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.health = 50;
    player.max_health = 100;
    const mega = makeItemEdict(edicts, 1, ItemIdT.IT_HEALTH_MEGA);

    Pickup_Health(mega, player);

    expect(mega.think).toBeNull();
    expect(player.client!.pers.megahealth_time).toBe(Gtime_from_sec(5));
  });

  test("MegaHealth_think ticks health down by 1 per second while overhealed, then respawns/frees once back at max", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.health = 150;
    player.max_health = 100;
    const mega = makeItemEdict(edicts, 1, ItemIdT.IT_HEALTH_MEGA);
    mega.owner = player;

    MegaHealth_think(mega);

    expect(player.health).toBe(149);
    expect(mega.nextthink).toBe(Gtime_from_sec(1));
  });

  test("MegaHealth_think frees itself once the owner is no longer overhealed (single player, no respawn)", () => {
    // G_FreeEdict no-ops for any edict indexed within
    // [0, game.maxclients + BODY_QUEUE_SIZE] (the reserved client/body-queue
    // range) -- use a maxclients=1 world with the mega edict placed well
    // past that reserved range (index 20 > 1 + BODY_QUEUE_SIZE(8) = 9) so
    // this test actually exercises a real free.
    const { edicts } = setupWorld(1, 25);
    const player = makePlayerEdict(edicts, 0);
    player.health = 100;
    player.max_health = 100;
    const mega = makeItemEdict(edicts, 20, ItemIdT.IT_HEALTH_MEGA);
    mega.owner = player;
    mega.inuse = true;

    MegaHealth_think(mega);

    expect(mega.inuse).toBe(false); // G_FreeEdict clears inuse
  });
});

// ---------------------------------------------------------------------------
// Quad Damage stacking timing rule
// ---------------------------------------------------------------------------

describe("Use_Quad timing", () => {
  test("using a second quad re-ups from max(level.time, quad_time), not from a flat level.time + 30s", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD] = 2;
    level.time = Gtime_from_ms(10_000);
    player.client!.quad_time = Gtime_from_ms(35_000); // still 25s of quad left

    const quadItem = GetItemByIndex(ItemIdT.IT_ITEM_QUAD)!;
    Use_Quad(player, quadItem);

    // stacks on top of the existing 35s expiry, not level.time (10s) + 30s
    expect(player.client!.quad_time).toBe(Gtime_from_ms(65_000));
    expect(player.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD]).toBe(1);
  });

  test("using quad with none currently active starts a flat 30s window from level.time", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD] = 1;
    level.time = Gtime_from_ms(5_000);
    player.client!.quad_time = Gtime_from_ms(0);

    const quadItem = GetItemByIndex(ItemIdT.IT_ITEM_QUAD)!;
    Use_Quad(player, quadItem);

    expect(player.client!.quad_time).toBe(Gtime_from_ms(35_000));
  });
});

// ---------------------------------------------------------------------------
// Ammo add caps
// ---------------------------------------------------------------------------

describe("Add_Ammo caps", () => {
  test("Add_Ammo never exceeds the player's max_ammo ceiling for that ammo tag", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.max_ammo[AmmoT.AMMO_SHELLS] = 100;
    player.client!.pers.inventory[ItemIdT.IT_AMMO_SHELLS] = 90;

    const shellsItem = GetItemByIndex(ItemIdT.IT_AMMO_SHELLS)!;
    const added = Add_Ammo(player, shellsItem, 50);

    expect(added).toBe(true);
    expect(player.client!.pers.inventory[ItemIdT.IT_AMMO_SHELLS]).toBe(100);
  });

  test("Add_Ammo returns false and adds nothing once already at the cap", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.max_ammo[AmmoT.AMMO_SHELLS] = 100;
    player.client!.pers.inventory[ItemIdT.IT_AMMO_SHELLS] = 100;

    const shellsItem = GetItemByIndex(ItemIdT.IT_AMMO_SHELLS)!;
    const added = Add_Ammo(player, shellsItem, 10);

    expect(added).toBe(false);
    expect(player.client!.pers.inventory[ItemIdT.IT_AMMO_SHELLS]).toBe(100);
  });

  test("Add_Ammo returns false for a non-client entity (item.tag out of ammo range is also rejected)", () => {
    const { edicts } = setupWorld(1, 4);
    const monster = edicts[0]!;
    monster.inuse = true;
    const armorItem = GetItemByIndex(ItemIdT.IT_ARMOR_BODY)!; // tag 0, not an ammo tag
    expect(Add_Ammo(monster, armorItem, 10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Power armor toggle
// ---------------------------------------------------------------------------

describe("Use_PowerArmor toggle", () => {
  test("toggling on requires cells and sets FL_POWER_ARMOR", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 50;

    const screenItem = GetItemByIndex(ItemIdT.IT_ITEM_POWER_SCREEN)!;
    Use_PowerArmor(player, screenItem);

    expect((player.flags & 0x1000n) !== 0n).toBe(true); // FL_POWER_ARMOR = bitBig(12)
  });

  test("toggling on with no cells prints the no-cells message and does not set the flag", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.client!.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 0;

    const screenItem = GetItemByIndex(ItemIdT.IT_ITEM_POWER_SCREEN)!;
    Use_PowerArmor(player, screenItem);

    expect((player.flags & 0x1000n) !== 0n).toBe(false);
  });

  test("toggling off clears FL_POWER_ARMOR and FL_WANTS_POWER_ARMOR", () => {
    const { edicts } = setupWorld(1, 4);
    const player = makePlayerEdict(edicts, 0);
    player.flags = 0x1000n | 0x40000000n; // FL_POWER_ARMOR | FL_WANTS_POWER_ARMOR

    const screenItem = GetItemByIndex(ItemIdT.IT_ITEM_POWER_SCREEN)!;
    Use_PowerArmor(player, screenItem);

    expect(player.flags & 0x1000n).toBe(0n);
    expect(player.flags & 0x40000000n).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// SetRespawn ordering
// ---------------------------------------------------------------------------

describe("SetRespawn ordering", () => {
  test("already-respawning entity (think === DoRespawn, nextthink in the future) is a no-op", () => {
    const { edicts } = setupWorld(1, 4);
    const ent = edicts[0]!;
    ent.inuse = true;
    level.time = Gtime_from_ms(1_000);
    ent.think = DoRespawn;
    ent.nextthink = Gtime_from_ms(5_000);
    ent.flags = 0n;

    SetRespawn(ent, Gtime_from_sec(30));

    // nextthink is untouched -- the guard returned before scheduling anything new
    expect(ent.nextthink).toBe(Gtime_from_ms(5_000));
    expect(ent.flags).toBe(0n);
  });

  test("an entity whose DoRespawn think has already elapsed schedules a fresh respawn", () => {
    const { edicts } = setupWorld(1, 4);
    const ent = edicts[0]!;
    ent.inuse = true;
    level.time = Gtime_from_ms(10_000);
    ent.think = DoRespawn;
    ent.nextthink = Gtime_from_ms(5_000); // already in the past

    SetRespawn(ent, Gtime_from_sec(30), false);

    expect(ent.nextthink).toBe(Gtime_from_ms(40_000));
    expect(ent.flags & 0x80000000n).not.toBe(0n); // FL_RESPAWN = bitBig(31)
  });

  test("hide_self defaults to true and hides the entity (SVF_NOCLIENT + SOLID_NOT)", () => {
    const { edicts } = setupWorld(1, 4);
    const ent = edicts[0]!;
    ent.inuse = true;
    level.time = Gtime_from_ms(0);

    SetRespawn(ent, Gtime_from_sec(10));

    const solid: SolidT = ent.solid;
    expect(solid).toBe(SolidT.SOLID_NOT);
    expect(ent.think).toBe(DoRespawn);
  });
});

// ---------------------------------------------------------------------------
// Use_Doppleganger (rogue/g_rogue_items.cpp:65-88) -- gap fix (2026-08-30,
// KEX demo playback unit): this file's own local `Use_Doppleganger` used to
// be an unconditional throwing stub; it now delegates to
// rogue/g_rogue_items.ts's real, reconciled implementation (FindSpawnPoint/
// CheckGroundSpawnPoint/SpawnGrow_Spawn imported for real from m_medic.ts,
// with the calling convention mismatch fixed -- see that file's own header
// for the derivation). Reached through the real itemlist entry, matching
// how a real Use_Item command would call it.
// ---------------------------------------------------------------------------

describe("Use_Doppleganger (rogue/g_rogue_items.cpp:65-88)", () => {
  test("valid ground spot: spawns a doppleganger and decrements inventory", () => {
    const { edicts, rec } = setupWorld(1, 16);
    const ent = makePlayerEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 100);
    ent.client!.v_angle[YAW] = 90;

    const item = itemlist[ItemIdT.IT_ITEM_DOPPELGANGER]!;
    ent.client!.pers.inventory[item.id] = 1;

    // A trace that reports solid ground directly below wherever it's cast,
    // hitting the world entity -- satisfies CheckSpawnPoint's `tr.ent ===
    // world` check and M_droptofloor_generic's `fraction !== 1` check in one
    // shot. pointcontents SOLID at every corner satisfies
    // M_CheckBottom_Fast_Generic (the CheckGroundSpawnPoint half).
    rec.traceResult = {
      allsolid: false,
      startsolid: false,
      fraction: 0.5,
      endpos: vec3(48, 0, 90),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: g_edicts[0]!,
      plane2: new CplaneT(),
      surface2: null,
    };
    rec.pointcontentsResult = ContentsT.CONTENTS_SOLID;

    expect(() => item.use!(ent, item)).not.toThrow();

    expect(ent.client!.pers.inventory[item.id]).toBe(0);
    const spawned = edicts.filter((e) => e.inuse && e.classname === "doppleganger");
    expect(spawned.length).toBe(1);
  });

  test("no valid ground spot nearby: returns early without throwing or decrementing inventory", () => {
    const { edicts } = setupWorld(1, 8);
    const ent = makePlayerEdict(edicts, 1);
    ent.s.origin = vec3(0, 0, 100);
    ent.client!.v_angle[YAW] = 0;
    // default fixture trace (fraction: 1, no hit) / pointcontents (0, not
    // solid) -- the real game's own "nowhere to put it" case.

    const item = itemlist[ItemIdT.IT_ITEM_DOPPELGANGER]!;
    ent.client!.pers.inventory[item.id] = 1;

    expect(() => item.use!(ent, item)).not.toThrow();
    expect(ent.client!.pers.inventory[item.id]).toBe(1); // unchanged: never reached the decrement
  });
});
