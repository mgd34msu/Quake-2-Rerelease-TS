/*
The one native windowing/input/audio backend for this port, bound to the
system SDL2 shared library through bun:ffi.

PORTING.md maps linux/ win32/ solaris/ irix/ to a single src/platform
implementation of the sys/net/vid/snd interfaces. This file is the shared
device layer those interfaces sit on: swimp.ts (SWimp_*, the C rw_x11.c /
rw_ddraw.c surface), sys.ts (Sys_SendKeyEvents, the C sys_linux.c /
sys_win.c event pump), snd.ts (SNDDMA_*, the C snd_linux.c / snd_win.c DMA
buffer) and vid.ts (VID_*, the C vid_so.c / vid_dll.c refresh loader) all
call in here rather than each opening the library themselves.

Nothing is dlopen()ed at module load. `SDL_SetBackendEnabled(true)` is what
arms the backend (main.ts calls it only on the client path), and even then
the library is opened on first use inside `lib()`. A dedicated server and
the test suite never touch libSDL2 unless they ask for it.

The C backends bind X11/DirectDraw/DirectSound function-by-function; there
is no equivalent of that per-symbol #ifdef ladder here, so the symbol table
below is the whole native surface this port uses.

Struct offsets below were read off /usr/include/SDL2 (SDL 2.32) with an
offsetof program; they are ABI-stable across SDL2's lifetime because SDL2
freezes its public struct layouts.
*/

import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";
import { VID_CalcBlitRect } from "./vid_scale";
import {
  SDL_GamepadButtonEventToKey,
  SDL_GamepadTriggerAxisEventToKey,
  GamepadAxisNormalize,
  SDL_CONTROLLER_AXIS_LEFTX,
  SDL_CONTROLLER_AXIS_LEFTY,
  SDL_CONTROLLER_AXIS_RIGHTX,
  SDL_CONTROLLER_AXIS_RIGHTY,
  SDL_CONTROLLER_AXIS_TRIGGERLEFT,
  SDL_CONTROLLER_AXIS_TRIGGERRIGHT,
} from "./gamepad_map";
import {
  DeviceOrdinals,
  FormatDeviceSpec,
  MAX_LOCAL_PLAYERS,
  PlayerDevicePrefs,
  PlayerTuning,
  RegisterPlayerCvars,
  ResolvePadAssignments,
  SeatsDrivable,
  type PadDeviceT,
} from "./gamepad_assign";
import { Cvar_Get, Cvar_VariableValue } from "../qcommon/cvar";
import { Cmd_AddCommand } from "../qcommon/cmd";
import { Com_DPrintf, Com_Printf } from "../qcommon/common";
import type { CvarT, UsercmdT } from "../shared/q_shared";
import { CVAR_ARCHIVE, PITCH, YAW } from "../shared/q_shared";
import { cl, cls, clCvars, in_strafe, KeydestT } from "../client/client";
import { CL_Wheel_Input, CL_Wheel_Update } from "../client/cl_wheel";
import {
  K_BACKSPACE,
  K_DEL,
  K_DOWNARROW,
  K_END,
  K_ENTER,
  K_ESCAPE,
  K_F1,
  K_F2,
  K_F3,
  K_F4,
  K_F5,
  K_F6,
  K_F7,
  K_F8,
  K_F9,
  K_F10,
  K_F11,
  K_F12,
  K_HOME,
  K_INS,
  K_KP_DEL,
  K_KP_DOWNARROW,
  K_KP_END,
  K_KP_ENTER,
  K_KP_HOME,
  K_KP_INS,
  K_KP_LEFTARROW,
  K_KP_MINUS,
  K_KP_PGDN,
  K_KP_PGUP,
  K_KP_PLUS,
  K_KP_RIGHTARROW,
  K_KP_SLASH,
  K_KP_UPARROW,
  K_KP_5,
  K_LEFTARROW,
  K_MOUSE1,
  K_MOUSE2,
  K_MOUSE3,
  K_MWHEELDOWN,
  K_MWHEELUP,
  K_PAUSE,
  K_PGDN,
  K_PGUP,
  K_RIGHTARROW,
  K_SHIFT,
  K_ALT,
  K_CTRL,
  K_TAB,
  K_UPARROW,
} from "../client/keys";
import type * as KeysImplModule from "../client/keys_impl";
import type * as ClInputModule from "../client/cl_input";
import type * as CommonModule from "../qcommon/common";

// keys_impl.ts (Key_Event) and cl_input.ts (IN_CenterView) both sit above
// this file in the module graph and reach back down into src/platform, so a
// static import here closes a value cycle. PORTING.md's import-cycle rule
// applies: this file is the less fundamental side of that edge, so both are
// resolved lazily from inside function bodies. `import type` above is
// erased at runtime and adds no edge. Same for common.ts (Com_Quit), which
// files.ts already resolves this way.
function keysMod(): typeof KeysImplModule {
  return require("../client/keys_impl");
}
function clInputMod(): typeof ClInputModule {
  return require("../client/cl_input");
}
function commonMod(): typeof CommonModule {
  return require("../qcommon/common");
}

//=============================================================================
// SDL constants (SDL_video.h, SDL_render.h, SDL_events.h, SDL_audio.h,
// SDL_keycode.h, SDL_mouse.h, SDL_pixels.h)

const SDL_INIT_AUDIO = 0x00000010;
const SDL_INIT_VIDEO = 0x00000020;
const SDL_INIT_GAMECONTROLLER = 0x00002000;
const SDL_INIT_NOPARACHUTE = 0x00100000;

const SDL_WINDOWPOS_CENTERED = 0x2fff0000;
const SDL_WINDOW_SHOWN = 0x00000004;
const SDL_WINDOW_FULLSCREEN = 0x00000001;
// FULLSCREEN | 0x1000: borderless "desktop" fullscreen. The plain
// FULLSCREEN flag asks for a video-mode change, which Wayland cannot do --
// SDL's wayland backend then leaves the surface in a state Hyprland
// eventually flags "not responding". Desktop fullscreen composites at the
// native resolution; SDLVID_Present's explicit dstrect (see VID_CalcScaledRect)
// is what scales the frame to fill it when vid_scale renders smaller than
// the window.
const SDL_WINDOW_FULLSCREEN_DESKTOP = 0x00001001;
// window usable with an OpenGL context -- glimp.ts's SDLGL_CreateWindow variant
const SDL_WINDOW_OPENGL = 0x00000002;

// SDL_GLattr (SDL_video.h): enum order matters, these are index values, not bitflags.
const SDL_GL_DOUBLEBUFFER = 5;
const SDL_GL_DEPTH_SIZE = 6;

const SDL_RENDERER_SOFTWARE = 0x00000001;
const SDL_RENDERER_ACCELERATED = 0x00000002;

// packed ABGR8888: on a little-endian host the bytes in memory are R,G,B,A,
// which is exactly the order expandFrame writes.
const SDL_PIXELFORMAT_ABGR8888 = 376840196;
const SDL_TEXTUREACCESS_STREAMING = 1;

const SDL_QUIT = 0x100;
const SDL_WINDOWEVENT = 0x200;
const SDL_KEYDOWN = 0x300;
const SDL_KEYUP = 0x301;
const SDL_MOUSEMOTION = 0x400;
const SDL_MOUSEBUTTONDOWN = 0x401;
const SDL_MOUSEBUTTONUP = 0x402;
const SDL_MOUSEWHEEL = 0x403;

// SDL_events.h's "Game controller events" block (verified against
// /usr/include/SDL2/SDL_events.h on this host): SDL_CONTROLLERAXISMOTION
// starts the run at 0x650, the rest increment from there.
const SDL_CONTROLLERAXISMOTION = 0x650;
const SDL_CONTROLLERBUTTONDOWN = 0x651;
const SDL_CONTROLLERBUTTONUP = 0x652;
const SDL_CONTROLLERDEVICEADDED = 0x653;
const SDL_CONTROLLERDEVICEREMOVED = 0x654;

const SDL_WINDOWEVENT_FOCUS_GAINED = 12;
const SDL_WINDOWEVENT_FOCUS_LOST = 13;
const SDL_WINDOWEVENT_CLOSE = 14;

const SDL_BUTTON_LEFT = 1;
const SDL_BUTTON_MIDDLE = 2;
const SDL_BUTTON_RIGHT = 3;

const AUDIO_S16LSB = 0x8010;

// SDL_Event is a 56-byte union; every member starts with `Uint32 type`.
const SDL_EVENT_SIZE = 56;
// SDL_KeyboardEvent: type 0, state 12, repeat 13, keysym 16 (scancode 16,
// sym 20).
const KEYEVENT_STATE = 12;
const KEYEVENT_REPEAT = 13;
const KEYEVENT_SYM = 20;
// SDL_MouseButtonEvent: button 16, state 17.
const BUTTONEVENT_BUTTON = 16;
// SDL_MouseWheelEvent: x 16, y 20.
const WHEELEVENT_Y = 20;
// SDL_WindowEvent: event 12.
const WINDOWEVENT_EVENT = 12;
// SDL_ControllerAxisEvent: which(Sint32) 8, axis(Uint8) 12, value(Sint16) 16.
const CAXISEVENT_WHICH = 8;
const CAXISEVENT_AXIS = 12;
const CAXISEVENT_VALUE = 16;
// SDL_ControllerButtonEvent: which(Sint32) 8, button(Uint8) 12, state(Uint8) 13.
const CBUTTONEVENT_WHICH = 8;
const CBUTTONEVENT_BUTTON = 12;
const CBUTTONEVENT_STATE = 13;
// SDL_ControllerDeviceEvent: which(Sint32) 8 -- device index for ADDED,
// instance id for REMOVED/REMAPPED.
const CDEVICEEVENT_WHICH = 8;

