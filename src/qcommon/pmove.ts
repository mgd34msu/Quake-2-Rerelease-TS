/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from qcommon/pmove.c (GNU GPL v2 or later).
*/

import {
  type Vec3,
  vec3,
  DotProduct,
  VectorCopy,
  VectorClear,
  VectorMA,
  VectorScale,
  VectorNormalize,
  VectorLength,
  CrossProduct,
  AngleVectors,
} from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  type TraceT,
  type CsurfaceT,
  CplaneT,
  PmoveT,
  PmTypeT,
  PMF_DUCKED,
  PMF_JUMP_HELD,
  PMF_ON_GROUND,
  PMF_TIME_WATERJUMP,
  PMF_TIME_LAND,
  PMF_TIME_TELEPORT,
  MAXTOUCH,
  PITCH,
  YAW,
  ROLL,
  SHORT2ANGLE,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  CONTENTS_SLIME,
  CONTENTS_LADDER,
  MASK_WATER,
  MASK_CURRENT,
  CONTENTS_CURRENT_0,
  CONTENTS_CURRENT_90,
  CONTENTS_CURRENT_180,
  CONTENTS_CURRENT_270,
  CONTENTS_CURRENT_UP,
  CONTENTS_CURRENT_DOWN,
  SURF_SLICK,
} from "../shared/q_shared";

const STEPSIZE = 18;

// all of the locals will be zeroed before each
// pmove, just to make damn sure we don't have
// any differences when running on client or server
class PmlT {
  origin: Vec3 = vec3(); // full float precision
  velocity: Vec3 = vec3(); // full float precision

  forward: Vec3 = vec3();
  right: Vec3 = vec3();
  up: Vec3 = vec3();
  frametime = 0;

  groundsurface: CsurfaceT | null = null;
  groundplane: CplaneT = new CplaneT();
  groundcontents = 0;

  previous_origin: Vec3 = vec3();
  ladder = false;
}

// `pmove_t *pm;` — a reassigned pointer in C, held here as a module-local `let`
// per PORTING.md. `pml_t pml;` likewise: replaced wholesale each Pmove() call,
// mirroring the C `memset(&pml, 0, sizeof(pml))`.
let pm: PmoveT = new PmoveT();
let pml: PmlT = new PmlT();

// movement parameters
export let pm_stopspeed = 100;
export let pm_maxspeed = 300;
export let pm_duckspeed = 100;
export let pm_accelerate = 10;
export let pm_airaccelerate = 0;

// C: `pm_airaccelerate = sv_airaccelerate->value;` (sv_init.c:SV_SpawnServer)
// assigns the module-local straight through the extern pointer. This module
// has no exported setter for a bare `export let` (ES module bindings are
// read-only to importers), so sv_init.ts's SV_SpawnServer -- out of this
// unit's SCOPE to edit -- needs this setter to wire the assignment through;
// see report.
export function SetPmAirAccelerate(v: number): void {
  pm_airaccelerate = v;
}
export let pm_wateraccelerate = 10;
export let pm_friction = 6;
export let pm_waterfriction = 1;
export let pm_waterspeed = 400;

/*

  walking up a step should kill some velocity

*/

// cplane_t is a value struct in C; `pml.groundplane = trace.plane;` is a
// memberwise struct copy, not a pointer/reference assignment.
function copyPlane(dst: CplaneT, src: CplaneT): void {
  VectorCopy(src.normal, dst.normal);
  dst.dist = src.dist;
  dst.type = src.type;
  dst.signbits = src.signbits;
}

// Matches assigning an int expression into a C `short` local: two's complement
// truncation to 16 bits (the negative-value behavior of a `(short)` cast).
function toShort(x: number): number {
  return (x << 16) >> 16;
}

/*
==================
PM_ClipVelocity

Slide off of the impacting object
returns the blocked flags (1 = floor, 2 = step / wall)
==================
*/
const STOP_EPSILON = 0.1;

export function PM_ClipVelocity(inVec: Vec3, normal: Vec3, out: Vec3, overbounce: number): void {
  const backoff = DotProduct(inVec, normal) * overbounce;

  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = inVec[i] - change;
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) out[i] = 0;
  }
}

