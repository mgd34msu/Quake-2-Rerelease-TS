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

import { PRINT_ALL, CVAR_REFRESH } from "../shared/q_shared";
import type { GLimp } from "../ref_gl/gl_rmain";
import { ri, RserrT } from "../ref_gl/gl_local";
import { qgl } from "../ref_gl/gl_image";
import { SDL_AppActivate, SDLGL_CreateContext, SDLGL_CreateWindow, SDLGL_GetDesktopSize, SDLGL_GetProcAddress, SDLGL_SetSwapInterval, SDLGL_Shutdown, SDLGL_SwapWindow } from "./sdl";
import { VID_CalcRenderSize, VID_CalcBlitRect, VID_CalcOutputSize } from "./vid_scale";
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
const GL_RENDERBUFFER = 0x8d41;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_DEPTH_ATTACHMENT = 0x8d00;
const GL_DEPTH_COMPONENT24 = 0x81a6;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;
const GL_COLOR_BUFFER_BIT = 0x00004000;
const GL_DEPTH_BUFFER_BIT = 0x00000100;

let scaleFbo = 0;
let scaleColorTex = 0;
// Bug fix (Mike, 2026-09-02): the render-scale FBO originally attached
// only a color texture -- no depth buffer at all. GL_DEPTH_TEST (glimp.ts
// never touches this cvar/state itself; gl_rmain.ts's normal per-frame
// setup enables it exactly the same whether or not scaleActive) cannot
// work correctly with no depth attachment to test/write against, and
// depth-equal multipass techniques (the world's lightmap modulation pass
// in particular) simply don't draw at all without one -- confirmed with a
// real rendered frame: world/lightmap surfaces missing entirely, only sky
// and alias models (which don't depend on that same depth-equal pass)
// drew. A real window's default framebuffer always has a depth buffer
// (SDLGL_CreateWindow's SDL_GL_DEPTH_SIZE attribute) -- this renderbuffer
// gives the FBO path the same thing, sized to match.
let scaleDepthRbo = 0;
let scaleRenderWidth = 0;
let scaleRenderHeight = 0;
let scaleDisplayWidth = 0;
let scaleDisplayHeight = 0;
let scaleActive = false;
let scaleWarned = false;
// QoL addition (Mike, 2026-09-01, "scale to fullscreen" toggle, cvar
// vid_scale_fit): whether GLimp_EndFrame stretches the render target to
// fill scaleDisplayWidth/scaleDisplayHeight (true, byte-for-byte the
// pre-existing behavior) or centers it at its own size, unscaled (false).
let scaleFit = true;
// Bug fix (Mike, 2026-09-02, owner's play-test report: fullscreen fit/scale
// never actually engaged -- "fit screen ... was not applied at all"). Root
// cause #4 (see this unit's report for #1-#3: sdl.ts's desktopDisplaySize,
// gl_rmain.ts's R_BeginFrame OR-condition, gl_local.ts's allow_cds
// default): GLimp_SetMode calls GLScale_Setup synchronously, as part of
// context creation itself -- but gl_rmain.ts's own R_Init header comment
// (right above its SECOND `SetQGL(loadQGLFromSystem(...))` call) already
// documents exactly this class of bug for the SHADER path: the FIRST QGL
// resolution runs before any GL context has ever existed in the process,
// and getProcAddress cannot reliably resolve extension entry points (confirmed on this
// unit's own RTX hardware) until a context has actually been made current
// once -- R_Init re-resolves QGL a second time, after R_SetMode, for
// exactly that reason, and GL_InitShaderPath runs after THAT second
// resolution rather than being called from inside SetMode. GLimp_SetMode's
// vid_scale FBO setup never got the same treatment: it runs inside the
// first (unreliable) QGL resolution, so qgl.qglGenFramebuffers and friends
// were still null on a cold boot straight into `vid_ref gl` -- confirmed
// empirically, "GLimp: framebuffer objects unavailable on this context --
// vid_scale disabled" printed even on hardware whose FBO support is not in
// question. These three remember the last SetMode call's scale geometry
// (regardless of whether GLScale_Setup succeeded) so GLimp_RetryScaleSetup
// below can redo it once QGL is reliably resolved, the same way
// GL_InitShaderPath gets a second, later, authoritative attempt.
let scaleNeeded = false;
let scaleNeededRenderWidth = 0;
let scaleNeededRenderHeight = 0;
let scaleNeededDisplayWidth = 0;
let scaleNeededDisplayHeight = 0;
let scaleNeededFit = true;

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
  if (scaleDepthRbo && qgl.qglDeleteRenderbuffers) {
    qgl.qglDeleteRenderbuffers(1, new Uint32Array([scaleDepthRbo]));
  }
  scaleFbo = 0;
  scaleColorTex = 0;
  scaleDepthRbo = 0;
  scaleActive = false;
}

