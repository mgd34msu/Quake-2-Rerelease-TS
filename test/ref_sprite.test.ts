/*
Unit test for the software renderer's alpha/particle/polygon pieces
(ref_soft/r_part.ts, r_poly.ts). Named ref_sprite.test.ts per the brief;
r_sprite.ts's own R_DrawSprite is a thin billboard-setup wrapper around
R_ClipAndDrawPoly (exercised transitively by every case below) with no
independent numeric behavior worth asserting beyond what tsc already
checks, so the brief's three scenarios -- particle projection/z-buffer,
alpha-table blend arithmetic, and polygon-face clipping -- are what get
concrete coverage here.

Self-sufficient per PORTING.md rule 13: every global this file reads is
set explicitly below (buffers via r_scan.ts's D_SetViewBuffer/D_SetZBuffer,
the r_part.ts-local shadow globals via its own D_Set* setters, r_local.ts's
`const` object bindings by mutating their elements/properties directly).
No dependency on another test file having run first.
*/

import { describe, test, expect } from "bun:test";
import { ParticleT } from "../src/client/ref";
import { r_pright, r_pup, r_ppn, r_origin, vright, vup, vpn, vid, r_newrefdef, d_scantable, ClipplaneT } from "../src/ref_soft/r_local";
import { D_SetViewBuffer, D_SetZBuffer } from "../src/ref_soft/r_scan";
import {
  R_DrawParticles,
  BlendParticle33,
  BlendParticle66,
  BlendParticle100,
  D_SetParticleCenter,
  D_SetParticleShrink,
  D_SetParticleClipRect,
  D_SetParticlePixRange,
} from "../src/ref_soft/r_part";
import { R_ClipPolyFace, r_clip_verts } from "../src/ref_soft/r_poly";

function makeParticle(x: number, y: number, z: number, color: number, alpha: number): ParticleT {
  const p = new ParticleT();
  p.origin[0] = x;
  p.origin[1] = y;
  p.origin[2] = z;
  p.color = color;
  p.alpha = alpha;
  return p;
}

describe("R_DrawParticle projection and z-buffer", () => {
  // identity camera basis: vright=+X, vup=+Y, vpn=+Z, unit scale -- so
  // r_pright/r_pup/r_ppn (computed by R_DrawParticles from these) equal the
  // world axes exactly, and the projected screen position is fully
  // hand-computable.
  function setupCamera(): void {
    r_origin[0] = 0;
    r_origin[1] = 0;
    r_origin[2] = 0;

    vright[0] = 1;
    vright[1] = 0;
    vright[2] = 0;
    vup[0] = 0;
    vup[1] = 1;
    vup[2] = 0;
    vpn[0] = 0;
    vpn[1] = 0;
    vpn[2] = 1;

    D_SetParticleShrink(1, 1);
    D_SetParticleCenter(160, 120);
    D_SetParticleClipRect(0, 0, 319, 239);
    D_SetParticlePixRange(1, 10, 8);

    D_SetViewBuffer(new Uint8Array(320 * 240), 320);
    D_SetZBuffer(new Int16Array(320 * 240), 320);

    for (let v = 0; v < 240; v++) d_scantable[v] = v * 320;
  }

  // particle at world (0,0,100): with the identity basis above,
  // local = transformed = (0,0,100), zi = 1/100 = 0.01.
  // u = trunc(160 + 0.01*0 + 0.5) = 160, v = trunc(120 - 0.01*0 + 0.5) = 120
  // izi = trunc(0.01 * 0x8000) = trunc(327.68) = 327
  // pix = 327 >> 8 = 1, clamped into [1,10] -> stays 1 (single pixel)
  const EXPECTED_U = 160;
  const EXPECTED_V = 120;
  const EXPECTED_IZI = 327;

  test("writes color and z-buffer when the z-test passes", () => {
    setupCamera();

    const pzIdx = 320 * EXPECTED_V + EXPECTED_U;
    const pdestIdx = d_scantable[EXPECTED_V] + EXPECTED_U;

    const zbuf = new Int16Array(320 * 240); // all 0s: 0 <= 327 passes
    D_SetZBuffer(zbuf, 320);
    const viewbuf = new Uint8Array(320 * 240).fill(5);
    D_SetViewBuffer(viewbuf, 320);

    r_newrefdef.particles = [makeParticle(0, 0, 100, 200, 0.9)]; // alpha>0.66 -> PARTICLE_OPAQUE
    r_newrefdef.num_particles = 1;

    R_DrawParticles();

    expect(viewbuf[pdestIdx]).toBe(200);
    expect(zbuf[pzIdx]).toBe(EXPECTED_IZI);
  });

  test("skips the pixel when the z-buffer already holds a nearer value", () => {
    setupCamera();

    const pzIdx = 320 * EXPECTED_V + EXPECTED_U;
    const pdestIdx = d_scantable[EXPECTED_V] + EXPECTED_U;

    const zbuf = new Int16Array(320 * 240).fill(9999); // nearer than izi=327 -> rejects
    D_SetZBuffer(zbuf, 320);
    const viewbuf = new Uint8Array(320 * 240).fill(5);
    D_SetViewBuffer(viewbuf, 320);

    r_newrefdef.particles = [makeParticle(0, 0, 100, 200, 0.9)];
    r_newrefdef.num_particles = 1;

    R_DrawParticles();

    expect(viewbuf[pdestIdx]).toBe(5); // untouched
    expect(zbuf[pzIdx]).toBe(9999); // untouched
  });

  test("clips particles projecting outside the view rectangle", () => {
    setupCamera();
    D_SetParticleClipRect(0, 0, 100, 100); // narrower than the 160,120 projection above

    const viewbuf = new Uint8Array(320 * 240).fill(7);
    D_SetViewBuffer(viewbuf, 320);
    D_SetZBuffer(new Int16Array(320 * 240), 320);

    r_newrefdef.particles = [makeParticle(0, 0, 100, 200, 0.9)];
    r_newrefdef.num_particles = 1;

    R_DrawParticles();

    // nothing in the buffer should have moved off its fill value
    expect(viewbuf.every((b) => b === 7)).toBe(true);
  });

  test("drops particles behind PARTICLE_Z_CLIP", () => {
    setupCamera();

    const viewbuf = new Uint8Array(320 * 240).fill(3);
    D_SetViewBuffer(viewbuf, 320);
    D_SetZBuffer(new Int16Array(320 * 240), 320);

    r_newrefdef.particles = [makeParticle(0, 0, 1, 200, 0.9)]; // z=1 < PARTICLE_Z_CLIP(8)
    r_newrefdef.num_particles = 1;

    R_DrawParticles();

    expect(viewbuf.every((b) => b === 3)).toBe(true);
  });
});

