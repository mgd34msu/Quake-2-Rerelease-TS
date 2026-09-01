// gl_shadowmap.ts -- v1.1.0 shadow maps for the kex family's cone shadow
// lights. Three legs, all runnable without a GPU:
//
//   1. Light-space matrix math (pure): a point on the cone axis must land
//      dead-centre in the depth map, a point behind the light must fall
//      behind the near plane, and depth must increase with distance.
//   2. Atlas allocation (pure): resolution clamping against the values the
//      shipped rerelease content actually asks for, and shelf packing.
//   3. The real GL call sequence, pinned through QGLRecording -- FBO/depth
//      texture setup, the per-slot viewport/scissor/clear/matrix/draw
//      order, and that the pass leaves the framebuffer binding as it found
//      it.
//
// Self-sufficient per standing order 13: every suite installs its own QGL
// double and RefImports; nothing here depends on another test file running.

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";
import type { RefImports } from "../src/client/ref";
import { DlightT } from "../src/client/ref";
import { QGLRecording, type QGL } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { glCvars, SetRefImports } from "../src/ref_gl/gl_local";
import { ModelT, MsurfaceT, GlpolyT, SURF_DRAWSKY, SURF_DRAWTURB } from "../src/ref_gl/gl_model";
import {
  shadowMapResolution,
  packShadowAtlas,
  matrixIdentity,
  matrixMultiply,
  matrixInvertRigid,
  matrixTransformPoint,
  matrixLookAt,
  matrixPerspective,
  shadowLightMatrix,
  shadowFovForConeAngle,
  SHADOW_ATLAS_SIZE,
  SHADOW_RES_DEFAULT,
  SHADOW_RES_MIN,
  SHADOW_RES_MAX,
  SHADOW_NEAR,
  GL_InitShadowMaps,
  GL_ShutdownShadowMaps,
  GL_ShadowMapsReady,
  GL_ShadowMapBindings,
  GL_ShadowMapTexture,
  GL_ShadowMapsNewMap,
  R_RenderShadowMaps,
} from "../src/ref_gl/gl_shadowmap";

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

function makeCvar(value: number): CvarT {
  const c = new CvarT();
  c.name = "gl_shadowmaps";
  c.string = String(value);
  c.value = value;
  return c;
}

function makeConeLight(origin: readonly number[], direction: readonly number[], radius: number, cosHalfAngle: number, resolution: number): DlightT {
  const dl = new DlightT();
  dl.origin = vec3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  dl.color = vec3(1, 1, 1);
  dl.intensity = radius; // dlight_t's `intensity` doubles as radius, per ref.ts
  dl.lightScale = 1;
  dl.resolution = resolution;
  dl.cone = { direction: vec3(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0), cosHalfAngle };
  return dl;
}

function makePointLight(origin: readonly number[], radius: number): DlightT {
  const dl = new DlightT();
  dl.origin = vec3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  dl.color = vec3(1, 1, 1);
  dl.intensity = radius;
  dl.cone = null;
  return dl;
}

// A one-triangle world sitting `distance` units down the -X axis, i.e. in
// front of a light at the origin aimed along -X.
function makeWorld(distance: number, flags = 0): ModelT {
  const poly = new GlpolyT();
  poly.numverts = 3;
  poly.verts = [
    Float32Array.from([-distance, -16, -16, 0, 0, 0, 0]),
    Float32Array.from([-distance, 16, -16, 0, 0, 0, 0]),
    Float32Array.from([-distance, 0, 16, 0, 0, 0, 0]),
  ];

  const surf = new MsurfaceT();
  surf.flags = flags;
  surf.polys = poly;

  const model = new ModelT();
  model.numsurfaces = 1;
  model.surfaces = [surf];
  return model;
}

function names(rec: QGLRecording): string[] {
  return rec.calls.map((c) => c.name);
}

beforeEach(() => {
  SetQGL(new QGLRecording());
  SetRefImports(makeFakeRi());
  glCvars.gl_shadowmaps = makeCvar(1);
  GL_ShutdownShadowMaps();
});

