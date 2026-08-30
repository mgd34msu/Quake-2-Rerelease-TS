/*
Tests for task #25 (v1.1.0)'s GL2+ per-pixel-lighting shader path
(src/ref_gl/gl_shader.ts, src/ref_gl/qgl.ts's GL2 program-object additions,
and the client-side CS_SHADOWLIGHTS pipeline in src/client/cl_fx.ts /
src/client/cl_view.ts). Per this unit's brief, real shader COMPILATION can't
run headlessly (no GPU context) -- this suite covers exactly what can be
verified without one: GLSL source assembly, the uniform-binding table's
consistency with that source, the per-pixel light-contribution math
(cross-checked against q2repro's calc_dynamic_lights/fade_distance_to_light
formulas, cited inline), CS_SHADOWLIGHTS wire-format parsing, and the
GL_InitShaderPath capability probe's graceful fallback to fixed-function
using QGLRecording doubles (this project's own no-GPU-needed test seam --
see qgl.ts's header comment on QGLRecording). Self-sufficient per rule 13:
every test sets up exactly the shared module state it reads.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";
import type { RefImports } from "../src/client/ref";
import { DlightT } from "../src/client/ref";
import { QGLRecording, type QGL } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { glCvars, SetRefImports } from "../src/ref_gl/gl_local";
import {
  GLS_WORLD_SURFACE,
  GLS_ENTITY_MESH,
  GLS_LIGHTMAP,
  GLS_DYNAMIC_LIGHTS,
  MAX_SHADER_LIGHTS,
  buildVertexShaderSource,
  buildFragmentShaderSource,
  uniformBindingsFor,
  pointLightFalloff,
  spotConeAttenuation,
  calcDynamicLightContribution,
  GL_InitShaderPath,
  GL_ShutdownShaderPath,
  GL_UsingShaderPath,
  GL_UseWorldSurfaceProgram,
} from "../src/ref_gl/gl_shader";
import { cl, ShadowLightT } from "../src/client/client";
import { CL_ParseShadowLightConfigstring } from "../src/client/cl_fx";
import { fadeDistanceToLight } from "../src/client/cl_view";

function makeFakeRi(overrides: Partial<RefImports> = {}): RefImports {
  const cvarSetValueCalls: { name: string; value: number }[] = [];
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
    Cvar_SetValue: (name: string, value: number) => {
      cvarSetValueCalls.push({ name, value });
    },
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => undefined,
    Vid_NewWindow: () => undefined,
    ...overrides,
  };
}

// A QGL double simulating a context/driver with no GL2 program-object
// support at all (every dummy-video-driver / pre-GL2 case this unit's
// GL_InitShaderPath must fall back cleanly from) -- QGLRecording resolves
// its GL2 members exactly like a real capable context would (see qgl.ts),
// so this forces them back to null the way qgl.ts's own resolveGLShaderAPI
// would on a context missing even one of them.
function makeNoShaderQGL(): QGL {
  // Mutates a QGLRecording instance's own GL2 arrow-function fields back to
  // null (rather than spreading the instance, which would drop its
  // prototype methods -- qglBegin/qglVertex3fv/etc are plain class methods,
  // not own properties, so `{ ...rec }` silently loses them).
  const rec: QGL = new QGLRecording();
  rec.qglCreateShader = null;
  rec.qglShaderSource = null;
  rec.qglCompileShader = null;
  rec.qglGetShaderiv = null;
  rec.qglGetShaderInfoLog = null;
  rec.qglDeleteShader = null;
  rec.qglCreateProgram = null;
  rec.qglAttachShader = null;
  rec.qglLinkProgram = null;
  rec.qglGetProgramiv = null;
  rec.qglGetProgramInfoLog = null;
  rec.qglDeleteProgram = null;
  rec.qglUseProgram = null;
  rec.qglGetUniformLocation = null;
  rec.qglUniform1i = null;
  rec.qglUniform1f = null;
  rec.qglUniform3f = null;
  rec.qglUniform3fv = null;
  rec.qglUniform4f = null;
  return rec;
}

function extractUniformNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const m = /^uniform\s+\S+\s+(\w+)/.exec(line.trim());
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

beforeEach(() => {
  SetQGL(new QGLRecording());
  glCvars.gl_shaders = null;
  glCvars.gl_per_pixel_lighting = null;
  GL_ShutdownShaderPath();
});

describe("gl_shader.ts -- GLSL source assembly", () => {
  test("world-surface permutation samples u_lightmap, not u_texture", () => {
    const src = buildFragmentShaderSource(GLS_WORLD_SURFACE);
    expect(src).toContain("uniform sampler2D u_lightmap;");
    expect(src).not.toContain("u_texture");
  });

  test("entity-mesh permutation samples u_texture, not u_lightmap", () => {
    const src = buildFragmentShaderSource(GLS_ENTITY_MESH);
    expect(src).toContain("uniform sampler2D u_texture;");
    expect(src).not.toContain("u_lightmap");
  });

  test("GLS_DYNAMIC_LIGHTS emits calc_dynamic_lights() and both call sites use it", () => {
    const worldSrc = buildFragmentShaderSource(GLS_WORLD_SURFACE);
    const entitySrc = buildFragmentShaderSource(GLS_ENTITY_MESH);
    expect(worldSrc).toContain("vec3 calc_dynamic_lights()");
    expect(worldSrc).toContain("lm += calc_dynamic_lights();");
    expect(entitySrc).toContain("base.rgb += calc_dynamic_lights();");
  });

  test("without GLS_DYNAMIC_LIGHTS, no light-uniform declarations or normal varying are emitted", () => {
    const src = buildFragmentShaderSource(GLS_LIGHTMAP);
    expect(src).not.toContain("calc_dynamic_lights");
    expect(src).not.toContain("u_light_count");
    expect(buildVertexShaderSource(GLS_LIGHTMAP)).not.toContain("v_normal");
  });

  test("vertex shader feeds gl_Normal into v_normal only when dynamic lights are requested", () => {
    const withLights = buildVertexShaderSource(GLS_WORLD_SURFACE);
    expect(withLights).toContain("gl_NormalMatrix * gl_Normal");
    expect(withLights).toContain("gl_ModelViewProjectionMatrix * gl_Vertex");
  });

  test("uniform-binding table matches the fragment source's actual `uniform` declarations (world surface)", () => {
    const src = buildFragmentShaderSource(GLS_WORLD_SURFACE);
    const declared = new Set(extractUniformNames(src));
    const tabled = new Set(uniformBindingsFor(GLS_WORLD_SURFACE).map((b) => b.name));
    expect(declared).toEqual(tabled);
  });

  test("uniform-binding table matches the fragment source's actual `uniform` declarations (entity mesh)", () => {
    const src = buildFragmentShaderSource(GLS_ENTITY_MESH);
    const declared = new Set(extractUniformNames(src));
    const tabled = new Set(uniformBindingsFor(GLS_ENTITY_MESH).map((b) => b.name));
    expect(declared).toEqual(tabled);
  });

  test("light-uniform arrays are sized to MAX_SHADER_LIGHTS", () => {
    const src = buildFragmentShaderSource(GLS_WORLD_SURFACE);
    expect(src).toContain(`u_light_pos[${MAX_SHADER_LIGHTS}]`);
    expect(src).toContain(`u_light_color[${MAX_SHADER_LIGHTS}]`);
  });
});

describe("gl_shader.ts -- per-pixel light math (mirrors q2repro shader.c's calc_dynamic_lights)", () => {
  test("pointLightFalloff at zero distance: (radius+64-0-64)/(radius+64) -- hand math", () => {
    // q2repro: radius = light.radius + CUTOFF; len = max(radius-dist-CUTOFF,0)/radius.
    // radius=100 -> effectiveRadius=164; len = (164-0-64)/164 = 100/164.
    expect(pointLightFalloff(0, 100)).toBeCloseTo(100 / 164, 10);
  });

  test("pointLightFalloff clamps to zero beyond range, never negative", () => {
    expect(pointLightFalloff(10000, 100)).toBe(0);
  });

  test("pointLightFalloff decreases monotonically with distance", () => {
    const near = pointLightFalloff(10, 200);
    const far = pointLightFalloff(150, 200);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  test("spotConeAttenuation is maximal (1) dead-center in the cone", () => {
    const coneDirection = vec3(0, 0, -1); // spotlight aimed straight down
    const dirFragToLight = vec3(0, 0, 1); // fragment directly below, looking straight up at the light
    expect(spotConeAttenuation(dirFragToLight, coneDirection, 0.9)).toBeCloseTo(1, 10);
  });

  test("spotConeAttenuation is zero outside the cone", () => {
    const coneDirection = vec3(0, 0, -1);
    const dirFragToLight = vec3(1, 0, 0); // 90 degrees off-axis
    expect(spotConeAttenuation(dirFragToLight, coneDirection, 0.9)).toBe(0);
  });

  test("calcDynamicLightContribution: omni light directly above a floor point lights it", () => {
    const light = { origin: vec3(0, 0, 50), radius: 200, color: vec3(1, 1, 1), scale: 1, cone: null };
    const fragPos = vec3(0, 0, 0);
    const normal = vec3(0, 0, 1); // floor facing up, toward the light
    const result = calcDynamicLightContribution(light, fragPos, normal);
    expect(result[0]).toBeGreaterThan(0);
    expect(result[0]).toBe(result[1]);
    expect(result[1]).toBe(result[2]);
  });

  test("calcDynamicLightContribution: a surface facing away from the light gets no contribution", () => {
    const light = { origin: vec3(0, 0, 50), radius: 200, color: vec3(1, 1, 1), scale: 1, cone: null };
    const fragPos = vec3(0, 0, 0);
    const normal = vec3(0, 0, -1); // floor facing down, away from the light
    const result = calcDynamicLightContribution(light, fragPos, normal);
    expect(result[0]).toBe(0);
  });

  test("calcDynamicLightContribution: fullbright sentinel (color.r < 0) skips the lambert term", () => {
    // q2repro calc_dynamic_lights(): `if (color.r < 0) lambert = 1;` -- a
    // surface facing directly away from the light still gets full falloff
    // brightness when this sentinel is set (e.g. EF_TRACKERTRAIL lights).
    const light = { origin: vec3(0, 0, 50), radius: 200, color: vec3(-1, -1, -1), scale: 1, cone: null };
    const fragPos = vec3(0, 0, 0);
    const normal = vec3(0, 0, -1);
    const result = calcDynamicLightContribution(light, fragPos, normal);
    expect(result[0]).toBeLessThan(0); // color is negative; magnitude is what matters
    expect(Math.abs(result[0])).toBeGreaterThan(0);
  });

  test("calcDynamicLightContribution: a cone light excludes a point behind its aim direction", () => {
    const light = {
      origin: vec3(0, 0, 50),
      radius: 200,
      color: vec3(1, 1, 1),
      scale: 1,
      cone: { direction: vec3(1, 0, 0), cosHalfAngle: 0.9 }, // aimed +X, fragment is directly below (not in the beam)
    };
    const fragPos = vec3(0, 0, 0);
    const normal = vec3(0, 0, 1);
    const result = calcDynamicLightContribution(light, fragPos, normal);
    expect(result[0]).toBe(0);
  });
});

describe("cl_view.ts -- fadeDistanceToLight (q2repro view.c)", () => {
  test("default fade_start=fade_end=0 (every classic V_AddLight caller) is always fully lit", () => {
    expect(fadeDistanceToLight(0, 0, vec3(1000, 0, 0), vec3(0, 0, 0))).toBe(1);
  });

  test("fully faded out at or beyond fade_end", () => {
    expect(fadeDistanceToLight(64, 128, vec3(128, 0, 0), vec3(0, 0, 0))).toBeCloseTo(0, 5);
  });

  test("fully lit at or inside fade_start", () => {
    expect(fadeDistanceToLight(64, 128, vec3(10, 0, 0), vec3(0, 0, 0))).toBe(1);
  });
});

describe("cl_fx.ts -- CL_ParseShadowLightConfigstring (q2repro precache.c's CS_LoadShadowLight)", () => {
  beforeEach(() => {
    cl.shadowdefs[0] = { number: 0, light: new ShadowLightT() };
  });

  test("parses a well-formed point-light configstring (matches kexgame/g_misc.ts's writer format)", () => {
    const s = "5;0;300;512;2;0;0;-1;45;0;0;0";
    CL_ParseShadowLightConfigstring(0, s);
    const def = cl.shadowdefs[0];
    expect(def.number).toBe(5);
    expect(def.light.radius).toBe(300);
    expect(def.light.resolution).toBe(512);
    expect(def.light.intensity).toBe(2);
    expect(def.light.lightstyle).toBe(-1);
    expect(def.light.coneangle).toBe(0); // is_cone=0 -> forced to 0 regardless of field 8
  });

  test("parses a well-formed cone-light configstring, coneangle and conedirection survive", () => {
    const s = "7;1;300;512;2;0;0;-1;22.5;1;0;0";
    CL_ParseShadowLightConfigstring(0, s);
    const def = cl.shadowdefs[0];
    expect(def.number).toBe(7);
    expect(def.light.coneangle).toBe(22.5);
    expect(def.light.conedirection[0]).toBe(1);
    expect(def.light.conedirection[1]).toBe(0);
  });

  test("is_cone=0 zeroes coneangle even when the wire field carries a nonzero value", () => {
    const s = "1;0;300;512;2;0;0;-1;99;0;0;0"; // is_cone=0 but coneangle field is garbage-nonzero
    CL_ParseShadowLightConfigstring(0, s);
    expect(cl.shadowdefs[0].light.coneangle).toBe(0);
  });

  test("a malformed configstring (wrong field count) is silently dropped, matching q2repro's `n !== 11` check", () => {
    const before = { ...cl.shadowdefs[0], light: { ...cl.shadowdefs[0].light } };
    CL_ParseShadowLightConfigstring(0, "1;2;3");
    expect(cl.shadowdefs[0].number).toBe(before.number);
    expect(cl.shadowdefs[0].light.radius).toBe(before.light.radius);
  });

  test("an out-of-range slot index is ignored rather than throwing", () => {
    expect(() => CL_ParseShadowLightConfigstring(99999, "5;0;300;512;2;0;0;-1;45;0;0;0")).not.toThrow();
  });
});

describe("gl_shader.ts -- GL_InitShaderPath capability probe and graceful fallback", () => {
  test("gl_shaders 0 (user-disabled) never probes the context at all", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    SetRefImports(makeFakeRi());
    const cvar = new CvarT();
    cvar.value = 0;
    glCvars.gl_shaders = cvar;

    expect(GL_InitShaderPath()).toBe(false);
    expect(GL_UsingShaderPath()).toBe(false);
    expect(rec.calls.length).toBe(0);
  });

  test("a context with no GL2 program objects (dummy-driver/no-GPU case) falls back to fixed-function without throwing", () => {
    SetQGL(makeNoShaderQGL());
    SetRefImports(makeFakeRi());
    const cvar = new CvarT();
    cvar.value = 1;
    glCvars.gl_shaders = cvar;

    expect(() => GL_InitShaderPath()).not.toThrow();
    expect(GL_UsingShaderPath()).toBe(false);
  });

  test("falling back also clears the gl_shaders cvar back to 0, matching q2repro state.c's own fallback", () => {
    SetQGL(makeNoShaderQGL());
    const setCalls: { name: string; value: number }[] = [];
    SetRefImports(makeFakeRi({ Cvar_SetValue: (name, value) => setCalls.push({ name, value }) }));
    const cvar = new CvarT();
    cvar.value = 1;
    glCvars.gl_shaders = cvar;

    GL_InitShaderPath();

    expect(setCalls).toContainEqual({ name: "gl_shaders", value: 0 });
  });

  test("a context with full GL2 support (QGLRecording's simulated success) activates the shader path", () => {
    SetQGL(new QGLRecording());
    SetRefImports(makeFakeRi());
    const cvar = new CvarT();
    cvar.value = 1;
    glCvars.gl_shaders = cvar;

    expect(GL_InitShaderPath()).toBe(true);
    expect(GL_UsingShaderPath()).toBe(true);
  });

  test("GL_ShutdownShaderPath leaves the path inactive and safe to call twice", () => {
    SetQGL(new QGLRecording());
    SetRefImports(makeFakeRi());
    const cvar = new CvarT();
    cvar.value = 1;
    glCvars.gl_shaders = cvar;
    GL_InitShaderPath();
    expect(GL_UsingShaderPath()).toBe(true);

    GL_ShutdownShaderPath();
    expect(GL_UsingShaderPath()).toBe(false);
    expect(() => GL_ShutdownShaderPath()).not.toThrow();
  });
});

describe("gl_shader.ts -- GL_UseWorldSurfaceProgram activation", () => {
  test("no-ops (returns false) when the shader path isn't active, leaving fixed-function behavior untouched", () => {
    SetQGL(new QGLRecording());
    GL_ShutdownShaderPath(); // ensure inactive
    const lights = [new DlightT()];
    expect(GL_UseWorldSurfaceProgram(lights, 1)).toBe(false);
  });

  test("activates the program and uploads the frame's lights when the shader path is active", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    SetRefImports(makeFakeRi());
    const cvar = new CvarT();
    cvar.value = 1;
    glCvars.gl_shaders = cvar;
    GL_InitShaderPath();
    rec.clear();

    const light = new DlightT();
    light.origin.set(vec3(10, 20, 30));
    light.color.set(vec3(1, 0.5, 0.25));
    light.intensity = 200;

    expect(GL_UseWorldSurfaceProgram([light], 1)).toBe(true);
    expect(rec.calls.some((c) => c.name === "qglUseProgram")).toBe(true);
    // one qglUniform1i binds the lightmap sampler to TMU 0
    expect(rec.calls.some((c) => c.name === "qglUniform1i" && c.args[1] === 0)).toBe(true);
    // per-light uniforms: position (3f), radius (1f), color (3f), scale (1f)
    const uniform3fCalls = rec.calls.filter((c) => c.name === "qglUniform3f");
    expect(uniform3fCalls.length).toBeGreaterThanOrEqual(2); // position + color for the one light
  });
});
