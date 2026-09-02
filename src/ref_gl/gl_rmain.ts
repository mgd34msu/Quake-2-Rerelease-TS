/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_rmain.c (GNU GPL v2 or later).

Internal helpers not declared in gl_local.h (R_Clear, R_SetFrustum,
R_SetupFrame, MYgluPerspective, R_SetupGL, R_Flash, R_SetGL2D,
R_SetLightLevel, R_Register, R_SetMode, SignbitsForPlane, R_DrawNullModel,
R_DrawEntitiesOnList, R_DrawParticles, R_PolyBlend, v_blend) stay
module-private, except `MYgluPerspective`: gl_mesh.c's R_DrawAliasModel
calls it too (via a local `extern` inside that function body, not a
gl_local.h declaration), so it is exported here for that sibling to import.

GLimp_* / GL_BeginRendering / GL_EndRendering (GLimp_Init/SetMode/BeginFrame/
EndFrame/Shutdown/AppActivate/EnableLogging/LogNewFrame) are implemented
per-platform (linux/gl_glx.c et al), never in any gl_*.c file -- out of this
unit's SCOPE (a future src/platform/** unit owns them). No such module exists
under src/platform/ yet, so this file declares the small local `GLimp`
interface + `glimp` holder + `SetGLimp()` setter the brief asks for; every
member throws `GLimpNotWired` (a plain local error, deliberately distinct
from a pending stub -- this holder is a genuine forward integration seam for
a different, not-yet-started unit, not a stand-in for something this unit
should have ported itself) until a future platform unit calls `SetGLimp`.
`R_SwapBuffers` (declared in gl_local.h, never defined in any gl_*.c file --
confirmed by grepping the tree) has the same gap and is not stubbed, per
PORTING.md's "a function you cannot port faithfully is a reported deviation"
rule applied to a dead declaration.

QGL lifecycle: `QGL_Init(gl_driver->string)` -> `SetQGL(loadQGLFromSystem())`
(qgl.ts, already landed); a thrown error from that loader is this port's
equivalent of `QGL_Init` returning false. There is no `QGL_Shutdown`
counterpart in qgl.ts (that file's own header comment flags this and defers
adding one until "gl_rmain.ts's real R_Shutdown lands" -- this unit is that
R_Shutdown, but qgl.ts itself is out of this unit's SCOPE beyond the narrow
"QGL interface members" exception, which does not cover adding a new
top-level lifecycle export) -- R_Shutdown does not call anything for this;
reported gap/follow-up.

`r_turbsin` scaling: R_Init calls gl_warp.ts's R_ScaleTurbsinForRInit(),
which reproduces C's one-halving-per-DLL-load semantics idempotently.
setter there or applies the `*0.5` itself.

`#ifdef WIN32` extension-pointer probing in R_Init (GL_EXT_compiled_vertex_array/
WGL_EXT_swap_control/GL_EXT_point_parameters/GL_EXT_shared_texture_palette/
GL_SGIS_multitexture) is dropped per PORTING.md's portable-path rule -- QGL's
interface (qgl.ts) already declares every member unconditionally present, so
there is nothing left for these probes to conditionally assign in this port.
`#if 0 GL_DrawStereoPattern()` (commented out in the original pending an H3D
licensing dispute) is dropped per PORTING.md's "#if 0 blocks are dropped
silently" rule; `GL_DrawStereoPattern`/`GL_DrawColoredStereoLinePair` (its
only two callers/helpers, both `static`) are dead code with that call site
gone and are not ported either. The `#ifndef REF_HARD_LINKED` fallback
Sys_Error/Com_Printf pair at the bottom of the file is dropped for the same
reason ref_soft/r_main.ts's identical header comment gives: this port is
always hard-linked into one process, and src/shared/q_shared.ts /
src/platform/sys.ts already own those symbols for real.

No literal `#ifdef __linux__` vertex-array block exists anywhere in
gl_rmain.c/gl_rmisc.c/gl_mesh.c (confirmed by grepping all three) -- the
`gl_vertex_arrays->value` branch in gl_mesh.c's GL_DrawAliasFrameLerp is a
plain runtime cvar check, not a preprocessor conditional, so both of its
branches are ported in full there (see gl_mesh.ts), not dropped.

R_Init's final fall-off-the-end (the original `int` function has no
`return` statement after its last `if`, real undefined behavior in the C
source) is ported as `return true` (every earlier failure path already
returns `false` explicitly) -- reported deviation since a literal
"undefined value" isn't expressible under TS's strict typing, matching
gl_image.ts's identical `GL_Upload8` precedent for the same kind of gap.
*/

import { CString } from "bun:ffi";
import type { RefExports, RefImports, EntityT, RefdefT, ParticleT, DrawColorT } from "../client/ref";
import { API_VERSION } from "../client/ref";
import { type Vec3, vec3, DotProduct, VectorCopy, VectorScale, VectorMA, VectorNormalize, AngleVectors, RotatePointAroundVector, PerpendicularVector, BOX_ON_PLANE_SIDE } from "../shared/math";
import { CplaneT, CONTENTS_SOLID, RDF_NOWORLDMODEL, RF_BEAM, RF_FLARE, RF_FLARE_LOCK_ANGLE, RF_SHELL_RED, RF_SHELL_GREEN, RF_SHELL_BLUE, RF_FULLBRIGHT, RF_TRANSLUCENT, ERR_DROP, PRINT_ALL, PRINT_DEVELOPER, CVAR_ARCHIVE, CVAR_USERINFO, CVAR_CHEAT, CVAR_FILES, Q_stricmp, Q_ftol } from "../shared/q_shared";
import { PLANE_ANYZ } from "../qcommon/qfiles";
import {
  ri,
  SetRefImports,
  vid,
  glCvars,
  frustum,
  vup,
  vpn,
  vright,
  r_origin,
  r_newrefdef,
  r_world_matrix,
  gl_config,
  gl_state,
  gldepthmin,
  gldepthmax,
  SetGlDepthRange,
  d_8to24table,
  currententity,
  currentmodel,
  SetCurrentEntity,
  SetCurrentModel,
  SetFrameCount,
  r_framecount,
  r_viewcluster,
  r_viewcluster2,
  SetViewClusters,
  c_brush_polys,
  c_alias_polys,
  SetBrushPolys,
  SetAliasPolys,
  c_visible_lightmaps,
  c_visible_textures,
  r_worldmodel,
  RserrT,
  GL_RENDERER_VOODOO,
  GL_RENDERER_VOODOO_RUSH,
  GL_RENDERER_SGI,
  GL_RENDERER_PERMEDIA2,
  GL_RENDERER_GLINT_MX,
  GL_RENDERER_REALIZM,
  GL_RENDERER_MCD,
  GL_RENDERER_PCX2,
  GL_RENDERER_RENDITION,
  GL_RENDERER_OTHER,
  GL_RENDERER_POWERVR,
  GL_RENDERER_3DLABS,
  REF_VERSION,
  r_particletexture,
  ImagetypeT,
  ImageT,
} from "./gl_local";
import { R_BeginRegistration, R_EndRegistration, R_RegisterModel, Mod_PointInLeaf, Mod_Init, Mod_FreeAll, Mod_Modellist_f, ModtypeT, ModelT, ParsedSp2T } from "./gl_model";
import { GL_InitShaderPath, GL_ShutdownShaderPath, GL_UsingShaderPath } from "./gl_shader";
import { GL_InitShadowMaps, GL_ShutdownShadowMaps, GL_ShadowMapsNewMap, GL_ShadowMapStats, R_RenderShadowMaps } from "./gl_shadowmap";
import {
  R_RegisterSkin,
  GL_InitImages,
  GL_ShutdownImages,
  GL_ImageList_f,
  Draw_GetPalette,
  GL_Bind,
  GL_TexEnv,
  qgl,
  SetQGL,
  GL_TEXTURE_2D,
  GL_BLEND,
  GL_ALPHA_TEST,
  GL_REPLACE,
  GL_QUADS,
  GL_TextureMode,
  GL_TextureAlphaMode,
  GL_TextureSolidMode,
  GL_SetTexturePalette,
  GL_LoadPic,
} from "./gl_image";
import { loadQGLFromSystem, QGL_Shutdown, type GLGetProcAddressFn } from "./qgl";
import { Draw_Char, Draw_ColorPic, Draw_Fill, Draw_FadeScreen, Draw_FindPic, Draw_GetPicSize, Draw_InitLocal, Draw_Pic, Draw_StretchPic, Draw_StretchPicRegion, Draw_StretchRaw, Draw_TileClear, SetGifBeatSeconds, SetRawPalette } from "./gl_draw";
import { R_ScaleTurbsinForRInit, R_SetSky } from "./gl_warp";
import { R_DrawWorld, R_DrawAlphaSurfaces, R_MarkLeaves, R_DrawBrushModel } from "./gl_rsurf";
import { R_LightPoint, R_PushDlights, R_RenderDlights } from "./gl_light";
import { R_DrawAliasModel } from "./gl_mesh";
import { GL_ScreenShot_f, GL_SetDefaultState, GL_UpdateSwapInterval, GL_Strings_f, R_InitParticleTexture } from "./gl_rmisc";

// standard OpenGL 1.1 enum values (`<GL/gl.h>`) this file calls qgl* with
// directly; no shared GL-enum module exists yet across gl_*.ts, see
// gl_light.ts/gl_rsurf.ts/gl_warp.ts's identical note.
const GL_DEPTH_BUFFER_BIT = 0x0100;
const GL_COLOR_BUFFER_BIT = 0x4000;
const GL_DEPTH_TEST = 0x0b71;
const GL_CULL_FACE = 0x0b44;
const GL_SCISSOR_TEST = 0x0c11;
const GL_LEQUAL = 0x0203;
const GL_GEQUAL = 0x0206;
const GL_FRONT = 0x0404;
const GL_BACK = 0x0405;
const GL_PROJECTION = 0x1701;
const GL_MODELVIEW = 0x1700;
const GL_MODELVIEW_MATRIX = 0x0ba6;
const GL_VENDOR = 0x1f00;
const GL_RENDERER = 0x1f01;
const GL_VERSION = 0x1f02;
const GL_EXTENSIONS = 0x1f03;
const GL_NO_ERROR = 0;
const GL_TRIANGLE_FAN = 0x0006;
const GL_TRIANGLE_STRIP = 0x0005;
const GL_TRIANGLES = 0x0004;
const GL_POINTS = 0x0000;
const GL_MODULATE = 0x2100;
const GL_ONE = 1;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_SMOOTH = 0x1d01;
const GL_FLAT = 0x1d00;

// float v_blend[4] -- final blending color; file-scope global read/written
// only within this file (R_SetupFrame writes it, R_PolyBlend reads it).
const v_blend = new Float32Array(4);

/*
====================================================================
IMPLEMENTATION SPECIFIC FUNCTIONS -- see file header comment
====================================================================
*/
class GLimpNotWired extends Error {
  constructor(name: string) {
    super(`GLimp.${name}: no platform glimp implementation has been wired via SetGLimp() -- see gl_rmain.ts's header comment`);
  }
}

export interface GLimp {
  Init(hinstance: unknown, hWnd: unknown): boolean;
  SetMode(width: number, height: number, mode: number, fullscreen: boolean): { rserr: RserrT; width: number; height: number };
  Shutdown(): void;
  BeginFrame(camera_separation: number): void;
  EndFrame(): void;
  AppActivate(activate: boolean): void;
  EnableLogging(enable: boolean): void;
  LogNewFrame(): void;
  // qgl.h resolves extensions via wglGetProcAddress/glXGetProcAddress;
  // undefined = no live context source (tests, headless), dlsym fallback.
  GetProcAddress?: GLGetProcAddressFn;
}

function defaultGLimp(): GLimp {
  return {
    Init(): boolean {
      throw new GLimpNotWired("Init");
    },
    SetMode(): { rserr: RserrT; width: number; height: number } {
      throw new GLimpNotWired("SetMode");
    },
    Shutdown(): void {
      throw new GLimpNotWired("Shutdown");
    },
    BeginFrame(): void {
      throw new GLimpNotWired("BeginFrame");
    },
    EndFrame(): void {
      throw new GLimpNotWired("EndFrame");
    },
    AppActivate(): void {
      throw new GLimpNotWired("AppActivate");
    },
    EnableLogging(): void {
      throw new GLimpNotWired("EnableLogging");
    },
    LogNewFrame(): void {
      throw new GLimpNotWired("LogNewFrame");
    },
  };
}

