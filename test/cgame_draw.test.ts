// Phase-7 unit: the draw primitives the cgame host (src/client/cgame/host.ts)
// stubs out -- SCR_DrawColorPic, SCR_DrawFontString/MeasureFontString/
// FontLineHeight/SetAltTypeface, Draw_RegisterPic/Draw_GetPicSize,
// SCR_DrawBind, CL_GetKeyBinding. See host.ts's own doc comments (the kfont
// finding on SCR_SetAltTypeface, the conchars-fallback math on
// SCR_MeasureFontString/SCR_DrawFontString) for the full precedent this
// exercises.
//
// Self-sufficient per PORTING.md rule 13: keybindings and the module-level
// altTypefaceEnabled flag (read via CG_IsAltTypefaceEnabled) are reset in
// beforeEach, and `re` is set to a fresh spying fake (or null) per test
// rather than relying on another test file's state.

import { describe, test, expect, beforeEach } from "bun:test";
import { buildCgameImports, CG_IsAltTypefaceEnabled } from "../src/client/cgame/host";
import { setRe } from "../src/client/client";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { keybindings } from "../src/client/keys";
import { Key_SetBinding, Key_StringToKeynum } from "../src/client/keys_impl";
import { TextAlignT } from "../src/kexapi/game";

// Full RefExports fake (not a partial/cast -- every member is implemented,
// same convention test/client_types.test.ts uses) so this file typechecks
// against RefExports without `as`. registerPicResult/drawGetPicSizeResult
// are mutable knobs individual tests set before calling into host.ts;
// drawCharCalls/drawColorPicCalls are spy logs.
function makeFakeRe(): RefExports & {
  drawCharCalls: number[];
  drawColorPicCalls: Array<{ x: number; y: number; w: number; h: number; name: string; color: DrawColorT }>;
  drawStretchPicRegionCalls: Array<{ x: number; y: number; w: number; h: number; name: string; srcX: number; srcY: number; srcW: number; srcH: number; color: DrawColorT }>;
  registerPicResult: ImageS | null;
  drawGetPicSizeResult: { w: number; h: number };
} {
  const fake = {
    drawCharCalls: [] as number[],
    drawColorPicCalls: [] as Array<{ x: number; y: number; w: number; h: number; name: string; color: DrawColorT }>,
    drawStretchPicRegionCalls: [] as Array<{ x: number; y: number; w: number; h: number; name: string; srcX: number; srcY: number; srcW: number; srcH: number; color: DrawColorT }>,
    registerPicResult: null as ImageS | null,
    drawGetPicSizeResult: { w: -1, h: -1 },

    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic(_name: string): ImageS | null {
      return fake.registerPicResult;
    },
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize(_name: string) {
      return fake.drawGetPicSizeResult;
    },
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic(x: number, y: number, w: number, h: number, name: string, color: DrawColorT) {
      fake.drawColorPicCalls.push({ x, y, w, h, name, color });
    },
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

function bind(binding: string, command: string): void {
  const keynum = Key_StringToKeynum(binding);
  expect(keynum).not.toBe(-1);
  Key_SetBinding(keynum, command);
}

function drawnString(codes: number[]): string {
  return codes.map((c) => String.fromCharCode(c)).join("");
}

beforeEach(() => {
  keybindings.fill(null);
  setRe(null);
  // altTypefaceEnabled is module-private state in host.ts; drive it back to
  // its default via the real setter rather than reaching into the module.
  buildCgameImports().SCR_SetAltTypeface(false);
});

describe("cgame draw primitives (host.ts)", () => {
  test("SCR_MeasureFontString: single line width is length * CONCHAR_WIDTH * scale, height is CONCHAR_HEIGHT * scale", () => {
    const imports = buildCgameImports();
    const size = imports.SCR_MeasureFontString("test", 2);
    expect(size.x).toBe(4 * 8 * 2); // "test".length=4
    expect(size.y).toBe(1 * 8 * 2);
  });

  test("SCR_MeasureFontString: multi-line uses the longest line's width and sums per-line heights", () => {
    const imports = buildCgameImports();
    const size = imports.SCR_MeasureFontString("ab\nabcd\na", 1);
    expect(size.x).toBe(4 * 8); // "abcd" is the longest line
    expect(size.y).toBe(3 * 8); // 3 lines
  });

  test("SCR_FontLineHeight: kfont-less fallback is CONCHAR_HEIGHT * scale", () => {
    const imports = buildCgameImports();
    expect(imports.SCR_FontLineHeight(1)).toBe(8);
    expect(imports.SCR_FontLineHeight(3)).toBe(24);
  });

  test("SCR_DrawBind: composes '[key] purpose' when the action is bound, and returns CONCHAR_HEIGHT", () => {
    const fake = makeFakeRe();
    setRe(fake);
    bind("F1", "+use");

    const imports = buildCgameImports();
    const yAdvance = imports.SCR_DrawBind(0, "+use", "Use", 100, 50, 1);

    expect(drawnString(fake.drawCharCalls)).toBe("[F1] Use");
    expect(yAdvance).toBe(8);
  });

  test("SCR_DrawBind: composes '<unbound> purpose' when nothing is bound to the action", () => {
    const fake = makeFakeRe();
    setRe(fake);

    const imports = buildCgameImports();
    imports.SCR_DrawBind(0, "+jump", "Jump", 100, 50, 1);

    expect(drawnString(fake.drawCharCalls)).toBe("<unbound> Jump");
  });

  test("SCR_DrawColorPic: dispatches x/y/w/h/name/color straight through to RefExports.DrawColorPic", () => {
    const fake = makeFakeRe();
    setRe(fake);

    const imports = buildCgameImports();
    const color: DrawColorT = { r: 255, g: 0, b: 0, a: 128 };
    imports.SCR_DrawColorPic(10, 20, 30, 40, "pics/foo", color);

    expect(fake.drawColorPicCalls).toEqual([{ x: 10, y: 20, w: 30, h: 40, name: "pics/foo", color }]);
  });

  test("SCR_DrawColorPic: no-ops (does not throw) when the renderer isn't constructed", () => {
    setRe(null);
    const imports = buildCgameImports();
    expect(() => imports.SCR_DrawColorPic(0, 0, 1, 1, "pics/foo", { r: 1, g: 2, b: 3, a: 4 })).not.toThrow();
  });

  test("Draw_RegisterPic: true when RefExports.RegisterPic resolves, false on a miss or no renderer", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const imports = buildCgameImports();

    fake.registerPicResult = {}; // any non-null ImageS handle
    expect(imports.Draw_RegisterPic("pics/found")).toBe(true);

    fake.registerPicResult = null;
    expect(imports.Draw_RegisterPic("pics/missing")).toBe(false);

    setRe(null);
    expect(buildCgameImports().Draw_RegisterPic("pics/anything")).toBe(false);
  });

  test("Draw_GetPicSize: writes the ref layer's size into the out-param arrays, clamping a miss's -1/-1 to 0/0", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const imports = buildCgameImports();

    fake.drawGetPicSizeResult = { w: 64, h: 32 };
    const wFound: [number] = [0];
    const hFound: [number] = [0];
    imports.Draw_GetPicSize(wFound, hFound, "pics/found");
    expect(wFound[0]).toBe(64);
    expect(hFound[0]).toBe(32);

    fake.drawGetPicSizeResult = { w: -1, h: -1 };
    const wMiss: [number] = [0];
    const hMiss: [number] = [0];
    imports.Draw_GetPicSize(wMiss, hMiss, "pics/missing");
    expect(wMiss[0]).toBe(0);
    expect(hMiss[0]).toBe(0);
  });

  test("CL_GetKeyBinding: reverse-looks-up a bound command's key name, empty string when unbound", () => {
    bind("x", "+attack");
    const imports = buildCgameImports();

    expect(imports.CL_GetKeyBinding("+attack")).toBe("x");
    expect(imports.CL_GetKeyBinding("+never_bound_to_anything")).toBe("");
  });

  test("SCR_SetAltTypeface: tracks the flag rather than discarding it (kfont upgrade path)", () => {
    const imports = buildCgameImports();
    expect(CG_IsAltTypefaceEnabled()).toBe(false);

    imports.SCR_SetAltTypeface(true);
    expect(CG_IsAltTypefaceEnabled()).toBe(true);

    imports.SCR_SetAltTypeface(false);
    expect(CG_IsAltTypefaceEnabled()).toBe(false);
  });

  test("SCR_DrawFontString: draws one conchar per character in string order, honoring the fallback's LEFT alignment", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const imports = buildCgameImports();

    imports.SCR_DrawFontString("hi", 0, 0, 1, { r: 255, g: 255, b: 255, a: 255 }, false, TextAlignT.LEFT);

    expect(drawnString(fake.drawCharCalls)).toBe("hi");
  });
});
