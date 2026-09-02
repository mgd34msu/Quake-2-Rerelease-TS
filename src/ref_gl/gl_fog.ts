/*
gl_fog.ts -- the re-release's fog, ported onto ref_gl.

No .c analog in the 1997 id Software renderer (vanilla ref_gl has no fog of
any kind). The model is q2repro's, from src/refresh/shader.c:

  * shader.c:719-726  global fog. `frag_depth = gl_FragCoord.z /
    gl_FragCoord.w`, then `d = u_fog_color.a * frag_depth;
    fog = 1.0 - exp(-(d * d)); diffuse.rgb = mix(diffuse.rgb,
    u_fog_color.rgb, fog)`. shader.c:1105 supplies that alpha:
    `fog_color[3] = glr.fd.fog.density / 64`.
  * shader.c:541-561  write_height_fog(), ported line for line below,
    including its own "XXX: this is very broken. but that's how it is in
    re-release." -- see heightFogFraction().
  * shader.c:738-739  the sky term: a FLAT `mix(diffuse.rgb,
    u_fog_color.rgb, u_fog_sky_factor)` on sky surfaces, with no distance
    term at all.
  * main.c:817-827    which of the three are active for a frame, and the
    gl_fog cvar gate. GL_FogFrameSetup below is that block.

── Why a depth post-pass instead of per-draw shader bits ──────────────────
q2repro renders EVERY surface through a GLSL program, so it folds fog into
each fragment shader as three more permutation bits (GLS_FOG_GLOBAL /
_HEIGHT / _SKY) and gets world, brush models, alias models, sprites and
particles fogged by construction. This renderer is not that. It is ref_gl:
GL1.1 immediate mode, with a single narrow GLSL program layered over the
LIGHTMAP-BLEND pass only (gl_shader.ts's header explains why). Everything
else -- the world's texture pass, alias models, sprites, particles, alpha
surfaces -- is fixed-function.

That rules out the per-draw approach, and not for effort reasons. The world
is drawn as two passes that MULTIPLY: pass 1 emits the texture T, pass 2
re-emits the same polygons with the lightmap L under glBlendFunc(GL_ZERO,
GL_SRC_COLOR), so the framebuffer ends at T*L. The wanted result is
mix(T*L, F, f). Fogging both passes gives (f*T + (1-f)F) * (f*L + (1-f)F),
which at full fog is F*F -- the fog color SQUARED, i.e. a purple fog that
turns near-black exactly where it should be thickest. Fogging one pass and
not the other is worse: fog the texture pass alone and the lightmap
darkens the fog (fog vanishes in unlit rooms); fog the lightmap pass alone
and the fog is multiplied by the texture. There is no assignment of fog
colors to those two passes that yields one lerp, because a product of two
lerps is not a lerp.

So fog goes where it can be applied exactly ONCE, per fragment, after
everything else: a screen-space pass that reads the frame's depth buffer,
reconstructs each fragment's eye distance and world position, and blends.
That also makes it uniform across world, brush models, alias models,
sprites and particles for free -- the requirement q2repro meets by putting
the same three bits on every draw call -- and it composes with the shadow
pass (gl_shadowmap.ts) without either knowing about the other, since the
shadow atlas has long since been resolved into the color buffer by the
time this runs.

The three terms are three quad draws rather than one, under
glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA) with the term's own
color in RGB and its own amount in A. `dst' = C*a + dst*(1-a)` IS
`mix(dst, C, a)`, so each draw reproduces one of q2repro's mix() lines,
and running them in q2repro's order (global, then height, then sky --
shader.c:722/736/739) reproduces its sequencing exactly.

── Known departures, stated plainly ──────────────────────────────────────
1. TRANSLUCENT fragments take the fog of whatever opaque surface is behind
   them, because particles, sprites and alpha surfaces do not write depth
   (R_DrawParticles/R_DrawAlphaSurfaces run with glDepthMask(false), as in
   1997). q2repro fogs those by their own fragment depth. A particle close
   to the eye in front of a distant wall is therefore fogged as if it were
   at the wall. The fog COLOR is identical either way; only the amount on
   the translucent pixels differs.
2. gl_shaders 0 gets NO fog -- see GL_FogFrameSetup's comment for the
   reason, which is the two-pass algebra above plus the fact that classic
   glFog*() has no height-fog form at all (GL_EXP2 has one density and one
   color; the re-release's height term needs a per-fragment world Z, two
   colors and a falloff integral). q2repro's own gate is the same shape:
   main.c:819 only sets any fog bit `if (gl_static.use_shaders)`.
3. The SOFTWARE renderer (src/ref_soft) has no fog and gets none. The
   re-release ships no software renderer, so there is nothing to be
   faithful to; ref_soft's span/particle rasterizers have no place to put
   a per-pixel blend that would not be an invention.
4. gl_ztrick (the 1997 depth-range flip-flop, default 0 here and in
   q2repro's lineage) disables the pass: it halves and inverts the depth
   range every other frame, so the window-depth -> eye-distance inversion
   below and the "is this the sky" comparison would both need to change
   sense per frame for a cvar no driver has needed since 1999.
*/