/*
==================
PM_StepSlideMove

Each intersection will try to step over the obstruction instead of
sliding along it.

Returns a new origin, velocity, and contact entity
Does not modify any world state?
==================
*/
const MIN_STEP_NORMAL = 0.7; // can't step up onto very steep slopes
const MAX_CLIP_PLANES = 5;

export function PM_StepSlideMove_(): void {
  const numbumps = 4;
  const dir = vec3();
  const planes: Vec3[] = [];
  for (let p = 0; p < MAX_CLIP_PLANES; p++) planes.push(vec3());
  const primal_velocity = vec3();
  const end = vec3();
  let i = 0;
  let j = 0;

  VectorCopy(pml.velocity, primal_velocity);
  let numplanes = 0;

  let time_left = pml.frametime;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    for (let k = 0; k < 3; k++) end[k] = pml.origin[k] + time_left * pml.velocity[k];

    const trace = pm.trace(pml.origin, pm.mins, pm.maxs, end);

    if (trace.allsolid) {
      // entity is trapped in another solid
      pml.velocity[2] = 0; // don't build up falling damage
      return;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, pml.origin);
      numplanes = 0;
    }

    if (trace.fraction === 1) break; // moved the entire distance

    // save entity for contact
    if (pm.numtouch < MAXTOUCH && trace.ent) {
      pm.touchents[pm.numtouch] = trace.ent;
      pm.numtouch++;
    }

    time_left -= time_left * trace.fraction;

    // slide along this plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      VectorClear(pml.velocity);
      break;
    }

    VectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    //
    // modify original_velocity so it parallels all of the clip planes
    //
    for (i = 0; i < numplanes; i++) {
      PM_ClipVelocity(pml.velocity, planes[i], pml.velocity, 1.01);
      for (j = 0; j < numplanes; j++) {
        if (j !== i) {
          if (DotProduct(pml.velocity, planes[j]) < 0) break; // not ok
        }
      }
      if (j === numplanes) break;
    }

    if (i !== numplanes) {
      // go along this plane
    } else {
      // go along the crease
      if (numplanes !== 2) {
        VectorClear(pml.velocity);
        break;
      }
      CrossProduct(planes[0], planes[1], dir);
      const d = DotProduct(dir, pml.velocity);
      VectorScale(dir, d, pml.velocity);
    }

    //
    // if velocity is against the original velocity, stop dead
    // to avoid tiny occilations in sloping corners
    //
    if (DotProduct(pml.velocity, primal_velocity) <= 0) {
      VectorClear(pml.velocity);
      break;
    }
  }

  if (pm.s.pm_time) {
    VectorCopy(primal_velocity, pml.velocity);
  }
}

/*
==================
PM_StepSlideMove

==================
*/
export function PM_StepSlideMove(): void {
  const start_o = vec3();
  const start_v = vec3();
  const down_o = vec3();
  const down_v = vec3();
  const up = vec3();
  const down = vec3();

  VectorCopy(pml.origin, start_o);
  VectorCopy(pml.velocity, start_v);

  PM_StepSlideMove_();

  VectorCopy(pml.origin, down_o);
  VectorCopy(pml.velocity, down_v);

  VectorCopy(start_o, up);
  up[2] += STEPSIZE;

  let trace: TraceT = pm.trace(up, pm.mins, pm.maxs, up);
  if (trace.allsolid) return; // can't step up

  // try sliding above
  VectorCopy(up, pml.origin);
  VectorCopy(start_v, pml.velocity);

  PM_StepSlideMove_();

  // push down the final amount
  VectorCopy(pml.origin, down);
  down[2] -= STEPSIZE;
  trace = pm.trace(pml.origin, pm.mins, pm.maxs, down);
  if (!trace.allsolid) {
    VectorCopy(trace.endpos, pml.origin);
  }

  VectorCopy(pml.origin, up);

  // decide which one went farther
  const down_dist =
    (down_o[0] - start_o[0]) * (down_o[0] - start_o[0]) + (down_o[1] - start_o[1]) * (down_o[1] - start_o[1]);
  const up_dist = (up[0] - start_o[0]) * (up[0] - start_o[0]) + (up[1] - start_o[1]) * (up[1] - start_o[1]);

  if (down_dist > up_dist || trace.plane.normal[2] < MIN_STEP_NORMAL) {
    VectorCopy(down_o, pml.origin);
    VectorCopy(down_v, pml.velocity);
    return;
  }
  //!! Special case
  // if we were walking along a plane, then we need to copy the Z over
  pml.velocity[2] = down_v[2];
}

