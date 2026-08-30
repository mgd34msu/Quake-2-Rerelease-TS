// Pixel-identity proof for ARCHITECTURE.md phase 4's classic-cgame HUD/
// layout extraction (SCR_ExecuteLayoutString, SCR_DrawStats, SCR_DrawLayout,
// SCR_DrawField: cl_scrn.ts -> src/client/cgame/classic_hud.ts;
// CL_DrawInventory: cl_inv.ts -> the same file).
//
// The extraction is only safe if it produces the SAME renderer draw calls,
// in the SAME order, as the code it replaced. Since the pre-move
// implementation no longer exists in the tree (it moved, it didn't stay
// behind as a second copy), this file keeps a verbatim transcription of it
// -- oldSCR_DrawStats/oldSCR_DrawLayout/oldCL_DrawInventory and their direct
// helpers below, copied from cl_scrn.ts/cl_inv.ts as they stood immediately
// before the move -- as a fixed oracle. Both the oracle and the real,
// moved implementation (src/client/cgame/classic.ts's GetClassicCgameAPI,
// which dispatches to classic_hud.ts) are driven against the exact same
// fabricated cl/cls/viddef/keybindings state through the exact same fake
// `re`, and their two draw-call logs are compared for byte-for-byte
// equality. A regression here means the extraction changed what actually
// gets drawn -- not just where the code that draws it lives.
//
// The fabricated CS_STATUSBAR layout string below exercises every op this
// unit's brief called out: xl, xr, xv, yb, yt, pic, num, hnum, anum, rnum,
// stat_string, if (both the true/fall-through branch and the false/skip-to-
// endif branch), client, and ctf. CL_DrawInventory's fixture exercises the
// keybinding lookup (CL_GetKeyBinding/Key_GetBinding, one bound item and
// two unbound), the high-bit string toggle for non-selected items, and the
// blinking-cursor draw for the selected one.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cl, cls, ConnstateT, setRe } from "../src/client/client";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { viddef } from "../src/client/vid";
import { keybindings } from "../src/client/keys";
import { Key_SetBinding, Key_StringToKeynum, Key_KeynumToString } from "../src/client/keys_impl";
import { DrawString, DrawAltString } from "../src/client/console_impl";
import { SCR_AddDirtyPoint, SCR_DirtyScreen } from "../src/client/cl_scrn";
import {
  Com_sprintf,
  STAT_HEALTH,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_FLASHES,
  STAT_LAYOUTS,
  STAT_SELECTED_ITEM,
  MAX_CLIENTS,
  MAX_IMAGES,
  MAX_CONFIGSTRINGS,
  MAX_ITEMS,
  CS_STATUSBAR,
  CS_IMAGES,
  CS_ITEMS,
} from "../src/shared/q_shared";
import { type ComParseState, COM_Parse } from "../src/shared/math";
import { GetClassicCgameAPI } from "../src/client/cgame/classic";
import { buildCgameImports } from "../src/client/cgame/host";

//=============================================================================
// Spy `re` -- records DrawChar/DrawPic/DrawStretchPic calls, in order, with
// their arguments. Every other RefExports member is a real (unused) no-op
// so this typechecks as a full RefExports without a cast.
//=============================================================================

type DrawCall =
  | { fn: "DrawChar"; x: number; y: number; num: number }
  | { fn: "DrawPic"; x: number; y: number; name: string }
  | { fn: "DrawStretchPic"; x: number; y: number; w: number; h: number; name: string };

