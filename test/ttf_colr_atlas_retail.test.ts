// qcommon/ttf.ts's buildFontAtlas COLR v0 + CPAL color-glyph baking (the
// kfont-draw-model completion unit -- see ttf.ts's own "COLR v0 + CPAL
// COLOR GLYPHS" doc comment on buildFontAtlas, and client/cgame/kfont.ts's
// KfontCharT.color / client/cgame/host.ts's drawKfontChar for the draw-side
// half) against REAL retail font bytes: a controller-icon PUA glyph must
// bake into the atlas as a full-RGBA, non-monochrome region
// (AtlasRectT.color = true), while an ordinary text glyph from a real text
// font keeps the pre-existing white-RGB/coverage-alpha monochrome shape
// (AtlasRectT.color = false) -- proving the new color-glyph branch doesn't
// disturb the atlas format every ordinary (non-color) glyph has always
// used.
//
// No retail content is read into this repository or committed anywhere:
// the KPF is read directly from the user's local retail install path at
// test-run time via this project's own qcommon/zipfile.ts ZipArchive
// reader (same approach test/ttf_colr_retail.test.ts's own header
// documents), and rasterized pixels never touch disk. If the retail
// install isn't present (e.g. CI), every test in this file skips itself
// (loudly, by name) rather than failing.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ZipArchive } from "../src/qcommon/zipfile";
import { parseFont, buildFontAtlas } from "../src/qcommon/ttf";

const KPF_PATH = "/home/buzzkill/q2rets/rerelease/Q2Game.kpf";
const haveKpf = existsSync(KPF_PATH);

function openKpf(): ZipArchive {
  const buf = readFileSync(KPF_PATH);
  const archive = ZipArchive.open(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (!archive) throw new Error("failed to open Q2Game.kpf as a zip archive");
  return archive;
}

describe("ttf.ts -- buildFontAtlas COLR/CPAL color-region baking against the real retail font stack, skipped if the retail install isn't present", () => {
  if (!haveKpf) {
    test.skip(`SKIPPED (no retail install at ${KPF_PATH}): needs the real Q2Game.kpf`, () => {});
  }

  test.skipIf(!haveKpf)("KexControllerIconsDS4.ttf codepoint 0xF0000 (a real 3-layer COLR/CPAL icon glyph): baked atlas region is marked color=true and contains multiple distinct opaque RGB colors -- the real CPAL palette, not a flat white coverage mask", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/KexControllerIconsDS4.ttf");
    expect(bytes, "fonts/KexControllerIconsDS4.ttf not found in Q2Game.kpf").not.toBeNull();
    const parsed = parseFont(bytes!);
    if (!parsed.ok) throw new Error(`parseFont failed: ${parsed.reason}`);
    const font = parsed.font;

    const atlas = buildFontAtlas(font, [0xf0000], 32);
    const rect = atlas.glyphs.get(0xf0000);
    expect(rect, "codepoint 0xF0000 did not bake into the atlas at all").toBeDefined();
    expect(rect!.color, "expected the icon glyph's atlas rect to be marked as a color region (AtlasRectT.color)").toBe(true);

    // Same "which real palette colors actually got painted" technique
    // test/ttf_colr_retail.test.ts's own rasterizeColorGlyph test uses,
    // applied to the ATLAS's pixels at the baked rect's offset (proving the
    // atlas copy step preserves the real composited colors, not just that
    // rasterizeColorGlyph itself produces them).
    const opaqueColors = new Map<string, number>();
    for (let y = 0; y < rect!.h; y++) {
      for (let x = 0; x < rect!.w; x++) {
        const o = ((rect!.y + y) * atlas.width + (rect!.x + x)) * 4;
        if (atlas.pixels[o + 3] < 200) continue;
        const key = `${atlas.pixels[o]},${atlas.pixels[o + 1]},${atlas.pixels[o + 2]}`;
        opaqueColors.set(key, (opaqueColors.get(key) ?? 0) + 1);
      }
    }
    expect(opaqueColors.size, `expected multiple distinct opaque colors baked into the atlas region, got: ${[...opaqueColors.keys()].join(" | ")}`).toBeGreaterThan(1);
    expect(opaqueColors.has("255,255,255"), "the baked color region should NOT be the flat white monochrome mask ordinary (non-color) glyphs use").toBe(false);

    // Real CPAL palette 0 colors for this exact glyph (verified real bytes,
    // same values test/ttf_colr_retail.test.ts's direct-rasterizer test
    // asserts) should actually appear among the baked atlas pixels.
    expect(opaqueColors.get("75,75,77"), "expected layer 0's exact CPAL color (75,75,77) baked into the atlas").toBeGreaterThan(0);
    expect(opaqueColors.get("35,31,32"), "expected layer 1's exact CPAL color (35,31,32) baked into the atlas").toBeGreaterThan(0);
    expect(opaqueColors.get("0,160,136"), "expected layer 2's exact CPAL color (0,160,136) baked into the atlas").toBeGreaterThan(0);
  });

  test.skipIf(!haveKpf)("RobotoMono-Regular.ttf codepoint 'A' (0x41, an ordinary text glyph): baked atlas region is marked color=false and stays monochrome (RGB always 255,255,255; only alpha varies with antialiased coverage)", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/RobotoMono-Regular.ttf");
    expect(bytes, "fonts/RobotoMono-Regular.ttf not found in Q2Game.kpf").not.toBeNull();
    const parsed = parseFont(bytes!);
    if (!parsed.ok) throw new Error(`parseFont failed: ${parsed.reason}`);
    const font = parsed.font;

    const atlas = buildFontAtlas(font, [0x41], 32);
    const rect = atlas.glyphs.get(0x41);
    expect(rect, "'A' did not bake into the atlas at all").toBeDefined();
    expect(rect!.color, "expected an ordinary text glyph's atlas rect to NOT be marked as a color region").toBe(false);

    let sawPartialAlpha = false;
    for (let y = 0; y < rect!.h; y++) {
      for (let x = 0; x < rect!.w; x++) {
        const o = ((rect!.y + y) * atlas.width + (rect!.x + x)) * 4;
        expect(atlas.pixels[o], "monochrome glyph pixel R channel should always be 255").toBe(255);
        expect(atlas.pixels[o + 1], "monochrome glyph pixel G channel should always be 255").toBe(255);
        expect(atlas.pixels[o + 2], "monochrome glyph pixel B channel should always be 255").toBe(255);
        if (atlas.pixels[o + 3] > 0 && atlas.pixels[o + 3] < 255) sawPartialAlpha = true;
      }
    }
    // A real rasterized 'A' at 32px has antialiased edges somewhere --
    // proves this is genuine rasterizer output, not a degenerate
    // all-or-nothing box that would trivially satisfy the RGB-always-255
    // check above.
    expect(sawPartialAlpha, "expected at least one antialiased (partial-coverage) pixel in a real rasterized 'A' glyph").toBe(true);
  });
});