/*
==================
PM_Friction

Handles both ground friction and water friction
==================
*/
export function PM_Friction(): void {
  const vel = pml.velocity;

  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
  if (speed < 1) {
    vel[0] = 0;
    vel[1] = 0;
    return;
  }

  let drop = 0;

  // apply ground friction
  if ((pm.groundentity && pml.groundsurface && (pml.groundsurface.flags & SURF_SLICK) === 0) || pml.ladder) {
    const friction = pm_friction;
    const control = speed < pm_stopspeed ? pm_stopspeed : speed;
    drop += control * friction * pml.frametime;
  }

  // apply water friction
  if (pm.waterlevel && !pml.ladder) {
    drop += speed * pm_waterfriction * pm.waterlevel * pml.frametime;
  }

  // scale the velocity
  let newspeed = speed - drop;
  if (newspeed < 0) {
    newspeed = 0;
  }
  newspeed /= speed;

  vel[0] = vel[0] * newspeed;
  vel[1] = vel[1] * newspeed;
  vel[2] = vel[2] * newspeed;
}

/*
==============
PM_Accelerate

Handles user intended acceleration
==============
*/
export function PM_Accelerate(wishdir: Vec3, wishspeed: number, accel: number): void {
  const currentspeed = DotProduct(pml.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * pml.frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) pml.velocity[i] += accelspeed * wishdir[i];
}

export function PM_AirAccelerate(wishdir: Vec3, wishspeed: number, accel: number): void {
  let wishspd = wishspeed;

  if (wishspd > 30) wishspd = 30;
  const currentspeed = DotProduct(pml.velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * pml.frametime;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) pml.velocity[i] += accelspeed * wishdir[i];
}

/*
=============
PM_AddCurrents
=============
*/
export function PM_AddCurrents(wishvel: Vec3): void {
  const v = vec3();

  //
  // account for ladders
  //
  if (pml.ladder && Math.abs(pml.velocity[2]) <= 200) {
    if (pm.viewangles[PITCH] <= -15 && pm.cmd.forwardmove > 0) wishvel[2] = 200;
    else if (pm.viewangles[PITCH] >= 15 && pm.cmd.forwardmove > 0) wishvel[2] = -200;
    else if (pm.cmd.upmove > 0) wishvel[2] = 200;
    else if (pm.cmd.upmove < 0) wishvel[2] = -200;
    else wishvel[2] = 0;

    // limit horizontal speed when on a ladder
    if (wishvel[0] < -25) wishvel[0] = -25;
    else if (wishvel[0] > 25) wishvel[0] = 25;

    if (wishvel[1] < -25) wishvel[1] = -25;
    else if (wishvel[1] > 25) wishvel[1] = 25;
  }

  //
  // add water currents
  //
  if (pm.watertype & MASK_CURRENT) {
    VectorClear(v);

    if (pm.watertype & CONTENTS_CURRENT_0) v[0] += 1;
    if (pm.watertype & CONTENTS_CURRENT_90) v[1] += 1;
    if (pm.watertype & CONTENTS_CURRENT_180) v[0] -= 1;
    if (pm.watertype & CONTENTS_CURRENT_270) v[1] -= 1;
    if (pm.watertype & CONTENTS_CURRENT_UP) v[2] += 1;
    if (pm.watertype & CONTENTS_CURRENT_DOWN) v[2] -= 1;

    let s = pm_waterspeed;
    if (pm.waterlevel === 1 && pm.groundentity) s /= 2;

    VectorMA(wishvel, s, v, wishvel);
  }

  //
  // add conveyor belt velocities
  //
  if (pm.groundentity) {
    VectorClear(v);

    if (pml.groundcontents & CONTENTS_CURRENT_0) v[0] += 1;
    if (pml.groundcontents & CONTENTS_CURRENT_90) v[1] += 1;
    if (pml.groundcontents & CONTENTS_CURRENT_180) v[0] -= 1;
    if (pml.groundcontents & CONTENTS_CURRENT_270) v[1] -= 1;
    if (pml.groundcontents & CONTENTS_CURRENT_UP) v[2] += 1;
    if (pml.groundcontents & CONTENTS_CURRENT_DOWN) v[2] -= 1;

    VectorMA(wishvel, 100 /* pm->groundentity->speed */, v, wishvel);
  }
}

