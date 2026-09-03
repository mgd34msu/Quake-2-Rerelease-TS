/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.

Ported from rerelease/m_guncmdr.cpp via src/kexgame/m_guncmdr.ts.
*/
/*
==============================================================================

GUN COMMANDER

==============================================================================
*/
//
// RERELEASE CONTENT PORT -- this monster exists ONLY in the 2023 re-release;
// there is no 3.21 baseq2/xatrix/rogue precedent anywhere in this tree.
// Full stand/fidget/walk/run/pain (x7)/death (x7)/setskin system, a chaingun
// attack with two dodge variants, three grenade-launcher patterns (mortar
// arc, front-facing arc, crouched ionripper burst), a kick melee, a
// duck-and-counter slam, and the PGM/PMM jump-over-obstacle logic.
//
// Translation source: src/kexgame/m_guncmdr.ts, retargeted at the CLASSIC
// module's type machinery.
//
// ===========================================================================
// TRANSLATION NOTES (kexgame -> classic)
// ===========================================================================
// - TIME. kexgame's GTime (ms) becomes the classic float-seconds level.time.
//   `Gtime_from_ms(gi.frame_time_ms)` (the C++'s FRAME_TIME_S) -> FRAMETIME.
// - CALLBACK REGISTRATION. Register*/RegisterMmove become plain
//   functions/objects plus registerSaveFunction/registerSaveMmove at the
//   file tail (m_soldier.ts's idiom).
// - M_SetAnimation(self, move, instant) -> `self.monsterinfo.currentmove =
//   move`. The classic MonsterInfoT has no active_move/next_move split, so
//   the `instant` flag has no counterpart -- every switch is immediate.
//   `self.monsterinfo.active_move` reads become `currentmove` reads.
//   DOCUMENTED DEGRADATION: in the re-release a non-instant switch waits for
//   the current frame to finish; here it takes effect on the next think.
// - SHARED ROGUE "NEW AI". M_MonsterDodge, monster_duck_down/hold/up,
//   blocked_checkplat, blocked_checkjump, monster_jump_start/finished now
//   exist for real in src/game/g_newai.ts and monster_done_dodge in
//   src/game/g_monster.ts, so they are IMPORTED rather than duplicated.
//   Neither file is owned by this unit; nothing here edits them.
// - PredictAim. g_newai.ts's PredictAim is the pre-KEX ROGUE version (7
//   parameters, no `self`, and without the [Paril-KEX] "if the current
//   attempt is blocked, try the opposite eye height" flip). The guncmdr's
//   chaingun calls PredictAim on EVERY shot and was tuned against the KEX
//   one, so the KEX version is ported locally here (same copy m_shambler.ts
//   carries). See `PredictAim` below.
// - M_CalculatePitchToFire (rogue/g_rogue_newai.cpp:1136-1196, in its KEX
//   form) has no classic counterpart at all; ported locally. Its
//   `level.gravity` becomes the sv_gravity cvar -- the classic LevelLocalsT
//   has no `gravity` field.
// - ai_check_move (kexgame/m_move.ts) has no classic counterpart and
//   m_move.ts is not owned by this unit. Ported locally on top of the
//   exported M_walkmove -- see `ai_check_move` for the one side effect that
//   costs.
// - GRENADES. The re-release's fire_grenade takes right_adjust/up_adjust
//   parameters; the classic fire_grenade hardcodes exactly the values the
//   re-release passes on its FAILED-pitch path (`200 + crandom()*10` up,
//   `crandom()*10` right). Both paths are needed here, so a local
//   `guncmdr_fire_grenade` carries the parameterized form -- see there.
// - FLECHETTES. monster_fire_flechette has no classic counterpart; the
//   two-line kexgame body (fire_flechette + monster_muzzleflash) is
//   reproduced locally on top of g_newweap.ts's fire_flechette.
// - MUZZLE FLASH IDS 240..250 live only in the re-release's 290-entry
//   monster_flash_offset table; the classic table (m_flash.ts, 212 entries)
//   is owned by another unit. The eleven offsets are carried locally --
//   see `guncmdrFlashOffset` for the client-side cost.
// - GIBS. ThrowGibs(self, damage, [{gibname, count, type}]) becomes the
//   classic per-gib ThrowGib/ThrowHead loop. The re-release's GIB_SKINNED /
//   GIB_UPRIGHT / per-gib scale have no classic counterpart; each gib is
//   thrown as GIB_ORGANIC or GIB_METALLIC. DOCUMENTED DEGRADATION.
// - T_SlamRadiusDamage is duplicated locally exactly as kexgame does (its
//   real home, m_berserk.cpp, does not export it in either family).
// - `self.monsterinfo.melee_debounce_time`, `.setskin`, `.can_jump`,
//   `.drop_height`, `.jump_height` do not exist on the classic
//   MonsterInfoT. See each site below; all REPORTED for g_local.ts.
//
// ===========================================================================
// PRESERVED KEXGAME QUIRKS (bug-for-bug, not "fixed")
// ===========================================================================
// - GunnerGrenade/GunnerFire are forward-declared in guncmdr.cpp but never
//   defined or called there (copy/paste leftovers from m_gunner.cpp). Not
//   ported -- there is no behavior to port.
// - `flash_number` and `spread` in GunnerCmdrGrenade are C++ locals with no
//   initializer, assigned only inside an if/else-if chain with no final
//   `else`. TypeScript needs definite assignment, so both get a placeholder
//   every real call path overwrites before use.
// - guncmdr_frames_duck_attack has three commented-out GunnerCmdrGrenade
//   thinkfuncs in the C++ (dead `#if 0`-equivalent code); dropped.

import {
  AngleVectors,
  DotProduct,
  VectorAdd,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
  crandom,
  random,
  vec3,
  type Vec3,
} from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_VOICE,
  CONTENTS_DEADMONSTER,
  CONTENTS_MONSTER,
  EF_GRENADE,
  EF_IONRIPPER,
  EntityEventT,
  MASK_SHOT,
  MASK_SOLID,
  MulticastT,
  PITCH,
  SURF_SKY,
  YAW,
} from "../shared/q_shared";
import {
  AI_COMBAT_POINT,
  AI_DUCKED,
  AI_MANUAL_STEERING,
  AI_LOST_SIGHT,
  AI_STAND_GROUND,
  AS_BLIND,
  AS_STRAIGHT,
  DamageT,
  DAMAGE_RADIUS,
  DEAD_DEAD,
  type EdictT,
  FRAMETIME,
  g_edicts,
  gameCvars,
  gi,
  GIB_METALLIC,
  GIB_ORGANIC,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MOD_UNKNOWN,
  MovetypeT,
  POWER_ARMOR_SHIELD,
  st,
  svc_muzzleflash2,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, visible } from "./g_ai";
import { monster_done_dodge, walkmonster_start } from "./g_monster";
import {
  M_MonsterDodge,
  blocked_checkjump,
  blocked_checkplat,
  monster_duck_down,
  monster_duck_hold,
  monster_duck_up,
  monster_jump_finished,
  monster_jump_start,
} from "./g_newai";
import { M_walkmove } from "./m_move";
import { ClipVelocity } from "./g_phys";
import { findradius, G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { CanDamage, T_Damage } from "./g_combat";
import { fire_hit, fire_ionripper, Grenade_Explode, Grenade_Touch } from "./g_weapon";
import { fire_flechette } from "./g_newweap";
import * as FRAME from "./m_guncmdr_frames";

// mirrors g_monster.ts's/g_items.ts's own `cvarNum` (module-local there too).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// q_std.h's frandom/brandom/irandom/crandom_open, on shared/math.ts's random().
function frandom(): number {
  return random();
}
function brandom(): boolean {
  return random() < 0.5;
}
/** q_std.h `irandom(min, max)` -- half-open [min, max). */
function irandom(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min));
}
/** q_std.h `crandom_open()` -- (-1, 1), endpoints excluded. */
function crandom_open(): number {
  return crandom();
}

// SPAWNFLAG_GUNCMDR_NOJUMPING (kexgame/m_guncmdr.ts, guncmdr.cpp).
const SPAWNFLAG_GUNCMDR_NOJUMPING = 8;

// SP_monster_guncmdr's own monsterinfo settings, which the classic
// MonsterInfoT has no fields for (REPORTED): can_jump (from the spawnflag),
// drop_height = 192, jump_height = 40.
const GUNCMDR_DROP_HEIGHT = 192;
const GUNCMDR_JUMP_HEIGHT = 40;

function guncmdrCanJump(self: EdictT): boolean {
  return (self.spawnflags & SPAWNFLAG_GUNCMDR_NOJUMPING) === 0;
}

/**
 * `st.health_multiplier` -- see the identical note in m_arachnid.ts.
 *
 * REPORTED (g_local.ts, not owned by this unit): the re-release defaults it
 * to 1.0; the classic SpawnTempT (g_local.ts:461) declares it `= 0`, which
 * would spawn a 0-health monster. A 0 is read here as "key not present".
 */
function healthMultiplier(): number {
  return st.health_multiplier || 1;
}

// ---------------------------------------------------------------------------
// MELEE / RANGE constants -- the two families measure distance differently.
//
// * g_weapon.ts's `fire_hit` (the CLASSIC one, the one that runs here)
//   measures ORIGIN-to-ORIGIN distance against aim[0]; its matched constant
//   is the classic MELEE_DISTANCE = 80 (g_local.ts:86), which is what is
//   passed to fire_hit in guncmdr_kick.
// * guncmdr_attack's melee GATE compares `range_to` -- box-to-box -- against
//   the re-release's RANGE_MELEE = 20 (kexgame/g_local.ts:873, "bboxes
//   basically touching"). The classic RANGE_MELEE (g_local.ts:119) is a
//   RANGE_* BUCKET INDEX (0), not a distance, and must not be used here.
// ---------------------------------------------------------------------------
const RANGE_MELEE_BOX = 20;

// don't ever try grenades if we get this close (guncmdr.cpp:1130-1134)
const RANGE_GRENADE = 100.0;
// always use mortar at this range
const RANGE_GRENADE_MORTAR = 525.0;
// at this range, run towards the enemy
const RANGE_CHAINGUN_RUN = 400.0;