function makeSpyRe(log: DrawCall[]): RefExports {
  return {
    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (_name: string): ImageS | null => null,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: (_name: string) => ({ w: -1, h: -1 }),
    DrawPic(x: number, y: number, name: string) {
      log.push({ fn: "DrawPic", x, y, name });
    },
    DrawStretchPic(x: number, y: number, w: number, h: number, name: string) {
      log.push({ fn: "DrawStretchPic", x, y, w, h, name });
    },
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _srcX: number, _srcY: number, _srcW: number, _srcH: number, _color: DrawColorT) => undefined,
    DrawChar(x: number, y: number, num: number) {
      log.push({ fn: "DrawChar", x, y, num });
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
}

//=============================================================================
// Oracle -- verbatim transcription of cl_scrn.ts's SCR_ExecuteLayoutString/
// SCR_DrawStats/SCR_DrawLayout/SCR_DrawField and cl_inv.ts's
// CL_DrawInventory/Inv_DrawString/SetStringHighBit, exactly as they stood
// immediately before the classic-cgame extraction. Reads cl/cls/re/viddef
// directly, same as the pre-move originals did.
//=============================================================================

function oldAtoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

const oldStatMinus = 10;
const oldSbNums: string[][] = [
  ["num_0", "num_1", "num_2", "num_3", "num_4", "num_5", "num_6", "num_7", "num_8", "num_9", "num_minus"],
  ["anum_0", "anum_1", "anum_2", "anum_3", "anum_4", "anum_5", "anum_6", "anum_7", "anum_8", "anum_9", "anum_minus"],
];
const oldCharWidth = 16;

function oldSCR_DrawField(re: RefExports, x: number, yIn: number, color: number, widthIn: number, value: number): void {
  if (widthIn < 1) return;

  const width = widthIn > 5 ? 5 : widthIn;

  SCR_AddDirtyPoint(x, yIn);
  SCR_AddDirtyPoint(x + width * oldCharWidth + 2, yIn + 23);

  const num = Com_sprintf("%i", value);
  let l = num.length;
  if (l > width) l = width;
  let px = x + 2 + oldCharWidth * (width - l);

  let ptr = 0;
  while (ptr < num.length && l) {
    const ch = num[ptr];
    const frame = ch === "-" ? oldStatMinus : ch.charCodeAt(0) - "0".charCodeAt(0);

    re.DrawPic(px, yIn, oldSbNums[color][frame]);
    px += oldCharWidth;
    ptr++;
    l--;
  }
}

function oldNextLayoutToken(state: ComParseState): { token: string; done: boolean } {
  const startIndex = state.index;
  const token = COM_Parse(state);
  const closedEmptyQuote = state.index > startIndex && state.data.charAt(state.index - 1) === '"';
  const done = token === "" && !closedEmptyQuote;
  return { token, done };
}

function oldSCR_ExecuteLayoutString(re: RefExports, s: string): void {
  if (cls.state !== ConnstateT.ca_active || !cl.refresh_prepped) return;
  if (!s || s.length === 0) return;

  let x = 0;
  let y = 0;
  let width = 3;

  const state: ComParseState = { data: s, index: 0 };

  for (;;) {
    const { token, done } = oldNextLayoutToken(state);
    if (done) break;

    if (token === "xl") {
      x = oldAtoi(oldNextLayoutToken(state).token);
      continue;
    }
    if (token === "xr") {
      x = viddef.width + oldAtoi(oldNextLayoutToken(state).token);
      continue;
    }
    if (token === "xv") {
      x = Math.trunc(viddef.width / 2) - 160 + oldAtoi(oldNextLayoutToken(state).token);
      continue;
    }

    if (token === "yt") {
      y = oldAtoi(oldNextLayoutToken(state).token);
      continue;
    }
    if (token === "yb") {
      y = viddef.height + oldAtoi(oldNextLayoutToken(state).token);
      continue;
    }
    if (token === "yv") {
      y = Math.trunc(viddef.height / 2) - 120 + oldAtoi(oldNextLayoutToken(state).token);
      continue;
    }

    if (token === "pic") {
      const value = cl.frame.playerstate.stats[oldAtoi(oldNextLayoutToken(state).token)];
      if (value >= MAX_IMAGES) return;
      if (cl.configstrings[CS_IMAGES + value]) {
        SCR_AddDirtyPoint(x, y);
        SCR_AddDirtyPoint(x + 23, y + 23);
        re.DrawPic(x, y, cl.configstrings[CS_IMAGES + value]);
      }
      continue;
    }

    if (token === "client") {
      x = Math.trunc(viddef.width / 2) - 160 + oldAtoi(oldNextLayoutToken(state).token);
      y = Math.trunc(viddef.height / 2) - 120 + oldAtoi(oldNextLayoutToken(state).token);
      SCR_AddDirtyPoint(x, y);
      SCR_AddDirtyPoint(x + 159, y + 31);

      const value = oldAtoi(oldNextLayoutToken(state).token);
      if (value >= MAX_CLIENTS || value < 0) return;
      let ci = cl.clientinfo[value];

      const score = oldAtoi(oldNextLayoutToken(state).token);
      const ping = oldAtoi(oldNextLayoutToken(state).token);
      const time = oldAtoi(oldNextLayoutToken(state).token);

      DrawAltString(x + 32, y, ci.name);
      DrawString(x + 32, y + 8, "Score: ");
      DrawAltString(x + 32 + 7 * 8, y + 8, Com_sprintf("%i", score));
      DrawString(x + 32, y + 16, Com_sprintf("Ping:  %i", ping));
      DrawString(x + 32, y + 24, Com_sprintf("Time:  %i", time));

      if (!ci.icon) ci = cl.baseclientinfo;
      re.DrawPic(x, y, ci.iconname);
      continue;
    }

    if (token === "ctf") {
      x = Math.trunc(viddef.width / 2) - 160 + oldAtoi(oldNextLayoutToken(state).token);
      y = Math.trunc(viddef.height / 2) - 120 + oldAtoi(oldNextLayoutToken(state).token);
      SCR_AddDirtyPoint(x, y);
      SCR_AddDirtyPoint(x + 159, y + 31);

      const value = oldAtoi(oldNextLayoutToken(state).token);
      if (value >= MAX_CLIENTS || value < 0) return;
      const ci = cl.clientinfo[value];

      const score = oldAtoi(oldNextLayoutToken(state).token);
      let ping = oldAtoi(oldNextLayoutToken(state).token);
      if (ping > 999) ping = 999;

      const block = Com_sprintf("%3i %3i %-12.12s", score, ping, ci.name);

      if (value === cl.playernum) DrawAltString(x, y, block);
      else DrawString(x, y, block);
      continue;
    }

    if (token === "num") {
      width = oldAtoi(oldNextLayoutToken(state).token);
      const value = cl.frame.playerstate.stats[oldAtoi(oldNextLayoutToken(state).token)];
      oldSCR_DrawField(re, x, y, 0, width, value);
      continue;
    }

    if (token === "hnum") {
      width = 3;
      const value = cl.frame.playerstate.stats[STAT_HEALTH];
      let color: number;
      if (value > 25) color = 0;
      else if (value > 0) color = (cl.frame.serverframe >> 2) & 1;
      else color = 1;

      if (cl.frame.playerstate.stats[STAT_FLASHES] & 1) re.DrawPic(x, y, "field_3");

      oldSCR_DrawField(re, x, y, color, width, value);
      continue;
    }

    if (token === "anum") {
      width = 3;
      const value = cl.frame.playerstate.stats[STAT_AMMO];
      let color: number;
      if (value > 5) color = 0;
      else if (value >= 0) color = (cl.frame.serverframe >> 2) & 1;
      else continue;

      if (cl.frame.playerstate.stats[STAT_FLASHES] & 4) re.DrawPic(x, y, "field_3");

      oldSCR_DrawField(re, x, y, color, width, value);
      continue;
    }

    if (token === "rnum") {
      width = 3;
      const value = cl.frame.playerstate.stats[STAT_ARMOR];
      if (value < 1) continue;

      const color = 0;

      if (cl.frame.playerstate.stats[STAT_FLASHES] & 2) re.DrawPic(x, y, "field_3");

      oldSCR_DrawField(re, x, y, color, width, value);
      continue;
    }

    if (token === "stat_string") {
      let index = oldAtoi(oldNextLayoutToken(state).token);
      if (index < 0 || index >= MAX_CONFIGSTRINGS) return;
      index = cl.frame.playerstate.stats[index];
      if (index < 0 || index >= MAX_CONFIGSTRINGS) return;
      DrawString(x, y, cl.configstrings[index]);
      continue;
    }

    if (token === "if") {
      const value = cl.frame.playerstate.stats[oldAtoi(oldNextLayoutToken(state).token)];
      if (!value) {
        for (;;) {
          const next = oldNextLayoutToken(state);
          if (next.done || next.token === "endif") break;
        }
      }
      continue;
    }
  }
}

function oldSCR_DrawStats(re: RefExports): void {
  oldSCR_ExecuteLayoutString(re, cl.configstrings[CS_STATUSBAR]);
}

function oldSCR_DrawLayout(re: RefExports): void {
  if (!cl.frame.playerstate.stats[STAT_LAYOUTS]) return;
  oldSCR_ExecuteLayoutString(re, cl.layout);
}

function oldSetStringHighBit(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) | 128);
  return out;
}

