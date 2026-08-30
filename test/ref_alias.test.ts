/*
Unit tests for the alias (MD2) model drawing pipeline (r_alias.ts/
r_aclip.ts/r_polyse.ts). Exercises the pieces that are exact,
hand-computable math or self-contained algorithms:

- R_AliasClip (r_aclip.ts): the single-plane clip step R_AliasClipTriangle
  orchestrates per plane -- a triangle with exactly one vertex outside the
  left clip boundary clips into 4 vertices, with hand-computed coordinates.
- R_PolysetCalcGradients (r_polyse.ts): s/t/light/zi screen-space gradients
  for a hand-picked triangle where every intermediate product is an exact
  integer.
- R_DrawTriangle (r_polyse.ts): rasterizes a small axis-legged right
  triangle into d_viewbuffer, hitting the exact expected pixel positions
  (a triangular-number pixel count for a right triangle with two
  axis-aligned legs of length 2: 2*3/2 = 3 pixels).
- R_AliasClipTriangle (r_aclip.ts) into R_DrawTriangle (r_polyse.ts): a
  triangle with one vertex past the left plane, whose clip intersections
  land on interior fractional v values -- the configuration that runs
  R_PolysetScanLeftEdge_C past the end of the DPS_MAXSPANS pool if the
  clip results are not truncated to finalvert_t's int fields.
- R_AliasSetUpLerpData (r_alias.ts): frame-vertex lerp coefficients at
  backlerp 0.5, hand-computed.

Each test initializes every global it reads, per PORTING.md/rule 13; none
of them rely on another test file (or another test in this file) having
run first.
*/

import { describe, test, expect } from "bun:test";
import { EntityT } from "../src/client/ref";
import { ALIAS_LEFT_CLIP, FinalvertT, MAXHEIGHT, r_refdef } from "../src/ref_soft/r_local";
import { R_AliasClip, R_AliasClipTriangle, R_Alias_clip_left } from "../src/ref_soft/r_aclip";
import { R_AliasSetUpLerpData, r_lerp_backv, r_lerp_frontv, r_lerp_move } from "../src/ref_soft/r_alias";
import {
  R_DrawTriangle,
  R_PolysetCalcGradients,
  R_PolysetGetGradients,
  R_PolysetSetXDenom,
  R_SetDrawSpansFn,
  R_PolysetDrawSpans8_Opaque,
  r_p0,
  r_p1,
  r_p2,
} from "../src/ref_soft/r_polyse";
import { D_SetViewBuffer, D_SetZBuffer } from "../src/ref_soft/r_scan";
import { aliastriangleparms, r_affinetridesc, r_newrefdef, vid } from "../src/ref_soft/r_local";

function makeFinalvert(u: number, v: number, s: number, t: number, l: number, zi: number, flags = 0): FinalvertT {
  const fv = new FinalvertT();
  fv.u = u;
  fv.v = v;
  fv.s = s;
  fv.t = t;
  fv.l = l;
  fv.zi = zi;
  fv.flags = flags;
  return fv;
}

describe("R_AliasClip / R_Alias_clip_left", () => {
  test("clips a triangle with one vertex outside the left plane into 4 vertices", () => {
    // left clip boundary at u=10; generous bounds on every other side so
    // only ALIAS_LEFT_CLIP is ever in play.
    r_refdef.aliasvrect.x = 10;
    r_refdef.aliasvrect.y = -1000;
    r_refdef.aliasvrectright = 1000;
    r_refdef.aliasvrectbottom = 1000;

    const v0 = makeFinalvert(20, 0, 100, 200, 50, 1000, 0); // inside (u=20 > 10)
    const v1 = makeFinalvert(0, 10, 0, 0, 0, 0, ALIAS_LEFT_CLIP); // outside (u=0 < 10)
    const v2 = makeFinalvert(40, 20, 400, 800, 200, 4000, 0); // inside (u=40 > 10)

    const out = [new FinalvertT(), new FinalvertT(), new FinalvertT(), new FinalvertT()];
    const k = R_AliasClip([v0, v1, v2], out, ALIAS_LEFT_CLIP, 3, R_Alias_clip_left);

    expect(k).toBe(4);

    // out[0] = copy of v0 (untouched, first vertex was already inside)
    expect(out[0].u).toBeCloseTo(20);
    expect(out[0].v).toBeCloseTo(0);
    expect(out[0].s).toBeCloseTo(100);

    // out[1] = clip(v0, v1): edge from (20,0) to (0,10) crossing u=10 at scale
    // 0.5, so the raw `expr + 0.5` values are 10.5/5.5/50.5/100.5/25.5/500.5
    // and land in finalvert_t's int fields truncated toward zero.
    expect(out[1].u).toBe(10);
    expect(out[1].v).toBe(5);
    expect(out[1].s).toBe(50);
    expect(out[1].t).toBe(100);
    expect(out[1].l).toBe(25);
    expect(out[1].zi).toBe(500);
    expect(out[1].flags).toBe(0);

    // out[2] = clip(v1, v2): edge from (0,10) to (40,20) crossing u=10 at scale 0.75
    expect(out[2].u).toBe(10);
    expect(out[2].v).toBe(13);
    expect(out[2].s).toBe(100);
    expect(out[2].t).toBe(200);
    expect(out[2].l).toBe(50);
    expect(out[2].zi).toBe(1000);
    expect(out[2].flags).toBe(0);

    // out[3] = copy of v2 (untouched, third vertex was already inside)
    expect(out[3].u).toBeCloseTo(40);
    expect(out[3].v).toBeCloseTo(20);
  });
});

