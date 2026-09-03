// g_ai.c
//
// rogue/g_ai.c vs baseq2/g_ai.c: the pack's largest shared-basename delta.
// Ported additively and, where the C's own addition is genuinely UNGATED
// (i.e. it would change behavior for every monster sharing this file, not
// just rogue's), restricted here to ROGUE_MONSTER_CLASSNAMES -- the 8
// classnames this porting round adds -- so classic monsters (soldier, tank,
// gunner, etc., all of whom call into this same shared file) stay byte-
// identical to vanilla 3.21. See PORTING.md's fidelity rule and this file's
// own porting report for the exact list of restrictions and why each one was
// judged necessary. Summary of what rogue/g_ai.c changed (see individual
// function comments for the exact C rationale and gating):
// - AI_SetSightClient additionally skips FL_DISGUISED entities (flag never
//   set on a classic entity -- inert).
// - ai_stand/ai_charge/ai_turn/ai_run_melee/ai_run_missile/ai_run_slide all
//   gain an AI_MANUAL_STEERING guard around M_ChangeYaw (flag never set on a
//   classic entity -- inert; a monster under manual steering, e.g.
//   mid-hint-path, still turns via M_walkmove but doesn't let M_ChangeYaw
//   fight that turn).
// - ai_stand also records blind-fire/last-sighting state when its enemy is
//   visible (inert field writes classic monster code never reads), and --
//   RESTRICTED to ROGUE_MONSTER_CLASSNAMES -- falls through to FindTarget
//   when ai_checkattack declines (this is a real, ungated rogue behavior
//   change for every monster in the shipped binary; restricted here to keep
//   classic ai_stand byte-identical).
// - ai_charge gains blind-fire target tracking (inert), an early-out for a
//   dead/gone enemy (so monsters don't walk toward the origin after killing
//   a tesla -- strictly safer, no classic-monster behavior change since
//   `!self.enemy.inuse` never held true before for a live combat scenario),
//   AI_CHARGING (call M_MoveToGoal directly -- flag never set on a classic
//   entity, inert) and -- RESTRICTED to ROGUE_MONSTER_CLASSNAMES -- a
//   circle-strafe (AS_SLIDING) movement branch (ungated in the C; classic
//   ai_charge never inspected attack_state at all, so adding it unrestricted
//   risks a classic monster coincidentally circle-strafing during ai_charge
//   instead of walking straight).
// - visible() also counts a full-length trace whose endpoint entity is the
//   target itself (info_notnull-style intangible targets) -- RESTRICTED to
//   ROGUE_MONSTER_CLASSNAMES as the caller (`self`), since this is a genuine,
//   if narrow, visibility-corner-case widening versus vanilla.
// - FoundTarget clears FL_DISGUISED off a spotted enemy (inert) and seeds
//   the new blind-fire-target state (inert field write).
// - FindTarget gains a disguise_violator/disguise_violation_framenum sound
//   source (inert, level.disguise_violation_framenum never set by classic
//   code), a coop hint-path sound-ignore rule (gated on AI_HINT_PATH, never
//   set on a classic entity -- inert), and routes a newly-found enemy
//   through hintpath_stop (g_newai.c) instead of FoundTarget when the
//   monster is following a hint path (same gate).
// - M_CheckAttack gains blind-fire logic (gated on monsterinfo.blindfire,
//   false by default -- inert for classic), lets monsters shoot at
//   SOLID_NOT (info_notnull) targets even without a clear trace hit (inert
//   unless enemy.solid === SOLID_NOT, which never happens for a classic
//   player/monster enemy), fixes the melee/missile attack_state to
//   AS_STRAIGHT on early bail-outs (strictly safer -- prevents a stale
//   AS_SLIDING/AS_MELEE from surviving a declined attack; verified against
//   every ai_run/ai_checkattack caller, no classic behavior depends on the
//   stale value), and -- RESTRICTED to ROGUE_MONSTER_CLASSNAMES -- replaces
//   the FL_FLY-only 0.3 strafe chance with a monster_daedalus-specific 0.8/
//   generic-rogue-flyer 0.6 chance, plus an always-on ("SLIDING_TROOPS")
//   0.4 ground-monster strafe chance. Both replacements are UNGATED in the
//   shipped rogue binary (it changed classic flyer/hover/soldier/etc. combat
//   feel too, by design, since rogue replaced the whole game DLL) but are
//   restricted here since this port keeps one classic ruleset byte-identical
//   to vanilla 3.21 while also hosting rogue's monsters.
// - ai_run_slide's non-flyer sidestep distance clamp has an operator-
//   precedence bug in the C itself (`if (!self->flags & FL_FLY)` instead of
//   `if (!(self->flags & FL_FLY))` -- `!` binds tighter than `&`, so the
//   clamp only ever applies when self->flags is exactly 0) -- preserved
//   bug-for-bug per PORTING.md; see the inline comment at the call site.
//   It also gives up and returns AS_STRAIGHT when a dodge move fails (gated
//   on AI_DODGING, never set on a classic entity -- inert), instead of
//   always trying both sidestep directions unconditionally.
// - ai_checkattack calls monsterinfo.checkattack before (not after) the
//   AS_MISSILE/AS_MELEE dispatch, so a monster's custom checkattack can
//   drive circle-strafing/charging behavior (every classic monster's
//   checkattack is either unset -- defaults to M_CheckAttack -- or a
//   drop-in override that doesn't depend on dispatch order; verified no
//   classic monster's checkattack has a side effect that this reordering
//   would double-apply), and adds an AS_BLIND state (new enum value, only
//   ever set by the also-restricted blind-fire logic in M_CheckAttack --
//   inert for classic).
// - ai_run gains AI_DUCKED/base_height cleanup (monster_duck_up, g_newai.c;
//   inert -- g_monster.ts's monster_start now sets base_height = maxs[2] for
//   every monster, so this comparison never fires unless a monster actually
//   ducks, which only rogue's duck/sidestep monsters do), an entire
//   AI_HINT_PATH branch (gated, inert for classic), an alreadyMoved guard so
//   M_MoveToGoal is never called twice in one frame -- RESTRICTED to
//   ROGUE_MONSTER_CLASSNAMES in the one spot (the AI_SOUND_TARGET branch)
//   where skipping a genuine double-move is an observable behavior change
//   from vanilla 3.21's own double-move quirk, preserved bug-for-bug for
//   classic monsters per PORTING.md -- AI_CHARGING/AI_DODGING attack_state
//   coordination (gated, inert for classic), blind-fire target tracking
//   alongside last_sighting (inert field writes), a monsterlost_checkhint
//   (g_newai.c) call after 5 seconds of lost contact (inert -- no-ops
//   immediately when there are no hint_path entities on the map), and
//   `!self.inuse` guards after every M_MoveToGoal call (a touch-trigger can
//   free the entity mid-move -- strictly safer).