import { qgl } from "./gl_image";
import { ri, glCvars, r_newrefdef, r_origin, vpn, vright, vup, vid, gl_state, gldepthmax } from "./gl_local";
import { PRINT_ALL } from "../shared/q_shared";
import { GL_UsingShaderPath, GL_BuildProgram, type GlProgramT } from "./gl_shader";

const GL_TEXTURE_2D = 0x0de1;
const GL_DEPTH_COMPONENT24 = 0x81a6;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_NEAREST = 0x2600;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_QUADS = 0x0007;
const GL_BLEND = 0x0be2;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_DEPTH_TEST = 0x0b71;
const GL_CULL_FACE = 0x0b44;
const GL_ALPHA_TEST = 0x0bc0;
const GL_PROJECTION = 0x1701;
const GL_MODELVIEW = 0x1700;

// q2repro shader.c:1105 -- `gls.u_block.fog_color[3] = glr.fd.fog.density / 64`.
// The whole reason the wire density looks small (mgu6m1 ships 0.024) and the
// resulting fog still reads thick is this divisor plus the SQUARED exponent
// in the global term.
export const FOG_DENSITY_SCALE = 64;

// Window depth at (or past) which a fragment is treated as "sky or nothing
// drawn". R_DrawSkyBox pins the sky box to exactly gldepthmax while fog is
// active (see GL_FogNoteSkyDrawn's comment), so this cleanly separates the
// three cases without a stencil buffer. At the scene's 4/4096 near/far
// planes this threshold corresponds to ~4092 world units, i.e. the far
// plane itself.
export const FOG_SKY_DEPTH_EPSILON = 1e-6;

// --- pure fog math (q2repro shader.c, extracted for headless tests) -----

/*
q2repro shader.c:723-725. NOTE the square: `d = density_scaled * depth`
then `1 - exp(-(d*d))`, which is a GL_EXP2-shaped curve, not GL_EXP.
`densityScaled` is the wire density already divided by FOG_DENSITY_SCALE.
*/
export function globalFogAmount(densityScaled: number, fragDepth: number): number {
  const d = densityScaled * fragDepth;
  return 1 - Math.exp(-(d * d));
}

/*
q2repro shader.c:552, verbatim -- and this is the line its own comment
calls "very broken":

    float pos = v_world_pos.z - u_heightfog_start.w;
    float fraction = clamp((pos - u_heightfog_start.w) / (u_heightfog_end.w - u_heightfog_start.w), 0.0, 1.0);

`pos` has ALREADY had the start distance subtracted, and then the start
distance is subtracted a second time. The band therefore sits around
2*start rather than between start and end. Preserved exactly: mgu6m1
authors start=-328 / end=-349, so the orange-to-black ramp lands between
world Z -656 and -677 rather than between -328 and -349, and that is what
the re-release itself draws.
*/
export function heightFogFraction(worldZ: number, startDist: number, endDist: number): number {
  const pos = worldZ - startDist;
  const denom = endDist - startDist;
  if (denom === 0) return 0;
  const raw = (pos - startDist) / denom;
  return Math.min(Math.max(raw, 0), 1);
}

