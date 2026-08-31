// Test for src/client/cgame/host.ts's cl_kfont_source cvar wiring (wave B
// task, item 5): the TTF unit's documented "classic|kfont|ttf:<name>" cvar
// (kfont.ts's Kfont_FromTTF header comment) is implemented for real by
// ensureActiveKfont() -- this exercises the DISPATCH (which loader a given
// cl_kfont_source value selects) through the public CgameImports surface
// (buildCgameImports().SCR_MeasureFontString), the same seam
// test/cgame_draw.test.ts already uses to exercise the font path.
//
// Uses a REAL temp filesystem (precedent: test/files.test.ts/test/cd_ogg
// .test.ts's own mkdtempSync pattern) with a real (hand-written, tiny)
// fonts/qconfont.kfont loose file, so the "classic" source's override can
// be proven crisply: the SAME kfont file is loadable in every test below,
// so a measured-width difference is entirely attributable to
// cl_kfont_source's own dispatch, not to whether a kfont asset happens to
// exist.
//
// The "ttf:<name>" source's happy path (real TTF bytes -> parseFont ->
// buildFontAtlas -> GL_LoadPic) is NOT independently re-tested here: that
// pipeline's own pure-function correctness is test/ttf.test.ts's and
// test/ttf_retail.test.ts's job, and GL_LoadPic's own renderer-side
// behavior is test/gl_image.test.ts's. What's new and unique to THIS unit
// is the cvar dispatch glue, which the graceful-fallback case below proves
// end-to-end (FS_LoadFile miss -> null -> conchars fallback, exactly like
// any other kfont load failure).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_InitFilesystem, FS_SetGamedir } from "../src/qcommon/files";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { setRe } from "../src/client/client";
import { buildCgameImports } from "../src/client/cgame/host";
import { API_VERSION, type RefExports, type ImageS, type DrawColorT } from "../src/client/ref";

function makeFakeRe(): RefExports {
  return {
    api_version: API_VERSION,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (): ImageS | null => ({}) as ImageS, // always "succeeds" -- the PNG itself is never touched by loadKfontAsset
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _srcX: number, _srcY: number, _srcW: number, _srcH: number, _color: DrawColorT) => undefined,
    DrawChar: () => undefined,
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
}

// Codepoint 65 ('A') -> width 10, height 12; this is the ONLY mapped glyph,
// deliberately, so measured width is unambiguous: kfont branch sums
// per-glyph widths (10 for "A"), the conchars fallback uses
// maxlen * CONCHAR_WIDTH(8) * scale (8 for "A").
const KFONT_TEXT = `texture "fonts/qconfont.png"\nunicode\nmapchar\n{\n65 0 0 10 12 0\n}\n`;

describe("cgame/host.ts -- cl_kfont_source dispatch", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2kfontsrc-"));
    const baseq2 = join(tmpRoot, "baseq2");
    mkdirSync(join(baseq2, "fonts"), { recursive: true });
    writeFileSync(join(baseq2, "fonts", "qconfont.kfont"), KFONT_TEXT);
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir("");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    setRe(makeFakeRe());
  });

  test("default (\"kfont\"): a real qconfont.kfont on disk is loaded and used for measurement", () => {
    Cvar_ForceSet("cl_kfont_source", "kfont");
    const imports = buildCgameImports();
    expect(imports.SCR_MeasureFontString("A", 1).x).toBe(10);
  });

  test("\"classic\": forces the conchars fallback even though the SAME kfont file would otherwise load", () => {
    Cvar_ForceSet("cl_kfont_source", "classic");
    const imports = buildCgameImports();
    expect(imports.SCR_MeasureFontString("A", 1).x).toBe(8);
  });

  test("switching the cvar at runtime takes effect on the next call (cache keyed on source, not just `re`)", () => {
    Cvar_ForceSet("cl_kfont_source", "kfont");
    const imports = buildCgameImports();
    expect(imports.SCR_MeasureFontString("A", 1).x).toBe(10);

    Cvar_ForceSet("cl_kfont_source", "classic");
    expect(imports.SCR_MeasureFontString("A", 1).x).toBe(8);

    Cvar_ForceSet("cl_kfont_source", "kfont");
    expect(imports.SCR_MeasureFontString("A", 1).x).toBe(10);
  });

  test("\"ttf:<name>\" for a font that doesn't exist on disk gracefully falls back to conchars, exactly like any other kfont load failure", () => {
    Cvar_ForceSet("cl_kfont_source", "ttf:DoesNotExist");
    const imports = buildCgameImports();
    expect(imports.SCR_MeasureFontString("A", 1).x).toBe(8);
  });

  test("cl_kfont_source/cl_kfont_ttf_size register with their documented defaults", () => {
    // ensureKfontCvars() (host.ts) registers both cvars on first use; by
    // this point in the suite something has already triggered that (every
    // test above calls buildCgameImports().SCR_MeasureFontString at least
    // once). Cvar_Get is idempotent -- calling it again here just returns
    // the SAME CvarT host.ts already registered, whose `default_string`
    // reflects what it was FIRST registered with regardless of any
    // Cvar_ForceSet done since (default_string is set once in Cvar_Get,
    // never touched by Cvar_Set/Cvar_ForceSet -- see shared/q_shared.ts's
    // CvarT.default_string doc comment).
    expect(Cvar_Get("cl_kfont_source", "kfont", 0)?.default_string).toBe("kfont");
    expect(Cvar_Get("cl_kfont_ttf_size", "16", 0)?.default_string).toBe("16");
  });
});
