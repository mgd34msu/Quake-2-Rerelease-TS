// cgame host -- ARCHITECTURE.md phase 4 ("Client: cgame host, two built-in
// cgames"). Step 1 of that phase: introduce the seam and exercise it,
// WITHOUT extracting the ~8k lines of cl_scrn/cl_tent/cl_fx/cl_newfx/cl_inv
// that will eventually live behind it. Precedent: q2repro's
// src/client/cgame.c (the host) and src/client/cgame_classic.c (the
// built-in classic cgame), both GPLv2.
//
// CgameImports below is the 2022/2023 cgame import surface verbatim
// (KexCgameImports, src/kexapi/game.ts) -- reused as-is rather than
// trimmed, because every future cgame implementation (including the
// phase 6 kex cgame port) needs the full surface, not a subset invented
// for this step. Only the members the classic cgame's pass-through
// DrawHUD path touches today are wired to real client/engine functions
// in buildCgameImports() below; every other member is a stub, each
// commented with the phase expected to give it a real body.
//
// CgameExports is intentionally NOT the full KexCgameExports -- this step's
// classic cgame is a bare pass-through (Init/Shutdown no-ops, DrawHUD
// delegating to the existing SCR_DrawStats/SCR_DrawLayout functions in
// cl_scrn.ts), so only the members actually exercised are declared. It
// grows toward KexCgameExports's full shape (isplit/data/hud_vrect/
// hud_safe/scale/playernum/ps parameters on DrawHUD, the weapon-wheel/
// centerprint/notify members, etc.) once the kex cgame (phase 6) needs
// them.

import { cl, cls, re } from "../client";
import { Com_Printf, Com_Error as Engine_Com_Error } from "../../qcommon/common";
import { Loc_Localize } from "../../qcommon/loc";
import { ERR_DROP } from "../../qcommon/qcommon";
import { Cvar_Get, Cvar_Set, Cvar_ForceSet } from "../../qcommon/cvar";
import type { KexCgameImports, Vec2T } from "../../kexapi/game";
import { TextAlignT } from "../../kexapi/game";
import { Key_GetBinding } from "../keys_impl";
import { GetClassicCgameAPI } from "./classic";
import { GetCGameAPI as GetKexCgameAPI } from "../../kexgame/cgame/cg_main";

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

// SCR_MeasureFontString's fallback body, factored out so SCR_DrawFontString
// (which needs the total width for CENTER/RIGHT alignment) and
// SCR_FontLineHeight can both call it without duplicating the split-on-'\n'
// walk. See the doc comment on SCR_MeasureFontString below for the
// side-by-side with q2repro's CG_SCR_MeasureFontString.
function measureFontStringFallback(str: string, scale: number): Vec2T {
  const lines = str.split("\n");
  let maxWidth = 0;
  for (const line of lines) {
    const width = line.length * CONCHAR_WIDTH * scale;
    if (width > maxWidth) maxWidth = width;
  }
  return { x: maxWidth, y: lines.length * CONCHAR_HEIGHT * scale };
}

// SCR_DrawFontString's fallback body. KNOWN GAP (documented, not silently
// dropped): re.DrawChar(x, y, c) -- the only char-drawing primitive this
// port's renderer surface has (ref.ts's RefExports) -- takes no scale and
// no color, unlike q2repro's R_DrawStretchChar(x, y, w, h, flags, c, color,
// font) which the real conchars fallback (SCR_DrawStringMultiStretch) uses.
// So: position/line-wrap/alignment math below is scale-correct (matches
// q2repro's own math exactly, see SCR_MeasureFontString's doc comment), but
// each glyph itself always draws at its native 8x8 size in the conchars
// texture's baked color, ignoring `scale`'s effect on glyph size, `color`,
// and `shadow`. This is the exact same gap this file's own SCR_DrawChar
// wrapper above already documents and defers to "once scaled/kfont-aware
// char drawing lands with the kex module" -- not a new gap introduced here.
function drawFontStringFallback(str: string, x: number, y: number, scale: number, align: TextAlignT): void {
  const lines = str.split("\n");
  let lineY = y;
  for (const line of lines) {
    let lineX = x;
    if (align !== TextAlignT.LEFT) {
      const width = line.length * CONCHAR_WIDTH * scale;
      lineX = align === TextAlignT.CENTER ? x - width / 2 : x - width;
    }
    for (let i = 0; i < line.length; i++) {
      drawConchar(lineX + i * CONCHAR_WIDTH * scale, lineY, line.charCodeAt(i));
    }
    lineY += CONCHAR_HEIGHT * scale;
  }
}

// ---------------------------------------------------------------------------
// Import table (engine -> cgame)
// ---------------------------------------------------------------------------

