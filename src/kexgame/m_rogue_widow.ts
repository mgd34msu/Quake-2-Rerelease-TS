// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_rogue_widow.c -- the BLACK WIDOW boss monster, first form (2023 Quake II
// re-release / "KEX" engine, rogue mission-pack content). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/m_rogue_widow.cpp
// (1,304 lines) + m_rogue_widow.h (178 frame-index enum entries +
// MODEL_SCALE), C++17. Behavioral code, ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/m_soldier.ts/m_medic.ts
// headers). Classname "monster_widow", spawn function `SP_monster_widow`.
// The SECOND widow boss ("Widow2"/widow2) is a separate monster in a
// sibling file, m_rogue_widow2.ts -- not touched here, not imported here.
//
// ============================================================================
// DECLARATION-ORDER RESHUFFLE (no behavioral change)
// ============================================================================
// The C++ source relies on forward declarations / extern mmove_t decls to
// let a frame table reference a function or move defined later in the file
// (`extern const mmove_t widow_move_attack_post_blaster;` etc., cpp:77-80,
// 490-492). TS `const` bindings have no such forward-reference allowance
// (TDZ). Four identifiers that the C only forward-declares are moved earlier
// in this file, ahead of their C textual position, so every frame-table
// array literal that stores them as a value only ever references an
// already-initialized const: `widow_stand`/`widow_run`/`widow_walk`
// (MONSTERINFO_STAND/RUN/WALK, cpp:767-786) are registered immediately
// after their own single-frame moves instead of near the bottom of the
// file; `widow_attack_blaster` (cpp:906-911) and `widow_reattack_blaster`
// (cpp:913-929) are moved ahead of the pre_blaster/blaster frame tables that
// store them as per-frame callbacks (cpp:435-464); `widow_attack_rail`
// (cpp:587-599) is moved ahead of `widow_frames_attack_pre_rail` (cpp:540).
// Every other function body may reference a later-defined const freely --
// function bodies are not evaluated until called, well after full module
// init -- so no other reordering was needed. This is a pure declaration-
// order change; every function's own body is unmodified from the C.
//
// ============================================================================
// SHARED REINFORCEMENT-PLACEMENT HELPERS -- ported locally, unexported
// ============================================================================
// `CreateGroundMonster`/`CheckSpawnPoint`/`CheckGroundSpawnPoint`/
// `FindSpawnPoint` (rogue/g_rogue_spawn.cpp:29-97) and `M_SlotsLeft`
// (rogue/g_rogue_monster.cpp:105-108) / `realrange`
// (rogue/g_rogue_newai.cpp:914-921) / `PickCoopTarget`
// (rogue/g_rogue_newai.cpp:1508-1534) are declared in g_local.h but defined
// in rogue systems files with no ported .ts module. m_medic.ts already faced
// this exact situation for its own reinforcement spawning and ported these
// same C++ functions locally, unexported (see m_medic.ts:605-704 and its
// file header's "THE REINFORCEMENTS FINDING" section) -- m_medic.ts's copies
// are not importable (unexported), so this file reproduces the identical
// logic locally again, following the same precedent, cited to the same C++
// line ranges. `SpawnGrow_Spawn` (rogue/g_rogue_spawn.cpp:152-251, used by
// `widow_ready_spawn`) is ported the same way, following m_medic.ts:746+.
// `CountPlayers` (rogue/g_rogue_newai.cpp:1541-1556, used by
// `WidowCalcSlots`) has no existing port anywhere in this tree; it is
// trivial (coop-only client census) and ported locally for real here too.
//
// ============================================================================
// STUBS -- functions owned by the concurrent rogue-systems porting unit
// ============================================================================
// `monster_fire_blaster2` (cpp:190,239,250): a full second blaster-bolt
// projectile weapon declared in g_local.h, defined in
// rogue/g_rogue_newweap.cpp:1374 -- a weapons-file concern out of this
// unit's scope, exactly like m_medic.ts's own `monster_fire_blaster2` stub
// (see m_medic.ts's file header). Reached only from `WidowBlaster`'s three
// call sites (spawn-sweep, blind-fire-torso, and run-attack blaster frames);
// narrowly gated behind those frame callbacks, not a landmine.
// `Widowlegs_Spawn` (declared g_local.h, defined rogue/g_rogue_spawn.cpp:
// 350-367) and its `widowlegs_think` (g_rogue_spawn.cpp:265-347): a purely
// cosmetic legs-falling-apart prop spawned once, in the death sequence's
// final frame (`spawn_out_do`, cpp:681-708). `widowlegs_think`'s own body
// calls `ThrowSmallStuff`/`ThrowWidowGibSized`, genuinely DEFINED in the
// sibling m_rogue_widow2.cpp (now landed and exporting both) -- ported for
// real below, importing them from "./m_rogue_widow2". Reached only once, at
// the very end of the boss's death animation -- cosmetic, not a landmine.
//
// ============================================================================
// OTHER NOTES
// ============================================================================
// - `shotsfired` (cpp:30, `static uint32_t shotsfired;`) is a C++ file-level
//   static, i.e. ONE counter shared across every widow instance in the
//   level (not per-entity) -- ported as a module-level `let`, preserving
//   that cross-instance sharing bug-for-bug (it only gates a cosmetic
//   EF_BLASTER muzzle-flash-effect toggle every 4th shot fired by ANY
//   widow, not gameplay-affecting).
// - `widow_damage_multiplier` (cpp:49, a plain global `unsigned int`) is
//   likewise a module-level `let`, matching PORTING.md's "C globals become
//   exported/module const-object singletons, mutated in place" -- this one
//   is reassigned wholesale (not mutated in place) in the C too, so a plain
//   `let` is the faithful shape.
// - `coop->integer`/`skill->integer`/`skill->value`: no cached `.integer`
//   on `CvarT` (see g_utils.ts's own `coopEnabled()` precedent) -- this
//   file carries its own local unexported `cvarOrDefault` (copied verbatim
//   from m_soldier.ts's own per-file duplicate, m_soldier.ts:947-951) plus
//   inline `Math.trunc(cvarOrDefault("skill", "1").value)` at each
//   `skill->integer` use site, matching the established idiom already used
//   by m_soldier.ts/m_gunner.ts/m_tank.ts/m_shambler.ts/g_ai.ts/g_monster.ts.
// - `min(6, ...)` (cpp:1204, C's global `min` template) -> `Math.min`.
// - `bool infront(edict_t *self, edict_t *other);` (cpp:23) is a dead
//   forward declaration -- never called anywhere in this file. Dropped
//   silently, matching PORTING.md's precedent for unused C declarations.
// - `self->bad_area` is `EdictT | null` in this port (a pointer to a
//   bad-area marker entity, not a boolean -- see m_move.ts's own header),
//   so `if (self->bad_area)` becomes `if (self.enemy !== null &&
//   self.bad_area !== null)` style null checks, not a boolean read.

import { vec3, VectorCopy, type Vec3 } from "../shared/math";
import { AngleVectors, vec3_sub, vec3_add, vec3_muls, vec3_dot, vec3_length, vec3_normalized, vec3_any_nonzero, vectoyaw, vectoangles, G_ProjectSource, G_ProjectSource2 } from "./q_vec3";
import { PITCH, ROLL, type CvarT } from "../shared/q_shared";
import {
  MonsterMuzzleflashIdT,
  SoundchanT,
  EffectsT,
  SvflagsT,
  SolidT,
  CvarFlagsT,
  ATTN_NORM,
  ATTN_NONE,
  MASK_MONSTERSOLID,
  MASK_SOLID,
  ServerCommandT,
  KexMulticastT,
  KexTempEventT,
  RenderfxT,
} from "../kexapi/game";
import type { ModT, MonsterinfoIdleFn, MonsterinfoSearchFn } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn, PainFn, DieFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoCheckattack,
} from "./g_save_registry";
import {
  type EdictT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  EntFlagsT,
  ItemIdT,
  MovetypeT,
  StuckResultT,
  random_time,
  GibTypeT,
} from "./g_local";
import { gi, level, g_edicts, game } from "./g_main_globals";
import { ai_stand, ai_walk, ai_run, ai_charge, ai_move, visible, FoundTarget, M_CheckAttack_Base } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_droptofloor_generic, M_ShouldReactToPain, monster_fire_railgun, walkmonster_start } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { G_Spawn, G_FreeEdict } from "./g_utils";
import { st, ED_CallSpawn } from "./g_spawn";
import { G_FixStuckObject_Generic } from "./p_move";
import type { StuckObjectTraceFn } from "./bg_local";
import { M_CheckBottom_Fast_Generic, M_CheckBottom_Slow_Generic } from "./m_move";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, Gtime_seconds, GTIME_ZERO, type GTime } from "./gtime";
import { frandom, irandom, crandom, YAW } from "./q_std";
import { monsterFlashOffset } from "./m_flash";
import { PredictAim } from "./m_supertank";
import { SpawnGrow_Spawn } from "./m_medic";
import { ThrowWidowGibSized, ThrowSmallStuff } from "./m_rogue_widow2";
import { monster_fire_blaster2 as RealMonsterFireBlaster2 } from "./rogue/g_rogue_monster";
import type { ThinkFn } from "./g_local_types";

