/*
Regression cover for the image cache in both renderers' extension-fallback
chains (GL_FindImage in src/ref_gl/gl_image.ts, R_FindImage in
src/ref_soft/r_image.ts).

Both functions look the requested name up in the cache first, then walk
q2repro's candidate extensions (src/qcommon/img_resolve.ts) and record the
extension that actually resolved. A caller that keeps asking for the ORIGINAL
name therefore keeps missing the cache, and every miss burns a fresh
gltextures/r_images slot for a picture that is already loaded.
SCR_DrawCrosshair asks for pics/ch1.pcx once per frame and the retail file is
pics/ch1.png: about 570 frames into any kex session the GL renderer died with
"ERROR: MAX_GLTEXTURES" (reproduced live on kex base1). q2repro has no such
hole -- its lookup_image keys on the base name, extension excluded
(src/refresh/images.c) -- so both chains now probe each candidate against the
cache before trying to load it.

Self-sufficient per PORTING.md rule 13: fake RefImports, texture arrays and
scrap state are all installed in this file's own beforeEach, following
test/img_resolve_new_formats.test.ts's conventions (including the
query-string module isolation the soft renderer's cache needs).
*/

import { describe, test, expect, beforeEach } from "bun:test";

// 1x1 24bpp BMP, color (200,150,100) -- the same fixture bytes
// test/img_resolve_new_formats.test.ts documents the generator for.
const ONE_PIXEL_BMP = new Uint8Array([66, 77, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 150, 200, 0]);

describe("GL_FindImage -- a fallback-resolved image is found again on the next lookup", () => {
  let files: Map<string, Uint8Array>;

  beforeEach(async () => {
    const { SetRefImports, gltextures, ImageT, SetNumGltextures, gl_state } = await import("../src/ref_gl/gl_local");
    const { CvarT } = await import("../src/shared/q_shared");
    const { SetQGL, ResetScrapState } = await import("../src/ref_gl/gl_image");
    const { QGLRecording } = await import("../src/ref_gl/qgl");

    files = new Map();
    SetRefImports({
      Sys_Error(errLevel: number, str: string): never {
        throw new Error(`Sys_Error(${errLevel}): ${str}`);
      },
      Cmd_AddCommand: () => {},
      Cmd_RemoveCommand: () => {},
      Cmd_Argc: () => 0,
      Cmd_Argv: () => "",
      Cmd_ExecuteText: () => {},
      Con_Printf: () => {},
      FS_LoadFile: (name: string) => {
        const data = files.get(name);
        if (!data) return { length: -1, data: null };
        return { length: data.length, data };
      },
      FS_FreeFile: () => {},
      FS_Gamedir: () => "",
      Cvar_Get: () => new CvarT(),
      Cvar_Set: () => new CvarT(),
      Cvar_SetValue: () => {},
      Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
      Vid_MenuInit: () => {},
      Vid_NewWindow: () => {},
    });
    SetQGL(new QGLRecording());
    for (let i = 0; i < gltextures.length; i++) gltextures[i] = new ImageT();
    SetNumGltextures(0);
    gl_state.currenttextures[0] = 0;
    gl_state.currenttextures[1] = 0;
    gl_state.currenttmu = 0;
    ResetScrapState();
  });

  test("repeated lookups of a name whose file only exists under another extension reuse one slot", async () => {
    const { GL_FindImage } = await import("../src/ref_gl/gl_image");
    const { ImagetypeT, numgltextures } = await import("../src/ref_gl/gl_local");
    files.set("pics/ch1.bmp", ONE_PIXEL_BMP);
    expect(numgltextures).toBe(0);

    const first = GL_FindImage("pics/ch1.pcx", ImagetypeT.it_pic);
    expect(first).not.toBeNull();
    expect(first?.name).toBe("pics/ch1.bmp");

    const local = await import("../src/ref_gl/gl_local");
    const afterFirst = local.numgltextures;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      const again = GL_FindImage("pics/ch1.pcx", ImagetypeT.it_pic);
      expect(again).toBe(first);
    }
    // one slot, not twenty-one
    expect(local.numgltextures).toBe(afterFirst);
  });

  test("asking by the resolved name directly still hits the plain exact-name cache", async () => {
    const { GL_FindImage } = await import("../src/ref_gl/gl_image");
    const { ImagetypeT } = await import("../src/ref_gl/gl_local");
    files.set("pics/ch1.bmp", ONE_PIXEL_BMP);

    const viaFallback = GL_FindImage("pics/ch1.pcx", ImagetypeT.it_pic);
    const direct = GL_FindImage("pics/ch1.bmp", ImagetypeT.it_pic);
    expect(direct).toBe(viaFallback);
  });
});

describe("R_FindImage -- same cache reuse in the software renderer", () => {
  let files: Map<string, Uint8Array>;
  let loads: string[];
  let isolationCounter = 0;

  beforeEach(async () => {
    isolationCounter++;
    loads = [];
    const { SetRefImports, d_8to24table } = await import("../src/ref_soft/r_local");
    files = new Map();
    SetRefImports({
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
        loads.push(name);
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
    });
    d_8to24table.fill(0);
    d_8to24table[9] = ((100 << 16) | (150 << 8) | 200) >>> 0;
  });

  // r_image.ts's r_images/numr_images module cache has no reset hook between
  // tests -- same rationale as test/img_resolve_new_formats.test.ts's own
  // soft-renderer block: import through a private query-string instance.
  async function freshRImage(): Promise<typeof import("../src/ref_soft/r_image")> {
    return import("../src/ref_soft/r_image" + "?img_resolve_cache_reuse_isolation_" + isolationCounter);
  }

  // r_image.ts keeps numr_images module-private, so the observable here is
  // the load itself: with the cache probe missing, every lookup re-reads the
  // file off the filesystem AND takes a new r_images slot.
  test("repeated lookups of a name whose file only exists under another extension load it once", async () => {
    const rImage = await freshRImage();
    const { ImagetypeT } = await import("../src/ref_soft/r_model");
    files.set("pics/ch1.bmp", ONE_PIXEL_BMP);

    const first = rImage.R_FindImage("pics/ch1.pcx", ImagetypeT.it_pic);
    expect(first).not.toBeNull();
    expect(first?.name).toBe("pics/ch1.bmp");
    expect(loads).toEqual(["pics/ch1.bmp"]);

    for (let i = 0; i < 20; i++) {
      const again = rImage.R_FindImage("pics/ch1.pcx", ImagetypeT.it_pic);
      expect(again).toBe(first);
    }
    expect(loads).toEqual(["pics/ch1.bmp"]);
  });
});
