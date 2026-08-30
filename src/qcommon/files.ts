// files.c -- QUAKE FILESYSTEM
//
// All of Quake's data access is through a hierchal file system, but the
// contents of the file system can be transparently merged from several
// sources. The "base directory" is the path to the directory holding the
// quake.exe and all game directories (fs_basedir, overridable with the
// "-basedir" command line parm via the "basedir" cvar). The "game directory"
// is the first tree on the search path and the directory that all generated
// files (savegames, screenshots, demos, config files) will be saved to
// (overridable with "-game"/the "game" cvar). The game directory can never
// be changed while quake is executing.
//
// Notes on this port:
// - FILE* handles become fd numbers from node:fs, tracked in fs_open_handles
//   with an explicit read cursor (position) per handle rather than relying on
//   the fd's own OS-level offset, since node's readSync takes an explicit
//   position argument. This is the "open-handle object" shape PORTING.md's
//   brief calls for.
// - searchpath_t's "only one of filename / pack will be used" comment becomes
//   a discriminated union (SearchPathT) instead of two co-resident nullable
//   fields, so every read site is narrowed by `kind` rather than by a
//   non-null assumption.
// - dpackheader_t/dpackfile_t (qfiles.h) are defined locally below: the
//   qfiles.h port (src/qcommon/qfiles.ts per PORTING.md's mapping table) has
//   not landed yet, and this brief's SCOPE does not include creating it.
// - Sys_Mkdir/Sys_FindFirst/Sys_FindNext/Sys_FindClose (linux/win32 sys_*.c)
//   are declared in q_shared.ts's comments as a future src/platform/sys.ts
//   addition, but are not implemented there yet, and adding them is outside
//   this brief's SCOPE (files.ts and test/files.test.ts only). Every call
//   site that used them here (FS_ExecAutoexec's existence check, FS_ListFiles'
//   directory enumeration, FS_CreatePath's mkdir) uses node:fs directly
//   instead, per PORTING.md's "File I/O: node:fs sync calls inside
//   src/platform and src/qcommon/files.ts only" -- files.ts is an allowed
//   direct fs user. Attribute-based filtering (SFF_SUBDIR/SFF_HIDDEN/...,
//   used by client/menu.c's FS_ListFiles calls) has no portable node:fs
//   equivalent wired up here; FS_ListFiles' musthave/canthave parameters are
//   dropped since every call site in this brief's scope (FS_Dir_f) passes
//   0/0. Owner for wiring real attribute filtering: whoever ports
//   src/platform/sys.ts's Sys_FindFirst/Next and src/client/menu.c.
// - CD-ROM handling (FS_Read's CDAudio_Stop() retry-kick and the cddir
//   concept's original motivation) is client code not yet ported; the
//   retry-once-then-fail control flow is kept, only the CDAudio_Stop() call
//   itself is dropped (owning module: src/client/cl_cin.ts). WIN32-only
//   branches (FS_ListFiles' strlwr under _WIN32) are dropped per PORTING.md's
//   "take the portable path" rule.
// - Write primitives (FS_WriteFile/FS_RemoveFile/FS_ReadRawFile/
//   FS_FOpenFileWrite/FS_Write) were added after the initial port to unblock
//   sv_ccmds.ts/g_svcmds.ts/sv_ents.ts call sites that previously had to
//   defer with a logged no-op. FS_ReadRawFile/FS_FOpenFileWrite/FS_WriteFile
//   take a literal on-disk path (as fopen() does) rather than resolving
//   through fs_links/fs_searchpaths/pak files the way FS_FOpenFile does --
//   every call site for these (savegame files, listip.cfg, demo files)
//   already builds a fully-qualified path off FS_Gamedir() itself, exactly
//   as the C originals' fopen(name, "wb")/fopen(src, "rb") do.