/*
===================
PM_WaterMove

===================
*/
export function PM_WaterMove(): void {
  const wishvel = vec3();

  //
  // user intentions
  //
  for (let i = 0; i < 3; i++) wishvel[i] = pml.forward[i] * pm.cmd.forwardmove + pml.right[i] * pm.cmd.sidemove;

  if (!pm.cmd.forwardmove && !pm.cmd.sidemove && !pm.cmd.upmove) wishvel[2] -= 60; // drift towards bottom
  else wishvel[2] += pm.cmd.upmove;

  PM_AddCurrents(wishvel);

  const wishdir = vec3();
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  if (wishspeed > pm_maxspeed) {
    VectorScale(wishvel, pm_maxspeed / wishspeed, wishvel);
    wishspeed = pm_maxspeed;
  }
  wishspeed *= 0.5;

  PM_Accelerate(wishdir, wishspeed, pm_wateraccelerate);

  PM_StepSlideMove();
}

/*
===================
PM_AirMove

===================
*/
export function PM_AirMove(): void {
  const wishvel = vec3();
  const fmove = pm.cmd.forwardmove;
  const smove = pm.cmd.sidemove;

  for (let i = 0; i < 2; i++) wishvel[i] = pml.forward[i] * fmove + pml.right[i] * smove;
  wishvel[2] = 0;

  PM_AddCurrents(wishvel);

  const wishdir = vec3();
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  //
  // clamp to server defined max speed
  //
  const maxspeed = pm.s.pm_flags & PMF_DUCKED ? pm_duckspeed : pm_maxspeed;

  if (wishspeed > maxspeed) {
    VectorScale(wishvel, maxspeed / wishspeed, wishvel);
    wishspeed = maxspeed;
  }

  if (pml.ladder) {
    PM_Accelerate(wishdir, wishspeed, pm_accelerate);
    if (wishvel[2] === 0) {
      if (pml.velocity[2] > 0) {
        pml.velocity[2] -= pm.s.gravity * pml.frametime;
        if (pml.velocity[2] < 0) pml.velocity[2] = 0;
      } else {
        pml.velocity[2] += pm.s.gravity * pml.frametime;
        if (pml.velocity[2] > 0) pml.velocity[2] = 0;
      }
    }
    PM_StepSlideMove();
  } else if (pm.groundentity) {
    // walking on ground
    pml.velocity[2] = 0; //!!! this is before the accel
    PM_Accelerate(wishdir, wishspeed, pm_accelerate);

    // PGM -- fix for negative trigger_gravity fields
    if (pm.s.gravity > 0) pml.velocity[2] = 0;
    else pml.velocity[2] -= pm.s.gravity * pml.frametime;
    // PGM

    if (pml.velocity[0] === 0 && pml.velocity[1] === 0) return;
    PM_StepSlideMove();
  } else {
    // not on ground, so little effect on velocity
    if (pm_airaccelerate) PM_AirAccelerate(wishdir, wishspeed, pm_accelerate);
    else PM_Accelerate(wishdir, wishspeed, 1);
    // add gravity
    pml.velocity[2] -= pm.s.gravity * pml.frametime;
    PM_StepSlideMove();
  }
}