/*
q2repro shader.c:547-551 + 551's clamp. `dirZ` is the Z of the normalized
eye->fragment direction, with shader.c:545-546's zero-guard already
applied by heightFogDirZ below.
*/
export function heightFogExtinction(viewZ: number, worldZ: number, startDist: number, falloff: number, dirZ: number): number {
  const eye = viewZ - startDist;
  const pos = worldZ - startDist;
  const density = (Math.exp(-falloff * eye) - Math.exp(-falloff * pos)) / (falloff * dirZ);
  return 1 - Math.min(Math.max(Math.exp(-density), 0), 1);
}

// shader.c:545-546: `float s = sign(dir_z); dir_z += 0.00001 * (1.0 - s*s);`
// -- adds the epsilon only when dir_z is exactly zero (a perfectly
// horizontal view ray), where the division above would otherwise blow up.
export function heightFogDirZ(dirZ: number): number {
  const s = Math.sign(dirZ);
  return dirZ + 0.00001 * (1 - s * s);
}

// shader.c:554: `(1.0 - exp(-(u_heightfog_density * frag_depth))) * extinction`.
// Not squared, unlike the global term.
export function heightFogAmount(density: number, fragDepth: number, extinction: number): number {
  return (1 - Math.exp(-(density * fragDepth))) * extinction;
}

/*
The window-depth -> eye-distance inversion the post-pass needs and
q2repro's in-line shaders do not (they read gl_FragCoord.w directly).

MYgluPerspective (gl_rmain.ts) builds a standard symmetric frustum, whose
third row gives ndc_z = A - B/w for w = -z_eye, with
A = (far+near)/(far-near) and B = 2*far*near/(far-near). Inverting:
w = B / (A - ndc_z).

`fragDepth` is then window_z * w, because q2repro's fog reads
gl_FragCoord.z / gl_FragCoord.w and gl_FragCoord.w is 1/w_clip = 1/w while
gl_FragCoord.z is the window depth. That product is not the linear eye
distance -- it is the idiom the re-release uses, quirk included, so the
same expression is reproduced here rather than a "corrected" one.
*/
export function projectionInverseCoefficients(zNear: number, zFar: number): { a: number; b: number } {
  return { a: (zFar + zNear) / (zFar - zNear), b: (2 * zFar * zNear) / (zFar - zNear) };
}

export function eyeDistanceFromWindowDepth(windowDepth: number, a: number, b: number): number {
  const ndcZ = 2 * windowDepth - 1;
  return b / (a - ndcZ);
}

export function fragDepthFromWindowDepth(windowDepth: number, a: number, b: number): number {
  return windowDepth * eyeDistanceFromWindowDepth(windowDepth, a, b);
}

// --- GLSL assembly ------------------------------------------------------

export const FOG_PASS_GLOBAL = 0;
export const FOG_PASS_HEIGHT = 1;
export const FOG_PASS_SKY = 2;
export type FogPassKind = 0 | 1 | 2;

export function fogUniformsFor(kind: FogPassKind): readonly string[] {
  if (kind === FOG_PASS_SKY) return ["u_depth", "u_far_depth", "u_fog_color"];
  if (kind === FOG_PASS_GLOBAL) return ["u_depth", "u_far_depth", "u_proj", "u_fog_color"];
  return ["u_depth", "u_far_depth", "u_proj", "u_vieworg", "u_forward", "u_right", "u_up", "u_tan", "u_hf_start", "u_hf_end", "u_hf_density", "u_hf_falloff"];
}

