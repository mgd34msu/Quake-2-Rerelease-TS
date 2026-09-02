// gl_shadowmap.ts -- v1.1.0 headline #2: real shadow MAP rendering for the
// kex family's shadow lights, layered on task #25's shader path
// (gl_shader.ts). No .c analog in the original id Software source, and --
// unlike task #25 -- no analog in q2repro either.
//
// ── Reference ruling (investigated for this unit) ──────────────────────────
// q2repro has NO shadow mapping of any kind. Its src/refresh/shader.c
// calc_dynamic_lights() (shader.c:149-179) is a pure UNOCCLUDED lambert +
// radius falloff + cone term; light passes straight through walls. Its only
// FBOs are the bloom/scene post-process chain (texture.c:1208-1230), never
// bound from a light's point of view, and its only "shadow" is the classic
// planar projected blob under alias models (mesh.c:461-520, cvar
// gl_shadows). Telling detail: q2repro parses `resolution` out of the
// CS_SHADOWLIGHTS configstring (precache.c:576) and then never reads it
// anywhere -- there is no shadow-map render target for it to size. The
// rerelease game source likewise only PRODUCES the field
// (`shadowlightresolution`, g_spawn.cpp:826); the engine that consumes it is
// KEX's own, which is closed. So there is no reference implementation to
// mirror here and none is cited: the technique below is ordinary GL2-era
// shadow mapping, chosen to fit this renderer's existing architecture.
//
// ── Scope ──────────────────────────────────────────────────────────────────
// Both shadow-light kinds and both caster kinds:
//
//   * CONE/SPOT lights -- a light whose `target` resolves to another entity's
//     `targetname` (g_misc.ts's setup_shadow_lights) -- get one square
//     perspective depth map, as they have since v1.1.0.
//   * POINT/OMNI lights -- every shadow light that resolves no target -- get
//     six 90-degree faces packed as a 3x2 grid of squares inside ONE atlas
//     rectangle. See "Why cube FACES in the 2D atlas" below.
//   * CASTERS are the static world (BSP) brush geometry plus alias-model
//     entities (players, monsters, gibs, items) and inline brush-model
//     entities (doors, platforms, every func_* mover). shadowCasterKind below
//     names what is deliberately excluded and why.
//
// ── Why cube FACES in the 2D atlas, not a cube map or a paraboloid ─────────
// A GL_TEXTURE_CUBE_MAP depth target would need its own samplerCube and its
// own texture unit, and -- being a separate texture -- could share neither
// the shelf-packed atlas, the single FBO, nor the depth-map cache the cone
// path already has. The fragment loop would then have to pick between a
// sampler2D and a samplerCube per light, which under GLSL 1.10 means indexing
// a sampler array by a non-constant expression: exactly the restriction that
// produced the single-atlas design in the first place.
//
// Dual-paraboloid and octahedral encodings avoid the second sampler, but both
// bend straight edges: they are only correct where the geometry is tessellated
// finely enough for the per-vertex warp to approximate the true mapping. Quake
// 2 BSP faces are single very large polygons (a room's whole floor is often
// one quad), so either encoding would need a tessellation stage this renderer
// does not have, and would curve every shadow edge in the meantime.
//
// Six 90-degree perspective faces keep rasterization exactly as linear as the
// cone path's, reuse every piece of machinery above, and need NO per-face
// matrix in the shader: a square 90-degree perspective has tan(45) == 1, so
// the face UV is just (dot(L,right), dot(L,up)) / dot(L,forward) and the
// stored window depth inverts to a distance in closed form. A point light is
// therefore read from the SAME uniforms a cone light uses -- u_light_pos,
// u_light_radius and u_light_atlas -- with u_light_shadow carrying a kind
// code (0 none / 1 cone / 2 point) where it used to carry a flag.
//
// ── Cost, and why the cache survives moving entities ───────────────────────
// A light's depth map is rebuilt only when its own parameters change OR when
// the set of entity casters standing inside its radius changes shape (see
// shadowSignature). A room whose only casters are still -- an idle monster,
// a closed door -- keeps rendering zero depth passes per frame, exactly as
// before this unit. A light with a walking monster in range rebuilds every
// frame it moves, which for a point light is six faces.
//
// ── The rules, in full ─────────────────────────────────────────────────────
// Written out because the two shadow techniques in this renderer have to
// agree about who draws what, and because a play-test found them both
// drawing at once.
//
// 1. WHO CASTS. Every alias-model entity (players, monsters, corpses, gibs,
//    items) and every inline brush model, plus the static world. Life and
//    death make no difference: a dead monster and its gibs are alias
//    entities like any other, and shadowCasterKind excludes them for none
//    of its reasons. The exclusions are exactly RF_BEAM / RF_FLARE (no
//    geometry), RF_TRANSLUCENT (you can see through it), RF_NOSHADOW (the
//    rerelease's own opt-out), RF_WEAPONMODEL / RF_DEPTHHACK (the view
//    weapon is not in the world), and sprites (no stable silhouette).
//
// 2. WHO RECEIVES. World BSP surfaces only, because the shadow test lives in
//    gl_shader.ts's world-surface program and alias models are drawn through
//    the fixed-function path with R_LightPoint colours. A monster standing
//    inside another caster's shadow is therefore still lit by that light.
//    Stated as a limit, not a defect to hide: making models receivers needs
//    a shadow-sampling entity-mesh program, which is a separate change.
//
// 3. WHICH LIGHT. Only CS_SHADOWLIGHTS-fed lights (DlightT.isShadowLight)
//    and cone lights get a depth map -- see R_RenderShadowMaps. A classic
//    transient dlight (muzzle flash, rocket trail, blaster glow) has never
//    cast a shadow in any Quake 2 and does not start here. There is no sun.
//
// 4. WHICH VOLUME. A cone light gets one perspective frustum aimed down its
//    cone, with SHADOW_FOV_MARGIN slack and far = shadowCubeFar(intensity);
//    a point light gets six 90-degree faces covering everything within the
//    same far distance. Neither is an orthographic fit around the casters:
//    the light's own radius IS the volume, which is what keeps a depth map
//    cacheable across frames while casters move inside it.
//
// 5. PLANAR SHADOW INTERACTION (gl_shadows). id's 1997 projected decal
//    (gl_mesh.ts's GL_DrawAliasShadow) and this file are mutually exclusive.
//    When GL_ShadowMapsActive() is true the decal does not draw at all --
//    not dimmed, not offset, not drawn. When it is false (gl_shadowmaps 0,
//    or gl_shaders 0, or a context with no framebuffer objects) the decal is
//    available under its own cvar and renders exactly what id shipped, which
//    since gl_rmain.ts's default is back to "0" means: off unless asked for.
//    Turning shadow mapping off in the Video menu therefore removes every
//    shadow this engine draws, in the same session, with no vid_restart.
//
// 6. gl_shaders 0. There is no shadow mapping at all: nothing sampling the
//    atlas exists, so R_RenderShadowMaps never allocates it and
//    GL_ShadowMapsActive() is false regardless of gl_shadowmaps. The Video
//    menu greys both shadow rows and says "requires gl_shaders 1" rather
//    than letting the player set a value that does nothing.
//
// 7. ORDER WITHIN THE FRAME. The atlas is fully rendered and the framebuffer
//    binding restored before R_DrawWorld samples it, and long before
//    gl_fog.ts's screen-space pass reads the scene depth buffer at the end
//    of the frame -- the two never share a bound framebuffer.
//
// ── Why a single atlas and not one FBO per light ───────────────────────────
// GLSL 1.10 only guarantees sampler array indexing by a constant-index-
// expression, so `uniform sampler2D u_shadow[8]` indexed by the fragment
// loop's counter is not portable. One atlas texture sampled through per-light
// (offset, scale) rectangles needs exactly one sampler and one texture unit,
// and allocates its FBO once for the process rather than once per light.

import { qgl } from "./gl_image";
import { ri, glCvars, r_world_matrix } from "./gl_local";
import { type Vec3, vec3, AngleVectors } from "../shared/math";
import {
  PRINT_ALL,
  RF_BEAM,
  RF_FLARE,
  RF_TRANSLUCENT,
  RF_NOSHADOW,
  RF_WEAPONMODEL,
  RF_DEPTHHACK,
  SURF_TRANS33,
  SURF_TRANS66,
} from "../shared/q_shared";
import { type DlightT, type EntityT } from "../client/ref";
import { ModelT, ModtypeT, ParsedMd2T, type MsurfaceT, type GlpolyT, SURF_DRAWSKY, SURF_DRAWTURB } from "./gl_model";
import { type Md5ModelT, calcSkelVert, getSkeletonFrame } from "../qcommon/md5_model";

