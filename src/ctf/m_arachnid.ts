/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.

Ported from rerelease/m_arachnid.cpp via src/kexgame/m_arachnid.ts.
*/
/*
==============================================================================

ARACHNID

==============================================================================
*/
//
// RERELEASE CONTENT PORT -- this monster exists ONLY in the 2023 re-release;
// there is no 3.21 baseq2/xatrix/rogue precedent anywhere in this tree. The
// translation source is src/kexgame/m_arachnid.ts (itself a faithful port of
// rerelease/m_arachnid.cpp), retargeted at the CLASSIC module's type
// machinery. Every kexgame quirk documented in that file's own header is
// preserved here and re-noted at the site it applies to.
//
// ===========================================================================
// TRANSLATION NOTES (kexgame -> classic)
// ===========================================================================
// - TIME. kexgame's level.time is a millisecond GTime; the classic module's
//   is a float in SECONDS. `Gtime_add(level.time, Gtime_from_sec(3))` becomes
//   `level.time + 3`, `Gtime_from_ms(1000)` becomes `1.0`.
// - CALLBACK REGISTRATION. kexgame wraps every callback/mmove in
//   RegisterThink/RegisterMmove/...; the classic module uses plain
//   functions/objects plus registerSaveFunction/registerSaveMmove calls at
//   the file tail (see m_soldier.ts's own tail for the idiom).
// - M_SetAnimation(self, move, instant) -> `self.monsterinfo.currentmove =
//   move`. The classic MonsterInfoT has no active_move/next_move split, so
//   the `instant` argument has no classic counterpart: every switch is
//   immediate. The arachnid passes `true` (instant) at every one of its call
//   sites in the C++ anyway, so no behavior is lost.
// - M_ProjectFlashSource(self, offset, f, r) -> G_ProjectSource(self.s.origin,
//   offset, f, r, out). kexgame's version pre-scales `offset` by
//   `self.s.scale`; SP_monster_arachnid never sets s.scale (it leaves it 0,
//   the "unscaled" sentinel), so the scaled and unscaled forms are identical
//   for this monster and the classic G_ProjectSource is used directly.
// - M_ShouldReactToPain(self, mod) -> local `arachnidShouldReactToPain(self)`.
//   The classic `pain` callback signature carries no `mod`, so the
//   rerelease's `mod.id == MOD_CHAINFIST ||` short-circuit (which lets a
//   chainfist hit force a pain animation even on nightmare) cannot be
//   evaluated and is dropped. DOCUMENTED DEGRADATION -- see the helper.
// - M_CheckGib(self, mod) -> `self.health <= self.gib_health`, the classic
//   die-callback idiom (m_tank.ts's tank_die). The rerelease's extra
//   "already dead + MOD_CRUSH => gib" branch needs the `mod` the classic die
//   signature does not carry. DOCUMENTED DEGRADATION -- see arachnid_die.
// - M_AllowSpawn -> `arachnidAllowSpawn`, ported locally (kexgame
//   g_monster.ts:M_AllowSpawn) rather than added to the W1-owned
//   g_monster.ts.
// - ThrowGibs(self, damage, [...]) -> the classic per-gib ThrowGib/ThrowHead
//   loop, with the same models and counts.
// - `range_to` (kexgame g_ai.ts, box-to-box distance) has no classic
//   counterpart -- g_ai.ts's `range()` returns a RANGE_* bucket, not a
//   distance. Ported locally as `range_to`/`distance_between_boxes` from
//   src/kexgame/q_vec3.ts.
// - MUZZLE FLASH IDS. The arachnid's rail flashes are MZ2_ARACHNID_RAIL1..
//   RAIL_UP2 = 228..231, which live only in the re-release's 290-entry
//   monster_flash_offset table. The classic table (src/game/m_flash.ts) has
//   212 entries (0..211) and is owned by another unit, so the four offsets
//   are carried locally here (values transcribed verbatim from
//   src/kexgame/m_flash.ts:307-310). See the DEGRADATION note on
//   `arachnidFlashOffset` for what this costs on the client side.
// - `self.monsterinfo.melee_debounce_time` does not exist on the classic
//   MonsterInfoT. Carried in a module-local WeakMap -- see
//   `meleeDebounceTime`. REPORTED for a future g_local.ts addition.
//
// ===========================================================================
// PRESERVED KEXGAME QUIRKS (bug-for-bug, not "fixed")
// ===========================================================================
// - SP_monster_arachnid assigns sound_step = "insane/insane11.wav" (a
//   misc_insane fist-thump) as this spider's footstep. Preserved exactly.
// - sound_melee_hit ("gladiator/melee2.wav") is precached and stored but
//   never played by any gi.sound call: arachnid_melee_hit is silent on a
//   successful fire_hit. A genuine dead assignment in the shipped source.
// - arachnid_attack's melee gate uses `<` while its "enemy well above" gate
//   uses `>` -- both strict, no `<=`/`>=`. Preserved exactly.
// - arachnid_rail's frame->flash-id switch has FRAME_rails4 as BOTH an
//   explicit case AND the default fallthrough target, so ANY frame that is
//   not exactly rails8/rails_up7/rails_up11 resolves to MZ2_ARACHNID_RAIL1.
//   Ported as an if/else-if chain ending in a bare `else`.

