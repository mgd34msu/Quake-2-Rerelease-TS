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

v1.0.0 RC vid_scale (render-resolution scaling): GLimp_SetMode reports the
*render* size (info.width/height * vid_scale) to Vid_NewWindow/its own return
value -- gl_rmain.ts's vid.width/vid.height, and therefore every glViewport
call it makes each frame, follow that size automatically (see R_SetMode/
R_BeginFrame in gl_rmain.ts, no changes needed there) -- while the actual SDL
window is created at the mode's full (display) size via SDLGL_CreateWindow.
When the two differ, GLScale_Setup below allocates an ARB_framebuffer_object
render target sized to the render resolution; GLimp_BeginFrame binds it so
everything gl_rmain.ts draws lands there, and GLimp_EndFrame blits it into
the default framebuffer scaled into an aspect-preserving letterboxed rect
(VID_CalcScaledRect, the same math src/platform/sdl.ts's software path uses)
before swapping. No q2repro precedent for any of this (checked: no r_scale/
downscale-and-present feature anywhere in its refresh or GL backend), so this
is this port's own design -- see this unit's report.
*/

import { PRINT_ALL } from "../shared/q_shared";
import type { GLimp } from "../ref_gl/gl_rmain";
import { ri, RserrT } from "../ref_gl/gl_local";
import { qgl } from "../ref_gl/gl_image";
import { SDL_AppActivate, SDLGL_CreateContext, SDLGL_CreateWindow, SDLGL_GetProcAddress, SDLGL_SetSwapInterval, SDLGL_Shutdown, SDLGL_SwapWindow } from "./sdl";
import { VID_CalcRenderSize, VID_CalcScaledRect } from "./vid_scale";
import type * as VidModule from "./vid";

// vid.ts (VID_LoadRefresh) statically imports this file's CreateGLimp;
// importing vid.ts's VID_GetScale back from here would close that loop.
// Resolved lazily on this (less fundamental, platform-utility) side, same
// idiom swimp.ts and sdl.ts already use for their own back-references.
function vidMod(): typeof VidModule {
  return require("./vid");
}

// ARB_framebuffer_object / GL3.0 core enum values gl_rmain.ts/qgl.ts never
// needed before this feature -- qgl.ts's QGL interface takes the numeric
// target/attachment/enum arguments as plain `number`, so these live here
// rather than in qgl.ts alongside the function bindings themselves.
const GL_TEXTURE_2D = 0x0de1;
const GL_RGB = 0x1907;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_LINEAR = 0x2601;
const GL_FRAMEBUFFER = 0x8d40;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;
const GL_COLOR_BUFFER_BIT = 0x00004000;

let scaleFbo = 0;
let scaleColorTex = 0;
let scaleRenderWidth = 0;
let scaleRenderHeight = 0;
let scaleDisplayWidth = 0;
let scaleDisplayHeight = 0;
let scaleActive = false;
let scaleWarned = false;

// Frees the render-scale target, if one exists. Safe to call whether or not
// GLScale_Setup ever succeeded (every GLimp_SetMode call clears the previous
// mode's target before deciding whether the new one needs its own).
function GLScale_Shutdown(): void {
  if (scaleFbo && qgl.qglDeleteFramebuffers) {
    qgl.qglDeleteFramebuffers(1, new Uint32Array([scaleFbo]));
  }
  if (scaleColorTex) {
    qgl.qglDeleteTextures(1, new Uint32Array([scaleColorTex]));
  }
  scaleFbo = 0;
  scaleColorTex = 0;
  scaleActive = false;
}

// Allocates an FBO + color texture sized to the render resolution. Returns
// false (leaving nothing allocated) when ARB_framebuffer_object isn't
// available on this context or the driver reports an incomplete framebuffer
// -- GLimp_SetMode's caller then renders unscaled at the render resolution
// directly to the window rather than failing the whole mode set over a
// feature nothing but vid_scale depends on.
function GLScale_Setup(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number): boolean {
  if (!qgl.qglGenFramebuffers || !qgl.qglBindFramebuffer || !qgl.qglFramebufferTexture2D || !qgl.qglCheckFramebufferStatus || !qgl.qglBlitFramebuffer || !qgl.qglDeleteFramebuffers) {
    if (!scaleWarned) {
      ri.Con_Printf(PRINT_ALL, "GLimp: framebuffer objects unavailable on this context -- vid_scale disabled\n");
      scaleWarned = true;
    }
    return false;
  }

  const texName = new Uint32Array(1);
  qgl.qglGenTextures(1, texName);
  scaleColorTex = texName[0];
  qgl.qglBindTexture(GL_TEXTURE_2D, scaleColorTex);
  qgl.qglTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, renderWidth, renderHeight, 0, GL_RGB, GL_UNSIGNED_BYTE, null);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

  const fboName = new Uint32Array(1);
  qgl.qglGenFramebuffers(1, fboName);
  scaleFbo = fboName[0];
  qgl.qglBindFramebuffer(GL_FRAMEBUFFER, scaleFbo);
  qgl.qglFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, scaleColorTex, 0);

  const status = qgl.qglCheckFramebufferStatus(GL_FRAMEBUFFER);
  qgl.qglBindFramebuffer(GL_FRAMEBUFFER, 0);

  if (status !== GL_FRAMEBUFFER_COMPLETE) {
    ri.Con_Printf(PRINT_ALL, "GLimp: render-scale framebuffer incomplete -- vid_scale disabled\n");
    GLScale_Shutdown();
    return false;
  }

  scaleRenderWidth = renderWidth;
  scaleRenderHeight = renderHeight;
  scaleDisplayWidth = displayWidth;
  scaleDisplayHeight = displayHeight;
  scaleActive = true;
  return true;
}

