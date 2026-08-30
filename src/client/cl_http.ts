// cl_http.ts -- HTTP downloading, ported from Q2PRO's src/client/http.c
// (r1ch.net, GPLv2) and src/client/download.c (id Software, GPLv2), with
// this port's own enhancement layered on top (see "RANGED MULTI-STREAM"
// section below).
//
// Q2PRO's original is curl-multi + a pthread worker thread pumping libcurl's
// event loop. Bun has no curl binding and no reason to hand-roll one: this
// port replaces the transport with Bun's native `fetch`, and replaces the
// worker thread + curl-multi polling with plain `Promise`-driven concurrency
// (Bun's event loop already does what the worker thread existed for). Every
// piece of *behavior* Q2PRO implements on top of that transport -- the
// queue, the dlserver negotiation, filelist handling, path-safety checks,
// UDP fallback -- is ported faithfully and cited inline against
// ~/Projects/qsrc/q2repro/src/client/{http,download}.c.
//
// Q2PRO's dlqueue_t/dltype_t (DL_LIST/DL_PAK/DL_MAP/DL_MODEL/DL_OTHER) is a
// newer, richer enum than this engine's existing vanilla-3.21-derived
// DltypeT (client.ts: dl_none/dl_model/dl_sound/dl_skin/dl_single), which
// only tracks the UDP path's *single* in-flight download. Rather than
// overload that enum (shared, UDP-only, and outside this brief's scope),
// HttpDlType below is this module's own local type covering everything the
// HTTP queue needs, including the two Q2PRO added (list/pak) that vanilla's
// enum never had a slot for.

import { Com_Printf, Com_DPrintf } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import type { CvarT } from "../shared/q_shared";
import { MAX_QPATH } from "../shared/q_shared";
import { BASEDIRNAME } from "../qcommon/qcommon";
import { FS_Gamedir, FS_CreatePath, FS_WriteFile, FS_ReadRawFile, FS_RemoveFile, FS_LoadFile, FS_AddPak, fs_gamedirvar } from "../qcommon/files";
import { allow_download } from "../server/sv_main";

export type HttpDlType = "model" | "sound" | "skin" | "single" | "pak" | "list";

export type QueueOutcome = "queued" | "duplicate" | "no-server" | "http-disabled";

export interface QueueResult {
  outcome: QueueOutcome;
  // Resolves true once the file lands on disk, false if every avenue
  // (HTTP, then the injected UDP fallback) failed. Null when `outcome`
  // isn't "queued"/"duplicate" -- the caller should fall back to its own
  // UDP request synchronously in that case, mirroring Q2PRO's
  // `check_file_len`: `ret = HTTP_QueueDownload(...); if (ret != Q_ERR(ENOSYS)) return ret;`
  done: Promise<boolean> | null;
}

//=============================================================================
// PATH SAFETY (ported from Q2PRO src/common/files.c + src/client/download.c
// + src/client/http.c -- these are the SECURITY checks the brief calls out.
// Each function below cites its source and, where this port's behavior
// differs, says exactly how and why.)
//=============================================================================

// Q2PRO inc/shared/shared.h:
//   #define Q_ispath(c) (Q_isalnum(c) || (c) == '_' || (c) == '-')
// A path's first and last character must satisfy this; blocks a bare "."
// or "/" surviving as an edge character after normalization.
export function Q_ispath(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "-";
}

export type PathValid = "invalid" | "valid" | "mixed-case";

