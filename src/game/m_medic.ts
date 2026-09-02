/*
Copyright (C) 1997-2001 Id Software, Inc.
*/
/*
==============================================================================

MEDIC

rogue/m_medic.c vs baseq2/m_medic.c: the pack's largest single-monster diff
-- a full "medic commander" overhaul. Highlights:

- Healing targets are no longer limited to already-dead monsters that the
  medic "owns" via a plain `owner` pointer: monsterinfo.healer/badMedic1/
  badMedic2/medicTries (g_local.ts) replace that bookkeeping, with
  medic_FindDeadMonster gaining a healer-conflict check, a player-classname
  exclusion, a minimum-distance check (realrange, g_newai.ts), and a
  MEDIC_TRY_TIME timeout (self.timestamp) enforced by medic_checkattack.
  cleanupHeal/abortHeal (this file) replace the old inline owner-clearing
  logic; g_combat.ts's cleanupHealTarget is the sibling cleanup hook called
  from T_Damage/Killed when a heal target dies or is gibbed out from under
  its medic -- this file never calls it directly.
- A second entity, monster_medic_commander (mass 600/health 600, dispatched
  through the same SP_monster_medic entry point by classname check -- see
  g_spawn.ts's spawn table), gets its own sound set, a blaster2-family
  attack (monster_fire_blaster2), commander-only pain/die/sight/search/idle
  sound branches keyed off `self.mass`, and a new medic_move_callReinforcements
  attack that spawns 1/3/5 reinforcements (medic_start_spawn/
  medic_determine_spawn/medic_spawngrows/medic_finish_spawn, using
  g_spawn.ts's FindSpawnPoint/CheckSpawnPoint/CheckGroundSpawnPoint/
  CreateGroundMonster/SpawnGrow_Spawn and g_newai.ts's PickCoopTarget).
- Dodge/duck/jump AI is rewired onto the shared g_newai.ts helpers
  (M_MonsterDodge, monster_duck_down/hold/up) and monster_done_dodge from
  g_monster.ts, same pattern as m_gunner.ts/m_infantry.ts. The original
  medic_dodge function is left as dead, fully commented-out C source in
  rogue/m_medic.c -- dropped here per PORTING.md's "#if 0 blocks are
  dropped silently" rule.
- medic_cable_attack (the resurrection beam) gains an EF_GIB/client/health
  abort check, a MEDIC_MIN_DISTANCE abort, switches its blocking trace from
  MASK_SHOT to MASK_SOLID with a medicTries retry-once-then-give-up path
  when the beam is blocked by the world, and its FRAME_attack50 revival
  branch now traces the target's resurrected bounding box for room before
  calling ED_CallSpawn, hands the revived monster a new enemy via
  FoundTarget/FindTarget instead of the base game's immediate self-heal
  loop, and marks the revived monster AI_IGNORE_SHOTS|AI_DO_NOT_COUNT.

Deviations from bug-for-bug fidelity (both present in rogue/m_medic.c,
documented here rather than "fixed" silently):
- medic_hook_retract (rogue/m_medic.c:965-970): both the `self.mass == 400`
  and the commander branch read `sound_hook_retract` -- the C source never
  actually plays `commander_sound_hook_retract` despite assigning it in
  SP_monster_medic. Preserved verbatim (both branches use sound_hook_retract).
- medic_cable_attack's FRAME_attack50 revival branch (rogue/m_medic.c:928-
  936, then read again at line ~954): when the revived monster has no valid
  self.oldenemy to hand it AND FindTarget(self) still succeeds for the
  medic itself, the C source sets `self->enemy = NULL` and then falls
  through to `VectorCopy (self->enemy->s.origin, end)` at the shared tail of
  the function -- a null-pointer dereference in the original game. Ported
  using the `enemy` local captured at function entry for that tail write
  instead of `self.enemy`, avoiding the crash while preserving every other
  effect of the branch (this matches how the beam draw uses the same
  already-resolved target in every other frame of the same move).
- medic_continue (rogue/m_medic.c:715-720) drops the base game's
  `self->enemy &&` guard before calling visible(); visible() requires a
  non-null EdictT here, so the null check is kept (medic_continue is only
  ever reached mid-attack, when self.enemy is always set).

==============================================================================
*/

import {
  AngleVectors,
  anglemod,
  random,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorSet,
  VectorSubtract,
  vec3,
  vec3_origin,
  type Vec3,
} from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_VOICE,
  CHAN_WEAPON,
  EF_BLASTER,
  EF_FLIES,
  EF_GIB,
  EF_HYPERBLASTER,
  MASK_MONSTERSOLID,
  MASK_SHOT,
  MASK_SOLID,
  MASK_WATER,
  MulticastT,
  MZ2_MEDIC_BLASTER_1,
  MZ2_MEDIC_BLASTER_2,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import {
  AI_BLOCKED,
  AI_DODGING,
  AI_DO_NOT_COUNT,
  AI_DUCKED,
  AI_GOOD_GUY,
  AI_HOLD_FRAME,
  AI_IGNORE_SHOTS,
  AI_MANUAL_STEERING,
  AI_MEDIC,
  AI_RESURRECTING,
  AI_SPAWNED_MEDIC_C,
  AI_STAND_GROUND,
  AS_BLIND,
  AS_MISSILE,
  AS_STRAIGHT,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  g_edicts,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MframeT,
  MmoveT,
  MOD_UNKNOWN,
  MovetypeT,
  RANGE_MELEE,
  svc_temp_entity,
  world,
} from "./g_local";
import { type Edict, type GTraceT, SolidT, SVF_DEADMONSTER, SVF_MONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, FindTarget, FoundTarget, M_CheckAttack, range, visible } from "./g_ai";
import { M_FliesOff, M_FliesOn, M_SetEffects, monster_done_dodge, monster_fire_blaster, monster_fire_blaster2, walkmonster_start } from "./g_monster";
import { blocked_checkplat, blocked_checkshot, M_MonsterDodge, monster_duck_down, monster_duck_hold, monster_duck_up, PickCoopTarget, realrange } from "./g_newai";
import { findradius, G_FreeEdict, G_ProjectSource, G_Spawn } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { ED_CallSpawn, ED_NewString } from "./g_spawn";
import { CheckGroundSpawnPoint, CheckSpawnPoint, CreateGroundMonster, FindSpawnPoint, SpawnGrow_Spawn } from "./g_monster";
import { T_Damage } from "./g_combat";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_medic_frames";

const MEDIC_MIN_DISTANCE = 32;
const MEDIC_MAX_HEAL_DISTANCE = 400;
const MEDIC_TRY_TIME = 10.0;

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