const GL_DEPTH_COMPONENT24 = 0x81a6;
const GL_DEPTH_COMPONENT = 0x1902;
const GL_FLOAT = 0x1406;
const GL_TEXTURE_2D = 0x0de1;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_NEAREST = 0x2600;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_FRAMEBUFFER = 0x8d40;
const GL_FRAMEBUFFER_BINDING = 0x8ca6;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;
const GL_DEPTH_ATTACHMENT = 0x8d00;
const GL_NONE = 0;
const GL_DEPTH_BUFFER_BIT = 0x00000100;
const GL_SCISSOR_TEST = 0x0c11;
const GL_CULL_FACE = 0x0b44;
const GL_POLYGON_OFFSET_FILL = 0x8037;
const GL_PROJECTION = 0x1701;
const GL_MODELVIEW = 0x1700;
const GL_POLYGON = 0x0009;
const GL_BLEND = 0x0be2;
const GL_ALPHA_TEST = 0x0bc0;
const GL_DEPTH_TEST = 0x0b71;
const GL_LEQUAL = 0x0203;
const GL_DEPTH_FUNC = 0x0b74;
const GL_DEPTH_RANGE = 0x0b70;
const GL_TRIANGLES = 0x0004;
const GL_TRIANGLE_FAN = 0x0006;
const GL_TRIANGLE_STRIP = 0x0005;

// One shadow map per shader light slot (gl_shader.ts's MAX_SHADER_LIGHTS).
// Kept equal so a light's shadow index is simply its light index -- no
// indirection array, which GLSL 1.10 would make awkward to index anyway.
export const MAX_SHADOW_MAPS = 8;

// Atlas edge, in texels. 2048 holds 8 cone lights at the 512 that 435 of the
// 462 resolution-carrying shipped shadow lights actually ask for, with room
// for the 1024s (23 of them) via the shelf packer below.
export const SHADOW_ATLAS_SIZE = 2048;

// The shipped content asks for 512 (x435), 1024 (x23), 2048 (x3) and 356
// (x1); 463 of 925 shadow lights carry no shadowlightresolution key at all.
// 512 is the default those take -- the same value q2repro hardcodes for its
// synthetic flashlight light (entities.c:860).
export const SHADOW_RES_DEFAULT = 512;
export const SHADOW_RES_MIN = 128;
export const SHADOW_RES_MAX = 1024;

// A point light's six faces are laid out inside ONE atlas rectangle as a
// 3-wide, 2-tall grid: face f occupies cell (f % 3, floor(f / 3)). One
// rectangle rather than six independent square slots is what keeps the
// per-light shader state at the single vec4 the cone path already uploads.
export const SHADOW_CUBE_COLS = 3;
export const SHADOW_CUBE_ROWS = 2;
export const SHADOW_CUBE_FACES = SHADOW_CUBE_COLS * SHADOW_CUBE_ROWS;

// The value gl_shader.ts's fragment loop reads out of u_light_shadow[i].
// It used to be a 0/1 flag; a third state was cheaper than a second array.
export const SHADOW_KIND_NONE = 0;
export const SHADOW_KIND_CONE = 1;
export const SHADOW_KIND_POINT = 2;

/*
====================
shadowMapResolution

Clamps a light's `shadowlightresolution` to a power of two this atlas can
actually hand out. 0 (the field absent from the entity) means "use the
default", not "no shadow". The 2048 that three shipped lights ask for
exceeds SHADOW_RES_MAX and clamps down rather than being refused -- a
slightly softer shadow is the right answer there, not no shadow.
====================
*/
export function shadowMapResolution(requested: number, cap: number = SHADOW_RES_MAX): number {
  const wanted = requested > 0 ? requested : SHADOW_RES_DEFAULT;
  // `cap` is the video menu's quality setting (gl_shadowmap_res). It only
  // ever lowers a light's own request -- SHADOW_RES_MAX stays the hard
  // ceiling, so a bad cvar value can never ask the atlas for more than it
  // can hand out.
  const ceiling = Math.min(cap > 0 ? cap : SHADOW_RES_MAX, SHADOW_RES_MAX);
  const clamped = Math.min(Math.max(wanted, SHADOW_RES_MIN), Math.max(ceiling, SHADOW_RES_MIN));
  // round DOWN to a power of two (356 -> 256), so a cell always tiles the
  // atlas evenly and the shelf packer never leaves an unusable sliver
  let pow = SHADOW_RES_MIN;
  while (pow * 2 <= clamped) pow *= 2;
  return pow;
}

export interface AtlasSlotT {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// A packing request. A bare number is the square a cone light asks for; the
// {width, height} form is what a point light's 3x2 face grid needs, and is
// the only reason the packer handles rectangles at all.
export type AtlasRequestT = number | { readonly width: number; readonly height: number };

function requestExtent(request: AtlasRequestT): { width: number; height: number } {
  if (typeof request === "number") return { width: request, height: request };
  return { width: request.width, height: request.height };
}

/*
====================
packShadowAtlas

Shelf packer: requests are placed left-to-right on a shelf whose height is
the first (largest) request that opened it, and a new shelf starts above when
the current one runs out of width. Callers pass requests already sorted by
descending AREA, which is what makes a shelf packer tight rather than merely
correct. Returns one slot per request, or null for any request that no
longer fits -- that light simply renders unshadowed, never garbage.
====================
*/
export function packShadowAtlas(requests: readonly AtlasRequestT[], atlasSize: number = SHADOW_ATLAS_SIZE): (AtlasSlotT | null)[] {
  const slots: (AtlasSlotT | null)[] = [];
  let shelfY = 0;
  let shelfHeight = 0;
  let cursorX = 0;

  for (const request of requests) {
    const { width, height } = requestExtent(request);
    if (width <= 0 || height <= 0 || width > atlasSize || height > atlasSize) {
      slots.push(null);
      continue;
    }
    if (cursorX + width > atlasSize) {
      // close this shelf, open the next one above it
      shelfY += shelfHeight;
      shelfHeight = 0;
      cursorX = 0;
    }
    if (shelfY + height > atlasSize) {
      slots.push(null); // atlas full
      continue;
    }
    slots.push({ x: cursorX, y: shelfY, width, height });
    cursorX += width;
    if (height > shelfHeight) shelfHeight = height;
  }
  return slots;
}

// --- matrix helpers (GL column-major, m[col*4 + row]) --------------------

export function matrixIdentity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/*
====================
matrixMultiply

Returns a*b in GL's column-major convention, i.e. the matrix that transforms
a column vector v as a*(b*v) -- the same order `glMultMatrixf(b)` after
`glLoadMatrixf(a)` produces.
====================
*/
export function matrixMultiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function matrixTransformPoint(m: Float32Array, p: Vec3): [number, number, number, number] {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
    (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0),
  ];
}

/*
====================
matrixInvertRigid

Inverse of a rotation+translation matrix, by transposing the 3x3 rotation and
re-projecting the translation through it: [R|t]^-1 = [R^T | -R^T t]. Only
valid for a matrix with no scale/shear/projection -- which R_SetupGL's
modelview (three glRotatef calls plus one glTranslatef) always is. Used to
recover eye->world, so the shader can do its light math in world space where
the light positions already live.
====================
*/
export function matrixInvertRigid(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = m[row * 4 + col] ?? 0;
  }
  const tx = m[12] ?? 0;
  const ty = m[13] ?? 0;
  const tz = m[14] ?? 0;
  out[12] = -((out[0] ?? 0) * tx + (out[4] ?? 0) * ty + (out[8] ?? 0) * tz);
  out[13] = -((out[1] ?? 0) * tx + (out[5] ?? 0) * ty + (out[9] ?? 0) * tz);
  out[14] = -((out[2] ?? 0) * tx + (out[6] ?? 0) * ty + (out[10] ?? 0) * tz);
  out[15] = 1;
  return out;
}

