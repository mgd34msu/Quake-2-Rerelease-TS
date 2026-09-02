/*
KFONT ATLAS UPLOAD -- a font atlas must reach the renderer at 1:1 texels.

THE DEFECT this pins (owner play-test: the help computer's "Primary
Objective" drawn with broken, half-overlapping letterforms with fragments of
other glyphs inside them, under +set game kex on the re-release tree).

gl_image.ts's GL_Upload32 does what vanilla's does: round each axis up to the
next power of two and, when that differs from the source size, RESAMPLE the
whole image into it (GL_ResampleTexture, a point-sampled 2x2 box filter with a
non-integer step). Harmless for an ordinary pic, which is drawn whole -- the
0..1 texcoords still cover the same picture. Ruinous for an ATLAS, which is
drawn one sub-rectangle at a time: the retail fonts/qconfont.png is 195x252,
so every 8x14 glyph cell got stretched by 256/195 and 256/252, its boundaries
stopped landing on texel boundaries, and each glyph's source region sampled a
smear of that glyph plus its neighbours' columns.

Nothing about the DRAW was wrong -- drawKfontChar already sizes the quad and
advances the pen by the same `ch.w * scale` -- so the fix is on the upload
side: host.ts's registerKfontAtlas pads the decoded atlas to a power of two
(padding at right/bottom, so every .kfont (x, y, w, h) still addresses the
same texels) and registers it through RefExports.RegisterRawPic, which
GL_Upload32 then uploads untouched. Deliberately scoped to this asset:
changing GL_Upload32 itself would move every non-power-of-two pic in the game,
including the 16x24 sb_nums digits and the 128x24 menu plaques the 1997-era
data ships.

WHAT IS PINNED
  1. A non-power-of-two atlas is padded to the next power of two on each
     axis, registered raw, and drawn from under a distinct name -- with the
     original pixels still at their original (x, y).
  2. A power-of-two atlas keeps the plain RegisterPic path (nothing to pad;
     GL_Upload32 uploads those unresampled already).
  3. A non-PNG atlas token keeps the plain RegisterPic path (no decoder), and
     so does an undecodable file -- the pre-fix behavior, unchanged.
  4. The glyph quad and the pen advance both scale by the draw's `scale`, at
     1x and at 2x. (The mismatch this was first attributed to does not exist,
     and must not be introduced.)

Self-sufficient per .orch/preferences.md rule 13: a real temp filesystem
(mkdtempSync, the same pattern test/cgame_host_kfont_source.test.ts uses) with
hand-written .kfont + PNG assets, and a capturing fake RefExports. No retail
data, no renderer, no server.
*/

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { FS_InitFilesystem, FS_SetGamedir } from "../src/qcommon/files";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { setRe } from "../src/client/client";
import { buildCgameImports } from "../src/client/cgame/host";
import { decodePNG } from "../src/qcommon/png";
import { API_VERSION, type RefExports, type ImageS, type DrawColorT } from "../src/client/ref";
import { TextAlignT, rgba_white } from "../src/kexapi/game";