function mkframe(aifunc: ((self: EdictT, dist: number) => void) | null, dist: number, thinkfunc: ((self: EdictT) => void) | null = null): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mkmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: ((self: EdictT) => void) | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// Recovers the game-private EdictT from a trace's game-visible Edict, per
// PORTING.md's EDICT_NUM idiom (g_edicts[ent.s.number]), never a cast; this
// module-private helper is duplicated per-file across the codebase
// (g_weapon.ts, m_parasite.ts, m_boss2.ts, ...), not centralized.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

let sound_idle1 = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_die = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_hook_launch = 0;
let sound_hook_hit = 0;
let sound_hook_heal = 0;
let sound_hook_retract = 0;

// ROGUE -- medic commander sounds
let commander_sound_idle1 = 0;
let commander_sound_pain1 = 0;
let commander_sound_pain2 = 0;
let commander_sound_die = 0;
let commander_sound_sight = 0;
let commander_sound_search = 0;
let commander_sound_hook_launch = 0;
let commander_sound_hook_hit = 0;
let commander_sound_hook_heal = 0;
// `commander_sound_hook_retract` is assigned in SP_monster_medic but never
// read anywhere in rogue/m_medic.c -- see medic_hook_retract's header note.
let commander_sound_hook_retract = 0;
let commander_sound_spawn = 0;
// ROGUE

// ROGUE -- monster classnames medic_finish_spawn can summon, indexed by
// (skill-derived) summonStr, and their spawn geometry.
const reinforcements: readonly string[] = fixedLength("reinforcements", 7, [
  "monster_soldier_light", // 0
  "monster_soldier", // 1
  "monster_soldier_ss", // 2
  "monster_infantry", // 3
  "monster_gunner", // 4
  "monster_medic", // 5
  "monster_gladiator", // 6
]);

const reinforcement_mins: readonly Vec3[] = fixedLength("reinforcement_mins", 7, [
  vec3(-16, -16, -24),
  vec3(-16, -16, -24),
  vec3(-16, -16, -24),
  vec3(-16, -16, -24),
  vec3(-16, -16, -24),
  vec3(-16, -16, -24),
  vec3(-32, -32, -24),
]);

const reinforcement_maxs: readonly Vec3[] = fixedLength("reinforcement_maxs", 7, [
  vec3(16, 16, 32),
  vec3(16, 16, 32),
  vec3(16, 16, 32),
  vec3(16, 16, 32),
  vec3(16, 16, 32),
  vec3(16, 16, 32),
  vec3(32, 32, 64),
]);

const reinforcement_position: readonly Vec3[] = fixedLength("reinforcement_position", 5, [
  vec3(80, 0, 0),
  vec3(40, 60, 0),
  vec3(40, -60, 0),
  vec3(0, 80, 0),
  vec3(0, -80, 0),
]);

function cleanupHeal(self: EdictT, change_frame: boolean): void {
  // clean up target, if we have one and it's legit
  if (self.enemy !== null && self.enemy.inuse) {
    self.enemy.monsterinfo.healer = null;
    // vanilla parity (see the note at the claim sites): release the owner
    // claim too, and only if it is still ours.
    if (self.enemy.owner === self) self.enemy.owner = null;
    self.enemy.monsterinfo.aiflags &= ~AI_RESURRECTING;
    self.enemy.takedamage = DamageT.DAMAGE_YES;
    M_SetEffects(self.enemy);
  }

  if (change_frame) self.monsterinfo.nextframe = FRAME.FRAME_attack52;
}

function abortHeal(self: EdictT, change_frame: boolean, gib: boolean, mark: boolean): void {
  // clean up target
  cleanupHeal(self, change_frame);
  // gib em!
  if (mark && self.enemy !== null && self.enemy.inuse) {
    // if the first badMedic slot is filled by a medic, skip it and use the second one
    const badMedic1 = self.enemy.monsterinfo.badMedic1;
    if (badMedic1 !== null && badMedic1.inuse && badMedic1.classname !== null && badMedic1.classname.startsWith("monster_medic")) {
      self.enemy.monsterinfo.badMedic2 = self;
    } else {
      self.enemy.monsterinfo.badMedic1 = self;
    }
  }
  if (gib && self.enemy !== null && self.enemy.inuse) {
    const hurt = self.enemy.gib_health !== 0 ? -self.enemy.gib_health : 500;
    const pain_normal = vec3(0, 0, 1);
    T_Damage(self.enemy, self, self, vec3_origin, self.enemy.s.origin, pain_normal, hurt, 0, 0, MOD_UNKNOWN);
  }
  // clean up self

  self.monsterinfo.aiflags &= ~AI_MEDIC;
  if (self.oldenemy !== null && self.oldenemy.inuse) self.enemy = self.oldenemy;
  else self.enemy = null;

  self.monsterinfo.medicTries = 0;
}

// PMM -- currently unreachable: canReach's only call sites in rogue/
// m_medic.c (medic_FindDeadMonster, medic_run) are commented out in favor of
// the plain visible() check, but the function itself is live source (not
// inside a #if 0 block), so it is ported rather than dropped.
function canReach(self: EdictT, other: EdictT): boolean {
  const spot1 = vec3();
  VectorCopy(self.s.origin, spot1);
  spot1[2] += self.viewheight;
  const spot2 = vec3();
  VectorCopy(other.s.origin, spot2);
  spot2[2] += other.viewheight;
  const trace = gi.trace(spot1, vec3_origin, vec3_origin, spot2, self, MASK_SHOT | MASK_WATER);

  if (trace.fraction === 1.0 || traceEdict(trace.ent) === other) return true;
  return false;
}

function medic_FindDeadMonster(self: EdictT): EdictT | null {
  let ent: EdictT | null = null;
  let best: EdictT | null = null;

  const radius = (self.monsterinfo.aiflags & AI_STAND_GROUND) !== 0 ? MEDIC_MAX_HEAL_DISTANCE : 1024;

  while ((ent = findradius(ent, self.s.origin, radius)) !== null) {
    if (ent === self) continue;
    if (!(ent.svflags & SVF_MONSTER)) continue;
    if (ent.monsterinfo.aiflags & AI_GOOD_GUY) continue;
    // check to make sure we haven't bailed on this guy already
    if (ent.monsterinfo.badMedic1 === self || ent.monsterinfo.badMedic2 === self) continue;
    if (ent.monsterinfo.healer !== null) {
      // FIXME - this is correcting a bug that is somewhere else
      // if the healer is a monster, and it's in medic mode .. continue .. otherwise
      //   we will override the healer, if it passes all the other tests
      const healer = ent.monsterinfo.healer;
      if (healer.inuse && healer.health > 0 && (healer.svflags & SVF_MONSTER) !== 0 && (healer.monsterinfo.aiflags & AI_MEDIC) !== 0) continue;
    }
    if (ent.health > 0) continue;
    if (ent.nextthink !== 0 && !(ent.think === M_FliesOn || ent.think === M_FliesOff)) continue;
    if (!visible(self, ent)) continue;
    // stop it from trying to heal player_noise entities
    if (ent.classname !== null && ent.classname.startsWith("player")) continue;
    // FIXME - there's got to be a better way .. make sure we don't spawn people right on top of us
    if (realrange(self, ent) <= MEDIC_MIN_DISTANCE) continue;
    if (best === null) {
      best = ent;
      continue;
    }
    if (ent.max_health <= best.max_health) continue;
    best = ent;
  }

  if (best !== null) self.timestamp = level.time + MEDIC_TRY_TIME;

  return best;
}