function oldInv_DrawString(re: RefExports, x: number, y: number, s: string): void {
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    re.DrawChar(cx, y, s.charCodeAt(i));
    cx += 8;
  }
}

const oldDisplayItems = 17;

function oldCL_DrawInventory(re: RefExports): void {
  const selected = cl.frame.playerstate.stats[STAT_SELECTED_ITEM];

  let num = 0;
  let selected_num = 0;
  const index: number[] = new Array(MAX_ITEMS).fill(0);
  for (let i = 0; i < MAX_ITEMS; i++) {
    if (i === selected) selected_num = num;
    if (cl.inventory[i]) {
      index[num] = i;
      num++;
    }
  }

  let top = selected_num - Math.floor(oldDisplayItems / 2);
  if (num - top < oldDisplayItems) top = num - oldDisplayItems;
  if (top < 0) top = 0;

  let x = Math.floor((viddef.width - 256) / 2);
  let y = Math.floor((viddef.height - 240) / 2);

  SCR_DirtyScreen();

  re.DrawPic(x, y + 8, "inventory");

  y += 24;
  x += 24;
  oldInv_DrawString(re, x, y, "hotkey ### item");
  oldInv_DrawString(re, x, y + 8, "------ --- ----");
  y += 16;
  for (let i = top; i < num && i < top + oldDisplayItems; i++) {
    const item = index[i];
    const binding = Com_sprintf("use %s", cl.configstrings[CS_ITEMS + item]);
    // Reverse-lookup exactly like the pre-move code's inline loop
    // (Q_stricmp against every of the 256 keybindings, first match wins) --
    // done via the same keybindings array both sides share, not re-derived
    // from Key_GetBinding, so this oracle doesn't depend on the very
    // production helper the moved code now uses for the same job.
    let bind = "";
    for (let j = 0; j < 256; j++) {
      const kb = keybindings[j];
      if (kb && kb.toLowerCase() === binding.toLowerCase()) {
        bind = Key_KeynumToString(j);
        break;
      }
    }

    let str = Com_sprintf("%6s %3i %s", bind, cl.inventory[item], cl.configstrings[CS_ITEMS + item]);
    if (item !== selected) {
      str = oldSetStringHighBit(str);
    } else if ((Math.trunc(cls.realtime * 10) & 1) === 1) {
      re.DrawChar(x - 8, y, 15);
    }
    oldInv_DrawString(re, x, y, str);
    y += 8;
  }
}

