// cgame host -- ARCHITECTURE.md phase 4 ("Client: cgame host, two built-in
// cgames"). Precedent: q2repro's src/client/cgame.c (the host) and
// src/client/cgame_classic.c (the built-in classic cgame), both GPLv2.
//
// CgameImports below is the 2022/2023 cgame import surface verbatim
// (KexCgameImports, src/kexapi/game.ts), widened by ClassicOnlyImports (this
// file, just below) with the one primitive the real API doesn't have: a
// native-size Draw_Pic. KexCgameImports's own SCR_DrawPic is stretch-shaped
// (explicit w/h -- fine for the kex cgame, which always knows its icon
// sizes up front); the classic layout interpreter's "pic"/"picn"/"client"/
// field_3/sb_nums/inventory-background draws call the classic engine's
// re.DrawPic(x, y, name) (native size, no stretch) throughout, and going
// through SCR_DrawPic would swap that for a DrawStretchPic call even when
// visually identical -- which breaks the byte-for-byte draw-call identity
// test/cgame_classic_extraction.test.ts enforces. Draw_Pic is the "surface
// gap found, add it" fix flagged by that unit's task brief, kept out of
// KexCgameImports itself (that type mirrors the real upstream API and
// shouldn't grow invented members) via the intersection below instead.
//
// Most members the classic cgame's DrawHUD path touches are wired to real
// client/engine functions in buildCgameImports() below; every other member
// is a stub, each commented with the phase expected to give it a real body.
// CL_GetClientPic and CL_FrameValid, previously two such stubs, are now
// wired for real (see their own comments below) -- the classic HUD's
// "client" layout token and its own connection-state guard both moved
// behind this interface in the same step that extracted the layout
// interpreter into ./classic_hud.ts, closing out both TODOs.
//
// CgameExports is intentionally NOT the full KexCgameExports -- DrawHUD's
// signature only carries the subset the classic cgame's real (now-extracted)
// implementation needs (playernum, ps, and the classic-shaped
// ClassicHudDataT bundling the layout string + inventory array KexCgameExports'
// own CgServerDataT covers for kex, minus the Int16Array/Int32Array mismatch
// noted on ClassicHudDataT below). It grows further toward KexCgameExports's
// full shape (isplit/hud_vrect/hud_safe/scale, the weapon-wheel/centerprint/
// notify members, etc.) once the kex cgame (phase 6) needs them.

import { cl, cls, re, ConnstateT } from "../client";
import { Com_Printf, Com_Error as Engine_Com_Error } from "../../qcommon/common";
import { Loc_Localize } from "../../qcommon/loc";
import { ERR_DROP } from "../../qcommon/qcommon";
import { Cvar_Get, Cvar_Set, Cvar_ForceSet } from "../../qcommon/cvar";
import { FS_LoadFile } from "../../qcommon/files";
import type { KexCgameImports, Vec2T, KexPlayerStateT, KexPmoveStateT, CgServerDataT, VrectT } from "../../kexapi/game";
import { TextAlignT, KexPmTypeT, MAX_STATS as KEX_MAX_STATS, rgba_white } from "../../kexapi/game";
import type { PlayerStateT, PmoveStateT } from "../../shared/q_shared";
import { PmTypeT, SHORT2ANGLE } from "../../shared/q_shared";
import type { Vec3 } from "../../shared/math";
import type { DrawColorT } from "../ref";
import { Key_GetBinding } from "../keys_impl";
import { viddef } from "../vid";
import { GetClassicCgameAPI } from "./classic";
import { GetCGameAPI as GetKexCgameAPI } from "../../kexgame/cgame/cg_main";
import { ParseKfont, SCR_KFontLookup, type KfontT } from "./kfont";
import { CL_Wheel_Precache } from "../cl_wheel";

// ---------------------------------------------------------------------------
// Fallback text metrics (kfont-less path) -- see the SCR_DrawFontString /
// SCR_MeasureFontString / SCR_FontLineHeight doc comments below for the
// full q2repro-vs-here comparison. CONCHAR_WIDTH/HEIGHT mirror q2repro's
// client.h constants of the same name: the fixed 8x8 cell every conchars.pcx
// glyph occupies, matching the `<< 3` (*8) arithmetic already used
// throughout console_impl.ts/cl_scrn.ts/cl_inv.ts for the same texture.
// ---------------------------------------------------------------------------
const CONCHAR_WIDTH = 8;
const CONCHAR_HEIGHT = 8;

// [Paril-KEX] SCR_SetAltTypeface state. Tracked (not discarded) even though
// nothing reads it back into a draw call yet: q2repro's own
// CG_SCR_SetAltTypeface is `// We don't support alternate type faces` (a
// documented no-op there too), and the alt typeface is a kfont-only concept
// (a second glyph set inside the .kfont asset) -- see this file's kfont doc
// comment below for why no .kfont asset exists to select between here
// either. Kept as real state (not a bare no-op) so the kfont upgrade path
// this comment points at only has to start reading this flag, not add it.
let altTypefaceEnabled = false;
// Exposed for tests; the flag has no reader yet (see comment above).
export function CG_IsAltTypefaceEnabled(): boolean {
  return altTypefaceEnabled;
}

function drawConchar(x: number, y: number, num: number): void {
  if (!re) return;
  re.DrawChar(x, y, num);
}

// ---------------------------------------------------------------------------
// [Paril-KEX] kfont loading -- see ./kfont.ts's own header comment for the
// full format writeup and the FIDELITY RAZOR (rule 17) history: this port
// used to ship ONLY the conchars-fallback branch of the four font functions
// below, with a FINDING comment (now superseded) recording that q2repro's
// real "fonts/qconfont.kfont" + "fonts/qconfont.png" assets exist in the
// retail rerelease KPF (Q2Game.kpf) this project can now mount, but that no
// PNG decoder or atlas-subrect draw primitive existed yet to load/render
// them. Both now exist (qcommon/png.ts, RefExports.DrawStretchPicRegion) --
// this section is the real load path q2repro's own SCR_Init
// (`SCR_LoadKFont(&scr.kfont, "fonts/qconfont.kfont")`) exercises.
//
// Memoized by `re` IDENTITY, not a one-shot flag: `re` is swapped out
// exactly once in a real process (client.ts's setRe, right after the
// renderer constructs) and stays stable for the rest of that process's
// life, so in real play this reduces to "load once, right after the
// renderer exists" -- the same timing q2repro's SCR_Init achieves by
// running once at startup. The identity-keyed cache (rather than a plain
// "attempted yet?" boolean) exists so this module's shared state stays
// correct across test files that call `setRe` repeatedly with different
// fakes in the same process (test/cgame_draw.test.ts's beforeEach, etc.) --
// a plain boolean would wrongly stick to whatever the FIRST test's `re`
// value produced for the rest of the suite.
let kfontCacheFor: unknown = undefined;
let kfontCache: KfontT | null = null;

