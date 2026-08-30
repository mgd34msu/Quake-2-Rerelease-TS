// common.c -- misc functions used in client and server
//
// Qcommon_Init/Qcommon_Frame/Qcommon_Shutdown, and every FS_InitFilesystem/
// NET_/Netchan/SV_/CL_/Key_/SCR_/IN_ call inside them, are omitted per brief
// (owning module: the future src/main.ts). Z_Malloc/Z_Free/Z_TagMalloc/
// Z_FreeTags and the whole zone allocator (including the Z_Stats_f debug
// command, which reports z_bytes/z_count) are omitted per brief; call sites
// elsewhere use direct allocation instead.

import { openSync, writeSync, closeSync } from "node:fs";
import { Com_sprintf, ERR_DISCONNECT, MAX_TOKEN_CHARS, type CvarT } from "../shared/q_shared";
import { ComError, SysError, ERR_FATAL, ERR_DROP } from "./qcommon";
import { Sys_ConsoleOutput, Sys_Quit } from "../platform/sys";
import { FS_Gamedir } from "./files";
// CRC_Block lives in qcommon/crc.c, which is outside this brief's SCOPE and has
// not been ported yet (no sibling worker announced for it, unlike md4.ts).
// See report: "crc.ts" is a newly discovered missing dependency.
import { CRC_Block } from "./crc";

// Com_BlockChecksum's only call site in common.c is inside the dead `#if 0`
// block of COM_BlockSequenceCheckByte (dropped per PORTING.md's "#if 0 blocks
// are dropped silently"), so nothing here actually calls it. qcommon.h still
// declares it as part of the public surface, so it is re-exported from its
// owning module per the brief's explicit instruction.
export { Com_BlockChecksum } from "./md4";

//============================================================================
// com_argv handling

const MAX_NUM_ARGVS = 50;

let com_argc = 0;
let com_argv: string[] = [];

export function COM_Argc(): number {
  return com_argc;
}

export function COM_Argv(arg: number): string {
  if (arg < 0 || arg >= com_argc || com_argv[arg] === undefined) return "";
  return com_argv[arg];
}

export function COM_ClearArgv(arg: number): void {
  if (arg < 0 || arg >= com_argc || com_argv[arg] === undefined) return;
  com_argv[arg] = "";
}

export function COM_CheckParm(parm: string): number {
  for (let i = 1; i < com_argc; i++) {
    if (parm === com_argv[i]) return i;
  }
  return 0;
}

// C signature is COM_InitArgv(int argc, char **argv); argc is redundant once
// argv is a real JS array, so it is dropped here.
export function COM_InitArgv(argv: string[]): void {
  if (argv.length > MAX_NUM_ARGVS) {
    Com_Error(ERR_FATAL, "argc > MAX_NUM_ARGVS");
  }
  com_argc = argv.length;
  com_argv = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || a.length >= MAX_TOKEN_CHARS) com_argv[i] = "";
    else com_argv[i] = a;
  }
}

// Adds the given string at the end of the current argument list
export function COM_AddParm(parm: string): void {
  if (com_argc === MAX_NUM_ARGVS) {
    Com_Error(ERR_FATAL, "COM_AddParm: MAX_NUM)ARGS"); // sic -- typo preserved from the original
  }
  com_argv[com_argc] = parm;
  com_argc++;
}

// Z_Malloc(strlen(in)+1) + strcpy collapses to identity: JS strings are
// immutable values, not aliased buffers, so there is nothing to copy.
export function CopyString(inStr: string): string {
  return inStr;
}

//============================================================================
// CLIENT / SERVER interactions

interface RedirectState {
  target: number;
  buffer: string;
  buffersize: number;
  flush: (target: number, buffer: string) => void;
}

// C's Com_BeginRedirect takes a caller-owned `char *buffer` to accumulate
// into; here the accumulator is owned internally since JS strings cannot be
// mutated/strcat'd in place, so that parameter is dropped.
let redirect: RedirectState | null = null;

