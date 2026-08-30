// Ports lmctf60/g_save.c's field/save-format machinery -- NOT its InitGame
// (g_main.ts already has a documented partial InitGame from the foundation
// unit; this file does not duplicate or replace it, matching this unit's
// SCOPE: "WriteGame/ReadGame/WriteLevel/ReadLevel", not InitGame).
//
// Savegame redesign per src/ctf/g_save.ts's own header comment
// (.orch/decisions.tsv, 2026-08-29, "Savegames redesigned as JSON keyed by
// property names; function fields serialized via name registry") -- this
// file follows that exact pattern, diff-derived from src/ctf/g_save.ts.
//
// lmctf60/g_save.c's own `fields[]` diff vs quake-2/ctf/g_save.c reorders a
// few entries and appends a block of FFL_NOSPAWN save-only fields
// (goalentity/movetarget/enemy/oldenemy/activator/groundentity/teamchain/
// teammaster/owner/mynoise/mynoise2/target_ent/chain as F_EDICT, every
// think/touch/use/pain/die/monsterinfo.*/moveinfo.endfunc callback as
// F_FUNCTION, monsterinfo.currentmove as F_MMOVE) plus a duplicate `"item"`
// F_ITEM entry on the real edict field (not spawntemp). None of that
// FFL_NOSPAWN block is reachable from ED_ParseField (guarded out by the C
// source's own `!(f->flags & FFL_NOSPAWN)` check, confirmed in the diff) --
// this port's FIELDS table is spawn-time only (same design ctf's g_save.ts
// already uses), so it is unaffected: the spawn-relevant subset of
// lmctf60's fields[] is identical in content to quake-2/ctf/g_save.c's,
// just reordered. FIELDS below matches src/ctf/g_save.ts's FIELDS exactly.
// The FFL_NOSPAWN callback/edict-reference fields are instead covered by
// this file's own JSON serializer (EdictJSON), which persists every
// EdictT field by property name directly -- no field-table indirection
// needed for save/load in this port's design.

import type { Vec3 } from "../shared/math";
import {
  type CplaneT,
  type CsurfaceT,
  CVAR_ARCHIVE,
  CVAR_LATCH,
  CVAR_NOSET,
  CVAR_SERVERINFO,
  CVAR_USERINFO,
  EntityStateT,
} from "../shared/q_shared";
import { FS_ReadRawFile, FS_WriteFile } from "../qcommon/files";
import { type EdictStringKey } from "./g_utils";
import {
  ClientPersistentT,
  EdictT,
  GClientT,
  g_edicts,
  game,
  gi,
  type GItemT,
  globals,
  level,
  MmoveT,
  MonsterInfoT,
  MoveinfoT,
  type SpawnTempT,
  SetGEdicts,
} from "./g_local";
import { FindItemByClassname } from "./g_items";

// -------------------------------------------------------------------------
// field_t / fields[] -- spawn-time subset only, see file header. Content
// identical to src/ctf/g_save.ts's FIELDS (lmctf60's fields[] diff does not
// change any spawn-reachable entry).
// -------------------------------------------------------------------------

type EdictNumberKey = Exclude<
  { [K in keyof EdictT]: EdictT[K] extends number ? K : never }[keyof EdictT],
  "movetype" | "solid"
>;
type EdictVectorKey = { [K in keyof EdictT]: EdictT[K] extends Vec3 ? K : never }[keyof EdictT];
type EntityStateVectorKey = { [K in keyof EntityStateT]: EntityStateT[K] extends Vec3 ? K : never }[keyof EntityStateT];
type SpawnTempStringKey = {
  [K in keyof SpawnTempT]: SpawnTempT[K] extends string | null ? K : never;
}[keyof SpawnTempT];
type SpawnTempNumberKey = { [K in keyof SpawnTempT]: SpawnTempT[K] extends number ? K : never }[keyof SpawnTempT];
type SpawnTempVectorKey = { [K in keyof SpawnTempT]: SpawnTempT[K] extends Vec3 ? K : never }[keyof SpawnTempT];

export type FieldSpawn =
  | { key: string; type: "F_LSTRING"; target: "edict"; prop: EdictStringKey }
  | { key: string; type: "F_LSTRING"; target: "spawntemp"; prop: SpawnTempStringKey }
  | { key: string; type: "F_INT"; target: "edict"; prop: EdictNumberKey }
  | { key: string; type: "F_INT"; target: "spawntemp"; prop: SpawnTempNumberKey }
  | { key: string; type: "F_FLOAT"; target: "edict"; prop: EdictNumberKey }
  | { key: string; type: "F_FLOAT"; target: "spawntemp"; prop: SpawnTempNumberKey }
  | { key: string; type: "F_VECTOR"; target: "edict"; prop: EdictVectorKey }
  | { key: string; type: "F_VECTOR"; target: "spawntemp"; prop: SpawnTempVectorKey }
  | { key: string; type: "F_VECTOR"; target: "edict_s"; prop: EntityStateVectorKey }
  | { key: string; type: "F_ANGLEHACK"; target: "edict"; prop: EdictVectorKey }
  | { key: string; type: "F_ANGLEHACK"; target: "spawntemp"; prop: SpawnTempVectorKey }
  | { key: string; type: "F_ANGLEHACK"; target: "edict_s"; prop: EntityStateVectorKey }
  | { key: string; type: "F_IGNORE" };

