/*
Software renderer BSPX DECOUPLED_LM lighting -- src/ref_soft/r_model.ts's
SetupDecoupledLightmap and src/ref_soft/r_light.ts's R_BuildLightMap.

Regression origin: every rerelease map rendered near-black under `vid_ref
soft` (measured mean luminance ~1.7/255 for baseq2/maps/base1.bsp where the
GL renderer reads ~40-55). A rerelease BSP stores its lightmaps in the
ordinary LUMP_LIGHTING lump but sets the classic dface_t lightofs field to
-1 on EVERY face -- DECOUPLED_LM is the only record of where each face's
lightmap lives (verified against baseq2/maps/base1.bsp: 16787/16787 faces
with lightofs == -1, LUMP_LIGHTING 4335168 bytes, DECOUPLED_LM 671480
bytes == 16787 * 40).

The software renderer used to parse that lump and then ignore it, on the
belief that a face with no samples degraded to fullbright. It does not, and
the first test below pins exactly why: only R_BuildLightMap's r_fullbright /
"model has no lightdata at all" early-out leaves blocklights at 0, which is
the BRIGHTEST value in this renderer's inverted encoding. A lit model whose
individual face has no samples instead falls through to the normal path,
where the closing bound/invert/shift turns a zero accumulator into
(255*256) >> (8 - VID_CBITS) == 16320 -- and r_surf.ts's block drawers index
the colormap with `light & 0xFF00`, so 16320 (0x3FC0) selects row 0x3F == 63,
the DARKEST row of a 64-row colormap.

Self-sufficient per PORTING.md rule 13: each test builds the surface,
texinfo, plane and world model it reads, and restores the module-level
r_worldmodel / r_drawsurf / rCvars state it touches.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CplaneT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { MsurfaceT, MtexinfoT, ModelT, SetupDecoupledLightmap } from "../src/ref_soft/r_model";
import { r_drawsurf, rCvars, SetWorldModel, VID_CBITS } from "../src/ref_soft/r_local";
import { R_BuildLightMap, blocklights } from "../src/ref_soft/r_light";
import type { DecoupledLmFaceT } from "../src/qcommon/bspx";

// The value R_BuildLightMap's closing bound/invert/shift produces from a
// zero accumulator -- i.e. what a lit model's unlit face encodes to. Named
// rather than inlined because the whole regression is that this is the DARK
// end of the scale, not the bright end.
const DARKEST = (255 * 256) >> (8 - VID_CBITS);

// r_surf.ts's block drawers select a colormap row with `light & 0xFF00`.
function colormapRow(light: number): number {
  return (light & 0xff00) >> 8;
}

/*
A single axis-aligned face on the plane z == 0, with texture axes running
along +x and +y at the classic scale (1 texture unit per world unit). Its
classic lightmap grid is therefore 16 world units per texel.
*/
function makeFloorSurface(extentS: number, extentT: number): MsurfaceT {
  const surf = new MsurfaceT();

  const tex = new MtexinfoT();
  tex.vecs[0].set([1, 0, 0, 0]);
  tex.vecs[1].set([0, 1, 0, 0]);
  surf.texinfo = tex;

  const plane = new CplaneT();
  plane.normal = vec3(0, 0, 1);
  plane.dist = 0;
  surf.plane = plane;

  surf.texturemins = [0, 0];
  surf.extents = [extentS, extentT];
  surf.styles = [0, 255, 255, 255];

  return surf;
}

function makeLitWorld(lightdata: Uint8Array): ModelT {
  const model = new ModelT();
  model.lightdata = lightdata;
  return model;
}

