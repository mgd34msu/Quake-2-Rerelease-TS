// g_newai.c
//
// Rogue-specific AI helpers: the "blocked" family (monster interrupts its
// current move to shoot, trigger a plat, or jump a gap), hint paths (scripted
// monster travel routes), bad-area markers (tesla no-go zones), predictive
// aiming, ducking/dodging, and coop helpers. Everything here is live C code
// -- this file has no `#ifdef`-gated dead sections.
//
// `monster_fire_blaster2`/`monster_fire_tracker`/`monster_fire_heat`/
// `stationarymonster_start`/`monster_done_dodge` are grouped with this
// file's prototypes in g_local.h but are actually DEFINED in g_monster.c
// (confirmed by grep across the rogue source tree) -- only
// `monster_done_dodge` is called from here (in M_MonsterDodge), imported
// from "./g_monster" rather than redefined.

import {
  AngleVectors,
  DotProduct,
  random,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
  type Vec3,
} from "../shared/math";
import {
  AREA_TRIGGERS,
  type CplaneT,
  type CsurfaceT,
  MASK_MONSTERSOLID,
  MASK_SHOT,
  MASK_SOLID,
  MASK_WATER,
  MAX_EDICTS,
  MulticastT,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { type Edict, type GTraceT, SolidT, SVF_NOCLIENT } from "./game";
import {
  AI_BLOCKED,
  AI_DODGING,
  AI_DUCKED,
  AI_HOLD_FRAME,
  AI_HINT_PATH,
  AI_MEDIC,
  AI_PURSUE_NEXT,
  AI_PURSUE_TEMP,
  AI_PURSUIT_LAST_SEEN,
  AI_SOUND_TARGET,
  AI_STAND_GROUND,
  AS_SLIDING,
  DamageT,
  DUCK_INTERVAL,
  type EdictT,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  gi,
  level,
  MovetypeT,
  svc_temp_entity,
  world,
} from "./g_local";
import { FoundTarget, HuntTarget, visible } from "./g_ai";
import { G_Find, G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles2, vtos } from "./g_utils";
import { M_ChangeYaw } from "./m_move";
import { cleanupHealTarget } from "./g_combat";
import { monster_done_dodge } from "./g_monster";
import { parasite_drain_attack_ok } from "./m_parasite";

// plat states, copied from g_func.c
const STATE_TOP = 0;
const STATE_BOTTOM = 1;

function requireEnemy(self: EdictT, what: string): EdictT {
  if (self.enemy === null) {
    throw new Error(`${what}: self.enemy is null (C dereferences it unconditionally here)`);
  }
  return self.enemy;
}

// recovers the full game-side EdictT from a server-visible Edict (trace
// results, BoxEdicts results), mirroring g_utils.ts's G_TouchTriggers idiom
// -- never a cast, per PORTING.md.
function recoverEdict(e: Edict | null): EdictT | null {
  if (e === null) return null;
  const full = g_edicts[e.s.number];
  return full === undefined ? null : full;
}

//===============================
// BLOCKED Logic
//===============================

// blocked_checkshot
//	shotchance: 0-1, chance they'll take the shot if it's clear.
export function blocked_checkshot(self: EdictT, shotChance: number): boolean {
  if (self.enemy === null) return false;

  // blocked checkshot is only against players. this will
  // filter out player sounds and other shit they should
  // not be firing at.
  if (self.enemy.client === null) return false;

  if (random() < shotChance) return false;

  // PMM - special handling for the parasite
  if (self.classname === "monster_parasite") {
    const f = vec3();
    const r = vec3();
    const offset = vec3();
    const start = vec3();
    let end = vec3();
    AngleVectors(self.s.angles, f, r, null);
    VectorSet(offset, 24, 0, 6);
    G_ProjectSource(self.s.origin, offset, f, r, start);

    VectorCopy(self.enemy.s.origin, end);
    if (!parasite_drain_attack_ok(start, end)) {
      end[2] = self.enemy.s.origin[2]! + self.enemy.maxs[2]! - 8;
      if (!parasite_drain_attack_ok(start, end)) {
        end[2] = self.enemy.s.origin[2]! + self.enemy.mins[2]! + 8;
        if (!parasite_drain_attack_ok(start, end)) return false;
      }
    }
    VectorCopy(self.enemy.s.origin, end);

    const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
    if (tr.ent !== self.enemy) {
      self.monsterinfo.aiflags |= AI_BLOCKED;

      if (self.monsterinfo.attack) self.monsterinfo.attack(self);

      self.monsterinfo.aiflags &= ~AI_BLOCKED;
      return true;
    }
  }

  const playerVisible = visible(self, self.enemy);
  // always shoot at teslas
  if (playerVisible) {
    if (self.enemy.classname === "tesla") {
      // turn on AI_BLOCKED to let the monster know the attack is being called
      // by the blocked functions...
      self.monsterinfo.aiflags |= AI_BLOCKED;

      if (self.monsterinfo.attack) self.monsterinfo.attack(self);

      self.monsterinfo.aiflags &= ~AI_BLOCKED;
      return true;
    }
  }

  return false;
}

// blocked_checkplat
//	dist: how far they are trying to walk.
export function blocked_checkplat(self: EdictT, dist: number): boolean {
  if (self.enemy === null) return false;

  // check player's relative altitude
  let playerPosition: number;
  if (self.enemy.absmin[2]! >= self.absmax[2]!) playerPosition = 1;
  else if (self.enemy.absmax[2]! <= self.absmin[2]!) playerPosition = -1;
  else playerPosition = 0;

  // if we're close to the same position, don't bother trying plats.
  if (playerPosition === 0) return false;

  let plat: EdictT | null = null;

  // see if we're already standing on a plat.
  if (self.groundentity !== null && self.groundentity !== world()) {
    if (self.groundentity.classname !== null && self.groundentity.classname.startsWith("func_plat")) {
      plat = self.groundentity;
    }
  }

  // if we're not, check to see if we'll step onto one with this move
  if (plat === null) {
    const forward = vec3();
    AngleVectors(self.s.angles, forward, null, null);
    const pt1 = vec3();
    VectorMA(self.s.origin, dist, forward, pt1);
    const pt2 = vec3();
    VectorCopy(pt1, pt2);
    pt2[2] -= 384;

    const trace = gi.trace(pt1, vec3_origin, vec3_origin, pt2, self, MASK_MONSTERSOLID);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid) {
      const hit = recoverEdict(trace.ent);
      if (hit !== null && hit.classname !== null && hit.classname.startsWith("func_plat")) {
        plat = hit;
      }
    }
  }

  // if we've found a plat, trigger it.
  if (plat !== null && plat.use !== null) {
    if (playerPosition === 1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === STATE_BOTTOM) ||
        (self.groundentity !== plat && plat.moveinfo.state === STATE_TOP)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    } else if (playerPosition === -1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === STATE_TOP) ||
        (self.groundentity !== plat && plat.moveinfo.state === STATE_BOTTOM)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    }
  }

  return false;
}