// SDL_AudioSpec: freq 0, format 4, channels 6, silence 7, samples 8,
// padding 10, size 12, callback 16, userdata 24 (32 bytes total).
const AUDIOSPEC_SIZE = 32;
const AUDIOSPEC_FREQ = 0;
const AUDIOSPEC_FORMAT = 4;
const AUDIOSPEC_CHANNELS = 6;
const AUDIOSPEC_SAMPLES = 8;

//=============================================================================
// library binding

const symbols = {
  SDL_Init: { args: ["u32"], returns: "i32" },
  SDL_setenv: { args: ["cstring", "cstring", "i32"], returns: "i32" },
  SDL_InitSubSystem: { args: ["u32"], returns: "i32" },
  SDL_QuitSubSystem: { args: ["u32"], returns: "void" },
  SDL_Quit: { args: [], returns: "void" },
  SDL_GetError: { args: [], returns: "cstring" },

  SDL_CreateWindow: { args: ["cstring", "i32", "i32", "i32", "i32", "u32"], returns: "ptr" },
  SDL_DestroyWindow: { args: ["ptr"], returns: "void" },
  SDL_SetWindowTitle: { args: ["ptr", "cstring"], returns: "void" },
  SDL_GetWindowSize: { args: ["ptr", "ptr", "ptr"], returns: "void" },

  SDL_CreateRenderer: { args: ["ptr", "i32", "u32"], returns: "ptr" },
  SDL_DestroyRenderer: { args: ["ptr"], returns: "void" },
  SDL_RenderClear: { args: ["ptr"], returns: "i32" },
  SDL_RenderCopy: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  SDL_RenderPresent: { args: ["ptr"], returns: "void" },

  SDL_CreateTexture: { args: ["ptr", "u32", "i32", "i32", "i32"], returns: "ptr" },
  SDL_DestroyTexture: { args: ["ptr"], returns: "void" },
  SDL_UpdateTexture: { args: ["ptr", "ptr", "ptr", "i32"], returns: "i32" },

  SDL_GL_SetAttribute: { args: ["i32", "i32"], returns: "i32" },
  SDL_GL_CreateContext: { args: ["ptr"], returns: "ptr" },
  SDL_GL_DeleteContext: { args: ["ptr"], returns: "void" },
  SDL_GL_SwapWindow: { args: ["ptr"], returns: "void" },
  SDL_GL_GetProcAddress: { args: ["cstring"], returns: "ptr" },
  SDL_GL_SetSwapInterval: { args: ["i32"], returns: "i32" },

  SDL_PollEvent: { args: ["ptr"], returns: "i32" },
  SDL_PumpEvents: { args: [], returns: "void" },

  SDL_GetRelativeMouseState: { args: ["ptr", "ptr"], returns: "u32" },
  SDL_SetRelativeMouseMode: { args: ["i32"], returns: "i32" },
  SDL_ShowCursor: { args: ["i32"], returns: "i32" },

  // SDL_GameController hotplug (SDL_gamecontroller.h) -- opens/closes
  // exactly one controller at a time (this port's own "hold one open
  // controller" scope, matching platform/haptics.ts's own precedent) in
  // response to SDL_CONTROLLERDEVICEADDED/REMOVED events read off the same
  // SDL_PollEvent loop that already pumps keyboard/mouse below. See
  // SDL_GetActiveGameController's doc comment for how platform/haptics.ts
  // reuses this handle instead of opening a second one.
  SDL_IsGameController: { args: ["i32"], returns: "i32" },
  SDL_GameControllerOpen: { args: ["i32"], returns: "ptr" },
  SDL_GameControllerClose: { args: ["ptr"], returns: "void" },
  SDL_GameControllerGetJoystick: { args: ["ptr"], returns: "ptr" },
  SDL_JoystickInstanceID: { args: ["ptr"], returns: "i32" },

  // Device IDENTITY, for the per-player controller assignment model
  // (gamepad_assign.ts). SDL's own GUID accessors
  // (SDL_JoystickGetGUID/SDL_JoystickGetGUIDString) pass and return the
  // 16-byte SDL_JoystickGUID struct BY VALUE, which bun:ffi cannot express
  // -- it handles primitives and pointers only. SDL_GameControllerMapping
  // is the way around that: its returned mapping string BEGINS with the
  // device's GUID as hex text ("03000000...,Xbox Controller,platform:Linux,
  // a:b0,..."), which is precisely the string we want, and it comes back as
  // an ordinary char* the FFI can carry. The buffer is malloc'd by SDL and
  // is ours to release, hence SDL_free below.
  //
  // The vendor/product/version triple is the fallback for a pad with no
  // mapping string at all: those are the same fields SDL folds INTO the
  // GUID, so a synthesized "vpv:vvvv:pppp:rrrr" identity is stable across
  // replugs for exactly the same reason the real GUID is.
  SDL_GameControllerName: { args: ["ptr"], returns: "cstring" },
  SDL_GameControllerMapping: { args: ["ptr"], returns: "ptr" },
  SDL_GameControllerGetVendor: { args: ["ptr"], returns: "u16" },
  SDL_GameControllerGetProduct: { args: ["ptr"], returns: "u16" },
  SDL_GameControllerGetProductVersion: { args: ["ptr"], returns: "u16" },
  SDL_free: { args: ["ptr"], returns: "void" },

  SDL_OpenAudioDevice: { args: ["cstring", "i32", "ptr", "ptr", "i32"], returns: "u32" },
  SDL_CloseAudioDevice: { args: ["u32"], returns: "void" },
  SDL_PauseAudioDevice: { args: ["u32", "i32"], returns: "void" },
  SDL_QueueAudio: { args: ["u32", "ptr", "u32"], returns: "i32" },
  SDL_GetQueuedAudioSize: { args: ["u32"], returns: "u32" },
  SDL_ClearQueuedAudio: { args: ["u32"], returns: "void" },
} as const;

type SdlLib = ReturnType<typeof dlopen<typeof symbols>>;

function libraryName(): string {
  switch (process.platform) {
    case "win32":
      return "SDL2.dll";
    case "darwin":
      return "libSDL2.dylib";
    default:
      return "libSDL2-2.0.so.0";
  }
}

let enabled = false;
let library: SdlLib | null = null;
let libraryFailed = false;

export function SDL_SetBackendEnabled(value: boolean): void {
  enabled = value;
}

export function SDL_BackendEnabled(): boolean {
  return enabled;
}

// The only dlopen in the port. Returns null (once, then remembers) when the
// backend is disabled or the system library is missing, so every caller can
// fall back to the headless path instead of dying.
function lib(): SdlLib | null {
  if (!enabled || libraryFailed) return null;
  if (library) return library;
  try {
    library = dlopen(libraryName(), symbols);
    // JS-side env writes (Bun.env/process.env) do not reliably reach the C
    // runtime's getenv(), which is how SDL selects its drivers. Propagate
    // the two driver-selection variables through SDL's own setenv so a test
    // harness setting SDL_VIDEODRIVER=dummy is honored -- without this, test
    // runs open real windows on the host desktop.
    for (const name of ["SDL_VIDEODRIVER", "SDL_AUDIODRIVER"]) {
      const v = process.env[name];
      if (v !== undefined) {
        library.symbols.SDL_setenv(Buffer.from(`${name}\0`), Buffer.from(`${v}\0`), 1);
      }
    }
  } catch (err) {
    libraryFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    Com_Printf("SDL: could not load %s: %s\n", libraryName(), msg);
    return null;
  }
  return library;
}

function sdlError(l: SdlLib): string {
  return l.symbols.SDL_GetError() ?? "";
}

let subsystems = 0;

function initSubsystem(l: SdlLib, flag: number): boolean {
  if (subsystems === 0) {
    // SDL_INIT_NOPARACHUTE: leave signal handling to the host process, the
    // same choice the C backends make when they hand SDL a bare init.
    if (l.symbols.SDL_Init(SDL_INIT_NOPARACHUTE) < 0) {
      Com_Printf("SDL: SDL_Init failed: %s\n", sdlError(l));
      return false;
    }
  }
  if ((subsystems & flag) === 0) {
    if (l.symbols.SDL_InitSubSystem(flag) < 0) {
      Com_Printf("SDL: SDL_InitSubSystem(0x%x) failed: %s\n", flag, sdlError(l));
      return false;
    }
    subsystems |= flag;
  }
  return true;
}

function quitSubsystem(l: SdlLib, flag: number): void {
  if ((subsystems & flag) === 0) return;
  l.symbols.SDL_QuitSubSystem(flag);
  subsystems &= ~flag;
  if (subsystems === 0) l.symbols.SDL_Quit();
}