/*
=============
PM_CatagorizePosition
=============
*/
export function PM_CatagorizePosition(): void {
  const point = vec3();

  // if the player hull point one unit down is solid, the player
  // is on ground

  // see if standing on something solid
  point[0] = pml.origin[0];
  point[1] = pml.origin[1];
  point[2] = pml.origin[2] - 0.25;
  if (pml.velocity[2] > 180) {
    //!!ZOID changed from 100 to 180 (ramp accel)
    pm.s.pm_flags &= ~PMF_ON_GROUND;
    pm.groundentity = null;
  } else {
    const trace = pm.trace(pml.origin, pm.mins, pm.maxs, point);
    copyPlane(pml.groundplane, trace.plane);
    pml.groundsurface = trace.surface;
    pml.groundcontents = trace.contents;

    if (!trace.ent || (trace.plane.normal[2] < 0.7 && !trace.startsolid)) {
      pm.groundentity = null;
      pm.s.pm_flags &= ~PMF_ON_GROUND;
    } else {
      pm.groundentity = trace.ent;

      // hitting solid ground will end a waterjump
      if (pm.s.pm_flags & PMF_TIME_WATERJUMP) {
        pm.s.pm_flags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_TELEPORT);
        pm.s.pm_time = 0;
      }

      if (!(pm.s.pm_flags & PMF_ON_GROUND)) {
        // just hit the ground
        pm.s.pm_flags |= PMF_ON_GROUND;
        // don't do landing time if we were just going down a slope
        if (pml.velocity[2] < -200) {
          pm.s.pm_flags |= PMF_TIME_LAND;
          // don't allow another jump for a little while
          if (pml.velocity[2] < -400) pm.s.pm_time = 25;
          else pm.s.pm_time = 18;
        }
      }
    }

    if (pm.numtouch < MAXTOUCH && trace.ent) {
      pm.touchents[pm.numtouch] = trace.ent;
      pm.numtouch++;
    }
  }

  //
  // get waterlevel, accounting for ducking
  //
  pm.waterlevel = 0;
  pm.watertype = 0;

  const sample2 = Math.trunc(pm.viewheight - pm.mins[2]);
  const sample1 = (sample2 / 2) | 0;

  point[2] = pml.origin[2] + pm.mins[2] + 1;
  let cont = pm.pointcontents(point);

  if (cont & MASK_WATER) {
    pm.watertype = cont;
    pm.waterlevel = 1;
    point[2] = pml.origin[2] + pm.mins[2] + sample1;
    cont = pm.pointcontents(point);
    if (cont & MASK_WATER) {
      pm.waterlevel = 2;
      point[2] = pml.origin[2] + pm.mins[2] + sample2;
      cont = pm.pointcontents(point);
      if (cont & MASK_WATER) pm.waterlevel = 3;
    }
  }
}

/*
=============
PM_CheckJump
=============
*/
export function PM_CheckJump(): void {
  if (pm.s.pm_flags & PMF_TIME_LAND) {
    // hasn't been long enough since landing to jump again
    return;
  }

  if (pm.cmd.upmove < 10) {
    // not holding jump
    pm.s.pm_flags &= ~PMF_JUMP_HELD;
    return;
  }

  // must wait for jump to be released
  if (pm.s.pm_flags & PMF_JUMP_HELD) return;

  if (pm.s.pm_type === PmTypeT.PM_DEAD) return;

  if (pm.waterlevel >= 2) {
    // swimming, not jumping
    pm.groundentity = null;

    if (pml.velocity[2] <= -300) return;

    if (pm.watertype === CONTENTS_WATER) pml.velocity[2] = 100;
    else if (pm.watertype === CONTENTS_SLIME) pml.velocity[2] = 80;
    else pml.velocity[2] = 50;
    return;
  }

  if (pm.groundentity === null) return; // in air, so no effect

  pm.s.pm_flags |= PMF_JUMP_HELD;

  pm.groundentity = null;
  pml.velocity[2] += 270;
  if (pml.velocity[2] < 270) pml.velocity[2] = 270;
}

