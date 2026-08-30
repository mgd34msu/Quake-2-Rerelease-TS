// classic cgame HUD/layout subsystem -- extracted from cl_scrn.ts (the
// layout-string interpreter, SCR_DrawStats/SCR_DrawLayout/SCR_DrawField) and
// cl_inv.ts (CL_DrawInventory) as part of ARCHITECTURE.md phase 4's
// "extract the classic cgame" step. Precedent: q2repro's cgame_classic.c
// (CGC_ExecuteLayoutString, CGC_DrawStats, CGC_DrawLayout, CGC_DrawField,
// CGC_DrawInventory), which carries this exact code behind the cgame
// interface too.
//
// BOUNDARY: everything that reads engine state the host import surface
// (CgameImports, ./host.ts) actually exposes now goes through `imports`
// (get_configstring, SCR_DrawChar, Draw_Pic, CL_ServerFrame, CL_GetClientName,
// CL_GetClientPic, CL_GetKeyBinding, CL_FrameValid, Com_Print). Playerstate
// stats, the layout string, and the inventory array have no import-surface
// counterpart (KexCgameImports doesn't expose per-frame game state at all --
// the real cgame_export_t.DrawHUD receives them as PARAMETERS instead, see
// KexCgameExports.DrawHUD's data/ps/playernum params in kexapi/game.ts) --
// so classic.ts's DrawHUD receives the same shape (ClassicHudDataT, host.ts)
// and threads it down to the functions below as explicit parameters rather
// than each function reaching into `cl` directly.
//
// Three things stay OUT of the host import surface, by design, because
// routing them through it would change the actual draw call this file emits
// (breaking the pixel-identity contract test/cgame_classic_extraction.test.ts
// enforces) or would misuse a surface member ahead of its documented phase:
//   - viddef.width/height: no CgameImports counterpart exists yet (the real
//     API expresses screen geometry via DrawHUD's hud_vrect/hud_safe/scale
//     params, a phase-6 kex-cgame concept CgameExports intentionally hasn't
//     grown into yet -- see host.ts's own doc comment on CgameExports).
//   - DrawString/DrawAltString (console_impl.ts): KexCgameImports's nearest
//     equivalent, SCR_DrawFontString, is alignment-based with no discrete
//     high-bit/color toggle -- routing "client"/"ctf"/"string"/"string2"
//     through it would not reproduce the same draw calls.
//   - cls.realtime (CL_DrawInventory's blinky-cursor timing): CgameImports'
//     CL_ClientRealTime() is earmarked for a different concept (wall-clock/
//     com_localTime, phase-3 TODO in host.ts) -- reusing it here ahead of
//     that would misrepresent what it returns once it's wired for real.
// SCR_AddDirtyPoint/SCR_DirtyScreen also stay direct cl_scrn.ts imports:
// dirty-rect bookkeeping for the software tile-clear path is an engine-
// internal optimization with no cgame-import counterpart in the real API
// either (kex's modern renderer doesn't need it).

import type { CgameImports } from "./host";
import type { PlayerStateT } from "../../shared/q_shared";
import {
  Com_sprintf,
  STAT_HEALTH,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_FLASHES,
  STAT_LAYOUTS,
  STAT_SELECTED_ITEM,
  MAX_CLIENTS,
  MAX_ITEMS,
  CS_STATUSBAR,
} from "../../shared/q_shared";
import { fixedLength } from "../../shared/fixed";
import { type ComParseState, COM_Parse } from "../../shared/math";
import { cls } from "../client";
import { viddef } from "../vid";
import { DrawString, DrawAltString } from "../console_impl";
import { SCR_AddDirtyPoint, SCR_DirtyScreen } from "../cl_scrn";

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

//=============================================================================
// SCR_DrawField / sb_nums -- the digit-icon status bar numbers. sb_nums is
// exported so cl_scrn.ts's SCR_TouchPics (stays there -- see that file's own
// note on why TouchPics as a whole doesn't move) can still precache the same
// pic names this file draws.
//=============================================================================

const STAT_MINUS = 10; // num frame for '-' stats digit
export const sb_nums: string[][] = fixedLength("sb_nums", 2, [
  fixedLength("sb_nums row", 11, ["num_0", "num_1", "num_2", "num_3", "num_4", "num_5", "num_6", "num_7", "num_8", "num_9", "num_minus"]),
  fixedLength("sb_nums row", 11, ["anum_0", "anum_1", "anum_2", "anum_3", "anum_4", "anum_5", "anum_6", "anum_7", "anum_8", "anum_9", "anum_minus"]),
]);