import {
  AngleVectors,
  anglemod,
  DotProduct,
  random,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorLength,
  VectorNormalize,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WINDOW,
  MASK_OPAQUE,
  MASK_PLAYERSOLID,
  YAW,
} from "../shared/q_shared";
import { type Edict, SolidT, SVF_MONSTER } from "./game";
import {
  AI_BRUTAL,
  AI_CHARGING,
  AI_COMBAT_POINT,
  AI_DODGING,
  AI_DUCKED,
  AI_GOOD_GUY,
  AI_HINT_PATH,
  AI_LOST_SIGHT,
  AI_MANUAL_STEERING,
  AI_MEDIC,
  AI_PURSUE_NEXT,
  AI_PURSUE_TEMP,
  AI_PURSUIT_LAST_SEEN,
  AI_SOUND_TARGET,
  AI_STAND_GROUND,
  AI_TEMP_STAND_GROUND,
  AS_BLIND,
  AS_MELEE,
  AS_MISSILE,
  AS_SLIDING,
  AS_STRAIGHT,
  type EdictT,
  FL_DISGUISED,
  FL_FLY,
  FL_NOTARGET,
  g_edicts,
  game,
  gameCvars,
  gi,
  level,
  MELEE_DISTANCE,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
} from "./g_local";
import { AttackFinished, monster_done_dodge } from "./g_monster";
import { hintpath_stop, monster_duck_up, monsterlost_checkhint } from "./g_newai";
import { G_FreeEdict, G_PickTarget, G_ProjectSource, G_Spawn, vectoyaw, vtos } from "./g_utils";
import { M_ChangeYaw, M_MoveToGoal, M_walkmove } from "./m_move";
import { PlayerTrail_PickFirst, PlayerTrail_PickNext } from "./p_trail";

// ROGUE -- see this file's top-of-file porting note. Every genuinely UNGATED
// rogue/g_ai.c behavior change (one that would alter a classic monster's
// combat feel, not just add inert bookkeeping) is restricted to these 8
// classnames -- exactly this porting round's monster list -- so classic
// monsters sharing this file stay byte-identical to vanilla 3.21.
const ROGUE_MONSTER_CLASSNAMES = new Set<string>([
  "monster_stalker",
  "monster_carrier",
  "monster_widow",
  "monster_widow2",
  "monster_turret",
  "turret_invisible_brain",
  "monster_daedalus",
  "monster_medic_commander",
]);
function isRogueMonster(self: EdictT): boolean {
  return self.classname !== null && ROGUE_MONSTER_CLASSNAMES.has(self.classname);
}

// rogue/g_ai.c's file-top `#define SLIDING_TROOPS 1` / `#define MAX_SIDESTEP
// 8.0`. SLIDING_TROOPS is unconditionally defined in the shipped binary, so
// its `#ifdef` in ai_checkattack always takes the "compiled in" branch below
// (restricted to ROGUE_MONSTER_CLASSNAMES here -- see the top-of-file note);
// MAX_SIDESTEP is used by ai_run_slide.
const MAX_SIDESTEP = 8.0;

// C's `qboolean show_hostile` really holds a truncated level.time timestamp
// (int-backed enum absorbs the float assignment); EdictT types it as number.
function setShowHostile(ent: EdictT, levelTime: number): void {
  ent.show_hostile = Math.trunc(levelTime + 1);
}

function getShowHostileUntil(ent: EdictT): number {
  return ent.show_hostile;
}

// trace_t.ent recovery idiom (see g_monster.ts's traceEdict / g_phys.ts's
// traceEdict): sv_world.c defaults an unset trace.ent to the world edict,
// never NULL, so a null GTraceT.ent here falls back to g_edicts[0] the same
// way. Module-local per PORTING.md (g_monster.ts's own copy is local too).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// module-level globals, matching g_ai.c's file-scope `enemy_vis` /
// `enemy_infront` / `enemy_range` / `enemy_yaw`. Grepping the C tree shows
// no other ported file reads these (m_boss2.c/m_boss31.c/m_boss32.c declare
// their own function-local shadows of the same names, not references to
// these), so they stay module-private rather than becoming an exported
// holder object.
let enemy_vis = false;
let enemy_infront = false;
let enemy_range = RANGE_MELEE; // 0, matches the C global's zero-initialized default
let enemy_yaw = 0;

//============================================================================

/*
=================
AI_SetSightClient

Called once each frame to set level.sight_client to the
player to be checked for in findtarget.

If all clients are either dead or in notarget, sight_client
will be null.

In coop games, sight_client will cycle between the clients.
=================
*/
export function AI_SetSightClient(): void {
  let start: number;
  if (level.sight_client === null) {
    start = 1;
  } else {
    start = level.sight_client.s.number;
  }

  let check = start;
  for (;;) {
    check++;
    if (check > game.maxclients) check = 1;
    const ent = g_edicts[check];
    if (ent.inuse && ent.health > 0 && !(ent.flags & (FL_NOTARGET | FL_DISGUISED))) {
      level.sight_client = ent;
      return; // got one
    }
    if (check === start) {
      level.sight_client = null;
      return; // nobody to see
    }
  }
}

//============================================================================

/*
=============
ai_move

Move the specified distance at current facing.
This replaces the QC functions: ai_forward, ai_back, ai_pain, and ai_painforward
==============
*/
export function ai_move(self: EdictT, dist: number): void {
  M_walkmove(self, self.s.angles[YAW], dist);
}

/*
=============
ai_stand

Used for standing around and looking for players
Distance is for slight position adjustments needed by the animations
==============
*/
export function ai_stand(self: EdictT, dist: number): void {
  if (dist) M_walkmove(self, self.s.angles[YAW], dist);

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    if (self.enemy !== null) {
      const v = vec3();
      VectorSubtract(self.enemy.s.origin, self.s.origin, v);
      self.ideal_yaw = vectoyaw(v);
      if (self.s.angles[YAW] !== self.ideal_yaw && self.monsterinfo.aiflags & AI_TEMP_STAND_GROUND) {
        self.monsterinfo.aiflags &= ~(AI_STAND_GROUND | AI_TEMP_STAND_GROUND);
        if (self.monsterinfo.run) self.monsterinfo.run(self);
      }
      if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);

      // PMM
      // find out if we're going to be shooting
      const retval = ai_checkattack(self, 0);
      // record sightings of player
      if (self.enemy !== null && self.enemy.inuse && visible(self, self.enemy)) {
        self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
        VectorCopy(self.enemy.s.origin, self.monsterinfo.last_sighting);
        VectorCopy(self.enemy.s.origin, self.monsterinfo.blind_fire_target);
        self.monsterinfo.trail_time = level.time;
        self.monsterinfo.blind_fire_delay = 0;
      }
      // check retval to make sure we're not blindfiring -- RESTRICTED to
      // ROGUE_MONSTER_CLASSNAMES: rogue's own ai_stand does this
      // unconditionally, which would change vanilla ai_stand for every
      // classic monster; see this file's top-of-file porting note.
      else if (!retval && isRogueMonster(self)) {
        FindTarget(self);
        return;
      }
      // pmm
    } else {
      FindTarget(self);
    }
    return;
  }

  if (FindTarget(self)) return;

  if (level.time > self.monsterinfo.pausetime) {
    if (self.monsterinfo.walk) self.monsterinfo.walk(self);
    return;
  }

  if (!(self.spawnflags & 1) && self.monsterinfo.idle && level.time > self.monsterinfo.idle_time) {
    if (self.monsterinfo.idle_time) {
      self.monsterinfo.idle(self);
      self.monsterinfo.idle_time = level.time + 15 + random() * 15;
    } else {
      self.monsterinfo.idle_time = level.time + random() * 15;
    }
  }
}

