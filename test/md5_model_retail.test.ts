/*
Byte-vector test for src/qcommon/md5_model.ts against the REAL retail MD5
data (~/q2rets/rerelease/baseq2/pak0.pak, id PACK format -- 412 files at
"models/<dir>/md5/tris.md5*"/"players/<dir>/md5/*.md5*", see md5_model.ts's
own header comment). No synthetic fixture: this test reads the real
.md5mesh/.md5anim/.md5scale bytes straight out of the shipping pak, exactly
like every other retail-gated test in this suite (gl_model_retail_qbsp_sweep
.test.ts's own header comment documents the same "raw node:fs PACK
extraction" convention, duplicated here per that file's own note that this
port has no shared PAK reader to import instead).

Self-sufficient per rule 13: this file reads its own retail data and does
not depend on any other test having run first. Skips cleanly (with a loud
message) if the retail install isn't present on this machine.

Two real models:

  - models/items/ammo/bullets/medium/md5/tris.md5{mesh,anim}: the smallest
    real MD5 pair in the retail data (1 joint, 14 verts, 14 weights, 1
    frame) -- small enough that the frame-0 skinned vertex positions for
    two of its vertices are HAND-VERIFIED below (independently worked out
    from the file's own joint orientation and weight data, not just
    round-tripped through this module's own code -- see the comment above
    those two expect() calls for the arithmetic).

  - models/monsters/infantry/md5/tris.md5{mesh,anim,scale}: a real animated
    monster (18 joints, 264 frames, numAnimatedComponents 108 == 18*6, every
    joint fully animated) whose real .md5scale sidecar zeroes joint 6
    ("Head", confirmed by reading the .md5anim's own "hierarchy" block) for
    frames 125-169 -- exercises the JSON scale-sidecar path end-to-end
    against real shipping data, not a synthetic scale file.
*/

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseMd5Mesh, parseMd5Anim, calcSkelVert, getSkeletonFrame, md5PathsFor } from "../src/qcommon/md5_model";
import { vec3 } from "../src/shared/math";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

interface PakEntry {
  name: string;
  filepos: number;
  filelen: number;
}

function readPakDirectory(pakPath: string): { data: Buffer; entries: PakEntry[] } {
  const data = readFileSync(pakPath);
  const entries: PakEntry[] = [];
  if (data.toString("ascii", 0, 4) === "PACK") {
    const dirofs = data.readInt32LE(4);
    const dirlen = data.readInt32LE(8);
    const numEntries = dirlen / 64;
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = dirofs + i * 64;
      const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
      const name = rawName.replace(/\0.*$/, "");
      const filepos = data.readInt32LE(entryOffset + 56);
      const filelen = data.readInt32LE(entryOffset + 60);
      entries.push({ name, filepos, filelen });
    }
  }
  return { data, entries };
}

const pak = havePak ? readPakDirectory(PAK_PATH) : null;

function readPakFile(name: string): string {
  if (!pak) throw new Error("pak not loaded");
  const entry = pak.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`${name} not found in ${PAK_PATH}`);
  return new TextDecoder().decode(new Uint8Array(pak.data.buffer, pak.data.byteOffset + entry.filepos, entry.filelen));
}

