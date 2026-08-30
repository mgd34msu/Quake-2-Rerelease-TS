/*
Tests for src/ref_gl/gl_mesh.ts, per this unit's brief (rule 13):
self-sufficient, no reliance on any other test file having run first. Rather
than parsing a byte-level MD2 file (test/gl_model.test.ts already covers
that loader), these tests hand-build a `ParsedMd2T` object directly (the
same shape Mod_LoadAliasModel would have produced) and drive R_DrawAliasModel
through it, asserting the qgl call sequence for the triangle-strip draw via
QGLRecording.

Every entity flag combination below picks RF_WEAPONMODEL so R_CullAliasModel
is skipped entirely (its frustum-culling math is gl_rmain.ts's concern, not
this file's), and leaves gl_lefthand/gl_shadows/gl_vertex_arrays/r_lerpmodels
unset so R_DrawAliasModel's other conditional side branches (perspective
flip, shadow pass, vertex-array path) stay inert -- this isolates exactly
the GL_DrawAliasFrameLerp emission this file owns.

Only the calls between the triangle-strip's own qglBegin/qglEnd are
asserted; qglBindTexture/qglTexEnvf's exact emission depends on gl_image.ts's
own shared, cross-test-file GL-state caches (`gl_state.currenttextures`,
`GL_TexEnv`'s private `lastmodes`), which this file has no exported reset
for -- asserting on them here would make the test's pass/fail depend on
which other test files ran first in the same bun test process.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { EntityT, POWERSUIT_SCALE } from "../src/client/ref";
import { RF_WEAPONMODEL, RF_FULLBRIGHT, RF_SHELL_RED } from "../src/shared/q_shared";
import { QGLRecording, type QGLCall } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { SetRefImports, SetCurrentModel, SetCurrentEntity, glCvars, r_newrefdef, ImageT } from "../src/ref_gl/gl_local";
import { ModelT, ParsedMd2T } from "../src/ref_gl/gl_model";
import { R_DrawAliasModel, r_avertexnormals, r_avertexnormal_dots } from "../src/ref_gl/gl_mesh";

function xyz(x: number, y: number, z: number): [number, number, number] {
  return [x, y, z];
}

// (float*)order -- see gl_mesh.ts's header comment on this bit-reinterpretation.
const floatBitsBuffer = new ArrayBuffer(4);
const floatBitsFloatView = new Float32Array(floatBitsBuffer);
const floatBitsIntView = new Int32Array(floatBitsBuffer);
function floatBits(f: number): number {
  floatBitsFloatView[0] = f;
  return floatBitsIntView[0];
}

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

// builds a 3-vertex, 1-triangle, 1-frame MD2 header with a single
// triangle-strip glcmds block -- see test/gl_model.test.ts's byte-level
// builder for the on-disk shape this mirrors as plain objects.
function buildTestMd2(): ParsedMd2T {
  const hdr = new ParsedMd2T();
  hdr.num_frames = 1;
  hdr.num_xyz = 3;
  hdr.num_tris = 1;
  hdr.num_st = 3;
  hdr.num_skins = 1;
  hdr.frames = [
    {
      scale: xyz(1, 1, 1),
      translate: xyz(10, 20, 30),
      name: "frame0",
      verts: [
        { v: xyz(1, 2, 3), lightnormalindex: 0 },
        { v: xyz(4, 5, 6), lightnormalindex: 0 },
        { v: xyz(7, 8, 9), lightnormalindex: 0 },
      ],
    },
  ];
  // one triangle strip of 3 verts: [3, s0,t0,idx0, s1,t1,idx1, s2,t2,idx2, 0]
  hdr.glcmds = [3, floatBits(0.5), floatBits(0.25), 0, floatBits(0.75), floatBits(0.125), 1, floatBits(1.0), floatBits(0.0), 2, 0];
  return hdr;
}

function makeEntity(flags: number): EntityT {
  const e = new EntityT();
  e.flags = flags;
  e.frame = 0;
  e.oldframe = 0;
  e.backlerp = 0;
  e.alpha = 1;
  return e;
}

// slices the recorded calls down to the one qglBegin/qglEnd pair the
// triangle-strip draw emits -- see file header comment on why the
// surrounding qglBindTexture/qglTexEnvf calls are excluded.
function triangleBlock(calls: readonly QGLCall[]): QGLCall[] {
  const beginIdx = calls.findIndex((c) => c.name === "qglBegin");
  const endIdx = calls.findIndex((c) => c.name === "qglEnd");
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) throw new Error("no qglBegin/qglEnd pair found");
  return calls.slice(beginIdx, endIdx + 1);
}

function vertexArgAsTriplet(call: QGLCall): [number, number, number] {
  const v = call.args[0];
  if (!(v instanceof Float32Array)) throw new Error("expected qglVertex3fv's argument to be a Float32Array");
  return [v[0], v[1], v[2]];
}

beforeEach(() => {
  SetRefImports(makeFakeRi());
  SetQGL(new QGLRecording());

  glCvars.r_lefthand = null;
  glCvars.gl_shadows = null;
  glCvars.r_lerpmodels = null;
  glCvars.gl_vertex_arrays = null;
  glCvars.gl_monolightmap = null;
  glCvars.r_lightlevel = null;

  r_newrefdef.rdflags = 0;
  r_newrefdef.time = 0;
});

describe("gl_mesh.ts -- R_DrawAliasModel / GL_DrawAliasFrameLerp", () => {
  test("non-shell entity: emits texcoord + lit color + lerped vertex per glcmds vertex, in triangle-strip order", () => {
    const paliashdr = buildTestMd2();

    const model = new ModelT();
    model.name = "test.md2";
    model.extradata = paliashdr;
    const skin = new ImageT();
    skin.texnum = 7;
    model.skins[0] = skin;
    SetCurrentModel(model);

    const e = makeEntity(RF_WEAPONMODEL | RF_FULLBRIGHT);
    SetCurrentEntity(e);

    const rec = new QGLRecording();
    SetQGL(rec);

    R_DrawAliasModel(e);

    const block = triangleBlock(rec.calls);
    expect(block.map((c) => c.name)).toEqual(["qglBegin", "qglTexCoord2f", "qglColor4f", "qglVertex3fv", "qglTexCoord2f", "qglColor4f", "qglVertex3fv", "qglTexCoord2f", "qglColor4f", "qglVertex3fv", "qglEnd"]);

    expect(block[0]?.args).toEqual([0x0005]); // GL_TRIANGLE_STRIP (positive count)

    // RF_FULLBRIGHT forces shadelight = (1,1,1); the lit color is
    // shadedots[lightnormalindex] * shadelight -- shadedots defaults to
    // r_avertexnormal_dots[0] (angles[1] === 0), lightnormalindex 0 for
    // every vertex here.
    const l = r_avertexnormal_dots[0][0];
    const expectedVerts: [number, number, number][] = [
      [10 + 1, 20 + 2, 30 + 3],
      [10 + 4, 20 + 5, 30 + 6],
      [10 + 7, 20 + 8, 30 + 9],
    ];
    const expectedTexcoords: [number, number][] = [
      [0.5, 0.25],
      [0.75, 0.125],
      [1.0, 0.0],
    ];

    for (let i = 0; i < 3; i++) {
      const texcoordCall = block[1 + i * 3];
      const colorCall = block[2 + i * 3];
      const vertexCall = block[3 + i * 3];

      expect(texcoordCall?.args[0]).toBeCloseTo(expectedTexcoords[i][0], 5);
      expect(texcoordCall?.args[1]).toBeCloseTo(expectedTexcoords[i][1], 5);

      expect(colorCall?.args).toEqual([l, l, l, 1]);

      if (!vertexCall) throw new Error("missing vertex call");
      const [vx, vy, vz] = vertexArgAsTriplet(vertexCall);
      expect(vx).toBeCloseTo(expectedVerts[i][0], 5);
      expect(vy).toBeCloseTo(expectedVerts[i][1], 5);
      expect(vz).toBeCloseTo(expectedVerts[i][2], 5);
    }
  });

  test("shell entity (RF_SHELL_RED): skips texcoords, uses flat shadelight color, and offsets vertices by the vertex normal * POWERSUIT_SCALE", () => {
    const paliashdr = buildTestMd2();

    const model = new ModelT();
    model.name = "test.md2";
    model.extradata = paliashdr;
    const skin = new ImageT();
    skin.texnum = 7;
    model.skins[0] = skin;
    SetCurrentModel(model);

    const e = makeEntity(RF_WEAPONMODEL | RF_SHELL_RED);
    SetCurrentEntity(e);

    const rec = new QGLRecording();
    SetQGL(rec);

    R_DrawAliasModel(e);

    const block = triangleBlock(rec.calls);
    // shell path: qglColor4f + qglVertex3fv per vertex, no qglTexCoord2f.
    expect(block.map((c) => c.name)).toEqual(["qglBegin", "qglColor4f", "qglVertex3fv", "qglColor4f", "qglVertex3fv", "qglColor4f", "qglVertex3fv", "qglEnd"]);

    // RF_SHELL_RED alone (no BLUE/DOUBLE) -> shadelight = (1,0,0), alpha 1
    // (not RF_TRANSLUCENT).
    for (let i = 0; i < 3; i++) {
      const colorCall = block[1 + i * 2];
      expect(colorCall?.args).toEqual([1, 0, 0, 1]);
    }

    // GL_LerpVerts' shell branch adds r_avertexnormals[lightnormalindex] *
    // POWERSUIT_SCALE on top of the same move+scale math as the non-shell
    // case; lightnormalindex is 0 for every vertex in this fixture.
    const normal = r_avertexnormals[0];
    const rawVerts: [number, number, number][] = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];

    for (let i = 0; i < 3; i++) {
      const vertexCall = block[2 + i * 2];
      if (!vertexCall) throw new Error("missing vertex call");
      const [vx, vy, vz] = vertexArgAsTriplet(vertexCall);
      expect(vx).toBeCloseTo(10 + rawVerts[i][0] + normal[0] * POWERSUIT_SCALE, 5);
      expect(vy).toBeCloseTo(20 + rawVerts[i][1] + normal[1] * POWERSUIT_SCALE, 5);
      expect(vz).toBeCloseTo(30 + rawVerts[i][2] + normal[2] * POWERSUIT_SCALE, 5);
    }
  });
});
