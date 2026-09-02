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
import type {
  KexCgameImports,
  Vec2T,
  KexPlayerStateT,
  KexPmoveStateT,
  CgServerDataT,
  VrectT,
  KexCgameExports,
  KexPmoveT,
  KexUsercmdT,
  KexTraceT,
  KexCsurfaceT,
  KexEdictT,
} from "../../kexapi/game";
import {
  TextAlignT,
  KexPmTypeT,
  MAX_STATS as KEX_MAX_STATS,
  rgba_white,
  ContentsT,
  SolidT,
  SvflagsT,
  KexEntityEventT,
  WaterLevelT,
  MAX_ITEMS,
  Max_Armor_Types,
} from "../../kexapi/game";
import type { PlayerStateT, PmoveStateT, TraceT, CsurfaceT, UsercmdT, CvarT } from "../../shared/q_shared";
import { PmTypeT, SHORT2ANGLE, CplaneT, CVAR_ARCHIVE } from "../../shared/q_shared";
import { vec3, type Vec3 } from "../../shared/math";
import type { DrawColorT } from "../ref";
import { Key_GetBinding } from "../keys_impl";
import { viddef } from "../vid";
import { GetClassicCgameAPI } from "./classic";
import { GetCGameAPI as GetKexCgameAPI } from "../../kexgame/cgame/cg_main";
import { ParseKfont, SCR_KFontLookup, Kfont_FromTTF, TtfKfont_Lookup, type KfontT, type KfontCharT, type TtfKfontT } from "./kfont";
import { CL_Wheel_Precache } from "../cl_wheel";
// [item 5] cl_kfont_source's "ttf:<name>" path -- qcommon/ttf.ts's pure
// TTF/OTF parser+rasterizer (no engine/renderer dependency of its own) and
// kfont.ts's own Kfont_FromTTF seam (see that file's "Kfont_FromTTF --
// TTF/OTF-backed kfont seam" section, especially its INTEGRATION CONTRACT
// doc comment -- this file's ensureActiveKfont() below is that contract's
// prescribed caller, implemented for real).
import { parseFont, buildFontAtlas, latin1Codepoints } from "../../qcommon/ttf";
// re.RegisterRawPic: the INTEGRATION CONTRACT's step 4 registration
// primitive, reached through RefExports (ref.ts) so it works under EITHER
// renderer -- see that interface member's own doc comment for the full
// GL-vs-software writeup. Previously this called gl_image.ts's GL_LoadPic
// directly, which only reaches the GL renderer (ref_soft/r_image.ts's own
// GL_LoadPic-equivalent was a private, non-exported function, so a "ttf:"
// source silently registered nothing at all under the software renderer --
// ensureActiveKfont() below would fall back to the classic conchars path
// exactly as it would for any other load failure). Closed by adding
// RegisterRawPic to RefExports (implemented in both gl_rmain.ts, which
// forwards straight to GL_LoadPic, and r_main.ts, which forwards to
// r_image.ts's new R_RegisterRawPic -- RGBA8-to-palette quantization via
// the same QuantizeRGBAToPalette pipeline that renderer's own
// LoadPNGQuantized/LoadJPGQuantized already use for the rerelease's other
// truecolor UI assets), so a "ttf:" source now registers correctly under
// both renderers.

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
// Memoized by `re` IDENTITY (plus, since item 5 below, the resolved source
// cvar state -- see ensureActiveKfont()), not a one-shot flag: `re` is
// swapped out exactly once in a real process (client.ts's setRe, right
// after the renderer constructs) and stays stable for the rest of that
// process's life, so in real play this reduces to "load once, right after
// the renderer exists" -- the same timing q2repro's SCR_Init achieves by
// running once at startup. The identity-keyed cache (rather than a plain
// "attempted yet?" boolean) exists so this module's shared state stays
// correct across test files that call `setRe` repeatedly with different
// fakes in the same process (test/cgame_draw.test.ts's beforeEach, etc.) --
// a plain boolean would wrongly stick to whatever the FIRST test's `re`
// value produced for the rest of the suite.
let kfontCacheFor: unknown = undefined;
let kfontCache: KfontT | null = null;

// ---------------------------------------------------------------------------
// [item 5] cl_kfont_source -- kfont.ts's own "Kfont_FromTTF" doc comment
// (see that file) already spelled out the proposed cvar exactly: a plain
// string cvar, default "kfont" (byte-identical to the load-with-conchars-
// fallback behavior above), also accepting "classic" (force-disable, conchars
// only) and "ttf:<name>" (rasterize fonts/<name>.ttf or .otf via qcommon/
// ttf.ts's parseFont/buildFontAtlas at cl_kfont_ttf_size pixels, ASCII+
// Latin-1 codepoint set per latin1Codepoints()). ActiveKfontT is this file's
// own dispatch shape: both KfontT (the classic .kfont path, fixed 95-entry
// array + SCR_KFontLookup) and TtfKfontT (kfont.ts's Map-based generalization
// + TtfKfont_Lookup) get wrapped behind the SAME {pic, line_height,
// lookup(codepoint)} shape, so every draw/measure function below this point
// only needs to change ITS OWN parameter type from `KfontT | null` to
// `ActiveKfontT | null` and replace `SCR_KFontLookup(font, cp)` with
// `font.lookup(cp)` -- no other body changes, and every preserved-quirk
// doc comment on those functions (unscaled kfont line-height/width,
// CONCHAR_HEIGHT-not-line_height newline advance, etc.) still applies
// unchanged to both wrapped sources.
// ---------------------------------------------------------------------------

// Exported for tests (see drawKfontChar's own export below): the COLR/CPAL
// color-region draw-selection unit tests this shape directly rather than
// re-deriving it from a real TTF/kfont load, since ActiveKfontT.lookup is
// already the exact seam both wrapClassicKfont and wrapTtfKfont funnel
// through.
export interface ActiveKfontT {
  pic: string;
  line_height: number;
  lookup(codepoint: number): KfontCharT | null;
}

function wrapClassicKfont(font: KfontT): ActiveKfontT {
  return { pic: font.pic, line_height: font.line_height, lookup: (cp) => SCR_KFontLookup(font, cp) };
}

function wrapTtfKfont(font: TtfKfontT): ActiveKfontT {
  return { pic: font.pic, line_height: font.line_height, lookup: (cp) => TtfKfont_Lookup(font, cp) };
}

let cl_kfont_source: CvarT | null = null;
let cl_kfont_ttf_size: CvarT | null = null;

function ensureKfontCvars(): void {
  // Cvar_Get is idempotent (this codebase's established convention --
  // multiple files already independently register the same cvar name, e.g.
  // cl_scrn.ts's own SCR_Init comment on scr_font/scr_alpha), so calling
  // this on every ensureActiveKfont() is cheap and correct even if it runs
  // before or after any other registrar.
  if (!cl_kfont_source) cl_kfont_source = Cvar_Get("cl_kfont_source", "kfont", 0);
  if (!cl_kfont_ttf_size) cl_kfont_ttf_size = Cvar_Get("cl_kfont_ttf_size", "16", 0);
}