// C strings for the FFI: bun's "cstring" argument accepts a NUL-terminated
// byte array.
function cstr(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

//=============================================================================
// VIDEO -- the rw_x11.c/rw_ddraw.c surface: a window, a renderer, and one
// streaming texture the 8-bit software framebuffer is expanded into.

let window: Pointer | bigint | null = null;
let renderer: Pointer | bigint | null = null;
let texture: Pointer | bigint | null = null;
let texWidth = 0;
let texHeight = 0;
// The window's client-area size (v1.0.0 RC vid_scale support): equal to
// texWidth/texHeight unless the caller asked for a smaller render buffer
// than the window/display it presents into (SDLVID_Present then upscales,
// aspect-preserving letterbox, via VID_CalcScaledRect below).
let dispWidth = 0;
let dispHeight = 0;
// QoL addition (Mike, 2026-09-01, "scale to fullscreen" toggle, cvar
// vid_scale_fit): whether SDLVID_Present stretches the render texture to
// fill dispWidth/dispHeight (true, byte-for-byte the pre-existing behavior)
// or centers it at its own size, unscaled (false) -- see VID_CalcBlitRect.
let dispFit = true;
let rgba = new Uint8Array(0);
let framesPresented = 0;
const dstRectBuf = new Int32Array(4); // reused SDL_Rect (x,y,w,h) for SDL_RenderCopy's dstrect
// SDL_GetWindowSize int-out-param buffers, same idiom as relX/relY below.
const windowSizeW = new Int32Array(1);
const windowSizeH = new Int32Array(1);

// QoL addition (Mike, 2026-09-01): SDL_WINDOW_FULLSCREEN_DESKTOP (below)
// silently resizes the created window to the desktop's native resolution
// regardless of the width/height SDL_CreateWindow was asked for -- this
// reads back the REAL post-creation size so callers (SDLVID_Init below,
// glimp.ts's GLimp_SetMode) can size their blit/clear geometry to the
// actual surface instead of the requested mode. Returns {0,0} if there is
// no window or the library isn't loaded (headless/dummy-driver tests).
function sdlWindowSize(): { width: number; height: number } {
  const l = lib();
  if (!l || !window) return { width: 0, height: 0 };
  l.symbols.SDL_GetWindowSize(window, windowSizeW, windowSizeH);
  return { width: windowSizeW[0], height: windowSizeH[0] };
}

export function SDLGL_GetWindowSize(): { width: number; height: number } {
  return sdlWindowSize();
}

export function SDLVID_Active(): boolean {
  return texture !== null;
}

// test seam: how many frames reached the window since the mode was set
export function SDLVID_FramesPresented(): number {
  return framesPresented;
}

/*
Expands one 8-bit paletted frame into RGBA8888 bytes.

`palette` is the 256-entry padded xRGB table SWimp_SetPalette keeps
(sw_state.currentpalette): 4 bytes per index, R,G,B,unused. Alpha is forced
opaque. `rowbytes` may exceed `width` -- vid.rowbytes is the C surface
stride, not the visible width.
*/
export function SDLVID_ExpandFrame(buffer: Uint8Array, rowbytes: number, width: number, height: number, palette: Uint8Array, out: Uint8Array): void {
  for (let y = 0; y < height; y++) {
    let src = y * rowbytes;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = buffer[src++] * 4;
      out[dst++] = palette[idx + 0];
      out[dst++] = palette[idx + 1];
      out[dst++] = palette[idx + 2];
      out[dst++] = 255;
    }
  }
}

/*
`renderWidth`/`renderHeight` size the streaming texture the software
framebuffer is expanded into every frame; `displayWidth`/`displayHeight`
(defaulting to the render size, i.e. no scaling -- every pre-existing call
site that only ever passed one size still gets exactly that size on both)
size the actual OS window. When they differ (src/platform/swimp.ts's
vid_scale support), SDLVID_Present blits the smaller texture into an
aspect-preserving letterboxed rect sized to fit the window instead of
1:1 pixel-copying it.
*/
export function SDLVID_Init(renderWidth: number, renderHeight: number, fullscreen: boolean, displayWidth: number = renderWidth, displayHeight: number = renderHeight, fit: boolean = true): boolean {
  const l = lib();
  if (!l) return false;
  if (!initSubsystem(l, SDL_INIT_VIDEO)) return false;

  SDLVID_Shutdown();

  const flags = SDL_WINDOW_SHOWN | (fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
  window = l.symbols.SDL_CreateWindow(cstr("Quake 2"), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, displayWidth, displayHeight, flags);
  if (!window) {
    Com_Printf("SDL: SDL_CreateWindow failed: %s\n", sdlError(l));
    return false;
  }

  renderer = l.symbols.SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
  if (!renderer) renderer = l.symbols.SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer) {
    Com_Printf("SDL: SDL_CreateRenderer failed: %s\n", sdlError(l));
    SDLVID_Shutdown();
    return false;
  }

  texture = l.symbols.SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ABGR8888, SDL_TEXTUREACCESS_STREAMING, renderWidth, renderHeight);
  if (!texture) {
    Com_Printf("SDL: SDL_CreateTexture failed: %s\n", sdlError(l));
    SDLVID_Shutdown();
    return false;
  }

  texWidth = renderWidth;
  texHeight = renderHeight;

  // QoL addition (Mike, 2026-09-01): SDL_WINDOW_FULLSCREEN_DESKTOP resizes
  // the real window to the desktop's native resolution regardless of the
  // displayWidth/displayHeight just passed to SDL_CreateWindow above -- see
  // sdlWindowSize's doc comment. Query the real size in fullscreen so the
  // present-time blit/clear geometry covers the whole actual surface
  // instead of leaving the rest of a larger real window never painted
  // (falls back to the requested size if the query comes back 0x0, e.g. the
  // "dummy" SDL video driver under the test harness). Windowed mode keeps
  // using the requested size directly -- it IS the real size there.
  if (fullscreen) {
    const actual = sdlWindowSize();
    dispWidth = actual.width > 0 ? actual.width : displayWidth;
    dispHeight = actual.height > 0 ? actual.height : displayHeight;
  } else {
    dispWidth = displayWidth;
    dispHeight = displayHeight;
  }
  dispFit = fit;
  rgba = new Uint8Array(renderWidth * renderHeight * 4);
  framesPresented = 0;
  return true;
}

export function SDLVID_Shutdown(): void {
  const l = lib();
  if (!l) return;
  if (texture) {
    l.symbols.SDL_DestroyTexture(texture);
    texture = null;
  }
  if (renderer) {
    l.symbols.SDL_DestroyRenderer(renderer);
    renderer = null;
  }
  if (window) {
    l.symbols.SDL_DestroyWindow(window);
    window = null;
  }
  texWidth = 0;
  texHeight = 0;
  dispWidth = 0;
  dispHeight = 0;
  dispFit = true;
  rgba = new Uint8Array(0);
  IN_DeactivateMouse();
  // deliberately NOT quitSubsystem(SDL_INIT_VIDEO): the subsystem stays
  // armed for the life of the process. Tearing it down here cleared the
  // `subsystems` VIDEO bit on every runtime mode change (SDLVID_Init calls
  // this after re-arming), which permanently disabled SDL_PumpInput -- dead
  // keyboard/mouse and a compositor "not responding" verdict. SDL_ShutdownAll
  // owns the final teardown.
}

export function SDLVID_Present(buffer: Uint8Array, rowbytes: number, width: number, height: number, palette: Uint8Array): void {
  const l = lib();
  if (!l || !texture || !renderer) return;
  if (width !== texWidth || height !== texHeight) {
    Com_DPrintf("SDLVID_Present: %ix%i frame vs %ix%i texture -- dropped\n", width, height, texWidth, texHeight);
    return;
  }

  SDLVID_ExpandFrame(buffer, rowbytes, width, height, palette, rgba);

  l.symbols.SDL_UpdateTexture(texture, null, rgba, width * 4);
  l.symbols.SDL_RenderClear(renderer); // paints the letterbox bars when dispW/H != texW/H

  const rect = VID_CalcBlitRect(texWidth, texHeight, dispWidth, dispHeight, dispFit);
  dstRectBuf[0] = rect.x;
  dstRectBuf[1] = rect.y;
  dstRectBuf[2] = rect.w;
  dstRectBuf[3] = rect.h;
  l.symbols.SDL_RenderCopy(renderer, texture, null, dstRectBuf);

  l.symbols.SDL_RenderPresent(renderer);
  framesPresented++;
}

export function SDLVID_SetWindowTitle(title: string): void {
  const l = lib();
  if (!l || !window) return;
  l.symbols.SDL_SetWindowTitle(window, cstr(title));
}

//=============================================================================
// GL -- win32/glw_imp.c's GLimp_Init/SetMode/EndFrame surface (see
// src/platform/glimp.ts, this section's only caller): an SDL_GLContext bound
// to the same module-level `window` the software path's SDLVID_Init uses.
// This port only ever runs one refresh at a time, never software and GL
// together, so sharing that one handle between the two paths is safe.

let glContext: Pointer | bigint | null = null;

