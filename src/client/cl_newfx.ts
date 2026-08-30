// cl_newfx.c -- MORE entity effects parsing and management

import {
  type Vec3,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorSubtract,
  VectorAdd,
  VectorClear,
  VectorMA,
  VectorScale,
  VectorNormalize,
  DotProduct,
  AngleVectors,
} from "../shared/math";
import { frand, crand } from "../qcommon/common";
import { PITCH, YAW, ROLL, VIDREF_GL } from "../shared/q_shared";
import { cl, PARTICLE_GRAVITY, INSTANT_PARTICLE, type ClSustainT, type CentityT } from "./client";
import { rand, particleList, MakeNormalVectors, CL_AllocDlight } from "./cl_fx";
import { fixedLength } from "../shared/fixed";

// `extern int vidref_val` -- see cl_fx.ts's CL_AddDLights banner: no GL
// renderer exists in this port (ref_gl/ is not ported per PORTING.md), so
// the ref_gl-only RINGS offset branch below never takes the GL path.
// Reported deviation, matching cl_fx.ts's.
const vidref_val: number = 0;

/*
======
vectoangles2 - this is duplicated in the game DLL, but I need it here.
======
*/
function vectoangles2(value1: Vec3, angles: Vec3): void {
  let yaw: number;
  let pitch: number;

  if (value1[1] === 0 && value1[0] === 0) {
    yaw = 0;
    pitch = value1[2] > 0 ? 90 : 270;
  } else {
    // PMM - fixed to correct for pitch of 0
    if (value1[0]) {
      yaw = (Math.atan2(value1[1], value1[0]) * 180) / Math.PI;
    } else if (value1[1] > 0) {
      yaw = 90;
    } else {
      yaw = 270;
    }

    if (yaw < 0) yaw += 360;

    const forward = Math.sqrt(value1[0] * value1[0] + value1[1] * value1[1]);
    pitch = (Math.atan2(value1[2], forward) * 180) / Math.PI;
    if (pitch < 0) pitch += 360;
  }

  angles[PITCH] = -pitch;
  angles[YAW] = yaw;
  angles[ROLL] = 0;
}

//=============
//=============
export function CL_Flashlight(ent: number, pos: Vec3): void {
  const dl = CL_AllocDlight(ent);
  VectorCopy(pos, dl.origin);
  dl.radius = 400;
  dl.minlight = 250;
  dl.die = cl.time + 100;
  dl.color[0] = 1;
  dl.color[1] = 1;
  dl.color[2] = 1;
}

/*
======
CL_ColorFlash - flash of light
======
*/
export function CL_ColorFlash(pos: Vec3, ent: number, intensityIn: number, rIn: number, gIn: number, bIn: number): void {
  let intensity = intensityIn;
  let r = rIn;
  let g = gIn;
  let b = bIn;

  if (vidref_val === VIDREF_GL && (r < 0 || g < 0 || b < 0)) {
    intensity = -intensity;
    r = -r;
    g = -g;
    b = -b;
  }

  const dl = CL_AllocDlight(ent);
  VectorCopy(pos, dl.origin);
  dl.radius = intensity;
  dl.minlight = 250;
  dl.die = cl.time + 100;
  dl.color[0] = r;
  dl.color[1] = g;
  dl.color[2] = b;
}

/*
======
CL_DebugTrail
======
*/
export function CL_DebugTrail(start: Vec3, end: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const right = vec3();
  const up = vec3();
  MakeNormalVectors(vec, right, up);

  const dec = 3;
  VectorScale(vec, dec, vec);
  VectorCopy(start, move);

  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    VectorClear(p.accel);
    VectorClear(p.vel);
    p.alpha = 1.0;
    p.alphavel = -0.1;
    p.color = 0x74 + (rand() & 7);
    VectorCopy(move, p.org);

    VectorAdd(move, vec, move);
  }
}

/*
===============
CL_SmokeTrail
===============
*/
export function CL_SmokeTrail(start: Vec3, end: Vec3, colorStart: number, colorRun: number, spacing: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  VectorScale(vec, spacing, vec);

  // FIXME: this is a really silly way to have a loop
  while (len > 0) {
    len -= spacing;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (1 + frand() * 0.5);
    p.color = colorStart + (rand() % colorRun);
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 3;
      p.accel[j] = 0;
    }
    p.vel[2] = 20 + crand() * 5;

    VectorAdd(move, vec, move);
  }
}