describe("gl_shadowmap.ts -- shadowlightresolution clamping", () => {
  test("the 512 that 435 of the shipped resolution-carrying lights ask for passes through unchanged", () => {
    expect(shadowMapResolution(512)).toBe(512);
  });

  test("0 means the entity omitted shadowlightresolution -- that is the default, not 'no shadow'", () => {
    expect(shadowMapResolution(0)).toBe(SHADOW_RES_DEFAULT);
  });

  test("the 2048 three shipped lights ask for clamps down to the cap rather than being refused", () => {
    expect(shadowMapResolution(2048)).toBe(SHADOW_RES_MAX);
  });

  test("a non-power-of-two rounds DOWN (the shipped 356 becomes 256)", () => {
    expect(shadowMapResolution(356)).toBe(256);
  });

  test("absurdly small values clamp up to the floor", () => {
    expect(shadowMapResolution(1)).toBe(SHADOW_RES_MIN);
  });

  test("every result is a power of two inside [min, max]", () => {
    for (const requested of [0, 1, 64, 128, 200, 256, 356, 512, 1000, 1024, 2048, 8192]) {
      const r = shadowMapResolution(requested);
      expect(r).toBeGreaterThanOrEqual(SHADOW_RES_MIN);
      expect(r).toBeLessThanOrEqual(SHADOW_RES_MAX);
      expect(Number.isInteger(Math.log2(r))).toBe(true);
    }
  });
});