export function SDLGL_CreateWindow(width: number, height: number, fullscreen: boolean, depthBits: number = 24): boolean {
  const l = lib();
  if (!l) return false;
  if (!initSubsystem(l, SDL_INIT_VIDEO)) return false;

  if (glContext) {
    l.symbols.SDL_GL_DeleteContext(glContext);
    glContext = null;
  }
  SDLVID_Shutdown(); // destroy any previous window (software or GL) first, like GLimp_SetMode's GLimp_Shutdown() call in the C original

  l.symbols.SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  // q2repro src/refresh/main.c:1490/1491 (R_GetGLConfig) + src/unix/video/sdl.c's
  // set_gl_attributes(): `SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, cfg.depthbits)`,
  // where cfg.depthbits comes from the gl_depthbits cvar (0 default falls back
  // to 24, matching that function's own colorbits>16?24:16 cascade collapsing
  // to 24 here since this port never wires a configurable colorbits). Caller
  // (glimp.ts's GLimp_SetMode) reads gl_depthbits and passes it in; this
  // parameter's own default (24) is only hit when called without one.
  // Previously this was an unconditional hardcoded "24" with no cvar behind
  // it at all -- gl_colorbits/gl_stencilbits/gl_multisamples/gl_debug/
  // gl_profile remain registered-only (no SDL_GL_SetAttribute call for any
  // of those exists in this port at all, so there is no hardcoded constant
  // to wire them into -- see glimp.ts's GLimp_SetMode comment).
  l.symbols.SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, depthBits || 24);

  const flags = SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN | (fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
  window = l.symbols.SDL_CreateWindow(cstr("Quake 2"), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, width, height, flags);
  if (!window) {
    Com_Printf("SDL: SDL_CreateWindow failed: %s\n", sdlError(l));
    return false;
  }
  return true;
}

export function SDLGL_CreateContext(): boolean {
  const l = lib();
  if (!l || !window) return false;

  glContext = l.symbols.SDL_GL_CreateContext(window);
  if (!glContext) {
    Com_Printf("SDL: SDL_GL_CreateContext failed: %s\n", sdlError(l));
    return false;
  }
  return true;
}

export function SDLGL_SwapWindow(): void {
  const l = lib();
  if (!l || !window) return;
  l.symbols.SDL_GL_SwapWindow(window);
}

export function SDLGL_SetSwapInterval(interval: number): void {
  const l = lib();
  if (!l) return;
  l.symbols.SDL_GL_SetSwapInterval(interval);
}

// linux/qgl_linux.c resolves *_EXT/*_SGIS entries through glXGetProcAddress
// once a context is current; SDL_GL_GetProcAddress is this port's portable
// equivalent (see qgl.ts's loadQGLFromSystem, the only caller). Returns the
// raw FFIType.ptr result rather than narrowing bigint away the way
// qgl.ts's qglGetString does for a cstring result -- linkSymbols' `ptr`
// field accepts `Pointer | bigint` directly, so no narrowing is needed here.
export function SDLGL_GetProcAddress(name: string): Pointer | bigint | null {
  const l = lib();
  if (!l) return null;
  return l.symbols.SDL_GL_GetProcAddress(cstr(name));
}

export function SDLGL_Shutdown(): void {
  const l = lib();
  if (l && glContext) {
    l.symbols.SDL_GL_DeleteContext(glContext);
    glContext = null;
  }
  SDLVID_Shutdown();
}

//=============================================================================
// INPUT -- rw_x11.c's HandleEvents (keyboard/mouse to Key_Event) plus
// in_win.c's IN_MouseMove/IN_Frame/IN_ActivateMouse/IN_JoyMove. The
// SDL_GameController gamepad layer (button/trigger -> Key_Event, hotplug,
// left/right stick -> movement/look) lives in this same section, further
// down -- see its own "GAMEPAD" sub-header below and gamepad_map.ts for the
// pure event-mapping half.

// SDLK_* -> the K_* numbers keys.c expects. Printable ASCII (space through
// '~') passes through unmapped, exactly as rw_x11.c's XLateKey does after
// its switch: the console reads those key numbers as characters.
const keymap = new Map<number, number>([
  [9, K_TAB],
  [13, K_ENTER],
  [27, K_ESCAPE],
  [8, K_BACKSPACE], // SDLK_BACKSPACE
  [127, K_DEL], // SDLK_DELETE
  [1073741906, K_UPARROW],
  [1073741905, K_DOWNARROW],
  [1073741904, K_LEFTARROW],
  [1073741903, K_RIGHTARROW],
  [1073742050, K_ALT], // SDLK_LALT
  [1073742054, K_ALT], // SDLK_RALT
  [1073742048, K_CTRL], // SDLK_LCTRL
  [1073742052, K_CTRL], // SDLK_RCTRL
  [1073742049, K_SHIFT], // SDLK_LSHIFT
  [1073742053, K_SHIFT], // SDLK_RSHIFT
  [1073741882, K_F1],
  [1073741883, K_F2],
  [1073741884, K_F3],
  [1073741885, K_F4],
  [1073741886, K_F5],
  [1073741887, K_F6],
  [1073741888, K_F7],
  [1073741889, K_F8],
  [1073741890, K_F9],
  [1073741891, K_F10],
  [1073741892, K_F11],
  [1073741893, K_F12],
  [1073741897, K_INS],
  [1073741902, K_PGDN],
  [1073741899, K_PGUP],
  [1073741898, K_HOME],
  [1073741901, K_END],
  [1073741896, K_PAUSE],
  [1073741919, K_KP_HOME], // SDLK_KP_7
  [1073741920, K_KP_UPARROW], // SDLK_KP_8
  [1073741921, K_KP_PGUP], // SDLK_KP_9
  [1073741916, K_KP_LEFTARROW], // SDLK_KP_4
  [1073741917, K_KP_5],
  [1073741918, K_KP_RIGHTARROW], // SDLK_KP_6
  [1073741913, K_KP_END], // SDLK_KP_1
  [1073741914, K_KP_DOWNARROW], // SDLK_KP_2
  [1073741915, K_KP_PGDN], // SDLK_KP_3
  [1073741922, K_KP_INS], // SDLK_KP_0
  [1073741923, K_KP_DEL], // SDLK_KP_PERIOD
  [1073741912, K_KP_ENTER],
  [1073741908, K_KP_SLASH], // SDLK_KP_DIVIDE
  [1073741910, K_KP_MINUS],
  [1073741911, K_KP_PLUS],
]);

export function SDL_KeyToQuake(sym: number): number {
  const mapped = keymap.get(sym);
  if (mapped !== undefined) return mapped;
  if (sym >= 32 && sym <= 126) return sym;
  return 0;
}

const eventBuf = new Uint8Array(SDL_EVENT_SIZE);
const eventView = new DataView(eventBuf.buffer);
const relX = new Int32Array(1);
const relY = new Int32Array(1);

let mouse_avail = false;
let mouse_active = false;
let mx = 0;
let my = 0;
let old_mouse_x = 0;
let old_mouse_y = 0;
let mlooking = false;
let windowActive = true;

let in_mouse: CvarT | null = null;
let m_filter: CvarT | null = null;
let sensitivity: CvarT | null = null;
let lookstrafe: CvarT | null = null;
let freelook: CvarT | null = null;
let lookspring: CvarT | null = null;
let m_pitch: CvarT | null = null;
let m_yaw: CvarT | null = null;
let m_forward: CvarT | null = null;
let m_side: CvarT | null = null;
// q2repro src/client/input.c:187,199 -- cvar-parity audit additions
let in_enable: CvarT | null = null;
let in_grab: CvarT | null = null;

//=============================================================================
// GAMEPAD -- SDL_GameController hotplug, button/trigger events -> Key_Event,
// and left/right stick axes fed into the same cmd/viewangles fields IN_Move
// already writes for the mouse. See gamepad_map.ts for the pure event
// mapping this section's runtime shell calls into (that file's own header
// comment has the full design writeup and citations).

/*
DEVICES AND PLAYERS.

Every controller SDL opens goes into ONE table, `gpDevices`, in plug order,
and every controller's raw state is latched there. Which player each device
drives is a separate question, answered by gamepad_assign.ts's
ResolvePadAssignments against the four in_playerN_device cvars and recomputed
whenever a device arrives or leaves (or the menu changes a preference).

This replaced an earlier "one primary + three secondary slots" arrangement in
which the roles were baked into where a pad was stored. They had to come
apart: the whole point of the Controllers screen is that a pad's ROLE is a
preference, so it cannot also be its storage location. What has NOT changed
is the behavior with every player left on "auto" -- the resolver hands
devices out in plug order, so player 1 gets the first pad, player 2 the
second, and so on, exactly as before.

The player-1 device keeps the old "primary controller" role in full: it is
the only pad whose buttons and triggers become Key_Event (so the bind system,
the menu and seat 0 are driven by one pad and cannot be fought over), and the
only pad IN_JoyMove reads. Every other open pad is latched only; nothing in
the single-screen client reads it, so a second pad plugged into a
non-splitscreen session still changes no observable behavior.

Routing is by SDL joystick INSTANCE ID, which is what an SDL event carries.
The GUID identifies a device ACROSS sessions (the cvar's job); the instance
id identifies it WITHIN one (the event pump's job). Both are needed and
neither substitutes for the other.
*/
const MAX_GAMEPAD_DEVICES = MAX_LOCAL_PLAYERS;

class GamepadDeviceT {
  handle: Pointer | bigint | null = null;
  instanceId = -1;
  /** SDL joystick GUID text -- stable across replug and reboot. */
  guid = "";
  /** Human-readable controller name, for the menu's device list. */
  name = "";
  leftX = 0;
  leftY = 0;
  rightX = 0;
  rightY = 0;
  triggerL = 0;
  triggerR = 0;
  /** SDL_CONTROLLER_BUTTON_* bitmask, bit N = button N held. */
  buttons = 0;

  clearState(): void {
    this.leftX = 0;
    this.leftY = 0;
    this.rightX = 0;
    this.rightY = 0;
    this.triggerL = 0;
    this.triggerR = 0;
    this.buttons = 0;
  }
}

