// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_guncmdr.c -- the GUN COMMANDER monster (2023 Quake II re-release / "KEX"
// engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/
// m_guncmdr.cpp (1,473 lines, C++17). Re-release-only content: there is no
// 3.21 baseq2/xatrix/rogue precedent anywhere in this tree for this monster
// -- the C++ is the only source of truth. Full stand/fidget/walk/run/pain
// (x7)/death (x7)/setskin/die system, chaingun attack (with two dodge
// variants), three grenade-launcher patterns (mortar arc, front-facing arc,
// crouched ionripper burst), a kick melee, a duck-and-counter-slam attack,
// and PGM/PMM jump-over-obstacle logic.
//
// ============================================================================
// #include "m_gunner.h" -- the FRAME_c_* constants belong to THIS monster
// ============================================================================
// m_guncmdr.cpp does not have its own m_guncmdr.h; its `#include "m_gunner.h"`
// pulls frame constants from the SECOND half of that 809-line header
// (FRAME_c_stand101..FRAME_c_duckdeath29, ~330 entries) that m_gunner.ts's
// own header already flagged as "belongs to a DIFFERENT monster" and
// deliberately did not transcribe, precisely so this file could land it.
// Absolute indices: m_gunner.h's first (gunner-owned) FRAME_ block runs
// 0..248 (249 entries, confirmed via `m_gunner.ts`'s own `FRAME_attak324 =
// 248`), so `FRAME_c_stand101 = 249` and the block continues sequentially
// through `FRAME_c_duckdeath29 = 798`. Per the leaner "only declare the
// FRAME_ constants actually referenced by this monster's own .cpp" style
// established by the sibling m_gladiator.ts unit (and explicitly endorsed by
// m_gunner.ts's own header for this exact FRAME_c_ situation), only the ~75
// boundary/comparison constants `m_guncmdr.cpp` itself names by identifier
// are declared below (every `mmove_t`'s firstframe/lastframe and every
// `self->s.frame == FRAME_c_...` comparison); frames referenced only by
// position inside an `mframe_t[]` array need no name.
//
// ============================================================================
// SHARED DUCK/DODGE INFRASTRUCTURE -- imported from m_soldier.ts, not
// re-registered
// ============================================================================
// `M_MonsterDodge`, `monster_duck_down`, `monster_duck_hold`,
// `monster_duck_up`, and `monster_done_dodge` are the rogue "new AI"
// dodge/duck system (rogue/g_rogue_newai.cpp), which m_soldier.ts already
// ports as real logic and exports specifically so later files reuse the same
// function VALUES instead of re-registering under the same name a second
// time (g_save_registry.ts throws "duplicate ... registration" the moment
// two files both call e.g. `RegisterMonsterinfoUnduck("monster_duck_up", ...)`
// and both load in the same process, which the real game's g_spawn.ts does
// for every monster file). `monster_duck_up` is used directly as
// `self.monsterinfo.unduck` below with NO further `RegisterMonsterinfoUnduck`
// call -- m_soldier.ts already registered it once, under its own file.
// `blocked_checkplat` (also rogue-newai) is NOT exported by m_soldier.ts (see
// that file's header), so it is duplicated locally here instead, verbatim,
// matching the established "duplicated per-file, not imported" convention
// for un-registered helpers (m_soldier.ts's own header documents this same
// choice for its local `traceEdict`/`giTraceline`/`M_CheckGib`/
// `monster_footstep` copies).
//
// ============================================================================
// PredictAim / M_CalculatePitchToFire -- imported from m_supertank.ts, not
// re-implemented as a stub
// ============================================================================
// Both are rogue/g_rogue_newai.cpp content (`PredictAim`:1083-1135,
// `M_CalculatePitchToFire`:1136-1196). m_soldier.ts keeps its OWN local copy
// of `PredictAim` as a cited throwing stub because soldier's callers never
// reach it in practice; guncmdr's chaingun attack (`GunnerCmdrFire`) calls
// `PredictAim` on EVERY chaingun shot -- its single most common attack -- so
// a throwing stub here would be the exact "landmine" m_soldier.ts's own
// header warns against for its rogue-newai dodge functions. m_supertank.ts
// already ports both as real, exported logic (shared with its own
// `supertankGrenade`), so this file imports that implementation instead of
// duplicating ~150 lines of ballistic-arc simulation a second time.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED (throwing stubs, cited)
// ============================================================================
// - `blocked_checkjump(edict_t*, float)` / `blocked_jump_result_t`: declared
//   in g_local.h, but the only BODY in the whole rerelease source tree is
//   rogue/g_rogue_newai.cpp:123 -- rogue (Ground Zero) content, out of scope
//   for this base-game-plus-KEX porting round. This is the SAME gap, same
//   citation, and same throwing-stub treatment already landed identically in
//   m_gunner.ts, m_infantry.ts, m_berserk.ts, m_mutant.ts, and m_parasite.ts
//   -- `guncmdr_blocked` calls it exactly like `gunner_blocked` does, and
//   genuinely throws if a jumpable gap ever blocks this monster's path
//   today. `guncmdr_jump`/`guncmdr_jump2`/`guncmdr_jump_now`/
//   `guncmdr_jump2_now`/`guncmdr_jump_wait_land` are still ported for real
//   below (unreachable via the stubbed path today, not deleted -- a future
//   g_rogue_newai.ts unit wires them back up with zero changes here).
//   `monster_jump_finished` (rogue/g_rogue_newai.cpp:101-117), by contrast,
//   IS ported for real (matching m_parasite.ts's/m_mutant.ts's identical
//   choice), since `guncmdr_jump_wait_land` calls it directly.
// - `fire_ionripper(edict_t*, const vec3_t&, const vec3_t&, int, int,
//   effects_t)`: declared in g_local.h:2334, but its only body is
//   xatrix/g_xatrix_weapon.cpp:91 -- xatrix mission-pack content, the same
//   kind of gap m_soldier.ts's header already documents for the sibling
//   `monster_fire_ionripper` (xatrix/g_xatrix_monster.cpp:14). Distinct
//   function: this is the raw player-weapon-shaped primitive `guncmdr`'s
//   crouched grenade pattern calls directly (three-shot burst), not the
//   `monster_fire_*` wrapper soldier stubs. A narrow gap, not a landmine:
//   only `GunnerCmdrGrenade`'s `MZ2_GUNCMDR_GRENADE_CROUCH_1..3` branch
//   (one of guncmdr's three grenade patterns) is affected; the chaingun,
//   mortar, and front-grenade attacks are untouched.
//
// ============================================================================
// T_SlamRadiusDamage -- duplicated locally from m_berserk.ts, not imported
// ============================================================================
// `guncmdr.cpp:1272` forward-declares `T_SlamRadiusDamage` exactly like
// m_berserk.cpp does (its own real body lives at m_berserk.cpp:212-255,
// called by berserk's jump-slam attack) -- guncmdr's duck-and-counter attack
// (`GunnerCmdrCounter`) calls the SAME external function. m_berserk.ts's
// copy is not exported, so this file duplicates the identical body locally,
// per the established "duplicated per-file, not imported" convention for
// un-registered helpers with no home module.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - `GunnerGrenade`/`GunnerFire` (guncmdr.cpp:40-41): forward-declared but
//   never defined or called anywhere in guncmdr.cpp itself (vestigial
//   copy-paste leftovers from m_gunner.cpp, where the real functions of
//   those names live) -- not ported, since there is no behavior to port.
// - `flash_number` and `spread` in `GunnerCmdrGrenade` are C++ locals with
//   NO initializer, assigned only inside an if/else-if chain with no final
//   `else` (every real call site's `self->s.frame` is one of the nine
//   frames the chain covers, so the C++ never actually reads them
//   unassigned) -- TypeScript requires definite assignment, so both get a
//   placeholder initial value (`spread = 0`, `flash_number =
//   MZ2_GUNCMDR_GRENADE_MORTAR_1`) that every real call path overwrites
//   before use, matching the C++'s actual runtime behavior exactly.
// - Vec3 arithmetic chains (`aim = forward + right*spread; aim += up*pitch;
//   aim.normalize();`) use q_vec3.ts's functional `vec3_add`/`vec3_muls`/
//   `vec3_normalize` helpers (the latter mutates in place, matching C++
//   `vec3_t::normalize()`), not the C++ operator overloads.
// - `world` / `EDICT_NUM` idioms (`traceEdict`, `giTraceline`) are per-file
//   local duplicates of the identical helpers in g_monster.ts/m_soldier.ts/
//   m_berserk.ts, matching this port line's established convention.
// - `mkframe`/`mkMove` are small local builders for `MframeT`/`MmoveT`,
//   standing in for the C++ `{ ... }` aggregate-initializer / `MMOVE_T(name)
//   = { ... }` macro syntax, duplicated per-file like every other landed
//   monster module.
// - `FRAME_TIME_S` (used by `guncmdr_pain`'s in-pain-debounce dodge call) is
//   not yet a real global in this port line (g_phys.ts's own header explains
//   the gap: `InitGame`/`g_main.ts` has not landed); duplicated locally as
//   `frameTimeAsGtime()` exactly like g_phys.ts's own workaround.
// - Forward-referenced handlers (`guncmdr_stand`/`guncmdr_run`/
//   `guncmdr_dead` are referenced as endfunc/thinkfunc VALUES inside frame
//   tables declared textually before their own definitions, matching the
//   C++'s forward declarations) are written as hoisted `function name() {}`
//   declarations throughout, per m_soldier.ts's established rationale (TS
//   function declarations are hoisted with their full body; `const x =
//   arrow` is not).

