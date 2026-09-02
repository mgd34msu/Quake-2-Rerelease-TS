/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.

Ported from rerelease/m_shambler.cpp via src/kexgame/m_shambler.ts.
*/
/*
==============================================================================

SHAMBLER

==============================================================================
*/
//
// RERELEASE CONTENT PORT -- this monster exists ONLY in the 2023 re-release;
// there is no 3.21 baseq2/xatrix/rogue precedent anywhere in this tree.
// Originally a Quake 1 monster (the "smash"/"swingl"/"swingr"/"magic"
// animation names are a direct callback to shambler.qc); the re-release
// reimplements it as a Quake II monster whose ranged attack is a
// lightning-bolt (ShamblerCastLightning) instead of Quake 1's magic.
//
// Translation source: src/kexgame/m_shambler.ts, retargeted at the CLASSIC
// module's type machinery.
//
// ===========================================================================
// TRANSLATION NOTES (kexgame -> classic)
// ===========================================================================
// - TIME. kexgame's GTime (ms) becomes the classic float-seconds level.time:
//   Gtime_from_ms(1) -> FRAMETIME (0.1), Gtime_from_sec(2) -> 2.
// - CALLBACK REGISTRATION. RegisterMmove/RegisterPain/... become plain
//   functions/objects plus registerSaveFunction/registerSaveMmove at the file
//   tail (m_soldier.ts's idiom).
// - M_SetAnimation(self, move, instant). Handled by the local
//   `shambler_setanimation` below, because kexgame's M_SetAnimation ALSO
//   frees self.beam/self.beam2 on every animation switch and the shambler is
//   the one monster in this slice that owns a beam. The classic MonsterInfoT
//   has no active_move/next_move split, so `instant` has no counterpart --
//   every switch is immediate, and the shambler passes `true` at all of its
//   own call sites anyway.
// - `self.beam` / `self.beam2` do not exist on the classic EdictT. Carried in
//   a module-local WeakMap -- see `shamblerBeam`. REPORTED for g_local.ts.
// - `self.monsterinfo.setskin` does not exist on the classic MonsterInfoT.
//   shambler_setskin is an EMPTY function in the shipped C++ ("FIXME: create
//   pain skin?"), so nothing is lost: the assignment is dropped and the
//   no-op is kept and documented. REPORTED for g_local.ts.
// - M_ShouldReactToPain / M_CheckGib: the classic pain and die callback
//   signatures carry no `mod`, so the rerelease's MOD_CHAINFIST and
//   MOD_CRUSH branches cannot be evaluated. DOCUMENTED DEGRADATION at each
//   site. Note shambler_pain's OWN `mod.id != MOD_CHAINFIST && damage <= 30
//   && frandom() > 0.2` early-out is affected by this too -- see there.
// - M_CheckClearShot / PredictAim have no classic counterpart (they are
//   rogue "new AI" / rerelease content and g_monster.ts + g_ai.ts belong to
//   another unit). Both are ported locally, from kexgame/g_monster.ts and
//   kexgame/m_supertank.ts respectively.
// - monster_dead(self) -> the classic dead-monster idiom (m_tank.ts's
//   tank_dead): movetype TOSS, SVF_DEADMONSTER, nextthink = 0, relink. The
//   rerelease's monster_dead also installs monster_dead_think (corpse fly
//   sounds and a slow frame advance); the classic module has no counterpart
//   for that think and g_monster.ts is not owned by this unit, so a classic
//   shambler corpse is inert exactly like every vanilla 3.21 corpse.
//   DOCUMENTED DEGRADATION.
// - TE_LIGHTNING wire format. kexgame writes gi.WriteEntity(self) /
//   gi.WriteEntity(world); the classic GameImports has no WriteEntity, and
//   the classic client's CL_ParseLightning reads srcEnt (short), destEnt
//   (short), start, end -- so the two entity numbers are written with
//   gi.WriteShort in that same order. Identical bytes on the wire.
//
// ===========================================================================
// PRESERVED KEXGAME QUIRKS (bug-for-bug, not "fixed")
// ===========================================================================
// - ShamblerCastLightning's damage type is MOD_TESLA -- otherwise the xatrix
//   Tesla mine's mod id. The shambler's lightning reuses it verbatim; only
//   death-message/damage-type attribution is affected. Preserved exactly.
// - shambler_setskin is entirely commented out in the C++ ("FIXME: create
//   pain skin?"). Kept as a no-op function.
// - sham_smash10/ShamClaw's aim vector is { MELEE_DISTANCE, self.mins[0], -4 }
//   -- self.mins[0], NOT a hardcoded width. Preserved exactly.
// - FindShamblerOffset returns {0,0,48} both on success AND as its final
//   fallback after the 8-step loop finds nothing, rather than returning the
//   last (lowest) offset tried. A copy/paste artifact in the shipped C++;
//   preserved exactly.
// - self.beam2 is referenced only by shambler_die's cleanup and never
//   assigned anywhere in this monster. Dead defensive code, preserved.

