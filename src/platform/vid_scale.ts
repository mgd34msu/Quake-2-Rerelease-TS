/*
Pure math for two features neither vid_so.c/vid_dll.c nor q2repro's own
refresh.c has any equivalent of (checked both -- see this unit's report for
the q2repro findings): a custom video mode (mode -1, backed by
r_customwidth/r_customheight) and an internal-render-resolution scale
(vid_scale) that lets the engine render at a lower resolution than the
window/display it is presented in, aspect-preserving letterboxed when the
two don't share a ratio.

Split out of vid.ts into its own leaf module (no imports from this project)
so src/platform/sdl.ts can use the same rect math vid.ts uses without
creating an import cycle -- vid.ts already imports SDL_BackendEnabled/
SDLGL_GetProcAddress/SDLVID_SetWindowTitle from sdl.ts, so sdl.ts importing
back from vid.ts would be circular. vid.ts re-exports these for external
callers; this file is the single implementation both sides share.

All four functions are total: every input, including NaN/Infinity/negative/
zero, produces a finite, in-range result rather than throwing or returning
NaN. Bad cvar values (a user typing `r_customwidth abc` or `vid_scale -1`)
must clamp instead of corrupting the mode table lookup or producing a
zero-sized SDL texture.
*/

export interface VidRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Matches q2repro's own VID_GetFullscreen sanity check in src/client/refresh.c
// (`w < 320 || w > 8192 || h < 240 || h > 8192`) -- the one piece of this
// unit's custom-resolution support q2repro's source actually corroborates,
// even though q2repro has no r_customwidth/r_customheight cvars of its own
// (see this unit's report).
export const CUSTOM_WIDTH_MIN = 320;
export const CUSTOM_WIDTH_MAX = 8192;
export const CUSTOM_HEIGHT_MIN = 240;
export const CUSTOM_HEIGHT_MAX = 8192;
export const CUSTOM_WIDTH_DEFAULT = 1920;
export const CUSTOM_HEIGHT_DEFAULT = 1080;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function VID_ClampCustomWidth(value: number): number {
  return clampInt(value, CUSTOM_WIDTH_MIN, CUSTOM_WIDTH_MAX, CUSTOM_WIDTH_DEFAULT);
}

export function VID_ClampCustomHeight(value: number): number {
  return clampInt(value, CUSTOM_HEIGHT_MIN, CUSTOM_HEIGHT_MAX, CUSTOM_HEIGHT_DEFAULT);
}

// vid_scale: fraction of the display resolution actually rendered internally.
// 1.0 (default) renders at full resolution -- byte-for-byte the pre-existing
// behavior. Below MIN_SCALE the source image degrades faster than any
// plausible use case wants; above 1.0 there is nothing to blit down to, so
// values are clamped rather than treated as supersampling (not implemented).
export const VID_SCALE_MIN = 0.1;
export const VID_SCALE_MAX = 1.0;
export const VID_SCALE_DEFAULT = 1.0;

export function VID_ClampScale(value: number): number {
  if (!Number.isFinite(value)) return VID_SCALE_DEFAULT;
  return Math.min(VID_SCALE_MAX, Math.max(VID_SCALE_MIN, value));
}

// The internal render-buffer size for a given display (window/mode) size and
// scale factor. Both axes scale by the same factor, so the render buffer
// always shares the display's aspect ratio -- VID_CalcScaledRect below never
// needs to letterbox a render/display mismatch this function produced, only
// a genuine display-aspect mismatch (e.g. a 4:3 custom mode on a 16:9 one).
export function VID_CalcRenderSize(displayWidth: number, displayHeight: number, scale: number): { width: number; height: number } {
  const s = VID_ClampScale(scale);
  const dw = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 1;
  const dh = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 1;
  return {
    width: Math.max(1, Math.round(dw * s)),
    height: Math.max(1, Math.round(dh * s)),
  };
}