// SCR_LoadKFont (src/refresh/draw.c), engine-side half: ./kfont.ts's
// ParseKfont does the pure text-format parsing (unit-tested directly,
// test/kfont.test.ts); this wires that result to the actual FS + renderer.
// `"/" + textureToken` matches Draw_FindPic's own "leading '/' means exact
// path, no pics/*.pcx default" convention (this port's gl_draw.ts/
// r_draw.ts) -- the same trick q2repro's own `R_RegisterFont(va("/%s",
// token))` call relies on. re.RegisterPic(...) !== null as the "does this
// texture actually exist" check mirrors Draw_RegisterPic's own existing
// convention just below in this file, rather than the documented
//0-vs-(-1) DrawGetPicSize mismatch noted on that member.
function loadKfontAsset(filename: string): KfontT | null {
  if (!re) return null;
  const raw = FS_LoadFile(filename);
  if (!raw) return null;
  const text = Buffer.from(raw).toString("latin1");
  const parsed = ParseKfont(text);
  if (!parsed) return null;
  const pic = "/" + parsed.textureToken;
  if (!re.RegisterPic(pic)) return null;
  return { pic, chars: parsed.chars, line_height: parsed.line_height };
}

function ensureKfont(): KfontT | null {
  if (re !== kfontCacheFor) {
    kfontCacheFor = re;
    kfontCache = loadKfontAsset("fonts/qconfont.kfont");
  }
  return kfontCache;
}

// CG_SCR_FontLineHeight (src/client/cgame.c): NOTE `scale` is read in the
// fallback branch but NOT in the kfont branch -- `return scr.kfont.
// line_height;`, no `* scale`. That is q2repro's own code, not a bug
// introduced by this port; preserved per FIDELITY RAZOR (rule 17) since it
// is real, observable behavior with the shipped asset (a HUD string drawn
// at scale=2 through the kfont path gets a scaled glyph ADVANCE per
// character -- see drawKfontChar below -- but an UNSCALED line pitch and
// UNSCALED measured width; see measureFontStringDispatch's own doc comment
// for the matching quirk on the measure side).
function fontLineHeightForScale(font: KfontT | null, scale: number): number {
  if (!font) return CONCHAR_HEIGHT * scale;
  return font.line_height;
}

// CG_MeasureKFontWidth (src/client/cgame.c): sums each looked-up glyph's
// native atlas width. Codepoints SCR_KFontLookup can't find (out of range,
// or a zero-width atlas entry -- e.g. the real qconfont.kfont has no entry
// at all for ` or ~) contribute nothing, matching `if (ch) x += ch->w;`
// exactly (silently skipped, not substituted with a fallback width).
function measureKfontLineWidth(font: KfontT, line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = SCR_KFontLookup(font, line.charCodeAt(i));
    if (ch) width += ch.w;
  }
  return width;
}

// CG_SCR_MeasureFontString (src/client/cgame.c): branches per-line on
// `scr.kfont.pic` exactly like the real function (`scr.kfont.pic ?
// CG_MeasureKFontWidth(...) : maxlen * CONCHAR_WIDTH * scale`); height is
// `num_lines * CG_SCR_FontLineHeight(scale)` either way. KFONT QUIRK
// (preserved, see fontLineHeightForScale's own doc comment): the kfont
// branch's width sum (measureKfontLineWidth) and its line-height
// (fontLineHeightForScale) are BOTH unscaled by `scale`, unlike the
// fallback branch, which scales both -- this is q2repro's own real
// behavior with kfont data, not something to "fix" here.
function measureFontStringDispatch(font: KfontT | null, str: string, scale: number): Vec2T {
  const lines = str.split("\n");
  let maxWidth = 0;
  for (const line of lines) {
    const width = font ? measureKfontLineWidth(font, line) : line.length * CONCHAR_WIDTH * scale;
    if (width > maxWidth) maxWidth = width;
  }
  return { x: maxWidth, y: lines.length * fontLineHeightForScale(font, scale) };
}

// draw_kfont_char (src/refresh/draw.c): looks up the glyph, then draws it
// (and, when `shadow` is set, a black copy offset by `1 * scale` first --
// SIMPLIFIED from q2repro's own `(flags & UI_DROPSHADOW) || gl_fontshadow->
// integer > 0` gate and its `gl_fontshadow->integer > 1` SECOND offset copy:
// this port has no gl_fontshadow cvar (a renderer-tuning knob with no
// existing counterpart anywhere in this client), so the shadow decision is
// driven by the `shadow` parameter alone, and only the single `1 * scale`
// offset copy draws, never the double-offset second pass. Documented
// deviation, not a silent drop -- the base single-shadow-offset behavior
// this DOES implement is identical to q2repro's own in the (default,
// gl_fontshadow=0) case any caller here would actually hit.
// Returns `ch.w * scale` (the SCALED advance) -- see
// measureFontStringDispatch's doc comment for why this differs from the
// UNSCALED width the measure path sums; both sides are faithful to
// q2repro's own respective functions.
function drawKfontChar(font: KfontT, x: number, y: number, scale: number, codepoint: number, color: DrawColorT, shadow: boolean): number {
  if (!re) return 0;
  const ch = SCR_KFontLookup(font, codepoint);
  if (!ch) return 0;

  const w = ch.w * scale;
  const h = ch.h * scale;

  if (shadow) {
    const offset = 1 * scale;
    const black: DrawColorT = { r: 0, g: 0, b: 0, a: color.a };
    re.DrawStretchPicRegion(x + offset, y + offset, w, h, font.pic, ch.x, ch.y, ch.w, ch.h, black);
  }
  re.DrawStretchPicRegion(x, y, w, h, font.pic, ch.x, ch.y, ch.w, ch.h, color);

  return w;
}