import {
  AngleVectors,
  VectorCopy,
  VectorNormalize,
  VectorSet,
  VectorSubtract,
  random,
  vec3,
  type Vec3,
} from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, CHAN_BODY, CHAN_VOICE, CHAN_WEAPON } from "../shared/q_shared";
import {
  AI_COMBAT_POINT,
  AI_DUCKED,
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MELEE_DISTANCE,
  st,
  MframeT,
  MmoveT,
  MovetypeT,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk } from "./g_ai";
import { monster_fire_railgun, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { fire_hit } from "./g_weapon";
import * as FRAME from "./m_arachnid_frames";

// mirrors g_monster.ts's/g_items.ts's own `cvarNum` (module-local there too).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

/**
 * `st.health_multiplier` -- the rerelease spawn key that scales a monster's
 * authored health.
 *
 * REPORTED (g_local.ts, not owned by this unit): the rerelease's SpawnTempT
 * initializes `health_multiplier` to 1.0 (kexgame/g_spawn.ts:707, from
 * g_local.h:1306 `float health_multiplier = 1.0f`), but the classic
 * SpawnTempT (g_local.ts:461) declares it `= 0`. Multiplying by the classic
 * default would spawn this monster with 0 health. Until the default is fixed
 * in g_local.ts, a 0 here is read as "key not present" and treated as 1 --
 * which is what a map that does not set the key means. A map that really does
 * write `health_multiplier 0` would have spawned a 0-health monster in the
 * rerelease too; that degenerate case is not reachable through this helper,
 * and is the one deviation it introduces.
 */
function healthMultiplier(): number {
  return st.health_multiplier || 1;
}

// ---------------------------------------------------------------------------
// Locally-ported shared infrastructure -- see the TRANSLATION NOTES header.
// Each of these is a per-file duplicate rather than an edit to a module this
// unit does not own (g_monster.ts / g_ai.ts / m_move.ts / m_flash.ts).
// ---------------------------------------------------------------------------

/** kexgame/g_monster.ts `M_AllowSpawn`. */
function arachnidAllowSpawn(): boolean {
  const ai_allow_dm_spawn = gi.cvar("ai_allow_dm_spawn", "0", 0);
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(ai_allow_dm_spawn) === 0) return false;
  return true;
}

/**
 * kexgame/g_monster.ts `M_ShouldReactToPain`.
 *
 * DOCUMENTED DEGRADATION: the rerelease reads `mod.id == MOD_CHAINFIST ||
 * skill < 3`, so a chainfist hit forces a pain animation even on nightmare.
 * The classic `pain` callback signature is (self, other, kick, damage) with
 * no `mod`, so that clause cannot be evaluated here and the nightmare check
 * stands alone -- exactly what every vanilla 3.21 monster does. The chainfist
 * is a rogue weapon that classic maps never hand the player, so the practical
 * difference is nil, but it IS a deviation.
 */
function arachnidShouldReactToPain(self: EdictT): boolean {
  if ((self.monsterinfo.aiflags & (AI_DUCKED | AI_COMBAT_POINT)) !== 0) return false;
  return cvarNum(gameCvars.skill) < 3;
}

/** kexgame/q_vec3.ts `distance_between_boxes`. */
function distance_between_boxes(absminsa: Vec3, absmaxsa: Vec3, absminsb: Vec3, absmaxsb: Vec3): number {
  let len = 0;
  for (let i = 0; i < 3; i++) {
    if (absmaxsa[i] < absminsb[i]) {
      const d = absmaxsa[i] - absminsb[i];
      len += d * d;
    } else if (absminsa[i] > absmaxsb[i]) {
      const d = absminsa[i] - absmaxsb[i];
      len += d * d;
    }
  }
  return Math.sqrt(len);
}

/** kexgame/g_ai.ts `range_to`. */
function range_to(self: EdictT, other: EdictT): number {
  return distance_between_boxes(self.absmin, self.absmax, other.absmin, other.absmax);
}

