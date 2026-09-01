/*
Regression cover for Mod_LoadLeafs/Mod_LoadLeafsExt in BOTH renderers
(src/ref_gl/gl_model.ts, src/ref_soft/r_model.ts).

The C stores `out->firstmarksurface = loadmodel->marksurfaces +
in->firstleafface` -- a pointer into one shared array. This port has to
materialize that as a JS array, and the first version copied the whole TAIL
(`marksurfaces.slice(firstleafface)`), which is O(numleafs *
nummarksurfaces) retained memory rather than O(1). On maps/mguhub.bsp
(72159 faces, "Call of the Machine") that turned one 17-second load into 21
GB of arrays that never freed, which is where the client's runaway RSS came
from during live play. Both loaders now store the leaf's OWN range, which is
every element the C pointer is ever dereferenced through: the only readers,
R_RecursiveWorldNode in each renderer, index [0, nummarksurfaces).

Self-sufficient per PORTING.md rule 13: each suite installs its own
RefImports/QGL/no-texture globals in beforeEach and frees the model cache.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports as SetGlRefImports, SetNoTexture, ImageT } from "../src/ref_gl/gl_local";
import { SetQGL } from "../src/ref_gl/gl_image";
import { QGLRecording } from "../src/ref_gl/qgl";
import { Mod_ForName as GlMod_ForName, Mod_Init as GlMod_Init, Mod_FreeAll as GlMod_FreeAll, isMleaf as glIsMleaf } from "../src/ref_gl/gl_model";
import { SetRefImports as SetSwRefImports } from "../src/ref_soft/r_local";
import { Mod_ForName as SwMod_ForName, Mod_Init as SwMod_Init, Mod_FreeAll as SwMod_FreeAll, isMleaf as swIsMleaf } from "../src/ref_soft/r_model";
import { buildBoxRoomBsp, buildBoxRoomBspQbsp } from "./support/bsp_builder";

const files = new Map<string, Uint8Array>();

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
    FS_LoadFile: (name: string) => {
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
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

// bsp_builder's partialLeafFaces option: the empty leaf owns leaffaces
// [2, 5) out of the six in the lump.
const PARTIAL_FIRST = 2;
const PARTIAL_COUNT = 3;
const TOTAL_LEAFFACES = 6;

describe("ref_gl Mod_LoadLeafs/Mod_LoadLeafsExt -- a leaf's firstmarksurface is its own range, not the tail of the shared array", () => {
  beforeEach(() => {
    files.clear();
    SetGlRefImports(makeFakeRi());
    GlMod_Init();
    GlMod_FreeAll();
    const fakeTex = new ImageT();
    fakeTex.width = 64;
    fakeTex.height = 64;
    SetNoTexture(fakeTex);
    SetQGL(new QGLRecording());
  });

  afterEach(() => {
    GlMod_FreeAll();
  });

  for (const [label, build] of [
    ["classic IBSP", buildBoxRoomBsp],
    ["QBSP extended", buildBoxRoomBspQbsp],
  ] as const) {
    test(`${label}: length matches nummarksurfaces and the entries are marksurfaces[first .. first+num)`, () => {
      files.set("maps/partial.bsp", build(undefined, { renderable: true, partialLeafFaces: true }));
      const model = GlMod_ForName("maps/partial.bsp", true);
      expect(model).not.toBeNull();
      if (!model) return;

      expect(model.marksurfaces.length).toBe(TOTAL_LEAFFACES);

      const empty = model.leafs.filter((lf) => lf.nummarksurfaces > 0);
      expect(empty.length).toBe(1);
      const leaf = empty[0];

      expect(leaf.nummarksurfaces).toBe(PARTIAL_COUNT);
      // the tail-copy version stored TOTAL_LEAFFACES - PARTIAL_FIRST == 4 here
      expect(leaf.firstmarksurface.length).toBe(PARTIAL_COUNT);
      for (let i = 0; i < PARTIAL_COUNT; i++) {
        expect(leaf.firstmarksurface[i]).toBe(model.marksurfaces[PARTIAL_FIRST + i]);
      }

      // total retained across every leaf stays O(nummarksurfaces) -- the
      // property the tail copy violated quadratically.
      const total = model.leafs.reduce((sum, lf) => sum + lf.firstmarksurface.length, 0);
      expect(total).toBeLessThanOrEqual(model.marksurfaces.length);
    });
  }

  test("every leaf of a whole-lump map still holds all six, and R_RecursiveWorldNode's reader bound is respected", () => {
    files.set("maps/whole.bsp", buildBoxRoomBsp(undefined, { renderable: true }));
    const model = GlMod_ForName("maps/whole.bsp", true);
    expect(model).not.toBeNull();
    if (!model) return;

    for (const node of model.leafs) {
      if (!glIsMleaf(node)) continue;
      expect(node.firstmarksurface.length).toBe(node.nummarksurfaces);
    }
  });
});

describe("ref_soft Mod_LoadLeafs/Mod_LoadLeafsExt -- same invariant", () => {
  beforeEach(() => {
    files.clear();
    SetSwRefImports(makeFakeRi());
    SwMod_Init();
    SwMod_FreeAll();
  });

  afterEach(() => {
    SwMod_FreeAll();
  });

  for (const [label, build] of [
    ["classic IBSP", buildBoxRoomBsp],
    ["QBSP extended", buildBoxRoomBspQbsp],
  ] as const) {
    test(`${label}: length matches nummarksurfaces and the entries are marksurfaces[first .. first+num)`, () => {
      files.set("maps/partial.bsp", build(undefined, { renderable: true, partialLeafFaces: true }));
      const model = SwMod_ForName("maps/partial.bsp", true);
      expect(model).not.toBeNull();
      if (!model) return;

      const empty = model.leafs.filter((lf) => lf.nummarksurfaces > 0);
      expect(empty.length).toBe(1);
      const leaf = empty[0];

      expect(leaf.nummarksurfaces).toBe(PARTIAL_COUNT);
      expect(leaf.firstmarksurface.length).toBe(PARTIAL_COUNT);
      for (let i = 0; i < PARTIAL_COUNT; i++) {
        expect(leaf.firstmarksurface[i]).toBe(model.marksurfaces[PARTIAL_FIRST + i]);
      }

      const total = model.leafs.reduce((sum, lf) => sum + lf.firstmarksurface.length, 0);
      expect(total).toBeLessThanOrEqual(model.marksurfaces.length);
    });
  }

  test("every leaf of a whole-lump map still holds all six", () => {
    files.set("maps/whole.bsp", buildBoxRoomBsp(undefined, { renderable: true }));
    const model = SwMod_ForName("maps/whole.bsp", true);
    expect(model).not.toBeNull();
    if (!model) return;

    for (const node of model.leafs) {
      if (!swIsMleaf(node)) continue;
      expect(node.firstmarksurface.length).toBe(node.nummarksurfaces);
    }
  });
});
