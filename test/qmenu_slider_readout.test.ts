/*
Test for MenusliderS.valueFormatter (src/client/qmenu.ts) and Slider_Draw's
readout draw (src/client/qmenu_impl.ts) -- QoL addition (Mike, 2026-09-01):
a slider with a formatter set draws its live curvalue -> display-string just
past the track; a slider with no formatter renders byte-for-byte the same as
before the patch.

Bug fix (Mike, 2026-09-02, owner's play-test report on the Video menu: "the
formatting is shit on that screen") extends this file's own scope: the
describe block below ("SpinControl_Draw's value column matches
Slider_Draw's readout column") pins the fix for a real misalignment --
SpinControl_Draw used to draw its value at plain RCOLUMN_OFFSET (x=16)
while Slider_Draw's readout (above) draws past the slider track at
READOUT_X (x=120); any menu mixing the two widget types (Video, Options,
Controller -- every one of them does) had its value text staggered between
two different columns row to row. Both draw functions now share
VALUE_COLUMN_OFFSET (qmenu_impl.ts) -- READOUT_X below is that same
constant's value, reused for both describe blocks in this file.

Self-sufficient per PORTING.md rule 13: fabricates its own MenuframeworkS/
MenusliderS/MenulistS rather than reaching into any real per-screen menu,
and installs a fresh spying RefExports (setRe) per test rather than relying
on another test file's state.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { setRe } from "../src/client/client";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { MenuframeworkS, MenulistS, MenusliderS } from "../src/client/qmenu";
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

function buildMenuWithSpinControl(itemnames: string[], curvalue: number): { menu: MenuframeworkS; spin: MenulistS } {
  const menu = new MenuframeworkS();
  const spin = new MenulistS();
  spin.generic.type = 3; // MTYPE_SPINCONTROL -- see qmenu.ts
  spin.generic.x = 0;
  spin.generic.y = 0;
  // generic.name left null, same isolation reason buildMenuWithSlider uses.
  spin.itemnames = itemnames;
  spin.curvalue = curvalue;
  Menu_AddItem(menu, spin);
  return { menu, spin };
}

describe("SpinControl_Draw's value column", () => {
  // Vanilla's column: a spin row's value right after its label at
  // RCOLUMN_OFFSET, whether or not a slider shares the menu. Only a slider's
  // own readout sits past its track (READOUT_X). Forcing both onto one
  // shared column left every spin value floating 120 pixels out (Mike's
  // 2026-09-02 New Game / Video / Options screenshots).
  test("spin rows draw their value at RCOLUMN_OFFSET(16)", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu } = buildMenuWithSpinControl(["no", "yes"], 1);

    Menu_Draw(menu);

    const str = "yes";
    expect(fake.drawCharCalls.length).toBe(str.length + 1); // value chars + cursor frame
    const value = fake.drawCharCalls.slice(0, str.length);
    for (let i = 0; i < str.length; i++) {
      expect(value[i]).toEqual({ x: 16 + i * 8, y: TRACK_Y, c: str.charCodeAt(i) });
    }
  });

  test("a slider row beside a spin row keeps its readout past the track while the spin value stays at RCOLUMN_OFFSET", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const menu = new MenuframeworkS();

    const slider = new MenusliderS();
    slider.generic.type = 0; // MTYPE_SLIDER
    slider.generic.x = 0;
    slider.generic.y = 0;
    slider.minvalue = 0;
    slider.maxvalue = 10;
    slider.curvalue = 10;
    slider.valueFormatter = () => "1.00x (native)";
    Menu_AddItem(menu, slider);

    const spin = new MenulistS();
    spin.generic.type = 3; // MTYPE_SPINCONTROL
    spin.generic.x = 0;
    spin.generic.y = 10;
    spin.itemnames = ["1:1 pixels", "fit screen"];
    spin.curvalue = 1;
    Menu_AddItem(menu, spin);

    Menu_Draw(menu);

    const readout = fake.drawCharCalls.find((c) => c.c === "1".charCodeAt(0) && c.y === TRACK_Y);
    expect(readout?.x).toBe(READOUT_X);
    const spinValue = fake.drawCharCalls.find((c) => c.c === "f".charCodeAt(0) && c.y === TRACK_Y + 10);
    expect(spinValue?.x).toBe(16);
  });
});