const ICON_WIDTH = 24;
const ICON_HEIGHT = 24;
const CHAR_WIDTH = 16;
const ICON_SPACE = 8;
// ICON_WIDTH/ICON_HEIGHT/ICON_SPACE are unused by SCR_DrawField itself (only
// CHAR_WIDTH is) -- carried over unused from cl_scrn.c's own screen.c
// neighborhood of this function, same as before the move. Referenced here so
// the strict-unused-locals compiler setting doesn't flag them as dead;
// preserved rather than dropped, matching this port's "report, don't
// silently fix" stance on pre-existing oddities found while moving code.
void ICON_WIDTH;
void ICON_HEIGHT;
void ICON_SPACE;

/*
==============
SCR_DrawField
==============
*/
function SCR_DrawField(imports: CgameImports, x: number, yIn: number, color: number, widthIn: number, value: number): void {
  if (widthIn < 1) return;

  // draw number string
  const width = widthIn > 5 ? 5 : widthIn;

  SCR_AddDirtyPoint(x, yIn);
  SCR_AddDirtyPoint(x + width * CHAR_WIDTH + 2, yIn + 23);

  const num = Com_sprintf("%i", value);
  let l = num.length;
  if (l > width) l = width;
  let px = x + 2 + CHAR_WIDTH * (width - l);

  let ptr = 0;
  while (ptr < num.length && l) {
    const ch = num[ptr];
    const frame = ch === "-" ? STAT_MINUS : ch.charCodeAt(0) - "0".charCodeAt(0);

    imports.Draw_Pic(px, yIn, sb_nums[color][frame]);
    px += CHAR_WIDTH;
    ptr++;
    l--;
  }
}

//=============================================================================
// SCR_ExecuteLayoutString
//=============================================================================

function nextLayoutToken(state: ComParseState): { token: string; done: boolean } {
  const startIndex = state.index;
  const token = COM_Parse(state);
  const closedEmptyQuote = state.index > startIndex && state.data.charAt(state.index - 1) === '"';
  const done = token === "" && !closedEmptyQuote;
  return { token, done };
}

function DrawHUDString(imports: CgameImports, str: string, xIn: number, yIn: number, centerwidth: number, xor: number): void {
  const margin = xIn;
  let y = yIn;
  let i = 0;

  while (i < str.length) {
    // scan out one line of text from the string
    let line = "";
    while (i < str.length && str[i] !== "\n") line += str[i++];

    let x: number;
    if (centerwidth) x = margin + Math.trunc((centerwidth - line.length * 8) / 2);
    else x = margin;
    for (let j = 0; j < line.length; j++) {
      imports.SCR_DrawChar(x, y, 1, line.charCodeAt(j) ^ xor, false);
      x += 8;
    }
    if (i < str.length) {
      i++; // skip the \n
      y += 8;
    }
  }
}

