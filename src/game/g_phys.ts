/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/g_phys.c (GNU GPL v2 or later).
*/
// g_phys.c

/*


pushmove objects do not obey gravity, and do not interact with each other or trigger fields, but block normal movement and push normal objects when they move.

onground is set for toss objects when they come to a complete rest.  it is set for steping or walking objects

doors, plats, etc are SOLID_BSP, and MOVETYPE_PUSH
bonus items are SOLID_TRIGGER touch, and MOVETYPE_TOSS
corpses are SOLID_NOT and MOVETYPE_TOSS
crates are SOLID_BBOX and MOVETYPE_TOSS
walking monsters are SOLID_SLIDEBOX and MOVETYPE_STEP
flying/floating monsters are SOLID_SLIDEBOX and MOVETYPE_FLY

solid_edge items only clip against bsp models.

*/

import {
  CrossProduct,
  DotProduct,
  vec3,
  vec3_origin,
  type Vec3,
  VectorAdd,
  VectorCompare,
  VectorCopy,
  VectorMA,
  VectorScale,
  VectorSubtract,
  AngleVectors,
} from "../shared/math";
import { Com_sprintf, type CvarT, MASK_MONSTERSOLID, MASK_SOLID, MASK_WATER, YAW, CHAN_AUTO } from "../shared/q_shared";
import {
  FL_FLY,
  FL_SWIM,
  FL_TEAMSLAVE,
  FRAMETIME,
  gameCvars,
  g_edicts,
  gi,
  globals,
  level,
  MovetypeT,
  world,
  type EdictT,
} from "./g_local";
import { type Edict, type GTraceT, SolidT, SVF_MONSTER } from "./game";
import { G_TouchTriggers, vectoangles } from "./g_utils";
import { M_CheckGround } from "./g_monster";
import { M_CheckBottom } from "./m_move";
import { MAX_EDICTS } from "../shared/q_shared";

// `sv_maxvelocity`/`sv_gravity` are `cvar_t *` in C, resolved once at
// InitGame and read as bare pointers thereafter. g_local.ts's `gameCvars`
// holder types them `CvarT | null` (unlike `gi`/`globals`, which get the
// bare-`let` carve-out); this narrows with a real null check rather than a
// cast, matching "no `as` casts" (standing order 2).
function cvarOrThrow(c: CvarT | null, name: string): CvarT {
  if (c === null) {
    throw new Error(`${name} cvar not initialized`);
  }
  return c;
}

// Recovers the game-private EdictT from a GameImports.trace() result's
// game-visible `Edict`, per PORTING.md's EDICT_NUM idiom
// (`g_edicts[ent.s.number]`, never a cast). sv_world.c defaults trace.ent to
// the world edict before any collision test narrows it further
// (`clip.trace.ent = ge->edicts;`), so a null `Edict` -- only possible
// because GameImports.trace's declared return type allows it -- falls back
// to the world edict the same way.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/*
============
SV_TestEntityPosition

============
*/
export function SV_TestEntityPosition(ent: EdictT): EdictT | null {
  const mask = ent.clipmask ? ent.clipmask : MASK_SOLID;
  const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, ent.s.origin, ent, mask);

  if (trace.startsolid) return g_edicts[0];

  return null;
}

/*
================
SV_CheckVelocity
================
*/
export function SV_CheckVelocity(ent: EdictT): void {
  const sv_maxvelocity = cvarOrThrow(gameCvars.sv_maxvelocity, "sv_maxvelocity");

  //
  // bound velocity
  //
  for (let i = 0; i < 3; i++) {
    if (ent.velocity[i] > sv_maxvelocity.value) ent.velocity[i] = sv_maxvelocity.value;
    else if (ent.velocity[i] < -sv_maxvelocity.value) ent.velocity[i] = -sv_maxvelocity.value;
  }
}

/*
=============
SV_RunThink

Runs thinking code for this frame if necessary
=============
*/
export function SV_RunThink(ent: EdictT): boolean {
  const thinktime = ent.nextthink;
  if (thinktime <= 0) return true;
  if (thinktime > level.time + 0.001) return true;

  ent.nextthink = 0;
  if (!ent.think) gi.error("NULL ent->think");
  ent.think(ent);

  return false;
}

