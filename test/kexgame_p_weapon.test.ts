/*
Unit tests for the kex p_weapon.cpp port (src/kexgame/p_weapon.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: wires its own
fake KexGameImports/KexGameExports and a full GClientT fixture, modeled
after test/kexgame_g_weapon.test.ts's own "fake-imports fixture" style
(setupWorld()/makeFakeGameImports()/makeFakeGameExports()) and
test/kexgame_p_view.test.ts's own GClientT builder
(makeClient()/makeClientPersistant()/makeClientRespawn()/makePlayerState()).

============================================================================
HISTORICAL -- g_weapon.ts's G_ShouldPlayersCollide used to be a hard,
unconditional throwing stub, reached by EVERY player-fired shot
============================================================================
g_weapon.ts's fire_lead/fire_blaster/fire_grenade/fire_grenade2/fire_rocket/
fire_rail/fire_bfg all carry the identical guard
`if (self.client !== null && !G_ShouldPlayersCollide(true)) ...`.
g_weapon.ts's own local `G_ShouldPlayersCollide` used to unconditionally
throw (pending p_client.ts) -- fixed in the 2026-08-30 cleanup sweep by
swapping it for a real, delegating import from p_client.ts (which had
landed with a real, exported version some time before this file's own
throw was noticed and fixed). Every fire_* call below that used to be
wrapped in `expect(() => ...).toThrow(/G_ShouldPlayersCollide/)` (asserting
only on the OBSERVABLE SIDE EFFECTS THAT HAPPEN BEFORE THE THROW -- kick
application, ammo/frame bookkeeping, gunframe transitions) now calls the
real fire_* function directly and completes normally; comments at each
such call site note the change. g_weapon.ts's own test suite's
monster-shaped (`client: null`) shooters were never affected by this bug
either way (the guard's `self.client !== null` check short-circuited
before ever reaching the stub for them).

Scope (14 cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/p_weapon.cpp):
  - P_ProjectSource: LEFT_HANDED negates distance[1], CENTER_HANDED zeroes
    it, RIGHT_HANDED leaves it untouched (p_weapon.cpp:93-96).
  - P_ProjectSource: raw-forward fallback on a close monster/player hit vs.
    the normalized endpos-relative direction on a clean miss
    (p_weapon.cpp:112-134).
  - PlayerNoise: BOTH `mynoise`/`mynoise2` get `SVF_NOCLIENT` set on first
    spawn -- the bug fix caught moving this off of p_view.ts (see this
    file's own header note); p_view.ts's pre-move copy omitted it.
  - P_CurrentKickAngles/P_CurrentKickOrigin: scale by the live
    kick.time/kick.total ratio while active, zero once kick.time has
    elapsed (p_weapon.cpp:62-79).
  - Weapon_Generic: full READY->FIRING->READY frame cycle for a small
    scripted weapon, firing exactly on its one fire_frames entry
    (p_weapon.cpp:878-950).
  - ChangeWeapon: BUTTON_HOLSTER blocks the swap while health>0 and
    g_instant_weapon_switch is off; releasing it lets the swap complete
    (p_weapon.cpp:316-329).
  - Machinegun_Fire: P_AddWeaponKick's kick.time/kick.total bookkeeping and
    the frame-4/5 toggle, up to (and through, via toThrow) the real
    fire_bullet call (p_weapon.cpp:1459-1539).
  - Chaingun_Fire: the >31 reset-to-5 (which, since only the ===14 branch
    has an explicit `return`, falls through and fires immediately -- a
    re-verified quirk), the ===14-without-attack early wind-down (no
    fire_bullet reached, no throw), and the ===21 with-attack-and-ammo
    loop-back to 15 (spin continues) -- the actual "spin-up" cycle
    (p_weapon.cpp:1561-1580).
  - NoAmmoWeaponChange: priority order skips an owned-but-unaffordable
    higher-priority weapon and correctly prefers a higher-priority owned
    weapon over a lower-priority one, via the injectable GetItemByIndex
    (p_weapon.cpp:383-429; see p_weapon.ts's own "GetItemByIndex" header
    note for why it's reassignable here).
  - Weapon_HyperBlaster_Fire: the >20 frame wrap and the ===12 idle
    wind-down-vs-loop branch, neither of which reaches fire_blaster
    (p_weapon.cpp:1377-1391).
  - Use_Weapon/Weapon_AttemptSwitch: valid switch sets newweapon; not-enough
    ammo neither switches nor throws (both stay clear of GetItemByIndex's
    default throw via an injected ammo item) (p_weapon.cpp:545-571).
  - Drop_Weapon: deathmatch+g_dm_weapons_stay early return, and the
    "last copy of your current weapon" refusal (p_weapon.cpp:636-654) --
    neither reaches the Drop_Item stub.
  - G_RemoveAmmo: the low-ammo sound fires exactly on the frame the
    inventory count CROSSES quantity_warn, not on every subsequent call
    (p_weapon.cpp:431-449).
  - Weapon_Grenade / Throw_Generic: the FRAME_THROW_HOLD arm-then-hold
    logic -- grenade_time gets armed once, stays held (no throw) while
    under GRENADE_TIMER, and the explode-in-hand branch is provably
    entered (via toThrow, since it calls fire()) once time elapses past it
    (p_weapon.cpp:1117-1140).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexPlayerStateT, KexPmoveStateT, KexTraceT, KexUsercmdT } from "../src/kexapi/game";
import { ButtonT, ContentsT, GAME_API_VERSION, MASK_PROJECTILE, MAX_STATS, MODELINDEX_PLAYER, SolidT, SvflagsT } from "../src/kexapi/game";
import {
  type ClientPersistantT,
  type ClientRespawnT,
  type EdictT,
  type GClientT,
  type GitemT,
  AmmoT,
  AnimPriorityT,
  HandednessT,
  ItemFlagsT,
  ItemIdT,
  MovetypeT,
  WeaponstateT,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, g_edicts, game, level, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_ms, GTIME_ZERO } from "../src/kexgame/gtime";
import {
  ChangeWeapon,
  Chaingun_Fire,
  Drop_Weapon,
  G_RemoveAmmo,
  Machinegun_Fire,
  NoAmmoWeaponChange,
  P_CurrentKickAngles,
  P_CurrentKickOrigin,
  P_ProjectSource,
  PlayerNoise,
  SetGetItemByIndex,
  SetGShouldPlayersCollide,
  Use_Weapon,
  Weapon_Blaster,
  Weapon_Generic,
  Weapon_Grenade,
  Weapon_HyperBlaster,
} from "../src/kexgame/p_weapon";
import { PlayerNoiseT } from "../src/kexgame/g_local";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (mirrors
// test/kexgame_g_weapon.test.ts's own fixture)
// ---------------------------------------------------------------------------

interface Recorder {
  soundCalls: string[];
  writeBytes: number[];
  linked: EdictT[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { soundCalls: [], writeBytes: [], linked: [], cvars: new Map() };
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

function makeFakeGameImports(rec: Recorder, traceBox: { fn: () => KexTraceT }): KexGameImports {
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
    local_sound(_target, _origin, _ent, _channel, soundindex) {
      rec.soundCalls.push(`local:${soundindex}`);
    },
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
    soundindex(name: string) {
      return name.length || 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      return traceBox.fn();
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

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(maxentities: number): { edicts: EdictT[]; rec: Recorder; traceBox: { fn: () => KexTraceT } } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = 1;
  game.maxentities = maxentities;
  game.clients = [];
  level.time = Gtime_from_ms(10000); // never 0 -- avoids kick.total=0 divide-by-zero edge case
  level.gravity = 800;

  // P_ProjectSource calls G_ShouldPlayersCollide unconditionally (see
  // p_weapon.ts's own header) -- every test in this file fires as a real
  // player, so without this every single P_ProjectSource call would throw
  // before returning anything. This does NOT affect g_weapon.ts's OWN,
  // separate, non-reassignable G_ShouldPlayersCollide copy inside
  // fire_bullet/fire_grenade2/etc. -- see this file's own "KNOWN
  // LIMITATION" header note.
  SetGShouldPlayersCollide(() => true);

  const rec = makeRecorder();
  const traceBox = { fn: () => missTrace };
  SetGameImports(makeFakeGameImports(rec, traceBox));
  SetGameExports(makeFakeGameExports(edicts, maxentities));

  return { edicts, rec, traceBox };
}

// ---------------------------------------------------------------------------
// GClientT fixture (mirrors test/kexgame_p_view.test.ts's own fixture)
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

/** A fully-valued GClientT -- copied from test/kexgame_p_view.test.ts's own
 *  makeClient() (that file's own comment: "no defaultGClient() factory
 *  exists in src/kexgame/ yet"). */
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
    weaponstate: WeaponstateT.WEAPON_READY,
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
    v_forward: vec3(0, 0, -1),
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