import {
  AngleVectors,
  VectorAdd,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorSet,
  VectorSubtract,
  DotProduct,
  VectorLength,
  random,
  vec3,
  type Vec3,
} from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_DEADMONSTER,
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  MASK_SHOT,
  MASK_SOLID,
  MulticastT,
  RF_BEAM,
  TempEventT,
} from "../shared/q_shared";
import {
  AI_BRUTAL,
  AI_COMBAT_POINT,
  AI_DUCKED,
  AI_IGNORE_SHOTS,
  AI_LOST_SIGHT,
  AI_MANUAL_STEERING,
  AI_STAND_GROUND,
  AS_BLIND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FRAMETIME,
  g_edicts,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MOD_TESLA,
  MovetypeT,
  st,
  svc_temp_entity,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk } from "./g_ai";
import { walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource, G_Spawn } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { CanDamage } from "./g_combat";
import { fire_bullet, fire_hit } from "./g_weapon";
import * as FRAME from "./m_shambler_frames";

// mirrors g_monster.ts's/g_items.ts's own `cvarNum` (module-local there too).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// q_std.h's frandom/brandom/irandom, on top of shared/math.ts's random().
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

// SPAWNFLAG_SHAMBLER_PRECISE (kexgame/m_shambler.ts, m_shambler.cpp:23).
const SPAWNFLAG_SHAMBLER_PRECISE = 1;

/**
 * `st.health_multiplier` -- see the identical note in m_arachnid.ts.
 *
 * REPORTED (g_local.ts, not owned by this unit): the rerelease defaults it to
 * 1.0; the classic SpawnTempT (g_local.ts:461) declares it `= 0`, which would
 * spawn a 0-health monster. A 0 is read here as "key not present".
 */
function healthMultiplier(): number {
  return st.health_multiplier || 1;
}

// ---------------------------------------------------------------------------
// `self.beam` / `self.beam2` stand-in.
//
// The classic EdictT has no `beam`/`beam2` (the rerelease added them for
// exactly this kind of held beam entity). This unit does not own g_local.ts,
// so the shambler's single lightning beam is parked in a module-local
// WeakMap keyed by the edict. `beam2` is never assigned by this monster
// (see the header quirk list), so it needs no storage at all -- only
// shambler_die's dead defensive cleanup mentioned it.
//
// NOT save-persisted: after a load, a shambler that was mid-windup has no
// beam entity to free. The beam is a purely cosmetic RF_BEAM entity with a
// lifetime of a few frames inside one animation, so the worst case is a
// stray beam left in the world across exactly one save/load; the G_Spawn'd
// entity itself IS saved, and the next shambler_setanimation frees whatever
// the map is holding.
// REPORTED for g_local.ts: `beam: EdictT | null = null;` and
// `beam2: EdictT | null = null;` on EdictT.
// ---------------------------------------------------------------------------
const shamblerBeam: WeakMap<EdictT, EdictT> = new WeakMap();

function getBeam(self: EdictT): EdictT | null {
  return shamblerBeam.get(self) ?? null;
}

function freeBeam(self: EdictT): void {
  const b = shamblerBeam.get(self);
  if (b !== undefined) {
    G_FreeEdict(b);
    shamblerBeam.delete(self);
  }
}

