/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_scan.c (d_scan.c in the file header comment; the
GPL source file itself is named r_scan.c) -- GNU GPL v2 or later.
`D_DrawTurbulent8Span` is a static internal helper (not declared in
r_local.h) and is exposed here only as a module-private function, per the
pending stub's note.

Cross-module mutable state: r_local.h declares `cacheblock`/`cachewidth`, the
ten `d_sdivz*`/`d_tdivz*`/`sadjust`/`tadjust`/`bbextent*` perspective
gradients, the three `d_zistep*`/`d_ziorigin` z gradients, and `d_viewbuffer`/
`r_screenwidth`/`d_pzbuffer`/`d_zwidth` as plain `extern` globals. This module
owns them: an imported `let` binding is read-only to the importer (bun throws
"Attempted to assign to readonly property"), so the writers -- r_edge.c's
surface fillers (r_edge.ts), r_poly.c's R_PolygonCalculateGradients (r_poly.ts)
and r_misc.c's R_SetupFrame/D_ViewChanged (r_misc.ts) -- go through the
exported `D_Set*` setters, and the readers import the bindings directly.
*/

import { AMP2, CYCLE, MAXHEIGHT, MAXWIDTH, SPEED, WARP_WIDTH, type EspanT, blanktable, intsintable, r_newrefdef, r_refdef, r_warpbuffer, sintable, vid } from "./r_local";

//===========================================================================
// relocated shared rasterizer state -- see file header comment.

export let cacheblock: Uint8Array | null = null;
export let cachewidth = 0;

// exported (not just for internal use) because D_FlatFillSurface, ported in
// r_edge.ts, also reads d_viewbuffer/r_screenwidth directly for its
// texture-free solid fill path.
export let d_viewbuffer: Uint8Array | null = null;
export let r_screenwidth = 0;
export let d_pzbuffer: Int16Array | null = null;
export let d_zwidth = 0;

export let d_sdivzstepu = 0;
export let d_tdivzstepu = 0;
export let d_sdivzstepv = 0;
export let d_tdivzstepv = 0;
export let d_sdivzorigin = 0;
export let d_tdivzorigin = 0;
export let d_zistepu = 0;
export let d_zistepv = 0;
export let d_ziorigin = 0;
export let sadjust = 0;
export let tadjust = 0;
export let bbextents = 0;
export let bbextentt = 0;

export function D_SetCacheSource(block: Uint8Array | null, width: number): void {
  cacheblock = block;
  cachewidth = width;
}

export function D_SetViewBuffer(buffer: Uint8Array | null, screenwidth: number): void {
  d_viewbuffer = buffer;
  r_screenwidth = screenwidth;
}

export function D_SetZBuffer(buffer: Int16Array | null, zwidth: number): void {
  d_pzbuffer = buffer;
  d_zwidth = zwidth;
}

// D_ViewChanged (r_misc.ts) re-derives `d_zwidth` from vid.width without
// reallocating the buffer.
export function D_SetZBufferWidth(zwidth: number): void {
  d_zwidth = zwidth;
}

export function D_SetZGradients(zistepu: number, zistepv: number, ziorigin: number): void {
  d_zistepu = zistepu;
  d_zistepv = zistepv;
  d_ziorigin = ziorigin;
}

export interface StGradientsT {
  sdivzstepu: number;
  tdivzstepu: number;
  sdivzstepv: number;
  tdivzstepv: number;
  sdivzorigin: number;
  tdivzorigin: number;
  sadjust: number;
  tadjust: number;
  bbextents: number;
  bbextentt: number;
}

export function D_SetStGradients(g: StGradientsT): void {
  d_sdivzstepu = g.sdivzstepu;
  d_tdivzstepu = g.tdivzstepu;
  d_sdivzstepv = g.sdivzstepv;
  d_tdivzstepv = g.tdivzstepv;
  d_sdivzorigin = g.sdivzorigin;
  d_tdivzorigin = g.tdivzorigin;
  sadjust = g.sadjust;
  tadjust = g.tadjust;
  bbextents = g.bbextents;
  bbextentt = g.bbextentt;
}

//===========================================================================

/*
=============
D_WarpScreen

this performs a slight compression of the screen at the same time as
the sine warp, to keep the edges from wrapping
=============
*/
let cached_width = 0;
let cached_height = 0;
const rowptr: number[] = new Array<number>(MAXHEIGHT + AMP2 * 2).fill(0); // index into r_warpbuffer, replaces byte*
const column: number[] = new Array<number>(MAXWIDTH + AMP2 * 2).fill(0);