/*
=============
ai_walk

The monster is walking it's beat
=============
*/
export function ai_walk(self: EdictT, dist: number): void {
  M_MoveToGoal(self, dist);

  // check for noticing a player
  if (FindTarget(self)) return;

  if (self.monsterinfo.search && level.time > self.monsterinfo.idle_time) {
    if (self.monsterinfo.idle_time) {
      self.monsterinfo.search(self);
      self.monsterinfo.idle_time = level.time + 15 + random() * 15;
    } else {
      self.monsterinfo.idle_time = level.time + random() * 15;
    }
  }
}

/*
=============
ai_charge

Turns towards target and advances
Use this call with a distnace of 0 to replace ai_face
==============
*/
export function ai_charge(self: EdictT, dist: number): void {
  // PMM - made AI_MANUAL_STEERING affect things differently here .. they turn, but
  // don't set the ideal_yaw

  // This is put in there so monsters won't move towards the origin after killing
  // a tesla. This could be problematic, so keep an eye on it.
  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  const v = vec3();

  // PMM - save blindfire target
  if (visible(self, self.enemy)) VectorCopy(self.enemy.s.origin, self.monsterinfo.blind_fire_target);
  // pmm

  if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) {
    VectorSubtract(self.enemy.s.origin, self.s.origin, v);
    self.ideal_yaw = vectoyaw(v);
  }
  M_ChangeYaw(self);
  // PMM

  if (dist) {
    if (self.monsterinfo.aiflags & AI_CHARGING) {
      M_MoveToGoal(self, dist);
      return;
    }
    // circle strafe support -- RESTRICTED to ROGUE_MONSTER_CLASSNAMES:
    // classic ai_charge never inspected attack_state at all, so this is
    // gated to avoid a classic monster coincidentally circle-strafing here
    // instead of walking straight; see this file's top-of-file porting note.
    if (self.monsterinfo.attack_state === AS_SLIDING && isRogueMonster(self)) {
      let ofs: number;
      // if we're fighting a tesla, NEVER circle strafe
      if (self.enemy !== null && self.enemy.classname === "tesla") ofs = 0;
      else if (self.monsterinfo.lefty) ofs = 90;
      else ofs = -90;

      if (M_walkmove(self, self.ideal_yaw + ofs, dist)) return;

      self.monsterinfo.lefty = 1 - self.monsterinfo.lefty;
      M_walkmove(self, self.ideal_yaw - ofs, dist);
    } else {
      M_walkmove(self, self.s.angles[YAW], dist);
    }
  }
  // PMM
}

/*
=============
ai_turn

don't move, but turn towards ideal_yaw
Distance is for slight position adjustments needed by the animations
=============
*/
export function ai_turn(self: EdictT, dist: number): void {
  if (dist) M_walkmove(self, self.s.angles[YAW], dist);

  if (FindTarget(self)) return;

  if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);
}

/*

.enemy
Will be world if not currently angry at anyone.

.movetarget
The next path spot to walk toward.  If .enemy, ignore .movetarget.
When an enemy is killed, the monster will try to return to it's path.

.hunt_time
Set to time + something when the player is in sight, but movement straight for
him is blocked.  This causes the monster to use wall following code for
movement direction instead of sighting on the player.

.ideal_yaw
A yaw angle of the intended direction, which will be turned towards at up
to 45 deg / state.  If the enemy is in view and hunt_time is not active,
this will be the exact line towards the enemy.

.pausetime
A monster will leave it's stand state and head towards it's .movetarget when
time > .pausetime.

walkmove(angle, speed) primitive is all or nothing
*/

/*
=============
range

returns the range catagorization of an entity reletive to self
0	melee range, will become hostile even if back is turned
1	visibility and infront, or visibility and show hostile
2	infront and show hostile
3	only triggered by damage
=============
*/
export function range(self: EdictT, other: EdictT): number {
  const v = vec3();
  VectorSubtract(self.s.origin, other.s.origin, v);
  const len = VectorLength(v);
  if (len < MELEE_DISTANCE) return RANGE_MELEE;
  if (len < 500) return RANGE_NEAR;
  if (len < 1000) return RANGE_MID;
  return RANGE_FAR;
}

/*
=============
visible

returns 1 if the entity is visible to self, even if not infront ()
=============
*/
export function visible(self: EdictT, other: EdictT): boolean {
  const spot1 = vec3();
  const spot2 = vec3();

  VectorCopy(self.s.origin, spot1);
  spot1[2] += self.viewheight;
  VectorCopy(other.s.origin, spot2);
  spot2[2] += other.viewheight;
  const trace = gi.trace(spot1, vec3_origin, vec3_origin, spot2, self, MASK_OPAQUE);

  // PGM -- also count a full-length trace whose endpoint entity is the
  // target itself (info_notnull-style intangible targets). RESTRICTED to
  // ROGUE_MONSTER_CLASSNAMES as the caller: this is a genuine, if narrow,
  // visibility widening versus vanilla; see this file's top-of-file porting
  // note.
  return trace.fraction === 1.0 || (isRogueMonster(self) && traceEdict(trace.ent) === other);
}

/*
=============
infront

returns 1 if the entity is in front (in sight) of self
=============
*/
export function infront(self: EdictT, other: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const vec = vec3();
  VectorSubtract(other.s.origin, self.s.origin, vec);
  VectorNormalize(vec);
  const dot = DotProduct(vec, forward);

  return dot > 0.3;
}

//============================================================================

