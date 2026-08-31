/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from null/swimp_null.c (GNU GPL v2 or later), grown into a real
implementation per PORTING.md's platform-track rule ("linux/ win32/... ->
src/platform/ -- ONE bun implementation of the sys/net/vid/snd interfaces"):
the C linux/rw_x11.c allocates an X11 XImage and blits it in SWimp_EndFrame,
and win32/rw_dib.c a DIB section; here SWimp_SetMode allocates `vid.buffer`
itself and hands it to sdl.ts's streaming texture once per EndFrame (see
linux/rw_x11.c's ResetFrameBuffer/SWimp_InitGraphics for the windowed
equivalent this replaces).

When the SDL backend is not armed (a dedicated server, or a test that never
enables it) or the system SDL2 library is missing, every entry point here
degrades to the headless behaviour this file started with: `vid.buffer` is
the rendered frame and there is nothing to present it to.
*/

import { RserrT, ri, sw_state, vid } from "../ref_soft/r_local";
import { SDL_BackendEnabled, SDLVID_Active, SDLVID_Init, SDLVID_Present, SDLVID_Shutdown, SDL_AppActivate } from "./sdl";
import { VID_CalcRenderSize } from "./vid_scale";
import type * as VidModule from "./vid";

// vid.ts (VID_LoadRefresh) statically imports ref_soft/r_main.ts, which
// statically imports this file for the real SWimp_* implementation --
// importing vid.ts's VID_GetScale back from here would close that loop.
// Resolved lazily on this (less fundamental, platform-utility) side, same
// idiom as sdl.ts's keysMod/clInputMod/commonMod.
function vidMod(): typeof VidModule {
  return require("./vid");
}

// The real linux/rw_x11.c SWimp_SetMode ends by calling
// R_GammaCorrectAndSetPalette(d_8to24table) to push the mode's palette to
// the display. That call is dropped here: it lives in r_main.ts, which is
// this function's own caller (R_SetMode), and r_main's R_Init/R_BeginFrame
// already push the palette on their own paths. Reported deviation.

export function SWimp_Init(hInstance: unknown, wndProc: unknown): number {
  return 1; // true: the window is created by SWimp_SetMode, not here
}

export function SWimp_SetMode(width: number, height: number, mode: number, fullscreen: boolean): { pwidth: number; pheight: number; rserr: RserrT } {
  ri.Con_Printf(0, `setting mode ${mode}:`);

  const info = ri.Vid_GetModeInfo(mode); // the display's (window/mode) size
  if (!info) {
    ri.Con_Printf(0, " invalid mode\n");
    return { pwidth: width, pheight: height, rserr: RserrT.rserr_invalid_mode };
  }

  ri.Con_Printf(0, ` ${info.width} ${info.height}\n`);

  // vid_scale (v1.0.0 RC): the engine renders at `render`, decoupled from
  // the window's `info` (display) size -- SDLVID_Init creates the window at
  // `info` and the streaming texture at `render`, so SDLVID_Present's blit
  // upscales (aspect-preserving letterbox) the smaller render buffer to fill
  // the window. scale===1 (the default) makes render===info, byte-for-byte
  // the pre-existing behavior.
  const scale = vidMod().VID_GetScale();
  const render = VID_CalcRenderSize(info.width, info.height, scale);

  vid.width = render.width;
  vid.height = render.height;
  vid.rowbytes = render.width;
  vid.buffer = new Uint8Array(render.width * render.height);

  // rw_x11.c's SWimp_SetMode tells the engine the drawable size; without
  // this the client-side viddef stays 0x0 and SCR_CalcVrect renders nothing.
  // Reports the render (internal) size, not the display size, so 2D/HUD
  // drawing and the software rasterizer agree on one resolution -- the whole
  // frame (game view and HUD together) is what gets scaled up on presentation.
  ri.Vid_NewWindow(render.width, render.height);

  // rw_x11.c: "if ( !SWimp_InitGraphics( false ) ) return rserr_invalid_mode;"
  // -- a failed window/renderer/texture creation must not report success, or
  // the engine renders into a buffer nothing will ever present. When the SDL
  // backend is not armed (dedicated server, headless tests) a false return
  // is the designed degradation, not a failure: vid.buffer IS the frame.
  if (!SDLVID_Init(render.width, render.height, fullscreen, info.width, info.height) && SDL_BackendEnabled()) {
    ri.Con_Printf(0, " SDL window/renderer creation failed\n");
    return { pwidth: render.width, pheight: render.height, rserr: RserrT.rserr_invalid_mode };
  }

  return { pwidth: render.width, pheight: render.height, rserr: RserrT.rserr_ok };
}

// A NULL palette means to use the existing palette. The palette is
// expected to be in a padded 4-byte xRGB format (256 * 4 bytes).
export function SWimp_SetPalette(palette: Uint8Array | null): void {
  const pal = palette ?? sw_state.currentpalette;
  sw_state.currentpalette.set(pal.subarray(0, 1024));
}

export function SWimp_Shutdown(): void {
  SDLVID_Shutdown();
  vid.buffer = new Uint8Array(0);
  vid.width = 0;
  vid.height = 0;
  vid.rowbytes = 0;
}

export function SWimp_BeginFrame(camera_separation: number): void {
  // nothing to do: there is no per-frame surface to (re)acquire, the way
  // rw_ddraw.c's SWimp_BeginFrame locks its DirectDraw surface
}

export function SWimp_EndFrame(): void {
  if (!SDLVID_Active()) return; // vid.buffer is the frame; nothing to blit to
  SDLVID_Present(vid.buffer, vid.rowbytes, vid.width, vid.height, sw_state.currentpalette);
}

export function SWimp_AppActivate(active: boolean): void {
  SDL_AppActivate(active);
}