// blocked_checkjump
//	dist: how far they are trying to walk.
//  maxDown/maxUp: how far they'll ok a jump for. set to 0 to disable that direction.
export function blocked_checkjump(self: EdictT, dist: number, maxDown: number, maxUp: number): boolean {
  if (self.enemy === null) return false;

  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);

  let playerPosition: number;
  if (self.enemy.absmin[2]! > self.absmin[2]! + 16) playerPosition = 1;
  else if (self.enemy.absmin[2]! < self.absmin[2]! - 16) playerPosition = -1;
  else playerPosition = 0;

  if (playerPosition === -1 && maxDown) {
    // check to make sure we can even get to the spot we're going to "fall" from
    const pt1 = vec3();
    VectorMA(self.s.origin, 48, forward, pt1);
    let trace = gi.trace(self.s.origin, self.mins, self.maxs, pt1, self, MASK_MONSTERSOLID);
    if (trace.fraction < 1) {
      return false;
    }

    const pt2 = vec3();
    VectorCopy(pt1, pt2);
    pt2[2] = self.mins[2]! - maxDown - 1;

    trace = gi.trace(pt1, vec3_origin, vec3_origin, pt2, self, MASK_MONSTERSOLID | MASK_WATER);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid) {
      if (self.absmin[2]! - trace.endpos[2]! >= 24 && trace.contents & MASK_SOLID) {
        if (self.enemy.absmin[2]! - trace.endpos[2]! > 32) {
          return false;
        }

        if (trace.plane.normal[2]! < 0.9) {
          return false;
        }
        return true;
      }
    }
  } else if (playerPosition === 1 && maxUp) {
    const pt1 = vec3();
    VectorMA(self.s.origin, 48, forward, pt1);
    const pt2 = vec3();
    VectorCopy(pt1, pt2);
    pt1[2] = self.absmax[2]! + maxUp;

    const trace = gi.trace(pt1, vec3_origin, vec3_origin, pt2, self, MASK_MONSTERSOLID | MASK_WATER);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid) {
      if (trace.endpos[2]! - self.absmin[2]! <= maxUp && trace.contents & MASK_SOLID) {
        face_wall(self);
        return true;
      }
    }
  }

  return false;
}

// checks to see if another coop player is nearby, and will switch.
// C body is entirely `#if 0`-style commented out and always `return false;`
// -- preserved as dead code in a comment, matching the C exactly.
export function blocked_checknewenemy(_self: EdictT): boolean {
  /*
  if (!coop->value) return false;
  for (player = 1; player <= game.maxclients; player++) {
    ent = &g_edicts[player];
    if (!ent->inuse) continue;
    if (!ent->client) continue;
    if (ent == self->enemy) continue;
    if (visible(self, ent)) {
      self->enemy = ent;
      FoundTarget(self);
      return true;
    }
  }
  return false;
  */
  return false;
}

// *************************
// HINT PATHS
// *************************

const HINT_ENDPOINT = 0x0001;
const MAX_HINT_CHAINS = 100;

let hint_paths_present = 0;
let hint_path_start: (EdictT | null)[] = new Array<EdictT | null>(MAX_HINT_CHAINS).fill(null);
let num_hint_paths = 0;

