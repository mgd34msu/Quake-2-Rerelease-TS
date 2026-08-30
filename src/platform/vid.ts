/*
linux/vid_so.c + win32/vid_dll.c -- the client-side video layer: the mode
table, the vid_* cvars, VID_CheckChanges' refresh (re)load, and the
refimport_t the renderer calls back through. PORTING.md maps the per-OS vid
backends to this one module.

Two things differ from the C, both forced by the port's shape:

- VID_LoadRefresh dlopen()s "ref_soft.so"/"ref_gl.so" and looks up
  GetRefAPI. Both refreshes are statically linked here (src/ref_soft/r_main.ts
  and src/ref_gl/gl_rmain.ts), so the load is a direct call by name rather
  than a dlopen()+dlsym() pair: "ref_soft" calls ref_soft's GetRefAPI
  directly; "ref_gl" first wires src/platform/glimp.ts's SDL-backed GLimp
  into gl_rmain.ts (SetGLimp) and a real system QGL binding into gl_image.ts
  (SetQGL(loadQGLFromSystem(SDLGL_GetProcAddress))) before calling gl_rmain's
  GetRefAPI; any other name fails the same way an unknown/missing ref_*.so
  would in the original. A thrown error anywhere in the ref_gl branch (a
  missing libGL, a GL context the host can't create -- e.g. SDL's "dummy"
  video driver under the test harness) is caught there and turned into the
  same false return VID_CheckChanges already falls back to "soft" from, since
  nothing throws for a real ref_*.so load failure in the C original either.

- The refresh only starts when the client backend is armed
  (sdl.ts's SDL_SetBackendEnabled, which main.ts calls on the non-dedicated
  path). The renderer test suites drive GetRefAPI themselves and call
  VID_Init only for the screenshot writer below, so an unconditional
  VID_CheckChanges here would tear their RefImports out from under them.

PORTING.md restricts `node:fs` to `src/platform` and `src/qcommon/files.ts`,
and `refimport_t` has no file-write entry point, so r_misc.ts's
R_ScreenShot_f builds the PCX in memory and hands it to an injected writer
(`SetScreenshotWriter`). This module is that writer: the one place allowed
to put the bytes on disk. In the C original the equivalent write is
`fopen`/`fwrite` inside R_ScreenShot_f itself.

R_ScreenShot_f never creates its `scrnshot` directory (refimport_t has no
Sys_Mkdir either), so the writer does it here -- the C version relies on the
directory already existing and silently fails when it does not.
*/

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SetScreenshotWriter } from "../ref_soft/r_misc";
import { SetScreenshotWriter as SetGLScreenshotWriter } from "../ref_gl/gl_rmisc";
import { GetRefAPI as GetRefAPI_Soft } from "../ref_soft/r_main";
import { GetRefAPI as GetRefAPI_GL, SetGLimp } from "../ref_gl/gl_rmain";
import { SetQGL } from "../ref_gl/gl_image";
import { loadQGLFromSystem } from "../ref_gl/qgl";
import { CreateGLimp } from "./glimp";
import { Cbuf_ExecuteText, Cmd_AddCommand, Cmd_RemoveCommand } from "../qcommon/cmd";
import { Cvar_Get, Cvar_Set, Cvar_SetValue } from "../qcommon/cvar";
import { Com_Error, Com_Printf, Com_DPrintf } from "../qcommon/common";
import { FS_Gamedir, FS_LoadFile, FS_FreeFile } from "../qcommon/files";
import { ERR_FATAL, EXEC_NOW } from "../qcommon/qcommon";
import { CVAR_ARCHIVE, PRINT_ALL, type CvarT } from "../shared/q_shared";
import { API_VERSION, type RefExports, type RefImports } from "../client/ref";
import { cl, cls, re, setRe, KeydestT } from "../client/client";
import { viddef } from "../client/vid";
import { S_StopAllSounds } from "../client/snd_dma";
import { SDL_BackendEnabled, SDLGL_GetProcAddress, SDLVID_SetWindowTitle } from "./sdl";