// kfont.ts's Kfont_FromTTF INTEGRATION CONTRACT, steps 1-5, implemented for
// real: FS_LoadFile the raw font bytes (.ttf, falling back to .otf --
// covers the 3 CFF-flavored files in the real retail font set), parseFont,
// buildFontAtlas over latin1Codepoints() at the requested pixel size,
// register the atlas under a caller-assigned name via re.RegisterRawPic
// (see this file's own import-site doc comment above on RefExports.
// RegisterRawPic for the cross-layer reasoning -- reaches both renderers,
// closing the former GL-only ref_soft gap), then Kfont_FromTTF to relabel
// the atlas into this file's own lookup shape. Any failure at any step
// (file missing, unrecognized sfnt signature, registration failure, etc.)
// returns null -- matches SCR_LoadKFont's own "just return" bail-on-failure
// convention (loadKfontAsset's own doc comment above cites the same
// precedent) rather than throwing.
function loadTtfKfontAsset(name: string, pxSize: number): ActiveKfontT | null {
  if (!re) return null;
  const raw = FS_LoadFile(`fonts/${name}.ttf`) ?? FS_LoadFile(`fonts/${name}.otf`);
  if (!raw) return null;
  const parsed = parseFont(raw);
  if (!parsed.ok) return null;
  const atlas = buildFontAtlas(parsed.font, latin1Codepoints(), pxSize);
  const pic = `/ttf:${name}:${pxSize}`;
  if (!re.RegisterRawPic(pic, atlas.pixels, atlas.width, atlas.height)) return null;
  return wrapTtfKfont(Kfont_FromTTF(atlas, pic));
}

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
/*
ONE MECHANISM, not a font-specific one.

This function briefly carried its own power-of-two PADDING path: it decoded
fonts/qconfont.png itself, copied it into the corner of a power-of-two RGBA
buffer and registered that through RegisterRawPic, because gl_image.ts's
GL_Upload32 resampled the 195x252 atlas up to 256x256 and smeared every 8x14
glyph cell across texel boundaries.

The atlas was never special. A census of the re-release paks finds 156 of the
179 PNGs under pics/ and fonts/ are non-power-of-two -- damage_indicator.png
(96x96), friend.png (30x30), loc_ping.png and marker.png (48x48), every
m_cursorN.png (22x29) -- and so were 116 of the 125 pics in the 1997 baseq2
pak0. All of them were being resampled the same way; the font was simply the
one where a sub-rectangle draw made the smear unmistakable. That is now fixed
where it belongs, once, for every image: GL_Upload32 uploads a non-mipmapped
image at its native size on a context that supports non-power-of-two textures
(gl_config.npot, gl_local.ts / gl_rmain.ts's GL_DetectNpotSupport).

So the padding is gone and this is back to the plain registration it always
was -- the atlas is now exactly as special as every other pic, which is
the point.
*/
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

// The real entry point every draw/measure function below calls (superseding
// the old "always today's classic .kfont" ensureKfont) -- resolves
// cl_kfont_source, then dispatches to whichever loader that source names.
// Cache key is `re` identity PLUS the resolved source/size string, so a
// runtime `cl_kfont_source`/`cl_kfont_ttf_size` change takes effect on the
// next call instead of sticking to whatever loaded first (unlike the plain
// `re`-only memoization the classic-only path used to get away with, since
// that path had no cvar to react to).
let activeKfontCacheKey: string | null = null;
let activeKfontCacheFor: unknown = undefined;
let activeKfontCache: ActiveKfontT | null = null;