// ---------------------------------------------------------------------------
// monster_flash_offset entries 228..231 (kexgame/m_flash.ts:307-310).
//
// DOCUMENTED DEGRADATION (protocol 34): the classic ruleset's flash table
// (src/game/m_flash.ts) stops at index 211, and that file belongs to another
// unit, so the four arachnid offsets are carried here for the SERVER side --
// the shot really does originate from the right point on the model. The
// flash id is still written verbatim into svc_muzzleflash2, and the CLASSIC
// client resolves it through its own 212-entry table; cl_fx.ts's
// CL_ParseMuzzleFlash2 already documents that an out-of-range flash_number
// falls back to a zero offset there, so under the classic ruleset the rail
// muzzle FLASH/dynamic light draws at the arachnid's origin instead of at the
// gun. Sound and particle behavior driven off flash_number are unaffected.
// ---------------------------------------------------------------------------

const MZ2_ARACHNID_RAIL1 = 228;
const MZ2_ARACHNID_RAIL2 = 229;
const MZ2_ARACHNID_RAIL_UP1 = 230;
const MZ2_ARACHNID_RAIL_UP2 = 231;

function arachnidFlashOffset(id: number): Vec3 {
  if (id === MZ2_ARACHNID_RAIL2) return vec3(64.0, -22.0, 24.0);
  if (id === MZ2_ARACHNID_RAIL_UP1) return vec3(37.0, 13.0, 72.0);
  if (id === MZ2_ARACHNID_RAIL_UP2) return vec3(58.0, -25.0, 72.0);
  return vec3(58.0, 20.0, 17.2); // MZ2_ARACHNID_RAIL1
}

// ---------------------------------------------------------------------------
// `self.monsterinfo.melee_debounce_time` stand-in.
//
// The classic MonsterInfoT has no melee_debounce_time (the rerelease added
// it). This unit does not own g_local.ts, so the value is parked in a
// module-local WeakMap keyed by the edict. Reset in SP_monster_arachnid so a
// recycled edict slot cannot inherit a stale debounce. NOT save-persisted:
// after a load, an arachnid's melee is simply available again (the field is
// only ever set to level.time + 1 second).
// REPORTED for g_local.ts: `melee_debounce_time = 0;` on MonsterInfoT.
// ---------------------------------------------------------------------------
const meleeDebounceTime: WeakMap<EdictT, number> = new WeakMap();

function getMeleeDebounceTime(self: EdictT): number {
  return meleeDebounceTime.get(self) ?? 0;
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
let sound_death = 0;
let sound_sight = 0;
let sound_step = 0;
let sound_charge = 0;
let sound_melee = 0;
// Assigned in SP_monster_arachnid, never read by any gi.sound call -- a dead
// assignment in the shipped rerelease source, preserved exactly (see header).
let sound_melee_hit = 0;
void sound_melee_hit;

//
// sight / stand (m_arachnid.cpp:19-48)
//

function arachnid_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

const arachnid_frames_stand: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_stand));
const arachnid_move_stand = mkmove(FRAME.FRAME_idle1, FRAME.FRAME_idle13, arachnid_frames_stand);

function arachnid_stand(self: EdictT): void {
  self.monsterinfo.currentmove = arachnid_move_stand;
}

//
// walk / run (m_arachnid.cpp:50-107)
//

function arachnid_footstep(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step, 0.5, ATTN_IDLE, 0);
}

const arachnid_frames_walk: MframeT[] = [
  mkframe(ai_walk, 8, arachnid_footstep),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8, arachnid_footstep),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
];
const arachnid_move_walk = mkmove(FRAME.FRAME_walk1, FRAME.FRAME_walk10, arachnid_frames_walk);

function arachnid_walk(self: EdictT): void {
  self.monsterinfo.currentmove = arachnid_move_walk;
}

const arachnid_frames_run: MframeT[] = [
  mkframe(ai_run, 8, arachnid_footstep),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8, arachnid_footstep),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
];
const arachnid_move_run = mkmove(FRAME.FRAME_walk1, FRAME.FRAME_walk10, arachnid_frames_run);

function arachnid_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & AI_STAND_GROUND) !== 0) {
    self.monsterinfo.currentmove = arachnid_move_stand;
    return;
  }

  self.monsterinfo.currentmove = arachnid_move_run;
}

//
// pain (m_arachnid.cpp:109-149)
//

const arachnid_frames_pain1: MframeT[] = Array.from({ length: 5 }, () => mkframe(ai_move));
const arachnid_move_pain1 = mkmove(FRAME.FRAME_pain11, FRAME.FRAME_pain15, arachnid_frames_pain1, arachnid_run);