describe("gl_shadowmap.ts -- atlas shelf packing", () => {
  test("eight 512s tile a 2048 atlas as two full shelves, no overlap", () => {
    const slots = packShadowAtlas(new Array(8).fill(512));
    expect(slots.every((s) => s !== null)).toBe(true);
    const seen = new Set(slots.map((s) => `${s?.x},${s?.y}`));
    expect(seen.size).toBe(8); // all distinct origins
    for (const s of slots) {
      expect(s).not.toBeNull();
      if (!s) continue;
      expect(s.x + s.size).toBeLessThanOrEqual(SHADOW_ATLAS_SIZE);
      expect(s.y + s.size).toBeLessThanOrEqual(SHADOW_ATLAS_SIZE);
    }
  });

  test("no two slots overlap, for a mixed descending request set", () => {
    const slots = packShadowAtlas([1024, 1024, 512, 512, 512, 256, 256, 128]);
    const boxes = slots.filter((s): s is NonNullable<typeof s> => s !== null);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        const disjoint = a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  test("a request larger than the whole atlas gets no slot rather than a clipped one", () => {
    expect(packShadowAtlas([SHADOW_ATLAS_SIZE * 2])[0]).toBeNull();
  });

  test("overflow past the atlas returns null for the leftovers -- those lights render unshadowed, never garbage", () => {
    const slots = packShadowAtlas(new Array(64).fill(1024));
    expect(slots.slice(0, 4).every((s) => s !== null)).toBe(true);
    expect(slots.slice(4).every((s) => s === null)).toBe(true);
  });
});

describe("gl_shadowmap.ts -- matrix helpers", () => {
  test("identity is the multiplicative identity", () => {
    const m = matrixPerspective(90, 4, 1024);
    const back = matrixMultiply(matrixIdentity(), m);
    for (let i = 0; i < 16; i++) expect(back[i]).toBeCloseTo(m[i] ?? 0, 6);
  });

  test("matrixInvertRigid actually inverts a rotation+translation", () => {
    const view = matrixLookAt(vec3(100, -50, 20), vec3(0.6, 0.8, 0));
    const inverse = matrixInvertRigid(view);
    const product = matrixMultiply(inverse, view);
    const identity = matrixIdentity();
    for (let i = 0; i < 16; i++) expect(product[i]).toBeCloseTo(identity[i] ?? 0, 4);
  });

  test("eye->world round trip returns an arbitrary world point to itself", () => {
    const view = matrixLookAt(vec3(-300, 44, 96), vec3(-0.98, -0.14, -0.14));
    const eyeToWorld = matrixInvertRigid(view);
    const world = vec3(12, -345, 67);
    const eye = matrixTransformPoint(view, world);
    const back = matrixTransformPoint(eyeToWorld, vec3(eye[0], eye[1], eye[2]));
    expect(back[0]).toBeCloseTo(world[0], 3);
    expect(back[1]).toBeCloseTo(world[1], 3);
    expect(back[2]).toBeCloseTo(world[2], 3);
  });

  test("matrixLookAt stays well-conditioned for a light aimed straight down (the commonest aim in shipped content)", () => {
    const view = matrixLookAt(vec3(0, 0, 200), vec3(0, 0, -1));
    for (let i = 0; i < 16; i++) expect(Number.isFinite(view[i] ?? NaN)).toBe(true);

    // a point 100 below the light must sit on the view axis, 100 in front
    const onAxis = matrixTransformPoint(view, vec3(0, 0, 100));
    expect(onAxis[0]).toBeCloseTo(0, 4);
    expect(onAxis[1]).toBeCloseTo(0, 4);
    expect(onAxis[2]).toBeCloseTo(-100, 4);

    // ...and the basis must not have COLLAPSED, which an on-axis point alone
    // cannot detect: two points offset along different world axes have to
    // land at different, non-degenerate places in light space. Picking +Z as
    // the up hint for a light already pointing along -Z is exactly the
    // degenerate case matrixLookAt's up-axis switch exists to avoid.
    const offX = matrixTransformPoint(view, vec3(40, 0, 100));
    const offY = matrixTransformPoint(view, vec3(0, 40, 100));
    expect(Math.hypot(offX[0], offX[1])).toBeCloseTo(40, 3);
    expect(Math.hypot(offY[0], offY[1])).toBeCloseTo(40, 3);
    // the two offsets must be perpendicular in light space, not collinear
    expect(offX[0] * offY[0] + offX[1] * offY[1]).toBeCloseTo(0, 3);
  });

  test("the light basis is orthonormal for every aim direction, including the axis-aligned ones", () => {
    for (const dir of [vec3(0, 0, -1), vec3(0, 0, 1), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(-0.98, -0.14, -0.14)]) {
      const view = matrixLookAt(vec3(10, 20, 30), dir);
      const rows = [
        [view[0] ?? 0, view[4] ?? 0, view[8] ?? 0],
        [view[1] ?? 0, view[5] ?? 0, view[9] ?? 0],
        [view[2] ?? 0, view[6] ?? 0, view[10] ?? 0],
      ];
      for (let i = 0; i < 3; i++) {
        const r = rows[i];
        if (!r) continue;
        expect(Math.hypot(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0)).toBeCloseTo(1, 4);
        for (let j = i + 1; j < 3; j++) {
          const q = rows[j];
          if (!q) continue;
          expect((r[0] ?? 0) * (q[0] ?? 0) + (r[1] ?? 0) * (q[1] ?? 0) + (r[2] ?? 0) * (q[2] ?? 0)).toBeCloseTo(0, 4);
        }
      }
    }
  });

  test("the shadow frustum is wider than the cone it serves, so the cone's outer falloff still has depth data", () => {
    for (const coneAngle of [15, 21, 30, 40, 45, 75]) {
      expect(shadowFovForConeAngle(coneAngle)).toBeGreaterThan(coneAngle * 2);
    }
  });

  test("shadowFovForConeAngle never opens past the 175-degree ceiling", () => {
    expect(shadowFovForConeAngle(120)).toBeLessThanOrEqual(175);
  });
});

describe("gl_shadowmap.ts -- shadowLightMatrix (world -> shadow-map UV + depth)", () => {
  const origin = vec3(244, -256, 56); // base1's dyn_target_01 cone light
  const direction = vec3(-0.98, -0.14, -0.14);
  const M = shadowLightMatrix(origin, direction, 40, 350);

  function project(point: readonly number[]): { u: number; v: number; z: number; w: number } {
    const t = matrixTransformPoint(M, vec3(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0));
    return { u: t[0] / t[3], v: t[1] / t[3], z: t[2] / t[3], w: t[3] };
  }

  function alongAxis(distance: number): number[] {
    return [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, origin[2] + direction[2] * distance];
  }

  test("a point on the cone axis lands dead-centre in the depth map", () => {
    for (const d of [10, 50, 100, 200, 340]) {
      const p = project(alongAxis(d));
      expect(p.u).toBeCloseTo(0.5, 3);
      expect(p.v).toBeCloseTo(0.5, 3);
    }
  });

  test("depth increases monotonically with distance from the light", () => {
    let previous = -1;
    for (const d of [10, 50, 100, 200, 340]) {
      const z = project(alongAxis(d)).z;
      expect(z).toBeGreaterThan(previous);
      previous = z;
    }
  });

  test("everything inside the frustum maps into the [0,1] range the shader tests against", () => {
    for (const d of [SHADOW_NEAR + 1, 50, 200, 340]) {
      const p = project(alongAxis(d));
      expect(p.u).toBeGreaterThanOrEqual(0);
      expect(p.u).toBeLessThanOrEqual(1);
      expect(p.z).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeLessThanOrEqual(1);
    }
  });

  test("a point BEHIND the light has w <= 0, which is the shader's 'no shadow data' early-out", () => {
    const p = project(alongAxis(-100));
    expect(p.w).toBeLessThanOrEqual(0);
  });

  test("moving off the cone axis moves the sample off centre in the same direction", () => {
    const onAxis = project(alongAxis(100));
    // step perpendicular to the aim, along the light's own right/up basis
    const view = matrixLookAt(origin, direction);
    const eyeToWorld = matrixInvertRigid(view);
    // (+20, 0, -100) in light space is 20 units to the light's right, 100 ahead
    const offAxisWorld = matrixTransformPoint(eyeToWorld, vec3(20, 0, -100));
    const offAxis = project([offAxisWorld[0], offAxisWorld[1], offAxisWorld[2]]);
    expect(offAxis.u).toBeGreaterThan(onAxis.u);
    expect(offAxis.v).toBeCloseTo(onAxis.v, 3);
  });
});

describe("gl_shadowmap.ts -- GL_InitShadowMaps (call sequence + graceful fallback)", () => {
  test("allocates exactly one depth texture and one framebuffer, and restores the previous binding", () => {
    const rec = new QGLRecording();
    SetQGL(rec);

    expect(GL_InitShadowMaps()).toBe(true);
    expect(GL_ShadowMapsReady()).toBe(true);
    expect(GL_ShadowMapTexture()).not.toBe(0);

    const seq = names(rec);
    expect(seq.filter((n) => n === "qglGenTextures").length).toBe(1);
    expect(seq.filter((n) => n === "qglGenFramebuffers").length).toBe(1);
    expect(seq).toContain("qglFramebufferTexture2D");
    expect(seq).toContain("qglCheckFramebufferStatus");

    // depth-only FBOs are incomplete unless both buffers point at nothing
    const drawBuffer = rec.calls.find((c) => c.name === "qglDrawBuffer");
    const readBuffer = rec.calls.find((c) => c.name === "qglReadBuffer");
    expect(drawBuffer?.args[0]).toBe(0); // GL_NONE
    expect(readBuffer?.args[0]).toBe(0);

    // the last bind puts back whatever was bound before (0 from the double)
    const binds = rec.calls.filter((c) => c.name === "qglBindFramebuffer");
    expect(binds.length).toBeGreaterThanOrEqual(2);
    expect(binds[binds.length - 1]?.args[1]).toBe(0);
  });

  test("the depth texture is allocated at the atlas size as a real depth format", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const texImage = rec.calls.find((c) => c.name === "qglTexImage2D");
    expect(texImage?.args[2]).toBe(0x81a6); // GL_DEPTH_COMPONENT24 internalformat
    expect(texImage?.args[3]).toBe(SHADOW_ATLAS_SIZE);
    expect(texImage?.args[4]).toBe(SHADOW_ATLAS_SIZE);
    expect(texImage?.args[6]).toBe(0x1902); // GL_DEPTH_COMPONENT format
  });

  test("gl_shadowmaps 0 allocates nothing at all", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    glCvars.gl_shadowmaps = makeCvar(0);

    expect(GL_InitShadowMaps()).toBe(false);
    expect(GL_ShadowMapsReady()).toBe(false);
    expect(names(rec)).not.toContain("qglGenFramebuffers");
  });

  test("a context without framebuffer objects falls back cleanly instead of throwing", () => {
    const rec: QGL = new QGLRecording();
    rec.qglGenFramebuffers = null;
    rec.qglBindFramebuffer = null;
    rec.qglFramebufferTexture2D = null;
    rec.qglCheckFramebufferStatus = null;
    SetQGL(rec);

    expect(GL_InitShadowMaps()).toBe(false);
    expect(GL_ShadowMapsReady()).toBe(false);
  });

  test("an incomplete framebuffer disables shadow maps and frees what it allocated", () => {
    const rec: QGL = new QGLRecording();
    rec.qglCheckFramebufferStatus = () => 0x8cdd; // GL_FRAMEBUFFER_UNSUPPORTED
    SetQGL(rec);

    expect(GL_InitShadowMaps()).toBe(false);
    expect(GL_ShadowMapsReady()).toBe(false);
    expect(GL_ShadowMapTexture()).toBe(0);
  });

  test("GL_ShutdownShadowMaps is safe to call twice and leaves nothing bound", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();
    GL_ShutdownShadowMaps();
    GL_ShutdownShadowMaps();
    expect(GL_ShadowMapsReady()).toBe(false);
    expect(GL_ShadowMapTexture()).toBe(0);
    expect(GL_ShadowMapBindings().length).toBe(0);
  });
});

