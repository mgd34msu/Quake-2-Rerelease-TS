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
  // Head of this texture's glow-pass surface chain for the current frame,
  // linked through MsurfaceT.glowchain. Drained (and reset to null) by
  // gl_rsurf.ts's R_DrawGlowmaps; see MsurfaceT.glowchain's comment.
  glowchain: MsurfaceT | null = null;
  texnum = 0; // gl texture binding
  sl = 0;
  tl = 0;
  sh = 0;
  th = 0; // 0,0 - 1,1 unless part of the scrap
  scrap = false;
  has_alpha = false;
  paletted = false;

  // image_t.texnum2 in the reference (q2repro src/refresh/images.c:1908,
  // check_for_glow_map) -- the emissive glow map that ships next to a skin
  // or wall texture as "<name>_glow.<ext>", or null (the common case) when
  // no such file exists. Held as a whole ImageT rather than a bare texture
  // number because this port's images are objects and the glow needs its
  // own upload_width/height and registration_sequence like any other.
  //
  // q2repro overloads one texnum2 field for both glow maps and the classic
  // two-layer sky; this renderer's sky path (gl_warp.ts) keeps its own
  // separate images, so there is no such overload here and the field means
  // exactly one thing.
  glow: ImageT | null = null;

  // Animated-GIF support (no classic-engine precedent -- see qcommon/
  // gif.ts's own header comment for the design). Null for every ordinary
  // image and for a GIF with only one frame. When non-null, this IS the
  // frame-0 ImageT (gifFrames[0] === this object) and gifFrames[1..] are
  // additional ImageT records for the rest of the composited frames, each
  // separately registered/uploaded as its own GL texture under a derived
  // name (see gl_image.ts's GL_LoadByExt "gif" case). Only ever populated
  // for `ImagetypeT.it_pic` loads -- 3D uses (skins/walls) stay first-
  // frame-only by ruling, so this field is simply never set for them.
  gifFrames: ImageT[] | null = null;
}

export const TEXNUM_LIGHTMAPS = 1024;
export const TEXNUM_SCRAPS = 1152;
export const TEXNUM_IMAGES = 1153;