function SCR_ExecuteLayoutString(imports: CgameImports, ps: PlayerStateT, playernum: number, s: string): void {
  if (!imports.CL_FrameValid()) return;
  if (!s || s.length === 0) return;

  let x = 0;
  let y = 0;
  let width = 3;

  const state: ComParseState = { data: s, index: 0 };

  for (;;) {
    const { token, done } = nextLayoutToken(state);
    if (done) break;

    if (token === "xl") {
      x = atoi(nextLayoutToken(state).token);
      continue;
    }
    if (token === "xr") {
      x = viddef.width + atoi(nextLayoutToken(state).token);
      continue;
    }
    if (token === "xv") {
      x = Math.trunc(viddef.width / 2) - 160 + atoi(nextLayoutToken(state).token);
      continue;
    }

    if (token === "yt") {
      y = atoi(nextLayoutToken(state).token);
      continue;
    }
    if (token === "yb") {
      y = viddef.height + atoi(nextLayoutToken(state).token);
      continue;
    }
    if (token === "yv") {
      y = Math.trunc(viddef.height / 2) - 120 + atoi(nextLayoutToken(state).token);
      continue;
    }

    if (token === "pic") {
      // draw a pic from a stat number
      const value = ps.stats[atoi(nextLayoutToken(state).token)];
      if (value >= cls.csr.max_images) {
        imports.Com_Print("Pic >= MAX_IMAGES\n");
        return;
      }
      const picname = imports.get_configstring(cls.csr.images + value);
      if (picname) {
        SCR_AddDirtyPoint(x, y);
        SCR_AddDirtyPoint(x + 23, y + 23);
        imports.Draw_Pic(x, y, picname);
      }
      continue;
    }

    if (token === "client") {
      // draw a deathmatch client block
      x = Math.trunc(viddef.width / 2) - 160 + atoi(nextLayoutToken(state).token);
      y = Math.trunc(viddef.height / 2) - 120 + atoi(nextLayoutToken(state).token);
      SCR_AddDirtyPoint(x, y);
      SCR_AddDirtyPoint(x + 159, y + 31);

      const value = atoi(nextLayoutToken(state).token);
      if (value >= MAX_CLIENTS || value < 0) {
        imports.Com_Print("client >= MAX_CLIENTS\n");
        return;
      }

      const score = atoi(nextLayoutToken(state).token);
      const ping = atoi(nextLayoutToken(state).token);
      const time = atoi(nextLayoutToken(state).token);

      const name = imports.CL_GetClientName(value);
      DrawAltString(x + 32, y, name);
      DrawString(x + 32, y + 8, "Score: ");
      DrawAltString(x + 32 + 7 * 8, y + 8, Com_sprintf("%i", score));
      DrawString(x + 32, y + 16, Com_sprintf("Ping:  %i", ping));
      DrawString(x + 32, y + 24, Com_sprintf("Time:  %i", time));

      imports.Draw_Pic(x, y, imports.CL_GetClientPic(value));
      continue;
    }

    if (token === "ctf") {
      // draw a ctf client block
      x = Math.trunc(viddef.width / 2) - 160 + atoi(nextLayoutToken(state).token);
      y = Math.trunc(viddef.height / 2) - 120 + atoi(nextLayoutToken(state).token);
      SCR_AddDirtyPoint(x, y);
      SCR_AddDirtyPoint(x + 159, y + 31);

      const value = atoi(nextLayoutToken(state).token);
      if (value >= MAX_CLIENTS || value < 0) {
        imports.Com_Print("client >= MAX_CLIENTS\n");
        return;
      }

      const score = atoi(nextLayoutToken(state).token);
      let ping = atoi(nextLayoutToken(state).token);
      if (ping > 999) ping = 999;

      const name = imports.CL_GetClientName(value);
      const block = Com_sprintf("%3i %3i %-12.12s", score, ping, name);

      if (value === playernum) DrawAltString(x, y, block);
      else DrawString(x, y, block);
      continue;
    }

    if (token === "picn") {
      // draw a pic from a name
      const name = nextLayoutToken(state).token;
      SCR_AddDirtyPoint(x, y);
      SCR_AddDirtyPoint(x + 23, y + 23);
      imports.Draw_Pic(x, y, name);
      continue;
    }

    if (token === "num") {
      // draw a number
      width = atoi(nextLayoutToken(state).token);
      const value = ps.stats[atoi(nextLayoutToken(state).token)];
      SCR_DrawField(imports, x, y, 0, width, value);
      continue;
    }

    if (token === "hnum") {
      // health number
      width = 3;
      const value = ps.stats[STAT_HEALTH];
      let color: number;
      if (value > 25) color = 0; // green
      else if (value > 0) color = (imports.CL_ServerFrame() >> 2) & 1; // flash
      else color = 1;

      if (ps.stats[STAT_FLASHES] & 1) {
        imports.Draw_Pic(x, y, "field_3");
      }

      SCR_DrawField(imports, x, y, color, width, value);
      continue;
    }

    if (token === "anum") {
      // ammo number
      width = 3;
      const value = ps.stats[STAT_AMMO];
      let color: number;
      if (value > 5) color = 0; // green
      else if (value >= 0) color = (imports.CL_ServerFrame() >> 2) & 1; // flash
      else continue; // negative number = don't show

      if (ps.stats[STAT_FLASHES] & 4) {
        imports.Draw_Pic(x, y, "field_3");
      }

      SCR_DrawField(imports, x, y, color, width, value);
      continue;
    }

    if (token === "rnum") {
      // armor number
      width = 3;
      const value = ps.stats[STAT_ARMOR];
      if (value < 1) continue;

      const color = 0; // green

      if (ps.stats[STAT_FLASHES] & 2) {
        imports.Draw_Pic(x, y, "field_3");
      }

      SCR_DrawField(imports, x, y, color, width, value);
      continue;
    }

    if (token === "stat_string") {
      let index = atoi(nextLayoutToken(state).token);
      if (index < 0 || index >= cls.csr.end) {
        imports.Com_Print("Bad stat_string index\n");
        return;
      }
      index = ps.stats[index];
      if (index < 0 || index >= cls.csr.end) {
        imports.Com_Print("Bad stat_string index\n");
        return;
      }
      DrawString(x, y, imports.get_configstring(index));
      continue;
    }

    if (token === "cstring") {
      DrawHUDString(imports, nextLayoutToken(state).token, x, y, 320, 0);
      continue;
    }

    if (token === "string") {
      DrawString(x, y, nextLayoutToken(state).token);
      continue;
    }

    if (token === "cstring2") {
      DrawHUDString(imports, nextLayoutToken(state).token, x, y, 320, 0x80);
      continue;
    }

    if (token === "string2") {
      DrawAltString(x, y, nextLayoutToken(state).token);
      continue;
    }

    if (token === "if") {
      // draw a number
      const value = ps.stats[atoi(nextLayoutToken(state).token)];
      if (!value) {
        // skip to endif
        for (;;) {
          const next = nextLayoutToken(state);
          if (next.done || next.token === "endif") break;
        }
      }
      continue;
    }
  }
}

