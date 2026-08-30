// [Paril-KEX] kfont format -- src/client/cgame/kfont.ts (pure parser/lookup)
// and src/client/cgame/host.ts (loader + kfont-aware SCR_DrawFontString/
// SCR_MeasureFontString/SCR_FontLineHeight/SCR_DrawBind). See kfont.ts's own
// header comment for the full format writeup and the FIDELITY RAZOR
// (.orch/preferences.md rule 17) history this unit closes out.
//
// FIXTURE_KFONT below is a hand-built literal, not a copy of the real
// fonts/qconfont.kfont asset (a retail rerelease file this project does not
// redistribute) -- but its numeric glyph metrics (codepoint/x/y/w/h for 32,
// 33, 48, 65, 97, 115, 116) are copied verbatim from that real file's own
// bytes (extracted via `unzip -p .../Q2Game.kpf fonts/qconfont.kfont` and
// spot-read by this unit), so the parse/measure assertions below are
// checked against genuine data, not invented numbers. line_height=14 is the
// real file's own max(h) over its full ASCII 32-126 entry set (spot-checked
// by this unit against all 93 such entries, not just the 7 reproduced
// here). The "boots clean against q2rets/rerelease" half of this unit's
// gate (a separate, non-bun-test step) is what actually exercises the real
// asset end to end.
//
// Self-sufficient per PORTING.md rule 13: every test either uses the pure
// kfont.ts functions directly (no engine state) or mounts its own temp
// basedir + constructs its own fake RefExports via setRe, matching
// test/files.test.ts's and test/cgame_draw.test.ts's own established
// per-file setup conventions rather than relying on either file's state.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { ParseKfont, SCR_KFontLookup, KFONT_ASCII_MIN, KFONT_ASCII_MAX, type KfontT } from "../src/client/cgame/kfont";
import { buildCgameImports } from "../src/client/cgame/host";
import { setRe } from "../src/client/client";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { TextAlignT } from "../src/kexapi/game";

// Real-byte-derived subset of fonts/qconfont.kfont -- see this file's
// header comment above for provenance of every number here.
const FIXTURE_KFONT = `texture "fonts/qconfont.png"
unicode
mapchar
{
\t32 178 56 9 8 0
\t33 186 104 3 14 0
\t48 93 38 8 14 0
\t65 114 218 8 14 0
\t97 14 236 8 14 0
\t115 25 236 8 14 0
\t116 15 110 8 14 0
}
`;

function parsedFixtureFont(): KfontT {
  const parsed = ParseKfont(FIXTURE_KFONT);
  expect(parsed).not.toBeNull();
  const p = parsed!;
  return { pic: "/" + p.textureToken, chars: p.chars, line_height: p.line_height };
}