/*
====================
matrixLookAt

Right-handed view matrix looking from `eye` along `dir` (which need not be
normalized). Picks a world up axis that is not parallel to `dir` so a light
aimed straight down -- `angle 270`, by far the most common aim in the shipped
content -- doesn't produce a degenerate basis.
====================
*/
export function matrixLookAt(eye: Vec3, dir: Vec3): Float32Array {
  let fx = dir[0];
  let fy = dir[1];
  let fz = dir[2];
  const flen = Math.hypot(fx, fy, fz);
  if (flen < 1e-6) {
    fx = 0;
    fy = 0;
    fz = -1;
  } else {
    fx /= flen;
    fy /= flen;
    fz /= flen;
  }

  // world up is +Z in Quake; swap to +X when the light points (anti)parallel to it
  const upIsZ = Math.abs(fz) < 0.99;
  const ux = upIsZ ? 0 : 1;
  const uy = 0;
  const uz = upIsZ ? 1 : 0;

  // s = f x up, normalized; u = s x f
  let sx = fy * uz - fz * uy;
  let sy = fz * ux - fx * uz;
  let sz = fx * uy - fy * ux;
  const slen = Math.hypot(sx, sy, sz) || 1;
  sx /= slen;
  sy /= slen;
  sz /= slen;

  const vx = sy * fz - sz * fy;
  const vy = sz * fx - sx * fz;
  const vz = sx * fy - sy * fx;

  const m = new Float32Array(16);
  m[0] = sx;
  m[4] = sy;
  m[8] = sz;
  m[1] = vx;
  m[5] = vy;
  m[9] = vz;
  m[2] = -fx;
  m[6] = -fy;
  m[10] = -fz;
  m[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  m[13] = -(vx * eye[0] + vy * eye[1] + vz * eye[2]);
  m[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  m[15] = 1;
  return m;
}

/*
====================
matrixPerspective

Square (aspect 1) symmetric perspective, same form as gluPerspective. The
shadow map is always square, so no aspect parameter is taken.
====================
*/
export function matrixPerspective(fovYDegrees: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovYDegrees * Math.PI) / 360);
  const m = new Float32Array(16);
  m[0] = f;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

// NDC [-1,1] -> texture [0,1]. Folded into the light matrix so the fragment
// shader does one multiply instead of a multiply plus a mad.
export function matrixDepthBias(): Float32Array {
  const m = matrixIdentity();
  m[0] = 0.5;
  m[5] = 0.5;
  m[10] = 0.5;
  m[12] = 0.5;
  m[13] = 0.5;
  m[14] = 0.5;
  return m;
}

// A cone light's shadow frustum has to be WIDER than the cone itself or the
// cone's outer falloff ring samples outside the depth map. 1.15 gives a
// margin without wasting much of the map; the 175-degree ceiling keeps the
// projection from blowing up on the (rare) very wide cones -- the widest in
// shipped content is 75 degrees.
export const SHADOW_FOV_MARGIN = 1.15;

export function shadowFovForConeAngle(coneAngleDegrees: number): number {
  return Math.min(coneAngleDegrees * 2 * SHADOW_FOV_MARGIN, 175);
}

export const SHADOW_NEAR = 4;

/*
====================
shadowLightMatrix

Full world -> shadow-atlas-UV-and-depth transform for one cone light:
bias * projection * view. The caller still has to scale/offset the resulting
xy by the light's atlas rectangle; that part is a per-light vec4 uniform
rather than being folded in here, so the same matrix survives the light
being repacked into a different atlas slot.
====================
*/
export function shadowLightMatrix(origin: Vec3, coneDirection: Vec3, coneAngleDegrees: number, radius: number): Float32Array {
  const view = matrixLookAt(origin, coneDirection);
  const far = Math.max(radius, SHADOW_NEAR * 2);
  const proj = matrixPerspective(shadowFovForConeAngle(coneAngleDegrees), SHADOW_NEAR, far);
  return matrixMultiply(matrixDepthBias(), matrixMultiply(proj, view));
}

// --- omnidirectional (cube-face) light math ------------------------------

export interface CubeFaceBasisT {
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

/*
====================
CUBE_FACE_BASIS

The six face bases, in the atlas's 3x2 cell order: +X, -X, +Y, -Y, +Z, -Z.
Each one is exactly what matrixLookAt builds for that direction (pinned by a
test), written out as literals because gl_shader.ts's fragment stage has to
carry the SAME table in GLSL -- the shader selects the face and derives the
face UV from these three vectors by hand rather than being handed six
matrices it has no uniform budget for.

Handedness is deliberately not policed: rendering and lookup use the same
basis, so they agree either way, and the depth pass draws with GL_CULL_FACE
off so winding never enters into it.
====================
*/
export const CUBE_FACE_BASIS: readonly CubeFaceBasisT[] = [
  { forward: vec3(1, 0, 0), right: vec3(0, -1, 0), up: vec3(0, 0, 1) },
  { forward: vec3(-1, 0, 0), right: vec3(0, 1, 0), up: vec3(0, 0, 1) },
  { forward: vec3(0, 1, 0), right: vec3(1, 0, 0), up: vec3(0, 0, 1) },
  { forward: vec3(0, -1, 0), right: vec3(-1, 0, 0), up: vec3(0, 0, 1) },
  { forward: vec3(0, 0, 1), right: vec3(0, 1, 0), up: vec3(1, 0, 0) },
  { forward: vec3(0, 0, -1), right: vec3(0, -1, 0), up: vec3(1, 0, 0) },
];

// Which 3x2 cell a face occupies. Kept as a function so the GLSL's
// `vec2(mod(face, 3.0), floor(face / 3.0))` has one thing to be tested against.
export function cubeFaceCell(face: number): { col: number; row: number } {
  return { col: face % SHADOW_CUBE_COLS, row: Math.floor(face / SHADOW_CUBE_COLS) };
}

/*
====================
cubeFaceForDirection

Major-axis selection: the face whose forward axis dominates `dir`. The tie
rules (>= rather than >, and the x-then-y-then-z order) are load-bearing --
gl_shader.ts's fragment stage repeats them exactly, and a fragment that
picked a different face than the depth pass rasterized would read a
neighbouring face's texels.
====================
*/
export function cubeFaceForDirection(dir: Vec3): number {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  if (ax >= ay && ax >= az) return dir[0] >= 0 ? 0 : 1;
  if (ay >= az) return dir[1] >= 0 ? 2 : 3;
  return dir[2] >= 0 ? 4 : 5;
}

/*
====================
matrixCubeFaceView

World -> face-eye view matrix for one cube face, built straight from
CUBE_FACE_BASIS so the render side and the shader's hand-rolled lookup can
never drift apart. Same layout as matrixLookAt (which a test asserts it
matches for all six directions).
====================
*/
export function matrixCubeFaceView(origin: Vec3, face: number): Float32Array {
  const basis = CUBE_FACE_BASIS[face] ?? CUBE_FACE_BASIS[0];
  if (!basis) return matrixIdentity();
  const f = basis.forward;
  const r = basis.right;
  const u = basis.up;
  const m = new Float32Array(16);
  m[0] = r[0];
  m[4] = r[1];
  m[8] = r[2];
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[2] = -f[0];
  m[6] = -f[1];
  m[10] = -f[2];
  m[12] = -(r[0] * origin[0] + r[1] * origin[1] + r[2] * origin[2]);
  m[13] = -(u[0] * origin[0] + u[1] * origin[1] + u[2] * origin[2]);
  m[14] = f[0] * origin[0] + f[1] * origin[1] + f[2] * origin[2];
  m[15] = 1;
  return m;
}

// A cube face is always a square 90-degree frustum; only its far plane varies.
export const SHADOW_CUBE_FOV = 90;

export function shadowCubeFar(radius: number): number {
  return Math.max(radius, SHADOW_NEAR * 2);
}

/*
====================
shadowCubeDepthCoefficients

The two numbers that turn a distance ALONG THE FACE AXIS into the window
depth glDrawPixels-equivalent the depth pass stores, and back again:

    z_ndc = -a + b / axialDistance          (what the rasterizer writes)
    axialDistance = b / (z_ndc + a)         (what the fragment shader inverts)

which is just matrixPerspective's third row rewritten with w divided out.
The shader does the same two lines with the same a/b, so that a point light's
depth comparison can be made in WORLD units -- see SHADOW_CUBE_BIAS in
gl_shader.ts for why that matters for the bias.
====================
*/
export function shadowCubeDepthCoefficients(radius: number): { a: number; b: number } {
  const far = shadowCubeFar(radius);
  return {
    a: (far + SHADOW_NEAR) / (SHADOW_NEAR - far),
    b: (2 * far * SHADOW_NEAR) / (SHADOW_NEAR - far),
  };
}

export function shadowCubeWindowDepth(axialDistance: number, radius: number): number {
  const { a, b } = shadowCubeDepthCoefficients(radius);
  return 0.5 * (-a + b / axialDistance) + 0.5;
}

export function shadowCubeAxialDistance(windowDepth: number, radius: number): number {
  const { a, b } = shadowCubeDepthCoefficients(radius);
  return b / (2 * windowDepth - 1 + a);
}

export interface CubeProjectionT {
  readonly face: number;
  readonly u: number; // [0,1] inside the face
  readonly v: number;
  readonly axial: number; // distance along the face's forward axis
  readonly depth: number; // window depth as the depth pass stores it
}

/*
====================
cubeFaceProject

TS mirror of the whole point-light lookup gl_shader.ts's fragment stage does:
pick the face, project onto it, and say what window depth that point would
have been rasterized with. Exists so the face math can be tested without a
GPU -- the GLSL is the same expressions in the same order.

Returns null in front of the near plane, which is the shader's early-out.
====================
*/
export function cubeFaceProject(lightOrigin: Vec3, worldPoint: Vec3, radius: number): CubeProjectionT | null {
  const l = vec3(worldPoint[0] - lightOrigin[0], worldPoint[1] - lightOrigin[1], worldPoint[2] - lightOrigin[2]);
  const face = cubeFaceForDirection(l);
  const basis = CUBE_FACE_BASIS[face];
  if (!basis) return null;
  const axial = l[0] * basis.forward[0] + l[1] * basis.forward[1] + l[2] * basis.forward[2];
  if (axial <= SHADOW_NEAR) return null;
  const sx = l[0] * basis.right[0] + l[1] * basis.right[1] + l[2] * basis.right[2];
  const sy = l[0] * basis.up[0] + l[1] * basis.up[1] + l[2] * basis.up[2];
  return {
    face,
    u: (sx / axial) * 0.5 + 0.5,
    v: (sy / axial) * 0.5 + 0.5,
    axial,
    depth: shadowCubeWindowDepth(axial, radius),
  };
}

// --- caster classification ----------------------------------------------

export const SHADOW_CASTER_NONE = 0;
export const SHADOW_CASTER_ALIAS = 1;
export const SHADOW_CASTER_BRUSH = 2;

/*
====================
shadowCasterKind

Which refresh entities block light. Deliberately excluded, and why:

  * RF_BEAM and RF_FLARE carry no model at all -- gl_rmain.ts draws both
    procedurally, so there is no geometry to rasterize.
  * RF_TRANSLUCENT: a surface you can see through does not stop light.
  * RF_NOSHADOW: the rerelease's own opt-out, honoured here for the first
    time (nothing else in this renderer reads it).
  * RF_WEAPONMODEL / RF_DEPTHHACK: the view weapon sits a few units from the
    eye and is not really in the world; in a light's depth map it would black
    out the entire room.
  * mod_sprite: a camera-facing billboard has no stable silhouette from a
    light's point of view -- its shadow would swing as the PLAYER turned.

RF_VIEWERMODEL is deliberately NOT excluded: "don't draw through the owner's
own eyes" is a statement about the eye pass, and a player who casts no shadow
of their own is exactly the artifact this unit exists to remove.
====================
*/
export function shadowCasterKind(ent: EntityT | null | undefined): number {
  if (!ent) return SHADOW_CASTER_NONE;
  if (ent.flags & (RF_BEAM | RF_FLARE | RF_TRANSLUCENT | RF_NOSHADOW | RF_WEAPONMODEL | RF_DEPTHHACK)) return SHADOW_CASTER_NONE;
  const model = ent.model;
  if (!(model instanceof ModelT)) return SHADOW_CASTER_NONE;
  if (model.type === ModtypeT.mod_alias) return SHADOW_CASTER_ALIAS;
  // mod_brush in the ENTITY list is always an inline submodel (*1, *2, ...):
  // a func_door/func_plat/func_rotating and friends. The world model itself
  // is drawn by R_DrawWorld and never appears here.
  if (model.type === ModtypeT.mod_brush && model.nummodelsurfaces > 0) return SHADOW_CASTER_BRUSH;
  return SHADOW_CASTER_NONE;
}

/*
====================
shadowCasterRadius

Radius of a world-axis-aligned sphere centred on the entity's ORIGIN that
contains the model however it is rotated: the corner of the model's own
bounding box that is furthest from its origin. Using the origin rather than
the box centre is what makes it rotation-proof -- R_RotateForEntity spins the
model about its origin, so a sphere centred there never has to be re-fitted.
====================
*/
export function shadowCasterRadius(model: ModelT): number {
  const rx = Math.max(Math.abs(model.mins[0]), Math.abs(model.maxs[0]));
  const ry = Math.max(Math.abs(model.mins[1]), Math.abs(model.maxs[1]));
  const rz = Math.max(Math.abs(model.mins[2]), Math.abs(model.maxs[2]));
  const r = Math.hypot(rx, ry, rz);
  // A model that reported no bounds at all still has to occlude something;
  // 64 comfortably contains every shipped alias model's ±32 default box.
  return r > 0 ? r : 64;
}

// --- live shadow-map state (real GL calls) --------------------------------

export interface ShadowMapBindingT {
  readonly lightIndex: number;
  // SHADOW_KIND_CONE or SHADOW_KIND_POINT -- gl_shader.ts uploads this
  // straight into u_light_shadow[i], where the fragment loop switches on it.
  readonly kind: number;
  readonly matrix: Float32Array;
  readonly slot: AtlasSlotT;
}

interface CachedShadowT {
  signature: string;
  slot: AtlasSlotT;
  matrix: Float32Array;
}

interface ShadowCasterT {
  readonly ent: EntityT;
  readonly model: ModelT;
  readonly kind: number;
  readonly radius: number;
}

interface ShadowCandidateT {
  readonly index: number;
  readonly dl: DlightT;
  readonly kind: number;
  // per-FACE edge for a point light, whole-map edge for a cone light
  face: number;
  casters: ShadowCasterT[];
}

export interface ShadowMapStatsT {
  // lights that ended up with an atlas rectangle this frame
  readonly lights: number;
  // ...of which reused their existing depth texels (zero draw calls)
  readonly cachedLights: number;
  // ...and which had to re-render, because the light or one of its casters moved
  readonly rebuiltLights: number;
  // total depth passes issued: one per cone light, six per point light
  readonly facesRendered: number;
  // entity casters actually emitted into a depth map this frame
  readonly entityCasters: number;
}

const NO_STATS: ShadowMapStatsT = { lights: 0, cachedLights: 0, rebuiltLights: 0, facesRendered: 0, entityCasters: 0 };

let shadowFbo = 0;
let shadowTexture = 0;
let shadowReady = false;
let shadowWarned = false;
// Set when GL_InitShadowMaps has failed on THIS context (no FBO entry points,
// or an incomplete depth framebuffer). One failure is permanent for the life
// of the context: retrying it every frame would spam the console and reprobe
// hardware that is not going to change its mind.
let shadowInitFailed = false;
const cached = new Map<number, CachedShadowT>();
let activeBindings: ShadowMapBindingT[] = [];
let shadowStats: ShadowMapStatsT = NO_STATS;

/*
====================
GL_ShadowMapsActive

"Is the shadow-map system the thing drawing shadows this frame?" -- the one
answer both this file and gl_mesh.ts's planar-decal gate ask, so that the two
shadow techniques can never both run over the same model (see the header's
"Planar shadow interaction").

Deliberately answered from the CVARS and the context's capability, not from
whether any light actually got an atlas rectangle this frame. Keying it on
live bindings would switch the 1997 decal on and off as a monster walked in
and out of a shadow light's radius, which is a far worse artifact than the
one it would be avoiding.

gl_shaders is read directly rather than through gl_shader.ts's
GL_UsingShaderPath() only because gl_shader.ts imports THIS file; the cvar is
an accurate proxy, since GL_InitShaderPath sets it to 0 itself when the
context turns out not to support program objects.
====================
*/
export function GL_ShadowMapsActive(): boolean {
  if (shadowInitFailed) return false;
  if (glCvars.gl_shaders && !glCvars.gl_shaders.value) return false;
  return !glCvars.gl_shadowmaps || glCvars.gl_shadowmaps.value !== 0;
}

export function GL_ShadowMapTexture(): number {
  return shadowTexture;
}

export function GL_ShadowMapsReady(): boolean {
  return shadowReady;
}

export function GL_ShadowMapBindings(): readonly ShadowMapBindingT[] {
  return activeBindings;
}

// Last frame's depth-pass cost, for r_speeds-style reporting and for tests
// that need to assert the cache actually cached.
export function GL_ShadowMapStats(): ShadowMapStatsT {
  return shadowStats;
}

/*
====================
GL_InitShadowMaps

One-time allocation of the depth atlas and its framebuffer. Called from
R_Init after the shader path has decided whether it is active at all --
there is no point allocating a 2048x2048 depth texture for a context that
will be drawing fixed-function. Returns false and leaves nothing allocated
if the context lacks ARB_framebuffer_object or reports the framebuffer
incomplete; the caller then simply never renders a shadow pass and the
lighting shader falls back to its unshadowed permutation.
====================
*/
export function GL_InitShadowMaps(): boolean {
  GL_ShutdownShadowMaps();
  // A fresh attempt on a (possibly new) context: the caller re-arms the latch
  // if this attempt fails too.
  shadowInitFailed = false;

  // No gl_shadowmaps check here on purpose. This used to return early when
  // the cvar was 0, which meant a session that BOOTED with shadow mapping
  // off could never turn it back on: R_Init ran once, shadowReady stayed
  // false, and the Video menu's "shadow mapping: yes" wrote a cvar nothing
  // ever looked at again without a vid_restart. The cvar is now read once
  // per frame in R_RenderShadowMaps, which allocates the atlas on the first
  // frame it is wanted and releases it on the first frame it is not.
  const genFramebuffers = qgl.qglGenFramebuffers;
  const bindFramebuffer = qgl.qglBindFramebuffer;
  const framebufferTexture2D = qgl.qglFramebufferTexture2D;
  const checkFramebufferStatus = qgl.qglCheckFramebufferStatus;
  if (!genFramebuffers || !bindFramebuffer || !framebufferTexture2D || !checkFramebufferStatus) {
    if (!shadowWarned) {
      ri.Con_Printf(PRINT_ALL, "gl_shadowmaps: framebuffer objects unavailable on this context -- shadow maps disabled\n");
      shadowWarned = true;
    }
    return false;
  }

  const texName = new Uint32Array(1);
  qgl.qglGenTextures(1, texName);
  shadowTexture = texName[0] ?? 0;
  if (!shadowTexture) return false;

  qgl.qglBindTexture(GL_TEXTURE_2D, shadowTexture);
  qgl.qglTexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT24, SHADOW_ATLAS_SIZE, SHADOW_ATLAS_SIZE, 0, GL_DEPTH_COMPONENT, GL_FLOAT, null);
  // GL_NEAREST, and GL_TEXTURE_COMPARE_MODE deliberately left at its default
  // GL_NONE: the fragment shader reads the raw depth through texture2D().r
  // and does its own compare, which needs no sampler2DShadow and so keeps
  // the GLSL at the #version 110 this renderer's shader path targets. For a
  // point light it also has to INVERT that depth back to a distance, which
  // a hardware compare could not have done for it either.
  qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

  const fboName = new Uint32Array(1);
  genFramebuffers(1, fboName);
  shadowFbo = fboName[0] ?? 0;

  const previous = new Int32Array(1);
  qgl.qglGetIntegerv(GL_FRAMEBUFFER_BINDING, previous);

  bindFramebuffer(GL_FRAMEBUFFER, shadowFbo);
  framebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, shadowTexture, 0);
  // a depth-only FBO is incomplete unless BOTH buffers are pointed at nothing
  qgl.qglDrawBuffer(GL_NONE);
  qgl.qglReadBuffer(GL_NONE);
  const status = checkFramebufferStatus(GL_FRAMEBUFFER);
  bindFramebuffer(GL_FRAMEBUFFER, previous[0] ?? 0);

  if (status !== GL_FRAMEBUFFER_COMPLETE) {
    ri.Con_Printf(PRINT_ALL, "gl_shadowmaps: depth framebuffer incomplete -- shadow maps disabled\n");
    GL_ShutdownShadowMaps();
    return false;
  }

  cached.clear();
  shadowReady = true;
  return true;
}

