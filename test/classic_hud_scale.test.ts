/*
THE CLASSIC HUD'S SCALE -- one display resolution, one HUD size, under either
ruleset and under either wire layout.

WHAT WENT WRONG. The kex cgame has always drawn its HUD through a scale
factor: host.ts's hudUpscaleFactor (q2repro's get_auto_scale tier -- 1x below
720p, 2x at 720p..2160p, 4x above, with a user-set scr_scale winning
outright), divided into hud_vrect and passed to cg_screen.ts as its `scale`
parameter. The CLASSIC cgame had no scale term at all: classic_hud.ts drew the
v3.19 320x240 status bar at native atlas pixel size no matter how large the
display was. So the same engine at 1280x960 drew the re-release ruleset's HUD
at 2x and the classic ruleset's at 1x -- 16x24 health digits in the corner of
a 1280x960 frame, which is the owner's "tiny icons" play-test report.

WHAT THIS FILE PINS.
  1. The factor the classic cgame uses IS host.ts's shared tier -- the same
     one the kex adapter uses -- so both rulesets agree at every resolution.
  2. It is display geometry only. A classic-ruleset session draws its HUD
     identically whether it came in on the narrow protocol-36 configstring
     layout (1997 content) or the engine-local 4038 wide layout (re-release
     content). This was ALREADY true before the scale term and has to stay
     true after it: nothing in the HUD path may key off cls.csr/cls.gameFamily.
     (The two play-test frames that looked different were rendered at
     different sizes -- /home/buzzkill/q2ts/baseq2/config.cfg carries
     `vid_scale 0.5` and the re-release tree's carries `vid_scale 1`, so the
     "1997" frame was a 640x480 buffer presented at 1280x960 -- not because
     anything in this path read the wire layout.)
  3. Below the 720p tier the scale is 1 and every draw is byte-for-byte the
     call this code made before the term existed.
  4. The health_bars token (the re-release target_healthbar boss bars, drawn
     under the classic ruleset on a wide session) scales WITH the rest: its
     bar stays half the display wide, and its height/outline/pitch grow with
     the digits instead of staying a 4-pixel sliver.

Self-sufficient per .orch/preferences.md rule 13: no retail data, no renderer,
no server. The classic cgame is driven directly with a capturing CgameImports;
every global read (viddef, cls.state, cls.csr, cl.refresh_prepped, scr_scale)
is installed in beforeEach and restored in afterEach.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { GetClassicCgameAPI } from "../src/client/cgame/classic";
import { buildCgameImports, CG_HudUpscaleFactor, CG_SeatHudUpscaleFactor, type CgameImports, type ClassicHudDataT } from "../src/client/cgame/host";
import { fullScreenHudPane, seatHudPane } from "../src/client/cgame/classic_hud";
import { viddef } from "../src/client/vid";
import { cl, cls, ConnstateT } from "../src/client/client";
import { Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, type CsRemapT } from "../src/shared/cs_remap";
import type { DrawColorT } from "../src/client/ref";
import { PlayerStateT, STAT_HEALTH, MAX_ITEMS, CS_STATUSBAR, CVAR_ARCHIVE } from "../src/shared/q_shared";

/** classic_hud.ts's own STAT_HEALTH_BARS, restated (that constant is private
 *  to the module for the same reason p_hud.ts hardcodes it -- the classic
 *  stat list stops well short of the KEX-only 32..63 tail). */
const STAT_HEALTH_BARS = 52;