describe("kfont.ts -- ParseKfont / SCR_KFontLookup (pure, no engine state)", () => {
  test("ParseKfont: reads the texture line and mapchar entries (real-byte-derived values)", () => {
    const parsed = ParseKfont(FIXTURE_KFONT);
    expect(parsed).not.toBeNull();
    expect(parsed!.textureToken).toBe("fonts/qconfont.png");

    const a = parsed!.chars[97 - KFONT_ASCII_MIN]; // 'a'
    expect(a).toEqual({ x: 14, y: 236, w: 8, h: 14 });

    const bang = parsed!.chars[33 - KFONT_ASCII_MIN]; // '!'
    expect(bang).toEqual({ x: 186, y: 104, w: 3, h: 14 });
  });

  test("ParseKfont: line_height is the max h across all parsed entries (14 in the real asset)", () => {
    const parsed = ParseKfont(FIXTURE_KFONT);
    expect(parsed!.line_height).toBe(14);
  });

  test("ParseKfont: returns null when the file has no 'texture' line", () => {
    const noTexture = `unicode\nmapchar\n{\n\t97 14 236 8 14 0\n}\n`;
    expect(ParseKfont(noTexture)).toBeNull();
  });

  test("ParseKfont/SCR_KFontLookup: a codepoint in q2repro's own [127,157] out-of-bounds range (see kfont.ts's header comment) is dropped, not stored -- FIDELITY RAZOR deviation, not reproduced as a real OOB write", () => {
    const withDangerRange = `texture "fonts/qconfont.png"\nmapchar\n{\n\t140 1 1 5 5 0\n}\n`;
    const parsed = ParseKfont(withDangerRange);
    expect(parsed).not.toBeNull();
    const font: KfontT = { pic: "/x", chars: parsed!.chars, line_height: parsed!.line_height };
    expect(SCR_KFontLookup(font, 140)).toBeNull();
  });

  test("SCR_KFontLookup: returns the glyph rect for a mapped codepoint", () => {
    const font = parsedFixtureFont();
    expect(SCR_KFontLookup(font, "t".charCodeAt(0))).toEqual({ x: 15, y: 110, w: 8, h: 14 });
  });

  test("SCR_KFontLookup: returns null for a codepoint outside [KFONT_ASCII_MIN, KFONT_ASCII_MAX]", () => {
    const font = parsedFixtureFont();
    expect(SCR_KFontLookup(font, KFONT_ASCII_MIN - 1)).toBeNull();
    expect(SCR_KFontLookup(font, KFONT_ASCII_MAX + 1)).toBeNull();
  });

  test("SCR_KFontLookup: returns null for an in-range codepoint the atlas has no entry for (e.g. 'b', not in this fixture)", () => {
    const font = parsedFixtureFont();
    expect(SCR_KFontLookup(font, "b".charCodeAt(0))).toBeNull();
  });

  test("SCR_KFontLookup: treats a present-but-zero-width entry as missing (synthetic case -- the real asset's own backtick/tilde gaps are this same shape)", () => {
    const withZeroWidth = `texture "fonts/qconfont.png"\nmapchar\n{\n\t34 0 0 0 0 0\n}\n`;
    const parsed = ParseKfont(withZeroWidth);
    const font: KfontT = { pic: "/x", chars: parsed!.chars, line_height: parsed!.line_height };
    expect(SCR_KFontLookup(font, 34)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// host.ts integration: buildCgameImports()'s SCR_MeasureFontString/
// SCR_FontLineHeight/SCR_DrawFontString, kfont-loaded vs the original
// conchars-only fallback. Mirrors test/cgame_draw.test.ts's makeFakeRe
// convention (full RefExports fake, no `as`/partial) rather than importing
// that file's copy, per PORTING.md rule 13 (self-sufficient test files).
// ---------------------------------------------------------------------------

function makeFakeRe(): RefExports & {
  drawCharCalls: number[];
  drawStretchPicRegionCalls: Array<{ x: number; y: number; w: number; h: number; name: string; srcX: number; srcY: number; srcW: number; srcH: number; color: DrawColorT }>;
  registerPicCalls: string[];
  registerPicResult: ImageS | null;
} {
  const fake = {
    drawCharCalls: [] as number[],
    drawStretchPicRegionCalls: [] as Array<{ x: number; y: number; w: number; h: number; name: string; srcX: number; srcY: number; srcW: number; srcH: number; color: DrawColorT }>,
    registerPicCalls: [] as string[],
    registerPicResult: {} as ImageS | null, // truthy handle by default -- most tests below want the font to "exist"

    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic(name: string): ImageS | null {
      fake.registerPicCalls.push(name);
      return fake.registerPicResult;
    },
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    DrawGetPicSize: () => ({ w: -1, h: -1 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: () => undefined,
    DrawStretchPicRegion(x: number, y: number, w: number, h: number, name: string, srcX: number, srcY: number, srcW: number, srcH: number, color: DrawColorT) {
      fake.drawStretchPicRegionCalls.push({ x, y, w, h, name, srcX, srcY, srcW, srcH, color });
    },
    DrawChar(_x: number, _y: number, c: number) {
      fake.drawCharCalls.push(c);
    },
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return fake;
}

function mountBasedir(dir: string): void {
  Cvar_ForceSet("basedir", dir);
  FS_InitFilesystem();
}

// NOTE on ordering: files.ts's FS_AddGameDirectory PREPENDS each newly
// mounted directory onto the existing fs_searchpaths chain rather than
// replacing it (matching files.c's own real search-path semantics -- later
// gamedirs shadow earlier ones, they don't erase them). FS_InitFilesystem
// is therefore NOT a clean "reset" between mounts within one process: this
// file calls it exactly ONCE per describe block below (never toggling back
// and forth), and orders the two describes so the "no kfont anywhere in the
// search chain yet" case runs BEFORE this file ever mounts a directory that
// has one -- once fonts/qconfont.kfont is mounted, later FS_LoadFile calls
// in this same process would keep finding it via that leftover search path
// entry, exactly like test/files.test.ts's own single-mount-per-file
// convention this mirrors.
describe("host.ts -- kfont-aware SCR_MeasureFontString/SCR_FontLineHeight/SCR_DrawFontString: missing-font fallback", () => {
  let noFontRoot: string;

  beforeAll(() => {
    noFontRoot = mkdtempSync(join(tmpdir(), "q2kfont-without-"));
    mkdirSync(join(noFontRoot, "baseq2"), { recursive: true });
    mountBasedir(noFontRoot);
  });

  afterAll(() => {
    rmSync(noFontRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    setRe(null);
  });

  test("without a mounted fonts/qconfont.kfont, SCR_MeasureFontString/SCR_FontLineHeight use the original conchars math", () => {
    setRe(makeFakeRe());
    const imports = buildCgameImports();

    expect(imports.SCR_FontLineHeight(3)).toBe(8 * 3); // CONCHAR_HEIGHT * scale
    expect(imports.SCR_MeasureFontString("test", 2)).toEqual({ x: 4 * 8 * 2, y: 1 * 8 * 2 }); // CONCHAR_WIDTH/HEIGHT * scale
  });

  test("SCR_DrawFontString draws via DrawChar (conchars), never DrawStretchPicRegion, when no kfont is mounted", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const imports = buildCgameImports();

    imports.SCR_DrawFontString("hi", 0, 0, 1, { r: 255, g: 255, b: 255, a: 255 }, false, TextAlignT.LEFT);

    expect(fake.drawStretchPicRegionCalls).toEqual([]);
    expect(fake.drawCharCalls).toEqual(["h".charCodeAt(0), "i".charCodeAt(0)]);
  });
});

describe("host.ts -- kfont-aware SCR_MeasureFontString/SCR_FontLineHeight/SCR_DrawFontString: font loads", () => {
  let withFontRoot: string;

  beforeAll(() => {
    withFontRoot = mkdtempSync(join(tmpdir(), "q2kfont-with-"));
    const withFontBaseq2 = join(withFontRoot, "baseq2");
    mkdirSync(join(withFontBaseq2, "fonts"), { recursive: true });
    writeFileSync(join(withFontBaseq2, "fonts", "qconfont.kfont"), FIXTURE_KFONT);
    mountBasedir(withFontRoot);
  });

  afterAll(() => {
    rmSync(withFontRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    setRe(null);
  });

  test("the font loads: with fonts/qconfont.kfont mounted, SCR_DrawFontString registers and draws through DrawStretchPicRegion (the atlas path), not DrawChar", () => {
    const fake = makeFakeRe();
    setRe(fake);

    const imports = buildCgameImports();
    imports.SCR_DrawFontString("a", 100, 50, 1, { r: 255, g: 255, b: 255, a: 255 }, false, TextAlignT.LEFT);

    expect(fake.registerPicCalls).toContain("/fonts/qconfont.png");
    expect(fake.drawCharCalls).toEqual([]);
    expect(fake.drawStretchPicRegionCalls).toEqual([{ x: 100, y: 50, w: 8, h: 14, name: "/fonts/qconfont.png", srcX: 14, srcY: 236, srcW: 8, srcH: 14, color: { r: 255, g: 255, b: 255, a: 255 } }]);
  });

  test("SCR_FontLineHeight: kfont path returns font.line_height UNSCALED, regardless of `scale` (preserved q2repro quirk)", () => {
    setRe(makeFakeRe());
    const imports = buildCgameImports();

    expect(imports.SCR_FontLineHeight(1)).toBe(14);
    expect(imports.SCR_FontLineHeight(5)).toBe(14);
  });

  test("SCR_MeasureFontString: kfont path sums real glyph widths and ignores `scale` entirely (preserved q2repro quirk)", () => {
    setRe(makeFakeRe());
    const imports = buildCgameImports();

    // 'a' (w=8) + 't' (w=8) = 16, at any scale.
    expect(imports.SCR_MeasureFontString("at", 1)).toEqual({ x: 16, y: 14 });
    expect(imports.SCR_MeasureFontString("at", 3)).toEqual({ x: 16, y: 14 });
  });

  test("SCR_MeasureFontString: multi-line kfont path uses the widest line's width and line_height * line count for height", () => {
    setRe(makeFakeRe());
    const imports = buildCgameImports();

    // line 1 "A" -> w=8; line 2 "at" -> w=16; widest is 16. height = 2*14.
    expect(imports.SCR_MeasureFontString("A\nat", 1)).toEqual({ x: 16, y: 28 });
  });

  test("SCR_MeasureFontString: an in-range codepoint with no atlas entry contributes zero width (kfont path)", () => {
    setRe(makeFakeRe());
    const imports = buildCgameImports();

    // 'a' (w=8) + 'b' (no entry in the fixture, contributes 0) = 8.
    expect(imports.SCR_MeasureFontString("ab", 1).x).toBe(8);
  });

  test("draw advance IS scaled even though measure is not (preserved q2repro quirk): drawing 'at' at scale=2 advances by ch.w*2 per glyph", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const imports = buildCgameImports();

    imports.SCR_DrawFontString("at", 100, 50, 2, { r: 1, g: 2, b: 3, a: 255 }, false, TextAlignT.LEFT);

    expect(fake.drawStretchPicRegionCalls.map((c) => ({ x: c.x, w: c.w }))).toEqual([
      { x: 100, w: 16 }, // 'a': ch.w=8 * scale=2
      { x: 116, w: 16 }, // 't': cursor advanced by 8*2=16, not the unscaled 8 MeasureFontString would report
    ]);
  });

  test("shadow=true draws a black offset copy before the real glyph (two DrawStretchPicRegion calls); shadow=false draws one", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const imports = buildCgameImports();

    imports.SCR_DrawFontString("a", 10, 10, 1, { r: 200, g: 100, b: 50, a: 255 }, true, TextAlignT.LEFT);
    expect(fake.drawStretchPicRegionCalls.length).toBe(2);
    expect(fake.drawStretchPicRegionCalls[0]).toMatchObject({ x: 11, y: 11, color: { r: 0, g: 0, b: 0, a: 255 } });
    expect(fake.drawStretchPicRegionCalls[1]).toMatchObject({ x: 10, y: 10, color: { r: 200, g: 100, b: 50, a: 255 } });

    fake.drawStretchPicRegionCalls.length = 0;
    imports.SCR_DrawFontString("a", 10, 10, 1, { r: 200, g: 100, b: 50, a: 255 }, false, TextAlignT.LEFT);
    expect(fake.drawStretchPicRegionCalls.length).toBe(1);
  });
});