/*
==================
SV_Impact

Two entities have touched, so run their touch functions
==================
*/
export function SV_Impact(e1: EdictT, trace: GTraceT): void {
  // cplane_t backplane;
  const e2 = traceEdict(trace.ent);

  if (e1.touch && e1.solid !== SolidT.SOLID_NOT) e1.touch(e1, e2, trace.plane, trace.surface);

  if (e2.touch && e2.solid !== SolidT.SOLID_NOT) e2.touch(e2, e1, null, null);
}

/*
==================
ClipVelocity

Slide off of the impacting object
returns the blocked flags (1 = floor, 2 = step / wall)
==================
*/
const STOP_EPSILON = 0.1;

export function ClipVelocity(inVec: Vec3, normal: Vec3, out: Vec3, overbounce: number): number {
  let blocked = 0;
  if (normal[2] > 0) blocked |= 1; // floor
  if (!normal[2]) blocked |= 2; // step

  const backoff = DotProduct(inVec, normal) * overbounce;

  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = inVec[i] - change;
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) out[i] = 0;
  }

  return blocked;
}

/*
============
SV_FlyMove

The basic solid body movement clip that slides along multiple planes
Returns the clipflags if the velocity was modified (hit something solid)
1 = floor
2 = wall / step
4 = dead stop
============
*/
const MAX_CLIP_PLANES = 5;

export function SV_FlyMove(ent: EdictT, time: number, mask: number): number {
  const numbumps = 4;

  let blocked = 0;
  const original_velocity = vec3();
  VectorCopy(ent.velocity, original_velocity);
  const primal_velocity = vec3();
  VectorCopy(ent.velocity, primal_velocity);
  let numplanes = 0;
  const planes: Vec3[] = [];
  for (let p = 0; p < MAX_CLIP_PLANES; p++) planes.push(vec3());

  let i = 0;
  let j = 0;

  let time_left = time;

  ent.groundentity = null;
  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    const end = vec3();
    for (i = 0; i < 3; i++) end[i] = ent.s.origin[i] + time_left * ent.velocity[i];

    const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, end, ent, mask);

    if (trace.allsolid) {
      // entity is trapped in another solid
      VectorCopy(vec3_origin, ent.velocity);
      return 3;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, ent.s.origin);
      VectorCopy(ent.velocity, original_velocity);
      numplanes = 0;
    }

    if (trace.fraction === 1) break; // moved the entire distance

    const hit = traceEdict(trace.ent);

    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1; // floor
      if (hit.solid === SolidT.SOLID_BSP) {
        ent.groundentity = hit;
        ent.groundentity_linkcount = hit.linkcount;
      }
    }
    if (!trace.plane.normal[2]) {
      blocked |= 2; // step
    }

    //
    // run the impact function
    //
    SV_Impact(ent, trace);
    if (!ent.inuse) break; // removed by the impact function

    time_left -= time_left * trace.fraction;

    // cliped to another plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      VectorCopy(vec3_origin, ent.velocity);
      return 3;
    }

    VectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    //
    // modify original_velocity so it parallels all of the clip planes
    //
    const new_velocity = vec3();
    for (i = 0; i < numplanes; i++) {
      ClipVelocity(original_velocity, planes[i], new_velocity, 1);

      for (j = 0; j < numplanes; j++)
        if (j !== i && !VectorCompare(planes[i], planes[j])) {
          if (DotProduct(new_velocity, planes[j]) < 0) break; // not ok
        }
      if (j === numplanes) break;
    }

    if (i !== numplanes) {
      // go along this plane
      VectorCopy(new_velocity, ent.velocity);
    } else {
      // go along the crease
      if (numplanes !== 2) {
        VectorCopy(vec3_origin, ent.velocity);
        return 7;
      }
      const dir = vec3();
      CrossProduct(planes[0], planes[1], dir);
      const d = DotProduct(dir, ent.velocity);
      VectorScale(dir, d, ent.velocity);
    }

    //
    // if original velocity is against the original velocity, stop dead
    // to avoid tiny occilations in sloping corners
    //
    if (DotProduct(ent.velocity, primal_velocity) <= 0) {
      VectorCopy(vec3_origin, ent.velocity);
      return blocked;
    }
  }

  return blocked;
}

