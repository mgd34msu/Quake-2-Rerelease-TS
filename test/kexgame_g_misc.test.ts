/*
Unit tests for the kex g_misc.cpp port (src/kexgame/g_misc.ts).

Self-sufficient per .orch/preferences.md rule 13: wires up its own fake
KexGameImports/KexGameExports and never relies on another test file having
run first. Modeled after test/kexgame_g_monster.test.ts's own fake-imports
fixture (mutable per-test `traceImpl`/`pointcontentsImpl` hooks, the same
`linkentity` that computes absmin/absmax -- extended here to also compute
`.size`, which g_misc.ts's `ThrowGib` reads), plus test/kexgame_g_combat.test.ts's
full GClientT fixture (no `defaultGClient()` factory exists anywhere in
src/kexgame/ yet), since `teleporter_touch` needs a real player client.
`SetAreaPortalState`/`Com_Print` are recorders instead of no-ops so this
suite can assert on them directly.

Internal (non-exported) handlers -- Use_Areaportal, barrel_delay/barrel_explode,
func_clock_think/use, teleporter_touch, func_explosive_explode -- are reached
the same way real game code reaches them: through the public `.use`/`.think`/
`.die`/`.touch` field an `SP_*` spawn function assigns, never by importing the
module-local const directly (g_misc.ts does not export them).

Scope (18 cases, each citing the exact C++ line range it exercises):
  - ThrowGib velocity scaling + gib type flags (g_misc.cpp:38-64, 86-218):
    organic (GIB_NONE) vscale=0.5 + MOVETYPE_TOSS + upper/lower ClipGibVelocity
    clamp; GIB_ACID vscale=3.0 (clipped at the 500 upper bound); GIB_METALLIC
    vscale=1.0 + MOVETYPE_BOUNCE (no clipping needed); GIB_DEBRIS bypasses
    VelocityForDamage/ClipGibVelocity entirely (proven by a velocity far
    outside the clip range surviving untouched); GIB_HEAD reuses `self` as
    the gib and sets EV_OTHER_TELEPORT + clears monsterinfo.setskin.
  - barrel_explode damage/radius (g_misc.cpp:1119-1135): a target at the
    barrel's exact origin (distance 0) takes exactly `self.dmg`; a target
    beyond `self.dmg + 40` (the radius argument) takes none at all.
  - func_clock tick formatting (g_misc.cpp:1874-1951): style 0 space-padded
    seconds, style 1 mm:ss with zero-padded seconds, style 2 hh:mm:ss
    including the hour/minute rollover carry, and the TIMER_UP
    health>wait threshold that stops rescheduling nextthink.
  - teleporter_touch destination lookup + player state reset (g_misc.cpp:1998-2061):
    origin relocation (dest + 10 on Z, old_origin WITHOUT the offset),
    velocity/pm_time/PMF_TIME_TELEPORT reset, and the "no destination found"
    early-out that changes nothing.
  - areaportal open/close toggling via gi.SetAreaPortalState (g_misc.cpp:13-17):
    first use opens (true), second use closes (false).
  - debris spawn count capping (g_misc.cpp:938-955): mass=800 caps big
    chunks at 8 and small chunks at 16; the default mass=75 case (no
    override) produces 0 big chunks (mass<100) and 3 small chunks, proving
    the cap only engages when actually exceeded.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION, MAX_STATS, SolidT, PmflagsT } from "../src/kexapi/game";
import {
  type EdictT,
  type GClientT,
  type ClientPersistantT,
  type ClientRespawnT,
  MovetypeT,
  GibTypeT,
  ItemIdT,
  AmmoT,
} from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms } from "../src/kexgame/gtime";
import { SpawnFlags_from } from "../src/kexgame/spawnflags";
import {
  ThrowGib,
  SP_func_areaportal,
  SP_misc_explobox,
  SP_func_clock,
  SP_misc_teleporter,
  SP_func_explosive,
} from "../src/kexgame/g_misc";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture
// ---------------------------------------------------------------------------

function noHitTrace(end: Vec3): KexTraceT {
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

let traceImpl: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: number) => KexTraceT = (
  _start,
  _mins,
  _maxs,
  end,
) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;

interface Recorder {
  areaPortalCalls: { portalnum: number; open: boolean }[];
  comPrints: string[];
}
let rec: Recorder;

function makeFakeGameImports(): KexGameImports {
  const cvars = new Map<string, CvarT>();
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

  const modelNamesById: string[] = [""];
  function modelindex(name: string): number {
    let idx = modelNamesById.indexOf(name);
    if (idx === -1) {
      idx = modelNamesById.length;
      modelNamesById.push(name);
    }
    return idx;
  }

  const soundNamesById: string[] = [""];
  function soundindex(name: string): number {
    let idx = soundNamesById.indexOf(name);
    if (idx === -1) {
      idx = soundNamesById.length;
      soundNamesById.push(name);
    }
    return idx;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print(msg: string) {
      rec.comPrints.push(msg);
    },
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
    modelindex,
    soundindex,
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(start, mins, maxs, end, passent, mask) {
      return traceImpl(start, mins, maxs, end, passent, mask);
    },
    clip(_entity, _start, _mins, _maxs, end) {
      return noHitTrace(end);
    },
    pointcontents(point) {
      return pointcontentsImpl(point);
    },
    inPVS() {
      return false;
    },
    inPHS() {
      return false;
    },
    SetAreaPortalState(portalnum, open) {
      rec.areaPortalCalls.push({ portalnum, open });
    },
    AreasConnected() {
      return false;
    },
    linkentity(ent) {
      if (ent === null) return;
      const full = g_edicts[ent.s.number];
      if (full === undefined) return;
      for (let i = 0; i < 3; i++) {
        full.absmin[i] = full.s.origin[i] + full.mins[i];
        full.absmax[i] = full.s.origin[i] + full.maxs[i];
        full.size[i] = full.maxs[i] - full.mins[i];
      }
    },
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

const NUM_EDICTS = 128;

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < NUM_EDICTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 1;
  game.maxentities = NUM_EDICTS;
  level.time = Gtime_from_ms(0);
  level.gravity = 800;
  level.is_n64 = false;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;
  rec = { areaPortalCalls: [], comPrints: [] };

  SetGameImports(makeFakeGameImports());
  // num_edicts must cover every index a test places an entity at directly
  // (G_Find/G_FindByString/findradius all bound their scan by this) -- set
  // to the full preallocated array size rather than tracking it per-test.
  SetGameExports(makeFakeGameExports(edicts, NUM_EDICTS));

  return { edicts };
}

/** A live, non-world entity with sane physics defaults. */
function makeLiveEdict(index: number): EdictT {
  const e = g_edicts[index]!;
  e.inuse = true;
  e.classname = "test_ent";
  e.solid = SolidT.SOLID_BBOX;
  e.mins = vec3(-16, -16, -16);
  e.maxs = vec3(16, 16, 16);
  gi.linkentity(e);
  return e;
}

