// gl_shader.ts -- task #25 (v1.1.0): a GL2+ program-object shader path
// layered over ref_gl's classic GL1.1 fixed-function renderer. No .c analog
// in the original id Software source (ref_gl was fixed-function only) or in
// PORTING.md's file map; modeled on q2repro's src/refresh/shader.c (its
// GLSL permutation-program backend for the same job: per-pixel dynamic
// lighting for CS_SHADOWLIGHTS-fed lights, layered over the existing
// lightmap path). NO shadow mapping/casting -- that is v1.1.1's job per the
// brief; this only adds a per-pixel light *contribution* term.
//
// ── Shader-source ruling (investigated for this unit) ──────────────────
// The retail Q2Game.kpf ships 474 shader-ish files under progs/ (readable
// via zipfile.ts -- already proven for KPF fonts/BSPX, see
// test/bspx_kpf.test.ts). Inspected progs/default.shader and
// progs/common_glsl.inc directly: they are NOT GLSL or HLSL. They're
// written in Sam Villarreal's KEX-engine shader meta-language
// (begin_input/end_input, var_attrib, def_var_out, shader_main,
// outVarPosition, mul()/saturate()/frac() HLSL-style macros) that KEX's own
// (closed, unreleased) offline shader compiler transpiles into real
// GLSL/HLSL before it ever reaches a GPU driver. Nothing in the GPL sources
// or the KPF itself performs that transpilation -- consuming these files as
// shader source would mean reverse-engineering an unreleased preprocessor
// with no reference implementation to check output against, which is a
// license-laundering concern as much as an engineering one, not just a
// hard reverse-engineering problem. The shader set also targets a
// completely different rendering architecture (forward+ with
// bloom/SSAO/SMAA/motion-blur G-buffers) than this renderer's GL1.1
// immediate-mode fixed-function lineage. Ruling: WRITE MINIMAL OWN GLSL,
// modeled on q2repro's shader.c -- not feed the retail KPF shaders. No
// KPF-parsing code was added for this unit as a result: zipfile.ts's
// existing, already-tested extraction path is sufficient if a future unit
// ever needs progs/ for something else (e.g. the postprocess chain); there
// is nothing shader-specific left to build here.
//
// ── Vertex submission ruling ─────────────────────────────────────────────
// q2repro's C renderer already submits geometry through vertex-attribute
// arrays (`in vec4 a_pos`, etc -- see shader.c's write_vertex_shader), so
// its GLSL targets a core profile with custom attributes bound via
// glBindAttribLocation, plus std140 UBOs for transforms/lights. This
// renderer instead draws through GL1.1 immediate-mode calls (qglBegin/
// qglVertex3fv/qglTexCoord2f/qglColor4f -- see gl_rsurf.ts/gl_mesh.ts).
// Under the GL COMPATIBILITY profile (the only profile a plain
// dlopen("libGL.so.1") context without an explicit forward-compatible
// context request ever is), those calls already feed a GLSL shader's
// builtin gl_Vertex/gl_Normal/gl_Color/gl_MultiTexCoord0 inputs
// automatically -- zero changes needed to the existing draw-call vertex
// submission. Given that, this unit targets `#version 110` compatibility-
// profile GLSL using those builtins instead of q2repro's custom-attribute
// design, and needs neither vertex array objects nor buffer objects nor
// glBindAttribLocation: documented departure from mirroring q2repro's own
// vertex-submission model, justified by this renderer's different (older,
// immediate-mode) architecture. Light data (well under any GLSL
// uniform-array size limit) goes through plain `uniform vec3 name[N]`
// arrays set with individual glUniform3f/1f calls per light, no UBO
// needed -- MAX_SHADER_LIGHTS below caps the per-draw-call array size.
//
// ── Integration scope for this unit ───────────────────────────────────────
// World surfaces: fully wired -- gl_rsurf.ts's R_BlendLightmaps (the
// existing second lightmap-blend pass) activates GLS_WORLD_SURFACE once per
// frame and sets qglNormal3f from each surface's plane normal before its
// existing DrawGLPolyChain call, so the per-pixel lambert term is accurate
// per surface (Quake 2 world surfaces are planar, so one normal per surface
// is exact, not an approximation).
// Entity meshes: GLS_ENTITY_MESH (the per-pixel lambert permutation) is
// still infrastructure only, and for the reason this note has always given
// -- GL_DrawAliasFrameLerp has two vertex-submission paths (the
// gl_vertex_arrays client-array path and plain immediate mode) and feeding
// gl_Normal correctly needs a per-vertex normal threaded through both
// without disturbing either's delicate vertex data layout. An entity lit
// with a stale or default gl_Normal would look visibly wrong in a way
// nothing in this headless test suite could catch.
//
// v1.2.2 nonetheless makes alias models SHADOW receivers, through a
// different permutation that needs no normals at all: GLS_MODEL_SHADOW
// reproduces the fixed-function GL_MODULATE result exactly and subtracts
// each shadow light's measured share of the model's existing shade colour
// where the depth atlas says the fragment cannot see that light. Both mesh
// paths (MD2 lerp and MD5 skeleton) therefore submit byte-for-byte what
// they always did; the only change is which program is bound while they
// run, and none is bound at all unless a shadow light actually reaches the
// model. See GLS_MODEL_SHADOW's own comment and gl_shadowmap.ts's rule 2.

import { qgl } from "./gl_image";
import { ri, glCvars } from "./gl_local";
import { type Vec3, vec3 } from "../shared/math";
import { PRINT_ALL } from "../shared/q_shared";
import { type DlightT } from "../client/ref";
import {
  type ShadowMapBindingT,
  GL_ShadowMapBindings,
  GL_ShadowMapsReady,
  GL_ShadowMapTexture,
  GL_EyeToWorldMatrix,
  SHADOW_ATLAS_SIZE,
  SHADOW_NEAR,
  SHADOW_CUBE_COLS,
  SHADOW_CUBE_ROWS,
  SHADOW_KIND_NONE,
} from "./gl_shadowmap";

const GL_TEXTURE0 = 0x84c0;
const GL_TEXTURE1 = 0x84c1;
const GL_TEXTURE_2D = 0x0de1;

// Same well-known falloff-cutoff constant as gl_light.ts's private
// DLIGHT_CUTOFF (not exported there -- duplicated here rather than
// widening that file's export surface for a value this module also needs;
// both mirror q2repro shader.c's `#define DLIGHT_CUTOFF 64`).
const DLIGHT_CUTOFF = 64;

const GL_VERTEX_SHADER = 0x8b31;
const GL_FRAGMENT_SHADER = 0x8b30;
const GL_COMPILE_STATUS = 0x8b81;
const GL_LINK_STATUS = 0x8b82;

// Per-draw-call light cap. Q2's own MAX_DLIGHTS is 32 (ref.ts); q2repro
// caps its GLSL array the same way (MAX_DLIGHTS in its Uniforms block).
// This unit caps lower since every uniform is set with an individual
// glUniform call (no UBO, see header ruling) and layers 1-2 target
// CS_SHADOWLIGHTS-fed lights, which are few per level by design.
export const MAX_SHADER_LIGHTS = 8;