export function D_WarpScreen(): void {
  const w = r_newrefdef.width;
  const h = r_newrefdef.height;
  if (w !== cached_width || h !== cached_height) {
    cached_width = w;
    cached_height = h;
    for (let v = 0; v < h + AMP2 * 2; v++) {
      const v2 = Math.trunc((v / (h + AMP2 * 2)) * r_refdef.vrect.height);
      rowptr[v] = WARP_WIDTH * v2;
    }

    for (let u = 0; u < w + AMP2 * 2; u++) {
      const u2 = Math.trunc((u / (w + AMP2 * 2)) * r_refdef.vrect.width);
      column[u] = u2;
    }
  }

  const turbOffset = Math.trunc(r_newrefdef.time * SPEED) & (CYCLE - 1);
  const turb = (i: number): number => intsintable[turbOffset + i];
  const destBase = r_newrefdef.y * vid.rowbytes + r_newrefdef.x;

  for (let v = 0; v < h; v++) {
    const destRow = destBase + v * vid.rowbytes;
    const colBase = turb(v);
    for (let u = 0; u < w; u += 4) {
      vid.buffer[destRow + u + 0] = r_warpbuffer[rowptr[v + turb(u + 0)] + column[colBase + u + 0]];
      vid.buffer[destRow + u + 1] = r_warpbuffer[rowptr[v + turb(u + 1)] + column[colBase + u + 1]];
      vid.buffer[destRow + u + 2] = r_warpbuffer[rowptr[v + turb(u + 2)] + column[colBase + u + 2]];
      vid.buffer[destRow + u + 3] = r_warpbuffer[rowptr[v + turb(u + 3)] + column[colBase + u + 3]];
    }
  }
}

//===========================================================================
// r_turb_* file statics (r_scan.c): private to the turbulent-span drawer.

let r_turb_turbTable: number[] = sintable; // reshaping of `int *r_turb_turb` into (table, offset)
let r_turb_turbOffset = 0;
let r_turb_pbase: Uint8Array | null = null;
let r_turb_pdestIdx = 0; // reshaping of `unsigned char *r_turb_pdest` into an index into d_viewbuffer
let r_turb_s = 0;
let r_turb_t = 0;
let r_turb_sstep = 0;
let r_turb_tstep = 0;
let r_turb_spancount = 0;

/*
=============
D_DrawTurbulent8Span
=============
*/
function D_DrawTurbulent8Span(): void {
  if (r_turb_pbase === null || d_viewbuffer === null) return;
  const pbase = r_turb_pbase;
  const buffer = d_viewbuffer;
  do {
    const sturb = ((r_turb_s + r_turb_turbTable[r_turb_turbOffset + ((r_turb_t >> 16) & (CYCLE - 1))]) >> 16) & 63;
    const tturb = ((r_turb_t + r_turb_turbTable[r_turb_turbOffset + ((r_turb_s >> 16) & (CYCLE - 1))]) >> 16) & 63;
    buffer[r_turb_pdestIdx++] = pbase[(tturb << 6) + sturb];
    r_turb_s += r_turb_sstep;
    r_turb_t += r_turb_tstep;
    r_turb_spancount--;
  } while (r_turb_spancount > 0);
}