describe("md5_model.ts -- parser + CPU skinning against real retail MD5 data (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("file discovery matches the real pak0.pak layout ('md5/' subdirectory, not a bare sibling of tris.md2)", () => {
    const paths = md5PathsFor("models/items/ammo/bullets/medium/tris.md2");
    expect(paths.meshPath).toBe("models/items/ammo/bullets/medium/md5/tris.md5mesh");
    expect(paths.animPath).toBe("models/items/ammo/bullets/medium/md5/tris.md5anim");
    expect(paths.scalePath).toBe("models/items/ammo/bullets/medium/md5/tris.md5scale");
    expect(pak?.entries.some((e) => e.name === paths.meshPath)).toBe(true);
    expect(pak?.entries.some((e) => e.name === paths.animPath)).toBe(true);
  });

  test.skipIf(!havePak)("ammo box: joint/vertex/weight counts and hand-verified frame-0 vertex positions", () => {
    const meshPath = "models/items/ammo/bullets/medium/md5/tris.md5mesh";
    const animPath = "models/items/ammo/bullets/medium/md5/tris.md5anim";

    const model = parseMd5Mesh(readPakFile(meshPath), meshPath);
    expect(model.numJoints).toBe(1);
    expect(model.numMeshes).toBe(1);
    expect(model.meshes[0].numVerts).toBe(14);
    expect(model.meshes[0].numIndices).toBe(36); // numtris 12 * 3
    expect(model.meshes[0].numWeights).toBe(14);
    expect(model.meshes[0].shader).toBe("ammoBox.new");

    // real weight 0/1 data straight from the file, both bound entirely to
    // joint 0 with bias 1.0 -- a direct, uncomputed byte-vector check.
    expect(model.meshes[0].weights[0].bias).toBeCloseTo(1.0, 6);
    expect(model.meshes[0].weights[0].pos[0]).toBeCloseTo(-0.0054546287, 5);
    expect(model.meshes[0].weights[0].pos[1]).toBeCloseTo(4.0292606354, 5);
    expect(model.meshes[0].weights[0].pos[2]).toBeCloseTo(-8.0327367783, 5);
    expect(model.meshes[0].jointnums[0]).toBe(0);

    parseMd5Anim(readPakFile(animPath), animPath, model, null, (msg) => {
      throw new Error(`unexpected warning: ${msg}`);
    });
    expect(model.numFrames).toBe(1);
    expect(model.skeletonFrames.length).toBe(1);

    const skeleton = getSkeletonFrame(model, 0, 0, 0, 1);
    expect(skeleton.length).toBe(1);
    // joint orientation (-0.5, -0.5, 0.5, w) with w = -sqrt(1 - 0.25*3) = -0.5
    // (Quat_ComputeW negates the sqrt -- see md5_model.ts's own comment on
    // that sign) rotates to axis rows (0,1,0)/(0,0,-1)/(-1,0,0), a clean
    // permutation matrix -- hand-verified by direct substitution into
    // Quat_ToAxis's formula, not just re-derived from this module's own code.
    expect(skeleton[0].orient[3]).toBeCloseTo(-0.5, 5);
    expect(skeleton[0].axis[0][0]).toBeCloseTo(0, 5);
    expect(skeleton[0].axis[0][1]).toBeCloseTo(1, 5);
    expect(skeleton[0].axis[1][2]).toBeCloseTo(-1, 5);
    expect(skeleton[0].axis[2][0]).toBeCloseTo(-1, 5);

    const pos = vec3();
    const normal = vec3();
    // vertex 0's sole weight is weight 0 (pos above); with axis rows
    // (0,1,0)/(0,0,-1)/(-1,0,0) and joint.pos=(0,0,0), scale=1:
    //   VectorRotate(weight.pos, axis) = (dot(pos,row0), dot(pos,row1), dot(pos,row2))
    //     = (4.0292606354, 8.0327367783, 0.0054546287)
    // (calcSkelVert then adds joint.pos*scale = 0 and multiplies by bias 1.0,
    // so this IS the final skinned position -- see md5_model.ts's calcSkelVert.)
    calcSkelVert(model.meshes[0].vertices[0], model.meshes[0], skeleton, pos, normal);
    expect(pos[0]).toBeCloseTo(4.0292606354, 3);
    expect(pos[1]).toBeCloseTo(8.0327367783, 3);
    expect(pos[2]).toBeCloseTo(0.0054546287, 3);

    // vertex 1 (weight 1, pos (-0.0054562907, 4.0292644501, 8.0536642075)):
    //   = (4.0292644501, -8.0536642075, 0.0054562907)
    calcSkelVert(model.meshes[0].vertices[1], model.meshes[0], skeleton, pos, normal);
    expect(pos[0]).toBeCloseTo(4.0292644501, 3);
    expect(pos[1]).toBeCloseTo(-8.0536642075, 3);
    expect(pos[2]).toBeCloseTo(0.0054562907, 3);
  });

  test.skipIf(!havePak)("infantry: real animated monster (18 joints, 264 frames) plus real .md5scale sidecar", () => {
    const meshPath = "models/monsters/infantry/md5/tris.md5mesh";
    const animPath = "models/monsters/infantry/md5/tris.md5anim";
    const scalePath = "models/monsters/infantry/md5/tris.md5scale";

    const model = parseMd5Mesh(readPakFile(meshPath), meshPath);
    expect(model.numJoints).toBe(18);
    expect(model.numMeshes).toBe(1);
    expect(model.meshes[0].numVerts).toBeGreaterThan(0);
    expect(model.meshes[0].numWeights).toBeGreaterThan(0);

    const warnings: string[] = [];
    parseMd5Anim(readPakFile(animPath), animPath, model, { text: readPakFile(scalePath), path: scalePath }, (msg) => warnings.push(msg));

    expect(model.numFrames).toBe(264);
    expect(model.skeletonFrames.length).toBe(264 * 18);
    // "Head" is joint index 6 in the real .md5anim's hierarchy block
    // ("Root" 0, "Abdomen" 1, "R_UpperLeg" 2, "R_LowerLeg" 3, "R_Foot" 4,
    // "Chest" 5, "Head" 6, ...) -- the real tris.md5scale zeroes its scale
    // for frames 125-169 (no "scale_positions" key present, confirmed by
    // reading the file directly) and leaves every other frame at the 1.0
    // default this module initializes every joint/frame to.
    const headJoint = 6;
    expect(model.skeletonFrames[124 * model.numJoints + headJoint].scale).toBeCloseTo(1.0, 6);
    expect(model.skeletonFrames[125 * model.numJoints + headJoint].scale).toBeCloseTo(0.0, 6);
    expect(model.skeletonFrames[169 * model.numJoints + headJoint].scale).toBeCloseTo(0.0, 6);
    expect(model.skeletonFrames[170 * model.numJoints + headJoint].scale).toBeCloseTo(1.0, 6);
    // no unresolved joint names in the real scale file for this model
    expect(warnings.filter((w) => w.startsWith("No such joint"))).toEqual([]);

    // frame-0 vertex set: every vertex of every mesh produces a finite,
    // non-degenerate position (a real regression guard -- any future change
    // to calcSkelVert/getSkeletonFrame/buildFrameSkeleton that introduces a
    // NaN/undefined-weight bug on real weighted, multi-joint retail data
    // would trip this).
    const skeleton = getSkeletonFrame(model, 0, 0, 0, 1);
    expect(skeleton.length).toBe(18);
    const pos = vec3();
    for (const mesh of model.meshes) {
      for (const vert of mesh.vertices) {
        calcSkelVert(vert, mesh, skeleton, pos, null);
        expect(Number.isFinite(pos[0])).toBe(true);
        expect(Number.isFinite(pos[1])).toBe(true);
        expect(Number.isFinite(pos[2])).toBe(true);
      }
    }
  });

  test.skipIf(havePak)("SKIPPED: retail data not found -- set up ~/q2rets/rerelease/baseq2/pak0.pak to run md5_model.ts's byte-vector tests", () => {
    expect(havePak).toBe(false);
  });
});