export const FIELDS: FieldSpawn[] = [
  { key: "classname", type: "F_LSTRING", target: "edict", prop: "classname" },
  { key: "model", type: "F_LSTRING", target: "edict", prop: "model" },
  { key: "spawnflags", type: "F_INT", target: "edict", prop: "spawnflags" },
  { key: "speed", type: "F_FLOAT", target: "edict", prop: "speed" },
  { key: "accel", type: "F_FLOAT", target: "edict", prop: "accel" },
  { key: "decel", type: "F_FLOAT", target: "edict", prop: "decel" },
  { key: "target", type: "F_LSTRING", target: "edict", prop: "target" },
  { key: "targetname", type: "F_LSTRING", target: "edict", prop: "targetname" },
  { key: "pathtarget", type: "F_LSTRING", target: "edict", prop: "pathtarget" },
  { key: "deathtarget", type: "F_LSTRING", target: "edict", prop: "deathtarget" },
  { key: "killtarget", type: "F_LSTRING", target: "edict", prop: "killtarget" },
  { key: "combattarget", type: "F_LSTRING", target: "edict", prop: "combattarget" },
  { key: "message", type: "F_LSTRING", target: "edict", prop: "message" },
  { key: "team", type: "F_LSTRING", target: "edict", prop: "team" },
  { key: "wait", type: "F_FLOAT", target: "edict", prop: "wait" },
  { key: "delay", type: "F_FLOAT", target: "edict", prop: "delay" },
  { key: "random", type: "F_FLOAT", target: "edict", prop: "random" },
  { key: "move_origin", type: "F_VECTOR", target: "edict", prop: "move_origin" },
  { key: "move_angles", type: "F_VECTOR", target: "edict", prop: "move_angles" },
  { key: "style", type: "F_INT", target: "edict", prop: "style" },
  { key: "count", type: "F_INT", target: "edict", prop: "count" },
  { key: "health", type: "F_INT", target: "edict", prop: "health" },
  { key: "sounds", type: "F_INT", target: "edict", prop: "sounds" },
  { key: "light", type: "F_IGNORE" },
  { key: "dmg", type: "F_INT", target: "edict", prop: "dmg" },
  { key: "mass", type: "F_INT", target: "edict", prop: "mass" },
  { key: "volume", type: "F_FLOAT", target: "edict", prop: "volume" },
  { key: "attenuation", type: "F_FLOAT", target: "edict", prop: "attenuation" },
  { key: "map", type: "F_LSTRING", target: "edict", prop: "map" },
  { key: "origin", type: "F_VECTOR", target: "edict_s", prop: "origin" },
  { key: "angles", type: "F_VECTOR", target: "edict_s", prop: "angles" },
  { key: "angle", type: "F_ANGLEHACK", target: "edict_s", prop: "angles" },

  // temp spawn vars -- only valid when the spawn function is called
  { key: "lip", type: "F_INT", target: "spawntemp", prop: "lip" },
  { key: "distance", type: "F_INT", target: "spawntemp", prop: "distance" },
  { key: "height", type: "F_INT", target: "spawntemp", prop: "height" },
  { key: "noise", type: "F_LSTRING", target: "spawntemp", prop: "noise" },
  { key: "pausetime", type: "F_FLOAT", target: "spawntemp", prop: "pausetime" },
  { key: "item", type: "F_LSTRING", target: "spawntemp", prop: "item" },

  { key: "gravity", type: "F_LSTRING", target: "spawntemp", prop: "gravity" },
  { key: "sky", type: "F_LSTRING", target: "spawntemp", prop: "sky" },
  { key: "skyrotate", type: "F_FLOAT", target: "spawntemp", prop: "skyrotate" },
  { key: "skyaxis", type: "F_VECTOR", target: "spawntemp", prop: "skyaxis" },
  { key: "minyaw", type: "F_FLOAT", target: "spawntemp", prop: "minyaw" },
  { key: "maxyaw", type: "F_FLOAT", target: "spawntemp", prop: "maxyaw" },
  { key: "minpitch", type: "F_FLOAT", target: "spawntemp", prop: "minpitch" },
  { key: "maxpitch", type: "F_FLOAT", target: "spawntemp", prop: "maxpitch" },
  { key: "nextmap", type: "F_LSTRING", target: "spawntemp", prop: "nextmap" },
];

// -------------------------------------------------------------------------
// Function / mmove name registry (F_FUNCTION / F_MMOVE replacement) --
// identical design to src/ctf/g_save.ts.
// -------------------------------------------------------------------------

const functionRegistry = new Map<string, Function>();
const functionNameByRef = new Map<Function, string>();

export function registerSaveFunction(name: string, fn: Function): void {
  functionRegistry.set(name, fn);
  functionNameByRef.set(fn, name);
}

function lookupSaveFunctionRaw(name: string): Function | null {
  return functionRegistry.get(name) ?? null;
}

function nameOfFunction(fn: Function | null): string | null {
  if (fn === null) return null;
  return functionNameByRef.get(fn) ?? null;
}

const mmoveRegistry = new Map<string, MmoveT>();
const mmoveNameByRef = new Map<MmoveT, string>();

export function registerSaveMmove(name: string, mmove: MmoveT): void {
  mmoveRegistry.set(name, mmove);
  mmoveNameByRef.set(mmove, name);
}

function lookupSaveMmove(name: string): MmoveT | null {
  return mmoveRegistry.get(name) ?? null;
}

function nameOfMmove(mmove: MmoveT | null): string | null {
  if (mmove === null) return null;
  return mmoveNameByRef.get(mmove) ?? null;
}

function wrapVoidSelf(fn: Function): (self: EdictT) => void {
  return (self: EdictT) => {
    Reflect.apply(fn, null, [self]);
  };
}
function wrapTouch(
  fn: Function,
): (self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null) => void {
  return (self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null) => {
    Reflect.apply(fn, null, [self, other, plane, surf]);
  };
}
function wrapUse(fn: Function): (self: EdictT, other: EdictT | null, activator: EdictT | null) => void {
  return (self: EdictT, other: EdictT | null, activator: EdictT | null) => {
    Reflect.apply(fn, null, [self, other, activator]);
  };
}
function wrapPain(fn: Function): (self: EdictT, other: EdictT, kick: number, damage: number) => void {
  return (self: EdictT, other: EdictT, kick: number, damage: number) => {
    Reflect.apply(fn, null, [self, other, kick, damage]);
  };
}
function wrapDie(
  fn: Function,
): (self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3) => void {
  return (self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3) => {
    Reflect.apply(fn, null, [self, inflictor, attacker, damage, point]);
  };
}
function wrapBlocked(fn: Function): (self: EdictT, other: EdictT) => void {
  return (self: EdictT, other: EdictT) => {
    Reflect.apply(fn, null, [self, other]);
  };
}

// -------------------------------------------------------------------------
// Registry population -- every exported think/touch/use/pain/die/blocked
// function already ported in this family's non-monster game/player modules
// at the time this file was written. NOTE (follow-up): g_func.ts, g_misc.ts,
// and p_client.ts were being ported concurrently by other workers in this
// same unit when this file was written; their callback exports are NOT yet
// registered here. Whichever pass lands last across those files should add
// their think/touch/use/pain/die functions to `entries` below the same way
// -- every one of them is a plain named export, so the addition is
// mechanical. Until then, a save made with e.g. a func_door mid-move or a
// player mid-pain will round-trip that one field as `null` instead of the
// real callback (equivalent to the field never having been set), not a
// crash -- see deserializeEdict's null-safe wrap calls below.
// -------------------------------------------------------------------------