/**
 * kexgame/g_monster.ts `M_SetAnimation`, narrowed to this monster.
 *
 * The beam free is the whole reason this exists: "[Paril-KEX] free the beams
 * if we switch animations." The classic module has no active_move/next_move
 * split, so the `instant` argument is dropped and the switch is immediate.
 */
function shambler_setanimation(self: EdictT, move: MmoveT): void {
  freeBeam(self);
  self.monsterinfo.currentmove = move;
}

// ---------------------------------------------------------------------------
// Locally-ported shared infrastructure -- see the TRANSLATION NOTES header.
// ---------------------------------------------------------------------------

/** kexgame/g_monster.ts `M_AllowSpawn`. */
function shamblerAllowSpawn(): boolean {
  const ai_allow_dm_spawn = gi.cvar("ai_allow_dm_spawn", "0", 0);
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(ai_allow_dm_spawn) === 0) return false;
  return true;
}

/**
 * kexgame/g_monster.ts `M_ShouldReactToPain`.
 *
 * DOCUMENTED DEGRADATION: the `mod.id == MOD_CHAINFIST ||` short-circuit is
 * dropped -- the classic pain signature carries no `mod`. See m_arachnid.ts's
 * identical note.
 */
function shamblerShouldReactToPain(self: EdictT): boolean {
  if ((self.monsterinfo.aiflags & (AI_DUCKED | AI_COMBAT_POINT)) !== 0) return false;
  return cvarNum(gameCvars.skill) < 3;
}

/** g_local.h `EDICT_NUM` recovery -- sv_world defaults an unset trace.ent to world, never null. */
function traceEdict(ent: { s: { number: number } } | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
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
  G_ProjectSource(self.s.origin, offset, f, r, start);

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
 * blocked, try the opposite one" eye-height flip). Ported locally: the
 * classic m_supertank.ts is the vanilla 3.21 one and has no PredictAim, and
 * this unit owns neither it nor g_ai.ts.
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

  const vec = vec3();
  VectorMA(target.s.origin, time - offset, target.velocity, vec);

  const dirN = vec3();
  VectorCopy(dir, dirN);
  VectorNormalize(dirN);
  const toVec = vec3();
  VectorSubtract(vec, start, toVec);
  VectorNormalize(toVec);

  // went backwards...
  if (DotProduct(dirN, toVec) < 0) {
    VectorCopy(target.s.origin, vec);
  } else if (gi.trace(start, null, null, vec, null, MASK_SOLID).fraction < 0.9) {
    // if the shot is going to impact a nearby wall from our prediction, just
    // fire it straight.
    VectorCopy(target.s.origin, vec);
  }

  if (eh) vec[2] += target.viewheight;

  if (aimdir !== null) {
    VectorSubtract(vec, start, aimdir);
    VectorNormalize(aimdir);
  }
  if (aimpoint !== null) VectorCopy(vec, aimpoint);
}

// ---------------------------------------------------------------------------
// MELEE RANGE -- the two families measure it differently, so BOTH constants
// are needed and each is used with its own family's metric.
//
// * g_weapon.ts's `fire_hit` (the CLASSIC one, which is the one that runs
//   here) measures ORIGIN-to-ORIGIN distance and compares it against aim[0].
//   Its matched constant is the classic MELEE_DISTANCE = 80 (g_local.ts:86),
//   which is what every vanilla 3.21 melee monster passes. That is what is
//   passed to fire_hit below.
// * The rerelease's own fire_hit measures BOX-to-BOX distance and its matched
//   constant is MELEE_DISTANCE = 50 (kexgame/g_local.ts:218, from
//   g_local.h:622). The monster's melee-SELECTION gates compare `range_to`
//   -- which is box-to-box -- against that same 50, so those gates keep the
//   rerelease value here under the name MELEE_DISTANCE_BOX.
//
// Pairing each constant with the metric it was tuned against reproduces the
// rerelease's reach far more closely than forcing one number onto both.
// DOCUMENTED DEVIATION: the two metrics are not identical, so the window
// between "monster decides to swing" and "the swing can connect" is slightly
// wider here than in the rerelease.
// ---------------------------------------------------------------------------
const MELEE_DISTANCE_BOX = 50;

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
let sound_idle = 0;
let sound_die = 0;
let sound_sight = 0;
let sound_windup = 0;
let sound_melee1 = 0;
let sound_melee2 = 0;
let sound_smack = 0;
let sound_boom = 0;