/*
============
SV_AddGravity

============
*/
export function SV_AddGravity(ent: EdictT): void {
  const sv_gravity = cvarOrThrow(gameCvars.sv_gravity, "sv_gravity");
  ent.velocity[2] -= ent.gravity * sv_gravity.value * FRAMETIME;
}

/*
===============================================================================

PUSHMOVE

===============================================================================
*/

/*
============
SV_PushEntity

Does not change the entities velocity at all
============
*/
export function SV_PushEntity(ent: EdictT, push: Vec3): GTraceT {
  const start = vec3();
  VectorCopy(ent.s.origin, start);
  const end = vec3();
  VectorAdd(start, push, end);

  let trace: GTraceT;
  for (;;) {
    const mask = ent.clipmask ? ent.clipmask : MASK_SOLID;

    trace = gi.trace(start, ent.mins, ent.maxs, end, ent, mask);

    VectorCopy(trace.endpos, ent.s.origin);
    gi.linkentity(ent);

    if (trace.fraction !== 1.0) {
      SV_Impact(ent, trace);

      // if the pushed entity went away and the pusher is still there
      const traceEnt = traceEdict(trace.ent);
      if (!traceEnt.inuse && ent.inuse) {
        // move the pusher back and try again
        VectorCopy(start, ent.s.origin);
        gi.linkentity(ent);
        continue; // goto retry
      }
    }
    break;
  }

  if (ent.inuse) G_TouchTriggers(ent);

  return trace;
}

class PushedT {
  ent: EdictT | null = null;
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
  deltayaw = 0;
}

// `pushed_t pushed[MAX_EDICTS], *pushed_p;` -- file-scope C globals, not
// `extern`'d anywhere else in g_local.h, so they stay module-private here.
// Per the brief: array + index instead of array + pointer.
const pushed: PushedT[] = Array.from({ length: MAX_EDICTS }, () => new PushedT());
let pushed_p = 0;

// `edict_t *obstacle;` -- also file-scope only (not `extern`'d), preserved
// as a module-private reassigned pointer.
let obstacle: EdictT | null = null;

