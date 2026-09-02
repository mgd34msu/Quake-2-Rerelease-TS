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
import { RF_WEAPONMODEL, RF_FULLBRIGHT, RF_SHELL_RED, RF_IR_VISIBLE } from "../src/shared/q_shared";
import { QGLRecording, type QGLCall } from "../src/ref_gl/qgl";
import { SetQGL, GL_TEXTURE_2D } from "../src/ref_gl/gl_image";
import { SetRefImports, SetCurrentModel, SetCurrentEntity, glCvars, r_newrefdef, ImageT } from "../src/ref_gl/gl_local";
import { ModelT, ParsedMd2T } from "../src/ref_gl/gl_model";
import { R_DrawAliasModel, r_avertexnormals, r_avertexnormal_dots } from "../src/ref_gl/gl_mesh";
import { GL_InitShadowMaps } from "../src/ref_gl/gl_shadowmap";
import { Md5ModelT, Md5MeshT, Md5VertexT, Md5WeightT, Md5TCoordT, Md5SkeletonJointT } from "../src/qcommon/md5_model";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";

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

  // Symptom pin for the live "solid yellow untextured props" defect
  // (.orch/followups.md finding 2). The renderer itself is faithful -- the
  // wire bug that produced it lived in the 1038/kex entity-delta READ (16-bit
  // fields read signed; see test/protocol_q2repro.test.ts). These two cases
  // lock the exact discriminator that turned one wrong bit into the visible
  // blob, so a future regression on either side is caught here too.
  function drawWithFlags(flags: number): QGLCall[] {
    const paliashdr = buildTestMd2();
    const model = new ModelT();
    model.name = "test.md2";
    model.extradata = paliashdr;
    const skin = new ImageT();
    skin.texnum = 7;
    model.skins[0] = skin;
    SetCurrentModel(model);

    const e = makeEntity(flags);
    SetCurrentEntity(e);

    const rec = new QGLRecording();
    SetQGL(rec);
    R_DrawAliasModel(e);
    return [...rec.calls];
  }

  test("RF_IR_VISIBLE alone is NOT a shell: texturing stays on and the model draws textured", () => {
    // 0x8000 is what src/kexgame/g_spawn.ts's SpawnEntities leaves on every
    // prop whose spawn function set no other renderfx (misc_explobox,
    // misc_deadsoldier, misc_gib_*) -- confirmed against a real base1 boot.
    const calls = drawWithFlags(RF_WEAPONMODEL | RF_IR_VISIBLE);
    const block = triangleBlock(calls);

    expect(block.filter((c) => c.name === "qglTexCoord2f").length).toBe(3);
    expect(calls.some((c) => c.name === "qglDisable" && c.args[0] === GL_TEXTURE_2D)).toBe(false);
  });

  test("the sign-extended 0xffff8000 renderfx draws the untextured yellow (0.9,0.7,0) shell -- the reported symptom", () => {
    // Reading RF_IR_VISIBLE back through a SIGNED 16-bit wire field yields
    // -32768, i.e. bits 15..31: RF_SHELL_DOUBLE|RF_SHELL_HALF_DAM set,
    // RF_SHELL_RED/GREEN/BLUE clear. R_DrawAliasModel's colour block then
    // picks the RF_SHELL_DOUBLE arm (0.9, 0.7, 0.0), isShellFlags disables
    // GL_TEXTURE_2D and puffs the mesh, but GL_DrawAliasFrameLerp's
    // immediate-mode branch tests only RED|GREEN|BLUE (faithful to id's own
    // gl_mesh.c:258 discrepancy vs :205's vertex-array branch), so it emits
    // per-vertex `l * shadelight` instead of a flat colour: an untextured,
    // Gouraud-shaded yellow blob at exactly R:G = 0.9:0.7 = 1.2857 -- the
    // ratio measured across the reported screenshots.
    const signExtended = -32768;
    const calls = drawWithFlags(RF_WEAPONMODEL | signExtended);
    const block = triangleBlock(calls);

    // GL_TEXTURE_2D is disabled (isShellFlags), so the model is untextured --
    // but the immediate-mode else-branch still emits its qglTexCoord2f calls,
    // which are inert with texturing off. That combination (no texture, but
    // per-vertex Gouraud colour) is precisely what neither a normal draw nor a
    // proper flat shell produces, and is the screenshots' exact appearance.
    expect(calls.some((c) => c.name === "qglDisable" && c.args[0] === GL_TEXTURE_2D)).toBe(true);
    expect(block.filter((c) => c.name === "qglTexCoord2f").length).toBe(3);

    const colorCalls = block.filter((c) => c.name === "qglColor4f");
    expect(colorCalls.length).toBe(3);
    for (const c of colorCalls) {
      const [r, g, b] = c.args as [number, number, number, number];
      expect(b).toBe(0);
      expect(r / g).toBeCloseTo(0.9 / 0.7, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// The 1997 planar shadow decal (gl_shadows): when it draws, what geometry it
// projects, and the shadow-map interaction.
//
// Motivated by a play-test that showed giant fans of overlapping black
// triangles spraying across the floor around every monster in the rerelease
// content, plus black patches on the monsters' own skins. Two independent
// causes, one test group:
//
//   * the decal drew AT ALL while shadow mapping was on (gl_shadows had been
//     given q2repro's "2" default while keeping id's 1997 implementation),
//     and
//   * for a model drawn through the MD5 skeleton path -- every rerelease
//     monster, item and gib -- it projected `s_lerped`, which only the MD2
//     path ever fills, so it drew a stale unrelated mesh.
// ---------------------------------------------------------------------------

function makeSkeletonModel(positions: readonly [number, number, number][]): Md5ModelT {
  const md5 = new Md5ModelT();
  md5.numMeshes = 1;
  md5.numJoints = 1;
  md5.numFrames = 1;

  // one joint at the origin with an identity axis, so calcSkelVert reduces to
  // "the weight position is the vertex position" and the test can assert on
  // the projection alone rather than on the skinning.
  const joint = new Md5SkeletonJointT();
  joint.scale = 1;
  joint.axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  md5.skeletonFrames = [joint];

  const mesh = new Md5MeshT();
  mesh.numVerts = positions.length;
  mesh.numIndices = positions.length;
  mesh.numWeights = positions.length;
  mesh.indices = positions.map((_p, i) => i);
  for (let i = 0; i < positions.length; i++) {
    const v = new Md5VertexT();
    v.start = i;
    v.count = 1;
    mesh.vertices.push(v);
    const w = new Md5WeightT();
    w.bias = 1;
    w.pos = vec3(positions[i][0], positions[i][1], positions[i][2]);
    mesh.weights.push(w);
    mesh.jointnums.push(0);
    mesh.tcoords.push(new Md5TCoordT());
  }
  md5.meshes = [mesh];
  return md5;
}

function makeCvar(value: number): CvarT {
  const c = new CvarT();
  c.name = "test";
  c.string = String(value);
  c.value = value;
  return c;
}

// every qglBegin..qglEnd pair, in order
function drawBlocks(calls: readonly QGLCall[]): QGLCall[][] {
  const blocks: QGLCall[][] = [];
  let current: QGLCall[] | null = null;
  for (const c of calls) {
    if (c.name === "qglBegin") current = [];
    if (current) current.push(c);
    if (c.name === "qglEnd" && current) {
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

describe("gl_mesh.ts -- gl_shadows planar decal", () => {
  function setupMd2Entity(): EntityT {
    const model = new ModelT();
    model.name = "test.md2";
    model.extradata = buildTestMd2();
    const skin = new ImageT();
    skin.texnum = 7;
    model.skins[0] = skin;
    SetCurrentModel(model);

    const e = makeEntity(0);
    e.origin = vec3(0, 0, 40);
    SetCurrentEntity(e);
    return e;
  }

  beforeEach(() => {
    // GL_ShadowMapsActive latches a permanent "this context cannot do shadow
    // maps" flag on a failed init. A successful init here clears it, so this
    // file does not depend on whether gl_shadowmap.test.ts ran first.
    SetQGL(new QGLRecording());
    glCvars.gl_shaders = makeCvar(1);
    glCvars.gl_shadowmaps = makeCvar(1);
    GL_InitShadowMaps();
    glCvars.gl_md5_use = makeCvar(1);
    glCvars.gl_md5_distance = makeCvar(0);
  });

  test("shadow mapping ON suppresses the decal entirely, even with gl_shadows set", () => {
    const e = setupMd2Entity();
    glCvars.gl_shadows = makeCvar(1);
    glCvars.gl_shadowmaps = makeCvar(1);

    const rec = new QGLRecording();
    SetQGL(rec);
    R_DrawAliasModel(e);

    // exactly one draw block: the model itself. No second, untextured one.
    expect(drawBlocks(rec.calls).length).toBe(1);
  });

  test("shadow mapping OFF lets the decal draw, as its own untextured blended block", () => {
    const e = setupMd2Entity();
    glCvars.gl_shadows = makeCvar(1);
    glCvars.gl_shadowmaps = makeCvar(0);

    const rec = new QGLRecording();
    SetQGL(rec);
    R_DrawAliasModel(e);

    const blocks = drawBlocks(rec.calls);
    expect(blocks.length).toBe(2);
    // the decal emits positions only -- no texcoords, no per-vertex colours
    const decal = blocks[1] ?? [];
    expect(decal.map((c) => c.name)).toEqual(["qglBegin", "qglVertex3fv", "qglVertex3fv", "qglVertex3fv", "qglEnd"]);
    // ...under the 1997 fixed black half-alpha colour
    expect(rec.calls.some((c) => c.name === "qglColor4f" && c.args[0] === 0 && c.args[1] === 0 && c.args[2] === 0 && c.args[3] === 0.5)).toBe(true);
  });

  test("gl_shaders 0 leaves the decal available: it is the only alias shadow that configuration can have", () => {
    const e = setupMd2Entity();
    glCvars.gl_shadows = makeCvar(1);
    glCvars.gl_shadowmaps = makeCvar(1); // still 1 -- but nothing can sample an atlas
    glCvars.gl_shaders = makeCvar(0);

    const rec = new QGLRecording();
    SetQGL(rec);
    R_DrawAliasModel(e);

    expect(drawBlocks(rec.calls).length).toBe(2);
  });

  test("an MD5-skinned model projects its OWN skeleton, not the MD2 path's stale s_lerped", () => {
    // Draw an MD2 model FIRST, so s_lerped holds that unrelated model's
    // vertices. Before the fix the MD5 model's decal projected exactly these.
    const stale = setupMd2Entity();
    glCvars.gl_shadows = makeCvar(0);
    SetQGL(new QGLRecording());
    R_DrawAliasModel(stale);

    // now an MD5 model at the same origin, with a deliberately distinctive
    // skeleton the MD2 above shares no coordinate with
    const skelPositions: [number, number, number][] = [
      [100, 0, 0],
      [0, 100, 0],
      [0, 0, 100],
    ];
    const model = new ModelT();
    model.name = "monster.md2";
    model.extradata = buildTestMd2();
    model.skeleton = makeSkeletonModel(skelPositions);
    const skin = new ImageT();
    skin.texnum = 7;
    model.skins[0] = skin;
    SetCurrentModel(model);

    const e = makeEntity(0);
    e.origin = vec3(0, 0, 40);
    SetCurrentEntity(e);

    glCvars.gl_shadows = makeCvar(1);
    glCvars.gl_shadowmaps = makeCvar(0);

    const rec = new QGLRecording();
    SetQGL(rec);
    R_DrawAliasModel(e);

    const blocks = drawBlocks(rec.calls);
    expect(blocks.length).toBe(2);
    const decal = blocks[1] ?? [];
    const vertexCalls = decal.filter((c) => c.name === "qglVertex3fv");
    expect(vertexCalls.length).toBe(3);

    // Both decal paths reuse one scratch `point` for every qglVertex3fv, the
    // way gl_mesh.c does; the real qgl reads it immediately, but QGLRecording
    // keeps the reference, so all three recorded args alias the LAST vertex.
    // That last vertex is still the discriminating one, so assert on it.
    const last = vertexArgAsTriplet(vertexCalls[2] as QGLCall);

    // GL_DrawAliasShadow's projection applied to the SKELETON's last position.
    // lightspot is (0,0,0) in this harness (no world model was ever loaded),
    // so lheight == origin[2] == 40 and height == -lheight + 1 == -39.
    // shadevector == normalize(cos(0), sin(0), 1) == (1,0,1)/sqrt(2).
    const s = 1 / Math.SQRT2;
    const p = skelPositions[2];
    expect(last[0]).toBeCloseTo(p[0] - s * (p[2] + 40), 3);
    expect(last[1]).toBeCloseTo(p[1], 3);
    expect(last[2]).toBeCloseTo(-39, 3);

    // ...and it is NOT what the MD2 glcmds path would have produced from the
    // stale s_lerped the first draw left behind (that model's last strip
    // vertex is (10+7, 20+8, 30+9) before projection). This is the whole
    // point of the fix: the two values are nowhere near each other.
    const staleX = 17 - s * (39 + 40);
    expect(Math.abs(last[0] - staleX)).toBeGreaterThan(1);
  });
});