export let glimp: GLimp = defaultGLimp();
export function SetGLimp(g: GLimp): void {
  glimp = g;
}

/*
=================
R_CullBox

Returns true if the box is completely outside the frustom
=================
*/
export function R_CullBox(mins: Vec3, maxs: Vec3): boolean {
  if (glCvars.r_nocull && glCvars.r_nocull.value) return false;

  for (let i = 0; i < 4; i++) {
    if (BOX_ON_PLANE_SIDE(mins, maxs, frustum[i]) === 2) return true;
  }
  return false;
}

export function R_RotateForEntity(e: EntityT): void {
  qgl.qglTranslatef(e.origin[0], e.origin[1], e.origin[2]);

  qgl.qglRotatef(e.angles[1], 0, 0, 1);
  qgl.qglRotatef(-e.angles[0], 0, 1, 0);
  qgl.qglRotatef(-e.angles[2], 1, 0, 0);
}

/*
=============================================================

  SPRITE MODELS

=============================================================
*/

/*
=================
R_DrawSpriteModel

=================
*/
export function R_DrawSpriteModel(e: EntityT): void {
  let alpha = 1.0;

  // don't even bother culling, because it's just a single
  // polygon without a surface cache
  if (!currentmodel) return;
  const psprite = currentmodel.extradata;
  if (!(psprite instanceof ParsedSp2T)) return;

  e.frame = psprite.numframes > 0 ? e.frame % psprite.numframes : 0;

  const frame = psprite.frames[e.frame];

  // #if 0 SPR_ORIENTED "bullet marks on walls" branch dropped (dead code in
  // the original -- see file header comment); normal sprite path is the
  // only one ever compiled.
  const up = vup;
  const right = vright;

  if (e.flags & RF_TRANSLUCENT) alpha = e.alpha;

  if (alpha !== 1.0) qgl.qglEnable(GL_BLEND);

  qgl.qglColor4f(1, 1, 1, alpha);

  const skin = currentmodel.skins[e.frame];
  GL_Bind(skin ? skin.texnum : 0);

  GL_TexEnv(GL_MODULATE);

  if (alpha === 1.0) qgl.qglEnable(GL_ALPHA_TEST);
  else qgl.qglDisable(GL_ALPHA_TEST);

  qgl.qglBegin(GL_QUADS);

  const point = vec3();

  qgl.qglTexCoord2f(0, 1);
  VectorMA(e.origin, -frame.origin_y, up, point);
  VectorMA(point, -frame.origin_x, right, point);
  qgl.qglVertex3fv(point);

  qgl.qglTexCoord2f(0, 0);
  VectorMA(e.origin, frame.height - frame.origin_y, up, point);
  VectorMA(point, -frame.origin_x, right, point);
  qgl.qglVertex3fv(point);

  qgl.qglTexCoord2f(1, 0);
  VectorMA(e.origin, frame.height - frame.origin_y, up, point);
  VectorMA(point, frame.width - frame.origin_x, right, point);
  qgl.qglVertex3fv(point);

  qgl.qglTexCoord2f(1, 1);
  VectorMA(e.origin, -frame.origin_y, up, point);
  VectorMA(point, frame.width - frame.origin_x, right, point);
  qgl.qglVertex3fv(point);

  qgl.qglEnd();

  qgl.qglDisable(GL_ALPHA_TEST);
  GL_TexEnv(GL_REPLACE);

  if (alpha !== 1.0) qgl.qglDisable(GL_BLEND);

  qgl.qglColor4f(1, 1, 1, 1);
}

/*
=============================================================

  FLARES (misc_flare, RF_FLARE)

=============================================================
*/

/*
=================
GL_MakeNormalVectors

q2repro src/common/math.c's MakeNormalVectors (vanilla q_shared.c has the
same function; this port's shared/math.ts never needed it, so it lives here
next to its one caller). Builds an arbitrary orthonormal pair around
`forward` -- the flare's non-LOCK_ANGLE billboard basis.
=================
*/
function GL_MakeNormalVectors(forward: Vec3, right: Vec3, up: Vec3): void {
  // this rotate and negate guarantees a vector not colinear with the original
  right[1] = -forward[0];
  right[2] = forward[1];
  right[0] = forward[2];

  const d = DotProduct(right, forward);
  VectorMA(right, -d, forward, right);
  VectorNormalize(right);

  // CrossProduct(right, forward, up)
  up[0] = right[1] * forward[2] - right[2] * forward[1];
  up[1] = right[2] * forward[0] - right[0] * forward[2];
  up[2] = right[0] * forward[1] - right[1] * forward[0];
}

/*
=================
GL_IsDefaultFlareImage

q2repro tags two image names with IF_DEFAULT_FLARE at registration time --
"misc/flare.tga" (src/client/tent.c:322, the built-in flare) and any
"sprites/psx_flare*" (src/client/precache.c:406) -- and its flare draw reads
that flag back for two things: a doubled quad size (`25 << def`) and a
brighter alpha (`128 + def * 32`). This port's RefExports has no
image-type/flags argument to carry the tag through registration (see
cl_tent.ts's cl_img_flare comment), so the same two names are recognized
here, at the one place the flag is ever read. Same inputs, same answer.
=================
*/
function GL_IsDefaultFlareImage(name: string): boolean {
  const n = name.toLowerCase();
  return n === "misc/flare.tga" || n.startsWith("sprites/psx_flare");
}

/*
=================
R_DrawFlare

q2repro src/refresh/tess.c:366-489 (GL_DrawFlares), one entity at a time.

Two deviations, both forced by what this renderer is:

 1. No occlusion queries. q2repro draws each flare's bounding quad into an
    occlusion query with color writes off (src/refresh/main.c:441-518
    GL_OccludeFlares), then ramps a per-flare visibility fraction `q->frac`
    toward the query result at gl_flarespeed and multiplies both the quad
    size and the alpha by it -- which is also why its draw pass runs with
    GLS_DEPTHTEST_DISABLE (the query, not the depth buffer, decides whether
    a flare behind a wall is visible). qgl.ts binds no query entry points,
    so this port draws with the depth test LEFT ON: geometry in front of the
    flare occludes it directly, and `frac` is a constant 1 (a flare that is
    visible at all is drawn at full size, with no fade-in ramp).
 2. No fragment shader. q2repro's IF_DEFAULT_FLARE path adds
    `diffuse.rgb *= luminance(diffuse.rgb); diffuse.rgb *= v_color.a;`
    (src/refresh/shader.c:689-692) before the usual `diffuse *= color`,
    against a GLS_BLEND_ADD (GL_SRC_ALPHA, GL_ONE) blend. misc/flare.tga is
    a 49x49 24-bit grayscale radial glow with no alpha channel, so under
    fixed-function GL the equivalent is an additive GL_MODULATE draw with
    the alpha term folded into the color's rgb as well as its alpha -- that
    keeps the C's quadratic (alpha squared) response to the distance fade,
    and the texture's own black surround still adds nothing.

Everything else -- the 5-vertex fan and its texcoords, the `25 << def` /
`128 + def * 32` size and alpha constants, the LOCK_ANGLE view-axis basis vs
MakeNormalVectors basis, and the shell-color outer ring -- is the C's.
=================
*/
const flareTcoords: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0, 1],
  [0, 0],
  [1, 0],
  [1, 1],
];

export function R_DrawFlare(e: EntityT): void {
  const image = e.skin instanceof ImageT ? e.skin : null;
  if (!image) return; // no flare image registered (missing misc/flare.tga)

  const def = GL_IsDefaultFlareImage(image.name) ? 1 : 0;
  const scale = (25 << def) * e.scale[0];

  const left = vec3();
  const right = vec3();
  const down = vec3();
  const up = vec3();

  if (e.flags & RF_FLARE_LOCK_ANGLE) {
    // view-axis aligned: q2repro's viewaxis[1] is LEFT and [2] is UP, which
    // are this renderer's -vright and vup.
    VectorScale(vright, -scale, left);
    VectorScale(vright, scale, right);
    VectorScale(vup, -scale, down);
    VectorScale(vup, scale, up);
  } else {
    const dir = vec3();
    const r = vec3();
    const u = vec3();
    dir[0] = e.origin[0] - r_newrefdef.vieworg[0];
    dir[1] = e.origin[1] - r_newrefdef.vieworg[1];
    dir[2] = e.origin[2] - r_newrefdef.vieworg[2];
    VectorNormalize(dir);
    GL_MakeNormalVectors(dir, r, u);
    VectorScale(r, -scale, left);
    VectorScale(r, scale, right);
    VectorScale(u, -scale, down);
    VectorScale(u, scale, up);
  }

  // inner.a = (128 + def * 32) * (ent->alpha * q->frac), as a 0-255 byte
  const a = ((128 + def * 32) * e.alpha) / 255;

  // inner is the entity's own tint; outer matches it unless a shell color is
  // set, in which case the rim goes to the pure shell channel(s) and the
  // fan is smooth-shaded between the two (tess.c:459-472).
  const innerR = (e.rgba.r / 255) * a;
  const innerG = (e.rgba.g / 255) * a;
  const innerB = (e.rgba.b / 255) * a;
  let outerR = innerR;
  let outerG = innerG;
  let outerB = innerB;
  const shaded = (e.flags & (RF_SHELL_RED | RF_SHELL_GREEN | RF_SHELL_BLUE)) !== 0;
  if (shaded) {
    outerR = e.flags & RF_SHELL_RED ? a : 0;
    outerG = e.flags & RF_SHELL_GREEN ? a : 0;
    outerB = e.flags & RF_SHELL_BLUE ? a : 0;
  }

  const verts: Vec3[] = [
    vec3(e.origin[0], e.origin[1], e.origin[2]),
    vec3(e.origin[0] + down[0] + left[0], e.origin[1] + down[1] + left[1], e.origin[2] + down[2] + left[2]),
    vec3(e.origin[0] + up[0] + left[0], e.origin[1] + up[1] + left[1], e.origin[2] + up[2] + left[2]),
    vec3(e.origin[0] + up[0] + right[0], e.origin[1] + up[1] + right[1], e.origin[2] + up[2] + right[2]),
    vec3(e.origin[0] + down[0] + right[0], e.origin[1] + down[1] + right[1], e.origin[2] + down[2] + right[2]),
  ];

  GL_Bind(image.texnum);
  GL_TexEnv(GL_MODULATE);
  qgl.qglDisable(GL_ALPHA_TEST); // GL_SetDefaultState leaves it at GREATER 0.666, which would discard a faded flare outright
  qgl.qglEnable(GL_BLEND);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE); // GLS_BLEND_ADD
  // GLS_SHADE_SMOOTH is set only for the shell case in the C (tess.c:471);
  // without a shell every vertex carries the same color, so flat shading
  // (this renderer's default, GL_SetDefaultState) draws the same pixels.
  if (shaded) qgl.qglShadeModel(GL_SMOOTH);

  // indices { 0,2,3, 0,3,4, 0,4,1, 0,1,2 } == a fan around the center
  qgl.qglBegin(GL_TRIANGLE_FAN);
  for (const i of [0, 2, 3, 4, 1, 2]) {
    const tc = flareTcoords[i];
    if (i === 0) qgl.qglColor4f(innerR, innerG, innerB, a);
    else qgl.qglColor4f(outerR, outerG, outerB, a);
    qgl.qglTexCoord2f(tc[0], tc[1]);
    qgl.qglVertex3fv(verts[i]);
  }
  qgl.qglEnd();

  if (shaded) qgl.qglShadeModel(GL_FLAT);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglDisable(GL_BLEND);
  // leave the alpha test OFF, exactly as R_DrawSpriteModel above does. Its
  // threshold is GL_GREATER 0.666 (GL_SetDefaultState), and R_DrawAlphaSurfaces
  // -- which runs after the entity list, and never touches the alpha test
  // itself -- draws SURF_TRANS33/TRANS66 surfaces at alpha 0.33/0.66. Both
  // are below the threshold, so re-enabling here erased every translucent
  // world surface in the frame (seen live on maps/q64/cargo.bsp: the grated
  // floor and wall panels vanished the moment a flare was on screen).
  qgl.qglDisable(GL_ALPHA_TEST);
  qgl.qglColor4f(1, 1, 1, 1);
  GL_TexEnv(GL_REPLACE);
  // depth writes are already off: cl_ents.ts stamps RF_TRANSLUCENT on every
  // flare, so this only ever runs inside R_DrawEntitiesOnList's translucent
  // pass, which brackets itself with qglDepthMask(false)/(true) --
  // q2repro's own GLS_DEPTHMASK_FALSE, arrived at from the other side.
}