// --- permutation bits -------------------------------------------------
//
// q2repro's shader.c has a much larger bit space (fog, bloom, warp, skel
// meshes, sky, scroll, ...) that this renderer's fixed-function path
// already handles some other way and this unit doesn't touch -- kept to
// exactly the two combinations layers 1-2 actually use.
export const GLS_LIGHTMAP = 1 << 0;
export const GLS_DYNAMIC_LIGHTS = 1 << 1;
// v1.1.0: sample gl_shadowmap.ts's depth atlas to occlude each shadow light --
// a cone light through its own light matrix, a point light through the six
// cube faces packed into its atlas rectangle.
// A separate bit rather than a change to GLS_DYNAMIC_LIGHTS so the
// unshadowed permutation stays compiled and available as the fallback when
// the shadow permutation won't build on a given context.
export const GLS_SHADOWMAP = 1 << 2;
// v1.2.2: the alias-model receiver. Same depth atlas, same per-fragment
// occlusion test as GLS_SHADOWMAP, but applied to an alias model's existing
// fixed-function shade colour instead of to a per-pixel lambert term.
//
// Why a fourth bit rather than reusing GLS_SHADOWMAP with GLS_DYNAMIC_LIGHTS
// cleared: the two receivers answer different questions. A world surface has
// a real per-fragment normal (its plane's, uploaded per surface) and gets its
// shadow light as an ADDED per-pixel lambert term, so occluding it means
// scaling that term. An alias model is shaded by gl_mesh.ts's 1997 pipeline
// -- one R_LightPoint colour for the whole model, times the per-vertex
// r_avertexnormal_dots value -- and has no per-fragment normal to build a
// lambert term from; the shadow lights are already IN that colour, mixed
// with the lightmap sample. So this permutation occludes by REMOVING each
// shadow light's known share of the shade colour (u_light_frac[i], measured
// CPU-side in gl_mesh.ts), which needs no vertex normals and therefore no
// change at all to either mesh path's vertex submission -- the thing this
// file's original header flagged as the blocker on entity meshes.
//
// Never combined with GLS_SHADOWMAP or GLS_DYNAMIC_LIGHTS: it is the whole
// fragment program for a model, not a term added to another one.
export const GLS_MODEL_SHADOW = 1 << 3;

export type GlShaderBits = number;

export const GLS_WORLD_SURFACE: GlShaderBits = GLS_LIGHTMAP | GLS_DYNAMIC_LIGHTS;
export const GLS_WORLD_SURFACE_SHADOWED: GlShaderBits = GLS_LIGHTMAP | GLS_DYNAMIC_LIGHTS | GLS_SHADOWMAP;
export const GLS_ENTITY_MESH: GlShaderBits = GLS_DYNAMIC_LIGHTS;
export const GLS_ENTITY_MESH_SHADOWED: GlShaderBits = GLS_MODEL_SHADOW;

// Constant depth bias applied on top of the depth pass's own glPolygonOffset,
// in the [0,1] window-depth space the atlas stores. Small on purpose:
// polygon offset already does the slope-dependent work, and a large constant
// bias here is what produces peter-panning (shadows detaching from their
// caster's base).
export const SHADOW_DEPTH_BIAS = 0.0005;

// A point light's bias, in WORLD units rather than window depth. The cube
// path inverts the stored depth back to a distance along the face axis (see
// gl_shadowmap.ts's shadowCubeDepthCoefficients), which is exactly what makes
// this possible -- a constant window-depth bias like the cone path's would be
// worth 0.1 units next to the light and 30 units at the far plane, because
// perspective depth is distributed as 1/distance.
//
// The constant term covers texel quantization; the texel term covers slope,
// and is expressed in FACE TEXELS so that halving a light's face resolution
// (which fitCandidatesToAtlas does under atlas pressure) widens the bias to
// match instead of breaking out in acne.
export const SHADOW_CUBE_BIAS = 1.0;
export const SHADOW_CUBE_BIAS_TEXELS = 2.0;

// The same two biases, widened for the alias-model receiver.
//
// A model receives a depth map that it is ITSELF rasterized into, so unlike a
// world surface it self-shadows: the depth stored for a soldier's chest and
// the depth the eye pass reconstructs for that same chest are the same
// surface, and any disagreement between them paints acne straight down the
// lit side of the model. Three things make that disagreement bigger than the
// world's:
//
//   * gl_shadowmap.ts deliberately gives entity casters a GENTLER polygon
//     offset than the world (SHADOW_OFFSET_ENTITY_*: 1/2 against the world's
//     2/4), to keep a model's shadow attached to the floor it stands on.
//     That offset is not raised here -- doing so would move every shadow this
//     unit did not set out to change -- so the receiver side makes up the
//     difference.
//   * a model is a curved shell, so the depth slope across one shadow texel
//     is far larger than across a flat BSP floor.
//   * a model's own frame lerps and skinning run in floating point on the CPU
//     twice (once for the depth pass, once for the eye pass); they agree to
//     the same arithmetic, but the two rasterizations do not land on the same
//     sub-texel.
//
// 5x the world's constants, which is what stopped the acne on a soldier at
// point-blank range to a 512-texel face on this renderer's own test map
// without visibly detaching the shadow from anything (peter-panning on a
// model shows up as light leaking under a limb, and does not at this value).
export const SHADOW_MODEL_DEPTH_BIAS = 0.0025;
export const SHADOW_MODEL_CUBE_BIAS = 5.0;
export const SHADOW_MODEL_CUBE_BIAS_TEXELS = 6.0;

// --- uniform-binding table (pure data) ---------------------------------
//
// Exactly which uniforms a given permutation's GLSL declares. Verified in
// test/gl_shaders.test.ts to stay in lockstep with
// buildFragmentShaderSource's actual `uniform` lines -- the "uniform-
// binding table correctness" leg of this unit's headless verification
// (real compilation can't run without a GPU context; this can).
export interface UniformBindingT {
  readonly name: string;
  readonly kind: "sampler2D" | "vec3[]" | "float[]" | "vec4[]" | "mat4[]" | "mat4" | "float" | "int";
}

export function uniformBindingsFor(bits: GlShaderBits): UniformBindingT[] {
  const bindings: UniformBindingT[] = [
    { name: bits & GLS_LIGHTMAP ? "u_lightmap" : "u_texture", kind: "sampler2D" },
    // Every permutation needs it: the fixed-function pipeline hands the
    // vertex stage an EYE-space position, and all of this file's light math
    // is in world space (see buildVertexShaderSource).
    { name: "u_eye_to_world", kind: "mat4" },
  ];
  if (bits & GLS_DYNAMIC_LIGHTS) {
    bindings.push(
      { name: "u_light_count", kind: "int" },
      { name: "u_light_pos", kind: "vec3[]" },
      { name: "u_light_radius", kind: "float[]" },
      { name: "u_light_color", kind: "vec3[]" },
      { name: "u_light_scale", kind: "float[]" },
      { name: "u_light_cone_dir", kind: "vec3[]" },
      { name: "u_light_cone_cos", kind: "float[]" },
    );
  }
  if (bits & (GLS_SHADOWMAP | GLS_MODEL_SHADOW)) {
    bindings.push(
      { name: "u_shadow_map", kind: "sampler2D" },
      { name: "u_shadow_texel", kind: "float" },
      { name: "u_light_matrix", kind: "mat4[]" },
      { name: "u_light_atlas", kind: "vec4[]" },
      { name: "u_light_shadow", kind: "float[]" },
    );
  }
  if (bits & GLS_MODEL_SHADOW) {
    // The model permutation has no GLS_DYNAMIC_LIGHTS block to borrow these
    // from, but the shared shadow-factor GLSL still reads u_light_pos and
    // u_light_radius (the point-light path derives its cube face and its
    // depth coefficients from them) and still needs u_light_count to know
    // where the loop stops.
    bindings.push(
      { name: "u_light_count", kind: "int" },
      { name: "u_light_pos", kind: "vec3[]" },
      { name: "u_light_radius", kind: "float[]" },
      // per-channel share of this model's shade colour that light i put
      // there -- see GLS_MODEL_SHADOW's comment and gl_mesh.ts's
      // aliasShadowLights().
      { name: "u_light_frac", kind: "vec3[]" },
      // gl_mesh.ts's aliasShadeDivisor: the headroom the mesh paths divided
      // the vertex colour by so it would survive glColor4f's [0,1] clamp.
      // Multiplied straight back out below.
      { name: "u_shade_scale", kind: "float" },
    );
  }
  return bindings;
}