/*
The quad is submitted in normalized device coordinates directly (see
drawFullscreenQuad), so gl_Position is gl_Vertex with no matrix at all --
deliberately NOT ftransform(), because there is no fixed-function
transform to match here: nothing else draws this geometry.

v_ray is the eye->fragment direction scaled so that `vieworg + v_ray * w`
lands on the fragment, for w the eye-axis distance. It is linear in NDC, so
interpolating it across two triangles is exact rather than approximate.
*/
export function buildFogVertexShaderSource(kind: FogPassKind): string {
  const lines = ["#version 110", "varying vec2 v_tc;"];
  if (kind === FOG_PASS_HEIGHT) {
    lines.push("uniform vec3 u_forward;", "uniform vec3 u_right;", "uniform vec3 u_up;", "uniform vec4 u_tan;", "varying vec3 v_ray;");
  }
  lines.push("void main() {");
  lines.push("  v_tc = gl_MultiTexCoord0.st;");
  if (kind === FOG_PASS_HEIGHT) {
    lines.push("  v_ray = u_forward + u_right * (gl_Vertex.x * u_tan.x) + u_up * (gl_Vertex.y * u_tan.y);");
  }
  lines.push("  gl_Position = vec4(gl_Vertex.xy, 0.0, 1.0);");
  lines.push("}");
  return lines.join("\n");
}

export function buildFogFragmentShaderSource(kind: FogPassKind): string {
  const lines = ["#version 110", "varying vec2 v_tc;", "uniform sampler2D u_depth;", "uniform float u_far_depth;"];

  if (kind === FOG_PASS_SKY) {
    // shader.c:739 -- flat mix, no distance term. Only the fragments the sky
    // box painted qualify; everything nearer was already handled by the two
    // distance passes.
    lines.push(
      "uniform vec4 u_fog_color;",
      "void main() {",
      "  float d = texture2D(u_depth, v_tc).r;",
      "  if (d < u_far_depth) discard;",
      "  gl_FragColor = vec4(u_fog_color.rgb, u_fog_color.a);",
      "}",
    );
    return lines.join("\n");
  }

  lines.push("uniform vec4 u_proj;");
  if (kind === FOG_PASS_GLOBAL) lines.push("uniform vec4 u_fog_color;");
  else {
    lines.push(
      "varying vec3 v_ray;",
      "uniform vec3 u_vieworg;",
      "uniform vec4 u_hf_start;",
      "uniform vec4 u_hf_end;",
      "uniform float u_hf_density;",
      "uniform float u_hf_falloff;",
    );
  }

  lines.push(
    "void main() {",
    "  float d = texture2D(u_depth, v_tc).r;",
    // Sky and never-drawn background both sit at exactly the far window
    // depth; the sky gets its own flat pass, the background gets nothing.
    "  if (d >= u_far_depth) discard;",
    "  float ndc_z = 2.0 * d - 1.0;",
    "  float w = u_proj.y / (u_proj.x - ndc_z);",
    "  float frag_depth = d * w;",
  );

  if (kind === FOG_PASS_GLOBAL) {
    lines.push(
      // shader.c:723-725
      "  float dd = u_fog_color.a * frag_depth;",
      "  float fog = 1.0 - exp(-(dd * dd));",
      "  gl_FragColor = vec4(u_fog_color.rgb, fog);",
      "}",
    );
    return lines.join("\n");
  }

  // shader.c:541-556's write_height_fog(), line for line.
  lines.push(
    "  vec3 v_world_pos = u_vieworg + v_ray * w;",
    "  float dir_z = normalize(v_world_pos - u_vieworg).z;",
    "  float s = sign(dir_z);",
    "  dir_z += 0.00001 * (1.0 - s * s);",
    "  float eye = u_vieworg.z - u_hf_start.w;",
    "  float pos = v_world_pos.z - u_hf_start.w;",
    "  float density = (exp(-u_hf_falloff * eye) - exp(-u_hf_falloff * pos)) / (u_hf_falloff * dir_z);",
    "  float extinction = 1.0 - clamp(exp(-density), 0.0, 1.0);",
    "  float fraction = clamp((pos - u_hf_start.w) / (u_hf_end.w - u_hf_start.w), 0.0, 1.0);",
    "  vec3 fog_color = mix(u_hf_start.rgb, u_hf_end.rgb, fraction) * extinction;",
    "  float fog = (1.0 - exp(-(u_hf_density * frag_depth))) * extinction;",
    "  gl_FragColor = vec4(fog_color, fog);",
    "}",
  );
  return lines.join("\n");
}