function turbulentSpanCommon(pspanIn: EspanT | null): void {
  if (cacheblock === null) return;

  r_turb_sstep = 0; // keep compiler happy
  r_turb_tstep = 0; // ditto

  r_turb_pbase = cacheblock;

  const sdivz16stepu = d_sdivzstepu * 16;
  const tdivz16stepu = d_tdivzstepu * 16;
  const zi16stepu = d_zistepu * 16;

  let pspan = pspanIn;
  do {
    if (pspan === null || d_viewbuffer === null) break;

    r_turb_pdestIdx = r_screenwidth * pspan.v + pspan.u;

    let count = pspan.count;

    // calculate the initial s/z, t/z, 1/z, s, and t and clamp
    const du = pspan.u;
    const dv = pspan.v;

    let sdivz = d_sdivzorigin + dv * d_sdivzstepv + du * d_sdivzstepu;
    let tdivz = d_tdivzorigin + dv * d_tdivzstepv + du * d_tdivzstepu;
    let zi = d_ziorigin + dv * d_zistepv + du * d_zistepu;
    let z = 0x10000 / zi; // prescale to 16.16 fixed-point

    r_turb_s = Math.trunc(sdivz * z) + sadjust;
    if (r_turb_s > bbextents) r_turb_s = bbextents;
    else if (r_turb_s < 0) r_turb_s = 0;

    r_turb_t = Math.trunc(tdivz * z) + tadjust;
    if (r_turb_t > bbextentt) r_turb_t = bbextentt;
    else if (r_turb_t < 0) r_turb_t = 0;

    let snext = 0;
    let tnext = 0;

    do {
      // calculate s and t at the far end of the span
      r_turb_spancount = count >= 16 ? 16 : count;

      count -= r_turb_spancount;

      if (count) {
        // calculate s/z, t/z, zi->fixed s and t at far end of span,
        // calculate s and t steps across span by shifting
        sdivz += sdivz16stepu;
        tdivz += tdivz16stepu;
        zi += zi16stepu;
        z = 0x10000 / zi; // prescale to 16.16 fixed-point

        snext = Math.trunc(sdivz * z) + sadjust;
        if (snext > bbextents) snext = bbextents;
        else if (snext < 16) snext = 16; // prevent round-off error on <0 steps from
        // from causing overstepping & running off the
        // edge of the texture

        tnext = Math.trunc(tdivz * z) + tadjust;
        if (tnext > bbextentt) tnext = bbextentt;
        else if (tnext < 16) tnext = 16; // guard against round-off error on <0 steps

        r_turb_sstep = (snext - r_turb_s) >> 4;
        r_turb_tstep = (tnext - r_turb_t) >> 4;
      } else {
        // calculate s/z, t/z, zi->fixed s and t at last pixel in span (so
        // can't step off polygon), clamp, calculate s and t steps across
        // span by division, biasing steps low so we don't run off the
        // texture
        const spancountminus1 = r_turb_spancount - 1;
        sdivz += d_sdivzstepu * spancountminus1;
        tdivz += d_tdivzstepu * spancountminus1;
        zi += d_zistepu * spancountminus1;
        z = 0x10000 / zi; // prescale to 16.16 fixed-point
        snext = Math.trunc(sdivz * z) + sadjust;
        if (snext > bbextents) snext = bbextents;
        else if (snext < 16) snext = 16; // prevent round-off error on <0 steps from
        // from causing overstepping & running off the
        // edge of the texture

        tnext = Math.trunc(tdivz * z) + tadjust;
        if (tnext > bbextentt) tnext = bbextentt;
        else if (tnext < 16) tnext = 16; // guard against round-off error on <0 steps

        if (r_turb_spancount > 1) {
          r_turb_sstep = Math.trunc((snext - r_turb_s) / (r_turb_spancount - 1));
          r_turb_tstep = Math.trunc((tnext - r_turb_t) / (r_turb_spancount - 1));
        }
      }

      r_turb_s = r_turb_s & ((CYCLE << 16) - 1);
      r_turb_t = r_turb_t & ((CYCLE << 16) - 1);

      D_DrawTurbulent8Span();

      r_turb_s = snext;
      r_turb_t = tnext;
    } while (count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}

/*
=============
Turbulent8
=============
*/
export function Turbulent8(pspan: EspanT | null): void {
  const turbOffset = Math.trunc(r_newrefdef.time * SPEED) & (CYCLE - 1);
  r_turb_turbTable = sintable;
  r_turb_turbOffset = turbOffset;
  turbulentSpanCommon(pspan);
}

//====================
//PGM
/*
=============
NonTurbulent8 - this is for drawing scrolling textures. they're warping water textures
	but the turbulence is automatically 0.
=============
*/
export function NonTurbulent8(pspan: EspanT | null): void {
  r_turb_turbTable = blanktable;
  r_turb_turbOffset = 0;
  turbulentSpanCommon(pspan);
}
//PGM
//====================

/*
=============
D_DrawSpans16

  FIXME: actually make this subdivide by 16 instead of 8!!!
=============
*/
export function D_DrawSpans16(pspanIn: EspanT | null): void {
  if (cacheblock === null) return;
  const pbase = cacheblock;

  let sstep = 0; // keep compiler happy
  let tstep = 0; // ditto

  const sdivz8stepu = d_sdivzstepu * 8;
  const tdivz8stepu = d_tdivzstepu * 8;
  const zi8stepu = d_zistepu * 8;

  let pspan = pspanIn;
  do {
    if (pspan === null || d_viewbuffer === null) break;
    const buffer = d_viewbuffer;

    let destIdx = r_screenwidth * pspan.v + pspan.u;

    let count = pspan.count;

    // calculate the initial s/z, t/z, 1/z, s, and t and clamp
    const du = pspan.u;
    const dv = pspan.v;

    let sdivz = d_sdivzorigin + dv * d_sdivzstepv + du * d_sdivzstepu;
    let tdivz = d_tdivzorigin + dv * d_tdivzstepv + du * d_tdivzstepu;
    let zi = d_ziorigin + dv * d_zistepv + du * d_zistepu;
    let z = 0x10000 / zi; // prescale to 16.16 fixed-point

    let s = Math.trunc(sdivz * z) + sadjust;
    if (s > bbextents) s = bbextents;
    else if (s < 0) s = 0;

    let t = Math.trunc(tdivz * z) + tadjust;
    if (t > bbextentt) t = bbextentt;
    else if (t < 0) t = 0;

    let snext = 0;
    let tnext = 0;

    do {
      // calculate s and t at the far end of the span
      let spancount = count >= 8 ? 8 : count;

      count -= spancount;

      if (count) {
        // calculate s/z, t/z, zi->fixed s and t at far end of span,
        // calculate s and t steps across span by shifting
        sdivz += sdivz8stepu;
        tdivz += tdivz8stepu;
        zi += zi8stepu;
        z = 0x10000 / zi; // prescale to 16.16 fixed-point

        snext = Math.trunc(sdivz * z) + sadjust;
        if (snext > bbextents) snext = bbextents;
        else if (snext < 8) snext = 8; // prevent round-off error on <0 steps from
        // from causing overstepping & running off the
        // edge of the texture

        tnext = Math.trunc(tdivz * z) + tadjust;
        if (tnext > bbextentt) tnext = bbextentt;
        else if (tnext < 8) tnext = 8; // guard against round-off error on <0 steps

        sstep = (snext - s) >> 3;
        tstep = (tnext - t) >> 3;
      } else {
        // calculate s/z, t/z, zi->fixed s and t at last pixel in span (so
        // can't step off polygon), clamp, calculate s and t steps across
        // span by division, biasing steps low so we don't run off the
        // texture
        const spancountminus1 = spancount - 1;
        sdivz += d_sdivzstepu * spancountminus1;
        tdivz += d_tdivzstepu * spancountminus1;
        zi += d_zistepu * spancountminus1;
        z = 0x10000 / zi; // prescale to 16.16 fixed-point
        snext = Math.trunc(sdivz * z) + sadjust;
        if (snext > bbextents) snext = bbextents;
        else if (snext < 8) snext = 8; // prevent round-off error on <0 steps from
        // from causing overstepping & running off the
        // edge of the texture

        tnext = Math.trunc(tdivz * z) + tadjust;
        if (tnext > bbextentt) tnext = bbextentt;
        else if (tnext < 8) tnext = 8; // guard against round-off error on <0 steps

        if (spancount > 1) {
          sstep = Math.trunc((snext - s) / (spancount - 1));
          tstep = Math.trunc((tnext - t) / (spancount - 1));
        }
      }

      do {
        buffer[destIdx++] = pbase[(s >> 16) + (t >> 16) * cachewidth];
        s += sstep;
        t += tstep;
        spancount--;
      } while (spancount > 0);

      s = snext;
      t = tnext;
    } while (count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}

/*
=============
D_DrawZSpans

Ported as a single per-pixel loop: the C original writes pairs of `short`
z-values via one 32-bit store, guarded by a leading `(long)pdest & 0x02`
alignment fixup so the paired store lands on a 4-byte boundary. That
alignment/pairing is a pure memory-layout micro-optimization -- d_pzbuffer
here is an Int16Array indexed by element, with no such addressing concept
-- and produces the exact same sequence of values (izi stepped by izistep
once per sample, truncated to int16) regardless of how the writes are
paired, so it is dropped as an output-identical deviation.
=============
*/
export function D_DrawZSpans(pspanIn: EspanT | null): void {
  if (d_pzbuffer === null) return;
  const buffer = d_pzbuffer;

  // FIXME: check for clamping/range problems
  // we count on FP exceptions being turned off to avoid range problems
  const izistep = Math.trunc(d_zistepu * 0x8000 * 0x10000) | 0;

  let pspan = pspanIn;
  while (pspan !== null) {
    let destIdx = d_zwidth * pspan.v + pspan.u;

    const count = pspan.count;

    // calculate the initial 1/z
    const du = pspan.u;
    const dv = pspan.v;

    const zi = d_ziorigin + dv * d_zistepv + du * d_zistepu;
    // we count on FP exceptions being turned off to avoid range problems
    let izi = Math.trunc(zi * 0x8000 * 0x10000) | 0;

    for (let i = 0; i < count; i++) {
      buffer[destIdx++] = izi >> 16;
      izi = (izi + izistep) | 0;
    }

    pspan = pspan.pnext;
  }
}