// Q2PRO src/common/files.c FS_ValidatePath()/validate_char(): rejects an
// empty string and any non-printable-ASCII character, flags PATH_MIXED_CASE
// when any uppercase letter is present (servers get asked to lower-case
// mixed-case names so download URLs stay filesystem-portable).
//
// Dropped branch: validate_char() also rejects `<>:"|?*` but only under
// `#ifdef _WIN32` -- PORTING.md's idiom map says take the portable path and
// list the drop. Kept here anyway, unconditionally, because the brief
// explicitly asks for drive-letter/reserved-character rejection to survive
// on every platform this engine runs on, not just Windows: a malicious
// server could otherwise embed a Windows-drive-style prefix from a Linux
// server hitting a Windows client. See rejectAbsoluteOrDrivePath() below,
// which does this check on the *raw* (pre-normalize) path where a drive
// letter or `<>|` would still be visible; FS_ValidatePath itself stays
// faithful to the portable branch (Q_isprint only) since by the time a path
// reaches it, normalization has already stripped the characters that would
// make a Windows path dangerous.
export function FS_ValidatePath(s: string): PathValid {
  if (s.length === 0) return "invalid";
  let mixedCase = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return "invalid"; // !Q_isprint(c)
    if (s[i] >= "A" && s[i] <= "Z") mixedCase = true;
  }
  return mixedCase ? "mixed-case" : "valid";
}