/** Open controllers, in plug order. */
const gpDevices: GamepadDeviceT[] = [];

/** Index into gpDevices for each player (0 = player 1), or -1. Recomputed by
 *  gpResolve; never written anywhere else. */
let gpPlayerDevice: number[] = new Array(MAX_LOCAL_PLAYERS).fill(-1);

/** Bumped on every device arrival/departure. The Controllers menu polls it
 *  so a pad plugged in while the screen is open rebuilds the list, without
 *  the platform layer needing to know the menu exists. */
let gpDeviceGeneration = 0;

// Trigger axes on the PLAYER 1 pad are converted to a press/release
// Key_Event pair, not raw analog data -- these are the latched button states
// SDL_GamepadTriggerAxisEventToKey's `wasDown` hysteresis argument needs.
// Only player 1's pad needs them, because only player 1's pad produces key
// events; every other pad's triggers are latched as analog values instead.
let gpLeftTriggerDown = false;
let gpRightTriggerDown = false;

/*
Raw SDL_ControllerAxisEvent.value for the movement-stick axes is latched on
the device itself (GamepadDeviceT above) and consumed once per frame -- by
IN_JoyMove for player 1, by cl_seats.ts for players 2..4. Same "latch from
events, apply once per frame" shape mx/my use for the mouse above, minus the
accumulation: each new axis event simply replaces the previous value,
matching SDL's own "this is the current absolute position" semantics for a
game controller axis (unlike relative mouse motion, which really does need
summing between frames).
*/

/** Raw latched state of one pad. */
export interface GamepadSeatStateT {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  triggerL: number;
  triggerR: number;
  buttons: number;
}

/** One row of the Controllers menu's "detected controllers" list. */
export interface GamepadDeviceInfoT {
  /** SDL joystick GUID text. */
  guid: string;
  /** The value an in_playerN_device cvar needs to name THIS pad -- the bare
   *  GUID, or "<guid>#n" when an identical pad is also plugged in. */
  spec: string;
  name: string;
  instanceId: number;
  /** 0-based player this pad currently drives, or -1 when it is idle. */
  player: number;
}

function gpDeviceByInstance(which: number): GamepadDeviceT | null {
  for (const dev of gpDevices) if (dev.instanceId === which) return dev;
  // Degenerate case, preserved from before this table existed: if the
  // joystick handle could not be read for the one and only open pad, its
  // instance id is -1 and routing by `which` is impossible -- but its events
  // still have to reach it, which is what the old single-pad code did by
  // never looking at `which` at all.
  const only = gpDevices.length === 1 ? gpDevices[0] : null;
  return only && only.instanceId < 0 ? only : null;
}

/** The device driving a player (0 = player 1), or null. */
function gpDeviceForPlayer(player: number): GamepadDeviceT | null {
  const idx = gpPlayerDevice[player];
  if (idx === undefined || idx < 0) return null;
  return gpDevices[idx] ?? null;
}

function gpSnapshot(dev: GamepadDeviceT | null): GamepadSeatStateT | null {
  if (!dev || !dev.handle) return null;
  return {
    leftX: dev.leftX,
    leftY: dev.leftY,
    rightX: dev.rightX,
    rightY: dev.rightY,
    triggerL: dev.triggerL,
    triggerR: dev.triggerR,
    buttons: dev.buttons,
  };
}

/*
==================
gpResolve

Re-run the assignment rule over the current device table. Called on every
hotplug event and from SDL_GamepadRefreshAssignments (the menu's hook), so
the routing the event pump uses is never stale.

Changing which pad is player 1's invalidates the trigger hysteresis latches
above -- they describe a button state on a device that is no longer the one
producing key events -- so they are released. Without this a pad that was
holding its right trigger when it stopped being player 1's would leave
+attack stuck down on the bind system.
==================
*/
function gpResolve(): void {
  const before = gpDeviceForPlayer(0);
  const devices: PadDeviceT[] = gpDevices.map((d) => ({ instanceId: d.instanceId, guid: d.guid, name: d.name }));
  gpPlayerDevice = ResolvePadAssignments(devices, PlayerDevicePrefs()).players;
  const after = gpDeviceForPlayer(0);
  if (before !== after) {
    gpLeftTriggerDown = false;
    gpRightTriggerDown = false;
  }
}

/** Recompute routing after something outside this file changed an
 *  in_playerN_device cvar (the Controllers menu, or a console `set`). */
export function SDL_GamepadRefreshAssignments(): void {
  gpResolve();
}

/** Every open controller, in plug order, with the cvar value that names it
 *  and the player it currently drives. The Controllers menu's device list. */
export function SDL_GamepadDevices(): GamepadDeviceInfoT[] {
  const ordinals = DeviceOrdinals(gpDevices.map((d) => ({ instanceId: d.instanceId, guid: d.guid, name: d.name })));
  return gpDevices.map((dev, i) => ({
    guid: dev.guid,
    spec: FormatDeviceSpec(dev.guid, ordinals[i] ?? 0),
    name: dev.name,
    instanceId: dev.instanceId,
    player: gpPlayerDevice.indexOf(i),
  }));
}

/** Bumped whenever a controller arrives or leaves; the menu polls it to
 *  rebuild its rows while the screen is open. */
export function SDL_GamepadDeviceGeneration(): number {
  return gpDeviceGeneration;
}

/** Raw latched state of the pad driving splitscreen seat `slot + 1`, i.e.
 *  player `slot + 2`. Slot 0 is the first seat past seat 0. Null when no
 *  controller is assigned to that player. */
export function SDL_GamepadSeatState(slot: number): GamepadSeatStateT | null {
  return gpSnapshot(gpDeviceForPlayer(slot + 1));
}

/*
How many splitscreen seats past seat 0 can actually be driven right now.
Counted CONSECUTIVELY from seat 1 (gamepad_assign.ts's SeatsDrivable), not as
a raw "how many spare pads are open": seats are filled in order, so a pad
assigned to player 4 while player 2 has none buys no extra seat. With every
player on "auto" this is identical to the old `number of extra pads`, because
the resolver fills players in order.
*/
export function SDL_GamepadSeatCount(): number {
  return SeatsDrivable({ players: gpPlayerDevice, idle: [] }) - 1;
}

let in_joystick: CvarT | null = null;
let joy_deadzone: CvarT | null = null;
let joy_forwardsensitivity: CvarT | null = null;
let joy_sidesensitivity: CvarT | null = null;
let joy_yawsensitivity: CvarT | null = null;
let joy_pitchsensitivity: CvarT | null = null;

/*
Shared controller handle: platform/haptics.ts's own rumble sink calls this
FIRST, before falling back to its own independent open/close/rescan, so the
real client never runs two separate SDL_GameController lifecycles against
the same physical device (this task's brief: "reuse its controller handle
plumbing ... do NOT duplicate"). Returns null whenever no controller is
currently open here (headless, backend disarmed, or genuinely unplugged);
haptics.ts's own fallback covers that case, plus any future caller that
arms haptics without ever arming this backend.

It is PLAYER 1's pad specifically, not "any open pad": rumble is feedback for
the player holding the client's own view, and handing it to some other
player's controller would buzz the wrong person. A player 1 set to "kbm" (or
whose assigned pad is unplugged) therefore has no rumble device, which is the
honest answer rather than borrowing a seat's.
*/
export function SDL_GetActiveGameController(): Pointer | bigint | null {
  const dev = gpDeviceForPlayer(0);
  return dev ? dev.handle : null;
}

function gpCloseDevice(l: SdlLib, dev: GamepadDeviceT): void {
  if (dev.handle) l.symbols.SDL_GameControllerClose(dev.handle);
  dev.handle = null;
  dev.clearState();
}

/** Drop every open controller EXCEPT the one driving player 1. */
export function SDL_CloseSecondaryGamepads(): void {
  const l = lib();
  if (!l) return;
  const primary = gpDeviceForPlayer(0);
  for (let i = gpDevices.length - 1; i >= 0; i--) {
    const dev = gpDevices[i];
    if (!dev || dev === primary) continue;
    gpCloseDevice(l, dev);
    gpDevices.splice(i, 1);
  }
  gpDeviceGeneration++;
  gpResolve();
}

