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

export type GlShaderBits = number;

export const GLS_WORLD_SURFACE: GlShaderBits = GLS_LIGHTMAP | GLS_DYNAMIC_LIGHTS;
export const GLS_ENTITY_MESH: GlShaderBits = GLS_DYNAMIC_LIGHTS;

// --- uniform-binding table (pure data) ---------------------------------
//
// Exactly which uniforms a given permutation's GLSL declares. Verified in
// test/gl_shaders.test.ts to stay in lockstep with
// buildFragmentShaderSource's actual `uniform` lines -- the "uniform-
// binding table correctness" leg of this unit's headless verification
// (real compilation can't run without a GPU context; this can).
export interface UniformBindingT {
  readonly name: string;
  readonly kind: "sampler2D" | "vec3[]" | "float[]" | "int";
}

export function uniformBindingsFor(bits: GlShaderBits): UniformBindingT[] {
  const bindings: UniformBindingT[] = [{ name: bits & GLS_LIGHTMAP ? "u_lightmap" : "u_texture", kind: "sampler2D" }];
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
  return bindings;
}

// --- pure GLSL source assembly ------------------------------------------

export function buildVertexShaderSource(bits: GlShaderBits): string {
  const lines: string[] = ["#version 110", "varying vec3 v_world_pos;"];
  if (bits & GLS_DYNAMIC_LIGHTS) lines.push("varying vec3 v_normal;");
  lines.push("void main() {");
  lines.push("  v_world_pos = vec3(gl_ModelViewMatrix * gl_Vertex);");
  if (bits & GLS_DYNAMIC_LIGHTS) lines.push("  v_normal = normalize(gl_NormalMatrix * gl_Normal);");
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
  for (const binding of uniformBindingsFor(bits)) {
    uniforms.set(binding.name, qgl.qglGetUniformLocation(program, binding.name));
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

// Addresses array element i as `baseLocation + i` -- glGetUniformLocation
// was called once per array uniform (see uniformBindingsFor/createProgram),
// against the bare array name, which resolves to element 0's location;
// every desktop GL driver in practice lays consecutive array elements out
// at consecutive locations from there (the same technique many UBO-less
// GL2 engines use), but this is only checkable on a real context -- flagged
// in this unit's RC checklist for Mike's real-GPU run.
function uploadLightUniforms(prog: CompiledProgram, lights: readonly DlightT[], numLights: number): void {
  const countLoc = prog.uniforms.get("u_light_count");
  const count = Math.min(numLights, MAX_SHADER_LIGHTS, lights.length);
  if (countLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(countLoc, count);

  const posLoc = prog.uniforms.get("u_light_pos");
  const radiusLoc = prog.uniforms.get("u_light_radius");
  const colorLoc = prog.uniforms.get("u_light_color");
  const scaleLoc = prog.uniforms.get("u_light_scale");
  const coneDirLoc = prog.uniforms.get("u_light_cone_dir");
  const coneCosLoc = prog.uniforms.get("u_light_cone_cos");

  for (let i = 0; i < count; i++) {
    const dl = lights[i];
    if (!dl) break;
    if (posLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(posLoc + i, dl.origin[0], dl.origin[1], dl.origin[2]);
    if (radiusLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(radiusLoc + i, dl.intensity);
    if (colorLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(colorLoc + i, dl.color[0], dl.color[1], dl.color[2]);
    if (scaleLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(scaleLoc + i, dl.lightScale);
    const cone = dl.cone;
    if (cone) {
      if (coneDirLoc !== undefined && qgl.qglUniform3f) qgl.qglUniform3f(coneDirLoc + i, cone.direction[0], cone.direction[1], cone.direction[2]);
      if (coneCosLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(coneCosLoc + i, cone.cosHalfAngle);
    } else {
      if (coneCosLoc !== undefined && qgl.qglUniform1f) qgl.qglUniform1f(coneCosLoc + i, 0);
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
  const prog = getProgram(GLS_WORLD_SURFACE);
  if (!prog || !qgl.qglUseProgram) return false;
  qgl.qglUseProgram(prog.program);
  const lmLoc = prog.uniforms.get("u_lightmap");
  if (lmLoc !== undefined && qgl.qglUniform1i) qgl.qglUniform1i(lmLoc, 0);
  uploadLightUniforms(prog, lights, numLights);
  return true;
}

export function GL_RestoreFixedFunction(): void {
  if (qgl.qglUseProgram) qgl.qglUseProgram(0);
}