// Q2PRO src/common/files.c FS_NormalizePathBuffer(): backslash -> slash,
// removes "." and ".." components and duplicate slashes, strips
// leading/trailing slashes. Transform table from that function's own header
// comment (reproduced here so ported cases can be checked against it):
//   ///foo       -> foo
//   foo/         -> foo
//   foo\bar      -> foo/bar
//   foo/..       -> <empty>
//   foo/../bar   -> bar
//   foo/./bar    -> foo/bar
//   foo//bar     -> foo/bar
//   ./foo        -> foo
// The C original is a single-pass pointer/byte state machine (walks the
// string once, backing up `out` on ".."). This is a behavior-equivalent
// reimplementation via a segment stack, which is what "foo/../bar" ->
// pop-then-push amounts to anyway; verified against every row in the table
// above, including the "can't go past root" clamp (C: excess ".." at the
// start just resets `out` to the buffer start and keeps going -- here, an
// empty stack simply ignores a ".." pop instead of erroring, producing the
// same "clamped, not rejected" result for e.g. "../../foo" -> "foo").
export function FS_NormalizePathBuffer(input: string): string {
  const segments: string[] = [];
  for (const raw of input.split(/[/\\]+/)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (segments.length) segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return segments.join("/");
}

// Not present in Q2PRO as a named function -- Q2PRO relies entirely on
// FS_NormalizePathBuffer stripping a leading '/' (so "/etc/passwd" becomes
// "etc/passwd" before Q_ispath/".." checks even run) plus the WIN32-only
// `<>:"|?*` rejection in validate_char for drive letters. The brief asks
// these be "cited each check" and exercised directly by name, so this port
// makes both an explicit, testable, platform-independent gate on the *raw*
// caller-supplied string, run before normalization ever touches it:
//   - a leading '/' or '\' is an absolute path -> reject
//   - a Windows drive prefix ("C:", "d:\...") -> reject
//   - any of the Windows-reserved `<>:"|?*` characters anywhere -> reject
//     (this is exactly validate_char's WIN32 branch, made unconditional --
//     see the FS_ValidatePath doc comment above for why)
export function rejectAbsoluteOrDrivePath(raw: string): boolean {
  if (raw.length === 0) return true;
  if (raw[0] === "/" || raw[0] === "\\") return true;
  if (/^[A-Za-z]:/.test(raw)) return true;
  if (/[<>:"|?*]/.test(raw)) return true;
  return false;
}

// Q2PRO src/client/download.c CL_CheckDownloadExtension(): only these
// extensions may ever be auto-downloaded, closing off arbitrary file
// upload-by-server. List reproduced verbatim.
const ALLOWED_EXTENSIONS = ["bsp", "dm2", "ent", "jpg", "loc", "md2", "md3", "ogg", "pcx", "png", "sp2", "tga", "txt", "wal", "wav"];

export function CL_CheckDownloadExtension(ext: string): boolean {
  return ALLOWED_EXTENSIONS.includes(ext.toLowerCase());
}

export interface PathCheckOk {
  ok: true;
  path: string; // normalized, lower-cased if the input was mixed-case
}
export interface PathCheckFail {
  ok: false;
  reason: string;
}

// Combines Q2PRO's check_file_len() (src/client/download.c) and
// check_and_queue_download() (src/client/http.c) into one gate, since both
// run the same core sequence (oversize -> normalize -> validate -> ispath
// edges -> ".." -> slash placement -> extension) and only differ in which
// slash rule applies for which dltype. `requireSlash` is check_file_len's
// unconditional `!strchr(buffer, '/')` reject (engine-internal precache
// paths always live in a subdirectory) and DL_OTHER's rule in
// check_and_queue_download; `forbidSlash` is DL_PAK's rule there ("by
// definition paks are game-local", i.e. flat, no subdirectory).
export function validateDownloadPath(rawPath: string, opts: { requireSlash: boolean; forbidSlash: boolean; checkExtension: boolean }): PathCheckOk | PathCheckFail {
  if (rawPath.length >= MAX_QPATH) return { ok: false, reason: "oversize path" }; // check_file_len: len >= MAX_QPATH
  if (rejectAbsoluteOrDrivePath(rawPath)) return { ok: false, reason: "absolute or drive-qualified path" };

  const normalized = FS_NormalizePathBuffer(rawPath);
  const valid = FS_ValidatePath(normalized);

  if (valid === "invalid" || normalized.length === 0) return { ok: false, reason: "invalid path" };
  if (!Q_ispath(normalized[0]) || !Q_ispath(normalized[normalized.length - 1])) return { ok: false, reason: "illegal path" };
  // strstr(path, "..") -- kept even though normalization above already
  // collapses every ".." component, exactly as Q2PRO keeps it: "some of
  // these checks are too conservative or even redundant once we have
  // normalized the path, however they have to stay for compatibility
  // reasons" (download.c comment, reproduced verbatim in spirit).
  if (normalized.includes("..")) return { ok: false, reason: "path traversal" };
  if (opts.requireSlash && !normalized.includes("/")) return { ok: false, reason: "must be inside a subdirectory" };
  if (opts.forbidSlash && normalized.includes("/")) return { ok: false, reason: "pak files must be flat (no subdirectory)" };

  if (opts.checkExtension) {
    const dot = normalized.lastIndexOf(".");
    const ext = dot >= 0 ? normalized.slice(dot + 1) : "";
    if (dot < 0 || !CL_CheckDownloadExtension(ext)) return { ok: false, reason: "illegal file extension" };
  }

  return { ok: true, path: valid === "mixed-case" ? normalized.toLowerCase() : normalized };
}

// Q2PRO src/client/http.c escape_path(): percent-encodes everything except
// alphanumerics and "/-_.~" (RFC 3986 unreserved set, plus '/' left alone
// since these are whole relative paths, not single segments).
export function escapePath(path: string): string {
  const hex = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    const code = path.charCodeAt(i);
    const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (alnum || "/-_.~".includes(ch)) {
      out += ch;
    } else {
      out += `%${hex[(code >> 4) & 0xf]}${hex[code & 0xf]}`;
    }
  }
  return out;
}

//=============================================================================
// dlserver gamedir prefix (Q2PRO src/client/http.c http_gamedir())
//=============================================================================

function http_gamedir(): string {
  if (fs_gamedirvar && fs_gamedirvar.string.length) return fs_gamedirvar.string;
  return BASEDIRNAME;
}

// Q2PRO src/client/http.c: "Use 'baseq2' instead of empty gamedir
// consistently for all kinds of downloads." Mirrors cl_parse.ts's
// CL_DownloadFileName ("players/" goes to the shared baseq2 tree,
// everything else to the active gamedir) -- re-implemented here rather than
// imported to avoid a client-module import cycle risk on a one-line helper;
// kept byte-identical to cl_parse.ts's version.
function downloadFileOnDiskPath(quakePath: string): string {
  if (quakePath.slice(0, 7) === "players") return `${BASEDIRNAME}/${quakePath}`;
  return `${FS_Gamedir()}/${quakePath}`;
}

//=============================================================================
// CVARS (Q2PRO src/client/http.c HTTP_Init(); range cvars are this port's
// own addition, see RANGED MULTI-STREAM below)
//=============================================================================

let cl_http_downloads: CvarT | null = null;
let cl_http_filelists: CvarT | null = null;
let cl_http_max_connections: CvarT | null = null;
// THE ENHANCEMENT (ours, not in Q2PRO): per-file ranged multi-stream.
// cl_http_range_streams is K, the number of parallel Range: byte-streams to
// split one file across when the server advertises Accept-Ranges and the
// file is bigger than cl_http_range_threshold bytes. Defaults are
// deliberately modest: 4 streams keeps well clear of most browsers'/CDNs'
// per-host connection limits when stacked with cl_http_max_connections
// (itself clamped to 1-4, matching Q2PRO's CURLMOPT_MAX_HOST_CONNECTIONS
// clamp), and 1 MiB is large enough that splitting a texture or sound below
// it would spend more time on request overhead than it saves.
let cl_http_range_streams: CvarT | null = null;
let cl_http_range_threshold: CvarT | null = null;

export function HTTP_Init(): void {
  cl_http_downloads = Cvar_Get("cl_http_downloads", "1", 0);
  cl_http_filelists = Cvar_Get("cl_http_filelists", "1", 0);
  cl_http_max_connections = Cvar_Get("cl_http_max_connections", "2", 0);
  cl_http_range_streams = Cvar_Get("cl_http_range_streams", "4", 0);
  cl_http_range_threshold = Cvar_Get("cl_http_range_threshold", "1048576", 0);
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.trunc(v);
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function maxConnections(): number {
  return clampInt(cl_http_max_connections ? cl_http_max_connections.value : 2, 1, 4);
}

function rangeStreams(): number {
  return clampInt(cl_http_range_streams ? cl_http_range_streams.value : 4, 1, 8);
}

function rangeThreshold(): number {
  const v = cl_http_range_threshold ? cl_http_range_threshold.value : 1048576;
  return v > 0 ? v : 1048576;
}

//=============================================================================
// QUEUE (Q2PRO src/client/download.c dlqueue_t / CL_QueueDownload /
// CL_FinishDownload, folded into this module since our engine's UDP path
// -- cl_parse.ts's cls.download* fields -- has no queue of its own to share)
//=============================================================================

interface DlEntry {
  path: string; // normalized quake-relative path
  type: HttpDlType;
  state: "pending" | "running" | "done";
  resolve: (ok: boolean) => void;
  done: Promise<boolean>;
  controller: AbortController;
}

let downloadServer: string | null = null; // Q2PRO's download_server[512]
let queue: DlEntry[] = [];
let activeCount = 0;

// Injected by cl_parse.ts/cl_main.ts wiring (HTTP_SetCallbacks) so this
// module never has to import them directly and risk a load-order cycle.
export interface HttpCallbacks {
  // Q2PRO falls back to UDP wholesale only on a connection-level fatal
  // error (abort_downloads()) and simply drops an individual 404 with no
  // retry. This port has no "whole session" HTTP-abort state worth
  // tracking separately -- our engine downloads one UDP file at a time
  // regardless -- so every per-file HTTP failure (including a plain 404)
  // triggers a UDP retry of that one file instead. Documented departure
  // (rule 16): friendlier given the shape of our UDP path, not a fidelity
  // loss against any observable multiplayer behavior a real server relies
  // on (the client still ends up with the file, or without it, exactly as
  // it would after Q2PRO's fallback-to-UDP path).
  udpFallback: (path: string) => void;
  // Called after every settled entry (success or exhausted failure),
  // mirroring Q2PRO's process_downloads()/abort_downloads() both ending in
  // `CL_RequestNextDownload()`.
  onSettled: () => void;
}

let callbacks: HttpCallbacks | null = null;

export function HTTP_SetCallbacks(cb: HttpCallbacks): void {
  callbacks = cb;
}

export function HTTP_HasServer(): boolean {
  return downloadServer !== null;
}

/*
===============
HTTP_SetServer

A new server is specified, so we nuke all our state.

Q2PRO src/client/http.c HTTP_SetServer(). `isLocalServer` is passed in by
the caller (cl_main.ts's client_connect handler already has `net_from` in
scope to test with NET_IsLocalAddress) rather than read from a module-global
`cls.serverAddress`, so this function stays a pure state transition and is
directly unit-testable without faking global client state.
===============
*/
export function HTTP_SetServer(url: string | null, isLocalServer: boolean): void {
  if (downloadServer !== null) {
    Com_Printf("[HTTP] Set server without cleanup?\n");
    return;
  }

  // ignore on the local server
  if (isLocalServer) return;

  // ignore if downloads are permanently disabled
  if (allow_download && allow_download.value === -1) return;

  // ignore if HTTP downloads are disabled
  if (cl_http_downloads && cl_http_downloads.value === 0) return;

  // Q2PRO also falls back to cl_http_default_url here when the server
  // doesn't advertise one; not wired into this brief's dlserver-negotiation
  // ask (server-advertised URL only), so a null/empty url is a plain no-op.
  if (!url || url.length === 0) return;

  if (!/^https?:\/\//i.test(url)) {
    Com_Printf("[HTTP] Ignoring download server URL with non-HTTP schema.\n");
    return;
  }

  if (url.length >= 512) {
    Com_Printf("[HTTP] Ignoring oversize download server URL.\n");
    return;
  }

  downloadServer = url.endsWith("/") ? url : `${url}/`;
  Com_Printf("[HTTP] Download server at %s\n", downloadServer);
}

function insertQueueEntry(entry: DlEntry): void {
  if (entry.type === "pak") {
    // "paks get bumped to the top and HTTP switches to single downloading"
    // (http.c CL_QueueDownload comment): insert before the first non-pak
    // entry, keeping any existing paks bunched together in FIFO order.
    const idx = queue.findIndex((q) => q.type !== "pak");
    if (idx === -1) queue.push(entry);
    else queue.splice(idx, 0, entry);
  } else {
    queue.push(entry);
  }
}

/*
===============
HTTP_QueueDownload

Called from the precache check (cl_parse.ts's CL_CheckOrDownloadFile) to
queue a download. outcome "no-server"/"http-disabled" tells the caller to
fall back to standard UDP downloading immediately, mirroring Q2PRO's
Q_ERR(ENOSYS) sentinel.
===============
*/
export function HTTP_QueueDownload(path: string, type: HttpDlType): QueueResult {
  if (!downloadServer) return { outcome: "no-server", done: null };
  if (cl_http_downloads && cl_http_downloads.value === 0) return { outcome: "http-disabled", done: null };

  const existing = queue.find((q) => q.path === path);
  if (existing) {
    Com_DPrintf("%s: %s [DUP]\n", "HTTP_QueueDownload", path);
    return { outcome: "duplicate", done: existing.done };
  }

  const needList = queue.length === 0;

  let resolveFn: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    resolveFn = resolve;
  });
  const entry: DlEntry = { path, type, state: "pending", resolve: resolveFn, done, controller: new AbortController() };
  insertQueueEntry(entry);
  Com_DPrintf("%s: %s [%d]\n", "HTTP_QueueDownload", path, queue.filter((q) => q.state !== "done").length);

  if (needList && cl_http_filelists && cl_http_filelists.value !== 0) {
    // grab the mod filelist
    const listPath = `${http_gamedir()}.filelist`;
    if (listPath.length < MAX_QPATH && !queue.some((q) => q.path === listPath)) {
      const listEntry: DlEntry = { path: listPath, type: "list", state: "pending", resolve: () => {}, done: Promise.resolve(true), controller: new AbortController() };
      insertQueueEntry(listEntry);
    }
  }

  // special case for map file lists: "<gamedir>/<mapname>.filelist"
  if (path.length > 4 && path.slice(-4).toLowerCase() === ".bsp" && cl_http_filelists && cl_http_filelists.value !== 0) {
    const mapListPath = `${http_gamedir()}/${path.slice(0, -4)}.filelist`;
    if (mapListPath.length < MAX_QPATH && !queue.some((q) => q.path === mapListPath)) {
      const listEntry: DlEntry = { path: mapListPath, type: "list", state: "pending", resolve: () => {}, done: Promise.resolve(true), controller: new AbortController() };
      insertQueueEntry(listEntry);
    }
  }

  pump();
  return { outcome: "queued", done };
}

//=============================================================================
// RANGED MULTI-STREAM (this port's enhancement -- not present in Q2PRO)
//
// Before downloading a file, probe it with a HEAD request. If the server
// answers with `Accept-Ranges: bytes` and a numeric Content-Length, and the
// file is larger than cl_http_range_threshold, split it into
// cl_http_range_streams contiguous byte ranges and fetch them all in
// parallel with `Range:` headers, assembling the result byte-exactly in
// memory before writing it out once. Any single stream failing (network
// error, non-206 status, or a Content-Range that doesn't match what was
// requested -- catches a server that lies about Accept-Ranges and just
// returns 200 with the full body) aborts the whole ranged attempt and
// falls back to one clean, ordinary single-stream GET of the same URL.
//
// If the HEAD probe itself fails or is inconclusive (some servers don't
// implement HEAD), there is no second round-trip: the plain GET's own
// response *is* the file, used directly ("first-response" fallback).
//=============================================================================

interface ProbeResult {
  rangeable: boolean;
  size: number | null;
}

async function probeRanges(url: string, signal: AbortSignal): Promise<ProbeResult> {
  try {
    const head = await fetch(url, { method: "HEAD", signal });
    if (!head.ok) return { rangeable: false, size: null };
    const len = head.headers.get("content-length");
    const acceptRanges = (head.headers.get("accept-ranges") ?? "").toLowerCase();
    const size = len ? Number(len) : null;
    if (size !== null && Number.isFinite(size) && acceptRanges.includes("bytes")) {
      return { rangeable: true, size };
    }
    return { rangeable: false, size };
  } catch {
    // HEAD not supported / network hiccup -- fall through to a plain GET,
    // whose first (only) response becomes the file content directly.
    return { rangeable: false, size: null };
  }
}

function computeByteRanges(size: number, streams: number): Array<[number, number]> {
  const chunk = Math.ceil(size / streams);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < streams; i++) {
    const start = i * chunk;
    if (start >= size) break;
    const end = Math.min(start + chunk, size) - 1;
    ranges.push([start, end]);
  }
  return ranges;
}