// --- per-frame activation (q2repro main.c:817-827) ----------------------

let fogGlobal = false;
let fogHeight = false;
let fogSky = false;
let skyDrawn = false;
let warnedNoShaders = false;

export interface FogFrameBitsT {
  readonly global: boolean;
  readonly height: boolean;
  readonly sky: boolean;
}

/*
====================
fogBitsFor

main.c:820-826, as a pure predicate so the gating is testable without a
context. `useShaders` is q2repro's `gl_static.use_shaders`; `fogEnabled` is
`gl_fog->integer > 0`.
====================
*/
export function fogBitsFor(fd: { fog: { density: number; skyFactor: number }; heightfog: { density: number; falloff: number } }, useShaders: boolean, fogEnabled: boolean): FogFrameBitsT {
  if (!useShaders || !fogEnabled) return { global: false, height: false, sky: false };
  return {
    global: fd.fog.density > 0,
    height: fd.heightfog.density > 0 && fd.heightfog.falloff > 0,
    sky: fd.fog.skyFactor > 0,
  };
}

/*
====================
GL_FogFrameSetup

Run once per frame from R_RenderView, after the refdef has been copied and
before R_DrawWorld -- R_DrawSkyBox consults GL_FogActive() to decide
whether to pin the sky's depth, so the answer has to be settled first.
====================
*/
export function GL_FogFrameSetup(): void {
  skyDrawn = false;

  const ztrick = glCvars.gl_ztrick ? glCvars.gl_ztrick.value !== 0 : false;
  const fogEnabled = glCvars.gl_fog ? glCvars.gl_fog.value > 0 : true;
  const bits = fogBitsFor(r_newrefdef, GL_UsingShaderPath() && !ztrick, fogEnabled);

  fogGlobal = bits.global;
  fogHeight = bits.height;
  fogSky = bits.sky;

  if (fogEnabled && !GL_UsingShaderPath() && !warnedNoShaders && (r_newrefdef.fog.density > 0 || r_newrefdef.heightfog.density > 0)) {
    warnedNoShaders = true;
    ri.Con_Printf(PRINT_ALL, "gl_fog: this map asks for fog, which needs gl_shaders 1 (see gl_fog.ts's header for why the fixed-function path cannot render it)\n");
  }
}

export function GL_FogActive(): boolean {
  return fogGlobal || fogHeight || fogSky;
}

// Called by gl_warp.ts's R_DrawSkyBox once it has actually painted sky
// quads, so the flat sky-factor pass only runs where a sky exists (an
// empty/void background must stay untouched).
export function GL_FogNoteSkyDrawn(): void {
  skyDrawn = true;
}

// --- the pass -----------------------------------------------------------

const programs = new Map<FogPassKind, GlProgramT | null>();
let depthTexture = 0;

function getFogProgram(kind: FogPassKind): GlProgramT | null {
  const cached = programs.get(kind);
  if (cached !== undefined) return cached;
  const built = GL_BuildProgram(buildFogVertexShaderSource(kind), buildFogFragmentShaderSource(kind), fogUniformsFor(kind));
  programs.set(kind, built);
  return built;
}