// Aspect-preserving "contain" fit of a renderWidth x renderHeight source
// image into a displayWidth x displayHeight destination: the largest
// integer-pixel rectangle, centered, that fits inside the destination
// without cropping the source. Equal aspect ratios fill the destination
// exactly (x=y=0); a mismatched aspect ratio letterboxes (bars top/bottom)
// or pillarboxes (bars left/right) depending on which axis is the tighter
// fit. Degenerate inputs (zero/negative/non-finite on either side) fall back
// to an unscaled full-destination rect rather than dividing by zero.
export function VID_CalcScaledRect(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number): VidRect {
  const dw = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 0;
  const dh = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 0;

  if (!(Number.isFinite(renderWidth) && renderWidth > 0) || !(Number.isFinite(renderHeight) && renderHeight > 0) || dw <= 0 || dh <= 0) {
    return { x: 0, y: 0, w: dw, h: dh };
  }

  const scale = Math.min(dw / renderWidth, dh / renderHeight);
  const w = Math.max(1, Math.round(renderWidth * scale));
  const h = Math.max(1, Math.round(renderHeight * scale));
  const x = Math.floor((dw - w) / 2);
  const y = Math.floor((dh - h) / 2);
  return { x, y, w, h };
}

// "Scale to fullscreen" toggle (Mike, 2026-09-01, cvar vid_scale_fit):
// VID_CalcScaledRect above always stretches (aspect-preserving fill) the
// render size into the display size. When the player wants crisp,
// unscaled pixels instead, this returns the render's own size centered in
// the display -- no stretch, letterboxed/pillarboxed around it (or,
// symmetrically cropped, if the render is larger than the display).
export function VID_CalcCenteredRect(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number): VidRect {
  const dw = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 0;
  const dh = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 0;
  if (!(Number.isFinite(renderWidth) && renderWidth > 0) || !(Number.isFinite(renderHeight) && renderHeight > 0) || dw <= 0 || dh <= 0) {
    return { x: 0, y: 0, w: dw, h: dh };
  }
  return { x: Math.floor((dw - renderWidth) / 2), y: Math.floor((dh - renderHeight) / 2), w: renderWidth, h: renderHeight };
}

// Single entry point both blit call sites (sdl.ts's SDLVID_Present,
// glimp.ts's GLimp_EndFrame) use: `fit` true = VID_CalcScaledRect's
// existing stretch-to-fill behavior; false = VID_CalcCenteredRect's 1:1
// crisp-pixel behavior. Display-only -- never resizes the render target.
export function VID_CalcBlitRect(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number, fit: boolean): VidRect {
  return fit ? VID_CalcScaledRect(renderWidth, renderHeight, displayWidth, displayHeight) : VID_CalcCenteredRect(renderWidth, renderHeight, displayWidth, displayHeight);
}

// Fullscreen output-surface sizing rule (Mike, 2026-09-01: "on a 4K monitor
// picking 720p fullscreen doesn't mean I want a 720-pixel-high thing, I
// want to PLAY in 720p"): windowed mode's output surface is the selected
// mode's own size (unchanged pre-existing behavior); fullscreen's output
// surface is always the display's native size -- the selected mode instead
// sizes the RENDER target, which VID_CalcBlitRect then stretches (fit) or
// centers (no fit) into that native-size output. No physical display-mode
// switch either way -- SDL_WINDOW_FULLSCREEN_DESKTOP only, see sdl.ts.
export function VID_CalcOutputSize(modeWidth: number, modeHeight: number, nativeDisplayWidth: number, nativeDisplayHeight: number, fullscreen: boolean): { width: number; height: number } {
  if (fullscreen && Number.isFinite(nativeDisplayWidth) && nativeDisplayWidth > 0 && Number.isFinite(nativeDisplayHeight) && nativeDisplayHeight > 0) {
    return { width: Math.round(nativeDisplayWidth), height: Math.round(nativeDisplayHeight) };
  }
  return { width: modeWidth, height: modeHeight };
}