import { vec3, type Vec3, VectorCopy } from "../shared/math";
import { AngleVectors, vec3_add, vec3_sub, vec3_muls, vec3_dot, vec3_normalize, vec3_normalized, vec3_length, closest_point_to_box } from "./q_vec3";
import {
  MonsterMuzzleflashIdT,
  SolidT,
  SoundchanT,
  EffectsT,
  ContentsT,
  MASK_MONSTERSOLID,
  MASK_SOLID,
  ServerCommandT,
  KexTempEventT,
  KexMulticastT,
  SvflagsT,
  ATTN_NORM,
  ATTN_IDLE,
  type KexTraceT,
  type KexEdictT,
} from "../kexapi/game";
import {
  type EdictT,
  MovetypeT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  BlockedJumpResultT,
  RANGE_MELEE,
  MELEE_DISTANCE,
  GibTypeT,
  DamageflagsT,
  ModIdT,
  ItemIdT,
} from "./g_local";
import type { ModT } from "./g_local_types";
import { gi, level, g_edicts } from "./g_main_globals";
import { st } from "./g_spawn";
import { SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import {
  MframeT,
  MmoveT,
  PainFn,
  DieFn,
  MonsterinfoStandFn,
  MonsterinfoWalkFn,
  MonsterinfoRunFn,
  MonsterinfoAttackFn,
  MonsterinfoSightFn,
  MonsterinfoSearchFn,
  MonsterinfoSetskinFn,
  MonsterinfoBlockedFn,
  MonsterinfoDuckFn,
  MonsterinfoSidestepFn,
} from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMonsterinfoDuck,
  RegisterMonsterinfoSidestep,
} from "./g_save_registry";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, visible, range_to } from "./g_ai";
import { ai_check_move } from "./m_move";
import { monster_fire_flechette, monster_fire_grenade, M_ProjectFlashSource, M_CheckClearShot, M_ShouldReactToPain, M_SetAnimation, M_AllowSpawn, monster_dead, walkmonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { PredictAim, M_CalculatePitchToFire } from "./m_supertank";
import { M_MonsterDodge, monster_duck_down, monster_duck_hold, monster_duck_up, monster_done_dodge } from "./m_soldier";
import { ThrowGib, ThrowGibs } from "./g_misc";
import { G_FreeEdict, findradius } from "./g_utils";
import { T_Damage, CanDamage } from "./g_combat";
import { fire_hit } from "./g_weapon";
import { frandom, brandom, irandom, crandom_open } from "./q_std";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, type GTime } from "./gtime";

// ---------------------------------------------------------------------------
// m_gunner.h's FRAME_c_* half (see file header). Only the boundary/comparison
// constants m_guncmdr.cpp itself names by identifier.
// ---------------------------------------------------------------------------

export const FRAME_c_stand101 = 249;
export const FRAME_c_stand140 = 288;
export const FRAME_c_stand201 = 289;
export const FRAME_c_stand254 = 342;
export const FRAME_c_attack101 = 343;
export const FRAME_c_attack106 = 348;
export const FRAME_c_attack107 = 349;
export const FRAME_c_attack112 = 354;
export const FRAME_c_attack118 = 360;
export const FRAME_c_attack124 = 366;
export const FRAME_c_jump01 = 367;
export const FRAME_c_jump10 = 376;
export const FRAME_c_attack201 = 377;
export const FRAME_c_attack205 = 381;
export const FRAME_c_attack208 = 384;
export const FRAME_c_attack211 = 387;
export const FRAME_c_attack221 = 397;
export const FRAME_c_attack302 = 399;
export const FRAME_c_attack304 = 401;
export const FRAME_c_attack307 = 404;
export const FRAME_c_attack310 = 407;
export const FRAME_c_attack321 = 418;
export const FRAME_c_attack401 = 419;
export const FRAME_c_attack405 = 423;
export const FRAME_c_attack501 = 424;
export const FRAME_c_attack505 = 428;
export const FRAME_c_attack601 = 429;
export const FRAME_c_attack605 = 433;
export const FRAME_c_attack701 = 434;
export const FRAME_c_attack705 = 438;
export const FRAME_c_pain101 = 439;
export const FRAME_c_pain104 = 442;
export const FRAME_c_pain201 = 443;
export const FRAME_c_pain204 = 446;
export const FRAME_c_pain301 = 447;
export const FRAME_c_pain304 = 450;
export const FRAME_c_pain401 = 451;
export const FRAME_c_pain415 = 465;
export const FRAME_c_pain501 = 466;
export const FRAME_c_pain508 = 473;
export const FRAME_c_pain524 = 489;
export const FRAME_c_death101 = 490;
export const FRAME_c_death118 = 507;
export const FRAME_c_death201 = 508;
export const FRAME_c_death204 = 511;
export const FRAME_c_death301 = 512;
export const FRAME_c_death321 = 532;
export const FRAME_c_death401 = 533;
export const FRAME_c_death436 = 568;
export const FRAME_c_death501 = 569;
export const FRAME_c_death528 = 596;
export const FRAME_c_run101 = 597;
export const FRAME_c_run106 = 602;
export const FRAME_c_run201 = 603;
export const FRAME_c_run206 = 608;
export const FRAME_c_walk101 = 615;
export const FRAME_c_walk124 = 638;
export const FRAME_c_pain601 = 639;
export const FRAME_c_pain607 = 645;
export const FRAME_c_pain632 = 670;
export const FRAME_c_death601 = 671;
export const FRAME_c_death614 = 684;
export const FRAME_c_death701 = 685;
export const FRAME_c_death730 = 714;
export const FRAME_c_pain701 = 715;
export const FRAME_c_pain714 = 728;
export const FRAME_c_attack801 = 729;
export const FRAME_c_attack808 = 736;
export const FRAME_c_attack901 = 738;
export const FRAME_c_attack911 = 748;
export const FRAME_c_attack912 = 749;
export const FRAME_c_attack913 = 750;
export const FRAME_c_attack919 = 756;
export const FRAME_c_duckstep01 = 759;
export const FRAME_c_duckstep06 = 764;

export const MODEL_SCALE = 1.15;

const SPAWNFLAG_GUNCMDR_NOJUMPING: SpawnFlags = SpawnFlags_from(8);

// ---------------------------------------------------------------------------
// cached_soundindex fields
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

const sound_pain = mkSound();
const sound_pain2 = mkSound();
const sound_death = mkSound();
const sound_idle = mkSound();
const sound_open = mkSound();
const sound_search = mkSound();
const sound_sight = mkSound();

// ---------------------------------------------------------------------------
// Locally-ported shared infra -- see file header.
// ---------------------------------------------------------------------------

/** g_local.h:3281-3286 `inline void monster_footstep(edict_t *self)`. */
function monster_footstep(self: EdictT): void {
  if (self.groundentity !== null) self.s.event = 2 /* EV_OTHER_FOOTSTEP, see kexapi/game.ts EntityEventT */;
}

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

