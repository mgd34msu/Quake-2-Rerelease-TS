// client/cgame/host.ts's drawKfontChar (exported for testing) -- selects an
// UNTINTED DrawColorT (white RGB, caller's alpha preserved) for a COLR/CPAL
// color-icon glyph region (KfontCharT.color === true) instead of the
// caller's own text color, which every ordinary (non-color) glyph still
// gets. See drawKfontChar's own doc comment (host.ts) for the full "why a
// dedicated single-glyph test, not a string-level one" writeup: PUA icon
// codepoints (0xF0000+) are astral-plane and cannot be carried through a
// plain JS string via the *StringStretch functions' charCodeAt-based
// iteration (a pre-existing limitation, not something this fix introduces
// or needs to touch -- q2repro's own SCR_DrawKStringStretch is even more
// restricted, passing a raw byte as the codepoint), so this exercises
// drawKfontChar directly with the exact ActiveKfontT.lookup shape both
// wrapClassicKfont and wrapTtfKfont (host.ts) already funnel through -- no
// real TTF parse or retail dependency needed to prove the tint-selection
// logic itself (test/ttf_colr_atlas_retail.test.ts covers the real-bytes
// atlas-bake half against the retail install).
//
// Uses the same full-RefExports-fake + drawStretchPicRegionCalls spy-log
// pattern test/cgame_draw.test.ts's own makeFakeRe already establishes, and
// the same real-`setRe`-fake precedent test/cgame_host_kfont_source.test.ts
// uses. Self-sufficient per PORTING.md/.orch/preferences.md rule 13:
// `re` is set to a fresh fake per test in beforeEach.

import { describe, test, expect, beforeEach } from "bun:test";
import { drawKfontChar, type ActiveKfontT } from "../src/client/cgame/host";
import { setRe } from "../src/client/client";
import { API_VERSION, type RefExports, type ImageS, type DrawColorT } from "../src/client/ref";
import type { KfontCharT } from "../src/client/cgame/kfont";

type DrawStretchPicRegionCall = { x: number; y: number; w: number; h: number; name: string; srcX: number; srcY: number; srcW: number; srcH: number; color: DrawColorT };

function makeFakeRe(): RefExports & { drawStretchPicRegionCalls: DrawStretchPicRegionCall[] } {
  const fake = {
    drawStretchPicRegionCalls: [] as DrawStretchPicRegionCall[],
    api_version: API_VERSION,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (): ImageS | null => null,
    RegisterRawPic: (): ImageS | null => null,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: -1, h: -1 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: () => undefined,
    DrawStretchPicRegion(x: number, y: number, w: number, h: number, name: string, srcX: number, srcY: number, srcW: number, srcH: number, color: DrawColorT) {
      fake.drawStretchPicRegionCalls.push({ x, y, w, h, name, srcX, srcY, srcW, srcH, color });
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
  return fake;
}

function makeFont(chars: Map<number, KfontCharT>): ActiveKfontT {
  return {
    pic: "/ttf:fake:16",
    line_height: 16,
    lookup(codepoint: number): KfontCharT | null {
      return chars.get(codepoint) ?? null;
    },
  };
}

const TEXT_COLOR: DrawColorT = { r: 200, g: 100, b: 50, a: 180 };

describe("cgame/host.ts -- drawKfontChar selects untinted draw for COLR/CPAL color regions", () => {
  let fake: ReturnType<typeof makeFakeRe>;

  beforeEach(() => {
    fake = makeFakeRe();
    setRe(fake);
  });

  test("a color-region glyph (KfontCharT.color === true) draws with white RGB and the CALLER's alpha preserved, not the caller's own RGB", () => {
    const font = makeFont(new Map([[0xf0000, { x: 10, y: 20, w: 30, h: 40, color: true }]]));
    const advance = drawKfontChar(font, 5, 6, 2, 0xf0000, TEXT_COLOR, false);

    expect(advance).toBe(60); // ch.w * scale = 30 * 2
    expect(fake.drawStretchPicRegionCalls.length).toBe(1);
    const call = fake.drawStretchPicRegionCalls[0];
    expect(call.x).toBe(5);
    expect(call.y).toBe(6);
    expect(call.w).toBe(60);
    expect(call.h).toBe(80);
    expect(call.name).toBe(font.pic);
    expect(call.srcX).toBe(10);
    expect(call.srcY).toBe(20);
    expect(call.srcW).toBe(30);
    expect(call.srcH).toBe(40);
    expect(call.color).toEqual({ r: 255, g: 255, b: 255, a: TEXT_COLOR.a });
  });

  test("an ordinary text glyph (KfontCharT.color === false) still draws tinted by the CALLER's own color -- unchanged, pre-existing single-tint behavior", () => {
    const font = makeFont(new Map([[0x41, { x: 0, y: 0, w: 8, h: 12, color: false }]]));
    drawKfontChar(font, 0, 0, 1, 0x41, TEXT_COLOR, false);

    expect(fake.drawStretchPicRegionCalls.length).toBe(1);
    expect(fake.drawStretchPicRegionCalls[0].color).toEqual(TEXT_COLOR);
  });

  test("a classic-kfont glyph (KfontCharT.color left undefined -- ParseKfont's own shape, which never sets this field) is treated the same as color=false: tinted by the caller's color", () => {
    const font = makeFont(new Map([[0x42, { x: 0, y: 0, w: 8, h: 12 }]]));
    drawKfontChar(font, 0, 0, 1, 0x42, TEXT_COLOR, false);

    expect(fake.drawStretchPicRegionCalls.length).toBe(1);
    expect(fake.drawStretchPicRegionCalls[0].color).toEqual(TEXT_COLOR);
  });

  test("shadow pass for a color-region glyph still draws a black offset copy first (the untinted-region selection only replaces the MAIN draw call's color, not the shadow branch's), then the untinted main draw", () => {
    const font = makeFont(new Map([[0xf0000, { x: 10, y: 20, w: 30, h: 40, color: true }]]));
    drawKfontChar(font, 5, 6, 2, 0xf0000, TEXT_COLOR, true);

    expect(fake.drawStretchPicRegionCalls.length).toBe(2);
    const [shadowCall, mainCall] = fake.drawStretchPicRegionCalls;
    expect(shadowCall.x).toBe(5 + 2); // x + 1*scale
    expect(shadowCall.y).toBe(6 + 2);
    expect(shadowCall.color).toEqual({ r: 0, g: 0, b: 0, a: TEXT_COLOR.a });
    expect(mainCall.x).toBe(5);
    expect(mainCall.color).toEqual({ r: 255, g: 255, b: 255, a: TEXT_COLOR.a });
  });

  test("re === null: returns 0 and issues no draw call, same re-null guard every other kfont draw function has", () => {
    setRe(null);
    const font = makeFont(new Map([[0xf0000, { x: 10, y: 20, w: 30, h: 40, color: true }]]));
    const advance = drawKfontChar(font, 5, 6, 2, 0xf0000, TEXT_COLOR, false);
    expect(advance).toBe(0);
  });

  test("codepoint not present in the font's lookup: returns 0 and issues no draw call", () => {
    const font = makeFont(new Map());
    const advance = drawKfontChar(font, 5, 6, 2, 0xf0000, TEXT_COLOR, false);
    expect(advance).toBe(0);
    expect(fake.drawStretchPicRegionCalls.length).toBe(0);
  });
});