import { multi_wait, Touch_Multi, trigger_counter_use, trigger_enable, trigger_gravity_touch, trigger_key_use, trigger_monsterjump_touch, trigger_push_touch, trigger_relay_use, Use_Multi } from "./g_trigger";
import {
  target_crosslevel_target_think,
  target_earthquake_think,
  target_earthquake_use,
  target_explosion_explode,
  target_laser_start,
  target_laser_think,
  target_laser_use,
  target_lightramp_think,
  target_lightramp_use,
  trigger_crosslevel_trigger_use,
  Use_Target_Help,
  use_target_changelevel,
  use_target_explosion,
  use_target_goal,
  use_target_secret,
  use_target_spawner,
  use_target_splash,
  Use_Target_Speaker,
  Use_Target_Tent,
} from "./g_target";
import { G_FreeEdict, Think_Delay } from "./g_utils";

function populateSaveRegistry(): void {
  const entries: Array<[string, Function]> = [
    ["multi_wait", multi_wait],
    ["Touch_Multi", Touch_Multi],
    ["trigger_push_touch", trigger_push_touch],
    ["trigger_gravity_touch", trigger_gravity_touch],
    ["trigger_monsterjump_touch", trigger_monsterjump_touch],
    ["Use_Multi", Use_Multi],
    ["trigger_enable", trigger_enable],
    ["trigger_relay_use", trigger_relay_use],
    ["trigger_key_use", trigger_key_use],
    ["trigger_counter_use", trigger_counter_use],
    ["Think_Delay", Think_Delay],
    ["G_FreeEdict", G_FreeEdict],
    ["target_explosion_explode", target_explosion_explode],
    ["target_crosslevel_target_think", target_crosslevel_target_think],
    ["target_laser_think", target_laser_think],
    ["target_laser_start", target_laser_start],
    ["target_laser_use", target_laser_use],
    ["target_lightramp_think", target_lightramp_think],
    ["target_lightramp_use", target_lightramp_use],
    ["target_earthquake_think", target_earthquake_think],
    ["target_earthquake_use", target_earthquake_use],
    ["Use_Target_Tent", Use_Target_Tent],
    ["Use_Target_Speaker", Use_Target_Speaker],
    ["Use_Target_Help", Use_Target_Help],
    ["use_target_secret", use_target_secret],
    ["use_target_goal", use_target_goal],
    ["use_target_explosion", use_target_explosion],
    ["use_target_changelevel", use_target_changelevel],
    ["use_target_splash", use_target_splash],
    ["use_target_spawner", use_target_spawner],
    ["trigger_crosslevel_trigger_use", trigger_crosslevel_trigger_use],
  ];
  for (const [name, fn] of entries) registerSaveFunction(name, fn);
  // No registered module defines an MmoveT instance yet in this family's
  // non-monster scope; registerSaveMmove has no callers, matching
  // src/ctf/g_save.ts's identical situation.
}
populateSaveRegistry();

// -------------------------------------------------------------------------
// JSON shapes and serialize/deserialize pairs.
// -------------------------------------------------------------------------

function setVec3(dest: Vec3, arr: readonly number[]): void {
  dest[0] = arr[0] ?? 0;
  dest[1] = arr[1] ?? 0;
  dest[2] = arr[2] ?? 0;
}

function edictIndex(ent: EdictT | null): number {
  return ent === null ? -1 : g_edicts.indexOf(ent);
}
function edictFromIndex(idx: number): EdictT | null {
  return idx < 0 ? null : (g_edicts[idx] ?? null);
}
function clientIndex(client: GClientT | null): number {
  return client === null ? -1 : game.clients.indexOf(client);
}
function clientFromIndex(idx: number): GClientT | null {
  return idx < 0 ? null : (game.clients[idx] ?? null);
}
function itemClassname(item: GItemT | null): string | null {
  return item === null ? null : item.classname;
}
function itemFromClassname(classname: string | null): GItemT | null {
  return classname === null ? null : FindItemByClassname(classname);
}

interface EntityStateJSON {
  number: number;
  origin: number[];
  angles: number[];
  old_origin: number[];
  modelindex: number;
  modelindex2: number;
  modelindex3: number;
  modelindex4: number;
  frame: number;
  skinnum: number;
  effects: number;
  renderfx: number;
  solid: number;
  sound: number;
  event: number;
}

function serializeEntityState(s: EntityStateT): EntityStateJSON {
  return {
    number: s.number,
    origin: Array.from(s.origin),
    angles: Array.from(s.angles),
    old_origin: Array.from(s.old_origin),
    modelindex: s.modelindex,
    modelindex2: s.modelindex2,
    modelindex3: s.modelindex3,
    modelindex4: s.modelindex4,
    frame: s.frame,
    skinnum: s.skinnum,
    effects: s.effects,
    renderfx: s.renderfx,
    solid: s.solid,
    sound: s.sound,
    event: s.event,
  };
}

function deserializeEntityState(json: EntityStateJSON): EntityStateT {
  const s = new EntityStateT();
  s.number = json.number;
  setVec3(s.origin, json.origin);
  setVec3(s.angles, json.angles);
  setVec3(s.old_origin, json.old_origin);
  s.modelindex = json.modelindex;
  s.modelindex2 = json.modelindex2;
  s.modelindex3 = json.modelindex3;
  s.modelindex4 = json.modelindex4;
  s.frame = json.frame;
  s.skinnum = json.skinnum;
  s.effects = json.effects;
  s.renderfx = json.renderfx;
  s.solid = json.solid;
  s.sound = json.sound;
  s.event = json.event;
  return s;
}

interface MoveinfoJSON {
  start_origin: number[];
  start_angles: number[];
  end_origin: number[];
  end_angles: number[];
  sound_start: number;
  sound_middle: number;
  sound_end: number;
  accel: number;
  speed: number;
  decel: number;
  distance: number;
  wait: number;
  state: number;
  dir: number[];
  current_speed: number;
  move_speed: number;
  next_speed: number;
  remaining_distance: number;
  decel_distance: number;
  endfunc: string | null;
}

