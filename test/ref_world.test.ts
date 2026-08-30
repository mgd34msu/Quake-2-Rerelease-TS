/*
Tests for src/ref_soft/r_bsp.ts, r_rast.ts, r_light.ts, per this unit's
brief (rule 13): self-sufficient, no reliance on any other test file having
run first. Each test sets up exactly the shared module state it reads.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT } from "../src/shared/q_shared";
import { PLANE_X } from "../src/qcommon/qfiles";
import type { DlightT } from "../src/client/ref";
import { MnodeT, MleafT, MsurfaceT, ModelT, CONTENTS_NODE } from "../src/ref_soft/r_model";
import { SetVisFrameCount, modelorg, r_drawsurf, rCvars, type ClipplaneT } from "../src/ref_soft/r_local";
import { R_ClipEdge, r_leftenter, rKey } from "../src/ref_soft/r_rast";
import { R_RecursiveWorldNode, c_drawnode, setWorldModelForTesting } from "../src/ref_soft/r_bsp";
import { R_MarkLights, R_BuildLightMap, blocklights } from "../src/ref_soft/r_light";

beforeEach(() => {
  rKey.current = 0;
  rKey.currentB = 0;
  modelorg[0] = 0;
  modelorg[1] = 0;
  modelorg[2] = 0;
});

describe("r_rast.ts -- R_ClipEdge", () => {
  test("clips a world-space edge against a single fabricated clip plane and lands on the hand-computed intersection point", () => {
    // plane: x = 5 (normal (1,0,0), dist 5), leftedge so the clip result
    // lands in r_leftenter/r_leftexit.
    const clip: ClipplaneT = {
      normal: vec3(1, 0, 0),
      dist: 5,
      next: null,
      leftedge: 1,
      rightedge: 0,
    };

    const pv0 = { position: vec3(0, 0, 0) };
    const pv1 = { position: vec3(10, 0, 0) };

    // d0 = 0*1 - 5 = -5 (clipped), d1 = 10*1 - 5 = 5 (unclipped) -> point 0
    // is the clipped one; f = d0/(d0-d1) = -5/-10 = 0.5, so the plane
    // crosses the edge at x = 0 + 0.5*(10-0) = 5.
    R_ClipEdge(pv0, pv1, clip);

    expect(r_leftenter.position[0]).toBeCloseTo(5, 5);
    expect(r_leftenter.position[1]).toBeCloseTo(0, 5);
    expect(r_leftenter.position[2]).toBeCloseTo(0, 5);
  });
});

describe("r_bsp.ts -- R_RecursiveWorldNode", () => {
  test("visits a fabricated node/leaf tree front-to-back from the viewpoint", () => {
    // rule 13: the frame-render suite advances the shared visframecount;
    // pin it so the fabricated tree's visframe=0 fields mean "not visited".
    SetVisFrameCount(0);
    const root = new MnodeT();
    root.contents = CONTENTS_NODE;
    root.visframe = 0;
    root.plane = new CplaneT();
    root.plane.normal = vec3(1, 0, 0);
    root.plane.dist = 0;
    root.plane.type = PLANE_X;
    root.numsurfaces = 0;

    const frontLeaf = new MleafT();
    frontLeaf.contents = 0; // a non-solid leaf
    frontLeaf.visframe = 0;
    frontLeaf.area = 0;
    frontLeaf.firstmarksurface = [];
    frontLeaf.nummarksurfaces = 0;

    const backLeaf = new MleafT();
    backLeaf.contents = 0;
    backLeaf.visframe = 0;
    backLeaf.area = 0;
    backLeaf.firstmarksurface = [];
    backLeaf.nummarksurfaces = 0;

    root.children = [frontLeaf, backLeaf];

    // viewpoint at x = 5 is on the positive side of the x=0 split plane,
    // so children[0] (front) must be visited before children[1] (back).
    modelorg[0] = 5;

    R_RecursiveWorldNode(root, 0);

    expect(frontLeaf.key).toBe(0);
    expect(backLeaf.key).toBe(1);
    expect(frontLeaf.key).toBeLessThan(backLeaf.key);
    expect(c_drawnode).toBeGreaterThan(0);
  });
});

describe("r_light.ts -- R_MarkLights", () => {
  test("marks surfaces on a fabricated 2-surface node when within the dlight radius, and skips it when beyond radius", () => {
    const root = new MnodeT();
    root.contents = CONTENTS_NODE;
    root.plane = new CplaneT();
    root.plane.normal = vec3(0, 0, 1);
    root.plane.dist = 0;
    root.firstsurface = 0;
    root.numsurfaces = 2;
    // real leaf children (contents !== CONTENTS_NODE) so recursion into
    // them terminates immediately, matching R_MarkLights's own
    // `if (node->contents != -1) return;` guard.
    root.children = [new MleafT(), new MleafT()];

    const surf0 = new MsurfaceT();
    const surf1 = new MsurfaceT();

    const fakeWorldModel = new ModelT();
    fakeWorldModel.surfaces = [surf0, surf1];
    setWorldModelForTesting(fakeWorldModel);

    // dist = DotProduct(origin, normal) - planeDist = 50; within intensity 100.
    const nearLight: DlightT = { origin: vec3(0, 0, 50), color: vec3(1, 1, 1), intensity: 100 };
    R_MarkLights(nearLight, 1, root);

    expect(surf0.dlightbits & 1).toBe(1);
    expect(surf1.dlightbits & 1).toBe(1);

    // dist = 500, well beyond intensity 100 -> this node's surfaces must
    // not pick up bit 2 (R_MarkLights recurses into the near child only).
    const farLight: DlightT = { origin: vec3(0, 0, 500), color: vec3(1, 1, 1), intensity: 100 };
    R_MarkLights(farLight, 2, root);

    expect(surf0.dlightbits & 2).toBe(0);
    expect(surf1.dlightbits & 2).toBe(0);

    setWorldModelForTesting(null);
  });
});

describe("r_light.ts -- R_BuildLightMap", () => {
  test("combines two lightstyles' lightmap bytes per the C scaling into blocklights", () => {
    const surf = new MsurfaceT();
    surf.extents = [0, 0]; // smax = tmax = 1, size = 1 texel
    surf.styles = [0, 1, 255, 255];
    surf.samples = new Uint8Array([100, 50]); // style 0 byte, then style 1 byte
    surf.dlightframe = -1; // != r_framecount(0), so R_AddDynamicLights is skipped

    r_drawsurf.surf = surf;
    r_drawsurf.lightadj = [200, 128, 0, 0]; // 8.8-fraction scales for styles 0 and 1

    const fakeModel = new ModelT();
    fakeModel.lightdata = new Uint8Array([1]); // just needs to be non-null

    rCvars.r_fullbright = null;
    setWorldModelForTesting(fakeModel);

    R_BuildLightMap();

    // raw = 100*200 + 50*128 = 26400
    // t = (255*256 - 26400) >> (8 - VID_CBITS=6) = 38880 >> 2 = 9720
    expect(blocklights[0]).toBe(9720);

    setWorldModelForTesting(null);
  });
});