export function CL_ForceWall(start: Vec3, end: Vec3, color: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  VectorScale(vec, 4, vec);

  // FIXME: this is a really silly way to have a loop
  while (len > 0) {
    len -= 4;

    if (!particleList.free) return;

    if (frand() > 0.3) {
      const p = particleList.free;
      particleList.free = p.next;
      p.next = particleList.active;
      particleList.active = p;
      VectorClear(p.accel);

      p.time = cl.time;

      p.alpha = 1.0;
      p.alphavel = -1.0 / (3.0 + frand() * 0.5);
      p.color = color;
      for (let j = 0; j < 3; j++) {
        p.org[j] = move[j] + crand() * 3;
        p.accel[j] = 0;
      }
      p.vel[0] = 0;
      p.vel[1] = 0;
      p.vel[2] = -40 - crand() * 10;
    }

    VectorAdd(move, vec, move);
  }
}

// `ent` is unused in the C body too (only `origin` is read) -- kept for
// signature fidelity with client.h's declaration.
export function CL_FlameEffects(_ent: CentityT, origin: Vec3): void {
  let count = rand() & 0xf;

  for (let n = 0; n < count; n++) {
    if (!particleList.free) return;

    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    VectorClear(p.accel);
    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (1 + frand() * 0.2);
    p.color = 226 + (rand() % 4);
    for (let j = 0; j < 3; j++) {
      p.org[j] = origin[j] + crand() * 5;
      p.vel[j] = crand() * 5;
    }
    p.vel[2] = crand() * -10;
    p.accel[2] = -PARTICLE_GRAVITY;
  }

  count = rand() & 0x7;

  for (let n = 0; n < count; n++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (1 + frand() * 0.5);
    p.color = 0 + (rand() % 4);
    for (let j = 0; j < 3; j++) {
      p.org[j] = origin[j] + crand() * 3;
    }
    p.vel[2] = 20 + crand() * 5;
  }
}

/*
===============
CL_GenericParticleEffect
===============
*/
export function CL_GenericParticleEffect(
  org: Vec3,
  dir: Vec3,
  color: number,
  count: number,
  numcolors: number,
  dirspread: number,
  alphavel: number,
): void {
  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    if (numcolors > 1) p.color = color + (rand() & numcolors);
    else p.color = color;

    const d = rand() & dirspread;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() & 7) - 4) + d * dir[j];
      p.vel[j] = crand() * 20;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * alphavel);
  }
}

/*
===============
CL_BubbleTrail2 (lets you control the # of bubbles by setting the distance between the spawns)

===============
*/
export function CL_BubbleTrail2(start: Vec3, end: Vec3, dist: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  const len = VectorNormalize(vec);

  const dec = dist;
  VectorScale(vec, dec, vec);

  for (let i = 0; i < len; i += dec) {
    if (!particleList.free) return;

    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    VectorClear(p.accel);
    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (1 + frand() * 0.1);
    p.color = 4 + (rand() & 7);
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 2;
      p.vel[j] = crand() * 10;
    }
    p.org[2] -= 4;
    p.vel[2] += 20;

    VectorAdd(move, vec, move);
  }
}

// Only RINGS is #define'd in cl_fx.c's upstream build (CORKSCREW and SPRAY
// are alternate #ifdef'd bodies that are never compiled); the RINGS body is
// the one faithfully ported here. Dropped #ifdef branches (CORKSCREW,
// SPRAY) reported per PORTING.md's "#ifdef ... take the portable path; list
// dropped branches" rule.
export function CL_Heatbeam(start: Vec3, forward: Vec3): void {
  const step = 32.0;

  const end = vec3();
  VectorMA(start, 4096, forward, end);

  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  const len = VectorNormalize(vec);

  // FIXME - pmm - these might end up using old values?
  const right = vec3();
  const up = vec3();
  VectorCopy(cl.v_right, right);
  VectorCopy(cl.v_up, up);
  if (vidref_val === VIDREF_GL) {
    // GL mode
    VectorMA(move, -0.5, right, move);
    VectorMA(move, -0.5, up, move);
  }
  // otherwise assume SOFT

  const ltime = cl.time / 1000.0;
  const start_pt = ltime * 96.0 % step;
  VectorMA(move, start_pt, vec, move);

  VectorScale(vec, step, vec);

  const rstep = Math.PI / 10.0;
  for (let i = start_pt; i < len; i += step) {
    if (i > step * 5) break; // don't bother after the 5th ring

    for (let rot = 0; rot < Math.PI * 2; rot += rstep) {
      if (!particleList.free) return;

      const p = particleList.free;
      particleList.free = p.next;
      p.next = particleList.active;
      particleList.active = p;

      p.time = cl.time;
      VectorClear(p.accel);
      const variance = 0.5;
      const c = Math.cos(rot) * variance;
      const s = Math.sin(rot) * variance;

      const dir = vec3();
      // trim it so it looks like it's starting at the origin
      if (i < 10) {
        VectorScale(right, c * (i / 10.0), dir);
        VectorMA(dir, s * (i / 10.0), up, dir);
      } else {
        VectorScale(right, c, dir);
        VectorMA(dir, s, up, dir);
      }

      p.alpha = 0.5;
      p.alphavel = -1000.0;
      p.color = 223 - (rand() & 7);
      for (let j = 0; j < 3; j++) {
        p.org[j] = move[j] + dir[j] * 3;
        p.vel[j] = 0;
      }
    }
    VectorAdd(move, vec, move);
  }
}