const arachnid_frames_pain2: MframeT[] = Array.from({ length: 6 }, () => mkframe(ai_move));
const arachnid_move_pain2 = mkmove(FRAME.FRAME_pain21, FRAME.FRAME_pain26, arachnid_frames_pain2, arachnid_run);

function arachnid_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (!arachnidShouldReactToPain(self)) return; // no pain anims in nightmare

  const r = random();

  if (r < 0.5) self.monsterinfo.currentmove = arachnid_move_pain1;
  else self.monsterinfo.currentmove = arachnid_move_pain2;
}

//
// rail attacks (m_arachnid.cpp:151-230)
//

function arachnid_charge_rail(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  gi.sound(self, CHAN_WEAPON, sound_charge, 1, ATTN_NORM, 0);
  VectorCopy(self.enemy.s.origin, self.pos1);
  self.pos1[2] += self.enemy.viewheight;
}

function arachnid_rail(self: EdictT): void {
  let id: number;

  // FRAME_rails4 is both an explicit case and the implicit default
  // fallthrough target in the C++ switch, so any frame that is not
  // rails8/rails_up7/rails_up11 resolves to RAIL1 (see file header).
  if (self.s.frame === FRAME.FRAME_rails8) id = MZ2_ARACHNID_RAIL2;
  else if (self.s.frame === FRAME.FRAME_rails_up7) id = MZ2_ARACHNID_RAIL_UP1;
  else if (self.s.frame === FRAME.FRAME_rails_up11) id = MZ2_ARACHNID_RAIL_UP2;
  else id = MZ2_ARACHNID_RAIL1;

  const forward = vec3();
  const right = vec3();
  const start = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, arachnidFlashOffset(id), forward, right, start);

  // calc direction to where we targeted
  const dir = vec3();
  VectorSubtract(self.pos1, start, dir);
  VectorNormalize(dir);

  monster_fire_railgun(self, start, dir, 35, 100, id);
}

const arachnid_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 0, arachnid_charge_rail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_rail),
  mkframe(ai_charge, 0, arachnid_charge_rail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_rail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
const arachnid_attack1 = mkmove(FRAME.FRAME_rails1, FRAME.FRAME_rails11, arachnid_frames_attack1, arachnid_run);

const arachnid_frames_attack_up1: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_charge_rail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_rail),
  mkframe(ai_charge, 0, arachnid_charge_rail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_rail),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
const arachnid_attack_up1 = mkmove(
  FRAME.FRAME_rails_up1,
  FRAME.FRAME_rails_up16,
  arachnid_frames_attack_up1,
  arachnid_run,
);

//
// melee (m_arachnid.cpp:232-272)
//

function arachnid_melee_charge(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_melee, 1, ATTN_NORM, 0);
}

function arachnid_melee_hit(self: EdictT): void {
  // No gi.sound on a landed hit -- sound_melee_hit is never played (header).
  if (!fire_hit(self, vec3(MELEE_DISTANCE, 0, 0), 15, 50)) {
    meleeDebounceTime.set(self, level.time + 1.0);
  }
}

const arachnid_frames_melee: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_melee_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_melee_hit),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_melee_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, arachnid_melee_hit),
  mkframe(ai_charge),
];
const arachnid_melee = mkmove(FRAME.FRAME_melee_atk1, FRAME.FRAME_melee_atk12, arachnid_frames_melee, arachnid_run);

function arachnid_attack(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  // both gates are strict inequalities in the C++ (`<` and `>`), preserved.
  if (getMeleeDebounceTime(self) < level.time && range_to(self, self.enemy) < MELEE_DISTANCE_BOX) {
    self.monsterinfo.currentmove = arachnid_melee;
  } else if (self.enemy.s.origin[2] - self.s.origin[2] > 150) {
    self.monsterinfo.currentmove = arachnid_attack_up1;
  } else {
    self.monsterinfo.currentmove = arachnid_attack1;
  }
}

//
// death (m_arachnid.cpp:274-336)
//

function arachnid_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const arachnid_frames_death1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, -1.23),
  mkframe(ai_move, -1.23),
  mkframe(ai_move, -1.23),
  mkframe(ai_move, -1.23),
  mkframe(ai_move, -1.64),
  mkframe(ai_move, -1.64),
  mkframe(ai_move, -2.45),
  mkframe(ai_move, -8.63),
  mkframe(ai_move, -4.0),
  mkframe(ai_move, -4.5),
  mkframe(ai_move, -6.8),
  mkframe(ai_move, -8.0),
  mkframe(ai_move, -5.4),
  mkframe(ai_move, -3.4),
  mkframe(ai_move, -1.9),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
