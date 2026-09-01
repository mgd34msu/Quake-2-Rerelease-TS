/*
Cover for ref_gl's translucent-chain enqueue guard (src/ref_gl/gl_rsurf.ts's
R_RecursiveWorldNode and R_DrawInlineBModel), the GL twin of the ref_soft
fix already carried by r_rast.ts's R_RenderFace/R_RenderBmodelFace.

r_alpha_surfaces is a singly linked list threaded through each surface's own
`texturechain` field. Pushing a surface that is already on the list writes
`X.texturechain = <something already reachable from X>`, which closes the
list into a cycle, and R_DrawAlphaSurfaces's `for (s = ...; s; s =
s.texturechain)` then never terminates. Real retail data reaches that state:
an entity whose modelindex resolves to the world model makes
R_DrawInlineBModel walk the world's own surface list, and
R_RecursiveWorldNode has already queued those same surfaces this frame.
Vanilla C corrupts its list identically given the same data, so per rule 17
the port matches the original's observable, playable outcome (one push per
surface per frame) instead of reproducing a permanent freeze.

Self-sufficient per PORTING.md rule 13: the QGL fake, world model and frame
counters this suite reads are all installed in its own beforeEach.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, SURF_TRANS33 } from "../src/shared/q_shared";
import { PLANE_X } from "../src/qcommon/qfiles";
import { MsurfaceT, MtexinfoT, MnodeT, MleafT, ModelT, CONTENTS_NODE } from "../src/ref_gl/gl_model";
import { SetWorldModel, SetVisFrameCount, SetFrameCount } from "../src/ref_gl/gl_local";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { R_RecursiveWorldNode, R_DrawAlphaSurfaces, r_alpha_surfaces } from "../src/ref_gl/gl_rsurf";

const VISFRAME = 11;
const FRAMECOUNT = 5;

function makeLeaf(): MleafT {
  const leaf = new MleafT();
  leaf.contents = 0;
  leaf.visframe = VISFRAME;
  leaf.area = 0;
  leaf.firstmarksurface = [];
  leaf.nummarksurfaces = 0;
  return leaf;
}

function makePlane(): CplaneT {
  const plane = new CplaneT();
  plane.type = PLANE_X;
  plane.normal = vec3(1, 0, 0);
  plane.dist = -10; // dot stays >= 0 whatever modelorg is
  return plane;
}

// every surface this suite hands to the renderer, so afterEach can cut any
// cycle before R_DrawAlphaSurfaces (whose own walk is unbounded, by design --
// see this file's header) drains the chain. Without this, a regression would
// hang the whole runner instead of failing one test.
const touched: MsurfaceT[] = [];

function makeTranslucentSurface(): MsurfaceT {
  const surf = new MsurfaceT();
  touched.push(surf);
  surf.flags = 0;
  surf.visframe = FRAMECOUNT;
  const texinfo = new MtexinfoT();
  texinfo.flags = SURF_TRANS33;
  surf.texinfo = texinfo;
  return surf;
}

// walk the chain with a hard step budget so a cycle fails the test instead
// of hanging the runner
function chainLength(head: MsurfaceT | null, budget: number): number {
  let n = 0;
  for (let s = head; s; s = s.texturechain) {
    n++;
    if (n > budget) return budget + 1;
  }
  return n;
}

beforeEach(() => {
  touched.length = 0;
  SetQGL(new QGLRecording());
  R_DrawAlphaSurfaces(); // clears r_alpha_surfaces whatever ran before
  SetVisFrameCount(VISFRAME);
  SetFrameCount(FRAMECOUNT);
});

afterEach(() => {
  for (const s of touched) s.texturechain = null;
  R_DrawAlphaSurfaces();
  SetWorldModel(null);
});

describe("gl_rsurf.ts -- r_alpha_surfaces stays acyclic when the same surface is reached twice in one frame", () => {
  test("a second R_RecursiveWorldNode pass over the same tree in the same frame does not re-queue", () => {
    const surf = makeTranslucentSurface();

    const model = new ModelT();
    model.surfaces = [surf];
    SetWorldModel(model);

    const root = new MnodeT();
    root.contents = CONTENTS_NODE;
    root.visframe = VISFRAME;
    root.plane = makePlane();
    root.children = [makeLeaf(), makeLeaf()];
    root.firstsurface = 0;
    root.numsurfaces = 1;

    R_RecursiveWorldNode(root);
    expect(r_alpha_surfaces).toBe(surf);
    expect(chainLength(r_alpha_surfaces, 8)).toBe(1);

    // the world-model-as-brush-entity case: the same surface comes back
    // around inside one frame
    R_RecursiveWorldNode(root);

    expect(chainLength(r_alpha_surfaces, 8)).toBe(1);
    expect(surf.texturechain).toBeNull();
  });

  test("the next frame queues it again -- the guard is per-frame, not permanent", () => {
    const surf = makeTranslucentSurface();

    const model = new ModelT();
    model.surfaces = [surf];
    SetWorldModel(model);

    const root = new MnodeT();
    root.contents = CONTENTS_NODE;
    root.visframe = VISFRAME;
    root.plane = makePlane();
    root.children = [makeLeaf(), makeLeaf()];
    root.firstsurface = 0;
    root.numsurfaces = 1;

    R_RecursiveWorldNode(root);
    expect(r_alpha_surfaces).toBe(surf);

    R_DrawAlphaSurfaces(); // end of frame: chain drained
    expect(r_alpha_surfaces).toBeNull();

    SetVisFrameCount(VISFRAME + 1);
    SetFrameCount(FRAMECOUNT + 1);
    root.visframe = VISFRAME + 1;
    surf.visframe = FRAMECOUNT + 1;

    R_RecursiveWorldNode(root);
    expect(r_alpha_surfaces).toBe(surf);
    expect(chainLength(r_alpha_surfaces, 8)).toBe(1);
  });

  test("two distinct surfaces still both land on the chain, front-to-back push order preserved", () => {
    const surfFront = makeTranslucentSurface();
    const surfBack = makeTranslucentSurface();

    const model = new ModelT();
    model.surfaces = [surfFront, surfBack];
    SetWorldModel(model);

    const frontNode = new MnodeT();
    frontNode.contents = CONTENTS_NODE;
    frontNode.visframe = VISFRAME;
    frontNode.plane = makePlane();
    frontNode.children = [makeLeaf(), makeLeaf()];
    frontNode.firstsurface = 0;
    frontNode.numsurfaces = 1;

    const backNode = new MnodeT();
    backNode.contents = CONTENTS_NODE;
    backNode.visframe = VISFRAME;
    backNode.plane = makePlane();
    backNode.children = [makeLeaf(), makeLeaf()];
    backNode.firstsurface = 1;
    backNode.numsurfaces = 1;

    const root = new MnodeT();
    root.contents = CONTENTS_NODE;
    root.visframe = VISFRAME;
    root.plane = makePlane();
    root.children = [frontNode, backNode];
    root.numsurfaces = 0;

    R_RecursiveWorldNode(root);

    expect(r_alpha_surfaces).toBe(surfBack);
    expect(surfBack.texturechain).toBe(surfFront);
    expect(surfFront.texturechain).toBeNull();
    expect(chainLength(r_alpha_surfaces, 8)).toBe(2);
  });
});