// SCR_DrawKStringStretch (src/client/screen.c): draws a single line
// (no '\n' handling -- that's SCR_DrawKStringMultiStretch's job just
// below), returning the cursor's final x (used by q2repro's own caller to
// place the blink cursor; unused here, but kept for shape parity/future
// callers).
function drawKStringStretch(font: KfontT, x: number, y: number, scale: number, maxlen: number, s: string, color: DrawColorT, shadow: boolean): number {
  let cx = x;
  for (let i = 0; i < maxlen && i < s.length; i++) {
    cx += drawKfontChar(font, cx, y, scale, s.charCodeAt(i), color, shadow);
  }
  return cx;
}

// SCR_DrawKStringMultiStretch (src/client/screen.c): splits on '\n'.
// PRESERVED QUIRK: the newline advance is `CONCHAR_HEIGHT * scale`, NOT
// `font.line_height` -- that is q2repro's own literal code (its
// SCR_DrawKStringMultiStretch shares the exact same `y += CONCHAR_HEIGHT *
// scale;` line its conchars-fallback sibling SCR_DrawStringMultiStretch
// uses), not a mistake introduced by this port. Every line restarts at the
// SAME `x` (the caller's already-aligned draw position, computed once from
// the whole string's measured width -- see drawFontStringDispatch below),
// matching q2repro's own `x = sx;` per-line reset rather than re-aligning
// each line independently.
function drawKStringMultiStretch(font: KfontT, x: number, y: number, scale: number, maxlen: number, s: string, color: DrawColorT, shadow: boolean): void {
  let remaining = maxlen;
  let pos = 0;
  let cy = y;
  while (pos < s.length && remaining > 0) {
    const newlineIndex = s.indexOf("\n", pos);
    if (newlineIndex === -1) {
      drawKStringStretch(font, x, cy, scale, remaining, s.slice(pos), color, shadow);
      break;
    }
    const len = Math.min(newlineIndex - pos, remaining);
    drawKStringStretch(font, x, cy, scale, len, s.slice(pos, pos + len), color, shadow);
    remaining -= len;
    cy += CONCHAR_HEIGHT * scale;
    pos = newlineIndex + 1;
  }
}

// SCR_DrawStringMultiStretch's kfont-less/conchars-fallback shape (used by
// drawFontStringDispatch's `!font` branch below). KNOWN GAP (documented,
// not silently dropped): re.DrawChar(x, y, c) -- the only char-drawing
// primitive this port's renderer surface had before this unit (ref.ts's
// RefExports.DrawChar) -- takes no scale and no color, unlike q2repro's
// R_DrawStretchChar(x, y, w, h, flags, c, color, font) which the real
// conchars fallback uses. So: position/line-wrap math below is
// scale-correct, but each glyph itself always draws at its native 8x8 size
// in the conchars texture's baked color, ignoring `scale`'s effect on glyph
// size, `color`, and `shadow`. Same gap this file's own SCR_DrawChar
// wrapper above already documents and defers to "once scaled/kfont-aware
// char drawing lands" -- unrelated to (and not fixed by) this unit's new
// DrawStretchPicRegion primitive, since the conchars.pcx texture is not an
// atlas with per-glyph metrics the way the kfont path's atlas is.
function drawConcharLines(str: string, x: number, y: number, scale: number): void {
  const lines = str.split("\n");
  let lineY = y;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      drawConchar(x + i * CONCHAR_WIDTH * scale, lineY, line.charCodeAt(i));
    }
    lineY += CONCHAR_HEIGHT * scale;
  }
}

// CG_SCR_DrawFontString (src/client/cgame.c): alignment is computed ONCE
// from the whole string's measured width (CENTER: `-= width/2`, RIGHT:
// `-= width`) and applied as a single x offset to every line -- NOT
// recomputed per line. This matches q2repro's own structure exactly
// (`draw_x` is computed once, then handed to SCR_DrawStringMultiStretch/
// SCR_DrawKStringMultiStretch, both of which reset to that same `x` after
// every newline -- see drawKStringMultiStretch's own doc comment above).
function drawFontStringDispatch(str: string, x: number, y: number, scale: number, color: DrawColorT, shadow: boolean, align: TextAlignT): void {
  const font = ensureKfont();

  let drawX = x;
  if (align !== TextAlignT.LEFT) {
    const width = measureFontStringDispatch(font, str, scale).x;
    drawX = align === TextAlignT.CENTER ? x - width / 2 : x - width;
  }

  if (!font) {
    drawConcharLines(str, drawX, y, scale);
    return;
  }
  drawKStringMultiStretch(font, drawX, y, scale, str.length, str, color, shadow);
}

// ---------------------------------------------------------------------------
// Import table (engine -> cgame)
// ---------------------------------------------------------------------------

// See this file's top-of-file comment for why Draw_Pic exists outside
// KexCgameImports proper.
interface ClassicOnlyImports {
  Draw_Pic(x: number, y: number, name: string): void;
}

export type CgameImports = KexCgameImports & ClassicOnlyImports;

// The classic engine's game logic has always run at a fixed 10Hz tick (see
// server.ts's ServerT.framerate/frametime, which documents the identical
// "fixed until ARCHITECTURE.md phase 3's tick-rate binding lands" state on
// the server side). tick_rate/frame_time_s/frame_time_ms mirror Kex's
// cgame_import_t, which sets these once from the CL_FRAMETIME constant --
// they are the *logic* tick duration, not the variable per-frame render
// delta (that is CL_FrameTime() below, wired to the real cls.frametime).
const CGAME_TICK_RATE_HZ = 10;
const CGAME_TICK_MS = 1000 / CGAME_TICK_RATE_HZ;
const CGAME_TICK_S = CGAME_TICK_MS * 0.001;

function boundsCheckedConfigstring(num: number): string {
  if (num < 0 || num >= cl.configstrings.length) {
    Engine_Com_Error(ERR_DROP, "get_configstring: bad index: %d", num);
  }
  return cl.configstrings[num];
}

function boundsCheckedClientName(index: number): string {
  if (index < 0 || index >= cl.clientinfo.length) {
    Engine_Com_Error(ERR_DROP, "CL_GetClientName: invalid client index");
  }
  return cl.clientinfo[index].name;
}

// Real body for CL_GetClientPic (see this file's top-of-file comment): the
// classic layout interpreter's "client" token resolves a scoreboard icon
// with the exact same fallback cl_scrn.c always used -- draw the indexed
// client's own icon unless it never registered one (ci.icon null), in which
// case fall back to cl.baseclientinfo's icon. Note the fallback applies only
// to the ICON, not the name text drawn alongside it (CL_GetClientName above
// never falls back) -- this mirrors the original inline code's `let ci = ...;
// ...draw name/score/ping/time off ci...; if (!ci.icon) ci = baseclientinfo;
// ...draw icon off (possibly reassigned) ci...` sequencing exactly.
function boundsCheckedClientPic(index: number): string {
  if (index < 0 || index >= cl.clientinfo.length) {
    Engine_Com_Error(ERR_DROP, "CL_GetClientPic: invalid client index");
  }
  const ci = cl.clientinfo[index];
  const resolved = ci.icon ? ci : cl.baseclientinfo;
  return resolved.iconname;
}