// ---------------------------------------------------------------------------
// m_rogue_widow.h frame-index enum (178 lines; anonymous enum, declaration
// order = array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_idle01 = 0;
export const FRAME_idle02 = 1;
export const FRAME_idle03 = 2;
export const FRAME_idle04 = 3;
export const FRAME_idle05 = 4;
export const FRAME_idle06 = 5;
export const FRAME_idle07 = 6;
export const FRAME_idle08 = 7;
export const FRAME_idle09 = 8;
export const FRAME_idle10 = 9;
export const FRAME_idle11 = 10;
export const FRAME_walk01 = 11;
export const FRAME_walk02 = 12;
export const FRAME_walk03 = 13;
export const FRAME_walk04 = 14;
export const FRAME_walk05 = 15;
export const FRAME_walk06 = 16;
export const FRAME_walk07 = 17;
export const FRAME_walk08 = 18;
export const FRAME_walk09 = 19;
export const FRAME_walk10 = 20;
export const FRAME_walk11 = 21;
export const FRAME_walk12 = 22;
export const FRAME_walk13 = 23;
export const FRAME_run01 = 24;
export const FRAME_run02 = 25;
export const FRAME_run03 = 26;
export const FRAME_run04 = 27;
export const FRAME_run05 = 28;
export const FRAME_run06 = 29;
export const FRAME_run07 = 30;
export const FRAME_run08 = 31;
export const FRAME_firea01 = 32;
export const FRAME_firea02 = 33;
export const FRAME_firea03 = 34;
export const FRAME_firea04 = 35;
export const FRAME_firea05 = 36;
export const FRAME_firea06 = 37;
export const FRAME_firea07 = 38;
export const FRAME_firea08 = 39;
export const FRAME_firea09 = 40;
export const FRAME_fireb01 = 41;
export const FRAME_fireb02 = 42;
export const FRAME_fireb03 = 43;
export const FRAME_fireb04 = 44;
export const FRAME_fireb05 = 45;
export const FRAME_fireb06 = 46;
export const FRAME_fireb07 = 47;
export const FRAME_fireb08 = 48;
export const FRAME_fireb09 = 49;
export const FRAME_firec01 = 50;
export const FRAME_firec02 = 51;
export const FRAME_firec03 = 52;
export const FRAME_firec04 = 53;
export const FRAME_firec05 = 54;
export const FRAME_firec06 = 55;
export const FRAME_firec07 = 56;
export const FRAME_firec08 = 57;
export const FRAME_firec09 = 58;
export const FRAME_fired01 = 59;
export const FRAME_fired02 = 60;
export const FRAME_fired02a = 61;
export const FRAME_fired03 = 62;
export const FRAME_fired04 = 63;
export const FRAME_fired05 = 64;
export const FRAME_fired06 = 65;
export const FRAME_fired07 = 66;
export const FRAME_fired08 = 67;
export const FRAME_fired09 = 68;
export const FRAME_fired10 = 69;
export const FRAME_fired11 = 70;
export const FRAME_fired12 = 71;
export const FRAME_fired13 = 72;
export const FRAME_fired14 = 73;
export const FRAME_fired15 = 74;
export const FRAME_fired16 = 75;
export const FRAME_fired17 = 76;
export const FRAME_fired18 = 77;
export const FRAME_fired19 = 78;
export const FRAME_fired20 = 79;
export const FRAME_fired21 = 80;
export const FRAME_fired22 = 81;
export const FRAME_spawn01 = 82;
export const FRAME_spawn02 = 83;
export const FRAME_spawn03 = 84;
export const FRAME_spawn04 = 85;
export const FRAME_spawn05 = 86;
export const FRAME_spawn06 = 87;
export const FRAME_spawn07 = 88;
export const FRAME_spawn08 = 89;
export const FRAME_spawn09 = 90;
export const FRAME_spawn10 = 91;
export const FRAME_spawn11 = 92;
export const FRAME_spawn12 = 93;
export const FRAME_spawn13 = 94;
export const FRAME_spawn14 = 95;
export const FRAME_spawn15 = 96;
export const FRAME_spawn16 = 97;
export const FRAME_spawn17 = 98;
export const FRAME_spawn18 = 99;
export const FRAME_pain01 = 100;
export const FRAME_pain02 = 101;
export const FRAME_pain03 = 102;
export const FRAME_pain04 = 103;
export const FRAME_pain05 = 104;
export const FRAME_pain06 = 105;
export const FRAME_pain07 = 106;
export const FRAME_pain08 = 107;
export const FRAME_pain09 = 108;
export const FRAME_pain10 = 109;
export const FRAME_pain11 = 110;
export const FRAME_pain12 = 111;
export const FRAME_pain13 = 112;
export const FRAME_pain201 = 113;
export const FRAME_pain202 = 114;
export const FRAME_pain203 = 115;
export const FRAME_transa01 = 116;
export const FRAME_transa02 = 117;
export const FRAME_transa03 = 118;
export const FRAME_transa04 = 119;
export const FRAME_transa05 = 120;
export const FRAME_transb01 = 121;
export const FRAME_transb02 = 122;
export const FRAME_transb03 = 123;
export const FRAME_transb04 = 124;
export const FRAME_transb05 = 125;
export const FRAME_transc01 = 126;
export const FRAME_transc02 = 127;
export const FRAME_transc03 = 128;
export const FRAME_transc04 = 129;
export const FRAME_death01 = 130;
export const FRAME_death02 = 131;
export const FRAME_death03 = 132;
export const FRAME_death04 = 133;
export const FRAME_death05 = 134;
export const FRAME_death06 = 135;
export const FRAME_death07 = 136;
export const FRAME_death08 = 137;
export const FRAME_death09 = 138;
export const FRAME_death10 = 139;
export const FRAME_death11 = 140;
export const FRAME_death12 = 141;
export const FRAME_death13 = 142;
export const FRAME_death14 = 143;
export const FRAME_death15 = 144;
export const FRAME_death16 = 145;
export const FRAME_death17 = 146;
export const FRAME_death18 = 147;
export const FRAME_death19 = 148;
export const FRAME_death20 = 149;
export const FRAME_death21 = 150;
export const FRAME_death22 = 151;
export const FRAME_death23 = 152;
export const FRAME_death24 = 153;
export const FRAME_death25 = 154;
export const FRAME_death26 = 155;
export const FRAME_death27 = 156;
export const FRAME_death28 = 157;
export const FRAME_death29 = 158;
export const FRAME_death30 = 159;
export const FRAME_death31 = 160;
export const FRAME_kick01 = 161;
export const FRAME_kick02 = 162;
export const FRAME_kick03 = 163;
export const FRAME_kick04 = 164;
export const FRAME_kick05 = 165;
export const FRAME_kick06 = 166;
export const FRAME_kick07 = 167;
export const FRAME_kick08 = 168;

export const MODEL_SCALE = 2.0;

// ---------------------------------------------------------------------------
// File-level state (cpp:18-49)
// ---------------------------------------------------------------------------

const RAIL_TIME: GTime = Gtime_from_sec(3);
const BLASTER_TIME: GTime = Gtime_from_sec(2);
const BLASTER2_DAMAGE = 10;
const WIDOW_RAIL_DAMAGE = 50;

