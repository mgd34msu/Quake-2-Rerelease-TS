// gl_shadowmap.ts -- v1.1.0 shadow maps for the kex family's shadow lights,
// both cone/spot and point/omni, cast by the world and by entities. Four
// legs, all runnable without a GPU:
//
//   1. Light-space matrix math (pure): a point on the cone axis must land
//      dead-centre in the depth map, a point behind the light must fall
//      behind the near plane, and depth must increase with distance.
//   2. Atlas allocation (pure): resolution clamping against the values the
//      shipped rerelease content actually asks for, and shelf packing.
//   3. Cube-face math (pure): the six-face basis table matching what the
//      render side builds, major-axis selection, the 3x2 cell layout, and
//      the window-depth <-> distance inversion the fragment shader relies on.
//   4. The real GL call sequence, pinned through QGLRecording -- FBO/depth
//      texture setup, the per-slot viewport/scissor/clear/matrix/draw
//      order, six faces per point light, entity casters, the cache's
//      invalidation rules, and that the pass leaves the framebuffer binding
//      as it found it.
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
import { ModelT, ModtypeT, MsurfaceT, GlpolyT, ParsedMd2T, SURF_DRAWSKY, SURF_DRAWTURB } from "../src/ref_gl/gl_model";
import { EntityT } from "../src/client/ref";
import { RF_TRANSLUCENT, RF_NOSHADOW, RF_WEAPONMODEL, RF_BEAM, RF_FLARE, RF_VIEWERMODEL } from "../src/shared/q_shared";
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
  GL_ShadowMapStats,
  R_RenderShadowMaps,
  SHADOW_CUBE_COLS,
  SHADOW_CUBE_ROWS,
  SHADOW_CUBE_FACES,
  SHADOW_CUBE_FOV,
  SHADOW_KIND_CONE,
  SHADOW_KIND_POINT,
  SHADOW_CASTER_NONE,
  SHADOW_CASTER_ALIAS,
  SHADOW_CASTER_BRUSH,
  CUBE_FACE_BASIS,
  cubeFaceCell,
  cubeFaceForDirection,
  cubeFaceProject,
  matrixCubeFaceView,
  shadowCasterKind,
  shadowCasterRadius,
  shadowCubeAxialDistance,
  shadowCubeWindowDepth,
  shadowCubeFar,
  GL_ShadowMapsActive,
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
  dl.isShadowLight = true;
  return dl;
}

// A CS_SHADOWLIGHTS-fed light that resolved no `target`, i.e. an omni shadow
// light -- 122 of the 922 shadow lights in shipped rerelease content.
function makePointLight(origin: readonly number[], radius: number): DlightT {
  const dl = new DlightT();
  dl.origin = vec3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  dl.color = vec3(1, 1, 1);
  dl.intensity = radius;
  dl.cone = null;
  dl.isShadowLight = true;
  return dl;
}