export type CgameImports = KexCgameImports;

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

    // TODO(phase 4 continuation): real once the classic cgame's DrawHUD
    // stops being a bare pass-through and needs to skip stale frames
    // itself instead of relying on cl_scrn.ts's own guards.
    CL_FrameValid() {
      return true;
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

    // TODO(phase 6, kex cgame): client icon assets are a kex HUD concept;
    // the classic HUD path (cl_scrn.ts) reads cl.clientinfo directly today.
    CL_GetClientPic(_index) {
      return "";
    },
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

    // [Paril-KEX] kfont stuff. FINDING (this unit's brief asked for it to be
    // reported): q2repro's SCR_Init loads `fonts/qconfont.kfont` (see
    // src/client/screen.c's SCR_Init and src/refresh/draw.c's
    // SCR_LoadKFont); every one of these four functions branches on
    // `scr.kfont.pic` and falls back to the plain conchars.pcx path
    // (SCR_DrawStringMultiStretch / CONCHAR_WIDTH*scale math) whenever that
    // load failed or never ran. The user's baseq2/rogue/xatrix/ctf/lmctf
    // data at /home/buzzkill/q2ts is 3.21-era: grepping every .pak there for
    // "kfont"/"qconfont" (buzzpak.pak, pak0-2.pak, etc.) finds nothing --
    // no .kfont asset exists in this install, matching a case q2repro
    // itself handles by design (its own load path is a graceful
    // `if (!file) return` in SCR_LoadKFont before ever writing kfont.pic).
    // This port therefore implements ONLY the conchars-fallback branch of
    // all four functions below (the branch that's actually reachable with
    // today's data), with the kfont branch called out as the upgrade path
    // rather than faked: adding it for real means porting the .kfont binary
    // format (SCR_LoadKFont), a kfont-glyph draw primitive
    // (R_DrawKFontChar) neither ref_gl/ nor ref_soft/ has a counterpart for
    // yet, and shipping a rerelease asset pak this install doesn't have.
    //
    // SCR_SetAltTypeface: state-only (see CG_IsAltTypefaceEnabled above) --
    // matches q2repro's own CG_SCR_SetAltTypeface, which is *also* a
    // documented no-op (`// We don't support alternate type faces`) even
    // WITH a kfont loaded; alt-typeface selection is a kfont-internal
    // second glyph set this port has no reader for regardless of the
    // asset-availability finding above.
    SCR_SetAltTypeface(enabled) {
      altTypefaceEnabled = enabled;
    },
    // See drawFontStringFallback's doc comment (top of file) for the
    // known scale/color/shadow gap in the glyph draw itself; the
    // position/wrap/align math here is exact.
    SCR_DrawFontString(str, x, y, scale, _color, _shadow, align) {
      drawFontStringFallback(str, x, y, scale, align);
    },
    // Fallback body factored into measureFontStringFallback (top of file);
    // matches q2repro's CG_SCR_MeasureFontString's own kfont-less branch
    // line for line (split on '\n', width = maxlen * CONCHAR_WIDTH * scale
    // per line, height = num_lines * FontLineHeight(scale)).
    SCR_MeasureFontString(str, scale) {
      return measureFontStringFallback(str, scale);
    },
    // Matches q2repro's CG_SCR_FontLineHeight's own kfont-less branch
    // (`return CONCHAR_HEIGHT * scale;`).
    SCR_FontLineHeight(scale) {
      return CONCHAR_HEIGHT * scale;
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
    // drop shadow; returns CONCHAR_HEIGHT as the caller's y-advance.
    SCR_DrawBind(_isplit, binding, purpose, x, y, scale) {
      const key = Key_GetBinding(binding);
      const localizedPurpose = Loc_Localize(purpose, true, [], 0);
      const str = key ? `[${key}] ${localizedPurpose}` : `<unbound> ${localizedPurpose}`;
      drawFontStringFallback(str, x, y, scale, TextAlignT.CENTER);
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

// Not KexCgameExports: this step's classic cgame is a bare pass-through,
// so only Init/Shutdown/DrawHUD exist. DrawHUD takes no parameters yet --
// it grows to KexCgameExports.DrawHUD's full signature (isplit, data,
// hud_vrect, hud_safe, scale, playernum, ps) in phase 6 when the kex cgame
// needs them and the classic cgame's internals actually move behind this
// interface.
export interface CgameExports {
  apiversion: number;
  Init(): void;
  Shutdown(): void;
  DrawHUD(): void;
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
// DrawHUD is the one member the adapter cannot make real yet: KexPlayerStateT
// (64 stats, weapon-wheel/coop-respawn/hit-marker fields) and the classic
// PlayerStateT that `cl.frame.playerstate` actually holds are DIFFERENT
// TYPES with no conversion function anywhere in this port line -- that
// conversion is protocol-layer work (ARCHITECTURE.md phase 5; see
// buildCgameImports()'s own CL_ServerProtocol/CL_FrameValid stubs above,
// which are TODO'd to the identical phase for the identical reason).
// Fabricating a placeholder KexPlayerStateT out of the classic one would
// silently draw a WRONG hud rather than no hud, so this adapter's DrawHUD is
// a documented no-op instead -- degrades visually, does not crash. Init/
// Shutdown/apiversion need none of that missing state and are wired for
// real. This is exactly the "kex cgame becomes active only when the kex
// binding drives the client, future wiring" boundary from this unit's brief.
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
    DrawHUD() {
      // TODO(phase 5, protocol layer): no KexPlayerStateT / CgServerDataT /
      // per-split hud_vrect/hud_safe/scale/playernum is derivable from the
      // classic client state yet -- see comment above. Intentionally not
      // wired; kex's real CG_DrawHUD (src/kexgame/cgame/cg_screen.ts) is
      // fully implemented and unit-tested (test/kexgame_cgame.test.ts), it
      // just has nothing valid to call it with here yet.
    },
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
// caller this seam is waiting on; nothing calls it yet, so default behavior
// is unchanged.
export function CG_SetActiveCgameKind(kind: CgameKind): void {
  activeCgameKind = kind;
  activeCgame = null; // force ensureActiveCgame() to rebuild under the new kind
}

export function CG_GetActiveCgameKind(): CgameKind {
  return activeCgameKind;
}

// The single entry point cl_scrn.ts's SCR_UpdateScreen calls in place of
// its former direct SCR_DrawStats()/SCR_DrawLayout() calls.
export function CG_DrawHUD(): void {
  ensureActiveCgame().DrawHUD();
}
