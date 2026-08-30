// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_rogue_carrier.c -- the CARRIER monster (2023 Quake II re-release / "KEX"
// engine, Rogue mission-pack content). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/m_rogue_carrier.cpp
// (1,153 lines) + m_rogue_carrier.h (88 lines, 78 FRAME_ constants +
// MODEL_SCALE), C++17. Behavioral code, ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/m_soldier.ts/m_medic.ts
// headers). One spawn function, `SP_monster_carrier`.
//
// ============================================================================
// REINFORCEMENT-PLACEMENT HELPERS -- REUSED FROM m_medic.ts, NOT DUPLICATED
// ============================================================================
// carrier.cpp calls `CheckSpawnPoint`/`FindSpawnPoint`/`M_SlotsLeft`/
// `SpawnGrow_Spawn` -- declared in g_local.h, defined in
// rogue/g_rogue_spawn.cpp and rogue/g_rogue_monster.cpp (not this file's
// source, not yet ported as standalone modules). m_medic.ts already needed
// these exact same functions for its own reinforcement-spawning path and
// ported them for real; unlike the earlier assumption in m_medic.ts's own
// file header ("ported... locally... unexported"), the actual landed code
// EXPORTS `realrange`, `M_SlotsLeft`, `PickCoopTarget`, `CheckSpawnPoint`,
// `CheckGroundSpawnPoint`, `FindSpawnPoint`, `CreateGroundMonster`, and
// `SpawnGrow_Spawn` (verified by grepping m_medic.ts directly) -- so this
// file imports `CheckSpawnPoint`/`FindSpawnPoint`/`SpawnGrow_Spawn`/
// `M_SlotsLeft` from m_medic.ts instead of re-deriving them. `realrange`/
// `PickCoopTarget`/`CreateGroundMonster`/`CheckGroundSpawnPoint` are also
// exported there but this file's C++ source never calls them (verified by
// grep against m_rogue_carrier.cpp) -- not imported.
//
// `CreateFlyMonster` (g_rogue_spawn.cpp:49-54) is NOT in m_medic.ts (its own
// header explicitly says CreateFlyMonster "belongs to the carrier/widow
// files" -- this is that file). Ported for real, locally, unexported: it is
// just `CheckSpawnPoint` guarding the same `CreateMonster` body
// (g_rogue_spawn.cpp:31-46) that m_medic.ts's `CreateGroundMonster` already
// inlines for its own ground-check variant -- collapsed the same way here.
//
// `inback`/`below` (rogue/g_rogue_newai.cpp:901-912, 1205-1219) are simple,
// self-contained dot-product geometry predicates -- not weapon systems or
// hint-node pathing (the concurrent unit's actual scope per this unit's
// brief: fire_prox/fire_tesla/fire_blaster2/hint paths), and every primitive
// they need (AngleVectors, vec3 math) is already landed. Ported for real,
// locally, unexported, matching m_medic.ts's own precedent of porting
// small self-contained g_rogue_newai.cpp helpers (`realrange`,
// `PickCoopTarget`) locally rather than stubbing them. `infront` (same
// forward-declared trio in the C++) is instead defined in base g_ai.cpp and
// already exported from g_ai.ts -- imported directly, not re-derived.
// `drawbbox` (g_rogue_newai.cpp:1221+, also forward-declared in this file)
// is a debug-draw visualization helper never actually called anywhere in
// m_rogue_carrier.cpp (verified by grep) -- a dead extern declaration, not
// ported, matching m_medic.ts's/m_flyer.ts's own "declared-but-unused C
// extern" precedent (e.g. flyer_move_attack2 in this same file, below).
//
// ============================================================================
// KAMIKAZE REINFORCEMENT ANIMATION -- GENERIC FIELD CALL, NOT A NEW IMPORT
// ============================================================================
// `CarrierSpawn` (cpp:331-394) explicitly does
// `M_SetAnimation(ent, &flyer_move_kamikaze)` on a freshly-spawned
// "monster_kamikaze" reinforcement. `flyer_move_kamikaze` (and its endfunc
// wrapper `flyer_kamikaze`) are local, UNEXPORTED bindings in m_flyer.ts --
// not importable, and m_flyer.ts is out of this unit's scope to edit.
// Reading m_flyer.ts directly (SP_monster_kamikaze -> SP_monster_flyer,
// m_flyer.ts:805-817) shows `EF_ROCKET` (which `SP_monster_kamikaze` always
// sets) forces `self.mass = 100`, and `flyer_run`
// (`self.monsterinfo.run`, assigned by `SP_monster_flyer`) does exactly
// `if (self.mass > 50) M_SetAnimation(self, flyer_move_kamikaze, true);` --
// i.e. calling the newly-spawned entity's own already-assigned
// `ent.monsterinfo.run(ent)` through the generic EdictT field (no import
// needed) reproduces the IDENTICAL `M_SetAnimation(ent, flyer_move_kamikaze)`
// call the C++ makes directly, byte-for-byte, since mass > 50 always holds
// for a kamikaze. Used below in place of a direct `flyer_move_kamikaze`
// reference. The non-kamikaze "monster_flyer" branch uses
// `flyer_move_attack3`, which IS exported from m_flyer.ts -- imported
// directly, matching the C++ call verbatim.
//
// ============================================================================
// FORWARD-REFERENCED ENDFUNCS -- HOISTED `function` DECLARATIONS
// ============================================================================
// C++ forward-declares `carrier_run`/`carrier_dead`/`carrier_attack_mg`/
// `carrier_reattack_mg`/`carrier_attack_gren`/`carrier_reattack_gren` at the
// top of the file so its frame tables (defined textually earlier than these
// functions' own bodies) can reference them as `mmove_t` function-pointer
// fields. TS `const`/arrow functions have no such forward visibility (TDZ),
// but plain `function` declarations are fully hoisted -- the exact
// technique m_flyer.ts already uses for the identical problem (see its own
// "hoisted (used as a VALUE above...)" comments on `flyer_kamikaze`). This
// file uses plain `function` declarations for all six, in the same
// relative order as the C++ source; `carrier_run` is the only one also
// assigned to an entity field (`self.monsterinfo.run`), so it alone gets a
// one-time `RegisterMonsterinfoRun("carrier_run", carrier_run)` call after
// its definition (the registry returns the same function identity it was
// given, so the plain hoisted binding IS the registered one -- see
// g_save_registry.ts's `makeRegistry().register()`).
//
// ============================================================================
// MINOR IDIOMS
// ============================================================================
// - `CarrierCoopCheck`'s fixed `std::array<edict_t*, MAX_SPLIT_PLAYERS>`
//   becomes a plain growable `EdictT[]` (`targets.push(ent)` instead of
//   `targets[num_targets++] = ent`) -- MAX_SPLIT_PLAYERS(8) is a capacity
//   bound the C++ never actually needs to enforce (`game.maxclients` is the
//   real loop bound), so this drops a fixed-capacity allocation with no
//   observable behavioral effect, matching this port line's established
//   "dropped allocation-reuse optimization, not a behavioral deviation"
//   idiom (m_medic.ts's own header uses this exact phrase for an analogous
//   case).
// - `coop->integer`/`skill->integer`/`skill->value`: local unexported
//   `coopEnabled()`/`skillValue()` helpers, matching m_medic.ts's own
//   precedent verbatim (`CvarT` has no cached `.integer`/`.value`).
// - `self->bad_area` is `edict_t*` (nullable pointer used as a boolean
//   flag) in the C++; ported field type is `EdictT | null` --
//   `if (self->bad_area)` becomes `if (self.bad_area !== null)`.
//
// ============================================================================