//
// misc (m_shambler.cpp:25-88)
//

function shambler_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

const lightning_left_hand: readonly Vec3[] = [
  vec3(44, 36, 25),
  vec3(10, 44, 57),
  vec3(-1, 40, 70),
  vec3(-10, 34, 75),
  vec3(7.4, 24, 89),
];

const lightning_right_hand: readonly Vec3[] = [
  vec3(28, -38, 25),
  vec3(31, -7, 70),
  vec3(20, 0, 80),
  vec3(16, 1.2, 81),
  vec3(27, -11, 83),
];

function shambler_lightning_update(self: EdictT): void {
  const lightning = getBeam(self);
  if (lightning === null) {
    throw new Error(`shambler_lightning_update: beam is null for ${self.classname ?? "?"}`);
  }

  if (self.s.frame >= FRAME.FRAME_magic01 + lightning_left_hand.length) {
    freeBeam(self);
    return;
  }

  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);
  const origin = vec3();
  G_ProjectSource(self.s.origin, lightning_left_hand[self.s.frame - FRAME.FRAME_magic01], f, r, origin);
  VectorCopy(origin, lightning.s.origin);
  const oldOrigin = vec3();
  G_ProjectSource(self.s.origin, lightning_right_hand[self.s.frame - FRAME.FRAME_magic01], f, r, oldOrigin);
  VectorCopy(oldOrigin, lightning.s.old_origin);
  gi.linkentity(lightning);
}

function shambler_windup(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_windup, 1, ATTN_NORM, 0);

  const lightning = G_Spawn();
  shamblerBeam.set(self, lightning);
  lightning.s.modelindex = gi.modelindex("models/proj/lightning/tris.md2");
  lightning.s.renderfx |= RF_BEAM;
  lightning.owner = self;
  shambler_lightning_update(self);
}

function shambler_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function shambler_maybe_idle(self: EdictT): void {
  if (frandom() > 0.8) gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

//
// stand (m_shambler.cpp:94-118)
//

const shambler_frames_stand: MframeT[] = Array.from({ length: 17 }, () => mkframe(ai_stand));
const shambler_move_stand = mkmove(FRAME.FRAME_stand01, FRAME.FRAME_stand17, shambler_frames_stand);

function shambler_stand(self: EdictT): void {
  shambler_setanimation(self, shambler_move_stand);
}

//
// walk (m_shambler.cpp:120-145)
//

const shambler_frames_walk: MframeT[] = [
  mkframe(ai_walk, 10), // FIXME: add footsteps?
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 12),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 13),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 7, shambler_maybe_idle),
  mkframe(ai_walk, 5),
];
const shambler_move_walk = mkmove(FRAME.FRAME_walk01, FRAME.FRAME_walk12, shambler_frames_walk);

function shambler_walk(self: EdictT): void {
  shambler_setanimation(self, shambler_move_walk);
}

//
// run (m_shambler.cpp:147-177)
//

const shambler_frames_run: MframeT[] = [
  mkframe(ai_run, 20), // FIXME: add footsteps?
  mkframe(ai_run, 24),
  mkframe(ai_run, 20),
  mkframe(ai_run, 20),
  mkframe(ai_run, 24),
  mkframe(ai_run, 20, shambler_maybe_idle),
];
const shambler_move_run = mkmove(FRAME.FRAME_run01, FRAME.FRAME_run06, shambler_frames_run);

function shambler_run(self: EdictT): void {
  if (self.enemy !== null && self.enemy.client !== null) self.monsterinfo.aiflags |= AI_BRUTAL;
  else self.monsterinfo.aiflags &= ~AI_BRUTAL;

  if ((self.monsterinfo.aiflags & AI_STAND_GROUND) !== 0) {
    shambler_setanimation(self, shambler_move_stand);
    return;
  }

  shambler_setanimation(self, shambler_move_run);
}

//
// pain (m_shambler.cpp:179-236)
//