/*
============
SV_Push

Objects need to be moved back on a failed push,
otherwise riders would continue to slide.
============
*/
export function SV_Push(pusher: EdictT, move: Vec3, amove: Vec3): boolean {
  // clamp the move to 1/8 units, so the position will
  // be accurate for client side prediction
  for (let i = 0; i < 3; i++) {
    let temp = move[i] * 8.0;
    if (temp > 0.0) temp += 0.5;
    else temp -= 0.5;
    move[i] = 0.125 * (temp | 0);
  }

  // find the bounding box
  const mins = vec3();
  const maxs = vec3();
  for (let i = 0; i < 3; i++) {
    mins[i] = pusher.absmin[i] + move[i];
    maxs[i] = pusher.absmax[i] + move[i];
  }

  // we need this for pushing things later
  const org = vec3();
  VectorSubtract(vec3_origin, amove, org);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(org, forward, right, up);

  // save the pusher's original position
  pushed[pushed_p].ent = pusher;
  VectorCopy(pusher.s.origin, pushed[pushed_p].origin);
  VectorCopy(pusher.s.angles, pushed[pushed_p].angles);
  if (pusher.client) {
    pushed[pushed_p].deltayaw = pusher.client.ps.pmove.delta_angles[YAW];
  }
  pushed_p++;

  // move the pusher to it's final position
  VectorAdd(pusher.s.origin, move, pusher.s.origin);
  VectorAdd(pusher.s.angles, amove, pusher.s.angles);
  gi.linkentity(pusher);

  // see if any solid entities are inside the final position
  for (let e = 1; e < globals.num_edicts; e++) {
    const check = g_edicts[e];
    if (!check.inuse) continue;
    if (
      check.movetype === MovetypeT.MOVETYPE_PUSH ||
      check.movetype === MovetypeT.MOVETYPE_STOP ||
      check.movetype === MovetypeT.MOVETYPE_NONE ||
      check.movetype === MovetypeT.MOVETYPE_NOCLIP
    )
      continue;

    if (!check.area.prev) continue; // not linked in anywhere

    // if the entity is standing on the pusher, it will definitely be moved
    if (check.groundentity !== pusher) {
      // see if the ent needs to be tested
      if (
        check.absmin[0] >= maxs[0] ||
        check.absmin[1] >= maxs[1] ||
        check.absmin[2] >= maxs[2] ||
        check.absmax[0] <= mins[0] ||
        check.absmax[1] <= mins[1] ||
        check.absmax[2] <= mins[2]
      )
        continue;

      // see if the ent's bbox is inside the pusher's final position
      if (!SV_TestEntityPosition(check)) continue;
    }

    if (pusher.movetype === MovetypeT.MOVETYPE_PUSH || check.groundentity === pusher) {
      // move this entity
      pushed[pushed_p].ent = check;
      VectorCopy(check.s.origin, pushed[pushed_p].origin);
      VectorCopy(check.s.angles, pushed[pushed_p].angles);
      pushed_p++;

      // try moving the contacted entity
      VectorAdd(check.s.origin, move, check.s.origin);
      if (check.client) {
        // FIXME: doesn't rotate monsters?
        check.client.ps.pmove.delta_angles[YAW] += amove[YAW];
      }

      // figure movement due to the pusher's amove
      const org2 = vec3();
      VectorSubtract(check.s.origin, pusher.s.origin, org);
      org2[0] = DotProduct(org, forward);
      org2[1] = -DotProduct(org, right);
      org2[2] = DotProduct(org, up);
      const move2 = vec3();
      VectorSubtract(org2, org, move2);
      VectorAdd(check.s.origin, move2, check.s.origin);

      // may have pushed them off an edge
      if (check.groundentity !== pusher) check.groundentity = null;

      let block = SV_TestEntityPosition(check);
      if (!block) {
        // pushed ok
        gi.linkentity(check);
        // impact?
        continue;
      }

      // if it is ok to leave in the old position, do it
      // this is only relevent for riding entities, not pushed
      // FIXME: this doesn't acount for rotation
      VectorSubtract(check.s.origin, move, check.s.origin);
      block = SV_TestEntityPosition(check);
      if (!block) {
        pushed_p--;
        continue;
      }
    }

    // save off the obstacle so we can call the block function
    obstacle = check;

    // move back any entities we already moved
    // go backwards, so if the same entity was pushed
    // twice, it goes back to the original position
    for (let p = pushed_p - 1; p >= 0; p--) {
      const pe = pushed[p];
      const pent = pe.ent;
      if (pent === null) continue;
      VectorCopy(pe.origin, pent.s.origin);
      VectorCopy(pe.angles, pent.s.angles);
      if (pent.client) {
        pent.client.ps.pmove.delta_angles[YAW] = pe.deltayaw;
      }
      gi.linkentity(pent);
    }
    return false;
  }

  // FIXME: is there a better way to handle this?
  // see if anything we moved has touched a trigger
  for (let p = pushed_p - 1; p >= 0; p--) {
    const pent = pushed[p].ent;
    if (pent !== null) G_TouchTriggers(pent);
  }

  return true;
}