import { vec3, type Vec3 } from "../shared/math";
import { AngleVectors, vec3_sub, vec3_add, vec3_muls, vec3_addEq, vec3_dot, vec3_length, vec3_normalize, vectoyaw } from "./q_vec3";
import {
  MonsterMuzzleflashIdT,
  SoundchanT,
  SolidT,
  ATTN_NORM,
  ATTN_NONE,
  MASK_SOLID,
  ServerCommandT,
  KexMulticastT,
  KexTempEventT,
  RenderfxT,
  CvarFlagsT,
} from "../kexapi/game";
import type { CvarT } from "../shared/q_shared";
import type {
  ModT,
  MonsterinfoSightFn,
  MonsterinfoStandFn,
  MonsterinfoWalkFn,
  MonsterinfoAttackFn,
  MonsterinfoCheckattackFn,
  MonsterinfoSetskinFn,
} from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn, PainFn, DieFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoCheckattack,
  RegisterMonsterinfoSetskin,
} from "./g_save_registry";
import { type EdictT, MonsterAiFlagsT, MonsterAttackStateT, EntFlagsT, GibTypeT, MovetypeT, ModIdT, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, random_time } from "./g_local";
import { gi, level, g_edicts, game } from "./g_main_globals";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, infront, visible, FoundTarget, M_CheckAttack_Base } from "./g_ai";
import { M_ProjectFlashSource, M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, monster_fire_bullet, monster_fire_rocket, monster_fire_grenade, monster_fire_railgun, flymonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { G_Spawn, G_FreeEdict } from "./g_utils";
import { st, ED_CallSpawn } from "./g_spawn";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, Gtime_seconds, Gtime_subtract, type GTime } from "./gtime";
import { frandom, irandom, crandom_open } from "./q_std";
import { PredictAim, BossExplode } from "./m_supertank";
import { M_PickReinforcements, M_SetupReinforcements, CheckSpawnPoint, FindSpawnPoint, SpawnGrow_Spawn, M_SlotsLeft } from "./m_medic";
import { flyer_move_attack3 } from "./m_flyer";

// ---------------------------------------------------------------------------
// m_rogue_carrier.h frame-index enum (88 lines; anonymous enum, declaration
// order = array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_search01 = 0;
export const FRAME_search02 = 1;
export const FRAME_search03 = 2;
export const FRAME_search04 = 3;
export const FRAME_search05 = 4;
export const FRAME_search06 = 5;
export const FRAME_search07 = 6;
export const FRAME_search08 = 7;
export const FRAME_search09 = 8;
export const FRAME_search10 = 9;
export const FRAME_search11 = 10;
export const FRAME_search12 = 11;
export const FRAME_search13 = 12;
export const FRAME_firea01 = 13;
export const FRAME_firea02 = 14;
export const FRAME_firea03 = 15;
export const FRAME_firea04 = 16;
export const FRAME_firea05 = 17;
export const FRAME_firea06 = 18;
export const FRAME_firea07 = 19;
export const FRAME_firea08 = 20;
export const FRAME_firea09 = 21;
export const FRAME_firea10 = 22;
export const FRAME_firea11 = 23;
export const FRAME_firea12 = 24;
export const FRAME_firea13 = 25;
export const FRAME_firea14 = 26;
export const FRAME_firea15 = 27;
export const FRAME_fireb01 = 28;
export const FRAME_fireb02 = 29;
export const FRAME_fireb03 = 30;
export const FRAME_fireb04 = 31;
export const FRAME_fireb05 = 32;
export const FRAME_fireb06 = 33;
export const FRAME_fireb07 = 34;
export const FRAME_fireb08 = 35;
export const FRAME_fireb09 = 36;
export const FRAME_fireb10 = 37;
export const FRAME_fireb11 = 38;
export const FRAME_fireb12 = 39;
export const FRAME_fireb13 = 40;
export const FRAME_fireb14 = 41;
export const FRAME_fireb15 = 42;
export const FRAME_fireb16 = 43;
export const FRAME_spawn01 = 44;
export const FRAME_spawn02 = 45;
export const FRAME_spawn03 = 46;
export const FRAME_spawn04 = 47;
export const FRAME_spawn05 = 48;
export const FRAME_spawn06 = 49;
export const FRAME_spawn07 = 50;
export const FRAME_spawn08 = 51;
export const FRAME_spawn09 = 52;
export const FRAME_spawn10 = 53;
export const FRAME_spawn11 = 54;
export const FRAME_spawn12 = 55;
export const FRAME_spawn13 = 56;
export const FRAME_spawn14 = 57;
export const FRAME_spawn15 = 58;
export const FRAME_spawn16 = 59;
export const FRAME_spawn17 = 60;
export const FRAME_spawn18 = 61;
export const FRAME_death01 = 62;
export const FRAME_death02 = 63;
export const FRAME_death03 = 64;
export const FRAME_death04 = 65;
export const FRAME_death05 = 66;
export const FRAME_death06 = 67;
export const FRAME_death07 = 68;
export const FRAME_death08 = 69;
export const FRAME_death09 = 70;
export const FRAME_death10 = 71;
export const FRAME_death11 = 72;
export const FRAME_death12 = 73;
export const FRAME_death13 = 74;
export const FRAME_death14 = 75;
export const FRAME_death15 = 76;
export const FRAME_death16 = 77;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see m_medic.ts's own precedent.
// ---------------------------------------------------------------------------

