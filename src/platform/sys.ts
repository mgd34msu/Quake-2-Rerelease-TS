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

/*
q2repro's per-platform "homedir" default (the per-user directory that
shadows basedir for writes -- see files.ts's FS_InitFilesystem for the
consumer). Both reference implementations resolve to the empty string for
this port's deployment shape:

- src/unix/system.c:195-208 (Sys_Init) tilde-expands a build-time HOMEDIR
  macro against $HOME, but meson.build:318 only sets that macro to a
  non-empty value ('~/.q2pro', meson_options.txt:52-55) when the build was
  configured with `-Dsystem-wide=true` (meson.build:321-326); the ordinary
  build HOMEDIR resolves to '', so Sys_Init registers "homedir" CVAR_NOSET
  with an empty default (src/unix/system.c:210).
- src/windows/system.c:955 registers "homedir" CVAR_NOSET with a literal ""
  default unconditionally -- there is no meson-configured HOMEDIR macro on
  Windows at all (meson.build:702-705 only sets HOMEDIR `if not win32`).
  Windows' only non-empty default comes from FS_FindBaseDir's Windows-only
  rerelease-mode branch (src/common/files.c:3999-4003), which calls
  Sys_GetRereleaseHomeDir (src/windows/system.c:1291-1312) to redirect to
  the OS "Saved Games\NightDive Studios\Quake II" folder via
  SHGetKnownFolderPath(FOLDERID_SavedGames) -- reached only after first
  detecting an actual Steam/GOG-installed rerelease package
  (gamepath_funcs, windows/system.c:1281-1287). This port has no
  "-Dsystem-wide" build variant (there's exactly one Bun runtime shape) and
  no Steam/GOG/Xbox installation-detection layer, so neither reference
  platform's non-empty branch applies here -- the faithfully-ported default
  for THIS deployment shape is "" on every platform bun runs on, same as
  q2repro's own ordinary (non-packaged) build produces on both of its
  platforms.

files.ts's FS_InitFilesystem gates all homedir shadowing/write-redirection
behind this string being non-empty (mirrors q2repro's
`sys_homedir->string[0]` checks throughout files.c), so an empty default
here means today's basedir-only behavior is preserved exactly until
something explicitly sets the "homedir" cvar (there is presently no
`-homedir`/`+set homedir` wiring at boot; that is a follow-up, tracked in
.orch/followups.md, not bundled into this default-resolution function).
*/
export function Sys_GetDefaultHomedir(): string {
  return "";
}
