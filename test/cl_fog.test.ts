/*
Tests for the re-release's fog: the client-side state machine
(src/client/cl_fog.ts -- q2repro view.c:482-528's V_FogParamsChanged and
view.c:616-650's per-frame lerp) and the renderer's fog math and GLSL
assembly (src/ref_gl/gl_fog.ts -- q2repro shader.c:541-561/719-739).

Real shader COMPILATION can't run headlessly (no GPU context), so the GL
half covers exactly what can: the extracted per-fragment math against
q2repro's formulas, the depth->distance inversion the screen-space pass
needs, the uniform lists' consistency with the generated GLSL, and the
per-frame activation gate. Self-sufficient per rule 13: every test resets
the module state it reads.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { SvcFogDataBitsT, type SvcFogDataT } from "../src/kexapi/game";
import { FogGlobalT, FogHeightT } from "../src/client/ref";
import { CL_ClearFog, CL_FogParamsChanged, CL_CurrentFog, CL_FogState, lerpFogParams, makeFogParams } from "../src/client/cl_fog";
import {
  FOG_DENSITY_SCALE,
  FOG_PASS_GLOBAL,
  FOG_PASS_HEIGHT,
  FOG_PASS_SKY,
  buildFogFragmentShaderSource,
  buildFogVertexShaderSource,
  fogUniformsFor,
  fogBitsFor,
  globalFogAmount,
  heightFogAmount,
  heightFogDirZ,
  heightFogExtinction,
  heightFogFraction,
  projectionInverseCoefficients,
  eyeDistanceFromWindowDepth,
  fragDepthFromWindowDepth,
} from "../src/ref_gl/gl_fog";

// The exact svc_fog body mgu6m1's worldspawn produces, as decoded by
// q2repro.ts's readFog(): bits 36847 (0x8FEF) selects density+skyfactor,
// all three global color components, height-fog falloff and density, the
// three height START color components plus its distance, and the height END
// distance -- but NOT BIT_TIME and NOT the three END color components,
// which is why the end color stays black.
function mgu6m1Fog(): SvcFogDataT {
  return {
    bits: 36847,
    density: 0.024,
    skyfactor: 51,
    red: 138,
    green: 82,
    blue: 211,
    time: 0,
    hf_falloff: 0.0673,
    hf_density: 0.0005,
    hf_start_r: 235,
    hf_start_g: 97,
    hf_start_b: 23,
    hf_start_dist: -328,
    hf_end_r: 0,
    hf_end_g: 0,
    hf_end_b: 0,
    hf_end_dist: -349,
  };
}

function emptyFog(): SvcFogDataT {
  return {
    bits: 0,
    density: 0,
    skyfactor: 0,
    red: 0,
    green: 0,
    blue: 0,
    time: 0,
    hf_falloff: 0,
    hf_density: 0,
    hf_start_r: 0,
    hf_start_g: 0,
    hf_start_b: 0,
    hf_start_dist: 0,
    hf_end_r: 0,
    hf_end_g: 0,
    hf_end_b: 0,
    hf_end_dist: 0,
  };
}

describe("cl_fog.ts -- svc_fog message to client fog state", () => {
  beforeEach(() => {
    CL_ClearFog();
  });

  test("mgu6m1's worldspawn fog decodes into the renderer's units", () => {
    CL_FogParamsChanged(mgu6m1Fog(), 1000);

    const linear = new FogGlobalT();
    const height = new FogHeightT();
    CL_CurrentFog(1000, linear, height);

    // Colors and the sky factor are byte fractions on the wire
    // (q2proto_coords.c:552/607 -- both are `b / 255`).
    expect(linear.color[0]).toBeCloseTo(138 / 255, 6);
    expect(linear.color[1]).toBeCloseTo(82 / 255, 6);
    expect(linear.color[2]).toBeCloseTo(211 / 255, 6);
    expect(linear.skyFactor).toBeCloseTo(51 / 255, 6);
    // Density and falloff are raw floats, passed straight through.
    expect(linear.density).toBeCloseTo(0.024, 6);
    expect(height.falloff).toBeCloseTo(0.0673, 6);
    expect(height.density).toBeCloseTo(0.0005, 6);
    // Heights are unscaled i32 world Z, not 1/8-unit coords.
    expect(height.start.dist).toBe(-328);
    expect(height.end.dist).toBe(-349);
    expect(height.start.color[0]).toBeCloseTo(235 / 255, 6);
    expect(height.start.color[1]).toBeCloseTo(97 / 255, 6);
    expect(height.start.color[2]).toBeCloseTo(23 / 255, 6);
    // The END color bits are absent from bits 36847, so it stays at its
    // initial black rather than picking up the start color.
    expect(height.end.color[0]).toBe(0);
    expect(height.end.color[1]).toBe(0);
    expect(height.end.color[2]).toBe(0);
  });

  test("absent fields leave the previous target untouched (view.c:497-528's per-bit guards)", () => {
    CL_FogParamsChanged(mgu6m1Fog(), 1000);

    // A second message that carries ONLY the red component.
    const partial = emptyFog();
    partial.bits = SvcFogDataBitsT.BIT_R;
    partial.red = 10;
    CL_FogParamsChanged(partial, 2000);

    const linear = new FogGlobalT();
    const height = new FogHeightT();
    CL_CurrentFog(2000, linear, height);

    expect(linear.color[0]).toBeCloseTo(10 / 255, 6);
    // Everything else survives.
    expect(linear.color[1]).toBeCloseTo(82 / 255, 6);
    expect(linear.density).toBeCloseTo(0.024, 6);
    expect(height.start.dist).toBe(-328);
  });

  test("CL_ClearFog drops the state, so a new map starts unfogged", () => {
    CL_FogParamsChanged(mgu6m1Fog(), 1000);
    CL_ClearFog();

    const linear = new FogGlobalT();
    const height = new FogHeightT();
    CL_CurrentFog(1000, linear, height);
    expect(linear.density).toBe(0);
    expect(linear.color[2]).toBe(0);
    expect(height.start.dist).toBe(0);
    expect(CL_FogState().lerpTime).toBe(0);
  });
});

describe("cl_fog.ts -- the client-side transition (view.c:484-492, 616-650)", () => {
  beforeEach(() => {
    CL_ClearFog();
  });

  test("a message with no time takes effect immediately and disarms any fade", () => {
    CL_FogParamsChanged(mgu6m1Fog(), 500);
    expect(CL_FogState().lerpTime).toBe(0);

    const linear = new FogGlobalT();
    const height = new FogHeightT();
    CL_CurrentFog(500, linear, height);
    expect(linear.density).toBeCloseTo(0.024, 6);
  });

  test("a message with a time interpolates from the previous target over that many ms", () => {
    // Establish a target: fully dense red fog.
    const first = emptyFog();
    first.bits = SvcFogDataBitsT.BIT_DENSITY | SvcFogDataBitsT.BIT_R;
    first.density = 1;
    first.skyfactor = 255;
    first.red = 255;
    CL_FogParamsChanged(first, 0);

    // Then fade to zero density over 1000ms starting at cl.time 1000.
    const second = emptyFog();
    second.bits = SvcFogDataBitsT.BIT_DENSITY | SvcFogDataBitsT.BIT_TIME;
    second.density = 0;
    second.skyfactor = 0;
    second.time = 1000;
    CL_FogParamsChanged(second, 1000);

    const linear = new FogGlobalT();
    const height = new FogHeightT();

    // At the arming instant: still entirely the old target.
    CL_CurrentFog(1000, linear, height);
    expect(linear.density).toBeCloseTo(1, 6);

    // Halfway.
    CL_CurrentFog(1500, linear, height);
    expect(linear.density).toBeCloseTo(0.5, 6);
    expect(linear.skyFactor).toBeCloseTo(0.5, 6);
    // The red component was never re-sent, so both ends hold it and it does
    // not move.
    expect(linear.color[0]).toBeCloseTo(1, 6);

    // Past the end: pinned at the new target, not extrapolated.
    CL_CurrentFog(9999, linear, height);
    expect(linear.density).toBeCloseTo(0, 6);
  });

  test("lerpFogParams is LERP2 (shared.h:218) on every field, distances included", () => {
    const start = makeFogParams();
    const end = makeFogParams();
    const out = makeFogParams();

    start.linear.color[0] = 0;
    end.linear.color[0] = 1;
    start.height.start.dist = -100;
    end.height.start.dist = -300;
    start.height.falloff = 0;
    end.height.falloff = 0.08;

    lerpFogParams(start, end, 0.25, out);
    expect(out.linear.color[0]).toBeCloseTo(0.25, 6);
    expect(out.height.start.dist).toBeCloseTo(-150, 6);
    expect(out.height.falloff).toBeCloseTo(0.02, 6);
  });

  test("a mid-fade message restarts from the old TARGET, not from what is on screen", () => {
    // view.c:486 is `cl.fog.start = cl.fog.end`, i.e. the target, and that
    // asymmetry is deliberate here.
    const first = emptyFog();
    first.bits = SvcFogDataBitsT.BIT_DENSITY;
    first.density = 1;
    CL_FogParamsChanged(first, 0);

    const second = emptyFog();
    second.bits = SvcFogDataBitsT.BIT_DENSITY | SvcFogDataBitsT.BIT_TIME;
    second.density = 0;
    second.time = 1000;
    CL_FogParamsChanged(second, 0);

    // Interrupt the fade at its halfway point with a third message.
    const third = emptyFog();
    third.bits = SvcFogDataBitsT.BIT_DENSITY | SvcFogDataBitsT.BIT_TIME;
    third.density = 1;
    third.time = 1000;
    CL_FogParamsChanged(third, 500);

    // `start` is now the SECOND message's target (0), not the 0.5 that was
    // being displayed.
    expect(CL_FogState().start.linear.density).toBeCloseTo(0, 6);

    const linear = new FogGlobalT();
    const height = new FogHeightT();
    CL_CurrentFog(1000, linear, height);
    expect(linear.density).toBeCloseTo(0.5, 6);
  });
});

describe("gl_fog.ts -- per-fragment fog math (q2repro shader.c)", () => {
  test("global fog is exp2-shaped over density/64 (shader.c:723-725, 1105)", () => {
    const densityScaled = 0.024 / FOG_DENSITY_SCALE;
    expect(FOG_DENSITY_SCALE).toBe(64);

    // Zero distance is zero fog, and the curve is monotonic and saturating.
    expect(globalFogAmount(densityScaled, 0)).toBeCloseTo(0, 12);
    const near = globalFogAmount(densityScaled, 500);
    const far = globalFogAmount(densityScaled, 3000);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(1);

    // The literal formula, not a re-derivation.
    const d = densityScaled * 1234;
    expect(globalFogAmount(densityScaled, 1234)).toBeCloseTo(1 - Math.exp(-(d * d)), 12);

    // Squared, not linear: doubling the distance more than doubles the fog
    // while the curve is still in its low range.
    expect(globalFogAmount(densityScaled, 1000)).toBeGreaterThan(2 * globalFogAmount(densityScaled, 500));
  });

  test("the height-fog fraction reproduces re-release's double subtraction (shader.c:552)", () => {
    // start=-328, end=-349 (mgu6m1). Because `pos` already has start
    // subtracted and the expression subtracts it again, the ramp sits
    // between 2*start = -656 and 2*start + (end-start) = -677, NOT between
    // -328 and -349. q2repro flags this as broken and ships it anyway.
    expect(heightFogFraction(-656, -328, -349)).toBeCloseTo(0, 9);
    expect(heightFogFraction(-677, -328, -349)).toBeCloseTo(1, 9);
    expect(heightFogFraction(-666.5, -328, -349)).toBeCloseTo(0.5, 6);

    // Clamped on both sides.
    expect(heightFogFraction(0, -328, -349)).toBe(0);
    expect(heightFogFraction(-5000, -328, -349)).toBe(1);

    // The naive (correct-looking) reading would put the midpoint at -338.5;
    // it does not.
    expect(heightFogFraction(-338.5, -328, -349)).toBe(0);
  });

  test("heightFogDirZ only nudges an exactly-horizontal ray (shader.c:545-546)", () => {
    expect(heightFogDirZ(0)).toBeCloseTo(0.00001, 12);
    expect(heightFogDirZ(0.5)).toBe(0.5);
    expect(heightFogDirZ(-0.5)).toBe(-0.5);
  });

  test("extinction and the height amount follow shader.c:549-554", () => {
    const falloff = 0.0673;
    const start = -328;
    const viewZ = -300;
    const worldZ = -400;
    const dirZ = heightFogDirZ(-0.4);

    const eye = viewZ - start;
    const pos = worldZ - start;
    const density = (Math.exp(-falloff * eye) - Math.exp(-falloff * pos)) / (falloff * dirZ);
    const expected = 1 - Math.min(Math.max(Math.exp(-density), 0), 1);
    expect(heightFogExtinction(viewZ, worldZ, start, falloff, dirZ)).toBeCloseTo(expected, 12);

    // Extinction is a clamped 0..1 gate, and it scales the amount linearly.
    expect(heightFogAmount(0.0005, 1000, 0)).toBe(0);
    expect(heightFogAmount(0.0005, 1000, 1)).toBeCloseTo(1 - Math.exp(-0.5), 12);
    expect(heightFogAmount(0.0005, 1000, 0.5)).toBeCloseTo(0.5 * (1 - Math.exp(-0.5)), 12);
  });

  test("window depth inverts back to the eye distance the projection produced", () => {
    const zNear = 4;
    const zFar = 4096;
    const { a, b } = projectionInverseCoefficients(zNear, zFar);

    // Round-trip a handful of known eye distances through the projection's
    // own third row and back.
    for (const w of [4, 36, 250, 1000, 2300, 4096]) {
      const ndcZ = a - b / w;
      const windowDepth = 0.5 * ndcZ + 0.5;
      expect(eyeDistanceFromWindowDepth(windowDepth, a, b)).toBeCloseTo(w, 4);
      // q2repro's frag_depth idiom: gl_FragCoord.z / gl_FragCoord.w, i.e.
      // window depth TIMES eye distance, not the eye distance itself.
      expect(fragDepthFromWindowDepth(windowDepth, a, b)).toBeCloseTo(windowDepth * w, 4);
    }

    // The near and far planes land where they should.
    expect(eyeDistanceFromWindowDepth(0, a, b)).toBeCloseTo(zNear, 6);
    expect(eyeDistanceFromWindowDepth(1, a, b)).toBeCloseTo(zFar, 3);
  });
});

describe("gl_fog.ts -- frame activation gate (q2repro main.c:817-826)", () => {
  const fd = (density: number, skyFactor: number, hfDensity: number, hfFalloff: number) => ({
    fog: { density, skyFactor },
    heightfog: { density: hfDensity, falloff: hfFalloff },
  });

  test("each term has its own condition", () => {
    const bits = fogBitsFor(fd(0.024, 0.2, 0.0005, 0.0673), true, true);
    expect(bits).toEqual({ global: true, height: true, sky: true });

    // Height fog needs BOTH a density and a falloff -- main.c:823.
    expect(fogBitsFor(fd(0, 0, 0.0005, 0), true, true).height).toBe(false);
    expect(fogBitsFor(fd(0, 0, 0, 0.0673), true, true).height).toBe(false);
    // Zero density is no global fog, zero sky factor is no sky term.
    expect(fogBitsFor(fd(0, 0.2, 0, 0), true, true).global).toBe(false);
    expect(fogBitsFor(fd(0.024, 0, 0, 0), true, true).sky).toBe(false);
  });

  test("gl_fog 0 and a missing shader path both disable every term", () => {
    const full = fd(0.024, 0.2, 0.0005, 0.0673);
    expect(fogBitsFor(full, true, false)).toEqual({ global: false, height: false, sky: false });
    expect(fogBitsFor(full, false, true)).toEqual({ global: false, height: false, sky: false });
  });
});

describe("gl_fog.ts -- GLSL assembly and uniform packing", () => {
  const kinds = [FOG_PASS_GLOBAL, FOG_PASS_HEIGHT, FOG_PASS_SKY] as const;

  test("every declared uniform is actually used by that pass's GLSL, and vice versa", () => {
    for (const kind of kinds) {
      const source = `${buildFogVertexShaderSource(kind)}\n${buildFogFragmentShaderSource(kind)}`;
      const declared = new Set(fogUniformsFor(kind));

      // Everything the binding list promises is declared exactly once.
      for (const name of declared) {
        const matches = source.match(new RegExp(`uniform\\s+\\w+\\s+${name};`, "g")) ?? [];
        expect(matches.length).toBe(1);
      }

      // ...and nothing else is declared.
      const found = [...source.matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1]);
      expect(new Set(found)).toEqual(declared);
    }
  });

  test("both stages target GLSL 1.10 and every varying is matched across them", () => {
    for (const kind of kinds) {
      const vs = buildFogVertexShaderSource(kind);
      const fs = buildFogFragmentShaderSource(kind);
      expect(vs.startsWith("#version 110\n")).toBe(true);
      expect(fs.startsWith("#version 110\n")).toBe(true);

      const varyingsOf = (src: string) => new Set([...src.matchAll(/varying\s+\w+\s+(\w+);/g)].map((m) => m[1]));
      // Every varying the fragment stage reads is produced by the vertex
      // stage -- an unmatched one links but reads garbage.
      for (const name of varyingsOf(fs)) expect(varyingsOf(vs).has(name)).toBe(true);
    }
  });

  test("the global pass carries q2repro's exp2 line verbatim", () => {
    const fs = buildFogFragmentShaderSource(FOG_PASS_GLOBAL);
    expect(fs).toContain("float dd = u_fog_color.a * frag_depth;");
    expect(fs).toContain("float fog = 1.0 - exp(-(dd * dd));");
    // Sky and untouched background are excluded from the distance terms.
    expect(fs).toContain("if (d >= u_far_depth) discard;");
  });

  test("the height pass carries write_height_fog's double subtraction verbatim", () => {
    const fs = buildFogFragmentShaderSource(FOG_PASS_HEIGHT);
    expect(fs).toContain("float pos = v_world_pos.z - u_hf_start.w;");
    expect(fs).toContain("float fraction = clamp((pos - u_hf_start.w) / (u_hf_end.w - u_hf_start.w), 0.0, 1.0);");
    expect(fs).toContain("float extinction = 1.0 - clamp(exp(-density), 0.0, 1.0);");
    expect(fs).toContain("vec3 fog_color = mix(u_hf_start.rgb, u_hf_end.rgb, fraction) * extinction;");
    // Only the height pass needs a reconstructed world position, so only it
    // declares the view basis that builds one.
    expect(buildFogVertexShaderSource(FOG_PASS_HEIGHT)).toContain("v_ray = u_forward");
    expect(buildFogVertexShaderSource(FOG_PASS_GLOBAL)).not.toContain("v_ray");
  });

  test("the sky pass is a flat mix with the inverse depth test", () => {
    const fs = buildFogFragmentShaderSource(FOG_PASS_SKY);
    // Sky keeps ONLY the fragments the two distance passes threw away.
    expect(fs).toContain("if (d < u_far_depth) discard;");
    expect(fs).toContain("gl_FragColor = vec4(u_fog_color.rgb, u_fog_color.a);");
    // No distance term at all -- shader.c:739.
    expect(fs).not.toContain("frag_depth");
    expect(fs).not.toContain("u_proj");
  });
});