const spawnpoints: readonly Vec3[] = [vec3(30, 100, 16), vec3(30, -100, 16)];
const beameffects: readonly Vec3[] = [vec3(12.58, -43.71, 68.88), vec3(3.43, 58.72, 68.41)];
const sweep_angles: readonly number[] = [32, 26, 20, 10, 0, -6.5, -13, -27, -41];
const stalker_mins: Vec3 = vec3(-28, -28, -18);
const stalker_maxs: Vec3 = vec3(28, 28, 18);
const VARIANCE = 15.0;

/** cpp:30 `static uint32_t shotsfired;` -- a file-level static, shared
 *  across every widow instance. See file header. */
let shotsfired = 0;

/** cpp:49 `unsigned int widow_damage_multiplier;` */
let widow_damage_multiplier = 1;

/** cached_soundindex -- matching m_soldier.ts's/m_medic.ts's own per-file
 *  precedent (interface + mkSound()/assignSound() pair). */
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
const sound_rail = mkSound();

// ---------------------------------------------------------------------------
// cvarOrDefault / coopEnabled -- duplicated per-file, see file header.
// ---------------------------------------------------------------------------

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_LATCH);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
}

function coopEnabled(): boolean {
  return cvarOrDefault("coop", "0").value !== 0;
}

/** Local `must()` null-assertion helper, matching m_medic.ts's idiom. */
function must<T>(value: T | null, field: string, self: EdictT): T {
  if (value === null) throw new Error(`${field} is null for ${self.classname ?? "?"}`);
  return value;
}

// ---------------------------------------------------------------------------
// realrange / M_SlotsLeft / PickCoopTarget / CountPlayers -- ported locally,
// unexported. See file header.
// ---------------------------------------------------------------------------

/** rogue/g_rogue_newai.cpp:914-921. */
function realrange(self: EdictT, other: EdictT): number {
  return vec3_length(vec3_sub(self.s.origin, other.s.origin));
}

/** rogue/g_rogue_monster.cpp:105-108. */
function M_SlotsLeft(self: EdictT): number {
  return self.monsterinfo.monster_slots - self.monsterinfo.monster_used;
}

/** rogue/g_rogue_newai.cpp:1508-1534. */
function PickCoopTarget(self: EdictT): EdictT | null {
  if (!coopEnabled()) return null;

  const targets: EdictT[] = [];
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    if (visible(self, ent)) targets.push(ent);
  }

  if (targets.length === 0) return null;

  return targets[Math.trunc(frandom(targets.length))];
}

/** rogue/g_rogue_newai.cpp:1541-1556. Noop (always 1) outside coop. */
function CountPlayers(): number {
  if (!coopEnabled()) return 1;

  let count = 0;
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// CreateGroundMonster / FindSpawnPoint / CheckSpawnPoint /
// CheckGroundSpawnPoint / SpawnGrow_Spawn -- ported locally, unexported.
// See file header.
// ---------------------------------------------------------------------------

/** rogue/g_rogue_spawn.cpp:112-127. The C++'s `if (!mins || !maxs) return
 *  false;` null-pointer guard has no TS equivalent (mins/maxs are always
 *  real Vec3 values here) -- dropped, matching m_medic.ts's own precedent
 *  for the identical function. */
function CheckSpawnPoint(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
  const tr = gi.trace(origin, mins, maxs, origin, null, MASK_MONSTERSOLID);
  if (tr.startsolid || tr.allsolid) return false;
  if (tr.ent !== g_edicts[0]) return false;
  return true;
}

/** rogue/g_rogue_spawn.cpp:139-151. */
function CheckGroundSpawnPoint(origin: Vec3, entMins: Vec3, entMaxs: Vec3, height: number, _gravity: number): boolean {
  if (!CheckSpawnPoint(origin, entMins, entMaxs)) return false;

  if (M_CheckBottom_Fast_Generic(vec3(origin[0] + entMins[0], origin[1] + entMins[1], origin[2] + entMins[2]), vec3(origin[0] + entMaxs[0], origin[1] + entMaxs[1], origin[2] + entMaxs[2]), false)) return true;

  if (M_CheckBottom_Slow_Generic(origin, entMins, entMaxs, g_edicts[0], MASK_MONSTERSOLID, false, false)) return true;

  return false;
}

/** rogue/g_rogue_spawn.cpp:79-97. `maxMoveUp` is genuinely unused in the
 *  C++ body -- kept as an unused parameter to match the call signature
 *  bug-for-bug, matching m_medic.ts's own precedent for the identical
 *  function. */
function FindSpawnPoint(startpoint: Vec3, mins: Vec3, maxs: Vec3, _maxMoveUp: number, drop: boolean = true): Vec3 | null {
  let spawnpoint = vec3(startpoint[0], startpoint[1], startpoint[2]);

  if (!drop || !M_droptofloor_generic(spawnpoint, mins, maxs, false, null, MASK_MONSTERSOLID, false)) {
    spawnpoint = vec3(startpoint[0], startpoint[1], startpoint[2]);

    const trace_func: StuckObjectTraceFn = (start, tmins, tmaxs, end) => gi.trace(start, tmins, tmaxs, end, null, MASK_MONSTERSOLID);
    if (G_FixStuckObject_Generic(spawnpoint, mins, maxs, trace_func) === StuckResultT.NO_GOOD_POSITION) return null;

    if (drop && !M_droptofloor_generic(spawnpoint, mins, maxs, false, null, MASK_MONSTERSOLID, false)) return null;
  }

  return spawnpoint;
}

/** rogue/g_rogue_spawn.cpp:29-46 (`CreateMonster`) + 60-73
 *  (`CreateGroundMonster`), collapsed into one function, matching
 *  m_medic.ts's own precedent (`CreateFlyMonster`, `CreateMonster`'s other
 *  caller, belongs to the carrier file, out of scope here). */
function CreateGroundMonster(origin: Vec3, angles: Vec3, entMins: Vec3, entMaxs: Vec3, classname: string, height: number): EdictT | null {
  if (!CheckGroundSpawnPoint(origin, entMins, entMaxs, height, -1)) return null;

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

// `SpawnGrow_Spawn` (rogue/g_rogue_spawn.cpp:152-251) is already ported for
// real and EXPORTED by m_medic.ts (m_medic.ts:758) -- imported directly
// above rather than duplicated.

// ---------------------------------------------------------------------------
// mkframe / mkMove / Aifunc / Thinkfunc -- local per-file helpers, matching
// m_medic.ts's own precedent verbatim (m_medic.ts:536-542).
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
// monster_fire_blaster2: formerly a local throwing stub here ("owned by
// the concurrent rogue-systems porting unit") -- rogue/g_rogue_monster.ts
// has since landed with a real, exported version; swapped for a
// delegating import (2026-08-30 stale-comment sweep).
// ---------------------------------------------------------------------------

function monster_fire_blaster2(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, flashtype: MonsterMuzzleflashIdT, effect: EffectsT): void {
  RealMonsterFireBlaster2(self, start, dir, damage, speed, flashtype, effect);
}

// ---------------------------------------------------------------------------
// widowlegs_think / Widowlegs_Spawn (rogue/g_rogue_spawn.cpp:265-367) --
// cosmetic legs-falling-apart prop shown at the end of the death sequence.
// See file header: ThrowSmallStuff/ThrowWidowGibSized are genuinely defined
// in the sibling m_rogue_widow2.cpp, imported directly.
// ---------------------------------------------------------------------------

const MAX_LEGSFRAME = 23;
const LEG_WAIT_TIME: GTime = Gtime_from_sec(1);

/** rogue/g_rogue_spawn.cpp:265-347. The two `//ThrowSmallStuff(self, point);`
 *  lines in the final block are commented out in the C++ source itself --
 *  kept commented here too, bug-for-bug (dead code the original authors
 *  left in place). */
const widowlegs_think: ThinkFn = (self: EdictT): void => {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  let point: Vec3 = vec3();

  if (self.s.frame === 17) {
    const offset = vec3(11.77, -7.24, 23.31);
    AngleVectors(self.s.angles, f, r, u);
    point = G_ProjectSource2(self.s.origin, offset, f, r, u);
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, KexMulticastT.MULTICAST_ALL, false);
    ThrowSmallStuff(self, point);
  }

  if (self.s.frame < MAX_LEGSFRAME) {
    self.s.frame++;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    return;
  } else if (self.wait === 0) {
    self.wait = Gtime_seconds(Gtime_add(level.time, LEG_WAIT_TIME));
  }

  if (level.time > Gtime_from_sec(self.wait)) {
    AngleVectors(self.s.angles, f, r, u);

    let offset = vec3(-65.6, -8.44, 28.59);
    point = G_ProjectSource2(self.s.origin, offset, f, r, u);
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, KexMulticastT.MULTICAST_ALL, false);
    ThrowSmallStuff(self, point);

    ThrowWidowGibSized(self, "models/monsters/blackwidow/gib1/tris.md2", 80 + Math.trunc(frandom(20.0)), GibTypeT.GIB_METALLIC, point, 0, true);
    ThrowWidowGibSized(self, "models/monsters/blackwidow/gib2/tris.md2", 80 + Math.trunc(frandom(20.0)), GibTypeT.GIB_METALLIC, point, 0, true);

    offset = vec3(-1.04, -51.18, 7.04);
    point = G_ProjectSource2(self.s.origin, offset, f, r, u);
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, KexMulticastT.MULTICAST_ALL, false);
    ThrowSmallStuff(self, point);

    ThrowWidowGibSized(self, "models/monsters/blackwidow/gib1/tris.md2", 80 + Math.trunc(frandom(20.0)), GibTypeT.GIB_METALLIC, point, 0, true);
    ThrowWidowGibSized(self, "models/monsters/blackwidow/gib2/tris.md2", 80 + Math.trunc(frandom(20.0)), GibTypeT.GIB_METALLIC, point, 0, true);
    ThrowWidowGibSized(self, "models/monsters/blackwidow/gib3/tris.md2", 80 + Math.trunc(frandom(20.0)), GibTypeT.GIB_METALLIC, point, 0, true);

    G_FreeEdict(self);
    return;
  }

  if (level.time > Gtime_from_sec(self.wait - 0.5) && self.count === 0) {
    self.count = 1;
    AngleVectors(self.s.angles, f, r, u);

    let offset = vec3(31, -88.7, 10.96);
    point = G_ProjectSource2(self.s.origin, offset, f, r, u);
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, KexMulticastT.MULTICAST_ALL, false);
    // ThrowSmallStuff(self, point);

    offset = vec3(-12.67, -4.39, 15.68);
    point = G_ProjectSource2(self.s.origin, offset, f, r, u);
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, KexMulticastT.MULTICAST_ALL, false);
    // ThrowSmallStuff(self, point);

    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    return;
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
};

