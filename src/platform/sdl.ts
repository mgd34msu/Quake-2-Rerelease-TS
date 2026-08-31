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

import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { VID_CalcScaledRect } from "./vid_scale";
import { Cvar_Get, Cvar_VariableValue } from "../qcommon/cvar";
import { Cmd_AddCommand } from "../qcommon/cmd";
import { Com_DPrintf, Com_Printf } from "../qcommon/common";
import type { CvarT, UsercmdT } from "../shared/q_shared";
import { CVAR_ARCHIVE, PITCH, YAW } from "../shared/q_shared";
import { cl, cls, in_strafe, KeydestT } from "../client/client";
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
let rgba = new Uint8Array(0);
let framesPresented = 0;
const dstRectBuf = new Int32Array(4); // reused SDL_Rect (x,y,w,h) for SDL_RenderCopy's dstrect

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
export function SDLVID_Init(renderWidth: number, renderHeight: number, fullscreen: boolean, displayWidth: number = renderWidth, displayHeight: number = renderHeight): boolean {
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
  dispWidth = displayWidth;
  dispHeight = displayHeight;
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

  const rect = VID_CalcScaledRect(texWidth, texHeight, dispWidth, dispHeight);
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

export function SDLGL_CreateWindow(width: number, height: number, fullscreen: boolean): boolean {
  const l = lib();
  if (!l) return false;
  if (!initSubsystem(l, SDL_INIT_VIDEO)) return false;

  if (glContext) {
    l.symbols.SDL_GL_DeleteContext(glContext);
    glContext = null;
  }
  SDLVID_Shutdown(); // destroy any previous window (software or GL) first, like GLimp_SetMode's GLimp_Shutdown() call in the C original

  l.symbols.SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  // 24, not the win32 PFD's 32 -- no per-OS branch here (PORTING.md's
  // portable-path rule), and 24-bit depth is what every GL driver this port
  // actually runs against offers; SDL_GL_SetAttribute is a request, not a
  // guarantee, so this only steers picking a close-enough visual/config.
  l.symbols.SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);

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
// in_win.c's IN_MouseMove/IN_Frame/IN_ActivateMouse.

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

function IN_MLookDown(): void {
  mlooking = true;
}

function IN_MLookUp(): void {
  mlooking = false;
  if (!(freelook && freelook.value) && lookspring && lookspring.value) clInputMod().IN_CenterView();
}

export function IN_Init(): void {
  // in_win.c's IN_StartupMouse registrations, minus the joystick ones
  // (no joystick support in this backend).
  in_mouse = Cvar_Get("in_mouse", "1", CVAR_ARCHIVE);
  m_filter = Cvar_Get("m_filter", "0", 0);
  sensitivity = Cvar_Get("sensitivity", "3", 0);
  lookstrafe = Cvar_Get("lookstrafe", "0", 0);
  freelook = Cvar_Get("freelook", "0", 0);
  lookspring = Cvar_Get("lookspring", "0", 0);
  m_pitch = Cvar_Get("m_pitch", "0.022", 0);
  m_yaw = Cvar_Get("m_yaw", "0.022", 0);
  m_forward = Cvar_Get("m_forward", "1", 0);
  m_side = Cvar_Get("m_side", "0.8", 0);

  Cmd_AddCommand("+mlook", IN_MLookDown);
  Cmd_AddCommand("-mlook", IN_MLookUp);

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
}

function IN_ActivateMouse(): void {
  const l = lib();
  if (!l || !mouse_avail || mouse_active) return;
  l.symbols.SDL_SetRelativeMouseMode(1);
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
  const l = lib();
  if (!l || !mouse_active) return;

  l.symbols.SDL_GetRelativeMouseState(relX, relY);
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

// in_win.c's IN_Commands only reads the joystick, which this backend does
// not support; mouse buttons already arrive as key events from the pump.
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
  if (l && subsystems !== 0) {
    l.symbols.SDL_Quit();
    subsystems = 0;
  }
  enabled = false;
  libraryFailed = false;
}