//
// AI code
//

// hintpath_findstart - given any hintpath node, finds the start node
export function hintpath_findstart(ent: EdictT): EdictT | null {
  let last: EdictT;
  let e: EdictT | null;

  if (ent.target) {
    // starting point
    last = world();
    e = G_Find(null, "targetname", ent.target);
    while (e !== null) {
      last = e;
      if (!e.target) break;
      e = G_Find(null, "targetname", e.target);
    }
  } else {
    // end point
    last = world();
    e = G_Find(null, "target", ent.targetname ?? "");
    while (e !== null) {
      last = e;
      if (!e.targetname) break;
      e = G_Find(null, "target", e.targetname);
    }
  }

  if (!(last.spawnflags & HINT_ENDPOINT)) {
    return null;
  }

  if (last === world()) return null;
  return last;
}

// hintpath_other_end - given one endpoint of a hintpath, returns the other end.
export function hintpath_other_end(ent: EdictT): EdictT | null {
  let last: EdictT;
  let e: EdictT | null;

  if (ent.target) {
    // starting point
    last = world();
    e = G_Find(null, "targetname", ent.target);
    while (e !== null) {
      last = e;
      if (!e.target) break;
      e = G_Find(null, "targetname", e.target);
    }
  } else {
    // end point
    last = world();
    e = G_Find(null, "target", ent.targetname ?? "");
    while (e !== null) {
      last = e;
      if (!e.targetname) break;
      e = G_Find(null, "target", e.targetname);
    }
  }

  if (!(last.spawnflags & HINT_ENDPOINT)) {
    return null;
  }

  if (last === world()) return null;
  return last;
}

// hintpath_go - starts a monster (self) moving towards the hintpath (point)
//		disables all contrary AI flags.
export function hintpath_go(self: EdictT, point: EdictT): void {
  const dir = vec3();
  const angles = vec3();
  VectorSubtract(point.s.origin, self.s.origin, dir);
  vectoangles2(dir, angles);

  self.ideal_yaw = angles[YAW]!;
  self.goalentity = self.movetarget = point;
  self.monsterinfo.pausetime = 0;
  self.monsterinfo.aiflags |= AI_HINT_PATH;
  self.monsterinfo.aiflags &= ~(AI_SOUND_TARGET | AI_PURSUIT_LAST_SEEN | AI_PURSUE_NEXT | AI_PURSUE_TEMP);
  // run for it
  self.monsterinfo.search_time = level.time;
  if (self.monsterinfo.run) self.monsterinfo.run(self);
}

// hintpath_stop - bails a monster out of following hint paths
export function hintpath_stop(self: EdictT): void {
  self.goalentity = null;
  self.movetarget = null;
  self.monsterinfo.last_hint_time = level.time;
  self.monsterinfo.goal_hint = null;
  self.monsterinfo.aiflags &= ~AI_HINT_PATH;
  if (has_valid_enemy(self)) {
    // if we can see our target, go nuts
    if (self.enemy !== null && visible(self, self.enemy)) {
      FoundTarget(self);
      return;
    }
    // otherwise, keep chasing
    HuntTarget(self);
    return;
  }
  // if our enemy is no longer valid, forget about our enemy and go into stand
  self.enemy = null;
  // we need the pausetime otherwise the stand code
  // will just revert to walking with no target and
  // the monsters will wonder around aimlessly trying
  // to hunt the world entity
  self.monsterinfo.pausetime = level.time + 100000000;
  if (self.monsterinfo.stand) self.monsterinfo.stand(self);
}