export function GLimp_Init(hInstance: unknown, wndProc: unknown): boolean {
  return true; // the window is created by GLimp_SetMode, not here -- see SWimp_Init's identical note
}

export function GLimp_SetMode(width: number, height: number, mode: number, fullscreen: boolean): { rserr: RserrT; width: number; height: number } {
  ri.Con_Printf(PRINT_ALL, `setting mode ${mode}:`);

  const info = ri.Vid_GetModeInfo(mode); // the display's (window/mode) size
  if (!info) {
    ri.Con_Printf(PRINT_ALL, " invalid mode\n");
    return { rserr: RserrT.rserr_invalid_mode, width, height };
  }

  ri.Con_Printf(PRINT_ALL, ` ${info.width} ${info.height}\n`);

  const scale = vidMod().VID_GetScale();
  const render = VID_CalcRenderSize(info.width, info.height, scale);

  // rw_x11.c/rw_ddraw.c's SWimp_SetMode-equivalent notification -- tells the
  // engine the drawable size before the window actually exists. Reports the
  // render (internal) size, not the display size -- see file header comment.
  ri.Vid_NewWindow(render.width, render.height);

  GLScale_Shutdown(); // drop the previous mode's render-scale target, if any

  if (!SDLGL_CreateWindow(info.width, info.height, fullscreen)) {
    return { rserr: RserrT.rserr_unknown, width: render.width, height: render.height };
  }

  if (!SDLGL_CreateContext()) {
    return { rserr: RserrT.rserr_unknown, width: render.width, height: render.height };
  }

  SDLGL_SetSwapInterval(1);

  if (render.width !== info.width || render.height !== info.height) {
    GLScale_Setup(render.width, render.height, info.width, info.height); // false leaves scaleActive false: renders unscaled, see that function's header comment
  }

  return { rserr: RserrT.rserr_ok, width: render.width, height: render.height };
}

export function GLimp_Shutdown(): void {
  GLScale_Shutdown();
  SDLGL_Shutdown();
}

export function GLimp_BeginFrame(camera_separation: number): void {
  // win32/glw_imp.c's GLimp_BeginFrame only handles the gl_bitdepth cvar
  // (Win95 OSR2/WinNT display-depth-change gating), which has no SDL
  // equivalent and no field in gl_local.ts's glCvars -- nothing OS-specific
  // is left to do before a frame under this backend.
  //
  // vid_scale: redirect the frame gl_rmain.ts is about to draw into the
  // render-resolution target instead of the window's own (display-sized)
  // default framebuffer. gl_rmain.ts's own glViewport call right after this
  // (R_BeginFrame, using vid.width/vid.height) already matches the FBO's
  // size -- see file header comment -- so nothing else here needs to change.
  if (scaleActive && qgl.qglBindFramebuffer) {
    qgl.qglBindFramebuffer(GL_FRAMEBUFFER, scaleFbo);
  }
}

export function GLimp_EndFrame(): void {
  if (scaleActive && qgl.qglBindFramebuffer && qgl.qglBlitFramebuffer) {
    const rect = VID_CalcScaledRect(scaleRenderWidth, scaleRenderHeight, scaleDisplayWidth, scaleDisplayHeight);

    qgl.qglBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    qgl.qglViewport(0, 0, scaleDisplayWidth, scaleDisplayHeight);
    qgl.qglClear(GL_COLOR_BUFFER_BIT); // paints the letterbox bars when the aspect ratio doesn't match

    qgl.qglBindFramebuffer(GL_READ_FRAMEBUFFER, scaleFbo);
    qgl.qglBlitFramebuffer(0, 0, scaleRenderWidth, scaleRenderHeight, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, GL_COLOR_BUFFER_BIT, GL_LINEAR);
    qgl.qglBindFramebuffer(GL_FRAMEBUFFER, 0);
  }

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
