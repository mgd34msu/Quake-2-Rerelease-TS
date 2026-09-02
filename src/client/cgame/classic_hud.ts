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
//   - conchar strings ("client"/"ctf"/"string"/"string2"/"stat_string" and
//     the inventory rows): KexCgameImports's nearest equivalent,
//     SCR_DrawFontString, is alignment-based with no discrete high-bit/color
//     toggle -- routing them through it would not reproduce the same draw
//     calls. These used to call console_impl.ts's DrawString/DrawAltString
//     directly; they now go through this file's own hudString, which applies
//     the HUD scale and emits the identical per-character draw at scale 1.
//     console_impl.ts keeps its own unscaled pair for the CONSOLE's callers,
//     which have no HUD scale.
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
import { SCR_AddDirtyPoint, SCR_DirtyScreen } from "../cl_scrn";

// ---------------------------------------------------------------------------
// RERELEASE CONTENT constants for the "health_bars" token below
// ---------------------------------------------------------------------------

/** The rerelease player_stat_t slot 52, hardcoded for the same reason
 *  src/client/cl_wheel.ts and src/game/p_hud.ts hardcode it: the classic
 *  q_shared.ts stat list stops at STAT_SPECTATOR and 32..63 are the KEX-only
 *  tail. PlayerStateT.stats is MAX_STATS_STORAGE=64 wide, so the read is in
 *  range under either layout; the stat is only ever non-zero on a wide one. */
const STAT_HEALTH_BARS = 52;

/** bg_local.h:56-73's reserved general-configstring range, as an offset from
 *  the LIVE layout's CS_GENERAL base (cls.csr.general): CTF match(0) +
 *  teaminfo(1) + player names(2 .. 2+MAX_CLIENTS) + 1 + the 5 coop-respawn
 *  strings + n64 physics -> 10 + MAX_CLIENTS. Computed rather than written as
 *  266 so it tracks MAX_CLIENTS, exactly as src/kexgame/p_hud.ts computes it
 *  and src/game/g_kextarg.ts computes the server-side twin. */
const CONFIG_HEALTH_BAR_NAME_OFFSET = 10 + MAX_CLIENTS;

/** The conchars cell height. cg_screen.cpp reaches the same number through
 *  SCR_FontLineHeight(scale) with no kfont loaded; this file has always
 *  advanced a HUD-string line by a literal 8 (see DrawHUDString below). */
const CONCHAR_HEIGHT = 8;

/** cg_screen.cpp's rgba_black / rgba_red and its inline {80,80,80,255}. */
const RGBA_BLACK = { r: 0, g: 0, b: 0, a: 255 };
const RGBA_RED = { r: 255, g: 0, b: 0, a: 255 };
const RGBA_GREY = { r: 80, g: 80, b: 80, a: 255 };

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