//=============================================================================
// Fixture
//=============================================================================

// Custom (non-STAT_*) stat slots used by the "pic"/"num"/"if"/"stat_string"
// ops below -- chosen clear of STAT_HEALTH(1)/STAT_AMMO(3)/STAT_ARMOR(5)/
// STAT_SELECTED_ITEM(12)/STAT_LAYOUTS(13)/STAT_FLASHES(15).
const STAT_PIC = 20;
const STAT_NUM_VALUE = 21;
const STAT_IF_TRUE = 22;
const STAT_STAT_STRING = 23;
const STAT_IF_FALSE = 24;

const CUSTOM_IMAGE_INDEX = 7;
const CUSTOM_CS_INDEX = 100;

const STATUSBAR = [
  "xl",
  "10",
  "yt",
  "20",
  "pic",
  String(STAT_PIC),
  "xl",
  "30",
  "yt",
  "40",
  "if",
  String(STAT_IF_TRUE),
  "num",
  "3",
  String(STAT_NUM_VALUE),
  "endif",
  "if",
  String(STAT_IF_FALSE),
  "num",
  "1",
  String(STAT_NUM_VALUE),
  "endif",
  "xl",
  "50",
  "yt",
  "60",
  "hnum",
  "xl",
  "90",
  "yt",
  "60",
  "anum",
  "xl",
  "130",
  "yt",
  "60",
  "rnum",
  "xl",
  "10",
  "yt",
  "90",
  "stat_string",
  String(STAT_STAT_STRING),
  "xr",
  "-60",
  "yb",
  "-40",
  "client", // xoff yoff clientindex score ping time (6 operands)
  "0",
  "0",
  "0",
  "500",
  "42",
  "1000",
  "xv",
  "-60",
  "yt",
  "90",
  "ctf", // xoff yoff clientindex score ping (5 operands)
  "0",
  "0",
  "3",
  "300",
  "55",
].join(" ");

const LAYOUT = ["xl", "5", "yt", "5", "hnum"].join(" ");