//==================================================================================

/*
=============
R_DrawNullModel
=============
*/
function R_DrawNullModel(): void {
  const shadelight = vec3();
  if (!currententity) return;

  if (currententity.flags & RF_FULLBRIGHT) {
    shadelight[0] = shadelight[1] = shadelight[2] = 1.0;
  } else {
    R_LightPoint(currententity.origin, shadelight);
  }

  qgl.qglPushMatrix();
  R_RotateForEntity(currententity);

  qgl.qglDisable(GL_TEXTURE_2D);
  qgl.qglColor3fv(shadelight);

  qgl.qglBegin(GL_TRIANGLE_FAN);
  qgl.qglVertex3f(0, 0, -16);
  for (let i = 0; i <= 4; i++) {
    qgl.qglVertex3f(16 * Math.cos((i * Math.PI) / 2), 16 * Math.sin((i * Math.PI) / 2), 0);
  }
  qgl.qglEnd();

  qgl.qglBegin(GL_TRIANGLE_FAN);
  qgl.qglVertex3f(0, 0, 16);
  for (let i = 4; i >= 0; i--) {
    qgl.qglVertex3f(16 * Math.cos((i * Math.PI) / 2), 16 * Math.sin((i * Math.PI) / 2), 0);
  }
  qgl.qglEnd();

  qgl.qglColor3f(1, 1, 1);
  qgl.qglPopMatrix();
  qgl.qglEnable(GL_TEXTURE_2D);
}

function narrowModel(model: unknown): ModelT | null {
  return model instanceof ModelT ? model : null;
}

function drawOneEntity(ent: EntityT): void {
  if (ent.flags & RF_BEAM) {
    R_DrawBeam(ent);
    return;
  }

  // q2repro's GL_ClassifyEntities (src/refresh/main.c:543-548) pulls flares
  // out of the entity list into their own chain before anything looks at
  // `ent->model`; a flare has no model at all (cl_ents.ts leaves it null),
  // so this has to come before the model lookup below or every flare would
  // draw as R_DrawNullModel's diamond.
  if (ent.flags & RF_FLARE) {
    R_DrawFlare(ent);
    return;
  }

  SetCurrentModel(narrowModel(ent.model));
  if (!currentmodel) {
    R_DrawNullModel();
    return;
  }
  switch (currentmodel.type) {
    case ModtypeT.mod_alias:
      R_DrawAliasModel(ent);
      break;
    case ModtypeT.mod_brush:
      R_DrawBrushModel(ent);
      break;
    case ModtypeT.mod_sprite:
      R_DrawSpriteModel(ent);
      break;
    default:
      ri.Sys_Error(ERR_DROP, "Bad modeltype");
      break;
  }
}

/*
=============
R_DrawEntitiesOnList
=============
*/
function R_DrawEntitiesOnList(): void {
  if (!(glCvars.r_drawentities && glCvars.r_drawentities.value)) return;
  // q2repro src/refresh/main.c:1135: `gl_drawentities` (CVAR_CHEAT) is
  // q2repro's rename of this same toggle; gate on both so either hides entities.
  if (glCvars.gl_drawentities && !glCvars.gl_drawentities.value) return;

  // draw non-transparent first
  for (let i = 0; i < r_newrefdef.num_entities; i++) {
    const ent = r_newrefdef.entities[i];
    SetCurrentEntity(ent);
    if (ent.flags & RF_TRANSLUCENT) continue; // solid

    drawOneEntity(ent);
  }

  // draw transparent entities
  // we could sort these if it ever becomes a problem...
  qgl.qglDepthMask(false); // no z writes
  for (let i = 0; i < r_newrefdef.num_entities; i++) {
    const ent = r_newrefdef.entities[i];
    SetCurrentEntity(ent);
    if (!(ent.flags & RF_TRANSLUCENT)) continue; // solid

    drawOneEntity(ent);
  }
  qgl.qglDepthMask(true); // back to writing
}

/*
** GL_DrawParticles
**
*/
export function GL_DrawParticles(particles: readonly ParticleT[], colortable: Uint32Array): void {
  if (!r_particletexture) return;

  GL_Bind(r_particletexture.texnum);
  qgl.qglDepthMask(false); // no z buffering
  qgl.qglEnable(GL_BLEND);
  GL_TexEnv(GL_MODULATE);
  qgl.qglBegin(GL_TRIANGLES);

  const up = vec3();
  const right = vec3();
  VectorScale(vup, 1.5, up);
  VectorScale(vright, 1.5, right);

  const colorBuf = new Uint32Array(1);
  const colorBytes = new Uint8Array(colorBuf.buffer);

  for (const p of particles) {
    // hack a scale up to keep particles from disapearing
    let scale = (p.origin[0] - r_origin[0]) * vpn[0] + (p.origin[1] - r_origin[1]) * vpn[1] + (p.origin[2] - r_origin[2]) * vpn[2];

    scale = scale < 20 ? 1 : 1 + scale * 0.004;

    colorBuf[0] = colortable[p.color];
    colorBytes[3] = Q_ftol(p.alpha * 255);

    qgl.qglColor4ubv(colorBytes);

    qgl.qglTexCoord2f(0.0625, 0.0625);
    qgl.qglVertex3fv(p.origin);

    qgl.qglTexCoord2f(1.0625, 0.0625);
    qgl.qglVertex3f(p.origin[0] + up[0] * scale, p.origin[1] + up[1] * scale, p.origin[2] + up[2] * scale);

    qgl.qglTexCoord2f(0.0625, 1.0625);
    qgl.qglVertex3f(p.origin[0] + right[0] * scale, p.origin[1] + right[1] * scale, p.origin[2] + right[2] * scale);
  }

  qgl.qglEnd();
  qgl.qglDisable(GL_BLEND);
  qgl.qglColor4f(1, 1, 1, 1);
  qgl.qglDepthMask(true); // back to normal Z buffering
  GL_TexEnv(GL_REPLACE);
}

/*
===============
R_DrawParticles
===============
*/
function R_DrawParticles(): void {
  if (glCvars.gl_ext_pointparameters && glCvars.gl_ext_pointparameters.value && Boolean(qgl.qglPointParameterfEXT)) {
    qgl.qglDepthMask(false);
    qgl.qglEnable(GL_BLEND);
    qgl.qglDisable(GL_TEXTURE_2D);

    qgl.qglPointSize(glCvars.gl_particle_size ? glCvars.gl_particle_size.value : 0);

    qgl.qglBegin(GL_POINTS);

    const colorBuf = new Uint32Array(1);
    const colorBytes = new Uint8Array(colorBuf.buffer);

    for (let i = 0; i < r_newrefdef.num_particles; i++) {
      const p = r_newrefdef.particles[i];
      colorBuf[0] = d_8to24table[p.color];
      colorBytes[3] = Q_ftol(p.alpha * 255);

      qgl.qglColor4ubv(colorBytes);

      qgl.qglVertex3fv(p.origin);
    }
    qgl.qglEnd();

    qgl.qglDisable(GL_BLEND);
    qgl.qglColor4f(1.0, 1.0, 1.0, 1.0);
    qgl.qglDepthMask(true);
    qgl.qglEnable(GL_TEXTURE_2D);
  } else {
    GL_DrawParticles(r_newrefdef.particles.slice(0, r_newrefdef.num_particles), d_8to24table);
  }
}

/*
============
R_PolyBlend
============
*/
function R_PolyBlend(): void {
  if (!(glCvars.gl_polyblend && glCvars.gl_polyblend.value)) return;
  if (!v_blend[3]) return;

  qgl.qglDisable(GL_ALPHA_TEST);
  qgl.qglEnable(GL_BLEND);
  qgl.qglDisable(GL_DEPTH_TEST);
  qgl.qglDisable(GL_TEXTURE_2D);

  qgl.qglLoadIdentity();

  // FIXME: get rid of these
  qgl.qglRotatef(-90, 1, 0, 0); // put Z going up
  qgl.qglRotatef(90, 0, 0, 1); // put Z going up

  qgl.qglColor4fv(v_blend);

  qgl.qglBegin(GL_QUADS);

  qgl.qglVertex3f(10, 100, 100);
  qgl.qglVertex3f(10, -100, 100);
  qgl.qglVertex3f(10, -100, -100);
  qgl.qglVertex3f(10, 100, -100);
  qgl.qglEnd();

  qgl.qglDisable(GL_BLEND);
  qgl.qglEnable(GL_TEXTURE_2D);
  qgl.qglEnable(GL_ALPHA_TEST);

  qgl.qglColor4f(1, 1, 1, 1);
}

//=======================================================================

function SignbitsForPlane(out: CplaneT): number {
  // for fast box on planeside test
  let bits = 0;
  for (let j = 0; j < 3; j++) {
    if (out.normal[j] < 0) bits |= 1 << j;
  }
  return bits;
}

function R_SetFrustum(): void {
  // rotate VPN right by FOV_X/2 degrees
  RotatePointAroundVector(frustum[0].normal, vup, vpn, -(90 - r_newrefdef.fov_x / 2));
  // rotate VPN left by FOV_X/2 degrees
  RotatePointAroundVector(frustum[1].normal, vup, vpn, 90 - r_newrefdef.fov_x / 2);
  // rotate VPN up by FOV_X/2 degrees
  RotatePointAroundVector(frustum[2].normal, vright, vpn, 90 - r_newrefdef.fov_y / 2);
  // rotate VPN down by FOV_X/2 degrees
  RotatePointAroundVector(frustum[3].normal, vright, vpn, -(90 - r_newrefdef.fov_y / 2));

  for (let i = 0; i < 4; i++) {
    frustum[i].type = PLANE_ANYZ;
    frustum[i].dist = DotProduct(r_origin, frustum[i].normal);
    frustum[i].signbits = SignbitsForPlane(frustum[i]);
  }
}

//=======================================================================

/*
===============
R_SetupFrame
===============
*/
function R_SetupFrame(): void {
  SetFrameCount(r_framecount + 1);

  // build the transformation matrix for the given view angles
  VectorCopy(r_newrefdef.vieworg, r_origin);

  AngleVectors(r_newrefdef.viewangles, vpn, vright, vup);

  // current viewcluster
  if (!(r_newrefdef.rdflags & RDF_NOWORLDMODEL) && r_worldmodel) {
    const oldCluster = r_viewcluster;
    const oldCluster2 = r_viewcluster2;
    let leaf = Mod_PointInLeaf(r_origin, r_worldmodel);
    let cluster = leaf.cluster;
    let cluster2 = leaf.cluster;

    // check above and below so crossing solid water doesn't draw wrong
    if (!leaf.contents) {
      // look down a bit
      const temp = vec3(r_origin[0], r_origin[1], r_origin[2] - 16);
      leaf = Mod_PointInLeaf(temp, r_worldmodel);
      if (!(leaf.contents & CONTENTS_SOLID) && leaf.cluster !== cluster2) cluster2 = leaf.cluster;
    } else {
      // look up a bit
      const temp = vec3(r_origin[0], r_origin[1], r_origin[2] + 16);
      leaf = Mod_PointInLeaf(temp, r_worldmodel);
      if (!(leaf.contents & CONTENTS_SOLID) && leaf.cluster !== cluster2) cluster2 = leaf.cluster;
    }

    SetViewClusters(cluster, cluster2, oldCluster, oldCluster2);
  }

  for (let i = 0; i < 4; i++) v_blend[i] = r_newrefdef.blend[i];

  SetBrushPolys(0);
  SetAliasPolys(0);

  // clear out the portion of the screen that the NOWORLDMODEL defines
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL) {
    qgl.qglEnable(GL_SCISSOR_TEST);
    qgl.qglClearColor(0.3, 0.3, 0.3, 1);
    qgl.qglScissor(r_newrefdef.x, vid.height - r_newrefdef.height - r_newrefdef.y, r_newrefdef.width, r_newrefdef.height);
    qgl.qglClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    qgl.qglClearColor(1, 0, 0.5, 0.5);
    qgl.qglDisable(GL_SCISSOR_TEST);
  }
}