/** rogue/g_rogue_spawn.cpp:350-367. */
function Widowlegs_Spawn(startpos: Vec3, angles: Vec3): void {
  const ent = G_Spawn();
  ent.s.origin = vec3(startpos[0], startpos[1], startpos[2]);
  ent.s.angles = vec3(angles[0], angles[1], angles[2]);
  ent.solid = SolidT.SOLID_NOT;
  ent.s.renderfx = RenderfxT.RF_IR_VISIBLE;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.classname = "widowlegs";

  ent.s.modelindex = gi.modelindex("models/monsters/legs/tris.md2");
  ent.think = widowlegs_think;

  ent.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// target_angle / WidowTorso (cpp:82-155)
// ---------------------------------------------------------------------------

function target_angle(self: EdictT): number {
  const enemy = must(self.enemy, "enemy", self);
  const target = vec3_sub(self.s.origin, enemy.s.origin);
  let enemy_yaw = self.s.angles[YAW] - vectoyaw(target);
  if (enemy_yaw < 0) enemy_yaw += 360.0;

  // this gets me 0 degrees = forward
  enemy_yaw -= 180.0;
  // positive is to right, negative to left

  return enemy_yaw;
}

function WidowTorso(self: EdictT): number {
  const enemy_yaw = target_angle(self);

  if (enemy_yaw >= 105) {
    M_SetAnimation(self, widow_move_attack_post_blaster_r, true);
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    return 0;
  }

  if (enemy_yaw <= -75.0) {
    M_SetAnimation(self, widow_move_attack_post_blaster_l, true);
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    return 0;
  }

  if (enemy_yaw >= 95) return FRAME_fired03;
  else if (enemy_yaw >= 85) return FRAME_fired04;
  else if (enemy_yaw >= 75) return FRAME_fired05;
  else if (enemy_yaw >= 65) return FRAME_fired06;
  else if (enemy_yaw >= 55) return FRAME_fired07;
  else if (enemy_yaw >= 45) return FRAME_fired08;
  else if (enemy_yaw >= 35) return FRAME_fired09;
  else if (enemy_yaw >= 25) return FRAME_fired10;
  else if (enemy_yaw >= 15) return FRAME_fired11;
  else if (enemy_yaw >= 5) return FRAME_fired12;
  else if (enemy_yaw >= -5) return FRAME_fired13;
  else if (enemy_yaw >= -15) return FRAME_fired14;
  else if (enemy_yaw >= -25) return FRAME_fired15;
  else if (enemy_yaw >= -35) return FRAME_fired16;
  else if (enemy_yaw >= -45) return FRAME_fired17;
  else if (enemy_yaw >= -55) return FRAME_fired18;
  else if (enemy_yaw >= -65) return FRAME_fired19;
  else if (enemy_yaw >= -75) return FRAME_fired20;

  return 0;
}

// ---------------------------------------------------------------------------
// search / sight (cpp:68-75)
// ---------------------------------------------------------------------------

export const widow_search: MonsterinfoSearchFn = RegisterMonsterinfoSearch("widow_search", (_self: EdictT): void => {});

export const widow_sight = RegisterMonsterinfoSight("widow_sight", (self: EdictT, _other: EdictT): void => {
  self.monsterinfo.fire_wait = GTIME_ZERO;
});

// ---------------------------------------------------------------------------
// WidowBlaster (cpp:159-252)
// ---------------------------------------------------------------------------

function WidowBlaster(self: EdictT): void {
  if (self.enemy === null) return;
  const enemy = self.enemy;

  shotsfired++;
  const effect: EffectsT = shotsfired % 4 === 0 ? EffectsT.EF_BLASTER : EffectsT.EF_NONE;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  if (self.s.frame >= FRAME_spawn05 && self.s.frame <= FRAME_spawn13) {
    // sweep
    const flashnum: MonsterMuzzleflashIdT = MonsterMuzzleflashIdT.MZ2_WIDOW_BLASTER_SWEEP1 + (self.s.frame - FRAME_spawn05);
    const start = G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right);
    const target = vec3_sub(enemy.s.origin, start);
    const targ_angles = vectoangles(target);

    const vec = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
    vec[PITCH] += targ_angles[PITCH];
    vec[YAW] -= sweep_angles[flashnum - MonsterMuzzleflashIdT.MZ2_WIDOW_BLASTER_SWEEP1];

    const fwd2 = vec3();
    AngleVectors(vec, fwd2, null, null);
    monster_fire_blaster2(self, start, fwd2, BLASTER2_DAMAGE * widow_damage_multiplier, 1000, flashnum, effect);
  } else if (self.s.frame >= FRAME_fired02a && self.s.frame <= FRAME_fired20) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;

    self.monsterinfo.nextframe = WidowTorso(self);

    if (!self.monsterinfo.nextframe) self.monsterinfo.nextframe = self.s.frame;

    const flashnum: MonsterMuzzleflashIdT =
      self.s.frame === FRAME_fired02a ? MonsterMuzzleflashIdT.MZ2_WIDOW_BLASTER_0 : MonsterMuzzleflashIdT.MZ2_WIDOW_BLASTER_100 + (self.s.frame - FRAME_fired03);

    const start = G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right);

    let aimdir = vec3();
    PredictAim(self, enemy, start, 1000, true, crandom() * 0.1, aimdir, null);

    // clamp it to within 10 degrees of the aiming angle (where she's facing)
    const angles = vectoangles(aimdir);
    // give me 100 -> -70
    let aim_angle = 100 - 10 * (flashnum - MonsterMuzzleflashIdT.MZ2_WIDOW_BLASTER_100);
    if (aim_angle <= 0) aim_angle += 360;
    let target_angle_deg = self.s.angles[YAW] - angles[YAW];
    if (target_angle_deg <= 0) target_angle_deg += 360;

    const error = aim_angle - target_angle_deg;

    // positive error is to entity's left, aka positive direction in engine
    // unfortunately, I decided that for the aim_angle, positive was right.  *sigh*
    if (error > VARIANCE) {
      angles[YAW] = self.s.angles[YAW] - aim_angle + VARIANCE;
      AngleVectors(angles, aimdir, null, null);
    } else if (error < -VARIANCE) {
      angles[YAW] = self.s.angles[YAW] - aim_angle - VARIANCE;
      AngleVectors(angles, aimdir, null, null);
    }

    monster_fire_blaster2(self, start, aimdir, BLASTER2_DAMAGE * widow_damage_multiplier, 1000, flashnum, effect);
  } else if (self.s.frame >= FRAME_run01 && self.s.frame <= FRAME_run08) {
    const flashnum: MonsterMuzzleflashIdT = MonsterMuzzleflashIdT.MZ2_WIDOW_RUN_1 + (self.s.frame - FRAME_run01);
    const start = G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right);

    const target = vec3_sub(enemy.s.origin, start);
    target[2] += enemy.viewheight;
    const targetNorm = vec3_normalized(target);

    monster_fire_blaster2(self, start, targetNorm, BLASTER2_DAMAGE * widow_damage_multiplier, 1000, flashnum, effect);
  }
}

