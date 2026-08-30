/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_polyse.c (GNU GPL v2 or later): the finalvert-based
span rasterizer for MD2 alias-model triangles (d_polyset.c's original file
header). `SetUpForLineScan` in r_local.h is a stale/misnamed forward
declaration for this file's actual `R_PolysetSetUpForLineScan` -- the real
.c source is authoritative per PORTING.md ("the brief's placement wins;
report the mismatch"), so the real name is what's exported here.

Dropped per PORTING.md's id386/asm rule: the `#if id386 && !defined __linux__`
inline-asm body of R_PolysetCalcGradients (its `#else` C fallback is ported
below), the x86-asm-only `R_PolysetScanLeftEdge` (never defined in C outside
an .s file -- only `R_PolysetScanLeftEdge_C` has a C body and is ported),
and every `#if id386` branch inside R_RasterizeAliasPolySmooth/
R_PolysetCalcGradients that chose between a packed 16.16 "opaque" fixed-point
representation (paired with the dropped asm scan routine) and the plain
masked representation used by the C fallback -- this port always takes the
masked (`& 0xFFFF`) branch and always calls R_PolysetScanLeftEdge_C, which is
the only self-consistent combination once the asm routine is gone.
`R_DrawNonSubdiv` is forward-declared in the C file but never given a body
there (asm/dead) and is not ported.

Pointer -> index reshaping (same pattern as r_scan.ts's documented
r_turb_pdestIdx): `spanpackage_t.pdest`/`.pz` become indices into
r_scan.ts's d_viewbuffer/d_pzbuffer, `.ptex` and the module's `d_ptex`/
`skintable` become indices into whichever Uint8Array r_affinetridesc.pskin
currently holds (narrowed from `unknown` with `instanceof Uint8Array` at
each read, since AffinetridescT.pskin is typed `unknown` in r_local.ts).
`spanpackage_t spans[DPS_MAXSPANS]` (a fresh stack array per C call) becomes
a single preallocated module-level pool reused every call -- every element
is fully overwritten before being read (either by the scan routines or by
an explicit `-999999` end marker) so reuse is behavior-preserving and avoids
a fresh 1201-element allocation per triangle.

Cross-module read-only state: `d_viewbuffer`/`r_screenwidth`/`d_pzbuffer`/
`d_zwidth` are owned by r_scan.ts (see that file's header comment -- it
already relocated ownership of these r_local.h globals away from inert
`export let` duplicates in r_local.ts because imported `let` bindings are
read-only from outside their declaring module). This file only reads them.
`ubasestep`/`errorterm`/`erroradjustup`/`erroradjustdown` are also declared
as inert `export let`s in r_local.ts, but grep shows r_edge.ts never reads
or writes them -- they exist solely for this file's line-scan setup
(R_PolysetSetUpForLineScan writes, R_PolysetScanLeftEdge_C reads, both
here), so per the same precedent they are relocated to local `let`s owned
by this module instead of the dead r_local.ts copies.
*/

import { RDF_IRGOGGLES, RF_IR_VISIBLE } from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";
import { rand1k, MASK_1K } from "./rand1k";
import { adivtabQuotient, adivtabRemainder, adivtabIndex } from "./adivtab";
import { MAXHEIGHT, MAX_LBM_HEIGHT, aliastriangleparms, currententity, r_affinetridesc, r_aliasblendcolor, r_newrefdef, vid, SetAliasBlendColor } from "./r_local";
import { d_pzbuffer, d_viewbuffer, d_zwidth, r_screenwidth } from "./r_scan";

// !!! if this is changed, it must be changed in d_polysa.s too !!!
const DPS_MAXSPANS = MAXHEIGHT + 1; // 1 extra for the spanpackage that marks the end
const SPAN_END_MARKER = -999999;

export class SpanpackageT {
  pdest = 0; // index into d_viewbuffer
  pz = 0; // index into d_pzbuffer
  count = 0;
  ptex = 0; // index into the skin pixel buffer
  sfrac = 0;
  tfrac = 0;
  light = 0;
  zi = 0;
}

class EdgetableT {
  isflattop = 0;
  numleftedges = 0;
  pleftedgevert0: number[] = [];
  pleftedgevert1: number[] = [];
  pleftedgevert2: number[] | null = null;
  numrightedges = 0;
  prightedgevert0: number[] = [];
  prightedgevert1: number[] = [];
  prightedgevert2: number[] | null = null;
}

export type DrawSpansFn = (spans: SpanpackageT[], start: number) => void;

// PGM: IR-goggles palette remap, verbatim from r_polyse.c's irtable[256].
const irtable: Uint8Array = fixedLength("irtable", 256, new Uint8Array([
  79, 78, 77, 76, 75, 74, 73, 72, 71, 70, 69, 68, 67, 66, 65, 64, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70,
  71, 72, 73, 74, 75, 76, 77, 78, 79, 208, 208, 208, 208, 208, 208, 208, 208, 64, 66, 68, 70, 72, 74, 76, 78, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
  76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 64, 66, 68, 70, 72, 74, 76, 78, 68, 67, 66, 65, 64, 65, 66, 67, 68, 69, 70,
  71, 72, 73, 74, 75, 76, 76, 77, 77, 78, 78, 79, 79, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
  74, 75, 76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 64,
  65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70, 71, 64, 65, 66, 67, 68, 69, 70, 71, 64, 65, 66, 67, 68, 69, 70, 71,
  72, 73, 74, 75, 76, 77, 78, 79, 208, 208, 64, 64, 70, 71, 72, 64, 66, 68, 70, 64, 65, 66, 67, 68,
]));

// aliastriangleparms.a/b/c coordinates, copied out per PORTING.md's
// out-param idiom -- indices are [u, v, s, t, light, zi] matching the C
// int r_p0[6]/r_p1[6]/r_p2[6] arrays.
// exported (const array bindings' elements are freely mutable/readable
// from outside, unlike the `let` wall documented above) so
// test/ref_alias.test.ts can drive R_PolysetCalcGradients directly.
export const r_p0: number[] = [0, 0, 0, 0, 0, 0];
export const r_p1: number[] = [0, 0, 0, 0, 0, 0];
export const r_p2: number[] = [0, 0, 0, 0, 0, 0];

const edgetables: EdgetableT[] = fixedLength("edgetables", 12, [
  edge(0, 1, r_p0, r_p2, null, 2, r_p0, r_p1, r_p2),
  edge(0, 2, r_p1, r_p0, r_p2, 1, r_p1, r_p2, null),
  edge(1, 1, r_p0, r_p2, null, 1, r_p1, r_p2, null),
  edge(0, 1, r_p1, r_p0, null, 2, r_p1, r_p2, r_p0),
  edge(0, 2, r_p0, r_p2, r_p1, 1, r_p0, r_p1, null),
  edge(0, 1, r_p2, r_p1, null, 1, r_p2, r_p0, null),
  edge(0, 1, r_p2, r_p1, null, 2, r_p2, r_p0, r_p1),
  edge(0, 2, r_p2, r_p1, r_p0, 1, r_p2, r_p0, null),
  edge(0, 1, r_p1, r_p0, null, 1, r_p1, r_p2, null),
  edge(1, 1, r_p2, r_p1, null, 1, r_p0, r_p1, null),
  edge(1, 1, r_p1, r_p0, null, 1, r_p2, r_p0, null),
  edge(0, 1, r_p0, r_p2, null, 1, r_p0, r_p1, null),
]);

function edge(
  isflattop: number,
  numleftedges: number,
  v0: number[],
  v1: number[],
  v2: number[] | null,
  numrightedges: number,
  rv0: number[],
  rv1: number[],
  rv2: number[] | null,
): EdgetableT {
  const t = new EdgetableT();
  t.isflattop = isflattop;
  t.numleftedges = numleftedges;
  t.pleftedgevert0 = v0;
  t.pleftedgevert1 = v1;
  t.pleftedgevert2 = v2;
  t.numrightedges = numrightedges;
  t.prightedgevert0 = rv0;
  t.prightedgevert1 = rv1;
  t.prightedgevert2 = rv2;
  return t;
}

let pedgetable: EdgetableT | null = null;

let a_sstepxfrac = 0;
let a_tstepxfrac = 0;
let r_lstepx = 0;
let a_ststepxwhole = 0;
let r_sstepx = 0;
let r_tstepx = 0;
let r_lstepy = 0;
let r_sstepy = 0;
let r_tstepy = 0;
let r_zistepx = 0;
let r_zistepy = 0;
let d_aspancount = 0;
let d_countextrastep = 0;
let d_xdenom = 0;

let rand1k_index = 0;

// relocated ownership -- see file header comment.
let ubasestep = 0;
let errorterm = 0;
let erroradjustup = 0;
let erroradjustdown = 0;

const a_spans: SpanpackageT[] = Array.from({ length: DPS_MAXSPANS }, () => new SpanpackageT());
let d_pedgespanpackageIdx = 0;
let ystart = 0;

let d_pdest = 0;
let d_ptex = 0;
let d_pz = 0;
let d_sfrac = 0;
let d_tfrac = 0;
let d_light = 0;
let d_zi = 0;
let d_ptexextrastep = 0;
let d_sfracextrastep = 0;
let d_tfracextrastep = 0;
let d_lightextrastep = 0;
let d_pdestextrastep = 0;
let d_lightbasestep = 0;
let d_pdestbasestep = 0;
let d_ptexbasestep = 0;
let d_sfracbasestep = 0;
let d_tfracbasestep = 0;
let d_ziextrastep = 0;
let d_zibasestep = 0;
let d_pzextrastep = 0;
let d_pzbasestep = 0;

let d_aflatcolor = 0;

const skintable: number[] = new Array<number>(MAX_LBM_HEIGHT).fill(0);
let skinwidth = 0;
let skinstart: Uint8Array | null = null;

let d_pdrawspans: DrawSpansFn | null = null;

// `r_aliasblendcolor` is an r_local.h extern owned by r_local.ts, written by
// r_alias.ts (the RF_SHELL_* color selection in R_AliasDrawModel) and read
// here (the ConstantX_33/66 span drawers). This is the setter r_alias.ts
// calls, since an imported `let` binding is read-only to the importer.
export function R_SetAliasBlendColor(v: number): void {
  SetAliasBlendColor(v);
}

// PGM: `extern byte iractive;` -- set by R_AliasPreparePoints (r_alias.ts),
// declared/defined here because r_polyse.c is its true C home. Faithful
// dead state: nothing in this file's span drawers reads it (they re-check
// the rdflags/RF_IR_VISIBLE condition directly instead, see
// R_PolysetDrawSpans8_Opaque below), matching the original.
export let iractive = 0;

export function R_SetIractive(v: number): void {
  iractive = v;
}

export function R_SetDrawSpansFn(fn: DrawSpansFn): void {
  d_pdrawspans = fn;
}

export function R_GetDrawSpansFn(): DrawSpansFn | null {
  return d_pdrawspans;
}

function requireSkin(): Uint8Array {
  const p = r_affinetridesc.pskin;
  if (!(p instanceof Uint8Array)) throw new Error("r_polyse: skin pixel buffer not set");
  return p;
}

function requireColormap(): Uint8Array {
  if (vid.colormap === null) throw new Error("r_polyse: vid.colormap not set");
  return vid.colormap;
}

function requireAlphamap(): Uint8Array {
  if (vid.alphamap === null) throw new Error("r_polyse: vid.alphamap not set");
  return vid.alphamap;
}

function requireView(): Uint8Array {
  if (d_viewbuffer === null) throw new Error("r_polyse: d_viewbuffer not set");
  return d_viewbuffer;
}

function requireZbuffer(): Int16Array {
  if (d_pzbuffer === null) throw new Error("r_polyse: d_pzbuffer not set");
  return d_pzbuffer;
}

/*
================
R_PolysetUpdateTables
================
*/
export function R_PolysetUpdateTables(): void {
  const pskin = r_affinetridesc.pskin;
  if (r_affinetridesc.skinwidth !== skinwidth || pskin !== skinstart) {
    skinwidth = r_affinetridesc.skinwidth;
    skinstart = pskin instanceof Uint8Array ? pskin : null;
    for (let i = 0; i < MAX_LBM_HEIGHT; i++) {
      skintable[i] = i * skinwidth;
    }
  }
}

/*
================
R_DrawTriangle
================
*/
export function R_DrawTriangle(): void {
  const a = aliastriangleparms.a;
  const b = aliastriangleparms.b;
  const c = aliastriangleparms.c;
  if (a === null || b === null || c === null) return; // invariant: always populated by the caller before R_DrawTriangle

  const dv0_ab = (a.u - b.u) | 0;
  const dv1_ab = (a.v - b.v) | 0;

  if (!(dv0_ab | dv1_ab)) return;

  const dv0_ac = (a.u - c.u) | 0;
  const dv1_ac = (a.v - c.v) | 0;

  if (!(dv0_ac | dv1_ac)) return;

  d_xdenom = (dv0_ac * dv1_ab - dv0_ab * dv1_ac) | 0;

  if (d_xdenom < 0) {
    r_p0[0] = a.u;
    r_p0[1] = a.v;
    r_p0[2] = a.s;
    r_p0[3] = a.t;
    r_p0[4] = a.l;
    r_p0[5] = a.zi;

    r_p1[0] = b.u;
    r_p1[1] = b.v;
    r_p1[2] = b.s;
    r_p1[3] = b.t;
    r_p1[4] = b.l;
    r_p1[5] = b.zi;

    r_p2[0] = c.u;
    r_p2[1] = c.v;
    r_p2[2] = c.s;
    r_p2[3] = c.t;
    r_p2[4] = c.l;
    r_p2[5] = c.zi;

    R_PolysetSetEdgeTable();
    R_RasterizeAliasPolySmooth();
  }
}

/*
===================
R_PolysetScanLeftEdge_C
====================
*/
function R_PolysetScanLeftEdge_C(height: number): void {
  const skin = requireSkin();
  let h = height;
  do {
    const pkg = a_spans[d_pedgespanpackageIdx];
    pkg.pdest = d_pdest;
    pkg.pz = d_pz;
    pkg.count = d_aspancount;
    pkg.ptex = d_ptex;

    pkg.sfrac = d_sfrac;
    pkg.tfrac = d_tfrac;

    // FIXME: need to clamp l, s, t, at both ends?
    pkg.light = d_light;
    pkg.zi = d_zi;

    d_pedgespanpackageIdx++;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_pdest += d_pdestextrastep;
      d_pz += d_pzextrastep;
      d_aspancount += d_countextrastep;
      d_ptex += d_ptexextrastep;
      d_sfrac += d_sfracextrastep;
      d_ptex += d_sfrac >> 16;

      d_sfrac &= 0xffff;
      d_tfrac += d_tfracextrastep;
      if (d_tfrac & 0x10000) {
        d_ptex += r_affinetridesc.skinwidth;
        d_tfrac &= 0xffff;
      }
      d_light += d_lightextrastep;
      d_zi += d_ziextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_pdest += d_pdestbasestep;
      d_pz += d_pzbasestep;
      d_aspancount += ubasestep;
      d_ptex += d_ptexbasestep;
      d_sfrac += d_sfracbasestep;
      d_ptex += d_sfrac >> 16;
      d_sfrac &= 0xffff;
      d_tfrac += d_tfracbasestep;
      if (d_tfrac & 0x10000) {
        d_ptex += r_affinetridesc.skinwidth;
        d_tfrac &= 0xffff;
      }
      d_light += d_lightbasestep;
      d_zi += d_zibasestep;
    }
  } while (--h);
  void skin; // skin buffer itself is only dereferenced by the span drawers, not here
}