export function Com_BeginRedirect(target: number, buffersize: number, flush: (target: number, buffer: string) => void): void {
  if (!target || !buffersize || !flush) return;
  redirect = { target, buffer: "", buffersize, flush };
}

export function Com_EndRedirect(): void {
  if (!redirect) return;
  redirect.flush(redirect.target, redirect.buffer);
  redirect = null;
}

let logfile: number | null = null;

let conPrintHandler: ((msg: string) => void) | null = null;
export function SetConPrintHandler(fn: (msg: string) => void): void {
  conPrintHandler = fn;
}

// common.c calls straight into sv_main.c/cl_main.c; qcommon cannot import
// either side, so main.ts registers them (same idiom as SetConPrintHandler).
let svShutdownHandler: ((finalmsg: string, reconnect: boolean) => void) | null = null;
let clDropHandler: (() => void) | null = null;
let clShutdownHandler: (() => void) | null = null;
export function SetErrorHandlers(svShutdown: (finalmsg: string, reconnect: boolean) => void, clDrop: () => void, clShutdown?: () => void): void {
  svShutdownHandler = svShutdown;
  clDropHandler = clDrop;
  clShutdownHandler = clShutdown ?? null;
}

// sv_init.c calls the client's CL_Drop/SCR_BeginLoadingPlaque directly in
// the combined (non-dedicated) build; server modules reach them through
// these same registered handlers instead of importing the client.
let scrBeginLoadingPlaqueHandler: (() => void) | null = null;
export function SetLoadingPlaqueHandler(fn: () => void): void {
  scrBeginLoadingPlaqueHandler = fn;
}
export function SCR_BeginLoadingPlaqueHook(): void {
  if (scrBeginLoadingPlaqueHandler) scrBeginLoadingPlaqueHandler();
}
export function CL_DropHook(): void {
  if (clDropHandler) clDropHandler();
}

// common.c's `int time_before_game, time_after_game, time_before_ref,
// time_after_ref;` (qcommon.h externs them). Written from sv_main.ts and the
// renderer, read by Qcommon_Frame's host_speeds report in src/main.ts, so
// they live in a holder object rather than as `export let` bindings.
export const comTiming = {
  time_before_game: 0,
  time_after_game: 0,
  time_before_ref: 0,
  time_after_ref: 0,
};

// nothing outside this module should modify these; they are exported the way
// C exposes `cvar_t *developer;` etc. as externs -- future modules (chiefly
// the eventual Qcommon_Init in src/main.ts) are expected to Cvar_Get() into
// them, since Qcommon_Init itself is omitted from this unit.
export let host_speeds: CvarT | null = null;
export let log_stats: CvarT | null = null;
export let developer: CvarT | null = null;
export let timescale: CvarT | null = null;
export let fixedtime: CvarT | null = null;
export let logfile_active: CvarT | null = null; // 1 = buffer log, 2 = flush after each print
export let showtrace: CvarT | null = null;
export let dedicated: CvarT | null = null;

// `export let` bindings cannot be assigned from outside their module, so
// Qcommon_Init (src/main.ts) fills them through these setters -- the same
// shape src/server/server.ts already uses for setSvPaused/setMaxclients/...
export function setHostSpeeds(v: CvarT | null): void {
  host_speeds = v;
}
export function setLogStats(v: CvarT | null): void {
  log_stats = v;
}
export function setDeveloper(v: CvarT | null): void {
  developer = v;
}
export function setTimescale(v: CvarT | null): void {
  timescale = v;
}
export function setFixedtime(v: CvarT | null): void {
  fixedtime = v;
}
export function setLogfileActive(v: CvarT | null): void {
  logfile_active = v;
}
export function setShowtrace(v: CvarT | null): void {
  showtrace = v;
}
export function setDedicated(v: CvarT | null): void {
  dedicated = v;
}