export function MYgluPerspective(fovy: number, aspect: number, zNear: number, zFar: number): void {
  const ymax = zNear * Math.tan((fovy * Math.PI) / 360.0);
  const ymin = -ymax;

  let xmin = ymin * aspect;
  let xmax = ymax * aspect;

  xmin += -(2 * gl_state.camera_separation) / zNear;
  xmax += -(2 * gl_state.camera_separation) / zNear;

  qgl.qglFrustum(xmin, xmax, ymin, ymax, zNear, zFar);
}

/*
=============
R_SetupGL
=============
*/
function R_SetupGL(): void {
  const x = Math.floor((r_newrefdef.x * vid.width) / vid.width);
  const x2 = Math.ceil(((r_newrefdef.x + r_newrefdef.width) * vid.width) / vid.width);
  const y = Math.floor(vid.height - (r_newrefdef.y * vid.height) / vid.height);
  const y2 = Math.ceil(vid.height - ((r_newrefdef.y + r_newrefdef.height) * vid.height) / vid.height);

  const w = x2 - x;
  const h = y - y2;

  qgl.qglViewport(x, y2, w, h);

  //
  // set up projection matrix
  //
  const screenaspect = r_newrefdef.width / r_newrefdef.height;
  qgl.qglMatrixMode(GL_PROJECTION);
  qgl.qglLoadIdentity();
  // q2repro src/refresh/state.c:232: `float znear = gl_znear->value` --
  // replaces this port's prior hardcoded "4" near-plane constant.
  const znear = glCvars.gl_znear ? glCvars.gl_znear.value : 4;
  MYgluPerspective(r_newrefdef.fov_y, screenaspect, znear, 4096);

  qgl.qglCullFace(GL_FRONT);

  qgl.qglMatrixMode(GL_MODELVIEW);
  qgl.qglLoadIdentity();

  qgl.qglRotatef(-90, 1, 0, 0); // put Z going up
  qgl.qglRotatef(90, 0, 0, 1); // put Z going up
  qgl.qglRotatef(-r_newrefdef.viewangles[2], 1, 0, 0);
  qgl.qglRotatef(-r_newrefdef.viewangles[0], 0, 1, 0);
  qgl.qglRotatef(-r_newrefdef.viewangles[1], 0, 0, 1);
  qgl.qglTranslatef(-r_newrefdef.vieworg[0], -r_newrefdef.vieworg[1], -r_newrefdef.vieworg[2]);

  qgl.qglGetFloatv(GL_MODELVIEW_MATRIX, r_world_matrix);

  //
  // set drawing parms
  //
  if (glCvars.gl_cull && glCvars.gl_cull.value) qgl.qglEnable(GL_CULL_FACE);
  else qgl.qglDisable(GL_CULL_FACE);

  qgl.qglDisable(GL_BLEND);
  qgl.qglDisable(GL_ALPHA_TEST);
  qgl.qglEnable(GL_DEPTH_TEST);
}

/*
=============
R_Clear
=============
*/
let trickframe = 0; // static int trickframe (C function-scoped static)

function R_Clear(): void {
  if (glCvars.gl_ztrick && glCvars.gl_ztrick.value) {
    if (glCvars.gl_clear && glCvars.gl_clear.value) qgl.qglClear(GL_COLOR_BUFFER_BIT);

    trickframe++;
    if (trickframe & 1) {
      SetGlDepthRange(0, 0.49999);
      qgl.qglDepthFunc(GL_LEQUAL);
    } else {
      SetGlDepthRange(1, 0.5);
      qgl.qglDepthFunc(GL_GEQUAL);
    }
  } else {
    if (glCvars.gl_clear && glCvars.gl_clear.value) qgl.qglClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    else qgl.qglClear(GL_DEPTH_BUFFER_BIT);
    SetGlDepthRange(0, 1);
    qgl.qglDepthFunc(GL_LEQUAL);
  }

  qgl.qglDepthRange(gldepthmin, gldepthmax);
}

function R_Flash(): void {
  R_PolyBlend();
}

/*
================
R_RenderView

r_newrefdef must be set before the first call
================
*/
function copyRefdef(dst: RefdefT, src: RefdefT): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.width = src.width;
  dst.height = src.height;
  dst.fov_x = src.fov_x;
  dst.fov_y = src.fov_y;
  VectorCopy(src.vieworg, dst.vieworg);
  VectorCopy(src.viewangles, dst.viewangles);
  dst.blend.set(src.blend);
  dst.time = src.time;
  dst.rdflags = src.rdflags;
  dst.areabits = src.areabits;
  dst.lightstyles = src.lightstyles;
  dst.num_entities = src.num_entities;
  dst.entities = src.entities;
  dst.num_dlights = src.num_dlights;
  dst.dlights = src.dlights;
  dst.num_particles = src.num_particles;
  dst.particles = src.particles;
}

export function R_RenderView(fd: RefdefT): void {
  if (glCvars.r_norefresh && glCvars.r_norefresh.value) return;

  copyRefdef(r_newrefdef, fd);

  if (!r_worldmodel && !(r_newrefdef.rdflags & RDF_NOWORLDMODEL)) {
    ri.Sys_Error(ERR_DROP, "R_RenderView: NULL worldmodel");
  }

  if (glCvars.r_speeds && glCvars.r_speeds.value) {
    SetBrushPolys(0);
    SetAliasPolys(0);
  }

  R_PushDlights();

  if (glCvars.gl_finish && glCvars.gl_finish.value) qgl.qglFinish();

  R_SetupFrame();

  R_SetFrustum();

  R_SetupGL();

  R_MarkLeaves(); // done here so we know if we're in water

  // v1.1.0 shadow maps: build/refresh the shadow lights' depth atlas. Must sit
  // between R_SetupGL and R_DrawWorld -- it takes over the viewport and both
  // matrices, and nothing between here and the world draw depends on them
  // except R_DrawWorld itself, which is why R_SetupGL is re-run below rather
  // than the pass trying to restore the scene's matrices by hand.
  //
  // The entity list goes in as well: alias models and inline brush models are
  // casters, so a light with one in range re-renders its depth map here
  // before R_DrawEntitiesOnList below draws the same entities to the screen.
  R_RenderShadowMaps(r_worldmodel, r_newrefdef.dlights, r_newrefdef.num_dlights, r_newrefdef.entities, r_newrefdef.num_entities);
  R_SetupGL();

  R_DrawWorld();

  R_DrawEntitiesOnList();

  R_RenderDlights();

  R_DrawParticles();

  R_DrawAlphaSurfaces();

  R_Flash();

  if (glCvars.r_speeds && glCvars.r_speeds.value) {
    ri.Con_Printf(PRINT_ALL, `${c_brush_polys} wpoly ${c_alias_polys} epoly ${c_visible_textures} tex ${c_visible_lightmaps} lmaps\n`);
    // v1.1.1: the shadow atlas's own cost, appended rather than folded into
    // the line above so the original id Software format stays byte-identical
    // for anyone reading it. A frame with no shadow lights prints nothing.
    const shadows = GL_ShadowMapStats();
    if (shadows.lights) {
      ri.Con_Printf(
        PRINT_ALL,
        `${shadows.lights} shadowlights (${shadows.cachedLights} cached, ${shadows.rebuiltLights} rebuilt) ${shadows.facesRendered} depthpass ${shadows.entityCasters} ecasters\n`,
      );
    }
  }
}

function R_SetGL2D(): void {
  // set 2D virtual screen size
  qgl.qglViewport(0, 0, vid.width, vid.height);
  qgl.qglMatrixMode(GL_PROJECTION);
  qgl.qglLoadIdentity();
  qgl.qglOrtho(0, vid.width, vid.height, 0, -99999, 99999);
  qgl.qglMatrixMode(GL_MODELVIEW);
  qgl.qglLoadIdentity();
  qgl.qglDisable(GL_DEPTH_TEST);
  qgl.qglDisable(GL_CULL_FACE);
  qgl.qglDisable(GL_BLEND);
  qgl.qglEnable(GL_ALPHA_TEST);
  qgl.qglColor4f(1, 1, 1, 1);
}

// GL_DrawStereoPattern/GL_DrawColoredStereoLinePair (and their sole caller,
// wrapped in `#if 0 // commented out until H3D pays us the money they owe
// us`) are dropped -- see file header comment.

/*
====================
R_SetLightLevel

====================
*/
function R_SetLightLevel(): void {
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL) return;

  // save off light value for server to look at (BIG HACK!)
  const shadelight = vec3();
  R_LightPoint(r_newrefdef.vieworg, shadelight);

  if (!glCvars.r_lightlevel) return;

  // pick the greatest component, which should be the same
  // as the mono value returned by software
  if (shadelight[0] > shadelight[1]) {
    glCvars.r_lightlevel.value = shadelight[0] > shadelight[2] ? 150 * shadelight[0] : 150 * shadelight[2];
  } else {
    glCvars.r_lightlevel.value = shadelight[1] > shadelight[2] ? 150 * shadelight[1] : 150 * shadelight[2];
  }
}

/*
@@@@@@@@@@@@@@@@@@@@@
R_RenderFrame

@@@@@@@@@@@@@@@@@@@@@
*/
export function R_RenderFrame(fd: RefdefT): void {
  R_RenderView(fd);
  R_SetLightLevel();
  R_SetGL2D();
}