// monsterlost_checkhint - the monster (self) will check around for valid hintpaths.
//		a valid hintpath is one where the two endpoints can see both the monster
//		and the monster's enemy. if only one person is visible from the endpoints,
//		it will not go for it.
export function monsterlost_checkhint(self: EdictT): boolean {
  // if there are no hint paths on this map, exit immediately.
  if (!hint_paths_present) return false;

  if (self.enemy === null) return false;

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) return false;

  if (self.classname === "monster_turret") return false;

  let monster_pathchain: EdictT | null = null;
  let checkpoint: EdictT | null = null;

  // find all the hint_paths.
  // FIXME - can we not do this every time?
  for (let i = 0; i < num_hint_paths; i++) {
    let e = hint_path_start[i] ?? null;
    while (e !== null) {
      if (e.monster_hint_chain !== null) {
        e.monster_hint_chain = null;
      }
      if (monster_pathchain !== null) {
        checkpoint!.monster_hint_chain = e;
        checkpoint = e;
      } else {
        monster_pathchain = e;
        checkpoint = e;
      }
      e = e.hint_chain;
    }
  }

  // filter them by distance and visibility to the monster
  let e: EdictT | null = monster_pathchain;
  checkpoint = null;
  let count5 = 0;
  while (e !== null) {
    const r = realrange(self, e);

    if (r > 512) {
      if (checkpoint !== null) {
        checkpoint.monster_hint_chain = e.monster_hint_chain;
        e.monster_hint_chain = null;
        e = checkpoint.monster_hint_chain;
        continue;
      } else {
        // use checkpoint as temp pointer
        checkpoint = e;
        e = e.monster_hint_chain;
        checkpoint.monster_hint_chain = null;
        // and clear it again
        checkpoint = null;
        // since we have yet to find a valid one (or else checkpoint would be set) move the
        // start of monster_pathchain
        monster_pathchain = e;
        continue;
      }
    }
    if (!visible(self, e)) {
      if (checkpoint !== null) {
        checkpoint.monster_hint_chain = e.monster_hint_chain;
        e.monster_hint_chain = null;
        e = checkpoint.monster_hint_chain;
        continue;
      } else {
        // use checkpoint as temp pointer
        checkpoint = e;
        e = e.monster_hint_chain;
        checkpoint.monster_hint_chain = null;
        // and clear it again
        checkpoint = null;
        monster_pathchain = e;
        continue;
      }
    }
    // if it passes all the tests, it's a keeper
    count5++;
    checkpoint = e;
    e = e.monster_hint_chain;
  }

  // at this point, we have a list of all of the eligible hint nodes for the monster
  // we now take them, figure out what hint chains they're on, and traverse down those chains,
  // seeing whether any can see the player
  //
  // first, we figure out which hint chains we have represented in monster_pathchain
  if (count5 === 0) {
    return false;
  }

  const hint_path_represented: boolean[] = new Array<boolean>(MAX_HINT_CHAINS).fill(false);
  e = monster_pathchain;
  checkpoint = null;
  while (e !== null) {
    if (e.hint_chain_id < 0 || e.hint_chain_id > num_hint_paths) {
      return false;
    }
    hint_path_represented[e.hint_chain_id] = true;
    e = e.monster_hint_chain;
  }

  // now, build the target_pathchain which contains all of the hint_path nodes we need to check for
  // validity (within range, visibility)
  let target_pathchain: EdictT | null = null;
  checkpoint = null;
  for (let i = 0; i < num_hint_paths; i++) {
    // if this hint chain is represented in the monster_hint_chain, add all of it's nodes to the target_pathchain
    // for validity checking
    if (hint_path_represented[i]) {
      let ee = hint_path_start[i] ?? null;
      while (ee !== null) {
        if (target_pathchain !== null) {
          checkpoint!.target_hint_chain = ee;
          checkpoint = ee;
        } else {
          target_pathchain = ee;
          checkpoint = ee;
        }
        ee = ee.hint_chain;
      }
    }
  }

  // target_pathchain is a list of all of the hint_path nodes we need to check for validity relative to the target
  e = target_pathchain;
  checkpoint = null;
  const enemy = requireEnemy(self, "monsterlost_checkhint");
  while (e !== null) {
    const r = realrange(enemy, e);

    if (r > 512) {
      if (checkpoint !== null) {
        checkpoint.target_hint_chain = e.target_hint_chain;
        e.target_hint_chain = null;
        e = checkpoint.target_hint_chain;
        continue;
      } else {
        checkpoint = e;
        e = e.target_hint_chain;
        checkpoint.target_hint_chain = null;
        checkpoint = null;
        target_pathchain = e;
        continue;
      }
    }
    if (!visible(enemy, e)) {
      if (checkpoint !== null) {
        checkpoint.target_hint_chain = e.target_hint_chain;
        e.target_hint_chain = null;
        e = checkpoint.target_hint_chain;
        continue;
      } else {
        checkpoint = e;
        e = e.target_hint_chain;
        checkpoint.target_hint_chain = null;
        checkpoint = null;
        target_pathchain = e;
        continue;
      }
    }
    // if it passes all the tests, it's a keeper
    count5++;
    checkpoint = e;
    e = e.target_hint_chain;
  }

  // at this point we should have:
  // monster_pathchain - a list of "monster valid" hint_path nodes linked together by monster_hint_chain
  // target_pathcain - a list of "target valid" hint_path nodes linked together by target_hint_chain.  these
  //                   are filtered such that only nodes which are on the same chain as "monster valid" nodes
  //
  // Now, we figure out which "monster valid" node we want to use
  //
  // To do this, we first off make sure we have some target nodes.  If we don't, there are no valid hint_path nodes
  // for us to take
  //
  // If we have some, we filter all of our "monster valid" nodes by which ones have "target valid" nodes on them
  //
  // Once this filter is finished, we select the closest "monster valid" node, and go to it.

  if (count5 === 0) {
    return false;
  }

  // reuse the hint_chain_represented array, this time to see which chains are represented by the target
  for (let i = 0; i < num_hint_paths; i++) {
    hint_path_represented[i] = false;
  }

  e = target_pathchain;
  checkpoint = null;
  while (e !== null) {
    if (e.hint_chain_id < 0 || e.hint_chain_id > num_hint_paths) {
      return false;
    }
    hint_path_represented[e.hint_chain_id] = true;
    e = e.target_hint_chain;
  }

  // traverse the monster_pathchain - if the hint_node isn't represented in the "target valid" chain list,
  // remove it
  // if it is on the list, check it for range from the monster.  If the range is the closest, keep it
  //
  let closest: EdictT | null = null;
  let closest_range = 1000000;
  e = monster_pathchain;
  while (e !== null) {
    if (!hint_path_represented[e.hint_chain_id]) {
      checkpoint = e.monster_hint_chain;
      e.monster_hint_chain = null;
      e = checkpoint;
      continue;
    }
    const r = realrange(self, e);
    if (r < closest_range) closest = e;
    e = e.monster_hint_chain;
  }

  if (closest === null) {
    return false;
  }

  const start = closest;
  // now we know which one is the closest to the monster .. this is the one the monster will go to
  // we need to finally determine what the DESTINATION node is for the monster .. walk down the hint_chain,
  // and find the closest one to the player

  closest = null;
  closest_range = 10000000;
  e = target_pathchain;
  while (e !== null) {
    if (start.hint_chain_id === e.hint_chain_id) {
      const r = realrange(self, e);
      if (r < closest_range) closest = e;
    }
    e = e.target_hint_chain;
  }

  if (closest === null) {
    return false;
  }

  const destination = closest;

  self.monsterinfo.goal_hint = destination;
  hintpath_go(self, start);

  return true;
}