function medic_idle(self: EdictT): void {
  // PMM - commander sounds
  if (self.mass === 400) gi.sound(self, CHAN_VOICE, sound_idle1, 1, ATTN_IDLE, 0);
  else gi.sound(self, CHAN_VOICE, commander_sound_idle1, 1, ATTN_IDLE, 0);

  if (self.oldenemy === null) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      self.enemy.monsterinfo.healer = self;
      // RERELEASE CONTENT PORT -- vanilla parity. rogue's medic overhaul
      // replaced vanilla's `self.enemy.owner = self` corpse claim with the
      // `monsterinfo.healer` back-pointer above. Both are kept here: this
      // one file hosts BOTH monster_medic (which must stay byte-identical
      // to vanilla 3.21) and the ported monster_medic_commander, and
      // `owner` is not just bookkeeping -- the trace/collision code skips
      // an entity's owner, so dropping it would let a vanilla medic
      // collide with the corpse it is reviving. `healer` is inert for
      // anything that does not read it.
      self.enemy.owner = self;
      self.monsterinfo.aiflags |= AI_MEDIC;
      FoundTarget(self);
    }
  }
}

function medic_search(self: EdictT): void {
  // PMM - commander sounds
  if (self.mass === 400) gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_IDLE, 0);
  else gi.sound(self, CHAN_VOICE, commander_sound_search, 1, ATTN_IDLE, 0);

  if (self.oldenemy === null) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      self.enemy.monsterinfo.healer = self;
      // RERELEASE CONTENT PORT -- vanilla parity. rogue's medic overhaul
      // replaced vanilla's `self.enemy.owner = self` corpse claim with the
      // `monsterinfo.healer` back-pointer above. Both are kept here: this
      // one file hosts BOTH monster_medic (which must stay byte-identical
      // to vanilla 3.21) and the ported monster_medic_commander, and
      // `owner` is not just bookkeeping -- the trace/collision code skips
      // an entity's owner, so dropping it would let a vanilla medic
      // collide with the corpse it is reviving. `healer` is inert for
      // anything that does not read it.
      self.enemy.owner = self;
      self.monsterinfo.aiflags |= AI_MEDIC;
      FoundTarget(self);
    }
  }
}

function medic_sight(self: EdictT, _other: EdictT): void {
  // PMM - commander sounds
  if (self.mass === 400) gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, commander_sound_sight, 1, ATTN_NORM, 0);
}

const medic_frames_stand: MframeT[] = [
  mkframe(ai_stand, 0, medic_idle),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
];
const medic_move_stand = mkmove(FRAME.FRAME_wait1, FRAME.FRAME_wait90, medic_frames_stand, null);

function medic_stand(self: EdictT): void {
  self.monsterinfo.currentmove = medic_move_stand;
}

const medic_frames_walk: MframeT[] = [
  mkframe(ai_walk, 6.2),
  mkframe(ai_walk, 18.1),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 11),
  mkframe(ai_walk, 11.6),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 9.9),
  mkframe(ai_walk, 14),
  mkframe(ai_walk, 9.3),
];
const medic_move_walk = mkmove(FRAME.FRAME_walk1, FRAME.FRAME_walk12, medic_frames_walk, null);

function medic_walk(self: EdictT): void {
  self.monsterinfo.currentmove = medic_move_walk;
}

const medic_frames_run: MframeT[] = [
  mkframe(ai_run, 18),
  mkframe(ai_run, 22.5),
  // ROGUE: this frame's thinkfunc gains monster_done_dodge (rogue/m_medic.c:427)
  mkframe(ai_run, 25.4, monster_done_dodge),
  mkframe(ai_run, 23.4),
  mkframe(ai_run, 24),
  mkframe(ai_run, 35.6), // pmm
];
const medic_move_run = mkmove(FRAME.FRAME_run1, FRAME.FRAME_run6, medic_frames_run, null);

function medic_run(self: EdictT): void {
  // ROGUE
  monster_done_dodge(self);
  // ROGUE

  if (!(self.monsterinfo.aiflags & AI_MEDIC)) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      self.enemy.monsterinfo.healer = self;
      // RERELEASE CONTENT PORT -- vanilla parity. rogue's medic overhaul
      // replaced vanilla's `self.enemy.owner = self` corpse claim with the
      // `monsterinfo.healer` back-pointer above. Both are kept here: this
      // one file hosts BOTH monster_medic (which must stay byte-identical
      // to vanilla 3.21) and the ported monster_medic_commander, and
      // `owner` is not just bookkeeping -- the trace/collision code skips
      // an entity's owner, so dropping it would let a vanilla medic
      // collide with the corpse it is reviving. `healer` is inert for
      // anything that does not read it.
      self.enemy.owner = self;
      self.monsterinfo.aiflags |= AI_MEDIC;
      FoundTarget(self);
      return;
    }
  }

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = medic_move_stand;
  else self.monsterinfo.currentmove = medic_move_run;
}

const medic_frames_pain1: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const medic_move_pain1 = mkmove(FRAME.FRAME_paina1, FRAME.FRAME_paina8, medic_frames_pain1, medic_run);

const medic_frames_pain2: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const medic_move_pain2 = mkmove(FRAME.FRAME_painb1, FRAME.FRAME_painb15, medic_frames_pain2, medic_run);

function medic_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  // ROGUE
  monster_done_dodge(self);

  if (self.health < self.max_health / 2) {
    if (self.mass > 400) self.s.skinnum = 3;
    else self.s.skinnum = 1;
  }
  // ROGUE

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // ROGUE
  // if we're healing someone, we ignore pain
  if (self.monsterinfo.aiflags & AI_MEDIC) return;

  if (self.mass > 400) {
    if (damage < 35) {
      gi.sound(self, CHAN_VOICE, commander_sound_pain1, 1, ATTN_NORM, 0);
      return;
    }

    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;

    gi.sound(self, CHAN_VOICE, commander_sound_pain2, 1, ATTN_NORM, 0);

    // no more than 50% chance of big pain
    if (random() < Math.min(damage * 0.005, 0.5)) self.monsterinfo.currentmove = medic_move_pain2;
    else self.monsterinfo.currentmove = medic_move_pain1;
  } else if (random() < 0.5) {
    self.monsterinfo.currentmove = medic_move_pain1;
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.currentmove = medic_move_pain2;
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  }

  // PMM - clear duck flag
  if (self.monsterinfo.aiflags & AI_DUCKED) monster_duck_up(self);
  // ROGUE
}

