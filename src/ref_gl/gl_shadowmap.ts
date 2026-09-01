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
// ── Staged scope (deliberate, see this unit's report) ──────────────────────
// SHIPPING: cone/spot shadow lights only, cast by static world (BSP) brush
// geometry, into one depth-texture atlas. NOT shipping: omni/point shadow
// lights (they keep task #25's existing unoccluded contribution -- a working
// spot shadow beats a broken cube map), and alias/brush-model entities as
// CASTERS (they are still correctly SHADOWED, they just do not block light).
// In the shipped rerelease content this covers 475 of 925 shadow lights;
// every one of the other 450 renders exactly as it did before this unit.
//
// ── Why a single atlas and not one FBO per light ───────────────────────────
// GLSL 1.10 only guarantees sampler array indexing by a constant-index-
// expression, so `uniform sampler2D u_shadow[8]` indexed by the fragment
// loop's counter is not portable. One atlas texture sampled through per-light
// (offset, scale) rectangles needs exactly one sampler and one texture unit,
// and allocates its FBO once for the process rather than once per light.

import { qgl } from "./gl_image";
import { ri, glCvars, r_world_matrix } from "./gl_local";
import { type Vec3 } from "../shared/math";
import { PRINT_ALL } from "../shared/q_shared";
import { type DlightT } from "../client/ref";
import { type ModelT, type MsurfaceT, type GlpolyT, SURF_DRAWSKY, SURF_DRAWTURB } from "./gl_model";

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
  readonly size: number;
}