/*
================
SV_Physics_Pusher

Bmodel objects don't interact with each other, but
push all box objects
================
*/
export function SV_Physics_Pusher(ent: EdictT): void {
  // if not a team captain, so movement will be handled elsewhere
  if (ent.flags & FL_TEAMSLAVE) return;

  // make sure all team slaves can move before commiting
  // any moves or calling any think functions
  // if the move is blocked, all moved objects will be backed out
  // retry:
  pushed_p = 0;
  let part: EdictT | null;
  for (part = ent; part; part = part.teamchain) {
    if (
      part.velocity[0] ||
      part.velocity[1] ||
      part.velocity[2] ||
      part.avelocity[0] ||
      part.avelocity[1] ||
      part.avelocity[2]
    ) {
      // object is moving
      const move = vec3();
      VectorScale(part.velocity, FRAMETIME, move);
      const amove = vec3();
      VectorScale(part.avelocity, FRAMETIME, amove);

      if (!SV_Push(part, move, amove)) break; // move was blocked
    }
  }
  if (pushed_p > MAX_EDICTS) {
    // C passes `ERR_FATAL` as this call's first arg, but game_import_t's
    // `error` is `(char *fmt, ...)` -- ERR_FATAL lands in the fmt slot,
    // a benign quirk of the original source. GameImports.error (game.ts,
    // out of scope) takes a single already-formatted string, so the stray
    // ERR_FATAL argument is dropped.
    gi.error("pushed_p > &pushed[MAX_EDICTS], memory corrupted");
  }

  if (part) {
    // the move failed, bump all nextthink times and back out moves
    for (let mv: EdictT | null = ent; mv; mv = mv.teamchain) {
      if (mv.nextthink > 0) mv.nextthink += FRAMETIME;
    }

    // if the pusher has a "blocked" function, call it
    // otherwise, just stay in place until the obstacle is gone
    if (part.blocked && obstacle !== null) part.blocked(part, obstacle);
    // #if 0
    // // if the pushed entity went away and the pusher is still there
    // if (!obstacle->inuse && part->inuse)
    //   goto retry;
    // #endif -- dropped per PORTING.md ("#if 0 blocks are dropped silently")
  } else {
    // the move succeeded, so call all think functions
    for (part = ent; part; part = part.teamchain) {
      SV_RunThink(part);
    }
  }
}

//==================================================================

/*
=============
SV_Physics_None

Non moving objects can only think
=============
*/
export function SV_Physics_None(ent: EdictT): void {
  // regular thinking
  SV_RunThink(ent);
}

/*
=============
SV_Physics_Noclip

A moving object that doesn't obey physics
=============
*/
export function SV_Physics_Noclip(ent: EdictT): void {
  // regular thinking
  if (!SV_RunThink(ent)) return;

  VectorMA(ent.s.angles, FRAMETIME, ent.avelocity, ent.s.angles);
  VectorMA(ent.s.origin, FRAMETIME, ent.velocity, ent.s.origin);

  gi.linkentity(ent);
}

/*
==============================================================================

TOSS / BOUNCE

==============================================================================
*/

