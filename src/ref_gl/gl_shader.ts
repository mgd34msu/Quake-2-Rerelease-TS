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
// Entity meshes: infrastructure only (GLS_ENTITY_MESH exists, is tested,
// and would be a drop-in given a per-vertex glNormal3f call) but NOT
// activated at gl_mesh.ts's draw call this pass -- GL_DrawAliasFrameLerp
// has two vertex-submission paths (gl_vertex_arrays client-array path vs.
// plain immediate-mode) and correctly feeding gl_Normal needs a per-vertex
// normal threaded through both without disturbing either's existing,
// delicate vertex data layout. Left as a flagged, bounded follow-up (see
// this unit's report) rather than activated-but-wrong: an entity lit with
// a stale/default gl_Normal would look visibly incorrect in a way nothing
// in this headless test suite could catch.

import { qgl } from "./gl_image";
import { ri, glCvars } from "./gl_local";
import { type Vec3, vec3 } from "../shared/math";
import { PRINT_ALL } from "../shared/q_shared";
import { type DlightT } from "../client/ref";
import { type ShadowMapBindingT, GL_ShadowMapBindings, GL_ShadowMapsReady, GL_ShadowMapTexture, GL_EyeToWorldMatrix, SHADOW_ATLAS_SIZE } from "./gl_shadowmap";

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
// v1.1.0: sample gl_shadowmap.ts's depth atlas to occlude each cone light.
// A separate bit rather than a change to GLS_DYNAMIC_LIGHTS so the
// unshadowed permutation stays compiled and available as the fallback when
// the shadow permutation won't build on a given context.
export const GLS_SHADOWMAP = 1 << 2;

export type GlShaderBits = number;

export const GLS_WORLD_SURFACE: GlShaderBits = GLS_LIGHTMAP | GLS_DYNAMIC_LIGHTS;
export const GLS_WORLD_SURFACE_SHADOWED: GlShaderBits = GLS_LIGHTMAP | GLS_DYNAMIC_LIGHTS | GLS_SHADOWMAP;
export const GLS_ENTITY_MESH: GlShaderBits = GLS_DYNAMIC_LIGHTS;

// Constant depth bias applied on top of the depth pass's own glPolygonOffset,
// in the [0,1] window-depth space the atlas stores. Small on purpose:
// polygon offset already does the slope-dependent work, and a large constant
// bias here is what produces peter-panning (shadows detaching from their
// caster's base).
export const SHADOW_DEPTH_BIAS = 0.0005;

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
  if (bits & GLS_SHADOWMAP) {
    bindings.push(
      { name: "u_shadow_map", kind: "sampler2D" },
      { name: "u_shadow_texel", kind: "float" },
      { name: "u_light_matrix", kind: "mat4[]" },
      { name: "u_light_atlas", kind: "vec4[]" },
      { name: "u_light_shadow", kind: "float[]" },
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

  if (bits & GLS_SHADOWMAP) {
    lines.push(
      `uniform sampler2D u_shadow_map;`,
      `uniform float u_shadow_texel;`,
      `uniform mat4 u_light_matrix[${MAX_SHADER_LIGHTS}];`,
      // xy = this light's atlas rectangle origin, zw = its size, both already
      // normalized to [0,1] atlas UV by the caller
      `uniform vec4 u_light_atlas[${MAX_SHADER_LIGHTS}];`,
      // 1.0 when this light owns an atlas rectangle, 0.0 when it does not
      // (point lights, and cone lights the atlas had no room for) -- those
      // keep the unoccluded contribution rather than being wrongly shadowed
      `uniform float u_light_shadow[${MAX_SHADER_LIGHTS}];`,
      `#define SHADOW_DEPTH_BIAS ${SHADOW_DEPTH_BIAS}`,
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
      lines.push(
        `    if (u_light_shadow[i] != 0.0) {`,
        `      vec4 lpos = u_light_matrix[i] * vec4(v_world_pos, 1.0);`,
        `      if (lpos.w > 0.0) {`,
        `        vec3 lproj = lpos.xyz / lpos.w;`,
        // outside the light's own frustum there is no depth data to consult;
        // leave the fragment lit rather than guessing (a wrong guess here is
        // what paints hard black rectangles at shadow-map edges)
        `        if (lproj.x >= 0.0 && lproj.x <= 1.0 && lproj.y >= 0.0 && lproj.y <= 1.0 && lproj.z <= 1.0) {`,
        `          vec2 base = lproj.xy * u_light_atlas[i].zw + u_light_atlas[i].xy;`,
        `          float lit = 0.0;`,
        // 2x2 percentage-closer filter. Cheap, and enough to break up the
        // stair-stepped edge a single tap gives at these map sizes.
        `          for (int sy = 0; sy < 2; sy++) {`,
        `            for (int sx = 0; sx < 2; sx++) {`,
        `              vec2 off = (vec2(float(sx), float(sy)) - 0.5) * u_shadow_texel;`,
        `              float d = texture2D(u_shadow_map, base + off).r;`,
        `              lit += (lproj.z - SHADOW_DEPTH_BIAS) > d ? 0.0 : 1.0;`,
        `            }`,
        `          }`,
        `          result *= lit * 0.25;`,
        `        }`,
        `      }`,
        `    }`,
      );
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
for lights with no map -- leaving a stale 1.0 behind from a previous frame
would shadow a light against another light's depth rectangle.

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
    const flagLoc = prog.uniforms.get(`u_light_shadow[${i}]`);
    if (flagLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(flagLoc, binding ? 1 : 0);
    if (!binding) continue;
    const matrixLoc = prog.uniforms.get(`u_light_matrix[${i}]`);
    const atlasLoc = prog.uniforms.get(`u_light_atlas[${i}]`);
    if (matrixLoc !== undefined && qgl.qglUniformMatrix4fv) qgl.qglUniformMatrix4fv(matrixLoc, 1, false, binding.matrix);
    if (atlasLoc !== undefined && qgl.qglUniform4f) {
      const scale = binding.slot.size / SHADOW_ATLAS_SIZE;
      qgl.qglUniform4f(atlasLoc, binding.slot.x / SHADOW_ATLAS_SIZE, binding.slot.y / SHADOW_ATLAS_SIZE, scale, scale);
    }
  }
}

export function GL_RestoreFixedFunction(): void {
  if (qgl.qglUseProgram) qgl.qglUseProgram(0);
}