export function GL_ShutdownShadowMaps(): void {
  if (shadowFbo && qgl.qglDeleteFramebuffers) qgl.qglDeleteFramebuffers(1, new Uint32Array([shadowFbo]));
  if (shadowTexture) qgl.qglDeleteTextures(1, new Uint32Array([shadowTexture]));
  shadowFbo = 0;
  shadowTexture = 0;
  shadowReady = false;
  // The "this context cannot do shadow maps" latch lives exactly as long as
  // the context does. Tearing the atlas down (R_Shutdown, or a vid_restart's
  // R_Init) is the point at which a fresh attempt becomes reasonable again.
  shadowInitFailed = false;
  cached.clear();
  activeBindings = [];
  shadowStats = NO_STATS;
}

// Invalidates every cached depth map. Called on map change: the cache is
// keyed on light parameters, which say nothing about which world the
// geometry came from, so two maps whose lights happen to match would
// otherwise share a stale depth map.
export function GL_ShadowMapsNewMap(): void {
  cached.clear();
  activeBindings = [];
  shadowStats = NO_STATS;
}

/*
====================
shadowSignature

What a light's depth map depends on. Intensity/colour/lightstyle flicker
change none of it, so they are deliberately absent -- a strobing shadow light
re-renders its depth map zero times per second, not sixty.

The caster digest is the part that makes entity casters affordable. An entity
contributes its model, its origin, its angles and its current frame; it
contributes its LERP state (oldframe/backlerp) only when that lerp actually
moves vertices, i.e. only when the entity is mid-animation or mid-move. That
distinction is the whole cache: `backlerp` ticks every single client frame
even for a crate sitting still, so digesting it unconditionally would rebuild
every depth map in the level, every frame, forever.
====================
*/
function casterDigest(caster: ShadowCasterT): string {
  const e = caster.ent;
  const r = (v: number): string => v.toFixed(1);
  const moving =
    Math.abs(e.oldorigin[0] - e.origin[0]) > 0.05 || Math.abs(e.oldorigin[1] - e.origin[1]) > 0.05 || Math.abs(e.oldorigin[2] - e.origin[2]) > 0.05;
  const animating = e.frame !== e.oldframe;
  const lerp = moving || animating ? `${e.oldframe}:${e.backlerp.toFixed(2)}:${r(e.oldorigin[0])},${r(e.oldorigin[1])},${r(e.oldorigin[2])}` : "";
  return `${caster.model.name}@${r(e.origin[0])},${r(e.origin[1])},${r(e.origin[2])}/${r(e.angles[0])},${r(e.angles[1])},${r(e.angles[2])}#${e.frame}${lerp}`;
}