function serializeMoveinfo(m: MoveinfoT): MoveinfoJSON {
  return {
    start_origin: Array.from(m.start_origin),
    start_angles: Array.from(m.start_angles),
    end_origin: Array.from(m.end_origin),
    end_angles: Array.from(m.end_angles),
    sound_start: m.sound_start,
    sound_middle: m.sound_middle,
    sound_end: m.sound_end,
    accel: m.accel,
    speed: m.speed,
    decel: m.decel,
    distance: m.distance,
    wait: m.wait,
    state: m.state,
    dir: Array.from(m.dir),
    current_speed: m.current_speed,
    move_speed: m.move_speed,
    next_speed: m.next_speed,
    remaining_distance: m.remaining_distance,
    decel_distance: m.decel_distance,
    endfunc: nameOfFunction(m.endfunc),
  };
}

function deserializeMoveinfo(json: MoveinfoJSON): MoveinfoT {
  const m = new MoveinfoT();
  setVec3(m.start_origin, json.start_origin);
  setVec3(m.start_angles, json.start_angles);
  setVec3(m.end_origin, json.end_origin);
  setVec3(m.end_angles, json.end_angles);
  m.sound_start = json.sound_start;
  m.sound_middle = json.sound_middle;
  m.sound_end = json.sound_end;
  m.accel = json.accel;
  m.speed = json.speed;
  m.decel = json.decel;
  m.distance = json.distance;
  m.wait = json.wait;
  m.state = json.state;
  setVec3(m.dir, json.dir);
  m.current_speed = json.current_speed;
  m.move_speed = json.move_speed;
  m.next_speed = json.next_speed;
  m.remaining_distance = json.remaining_distance;
  m.decel_distance = json.decel_distance;
  const fn = json.endfunc === null ? null : lookupSaveFunctionRaw(json.endfunc);
  m.endfunc = fn === null ? null : wrapVoidSelf(fn);
  return m;
}

// MonsterInfoT is dead state in this port (no monster subsystem exists in
// the LM_CTF family -- MONSTERS_OK is never defined, see g_local.ts's own
// AI_* comment), but EdictT.monsterinfo is still a real, always-present
// field (every EdictT has one, zero-initialized) that a full-fidelity save
// must still round-trip byte-for-byte the same way it round-trips any other
// always-zero field. Persisted as its numeric/vector state only --
// currentmove/stand/idle/etc are never non-null in this port since nothing
// ever assigns them, so the function-name registry indirection ctf's own
// g_save.ts needs for its (populated, monster-driven) MonsterInfoT is
// unnecessary here; if a future unit ports monster AI into this family,
// this serializer will need the same registry-backed treatment ctf's has.
interface MonsterInfoJSON {
  aiflags: number;
  nextframe: number;
  scale: number;
  pausetime: number;
  attack_finished: number;
  saved_goal: number[];
  search_time: number;
  trail_time: number;
  last_sighting: number[];
  attack_state: number;
  lefty: number;
  idle_time: number;
  linkcount: number;
  power_armor_type: number;
  power_armor_power: number;
}

function serializeMonsterinfo(mi: MonsterInfoT): MonsterInfoJSON {
  return {
    aiflags: mi.aiflags,
    nextframe: mi.nextframe,
    scale: mi.scale,
    pausetime: mi.pausetime,
    attack_finished: mi.attack_finished,
    saved_goal: Array.from(mi.saved_goal),
    search_time: mi.search_time,
    trail_time: mi.trail_time,
    last_sighting: Array.from(mi.last_sighting),
    attack_state: mi.attack_state,
    lefty: mi.lefty,
    idle_time: mi.idle_time,
    linkcount: mi.linkcount,
    power_armor_type: mi.power_armor_type,
    power_armor_power: mi.power_armor_power,
  };
}

function deserializeMonsterinfo(json: MonsterInfoJSON): MonsterInfoT {
  const mi = new MonsterInfoT();
  mi.aiflags = json.aiflags;
  mi.nextframe = json.nextframe;
  mi.scale = json.scale;
  mi.pausetime = json.pausetime;
  mi.attack_finished = json.attack_finished;
  setVec3(mi.saved_goal, json.saved_goal);
  mi.search_time = json.search_time;
  mi.trail_time = json.trail_time;
  setVec3(mi.last_sighting, json.last_sighting);
  mi.attack_state = json.attack_state;
  mi.lefty = json.lefty;
  mi.idle_time = json.idle_time;
  mi.linkcount = json.linkcount;
  mi.power_armor_type = json.power_armor_type;
  mi.power_armor_power = json.power_armor_power;
  return mi;
}

// Full edict field set -- everything but the server-private linking cache
// (area/num_clusters/clusternums/headnode/areanum/areanum2/linkcount),
// which ReadLevel discards and rebuilds via gi.linkentity() exactly as the
// C original does. Extends src/ctf/g_save.ts's EdictJSON shape with
// lmctf60/g_local.h's own appended edict_s fields (see g_local.ts's "CTF
// CODE -- LM_JORM" comment on EdictT): homeposition, homeangles, runetype,
// flagteam, hook_target, hook_lastframe, hook_offset, dontfree, droptime,
// entprops.
export interface EdictJSON {
  s: EntityStateJSON;
  client: number;
  inuse: boolean;
  svflags: number;
  mins: number[];
  maxs: number[];
  absmin: number[];
  absmax: number[];
  size: number[];
  solid: number;
  clipmask: number;
  owner: number;
  movetype: number;
  flags: number;
  model: string | null;
  freetime: number;
  message: string | null;
  classname: string | null;
  spawnflags: number;
  timestamp: number;
  angle: number;
  target: string | null;
  targetname: string | null;
  killtarget: string | null;
  team: string | null;
  pathtarget: string | null;
  deathtarget: string | null;
  combattarget: string | null;
  target_ent: number;
  speed: number;
  accel: number;
  decel: number;
  movedir: number[];
  pos1: number[];
  pos2: number[];
  velocity: number[];
  avelocity: number[];
  mass: number;
  air_finished: number;
  gravity: number;
  goalentity: number;
  movetarget: number;
  yaw_speed: number;
  ideal_yaw: number;
  nextthink: number;
  prethink: string | null;
  think: string | null;
  blocked: string | null;
  touch: string | null;
  use: string | null;
  pain: string | null;
  die: string | null;
  touch_debounce_time: number;
  pain_debounce_time: number;
  damage_debounce_time: number;
  fly_sound_debounce_time: number;
  last_move_time: number;
  health: number;
  max_health: number;
  gib_health: number;
  deadflag: number;
  show_hostile: number;
  powerarmor_time: number;
  map: string | null;
  viewheight: number;
  takedamage: number;
  dmg: number;
  radius_dmg: number;
  dmg_radius: number;
  sounds: number;
  count: number;
  chain: number;
  enemy: number;
  oldenemy: number;
  activator: number;
  groundentity: number;
  groundentity_linkcount: number;
  teamchain: number;
  teammaster: number;
  mynoise: number;
  mynoise2: number;
  noise_index: number;
  noise_index2: number;
  volume: number;
  attenuation: number;
  wait: number;
  delay: number;
  random: number;
  teleport_time: number;
  watertype: number;
  waterlevel: number;
  move_origin: number[];
  move_angles: number[];
  light_level: number;
  style: number;
  item: string | null;
  moveinfo: MoveinfoJSON;
  monsterinfo: MonsterInfoJSON;
  // CTF CODE -- LM_JORM appended fields (see g_local.ts's EdictT):
  homeposition: number[];
  homeangles: number[];
  runetype: number;
  flagteam: number;
  hook_target: number;
  hook_lastframe: number;
  hook_offset: number[];
  dontfree: number;
  droptime: number;
  entprops: number;
}

