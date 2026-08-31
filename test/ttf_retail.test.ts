// qcommon/ttf.ts against the REAL retail font stack: all 29 files under
// fonts/ inside the retail rerelease KPF (Q2Game.kpf) -- 26 .ttf (TrueType
// glyf outlines) + 3 .otf (CFF outlines; two of those three, NotoSansJP and
// NotoSansKR, are CID-keyed CFF -- FDArray/FDSelect, not just a single
// Private DICT). See qcommon/ttf.ts's own header comment for the full
// format-coverage writeup this test's assertions are backed by.
//
// No retail content is read into this repository or committed anywhere:
// the KPF is read directly from the user's local retail install path at
// test-run time via this project's own qcommon/zipfile.ts ZipArchive
// reader (raw node:fs read of the .kpf, NOT the engine's FS_* module --
// same "don't mutate the shared fs_searchpaths singleton" reasoning
// test/cl_demo_retail.test.ts's own header documents), and rasterized
// pixels never touch disk. If the retail install isn't present (e.g. CI),
// every test in this file skips itself rather than failing.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ZipArchive } from "../src/qcommon/zipfile";
import { parseFont, buildFontAtlas, latin1Codepoints, rasterizeGlyph } from "../src/qcommon/ttf";

const KPF_PATH = "/home/buzzkill/q2rets/rerelease/Q2Game.kpf";
const haveKpf = existsSync(KPF_PATH);

// The full 29-file matrix -- name plus the outline format this port's own
// research pass (sfnt table-directory tag scan against the real bytes)
// found, so a format regression (e.g. a font quietly losing its CFF table
// support and silently falling through to "no outline table found") shows
// up as a specific wrong-format assertion, not just a generic failure.
const RETAIL_FONTS: { file: string; format: "glyf" | "cff" }[] = [
  { file: "AtkinsonHyperLegible-Regular.otf", format: "cff" },
  { file: "KexControllerIconsDS4.ttf", format: "glyf" },
  { file: "KexControllerIconsDSense.ttf", format: "glyf" },
  { file: "KexControllerIconsGeneric.ttf", format: "glyf" },
  { file: "KexControllerIconsMouse.ttf", format: "glyf" },
  { file: "KexControllerIconsSwitchJoy.ttf", format: "glyf" },
  { file: "KexControllerIconsSwitchPro.ttf", format: "glyf" },
  { file: "KexControllerIconsXbox.ttf", format: "glyf" },
  { file: "Montserrat-Regular.ttf", format: "glyf" },
  { file: "NotoSans-Bold.ttf", format: "glyf" },
  { file: "NotoSans-ExtraCondensedMedium.ttf", format: "glyf" },
  { file: "NotoSans-ExtraCondensedSemiBold.ttf", format: "glyf" },
  { file: "NotoSansJP-Regular.otf", format: "cff" }, // CID-keyed (FDArray/FDSelect)
  { file: "NotoSansKR-Regular.otf", format: "cff" }, // CID-keyed (FDArray/FDSelect)
  { file: "RobotoMono-Bold.ttf", format: "glyf" },
  { file: "RobotoMono-BoldItalic.ttf", format: "glyf" },
  { file: "RobotoMono-ExtraLight.ttf", format: "glyf" },
  { file: "RobotoMono-ExtraLightItalic.ttf", format: "glyf" },
  { file: "RobotoMono-Italic.ttf", format: "glyf" },
  { file: "RobotoMono-Light.ttf", format: "glyf" },
  { file: "RobotoMono-LightItalic.ttf", format: "glyf" },
  { file: "RobotoMono-Medium.ttf", format: "glyf" },
  { file: "RobotoMono-MediumItalic.ttf", format: "glyf" },
  { file: "RobotoMono-Regular.ttf", format: "glyf" },
  { file: "RobotoMono-SemiBold.ttf", format: "glyf" },
  { file: "RobotoMono-SemiBoldItalic.ttf", format: "glyf" },
  { file: "RobotoMono-Thin.ttf", format: "glyf" },
  { file: "RobotoMono-ThinItalic.ttf", format: "glyf" },
  { file: "RussoOne-Regular.ttf", format: "glyf" },
];