type Aifunc = (self: EdictT, dist: number) => void;
type Thinkfunc = (self: EdictT) => void;

function mkframe(aifunc: Aifunc | null, dist = 0, thinkfunc: Thinkfunc | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveEndfuncFn | null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// ---------------------------------------------------------------------------
// cached_soundindex idiom -- see m_medic.ts's own precedent.
// ---------------------------------------------------------------------------

interface CachedSoundIndex {
  index: number;
}
function mkSound(): CachedSoundIndex {
  return { index: 0 };
}
function assignSound(cache: CachedSoundIndex, name: string): void {
  cache.index = gi.soundindex(name);
}

const sound_pain1 = mkSound();
const sound_pain2 = mkSound();
const sound_pain3 = mkSound();
const sound_death = mkSound();
const sound_sight = mkSound();
const sound_rail = mkSound();
const sound_spawn = mkSound();
const sound_cg_down = mkSound();
const sound_cg_loop = mkSound();
const sound_cg_up = mkSound();

let orig_yaw_speed = 0;

// ---------------------------------------------------------------------------
// coopEnabled/skillValue -- local unexported cvar-value helpers, matching
// m_medic.ts's own precedent verbatim.
// ---------------------------------------------------------------------------

function coopEnabled(): boolean {
  const c: CvarT | null = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}
function skillValue(): number {
  const c: CvarT | null = gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
  return c === null ? 1 : c.value;
}

// ---------------------------------------------------------------------------
// inback / below -- ported for real, locally (rogue/g_rogue_newai.cpp:
// 901-912, 1205-1219). See file header.
// ---------------------------------------------------------------------------

function inback(self: EdictT, other: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const vec = vec3_sub(other.s.origin, self.s.origin);
  vec3_normalize(vec);
  return vec3_dot(vec, forward) < -0.3;
}

function below(self: EdictT, other: EdictT): boolean {
  const vec = vec3_sub(other.s.origin, self.s.origin);
  vec3_normalize(vec);
  const down = vec3(0, 0, -1);
  return vec3_dot(vec, down) > 0.95; // 18 degree arc below
}

// ---------------------------------------------------------------------------
// CreateFlyMonster -- ported for real, locally (rogue/g_rogue_spawn.cpp:
// 29-46 `CreateMonster` + 49-54 `CreateFlyMonster`, collapsed the same way
// m_medic.ts collapses CreateMonster+CreateGroundMonster). See file header.
// ---------------------------------------------------------------------------

function CreateFlyMonster(origin: Vec3, angles: Vec3, mins: Vec3, maxs: Vec3, classname: string): EdictT | null {
  if (!CheckSpawnPoint(origin, mins, maxs)) return null;

  const newEnt = G_Spawn();
  newEnt.s.origin = vec3(origin[0], origin[1], origin[2]);
  newEnt.s.angles = vec3(angles[0], angles[1], angles[2]);
  newEnt.classname = classname;
  newEnt.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;
  newEnt.gravityVector = vec3(0, 0, -1);
  ED_CallSpawn(newEnt);
  newEnt.s.renderfx |= RenderfxT.RF_IR_VISIBLE;

  return newEnt;
}

// ---------------------------------------------------------------------------
// carrier_sight (cpp:66-69)
// ---------------------------------------------------------------------------

export const carrier_sight: MonsterinfoSightFn = RegisterMonsterinfoSight("carrier_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight.index, 1, ATTN_NORM, 0);
});

// ---------------------------------------------------------------------------
// CarrierCoopCheck (cpp:76-131)
// ---------------------------------------------------------------------------

function CarrierCoopCheck(self: EdictT): void {
  if (self.monsterinfo.fire_wait > level.time) return;

  const targets: EdictT[] = [];

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    if (inback(self, ent) || below(self, ent)) {
      const tr = gi.trace(self.s.origin, null, null, ent.s.origin, self, MASK_SOLID);
      if (tr.fraction === 1.0) targets.push(ent);
    }
  }

  if (targets.length === 0) return;

  const target = irandom(targets.length);

  self.monsterinfo.fire_wait = Gtime_add(level.time, CARRIER_ROCKET_TIME);

  const ent = self.enemy;
  self.enemy = targets[target];
  CarrierRocket(self);
  self.enemy = ent;
}

const CARRIER_ROCKET_TIME: GTime = Gtime_from_sec(2);
const CARRIER_ROCKET_SPEED = 750;
const RAIL_FIRE_TIME: GTime = Gtime_from_sec(3);

// ---------------------------------------------------------------------------
// CarrierGrenade (cpp:133-198)
// ---------------------------------------------------------------------------

function CarrierGrenade(self: EdictT): void {
  CarrierCoopCheck(self);

  if (self.enemy === null) return;

  const direction = frandom() < 0.5 ? -1.0 : 1.0;

  const mytime = Math.trunc(Gtime_seconds(Gtime_subtract(level.time, self.timestamp)) / 0.4);

  let spreadR: number;
  let spreadU: number;
  if (mytime === 0) {
    spreadR = 0.15 * direction;
    spreadU = 0.1 - 0.1 * direction;
  } else if (mytime === 1) {
    spreadR = 0;
    spreadU = 0.1;
  } else if (mytime === 2) {
    spreadR = -0.15 * direction;
    spreadU = 0.1 - -0.1 * direction;
  } else if (mytime === 3) {
    spreadR = 0;
    spreadU = 0.1;
  } else {
    spreadR = 0;
    spreadU = 0;
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_CARRIER_GRENADE], forward, right);

  const aim = vec3_sub(self.enemy.s.origin, start);
  vec3_normalize(aim);

  vec3_addEq(aim, vec3_muls(right, spreadR));
  vec3_addEq(aim, vec3_muls(up, spreadU));

  if (aim[2] > 0.15) aim[2] = 0.15;
  else if (aim[2] < -0.5) aim[2] = -0.5;

  const flash_number = MonsterMuzzleflashIdT.MZ2_GUNNER_GRENADE_1;
  monster_fire_grenade(self, start, aim, 50, 600, flash_number, crandom_open() * 10.0, 200.0 + crandom_open() * 10.0);
}