// Both client and server can use this, and it will output to the apropriate place.
export function Com_Printf(fmt: string, ...args: Array<string | number>): void {
  const msg = Com_sprintf(fmt, ...args);

  if (redirect) {
    if (msg.length + redirect.buffer.length > redirect.buffersize - 1) {
      redirect.flush(redirect.target, redirect.buffer);
      redirect.buffer = "";
    }
    redirect.buffer += msg;
    return;
  }

  // console.c's Con_Print lives client-side; qcommon cannot import the
  // client, so the client registers the handler at Con_Init (the same
  // link-time-binding idiom as cmd.ts's setCmdForwardToServerHandler).
  if (conPrintHandler) conPrintHandler(msg);

  // also echo to debugging console
  Sys_ConsoleOutput(msg);

  // logfile
  if (logfile_active && logfile_active.value) {
    if (logfile === null) {
      const name = `${FS_Gamedir()}/qconsole.log`;
      logfile = openSync(name, logfile_active.value > 2 ? "a" : "w");
    }
    if (logfile !== null) {
      writeSync(logfile, msg);
    }
    // logfile_active->value > 1 forces an fflush after every print in C;
    // node:fs writeSync is already unbuffered, so there is nothing more to do.
  }
}

// A Com_Printf that only shows up if the "developer" cvar is set
export function Com_DPrintf(fmt: string, ...args: Array<string | number>): void {
  if (!developer || !developer.value) return; // don't confuse non-developers with techie stuff...

  const msg = Com_sprintf(fmt, ...args);
  Com_Printf("%s", msg);
}

let recursive = false;

// Both client and server can use this, and it will do the apropriate things.
export function Com_Error(code: number, fmt: string, ...args: Array<string | number>): never {
  const msg = Com_sprintf(fmt, ...args);

  if (recursive) {
    throw new SysError(`recursive error after: ${msg}`);
  }
  recursive = true;

  if (code === ERR_DISCONNECT) {
    if (clDropHandler) clDropHandler();
    recursive = false;
    throw new ComError(code, msg);
  } else if (code === ERR_DROP) {
    Com_Printf(`********************\nERROR: ${msg}\n********************\n`);
    // a handler that itself errors must not abort this unwind or leave the
    // recursion latch set -- C's handlers cannot longjmp, ours can throw
    try {
      if (svShutdownHandler) svShutdownHandler(`Server crashed: ${msg}\n`, false);
      if (clDropHandler) clDropHandler();
    } catch (secondary) {
      Com_Printf("Com_Error: secondary error during drop: %s\n", secondary instanceof Error ? secondary.message : String(secondary));
    } finally {
      recursive = false;
    }
    throw new ComError(code, msg);
  }

  if (svShutdownHandler) svShutdownHandler(`Server fatal crashed: ${msg}\n`, false);
  if (clShutdownHandler) clShutdownHandler();
  if (logfile !== null) {
    closeSync(logfile);
    logfile = null;
  }
  throw new SysError(msg);
}

// Both client and server can use this, and it will do the apropriate things.
export function Com_Quit(): void {
  if (svShutdownHandler) svShutdownHandler("Server quit\n", false);
  if (clShutdownHandler) clShutdownHandler();
  if (logfile !== null) {
    closeSync(logfile);
    logfile = null;
  }
  Sys_Quit();
}

let server_state = 0;

export function Com_ServerState(): number {
  return server_state;
}

export function Com_SetServerState(state: number): void {
  server_state = state;
}

//============================================================================

export function Info_Print(s: string): void {
  let i = 0;
  if (s.charAt(0) === "\\") i++;

  while (i < s.length) {
    let key = "";
    while (i < s.length && s.charAt(i) !== "\\") {
      key += s.charAt(i);
      i++;
    }

    if (key.length < 20) {
      key += " ".repeat(20 - key.length);
    }
    Com_Printf("%s", key);

    if (i >= s.length) {
      Com_Printf("MISSING VALUE\n");
      return;
    }

    i++; // skip the '\\'
    let value = "";
    while (i < s.length && s.charAt(i) !== "\\") {
      value += s.charAt(i);
      i++;
    }

    if (i < s.length) i++; // skip the trailing '\\'
    Com_Printf("%s\n", value);
  }
}