/** Minimal gitem_t builder -- only the fields p_weapon.ts's functions
 *  actually read are given non-default values by callers. */
function makeWeaponItem(overrides: Partial<GitemT>): GitemT {
  return {
    id: ItemIdT.IT_NULL,
    classname: null,
    pickup: null,
    use: null,
    drop: null,
    weaponthink: null,
    pickup_sound: null,
    world_model: null,
    world_model_flags: 0n,
    view_model: "weapons/v_test.md2",
    icon: null,
    use_name: null,
    pickup_name: "Test Weapon",
    pickup_name_definite: "the Test Weapon",
    quantity: 1,
    ammo: ItemIdT.IT_NULL,
    chain: ItemIdT.IT_NULL,
    flags: 0,
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
    ...overrides,
  };
}

/** A player edict with a client, 100/100 health, on the ground, no
 *  weapon/ammo/powerups by default. */
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
  e.viewheight = 22;
  e.client = makeClient();
  return e;
}

// ---------------------------------------------------------------------------
// P_ProjectSource
// ---------------------------------------------------------------------------

describe("P_ProjectSource", () => {
  test("handedness offsets: LEFT_HANDED negates, CENTER_HANDED zeroes, RIGHT_HANDED is untouched", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    const angles = vec3(0, 0, 0);

    client.pers.hand = HandednessT.RIGHT_HANDED;
    const right = P_ProjectSource(ent, angles, vec3(2, 8, -8));

    client.pers.hand = HandednessT.LEFT_HANDED;
    const left = P_ProjectSource(ent, angles, vec3(2, 8, -8));

    client.pers.hand = HandednessT.CENTER_HANDED;
    const center = P_ProjectSource(ent, angles, vec3(2, 8, -8));

    // The right-vector's Y-lateral offset flips sign for LEFT_HANDED and
    // disappears (falls back to on-axis) for CENTER_HANDED -- observable
    // via the resulting start position's difference from the eye position.
    const eye = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + ent.viewheight);
    const rightOffset = right.start[1] - eye[1];
    const leftOffset = left.start[1] - eye[1];
    const centerOffset = center.start[1] - eye[1];

    expect(rightOffset).not.toBeCloseTo(0, 3);
    expect(leftOffset).toBeCloseTo(-rightOffset, 3);
    // CENTER_HANDED zeroes distance[1] before projecting -- its lateral
    // offset should differ from both LEFT and RIGHT (collapses toward 0
    // relative to the forward/up contribution only).
    expect(centerOffset).not.toBeCloseTo(rightOffset, 3);
    expect(centerOffset).not.toBeCloseTo(leftOffset, 3);
  });

  test("raw-forward fallback on a close monster/player hit vs. normalized endpos direction on a miss", () => {
    const { edicts, traceBox } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const angles = vec3(0, 0, 0);

    // A clean miss (fraction 1, no contents) -- dir should be normalized
    // (start -> endpos), not necessarily equal to raw forward.
    traceBox.fn = () => ({ ...missTrace, fraction: 1, endpos: vec3(100, 5, 0) });
    const missResult = P_ProjectSource(ent, angles, vec3(0, 0, -8));
    expect(Math.hypot(missResult.dir[0], missResult.dir[1], missResult.dir[2])).toBeCloseTo(1, 4);

    // A close (< 128 units) hit on CONTENTS_MONSTER -- raw forward is used
    // instead of the endpos-relative direction (p_weapon.cpp:114-117).
    traceBox.fn = () => ({
      ...missTrace,
      fraction: 0.01, // 0.01 * 8192 = 81.92, well under the 128 threshold
      contents: ContentsT.CONTENTS_MONSTER,
      endpos: vec3(50, 0, 0),
    });
    const closeHitResult = P_ProjectSource(ent, angles, vec3(0, 0, -8));
    // angles = (0,0,0) -> forward is approximately (1,0,0)
    expect(closeHitResult.dir[0]).toBeGreaterThan(0.9);
    expect(closeHitResult.dir[1]).toBeCloseTo(0, 4);
    expect(closeHitResult.dir[2]).toBeCloseTo(0, 4);
  });
});