/*
Device IDENTITY for an open controller: SDL's GUID as text, plus the
human-readable name.

SDL_GameControllerMapping's return value begins with the GUID hex followed by
a comma (see the symbol table's own note on why the by-value
SDL_JoystickGetGUIDString cannot be used through bun:ffi). The buffer is
malloc'd by SDL, so it is read into a JS string and released immediately.

Fallbacks, in order, because neither call is guaranteed to produce anything:
a pad with no mapping string gets a synthesized identity from the same
vendor/product/version fields SDL folds into a real GUID (equally stable
across replugs), and a pad that reports none of those gets "unknown", which
is honest -- an unknown identity simply cannot be assigned by name, and the
Controllers menu still lists it and still lets "auto" use it.
*/
function gpReadIdentity(l: SdlLib, handle: Pointer | bigint): { guid: string; name: string } {
  let name = "";
  try {
    name = l.symbols.SDL_GameControllerName(handle) ?? "";
  } catch {
    name = "";
  }

  let guid = "";
  try {
    const mapping = l.symbols.SDL_GameControllerMapping(handle);
    if (mapping) {
      const text = new CString(mapping).toString();
      l.symbols.SDL_free(mapping);
      const comma = text.indexOf(",");
      const head = (comma < 0 ? text : text.slice(0, comma)).trim();
      // A mapping's leading field is the GUID; guard against a malformed one
      // rather than trusting whatever text came back.
      if (/^[0-9a-fA-F]{8,32}$/.test(head)) guid = head.toLowerCase();
      if (!name) {
        const rest = comma < 0 ? "" : text.slice(comma + 1);
        const second = rest.indexOf(",");
        name = (second < 0 ? rest : rest.slice(0, second)).trim();
      }
    }
  } catch {
    guid = "";
  }

  if (!guid) {
    try {
      const vendor = l.symbols.SDL_GameControllerGetVendor(handle);
      const product = l.symbols.SDL_GameControllerGetProduct(handle);
      const version = l.symbols.SDL_GameControllerGetProductVersion(handle);
      if (vendor || product) {
        const hex = (v: number): string => (v & 0xffff).toString(16).padStart(4, "0");
        guid = `vpv:${hex(vendor)}:${hex(product)}:${hex(version)}`;
      }
    } catch {
      guid = "";
    }
  }

  if (!guid) guid = "unknown";
  if (!name) name = "controller";
  return { guid, name };
}

/*
Open a newly-arrived controller into the device table. Every pad goes into
the same table now; which player it drives is decided afterwards by
gpResolve, not by which slot it landed in.

A pad SDL reports twice (or whose instance id could not be read while other
pads are already open) would alias onto an existing entry's event routing, so
it is refused rather than allowed to corrupt a working device. The table is
capped at one pad per player -- a fifth controller has no player to drive.
*/
function gpOpenDevice(l: SdlLib, deviceIndex: number): void {
  if (!l.symbols.SDL_IsGameController(deviceIndex)) return;
  if (gpDevices.length >= MAX_GAMEPAD_DEVICES) return;

  const handle = l.symbols.SDL_GameControllerOpen(deviceIndex);
  if (!handle) return;

  const joystick = l.symbols.SDL_GameControllerGetJoystick(handle);
  const instanceId = joystick ? l.symbols.SDL_JoystickInstanceID(joystick) : -1;
  if (gpDeviceByInstance(instanceId) || (instanceId < 0 && gpDevices.length > 0)) {
    l.symbols.SDL_GameControllerClose(handle);
    return;
  }

  const dev = new GamepadDeviceT();
  dev.handle = handle;
  dev.instanceId = instanceId;
  const identity = gpReadIdentity(l, handle);
  dev.guid = identity.guid;
  dev.name = identity.name;
  gpDevices.push(dev);
  gpDeviceGeneration++;
  gpResolve();
  Com_DPrintf("gamepad: %s (%s) connected\n", dev.name, dev.guid);
}

/*
SDL_CONTROLLERDEVICEADDED/REMOVED (SDL_gamecontroller.h/SDL_events.h):
`which` is a DEVICE INDEX for ADDED, an INSTANCE ID for REMOVED -- two
different namespaces sharing one struct field, per SDL_ControllerDeviceEvent's
own doc comment. A REMOVED event only closes a handle whose instance id we
actually opened, so unplugging some other, never-opened controller cannot
drop an active one.
*/
function gpHandleDeviceEvent(l: SdlLib, added: boolean, which: number): void {
  if (added) {
    gpOpenDevice(l, which);
    return;
  }
  for (let i = 0; i < gpDevices.length; i++) {
    const dev = gpDevices[i];
    if (!dev || dev.instanceId !== which) continue;
    gpCloseDevice(l, dev);
    gpDevices.splice(i, 1);
    gpDeviceGeneration++;
    gpResolve();
    return;
  }
}

function IN_MLookDown(): void {
  mlooking = true;
}

function IN_MLookUp(): void {
  mlooking = false;
  if (!(freelook && freelook.value) && lookspring && lookspring.value) clInputMod().IN_CenterView();
}

export function IN_Init(): void {
  // in_win.c's IN_StartupMouse registrations, plus this port's own
  // SDL_GameController registrations below (in_win.c had no equivalent --
  // see keys.ts's own citation on why the K_GAMEPAD_* keynums are new, not
  // ported from anything).
  in_mouse = Cvar_Get("in_mouse", "1", CVAR_ARCHIVE);
  m_filter = Cvar_Get("m_filter", "0", 0);
  sensitivity = Cvar_Get("sensitivity", "3", 0);
  lookstrafe = Cvar_Get("lookstrafe", "0", 0);
  // q2repro src/client/input.c:775 defaults freelook to "1" (cvar-parity
  // fix -- was diverging from both this file and cl_main.ts's registration).
  freelook = Cvar_Get("freelook", "1", 0);
  lookspring = Cvar_Get("lookspring", "0", 0);
  m_pitch = Cvar_Get("m_pitch", "0.022", 0);
  m_yaw = Cvar_Get("m_yaw", "0.022", 0);
  m_forward = Cvar_Get("m_forward", "1", 0);
  // q2repro src/client/input.c:783 defaults m_side to "1", not "0.8"
  // (cvar-parity fix).
  m_side = Cvar_Get("m_side", "1", 0);

  // Gamepad stick movement/look: new functionality (vanilla PC Quake II
  // never had SDL_GameController analog input at all; the nearest
  // precedent is in_win.c's IN_JoyMove for a physical DirectInput joystick
  // -- see IN_JoyMove's own doc comment below and gamepad_map.ts's
  // GamepadAxisNormalize comment for the full citation/deviation writeup).
  // Button presses (K_GAMEPAD_* keynums, dispatched from SDL_PumpInput
  // below) are always live regardless of in_joystick, the same way
  // keyboard/mouse-button Key_Event calls are never gated by an enable
  // cvar -- in_joystick only gates the CONTINUOUS stick axes IN_JoyMove
  // applies to cmd/viewangles, so a pad plugged in but not being used for
  // movement can't fight keyboard/mouse input through stick drift.
  in_joystick = Cvar_Get("in_joystick", "1", CVAR_ARCHIVE);
  // in_win.c's joy_forwardthreshold/joy_sidethreshold/joy_pitchthreshold/
  // joy_yawthreshold all defaulted to "0.15"; this port collapses that to
  // one shared per-axis deadzone (gamepad_map.ts's GamepadAxisNormalize doc
  // comment explains why one knob is enough for SDL_GameController's fixed
  // 2-stick layout, where in_win.c's per-axis-remap system doesn't apply).
  joy_deadzone = Cvar_Get("joy_deadzone", "0.15", 0);
  joy_forwardsensitivity = Cvar_Get("joy_forwardsensitivity", "1", 0);
  joy_sidesensitivity = Cvar_Get("joy_sidesensitivity", "1", 0);
  joy_yawsensitivity = Cvar_Get("joy_yawsensitivity", "1", 0);
  joy_pitchsensitivity = Cvar_Get("joy_pitchsensitivity", "1", 0);
  // Per-player device assignment and stick tuning (gamepad_assign.ts).
  // Registered HERE, right after the globals above and nowhere earlier, so
  // each per-player tuning cvar takes its default from the global's live
  // value -- main.ts has already exec'd config.cfg by the time IN_Init runs,
  // so an existing `set joy_yawsensitivity 2` is what every player defaults
  // to and nobody's aim changes because this feature was added. See
  // gamepad_assign.ts's header.
  RegisterPlayerCvars();
  gpLeftTriggerDown = false;
  gpRightTriggerDown = false;
  for (const dev of gpDevices) dev.clearState();
  gpResolve();
  {
    const gl = lib();
    if (gl) initSubsystem(gl, SDL_INIT_GAMECONTROLLER);
  }

  Cmd_AddCommand("+mlook", IN_MLookDown);
  Cmd_AddCommand("-mlook", IN_MLookUp);

  // q2repro src/client/input.c:187-203 (IN_Init): in_enable gates whether
  // mouse hardware is initialized at all; in_grab controls whether the
  // pointer is captured once active. This port's CvarT has no `changed`
  // callback mechanism (in_changed_hard/in_changed_soft are not ported), so
  // both are read live at each call site below instead of via a callback.
  // (Gamepad init above already ran and is unaffected by this mouse-only
  // gate -- in_enable/"Mouse input disabled" has never applied to the
  // K_GAMEPAD_* button path or the joystick axes, matching how it never
  // applied to the keyboard either.)
  in_enable = Cvar_Get("in_enable", "1", 0);
  if (!(in_enable && in_enable.value)) {
    Com_Printf("Mouse input disabled.\n");
    mouse_avail = false;
    return;
  }
  in_grab = Cvar_Get("in_grab", "1", 0);

  const l = lib();
  mouse_avail = l !== null && initSubsystem(l, SDL_INIT_VIDEO);
  mx = 0;
  my = 0;
  old_mouse_x = 0;
  old_mouse_y = 0;
}

export function IN_Shutdown(): void {
  IN_DeactivateMouse();
  mouse_avail = false;
  const l = lib();
  if (l) for (const dev of gpDevices) gpCloseDevice(l, dev);
  gpDevices.length = 0;
  gpDeviceGeneration++;
  gpResolve();
}

function IN_ActivateMouse(): void {
  const l = lib();
  if (!l || !mouse_avail || mouse_active) return;
  // q2repro src/client/input.c:199-203 (IN_Activate/in_grab): only capture
  // the pointer if in_grab is set.
  if (!in_grab || in_grab.value) l.symbols.SDL_SetRelativeMouseMode(1);
  // drain whatever relative motion piled up while the mouse was released
  l.symbols.SDL_GetRelativeMouseState(relX, relY);
  mx = 0;
  my = 0;
  mouse_active = true;
}

