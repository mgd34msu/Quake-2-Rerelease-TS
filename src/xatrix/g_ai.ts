// g_ai.c

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
import { type Edict, SVF_MONSTER } from "./game";
import {
  AI_BRUTAL,
  AI_COMBAT_POINT,
  AI_GOOD_GUY,
  AI_LOST_SIGHT,
  AI_MEDIC,
  AI_PURSUE_NEXT,
  AI_PURSUE_TEMP,
  AI_PURSUIT_LAST_SEEN,
  AI_SOUND_TARGET,
  AI_STAND_GROUND,
  AI_TEMP_STAND_GROUND,
  AS_MELEE,
  AS_MISSILE,
  AS_SLIDING,
  AS_STRAIGHT,
  type EdictT,
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
import { AttackFinished } from "./g_monster";
import { G_FreeEdict, G_PickTarget, G_ProjectSource, G_Spawn, vectoyaw, vtos } from "./g_utils";
import { M_ChangeYaw, M_MoveToGoal, M_walkmove } from "./m_move";
import { PlayerTrail_PickFirst, PlayerTrail_PickNext } from "./p_trail";

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
    if (ent.inuse && ent.health > 0 && !(ent.flags & FL_NOTARGET)) {
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
      M_ChangeYaw(self);
      ai_checkattack(self, 0);
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
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const v = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, v);
  self.ideal_yaw = vectoyaw(v);
  M_ChangeYaw(self);

  if (dist) M_walkmove(self, self.s.angles[YAW], dist);
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

  M_ChangeYaw(self);
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

  return trace.fraction === 1.0;
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
    level.sight_entity = self;
    level.sight_entity_framenum = level.framenum;
    self.light_level = 128; // level.sight_entity is self here
  }

  setShowHostile(self, level.time); // wake up other monsters

  VectorCopy(enemy.s.origin, self.monsterinfo.last_sighting);
  self.monsterinfo.trail_time = level.time;

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

  if (client.client !== null) {
    if (client.flags & FL_NOTARGET) return false;
  } else if (client.svflags & SVF_MONSTER) {
    if (client.enemy === null) return false;
    if (client.enemy.flags & FL_NOTARGET) return false;
  } else if (heardit) {
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
    M_ChangeYaw(self);

    // hunt the sound for a bit; hopefully find the real player
    self.monsterinfo.aiflags |= AI_SOUND_TARGET;
    self.enemy = client;
  }

  //
  // got one
  //
  FoundTarget(self);

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
    if (traceEdict(tr.ent) !== enemy) return false;
  }

  const skill = gameCvars.skill === null ? 0 : gameCvars.skill.value;

  // melee attack
  if (enemy_range === RANGE_MELEE) {
    // don't always melee in easy mode
    if (skill === 0 && Math.floor(Math.random() * 4) & 3) return false;
    if (self.monsterinfo.melee) self.monsterinfo.attack_state = AS_MELEE;
    else self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  // missile attack
  if (!self.monsterinfo.attack) return false;

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

  if (random() < chance) {
    self.monsterinfo.attack_state = AS_MISSILE;
    self.monsterinfo.attack_finished = level.time + 2 * random();
    return true;
  }

  if (self.flags & FL_FLY) {
    if (random() < 0.3) self.monsterinfo.attack_state = AS_SLIDING;
    else self.monsterinfo.attack_state = AS_STRAIGHT;
  }

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
  M_ChangeYaw(self);

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
  M_ChangeYaw(self);

  if (FacingIdeal(self)) {
    if (self.monsterinfo.attack) self.monsterinfo.attack(self);
    self.monsterinfo.attack_state = AS_STRAIGHT;
  }
}

/*
=============
ai_run_slide

Strafe sideways, but stay at aproximately the same range
=============
*/
export function ai_run_slide(self: EdictT, distance: number): void {
  self.ideal_yaw = enemy_yaw;
  M_ChangeYaw(self);

  const ofs = self.monsterinfo.lefty ? 90 : -90;

  if (M_walkmove(self, self.ideal_yaw + ofs, distance)) return;

  self.monsterinfo.lefty = 1 - self.monsterinfo.lefty;
  M_walkmove(self, self.ideal_yaw - ofs, distance);
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
    if (self.enemy.health > 0) {
      hesDeadJim = true;
      self.monsterinfo.aiflags &= ~AI_MEDIC;
    }
  } else {
    if (self.monsterinfo.aiflags & AI_BRUTAL) {
      if (self.enemy.health <= -80) hesDeadJim = true;
    } else {
      if (self.enemy.health <= 0) hesDeadJim = true;
    }
  }

  if (hesDeadJim) {
    self.enemy = null;
    // FIXME: look all around for other targets
    if (self.oldenemy !== null && self.oldenemy.health > 0) {
      self.enemy = self.oldenemy;
      self.oldenemy = null;
      HuntTarget(self);
    } else {
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

  if (self.monsterinfo.aiflags & AI_SOUND_TARGET) {
    if (self.enemy !== null) {
      const v = vec3();
      VectorSubtract(self.s.origin, self.enemy.s.origin, v);
      if (VectorLength(v) < 64) {
        self.monsterinfo.aiflags |= AI_STAND_GROUND | AI_TEMP_STAND_GROUND;
        if (self.monsterinfo.stand) self.monsterinfo.stand(self);
        return;
      }
    }

    M_MoveToGoal(self, dist);

    if (!FindTarget(self)) return;
  }

  if (ai_checkattack(self, dist)) return;

  if (self.monsterinfo.attack_state === AS_SLIDING) {
    ai_run_slide(self, dist);
    return;
  }

  if (enemy_vis) {
    //		if (self.aiflags & AI_LOST_SIGHT)
    //			dprint("regained sight\n");
    M_MoveToGoal(self, dist);
    self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
    if (self.enemy !== null) VectorCopy(self.enemy.s.origin, self.monsterinfo.last_sighting);
    self.monsterinfo.trail_time = level.time;
    return;
  }

  // coop will change to another enemy if visible
  const coop = gameCvars.coop === null ? 0 : gameCvars.coop.value;
  if (coop) {
    // FIXME: insane guys get mad with this, which causes crashes!
    if (FindTarget(self)) return;
  }

  if (self.monsterinfo.search_time && level.time > self.monsterinfo.search_time + 20) {
    M_MoveToGoal(self, dist);
    self.monsterinfo.search_time = 0;
    //		dprint("search timeout\n");
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

  G_FreeEdict(tempgoal);

  self.goalentity = save;
}