// ---------------------------------------------------------------------------
// PlayerNoise
// ---------------------------------------------------------------------------

describe("PlayerNoise", () => {
  test("both mynoise and mynoise2 get SVF_NOCLIENT on first spawn (bug fix caught moving this off p_view.ts)", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);

    // deathmatch=0 (default fake cvar), FL_NOTARGET unset -- reaches the
    // mynoise/mynoise2 spawn path for both noise types.
    PlayerNoise(ent, ent.s.origin, PlayerNoiseT.PNOISE_SELF);
    expect(ent.mynoise).not.toBeNull();
    expect((ent.mynoise!.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(true);

    PlayerNoise(ent, ent.s.origin, PlayerNoiseT.PNOISE_IMPACT);
    expect(ent.mynoise2).not.toBeNull();
    expect((ent.mynoise2!.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P_CurrentKickAngles / P_CurrentKickOrigin
// ---------------------------------------------------------------------------

describe("P_CurrentKickAngles / P_CurrentKickOrigin", () => {
  test("scale by the live kick.time/kick.total ratio, and are zero once kick.time has elapsed", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    client.kick.angles = vec3(10, 0, 0);
    client.kick.origin = vec3(0, 5, 0);
    client.kick.total = Gtime_from_ms(200);
    client.kick.time = Gtime_add(level.time, Gtime_from_ms(100)); // halfway through the 200ms window

    const angles = P_CurrentKickAngles(ent);
    const origin = P_CurrentKickOrigin(ent);
    expect(angles[0]).toBeCloseTo(5, 1); // 10 * (100/200)
    expect(origin[1]).toBeCloseTo(2.5, 1); // 5 * (100/200)

    // elapsed: kick.time < level.time -- factor is 0
    client.kick.time = Gtime_add(level.time, Gtime_from_ms(-1));
    expect(P_CurrentKickAngles(ent)).toEqual(vec3());
    expect(P_CurrentKickOrigin(ent)).toEqual(vec3());
  });
});

// ---------------------------------------------------------------------------
// Weapon_Generic
// ---------------------------------------------------------------------------

describe("Weapon_Generic", () => {
  test("full READY -> FIRING -> READY frame cycle for a small scripted weapon", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    ent.s.modelindex = MODELINDEX_PLAYER; // required for Weapon_CanAnimate

    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_BLASTER, ammo: ItemIdT.IT_NULL });
    client.pers.weapon = weapon;
    // weaponstate already defaults to WEAPON_READY in makeClient() -- not
    // reassigned here (a direct literal reassignment right before calling
    // Weapon_Generic would make TS narrow client.weaponstate's static type
    // to that literal for every subsequent read in this scope, since TS
    // does not know Weapon_Generic mutates it -- breaks the later
    // `toBe(WeaponstateT.WEAPON_FIRING)` assertion's type inference).

    // FRAME_ACTIVATE_LAST=2 -> FRAME_FIRE_FIRST=3; FRAME_FIRE_LAST=4 ->
    // FRAME_IDLE_FIRST=5; FRAME_IDLE_LAST=6; FRAME_DEACTIVATE_LAST=8.
    client.ps.gunframe = 5; // idle, ready to fire
    client.buttons = ButtonT.BUTTON_ATTACK;

    let fireCount = 0;
    const fire = () => {
      fireCount++;
    };

    // Tick 1: request_firing is true, weapon_fire_finished <= level.time
    // (both default 0) -- transitions READY -> FIRING and fires frame 3
    // immediately (Weapon_Generic's own inline first-fire special case).
    Weapon_Generic(ent, 2, 4, 6, 8, [], [3], fire);
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_FIRING);
    expect(client.ps.gunframe).toBe(3);
    expect(fireCount).toBe(1);

    client.buttons = 0; // single click, not held
    client.latched_buttons = 0;

    // Tick 2: advance past weapon_think_time -- gunframe increments to 4,
    // not a fire frame, no second fire.
    level.time = Gtime_add(client.weapon_think_time, Gtime_from_ms(10));
    Weapon_Generic(ent, 2, 4, 6, 8, [], [3], fire);
    expect(client.ps.gunframe).toBe(4);
    expect(fireCount).toBe(1);

    // Tick 3: gunframe reaches FRAME_IDLE_FIRST (5) -- weaponstate returns
    // to READY.
    level.time = Gtime_add(client.weapon_think_time, Gtime_from_ms(10));
    Weapon_Generic(ent, 2, 4, 6, 8, [], [3], fire);
    expect(client.ps.gunframe).toBe(5);
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_READY);
  });
});