export function GL_ShutdownFog(): void {
  if (qgl.qglDeleteProgram) {
    for (const p of programs.values()) if (p) qgl.qglDeleteProgram(p.program);
  }
  programs.clear();
  if (depthTexture !== 0) {
    const names = new Int32Array([depthTexture]);
    qgl.qglDeleteTextures(1, names);
    depthTexture = 0;
  }
  fogGlobal = fogHeight = fogSky = skyDrawn = false;
  warnedNoShaders = false;
}

function drawFullscreenQuad(): void {
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(0, 0);
  qgl.qglVertex3f(-1, -1, 0);
  qgl.qglTexCoord2f(1, 0);
  qgl.qglVertex3f(1, -1, 0);
  qgl.qglTexCoord2f(1, 1);
  qgl.qglVertex3f(1, 1, 0);
  qgl.qglTexCoord2f(0, 1);
  qgl.qglVertex3f(-1, 1, 0);
  qgl.qglEnd();
}

function setUniform1f(prog: GlProgramT, name: string, v: number): void {
  const loc = prog.uniforms.get(name);
  if (loc !== undefined && loc >= 0 && qgl.qglUniform1f) qgl.qglUniform1f(loc, v);
}
function setUniform1i(prog: GlProgramT, name: string, v: number): void {
  const loc = prog.uniforms.get(name);
  if (loc !== undefined && loc >= 0 && qgl.qglUniform1i) qgl.qglUniform1i(loc, v);
}
function setUniform3f(prog: GlProgramT, name: string, a: number, b: number, c: number): void {
  const loc = prog.uniforms.get(name);
  if (loc !== undefined && loc >= 0 && qgl.qglUniform3f) qgl.qglUniform3f(loc, a, b, c);
}
function setUniform4f(prog: GlProgramT, name: string, a: number, b: number, c: number, d: number): void {
  const loc = prog.uniforms.get(name);
  if (loc !== undefined && loc >= 0 && qgl.qglUniform4f) qgl.qglUniform4f(loc, a, b, c, d);
}