//
// Path code
//

// hint_path_touch - someone's touched the hint_path
export function hint_path_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  let goalFound = false;

  // make sure we're the target of it's obsession
  if (other.movetarget === self) {
    const goal = other.monsterinfo.goal_hint;

    // if the monster is where he wants to be
    if (goal === self) {
      hintpath_stop(other);
      return;
    } else {
      // uninitialized in C (`edict_t *next;`, no default) -- the while loop
      // below always runs since `self` is on its own hint chain, so `next`
      // is always assigned before use in practice; `null` is a safe TS
      // default where C left it garbage.
      let next: EdictT | null = null;

      // figure out which way we want to go
      let e = hint_path_start[self.hint_chain_id] ?? null;
      while (e !== null) {
        // if we get up to ourselves on the hint chain, we're going down it
        if (e === self) {
          next = e.hint_chain;
          break;
        }
        if (e === goal) goalFound = true;
        // if we get to where the next link on the chain is this hint_path and have found the goal on the way
        // we're going upstream, so remember who the previous link is
        if (e.hint_chain === self && goalFound) {
          next = e;
          break;
        }
        e = e.hint_chain;
      }

      // if we couldn't find it, have the monster go back to normal hunting.
      if (next === null) {
        hintpath_stop(other);
        return;
      }

      // set the last_hint entry to this hint_path, and
      // send him on his way
      hintpath_go(other, next);

      // have the monster freeze if the hint path we just touched has a wait time
      // on it, for example, when riding a plat.
      if (self.wait) {
        other.nextthink = level.time + self.wait;
      }
    }
  }
}