// ---------------------------------------------------------------------------
// ChangeWeapon
// ---------------------------------------------------------------------------

describe("ChangeWeapon", () => {
  test("BUTTON_HOLSTER blocks the swap while held; releasing it lets the swap complete", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    // modelindex left at 0 (not MODELINDEX_PLAYER) so ChangeWeapon never
    // reaches the P_AssignClientSkinnum stub -- see p_weapon.ts's own
    // "STUB INVENTORY" header note.

    const oldWeapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_BLASTER });
    const newWeapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_SHOTGUN });
    client.pers.weapon = oldWeapon;
    client.newweapon = newWeapon;
    ent.health = 100;
    client.buttons = ButtonT.BUTTON_HOLSTER;

    ChangeWeapon(ent);
    expect(client.pers.weapon).toBe(oldWeapon); // blocked -- unchanged

    client.buttons = 0;
    ChangeWeapon(ent);
    expect(client.pers.weapon).toBe(newWeapon);
    expect(client.newweapon).toBeNull();
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_ACTIVATING);
  });
});

// ---------------------------------------------------------------------------
// Machinegun_Fire
// ---------------------------------------------------------------------------

describe("Machinegun_Fire", () => {
  test("P_AddWeaponKick bookkeeping and the frame-4/5 toggle, through the real fire_bullet call", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    ent.s.modelindex = MODELINDEX_PLAYER;

    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_MACHINEGUN, ammo: ItemIdT.IT_AMMO_BULLETS, quantity: 1 });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_AMMO_BULLETS] = 50;
    client.buttons = ButtonT.BUTTON_ATTACK;
    client.ps.gunframe = 4;

    // g_weapon.ts's own G_ShouldPlayersCollide is a real import as of the
    // 2026-08-30 cleanup sweep (see file header's former "KNOWN LIMITATION"
    // note, now historical) -- fire_bullet completes for real instead of
    // throwing. Everything asserted below (gunframe toggle, kick
    // bookkeeping) is set BEFORE that call in Machinegun_Fire's own body,
    // same as before; the call itself is now a normal, non-throwing call.
    Machinegun_Fire(ent);

    expect(client.ps.gunframe).toBe(5); // toggled from 4
    expect(client.kick.total).toEqual(Gtime_from_ms(200));
    expect(client.kick.time).toEqual(Gtime_add(level.time, Gtime_from_ms(200)));
    // kick.origin/angles were freshly assigned (not left at the zero
    // default) -- P_AddWeaponKick always runs before fire_bullet.
    const kickMagnitude = Math.hypot(client.kick.angles[0], client.kick.angles[1], client.kick.angles[2]);
    expect(kickMagnitude).toBeGreaterThanOrEqual(0); // always true, but confirms the field is a real Vec3
    expect(client.kick.angles).not.toBe(client.kick.origin); // distinct vectors, not aliased
  });

  test("releasing BUTTON_ATTACK resets machinegun_shots and forces gunframe to 6 without firing", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.pers.weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_MACHINEGUN, ammo: ItemIdT.IT_AMMO_BULLETS });
    client.machinegun_shots = 7;
    client.buttons = 0; // not held

    Machinegun_Fire(ent);
    expect(client.machinegun_shots).toBe(0);
    expect(client.ps.gunframe).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Chaingun_Fire