function IN_DeactivateMouse(): void {
  const l = lib();
  if (!l || !mouse_active) return;
  l.symbols.SDL_SetRelativeMouseMode(0);
  mouse_active = false;
}

/*
in_win.c's IN_Frame: let the mouse go whenever the game is not the thing
reading it (console, menu, no refresh yet), except in fullscreen, where
releasing it would drop the pointer outside the display.
*/
export function IN_Frame(): void {
  if (!mouse_avail) return;

  if (!(in_mouse && in_mouse.value) || !windowActive) {
    IN_DeactivateMouse();
    return;
  }

  if (!cl.refresh_prepped || cls.key_dest === KeydestT.key_console || cls.key_dest === KeydestT.key_menu) {
    if (Cvar_VariableValue("vid_fullscreen") === 0) {
      IN_DeactivateMouse();
      return;
    }
  }

  IN_ActivateMouse();
}

/*
in_win.c's IN_MouseMove, called from IN_Move. The accumulated relative
motion is read straight from SDL rather than from a WM_MOUSEMOVE delta.
*/
export function IN_Move(cmd: UsercmdT): void {
  IN_MouseMove(cmd);
  IN_JoyMove(cmd);
}

function IN_MouseMove(cmd: UsercmdT): void {
  const l = lib();
  if (!l || !mouse_active) return;

  l.symbols.SDL_GetRelativeMouseState(relX, relY);

  // wheel.c's CL_MouseMove: "always send input to wheel even if we didn't
  // move" -- fed the RAW per-frame relative motion (q2repro's own dx/dy,
  // read once per frame from vid->get_mouse_motion before m_filter/
  // sensitivity scaling below), not the filtered mouse_x/mouse_y this
  // function computes for cmd/viewangles. This is the one place in this
  // port's input backend that still has undivided access to that raw
  // per-frame delta -- see cl_wheel.ts's own CL_Wheel_Input doc comment.
  // CL_Wheel_Input's own top-of-function check (mirroring wheel.c's) is
  // what gates on wheel.state, not this call site -- called unconditionally
  // here so the WHEEL_CLOSING "keep holster held" branch still runs.
  CL_Wheel_Input(cmd, relX[0], relY[0]);

  // main.c:3391's CL_Wheel_Update() call: no dedicated per-frame client-tick
  // hook exists in this port's territory for this unit (cl_main.ts/
  // cl_view.ts, the closest counterparts, are both under concurrent edit by
  // another unit per this task's brief) -- called from here instead, the
  // one place in this port that already runs unconditionally once per
  // client frame while the mouse backend is live. Reported deviation.
  CL_Wheel_Update();

  mx += relX[0];
  my += relY[0];

  let mouse_x: number;
  let mouse_y: number;
  if (m_filter && m_filter.value) {
    mouse_x = (mx + old_mouse_x) * 0.5;
    mouse_y = (my + old_mouse_y) * 0.5;
  } else {
    mouse_x = mx;
    mouse_y = my;
  }

  old_mouse_x = mx;
  old_mouse_y = my;
  mx = 0;
  my = 0;

  const sens = sensitivity ? sensitivity.value : 0;
  mouse_x *= sens;
  mouse_y *= sens;

  // add mouse X/Y movement to cmd
  if (in_strafe.state & 1 || (lookstrafe && lookstrafe.value && mlooking)) cmd.sidemove += (m_side ? m_side.value : 0) * mouse_x;
  else cl.viewangles[YAW] -= (m_yaw ? m_yaw.value : 0) * mouse_x;

  if ((mlooking || (freelook && freelook.value)) && !(in_strafe.state & 1)) cl.viewangles[PITCH] += (m_pitch ? m_pitch.value : 0) * mouse_y;
  else cmd.forwardmove -= (m_forward ? m_forward.value : 0) * mouse_y;
}

/*
in_win.c's IN_JoyMove shape, adapted for SDL_GameController's fixed 2-stick
layout (gamepad_map.ts's GamepadAxisNormalize doc comment has the full
citation/deviation writeup against in_win.c's own per-axis-remap joystick
system). Left stick feeds forward/side movement the same fields CL_BaseMove's
own WASD handling writes; right stick feeds yaw/pitch the same fields
CL_AdjustAngles's own arrow-key turn handling writes (both already ran
before CL_CreateCmd reaches IN_Move) -- scaled by the SAME cl_yawspeed/
cl_pitchspeed cvars times cls.frametime times this axis's own
joy_*sensitivity multiplier, rather than m_yaw/m_pitch: a stick reports a
sustained deflection every frame, not a one-shot relative delta the way a
mouse motion event does, so it needs the same "degrees per second of hold
time" scaling in_win.c's own joystick turn axes used, not the mouse's
per-event scaling.

Gated on in_joystick AND cls.key_dest === key_game: a pad left plugged in
but unused should never fight keyboard/mouse input in a menu or the
console, the same reasoning IN_Frame already applies to mouse capture.
*/
function IN_JoyMove(cmd: UsercmdT): void {
  if (!(in_joystick && in_joystick.value)) return;
  if (cls.key_dest !== KeydestT.key_game) return;

  // PLAYER 1's pad, whichever device that currently is -- not "the first pad
  // that happened to be opened". With every player on "auto" they are the
  // same device; once somebody assigns controllers on the Controllers
  // screen, this is what makes the assignment real for seat 0.
  const pad = gpDeviceForPlayer(0);
  if (!pad) return;

  // Player 1's own deadzone/sensitivity/invert, defaulted from the global
  // joy_* values at registration (gamepad_assign.ts). joy_forwardsensitivity
  // and joy_sidesensitivity stay global for every player: movement speed is
  // not a per-seat preference the way aim is.
  const tuning = PlayerTuning(0);

  const dz = tuning.deadzone;
  const lx = GamepadAxisNormalize(pad.leftX, dz);
  const ly = GamepadAxisNormalize(pad.leftY, dz);
  const rx = GamepadAxisNormalize(pad.rightX, dz);
  const ry = GamepadAxisNormalize(pad.rightY, dz);
  if (lx === 0 && ly === 0 && rx === 0 && ry === 0) return;

  const sidespeed = clCvars.cl_sidespeed ? clCvars.cl_sidespeed.value : 0;
  const forwardspeed = clCvars.cl_forwardspeed ? clCvars.cl_forwardspeed.value : 0;
  const yawspeed = clCvars.cl_yawspeed ? clCvars.cl_yawspeed.value : 0;
  const pitchspeed = clCvars.cl_pitchspeed ? clCvars.cl_pitchspeed.value : 0;

  const fwdSens = joy_forwardsensitivity ? joy_forwardsensitivity.value : 1;
  const sideSens = joy_sidesensitivity ? joy_sidesensitivity.value : 1;
  const yawSens = tuning.yawsensitivity;
  const pitchSens = tuning.pitchsensitivity;

  // Left stick: SDL's Y axis is positive DOWN, so pushing the stick up
  // (negative Y) is forward -- the same sign convention CL_BaseMove's own
  // in_forward/in_back pair already produces for cmd.forwardmove.
  cmd.forwardmove += forwardspeed * fwdSens * -ly;
  cmd.sidemove += sidespeed * sideSens * lx;

  // Right stick: matches IN_MouseMove's own mouse_x/mouse_y sign convention
  // directly above (stick right = look right = yaw decreases; stick down =
  // look down = pitch increases). tuning.pitchsign is -1 when this player has
  // invert-pitch on, which is the whole of what that toggle does.
  cl.viewangles[YAW] -= cls.frametime * yawspeed * yawSens * rx;
  cl.viewangles[PITCH] += cls.frametime * pitchspeed * pitchSens * tuning.pitchsign * ry;
}

// in_win.c's IN_Commands only reads the joystick's DIGITAL buttons (POV hat
// etc, folded into cmd.buttons there); this port's gamepad buttons already
// arrive as ordinary Key_Event calls from the pump (SDL_GameController
// normalizes even the d-pad into button events, unlike a raw HAT), so there
// is nothing left for this function to poll.
export function IN_Commands(): void {}