import { openSync, closeSync, readSync, writeSync, writeFileSync, unlinkSync, fstatSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { type CvarT, CVAR_NOSET, CVAR_LATCH, CVAR_SERVERINFO, Q_strcasecmp } from "../shared/q_shared";
import { Com_Error, Com_Printf, Com_DPrintf, dedicated } from "./common";
import { ERR_FATAL, BASEDIRNAME } from "./qcommon";
import type * as CvarModule from "./cvar";
import type * as CmdModule from "./cmd";
import type * as LocModule from "./loc";

// cvar.ts and cmd.ts are reached lazily (via Bun's synchronous require, not a
// static top-level import) rather than statically imported here. cmd.ts's
// own module body runs `const cmd_text = new SizeBuf();` at its top level,
// and sizebuf.ts (SizeBuf's home module) itself imports Com_Printf from
// common.ts; a *static* files.ts -> cvar.ts/cmd.ts edge closes the cycle
// sizebuf -> common -> files -> cvar/cmd -> sizebuf, which reaches cmd.ts's
// top-level `new SizeBuf()` before sizebuf.ts's own class declaration has
// run, throwing "Cannot access 'SizeBuf' before initialization". None of
// cmd.ts/cvar.ts/sizebuf.ts/common.ts are in this brief's SCOPE to fix
// directly, so the edge is made lazy here instead: every call below happens
// from inside a function body (never at files.ts's own module top level), by
// which point the whole module graph has long since finished loading via its
// own natural (working) static paths, so the lazy require just returns the
// same cached module. `import type` above is compile-time only (erased),
// so it adds no runtime edge.
//
// loc.ts joins this list for the same structural reason: it statically
// imports Cvar_Get from cvar.ts, so a static files.ts -> loc.ts edge would
// recreate the identical files.ts -> cvar.ts -> cmd.ts -> sizebuf.ts ->
// common.ts -> files.ts cycle one hop further out.
function cvarMod(): typeof CvarModule {
  return require("./cvar");
}
function cmdMod(): typeof CmdModule {
  return require("./cmd");
}
function locMod(): typeof LocModule {
  return require("./loc");
}

//=============================================================================
// qfiles.h -- the .pak files are just a linear collapse of a directory tree.
// See header comment: defined here, not in a qfiles.ts, since that module
// has not landed.

const IDPAKHEADER = 0x4b434150; // little-endian on-disk bytes 'P','A','C','K'
const MAX_FILES_IN_PACK = 4096;
const PACKFILE_NAME_LEN = 56;
const DPACKFILE_SIZE = PACKFILE_NAME_LEN + 4 + 4; // name + filepos + filelen

//=============================================================================
// in memory

interface PackFileT {
  name: string;
  filepos: number;
  filelen: number;
}

interface PackT {
  filename: string;
  handle: number; // fd; kept open for the lifetime of the pack, matching
  // pack_t.handle in the original -- opened once here, only ever closed when
  // FS_SetGamedir frees the searchpath (reads reopen their own fd, see
  // FS_FOpenFile, exactly as fopen(pak->filename) does in the C version)
  numfiles: number;
  files: PackFileT[];
}

// "only one of filename / pack will be used" (searchpath_t's C comment)
// becomes a discriminated union instead of two co-resident nullable fields.
type SearchPathT = { readonly kind: "dir"; filename: string; next: SearchPathT | null } | { readonly kind: "pack"; pack: PackT; next: SearchPathT | null };

interface FileLinkT {
  from: string;
  fromlength: number;
  to: string;
  next: FileLinkT | null;
}

let fs_gamedir = "";
export let fs_basedir: CvarT | null = null;
export let fs_cddir: CvarT | null = null;
export let fs_gamedirvar: CvarT | null = null;

let fs_links: FileLinkT | null = null;

let fs_searchpaths: SearchPathT | null = null;
let fs_base_searchpaths: SearchPathT | null = null; // without gamedirs

function basedirString(): string {
  // fs_basedir is only null before FS_InitFilesystem's Cvar_Get runs; "."
  // mirrors the cvar's own default value in that window.
  return fs_basedir ? fs_basedir.string : ".";
}

//=============================================================================
// open file handles -- stands in for the C FILE* returned by fopen()/passed
// around as FS_FOpenFile's out-parameter.

interface OpenHandleT {
  fd: number;
  position: number; // explicit read cursor; node's readSync takes an
  // explicit position rather than relying on the fd's own offset
}

const fs_open_handles = new Map<number, OpenHandleT>();
let fs_next_handle = 1;

// ZOID: did the file come from a pak? (extern'd by server/sv_user.c, a
// future unit, to refuse "maps/" downloads sourced from a pak file)
export let file_from_pak = 0;

//=============================================================================

function hasStringCode(err: object): err is { code: unknown } {
  return "code" in err;
}

function errnoCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && hasStringCode(err) && typeof err.code === "string") {
    return err.code;
  }
  return null;
}

