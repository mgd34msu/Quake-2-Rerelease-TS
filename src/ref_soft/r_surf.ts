/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_surf.c (GNU GPL v2 or later). `R_TextureAnimation`/
`D_SCDump`/`D_log2`/`MaskForNum` are static internal helpers (not declared
in r_local.h); `R_TextureAnimation`/`D_SCDump` stay module-private, while
`D_log2`/`MaskForNum` are exported since nothing in this file calls them
(they exist for future ref_soft siblings, same as in the C original) and
keeping them private would make them dead code. `D_SCAlloc` is also a
static internal helper in the C original, but this unit's test brief
requires exercising it directly, so it is exported here for testability
(unlike D_SCDump, which stays private since no test needs it).
`R_DrawSurfaceBlock8` (no mip suffix) and `R_DrawSurfaceBlock16` are
declared in r_local.h but have no definition anywhere in ref_soft's .c or
.asm sources (dead/stale declarations) -- reported omission, no port exists
for either.

Cache-ownership backlink design (`surfcache_t **owner`, typed `unknown` in
r_local.ts's SurfcacheT): C stores the address of the `msurface_t.cachespots[]`
slot that points at this cache block, so D_FlushCaches/D_SCAlloc can null
that slot out (`*cache->owner = NULL`) when reclaiming the block. Ported as
a concrete `{ surf: MsurfaceT; slot: number }` object (`SurfcacheOwnerT`),
assigned to the `unknown`-typed field in D_CacheSurface and read back via
the `isSurfcacheOwner` type guard (an `in`-based narrow, not a cast) in
D_FlushCaches/D_SCAlloc; reading `owner.surf.cachespots[owner.slot] = null`
reproduces `*cache->owner = NULL`.

Surface-cache allocator pointer-arithmetic reshaping (reported in the unit
report): the C allocator is a flat malloc'd byte heap (`sc_base`) with
`surfcache_t` headers embedded inline, walked and split/coalesced via raw
pointer arithmetic and compared against `sc_size` via `(byte*)sc_rover -
(byte*)sc_base`. Since SurfcacheT nodes here are independent JS objects
(their `.data` is its own separately-allocated Uint8Array, not a view into
shared memory), there is no address to subtract. A side `WeakMap<SurfcacheT,
number>` (`scPosition`) tracks each node's logical byte offset in the
abstract `sc_size`-byte arena, updated exactly where the C code would have
advanced a pointer (initial alloc, and the leftover-fragment split), which
preserves D_SCAlloc's wrap/coalesce/split control flow and space bookkeeping
without shared memory. `size = (int)&((surfcache_t*)0)->data[size]` (C's
"header bytes + payload bytes" idiom) becomes `SURFCACHE_HEADER_SIZE +
size`, an approximate constant standing in for `sizeof(surfcache_t)` minus
the trailing flexible-array placeholder; since nothing outside this
allocator ever compares that number to a real C `sizeof`, only internal
consistency (same constant used every time this file adds header overhead)
matters for the port's own correctness.

Cross-module mutable state: r_local.h's `sc_base`/`sc_rover`/
`d_roverwrapped`/`d_initial_rover`/`c_surf` are owned here, since the surface
cache allocator in this file is their only reader and writer. `D_SetInitialRover`
is the setter r_misc.ts's R_SetupFrame calls for the C original's per-frame
`d_roverwrapped = false; d_initial_rover = sc_rover;` reset.

`R_BuildLightMap` and its `blocklights` backing array are declared via a local
`extern` forward declaration inside r_surf.c rather than in r_local.h;
r_light.ts (r_light.c, their true C home) exports both and this file imports
them.
*/

import { ERR_FATAL, PRINT_ALL } from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";
import { SURFCACHE_SIZE_AT_320X240, SurfcacheT, currententity, r_drawsurf, r_framecount, r_newrefdef, rCvars, ri, vid } from "./r_local";
import { R_BuildLightMap, blocklights } from "./r_light";
import type { ImageT, MsurfaceT, MtexinfoT } from "./r_model";

//===========================================================================
// cache-ownership backlink -- see file header comment.

export interface SurfcacheOwnerT {
  surf: MsurfaceT;
  slot: number;
}

function isSurfcacheOwner(v: unknown): v is SurfcacheOwnerT {
  return typeof v === "object" && v !== null && "surf" in v && "slot" in v;
}

//===========================================================================
// surface cache allocator state -- see file header comment on relocation.

let sc_size = 0;
let sc_rover: SurfcacheT | null = null;
let sc_base: SurfcacheT | null = null;
let d_roverwrapped = false;
let d_initial_rover: SurfcacheT | null = null;
let r_cache_thrash = false; // set if surface cache is thrashing
let c_surf = 0;

// r_main.c's D_SetupFrame does both halves of this reset together.
export function D_SetInitialRover(): void {
  d_roverwrapped = false;
  d_initial_rover = sc_rover;
}

// pointer-arithmetic reshaping: replaces `(byte*)node - (byte*)sc_base`.
const scPosition = new WeakMap<SurfcacheT, number>();
function positionOf(c: SurfcacheT): number {
  return scPosition.get(c) ?? 0;
}

// approximates `sizeof(surfcache_t)` minus the flexible `data[]` member --
// see file header comment.
const SURFCACHE_HEADER_SIZE = 32;

//===========================================================================

// `lightleft`/`lightright`/`lightleftstep`/`lightrightstep`/`lighttemp`/
// `lightstep` are C globals in r_surf.c but are only ever set and consumed
// within a single R_DrawSurfaceBlock8_mip* call, never across calls; ported
// as ordinary function-locals in each block drawer below instead of module
// state -- behaviorally identical, not a restructuring of the algorithm.
// `sourcesstep`/`blockdivmask` are computed in the C original but never
// read anywhere (dead); dropped rather than carried as unused module state.
let blocksize = 0;
let sourcetstep = 0;
let blockdivshift = 0;
let prowdestbase = 0; // index into r_drawsurf.surfdat, replaces `void *prowdestbase`
let pbasesource = 0; // index into r_source, replaces `unsigned char *pbasesource`
let surfrowbytes = 0; // used by ASM files
let r_lightptr = 0; // index into blocklights, replaces `unsigned *r_lightptr`
let r_stepback = 0;
let r_lightwidth = 0;
let r_numhblocks = 0;
let r_numvblocks = 0;
let r_source: Uint8Array | null = null;
let r_sourcemax = 0; // index bound into r_source

const surfmiptable: (() => void)[] = fixedLength("surfmiptable", 4, [R_DrawSurfaceBlock8_mip0, R_DrawSurfaceBlock8_mip1, R_DrawSurfaceBlock8_mip2, R_DrawSurfaceBlock8_mip3]);

/*
===============
R_TextureAnimation

Returns the proper texture for a given time and base texture
===============
*/
function R_TextureAnimation(tex: MtexinfoT): ImageT | null {
  if (tex.next === null) return tex.image;

  const entity = currententity;
  if (entity === null) throw new Error("r_surf: R_TextureAnimation needs currententity");

  let c = entity.frame % tex.numframes;
  let t = tex;
  while (c) {
    const next = t.next;
    if (next === null) break;
    t = next;
    c--;
  }

  return t.image;
}

/*
===============
R_DrawSurface
===============
*/
function R_DrawSurface(): void {
  const mt = r_drawsurf.image;
  if (mt === null) throw new Error("r_surf: R_DrawSurface with no image");

  const source = mt.pixels[r_drawsurf.surfmip];
  if (source === null) throw new Error("r_surf: R_DrawSurface missing mip pixels");
  r_source = source;

  surfrowbytes = r_drawsurf.rowbytes;

  // the fractional light values should range from 0 to (VID_GRADES - 1) << 16
  // from a source range of 0 - 255

  const texwidth = mt.width >> r_drawsurf.surfmip;

  blocksize = 16 >> r_drawsurf.surfmip;
  blockdivshift = 4 - r_drawsurf.surfmip;
  const blockdivmask = (1 << blockdivshift) - 1; // computed but never read in the C original; kept for fidelity

  const surf = r_drawsurf.surf;
  if (surf === null) throw new Error("r_surf: R_DrawSurface with no surf");

  r_lightwidth = (surf.extents[0] >> 4) + 1;

  r_numhblocks = r_drawsurf.surfwidth >> blockdivshift;
  r_numvblocks = r_drawsurf.surfheight >> blockdivshift;

  //==============================

  const pblockdrawer = surfmiptable[r_drawsurf.surfmip];
  // TODO: only needs to be set when there is a display settings change
  const horzblockstep = blocksize;

  const smax = mt.width >> r_drawsurf.surfmip;
  const twidth = texwidth;
  const tmax = mt.height >> r_drawsurf.surfmip;
  sourcetstep = texwidth;
  r_stepback = tmax * twidth;

  r_sourcemax = tmax * smax;

  let soffset = surf.texturemins[0];
  const basetoffset = surf.texturemins[1];

  // << 16 components are to guarantee positive values for %
  soffset = ((soffset >> r_drawsurf.surfmip) + (smax << 16)) % smax;
  const basetptrIdx = (((basetoffset >> r_drawsurf.surfmip) + (tmax << 16)) % tmax) * twidth;

  if (r_drawsurf.surfdat === null) throw new Error("r_surf: R_DrawSurface with no surfdat");

  let pcolumndest = 0;

  for (let u = 0; u < r_numhblocks; u++) {
    r_lightptr = u;

    prowdestbase = pcolumndest;

    pbasesource = basetptrIdx + soffset;

    pblockdrawer();

    soffset = soffset + blocksize;
    if (soffset >= smax) soffset = 0;

    pcolumndest += horzblockstep;
  }
}

//=============================================================================

/*
================
R_DrawSurfaceBlock8_mip0
================
*/
function R_DrawSurfaceBlock8_mip0(): void {
  if (r_source === null || r_drawsurf.surfdat === null || vid.colormap === null) return;
  const source = r_source;
  const surfdat = r_drawsurf.surfdat;
  const colormap = vid.colormap;

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    // FIXME: make these locals?
    // FIXME: use delta rather than both right and left, like ASM?
    let lightleftV = blocklights[r_lightptr + 0];
    let lightrightV = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    const lightleftstepV = (blocklights[r_lightptr + 0] - lightleftV) >> 4;
    const lightrightstepV = (blocklights[r_lightptr + 1] - lightrightV) >> 4;

    for (let i = 0; i < 16; i++) {
      const lighttemp = lightleftV - lightrightV;
      const lightstep = lighttemp >> 4;

      let light = lightrightV;

      for (let b = 15; b >= 0; b--) {
        const pix = source[psource + b];
        surfdat[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightrightV += lightrightstepV;
      lightleftV += lightleftstepV;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock8_mip1
================
*/
function R_DrawSurfaceBlock8_mip1(): void {
  if (r_source === null || r_drawsurf.surfdat === null || vid.colormap === null) return;
  const source = r_source;
  const surfdat = r_drawsurf.surfdat;
  const colormap = vid.colormap;

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    let lightleftV = blocklights[r_lightptr + 0];
    let lightrightV = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    const lightleftstepV = (blocklights[r_lightptr + 0] - lightleftV) >> 3;
    const lightrightstepV = (blocklights[r_lightptr + 1] - lightrightV) >> 3;

    for (let i = 0; i < 8; i++) {
      const lighttemp = lightleftV - lightrightV;
      const lightstep = lighttemp >> 3;

      let light = lightrightV;

      for (let b = 7; b >= 0; b--) {
        const pix = source[psource + b];
        surfdat[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightrightV += lightrightstepV;
      lightleftV += lightleftstepV;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock8_mip2
================
*/
function R_DrawSurfaceBlock8_mip2(): void {
  if (r_source === null || r_drawsurf.surfdat === null || vid.colormap === null) return;
  const source = r_source;
  const surfdat = r_drawsurf.surfdat;
  const colormap = vid.colormap;

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    let lightleftV = blocklights[r_lightptr + 0];
    let lightrightV = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    const lightleftstepV = (blocklights[r_lightptr + 0] - lightleftV) >> 2;
    const lightrightstepV = (blocklights[r_lightptr + 1] - lightrightV) >> 2;

    for (let i = 0; i < 4; i++) {
      const lighttemp = lightleftV - lightrightV;
      const lightstep = lighttemp >> 2;

      let light = lightrightV;

      for (let b = 3; b >= 0; b--) {
        const pix = source[psource + b];
        surfdat[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightrightV += lightrightstepV;
      lightleftV += lightleftstepV;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock8_mip3
================
*/
function R_DrawSurfaceBlock8_mip3(): void {
  if (r_source === null || r_drawsurf.surfdat === null || vid.colormap === null) return;
  const source = r_source;
  const surfdat = r_drawsurf.surfdat;
  const colormap = vid.colormap;

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    let lightleftV = blocklights[r_lightptr + 0];
    let lightrightV = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    const lightleftstepV = (blocklights[r_lightptr + 0] - lightleftV) >> 1;
    const lightrightstepV = (blocklights[r_lightptr + 1] - lightrightV) >> 1;

    for (let i = 0; i < 2; i++) {
      const lighttemp = lightleftV - lightrightV;
      const lightstep = lighttemp >> 1;

      let light = lightrightV;

      for (let b = 1; b >= 0; b--) {
        const pix = source[psource + b];
        surfdat[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightrightV += lightrightstepV;
      lightleftV += lightleftstepV;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

//============================================================================

/*
================
R_InitCaches

================
*/
export function R_InitCaches(): void {
  let size: number;

  if (rCvars.sw_surfcacheoverride !== null && rCvars.sw_surfcacheoverride.value) {
    size = rCvars.sw_surfcacheoverride.value;
  } else {
    size = SURFCACHE_SIZE_AT_320X240;

    const pix = vid.width * vid.height;
    if (pix > 64000) size += (pix - 64000) * 3;
  }

  // round up to page size
  size = (size + 8191) & ~8191;

  ri.Con_Printf(PRINT_ALL, `${Math.trunc(size / 1024)}k surface cache\n`);

  sc_size = size;
  sc_base = new SurfcacheT();
  sc_base.next = null;
  sc_base.owner = null;
  sc_base.size = sc_size;
  scPosition.set(sc_base, 0);
  sc_rover = sc_base;
}

/*
==================
D_FlushCaches
==================
*/
export function D_FlushCaches(): void {
  if (sc_base === null) return;

  for (let c: SurfcacheT | null = sc_base; c !== null; c = c.next) {
    if (c.owner !== null && isSurfcacheOwner(c.owner)) {
      c.owner.surf.cachespots[c.owner.slot] = null;
    }
  }

  sc_rover = sc_base;
  sc_base.next = null;
  sc_base.owner = null;
  sc_base.size = sc_size;
  scPosition.set(sc_base, 0);
}

/*
=================
D_SCAlloc
=================
*/
export function D_SCAlloc(width: number, size: number): SurfcacheT {
  if (width < 0 || width > 256) ri.Sys_Error(ERR_FATAL, `D_SCAlloc: bad cache width ${width}\n`);

  if (size <= 0 || size > 0x10000) ri.Sys_Error(ERR_FATAL, `D_SCAlloc: bad cache size ${size}\n`);

  let allocSize = SURFCACHE_HEADER_SIZE + size;
  allocSize = (allocSize + 3) & ~3;
  if (allocSize > sc_size) ri.Sys_Error(ERR_FATAL, `D_SCAlloc: ${allocSize} > cache size of ${sc_size}`);

  // if there is not size bytes after the rover, reset to the start
  let wrapped_this_time = false;

  if (sc_rover === null || positionOf(sc_rover) > sc_size - allocSize) {
    if (sc_rover !== null) wrapped_this_time = true;
    sc_rover = sc_base;
  }

  if (sc_rover === null) ri.Sys_Error(ERR_FATAL, "D_SCAlloc: cache not initialized");

  // collect and free surfcache_t blocks until the rover block is large enough
  const newNode = sc_rover;
  if (newNode.owner !== null && isSurfcacheOwner(newNode.owner)) {
    newNode.owner.surf.cachespots[newNode.owner.slot] = null;
  }

  // `rover` walks the chain being coalesced into `newNode`; kept as its own
  // non-nullable local (rather than reassigning the nullable `sc_rover`
  // binding itself inside the loop) because TS widens a `let` back to its
  // declared (nullable) type for the whole loop body once it sees any
  // reassignment inside the loop.
  let rover: SurfcacheT = newNode;
  while (newNode.size < allocSize) {
    // free another
    const next: SurfcacheT | null = rover.next;
    if (next === null) {
      ri.Sys_Error(ERR_FATAL, "D_SCAlloc: hit the end of memory");
    }
    rover = next;
    if (rover.owner !== null && isSurfcacheOwner(rover.owner)) {
      rover.owner.surf.cachespots[rover.owner.slot] = null;
    }

    newNode.size += rover.size;
    newNode.next = rover.next;
  }
  sc_rover = rover;

  // create a fragment out of any leftovers
  if (newNode.size - allocSize > 256) {
    const fragment = new SurfcacheT();
    fragment.size = newNode.size - allocSize;
    fragment.next = newNode.next;
    fragment.width = 0;
    fragment.owner = null;
    scPosition.set(fragment, positionOf(newNode) + allocSize);

    newNode.next = fragment;
    newNode.size = allocSize;
    sc_rover = fragment;
  } else {
    sc_rover = newNode.next;
  }

  newNode.width = width;
  // DEBUG
  if (width > 0) newNode.height = Math.trunc((allocSize - SURFCACHE_HEADER_SIZE) / width);

  newNode.owner = null; // should be set properly after return
  // C hands back a pointer into the sc_base arena and allocates nothing;
  // minting a fresh buffer on every (re)allocation kept the GC hot under
  // cache thrash at large modes. Reuse the block's buffer when it fits.
  const wantBytes = width > 0 ? width * newNode.height : size;
  if (newNode.data.length !== wantBytes) newNode.data = new Uint8Array(wantBytes);

  if (d_roverwrapped) {
    if (wrapped_this_time || (sc_rover !== null && d_initial_rover !== null && positionOf(sc_rover) >= positionOf(d_initial_rover))) {
      r_cache_thrash = true;
    }
  } else if (wrapped_this_time) {
    d_roverwrapped = true;
  }

  return newNode;
}

/*
=================
D_SCDump
=================
*/
function D_SCDump(): void {
  for (let test: SurfcacheT | null = sc_base; test !== null; test = test.next) {
    if (test === sc_rover) ri.Con_Printf(PRINT_ALL, "ROVER:\n");
    ri.Con_Printf(PRINT_ALL, `${positionOf(test)} : ${test.size} bytes     ${test.width} width\n`);
  }
}
//=============================================================================

// if the num is not a power of 2, assume it will not repeat

export function MaskForNum(num: number): number {
  if (num === 128) return 127;
  if (num === 64) return 63;
  if (num === 32) return 31;
  if (num === 16) return 15;
  return 255;
}

export function D_log2(numArg: number): number {
  let num = numArg >> 1;
  let c = 0;

  while (num !== 0) {
    c++;
    num = num >> 1;
  }
  return c;
}

//=============================================================================

/*
================
D_CacheSurface
================
*/
export function D_CacheSurface(surface: MsurfaceT, miplevel: number): SurfcacheT {
  if (surface.texinfo === null) throw new Error("r_surf: surface has no texinfo");

  //
  // if the surface is animating or flashing, flush the cache
  //
  r_drawsurf.image = R_TextureAnimation(surface.texinfo);
  r_drawsurf.lightadj[0] = r_newrefdef.lightstyles[surface.styles[0]].white * 128;
  r_drawsurf.lightadj[1] = r_newrefdef.lightstyles[surface.styles[1]].white * 128;
  r_drawsurf.lightadj[2] = r_newrefdef.lightstyles[surface.styles[2]].white * 128;
  r_drawsurf.lightadj[3] = r_newrefdef.lightstyles[surface.styles[3]].white * 128;

  //
  // see if the cache holds apropriate data
  //
  let cache = surface.cachespots[miplevel];

  if (
    cache !== null &&
    !cache.dlight &&
    surface.dlightframe !== r_framecount &&
    cache.image === r_drawsurf.image &&
    cache.lightadj[0] === r_drawsurf.lightadj[0] &&
    cache.lightadj[1] === r_drawsurf.lightadj[1] &&
    cache.lightadj[2] === r_drawsurf.lightadj[2] &&
    cache.lightadj[3] === r_drawsurf.lightadj[3]
  ) {
    return cache;
  }

  //
  // determine shape of surface
  //
  const surfscale = 1.0 / (1 << miplevel);
  r_drawsurf.surfmip = miplevel;
  r_drawsurf.surfwidth = surface.extents[0] >> miplevel;
  r_drawsurf.rowbytes = r_drawsurf.surfwidth;
  r_drawsurf.surfheight = surface.extents[1] >> miplevel;

  //
  // allocate memory if needed
  //
  if (cache === null) {
    // if a texture just animated, don't reallocate it
    cache = D_SCAlloc(r_drawsurf.surfwidth, r_drawsurf.surfwidth * r_drawsurf.surfheight);
    surface.cachespots[miplevel] = cache;
    cache.owner = { surf: surface, slot: miplevel };
    cache.mipscale = surfscale;
  }

  cache.dlight = surface.dlightframe === r_framecount ? 1 : 0;

  r_drawsurf.surfdat = cache.data;

  cache.image = r_drawsurf.image;
  cache.lightadj[0] = r_drawsurf.lightadj[0];
  cache.lightadj[1] = r_drawsurf.lightadj[1];
  cache.lightadj[2] = r_drawsurf.lightadj[2];
  cache.lightadj[3] = r_drawsurf.lightadj[3];

  //
  // draw and light the surface texture
  //
  r_drawsurf.surf = surface;

  c_surf++;

  // calculate the lightings
  R_BuildLightMap();

  // rasterize the surface into the cache
  R_DrawSurface();

  return cache;
}