interface PicDraw {
  x: number;
  y: number;
  scale: number;
  name: string;
}
interface CharDraw {
  x: number;
  y: number;
  scale: number;
  num: number;
}
interface ColorPicDraw {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

interface Capture {
  imports: CgameImports;
  pics: PicDraw[];
  chars: CharDraw[];
  bars: ColorPicDraw[];
}

/* The real import surface with only the members this suite observes swapped
   for capturing ones -- the same "wrap the real thing, don't stand in for it"
   shape test/splitscreen_classic_hud.test.ts uses. Coordinates arrive already
   multiplied by the HUD scale, i.e. in real pixels. */
function makeCapture(statusbar: string, healthBarName = "Boss"): Capture {
  const pics: PicDraw[] = [];
  const chars: CharDraw[] = [];
  const bars: ColorPicDraw[] = [];
  const base = buildCgameImports();
  const imports: CgameImports = {
    ...base,
    CL_FrameValid: () => true,
    get_configstring: (index: number) => (index === CS_STATUSBAR ? statusbar : healthBarName),
    Localize: (s: string) => s,
    Draw_PicScaled: (x: number, y: number, scale: number, name: string) => {
      pics.push({ x, y, scale, name });
    },
    Draw_CharScaled: (x: number, y: number, scale: number, num: number) => {
      chars.push({ x, y, scale, num });
    },
    SCR_DrawColorPic: (x: number, y: number, w: number, h: number, name: string, _color: DrawColorT) => {
      bars.push({ x, y, w, h, name });
    },
    Com_Print: () => {},
  };
  return { imports, pics, chars, bars };
}

function makePlayerState(health = 100): PlayerStateT {
  const ps = new PlayerStateT();
  ps.stats[STAT_HEALTH] = health;
  return ps;
}

function emptyData(): ClassicHudDataT {
  return { layout: "", inventory: new Int32Array(MAX_ITEMS) };
}

function drawStatusbar(statusbar: string, ps: PlayerStateT = makePlayerState()): Capture {
  const cap = makeCapture(statusbar);
  GetClassicCgameAPI(cap.imports).DrawHUD(0, ps, emptyData());
  return cap;
}

/** The bounding box of the digit pics a `hnum` drew -- the "health digit box"
 *  the play-test comparison measures. */
function digitBox(pics: PicDraw[]): { x: number; y: number; width: number; height: number; scale: number } {
  const digits = pics.filter((p) => p.name.startsWith("num_") || p.name.startsWith("anum_"));
  if (digits.length === 0) throw new Error(`no digit pics drawn (got: ${pics.map((p) => p.name).join(", ")})`);
  const scale = digits[0]!.scale;
  const minX = Math.min(...digits.map((d) => d.x));
  const minY = Math.min(...digits.map((d) => d.y));
  // sb_nums cells are 16x24 in the atlas; the box is that, times the scale,
  // spanning however many digits were drawn.
  const maxX = Math.max(...digits.map((d) => d.x)) + 16 * scale;
  const maxY = Math.max(...digits.map((d) => d.y)) + 24 * scale;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, scale };
}

const STATUSBAR_HNUM = "yb -24 xv 0 hnum";