//============================================================================

// just for debugging
export function memsearch(start: Uint8Array, count: number, search: number): number {
  for (let i = 0; i < count; i++) {
    if (start[i] === search) return i;
  }
  return -1;
}

//============================================================================

// THIS IS MASSIVELY BROKEN! CHALLENGE MAY BE NEGATIVE
// DON'T USE THIS FUNCTION!!!!!
//
// The C body is entirely `#if 0`'d out after the Sys_Error() call (dropped
// per PORTING.md); Sys_Error never returns, so the dead code is unreachable
// in the original too.
export function COM_BlockSequenceCheckByte(_base: Uint8Array, _length: number, _sequence: number, _challenge: number): number {
  throw new SysError("COM_BlockSequenceCheckByte called\n");
}

// biome-ignore-file: transcribed verbatim from common.c, not hand-written
// C declares chktbl[1024] with 960 initializers; the remaining 64 bytes are
// zero-filled by C static-storage semantics, and the modulus below uses the
// FULL 1024 (sizeof - 4 = 1020). The table is padded to match.
const chktblLiterals = new Uint8Array([
  0x84, 0x47, 0x51, 0xc1, 0x93, 0x22, 0x21, 0x24, 0x2f, 0x66, 0x60, 0x4d, 0xb0, 0x7c, 0xda, 0x88, 0x54, 0x15, 0x2b, 0xc6, 0x6c, 0x89, 0xc5, 0x9d, 0x48, 0xee, 0xe6, 0x8a, 0xb5, 0xf4, 0xcb, 0xfb, 0xf1,
  0x0c, 0x2e, 0xa0, 0xd7, 0xc9, 0x1f, 0xd6, 0x06, 0x9a, 0x09, 0x41, 0x54, 0x67, 0x46, 0xc7, 0x74, 0xe3, 0xc8, 0xb6, 0x5d, 0xa6, 0x36, 0xc4, 0xab, 0x2c, 0x7e, 0x85, 0xa8, 0xa4, 0xa6, 0x4d, 0x96, 0x19,
  0x19, 0x9a, 0xcc, 0xd8, 0xac, 0x39, 0x5e, 0x3c, 0xf2, 0xf5, 0x5a, 0x72, 0xe5, 0xa9, 0xd1, 0xb3, 0x23, 0x82, 0x6f, 0x29, 0xcb, 0xd1, 0xcc, 0x71, 0xfb, 0xea, 0x92, 0xeb, 0x1c, 0xca, 0x4c, 0x70, 0xfe,
  0x4d, 0xc9, 0x67, 0x43, 0x47, 0x94, 0xb9, 0x47, 0xbc, 0x3f, 0x01, 0xab, 0x7b, 0xa6, 0xe2, 0x76, 0xef, 0x5a, 0x7a, 0x29, 0x0b, 0x51, 0x54, 0x67, 0xd8, 0x1c, 0x14, 0x3e, 0x29, 0xec, 0xe9, 0x2d, 0x48,
  0x67, 0xff, 0xed, 0x54, 0x4f, 0x48, 0xc0, 0xaa, 0x61, 0xf7, 0x78, 0x12, 0x03, 0x7a, 0x9e, 0x8b, 0xcf, 0x83, 0x7b, 0xae, 0xca, 0x7b, 0xd9, 0xe9, 0x53, 0x2a, 0xeb, 0xd2, 0xd8, 0xcd, 0xa3, 0x10, 0x25,
  0x78, 0x5a, 0xb5, 0x23, 0x06, 0x93, 0xb7, 0x84, 0xd2, 0xbd, 0x96, 0x75, 0xa5, 0x5e, 0xcf, 0x4e, 0xe9, 0x50, 0xa1, 0xe6, 0x9d, 0xb1, 0xe3, 0x85, 0x66, 0x28, 0x4e, 0x43, 0xdc, 0x6e, 0xbb, 0x33, 0x9e,
  0xf3, 0x0d, 0x00, 0xc1, 0xcf, 0x67, 0x34, 0x06, 0x7c, 0x71, 0xe3, 0x63, 0xb7, 0xb7, 0xdf, 0x92, 0xc4, 0xc2, 0x25, 0x5c, 0xff, 0xc3, 0x6e, 0xfc, 0xaa, 0x1e, 0x2a, 0x48, 0x11, 0x1c, 0x36, 0x68, 0x78,
  0x86, 0x79, 0x30, 0xc3, 0xd6, 0xde, 0xbc, 0x3a, 0x2a, 0x6d, 0x1e, 0x46, 0xdd, 0xe0, 0x80, 0x1e, 0x44, 0x3b, 0x6f, 0xaf, 0x31, 0xda, 0xa2, 0xbd, 0x77, 0x06, 0x56, 0xc0, 0xb7, 0x92, 0x4b, 0x37, 0xc0,
  0xfc, 0xc2, 0xd5, 0xfb, 0xa8, 0xda, 0xf5, 0x57, 0xa8, 0x18, 0xc0, 0xdf, 0xe7, 0xaa, 0x2a, 0xe0, 0x7c, 0x6f, 0x77, 0xb1, 0x26, 0xba, 0xf9, 0x2e, 0x1d, 0x16, 0xcb, 0xb8, 0xa2, 0x44, 0xd5, 0x2f, 0x1a,
  0x79, 0x74, 0x87, 0x4b, 0x00, 0xc9, 0x4a, 0x3a, 0x65, 0x8f, 0xe6, 0x5d, 0xe5, 0x0a, 0x77, 0xd8, 0x1a, 0x14, 0x41, 0x75, 0xb1, 0xe2, 0x50, 0x2c, 0x93, 0x38, 0x2b, 0x6d, 0xf3, 0xf6, 0xdb, 0x1f, 0xcd,
  0xff, 0x14, 0x70, 0xe7, 0x16, 0xe8, 0x3d, 0xf0, 0xe3, 0xbc, 0x5e, 0xb6, 0x3f, 0xcc, 0x81, 0x24, 0x67, 0xf3, 0x97, 0x3b, 0xfe, 0x3a, 0x96, 0x85, 0xdf, 0xe4, 0x6e, 0x3c, 0x85, 0x05, 0x0e, 0xa3, 0x2b,
  0x07, 0xc8, 0xbf, 0xe5, 0x13, 0x82, 0x62, 0x08, 0x61, 0x69, 0x4b, 0x47, 0x62, 0x73, 0x44, 0x64, 0x8e, 0xe2, 0x91, 0xa6, 0x9a, 0xb7, 0xe9, 0x04, 0xb6, 0x54, 0x0c, 0xc5, 0xa9, 0x47, 0xa6, 0xc9, 0x08,
  0xfe, 0x4e, 0xa6, 0xcc, 0x8a, 0x5b, 0x90, 0x6f, 0x2b, 0x3f, 0xb6, 0x0a, 0x96, 0xc0, 0x78, 0x58, 0x3c, 0x76, 0x6d, 0x94, 0x1a, 0xe4, 0x4e, 0xb8, 0x38, 0xbb, 0xf5, 0xeb, 0x29, 0xd8, 0xb0, 0xf3, 0x15,
  0x1e, 0x99, 0x96, 0x3c, 0x5d, 0x63, 0xd5, 0xb1, 0xad, 0x52, 0xb8, 0x55, 0x70, 0x75, 0x3e, 0x1a, 0xd5, 0xda, 0xf6, 0x7a, 0x48, 0x7d, 0x44, 0x41, 0xf9, 0x11, 0xce, 0xd7, 0xca, 0xa5, 0x3d, 0x7a, 0x79,
  0x7e, 0x7d, 0x25, 0x1b, 0x77, 0xbc, 0xf7, 0xc7, 0x0f, 0x84, 0x95, 0x10, 0x92, 0x67, 0x15, 0x11, 0x5a, 0x5e, 0x41, 0x66, 0x0f, 0x38, 0x03, 0xb2, 0xf1, 0x5d, 0xf8, 0xab, 0xc0, 0x02, 0x76, 0x84, 0x28,
  0xf4, 0x9d, 0x56, 0x46, 0x60, 0x20, 0xdb, 0x68, 0xa7, 0xbb, 0xee, 0xac, 0x15, 0x01, 0x2f, 0x20, 0x09, 0xdb, 0xc0, 0x16, 0xa1, 0x89, 0xf9, 0x94, 0x59, 0x00, 0xc1, 0x76, 0xbf, 0xc1, 0x4d, 0x5d, 0x2d,
  0xa9, 0x85, 0x2c, 0xd6, 0xd3, 0x14, 0xcc, 0x02, 0xc3, 0xc2, 0xfa, 0x6b, 0xb7, 0xa6, 0xef, 0xdd, 0x12, 0x26, 0xa4, 0x63, 0xe3, 0x62, 0xbd, 0x56, 0x8a, 0x52, 0x2b, 0xb9, 0xdf, 0x09, 0xbc, 0x0e, 0x97,
  0xa9, 0xb0, 0x82, 0x46, 0x08, 0xd5, 0x1a, 0x8e, 0x1b, 0xa7, 0x90, 0x98, 0xb9, 0xbb, 0x3c, 0x17, 0x9a, 0xf2, 0x82, 0xba, 0x64, 0x0a, 0x7f, 0xca, 0x5a, 0x8c, 0x7c, 0xd3, 0x79, 0x09, 0x5b, 0x26, 0xbb,
  0xbd, 0x25, 0xdf, 0x3d, 0x6f, 0x9a, 0x8f, 0xee, 0x21, 0x66, 0xb0, 0x8d, 0x84, 0x4c, 0x91, 0x45, 0xd4, 0x77, 0x4f, 0xb3, 0x8c, 0xbc, 0xa8, 0x99, 0xaa, 0x19, 0x53, 0x7c, 0x02, 0x87, 0xbb, 0x0b, 0x7c,
  0x1a, 0x2d, 0xdf, 0x48, 0x44, 0x06, 0xd6, 0x7d, 0x0c, 0x2d, 0x35, 0x76, 0xae, 0xc4, 0x5f, 0x71, 0x85, 0x97, 0xc4, 0x3d, 0xef, 0x52, 0xbe, 0x00, 0xe4, 0xcd, 0x49, 0xd1, 0xd1, 0x1c, 0x3c, 0xd0, 0x1c,
  0x42, 0xaf, 0xd4, 0xbd, 0x58, 0x34, 0x07, 0x32, 0xee, 0xb9, 0xb5, 0xea, 0xff, 0xd7, 0x8c, 0x0d, 0x2e, 0x2f, 0xaf, 0x87, 0xbb, 0xe6, 0x52, 0x71, 0x22, 0xf5, 0x25, 0x17, 0xa1, 0x82, 0x04, 0xc2, 0x4a,
  0xbd, 0x57, 0xc6, 0xab, 0xc8, 0x35, 0x0c, 0x3c, 0xd9, 0xc2, 0x43, 0xdb, 0x27, 0x92, 0xcf, 0xb8, 0x25, 0x60, 0xfa, 0x21, 0x3b, 0x04, 0x52, 0xc8, 0x96, 0xba, 0x74, 0xe3, 0x67, 0x3e, 0x8e, 0x8d, 0x61,
  0x90, 0x92, 0x59, 0xb6, 0x1a, 0x1c, 0x5e, 0x21, 0xc1, 0x65, 0xe5, 0xa6, 0x34, 0x05, 0x6f, 0xc5, 0x60, 0xb1, 0x83, 0xc1, 0xd5, 0xd5, 0xed, 0xd9, 0xc7, 0x11, 0x7b, 0x49, 0x7a, 0xf9, 0xf9, 0x84, 0x47,
  0x9b, 0xe2, 0xa5, 0x82, 0xe0, 0xc2, 0x88, 0xd0, 0xb2, 0x58, 0x88, 0x7f, 0x45, 0x09, 0x67, 0x74, 0x61, 0xbf, 0xe6, 0x40, 0xe2, 0x9d, 0xc2, 0x47, 0x05, 0x89, 0xed, 0xcb, 0xbb, 0xb7, 0x27, 0xe7, 0xdc,
  0x7a, 0xfd, 0xbf, 0xa8, 0xd0, 0xaa, 0x10, 0x39, 0x3c, 0x20, 0xf0, 0xd3, 0x6e, 0xb1, 0x72, 0xf8, 0xe6, 0x0f, 0xef, 0x37, 0xe5, 0x09, 0x33, 0x5a, 0x83, 0x43, 0x80, 0x4f, 0x65, 0x2f, 0x7c, 0x8c, 0x6a,
  0xa0, 0x82, 0x0c, 0xd4, 0xd4, 0xfa, 0x81, 0x60, 0x3d, 0xdf, 0x06, 0xf1, 0x5f, 0x08, 0x0d, 0x6d, 0x43, 0xf2, 0xe3, 0x11, 0x7d, 0x80, 0x32, 0xc5, 0xfb, 0xc5, 0xd9, 0x27, 0xec, 0xc6, 0x4e, 0x65, 0x27,
  0x76, 0x87, 0xa6, 0xee, 0xee, 0xd7, 0x8b, 0xd1, 0xa0, 0x5c, 0xb0, 0x42, 0x13, 0x0e, 0x95, 0x4a, 0xf2, 0x06, 0xc6, 0x43, 0x33, 0xf4, 0xc7, 0xf8, 0xe7, 0x1f, 0xdd, 0xe4, 0x46, 0x4a, 0x70, 0x39, 0x6c,
  0xd0, 0xed, 0xca, 0xbe, 0x60, 0x3b, 0xd1, 0x7b, 0x57, 0x48, 0xe5, 0x3a, 0x79, 0xc1, 0x69, 0x33, 0x53, 0x1b, 0x80, 0xb8, 0x91, 0x7d, 0xb4, 0xf6, 0x17, 0x1a, 0x1d, 0x5a, 0x32, 0xd6, 0xcc, 0x71, 0x29,
  0x3f, 0x28, 0xbb, 0xf3, 0x5e, 0x71, 0xb8, 0x43, 0xaf, 0xf8, 0xb9, 0x64, 0xef, 0xc4, 0xa5, 0x6c, 0x08, 0x53, 0xc7, 0x00, 0x10, 0x39, 0x4f, 0xdd, 0xe4, 0xb6, 0x19, 0x27, 0xfb, 0xb8, 0xf5, 0x32, 0x73,
  0xe5, 0xcb, 0x32,
]);
const chktbl = new Uint8Array(1024);
chktbl.set(chktblLiterals);

// For proxy protecting
export function COM_BlockSequenceCRCByte(base: Uint8Array, length: number, sequence: number): number {
  if (sequence < 0) {
    throw new SysError("sequence < 0, this shouldn't happen\n");
  }

  const pOffset = sequence % (chktbl.length - 4);

  let len = length;
  if (len > 60) len = 60;

  const chkb = new Uint8Array(60 + 4);
  chkb.set(base.subarray(0, len), 0);

  chkb[len] = chktbl[pOffset];
  chkb[len + 1] = chktbl[pOffset + 1];
  chkb[len + 2] = chktbl[pOffset + 2];
  chkb[len + 3] = chktbl[pOffset + 3];

  len += 4;

  let crc = CRC_Block(chkb.subarray(0, len), len);

  let x = 0;
  for (let n = 0; n < len; n++) x += chkb[n];

  crc = (crc ^ x) & 0xff;

  return crc;
}

//========================================================

export function frand(): number {
  return (Math.floor(Math.random() * 32768) & 32767) * (1.0 / 32767);
}

export function crand(): number {
  return ((Math.floor(Math.random() * 32768) & 32767) * (2.0 / 32767)) - 1;
}