/*
====================
GL_DrawFogPass

Called at the very end of R_RenderView's 3D work (after alpha surfaces,
before R_Flash's screen blend -- q2repro likewise applies fog inside the
scene shaders and the polyblend afterwards).
====================
*/
export function GL_DrawFogPass(zNear: number, zFar: number): void {
  if (!GL_FogActive()) return;
  if (!qgl.qglUseProgram || !qgl.qglCopyTexImage2D) return;

  // Viewport rectangle, recomputed exactly as R_SetupGL does, because the
  // depth copy and the quad both have to line up with the scene's pixels.
  const x = Math.floor(r_newrefdef.x);
  const y2 = Math.ceil(vid.height - (r_newrefdef.y + r_newrefdef.height));
  const w = Math.ceil(r_newrefdef.x + r_newrefdef.width) - x;
  const h = Math.floor(vid.height - r_newrefdef.y) - y2;
  if (w <= 0 || h <= 0) return;

  if (depthTexture === 0) {
    const names = new Int32Array(1);
    qgl.qglGenTextures(1, names);
    depthTexture = names[0] ?? 0;
    if (depthTexture === 0) return;
    qgl.qglBindTexture(GL_TEXTURE_2D, depthTexture);
    qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    qgl.qglTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  } else {
    qgl.qglBindTexture(GL_TEXTURE_2D, depthTexture);
  }

  // Snapshot the scene's depth. glCopyTexImage2D reallocates every frame,
  // which keeps this correct across vid_restart and viewport changes with
  // no size bookkeeping; the copy is a GPU-local blit, not a readback.
  qgl.qglCopyTexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT24, x, y2, w, h, 0);

  // gl_image.ts's GL_Bind cache was never told about that bind.
  gl_state.currenttextures[0] = -1;

  const coeff = projectionInverseCoefficients(zNear, zFar);
  const farDepth = gldepthmax - FOG_SKY_DEPTH_EPSILON;

  qgl.qglMatrixMode(GL_PROJECTION);
  qgl.qglPushMatrix();
  qgl.qglLoadIdentity();
  qgl.qglMatrixMode(GL_MODELVIEW);
  qgl.qglPushMatrix();
  qgl.qglLoadIdentity();

  qgl.qglDisable(GL_DEPTH_TEST);
  qgl.qglDepthMask(false);
  qgl.qglDisable(GL_CULL_FACE);
  qgl.qglDisable(GL_ALPHA_TEST);
  qgl.qglEnable(GL_BLEND);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglColor4f(1, 1, 1, 1);

  const fog = r_newrefdef.fog;
  const hf = r_newrefdef.heightfog;

  // ---- global (shader.c:722-731) ----
  if (fogGlobal) {
    const prog = getFogProgram(FOG_PASS_GLOBAL);
    if (prog) {
      qgl.qglUseProgram(prog.program);
      setUniform1i(prog, "u_depth", 0);
      setUniform1f(prog, "u_far_depth", farDepth);
      setUniform4f(prog, "u_proj", coeff.a, coeff.b, 0, 0);
      setUniform4f(prog, "u_fog_color", fog.color[0], fog.color[1], fog.color[2], fog.density / FOG_DENSITY_SCALE);
      drawFullscreenQuad();
    }
  }

  // ---- height (shader.c:735-736) ----
  if (fogHeight) {
    const prog = getFogProgram(FOG_PASS_HEIGHT);
    if (prog) {
      qgl.qglUseProgram(prog.program);
      setUniform1i(prog, "u_depth", 0);
      setUniform1f(prog, "u_far_depth", farDepth);
      setUniform4f(prog, "u_proj", coeff.a, coeff.b, 0, 0);
      setUniform3f(prog, "u_vieworg", r_origin[0], r_origin[1], r_origin[2]);
      setUniform3f(prog, "u_forward", vpn[0], vpn[1], vpn[2]);
      setUniform3f(prog, "u_right", vright[0], vright[1], vright[2]);
      setUniform3f(prog, "u_up", vup[0], vup[1], vup[2]);
      // MYgluPerspective's ymax/xmax over zNear: the half-extents of the
      // near plane in eye space, per unit of eye-axis distance.
      const tanY = Math.tan((r_newrefdef.fov_y * Math.PI) / 360);
      const tanX = tanY * (r_newrefdef.width / r_newrefdef.height);
      setUniform4f(prog, "u_tan", tanX, tanY, 0, 0);
      setUniform4f(prog, "u_hf_start", hf.start.color[0], hf.start.color[1], hf.start.color[2], hf.start.dist);
      setUniform4f(prog, "u_hf_end", hf.end.color[0], hf.end.color[1], hf.end.color[2], hf.end.dist);
      setUniform1f(prog, "u_hf_density", hf.density);
      setUniform1f(prog, "u_hf_falloff", hf.falloff);
      drawFullscreenQuad();
    }
  }

  // ---- sky (shader.c:738-739) ----
  if (fogSky && skyDrawn) {
    const prog = getFogProgram(FOG_PASS_SKY);
    if (prog) {
      qgl.qglUseProgram(prog.program);
      setUniform1i(prog, "u_depth", 0);
      setUniform1f(prog, "u_far_depth", farDepth);
      setUniform4f(prog, "u_fog_color", fog.color[0], fog.color[1], fog.color[2], fog.skyFactor);
      drawFullscreenQuad();
    }
  }

  qgl.qglUseProgram(0);

  qgl.qglMatrixMode(GL_PROJECTION);
  qgl.qglPopMatrix();
  qgl.qglMatrixMode(GL_MODELVIEW);
  qgl.qglPopMatrix();

  qgl.qglDisable(GL_BLEND);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglDepthMask(true);
  qgl.qglEnable(GL_DEPTH_TEST);
  if (glCvars.gl_cull && glCvars.gl_cull.value) qgl.qglEnable(GL_CULL_FACE);
}