/*
=============
PM_CheckSpecialMovement
=============
*/
export function PM_CheckSpecialMovement(): void {
  const spot = vec3();
  const flatforward = vec3();

  if (pm.s.pm_time) return;

  pml.ladder = false;

  // check for ladder
  flatforward[0] = pml.forward[0];
  flatforward[1] = pml.forward[1];
  flatforward[2] = 0;
  VectorNormalize(flatforward);

  VectorMA(pml.origin, 1, flatforward, spot);
  const trace = pm.trace(pml.origin, pm.mins, pm.maxs, spot);
  if (trace.fraction < 1 && trace.contents & CONTENTS_LADDER) pml.ladder = true;

  // check for water jump
  if (pm.waterlevel !== 2) return;

  VectorMA(pml.origin, 30, flatforward, spot);
  spot[2] += 4;
  let cont = pm.pointcontents(spot);
  if (!(cont & CONTENTS_SOLID)) return;

  spot[2] += 16;
  cont = pm.pointcontents(spot);
  if (cont) return;
  // jump out of water
  VectorScale(flatforward, 50, pml.velocity);
  pml.velocity[2] = 350;

  pm.s.pm_flags |= PMF_TIME_WATERJUMP;
  pm.s.pm_time = 255;
}

/*
===============
PM_FlyMove
===============
*/
export function PM_FlyMove(doclip: boolean): void {
  pm.viewheight = 22;

  // friction
  const speed = VectorLength(pml.velocity);
  if (speed < 1) {
    VectorClear(pml.velocity);
  } else {
    const friction = pm_friction * 1.5; // extra friction
    const control = speed < pm_stopspeed ? pm_stopspeed : speed;
    const drop = control * friction * pml.frametime;

    // scale the velocity
    let newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;

    VectorScale(pml.velocity, newspeed, pml.velocity);
  }

  // accelerate
  const fmove = pm.cmd.forwardmove;
  const smove = pm.cmd.sidemove;

  VectorNormalize(pml.forward);
  VectorNormalize(pml.right);

  const wishvel = vec3();
  for (let i = 0; i < 3; i++) wishvel[i] = pml.forward[i] * fmove + pml.right[i] * smove;
  wishvel[2] += pm.cmd.upmove;

  const wishdir = vec3();
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  //
  // clamp to server defined max speed
  //
  if (wishspeed > pm_maxspeed) {
    VectorScale(wishvel, pm_maxspeed / wishspeed, wishvel);
    wishspeed = pm_maxspeed;
  }

  const currentspeed = DotProduct(pml.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = pm_accelerate * pml.frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) pml.velocity[i] += accelspeed * wishdir[i];

  if (doclip) {
    const end = vec3();
    for (let i = 0; i < 3; i++) end[i] = pml.origin[i] + pml.frametime * pml.velocity[i];

    const trace = pm.trace(pml.origin, pm.mins, pm.maxs, end);

    VectorCopy(trace.endpos, pml.origin);
  } else {
    // move
    VectorMA(pml.origin, pml.frametime, pml.velocity, pml.origin);
  }
}

/*
==============
PM_CheckDuck

Sets mins, maxs, and pm->viewheight
==============
*/
export function PM_CheckDuck(): void {
  pm.mins[0] = -16;
  pm.mins[1] = -16;

  pm.maxs[0] = 16;
  pm.maxs[1] = 16;

  if (pm.s.pm_type === PmTypeT.PM_GIB) {
    pm.mins[2] = 0;
    pm.maxs[2] = 16;
    pm.viewheight = 8;
    return;
  }

  pm.mins[2] = -24;

  if (pm.s.pm_type === PmTypeT.PM_DEAD) {
    pm.s.pm_flags |= PMF_DUCKED;
  } else if (pm.cmd.upmove < 0 && (pm.s.pm_flags & PMF_ON_GROUND)) {
    // duck
    pm.s.pm_flags |= PMF_DUCKED;
  } else {
    // stand up if possible
    if (pm.s.pm_flags & PMF_DUCKED) {
      // try to stand up
      pm.maxs[2] = 32;
      const trace = pm.trace(pml.origin, pm.mins, pm.maxs, pml.origin);
      if (!trace.allsolid) pm.s.pm_flags &= ~PMF_DUCKED;
    }
  }

  if (pm.s.pm_flags & PMF_DUCKED) {
    pm.maxs[2] = 4;
    pm.viewheight = -2;
  } else {
    pm.maxs[2] = 32;
    pm.viewheight = 22;
  }
}

