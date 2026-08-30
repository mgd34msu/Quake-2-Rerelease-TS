/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_local.h (GNU GPL v2 or later). Pure header module --
there is no gl_local.c -- so this carries the types, constants, cvar holder,
and shared mutable globals every gl_*.ts module reads/writes, mirroring
ref_soft/r_local.ts's role for the software renderer and g_local.ts's role
for the game track.

Unlike r_local.h (whose image_t the ref_soft brief relocated to r_model.ts,
see that file's header comment), gl_local.h declares `image_t` itself,
directly above its `#include "gl_model.h"` -- no placement mismatch to
report here; image_t stays in this file and gl_model.ts imports it, the
same direction r_model.ts's ImageT flows into r_local.ts's MsurfaceT there.

An imported `let` binding is read-only to the importer, so every global here
that a sibling module reassigns has a `Set*` setter next to it (PORTING.md's
"C globals that are reassigned pointers become fields on their owning
singleton", and r_local.ts's identical pattern).
*/

import { type Vec3, vec3 } from "../shared/math";
import { CplaneT, type CvarT } from "../shared/q_shared";
import type { RefImports } from "../client/ref";
import { EntityT, RefdefT } from "../client/ref";
import type { ModelT, MsurfaceT } from "./gl_model";

export const REF_VERSION = "GL 0.01";

// up / down
export const PITCH = 0;
// left / right
export const YAW = 1;
// fall over
export const ROLL = 2;

export class ViddefT {
  width = 0; // coordinates from main game
  height = 0;
}

export const vid: ViddefT = new ViddefT();

/*
  skins will be outline flood filled and mip mapped
  pics and sprites with alpha will be outline flood filled
  pic won't be mip mapped

  model skin
  sprite frame
  wall texture
  pic
*/
export enum ImagetypeT {
  it_skin,
  it_sprite,
  it_wall,
  it_pic,
  it_sky,
}

export class ImageT {
  name = ""; // game path, including extension, MAX_QPATH
  type: ImagetypeT = ImagetypeT.it_skin;
  width = 0;
  height = 0; // source image
  upload_width = 0;
  upload_height = 0; // after power of two and picmip
  registration_sequence = 0; // 0 = free
  texturechain: MsurfaceT | null = null; // for sort-by-texture world drawing
  texnum = 0; // gl texture binding
  sl = 0;
  tl = 0;
  sh = 0;
  th = 0; // 0,0 - 1,1 unless part of the scrap
  scrap = false;
  has_alpha = false;
  paletted = false;
}

export const TEXNUM_LIGHTMAPS = 1024;
export const TEXNUM_SCRAPS = 1152;
export const TEXNUM_IMAGES = 1153;

export const MAX_GLTEXTURES = 1024;

//===================================================================

export enum RserrT {
  rserr_ok,
  rserr_invalid_fullscreen,
  rserr_invalid_mode,
  rserr_unknown,
}

export class GlvertT {
  x = 0;
  y = 0;
  z = 0;
  s = 0;
  t = 0;
  r = 0;
  g = 0;
  b = 0;
}

export const MAX_LBM_HEIGHT = 480;

export const BACKFACE_EPSILON = 0.01;

//====================================================

export const gltextures: ImageT[] = Array.from({ length: MAX_GLTEXTURES }, () => new ImageT());
export let numgltextures = 0;
export function SetNumGltextures(v: number): void {
  numgltextures = v;
}

export let r_notexture: ImageT | null = null;
export let r_particletexture: ImageT | null = null;
export function SetNoTexture(v: ImageT | null): void {
  r_notexture = v;
}
export function SetParticleTexture(v: ImageT | null): void {
  r_particletexture = v;
}

export let currententity: EntityT | null = null;
export let currentmodel: ModelT | null = null;
export function SetCurrentEntity(v: EntityT | null): void {
  currententity = v;
}
export function SetCurrentModel(v: ModelT | null): void {
  currentmodel = v;
}

export let r_visframecount = 0;
export let r_framecount = 0;
export function SetVisFrameCount(v: number): void {
  r_visframecount = v;
}
export function SetFrameCount(v: number): void {
  r_framecount = v;
}

export const frustum: [CplaneT, CplaneT, CplaneT, CplaneT] = [new CplaneT(), new CplaneT(), new CplaneT(), new CplaneT()];

export let c_brush_polys = 0;
export let c_alias_polys = 0;
export function SetBrushPolys(v: number): void {
  c_brush_polys = v;
}
export function SetAliasPolys(v: number): void {
  c_alias_polys = v;
}

export let gl_filter_min = 0;
export let gl_filter_max = 0;
export function SetGlFilterMinMax(min: number, max: number): void {
  gl_filter_min = min;
  gl_filter_max = max;
}

//
// view origin
//
export const vup: Vec3 = vec3();
export const vpn: Vec3 = vec3();
export const vright: Vec3 = vec3();
export const r_origin: Vec3 = vec3();

//
// screen size info
//
export const r_newrefdef: RefdefT = new RefdefT();
export let r_viewcluster = 0;
export let r_viewcluster2 = 0;
export let r_oldviewcluster = 0;
export let r_oldviewcluster2 = 0;
export function SetViewClusters(cluster: number, cluster2: number, oldCluster: number, oldCluster2: number): void {
  r_viewcluster = cluster;
  r_viewcluster2 = cluster2;
  r_oldviewcluster = oldCluster;
  r_oldviewcluster2 = oldCluster2;
}

// cvars -- grouped into one mutable holder (mirrors r_local.ts's rCvars /
// client.ts's clCvars pattern) rather than per-cvar setter functions.
export const glCvars: {
  r_norefresh: CvarT | null;
  r_lefthand: CvarT | null;
  r_drawentities: CvarT | null;
  r_drawworld: CvarT | null;
  r_speeds: CvarT | null;
  r_fullbright: CvarT | null;
  r_novis: CvarT | null;
  r_nocull: CvarT | null;
  r_lerpmodels: CvarT | null;
  r_lightlevel: CvarT | null; // FIXME: This is a HACK to get the client's light level

  gl_vertex_arrays: CvarT | null;

  gl_ext_swapinterval: CvarT | null;
  gl_ext_palettedtexture: CvarT | null;
  gl_ext_multitexture: CvarT | null;
  gl_ext_pointparameters: CvarT | null;
  gl_ext_compiled_vertex_array: CvarT | null;

  gl_particle_min_size: CvarT | null;
  gl_particle_max_size: CvarT | null;
  gl_particle_size: CvarT | null;
  gl_particle_att_a: CvarT | null;
  gl_particle_att_b: CvarT | null;
  gl_particle_att_c: CvarT | null;

  gl_nosubimage: CvarT | null;
  gl_bitdepth: CvarT | null;
  gl_mode: CvarT | null;
  gl_log: CvarT | null;
  gl_lightmap: CvarT | null;
  gl_shadows: CvarT | null;
  gl_dynamic: CvarT | null;
  gl_monolightmap: CvarT | null;
  gl_nobind: CvarT | null;
  gl_round_down: CvarT | null;
  gl_picmip: CvarT | null;
  gl_skymip: CvarT | null;
  gl_showtris: CvarT | null;
  gl_finish: CvarT | null;
  gl_ztrick: CvarT | null;
  gl_clear: CvarT | null;
  gl_cull: CvarT | null;
  gl_poly: CvarT | null;
  gl_texsort: CvarT | null;
  gl_polyblend: CvarT | null;
  gl_flashblend: CvarT | null;
  gl_lightmaptype: CvarT | null;
  gl_modulate: CvarT | null;
  gl_playermip: CvarT | null;
  gl_drawbuffer: CvarT | null;
  gl_3dlabs_broken: CvarT | null;
  gl_driver: CvarT | null;
  gl_swapinterval: CvarT | null;
  gl_texturemode: CvarT | null;
  gl_texturealphamode: CvarT | null;
  gl_texturesolidmode: CvarT | null;
  gl_saturatelighting: CvarT | null;
  gl_lockpvs: CvarT | null;

  vid_fullscreen: CvarT | null;
  vid_gamma: CvarT | null;

  intensity: CvarT | null;
} = {
  r_norefresh: null,
  r_lefthand: null,
  r_drawentities: null,
  r_drawworld: null,
  r_speeds: null,
  r_fullbright: null,
  r_novis: null,
  r_nocull: null,
  r_lerpmodels: null,
  r_lightlevel: null,

  gl_vertex_arrays: null,

  gl_ext_swapinterval: null,
  gl_ext_palettedtexture: null,
  gl_ext_multitexture: null,
  gl_ext_pointparameters: null,
  gl_ext_compiled_vertex_array: null,

  gl_particle_min_size: null,
  gl_particle_max_size: null,
  gl_particle_size: null,
  gl_particle_att_a: null,
  gl_particle_att_b: null,
  gl_particle_att_c: null,

  gl_nosubimage: null,
  gl_bitdepth: null,
  gl_mode: null,
  gl_log: null,
  gl_lightmap: null,
  gl_shadows: null,
  gl_dynamic: null,
  gl_monolightmap: null,
  gl_nobind: null,
  gl_round_down: null,
  gl_picmip: null,
  gl_skymip: null,
  gl_showtris: null,
  gl_finish: null,
  gl_ztrick: null,
  gl_clear: null,
  gl_cull: null,
  gl_poly: null,
  gl_texsort: null,
  gl_polyblend: null,
  gl_flashblend: null,
  gl_lightmaptype: null,
  gl_modulate: null,
  gl_playermip: null,
  gl_drawbuffer: null,
  gl_3dlabs_broken: null,
  gl_driver: null,
  gl_swapinterval: null,
  gl_texturemode: null,
  gl_texturealphamode: null,
  gl_texturesolidmode: null,
  gl_saturatelighting: null,
  gl_lockpvs: null,

  vid_fullscreen: null,
  vid_gamma: null,

  intensity: null,
};

export let gl_lightmap_format = 0;
export let gl_solid_format = 0;
export let gl_alpha_format = 0;
export let gl_tex_solid_format = 0;
export let gl_tex_alpha_format = 0;
export function SetTextureFormats(lightmap: number, solid: number, alpha: number, texSolid: number, texAlpha: number): void {
  gl_lightmap_format = lightmap;
  gl_solid_format = solid;
  gl_alpha_format = alpha;
  gl_tex_solid_format = texSolid;
  gl_tex_alpha_format = texAlpha;
}

export let c_visible_lightmaps = 0;
export let c_visible_textures = 0;
export function SetVisibleCounts(lightmaps: number, textures: number): void {
  c_visible_lightmaps = lightmaps;
  c_visible_textures = textures;
}

export const r_world_matrix: Float32Array = new Float32Array(16);

export let gldepthmin = 0;
export let gldepthmax = 0;
export function SetGlDepthRange(min: number, max: number): void {
  gldepthmin = min;
  gldepthmax = max;
}

//====================================================================

export let r_worldmodel: ModelT | null = null;
export function SetWorldModel(v: ModelT | null): void {
  r_worldmodel = v;
}

export const d_8to24table: Uint32Array = new Uint32Array(256);

export let registration_sequence = 0;
export function SetRegistrationSequence(v: number): void {
  registration_sequence = v;
}

/*
** GL config stuff
*/
export const GL_RENDERER_VOODOO = 0x00000001;
export const GL_RENDERER_VOODOO2 = 0x00000002;
export const GL_RENDERER_VOODOO_RUSH = 0x00000004;
export const GL_RENDERER_BANSHEE = 0x00000008;
export const GL_RENDERER_3DFX = 0x0000000f;

export const GL_RENDERER_PCX1 = 0x00000010;
export const GL_RENDERER_PCX2 = 0x00000020;
export const GL_RENDERER_PMX = 0x00000040;
export const GL_RENDERER_POWERVR = 0x00000070;

export const GL_RENDERER_PERMEDIA2 = 0x00000100;
export const GL_RENDERER_GLINT_MX = 0x00000200;
export const GL_RENDERER_GLINT_TX = 0x00000400;
export const GL_RENDERER_3DLABS_MISC = 0x00000800;
export const GL_RENDERER_3DLABS = 0x00000f00;

export const GL_RENDERER_REALIZM = 0x00001000;
export const GL_RENDERER_REALIZM2 = 0x00002000;
export const GL_RENDERER_INTERGRAPH = 0x00003000;

export const GL_RENDERER_3DPRO = 0x00004000;
export const GL_RENDERER_REAL3D = 0x00008000;
export const GL_RENDERER_RIVA128 = 0x00010000;
export const GL_RENDERER_DYPIC = 0x00020000;

export const GL_RENDERER_V1000 = 0x00040000;
export const GL_RENDERER_V2100 = 0x00080000;
export const GL_RENDERER_V2200 = 0x00100000;
export const GL_RENDERER_RENDITION = 0x001c0000;

export const GL_RENDERER_O2 = 0x00100000;
export const GL_RENDERER_IMPACT = 0x00200000;
export const GL_RENDERER_RE = 0x00400000;
export const GL_RENDERER_IR = 0x00800000;
export const GL_RENDERER_SGI = 0x00f00000;

export const GL_RENDERER_MCD = 0x01000000;
export const GL_RENDERER_OTHER = 0x80000000;

export class GlconfigT {
  renderer = 0;
  renderer_string = "";
  vendor_string = "";
  version_string = "";
  extensions_string = "";

  allow_cds = false;
}

export class GlstateT {
  inverse_intensity = 0;
  fullscreen = false;

  prev_mode = 0;

  d_16to8table: Uint8Array | null = null;

  lightmap_textures = 0;

  currenttextures: [number, number] = [0, 0];
  currenttmu = 0;

  camera_separation = 0;
  stereo_enabled = false;

  originalRedGammaTable: Uint8Array = new Uint8Array(256);
  originalGreenGammaTable: Uint8Array = new Uint8Array(256);
  originalBlueGammaTable: Uint8Array = new Uint8Array(256);
}

export const gl_config: GlconfigT = new GlconfigT();
export const gl_state: GlstateT = new GlstateT();

/*
====================================================================
IMPORTED FUNCTIONS
====================================================================
*/

// An imported `let` binding is read-only to the importer -- see r_local.ts's
// identical `ri`/SetRefImports pair (and g_local.ts's SetGameImports) for
// the general pattern this follows.
export let ri: RefImports;

export function SetRefImports(imp: RefImports): void {
  ri = imp;
}

/*
====================================================================
IMPLEMENTATION SPECIFIC FUNCTIONS
====================================================================

GLimp_BeginFrame/GLimp_EndFrame/GLimp_Init/GLimp_Shutdown/GLimp_SetMode/
GLimp_AppActivate/GLimp_EnableLogging/GLimp_LogNewFrame are implemented in
linux/gl_glx.c / win32/gl_win.c, not in any ref_gl/gl_*.c file -- per
PORTING.md's platform mapping those become one src/platform/ implementation
(the GL windowing/context half of the same job src/platform/sdl.ts is doing
for the client), not a ref_gl/*.ts stub. Out of this unit's SCOPE (a live
sibling owns src/platform/**); not stubbed here, reported as a follow-up.
GL_BeginRendering/GL_EndRendering (declared in gl_local.h) are likewise
defined only in that platform-specific file, not in any gl_*.c -- same gap,
same follow-up.
*/