// Allocates an FBO + color texture + depth renderbuffer, all sized to the
// render resolution. Returns false (leaving nothing allocated) when
// ARB_framebuffer_object isn't available on this context or the driver
// reports an incomplete framebuffer -- GLimp_SetMode's caller then renders
// unscaled at the render resolution directly to the window rather than
// failing the whole mode set over a feature nothing but vid_scale depends
// on. Bug fix (Mike, 2026-09-02): the depth renderbuffer below used to not
// exist at all -- see scaleDepthRbo's own doc comment for the reproduced
// symptom (world/lightmap geometry missing from the rendered frame).
function GLScale_Setup(renderWidth: number, renderHeight: number, displayWidth: number, displayHeight: number, fit: boolean): boolean {
  if (
    !qgl.qglGenFramebuffers ||
    !qgl.qglBindFramebuffer ||
    !qgl.qglFramebufferTexture2D ||
    !qgl.qglCheckFramebufferStatus ||
    !qgl.qglBlitFramebuffer ||
    !qgl.qglDeleteFramebuffers ||
    !qgl.qglGenRenderbuffers ||
    !qgl.qglBindRenderbuffer ||
    !qgl.qglRenderbufferStorage ||
    !qgl.qglFramebufferRenderbuffer ||
    !qgl.qglDeleteRenderbuffers
  ) {
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

  const rboName = new Uint32Array(1);
  qgl.qglGenRenderbuffers(1, rboName);
  scaleDepthRbo = rboName[0];
  qgl.qglBindRenderbuffer(GL_RENDERBUFFER, scaleDepthRbo);
  qgl.qglRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, renderWidth, renderHeight);

  const fboName = new Uint32Array(1);
  qgl.qglGenFramebuffers(1, fboName);
  scaleFbo = fboName[0];
  qgl.qglBindFramebuffer(GL_FRAMEBUFFER, scaleFbo);
  qgl.qglFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, scaleColorTex, 0);
  qgl.qglFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, scaleDepthRbo);

  const status = qgl.qglCheckFramebufferStatus(GL_FRAMEBUFFER);
  qgl.qglBindFramebuffer(GL_FRAMEBUFFER, 0);
  qgl.qglBindRenderbuffer(GL_RENDERBUFFER, 0);

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
  scaleFit = fit;
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

  // q2repro src/refresh/main.c:1487-1510 (R_GetGLConfig, called from this
  // exact per-platform video-init call site in every one of q2repro's own
  // backends -- src/unix/video/sdl.c:62, wayland.c:784, x11.c:299,
  // src/windows/{egl,wgl}.c). Only gl_depthbits has a matching hardcoded
  // constant in this port's context creation (sdl.ts's SDL_GL_DEPTH_SIZE
  // attribute, previously a fixed "24") to wire in below. The other five
  // have no equivalent SDL_GL_SetAttribute call anywhere in this port at
  // all (no SDL_GL_{RED,GREEN,BLUE,STENCIL}_SIZE, no
  // SDL_GL_MULTISAMPLE{BUFFERS,SAMPLES}, no SDL_GL_CONTEXT_FLAGS, no
  // SDL_GL_CONTEXT_PROFILE_MASK/{MAJOR,MINOR}_VERSION -- confirmed by
  // grepping sdl.ts) -- adding those would mean implementing new
  // context-configurability features, not gating existing ones, so they are
  // registered only (console command stops failing) rather than wired in.
  // gl_profile's C default macro DEFGLPROFILE is build-configured
  // (meson.build:727-731: "gl3.2" for a GL3 core build, "es1" for GLES, ""
  // otherwise); q2repro's own checked-in build/config.h:20 has it as "".
  ri.Cvar_Get("gl_colorbits", "0", CVAR_REFRESH);
  const depthBitsCvar = ri.Cvar_Get("gl_depthbits", "0", CVAR_REFRESH);
  ri.Cvar_Get("gl_stencilbits", "8", CVAR_REFRESH);
  ri.Cvar_Get("gl_multisamples", "0", CVAR_REFRESH);
  ri.Cvar_Get("gl_debug", "0", CVAR_REFRESH);
  ri.Cvar_Get("gl_profile", "", CVAR_REFRESH);

  if (!SDLGL_CreateWindow(info.width, info.height, fullscreen, depthBitsCvar ? depthBitsCvar.value : 0)) {
    return { rserr: RserrT.rserr_unknown, width: render.width, height: render.height };
  }

  if (!SDLGL_CreateContext()) {
    return { rserr: RserrT.rserr_unknown, width: render.width, height: render.height };
  }

  SDLGL_SetSwapInterval(1);

  // QoL addition (Mike, 2026-09-01): SDL_WINDOW_FULLSCREEN_DESKTOP (see
  // sdl.ts's SDLGL_CreateWindow) resizes the real window to the desktop's
  // native resolution regardless of info.width/info.height above -- query
  // it and use THAT as the output surface size in fullscreen, so a small
  // mode (e.g. 1280x720) on a larger real display (e.g. 3840x2160) still
  // activates the scale/blit path below instead of leaving the rest of the
  // real, larger surface never cleared/painted (the corner-anchored
  // "postage stamp" bug -- see this unit's report). Windowed mode keeps
  // using info's own size -- it IS the real window size there.
  //
  // Bug fix (Mike, 2026-09-02): SDLGL_GetDesktopSize (not the plain
  // SDLGL_GetWindowSize this used to call) -- reading the window's own
  // reported size here raced the window manager's asynchronous fullscreen
  // resize on a real WM/compositor: SDL_CreateWindow returns before the WM
  // has actually resized the window, so the "actual" size read back
  // immediately after was still the small requested mode size far more
  // often than not, VID_CalcOutputSize below then had nothing to detect
  // (render size == that same small size), and GLScale_Setup's blit/FBO
  // path never activated at all -- the untouched default framebuffer drew
  // the frame 1:1 into a viewport sized to the small mode, in the corner of
  // the real (already fullscreen-sized) window, with the remainder of the
  // window never cleared: exactly the reported black-fill postage-stamp
  // symptom. This port's own Xvfb test runs never caught it because a bare
  // Xvfb has no window manager at all, so the resize happens synchronously
  // and the race window doesn't exist there. SDLGL_GetDesktopSize instead
  // reads the display's own native mode, which has no dependency on the
  // window's state or any WM round trip -- see its doc comment in sdl.ts.
  let displaySize = { width: info.width, height: info.height };
  if (fullscreen) {
    const actual = SDLGL_GetDesktopSize();
    displaySize = VID_CalcOutputSize(info.width, info.height, actual.width, actual.height, true);
  }

  scaleNeeded = render.width !== displaySize.width || render.height !== displaySize.height;
  scaleNeededRenderWidth = render.width;
  scaleNeededRenderHeight = render.height;
  scaleNeededDisplayWidth = displaySize.width;
  scaleNeededDisplayHeight = displaySize.height;
  scaleNeededFit = vidMod().VID_GetScaleFit();
  if (scaleNeeded) {
    GLScale_Setup(render.width, render.height, displaySize.width, displaySize.height, scaleNeededFit); // false leaves scaleActive false: renders unscaled, see that function's header comment
  }

  return { rserr: RserrT.rserr_ok, width: render.width, height: render.height };
}