// FIXME: needs halved explosion damage
const shambler_frames_pain: MframeT[] = Array.from({ length: 6 }, () => mkframe(ai_move));
const shambler_move_pain = mkmove(FRAME.FRAME_pain01, FRAME.FRAME_pain06, shambler_frames_pain, shambler_run);

function shambler_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (level.time < self.timestamp) return;

  self.timestamp = level.time + FRAMETIME;
  gi.sound(self, CHAN_AUTO, sound_pain, 1, ATTN_NORM, 0);

  // DOCUMENTED DEGRADATION: the C++ reads
  // `if (mod.id != MOD_CHAINFIST && damage <= 30 && frandom() > 0.2) return;`
  // The classic pain signature carries no `mod`, so the MOD_CHAINFIST
  // exemption (which makes a chainfist hit always able to stagger the
  // shambler regardless of how little damage it dealt) cannot be evaluated.
  // The remaining test is the C++'s own behavior for every OTHER damage
  // type, which is every damage type a classic-ruleset map can produce.
  if (damage <= 30 && frandom() > 0.2) return;

  // If hard or nightmare, don't go into pain while attacking
  if (cvarNum(gameCvars.skill) >= 2) {
    if (self.s.frame >= FRAME.FRAME_smash01 && self.s.frame <= FRAME.FRAME_smash12) return;
    if (self.s.frame >= FRAME.FRAME_swingl01 && self.s.frame <= FRAME.FRAME_swingl09) return;
    if (self.s.frame >= FRAME.FRAME_swingr01 && self.s.frame <= FRAME.FRAME_swingr09) return;
  }

  if (!shamblerShouldReactToPain(self)) return; // no pain anims in nightmare

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 2;
  shambler_setanimation(self, shambler_move_pain);
}

/**
 * m_shambler.cpp:229-236 `shambler_setskin` -- the ENTIRE body is commented
 * out in the shipped C++ ("FIXME: create pain skin?"), yet it is still wired
 * up as monsterinfo.setskin. Kept here as the same no-op it is there.
 *
 * The classic MonsterInfoT has no `setskin` field, so nothing assigns this;
 * it is retained (and referenced by the save registry below) so the
 * translation stays line-for-line with the source and a future
 * MonsterInfoT.setskin needs only the one assignment added back.
 * REPORTED for g_local.ts: `setskin: ((self: EdictT) => void) | null = null;`
 */
function shambler_setskin(_self: EdictT): void {
  // FIXME: create pain skin?
  // if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  // else self.s.skinnum &= ~1;
}

//
// magic / lightning attack (m_shambler.cpp:242-337)
//

function ShamblerSaveLoc(self: EdictT): void {
  if (self.enemy === null) throw new Error(`ShamblerSaveLoc: self.enemy is null for ${self.classname ?? "?"}`);

  VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
  self.pos1[2] += self.enemy.viewheight;
  self.monsterinfo.nextframe = FRAME.FRAME_magic09;

  gi.sound(self, CHAN_WEAPON, sound_boom, 1, ATTN_NORM, 0);
  shambler_lightning_update(self);
}

function FindShamblerOffset(self: EdictT): Vec3 {
  const offset = vec3(0, 0, 48);

  for (let i = 0; i < 8; i++) {
    if (M_CheckClearShot(self, offset)) return offset;

    offset[2] -= 4;
  }

  // Returns iteration 0's value again rather than the last offset tried --
  // a copy/paste artifact in the shipped C++, preserved (see file header).
  return vec3(0, 0, 48);
}