function shadowSignature(cand: ShadowCandidateT): string {
  const dl = cand.dl;
  const r = (v: number): string => v.toFixed(2);
  const cone = dl.cone;
  const shape = cone ? `${r(cone.direction[0])},${r(cone.direction[1])},${r(cone.direction[2])};${r(cone.cosHalfAngle)}` : "omni";
  const casters = cand.casters.map(casterDigest).join("|");
  return `${cand.kind};${r(dl.origin[0])},${r(dl.origin[1])},${r(dl.origin[2])};${shape};${r(dl.intensity)};${cand.face};${casters}`;
}

function coneAngleDegrees(cosHalfAngle: number): number {
  return (Math.acos(Math.min(Math.max(cosHalfAngle, -1), 1)) * 180) / Math.PI;
}

// The atlas rectangle a candidate wants: one square for a cone light, a 3x2
// grid of face-sized squares for a point light.
function candidateRequest(cand: ShadowCandidateT): AtlasRequestT {
  if (cand.kind !== SHADOW_KIND_POINT) return cand.face;
  return { width: cand.face * SHADOW_CUBE_COLS, height: cand.face * SHADOW_CUBE_ROWS };
}

function candidateArea(cand: ShadowCandidateT): number {
  const request = candidateRequest(cand);
  const extent = typeof request === "number" ? { width: request, height: request } : request;
  return extent.width * extent.height;
}

/*
====================
fitCandidatesToAtlas

Packs the frame's lights, and -- when they do not all fit -- halves every
point light's FACE edge and tries again rather than dropping whole lights.
A point light asks for six faces' worth of atlas, so at the video menu's
"high" setting two of them alone fill a 2048 atlas; softening those to a
smaller face is a far better answer than the first two lights casting
shadows and the rest silently not.

Cone lights are never shrunk: their footprint is already a sixth of a point
light's at the same resolution, and shrinking them would regress shadows
that shipped working in v1.1.0.
====================
*/
function fitCandidatesToAtlas(candidates: ShadowCandidateT[]): (AtlasSlotT | null)[] {
  candidates.sort((a, b) => candidateArea(b) - candidateArea(a));
  let slots = packShadowAtlas(candidates.map(candidateRequest));

  for (let attempt = 0; attempt < 4 && slots.some((slot) => slot === null); attempt++) {
    let shrank = false;
    for (const cand of candidates) {
      if (cand.kind === SHADOW_KIND_POINT && cand.face > SHADOW_RES_MIN) {
        cand.face /= 2;
        shrank = true;
      }
    }
    if (!shrank) break;
    candidates.sort((a, b) => candidateArea(b) - candidateArea(a));
    slots = packShadowAtlas(candidates.map(candidateRequest));
  }
  return slots;
}