// ---------------------------------------------------------------------------
// CarrierPredictiveRocket / CarrierRocket (cpp:200-286)
// ---------------------------------------------------------------------------

function CarrierPredictiveRocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  const offsets: [MonsterMuzzleflashIdT, number][] = [
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_1, -0.3],
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_2, -0.15],
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_3, 0],
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_4, 0.15],
  ];

  for (const [flash, offset] of offsets) {
    const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash], forward, right);
    const dir = vec3();
    PredictAim(self, self.enemy, start, CARRIER_ROCKET_SPEED, false, offset, dir, null);
    monster_fire_rocket(self, start, dir, 50, CARRIER_ROCKET_SPEED, flash);
  }
}

function CarrierRocket(self: EdictT): void {
  if (self.enemy !== null) {
    if (self.enemy.client !== null && frandom() < 0.5) {
      CarrierPredictiveRocket(self);
      return;
    }
  } else return;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const enemy = self.enemy;

  const shots: [MonsterMuzzleflashIdT, number, boolean][] = [
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_1, 0.4, true],
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_2, 0.025, false],
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_3, -0.025, false],
    [MonsterMuzzleflashIdT.MZ2_CARRIER_ROCKET_4, -0.4, true],
  ];

  for (const [flash, rightScale, dropVertical] of shots) {
    const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash], forward, right);
    const vec = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
    if (dropVertical) vec[2] -= 15;
    const dir = vec3_sub(vec, start);
    vec3_normalize(dir);
    vec3_addEq(dir, vec3_muls(right, rightScale));
    vec3_normalize(dir);
    monster_fire_rocket(self, start, dir, 50, 500, flash);
  }
}

// ---------------------------------------------------------------------------
// carrier_firebullet_right / carrier_firebullet_left / CarrierMachineGun
// (cpp:288-329)
// ---------------------------------------------------------------------------

function carrier_firebullet_right(self: EdictT): void {
  const flashnum = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n ? MonsterMuzzleflashIdT.MZ2_CARRIER_MACHINEGUN_R2 : MonsterMuzzleflashIdT.MZ2_CARRIER_MACHINEGUN_R1;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flashnum], forward, right);
  const aim = vec3();
  PredictAim(self, self.enemy, start, 0, true, -0.3, aim, null);
  monster_fire_bullet(self, start, aim, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flashnum);
}

function carrier_firebullet_left(self: EdictT): void {
  const flashnum = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n ? MonsterMuzzleflashIdT.MZ2_CARRIER_MACHINEGUN_L2 : MonsterMuzzleflashIdT.MZ2_CARRIER_MACHINEGUN_L1;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flashnum], forward, right);
  const aim = vec3();
  PredictAim(self, self.enemy, start, 0, true, -0.3, aim, null);
  monster_fire_bullet(self, start, aim, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flashnum);
}

function CarrierMachineGun(self: EdictT): void {
  CarrierCoopCheck(self);
  if (self.enemy !== null) carrier_firebullet_left(self);
  if (self.enemy !== null) carrier_firebullet_right(self);
}

/** m_rogue_carrier.cpp:724 -- declared and defined but never referenced in the
 *  shipped C++ (dead-but-live one-liner); restored by the phase-6 coverage
 *  audit for completeness, matching the legacy port's precedent. */
export function CarrierMachineGunHold(self: EdictT): void {
  CarrierMachineGun(self);
}

// ---------------------------------------------------------------------------
// CarrierSpawn (cpp:331-394)
// ---------------------------------------------------------------------------

function CarrierSpawn(self: EdictT): void {
  const offset = vec3(105, 0, -58);
  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);

  const startpoint = M_ProjectFlashSource(self, offset, f, r);

  if (self.monsterinfo.chosen_reinforcements[0] === 255) return;

  const reinforcement = self.monsterinfo.reinforcements.reinforcements[self.monsterinfo.chosen_reinforcements[0]];

  const spawnpoint = FindSpawnPoint(startpoint, reinforcement.mins, reinforcement.maxs, 32, false);
  if (spawnpoint === null) return;
  if (reinforcement.classname === null) return;

  const ent = CreateFlyMonster(spawnpoint, self.s.angles, reinforcement.mins, reinforcement.maxs, reinforcement.classname);
  if (ent === null) return;

  gi.sound(self, SoundchanT.CHAN_BODY, sound_spawn.index, 1, ATTN_NONE, 0);

  ent.nextthink = level.time;
  if (ent.think !== null) ent.think(ent);

  ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_SPAWNED_CARRIER | MonsterAiFlagsT.AI_DO_NOT_COUNT | MonsterAiFlagsT.AI_IGNORE_SHOTS;
  ent.monsterinfo.commander = self;
  ent.monsterinfo.monster_slots = reinforcement.strength;
  self.monsterinfo.monster_used += reinforcement.strength;

  if (self.enemy !== null && self.enemy.inuse && self.enemy.health > 0) {
    ent.enemy = self.enemy;
    FoundTarget(ent);

    if (ent.classname === "monster_kamikaze") {
      ent.monsterinfo.lefty = false;
      ent.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
      // [Paril-KEX] equivalent to `M_SetAnimation(ent, &flyer_move_kamikaze)`
      // -- see file header "KAMIKAZE REINFORCEMENT ANIMATION".
      if (ent.monsterinfo.run !== null) ent.monsterinfo.run(ent);
      ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_CHARGING;
      ent.owner = self;
    } else if (ent.classname === "monster_flyer") {
      ent.monsterinfo.lefty = Math.random() < 0.5;
      ent.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;
      M_SetAnimation(ent, flyer_move_attack3, true);
    }
  }
}

// ---------------------------------------------------------------------------
// carrier_prep_spawn / carrier_spawn_check / carrier_ready_spawn /
// carrier_start_spawn (cpp:396-480)
// ---------------------------------------------------------------------------

function carrier_prep_spawn(self: EdictT): void {
  CarrierCoopCheck(self);
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;
  self.timestamp = level.time;
  self.yaw_speed = 10;
}

function carrier_spawn_check(self: EdictT): void {
  CarrierCoopCheck(self);
  CarrierSpawn(self);

  if (Gtime_seconds(level.time) > Gtime_seconds(Gtime_add(self.timestamp, Gtime_from_sec(2)))) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    self.yaw_speed = orig_yaw_speed;
  } else {
    self.monsterinfo.nextframe = FRAME_spawn08;
  }
}