// ---------------------------------------------------------------------------
// WidowSpawn / widow_spawn_check / widow_ready_spawn / widow_step /
// widow_stepshoot (cpp:254-399)
// ---------------------------------------------------------------------------

function WidowSpawn(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = spawnpoints[i];
    const startpoint = G_ProjectSource2(self.s.origin, offset, f, r, u);

    const spawnpoint = FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, 64);
    if (spawnpoint === null) continue;

    const ent = CreateGroundMonster(spawnpoint, self.s.angles, stalker_mins, stalker_maxs, "monster_stalker", 256);
    if (ent === null) continue;

    self.monsterinfo.monster_used++;
    ent.monsterinfo.commander = self;

    ent.nextthink = level.time;
    must(ent.think, "think", ent)(ent);

    ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_SPAWNED_WIDOW | MonsterAiFlagsT.AI_DO_NOT_COUNT | MonsterAiFlagsT.AI_IGNORE_SHOTS;

    let designated_enemy: EdictT | null;
    if (!coopEnabled()) {
      designated_enemy = self.enemy;
    } else {
      designated_enemy = PickCoopTarget(ent);
      if (designated_enemy !== null) {
        // try to avoid using my enemy
        if (designated_enemy === self.enemy) {
          designated_enemy = PickCoopTarget(ent);
          if (designated_enemy === null) designated_enemy = self.enemy;
        }
      } else {
        designated_enemy = self.enemy;
      }
    }

    if (designated_enemy !== null && designated_enemy.inuse && designated_enemy.health > 0) {
      ent.enemy = designated_enemy;
      FoundTarget(ent);
      must(ent.monsterinfo.attack, "monsterinfo.attack", ent)(ent);
    }
  }
}

function widow_spawn_check(self: EdictT): void {
  WidowBlaster(self);
  WidowSpawn(self);
}

function widow_ready_spawn(self: EdictT): void {
  WidowBlaster(self);
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = spawnpoints[i];
    const startpoint = G_ProjectSource2(self.s.origin, offset, f, r, u);
    const spawnpoint = FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, 64);
    if (spawnpoint === null) continue;

    const radius = vec3_length(vec3_sub(stalker_maxs, stalker_mins)) * 0.5;

    SpawnGrow_Spawn(vec3(spawnpoint[0] + stalker_mins[0] + stalker_maxs[0], spawnpoint[1] + stalker_mins[1] + stalker_maxs[1], spawnpoint[2] + stalker_mins[2] + stalker_maxs[2]), radius, radius * 2.0);
  }
}

function widow_step(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("widow/bwstep3.wav"), 1, ATTN_NORM, 0);
}

function widow_stepshoot(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("widow/bwstep2.wav"), 1, ATTN_NORM, 0);
  WidowBlaster(self);
}

// ---------------------------------------------------------------------------
// stand / walk / run moves (cpp:346-393)
// ---------------------------------------------------------------------------

const widow_frames_stand: MframeT[] = Array.from({ length: 11 }, () => mkframe(ai_stand));
const widow_move_stand = RegisterMmove("widow_move_stand", mkMove(FRAME_idle01, FRAME_idle11, widow_frames_stand, null));

const widow_frames_walk: MframeT[] = [
  mkframe(ai_walk, 2.79, widow_step),
  mkframe(ai_walk, 2.77),
  mkframe(ai_walk, 3.53),
  mkframe(ai_walk, 3.97),
  mkframe(ai_walk, 4.13),
  mkframe(ai_walk, 4.09),
  mkframe(ai_walk, 3.84),
  mkframe(ai_walk, 3.62, widow_step),
  mkframe(ai_walk, 3.29),
  mkframe(ai_walk, 6.08),
  mkframe(ai_walk, 6.94),
  mkframe(ai_walk, 5.73),
  mkframe(ai_walk, 2.85),
];
const widow_move_walk = RegisterMmove("widow_move_walk", mkMove(FRAME_walk01, FRAME_walk13, widow_frames_walk, null));

const widow_frames_run: MframeT[] = [
  mkframe(ai_run, 2.79, widow_step),
  mkframe(ai_run, 2.77),
  mkframe(ai_run, 3.53),
  mkframe(ai_run, 3.97),
  mkframe(ai_run, 4.13),
  mkframe(ai_run, 4.09),
  mkframe(ai_run, 3.84),
  mkframe(ai_run, 3.62, widow_step),
  mkframe(ai_run, 3.29),
  mkframe(ai_run, 6.08),
  mkframe(ai_run, 6.94),
  mkframe(ai_run, 5.73),
  mkframe(ai_run, 2.85),
];
const widow_move_run = RegisterMmove("widow_move_run", mkMove(FRAME_walk01, FRAME_walk13, widow_frames_run, null));

// ---------------------------------------------------------------------------
// MONSTERINFO_STAND/RUN/WALK -- registered here (moved ahead of the C's own
// textual position, cpp:767-786) so `widow_run` exists before any later
// frame table below stores it as an endfunc. See file header's
// "DECLARATION-ORDER RESHUFFLE" note.
// ---------------------------------------------------------------------------

export const widow_stand = RegisterMonsterinfoStand("widow_stand", (self: EdictT): void => {
  gi.sound(self, SoundchanT.CHAN_WEAPON, gi.soundindex("widow/laugh.wav"), 1, ATTN_NORM, 0);
  M_SetAnimation(self, widow_move_stand, true);
});

export const widow_run = RegisterMonsterinfoRun("widow_run", (self: EdictT): void => {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, widow_move_stand, true);
  else M_SetAnimation(self, widow_move_run, true);
});

export const widow_walk = RegisterMonsterinfoWalk("widow_walk", (self: EdictT): void => {
  M_SetAnimation(self, widow_move_walk, true);
});

// ---------------------------------------------------------------------------
// run_attack move + the three specific run-sequence entry points (cpp:
// 401-433)
// ---------------------------------------------------------------------------

const widow_frames_run_attack: MframeT[] = [
  mkframe(ai_charge, 13, widow_stepshoot),
  mkframe(ai_charge, 11.72, WidowBlaster),
  mkframe(ai_charge, 18.04, WidowBlaster),
  mkframe(ai_charge, 14.58, WidowBlaster),
  mkframe(ai_charge, 13, widow_stepshoot),
  mkframe(ai_charge, 12.12, WidowBlaster),
  mkframe(ai_charge, 19.63, WidowBlaster),
  mkframe(ai_charge, 11.37, WidowBlaster),
];
const widow_move_run_attack = RegisterMmove("widow_move_run_attack", mkMove(FRAME_run01, FRAME_run08, widow_frames_run_attack, widow_run));

// These three allow specific entry into the run sequence
function widow_start_run_5(self: EdictT): void {
  M_SetAnimation(self, widow_move_run, true);
  self.monsterinfo.nextframe = FRAME_walk05;
}

function widow_start_run_10(self: EdictT): void {
  M_SetAnimation(self, widow_move_run, true);
  self.monsterinfo.nextframe = FRAME_walk10;
}