function medic_fire_blaster(self: EdictT): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const end = vec3();
  const dir = vec3();
  let effect: number;
  // ROGUE
  let damage = 2;

  // paranoia checking
  if (self.enemy === null || !self.enemy.inuse) return;
  // ROGUE

  if (self.s.frame === FRAME.FRAME_attack9 || self.s.frame === FRAME.FRAME_attack12) effect = EF_BLASTER;
  else if (
    self.s.frame === FRAME.FRAME_attack19 ||
    self.s.frame === FRAME.FRAME_attack22 ||
    self.s.frame === FRAME.FRAME_attack25 ||
    self.s.frame === FRAME.FRAME_attack28
  )
    effect = EF_HYPERBLASTER;
  else effect = 0;

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_MEDIC_BLASTER_1], forward, right, start);

  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  // ROGUE
  if (self.enemy.classname === "tesla") damage = 3;

  // medic commander shoots blaster2
  if (self.mass > 400) monster_fire_blaster2(self, start, dir, damage, 1000, MZ2_MEDIC_BLASTER_2, effect);
  else monster_fire_blaster(self, start, dir, damage, 1000, MZ2_MEDIC_BLASTER_1, effect);
  // ROGUE
}

function medic_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const medic_frames_death: MframeT[] = [
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const medic_move_death = mkmove(FRAME.FRAME_death1, FRAME.FRAME_death30, medic_frames_death, medic_dead);

function medic_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // if we had a pending patient, free him up for another medic.
  //
  // VANILLA PARITY: this line is vanilla 3.21's, and it was dropped when
  // rogue's medic overhaul was ported over this file on the theory that
  // Killed()'s cleanupHealTarget covers it. It does not: cleanupHealTarget
  // clears monsterinfo.healer, not `owner`, and a die() reached by any path
  // other than Killed() (or with the patient already claimed) would leave
  // the corpse permanently owned by a dead medic and therefore unclaimable
  // by another one. Both paths now release it; the check makes it
  // idempotent.
  if (self.enemy !== null && self.enemy.owner === self) self.enemy.owner = null;

  // check for gib
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
  // PMM
  if (self.mass === 400) gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, commander_sound_die, 1, ATTN_NORM, 0);

  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  self.monsterinfo.currentmove = medic_move_death;
}

const medic_frames_duck: MframeT[] = [
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1, monster_duck_down),
  mkframe(ai_move, -1, monster_duck_hold),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1), // PMM - duck up used to be here
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1, monster_duck_up),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
];
const medic_move_duck = mkmove(FRAME.FRAME_duck1, FRAME.FRAME_duck16, medic_frames_duck, medic_run);

// PMM -- moved dodge code to after attack code so I can reference attack frames

const medic_frames_attackHyperBlaster: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
];
const medic_move_attackHyperBlaster = mkmove(FRAME.FRAME_attack15, FRAME.FRAME_attack30, medic_frames_attackHyperBlaster, medic_run);

function medic_continue(self: EdictT): void {
  // ROGUE: C drops the `self->enemy &&` guard here (see header note) --
  // kept for null-safety since visible() requires a non-null EdictT.
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (random() <= 0.95) self.monsterinfo.currentmove = medic_move_attackHyperBlaster;
  }
}

const medic_frames_attackBlaster: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, medic_continue), // Change to medic_continue... Else, go to frame 32
];
const medic_move_attackBlaster = mkmove(FRAME.FRAME_attack1, FRAME.FRAME_attack14, medic_frames_attackBlaster, medic_run);

function medic_hook_launch(self: EdictT): void {
  // PMM - commander sounds
  if (self.mass === 400) gi.sound(self, CHAN_WEAPON, sound_hook_launch, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_WEAPON, commander_sound_hook_launch, 1, ATTN_NORM, 0);
}

const medic_cable_offsets: readonly Vec3[] = fixedLength("medic_cable_offsets", 10, [
  vec3(45.0, -9.2, 15.5),
  vec3(48.4, -9.7, 15.2),
  vec3(47.8, -9.8, 15.8),
  vec3(47.3, -9.3, 14.3),
  vec3(45.4, -10.1, 13.1),
  vec3(41.9, -12.7, 12.0),
  vec3(37.8, -15.8, 11.2),
  vec3(34.3, -18.4, 10.7),
  vec3(32.7, -19.7, 10.4),
  vec3(32.7, -19.7, 10.4),
]);