export function serializeEdict(ent: EdictT): EdictJSON {
  return {
    s: serializeEntityState(ent.s),
    client: clientIndex(ent.client),
    inuse: ent.inuse,
    svflags: ent.svflags,
    mins: Array.from(ent.mins),
    maxs: Array.from(ent.maxs),
    absmin: Array.from(ent.absmin),
    absmax: Array.from(ent.absmax),
    size: Array.from(ent.size),
    solid: ent.solid,
    clipmask: ent.clipmask,
    owner: edictIndex(ent.owner),
    movetype: ent.movetype,
    flags: ent.flags,
    model: ent.model,
    freetime: ent.freetime,
    message: ent.message,
    classname: ent.classname,
    spawnflags: ent.spawnflags,
    timestamp: ent.timestamp,
    angle: ent.angle,
    target: ent.target,
    targetname: ent.targetname,
    killtarget: ent.killtarget,
    team: ent.team,
    pathtarget: ent.pathtarget,
    deathtarget: ent.deathtarget,
    combattarget: ent.combattarget,
    target_ent: edictIndex(ent.target_ent),
    speed: ent.speed,
    accel: ent.accel,
    decel: ent.decel,
    movedir: Array.from(ent.movedir),
    pos1: Array.from(ent.pos1),
    pos2: Array.from(ent.pos2),
    velocity: Array.from(ent.velocity),
    avelocity: Array.from(ent.avelocity),
    mass: ent.mass,
    air_finished: ent.air_finished,
    gravity: ent.gravity,
    goalentity: edictIndex(ent.goalentity),
    movetarget: edictIndex(ent.movetarget),
    yaw_speed: ent.yaw_speed,
    ideal_yaw: ent.ideal_yaw,
    nextthink: ent.nextthink,
    prethink: nameOfFunction(ent.prethink),
    think: nameOfFunction(ent.think),
    blocked: nameOfFunction(ent.blocked),
    touch: nameOfFunction(ent.touch),
    use: nameOfFunction(ent.use),
    pain: nameOfFunction(ent.pain),
    die: nameOfFunction(ent.die),
    touch_debounce_time: ent.touch_debounce_time,
    pain_debounce_time: ent.pain_debounce_time,
    damage_debounce_time: ent.damage_debounce_time,
    fly_sound_debounce_time: ent.fly_sound_debounce_time,
    last_move_time: ent.last_move_time,
    health: ent.health,
    max_health: ent.max_health,
    gib_health: ent.gib_health,
    deadflag: ent.deadflag,
    show_hostile: ent.show_hostile,
    powerarmor_time: ent.powerarmor_time,
    map: ent.map,
    viewheight: ent.viewheight,
    takedamage: ent.takedamage,
    dmg: ent.dmg,
    radius_dmg: ent.radius_dmg,
    dmg_radius: ent.dmg_radius,
    sounds: ent.sounds,
    count: ent.count,
    chain: edictIndex(ent.chain),
    enemy: edictIndex(ent.enemy),
    oldenemy: edictIndex(ent.oldenemy),
    activator: edictIndex(ent.activator),
    groundentity: edictIndex(ent.groundentity),
    groundentity_linkcount: ent.groundentity_linkcount,
    teamchain: edictIndex(ent.teamchain),
    teammaster: edictIndex(ent.teammaster),
    mynoise: edictIndex(ent.mynoise),
    mynoise2: edictIndex(ent.mynoise2),
    noise_index: ent.noise_index,
    noise_index2: ent.noise_index2,
    volume: ent.volume,
    attenuation: ent.attenuation,
    wait: ent.wait,
    delay: ent.delay,
    random: ent.random,
    teleport_time: ent.teleport_time,
    watertype: ent.watertype,
    waterlevel: ent.waterlevel,
    move_origin: Array.from(ent.move_origin),
    move_angles: Array.from(ent.move_angles),
    light_level: ent.light_level,
    style: ent.style,
    item: itemClassname(ent.item),
    moveinfo: serializeMoveinfo(ent.moveinfo),
    monsterinfo: serializeMonsterinfo(ent.monsterinfo),
    homeposition: Array.from(ent.homeposition),
    homeangles: Array.from(ent.homeangles),
    runetype: ent.runetype,
    flagteam: ent.flagteam,
    hook_target: edictIndex(ent.hook_target),
    hook_lastframe: ent.hook_lastframe,
    hook_offset: Array.from(ent.hook_offset),
    dontfree: ent.dontfree,
    droptime: ent.droptime,
    entprops: ent.entprops,
  };
}