/*
====================
packShadowAtlas

Shelf packer: requests are placed left-to-right on a shelf whose height is
the first (largest) request that opened it, and a new shelf starts above when
the current one runs out of width. Callers pass requests already sorted
descending, which is what makes a shelf packer tight rather than merely
correct. Returns one slot per request, or null for any request that no
longer fits -- that light simply renders unshadowed, never garbage.
====================
*/
export function packShadowAtlas(sizes: readonly number[], atlasSize: number = SHADOW_ATLAS_SIZE): (AtlasSlotT | null)[] {
  const slots: (AtlasSlotT | null)[] = [];
  let shelfY = 0;
  let shelfHeight = 0;
  let cursorX = 0;

  for (const size of sizes) {
    if (size <= 0 || size > atlasSize) {
      slots.push(null);
      continue;
    }
    if (cursorX + size > atlasSize) {
      // close this shelf, open the next one above it
      shelfY += shelfHeight;
      shelfHeight = 0;
      cursorX = 0;
    }
    if (shelfY + size > atlasSize) {
      slots.push(null); // atlas full
      continue;
    }
    slots.push({ x: cursorX, y: shelfY, size });
    cursorX += size;
    if (size > shelfHeight) shelfHeight = size;
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

// --- live shadow-map state (real GL calls) --------------------------------

export interface ShadowMapBindingT {
  readonly lightIndex: number;
  readonly matrix: Float32Array;
  readonly slot: AtlasSlotT;
}

interface CachedShadowT {
  signature: string;
  slot: AtlasSlotT;
  matrix: Float32Array;
}

let shadowFbo = 0;
let shadowTexture = 0;
let shadowReady = false;
let shadowWarned = false;
const cached: (CachedShadowT | null)[] = [];
let activeBindings: ShadowMapBindingT[] = [];

export function GL_ShadowMapTexture(): number {
  return shadowTexture;
}

export function GL_ShadowMapsReady(): boolean {
  return shadowReady;
}

export function GL_ShadowMapBindings(): readonly ShadowMapBindingT[] {
  return activeBindings;
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

  if (glCvars.gl_shadowmaps && !glCvars.gl_shadowmaps.value) return false;

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
  // the GLSL at the #version 110 this renderer's shader path targets.
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

  cached.length = 0;
  shadowReady = true;
  return true;
}

export function GL_ShutdownShadowMaps(): void {
  if (shadowFbo && qgl.qglDeleteFramebuffers) qgl.qglDeleteFramebuffers(1, new Uint32Array([shadowFbo]));
  if (shadowTexture) qgl.qglDeleteTextures(1, new Uint32Array([shadowTexture]));
  shadowFbo = 0;
  shadowTexture = 0;
  shadowReady = false;
  cached.length = 0;
  activeBindings = [];
}

// Invalidates every cached depth map. Called on map change: the cache is
// keyed on light parameters, which say nothing about which world the
// geometry came from, so two maps whose lights happen to match would
// otherwise share a stale depth map.
export function GL_ShadowMapsNewMap(): void {
  cached.length = 0;
  activeBindings = [];
}

// A light's depth map only needs re-rendering when the light itself moves or
// changes shape. Intensity/colour/lightstyle flicker change none of that, so
// they are deliberately absent from the signature -- a strobing shadow light
// re-renders its depth map zero times per second, not sixty.
function shadowSignature(dl: DlightT, resolution: number): string {
  const cone = dl.cone;
  if (!cone) return "";
  const r = (v: number): string => v.toFixed(2);
  return `${r(dl.origin[0])},${r(dl.origin[1])},${r(dl.origin[2])};${r(cone.direction[0])},${r(cone.direction[1])},${r(cone.direction[2])};${r(cone.cosHalfAngle)};${r(dl.intensity)};${resolution}`;
}

function coneAngleDegrees(cosHalfAngle: number): number {
  return (Math.acos(Math.min(Math.max(cosHalfAngle, -1), 1)) * 180) / Math.PI;
}

/*
====================
R_RenderShadowMaps

Renders (or reuses) one depth map per shadowing light, then leaves the
framebuffer binding exactly as it found it. Must run BEFORE R_SetupGL: it
takes over the projection and modelview matrices and the viewport, and
R_SetupGL is what puts all three back for the scene proper.

Point lights are skipped by design (see the staged-scope note at the top of
this file), as is every light past MAX_SHADOW_MAPS and every light the atlas
has no room left for -- each of those simply keeps task #25's unoccluded
contribution rather than getting a wrong shadow.
====================
*/
export function R_RenderShadowMaps(worldmodel: ModelT | null, lights: readonly DlightT[], numLights: number): void {
  activeBindings = [];
  if (!shadowReady || !worldmodel) return;
  if (glCvars.gl_shadowmaps && !glCvars.gl_shadowmaps.value) return;

  const bindFramebuffer = qgl.qglBindFramebuffer;
  if (!bindFramebuffer) return;

  // pick the shadow-casting lights, largest map first so the shelf packs tight
  const resolutionCap = glCvars.gl_shadowmap_res ? glCvars.gl_shadowmap_res.value : SHADOW_RES_MAX;
  const candidates: { index: number; dl: DlightT; resolution: number }[] = [];
  const count = Math.min(numLights, lights.length, MAX_SHADOW_MAPS);
  for (let i = 0; i < count; i++) {
    const dl = lights[i];
    if (!dl || !dl.cone || dl.intensity <= 0) continue;
    candidates.push({ index: i, dl, resolution: shadowMapResolution(dl.resolution, resolutionCap) });
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => b.resolution - a.resolution);

  const slots = packShadowAtlas(candidates.map((c) => c.resolution));

  // Reuse a cached depth map whenever the light AND its atlas rectangle are
  // both unchanged; the rectangle matters because the cached texels live at
  // fixed atlas coordinates.
  const pending: { candidateIndex: number; slot: AtlasSlotT; matrix: Float32Array; signature: string }[] = [];
  const bindings: ShadowMapBindingT[] = [];

  for (let c = 0; c < candidates.length; c++) {
    const cand = candidates[c];
    const slot = slots[c];
    if (!cand || !slot) continue;
    const cone = cand.dl.cone;
    if (!cone) continue;

    const signature = shadowSignature(cand.dl, cand.resolution);
    const matrix = shadowLightMatrix(cand.dl.origin, cone.direction, coneAngleDegrees(cone.cosHalfAngle), cand.dl.intensity);
    const hit = cached[c];
    if (!hit || hit.signature !== signature || hit.slot.x !== slot.x || hit.slot.y !== slot.y || hit.slot.size !== slot.size) {
      pending.push({ candidateIndex: c, slot, matrix, signature });
    }
    cached[c] = { signature, slot, matrix };
    bindings.push({ lightIndex: cand.index, matrix, slot });
  }

  activeBindings = bindings;
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
  qgl.qglPolygonOffset(2, 4); // depth bias in the map itself; the shader adds a small constant one too
  qgl.qglDepthMask(true);

  for (const job of pending) {
    const cand = candidates[job.candidateIndex];
    if (!cand) continue;
    const cone = cand.dl.cone;
    if (!cone) continue;

    qgl.qglViewport(job.slot.x, job.slot.y, job.slot.size, job.slot.size);
    qgl.qglScissor(job.slot.x, job.slot.y, job.slot.size, job.slot.size);
    qgl.qglClear(GL_DEPTH_BUFFER_BIT);

    const far = Math.max(cand.dl.intensity, SHADOW_NEAR * 2);
    qgl.qglMatrixMode(GL_PROJECTION);
    qgl.qglLoadMatrixf(matrixPerspective(shadowFovForConeAngle(coneAngleDegrees(cone.cosHalfAngle)), SHADOW_NEAR, far));
    qgl.qglMatrixMode(GL_MODELVIEW);
    qgl.qglLoadMatrixf(matrixLookAt(cand.dl.origin, cone.direction));

    drawWorldDepth(worldmodel, cand.dl.origin, far);
  }

  qgl.qglDisable(GL_POLYGON_OFFSET_FILL);
  qgl.qglDisable(GL_SCISSOR_TEST);
  qgl.qglPolygonOffset(0, 0);
  qgl.qglDepthFunc(savedDepthFunc[0] ?? GL_LEQUAL);
  qgl.qglDepthRange(savedDepthRange[0] ?? 0, savedDepthRange[1] ?? 1);
  bindFramebuffer(GL_FRAMEBUFFER, previous[0] ?? 0);
}

/*
====================
drawWorldDepth

Position-only emission of every world surface inside the light's radius.
Sky and warped (liquid) surfaces are skipped: sky is the void behind the
level and would clamp every shadow to the skybox, and liquid surfaces are
vertex-animated at draw time so their static positions here would not match
what the eye pass shows anyway.

Culling is a plain per-vertex radius test rather than a light-frustum test:
this runs only when a light's depth map is actually (re)built -- effectively
once per light per level, since shipped shadow lights never move -- so the
cheaper, looser test costs nothing worth reclaiming.
====================
*/
function drawWorldDepth(worldmodel: ModelT, origin: Vec3, radius: number): void {
  const radiusSquared = radius * radius;

  for (let i = 0; i < worldmodel.numsurfaces; i++) {
    const surf: MsurfaceT | undefined = worldmodel.surfaces[i];
    if (!surf || !surf.polys) continue;
    if (surf.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) continue;

    for (let poly: GlpolyT | null = surf.polys; poly; poly = poly.next) {
      let anyInside = false;
      for (let v = 0; v < poly.numverts && !anyInside; v++) {
        const vert = poly.verts[v];
        if (!vert) continue;
        const dx = (vert[0] ?? 0) - origin[0];
        const dy = (vert[1] ?? 0) - origin[1];
        const dz = (vert[2] ?? 0) - origin[2];
        if (dx * dx + dy * dy + dz * dz <= radiusSquared) anyInside = true;
      }
      if (!anyInside) continue;

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