/*
====================
gatherCasters

Every entity caster whose bounding sphere reaches into the light. For a cone
light the sphere is additionally tested against the shadow frustum's DIAGONAL
half-angle -- the frustum is a square pyramid, so its corners open wider than
shadowFovForConeAngle's vertical half-angle, and clipping a caster that a
corner would have caught is the one error that shows (a shadow that pops in
as the caster walks toward the middle of the cone).
====================
*/
function gatherCasters(cand: ShadowCandidateT, casters: readonly ShadowCasterT[]): ShadowCasterT[] {
  if (!casters.length) return [];
  const dl = cand.dl;
  const lightRadius = dl.intensity;

  let cosLimit = -1;
  const cone = dl.cone;
  if (cone) {
    const halfFov = (shadowFovForConeAngle(coneAngleDegrees(cone.cosHalfAngle)) * 0.5 * Math.PI) / 180;
    const diagonal = Math.atan(Math.SQRT2 * Math.tan(Math.min(halfFov, (87 * Math.PI) / 180)));
    cosLimit = Math.cos(Math.min(diagonal, Math.PI));
  }

  const hits: ShadowCasterT[] = [];
  for (const caster of casters) {
    const dx = caster.ent.origin[0] - dl.origin[0];
    const dy = caster.ent.origin[1] - dl.origin[1];
    const dz = caster.ent.origin[2] - dl.origin[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > lightRadius + caster.radius) continue;

    if (cone && dist > caster.radius) {
      const dot = (dx * cone.direction[0] + dy * cone.direction[1] + dz * cone.direction[2]) / dist;
      // widen the cone by the caster's own angular radius before rejecting
      const angular = Math.asin(Math.min(1, caster.radius / dist));
      if (Math.cos(Math.min(Math.PI, Math.acos(Math.min(1, Math.max(-1, dot))) - angular)) < cosLimit) continue;
    }
    hits.push(caster);
  }
  return hits;
}

/*
====================
R_RenderShadowMaps

Renders (or reuses) one depth map per shadowing light, then leaves the
framebuffer binding exactly as it found it. Must run BEFORE R_SetupGL: it
takes over the projection and modelview matrices and the viewport, and
R_SetupGL is what puts all three back for the scene proper.

Every light past MAX_SHADOW_MAPS, and every light the atlas has no room left
for even after fitCandidatesToAtlas has shrunk what it can, keeps task #25's
unoccluded contribution rather than getting a wrong shadow.
====================
*/
export function R_RenderShadowMaps(
  worldmodel: ModelT | null,
  lights: readonly DlightT[],
  numLights: number,
  entities: readonly EntityT[] = [],
  numEntities = 0,
): void {
  activeBindings = [];
  shadowStats = NO_STATS;

  // Follow the cvar every frame, in both directions. Turning shadow mapping
  // off in the Video menu has to stop drawing shadows in the SAME session
  // (and give the 16MB atlas back), and turning it on has to start again
  // without a vid_restart.
  if (!GL_ShadowMapsActive()) {
    if (shadowReady) GL_ShutdownShadowMaps();
    return;
  }
  if (!shadowReady && !GL_InitShadowMaps()) {
    shadowInitFailed = true;
    return;
  }
  if (!worldmodel) return;

  const bindFramebuffer = qgl.qglBindFramebuffer;
  if (!bindFramebuffer) return;

  const resolutionCap = glCvars.gl_shadowmap_res ? glCvars.gl_shadowmap_res.value : SHADOW_RES_MAX;
  const candidates: ShadowCandidateT[] = [];
  const count = Math.min(numLights, lights.length, MAX_SHADOW_MAPS);
  for (let i = 0; i < count; i++) {
    const dl = lights[i];
    if (!dl || dl.intensity <= 0) continue;
    // Only CS_SHADOWLIGHTS-fed lights get a depth map. A classic transient
    // dlight (muzzle flash, rocket, blaster glow) is coneless like a point
    // shadow light is, and would otherwise be handed a six-face cube map it
    // has never had in any Quake 2 -- see DlightT.isShadowLight.
    if (!dl.isShadowLight && !dl.cone) continue;
    candidates.push({
      index: i,
      dl,
      kind: dl.cone ? SHADOW_KIND_CONE : SHADOW_KIND_POINT,
      // gl_shadowmap_res is the cap for BOTH kinds; for a point light it caps
      // one FACE, which is what makes it comparable to a cone light's map.
      face: shadowMapResolution(dl.resolution, resolutionCap),
      casters: [],
    });
  }
  if (!candidates.length) return;

  // Entity casters are hidden exactly when the entities themselves are:
  // r_drawentities 0 must not leave a level full of shadows cast by nothing.
  const entitiesVisible =
    (!glCvars.r_drawentities || glCvars.r_drawentities.value !== 0) && (!glCvars.gl_drawentities || glCvars.gl_drawentities.value !== 0);
  const allCasters: ShadowCasterT[] = [];
  if (entitiesVisible) {
    const entCount = Math.min(numEntities, entities.length);
    for (let i = 0; i < entCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      const kind = shadowCasterKind(ent);
      if (kind === SHADOW_CASTER_NONE) continue;
      const model = ent.model;
      if (!(model instanceof ModelT)) continue;
      allCasters.push({ ent, model, kind, radius: shadowCasterRadius(model) });
    }
  }
  for (const cand of candidates) cand.casters = gatherCasters(cand, allCasters);

  const slots = fitCandidatesToAtlas(candidates);

  // Reuse a cached depth map whenever the light, its casters AND its atlas
  // rectangle are all unchanged; the rectangle matters because the cached
  // texels live at fixed atlas coordinates.
  const pending: { cand: ShadowCandidateT; slot: AtlasSlotT }[] = [];
  const bindings: ShadowMapBindingT[] = [];
  let cachedLights = 0;
  let entityCasters = 0;

  for (let c = 0; c < candidates.length; c++) {
    const cand = candidates[c];
    const slot = slots[c];
    if (!cand || !slot) continue;

    const signature = shadowSignature(cand);
    const matrix =
      cand.kind === SHADOW_KIND_CONE && cand.dl.cone
        ? shadowLightMatrix(cand.dl.origin, cand.dl.cone.direction, coneAngleDegrees(cand.dl.cone.cosHalfAngle), cand.dl.intensity)
        : // a point light needs no matrix at all -- the shader derives the
          // face and its UV from u_light_pos/u_light_radius. Identity keeps
          // ShadowMapBindingT one shape and the uniform upload branch-free.
          matrixIdentity();
    const hit = cached.get(cand.index);
    if (!hit || hit.signature !== signature || hit.slot.x !== slot.x || hit.slot.y !== slot.y || hit.slot.width !== slot.width || hit.slot.height !== slot.height) {
      pending.push({ cand, slot });
      entityCasters += cand.casters.length;
    } else {
      cachedLights++;
    }
    cached.set(cand.index, { signature, slot, matrix });
    bindings.push({ lightIndex: cand.index, kind: cand.kind, matrix, slot });
  }

  activeBindings = bindings;
  let facesRendered = 0;
  for (const job of pending) facesRendered += job.cand.kind === SHADOW_KIND_POINT ? SHADOW_CUBE_FACES : 1;
  shadowStats = {
    lights: bindings.length,
    cachedLights,
    rebuiltLights: pending.length,
    facesRendered,
    entityCasters,
  };
  if (!pending.length) return;

  // This pass runs before R_SetupGL, so the GL state it inherits is whatever
  // the PREVIOUS frame's 2D overlay pass (R_SetGL2D) left behind -- depth
  // test off, alpha test on. Both would silently ruin a depth map, so every
  // piece of state the depth render depends on is set explicitly here.
  // R_SetupGL puts the viewport, both matrices, cull, blend, alpha test and
  // depth test back for the scene; depth range, depth func, scissor,
  // polygon offset and the framebuffer binding are NOT in its remit, so
  // those are saved and restored around the pass.
  const previous = new Int32Array(1);
  qgl.qglGetIntegerv(GL_FRAMEBUFFER_BINDING, previous);
  const savedDepthFunc = new Int32Array(1);
  qgl.qglGetIntegerv(GL_DEPTH_FUNC, savedDepthFunc);
  const savedDepthRange = new Float32Array(2);
  qgl.qglGetFloatv(GL_DEPTH_RANGE, savedDepthRange);

  bindFramebuffer(GL_FRAMEBUFFER, shadowFbo);
  if (qgl.qglUseProgram) qgl.qglUseProgram(0); // the depth pass is fixed-function; only position matters
  qgl.qglDisable(GL_BLEND);
  qgl.qglDisable(GL_ALPHA_TEST); // R_SetGL2D leaves this ON; it would punch holes in the depth map
  qgl.qglEnable(GL_DEPTH_TEST); // R_SetGL2D leaves this OFF, which would write no depth at all
  qgl.qglDepthFunc(GL_LEQUAL);
  qgl.qglDepthRange(0, 1); // gl_ztrick halves the scene's range; the atlas wants the whole of it
  qgl.qglDisable(GL_CULL_FACE); // closed brush geometry: take whichever face is nearest the light
  qgl.qglEnable(GL_SCISSOR_TEST); // so the per-slot clear cannot wipe a neighbour's map
  qgl.qglEnable(GL_POLYGON_OFFSET_FILL);
  qgl.qglDepthMask(true);

  for (const job of pending) {
    const cand = job.cand;
    const far = shadowCubeFar(cand.dl.intensity);
    const cone = cand.dl.cone;

    if (cand.kind === SHADOW_KIND_CONE && cone) {
      renderShadowFace(
        job.slot.x,
        job.slot.y,
        job.slot.width,
        job.slot.height,
        matrixPerspective(shadowFovForConeAngle(coneAngleDegrees(cone.cosHalfAngle)), SHADOW_NEAR, far),
        matrixLookAt(cand.dl.origin, cone.direction),
        worldmodel,
        cand,
        far,
        null,
      );
      continue;
    }

    const faceSize = job.slot.width / SHADOW_CUBE_COLS;
    const projection = matrixPerspective(SHADOW_CUBE_FOV, SHADOW_NEAR, far);
    for (let f = 0; f < SHADOW_CUBE_FACES; f++) {
      const basis = CUBE_FACE_BASIS[f];
      if (!basis) continue;
      const { col, row } = cubeFaceCell(f);
      renderShadowFace(
        job.slot.x + col * faceSize,
        job.slot.y + row * faceSize,
        faceSize,
        faceSize,
        projection,
        matrixCubeFaceView(cand.dl.origin, f),
        worldmodel,
        cand,
        far,
        basis.forward,
      );
    }
  }

  qgl.qglDisable(GL_POLYGON_OFFSET_FILL);
  qgl.qglDisable(GL_SCISSOR_TEST);
  qgl.qglPolygonOffset(0, 0);
  qgl.qglDepthFunc(savedDepthFunc[0] ?? GL_LEQUAL);
  qgl.qglDepthRange(savedDepthRange[0] ?? 0, savedDepthRange[1] ?? 1);
  bindFramebuffer(GL_FRAMEBUFFER, previous[0] ?? 0);
}