// A classic transient dlight: a muzzle flash, a rocket, the blaster glow.
// Coneless exactly like an omni shadow light, and deliberately never given a
// depth map -- see DlightT.isShadowLight.
function makeClassicDlight(origin: readonly number[], radius: number): DlightT {
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
      expect(s.x + s.width).toBeLessThanOrEqual(SHADOW_ATLAS_SIZE);
      expect(s.y + s.height).toBeLessThanOrEqual(SHADOW_ATLAS_SIZE);
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
        const disjoint = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
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

  test("a point light gets a six-face cube map: one rectangle, six viewports, six clears", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(makeWorld(100), [makePointLight([0, 0, 0], 512)], 1);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.kind).toBe(SHADOW_KIND_POINT);
    // one atlas rectangle, three faces wide by two tall
    const slot = bindings[0]?.slot;
    expect(slot).toBeTruthy();
    if (slot) {
      expect(slot.width).toBe(slot.height * (SHADOW_CUBE_COLS / SHADOW_CUBE_ROWS));
      expect(slot.width / SHADOW_CUBE_COLS).toBe(slot.height / SHADOW_CUBE_ROWS);
    }

    expect(rec.calls.filter((c) => c.name === "qglViewport").length).toBe(SHADOW_CUBE_FACES);
    expect(rec.calls.filter((c) => c.name === "qglClear").length).toBe(SHADOW_CUBE_FACES);
    expect(GL_ShadowMapStats().facesRendered).toBe(SHADOW_CUBE_FACES);
  });

  test("the six cube viewports tile the light's rectangle exactly, no gaps and no overlap", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(makeWorld(100), [makePointLight([0, 0, 0], 512)], 1);

    const slot = GL_ShadowMapBindings()[0]?.slot;
    expect(slot).toBeTruthy();
    if (!slot) return;
    const faceSize = slot.width / SHADOW_CUBE_COLS;

    const viewports = rec.calls.filter((c) => c.name === "qglViewport").map((c) => c.args);
    expect(viewports.length).toBe(SHADOW_CUBE_FACES);
    const seen = new Set<string>();
    viewports.forEach((v, face) => {
      const { col, row } = cubeFaceCell(face);
      expect(v[0]).toBe(slot.x + col * faceSize);
      expect(v[1]).toBe(slot.y + row * faceSize);
      expect(v[2]).toBe(faceSize); // square: a 90-degree face in a non-square viewport would shear
      expect(v[3]).toBe(faceSize);
      seen.add(`${v[0]},${v[1]}`);
    });
    expect(seen.size).toBe(SHADOW_CUBE_FACES);

    // every scissor matches its viewport, so a face's clear cannot wipe a neighbour
    const scissors = rec.calls.filter((c) => c.name === "qglScissor").map((c) => c.args);
    expect(scissors).toEqual(viewports);
  });

  test("in a mixed light list BOTH kinds are shadowed, each binding naming its own light index", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [makePointLight([0, 0, 0], 512), coneLight, makePointLight([10, 0, 0], 512)], 3);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(3);
    const byIndex = new Map(bindings.map((b) => [b.lightIndex, b]));
    expect(byIndex.get(0)?.kind).toBe(SHADOW_KIND_POINT);
    expect(byIndex.get(1)?.kind).toBe(SHADOW_KIND_CONE); // the cone light's slot in r_dlights
    expect(byIndex.get(2)?.kind).toBe(SHADOW_KIND_POINT);

    // no two lights share atlas texels
    for (let i = 0; i < bindings.length; i++) {
      for (let j = i + 1; j < bindings.length; j++) {
        const a = bindings[i]?.slot;
        const b = bindings[j]?.slot;
        if (!a || !b) continue;
        const disjoint = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  test("a cone light produces exactly one binding, carrying its own atlas slot and matrix", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.lightIndex).toBe(0);
    expect(bindings[0]?.slot.width).toBe(512);
    expect(bindings[0]?.slot.height).toBe(512);
    expect(bindings[0]?.kind).toBe(SHADOW_KIND_CONE);
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

  // Was "nothing happens at all when shadow maps were never initialized".
  // R_RenderShadowMaps now allocates the atlas on the first frame it is
  // wanted, so a plain GL_ShutdownShadowMaps no longer keeps it quiet -- the
  // genuine "nothing happens" case is a context that cannot do FBOs at all,
  // which is what this now pins.
  test("a context without framebuffer objects does nothing at all, every frame, without re-warning", () => {
    const rec = new QGLRecording();
    // the null-out needs the QGL view (QGLRecording types these non-nullable);
    // `rec` itself stays typed so the call log below is reachable.
    const capless: QGL = rec;
    capless.qglGenFramebuffers = null;
    capless.qglBindFramebuffer = null;
    capless.qglFramebufferTexture2D = null;
    capless.qglCheckFramebufferStatus = null;
    SetQGL(rec);
    GL_ShutdownShadowMaps();

    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapBindings().length).toBe(0);
    expect(GL_ShadowMapsReady()).toBe(false);

    // the failure latches, so the second frame does not retry the probe
    const before = rec.calls.length;
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(rec.calls.length).toBe(before);
    expect(GL_ShadowMapsActive()).toBe(false);
  });

  // The cvar gate moved OUT of GL_InitShadowMaps and into GL_ShadowMapsActive,
  // which R_Init and R_RenderShadowMaps both consult. Keeping it inside init
  // meant a session that BOOTED with shadow mapping off could never turn it
  // back on without a vid_restart, which is the defect this pair now pins.
  test("gl_shadowmaps 0 leaves the shadow-map system inactive, so nothing allocates", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    glCvars.gl_shadowmaps = makeCvar(0);

    expect(GL_ShadowMapsActive()).toBe(false);
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapsReady()).toBe(false);
    expect(names(rec)).not.toContain("qglGenFramebuffers");
    expect(GL_ShadowMapBindings().length).toBe(0);
  });

  test("gl_shadowmaps flipped 0 -> 1 at runtime allocates the atlas on the next frame", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_ShutdownShadowMaps(); // fresh context: clears any capability latch
    glCvars.gl_shadowmaps = makeCvar(0);
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapsReady()).toBe(false);

    glCvars.gl_shadowmaps = makeCvar(1);
    R_RenderShadowMaps(world, [coneLight], 1);
    expect(GL_ShadowMapsReady()).toBe(true);
    expect(names(rec)).toContain("qglGenFramebuffers");
    expect(GL_ShadowMapBindings().length).toBe(1);
  });

  test("gl_shaders 0 makes the shadow-map system inactive whatever gl_shadowmaps says", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    glCvars.gl_shadowmaps = makeCvar(1);
    const savedShaders = glCvars.gl_shaders;
    glCvars.gl_shaders = makeCvar(0);
    try {
      expect(GL_ShadowMapsActive()).toBe(false);
      R_RenderShadowMaps(world, [coneLight], 1);
      expect(GL_ShadowMapsReady()).toBe(false);
      expect(GL_ShadowMapBindings().length).toBe(0);
    } finally {
      glCvars.gl_shaders = savedShaders;
    }
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
    // ...and the 16MB atlas goes back, rather than sitting allocated for a
    // feature the player just turned off.
    expect(GL_ShadowMapsReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v1.1.1: omnidirectional (cube-face) lights, and entity casters
// ---------------------------------------------------------------------------

function makeAliasModel(name = "models/monsters/soldier/tris.md2"): ModelT {
  const hdr = new ParsedMd2T();
  hdr.num_xyz = 3;
  hdr.num_frames = 1;
  hdr.num_tris = 1;
  hdr.frames = [
    {
      scale: [1, 1, 1],
      translate: [0, 0, 0],
      name: "stand",
      verts: [
        { v: [0, 0, 0], lightnormalindex: 0 },
        { v: [16, 0, 0], lightnormalindex: 0 },
        { v: [0, 0, 32], lightnormalindex: 0 },
      ],
    },
  ];
  // one triangle strip of three vertices: count, then (s, t, index) per vertex
  hdr.glcmds = [3, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0];

  const model = new ModelT();
  model.name = name;
  model.type = ModtypeT.mod_alias;
  model.extradata = hdr;
  model.mins = vec3(-32, -32, -32);
  model.maxs = vec3(32, 32, 32);
  return model;
}

function makeInlineBrushModel(name = "*1"): ModelT {
  const poly = new GlpolyT();
  poly.numverts = 3;
  poly.verts = [
    Float32Array.from([0, -16, -16, 0, 0, 0, 0]),
    Float32Array.from([0, 16, -16, 0, 0, 0, 0]),
    Float32Array.from([0, 0, 16, 0, 0, 0, 0]),
  ];
  const surf = new MsurfaceT();
  surf.flags = 0;
  surf.polys = poly;

  const model = new ModelT();
  model.name = name;
  model.type = ModtypeT.mod_brush;
  model.surfaces = [surf];
  model.numsurfaces = 1;
  model.firstmodelsurface = 0;
  model.nummodelsurfaces = 1;
  model.mins = vec3(-64, -16, -16);
  model.maxs = vec3(64, 16, 16);
  return model;
}

function makeEntity(model: ModelT, origin: readonly number[], flags = 0): EntityT {
  const e = new EntityT();
  e.model = model;
  e.flags = flags;
  e.origin = vec3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  e.oldorigin = vec3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  e.angles = vec3();
  e.frame = 0;
  e.oldframe = 0;
  e.backlerp = 0;
  return e;
}

describe("gl_shadowmap.ts -- cube face basis and selection", () => {
  test("every face basis is orthonormal and right-handed the same way matrixLookAt is", () => {
    expect(CUBE_FACE_BASIS.length).toBe(SHADOW_CUBE_FACES);
    for (const basis of CUBE_FACE_BASIS) {
      const vecs = [basis.forward, basis.right, basis.up];
      for (let i = 0; i < 3; i++) {
        const a = vecs[i];
        if (!a) continue;
        expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1, 6);
        for (let j = i + 1; j < 3; j++) {
          const b = vecs[j];
          if (!b) continue;
          expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeCloseTo(0, 6);
        }
      }
    }
  });

  test("the six forward axes are exactly +X -X +Y -Y +Z -Z, in the atlas's 3x2 cell order", () => {
    const expected = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    CUBE_FACE_BASIS.forEach((basis, i) => {
      expect([basis.forward[0], basis.forward[1], basis.forward[2]]).toEqual(expected[i] ?? []);
    });
  });

  test("matrixCubeFaceView is what matrixLookAt would have built -- the render side and the shader's hand-rolled lookup cannot drift", () => {
    const origin = vec3(-1184, -176, 136); // mguhub's one point shadow light
    for (let face = 0; face < SHADOW_CUBE_FACES; face++) {
      const basis = CUBE_FACE_BASIS[face];
      if (!basis) continue;
      const built = matrixCubeFaceView(origin, face);
      const reference = matrixLookAt(origin, basis.forward);
      for (let i = 0; i < 16; i++) expect(built[i]).toBeCloseTo(reference[i] ?? 0, 5);
    }
  });

  test("each face's own forward axis selects that face", () => {
    CUBE_FACE_BASIS.forEach((basis, face) => {
      expect(cubeFaceForDirection(basis.forward)).toBe(face);
    });
  });

  test("the 3x2 cell layout gives every face a distinct cell inside a 3-wide, 2-tall grid", () => {
    const seen = new Set<string>();
    for (let face = 0; face < SHADOW_CUBE_FACES; face++) {
      const { col, row } = cubeFaceCell(face);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(SHADOW_CUBE_COLS);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(SHADOW_CUBE_ROWS);
      seen.add(`${col},${row}`);
    }
    expect(seen.size).toBe(SHADOW_CUBE_FACES);
  });

  test("face selection never leaves a direction unclassified, and always picks the dominant axis", () => {
    for (let i = 0; i < 400; i++) {
      // deterministic spiral over the sphere -- no RNG, so a failure reproduces
      const t = (i / 400) * Math.PI * 2;
      const z = 1 - (2 * i) / 399;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const dir = vec3(r * Math.cos(t * 7.3), r * Math.sin(t * 7.3), z);
      const face = cubeFaceForDirection(dir);
      expect(face).toBeGreaterThanOrEqual(0);
      expect(face).toBeLessThan(SHADOW_CUBE_FACES);

      const basis = CUBE_FACE_BASIS[face];
      if (!basis) continue;
      const axial = dir[0] * basis.forward[0] + dir[1] * basis.forward[1] + dir[2] * basis.forward[2];
      // the chosen axis must be the largest in magnitude, and positive
      expect(axial).toBeGreaterThan(0);
      expect(axial).toBeGreaterThanOrEqual(Math.max(Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2])) - 1e-9);
    }
  });
});