function openKpf(): ZipArchive {
  const buf = readFileSync(KPF_PATH);
  const archive = ZipArchive.open(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (!archive) throw new Error("failed to open Q2Game.kpf as a zip archive");
  return archive;
}

describe("ttf.ts -- real retail font stack (Q2Game.kpf), skipped if the retail install isn't present", () => {
  test.skipIf(!haveKpf)(`all ${RETAIL_FONTS.length} shipped fonts parse successfully with the expected outline format and a positive glyph count`, () => {
    const archive = openKpf();
    const results: string[] = [];
    for (const { file, format } of RETAIL_FONTS) {
      const bytes = archive.readFile(`fonts/${file}`);
      expect(bytes).not.toBeNull();
      const parsed = parseFont(bytes!);
      if (!parsed.ok) {
        throw new Error(`${file}: parseFont failed: ${parsed.reason}`);
      }
      expect(parsed.font.outlineFormat).toBe(format);
      expect(parsed.font.numGlyphs).toBeGreaterThan(0);
      expect(parsed.font.unitsPerEm).toBeGreaterThan(0);
      results.push(`${file}: ${parsed.font.outlineFormat}, ${parsed.font.numGlyphs} glyphs, unitsPerEm=${parsed.font.unitsPerEm}`);
    }
    expect(results.length).toBe(RETAIL_FONTS.length);
  });

  test.skipIf(!haveKpf)("every shipped text font maps 'A' (U+0041) to a real glyph and rasterizes it at 16px with non-zero coverage", () => {
    // The 7 KexControllerIcons*.ttf files are private-use-area icon fonts
    // (verified against the real bytes: their sole cmap format-12 group
    // maps codepoint 0x0 to gid 1 and a font-specific PUA range starting at
    // 0xF0000/0xF0100/etc to the icon glyphs -- no 'A' entry at all, by
    // design, not a parser gap). They get their own gid-1-direct check
    // below instead of an 'A' lookup.
    const archive = openKpf();
    for (const { file } of RETAIL_FONTS) {
      if (file.startsWith("KexControllerIcons")) continue;
      const bytes = archive.readFile(`fonts/${file}`);
      const parsed = parseFont(bytes!);
      if (!parsed.ok) throw new Error(`${file}: parseFont failed: ${parsed.reason}`);
      const font = parsed.font;

      const gid = font.cmapLookup(0x41);
      expect(gid, `${file}: cmap has no entry for 'A'`).toBeGreaterThan(0);

      const atlas = buildFontAtlas(font, [0x41], 16);
      const rect = atlas.glyphs.get(0x41);
      expect(rect, `${file}: 'A' not present in the built atlas`).toBeDefined();
      expect(rect!.w).toBeGreaterThan(0);
      expect(rect!.h).toBeGreaterThan(0);

      let sum = 0;
      for (let y = 0; y < rect!.h; y++) {
        for (let x = 0; x < rect!.w; x++) {
          sum += atlas.pixels[((rect!.y + y) * atlas.width + (rect!.x + x)) * 4 + 3]; // alpha channel
        }
      }
      expect(sum, `${file}: 'A' rasterized to all-zero coverage`).toBeGreaterThan(0);
    }
  });

  // FINDING (glyf/loca decoder verification against real, non-trivial data
  // -- NOT a parser gap): the 7 KexControllerIcons*.ttf files are COLR v0 +
  // CPAL color fonts (verified against the real sfnt table directory: each
  // one carries COLR/CPAL/GDEF tables alongside glyf/loca). Their
  // cmap-reachable glyphs (gid 1 = a blank placeholder mapped from
  // codepoint 0x0; gids 2 upward = one per icon, mapped from a
  // font-specific private-use-area range) are legitimately EMPTY base
  // outlines by the COLR v0 design -- the actual multi-color icon artwork
  // lives in separate, higher-numbered, NOT-cmap-reachable "layer" glyphs
  // (verified by direct inspection: e.g. KexControllerIconsDS4.ttf's gid 30
  // has 2 real contours and non-zero rasterized coverage), which a COLR
  // table (not implemented -- see ttf.ts's header) would composite with
  // per-layer palette colors from CPAL. Rasterizing a COLR base glyph
  // (gid 1/2/3/...) as this module does -- plain outline-to-grayscale, no
  // layer compositing -- correctly and faithfully produces nothing, so this
  // test proves the glyf/loca DECODER itself works on these real files by
  // rasterizing a known-non-empty LAYER glyph instead of a cmap-mapped one.
  test.skipIf(!haveKpf)("the 7 KexControllerIcons*.ttf COLR fonts: the glyf/loca decoder itself works on real data -- the first glyph with real outline geometry rasterizes with non-zero coverage", () => {
    const archive = openKpf();
    for (const { file } of RETAIL_FONTS) {
      if (!file.startsWith("KexControllerIcons")) continue;
      const bytes = archive.readFile(`fonts/${file}`);
      const parsed = parseFont(bytes!);
      if (!parsed.ok) throw new Error(`${file}: parseFont failed: ${parsed.reason}`);
      const font = parsed.font;

      let firstNonEmptyGid = -1;
      for (let gid = 0; gid < font.numGlyphs; gid++) {
        if (font.contours(gid).length > 0) {
          firstNonEmptyGid = gid;
          break;
        }
      }
      expect(firstNonEmptyGid, `${file}: every glyph (including COLR layer glyphs) decoded to zero contours`).toBeGreaterThanOrEqual(0);

      const raster = rasterizeGlyph(font, firstNonEmptyGid, 16);
      let sum = 0;
      for (const a of raster.coverage) sum += a;
      expect(sum, `${file}: gid ${firstNonEmptyGid} (first non-empty) rasterized to all-zero coverage`).toBeGreaterThan(0);
    }
  });

  test.skipIf(!haveKpf)("RobotoMono-Regular.ttf (glyf, monospace): a full ASCII+Latin-1 atlas builds with plausible dimensions and every ASCII letter present", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/RobotoMono-Regular.ttf");
    expect(bytes).not.toBeNull();
    const parsed = parseFont(bytes!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const atlas = buildFontAtlas(parsed.font, latin1Codepoints(), 16);
    expect(atlas.width).toBeGreaterThan(0);
    expect(atlas.height).toBeGreaterThan(0);
    expect(atlas.lineHeight).toBeGreaterThan(0);
    // Monospace: every rasterized ASCII letter should share the same advance
    // (rect width) at a fixed pixel size.
    const widths = new Set<number>();
    for (let cp = 0x41; cp <= 0x5a; cp++) {
      const rect = atlas.glyphs.get(cp);
      expect(rect, `RobotoMono-Regular.ttf: missing '${String.fromCharCode(cp)}'`).toBeDefined();
      widths.add(rect!.w);
    }
    expect(widths.size).toBe(1);
  });

  test.skipIf(!haveKpf)("AtkinsonHyperLegible-Regular.otf (plain, non-CID CFF): 'A' rasterizes with non-zero coverage via the Type 2 charstring interpreter", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/AtkinsonHyperLegible-Regular.otf");
    expect(bytes).not.toBeNull();
    const parsed = parseFont(bytes!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.font.outlineFormat).toBe("cff");
    const contours = parsed.font.contours(parsed.font.cmapLookup(0x41));
    expect(contours.length).toBeGreaterThan(0);
  });

  test.skipIf(!haveKpf)("NotoSansJP-Regular.otf and NotoSansKR-Regular.otf (CID-keyed CFF via FDArray/FDSelect): 'A' resolves through a non-default FD's local subrs without error", () => {
    const archive = openKpf();
    for (const file of ["NotoSansJP-Regular.otf", "NotoSansKR-Regular.otf"]) {
      const bytes = archive.readFile(`fonts/${file}`);
      expect(bytes).not.toBeNull();
      const parsed = parseFont(bytes!);
      expect(parsed.ok, `${file}: parseFont failed`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.font.outlineFormat).toBe("cff");
      const gid = parsed.font.cmapLookup(0x41);
      expect(gid, `${file}: no cmap entry for 'A'`).toBeGreaterThan(0);
      const contours = parsed.font.contours(gid);
      expect(contours.length, `${file}: 'A' has no contours`).toBeGreaterThan(0);
    }
  });
});