interface FetchOutcome {
  ok: boolean;
  bytes: Uint8Array | null;
}

async function fetchWhole(url: string, signal: AbortSignal): Promise<FetchOutcome> {
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return { ok: false, bytes: null };
    const buf = new Uint8Array(await resp.arrayBuffer());
    return { ok: true, bytes: buf };
  } catch {
    return { ok: false, bytes: null };
  }
}

// Byte-exact ranged assembly: each range is fetched independently and
// written into its known offset in the pre-sized output buffer, so stream
// completion order never matters.
async function fetchRanged(url: string, size: number, ranges: Array<[number, number]>, signal: AbortSignal): Promise<Uint8Array | null> {
  const out = new Uint8Array(size);

  const results = await Promise.all(
    ranges.map(async ([start, end]): Promise<boolean> => {
      try {
        const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
        if (resp.status !== 206) return false;
        const contentRange = resp.headers.get("content-range") ?? "";
        const match = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(contentRange);
        if (match && (Number(match[1]) !== start || Number(match[2]) !== end)) return false;
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.length !== end - start + 1) return false;
        out.set(buf, start);
        return true;
      } catch {
        return false;
      }
    }),
  );

  return results.every((ok) => ok) ? out : null;
}

//=============================================================================
// TRANSFER + QUEUE PUMP (Q2PRO src/client/http.c start_download /
// process_downloads / start_next_download, collapsed into one async
// function per entry since Bun's fetch already gives us the concurrency
// curl-multi existed to provide)
//=============================================================================

