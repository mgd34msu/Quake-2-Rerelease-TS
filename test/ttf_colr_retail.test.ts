// qcommon/ttf.ts's COLR v0 + CPAL color-glyph compositing (parseCOLR/
// parseCPAL, ParsedFontT.colorLayers()/paletteColor(), rasterizeColorGlyph())
// against the REAL retail controller-icon fonts: the 7 KexControllerIcons*
// .ttf files shipped under fonts/ inside the retail rerelease KPF
// (Q2Game.kpf). See ttf.ts's own header comment ("COLR v0 + CPAL color
// glyphs -- IMPLEMENTED") and test/ttf_retail.test.ts's own COLR finding
// (the glyf/loca-decoder-works-on-real-data test just above this file's
// concern) for the background: every one of these 7 fonts carries COLR/
// CPAL/GDEF tables, with cmap-reachable "base" glyphs that are legitimately
// empty outlines by the COLR v0 design -- the actual multi-color
// button-icon artwork lives in separate, higher-numbered "layer" glyphs a
// COLR table composites with per-layer palette colors from CPAL.
//
// No retail content is read into this repository or committed anywhere:
// the KPF is read directly from the user's local retail install path at
// test-run time via this project's own qcommon/zipfile.ts ZipArchive
// reader (raw node:fs read of the .kpf, NOT the engine's FS_* module --
// same "don't mutate the shared fs_searchpaths singleton" reasoning
// test/ttf_retail.test.ts's own header documents), and rasterized pixels
// never touch disk. If the retail install isn't present (e.g. CI), every
// test in this file skips itself (bun test reports each skip by name)
// rather than failing.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ZipArchive } from "../src/qcommon/zipfile";
import { parseFont, rasterizeColorGlyph } from "../src/qcommon/ttf";

const KPF_PATH = "/home/buzzkill/q2rets/rerelease/Q2Game.kpf";
const haveKpf = existsSync(KPF_PATH);

// All 7 real COLR v0 + CPAL controller-icon fonts (verified against the
// real sfnt table directory -- see test/ttf_retail.test.ts's RETAIL_FONTS
// list, same file set, "glyf" outline format for every one of these 7).
const CONTROLLER_FONTS = [
  "KexControllerIconsDS4.ttf",
  "KexControllerIconsDSense.ttf",
  "KexControllerIconsGeneric.ttf",
  "KexControllerIconsMouse.ttf",
  "KexControllerIconsSwitchJoy.ttf",
  "KexControllerIconsSwitchPro.ttf",
  "KexControllerIconsXbox.ttf",
];

