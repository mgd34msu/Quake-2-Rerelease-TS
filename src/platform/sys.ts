// linux/sys_linux.c + win32/sys_win.c, etc. -- one portable bun implementation
// of the non-portable system services qcommon.h declares. Only the pieces
// common.c/cvar.c/cmd.c/cl_input.c actually call are ported here; the rest of
// sys_*.c (Sys_Init, Sys_GetGameAPI, ...) has no bun equivalent -- see
// src/main.ts's Qcommon_Init banner for the list.

import { Com_sprintf } from "../shared/q_shared";
import type * as SdlModule from "./sdl";

export const curtime = { value: 0 };

let startTime: number | null = null;

// monotonic clock, integer ms since first call
export function Sys_Milliseconds(): number {
  if (startTime === null) {
    startTime = performance.now();
  }
  const ms = Math.floor(performance.now() - startTime);
  curtime.value = ms;
  return ms;
}

export function Sys_ConsoleOutput(text: string): void {
  process.stdout.write(text);
}

// Sys_Error is fatal and does not return in the original engine.
export function Sys_Error(fmt: string, ...args: Array<string | number>): never {
  const msg = Com_sprintf(fmt, ...args);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

export function Sys_Quit(): never {
  process.exit(0);
}

// sys_linux.c reads stdin here only for a dedicated server (its first line
// is `if (!dedicated || !dedicated->value) return NULL;`, and the windowed
// client's console is keys.c's instead). No non-blocking stdin reader is
// wired up under bun, so this stays NULL for both.
export function Sys_ConsoleInput(): string | null {
  return null;
}

// sys_linux.c's Sys_GetClipboardData returns NULL (only win32 implements a
// real clipboard read); ported as the linux behavior.
export function Sys_GetClipboardData(): string | null {
  return null;
}

/*
sys_linux.c's `unsigned sys_frame_time`, assigned once per frame by
Sys_SendKeyEvents before it pumps the OS event queue. cl_input.c's
CL_KeyState/CL_CreateCmd read it to weight partial key presses.
*/
export let sys_frame_time = 0;

// sdl.ts is resolved lazily so this module stays a leaf: sdl.ts reaches back
// into common.ts/cvar.ts, which import from here, and a static import would
// close that value cycle (PORTING.md's import-cycle rule). It also keeps the
// whole FFI module out of a dedicated server's graph entirely.
function sdlMod(): typeof SdlModule {
  return require("./sdl");
}

/*
sys_linux.c's Sys_SendKeyEvents: latch the frame timestamp, then drain the
window system's event queue into Key_Event calls. With no window backend
armed the pump returns immediately and only the timestamp latch happens,
which is all the C dedicated build does too.
*/
export function Sys_SendKeyEvents(): void {
  sys_frame_time = Sys_Milliseconds();
  const sdl = sdlMod();
  if (!sdl.SDL_BackendEnabled()) return;
  sdl.SDL_PumpInput(sys_frame_time);
}