function ShamblerCastLightning(self: EdictT): void {
  if (self.enemy === null) return;

  const offset = FindShamblerOffset(self);

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const start = vec3();
  G_ProjectSource(self.s.origin, offset, forward, right, start);

  // calc direction to where we targted
  const dir = vec3();
  PredictAim(
    self,
    self.enemy,
    start,
    0,
    false,
    (self.spawnflags & SPAWNFLAG_SHAMBLER_PRECISE) !== 0 ? 0 : 0.1,
    dir,
    null,
  );

  const end = vec3();
  VectorMA(start, 8192, dir, end);
  const tr = gi.trace(start, null, null, end, self, MASK_SHOT | CONTENTS_SLIME | CONTENTS_LAVA);

  // kexgame writes gi.WriteEntity(self) / gi.WriteEntity(world); the classic
  // GameImports has no WriteEntity and the classic client's CL_ParseLightning
  // reads srcEnt (short) then destEnt (short), so the entity numbers go out
  // as shorts in that same order -- identical bytes on the wire.
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_LIGHTNING);
  gi.WriteShort(g_edicts.indexOf(self)); // source entity
  gi.WriteShort(0); // destination entity (world)
  gi.WritePosition(start);
  gi.WritePosition(tr.endpos);
  gi.multicast(start, MulticastT.MULTICAST_PVS);

  // MOD_TESLA is the xatrix Tesla mine's mod id; the shambler's lightning
  // reuses it verbatim (see file header).
  fire_bullet(self, start, dir, irandom(8, 12), 15, 0, 0, MOD_TESLA);
}

const shambler_frames_magic: MframeT[] = [
  mkframe(ai_charge, 0, shambler_windup),
  mkframe(ai_charge, 0, shambler_lightning_update),
  mkframe(ai_charge, 0, shambler_lightning_update),
  mkframe(ai_move, 0, shambler_lightning_update),
  mkframe(ai_move, 0, shambler_lightning_update),
  mkframe(ai_move, 0, ShamblerSaveLoc),
  mkframe(ai_move),
  mkframe(ai_charge),
  mkframe(ai_move, 0, ShamblerCastLightning),
  mkframe(ai_move, 0, ShamblerCastLightning),
  mkframe(ai_move, 0, ShamblerCastLightning),
  mkframe(ai_move),
];
const shambler_attack_magic = mkmove(
  FRAME.FRAME_magic01,
  FRAME.FRAME_magic12,
  shambler_frames_magic,
  shambler_run,
);

function shambler_attack(self: EdictT): void {
  shambler_setanimation(self, shambler_attack_magic);
}

//
// melee (m_shambler.cpp:339-473)
//

function shambler_melee1(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_melee1, 1, ATTN_NORM, 0);
}

function shambler_melee2(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_melee2, 1, ATTN_NORM, 0);
}

function sham_smash10(self: EdictT): void {
  if (self.enemy === null) return;

  ai_charge(self, 0);

  if (!CanDamage(self.enemy, self)) return;

  // self.mins[0], NOT a hardcoded width -- preserved exactly (file header).
  const aim = vec3(MELEE_DISTANCE, self.mins[0], -4);
  const hit = fire_hit(self, aim, irandom(110, 120), 120); // Slower attack

  if (hit) gi.sound(self, CHAN_WEAPON, sound_smack, 1, ATTN_NORM, 0);
}

function ShamClaw(self: EdictT): void {
  if (self.enemy === null) return;

  ai_charge(self, 10);

  if (!CanDamage(self.enemy, self)) return;

  const aim = vec3(MELEE_DISTANCE, self.mins[0], -4);
  const hit = fire_hit(self, aim, irandom(70, 80), 80); // Slower attack

  if (hit) gi.sound(self, CHAN_WEAPON, sound_smack, 1, ATTN_NORM, 0);
}

const shambler_frames_smash: MframeT[] = [
  mkframe(ai_charge, 2, shambler_melee1),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, sham_smash10),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 4),
];
const shambler_attack_smash = mkmove(
  FRAME.FRAME_smash01,
  FRAME.FRAME_smash12,
  shambler_frames_smash,
  shambler_run,
);

const shambler_frames_swingl: MframeT[] = [
  mkframe(ai_charge, 5, shambler_melee1),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 7),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 7),
  mkframe(ai_charge, 9),
  mkframe(ai_charge, 5, ShamClaw),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 8, sham_swingl9),
];
const shambler_attack_swingl = mkmove(
  FRAME.FRAME_swingl01,
  FRAME.FRAME_swingl09,
  shambler_frames_swingl,
  shambler_run,
);