export function deserializeEdict(ent: EdictT, json: EdictJSON): void {
  ent.s = deserializeEntityState(json.s);
  ent.client = clientFromIndex(json.client);
  ent.inuse = json.inuse;
  ent.svflags = json.svflags;
  setVec3(ent.mins, json.mins);
  setVec3(ent.maxs, json.maxs);
  setVec3(ent.absmin, json.absmin);
  setVec3(ent.absmax, json.absmax);
  setVec3(ent.size, json.size);
  ent.solid = json.solid;
  ent.clipmask = json.clipmask;
  ent.owner = edictFromIndex(json.owner);
  ent.movetype = json.movetype;
  ent.flags = json.flags;
  ent.model = json.model;
  ent.freetime = json.freetime;
  ent.message = json.message;
  ent.classname = json.classname;
  ent.spawnflags = json.spawnflags;
  ent.timestamp = json.timestamp;
  ent.angle = json.angle;
  ent.target = json.target;
  ent.targetname = json.targetname;
  ent.killtarget = json.killtarget;
  ent.team = json.team;
  ent.pathtarget = json.pathtarget;
  ent.deathtarget = json.deathtarget;
  ent.combattarget = json.combattarget;
  ent.target_ent = edictFromIndex(json.target_ent);
  ent.speed = json.speed;
  ent.accel = json.accel;
  ent.decel = json.decel;
  setVec3(ent.movedir, json.movedir);
  setVec3(ent.pos1, json.pos1);
  setVec3(ent.pos2, json.pos2);
  setVec3(ent.velocity, json.velocity);
  setVec3(ent.avelocity, json.avelocity);
  ent.mass = json.mass;
  ent.air_finished = json.air_finished;
  ent.gravity = json.gravity;
  ent.goalentity = edictFromIndex(json.goalentity);
  ent.movetarget = edictFromIndex(json.movetarget);
  ent.yaw_speed = json.yaw_speed;
  ent.ideal_yaw = json.ideal_yaw;
  ent.nextthink = json.nextthink;
  const prethink = json.prethink === null ? null : lookupSaveFunctionRaw(json.prethink);
  ent.prethink = prethink === null ? null : wrapVoidSelf(prethink);
  const think = json.think === null ? null : lookupSaveFunctionRaw(json.think);
  ent.think = think === null ? null : wrapVoidSelf(think);
  const blocked = json.blocked === null ? null : lookupSaveFunctionRaw(json.blocked);
  ent.blocked = blocked === null ? null : wrapBlocked(blocked);
  const touch = json.touch === null ? null : lookupSaveFunctionRaw(json.touch);
  ent.touch = touch === null ? null : wrapTouch(touch);
  const use = json.use === null ? null : lookupSaveFunctionRaw(json.use);
  ent.use = use === null ? null : wrapUse(use);
  const pain = json.pain === null ? null : lookupSaveFunctionRaw(json.pain);
  ent.pain = pain === null ? null : wrapPain(pain);
  const die = json.die === null ? null : lookupSaveFunctionRaw(json.die);
  ent.die = die === null ? null : wrapDie(die);
  ent.touch_debounce_time = json.touch_debounce_time;
  ent.pain_debounce_time = json.pain_debounce_time;
  ent.damage_debounce_time = json.damage_debounce_time;
  ent.fly_sound_debounce_time = json.fly_sound_debounce_time;
  ent.last_move_time = json.last_move_time;
  ent.health = json.health;
  ent.max_health = json.max_health;
  ent.gib_health = json.gib_health;
  ent.deadflag = json.deadflag;
  ent.show_hostile = json.show_hostile;
  ent.powerarmor_time = json.powerarmor_time;
  ent.map = json.map;
  ent.viewheight = json.viewheight;
  ent.takedamage = json.takedamage;
  ent.dmg = json.dmg;
  ent.radius_dmg = json.radius_dmg;
  ent.dmg_radius = json.dmg_radius;
  ent.sounds = json.sounds;
  ent.count = json.count;
  ent.chain = edictFromIndex(json.chain);
  ent.enemy = edictFromIndex(json.enemy);
  ent.oldenemy = edictFromIndex(json.oldenemy);
  ent.activator = edictFromIndex(json.activator);
  ent.groundentity = edictFromIndex(json.groundentity);
  ent.groundentity_linkcount = json.groundentity_linkcount;
  ent.teamchain = edictFromIndex(json.teamchain);
  ent.teammaster = edictFromIndex(json.teammaster);
  ent.mynoise = edictFromIndex(json.mynoise);
  ent.mynoise2 = edictFromIndex(json.mynoise2);
  ent.noise_index = json.noise_index;
  ent.noise_index2 = json.noise_index2;
  ent.volume = json.volume;
  ent.attenuation = json.attenuation;
  ent.wait = json.wait;
  ent.delay = json.delay;
  ent.random = json.random;
  ent.teleport_time = json.teleport_time;
  ent.watertype = json.watertype;
  ent.waterlevel = json.waterlevel;
  setVec3(ent.move_origin, json.move_origin);
  setVec3(ent.move_angles, json.move_angles);
  ent.light_level = json.light_level;
  ent.style = json.style;
  ent.item = itemFromClassname(json.item);
  ent.moveinfo = deserializeMoveinfo(json.moveinfo);
  ent.monsterinfo = deserializeMonsterinfo(json.monsterinfo);
  setVec3(ent.homeposition, json.homeposition);
  setVec3(ent.homeangles, json.homeangles);
  ent.runetype = json.runetype;
  ent.flagteam = json.flagteam;
  ent.hook_target = edictFromIndex(json.hook_target);
  ent.hook_lastframe = json.hook_lastframe;
  setVec3(ent.hook_offset, json.hook_offset);
  ent.dontfree = json.dontfree;
  ent.droptime = json.droptime;
  ent.entprops = json.entprops;
}

// -------------------------------------------------------------------------
// client_persistent_t -- "client data that stays across multiple level
// loads". WriteGame/ReadGame persist exactly this (and nothing else of
// gclient_t, which GClientT.clear() already treats as fully re-derivable at
// PutClientInServer time -- see g_local.ts's GClientT.clear() comment).
// Extends src/ctf/g_save.ts's ClientPersistantJSON shape with lmctf60's ADC
// squad-board fields (squad, squadStatus) and its savedFlags-instead-of-
// powerArmorActive rename (see g_local.ts's ClientPersistentT comment).
// -------------------------------------------------------------------------

export interface ClientPersistentJSON {
  userinfo: string;
  netname: string;
  squad: string;
  squadStatus: string;
  hand: number;
  connected: boolean;
  health: number;
  max_health: number;
  savedFlags: number;
  selected_item: number;
  inventory: number[];
  max_bullets: number;
  max_shells: number;
  max_rockets: number;
  max_grenades: number;
  max_cells: number;
  max_slugs: number;
  weapon: string | null;
  lastweapon: string | null;
  power_cubes: number;
  score: number;
  game_helpchanged: number;
  helpchanged: number;
  spectator: boolean;
}

