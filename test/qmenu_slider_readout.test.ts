/*
Test for MenusliderS.valueFormatter (src/client/qmenu.ts) and Slider_Draw's
readout draw (src/client/qmenu_impl.ts) -- QoL addition (Mike, 2026-09-01):
a slider with a formatter set draws its live curvalue -> display-string just
past the track; a slider with no formatter renders byte-for-byte the same as
before the patch.

Self-sufficient per PORTING.md rule 13: fabricates its own MenuframeworkS/
MenusliderS rather than reaching into any real per-screen menu, and installs
a fresh spying RefExports (setRe) per test rather than relying on another
test file's state.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { setRe } from "../src/client/client";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { MenuframeworkS, MenusliderS } from "../src/client/qmenu";
import { Menu_AddItem, Menu_Draw } from "../src/client/qmenu_impl";

interface DrawCharCall {
  x: number;
  y: number;
  c: number;
}
interface DrawFillCall {
  x: number;
  y: number;
  w: number;
  h: number;
  c: number;
}

// Full RefExports fake (every member implemented, no partial/cast), same
// convention as test/cgame_draw.test.ts's makeFakeRe.
function makeFakeRe(): RefExports & { drawCharCalls: DrawCharCall[]; drawFillCalls: DrawFillCall[] } {
  const fake = {
    drawCharCalls: [] as DrawCharCall[],
    drawFillCalls: [] as DrawFillCall[],

    api_version: 3,
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
    DrawGetPicSize: (_name: string) => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _srcX: number, _srcY: number, _srcW: number, _srcH: number, _color: DrawColorT) => undefined,
    DrawChar(x: number, y: number, c: number) {
      fake.drawCharCalls.push({ x, y, c });
    },
    DrawTileClear: () => undefined,
    DrawFill(x: number, y: number, w: number, h: number, c: number) {
      fake.drawFillCalls.push({ x, y, w, h, c });
    },
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

// Slider_Draw's own track geometry (qmenu_impl.ts): RCOLUMN_OFFSET=16,
// SLIDER_RANGE=10, trackW=(SLIDER_RANGE+2)*8=96. With menu.x=0, item x=0,
// item y=0: trackX=16, trackY=0, trackW=96, so the readout (if any) starts
// at trackX+trackW+8=120.
const TRACK_X = 16;
const TRACK_Y = 0;
const TRACK_W = 96;
const READOUT_X = TRACK_X + TRACK_W + 8;

function buildMenuWithSlider(): { menu: MenuframeworkS; slider: MenusliderS } {
  const menu = new MenuframeworkS();
  const slider = new MenusliderS();
  slider.generic.type = 0; // MTYPE_SLIDER
  slider.generic.x = 0;
  slider.generic.y = 0;
  // generic.name left null -> Slider_Draw's own `?? ""` skips the label
  // entirely (Menu_DrawStringR2LDark("") draws zero chars), isolating the
  // assertions below to just the track + readout.
  slider.minvalue = 0;
  slider.maxvalue = 10;
  slider.curvalue = 5;
  Menu_AddItem(menu, slider);
  return { menu, slider };
}

beforeEach(() => {
  setRe(null);
});

describe("Slider_Draw -- no formatter set (byte-for-byte pre-patch rendering)", () => {
  test("draws exactly the track fills + thumb char + cursor frame char, nothing past the track", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu } = buildMenuWithSlider();

    Menu_Draw(menu);

    // 3 track fills (groove, left cap, right cap) + 1 statusbar fill (menu.statusbar is null)
    expect(fake.drawFillCalls.length).toBe(4);
    // 1 thumb char + 1 cursor-frame char (menu.cursor defaults to 0, the only item)
    expect(fake.drawCharCalls.length).toBe(2);

    // thumb: DrawChar(8 + RCOLUMN_OFFSET + parent.x + generic.x + (SLIDER_RANGE-1)*8*range, generic.y+parent.y, 131)
    // range = (5-0)/(10-0) = 0.5 -> x = 8+16+0+0+9*8*0.5 = 60
    expect(fake.drawCharCalls[0]).toEqual({ x: 60, y: TRACK_Y, c: 131 });

    // nothing drawn at or past the readout column
    for (const call of fake.drawCharCalls) {
      expect(call.x).toBeLessThan(READOUT_X);
    }
  });
});

describe("Slider_Draw -- formatter set draws the live value past the track", () => {
  test("single-word formatter output (no space)", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu, slider } = buildMenuWithSlider();
    slider.valueFormatter = () => "75%";

    Menu_Draw(menu);

    // track fills unaffected
    expect(fake.drawFillCalls.length).toBe(4);
    // thumb + 3 readout chars + cursor frame
    expect(fake.drawCharCalls.length).toBe(1 + 3 + 1);

    const readout = fake.drawCharCalls.slice(1, 1 + 3);
    const str = "75%";
    for (let i = 0; i < str.length; i++) {
      expect(readout[i]).toEqual({ x: READOUT_X + i * 8, y: TRACK_Y, c: str.charCodeAt(i) });
    }
  });

  test("multi-word / spaced formatter output -- the exact scale-slider native reference point", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu, slider } = buildMenuWithSlider();
    // matches vid_menu.ts's ScaleFormatter at curvalue=10 (scale 1.0, VID_SCALE_MAX)
    const str = "1.00x (native)";
    slider.valueFormatter = () => str;

    Menu_Draw(menu);

    expect(fake.drawFillCalls.length).toBe(4);
    expect(fake.drawCharCalls.length).toBe(1 + str.length + 1);

    const readout = fake.drawCharCalls.slice(1, 1 + str.length);
    for (let i = 0; i < str.length; i++) {
      expect(readout[i]).toEqual({ x: READOUT_X + i * 8, y: TRACK_Y, c: str.charCodeAt(i) });
    }
  });

  test("formatter receives the slider's own curvalue", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu, slider } = buildMenuWithSlider();
    slider.curvalue = 7;
    const seen: number[] = [];
    slider.valueFormatter = (curvalue: number) => {
      seen.push(curvalue);
      return "x";
    };

    Menu_Draw(menu);

    expect(seen).toEqual([7]);
  });
});