// Vanilla's 1024 was sized for 1997 maps. A re-release map registers its
// walls AND their glow maps, MD5 skins per model, and the previous map's
// images stay registered until R_EndRegistration frees them -- so a level
// change between two large re-release maps (Strogg Gateway -> Uplink Tower,
// Mike's 2026-09-02 play-test) overran 1024 mid-load: "ERROR: MAX_GLTEXTURES",
// game dropped to the console. q2repro sizes MAX_RIMAGES at 2048; 4096
// covers the re-release's largest pairs with room. Texture names stay
// TEXNUM_IMAGES + slot; nothing else claims fixed names above them.
export const MAX_GLTEXTURES = 4096;

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
  gl_fog: CvarT | null;
  gl_debug_distfrac: CvarT | null;
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

  // q2repro src/refresh/main.c: `gl_lightgrid = Cvar_Get("gl_lightgrid", "1", 0);`
  // -- not a vanilla cvar (vanilla gl_light.c has no LIGHTGRID_OCTREE
  // consumption at all); added here solely to gate world.c's
  // GL_LightGridPoint port in gl_light.ts's R_LightPoint.
  gl_lightgrid: CvarT | null;

  // q2repro src/refresh/shader.c / main.c: `gl_shaders = Cvar_Get("gl_shaders",
  // "1", CVAR_FILES);` / `gl_per_pixel_lighting = Cvar_Get("gl_per_pixel_lighting",
  // "1", 0);` -- task #25's shader path (gl_shader.ts), same default as
  // q2repro's own GLSL backend: on by default, graceful fallback to the
  // fixed-function path if program compilation/linking fails on this
  // context (see GL_InitShaderPath's header comment).
  gl_shaders: CvarT | null;
  gl_per_pixel_lighting: CvarT | null;

  // v1.1.0 shadow maps (gl_shadowmap.ts). No q2repro counterpart to name it
  // after -- q2repro has no shadow mapping at all (see that file's reference
  // ruling), so this is a new toggle, defaulted on and subordinate to
  // gl_shaders: at gl_shaders 0 there is no lighting shader to sample a
  // depth map from, so the whole pass is skipped regardless of this value.
  gl_shadowmaps: CvarT | null;
  // Per-light shadow-map resolution CAP, in texels (256/512/1024 -- the
  // video menu's low/medium/high). A light's own shadowlightresolution is
  // still honoured; this only clamps how high it may go, so a player on
  // weak hardware can turn every map down without editing entities.
  gl_shadowmap_res: CvarT | null;

  vid_fullscreen: CvarT | null;
  vid_gamma: CvarT | null;
  // v1.0.0 RC resolution scaling (src/platform/vid_scale.ts/glimp.ts): no
  // C-original or q2repro field to mirror -- see vid.ts's VID_GetScale
  // header comment. Tracked here only so R_BeginFrame/R_SetMode can detect
  // "modified" and force the same mode-restart path gl_mode/vid_fullscreen
  // already use; glimp.ts reads the cvar's live value directly, not through
  // this struct.
  vid_scale: CvarT | null;
  // Bug fix (Mike, 2026-09-02): same reason as vid_scale immediately above
  // -- tracked here so R_BeginFrame can detect "modified" and force a mode
  // restart when only "scale to fullscreen" changes (previously missing
  // entirely, so that toggle alone never took effect until some other
  // video-menu change also forced a restart). glimp.ts still reads the
  // cvar's live value directly, not through this struct.
  vid_scale_fit: CvarT | null;

  intensity: CvarT | null;

  // q2repro src/refresh/main.c's GL_Register(): these are q2repro's
  // replacement names for several vanilla cvars this port already carries
  // above (r_drawworld/r_drawentities/r_novis) plus one genuinely new
  // near-clip-plane cvar (gl_znear) and two toggles gating real, existing
  // culling logic (gl_cull_nodes/gl_cull_models). Where a vanilla cvar of
  // the same meaning already has a live consumer, R_Register wires both in
  // as an additional AND/OR gate rather than replacing the vanilla one --
  // see the call sites cited next to each field below.
  gl_znear: CvarT | null;
  gl_drawworld: CvarT | null;
  gl_drawentities: CvarT | null;
  gl_drawsky: CvarT | null;
  gl_cull_nodes: CvarT | null;
  gl_cull_models: CvarT | null;
  gl_novis: CvarT | null;

  // q2repro src/refresh/main.c:1121-1123 (`#if USE_MD5`): MD5 skeletal-model
  // loading/use/LOD-distance cvars -- now real consumers, see gl_model.ts's
  // Mod_LoadMD5 (gl_md5_load) and gl_mesh.ts's R_DrawAliasModel
  // (gl_md5_use/gl_md5_distance).
  gl_md5_load: CvarT | null;
  gl_md5_use: CvarT | null;
  gl_md5_distance: CvarT | null;

  // Emissive glow maps. r_glowmaps (q2repro src/refresh/images.c:2280)
  // gates loading a "<skin>_glow.<ext>" next to a skin/wall texture;
  // gl_glowmap_intensity (main.c:1116) scales how strongly the glow is
  // added at draw time. Both were registered-only until this unit gave
  // them real consumers -- gl_image.ts's GL_CheckForGlowMap and the
  // additive passes in gl_mesh.ts/gl_rsurf.ts.
  r_glowmaps: CvarT | null;
  gl_glowmap_intensity: CvarT | null;
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
  gl_fog: null,
  gl_debug_distfrac: null,
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

  gl_lightgrid: null,

  gl_shaders: null,
  gl_shadowmaps: null,
  gl_shadowmap_res: null,
  gl_per_pixel_lighting: null,

  vid_fullscreen: null,
  vid_gamma: null,
  vid_scale: null,
  vid_scale_fit: null,

  intensity: null,

  gl_znear: null,
  gl_drawworld: null,
  gl_drawentities: null,
  gl_drawsky: null,
  gl_cull_nodes: null,
  gl_cull_models: null,
  gl_novis: null,

  gl_md5_load: null,
  gl_md5_use: null,
  gl_md5_distance: null,

  r_glowmaps: null,
  gl_glowmap_intensity: null,
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

  // Bug fix (Mike, 2026-09-02, owner's play-test report: fullscreen simply
  // never engaged -- "fit screen ... was not applied at all"). Root cause
  // #3 (see src/platform/sdl.ts's desktopDisplaySize for #1 and
  // gl_rmain.ts's R_BeginFrame OR-condition for #2), and the decisive one:
  // gl_rmain.ts's R_SetMode gates vid_fullscreen on `gl_config.allow_cds`,
  // but R_Init calls R_SetMode BEFORE it can determine allow_cds at all --
  // that requires GL_VENDOR/GL_RENDERER strings, which requires the live
  // context R_SetMode itself is what creates. This field used to default
  // false, so on the very first R_SetMode of a process (this module-level
  // gl_config is a true singleton -- constructed once, same "static
  // persists across re-init" semantics the real allow_cds detection below
  // relies on -- so this default is read exactly once per process, ever)
  // vid_fullscreen.modified is unconditionally true (Cvar_Get sets it on
  // every cvar's first-ever registration, and R_Register -- called from
  // inside this same R_Init, right before R_SetMode -- is that first
  // registration for a session that boots straight into `vid_ref gl`),
  // and the CDS gate fired unconditionally, force-flipping vid_fullscreen
  // to 0 regardless of what was actually requested (`vid_fullscreen 1` in
  // config.cfg, `+set vid_fullscreen 1`, or the video menu) -- confirmed
  // empirically: every headless verification run for this fix printed
  // "R_SetMode() - CDS not allowed with this driver" and booted windowed
  // even with `+set vid_fullscreen 1 +set vid_ref gl` on the command line.
  // Once R_Init completes one time, this field is set for real (line
  // ~1690 below: true for every renderer except a 3dlabs card with
  // gl_3dlabs_broken on) and STAYS set for the rest of the process, so
  // this default is only ever actually consulted on that first call --
  // defaulting it to true (the same value the real detection lands on for
  // every non-3dlabs-broken card, i.e. essentially all hardware in 2026)
  // means the gate no longer misfires on a fresh boot for the overwhelming
  // majority of players, at the cost of a 3dlabs-broken card's first-ever
  // boot behaving the same permissive way every OTHER card's first boot
  // already did under the old default -- no worse than before for that
  // vanishingly rare case, since the vendor genuinely cannot be known
  // before this first call either way.
  allow_cds = true;

  /*
  Non-power-of-two texture support (q2repro's QGL_CAP_TEXTURE_NON_POWER_OF_TWO,
  src/refresh/gl.h:176, consumed by its GL_MakePowerOfTwo in
  src/refresh/texture.c:432-442).

  Vanilla always rounds a texture up to the next power of two on each axis and
  RESAMPLES it into that size (GL_ResampleTexture) -- every GL 1.1 driver
  required POT dimensions. That resample is a non-integer-step 2x2 box filter,
  so it does not just enlarge an image, it smears it: a 195x252 font atlas
  becomes 256x256 with every glyph cell straddling texel boundaries, a 30x30
  HUD icon becomes 32x32 with soft, shifted edges, a 22x29 menu cursor becomes
  32x32. 156 of the 179 PNGs under pics/ and fonts/ in the re-release paks are
  non-power-of-two, and 116 of the 125 pics in the 1997 baseq2 pak0 are too, so
  in practice almost every 2D image in the game was being resampled.

  Set once in R_Init (gl_rmain.ts), from the live context's GL_VERSION /
  GL_EXTENSIONS -- see the assignment there for the exact rule and why it is
  slightly more permissive than q2repro's. Defaults false so that anything
  reading it before a context exists (and every test that does not install one)
  gets vanilla's POT behavior.
  */
  npot = false;
  /*
  Non-power-of-two support for MIPMAPPED textures (skins and world textures)
  specifically -- the stricter half of `npot` above.

  q2repro grants QGL_CAP_TEXTURE_NON_POWER_OF_TWO only in its GL 3.0 / GLES
  3.0 tier (src/refresh/qgl.c:287-293) with the comment "NPOT textures are
  technically GL 2.0, but only enable them on 3.0 to ensure full hardware
  support, INCLUDING MIPMAPS". `npot` above is deliberately more permissive
  than that -- it also accepts a pre-3.0 context that advertises
  GL_ARB_texture_non_power_of_two / GL_OES_texture_npot -- which is safe for
  the non-mipmapped 2D pics but is exactly the case the reference's comment
  warns about once a mip chain is involved. This field is the reference's own
  unrelaxed rule, version tier only, and GL_Upload32 requires it (plus a
  resolved qglGenerateMipmap) before it will hand a skin or a wall to the
  driver at a non-power-of-two size.

  Set in R_Init next to `npot`; defaults false, so anything running without a
  live context keeps vanilla's POT-and-resample path for mipmapped images.
  */
  npot_mipmap = false;
  /**
   * GL_MAX_TEXTURE_SIZE, queried in R_Init. Vanilla hardcoded a 256 cap in
   * GL_Upload32 ("don't ever bother with >256 textures"); the reference
   * clamps to the driver's limit instead. 256 until queried, so a context
   * that never reports stays on vanilla's cap.
   */
  max_texture_size = 256;
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