export function VID_WriteScreenshot(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/*
==========================================================================
DLL GLOBAL VARIABLES
==========================================================================
*/

let vid_ref: CvarT | null = null;
let vid_xpos: CvarT | null = null; // X coordinate of window position
let vid_ypos: CvarT | null = null; // Y coordinate of window position
let vid_fullscreen: CvarT | null = null;

let reflib_active = false;

/*
==========================================================================
VID_GetModeInfo
==========================================================================
*/

class VidmodeT {
  constructor(
    public description: string,
    public width: number,
    public height: number,
    public mode: number,
  ) {}
}

const vid_modes: VidmodeT[] = [
  new VidmodeT("Mode 0: 320x240", 320, 240, 0),
  new VidmodeT("Mode 1: 400x300", 400, 300, 1),
  new VidmodeT("Mode 2: 512x384", 512, 384, 2),
  new VidmodeT("Mode 3: 640x480", 640, 480, 3),
  new VidmodeT("Mode 4: 800x600", 800, 600, 4),
  new VidmodeT("Mode 5: 960x720", 960, 720, 5),
  new VidmodeT("Mode 6: 1024x768", 1024, 768, 6),
  new VidmodeT("Mode 7: 1152x864", 1152, 864, 7),
  new VidmodeT("Mode 8: 1280x960", 1280, 960, 8),
  new VidmodeT("Mode 9: 1600x1200", 1600, 1200, 9),
  // Extension beyond the C table (vid_menu.c stopped at 1600x1200 in the
  // 4:3 CRT era): a 16:9 mode so `vid_mode 10` gives native 1080p.
  new VidmodeT("Mode 10: 1920x1080", 1920, 1080, 10),
];

export function VID_GetModeInfo(mode: number): { width: number; height: number } | null {
  if (mode < 0 || mode >= vid_modes.length) return null;
  return { width: vid_modes[mode].width, height: vid_modes[mode].height };
}

export function VID_NewWindow(width: number, height: number): void {
  viddef.width = width;
  viddef.height = height;

  cl.force_refdef = true; // can't use a paused refdef
}

export function VID_Printf(print_level: number, str: string): void {
  if (print_level === PRINT_ALL) Com_Printf("%s", str);
  else Com_DPrintf("%s", str);
}

export function VID_Error(err_level: number, str: string): never {
  Com_Error(err_level, "%s", str);
}

/*
==========================================================================
VID_Restart_f

Console command to re-start the video mode and refresh DLL. We do this
simply by setting the modified flag for the vid_ref variable, which will
cause the entire video mode and refresh DLL to be reset on the next frame.
==========================================================================
*/
export function VID_Restart_f(): void {
  if (vid_ref) vid_ref.modified = true;
}

export function VID_Front_f(): void {
  // win32/vid_dll.c raises the game window above every other one
  // (SetWindowLong + SetForegroundWindow). SDL has no equivalent that works
  // across the platforms this one backend covers, so the window is only
  // re-titled, which is the other half of what the C function does.
  SDLVID_SetWindowTitle("Quake 2");
}

/*
==========================================================================
VID_FreeReflib
==========================================================================
*/
function VID_FreeReflib(): void {
  setRe(null);
  reflib_active = false;
}

/*
==========================================================================
VID_LoadRefresh
==========================================================================
*/
function refImports(): RefImports {
  return {
    Sys_Error: VID_Error,
    Cmd_AddCommand,
    Cmd_RemoveCommand,
    Cmd_Argc(): number {
      return cmdMod().Cmd_Argc();
    },
    Cmd_Argv(i: number): string {
      return cmdMod().Cmd_Argv(i);
    },
    Cmd_ExecuteText: Cbuf_ExecuteText,
    Con_Printf: VID_Printf,
    FS_LoadFile(name: string): { length: number; data: Uint8Array | null } {
      const data = FS_LoadFile(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile,
    FS_Gamedir,
    Cvar_Get,
    Cvar_Set,
    Cvar_SetValue,
    Vid_GetModeInfo: VID_GetModeInfo,
    Vid_MenuInit(): void {
      // vid_menu.c's VID_MenuInit builds the video menu's widget list; the
      // port lives in src/platform/vid_menu.ts (menu.ts calls it directly),
      // and ref_soft never calls this entry point -- only ref_gl's
      // GLimp_Init path does. Left empty until the video menu lands.
    },
    Vid_NewWindow: VID_NewWindow,
  };
}

// Cmd_Argc/Cmd_Argv read cmd.c's argument vector at call time, so they are
// resolved through the module rather than captured once.
function cmdMod(): typeof import("../qcommon/cmd") {
  return require("../qcommon/cmd");
}

// Shared tail of VID_LoadRefresh once `exports` is in hand: register it,
// check the api_version, and run Init -- identical for both refreshes.
function finishLoadRefresh(exports: RefExports, name: string): boolean {
  setRe(exports);

  if (exports.api_version !== API_VERSION) {
    VID_FreeReflib();
    Com_Error(ERR_FATAL, "%s has incompatible api_version", name);
  }

  if (!exports.Init(0, 0)) {
    exports.Shutdown();
    VID_FreeReflib();
    return false;
  }

  Com_Printf("------------------------------------\n");
  reflib_active = true;
  return true;
}

// exported purely as a test seam (mirrors gl_image.ts's LoadPCX precedent) --
// VID_CheckChanges below is its only real caller.
export function VID_LoadRefresh(name: string): boolean {
  if (reflib_active) {
    if (re) re.Shutdown();
    VID_FreeReflib();
  }

  Com_Printf("------- Loading %s -------\n", name);

  if (name === "ref_soft") {
    return finishLoadRefresh(GetRefAPI_Soft(refImports()), name);
  }

  if (name === "ref_gl") {
    try {
      // wire the platform seams gl_rmain.ts/gl_image.ts need before their
      // own GetRefAPI runs -- see this module's header comment. Init() is
      // inside this try too: a GL init failure can throw from deep inside
      // R_Init (e.g. Sys_Error on a missing asset) rather than returning
      // false the way a rejected video mode does, and none of that should
      // escape VID_LoadRefresh uncaught -- the same "unknown/missing ref_gl"
      // outcome the C original gets from a failed dlopen()/dlsym().
      SetGLimp(CreateGLimp());
      SetQGL(loadQGLFromSystem(SDLGL_GetProcAddress));
      return finishLoadRefresh(GetRefAPI_GL(refImports()), name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Com_Printf("LoadLibrary(\"%s\") failed: %s\n", name, msg);
      // vid_dll.c always runs re.Shutdown() when re.Init() fails; a throwing
      // Init would otherwise skip it here and leave ref_gl's console commands
      // (screenshot/modellist/imagelist/gl_strings) registered against a dead
      // GL context -- the soft refresh's own registrations are then rejected
      // as duplicates and "screenshot" segfaults through a null GL pointer.
      // Shutdown removes its commands first, so even if it throws partway
      // through the dead-context teardown the command table is clean.
      if (re) {
        try {
          re.Shutdown();
        } catch {
          // partially-initialized refresh; commands are already removed
        }
      }
      VID_FreeReflib();
      return false;
    }
  }

  Com_Printf("LoadLibrary(\"%s\") failed: no such refresh\n", name);
  return false;
}

/*
============
VID_CheckChanges

This function gets called once just before drawing each frame, and it's
sole purpose in life is to check to see if any of the video mode parameters
have changed, and if they have to update the rendering DLL and/or video
mode to match.
============
*/
export function VID_CheckChanges(): void {
  if (!SDL_BackendEnabled()) return; // see this module's banner

  if (vid_ref && vid_ref.modified) S_StopAllSounds();

  while (vid_ref && vid_ref.modified) {
    //
    // refresh has changed
    //
    vid_ref.modified = false;
    if (vid_fullscreen) vid_fullscreen.modified = true;
    cl.refresh_prepped = false;
    cls.disable_screen = 1;

    const name = `ref_${vid_ref.string}`;
    if (!VID_LoadRefresh(name)) {
      if (vid_ref.string === "soft") Com_Error(ERR_FATAL, "Couldn't fall back to software refresh!");
      Cvar_Set("vid_ref", "soft");

      // drop the console if we fail to load a refresh
      if (cls.key_dest !== KeydestT.key_console) {
        Cbuf_ExecuteText(EXEC_NOW, "toggleconsole\n");
      }
    }
    cls.disable_screen = 0;
  }
}

/*
============
VID_Init
============
*/
export function VID_Init(): void {
  SetScreenshotWriter(VID_WriteScreenshot);
  SetGLScreenshotWriter(VID_WriteScreenshot);

  // Create the video variables so we know how to start the graphics drivers.
  // vid_so.c picks "softx" when $DISPLAY is set and "soft" otherwise; this
  // port has one software refresh whichever windowing system SDL picks, so
  // the default is always "soft".
  vid_ref = Cvar_Get("vid_ref", "soft", CVAR_ARCHIVE);
  vid_xpos = Cvar_Get("vid_xpos", "3", CVAR_ARCHIVE);
  vid_ypos = Cvar_Get("vid_ypos", "22", CVAR_ARCHIVE);
  vid_fullscreen = Cvar_Get("vid_fullscreen", "0", CVAR_ARCHIVE);
  Cvar_Get("vid_gamma", "1", CVAR_ARCHIVE);

  // Add some console commands that we want to handle
  Cmd_AddCommand("vid_restart", VID_Restart_f);
  Cmd_AddCommand("vid_front", VID_Front_f);

  // Start the graphics mode and load refresh DLL
  VID_CheckChanges();
}

/*
============
VID_Shutdown
============
*/
export function VID_Shutdown(): void {
  if (reflib_active) {
    if (re) re.Shutdown();
    VID_FreeReflib();
  }
  SetScreenshotWriter(null);
}

// vid_xpos/vid_ypos are read by win32/vid_dll.c's window placement; SDL
// centers the window instead (see sdl.ts), so they are registered for the
// menu's sake and otherwise unread here.
export function VID_WindowPosition(): { x: number; y: number } {
  return { x: vid_xpos ? vid_xpos.value : 0, y: vid_ypos ? vid_ypos.value : 0 };
}