export function SP_hint_path(self: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }

  if (!self.targetname && !self.target) {
    gi.dprintf(`unlinked hint_path at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = hint_path_touch;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);
  self.svflags |= SVF_NOCLIENT;
  gi.linkentity(self);
}

// InitHintPaths - Called by InitGame (g_save) to enable quick exits if valid
export function InitHintPaths(): void {
  hint_paths_present = 0;

  // check all the hint_paths.
  let e = G_Find(null, "classname", "hint_path");
  if (e !== null) {
    hint_paths_present = 1;
  } else {
    return;
  }

  hint_path_start = new Array<EdictT | null>(MAX_HINT_CHAINS).fill(null);
  num_hint_paths = 0;
  while (e !== null) {
    if (e.spawnflags & HINT_ENDPOINT) {
      if (e.target) {
        // start point
        if (e.targetname) {
          // this is a bad end, ignore it
          gi.dprintf(
            `Hint path at ${vtos(e.s.origin)} marked as endpoint with both target (${e.target}) and targetname (${e.targetname})\n`,
          );
        } else {
          if (num_hint_paths >= MAX_HINT_CHAINS) {
            break;
          }
          hint_path_start[num_hint_paths++] = e;
        }
      }
    }
    e = G_Find(e, "classname", "hint_path");
  }

  for (let i = 0; i < num_hint_paths; i++) {
    let current = hint_path_start[i];
    if (current === undefined || current === null) continue;
    current.hint_chain_id = i;
    let ee = G_Find(null, "targetname", current.target ?? "");
    if (G_Find(ee, "targetname", current.target ?? "") !== null) {
      gi.dprintf(`\nForked hint path at ${vtos(current.s.origin)} detected for chain ${num_hint_paths}, target ${current.target}\n`);
      current.hint_chain = null;
      continue;
    }
    while (ee !== null) {
      if (ee.hint_chain !== null) {
        gi.dprintf(
          `\nCircular hint path at ${vtos(ee.s.origin)} detected for chain ${num_hint_paths}, targetname ${ee.targetname}\n`,
        );
        current.hint_chain = null;
        break;
      }
      current.hint_chain = ee;
      current = ee;
      current.hint_chain_id = i;
      if (!current.target) break;
      ee = G_Find(null, "targetname", current.target);
      if (G_Find(ee, "targetname", current.target) !== null) {
        gi.dprintf(`\nForked hint path at ${vtos(current.s.origin)} detected for chain ${num_hint_paths}, target ${current.target}\n`);
        // NOTE: the C reassigns `hint_path_start[i]->hint_chain = NULL` here
        // too, on the same start-of-chain edict, not `current`.
        const first = hint_path_start[i];
        if (first !== undefined && first !== null) first.hint_chain = null;
        break;
      }
    }
  }
}

// *****************************
//	MISCELLANEOUS STUFF
// *****************************

// PMM - inback
// use to see if opponent is behind you (not to side)
// if it looks a lot like infront, well, there's a reason
export function inback(self: EdictT, other: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const vec = vec3();
  VectorSubtract(other.s.origin, self.s.origin, vec);
  VectorNormalize(vec);
  const dot = DotProduct(vec, forward);

  return dot < -0.3;
}

export function realrange(self: EdictT, other: EdictT): number {
  const dir = vec3();
  VectorSubtract(self.s.origin, other.s.origin, dir);
  return VectorLength(dir);
}

export function face_wall(self: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const pt = vec3();
  VectorMA(self.s.origin, 64, forward, pt);
  const tr = gi.trace(self.s.origin, vec3_origin, vec3_origin, pt, self, MASK_MONSTERSOLID);
  if (tr.fraction < 1 && !tr.allsolid && !tr.startsolid) {
    const ang = vec3();
    vectoangles2(tr.plane.normal, ang);
    self.ideal_yaw = ang[YAW]! + 180;
    if (self.ideal_yaw > 360) self.ideal_yaw -= 360;

    M_ChangeYaw(self);
    return true;
  }

  return false;
}

//
// Monster "Bad" Areas
//

export function badarea_touch(_ent: EdictT, _other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  // drawbbox(ent);
}

export function SpawnBadArea(minsIn: Vec3, maxsIn: Vec3, lifespan: number, owner: EdictT | null): EdictT {
  const mins = vec3();
  VectorCopy(minsIn, mins);
  const maxs = vec3();
  VectorCopy(maxsIn, maxs);

  const origin = vec3();
  VectorAdd(mins, maxs, origin);
  VectorScale(origin, 0.5, origin);

  VectorSubtract(maxs, origin, maxs);
  VectorSubtract(mins, origin, mins);

  const badarea = G_Spawn();
  VectorCopy(origin, badarea.s.origin);
  VectorCopy(maxs, badarea.maxs);
  VectorCopy(mins, badarea.mins);
  badarea.touch = badarea_touch;
  badarea.movetype = MovetypeT.MOVETYPE_NONE;
  badarea.solid = SolidT.SOLID_TRIGGER;
  badarea.classname = "bad_area";
  gi.linkentity(badarea);

  if (lifespan) {
    badarea.think = G_FreeEdict;
    badarea.nextthink = level.time + lifespan;
  }
  if (owner !== null) {
    badarea.owner = owner;
  }

  return badarea;
}

// CheckForBadArea
//		This is a customized version of G_TouchTriggers that will check
//		for bad area triggers and return them if they're touched.
export function CheckForBadArea(ent: EdictT): EdictT | null {
  const mins = vec3();
  VectorAdd(ent.s.origin, ent.mins, mins);
  const maxs = vec3();
  VectorAdd(ent.s.origin, ent.maxs, maxs);

  const touch: Edict[] = new Array<Edict>(MAX_EDICTS);
  const num = gi.BoxEdicts(mins, maxs, touch, MAX_EDICTS, AREA_TRIGGERS);

  // be careful, it is possible to have an entity in this
  // list removed before we get to it (killtriggered)
  for (let i = 0; i < num; i++) {
    const hit = recoverEdict(touch[i] ?? null);
    if (hit === null || !hit.inuse) continue;
    if (hit.touch === badarea_touch) {
      return hit;
    }
  }

  return null;
}

const TESLA_DAMAGE_RADIUS = 128;

export function MarkTeslaArea(self: EdictT | null, tesla: EdictT | null): boolean {
  if (tesla === null || self === null) return false;

  // make sure this tesla doesn't have a bad area around it already...
  let e = tesla.teamchain;
  let tail = tesla;
  while (e !== null) {
    tail = tail.teamchain ?? tail;
    if (e.classname === "bad_area") {
      return false;
    }
    e = e.teamchain;
  }

  let area: EdictT | null = null;

  // see if we can grab the trigger directly
  if (tesla.teamchain !== null && tesla.teamchain.inuse) {
    const trigger = tesla.teamchain;

    const mins = vec3();
    const maxs = vec3();
    VectorCopy(trigger.absmin, mins);
    VectorCopy(trigger.absmax, maxs);

    if (tesla.air_finished) area = SpawnBadArea(mins, maxs, tesla.air_finished, tesla);
    else area = SpawnBadArea(mins, maxs, tesla.nextthink, tesla);
  }
  // otherwise we just guess at how long it'll last.
  else {
    const mins = vec3();
    const maxs = vec3();
    VectorSet(mins, -TESLA_DAMAGE_RADIUS, -TESLA_DAMAGE_RADIUS, tesla.mins[2]!);
    VectorSet(maxs, TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS);

    area = SpawnBadArea(mins, maxs, 30, tesla);
  }

  // if we spawned a bad area, then link it to the tesla
  if (area !== null) {
    tail.teamchain = area;
  }
  return true;
}

// predictive calculator
// target is who you want to shoot
// start is where the shot comes from
// bolt_speed is how fast the shot is
// eye_height is a boolean to say whether or not to adjust to targets eye_height
// offset is how much time to miss by
// aimdir is the resulting aim direction (every call site in the rogue source
// passes a real vector here, never NULL -- typed non-null, unlike aimpoint)
// aimpoint is the resulting aimpoint (pass in NULL if don't want it)
export function PredictAim(
  target: EdictT | null,
  start: Vec3,
  bolt_speed: number,
  eye_height: boolean,
  offset: number,
  aimdir: Vec3,
  aimpoint: Vec3 | null,
): void {
  if (target === null || !target.inuse) {
    VectorCopy(vec3_origin, aimdir);
    return;
  }

  const dir = vec3();
  VectorSubtract(target.s.origin, start, dir);
  if (eye_height) dir[2] += target.viewheight;
  const dist = VectorLength(dir);
  const time = dist / bolt_speed;

  const vec = vec3();
  VectorMA(target.s.origin, time - offset, target.velocity, vec);

  if (eye_height) vec[2] += target.viewheight;

  VectorSubtract(vec, start, aimdir);
  VectorNormalize(aimdir);

  if (aimpoint !== null) {
    VectorCopy(vec, aimpoint);
  }
}

export function below(self: EdictT, other: EdictT): boolean {
  const vec = vec3();
  VectorSubtract(other.s.origin, self.s.origin, vec);
  VectorNormalize(vec);
  const down = vec3();
  VectorSet(down, 0, 0, -1);
  const dot = DotProduct(vec, down);

  return dot > 0.95; // 18 degree arc below
}

export function drawbbox(self: EdictT): void {
  const lines = [
    [1, 2, 4],
    [1, 2, 7],
    [1, 4, 5],
    [2, 4, 7],
  ];
  const starts = [0, 3, 5, 6];

  const pt: Vec3[] = [];
  for (let i = 0; i < 8; i++) pt.push(vec3());

  const coords: [Vec3, Vec3] = [vec3(), vec3()];
  VectorCopy(self.absmin, coords[0]);
  VectorCopy(self.absmax, coords[1]);

  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= 1; j++) {
      for (let k = 0; k <= 1; k++) {
        pt[4 * i + 2 * j + k]![0] = coords[i]![0]!;
        pt[4 * i + 2 * j + k]![1] = coords[j]![1]!;
        pt[4 * i + 2 * j + k]![2] = coords[k]![2]!;
      }
    }
  }

  for (let i = 0; i <= 3; i++) {
    for (let j = 0; j <= 2; j++) {
      gi.WriteByte(svc_temp_entity);
      gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
      gi.WritePosition(pt[starts[i]!]!);
      gi.WritePosition(pt[lines[i]![j]!]!);
      gi.multicast(pt[starts[i]!]!, MulticastT.MULTICAST_ALL);
    }
  }

  const dir = vec3();
  vectoangles2(self.s.angles, dir);
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(dir, f, r, u);

  let newbox = vec3();
  VectorMA(self.s.origin, 50, f, newbox);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
  gi.WritePosition(self.s.origin);
  gi.WritePosition(newbox);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  VectorClear(newbox);

  newbox = vec3();
  VectorMA(self.s.origin, 50, r, newbox);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
  gi.WritePosition(self.s.origin);
  gi.WritePosition(newbox);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  VectorClear(newbox);

  newbox = vec3();
  VectorMA(self.s.origin, 50, u, newbox);
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DEBUGTRAIL);
  gi.WritePosition(self.s.origin);
  gi.WritePosition(newbox);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  VectorClear(newbox);
}

//
// New dodge code
//
export function M_MonsterDodge(self: EdictT, attacker: EdictT, eta: number, tr: GTraceT | null): void {
  const r = random();
  let height: number;
  let ducker = false;
  let dodger = false;

  // this needs to be here since this can be called after the monster has "died"
  if (self.health < 1) return;

  if (self.monsterinfo.duck && self.monsterinfo.unduck) ducker = true;
  if (self.monsterinfo.sidestep && !(self.monsterinfo.aiflags & AI_STAND_GROUND)) dodger = true;

  if (!ducker && !dodger) return;

  if (self.enemy === null) {
    self.enemy = attacker;
    FoundTarget(self);
  }

  // PMM - don't bother if it's going to hit anyway; fix for weird in-your-face etas (I was
  // seeing numbers like 13 and 14)
  if (eta < 0.1 || eta > 5) {
    return;
  }

  // skill level determination..
  const skillValue = gameCvars.skill === null ? 0 : gameCvars.skill.value;
  if (r > 0.25 * (skillValue + 1)) {
    return;
  }

  // stop charging, since we're going to dodge (somehow) instead
  // soldier_stop_charge (self);

  if (tr === null) throw new Error("M_MonsterDodge: tr is null (C dereferences tr->endpos unconditionally here)");

  if (ducker) {
    height = self.absmax[2]! - 32 - 1; // the -1 is because the absmax is s.origin + maxs + 1

    // FIXME, make smarter
    // if we only duck, and ducking won't help or we're already ducking, do nothing
    //
    // need to add monsterinfo.abort_duck() and monsterinfo.next_duck_time
    if (!dodger && (tr.endpos[2]! <= height || self.monsterinfo.aiflags & AI_DUCKED)) return;
  } else {
    height = self.absmax[2]!;
  }

  if (dodger) {
    // if we're already dodging, just finish the sequence, i.e. don't do anything else
    if (self.monsterinfo.aiflags & AI_DODGING) {
      return;
    }

    // if we're ducking already, or the shot is at our knees
    if (tr.endpos[2]! <= height || self.monsterinfo.aiflags & AI_DUCKED) {
      const right = vec3();
      AngleVectors(self.s.angles, null, right, null);
      const diff = vec3();
      VectorSubtract(tr.endpos, self.s.origin, diff);

      if (DotProduct(right, diff) < 0) {
        self.monsterinfo.lefty = 0;
      } else {
        self.monsterinfo.lefty = 1;
      }

      // if we are currently ducked, unduck
      if (ducker && self.monsterinfo.aiflags & AI_DUCKED) {
        if (self.monsterinfo.unduck) self.monsterinfo.unduck(self);
      }

      self.monsterinfo.aiflags |= AI_DODGING;
      self.monsterinfo.attack_state = AS_SLIDING;

      // call the monster specific code here
      if (self.monsterinfo.sidestep) self.monsterinfo.sidestep(self);
      return;
    }
  }

  if (ducker) {
    if (self.monsterinfo.next_duck_time > level.time) {
      return;
    }

    monster_done_dodge(self);
    // set this prematurely; it doesn't hurt, and prevents extra iterations
    self.monsterinfo.aiflags |= AI_DUCKED;

    if (self.monsterinfo.duck) self.monsterinfo.duck(self, eta);
  }
}

export function monster_duck_down(self: EdictT): void {
  self.monsterinfo.aiflags |= AI_DUCKED;

  self.maxs[2] = self.monsterinfo.base_height - 32;
  self.takedamage = DamageT.DAMAGE_YES;
  if (self.monsterinfo.duck_wait_time < level.time) self.monsterinfo.duck_wait_time = level.time + 1;
  gi.linkentity(self);
}

export function monster_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.duck_wait_time) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

export function monster_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] = self.monsterinfo.base_height;
  self.takedamage = DamageT.DAMAGE_AIM;
  self.monsterinfo.next_duck_time = level.time + DUCK_INTERVAL;
  gi.linkentity(self);
}

//=========================
//=========================
export function has_valid_enemy(self: EdictT): boolean {
  if (self.enemy === null) return false;

  if (!self.enemy.inuse) return false;

  if (self.enemy.health < 1) return false;

  return true;
}

export function TargetTesla(self: EdictT | null, tesla: EdictT | null): void {
  if (self === null || tesla === null) return;

  // PMM - medic bails on healing things
  if (self.monsterinfo.aiflags & AI_MEDIC) {
    if (self.enemy !== null) cleanupHealTarget(self.enemy);
    self.monsterinfo.aiflags &= ~AI_MEDIC;
  }

  // store the player enemy in case we lose track of him.
  if (self.enemy !== null && self.enemy.client !== null) self.monsterinfo.last_player_enemy = self.enemy;

  if (self.enemy !== tesla) {
    self.oldenemy = self.enemy;
    self.enemy = tesla;
    if (self.monsterinfo.attack) {
      if (self.health <= 0) {
        return;
      }
      self.monsterinfo.attack(self);
    } else {
      FoundTarget(self);
    }
  }
}

// this returns a randomly selected coop player who is visible to self
// returns NULL if bad
export function PickCoopTarget(self: EdictT): EdictT | null {
  // no more than 4 players in coop, so..
  const targets: EdictT[] = [];

  // if we're not in coop, this is a noop
  if (gameCvars.coop === null || !gameCvars.coop.value) return null;

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.client === null) continue;
    if (visible(self, ent)) {
      targets.push(ent);
    }
  }

  if (targets.length === 0) return null;

  // get a number from 0 to (num_targets-1)
  let targetID = Math.trunc(random() * targets.length);

  // just in case we got a 1.0 from random
  if (targetID === targets.length) targetID--;

  return targets[targetID] ?? null;
}

// only meant to be used in coop
export function CountPlayers(): number {
  // if we're not in coop, this is a noop
  if (gameCvars.coop === null || !gameCvars.coop.value) return 1;

  let count = 0;
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.client === null) continue;
    count++;
  }
  return count;
}

//*******************
// JUMPING AIDS
//*******************

export function monster_jump_start(self: EdictT): void {
  self.timestamp = level.time;
}

export function monster_jump_finished(self: EdictT): boolean {
  if (level.time - self.timestamp > 3) {
    return true;
  }
  return false;
}