describe("software renderer -- DECOUPLED_LM lighting", () => {
  let savedFullbright: (typeof rCvars)["r_fullbright"];

  beforeEach(() => {
    savedFullbright = rCvars.r_fullbright;
    rCvars.r_fullbright = null; // treated as "not set" -> not fullbright
    r_drawsurf.lightadj = [256, 0, 0, 0]; // 8.8 fixed point: scale 1.0 for style 0
    blocklights.fill(0);
  });

  afterEach(() => {
    rCvars.r_fullbright = savedFullbright;
    r_drawsurf.surf = null;
    SetWorldModel(null);
  });

  // -------------------------------------------------------------------
  // The mechanism the old behavior got backwards.
  // -------------------------------------------------------------------

  test("R_BuildLightMap: a face with no samples in a LIT model encodes to the DARKEST colormap row, not fullbright", () => {
    const surf = makeFloorSurface(64, 64); // 5x5 classic lightmap texels
    surf.samples = null;
    surf.decoupledLm = null;

    SetWorldModel(makeLitWorld(new Uint8Array(4096)));
    r_drawsurf.surf = surf;

    R_BuildLightMap();

    for (let i = 0; i < 5 * 5; i++) {
      expect(blocklights[i]).toBe(DARKEST);
    }
    expect(colormapRow(DARKEST)).toBe(63); // last row of the 64-row colormap
  });

  test("R_BuildLightMap: blocklights is INVERTED -- brighter lightmap samples produce smaller values, and the fullbright early-out is 0", () => {
    const surf = makeFloorSurface(64, 64);
    surf.decoupledLm = null;
    surf.samples = new Uint8Array(5 * 5).fill(255); // brightest possible luxels

    SetWorldModel(makeLitWorld(new Uint8Array(4096)));
    r_drawsurf.surf = surf;

    R_BuildLightMap();

    // 255 * 256 accumulated, inverted to 0, then floored at the renderer's
    // own minimum of 1 << 6.
    expect(blocklights[0]).toBe(1 << 6);
    expect(blocklights[0]).toBeLessThan(DARKEST);
    expect(colormapRow(blocklights[0])).toBe(0); // brightest row
  });

  // -------------------------------------------------------------------
  // SetupDecoupledLightmap: the classic-grid -> decoupled-grid transform.
  // -------------------------------------------------------------------

  test("SetupDecoupledLightmap: a decoupled grid at the same scale and origin as the classic grid maps texel-for-texel", () => {
    const surf = makeFloorSurface(64, 64); // classic 5x5, 16 units per texel

    // lm axes at 1/16 per world unit == the classic scale, same origin.
    const dlmFace: DecoupledLmFaceT = {
      lmWidth: 5,
      lmHeight: 5,
      lightofs: null,
      lmAxis: [
        [1 / 16, 0, 0],
        [0, 1 / 16, 0],
      ],
      lmOffset: [0, 0],
    };

    SetupDecoupledLightmap(surf, dlmFace);

    const dlm = surf.decoupledLm;
    expect(dlm).not.toBeNull();
    if (!dlm) throw new Error("decoupledLm not set");

    expect(dlm.map.sBase).toBeCloseTo(0, 6);
    expect(dlm.map.tBase).toBeCloseTo(0, 6);
    expect(dlm.map.sStepS).toBeCloseTo(1, 6); // one classic texel -> one decoupled texel
    expect(dlm.map.tStepT).toBeCloseTo(1, 6);
    expect(dlm.map.sStepT).toBeCloseTo(0, 6); // axis-aligned: no cross terms
    expect(dlm.map.tStepS).toBeCloseTo(0, 6);
  });

  test("SetupDecoupledLightmap: a half-scale decoupled grid (8 units per luxel, as real rerelease maps use) maps one classic texel to two decoupled texels", () => {
    const surf = makeFloorSurface(64, 64); // classic 5x5

    // 1/8 per world unit: the scale baseq2/maps/base1.bsp actually uses.
    const dlmFace: DecoupledLmFaceT = {
      lmWidth: 9,
      lmHeight: 9,
      lightofs: null,
      lmAxis: [
        [1 / 8, 0, 0],
        [0, 1 / 8, 0],
      ],
      lmOffset: [0, 0],
    };

    SetupDecoupledLightmap(surf, dlmFace);
    const dlm = surf.decoupledLm;
    if (!dlm) throw new Error("decoupledLm not set");

    expect(dlm.map.sStepS).toBeCloseTo(2, 6);
    expect(dlm.map.tStepT).toBeCloseTo(2, 6);
  });

  test("SetupDecoupledLightmap: lmOffset shifts the decoupled grid's origin, and texturemins is accounted for", () => {
    // A face whose classic grid does NOT start at texture origin 0.
    const surf = makeFloorSurface(32, 32);
    surf.texturemins = [-64, 32];

    const dlmFace: DecoupledLmFaceT = {
      lmWidth: 3,
      lmHeight: 3,
      lightofs: null,
      lmAxis: [
        [1 / 16, 0, 0],
        [0, 1 / 16, 0],
      ],
      lmOffset: [4, -2],
    };

    SetupDecoupledLightmap(surf, dlmFace);
    const dlm = surf.decoupledLm;
    if (!dlm) throw new Error("decoupledLm not set");

    // classic texel 0 sits at world x == texturemins[0] == -64, so its
    // decoupled coordinate is -64/16 + 4 == 0; likewise 32/16 - 2 == 0.
    expect(dlm.map.sBase).toBeCloseTo(0, 6);
    expect(dlm.map.tBase).toBeCloseTo(0, 6);
  });

  test("SetupDecoupledLightmap: a rotated decoupled grid produces the cross terms the axis-aligned cases do not", () => {
    const surf = makeFloorSurface(64, 64);

    // lm axes rotated 90 degrees relative to the texture axes.
    const dlmFace: DecoupledLmFaceT = {
      lmWidth: 5,
      lmHeight: 5,
      lightofs: null,
      lmAxis: [
        [0, 1 / 16, 0],
        [-1 / 16, 0, 0],
      ],
      lmOffset: [0, 4],
    };

    SetupDecoupledLightmap(surf, dlmFace);
    const dlm = surf.decoupledLm;
    if (!dlm) throw new Error("decoupledLm not set");

    // ds now advances with the classic T axis, dt with the classic S axis.
    expect(dlm.map.sStepS).toBeCloseTo(0, 6);
    expect(dlm.map.sStepT).toBeCloseTo(1, 6);
    expect(dlm.map.tStepS).toBeCloseTo(-1, 6);
    expect(dlm.map.tStepT).toBeCloseTo(0, 6);
  });

  // -------------------------------------------------------------------
  // End to end: the same face, lit through DECOUPLED_LM.
  // -------------------------------------------------------------------

  test("R_BuildLightMap: a DECOUPLED_LM face resamples its own lightmap onto the classic grid instead of going black", () => {
    const surf = makeFloorSurface(64, 64); // classic 5x5

    // 9x9 decoupled lightmap at half the classic texel size, fully bright.
    const lmW = 9;
    const lmH = 9;
    const lightdata = new Uint8Array(lmW * lmH).fill(255);

    SetupDecoupledLightmap(surf, {
      lmWidth: lmW,
      lmHeight: lmH,
      lightofs: null,
      lmAxis: [
        [1 / 8, 0, 0],
        [0, 1 / 8, 0],
      ],
      lmOffset: [0, 0],
    });
    surf.samples = lightdata;

    SetWorldModel(makeLitWorld(lightdata));
    r_drawsurf.surf = surf;

    R_BuildLightMap();

    for (let i = 0; i < 5 * 5; i++) {
      expect(blocklights[i]).toBe(1 << 6); // fully lit, not DARKEST
      expect(blocklights[i]).toBeLessThan(DARKEST);
    }
  });

  test("R_BuildLightMap: a DECOUPLED_LM face reproduces a per-luxel gradient across the classic grid", () => {
    const surf = makeFloorSurface(64, 64); // classic 5x5

    // 5x5 decoupled lightmap at the classic scale, so texel (s,t) of the
    // classic grid reads decoupled texel (s,t) -- a column ramp makes the
    // resampling's addressing observable.
    const lmW = 5;
    const lmH = 5;
    const lightdata = new Uint8Array(lmW * lmH);
    for (let t = 0; t < lmH; t++) {
      for (let s = 0; s < lmW; s++) lightdata[t * lmW + s] = s * 60; // 0,60,120,180,240
    }

    SetupDecoupledLightmap(surf, {
      lmWidth: lmW,
      lmHeight: lmH,
      lightofs: null,
      lmAxis: [
        [1 / 16, 0, 0],
        [0, 1 / 16, 0],
      ],
      lmOffset: [0, 0],
    });
    surf.samples = lightdata;

    SetWorldModel(makeLitWorld(lightdata));
    r_drawsurf.surf = surf;

    R_BuildLightMap();

    // Inverted encoding: the brightest column has the SMALLEST value, and
    // the ramp is strictly decreasing left to right on every row.
    for (let t = 0; t < 5; t++) {
      for (let s = 1; s < 5; s++) {
        expect(blocklights[t * 5 + s]).toBeLessThan(blocklights[t * 5 + s - 1]);
      }
      // the darkest luxel of the ramp is still the sample value 0 case
      expect(blocklights[t * 5]).toBe(DARKEST);
    }
  });

  test("R_BuildLightMap: classic (non-decoupled) faces are untouched by the decoupled path", () => {
    const surf = makeFloorSurface(64, 64);
    surf.decoupledLm = null;

    const samples = new Uint8Array(5 * 5);
    for (let i = 0; i < 25; i++) samples[i] = i * 10;
    surf.samples = samples;

    SetWorldModel(makeLitWorld(samples));
    r_drawsurf.surf = surf;

    R_BuildLightMap();

    // Straight vanilla arithmetic: accumulate sample*scale, then invert.
    for (let i = 0; i < 25; i++) {
      const expected = Math.max(1 << 6, (255 * 256 - samples[i] * 256) >> (8 - VID_CBITS));
      expect(blocklights[i]).toBe(expected);
    }
  });
});