describe("gl_shadowmap.ts -- cube face projection and depth inversion", () => {
  const light = vec3(320, -1344, 48); // command.bsp's dynamic_light, radius 128
  const radius = 128;

  test("a point straight along a face axis lands dead-centre in that face", () => {
    CUBE_FACE_BASIS.forEach((basis, face) => {
      const p = vec3(light[0] + basis.forward[0] * 64, light[1] + basis.forward[1] * 64, light[2] + basis.forward[2] * 64);
      const proj = cubeFaceProject(light, p, radius);
      expect(proj).not.toBeNull();
      if (!proj) return;
      expect(proj.face).toBe(face);
      expect(proj.u).toBeCloseTo(0.5, 5);
      expect(proj.v).toBeCloseTo(0.5, 5);
      expect(proj.axial).toBeCloseTo(64, 5);
    });
  });

  test("nothing inside a face's frustum ever projects outside its cell -- that is what a 90-degree face guarantees", () => {
    for (let i = 0; i < 300; i++) {
      const t = (i / 300) * Math.PI * 2;
      const z = 1 - (2 * i) / 299;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const dist = 8 + (i % 100);
      const p = vec3(light[0] + r * Math.cos(t * 5.1) * dist, light[1] + r * Math.sin(t * 5.1) * dist, light[2] + z * dist);
      const proj = cubeFaceProject(light, p, radius);
      if (!proj) continue;
      expect(proj.u).toBeGreaterThanOrEqual(0);
      expect(proj.u).toBeLessThanOrEqual(1);
      expect(proj.v).toBeGreaterThanOrEqual(0);
      expect(proj.v).toBeLessThanOrEqual(1);
      expect(proj.depth).toBeGreaterThanOrEqual(0);
      expect(proj.depth).toBeLessThanOrEqual(1);
    }
  });

  test("depth increases monotonically with distance, and the near/far planes land on 0 and 1", () => {
    expect(shadowCubeWindowDepth(SHADOW_NEAR, radius)).toBeCloseTo(0, 5);
    expect(shadowCubeWindowDepth(shadowCubeFar(radius), radius)).toBeCloseTo(1, 5);
    let previous = -1;
    for (const d of [SHADOW_NEAR, 8, 16, 32, 64, 128]) {
      const z = shadowCubeWindowDepth(d, radius);
      expect(z).toBeGreaterThan(previous);
      previous = z;
    }
  });

  test("the fragment shader's depth->distance inversion round-trips, which is what lets its bias be in world units", () => {
    for (const r of [64, 128, 350, 768]) {
      for (const d of [SHADOW_NEAR + 0.5, 10, 37, 100, shadowCubeFar(r) * 0.99]) {
        if (d > shadowCubeFar(r)) continue;
        expect(shadowCubeAxialDistance(shadowCubeWindowDepth(d, r), r)).toBeCloseTo(d, 3);
      }
    }
  });

  test("a cleared texel (depth 1.0) inverts to the far plane, so an empty face shadows nothing", () => {
    for (const r of [64, 512]) {
      expect(shadowCubeAxialDistance(1, r)).toBeCloseTo(shadowCubeFar(r), 3);
    }
  });

  test("a point behind the near plane gets no projection -- the shader's early-out", () => {
    expect(cubeFaceProject(light, vec3(light[0] + 1, light[1], light[2]), radius)).toBeNull();
    expect(cubeFaceProject(light, light, radius)).toBeNull();
  });

  test("the face frustum is exactly 90 degrees, which is what makes tan(45) == 1 in the shader", () => {
    expect(SHADOW_CUBE_FOV).toBe(90);
    // a point offset sideways by exactly its axial distance lands on the face edge
    const p = vec3(light[0] + 64, light[1] + 64, light[2]);
    const proj = cubeFaceProject(light, p, radius);
    expect(proj).not.toBeNull();
    if (!proj) return;
    expect(Math.min(Math.abs(proj.u - 0), Math.abs(proj.u - 1), Math.abs(proj.v - 0), Math.abs(proj.v - 1))).toBeCloseTo(0, 5);
  });
});