const MAX_DLSIZE = 1 << 20; // Q2PRO http.c: filelist size cap, power of two

// Q2PRO src/client/http.c parse_file_list() + check_and_queue_download():
// validates and queues every non-blank line of a fetched .filelist.
function parseAndQueueFileList(text: string): void {
  if (!cl_http_filelists || cl_http_filelists.value === 0) return;

  const lines = text.split("\n");
  for (let raw of lines) {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (raw.length === 0) continue;

    let path = raw;
    let type: HttpDlType = "single";

    const dot = path.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = path.slice(dot + 1).toLowerCase();

    if (ext === "pak" || ext === "pkz") {
      Com_Printf("[HTTP] Filelist is requesting a .%s file '%s'\n", ext, path);
      type = "pak";
    } else if (!CL_CheckDownloadExtension(ext)) {
      Com_Printf("[HTTP] Illegal file type '%s' in filelist.\n", path);
      continue;
    }

    // '@' prefix (FS_PATH_GAME in Q2PRO): stripped for wire compatibility.
    // See downloadFileOnDiskPath()'s doc comment -- this port has one
    // unified search path, so the flag doesn't change lookup/write
    // behavior here, only whether the leading '@' survives into the path.
    if (path[0] === "@") {
      if (type === "pak") {
        Com_Printf("[HTTP] '@' prefix used on a pak file '%s' in filelist.\n", path);
        continue;
      }
      path = path.slice(1);
    }

    const check = validateDownloadPath(path, { requireSlash: type !== "pak", forbidSlash: type === "pak", checkExtension: type !== "pak" });
    if (!check.ok) {
      Com_Printf("[HTTP] Illegal path '%s' in filelist.\n", raw);
      continue;
    }

    if (FS_LoadFile(check.path) !== null) continue; // already have it

    HTTP_QueueDownload(check.path, type);
  }
}