function medic_cable_attack(self: EdictT): void {
  // ROGUE: gib/client/health abort check replaces the base game's plain
  // `!enemy.inuse` guard.
  if (self.enemy === null || !self.enemy.inuse || (self.enemy.s.effects & EF_GIB) !== 0) {
    abortHeal(self, true, false, false);
    return;
  }
  const enemy = self.enemy;

  // see if our enemy has changed to a client, or our target has more than 0 health,
  // abort it .. we got switched to someone else due to damage
  if (enemy.client !== null || enemy.health > 0) {
    abortHeal(self, true, false, false);
    return;
  }

  const f = vec3();
  const r = vec3();
  const start = vec3();
  const end = vec3();
  const dir = vec3();

  AngleVectors(self.s.angles, f, r, null);
  const offset = medic_cable_offsets[self.s.frame - FRAME.FRAME_attack42];
  G_ProjectSource(self.s.origin, offset, f, r, start);

  // check for max distance -- not needed, done in checkattack
  // check for min distance
  VectorSubtract(start, enemy.s.origin, dir);
  const distance = VectorLength(dir);
  if (distance < MEDIC_MIN_DISTANCE) {
    abortHeal(self, true, true, false);
    return;
  }

  // check for min/max pitch -- PMM took this out since it doesn't look bad when it fails

  const tr = gi.trace(start, null, null, enemy.s.origin, self, MASK_SOLID);
  if (tr.fraction !== 1.0 && traceEdict(tr.ent) !== enemy) {
    if (traceEdict(tr.ent) === world()) {
      // give up on second try
      if (self.monsterinfo.medicTries > 1) {
        abortHeal(self, true, false, true);
        return;
      }
      self.monsterinfo.medicTries++;
      cleanupHeal(self, true);
      return;
    }
    abortHeal(self, true, false, false);
    return;
  }

  if (self.s.frame === FRAME.FRAME_attack43) {
    // PMM - commander sounds
    if (self.mass === 400) gi.sound(enemy, CHAN_AUTO, sound_hook_hit, 1, ATTN_NORM, 0);
    else gi.sound(enemy, CHAN_AUTO, commander_sound_hook_hit, 1, ATTN_NORM, 0);

    enemy.monsterinfo.aiflags |= AI_RESURRECTING;
    enemy.takedamage = DamageT.DAMAGE_NO;
    M_SetEffects(enemy);
  } else if (self.s.frame === FRAME.FRAME_attack50) {
    enemy.spawnflags = 0;
    enemy.monsterinfo.aiflags = 0;
    enemy.target = null;
    enemy.targetname = null;
    enemy.combattarget = null;
    enemy.deathtarget = null;
    enemy.monsterinfo.healer = self;
    // vanilla parity -- see the note at the claim sites above.
    enemy.owner = self;

    const maxs = vec3();
    VectorCopy(enemy.maxs, maxs);
    maxs[2] += 48; // compensate for change when they die

    const tr2 = gi.trace(enemy.s.origin, enemy.mins, maxs, enemy.s.origin, enemy, MASK_MONSTERSOLID);
    if (tr2.startsolid || tr2.allsolid) {
      abortHeal(self, true, true, false);
      return;
    } else if (traceEdict(tr2.ent) !== world()) {
      abortHeal(self, true, true, false);
      return;
    } else {
      enemy.monsterinfo.aiflags |= AI_DO_NOT_COUNT;
      ED_CallSpawn(enemy);

      if (enemy.think !== null) {
        enemy.nextthink = level.time;
        enemy.think(enemy);
      }
      enemy.monsterinfo.aiflags &= ~AI_RESURRECTING;
      enemy.monsterinfo.aiflags |= AI_IGNORE_SHOTS | AI_DO_NOT_COUNT;
      // turn off flies
      enemy.s.effects &= ~EF_FLIES;
      enemy.monsterinfo.healer = null;
      // vanilla parity -- the revived monster is its own entity again.
      if (enemy.owner === self) enemy.owner = null;

      if (self.oldenemy !== null && self.oldenemy.inuse && self.oldenemy.health > 0) {
        enemy.enemy = self.oldenemy;
        FoundTarget(enemy);
      } else {
        enemy.enemy = null;
        if (!FindTarget(enemy)) {
          // no valid enemy, so stop acting
          enemy.monsterinfo.pausetime = level.time + 100000000;
          if (enemy.monsterinfo.stand) enemy.monsterinfo.stand(enemy);
        }
        self.enemy = null;
        self.oldenemy = null;
        if (!FindTarget(self)) {
          // no valid enemy, so stop acting
          self.monsterinfo.pausetime = level.time + 100000000;
          if (self.monsterinfo.stand) self.monsterinfo.stand(self);
          return;
        }
      }
    }
  } else {
    if (self.s.frame === FRAME.FRAME_attack44) {
      // PMM - medic commander sounds
      if (self.mass === 400) gi.sound(self, CHAN_WEAPON, sound_hook_heal, 1, ATTN_NORM, 0);
      else gi.sound(self, CHAN_WEAPON, commander_sound_hook_heal, 1, ATTN_NORM, 0);
    }
  }

  // adjust start for beam origin being in middle of a segment
  VectorMA(start, 8, f, start);

  // adjust end z for end spot since the monster is currently dead
  // ROGUE: uses the `enemy` local (not `self.enemy`, which the FRAME_attack50
  // branch above may have nulled) -- see header note.
  VectorCopy(enemy.s.origin, end);
  end[2] = enemy.absmin[2] + enemy.size[2] / 2;

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_MEDIC_CABLE_ATTACK);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

function medic_hook_retract(self: EdictT): void {
  // ROGUE: both branches read `sound_hook_retract` in the C source
  // (rogue/m_medic.c:967-970) -- see this file's header note.
  if (self.mass === 400) gi.sound(self, CHAN_WEAPON, sound_hook_retract, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_WEAPON, sound_hook_retract, 1, ATTN_NORM, 0);

  self.monsterinfo.aiflags &= ~AI_MEDIC;
  if (self.oldenemy !== null && self.oldenemy.inuse) self.enemy = self.oldenemy;
  else {
    self.enemy = null;
    self.oldenemy = null;
    if (!FindTarget(self)) {
      // no valid enemy, so stop acting
      self.monsterinfo.pausetime = level.time + 100000000;
      if (self.monsterinfo.stand) self.monsterinfo.stand(self);
      return;
    }
  }
}

// ROGUE - negated 36-40 so he scoots back from his target a little
// ROGUE - switched 33-36 to ai_charge
// ROGUE - changed frame 52 to 0 to compensate for changes in 36-40
const medic_frames_attackCable: MframeT[] = [
  mkframe(ai_charge, 2), //33
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, -4.4), //36
  mkframe(ai_charge, -4.7), //37
  mkframe(ai_charge, -5),
  mkframe(ai_charge, -6),
  mkframe(ai_charge, -4), //40
  mkframe(ai_charge, 0),
  mkframe(ai_move, 0, medic_hook_launch), //42
  mkframe(ai_move, 0, medic_cable_attack), //43
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack), //51
  mkframe(ai_move, 0, medic_hook_retract), //52
  mkframe(ai_move, -1.5),
  mkframe(ai_move, -1.2),
  mkframe(ai_move, -3),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0.3),
  mkframe(ai_move, 0.7),
  mkframe(ai_move, 1.2),
  mkframe(ai_move, 1.3), //60
];
const medic_move_attackCable = mkmove(FRAME.FRAME_attack33, FRAME.FRAME_attack60, medic_frames_attackCable, medic_run);

// ROGUE -- medic commander reinforcement summoning
function medic_start_spawn(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, commander_sound_spawn, 1, ATTN_NORM, 0);
  self.monsterinfo.nextframe = FRAME.FRAME_attack48;
}

