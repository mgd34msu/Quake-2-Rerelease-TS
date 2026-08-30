// common.c -- Qcommon_Init / Qcommon_Frame / Qcommon_Shutdown, which
// src/qcommon/common.ts deliberately left to this module (see its header
// comment), plus the dedicated-server main() loop from linux/sys_linux.c.
//
// This build takes the C `#ifndef DEDICATED_ONLY` branch: `dedicated` is
// registered with a default of "0" and the client subsystems are the real
// ones (src/client/*). src/null/cl_null.ts is the DEDICATED_ONLY branch's
// alternative and stays unreferenced, the way the C makefile leaves it out
// of a full client build. A dedicated server is `+set dedicated 1`, at
// which point CL_Init/CL_Frame return immediately on their own cvar guards,
// exactly as they do in C.
//
// SDL_SetBackendEnabled arms src/platform/sdl.ts on the client path only:
// nothing in the port opens libSDL2 until it is armed, so a dedicated
// server never needs the library to be installed.
//
// Omitted from Qcommon_Init, with reasons:
//   z_chain re-init / Cmd_AddCommand("z_stats", Z_Stats_f) -- the zone
//     allocator is omitted from common.ts per PORTING.md's Z_Malloc rule.
//   Swap_Init() -- little-endian is the only path this port takes
//     (PORTING.md's #ifdef BIG_ENDIAN rule); qcommon.ts's BigShort/LittleShort
//     are already fixed at their little-endian meanings.
//   Sys_Init() -- src/platform/sys.ts has no such entry point; the C bodies
//     are FPU/console setup that bun does not need.
//   __DATE__ in the version string -- a C preprocessor compile-time constant
//     with no bun equivalent.

import { CVAR_NOSET, CVAR_SERVERINFO, Com_sprintf } from "./shared/q_shared";
import { ComError, ERR_FATAL, VERSION, CPUSTRING, BUILDSTRING } from "./qcommon/qcommon";
import { SetErrorHandlers, SetLoadingPlaqueHandler,
  COM_InitArgv,
  Com_Printf,
  Com_Error,
  Com_Quit,
  comTiming,
  dedicated,
  fixedtime,
  host_speeds,
  log_stats,
  showtrace,
  timescale,
  setDedicated,
  setDeveloper,
  setFixedtime,
  setHostSpeeds,
  setLogStats,
  setLogfileActive,
  setShowtrace,
  setTimescale,
} from "./qcommon/common";
import {
  Cbuf_AddEarlyCommands,
  Cbuf_AddLateCommands,
  Cbuf_AddText,
  Cbuf_Execute,
  Cbuf_Init,
  Cmd_AddCommand,
  Cmd_Argv,
  Cmd_Init,
  setCmdForwardToServerHandler,
} from "./qcommon/cmd";
import { Cvar_Get, Cvar_Init } from "./qcommon/cvar";
import { FS_InitFilesystem } from "./qcommon/files";
import { c_pointcontents, c_traces, resetTraceCounters } from "./qcommon/cmodel";
import { Netchan_Init } from "./qcommon/net_chan";
import { NET_Init } from "./platform/net_udp";
import { Sys_ConsoleInput, Sys_Error, Sys_Milliseconds } from "./platform/sys";
import { SV_Frame, SV_Init, SV_Shutdown } from "./server/sv_main";
import { CL_Drop, CL_Frame, CL_Init, CL_Shutdown, Cmd_ForwardToServer } from "./client/cl_main";
import { SCR_BeginLoadingPlaque } from "./client/cl_scrn";
import { Key_Init } from "./client/keys_impl";
import { SCR_EndLoadingPlaque } from "./client/cl_scrn";
import { SDL_SetBackendEnabled } from "./platform/sdl";

// common.c's Com_Error_f lives beside Com_Error there; common.ts omitted the
// whole Qcommon_Init block, so its one and only registration point is here.
function Com_Error_f(): void {
  Com_Error(ERR_FATAL, "%s", Cmd_Argv(1));
}