function widow_start_run_12(self: EdictT): void {
  M_SetAnimation(self, widow_move_run, true);
  self.monsterinfo.nextframe = FRAME_walk12;
}

// ---------------------------------------------------------------------------
// widow_attack_blaster / widow_reattack_blaster -- moved ahead of their C
// textual position (cpp:906-929) so the pre_blaster/blaster frame tables
// below can store them as per-frame callbacks. See file header's
// "DECLARATION-ORDER RESHUFFLE" note.
// ---------------------------------------------------------------------------

function widow_attack_blaster(self: EdictT): void {
  self.monsterinfo.fire_wait = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(3)));
  M_SetAnimation(self, widow_move_attack_blaster, true);
  self.monsterinfo.nextframe = WidowTorso(self);
}

function widow_reattack_blaster(self: EdictT): void {
  WidowBlaster(self);

  // if WidowBlaster bailed us out of the frames, just bail
  if (self.monsterinfo.active_move === widow_move_attack_post_blaster_l || self.monsterinfo.active_move === widow_move_attack_post_blaster_r) return;

  // if we're not done with the attack, don't leave the sequence
  if (self.monsterinfo.fire_wait >= level.time) return;

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;

  M_SetAnimation(self, widow_move_attack_post_blaster, true);
}

// ---------------------------------------------------------------------------
// blaster attack frame tables (cpp:435-488)
// ---------------------------------------------------------------------------

const widow_frames_attack_pre_blaster: MframeT[] = [mkframe(ai_charge), mkframe(ai_charge), mkframe(ai_charge, 0, widow_attack_blaster)];
const widow_move_attack_pre_blaster = RegisterMmove("widow_move_attack_pre_blaster", mkMove(FRAME_fired01, FRAME_fired02a, widow_frames_attack_pre_blaster, null));

// Loop this
const widow_frames_attack_blaster: MframeT[] = Array.from({ length: 19 }, () => mkframe(ai_charge, 0, widow_reattack_blaster));
const widow_move_attack_blaster = RegisterMmove("widow_move_attack_blaster", mkMove(FRAME_fired02a, FRAME_fired20, widow_frames_attack_blaster, null));

const widow_frames_attack_post_blaster: MframeT[] = [mkframe(ai_charge), mkframe(ai_charge)];
const widow_move_attack_post_blaster = RegisterMmove("widow_move_attack_post_blaster", mkMove(FRAME_fired21, FRAME_fired22, widow_frames_attack_post_blaster, widow_run));

const widow_frames_attack_post_blaster_r: MframeT[] = [mkframe(ai_charge, -2), mkframe(ai_charge, -10), mkframe(ai_charge, -2), mkframe(ai_charge), mkframe(ai_charge, 0, widow_start_run_12)];
const widow_move_attack_post_blaster_r = RegisterMmove("widow_move_attack_post_blaster_r", mkMove(FRAME_transa01, FRAME_transa05, widow_frames_attack_post_blaster_r, null));

const widow_frames_attack_post_blaster_l: MframeT[] = [mkframe(ai_charge), mkframe(ai_charge, 14), mkframe(ai_charge, -2), mkframe(ai_charge, 10), mkframe(ai_charge, 10, widow_start_run_12)];
const widow_move_attack_post_blaster_l = RegisterMmove("widow_move_attack_post_blaster_l", mkMove(FRAME_transb01, FRAME_transb05, widow_frames_attack_post_blaster_l, null));

// ---------------------------------------------------------------------------
// WidowRail / WidowSaveLoc / widow_start_rail / widow_rail_done (cpp:
// 494-538)
// ---------------------------------------------------------------------------

function WidowRail(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  let flash: MonsterMuzzleflashIdT;
  if (self.monsterinfo.active_move === widow_move_attack_rail_l) flash = MonsterMuzzleflashIdT.MZ2_WIDOW_RAIL_LEFT;
  else if (self.monsterinfo.active_move === widow_move_attack_rail_r) flash = MonsterMuzzleflashIdT.MZ2_WIDOW_RAIL_RIGHT;
  else flash = MonsterMuzzleflashIdT.MZ2_WIDOW_RAIL;

  const start = G_ProjectSource(self.s.origin, monsterFlashOffset()[flash], forward, right);

  // calc direction to where we targeted
  const dir = vec3_normalized(vec3_sub(self.pos1, start));

  monster_fire_railgun(self, start, dir, WIDOW_RAIL_DAMAGE * widow_damage_multiplier, 100, flash);
  self.timestamp = Gtime_add(level.time, RAIL_TIME);
}

function WidowSaveLoc(self: EdictT): void {
  const enemy = must(self.enemy, "enemy", self);
  self.pos1 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
}

function widow_start_rail(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;
}

function widow_rail_done(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
}

// ---------------------------------------------------------------------------
// widow_attack_rail -- moved ahead of its C textual position (cpp:587-599)
// so `widow_frames_attack_pre_rail` below can store it as a per-frame
// callback. See file header's "DECLARATION-ORDER RESHUFFLE" note.
// ---------------------------------------------------------------------------

function widow_attack_rail(self: EdictT): void {
  const enemy_angle = target_angle(self);

  if (enemy_angle < -15) M_SetAnimation(self, widow_move_attack_rail_l, true);
  else if (enemy_angle > 15) M_SetAnimation(self, widow_move_attack_rail_r, true);
  else M_SetAnimation(self, widow_move_attack_rail, true);
}

// ---------------------------------------------------------------------------
// rail attack frame tables (cpp:540-585)
// ---------------------------------------------------------------------------

const widow_frames_attack_pre_rail: MframeT[] = [mkframe(ai_charge, 0, widow_start_rail), mkframe(ai_charge), mkframe(ai_charge), mkframe(ai_charge, 0, widow_attack_rail)];
const widow_move_attack_pre_rail = RegisterMmove("widow_move_attack_pre_rail", mkMove(FRAME_transc01, FRAME_transc04, widow_frames_attack_pre_rail, null));

const widow_frames_attack_rail: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, WidowSaveLoc),
  mkframe(ai_charge, -10, WidowRail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, widow_rail_done),
];
const widow_move_attack_rail = RegisterMmove("widow_move_attack_rail", mkMove(FRAME_firea01, FRAME_firea09, widow_frames_attack_rail, widow_run));

const widow_frames_attack_rail_r: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, WidowSaveLoc),
  mkframe(ai_charge, -10, WidowRail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, widow_rail_done),
];
const widow_move_attack_rail_r = RegisterMmove("widow_move_attack_rail_r", mkMove(FRAME_fireb01, FRAME_fireb09, widow_frames_attack_rail_r, widow_run));

const widow_frames_attack_rail_l: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, WidowSaveLoc),
  mkframe(ai_charge, -10, WidowRail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, widow_rail_done),
];
const widow_move_attack_rail_l = RegisterMmove("widow_move_attack_rail_l", mkMove(FRAME_firec01, FRAME_firec09, widow_frames_attack_rail_l, widow_run));

// ---------------------------------------------------------------------------
// spawn sequence (cpp:601-631)
// ---------------------------------------------------------------------------

function widow_start_spawn(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;
}

function widow_done_spawn(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
}

const widow_frames_spawn: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, widow_start_spawn),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, WidowBlaster),
  mkframe(ai_charge, 0, widow_ready_spawn),
  mkframe(ai_charge, 0, WidowBlaster),
  mkframe(ai_charge, 0, WidowBlaster),
  mkframe(ai_charge, 0, widow_spawn_check),
  mkframe(ai_charge, 0, WidowBlaster),
  mkframe(ai_charge, 0, WidowBlaster),
  mkframe(ai_charge, 0, WidowBlaster),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, widow_done_spawn),
];
const widow_move_spawn = RegisterMmove("widow_move_spawn", mkMove(FRAME_spawn01, FRAME_spawn18, widow_frames_spawn, widow_run));

// ---------------------------------------------------------------------------
// pain frame tables (cpp:633-655)
// ---------------------------------------------------------------------------

const widow_frames_pain_heavy: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_move));
const widow_move_pain_heavy = RegisterMmove("widow_move_pain_heavy", mkMove(FRAME_pain01, FRAME_pain13, widow_frames_pain_heavy, widow_run));

const widow_frames_pain_light: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const widow_move_pain_light = RegisterMmove("widow_move_pain_light", mkMove(FRAME_pain201, FRAME_pain203, widow_frames_pain_light, widow_run));