/*
===============
CL_ParticleSteamEffect

Puffs with velocity along direction, with some randomness thrown in
===============
*/
export function CL_ParticleSteamEffect(org: Vec3, dir: Vec3, color: number, count: number, magnitude: number): void {
  const r = vec3();
  const u = vec3();
  MakeNormalVectors(dir, r, u);

  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color + (rand() & 7);

    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + magnitude * 0.1 * crand();
    }
    VectorScale(dir, magnitude, p.vel);
    let d = (crand() * magnitude) / 3;
    VectorMA(p.vel, d, r, p.vel);
    d = (crand() * magnitude) / 3;
    VectorMA(p.vel, d, u, p.vel);

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY / 2;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

export function CL_ParticleSteamEffect2(self: ClSustainT): void {
  const dir = vec3();
  VectorCopy(self.dir, dir);
  const r = vec3();
  const u = vec3();
  MakeNormalVectors(dir, r, u);

  for (let i = 0; i < self.count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = self.color + (rand() & 7);

    for (let j = 0; j < 3; j++) {
      p.org[j] = self.org[j] + self.magnitude * 0.1 * crand();
    }
    VectorScale(dir, self.magnitude, p.vel);
    let d = (crand() * self.magnitude) / 3;
    VectorMA(p.vel, d, r, p.vel);
    d = (crand() * self.magnitude) / 3;
    VectorMA(p.vel, d, u, p.vel);

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY / 2;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
  self.nextthink += self.thinkinterval;
}

/*
===============
CL_TrackerTrail
===============
*/
export function CL_TrackerTrail(start: Vec3, end: Vec3, particleColor: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const forward = vec3();
  VectorCopy(vec, forward);
  const angle_dir = vec3();
  vectoangles2(forward, angle_dir);
  const right = vec3();
  const up = vec3();
  AngleVectors(angle_dir, forward, right, up);

  const dec = 3;
  VectorScale(vec, 3, vec);

  // FIXME: this is a really silly way to have a loop
  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -2.0;
    p.color = particleColor;
    const dist = DotProduct(move, forward);
    VectorMA(move, 8 * Math.cos(dist), up, p.org);
    for (let j = 0; j < 3; j++) {
      p.vel[j] = 0;
      p.accel[j] = 0;
    }
    p.vel[2] = 5;

    VectorAdd(move, vec, move);
  }
}

export function CL_Tracker_Shell(origin: Vec3): void {
  for (let i = 0; i < 300; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = INSTANT_PARTICLE;
    p.color = 0;

    const dir = vec3();
    dir[0] = crand();
    dir[1] = crand();
    dir[2] = crand();
    VectorNormalize(dir);

    VectorMA(origin, 40, dir, p.org);
  }
}

export function CL_MonsterPlasma_Shell(origin: Vec3): void {
  for (let i = 0; i < 40; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = INSTANT_PARTICLE;
    p.color = 0xe0;

    const dir = vec3();
    dir[0] = crand();
    dir[1] = crand();
    dir[2] = crand();
    VectorNormalize(dir);

    VectorMA(origin, 10, dir, p.org);
  }
}

const widowbeamoutColortable = fixedLength("widowbeamoutColortable", 4, [2 * 8, 13 * 8, 21 * 8, 18 * 8]);