/*
=================
Qcommon_Init
=================
*/
export function Qcommon_Init(argv: string[]): void {
  try {
    // prepare enough of the subsystems to handle
    // cvar and command buffer management
    COM_InitArgv(argv);

    Cbuf_Init();

    Cmd_Init();
    Cvar_Init();

    // cmd.c forward-declares Cmd_ForwardToServer and cl_null.c defines it;
    // cmd.ts models that link-time binding as a registrable hook.
    setCmdForwardToServerHandler(Cmd_ForwardToServer);
    SetErrorHandlers(SV_Shutdown, CL_Drop, CL_Shutdown);
    SetLoadingPlaqueHandler(SCR_BeginLoadingPlaque);

    Key_Init();

    // we need to add the early commands twice, because
    // a basedir or cddir needs to be set before execing
    // config files, but we want other parms to override
    // the settings of the config files
    Cbuf_AddEarlyCommands(false);
    Cbuf_Execute();

    FS_InitFilesystem();

    Cbuf_AddText("exec default.cfg\n");
    Cbuf_AddText("exec config.cfg\n");

    Cbuf_AddEarlyCommands(true);
    Cbuf_Execute();

    //
    // init commands and vars
    //
    Cmd_AddCommand("error", Com_Error_f);

    setHostSpeeds(Cvar_Get("host_speeds", "0", 0));
    setLogStats(Cvar_Get("log_stats", "0", 0));
    setDeveloper(Cvar_Get("developer", "0", 0));
    setTimescale(Cvar_Get("timescale", "1", 0));
    setFixedtime(Cvar_Get("fixedtime", "0", 0));
    setLogfileActive(Cvar_Get("logfile", "0", 0));
    setShowtrace(Cvar_Get("showtrace", "0", 0));
    setDedicated(Cvar_Get("dedicated", "0", CVAR_NOSET));

    // arm the windowing/input/audio backend before CL_Init reaches VID_Init
    if (dedicated && !dedicated.value) SDL_SetBackendEnabled(true);

    const s = Com_sprintf("%4.2f %s %s", VERSION, CPUSTRING, BUILDSTRING);
    Cvar_Get("version", s, CVAR_SERVERINFO | CVAR_NOSET);

    if (dedicated && dedicated.value) Cmd_AddCommand("quit", Com_Quit);

    NET_Init();
    Netchan_Init();

    SV_Init();
    CL_Init();

    // add + commands from command line
    if (!Cbuf_AddLateCommands()) {
      // if the user didn't give any commands, run default action
      if (dedicated && !dedicated.value) Cbuf_AddText("d1\n");
      else Cbuf_AddText("dedicated_start\n");
      Cbuf_Execute();
    } else {
      // the user asked for something explicit
      // so drop the loading plaque
      SCR_EndLoadingPlaque();
    }

    Com_Printf("====== Quake2 Initialized ======\n\n");
  } catch (err) {
    if (err instanceof ComError) {
      Sys_Error("Error during initialization");
    }
    throw err;
  }
}

/*
=================
Qcommon_Frame
=================
*/
export function Qcommon_Frame(msec: number): void {
  try {
    if (log_stats && log_stats.modified) {
      log_stats.modified = false;
      // The fopen("stats.log")/fclose pair and its "entities,dlights,parts,
      // frame time" header are dropped: the only writer of log_stats_file is
      // the renderer (ref_gl/ref_soft R_RenderFrame), which this dedicated
      // build does not link. Clearing `modified` keeps the cvar's own
      // behaviour intact.
    }

    let time = msec;
    if (fixedtime && fixedtime.value) {
      time = fixedtime.value;
    } else if (timescale && timescale.value) {
      time *= timescale.value;
      if (time < 1) time = 1;
    }

    if (showtrace && showtrace.value) {
      Com_Printf("%4i traces  %4i points\n", c_traces, c_pointcontents);
      resetTraceCounters();
    }

    let s = Sys_ConsoleInput();
    while (s !== null) {
      Cbuf_AddText(`${s}\n`);
      s = Sys_ConsoleInput();
    }
    Cbuf_Execute();

    let time_before = 0;
    let time_between = 0;
    let time_after = 0;

    if (host_speeds && host_speeds.value) time_before = Sys_Milliseconds();

    SV_Frame(time);

    if (host_speeds && host_speeds.value) time_between = Sys_Milliseconds();

    CL_Frame(time);

    if (host_speeds && host_speeds.value) time_after = Sys_Milliseconds();

    if (host_speeds && host_speeds.value) {
      const all = time_after - time_before;
      let sv = time_between - time_before;
      let cl = time_after - time_between;
      const gm = comTiming.time_after_game - comTiming.time_before_game;
      const rf = comTiming.time_after_ref - comTiming.time_before_ref;
      sv -= gm;
      cl -= rf;
      Com_Printf("all:%3i sv:%3i gm:%3i cl:%3i rf:%3i\n", all, sv, gm, cl, rf);
    }
  } catch (err) {
    if (err instanceof ComError) return; // an ERR_DROP was thrown
    throw err;
  }
}

/*
=================
Qcommon_Shutdown
=================
*/
export function Qcommon_Shutdown(): void {}

// Synchronous frame driver, so an embedder (a test, a future tool) can step
// the server without owning the process's event loop the way main() does.
export function runFrames(count: number, msec: number): void {
  for (let i = 0; i < count; i++) Qcommon_Frame(msec);
}

/*
main -- linux/sys_linux.c's dedicated entry point.

The C loop spins on Sys_Milliseconds until at least one whole millisecond has
elapsed, then calls Qcommon_Frame with the measured delta. A spin here would
never yield, so Bun's UDP receive callbacks could not enqueue packets and
NET_Config's socket bind could not settle; `await Bun.sleep(1)` replaces the
spin, keeping the same "at least 1 ms per frame, delta-timed" semantics while
handing the event loop back on every iteration.

Also dropped from sys_linux.c's main: the fcntl(0, FNDELAY) non-blocking
stdin setup and the `nostdout` cvar, both of which belong to
src/platform/sys.ts's Sys_ConsoleInput/Sys_ConsoleOutput.
*/
export async function main(): Promise<void> {
  // Qcommon_Init is async (socket binds, file loads); entering the frame
  // loop before it settles races half-initialized subsystems.
  await Qcommon_Init(process.argv.slice(1));

  let oldtime = Sys_Milliseconds();
  for (;;) {
    // find time spent rendering last frame
    let newtime = oldtime;
    let time = 0;
    do {
      await Bun.sleep(1);
      newtime = Sys_Milliseconds();
      time = newtime - oldtime;
    } while (time < 1);
    Qcommon_Frame(time);
    oldtime = newtime;
  }
}

if (import.meta.main) {
  await main();
}