/*
================
FS_CreatePath

Creates any directories needed to store the given filename
================
*/
export function FS_CreatePath(path: string): void {
  for (let i = 1; i < path.length; i++) {
    if (path[i] !== "/") continue;
    const dir = path.slice(0, i);
    try {
      mkdirSync(dir);
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
    }
  }
}

/*
==============
FS_WriteFile

Writes data to a file relative to the quake search path (the caller
supplies the full on-disk path, typically built from FS_Gamedir()), creating
any missing parent directories first (FS_CreatePath semantics). Stands in
for the C idiom `fopen(name, "wb"); fwrite(...); fclose();` for callers that
just need to dump a whole buffer at once (savegame files, config dumps) --
see FS_FOpenFileWrite/FS_Write below for the streaming/append case.
==============
*/
export function FS_WriteFile(path: string, data: Uint8Array | string): void {
  FS_CreatePath(path);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  writeFileSync(path, bytes);
}

/*
==============
FS_RemoveFile

Stands in for the C `remove()` calls (SV_WipeSavegame's server.ssv/game.ssv/
*.sav/*.sv2 cleanup); like `remove()`, a missing file is not an error.
==============
*/
export function FS_RemoveFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

/*
==============
FS_ReadRawFile

Reads a literal on-disk path directly (no fs_links/fs_searchpaths/pak
lookup), returning null on any open failure. Stands in for the C idiom
`fopen(path, "rb")` used by call sites (CopyFile) that already hold a
fully-qualified filesystem path (typically built from FS_Gamedir()) rather
than a filename to resolve through the virtual quake search path -- the
same distinction FS_WriteFile/FS_FOpenFileWrite draw on the write side.
==============
*/
export function FS_ReadRawFile(path: string): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  const size = fstatSync(fd).size;
  const buf = new Uint8Array(size);
  readSync(fd, buf, 0, size, 0);
  closeSync(fd);
  return buf;
}

/*
==============
FS_FOpenFileWrite

Opens (creating/truncating) a literal on-disk path for writing, creating any
missing parent directories first, and returns a handle from the same
fs_open_handles table FS_FOpenFile/FS_Read/FS_FCloseFile use -- callers that
need to stream writes across multiple calls (SV_ServerRecord_f's demo file,
read back a chunk at a time by FS_Write below) get an open handle rather
than a whole-buffer FS_WriteFile call. Returns null on failure, matching
fopen(name, "wb") returning NULL.
==============
*/
/*
================
FS_filelength
================
*/
export function FS_filelength(handle: number): number {
  // C: ftell/fseek(END)/fseek(back); node exposes the same via fstat
  return fstatSync(handle).size;
}

export function FS_FOpenFileWrite(path: string): number | null {
  FS_CreatePath(path);
  let fd: number;
  try {
    fd = openSync(path, "w");
  } catch {
    return null;
  }
  const handle = fs_next_handle++;
  fs_open_handles.set(handle, { fd, position: 0 });
  return handle;
}

/*
==============
FS_Write

Writes len bytes from buffer to the given open handle (as returned by
FS_FOpenFileWrite), advancing that handle's write cursor. Mirrors FS_Read's
shape on the write side.
==============
*/
export function FS_Write(buffer: Uint8Array, len: number, handle: number): void {
  const h = fs_open_handles.get(handle);
  if (!h) {
    Com_Error(ERR_FATAL, "FS_Write: bad handle");
  }

  writeSync(h.fd, buffer, 0, len, h.position);
  h.position += len;
}

/*
==============
FS_FCloseFile

For some reason, other dll's can't just cal fclose()
on files returned by FS_FOpenFile...
==============
*/
export function FS_FCloseFile(handle: number): void {
  const h = fs_open_handles.get(handle);
  if (!h) return;
  closeSync(h.fd);
  fs_open_handles.delete(handle);
}