/*
================
SCR_DrawStats

The status bar is a small layout program that
is based on the stats array
================
*/
export function SCR_DrawStats(imports: CgameImports, ps: PlayerStateT, playernum: number): void {
  SCR_ExecuteLayoutString(imports, ps, playernum, imports.get_configstring(CS_STATUSBAR));
}

/*
================
SCR_DrawLayout
================
*/
export function SCR_DrawLayout(imports: CgameImports, ps: PlayerStateT, playernum: number, layout: string): void {
  if (!ps.stats[STAT_LAYOUTS]) return;
  SCR_ExecuteLayoutString(imports, ps, playernum, layout);
}

//=============================================================================
// CL_DrawInventory -- moved from cl_inv.ts. CL_ParseInventory (the wire
// read into cl.inventory) stays there: it is client network-parsing code,
// not HUD drawing, and has no cgame-side reason to move.
//=============================================================================

function SetStringHighBit(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) | 128);
  return out;
}

function Inv_DrawString(imports: CgameImports, x: number, y: number, s: string): void {
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    imports.SCR_DrawChar(cx, y, 1, s.charCodeAt(i), false);
    cx += 8;
  }
}

const DISPLAY_ITEMS = 17;

/*
================
CL_DrawInventory
================
*/
export function CL_DrawInventory(imports: CgameImports, ps: PlayerStateT, inventory: Int32Array): void {
  const selected = ps.stats[STAT_SELECTED_ITEM];

  let num = 0;
  let selected_num = 0;
  const index: number[] = new Array(MAX_ITEMS).fill(0);
  for (let i = 0; i < MAX_ITEMS; i++) {
    if (i === selected) selected_num = num;
    if (inventory[i]) {
      index[num] = i;
      num++;
    }
  }

  // determine scroll point
  let top = selected_num - Math.floor(DISPLAY_ITEMS / 2);
  if (num - top < DISPLAY_ITEMS) top = num - DISPLAY_ITEMS;
  if (top < 0) top = 0;

  let x = Math.floor((viddef.width - 256) / 2);
  let y = Math.floor((viddef.height - 240) / 2);

  // repaint everything next frame
  SCR_DirtyScreen();

  imports.Draw_Pic(x, y + 8, "inventory");

  y += 24;
  x += 24;
  Inv_DrawString(imports, x, y, "hotkey ### item");
  Inv_DrawString(imports, x, y + 8, "------ --- ----");
  y += 16;
  for (let i = top; i < num && i < top + DISPLAY_ITEMS; i++) {
    const item = index[i];
    const itemName = imports.get_configstring(cls.csr.items + item);
    // search for a binding
    const binding = Com_sprintf("use %s", itemName);
    const bind = imports.CL_GetKeyBinding(binding);

    let str = Com_sprintf("%6s %3i %s", bind, inventory[item], itemName);
    if (item !== selected) {
      str = SetStringHighBit(str);
    } else if ((Math.trunc(cls.realtime * 10) & 1) === 1) {
      // draw a blinky cursor by the selected item
      imports.SCR_DrawChar(x - 8, y, 1, 15, false);
    }
    Inv_DrawString(imports, x, y, str);
    y += 8;
  }
}