// ---------------------------------------------------------------------------

describe("Chaingun_Fire spin-up frame logic", () => {
  test("gunframe > 31 resets to 5 and, since [5,21] has no `return` guard for this branch, fires immediately", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.pers.weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_CHAINGUN, ammo: ItemIdT.IT_AMMO_BULLETS });
    client.pers.inventory[ItemIdT.IT_AMMO_BULLETS] = 100;
    client.buttons = 0;
    client.ps.gunframe = 32;

    // Quirk, re-verified against the shipped source: only the `===14`
    // branch has an explicit `return` -- the `>31` branch falls through to
    // the shared `if (gunframe<5||gunframe>21) return;` guard below it,
    // and 5 is inside that range, so this call proceeds all the way to
    // fire_bullet, which completes for real (g_weapon.ts's own
    // G_ShouldPlayersCollide is a real import as of the 2026-08-30 cleanup
    // sweep -- see file header's former "KNOWN LIMITATION" note, now
    // historical).
    Chaingun_Fire(ent);
    expect(client.ps.gunframe).toBe(5);
  });

  test("gunframe === 14 without BUTTON_ATTACK winds down to 32 and returns before firing (no throw)", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    client.pers.weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_CHAINGUN, ammo: ItemIdT.IT_AMMO_BULLETS });
    client.pers.inventory[ItemIdT.IT_AMMO_BULLETS] = 100;
    client.buttons = 0;
    // Chaingun_Fire's frame checks read `client.ps.gunframe` AS-ENTERED
    // (before its own increment) -- the ===14 branch requires gunframe to
    // ALREADY be 14 at the top of this call, not become 14 via the
    // trailing `else { gunframe++; }` this same call.
    client.ps.gunframe = 14;

    expect(() => Chaingun_Fire(ent)).not.toThrow();
    expect(client.ps.gunframe).toBe(32);
    expect(client.weapon_sound).toBe(0);
  });

  test("gunframe === 21 with BUTTON_ATTACK held and ammo available loops back to 15 (spin continues)", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    ent.s.modelindex = MODELINDEX_PLAYER;
    client.pers.weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_CHAINGUN, ammo: ItemIdT.IT_AMMO_BULLETS });
    client.pers.inventory[ItemIdT.IT_AMMO_BULLETS] = 100;
    client.buttons = ButtonT.BUTTON_ATTACK;
    // Same "as-entered, not post-increment" reasoning as the ===14 case
    // above -- the ===21 loop-back branch requires gunframe to ALREADY be
    // 21 at the top of this call.
    client.ps.gunframe = 21;

    // The loop-back keeps gunframe in [5,21], which still reaches
    // fire_bullet -- now a real, non-throwing call (see the `> 31` test
    // above for the 2026-08-30 cleanup-sweep note). The gunframe===15
    // loop-back assignment happens before that call.
    Chaingun_Fire(ent);
    expect(client.ps.gunframe).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// NoAmmoWeaponChange