// RAFAEL
/*
	Developer_searchpath
*/
export function Developer_searchpath(_who: number): number {
  // `ch` in the C source (set from `who`) is computed but never actually
  // used below -- dead leftover code, dropped along with it.
  for (let search = fs_searchpaths; search; search = search.next) {
    const filename = search.kind === "dir" ? search.filename : "";
    if (filename.includes("xatrix")) return 1;
    if (filename.includes("rogue")) return 2;
  }
  return 0;
}

/*
===========
FS_FOpenFile

Finds the file in the search path.
returns filesize and an open handle.
Used for streaming data out of either a pak file or
a seperate file.

NO_ADDONS is not defined in the shipped (non-demo) engine, so only that
branch is ported; the #else demo-only "everything but config.cfg/players/
comes from the pak" variant is dropped per PORTING.md's dead-branch rule.
===========
*/
export interface FsOpenResult {
  handle: number;
  length: number;
}

export function FS_FOpenFile(filename: string): FsOpenResult | null {
  file_from_pak = 0;

  // check for links first
  for (let link = fs_links; link; link = link.next) {
    if (filename.slice(0, link.fromlength) !== link.from) continue;

    const netpath = link.to + filename.slice(link.fromlength);
    let fd: number;
    try {
      fd = openSync(netpath, "r");
    } catch {
      return null;
    }
    Com_DPrintf("link file: %s\n", netpath);
    const handle = fs_next_handle++;
    fs_open_handles.set(handle, { fd, position: 0 });
    return { handle, length: FS_filelength(fd) };
  }

  // search through the path, one element at a time
  for (let search = fs_searchpaths; search; search = search.next) {
    if (search.kind === "pack") {
      // look through all the pak file elements
      const pak = search.pack;
      for (let i = 0; i < pak.numfiles; i++) {
        if (Q_strcasecmp(pak.files[i].name, filename) !== 0) continue;

        // found it!
        file_from_pak = 1;
        Com_DPrintf("PackFile: %s : %s\n", pak.filename, filename);

        // open a new file on the pakfile
        let fd: number;
        try {
          fd = openSync(pak.filename, "r");
        } catch {
          Com_Error(ERR_FATAL, "Couldn't reopen %s", pak.filename);
        }
        const handle = fs_next_handle++;
        fs_open_handles.set(handle, { fd, position: pak.files[i].filepos });
        return { handle, length: pak.files[i].filelen };
      }
    } else {
      // check a file in the directory tree
      const netpath = `${search.filename}/${filename}`;

      let fd: number;
      try {
        fd = openSync(netpath, "r");
      } catch {
        continue;
      }
      Com_DPrintf("FindFile: %s\n", netpath);
      const handle = fs_next_handle++;
      fs_open_handles.set(handle, { fd, position: 0 });
      return { handle, length: FS_filelength(fd) };
    }
  }

  Com_DPrintf("FindFile: can't find %s\n", filename);
  return null;
}

/*
=================
FS_Read

Properly handles partial reads
=================
*/
const MAX_READ = 0x10000; // read in blocks of 64k

/*
FS_ReadRaw -- fread semantics: returns the byte count actually read (0 at a
clean EOF), never errors. The C call sites this serves (SV_ReadServerFile's
latched-cvar loop, sv_send.c's demo-message reads) use bare fread() and
treat a short read as end-of-data; FS_Read below keeps FS_Read's C
semantics (retry then ERR_FATAL), which those callers must NOT use --
Com_Error's fatal path runs the full engine shutdown before throwing.
*/
export function FS_ReadRaw(buffer: Uint8Array, len: number, handle: number): number {
  const h = fs_open_handles.get(handle);
  if (!h) return 0;
  let total = 0;
  while (total < len) {
    let n: number;
    try {
      n = readSync(h.fd, buffer, total, len - total, h.position);
    } catch {
      n = 0;
    }
    if (n <= 0) break;
    total += n;
    h.position += n;
  }
  return total;
}