function medic_determine_spawn(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  let num_success = 0;

  const lucky = random();
  let summonStr = cvarNum(gameCvars.skill);

  // bell curve - 0 = 67%, 1 = 93%, 2 = 99% -- too steep
  // this ends up with
  // -3 = 5%
  // -2 = 10%
  // -1 = 15%
  // 0  = 40%
  // +1 = 15%
  // +2 = 10%
  // +3 = 5%
  if (lucky < 0.05) summonStr -= 3;
  else if (lucky < 0.15) summonStr -= 2;
  else if (lucky < 0.3) summonStr -= 1;
  else if (lucky > 0.95) summonStr += 3;
  else if (lucky > 0.85) summonStr += 2;
  else if (lucky > 0.7) summonStr += 1;

  if (summonStr < 0) summonStr = 0;

  // FIXME - need to remember this, might as well use this int that isn't used for monsters
  self.plat2flags = summonStr;
  AngleVectors(self.s.angles, f, r, null);

  // this yields either 1, 3, or 5
  const num_summoned = summonStr !== 0 ? summonStr - 1 + (summonStr % 2) : 1;

  for (let count = 0; count < num_summoned; count++) {
    const inc = count + (count % 2); // 0, 2, 2, 4, 4
    const offset = vec3();
    VectorCopy(reinforcement_position[count], offset);

    const startpoint = vec3();
    G_ProjectSource(self.s.origin, offset, f, r, startpoint);
    // a little off the ground
    startpoint[2] += 10;

    const spawnpoint = vec3();
    if (FindSpawnPoint(startpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], spawnpoint, 32)) {
      if (CheckGroundSpawnPoint(spawnpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], 256, -1)) {
        num_success++;
        // we found a spot, we're done here
        count = num_summoned;
      }
    }
  }

  if (num_success === 0) {
    for (let count = 0; count < num_summoned; count++) {
      const inc = count + (count % 2); // 0, 2, 2, 4, 4
      const offset = vec3();
      VectorCopy(reinforcement_position[count], offset);

      // check behind
      offset[0] *= -1.0;
      offset[1] *= -1.0;
      const startpoint = vec3();
      G_ProjectSource(self.s.origin, offset, f, r, startpoint);
      // a little off the ground
      startpoint[2] += 10;

      const spawnpoint = vec3();
      if (FindSpawnPoint(startpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], spawnpoint, 32)) {
        if (CheckGroundSpawnPoint(spawnpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], 256, -1)) {
          num_success++;
          // we found a spot, we're done here
          count = num_summoned;
        }
      }
    }

    if (num_success !== 0) {
      self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
      self.ideal_yaw = anglemod(self.s.angles[YAW]) + 180;
      if (self.ideal_yaw > 360.0) self.ideal_yaw -= 360.0;
    }
  }

  if (num_success === 0) {
    self.monsterinfo.nextframe = FRAME.FRAME_attack53;
  }
}

function medic_spawngrows(self: EdictT): void {
  // if we've been directed to turn around
  if (self.monsterinfo.aiflags & AI_MANUAL_STEERING) {
    const current_yaw = anglemod(self.s.angles[YAW]);
    if (Math.abs(current_yaw - self.ideal_yaw) > 0.1) {
      self.monsterinfo.aiflags |= AI_HOLD_FRAME;
      return;
    }

    // done turning around
    self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
  }

  const summonStr = self.plat2flags;

  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);

  const num_summoned = summonStr !== 0 ? summonStr - 1 + (summonStr % 2) : 1;
  let num_success = 0;

  for (let count = 0; count < num_summoned; count++) {
    const inc = count + (count % 2); // 0, 2, 2, 4, 4
    const offset = vec3();
    VectorCopy(reinforcement_position[count], offset);

    const startpoint = vec3();
    G_ProjectSource(self.s.origin, offset, f, r, startpoint);
    // a little off the ground
    startpoint[2] += 10;

    const spawnpoint = vec3();
    if (FindSpawnPoint(startpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], spawnpoint, 32)) {
      if (CheckGroundSpawnPoint(spawnpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], 256, -1)) {
        num_success++;
        if (summonStr - inc > 3) SpawnGrow_Spawn(spawnpoint, 1); // big monster
        else SpawnGrow_Spawn(spawnpoint, 0); // normal size
      }
    }
  }

  if (num_success === 0) {
    self.monsterinfo.nextframe = FRAME.FRAME_attack53;
  }
}

function medic_finish_spawn(self: EdictT): void {
  if (self.plat2flags < 0) {
    self.plat2flags *= -1;
  }
  const summonStr = self.plat2flags;

  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);

  const num_summoned = summonStr !== 0 ? summonStr - 1 + (summonStr % 2) : 1;

  for (let count = 0; count < num_summoned; count++) {
    const inc = count + (count % 2); // 0, 2, 2, 4, 4
    const offset = vec3();
    VectorCopy(reinforcement_position[count], offset);

    const startpoint = vec3();
    G_ProjectSource(self.s.origin, offset, f, r, startpoint);
    // a little off the ground
    startpoint[2] += 10;

    let ent: EdictT | null = null;
    const spawnpoint = vec3();
    if (FindSpawnPoint(startpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc], spawnpoint, 32)) {
      if (CheckSpawnPoint(spawnpoint, reinforcement_mins[summonStr - inc], reinforcement_maxs[summonStr - inc])) {
        ent = CreateGroundMonster(
          spawnpoint,
          self.s.angles,
          reinforcement_mins[summonStr - inc],
          reinforcement_maxs[summonStr - inc],
          reinforcements[summonStr - inc],
          256,
        );
      }
    }

    if (ent === null) continue;

    if (ent.think !== null) {
      ent.nextthink = level.time;
      ent.think(ent);
    }

    ent.monsterinfo.aiflags |= AI_IGNORE_SHOTS | AI_DO_NOT_COUNT | AI_SPAWNED_MEDIC_C;
    ent.monsterinfo.commander = self;
    self.monsterinfo.monster_slots--;

    let designated_enemy: EdictT | null = (self.monsterinfo.aiflags & AI_MEDIC) !== 0 ? self.oldenemy : self.enemy;

    if (cvarNum(gameCvars.coop) !== 0) {
      designated_enemy = PickCoopTarget(ent);
      if (designated_enemy !== null) {
        // try to avoid using my enemy
        if (designated_enemy === self.enemy) {
          designated_enemy = PickCoopTarget(ent);
          if (designated_enemy === null) {
            designated_enemy = self.enemy;
          }
        }
      } else {
        designated_enemy = self.enemy;
      }
    }

    if (designated_enemy !== null && designated_enemy.inuse && designated_enemy.health > 0) {
      ent.enemy = designated_enemy;
      FoundTarget(ent);
    } else {
      ent.enemy = null;
      if (ent.monsterinfo.stand) ent.monsterinfo.stand(ent);
    }
  }
}

// ROGUE - 33-36 now ai_charge
const medic_frames_callReinforcements: MframeT[] = [
  mkframe(ai_charge, 2), //33
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 4.4), //36
  mkframe(ai_charge, 4.7),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 4), //40
  mkframe(ai_charge, 0),
  mkframe(ai_move, 0, medic_start_spawn), //42
  mkframe(ai_move, 0), //43 -- 43 through 47 are skipped
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, medic_determine_spawn), //48
  mkframe(ai_charge, 0, medic_spawngrows), //49
  mkframe(ai_move, 0), //50
  mkframe(ai_move, 0), //51
  mkframe(ai_move, -15, medic_finish_spawn), //52
  mkframe(ai_move, -1.5),
  mkframe(ai_move, -1.2),
  mkframe(ai_move, -3),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0.3),
  mkframe(ai_move, 0.7),
  mkframe(ai_move, 1.2),
  mkframe(ai_move, 1.3), //60
];
const medic_move_callReinforcements = mkmove(FRAME.FRAME_attack33, FRAME.FRAME_attack60, medic_frames_callReinforcements, medic_run);