const MORTAR_SPEED = 850.0;
const GRENADE_SPEED = 600.0;

// rogue/g_rogue_newai.cpp's blocked_checkjump result -- kexgame/g_local.ts:913.
enum BlockedJumpResultT {
  NO_JUMP,
  JUMP_TURN,
  JUMP_JUMP_UP,
  JUMP_JUMP_DOWN,
}

// ---------------------------------------------------------------------------
// monster_flash_offset entries 240..250 (kexgame/m_flash.ts:321-334).
//
// DOCUMENTED DEGRADATION (protocol 34): the classic flash table
// (src/game/m_flash.ts) stops at index 211 and belongs to another unit, so
// these eleven offsets are carried here for the SERVER side -- every shot
// really does originate from the right point on the model. The flash id is
// still written verbatim into svc_muzzleflash2 and the CLASSIC client
// resolves it through its own 212-entry table; cl_fx.ts's
// CL_ParseMuzzleFlash2 already documents that an out-of-range flash_number
// falls back to a zero offset there, so under the classic ruleset the muzzle
// FLASH / dynamic light draws at the guncmdr's origin instead of at the gun.
// Everything else driven off flash_number is unaffected.
// ---------------------------------------------------------------------------

const MZ2_GUNCMDR_CHAINGUN_1 = 240; // straight
const MZ2_GUNCMDR_CHAINGUN_2 = 241; // dodging
const MZ2_GUNCMDR_GRENADE_MORTAR_1 = 242;
const MZ2_GUNCMDR_GRENADE_MORTAR_2 = 243;
const MZ2_GUNCMDR_GRENADE_MORTAR_3 = 244;
const MZ2_GUNCMDR_GRENADE_FRONT_1 = 245;
const MZ2_GUNCMDR_GRENADE_FRONT_2 = 246;
const MZ2_GUNCMDR_GRENADE_FRONT_3 = 247;
const MZ2_GUNCMDR_GRENADE_CROUCH_1 = 248;
const MZ2_GUNCMDR_GRENADE_CROUCH_2 = 249;
const MZ2_GUNCMDR_GRENADE_CROUCH_3 = 250;

const guncmdr_flash_offsets: readonly Vec3[] = [
  vec3(25.0, 11.0, 21.0), // MZ2_GUNCMDR_CHAINGUN_1 = 240
  vec3(26.5, 5.0, 21.0), // MZ2_GUNCMDR_CHAINGUN_2 = 241
  vec3(27.0, 6.5, 4.0), // MZ2_GUNCMDR_GRENADE_MORTAR_1 = 242
  vec3(28.0, 4.0, 4.0), // MZ2_GUNCMDR_GRENADE_MORTAR_2 = 243
  vec3(27.0, 1.7, 4.0), // MZ2_GUNCMDR_GRENADE_MORTAR_3 = 244
  vec3(21.7, -1.5, 22.5), // MZ2_GUNCMDR_GRENADE_FRONT_1 = 245
  vec3(22.0, 0.0, 20.5), // MZ2_GUNCMDR_GRENADE_FRONT_2 = 246
  vec3(22.5, 3.7, 20.5), // MZ2_GUNCMDR_GRENADE_FRONT_3 = 247
  vec3(8.0, 40.0, 18.0), // MZ2_GUNCMDR_GRENADE_CROUCH_1 = 248
  vec3(29.0, 16.0, 19.0), // MZ2_GUNCMDR_GRENADE_CROUCH_2 = 249
  vec3(4.7, -30.0, 20.0), // MZ2_GUNCMDR_GRENADE_CROUCH_3 = 250
];

function guncmdrFlashOffset(id: number): Vec3 {
  const off = guncmdr_flash_offsets[id - MZ2_GUNCMDR_CHAINGUN_1];
  if (off === undefined) {
    throw new Error(`guncmdrFlashOffset: id ${id} is not one of MZ2_GUNCMDR_CHAINGUN_1..GRENADE_CROUCH_3`);
  }
  return off;
}

// ---------------------------------------------------------------------------
// `self.monsterinfo.melee_debounce_time` stand-in -- see m_arachnid.ts's
// identical note. REPORTED for g_local.ts:
// `melee_debounce_time = 0;` on MonsterInfoT.
// ---------------------------------------------------------------------------
const meleeDebounceTime: WeakMap<EdictT, number> = new WeakMap();

function getMeleeDebounceTime(self: EdictT): number {
  return meleeDebounceTime.get(self) ?? 0;
}

// ---------------------------------------------------------------------------
// Locally-ported shared infrastructure -- see the TRANSLATION NOTES header.
// ---------------------------------------------------------------------------

/** kexgame/g_monster.ts `M_AllowSpawn`. */
function guncmdrAllowSpawn(): boolean {
  const ai_allow_dm_spawn = gi.cvar("ai_allow_dm_spawn", "0", 0);
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(ai_allow_dm_spawn) === 0) return false;
  return true;
}

/**
 * kexgame/g_monster.ts `M_ShouldReactToPain`.
 *
 * DOCUMENTED DEGRADATION: the `mod.id == MOD_CHAINFIST ||` short-circuit is
 * dropped -- the classic pain signature carries no `mod`.
 */
function guncmdrShouldReactToPain(self: EdictT): boolean {
  if ((self.monsterinfo.aiflags & (AI_DUCKED | AI_COMBAT_POINT)) !== 0) return false;
  return cvarNum(gameCvars.skill) < 3;
}