export function buildCgameImports(): CgameImports {
  return {
    // ---- tick fields (implemented: fixed logic-tick constants; see comment above) ----
    tick_rate: CGAME_TICK_RATE_HZ,
    frame_time_s: CGAME_TICK_S,
    frame_time_ms: CGAME_TICK_MS,

    // ---- implemented: wired to real engine functions ----
    Com_Print(msg: string): void {
      Com_Printf("%s", msg);
    },

    get_configstring: boundsCheckedConfigstring,

    Com_Error(message: string): never {
      Engine_Com_Error(ERR_DROP, "%s", message);
    },

    cvar(var_name, value, flags) {
      return Cvar_Get(var_name, value, flags);
    },
    cvar_set(var_name, value) {
      return Cvar_Set(var_name, value);
    },
    cvar_forceset(var_name, value) {
      return Cvar_ForceSet(var_name, value);
    },

    CL_FrameTime(): number {
      return cls.frametime;
    },
    CL_ClientTime(): number {
      return cl.time;
    },
    CL_ServerFrame(): number {
      return cl.frame.serverframe;
    },
    CL_GetClientName: boundsCheckedClientName,

    SCR_DrawChar(x, y, _scale, num, _shadow) {
      // TODO(phase 6, kex cgame): KexCgameImports.SCR_DrawChar carries a
      // scale + drop-shadow flag; ref.ts's RefExports.DrawChar (the only
      // char-drawing primitive our unconstructed-renderer port has) takes
      // just x/y/char (see ref.ts -- ref_gl/ is not ported per PORTING.md).
      // Scale and shadow are dropped here; wire once scaled/kfont-aware
      // char drawing lands with the kex module.
      if (!re) return;
      re.DrawChar(x, y, num);
    },
    SCR_DrawPic(x, y, w, h, name) {
      if (!re) return;
      re.DrawStretchPic(x, y, w, h, name);
    },
    // ClassicOnlyImports member (see this file's top-of-file comment) --
    // straight pass-through to the native-size draw primitive, matching
    // this file's own SCR_DrawChar's guard-then-forward shape exactly.
    Draw_Pic(x, y, name) {
      if (!re) return;
      re.DrawPic(x, y, name);
    },

    // ---- stubs: no current caller needs these; each names its phase ----

    // TS is garbage-collected -- the Z_Tag allocator concept this trio
    // ports has no client-side counterpart. Kept only for KexCgameImports
    // shape parity; not expected to ever gain a real body.
    TagMalloc(_size, _tag) {
      return null;
    },
    TagFree(_block) {
      // no-op: see TagMalloc comment above.
    },
    FreeTags(_tag) {
      // no-op: see TagMalloc comment above.
    },

    // TODO(phase 6, kex cgame): wire to the command buffer once a cgame
    // needs to inject console commands (menu actions, etc). The classic
    // cgame's pass-through DrawHUD never calls this.
    AddCommandString(_text) {
      // no-op
    },

    // TODO(phase 5, protocol layer): q2pro's extended-support query
    // mechanism (cgame_q2pro_extended_support_ext_t) has no counterpart
    // here yet. Unused by the classic cgame.
    GetExtension(_name) {
      return null;
    },

    // Wired for real: the classic layout interpreter (classic_hud.ts's
    // SCR_ExecuteLayoutString) used to bail out inline on
    // `cls.state !== ca_active || !cl.refresh_prepped` before this move --
    // now that it only sees the host import surface, that same guard lives
    // here. Matches the exact condition it replaces, just relocated.
    CL_FrameValid() {
      return cls.state === ConnstateT.ca_active && cl.refresh_prepped;
    },

    // TODO(phase 3, variable tick + framediv): wall-clock plumbing
    // (com_localTime equivalent) is not wired client-side yet.
    CL_ClientRealTime() {
      return 0;
    },

    // TODO(phase 5, protocol layer): "which protocol are we speaking" is
    // owned by the codec abstraction, not this step's bare seam.
    CL_ServerProtocol() {
      return 0;
    },

    // Wired for real (see boundsCheckedClientPic's own comment above) --
    // classic_hud.ts's "client" layout token now resolves the scoreboard
    // icon through this import instead of reading cl.clientinfo directly.
    CL_GetClientPic: boundsCheckedClientPic,
    // TODO(phase 6, kex cgame): dogtags are a kex-only concept, absent from
    // classic Q2's ClientinfoT.
    CL_GetClientDogtag(_index) {
      return "";
    },
    // Key-bind display for the kex HUD (centerprint control hints).
    // Key_GetBinding (src/client/keys_impl.ts) is a new function added for
    // this: classic Q2's keys.c never had a binding->keyname reverse
    // lookup, only q2repro's rerelease client added it for this exact
    // import. Mirrors q2repro's CG_CL_GetKeyBinding, which is a
    // one-line pass-through to the same-named Key_GetBinding.
    CL_GetKeyBinding(binding) {
      return Key_GetBinding(binding);
    },

    // re.RegisterPic returns the opaque ImageS handle (or null); q2repro's
    // CG_Draw_RegisterPic (R_RegisterPic != 0) reduces that to a bool the
    // same way.
    Draw_RegisterPic(name) {
      if (!re) return false;
      return re.RegisterPic(name) !== null;
    },
    // KexCgameImports models this as two length-1 arrays standing in for
    // C's `int *w, int *h` out-parameters (see this file's existing style
    // for that convention). ref.ts's RefExports.DrawGetPicSize's own doc
    // comment promises "0 0 if not found" but its actual GL/soft
    // implementations return {w:-1,h:-1} on a miss (Draw_GetPicSize in
    // gl_draw.ts/r_draw.ts) -- a pre-existing mismatch in ref.ts, not
    // introduced here; clamped to 0 below so this import keeps the
    // contract KexCgameImports's own doc comment states.
    Draw_GetPicSize(w, h, name) {
      if (!re) {
        w[0] = 0;
        h[0] = 0;
        return;
      }
      const size = re.DrawGetPicSize(name);
      w[0] = size.w > 0 ? size.w : 0;
      h[0] = size.h > 0 ? size.h : 0;
    },

    // Dispatches straight to the new RefExports.DrawColorPic primitive
    // (ref.ts) -- see gl_draw.ts's Draw_ColorPic / r_draw.ts's
    // Draw_ColorPic doc comments for the GL vertex-color and software
    // palette-remap+dither approaches respectively. Mirrors q2repro's
    // CG_SCR_DrawColorPic (R_RegisterImage + R_DrawStretchPic with a color
    // arg) at the same call shape, minus the alpha-scale cvar
    // (apply_scr_alpha) this port's scr_alpha equivalent doesn't exist yet.
    SCR_DrawColorPic(x, y, w, h, name, color) {
      if (!re) return;
      re.DrawColorPic(x, y, w, h, name, color);
    },

    // [Paril-KEX] kfont stuff. UPDATE (FIDELITY RAZOR sweep,
    // .orch/preferences.md rule 17): a previous unit's FINDING here recorded
    // that q2repro's SCR_Init loads `fonts/qconfont.kfont` (src/client/
    // screen.c's SCR_Init, src/refresh/draw.c's SCR_LoadKFont) and that every
    // one of these four functions branches on `scr.kfont.pic`, but that no
    // .kfont asset existed in this project's mounted data at the time and no
    // PNG decoder or atlas-subrect draw primitive existed to load/render one
    // even if it had. Both gaps are closed now: the retail rerelease KPF
    // (Q2Game.kpf) is mounted with real fonts/qconfont.kfont +
    // fonts/qconfont.png assets, qcommon/png.ts decodes the PNG, and
    // RefExports.DrawStretchPicRegion draws atlas sub-rects. All four
    // functions below now branch on ensureKfont() (./kfont.ts + the loader
    // just above) exactly like q2repro's own `scr.kfont.pic` check, falling
    // back to the ORIGINAL conchars-only math/draw (unchanged, still
    // reachable and still exercised by test/cgame_draw.test.ts) whenever
    // that load fails or hasn't run yet -- which remains the ONLY reachable
    // path for the 3.21-era baseq2/rogue/xatrix/ctf/lmctf data at
    // /home/buzzkill/q2ts (no fonts/qconfont.kfont there), matching
    // q2repro's own graceful `if (!file) return` in SCR_LoadKFont before
    // ever writing kfont.pic.
    //
    // SCR_SetAltTypeface: state-only (see CG_IsAltTypefaceEnabled above) --
    // matches q2repro's own CG_SCR_SetAltTypeface, which is *also* a
    // documented no-op (`// We don't support alternate type faces`) even
    // WITH a kfont loaded; alt-typeface selection is a kfont-internal second
    // glyph set this port has no reader for regardless of asset
    // availability.
    SCR_SetAltTypeface(enabled) {
      altTypefaceEnabled = enabled;
    },
    // drawFontStringDispatch (top of file) -- kfont-aware, with the
    // conchars-only math/draw (drawConcharLines) as its documented fallback.
    SCR_DrawFontString(str, x, y, scale, color, shadow, align) {
      drawFontStringDispatch(str, x, y, scale, color, shadow, align);
    },
    // measureFontStringDispatch (top of file) -- kfont-aware, with the
    // original conchars-only math (`maxlen * CONCHAR_WIDTH * scale`) as its
    // documented fallback.
    SCR_MeasureFontString(str, scale) {
      return measureFontStringDispatch(ensureKfont(), str, scale);
    },
    // fontLineHeightForScale (top of file) -- kfont-aware, with the original
    // `CONCHAR_HEIGHT * scale` as its documented fallback.
    SCR_FontLineHeight(scale) {
      return fontLineHeightForScale(ensureKfont(), scale);
    },

    // Matches q2repro's own CG_CL_GetTextInput, which is a `// FIXME: Hook
    // up with chat prompt` stub upstream too -- not a gap introduced here.
    CL_GetTextInput(_msg, _is_team) {
      return false;
    },

    // TODO(phase 6, kex cgame): weapon-wheel ammo warning thresholds.
    CL_GetWarnAmmoCount(_weapon_id) {
      return 0;
    },

    // Real Loc_Localize (src/qcommon/loc.ts), same allow_in_place=true call
    // site q2repro's CG_Localize uses (client/cgame.c:325-331).
    Localize(base, args, num_args) {
      return Loc_Localize(base, true, args, num_args);
    },

    // Key-bind display for centerprints. `isplit` is unused here (matches
    // q2repro's own CG_SCR_DrawBind, which accepts but never reads it
    // either -- this port has no split-screen support to key it on).
    // Mirrors CG_SCR_DrawBind's composition exactly: "[key] purpose" when
    // bound, "<unbound> purpose" when not, CENTER-aligned, drawn white, no
    // drop shadow, via CG_SCR_DrawFontString (drawFontStringDispatch here --
    // kfont-aware, same as the real CG_SCR_DrawBind's own call into
    // CG_SCR_DrawFontString); returns CONCHAR_HEIGHT unconditionally as the
    // caller's y-advance, matching q2repro's own `return CONCHAR_HEIGHT;`
    // (not scaled, not kfont.line_height, even when a kfont is loaded).
    SCR_DrawBind(_isplit, binding, purpose, x, y, scale) {
      const key = Key_GetBinding(binding);
      const localizedPurpose = Loc_Localize(purpose, true, [], 0);
      const str = key ? `[${key}] ${localizedPurpose}` : `<unbound> ${localizedPurpose}`;
      drawFontStringDispatch(str, x, y, scale, rgba_white, false, TextAlignT.CENTER);
      return CONCHAR_HEIGHT;
    },

    // Matches q2repro's own CG_CL_InAutoDemoLoop, which is a `// FIXME:
    // implement` stub upstream too -- not a gap introduced here.
    CL_InAutoDemoLoop() {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Exports table (cgame -> engine) -- minimal shape for this step
// ---------------------------------------------------------------------------

// ClassicHudDataT bundles the two pieces of per-frame server-sent state the
// classic layout interpreter needs beyond playerstate stats: the raw layout
// string (cl.layout, svc_layout) and the inventory counts array (cl.inventory,
// svc_inventory). This is the classic-shaped analogue of KexCgameExports'
// own CgServerDataT ({ layout, inventory }, kexapi/game.ts) -- not reused
// directly because CgServerDataT.inventory is typed Int16Array while this
// port's `cl.inventory` is an Int32Array (client.ts; a pre-existing,
// out-of-scope-to-fix mismatch from how CL_ParseInventory's MSG_ReadShort
// values get stored) -- reusing CgServerDataT here would force a cast this
// port's zero-cast policy doesn't allow, so classic gets its own
// identically-shaped type instead.
export interface ClassicHudDataT {
  layout: string;
  inventory: Int32Array;
}

// Not KexCgameExports: DrawHUD's signature only carries the subset the
// classic cgame's real implementation (classic.ts + classic_hud.ts) needs --
// playernum and ps mirror KexCgameExports.DrawHUD's own params of the same
// name (kexapi/game.ts), just typed against this port's classic PlayerStateT
// instead of KexPlayerStateT (cl.frame.playerstate's actual type); data is
// ClassicHudDataT above. isplit/hud_vrect/hud_safe/scale are still missing --
// the classic HUD path reads screen geometry off `viddef` directly (see
// classic_hud.ts's own top-of-file comment) rather than through per-split
// rect/scale parameters, so there is nothing for them to carry yet. Grows
// toward KexCgameExports.DrawHUD's full signature in phase 6 when the kex
// cgame needs those remaining parameters for real.
// TouchPics: added alongside the real DrawHUD wiring below (ARCHITECTURE.md
// phase 6 closure) -- cl_scrn.ts's SCR_TouchPics precache call is the real
// KexCgameExports.TouchPics() equivalent this file's own top-of-file comment
// (and cl_scrn.ts's matching TODO on SCR_TouchPics itself) already flagged as
// "exactly the kind of thing KexCgameExports.TouchPics() exists for ...
// CgameExports hasn't grown that member yet". It has now: the sb_nums
// status-bar digit precache (the HUD-owned half of SCR_TouchPics) moves
// behind this member for both cgames; the crosshair pic setup (a cl_view.c
// concern unrelated to either cgame's own layout/HUD data) stays in
// SCR_TouchPics itself, matching that file's own note that splitting sb_nums
// out from under crosshair-only SCOPE would leave no behavioral benefit.
// GetOwnedWeaponWheelWeapons/GetWeaponWheelAmmoCount/GetPowerupWheelCount/
// GetActiveWeaponWheelWeapon -- KexCgameExports' own wheel-data accessors
// (kexapi/game.ts), added to this narrower interface for
// src/client/cl_wheel.ts (the weapon-wheel/carousel client layer, wired to
// the active cgame exactly like DrawHUD is). Signatures take this port's
// classic PlayerStateT (not KexPlayerStateT) for the same reason DrawHUD's
// own `ps` parameter does: CgameExports is the engine-facing shape, and the
// kex adapter below (GetKexCgameAsClassicShape) is what runs
// kexPlayerStateViewFromClassic before forwarding into the real kex cgame.
export interface CgameExports {
  apiversion: number;
  Init(): void;
  Shutdown(): void;
  DrawHUD(playernum: number, ps: PlayerStateT, data: ClassicHudDataT): void;
  TouchPics(): void;
  GetOwnedWeaponWheelWeapons(ps: PlayerStateT): number;
  GetWeaponWheelAmmoCount(ps: PlayerStateT, ammoIndex: number): number;
  GetPowerupWheelCount(ps: PlayerStateT, powerupIndex: number): number;
  GetActiveWeaponWheelWeapon(ps: PlayerStateT): number;
}

// Own versioning for this minimal seam -- not yet KexCgameExports.apiversion
// (which is part of the full 2023 rerelease cgame API). Bumped only when
// this interface's shape changes; superseded once phase 6 raises it toward
// parity with the kex API.
export const CGAME_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Kex cgame adapter -- ARCHITECTURE.md phase 6 ("Kex game module port ...
// then the kex cgame"). DIFF vs. the phase-4-step-1 shape documented at the
// top of this file: this is the first thing to register a SECOND built-in
// cgame with the host.
// ---------------------------------------------------------------------------
//
// src/kexgame/cgame/cg_main.ts's GetCGameAPI returns the full KexCgameExports
// shape (DrawHUD(isplit, data, hud_vrect, hud_safe, scale, playernum, ps),
// plus the weapon-wheel/centerprint/notify/Pmove members) -- richer than
// this file's own minimal CgameExports (DrawHUD(): void, no parameters).
// Registering the kex cgame in ensureActiveCgame()'s registry alongside
// GetClassicCgameAPI means adapting that richer shape down to CgameExports's
// narrower one; this function is that adapter.
//
// DrawHUD used to be a documented no-op here: KexPlayerStateT and the
// classic PlayerStateT `cl.frame.playerstate` actually holds are different
// types, and nothing in this port line converted between them client-side.
// That conversion now exists below (kexPlayerStateViewFromClassic /
// kexServerDataViewFromClassic), built as the DIRECT INVERSE of
// src/server/bindings/kex.ts's syncPlayerStateKexToEngine (server-side,
// kex -> engine): where that function narrows/loses precision going one
// way, this one widens/pads coming back, and both directions are documented
// against the same field table so a future reader can check them side by
// side.
//
// ---------------------------------------------------------------------------
// kexPmTypeFromEngine: the exact inverse of kex.ts's toEnginePmType, which
// collapses two kex-only pm_types (PM_GRAPPLE, PM_NOCLIP) onto legacy
// PM_NORMAL/PM_SPECTATOR because the classic PmTypeT has no equivalent.
// Reversing that collapse is inherently lossy the other way too: legacy
// PM_SPECTATOR could have come from either kex PM_NOCLIP or kex
// PM_SPECTATOR -- this picks PM_SPECTATOR, the direct name match, as the
// "closest faithful thing" (preferences.md rule 3); PM_NOCLIP is simply
// never reconstructed from a classic ps. Every other member is a 1:1 name
// match on both enums and round-trips exactly.
// ---------------------------------------------------------------------------
function kexPmTypeFromEngine(t: PmTypeT): KexPmTypeT {
  switch (t) {
    case PmTypeT.PM_NORMAL:
      return KexPmTypeT.PM_NORMAL;
    case PmTypeT.PM_SPECTATOR:
      return KexPmTypeT.PM_SPECTATOR;
    case PmTypeT.PM_DEAD:
      return KexPmTypeT.PM_DEAD;
    case PmTypeT.PM_GIB:
      return KexPmTypeT.PM_GIB;
    case PmTypeT.PM_FREEZE:
      return KexPmTypeT.PM_FREEZE;
  }
}

// origin/velocity: kex.ts's forward direction is
// `clampInt16(Math.round(kexFloat * 8))` (float units -> 12.3 fixed-point
// int16); the inverse is qcommon/pmove.ts's own established "int16 fixed ->
// float" idiom, `fixed * 0.125` (see pmove.ts's pml.origin/pml.velocity
// assignments) -- not reintroducing a new `/ 8` convention.
function unfixed3(src: Int16Array): Vec3 {
  return new Float32Array([src[0] * 0.125, src[1] * 0.125, src[2] * 0.125]);
}

// delta_angles: kex.ts's forward direction is `ANGLE2SHORT(kexFloatDegrees)`;
// SHORT2ANGLE (q_shared.ts) is that function's own documented inverse.
function shortAngles3(src: Int16Array): Vec3 {
  return new Float32Array([SHORT2ANGLE(src[0]), SHORT2ANGLE(src[1]), SHORT2ANGLE(src[2])]);
}

function kexPmoveStateViewFromClassic(src: PmoveStateT): KexPmoveStateT {
  return {
    pm_type: kexPmTypeFromEngine(src.pm_type),
    origin: unfixed3(src.origin),
    velocity: unfixed3(src.velocity),
    pm_flags: src.pm_flags,
    pm_time: src.pm_time,
    gravity: src.gravity,
    delta_angles: shortAngles3(src.delta_angles),
    // viewheight (kex-only, int8_t): kex.ts's syncPlayerStateKexToEngine
    // documents this field as having no counterpart on this port's classic
    // PmoveStateT and drops it going kex -> engine; there is therefore
    // nothing to recover going the other way either. Defaults to 0 (the
    // classic engine's own implicit viewheight before ducking/crouch
    // adjustment), same "documented, not silently different" gap.
    viewheight: 0,
  };
}

// KexPlayerStateT view assembled from the classic PlayerStateT the real
// client actually populates (cl.frame.playerstate). Field-by-field against
// kex.ts's syncPlayerStateKexToEngine's own doc comment:
//   - pmove: kexPmoveStateViewFromClassic above.
//   - viewangles/viewoffset/kick_angles/gunangles/gunoffset, gunindex,
//     gunskin, gunframe, gunrate, fov, rdflags, team_id: identical shape on
//     both sides (ARCHITECTURE.md's "wide core" widening) -- copied
//     directly, same as the forward direction.
//   - screen_blend <- blend, damage_blend <- damage_blend: same vec4 shape,
//     kex's own field-rename convention (q_shared.ts's PlayerStateT.blend
//     doc comment), copied by value (not aliased) so callers can't mutate
//     the source ps through the view.
//   - stats: this port's classic PlayerStateT.stats is a vanilla
//     Int16Array(32) (q_shared.ts MAX_STATS); kex's own stats array is
//     Int16Array(64) (kexapi/game.ts MAX_STATS). The reverse of kex.ts's
//     documented 64->32 TRUNCATION is a 32->64 WIDEN: the first 32 slots
//     are copied as-is, the remaining 32 (kex-only stats: weapon-wheel,
//     coop-respawn, hit-marker, etc. -- see kexapi/game.ts's PlayerStatT)
//     are zero-filled (Int16Array's own default), matching kex.ts's own
//     "TODO(phase-2b): widen PlayerStateT.stats to 64" note -- until that
//     lands, any kex-only stat read off this view is legitimately 0, not a
//     guess.
function kexPlayerStateViewFromClassic(src: PlayerStateT): KexPlayerStateT {
  const stats = new Int16Array(KEX_MAX_STATS);
  stats.set(src.stats);
  return {
    pmove: kexPmoveStateViewFromClassic(src.pmove),
    viewangles: new Float32Array(src.viewangles),
    viewoffset: new Float32Array(src.viewoffset),
    kick_angles: new Float32Array(src.kick_angles),
    gunangles: new Float32Array(src.gunangles),
    gunoffset: new Float32Array(src.gunoffset),
    gunindex: src.gunindex,
    gunskin: src.gunskin,
    gunframe: src.gunframe,
    gunrate: src.gunrate,
    screen_blend: new Float32Array(src.blend),
    damage_blend: new Float32Array(src.damage_blend),
    fov: src.fov,
    rdflags: src.rdflags,
    stats,
    team_id: src.team_id,
  };
}

// CgServerDataT (kexapi/game.ts) is the same {layout, inventory} shape as
// this file's own ClassicHudDataT, minus the Int32Array/Int16Array mismatch
// ClassicHudDataT's own doc comment cites (cl.inventory is Int32Array;
// CgServerDataT.inventory is Int16Array). CL_ParseInventory only ever writes
// MSG_ReadShort() results into cl.inventory (cl_parse.ts), so every value is
// already in int16 range -- constructing a new Int16Array from the Int32Array
// values is a lossless narrowing, not a truncation, and needs no cast (the
// Int16Array constructor accepts any ArrayLike<number> source).
function kexServerDataViewFromClassic(data: ClassicHudDataT): CgServerDataT {
  return { layout: data.layout, inventory: new Int16Array(data.inventory) };
}

// hud_vrect/hud_safe/scale/isplit: the real kex client (q2repro's
// cgame.c-equivalent caller) computes these once per frame from the video
// mode and a splitscreen layout; no such caller-side computation exists yet
// in this port line (classic_hud.ts's own top-of-file comment notes the same
// gap for ITS geometry -- "no CgameImports counterpart exists yet", reading
// viddef directly instead). This adapter follows that same established
// precedent: hud_vrect covers the full viddef surface, hud_safe is identical
// to hud_vrect (no console-style safe-zone/overscan-inset concept exists in
// this PC-only port), scale is 1 (no hud-scale cvar has been ported), and
// isplit is always 0 (this port has no splitscreen support -- the same
// "isplit is unused/hardcoded 0" precedent buildCgameImports()'s own
// SCR_DrawBind above already documents for KexCgameImports's isplit
// parameter). Follow-up: replace with a real per-frame computation if/when
// splitscreen or HUD-scale cvars land.
function kexHudVrect(): VrectT {
  return { x: 0, y: 0, width: viddef.width, height: viddef.height };
}

function GetKexCgameAsClassicShape(imports: CgameImports): CgameExports {
  const kex = GetKexCgameAPI(imports);
  return {
    // This seam's own minimal-shape versioning (see CGAME_API_VERSION's own
    // doc comment below), NOT kex's real apiversion (KexCgameExports.apiversion
    // is 2022, kexapi/game.ts's CGAME_API_VERSION) -- the adapter is still
    // fulfilling the CgameExports CONTRACT, not exposing the richer kex API
    // surface through this narrow shape.
    apiversion: CGAME_API_VERSION,
    Init: kex.Init,
    Shutdown: kex.Shutdown,
    DrawHUD(playernum, ps, data) {
      const hud_vrect = kexHudVrect();
      kex.DrawHUD(0, kexServerDataViewFromClassic(data), hud_vrect, hud_vrect, 1, playernum, kexPlayerStateViewFromClassic(ps));
    },
    TouchPics: kex.TouchPics,
    GetOwnedWeaponWheelWeapons: (ps) => kex.GetOwnedWeaponWheelWeapons(kexPlayerStateViewFromClassic(ps)),
    GetWeaponWheelAmmoCount: (ps, ammoIndex) => kex.GetWeaponWheelAmmoCount(kexPlayerStateViewFromClassic(ps), ammoIndex),
    GetPowerupWheelCount: (ps, powerupIndex) => kex.GetPowerupWheelCount(kexPlayerStateViewFromClassic(ps), powerupIndex),
    GetActiveWeaponWheelWeapon: (ps) => kex.GetActiveWeaponWheelWeapon(kexPlayerStateViewFromClassic(ps)),
  };
}

// ---------------------------------------------------------------------------
// Active cgame registry
// ---------------------------------------------------------------------------

/** Which built-in cgame ensureActiveCgame() constructs. Defaults to
 *  "classic": nothing in today's client wiring ever calls
 *  CG_SetActiveCgameKind, so this seam's mere existence does not change any
 *  current behavior. */
export type CgameKind = "classic" | "kex";

const cgameFactories: Record<CgameKind, (imports: CgameImports) => CgameExports> = {
  classic: GetClassicCgameAPI,
  kex: GetKexCgameAsClassicShape,
};

let activeCgameKind: CgameKind = "classic";
let activeCgame: CgameExports | null = null;

// Lazy singleton rather than an eager module-scope construction: host.ts,
// classic.ts and cl_scrn.ts form an import cycle (host builds classic,
// classic calls back into cl_scrn.ts's SCR_DrawStats/SCR_DrawLayout,
// cl_scrn.ts calls CG_DrawHUD). Every one of those references is only
// dereferenced from inside a function body, never at module-top-level, so
// the cycle is safe under ESM live bindings -- but building the classic
// cgame this way (on first actual use) sidesteps having to reason about
// module-initialization order at all.
function ensureActiveCgame(): CgameExports {
  if (!activeCgame) {
    activeCgame = cgameFactories[activeCgameKind](buildCgameImports());
    activeCgame.Init();
  }
  return activeCgame;
}

// Exposed for tests and for the eventual cgame-switching logic (rerelease
// server -> kex cgame, classic/legacy server -> classic cgame; see
// q2repro's CG_Load for the precedent this will follow).
export function CG_GetActiveCgame(): CgameExports {
  return ensureActiveCgame();
}

export function CG_SetActiveCgame(cgame: CgameExports): void {
  activeCgame = cgame;
}

// Selection seam: picks which of the two registered factories
// ensureActiveCgame() builds NEXT time it needs to (i.e. after this call, or
// before the first-ever draw). This is the "registry + setActiveCgame"
// extension point the task brief asked for -- q2repro's CG_Load (deciding
// classic vs. kex from the connected server's declared ruleset) is the real
// caller this seam is waiting on. Now called for real from two sites:
// cl_parse.ts's CL_ParseServerData (picks "kex" when the freshly-read
// protocol is PROTOCOL_VERSION_RERELEASE/1038, "classic" otherwise -- mirrors
// q2repro's cgame.c:425-437 "rerelease server -> load the game's cgame;
// classic server -> builtin classic" precedent) and cl_main.ts's
// CL_Disconnect (resets to "classic", the module's own default, on
// disconnect so a dropped kex connection doesn't leave a stale kex cgame
// active for the next, possibly-classic, connection).
export function CG_SetActiveCgameKind(kind: CgameKind): void {
  activeCgameKind = kind;
  activeCgame = null; // force ensureActiveCgame() to rebuild under the new kind
}

export function CG_GetActiveCgameKind(): CgameKind {
  return activeCgameKind;
}

// The single entry point cl_scrn.ts's SCR_UpdateScreen calls in place of its
// former direct SCR_DrawStats()/SCR_DrawLayout()/CL_DrawInventory() calls.
// Gathering playernum/ps/data off `cl` here (rather than inside the cgame)
// is deliberate: this function IS the engine side of the seam, so it's the
// one place allowed to reach into client state directly and hand it down as
// parameters -- exactly the KexCgameExports.DrawHUD calling convention this
// step's ClassicHudDataT/CgameExports.DrawHUD mirror (see their own doc
// comments above).
export function CG_DrawHUD(): void {
  const data: ClassicHudDataT = { layout: cl.layout, inventory: cl.inventory };
  ensureActiveCgame().DrawHUD(cl.playernum, cl.frame.playerstate, data);
}

// The engine side of CgameExports.TouchPics -- called from cl_scrn.ts's
// SCR_TouchPics (see that file's own note on why the sb_nums precache moved
// behind this member while the crosshair precache stayed put) and from
// cl_view.ts's CL_PrepRefresh path that already calls SCR_TouchPics.
export function CG_TouchPics(): void {
  ensureActiveCgame().TouchPics();
  // q2repro's own SCR_LoadKFont call site is inside SCR_Init, right after
  // `cgame->TouchPics()` -- this is the closest counterpart this port's
  // architecture has to that timing (see ensureKfont's own doc comment,
  // top of file, for why the actual load is memoized by `re` identity
  // rather than needing a true one-shot init hook: this call and every
  // draw/measure call below it are equally safe to trigger the real load).
  ensureKfont();
  // q2repro's precache.c calls CL_Wheel_Precache() from its own per-level
  // asset-touch chain, alongside the rest of TouchPics' pic registrations --
  // this is the closest counterpart this port has to that call site (there
  // is no separate precache.ts in this port; see cl_wheel.ts's own file
  // header for why it has no CL_ParseConfigString-time hook either).
  CL_Wheel_Precache();
}

// Exposed for test/cgame_activation.test.ts's ps-view/server-data conversion
// spot checks -- pure functions, no engine state touched.
export { kexPlayerStateViewFromClassic, kexServerDataViewFromClassic, kexPmTypeFromEngine };