/** EDICT_NUM idiom -- see m_soldier.ts's own `traceEdict` for the full rationale. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** g_local.h:136-139 `game_import_t::traceline` -- see m_soldier.ts's own `giTraceline` for the full rationale. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** rogue/g_rogue_newai.cpp:14-88 `bool blocked_checkplat(edict_t *self, float dist)`. See file header. */
function blocked_checkplat(self: EdictT, dist: number): boolean {
  const enemy = self.enemy;
  if (enemy === null) return false;

  let playerPosition: number;
  if (enemy.absmin[2] >= self.absmax[2]) playerPosition = 1;
  else if (enemy.absmax[2] <= self.absmin[2]) playerPosition = -1;
  else playerPosition = 0;

  if (playerPosition === 0) return false;

  let plat: EdictT | null = null;

  if (self.groundentity !== null && self.groundentity !== g_edicts[0]) {
    if ((self.groundentity.classname ?? "").slice(0, 8) === "func_pla") plat = self.groundentity;
  }

  if (plat === null) {
    const forward = vec3(0, 0, 0);
    AngleVectors(self.s.angles, forward, null, null);
    const pt1 = vec3_add(self.s.origin, vec3_muls(forward, dist));
    const pt2 = vec3(pt1[0], pt1[1], pt1[2] - 384);

    const trace = giTraceline(pt1, pt2, self, MASK_MONSTERSOLID);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid && trace.ent !== null) {
      const hit = traceEdict(trace.ent);
      if ((hit.classname ?? "").slice(0, 8) === "func_pla") plat = hit;
    }
  }

  if (plat !== null && plat.use !== null) {
    if (playerPosition === 1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === 3 /* STATE_BOTTOM, see g_local.ts's MoveStateT */) ||
        (self.groundentity !== plat && plat.moveinfo.state === 1 /* STATE_TOP */)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    } else if (playerPosition === -1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === 1 /* STATE_TOP */) ||
        (self.groundentity !== plat && plat.moveinfo.state === 3 /* STATE_BOTTOM */)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    }
  }

  return false;
}

/** rogue/g_rogue_newai.cpp:101-117. See file header. */
function monster_jump_finished(self: EdictT): boolean {
  const forward = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, null, null);
  const forward_velocity = vec3_muls(forward, vec3_dot(self.velocity, forward));

  if (Math.hypot(forward_velocity[0], forward_velocity[1], forward_velocity[2]) < 150) {
    const z_velocity = self.velocity[2];
    self.velocity = vec3_muls(forward, 150);
    self.velocity[2] = z_velocity;
  }

  return self.monsterinfo.jump_time < level.time;
}

/** `blocked_jump_result_t blocked_checkjump(edict_t*, float)` -- see file header. */
function blocked_checkjump(_self: EdictT, _dist: number): BlockedJumpResultT {
  throw new Error("blocked_checkjump: not yet ported (rogue mission-pack content, see rogue/g_rogue_newai.cpp:123)");
}

/** `void fire_ionripper(edict_t*, const vec3_t&, const vec3_t&, int, int, effects_t)` -- see file header. */
function fire_ionripper(self: EdictT, _start: Vec3, _aimdir: Vec3, _damage: number, _speed: number, _effect: EffectsT): void {
  throw new Error(`fire_ionripper: not yet ported (xatrix mission pack, see xatrix/g_xatrix_weapon.cpp:91) -- called against ${self.classname ?? "?"}`);
}

/** m_berserk.cpp:212-255, forward-declared by guncmdr.cpp:1272. See file header. */
function T_SlamRadiusDamage(pointIn: Vec3, inflictor: EdictT, attacker: EdictT, damage: number, kick: number, ignore: EdictT, radius: number, mod: ModT): void {
  const point = vec3(pointIn[0], pointIn[1], pointIn[2]);
  let ent: EdictT | null = null;

  while ((ent = findradius(ent, inflictor.s.origin, radius * 2.0)) !== null) {
    if (ent === ignore) continue;
    if (!ent.takedamage) continue;
    if (!CanDamage(ent, inflictor)) continue;
    if (ent.client !== null && ent.groundentity === null) continue;

    const v = vec3_sub(closest_point_to_box(point, vec3_add(ent.s.origin, ent.mins), vec3_add(ent.s.origin, ent.maxs)), point);

    const amount0 = Math.min(1.0, 1.0 - vec3_length(v) / radius);
    if (amount0 <= 0.0) continue;

    const amount = amount0 * amount0;
    const points = Math.max(1.0, damage * amount);
    const dir = vec3_normalized(vec3_sub(ent.s.origin, point));

    point[2] = ent.absmin[2];

    T_Damage(ent, inflictor, attacker, dir, point, dir, Math.trunc(points), Math.trunc(kick * amount), DamageflagsT.DAMAGE_RADIUS, mod);

    if (ent.client !== null) ent.velocity[2] = Math.max(270.0, ent.velocity[2]);
  }
}