function carrier_ready_spawn(self: EdictT): void {
  CarrierCoopCheck(self);

  const current_yaw = anglemod(self.s.angles[YAW]);

  if (Math.abs(current_yaw - self.ideal_yaw) > 0.1) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
    self.timestamp = Gtime_add(self.timestamp, frameTimeAsGtime());
    return;
  }

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

  const { chosen, numChosen } = M_PickReinforcements(self, 1);
  self.monsterinfo.chosen_reinforcements = chosen;

  if (numChosen === 0) return;

  const reinforcement = self.monsterinfo.reinforcements.reinforcements[self.monsterinfo.chosen_reinforcements[0]];

  const offset = vec3(105, 0, -58);
  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);
  const startpoint = M_ProjectFlashSource(self, offset, f, r);
  const spawnpoint = FindSpawnPoint(startpoint, reinforcement.mins, reinforcement.maxs, 32, false);
  if (spawnpoint !== null) {
    const radius = vec3_length(vec3_sub(reinforcement.maxs, reinforcement.mins)) * 0.5;
    SpawnGrow_Spawn(vec3_add(spawnpoint, vec3_add(reinforcement.mins, reinforcement.maxs)), radius, radius * 2.0);
  }
}

function carrier_start_spawn(self: EdictT): void {
  CarrierCoopCheck(self);
  if (!orig_yaw_speed) orig_yaw_speed = self.yaw_speed;

  if (self.enemy === null) return;

  const mytime = Math.trunc(Gtime_seconds(Gtime_subtract(level.time, self.timestamp)) / 0.5);

  const temp = vec3_sub(self.enemy.s.origin, self.s.origin);
  const enemy_yaw = vectoyaw(temp);

  if (mytime === 0) self.ideal_yaw = anglemod(enemy_yaw - 30);
  else if (mytime === 1) self.ideal_yaw = anglemod(enemy_yaw);
  else if (mytime === 2) self.ideal_yaw = anglemod(enemy_yaw + 30);
}

// ---------------------------------------------------------------------------
// anglemod / frameTimeAsGtime -- trivial local helpers, matching this port
// line's per-file-duplicate idiom (m_medic.ts/g_ai.ts/m_move.ts/g_misc.ts/
// g_func.ts each carry their own `anglemod`).
// ---------------------------------------------------------------------------

const YAW = 1;

function anglemod(a: number): number {
  return (360.0 / 65536) * (Math.trunc((a * (65536 / 360.0)) % 65536) & 65535);
}

function frameTimeAsGtime(): GTime {
  return Gtime_from_sec(gi.frame_time_s);
}

// ---------------------------------------------------------------------------
// Frame tables (cpp:482-702)
// ---------------------------------------------------------------------------

const carrier_frames_stand: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_stand));
const carrier_move_stand = RegisterMmove("carrier_move_stand", mkMove(FRAME_search01, FRAME_search13, carrier_frames_stand, null));

const carrier_frames_walk: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_walk, 4));
const carrier_move_walk = RegisterMmove("carrier_move_walk", mkMove(FRAME_search01, FRAME_search13, carrier_frames_walk, null));

const carrier_frames_run: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_run, 6, CarrierCoopCheck));
const carrier_move_run = RegisterMmove("carrier_move_run", mkMove(FRAME_search01, FRAME_search13, carrier_frames_run, null));

function CarrierSpool(self: EdictT): void {
  CarrierCoopCheck(self);
  gi.sound(self, SoundchanT.CHAN_BODY, sound_cg_up.index, 1, 0.5, 0);
  self.monsterinfo.weapon_sound = sound_cg_loop.index;
}

const carrier_frames_attack_pre_mg: MframeT[] = [
  mkframe(ai_charge, 4, CarrierSpool),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, carrier_attack_mg),
];
const carrier_move_attack_pre_mg = RegisterMmove("carrier_move_attack_pre_mg", mkMove(FRAME_firea01, FRAME_firea08, carrier_frames_attack_pre_mg, null));

// Loop this
const carrier_frames_attack_mg: MframeT[] = [
  mkframe(ai_charge, -2, CarrierMachineGun),
  mkframe(ai_charge, -2, CarrierMachineGun),
  mkframe(ai_charge, -2, carrier_reattack_mg),
];
const carrier_move_attack_mg = RegisterMmove("carrier_move_attack_mg", mkMove(FRAME_firea09, FRAME_firea11, carrier_frames_attack_mg, null));

const carrier_frames_attack_post_mg: MframeT[] = [
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
];
const carrier_move_attack_post_mg = RegisterMmove("carrier_move_attack_post_mg", mkMove(FRAME_firea12, FRAME_firea15, carrier_frames_attack_post_mg, carrier_run));

const carrier_frames_attack_pre_gren: MframeT[] = [
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, carrier_attack_gren),
];
const carrier_move_attack_pre_gren = RegisterMmove("carrier_move_attack_pre_gren", mkMove(FRAME_fireb01, FRAME_fireb06, carrier_frames_attack_pre_gren, null));

const carrier_frames_attack_gren: MframeT[] = [
  mkframe(ai_charge, -15, CarrierGrenade),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, carrier_reattack_gren),
];
const carrier_move_attack_gren = RegisterMmove("carrier_move_attack_gren", mkMove(FRAME_fireb07, FRAME_fireb10, carrier_frames_attack_gren, null));

const carrier_frames_attack_post_gren: MframeT[] = [
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
  mkframe(ai_charge, 4, CarrierCoopCheck),
];
const carrier_move_attack_post_gren = RegisterMmove("carrier_move_attack_post_gren", mkMove(FRAME_fireb11, FRAME_fireb16, carrier_frames_attack_post_gren, carrier_run));

const carrier_frames_attack_rocket: MframeT[] = [mkframe(ai_charge, 15, CarrierRocket)];
const carrier_move_attack_rocket = RegisterMmove("carrier_move_attack_rocket", mkMove(FRAME_fireb01, FRAME_fireb01, carrier_frames_attack_rocket, carrier_run));

function CarrierRail(self: EdictT): void {
  CarrierCoopCheck(self);
  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_CARRIER_RAILGUN], forward, right);

  const dir = vec3_sub(self.pos1, start);
  vec3_normalize(dir);

  monster_fire_railgun(self, start, dir, 50, 100, MonsterMuzzleflashIdT.MZ2_CARRIER_RAILGUN);
  self.monsterinfo.attack_finished = Gtime_add(level.time, RAIL_FIRE_TIME);
}