//=============================================================================
// HUD PANE -- the rectangle this HUD pass draws inside.
//
// COMPAT ADDITION (Mike's v1.1.0 ruling: "it's all the same engine now, why
// would we not be able to play with the legacy ruleset in split screen?"),
// NOT a port of anything: q2repro's CGC_DrawHUD opens with "Note: isplit is
// ignored, due to missing split screen support" and derives every coordinate
// below from the full screen. This port renders one HUD pass per local seat
// (cl_scrn.ts's SCR_DrawSeatViews), so each pass needs its own rectangle,
// exactly the way the kex cgame receives a hud_vrect.
//
// EXACT IDENTITY FOR THE SINGLE-VIEWPORT CASE: the full-screen pane is
// {0, 0, viddef.width, viddef.height}, so every formula below reduces to the
// arithmetic it had before this parameter existed (pane.x is 0 and
// pane.width is viddef.width) -- which is what keeps
// test/cgame_classic_extraction.test.ts's pixel-identity contract intact.
//
// SCALE TERM (added 2026-09-02; this note used to read "NO SCALE TERM,
// deliberately"). The v3.19 status bar is a fixed 320x240 virtual layout that
// the original engine drew at native atlas pixel size -- at 320x240
// fullscreen it exactly fills the screen, and at 1920x1080 it stayed a small
// 320x240 island anchored by the xl/xr/xv/yt/yb/yv tokens. The kex HUD has
// always carried a scale here (cg_screen.ts multiplies every coordinate by
// its `scale` parameter, fed by host.ts's hudUpscaleFactor tier), so the SAME
// engine at 1080p drew a 2x HUD for the re-release ruleset and a 1x island
// for the classic one. That is the owner's "tiny icons" play-test report, and
// it is what this term fixes: the classic layout program now takes the same
// factor (host.ts's CG_HudUpscaleFactor -- q2repro's get_auto_scale tier,
// with a user-set scr_scale winning outright) and multiplies every draw by
// it, so one display resolution gives one HUD size under either ruleset.
//
// The pane is PRE-SCALE, exactly as GetKexCgameAsClassicShape's kexHudVrect
// already hands the kex cgame a hud_vrect divided by the same factor: all the
// anchor arithmetic below stays in the 320x240-relative virtual space it was
// written in, and only the final draw call multiplies by `scale`. That is
// also why `scale` is threaded as a parameter rather than read from a global
// here -- a splitscreen seat tiers off its own pane size (classic.ts).
//
// scale === 1 (any render size below 720p -- a 640x480 mode, or a 1280x960
// mode at vid_scale 0.5) is byte-for-byte the arithmetic and the draw calls
// this file had before the term existed: every `* scale` is an identity, and
// imports.Draw_PicScaled/Draw_CharScaled forward to the same
// re.DrawPic/re.DrawChar the old imports.Draw_Pic/SCR_DrawChar calls made
// (see their declarations in host.ts). That is what keeps
// test/cgame_classic_extraction.test.ts's pixel-identity contract intact.
//
// pane.x/pane.y are the pane's ORIGIN, added to left/top-anchored tokens and
// used as the base for right/bottom-anchored ones (`pane.x + pane.width + n`
// for `xr`, `pane.y + pane.height + n` for `yb`). There is no separate
// safe-area INSET here -- see host.ts's kexSeatHudSafe for why the kex path
// keeps those two concepts apart, and note that this file never conflates
// them: the origin is only ever ADDED, never subtracted.
//=============================================================================

export interface HudPaneT {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole display, i.e. what every coordinate below was implicitly
 *  relative to before panes existed -- in PRE-SCALE virtual units, the same
 *  shape host.ts's kexHudVrect hands the kex cgame. `scale` 1 (the default,
 *  and what every existing caller/test that does not pass one gets) is the
 *  literal viddef rect this returned before the scale term existed. */
export function fullScreenHudPane(scale = 1): HudPaneT {
  return { x: 0, y: 0, width: Math.round(viddef.width / scale), height: Math.round(viddef.height / scale) };
}

/** One local splitscreen seat's pane, in the same pre-scale virtual units. */
export function seatHudPane(seat: { x: number; y: number; width: number; height: number }, scale = 1): HudPaneT {
  return {
    x: Math.round(seat.x / scale),
    y: Math.round(seat.y / scale),
    width: Math.round(seat.width / scale),
    height: Math.round(seat.height / scale),
  };
}

//=============================================================================
// The four scaled draw primitives every draw below goes through. Each takes
// VIRTUAL coordinates and multiplies on the way out, so nothing above them
// has to know the scale exists. At scale 1 each is the exact call this file
// used to make (see the SCALE TERM note above).
//=============================================================================

function hudPic(imports: CgameImports, x: number, y: number, scale: number, name: string): void {
  imports.Draw_PicScaled(x * scale, y * scale, scale, name);
}

function hudChar(imports: CgameImports, x: number, y: number, scale: number, num: number): void {
  imports.Draw_CharScaled(x * scale, y * scale, scale, num);
}

/** console_impl.ts's DrawString/DrawAltString, with the scale term. Same
 *  8-unit advance and same `^ xor` high-bit toggle those two apply; kept here
 *  rather than widening console_impl.ts because the console's own callers
 *  have no HUD scale and must keep drawing at 8x8 (see this file's
 *  top-of-file BOUNDARY note on why those two were direct imports at all). */
function hudString(imports: CgameImports, x: number, y: number, scale: number, s: string, xor: number): void {
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    hudChar(imports, cx, y, scale, s.charCodeAt(i) ^ xor);
    cx += 8;
  }
}