/*
=============
SV_Physics_Toss

Toss, bounce, and fly movement.  When onground, do nothing.
=============
*/
export function SV_Physics_Toss(ent: EdictT): void {
  // regular thinking
  SV_RunThink(ent);

  // if not a team captain, so movement will be handled elsewhere
  if (ent.flags & FL_TEAMSLAVE) return;

  if (ent.velocity[2] > 0) ent.groundentity = null;

  // check for the groundentity going away
  if (ent.groundentity) if (!ent.groundentity.inuse) ent.groundentity = null;

  // if onground, return without moving
  if (ent.groundentity) return;

  const old_origin = vec3();
  VectorCopy(ent.s.origin, old_origin);

  SV_CheckVelocity(ent);

  // add gravity
  // RERELEASE CONTENT PORT (xatrix/g_phys.c's `// RAFAEL -- move type for
  // rippergun projectile`): MOVETYPE_WALLBOUNCE is weightless like the two
  // fly movetypes.
  if (
    ent.movetype !== MovetypeT.MOVETYPE_FLY &&
    ent.movetype !== MovetypeT.MOVETYPE_FLYMISSILE &&
    ent.movetype !== MovetypeT.MOVETYPE_WALLBOUNCE
  )
    SV_AddGravity(ent);

  // move angles
  VectorMA(ent.s.angles, FRAMETIME, ent.avelocity, ent.s.angles);

  // move origin
  const move = vec3();
  VectorScale(ent.velocity, FRAMETIME, move);
  const trace = SV_PushEntity(ent, move);
  if (!ent.inuse) return;

  if (trace.fraction < 1) {
    let backoff: number;
    // RERELEASE CONTENT PORT (xatrix/g_phys.c): the wallbounce projectile
    // gets a stronger backoff than a normal bounce, and re-orients its
    // model to face the new travel direction on every wall hit.
    if (ent.movetype === MovetypeT.MOVETYPE_WALLBOUNCE) backoff = 2.0;
    else if (ent.movetype === MovetypeT.MOVETYPE_BOUNCE) backoff = 1.5;
    else backoff = 1;

    ClipVelocity(ent.velocity, trace.plane.normal, ent.velocity, backoff);

    if (ent.movetype === MovetypeT.MOVETYPE_WALLBOUNCE) vectoangles(ent.velocity, ent.s.angles);

    // stop if on ground
    // RERELEASE CONTENT PORT (xatrix/g_phys.c): the wallbounce projectile
    // never settles on the ground the way a real bounce does.
    if (trace.plane.normal[2] > 0.7 && ent.movetype !== MovetypeT.MOVETYPE_WALLBOUNCE) {
      if (ent.velocity[2] < 60 || ent.movetype !== MovetypeT.MOVETYPE_BOUNCE) {
        const groundEnt = traceEdict(trace.ent);
        ent.groundentity = groundEnt;
        ent.groundentity_linkcount = groundEnt.linkcount;
        VectorCopy(vec3_origin, ent.velocity);
        VectorCopy(vec3_origin, ent.avelocity);
      }
    }

    //		if (ent->touch)
    //			ent->touch (ent, trace.ent, &trace.plane, trace.surface);
  }

  // check for water transition
  const wasinwater = (ent.watertype & MASK_WATER) !== 0;
  ent.watertype = gi.pointcontents(ent.s.origin);
  const isinwater = (ent.watertype & MASK_WATER) !== 0;

  if (isinwater) ent.waterlevel = 1;
  else ent.waterlevel = 0;

  if (!wasinwater && isinwater) {
    gi.positioned_sound(old_origin, world(), CHAN_AUTO, gi.soundindex("misc/h2ohit1.wav"), 1, 1, 0);
  } else if (wasinwater && !isinwater) {
    gi.positioned_sound(ent.s.origin, world(), CHAN_AUTO, gi.soundindex("misc/h2ohit1.wav"), 1, 1, 0);
  }

  // move teamslaves
  for (let slave = ent.teamchain; slave; slave = slave.teamchain) {
    VectorCopy(ent.s.origin, slave.s.origin);
    gi.linkentity(slave);
  }
}

/*
===============================================================================

STEPPING MOVEMENT

===============================================================================
*/

/*
=============
SV_Physics_Step

Monsters freefall when they don't have a ground entity, otherwise
all movement is done with discrete steps.

This is also used for objects that have become still on the ground, but
will fall if the floor is pulled out from under them.
FIXME: is this true?
=============
*/

// FIXME: hacked in for E3 demo
const sv_stopspeed = 100;
const sv_friction = 6;
const sv_waterfriction = 1;

export function SV_AddRotationalFriction(ent: EdictT): void {
  VectorMA(ent.s.angles, FRAMETIME, ent.avelocity, ent.s.angles);
  const adjustment = FRAMETIME * sv_stopspeed * sv_friction;
  for (let n = 0; n < 3; n++) {
    if (ent.avelocity[n] > 0) {
      ent.avelocity[n] -= adjustment;
      if (ent.avelocity[n] < 0) ent.avelocity[n] = 0;
    } else {
      ent.avelocity[n] += adjustment;
      if (ent.avelocity[n] > 0) ent.avelocity[n] = 0;
    }
  }
}