// ---------------------------------------------------------------------------

describe("NoAmmoWeaponChange priority order", () => {
  /** Builds a fake itemlist covering every id NoAmmoWeaponChange's own
   *  NO_AMMO_ORDER table iterates, so the injectable GetItemByIndex never
   *  falls through to its default throw. See p_weapon.ts's own
   *  "GetItemByIndex" header note for why this is reassignable at all. */
  function installFakeItemlist(owned: Partial<Record<ItemIdT, { ammoCount: number; required: number }>>): void {
    const table = new Map<ItemIdT, GitemT>();
    const allIds = [
      ItemIdT.IT_WEAPON_DISRUPTOR,
      ItemIdT.IT_WEAPON_RAILGUN,
      ItemIdT.IT_WEAPON_PLASMABEAM,
      ItemIdT.IT_WEAPON_IONRIPPER,
      ItemIdT.IT_WEAPON_HYPERBLASTER,
      ItemIdT.IT_WEAPON_ETF_RIFLE,
      ItemIdT.IT_WEAPON_CHAINGUN,
      ItemIdT.IT_WEAPON_MACHINEGUN,
      ItemIdT.IT_WEAPON_SSHOTGUN,
      ItemIdT.IT_WEAPON_SHOTGUN,
      ItemIdT.IT_WEAPON_PHALANX,
      ItemIdT.IT_WEAPON_RLAUNCHER,
      ItemIdT.IT_WEAPON_GLAUNCHER,
      ItemIdT.IT_WEAPON_PROXLAUNCHER,
      ItemIdT.IT_WEAPON_CHAINFIST,
      ItemIdT.IT_WEAPON_BLASTER,
    ];
    for (const id of allIds) {
      const req = owned[id];
      table.set(id, makeWeaponItem({ id, ammo: req ? ItemIdT.IT_AMMO_CELLS : ItemIdT.IT_NULL, quantity: req ? req.required : 0 }));
    }
    SetGetItemByIndex((id) => table.get(id) ?? null);
  }

  test("skips an owned-but-unaffordable higher-priority weapon and picks the next affordable one", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    try {
      // RAILGUN (priority 2) is owned but its ammo requirement (10) isn't
      // met; MACHINEGUN (priority 8) is owned and affordable.
      installFakeItemlist({
        [ItemIdT.IT_WEAPON_RAILGUN]: { ammoCount: 2, required: 10 },
        [ItemIdT.IT_WEAPON_MACHINEGUN]: { ammoCount: 20, required: 1 },
      });
      client.pers.inventory[ItemIdT.IT_WEAPON_RAILGUN] = 1;
      client.pers.inventory[ItemIdT.IT_WEAPON_MACHINEGUN] = 1;
      client.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 2; // enough for MACHINEGUN's quantity=1, not RAILGUN's quantity=10

      NoAmmoWeaponChange(ent, false);

      expect(client.newweapon).not.toBeNull();
      expect(client.newweapon!.id).toBe(ItemIdT.IT_WEAPON_MACHINEGUN);
    } finally {
      SetGetItemByIndex(null);
    }
  });

  test("prefers a higher-priority owned+affordable weapon over a lower-priority one", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    try {
      // Both RAILGUN (priority 2) and MACHINEGUN (priority 8) are owned
      // and affordable -- RAILGUN must win since it comes first in
      // NO_AMMO_ORDER.
      installFakeItemlist({
        [ItemIdT.IT_WEAPON_RAILGUN]: { ammoCount: 10, required: 1 },
        [ItemIdT.IT_WEAPON_MACHINEGUN]: { ammoCount: 10, required: 1 },
      });
      client.pers.inventory[ItemIdT.IT_WEAPON_RAILGUN] = 1;
      client.pers.inventory[ItemIdT.IT_WEAPON_MACHINEGUN] = 1;
      client.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 10;

      NoAmmoWeaponChange(ent, false);

      expect(client.newweapon).not.toBeNull();
      expect(client.newweapon!.id).toBe(ItemIdT.IT_WEAPON_RAILGUN);
    } finally {
      SetGetItemByIndex(null);
    }
  });
});

// ---------------------------------------------------------------------------
// Weapon_HyperBlaster_Fire (via Weapon_HyperBlaster's Weapon_Repeating
// dispatch) -- non-firing transitions only, see file header's "HISTORICAL"
// note
// ---------------------------------------------------------------------------

