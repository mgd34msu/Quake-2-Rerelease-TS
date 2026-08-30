/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from win32/glw_imp.c's GLimp_* family (GNU GPL v2 or later); no linux
gl_glx.c exists in this tree's C reference to port from directly (confirmed
absent -- grepped the whole tree), so this follows glw_imp.c's shape with the
Win32-specific parts (window classes, ChangeDisplaySettings, wgl*) replaced by
SDL2 the same way swimp.ts replaces rw_x11.c's Xlib calls: one bun
implementation per PORTING.md's platform-track rule, not a per-OS ifdef
ladder.

gl_rmain.ts declares the `GLimp` interface this file implements (see that
file's header comment for why: GLimp_* / GL_BeginRendering / GL_EndRendering
belong to a per-platform unit, never to any gl_*.c file) and exposes
`SetGLimp()` as the wiring seam. src/platform/vid.ts's VID_LoadRefresh is
this seam's only caller: it builds a `CreateGLimp()` object and hands it to
`SetGLimp()` before loading ref_gl, exactly the way ref_soft never needed an
analogous call (SWimp_* is imported directly by ref_soft/r_main.ts instead of
going through an interface, since that module never had a "platform not
wired yet" gap to close).

GLimp_SetMode reuses `ri.Vid_GetModeInfo`/`ri.Vid_NewWindow` and the shared
SDL `window` handle in sdl.ts exactly like swimp.ts's SWimp_SetMode does --
this port runs one refresh at a time, never software and GL together, so the
two implementations sharing that one module-level window variable is safe.

GLimp_EnableLogging/GLimp_LogNewFrame have no SDL equivalent to call: they
back win32's optional "wrapgl" call-logging DLL substitution (gl_log cvar),
which this tree never ported (no wrapgl.c anywhere in the C reference, and
gl_rmisc.ts's GL_Strings_f/GL_UpdateSwapInterval don't reference one either).
Both are no-ops here; reported gap, matching qgl.ts's own "no QGL_Shutdown
counterpart" precedent for a feature nothing in the reachable call graph
depends on.

Under the SDL "dummy" video driver (this port's headless/test posture, see
sdl.ts's SDL_setenv propagation), SDL_CreateWindow with SDL_WINDOW_OPENGL
fails outright -- confirmed empirically: "OpenGL support is either not
configured in SDL or not available in current SDL video driver (dummy) or
platform". GLimp_SetMode surfaces that as rserr_unknown rather than throwing,
so R_SetMode/R_Init fail cleanly and vid.ts's VID_LoadRefresh can fall back to
ref_soft the same way a real driver's rejected mode does.
*/

import { PRINT_ALL } from "../shared/q_shared";
import type { GLimp } from "../ref_gl/gl_rmain";
import { ri, RserrT } from "../ref_gl/gl_local";
import { SDL_AppActivate, SDLGL_CreateContext, SDLGL_CreateWindow, SDLGL_GetProcAddress, SDLGL_SetSwapInterval, SDLGL_Shutdown, SDLGL_SwapWindow } from "./sdl";

export function GLimp_Init(hInstance: unknown, wndProc: unknown): boolean {
  return true; // the window is created by GLimp_SetMode, not here -- see SWimp_Init's identical note
}

export function GLimp_SetMode(width: number, height: number, mode: number, fullscreen: boolean): { rserr: RserrT; width: number; height: number } {
  ri.Con_Printf(PRINT_ALL, `setting mode ${mode}:`);

  const info = ri.Vid_GetModeInfo(mode);
  if (!info) {
    ri.Con_Printf(PRINT_ALL, " invalid mode\n");
    return { rserr: RserrT.rserr_invalid_mode, width, height };
  }

  ri.Con_Printf(PRINT_ALL, ` ${info.width} ${info.height}\n`);

  // rw_x11.c/rw_ddraw.c's SWimp_SetMode-equivalent notification -- tells the
  // engine the drawable size before the window actually exists.
  ri.Vid_NewWindow(info.width, info.height);

  if (!SDLGL_CreateWindow(info.width, info.height, fullscreen)) {
    return { rserr: RserrT.rserr_unknown, width: info.width, height: info.height };
  }

  if (!SDLGL_CreateContext()) {
    return { rserr: RserrT.rserr_unknown, width: info.width, height: info.height };
  }

  SDLGL_SetSwapInterval(1);

  return { rserr: RserrT.rserr_ok, width: info.width, height: info.height };
}

export function GLimp_Shutdown(): void {
  SDLGL_Shutdown();
}

export function GLimp_BeginFrame(camera_separation: number): void {
  // win32/glw_imp.c's GLimp_BeginFrame only handles the gl_bitdepth cvar
  // (Win95 OSR2/WinNT display-depth-change gating), which has no SDL
  // equivalent and no field in gl_local.ts's glCvars -- nothing OS-specific
  // is left to do before a frame under this backend.
}

export function GLimp_EndFrame(): void {
  SDLGL_SwapWindow();
}

export function GLimp_AppActivate(active: boolean): void {
  SDL_AppActivate(active);
}

export function GLimp_EnableLogging(enable: boolean): void {
  // no wrapgl-equivalent call-logging path exists in this port -- see file header comment
}

export function GLimp_LogNewFrame(): void {
  // see GLimp_EnableLogging's note
}

export function CreateGLimp(): GLimp {
  return {
    Init: GLimp_Init,
    SetMode: GLimp_SetMode,
    Shutdown: GLimp_Shutdown,
    BeginFrame: GLimp_BeginFrame,
    EndFrame: GLimp_EndFrame,
    AppActivate: GLimp_AppActivate,
    EnableLogging: GLimp_EnableLogging,
    LogNewFrame: GLimp_LogNewFrame,
    GetProcAddress: SDLGL_GetProcAddress,
  };
}
