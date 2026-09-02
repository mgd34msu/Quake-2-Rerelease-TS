/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_local.h (GNU GPL v2 or later). Pure header module --
there is no r_local.c -- so this carries only types, constants, and the
shared mutable globals every r_*.ts module reads/writes, mirroring
g_local.ts's role for the game track.

An imported `let` binding is read-only to the importer, so every global here
that a sibling module reassigns has a `Set*` setter next to it (the same shape
as g_local.ts's SetGameImports/SetGEdicts and PORTING.md's "C globals that are
reassigned pointers become fields on their owning singleton or a small
exported holder object"); readers import the binding itself and see the live
value. A few r_local.h externs are owned by the module that is their only
reader and writer instead of living here -- r_scan.ts (span gradients and
frame/z buffers), r_surf.ts (surface cache rover), r_part.ts (particle clip
rect), r_polyse.ts (polygon-set edge stepping), r_rast.ts (`sky_texinfo`, as
`r_skytexinfo`) -- each noted at the point where it would otherwise appear.

`image_t`/model_t/msurface_t/mnode_t/mleaf_t/mtexinfo_t/medge_t live in
r_model.ts per that module's header comment (brief places image_t there
even though the true C source declares it in r_local.h just above
`#include "r_model.h"`; PORTING.md: "the brief's placement wins; report the
mismatch"). Only `import type` is used for that dependency and for
r_model.ts's reverse dependency on SurfcacheT here -- both sides are
type-only (no runtime value crosses either way at module-init time), so
this doesn't hit PORTING.md's import-cycle rule (which only fires for
value imports that break init order).
*/

import { type Vec3, vec3 } from "../shared/math";
import { CplaneT, type CvarT } from "../shared/q_shared";
import type { RefImports } from "../client/ref";
import { EntityT, RefdefT } from "../client/ref";
import type { ImageT, MedgeT, ModelT, MleafT, MplaneT, MsurfaceT, MvertexT } from "./r_model";

export const REF_VERSION = "SOFT 0.01";

// up / down
export const PITCH = 0;
// left / right
export const YAW = 1;
// fall over
export const ROLL = 2;

//===================================================================

// pixel_t is `unsigned char` in C: every framebuffer/surface/cache byte
// buffer is a Uint8Array (see viddef_t.buffer below) and a "pixel_t" value
// is simply one of its elements -- an 8-bit index into the current
// palette/colormap, never an RGB value. Kept as a documented alias rather
// than a branded type since nothing here needs to distinguish it from a
// plain byte at the type level.
export type PixelT = number;

export class VrectT {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  pnext: VrectT | null = null;
}

export class ViddefT {
  buffer: Uint8Array = new Uint8Array(0); // invisible buffer
  colormap: Uint8Array | null = null; // 256 * VID_GRADES size
  alphamap: Uint8Array | null = null; // 256 * 256 translucency map
  rowbytes = 0; // may be > width if displayed in a window
  width = 0;
  height = 0;
}

export enum RserrT {
  rserr_ok,
  rserr_invalid_fullscreen,
  rserr_invalid_mode,
  rserr_unknown,
}

export const vid: ViddefT = new ViddefT();

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class OldrefdefT {
  vrect: VrectT = new VrectT(); // subwindow in video for refresh
  aliasvrect: VrectT = new VrectT(); // scaled Alias version
  vrectright = 0;
  vrectbottom = 0; // right & bottom screen coords
  aliasvrectright = 0;
  aliasvrectbottom = 0; // scaled Alias versions
  vrectrightedge = 0; // rightmost right edge we care about, for use in edge list
  fvrectx = 0;
  fvrecty = 0; // for floating-point compares
  fvrectx_adj = 0;
  fvrecty_adj = 0; // left and top edges, for clamping
  vrect_x_adj_shift20 = 0; // (vrect.x + 0.5 - epsilon) << 20
  vrectright_adj_shift20 = 0; // (vrectright + 0.5 - epsilon) << 20
  fvrectright_adj = 0;
  fvrectbottom_adj = 0; // right and bottom edges, for clamping
  fvrectright = 0; // rightmost edge, for Alias clamping
  fvrectbottom = 0; // bottommost edge, for Alias clamping
  horizontalFieldOfView = 0; // at Z = 1.0, this many X is visible; 2.0 = 90 degrees
  xOrigin = 0; // should probably always be 0.5
  yOrigin = 0; // between be around 0.3 to 0.5

  vieworg: Vec3 = vec3();
  viewangles: Vec3 = vec3();

  ambientlight = 0;
}

export const r_refdef: OldrefdefT = new OldrefdefT();

export const CACHE_SIZE = 32;

/*
====================================================
  CONSTANTS
====================================================
*/

export const VID_CBITS = 6;
export const VID_GRADES = 1 << VID_CBITS;

export const MAXVERTS = 64; // max points in a surface polygon
export const MAXWORKINGVERTS = MAXVERTS + 4; // max points in an intermediate polygon (while processing)
// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const MAXHEIGHT = 1200;
export const MAXWIDTH = 1920; // raised past the C-era 4:3 table for mode 10 (1920x1080)

export const INFINITE_DISTANCE = 0x10000; // distance that's always guaranteed farther than anything in the scene

export const WARP_WIDTH = 320;
export const WARP_HEIGHT = 240;

export const MAX_LBM_HEIGHT = 480;

export const PARTICLE_Z_CLIP = 8.0;

// !!! must be kept the same as in quakeasm.h !!!
export const TRANSPARENT_COLOR = 0xff;

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const TURB_TEX_SIZE = 64; // base turbulent texture size
// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const CYCLE = 128; // turbulent cycle size

export const SCANBUFFERPAD = 0x1000;

export const DS_SPAN_LIST_END = -128;

export const NUMSTACKEDGES = 2000;
export const MINEDGES = NUMSTACKEDGES;
export const NUMSTACKSURFACES = 1000;
export const MINSURFACES = NUMSTACKSURFACES;
export const MAXSPANS = 3000;

// flags in finalvert_t.flags
export const ALIAS_LEFT_CLIP = 0x0001;
export const ALIAS_TOP_CLIP = 0x0002;
export const ALIAS_RIGHT_CLIP = 0x0004;
export const ALIAS_BOTTOM_CLIP = 0x0008;
export const ALIAS_Z_CLIP = 0x0010;
export const ALIAS_XY_CLIP_MASK = 0x000f;

export const SURFCACHE_SIZE_AT_320X240 = 1024 * 768;

export const BMODEL_FULLY_CLIPPED = 0x10; // value returned by R_BmodelCheckBBox() if bbox is trivially rejected

export const XCENTERING = 1.0 / 2.0;
export const YCENTERING = 1.0 / 2.0;

export const CLIP_EPSILON = 0.001;

export const BACKFACE_EPSILON = 0.01;

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export const NEAR_CLIP = 0.01;

export const MAXALIASVERTS = 2000; // TODO: tune this
export const ALIAS_Z_CLIP_PLANE = 4;

// turbulence stuff
export const AMP = 8 * 0x10000;
export const AMP2 = 3;
export const SPEED = 20;

/*
====================================================
  TYPES
====================================================
*/

export class EmitpointT {
  u = 0;
  v = 0;
  s = 0;
  t = 0;
  zi = 0;
}

// finalvert_t: SMALL_FINALVERT is 0 in the original (#if SMALL_FINALVERT is
// dead code), so only the non-small (int fields) layout is ported. The
// FINALVERT_* byte-offset #defines that follow it in C exist only to
// support the unported x86 asm rasterizer and are dropped, same rationale
// as CplaneT's dropped pad[2].
export class FinalvertT {
  u = 0;
  v = 0;
  s = 0;
  t = 0;
  l = 0;
  zi = 0;
  flags = 0;
  xyz: Vec3 = vec3(); // eye space
}

// void* pskin / dtriangle_t* ptriangles are opaque MD2-loader-owned
// pointers; qfiles.ts explicitly defers the MD2 format to the future
// alias-model-loading unit (see its file header), so these stay `unknown`
// here the same way ref.ts forward-declares ModelS/ImageS.
export class AffinetridescT {
  pskin: unknown = null;
  pskindesc = 0;
  skinwidth = 0;
  skinheight = 0;
  ptriangles: unknown = null;
  pfinalverts: FinalvertT[] | null = null;
  numtriangles = 0;
  drawtype = 0;
  seamfixupX16 = 0;
  do_vis_thresh = false;
  vis_thresh = 0;
}

export class DrawsurfT {
  surfdat: Uint8Array | null = null; // destination for generated surface
  rowbytes = 0; // destination logical width in bytes
  surf: MsurfaceT | null = null; // description for surface to generate
  lightadj: number[] = new Array<number>(4).fill(0); // MAXLIGHTMAPS; adjust for lightmap levels for dynamic lighting
  image: ImageT | null = null;
  surfmip = 0; // mipmapped ratio of surface texels / world pixels
  surfwidth = 0; // in mipmapped texels
  surfheight = 0; // in mipmapped texels
}

export class AlightT {
  ambientlight = 0;
  shadelight = 0;
  plightvec: Vec3 | null = null;
}

// clipped bmodel edges
export class BedgeT {
  v: [MvertexT | null, MvertexT | null] = [null, null];
  pnext: BedgeT | null = null;
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class ClipplaneT {
  normal: Vec3 = vec3();
  dist = 0;
  next: ClipplaneT | null = null;
  leftedge = 0;
  rightedge = 0;
  // trailing `byte reserved[2]` dropped: struct-alignment padding only.
}

// `struct surfcache_s **owner` is the address of whichever pointer
// currently references this cache block (nulled out when the cache is
// evicted, i.e. `*cache->owner = NULL`). Left `unknown` here -- this is a
// pure data-shape port and the real aliasing behavior belongs to r_surf.ts's
// future D_SCAlloc/D_FlushCaches port, not this type declaration.
export class SurfcacheT {
  next: SurfcacheT | null = null;
  owner: unknown = null;
  lightadj: number[] = new Array<number>(4).fill(0); // MAXLIGHTMAPS; checked for strobe flush
  dlight = 0;
  size = 0; // including header
  width = 0;
  height = 0; // DEBUG only needed for debug
  mipscale = 0;
  image: ImageT | null = null;
  data: Uint8Array = new Uint8Array(0); // width*height elements
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class EspanT {
  u = 0;
  v = 0;
  count = 0;
  pnext: EspanT | null = null;
}

// used by the polygon drawer (R_POLY.C) and sprite setup code (R_SPRITE.C)
export class PolydescT {
  nump = 0;
  pverts: EmitpointT[] | null = null;
  pixels: Uint8Array | null = null; // image
  pixel_width = 0;
  pixel_height = 0;
  vup: Vec3 = vec3();
  vright: Vec3 = vec3();
  vpn: Vec3 = vec3(); // in worldspace, for plane eq
  dist = 0;
  s_offset = 0;
  t_offset = 0;
  viewer_position: Vec3 = vec3();
  drawspanlet: (() => void) | null = null;
  stipple_parity = 0;
}

// FIXME: compress, make a union if that will help
// insubmodel is only 1, flags is fewer than 32, spanstate could be a byte
export class SurfT {
  next: SurfT | null = null; // active surface stack in r_edge.c
  prev: SurfT | null = null; // used in r_edge.c for active surf stack
  spans: EspanT | null = null; // pointer to linked list of spans to draw
  key = 0; // sorting key (BSP order)
  last_u = 0; // set during tracing
  spanstate = 0; // 0 = not in span, 1 = in span, -1 = in inverted span (end before start)
  flags = 0; // currentface flags
  msurf: MsurfaceT | null = null;
  entity: EntityT | null = null;
  nearzi = 0; // nearest 1/z on surface, for mipmapping
  insubmodel = false;
  d_ziorigin = 0;
  d_zistepu = 0;
  d_zistepv = 0;
  // trailing `int pad[2]` dropped: struct-alignment padding only.
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class EdgeT {
  u = 0; // fixed16_t
  u_step = 0; // fixed16_t
  prev: EdgeT | null = null;
  next: EdgeT | null = null;
  surfs: [number, number] = [0, 0]; // unsigned short[2]
  nextremove: EdgeT | null = null;
  nearzi = 0;
  owner: MedgeT | null = null;
}

/*
====================================================
  VARS
====================================================
*/

export let d_spanpixcount = 0;
export let r_framecount = 0; // sequence # of current frame since Quake started
export let r_aliasuvscale = 0; // scale-up factor for screen u and v on Alias vertices passed to driver
export let r_dowarp = false;

export function SetFrameCount(v: number): void {
  r_framecount = v;
}

export function SetAliasUvScale(v: number): void {
  r_aliasuvscale = v;
}

export function SetDowarp(v: boolean): void {
  r_dowarp = v;
}

export const r_affinetridesc: AffinetridescT = new AffinetridescT();

export const r_pright: Vec3 = vec3();
export const r_pup: Vec3 = vec3();
export const r_ppn: Vec3 = vec3();

export let acolormap: unknown = null; // FIXME: should go away

//=======================================================================//
// callbacks to Quake

export const r_drawsurf: DrawsurfT = new DrawsurfT();

export const r_warpbuffer: Uint8Array = new Uint8Array(WARP_WIDTH * WARP_HEIGHT);

export let scale_for_mip = 0;
export let d_zrowbytes = 0;
export let d_minmip = 0;

// `c_surf`/`sc_base`/`sc_rover`/`d_roverwrapped`/`d_initial_rover` are owned
// by r_surf.ts (the surface cache allocator is their only reader/writer);
// `cacheblock`/`cachewidth`/`d_viewbuffer`/`r_screenwidth`/`d_pzbuffer`/
// `d_zwidth` and the `d_sdivz*`/`d_tdivz*`/`d_zistep*`/`d_ziorigin`/
// `sadjust`/`tadjust`/`bbextent*` gradients by r_scan.ts (its D_Set* family);
// `d_vrect*`/`d_pix_*` by r_part.ts (its D_SetParticle* family);
// `ubasestep`/`errorterm`/`erroradjust*` by r_polyse.ts.

export const zspantable: (Int16Array | null)[] = new Array<Int16Array | null>(MAXHEIGHT).fill(null);
export const d_scantable: number[] = new Array<number>(MAXHEIGHT).fill(0);

export const d_scalemip: number[] = new Array<number>(3).fill(0);

export function D_SetMipState(scaleForMip: number, minmip: number, zrowbytes: number): void {
  scale_for_mip = scaleForMip;
  d_minmip = minmip;
  d_zrowbytes = zrowbytes;
}

//===================================================================

export let r_drawnpolycount = 0;

export function SetDrawnPolyCount(v: number): void {
  r_drawnpolycount = v;
}

// C sized these 1280 (R_InitTurb's hardcoded loop bound); D_WarpScreen
// indexes up to refdef width + CYCLE, so they scale with MAXWIDTH here.
export const SIN_BUFFER_SIZE = MAXWIDTH + CYCLE;
export const sintable: number[] = new Array<number>(SIN_BUFFER_SIZE).fill(0);
export const intsintable: number[] = new Array<number>(SIN_BUFFER_SIZE).fill(0);
export const blanktable: number[] = new Array<number>(SIN_BUFFER_SIZE).fill(0); // PGM

export const vup: Vec3 = vec3();
export const base_vup: Vec3 = vec3();
export const vpn: Vec3 = vec3();
export const base_vpn: Vec3 = vec3();
export const vright: Vec3 = vec3();
export const base_vright: Vec3 = vec3();

// surfaces are generated in back to front order by the bsp, so if a surf
// pointer is greater than another one, it should be drawn in front
// surfaces[1] is the background, and is used as the active surface stack.
// surfaces[0] is a dummy, because index 0 is used to indicate no surface
// attached to an edge_t
export let surfaces: SurfT[] | null = null;
export let surface_p: number = 0; // index into `surfaces`, replaces the C `surf_t *` cursor
export let surf_max: number = 0;

export function SetSurfaces(v: SurfT[] | null): void {
  surfaces = v;
}

export function SetSurfaceP(v: number): void {
  surface_p = v;
}

export function SetSurfMax(v: number): void {
  surf_max = v;
}

//===================================================================

export const sxformaxis: [Vec3, Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3(), vec3()]; // s axis transformed into viewspace
export const txformaxis: [Vec3, Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3(), vec3()]; // t axis transformed into viewspace

export let xcenter = 0;
export let ycenter = 0;
export let xscale = 0;
export let yscale = 0;
export let xscaleinv = 0;
export let yscaleinv = 0;
export let xscaleshrink = 0;
export let yscaleshrink = 0;

// R_ViewChanged (r_misc.ts) recomputes this whole block together every frame;
// one grouped setter rather than fifteen, same shape as r_scan.ts's
// D_SetStGradients.
export interface ViewScalesT {
  xcenter: number;
  ycenter: number;
  xscale: number;
  yscale: number;
  xscaleinv: number;
  yscaleinv: number;
  xscaleshrink: number;
  yscaleshrink: number;
  aliasxscale: number;
  aliasyscale: number;
  aliasxcenter: number;
  aliasycenter: number;
  verticalFieldOfView: number;
  xOrigin: number;
  yOrigin: number;
}

export function SetViewCenter(xc: number, yc: number): void {
  xcenter = xc;
  ycenter = yc;
}

export function SetViewShrink(xs: number, ys: number): void {
  xscaleshrink = xs;
  yscaleshrink = ys;
}

export function R_SetViewScales(v: ViewScalesT): void {
  xcenter = v.xcenter;
  ycenter = v.ycenter;
  xscale = v.xscale;
  yscale = v.yscale;
  xscaleinv = v.xscaleinv;
  yscaleinv = v.yscaleinv;
  xscaleshrink = v.xscaleshrink;
  yscaleshrink = v.yscaleshrink;
  aliasxscale = v.aliasxscale;
  aliasyscale = v.aliasyscale;
  aliasxcenter = v.aliasxcenter;
  aliasycenter = v.aliasycenter;
  verticalFieldOfView = v.verticalFieldOfView;
  xOrigin = v.xOrigin;
  yOrigin = v.yOrigin;
}

//===========================================================================

// cvars -- grouped into one mutable holder (mirrors client.ts's clCvars/
// server.ts's svClientHolder pattern) rather than per-cvar setter functions.
export const rCvars: {
  sw_aliasstats: CvarT | null;
  sw_clearcolor: CvarT | null;
  sw_drawflat: CvarT | null;
  sw_draworder: CvarT | null;
  sw_maxedges: CvarT | null;
  sw_maxsurfs: CvarT | null;
  sw_mipcap: CvarT | null;
  sw_mipscale: CvarT | null;
  sw_mode: CvarT | null;
  sw_reportsurfout: CvarT | null;
  sw_reportedgeout: CvarT | null;
  sw_stipplealpha: CvarT | null;
  sw_surfcacheoverride: CvarT | null;
  sw_waterwarp: CvarT | null;

  r_fullbright: CvarT | null;
  r_lefthand: CvarT | null;
  r_drawentities: CvarT | null;
  r_drawworld: CvarT | null;
  r_dspeeds: CvarT | null;
  r_lerpmodels: CvarT | null;

  r_speeds: CvarT | null;

  r_lightlevel: CvarT | null; // FIXME HACK

  vid_fullscreen: CvarT | null;
  vid_gamma: CvarT | null;
  // v1.0.0 RC resolution scaling (src/platform/vid_scale.ts/swimp.ts): no
  // C-original or q2repro field to mirror -- see vid.ts's VID_GetScale
  // header comment. Tracked here only so R_BeginFrame's mode-restart loop
  // can detect "modified" the same way sw_mode/vid_fullscreen already do;
  // swimp.ts reads the cvar's live value directly, not through this struct.
  vid_scale: CvarT | null;
  // Bug fix (Mike, 2026-09-02): same reason as vid_scale immediately above
  // -- tracked here so R_BeginFrame's mode-restart loop can detect
  // "modified" when only "scale to fullscreen" changes (previously missing
  // entirely: that toggle alone never took effect until some other
  // video-menu change also forced a restart). swimp.ts still reads the
  // cvar's live value directly, not through this struct.
  vid_scale_fit: CvarT | null;
} = {
  sw_aliasstats: null,
  sw_clearcolor: null,
  sw_drawflat: null,
  sw_draworder: null,
  sw_maxedges: null,
  sw_maxsurfs: null,
  sw_mipcap: null,
  sw_mipscale: null,
  sw_mode: null,
  sw_reportsurfout: null,
  sw_reportedgeout: null,
  sw_stipplealpha: null,
  sw_surfcacheoverride: null,
  sw_waterwarp: null,

  r_fullbright: null,
  r_lefthand: null,
  r_drawentities: null,
  r_drawworld: null,
  r_dspeeds: null,
  r_lerpmodels: null,

  r_speeds: null,

  r_lightlevel: null,

  vid_fullscreen: null,
  vid_gamma: null,
  vid_scale: null,
  vid_scale_fit: null,
};

export const view_clipplanes: [ClipplaneT, ClipplaneT, ClipplaneT, ClipplaneT] = [
  new ClipplaneT(),
  new ClipplaneT(),
  new ClipplaneT(),
  new ClipplaneT(),
];
export const pfrustum_indexes: [number[], number[], number[], number[]] = [[], [], [], []];

//=============================================================================

export const screenedge: [MplaneT, MplaneT, MplaneT, MplaneT] = [new CplaneT(), new CplaneT(), new CplaneT(), new CplaneT()];

export const r_origin: Vec3 = vec3();

export const r_worldentity: EntityT = new EntityT();
export let currentmodel: ModelT | null = null;
export let currententity: EntityT | null = null;
export const modelorg: Vec3 = vec3();
export const r_entorigin: Vec3 = vec3();

export let verticalFieldOfView = 0;
export let xOrigin = 0;
export let yOrigin = 0;

export let r_visframecount = 0;

export let r_alpha_surfaces: MsurfaceT | null = null;

export function SetCurrentModel(v: ModelT | null): void {
  currentmodel = v;
}

export function SetCurrentEntity(v: EntityT | null): void {
  currententity = v;
}

export function SetVisFrameCount(v: number): void {
  r_visframecount = v;
}

export function SetAlphaSurfaces(v: MsurfaceT | null): void {
  r_alpha_surfaces = v;
}

//=============================================================================

// current entity info
export let insubmodel = false;

export function SetInsubmodel(v: boolean): void {
  insubmodel = v;
}

//=============================================================================

export let r_amodels_drawn = 0;
export let auxedges: EdgeT[] | null = null;
export let r_numallocatededges = 0;
export let r_edges: EdgeT[] | null = null;
export let edge_p = 0;
export let edge_max = 0;

export function SetAmodelsDrawn(v: number): void {
  r_amodels_drawn = v;
}

export function SetAuxEdges(v: EdgeT[] | null): void {
  auxedges = v;
}

export function SetNumAllocatedEdges(v: number): void {
  r_numallocatededges = v;
}

export function SetEdges(v: EdgeT[] | null): void {
  r_edges = v;
}

export function SetEdgeP(v: number): void {
  edge_p = v;
}

export function SetEdgeMax(v: number): void {
  edge_max = v;
}

export const newedges: (EdgeT | null)[] = new Array<EdgeT | null>(MAXHEIGHT).fill(null);
export const removeedges: (EdgeT | null)[] = new Array<EdgeT | null>(MAXHEIGHT).fill(null);

// FIXME: make stack vars when debugging done
export const edge_head: EdgeT = new EdgeT();
export const edge_tail: EdgeT = new EdgeT();
export const edge_aftertail: EdgeT = new EdgeT();

export let r_aliasblendcolor = 0;

export let aliasxscale = 0;
export let aliasyscale = 0;
export let aliasxcenter = 0;
export let aliasycenter = 0;

export let r_outofsurfaces = 0;
export let r_outofedges = 0;

export let r_pcurrentvertbase: MvertexT[] | null = null;
export let r_maxvalidedgeoffset = 0;

export function SetAliasBlendColor(v: number): void {
  r_aliasblendcolor = v;
}

export function SetOutOfSurfaces(v: number): void {
  r_outofsurfaces = v;
}

export function SetOutOfEdges(v: number): void {
  r_outofedges = v;
}

export function SetCurrentVertBase(v: MvertexT[] | null): void {
  r_pcurrentvertbase = v;
}

export class AliastriangleparmsT {
  a: FinalvertT | null = null;
  b: FinalvertT | null = null;
  c: FinalvertT | null = null;
}

export const aliastriangleparms: AliastriangleparmsT = new AliastriangleparmsT();

export let r_time1 = 0;
export let da_time1 = 0;
export let da_time2 = 0;
export let dp_time1 = 0;
export let dp_time2 = 0;
export let db_time1 = 0;
export let db_time2 = 0;
export let rw_time1 = 0;
export let rw_time2 = 0;
export let se_time1 = 0;
export let se_time2 = 0;
export let de_time1 = 0;
export let de_time2 = 0;
export let dv_time1 = 0;
export let dv_time2 = 0;
export const r_frustum_indexes: number[] = new Array<number>(4 * 6).fill(0);
export let r_maxsurfsseen = 0;
export let r_maxedgesseen = 0;
export let r_cnumsurfs = 0;
export let r_surfsonstack = false;

export let r_viewleaf: MleafT | null = null;
export let r_viewcluster = 0;
export let r_oldviewcluster = 0;

export let r_clipflags = 0;
export let r_dlightframecount = 0;
export let r_fov_greater_than_90 = false;

export let r_notexture_mip: ImageT | null = null;
export let r_worldmodel: ModelT | null = null;

export function SetMaxSurfsSeen(v: number): void {
  r_maxsurfsseen = v;
}

export function SetMaxEdgesSeen(v: number): void {
  r_maxedgesseen = v;
}

export function SetCnumSurfs(v: number): void {
  r_cnumsurfs = v;
}

export function SetSurfsOnStack(v: boolean): void {
  r_surfsonstack = v;
}

export function SetViewLeaf(v: MleafT | null): void {
  r_viewleaf = v;
}

export function SetViewCluster(v: number): void {
  r_viewcluster = v;
}

export function SetOldViewCluster(v: number): void {
  r_oldviewcluster = v;
}

export function SetClipflags(v: number): void {
  r_clipflags = v;
}

export function SetDlightFrameCount(v: number): void {
  r_dlightframecount = v;
}

export function SetNotextureMip(v: ImageT | null): void {
  r_notexture_mip = v;
}

export function SetWorldModel(v: ModelT | null): void {
  r_worldmodel = v;
}

export const r_newrefdef: RefdefT = new RefdefT();

export let colormap: unknown = null;

//====================================================================

// `sky_texinfo` (r_local.h) is the same storage as r_rast.c's `r_skytexinfo`,
// which R_InitSkyBox/R_RenderFace draw with; r_rast.ts owns and exports it.

export class SwstateT {
  fullscreen = false;
  prev_mode = 0; // last valid SW mode

  gammatable: Uint8Array = new Uint8Array(256);
  currentpalette: Uint8Array = new Uint8Array(1024);
}

export const sw_state: SwstateT = new SwstateT();

export const d_8to24table: Uint32Array = new Uint32Array(256); // base

/*
====================================================================
  IMPORTED FUNCTIONS
====================================================================

`ri` is the renderer's copy of the engine callback table (`extern
refimport_t ri;`), assigned once by GetRefAPI the same way g_local.ts's
`gi` is assigned by GetGameAPI/InitGame -- bare `export let`, no null
checks, undefined before GetRefAPI runs (matches the C global's lifetime).
*/
export let ri: RefImports;

export function SetRefImports(imp: RefImports): void {
  ri = imp;
}