// See scaleNeeded's own doc comment above: R_Init (gl_rmain.ts) calls this
// once, right after its second, authoritative SetQGL(loadQGLFromSystem(...))
// -- the same point GL_InitShaderPath gets its own second, reliable
// attempt -- so a cold boot straight into `vid_ref gl` with fullscreen/
// scale/fit active gets a real chance at the FBO functions actually being
// resolved, instead of being stuck with whatever the pre-context QGL
// resolution inside GLimp_SetMode above managed to find (frequently
// nothing, on this port's own tested hardware). A no-op when no scaling
// was ever requested (scaleNeeded false) or it already succeeded
// (scaleActive true) -- never double-allocates a working FBO.
export function GLimp_RetryScaleSetup(): void {
  if (!scaleNeeded || scaleActive) return;
  GLScale_Setup(scaleNeededRenderWidth, scaleNeededRenderHeight, scaleNeededDisplayWidth, scaleNeededDisplayHeight, scaleNeededFit);
}

// Bug fix (Mike, 2026-09-02, found while verifying the fit/scale fixes
// above with real screenshots): GL_ScreenShot_f (gl_rmisc.ts) calls
// qglReadPixels(0, 0, vid.width, vid.height, ...) -- vid.width/height are
// the RENDER size (see this file's own header comment), so the intent has
// always been "capture the clean internal render, not the letterboxed
// window" -- but client/cl_main.ts's own per-frame order runs
// Cbuf_Execute() (which is what actually invokes "screenshot") BEFORE that
// frame's SCR_UpdateScreen()/R_BeginFrame() call, meaning the console
// command executes and reads pixels using whatever framebuffer was left
// bound at the END of the PREVIOUS frame -- framebuffer 0 (the real
// window), since GLimp_EndFrame always unbinds back to it after its own
// blit. With scaleActive false (every case before the fixes above --
// vid_scale's FBO never actually activated) framebuffer 0 WAS the render
// target 1:1, so this was never observable; once scaleActive is really
// true, framebuffer 0 holds the previous frame's full letterboxed
// 1920x1080-ish window content, and reading a vid.width x vid.height crop
// of THAT is a blurry, magenta-letterbox-tainted mess -- confirmed with a
// real screenshot capture (Video menu render came back with a pink stripe
// down the left edge). This getter lets GL_ScreenShot_f explicitly bind
// the actual render-resolution FBO for the read instead, regardless of
// what framebuffer command-buffer-time execution order happened to leave
// bound. Returns null (nothing to do differently) when scaling isn't
// active -- framebuffer 0 already IS the clean render target in that case.
export function GLimp_GetScaleReadFramebuffer(): number | null {
  return scaleActive ? scaleFbo : null;
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
    const rect = VID_CalcBlitRect(scaleRenderWidth, scaleRenderHeight, scaleDisplayWidth, scaleDisplayHeight, scaleFit);

    qgl.qglBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    qgl.qglViewport(0, 0, scaleDisplayWidth, scaleDisplayHeight);
    // The letterbox bars must be black. The clear color at this point is
    // whatever the renderer last set, and ref_gl's R_Clear sets the 1997
    // magenta (1, 0, 0.5) debug color every frame, so without this the bars
    // came out magenta on the owner's 4:3-in-16:9 setup.
    qgl.qglClearColor(0, 0, 0, 1);
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
    RetryScaleSetup: GLimp_RetryScaleSetup,
    GetScaleReadFramebuffer: GLimp_GetScaleReadFramebuffer,
  };
}