const shambler_frames_swingr: MframeT[] = [
  mkframe(ai_charge, 1, shambler_melee2),
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 14),
  mkframe(ai_charge, 7),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 6, ShamClaw),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 8, sham_swingr9),
];
const shambler_attack_swingr = mkmove(
  FRAME.FRAME_swingr01,
  FRAME.FRAME_swingr09,
  shambler_frames_swingr,
  shambler_run,
);

// `sham_swingl9`/`sham_swingr9` are hoisted `function` declarations
// referenced as thinkfuncs by the two frame tables immediately above, whose
// own textual position precedes these definitions -- matching m_shambler.cpp's
// own forward declarations at m_shambler.cpp:353-354. JS function
// declarations are fully hoisted, so this needs no other accommodation.
function sham_swingl9(self: EdictT): void {
  ai_charge(self, 8);

  if (brandom() && self.enemy !== null && range_to(self, self.enemy) < MELEE_DISTANCE_BOX) {
    shambler_setanimation(self, shambler_attack_swingr);
  }
}

function sham_swingr9(self: EdictT): void {
  ai_charge(self, 1);
  ai_charge(self, 10);

  if (brandom() && self.enemy !== null && range_to(self, self.enemy) < MELEE_DISTANCE_BOX) {
    shambler_setanimation(self, shambler_attack_swingl);
  }
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

function shambler_melee(self: EdictT): void {
  const chance = frandom();
  if (chance > 0.6 || self.health === 600) shambler_setanimation(self, shambler_attack_smash);
  else if (chance > 0.3) shambler_setanimation(self, shambler_attack_swingl);
  else shambler_setanimation(self, shambler_attack_swingr);
}

//
// death (m_shambler.cpp:475-545)
//

/**
 * m_shambler.cpp's `shambler_dead` -> `monster_dead(self)`.
 *
 * DOCUMENTED DEGRADATION: the rerelease's monster_dead also installs
 * monster_dead_think (corpse fly sounds via AI_STINKY, and a slow advance to
 * the last death frame) and resets monsterinfo.damage_blood /
 * fly_sound_debounce_time. The classic module has no monster_dead_think and
 * g_monster.ts belongs to another unit, so this uses the vanilla 3.21
 * dead-monster idiom (m_tank.ts's tank_dead) instead: a classic shambler
 * corpse is inert exactly like every other classic corpse.
 */
function shambler_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -0);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function shambler_shrink(self: EdictT): void {
  self.maxs[2] = 0;
  self.svflags |= SVF_DEADMONSTER;
  gi.linkentity(self);
}

const shambler_frames_death: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, shambler_shrink),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0), // FIXME: thud?
];
const shambler_move_death = mkmove(
  FRAME.FRAME_death01,
  FRAME.FRAME_death11,
  shambler_frames_death,
  shambler_dead,
);

function shambler_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  freeBeam(self);
  // self.beam2 is never assigned anywhere in this monster (see file header);
  // the C++'s matching cleanup for it is dead defensive code and has no
  // storage to clear here.

  // check for gib.
  //
  // DOCUMENTED DEGRADATION: the rerelease's M_CheckGib also gibs an already
  // dead monster on MOD_CRUSH; the classic die signature carries no `mod`.
  // See m_arachnid.ts's identical note.
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    // FIXME: better gibs for shambler, shambler head
    ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowGib(self, "models/objects/gibs/chest/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  shambler_setanimation(self, shambler_move_death);
}

/*QUAKED monster_shambler (1 .5 0) (-32 -32 -24) (32 32 64) Ambush Trigger_Spawn Sight
 */