export function FS_Read(buffer: Uint8Array, len: number, handle: number): void {
  const h = fs_open_handles.get(handle);
  if (!h) {
    Com_Error(ERR_FATAL, "FS_Read: bad handle");
  }

  // read in chunks for progress bar
  let remaining = len;
  let bufOffset = 0;
  let tries = 0;

  while (remaining) {
    let block = remaining;
    if (block > MAX_READ) block = MAX_READ;

    let read: number;
    try {
      read = readSync(h.fd, buffer, bufOffset, block, h.position);
    } catch {
      read = -1;
    }

    if (read === 0) {
      // we might have been trying to read from a CD -- this port has no CD
      // audio subsystem (cd_null is the one backend), so C's CDAudio_Stop()
      // has no equivalent; the retry-once-then-fail structure is kept.
      if (!tries) {
        tries = 1;
      } else {
        Com_Error(ERR_FATAL, "FS_Read: 0 bytes read");
      }
    }

    if (read === -1) {
      Com_Error(ERR_FATAL, "FS_Read: -1 bytes read");
    }

    // do some progress bar thing here...

    remaining -= read;
    bufOffset += read;
    h.position += read;
  }
}

/*
============
FS_LoadFile

Filename are reletive to the quake search path.
This port has no separate "just return the length" mode (JS callers hold the
buffer directly, not a raw length + malloc'd pointer) -- a null return means
the file was not found.
============
*/
export function FS_LoadFile(path: string): Uint8Array | null {
  const open = FS_FOpenFile(path);
  if (!open) return null;

  const buf = new Uint8Array(open.length);
  FS_Read(buf, open.length, open.handle);
  FS_FCloseFile(open.handle);

  return buf;
}

/*
=============
FS_FreeFile
=============
*/
// no-op in this port: Uint8Array buffers are garbage collected, not
// hand-freed. Kept so ported call sites that mirror the C shape still
// compile.
export function FS_FreeFile(_buffer: Uint8Array | null): void {}

/*
=================
FS_LoadPackFile

Takes an explicit (not game tree related) path to a pak file.

Loads the header and directory, adding the files at the beginning
of the list so they override previous pack files.
=================
*/
export function FS_LoadPackFile(packfile: string): PackT | null {
  let fd: number;
  try {
    fd = openSync(packfile, "r");
  } catch {
    return null;
  }

  const headerBuf = new Uint8Array(12);
  if (readSync(fd, headerBuf, 0, 12, 0) < 12) {
    closeSync(fd);
    return null;
  }
  const headerView = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);

  const ident = headerView.getInt32(0, true);
  if (ident !== IDPAKHEADER) {
    Com_Error(ERR_FATAL, "%s is not a packfile", packfile);
  }
  const dirofs = headerView.getInt32(4, true);
  const dirlen = headerView.getInt32(8, true);

  const numpackfiles = (dirlen / DPACKFILE_SIZE) | 0;

  if (numpackfiles > MAX_FILES_IN_PACK) {
    Com_Error(ERR_FATAL, "%s has %i files", packfile, numpackfiles);
  }

  const dirBuf = new Uint8Array(dirlen);
  readSync(fd, dirBuf, 0, dirlen, dirofs);
  const dirView = new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength);

  // crc the directory to check for modifications -- Com_BlockChecksum(info,
  // dirlen) is computed here in the original only to compare against
  // PAK0_CHECKSUM under #ifdef NO_ADDONS, which the shipped (non-demo)
  // engine never defines; dropped since it has no effect on this build.

  // parse the directory
  const files: PackFileT[] = [];
  for (let i = 0; i < numpackfiles; i++) {
    const base = i * DPACKFILE_SIZE;
    let nameEnd = base;
    while (nameEnd < base + PACKFILE_NAME_LEN && dirBuf[nameEnd] !== 0) nameEnd++;
    let name = "";
    for (let j = base; j < nameEnd; j++) name += String.fromCharCode(dirBuf[j]);

    files.push({
      name,
      filepos: dirView.getInt32(base + PACKFILE_NAME_LEN, true),
      filelen: dirView.getInt32(base + PACKFILE_NAME_LEN + 4, true),
    });
  }

  Com_Printf("Added packfile %s (%i files)\n", packfile, numpackfiles);

  return { filename: packfile, handle: fd, numfiles: numpackfiles, files };
}