// Exported (was module-private) so test/cvar_parity.test.ts can register
// this renderer's cvars without needing a real GL context (R_Init also
// calls Draw_GetPalette()/loadQGLFromSystem(), neither reachable headless).
export function R_Register(): void {
  glCvars.r_lefthand = ri.Cvar_Get("hand", "0", CVAR_USERINFO | CVAR_ARCHIVE);
  glCvars.r_norefresh = ri.Cvar_Get("r_norefresh", "0", 0);
  // q2repro src/refresh/main.c:1161 flags this CVAR_CHEAT (cvar-parity fix).
  glCvars.r_fullbright = ri.Cvar_Get("r_fullbright", "0", CVAR_CHEAT);
  glCvars.r_drawentities = ri.Cvar_Get("r_drawentities", "1", 0);
  glCvars.r_drawworld = ri.Cvar_Get("r_drawworld", "1", 0);
  glCvars.r_novis = ri.Cvar_Get("r_novis", "0", 0);
  glCvars.r_nocull = ri.Cvar_Get("r_nocull", "0", 0);
  glCvars.r_lerpmodels = ri.Cvar_Get("r_lerpmodels", "1", 0);
  glCvars.r_speeds = ri.Cvar_Get("r_speeds", "0", 0);

  glCvars.r_lightlevel = ri.Cvar_Get("r_lightlevel", "0", 0);

  // task #25 (v1.1.0): q2repro src/refresh/main.c/shader.c's
  // gl_shaders/gl_per_pixel_lighting, same names and same "1" default as
  // q2repro's own GLSL backend (see gl_shader.ts's GL_InitShaderPath).
  // q2repro flags this CVAR_FILES (src/refresh/main.c:1119, cvar-parity fix).
  glCvars.gl_shaders = ri.Cvar_Get("gl_shaders", "1", CVAR_FILES);
  glCvars.gl_per_pixel_lighting = ri.Cvar_Get("gl_per_pixel_lighting", "1", 0);
  // v1.1.0 shadow maps (gl_shadowmap.ts). CVAR_ARCHIVE rather than
  // gl_shaders' CVAR_FILES: toggling it needs no vid restart, since the
  // shadow permutation is selected per frame from the live value.
  glCvars.gl_shadowmaps = ri.Cvar_Get("gl_shadowmaps", "1", CVAR_ARCHIVE);
  glCvars.gl_shadowmap_res = ri.Cvar_Get("gl_shadowmap_res", "512", CVAR_ARCHIVE);

  glCvars.gl_nosubimage = ri.Cvar_Get("gl_nosubimage", "0", 0);
  // gl_allow_software: registered for its console side effect only -- the C
  // global it fills is never read anywhere in the ref_gl tree, and
  // gl_local.ts's glCvars holder (out of this unit's SCOPE) has no field
  // for it, matching that same dead-storage shape.
  ri.Cvar_Get("gl_allow_software", "0", 0);

  glCvars.gl_particle_min_size = ri.Cvar_Get("gl_particle_min_size", "2", CVAR_ARCHIVE);
  glCvars.gl_particle_max_size = ri.Cvar_Get("gl_particle_max_size", "40", CVAR_ARCHIVE);
  glCvars.gl_particle_size = ri.Cvar_Get("gl_particle_size", "40", CVAR_ARCHIVE);
  glCvars.gl_particle_att_a = ri.Cvar_Get("gl_particle_att_a", "0.01", CVAR_ARCHIVE);
  glCvars.gl_particle_att_b = ri.Cvar_Get("gl_particle_att_b", "0.0", CVAR_ARCHIVE);
  glCvars.gl_particle_att_c = ri.Cvar_Get("gl_particle_att_c", "0.01", CVAR_ARCHIVE);

  // q2repro src/refresh/main.c:1101: `gl_modulate = Cvar_Get("gl_modulate", "2", CVAR_ARCHIVE);`
  // -- default fixed from this port's prior "1" to q2repro's "2".
  glCvars.gl_modulate = ri.Cvar_Get("gl_modulate", "2", CVAR_ARCHIVE);
  glCvars.gl_log = ri.Cvar_Get("gl_log", "0", 0);
  glCvars.gl_bitdepth = ri.Cvar_Get("gl_bitdepth", "0", 0);
  glCvars.gl_mode = ri.Cvar_Get("gl_mode", "3", CVAR_ARCHIVE);
  // q2repro src/refresh/main.c:1160 flags this CVAR_CHEAT (cvar-parity fix).
  glCvars.gl_lightmap = ri.Cvar_Get("gl_lightmap", "0", CVAR_CHEAT);
  // q2repro src/refresh/main.c:1100: `gl_shadows = Cvar_Get("gl_shadows", "2", CVAR_ARCHIVE);`
  // -- default fixed from this port's prior "0" to q2repro's "2"; flags
  // already matched (CVAR_ARCHIVE), left unchanged.
  glCvars.gl_shadows = ri.Cvar_Get("gl_shadows", "2", CVAR_ARCHIVE);
  glCvars.gl_dynamic = ri.Cvar_Get("gl_dynamic", "1", 0);
  // q2repro src/refresh/main.c:1145 flags this CVAR_CHEAT (cvar-parity fix).
  glCvars.gl_nobind = ri.Cvar_Get("gl_nobind", "0", CVAR_CHEAT);
  // q2repro src/refresh/texture.c:1260: `gl_round_down = Cvar_Get("gl_round_down", "0", CVAR_FILES);`
  // -- default fixed from this port's prior "1" to q2repro's "0", flags
  // fixed from 0 to CVAR_FILES.
  glCvars.gl_round_down = ri.Cvar_Get("gl_round_down", "0", CVAR_FILES);
  // q2repro src/refresh/texture.c:1261: `gl_picmip = Cvar_Get("gl_picmip", "0", CVAR_FILES);`
  // -- flags fixed from 0 to CVAR_FILES (see also vid_menu.ts's own
  // gl_picmip registration, fixed the same way).
  glCvars.gl_picmip = ri.Cvar_Get("gl_picmip", "0", CVAR_FILES);
  glCvars.gl_skymip = ri.Cvar_Get("gl_skymip", "0", 0);
  // q2repro src/refresh/main.c:1139 flags this CVAR_CHEAT (cvar-parity fix).
  glCvars.gl_showtris = ri.Cvar_Get("gl_showtris", "0", CVAR_CHEAT);
  glCvars.gl_ztrick = ri.Cvar_Get("gl_ztrick", "0", 0);
  // q2repro src/refresh/main.c:1156: `gl_finish = Cvar_Get("gl_finish", "0", 0);`
  // -- flags fixed from this port's prior CVAR_ARCHIVE to q2repro's 0.
  glCvars.gl_finish = ri.Cvar_Get("gl_finish", "0", 0);
  glCvars.gl_clear = ri.Cvar_Get("gl_clear", "0", 0);
  glCvars.gl_cull = ri.Cvar_Get("gl_cull", "1", 0);
  glCvars.gl_polyblend = ri.Cvar_Get("gl_polyblend", "1", 0);
  glCvars.gl_flashblend = ri.Cvar_Get("gl_flashblend", "0", 0);
  glCvars.gl_playermip = ri.Cvar_Get("gl_playermip", "0", 0);
  glCvars.gl_monolightmap = ri.Cvar_Get("gl_monolightmap", "0", 0);
  glCvars.gl_driver = ri.Cvar_Get("gl_driver", "opengl32", CVAR_ARCHIVE);
  // q2repro src/refresh/texture.c:1253: `gl_texturemode = Cvar_Get("gl_texturemode",
  // "GL_LINEAR_MIPMAP_LINEAR", CVAR_ARCHIVE);` -- default fixed from this
  // port's prior "GL_LINEAR_MIPMAP_NEAREST". Checked for a documented
  // technical reason to keep NEAREST filtering (e.g. a hardcoded assumption
  // elsewhere): none found -- gl_image.ts:175's SetGlFilterMinMax(..., ...)
  // call and gl_rmisc.ts's GL_TextureMode fallback string are both just
  // defensive pre-init/null-cvar defaults, immediately superseded by
  // GL_TextureMode(glCvars.gl_texturemode.string) once the cvar exists (see
  // gl_rmain.ts's own R_Register-adjacent GL_TextureMode call and
  // gl_rmisc.ts's GL_SetDefaultState), so this default fix is applied plain.
  glCvars.gl_texturemode = ri.Cvar_Get("gl_texturemode", "GL_LINEAR_MIPMAP_LINEAR", CVAR_ARCHIVE);
  glCvars.gl_texturealphamode = ri.Cvar_Get("gl_texturealphamode", "default", CVAR_ARCHIVE);
  glCvars.gl_texturesolidmode = ri.Cvar_Get("gl_texturesolidmode", "default", CVAR_ARCHIVE);
  // q2repro src/refresh/main.c:1159 flags this CVAR_CHEAT (cvar-parity fix).
  glCvars.gl_lockpvs = ri.Cvar_Get("gl_lockpvs", "0", CVAR_CHEAT);
  // q2repro src/refresh/main.c: gl_lightgrid = Cvar_Get("gl_lightgrid", "1", 0);
  glCvars.gl_lightgrid = ri.Cvar_Get("gl_lightgrid", "1", 0);

  glCvars.gl_vertex_arrays = ri.Cvar_Get("gl_vertex_arrays", "0", CVAR_ARCHIVE);

  glCvars.gl_ext_swapinterval = ri.Cvar_Get("gl_ext_swapinterval", "1", CVAR_ARCHIVE);
  glCvars.gl_ext_palettedtexture = ri.Cvar_Get("gl_ext_palettedtexture", "1", CVAR_ARCHIVE);
  glCvars.gl_ext_multitexture = ri.Cvar_Get("gl_ext_multitexture", "1", CVAR_ARCHIVE);
  glCvars.gl_ext_pointparameters = ri.Cvar_Get("gl_ext_pointparameters", "1", CVAR_ARCHIVE);
  glCvars.gl_ext_compiled_vertex_array = ri.Cvar_Get("gl_ext_compiled_vertex_array", "1", CVAR_ARCHIVE);

  glCvars.gl_drawbuffer = ri.Cvar_Get("gl_drawbuffer", "GL_BACK", 0);
  glCvars.gl_swapinterval = ri.Cvar_Get("gl_swapinterval", "1", CVAR_ARCHIVE);

  glCvars.gl_saturatelighting = ri.Cvar_Get("gl_saturatelighting", "0", 0);

  glCvars.gl_3dlabs_broken = ri.Cvar_Get("gl_3dlabs_broken", "1", CVAR_ARCHIVE);

  glCvars.vid_fullscreen = ri.Cvar_Get("vid_fullscreen", "0", CVAR_ARCHIVE);
  glCvars.vid_gamma = ri.Cvar_Get("vid_gamma", "1.0", CVAR_ARCHIVE);
  glCvars.vid_scale = ri.Cvar_Get("vid_scale", "1", CVAR_ARCHIVE);
  // vid_ref: gl_local.ts has no field for it (client-owned elsewhere);
  // registered here purely for its console-visibility side effect, matching
  // the original's own local (non-stored) `cvar_t *vid_ref` use.
  ri.Cvar_Get("vid_ref", "soft", CVAR_ARCHIVE);

  // ==========================================================================
  // Engine-cvar parity audit, ref_gl cluster: cvars whose q2repro registration
  // site is in src/refresh/*.c but that this vanilla-shaped renderer never
  // registered at all (console "unknown command" today). Checked every one of
  // these against this renderer's actual logic (grepped gl_*.ts for the
  // feature each gates) before deciding disposition; most gate q2repro-only
  // features (bloom, fog, water warp, cel-shading, MD5 models, cubemaps,
  // HQ2X upscaling, glowmaps, damage-blend overlay, GL debug-line/text
  // overlay, a newer alpha-sort/GPU-lerp/VBO pipeline) that this renderer
  // never ported, so those are registered here so the console command stops
  // failing but have no consumer to wire in ("registered, consumer
  // unported" in this unit's report). A handful gate logic that DOES already
  // exist here under a differently-named vanilla cvar or a real function this
  // renderer already runs; those are wired in below at their consumer site
  // and just registered here.

  // q2repro src/refresh/main.c:1133: `gl_znear = Cvar_Get("gl_znear", "2", CVAR_CHEAT);`
  // -- wired into R_SetupGL below, replacing MYgluPerspective's hardcoded "4"
  // near-plane constant (state.c:232's `gl_znear->value` is the same
  // near-plane use).
  glCvars.gl_znear = ri.Cvar_Get("gl_znear", "2", CVAR_CHEAT);
  // q2repro src/refresh/main.c:1134/1135: q2repro renamed vanilla's
  // r_drawworld/r_drawentities (which this port still carries above, with
  // live consumers at gl_rsurf.ts's R_DrawWorld and this file's
  // R_DrawEntitiesOnList) to gl_drawworld/gl_drawentities with CVAR_CHEAT.
  // Registered under the new name too and wired in as an additional AND-gate
  // at both existing consumer sites, so either cvar can hide world/entities.
  glCvars.gl_drawworld = ri.Cvar_Get("gl_drawworld", "1", CVAR_CHEAT);
  glCvars.gl_drawentities = ri.Cvar_Get("gl_drawentities", "1", CVAR_CHEAT);
  // q2repro src/refresh/main.c:1136: `gl_drawsky = Cvar_Get("gl_drawsky", "1", 0);`
  // (consumed at sky.c:451/state.c:78/tess.c:763) -- wired into gl_warp.ts's
  // R_DrawSkyBox, this renderer's real (and only) skybox-drawing entry point.
  glCvars.gl_drawsky = ri.Cvar_Get("gl_drawsky", "1", 0);
  // q2repro src/refresh/main.c:1138: `gl_draworder = Cvar_Get("gl_draworder", "1", 0);`
  // -- gates an alpha-threshold translucent-entity sort/depth-write decision
  // in q2repro's main.c:563 (`ent->alpha <= gl_draworder->value`) that has no
  // equivalent in this renderer's simple solid-then-translucent draw order
  // (R_DrawEntitiesOnList); registered only, no consumer to wire in.
  ri.Cvar_Get("gl_draworder", "1", 0);
  // q2repro src/refresh/main.c:1140/1141/1142: development/debug toggles with
  // no matching debug-overlay logic in this renderer (no showorigins/
  // showtearing/showbloom counterpart exists) -- registered only.
  ri.Cvar_Get("gl_showorigins", "0", CVAR_CHEAT);
  ri.Cvar_Get("gl_showtearing", "0", CVAR_CHEAT);
  ri.Cvar_Get("gl_showbloom", "0", CVAR_CHEAT);
  // q2repro src/refresh/main.c:1144/1146/1147: gl_showscrap (scrap-atlas
  // debug view), gl_novbo (this renderer has no VBO path to disable -- only
  // gl_vertex_arrays, a distinct older client-vertex-array toggle), gl_test
  // (a free-form developer scratch cvar with no fixed behavior even in
  // q2repro itself) -- registered only.
  ri.Cvar_Get("gl_showscrap", "0", 0);
  ri.Cvar_Get("gl_novbo", "0", CVAR_FILES);
  ri.Cvar_Get("gl_test", "0", 0);
  // q2repro src/refresh/main.c:1149/1150: gate real, existing culling calls
  // in this renderer -- gl_cull_nodes wired into gl_rsurf.ts's
  // R_RecursiveWorldNode (world.c:593's node-tree cull-flag use, this port's
  // closest equivalent is the per-node R_CullBox check), gl_cull_models
  // wired into gl_mesh.ts's R_DrawAliasModel (mesh.c:501's identical gate on
  // its own R_CullAliasModel call).
  glCvars.gl_cull_nodes = ri.Cvar_Get("gl_cull_nodes", "1", 0);
  glCvars.gl_cull_models = ri.Cvar_Get("gl_cull_models", "1", 0);
  // q2repro src/refresh/main.c:1151: debug overlay counting culled objects; no such counter exists here.
  ri.Cvar_Get("gl_showcull", "0", CVAR_CHEAT);
  // q2repro src/refresh/main.c:1153: `gl_clearcolor = Cvar_Get("gl_clearcolor", "black", 0);`
  // -- this renderer's clear color is hardcoded at each qglClearColor call
  // site (gl_rmain.ts/gl_rmisc.ts), never cvar-driven; registered only.
  ri.Cvar_Get("gl_clearcolor", "black", 0);
  // q2repro src/refresh/main.c:1157: q2repro renamed vanilla's r_novis (still
  // carried above, live consumer at gl_rsurf.ts's R_MarkLeaves) to gl_novis.
  // Registered under the new name and wired in as an additional OR-gate at
  // both of R_MarkLeaves' r_novis checks.
  glCvars.gl_novis = ri.Cvar_Get("gl_novis", "0", 0);
  // q2repro src/refresh/main.c:1163: `gl_vertexlight = Cvar_Get("gl_vertexlight", "0", 0);`
  // -- gates a per-vertex-lighting path (vs. lightmaps) this renderer never
  // ported; registered only.
  ri.Cvar_Get("gl_vertexlight", "0", 0);
  // q2repro src/refresh/main.c:1167: `gl_showerrors = Cvar_Get("gl_showerrors", "1", 0);`
  // -- gates extra glGetError() diagnostic logging this renderer's qgl.ts
  // layer doesn't implement; registered only.
  ri.Cvar_Get("gl_showerrors", "1", 0);

  // q2repro src/refresh/main.c:1095-1099: particle/beam rendering-style
  // toggles for a shape/style system this renderer's particle drawing
  // (gl_rmain.ts's R_DrawParticles-equivalent) never implemented --
  // registered only.
  ri.Cvar_Get("gl_partscale", "2", 0);
  ri.Cvar_Get("gl_partstyle", "0", 0);
  ri.Cvar_Get("gl_beamstyle", "0", 0);
  ri.Cvar_Get("gl_celshading", "0", 0);
  // gl_dotshading: q2repro's mesh.c:62 setup_dotshading() is a distinct GPU-
  // shader-path effect (interacts with gl_static.use_shaders/
  // gl_per_pixel_lighting) layered on top of vanilla's own always-on,
  // non-cvar-gated shadedots computation in gl_mesh.ts -- not the same
  // feature, no consumer to wire in.
  ri.Cvar_Get("gl_dotshading", "0", 0);
  // q2repro src/refresh/main.c:1103/1105/1107/1109: lightmap-pipeline
  // variations (world-texture modulation toggle, colored lightmaps, forced
  // lightmap bit depth, brightness curve) this renderer's fixed vanilla
  // lightmap build (gl_light.ts) never implemented -- registered only.
  ri.Cvar_Get("gl_modulate_world", "1", 0);
  ri.Cvar_Get("gl_coloredlightmaps", "1", 0);
  ri.Cvar_Get("gl_lightmap_bits", "0", 0);
  ri.Cvar_Get("gl_brightness", "0", 0);
  // q2repro src/refresh/main.c:1113/1114: alternate dynamic-light falloff
  // curve and a separate entity-modulation toggle; this renderer's dlight
  // accumulation (gl_light.ts) has no such curve selector, and entity
  // modulation is unconditional -- registered only.
  ri.Cvar_Get("gl_dlight_falloff", "1", 0);
  ri.Cvar_Get("gl_modulate_entities", "1", 0);
  // q2repro src/refresh/main.c:1116/1117/1118: glowmap intensity (this
  // renderer has no glowmap texture pass), lens-flare animation speed (no
  // flare effect exists here), and font drop-shadow (gl_draw.ts's Draw_Char
  // has no shadow pass) -- registered only.
  ri.Cvar_Get("gl_glowmap_intensity", "1", 0);
  ri.Cvar_Get("gl_flarespeed", "8", 0);
  ri.Cvar_Get("gl_fontshadow", "0", 0);
  // q2repro src/refresh/main.c:1121-1123 (`#if USE_MD5`): MD5 skeletal-model
  // loading/use/LOD-distance cvars. gl_model.ts's Mod_LoadMD5 reads
  // gl_md5_load; gl_mesh.ts's R_DrawAliasModel reads gl_md5_use/gl_md5_distance.
  glCvars.gl_md5_load = ri.Cvar_Get("gl_md5_load", "1", CVAR_FILES);
  glCvars.gl_md5_use = ri.Cvar_Get("gl_md5_use", "1", 0);
  glCvars.gl_md5_distance = ri.Cvar_Get("gl_md5_distance", "2048", 0);
  // q2repro src/refresh/main.c:1125 (also :1168, same Cvar_Get call, cited
  // once here): damage-blend screen-overlay fraction; this renderer has no
  // damage-blend overlay pass -- registered only.
  ri.Cvar_Get("gl_damageblend_frac", "0.2", 0);
  // q2repro src/refresh/main.c:1126/1127/1128: water-warp distortion, fog,
  // and bloom post-processing -- none of these post-effects exist in this
  // renderer (gl_warp.ts's WaterWarpPolyVerts is `#if 0`'d out per that
  // file's own header comment; no fog or bloom pass anywhere) -- registered
  // only.
  ri.Cvar_Get("gl_waterwarp", "1", 0);
  ri.Cvar_Get("gl_fog", "1", 0);
  ri.Cvar_Get("gl_bloom", "1", 0);

  // q2repro src/refresh/models.c:1691: `gl_gpulerp = Cvar_Get("gl_gpulerp", "1", 0);`
  // -- gates uploading skeletal-lerp work to a vertex shader instead of the
  // CPU; this renderer's alias-model lerping (gl_mesh.ts) is always CPU-side
  // fixed-function, no GPU-lerp path exists -- registered only.
  ri.Cvar_Get("gl_gpulerp", "1", 0);
  // q2repro src/refresh/shader.c:1199: `gl_bloom_sigma = Cvar_Get("gl_bloom_sigma", "8", 0);`
  // -- Gaussian-blur sigma for the bloom pass gl_shader.ts never ported (see
  // gl_bloom above) -- registered only.
  ri.Cvar_Get("gl_bloom_sigma", "8", 0);

  // q2repro src/refresh/debug.c:703/704/706 (GL_InitDebugDraw) and
  // src/refresh/debug_text.c:193 (GL_InitDebugTextLines): client-side
  // rendering of the server's debug-primitive stream (R_AddDebugLine etc.).
  // This port's debug-draw machinery (src/server/sv_debugdraw.ts,
  // src/server/bindings/kex.ts) only builds and forwards that primitive list
  // server-side -- no ref_gl consumer renders it (grepped: no
  // AddDebugLine/ClearDebugLines/GL_InitDebugDraw counterpart anywhere in
  // src/ref_gl). Registered only, so the console commands stop failing.
  // gl_debug_font's C default is `debug_fonts[0].name` (debug_text.c's
  // debug_fonts[] array, first entry `DEBUG_FONT(futural)` -- confirmed by
  // reading that array in q2repro's tree): "futural".
  ri.Cvar_Get("gl_debug_linewidth", "2", 0);
  ri.Cvar_Get("gl_debug_distfrac", "0.004", 0);
  ri.Cvar_Get("gl_debug_text_style", "lines", 0);
  ri.Cvar_Get("gl_debug_font", "futural", 0);

  // q2repro src/refresh/hq2x.c:460-462 (HQ2x_Init): HQ2X texture-upscaling
  // filter thresholds; this renderer has no HQ2X (or any) texture-upscaling
  // pass -- registered only.
  ri.Cvar_Get("hqx_y", "48", CVAR_FILES);
  ri.Cvar_Get("hqx_cb", "7", CVAR_FILES);
  ri.Cvar_Get("hqx_cr", "6", CVAR_FILES);
  // ==========================================================================

  ri.Cmd_AddCommand("imagelist", GL_ImageList_f);
  ri.Cmd_AddCommand("screenshot", GL_ScreenShot_f);
  ri.Cmd_AddCommand("modellist", Mod_Modellist_f);
  ri.Cmd_AddCommand("gl_strings", GL_Strings_f);
}