/*
==============
PM_DeadMove
==============
*/
export function PM_DeadMove(): void {
  if (!pm.groundentity) return;

  // extra friction
  let forward = VectorLength(pml.velocity);
  forward -= 20;
  if (forward <= 0) {
    VectorClear(pml.velocity);
  } else {
    VectorNormalize(pml.velocity);
    VectorScale(pml.velocity, forward, pml.velocity);
  }
}

export function PM_GoodPosition(): boolean {
  if (pm.s.pm_type === PmTypeT.PM_SPECTATOR) return true;

  const origin = vec3();
  const end = vec3();
  for (let i = 0; i < 3; i++) origin[i] = end[i] = pm.s.origin[i] * 0.125;
  const trace = pm.trace(origin, pm.mins, pm.maxs, end);

  return !trace.allsolid;
}

/*
================
PM_SnapPosition

On exit, the origin will have a value that is pre-quantized to the 0.125
precision of the network channel and in a valid position.
================
*/
// try all single bits first
const jitterbits: readonly number[] = fixedLength("jitterbits", 8, [0, 4, 1, 2, 3, 5, 6, 7]);

export function PM_SnapPosition(): void {
  const sign = [0, 0, 0];
  const base = new Int16Array(3);

  // snap velocity to eigths
  for (let i = 0; i < 3; i++) pm.s.velocity[i] = pml.velocity[i] * 8;

  for (let i = 0; i < 3; i++) {
    sign[i] = pml.origin[i] >= 0 ? 1 : -1;
    pm.s.origin[i] = pml.origin[i] * 8;
    if (pm.s.origin[i] * 0.125 === pml.origin[i]) sign[i] = 0;
  }
  for (let i = 0; i < 3; i++) base[i] = pm.s.origin[i];

  // try all combinations
  for (let j = 0; j < 8; j++) {
    const bits = jitterbits[j];
    for (let i = 0; i < 3; i++) pm.s.origin[i] = base[i];
    for (let i = 0; i < 3; i++) if (bits & (1 << i)) pm.s.origin[i] += sign[i];

    if (PM_GoodPosition()) return;
  }

  // go back to the last position
  for (let i = 0; i < 3; i++) pm.s.origin[i] = pml.previous_origin[i];
  // Com_DPrintf ("using previous_origin\n") — Com_DPrintf lives in the future
  // src/qcommon/common.ts; dropped here per PORTING.md.
}

/*
================
PM_InitialSnapPosition

================
*/
// #if 0 branch (the old triple-nested z/y/x=1..-1 search) is dropped per
// PORTING.md; only the active `#else` implementation below is ported.
const offset: readonly number[] = fixedLength("offset", 3, [0, -1, 1]);

export function PM_InitialSnapPosition(): void {
  const base = new Int16Array(3);
  for (let i = 0; i < 3; i++) base[i] = pm.s.origin[i];

  for (let z = 0; z < 3; z++) {
    pm.s.origin[2] = base[2] + offset[z];
    for (let y = 0; y < 3; y++) {
      pm.s.origin[1] = base[1] + offset[y];
      for (let x = 0; x < 3; x++) {
        pm.s.origin[0] = base[0] + offset[x];
        if (PM_GoodPosition()) {
          pml.origin[0] = pm.s.origin[0] * 0.125;
          pml.origin[1] = pm.s.origin[1] * 0.125;
          pml.origin[2] = pm.s.origin[2] * 0.125;
          for (let i = 0; i < 3; i++) pml.previous_origin[i] = pm.s.origin[i];
          return;
        }
      }
    }
  }

  // Com_DPrintf("Bad InitialSnapPosition\n") dropped — see PORTING.md.
}