// Polygon offset for the STATIC world. Slope-scaled, because a big BSP floor
// seen edge-on from a light is where depth-map acne comes from.
const SHADOW_OFFSET_WORLD_FACTOR = 2;
const SHADOW_OFFSET_WORLD_UNITS = 4;
// ...and a gentler one for entity casters. An alias model is a thin, curved
// shell rather than a slab, so the world's offset would lift its shadow clean
// off the floor it is standing on (peter-panning) to buy acne protection it
// does not need -- its own surfaces are not receiving these shadows.
const SHADOW_OFFSET_ENTITY_FACTOR = 1;
const SHADOW_OFFSET_ENTITY_UNITS = 2;

/*
====================
renderShadowFace

One viewport's worth of depth: the shared clear/viewport/matrix preamble and
then the world and entity geometry. `faceForward`, when given, is the cube
face's forward axis, used to reject geometry that is entirely behind this
face -- a pure CPU saving (GL would clip it correctly anyway), but with six
faces per light the world walk is the part worth not doing six times.
====================
*/
function renderShadowFace(
  x: number,
  y: number,
  width: number,
  height: number,
  projection: Float32Array,
  view: Float32Array,
  worldmodel: ModelT,
  cand: ShadowCandidateT,
  far: number,
  faceForward: Vec3 | null,
): void {
  qgl.qglViewport(x, y, width, height);
  qgl.qglScissor(x, y, width, height);
  qgl.qglClear(GL_DEPTH_BUFFER_BIT);

  qgl.qglMatrixMode(GL_PROJECTION);
  qgl.qglLoadMatrixf(projection);
  qgl.qglMatrixMode(GL_MODELVIEW);
  qgl.qglLoadMatrixf(view);

  qgl.qglPolygonOffset(SHADOW_OFFSET_WORLD_FACTOR, SHADOW_OFFSET_WORLD_UNITS);
  drawWorldDepth(worldmodel, cand.dl.origin, far, faceForward);

  if (!cand.casters.length) return;
  qgl.qglPolygonOffset(SHADOW_OFFSET_ENTITY_FACTOR, SHADOW_OFFSET_ENTITY_UNITS);
  for (const caster of cand.casters) drawCasterDepth(caster, cand.dl.origin, faceForward);
}

/*
====================
drawWorldDepth

Position-only emission of every world surface inside the light's radius.
Sky and warped (liquid) surfaces are skipped: sky is the void behind the
level and would clamp every shadow to the skybox, and liquid surfaces are
vertex-animated at draw time so their static positions here would not match
what the eye pass shows anyway.

Culling is a plain per-vertex radius test (plus, for a cube face, a per-vertex
half-space test against that face's forward axis) rather than a full frustum
test: this runs only when a light's depth map is actually (re)built, so the
cheaper, looser test costs nothing worth reclaiming.
====================
*/
function drawWorldDepth(worldmodel: ModelT, origin: Vec3, radius: number, faceForward: Vec3 | null): void {
  const radiusSquared = radius * radius;

  for (let i = 0; i < worldmodel.numsurfaces; i++) {
    const surf: MsurfaceT | undefined = worldmodel.surfaces[i];
    if (!surf || !surf.polys) continue;
    if (surf.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) continue;

    for (let poly: GlpolyT | null = surf.polys; poly; poly = poly.next) {
      // The two tests are accumulated INDEPENDENTLY on purpose. Requiring one
      // single vertex to pass both would drop a polygon that reaches into the
      // light with one corner and in front of the face with another -- which
      // is most of a big floor quad seen from a cube face's edge, and would
      // show up as a wedge of missing shadow.
      let anyInRadius = false;
      let anyInFront = faceForward === null;
      for (let v = 0; v < poly.numverts && !(anyInRadius && anyInFront); v++) {
        const vert = poly.verts[v];
        if (!vert) continue;
        const dx = (vert[0] ?? 0) - origin[0];
        const dy = (vert[1] ?? 0) - origin[1];
        const dz = (vert[2] ?? 0) - origin[2];
        if (dx * dx + dy * dy + dz * dz <= radiusSquared) anyInRadius = true;
        if (faceForward && dx * faceForward[0] + dy * faceForward[1] + dz * faceForward[2] > 0) anyInFront = true;
      }
      if (!anyInRadius || !anyInFront) continue;

      qgl.qglBegin(GL_POLYGON);
      for (let v = 0; v < poly.numverts; v++) {
        const vert = poly.verts[v];
        if (vert) qgl.qglVertex3fv(vert);
      }
      qgl.qglEnd();
    }
  }
}

/*
====================
rotateForCasterDepth

R_RotateForEntity's transform, re-stated here rather than imported: gl_rmain
imports this file, so importing gl_rmain back would close a module cycle for
three glRotatef calls. The two sign flips its callers apply before calling it
are folded in -- R_DrawAliasModel negates PITCH around the call
(gl_mesh.ts:824-826) and R_DrawBrushModel negates PITCH and ROLL
(gl_rsurf.ts:872-876) -- because a shadow whose transform differs from the
drawn model's is worse than no shadow.
====================
*/
function rotateForCasterDepth(ent: EntityT, kind: number): void {
  qgl.qglTranslatef(ent.origin[0], ent.origin[1], ent.origin[2]);
  qgl.qglRotatef(ent.angles[1], 0, 0, 1);
  qgl.qglRotatef(ent.angles[0], 0, 1, 0); // == -(-pitch), for both entity kinds
  qgl.qglRotatef(kind === SHADOW_CASTER_ALIAS ? -ent.angles[2] : ent.angles[2], 1, 0, 0);
}