/*
===================
FloorDivMod

Returns mathematically correct (floor-based) quotient and remainder for
numer and denom, both of which should contain no fractional part.
====================
*/
function FloorDivMod(numer: number, denom: number): [number, number] {
  let q: number;
  let r: number;

  if (numer >= 0.0) {
    const x = Math.floor(numer / denom);
    q = x | 0;
    r = Math.floor(numer - x * denom) | 0;
  } else {
    const x = Math.floor(-numer / denom);
    q = -x | 0;
    r = Math.floor(-numer - x * denom) | 0;
    if (r !== 0) {
      q--;
      r = (denom | 0) - r;
    }
  }

  return [q, r];
}

/*
===================
R_PolysetSetUpForLineScan
====================
*/
function R_PolysetSetUpForLineScan(startvertu: number, startvertv: number, endvertu: number, endvertv: number): void {
  errorterm = -1;

  const tm = (endvertu - startvertu) | 0;
  const tn = (endvertv - startvertv) | 0;

  if (tm <= 16 && tm >= -15 && tn <= 16 && tn >= -15) {
    const idx = adivtabIndex(tm, tn);
    ubasestep = adivtabQuotient[idx];
    erroradjustup = adivtabRemainder[idx];
    erroradjustdown = tn;
  } else {
    const [q, r] = FloorDivMod(tm, tn);
    ubasestep = q;
    erroradjustup = r;
    erroradjustdown = tn;
  }
}