export function HuntTarget(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return; // C assumes self->enemy is set here

  self.goalentity = enemy;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    if (self.monsterinfo.stand) self.monsterinfo.stand(self);
  } else {
    if (self.monsterinfo.run) self.monsterinfo.run(self);
  }
  const vec = vec3();
  VectorSubtract(enemy.s.origin, self.s.origin, vec);
  self.ideal_yaw = vectoyaw(vec);
  // wait a while before first attack
  if (!(self.monsterinfo.aiflags & AI_STAND_GROUND)) AttackFinished(self, 1);
}

export function FoundTarget(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return; // C assumes self->enemy is set here

  // let other monsters see this monster for a while
  if (enemy.client !== null) {
    if (enemy.flags & FL_DISGUISED) {
      enemy.flags &= ~FL_DISGUISED;
    }

    level.sight_entity = self;
    level.sight_entity_framenum = level.framenum;
    self.light_level = 128; // level.sight_entity is self here
  }

  setShowHostile(self, level.time); // wake up other monsters

  VectorCopy(enemy.s.origin, self.monsterinfo.last_sighting);
  self.monsterinfo.trail_time = level.time;
  // PMM
  VectorCopy(enemy.s.origin, self.monsterinfo.blind_fire_target);
  self.monsterinfo.blind_fire_delay = 0;
  // PMM

  if (self.combattarget === null) {
    HuntTarget(self);
    return;
  }

  const picked = G_PickTarget(self.combattarget);
  self.goalentity = picked;
  self.movetarget = picked;
  if (self.movetarget === null) {
    self.goalentity = enemy;
    self.movetarget = enemy;
    HuntTarget(self);
    gi.dprintf(`${self.classname} at ${vtos(self.s.origin)}, combattarget ${self.combattarget} not found\n`);
    return;
  }

  // clear out our combattarget, these are a one shot deal
  self.combattarget = null;
  self.monsterinfo.aiflags |= AI_COMBAT_POINT;

  // clear the targetname, that point is ours!
  self.movetarget.targetname = null;
  self.monsterinfo.pausetime = 0;

  // run for it
  if (self.monsterinfo.run) self.monsterinfo.run(self);
}

/*
===========
FindTarget

Self is currently not attacking anything, so try to find a target

Returns TRUE if an enemy was sighted

When a player fires a missile, the point of impact becomes a fakeplayer so
that monsters that see the impact will respond as if they had seen the
player.

To avoid spending too much time, only a single client (or fakeclient) is
checked each frame.  This means multi player games will have slightly
slower noticing monsters.
============
*/
export function FindTarget(self: EdictT): boolean {
  if (self.monsterinfo.aiflags & AI_GOOD_GUY) {
    const goal = self.goalentity;
    if (goal !== null && goal.inuse && goal.classname !== null) {
      if (goal.classname === "target_actor") return false;
    }

    // FIXME look for monsters?
    return false;
  }

  // if we're going to a combat point, just proceed
  if (self.monsterinfo.aiflags & AI_COMBAT_POINT) return false;

  // if the first spawnflag bit is set, the monster will only wake up on
  // really seeing the player, not another monster getting angry or hearing
  // something

  // revised behavior so they will wake up if they "see" a player make a noise
  // but not weapon impact/explosion noises

  let heardit = false;
  let client: EdictT;

  if (level.sight_entity_framenum >= level.framenum - 1 && !(self.spawnflags & 1)) {
    if (level.sight_entity === null) return false;
    if (level.sight_entity.enemy === self.enemy) return false;
    client = level.sight_entity;
  } else if (level.disguise_violation_framenum > level.framenum) {
    // ROGUE
    if (level.disguise_violator === null) return false;
    client = level.disguise_violator;
  } else if (level.sound_entity_framenum >= level.framenum - 1) {
    if (level.sound_entity === null) return false;
    client = level.sound_entity;
    heardit = true;
  } else if (
    self.enemy === null &&
    level.sound2_entity_framenum >= level.framenum - 1 &&
    !(self.spawnflags & 1)
  ) {
    if (level.sound2_entity === null) return false;
    client = level.sound2_entity;
    heardit = true;
  } else {
    if (level.sight_client === null) return false; // no clients to get mad at
    client = level.sight_client;
  }

  // if the entity went away, forget it
  if (!client.inuse) return false;

  if (client === self.enemy) return true; // JDC false;

  // PMM - hintpath coop fix
  const coopCvar = gameCvars.coop;
  if (self.monsterinfo.aiflags & AI_HINT_PATH && coopCvar !== null && coopCvar.value) {
    heardit = false;
  }
  // pmm

  if (client.client !== null) {
    if (client.flags & FL_NOTARGET) return false;
  } else if (client.svflags & SVF_MONSTER) {
    if (client.enemy === null) return false;
    if (client.enemy.flags & FL_NOTARGET) return false;
  } else if (heardit) {
    // pgm - a little more paranoia won't hurt....
    if (client.owner !== null && client.owner.flags & FL_NOTARGET) return false;
  } else {
    return false;
  }

  if (!heardit) {
    const r = range(self, client);

    if (r === RANGE_FAR) return false;

    // this is where we would check invisibility

    // is client in an spot too dark to be seen?
    if (client.light_level <= 5) return false;

    if (!visible(self, client)) {
      return false;
    }

    if (r === RANGE_NEAR) {
      if (getShowHostileUntil(client) < level.time && !infront(self, client)) {
        return false;
      }
    } else if (r === RANGE_MID) {
      if (!infront(self, client)) {
        return false;
      }
    }

    self.enemy = client;

    if (self.enemy.classname !== "player_noise") {
      self.monsterinfo.aiflags &= ~AI_SOUND_TARGET;

      if (self.enemy.client === null) {
        self.enemy = self.enemy.enemy;
        if (self.enemy === null || self.enemy.client === null) {
          self.enemy = null;
          return false;
        }
      }
    }
  } else {
    // heardit
    if (self.spawnflags & 1) {
      if (!visible(self, client)) return false;
    } else {
      if (!gi.inPHS(self.s.origin, client.s.origin)) return false;
    }

    const temp = vec3();
    VectorSubtract(client.s.origin, self.s.origin, temp);

    if (VectorLength(temp) > 1000) {
      // too far to hear
      return false;
    }

    // check area portals - if they are different and not connected then we can't hear it
    if (client.areanum !== self.areanum) {
      if (!gi.AreasConnected(self.areanum, client.areanum)) return false;
    }

    self.ideal_yaw = vectoyaw(temp);
    if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);

    // hunt the sound for a bit; hopefully find the real player
    self.monsterinfo.aiflags |= AI_SOUND_TARGET;
    self.enemy = client;
  }

  //
  // got one
  //
  // PMM - if we got an enemy, we need to bail out of hint paths, so take over here
  if (self.monsterinfo.aiflags & AI_HINT_PATH) {
    // this calls foundtarget for us
    hintpath_stop(self);
  } else {
    FoundTarget(self);
  }
  // pmm

  if (!(self.monsterinfo.aiflags & AI_SOUND_TARGET) && self.monsterinfo.sight && self.enemy !== null) {
    self.monsterinfo.sight(self, self.enemy);
  }

  return true;
}