const arachnid_move_death = mkmove(FRAME.FRAME_death1, FRAME.FRAME_death20, arachnid_frames_death1, arachnid_dead);

function arachnid_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // check for gib.
  //
  // DOCUMENTED DEGRADATION: the rerelease's M_CheckGib also gibs an ALREADY
  // DEAD monster when `mod.id == MOD_CRUSH`. The classic `die` callback
  // signature is (self, inflictor, attacker, damage, point) with no `mod`, so
  // only the health test survives -- which is exactly what every vanilla 3.21
  // monster does.
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  self.monsterinfo.currentmove = arachnid_move_death;
}

/*QUAKED monster_arachnid (1 .5 0) (-48 -48 -20) (48 48 48) Ambush Trigger_Spawn Sight
 */
export function SP_monster_arachnid(self: EdictT): void {
  if (!arachnidAllowSpawn()) {
    G_FreeEdict(self);
    return;
  }

  sound_step = gi.soundindex("insane/insane11.wav");
  sound_charge = gi.soundindex("gladiator/railgun.wav");
  sound_melee = gi.soundindex("gladiator/melee3.wav");
  sound_melee_hit = gi.soundindex("gladiator/melee2.wav");
  sound_pain = gi.soundindex("arachnid/pain.wav");
  sound_death = gi.soundindex("arachnid/death.wav");
  sound_sight = gi.soundindex("arachnid/sight.wav");

  self.s.modelindex = gi.modelindex("models/monsters/arachnid/tris.md2");
  VectorSet(self.mins, -48, -48, -20);
  VectorSet(self.maxs, 48, 48, 48);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  // st.health_multiplier -- see healthMultiplier()'s note on the classic
  // SpawnTempT's 0 default.
  self.health = Math.trunc(1000 * healthMultiplier());
  self.gib_health = -200;

  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  self.mass = 450;

  // fresh edict slot: clear any melee debounce a recycled edict object left
  // behind (see the meleeDebounceTime note above).
  meleeDebounceTime.delete(self);

  self.pain = arachnid_pain;
  self.die = arachnid_die;
  self.monsterinfo.stand = arachnid_stand;
  self.monsterinfo.walk = arachnid_walk;
  self.monsterinfo.run = arachnid_run;
  self.monsterinfo.attack = arachnid_attack;
  self.monsterinfo.sight = arachnid_sight;

  gi.linkentity(self);

  self.monsterinfo.currentmove = arachnid_move_stand;

  walkmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- see m_soldier.ts's own tail.
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_arachnid:arachnid_pain", arachnid_pain);
registerSaveFunction("m_arachnid:arachnid_die", arachnid_die);
registerSaveFunction("m_arachnid:arachnid_dead", arachnid_dead);
registerSaveFunction("m_arachnid:arachnid_stand", arachnid_stand);
registerSaveFunction("m_arachnid:arachnid_walk", arachnid_walk);
registerSaveFunction("m_arachnid:arachnid_run", arachnid_run);
registerSaveFunction("m_arachnid:arachnid_attack", arachnid_attack);
registerSaveFunction("m_arachnid:arachnid_sight", arachnid_sight);
registerSaveFunction("m_arachnid:arachnid_footstep", arachnid_footstep);
registerSaveFunction("m_arachnid:arachnid_charge_rail", arachnid_charge_rail);
registerSaveFunction("m_arachnid:arachnid_rail", arachnid_rail);
registerSaveFunction("m_arachnid:arachnid_melee_charge", arachnid_melee_charge);
registerSaveFunction("m_arachnid:arachnid_melee_hit", arachnid_melee_hit);
registerSaveMmove("m_arachnid:arachnid_move_stand", arachnid_move_stand);
registerSaveMmove("m_arachnid:arachnid_move_walk", arachnid_move_walk);
registerSaveMmove("m_arachnid:arachnid_move_run", arachnid_move_run);
registerSaveMmove("m_arachnid:arachnid_move_pain1", arachnid_move_pain1);
registerSaveMmove("m_arachnid:arachnid_move_pain2", arachnid_move_pain2);
registerSaveMmove("m_arachnid:arachnid_attack1", arachnid_attack1);
registerSaveMmove("m_arachnid:arachnid_attack_up1", arachnid_attack_up1);
registerSaveMmove("m_arachnid:arachnid_melee", arachnid_melee);
registerSaveMmove("m_arachnid:arachnid_move_death", arachnid_move_death);
