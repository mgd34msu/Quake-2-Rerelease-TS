/*
Integration test: QBSP extended-format support in src/qcommon/cmodel.ts
(CM_LoadMap's ident dispatch, the CMod_Load*Ext functions, CM_ClusterPVS's
no-vis guard). Ports q2repro's dual-format lump table (bsp.c bsp_lumps[]) --
see cmodel.ts's own CM_LoadMap comment for the exact load-order rationale.

No copyrighted map data: uses test/support/bsp_builder.ts's synthetic
box-room fixture, built once in the classic (IBSP) format and once in the
QBSP extended format, and asserts they produce IDENTICAL observable
behavior (same checksum-independent trace/containment results) -- proving
the extended loader is a faithful parallel path, not just "doesn't throw".
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap, CM_NumInlineModels, CM_EntityString, CM_PointContents, CM_BoxTrace, CM_ClusterPVS, CM_ClusterPHS, CM_NumClusters } from "../src/qcommon/cmodel";
import { CONTENTS_SOLID } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { buildBoxRoomBsp, buildBoxRoomBspQbsp, ROOM_HALF } from "./support/bsp_builder";

describe("cmodel.ts -- QBSP extended-format dual-format support", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2cm-qbsp-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);

    writeFileSync(join(mapsDir, "classicroom.bsp"), buildBoxRoomBsp());
    writeFileSync(join(mapsDir, "qbsproom.bsp"), buildBoxRoomBspQbsp());

    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("a QBSP map loads with a nonzero checksum, one inline model, and a worldspawn entity string", () => {
    const { checksum } = CM_LoadMap("maps/qbsproom.bsp", false);
    expect(checksum).not.toBe(0);
    expect(CM_NumInlineModels()).toBeGreaterThanOrEqual(1);
    expect(CM_EntityString()).toContain("worldspawn");
  });

  test("QBSP room center is empty, well outside the walls is solid -- identical to the classic-format room", () => {
    const classic = CM_LoadMap("maps/classicroom.bsp", false);
    const classicCenter = CM_PointContents(vec3(0, 0, 0), classic.model.headnode);
    const classicOutside = CM_PointContents(vec3(ROOM_HALF + 36, 0, 0), classic.model.headnode);

    const qbsp = CM_LoadMap("maps/qbsproom.bsp", false);
    const qbspCenter = CM_PointContents(vec3(0, 0, 0), qbsp.model.headnode);
    const qbspOutside = CM_PointContents(vec3(ROOM_HALF + 36, 0, 0), qbsp.model.headnode);

    expect(qbspCenter).toBe(classicCenter);
    expect(qbspCenter).toBe(0);
    expect(qbspOutside).toBe(classicOutside);
    expect(qbspOutside).toBe(CONTENTS_SOLID);
  });

  test("a trace from the center into a wall stops short with a plane normal pointing back at the start -- identical between formats", () => {
    const classic = CM_LoadMap("maps/classicroom.bsp", false);
    const start = vec3(0, 0, 0);
    const end = vec3(ROOM_HALF + 36, 0, 0);
    const classicTrace = CM_BoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), classic.model.headnode, CONTENTS_SOLID);

    const qbsp = CM_LoadMap("maps/qbsproom.bsp", false);
    const qbspTrace = CM_BoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), qbsp.model.headnode, CONTENTS_SOLID);

    expect(qbspTrace.fraction).toBeLessThan(1);
    expect(qbspTrace.plane.normal[0]).toBeLessThan(0);
    expect(qbspTrace.fraction).toBeCloseTo(classicTrace.fraction, 6);
    expect(qbspTrace.plane.normal[0]).toBeCloseTo(classicTrace.plane.normal[0], 6);
  });

  test("CM_ClusterPVS/PHS no-vis guard: a map with no Visibility lump reports every cluster visible (bsp.c's BSP_ClusterVis 'no vis => all-visible' fallback)", () => {
    // this fixture's Visibility lump is empty (see bsp_builder.ts), so
    // map_has_vis is false for both formats -- CM_ClusterPVS/PHS must fall
    // back to an all-0xff row instead of reading past the (zero-length)
    // vis buffer.
    CM_LoadMap("maps/qbsproom.bsp", false);
    const pvs = CM_ClusterPVS(0);
    const phs = CM_ClusterPHS(0);
    expect(Array.from(pvs.subarray(0, 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(Array.from(phs.subarray(0, 4))).toEqual([0xff, 0xff, 0xff, 0xff]);

    CM_LoadMap("maps/classicroom.bsp", false);
    const classicPvs = CM_ClusterPVS(0);
    expect(Array.from(classicPvs.subarray(0, 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  test("cluster count on a no-vis fixture: classic scans leaf clusters defensively, QBSP takes the Visibility header's count directly (a genuine, intentional divergence -- see CMod_LoadLeafsExt's own comment, ported from bsp.c)", () => {
    CM_LoadMap("maps/classicroom.bsp", false);
    // classic CMod_LoadLeafs derives numclusters by scanning every leaf's
    // own cluster field (max cluster + 1) -- this fixture's one non-solid
    // leaf carries cluster 0, so numclusters comes out to 1.
    expect(CM_NumClusters()).toBe(1);

    CM_LoadMap("maps/qbsproom.bsp", false);
    // CMod_LoadLeafsExt instead reads numclusters straight from the
    // Visibility lump's own header (bsp.c: bsp->vis->numclusters) when a vis
    // lump is present, or 0 when it isn't (map_has_vis === false here, since
    // this fixture's Visibility lump is empty) -- it never falls back to
    // scanning leaf cluster fields the way the classic loader does.
    expect(CM_NumClusters()).toBe(0);
  });

  test("an unrecognized BSP ident (not IBSP or QBSP) is rejected", () => {
    const bad = buildBoxRoomBspQbsp();
    const view = new DataView(bad.buffer);
    view.setInt32(0, 0x50534258, true); // 'XBSP', not a recognized ident
    writeFileSync(join(tmpRoot, "baseq2", "maps", "badident.bsp"), bad);
    expect(() => CM_LoadMap("maps/badident.bsp", false)).toThrow();
  });
});