// ---------------------------------------------------------------------------
// death sequence -- spawn_out_start / spawn_out_do / widow_frames_death
// (cpp:657-743)
// ---------------------------------------------------------------------------

function spawn_out_start(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  let startpoint = G_ProjectSource2(self.s.origin, beameffects[0], f, r, u);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WIDOWBEAMOUT);
  gi.WriteShort(20001);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, KexMulticastT.MULTICAST_ALL, false);

  startpoint = G_ProjectSource2(self.s.origin, beameffects[1], f, r, u);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WIDOWBEAMOUT);
  gi.WriteShort(20002);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, KexMulticastT.MULTICAST_ALL, false);

  gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/bwidowbeamout.wav"), 1, ATTN_NORM, 0);
}

function spawn_out_do(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  let startpoint = G_ProjectSource2(self.s.origin, beameffects[0], f, r, u);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WIDOWSPLASH);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, KexMulticastT.MULTICAST_ALL, false);

  startpoint = G_ProjectSource2(self.s.origin, beameffects[1], f, r, u);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WIDOWSPLASH);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, KexMulticastT.MULTICAST_ALL, false);

  startpoint = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + 36);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_BOSSTPORT);
  gi.WritePosition(startpoint);
  gi.multicast(startpoint, KexMulticastT.MULTICAST_PHS, false);

  Widowlegs_Spawn(self.s.origin, self.s.angles);

  G_FreeEdict(self);
}

const widow_frames_death: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, spawn_out_start),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, spawn_out_do),
];
const widow_move_death = RegisterMmove("widow_move_death", mkMove(FRAME_death01, FRAME_death31, widow_frames_death, null));

// ---------------------------------------------------------------------------
// kick melee attack (cpp:745-765)
// ---------------------------------------------------------------------------

function widow_attack_kick(self: EdictT): void {
  const enemy = must(self.enemy, "enemy", self);
  const aim = vec3(100, 0, 4);
  if (enemy.groundentity !== null) fire_hit(self, aim, irandom(50, 56), 500);
  // not as much kick if they're in the air .. makes it harder to land on her head
  else fire_hit(self, aim, irandom(50, 56), 250);
}

const widow_frames_attack_kick: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, widow_attack_kick),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
const widow_move_attack_kick = RegisterMmove("widow_move_attack_kick", mkMove(FRAME_kick01, FRAME_kick08, widow_frames_attack_kick, widow_run));

// ---------------------------------------------------------------------------
// MONSTERINFO_ATTACK (cpp:788-904)
// ---------------------------------------------------------------------------

export const widow_attack = RegisterMonsterinfoAttack("widow_attack", (self: EdictT): void => {
  self.movetarget = null;

  let blocked = false;
  let anger = false;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_BLOCKED) !== 0n) {
    blocked = true;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
  }

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TARGET_ANGER) !== 0n) {
    anger = true;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TARGET_ANGER;
  }

  if (self.enemy === null || !self.enemy.inuse) return;

  if (self.bad_area !== null) {
    if (frandom() < 0.1 || level.time < self.timestamp) {
      M_SetAnimation(self, widow_move_attack_pre_blaster, true);
    } else {
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
      M_SetAnimation(self, widow_move_attack_pre_rail, true);
    }
    return;
  }

  // frames FRAME_walk13, FRAME_walk01, FRAME_walk02, FRAME_walk03 are rail gun start frames
  // frames FRAME_walk09, FRAME_walk10, FRAME_walk11, FRAME_walk12 are spawn & blaster start frames

  const rail_frames = self.s.frame === FRAME_walk13 || (self.s.frame >= FRAME_walk01 && self.s.frame <= FRAME_walk03);
  const blaster_frames = self.s.frame >= FRAME_walk09 && self.s.frame <= FRAME_walk12;

  WidowCalcSlots(self);

  // if we can't see the target, spawn stuff regardless of frame
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND && M_SlotsLeft(self) >= 2) {
    M_SetAnimation(self, widow_move_spawn, true);
    return;
  }

  // accept bias towards spawning regardless of frame
  if (blocked && M_SlotsLeft(self) >= 2) {
    M_SetAnimation(self, widow_move_spawn, true);
    return;
  }

  if (realrange(self, self.enemy) > 300 && !anger && frandom() < 0.5 && !blocked) {
    M_SetAnimation(self, widow_move_run_attack, true);
    return;
  }

  if (blaster_frames) {
    if (M_SlotsLeft(self) >= 2) {
      M_SetAnimation(self, widow_move_spawn, true);
      return;
    } else if (Gtime_add(self.monsterinfo.fire_wait, BLASTER_TIME) <= level.time) {
      M_SetAnimation(self, widow_move_attack_pre_blaster, true);
      return;
    }
  }

  if (rail_frames) {
    if (!(level.time < self.timestamp)) {
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
      M_SetAnimation(self, widow_move_attack_pre_rail, true);
    }
  }

  if (rail_frames || blaster_frames) return;

  const luck = frandom();
  if (M_SlotsLeft(self) >= 2) {
    if (luck <= 0.4 && Gtime_add(self.monsterinfo.fire_wait, BLASTER_TIME) <= level.time) {
      M_SetAnimation(self, widow_move_attack_pre_blaster, true);
    } else if (luck <= 0.7 && !(level.time < self.timestamp)) {
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
      M_SetAnimation(self, widow_move_attack_pre_rail, true);
    } else {
      M_SetAnimation(self, widow_move_spawn, true);
    }
  } else {
    if (level.time < self.timestamp) {
      M_SetAnimation(self, widow_move_attack_pre_blaster, true);
    } else if (luck <= 0.5 || Gtime_add(level.time, BLASTER_TIME) >= self.monsterinfo.fire_wait) {
      gi.sound(self, SoundchanT.CHAN_WEAPON, sound_rail.index, 1, ATTN_NORM, 0);
      M_SetAnimation(self, widow_move_attack_pre_rail, true);
    } else {
      // holdout to blaster
      M_SetAnimation(self, widow_move_attack_pre_blaster, true);
    }
  }
});

// ---------------------------------------------------------------------------
// pain / setskin / dead / die / melee (cpp:931-1004)
// ---------------------------------------------------------------------------

export const widow_pain: PainFn = RegisterPain("widow_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(5));

  if (damage < 15) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NONE, 0);
  else if (damage < 75) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NONE, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain3.index, 1, ATTN_NONE, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  self.monsterinfo.fire_wait = GTIME_ZERO;

  if (damage >= 15) {
    const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
    if (damage < 75) {
      if (skillInt < 3 && frandom() < 0.6 - 0.2 * skillInt) {
        M_SetAnimation(self, widow_move_pain_light, true);
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
      }
    } else {
      if (skillInt < 3 && frandom() < 0.75 - 0.1 * skillInt) {
        M_SetAnimation(self, widow_move_pain_heavy, true);
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
      }
    }
  }
});

export const widow_setskin = RegisterMonsterinfoSetskin("widow_setskin", (self: EdictT): void => {
  self.s.skinnum = self.health < self.max_health / 2 ? 1 : 0;
});

/** cpp:979-987. Declared and defined but never called anywhere in the C++
 *  source (verified by grepping the whole file) -- `widow_die` sets
 *  `widow_move_death` directly instead. Dead code in the original, ported
 *  verbatim for bug-for-bug fidelity (same as `widow_start_run_5`/
 *  `widow_start_run_10` above). */
function widow_dead(self: EdictT): void {
  self.mins = vec3(-56, -56, 0);
  self.maxs = vec3(56, 56, 80);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.nextthink = GTIME_ZERO;
  gi.linkentity(self);
}

export const widow_die: DieFn = RegisterDie("widow_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  self.deadflag = true;
  self.takedamage = false;
  self.count = 0;
  self.monsterinfo.quad_time = GTIME_ZERO;
  self.monsterinfo.double_time = GTIME_ZERO;
  self.monsterinfo.invincible_time = GTIME_ZERO;
  M_SetAnimation(self, widow_move_death, true);
});

export const widow_melee = RegisterMonsterinfoMelee("widow_melee", (self: EdictT): void => {
  M_SetAnimation(self, widow_move_attack_kick, true);
});