describe("gl_shadowmap.ts -- caster classification", () => {
  test("alias models and inline brush models are casters", () => {
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0]))).toBe(SHADOW_CASTER_ALIAS);
    expect(shadowCasterKind(makeEntity(makeInlineBrushModel(), [0, 0, 0]))).toBe(SHADOW_CASTER_BRUSH);
  });

  test("the player's own body still casts -- RF_VIEWERMODEL is about the eye pass, not about light", () => {
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0], RF_VIEWERMODEL))).toBe(SHADOW_CASTER_ALIAS);
  });

  test("the view weapon is never a caster: it sits at the eye and would black out the room", () => {
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0], RF_WEAPONMODEL))).toBe(SHADOW_CASTER_NONE);
  });

  test("you cannot cast a shadow with something you can see through", () => {
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0], RF_TRANSLUCENT))).toBe(SHADOW_CASTER_NONE);
  });

  test("RF_NOSHADOW is honoured", () => {
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0], RF_NOSHADOW))).toBe(SHADOW_CASTER_NONE);
  });

  test("beams and flares carry no model at all, so there is nothing to rasterize", () => {
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0], RF_BEAM))).toBe(SHADOW_CASTER_NONE);
    expect(shadowCasterKind(makeEntity(makeAliasModel(), [0, 0, 0], RF_FLARE))).toBe(SHADOW_CASTER_NONE);
  });

  test("a sprite is a camera-facing billboard -- its shadow would swing as the player turned", () => {
    const sprite = makeAliasModel();
    sprite.type = ModtypeT.mod_sprite;
    expect(shadowCasterKind(makeEntity(sprite, [0, 0, 0]))).toBe(SHADOW_CASTER_NONE);
  });

  test("a modelless entity and a null entity are both safely nothing", () => {
    const e = new EntityT();
    expect(shadowCasterKind(e)).toBe(SHADOW_CASTER_NONE);
    expect(shadowCasterKind(null)).toBe(SHADOW_CASTER_NONE);
  });

  test("the caster sphere is centred on the ORIGIN, so it stays valid however the entity is rotated", () => {
    // the corner of the +-32 box every shipped alias model reports
    expect(shadowCasterRadius(makeAliasModel())).toBeCloseTo(Math.hypot(32, 32, 32), 4);
    // an off-centre brush model still gets a sphere containing its whole box
    expect(shadowCasterRadius(makeInlineBrushModel())).toBeCloseTo(Math.hypot(64, 16, 16), 4);
  });
});