// --- pure GLSL source assembly ------------------------------------------

export function buildVertexShaderSource(bits: GlShaderBits): string {
  const lines: string[] = ["#version 110", "uniform mat4 u_eye_to_world;", "varying vec3 v_world_pos;"];
  if (bits & GLS_DYNAMIC_LIGHTS) lines.push("varying vec3 v_normal;");
  lines.push("void main() {");
  // gl_ModelViewMatrix * gl_Vertex is an EYE-space position, but every light
  // uniform below (and every shadow matrix) is in WORLD space -- the light
  // origins come straight from the entity's s.origin. Multiplying the eye
  // position by the inverse of the frame's view matrix puts the fragment
  // back in the space the lights live in. Doing this rather than
  // pre-transforming the lights into eye space CPU-side keeps the shadow
  // matrices independent of the camera, so they survive frame to frame in
  // gl_shadowmap.ts's depth-map cache.
  lines.push("  v_world_pos = vec3(u_eye_to_world * (gl_ModelViewMatrix * gl_Vertex));");
  if (bits & GLS_DYNAMIC_LIGHTS) {
    // Same round trip for the normal: gl_NormalMatrix takes it to eye space,
    // the rotation part of u_eye_to_world brings it back. For world surfaces
    // this returns the plane normal qglNormal3f supplied; for a ROTATED
    // brush model it correctly keeps the entity's rotation, which is why
    // this is a round trip rather than just `normalize(gl_Normal)`.
    // mat3(vec3,vec3,vec3) (column constructor) is GLSL 1.10; mat3(mat4) is
    // 1.20 and deliberately avoided.
    lines.push("  mat3 rot = mat3(u_eye_to_world[0].xyz, u_eye_to_world[1].xyz, u_eye_to_world[2].xyz);");
    lines.push("  v_normal = normalize(rot * (gl_NormalMatrix * gl_Normal));");
  }
  lines.push("  gl_TexCoord[0] = gl_MultiTexCoord0;");
  lines.push("  gl_FrontColor = gl_Color;");
  // ftransform(), NOT `gl_ModelViewProjectionMatrix * gl_Vertex`. The world
  // is drawn in two coplanar passes: R_RenderBrushPoly emits the texture
  // pass through the fixed-function pipeline, then R_BlendLightmaps re-emits
  // the SAME polygons through this program. GLSL 1.10 section 8.10 only
  // guarantees a vertex shader's position matches the fixed-function
  // pipeline's when the shader computes it with ftransform(); an explicit
  // matrix multiply is free to differ in the last bits, and on NVIDIA it
  // does -- the second pass then z-fights the first over whole surfaces and
  // paints the diagonal moire/striping and thin hanging lines this renderer
  // showed at gl_shaders 1.
  lines.push("  gl_Position = ftransform();");
  lines.push("}");
  return lines.join("\n");
}

/*
====================
shadowSamplerUniformLines / shadowFactorLines

The depth-atlas half of the fragment stage, factored out of
buildFragmentShaderSource so the world receiver (GLS_SHADOWMAP) and the
alias-model receiver (GLS_MODEL_SHADOW) sample the atlas through the SAME
text. Two receivers that disagree about which cube face a point is on, or
about how a stored window depth inverts to a distance, would put a model's
shadow boundary in a different place from the floor's directly under it --
the one artifact a "models receive too" change most obviously produces.

Only the bias #defines differ between the two, which is why they are the
helper's one parameter: a model self-shadows and a world surface does not
(see SHADOW_MODEL_DEPTH_BIAS).

shadowFactorLines emits the body of `if (u_light_shadow[i] != 0.0) {`,
leaving a `float lit` in scope at the caller's indentation and leaving the
caller to both open that `if` and close it after using `lit`.
====================
*/
function shadowSamplerUniformLines(modelBias: boolean): string[] {
  const depthBias = modelBias ? SHADOW_MODEL_DEPTH_BIAS : SHADOW_DEPTH_BIAS;
  const cubeBias = modelBias ? SHADOW_MODEL_CUBE_BIAS : SHADOW_CUBE_BIAS;
  const cubeBiasTexels = modelBias ? SHADOW_MODEL_CUBE_BIAS_TEXELS : SHADOW_CUBE_BIAS_TEXELS;
  return [
    `uniform sampler2D u_shadow_map;`,
    `uniform float u_shadow_texel;`,
    `uniform mat4 u_light_matrix[${MAX_SHADER_LIGHTS}];`,
    // xy = this light's atlas rectangle origin, zw = its size, both already
    // normalized to [0,1] atlas UV by the caller
    `uniform vec4 u_light_atlas[${MAX_SHADER_LIGHTS}];`,
    // The light's KIND: 0 for a light with no atlas rectangle (one the
    // atlas had no room for -- it keeps the unoccluded contribution rather
    // than being wrongly shadowed), 1 for a cone light, 2 for a point
    // light. A code rather than a second uniform array: the two kinds
    // share every other uniform they need.
    `uniform float u_light_shadow[${MAX_SHADER_LIGHTS}];`,
    `#define SHADOW_DEPTH_BIAS ${depthBias}`,
    `#define SHADOW_NEAR ${SHADOW_NEAR.toFixed(1)}`,
    `#define SHADOW_CUBE_BIAS ${cubeBias.toFixed(1)}`,
    `#define SHADOW_CUBE_BIAS_TEXELS ${cubeBiasTexels.toFixed(1)}`,
    `#define SHADOW_CUBE_COLS ${SHADOW_CUBE_COLS.toFixed(1)}`,
    `#define SHADOW_CUBE_ROWS ${SHADOW_CUBE_ROWS.toFixed(1)}`,
  ];
}