function openKpf(): ZipArchive {
  const buf = readFileSync(KPF_PATH);
  const archive = ZipArchive.open(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (!archive) throw new Error("failed to open Q2Game.kpf as a zip archive");
  return archive;
}

describe("ttf.ts -- COLR v0 + CPAL compositing against the real retail controller-icon fonts, skipped if the retail install isn't present", () => {
  if (!haveKpf) {
    test.skip(`SKIPPED (no retail install at ${KPF_PATH}): COLR/CPAL retail byte-vector tests need the real Q2Game.kpf`, () => {});
  }

  test.skipIf(!haveKpf)("every one of the 7 KexControllerIcons*.ttf fonts: every cmap-mapped icon codepoint in the private-use-area icon range resolves to a COLR base glyph with 1+ layers, each layer gid has real outline geometry, and each layer's palette index resolves to an opaque CPAL color", () => {
    const archive = openKpf();
    for (const file of CONTROLLER_FONTS) {
      const bytes = archive.readFile(`fonts/${file}`);
      expect(bytes, `${file}: not found in Q2Game.kpf`).not.toBeNull();
      const parsed = parseFont(bytes!);
      if (!parsed.ok) throw new Error(`${file}: parseFont failed: ${parsed.reason}`);
      const font = parsed.font;

      // Different fonts in this set base their icon range at different PUA
      // starting points (verified against the real bytes: DS4 starts at
      // 0xF0000, Mouse starts at 0xF0100) -- scan the whole 0xF0000-0xF01FF
      // block rather than hardcoding one base per font.
      let checkedAny = false;
      for (let cp = 0xf0000; cp <= 0xf01ff; cp++) {
        const gid = font.cmapLookup(cp);
        if (gid === 0) continue;
        const layers = font.colorLayers(gid);
        if (layers === null) continue; // gid 1 (the blank cp=0x0 placeholder) legitimately has no COLR record
        checkedAny = true;
        expect(layers.length, `${file}: cp 0x${cp.toString(16)} (gid ${gid}) has a COLR record with zero layers`).toBeGreaterThan(0);
        for (const layer of layers) {
          expect(font.contours(layer.gid).length, `${file}: cp 0x${cp.toString(16)} layer gid ${layer.gid} has no outline geometry`).toBeGreaterThan(0);
          if (layer.paletteIndex !== 0xffff) {
            const color = font.paletteColor(layer.paletteIndex);
            expect(color, `${file}: layer gid ${layer.gid} palette index ${layer.paletteIndex} does not resolve to a CPAL entry`).not.toBeNull();
            expect(color!.a, `${file}: layer gid ${layer.gid} resolved to a fully transparent CPAL color`).toBeGreaterThan(0);
          }
        }
      }
      expect(checkedAny, `${file}: no icon codepoint in the scanned PUA range resolved to a COLR base glyph at all`).toBe(true);
    }
  });

  test.skipIf(!haveKpf)("KexControllerIconsDS4.ttf codepoint 0xF0000 (a known button glyph): COLR base glyph has the real 3-layer record with the real per-layer palette indices and CPAL colors", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/KexControllerIconsDS4.ttf");
    expect(bytes).not.toBeNull();
    const parsed = parseFont(bytes!);
    if (!parsed.ok) throw new Error(`parseFont failed: ${parsed.reason}`);
    const font = parsed.font;

    const gid = font.cmapLookup(0xf0000);
    expect(gid, "cmap has no entry for codepoint 0xF0000").toBeGreaterThan(0);

    const layers = font.colorLayers(gid);
    expect(layers, `gid ${gid} has no COLR base-glyph record`).not.toBeNull();
    // Real bytes (verified against the shipped font): 3 layers, gids
    // 23/24/25, palette indices 0/1/2 in bottom-to-top paint order.
    expect(layers).toEqual([
      { gid: 23, paletteIndex: 0 },
      { gid: 24, paletteIndex: 1 },
      { gid: 25, paletteIndex: 2 },
    ]);

    // Real CPAL palette 0 entries for those 3 indices (BGRA-order bytes
    // decoded to {r,g,b,a} -- see parseCPAL's own doc comment on the byte
    // order).
    expect(font.paletteColor(0)).toEqual({ r: 75, g: 75, b: 77, a: 255 });
    expect(font.paletteColor(1)).toEqual({ r: 35, g: 31, b: 32, a: 255 });
    expect(font.paletteColor(2)).toEqual({ r: 0, g: 160, b: 136, a: 255 });
  });

  test.skipIf(!haveKpf)("KexControllerIconsDS4.ttf codepoint 0xF0000: rasterizeColorGlyph composites the 3 layers into a genuinely non-monochrome RGBA bitmap containing all 3 real CPAL colors as exact, high-alpha pixels", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/KexControllerIconsDS4.ttf");
    expect(bytes).not.toBeNull();
    const parsed = parseFont(bytes!);
    if (!parsed.ok) throw new Error(`parseFont failed: ${parsed.reason}`);
    const font = parsed.font;

    const gid = font.cmapLookup(0xf0000);
    const raster = rasterizeColorGlyph(font, gid, 32);
    expect(raster, "rasterizeColorGlyph returned null for a real COLR base glyph").not.toBeNull();
    expect(raster!.width).toBeGreaterThan(0);
    expect(raster!.height).toBeGreaterThan(0);
    expect(raster!.pixels.length).toBe(raster!.width * raster!.height * 4);

    // Collect every sufficiently-opaque pixel's RGB triple. Non-overlapping
    // solid interior regions of a layer land on that layer's exact CPAL
    // color with this rasterizer's compositing math (compositeOver's RGB
    // output is exactly the source color whenever the destination pixel
    // starts fully transparent, regardless of edge-AA alpha), so this is a
    // real "which real palette colors actually got painted" check, not a
    // fuzzy color-difference heuristic.
    const opaqueColors = new Map<string, number>();
    for (let i = 0; i < raster!.width * raster!.height; i++) {
      const o = i * 4;
      if (raster!.pixels[o + 3] < 200) continue;
      const key = `${raster!.pixels[o]},${raster!.pixels[o + 1]},${raster!.pixels[o + 2]}`;
      opaqueColors.set(key, (opaqueColors.get(key) ?? 0) + 1);
    }

    // Non-monochrome: more than one distinct opaque color actually appears
    // in the rasterized bitmap -- this is the load-bearing "compositing
    // really happened" assertion (a broken compositor that only painted the
    // top layer, or that painted every layer the same flat white the way
    // buildFontAtlas's plain grayscale path does, would produce exactly one
    // opaque color here).
    expect(opaqueColors.size, `expected multiple distinct opaque colors, got: ${[...opaqueColors.keys()].join(" | ")}`).toBeGreaterThan(1);

    // And those colors are the REAL CPAL palette entries this glyph's own
    // layers reference (verified real bytes, same as the previous test).
    expect(opaqueColors.get("75,75,77"), "expected layer 0's exact CPAL color (75,75,77) somewhere in the raster").toBeGreaterThan(0);
    expect(opaqueColors.get("35,31,32"), "expected layer 1's exact CPAL color (35,31,32) somewhere in the raster").toBeGreaterThan(0);
    expect(opaqueColors.get("0,160,136"), "expected layer 2's exact CPAL color (0,160,136) somewhere in the raster").toBeGreaterThan(0);
  });

  test.skipIf(!haveKpf)("rasterizeColorGlyph returns null for a glyph with no COLR base-glyph record (not a color glyph)", () => {
    const archive = openKpf();
    const bytes = archive.readFile("fonts/KexControllerIconsDS4.ttf");
    expect(bytes).not.toBeNull();
    const parsed = parseFont(bytes!);
    if (!parsed.ok) throw new Error(`parseFont failed: ${parsed.reason}`);
    const font = parsed.font;

    // gid 0 (.notdef) is never a COLR base glyph in this font.
    expect(font.colorLayers(0)).toBeNull();
    expect(rasterizeColorGlyph(font, 0, 32)).toBeNull();
  });
});