describe("gl_shadowmap.ts -- entity casters in the depth pass", () => {
  const coneLight = makeConeLight([0, 0, 0], [-1, 0, 0], 512, Math.cos((30 * Math.PI) / 180), 512);

  function vertexCount(rec: QGLRecording): number {
    return rec.calls.filter((c) => c.name === "qglVertex3fv").length;
  }

  test("an alias entity inside a cone light is emitted into its depth map, transformed to its own place", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    const monster = makeEntity(makeAliasModel(), [-100, 0, 0]);
    R_RenderShadowMaps(makeWorld(200), [coneLight], 1, [monster], 1);

    // three world verts + three alias verts
    expect(vertexCount(rec)).toBe(6);
    expect(names(rec)).toContain("qglPushMatrix");
    expect(names(rec)).toContain("qglPopMatrix");
    expect(rec.calls.find((c) => c.name === "qglTranslatef")?.args).toEqual([-100, 0, 0]);
    expect(GL_ShadowMapStats().entityCasters).toBe(1);
  });

  test("an inline brush model (a door, a platform) is emitted the same way", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    const door = makeEntity(makeInlineBrushModel(), [-100, 0, 0]);
    R_RenderShadowMaps(makeWorld(200), [coneLight], 1, [door], 1);

    expect(vertexCount(rec)).toBe(6);
    expect(GL_ShadowMapStats().entityCasters).toBe(1);
  });

  test("an entity beyond the light's radius is not emitted", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    const faraway = makeEntity(makeAliasModel(), [-5000, 0, 0]);
    R_RenderShadowMaps(makeWorld(200), [coneLight], 1, [faraway], 1);

    expect(vertexCount(rec)).toBe(3); // world only
    expect(GL_ShadowMapStats().entityCasters).toBe(0);
  });

  test("an entity BEHIND a cone light is outside its frustum and is not emitted", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    // the light at the origin aims along -X; this one is 200 units up +X
    const behind = makeEntity(makeAliasModel(), [200, 0, 0]);
    R_RenderShadowMaps(makeWorld(200), [coneLight], 1, [behind], 1);

    expect(vertexCount(rec)).toBe(3);
  });

  test("a non-caster entity in range is skipped without disturbing the world pass", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    const viewWeapon = makeEntity(makeAliasModel(), [-100, 0, 0], RF_WEAPONMODEL);
    R_RenderShadowMaps(makeWorld(200), [coneLight], 1, [viewWeapon], 1);

    expect(vertexCount(rec)).toBe(3);
  });

  test("r_drawentities 0 hides an entity's shadow too -- no shadows cast by nothing", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    const previous = glCvars.r_drawentities;
    const off = new CvarT();
    off.name = "r_drawentities";
    off.string = "0";
    off.value = 0;
    glCvars.r_drawentities = off;
    rec.clear();

    try {
      R_RenderShadowMaps(makeWorld(200), [coneLight], 1, [makeEntity(makeAliasModel(), [-100, 0, 0])], 1);
      expect(vertexCount(rec)).toBe(3);
    } finally {
      glCvars.r_drawentities = previous;
    }
  });

  test("a point light emits its casters into every face they can reach, and into no face they cannot", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    // straight down +X from the light: only the +X face's frustum contains it
    const caster = makeEntity(makeAliasModel(), [200, 0, 0]);
    R_RenderShadowMaps(makeWorld(1e6), [makePointLight([0, 0, 0], 512)], 1, [caster], 1);

    // the world triangle is far outside the radius, so every vertex recorded
    // is the caster's; three per face it was emitted into
    const emitted = rec.calls.filter((c) => c.name === "qglVertex3fv").length / 3;
    expect(emitted).toBeGreaterThanOrEqual(1);
    expect(emitted).toBeLessThan(SHADOW_CUBE_FACES); // not blindly six times
  });
});