function shadowFactorLines(): string[] {
  return [
    // 1.0 == unoccluded. Every path below either leaves it there (the
    // fragment is outside this light's depth data, where a guess is what
    // paints hard black rectangles at map edges) or replaces it with the
    // 2x2 percentage-closer average.
    `      float lit = 1.0;`,
    `      vec2 rect_lo = u_light_atlas[i].xy;`,
    `      vec2 rect_size = u_light_atlas[i].zw;`,
    `      if (u_light_shadow[i] < 1.5) {`,
    // ---- cone light: one perspective depth map, one matrix ----
    `        vec4 lpos = u_light_matrix[i] * vec4(v_world_pos, 1.0);`,
    `        if (lpos.w > 0.0) {`,
    `          vec3 lproj = lpos.xyz / lpos.w;`,
    `          if (lproj.x >= 0.0 && lproj.x <= 1.0 && lproj.y >= 0.0 && lproj.y <= 1.0 && lproj.z <= 1.0) {`,
    `            vec2 base = lproj.xy * rect_size + rect_lo;`,
    // Clamp each filter tap inside this light's own rectangle. Without
    // it a tap half a texel past the edge reads the NEIGHBOURING light's
    // depth map, which is how a shadow from one light appears as a
    // one-texel fringe along another's.
    `            vec2 tap_lo = rect_lo + u_shadow_texel;`,
    `            vec2 tap_hi = rect_lo + rect_size - u_shadow_texel;`,
    `            lit = 0.0;`,
    `            for (int sy = 0; sy < 2; sy++) {`,
    `              for (int sx = 0; sx < 2; sx++) {`,
    `                vec2 off = (vec2(float(sx), float(sy)) - 0.5) * u_shadow_texel;`,
    `                float d = texture2D(u_shadow_map, clamp(base + off, tap_lo, tap_hi)).r;`,
    `                lit += (lproj.z - SHADOW_DEPTH_BIAS) > d ? 0.0 : 1.0;`,
    `              }`,
    `            }`,
    `            lit *= 0.25;`,
    `          }`,
    `        }`,
    `      } else {`,
    // ---- point light: six 90-degree faces, 3x2 inside one rectangle ----
    // The face basis table below is gl_shadowmap.ts's CUBE_FACE_BASIS,
    // and the major-axis tie rules are cubeFaceForDirection's, both
    // written out because a fragment that picked a different face than
    // the depth pass rasterized would read a neighbouring face's texels.
    `        vec3 lvec = v_world_pos - u_light_pos[i];`,
    `        vec3 lmag = abs(lvec);`,
    `        vec3 face_f;`,
    `        vec3 face_r;`,
    `        vec3 face_u;`,
    `        float face;`,
    `        if (lmag.x >= lmag.y && lmag.x >= lmag.z) {`,
    `          if (lvec.x >= 0.0) { face_f = vec3(1.0, 0.0, 0.0); face_r = vec3(0.0, -1.0, 0.0); face_u = vec3(0.0, 0.0, 1.0); face = 0.0; }`,
    `          else { face_f = vec3(-1.0, 0.0, 0.0); face_r = vec3(0.0, 1.0, 0.0); face_u = vec3(0.0, 0.0, 1.0); face = 1.0; }`,
    `        } else if (lmag.y >= lmag.z) {`,
    `          if (lvec.y >= 0.0) { face_f = vec3(0.0, 1.0, 0.0); face_r = vec3(1.0, 0.0, 0.0); face_u = vec3(0.0, 0.0, 1.0); face = 2.0; }`,
    `          else { face_f = vec3(0.0, -1.0, 0.0); face_r = vec3(-1.0, 0.0, 0.0); face_u = vec3(0.0, 0.0, 1.0); face = 3.0; }`,
    `        } else {`,
    `          if (lvec.z >= 0.0) { face_f = vec3(0.0, 0.0, 1.0); face_r = vec3(0.0, 1.0, 0.0); face_u = vec3(1.0, 0.0, 0.0); face = 4.0; }`,
    `          else { face_f = vec3(0.0, 0.0, -1.0); face_r = vec3(0.0, -1.0, 0.0); face_u = vec3(1.0, 0.0, 0.0); face = 5.0; }`,
    `        }`,
    `        float axial = dot(lvec, face_f);`,
    `        if (axial > SHADOW_NEAR) {`,
    // matrixPerspective's third row, with w divided out: the depth pass
    // stored 0.5 * (-pa + pb / axial) + 0.5, so the stored value inverts
    // back to a distance and the comparison happens in world units.
    `          float zfar = max(u_light_radius[i], SHADOW_NEAR * 2.0);`,
    `          float pa = (zfar + SHADOW_NEAR) / (SHADOW_NEAR - zfar);`,
    `          float pb = (2.0 * zfar * SHADOW_NEAR) / (SHADOW_NEAR - zfar);`,
    `          vec2 cell_size = rect_size / vec2(SHADOW_CUBE_COLS, SHADOW_CUBE_ROWS);`,
    `          vec2 cell_lo = rect_lo + vec2(mod(face, SHADOW_CUBE_COLS), floor(face / SHADOW_CUBE_COLS)) * cell_size;`,
    // tan(45) == 1 for a square 90-degree frustum, so the face UV is just
    // the two off-axis components over the axial one
    `          vec2 face_uv = vec2(dot(lvec, face_r), dot(lvec, face_u)) / axial * 0.5 + 0.5;`,
    `          vec2 base = cell_lo + face_uv * cell_size;`,
    // taps clamp inside this FACE's cell, not just the light's rectangle:
    // the five neighbouring faces are the nearest wrong answers there
    `          vec2 tap_lo = cell_lo + u_shadow_texel;`,
    `          vec2 tap_hi = cell_lo + cell_size - u_shadow_texel;`,
    `          float face_texels = cell_size.x / u_shadow_texel;`,
    `          float bias = SHADOW_CUBE_BIAS + axial * (2.0 / face_texels) * SHADOW_CUBE_BIAS_TEXELS;`,
    `          lit = 0.0;`,
    `          for (int sy = 0; sy < 2; sy++) {`,
    `            for (int sx = 0; sx < 2; sx++) {`,
    `              vec2 off = (vec2(float(sx), float(sy)) - 0.5) * u_shadow_texel;`,
    `              float d = texture2D(u_shadow_map, clamp(base + off, tap_lo, tap_hi)).r;`,
    `              float stored = pb / ((2.0 * d - 1.0) + pa);`,
    `              lit += (axial - bias) > stored ? 0.0 : 1.0;`,
    `            }`,
    `          }`,
    `          lit *= 0.25;`,
    `        }`,
    `      }`,
  ];
}