/*
==================
R_SetMode
==================
*/
function R_SetMode(): boolean {
  if (glCvars.vid_fullscreen && glCvars.vid_fullscreen.modified && !gl_config.allow_cds) {
    ri.Con_Printf(PRINT_ALL, "R_SetMode() - CDS not allowed with this driver\n");
    ri.Cvar_SetValue("vid_fullscreen", glCvars.vid_fullscreen.value ? 0 : 1);
    glCvars.vid_fullscreen.modified = false;
  }

  const fullscreen = glCvars.vid_fullscreen ? glCvars.vid_fullscreen.value !== 0 : false;

  if (glCvars.vid_fullscreen) glCvars.vid_fullscreen.modified = false;
  if (glCvars.gl_mode) glCvars.gl_mode.modified = false;
  if (glCvars.vid_scale) glCvars.vid_scale.modified = false;

  const modeValue = glCvars.gl_mode ? glCvars.gl_mode.value : 0;
  let result = glimp.SetMode(vid.width, vid.height, modeValue, fullscreen);

  if (result.rserr === RserrT.rserr_ok) {
    vid.width = result.width;
    vid.height = result.height;
    gl_state.prev_mode = modeValue;
  } else {
    if (result.rserr === RserrT.rserr_invalid_fullscreen) {
      ri.Cvar_SetValue("vid_fullscreen", 0);
      if (glCvars.vid_fullscreen) glCvars.vid_fullscreen.modified = false;
      ri.Con_Printf(PRINT_ALL, "ref_gl::R_SetMode() - fullscreen unavailable in this mode\n");
      result = glimp.SetMode(vid.width, vid.height, modeValue, false);
      if (result.rserr === RserrT.rserr_ok) {
        vid.width = result.width;
        vid.height = result.height;
        return true;
      }
    } else if (result.rserr === RserrT.rserr_invalid_mode) {
      ri.Cvar_SetValue("gl_mode", gl_state.prev_mode);
      if (glCvars.gl_mode) glCvars.gl_mode.modified = false;
      ri.Con_Printf(PRINT_ALL, "ref_gl::R_SetMode() - invalid mode\n");
    }

    // try setting it back to something safe
    result = glimp.SetMode(vid.width, vid.height, gl_state.prev_mode, false);
    if (result.rserr !== RserrT.rserr_ok) {
      ri.Con_Printf(PRINT_ALL, "ref_gl::R_SetMode() - could not revert to safe mode\n");
      return false;
    }
    vid.width = result.width;
    vid.height = result.height;
  }
  return true;
}