export function serializeClientPersistent(pers: ClientPersistentT): ClientPersistentJSON {
  return {
    userinfo: pers.userinfo,
    netname: pers.netname,
    squad: pers.squad,
    squadStatus: pers.squadStatus,
    hand: pers.hand,
    connected: pers.connected,
    health: pers.health,
    max_health: pers.max_health,
    savedFlags: pers.savedFlags,
    selected_item: pers.selected_item,
    inventory: Array.from(pers.inventory),
    max_bullets: pers.max_bullets,
    max_shells: pers.max_shells,
    max_rockets: pers.max_rockets,
    max_grenades: pers.max_grenades,
    max_cells: pers.max_cells,
    max_slugs: pers.max_slugs,
    weapon: itemClassname(pers.weapon),
    lastweapon: itemClassname(pers.lastweapon),
    power_cubes: pers.power_cubes,
    score: pers.score,
    game_helpchanged: pers.game_helpchanged,
    helpchanged: pers.helpchanged,
    spectator: pers.spectator,
  };
}

export function deserializeClientPersistent(json: ClientPersistentJSON): ClientPersistentT {
  const pers = new ClientPersistentT();
  pers.userinfo = json.userinfo;
  pers.netname = json.netname;
  pers.squad = json.squad;
  pers.squadStatus = json.squadStatus;
  pers.hand = json.hand;
  pers.connected = json.connected;
  pers.health = json.health;
  pers.max_health = json.max_health;
  pers.savedFlags = json.savedFlags;
  pers.selected_item = json.selected_item;
  for (let i = 0; i < pers.inventory.length; i++) pers.inventory[i] = json.inventory[i] ?? 0;
  pers.max_bullets = json.max_bullets;
  pers.max_shells = json.max_shells;
  pers.max_rockets = json.max_rockets;
  pers.max_grenades = json.max_grenades;
  pers.max_cells = json.max_cells;
  pers.max_slugs = json.max_slugs;
  pers.weapon = itemFromClassname(json.weapon);
  pers.lastweapon = itemFromClassname(json.lastweapon);
  pers.power_cubes = json.power_cubes;
  pers.score = json.score;
  pers.game_helpchanged = json.game_helpchanged;
  pers.helpchanged = json.helpchanged;
  pers.spectator = json.spectator;
  return pers;
}

// -------------------------------------------------------------------------
// level_locals_t (levelfields[] adapted to property names) -- identical
// shape to src/ctf/g_save.ts's LevelJSON (lmctf60's level_locals_t has no
// diff from ctf's here beyond dropping the unused `forcemap` field, which
// was never persisted by either port's JSON serializer anyway).
// -------------------------------------------------------------------------

export interface LevelJSON {
  framenum: number;
  time: number;
  level_name: string;
  mapname: string;
  nextmap: string;
  intermissiontime: number;
  changemap: string | null;
  exitintermission: number;
  intermission_origin: number[];
  intermission_angle: number[];
  sight_client: number;
  sight_entity: number;
  sight_entity_framenum: number;
  sound_entity: number;
  sound_entity_framenum: number;
  sound2_entity: number;
  sound2_entity_framenum: number;
  pic_health: number;
  total_secrets: number;
  found_secrets: number;
  total_goals: number;
  found_goals: number;
  total_monsters: number;
  killed_monsters: number;
  body_que: number;
  power_cubes: number;
}

export function serializeLevel(): LevelJSON {
  return {
    framenum: level.framenum,
    time: level.time,
    level_name: level.level_name,
    mapname: level.mapname,
    nextmap: level.nextmap,
    intermissiontime: level.intermissiontime,
    changemap: level.changemap,
    exitintermission: level.exitintermission,
    intermission_origin: Array.from(level.intermission_origin),
    intermission_angle: Array.from(level.intermission_angle),
    sight_client: edictIndex(level.sight_client),
    sight_entity: edictIndex(level.sight_entity),
    sight_entity_framenum: level.sight_entity_framenum,
    sound_entity: edictIndex(level.sound_entity),
    sound_entity_framenum: level.sound_entity_framenum,
    sound2_entity: edictIndex(level.sound2_entity),
    sound2_entity_framenum: level.sound2_entity_framenum,
    pic_health: level.pic_health,
    total_secrets: level.total_secrets,
    found_secrets: level.found_secrets,
    total_goals: level.total_goals,
    found_goals: level.found_goals,
    total_monsters: level.total_monsters,
    killed_monsters: level.killed_monsters,
    body_que: level.body_que,
    power_cubes: level.power_cubes,
  };
}

export function deserializeLevel(json: LevelJSON): void {
  level.framenum = json.framenum;
  level.time = json.time;
  level.level_name = json.level_name;
  level.mapname = json.mapname;
  level.nextmap = json.nextmap;
  level.intermissiontime = json.intermissiontime;
  level.changemap = json.changemap;
  level.exitintermission = json.exitintermission;
  setVec3(level.intermission_origin, json.intermission_origin);
  setVec3(level.intermission_angle, json.intermission_angle);
  level.sight_client = edictFromIndex(json.sight_client);
  level.sight_entity = edictFromIndex(json.sight_entity);
  level.sight_entity_framenum = json.sight_entity_framenum;
  level.sound_entity = edictFromIndex(json.sound_entity);
  level.sound_entity_framenum = json.sound_entity_framenum;
  level.sound2_entity = edictFromIndex(json.sound2_entity);
  level.sound2_entity_framenum = json.sound2_entity_framenum;
  level.pic_health = json.pic_health;
  level.total_secrets = json.total_secrets;
  level.found_secrets = json.found_secrets;
  level.total_goals = json.total_goals;
  level.found_goals = json.found_goals;
  level.total_monsters = json.total_monsters;
  level.killed_monsters = json.killed_monsters;
  level.body_que = json.body_que;
  level.power_cubes = json.power_cubes;
  level.current_entity = null;
}

// -------------------------------------------------------------------------
// game_locals_t -- extends src/ctf/g_save.ts's GameJSON with lmctf60's
// appended `teamslocked` field (see g_local.ts's GameLocalsT comment).
// -------------------------------------------------------------------------

export interface GameJSON {
  stamp: string;
  autosaved: boolean;
  helpmessage1: string;
  helpmessage2: string;
  helpchanged: number;
  spawnpoint: string;
  maxclients: number;
  maxentities: number;
  serverflags: number;
  num_items: number;
  teamslocked: boolean;
  clients: ClientPersistentJSON[];
}

