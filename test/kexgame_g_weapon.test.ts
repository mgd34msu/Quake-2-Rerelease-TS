/*
Unit tests for the kex g_weapon.cpp port (src/kexgame/g_weapon.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled after test/kexgame_g_trigger_target.test.ts's
own "fake-imports fixture" style, but `gi.trace`'s mock is a per-CONTENTS-MASK
sequence dispatcher (`makeMaskSequencedTrace`) instead of one static
`traceBox.current` value -- several functions under test (fire_lead,
fire_rail, bfg_think) issue MULTIPLE gi.trace calls per invocation with
DIFFERENT masks for genuinely different purposes (a "seed" trace to satisfy
PierceArgsT's TS-required initial value vs. the real pierce_trace loop vs.
CanDamage's own internal line-of-sight checks), and dispatching by mask
lets each purpose get its own deterministic canned response without being
sensitive to incidental call-count/ordering noise from code this file
doesn't otherwise care about (e.g. CanDamage's up to 5 internal MASK_SOLID
traces, which every test here wants to just report "clear line").

Every `self`/shooter fixture in this file has `client: null` (a
monster-shaped shooter) specifically so `G_ShouldPlayersCollide`/
`PlayerNoise` (both real, unported cross-dep throwing stubs in
g_weapon.ts -- see that file's own header) are never reached: their guard
conditions are all `if (self.client !== null) ...`/`if (owner.client !==
null) ...`, which short-circuit before the stub for a monster shooter. This
mirrors every real monster_fire_* call path in g_monster.ts.

Scope (20 cases, each cited against
~/Projects/quake2-rerelease-dll/rerelease/g_weapon.cpp):
  - fire_hit: range check, direct hit on a non-monster/non-client (returns
    false despite applying damage -- a literal quirk of the shipped source,
    g_weapon.cpp:70-71), and direct hit + knockback on a monster (returns
    true).
  - fire_bullet: deterministic spread-cone math from a fixed Math.random
    (g_weapon.cpp:283-291), and fire_lead's water-redirection branch
    (g_weapon.cpp:148-200) including the mask retrace and the
    TE_SPLASH/TE_BUBBLETRAIL writes.
  - fire_shotgun: fires exactly `count` fire_lead pellets (g_weapon.cpp:342-343).
  - fire_blaster + blaster_touch: spawn fields (speed/effect/owner/dmg/
    classname/style), direct-damage touch, and the
    TE_BLASTER/TE_BLUEHYPERBLASTER selection by `self.style`
    (g_weapon.cpp:353-418).
  - fire_grenade: monster vs. non-monster arming (Grenade_Explode+
    EF_GRENADE_LIGHT vs. Grenade4_Think+RF_MINLIGHT timestamp,
    g_weapon.cpp:537-593); fire_grenade2's immediate-explode-at-timer<=0
    and HELD spawnflag OR (g_weapon.cpp:595-644); Grenade_Touch's
    bounce-vs-explode branch (g_weapon.cpp:485-514).
  - fire_rocket + rocket_touch: spawn fields, and the direct-hit-vs-radius
    damage split via T_RadiusDamage's own `ignore` parameter
    (g_weapon.cpp:651-732).
  - fire_rail: pierces through a living, pierceable monster but stops at a
    solid wall, restoring the monster's solidity by the time fire_rail
    returns (the `pierce_args_t` destructor-at-scope-exit emulation --
    g_weapon.cpp:764-875); GetUnicastKey's monotonic per-call sequence
    (g_weapon.cpp:820-828).
  - fire_bfg + bfg_touch + bfg_explode + bfg_think: the touch-to-explode
    transition and its direct + radius damage (g_weapon.cpp:989-1025);
    bfg_explode's frame-0 radius effect (g_weapon.cpp:933-987); bfg_think's
    per-findradius-iteration laser targeting AND per-iteration
    `restorePierce` (not once-after-the-whole-loop -- g_weapon.cpp:1070-1138).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3, AngleVectors } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import {
  ContentsT,
  EffectsT,
  GAME_API_VERSION,
  KexTempEventT,
  MASK_OPAQUE,
  MASK_PROJECTILE,
  MASK_SOLID,
  MASK_WATER,
  ServerCommandT,
  SolidT,
  SvflagsT,
} from "../src/kexapi/game";
import { type EdictT, DamageflagsT, EntFlagsT, type ModT, ModIdT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_ms, Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { SpawnFlags_from, SpawnFlags_has } from "../src/kexgame/spawnflags";
import { vectoangles } from "../src/kexgame/q_vec3";
import {
  fire_hit,
  fire_bullet,
  fire_shotgun,
  fire_blaster,
  blaster_touch,
  fire_grenade,
  fire_grenade2,
  Grenade_Touch,
  Grenade_Explode,
  Grenade4_Think,
  fire_rocket,
  rocket_touch,
  fire_rail,
  GetUnicastKey,
  fire_bfg,
  bfg_touch,
  bfg_explode,
  bfg_think,
} from "../src/kexgame/g_weapon";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (see file header)
// ---------------------------------------------------------------------------

interface TraceCall {
  start: Vec3;
  end: Vec3;
  mask: ContentsT;
}

interface Recorder {
  comPrints: string[];
  writeBytes: number[];
  traceCalls: TraceCall[];
  linked: EdictT[];
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { comPrints: [], writeBytes: [], traceCalls: [], linked: [], cvars: new Map() };
}

/** The last TE_* byte written after the most recent svc_temp_entity marker, if any. */
function lastTempEntity(rec: Recorder): number | undefined {
  for (let i = rec.writeBytes.length - 1; i >= 0; i--) {
    if (rec.writeBytes[i] === ServerCommandT.svc_temp_entity) return rec.writeBytes[i + 1];
  }
  return undefined;
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

type TraceFn = (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: ContentsT) => KexTraceT;

function makeTraceBox(): { fn: TraceFn } {
  return { fn: () => missTrace };
}

/**
 * Dispatches by CONTENTS mask: each mask key gets its own FIFO sequence of
 * canned traces (consumed one per call to that mask), falling back to
 * `fallback` once a mask's sequence is exhausted or was never given one.
 * See file header for why mask-based dispatch (not raw call order) is the
 * robust choice here.
 */
function makeMaskSequencedTrace(sequences: Map<number, KexTraceT[]>, fallback: KexTraceT): TraceFn {
  const cursors = new Map<number, number>();
  return (_start, _mins, _maxs, _end, _passent, mask) => {
    const seq = sequences.get(mask);
    if (seq === undefined) return fallback;
    const i = cursors.get(mask) ?? 0;
    cursors.set(mask, i + 1);
    return seq[i] ?? fallback;
  };
}

function makeFakeGameImports(rec: Recorder, traceBox: { fn: TraceFn }, pointContentsBox: { value: ContentsT }): KexGameImports {
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
      return 1;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(start, mins, maxs, end, passent, mask) {
      rec.traceCalls.push({ start: vec3(start[0], start[1], start[2]), end: vec3(end[0], end[1], end[2]), mask });
      return traceBox.fn(start, mins, maxs, end, passent, mask);
    },
    clip() {
      return missTrace;
    },
    pointcontents() {
      return pointContentsBox.value;
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

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level for one test. */
function setupWorld(maxentities: number, numEdicts: number): { edicts: EdictT[]; rec: Recorder; traceBox: { fn: TraceFn }; pointContentsBox: { value: ContentsT } } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = 0; // no players -- see file header's "active_players() yields nothing" note
  game.maxentities = maxentities;
  level.time = GTIME_ZERO;
  level.gravity = 800; // g_weapon.cpp's own gravityAdjustment divisor: normal gravity => adjustment of 1.0

  const rec = makeRecorder();
  const traceBox = makeTraceBox();
  const pointContentsBox = { value: ContentsT.CONTENTS_NONE as ContentsT };
  SetGameImports(makeFakeGameImports(rec, traceBox, pointContentsBox));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));
  globals.num_edicts = numEdicts;

  return { edicts, rec, traceBox, pointContentsBox };
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };

// ---------------------------------------------------------------------------
// fire_hit (g_weapon.cpp:12-81)
// ---------------------------------------------------------------------------

describe("fire_hit", () => {
  test("out of range: returns false and never damages the enemy", () => {
    const { edicts } = setupWorld(4, 4);
    const self = edicts[0]!;
    const enemy = edicts[1]!;
    self.enemy = enemy;
    self.s.origin = vec3(0, 0, 0);
    enemy.s.origin = vec3(1000, 0, 0);
    enemy.absmin = vec3(995, -5, -5);
    enemy.absmax = vec3(1005, 5, 5);
    enemy.takedamage = true;
    enemy.health = 100;

    const result = fire_hit(self, vec3(10, 0, 0), 20, 8); // aim[0]=10 -- far smaller than the real distance

    expect(result).toBe(false);
    expect(enemy.health).toBe(100);
  });

  test("direct hit on a non-monster/non-client target applies damage but still returns false (g_weapon.cpp:70-71 quirk)", () => {
    const { edicts, traceBox } = setupWorld(4, 4);
    const self = edicts[0]!;
    const enemy = edicts[1]!;
    self.enemy = enemy;
    self.s.origin = vec3(0, 0, 0);
    self.mins = vec3(-16, -16, -16);
    self.maxs = vec3(16, 16, 16);
    enemy.s.origin = vec3(20, 0, 0);
    enemy.absmin = vec3(10, -10, -10);
    enemy.absmax = vec3(30, 10, 10);
    enemy.mins = vec3(-10, -10, -10);
    enemy.maxs = vec3(10, 10, 10);
    enemy.takedamage = true;
    enemy.health = 100;
    // enemy.svflags has no SVF_MONSTER, enemy.client stays null

    traceBox.fn = () => ({ ...missTrace, fraction: 0.9, ent: enemy });

    const result = fire_hit(self, vec3(30, 0, 0), 20, 8);

    expect(enemy.health).toBe(80); // T_Damage applied
    expect(result).toBe(false); // g_weapon.cpp:70-71: only true for SVF_MONSTER/client hits
  });

  test("direct hit on a monster applies damage, returns true, and knocks it back", () => {
    const { edicts, traceBox } = setupWorld(4, 4);
    const self = edicts[0]!;
    const enemy = edicts[1]!;
    self.enemy = enemy;
    self.s.origin = vec3(0, 0, 0);
    self.mins = vec3(-16, -16, -16);
    self.maxs = vec3(16, 16, 16);
    enemy.s.origin = vec3(20, 0, 0);
    enemy.absmin = vec3(10, -10, -10);
    enemy.absmax = vec3(30, 10, 10);
    enemy.mins = vec3(-10, -10, -10);
    enemy.maxs = vec3(10, 10, 10);
    enemy.takedamage = true;
    enemy.health = 100;
    enemy.svflags |= SvflagsT.SVF_MONSTER;

    traceBox.fn = () => ({ ...missTrace, fraction: 0.9, ent: enemy });

    const result = fire_hit(self, vec3(30, 0, 0), 20, 8);

    expect(enemy.health).toBe(80);
    expect(result).toBe(true);
    // knockback pushes the enemy AWAY from the aim point -- some nonzero velocity results
    expect(enemy.velocity[0] !== 0 || enemy.velocity[1] !== 0 || enemy.velocity[2] !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fire_bullet / fire_lead (g_weapon.cpp:113-331)
// ---------------------------------------------------------------------------

describe("fire_bullet / fire_lead", () => {
  test("computes a deterministic spread-cone end position from a fixed Math.random", () => {
    const { edicts, rec } = setupWorld(2, 2);
    const self = edicts[0]!;
    self.s.origin = vec3(0, 0, 0);

    const realRandom = Math.random;
    Math.random = () => 0.75; // crandom() = 0.75*2-1 = 0.5, every call

    const start = vec3(0, 0, 0);
    const aimdir = vec3(1, 0, 0);
    const hspread = 200;
    const vspread = 100;

    fire_bullet(self, start, aimdir, 10, 4, hspread, vspread, MOD_UNKNOWN);

    Math.random = realRandom;

    // g_weapon.cpp:283-291: end = start + forward*8192 + right*r + up*u,
    // r = crandom()*hspread, u = crandom()*vspread -- both 0.5*spread here.
    const dirAngles = vectoangles(aimdir);
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(dirAngles, forward, right, up);
    const r = 0.5 * hspread;
    const u = 0.5 * vspread;
    const expectedEnd = vec3(start[0] + forward[0] * 8192 + right[0] * r + up[0] * u, start[1] + forward[1] * 8192 + right[1] * r + up[1] * u, start[2] + forward[2] * 8192 + right[2] * r + up[2] * u);

    // 3 gi.trace calls total: the PierceArgsT "seed" trace (a TS-only
    // artifact needed to give `pierce.tr` an initial value -- see
    // g_weapon.ts's own header note on this), then the self.origin->start
    // "clear shot" check (also misses), then the real bullet trace.
    expect(rec.traceCalls.length).toBe(3);
    const realTraceCall = rec.traceCalls[2]!;
    expect(realTraceCall.end[0]).toBeCloseTo(expectedEnd[0], 3);
    expect(realTraceCall.end[1]).toBeCloseTo(expectedEnd[1], 3);
    expect(realTraceCall.end[2]).toBeCloseTo(expectedEnd[2], 3);
  });

  test("fire_shotgun fires exactly `count` fire_lead pellets", () => {
    const { edicts, rec } = setupWorld(2, 2);
    const self = edicts[0]!;
    self.s.origin = vec3(0, 0, 0);

    fire_shotgun(self, vec3(0, 0, 0), vec3(1, 0, 0), 6, 4, 500, 500, 5, MOD_UNKNOWN);

    // each pellet's fire_lead does 3 gi.trace calls when both miss (the
    // PierceArgsT seed trace, the clear-shot check, then the real trace)
    // -- g_weapon.cpp:340-343
    expect(rec.traceCalls.length).toBe(5 * 3);
  });

  test("redirects trajectory on entering water, retraces with MASK_WATER cleared, and writes TE_SPLASH + TE_BUBBLETRAIL", () => {
    const { edicts, rec, traceBox } = setupWorld(3, 3);
    const self = edicts[0]!;
    const waterMarker = edicts[1]!;
    self.s.origin = vec3(0, 0, 0);

    let n = 0;
    traceBox.fn = () => {
      n++;
      if (n === 1) return missTrace; // clear-shot check: self.origin -> start
      if (n === 2) {
        // the real bullet trace hits water partway through
        return {
          ...missTrace,
          fraction: 0.5,
          ent: waterMarker,
          endpos: vec3(50, 0, 0),
          contents: ContentsT.CONTENTS_WATER,
        };
      }
      return missTrace; // final retrace (mask minus MASK_WATER) misses -> pierce_trace stops
    };

    fire_bullet(self, vec3(0, 0, 0), vec3(1, 0, 0), 10, 4, 50, 50, MOD_UNKNOWN);

    expect(lastTempEntity(rec)).not.toBe(KexTempEventT.TE_SPLASH); // last TE is the bubbletrail, not the splash
    expect(rec.writeBytes.includes(KexTempEventT.TE_SPLASH)).toBe(true);
    expect(rec.writeBytes.includes(KexTempEventT.TE_BUBBLETRAIL)).toBe(true);

    // the retrace after the water hit must have MASK_WATER cleared (g_weapon.cpp:198)
    const retraceCall = rec.traceCalls[2]!;
    expect((retraceCall.mask & MASK_WATER) === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fire_blaster / blaster_touch (g_weapon.cpp:353-418)
// ---------------------------------------------------------------------------

describe("fire_blaster / blaster_touch", () => {
  test("spawns a projectile with speed/effect/owner/dmg/classname/style set", () => {
    const { edicts, rec } = setupWorld(4, 4);
    const self = edicts[0]!;
    self.s.origin = vec3(0, 0, 0);

    fire_blaster(self, vec3(0, 0, 0), vec3(1, 0, 0), 15, 600, EffectsT.EF_BLASTER, { id: ModIdT.MOD_BLASTER, friendly_fire: false, no_point_loss: false });

    const bolt = rec.linked.at(-1)!;
    expect(bolt.velocity[0]).toBeCloseTo(600, 3);
    expect(bolt.dmg).toBe(15);
    expect(bolt.owner).toBe(self);
    expect(bolt.classname).toBe("bolt");
    expect(bolt.style).toBe(ModIdT.MOD_BLASTER);
    expect(bolt.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
    expect((bolt.s.effects & EffectsT.EF_BLASTER) !== 0n).toBe(true);
    expect(bolt.touch).toBe(blaster_touch);
  });

  test("blaster_touch applies energy damage to a takedamage target and frees the bolt", () => {
    // G_FreeEdict (g_utils.ts) no-ops on any index <= game.maxclients +
    // BODY_QUEUE_SIZE (the "special edict" guard) -- indices comfortably
    // past that reserved range are used here so the free actually happens.
    const { edicts } = setupWorld(16, 16);
    const owner = edicts[9]!;
    const bolt = edicts[10]!;
    const victim = edicts[11]!;
    bolt.owner = owner;
    bolt.dmg = 15;
    bolt.style = ModIdT.MOD_BLASTER;
    bolt.inuse = true;
    bolt.s.origin = vec3(0, 0, 0);
    bolt.velocity = vec3(600, 0, 0);
    victim.takedamage = true;
    victim.health = 100;

    const tr: KexTraceT = { ...missTrace, fraction: 0.5, plane: new CplaneT() };
    blaster_touch(bolt, victim, tr, false);

    expect(victim.health).toBe(85);
    expect(bolt.inuse).toBe(false); // G_FreeEdict
  });

  test("selects TE_BLUEHYPERBLASTER over TE_BLASTER when self.style is MOD_BLUEBLASTER, on a non-takedamage touch", () => {
    const { edicts, rec } = setupWorld(4, 4);
    const owner = edicts[0]!;
    const bolt = edicts[1]!;
    const wall = edicts[2]!;
    bolt.owner = owner;
    bolt.style = ModIdT.MOD_BLUEBLASTER;
    bolt.inuse = true;
    bolt.s.origin = vec3(0, 0, 0);
    wall.takedamage = false;

    const tr: KexTraceT = { ...missTrace, fraction: 0.5, plane: new CplaneT() };
    blaster_touch(bolt, wall, tr, false);

    expect(lastTempEntity(rec)).toBe(KexTempEventT.TE_BLUEHYPERBLASTER);
  });
});

// ---------------------------------------------------------------------------
// fire_grenade / fire_grenade2 / Grenade_Touch (g_weapon.cpp:428-644)
// ---------------------------------------------------------------------------

describe("fire_grenade / fire_grenade2 / Grenade_Touch", () => {
  test("monster-thrown grenade arms with Grenade_Explode + EF_GRENADE_LIGHT and a randomized tumble", () => {
    const { edicts, rec } = setupWorld(4, 4);
    const self = edicts[0]!;
    level.time = Gtime_from_ms(1000);
    const timer = Gtime_from_sec(2.5);

    fire_grenade(self, vec3(0, 0, 0), vec3(1, 0, 0), 40, 600, timer, 80, 0, 0, true);

    const grenade = rec.linked.at(-1)!;
    expect(grenade.think).toBe(Grenade_Explode);
    expect(grenade.nextthink).toBe(Gtime_add(level.time, timer));
    expect((grenade.s.effects & EffectsT.EF_GRENADE_LIGHT) !== 0n).toBe(true);
    expect(grenade.avelocity[0] !== 0 || grenade.avelocity[1] !== 0 || grenade.avelocity[2] !== 0).toBe(true);
    expect(grenade.owner).toBe(self);
    expect(grenade.dmg).toBe(40);
  });

  test("non-monster (player-thrown-shape) grenade arms with Grenade4_Think + RF_MINLIGHT and a timestamp deadline", () => {
    const { edicts, rec } = setupWorld(4, 4);
    const self = edicts[0]!;
    level.time = Gtime_from_ms(1000);
    const timer = Gtime_from_sec(2.5);

    fire_grenade(self, vec3(0, 0, 0), vec3(1, 0, 0), 40, 600, timer, 80, 0, 0, false);

    const grenade = rec.linked.at(-1)!;
    expect(grenade.think).toBe(Grenade4_Think);
    expect(grenade.timestamp).toBe(Gtime_add(level.time, timer));
    // nextthink is a per-frame tick, NOT the arming timer, for the non-monster path
    expect(grenade.nextthink).not.toBe(Gtime_add(level.time, timer));
  });

  test("fire_grenade2 explodes immediately when timer <= 0, without ever linking the entity", () => {
    const { edicts, rec } = setupWorld(16, 16);
    const self = edicts[9]!;
    self.s.origin = vec3(0, 0, 0);

    const nearby = edicts[10]!;
    nearby.inuse = true;
    nearby.takedamage = true;
    nearby.health = 200;
    nearby.solid = SolidT.SOLID_BBOX;
    nearby.s.origin = vec3(10, 0, 0); // well within the 80-unit dmg_radius

    fire_grenade2(self, vec3(0, 0, 0), vec3(1, 0, 0), 40, 600, GTIME_ZERO, 80, false);

    // g_weapon.cpp:637-638: `if (timer <= 0_ms) Grenade_Explode(grenade);`
    // runs synchronously, BEFORE `gi.linkentity` is ever reached (the
    // linkentity call is only on the `else` branch) -- verified two ways:
    // no entity was ever linked, and the explosion's own T_RadiusDamage
    // already landed on a nearby entity.
    expect(rec.linked.length).toBe(0);
    expect(nearby.health).toBeLessThan(200);
  });

  test("fire_grenade2(held=true) ORs SPAWNFLAG_GRENADE_HELD onto SPAWNFLAG_GRENADE_HAND", () => {
    const { edicts, rec } = setupWorld(4, 4);
    const self = edicts[0]!;

    fire_grenade2(self, vec3(0, 0, 0), vec3(1, 0, 0), 40, 600, Gtime_from_sec(3), 80, true);

    const grenade = rec.linked.at(-1)!;
    expect(SpawnFlags_has(grenade.spawnflags, SpawnFlags_from(1))).toBe(true); // HAND
    expect(SpawnFlags_has(grenade.spawnflags, SpawnFlags_from(2))).toBe(true); // HELD
  });

  test("Grenade_Touch bounces off a non-takedamage surface without exploding, but explodes on a takedamage hit", () => {
    // see the blaster_touch test above for why indices > BODY_QUEUE_SIZE
    // are needed here (G_FreeEdict's "special edict" guard).
    const { edicts } = setupWorld(16, 16);
    const grenade = edicts[10]!;
    const owner = edicts[9]!;
    const wall = edicts[11]!;
    const victim = edicts[12]!;
    grenade.owner = owner;
    grenade.inuse = true;
    grenade.dmg = 40;
    grenade.dmg_radius = 80;
    grenade.s.origin = vec3(0, 0, 0);
    wall.takedamage = false;

    const tr: KexTraceT = { ...missTrace, fraction: 0.5, plane: new CplaneT() };
    Grenade_Touch(grenade, wall, tr, false);
    expect(grenade.inuse).toBe(true); // still alive -- just bounced

    victim.takedamage = true;
    victim.health = 100;
    Grenade_Touch(grenade, victim, tr, false);
    // NOTE: can't assert `grenade.enemy === victim` here -- Grenade_Explode
    // (reached via Grenade_Touch's `ent.enemy = other;` assignment) ends by
    // calling G_FreeEdict, which resets EVERY field on the entity (a real
    // `memset(ed, 0, sizeof(*ed))` equivalent, see g_utils.ts's own
    // G_FreeEdict) -- `.enemy` is wiped back to null by the time control
    // returns here. `victim.health` dropping and `grenade.inuse` flipping
    // to false are what's actually observable post-explosion.
    expect(victim.health).toBeLessThan(100); // direct-hit damage, g_weapon.cpp:437-452
    expect(grenade.inuse).toBe(false); // Grenade_Explode fired and freed it
  });
});

// ---------------------------------------------------------------------------
// fire_rocket / rocket_touch (g_weapon.cpp:651-732)
// ---------------------------------------------------------------------------

describe("fire_rocket / rocket_touch", () => {
  test("spawns with EF_ROCKET/MOVETYPE_FLYMISSILE and the dmg/radius_dmg/dmg_radius fields set", () => {
    const { edicts, rec } = setupWorld(4, 4);
    const self = edicts[0]!;

    const rocket = fire_rocket(self, vec3(0, 0, 0), vec3(1, 0, 0), 100, 650, 120, 100);

    expect(rocket).toBe(rec.linked.at(-1)!);
    expect(rocket.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
    expect((rocket.s.effects & EffectsT.EF_ROCKET) !== 0n).toBe(true);
    expect(rocket.dmg).toBe(100);
    expect(rocket.radius_dmg).toBe(100);
    expect(rocket.dmg_radius).toBe(120);
    expect(rocket.owner).toBe(self);
  });

  test("rocket_touch applies full direct damage to the touched entity and separate radius damage to a nearby entity", () => {
    const { edicts } = setupWorld(4, 4);
    const rocket = edicts[0]!;
    const owner = edicts[1]!;
    const touched = edicts[2]!;
    const nearby = edicts[3]!;

    rocket.owner = owner;
    rocket.inuse = true;
    rocket.dmg = 100;
    rocket.radius_dmg = 120;
    rocket.dmg_radius = 200;
    rocket.s.origin = vec3(0, 0, 0);
    rocket.velocity = vec3(650, 0, 0);

    touched.takedamage = true;
    touched.health = 200;
    touched.s.origin = vec3(0, 0, 0);

    nearby.takedamage = true;
    nearby.health = 200;
    nearby.inuse = true;
    nearby.solid = SolidT.SOLID_BBOX;
    nearby.s.origin = vec3(50, 0, 0); // 50 units from the rocket's origin

    const tr: KexTraceT = { ...missTrace, fraction: 0.5, plane: new CplaneT() };
    rocket_touch(rocket, touched, tr, false);

    expect(touched.health).toBe(100); // direct hit: flat -dmg (g_weapon.cpp:672)
    // radius damage: points = radius_dmg - 0.5*dist = 120 - 0.5*50 = 95
    expect(nearby.health).toBe(200 - 95);
  });
});

// ---------------------------------------------------------------------------
// fire_rail (g_weapon.cpp:764-875) / GetUnicastKey (g_weapon.cpp:820-828)
// ---------------------------------------------------------------------------

describe("fire_rail", () => {
  const RAIL_MASK = MASK_PROJECTILE | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA;

  test("pierces through a living, pierceable monster but stops at a solid wall, restoring the monster's solidity afterward", () => {
    const { edicts, traceBox } = setupWorld(4, 4);
    const self = edicts[0]!;
    const monster = edicts[1]!;
    const wall = edicts[2]!;

    self.s.origin = vec3(0, 0, 0);

    monster.inuse = true;
    monster.takedamage = true;
    monster.health = 100;
    monster.svflags |= SvflagsT.SVF_MONSTER;
    monster.solid = SolidT.SOLID_BBOX;

    wall.inuse = true;
    wall.takedamage = false;
    wall.solid = SolidT.SOLID_BSP;

    traceBox.fn = makeMaskSequencedTrace(
      new Map([
        [
          RAIL_MASK,
          [
            { ...missTrace, fraction: 0.3, ent: monster, endpos: vec3(30, 0, 0) }, // pierces through
            { ...missTrace, fraction: 0.9, ent: wall, endpos: vec3(90, 0, 0) }, // stops here
          ],
        ],
      ]),
      missTrace,
    );

    fire_rail(self, vec3(0, 0, 0), vec3(1, 0, 0), 50, 0);

    expect(monster.health).toBe(50); // took the rail's damage
    expect(wall.health).toBe(0); // wall isn't takedamage, T_Damage no-ops
    // pierce_args_t's destructor-at-scope-exit restore: the monster's
    // solidity must be back to its original value by the time fire_rail
    // returns, even though markPierce() temporarily set it to SOLID_NOT
    // mid-trace (g_weapon.cpp:764-817's own header note in g_weapon.ts).
    expect(monster.solid).toBe(SolidT.SOLID_BBOX);
  });

  test("GetUnicastKey returns a monotonically increasing sequence starting wherever the module counter currently is", () => {
    const a = GetUnicastKey();
    const b = GetUnicastKey();
    const c = GetUnicastKey();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });
});

// ---------------------------------------------------------------------------
// fire_bfg / bfg_touch / bfg_explode / bfg_think (g_weapon.cpp:877-1172)
// ---------------------------------------------------------------------------

describe("fire_bfg / bfg_touch / bfg_explode / bfg_think", () => {
  test("bfg_touch applies core-explosion direct damage and switches to the lingering explosion sprite", () => {
    const { edicts } = setupWorld(4, 4);
    const bfg = edicts[0]!;
    const owner = edicts[1]!;
    const victim = edicts[2]!;

    bfg.owner = owner;
    bfg.inuse = true;
    bfg.s.origin = vec3(0, 0, 0);
    bfg.velocity = vec3(400, 0, 0);
    victim.takedamage = true;
    victim.health = 500;

    const tr: KexTraceT = { ...missTrace, fraction: 0.5, plane: new CplaneT() };
    bfg_touch(bfg, victim, tr, false);

    expect(victim.health).toBe(300); // 200 direct damage, g_weapon.cpp:1005
    expect(bfg.solid).toBe(SolidT.SOLID_NOT);
    expect(bfg.think).toBe(bfg_explode);
  });

  test("bfg_explode's frame-0 pass radius-damages nearby takedamage entities", () => {
    const { edicts } = setupWorld(4, 4);
    const bfg = edicts[0]!;
    const owner = edicts[1]!;
    const victim = edicts[2]!;

    bfg.owner = owner;
    bfg.inuse = true;
    bfg.s.origin = vec3(0, 0, 0);
    bfg.s.frame = 0;
    bfg.radius_dmg = 200;
    bfg.dmg_radius = 1000;

    victim.inuse = true;
    victim.takedamage = true;
    victim.health = 500;
    victim.solid = SolidT.SOLID_BBOX;
    victim.svflags |= SvflagsT.SVF_MONSTER;
    victim.s.origin = vec3(100, 0, 0);

    bfg_explode(bfg);

    expect(victim.health).toBeLessThan(500);
    expect(bfg.s.frame).toBe(1);
  });

  test("bfg_think targets a nearby damageable monster and restores its solidity after each findradius iteration", () => {
    const { edicts, rec, traceBox } = setupWorld(4, 4);
    const bfg = edicts[0]!;
    const owner = edicts[1]!;
    const monster = edicts[2]!;

    bfg.owner = owner;
    bfg.inuse = true;
    bfg.s.origin = vec3(0, 0, 0);

    monster.inuse = true;
    monster.takedamage = true;
    monster.health = 100;
    monster.svflags |= SvflagsT.SVF_MONSTER;
    monster.solid = SolidT.SOLID_BBOX;
    monster.s.origin = vec3(50, 0, 0);
    monster.absmin = vec3(40, -10, -10);
    monster.absmax = vec3(60, 10, 10);

    const LASER_MASK = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER;
    traceBox.fn = makeMaskSequencedTrace(
      new Map([
        [MASK_OPAQUE, []], // bfg_spawn_laser's own trace -- always miss (fallback), no visible beam needed
        [MASK_SOLID, []], // "blocked by world" check -- always miss/clear (fallback)
        [
          LASER_MASK,
          [
            missTrace, // the PierceArgsT seed trace -- SAME mask as the real trace here, unlike fire_rail's; unused value
            { ...missTrace, fraction: 0.5, ent: monster, endpos: vec3(50, 0, 0) }, // pierceTrace's real first call
          ],
        ],
      ]),
      missTrace,
    );

    bfg_think(bfg);

    expect(monster.health).toBeLessThan(100); // MOD_BFG_LASER damage applied
    expect(rec.writeBytes.includes(KexTempEventT.TE_BFG_LASER)).toBe(true);
    // per-iteration restorePierce -- see g_weapon.ts's own "per-iteration
    // restorePierce" quirk note: solidity must already be restored by the
    // time bfg_think returns, not left pierced for the whole loop.
    expect(monster.solid).toBe(SolidT.SOLID_BBOX);
  });
});