/*
================
PM_ClampAngles

================
*/
export function PM_ClampAngles(): void {
  if (pm.s.pm_flags & PMF_TIME_TELEPORT) {
    pm.viewangles[YAW] = SHORT2ANGLE(pm.cmd.angles[YAW] + pm.s.delta_angles[YAW]);
    pm.viewangles[PITCH] = 0;
    pm.viewangles[ROLL] = 0;
  } else {
    // circularly clamp the angles with deltas
    for (let i = 0; i < 3; i++) {
      const temp = toShort(pm.cmd.angles[i] + pm.s.delta_angles[i]);
      pm.viewangles[i] = SHORT2ANGLE(temp);
    }

    // don't let the player look up or down more than 90 degrees
    if (pm.viewangles[PITCH] > 89 && pm.viewangles[PITCH] < 180) pm.viewangles[PITCH] = 89;
    else if (pm.viewangles[PITCH] < 271 && pm.viewangles[PITCH] >= 180) pm.viewangles[PITCH] = 271;
  }
  AngleVectors(pm.viewangles, pml.forward, pml.right, pml.up);
}

/*
================
Pmove

Can be called by either the server or the client
================
*/
export function Pmove(pmove: PmoveT): void {
  pm = pmove;

  // clear results
  pm.numtouch = 0;
  VectorClear(pm.viewangles);
  pm.viewheight = 0;
  pm.groundentity = null;
  pm.watertype = 0;
  pm.waterlevel = 0;

  // clear all pmove local vars
  pml = new PmlT();

  // convert origin and velocity to float values
  pml.origin[0] = pm.s.origin[0] * 0.125;
  pml.origin[1] = pm.s.origin[1] * 0.125;
  pml.origin[2] = pm.s.origin[2] * 0.125;

  pml.velocity[0] = pm.s.velocity[0] * 0.125;
  pml.velocity[1] = pm.s.velocity[1] * 0.125;
  pml.velocity[2] = pm.s.velocity[2] * 0.125;

  // save old org in case we get stuck
  for (let i = 0; i < 3; i++) pml.previous_origin[i] = pm.s.origin[i];

  pml.frametime = pm.cmd.msec * 0.001;

  PM_ClampAngles();

  if (pm.s.pm_type === PmTypeT.PM_SPECTATOR) {
    PM_FlyMove(false);
    PM_SnapPosition();
    return;
  }

  if (pm.s.pm_type >= PmTypeT.PM_DEAD) {
    pm.cmd.forwardmove = 0;
    pm.cmd.sidemove = 0;
    pm.cmd.upmove = 0;
  }

  if (pm.s.pm_type === PmTypeT.PM_FREEZE) return; // no movement at all

  // set mins, maxs, and viewheight
  PM_CheckDuck();

  if (pm.snapinitial) PM_InitialSnapPosition();

  // set groundentity, watertype, and waterlevel
  PM_CatagorizePosition();

  if (pm.s.pm_type === PmTypeT.PM_DEAD) PM_DeadMove();

  PM_CheckSpecialMovement();

  // drop timing counter
  if (pm.s.pm_time) {
    let msec = pm.cmd.msec >> 3;
    if (!msec) msec = 1;
    if (msec >= pm.s.pm_time) {
      pm.s.pm_flags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_TELEPORT);
      pm.s.pm_time = 0;
    } else {
      pm.s.pm_time -= msec;
    }
  }

  if (pm.s.pm_flags & PMF_TIME_TELEPORT) {
    // teleport pause stays exactly in place
  } else if (pm.s.pm_flags & PMF_TIME_WATERJUMP) {
    // waterjump has no control, but falls
    pml.velocity[2] -= pm.s.gravity * pml.frametime;
    if (pml.velocity[2] < 0) {
      // cancel as soon as we are falling down again
      pm.s.pm_flags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_TELEPORT);
      pm.s.pm_time = 0;
    }

    PM_StepSlideMove();
  } else {
    PM_CheckJump();

    PM_Friction();

    if (pm.waterlevel >= 2) {
      PM_WaterMove();
    } else {
      const angles = vec3();

      VectorCopy(pm.viewangles, angles);
      if (angles[PITCH] > 180) angles[PITCH] = angles[PITCH] - 360;
      angles[PITCH] /= 3;

      AngleVectors(angles, pml.forward, pml.right, pml.up);

      PM_AirMove();
    }
  }

  // set groundentity, watertype, and waterlevel for final spot
  PM_CatagorizePosition();

  PM_SnapPosition();
}