function medic_attack(self: EdictT): void {
  // ROGUE
  monster_done_dodge(self);

  if (self.enemy === null) return; // C assumes self->enemy is set here

  const enemy_range = range(self, self.enemy);

  // signal from checkattack to spawn
  if (self.monsterinfo.aiflags & AI_BLOCKED) {
    self.monsterinfo.currentmove = medic_move_callReinforcements;
    self.monsterinfo.aiflags &= ~AI_BLOCKED;
  }

  const r = random();
  if (self.monsterinfo.aiflags & AI_MEDIC) {
    if (self.mass > 400 && r > 0.8 && self.monsterinfo.monster_slots > 2) self.monsterinfo.currentmove = medic_move_callReinforcements;
    else self.monsterinfo.currentmove = medic_move_attackCable;
  } else {
    if (self.monsterinfo.attack_state === AS_BLIND) {
      self.monsterinfo.currentmove = medic_move_callReinforcements;
      return;
    }
    if (self.mass > 400 && r > 0.2 && enemy_range !== RANGE_MELEE && self.monsterinfo.monster_slots > 2)
      self.monsterinfo.currentmove = medic_move_callReinforcements;
    else self.monsterinfo.currentmove = medic_move_attackBlaster;
  }
  // ROGUE
}

function medic_checkattack(self: EdictT): boolean {
  if (self.monsterinfo.aiflags & AI_MEDIC) {
    // if our target went away
    if (self.enemy === null || !self.enemy.inuse) {
      abortHeal(self, true, false, false);
      return false;
    }

    // if we ran out of time, give up
    if (self.timestamp < level.time) {
      abortHeal(self, true, false, true);
      self.timestamp = 0;
      return false;
    }

    if (realrange(self, self.enemy) < MEDIC_MAX_HEAL_DISTANCE + 10) {
      medic_attack(self);
      return true;
    } else {
      self.monsterinfo.attack_state = AS_STRAIGHT;
      return false;
    }
  }

  if (self.enemy === null) return M_CheckAttack(self); // C assumes self->enemy is set here

  if (self.enemy.client !== null && !visible(self, self.enemy) && self.monsterinfo.monster_slots > 2) {
    self.monsterinfo.attack_state = AS_BLIND;
    return true;
  }

  // give a LARGE bias to spawning things when we have room
  // use AI_BLOCKED as a signal to attack to spawn
  if (random() < 0.8 && self.monsterinfo.monster_slots > 5 && realrange(self, self.enemy) > 150) {
    self.monsterinfo.aiflags |= AI_BLOCKED;
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  // ROGUE
  // since his idle animation looks kinda bad in combat, if we're not in easy mode, always attack
  // when he's on a combat point.
  // RESTRICTED to monster_medic_commander (self.mass > 400): rogue/m_medic.c
  // applies this to classic monster_medic too, but that changes classic
  // medic's stand-ground attack frequency (a real combat-tactic change, not
  // part of the healing-mechanic overhaul) for every classic map. See
  // g_ai.ts's ROGUE_MONSTER_CLASSNAMES gate for the same restriction pattern.
  if (self.mass > 400 && cvarNum(gameCvars.skill) > 0) {
    if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
      self.monsterinfo.attack_state = AS_MISSILE;
      return true;
    }
  }

  return M_CheckAttack(self);
}

// Classic monster_medic keeps its original 3.21 dodge (random() > 0.25
// duck-in-place check): monsterinfo.dodge/duck/unduck/sidestep/blocked are
// only rewired onto the shared M_MonsterDodge/medic_duck/medic_sidestep/
// medic_blocked machinery below for monster_medic_commander, in
// SP_monster_medic -- see that function's porting note. rogue/m_medic.c
// applies the M_MonsterDodge rewrite and medic_blocked to both classnames
// (the original per-monster medic_dodge is left as dead, fully-commented-out
// C source there), but doing so here would give classic medic new blocked-
// path attack/plat behavior (via m_move.ts's SV_NewChaseDir blocked
// fallback) and a different evade reflex than vanilla 3.21.
function medic_dodge(self: EdictT, attacker: EdictT, _eta: number, _tr: GTraceT): void {
  if (random() > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  self.monsterinfo.currentmove = medic_move_duck;
}

function MedicCommanderCache(): void {
  // FIXME - better way to do this? this is quick and dirty
  for (let i = 0; i < 7; i++) {
    const newEnt = G_Spawn();

    VectorCopy(vec3_origin, newEnt.s.origin);
    VectorCopy(vec3_origin, newEnt.s.angles);
    newEnt.classname = ED_NewString(reinforcements[i]);

    newEnt.monsterinfo.aiflags |= AI_DO_NOT_COUNT;

    ED_CallSpawn(newEnt);
    // FIXME - could copy mins/maxs into reinforcements from here
    G_FreeEdict(newEnt);
  }

  gi.modelindex("models/items/spawngro/tris.md2");
  gi.modelindex("models/items/spawngro2/tris.md2");
}

function medic_duck(self: EdictT, eta: number): void {
  // don't dodge if you're healing
  if (self.monsterinfo.aiflags & AI_MEDIC) return;

  if (
    self.monsterinfo.currentmove === medic_move_attackHyperBlaster ||
    self.monsterinfo.currentmove === medic_move_attackCable ||
    self.monsterinfo.currentmove === medic_move_attackBlaster ||
    self.monsterinfo.currentmove === medic_move_callReinforcements
  ) {
    // he ignores skill
    self.monsterinfo.aiflags &= ~AI_DUCKED;
    return;
  }

  if (cvarNum(gameCvars.skill) === 0)
    // PMM - stupid dodge
    self.monsterinfo.duck_wait_time = level.time + eta + 1;
  else self.monsterinfo.duck_wait_time = level.time + eta + 0.1 * (3 - cvarNum(gameCvars.skill));

  // has to be done immediately otherwise he can get stuck
  monster_duck_down(self);

  self.monsterinfo.nextframe = FRAME.FRAME_duck1;
  self.monsterinfo.currentmove = medic_move_duck;
}

function medic_sidestep(self: EdictT): void {
  if (
    self.monsterinfo.currentmove === medic_move_attackHyperBlaster ||
    self.monsterinfo.currentmove === medic_move_attackCable ||
    self.monsterinfo.currentmove === medic_move_attackBlaster ||
    self.monsterinfo.currentmove === medic_move_callReinforcements
  ) {
    // if we're shooting, and not on easy, don't dodge
    if (cvarNum(gameCvars.skill) !== 0) {
      self.monsterinfo.aiflags &= ~AI_DODGING;
      return;
    }
  }

  if (self.monsterinfo.currentmove !== medic_move_run) self.monsterinfo.currentmove = medic_move_run;
}

//===========
//PGM
function medic_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  if (blocked_checkplat(self, dist)) return true;

  return false;
}
//PGM
//===========

