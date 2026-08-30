import { describe, expect, test, beforeAll } from "bun:test";
import { CM_InitBoxHull, CM_HeadnodeForBox, CM_BoxTrace, CM_PointContents, CM_TransformedBoxTrace, CM_MarkMapLoadedForTesting } from "../src/qcommon/cmodel";
import { CONTENTS_MONSTER } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";

// These tests exercise the box-hull path only, without loading a BSP file.
// CM_InitBoxHull normally runs at the end of CM_LoadMap, after a real BSP's
// planes/nodes/leafs/brushes have already been loaded. Calling it standalone
// (no BSP) is exactly what this unit's C code allows: every module-level
// count it reads (numnodes/numplanes/numleafs/numbrushes/numbrushsides/
// numleafbrushes) simply keeps its process-start default (0, or 1 for
// numleafs/numareas/numclusters).
//
// One further wrinkle: CM_PointContents and CM_BoxTrace both gate on
// `if (!numnodes) return ...` ("map not loaded"), and CM_InitBoxHull never
// increments numnodes -- in real gameplay that guard is always already open
// because a real map's CMod_LoadNodes call set numnodes first. There is no
// BSP-free way to open it from the public C API (CM_LoadMap's own map-free
// path returns before calling CM_InitBoxHull at all), so cmodel.ts exports
// CM_MarkMapLoadedForTesting() for exactly this: it sets the same "a map is
// loaded" state a real CMod_LoadNodes call would have set, without touching
// any of the ported functions' real logic. See its doc comment in cmodel.ts.
beforeAll(() => {
  CM_MarkMapLoadedForTesting();
  CM_InitBoxHull();
});

describe("CM_HeadnodeForBox / box hull tracing", () => {
  test("CM_HeadnodeForBox returns the box hull's head node for a unit box", () => {
    const mins = vec3(-1, -1, -1);
    const maxs = vec3(1, 1, 1);
    const headnode = CM_HeadnodeForBox(mins, maxs);
    expect(typeof headnode).toBe("number");
    expect(headnode).toBeGreaterThanOrEqual(0);
  });

  test("a ray starting outside and ending inside the box hits with fraction < 1 and a sensible plane normal", () => {
    const mins = vec3(-1, -1, -1);
    const maxs = vec3(1, 1, 1);
    const headnode = CM_HeadnodeForBox(mins, maxs);

    const start = vec3(-10, 0, 0);
    const end = vec3(0, 0, 0); // ends at the box center, inside the hull
    const trace = CM_BoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), headnode, -1 /* MASK_ALL */);

    expect(trace.fraction).toBeLessThan(1);
    expect(trace.fraction).toBeGreaterThan(0);
    // the ray travels in +X, so it should hit the -X face, whose outward
    // normal is (-1, 0, 0)
    expect(trace.plane.normal[0]).toBeCloseTo(-1, 5);
    expect(trace.plane.normal[1]).toBeCloseTo(0, 5);
    expect(trace.plane.normal[2]).toBeCloseTo(0, 5);
  });

  test("a ray that misses the box entirely reports fraction == 1", () => {
    const mins = vec3(-1, -1, -1);
    const maxs = vec3(1, 1, 1);
    const headnode = CM_HeadnodeForBox(mins, maxs);

    const start = vec3(-10, 10, 10);
    const end = vec3(10, 10, 10); // passes well above/beside the box
    const trace = CM_BoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), headnode, -1);

    expect(trace.fraction).toBe(1);
  });

  test("CM_PointContents inside the box hull returns CONTENTS_MONSTER", () => {
    const mins = vec3(-1, -1, -1);
    const maxs = vec3(1, 1, 1);
    const headnode = CM_HeadnodeForBox(mins, maxs);

    // CM_InitBoxHull sets box_leaf.contents = CONTENTS_MONSTER (see
    // cmodel.c/cmodel.ts) -- a point that lands in the box hull's leaf
    // reports that contents value, not CONTENTS_SOLID.
    const contents = CM_PointContents(vec3(0, 0, 0), headnode);
    expect(contents).toBe(CONTENTS_MONSTER);
  });

  test("CM_TransformedBoxTrace with a 90-degree rotation hits a translated box correctly", () => {
    const mins = vec3(-1, -1, -1);
    const maxs = vec3(1, 1, 1);
    const headnode = CM_HeadnodeForBox(mins, maxs);

    // box hull is axis-aligned around the origin in its own model space;
    // place it at origin (5, 0, 0) in world space, and rotate the model 90
    // degrees around yaw. A 90-degree yaw rotation of an axis-aligned box is
    // itself axis-aligned, so the box still occupies world-space
    // [4,6]x[-1,1]x[-1,1] after the transform.
    const origin = vec3(5, 0, 0);
    const angles = vec3(0, 90, 0);

    const start = vec3(0, 0, 0);
    const end = vec3(10, 0, 0);

    const trace = CM_TransformedBoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), headnode, -1, origin, angles);

    expect(trace.fraction).toBeLessThan(1);
    // entry point should be at world x == 4 (the near face of the translated
    // box), within DIST_EPSILON (1/32, see cmodel.ts): CM_ClipBoxToBrush
    // deliberately stops fractionally short of the surface ("put the
    // crosspoint DIST_EPSILON pixels on the near side").
    expect(trace.endpos[0]).toBeGreaterThan(4 - 0.0625);
    expect(trace.endpos[0]).toBeLessThanOrEqual(4);
    expect(trace.endpos[1]).toBeCloseTo(0, 4);
    expect(trace.endpos[2]).toBeCloseTo(0, 4);
  });

  test("a ray that misses the rotated, translated box reports fraction == 1", () => {
    const mins = vec3(-1, -1, -1);
    const maxs = vec3(1, 1, 1);
    const headnode = CM_HeadnodeForBox(mins, maxs);

    const origin = vec3(5, 0, 0);
    const angles = vec3(0, 90, 0);

    const start = vec3(0, 10, 0);
    const end = vec3(10, 10, 0); // passes well above the translated box

    const trace = CM_TransformedBoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), headnode, -1, origin, angles);

    expect(trace.fraction).toBe(1);
  });
});