function CarrierSaveLoc(self: EdictT): void {
  CarrierCoopCheck(self);
  const enemy = self.enemy;
  if (enemy === null) return;
  self.pos1 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
}

const carrier_frames_attack_rail: MframeT[] = [
  mkframe(ai_charge, 2, CarrierCoopCheck),
  mkframe(ai_charge, 2, CarrierSaveLoc),
  mkframe(ai_charge, 2, CarrierCoopCheck),
  mkframe(ai_charge, -20, CarrierRail),
  mkframe(ai_charge, 2, CarrierCoopCheck),
  mkframe(ai_charge, 2, CarrierCoopCheck),
  mkframe(ai_charge, 2, CarrierCoopCheck),
  mkframe(ai_charge, 2, CarrierCoopCheck),
  mkframe(ai_charge, 2, CarrierCoopCheck),
];
const carrier_move_attack_rail = RegisterMmove("carrier_move_attack_rail", mkMove(FRAME_search01, FRAME_search09, carrier_frames_attack_rail, carrier_run));

const carrier_frames_spawn: MframeT[] = [
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2, carrier_prep_spawn), // 7 - end of wind down
  mkframe(ai_charge, -2, carrier_start_spawn), // 8 - start of spawn
  mkframe(ai_charge, -2, carrier_ready_spawn),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -10, carrier_spawn_check), // 12 - actual spawn
  mkframe(ai_charge, -2), // 13 - begin of wind down
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2),
  mkframe(ai_charge, -2), // 18 - end of wind down
];
const carrier_move_spawn = RegisterMmove("carrier_move_spawn", mkMove(FRAME_spawn01, FRAME_spawn18, carrier_frames_spawn, carrier_run));

const carrier_frames_pain_heavy: MframeT[] = Array.from({ length: 10 }, () => mkframe(ai_move));
const carrier_move_pain_heavy = RegisterMmove("carrier_move_pain_heavy", mkMove(FRAME_death01, FRAME_death10, carrier_frames_pain_heavy, carrier_run));

const carrier_frames_pain_light: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move));
const carrier_move_pain_light = RegisterMmove("carrier_move_pain_light", mkMove(FRAME_spawn01, FRAME_spawn04, carrier_frames_pain_light, carrier_run));

const carrier_frames_death: MframeT[] = [mkframe(ai_move, 0, BossExplode), ...Array.from({ length: 15 }, () => mkframe(ai_move))];
const carrier_move_death = RegisterMmove("carrier_move_death", mkMove(FRAME_death01, FRAME_death16, carrier_frames_death, carrier_dead));

// ---------------------------------------------------------------------------
// carrier_run (MONSTERINFO_RUN, cpp:709-717) -- hoisted `function`, forward-
// referenced by frame tables above. See file header.
// ---------------------------------------------------------------------------

function carrier_run(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, carrier_move_stand, true);
  else M_SetAnimation(self, carrier_move_run, true);
}
RegisterMonsterinfoRun("carrier_run", carrier_run);

// ---------------------------------------------------------------------------
// carrier_dead (cpp:963-989) -- hoisted `function`, forward-referenced by
// carrier_move_death above. Never assigned to an entity field (only used as
// an mmove endfunc), so no Register* wrapping -- matches m_medic.ts's own
// `medic_dead` precedent exactly.
// ---------------------------------------------------------------------------