export function SV_Physics_Step(ent: EdictT): void {
  let hitsound = false;

  // airborn monsters should always check for ground
  if (!ent.groundentity) M_CheckGround(ent);

  const groundentity = ent.groundentity;

  SV_CheckVelocity(ent);

  const wasonground = !!groundentity;

  if (ent.avelocity[0] || ent.avelocity[1] || ent.avelocity[2]) SV_AddRotationalFriction(ent);

  // add gravity except:
  //   flying monsters
  //   swimming monsters who are in the water
  if (!wasonground)
    if (!(ent.flags & FL_FLY))
      if (!((ent.flags & FL_SWIM) && ent.waterlevel > 2)) {
        const sv_gravity = cvarOrThrow(gameCvars.sv_gravity, "sv_gravity");
        if (ent.velocity[2] < sv_gravity.value * -0.1) hitsound = true;
        if (ent.waterlevel === 0) SV_AddGravity(ent);
      }

  // friction for flying monsters that have been given vertical velocity
  if (ent.flags & FL_FLY && ent.velocity[2] !== 0) {
    const speed = Math.abs(ent.velocity[2]);
    const control = speed < sv_stopspeed ? sv_stopspeed : speed;
    const friction = sv_friction / 3;
    let newspeed = speed - FRAMETIME * control * friction;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    ent.velocity[2] *= newspeed;
  }

  // friction for flying monsters that have been given vertical velocity
  if (ent.flags & FL_SWIM && ent.velocity[2] !== 0) {
    const speed = Math.abs(ent.velocity[2]);
    const control = speed < sv_stopspeed ? sv_stopspeed : speed;
    let newspeed = speed - FRAMETIME * control * sv_waterfriction * ent.waterlevel;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    ent.velocity[2] *= newspeed;
  }

  if (ent.velocity[2] || ent.velocity[1] || ent.velocity[0]) {
    // apply friction
    // let dead monsters who aren't completely onground slide
    if (wasonground || ent.flags & (FL_SWIM | FL_FLY))
      if (!(ent.health <= 0.0 && !M_CheckBottom(ent))) {
        const vel = ent.velocity;
        const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
        if (speed) {
          const friction = sv_friction;

          const control = speed < sv_stopspeed ? sv_stopspeed : speed;
          let newspeed = speed - FRAMETIME * control * friction;

          if (newspeed < 0) newspeed = 0;
          newspeed /= speed;

          vel[0] *= newspeed;
          vel[1] *= newspeed;
        }
      }

    const mask = ent.svflags & SVF_MONSTER ? MASK_MONSTERSOLID : MASK_SOLID;
    SV_FlyMove(ent, FRAMETIME, mask);

    gi.linkentity(ent);
    G_TouchTriggers(ent);
    if (!ent.inuse) return;

    if (ent.groundentity) if (!wasonground) if (hitsound) gi.sound(ent, 0, gi.soundindex("world/land.wav"), 1, 1, 0);
  }

  // regular thinking
  SV_RunThink(ent);
}

//============================================================================
/*
================
G_RunEntity

================
*/
export function G_RunEntity(ent: EdictT): void {
  if (ent.prethink) ent.prethink(ent);

  switch (ent.movetype) {
    case MovetypeT.MOVETYPE_PUSH:
    case MovetypeT.MOVETYPE_STOP:
      SV_Physics_Pusher(ent);
      break;
    case MovetypeT.MOVETYPE_NONE:
      SV_Physics_None(ent);
      break;
    case MovetypeT.MOVETYPE_NOCLIP:
      SV_Physics_Noclip(ent);
      break;
    case MovetypeT.MOVETYPE_STEP:
      SV_Physics_Step(ent);
      break;
    case MovetypeT.MOVETYPE_TOSS:
    case MovetypeT.MOVETYPE_BOUNCE:
    case MovetypeT.MOVETYPE_FLY:
    case MovetypeT.MOVETYPE_FLYMISSILE:
    // RERELEASE CONTENT PORT (xatrix/g_phys.c): MOVETYPE_WALLBOUNCE routes
    // through the same toss/bounce physics as MOVETYPE_BOUNCE.
    case MovetypeT.MOVETYPE_WALLBOUNCE:
      SV_Physics_Toss(ent);
      break;
    default:
      gi.error(Com_sprintf("SV_Physics: bad movetype %i", ent.movetype));
  }
}