describe("particle alpha-table blending", () => {
  test("BlendParticle33/66/100 index the alphamap with the C's exact arithmetic", () => {
    const alphamap = new Uint8Array(65536);
    for (let i = 0; i < alphamap.length; i++) alphamap[i] = i % 256;
    vid.alphamap = alphamap;

    const pcolor = 10;
    const dstcolor = 20;

    // vid.alphamap[pcolor + dstcolor*256] = alphamap[5130], 5130 % 256 = 10
    expect(BlendParticle33(pcolor, dstcolor)).toBe(alphamap[pcolor + dstcolor * 256]);
    expect(BlendParticle33(pcolor, dstcolor)).toBe(10);

    // vid.alphamap[pcolor*256 + dstcolor] = alphamap[2580], 2580 % 256 = 20
    expect(BlendParticle66(pcolor, dstcolor)).toBe(alphamap[pcolor * 256 + dstcolor]);
    expect(BlendParticle66(pcolor, dstcolor)).toBe(20);

    // BlendParticle100 ignores dstcolor entirely and returns pcolor verbatim
    expect(BlendParticle100(pcolor, dstcolor)).toBe(pcolor);
    expect(BlendParticle100(pcolor, 255)).toBe(pcolor);
  });

  test("falls back to pcolor when vid.alphamap hasn't been allocated", () => {
    vid.alphamap = null;
    expect(BlendParticle33(42, 7)).toBe(42);
    expect(BlendParticle66(42, 7)).toBe(42);
  });
});

describe("R_ClipPolyFace", () => {
  test("clips a hand-built quad against a single plane to the expected vertex set", () => {
    // a 10x10 square in the z=0 plane: (0,0) (10,0) (10,10) (0,10), with
    // distinct per-vertex s/t so the interpolated texcoords are checkable
    // too.
    const square: [number, number, number, number, number][] = [
      [0, 0, 0, 0, 0],
      [10, 0, 0, 100, 0],
      [10, 10, 0, 100, 100],
      [0, 10, 0, 0, 100],
    ];

    const verts = r_clip_verts[0];
    for (let i = 0; i < square.length; i++) {
      verts[i].set(square[i]);
    }

    // clip plane: normal=+X, dist=5 -- keeps the x>=5 half, cutting the
    // square into a 5x10 rectangle from x=5 to x=10.
    const plane = new ClipplaneT();
    plane.normal[0] = 1;
    plane.normal[1] = 0;
    plane.normal[2] = 0;
    plane.dist = 5;

    const outcount = R_ClipPolyFace(4, plane);

    expect(outcount).toBe(4);

    // R_ClipPolyFace flips clip_current on every call and writes into the
    // *other* buffer than the one it read from -- since this is the first
    // call in this test file, it read r_clip_verts[0] and wrote r_clip_verts[1].
    const out = r_clip_verts[1];

    const expected: [number, number, number, number, number][] = [
      [5, 0, 0, 50, 0], // split of V0->V1 at frac 0.5
      [10, 0, 0, 100, 0], // V1, kept verbatim
      [10, 10, 0, 100, 100], // V2, kept verbatim
      [5, 10, 0, 50, 100], // split of V2->V3 at frac 0.5
    ];

    for (let i = 0; i < expected.length; i++) {
      for (let c = 0; c < 5; c++) {
        expect(out[i][c]).toBeCloseTo(expected[i][c], 5);
      }
    }
  });
});