// Fragment stage's `calc_dynamic_lights()`-equivalent GLSL loop below is a
// direct line-for-line port of q2repro's src/refresh/shader.c
// write_dynamic_lights() (point falloff + optional spot-cone term); see
// this file's calcDynamicLightContribution/pointLightFalloff/
// spotConeAttenuation for the same math extracted as pure, unit-tested TS
// functions (compilation can't run headlessly; the math can be verified).
export function buildFragmentShaderSource(bits: GlShaderBits): string {
  const lines: string[] = ["#version 110", "varying vec3 v_world_pos;"];
  if (bits & GLS_DYNAMIC_LIGHTS) lines.push("varying vec3 v_normal;");
  lines.push(`uniform sampler2D ${bits & GLS_LIGHTMAP ? "u_lightmap" : "u_texture"};`);

  if (bits & (GLS_SHADOWMAP | GLS_MODEL_SHADOW)) {
    lines.push(...shadowSamplerUniformLines((bits & GLS_MODEL_SHADOW) !== 0));
  }

  if (bits & GLS_MODEL_SHADOW) {
    lines.push(
      `uniform int u_light_count;`,
      `uniform vec3 u_light_pos[${MAX_SHADER_LIGHTS}];`,
      `uniform float u_light_radius[${MAX_SHADER_LIGHTS}];`,
      `uniform vec3 u_light_frac[${MAX_SHADER_LIGHTS}];`,
      `uniform float u_shade_scale;`,
    );
  }

  if (bits & GLS_DYNAMIC_LIGHTS) {
    lines.push(
      `uniform int u_light_count;`,
      `uniform vec3 u_light_pos[${MAX_SHADER_LIGHTS}];`,
      `uniform float u_light_radius[${MAX_SHADER_LIGHTS}];`,
      `uniform vec3 u_light_color[${MAX_SHADER_LIGHTS}];`,
      `uniform float u_light_scale[${MAX_SHADER_LIGHTS}];`,
      `uniform vec3 u_light_cone_dir[${MAX_SHADER_LIGHTS}];`,
      `uniform float u_light_cone_cos[${MAX_SHADER_LIGHTS}];`,
      `#define DLIGHT_CUTOFF ${DLIGHT_CUTOFF.toFixed(1)}`,
      `vec3 calc_dynamic_lights() {`,
      `  vec3 shade = vec3(0.0);`,
      `  for (int i = 0; i < ${MAX_SHADER_LIGHTS}; i++) {`,
      `    if (i >= u_light_count) break;`,
      `    vec3 light_pos = u_light_pos[i];`,
      `    float light_cone = u_light_cone_cos[i];`,
      `    if (light_cone == 0.0) light_pos += v_normal * 16.0;`,
      `    vec3 light_dir = light_pos - v_world_pos;`,
      `    float dist = length(light_dir);`,
      `    float radius = u_light_radius[i] + DLIGHT_CUTOFF;`,
      `    float len = max(radius - dist - DLIGHT_CUTOFF, 0.0) / radius;`,
      `    vec3 dir = light_dir / max(dist, 1.0);`,
      `    float lambert = u_light_color[i].r < 0.0 ? 1.0 : max(dot(v_normal, dir), 0.0);`,
      `    vec3 result = (u_light_color[i] * u_light_scale[i]) * len * lambert;`,
      `    if (light_cone != 0.0) {`,
      `      float mag = -dot(dir, u_light_cone_dir[i]);`,
      `      result *= max(1.0 - (1.0 - mag) * (1.0 / (1.0 - light_cone)), 0.0);`,
      `    }`,
    );

    if (bits & GLS_SHADOWMAP) {
      // Inlined rather than factored into a `float shadow_factor(int i)`
      // helper on purpose: GLSL 1.10 only promises array indexing by a
      // constant-index-expression, and a loop counter passed through a
      // function parameter is no longer one on every compiler. Kept in the
      // loop body it is the same expression form the light-uniform reads
      // above already rely on.
      lines.push(`    if (u_light_shadow[i] != 0.0) {`, ...shadowFactorLines(), `      result *= lit;`, `    }`);
    }

    lines.push(
      `    shade += result;`,
      `  }`,
      `  return shade;`,
      `}`,
    );
  }

  lines.push("void main() {");
  if (bits & GLS_LIGHTMAP) {
    lines.push("  vec3 lm = texture2D(u_lightmap, gl_TexCoord[0].st).rgb;");
    if (bits & GLS_DYNAMIC_LIGHTS) lines.push("  lm += calc_dynamic_lights();");
    lines.push("  gl_FragColor = vec4(lm, 1.0);");
  } else if (bits & GLS_MODEL_SHADOW) {
    // The alias path's texture environment is GL_MODULATE: the fixed-function
    // result is `texel * clamp(l * shadelight)`, where l is the per-vertex
    // r_avertexnormal_dots (or MD5 shadedot) value and the clamp is
    // glColor4f's own, to [0,1].
    //
    // The ORDER of that clamp is the whole design of this program. A shadow
    // light's contribution is part of `shadelight`, and shadelight commonly
    // exceeds 1 -- R_LightPoint's dynamic-light term is
    // (intensity - distance) / 256, which is 2.6 at 100 units from a
    // 768-radius light -- so a lit model reaches the vertex stage already
    // saturated at (1,1,1). Removing the light's SHARE from that saturated
    // white removes a share of a value the light never reached, and because
    // the shipped shadow lights are orange (blue 0.5) it takes proportionally
    // less blue than red: the leftover reads blue-purple instead of the warm
    // lightmap-only colour. So gl_mesh.ts hands the colour over divided by
    // u_shade_scale (its aliasShadeDivisor), this multiplies it back to the
    // true l * shadelight, the light's share comes off THERE, and the clamp
    // happens last -- min(1, l * (shadelight - removed)), which is what the
    // fixed-function path would have submitted had the light not reached the
    // model at all.
    //
    // With nothing occluded that reduces to min(1, l * shadelight): the
    // fixed-function result, term for term.
    //
    // The texel is called `texel` and not `base` because shadowFactorLines()
    // declares its own `vec2 base` inside the sampling scopes. GLSL 1.10
    // would let the inner declaration shadow an outer one legally, but a
    // fragment program whose correctness rests on a reader spotting which
    // `base` is in scope is not one to ship.
    lines.push(
      `  vec4 texel = texture2D(u_texture, gl_TexCoord[0].st);`,
      `  vec3 shade = gl_Color.rgb * u_shade_scale;`,
      `  vec3 keep = vec3(1.0);`,
      `  for (int i = 0; i < ${MAX_SHADER_LIGHTS}; i++) {`,
      `    if (i >= u_light_count) break;`,
      `    if (u_light_shadow[i] != 0.0) {`,
      ...shadowFactorLines(),
      `      keep -= u_light_frac[i] * (1.0 - lit);`,
      `    }`,
      `  }`,
      // Two lights whose measured shares happen to sum past 1 (they can: the
      // shares are measured against a shade colour that RF_MINLIGHT or
      // RF_GLOW may have raised afterwards) must clamp to black, not wrap
      // into negative colour.
      `  shade *= max(keep, vec3(0.0));`,
      `  gl_FragColor = vec4(texel.rgb * min(shade, vec3(1.0)), texel.a * gl_Color.a);`,
    );
  } else {
    lines.push("  vec4 base = texture2D(u_texture, gl_TexCoord[0].st) * gl_Color;");
    if (bits & GLS_DYNAMIC_LIGHTS) lines.push("  base.rgb += calc_dynamic_lights();");
    lines.push("  gl_FragColor = base;");
  }
  lines.push("}");
  return lines.join("\n");
}

// --- pure per-pixel light math (calc_dynamic_lights, extracted) ---------

// Mirrors q2repro shader.c's calc_dynamic_lights() point-light falloff:
// `radius = light.radius + CUTOFF; len = max(radius - dist - CUTOFF, 0) /
// radius`.
export function pointLightFalloff(dist: number, radius: number): number {
  const effectiveRadius = radius + DLIGHT_CUTOFF;
  return Math.max(effectiveRadius - dist - DLIGHT_CUTOFF, 0) / effectiveRadius;
}

// Mirrors calc_dynamic_lights()'s spot-cone term. `dirFragToLight` is the
// GLSL's `dir` (unit vector from the fragment toward the light);
// `coneDirection` is the light's forward spot axis; `coneCos` is cos(half
// angle) (q2repro's `dl->conecos`).
export function spotConeAttenuation(dirFragToLight: Vec3, coneDirection: Vec3, coneCos: number): number {
  const mag = -(dirFragToLight[0] * coneDirection[0] + dirFragToLight[1] * coneDirection[1] + dirFragToLight[2] * coneDirection[2]);
  if (coneCos >= 1) return 0; // degenerate zero-width cone, avoid divide-by-zero
  return Math.max(1 - (1 - mag) * (1 / (1 - coneCos)), 0);
}

export interface DynamicLightSample {
  readonly origin: Vec3;
  readonly radius: number;
  readonly color: Vec3; // 0..1, matching q2repro's dl->color (red < 0 is the fullbright sentinel, see below)
  readonly scale: number; // q2repro's dl->intensity
  readonly cone: { readonly direction: Vec3; readonly cosHalfAngle: number } | null;
}

// Mirrors calc_dynamic_lights() in full: falloff * lambert * intensity *
// color, times an optional cone attenuation. `color.r < 0` is q2repro's
// sentinel for "fullbright, skip the lambert term" (e.g. effects.c's
// tracker-trail lights use color (-1,-1,-1)); CS_SHADOWLIGHTS-fed lights
// never set this (their color is always unpacked 0..1 from an entity
// skinnum), kept here only for parity with the shared formula this mirrors.
export function calcDynamicLightContribution(light: DynamicLightSample, fragPos: Vec3, normal: Vec3): Vec3 {
  const lightPos: Vec3 = light.cone ? light.origin : vec3(light.origin[0] + normal[0] * 16, light.origin[1] + normal[1] * 16, light.origin[2] + normal[2] * 16);

  const lightDir = vec3(lightPos[0] - fragPos[0], lightPos[1] - fragPos[1], lightPos[2] - fragPos[2]);
  const dist = Math.hypot(lightDir[0], lightDir[1], lightDir[2]);
  const len = pointLightFalloff(dist, light.radius);
  const invDist = 1 / Math.max(dist, 1);
  const dir = vec3(lightDir[0] * invDist, lightDir[1] * invDist, lightDir[2] * invDist);

  const lambert = light.color[0] < 0 ? 1 : Math.max(dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2], 0);

  let scale = len * lambert * light.scale;
  if (light.cone) {
    scale *= spotConeAttenuation(dir, light.cone.direction, light.cone.cosHalfAngle);
  }
  return vec3(light.color[0] * scale, light.color[1] * scale, light.color[2] * scale);
}