function qglGetStringSafe(name: number): string {
  const ptr = qgl.qglGetString(name);
  return ptr ? new CString(ptr).toString() : "";
}

/*
===============
R_Init
===============
*/
export function R_Init(hInstance: unknown, wndProc: unknown): boolean {
  R_ScaleTurbsinForRInit(); // for (j=0;j<256;j++) r_turbsin[j] *= 0.5;

  ri.Con_Printf(PRINT_ALL, `ref_gl version: ${REF_VERSION}\n`);

  Draw_GetPalette();

  R_Register();

  // initialize our QGL dynamic bindings; extension entry points resolve
  // through the platform's GetProcAddress (glX/wgl equivalent) when the
  // GLimp provides one. This first resolution runs before any GL context
  // exists (R_SetMode/glimp.SetMode below is what actually creates one) --
  // it exists only so glimp.ts's GLimp_SetMode has a `qgl` to call into for
  // its own internal render-scale (vid_scale) framebuffer setup, which runs
  // synchronously as part of context creation itself. A getProcAddress call
  // made with no GL context ever having existed in this process cannot
  // reliably resolve entry points beyond core GL 1.1 on every driver (see
  // the re-resolution below for the citation and the bug this produced).
  try {
    SetQGL(loadQGLFromSystem(glimp.GetProcAddress));
  } catch {
    ri.Con_Printf(PRINT_ALL, `ref_gl::R_Init() - could not load "${glCvars.gl_driver ? glCvars.gl_driver.string : ""}"\n`);
    return false;
  }

  // initialize OS-specific parts of OpenGL
  if (!glimp.Init(hInstance, wndProc)) {
    return false;
  }

  // set our "safe" modes
  gl_state.prev_mode = 3;

  // create the window and set up the context
  if (!R_SetMode()) {
    ri.Con_Printf(PRINT_ALL, "ref_gl::R_Init() - could not R_SetMode()\n");
    return false;
  }

  // Re-resolve QGL now that a context genuinely exists and is current
  // (glimp.SetMode's SDL_GL_CreateContext call just above makes the new
  // context current on this thread -- SDL2's own documented behavior).
  // q2repro's src/refresh/main.c:1396-1400 (R_Init) calls `vid->init()`
  // (creates the context) strictly BEFORE `QGL_Init()` (resolves function
  // pointers) for exactly this reason: SDL_GL_GetProcAddress/
  // glXGetProcAddressARB/wglGetProcAddress are only guaranteed to resolve
  // extension and GL2+ program-object entry points (glCreateShader,
  // glCreateProgram, ...) once some context has been made current --
  // undefined/unreliable before that (GLX_ARB_get_proc_address /
  // WGL_ARB_extensions_string). The earlier resolution above runs BEFORE
  // R_SetMode ever creates a context (needed only for glimp.ts's own
  // internal vid_scale FBO setup, which happens synchronously inside
  // GLimp_SetMode) and was the root cause of a real, reproduced bug: on the
  // very first GL context of a process (cold boot straight into vid_ref
  // "gl"), `resolveGLShaderAPI` in qgl.ts got a null glCreateShader/
  // glCreateProgram from the getProcAddress path with no context ever
  // having existed, so GL_InitShaderPath (below) always printed "gl_shaders:
  // program objects unavailable on this context, falling back to
  // fixed-function" and forced gl_shaders to 0 even on capable hardware
  // (confirmed RTX 3090 / GL 4.6). A subsequent vid_restart worked only
  // because some context had already existed once earlier in the process by
  // then -- a driver-dependent side effect, not something this port should
  // rely on. This second, authoritative resolution makes the fix
  // unconditional instead of accidental: GL_InitShaderPath and the
  // GL_VENDOR/GL_RENDERER/GL_VERSION queries below always see a `qgl` built
  // against a context that is actually current at that exact moment, cold
  // boot or restart alike.
  try {
    SetQGL(loadQGLFromSystem(glimp.GetProcAddress));
  } catch {
    ri.Con_Printf(PRINT_ALL, `ref_gl::R_Init() - could not load "${glCvars.gl_driver ? glCvars.gl_driver.string : ""}"\n`);
    return false;
  }

  ri.Vid_MenuInit();

  /*
  ** get our various GL strings
  */
  gl_config.vendor_string = qglGetStringSafe(GL_VENDOR);
  ri.Con_Printf(PRINT_ALL, `GL_VENDOR: ${gl_config.vendor_string}\n`);
  gl_config.renderer_string = qglGetStringSafe(GL_RENDERER);
  ri.Con_Printf(PRINT_ALL, `GL_RENDERER: ${gl_config.renderer_string}\n`);
  gl_config.version_string = qglGetStringSafe(GL_VERSION);
  ri.Con_Printf(PRINT_ALL, `GL_VERSION: ${gl_config.version_string}\n`);
  // q2repro (src/refresh/qgl.c QGL_Init, ~line 585) never prints the raw
  // GL_EXTENSIONS string at normal verbosity: vendor/renderer/version/
  // extension-loaded lines are all Com_DPrintf (developer-only), and the
  // full extension list is only shown on request via the "strings" console
  // command. Match that: keep vendor/renderer/version at PRINT_ALL above,
  // but drop the extension dump to PRINT_DEVELOPER.
  gl_config.extensions_string = qglGetStringSafe(GL_EXTENSIONS);
  ri.Con_Printf(PRINT_DEVELOPER, `GL_EXTENSIONS: ${gl_config.extensions_string}\n`);

  const rendererLower = gl_config.renderer_string.toLowerCase();
  const vendorLower = gl_config.vendor_string.toLowerCase();

  if (rendererLower.includes("voodoo")) {
    gl_config.renderer = rendererLower.includes("rush") ? GL_RENDERER_VOODOO_RUSH : GL_RENDERER_VOODOO;
  } else if (vendorLower.includes("sgi")) {
    gl_config.renderer = GL_RENDERER_SGI;
  } else if (rendererLower.includes("permedia")) {
    gl_config.renderer = GL_RENDERER_PERMEDIA2;
  } else if (rendererLower.includes("glint")) {
    gl_config.renderer = GL_RENDERER_GLINT_MX;
  } else if (rendererLower.includes("glzicd")) {
    gl_config.renderer = GL_RENDERER_REALIZM;
  } else if (rendererLower.includes("gdi")) {
    gl_config.renderer = GL_RENDERER_MCD;
  } else if (rendererLower.includes("pcx2")) {
    gl_config.renderer = GL_RENDERER_PCX2;
  } else if (rendererLower.includes("verite")) {
    gl_config.renderer = GL_RENDERER_RENDITION;
  } else {
    gl_config.renderer = GL_RENDERER_OTHER;
  }

  const monolightmap = glCvars.gl_monolightmap;
  if (!monolightmap || monolightmap.string.charAt(1).toUpperCase() !== "F") {
    if (gl_config.renderer === GL_RENDERER_PERMEDIA2) {
      ri.Cvar_Set("gl_monolightmap", "A");
      ri.Con_Printf(PRINT_ALL, "...using gl_monolightmap 'a'\n");
    } else if (gl_config.renderer & GL_RENDERER_POWERVR) {
      ri.Cvar_Set("gl_monolightmap", "0");
    } else {
      ri.Cvar_Set("gl_monolightmap", "0");
    }
  }

  // power vr can't have anything stay in the framebuffer, so
  // the screen needs to redraw the tiled background every frame
  if (gl_config.renderer & GL_RENDERER_POWERVR) {
    ri.Cvar_Set("scr_drawall", "1");
  } else {
    ri.Cvar_Set("scr_drawall", "0");
  }

  // MCD has buffering issues
  if (gl_config.renderer === GL_RENDERER_MCD) {
    ri.Cvar_SetValue("gl_finish", 1);
  }

  if (gl_config.renderer & GL_RENDERER_3DLABS) {
    gl_config.allow_cds = !(glCvars.gl_3dlabs_broken && glCvars.gl_3dlabs_broken.value);
  } else {
    gl_config.allow_cds = true;
  }

  if (gl_config.allow_cds) ri.Con_Printf(PRINT_ALL, "...allowing CDS\n");
  else ri.Con_Printf(PRINT_ALL, "...disabling CDS\n");

  // Vanilla gl_rmain.c:1247-1321's extension gate, previously dropped here
  // as "#ifdef WIN32 probing". Dropping it was a REAL porting bug, found
  // live 2026-08-31: vanilla only keeps an extension pointer when the
  // driver ADVERTISES the extension in GL_EXTENSIONS (strstr) AND the
  // matching cvar allows it; this port's loadQGLFromSystem resolves every
  // symbol unconditionally, and modern NVIDIA exports glColorTableEXT
  // without supporting GL_EXT_paletted_texture -- so once bc99622 made
  // first-context resolution actually work, the never-advertised paletted
  // upload path activated and every world texture rendered WHITE
  // (headless screenshot forensics: 95% white -> 0.2% with the path off).
  // The gate below nulls exactly the pointers vanilla would never have
  // set, with vanilla's own console lines. WGL_EXT_swap_control stays
  // dropped (Windows-only, no member in this port's QGL).
  {
    const ext = gl_config.extensions_string;
    if (ext.includes("GL_EXT_compiled_vertex_array") || ext.includes("GL_SGI_compiled_vertex_array")) {
      ri.Con_Printf(PRINT_ALL, "...enabling GL_EXT_compiled_vertex_array\n");
    } else {
      ri.Con_Printf(PRINT_ALL, "...GL_EXT_compiled_vertex_array not found\n");
      qgl.qglLockArraysEXT = null;
      qgl.qglUnlockArraysEXT = null;
    }

    if (ext.includes("GL_EXT_point_parameters")) {
      if (glCvars.gl_ext_pointparameters && glCvars.gl_ext_pointparameters.value) {
        ri.Con_Printf(PRINT_ALL, "...using GL_EXT_point_parameters\n");
      } else {
        ri.Con_Printf(PRINT_ALL, "...ignoring GL_EXT_point_parameters\n");
        qgl.qglPointParameterfEXT = null;
        qgl.qglPointParameterfvEXT = null;
      }
    } else {
      ri.Con_Printf(PRINT_ALL, "...GL_EXT_point_parameters not found\n");
      qgl.qglPointParameterfEXT = null;
      qgl.qglPointParameterfvEXT = null;
    }

    if (ext.includes("GL_EXT_paletted_texture") && ext.includes("GL_EXT_shared_texture_palette")) {
      if (glCvars.gl_ext_palettedtexture && glCvars.gl_ext_palettedtexture.value) {
        ri.Con_Printf(PRINT_ALL, "...using GL_EXT_shared_texture_palette\n");
      } else {
        ri.Con_Printf(PRINT_ALL, "...ignoring GL_EXT_shared_texture_palette\n");
        qgl.qglColorTableEXT = null;
      }
    } else {
      ri.Con_Printf(PRINT_ALL, "...GL_EXT_shared_texture_palette not found\n");
      qgl.qglColorTableEXT = null;
    }

    if (ext.includes("GL_SGIS_multitexture")) {
      if (glCvars.gl_ext_multitexture && glCvars.gl_ext_multitexture.value) {
        ri.Con_Printf(PRINT_ALL, "...using GL_SGIS_multitexture\n");
      } else {
        ri.Con_Printf(PRINT_ALL, "...ignoring GL_SGIS_multitexture\n");
        qgl.qglMTexCoord2fSGIS = null;
        qgl.qglSelectTextureSGIS = null;
      }
    } else {
      ri.Con_Printf(PRINT_ALL, "...GL_SGIS_multitexture not found\n");
      qgl.qglMTexCoord2fSGIS = null;
      qgl.qglSelectTextureSGIS = null;
    }
  }

  GL_SetDefaultState();

  // #if 0 GL_DrawStereoPattern() dropped -- see file header comment.

  GL_InitImages();
  Mod_Init();
  R_InitParticleTexture();
  Draw_InitLocal();

  // task #25 (v1.1.0): try the GL2+ per-pixel-lighting shader path. Never
  // fails R_Init either way -- GL_InitShaderPath falls back to
  // fixed-function internally (see that function's header comment) and the
  // fixed-function path above has already fully initialized regardless of
  // its outcome.
  GL_InitShaderPath();

  // v1.1.0 shadow maps -- strictly after GL_InitShaderPath, because a
  // context that fell back to fixed-function has no lighting shader to
  // sample a depth atlas from and should not be handed a 2048x2048 depth
  // texture it will never read. Same never-fails-R_Init contract.
  if (GL_UsingShaderPath()) GL_InitShadowMaps();

  const err = qgl.qglGetError();
  if (err !== GL_NO_ERROR) {
    ri.Con_Printf(PRINT_ALL, `glGetError() = 0x${err.toString(16)}\n`);
  }

  return true;
}