describe("classic HUD scale", () => {
  let savedWidth = 0;
  let savedHeight = 0;
  let savedState = ConnstateT.ca_uninitialized;
  let savedPrepped = false;
  let savedCsr: CsRemapT = CS_REMAP_OLD;
  let savedScrScale = "0";

  beforeEach(() => {
    savedWidth = viddef.width;
    savedHeight = viddef.height;
    savedState = cls.state;
    savedPrepped = cl.refresh_prepped;
    savedCsr = cls.csr;
    savedScrScale = Cvar_Get("scr_scale", "0", CVAR_ARCHIVE)?.string ?? "0";
    Cvar_ForceSet("scr_scale", "0");
    cls.state = ConnstateT.ca_active;
    cl.refresh_prepped = true;
    viddef.width = 1280;
    viddef.height = 960;
  });

  afterEach(() => {
    viddef.width = savedWidth;
    viddef.height = savedHeight;
    cls.state = savedState;
    cl.refresh_prepped = savedPrepped;
    cls.csr = savedCsr;
    Cvar_ForceSet("scr_scale", savedScrScale);
  });

  // -------------------------------------------------------------------------
  // 1. the shared tier
  // -------------------------------------------------------------------------

  test("the classic HUD's factor IS host.ts's shared tier, at every resolution the tier defines", () => {
    const cases: [number, number, number][] = [
      [320, 240, 1],
      [640, 480, 1],
      // 768 is already over the tier's 720 threshold -- get_auto_scale's own
      // asymmetric landscape rule, preserved verbatim in host.ts.
      [1024, 768, 2],
      [1280, 960, 2],
      [1920, 1080, 2],
      [2560, 1440, 2],
      [3840, 2160, 4],
    ];
    for (const [w, h, expected] of cases) {
      viddef.width = w;
      viddef.height = h;
      expect(CG_HudUpscaleFactor()).toBe(expected);
      // ...and the classic cgame actually draws at it.
      expect(digitBox(drawStatusbar(STATUSBAR_HNUM).pics).scale).toBe(expected);
    }
  });

  test("a user-set scr_scale wins outright for the classic HUD, exactly as it does for the kex one", () => {
    Cvar_ForceSet("scr_scale", "3");
    expect(digitBox(drawStatusbar(STATUSBAR_HNUM).pics).scale).toBe(3);
    // R_ClampScale's own 1..10 clamp.
    Cvar_ForceSet("scr_scale", "42");
    expect(digitBox(drawStatusbar(STATUSBAR_HNUM).pics).scale).toBe(10);
    Cvar_ForceSet("scr_scale", "0.25");
    expect(digitBox(drawStatusbar(STATUSBAR_HNUM).pics).scale).toBe(1);
  });

  test("a seat tiers off its own pane, not the display", () => {
    // A quarter of a 4K display is 1080p-sized and picks the 1080p tier.
    expect(CG_SeatHudUpscaleFactor(1920, 1080)).toBe(2);
    expect(CG_SeatHudUpscaleFactor(640, 480)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. independent of the wire layout
  // -------------------------------------------------------------------------

  test("the classic HUD is identical on a narrow (protocol 36) and a wide (4038) session at the same display size", () => {
    // The defect report's premise. cls.csr is the ONLY thing that differs
    // between a 1997-content classic session and a re-release-content classic
    // session on the client side; the HUD path must not read it for geometry.
    const statusbar = "yb -24 xv 0 hnum xv 100 num 3 0 xl 8 yt 8 picn corner xr -40 yb -30 picn far";
    const ps = makePlayerState();

    cls.csr = CS_REMAP_OLD;
    const narrow = drawStatusbar(statusbar, ps);

    cls.csr = CS_REMAP_RERELEASE;
    const wide = drawStatusbar(statusbar, ps);

    expect(wide.pics).toEqual(narrow.pics);
    expect(wide.chars).toEqual(narrow.chars);
    expect(digitBox(wide.pics)).toEqual(digitBox(narrow.pics));
  });

  test("the health digit box is the same size and position on both session widths, at 1280x960 and at 640x480", () => {
    for (const [w, h] of [
      [1280, 960],
      [640, 480],
    ]) {
      viddef.width = w!;
      viddef.height = h!;

      cls.csr = CS_REMAP_OLD;
      const narrow = digitBox(drawStatusbar(STATUSBAR_HNUM).pics);
      cls.csr = CS_REMAP_RERELEASE;
      const wide = digitBox(drawStatusbar(STATUSBAR_HNUM).pics);

      expect(wide).toEqual(narrow);
      // 100 health -> three digits, each a 16x24 sb_nums cell times the tier.
      expect(narrow.width).toBe(3 * 16 * narrow.scale);
      expect(narrow.height).toBe(24 * narrow.scale);
    }
  });

  test("a 1280x960 frame's HUD covers the same fraction of the screen a 640x480 frame's does", () => {
    // The play-test comparison, as arithmetic: the 640x480 frame is presented
    // upscaled to the window, so matching SCREEN FRACTION is what "the same
    // size" means across the two. Before the scale term the 1280x960 HUD was
    // half the fraction, which is exactly what "tiny icons" describes.
    viddef.width = 640;
    viddef.height = 480;
    const small = digitBox(drawStatusbar(STATUSBAR_HNUM).pics);

    viddef.width = 1280;
    viddef.height = 960;
    const large = digitBox(drawStatusbar(STATUSBAR_HNUM).pics);

    expect(large.width / 1280).toBeCloseTo(small.width / 640, 10);
    expect(large.height / 960).toBeCloseTo(small.height / 480, 10);
    expect(large.x / 1280).toBeCloseTo(small.x / 640, 10);
    expect(large.y / 960).toBeCloseTo(small.y / 480, 10);
  });

  // -------------------------------------------------------------------------
  // 3. the identity case
  // -------------------------------------------------------------------------

  test("below the 720p tier the pane is the literal display rect and every draw is unscaled", () => {
    viddef.width = 640;
    viddef.height = 480;
    expect(fullScreenHudPane(CG_HudUpscaleFactor())).toEqual({ x: 0, y: 0, width: 640, height: 480 });

    const cap = drawStatusbar("xl 8 yt 12 picn topleft xr -40 yb -30 picn bottomright");
    expect(cap.pics).toEqual([
      { x: 8, y: 12, scale: 1, name: "topleft" },
      { x: 640 - 40, y: 480 - 30, scale: 1, name: "bottomright" },
    ]);
  });

  test("the pane handed down is pre-scale, the same shape kexHudVrect produces", () => {
    expect(fullScreenHudPane(2)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(seatHudPane({ x: 640, y: 480, width: 640, height: 480 }, 2)).toEqual({ x: 320, y: 240, width: 320, height: 240 });
    expect(seatHudPane({ x: 640, y: 480, width: 640, height: 480 }, 1)).toEqual({ x: 640, y: 480, width: 640, height: 480 });
  });

  // -------------------------------------------------------------------------
  // 4. health_bars
  // -------------------------------------------------------------------------

  test("health_bars scales with the rest of the HUD", () => {
    cls.csr = CS_REMAP_RERELEASE; // the only layout the stat can travel on
    const ps = makePlayerState();
    ps.stats[STAT_HEALTH_BARS] = 0x80 | 63; // one bar showing, ~50%

    const measure = (w: number, h: number) => {
      viddef.width = w;
      viddef.height = h;
      const cap = makeCapture("if 52 yt 24 health_bars endif");
      GetClassicCgameAPI(cap.imports).DrawHUD(0, ps, emptyData());
      expect(cap.bars.length).toBeGreaterThan(0);
      const outline = cap.bars[0]!;
      return { outline, scale: CG_HudUpscaleFactor(), width: w, height: h };
    };

    const small = measure(640, 480);
    const large = measure(1280, 960);

    expect(small.scale).toBe(1);
    expect(large.scale).toBe(2);

    // The bar stays half the display wide at both sizes -- the geometry the
    // token was written with (barWidth = pane.width * 0.5, on the PRE-SCALE
    // pane, times the scale on the way out).
    expect(small.outline.w).toBeCloseTo(640 * 0.5 + 1, 6);
    expect(large.outline.w).toBeCloseTo((640 * 0.5 + 1) * 2, 6);

    // ...and its height/outline grow with the digits instead of staying a
    // 4-pixel sliver on a large display.
    expect(large.outline.h).toBeCloseTo(small.outline.h * 2, 6);

    // Same screen fraction on both, horizontally and vertically.
    expect(large.outline.x / 1280).toBeCloseTo(small.outline.x / 640, 10);
    expect(large.outline.y / 960).toBeCloseTo(small.outline.y / 480, 10);
  });

  test("health_bars draws for the classic cgame on a wide session, and its title string scales too", () => {
    cls.csr = CS_REMAP_RERELEASE;
    const ps = makePlayerState();
    ps.stats[STAT_HEALTH_BARS] = 0x80 | 127;

    const cap = makeCapture("if 52 yt 24 health_bars endif", "Makron");
    GetClassicCgameAPI(cap.imports).DrawHUD(0, ps, emptyData());

    expect(cap.bars.length).toBeGreaterThan(0);
    expect(cap.chars.length).toBe("Makron".length);
    for (const ch of cap.chars) expect(ch.scale).toBe(2);
    // The title advances 8 VIRTUAL units per character, i.e. 16 real pixels
    // at this tier.
    expect(cap.chars[1]!.x - cap.chars[0]!.x).toBe(16);
  });
});