/*QUAKED monster_medic_commander (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
/*QUAKED monster_medic (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_medic(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/medic/tris.md2");
  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 32);

  // PMM
  if (self.classname === "monster_medic_commander") {
    self.health = 600; // fixme
    self.gib_health = -130;
    self.mass = 600;
    self.yaw_speed = 40; // default is 20
    MedicCommanderCache();
  } else {
    // PMM
    self.health = 300;
    self.gib_health = -130;
    self.mass = 400;
  }

  self.pain = medic_pain;
  self.die = medic_die;

  self.monsterinfo.stand = medic_stand;
  self.monsterinfo.walk = medic_walk;
  self.monsterinfo.run = medic_run;
  // pmm
  // RESTRICTED to monster_medic_commander: rogue/m_medic.c rewires dodge
  // onto the shared M_MonsterDodge/duck/sidestep machinery (and wires
  // monsterinfo.blocked, below) for classic monster_medic too, but that both
  // changes classic medic's evade reflex from vanilla 3.21's simple
  // duck-in-place check and gives it new blocked-path attack/plat behavior
  // (via m_move.ts's SV_NewChaseDir blocked fallback) it never had. See
  // medic_dodge's porting note and g_ai.ts's ROGUE_MONSTER_CLASSNAMES gate
  // for the same restriction pattern.
  if (self.classname === "monster_medic_commander") {
    self.monsterinfo.dodge = M_MonsterDodge;
    self.monsterinfo.duck = medic_duck;
    self.monsterinfo.unduck = monster_duck_up;
    self.monsterinfo.sidestep = medic_sidestep;
    self.monsterinfo.blocked = medic_blocked;
  } else {
    self.monsterinfo.dodge = medic_dodge;
  }
  // pmm
  self.monsterinfo.attack = medic_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = medic_sight;
  self.monsterinfo.idle = medic_idle;
  self.monsterinfo.search = medic_search;
  self.monsterinfo.checkattack = medic_checkattack;

  gi.linkentity(self);

  self.monsterinfo.currentmove = medic_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);

  // PMM
  self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;

  if (self.mass > 400) {
    self.s.skinnum = 2;
    const skillValue = cvarNum(gameCvars.skill);
    if (skillValue === 0) self.monsterinfo.monster_slots = 3;
    else if (skillValue === 1) self.monsterinfo.monster_slots = 4;
    else if (skillValue === 2) self.monsterinfo.monster_slots = 6;
    else if (skillValue === 3) self.monsterinfo.monster_slots = 6;
    // commander sounds
    commander_sound_idle1 = gi.soundindex("medic_commander/medidle.wav");
    commander_sound_pain1 = gi.soundindex("medic_commander/medpain1.wav");
    commander_sound_pain2 = gi.soundindex("medic_commander/medpain2.wav");
    commander_sound_die = gi.soundindex("medic_commander/meddeth.wav");
    commander_sound_sight = gi.soundindex("medic_commander/medsght.wav");
    commander_sound_search = gi.soundindex("medic_commander/medsrch.wav");
    commander_sound_hook_launch = gi.soundindex("medic_commander/medatck2c.wav");
    commander_sound_hook_hit = gi.soundindex("medic_commander/medatck3a.wav");
    commander_sound_hook_heal = gi.soundindex("medic_commander/medatck4a.wav");
    commander_sound_hook_retract = gi.soundindex("medic_commander/medatck5a.wav");
    commander_sound_spawn = gi.soundindex("medic_commander/monsterspawn1.wav");
    gi.soundindex("tank/tnkatck3.wav");
  } else {
    sound_idle1 = gi.soundindex("medic/idle.wav");
    sound_pain1 = gi.soundindex("medic/medpain1.wav");
    sound_pain2 = gi.soundindex("medic/medpain2.wav");
    sound_die = gi.soundindex("medic/meddeth1.wav");
    sound_sight = gi.soundindex("medic/medsght1.wav");
    sound_search = gi.soundindex("medic/medsrch1.wav");
    sound_hook_launch = gi.soundindex("medic/medatck2.wav");
    sound_hook_hit = gi.soundindex("medic/medatck3.wav");
    sound_hook_heal = gi.soundindex("medic/medatck4.wav");
    sound_hook_retract = gi.soundindex("medic/medatck5.wav");
    gi.soundindex("medic/medatck1.wav");

    self.s.skinnum = 0;
  }
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_medic:medic_pain", medic_pain);
registerSaveFunction("m_medic:medic_die", medic_die);
registerSaveFunction("m_medic:medic_stand", medic_stand);
registerSaveFunction("m_medic:medic_walk", medic_walk);
registerSaveFunction("m_medic:medic_run", medic_run);
registerSaveFunction("m_medic:medic_dodge", medic_dodge);
registerSaveFunction("m_medic:medic_duck", medic_duck);
registerSaveFunction("m_medic:medic_sidestep", medic_sidestep);
registerSaveFunction("m_medic:medic_blocked", medic_blocked);
registerSaveFunction("m_medic:medic_attack", medic_attack);
registerSaveFunction("m_medic:medic_sight", medic_sight);
registerSaveFunction("m_medic:medic_idle", medic_idle);
registerSaveFunction("m_medic:medic_search", medic_search);
registerSaveFunction("m_medic:medic_checkattack", medic_checkattack);
registerSaveMmove("m_medic:medic_move_stand", medic_move_stand);
registerSaveMmove("m_medic:medic_move_walk", medic_move_walk);
registerSaveMmove("m_medic:medic_move_run", medic_move_run);
registerSaveMmove("m_medic:medic_move_pain1", medic_move_pain1);
registerSaveMmove("m_medic:medic_move_pain2", medic_move_pain2);
registerSaveMmove("m_medic:medic_move_death", medic_move_death);
registerSaveMmove("m_medic:medic_move_duck", medic_move_duck);
registerSaveMmove("m_medic:medic_move_attackHyperBlaster", medic_move_attackHyperBlaster);
registerSaveMmove("m_medic:medic_move_attackBlaster", medic_move_attackBlaster);
registerSaveMmove("m_medic:medic_move_attackCable", medic_move_attackCable);
registerSaveMmove("m_medic:medic_move_callReinforcements", medic_move_callReinforcements);