describe("gl_shadowmap.ts -- only CS_SHADOWLIGHTS-fed lights get depth maps", () => {
  test("a classic transient dlight is coneless but gets NO cube map -- no rocket allocates six faces", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();
    rec.clear();

    R_RenderShadowMaps(makeWorld(100), [makeClassicDlight([0, 0, 0], 300)], 1);

    expect(GL_ShadowMapBindings().length).toBe(0);
    expect(GL_ShadowMapStats().facesRendered).toBe(0);
    expect(names(rec)).not.toContain("qglBegin");
  });

  test("a shadow light and a muzzle flash side by side: only the shadow light is mapped", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    R_RenderShadowMaps(makeWorld(100), [makeClassicDlight([0, 0, 0], 300), makePointLight([0, 0, 0], 512)], 2);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.lightIndex).toBe(1);
    expect(bindings[0]?.kind).toBe(SHADOW_KIND_POINT);
  });
});

describe("gl_shadowmap.ts -- cache invalidation with entity casters", () => {
  const coneLight = makeConeLight([0, 0, 0], [-1, 0, 0], 512, Math.cos((30 * Math.PI) / 180), 512);
  const world = makeWorld(200);

  test("a STILL entity caster costs nothing after the first frame -- the cached path survives casters", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const idle = makeEntity(makeAliasModel(), [-100, 0, 0]);
    R_RenderShadowMaps(world, [coneLight], 1, [idle], 1);
    expect(GL_ShadowMapStats().facesRendered).toBe(1);

    rec.clear();
    R_RenderShadowMaps(world, [coneLight], 1, [idle], 1);
    expect(names(rec)).not.toContain("qglBegin");
    expect(GL_ShadowMapStats().facesRendered).toBe(0);
    expect(GL_ShadowMapStats().cachedLights).toBe(1);
  });

  test("backlerp ticking on a NON-animating entity does not rebuild anything -- otherwise every crate in the level would", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const crate = makeEntity(makeAliasModel(), [-100, 0, 0]);
    R_RenderShadowMaps(world, [coneLight], 1, [crate], 1);

    rec.clear();
    crate.backlerp = 0.37; // the client advances this every single frame
    R_RenderShadowMaps(world, [coneLight], 1, [crate], 1);
    expect(names(rec)).not.toContain("qglBegin");
    expect(GL_ShadowMapStats().cachedLights).toBe(1);
  });

  test("an entity that MOVES rebuilds the depth map that frame", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const walker = makeEntity(makeAliasModel(), [-100, 0, 0]);
    R_RenderShadowMaps(world, [coneLight], 1, [walker], 1);

    rec.clear();
    walker.origin = vec3(-120, 0, 0);
    R_RenderShadowMaps(world, [coneLight], 1, [walker], 1);
    expect(names(rec)).toContain("qglBegin");
    expect(GL_ShadowMapStats().rebuiltLights).toBe(1);
  });

  test("an entity that ANIMATES in place rebuilds too -- its silhouette changed even though its origin did not", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const model = makeAliasModel();
    const monster = makeEntity(model, [-100, 0, 0]);
    R_RenderShadowMaps(world, [coneLight], 1, [monster], 1);

    rec.clear();
    monster.oldframe = 0;
    monster.frame = 1;
    monster.backlerp = 0.5;
    R_RenderShadowMaps(world, [coneLight], 1, [monster], 1);
    expect(names(rec)).toContain("qglBegin");
  });

  test("an entity that ROTATES in place rebuilds -- a turning door sweeps a different shadow", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const door = makeEntity(makeInlineBrushModel(), [-100, 0, 0]);
    R_RenderShadowMaps(world, [coneLight], 1, [door], 1);

    rec.clear();
    door.angles = vec3(0, 45, 0);
    R_RenderShadowMaps(world, [coneLight], 1, [door], 1);
    expect(names(rec)).toContain("qglBegin");
  });

  test("a caster LEAVING the light's range rebuilds once, then goes quiet again", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const walker = makeEntity(makeAliasModel(), [-100, 0, 0]);
    R_RenderShadowMaps(world, [coneLight], 1, [walker], 1);

    rec.clear();
    R_RenderShadowMaps(world, [coneLight], 1, [], 0); // walked out of the level's entity list
    expect(names(rec)).toContain("qglBegin");
    expect(GL_ShadowMapStats().entityCasters).toBe(0);

    rec.clear();
    R_RenderShadowMaps(world, [coneLight], 1, [], 0);
    expect(names(rec)).not.toContain("qglBegin");
  });

  test("a point light with no casters caches its six faces just as a cone light caches its one", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    GL_InitShadowMaps();

    const point = makePointLight([0, 0, 0], 512);
    R_RenderShadowMaps(world, [point], 1);
    expect(GL_ShadowMapStats().facesRendered).toBe(SHADOW_CUBE_FACES);

    rec.clear();
    R_RenderShadowMaps(world, [point], 1);
    expect(GL_ShadowMapStats().facesRendered).toBe(0);
    expect(names(rec)).not.toContain("qglViewport");
  });

  test("a moving caster inside a point light costs all six faces, which is the cost this design has to own", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    const point = makePointLight([0, 0, 0], 512);
    const walker = makeEntity(makeAliasModel(), [-100, 0, 0]);
    R_RenderShadowMaps(world, [point], 1, [walker], 1);

    walker.origin = vec3(-120, 0, 0);
    R_RenderShadowMaps(world, [point], 1, [walker], 1);
    expect(GL_ShadowMapStats().facesRendered).toBe(SHADOW_CUBE_FACES);
    expect(GL_ShadowMapStats().rebuiltLights).toBe(1);
  });
});