function countGibsWithModel(modelIndex: number): number {
  let n = 0;
  for (const e of g_edicts) {
    if (e.inuse && e.classname === "gib" && e.s.modelindex === modelIndex) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// full GClientT fixture -- modeled verbatim after
// test/kexgame_g_combat.test.ts's own makeClient() (no defaultGClient()
// factory exists anywhere in src/kexgame/ yet); trimmed to the same shape.
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

function makePlayerEdict(index: number): EdictT {
  const e = makeLiveEdict(index);
  e.classname = "player";
  e.movetype = MovetypeT.MOVETYPE_WALK;
  e.client = makeClient();
  return e;
}

// ---------------------------------------------------------------------------
// ThrowGib (g_misc.cpp:38-64, 86-218)
// ---------------------------------------------------------------------------

describe("ThrowGib", () => {
  let realRandom: () => number;
  beforeEach(() => {
    setupWorld();
    realRandom = Math.random;
    Math.random = () => 0.5; // crandom() -> 0, frandom(200,300) -> 250
  });
  afterEach(() => {
    Math.random = realRandom;
  });

  test("organic (GIB_NONE) uses vscale=0.5, MOVETYPE_TOSS, and ClipGibVelocity's lower clamp (g_misc.cpp:50-64,161-170,180-185)", () => {
    const self = makeLiveEdict(1);
    self.velocity = vec3(0, 0, 0);
    // VelocityForDamage(100, vd): vd=(0,0,250)*1.2=(0,0,300) (damage>=50).
    // organic vscale=0.5 -> (0,0,150); ClipGibVelocity clamps z<200 -> 200.
    const gib = ThrowGib(self, "models/objects/gibs/test/tris.md2", 100, GibTypeT.GIB_NONE, 1.0);
    expect(gib).not.toBeNull();
    expect(gib!.movetype).toBe(MovetypeT.MOVETYPE_TOSS);
    expect(gib!.velocity[0]).toBeCloseTo(0);
    expect(gib!.velocity[1]).toBeCloseTo(0);
    expect(gib!.velocity[2]).toBeCloseTo(200);
  });

  test("GIB_ACID uses vscale=3.0, clipped at ClipGibVelocity's upper 500 bound (g_misc.cpp:161-165,184)", () => {
    const self = makeLiveEdict(1);
    self.velocity = vec3(0, 0, 0);
    // vd=(0,0,300); acid vscale=3.0 -> (0,0,900); clamped to 500.
    const gib = ThrowGib(self, "models/objects/gibs/test/tris.md2", 100, GibTypeT.GIB_ACID, 1.0);
    expect(gib!.velocity[2]).toBeCloseTo(500);
  });

  test("GIB_METALLIC uses vscale=1.0 and MOVETYPE_BOUNCE, no clipping needed (g_misc.cpp:166-170)", () => {
    const self = makeLiveEdict(1);
    self.velocity = vec3(0, 0, 0);
    // vd=(0,0,300); metallic vscale=1.0 -> (0,0,300), already within [200,500].
    const gib = ThrowGib(self, "models/objects/gibs/test/tris.md2", 100, GibTypeT.GIB_METALLIC, 1.0);
    expect(gib!.movetype).toBe(MovetypeT.MOVETYPE_BOUNCE);
    expect(gib!.velocity[2]).toBeCloseTo(300);
  });

  test("GIB_DEBRIS bypasses VelocityForDamage AND ClipGibVelocity entirely (g_misc.cpp:172-179)", () => {
    const self = makeLiveEdict(1);
    self.velocity = vec3(0, 0, 0);
    // v=(100*crandom, 100*crandom, 100+100*crandom) = (0,0,100) with crandom=0.
    // gib.velocity = self.velocity + v*damage = (0,0,100*100) = (0,0,10000) --
    // far outside the [200,500] clip range ClipGibVelocity would otherwise
    // enforce, proving the debris branch never calls it.
    const gib = ThrowGib(self, "models/objects/gibs/test/tris.md2", 100, GibTypeT.GIB_DEBRIS | GibTypeT.GIB_METALLIC, 1.0);
    expect(gib!.velocity[2]).toBeCloseTo(10000);
  });

  test("GIB_HEAD reuses `self` as the gib and sets EV_OTHER_TELEPORT + clears monsterinfo.setskin (g_misc.cpp:94-100)", () => {
    const self = makeLiveEdict(1);
    self.monsterinfo.setskin = () => {};
    const gib = ThrowGib(self, "models/objects/gibs/head2/tris.md2", 100, GibTypeT.GIB_HEAD, 1.0);
    expect(gib).toBe(self);
    expect(self.monsterinfo.setskin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// barrel_explode damage/radius (g_misc.cpp:1119-1135), reached through
// SP_misc_explobox's public .die (barrel_delay) then .think (barrel_explode)
// ---------------------------------------------------------------------------

describe("barrel_explode (misc_explobox)", () => {
  function makeBarrel(index: number, dmg: number): EdictT {
    const barrel = g_edicts[index]!;
    barrel.inuse = true;
    barrel.s.origin = vec3(0, 0, 0);
    SP_misc_explobox(barrel);
    barrel.dmg = dmg;
    gi.linkentity(barrel);
    return barrel;
  }

  function detonate(barrel: EdictT, attacker: EdictT): void {
    // damage >= 90 makes barrel_delay switch straight to barrel_explode
    // (g_misc.cpp:1153-1158) instead of the delayed barrel_burn path.
    if (barrel.die === null) throw new Error("test setup: barrel.die is null");
    barrel.die(barrel, attacker, attacker, 90, vec3(0, 0, 0), { id: 0, friendly_fire: false, no_point_loss: false });
    if (barrel.think === null) throw new Error("test setup: barrel.think is null");
    barrel.think(barrel);
  }

  test("a target at the barrel's exact origin (distance 0) takes exactly self.dmg (g_misc.cpp:1123)", () => {
    setupWorld();
    const attacker = makeLiveEdict(1);
    const barrel = makeBarrel(2, 100);
    const target = makeLiveEdict(3);
    target.s.origin = vec3(0, 0, 0);
    gi.linkentity(target);
    target.takedamage = true;
    target.health = 1000;
    target.max_health = 1000;

    detonate(barrel, attacker);

    // points = damage - 0.5*dist = 100 - 0 = 100 (Math.trunc(100) = 100).
    expect(target.health).toBe(900);
  });

  test("a target beyond self.dmg + 40 (the radius argument) takes no damage at all (g_misc.cpp:1123)", () => {
    setupWorld();
    const attacker = makeLiveEdict(1);
    const barrel = makeBarrel(2, 100); // radius = 100 + 40 = 140
    const target = makeLiveEdict(3);
    target.s.origin = vec3(200, 0, 0); // well beyond radius 140
    gi.linkentity(target);
    target.takedamage = true;
    target.health = 1000;
    target.max_health = 1000;

    detonate(barrel, attacker);

    expect(target.health).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// func_clock tick formatting (g_misc.cpp:1874-1951), reached through
// SP_func_clock's public .think (func_clock_think)
// ---------------------------------------------------------------------------

describe("func_clock formatting", () => {
  function makeClockAndTarget(style: number, health: number, spawnflagsValue: number): { clock: EdictT; target: EdictT } {
    const clock = g_edicts[1]!;
    clock.inuse = true;
    clock.targetname = null;
    clock.target = "clockdisplay";
    clock.spawnflags = SpawnFlags_from(spawnflagsValue);
    clock.count = 3;
    SP_func_clock(clock);
    clock.style = style;
    clock.health = health;

    const target = g_edicts[2]!;
    target.inuse = true;
    target.targetname = "clockdisplay";
    target.use = () => {};

    return { clock, target };
  }

  test("style 0: space-padded seconds (g_misc.cpp:1876-1879)", () => {
    setupWorld();
    // TIMER_DOWN (2) so the countdown formats BEFORE self.health is
    // decremented -- avoids the TIMER_UP/DOWN threshold branch entirely.
    const { clock, target } = makeClockAndTarget(0, 5, 2);
    if (clock.think === null) throw new Error("test setup: clock.think is null");
    clock.think(clock);
    expect(target.message).toBe(" 5");
  });

  test("style 1: mm:ss with a zero-padded seconds field (g_misc.cpp:1882-1886)", () => {
    setupWorld();
    const { clock, target } = makeClockAndTarget(1, 125, 2); // 2 min 5 sec
    if (clock.think === null) throw new Error("test setup: clock.think is null");
    clock.think(clock);
    expect(target.message).toBe(" 2:05");
  });

  test("style 2: hh:mm:ss including the hour/minute rollover carry (g_misc.cpp:1888-1893)", () => {
    setupWorld();
    // 3661s = 1h 1m 1s -- crosses the 1-hour boundary, exercising the
    // (health - hours*3600)/60 carry computation.
    const { clock, target } = makeClockAndTarget(2, 3661, 2);
    if (clock.think === null) throw new Error("test setup: clock.think is null");
    clock.think(clock);
    expect(target.message).toBe(" 1:01:01");
  });

  test("TIMER_UP stops rescheduling nextthink once health > wait (g_misc.cpp:1929-1951)", () => {
    setupWorld();
    // TIMER_UP (1), count=3 -> wait=3 after func_clock_reset. health starts
    // at 0 and increments each tick; the 4th tick makes health=4 > wait=3,
    // which returns BEFORE the trailing `nextthink = level.time + 1s` line.
    const { clock } = makeClockAndTarget(0, 0, 1);
    clock.count = 3;
    clock.wait = 3;
    clock.health = 0;
    const sentinel = Gtime_from_ms(999999);
    for (let i = 0; i < 3; i++) {
      clock.nextthink = sentinel;
      if (clock.think === null) throw new Error("test setup: clock.think is null");
      clock.think(clock);
      // ticks 1-3 (health ends at 1,2,3; none > wait=3 yet) DO reschedule.
      expect(clock.nextthink).not.toBe(sentinel);
    }
    clock.nextthink = sentinel;
    if (clock.think === null) throw new Error("test setup: clock.think is null");
    clock.think(clock); // 4th tick: health becomes 4, 4 > wait(3) -> early return
    expect(clock.nextthink).toBe(sentinel);
    expect(clock.health).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// teleporter_touch (g_misc.cpp:1998-2061), reached through the trigger
// SP_misc_teleporter spawns and wires with .touch = teleporter_touch
// ---------------------------------------------------------------------------

describe("teleporter_touch", () => {
  function findTrig(owner: EdictT): EdictT {
    const trig = g_edicts.find((e) => e.owner === owner && e.touch !== null);
    if (trig === undefined) throw new Error("test setup: SP_misc_teleporter did not spawn its trigger");
    return trig;
  }

  test("relocates the player to dest + 10 on Z; old_origin does NOT get the +10 (g_misc.cpp:2018-2020)", () => {
    setupWorld();
    const teleporter = g_edicts[1]!;
    teleporter.inuse = true;
    teleporter.s.origin = vec3(0, 0, 0);
    teleporter.target = "dest_a";
    SP_misc_teleporter(teleporter);
    const trig = findTrig(teleporter);

    const dest = g_edicts[2]!;
    dest.inuse = true;
    dest.targetname = "dest_a";
    dest.s.origin = vec3(100, 200, 300);
    dest.s.angles = vec3(0, 90, 0);

    const player = makePlayerEdict(3);

    if (trig.touch === null) throw new Error("test setup: trig.touch is null");
    trig.touch(trig, player, noHitTrace(player.s.origin), false);

    expect(player.s.origin[0]).toBe(100);
    expect(player.s.origin[1]).toBe(200);
    expect(player.s.origin[2]).toBe(310); // +10
    expect(player.s.old_origin[0]).toBe(100);
    expect(player.s.old_origin[1]).toBe(200);
    expect(player.s.old_origin[2]).toBe(300); // no +10
  });

  test("resets player state: velocity zeroed, pm_time=160, PMF_TIME_TELEPORT set (g_misc.cpp:2022-2025)", () => {
    setupWorld();
    const teleporter = g_edicts[1]!;
    teleporter.inuse = true;
    teleporter.s.origin = vec3(0, 0, 0);
    teleporter.target = "dest_b";
    SP_misc_teleporter(teleporter);
    const trig = findTrig(teleporter);

    const dest = g_edicts[2]!;
    dest.inuse = true;
    dest.targetname = "dest_b";
    dest.s.origin = vec3(0, 0, 0);

    const player = makePlayerEdict(3);
    player.velocity = vec3(50, 50, 50);
    if (player.client === null) throw new Error("test setup: player.client is null");
    player.client.ps.pmove.pm_time = 0;
    player.client.ps.pmove.pm_flags = 0;

    if (trig.touch === null) throw new Error("test setup: trig.touch is null");
    trig.touch(trig, player, noHitTrace(player.s.origin), false);

    expect(player.velocity[0]).toBe(0);
    expect(player.velocity[1]).toBe(0);
    expect(player.velocity[2]).toBe(0);
    expect(player.client.ps.pmove.pm_time).toBe(160);
    expect((player.client.ps.pmove.pm_flags & PmflagsT.PMF_TIME_TELEPORT) !== 0).toBe(true);
  });

  test("no destination found: prints a message and changes nothing (g_misc.cpp:2004-2009)", () => {
    setupWorld();
    const teleporter = g_edicts[1]!;
    teleporter.inuse = true;
    teleporter.s.origin = vec3(0, 0, 0);
    teleporter.target = "nonexistent_dest";
    SP_misc_teleporter(teleporter);
    const trig = findTrig(teleporter);

    const player = makePlayerEdict(3);
    const originalOrigin = vec3(player.s.origin[0], player.s.origin[1], player.s.origin[2]);

    if (trig.touch === null) throw new Error("test setup: trig.touch is null");
    trig.touch(trig, player, noHitTrace(player.s.origin), false);

    expect(rec.comPrints).toContain("Couldn't find destination\n");
    expect(player.s.origin[0]).toBe(originalOrigin[0]);
    expect(player.s.origin[1]).toBe(originalOrigin[1]);
    expect(player.s.origin[2]).toBe(originalOrigin[2]);
  });
});

// ---------------------------------------------------------------------------
// areaportal open/close toggling via gi.SetAreaPortalState (g_misc.cpp:13-17)
// ---------------------------------------------------------------------------

describe("Use_Areaportal (func_areaportal)", () => {
  test("first use opens the portal (count 0 -> 1, SetAreaPortalState(style, true))", () => {
    setupWorld();
    const ent = g_edicts[1]!;
    ent.inuse = true;
    ent.style = 7;
    SP_func_areaportal(ent);
    expect(ent.count).toBe(0);

    if (ent.use === null) throw new Error("test setup: ent.use is null");
    ent.use(ent, null, null);

    expect(ent.count).toBe(1);
    expect(rec.areaPortalCalls).toEqual([{ portalnum: 7, open: true }]);
  });

  test("second use closes the portal (count 1 -> 0, SetAreaPortalState(style, false))", () => {
    setupWorld();
    const ent = g_edicts[1]!;
    ent.inuse = true;
    ent.style = 7;
    SP_func_areaportal(ent);
    if (ent.use === null) throw new Error("test setup: ent.use is null");
    ent.use(ent, null, null); // open

    ent.use(ent, null, null); // close

    expect(ent.count).toBe(0);
    expect(rec.areaPortalCalls).toEqual([
      { portalnum: 7, open: true },
      { portalnum: 7, open: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// debris spawn count capping (g_misc.cpp:938-955), reached through
// SP_func_explosive's public .die (func_explosive_explode)
// ---------------------------------------------------------------------------

describe("func_explosive_explode debris count capping", () => {
  function makeExplosive(index: number, mass: number): EdictT {
    const self = g_edicts[index]!;
    self.inuse = true;
    self.s.origin = vec3(0, 0, 0);
    self.mins = vec3(-8, -8, -8);
    self.maxs = vec3(8, 8, 8);
    self.targetname = null; // SP_func_explosive's plain (no targetname) path
    self.model = null; // skip gi.setmodel entirely (no real BSP model needed)
    self.spawnflags = SpawnFlags_from(0); // no TRIGGER_SPAWN/INACTIVE/ANIMATED flags
    SP_func_explosive(self);
    self.mass = mass;
    self.dmg = 0; // skip T_RadiusDamage/BecomeExplosion1, isolate gib counting
    gi.linkentity(self);
    return self;
  }

  test("mass=800 caps big chunks (debris1) at 8 and small chunks (debris2) at 16 (g_misc.cpp:938-955)", () => {
    setupWorld();
    const attacker = makeLiveEdict(1);
    const self = makeExplosive(2, 800);
    const debris1Index = gi.modelindex("models/objects/debris1/tris.md2");
    const debris2Index = gi.modelindex("models/objects/debris2/tris.md2");

    if (self.die === null) throw new Error("test setup: self.die is null");
    self.die(self, attacker, attacker, self.health, vec3(0, 0, 0), { id: 0, friendly_fire: false, no_point_loss: false });

    // mass=800 -> big: min(800/100, 8) = 8; small: min(800/25, 16) = 16.
    expect(countGibsWithModel(debris1Index)).toBe(8);
    expect(countGibsWithModel(debris2Index)).toBe(16);
  });

  test("mass=75 (uncapped default): 0 big chunks (mass<100), 3 small chunks (g_misc.cpp:939,950)", () => {
    setupWorld();
    const attacker = makeLiveEdict(1);
    const self = makeExplosive(2, 0); // self.mass stays 0 -> defaults to 75 inside func_explosive_explode
    const debris1Index = gi.modelindex("models/objects/debris1/tris.md2");
    const debris2Index = gi.modelindex("models/objects/debris2/tris.md2");

    if (self.die === null) throw new Error("test setup: self.die is null");
    self.die(self, attacker, attacker, self.health, vec3(0, 0, 0), { id: 0, friendly_fire: false, no_point_loss: false });

    // mass defaults to 75 (self.mass=0 -> `if (!mass) mass = 75`).
    // big chunks: 75 >= 100? no -> 0 thrown at all.
    // small chunks: floor(75/25) = 3, well under the 16 cap.
    expect(countGibsWithModel(debris1Index)).toBe(0);
    expect(countGibsWithModel(debris2Index)).toBe(3);
  });
});