/** g_local.h `EDICT_NUM` recovery -- sv_world defaults an unset trace.ent to world, never null. */
function traceEdict(ent: { s: { number: number } } | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** kexgame/q_vec3.ts `distance_between_boxes`, via kexgame/g_ai.ts `range_to`. */
function range_to(self: EdictT, other: EdictT): number {
  let len = 0;
  for (let i = 0; i < 3; i++) {
    if (self.absmax[i] < other.absmin[i]) {
      const d = self.absmax[i] - other.absmin[i];
      len += d * d;
    } else if (self.absmin[i] > other.absmax[i]) {
      const d = self.absmin[i] - other.absmax[i];
      len += d * d;
    }
  }
  return Math.sqrt(len);
}

/** kexgame/q_vec3.ts `closest_point_to_box`. */
function closest_point_to_box(from: Vec3, absmins: Vec3, absmaxs: Vec3): Vec3 {
  return vec3(
    from[0] < absmins[0] ? absmins[0] : from[0] > absmaxs[0] ? absmaxs[0] : from[0],
    from[1] < absmins[1] ? absmins[1] : from[1] > absmaxs[1] ? absmaxs[1] : from[1],
    from[2] < absmins[2] ? absmins[2] : from[2] > absmaxs[2] ? absmaxs[2] : from[2],
  );
}

/**
 * kexgame/g_monster.ts `M_ProjectFlashSource` -- G_ProjectSource with the
 * offset pre-scaled by s.scale. SP_monster_guncmdr sets s.scale = 1.25, so
 * unlike the arachnid this monster genuinely needs the scaling.
 */
function M_ProjectFlashSource(self: EdictT, offset: Vec3, forward: Vec3, right: Vec3, out: Vec3): void {
  if (self.s.scale !== 0) {
    const scaled = vec3();
    VectorScale(offset, self.s.scale, scaled);
    G_ProjectSource(self.s.origin, scaled, forward, right, out);
    return;
  }
  G_ProjectSource(self.s.origin, offset, forward, right, out);
}

// kexgame/g_monster.ts:552 `CLEARSHOT_MASK = MASK_PROJECTILE & ~CONTENTS_DEADMONSTER`.
// The classic module's equivalent of MASK_PROJECTILE is MASK_SHOT.
const CLEARSHOT_MASK = MASK_SHOT & ~CONTENTS_DEADMONSTER;

/** kexgame/g_monster.ts `M_CheckClearShot`. */
function M_CheckClearShot(self: EdictT, offset: Vec3): boolean {
  if (self.enemy === null) return false;

  const real_angles = vec3(self.s.angles[0], self.ideal_yaw, 0);
  const f = vec3();
  const r = vec3();
  AngleVectors(real_angles, f, r, null);
  const start = vec3();
  M_ProjectFlashSource(self, offset, f, r, start);

  const is_blind =
    self.monsterinfo.attack_state === AS_BLIND ||
    (self.monsterinfo.aiflags & (AI_MANUAL_STEERING | AI_LOST_SIGHT)) !== 0;

  const target = vec3();
  if (is_blind) {
    VectorCopy(self.monsterinfo.blind_fire_target, target);
  } else {
    VectorCopy(self.enemy.s.origin, target);
    target[2] += self.enemy.viewheight;
  }

  let tr = gi.trace(start, null, null, target, self, CLEARSHOT_MASK);

  if (traceEdict(tr.ent) === self.enemy || traceEdict(tr.ent).client !== null || (tr.fraction > 0.8 && !tr.startsolid)) {
    return true;
  }

  if (!is_blind) {
    VectorCopy(self.enemy.s.origin, target);

    tr = gi.trace(start, null, null, target, self, CLEARSHOT_MASK);

    if (
      traceEdict(tr.ent) === self.enemy ||
      traceEdict(tr.ent).client !== null ||
      (tr.fraction > 0.8 && !tr.startsolid)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * rogue/g_rogue_newai.cpp:1083-1135 `PredictAim`, in the form kexgame's
 * m_supertank.ts carries (with the [Paril-KEX] "if our current attempt is
 * blocked, try the opposite eye height" flip).
 *
 * NOT g_newai.ts's PredictAim: that one is the pre-KEX rogue version (7
 * parameters, no `self`, no blocked-flip). The guncmdr's chaingun calls this
 * on every shot and was tuned against the KEX behavior, so the KEX form is
 * carried here.
 */
function PredictAim(
  self: EdictT,
  target: EdictT | null,
  start: Vec3,
  bolt_speed: number,
  eye_height: boolean,
  offset: number,
  aimdir: Vec3 | null,
  aimpoint: Vec3 | null,
): void {
  if (target === null || !target.inuse) {
    if (aimdir !== null) VectorSet(aimdir, 0, 0, 0);
    return;
  }

  let eh = eye_height;
  const dir = vec3();
  VectorSubtract(target.s.origin, start, dir);
  if (eh) dir[2] += target.viewheight;
  let dist = VectorLength(dir);

  // [Paril-KEX] if our current attempt is blocked, try the opposite one
  const probeEnd = vec3();
  VectorAdd(start, dir, probeEnd);
  const probe = gi.trace(start, null, null, probeEnd, self, MASK_SHOT);

  if (probe.ent === null || traceEdict(probe.ent) !== target) {
    eh = !eh;
    VectorSubtract(target.s.origin, start, dir);
    if (eh) dir[2] += target.viewheight;
    dist = VectorLength(dir);
  }

  const time = bolt_speed !== 0 ? dist / bolt_speed : 0;

  const vecOut = vec3();
  VectorMA(target.s.origin, time - offset, target.velocity, vecOut);

  const dirN = vec3();
  VectorCopy(dir, dirN);
  VectorNormalize(dirN);
  const toVec = vec3();
  VectorSubtract(vecOut, start, toVec);
  VectorNormalize(toVec);

  // went backwards...
  if (DotProduct(dirN, toVec) < 0) {
    VectorCopy(target.s.origin, vecOut);
  } else if (gi.trace(start, null, null, vecOut, null, MASK_SOLID).fraction < 0.9) {
    // if the shot is going to impact a nearby wall from our prediction, just
    // fire it straight.
    VectorCopy(target.s.origin, vecOut);
  }

  if (eh) vecOut[2] += target.viewheight;

  if (aimdir !== null) {
    VectorSubtract(vecOut, start, aimdir);
    VectorNormalize(aimdir);
  }
  if (aimpoint !== null) VectorCopy(vecOut, aimpoint);
}

const PITCH_TABLE = [-80, -70, -60, -50, -40, -30, -20, -10, -5];

/**
 * rogue/g_rogue_newai.cpp:1136-1196 `M_CalculatePitchToFire`, in its KEX
 * form (kexgame/m_supertank.ts). No classic counterpart exists.
 *
 * DEVIATION: `level.gravity` (a rerelease LevelLocalsT field) becomes the
 * sv_gravity cvar -- the classic LevelLocalsT has no `gravity` member, and
 * g_local.ts is not owned by this unit. sv_gravity is the value the classic
 * physics code itself integrates with (g_phys.ts), so the simulated arc
 * matches the arc the grenade will actually fly.
 */
function M_CalculatePitchToFire(
  self: EdictT,
  target: Vec3,
  start: Vec3,
  aim: Vec3,
  speed: number,
  time_remaining: number,
  mortar: boolean,
  destroy_on_touch = false,
): boolean {
  let best_pitch = 0;
  let best_dist = Infinity;

  const SIM_TIME = 0.1;
  const pitched_aim = vec3();
  vectoangles(aim, pitched_aim);

  const gravity = cvarNum(gameCvars.sv_gravity);

  for (const pitch of PITCH_TABLE) {
    if (mortar && pitch >= -30) break;

    pitched_aim[PITCH] = pitch;
    const fwd = vec3();
    AngleVectors(pitched_aim, fwd, null, null);

    const velocity = vec3();
    VectorScale(fwd, speed, velocity);
    const origin = vec3();
    VectorCopy(start, origin);

    let t = time_remaining;

    while (t > 0) {
      velocity[2] -= gravity * SIM_TIME;

      const end = vec3();
      VectorMA(origin, SIM_TIME, velocity, end);
      const tr = gi.trace(origin, null, null, end, null, MASK_SHOT);

      VectorCopy(tr.endpos, origin);

      if (tr.fraction < 1.0) {
        if (tr.surface !== null && (tr.surface.flags & SURF_SKY) !== 0) break;

        VectorAdd(origin, tr.plane.normal, origin);
        const clipped = vec3();
        ClipVelocity(velocity, tr.plane.normal, clipped, 1.6);
        VectorCopy(clipped, velocity);

        const diff = vec3();
        VectorSubtract(origin, target, diff);
        const dist = DotProduct(diff, diff);
        const trEnt = tr.ent !== null ? traceEdict(tr.ent) : null;

        if (
          trEnt === self.enemy ||
          (trEnt !== null && trEnt.client !== null) ||
          (tr.plane.normal[2] >= 0.7 && dist < 128 * 128 && dist < best_dist)
        ) {
          best_pitch = pitch;
          best_dist = dist;
        }

        if (destroy_on_touch || (tr.contents & (CONTENTS_MONSTER | CONTENTS_DEADMONSTER)) !== 0) break;
      }

      t -= SIM_TIME;
    }
  }

  if (Number.isFinite(best_dist)) {
    pitched_aim[PITCH] = best_pitch;
    const fwd = vec3();
    AngleVectors(pitched_aim, fwd, null, null);
    VectorCopy(fwd, aim);
    return true;
  }

  return false;
}

/**
 * kexgame/m_move.ts `ai_check_move` -- "could I take a step of `dist` in the
 * direction I am facing?", used by the chaingun attack to decide between
 * standing fire and run-and-gun.
 *
 * The re-release calls SV_movestep(self, move, /*relink*\/ false) directly.
 * SV_movestep is module-private in the classic m_move.ts (which this unit
 * does not own), so this goes through the exported M_walkmove and then puts
 * the origin back.
 *
 * DOCUMENTED DEGRADATION: M_walkmove relinks and runs G_TouchTriggers at the
 * probed position on success, which SV_movestep(..., false) does not. The
 * origin is restored and the entity relinked immediately afterwards, so the
 * monster does not actually move; the one observable difference is that a
 * trigger volume 8 units ahead of a firing guncmdr can be touched a frame
 * early. REPORTED: an exported `ai_check_move` (or SV_movestep with
 * relink=false) in m_move.ts would remove this entirely.
 *
 * The re-release also gates on an `ai_movement_disabled` cvar; that cvar does
 * not exist in the classic module, so the gate is dropped (it defaults to 0
 * / "movement enabled" there anyway).
 */
function ai_check_move(self: EdictT, dist: number): boolean {
  const old_origin = vec3();
  VectorCopy(self.s.origin, old_origin);

  if (!M_walkmove(self, self.s.angles[YAW], dist)) return false;

  VectorCopy(old_origin, self.s.origin);
  gi.linkentity(self);
  return true;
}

/**
 * m_berserk.cpp:212-255 `T_SlamRadiusDamage`, forward-declared by
 * guncmdr.cpp:1272. Duplicated locally exactly as kexgame does -- neither
 * family's m_berserk exports it.
 */
function T_SlamRadiusDamage(
  pointIn: Vec3,
  inflictor: EdictT,
  attacker: EdictT,
  damage: number,
  kick: number,
  ignore: EdictT,
  radius: number,
  mod: number,
): void {
  const point = vec3(pointIn[0], pointIn[1], pointIn[2]);
  let ent: EdictT | null = null;

  while ((ent = findradius(ent, inflictor.s.origin, radius * 2.0)) !== null) {
    if (ent === ignore) continue;
    if (!ent.takedamage) continue;
    if (!CanDamage(ent, inflictor)) continue;
    if (ent.client !== null && ent.groundentity === null) continue;

    const absmin = vec3();
    const absmax = vec3();
    VectorAdd(ent.s.origin, ent.mins, absmin);
    VectorAdd(ent.s.origin, ent.maxs, absmax);
    const v = vec3();
    VectorSubtract(closest_point_to_box(point, absmin, absmax), point, v);

    const amount0 = Math.min(1.0, 1.0 - VectorLength(v) / radius);
    if (amount0 <= 0.0) continue;

    const amount = amount0 * amount0;
    const points = Math.max(1.0, damage * amount);
    const dir = vec3();
    VectorSubtract(ent.s.origin, point, dir);
    VectorNormalize(dir);

    point[2] = ent.absmin[2];

    T_Damage(
      ent,
      inflictor,
      attacker,
      dir,
      point,
      dir,
      Math.trunc(points),
      Math.trunc(kick * amount),
      DAMAGE_RADIUS,
      mod,
    );

    if (ent.client !== null) ent.velocity[2] = Math.max(270.0, ent.velocity[2]);
  }
}

/**
 * kexgame/g_monster.ts `monster_fire_flechette` -- fire_flechette plus the
 * multicast muzzleflash. No classic counterpart (g_monster.ts is not owned by
 * this unit), so the two-line body lives here.
 */
function monster_fire_flechette(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
): void {
  fire_flechette(self, start, dir, damage, speed, Math.trunc(damage / 2));

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

/**
 * The re-release's `fire_grenade` takes right_adjust/up_adjust parameters;
 * the classic one (g_weapon.ts) hardcodes `200 + crandom()*10` up and
 * `crandom()*10` right -- i.e. exactly the values GunnerCmdrGrenade passes on
 * its FAILED-pitch path. The SUCCESSFUL-pitch path passes a much smaller
 * `frandom()*10` up adjust, which the classic function cannot express, so the
 * parameterized form is carried here.
 *
 * Everything else is the classic fire_grenade verbatim (same movetype,
 * clipmask, avelocity, model, timer, touch, think), plus the svc_muzzleflash2
 * write that classic `monster_fire_grenade` (g_monster.ts) appends.
 *
 * DEVIATION: the re-release scales up_adjust by `level.gravity / 800`; the
 * classic LevelLocalsT has no gravity member, so the sv_gravity cvar is used
 * -- the same substitution M_CalculatePitchToFire makes above.
 */
function guncmdr_fire_grenade(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
  right_adjust: number,
  up_adjust: number,
): void {
  const dirAngles = vec3();
  vectoangles(aimdir, dirAngles);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dirAngles, forward, right, up);

  const grenade = G_Spawn();
  VectorCopy(start, grenade.s.origin);
  VectorScale(aimdir, speed, grenade.velocity);

  if (up_adjust !== 0) {
    const gravityAdjustment = cvarNum(gameCvars.sv_gravity) / 800;
    VectorMA(grenade.velocity, up_adjust * gravityAdjustment, up, grenade.velocity);
  }
  if (right_adjust !== 0) {
    VectorMA(grenade.velocity, right_adjust, right, grenade.velocity);
  }

  grenade.avelocity[0] = 300;
  grenade.avelocity[1] = 300;
  grenade.avelocity[2] = 300;
  grenade.movetype = MovetypeT.MOVETYPE_BOUNCE;
  grenade.clipmask = MASK_SHOT;
  grenade.solid = SolidT.SOLID_BBOX;
  grenade.s.effects |= EF_GRENADE;
  VectorSet(grenade.mins, 0, 0, 0);
  VectorSet(grenade.maxs, 0, 0, 0);
  grenade.s.modelindex = gi.modelindex("models/objects/grenade/tris.md2");
  grenade.owner = self;
  grenade.touch = Grenade_Touch;
  grenade.nextthink = level.time + 2.5;
  grenade.think = Grenade_Explode;
  grenade.dmg = damage;
  grenade.dmg_radius = damage + 40;
  grenade.classname = "grenade";

  gi.linkentity(grenade);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t builders (same shape as m_tank.ts's own mkmove)
// ---------------------------------------------------------------------------

function mkframe(
  aifunc: ((self: EdictT, dist: number) => void) | null,
  dist = 0,
  thinkfunc: ((self: EdictT) => void) | null = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mkmove(
  firstframe: number,
  lastframe: number,
  frames: MframeT[],
  endfunc: ((self: EdictT) => void) | null = null,
): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frames;
  m.endfunc = endfunc;
  return m;
}

let sound_pain = 0;
let sound_pain2 = 0;
let sound_death = 0;
let sound_idle = 0;
let sound_open = 0;
let sound_search = 0;
let sound_sight = 0;

/** g_local.h:3281-3286 `inline void monster_footstep(edict_t *self)`. */
function monster_footstep(self: EdictT): void {
  // EV_OTHER_FOOTSTEP -- both families' EntityEventT enums place it at the
  // same index (src/shared/q_shared.ts's own EntityEventT carries it), so the
  // constant is the same value on either side of the wire.
  if (self.groundentity !== null) self.s.event = EntityEventT.EV_OTHER_FOOTSTEP;
}

//
// guncmdr_idlesound / guncmdr_sight / guncmdr_search (guncmdr.cpp:25-38)
//

function guncmdr_idlesound(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function guncmdr_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function guncmdr_search(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

//
// fidget / stand (guncmdr.cpp:47-170)
//

function guncmdr_stand(self: EdictT): void {
  self.monsterinfo.currentmove = guncmdr_move_stand;
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
const guncmdr_move_fidget = mkmove(
  FRAME.FRAME_c_stand201,
  FRAME.FRAME_c_stand254,
  guncmdr_frames_fidget,
  guncmdr_stand,
);

function guncmdr_fidget(self: EdictT): void {
  if ((self.monsterinfo.aiflags & AI_STAND_GROUND) !== 0) return;
  else if (self.enemy !== null) return;
  if (frandom() <= 0.05) self.monsterinfo.currentmove = guncmdr_move_fidget;
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
const guncmdr_move_stand = mkmove(FRAME.FRAME_c_stand101, FRAME.FRAME_c_stand140, guncmdr_frames_stand, null);

function guncmdr_run(self: EdictT): void {
  monster_done_dodge(self);
  if ((self.monsterinfo.aiflags & AI_STAND_GROUND) !== 0) self.monsterinfo.currentmove = guncmdr_move_stand;
  else self.monsterinfo.currentmove = guncmdr_move_run;
}

//
// walk / run (guncmdr.cpp:172-225)
//

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
const guncmdr_move_walk = mkmove(FRAME.FRAME_c_walk101, FRAME.FRAME_c_walk124, guncmdr_frames_walk, null);

function guncmdr_walk(self: EdictT): void {
  self.monsterinfo.currentmove = guncmdr_move_walk;
}

const guncmdr_frames_run: MframeT[] = [
  mkframe(ai_run, 15.0, monster_done_dodge),
  mkframe(ai_run, 16.0, monster_footstep),
  mkframe(ai_run, 20.0),
  mkframe(ai_run, 18.0),
  mkframe(ai_run, 24.0, monster_footstep),
  mkframe(ai_run, 13.5),
];
const guncmdr_move_run = mkmove(FRAME.FRAME_c_run101, FRAME.FRAME_c_run106, guncmdr_frames_run, null);

//
// standing pains 1-4 (guncmdr.cpp:227-271)
//

const guncmdr_frames_pain1: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const guncmdr_move_pain1 = mkmove(FRAME.FRAME_c_pain101, FRAME.FRAME_c_pain104, guncmdr_frames_pain1, guncmdr_run);

const guncmdr_frames_pain2: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const guncmdr_move_pain2 = mkmove(FRAME.FRAME_c_pain201, FRAME.FRAME_c_pain204, guncmdr_frames_pain2, guncmdr_run);

const guncmdr_frames_pain3: MframeT[] = [mkframe(ai_move, -3.0), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const guncmdr_move_pain3 = mkmove(FRAME.FRAME_c_pain301, FRAME.FRAME_c_pain304, guncmdr_frames_pain3, guncmdr_run);

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
const guncmdr_move_pain4 = mkmove(FRAME.FRAME_c_pain401, FRAME.FRAME_c_pain415, guncmdr_frames_pain4, guncmdr_run);

//
// death1 / death2 / pain5 (guncmdr.cpp:273-353)
//

/**
 * guncmdr.cpp's guncmdr_dead -> monster_dead(self).
 *
 * DOCUMENTED DEGRADATION: the re-release's monster_dead also installs
 * monster_dead_think (corpse fly sounds, slow frame advance). The classic
 * module has no such think and g_monster.ts is not owned by this unit, so the
 * vanilla 3.21 dead-monster idiom (m_tank.ts's tank_dead) is used and the
 * corpse is inert like every other classic corpse.
 */
function guncmdr_dead(self: EdictT): void {
  VectorSet(self.mins, -16 * self.s.scale, -16 * self.s.scale, -24 * self.s.scale);
  VectorSet(self.maxs, 16 * self.s.scale, 16 * self.s.scale, -8 * self.s.scale);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
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
const guncmdr_move_death1 = mkmove(
  FRAME.FRAME_c_death101,
  FRAME.FRAME_c_death118,
  guncmdr_frames_death1,
  guncmdr_dead,
);

function guncmdr_pain5_to_death1(self: EdictT): void {
  if (self.health < 0) self.monsterinfo.currentmove = guncmdr_move_death1;
}

const guncmdr_frames_death2: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const guncmdr_move_death2 = mkmove(
  FRAME.FRAME_c_death201,
  FRAME.FRAME_c_death204,
  guncmdr_frames_death2,
  guncmdr_dead,
);

function guncmdr_pain5_to_death2(self: EdictT): void {
  if (self.health < 0 && brandom()) self.monsterinfo.currentmove = guncmdr_move_death2;
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
const guncmdr_move_pain5 = mkmove(FRAME.FRAME_c_pain501, FRAME.FRAME_c_pain524, guncmdr_frames_pain5, guncmdr_run);

function guncmdr_shrink(self: EdictT): void {
  self.maxs[2] = -4 * self.s.scale;
  self.svflags |= SVF_DEADMONSTER;
  gi.linkentity(self);
}

//
// death6 / pain6 / pain7 (guncmdr.cpp:362-424)
//

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
const guncmdr_move_death6 = mkmove(
  FRAME.FRAME_c_death601,
  FRAME.FRAME_c_death614,
  guncmdr_frames_death6,
  guncmdr_dead,
);

function guncmdr_pain6_to_death6(self: EdictT): void {
  if (self.health < 0) self.monsterinfo.currentmove = guncmdr_move_death6;
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
const guncmdr_move_pain6 = mkmove(FRAME.FRAME_c_pain601, FRAME.FRAME_c_pain632, guncmdr_frames_pain6, guncmdr_run);

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
const guncmdr_move_pain7 = mkmove(FRAME.FRAME_c_pain701, FRAME.FRAME_c_pain714, guncmdr_frames_pain7, guncmdr_run);

//
// guncmdr_pain (guncmdr.cpp:451-526)
//

function guncmdr_pain(self: EdictT, other: EdictT, _kick: number, damage: number): void {
  monster_done_dodge(self);

  if (
    self.monsterinfo.currentmove === guncmdr_move_jump ||
    self.monsterinfo.currentmove === guncmdr_move_jump2 ||
    self.monsterinfo.currentmove === guncmdr_move_duck_attack
  ) {
    return;
  }

  // The C++ calls `self->monsterinfo.dodge(self, other, FRAME_TIME_S,
  // nullptr, false)`. The classic MonsterInfoT.dodge field is typed with a
  // non-nullable trace, so the (always-M_MonsterDodge) handler is called
  // directly instead of through the field -- identical behavior, and the
  // imported g_newai.ts M_MonsterDodge already accepts a null trace.
  if (level.time < self.pain_debounce_time) {
    if (frandom() < 0.3) M_MonsterDodge(self, other, FRAMETIME, null);
    return;
  }

  self.pain_debounce_time = level.time + 3;

  if (brandom()) gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  if (!guncmdrShouldReactToPain(self)) {
    if (frandom() < 0.3) M_MonsterDodge(self, other, FRAMETIME, null);
    return; // no pain anims in nightmare
  }

  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);

  const dif = vec3();
  VectorSubtract(other.s.origin, self.s.origin, dif);
  dif[2] = 0;
  VectorNormalize(dif);

  if (damage < 35) {
    const r = irandom(0, 4);

    if (r === 0) self.monsterinfo.currentmove = guncmdr_move_pain3;
    else if (r === 1) self.monsterinfo.currentmove = guncmdr_move_pain2;
    else if (r === 2) self.monsterinfo.currentmove = guncmdr_move_pain1;
    else self.monsterinfo.currentmove = guncmdr_move_pain7;
  } else if (DotProduct(dif, forward) < -0.4) {
    // large pain from behind (aka Paril)
    self.monsterinfo.currentmove = guncmdr_move_pain6;
    self.pain_debounce_time += 1.5;
  } else {
    if (brandom()) self.monsterinfo.currentmove = guncmdr_move_pain4;
    else self.monsterinfo.currentmove = guncmdr_move_pain5;
    self.pain_debounce_time += 1.5;
  }

  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;

  // PMM - clear duck flag
  if ((self.monsterinfo.aiflags & AI_DUCKED) !== 0) monster_duck_up(self);
}

/**
 * guncmdr.cpp:528-534 `guncmdr_setskin`.
 *
 * DOCUMENTED DEGRADATION: the classic MonsterInfoT has no `setskin` field and
 * the classic monster_think never calls one, so nothing invokes this today
 * and a wounded guncmdr keeps its undamaged skin. The function is kept (and
 * save-registered) so that adding `setskin` to MonsterInfoT plus the one call
 * in g_monster.ts's monster_think is all that is needed to restore it.
 * REPORTED for g_local.ts / g_monster.ts.
 */
function guncmdr_setskin(self: EdictT): void {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
}

//
// death3 / death7 / death4 / death5 (guncmdr.cpp:536-674)
//

function guncmdr_footstep_and_shrink(self: EdictT): void {
  monster_footstep(self);
  guncmdr_shrink(self);
}

const guncmdr_frames_death3: MframeT[] = [
  mkframe(ai_move, 20.0),
  mkframe(ai_move, 10.0),
  mkframe(ai_move, 10.0, guncmdr_footstep_and_shrink),
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
const guncmdr_move_death3 = mkmove(
  FRAME.FRAME_c_death301,
  FRAME.FRAME_c_death321,
  guncmdr_frames_death3,
  guncmdr_dead,
);

const guncmdr_frames_death7: MframeT[] = [
  mkframe(ai_move, 30.0),
  mkframe(ai_move, 20.0),
  mkframe(ai_move, 16.0, guncmdr_footstep_and_shrink),
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
const guncmdr_move_death7 = mkmove(
  FRAME.FRAME_c_death701,
  FRAME.FRAME_c_death730,
  guncmdr_frames_death7,
  guncmdr_dead,
);

const guncmdr_frames_death4: MframeT[] = [
  mkframe(ai_move, -20.0),
  mkframe(ai_move, -16.0),
  mkframe(ai_move, -26.0, guncmdr_footstep_and_shrink),
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
const guncmdr_move_death4 = mkmove(
  FRAME.FRAME_c_death401,
  FRAME.FRAME_c_death436,
  guncmdr_frames_death4,
  guncmdr_dead,
);

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
const guncmdr_move_death5 = mkmove(
  FRAME.FRAME_c_death501,
  FRAME.FRAME_c_death528,
  guncmdr_frames_death5,
  guncmdr_dead,
);

//
// guncmdr_die (guncmdr.cpp:676-764)
//

function guncmdr_die(self: EdictT, inflictor: EdictT, _attacker: EdictT, damage: number, point: Vec3): void {
  // DOCUMENTED DEGRADATION: the re-release's M_CheckGib also gibs an already
  // dead monster on MOD_CRUSH; the classic die signature carries no `mod`.
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    const head_gib =
      self.monsterinfo.currentmove !== guncmdr_move_death5
        ? "models/objects/gibs/sm_meat/tris.md2"
        : "models/monsters/gunner/gibs/head.md2";

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    // DOCUMENTED DEGRADATION: the re-release throws these through ThrowGibs
    // with GIB_SKINNED / GIB_UPRIGHT flags and a per-gib scale, none of which
    // the classic ThrowGib/ThrowHead have. Each gib keeps its model, count
    // and organic-vs-metallic character; the skinned/upright presentation and
    // the 1.25x gib scale are lost.
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowGib(self, "models/objects/gibs/gear/tris.md2", damage, GIB_METALLIC);
    ThrowGib(self, "models/monsters/gunner/gibs/chest.md2", damage, GIB_ORGANIC);
    ThrowGib(self, "models/monsters/gunner/gibs/garm.md2", damage, GIB_ORGANIC);
    ThrowGib(self, "models/monsters/gunner/gibs/gun.md2", damage, GIB_METALLIC);
    ThrowGib(self, "models/monsters/gunner/gibs/foot.md2", damage, GIB_ORGANIC);
    ThrowHead(self, head_gib, damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  // these animations cleanly transition to death, so just keep going
  if (self.monsterinfo.currentmove === guncmdr_move_pain5 && self.s.frame < FRAME.FRAME_c_pain508) return;
  else if (self.monsterinfo.currentmove === guncmdr_move_pain6 && self.s.frame < FRAME.FRAME_c_pain607) return;

  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);

  const dif = vec3();
  VectorSubtract(inflictor.s.origin, self.s.origin, dif);
  dif[2] = 0;
  VectorNormalize(dif);

  // off with da head
  if (Math.abs(self.s.origin[2] + self.viewheight - point[2]) <= 4 && self.velocity[2] < 65.0) {
    self.monsterinfo.currentmove = guncmdr_move_death5;

    // DOCUMENTED DEGRADATION: the re-release captures the edict ThrowGib
    // returns and re-places it (angles copied from the body, origin lifted
    // 24 units, velocity aimed away from the inflictor at 100 u/s with a
    // 200 u/s pop, avelocity damped to 15%). The classic ThrowGib returns
    // void and its internals (gib_die/gib_touch/VelocityForDamage/
    // ClipGibVelocity) are module-private to g_misc.ts, which this unit does
    // not own -- so the head is thrown with ThrowGib's ordinary randomized
    // placement and velocity instead of the scripted pop.
    ThrowGib(self, "models/monsters/gunner/gibs/head.md2", damage, GIB_ORGANIC);
  } else if (DotProduct(dif, forward) < -0.4) {
    // damage came from behind; use backwards death
    const r = irandom(0, self.monsterinfo.currentmove === guncmdr_move_pain6 ? 2 : 3);

    if (r === 0) self.monsterinfo.currentmove = guncmdr_move_death3;
    else if (r === 1) self.monsterinfo.currentmove = guncmdr_move_death7;
    else if (r === 2) self.monsterinfo.currentmove = guncmdr_move_pain6;
  } else {
    const r = irandom(0, self.monsterinfo.currentmove === guncmdr_move_pain5 ? 1 : 2);

    if (r === 0) self.monsterinfo.currentmove = guncmdr_move_death4;
    else self.monsterinfo.currentmove = guncmdr_move_pain5;
  }
}

//
// chaingun attack (guncmdr.cpp:766-851)
//

function guncmdr_opengun(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_open, 1, ATTN_IDLE, 0);
}

function GunnerCmdrFire(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const flash_number =
    self.s.frame >= FRAME.FRAME_c_attack401 && self.s.frame <= FRAME.FRAME_c_attack505
      ? MZ2_GUNCMDR_CHAINGUN_2
      : MZ2_GUNCMDR_CHAINGUN_1;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const start = vec3();
  M_ProjectFlashSource(self, guncmdrFlashOffset(flash_number), forward, right, start);

  const aim = vec3();
  PredictAim(self, self.enemy, start, 800, false, frandom() * 0.3, aim, null);
  for (let i = 0; i < 3; i++) aim[i] += crandom_open() * 0.025;
  monster_fire_flechette(self, start, aim, 4, 800, flash_number);
}

function guncmdr_fire_chain(self: EdictT): void {
  if (
    (self.monsterinfo.aiflags & AI_STAND_GROUND) === 0 &&
    self.enemy !== null &&
    range_to(self, self.enemy) > RANGE_CHAINGUN_RUN &&
    ai_check_move(self, 8.0)
  ) {
    self.monsterinfo.currentmove = guncmdr_move_fire_chain_run;
  } else {
    self.monsterinfo.currentmove = guncmdr_move_fire_chain;
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
const guncmdr_move_attack_chain = mkmove(
  FRAME.FRAME_c_attack101,
  FRAME.FRAME_c_attack106,
  guncmdr_frames_attack_chain,
  guncmdr_fire_chain,
);

function guncmdr_refire_chain(self: EdictT): void {
  monster_done_dodge(self);
  self.monsterinfo.attack_state = AS_STRAIGHT;

  if (self.enemy !== null && self.enemy.health > 0 && visible(self, self.enemy) && frandom() <= 0.5) {
    if (
      (self.monsterinfo.aiflags & AI_STAND_GROUND) === 0 &&
      range_to(self, self.enemy) > RANGE_CHAINGUN_RUN &&
      ai_check_move(self, 8.0)
    ) {
      self.monsterinfo.currentmove = guncmdr_move_fire_chain_run;
    } else {
      self.monsterinfo.currentmove = guncmdr_move_fire_chain;
    }
    return;
  }
  self.monsterinfo.currentmove = guncmdr_move_endfire_chain;
}

const guncmdr_frames_fire_chain: MframeT[] = [
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
  mkframe(ai_charge, 0, GunnerCmdrFire),
];
const guncmdr_move_fire_chain = mkmove(
  FRAME.FRAME_c_attack107,
  FRAME.FRAME_c_attack112,
  guncmdr_frames_fire_chain,
  guncmdr_refire_chain,
);

const guncmdr_frames_fire_chain_run: MframeT[] = [
  mkframe(ai_charge, 15.0, GunnerCmdrFire),
  mkframe(ai_charge, 16.0, GunnerCmdrFire),
  mkframe(ai_charge, 20.0, GunnerCmdrFire),
  mkframe(ai_charge, 18.0, GunnerCmdrFire),
  mkframe(ai_charge, 24.0, GunnerCmdrFire),
  mkframe(ai_charge, 13.5, GunnerCmdrFire),
];
const guncmdr_move_fire_chain_run = mkmove(
  FRAME.FRAME_c_run201,
  FRAME.FRAME_c_run206,
  guncmdr_frames_fire_chain_run,
  guncmdr_refire_chain,
);

const guncmdr_frames_fire_chain_dodge_right: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 9.0 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.5 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.6 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, -1.0 * 2.0, GunnerCmdrFire),
];
const guncmdr_move_fire_chain_dodge_right = mkmove(
  FRAME.FRAME_c_attack401,
  FRAME.FRAME_c_attack405,
  guncmdr_frames_fire_chain_dodge_right,
  guncmdr_refire_chain,
);

const guncmdr_frames_fire_chain_dodge_left: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 9.0 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.5 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, 3.6 * 2.0, GunnerCmdrFire),
  mkframe(ai_charge, -1.0 * 2.0, GunnerCmdrFire),
];
const guncmdr_move_fire_chain_dodge_left = mkmove(
  FRAME.FRAME_c_attack501,
  FRAME.FRAME_c_attack505,
  guncmdr_frames_fire_chain_dodge_left,
  guncmdr_refire_chain,
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
const guncmdr_move_endfire_chain = mkmove(
  FRAME.FRAME_c_attack118,
  FRAME.FRAME_c_attack124,
  guncmdr_frames_endfire_chain,
  guncmdr_run,
);

//
// grenade patterns: mortar / front / crouch (guncmdr.cpp:853-1049)
//

function GunnerCmdrGrenade(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const blindfire = (self.monsterinfo.aiflags & AI_MANUAL_STEERING) !== 0;

  // `spread` and `flash_number` are uninitialized C++ locals assigned only
  // inside the if/else-if chain below; every real call path's s.frame is one
  // of the nine frames it covers, so these placeholders are always
  // overwritten before use (see file header).
  let spread = 0;
  let flash_number = MZ2_GUNCMDR_GRENADE_MORTAR_1;
  let pitch = 0;

  if (self.s.frame === FRAME.FRAME_c_attack205) {
    spread = -0.1;
    flash_number = MZ2_GUNCMDR_GRENADE_MORTAR_1;
  } else if (self.s.frame === FRAME.FRAME_c_attack208) {
    spread = 0.0;
    flash_number = MZ2_GUNCMDR_GRENADE_MORTAR_2;
  } else if (self.s.frame === FRAME.FRAME_c_attack211) {
    spread = 0.1;
    flash_number = MZ2_GUNCMDR_GRENADE_MORTAR_3;
  } else if (self.s.frame === FRAME.FRAME_c_attack304) {
    spread = -0.1;
    flash_number = MZ2_GUNCMDR_GRENADE_FRONT_1;
  } else if (self.s.frame === FRAME.FRAME_c_attack307) {
    spread = 0.0;
    flash_number = MZ2_GUNCMDR_GRENADE_FRONT_2;
  } else if (self.s.frame === FRAME.FRAME_c_attack310) {
    spread = 0.1;
    flash_number = MZ2_GUNCMDR_GRENADE_FRONT_3;
  } else if (self.s.frame === FRAME.FRAME_c_attack911) {
    spread = 0.25;
    flash_number = MZ2_GUNCMDR_GRENADE_CROUCH_1;
  } else if (self.s.frame === FRAME.FRAME_c_attack912) {
    spread = 0.0;
    flash_number = MZ2_GUNCMDR_GRENADE_CROUCH_2;
  } else if (self.s.frame === FRAME.FRAME_c_attack913) {
    spread = -0.25;
    flash_number = MZ2_GUNCMDR_GRENADE_CROUCH_3;
  }

  const isCrouch = flash_number >= MZ2_GUNCMDR_GRENADE_CROUCH_1 && flash_number <= MZ2_GUNCMDR_GRENADE_CROUCH_3;
  const isFront = flash_number >= MZ2_GUNCMDR_GRENADE_FRONT_1 && flash_number <= MZ2_GUNCMDR_GRENADE_FRONT_3;
  const isMortar = flash_number >= MZ2_GUNCMDR_GRENADE_MORTAR_1 && flash_number <= MZ2_GUNCMDR_GRENADE_MORTAR_3;

  const target = vec3();
  if (blindfire && !visible(self, self.enemy)) {
    const bft = self.monsterinfo.blind_fire_target;
    if (bft[0] === 0 && bft[1] === 0 && bft[2] === 0) return;
    VectorCopy(bft, target);
  } else {
    VectorCopy(self.enemy.s.origin, target);
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);
  const start = vec3();
  M_ProjectFlashSource(self, guncmdrFlashOffset(flash_number), forward, right, start);

  if (!isCrouch) {
    const toTarget = vec3();
    VectorSubtract(target, self.s.origin, toTarget);
    const dist = VectorLength(toTarget);

    // aim up if they're on the same level as me and far away.
    if (dist > 512 && toTarget[2] < 64 && toTarget[2] > -64) {
      toTarget[2] += dist - 512;
    }

    const normalized = vec3();
    VectorCopy(toTarget, normalized);
    VectorNormalize(normalized);
    pitch = normalized[2];
    if (pitch > 0.4) pitch = 0.4;
    else if (pitch < -0.5) pitch = -0.5;

    if (self.enemy.absmin[2] - self.absmax[2] > 16.0 && isMortar) pitch += 0.5;
  }

  if (isFront) pitch -= 0.05;

  const aim = vec3();
  if (!isCrouch) {
    VectorCopy(forward, aim);
    VectorMA(aim, spread, right, aim);
    VectorMA(aim, pitch, up, aim);
    VectorNormalize(aim);
  } else {
    PredictAim(self, self.enemy, start, 800, false, 0.0, aim, null);
    VectorMA(aim, spread, right, aim);
    VectorNormalize(aim);
  }

  if (isCrouch) {
    const inner_spread = 0.125;

    for (let i = 0; i < 3; i++) {
      const shot = vec3();
      VectorMA(aim, -(inner_spread * 2) + inner_spread * (i + 1), right, shot);
      fire_ionripper(self, start, shot, 15, 800, EF_IONRIPPER);
    }

    gi.WriteByte(svc_muzzleflash2);
    gi.WriteShort(g_edicts.indexOf(self));
    gi.WriteByte(flash_number);
    gi.multicast(start, MulticastT.MULTICAST_PHS);
  } else {
    const speed = isMortar ? MORTAR_SPEED : GRENADE_SPEED;

    if (M_CalculatePitchToFire(self, target, start, aim, speed, 2.5, isMortar)) {
      guncmdr_fire_grenade(self, start, aim, 50, speed, flash_number, crandom_open() * 10.0, frandom() * 10.0);
    } else {
      guncmdr_fire_grenade(
        self,
        start,
        aim,
        50,
        speed,
        flash_number,
        crandom_open() * 10.0,
        200.0 + crandom_open() * 10.0,
      );
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
const guncmdr_move_attack_mortar = mkmove(
  FRAME.FRAME_c_attack201,
  FRAME.FRAME_c_attack221,
  guncmdr_frames_attack_mortar,
  guncmdr_run,
);

function guncmdr_grenade_mortar_resume(self: EdictT): void {
  self.monsterinfo.currentmove = guncmdr_move_attack_mortar;
  self.monsterinfo.attack_state = AS_STRAIGHT;
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
const guncmdr_move_attack_mortar_dodge = mkmove(
  FRAME.FRAME_c_duckstep01,
  FRAME.FRAME_c_duckstep06,
  guncmdr_frames_attack_mortar_dodge,
  guncmdr_grenade_mortar_resume,
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
const guncmdr_move_attack_grenade_back = mkmove(
  FRAME.FRAME_c_attack302,
  FRAME.FRAME_c_attack321,
  guncmdr_frames_attack_back,
  guncmdr_run,
);

function guncmdr_grenade_back_dodge_resume(self: EdictT): void {
  self.monsterinfo.currentmove = guncmdr_move_attack_grenade_back;
  self.monsterinfo.attack_state = AS_STRAIGHT;
  self.s.frame = self.count;
}

const guncmdr_frames_attack_grenade_back_dodge_right: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0),
  mkframe(ai_charge, 9.0 * 2.0),
  mkframe(ai_charge, 3.5 * 2.0),
  mkframe(ai_charge, 3.6 * 2.0),
  mkframe(ai_charge, -1.0 * 2.0),
];
const guncmdr_move_attack_grenade_back_dodge_right = mkmove(
  FRAME.FRAME_c_attack601,
  FRAME.FRAME_c_attack605,
  guncmdr_frames_attack_grenade_back_dodge_right,
  guncmdr_grenade_back_dodge_resume,
);

const guncmdr_frames_attack_grenade_back_dodge_left: MframeT[] = [
  mkframe(ai_charge, 5.1 * 2.0),
  mkframe(ai_charge, 9.0 * 2.0),
  mkframe(ai_charge, 3.5 * 2.0),
  mkframe(ai_charge, 3.6 * 2.0),
  mkframe(ai_charge, -1.0 * 2.0),
];
const guncmdr_move_attack_grenade_back_dodge_left = mkmove(
  FRAME.FRAME_c_attack701,
  FRAME.FRAME_c_attack705,
  guncmdr_frames_attack_grenade_back_dodge_left,
  guncmdr_grenade_back_dodge_resume,
);

//
// kick melee (guncmdr.cpp:1102-1128)
//

function guncmdr_kick_finished(self: EdictT): void {
  meleeDebounceTime.set(self, level.time + 3);
  if (self.monsterinfo.attack !== null) self.monsterinfo.attack(self);
}

function guncmdr_kick(self: EdictT): void {
  // MELEE_DISTANCE here is the CLASSIC 80, matched to the classic fire_hit's
  // origin-to-origin metric -- see the MELEE / RANGE block above.
  if (fire_hit(self, vec3(MELEE_DISTANCE, 0.0, -32.0), 15.0, 400.0)) {
    if (self.enemy !== null && self.enemy.client !== null && self.enemy.velocity[2] < 270.0) {
      self.enemy.velocity[2] = 270.0;
    }
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
const guncmdr_move_attack_kick = mkmove(
  FRAME.FRAME_c_attack801,
  FRAME.FRAME_c_attack808,
  guncmdr_frames_attack_kick,
  guncmdr_kick_finished,
);

//
// guncmdr_attack (guncmdr.cpp:1130-1170)
//

function guncmdr_attack(self: EdictT): void {
  monster_done_dodge(self);

  if (self.enemy === null) return;

  const d = range_to(self, self.enemy);

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  // The C++ inlines M_ProjectFlashSource(...) as M_CalculatePitchToFire's
  // `start` argument; the classic G_ProjectSource writes through an out
  // parameter instead of returning, so each of the two arc checks is wrapped
  // in this helper to keep the evaluation LAZY -- M_CalculatePitchToFire runs
  // a full ballistic trace simulation and must not be evaluated for a branch
  // the earlier conditions already rejected.
  const canArcTo = (flashId: number, speed: number, mortar: boolean): boolean => {
    if (self.enemy === null) return false;
    const start = vec3();
    M_ProjectFlashSource(self, guncmdrFlashOffset(flashId), forward, right, start);
    return M_CalculatePitchToFire(self, self.enemy.s.origin, start, normalizedToEnemy(self), speed, 2.5, mortar);
  };

  if (self.bad_area === null && d < RANGE_MELEE_BOX && getMeleeDebounceTime(self) < level.time) {
    self.monsterinfo.currentmove = guncmdr_move_attack_kick;
  } else if (
    self.bad_area !== null ||
    ((d <= RANGE_GRENADE || brandom()) && M_CheckClearShot(self, guncmdrFlashOffset(MZ2_GUNCMDR_CHAINGUN_1)))
  ) {
    self.monsterinfo.currentmove = guncmdr_move_attack_chain;
  } else if (
    (d >= RANGE_GRENADE_MORTAR || Math.abs(self.absmin[2] - self.enemy.absmax[2]) > 64.0) &&
    M_CheckClearShot(self, guncmdrFlashOffset(MZ2_GUNCMDR_GRENADE_MORTAR_1)) &&
    canArcTo(MZ2_GUNCMDR_GRENADE_MORTAR_1, MORTAR_SPEED, true)
  ) {
    self.monsterinfo.currentmove = guncmdr_move_attack_mortar;
    monster_duck_down(self);
  } else if (
    M_CheckClearShot(self, guncmdrFlashOffset(MZ2_GUNCMDR_GRENADE_FRONT_1)) &&
    (self.monsterinfo.aiflags & AI_STAND_GROUND) === 0 &&
    canArcTo(MZ2_GUNCMDR_GRENADE_FRONT_1, GRENADE_SPEED, false)
  ) {
    self.monsterinfo.currentmove = guncmdr_move_attack_grenade_back;
  } else if ((self.monsterinfo.aiflags & AI_STAND_GROUND) !== 0) {
    self.monsterinfo.currentmove = guncmdr_move_attack_chain;
  }
}

/** guncmdr.cpp's `(self->enemy->s.origin - self->s.origin).normalized()` argument. */
function normalizedToEnemy(self: EdictT): Vec3 {
  const v = vec3();
  if (self.enemy === null) return v;
  VectorSubtract(self.enemy.s.origin, self.s.origin, v);
  VectorNormalize(v);
  return v;
}

//
// jump-over-obstacle (guncmdr.cpp:1200-1270, PGM)
//

function guncmdr_jump_now(self: EdictT): void {
  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 100, forward, self.velocity);
  VectorMA(self.velocity, 300, up, self.velocity);
}

function guncmdr_jump2_now(self: EdictT): void {
  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 150, forward, self.velocity);
  VectorMA(self.velocity, 400, up, self.velocity);
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
const guncmdr_move_jump = mkmove(FRAME.FRAME_c_jump01, FRAME.FRAME_c_jump10, guncmdr_frames_jump, guncmdr_run);

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
const guncmdr_move_jump2 = mkmove(FRAME.FRAME_c_jump01, FRAME.FRAME_c_jump10, guncmdr_frames_jump2, guncmdr_run);

function guncmdr_jump(self: EdictT, result: BlockedJumpResultT): void {
  if (self.enemy === null) return;

  monster_done_dodge(self);

  if (result === BlockedJumpResultT.JUMP_JUMP_UP) self.monsterinfo.currentmove = guncmdr_move_jump2;
  else self.monsterinfo.currentmove = guncmdr_move_jump;
}

//
// duck-and-counter (guncmdr.cpp:1274-1341, PGM/PMM)
//

function GunnerCmdrCounter(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);
  const start = vec3();
  M_ProjectFlashSource(self, vec3(20.0, 0.0, 14.0), f, r, start);
  const tr = gi.trace(self.s.origin, null, null, start, self, MASK_SOLID);

  // DOCUMENTED DEGRADATION: the C++ writes a TE_BERSERK_SLAM temp entity
  // here. TE_BERSERK_SLAM is a re-release temp event with no id in the
  // classic protocol-34 TempEventT table and no classic client handler, so
  // the visual slam burst is dropped. The damage below is unaffected.

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
  // (guncmdr.cpp:1303-1305) are dead code and dropped.
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
const guncmdr_move_duck_attack = mkmove(
  FRAME.FRAME_c_attack901,
  FRAME.FRAME_c_attack919,
  guncmdr_frames_duck_attack,
  guncmdr_run,
);

/**
 * guncmdr.cpp's monsterinfo.duck.
 *
 * DOCUMENTED DEGRADATION: the re-release's M_MonsterDodge uses this
 * function's RETURN VALUE to decide whether to actually duck. The classic
 * MonsterInfoT types `duck` as returning void and g_newai.ts's (pre-KEX
 * rogue) M_MonsterDodge sets AI_DUCKED before calling it and ignores the
 * result, so a `false` return no longer suppresses the duck. The two
 * `return false` paths below still avoid switching animation, and the
 * dodging path still calls unduck (which clears AI_DUCKED); only the
 * jumping path can be left with AI_DUCKED set for one duck interval.
 */
function guncmdr_duck(self: EdictT, _eta: number): boolean {
  if (self.monsterinfo.currentmove === guncmdr_move_jump2 || self.monsterinfo.currentmove === guncmdr_move_jump) {
    return false;
  }

  if (
    self.monsterinfo.currentmove === guncmdr_move_fire_chain_dodge_left ||
    self.monsterinfo.currentmove === guncmdr_move_fire_chain_dodge_right ||
    self.monsterinfo.currentmove === guncmdr_move_attack_grenade_back_dodge_left ||
    self.monsterinfo.currentmove === guncmdr_move_attack_grenade_back_dodge_right ||
    self.monsterinfo.currentmove === guncmdr_move_attack_mortar_dodge
  ) {
    // if we're dodging, don't duck
    if (self.monsterinfo.unduck !== null) self.monsterinfo.unduck(self);
    return false;
  }

  self.monsterinfo.currentmove = guncmdr_move_duck_attack;
  return true;
}

//
// sidestep / blocked (guncmdr.cpp:1343-1393, PGM)
//

function guncmdr_sidestep(self: EdictT): boolean {
  // use special dodge during the main firing anim
  if (
    self.monsterinfo.currentmove === guncmdr_move_fire_chain ||
    self.monsterinfo.currentmove === guncmdr_move_fire_chain_run
  ) {
    self.monsterinfo.currentmove = !self.monsterinfo.lefty
      ? guncmdr_move_fire_chain_dodge_right
      : guncmdr_move_fire_chain_dodge_left;
    return true;
  }

  // for backwards mortar, back up where we are in the animation and do a quick dodge
  if (self.monsterinfo.currentmove === guncmdr_move_attack_grenade_back) {
    self.count = self.s.frame;
    self.monsterinfo.currentmove = !self.monsterinfo.lefty
      ? guncmdr_move_attack_grenade_back_dodge_right
      : guncmdr_move_attack_grenade_back_dodge_left;
    return true;
  }

  // use crouch-move for mortar dodge
  if (self.monsterinfo.currentmove === guncmdr_move_attack_mortar) {
    self.count = self.s.frame;
    self.monsterinfo.currentmove = guncmdr_move_attack_mortar_dodge;
    return true;
  }

  // regular sidestep during run
  if (self.monsterinfo.currentmove === guncmdr_move_run) {
    self.monsterinfo.currentmove = guncmdr_move_run;
    return true;
  }

  return false;
}

/**
 * kexgame/rogue/g_rogue_newai.ts `blocked_checkjump`, reduced to what the
 * classic module can express.
 *
 * g_newai.ts's exported blocked_checkjump is the pre-KEX ROGUE one: it takes
 * (self, dist, maxDown, maxUp) and returns a bare boolean, so it cannot tell
 * guncmdr_jump which of its two jump animations to play. This wrapper adds
 * back the two things the re-release's version has and the rogue one does
 * not: the jump COOLDOWN (kex gates on monsterinfo.jump_time; the classic
 * field set has no jump_time, so monster_jump_start/monster_jump_finished's
 * self.timestamp -- the same field rogue's own jumping monsters use -- gates
 * it at the rogue 3-second interval) and the UP/DOWN result, recovered with
 * the same enemy-elevation test blocked_checkjump itself uses internally.
 *
 * The re-release's AI_PATHING / nav_path branch and its water-depth check on
 * the down-jump have no classic counterpart (there is no navigation mesh in
 * this module) and are not ported. DOCUMENTED DEGRADATION.
 *
 * `can_jump` / `drop_height` / `jump_height` are monsterinfo fields in the
 * re-release; the classic MonsterInfoT has none of them, so can_jump is
 * recomputed from SPAWNFLAG_GUNCMDR_NOJUMPING and the two heights are the
 * literals SP_monster_guncmdr assigns. REPORTED for g_local.ts.
 */
function guncmdr_blocked_checkjump(self: EdictT, dist: number): BlockedJumpResultT {
  if (!guncmdrCanJump(self)) return BlockedJumpResultT.NO_JUMP;
  if (self.enemy === null) return BlockedJumpResultT.NO_JUMP;
  if (!monster_jump_finished(self)) return BlockedJumpResultT.NO_JUMP;

  if (!blocked_checkjump(self, dist, GUNCMDR_DROP_HEIGHT, GUNCMDR_JUMP_HEIGHT)) {
    return BlockedJumpResultT.NO_JUMP;
  }

  monster_jump_start(self);

  return self.enemy.absmin[2] > self.absmin[2] + 16
    ? BlockedJumpResultT.JUMP_JUMP_UP
    : BlockedJumpResultT.JUMP_JUMP_DOWN;
}

function guncmdr_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkplat(self, dist)) return true;

  const result = guncmdr_blocked_checkjump(self, dist);
  if (result !== BlockedJumpResultT.NO_JUMP) {
    if (result !== BlockedJumpResultT.JUMP_TURN) guncmdr_jump(self, result);
    return true;
  }

  return false;
}

/*QUAKED monster_guncmdr (1 .5 0) (-16 -16 -24) (16 16 36) Ambush Trigger_Spawn Sight NoJumping
 */
export function SP_monster_guncmdr(self: EdictT): void {
  if (!guncmdrAllowSpawn()) {
    G_FreeEdict(self);
    return;
  }

  sound_death = gi.soundindex("guncmdr/gcdrdeath1.wav");
  sound_pain = gi.soundindex("guncmdr/gcdrpain2.wav");
  sound_pain2 = gi.soundindex("guncmdr/gcdrpain1.wav");
  sound_idle = gi.soundindex("guncmdr/gcdridle1.wav");
  sound_open = gi.soundindex("guncmdr/gcdratck1.wav");
  sound_search = gi.soundindex("guncmdr/gcdrsrch1.wav");
  sound_sight = gi.soundindex("guncmdr/sight1.wav");

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

  // DOCUMENTED DEGRADATION (protocol 34): s.scale is set faithfully and is
  // read by this file's own M_ProjectFlashSource / guncmdr_dead /
  // guncmdr_shrink, so every server-side computation that depends on it is
  // correct. Protocol 34 has no per-entity scale field, so the model renders
  // at its native size under the classic ruleset.
  self.s.scale = 1.25;
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 36);
  self.s.skinnum = 2;

  self.health = Math.trunc(325 * healthMultiplier());
  self.gib_health = -175;
  self.mass = 255;

  // fresh edict slot: clear any melee debounce a recycled edict left behind.
  meleeDebounceTime.delete(self);

  self.pain = guncmdr_pain;
  self.die = guncmdr_die;

  self.monsterinfo.stand = guncmdr_stand;
  self.monsterinfo.walk = guncmdr_walk;
  self.monsterinfo.run = guncmdr_run;
  // pmm
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = guncmdr_duck;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = guncmdr_sidestep;
  self.monsterinfo.blocked = guncmdr_blocked; // PGM
  // pmm
  self.monsterinfo.attack = guncmdr_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = guncmdr_sight;
  self.monsterinfo.search = guncmdr_search;
  // self.monsterinfo.setskin = guncmdr_setskin;
  // ^ the classic MonsterInfoT has no `setskin` field -- see
  //   guncmdr_setskin's own doc comment.

  gi.linkentity(self);

  self.monsterinfo.currentmove = guncmdr_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  // The re-release checks `st.keys_specified` (the set of keys the .bsp
  // actually wrote) so an explicit `power_armor_power 0` is honored. The
  // classic SpawnTempT has no keys_specified set; ED_ParseField already
  // writes both keys straight onto monsterinfo, so a still-zero value here
  // means the map did not set one. DEVIATION: a map that explicitly writes
  // `power_armor_power 0` gets 200 instead of 0.
  if (self.monsterinfo.power_armor_power === 0) self.monsterinfo.power_armor_power = 200;
  if (self.monsterinfo.power_armor_type === 0) self.monsterinfo.power_armor_type = POWER_ARMOR_SHIELD;

  // PMM -- can_jump / drop_height / jump_height have no classic MonsterInfoT
  // fields; see guncmdr_blocked_checkjump for where those three values live.

  walkmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- see m_soldier.ts's own tail.
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_guncmdr:guncmdr_pain", guncmdr_pain);
registerSaveFunction("m_guncmdr:guncmdr_die", guncmdr_die);
registerSaveFunction("m_guncmdr:guncmdr_dead", guncmdr_dead);
registerSaveFunction("m_guncmdr:guncmdr_shrink", guncmdr_shrink);
registerSaveFunction("m_guncmdr:guncmdr_setskin", guncmdr_setskin);
registerSaveFunction("m_guncmdr:guncmdr_stand", guncmdr_stand);
registerSaveFunction("m_guncmdr:guncmdr_walk", guncmdr_walk);
registerSaveFunction("m_guncmdr:guncmdr_run", guncmdr_run);
registerSaveFunction("m_guncmdr:guncmdr_attack", guncmdr_attack);
registerSaveFunction("m_guncmdr:guncmdr_sight", guncmdr_sight);
registerSaveFunction("m_guncmdr:guncmdr_search", guncmdr_search);
registerSaveFunction("m_guncmdr:guncmdr_idlesound", guncmdr_idlesound);
registerSaveFunction("m_guncmdr:guncmdr_fidget", guncmdr_fidget);
registerSaveFunction("m_guncmdr:guncmdr_duck", guncmdr_duck);
registerSaveFunction("m_guncmdr:guncmdr_sidestep", guncmdr_sidestep);
registerSaveFunction("m_guncmdr:guncmdr_blocked", guncmdr_blocked);
registerSaveFunction("m_guncmdr:guncmdr_opengun", guncmdr_opengun);
registerSaveFunction("m_guncmdr:guncmdr_kick", guncmdr_kick);
registerSaveFunction("m_guncmdr:guncmdr_kick_finished", guncmdr_kick_finished);
registerSaveFunction("m_guncmdr:guncmdr_fire_chain", guncmdr_fire_chain);
registerSaveFunction("m_guncmdr:guncmdr_refire_chain", guncmdr_refire_chain);
registerSaveFunction("m_guncmdr:GunnerCmdrFire", GunnerCmdrFire);
registerSaveFunction("m_guncmdr:GunnerCmdrGrenade", GunnerCmdrGrenade);
registerSaveFunction("m_guncmdr:GunnerCmdrCounter", GunnerCmdrCounter);
registerSaveFunction("m_guncmdr:guncmdr_grenade_mortar_resume", guncmdr_grenade_mortar_resume);
registerSaveFunction("m_guncmdr:guncmdr_grenade_back_dodge_resume", guncmdr_grenade_back_dodge_resume);
registerSaveFunction("m_guncmdr:guncmdr_pain5_to_death1", guncmdr_pain5_to_death1);
registerSaveFunction("m_guncmdr:guncmdr_pain5_to_death2", guncmdr_pain5_to_death2);
registerSaveFunction("m_guncmdr:guncmdr_pain6_to_death6", guncmdr_pain6_to_death6);
registerSaveFunction("m_guncmdr:guncmdr_footstep_and_shrink", guncmdr_footstep_and_shrink);
registerSaveFunction("m_guncmdr:monster_footstep", monster_footstep);
registerSaveFunction("m_guncmdr:guncmdr_jump_now", guncmdr_jump_now);
registerSaveFunction("m_guncmdr:guncmdr_jump2_now", guncmdr_jump2_now);
registerSaveFunction("m_guncmdr:guncmdr_jump_wait_land", guncmdr_jump_wait_land);
registerSaveMmove("m_guncmdr:guncmdr_move_stand", guncmdr_move_stand);
registerSaveMmove("m_guncmdr:guncmdr_move_fidget", guncmdr_move_fidget);
registerSaveMmove("m_guncmdr:guncmdr_move_walk", guncmdr_move_walk);
registerSaveMmove("m_guncmdr:guncmdr_move_run", guncmdr_move_run);
registerSaveMmove("m_guncmdr:guncmdr_move_pain1", guncmdr_move_pain1);
registerSaveMmove("m_guncmdr:guncmdr_move_pain2", guncmdr_move_pain2);
registerSaveMmove("m_guncmdr:guncmdr_move_pain3", guncmdr_move_pain3);
registerSaveMmove("m_guncmdr:guncmdr_move_pain4", guncmdr_move_pain4);
registerSaveMmove("m_guncmdr:guncmdr_move_pain5", guncmdr_move_pain5);
registerSaveMmove("m_guncmdr:guncmdr_move_pain6", guncmdr_move_pain6);
registerSaveMmove("m_guncmdr:guncmdr_move_pain7", guncmdr_move_pain7);
registerSaveMmove("m_guncmdr:guncmdr_move_death1", guncmdr_move_death1);
registerSaveMmove("m_guncmdr:guncmdr_move_death2", guncmdr_move_death2);
registerSaveMmove("m_guncmdr:guncmdr_move_death3", guncmdr_move_death3);
registerSaveMmove("m_guncmdr:guncmdr_move_death4", guncmdr_move_death4);
registerSaveMmove("m_guncmdr:guncmdr_move_death5", guncmdr_move_death5);
registerSaveMmove("m_guncmdr:guncmdr_move_death6", guncmdr_move_death6);
registerSaveMmove("m_guncmdr:guncmdr_move_death7", guncmdr_move_death7);
registerSaveMmove("m_guncmdr:guncmdr_move_attack_chain", guncmdr_move_attack_chain);
registerSaveMmove("m_guncmdr:guncmdr_move_fire_chain", guncmdr_move_fire_chain);
registerSaveMmove("m_guncmdr:guncmdr_move_fire_chain_run", guncmdr_move_fire_chain_run);
registerSaveMmove("m_guncmdr:guncmdr_move_fire_chain_dodge_right", guncmdr_move_fire_chain_dodge_right);
registerSaveMmove("m_guncmdr:guncmdr_move_fire_chain_dodge_left", guncmdr_move_fire_chain_dodge_left);
registerSaveMmove("m_guncmdr:guncmdr_move_endfire_chain", guncmdr_move_endfire_chain);
registerSaveMmove("m_guncmdr:guncmdr_move_attack_mortar", guncmdr_move_attack_mortar);
registerSaveMmove("m_guncmdr:guncmdr_move_attack_mortar_dodge", guncmdr_move_attack_mortar_dodge);
registerSaveMmove("m_guncmdr:guncmdr_move_attack_grenade_back", guncmdr_move_attack_grenade_back);
registerSaveMmove(
  "m_guncmdr:guncmdr_move_attack_grenade_back_dodge_right",
  guncmdr_move_attack_grenade_back_dodge_right,
);
registerSaveMmove(
  "m_guncmdr:guncmdr_move_attack_grenade_back_dodge_left",
  guncmdr_move_attack_grenade_back_dodge_left,
);
registerSaveMmove("m_guncmdr:guncmdr_move_attack_kick", guncmdr_move_attack_kick);
registerSaveMmove("m_guncmdr:guncmdr_move_jump", guncmdr_move_jump);
registerSaveMmove("m_guncmdr:guncmdr_move_jump2", guncmdr_move_jump2);
registerSaveMmove("m_guncmdr:guncmdr_move_duck_attack", guncmdr_move_duck_attack);