function carrier_dead(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  self.s.sound = 0;
  self.s.skinnum = Math.trunc(self.s.skinnum / 2);

  self.gravityVector[2] = -1.0;

  const gibs: GibDefT[] = [
    { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2" },
    { count: 3, gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
    { gibname: "models/monsters/carrier/gibs/base.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/carrier/gibs/chest.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/carrier/gibs/gl.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/carrier/gibs/lcg.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/carrier/gibs/lwing.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/carrier/gibs/rcg.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/carrier/gibs/rwing.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { count: 2, gibname: "models/monsters/carrier/gibs/spawner.md2", type: GibTypeT.GIB_SKINNED },
    { count: 2, gibname: "models/monsters/carrier/gibs/thigh.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/carrier/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD },
  ];
  ThrowGibs(self, 500, gibs);
}

// ---------------------------------------------------------------------------
// carrier_attack_mg / carrier_reattack_mg (cpp:857-887) -- hoisted
// `function`s, forward-referenced by frame tables above.
// ---------------------------------------------------------------------------

function carrier_attack_mg(self: EdictT): void {
  CarrierCoopCheck(self);
  M_SetAnimation(self, carrier_move_attack_mg, true);
  self.monsterinfo.melee_debounce_time = Gtime_add(level.time, random_time(Gtime_from_sec(1.2), Gtime_from_sec(2)));
}

function carrier_reattack_mg(self: EdictT): void {
  CarrierMachineGun(self);

  CarrierCoopCheck(self);
  if (self.enemy !== null && visible(self, self.enemy) && infront(self, self.enemy)) {
    if (frandom() < 0.6) {
      self.monsterinfo.melee_debounce_time = Gtime_add(self.monsterinfo.melee_debounce_time, random_time(Gtime_from_ms(250), Gtime_from_ms(500)));
      M_SetAnimation(self, carrier_move_attack_mg, true);
      return;
    } else if (self.monsterinfo.melee_debounce_time > level.time) {
      M_SetAnimation(self, carrier_move_attack_mg, true);
      return;
    }
  }

  M_SetAnimation(self, carrier_move_attack_post_mg, true);
  self.monsterinfo.weapon_sound = 0;
  gi.sound(self, SoundchanT.CHAN_BODY, sound_cg_down.index, 1, 0.5, 0);
}

// ---------------------------------------------------------------------------
// carrier_attack_gren / carrier_reattack_gren (cpp:889-906) -- hoisted
// `function`s, forward-referenced by frame tables above.
// ---------------------------------------------------------------------------

function carrier_attack_gren(self: EdictT): void {
  CarrierCoopCheck(self);
  self.timestamp = level.time;
  M_SetAnimation(self, carrier_move_attack_gren, true);
}

function carrier_reattack_gren(self: EdictT): void {
  CarrierCoopCheck(self);
  if (self.enemy !== null && infront(self, self.enemy)) {
    if (Gtime_seconds(Gtime_add(self.timestamp, Gtime_from_sec(1.3))) > Gtime_seconds(level.time)) {
      M_SetAnimation(self, carrier_move_attack_gren, true);
      return;
    }
  }
  M_SetAnimation(self, carrier_move_attack_post_gren, true);
}

// ---------------------------------------------------------------------------
// carrier_stand / carrier_walk (cpp:704-722)
// ---------------------------------------------------------------------------

export const carrier_stand: MonsterinfoStandFn = RegisterMonsterinfoStand("carrier_stand", (self: EdictT): void => {
  M_SetAnimation(self, carrier_move_stand, true);
});

export const carrier_walk: MonsterinfoWalkFn = RegisterMonsterinfoWalk("carrier_walk", (self: EdictT): void => {
  M_SetAnimation(self, carrier_move_walk, true);
});

// ---------------------------------------------------------------------------
// carrier_attack (MONSTERINFO_ATTACK, cpp:729-855)
// ---------------------------------------------------------------------------

export const carrier_attack: MonsterinfoAttackFn = RegisterMonsterinfoAttack("carrier_attack", (self: EdictT): void => {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

  if (self.enemy === null || !self.enemy.inuse) return;
  const enemy = self.enemy;

  const enemy_inback = inback(self, enemy);
  const enemy_infront = infront(self, enemy);
  const enemy_below = below(self, enemy);

  if (self.bad_area !== null) {
    if (enemy_inback || enemy_below) {
      M_SetAnimation(self, carrier_move_attack_rocket, true);
    } else if (frandom() < 0.1 || level.time < self.monsterinfo.attack_finished) {
      M_SetAnimation(self, carrier_move_attack_pre_mg, true);
    } else {
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
      M_SetAnimation(self, carrier_move_attack_rail, true);
    }
    return;
  }

  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
    M_SetAnimation(self, carrier_move_spawn, true);
    return;
  }

  if (!enemy_inback && !enemy_infront && !enemy_below) {
    if (frandom() < 0.1 || level.time < self.monsterinfo.attack_finished) {
      M_SetAnimation(self, carrier_move_attack_pre_mg, true);
    } else {
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
      M_SetAnimation(self, carrier_move_attack_rail, true);
    }
    return;
  }

  if (enemy_infront) {
    const range = vec3_length(vec3_sub(enemy.s.origin, self.s.origin));
    if (range <= 125) {
      if (frandom() < 0.8 || level.time < self.monsterinfo.attack_finished) {
        M_SetAnimation(self, carrier_move_attack_pre_mg, true);
      } else {
        gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
        M_SetAnimation(self, carrier_move_attack_rail, true);
      }
    } else if (range < 600) {
      const luck = frandom();
      if (M_SlotsLeft(self) > 2) {
        if (luck <= 0.2) M_SetAnimation(self, carrier_move_attack_pre_mg, true);
        else if (luck <= 0.4) M_SetAnimation(self, carrier_move_attack_pre_gren, true);
        else if (luck <= 0.7 && !(level.time < self.monsterinfo.attack_finished)) {
          gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
          M_SetAnimation(self, carrier_move_attack_rail, true);
        } else M_SetAnimation(self, carrier_move_spawn, true);
      } else {
        if (luck <= 0.3) M_SetAnimation(self, carrier_move_attack_pre_mg, true);
        else if (luck <= 0.65) M_SetAnimation(self, carrier_move_attack_pre_gren, true);
        else if (level.time >= self.monsterinfo.attack_finished) {
          gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
          M_SetAnimation(self, carrier_move_attack_rail, true);
        } else M_SetAnimation(self, carrier_move_attack_pre_mg, true);
      }
    } else {
      const luck = frandom();
      if (M_SlotsLeft(self) > 2) {
        if (luck < 0.3) M_SetAnimation(self, carrier_move_attack_pre_mg, true);
        else if (luck < 0.65 && !(level.time < self.monsterinfo.attack_finished)) {
          gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
          self.pos1 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
          M_SetAnimation(self, carrier_move_attack_rail, true);
        } else M_SetAnimation(self, carrier_move_spawn, true);
      } else {
        if (luck < 0.45 || level.time < self.monsterinfo.attack_finished) {
          M_SetAnimation(self, carrier_move_attack_pre_mg, true);
        } else {
          gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
          M_SetAnimation(self, carrier_move_attack_rail, true);
        }
      }
    }
  } else if (enemy_below || enemy_inback) {
    M_SetAnimation(self, carrier_move_attack_rocket, true);
  }
});

// ---------------------------------------------------------------------------
// carrier_pain (PAIN, cpp:908-953)
// ---------------------------------------------------------------------------

export const carrier_pain: PainFn = RegisterPain("carrier_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  let changed = false;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(5));

  if (damage < 10) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain3.index, 1, ATTN_NONE, 0);
  else if (damage < 30) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NONE, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NONE, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  self.monsterinfo.weapon_sound = 0;

  if (damage >= 10) {
    if (damage < 30) {
      if (mod.id === ModIdT.MOD_CHAINFIST || frandom() < 0.5) {
        changed = true;
        M_SetAnimation(self, carrier_move_pain_light, true);
      }
    } else {
      M_SetAnimation(self, carrier_move_pain_heavy, true);
      changed = true;
    }
  }

  if (changed) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    self.yaw_speed = orig_yaw_speed;
  }
});

// ---------------------------------------------------------------------------
// carrier_setskin (MONSTERINFO_SETSKIN, cpp:955-961)
// ---------------------------------------------------------------------------

export const carrier_setskin: MonsterinfoSetskinFn = RegisterMonsterinfoSetskin("carrier_setskin", (self: EdictT): void => {
  self.s.skinnum = self.health < self.max_health / 2 ? 1 : 0;
});

// ---------------------------------------------------------------------------
// carrier_die (DIE, cpp:991-1001)
// ---------------------------------------------------------------------------

export const carrier_die: DieFn = RegisterDie("carrier_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NONE, 0);
  self.deadflag = true;
  self.takedamage = false;
  self.count = 0;
  M_SetAnimation(self, carrier_move_death, true);
  self.velocity = vec3(0, 0, 0);
  self.gravityVector[2] *= 0.01;
  self.monsterinfo.weapon_sound = 0;
});

// ---------------------------------------------------------------------------
// Carrier_CheckAttack (MONSTERINFO_CHECKATTACK, cpp:1003-1026)
// ---------------------------------------------------------------------------