function ensureActiveKfont(): ActiveKfontT | null {
  ensureKfontCvars();
  const source = cl_kfont_source!.string;
  const pxSize = Math.trunc(cl_kfont_ttf_size!.value) || 16;
  const key = `${source}|${pxSize}`;

  if (re === activeKfontCacheFor && key === activeKfontCacheKey) return activeKfontCache;
  activeKfontCacheFor = re;
  activeKfontCacheKey = key;

  if (source === "classic") {
    // Force-disable: every draw/measure function's own `!font` branch is
    // the plain conchars fallback, exactly as if no kfont asset existed at
    // all.
    activeKfontCache = null;
  } else if (source.startsWith("ttf:")) {
    activeKfontCache = loadTtfKfontAsset(source.slice(4), pxSize);
  } else {
    // "kfont" (the documented default) and any unrecognized value both
    // fall back to today's pre-item-5 behavior: load the classic
    // fonts/qconfont.kfont asset, or the conchars fallback if that fails --
    // matches cl_kfont_source's own documented default disposition
    // ("kfont (today's default)", kfont.ts's Kfont_FromTTF header comment).
    if (re !== kfontCacheFor) {
      kfontCacheFor = re;
      kfontCache = loadKfontAsset("fonts/qconfont.kfont");
    }
    activeKfontCache = kfontCache ? wrapClassicKfont(kfontCache) : null;
  }
  return activeKfontCache;
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
function fontLineHeightForScale(font: ActiveKfontT | null, scale: number): number {
  if (!font) return CONCHAR_HEIGHT * scale;
  return font.line_height;
}

// CG_MeasureKFontWidth (src/client/cgame.c): sums each looked-up glyph's
// native atlas width. Codepoints SCR_KFontLookup can't find (out of range,
// or a zero-width atlas entry -- e.g. the real qconfont.kfont has no entry
// at all for ` or ~) contribute nothing, matching `if (ch) x += ch->w;`
// exactly (silently skipped, not substituted with a fallback width).
function measureKfontLineWidth(font: ActiveKfontT, line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = font.lookup(line.charCodeAt(i));
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
function measureFontStringDispatch(font: ActiveKfontT | null, str: string, scale: number): Vec2T {
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
// Exported for tests (test/cgame_host_kfont_colr_draw.test.ts): this is the
// actual single-glyph draw-selection function the COLR/CPAL untinted-region
// fix lives in, and it is the correct granularity to unit test at -- see
// this function's own color-region comment below for why the STRING-level
// entry points (drawKStringStretch/drawKStringMultiStretch, and therefore
// the public SCR_DrawFontString/SCR_DrawBind imports) can't carry a PUA
// icon codepoint (0xF0000+) through a plain JS string at all: they iterate
// `s.charCodeAt(i)`, one UTF-16 CODE UNIT at a time, and a codepoint above
// 0xFFFF is a surrogate PAIR in JS -- charCodeAt would yield the two
// surrogate halves (0xD800-0xDFFF), neither of which equals the real
// codepoint the atlas is keyed by. This is not a regression: q2repro's own
// SCR_DrawKStringStretch (src/client/screen.c) is even more restricted --
// `while (*s && maxlen--) { x += R_DrawKFontChar(..., *s++, ...); }` passes
// a raw BYTE (`*s++`, a `const char*` dereference) as the uint32_t
// codepoint, so it can never represent a codepoint above 0xFF either. In
// q2repro, real icon glyphs reach R_DrawKFontChar (the exact single-glyph
// primitive this port's drawKfontChar mirrors) through a DIFFERENT,
// dedicated call site that already has the decoded numeric codepoint in
// hand, never through the generic string walker. This port has no such
// dedicated bind-icon call site yet (SCR_DrawBind above renders key names
// as literal text, e.g. "[MOUSE1] Reload", not icon glyphs) -- wiring one
// is future work, out of this unit's scope (buildFontAtlas/kfont
// draw-model shape only), and does not block this fix: whatever future
// call site draws a real icon glyph will call drawKfontChar directly with
// the numeric codepoint, exactly like q2repro's own icon call site calls
// R_DrawKFontChar directly, and will get the correct untinted color-region
// behavior this function now implements.
export function drawKfontChar(font: ActiveKfontT, x: number, y: number, scale: number, codepoint: number, color: DrawColorT, shadow: boolean): number {
  if (!re) return 0;
  const ch = font.lookup(codepoint);
  if (!ch) return 0;

  const w = ch.w * scale;
  const h = ch.h * scale;

  if (shadow) {
    const offset = 1 * scale;
    const black: DrawColorT = { r: 0, g: 0, b: 0, a: color.a };
    re.DrawStretchPicRegion(x + offset, y + offset, w, h, font.pic, ch.x, ch.y, ch.w, ch.h, black);
  }
  // ch.color (ttf.ts's AtlasRectT.color, carried through by kfont.ts's
  // Kfont_FromTTF -- see that field's own doc comment) marks a COLR v0 +
  // CPAL color-icon region baked into the atlas with its REAL composited
  // RGBA colors, not the usual white-RGB/coverage-alpha text mask. Drawing
  // it tinted by the string's own text `color` (the classic single-tint
  // shape every OTHER kfont glyph uses) would recolor the button-icon
  // artwork -- e.g. a green Xbox "A" button glyph drawn inside white HUD
  // text would come out white too. Draw it with an untinted DrawColorT
  // instead (white RGB so the renderer's tint-modulate step is an identity
  // on the baked pixel colors -- GL_MODULATE's `rgb * 1` on ref_gl,
  // buildColorRemap(255,255,255)'s identity palette remap on ref_soft --
  // while still preserving the caller's own alpha, so a color glyph fades
  // consistently with any text glyphs drawn alongside it in the same HUD
  // fade). No q2repro precedent for this branch: see ttf.ts's own
  // buildFontAtlas doc comment for the full citation (q2repro's
  // draw_kfont_char applies one color to every glyph unconditionally,
  // because its kfont system has no color-icon concept at all).
  const drawColor: DrawColorT = ch.color ? { r: 255, g: 255, b: 255, a: color.a } : color;
  re.DrawStretchPicRegion(x, y, w, h, font.pic, ch.x, ch.y, ch.w, ch.h, drawColor);

  return w;
}

// SCR_DrawKStringStretch (src/client/screen.c): draws a single line
// (no '\n' handling -- that's SCR_DrawKStringMultiStretch's job just
// below), returning the cursor's final x (used by q2repro's own caller to
// place the blink cursor; unused here, but kept for shape parity/future
// callers).
function drawKStringStretch(font: ActiveKfontT, x: number, y: number, scale: number, maxlen: number, s: string, color: DrawColorT, shadow: boolean): number {
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
function drawKStringMultiStretch(font: ActiveKfontT, x: number, y: number, scale: number, maxlen: number, s: string, color: DrawColorT, shadow: boolean): void {
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
  const font = ensureActiveKfont();

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
  /** Draw_Pic with a HUD-scale multiplier on the pic's own native size.
   *  `scale === 1` forwards to the identical `re.DrawPic(x, y, name)` call
   *  Draw_Pic makes, so the byte-for-byte draw-call identity
   *  test/cgame_classic_extraction.test.ts enforces is untouched at the
   *  unscaled tier; above 1 it looks the pic's native size up and issues one
   *  DrawStretchPic instead. See CG_HudUpscaleFactor below for where the
   *  factor comes from and classic_hud.ts's HUD PANE note for why the
   *  classic layout program needed a scale term at all. */
  Draw_PicScaled(x: number, y: number, scale: number, name: string): void;
  /** SCR_DrawChar's scale argument, actually honored. host.ts's own
   *  SCR_DrawChar wrapper drops `scale` (documented gap: RefExports.DrawChar
   *  takes no size), which is fine for a 320x240 HUD drawn at native atlas
   *  size and wrong once the classic HUD carries a scale. `scale === 1`
   *  forwards to that same re.DrawChar call; above 1 the 8x8 conchars cell
   *  is drawn as an atlas sub-rect through RefExports.DrawStretchPicRegion
   *  (the primitive drawConcharLines' own KNOWN GAP note says did not exist
   *  when that gap was written -- it does now). */
  Draw_CharScaled(x: number, y: number, scale: number, num: number): void;
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
    // ClassicOnlyImports, see their declarations above for the scale === 1
    // identity requirement both of these exist to satisfy.
    Draw_PicScaled(x, y, scale, name) {
      if (!re) return;
      if (scale === 1) {
        re.DrawPic(x, y, name);
        return;
      }
      const { w, h } = re.DrawGetPicSize(name);
      // DrawGetPicSize returns -1/-1 (gl_draw.ts) or 0/0 (r_draw.ts) for a
      // pic that does not resolve; both renderers' DrawPic prints the same
      // "Can't find pic" line for it, so fall through to that path rather
      // than issuing a zero/negative-sized stretch of our own.
      if (w <= 0 || h <= 0) {
        re.DrawPic(x, y, name);
        return;
      }
      re.DrawStretchPic(x, y, Math.round(w * scale), Math.round(h * scale), name);
    },
    Draw_CharScaled(x, y, scale, num) {
      if (!re) return;
      if (scale === 1) {
        re.DrawChar(x, y, num);
        return;
      }
      const c = num & 255;
      if ((c & 127) === 32) return; // space -- gl_draw.ts's Draw_Char skips it too
      const size = Math.round(CONCHAR_WIDTH * scale);
      re.DrawStretchPicRegion(x, y, size, size, "conchars", (c & 15) * CONCHAR_WIDTH, ((c >> 4) & 15) * CONCHAR_HEIGHT, CONCHAR_WIDTH, CONCHAR_HEIGHT, rgba_white);
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

    // com_localTime (q2repro's src/common/common.c:141/1138, "milliseconds
    // since Q2 startup", incremented every frame REGARDLESS of sv_paused --
    // that pause-masked variant is the separate com_localTime2, which
    // nothing here needs) has no snapshot of its own in this port, but
    // cls.realtime (Sys_Milliseconds(), cl_main.ts's CL_Frame) is the exact
    // same concept this client already maintains: always-increasing wall
    // time, never rewound, not paused-masked -- cl_scrn.ts's own classic-
    // cgame centerprint fallback (SCR_CenterPrint/SCR_CheckDrawCenterString)
    // already uses cls.realtime for this identical role. Previously hard-
    // coded to 0 (a real bug, not a documented stub-forever gap): every
    // consumer of this import compares a future deadline against its
    // return value to decide when to stop showing something --
    // src/kexgame/cgame/cg_screen.ts's CG_CheckDrawCenterString
    // (`center.finished && center.time_off < CGI().CL_ClientRealTime()`)
    // computes `time_off` as `CL_ClientRealTime() + scr_centertime*1000`,
    // so with this stuck at a constant 0 that comparison was ALWAYS false
    // and centerprints (svc_print's PRINT_CENTER level, e.g. the "You found
    // a secret!" trigger message under the kex cgame) never expired --
    // Mike's "You found a secret!" report, root cause #1 (.orch/followups.md
    // finding 4). Also fixes every OTHER consumer of this same stub for
    // free: cg_main.ts's cgame_init_time-relative blink/flash timers
    // (cg_screen.ts:1532/1570/1720) were all permanently frozen at their
    // t=0 phase for the identical reason.
    CL_ClientRealTime() {
      return cls.realtime;
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
      return measureFontStringDispatch(ensureActiveKfont(), str, scale);
    },
    // fontLineHeightForScale (top of file) -- kfont-aware, with the original
    // `CONCHAR_HEIGHT * scale` as its documented fallback.
    SCR_FontLineHeight(scale) {
      return fontLineHeightForScale(ensureActiveKfont(), scale);
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
// ParseCenterPrint/NotifyMessage (items 5/6, this unit): the two
// KexCgameExports members (kexapi/game.ts:2296/2305) that never had an
// engine-facing home in CgameExports. OPTIONAL, not required-and-stubbed
// like every other CgameExports member above (see GetClassicCgameAPI's own
// "this port's CgameExports interface is narrower... but still requires
// every implementer to provide the same members, so these are harmless
// stubs" comment for that established convention) -- deliberately NOT
// following it here: the task brief scoping this wiring explicitly
// restricts it to "host.ts ONLY", and giving classic.ts (untouched by this
// unit) a harmless-stub implementer of these two would mean editing that
// file too. Optional members let classic.ts's existing object literal
// keep satisfying CgameExports unchanged; every call site below already
// treats their absence as "this cgame doesn't have one" (cl_scrn.ts's
// SCR_CenterPrint: falls through to its own local implementation when
// undefined).
/** One local splitscreen seat's viewport, as handed to a cgame's DrawHUD.
 *  See CgameExports.DrawHUD for why isplit and playernum are separate. */
export interface CgameSeatT {
  isplit: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CgameExports {
  apiversion: number;
  Init(): void;
  Shutdown(): void;
  // `seat` carries the two per-viewport values the 2023 cgame API keeps
  // DISTINCT (game.h:2270's DrawHUD takes both an `isplit` and a
  // `playernum`): `isplit` picks which local HUD-state slot the cgame keeps
  // its centerprint/notify queues in (cg_screen.cpp:107's
  // hud_data[MAX_SPLIT_PLAYERS]), while `playernum` picks whose stats get
  // drawn. `vrect` is the finished screen rectangle the engine is
  // responsible for computing -- the reference cgame never derives it, it
  // only reads it. Absent (the single-viewport case) it stays exactly what
  // it always was: the whole screen, isplit 0.
  DrawHUD(playernum: number, ps: PlayerStateT, data: ClassicHudDataT, seat?: CgameSeatT): void;
  TouchPics(): void;
  GetOwnedWeaponWheelWeapons(ps: PlayerStateT): number;
  GetWeaponWheelAmmoCount(ps: PlayerStateT, ammoIndex: number): number;
  GetPowerupWheelCount(ps: PlayerStateT, powerupIndex: number): number;
  GetActiveWeaponWheelWeapon(ps: PlayerStateT): number;
  ParseCenterPrint?(str: string, isplit: number, instant: boolean): void;
  NotifyMessage?(isplit: number, msg: string, is_chat: boolean): void;
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
// kexPmTypeFromEngine: the exact inverse of server/bindings/kex.ts's
// toEnginePmType, and a total bijection -- every member is a 1:1 name match on
// both enums. PM_GRAPPLE and PM_NOCLIP used to have no engine-side equivalent
// and collapsed onto PM_NORMAL/PM_SPECTATOR, which made this direction lossy
// (a legacy PM_SPECTATOR could have been either kex value, and PM_NOCLIP was
// simply never reconstructable). q_shared.ts's PmTypeT carries both for real
// now, so nothing is lost either way. That matters for prediction: the client
// replays through the kex cgame's own Pmove, and a grappled player predicted
// as PM_NORMAL gets gravity and friction the kex server never applies.
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
    case PmTypeT.PM_GRAPPLE:
      return KexPmTypeT.PM_GRAPPLE;
    case PmTypeT.PM_NOCLIP:
      return KexPmTypeT.PM_NOCLIP;
  }
}

// delta_angles: kex.ts's forward direction is `ANGLE2SHORT(kexFloatDegrees)`;
// SHORT2ANGLE (q_shared.ts) is that function's own documented inverse.
function shortAngles3(src: Int16Array): Vec3 {
  return new Float32Array([SHORT2ANGLE(src[0]), SHORT2ANGLE(src[1]), SHORT2ANGLE(src[2])]);
}

// FLOAT PMOVE STATE END TO END (.orch/followups.md): origin/velocity are
// read straight from PmoveStateT's own float mirror (`originF`/`velocityF`,
// q_shared.ts) -- populated with NO narrowing by protocol/q2repro.ts's 1038
// codec (server -> wire -> client, all genuine IEEE-754 float, matching
// q2repro.c's own encoding) -- instead of widening the legacy 12.3
// fixed-point `origin`/`velocity` Int16Array shadow (`short * 0.125`, this
// function's own former approach). This is the seed CL_PredictMovementKev
// replays from; feeding it the genuine value instead of a re-widened,
// already-quantized one is what eliminates the round trip that was
// destroying PM_StepSlideMove's DIST_EPSILON floor clearance. Seed is only
// this precise once per replay (CL_PredictMovementKex, cl_pred.ts) --
// exactly matching the design note there ("the pmove state stays FLOAT for
// the whole replay").
function kexPmoveStateViewFromClassic(src: PmoveStateT): KexPmoveStateT {
  return {
    pm_type: kexPmTypeFromEngine(src.pm_type),
    origin: new Float32Array(src.originF),
    velocity: new Float32Array(src.velocityF),
    pm_flags: src.pm_flags,
    pm_time: src.pm_time,
    gravity: src.gravity,
    delta_angles: shortAngles3(src.delta_angles),
    // viewheight (int8_t): a real field on this port's PmoveStateT now
    // (q_shared.ts) and carried end to end on protocol 1038 as
    // PS_RR_VIEWHEIGHT, so the classic -> kex direction recovers it instead
    // of hardcoding 0. Vanilla-family servers never set it, which is exactly
    // the 0 this used to hardcode.
    viewheight: src.viewheight,
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
//   - stats: this port's PlayerStateT.stats is MAX_STATS_STORAGE=64-wide
//     (q_shared.ts, "wide core" limit lift landed) -- the SAME width as
//     kex's own stats array (Int16Array(64), kexapi/game.ts MAX_STATS), so
//     `stats.set(src.stats)` below copies all 64 slots for real, including
//     the kex-only stats past index 31 (weapon-wheel, coop-respawn,
//     hit-marker, etc. -- see kexapi/game.ts's PlayerStatT). This used to be
//     a 32->64 widen with the upper 32 zero-filled (kex.ts's former
//     "TODO(phase-2b)" note); that gap is closed, so this is now a plain
//     same-width copy, kept as its own named conversion only because the
//     surrounding fields still need per-field translation (pmove, screen_blend
//     rename, etc.).
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

// ---------------------------------------------------------------------------
// Movement-prediction bridge (q2repro src/client/predict.c:230-243, 270-294)
// ---------------------------------------------------------------------------
// predict.c builds a pmove_t, hands it the client's own trace/clip/
// pointcontents callbacks plus the snapshot's pmove state and viewoffset, and
// dispatches every backed-up usercmd through `cgame->Pmove` -- the SAME
// movement code the server's game module runs. That is the whole point:
// prediction is only correct when both sides execute identical physics.
//
// The kex movement code (kexgame/p_move.ts, reached through the kex cgame's
// own Pmove export, kexgame/cgame/cg_main.ts:169) speaks KexPmoveT: float
// origin/velocity, float usercmd angles, KexTraceT results, KexEdictT trace
// targets. Everything the client actually holds is the classic shape -- the
// 1038 codec (qcommon/protocol/q2repro.ts) deposits pmove origin/velocity
// into PmoveStateT's 12.3 fixed-point Int16Array, exactly the same narrowing
// server/bindings/kex.ts's syncPlayerStateKexToEngine performs on the way in.
// The functions below are the conversions cl_pred.ts needs to cross that gap;
// cl_pred.ts owns the collision callbacks and the replay loop itself.
// ---------------------------------------------------------------------------

/** A cgame's own movement code. */
export type CgamePmoveFn = (pm: KexPmoveT) => void;

// q2repro's CL_Trace assigns `tr->ent = (struct edict_s *)cl_entities` -- the
// client's own entity slot, standing in for a server edict the client does
// not have. The kex movement code stores whatever a trace returns in
// pm.groundentity, tests it for truthiness in a dozen places, and compares it
// for identity against earlier touch entries (p_move.ts:344) -- but never
// reads a single field off it. So what the client needs is a stable IDENTITY
// TOKEN per entity number, not a mirror of the entity: `s.number` is set so
// the object is self-describing, everything else stays at the zero value
// defaultEdict() (kexgame/g_main_globals.ts) would give it.
//
// Identity must be stable for the whole session, not per frame: "am I still
// standing on the same thing I was standing on last frame" is an identity
// comparison across replayed frames. The array is keyed by entity number for
// exactly that reason, and is the client-side counterpart of the parallel
// edict array server/bindings/kex.ts maintains (its `engineEdicts`).
const kexTraceEntities: KexEdictT[] = [];

function makeKexTraceEntity(number: number): KexEdictT {
  return {
    s: {
      number,
      origin: vec3(),
      angles: vec3(),
      old_origin: vec3(),
      modelindex: 0,
      modelindex2: 0,
      modelindex3: 0,
      modelindex4: 0,
      frame: 0,
      skinnum: 0,
      effects: 0n,
      renderfx: 0,
      solid: 0,
      sound: 0,
      event: KexEntityEventT.EV_NONE,
      alpha: 0,
      scale: 0,
      instance_bits: 0,
      loop_volume: 0,
      loop_attenuation: 0,
      owner: 0,
      old_frame: 0,
    },
    client: null,
    sv: {
      init: false,
      ent_flags: 0n,
      buttons: 0,
      spawnflags: 0,
      item_id: 0,
      armor_type: 0,
      armor_value: 0,
      health: 0,
      max_health: 0,
      starting_health: 0,
      weapon: 0,
      team: 0,
      lobby_usernum: 0,
      respawntime: 0,
      viewheight: 0,
      last_attackertime: 0,
      waterlevel: WaterLevelT.WATER_NONE,
      viewangles: vec3(),
      viewforward: vec3(),
      velocity: vec3(),
      start_origin: vec3(),
      end_origin: vec3(),
      enemy: null,
      ground_entity: null,
      classname: null,
      targetname: null,
      netname: "",
      inventory: new Int32Array(MAX_ITEMS),
      armor_info: Array.from({ length: Max_Armor_Types }, () => ({ item_id: 0, max_count: 0 })),
    },
    inuse: false,
    linked: false,
    linkcount: 0,
    areanum: 0,
    areanum2: 0,
    svflags: SvflagsT.SVF_NONE,
    mins: vec3(),
    maxs: vec3(),
    absmin: vec3(),
    absmax: vec3(),
    size: vec3(),
    solid: SolidT.SOLID_NOT,
    clipmask: ContentsT.CONTENTS_NONE,
    owner: null,
  };
}

/** The identity token for entity `number`, allocated on first use and stable
 *  for the rest of the session. Number 0 is the world, matching the server's
 *  own edict-0-is-the-world convention (sv_world.ts's worldEdict()). */
export function CL_KexTraceEntity(number: number): KexEdictT {
  const existing = kexTraceEntities[number];
  if (existing) return existing;
  const created = makeKexTraceEntity(number);
  kexTraceEntities[number] = created;
  return created;
}

function kexCsurfaceFromEngine(s: CsurfaceT | null): KexCsurfaceT | null {
  if (!s) return null;
  // id/material are texinfo metadata the collision model does not carry here;
  // server/bindings/kex.ts's toKexTrace fills them the same way for the same
  // reason, so both sides of a trace see identical surface data.
  return { name: s.name, flags: s.flags, value: s.value, id: 0, material: "" };
}

/** The client-side twin of server/bindings/kex.ts's toKexTrace. */
export function kexTraceFromEngine(t: TraceT, ent: KexEdictT | null): KexTraceT {
  return {
    allsolid: t.allsolid,
    startsolid: t.startsolid,
    fraction: t.fraction,
    endpos: t.endpos,
    plane: t.plane,
    surface: kexCsurfaceFromEngine(t.surface),
    contents: t.contents,
    ent,
    plane2: t.plane2 ?? new CplaneT(),
    surface2: kexCsurfaceFromEngine(t.surface2 ?? null),
  };
}

/** In-place copy, for the "this entity's trace beat the running result" merge
 *  in cl_pred.ts (the client's counterpart of sv_world.ts's
 *  SV_ClipMoveToEntities, which assigns the whole struct by value). */
export function copyKexTrace(dst: KexTraceT, src: KexTraceT): void {
  dst.allsolid = src.allsolid;
  dst.startsolid = src.startsolid;
  dst.fraction = src.fraction;
  dst.endpos = src.endpos;
  dst.plane = src.plane;
  dst.surface = src.surface;
  dst.contents = src.contents;
  dst.ent = src.ent;
  dst.plane2 = src.plane2;
  dst.surface2 = src.surface2;
}

/** The client-side twin of server/bindings/kex.ts's toKexUsercmd. `upmove`,
 *  `impulse` and `lightlevel` have no field on KexUsercmdT and are dropped
 *  here exactly as the server drops them: the kex movement code takes
 *  vertical intent from BUTTON_JUMP/BUTTON_CROUCH instead, which cl_input.ts
 *  (:483-484) already sets from the same +moveup/+movedown key states.
 *  `server_frame` is only read by the server's own lag compensation
 *  (p_view.ts:1562); Pmove never looks at it. */
export function kexUsercmdFromClassic(cmd: UsercmdT, server_frame: number): KexUsercmdT {
  return {
    msec: cmd.msec,
    buttons: cmd.buttons,
    angles: vec3(SHORT2ANGLE(cmd.angles[0]), SHORT2ANGLE(cmd.angles[1]), SHORT2ANGLE(cmd.angles[2])),
    forwardmove: cmd.forwardmove,
    sidemove: cmd.sidemove,
    server_frame,
  };
}

// get_auto_scale (q2repro's src/refresh/draw.c:266-290): the real engine's
// automatic HUD-scale tier off raw display resolution, before any user
// override. Landscape displays tier on height, portrait ones on width --
// preserved exactly, including the asymmetric thresholds (2160/720 vs
// 3840/1920), since that asymmetry is the C source's own real behavior, not
// a transcription slip.
function autoHudUpscale(width: number, height: number): number {
  let scale = 1;
  if (height < width) {
    if (height >= 2160) scale = 4;
    else if (height >= 720) scale = 2;
  } else {
    if (width >= 3840) scale = 4;
    else if (width >= 1920) scale = 2;
  }
  return scale;
  // q2repro's get_auto_scale also clamps against `vid->get_dpi_scale()` when
  // the platform video backend reports one (`max(scale, min_scale)`). This
  // port's platform/vid layer has no DPI-awareness query at all (grepped) --
  // dropped per PORTING.md's "#ifdef ... take the portable path" idiom for a
  // platform capability this port never had, not a silently-dropped behavior
  // with an in-repo counterpart.
}

let scr_scale_cvar: CvarT | null = null;

// R_ClampScale(scr_scale) (q2repro's src/refresh/draw.c:293-301): a
// nonzero, user-set scr_scale (clamped 1..10) wins outright over the auto
// tier above; "0" (scr_scale's own registered default) means auto. Reuses
// the SAME cvar cl_scrn.ts's SCR_Init already registers ("scr_scale", "0",
// CVAR_ARCHIVE, screen.c:1450) -- Cvar_Get is idempotent (cvar.ts:70-74
// returns the existing CvarT, OR-ing in any new flags, when the name is
// already registered), so calling it again here from the cgame-host side is
// the same safe multi-registration pattern this codebase already uses for
// shared cvars, not a duplicate/competing registration.
function hudUpscaleFactor(): number {
  const cvar = scr_scale_cvar ?? (scr_scale_cvar = Cvar_Get("scr_scale", "0", CVAR_ARCHIVE));
  const requested = cvar ? cvar.value : 0;
  if (requested) return Math.min(Math.max(requested, 1), 10);
  return autoHudUpscale(viddef.width, viddef.height);
}

// hud_vrect/hud_safe/scale/isplit: the real kex client (q2repro's
// cgame.c-equivalent caller) computes these once per frame from the video
// mode and a splitscreen layout; no such caller-side computation exists yet
// in this port line (classic_hud.ts's own top-of-file comment notes the same
// gap for ITS geometry -- "no CgameImports counterpart exists yet", reading
// viddef directly instead). This adapter follows that same established
// precedent for hud_safe (identical to hud_vrect -- no console-style safe-
// zone/overscan-inset concept exists in this PC-only port) and isplit
// (always 0, no splitscreen support -- the same "isplit is unused/
// hardcoded 0" precedent buildCgameImports()'s own SCR_DrawBind above
// already documents for KexCgameImports's isplit parameter).
//
// hud_vrect/scale themselves are now real (Mike's "You found a secret!"
// report, root cause #2, .orch/followups.md finding 4): q2repro's actual
// mechanism is a RENDERER-level R_SetScale(1/upscale) applied to the whole
// 2D ortho projection once per frame (screen.c's SCR_Draw2D, "a scaling
// factor of 1 is fine, we're passing a pre-scale HUD rect and the drawing
// functions do the scaling"), paired with a hud_rect ALREADY divided down
// by that same upscale factor and a DrawHUD `scale` argument hardcoded to
// literal `1`. This port's renderer (RefExports, ref.ts) has no SetScale
// primitive -- adding one is a ref.ts/gl_rmain.ts/r_main.ts change, out of
// this file's SCOPE. Per the FIDELITY RAZOR (preferences.md rule 17), the
// OBSERVABLE result -- HUD text drawn at `upscale`x its native atlas pixel
// size on a high-resolution display -- is what must match, not the
// mechanism: every position/size formula inside cg_screen.ts already
// multiplies by its own `scale` PARAMETER (CG_DrawCenterString's
// `lineHeight = (kfont?10:8) * scale`, drawKfontChar's `ch.w * scale`
// above, etc.), so passing `upscale` itself as that parameter -- instead of
// the literal `1` q2repro always passes -- reproduces the identical final
// real-pixel-space numbers algebraically: q2repro computes position/size in
// a SMALLER pre-scale hud_rect times 1, then the renderer's ortho remap
// multiplies the final draw call by `upscale`; this does that same multiply
// one step earlier in the same arithmetic expression, with hud_vrect ALSO
// shrunk to the same pre-scale dimensions so every fractional-of-hud_vrect
// position (e.g. CG_DrawCenterString's `hud_vrect.height * 0.2`) still
// lands on the same virtual coordinate before the final `* scale`.
// Previously hardcoded to viddef's full real pixel dimensions with scale
// fixed at 1 (no separate renderer-level scale to compensate) -- every
// kfont/notify/centerprint glyph drew at its native, unscaled atlas pixel
// size regardless of display resolution, illegibly thin at any modern
// (>=720p) resolution. Q_rint's exact round-half-to-even tie-breaking is
// not reproduced -- plain nearest-integer rounding, cited rather than
// silently approximated.
function kexHudVrect(upscale: number): VrectT {
  return { x: 0, y: 0, width: Math.round(viddef.width / upscale), height: Math.round(viddef.height / upscale) };
}

/*
The same rect, for one local splitscreen seat instead of the whole display.

Every position formula in cg_screen.ts multiplies its hud_vrect term by the
`scale` argument (`x = (hud_vrect.x + atoi(t)) * scale`, cg_screen.ts:890,
and its siblings at :895/:900/:906/:911/:916), so pre-dividing the seat's
real pixel rect by the same upscale factor lands every HUD element back
inside that seat's pane in real pixels -- the identical algebra kexHudVrect
above already relies on for the full screen, with a nonzero origin.

hud_safe is NOT this rect -- see kexSeatHudSafe below.
*/
function kexSeatHudVrect(seat: { x: number; y: number; width: number; height: number }, upscale: number): VrectT {
  return {
    x: Math.round(seat.x / upscale),
    y: Math.round(seat.y / upscale),
    width: Math.round(seat.width / upscale),
    height: Math.round(seat.height / upscale),
  };
}

/** The seat's hud_safe: same size as its hud_vrect, but a ZERO origin,
 *  because cg_screen.ts treats hud_safe.x/y as a real-pixel INSET added to
 *  left/top-anchored positions and subtracted from right/bottom-anchored
 *  ones. This port has no overscan-inset concept, so the inset is zero --
 *  which is exactly what the full-screen path has always effectively passed,
 *  its hud_vrect origin being (0,0). */
function kexSeatHudSafe(hud_vrect: VrectT): VrectT {
  return { x: 0, y: 0, width: hud_vrect.width, height: hud_vrect.height };
}

/** hudUpscaleFactor's auto tier against a seat's pane instead of the whole
 *  display. A user-set scr_scale still wins outright, exactly as it does for
 *  the full-screen path (R_ClampScale, q2repro src/refresh/draw.c:293-301). */
function seatHudUpscaleFactor(width: number, height: number): number {
  const cvar = scr_scale_cvar ?? (scr_scale_cvar = Cvar_Get("scr_scale", "0", CVAR_ARCHIVE));
  const requested = cvar ? cvar.value : 0;
  if (requested) return Math.min(Math.max(requested, 1), 10);
  return autoHudUpscale(width, height);
}

/*
The HUD upscale factor, for the two callers OUTSIDE the kex adapter above.

Until now this tier was the kex cgame's alone: GetKexCgameAsClassicShape
divided hud_vrect by it and passed it as cg_screen.ts's `scale`, while the
CLASSIC cgame drew its 320x240 status bar at native atlas size no matter how
large the display was. That is what left the legacy ruleset with 16x24 health
digits on a 1080p/4K screen while the same engine's re-release ruleset drew
its own HUD at 2x/4x -- the owner's "tiny icons" play-test report. The
classic HUD (classic.ts -> classic_hud.ts) and the crosshair pic
(cl_view.ts's SCR_DrawCrosshair, which is engine-side and shared by both
families) now read the same factor, so one display resolution produces one
HUD size for both rulesets.

Nothing about the SESSION feeds this: it is display geometry and scr_scale
only. A classic-ruleset session is the same size whether it came in on
protocol 36 (narrow, 1997 content) or on the engine-local 4038 wide layout
(re-release content), which is exactly the property the wide-session HUD
needed and did not have to be given -- it was already true, see this unit's
report on what actually differed between those two play-tests.

At the 1x tier (any render size below 720p, e.g. a 640x480 mode or a 1280x960
mode at vid_scale 0.5) every call below is byte-for-byte the pre-existing
draw, so a legacy-resolution session is unchanged.
*/
export function CG_HudUpscaleFactor(): number {
  return hudUpscaleFactor();
}

/** CG_HudUpscaleFactor for one local splitscreen seat's pane. */
export function CG_SeatHudUpscaleFactor(width: number, height: number): number {
  return seatHudUpscaleFactor(width, height);
}

function GetKexCgameAsClassicShape(kex: KexCgameExports): CgameExports {
  return {
    // This seam's own minimal-shape versioning (see CGAME_API_VERSION's own
    // doc comment below), NOT kex's real apiversion (KexCgameExports.apiversion
    // is 2022, kexapi/game.ts's CGAME_API_VERSION) -- the adapter is still
    // fulfilling the CgameExports CONTRACT, not exposing the richer kex API
    // surface through this narrow shape.
    apiversion: CGAME_API_VERSION,
    Init: kex.Init,
    Shutdown: kex.Shutdown,
    DrawHUD(playernum, ps, data, seat) {
      // Per-seat auto scale is derived from the SEAT's rect, not the
      // display's: a quarter-screen pane on a 4K display is 1080p-sized and
      // should pick the 1080p HUD tier, not the 4K one. With no seat this
      // is the pre-splitscreen call, unchanged.
      const upscale = seat ? seatHudUpscaleFactor(seat.width, seat.height) : hudUpscaleFactor();
      const hud_vrect = seat ? kexSeatHudVrect(seat, upscale) : kexHudVrect(upscale);
      // hud_safe is an INSET, not a second rectangle: cg_screen.ts adds
      // hud_safe.x/y to left/top-anchored positions and SUBTRACTS them from
      // right/bottom-anchored ones (cg_screen.ts:890/895/906/911). Passing
      // hud_vrect for it is harmless only while hud_vrect's origin is (0,0),
      // which is why the full-screen call below has always been able to
      // reuse it. A seat's origin is not (0,0), and passing it as the inset
      // pushed every bottom-anchored HUD element off the bottom of the
      // screen -- caught by reading a live 4-way frame, whose two bottom
      // panes drew no HUD at all. Zero insets, matching this port's "no
      // console-style overscan concept" precedent (kexHudVrect's own note).
      const hud_safe = seat ? kexSeatHudSafe(hud_vrect) : hud_vrect;
      kex.DrawHUD(seat ? seat.isplit : 0, kexServerDataViewFromClassic(data), hud_vrect, hud_safe, upscale, playernum, kexPlayerStateViewFromClassic(ps));
    },
    TouchPics: kex.TouchPics,
    GetOwnedWeaponWheelWeapons: (ps) => kex.GetOwnedWeaponWheelWeapons(kexPlayerStateViewFromClassic(ps)),
    GetWeaponWheelAmmoCount: (ps, ammoIndex) => kex.GetWeaponWheelAmmoCount(kexPlayerStateViewFromClassic(ps), ammoIndex),
    GetPowerupWheelCount: (ps, powerupIndex) => kex.GetPowerupWheelCount(kexPlayerStateViewFromClassic(ps), powerupIndex),
    GetActiveWeaponWheelWeapon: (ps) => kex.GetActiveWeaponWheelWeapon(kexPlayerStateViewFromClassic(ps)),
    // [items 5/6] ParseCenterPrint/NotifyMessage: straight pass-throughs --
    // both members have IDENTICAL signatures on KexCgameExports and this
    // narrower CgameExports (kexapi/game.ts:2296/2305), unlike DrawHUD/the
    // wheel accessors above (which all need a playerstate-shape conversion
    // via kexPlayerStateViewFromClassic). kex.ParseCenterPrint is
    // src/kexgame/cgame/cg_screen.ts's real CG_ParseCenterPrint (the
    // %bind:cmd:purpose% stripping + queue/typewriter machinery, cg_main.ts's
    // `ParseCenterPrint: CG_ParseCenterPrint` export) -- see cl_scrn.ts's
    // SCR_CenterPrint for the delegation call site this makes real.
    ParseCenterPrint: kex.ParseCenterPrint,
    NotifyMessage: kex.NotifyMessage,
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

// What a built cgame hands back to the host. `Pmove` is the member q2repro's
// cgame_export_t carries and its predict.c calls for every replayed usercmd.
//
// It is null for classic, and that is not a gap: v3.19 had no cgame at all --
// Pmove lived in the engine (qcommon/pmove.ts here, exactly as in the
// original) and cl_pred.ts calls it directly, which is the byte-for-byte
// vanilla path this port must not disturb. The kex cgame really does own its
// movement code (kexgame/cgame/cg_main.ts:169 forwards to kexgame/p_move.ts,
// the same function kexgame/p_client.ts's ClientThink runs server-side), so
// for kex sessions this is the one and only movement implementation on both
// sides of the wire.
interface BuiltCgame {
  exports: CgameExports;
  Pmove: CgamePmoveFn | null;
}

const cgameFactories: Record<CgameKind, (imports: CgameImports) => BuiltCgame> = {
  classic: (imports) => ({ exports: GetClassicCgameAPI(imports), Pmove: null }),
  kex: (imports) => {
    const kex = GetKexCgameAPI(imports);
    return { exports: GetKexCgameAsClassicShape(kex), Pmove: (pm: KexPmoveT) => kex.Pmove(pm) };
  },
};

let activeCgameKind: CgameKind = "classic";
let activeCgame: BuiltCgame | null = null;

// Lazy singleton rather than an eager module-scope construction: host.ts,
// classic.ts and cl_scrn.ts form an import cycle (host builds classic,
// classic calls back into cl_scrn.ts's SCR_DrawStats/SCR_DrawLayout,
// cl_scrn.ts calls CG_DrawHUD). Every one of those references is only
// dereferenced from inside a function body, never at module-top-level, so
// the cycle is safe under ESM live bindings -- but building the classic
// cgame this way (on first actual use) sidesteps having to reason about
// module-initialization order at all.
function ensureActiveCgame(): BuiltCgame {
  if (!activeCgame) {
    activeCgame = cgameFactories[activeCgameKind](buildCgameImports());
    activeCgame.exports.Init();
  }
  return activeCgame;
}

// Exposed for tests and for the eventual cgame-switching logic (rerelease
// server -> kex cgame, classic/legacy server -> classic cgame; see
// q2repro's CG_Load for the precedent this will follow).
export function CG_GetActiveCgame(): CgameExports {
  return ensureActiveCgame().exports;
}

export function CG_SetActiveCgame(cgame: CgameExports): void {
  activeCgame = { exports: cgame, Pmove: null };
}

/** The active cgame's own movement code, for cl_pred.ts's replay loop --
 *  q2repro predict.c's `cgame->Pmove`. Null means "this cgame does not own
 *  movement", i.e. the classic path, which predicts through qcommon/pmove.ts
 *  directly (see BuiltCgame's own comment). Constructs the cgame if it has
 *  not been built yet, exactly as CG_DrawHUD does. */
export function CG_GetActiveCgamePmove(): CgamePmoveFn | null {
  return ensureActiveCgame().Pmove;
}

// Selection seam: picks which of the two registered factories
// ensureActiveCgame() builds NEXT time it needs to (i.e. after this call, or
// before the first-ever draw). This is the "registry + setActiveCgame"
// extension point the task brief asked for -- q2repro's CG_Load (deciding
// classic vs. kex from the connected server's declared ruleset) is the real
// caller this seam is waiting on. Now called for real from two sites:
// cl_parse.ts's CL_ParseServerData (picks "kex" when the freshly-read
// protocol says the server runs the RERELEASE game module -- cls.gameFamily,
// see client.ts; note that is not the same as "the protocol is wide", since a
// classic-module session widens its configstring space whenever the map needs
// it and must keep the classic HUD -- mirrors q2repro's cgame.c:425-437
// "rerelease server -> load the game's cgame; classic server -> builtin
// classic" precedent) and cl_main.ts's
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
  ensureActiveCgame().exports.DrawHUD(cl.playernum, cl.frame.playerstate, data);
}

/** CG_DrawHUD for one local splitscreen seat's viewport (cl_scrn.ts's
 *  per-seat draw loop). `layout`/`inventory` stay the connection's -- they
 *  arrive over the one wire this session has, and the reference API delivers
 *  them the same way: DrawHUD's `data` parameter carries no split index. */
export function CG_DrawHUDForSeat(playernum: number, ps: PlayerStateT, seat: CgameSeatT): void {
  const data: ClassicHudDataT = { layout: cl.layout, inventory: cl.inventory };
  ensureActiveCgame().exports.DrawHUD(playernum, ps, data, seat);
}

// The engine side of CgameExports.TouchPics -- called from cl_scrn.ts's
// SCR_TouchPics (see that file's own note on why the sb_nums precache moved
// behind this member while the crosshair precache stayed put) and from
// cl_view.ts's CL_PrepRefresh path that already calls SCR_TouchPics.
export function CG_TouchPics(): void {
  ensureActiveCgame().exports.TouchPics();
  // q2repro's own SCR_LoadKFont call site is inside SCR_Init, right after
  // `cgame->TouchPics()` -- this is the closest counterpart this port's
  // architecture has to that timing (see ensureActiveKfont's own doc
  // comment, top of file, for why the actual load is memoized by `re`
  // identity plus the resolved cl_kfont_source rather than needing a true
  // one-shot init hook: this call and every draw/measure call below it are
  // equally safe to trigger the real load).
  ensureActiveKfont();
  // q2repro's precache.c calls CL_Wheel_Precache() from its own per-level
  // asset-touch chain, alongside the rest of TouchPics' pic registrations --
  // this is the closest counterpart this port has to that call site (there
  // is no separate precache.ts in this port; see cl_wheel.ts's own file
  // header for why it has no CL_ParseConfigString-time hook either).
  CL_Wheel_Precache();
}

// Exposed for test/cgame_activation.test.ts's ps-view/server-data conversion
// spot checks -- pure functions, no engine state touched.
export { kexPlayerStateViewFromClassic, kexServerDataViewFromClassic, kexPmTypeFromEngine, kexPmoveStateViewFromClassic };
// Exported for test/cgame_host_hud_scale.test.ts: pure functions pinning
// root cause #2 of Mike's "You found a secret!" report (see kexHudVrect's
// own doc comment above) against q2repro's real get_auto_scale/
// R_ClampScale tiering.
export { autoHudUpscale, hudUpscaleFactor, kexHudVrect };
// Same reason, for the local-splitscreen per-seat variants: pure functions
// pinning that a seat's HUD scales to its own pane and lands inside it
// (test/splitscreen_seats.test.ts).
export { kexSeatHudVrect, kexSeatHudSafe, seatHudUpscaleFactor };