describe("R_PolysetCalcGradients", () => {
  test("computes exact s/t/light/zi gradients for a hand-picked triangle", () => {
    // a=(0,0) b=(4,0) c=(0,4); d_xdenom = dv0_ac*dv1_ab - dv0_ab*dv1_ac
    //   dv0_ab=-4, dv1_ab=0, dv0_ac=0, dv1_ac=-4 -> d_xdenom = 0*0 - (-4)*(-4) = -16
    r_p0[0] = 0;
    r_p0[1] = 0;
    r_p0[2] = 0; // s
    r_p0[3] = 0; // t
    r_p0[4] = 0; // light
    r_p0[5] = 0; // zi

    r_p1[0] = 4;
    r_p1[1] = 0;
    r_p1[2] = 8;
    r_p1[3] = 0;
    r_p1[4] = 0;
    r_p1[5] = 0;

    r_p2[0] = 0;
    r_p2[1] = 4;
    r_p2[2] = 0;
    r_p2[3] = 8;
    r_p2[4] = 16;
    r_p2[5] = 0;

    R_PolysetSetXDenom(-16);
    R_PolysetCalcGradients(4);

    const g = R_PolysetGetGradients();
    expect(g.sstepx).toBe(2);
    expect(g.sstepy).toBe(0);
    expect(g.tstepx).toBe(0);
    expect(g.tstepy).toBe(2);
    expect(g.lstepx).toBe(0);
    expect(g.lstepy).toBe(4);
    expect(g.zistepx).toBe(0);
    expect(g.zistepy).toBe(0);
  });
});

describe("R_DrawTriangle", () => {
  test("rasterizes a small axis-legged right triangle into the expected pixels", () => {
    const screenwidth = 8;
    const height = 8;
    const view = new Uint8Array(screenwidth * height).fill(255); // sentinel
    const zbuf = new Int16Array(screenwidth * height); // zeroed
    D_SetViewBuffer(view, screenwidth);
    D_SetZBuffer(zbuf, screenwidth);

    const colormap = new Uint8Array(256 * 64);
    for (let i = 0; i < 256; i++) colormap[i] = i; // identity for grade 0
    vid.colormap = colormap;

    const skin = new Uint8Array(16).fill(0);
    skin[0] = 200; // marker texel
    r_affinetridesc.pskin = skin;
    r_affinetridesc.skinwidth = 4;
    r_affinetridesc.skinheight = 4;

    r_newrefdef.rdflags = 0; // keep the IR-goggles branch off

    R_SetDrawSpansFn(R_PolysetDrawSpans8_Opaque);

    // right triangle, legs of length 2 along +u and +v from the origin;
    // winding chosen so d_xdenom ends up negative (front-facing).
    aliastriangleparms.a = makeFinalvert(0, 0, 0, 0, 0, 0);
    aliastriangleparms.b = makeFinalvert(2, 0, 0, 0, 0, 0);
    aliastriangleparms.c = makeFinalvert(0, 2, 0, 0, 0, 0);

    R_DrawTriangle();

    // triangular number for leg length 2: 2*3/2 = 3 pixels, at
    // (0,0),(1,0) on the top row and (0,1) on the second row.
    const touched: number[] = [];
    for (let i = 0; i < view.length; i++) {
      if (view[i] !== 255) touched.push(i);
    }
    expect(touched.sort((x, y) => x - y)).toEqual([0, 1, 8]);
    expect(view[0]).toBe(200);
    expect(view[1]).toBe(200);
    expect(view[8]).toBe(200);
  });
});