// --- program compile/link/cache (real GL calls; untestable headlessly) --

interface CompiledProgram {
  readonly program: number;
  readonly uniforms: ReadonlyMap<string, number>;
}

const programCache = new Map<GlShaderBits, CompiledProgram | null>();
let shaderPathActive = false;

function compileStage(type: number, source: string): number | null {
  if (!qgl.qglCreateShader || !qgl.qglShaderSource || !qgl.qglCompileShader || !qgl.qglGetShaderiv || !qgl.qglGetShaderInfoLog || !qgl.qglDeleteShader) return null;
  const shader = qgl.qglCreateShader(type);
  if (!shader) return null;
  qgl.qglShaderSource(shader, source);
  qgl.qglCompileShader(shader);
  const status = new Int32Array(1);
  qgl.qglGetShaderiv(shader, GL_COMPILE_STATUS, status);
  if (!status[0]) {
    const log = qgl.qglGetShaderInfoLog(shader);
    if (log) ri.Con_Printf(PRINT_ALL, `${log}\n`);
    qgl.qglDeleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(bits: GlShaderBits): CompiledProgram | null {
  if (!qgl.qglCreateProgram || !qgl.qglAttachShader || !qgl.qglLinkProgram || !qgl.qglGetProgramiv || !qgl.qglGetProgramInfoLog || !qgl.qglDeleteProgram || !qgl.qglGetUniformLocation) {
    return null;
  }

  const vs = compileStage(GL_VERTEX_SHADER, buildVertexShaderSource(bits));
  if (vs === null) return null;
  const fs = compileStage(GL_FRAGMENT_SHADER, buildFragmentShaderSource(bits));
  if (fs === null) {
    if (qgl.qglDeleteShader) qgl.qglDeleteShader(vs);
    return null;
  }

  const program = qgl.qglCreateProgram();
  if (!program) {
    if (qgl.qglDeleteShader) {
      qgl.qglDeleteShader(vs);
      qgl.qglDeleteShader(fs);
    }
    return null;
  }

  qgl.qglAttachShader(program, vs);
  qgl.qglAttachShader(program, fs);
  qgl.qglLinkProgram(program);
  if (qgl.qglDeleteShader) {
    qgl.qglDeleteShader(vs);
    qgl.qglDeleteShader(fs);
  }

  const status = new Int32Array(1);
  qgl.qglGetProgramiv(program, GL_LINK_STATUS, status);
  if (!status[0]) {
    const log = qgl.qglGetProgramInfoLog(program);
    if (log) ri.Con_Printf(PRINT_ALL, `${log}\n`);
    qgl.qglDeleteProgram(program);
    return null;
  }

  const uniforms = new Map<string, number>();
  const getLocation = qgl.qglGetUniformLocation;
  for (const binding of uniformBindingsFor(bits)) {
    uniforms.set(binding.name, getLocation(program, binding.name));
    // Array uniforms get every ELEMENT looked up by its own indexed name.
    // The previous approach -- one lookup of the bare array name plus
    // `baseLocation + i` arithmetic -- happens to work on the drivers that
    // lay consecutive elements out at consecutive locations, but the stride
    // is not 1 for every base type (this host's NVIDIA driver spaces a mat4
    // array's elements 4 locations apart, not 1), and nothing in the GL spec
    // requires callers to guess it. glGetUniformLocation accepts
    // "name[i]" directly, so ask for exactly what will be set.
    if (binding.kind.endsWith("[]")) {
      for (let i = 0; i < MAX_SHADER_LIGHTS; i++) {
        uniforms.set(`${binding.name}[${i}]`, getLocation(program, `${binding.name}[${i}]`));
      }
    }
  }
  return { program, uniforms };
}

/*
====================
GL_BuildProgram

The compile/link/uniform-lookup sequence above, exposed for a second
consumer that has its own GLSL and its own uniform list rather than a
`GlShaderBits` permutation: gl_fog.ts's screen-space fog passes. Factored
out rather than duplicated so there is exactly one place that knows how
this renderer reports a shader that would not build.

Callers own the returned program's lifetime (gl_fog.ts deletes its own in
GL_ShutdownFog); this module's cache is not involved.
====================
*/
export interface GlProgramT {
  readonly program: number;
  readonly uniforms: ReadonlyMap<string, number>;
}

export function GL_BuildProgram(vertexSource: string, fragmentSource: string, uniformNames: readonly string[]): GlProgramT | null {
  if (!qgl.qglCreateProgram || !qgl.qglAttachShader || !qgl.qglLinkProgram || !qgl.qglGetProgramiv || !qgl.qglGetProgramInfoLog || !qgl.qglDeleteProgram || !qgl.qglGetUniformLocation) {
    return null;
  }

  const vs = compileStage(GL_VERTEX_SHADER, vertexSource);
  if (vs === null) return null;
  const fs = compileStage(GL_FRAGMENT_SHADER, fragmentSource);
  if (fs === null) {
    if (qgl.qglDeleteShader) qgl.qglDeleteShader(vs);
    return null;
  }

  const program = qgl.qglCreateProgram();
  if (!program) {
    if (qgl.qglDeleteShader) {
      qgl.qglDeleteShader(vs);
      qgl.qglDeleteShader(fs);
    }
    return null;
  }

  qgl.qglAttachShader(program, vs);
  qgl.qglAttachShader(program, fs);
  qgl.qglLinkProgram(program);
  if (qgl.qglDeleteShader) {
    qgl.qglDeleteShader(vs);
    qgl.qglDeleteShader(fs);
  }

  const status = new Int32Array(1);
  qgl.qglGetProgramiv(program, GL_LINK_STATUS, status);
  if (!status[0]) {
    const log = qgl.qglGetProgramInfoLog(program);
    if (log) ri.Con_Printf(PRINT_ALL, `${log}\n`);
    qgl.qglDeleteProgram(program);
    return null;
  }

  const uniforms = new Map<string, number>();
  const getLocation = qgl.qglGetUniformLocation;
  for (const name of uniformNames) uniforms.set(name, getLocation(program, name));
  return { program, uniforms };
}

function getProgram(bits: GlShaderBits): CompiledProgram | null {
  const cached = programCache.get(bits);
  if (cached !== undefined) return cached;
  const created = createProgram(bits);
  programCache.set(bits, created);
  return created;
}

export function GL_UsingShaderPath(): boolean {
  return shaderPathActive;
}

/*
====================
GL_UsingPerPixelLighting

q2repro's gl_backend->use_per_pixel_lighting() -- shader.c:1273-1275
(`return !!gl_per_pixel_lighting->integer`) for the GLSL backend, versus
legacy.c:237's constant false for the fixed-function one, i.e. "the shader
backend is live AND the user hasn't turned per-pixel lighting off".

The reason this predicate exists at all is that a dynamic light must be
applied ONCE. q2repro gates the classic bake-the-dlight-into-the-lightmap
path on it in three places (surf.c:243, surf.c:277, world.c:309); without
that gate a light lands both in the lightmap AND in the fragment shader, and
the seam between surfaces the classic path marked and surfaces it didn't
shows up as hard-edged polygon-shaped brightness steps across a flat wall.
====================
*/
export function GL_UsingPerPixelLighting(): boolean {
  if (!shaderPathActive) return false;
  return !glCvars.gl_per_pixel_lighting || glCvars.gl_per_pixel_lighting.value !== 0;
}

/*
====================
GL_InitShaderPath

Called from R_Init, gated on the `gl_shaders` cvar (default "1", matching
q2repro's own GLSL backend default). Probes capability by actually
compiling+linking the simplest permutation this unit ships; if the context
can't do GL2 program objects at all (qgl's GL2 members are null -- see
qgl.ts's all-or-nothing group resolver) or rejects the shader for any other
reason, falls back to fixed-function exactly like q2repro's state.c does
when `gl_static.use_shaders` turns out false after the attempt
(`Cvar_Set("gl_shaders", "0")`). Never throws: the fixed-function path is
always left fully usable regardless of outcome, matching this unit's gate
requirement that both-basedir boots stay unchanged.
====================
*/
export function GL_InitShaderPath(): boolean {
  shaderPathActive = false;
  programCache.clear();
  if (!glCvars.gl_shaders || !glCvars.gl_shaders.value) return false;

  let probe: CompiledProgram | null = null;
  try {
    probe = getProgram(GLS_ENTITY_MESH);
  } catch {
    probe = null;
  }
  shaderPathActive = probe !== null;

  if (!shaderPathActive) {
    ri.Con_Printf(PRINT_ALL, "gl_shaders: program objects unavailable on this context, falling back to fixed-function\n");
    if (glCvars.gl_shaders) ri.Cvar_SetValue("gl_shaders", 0);
  }
  return shaderPathActive;
}

export function GL_ShutdownShaderPath(): void {
  if (qgl.qglUseProgram) qgl.qglUseProgram(0);
  if (qgl.qglDeleteProgram) {
    for (const compiled of programCache.values()) {
      if (compiled) qgl.qglDeleteProgram(compiled.program);
    }
  }
  programCache.clear();
  shaderPathActive = false;
}

// Each array element is addressed by the location createProgram looked up
// for its own indexed name ("u_light_pos[3]"), never by arithmetic on the
// bare array's location. That arithmetic was this unit's predecessor's
// approach and was flagged in the RC checklist as unverifiable headlessly;
// it is now retired, because the stride is genuinely not always 1 -- this
// host's NVIDIA driver spaces a mat4 array's elements 4 locations apart.
function uploadLightUniforms(prog: CompiledProgram, lights: readonly DlightT[], numLights: number): void {
  const countLoc = prog.uniforms.get("u_light_count");
  const count = Math.min(numLights, MAX_SHADER_LIGHTS, lights.length);
  if (countLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(countLoc, count);

  for (let i = 0; i < count; i++) {
    const dl = lights[i];
    if (!dl) break;
    const posLoc = prog.uniforms.get(`u_light_pos[${i}]`);
    const radiusLoc = prog.uniforms.get(`u_light_radius[${i}]`);
    const colorLoc = prog.uniforms.get(`u_light_color[${i}]`);
    const scaleLoc = prog.uniforms.get(`u_light_scale[${i}]`);
    const coneDirLoc = prog.uniforms.get(`u_light_cone_dir[${i}]`);
    const coneCosLoc = prog.uniforms.get(`u_light_cone_cos[${i}]`);

    if (posLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(posLoc, dl.origin[0], dl.origin[1], dl.origin[2]);
    if (radiusLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(radiusLoc, dl.intensity);
    if (colorLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(colorLoc, dl.color[0], dl.color[1], dl.color[2]);
    if (scaleLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(scaleLoc, dl.lightScale);
    const cone = dl.cone;
    if (cone) {
      if (coneDirLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(coneDirLoc, cone.direction[0], cone.direction[1], cone.direction[2]);
      if (coneCosLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(coneCosLoc, cone.cosHalfAngle);
    } else {
      if (coneCosLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(coneCosLoc, 0);
    }
  }
}

/*
====================
GL_UseWorldSurfaceProgram

Activates the GLS_WORLD_SURFACE permutation for the current frame's
lightmap-blend pass (gl_rsurf.ts's R_BlendLightmaps). Binds the lightmap
sampler to TMU 0 (that pass already rebinds unit 0 to the lightmap texture
per-surface via GL_Bind, same as the fixed-function path) and uploads the
frame's active per-pixel lights once; callers set qglNormal3f per surface
before each draw (Quake 2 world surfaces are planar, so the surface's plane
normal is exact, not an approximation). No-op (returns false) when the
shader path isn't active -- callers must check the return value and fall
back to the existing fixed-function draw, which is untouched either way.
====================
*/
export function GL_UseWorldSurfaceProgram(lights: readonly DlightT[], numLights: number): boolean {
  if (!shaderPathActive) return false;

  // Prefer the shadowed permutation, but only when there is actually a depth
  // map to sample and the permutation builds on this context; otherwise fall
  // straight back to task #25's unshadowed one, which is byte-identical to
  // what shipped before this unit.
  const bindings = GL_ShadowMapBindings();
  const wantShadows = GL_ShadowMapsReady() && bindings.length > 0 && GL_ShadowMapTexture() !== 0;
  let shadowed = false;
  let prog: CompiledProgram | null = null;
  if (wantShadows) {
    prog = getProgram(GLS_WORLD_SURFACE_SHADOWED);
    shadowed = prog !== null;
  }
  if (!prog) prog = getProgram(GLS_WORLD_SURFACE);
  if (!prog || !qgl.qglUseProgram) return false;

  qgl.qglUseProgram(prog.program);
  const lmLoc = prog.uniforms.get("u_lightmap");
  if (lmLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(lmLoc, 0);

  const eyeToWorldLoc = prog.uniforms.get("u_eye_to_world");
  if (eyeToWorldLoc !== undefined && qgl.qglUniformMatrix4fv) {
    qgl.qglUniformMatrix4fv(eyeToWorldLoc, 1, false, GL_EyeToWorldMatrix());
  }

  uploadLightUniforms(prog, lights, numLights);
  if (shadowed) uploadShadowUniforms(prog, bindings);
  return true;
}

/*
====================
uploadShadowUniforms

Binds the depth atlas to TMU 1 and fills the per-light shadow arrays. Every
slot is written every frame, including the zeroed `u_light_shadow` entries
for lights with no map -- leaving a stale kind code behind from a previous
frame would shadow a light against another light's depth rectangle.

TMU 1 via qglActiveTexture rather than gl_image.ts's GL_SelectTexture: that
helper drives qglSelectTextureSGIS, and GL_SGIS_multitexture is absent from
every current driver (see qgl.ts's note on qglActiveTexture). The active unit
is put back to 0 before returning, so gl_image.ts's own GL_Bind cache -- which
is never told about any of this -- stays correct.
====================
*/
function uploadShadowUniforms(prog: CompiledProgram, bindings: readonly ShadowMapBindingT[]): void {
  const activeTexture = qgl.qglActiveTexture;
  if (activeTexture) {
    activeTexture(GL_TEXTURE1);
    qgl.qglBindTexture(GL_TEXTURE_2D, GL_ShadowMapTexture());
    activeTexture(GL_TEXTURE0);
  }

  const mapLoc = prog.uniforms.get("u_shadow_map");
  if (mapLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(mapLoc, 1);
  const texelLoc = prog.uniforms.get("u_shadow_texel");
  if (texelLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(texelLoc, 1 / SHADOW_ATLAS_SIZE);

  const shadowed = new Map<number, ShadowMapBindingT>();
  for (const binding of bindings) shadowed.set(binding.lightIndex, binding);

  for (let i = 0; i < MAX_SHADER_LIGHTS; i++) {
    const binding = shadowed.get(i);
    const kindLoc = prog.uniforms.get(`u_light_shadow[${i}]`);
    if (kindLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(kindLoc, binding ? binding.kind : SHADOW_KIND_NONE);
    if (!binding) continue;
    const matrixLoc = prog.uniforms.get(`u_light_matrix[${i}]`);
    const atlasLoc = prog.uniforms.get(`u_light_atlas[${i}]`);
    if (matrixLoc !== undefined && qgl.qglUniformMatrix4fv) qgl.qglUniformMatrix4fv(matrixLoc, 1, false, binding.matrix);
    if (atlasLoc !== undefined && qgl.qglUniform4f) {
      // zw is the rectangle's size, no longer necessarily square: a point
      // light's rectangle is three faces wide by two tall.
      qgl.qglUniform4f(
        atlasLoc,
        binding.slot.x / SHADOW_ATLAS_SIZE,
        binding.slot.y / SHADOW_ATLAS_SIZE,
        binding.slot.width / SHADOW_ATLAS_SIZE,
        binding.slot.height / SHADOW_ATLAS_SIZE,
      );
    }
  }
}

/*
====================
GL_UseAliasModelProgram

Activates GLS_ENTITY_MESH_SHADOWED for one alias model's base pass, so the
model receives the same shadow lights the world under it already does.

`affecting` is gl_mesh.ts's measurement of how much of THIS model's shade
colour each shadow-mapped light is responsible for (see aliasShadowLights
there). An empty list is the normal case -- no shadow light reaches this
model -- and returns false so the caller draws through the untouched
fixed-function path, which is what keeps a map with no shadow lights (every
1997 map) rendering byte-identically to the build before this unit.

`shadeDivisor` is gl_mesh.ts's aliasShadeDivisor for this model: the mesh
paths divide the vertex colour by it so the colour survives glColor4f's
[0,1] clamp, and the fragment stage multiplies it back out before removing
any light's share. A caller that returns false must NOT apply the divisor.

Returns false, leaving the fixed-function path fully usable, for every other
reason too: gl_shaders 0, no depth atlas this frame, or a context on which
this permutation will not compile. Callers must call GL_RestoreFixedFunction
when it returns true -- notably BEFORE the glow pass, which is emissive and
must add unshadowed.
====================
*/
export interface ModelShadowLightT {
  // index into r_newrefdef.dlights, i.e. the same index ShadowMapBindingT
  // calls lightIndex
  readonly lightIndex: number;
  // per-channel share of the model's final shade colour that this light
  // contributed, in [0,1]
  readonly fraction: Vec3;
}

export function GL_UseAliasModelProgram(lights: readonly DlightT[], affecting: readonly ModelShadowLightT[], shadeDivisor: number): boolean {
  if (!shaderPathActive || affecting.length === 0) return false;
  if (!GL_ShadowMapsReady() || GL_ShadowMapTexture() === 0) return false;

  const bindings = GL_ShadowMapBindings();
  if (bindings.length === 0) return false;
  const bound = new Map<number, ShadowMapBindingT>();
  for (const binding of bindings) bound.set(binding.lightIndex, binding);

  // Only lights that BOTH affect this model and actually have a depth
  // rectangle this frame can be occluded; anything else keeps its
  // unoccluded contribution, exactly as the world receiver does.
  const usable = affecting.filter((entry) => entry.lightIndex >= 0 && entry.lightIndex < MAX_SHADER_LIGHTS && bound.has(entry.lightIndex));
  if (usable.length === 0) return false;

  const prog = getProgram(GLS_ENTITY_MESH_SHADOWED);
  if (!prog || !qgl.qglUseProgram) return false;

  qgl.qglUseProgram(prog.program);
  const texLoc = prog.uniforms.get("u_texture");
  if (texLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(texLoc, 0);

  // Undoes the headroom the mesh paths divided the vertex colour by, so the
  // fragment stage sees the true (unclamped) l * shadelight. See the
  // GLS_MODEL_SHADOW fragment body for why the clamp order matters.
  const scaleLoc = prog.uniforms.get("u_shade_scale");
  if (scaleLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(scaleLoc, shadeDivisor > 0 ? shadeDivisor : 1);

  const eyeToWorldLoc = prog.uniforms.get("u_eye_to_world");
  if (eyeToWorldLoc !== undefined && qgl.qglUniformMatrix4fv) {
    qgl.qglUniformMatrix4fv(eyeToWorldLoc, 1, false, GL_EyeToWorldMatrix());
  }

  const activeTexture = qgl.qglActiveTexture;
  if (activeTexture) {
    activeTexture(GL_TEXTURE1);
    qgl.qglBindTexture(GL_TEXTURE_2D, GL_ShadowMapTexture());
    activeTexture(GL_TEXTURE0);
  }
  const mapLoc = prog.uniforms.get("u_shadow_map");
  if (mapLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(mapLoc, 1);
  const texelLoc = prog.uniforms.get("u_shadow_texel");
  if (texelLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(texelLoc, 1 / SHADOW_ATLAS_SIZE);

  // The loop stops at the highest affecting slot rather than always walking
  // all MAX_SHADER_LIGHTS: this runs once per alias model per frame, not
  // once per frame, and the usual case is a single light.
  let count = 0;
  const byIndex = new Map<number, ModelShadowLightT>();
  for (const entry of usable) {
    byIndex.set(entry.lightIndex, entry);
    if (entry.lightIndex + 1 > count) count = entry.lightIndex + 1;
  }
  const countLoc = prog.uniforms.get("u_light_count");
  if (countLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(countLoc, count);

  for (let i = 0; i < count; i++) {
    const entry = byIndex.get(i);
    const kindLoc = prog.uniforms.get(`u_light_shadow[${i}]`);
    // Slots below `count` that this model is not affected by are zeroed
    // rather than skipped -- a stale kind code left over from the PREVIOUS
    // model drawn through this program would shadow this one against a
    // light it never saw.
    if (kindLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(kindLoc, entry ? (bound.get(i)?.kind ?? SHADOW_KIND_NONE) : SHADOW_KIND_NONE);
    if (!entry) continue;
    const binding = bound.get(i);
    if (!binding) continue;

    const fracLoc = prog.uniforms.get(`u_light_frac[${i}]`);
    if (fracLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(fracLoc, entry.fraction[0], entry.fraction[1], entry.fraction[2]);

    const matrixLoc = prog.uniforms.get(`u_light_matrix[${i}]`);
    if (matrixLoc !== undefined && qgl.qglUniformMatrix4fv) qgl.qglUniformMatrix4fv(matrixLoc, 1, false, binding.matrix);

    const atlasLoc = prog.uniforms.get(`u_light_atlas[${i}]`);
    if (atlasLoc !== undefined && qgl.qglUniform4f) {
      qgl.qglUniform4f(
        atlasLoc,
        binding.slot.x / SHADOW_ATLAS_SIZE,
        binding.slot.y / SHADOW_ATLAS_SIZE,
        binding.slot.width / SHADOW_ATLAS_SIZE,
        binding.slot.height / SHADOW_ATLAS_SIZE,
      );
    }

    // The point-light branch of the shared shadow-factor GLSL reads these
    // two directly; the cone branch never touches them.
    const dl = lights[i];
    if (!dl) continue;
    const posLoc = prog.uniforms.get(`u_light_pos[${i}]`);
    if (posLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(posLoc, dl.origin[0], dl.origin[1], dl.origin[2]);
    const radiusLoc = prog.uniforms.get(`u_light_radius[${i}]`);
    if (radiusLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(radiusLoc, dl.intensity);
  }

  return true;
}

export function GL_RestoreFixedFunction(): void {
  if (qgl.qglUseProgram) qgl.qglUseProgram(0);
}