async function runEntry(entry: DlEntry): Promise<void> {
  const url = entry.type === "list" ? `${downloadServer}${escapePath(entry.path)}` : `${downloadServer}${escapePath(`${http_gamedir()}/${entry.path}`)}`;

  const timeoutSignal = AbortSignal.timeout(30000);
  const signal = AbortSignal.any([entry.controller.signal, timeoutSignal]);

  let bytes: Uint8Array | null = null;

  if (entry.type === "list") {
    const result = await fetchWhole(url, signal);
    if (result.ok && result.bytes && result.bytes.length <= MAX_DLSIZE) {
      bytes = result.bytes;
    }
  } else {
    const probe = await probeRanges(url, signal);
    if (probe.rangeable && probe.size !== null && probe.size > rangeThreshold()) {
      const ranges = computeByteRanges(probe.size, rangeStreams());
      const assembled = await fetchRanged(url, probe.size, ranges, signal);
      if (assembled) {
        bytes = assembled;
      } else {
        // clean single-stream fallback
        const fallback = await fetchWhole(url, signal);
        if (fallback.ok) bytes = fallback.bytes;
      }
    } else {
      const single = await fetchWhole(url, signal);
      if (single.ok) bytes = single.bytes;
    }
  }

  entry.state = "done";
  activeCount--;

  if (bytes === null) {
    Com_Printf("[HTTP] %s [failed] [%d remaining file%s]\n", entry.path, queue.filter((q) => q.state !== "done").length, queue.filter((q) => q.state !== "done").length === 1 ? "" : "s");
    if (entry.type === "list") {
      entry.resolve(true); // a missing filelist is not fatal, matches Q2PRO's 404-on-filelist-is-fine handling
    } else {
      callbacks?.udpFallback(entry.path);
      entry.resolve(false);
    }
    callbacks?.onSettled();
    pump();
    return;
  }

  if (entry.type === "list") {
    parseAndQueueFileList(new TextDecoder().decode(bytes));
    entry.resolve(true);
  } else {
    const diskPath = downloadFileOnDiskPath(entry.path);
    const tmpPath = `${diskPath}.tmp`;
    FS_CreatePath(tmpPath);
    FS_WriteFile(tmpPath, bytes);

    // "atomic rename from a .tmp": this codebase's files.ts has no
    // FS_RenameFile (PORTING.md restricts node:fs sync calls to
    // src/platform and src/qcommon/files.ts, so cl_http.ts can't call
    // fs.renameSync directly either); cl_parse.ts's own CL_ParseDownload
    // finalizes its UDP downloads the same way -- read the temp file back
    // in full and write it to the final name -- so this follows the
    // existing project convention rather than inventing a new one.
    const data = FS_ReadRawFile(tmpPath);
    if (data !== null) {
      FS_WriteFile(diskPath, data);
      FS_RemoveFile(tmpPath);

      // "a pak file is very special..." (Q2PRO http.c process_downloads):
      // mount it immediately so any other still-pending queue entry that
      // turns out to live inside it (rescanQueue below) is satisfied
      // without ever being individually fetched.
      if (entry.type === "pak" && FS_AddPak(diskPath)) {
        HTTP_RescanQueue();
      }
    }

    Com_Printf("[HTTP] %s [%d bytes] [%d remaining file%s]\n", entry.path, bytes.length, queue.filter((q) => q.state !== "done").length, queue.filter((q) => q.state !== "done").length === 1 ? "" : "s");
    entry.resolve(true);
  }

  callbacks?.onSettled();
  pump();
}