describe("R_AliasClipTriangle -> R_DrawTriangle", () => {
  test("a left-clipped triangle rasterizes within the a_spans pool", () => {
    // finalvert_t's u/v/s/t/l/zi are `int` in r_local.h, so every clip
    // interpolation truncates. R_RasterizeAliasPolySmooth derives its edge
    // heights as differences of v, and R_PolysetScanLeftEdge_C ends on
    // `while (--height)`: a v that kept a fractional part never reaches 0, so
    // the scan walks off the end of the DPS_MAXSPANS pool. A left-plane
    // crossing interpolates v to an arbitrary interior value (here 173.5 and
    // 191.333...), so unlike a top/bottom crossing it is not rounded off
    // again by R_AliasClipTriangle's clamp to the alias vrect.
    const DPS_MAXSPANS = MAXHEIGHT + 1;
    const SPAN_END_MARKER = -999999;

    const screenwidth = 320;
    const screenheight = 240;
    const view = new Uint8Array(screenwidth * screenheight);
    const zbuf = new Int16Array(screenwidth * screenheight);
    D_SetViewBuffer(view, screenwidth);
    D_SetZBuffer(zbuf, screenwidth);

    const colormap = new Uint8Array(256 * 64);
    for (let i = 0; i < colormap.length; i++) colormap[i] = i & 0xff;
    vid.colormap = colormap;

    r_affinetridesc.pskin = new Uint8Array(64 * 64).fill(7);
    r_affinetridesc.skinwidth = 64;
    r_affinetridesc.skinheight = 64;

    r_newrefdef.rdflags = 0;

    r_refdef.aliasvrect.x = 10;
    r_refdef.aliasvrect.y = 0;
    r_refdef.aliasvrectright = 319;
    r_refdef.aliasvrectbottom = 239;

    let maxSpanIndex = -1;
    R_SetDrawSpansFn((spans, start) => {
      let i = start;
      while (i < DPS_MAXSPANS && spans[i].count !== SPAN_END_MARKER) i++;
      if (i > maxSpanIndex) maxSpanIndex = i;
      R_PolysetDrawSpans8_Opaque(spans, start);
    });

    // two vertices inside, one past the left plane at u=10
    const a = makeFinalvert(100, 20, 2 << 16, 1 << 16, 1000, 500000, 0);
    const c = makeFinalvert(120, 200, 1 << 16, 2 << 16, 600, 400000, 0);
    const b = makeFinalvert(0, 190, 0, 0, 200, 300000, ALIAS_LEFT_CLIP);

    expect(() => {
      R_AliasClipTriangle(a, c, b);
    }).not.toThrow();

    // clipping yields the quad (10,173) (100,20) (120,200) (10,191), fanned
    // into two triangles; the taller one spans 180 rows, well inside the
    // 1201-entry pool.
    for (const p of [r_p0, r_p1, r_p2]) {
      for (const coord of p) expect(Number.isInteger(coord)).toBe(true);
    }
    expect(r_p0[1]).toBe(173);
    expect(r_p1[1]).toBe(200);
    expect(r_p2[1]).toBe(191);
    expect(maxSpanIndex).toBe(180);
    expect(maxSpanIndex).toBeLessThan(DPS_MAXSPANS);

    // the span drawer actually painted the triangles' interior
    expect(view.some((px) => px !== 0)).toBe(true);
  });
});

describe("R_AliasSetUpLerpData", () => {
  test("interpolates frame verts at backlerp 0.5 exactly", () => {
    const entity = new EntityT();
    entity.angles[0] = 0; // PITCH
    entity.angles[1] = 0; // YAW
    entity.angles[2] = 0; // ROLL
    entity.origin[0] = 0;
    entity.origin[1] = 0;
    entity.origin[2] = 0;
    entity.oldorigin[0] = 10;
    entity.oldorigin[1] = 0;
    entity.oldorigin[2] = 0;

    const thisframe = { scale: [2, 4, 6] as [number, number, number], translate: [0, 1, 2] as [number, number, number], name: "", verts: [] };
    const lastframe = { scale: [10, 20, 30] as [number, number, number], translate: [2, 3, 4] as [number, number, number], name: "", verts: [] };

    R_AliasSetUpLerpData(entity, thisframe, lastframe, 0.5);

    // with identity angles: forward=(1,0,0), right=(0,-1,0), up=(0,0,1)
    // translation = oldorigin - origin = (10,0,0)
    // move (pre-lastframe) = (10,0,0); += lastframe.translate(2,3,4) -> (12,3,4)
    // lerp_move[i] = 0.5*move[i] + 0.5*thisframe.translate[i]
    //   -> (0.5*12+0.5*0, 0.5*3+0.5*1, 0.5*4+0.5*2) = (6, 2, 3)
    expect(r_lerp_move[0]).toBeCloseTo(6);
    expect(r_lerp_move[1]).toBeCloseTo(2);
    expect(r_lerp_move[2]).toBeCloseTo(3);

    // frontv = 0.5*thisframe.scale = (1,2,3); backv = 0.5*lastframe.scale = (5,10,15)
    expect(r_lerp_frontv[0]).toBeCloseTo(1);
    expect(r_lerp_frontv[1]).toBeCloseTo(2);
    expect(r_lerp_frontv[2]).toBeCloseTo(3);
    expect(r_lerp_backv[0]).toBeCloseTo(5);
    expect(r_lerp_backv[1]).toBeCloseTo(10);
    expect(r_lerp_backv[2]).toBeCloseTo(15);
  });
});