// There is no compile-time `__DATE__` in TS; a fixed stamp string plays the
// same role C's build-date check does (reject a save from an incompatible
// layout) without pretending to be a real build date. Distinct from the
// ctf family's own stamp so a ctf save is never mistakenly loaded as an
// lmctf one or vice versa.
const SAVE_VERSION_STAMP = "quake-2-ts:lmctf:g_save:v1";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

export function serializeGame(autosave: boolean): GameJSON {
  return {
    stamp: SAVE_VERSION_STAMP,
    autosaved: autosave,
    helpmessage1: game.helpmessage1,
    helpmessage2: game.helpmessage2,
    helpchanged: game.helpchanged,
    spawnpoint: game.spawnpoint,
    maxclients: game.maxclients,
    maxentities: game.maxentities,
    serverflags: game.serverflags,
    num_items: game.num_items,
    teamslocked: game.teamslocked,
    clients: game.clients.map((c) => serializeClientPersistent(c.pers)),
  };
}

export function deserializeGame(json: GameJSON): void {
  game.helpmessage1 = json.helpmessage1;
  game.helpmessage2 = json.helpmessage2;
  game.helpchanged = json.helpchanged;
  game.spawnpoint = json.spawnpoint;
  game.maxclients = json.maxclients;
  game.maxentities = json.maxentities;
  game.serverflags = json.serverflags;
  game.num_items = json.num_items;
  game.teamslocked = json.teamslocked;
  game.autosaved = json.autosaved;
  game.clients = json.clients.map((clientJson) => {
    const c = new GClientT();
    c.pers = deserializeClientPersistent(clientJson);
    return c;
  });
}

// zero-initialized EdictT per slot, `s.number` set to its own index -- same
// small helper g_main.ts's own InitGame keeps locally (this file does not
// import it from there to avoid a needless cross-file dependency for six
// lines; see file header for why this file does not own InitGame at all).
function makeEdicts(count: number): EdictT[] {
  const list: EdictT[] = [];
  for (let i = 0; i < count; i++) {
    const e = new EdictT();
    e.s.number = i;
    list.push(e);
  }
  return list;
}

// -------------------------------------------------------------------------
// WriteGame / ReadGame / WriteLevel / ReadLevel
// -------------------------------------------------------------------------

function readJSONFile(filename: string): unknown {
  const buf = FS_ReadRawFile(filename);
  if (buf === null) {
    gi.error(`Couldn't open ${filename}`);
  }
  const text = new TextDecoder().decode(buf);
  return JSON.parse(text);
}

function isGameJSON(value: unknown): value is GameJSON {
  return typeof value === "object" && value !== null && "stamp" in value && "clients" in value;
}

function isLevelSaveJSON(value: unknown): value is { level: LevelJSON; edicts: Array<{ index: number; data: EdictJSON }> } {
  return typeof value === "object" && value !== null && "level" in value && "edicts" in value;
}

// lmctf60/g_save.c's real WriteGame also calls `SaveClientData()` --
// same as ctf's -- to snapshot each in-game client's edict-side pers
// fields back into game.clients[].pers before serializing, so an
// in-progress client's health/inventory/etc are captured even though
// GClientT.clear() would otherwise wipe them on the next PutClientInServer.
export function WriteGame(filename: string, autosave: boolean): void {
  if (!autosave) saveClientDataMod().SaveClientData();

  const json = serializeGame(autosave);
  FS_WriteFile(filename, JSON.stringify(json));
}

export function ReadGame(filename: string): void {
  const parsed = readJSONFile(filename);
  if (!isGameJSON(parsed)) {
    gi.error("Savegame from an older version.\n");
  }
  if (parsed.stamp !== SAVE_VERSION_STAMP) {
    gi.error("Savegame from an older version.\n");
  }

  const numEntities = game.maxentities;
  SetGEdicts(makeEdicts(numEntities));
  globals.edicts = g_edicts;

  deserializeGame(parsed);
}

export function WriteLevel(filename: string): void {
  const edicts: Array<{ index: number; data: EdictJSON }> = [];
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse) continue;
    edicts.push({ index: i, data: serializeEdict(ent) });
  }

  const json = { level: serializeLevel(), edicts };
  FS_WriteFile(filename, JSON.stringify(json));
}

export function ReadLevel(filename: string): void {
  const parsed = readJSONFile(filename);
  if (!isLevelSaveJSON(parsed)) {
    gi.error("ReadLevel: malformed save data");
  }

  // wipe all the entities
  for (const e of g_edicts) e.clear();
  globals.num_edicts = Math.floor(cvarNum(gameCvarsMaxclients())) + 1;

  deserializeLevel(parsed.level);

  for (const { index, data } of parsed.edicts) {
    if (index >= globals.num_edicts) globals.num_edicts = index + 1;
    const ent = g_edicts[index];
    if (ent === undefined) continue;
    deserializeEdict(ent, data);

    // let the server rebuild world links for this ent
    ent.area.prev = null;
    ent.area.next = null;
    gi.linkentity(ent);
  }

  // mark all clients as unconnected
  const maxclients = Math.floor(cvarNum(gameCvarsMaxclients()));
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[i + 1];
    if (ent === undefined) continue;
    ent.client = game.clients[i] ?? null;
    if (ent.client !== null) ent.client.pers.connected = false;
  }

  // do any load time things at this point
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.classname !== null && ent.classname === "target_crosslevel_target") {
      ent.nextthink = level.time + ent.delay;
    }
  }
}

// Lazy require, not a static import: p_client.ts (SaveClientData) does not
// exist yet at the time this file was written -- another part of this same
// unit is building it concurrently. Per PORTING.md's import-cycle rule and
// the same precedent src/lmctf/g_target.ts already established for
// p_hud.ts/g_spawn.ts, this resolves lazily so tsc type-checks cleanly once
// p_client.ts lands.
import type * as PClientModule from "./p_client";
function saveClientDataMod(): typeof PClientModule {
  return require("./p_client") as typeof PClientModule;
}

// gameCvars.maxclients is `CvarT | null` until g_main.ts's InitGame
// resolves it; mirrors every other file's local cvarNum-style helper.
import { gameCvars } from "./g_local";
function gameCvarsMaxclients(): { value: number } | null {
  return gameCvars.maxclients;
}