/*
===============
R_Shutdown
===============
*/
export function R_Shutdown(): void {
  ri.Cmd_RemoveCommand("modellist");
  ri.Cmd_RemoveCommand("screenshot");
  ri.Cmd_RemoveCommand("imagelist");
  ri.Cmd_RemoveCommand("gl_strings");

  GL_ShutdownShadowMaps();
  GL_ShutdownShaderPath();

  Mod_FreeAll();

  GL_ShutdownImages();

  /*
  ** shut down OS specific OpenGL stuff like contexts, etc.
  */
  glimp.Shutdown();

  /*
  ** shutdown our QGL subsystem
  */
  QGL_Shutdown();
}

/*
@@@@@@@@@@@@@@@@@@@@@
R_BeginFrame
@@@@@@@@@@@@@@@@@@@@@
*/
export function R_BeginFrame(camera_separation: number): void {
  gl_state.camera_separation = camera_separation;

  /*
  ** change modes if necessary
  */
  if ((glCvars.gl_mode && glCvars.gl_mode.modified) || (glCvars.vid_fullscreen && glCvars.vid_fullscreen.modified) || (glCvars.vid_scale && glCvars.vid_scale.modified)) {
    // FIXME: only restart if CDS is required
    const ref = ri.Cvar_Get("vid_ref", "gl", 0);
    if (ref) ref.modified = true;
  }

  if (glCvars.gl_log && glCvars.gl_log.modified) {
    glimp.EnableLogging(glCvars.gl_log.value !== 0);
    glCvars.gl_log.modified = false;
  }

  if (glCvars.gl_log && glCvars.gl_log.value) {
    glimp.LogNewFrame();
  }

  /*
  ** update 3Dfx gamma -- it is expected that a user will do a vid_restart
  ** after tweaking this value
  */
  if (glCvars.vid_gamma && glCvars.vid_gamma.modified) {
    glCvars.vid_gamma.modified = false;

    if (gl_config.renderer & GL_RENDERER_VOODOO) {
      const g = 2.0 * (0.8 - (glCvars.vid_gamma.value - 0.5)) + 1.0;
      // putenv() -- process.env mutation is this port's portable equivalent
      // (real, always-compiled engine behavior, not an ifdef'd branch).
      process.env.SSTV2_GAMMA = String(g);
      process.env.SST_GAMMA = String(g);
    }
  }

  glimp.BeginFrame(camera_separation);

  /*
  ** go into 2D mode
  */
  qgl.qglViewport(0, 0, vid.width, vid.height);
  qgl.qglMatrixMode(GL_PROJECTION);
  qgl.qglLoadIdentity();
  qgl.qglOrtho(0, vid.width, vid.height, 0, -99999, 99999);
  qgl.qglMatrixMode(GL_MODELVIEW);
  qgl.qglLoadIdentity();
  qgl.qglDisable(GL_DEPTH_TEST);
  qgl.qglDisable(GL_CULL_FACE);
  qgl.qglDisable(GL_BLEND);
  qgl.qglEnable(GL_ALPHA_TEST);
  qgl.qglColor4f(1, 1, 1, 1);

  /*
  ** draw buffer stuff
  */
  if (glCvars.gl_drawbuffer && glCvars.gl_drawbuffer.modified) {
    glCvars.gl_drawbuffer.modified = false;

    if (gl_state.camera_separation === 0 || !gl_state.stereo_enabled) {
      if (Q_stricmp(glCvars.gl_drawbuffer.string, "GL_FRONT") === 0) qgl.qglDrawBuffer(GL_FRONT);
      else qgl.qglDrawBuffer(GL_BACK);
    }
  }

  /*
  ** texturemode stuff
  */
  if (glCvars.gl_texturemode && glCvars.gl_texturemode.modified) {
    GL_TextureMode(glCvars.gl_texturemode.string);
    glCvars.gl_texturemode.modified = false;
  }

  if (glCvars.gl_texturealphamode && glCvars.gl_texturealphamode.modified) {
    GL_TextureAlphaMode(glCvars.gl_texturealphamode.string);
    glCvars.gl_texturealphamode.modified = false;
  }

  if (glCvars.gl_texturesolidmode && glCvars.gl_texturesolidmode.modified) {
    GL_TextureSolidMode(glCvars.gl_texturesolidmode.string);
    glCvars.gl_texturesolidmode.modified = false;
  }

  /*
  ** swapinterval stuff
  */
  GL_UpdateSwapInterval();

  //
  // clear screen if desired
  //
  R_Clear();
}

/*
=============
R_SetPalette
=============
*/
export function R_SetPalette(palette: Uint8Array | null): void {
  const rp = new Uint8Array(256 * 4);

  if (palette) {
    for (let i = 0; i < 256; i++) {
      rp[i * 4 + 0] = palette[i * 3 + 0];
      rp[i * 4 + 1] = palette[i * 3 + 1];
      rp[i * 4 + 2] = palette[i * 3 + 2];
      rp[i * 4 + 3] = 0xff;
    }
  } else {
    for (let i = 0; i < 256; i++) {
      rp[i * 4 + 0] = d_8to24table[i] & 0xff;
      rp[i * 4 + 1] = (d_8to24table[i] >>> 8) & 0xff;
      rp[i * 4 + 2] = (d_8to24table[i] >>> 16) & 0xff;
      rp[i * 4 + 3] = 0xff;
    }
  }

  const rpAsUint32 = new Uint32Array(rp.buffer);
  SetRawPalette(rpAsUint32);
  GL_SetTexturePalette(rpAsUint32);

  qgl.qglClearColor(0, 0, 0, 0);
  qgl.qglClear(GL_COLOR_BUFFER_BIT);
  qgl.qglClearColor(1, 0, 0.5, 0.5);
}

/*
** R_DrawBeam
*/
const NUM_BEAM_SEGS = 6;

export function R_DrawBeam(e: EntityT): void {
  const oldorigin = vec3(e.oldorigin[0], e.oldorigin[1], e.oldorigin[2]);
  const origin = vec3(e.origin[0], e.origin[1], e.origin[2]);

  const direction = vec3(oldorigin[0] - origin[0], oldorigin[1] - origin[1], oldorigin[2] - origin[2]);
  const normalized_direction = vec3(direction[0], direction[1], direction[2]);

  if (VectorNormalize(normalized_direction) === 0) return;

  const perpvec = vec3();
  PerpendicularVector(perpvec, normalized_direction);
  VectorScale(perpvec, e.frame / 2, perpvec);

  const start_points: Vec3[] = [];
  const end_points: Vec3[] = [];

  for (let i = 0; i < NUM_BEAM_SEGS; i++) {
    const sp = vec3();
    RotatePointAroundVector(sp, normalized_direction, perpvec, (360.0 / NUM_BEAM_SEGS) * i);
    sp[0] += origin[0];
    sp[1] += origin[1];
    sp[2] += origin[2];
    start_points.push(sp);
    end_points.push(vec3(sp[0] + direction[0], sp[1] + direction[1], sp[2] + direction[2]));
  }

  qgl.qglDisable(GL_TEXTURE_2D);
  qgl.qglEnable(GL_BLEND);
  qgl.qglDepthMask(false);

  const packed = d_8to24table[e.skinnum & 0xff];
  let r = packed & 0xff;
  let g = (packed >>> 8) & 0xff;
  let b = (packed >>> 16) & 0xff;

  r *= 1 / 255.0;
  g *= 1 / 255.0;
  b *= 1 / 255.0;

  qgl.qglColor4f(r, g, b, e.alpha);

  qgl.qglBegin(GL_TRIANGLE_STRIP);
  for (let i = 0; i < NUM_BEAM_SEGS; i++) {
    qgl.qglVertex3fv(start_points[i]);
    qgl.qglVertex3fv(end_points[i]);
    qgl.qglVertex3fv(start_points[(i + 1) % NUM_BEAM_SEGS]);
    qgl.qglVertex3fv(end_points[(i + 1) % NUM_BEAM_SEGS]);
  }
  qgl.qglEnd();

  qgl.qglEnable(GL_TEXTURE_2D);
  qgl.qglDisable(GL_BLEND);
  qgl.qglDepthMask(true);
}

//===================================================================

/*
@@@@@@@@@@@@@@@@@@@@@
GetRefAPI

@@@@@@@@@@@@@@@@@@@@@
*/
export function GetRefAPI(imp: RefImports): RefExports {
  SetRefImports(imp);

  return {
    api_version: API_VERSION,

    Init: (hinstance: unknown, wndproc: unknown) => R_Init(hinstance, wndproc),
    Shutdown: () => R_Shutdown(),

    BeginRegistration: (map: string) => {
      // Drop every cached depth map before the new world's surfaces load:
      // the cache is keyed on light parameters only, so two maps whose
      // lights happen to match would otherwise share stale depth texels.
      // Hooked here rather than inside gl_model.ts's R_BeginRegistration
      // because gl_shadowmap.ts already imports gl_model.ts for MsurfaceT/
      // GlpolyT, and the reverse import would close a cycle.
      GL_ShadowMapsNewMap();
      R_BeginRegistration(map);
    },
    RegisterModel: (name: string) => R_RegisterModel(name),
    RegisterSkin: (name: string) => R_RegisterSkin(name),
    RegisterPic: (name: string) => Draw_FindPic(name),
    RegisterRawPic: (name: string, pixels: Uint8Array, width: number, height: number) => (width <= 0 || height <= 0 ? null : GL_LoadPic(name, pixels, width, height, ImagetypeT.it_pic, 32)),
    SetSky: (name: string, rotate: number, axis: Vec3) => R_SetSky(name, rotate, axis),
    EndRegistration: () => R_EndRegistration(),

    RenderFrame: (fd) => R_RenderFrame(fd),

    SupportsPerPixelLighting: () => GL_UsingShaderPath(),

    DrawGetPicSize: (name: string) => Draw_GetPicSize(name),
    DrawPic: (x: number, y: number, name: string) => Draw_Pic(x, y, name),
    DrawStretchPic: (x: number, y: number, w: number, h: number, name: string) => Draw_StretchPic(x, y, w, h, name),
    DrawColorPic: (x: number, y: number, w: number, h: number, name: string, color: DrawColorT) => Draw_ColorPic(x, y, w, h, name, color),
    DrawStretchPicRegion: (x: number, y: number, w: number, h: number, name: string, srcX: number, srcY: number, srcW: number, srcH: number, color: DrawColorT) =>
      Draw_StretchPicRegion(x, y, w, h, name, srcX, srcY, srcW, srcH, color),
    DrawChar: (x: number, y: number, c: number) => Draw_Char(x, y, c),
    DrawTileClear: (x: number, y: number, w: number, h: number, name: string) => Draw_TileClear(x, y, w, h, name),
    DrawFill: (x: number, y: number, w: number, h: number, c: number) => Draw_Fill(x, y, w, h, c),
    DrawFadeScreen: () => Draw_FadeScreen(),

    DrawStretchRaw: (x: number, y: number, w: number, h: number, cols: number, rows: number, data: Uint8Array) => Draw_StretchRaw(x, y, w, h, cols, rows, data),

    CinematicSetPalette: (palette) => R_SetPalette(palette),
    SetGifBeatSeconds: (seconds: number) => SetGifBeatSeconds(seconds),
    BeginFrame: (camera_separation) => R_BeginFrame(camera_separation),
    EndFrame: () => glimp.EndFrame(),

    AppActivate: (activate: boolean) => glimp.AppActivate(activate),
  };
}