/** See g_phys.ts's own "FRAME_TIME_S" header note -- duplicated locally. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see file header.
// ---------------------------------------------------------------------------

type Aifunc = (self: EdictT, dist: number) => void;
type Thinkfunc = (self: EdictT) => void;

function mkframe(aifunc: Aifunc | null, dist = 0, thinkfunc: Thinkfunc | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: Thinkfunc | null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// ---------------------------------------------------------------------------
// guncmdr_idlesound / guncmdr_sight / guncmdr_search (guncmdr.cpp:25-38)
// ---------------------------------------------------------------------------

function guncmdr_idlesound(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_idle.index, 1, ATTN_IDLE, 0);
}

function guncmdr_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight.index, 1, ATTN_NORM, 0);
}
RegisterMonsterinfoSight("guncmdr_sight", guncmdr_sight);

function guncmdr_search(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_search.index, 1, ATTN_NORM, 0);
}
RegisterMonsterinfoSearch("guncmdr_search", guncmdr_search);

// ---------------------------------------------------------------------------
// fidget / stand (guncmdr.cpp:47-170)
// ---------------------------------------------------------------------------

function guncmdr_stand(self: EdictT): void {
  M_SetAnimation(self, guncmdr_move_stand, false);
}

const guncmdr_frames_fidget: MframeT[] = [
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, guncmdr_idlesound),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand, 0, guncmdr_idlesound),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
];
export const guncmdr_move_fidget = RegisterMmove("guncmdr_move_fidget", mkMove(FRAME_c_stand201, FRAME_c_stand254, guncmdr_frames_fidget, guncmdr_stand));

function guncmdr_fidget(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) return;
  else if (self.enemy !== null) return;
  if (frandom() <= 0.05) M_SetAnimation(self, guncmdr_move_fidget, true);
}

const guncmdr_frames_stand: MframeT[] = [
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, guncmdr_fidget),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, guncmdr_fidget),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, guncmdr_fidget),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, guncmdr_fidget),
];
export const guncmdr_move_stand = RegisterMmove("guncmdr_move_stand", mkMove(FRAME_c_stand101, FRAME_c_stand140, guncmdr_frames_stand, null));

function guncmdr_run(self: EdictT): void {
  monster_done_dodge(self);
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, guncmdr_move_stand, false);
  else M_SetAnimation(self, guncmdr_move_run, false);
}
RegisterMonsterinfoStand("guncmdr_stand", guncmdr_stand);

// ---------------------------------------------------------------------------
// walk / run (guncmdr.cpp:172-225)
// ---------------------------------------------------------------------------

const guncmdr_frames_walk: MframeT[] = [
  mkframe(ai_walk, 1.5, monster_footstep),
  mkframe(ai_walk, 2.5),
  mkframe(ai_walk, 3.0),
  mkframe(ai_walk, 2.5),
  mkframe(ai_walk, 2.3),
  mkframe(ai_walk, 3.0),
  mkframe(ai_walk, 2.8, monster_footstep),
  mkframe(ai_walk, 3.6),
  mkframe(ai_walk, 2.8),
  mkframe(ai_walk, 2.5),

  mkframe(ai_walk, 2.3),
  mkframe(ai_walk, 4.3),
  mkframe(ai_walk, 3.0, monster_footstep),
  mkframe(ai_walk, 1.5),
  mkframe(ai_walk, 2.5),
  mkframe(ai_walk, 3.3),
  mkframe(ai_walk, 2.8),
  mkframe(ai_walk, 3.0),
  mkframe(ai_walk, 2.0, monster_footstep),
  mkframe(ai_walk, 2.0),

  mkframe(ai_walk, 3.3),
  mkframe(ai_walk, 3.6),
  mkframe(ai_walk, 3.4),
  mkframe(ai_walk, 2.8),
];
export const guncmdr_move_walk = RegisterMmove("guncmdr_move_walk", mkMove(FRAME_c_walk101, FRAME_c_walk124, guncmdr_frames_walk, null));

function guncmdr_walk(self: EdictT): void {
  M_SetAnimation(self, guncmdr_move_walk, false);
}
RegisterMonsterinfoWalk("guncmdr_walk", guncmdr_walk);

const guncmdr_frames_run: MframeT[] = [
  mkframe(ai_run, 15.0, monster_done_dodge),
  mkframe(ai_run, 16.0, monster_footstep),
  mkframe(ai_run, 20.0),
  mkframe(ai_run, 18.0),
  mkframe(ai_run, 24.0, monster_footstep),
  mkframe(ai_run, 13.5),
];
export const guncmdr_move_run = RegisterMmove("guncmdr_move_run", mkMove(FRAME_c_run101, FRAME_c_run106, guncmdr_frames_run, null));
RegisterMonsterinfoRun("guncmdr_run", guncmdr_run);

// ---------------------------------------------------------------------------
// standing pains 1-4 (guncmdr.cpp:227-271)
// ---------------------------------------------------------------------------

const guncmdr_frames_pain1: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
export const guncmdr_move_pain1 = RegisterMmove("guncmdr_move_pain1", mkMove(FRAME_c_pain101, FRAME_c_pain104, guncmdr_frames_pain1, guncmdr_run));

const guncmdr_frames_pain2: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
export const guncmdr_move_pain2 = RegisterMmove("guncmdr_move_pain2", mkMove(FRAME_c_pain201, FRAME_c_pain204, guncmdr_frames_pain2, guncmdr_run));

const guncmdr_frames_pain3: MframeT[] = [mkframe(ai_move, -3.0), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
export const guncmdr_move_pain3 = RegisterMmove("guncmdr_move_pain3", mkMove(FRAME_c_pain301, FRAME_c_pain304, guncmdr_frames_pain3, guncmdr_run));

const guncmdr_frames_pain4: MframeT[] = [
  mkframe(ai_move, -17.1),
  mkframe(ai_move, -3.2),
  mkframe(ai_move, 0.9),
  mkframe(ai_move, 3.6),
  mkframe(ai_move, -2.6),
  mkframe(ai_move, 1.0),
  mkframe(ai_move, -5.1),
  mkframe(ai_move, -6.7),
  mkframe(ai_move, -8.8),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move, -2.1),
  mkframe(ai_move, -2.3),
  mkframe(ai_move, -2.5),
  mkframe(ai_move),
];
export const guncmdr_move_pain4 = RegisterMmove("guncmdr_move_pain4", mkMove(FRAME_c_pain401, FRAME_c_pain415, guncmdr_frames_pain4, guncmdr_run));

// ---------------------------------------------------------------------------
// death1 / death2 / pain5 (guncmdr.cpp:273-353)
// ---------------------------------------------------------------------------

function guncmdr_dead(self: EdictT): void {
  self.mins = vec3_muls(vec3(-16, -16, -24), self.s.scale);
  self.maxs = vec3_muls(vec3(16, 16, -8), self.s.scale);
  monster_dead(self);
}

const guncmdr_frames_death1: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 4.0), // scoot
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
];
export const guncmdr_move_death1 = RegisterMmove("guncmdr_move_death1", mkMove(FRAME_c_death101, FRAME_c_death118, guncmdr_frames_death1, guncmdr_dead));

function guncmdr_pain5_to_death1(self: EdictT): void {
  if (self.health < 0) M_SetAnimation(self, guncmdr_move_death1, false);
}

const guncmdr_frames_death2: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
export const guncmdr_move_death2 = RegisterMmove("guncmdr_move_death2", mkMove(FRAME_c_death201, FRAME_c_death204, guncmdr_frames_death2, guncmdr_dead));

function guncmdr_pain5_to_death2(self: EdictT): void {
  if (self.health < 0 && brandom()) M_SetAnimation(self, guncmdr_move_death2, false);
}

const guncmdr_frames_pain5: MframeT[] = [
  mkframe(ai_move, -29.0),
  mkframe(ai_move, -5.0),
  mkframe(ai_move, -5.0),
  mkframe(ai_move, -3.0),
  mkframe(ai_move),
  mkframe(ai_move, 0, guncmdr_pain5_to_death2),
  mkframe(ai_move, 9.0),
  mkframe(ai_move, 3.0),
  mkframe(ai_move, 0, guncmdr_pain5_to_death1),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move, -4.6),
  mkframe(ai_move, -4.8),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 9.5),
  mkframe(ai_move, 3.4),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move, -2.4),
  mkframe(ai_move, -9.0),
  mkframe(ai_move, -5.0),
  mkframe(ai_move, -3.6),
];
export const guncmdr_move_pain5 = RegisterMmove("guncmdr_move_pain5", mkMove(FRAME_c_pain501, FRAME_c_pain524, guncmdr_frames_pain5, guncmdr_run));

function guncmdr_shrink(self: EdictT): void {
  self.maxs[2] = -4 * self.s.scale;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// death6 / pain6 (guncmdr.cpp:362-424)
// ---------------------------------------------------------------------------

const guncmdr_frames_death6: MframeT[] = [
  mkframe(ai_move, 0, guncmdr_shrink),
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
];
export const guncmdr_move_death6 = RegisterMmove("guncmdr_move_death6", mkMove(FRAME_c_death601, FRAME_c_death614, guncmdr_frames_death6, guncmdr_dead));

function guncmdr_pain6_to_death6(self: EdictT): void {
  if (self.health < 0) M_SetAnimation(self, guncmdr_move_death6, false);
}

const guncmdr_frames_pain6: MframeT[] = [
  mkframe(ai_move, 16.0),
  mkframe(ai_move, 16.0),
  mkframe(ai_move, 12.0),
  mkframe(ai_move, 5.5, monster_duck_down),
  mkframe(ai_move, 3.0),
  mkframe(ai_move, -4.7),
  mkframe(ai_move, -6.0, guncmdr_pain6_to_death6),
  mkframe(ai_move),
  mkframe(ai_move, 1.8),
  mkframe(ai_move, 0.7),

  mkframe(ai_move),
  mkframe(ai_move, -2.1),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move, -6.1),
  mkframe(ai_move, 10.5),
  mkframe(ai_move, 4.3),
  mkframe(ai_move, 4.7, monster_duck_up),
  mkframe(ai_move, 1.4),
  mkframe(ai_move),
  mkframe(ai_move, -3.2),
  mkframe(ai_move, 2.3),
  mkframe(ai_move, -4.4),

  mkframe(ai_move, -4.4),
  mkframe(ai_move, -2.4),
];
export const guncmdr_move_pain6 = RegisterMmove("guncmdr_move_pain6", mkMove(FRAME_c_pain601, FRAME_c_pain632, guncmdr_frames_pain6, guncmdr_run));

const guncmdr_frames_pain7: MframeT[] = [
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
];
export const guncmdr_move_pain7 = RegisterMmove("guncmdr_move_pain7", mkMove(FRAME_c_pain701, FRAME_c_pain714, guncmdr_frames_pain7, guncmdr_run));

// ---------------------------------------------------------------------------
// guncmdr_pain (guncmdr.cpp:451-526)
// ---------------------------------------------------------------------------

function guncmdr_pain(self: EdictT, other: EdictT, _kick: number, damage: number, mod: ModT): void {
  monster_done_dodge(self);

  if (self.monsterinfo.active_move === guncmdr_move_jump || self.monsterinfo.active_move === guncmdr_move_jump2 || self.monsterinfo.active_move === guncmdr_move_duck_attack) return;

  if (level.time < self.pain_debounce_time) {
    if (frandom() < 0.3) self.monsterinfo.dodge?.(self, other, frameTimeAsGtime(), null, false);
    return;
  }

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  if (brandom()) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) {
    if (frandom() < 0.3) self.monsterinfo.dodge?.(self, other, frameTimeAsGtime(), null, false);
    return; // no pain anims in nightmare
  }

  const forward = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, null, null);

  const dif = vec3_sub(other.s.origin, self.s.origin);
  dif[2] = 0;
  vec3_normalize(dif);

  if (damage < 35) {
    const r = irandom(0, 4);

    if (r === 0) M_SetAnimation(self, guncmdr_move_pain3, false);
    else if (r === 1) M_SetAnimation(self, guncmdr_move_pain2, false);
    else if (r === 2) M_SetAnimation(self, guncmdr_move_pain1, false);
    else M_SetAnimation(self, guncmdr_move_pain7, false);
  } else if (vec3_dot(dif, forward) < -0.4) {
    // large pain from behind (aka Paril)
    M_SetAnimation(self, guncmdr_move_pain6, false);
    self.pain_debounce_time = Gtime_add(self.pain_debounce_time, Gtime_from_sec(1.5));
  } else {
    if (brandom()) M_SetAnimation(self, guncmdr_move_pain4, false);
    else M_SetAnimation(self, guncmdr_move_pain5, false);
    self.pain_debounce_time = Gtime_add(self.pain_debounce_time, Gtime_from_sec(1.5));
  }

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;

  // PMM - clear duck flag
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);
}
RegisterPain("guncmdr_pain", guncmdr_pain as PainFn);

// ---------------------------------------------------------------------------
// guncmdr_setskin (guncmdr.cpp:528-534)
// ---------------------------------------------------------------------------

function guncmdr_setskin(self: EdictT): void {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
}
RegisterMonsterinfoSetskin("guncmdr_setskin", guncmdr_setskin);

// ---------------------------------------------------------------------------
// death3 / death7 / death4 / death5 (guncmdr.cpp:536-674)
// ---------------------------------------------------------------------------

const guncmdr_frames_death3: MframeT[] = [
  mkframe(ai_move, 20.0),
  mkframe(ai_move, 10.0),
  mkframe(ai_move, 10.0, (self: EdictT) => {
    monster_footstep(self);
    guncmdr_shrink(self);
  }),
  mkframe(ai_move, 0.0, monster_footstep),
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
];
export const guncmdr_move_death3 = RegisterMmove("guncmdr_move_death3", mkMove(FRAME_c_death301, FRAME_c_death321, guncmdr_frames_death3, guncmdr_dead));

const guncmdr_frames_death7: MframeT[] = [
  mkframe(ai_move, 30.0),
  mkframe(ai_move, 20.0),
  mkframe(ai_move, 16.0, (self: EdictT) => {
    monster_footstep(self);
    guncmdr_shrink(self);
  }),
  mkframe(ai_move, 5.0, monster_footstep),
  mkframe(ai_move, -6.0),
  mkframe(ai_move, -7.0, monster_footstep),
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
  mkframe(ai_move, 0.0, monster_footstep),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0.0, monster_footstep),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const guncmdr_move_death7 = RegisterMmove("guncmdr_move_death7", mkMove(FRAME_c_death701, FRAME_c_death730, guncmdr_frames_death7, guncmdr_dead));

const guncmdr_frames_death4: MframeT[] = [
  mkframe(ai_move, -20.0),
  mkframe(ai_move, -16.0),
  mkframe(ai_move, -26.0, (self: EdictT) => {
    monster_footstep(self);
    guncmdr_shrink(self);
  }),
  mkframe(ai_move, 0.0, monster_footstep),
  mkframe(ai_move, -12.0),
  mkframe(ai_move, 16.0),
  mkframe(ai_move, 9.2),
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
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const guncmdr_move_death4 = RegisterMmove("guncmdr_move_death4", mkMove(FRAME_c_death401, FRAME_c_death436, guncmdr_frames_death4, guncmdr_dead));

const guncmdr_frames_death5: MframeT[] = [
  mkframe(ai_move, -14.0),
  mkframe(ai_move, -2.7),
  mkframe(ai_move, -2.5),
  mkframe(ai_move, -4.6, monster_footstep),
  mkframe(ai_move, -4.0, monster_footstep),
  mkframe(ai_move, -1.5),
  mkframe(ai_move, 2.3),
  mkframe(ai_move, 2.5),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 3.5),
  mkframe(ai_move, 12.9, monster_footstep),
  mkframe(ai_move, 3.8),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move, -2.1),
  mkframe(ai_move, -1.3),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 3.4),
  mkframe(ai_move, 5.7),
  mkframe(ai_move, 11.2),
  mkframe(ai_move, 0, monster_footstep),
];
export const guncmdr_move_death5 = RegisterMmove("guncmdr_move_death5", mkMove(FRAME_c_death501, FRAME_c_death528, guncmdr_frames_death5, guncmdr_dead));

// ---------------------------------------------------------------------------
// guncmdr_die (guncmdr.cpp:676-764)
// ---------------------------------------------------------------------------

function guncmdr_die(self: EdictT, inflictor: EdictT, _attacker: EdictT, damage: number, point: Vec3, mod: ModT): void {
  if (M_CheckGib(self, mod)) {
    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    const head_gib = self.monsterinfo.active_move !== guncmdr_move_death5 ? "models/objects/gibs/sm_meat/tris.md2" : "models/monsters/gunner/gibs/head.md2";

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    ThrowGibs(self, damage, [
      { count: 2, gibname: "models/objects/gibs/bone/tris.md2", type: GibTypeT.GIB_NONE },
      { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2", type: GibTypeT.GIB_NONE },
      { count: 1, gibname: "models/objects/gibs/gear/tris.md2", type: GibTypeT.GIB_NONE },
      { count: 1, gibname: "models/monsters/gunner/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
      { count: 1, gibname: "models/monsters/gunner/gibs/garm.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { count: 1, gibname: "models/monsters/gunner/gibs/gun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { count: 1, gibname: "models/monsters/gunner/gibs/foot.md2", type: GibTypeT.GIB_SKINNED },
      { count: 1, gibname: head_gib, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
    ]);
    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NORM, 0);
  self.deadflag = true;
  self.takedamage = true;

  // these animations cleanly transition to death, so just keep going
  if (self.monsterinfo.active_move === guncmdr_move_pain5 && self.s.frame < FRAME_c_pain508) return;
  else if (self.monsterinfo.active_move === guncmdr_move_pain6 && self.s.frame < FRAME_c_pain607) return;

  const forward = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, null, null);

  const dif = vec3_sub(inflictor.s.origin, self.s.origin);
  dif[2] = 0;
  vec3_normalize(dif);

  // off with da head
  if (Math.abs(self.s.origin[2] + self.viewheight - point[2]) <= 4 && self.velocity[2] < 65.0) {
    M_SetAnimation(self, guncmdr_move_death5, false);

    const head = ThrowGib(self, "models/monsters/gunner/gibs/head.md2", damage, GibTypeT.GIB_NONE, self.s.scale);

    if (head !== null) {
      head.s.angles = self.s.angles;
      head.s.origin = vec3_add(self.s.origin, vec3(0, 0, 24.0));
      const headDir = vec3_sub(self.s.origin, inflictor.s.origin);
      head.velocity = vec3_muls(headDir, 100.0 / vec3_length(headDir));
      head.velocity[2] = 200.0;
      head.avelocity = vec3_muls(head.avelocity, 0.15);
      gi.linkentity(head);
    }
  } else if (vec3_dot(dif, forward) < -0.4) {
    // damage came from behind; use backwards death
    const r = irandom(0, self.monsterinfo.active_move === guncmdr_move_pain6 ? 2 : 3);

    if (r === 0) M_SetAnimation(self, guncmdr_move_death3, false);
    else if (r === 1) M_SetAnimation(self, guncmdr_move_death7, false);
    else if (r === 2) M_SetAnimation(self, guncmdr_move_pain6, false);
  } else {
    const r = irandom(0, self.monsterinfo.active_move === guncmdr_move_pain5 ? 1 : 2);

    if (r === 0) M_SetAnimation(self, guncmdr_move_death4, false);
    else M_SetAnimation(self, guncmdr_move_pain5, false);
  }
}
RegisterDie("guncmdr_die", guncmdr_die as DieFn);

// ---------------------------------------------------------------------------
// chaingun attack (guncmdr.cpp:766-851)
// ---------------------------------------------------------------------------

function guncmdr_opengun(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_open.index, 1, ATTN_IDLE, 0);
}

function GunnerCmdrFire(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const flash_number =
    self.s.frame >= FRAME_c_attack401 && self.s.frame <= FRAME_c_attack505 ? MonsterMuzzleflashIdT.MZ2_GUNCMDR_CHAINGUN_2 : MonsterMuzzleflashIdT.MZ2_GUNCMDR_CHAINGUN_1;

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  const aim = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 800, false, frandom() * 0.3, aim, null);
  for (let i = 0; i < 3; i++) aim[i] += crandom_open() * 0.025;
  monster_fire_flechette(self, start, aim, 4, 800, flash_number);
}

function guncmdr_fire_chain(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n && self.enemy !== null && range_to(self, self.enemy) > RANGE_CHAINGUN_RUN && ai_check_move(self, 8.0)) {
    M_SetAnimation(self, guncmdr_move_fire_chain_run, true);
  } else {
    M_SetAnimation(self, guncmdr_move_fire_chain, true);
  }
}

const guncmdr_frames_attack_chain: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, guncmdr_opengun),
  mkframe(ai_charge),
];
export const guncmdr_move_attack_chain = RegisterMmove("guncmdr_move_attack_chain", mkMove(FRAME_c_attack101, FRAME_c_attack106, guncmdr_frames_attack_chain, guncmdr_fire_chain));

function guncmdr_refire_chain(self: EdictT): void {
  monster_done_dodge(self);
  self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;

  if (self.enemy !== null && self.enemy.health > 0 && visible(self, self.enemy) && frandom() <= 0.5) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n && range_to(self, self.enemy) > RANGE_CHAINGUN_RUN && ai_check_move(self, 8.0)) {
      M_SetAnimation(self, guncmdr_move_fire_chain_run, false);
    } else {
      M_SetAnimation(self, guncmdr_move_fire_chain, false);
    }
    return;
  }
  M_SetAnimation(self, guncmdr_move_endfire_chain, false);
}

const guncmdr_frames_fire_chain: MframeT[] = [
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
];
export const guncmdr_move_fire_chain = RegisterMmove("guncmdr_move_fire_chain", mkMove(FRAME_c_attack107, FRAME_c_attack112, guncmdr_frames_fire_chain, guncmdr_refire_chain));

const guncmdr_frames_fire_chain_run: MframeT[] = [
  mkframe(ai_charge, 15.0, GunnerCmdrFire),
  mkframe(ai_charge, 16.0, GunnerCmdrFire),
  mkframe(ai_charge, 20.0, GunnerCmdrFire),
  mkframe(ai_charge, 18.0, GunnerCmdrFire),
  mkframe(ai_charge, 24.0, GunnerCmdrFire),
  mkframe(ai_charge, 13.5, GunnerCmdrFire),
];
export const guncmdr_move_fire_chain_run = RegisterMmove("guncmdr_move_fire_chain_run", mkMove(FRAME_c_run201, FRAME_c_run206, guncmdr_frames_fire_chain_run, guncmdr_refire_chain));

const guncmdr_frames_fire_chain_dodge_right: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 9.0 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.5 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.6 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, -1.0 * 2.0, GunnerCmdrFire),
];
export const guncmdr_move_fire_chain_dodge_right = RegisterMmove(
  "guncmdr_move_fire_chain_dodge_right",
  mkMove(FRAME_c_attack401, FRAME_c_attack405, guncmdr_frames_fire_chain_dodge_right, guncmdr_refire_chain),
);

const guncmdr_frames_fire_chain_dodge_left: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 9.0 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.5 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.6 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, -1.0 * 2.0, GunnerCmdrFire),
];
export const guncmdr_move_fire_chain_dodge_left = RegisterMmove(
  "guncmdr_move_fire_chain_dodge_left",
  mkMove(FRAME_c_attack501, FRAME_c_attack505, guncmdr_frames_fire_chain_dodge_left, guncmdr_refire_chain),
);

const guncmdr_frames_endfire_chain: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, guncmdr_opengun),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const guncmdr_move_endfire_chain = RegisterMmove("guncmdr_move_endfire_chain", mkMove(FRAME_c_attack118, FRAME_c_attack124, guncmdr_frames_endfire_chain, guncmdr_run));

// ---------------------------------------------------------------------------
// grenade patterns: mortar / front / crouch (guncmdr.cpp:853-1049)
// ---------------------------------------------------------------------------

const MORTAR_SPEED = 850.0;
const GRENADE_SPEED = 600.0;

function GunnerCmdrGrenade(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const blindfire = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n;

  let spread = 0;
  let flash_number: MonsterMuzzleflashIdT = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_1;
  let pitch = 0;

  if (self.s.frame === FRAME_c_attack205) {
    spread = -0.1;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_1;
  } else if (self.s.frame === FRAME_c_attack208) {
    spread = 0.0;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_2;
  } else if (self.s.frame === FRAME_c_attack211) {
    spread = 0.1;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_3;
  } else if (self.s.frame === FRAME_c_attack304) {
    spread = -0.1;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_1;
  } else if (self.s.frame === FRAME_c_attack307) {
    spread = 0.0;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_2;
  } else if (self.s.frame === FRAME_c_attack310) {
    spread = 0.1;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_3;
  } else if (self.s.frame === FRAME_c_attack911) {
    spread = 0.25;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_CROUCH_1;
  } else if (self.s.frame === FRAME_c_attack912) {
    spread = 0.0;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_CROUCH_2;
  } else if (self.s.frame === FRAME_c_attack913) {
    spread = -0.25;
    flash_number = MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_CROUCH_3;
  }

  const isCrouch = flash_number >= MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_CROUCH_1 && flash_number <= MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_CROUCH_3;
  const isFront = flash_number >= MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_1 && flash_number <= MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_3;
  const isMortar = flash_number >= MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_1 && flash_number <= MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_3;

  let target: Vec3;
  if (blindfire && !visible(self, self.enemy)) {
    if (self.monsterinfo.blind_fire_target[0] === 0 && self.monsterinfo.blind_fire_target[1] === 0 && self.monsterinfo.blind_fire_target[2] === 0) return;
    target = self.monsterinfo.blind_fire_target;
  } else {
    target = self.enemy.s.origin;
  }

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  const up = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, up);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  if (self.enemy !== null && !isCrouch) {
    const toTarget = vec3_sub(target, self.s.origin);
    const dist = vec3_length(toTarget);

    // aim up if they're on the same level as me and far away.
    if (dist > 512 && toTarget[2] < 64 && toTarget[2] > -64) {
      toTarget[2] += dist - 512;
    }

    const normalized = vec3_normalized(toTarget);
    pitch = normalized[2];
    if (pitch > 0.4) pitch = 0.4;
    else if (pitch < -0.5) pitch = -0.5;

    if (self.enemy.absmin[2] - self.absmax[2] > 16.0 && isMortar) pitch += 0.5;
  }

  if (isFront) pitch -= 0.05;

  let aim: Vec3;
  if (!isCrouch) {
    aim = vec3_add(forward, vec3_muls(right, spread));
    aim = vec3_add(aim, vec3_muls(up, pitch));
    vec3_normalize(aim);
  } else {
    aim = vec3(0, 0, 0);
    PredictAim(self, self.enemy, start, 800, false, 0.0, aim, null);
    aim = vec3_add(aim, vec3_muls(right, spread));
    vec3_normalize(aim);
  }

  if (isCrouch) {
    const inner_spread = 0.125;

    for (let i = 0; i < 3; i++) fire_ionripper(self, start, vec3_add(aim, vec3_muls(right, -(inner_spread * 2) + inner_spread * (i + 1))), 15, 800, EffectsT.EF_IONRIPPER);

    // monster_muzzleflash writes the multicast'd flash effect (see g_monster.ts)
    gi.WriteByte(ServerCommandT.svc_muzzleflash2);
    gi.WriteEntity(self);
    gi.WriteShort(flash_number);
    gi.multicast(start, KexMulticastT.MULTICAST_PHS, false);
  } else {
    const speed = isMortar ? MORTAR_SPEED : GRENADE_SPEED;

    if (M_CalculatePitchToFire(self, target, start, aim, speed, 2.5, isMortar)) {
      monster_fire_grenade(self, start, aim, 50, speed, flash_number, crandom_open() * 10.0, frandom() * 10.0);
    } else {
      monster_fire_grenade(self, start, aim, 50, speed, flash_number, crandom_open() * 10.0, 200.0 + crandom_open() * 10.0);
    }
  }
}

const guncmdr_frames_attack_mortar: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, GunnerCmdrGrenade),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, GunnerCmdrGrenade),
  mkframe(ai_charge),
  mkframe(ai_charge),

  mkframe(ai_charge, 0, GunnerCmdrGrenade),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, monster_duck_up),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const guncmdr_move_attack_mortar = RegisterMmove("guncmdr_move_attack_mortar", mkMove(FRAME_c_attack201, FRAME_c_attack221, guncmdr_frames_attack_mortar, guncmdr_run));

function guncmdr_grenade_mortar_resume(self: EdictT): void {
  M_SetAnimation(self, guncmdr_move_attack_mortar, true);
  self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  self.s.frame = self.count;
}

const guncmdr_frames_attack_mortar_dodge: MframeT[] = [
  mkframe(ai_charge, 11.0),
  mkframe(ai_charge, 12.0),
  mkframe(ai_charge, 16.0),
  mkframe(ai_charge, 16.0),
  mkframe(ai_charge, 12.0),
  mkframe(ai_charge, 11.0),
];
export const guncmdr_move_attack_mortar_dodge = RegisterMmove(
  "guncmdr_move_attack_mortar_dodge",
  mkMove(FRAME_c_duckstep01, FRAME_c_duckstep06, guncmdr_frames_attack_mortar_dodge, guncmdr_grenade_mortar_resume),
);

const guncmdr_frames_attack_back: MframeT[] = [
  mkframe(ai_charge, -2.0),
  mkframe(ai_charge, -1.5),
  mkframe(ai_charge, -0.5, GunnerCmdrGrenade),
  mkframe(ai_charge, -6.0),
  mkframe(ai_charge, -4.0),
  mkframe(ai_charge, -2.5, GunnerCmdrGrenade),
  mkframe(ai_charge, -7.0),
  mkframe(ai_charge, -3.5),
  mkframe(ai_charge, -1.1, GunnerCmdrGrenade),

  mkframe(ai_charge, -4.6),
  mkframe(ai_charge, 1.9),
  mkframe(ai_charge, 1.0),
  mkframe(ai_charge, -4.5),
  mkframe(ai_charge, 3.2),
  mkframe(ai_charge, 4.4),
  mkframe(ai_charge, -6.5),
  mkframe(ai_charge, -6.1),
  mkframe(ai_charge, 3.0),
  mkframe(ai_charge, -0.7),
  mkframe(ai_charge, -1.0),
];
export const guncmdr_move_attack_grenade_back = RegisterMmove("guncmdr_move_attack_grenade_back", mkMove(FRAME_c_attack302, FRAME_c_attack321, guncmdr_frames_attack_back, guncmdr_run));

function guncmdr_grenade_back_dodge_resume(self: EdictT): void {
  M_SetAnimation(self, guncmdr_move_attack_grenade_back, true);
  self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  self.s.frame = self.count;
}

const guncmdr_frames_attack_grenade_back_dodge_right: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0),
  mkframe(ai_charge, 9.0 * 2.0),
  mkframe(ai_charge, 3.5 * 2.0),
  mkframe(ai_charge, 3.6 * 2.0),
  mkframe(ai_charge, -1.0 * 2.0),
];
export const guncmdr_move_attack_grenade_back_dodge_right = RegisterMmove(
  "guncmdr_move_attack_grenade_back_dodge_right",
  mkMove(FRAME_c_attack601, FRAME_c_attack605, guncmdr_frames_attack_grenade_back_dodge_right, guncmdr_grenade_back_dodge_resume),
);

const guncmdr_frames_attack_grenade_back_dodge_left: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0),
  mkframe(ai_charge, 9.0 * 2.0),
  mkframe(ai_charge, 3.5 * 2.0),
  mkframe(ai_charge, 3.6 * 2.0),
  mkframe(ai_charge, -1.0 * 2.0),
];
export const guncmdr_move_attack_grenade_back_dodge_left = RegisterMmove(
  "guncmdr_move_attack_grenade_back_dodge_left",
  mkMove(FRAME_c_attack701, FRAME_c_attack705, guncmdr_frames_attack_grenade_back_dodge_left, guncmdr_grenade_back_dodge_resume),
);

// ---------------------------------------------------------------------------
// kick melee (guncmdr.cpp:1102-1128)
// ---------------------------------------------------------------------------

function guncmdr_kick_finished(self: EdictT): void {
  self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  self.monsterinfo.attack?.(self);
}

function guncmdr_kick(self: EdictT): void {
  if (fire_hit(self, vec3(MELEE_DISTANCE, 0.0, -32.0), 15.0, 400.0)) {
    if (self.enemy !== null && self.enemy.client !== null && self.enemy.velocity[2] < 270.0) self.enemy.velocity[2] = 270.0;
  }
}

const guncmdr_frames_attack_kick: MframeT[] = [
  mkframe(ai_charge, -7.7),
  mkframe(ai_charge, -4.9),
  mkframe(ai_charge, 12.6, guncmdr_kick),
  mkframe(ai_charge),
  mkframe(ai_charge, -3.0),
  mkframe(ai_charge),
  mkframe(ai_charge, -4.1),
  mkframe(ai_charge, 8.6),
];
export const guncmdr_move_attack_kick = RegisterMmove("guncmdr_move_attack_kick", mkMove(FRAME_c_attack801, FRAME_c_attack808, guncmdr_frames_attack_kick, guncmdr_kick_finished));

// ---------------------------------------------------------------------------
// guncmdr_attack (guncmdr.cpp:1130-1170)
// ---------------------------------------------------------------------------

// don't ever try grenades if we get this close
const RANGE_GRENADE = 100.0;
// always use mortar at this range
const RANGE_GRENADE_MORTAR = 525.0;
// at this range, run towards the enemy
const RANGE_CHAINGUN_RUN = 400.0;

function guncmdr_attack(self: EdictT): void {
  monster_done_dodge(self);

  if (self.enemy === null) return;

  const d = range_to(self, self.enemy);

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);

  if (self.bad_area === null && d < RANGE_MELEE && self.monsterinfo.melee_debounce_time < level.time) {
    M_SetAnimation(self, guncmdr_move_attack_kick, true);
  } else if (self.bad_area !== null || ((d <= RANGE_GRENADE || brandom()) && M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_GUNCMDR_CHAINGUN_1]))) {
    M_SetAnimation(self, guncmdr_move_attack_chain, true);
  } else if (
    (d >= RANGE_GRENADE_MORTAR || Math.abs(self.absmin[2] - self.enemy.absmax[2]) > 64.0) &&
    M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_1]) &&
    M_CalculatePitchToFire(
      self,
      self.enemy.s.origin,
      M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_MORTAR_1], forward, right),
      vec3_normalized(vec3_sub(self.enemy.s.origin, self.s.origin)),
      MORTAR_SPEED,
      2.5,
      true,
    )
  ) {
    M_SetAnimation(self, guncmdr_move_attack_mortar, true);
    monster_duck_down(self);
  } else if (
    M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_1]) &&
    (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n &&
    M_CalculatePitchToFire(
      self,
      self.enemy.s.origin,
      M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_GUNCMDR_GRENADE_FRONT_1], forward, right),
      vec3_normalized(vec3_sub(self.enemy.s.origin, self.s.origin)),
      GRENADE_SPEED,
      2.5,
      false,
    )
  ) {
    M_SetAnimation(self, guncmdr_move_attack_grenade_back, true);
  } else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, guncmdr_move_attack_chain, true);
  }
}
RegisterMonsterinfoAttack("guncmdr_attack", guncmdr_attack as MonsterinfoAttackFn);

// ---------------------------------------------------------------------------
// jump-over-obstacle (guncmdr.cpp:1200-1270, PGM)
// ---------------------------------------------------------------------------

function guncmdr_jump_now(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const up = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, null, up);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 100));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 300));
}

function guncmdr_jump2_now(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const up = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, null, up);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 150));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 400));
}

function guncmdr_jump_wait_land(self: EdictT): void {
  if (self.groundentity === null) {
    self.monsterinfo.nextframe = self.s.frame;
    if (monster_jump_finished(self)) self.monsterinfo.nextframe = self.s.frame + 1;
  } else {
    self.monsterinfo.nextframe = self.s.frame + 1;
  }
}

const guncmdr_frames_jump: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, guncmdr_jump_now),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, guncmdr_jump_wait_land),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const guncmdr_move_jump = RegisterMmove("guncmdr_move_jump", mkMove(FRAME_c_jump01, FRAME_c_jump10, guncmdr_frames_jump, guncmdr_run));

const guncmdr_frames_jump2: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, -4),
  mkframe(ai_move, -4),
  mkframe(ai_move, 0, guncmdr_jump2_now),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, guncmdr_jump_wait_land),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const guncmdr_move_jump2 = RegisterMmove("guncmdr_move_jump2", mkMove(FRAME_c_jump01, FRAME_c_jump10, guncmdr_frames_jump2, guncmdr_run));

function guncmdr_jump(self: EdictT, result: BlockedJumpResultT): void {
  if (self.enemy === null) return;

  monster_done_dodge(self);

  if (result === BlockedJumpResultT.JUMP_JUMP_UP) M_SetAnimation(self, guncmdr_move_jump2, false);
  else M_SetAnimation(self, guncmdr_move_jump, false);
}

// ---------------------------------------------------------------------------
// duck-and-counter (guncmdr.cpp:1274-1341, PGM/PMM)
// ---------------------------------------------------------------------------

function GunnerCmdrCounter(self: EdictT): void {
  const f = vec3(0, 0, 0);
  const r = vec3(0, 0, 0);
  AngleVectors(self.s.angles, f, r, null);
  const start = M_ProjectFlashSource(self, vec3(20.0, 0.0, 14.0), f, r);
  const tr = giTraceline(self.s.origin, start, self, MASK_SOLID);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_BERSERK_SLAM);
  gi.WritePosition(tr.endpos);
  gi.WriteDir(f);
  gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PHS, false);

  T_SlamRadiusDamage(tr.endpos, self, self, 15, 250.0, self, 200.0, MOD_UNKNOWN);
}

const guncmdr_frames_duck_attack: MframeT[] = [
  mkframe(ai_move, 3.6),
  mkframe(ai_move, 5.6, monster_duck_down),
  mkframe(ai_move, 8.4),
  mkframe(ai_move, 2.0, monster_duck_hold),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),

  // three commented-out GunnerCmdrGrenade thinkfuncs in the C++ source
  // (guncmdr.cpp:1303-1305) are dead code (`#if 0`-equivalent) and dropped
  // silently per this port line's idiom map.
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 9.5, GunnerCmdrCounter),
  mkframe(ai_charge, -1.5),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, monster_duck_up),
  mkframe(ai_charge),
  mkframe(ai_charge, 11.0),
  mkframe(ai_charge, 2.0),
  mkframe(ai_charge, 5.6),
];
export const guncmdr_move_duck_attack = RegisterMmove("guncmdr_move_duck_attack", mkMove(FRAME_c_attack901, FRAME_c_attack919, guncmdr_frames_duck_attack, guncmdr_run));

function guncmdr_duck(self: EdictT, _eta: GTime): boolean {
  if (self.monsterinfo.active_move === guncmdr_move_jump2 || self.monsterinfo.active_move === guncmdr_move_jump) {
    return false;
  }

  if (
    self.monsterinfo.active_move === guncmdr_move_fire_chain_dodge_left ||
    self.monsterinfo.active_move === guncmdr_move_fire_chain_dodge_right ||
    self.monsterinfo.active_move === guncmdr_move_attack_grenade_back_dodge_left ||
    self.monsterinfo.active_move === guncmdr_move_attack_grenade_back_dodge_right ||
    self.monsterinfo.active_move === guncmdr_move_attack_mortar_dodge
  ) {
    // if we're dodging, don't duck
    self.monsterinfo.unduck?.(self);
    return false;
  }

  M_SetAnimation(self, guncmdr_move_duck_attack, true);
  return true;
}
RegisterMonsterinfoDuck("guncmdr_duck", guncmdr_duck as MonsterinfoDuckFn);

// ---------------------------------------------------------------------------
// sidestep / blocked (guncmdr.cpp:1343-1393, PGM)
// ---------------------------------------------------------------------------

function guncmdr_sidestep(self: EdictT): boolean {
  // use special dodge during the main firing anim
  if (self.monsterinfo.active_move === guncmdr_move_fire_chain || self.monsterinfo.active_move === guncmdr_move_fire_chain_run) {
    M_SetAnimation(self, !self.monsterinfo.lefty ? guncmdr_move_fire_chain_dodge_right : guncmdr_move_fire_chain_dodge_left, false);
    return true;
  }

  // for backwards mortar, back up where we are in the animation and do a quick dodge
  if (self.monsterinfo.active_move === guncmdr_move_attack_grenade_back) {
    self.count = self.s.frame;
    M_SetAnimation(self, !self.monsterinfo.lefty ? guncmdr_move_attack_grenade_back_dodge_right : guncmdr_move_attack_grenade_back_dodge_left, false);
    return true;
  }

  // use crouch-move for mortar dodge
  if (self.monsterinfo.active_move === guncmdr_move_attack_mortar) {
    self.count = self.s.frame;
    M_SetAnimation(self, guncmdr_move_attack_mortar_dodge, false);
    return true;
  }

  // regular sidestep during run
  if (self.monsterinfo.active_move === guncmdr_move_run) {
    M_SetAnimation(self, guncmdr_move_run, true);
    return true;
  }

  return false;
}
RegisterMonsterinfoSidestep("guncmdr_sidestep", guncmdr_sidestep);

function guncmdr_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkplat(self, dist)) return true;

  const result = blocked_checkjump(self, dist);
  if (result !== BlockedJumpResultT.NO_JUMP) {
    if (result !== BlockedJumpResultT.JUMP_TURN) guncmdr_jump(self, result);
    return true;
  }

  return false;
}
RegisterMonsterinfoBlocked("guncmdr_blocked", guncmdr_blocked);

// ---------------------------------------------------------------------------
// SP_monster_guncmdr (guncmdr.cpp:1397-1473)
// ---------------------------------------------------------------------------

export function SP_monster_guncmdr(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_death, "guncmdr/gcdrdeath1.wav");
  assignSound(sound_pain, "guncmdr/gcdrpain2.wav");
  assignSound(sound_pain2, "guncmdr/gcdrpain1.wav");
  assignSound(sound_idle, "guncmdr/gcdridle1.wav");
  assignSound(sound_open, "guncmdr/gcdratck1.wav");
  assignSound(sound_search, "guncmdr/gcdrsrch1.wav");
  assignSound(sound_sight, "guncmdr/sight1.wav");

  gi.soundindex("guncmdr/gcdratck2.wav");
  gi.soundindex("guncmdr/gcdratck3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/gunner/tris.md2");

  gi.modelindex("models/monsters/gunner/gibs/chest.md2");
  gi.modelindex("models/monsters/gunner/gibs/foot.md2");
  gi.modelindex("models/monsters/gunner/gibs/garm.md2");
  gi.modelindex("models/monsters/gunner/gibs/gun.md2");
  gi.modelindex("models/monsters/gunner/gibs/head.md2");

  self.s.scale = 1.25;
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 36);
  self.s.skinnum = 2;

  self.health = Math.trunc(325 * st.health_multiplier);
  self.gib_health = -175;
  self.mass = 255;

  self.pain = guncmdr_pain as PainFn;
  self.die = guncmdr_die as DieFn;

  self.monsterinfo.stand = guncmdr_stand;
  self.monsterinfo.walk = guncmdr_walk;
  self.monsterinfo.run = guncmdr_run;
  // pmm
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = guncmdr_duck as MonsterinfoDuckFn;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = guncmdr_sidestep;
  self.monsterinfo.blocked = guncmdr_blocked; // PGM
  // pmm
  self.monsterinfo.attack = guncmdr_attack as MonsterinfoAttackFn;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = guncmdr_sight;
  self.monsterinfo.search = guncmdr_search;
  self.monsterinfo.setskin = guncmdr_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, guncmdr_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  if (!st.keys_specified.has("power_armor_power")) self.monsterinfo.power_armor_power = 200;
  if (!st.keys_specified.has("power_armor_type")) self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;

  // PMM
  self.monsterinfo.can_jump = !SpawnFlags_has(self.spawnflags, SPAWNFLAG_GUNCMDR_NOJUMPING);
  self.monsterinfo.drop_height = 192;
  self.monsterinfo.jump_height = 40;

  walkmonster_start(self);
}