function pump(): void {
  if (!downloadServer) return;

  for (const entry of queue) {
    if (activeCount >= maxConnections()) break;
    if (entry.state === "pending") {
      entry.state = "running";
      activeCount++;
      void runEntry(entry);
    }
    // "hack for pak file single downloading" (http.c start_next_download):
    // stop handing out new slots once we hit a pak that isn't finished yet.
    if (entry.type === "pak" && entry.state !== "done") break;
  }
}

/*
===============
HTTP_RunDownloads

Q2PRO calls this every client frame to pump curl-multi's event loop and
promote finished transfers. This port's transfers are plain Promises driven
by Bun's own event loop, so nothing needs polling -- kept as an exported,
idempotent no-op pump (rather than deleted outright) so the call site in
cl_main.ts's CL_Frame stays structurally where Q2PRO puts it, and so a
future change to the transport (e.g. real streaming with manual chunk
pacing) has an obvious hook to grow into.
===============
*/
export function HTTP_RunDownloads(): void {
  pump();
}

/*
===============
HTTP_RescanQueue

Q2PRO src/client/http.c rescan_queue(): "A pak file just downloaded, let's
see if we can remove some stuff from the queue which is in the .pak."
Any not-yet-dispatched queue entry whose path now resolves through
FS_LoadFile (thanks to a newly mounted pak, from either the HTTP path
above or cl_parse.ts's UDP-fallback .pak/.pkz completion) is resolved done
without ever being fetched, so pump() doesn't waste a request on it.
Exported (rather than kept file-private like the original static function)
so cl_parse.ts's CL_ParseDownload can call it too.
===============
*/
export function HTTP_RescanQueue(): void {
  for (const entry of queue) {
    if (entry.state === "pending" && entry.type !== "list" && FS_LoadFile(entry.path) !== null) {
      entry.state = "done";
      entry.resolve(true);
    }
  }
}

/*
===============
HTTP_CleanupDownloads

Disconnected from server, or fatal HTTP error occurred. Clean up.
===============
*/
export function HTTP_CleanupDownloads(): void {
  for (const entry of queue) {
    if (entry.state !== "done") entry.controller.abort();
  }
  queue = [];
  activeCount = 0;
  downloadServer = null;
}

export function HTTP_Shutdown(): void {
  HTTP_CleanupDownloads();
  callbacks = null;
}