/*
sys_linux.c's Sys_SendKeyEvents / rw_x11.c's HandleEvents: drain the OS
event queue, turning it into Key_Event calls. `time` is the timestamp the
caller latched for this frame (sys_frame_time).
*/
export function SDL_PumpInput(time: number): void {
  const l = lib();
  if (!l) return;
  if ((subsystems & SDL_INIT_VIDEO) === 0) return;

  const { Key_Event } = keysMod();

  while (l.symbols.SDL_PollEvent(eventBuf) !== 0) {
    const type = eventView.getUint32(0, true);
    switch (type) {
      case SDL_KEYDOWN:
      case SDL_KEYUP: {
        // key repeats are regenerated by keys.c's own repeat handling
        if (eventBuf[KEYEVENT_REPEAT] !== 0) break;
        const key = SDL_KeyToQuake(eventView.getInt32(KEYEVENT_SYM, true));
        if (key !== 0) Key_Event(key, eventBuf[KEYEVENT_STATE] !== 0, time);
        break;
      }
      case SDL_MOUSEBUTTONDOWN:
      case SDL_MOUSEBUTTONUP: {
        const down = type === SDL_MOUSEBUTTONDOWN;
        switch (eventBuf[BUTTONEVENT_BUTTON]) {
          case SDL_BUTTON_LEFT:
            Key_Event(K_MOUSE1, down, time);
            break;
          case SDL_BUTTON_RIGHT:
            Key_Event(K_MOUSE2, down, time);
            break;
          case SDL_BUTTON_MIDDLE:
            Key_Event(K_MOUSE3, down, time);
            break;
          default:
            break;
        }
        break;
      }
      case SDL_MOUSEWHEEL: {
        // the wheel has no up event of its own: keys.c wants a press and a
        // release per notch, the way win32's WM_MOUSEWHEEL handler sends them
        const y = eventView.getInt32(WHEELEVENT_Y, true);
        if (y > 0) {
          Key_Event(K_MWHEELUP, true, time);
          Key_Event(K_MWHEELUP, false, time);
        } else if (y < 0) {
          Key_Event(K_MWHEELDOWN, true, time);
          Key_Event(K_MWHEELDOWN, false, time);
        }
        break;
      }
      case SDL_WINDOWEVENT: {
        const ev = eventBuf[WINDOWEVENT_EVENT];
        if (ev === SDL_WINDOWEVENT_FOCUS_GAINED) SDL_AppActivate(true);
        else if (ev === SDL_WINDOWEVENT_FOCUS_LOST) SDL_AppActivate(false);
        else if (ev === SDL_WINDOWEVENT_CLOSE) commonMod().Com_Quit();
        break;
      }
      case SDL_CONTROLLERBUTTONDOWN:
      case SDL_CONTROLLERBUTTONUP: {
        const down = type === SDL_CONTROLLERBUTTONDOWN;
        const button = eventBuf[CBUTTONEVENT_BUTTON];
        // Route by instance id to the device that sent it, then by ROLE:
        // only PLAYER 1's pad turns buttons into Key_Event (bind system,
        // menu, seat 0). Every other pad latches a raw held-button bitmask
        // for cl_seats.ts instead. An event from a device we never opened is
        // dropped rather than treated as player 1's.
        const dev = gpDeviceByInstance(eventView.getInt32(CBUTTONEVENT_WHICH, true));
        if (!dev) break;
        if (dev !== gpDeviceForPlayer(0)) {
          if (button >= 0 && button < 31) {
            if (down) dev.buttons |= 1 << button;
            else dev.buttons &= ~(1 << button);
          }
          break;
        }
        const mapped = SDL_GamepadButtonEventToKey(button, down);
        if (mapped) Key_Event(mapped.key, mapped.down, time);
        break;
      }
      case SDL_CONTROLLERAXISMOTION: {
        const axis = eventBuf[CAXISEVENT_AXIS];
        const value = eventView.getInt16(CAXISEVENT_VALUE, true);
        const dev = gpDeviceByInstance(eventView.getInt32(CAXISEVENT_WHICH, true));
        if (!dev) break;

        // Sticks are latched on the device whichever player it drives:
        // IN_JoyMove reads player 1's copy, cl_seats.ts reads the rest.
        if (axis === SDL_CONTROLLER_AXIS_LEFTX) dev.leftX = value;
        else if (axis === SDL_CONTROLLER_AXIS_LEFTY) dev.leftY = value;
        else if (axis === SDL_CONTROLLER_AXIS_RIGHTX) dev.rightX = value;
        else if (axis === SDL_CONTROLLER_AXIS_RIGHTY) dev.rightY = value;
        else if (dev !== gpDeviceForPlayer(0)) {
          // A seat's triggers stay analog -- cl_seats.ts thresholds them
          // itself, since a seat has no bind table to send a key into.
          if (axis === SDL_CONTROLLER_AXIS_TRIGGERLEFT) dev.triggerL = value;
          else if (axis === SDL_CONTROLLER_AXIS_TRIGGERRIGHT) dev.triggerR = value;
        } else {
          // Player 1's trigger axes: convert to an edge-triggered Key_Event
          // instead of storing raw analog data -- see gamepad_map.ts's own
          // doc comment on SDL_GamepadTriggerAxisEventToKey for the
          // threshold/hysteresis shape this implements.
          const wasDown = axis === SDL_CONTROLLER_AXIS_TRIGGERLEFT ? gpLeftTriggerDown : gpRightTriggerDown;
          const trig = SDL_GamepadTriggerAxisEventToKey(axis, value, wasDown);
          if (trig) {
            if (axis === SDL_CONTROLLER_AXIS_TRIGGERLEFT) gpLeftTriggerDown = trig.down;
            else gpRightTriggerDown = trig.down;
            Key_Event(trig.key, trig.down, time);
          }
        }
        break;
      }
      case SDL_CONTROLLERDEVICEADDED:
        gpHandleDeviceEvent(l, true, eventView.getInt32(CDEVICEEVENT_WHICH, true));
        break;
      case SDL_CONTROLLERDEVICEREMOVED:
        gpHandleDeviceEvent(l, false, eventView.getInt32(CDEVICEEVENT_WHICH, true));
        break;
      case SDL_QUIT:
        commonMod().Com_Quit();
        break;
      default:
        break;
    }
  }
}

export function SDL_AppActivate(active: boolean): void {
  windowActive = active;
  if (!active) IN_DeactivateMouse();
}

export function SDL_WindowActive(): boolean {
  return windowActive;
}

//=============================================================================
// AUDIO -- snd_win.c's DirectSound secondary buffer, replaced by SDL's
// push-mode queue. No callback is installed (SDL_AudioSpec.callback = NULL),
// so nothing here runs on SDL's audio thread and the mixer keeps its
// single-threaded C shape.

let audioDevice = 0;
let audioBytesQueued = 0;

export function SDLSND_Open(freq: number, channels: number, samplebits: number): { freq: number; channels: number } | null {
  const l = lib();
  if (!l) return null;
  if (samplebits !== 16) return null;
  if (!initSubsystem(l, SDL_INIT_AUDIO)) return null;

  const desired = new Uint8Array(AUDIOSPEC_SIZE);
  const obtained = new Uint8Array(AUDIOSPEC_SIZE);
  const dv = new DataView(desired.buffer);
  dv.setInt32(AUDIOSPEC_FREQ, freq, true);
  dv.setUint16(AUDIOSPEC_FORMAT, AUDIO_S16LSB, true);
  desired[AUDIOSPEC_CHANNELS] = channels;
  // ~11ms of latency at 44100, and a power of two the way SDL wants it
  dv.setUint16(AUDIOSPEC_SAMPLES, 512, true);

  // allowed_changes = 0: take the format asked for or nothing, so the DMA
  // ring layout the mixer writes stays valid.
  const dev = l.symbols.SDL_OpenAudioDevice(null, 0, desired, obtained, 0);
  if (dev === 0) {
    Com_Printf("SDL: SDL_OpenAudioDevice failed: %s\n", sdlError(l));
    return null;
  }

  audioDevice = dev;
  audioBytesQueued = 0;
  l.symbols.SDL_PauseAudioDevice(dev, 0);

  const ov = new DataView(obtained.buffer);
  return { freq: ov.getInt32(AUDIOSPEC_FREQ, true), channels: obtained[AUDIOSPEC_CHANNELS] };
}

export function SDLSND_Active(): boolean {
  return audioDevice !== 0;
}

export function SDLSND_Close(): void {
  const l = lib();
  if (!l || audioDevice === 0) return;
  l.symbols.SDL_PauseAudioDevice(audioDevice, 1);
  l.symbols.SDL_ClearQueuedAudio(audioDevice);
  l.symbols.SDL_CloseAudioDevice(audioDevice);
  audioDevice = 0;
  audioBytesQueued = 0;
  quitSubsystem(l, SDL_INIT_AUDIO);
}

export function SDLSND_Queue(bytes: Uint8Array): void {
  const l = lib();
  if (!l || audioDevice === 0 || bytes.length === 0) return;
  if (l.symbols.SDL_QueueAudio(audioDevice, bytes, bytes.length) === 0) audioBytesQueued += bytes.length;
}

// bytes the device has actually consumed, which is what stands in for
// DirectSound's play cursor.
export function SDLSND_ConsumedBytes(): number {
  const l = lib();
  if (!l || audioDevice === 0) return 0;
  return audioBytesQueued - l.symbols.SDL_GetQueuedAudioSize(audioDevice);
}

export function SDLSND_QueuedBytes(): number {
  const l = lib();
  if (!l || audioDevice === 0) return 0;
  return l.symbols.SDL_GetQueuedAudioSize(audioDevice);
}

// test seam: forget the loaded library and every device handle, so a suite
// can bring the backend up and down inside one process.
export function SDL_ResetBackendForTests(): void {
  SDLSND_Close();
  SDLVID_Shutdown();
  const l = library;
  for (const dev of gpDevices) {
    if (l && dev.handle) gpCloseDevice(l, dev);
    else {
      dev.handle = null;
      dev.clearState();
    }
  }
  gpDevices.length = 0;
  gpPlayerDevice = new Array(MAX_LOCAL_PLAYERS).fill(-1);
  gpDeviceGeneration = 0;
  gpLeftTriggerDown = false;
  gpRightTriggerDown = false;
  if (l && subsystems !== 0) {
    l.symbols.SDL_Quit();
    subsystems = 0;
  }
  enabled = false;
  libraryFailed = false;
}
