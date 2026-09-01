/*
Unit tests for the ported particle/dlight/lightstyle system (cl_fx.ts),
the rail trail (also cl_fx.ts), and CL_ParseTEnt's temp-entity dispatch
(cl_tent.ts). Self-sufficient per .orch/preferences.md rule 13: every test
resets the module-level state it reads (particleList, cl_dlights,
cl_lightstyle, net_message) instead of relying on execution order.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, VectorLength, VectorSubtract } from "../src/shared/math";
import { CS_LIGHTS, MAX_QPATH, TempEventT } from "../src/shared/q_shared";
import { SZ_Clear, MSG_WriteByte, MSG_WritePos, MSG_BeginReading } from "../src/qcommon/sizebuf";
import { cl, cl_dlights } from "../src/client/client";
import { net_message } from "../src/qcommon/net_chan";
import { MAX_PARTICLES } from "../src/client/ref";
import {
  CL_ClearParticles,
  CL_ClearDlights,
  CL_ParticleEffect,
  CL_AllocDlight,
  CL_SetLightstyle,
  CL_RunLightStyles,
  CL_RailTrail,
  cl_lightstyle,
  particleList,
} from "../src/client/cl_fx";
import { CL_ParseTEnt, cl_explosions, ExptypeT } from "../src/client/cl_tent";

interface Chainable {
  next: Chainable | null;
}

function countChain(head: Chainable | null): number {
  let n = 0;
  let p = head;
  while (p) {
    n++;
    p = p.next;
  }
  return n;
}

describe("CL_ClearParticles / particle free list", () => {
  beforeEach(() => {
    CL_ClearParticles();
  });

  test("rebuilds the full free list and empties the active list", () => {
    expect(countChain(particleList.free)).toBe(MAX_PARTICLES);
    expect(particleList.active).toBeNull();
  });

  test("exhausting the free list does not crash and caps active count at MAX_PARTICLES", () => {
    const org = vec3(0, 0, 0);
    const dir = vec3(0, 0, 1);
    // Ask for far more particles than exist; CL_ParticleEffect must bail
    // out silently (matching the C `if (!free_particles) return;` guard)
    // rather than throwing or wrapping around.
    expect(() => CL_ParticleEffect(org, dir, 0, MAX_PARTICLES + 500)).not.toThrow();

    expect(particleList.free).toBeNull();
    expect(countChain(particleList.active)).toBe(MAX_PARTICLES);

    // Calling again once truly exhausted is still a no-op, not a crash.
    expect(() => CL_ParticleEffect(org, dir, 0, 10)).not.toThrow();
    expect(countChain(particleList.active)).toBe(MAX_PARTICLES);
  });
});

describe("CL_ParticleEffect", () => {
  beforeEach(() => {
    CL_ClearParticles();
    cl.time = 12345;
  });

  test("consumes exactly N particles and sets org/vel/color within C's bounds", () => {
    const org = vec3(100, 200, 300);
    const dir = vec3(0, 0, 1);
    const color = 0x40;
    const count = 50;

    CL_ParticleEffect(org, dir, color, count);

    expect(countChain(particleList.active)).toBe(count);
    expect(countChain(particleList.free)).toBe(MAX_PARTICLES - count);

    let p = particleList.active;
    let seen = 0;
    while (p) {
      seen++;
      expect(p.time).toBe(12345);

      // color = color + (rand()&7) -> [color, color+7]
      expect(p.color).toBeGreaterThanOrEqual(color);
      expect(p.color).toBeLessThanOrEqual(color + 7);

      // vel[j] = crand()*20 -> (-20, 20)
      for (let j = 0; j < 3; j++) {
        expect(p.vel[j]).toBeGreaterThan(-20);
        expect(p.vel[j]).toBeLessThan(20);
      }

      // org[j] = org[j] + ((rand()&7)-4) + d*dir[j], d = rand()&31 in [0,31]
      // dir is a pure +Z unit vector here, so X/Y only get the +-4 jitter
      // term and Z additionally gets up to 31 units along dir.
      expect(p.org[0]).toBeGreaterThanOrEqual(org[0] - 4);
      expect(p.org[0]).toBeLessThanOrEqual(org[0] + 3);
      expect(p.org[1]).toBeGreaterThanOrEqual(org[1] - 4);
      expect(p.org[1]).toBeLessThanOrEqual(org[1] + 3);
      expect(p.org[2]).toBeGreaterThanOrEqual(org[2] - 4);
      expect(p.org[2]).toBeLessThanOrEqual(org[2] + 3 + 31);

      // accel is (0,0,-PARTICLE_GRAVITY), alpha starts at 1
      expect(p.accel[0]).toBe(0);
      expect(p.accel[1]).toBe(0);
      expect(p.accel[2]).toBe(-40);
      expect(p.alpha).toBe(1.0);

      // alphavel = -1/(0.5+frand()*0.3) -> [-2, -1.25]
      expect(p.alphavel).toBeLessThanOrEqual(-1.25);
      expect(p.alphavel).toBeGreaterThanOrEqual(-2.0001);

      p = p.next;
    }
    expect(seen).toBe(count);
  });
});

describe("CL_AllocDlight", () => {
  beforeEach(() => {
    CL_ClearDlights();
  });

  test("reuses the same slot for a repeated key", () => {
    cl.time = 1000;
    const dl1 = CL_AllocDlight(7);
    dl1.radius = 999;
    dl1.color[0] = 0.5;

    const dl2 = CL_AllocDlight(7);
    expect(dl2).toBe(dl1);
    // CL_AllocDlight memsets the slot before returning it, so the stale
    // radius/color from the previous owner must be gone.
    expect(dl2.radius).toBe(0);
    expect(dl2.color[0]).toBe(0);
    expect(dl2.key).toBe(7);
  });

  test("a different key does not collide with a live light", () => {
    cl.time = 1000;
    const dl1 = CL_AllocDlight(1);
    dl1.die = cl.time + 500; // still alive

    const dl2 = CL_AllocDlight(2);
    expect(dl2).not.toBe(dl1);
    expect(dl2.key).toBe(2);
  });

  test("an expired light's slot is recycled for a new key", () => {
    cl.time = 1000;
    const dl1 = CL_AllocDlight(3);
    dl1.die = 500; // already expired relative to cl.time

    cl.time = 1000;
    const dl2 = CL_AllocDlight(4);
    expect(dl2).toBe(dl1);
    expect(dl2.key).toBe(4);
  });

  test("cl_dlights is the backing array CL_AllocDlight hands out slots from", () => {
    cl.time = 1;
    const dl = CL_AllocDlight(9);
    expect(cl_dlights).toContain(dl);
  });
});

describe("lightstyle parsing", () => {
  test("CL_SetLightstyle decodes a configstring into the a..m wave table", () => {
    const styleIndex = 3;
    // 'a' -> 0.0, 'm' -> 1.0 (map[k] = (ch-'a')/('m'-'a')); 'z' would exceed
    // that range but the engine only ever sends a..z-clamped animation
    // strings in practice -- use a..m to stay within the documented range.
    cl.configstrings[styleIndex + CS_LIGHTS] = "am";

    CL_SetLightstyle(styleIndex);

    const ls = cl_lightstyle[styleIndex];
    expect(ls.length).toBe(2);
    expect(ls.map[0]).toBeCloseTo(0.0, 5);
    expect(ls.map[1]).toBeCloseTo(1.0, 5);
  });

  test("CL_SetLightstyle rejects an over-length configstring", () => {
    const styleIndex = 4;
    cl.configstrings[styleIndex + CS_LIGHTS] = "a".repeat(MAX_QPATH);
    expect(() => CL_SetLightstyle(styleIndex)).toThrow();
  });

  test("CL_RunLightStyles cycles the wave into ls.value on a 100ms tick", () => {
    const styleIndex = 5;
    cl.configstrings[styleIndex + CS_LIGHTS] = "am"; // map = [0.0, 1.0]

    CL_SetLightstyle(styleIndex);

    cl.time = 0; // ofs = 0 -> map[0 % 2] = 0.0
    CL_RunLightStyles();
    let ls = cl_lightstyle[styleIndex];
    expect(ls.value[0]).toBeCloseTo(0.0, 5);
    expect(ls.value[1]).toBeCloseTo(0.0, 5);
    expect(ls.value[2]).toBeCloseTo(0.0, 5);

    cl.time = 100; // ofs = 1 -> map[1 % 2] = 1.0
    CL_RunLightStyles();
    ls = cl_lightstyle[styleIndex];
    expect(ls.value[0]).toBeCloseTo(1.0, 5);
  });

  test("a style with length 0 defaults to full bright (1.0)", () => {
    const styleIndex = 6;
    cl_lightstyle[styleIndex].length = 0;
    cl.time = 999900; // force a fresh ofs so CL_RunLightStyles doesn't early-return
    CL_RunLightStyles();
    const ls = cl_lightstyle[styleIndex];
    expect(ls.value[0]).toBe(1.0);
    expect(ls.value[1]).toBe(1.0);
    expect(ls.value[2]).toBe(1.0);
  });
});

describe("CL_RailTrail", () => {
  beforeEach(() => {
    CL_ClearParticles();
    cl.time = 500;
  });

  test("plants particles along the segment, close to the line", () => {
    const start = vec3(0, 0, 0);
    const end = vec3(0, 0, 10); // short, straight-up segment: len == 10

    CL_RailTrail(start, end);

    const planted = countChain(particleList.active);
    expect(planted).toBeGreaterThan(0);

    const segLen = VectorLength((() => {
      const d = vec3();
      VectorSubtract(end, start, d);
      return d;
    })());

    // Every planted particle should sit within a small radius of the
    // start->end line (the spiral offset is capped at a few units; the
    // corkscrew ring uses `dir*3`, the sparkle tail uses `crand()*3`) and
    // not drift far past either endpoint along Z.
    let p = particleList.active;
    while (p) {
      const distFromAxis = Math.sqrt(p.org[0] * p.org[0] + p.org[1] * p.org[1]);
      expect(distFromAxis).toBeLessThan(10);
      expect(p.org[2]).toBeGreaterThan(-5);
      expect(p.org[2]).toBeLessThan(segLen + 5);
      p = p.next;
    }
  });
});

describe("CL_ParseTEnt(TE_EXPLOSION1)", () => {
  beforeEach(() => {
    CL_ClearParticles();
    cl.time = 7000;
    cl.frame.servertime = 7000;
    SZ_Clear(net_message);
  });

  test("allocates an explosion slot from a hand-written wire message", () => {
    // Build the message the same way the server would: writer/reader
    // symmetry over net_message, per PORTING.md's SizeBuf convention.
    MSG_WriteByte(net_message, TempEventT.TE_EXPLOSION1);
    MSG_WritePos(net_message, vec3(64, -32, 128));
    MSG_BeginReading(net_message);

    // S_StartSound (snd_dma.ts) is a real implementation now; CL_ParseTEnt's
    // TE_EXPLOSION1 branch calls it after the explosion is already
    // allocated and populated, and the whole parse path completes cleanly.
    expect(() => CL_ParseTEnt()).not.toThrow();

    const ex = cl_explosions.find((e) => e.type === ExptypeT.ex_poly && e.ent.origin[0] === 64 && e.ent.origin[1] === -32 && e.ent.origin[2] === 128);
    expect(ex).toBeDefined();
    expect(ex?.frames).toBe(15);
    expect(ex?.light).toBe(350);
  });

  test("bad temp-entity type throws", () => {
    MSG_WriteByte(net_message, 250); // not a valid TempEventT value
    MSG_BeginReading(net_message);
    expect(() => CL_ParseTEnt()).toThrow();
  });
});