// ---------------------------------------------------------------------------
// A minimal RGBA8 PNG encoder (no filtering, no interlace) -- the repo has a
// decoder (qcommon/png.ts) but no encoder, and this suite needs a REAL PNG on
// a real filesystem for host.ts's own FS_LoadFile + decodePNG path to run.
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePNG(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter type 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A deterministic, per-pixel-unique RGBA image, so a padded copy can be
 *  checked pixel by pixel against its source. */
function rampPixels(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px[o] = (x * 17 + 1) & 255;
      px[o + 1] = (y * 29 + 3) & 255;
      px[o + 2] = (x * y + 7) & 255;
      px[o + 3] = 255;
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RawReg {
  name: string;
  width: number;
  height: number;
  pixels: Uint8Array;
}
interface RegionDraw {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

interface Capture {
  re: RefExports;
  raw: RawReg[];
  pics: string[];
  regions: RegionDraw[];
}

function makeCapture(): Capture {
  const raw: RawReg[] = [];
  const pics: string[] = [];
  const regions: RegionDraw[] = [];
  const re: RefExports = {
    api_version: API_VERSION,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (name: string): ImageS | null => {
      pics.push(name);
      return {} as ImageS;
    },
    RegisterRawPic: (name: string, pixels: Uint8Array, width: number, height: number): ImageS | null => {
      raw.push({ name, width, height, pixels: pixels.slice() });
      return {} as ImageS;
    },
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: () => undefined,
    DrawStretchPicRegion: (x: number, y: number, w: number, h: number, name: string, srcX: number, srcY: number, srcW: number, srcH: number, _color: DrawColorT) => {
      regions.push({ x, y, w, h, name, srcX, srcY, srcW, srcH });
    },
    DrawChar: () => undefined,
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    SetGifBeatSeconds: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return { re, raw, pics, regions };
}

const root = mkdtempSync(join(tmpdir(), "q2-kfont-atlas-"));
const gamedir = join(root, "baseq2");
mkdirSync(join(gamedir, "fonts"), { recursive: true });

/** One mapped glyph ('A', codepoint 65) at (1, 2), 3 wide, 5 tall, so both a
 *  draw's source rect and the atlas padding are unambiguous. */
function writeKfont(file: string, textureToken: string): void {
  writeFileSync(join(gamedir, "fonts", file), `texture "${textureToken}"\nunicode\nmapchar\n{\n65 1 2 3 5 0\n}\n`);
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Draws one 'A' through the public import surface and returns what the
 *  renderer saw. `scale` is the HUD scale the cgame would pass. */
function drawA(cap: Capture, scale: number): RegionDraw {
  const imports = buildCgameImports();
  imports.SCR_DrawFontString("A", 0, 0, scale, rgba_white, false, TextAlignT.LEFT);
  const hit = cap.regions[cap.regions.length - 1];
  if (!hit) throw new Error("no glyph was drawn");
  return hit;
}

describe("kfont atlas reaches the renderer at 1:1 texels", () => {
  let cap: Capture;

  beforeEach(() => {
    cap = makeCapture();
    setRe(cap.re);
    Cvar_ForceSet("basedir", root);
    FS_InitFilesystem();
    FS_SetGamedir("");
    // "kfont" is the default source; force it so a stale cvar from another
    // suite in the same process cannot select the TTF or classic path.
    Cvar_Get("cl_kfont_source", "kfont", 0);
    Cvar_ForceSet("cl_kfont_source", "kfont");
  });

  test("a non-power-of-two atlas is padded, registered raw, and drawn from the padded copy", () => {
    const W = 3;
    const H = 5;
    // qconfont.kfont's own name, because host.ts loads that exact filename.
    writeFileSync(join(gamedir, "fonts", "atlas_npot.png"), encodePNG(W, H, rampPixels(W, H)));
    writeKfont("qconfont.kfont", "fonts/atlas_npot.png");

    const draw = drawA(cap, 1);

    expect(cap.raw.length).toBe(1);
    const reg = cap.raw[0]!;
    expect({ width: reg.width, height: reg.height }).toEqual({ width: 4, height: 8 });
    expect(reg.name.startsWith("kfontatlas:")).toBe(true);
    // Registered WITHOUT the leading "/", drawn WITH it -- Draw_FindPic
    // strips the slash before matching the stored name.
    expect(draw.name).toBe("/" + reg.name);
    expect(cap.pics).not.toContain("/fonts/atlas_npot.png");

    // Every source pixel is still at its own (x, y) in the padded copy, and
    // the padding is transparent. This is what keeps the .kfont's own
    // (x, y, w, h) valid without rewriting a single glyph rect.
    const src = rampPixels(W, H);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * 4 + x) * 4;
        const inside = x < W && y < H;
        const want = inside ? Array.from(src.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)) : [0, 0, 0, 0];
        expect(Array.from(reg.pixels.subarray(o, o + 4))).toEqual(want);
      }
    }
  });

  test("the padded atlas is a real, decodable image of the padded size", () => {
    const W = 3;
    const H = 5;
    const png = encodePNG(W, H, rampPixels(W, H));
    writeFileSync(join(gamedir, "fonts", "atlas_npot2.png"), png);
    writeKfont("qconfont.kfont", "fonts/atlas_npot2.png");
    drawA(cap, 1);

    // Sanity on the encoder this suite depends on: the bytes written really
    // do decode back to the source image, so a padding mismatch above would
    // be the code's fault and not the fixture's.
    const decoded = decodePNG(png);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect({ w: decoded.image.width, h: decoded.image.height }).toEqual({ w: W, h: H });
      expect(Array.from(decoded.image.pixels)).toEqual(Array.from(rampPixels(W, H)));
    }
  });

  test("a power-of-two atlas keeps the plain RegisterPic path -- nothing to pad", () => {
    writeFileSync(join(gamedir, "fonts", "atlas_pot.png"), encodePNG(8, 16, rampPixels(8, 16)));
    writeKfont("qconfont.kfont", "fonts/atlas_pot.png");

    const draw = drawA(cap, 1);

    expect(cap.raw.length).toBe(0);
    expect(cap.pics).toContain("/fonts/atlas_pot.png");
    expect(draw.name).toBe("/fonts/atlas_pot.png");
  });

  test("a non-PNG atlas token keeps the plain RegisterPic path", () => {
    writeKfont("qconfont.kfont", "fonts/atlas.tga");

    const draw = drawA(cap, 1);

    expect(cap.raw.length).toBe(0);
    expect(draw.name).toBe("/fonts/atlas.tga");
  });

  test("an undecodable atlas file keeps the plain RegisterPic path", () => {
    writeFileSync(join(gamedir, "fonts", "atlas_bad.png"), Buffer.from("not a png at all, but long enough to get past the length check"));
    writeKfont("qconfont.kfont", "fonts/atlas_bad.png");

    const draw = drawA(cap, 1);

    expect(cap.raw.length).toBe(0);
    expect(draw.name).toBe("/fonts/atlas_bad.png");
  });

  test("the glyph quad and the pen advance scale by the same factor", () => {
    // The property the defect was first attributed to. It already held, and
    // the atlas fix must not break it: at 2x the quad is twice as large AND
    // the next glyph starts twice as far along, with the SOURCE rect
    // unchanged (it is atlas texels, not screen pixels).
    writeFileSync(join(gamedir, "fonts", "atlas_adv.png"), encodePNG(3, 5, rampPixels(3, 5)));
    writeKfont("qconfont.kfont", "fonts/atlas_adv.png");

    const imports = buildCgameImports();
    for (const scale of [1, 2, 4]) {
      cap.regions.length = 0;
      imports.SCR_DrawFontString("AA", 0, 0, scale, rgba_white, false, TextAlignT.LEFT);
      expect(cap.regions.length).toBe(2);
      const [a, b] = cap.regions as [RegionDraw, RegionDraw];
      expect({ w: a.w, h: a.h }).toEqual({ w: 3 * scale, h: 5 * scale });
      expect(b.x - a.x).toBe(3 * scale); // advance == quad width
      // The source rect is the .kfont's own cell at every scale.
      expect({ srcX: a.srcX, srcY: a.srcY, srcW: a.srcW, srcH: a.srcH }).toEqual({ srcX: 1, srcY: 2, srcW: 3, srcH: 5 });
      expect({ srcX: b.srcX, srcY: b.srcY, srcW: b.srcW, srcH: b.srcH }).toEqual({ srcX: 1, srcY: 2, srcW: 3, srcH: 5 });
    }
  });
});