//=============================================================================

/*
============
FacingIdeal

============
*/
export function FacingIdeal(self: EdictT): boolean {
  const delta = anglemod(self.s.angles[YAW] - self.ideal_yaw);
  if (delta > 45 && delta < 315) return false;
  return true;
}

//=============================================================================

export function M_CheckAttack(self: EdictT): boolean {
  const enemy = self.enemy;
  if (enemy === null) return false; // C assumes self->enemy is set here

  if (enemy.health > 0) {
    // see if any entities are in the way of the shot
    const spot1 = vec3();
    const spot2 = vec3();
    VectorCopy(self.s.origin, spot1);
    spot1[2] += self.viewheight;
    VectorCopy(enemy.s.origin, spot2);
    spot2[2] += enemy.viewheight;

    const tr = gi.trace(
      spot1,
      null,
      null,
      spot2,
      self,
      CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_SLIME | CONTENTS_LAVA | CONTENTS_WINDOW,
    );

    // do we have a clear shot?
    if (traceEdict(tr.ent) !== enemy) {
      // PGM - we want them to go ahead and shoot at info_notnulls if they can.
      if (enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) {
        // PMM - if we can't see our target, and we're not blocked by a monster, go into blind fire if available
        if (!(traceEdict(tr.ent).svflags & SVF_MONSTER) && !visible(self, enemy)) {
          if (self.monsterinfo.blindfire && self.monsterinfo.blind_fire_delay <= 20.0) {
            if (level.time < self.monsterinfo.attack_finished) {
              return false;
            }
            if (level.time < self.monsterinfo.trail_time + self.monsterinfo.blind_fire_delay) {
              // wait for our time
              return false;
            } else {
              // make sure we're not going to shoot a monster
              const btr = gi.trace(spot1, null, null, self.monsterinfo.blind_fire_target, self, CONTENTS_MONSTER);
              if (btr.allsolid || btr.startsolid || (btr.fraction < 1.0 && traceEdict(btr.ent) !== enemy)) {
                return false;
              }

              self.monsterinfo.attack_state = AS_BLIND;
              return true;
            }
          }
        }
        // pmm
        return false;
      }
    }
  }

  const skill = gameCvars.skill === null ? 0 : gameCvars.skill.value;

  // melee attack
  if (enemy_range === RANGE_MELEE) {
    // don't always melee in easy mode
    if (skill === 0 && Math.floor(Math.random() * 4) & 3) {
      // PMM - fix for melee only monsters & strafing
      self.monsterinfo.attack_state = AS_STRAIGHT;
      return false;
    }
    if (self.monsterinfo.melee) self.monsterinfo.attack_state = AS_MELEE;
    else self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  // missile attack
  if (!self.monsterinfo.attack) {
    // PMM - fix for melee only monsters & strafing
    self.monsterinfo.attack_state = AS_STRAIGHT;
    return false;
  }

  if (level.time < self.monsterinfo.attack_finished) return false;

  if (enemy_range === RANGE_FAR) return false;

  let chance: number;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    chance = 0.4;
  } else if (enemy_range === RANGE_MELEE) {
    chance = 0.2;
  } else if (enemy_range === RANGE_NEAR) {
    chance = 0.1;
  } else if (enemy_range === RANGE_MID) {
    chance = 0.02;
  } else {
    return false;
  }

  if (skill === 0) chance *= 0.5;
  else if (skill >= 2) chance *= 2;

  // PGM - go ahead and shoot every time if it's a info_notnull
  if (random() < chance || enemy.solid === SolidT.SOLID_NOT) {
    self.monsterinfo.attack_state = AS_MISSILE;
    self.monsterinfo.attack_finished = level.time + 2 * random();
    return true;
  }

  // PMM - daedalus/rogue-flyer strafe more, and rogue's ground monsters
  // ("SLIDING_TROOPS") occasionally strafe too -- RESTRICTED to
  // ROGUE_MONSTER_CLASSNAMES, since both replacements are ungated in the
  // shipped rogue binary and would otherwise change classic flyer/hover/
  // soldier/gunner/etc. combat feel; see this file's top-of-file porting
  // note. Classic monsters keep the base game's 0.3 FL_FLY-only chance and
  // never strafe on the ground here.
  if (self.flags & FL_FLY) {
    let strafe_chance: number;
    if (isRogueMonster(self)) {
      // originally, just 0.3
      if (self.classname === "monster_daedalus") strafe_chance = 0.8;
      else strafe_chance = 0.6;

      // if enemy is tesla, never strafe
      if (enemy.classname === "tesla") strafe_chance = 0;
    } else {
      strafe_chance = 0.3;
    }

    if (random() < strafe_chance) self.monsterinfo.attack_state = AS_SLIDING;
    else self.monsterinfo.attack_state = AS_STRAIGHT;
  } else if (isRogueMonster(self)) {
    if (random() < 0.4) self.monsterinfo.attack_state = AS_SLIDING;
    else self.monsterinfo.attack_state = AS_STRAIGHT;
  }
  //-PMM

  return false;
}

/*
=============
ai_run_melee

Turn and close until within an angle to launch a melee attack
=============
*/
export function ai_run_melee(self: EdictT): void {
  self.ideal_yaw = enemy_yaw;
  if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);

  if (FacingIdeal(self)) {
    if (self.monsterinfo.melee) self.monsterinfo.melee(self);
    self.monsterinfo.attack_state = AS_STRAIGHT;
  }
}

/*
=============
ai_run_missile

Turn in place until within an angle to launch a missile attack
=============
*/
export function ai_run_missile(self: EdictT): void {
  self.ideal_yaw = enemy_yaw;
  if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);

  if (FacingIdeal(self)) {
    if (self.monsterinfo.attack) self.monsterinfo.attack(self);
    if (self.monsterinfo.attack_state === AS_MISSILE || self.monsterinfo.attack_state === AS_BLIND) {
      self.monsterinfo.attack_state = AS_STRAIGHT;
    }
  }
}