/*
================
R_PolysetCalcGradients

Portable (non-id386-asm) C fallback only -- see file header comment.
================
*/
// exported, along with R_PolysetSetXDenom/R_PolysetGetGradients below, so
// test/ref_alias.test.ts can drive/read this pure-math step without going
// through the full R_DrawTriangle -> R_RasterizeAliasPolySmooth pipeline
// (which needs live d_viewbuffer/d_pzbuffer/skin buffers set up).
export function R_PolysetCalcGradients(skinwidthArg: number): void {
  const p00_minus_p20 = r_p0[0] - r_p2[0];
  const p01_minus_p21 = r_p0[1] - r_p2[1];
  const p10_minus_p20 = r_p1[0] - r_p2[0];
  const p11_minus_p21 = r_p1[1] - r_p2[1];

  const xstepdenominv = 1.0 / d_xdenom;
  const ystepdenominv = -xstepdenominv;

  // ceil() for light so positive steps are exaggerated, negative steps
  // diminished, pushing us away from underflow toward overflow. Underflow is
  // very visible, overflow is very unlikely, because of ambient lighting
  let t0 = r_p0[4] - r_p2[4];
  let t1 = r_p1[4] - r_p2[4];
  r_lstepx = Math.ceil((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_lstepy = Math.ceil((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  t0 = r_p0[2] - r_p2[2];
  t1 = r_p1[2] - r_p2[2];
  r_sstepx = ((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_sstepy = ((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  t0 = r_p0[3] - r_p2[3];
  t1 = r_p1[3] - r_p2[3];
  r_tstepx = ((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_tstepy = ((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  t0 = r_p0[5] - r_p2[5];
  t1 = r_p1[5] - r_p2[5];
  r_zistepx = ((t1 * p01_minus_p21 - t0 * p11_minus_p21) * xstepdenominv) | 0;
  r_zistepy = ((t1 * p00_minus_p20 - t0 * p10_minus_p20) * ystepdenominv) | 0;

  // portable path always takes the masked (non-id386-packed) representation
  // -- see file header comment.
  a_sstepxfrac = r_sstepx & 0xffff;
  a_tstepxfrac = r_tstepx & 0xffff;

  a_ststepxwhole = (skinwidthArg * (r_tstepx >> 16) + (r_sstepx >> 16)) | 0;
}

// test-support setter/getter for R_PolysetCalcGradients -- see its export comment above.
export function R_PolysetSetXDenom(v: number): void {
  d_xdenom = v;
}

export function R_PolysetGetGradients(): {
  sstepx: number;
  sstepy: number;
  tstepx: number;
  tstepy: number;
  lstepx: number;
  lstepy: number;
  zistepx: number;
  zistepy: number;
} {
  return {
    sstepx: r_sstepx,
    sstepy: r_sstepy,
    tstepx: r_tstepx,
    tstepy: r_tstepy,
    lstepx: r_lstepx,
    lstepy: r_lstepy,
    zistepx: r_zistepx,
    zistepy: r_zistepy,
  };
}

/*
================
R_PolysetSetEdgeTable
================
*/
function R_PolysetSetEdgeTable(): void {
  let edgetableindex = 0; // assume the vertices are already in top-to-bottom order

  // determine which edges are right & left, and the order in which to rasterize them
  if (r_p0[1] >= r_p1[1]) {
    if (r_p0[1] === r_p1[1]) {
      pedgetable = r_p0[1] < r_p2[1] ? edgetables[2] : edgetables[5];
      return;
    }
    edgetableindex = 1;
  }

  if (r_p0[1] === r_p2[1]) {
    pedgetable = edgetableindex ? edgetables[8] : edgetables[9];
    return;
  } else if (r_p1[1] === r_p2[1]) {
    pedgetable = edgetableindex ? edgetables[10] : edgetables[11];
    return;
  }

  if (r_p0[1] > r_p2[1]) edgetableindex += 2;
  if (r_p1[1] > r_p2[1]) edgetableindex += 4;

  pedgetable = edgetables[edgetableindex];
}

/*
================
R_RasterizeAliasPolySmooth
================
*/
function R_RasterizeAliasPolySmooth(): void {
  const table = pedgetable;
  if (table === null) return;

  let plefttop = table.pleftedgevert0;
  let prighttop = table.prightedgevert0;

  let pleftbottom = table.pleftedgevert1;
  const prightbottom = table.prightedgevert1;

  const initialleftheight = pleftbottom[1] - plefttop[1];
  const initialrightheight = prightbottom[1] - prighttop[1];

  // set the s, t, and light gradients, which are consistent across the
  // triangle because being a triangle, things are affine
  R_PolysetCalcGradients(r_affinetridesc.skinwidth);

  // rasterize the polygon

  // scan out the top (and possibly only) part of the left edge
  d_pedgespanpackageIdx = 0;

  ystart = plefttop[1];
  d_aspancount = plefttop[0] - prighttop[0];

  d_ptex = (plefttop[2] >> 16) + (plefttop[3] >> 16) * r_affinetridesc.skinwidth;
  d_sfrac = plefttop[2] & 0xffff;
  d_tfrac = plefttop[3] & 0xffff;
  d_light = plefttop[4];
  d_zi = plefttop[5];

  d_pdest = ystart * r_screenwidth + plefttop[0];
  d_pz = ystart * d_zwidth + plefttop[0];

  if (initialleftheight === 1) {
    const pkg = a_spans[d_pedgespanpackageIdx];
    pkg.pdest = d_pdest;
    pkg.pz = d_pz;
    pkg.count = d_aspancount;
    pkg.ptex = d_ptex;
    pkg.sfrac = d_sfrac;
    pkg.tfrac = d_tfrac;
    pkg.light = d_light;
    pkg.zi = d_zi;
    d_pedgespanpackageIdx++;
  } else {
    R_PolysetSetUpForLineScan(plefttop[0], plefttop[1], pleftbottom[0], pleftbottom[1]);

    d_pzbasestep = d_zwidth + ubasestep;
    d_pzextrastep = d_pzbasestep + 1;

    d_pdestbasestep = r_screenwidth + ubasestep;
    d_pdestextrastep = d_pdestbasestep + 1;

    // for negative steps in x along left edge, bias toward overflow rather
    // than underflow (sort of turning the floor() we did in the gradient
    // calcs into ceil(), but plus a little bit)
    const working_lstepx = ubasestep < 0 ? r_lstepx - 1 : r_lstepx;

    d_countextrastep = ubasestep + 1;
    d_ptexbasestep = ((r_sstepy + r_sstepx * ubasestep) >> 16) + ((r_tstepy + r_tstepx * ubasestep) >> 16) * r_affinetridesc.skinwidth;
    d_sfracbasestep = (r_sstepy + r_sstepx * ubasestep) & 0xffff;
    d_tfracbasestep = (r_tstepy + r_tstepx * ubasestep) & 0xffff;
    d_lightbasestep = r_lstepy + working_lstepx * ubasestep;
    d_zibasestep = r_zistepy + r_zistepx * ubasestep;

    d_ptexextrastep = ((r_sstepy + r_sstepx * d_countextrastep) >> 16) + ((r_tstepy + r_tstepx * d_countextrastep) >> 16) * r_affinetridesc.skinwidth;
    d_sfracextrastep = (r_sstepy + r_sstepx * d_countextrastep) & 0xffff;
    d_tfracextrastep = (r_tstepy + r_tstepx * d_countextrastep) & 0xffff;
    d_lightextrastep = d_lightbasestep + working_lstepx;
    d_ziextrastep = d_zibasestep + r_zistepx;

    R_PolysetScanLeftEdge_C(initialleftheight);
  }

  // scan out the bottom part of the left edge, if it exists
  if (table.numleftedges === 2 && table.pleftedgevert2 !== null) {
    plefttop = pleftbottom;
    pleftbottom = table.pleftedgevert2;

    const height = pleftbottom[1] - plefttop[1];

    ystart = plefttop[1];
    d_aspancount = plefttop[0] - prighttop[0];
    d_ptex = (plefttop[2] >> 16) + (plefttop[3] >> 16) * r_affinetridesc.skinwidth;
    d_sfrac = 0;
    d_tfrac = 0;
    d_light = plefttop[4];
    d_zi = plefttop[5];

    d_pdest = ystart * r_screenwidth + plefttop[0];
    d_pz = ystart * d_zwidth + plefttop[0];

    if (height === 1) {
      const pkg = a_spans[d_pedgespanpackageIdx];
      pkg.pdest = d_pdest;
      pkg.pz = d_pz;
      pkg.count = d_aspancount;
      pkg.ptex = d_ptex;
      pkg.sfrac = d_sfrac;
      pkg.tfrac = d_tfrac;
      pkg.light = d_light;
      pkg.zi = d_zi;
      d_pedgespanpackageIdx++;
    } else {
      R_PolysetSetUpForLineScan(plefttop[0], plefttop[1], pleftbottom[0], pleftbottom[1]);

      d_pdestbasestep = r_screenwidth + ubasestep;
      d_pdestextrastep = d_pdestbasestep + 1;

      d_pzbasestep = d_zwidth + ubasestep;
      d_pzextrastep = d_pzbasestep + 1;

      const working_lstepx = ubasestep < 0 ? r_lstepx - 1 : r_lstepx;

      d_countextrastep = ubasestep + 1;
      d_ptexbasestep = ((r_sstepy + r_sstepx * ubasestep) >> 16) + ((r_tstepy + r_tstepx * ubasestep) >> 16) * r_affinetridesc.skinwidth;
      d_sfracbasestep = (r_sstepy + r_sstepx * ubasestep) & 0xffff;
      d_tfracbasestep = (r_tstepy + r_tstepx * ubasestep) & 0xffff;
      d_lightbasestep = r_lstepy + working_lstepx * ubasestep;
      d_zibasestep = r_zistepy + r_zistepx * ubasestep;

      d_ptexextrastep = ((r_sstepy + r_sstepx * d_countextrastep) >> 16) + ((r_tstepy + r_tstepx * d_countextrastep) >> 16) * r_affinetridesc.skinwidth;
      d_sfracextrastep = (r_sstepy + r_sstepx * d_countextrastep) & 0xffff;
      d_tfracextrastep = (r_tstepy + r_tstepx * d_countextrastep) & 0xffff;
      d_lightextrastep = d_lightbasestep + working_lstepx;
      d_ziextrastep = d_zibasestep + r_zistepx;

      R_PolysetScanLeftEdge_C(height);
    }
  }

  // scan out the top (and possibly only) part of the right edge, updating
  // the count field
  d_pedgespanpackageIdx = 0;

  R_PolysetSetUpForLineScan(prighttop[0], prighttop[1], prightbottom[0], prightbottom[1]);
  d_aspancount = 0;
  d_countextrastep = ubasestep + 1;
  const originalcount = a_spans[initialrightheight].count;
  a_spans[initialrightheight].count = SPAN_END_MARKER; // mark end of the spanpackages
  if (d_pdrawspans !== null) d_pdrawspans(a_spans, 0);

  // scan out the bottom part of the right edge, if it exists
  if (table.numrightedges === 2 && table.prightedgevert2 !== null) {
    const pstartIdx = initialrightheight;
    a_spans[pstartIdx].count = originalcount;

    d_aspancount = prightbottom[0] - prighttop[0];

    prighttop = prightbottom;
    const prightbottom2 = table.prightedgevert2;

    const height = prightbottom2[1] - prighttop[1];

    R_PolysetSetUpForLineScan(prighttop[0], prighttop[1], prightbottom2[0], prightbottom2[1]);

    d_countextrastep = ubasestep + 1;
    a_spans[initialrightheight + height].count = SPAN_END_MARKER; // mark end of the spanpackages
    if (d_pdrawspans !== null) d_pdrawspans(a_spans, pstartIdx);
  }
}

/*
================
R_PolysetDrawThreshSpans8

Random fizzle fade rasterizer
================
*/
export function R_PolysetDrawThreshSpans8(spans: SpanpackageT[], start: number): void {
  const skin = requireSkin();
  const view = requireView();
  const zbuf = requireZbuffer();
  const colormap = requireColormap();

  let i = start;
  do {
    const pspan = spans[i];
    const lcount = d_aspancount - pspan.count;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_aspancount += d_countextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_aspancount += ubasestep;
    }

    if (lcount) {
      let lpdest = pspan.pdest;
      let lptex = pspan.ptex;
      let lpz = pspan.pz;
      let lsfrac = pspan.sfrac;
      let ltfrac = pspan.tfrac;
      let llight = pspan.light;
      let lzi = pspan.zi;
      let n = lcount;

      do {
        if (lzi >> 16 >= zbuf[lpz]) {
          rand1k_index = (rand1k_index + 1) & MASK_1K;

          if (rand1k[rand1k_index] <= r_affinetridesc.vis_thresh) {
            view[lpdest] = colormap[skin[lptex] + (llight & 0xff00)];
            zbuf[lpz] = lzi >> 16;
          }
        }

        lpdest++;
        lzi += r_zistepx;
        lpz++;
        llight += r_lstepx;
        lptex += a_ststepxwhole;
        lsfrac += a_sstepxfrac;
        lptex += lsfrac >> 16;
        lsfrac &= 0xffff;
        ltfrac += a_tstepxfrac;
        if (ltfrac & 0x10000) {
          lptex += r_affinetridesc.skinwidth;
          ltfrac &= 0xffff;
        }
      } while (--n);
    }

    i++;
  } while (spans[i].count !== SPAN_END_MARKER);
}

/*
================
R_PolysetDrawSpans8
================
*/
export function R_PolysetDrawSpans8_33(spans: SpanpackageT[], start: number): void {
  const skin = requireSkin();
  const view = requireView();
  const zbuf = requireZbuffer();
  const colormap = requireColormap();
  const alphamap = requireAlphamap();

  let i = start;
  do {
    const pspan = spans[i];
    const lcount = d_aspancount - pspan.count;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_aspancount += d_countextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_aspancount += ubasestep;
    }

    if (lcount) {
      let lpdest = pspan.pdest;
      let lptex = pspan.ptex;
      let lpz = pspan.pz;
      let lsfrac = pspan.sfrac;
      let ltfrac = pspan.tfrac;
      let llight = pspan.light;
      let lzi = pspan.zi;
      let n = lcount;

      do {
        if (lzi >> 16 >= zbuf[lpz]) {
          const temp = colormap[skin[lptex] + (llight & 0xff00)];
          view[lpdest] = alphamap[temp + view[lpdest] * 256];
        }
        lpdest++;
        lzi += r_zistepx;
        lpz++;
        llight += r_lstepx;
        lptex += a_ststepxwhole;
        lsfrac += a_sstepxfrac;
        lptex += lsfrac >> 16;
        lsfrac &= 0xffff;
        ltfrac += a_tstepxfrac;
        if (ltfrac & 0x10000) {
          lptex += r_affinetridesc.skinwidth;
          ltfrac &= 0xffff;
        }
      } while (--n);
    }

    i++;
  } while (spans[i].count !== SPAN_END_MARKER);
}

export function R_PolysetDrawSpansConstant8_33(spans: SpanpackageT[], start: number): void {
  const view = requireView();
  const zbuf = requireZbuffer();
  const alphamap = requireAlphamap();

  let i = start;
  do {
    const pspan = spans[i];
    const lcount = d_aspancount - pspan.count;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_aspancount += d_countextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_aspancount += ubasestep;
    }

    if (lcount) {
      let lpdest = pspan.pdest;
      let lpz = pspan.pz;
      let lzi = pspan.zi;
      let n = lcount;

      do {
        if (lzi >> 16 >= zbuf[lpz]) {
          view[lpdest] = alphamap[r_aliasblendcolor + view[lpdest] * 256];
        }
        lpdest++;
        lzi += r_zistepx;
        lpz++;
      } while (--n);
    }

    i++;
  } while (spans[i].count !== SPAN_END_MARKER);
}

export function R_PolysetDrawSpans8_66(spans: SpanpackageT[], start: number): void {
  const skin = requireSkin();
  const view = requireView();
  const zbuf = requireZbuffer();
  const colormap = requireColormap();
  const alphamap = requireAlphamap();

  let i = start;
  do {
    const pspan = spans[i];
    const lcount = d_aspancount - pspan.count;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_aspancount += d_countextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_aspancount += ubasestep;
    }

    if (lcount) {
      let lpdest = pspan.pdest;
      let lptex = pspan.ptex;
      let lpz = pspan.pz;
      let lsfrac = pspan.sfrac;
      let ltfrac = pspan.tfrac;
      let llight = pspan.light;
      let lzi = pspan.zi;
      let n = lcount;

      do {
        if (lzi >> 16 >= zbuf[lpz]) {
          const temp = colormap[skin[lptex] + (llight & 0xff00)];
          view[lpdest] = alphamap[temp * 256 + view[lpdest]];
          zbuf[lpz] = lzi >> 16;
        }
        lpdest++;
        lzi += r_zistepx;
        lpz++;
        llight += r_lstepx;
        lptex += a_ststepxwhole;
        lsfrac += a_sstepxfrac;
        lptex += lsfrac >> 16;
        lsfrac &= 0xffff;
        ltfrac += a_tstepxfrac;
        if (ltfrac & 0x10000) {
          lptex += r_affinetridesc.skinwidth;
          ltfrac &= 0xffff;
        }
      } while (--n);
    }

    i++;
  } while (spans[i].count !== SPAN_END_MARKER);
}

export function R_PolysetDrawSpansConstant8_66(spans: SpanpackageT[], start: number): void {
  const view = requireView();
  const zbuf = requireZbuffer();
  const alphamap = requireAlphamap();

  let i = start;
  do {
    const pspan = spans[i];
    const lcount = d_aspancount - pspan.count;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_aspancount += d_countextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_aspancount += ubasestep;
    }

    if (lcount) {
      let lpdest = pspan.pdest;
      let lpz = pspan.pz;
      let lzi = pspan.zi;
      let n = lcount;

      do {
        if (lzi >> 16 >= zbuf[lpz]) {
          view[lpdest] = alphamap[r_aliasblendcolor * 256 + view[lpdest]];
        }
        lpdest++;
        lzi += r_zistepx;
        lpz++;
      } while (--n);
    }

    i++;
  } while (spans[i].count !== SPAN_END_MARKER);
}

export function R_PolysetDrawSpans8_Opaque(spans: SpanpackageT[], start: number): void {
  const skin = requireSkin();
  const view = requireView();
  const zbuf = requireZbuffer();
  const colormap = requireColormap();

  const ir = r_newrefdef.rdflags & RDF_IRGOGGLES && currententity !== null && currententity.flags & RF_IR_VISIBLE;

  let i = start;
  do {
    const pspan = spans[i];
    const lcount = d_aspancount - pspan.count;

    errorterm += erroradjustup;
    if (errorterm >= 0) {
      d_aspancount += d_countextrastep;
      errorterm -= erroradjustdown;
    } else {
      d_aspancount += ubasestep;
    }

    if (lcount) {
      let lpdest = pspan.pdest;
      let lptex = pspan.ptex;
      let lpz = pspan.pz;
      let lsfrac = pspan.sfrac;
      let ltfrac = pspan.tfrac;
      let llight = pspan.light;
      let lzi = pspan.zi;
      let n = lcount;

      do {
        if (lzi >> 16 >= zbuf[lpz]) {
          // PGM
          if (ir) {
            view[lpdest] = colormap[irtable[skin[lptex]]];
          } else {
            view[lpdest] = colormap[skin[lptex] + (llight & 0xff00)];
          }
          zbuf[lpz] = lzi >> 16;
        }
        lpdest++;
        lzi += r_zistepx;
        lpz++;
        llight += r_lstepx;
        lptex += a_ststepxwhole;
        lsfrac += a_sstepxfrac;
        lptex += lsfrac >> 16;
        lsfrac &= 0xffff;
        ltfrac += a_tstepxfrac;
        if (ltfrac & 0x10000) {
          lptex += r_affinetridesc.skinwidth;
          ltfrac &= 0xffff;
        }
      } while (--n);
    }

    i++;
  } while (spans[i].count !== SPAN_END_MARKER);
}

/*
================
R_PolysetFillSpans8
================
*/
export function R_PolysetFillSpans8(spans: SpanpackageT[], start: number): void {
  const view = requireView();

  const color = d_aflatcolor++;

  let i = start;
  for (;;) {
    const pspan = spans[i];
    const lcount = pspan.count;

    if (lcount === -1) return;

    if (lcount) {
      let lpdest = pspan.pdest;
      let n = lcount;
      do {
        view[lpdest++] = color;
      } while (--n);
    }

    i++;
  }
}