describe("gl_shadowmap.ts -- R_RenderShadowMaps (depth pass call sequence)", () => {
  const world = makeWorld(100);
  const coneLight = makeConeLight([0, 0, 0], [-1, 0, 0], 512, Math.cos((30 * Math.PI) / 180), 512);

  test("a cone light gets a depth pass: viewport, scissor, depth clear, both matrices, then geometry", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(world, [coneLight], 1);

    const seq = names(rec);
    const iViewport = seq.indexOf("qglViewport");
    const iScissor = seq.indexOf("qglScissor");
    const iClear = seq.indexOf("qglClear");
    const iMatrix = seq.indexOf("qglLoadMatrixf");
    const iBegin = seq.indexOf("qglBegin");

    expect(iViewport).toBeGreaterThanOrEqual(0);
    expect(iScissor).toBeGreaterThan(iViewport);
    expect(iClear).toBeGreaterThan(iScissor);
    expect(iMatrix).toBeGreaterThan(iClear);
    expect(iBegin).toBeGreaterThan(iMatrix);

    // one projection matrix and one modelview matrix, in that order
    expect(seq.filter((n) => n === "qglLoadMatrixf").length).toBe(2);
    expect(rec.calls.filter((c) => c.name === "qglMatrixMode").map((c) => c.args[0])).toEqual([0x1701, 0x1700]);

    // the depth clear must be depth-only -- this pass has no colour buffer
    expect(rec.calls.find((c) => c.name === "qglClear")?.args[0]).toBe(0x00000100);
  });

  test("the pass sets the state R_SetGL2D would otherwise have left wrong, and emits the geometry", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(world, [coneLight], 1);

    const enables = rec.calls.filter((c) => c.name === "qglEnable").map((c) => c.args[0]);
    const disables = rec.calls.filter((c) => c.name === "qglDisable").map((c) => c.args[0]);
    expect(enables).toContain(0x0b71); // GL_DEPTH_TEST -- R_SetGL2D leaves this off
    expect(disables).toContain(0x0bc0); // GL_ALPHA_TEST -- R_SetGL2D leaves this on
    expect(disables).toContain(0x0be2); // GL_BLEND
    expect(disables).toContain(0x0b44); // GL_CULL_FACE
    expect(enables).toContain(0x0c11); // GL_SCISSOR_TEST
    expect(enables).toContain(0x8037); // GL_POLYGON_OFFSET_FILL

    // the one triangle actually went out
    expect(rec.calls.filter((c) => c.name === "qglVertex3fv").length).toBe(3);
  });

  test("the framebuffer binding is restored, and polygon offset/scissor are turned back off", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(world, [coneLight], 1);

    const binds = rec.calls.filter((c) => c.name === "qglBindFramebuffer");
    expect(binds.length).toBeGreaterThanOrEqual(2);
    expect(binds[binds.length - 1]?.args[1]).toBe(0); // back to what was bound before

    const disables = rec.calls.filter((c) => c.name === "qglDisable").map((c) => c.args[0]);
    expect(disables).toContain(0x8037); // GL_POLYGON_OFFSET_FILL off again
    expect(disables).toContain(0x0c11); // GL_SCISSOR_TEST off again
  });

  test("a point light gets NO shadow map -- omni shadows are deliberately not shipped", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(world, [makePointLight([0, 0, 0], 512)], 1);

    expect(GL_ShadowMapBindings().length).toBe(0);
    expect(names(rec)).not.toContain("qglBegin");
  });

  test("in a mixed light list only the cone light is shadowed, and the binding names its own light index", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [makePointLight([0, 0, 0], 512), coneLight, makePointLight([10, 0, 0], 512)], 3);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.lightIndex).toBe(1); // the cone light's slot in r_dlights
  });

  test("a cone light produces exactly one binding, carrying its own atlas slot and matrix", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.lightIndex).toBe(0);
    expect(bindings[0]?.slot.size).toBe(512);
    expect(bindings[0]?.matrix.length).toBe(16);
  });

  test("sky and liquid surfaces are never emitted as occluders", () => {
    for (const flags of [SURF_DRAWSKY, SURF_DRAWTURB]) {
      const rec = new QGLRecording();
      SetQGL(rec);
      GL_InitShadowMaps();
      GL_ShadowMapsNewMap();
      rec.clear();

      R_RenderShadowMaps(makeWorld(100, flags), [coneLight], 1);
      expect(names(rec)).not.toContain("qglVertex3fv");
    }
  });

  test("geometry outside the light's radius is culled away", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    // the triangle sits 5000 units out; the light's radius is 512
    R_RenderShadowMaps(makeWorld(5000), [coneLight], 1);
    expect(names(rec)).not.toContain("qglVertex3fv");
  });

  test("an unchanged light re-renders no depth map on the next frame -- the cache is the whole performance story", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);
    rec.clear();
    R_RenderShadowMaps(world, [coneLight], 1);

    expect(names(rec)).not.toContain("qglBegin");
    // ...but the light is still shadowed, using the depth map already there
    expect(GL_ShadowMapBindings().length).toBe(1);
  });

  test("a light that MOVES invalidates its cached depth map", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);
    rec.clear();

    const moved = makeConeLight([0, 0, 64], [-1, 0, 0], 512, Math.cos((30 * Math.PI) / 180), 512);
    R_RenderShadowMaps(world, [moved], 1);
    expect(names(rec)).toContain("qglBegin");
  });

  test("a map change drops every cached depth map, so two maps cannot share stale texels", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);
    GL_ShadowMapsNewMap();
    expect(GL_ShadowMapBindings().length).toBe(0);

    rec.clear();
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(names(rec)).toContain("qglBegin");
  });

  test("nothing happens at all when shadow maps were never initialized", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_ShutdownShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapBindings().length).toBe(0);
    expect(rec.calls.length).toBe(0);
  });

  test("a null worldmodel is a no-op rather than a crash", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();
    expect(() => R_RenderShadowMaps(null, [coneLight], 1)).not.toThrow();
    expect(GL_ShadowMapBindings().length).toBe(0);
  });

  test("gl_shadowmaps flipped to 0 at runtime stops producing bindings without needing a restart", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapBindings().length).toBe(1);

    glCvars.gl_shadowmaps = makeCvar(0);
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapBindings().length).toBe(0);
  });
});
