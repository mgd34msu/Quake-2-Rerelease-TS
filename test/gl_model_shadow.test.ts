/*
Tests for alias models RECEIVING shadow-map shadows (v1.2.2):
src/ref_gl/gl_shader.ts's GLS_MODEL_SHADOW permutation and
GL_UseAliasModelProgram, plus src/ref_gl/gl_mesh.ts's
aliasShadowLightFractions -- the measurement of how much of a model's
1997-pipeline shade colour each shadow light is responsible for.

Real GLSL compilation still can't run headlessly (no GPU context), so what
is covered here is what can be checked without one, and what actually
decides whether the feature is right:

  * PROGRAM SELECTION. A model that a shadow-mapped light reaches gets the
    program; a model that none reaches keeps the untouched fixed-function
    draw, which is the whole reason a 1997 map renders identically at
    gl_shadowmaps 1 and 0.
  * FIXED-FUNCTION FALLBACK, in every direction it can be needed:
    gl_shaders 0, a context with no program objects, no depth atlas this
    frame, and a light with no atlas rectangle.
  * IDENTICAL OUTPUT WITH NO LIGHTS. The program's fragment stage reduces to
    GL_MODULATE (`texture2D(...) * gl_Color`) with nothing subtracted.
  * The two receivers, world and model, sampling the atlas through
    CHARACTER-IDENTICAL GLSL, so a model's shadow boundary cannot land
    somewhere other than the floor's underneath it.
  * The share arithmetic itself, against R_LightPoint's own dynamic-light
    formula by hand.

Self-sufficient per rule 13: every test sets up exactly the shared module
state it reads.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";
import type { RefImports } from "../src/client/ref";
import { DlightT } from "../src/client/ref";
import { QGLRecording, type QGL } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { glCvars, SetRefImports } from "../src/ref_gl/gl_local";
import { ModelT, MsurfaceT, GlpolyT } from "../src/ref_gl/gl_model";
import {
  GLS_WORLD_SURFACE_SHADOWED,
  GLS_ENTITY_MESH,
  GLS_ENTITY_MESH_SHADOWED,
  GLS_MODEL_SHADOW,
  MAX_SHADER_LIGHTS,
  SHADOW_DEPTH_BIAS,
  SHADOW_CUBE_BIAS,
  SHADOW_CUBE_BIAS_TEXELS,
  SHADOW_MODEL_DEPTH_BIAS,
  SHADOW_MODEL_CUBE_BIAS,
  SHADOW_MODEL_CUBE_BIAS_TEXELS,
  buildVertexShaderSource,
  buildFragmentShaderSource,
  uniformBindingsFor,
  GL_InitShaderPath,
  GL_ShutdownShaderPath,
  GL_UseAliasModelProgram,
  type ModelShadowLightT,
} from "../src/ref_gl/gl_shader";
import { aliasShadowLightFractions, aliasShadeDivisorFor, ALIAS_SHADEDOT_MAX, type AliasShadowLightInputT } from "../src/ref_gl/gl_mesh";
import { GL_ShutdownShadowMaps, GL_ShadowMapBindings, R_RenderShadowMaps, SHADOW_ATLAS_SIZE } from "../src/ref_gl/gl_shadowmap";

function makeFakeRi(): RefImports {
  return {
    Sys_Error(_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand: () => undefined,
    Cmd_RemoveCommand: () => undefined,
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => undefined,
    Con_Printf: () => undefined,
    FS_LoadFile: () => ({ length: -1, data: null }),
    FS_FreeFile: () => undefined,
    FS_Gamedir: () => "",
    Cvar_Get: () => null,
    Cvar_Set: () => null,
    Cvar_SetValue: () => undefined,
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => undefined,
    Vid_NewWindow: () => undefined,
  };
}

function cvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

// A one-triangle world `distance` units down the -X axis -- the same shape
// gl_shadowmap.test.ts uses, and enough geometry for R_RenderShadowMaps to
// hand a light a real atlas rectangle.
function makeWorld(distance: number): ModelT {
  const poly = new GlpolyT();
  poly.numverts = 3;
  poly.verts = [
    Float32Array.from([-distance, -16, -16, 0, 0, 0, 0]),
    Float32Array.from([-distance, 16, -16, 0, 0, 0, 0]),
    Float32Array.from([-distance, 0, 16, 0, 0, 0, 0]),
  ];
  const surf = new MsurfaceT();
  surf.flags = 0;
  surf.polys = poly;
  const model = new ModelT();
  model.numsurfaces = 1;
  model.surfaces = [surf];
  return model;
}

function makeConeLight(): DlightT {
  const dl = new DlightT();
  dl.origin = vec3(0, 0, 0);
  dl.color = vec3(1, 1, 1);
  dl.intensity = 512;
  dl.lightScale = 1;
  dl.resolution = 512;
  dl.cone = { direction: vec3(-1, 0, 0), cosHalfAngle: Math.cos((30 * Math.PI) / 180) };
  dl.isShadowLight = true;
  return dl;
}

// The fraction uniforms arrive as Float32Array components, so an exact ===
// against a JS double misses by the float32 rounding (0.4 stores as
// 0.4000000059604645).
function near(actual: unknown, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-6;
}

function uniformNamesIn(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const m = /^uniform\s+\S+\s+(\w+)/.exec(line.trim());
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

// The atlas-sampling body both receivers share: everything from the `float
// lit` declaration to the line before the receiver's own use of it.
function shadowSamplingBody(source: string): string {
  const start = source.indexOf("      float lit = 1.0;");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  // the block ends at the first line that consumes `lit` -- `result *= lit;`
  // for the world receiver, `keep -= ...` for the model one
  const endWorld = rest.indexOf("      result *= lit;");
  const endModel = rest.indexOf("      keep -= u_light_frac[i]");
  const end = endWorld >= 0 ? endWorld : endModel;
  expect(end).toBeGreaterThan(0);
  return rest.slice(0, end);
}

beforeEach(() => {
  SetQGL(new QGLRecording());
  SetRefImports(makeFakeRi());
  glCvars.gl_shaders = null;
  glCvars.gl_shadowmaps = null;
  glCvars.gl_shadowmap_res = null;
  glCvars.r_drawentities = null;
  glCvars.gl_drawentities = null;
  GL_ShutdownShaderPath();
  GL_ShutdownShadowMaps();
});

describe("gl_shader.ts -- GLS_MODEL_SHADOW GLSL assembly", () => {
  test("with every light unoccluded the fragment stage is GL_MODULATE and nothing else", () => {
    const src = buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED);
    // the alias path's texture environment, written out: texel * clamp(shade)
    expect(src).toContain("vec4 texel = texture2D(u_texture, gl_TexCoord[0].st);");
    expect(src).toContain("vec3 shade = gl_Color.rgb * u_shade_scale;");
    // keep starts unoccluded and is only ever REDUCED, so a model no light
    // reaches (or one every light lights) comes out as texel * min(1, shade)
    expect(src).toContain("vec3 keep = vec3(1.0);");
    expect(src).toContain("keep -= u_light_frac[i] * (1.0 - lit);");
    expect(src.match(/keep\s*=/g)).toEqual(["keep ="]); // one initializer, no other assignment
    expect(src).toContain("gl_FragColor = vec4(texel.rgb * min(shade, vec3(1.0)), texel.a * gl_Color.a);");
  });

  // The defect this pins is the one a play-test found: an orange shadow light
  // removed from a saturated white-ish model tinted its body blue-purple.
  // glColor4f clamps to [0,1], an alias model's shade colour routinely
  // exceeds 1, and removing a light's SHARE from the already-clamped (1,1,1)
  // removes a share of a value the light never reached -- proportionally less
  // blue than red, for an orange light. The removal has to come BEFORE the
  // clamp, so the source order is part of the contract.
  test("the shade is un-clamped, then the light removed, and only then clamped -- in that order", () => {
    const src = buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED);
    const scaled = src.indexOf("vec3 shade = gl_Color.rgb * u_shade_scale;");
    const removed = src.indexOf("shade *= max(keep, vec3(0.0));");
    const clamped = src.indexOf("min(shade, vec3(1.0))");
    expect(scaled).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(scaled);
    expect(clamped).toBeGreaterThan(removed);
    // and the clamp is the shader's own, applied once, to the shade only
    expect(src.match(/min\(shade, vec3\(1\.0\)\)/g)).toEqual(["min(shade, vec3(1.0))"]);
  });

  test("the model receiver samples the base texture, not a lightmap, and adds no lambert term", () => {
    const src = buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED);
    expect(src).toContain("uniform sampler2D u_texture;");
    expect(src).not.toContain("u_lightmap");
    // no per-fragment lighting: an alias model has no per-fragment normal
    // (that is the whole reason this permutation subtracts a measured share
    // instead of scaling a lambert term)
    expect(src).not.toContain("calc_dynamic_lights");
    expect(src).not.toContain("v_normal");
    expect(buildVertexShaderSource(GLS_ENTITY_MESH_SHADOWED)).not.toContain("v_normal");
    expect(buildVertexShaderSource(GLS_ENTITY_MESH_SHADOWED)).not.toContain("gl_Normal");
  });

  test("the model receiver computes gl_Position with ftransform(), like every other permutation", () => {
    const src = buildVertexShaderSource(GLS_ENTITY_MESH_SHADOWED);
    expect(src).toContain("gl_Position = ftransform();");
    expect(src).not.toContain("gl_ModelViewProjectionMatrix");
    // the shadow test is in world space, so the world position still has to
    // make the eye -> world round trip
    expect(src).toContain("v_world_pos = vec3(u_eye_to_world * (gl_ModelViewMatrix * gl_Vertex));");
  });

  test("uniform-binding table matches the model permutation's actual `uniform` declarations", () => {
    const declared = new Set([
      ...uniformNamesIn(buildVertexShaderSource(GLS_ENTITY_MESH_SHADOWED)),
      ...uniformNamesIn(buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED)),
    ]);
    const tabled = new Set(uniformBindingsFor(GLS_ENTITY_MESH_SHADOWED).map((b) => b.name));
    expect(declared).toEqual(tabled);
  });

  test("each uniform array is sized to MAX_SHADER_LIGHTS, u_light_frac included", () => {
    const src = buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED);
    for (const name of ["u_light_frac", "u_light_pos", "u_light_radius", "u_light_shadow", "u_light_atlas", "u_light_matrix"]) {
      expect(src).toContain(`${name}[${MAX_SHADER_LIGHTS}]`);
    }
  });

  // The defect this guards is specific and visible: if the two receivers
  // disagreed about which cube face a point is on, or about how a stored
  // window depth inverts back to a distance, a monster's shadow boundary
  // would sit somewhere other than the floor's directly beneath it.
  test("world and model receivers sample the atlas through character-identical GLSL", () => {
    const world = shadowSamplingBody(buildFragmentShaderSource(GLS_WORLD_SURFACE_SHADOWED));
    const model = shadowSamplingBody(buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED));
    expect(model).toBe(world);
    // and it is not trivially empty
    expect(world).toContain("float axial = dot(lvec, face_f);");
    expect(world).toContain("float stored = pb / ((2.0 * d - 1.0) + pa);");
  });

  test("only the bias differs, and the model's is the wider one -- a model self-shadows, a flat world surface does not", () => {
    const world = buildFragmentShaderSource(GLS_WORLD_SURFACE_SHADOWED);
    const model = buildFragmentShaderSource(GLS_ENTITY_MESH_SHADOWED);
    expect(world).toContain(`#define SHADOW_DEPTH_BIAS ${SHADOW_DEPTH_BIAS}`);
    expect(model).toContain(`#define SHADOW_DEPTH_BIAS ${SHADOW_MODEL_DEPTH_BIAS}`);
    expect(world).toContain(`#define SHADOW_CUBE_BIAS ${SHADOW_CUBE_BIAS.toFixed(1)}`);
    expect(model).toContain(`#define SHADOW_CUBE_BIAS ${SHADOW_MODEL_CUBE_BIAS.toFixed(1)}`);
    expect(SHADOW_MODEL_DEPTH_BIAS).toBeGreaterThan(SHADOW_DEPTH_BIAS);
    expect(SHADOW_MODEL_CUBE_BIAS).toBeGreaterThan(SHADOW_CUBE_BIAS);
    expect(SHADOW_MODEL_CUBE_BIAS_TEXELS).toBeGreaterThan(SHADOW_CUBE_BIAS_TEXELS);
  });

  test("GLS_MODEL_SHADOW is its own bit -- it never turns on the world receiver's lambert loop", () => {
    expect(GLS_ENTITY_MESH_SHADOWED).toBe(GLS_MODEL_SHADOW);
    expect(GLS_ENTITY_MESH_SHADOWED & GLS_ENTITY_MESH).toBe(0);
  });
});

describe("gl_mesh.ts -- aliasShadowLightFractions (a shadow light's share of an alias model's shade colour)", () => {
  const at = (x: number, y: number, z: number): Vec3 => vec3(x, y, z);

  function light(origin: Vec3, intensity: number, color: Vec3, lightIndex = 0): AliasShadowLightInputT {
    return { lightIndex, origin, color, intensity };
  }

  test("matches R_LightPoint's own dynamic-light term by hand", () => {
    // R_LightPoint: add = (intensity - dist) / 256; color += add * dl->color;
    // then the whole colour is scaled by gl_modulate.
    // intensity 300, dist 44 -> add = 256/256 = 1.0; * modulate 2 = 2.0.
    // colour (0.5, 0.25, 0) -> contribution (1.0, 0.5, 0).
    // Against a final shade of (2, 2, 2) the shares are (0.5, 0.25, 0).
    const out = aliasShadowLightFractions(at(44, 0, 0), at(2, 2, 2), 2, false, [light(at(0, 0, 0), 300, at(0.5, 0.25, 0))]);
    expect(out.length).toBe(1);
    expect(out[0]?.lightIndex).toBe(0);
    expect(out[0]?.fraction[0]).toBeCloseTo(0.5, 10);
    expect(out[0]?.fraction[1]).toBeCloseTo(0.25, 10);
    expect(out[0]?.fraction[2]).toBeCloseTo(0, 10);
  });

  test("a light further away than its own intensity contributes nothing and is dropped entirely", () => {
    // add = (100 - 200)/256 < 0, which R_LightPoint's `if (add > 0)` skips.
    // Dropping it (rather than passing a zero share) is what keeps the model
    // on the fixed-function path when nothing reaches it.
    const out = aliasShadowLightFractions(at(200, 0, 0), at(1, 1, 1), 1, false, [light(at(0, 0, 0), 100, at(1, 1, 1))]);
    expect(out).toEqual([]);
  });

  test("a share is clamped to 1 -- RF_MINLIGHT and RF_GLOW change the shade colour after the light went into it", () => {
    // contribution 1.0 per channel against a shade of 0.1 would be 10x.
    const out = aliasShadowLightFractions(at(0, 0, 0), at(0.1, 0.1, 0.1), 1, false, [light(at(0, 0, 0), 256, at(1, 1, 1))]);
    expect(out[0]?.fraction[0]).toBe(1);
    expect(out[0]?.fraction[1]).toBe(1);
    expect(out[0]?.fraction[2]).toBe(1);
  });

  test("a black shade colour yields no share at all rather than a division by zero", () => {
    const out = aliasShadowLightFractions(at(0, 0, 0), at(0, 0, 0), 1, false, [light(at(0, 0, 0), 256, at(1, 1, 1))]);
    expect(out).toEqual([]);
  });

  test("gl_monolightmap collapses the contribution the same way it collapses the shade colour", () => {
    // R_DrawAliasModel flattens shadelight to its greatest channel under
    // gl_monolightmap; a contribution measured per-channel against that flat
    // colour would understate the two channels it zeroed.
    const mono = aliasShadowLightFractions(at(0, 0, 0), at(1, 1, 1), 1, true, [light(at(0, 0, 0), 256, at(0.5, 0.1, 0))]);
    expect(mono[0]?.fraction[0]).toBeCloseTo(0.5, 6);
    expect(mono[0]?.fraction[1]).toBeCloseTo(0.5, 6);
    expect(mono[0]?.fraction[2]).toBeCloseTo(0.5, 6);

    const colour = aliasShadowLightFractions(at(0, 0, 0), at(1, 1, 1), 1, false, [light(at(0, 0, 0), 256, at(0.5, 0.1, 0))]);
    expect(colour[0]?.fraction[1]).toBeCloseTo(0.1, 6);
    expect(colour[0]?.fraction[2]).toBeCloseTo(0, 6);
  });

  test("several lights each keep their own index, and one that reaches nothing drops out of the middle", () => {
    const out = aliasShadowLightFractions(at(0, 0, 0), at(1, 1, 1), 1, false, [
      light(at(0, 0, 0), 256, at(0.4, 0.4, 0.4), 0),
      light(at(9000, 0, 0), 256, at(1, 1, 1), 1),
      light(at(0, 0, 0), 256, at(0.2, 0.2, 0.2), 2),
    ]);
    expect(out.map((entry) => entry.lightIndex)).toEqual([0, 2]);
  });
});

describe("gl_shader.ts -- GL_UseAliasModelProgram selection and fallback", () => {
  const affecting: ModelShadowLightT[] = [{ lightIndex: 0, fraction: vec3(0.5, 0.4, 0.3) }];

  function activateShaderPath(rec: QGLRecording): void {
    SetQGL(rec);
    SetRefImports(makeFakeRi());
    glCvars.gl_shaders = cvar(1);
    GL_InitShaderPath();
  }

  test("returns false when the shader path isn't active -- the model draws fixed-function", () => {
    SetQGL(new QGLRecording());
    GL_ShutdownShaderPath();
    expect(GL_UseAliasModelProgram([makeConeLight()], affecting, 1)).toBe(false);
  });

  test("returns false on a context with no program objects", () => {
    const rec: QGL = new QGLRecording();
    rec.qglCreateProgram = null;
    rec.qglUseProgram = null;
    SetQGL(rec);
    SetRefImports(makeFakeRi());
    glCvars.gl_shaders = cvar(1);
    GL_InitShaderPath();
    expect(GL_UseAliasModelProgram([makeConeLight()], affecting, 1)).toBe(false);
  });

  // The 1997-map case, and the common kex case: the shader path is fully up,
  // shadow maps are on, and no shadow light reaches this model. Nothing is
  // bound, so the model is rasterized by the identical fixed-function
  // pipeline it was before models became receivers.
  test("returns false, binding no program at all, when no shadow light affects the model", () => {
    const rec = new QGLRecording();
    activateShaderPath(rec);
    R_RenderShadowMaps(makeWorld(100), [makeConeLight()], 1);
    expect(GL_ShadowMapBindings().length).toBe(1);
    rec.clear();

    expect(GL_UseAliasModelProgram([makeConeLight()], [], 1)).toBe(false);
    expect(rec.calls.some((c) => c.name === "qglUseProgram")).toBe(false);
  });

  test("returns false when no light got a depth rectangle this frame", () => {
    const rec = new QGLRecording();
    activateShaderPath(rec);
    // no R_RenderShadowMaps call at all: no atlas, no bindings
    expect(GL_ShadowMapBindings().length).toBe(0);
    rec.clear();
    expect(GL_UseAliasModelProgram([makeConeLight()], affecting, 1)).toBe(false);
    expect(rec.calls.some((c) => c.name === "qglUseProgram")).toBe(false);
  });

  test("a light that affects the model but has no atlas rectangle keeps the model unshadowed", () => {
    const rec = new QGLRecording();
    activateShaderPath(rec);
    R_RenderShadowMaps(makeWorld(100), [makeConeLight()], 1);
    rec.clear();
    // light 3 was never rendered -- only light 0 has a binding
    expect(GL_UseAliasModelProgram([makeConeLight()], [{ lightIndex: 3, fraction: vec3(1, 1, 1) }], 1)).toBe(false);
    expect(rec.calls.some((c) => c.name === "qglUseProgram")).toBe(false);
  });

  test("binds the program and uploads the light's share, its atlas rectangle and the depth atlas when a shadow light does affect the model", () => {
    const rec = new QGLRecording();
    activateShaderPath(rec);
    const cone = makeConeLight();
    R_RenderShadowMaps(makeWorld(100), [cone], 1);
    const binding = GL_ShadowMapBindings()[0];
    expect(binding).toBeDefined();
    rec.clear();

    expect(GL_UseAliasModelProgram([cone], affecting, 3.5)).toBe(true);
    expect(rec.calls.some((c) => c.name === "qglUseProgram" && c.args[0] !== 0)).toBe(true);

    // The program was compiled before rec.clear(), so assert on the VALUES
    // that were set rather than on locations from that earlier compile.
    const uniform3f = rec.calls.filter((c) => c.name === "qglUniform3f");
    const fracCall = uniform3f.find((c) => near(c.args[1], 0.5) && near(c.args[2], 0.4) && near(c.args[3], 0.3));
    expect(fracCall).toBeDefined();

    // the atlas rectangle, normalized to [0,1] atlas UV
    const uniform4f = rec.calls.filter((c) => c.name === "qglUniform4f");
    const atlasCall = uniform4f.find((c) => c.args[3] === (binding?.slot.width ?? 0) / SHADOW_ATLAS_SIZE);
    expect(atlasCall).toBeDefined();

    // the depth atlas is bound to TMU 1 and the active unit put back to 0
    const active = rec.calls.filter((c) => c.name === "qglActiveTexture").map((c) => c.args[0]);
    expect(active).toEqual([0x84c1, 0x84c0]);
    // ...and the sampler uniform points at unit 1, the base texture at unit 0
    const uniform1i = rec.calls.filter((c) => c.name === "qglUniform1i").map((c) => c.args[1]);
    expect(uniform1i).toContain(1);
    expect(uniform1i).toContain(0);
  });

  test("slots below the light count that this model is not affected by are zeroed, not left stale", () => {
    const rec = new QGLRecording();
    activateShaderPath(rec);
    const a = makeConeLight();
    const b = makeConeLight();
    b.origin = vec3(0, 400, 0);
    R_RenderShadowMaps(makeWorld(100), [a, b], 2);
    expect(GL_ShadowMapBindings().length).toBe(2);
    rec.clear();

    // only light 1 affects this model; slot 0 is below the count and must be
    // written as "no shadow" rather than inheriting the previous model's kind
    expect(GL_UseAliasModelProgram([a, b], [{ lightIndex: 1, fraction: vec3(0.5, 0.5, 0.5) }], 1)).toBe(true);
    const kindWrites = rec.calls.filter((c) => c.name === "qglUniform1f" && c.args[1] === 0);
    expect(kindWrites.length).toBeGreaterThanOrEqual(1);
  });
});

describe("gl_mesh.ts / gl_shader.ts -- the clamp order (regression: blue-purple barrels)", () => {
  // What the two stages do between them, in plain arithmetic. The mesh paths
  // submit l * shade / divisor, glColor4f clamps that to [0,1], the fragment
  // stage multiplies by u_shade_scale (= divisor), removes each light's share
  // and clamps. The GLSL is the same expressions in the same order.
  function submittedColour(l: number, shade: Vec3, divisor: number): Vec3 {
    const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
    return vec3(clamp01((l * shade[0]) / divisor), clamp01((l * shade[1]) / divisor), clamp01((l * shade[2]) / divisor));
  }
  function fragment(colour: Vec3, divisor: number, keep: Vec3): Vec3 {
    const out = vec3(colour[0] * divisor * keep[0], colour[1] * divisor * keep[1], colour[2] * divisor * keep[2]);
    return vec3(Math.min(out[0], 1), Math.min(out[1], 1), Math.min(out[2], 1));
  }

  // base1's dyn_target_02 measured at the barrels the play-test flagged:
  // radius 768 at ~100 units gives R_LightPoint an `add` of 2.6, against a
  // warm lightmap sample. The light's colour is the shipped (1, 1, 0.502).
  const lightmapOnly: Vec3 = vec3(0.34, 0.28, 0.22);
  const lightColour: Vec3 = vec3(1, 1, 0.501961); // the shipped shadow lights' own orange
  const add = 2.61; // R_LightPoint's (intensity - distance) / 256 at that barrel
  const contribution: Vec3 = vec3(add * lightColour[0], add * lightColour[1], add * lightColour[2]);
  const shade: Vec3 = vec3(lightmapOnly[0] + contribution[0], lightmapOnly[1] + contribution[1], lightmapOnly[2] + contribution[2]);
  const fractions = aliasShadowLightFractions(vec3(0, 0, 0), shade, 1, false, [
    { lightIndex: 0, origin: vec3(0, 0, 0), color: lightColour, intensity: 256 * add },
  ]);
  const keepFully = vec3(1 - (fractions[0]?.fraction[0] ?? 0), 1 - (fractions[0]?.fraction[1] ?? 0), 1 - (fractions[0]?.fraction[2] ?? 0));

  test("this model really does saturate -- the case the arithmetic has to survive", () => {
    // every channel of l * shade clears 1.0 even at the SMALLEST shadedot
    // (0.70), so an undivided submission is (1,1,1) over the whole model
    const submittedRaw = submittedColour(0.7, shade, 1);
    expect(submittedRaw[0]).toBe(1);
    expect(submittedRaw[1]).toBe(1);
    expect(submittedRaw[2]).toBe(1);
  });

  test("aliasShadeDivisorFor gives enough headroom that nothing clamps on the way in", () => {
    const divisor = aliasShadeDivisorFor(shade);
    for (const l of [0.7, 1.0, 1.5, ALIAS_SHADEDOT_MAX]) {
      const c = submittedColour(l, shade, divisor);
      for (let ch = 0; ch < 3; ch++) {
        // reached the shader un-clamped: the submitted value is still the
        // true l * shade / divisor
        expect(c[ch]).toBeCloseTo((l * shade[ch]) / divisor, 5);
      }
    }
  });

  test("a model already inside [0,1] is passed through with divisor 1 -- no amplification", () => {
    expect(aliasShadeDivisorFor(vec3(0.4, 0.3, 0.2))).toBe(1);
    expect(aliasShadeDivisorFor(vec3(0, 0, 0))).toBe(1);
    expect(aliasShadeDivisorFor(vec3(2.95, 2.89, 1.53))).toBeCloseTo(2.95 * ALIAS_SHADEDOT_MAX, 5);
  });

  test("fully occluded, the model falls back to the lightmap-only colour and stays WARM", () => {
    const divisor = aliasShadeDivisorFor(shade);
    const l = 1.5;
    const out = fragment(submittedColour(l, shade, divisor), divisor, keepFully);
    const want = vec3(Math.min(l * lightmapOnly[0], 1), Math.min(l * lightmapOnly[1], 1), Math.min(l * lightmapOnly[2], 1));
    for (let ch = 0; ch < 3; ch++) expect(out[ch]).toBeCloseTo(want[ch], 5);
    // the shipped shadow lights are orange, so removing one can never leave a
    // COLDER surface than it started: red must still lead blue
    expect(out[0]).toBeGreaterThan(out[2]);
    expect(out[1]).toBeGreaterThan(out[2]);
  });

  test("clamping BEFORE the removal is what tinted it blue -- the old order fails this", () => {
    const l = 1.5;
    // the defect, written out: clamp first (divisor 1), scale after
    const clampedFirst = submittedColour(l, shade, 1);
    const wrong = vec3(clampedFirst[0] * keepFully[0], clampedFirst[1] * keepFully[1], clampedFirst[2] * keepFully[2]);
    // blue outlives green, which is exactly the blue-purple that was reported
    expect(wrong[2]).toBeGreaterThan(wrong[1]);

    const divisor = aliasShadeDivisorFor(shade);
    const right = fragment(submittedColour(l, shade, divisor), divisor, keepFully);
    expect(right[2]).toBeLessThan(right[1]);
    expect(right[0]).toBeGreaterThan(wrong[0]);
  });

  test("with nothing occluded the arithmetic is the fixed-function result exactly, saturation included", () => {
    const divisor = aliasShadeDivisorFor(shade);
    for (const l of [0.7, 1.0, 1.5, ALIAS_SHADEDOT_MAX]) {
      const out = fragment(submittedColour(l, shade, divisor), divisor, vec3(1, 1, 1));
      for (let ch = 0; ch < 3; ch++) expect(out[ch]).toBeCloseTo(Math.min(l * shade[ch], 1), 5);
    }
  });
});
