/*
THE KFONT ATLAS IS NOT SPECIAL -- it registers as a plain pic, and the
non-power-of-two fix that makes it legible lives in the upload path.

HISTORY. The owner's play-test found the help computer's "Primary Objective"
drawn with broken, half-overlapping letterforms carrying fragments of other
glyphs. The cause was never in the draw: drawKfontChar already sizes the quad
and advances the pen by the same `ch.w * scale`. It was in the UPLOAD --
gl_image.ts's GL_Upload32 rounded the 195x252 fonts/qconfont.png up to 256x256
and resampled it, so every 8x14 glyph cell stopped landing on texel boundaries
and each glyph's source rect sampled a smear of itself plus its neighbours.

The first fix padded the atlas here, in host.ts. That was too narrow: 156 of
the 179 PNGs under pics/ and fonts/ in the re-release paks are
non-power-of-two, as are 116 of the 125 pics in the 1997 baseq2 pak0, and all
of them were being resampled identically -- the font was just the asset where
a sub-rectangle draw made it obvious. The padding is gone; GL_Upload32 now
uploads non-mipmapped images at their native size when the context supports it
(gl_config.npot). test/gl_image.test.ts pins that upload behavior directly.

WHAT IS PINNED HERE
  1. loadKfontAsset registers the atlas as an ordinary pic under its own
     "/"-prefixed path and draws from exactly that name -- no second,
     font-specific registration mechanism, whatever the atlas's dimensions.
  2. The glyph quad and the pen advance still scale by the same factor. That
     property was never broken and must not be introduced as a regression.

Self-sufficient per .orch/preferences.md rule 13: a real temp filesystem (the
pattern test/cgame_host_kfont_source.test.ts uses) and a capturing fake
RefExports. No retail data, no renderer, no server.
*/

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_InitFilesystem, FS_SetGamedir } from "../src/qcommon/files";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { setRe } from "../src/client/client";
import { buildCgameImports } from "../src/client/cgame/host";
import { API_VERSION, type RefExports, type ImageS, type DrawColorT } from "../src/client/ref";
import { TextAlignT, rgba_white } from "../src/kexapi/game";

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
  rawNames: string[];
  pics: string[];
  regions: RegionDraw[];
}

function makeCapture(): Capture {
  const rawNames: string[] = [];
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
    RegisterRawPic: (name: string): ImageS | null => {
      rawNames.push(name);
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
  return { re, rawNames, pics, regions };
}

const root = mkdtempSync(join(tmpdir(), "q2-kfont-atlas-"));
const gamedir = join(root, "baseq2");
mkdirSync(join(gamedir, "fonts"), { recursive: true });

/** One mapped glyph ('A', codepoint 65) at (1, 2), 3 wide, 5 tall, so a
 *  draw's source rect is unambiguous. */
function writeKfont(textureToken: string): void {
  writeFileSync(join(gamedir, "fonts", "qconfont.kfont"), `texture "${textureToken}"\nunicode\nmapchar\n{\n65 1 2 3 5 0\n}\n`);
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("kfont atlas registration", () => {
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

  test("the atlas registers as an ordinary pic and is drawn from that same name", () => {
    writeKfont("fonts/atlas_a.png");

    const imports = buildCgameImports();
    imports.SCR_DrawFontString("A", 0, 0, 1, rgba_white, false, TextAlignT.LEFT);

    expect(cap.pics).toContain("/fonts/atlas_a.png");
    expect(cap.regions[cap.regions.length - 1]?.name).toBe("/fonts/atlas_a.png");
    // No second, font-specific registration mechanism: the padded-atlas
    // RegisterRawPic path this file used to pin is gone on purpose.
    expect(cap.rawNames).toEqual([]);
  });

  test("a .tga atlas takes exactly the same single path", () => {
    // The old padding path keyed off the ".png" extension, so a .tga atlas
    // silently took a different route. There is only one route now.
    writeKfont("fonts/atlas_b.tga");

    const imports = buildCgameImports();
    imports.SCR_DrawFontString("A", 0, 0, 1, rgba_white, false, TextAlignT.LEFT);

    expect(cap.pics).toContain("/fonts/atlas_b.tga");
    expect(cap.regions[cap.regions.length - 1]?.name).toBe("/fonts/atlas_b.tga");
    expect(cap.rawNames).toEqual([]);
  });

  test("the glyph quad and the pen advance scale by the same factor", () => {
    // The property the defect was first attributed to. It already held, and
    // neither the atlas fix nor its removal may break it: at 2x the quad is
    // twice as large AND the next glyph starts twice as far along, with the
    // SOURCE rect unchanged (it is atlas texels, not screen pixels).
    writeKfont("fonts/atlas_c.png");

    const imports = buildCgameImports();
    for (const scale of [1, 2, 4]) {
      cap.regions.length = 0;
      imports.SCR_DrawFontString("AA", 0, 0, scale, rgba_white, false, TextAlignT.LEFT);
      expect(cap.regions.length).toBe(2);
      const [a, b] = cap.regions as [RegionDraw, RegionDraw];
      expect({ w: a.w, h: a.h }).toEqual({ w: 3 * scale, h: 5 * scale });
      expect(b.x - a.x).toBe(3 * scale); // advance == quad width
      expect({ srcX: a.srcX, srcY: a.srcY, srcW: a.srcW, srcH: a.srcH }).toEqual({ srcX: 1, srcY: 2, srcW: 3, srcH: 5 });
      expect({ srcX: b.srcX, srcY: b.srcY, srcW: b.srcW, srcH: b.srcH }).toEqual({ srcX: 1, srcY: 2, srcW: 3, srcH: 5 });
    }
  });
});