function setUpFixture(): void {
  cl.clear();
  cls.clear();
  keybindings.fill(null);
  viddef.width = 640;
  viddef.height = 480;

  cls.state = ConnstateT.ca_active;
  cl.refresh_prepped = true;
  cls.realtime = 0.15; // Math.trunc(1.5) & 1 === 1 -> inventory cursor blinks on

  cl.configstrings[CS_STATUSBAR] = STATUSBAR;
  cl.layout = LAYOUT;
  cl.playernum = 3;
  cl.frame.serverframe = 13;

  const stats = cl.frame.playerstate.stats;
  stats[STAT_HEALTH] = 15; // 1..25 -> flashing color branch
  stats[STAT_AMMO] = 3; // 0..5 -> flashing color branch
  stats[STAT_ARMOR] = 12; // >=1 -> green, drawn
  stats[STAT_FLASHES] = 1 | 2 | 4; // field_3 pre-pic for hnum/rnum/anum all fire
  stats[STAT_LAYOUTS] = 1 | 2; // draw layout (bit 0) AND inventory (bit 1)
  stats[STAT_PIC] = CUSTOM_IMAGE_INDEX;
  stats[STAT_NUM_VALUE] = 77;
  stats[STAT_IF_TRUE] = 1;
  stats[STAT_IF_FALSE] = 0;
  stats[STAT_STAT_STRING] = CUSTOM_CS_INDEX;
  stats[STAT_SELECTED_ITEM] = 5;

  cl.configstrings[CS_IMAGES + CUSTOM_IMAGE_INDEX] = "i_health";
  cl.configstrings[CUSTOM_CS_INDEX] = "Frag Limit: 30";

  cl.clientinfo[0].name = "Ranger";
  cl.clientinfo[0].icon = null; // forces the "client" op's baseclientinfo fallback
  cl.baseclientinfo.iconname = "base_icon";
  cl.clientinfo[3].name = "Bones"; // playernum === 3 -> ctf's DrawAltString branch

  cl.configstrings[CS_ITEMS + 2] = "Shells";
  cl.configstrings[CS_ITEMS + 5] = "Health";
  cl.configstrings[CS_ITEMS + 9] = "Rocket Launcher";
  cl.inventory[2] = 20;
  cl.inventory[5] = 1;
  cl.inventory[9] = 2;

  const shellsKey = Key_StringToKeynum("b");
  expect(shellsKey).not.toBe(-1);
  Key_SetBinding(shellsKey, "use Shells");
}

function tearDownFixture(): void {
  cl.clear();
  cls.clear();
  keybindings.fill(null);
  viddef.width = 0;
  viddef.height = 0;
  setRe(null);
}

beforeEach(() => {
  setUpFixture();
});

afterEach(() => {
  tearDownFixture();
});

describe("classic cgame HUD/layout extraction: draw-call identity", () => {
  test("SCR_DrawStats + SCR_DrawLayout + CL_DrawInventory draw identically before and after the move", () => {
    const beforeLog: DrawCall[] = [];
    const beforeRe = makeSpyRe(beforeLog);
    setRe(beforeRe);
    oldSCR_DrawStats(beforeRe);
    oldSCR_DrawLayout(beforeRe);
    oldCL_DrawInventory(beforeRe);

    const afterLog: DrawCall[] = [];
    const afterRe = makeSpyRe(afterLog);
    setRe(afterRe);
    const imports = buildCgameImports();
    const classic = GetClassicCgameAPI(imports);
    classic.DrawHUD(cl.playernum, cl.frame.playerstate, { layout: cl.layout, inventory: cl.inventory });

    // Sanity: the fixture must actually exercise real drawing (this
    // fixture's own log runs 177 entries), or an empty log would trivially
    // "match" without proving anything. Spot-check a few ops by name too,
    // so a fixture regression that silently stops exercising one of them
    // (e.g. a token-count mistake that makes "client"/"ctf" bail out early,
    // as happened once while writing this fixture) fails here instead of
    // just shrinking the log both sides happen to still agree on.
    expect(beforeLog.length).toBe(177);
    const beforePicNames = beforeLog.filter((c) => c.fn === "DrawPic").map((c) => c.name);
    expect(beforePicNames).toContain("i_health"); // "pic" op
    expect(beforePicNames).toContain("base_icon"); // "client" op's icon fallback
    expect(beforePicNames).toContain("inventory"); // CL_DrawInventory background
    // hnum+anum+rnum flashes in the statusbar, plus one more from the
    // LAYOUT string's own "hnum" (SCR_DrawLayout runs the same token
    // interpreter over a second, independent layout string).
    expect(beforePicNames.filter((n) => n === "field_3").length).toBe(4);

    expect(afterLog).toEqual(beforeLog);

    // The extraction's own surface-gap finding (see host.ts's top-of-file
    // comment): native-size pic draws must keep going through re.DrawPic,
    // never re.DrawStretchPic, or the log above would already have failed
    // to match -- asserted explicitly too so a future change that silently
    // reintroduces stretch-routing fails loudly right here.
    expect(afterLog.some((c) => c.fn === "DrawStretchPic")).toBe(false);
  });
});