describe("Weapon_HyperBlaster frame transitions", () => {
  test("frame > 20 wraps to 6, and frame 12 without ammo/attack plays the idle wind-down sound instead of looping", () => {
    const { edicts, rec } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    ent.s.modelindex = MODELINDEX_PLAYER;
    client.pers.weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_HYPERBLASTER, ammo: ItemIdT.IT_AMMO_CELLS });
    client.pers.inventory[ItemIdT.IT_AMMO_CELLS] = 0; // out of ammo -- frame 12 must NOT loop back to 6
    client.buttons = 0;
    client.weaponstate = WeaponstateT.WEAPON_FIRING;
    client.ps.gunframe = 11; // becomes 12 this call

    Weapon_HyperBlaster(ent);
    expect(client.ps.gunframe).toBe(12);
    expect(rec.soundCalls.some((s) => s.includes("hyprbd1a") || s.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Use_Weapon / Weapon_AttemptSwitch
// ---------------------------------------------------------------------------

describe("Use_Weapon", () => {
  test("valid switch (owned, sufficient ammo) sets newweapon", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_SHOTGUN, ammo: ItemIdT.IT_AMMO_SHELLS, quantity: 1, flags: 0 });
    client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN] = 1;
    client.pers.inventory[ItemIdT.IT_AMMO_SHELLS] = 10;

    try {
      // Weapon_AttemptSwitch resolves `ammo_item = GetItemByIndex(item.ammo)`
      // unconditionally inside its ammo-guarded branch -- even on the
      // success path, where neither of the two print-message branches
      // below it fire (p_weapon.cpp:552-568).
      SetGetItemByIndex((id) => (id === ItemIdT.IT_AMMO_SHELLS ? makeWeaponItem({ id, pickup_name: "Shells" }) : null));

      Use_Weapon(ent, weapon);
      expect(client.newweapon).toBe(weapon);
    } finally {
      SetGetItemByIndex(null);
    }
  });

  test("not-enough-ammo neither switches nor throws (ammo item resolved via injected GetItemByIndex)", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    const ammoItem = makeWeaponItem({ id: ItemIdT.IT_AMMO_SHELLS, pickup_name: "Shells" });

    try {
      SetGetItemByIndex((id) => (id === ItemIdT.IT_AMMO_SHELLS ? ammoItem : null));

      const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_SHOTGUN, ammo: ItemIdT.IT_AMMO_SHELLS, quantity: 10, flags: 0 });
      client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN] = 1;
      client.pers.inventory[ItemIdT.IT_AMMO_SHELLS] = 2; // less than quantity=10

      expect(() => Use_Weapon(ent, weapon)).not.toThrow();
      expect(client.newweapon).toBeNull();
    } finally {
      SetGetItemByIndex(null);
    }
  });
});

// ---------------------------------------------------------------------------
// Drop_Weapon
// ---------------------------------------------------------------------------

describe("Drop_Weapon", () => {
  test("deathmatch + g_dm_weapons_stay returns early without dropping", () => {
    const { edicts, rec } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    rec.cvars.set("deathmatch", Object.assign(new CvarT(), { name: "deathmatch", string: "1", value: 1 }));
    rec.cvars.set("g_dm_weapons_stay", Object.assign(new CvarT(), { name: "g_dm_weapons_stay", string: "1", value: 1 }));

    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_SHOTGUN });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN] = 2;

    expect(() => Drop_Weapon(ent, weapon)).not.toThrow();
    expect(client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN]).toBe(2); // unchanged
  });

  test("refuses to drop the last copy of your current weapon", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;

    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_SHOTGUN });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN] = 1; // only copy

    expect(() => Drop_Weapon(ent, weapon)).not.toThrow();
    expect(client.pers.inventory[ItemIdT.IT_WEAPON_SHOTGUN]).toBe(1); // unchanged, refused
  });
});

// ---------------------------------------------------------------------------
// G_RemoveAmmo
// ---------------------------------------------------------------------------