function drawCasterDepth(caster: ShadowCasterT, lightOrigin: Vec3, faceForward: Vec3 | null): void {
  if (faceForward) {
    const dx = caster.ent.origin[0] - lightOrigin[0];
    const dy = caster.ent.origin[1] - lightOrigin[1];
    const dz = caster.ent.origin[2] - lightOrigin[2];
    // entirely behind this cube face: another face already has it
    if (dx * faceForward[0] + dy * faceForward[1] + dz * faceForward[2] + caster.radius <= 0) return;
  }

  qgl.qglPushMatrix();
  rotateForCasterDepth(caster.ent, caster.kind);
  if (caster.kind === SHADOW_CASTER_BRUSH) drawBrushEntityDepth(caster.model);
  else drawAliasEntityDepth(caster.model, caster.ent);
  qgl.qglPopMatrix();
}

/*
====================
drawBrushEntityDepth

The inline submodel's own surfaces, in model space (the caller has already
pushed the entity transform). No backface test, unlike R_DrawInlineBModel:
the depth pass draws with GL_CULL_FACE off and wants whichever face is
nearest the light, which for a door seen edge-on is the back one.

SURF_TRANS33/SURF_TRANS66 surfaces are skipped for the same reason
RF_TRANSLUCENT entities are not casters at all -- you can see through them.
====================
*/
function drawBrushEntityDepth(model: ModelT): void {
  for (let i = 0; i < model.nummodelsurfaces; i++) {
    const surf: MsurfaceT | undefined = model.surfaces[model.firstmodelsurface + i];
    if (!surf || !surf.polys) continue;
    if (surf.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) continue;
    if (surf.texinfo && surf.texinfo.flags & (SURF_TRANS33 | SURF_TRANS66)) continue;

    for (let poly: GlpolyT | null = surf.polys; poly; poly = poly.next) {
      qgl.qglBegin(GL_POLYGON);
      for (let v = 0; v < poly.numverts; v++) {
        const vert = poly.verts[v];
        if (vert) qgl.qglVertex3fv(vert);
      }
      qgl.qglEnd();
    }
  }
}

interface AliasDepthVertexT {
  readonly v: readonly [number, number, number];
}
interface AliasDepthFrameT {
  readonly scale: readonly [number, number, number];
  readonly translate: readonly [number, number, number];
  readonly verts: readonly AliasDepthVertexT[];
}

/*
====================
drawAliasEntityDepth

Position-only alias emission. The frame lerp is GL_DrawAliasFrameLerp's
(gl_mesh.ts:284-330) with everything that is not a vertex position removed --
restated here rather than called because gl_mesh imports gl_rmain, which
imports this file, and because that function's real work is the colours and
texcoords a depth pass has no use for.

The RF_SHELL_* powersuit expansion GL_LerpVerts applies is deliberately NOT
reproduced: it inflates the mesh along its normals to draw a glowing shell
around the model, and a shadow cast by the shell rather than the body would
be visibly too fat.
====================
*/
function drawAliasEntityDepth(model: ModelT, ent: EntityT): void {
  const skeleton = model.skeleton;
  if (skeleton && (!glCvars.gl_md5_use || glCvars.gl_md5_use.value)) {
    drawAliasSkeletonDepth(skeleton, ent);
    return;
  }

  const hdr = model.extradata;
  if (!(hdr instanceof ParsedMd2T)) return;
  if (!hdr.num_frames || !hdr.glcmds.length) return;

  const frameIndex = ent.frame >= 0 && ent.frame < hdr.num_frames ? ent.frame : 0;
  const oldIndex = ent.oldframe >= 0 && ent.oldframe < hdr.num_frames ? ent.oldframe : 0;
  const frame = hdr.frames[frameIndex] as AliasDepthFrameT | undefined;
  const oldframe = hdr.frames[oldIndex] as AliasDepthFrameT | undefined;
  if (!frame || !oldframe) return;

  const backlerp = Math.min(Math.max(ent.backlerp, 0), 1);
  const frontlerp = 1 - backlerp;

  const delta = vec3(ent.oldorigin[0] - ent.origin[0], ent.oldorigin[1] - ent.origin[1], ent.oldorigin[2] - ent.origin[2]);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(ent.angles, forward, right, up);

  const move = vec3(
    delta[0] * forward[0] + delta[1] * forward[1] + delta[2] * forward[2],
    -(delta[0] * right[0] + delta[1] * right[1] + delta[2] * right[2]),
    delta[0] * up[0] + delta[1] * up[1] + delta[2] * up[2],
  );
  for (let i = 0; i < 3; i++) move[i] = backlerp * (move[i] + (oldframe.translate[i] ?? 0)) + frontlerp * (frame.translate[i] ?? 0);

  const frontv = vec3(frontlerp * frame.scale[0], frontlerp * frame.scale[1], frontlerp * frame.scale[2]);
  const backv = vec3(backlerp * oldframe.scale[0], backlerp * oldframe.scale[1], backlerp * oldframe.scale[2]);

  const lerped: Float32Array = new Float32Array(hdr.num_xyz * 3);
  for (let i = 0; i < hdr.num_xyz; i++) {
    const nv = frame.verts[i];
    const ov = oldframe.verts[i];
    if (!nv || !ov) continue;
    lerped[i * 3 + 0] = move[0] + ov.v[0] * backv[0] + nv.v[0] * frontv[0];
    lerped[i * 3 + 1] = move[1] + ov.v[1] * backv[1] + nv.v[1] * frontv[1];
    lerped[i * 3 + 2] = move[2] + ov.v[2] * backv[2] + nv.v[2] * frontv[2];
  }

  const order = hdr.glcmds;
  const point = vec3();
  let idx = 0;
  for (;;) {
    let count = order[idx++] ?? 0;
    if (!count) break;
    if (count < 0) {
      count = -count;
      qgl.qglBegin(GL_TRIANGLE_FAN);
    } else {
      qgl.qglBegin(GL_TRIANGLE_STRIP);
    }
    do {
      const index_xyz = order[idx + 2] ?? 0;
      idx += 3;
      point[0] = lerped[index_xyz * 3 + 0] ?? 0;
      point[1] = lerped[index_xyz * 3 + 1] ?? 0;
      point[2] = lerped[index_xyz * 3 + 2] ?? 0;
      qgl.qglVertex3fv(point);
      count--;
    } while (count);
    qgl.qglEnd();
  }
}

/*
====================
drawAliasSkeletonDepth

The MD5 path's silhouette, when a model has one. R_DrawAliasModel also gates
this on gl_md5_distance (an LOD switch measured from the EYE); the shadow
pass has no eye, and at the distance where that switch fires the two meshes'
silhouettes differ by less than one shadow texel, so the gate is not
reproduced -- the model's higher-fidelity mesh is simply always used.
====================
*/
function drawAliasSkeletonDepth(model: Md5ModelT, ent: EntityT): void {
  const backlerp = Math.min(Math.max(ent.backlerp, 0), 1);
  const skeleton = getSkeletonFrame(model, ent.oldframe, ent.frame, backlerp, 1 - backlerp);
  const position = vec3();
  const normal = vec3();

  for (const mesh of model.meshes) {
    const positions: Vec3[] = new Array(mesh.numVerts);
    for (let i = 0; i < mesh.numVerts; i++) {
      calcSkelVert(mesh.vertices[i], mesh, skeleton, position, normal);
      positions[i] = vec3(position[0], position[1], position[2]);
    }
    qgl.qglBegin(GL_TRIANGLES);
    for (let i = 0; i < mesh.numIndices; i++) {
      const vert = positions[mesh.indices[i]];
      if (vert) qgl.qglVertex3fv(vert);
    }
    qgl.qglEnd();
  }
}

/*
====================
GL_EyeToWorldMatrix

Inverse of the frame's world->eye matrix (gl_local.ts's r_world_matrix, which
R_SetupGL fills straight from GL_MODELVIEW_MATRIX). gl_shader.ts hands this
to the vertex stage so it can turn the fixed-function pipeline's eye-space
vertex position back into a world-space one -- the space both the light
positions and the shadow matrices above are expressed in.
====================
*/
export function GL_EyeToWorldMatrix(): Float32Array {
  return matrixInvertRigid(r_world_matrix);
}