/*
=============
ai_run_slide

Strafe sideways, but stay at aproximately the same range
=============
*/
export function ai_run_slide(self: EdictT, distanceIn: number): void {
  let distance = distanceIn;
  self.ideal_yaw = enemy_yaw;

  const angle = 90;
  let ofs: number;
  if (self.monsterinfo.lefty) ofs = angle;
  else ofs = -angle;

  if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);

  // PMM - clamp maximum sideways move for non flyers to make them look less jerky
  //
  // C: `if (!self->flags & FL_FLY)` -- an operator-precedence bug in the
  // rogue source itself (should be `if (!(self->flags & FL_FLY))`; unary
  // `!` binds tighter than `&`, so this only evaluates truthy when
  // self->flags is exactly 0, i.e. essentially never for a real monster).
  // Preserved bug-for-bug per PORTING.md rather than "fixed" to the
  // evidently-intended `!(self.flags & FL_FLY)`.
  if ((self.flags === 0 ? 1 : 0) & FL_FLY) {
    distance = Math.min(distance, MAX_SIDESTEP);
  }
  if (M_walkmove(self, self.ideal_yaw + ofs, distance)) return;
  // PMM - if we're dodging, give up on it and go straight
  if (self.monsterinfo.aiflags & AI_DODGING) {
    monster_done_dodge(self);
    // by setting as_straight, caller will know to try straight move
    self.monsterinfo.attack_state = AS_STRAIGHT;
    return;
  }

  self.monsterinfo.lefty = 1 - self.monsterinfo.lefty;
  if (M_walkmove(self, self.ideal_yaw - ofs, distance)) return;
  // PMM - if we're dodging, give up on it and go straight
  if (self.monsterinfo.aiflags & AI_DODGING) monster_done_dodge(self);

  // PMM - the move failed, so signal the caller (ai_run) to try going straight.
  // RESTRICTED to ROGUE_MONSTER_CLASSNAMES (and always-true for a dodging
  // monster, handled above): rogue's own ai_run_slide does this
  // unconditionally, which would change a classic FL_FLY monster's (flyer/
  // hover) strafe-retry behavior in the rare both-directions-blocked case;
  // see this file's top-of-file porting note.
  if (isRogueMonster(self)) self.monsterinfo.attack_state = AS_STRAIGHT;
}

/*
=============
ai_checkattack

Decides if we're going to attack or do something else
used by ai_run and ai_stand
=============
*/
export function ai_checkattack(self: EdictT, _dist: number): boolean {
  // this causes monsters to run blindly to the combat point w/o firing
  if (self.goalentity !== null) {
    if (self.monsterinfo.aiflags & AI_COMBAT_POINT) return false;

    if (self.monsterinfo.aiflags & AI_SOUND_TARGET) {
      const enemy = self.enemy;
      if (enemy !== null && level.time - enemy.teleport_time > 5.0) {
        if (self.goalentity === self.enemy) {
          if (self.movetarget !== null) self.goalentity = self.movetarget;
          else self.goalentity = null;
        }
        self.monsterinfo.aiflags &= ~AI_SOUND_TARGET;
        if (self.monsterinfo.aiflags & AI_TEMP_STAND_GROUND) {
          self.monsterinfo.aiflags &= ~(AI_STAND_GROUND | AI_TEMP_STAND_GROUND);
        }
      } else {
        setShowHostile(self, level.time);
        return false;
      }
    }
  }

  enemy_vis = false;

  // see if the enemy is dead
  let hesDeadJim = false;
  if (self.enemy === null || !self.enemy.inuse) {
    hesDeadJim = true;
  } else if (self.monsterinfo.aiflags & AI_MEDIC) {
    if (!self.enemy.inuse || self.enemy.health > 0) {
      hesDeadJim = true;
      // Classic monster_medic (not in ROGUE_MONSTER_CLASSNAMES) clears
      // AI_MEDIC right here, exactly as vanilla 3.21 does. rogue moves this
      // clear into the hesDeadJim block below (unconditionally, for every
      // hesDeadJim path) so a rogue monster's medic flag survives long
      // enough for the last_player_enemy fallback to take over; see this
      // file's top-of-file porting note.
      if (!isRogueMonster(self)) self.monsterinfo.aiflags &= ~AI_MEDIC;
    }
  } else {
    if (self.monsterinfo.aiflags & AI_BRUTAL) {
      if (self.enemy.health <= -80) hesDeadJim = true;
    } else {
      if (self.enemy.health <= 0) hesDeadJim = true;
    }
  }

  if (hesDeadJim) {
    // RESTRICTED to ROGUE_MONSTER_CLASSNAMES: rogue moves the AI_MEDIC clear
    // here unconditionally (every hesDeadJim path, not just the AI_MEDIC one
    // that set it), which could clear a classic monster_medic's AI_MEDIC
    // flag in a case (heal target freed out from under it) where vanilla
    // 3.21 leaves it set; see this file's top-of-file porting note. Classic
    // monster_medic keeps the original clear-only-in-the-AI_MEDIC-branch
    // behavior below.
    if (isRogueMonster(self)) self.monsterinfo.aiflags &= ~AI_MEDIC;
    self.enemy = null;
    // FIXME: look all around for other targets
    if (self.oldenemy !== null && self.oldenemy.health > 0) {
      self.enemy = self.oldenemy;
      self.oldenemy = null;
      HuntTarget(self);
    }
    // ROGUE - multiple teslas make monsters lose track of the player.
    else if (
      isRogueMonster(self) &&
      self.monsterinfo.last_player_enemy !== null &&
      self.monsterinfo.last_player_enemy.health > 0
    ) {
      self.enemy = self.monsterinfo.last_player_enemy;
      self.oldenemy = null;
      self.monsterinfo.last_player_enemy = null;
      HuntTarget(self);
    }
    // ROGUE
    else {
      if (self.movetarget !== null) {
        self.goalentity = self.movetarget;
        if (self.monsterinfo.walk) self.monsterinfo.walk(self);
      } else {
        // we need the pausetime otherwise the stand code
        // will just revert to walking with no target and
        // the monsters will wonder around aimlessly trying
        // to hunt the world entity
        self.monsterinfo.pausetime = level.time + 100000000;
        if (self.monsterinfo.stand) self.monsterinfo.stand(self);
      }
      return true;
    }
  }

  setShowHostile(self, level.time); // wake up other monsters

  const enemy = self.enemy;
  if (enemy === null) return false; // unreachable: every non-early-return path above leaves self.enemy set

  // check knowledge of enemy
  enemy_vis = visible(self, enemy);
  if (enemy_vis) {
    self.monsterinfo.search_time = level.time + 5;
    VectorCopy(enemy.s.origin, self.monsterinfo.last_sighting);
  }

  // look for other coop players here
  //	if (coop && self->monsterinfo.search_time < level.time)
  //	{
  //		if (FindTarget (self))
  //			return true;
  //	}

  enemy_infront = infront(self, enemy);
  enemy_range = range(self, enemy);
  const temp = vec3();
  VectorSubtract(enemy.s.origin, self.s.origin, temp);
  enemy_yaw = vectoyaw(temp);

  // JDC self->ideal_yaw = enemy_yaw;

  if (self.monsterinfo.attack_state === AS_MISSILE) {
    ai_run_missile(self);
    return true;
  }
  if (self.monsterinfo.attack_state === AS_MELEE) {
    ai_run_melee(self);
    return true;
  }

  // if enemy is not currently visible, we will never attack
  if (!enemy_vis) return false;

  return self.monsterinfo.checkattack ? self.monsterinfo.checkattack(self) : false;
}