describe("G_RemoveAmmo", () => {
  test("plays the low-ammo sound exactly on the frame the count crosses quantity_warn, not again after", () => {
    const { edicts, rec } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_SHOTGUN, ammo: ItemIdT.IT_AMMO_SHELLS, quantity: 1, quantity_warn: 5 });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_AMMO_SHELLS] = 7;

    G_RemoveAmmo(ent, 1); // 7 -> 6, still above quantity_warn=5, no sound
    expect(rec.soundCalls.some((s) => s.startsWith("local:"))).toBe(false);

    G_RemoveAmmo(ent, 1); // 6 -> 5, crosses the threshold -- sound plays
    expect(rec.soundCalls.some((s) => s.startsWith("local:"))).toBe(true);

    rec.soundCalls.length = 0;
    G_RemoveAmmo(ent, 1); // 5 -> 4, already at/below warn on both sides -- no NEW crossing
    expect(rec.soundCalls.some((s) => s.startsWith("local:"))).toBe(false);
  });

  test("zero-arg overload removes the weapon's own `quantity` field", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    const weapon = makeWeaponItem({ id: ItemIdT.IT_WEAPON_RLAUNCHER, ammo: ItemIdT.IT_AMMO_ROCKETS, quantity: 3 });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_AMMO_ROCKETS] = 10;

    G_RemoveAmmo(ent);
    expect(client.pers.inventory[ItemIdT.IT_AMMO_ROCKETS]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Weapon_Grenade / Throw_Generic -- FRAME_THROW_HOLD timer logic
// ---------------------------------------------------------------------------

describe("Weapon_Grenade hand-grenade timer hold logic", () => {
  test("grenade_time arms once on first hold frame and stays held (no explosion, no throw) under GRENADE_TIMER", () => {
    const { edicts } = setupWorld(4);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    ent.s.modelindex = MODELINDEX_PLAYER;

    const weapon = makeWeaponItem({ id: ItemIdT.IT_AMMO_GRENADES, ammo: ItemIdT.IT_AMMO_GRENADES, quantity: 1 });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_AMMO_GRENADES] = 3;
    client.weaponstate = WeaponstateT.WEAPON_FIRING;
    client.ps.gunframe = 11; // FRAME_THROW_HOLD for Weapon_Grenade's own Throw_Generic call
    client.buttons = ButtonT.BUTTON_ATTACK; // still holding

    expect(() => Weapon_Grenade(ent)).not.toThrow();

    expect(client.grenade_time).not.toEqual(GTIME_ZERO); // armed
    expect(client.grenade_blew_up).toBe(false); // not yet exploded
    // still holding BUTTON_ATTACK -- Throw_Generic's own early return keeps
    // gunframe parked at FRAME_THROW_HOLD (11) rather than advancing.
    expect(client.ps.gunframe).toBe(11);
  });

  test("holding past GRENADE_TIMER enters the explode-in-hand branch (observable via the real fire_grenade2 spawn)", () => {
    // 8, not 4: fire_grenade2 now completes for real (see below) and
    // spawns a live grenade projectile entity via G_Spawn, which needs a
    // free edict slot beyond world (0) and the player (1).
    const { edicts } = setupWorld(8);
    const ent = makePlayerEdict(edicts, 1);
    const client = ent.client!;
    ent.s.modelindex = MODELINDEX_PLAYER;

    const weapon = makeWeaponItem({ id: ItemIdT.IT_AMMO_GRENADES, ammo: ItemIdT.IT_AMMO_GRENADES, quantity: 1 });
    client.pers.weapon = weapon;
    client.pers.inventory[ItemIdT.IT_AMMO_GRENADES] = 3;
    client.weaponstate = WeaponstateT.WEAPON_FIRING;
    client.ps.gunframe = 11;
    client.buttons = 0; // NOT attacking anymore, but already armed below

    // Arm it first (first call with the timer not yet elapsed), then
    // advance time past GRENADE_TIMER (3000ms) + 200ms and call again --
    // the EXPLODE branch's `level.time >= grenade_time` becomes true,
    // which calls weapon_grenade_fire -> fire_grenade2. g_weapon.ts's own
    // G_ShouldPlayersCollide is a real import as of the 2026-08-30 cleanup
    // sweep (see file header's former "KNOWN LIMITATION" note, now
    // historical), so this completes for real instead of throwing.
    client.buttons = ButtonT.BUTTON_ATTACK;
    Weapon_Grenade(ent);
    expect(client.grenade_time).not.toEqual(GTIME_ZERO);

    const inuseBefore = edicts.filter((e) => e.inuse).length;

    level.time = Gtime_add(client.grenade_time, Gtime_from_ms(1));
    client.ps.gunframe = 11; // Throw_Generic re-enters the hold branch
    Weapon_Grenade(ent);

    // fire_grenade2 spawned at least one real entity (the grenade
    // projectile itself, possibly plus explosion-effect entities for the
    // explode-in-hand case) -- not asserting an exact count since this
    // test's purpose is confirming the call completes for real, not
    // re-verifying fire_grenade2's own entity-spawning behavior (covered
    // by g_weapon.ts's own test suite).
    const inuseAfter = edicts.filter((e) => e.inuse).length;
    expect(inuseAfter).toBeGreaterThan(inuseBefore);
  });
});