export function CL_Widowbeamout(self: ClSustainT): void {
  const ratio = 1.0 - (self.endtime - cl.time) / 2100.0;

  for (let i = 0; i < 300; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = INSTANT_PARTICLE;
    p.color = widowbeamoutColortable[rand() & 3];

    const dir = vec3();
    dir[0] = crand();
    dir[1] = crand();
    dir[2] = crand();
    VectorNormalize(dir);

    VectorMA(self.org, 45.0 * ratio, dir, p.org);
  }
}

const nukeblastColortable = fixedLength("nukeblastColortable", 4, [110, 112, 114, 116]);

export function CL_Nukeblast(self: ClSustainT): void {
  const ratio = 1.0 - (self.endtime - cl.time) / 1000.0;

  for (let i = 0; i < 700; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = INSTANT_PARTICLE;
    p.color = nukeblastColortable[rand() & 3];

    const dir = vec3();
    dir[0] = crand();
    dir[1] = crand();
    dir[2] = crand();
    VectorNormalize(dir);

    VectorMA(self.org, 200.0 * ratio, dir, p.org);
  }
}

const widowSplashColortable = fixedLength("widowSplashColortable", 4, [2 * 8, 13 * 8, 21 * 8, 18 * 8]);

export function CL_WidowSplash(org: Vec3): void {
  for (let i = 0; i < 256; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = widowSplashColortable[rand() & 3];

    const dir = vec3();
    dir[0] = crand();
    dir[1] = crand();
    dir[2] = crand();
    VectorNormalize(dir);
    VectorMA(org, 45.0, dir, p.org);
    VectorMA(vec3_origin, 40.0, dir, p.vel);

    p.accel[0] = p.accel[1] = 0;
    p.alpha = 1.0;

    p.alphavel = -0.8 / (0.5 + frand() * 0.3);
  }
}

export function CL_Tracker_Explode(origin: Vec3): void {
  for (let i = 0; i < 300; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0;
    p.color = 0;

    const dir = vec3();
    dir[0] = crand();
    dir[1] = crand();
    dir[2] = crand();
    VectorNormalize(dir);
    const backdir = vec3();
    VectorScale(dir, -1, backdir);

    VectorMA(origin, 64, dir, p.org);
    VectorScale(backdir, 64, p.vel);
  }
}

/*
===============
CL_TagTrail

===============
*/
export function CL_TagTrail(start: Vec3, end: Vec3, color: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  while (len >= 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.8 + frand() * 0.2);
    p.color = color;
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 16;
      p.vel[j] = crand() * 5;
      p.accel[j] = 0;
    }

    VectorAdd(move, vec, move);
  }
}

/*
===============
CL_ColorExplosionParticles
===============
*/
export function CL_ColorExplosionParticles(org: Vec3, color: number, run: number): void {
  for (let i = 0; i < 128; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color + (rand() % run);

    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() % 32) - 16);
      p.vel[j] = (rand() % 256) - 128;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -0.4 / (0.6 + frand() * 0.2);
  }
}

/*
===============
CL_ParticleSmokeEffect - like the steam effect, but unaffected by gravity
===============
*/
export function CL_ParticleSmokeEffect(org: Vec3, dir: Vec3, color: number, count: number, magnitude: number): void {
  const r = vec3();
  const u = vec3();
  MakeNormalVectors(dir, r, u);

  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color + (rand() & 7);

    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + magnitude * 0.1 * crand();
    }
    VectorScale(dir, magnitude, p.vel);
    let d = (crand() * magnitude) / 3;
    VectorMA(p.vel, d, r, p.vel);
    d = (crand() * magnitude) / 3;
    VectorMA(p.vel, d, u, p.vel);

    p.accel[0] = p.accel[1] = p.accel[2] = 0;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

/*
===============
CL_BlasterParticles2

Wall impact puffs (Green)
===============
*/
export function CL_BlasterParticles2(org: Vec3, dir: Vec3, color: number): void {
  const count = 40;
  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color + (rand() & 7);

    const d = rand() & 15;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() & 7) - 4) + d * dir[j];
      p.vel[j] = dir[j] * 30 + crand() * 40;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

/*
===============
CL_BlasterTrail2

Green!
===============
*/
export function CL_BlasterTrail2(start: Vec3, end: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  // FIXME: this is a really silly way to have a loop
  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.3 + frand() * 0.2);
    p.color = 0xd0;
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand();
      p.vel[j] = crand() * 5;
      p.accel[j] = 0;
    }

    VectorAdd(move, vec, move);
  }
}