/*
================
FS_AddGameDirectory

Sets fs_gamedir, adds the directory to the head of the path,
then loads and adds pak1.pak pak2.pak ...
================
*/
export function FS_AddGameDirectory(dir: string): void {
  fs_gamedir = dir;

  // add the directory to the search path
  fs_searchpaths = { kind: "dir", filename: dir, next: fs_searchpaths };

  // add any pak files in the format pak0.pak pak1.pak, ...
  for (let i = 0; i < 10; i++) {
    const pakfile = `${dir}/pak${i}.pak`;
    const pak = FS_LoadPackFile(pakfile);
    if (!pak) continue;
    fs_searchpaths = { kind: "pack", pack: pak, next: fs_searchpaths };
  }
}

/*
============
FS_Gamedir

Called to find where to write a file (demos, savegames, etc)
============
*/
export function FS_Gamedir(): string {
  if (fs_gamedir) return fs_gamedir;
  return BASEDIRNAME;
}

/*
=============
FS_ExecAutoexec
=============
*/
export function FS_ExecAutoexec(): void {
  const dir = cvarMod().Cvar_VariableString("gamedir");
  const name = dir.length ? `${basedirString()}/${dir}/autoexec.cfg` : `${basedirString()}/${BASEDIRNAME}/autoexec.cfg`;

  // Sys_FindFirst/Sys_FindClose (see header comment) reduce to a plain
  // existence check here: this call site always passes a literal filename,
  // never a wildcard.
  if (existsSync(name)) {
    cmdMod().Cbuf_AddText("exec autoexec.cfg\n");
  }
}

/*
================
FS_SetGamedir

Sets the gamedir and path to a different directory.
================
*/
export function FS_SetGamedir(dir: string): void {
  if (dir.includes("..") || dir.includes("/") || dir.includes("\\") || dir.includes(":")) {
    Com_Printf("Gamedir should be a single filename, not a path\n");
    return;
  }

  // free up any current game dir info
  for (;;) {
    const current = fs_searchpaths;
    if (current === fs_base_searchpaths || !current) break;
    if (current.kind === "pack") {
      closeSync(current.pack.handle);
    }
    fs_searchpaths = current.next;
  }

  // flush all data, so it will be forced to reload
  if (dedicated && !dedicated.value) {
    cmdMod().Cbuf_AddText("vid_restart\nsnd_restart\n");
  }

  fs_gamedir = `${basedirString()}/${dir}`;

  if (dir === BASEDIRNAME || dir.length === 0) {
    cvarMod().Cvar_FullSet("gamedir", "", CVAR_SERVERINFO | CVAR_NOSET);
    cvarMod().Cvar_FullSet("game", "", CVAR_LATCH | CVAR_SERVERINFO);
  } else {
    cvarMod().Cvar_FullSet("gamedir", dir, CVAR_SERVERINFO | CVAR_NOSET);
    if (fs_cddir && fs_cddir.string.length) {
      FS_AddGameDirectory(`${fs_cddir.string}/${dir}`);
    }
    FS_AddGameDirectory(`${basedirString()}/${dir}`);
  }
}

/*
================
FS_Link_f

Creates a filelink_t
================
*/
export function FS_Link_f(): void {
  const cmd = cmdMod();
  if (cmd.Cmd_Argc() !== 3) {
    Com_Printf("USAGE: link <from> <to>\n");
    return;
  }

  const from = cmd.Cmd_Argv(1);
  const to = cmd.Cmd_Argv(2);

  // see if the link already exists
  let prev: FileLinkT | null = null;
  for (let l = fs_links; l; l = l.next) {
    if (l.from === from) {
      if (to.length === 0) {
        // delete it
        if (prev) prev.next = l.next;
        else fs_links = l.next;
        return;
      }
      l.to = to;
      return;
    }
    prev = l;
  }

  // create a new link
  fs_links = { from, fromlength: from.length, to, next: fs_links };
}

/*
** FS_ListFiles
**
** musthave/canthave (SFF_* attribute filtering) are dropped: see header
** comment -- the only call site in this brief's scope (FS_Dir_f) always
** passes 0/0. numfiles is dropped as an out-parameter since a JS array
** already carries its own length (no "guard slot" needed either).
*/
function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