// ---------------------------------------------------------------------------
// powerup response (cpp:1006-1125)
// ---------------------------------------------------------------------------

function WidowGoinQuad(self: EdictT, time: GTime): void {
  self.monsterinfo.quad_time = time;
  widow_damage_multiplier = 4;
}

function WidowDouble(self: EdictT, time: GTime): void {
  self.monsterinfo.double_time = time;
  widow_damage_multiplier = 2;
}

function WidowPent(self: EdictT, time: GTime): void {
  self.monsterinfo.invincible_time = time;
}

function WidowPowerArmor(self: EdictT): void {
  self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  // I don't like this, but it works
  if (self.monsterinfo.power_armor_power <= 0) self.monsterinfo.power_armor_power += 250 * skillInt;
}

function WidowRespondPowerup(self: EdictT, other: EdictT): void {
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  const otherClient = must(other.client, "client", other);

  if ((other.s.effects & EffectsT.EF_QUAD) !== 0n) {
    if (skillInt === 1) WidowDouble(self, otherClient.quad_time);
    else if (skillInt === 2) WidowGoinQuad(self, otherClient.quad_time);
    else if (skillInt === 3) {
      WidowGoinQuad(self, otherClient.quad_time);
      WidowPowerArmor(self);
    }
  } else if ((other.s.effects & EffectsT.EF_DOUBLE) !== 0n) {
    if (skillInt === 2) WidowDouble(self, otherClient.double_time);
    else if (skillInt === 3) {
      WidowDouble(self, otherClient.double_time);
      WidowPowerArmor(self);
    }
  } else {
    widow_damage_multiplier = 1;
  }

  if ((other.s.effects & EffectsT.EF_PENT) !== 0n) {
    if (skillInt === 1) WidowPowerArmor(self);
    else if (skillInt === 2) WidowPent(self, otherClient.invincible_time);
    else if (skillInt === 3) {
      WidowPent(self, otherClient.invincible_time);
      WidowPowerArmor(self);
    }
  }
}

function WidowPowerups(self: EdictT): void {
  if (!coopEnabled()) {
    WidowRespondPowerup(self, must(self.enemy, "enemy", self));
    return;
  }

  // in coop, check for pents, then quads, then doubles
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse || ent.client === null) continue;
    if ((ent.s.effects & EffectsT.EF_PENT) !== 0n) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse || ent.client === null) continue;
    if ((ent.s.effects & EffectsT.EF_QUAD) !== 0n) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse || ent.client === null) continue;
    if ((ent.s.effects & EffectsT.EF_DOUBLE) !== 0n) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// MONSTERINFO_CHECKATTACK / MONSTERINFO_BLOCKED (cpp:1127-1182)
// ---------------------------------------------------------------------------

export const Widow_CheckAttack = RegisterMonsterinfoCheckattack("Widow_CheckAttack", (self: EdictT): boolean => {
  if (self.enemy === null) return false;

  WidowPowerups(self);

  if (self.monsterinfo.active_move === widow_move_run) {
    // if we're in run, make sure we're in a good frame for attacking before doing anything else
    // frames 1,2,3,9,10,11,13 good to fire
    switch (self.s.frame) {
      case FRAME_walk04:
      case FRAME_walk05:
      case FRAME_walk06:
      case FRAME_walk07:
      case FRAME_walk08:
      case FRAME_walk12:
        return false;
      default:
        break;
    }
  }

  // give a LARGE bias to spawning things when we have room
  // use AI_BLOCKED as a signal to attack to spawn
  if (frandom() < 0.8 && M_SlotsLeft(self) >= 2 && realrange(self, self.enemy) > 150) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BLOCKED;
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    return true;
  }

  return M_CheckAttack_Base(self, 0.4, 0.8, 0.7, 0.6, 0.5, 0.0);
});

export const widow_blocked = RegisterMonsterinfoBlocked("widow_blocked", (self: EdictT, _dist: number): boolean => {
  // if we get blocked while we're in our run/attack mode, turn on a meaningless (in this context) AI flag,
  // and call attack to get a new attack sequence.  make sure to turn it off when we're done.
  //
  // I'm using AI_TARGET_ANGER for this purpose

  if (self.monsterinfo.active_move === widow_move_run_attack) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_TARGET_ANGER;
    if (must(self.monsterinfo.checkattack, "monsterinfo.checkattack", self)(self)) must(self.monsterinfo.attack, "monsterinfo.attack", self)(self);
    else must(self.monsterinfo.run, "monsterinfo.run", self)(self);
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// WidowCalcSlots / WidowPrecache (cpp:1184-1240)
// ---------------------------------------------------------------------------

function WidowCalcSlots(self: EdictT): void {
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  switch (skillInt) {
    case 0:
    case 1:
      self.monsterinfo.monster_slots = 3;
      break;
    case 2:
      self.monsterinfo.monster_slots = 4;
      break;
    case 3:
      self.monsterinfo.monster_slots = 6;
      break;
    default:
      self.monsterinfo.monster_slots = 3;
      break;
  }
  if (coopEnabled()) {
    self.monsterinfo.monster_slots = Math.min(6, self.monsterinfo.monster_slots + skillInt * (CountPlayers() - 1));
  }
}

function WidowPrecache(): void {
  // cache in all of the stalker stuff, widow stuff, spawngro stuff, gibs
  gi.soundindex("stalker/pain.wav");
  gi.soundindex("stalker/death.wav");
  gi.soundindex("stalker/sight.wav");
  gi.soundindex("stalker/melee1.wav");
  gi.soundindex("stalker/melee2.wav");
  gi.soundindex("stalker/idle.wav");

  gi.soundindex("tank/tnkatck3.wav");
  gi.modelindex("models/objects/laser/tris.md2");

  gi.modelindex("models/monsters/stalker/tris.md2");
  gi.modelindex("models/items/spawngro3/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");
  gi.modelindex("models/objects/gibs/gear/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib1/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib2/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib3/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib4/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib1/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib2/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib3/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib4/tris.md2");
  gi.modelindex("models/monsters/legs/tris.md2");
  gi.soundindex("misc/bwidowbeamout.wav");

  gi.soundindex("misc/bigtele.wav");
  gi.soundindex("widow/bwstep3.wav");
  gi.soundindex("widow/bwstep2.wav");
  gi.soundindex("widow/bwstep1.wav");
}

// ---------------------------------------------------------------------------
// SP_monster_widow (cpp:1242-1305)
// QUAKED monster_widow (1 .5 0) (-40 -40 0) (40 40 144) Ambush Trigger_Spawn Sight
// ---------------------------------------------------------------------------

export function SP_monster_widow(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_pain1, "widow/bw1pain1.wav");
  assignSound(sound_pain2, "widow/bw1pain2.wav");
  assignSound(sound_pain3, "widow/bw1pain3.wav");
  assignSound(sound_rail, "gladiator/railgun.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/blackwidow/tris.md2");
  self.mins = vec3(-40, -40, 0);
  self.maxs = vec3(40, 40, 144);

  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  self.health = (2000 + 1000 * skillInt) * st.health_multiplier;
  if (coopEnabled()) self.health += 500 * skillInt;
  self.gib_health = -5000;
  self.mass = 1500;

  if (skillInt === 3) {
    if (!st.keys_specified.has("power_armor_type")) self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;
    if (!st.keys_specified.has("power_armor_power")) self.monsterinfo.power_armor_power = 500;
  }

  self.yaw_speed = 30;

  self.flags |= EntFlagsT.FL_IMMUNE_LASER;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;

  self.pain = widow_pain;
  self.die = widow_die;

  self.monsterinfo.melee = widow_melee;
  self.monsterinfo.stand = widow_stand;
  self.monsterinfo.walk = widow_walk;
  self.monsterinfo.run = widow_run;
  self.monsterinfo.attack = widow_attack;
  self.monsterinfo.search = widow_search;
  self.monsterinfo.checkattack = Widow_CheckAttack;
  self.monsterinfo.sight = widow_sight;
  self.monsterinfo.setskin = widow_setskin;
  self.monsterinfo.blocked = widow_blocked;

  gi.linkentity(self);

  M_SetAnimation(self, widow_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  WidowPrecache();
  WidowCalcSlots(self);
  widow_damage_multiplier = 1;

  walkmonster_start(self);
}