export function SP_monster_shambler(self: EdictT): void {
  if (!shamblerAllowSpawn()) {
    G_FreeEdict(self);
    return;
  }

  self.s.modelindex = gi.modelindex("models/monsters/shambler/tris.md2");
  VectorSet(self.mins, -32, -32, -24);
  VectorSet(self.maxs, 32, 32, 64);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  gi.modelindex("models/proj/lightning/tris.md2");
  sound_pain = gi.soundindex("shambler/shurt2.wav");
  sound_idle = gi.soundindex("shambler/sidle.wav");
  sound_die = gi.soundindex("shambler/sdeath.wav");
  sound_windup = gi.soundindex("shambler/sattck1.wav");
  sound_melee1 = gi.soundindex("shambler/melee1.wav");
  sound_melee2 = gi.soundindex("shambler/melee2.wav");
  sound_sight = gi.soundindex("shambler/ssight.wav");
  sound_smack = gi.soundindex("shambler/smack.wav");
  sound_boom = gi.soundindex("shambler/sboom.wav");

  self.health = Math.trunc(600 * healthMultiplier());
  self.gib_health = -60;

  self.mass = 500;

  // fresh edict slot: drop any beam a recycled edict object left behind.
  shamblerBeam.delete(self);

  self.pain = shambler_pain;
  self.die = shambler_die;
  self.monsterinfo.stand = shambler_stand;
  self.monsterinfo.walk = shambler_walk;
  self.monsterinfo.run = shambler_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = shambler_attack;
  self.monsterinfo.melee = shambler_melee;
  self.monsterinfo.sight = shambler_sight;
  self.monsterinfo.idle = shambler_idle;
  self.monsterinfo.blocked = null;
  // self.monsterinfo.setskin = shambler_setskin;
  // ^ the classic MonsterInfoT has no `setskin` field. shambler_setskin's
  //   whole body is commented out in the shipped C++ anyway, so this
  //   assignment is a pure no-op there too -- nothing is lost. See
  //   shambler_setskin's own doc comment.

  gi.linkentity(self);

  if ((self.spawnflags & SPAWNFLAG_SHAMBLER_PRECISE) !== 0) self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;

  shambler_setanimation(self, shambler_move_stand);
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- see m_soldier.ts's own tail.
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_shambler:shambler_pain", shambler_pain);
registerSaveFunction("m_shambler:shambler_die", shambler_die);
registerSaveFunction("m_shambler:shambler_dead", shambler_dead);
registerSaveFunction("m_shambler:shambler_shrink", shambler_shrink);
registerSaveFunction("m_shambler:shambler_stand", shambler_stand);
registerSaveFunction("m_shambler:shambler_walk", shambler_walk);
registerSaveFunction("m_shambler:shambler_run", shambler_run);
registerSaveFunction("m_shambler:shambler_attack", shambler_attack);
registerSaveFunction("m_shambler:shambler_melee", shambler_melee);
registerSaveFunction("m_shambler:shambler_sight", shambler_sight);
registerSaveFunction("m_shambler:shambler_idle", shambler_idle);
registerSaveFunction("m_shambler:shambler_maybe_idle", shambler_maybe_idle);
registerSaveFunction("m_shambler:shambler_setskin", shambler_setskin);
registerSaveFunction("m_shambler:shambler_windup", shambler_windup);
registerSaveFunction("m_shambler:shambler_lightning_update", shambler_lightning_update);
registerSaveFunction("m_shambler:ShamblerSaveLoc", ShamblerSaveLoc);
registerSaveFunction("m_shambler:ShamblerCastLightning", ShamblerCastLightning);
registerSaveFunction("m_shambler:shambler_melee1", shambler_melee1);
registerSaveFunction("m_shambler:shambler_melee2", shambler_melee2);
registerSaveFunction("m_shambler:sham_smash10", sham_smash10);
registerSaveFunction("m_shambler:ShamClaw", ShamClaw);
registerSaveFunction("m_shambler:sham_swingl9", sham_swingl9);
registerSaveFunction("m_shambler:sham_swingr9", sham_swingr9);
registerSaveMmove("m_shambler:shambler_move_stand", shambler_move_stand);
registerSaveMmove("m_shambler:shambler_move_walk", shambler_move_walk);
registerSaveMmove("m_shambler:shambler_move_run", shambler_move_run);
registerSaveMmove("m_shambler:shambler_move_pain", shambler_move_pain);
registerSaveMmove("m_shambler:shambler_attack_magic", shambler_attack_magic);
registerSaveMmove("m_shambler:shambler_attack_smash", shambler_attack_smash);
registerSaveMmove("m_shambler:shambler_attack_swingl", shambler_attack_swingl);
registerSaveMmove("m_shambler:shambler_attack_swingr", shambler_attack_swingr);
registerSaveMmove("m_shambler:shambler_move_death", shambler_move_death);