/** SCR_AddDirtyPoint takes REAL pixels (it feeds the software renderer's
 *  tile-clear bookkeeping, which knows nothing about the HUD's virtual
 *  space), so every dirty point is scaled the same way a draw is. */
function hudDirty(x: number, y: number, scale: number): void {
  SCR_AddDirtyPoint(x * scale, y * scale);
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
function SCR_DrawField(imports: CgameImports, x: number, yIn: number, color: number, widthIn: number, value: number, scale: number): void {
  if (widthIn < 1) return;

  // draw number string
  const width = widthIn > 5 ? 5 : widthIn;

  hudDirty(x, yIn, scale);
  hudDirty(x + width * CHAR_WIDTH + 2, yIn + 23, scale);

  const num = Com_sprintf("%i", value);
  let l = num.length;
  if (l > width) l = width;
  let px = x + 2 + CHAR_WIDTH * (width - l);

  let ptr = 0;
  while (ptr < num.length && l) {
    const ch = num[ptr];
    const frame = ch === "-" ? STAT_MINUS : ch.charCodeAt(0) - "0".charCodeAt(0);

    hudPic(imports, px, yIn, scale, sb_nums[color][frame]);
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

function DrawHUDString(imports: CgameImports, str: string, xIn: number, yIn: number, centerwidth: number, xor: number, scale: number): void {
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
      hudChar(imports, x, y, scale, line.charCodeAt(j) ^ xor);
      x += 8;
    }
    if (i < str.length) {
      i++; // skip the \n
      y += 8;
    }
  }
}

function SCR_ExecuteLayoutString(imports: CgameImports, ps: PlayerStateT, playernum: number, s: string, pane: HudPaneT, scale: number): void {
  if (!imports.CL_FrameValid()) return;
  if (!s || s.length === 0) return;

  // Every one of these six anchors used to read viddef directly; each is now
  // the same expression against the pane (see the HUD PANE note above for why
  // the full-screen pane reproduces the original arithmetic exactly).
  const xl = (n: number): number => pane.x + n;
  const xr = (n: number): number => pane.x + pane.width + n;
  const xv = (n: number): number => pane.x + Math.trunc(pane.width / 2) - 160 + n;
  const yt = (n: number): number => pane.y + n;
  const yb = (n: number): number => pane.y + pane.height + n;
  const yv = (n: number): number => pane.y + Math.trunc(pane.height / 2) - 120 + n;

  // Pane-relative, not 0,0: a layout that draws before setting an anchor put
  // its first element at the top-left of the SCREEN, which for a seat means
  // the top-left of that seat's pane. Identical for the full-screen pane.
  let x = pane.x;
  let y = pane.y;
  let width = 3;

  const state: ComParseState = { data: s, index: 0 };

  for (;;) {
    const { token, done } = nextLayoutToken(state);
    if (done) break;

    if (token === "xl") {
      x = xl(atoi(nextLayoutToken(state).token));
      continue;
    }
    if (token === "xr") {
      x = xr(atoi(nextLayoutToken(state).token));
      continue;
    }
    if (token === "xv") {
      x = xv(atoi(nextLayoutToken(state).token));
      continue;
    }

    if (token === "yt") {
      y = yt(atoi(nextLayoutToken(state).token));
      continue;
    }
    if (token === "yb") {
      y = yb(atoi(nextLayoutToken(state).token));
      continue;
    }
    if (token === "yv") {
      y = yv(atoi(nextLayoutToken(state).token));
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
        hudDirty(x, y, scale);
        hudDirty(x + 23, y + 23, scale);
        hudPic(imports, x, y, scale, picname);
      }
      continue;
    }

    if (token === "client") {
      // draw a deathmatch client block
      x = xv(atoi(nextLayoutToken(state).token));
      y = yv(atoi(nextLayoutToken(state).token));
      hudDirty(x, y, scale);
      hudDirty(x + 159, y + 31, scale);

      const value = atoi(nextLayoutToken(state).token);
      if (value >= MAX_CLIENTS || value < 0) {
        imports.Com_Print("client >= MAX_CLIENTS\n");
        return;
      }

      const score = atoi(nextLayoutToken(state).token);
      const ping = atoi(nextLayoutToken(state).token);
      const time = atoi(nextLayoutToken(state).token);

      const name = imports.CL_GetClientName(value);
      hudString(imports, x + 32, y, scale, name, 0x80);
      hudString(imports, x + 32, y + 8, scale, "Score: ", 0);
      hudString(imports, x + 32 + 7 * 8, y + 8, scale, Com_sprintf("%i", score), 0x80);
      hudString(imports, x + 32, y + 16, scale, Com_sprintf("Ping:  %i", ping), 0);
      hudString(imports, x + 32, y + 24, scale, Com_sprintf("Time:  %i", time), 0);

      hudPic(imports, x, y, scale, imports.CL_GetClientPic(value));
      continue;
    }

    if (token === "ctf") {
      // draw a ctf client block
      x = xv(atoi(nextLayoutToken(state).token));
      y = yv(atoi(nextLayoutToken(state).token));
      hudDirty(x, y, scale);
      hudDirty(x + 159, y + 31, scale);

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

      if (value === playernum) hudString(imports, x, y, scale, block, 0x80);
      else hudString(imports, x, y, scale, block, 0);
      continue;
    }

    if (token === "picn") {
      // draw a pic from a name
      const name = nextLayoutToken(state).token;
      hudDirty(x, y, scale);
      hudDirty(x + 23, y + 23, scale);
      hudPic(imports, x, y, scale, name);
      continue;
    }

    if (token === "num") {
      // draw a number
      width = atoi(nextLayoutToken(state).token);
      const value = ps.stats[atoi(nextLayoutToken(state).token)];
      SCR_DrawField(imports, x, y, 0, width, value, scale);
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
        hudPic(imports, x, y, scale, "field_3");
      }

      SCR_DrawField(imports, x, y, color, width, value, scale);
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
        hudPic(imports, x, y, scale, "field_3");
      }

      SCR_DrawField(imports, x, y, color, width, value, scale);
      continue;
    }

    if (token === "rnum") {
      // armor number
      width = 3;
      const value = ps.stats[STAT_ARMOR];
      if (value < 1) continue;

      const color = 0; // green

      if (ps.stats[STAT_FLASHES] & 2) {
        hudPic(imports, x, y, scale, "field_3");
      }

      SCR_DrawField(imports, x, y, color, width, value, scale);
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
      hudString(imports, x, y, scale, imports.get_configstring(index), 0);
      continue;
    }

    if (token === "cstring") {
      DrawHUDString(imports, nextLayoutToken(state).token, x, y, 320, 0, scale);
      continue;
    }

    if (token === "string") {
      hudString(imports, x, y, scale, nextLayoutToken(state).token, 0);
      continue;
    }

    if (token === "cstring2") {
      DrawHUDString(imports, nextLayoutToken(state).token, x, y, 320, 0x80, scale);
      continue;
    }

    if (token === "string2") {
      hudString(imports, x, y, scale, nextLayoutToken(state).token, 0x80);
      continue;
    }

    if (token === "health_bars") {
      // RERELEASE CONTENT: target_healthbar's boss bars, drawn under the
      // CLASSIC ruleset. Translated from cg_screen.cpp's own "health_bars"
      // token (src/kexgame/cgame/cg_screen.ts:1429-1470), which is what the
      // kex HUD draws for the identical stat. Reached only on a wide
      // session: src/game/g_spawn.ts appends `if 52 yt 24 health_bars endif`
      // to the SP/coop statusbar only when gi.extended_layout() is true, and
      // STAT_HEALTH_BARS cannot travel on protocol 34 at all.
      //
      // GEOMETRY, term by term against cg_screen.ts:
      //   scale                 -> `scale`, the same factor every other draw
      //                            in this file now carries (see the SCALE
      //                            TERM note above). This used to be a hard 1
      //                            because the classic layout program had no
      //                            scale term at all; the bar therefore has
      //                            always been half the pane wide, and still
      //                            is -- what changed is that the pane is now
      //                            expressed in pre-scale virtual units, so
      //                            the bar's REAL width is unchanged while its
      //                            4-unit height, its 1-unit outline and its
      //                            barHeight*3 pitch grow with the digits
      //                            instead of staying a 4-pixel sliver.
      //   hud_vrect             -> `pane`, this seat's rectangle.
      //   hud_safe.x            -> 0. The classic HUD has no safe-area inset
      //                            concept; the pane carries the origin and
      //                            the origin is only ever ADDED (HUD PANE
      //                            note). So barWidth is half the pane width.
      //   SCR_FontLineHeight(1) -> 8, the conchars cell height this file's
      //                            DrawHUDString already advances a line by.
      // Everything else -- the 0x80 "showing" bit, the /127 percent, the
      // black outline drawn one pixel larger, the red filled part, the grey
      // remainder, and the barHeight*3 pitch between the two bars -- is the
      // C's arithmetic unchanged.
      const raw = ps.stats[STAT_HEALTH_BARS];
      const bytes = [raw & 0xff, (raw >> 8) & 0xff];

      const name = imports.Localize(imports.get_configstring(cls.csr.general + CONFIG_HEALTH_BAR_NAME_OFFSET), [], 0);
      DrawHUDString(imports, name, pane.x + Math.trunc(pane.width / 2) - 160, y, 320, 0, scale);

      const barWidth = pane.width * 0.5;
      const barHeight = 4;

      y += CONCHAR_HEIGHT;
      const barX = pane.x + pane.width * 0.5 - barWidth * 0.5;
      let barY = y;

      // 2 health bars, hardcoded (cg_screen.cpp's own comment)
      for (let i = 0; i < 2; i++) {
        const stat = bytes[i];
        if ((stat & 0b10000000) === 0) continue;

        const percent = (stat & 0b01111111) / 127;

        hudDirty(barX, barY, scale);
        hudDirty(barX + barWidth + 1, barY + barHeight + 1, scale);

        imports.SCR_DrawColorPic(barX * scale, barY * scale, (barWidth + 1) * scale, (barHeight + 1) * scale, "_white", RGBA_BLACK);
        if (percent > 0) imports.SCR_DrawColorPic(barX * scale, barY * scale, barWidth * percent * scale, barHeight * scale, "_white", RGBA_RED);
        if (percent < 1) imports.SCR_DrawColorPic((barX + barWidth * percent) * scale, barY * scale, barWidth * (1 - percent) * scale, barHeight * scale, "_white", RGBA_GREY);

        barY += barHeight * 3;
        y = barY;
      }
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
export function SCR_DrawStats(imports: CgameImports, ps: PlayerStateT, playernum: number, pane: HudPaneT = fullScreenHudPane(), scale = 1): void {
  SCR_ExecuteLayoutString(imports, ps, playernum, imports.get_configstring(CS_STATUSBAR), pane, scale);
}

/*
================
SCR_DrawLayout
================
*/
export function SCR_DrawLayout(imports: CgameImports, ps: PlayerStateT, playernum: number, layout: string, pane: HudPaneT = fullScreenHudPane(), scale = 1): void {
  if (!ps.stats[STAT_LAYOUTS]) return;
  SCR_ExecuteLayoutString(imports, ps, playernum, layout, pane, scale);
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

function Inv_DrawString(imports: CgameImports, x: number, y: number, s: string, scale: number): void {
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    hudChar(imports, cx, y, scale, s.charCodeAt(i));
    cx += 8;
  }
}

const DISPLAY_ITEMS = 17;

/*
================
CL_DrawInventory
================
*/
export function CL_DrawInventory(imports: CgameImports, ps: PlayerStateT, inventory: Int32Array, pane: HudPaneT = fullScreenHudPane(), scale = 1): void {
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

  // The 256x240 inventory panel, centered in the PANE rather than on the
  // display -- same expression, pane-relative (see the HUD PANE note).
  let x = pane.x + Math.floor((pane.width - 256) / 2);
  let y = pane.y + Math.floor((pane.height - 240) / 2);

  // repaint everything next frame
  SCR_DirtyScreen();

  hudPic(imports, x, y + 8, scale, "inventory");

  y += 24;
  x += 24;
  Inv_DrawString(imports, x, y, "hotkey ### item", scale);
  Inv_DrawString(imports, x, y + 8, "------ --- ----", scale);
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
      hudChar(imports, x - 8, y, scale, 15);
    }
    Inv_DrawString(imports, x, y, str, scale);
    y += 8;
  }
}
