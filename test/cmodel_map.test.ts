/*
Integration test: loads a synthetic BSP (built by test/support/bsp_builder.ts,
no copyrighted map data) through the real CM_LoadMap and exercises point
containment and box tracing against it.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap, CM_NumInlineModels, CM_EntityString, CM_PointContents, CM_BoxTrace } from "../src/qcommon/cmodel";
import { CONTENTS_SOLID } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { buildBoxRoomBsp, ROOM_HALF } from "./support/bsp_builder";

describe("cmodel.ts -- CM_LoadMap against a synthetic box-room BSP", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2cm-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);

    writeFileSync(join(mapsDir, "testroom.bsp"), buildBoxRoomBsp());

    // bypass CVAR_NOSET the way an early "+set basedir ..." would (see
    // test/files.test.ts for the same pattern)
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("loads and reports a nonzero checksum, one inline model, and a worldspawn entity string", () => {
    const { checksum } = CM_LoadMap("maps/testroom.bsp", false);
    expect(checksum).not.toBe(0);
    expect(CM_NumInlineModels()).toBeGreaterThanOrEqual(1);
    expect(CM_EntityString()).toContain("worldspawn");
  });

  test("room center is empty, well outside the walls is solid", () => {
    const { model } = CM_LoadMap("maps/testroom.bsp", false);
    expect(CM_PointContents(vec3(0, 0, 0), model.headnode)).toBe(0);
    expect(CM_PointContents(vec3(ROOM_HALF + 36, 0, 0), model.headnode)).toBe(CONTENTS_SOLID);
  });

  test("a trace from the center into a wall stops short with a plane normal pointing back at the start", () => {
    const { model } = CM_LoadMap("maps/testroom.bsp", false);
    const start = vec3(0, 0, 0);
    const end = vec3(ROOM_HALF + 36, 0, 0);
    const trace = CM_BoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), model.headnode, CONTENTS_SOLID);

    expect(trace.fraction).toBeLessThan(1);
    expect(trace.plane.normal[0]).toBeLessThan(0); // points back toward start (-X)
    expect(trace.plane.normal[1]).toBe(0);
    expect(trace.plane.normal[2]).toBe(0);
  });

  test("a trace between two interior points is unobstructed (fraction 1)", () => {
    const { model } = CM_LoadMap("maps/testroom.bsp", false);
    const start = vec3(-30, 0, 0);
    const end = vec3(30, 0, 0);
    const trace = CM_BoxTrace(start, end, vec3(0, 0, 0), vec3(0, 0, 0), model.headnode, CONTENTS_SOLID);

    expect(trace.fraction).toBe(1);
  });
});
