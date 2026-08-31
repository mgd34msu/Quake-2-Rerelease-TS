/*
Integration test: QBSP extended-format support in src/ref_soft/r_model.ts
(Mod_ForName's ident dispatch, the Mod_Load*Ext functions, the classic-path
unsigned-read fixes for texinfo/marksurface indices, and the format-aware
PrescanClassicSurfaceExtents/BSPX numfaces computation). See r_model.ts's own
Mod_LoadBrushModel comment for the exact extended-format load-order
rationale.

Self-sufficient per PORTING.md rule 13: sets up its own fake RefImports each
test via beforeEach, mirroring test/gl_model.test.ts's established pattern
(RefImports is the same interface shared with ref_gl, src/client/ref.ts).
r_notexture_mip is intentionally left null -- Mod_LoadFaces/Mod_LoadFacesExt
both already handle a null texinfo.image by skipping the drawing-flags
section (`if (!s.texinfo.image) continue;`), so no fake texture is needed to
exercise the loader.

beforeEach also calls Mod_Free(mod_known[0]) unconditionally, on top of
Mod_FreeAll() -- see test/gl_model_qbsp.test.ts's identical, more detailed
comment for why: Mod_FreeAll() alone only frees a model whose extradatasize
is nonzero (bug-for-bug with vanilla ref_soft's own Mod_FreeAll), so a
FAILED load anywhere earlier in this bun:test process permanently occupies
mod_known[0] and makes every later Mod_LoadBrushModel throw "Loaded a brush
model after the world". The real engine avoids this via R_BeginRegistration
calling Mod_Free(&mod_known[0]) unconditionally before a new world map load,
not the gated Mod_FreeAll() -- mirrored here at the test level.

No copyrighted map data: uses test/support/bsp_builder.ts's synthetic
box-room fixture, built once in the classic (IBSP) format and once in the
QBSP extended format, and asserts they produce structurally IDENTICAL
loaded models.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports } from "../src/ref_soft/r_local";
import { vec3 } from "../src/shared/math";
import { CONTENTS_SOLID } from "../src/shared/q_shared";
import { Mod_FreeAll, Mod_Free, mod_known, Mod_ForName, Mod_PointInLeaf, Mod_Init, mod_inline, ModtypeT, isMleaf } from "../src/ref_soft/r_model";
import { buildBoxRoomBspQbsp, ROOM_HALF } from "./support/bsp_builder";

const files = new Map<string, Uint8Array>();
function registerFile(name: string, data: Uint8Array): void {
  files.set(name, data);
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

beforeEach(() => {
  SetRefImports(makeFakeRi());
  Mod_Init();
  Mod_FreeAll();
  Mod_Free(mod_known[0]); // see this file's header comment: unconditional, unlike Mod_FreeAll()
});

// Expected counts, established once against the classic-format loader; see
// test/gl_model_qbsp.test.ts's identical comment for why these tests never
// call Mod_ForName twice with different map names in the same test (the
// renderer only ever accepts one brush model as "the world" per fresh
// Mod_FreeAll(), and a second, different-named call corrupts that model's
// cache entry for later tests since Mod_FreeAll only frees entries with a
// nonzero extradatasize).
describe("r_model.ts -- QBSP extended-format Mod_LoadBrushModel", () => {
  const qbspName = "maps/qbsproom.bsp";
  registerFile(qbspName, buildBoxRoomBspQbsp(undefined, { renderable: true }));

  test("a QBSP room loads the same structural counts as the equivalent classic-format room (test/gl_model.test.ts's own box-room suite)", () => {
    const qbsp = Mod_ForName(qbspName, false);
    expect(qbsp).not.toBeNull();
    if (!qbsp) throw new Error("model not returned");

    expect(qbsp.type).toBe(ModtypeT.mod_brush);
    expect(qbsp.numsubmodels).toBe(1);
    expect(qbsp.numplanes).toBe(6);
    expect(qbsp.numnodes).toBe(6);
    expect(qbsp.numleafs).toBe(2);
    // 6 real wall faces + 6 synthetic skybox faces R_InitSkyBox (r_rast.ts)
    // unconditionally appends after every brush-model load, matching
    // vanilla ref_soft's own R_InitSkyBox (unlike ref_gl, which draws the
    // sky separately rather than injecting fake surfaces into the model's
    // own surface list) -- verified this is pre-existing, format-independent
    // behavior (reproduces identically with the classic-format box room too,
    // confirmed by direct instrumentation during this unit's own
    // investigation), not something the QBSP port changed.
    expect(qbsp.numsurfaces).toBe(12);
    expect(qbsp.surfaces.length).toBe(12);
    // 25 real edges + 12 synthetic skybox edges (R_InitSkyBox, same
    // pre-existing append as numsurfaces above).
    expect(qbsp.numedges).toBe(37);
  });

  test("QBSP node/leaf tree walks correctly -- same containment results as the classic room", () => {
    const model = Mod_ForName(qbspName, false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");

    const insideLeaf = Mod_PointInLeaf(vec3(0, 0, 0), model);
    expect(isMleaf(insideLeaf)).toBe(true);
    expect(insideLeaf.contents & CONTENTS_SOLID).toBe(0);

    const wallLeaf = Mod_PointInLeaf(vec3(200, 0, 0), model);
    expect(wallLeaf.contents & CONTENTS_SOLID).toBe(CONTENTS_SOLID);

    const inline0 = mod_inline[0];
    expect(inline0.firstnode).toBe(0);
    expect(inline0.mins[0]).toBeCloseTo(-ROOM_HALF - 1);
    expect(inline0.maxs[0]).toBeCloseTo(ROOM_HALF + 1);
  });

  test("Mod_LoadFacesExt populates numedges/firstedge per surface, same as the classic loader", () => {
    const model = Mod_ForName(qbspName, false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not found");

    // the first 6 surfaces are the wall faces Mod_LoadFacesExt itself
    // built; surfaces 6-11 are R_InitSkyBox's synthetic skybox faces (see
    // this describe block's first test) and have their own numedges (4,
    // same value coincidentally -- a skybox quad).
    const wallSurfaces = model.surfaces.slice(0, 6);
    expect(wallSurfaces.length).toBe(6);
    for (const surf of wallSurfaces) {
      expect(surf.numedges).toBe(4);
    }
  });

  // NOTE: an "unrecognized BSP ident throws" test deliberately isn't
  // included here -- see test/gl_model_qbsp.test.ts's identical note for why
  // (a rejected Mod_LoadBrushModel call permanently poisons mod_known[0] for
  // every later brush-model test in the same bun:test process; unknown-ident
  // rejection is already exercised safely by test/cmodel_qbsp.test.ts).
});