export function FS_ListFiles(findname: string): string[] | null {
  const slash = findname.lastIndexOf("/");
  const dir = slash >= 0 ? findname.slice(0, slash) : ".";
  const pattern = slash >= 0 ? findname.slice(slash + 1) : findname;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const matcher = globToRegExp(pattern);
  const list: string[] = [];
  for (const name of entries) {
    // s[strlen(s)-1] != '.' in the original filters out "." and ".."
    if (name.endsWith(".")) continue;
    if (!matcher.test(name)) continue;
    list.push(`${dir}/${name}`);
  }

  return list.length ? list : null;
}

/*
** FS_Dir_f
*/
export function FS_Dir_f(): void {
  const cmd = cmdMod();
  const wildcard = cmd.Cmd_Argc() !== 1 ? cmd.Cmd_Argv(1) : "*.*";

  let path: string | null = null;
  for (;;) {
    path = FS_NextPath(path);
    if (path === null) break;

    const findname = `${path}/${wildcard}`.replace(/\\/g, "/");

    Com_Printf("Directory of %s\n", findname);
    Com_Printf("----\n");

    const dirnames = FS_ListFiles(findname);
    if (dirnames) {
      for (const name of dirnames) {
        const nameSlash = name.lastIndexOf("/");
        Com_Printf("%s\n", nameSlash >= 0 ? name.slice(nameSlash + 1) : name);
      }
    }
    Com_Printf("\n");
  }
}

/*
============
FS_Path_f

============
*/
export function FS_Path_f(): void {
  Com_Printf("Current search path:\n");
  for (let s: SearchPathT | null = fs_searchpaths; s; s = s.next) {
    if (s === fs_base_searchpaths) Com_Printf("----------\n");
    if (s.kind === "pack") Com_Printf("%s (%i files)\n", s.pack.filename, s.pack.numfiles);
    else Com_Printf("%s\n", s.filename);
  }

  Com_Printf("\nLinks:\n");
  for (let l = fs_links; l; l = l.next) {
    Com_Printf("%s : %s\n", l.from, l.to);
  }
}

/*
================
FS_NextPath

Allows enumerating all of the directories in the search path.

The C original compares pointers (prevpath == prev) to walk the list one
step per call. JS strings have no pointer identity to compare, so this port
compares by value instead; this differs from the C behavior only if two
adjacent non-pack search path entries hold byte-identical directory strings,
which never happens in practice (each FS_AddGameDirectory call contributes a
distinct directory string).
================
*/
export function FS_NextPath(prevpath: string | null): string | null {
  if (prevpath === null) return fs_gamedir;

  let prev = fs_gamedir;
  for (let s = fs_searchpaths; s; s = s.next) {
    if (s.kind === "pack") continue;
    if (prevpath === prev) return s.filename;
    prev = s.filename;
  }

  return null;
}

/*
================
FS_InitFilesystem
================
*/
export function FS_InitFilesystem(): void {
  const cmd = cmdMod();
  const cvar = cvarMod();

  cmd.Cmd_AddCommand("path", FS_Path_f);
  cmd.Cmd_AddCommand("link", FS_Link_f);
  cmd.Cmd_AddCommand("dir", FS_Dir_f);

  // basedir <path>
  // allows the game to run from outside the data tree
  fs_basedir = cvar.Cvar_Get("basedir", ".", CVAR_NOSET);

  // cddir <path>
  // Logically concatenates the cddir after the basedir for
  // allows the game to run from outside the data tree
  fs_cddir = cvar.Cvar_Get("cddir", "", CVAR_NOSET);
  if (fs_cddir && fs_cddir.string.length) {
    FS_AddGameDirectory(`${fs_cddir.string}/${BASEDIRNAME}`);
  }

  // start up with baseq2 by default
  FS_AddGameDirectory(`${basedirString()}/${BASEDIRNAME}`);

  // any set gamedirs will be freed up to here
  fs_base_searchpaths = fs_searchpaths;

  // check for game override
  fs_gamedirvar = cvar.Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO);
  if (fs_gamedirvar && fs_gamedirvar.string.length) {
    FS_SetGamedir(fs_gamedirvar.string);
  }

  // q2repro's files.c:4046 -- Loc_Init() is the last statement of FS_Init(),
  // not part of Qcommon_Init's subsystem block. Mirrored at the same
  // relative position here (see loc.ts's header comment for why this is a
  // lazy require rather than a static import).
  locMod().Loc_Init();
}
