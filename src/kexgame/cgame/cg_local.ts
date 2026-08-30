// cg_local.h (2023 Quake II re-release / "KEX" engine, 13 lines). Ported
// from ~/Projects/quake2-rerelease-dll/rerelease/cg_local.h.
//
// The C header is tiny: it `#include`s bg_local.h and declares two module
// globals shared between cg_main.cpp and cg_screen.cpp:
//   extern cgame_import_t cgi;
//   extern cgame_export_t cglobals;
// (`cglobals` itself is defined and populated in cg_main.cpp -- GetCGameAPI
// builds and returns it; cg_screen.ts has no need to reach it, so it is not
// re-exported from here.)
//
// TS has no `extern` storage-class declaration; the two functions below are
// this port's equivalent of `extern cgame_import_t cgi` -- a module-scope
// mutable slot (set exactly once, by GetCGameAPI in cg_main.ts, before any
// other cgame entry point can run) plus an accessor that throws instead of
// silently dereferencing null, mirroring g_main.ts's own "Pmove: called
// with a null pmove -- the C++ source dereferences it unconditionally here"
// precedent for "the C++ never checks this pointer, so port the failure
// mode as an explicit throw rather than an implicit crash."
//
// cgame_init_time (cg_main.cpp:17: `uint64_t cgame_init_time = 0;`) is a
// second module global read by cg_screen.cpp's CG_DrawHUD (the
// CL_InAutoDemoLoop branch) and written only by cg_main.cpp's InitCGame.
// Same module-boundary problem, same shape of fix: a private `let` plus a
// setter, so only cg_main.ts can write it while every cgame module can read
// the live binding.

import type { KexCgameImports } from "../../kexapi/game";

let cgiInstance: KexCgameImports | null = null;

/** Set once by GetCGameAPI (cg_main.ts) before any other cgame entry point
 *  runs -- mirrors `cgi = *import;` at the top of the real GetCGameAPI. */
export function setCgi(imports: KexCgameImports): void {
  cgiInstance = imports;
}

/** Accessor for the shared `cgi` import table. Throws (rather than
 *  returning null / crashing on a null dereference) if called before
 *  GetCGameAPI -- see file header. */
export function CGI(): KexCgameImports {
  if (cgiInstance === null) {
    throw new Error("kex cgame: cgi import table not initialized -- GetCGameAPI has not been called yet");
  }
  return cgiInstance;
}

/** cg_main.cpp:17: `uint64_t cgame_init_time = 0;` -- see file header. */
export let cgame_init_time = 0;

export function setCgameInitTime(t: number): void {
  cgame_init_time = t;
}