describe("gl_shadowmap.ts -- atlas budget for cube lights", () => {
  const world = makeWorld(200);

  test("eight point lights all get a rectangle: face resolution is lowered rather than lights dropped", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    const lights = [];
    for (let i = 0; i < 8; i++) lights.push(makePointLight([i * 32, 0, 0], 512));
    R_RenderShadowMaps(world, lights, 8);

    const bindings = GL_ShadowMapBindings();
    expect(bindings.length).toBe(8);
    for (const b of bindings) {
      expect(b.kind).toBe(SHADOW_KIND_POINT);
      expect(b.slot.width).toBe((b.slot.height / SHADOW_CUBE_ROWS) * SHADOW_CUBE_COLS);
      expect(b.slot.x + b.slot.width).toBeLessThanOrEqual(SHADOW_ATLAS_SIZE);
      expect(b.slot.y + b.slot.height).toBeLessThanOrEqual(SHADOW_ATLAS_SIZE);
    }

    // ...and they still do not overlap
    for (let i = 0; i < bindings.length; i++) {
      for (let j = i + 1; j < bindings.length; j++) {
        const a = bindings[i]?.slot;
        const b = bindings[j]?.slot;
        if (!a || !b) continue;
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
  });

  test("a lone point light keeps the full face resolution its light asked for", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();
    // no shadowlightresolution key -- the default, which is what 460 of the
    // shipped shadow lights actually take
    R_RenderShadowMaps(world, [makePointLight([0, 0, 0], 512)], 1);
    const slot = GL_ShadowMapBindings()[0]?.slot;
    expect(slot?.width).toBe(SHADOW_RES_DEFAULT * SHADOW_CUBE_COLS);
    expect(slot?.height).toBe(SHADOW_RES_DEFAULT * SHADOW_CUBE_ROWS);
  });

  test("a face edge that would make the rectangle wider than the atlas is halved, not refused", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();
    // 1024 per face is 3072 wide -- more than the 2048 atlas has in any row
    const greedy = makePointLight([0, 0, 0], 512);
    greedy.resolution = 1024;
    R_RenderShadowMaps(world, [greedy], 1);
    const slot = GL_ShadowMapBindings()[0]?.slot;
    expect(slot?.width).toBe(512 * SHADOW_CUBE_COLS);
    expect(slot?.height).toBe(512 * SHADOW_CUBE_ROWS);
  });

  test("gl_shadowmap_res caps a point light's PER-FACE edge, not its whole rectangle", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();
    const cap = new CvarT();
    cap.name = "gl_shadowmap_res";
    cap.string = "256";
    cap.value = 256;
    const previous = glCvars.gl_shadowmap_res;
    glCvars.gl_shadowmap_res = cap;
    try {
      R_RenderShadowMaps(world, [makePointLight([0, 0, 0], 512)], 1);
      const slot = GL_ShadowMapBindings()[0]?.slot;
      expect(slot?.width).toBe(256 * SHADOW_CUBE_COLS);
      expect(slot?.height).toBe(256 * SHADOW_CUBE_ROWS);
    } finally {
      glCvars.gl_shadowmap_res = previous;
    }
  });

  test("a cone light is never shrunk to make room -- v1.1.0's working shadows do not regress", () => {
    SetQGL(new QGLRecording());
    GL_InitShadowMaps();

    const lights: DlightT[] = [makeConeLight([0, 0, 0], [-1, 0, 0], 512, Math.cos((30 * Math.PI) / 180), 512)];
    for (let i = 0; i < 7; i++) lights.push(makePointLight([i * 32, 0, 0], 512));
    R_RenderShadowMaps(world, lights, 8);

    const cone = GL_ShadowMapBindings().find((b) => b.kind === SHADOW_KIND_CONE);
    expect(cone?.slot.width).toBe(512);
    expect(cone?.slot.height).toBe(512);
  });

  test("the rectangle packer still refuses anything larger than the atlas rather than clipping it", () => {
    expect(packShadowAtlas([{ width: SHADOW_ATLAS_SIZE + 1, height: 64 }])[0]).toBeNull();
    expect(packShadowAtlas([{ width: 64, height: SHADOW_ATLAS_SIZE + 1 }])[0]).toBeNull();
  });

  test("a rectangle shelf never overlaps, for a mixed cube/cone request set", () => {
    const slots = packShadowAtlas([{ width: 1536, height: 1024 }, { width: 768, height: 512 }, 512, { width: 384, height: 256 }, 256]);
    const boxes = slots.filter((s): s is NonNullable<typeof s> => s !== null);
    expect(boxes.length).toBe(5);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
  });
});