export const Carrier_CheckAttack: MonsterinfoCheckattackFn = RegisterMonsterinfoCheckattack("Carrier_CheckAttack", (self: EdictT): boolean => {
  if (self.enemy === null) return false;
  const enemy_infront = infront(self, self.enemy);
  const enemy_inback = inback(self, self.enemy);
  const enemy_below = below(self, self.enemy);

  if (enemy_inback || (!enemy_infront && enemy_below)) {
    if (level.time >= self.monsterinfo.fire_wait) {
      self.monsterinfo.fire_wait = Gtime_add(level.time, CARRIER_ROCKET_TIME);
      if (self.monsterinfo.attack !== null) self.monsterinfo.attack(self);
      self.monsterinfo.attack_state = frandom() < 0.6 ? MonsterAttackStateT.AS_SLIDING : MonsterAttackStateT.AS_STRAIGHT;
      return true;
    }
  }

  return M_CheckAttack_Base(self, 0.4, 0.8, 0.8, 0.8, 0.5, 0.0);
});

// ---------------------------------------------------------------------------
// CarrierPrecache (cpp:1028-1052)
// ---------------------------------------------------------------------------

function CarrierPrecache(): void {
  gi.soundindex("flyer/flysght1.wav");
  gi.soundindex("flyer/flysrch1.wav");
  gi.soundindex("flyer/flypain1.wav");
  gi.soundindex("flyer/flypain2.wav");
  gi.soundindex("flyer/flyatck2.wav");
  gi.soundindex("flyer/flyatck1.wav");
  gi.soundindex("flyer/flydeth1.wav");
  gi.soundindex("flyer/flyatck3.wav");
  gi.soundindex("flyer/flyidle1.wav");
  gi.soundindex("weapons/rockfly.wav");
  gi.soundindex("infantry/infatck1.wav");
  gi.soundindex("gunner/gunatck3.wav");
  gi.soundindex("weapons/grenlb1b.wav");
  gi.soundindex("tank/rocket.wav");

  gi.modelindex("models/monsters/flyer/tris.md2");
  gi.modelindex("models/objects/rocket/tris.md2");
  gi.modelindex("models/objects/debris2/tris.md2");
  gi.modelindex("models/objects/grenade/tris.md2");
  gi.modelindex("models/items/spawngro3/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");
  gi.modelindex("models/objects/gibs/gear/tris.md2");
}

const default_reinforcements = "monster_flyer 1;monster_flyer 1;monster_flyer 1;monster_kamikaze 1";
const default_monster_slots_base = 3;

/*QUAKED monster_carrier (1 .5 0) (-56 -56 -44) (56 56 44) Ambush Trigger_Spawn Sight
 */
export function SP_monster_carrier(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_pain1, "carrier/pain_md.wav");
  assignSound(sound_pain2, "carrier/pain_lg.wav");
  assignSound(sound_pain3, "carrier/pain_sm.wav");
  assignSound(sound_death, "carrier/death.wav");
  assignSound(sound_rail, "gladiator/railgun.wav");
  assignSound(sound_sight, "carrier/sight.wav");
  assignSound(sound_spawn, "medic_commander/monsterspawn1.wav");

  assignSound(sound_cg_down, "weapons/chngnd1a.wav");
  assignSound(sound_cg_loop, "weapons/chngnl1a.wav");
  assignSound(sound_cg_up, "weapons/chngnu1a.wav");

  self.monsterinfo.engine_sound = gi.soundindex("bosshovr/bhvengn1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/carrier/tris.md2");

  gi.modelindex("models/monsters/carrier/gibs/base.md2");
  gi.modelindex("models/monsters/carrier/gibs/chest.md2");
  gi.modelindex("models/monsters/carrier/gibs/gl.md2");
  gi.modelindex("models/monsters/carrier/gibs/head.md2");
  gi.modelindex("models/monsters/carrier/gibs/lcg.md2");
  gi.modelindex("models/monsters/carrier/gibs/lwing.md2");
  gi.modelindex("models/monsters/carrier/gibs/rcg.md2");
  gi.modelindex("models/monsters/carrier/gibs/rwing.md2");
  gi.modelindex("models/monsters/carrier/gibs/spawner.md2");
  gi.modelindex("models/monsters/carrier/gibs/thigh.md2");

  self.mins = vec3(-56, -56, -44);
  self.maxs = vec3(56, 56, 44);

  // 2000 - 4000 health
  self.health = Math.trunc(Math.max(2000, 2000 + 1000 * (Math.trunc(skillValue()) - 1)) * st.health_multiplier);
  // add health in coop (500 * skill)
  if (coopEnabled()) self.health += 500 * Math.trunc(skillValue());

  self.gib_health = -200;
  self.mass = 1000;

  self.yaw_speed = 15;
  orig_yaw_speed = self.yaw_speed;

  self.flags |= EntFlagsT.FL_IMMUNE_LASER;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;

  self.pain = carrier_pain;
  self.die = carrier_die;

  self.monsterinfo.melee = null;
  self.monsterinfo.stand = carrier_stand;
  self.monsterinfo.walk = carrier_walk;
  self.monsterinfo.run = carrier_run;
  self.monsterinfo.attack = carrier_attack;
  self.monsterinfo.sight = carrier_sight;
  self.monsterinfo.checkattack = Carrier_CheckAttack;
  self.monsterinfo.setskin = carrier_setskin;
  gi.linkentity(self);

  M_SetAnimation(self, carrier_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  CarrierPrecache();

  flymonster_start(self);

  self.monsterinfo.attack_finished = Gtime_from_sec(0);

  let reinforcements = default_reinforcements;

  if (!st.keys_specified.has("monster_slots")) self.monsterinfo.monster_slots = default_monster_slots_base;
  if (st.keys_specified.has("reinforcements") && st.reinforcements !== null) reinforcements = st.reinforcements;

  if (self.monsterinfo.monster_slots !== 0 && reinforcements) {
    if (Math.trunc(skillValue()) !== 0) {
      self.monsterinfo.monster_slots += Math.floor(self.monsterinfo.monster_slots * (skillValue() / 2.0));
    }

    M_SetupReinforcements(reinforcements, self.monsterinfo.reinforcements);
  }

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  self.monsterinfo.fly_acceleration = 5.0;
  self.monsterinfo.fly_speed = 50.0;
  self.monsterinfo.fly_above = true;
  self.monsterinfo.fly_min_distance = 1000.0;
  self.monsterinfo.fly_max_distance = 1000.0;
}