/*
=============
ai_run

The monster has an enemy it is trying to kill
=============
*/
export function ai_run(self: EdictT, distIn: number): void {
  let dist = distIn;

  // if we're going to a combat point, just proceed
  if (self.monsterinfo.aiflags & AI_COMBAT_POINT) {
    M_MoveToGoal(self, dist);
    return;
  }

  // PMM -- inert for classic: base_height is set to maxs[2] for every
  // monster in g_monster.ts's monster_start, so this comparison only ever
  // fires for a monster that actually ducks (only rogue's duck/sidestep
  // monsters do).
  if (self.monsterinfo.aiflags & AI_DUCKED) {
    self.monsterinfo.aiflags &= ~AI_DUCKED;
  }
  if (self.maxs[2] !== self.monsterinfo.base_height) {
    monster_duck_up(self);
  }
  // pmm

  //==========
  //PGM
  // if we're currently looking for a hint path -- AI_HINT_PATH is never set
  // on a classic entity (inert).
  if (self.monsterinfo.aiflags & AI_HINT_PATH) {
    M_MoveToGoal(self, dist);
    if (!self.inuse) return; // PGM - g_touchtrigger free problem

    // first off, make sure we're looking for the player, not a noise he made
    let realEnemy: EdictT;
    if (self.enemy === null) {
      hintpath_stop(self);
      return;
    }
    if (!self.enemy.inuse) {
      self.enemy = null;
      hintpath_stop(self);
      return;
    }
    if (self.enemy.classname !== "player_noise") {
      realEnemy = self.enemy;
    } else if (self.enemy.owner !== null) {
      realEnemy = self.enemy.owner;
    } else {
      // uh oh, can't figure out enemy, bail
      self.enemy = null;
      hintpath_stop(self);
      return;
    }

    let gotcha = false;
    const coopCvar = gameCvars.coop;
    if (coopCvar !== null && coopCvar.value) {
      // if we're in coop, check my real enemy first .. if I SEE him, set gotcha to true
      if (self.enemy !== null && visible(self, realEnemy)) gotcha = true;
      // otherwise, let FindTarget bump us out of hint paths, if appropriate
      else FindTarget(self);
    } else {
      if (self.enemy !== null && visible(self, realEnemy)) gotcha = true;
    }

    // if we see the player, stop following hintpaths.
    if (gotcha) {
      // disconnect from hintpaths and start looking normally for players.
      hintpath_stop(self);
      // pmm - no longer needed, since hintpath_stop does it
    }
    return;
  }
  //PGM
  //==========

  let alreadyMoved = false;

  if (self.monsterinfo.aiflags & AI_SOUND_TARGET) {
    const v = vec3();
    // PMM - paranoia checking
    if (self.enemy !== null) VectorSubtract(self.s.origin, self.enemy.s.origin, v);

    if (self.enemy === null || VectorLength(v) < 64) {
      // pmm
      self.monsterinfo.aiflags |= AI_STAND_GROUND | AI_TEMP_STAND_GROUND;
      if (self.monsterinfo.stand) self.monsterinfo.stand(self);
      return;
    }

    M_MoveToGoal(self, dist);
    // PMM - prevent double moves for sound_targets -- RESTRICTED to
    // ROGUE_MONSTER_CLASSNAMES: skipping the second M_MoveToGoal call below
    // is an observable behavior change from vanilla 3.21's own double-move
    // quirk in this path, preserved bug-for-bug for classic monsters per
    // PORTING.md; see this file's top-of-file porting note.
    if (isRogueMonster(self)) alreadyMoved = true;
    // pmm
    if (!self.inuse) return; // PGM - g_touchtrigger free problem

    if (!FindTarget(self)) return;
  }

  // PMM -- moved ai_checkattack up here so the monsters can attack while strafing or charging
  // PMM -- if we're dodging, make sure to keep the attack_state AS_SLIDING
  const retval = ai_checkattack(self, dist);

  // PMM - don't strafe if we can't see our enemy
  if (!enemy_vis && self.monsterinfo.attack_state === AS_SLIDING) {
    self.monsterinfo.attack_state = AS_STRAIGHT;
  }
  // unless we're dodging (dodging out of view looks smart) -- AI_DODGING is
  // never set on a classic entity (inert).
  if (self.monsterinfo.aiflags & AI_DODGING) {
    self.monsterinfo.attack_state = AS_SLIDING;
  }
  // pmm

  if (self.monsterinfo.attack_state === AS_SLIDING) {
    // PMM - protect against double moves
    if (!alreadyMoved) ai_run_slide(self, dist);
    // PMM
    // we're using attack_state as the return value out of ai_run_slide to indicate whether or not the
    // move succeeded.  If the move succeeded, and we're still sliding, we're done in here (since we've
    // had our chance to shoot in ai_checkattack, and have moved).
    // if the move failed, our state is as_straight, and it will be taken care of below
    if (!retval && self.monsterinfo.attack_state === AS_SLIDING) return;
  } else if (self.monsterinfo.aiflags & AI_CHARGING) {
    // AI_CHARGING is never set on a classic entity (inert).
    self.ideal_yaw = enemy_yaw;
    if (!(self.monsterinfo.aiflags & AI_MANUAL_STEERING)) M_ChangeYaw(self);
  }
  if (retval) {
    // PMM - is this useful?  Monsters attacking usually call the ai_charge routine..
    // the only monster this affects should be the soldier
    if (
      dist !== 0 &&
      !alreadyMoved &&
      self.monsterinfo.attack_state === AS_STRAIGHT &&
      !(self.monsterinfo.aiflags & AI_STAND_GROUND)
    ) {
      M_MoveToGoal(self, dist);
    }
    if (self.enemy !== null && self.enemy.inuse && enemy_vis) {
      self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
      VectorCopy(self.enemy.s.origin, self.monsterinfo.last_sighting);
      self.monsterinfo.trail_time = level.time;
      // PMM
      VectorCopy(self.enemy.s.origin, self.monsterinfo.blind_fire_target);
      self.monsterinfo.blind_fire_delay = 0;
      // pmm
    }
    return;
  }
  // PMM

  // PGM - added a little paranoia checking here... 9/22/98
  if (self.enemy !== null && self.enemy.inuse && enemy_vis) {
    // PMM - check for alreadyMoved
    if (!alreadyMoved) M_MoveToGoal(self, dist);
    if (!self.inuse) return; // PGM - g_touchtrigger free problem

    self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
    VectorCopy(self.enemy.s.origin, self.monsterinfo.last_sighting);
    self.monsterinfo.trail_time = level.time;
    // PMM
    VectorCopy(self.enemy.s.origin, self.monsterinfo.blind_fire_target);
    self.monsterinfo.blind_fire_delay = 0;
    // pmm
    return;
  }

  //=======
  //PGM
  // if we've been looking (unsuccessfully) for the player for 10 seconds
  // PMM - reduced to 5, makes them much nastier
  //
  // monsterlost_checkhint is a no-op (returns false immediately) when there
  // are no hint_path entities on the map -- inert for every map that
  // doesn't place one.
  if (self.monsterinfo.trail_time + 5 <= level.time) {
    // and we haven't checked for valid hint paths in the last 10 seconds
    if (self.monsterinfo.last_hint_time + 10 <= level.time) {
      // check for hint_paths.
      self.monsterinfo.last_hint_time = level.time;
      if (monsterlost_checkhint(self)) return;
    }
  }
  //PGM
  //=======

  // PMM - moved down here to allow monsters to get on hint paths
  // coop will change to another enemy if visible
  const coop = gameCvars.coop === null ? 0 : gameCvars.coop.value;
  if (coop) {
    // FIXME: insane guys get mad with this, which causes crashes!
    if (FindTarget(self)) return;
  }
  // pmm

  if (self.monsterinfo.search_time && level.time > self.monsterinfo.search_time + 20) {
    // PMM - double move protection
    if (!alreadyMoved) M_MoveToGoal(self, dist);
    self.monsterinfo.search_time = 0;
    //		gi.dprintf("search timeout\n");
    return;
  }

  const save = self.goalentity;
  const tempgoal = G_Spawn();
  self.goalentity = tempgoal;

  let isNew = false;

  if (!(self.monsterinfo.aiflags & AI_LOST_SIGHT)) {
    // just lost sight of the player, decide where to go first
    self.monsterinfo.aiflags |= AI_LOST_SIGHT | AI_PURSUIT_LAST_SEEN;
    self.monsterinfo.aiflags &= ~(AI_PURSUE_NEXT | AI_PURSUE_TEMP);
    isNew = true;
  }

  if (self.monsterinfo.aiflags & AI_PURSUE_NEXT) {
    self.monsterinfo.aiflags &= ~AI_PURSUE_NEXT;

    // give ourself more time since we got this far
    self.monsterinfo.search_time = level.time + 5;

    let marker: EdictT | null;
    if (self.monsterinfo.aiflags & AI_PURSUE_TEMP) {
      self.monsterinfo.aiflags &= ~AI_PURSUE_TEMP;
      marker = null;
      VectorCopy(self.monsterinfo.saved_goal, self.monsterinfo.last_sighting);
      isNew = true;
    } else if (self.monsterinfo.aiflags & AI_PURSUIT_LAST_SEEN) {
      self.monsterinfo.aiflags &= ~AI_PURSUIT_LAST_SEEN;
      marker = PlayerTrail_PickFirst(self);
    } else {
      marker = PlayerTrail_PickNext(self);
    }

    if (marker !== null) {
      VectorCopy(marker.s.origin, self.monsterinfo.last_sighting);
      self.monsterinfo.trail_time = marker.timestamp;
      self.s.angles[YAW] = self.ideal_yaw = marker.s.angles[YAW];
      isNew = true;
    }
  }

  const v = vec3();
  VectorSubtract(self.s.origin, self.monsterinfo.last_sighting, v);
  let d1 = VectorLength(v);
  if (d1 <= dist) {
    self.monsterinfo.aiflags |= AI_PURSUE_NEXT;
    dist = d1;
  }

  VectorCopy(self.monsterinfo.last_sighting, tempgoal.s.origin);

  if (isNew) {
    let tr = gi.trace(self.s.origin, self.mins, self.maxs, self.monsterinfo.last_sighting, self, MASK_PLAYERSOLID);
    if (tr.fraction < 1) {
      VectorSubtract(tempgoal.s.origin, self.s.origin, v);
      d1 = VectorLength(v);
      let center = tr.fraction;
      const d2 = d1 * ((center + 1) / 2);
      self.s.angles[YAW] = self.ideal_yaw = vectoyaw(v);
      const v_forward = vec3();
      const v_right = vec3();
      AngleVectors(self.s.angles, v_forward, v_right, null);

      const proj = vec3();
      const left_target = vec3();
      const right_target = vec3();

      VectorSet(proj, d2, -16, 0);
      G_ProjectSource(self.s.origin, proj, v_forward, v_right, left_target);
      tr = gi.trace(self.s.origin, self.mins, self.maxs, left_target, self, MASK_PLAYERSOLID);
      const left = tr.fraction;

      VectorSet(proj, d2, 16, 0);
      G_ProjectSource(self.s.origin, proj, v_forward, v_right, right_target);
      tr = gi.trace(self.s.origin, self.mins, self.maxs, right_target, self, MASK_PLAYERSOLID);
      const right = tr.fraction;

      center = (d1 * center) / d2;
      if (left >= center && left > right) {
        if (left < 1) {
          VectorSet(proj, d2 * left * 0.5, -16, 0);
          G_ProjectSource(self.s.origin, proj, v_forward, v_right, left_target);
        }
        VectorCopy(self.monsterinfo.last_sighting, self.monsterinfo.saved_goal);
        self.monsterinfo.aiflags |= AI_PURSUE_TEMP;
        VectorCopy(left_target, tempgoal.s.origin);
        VectorCopy(left_target, self.monsterinfo.last_sighting);
        VectorSubtract(tempgoal.s.origin, self.s.origin, v);
        self.s.angles[YAW] = self.ideal_yaw = vectoyaw(v);
      } else if (right >= center && right > left) {
        if (right < 1) {
          VectorSet(proj, d2 * right * 0.5, 16, 0);
          G_ProjectSource(self.s.origin, proj, v_forward, v_right, right_target);
        }
        VectorCopy(self.monsterinfo.last_sighting, self.monsterinfo.saved_goal);
        self.monsterinfo.aiflags |= AI_PURSUE_TEMP;
        VectorCopy(right_target, tempgoal.s.origin);
        VectorCopy(right_target, self.monsterinfo.last_sighting);
        VectorSubtract(tempgoal.s.origin, self.s.origin, v);
        self.s.angles[YAW] = self.ideal_yaw = vectoyaw(v);
      }
    }
    //		else gi.dprintf("course was fine\n");
  }

  M_MoveToGoal(self, dist);
  if (!self.inuse) return; // PGM - g_touchtrigger free problem

  G_FreeEdict(tempgoal);

  self.goalentity = save;
}
