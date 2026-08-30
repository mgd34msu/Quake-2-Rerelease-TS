import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, cvar_vars } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_SetGamedir, FS_ReadRawFile } from "../src/qcommon/files";
import { BASEDIRNAME } from "../src/qcommon/qcommon";
import {
  HTTP_Init,
  HTTP_SetServer,
  HTTP_HasServer,
  HTTP_QueueDownload,
  HTTP_CleanupDownloads,
  HTTP_SetCallbacks,
  Q_ispath,
  FS_ValidatePath,
  FS_NormalizePathBuffer,
  rejectAbsoluteOrDrivePath,
  CL_CheckDownloadExtension,
  validateDownloadPath,
  escapePath,
} from "../src/client/cl_http";
import { CL_CheckOrDownloadFile } from "../src/client/cl_parse";

// Every test in this suite resets the module-scoped cvar/queue state it
// touches (rule 13: self-sufficient, verified with `bun test test/cl_http.test.ts`
// alone). cvar_vars is a process-wide Map (qcommon/cvar.ts), so cl_http.ts's
// cvars are deleted and re-registered by HTTP_Init() before every test
// rather than relying on defaults surviving from an earlier test/file.
function resetHttpState(): void {
  for (const name of ["cl_http_downloads", "cl_http_filelists", "cl_http_max_connections", "cl_http_range_streams", "cl_http_range_threshold"]) {
    cvar_vars.delete(name);
  }
  HTTP_CleanupDownloads();
  HTTP_Init();
  HTTP_SetCallbacks({ udpFallback: () => {}, onSettled: () => {} });
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Deterministic pseudo-random fill so range-assembled output can be
// compared byte-for-byte against the source without keeping two live
// copies of "random" data in sync.
function fabricate(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = 0x2545f4914f6cdd1d >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe("cl_http.ts -- path safety (ported Q2PRO security checks)", () => {
  beforeEach(resetHttpState);

  test("Q_ispath matches Q2PRO's alnum/_/- definition", () => {
    expect(Q_ispath("a")).toBe(true);
    expect(Q_ispath("Z")).toBe(true);
    expect(Q_ispath("9")).toBe(true);
    expect(Q_ispath("_")).toBe(true);
    expect(Q_ispath("-")).toBe(true);
    expect(Q_ispath(".")).toBe(false);
    expect(Q_ispath("/")).toBe(false);
  });

  test("FS_ValidatePath rejects empty and non-printable, flags mixed case", () => {
    expect(FS_ValidatePath("")).toBe("invalid");
    expect(FS_ValidatePath("foo\x01bar")).toBe("invalid"); // non-printable
    expect(FS_ValidatePath("foo/bar")).toBe("valid");
    expect(FS_ValidatePath("Foo/Bar")).toBe("mixed-case");
  });

  test("FS_NormalizePathBuffer matches Q2PRO's documented transform table", () => {
    expect(FS_NormalizePathBuffer("///foo")).toBe("foo");
    expect(FS_NormalizePathBuffer("foo/")).toBe("foo");
    expect(FS_NormalizePathBuffer("foo\\bar")).toBe("foo/bar");
    expect(FS_NormalizePathBuffer("foo/..")).toBe("");
    expect(FS_NormalizePathBuffer("foo/../bar")).toBe("bar");
    expect(FS_NormalizePathBuffer("foo/./bar")).toBe("foo/bar");
    expect(FS_NormalizePathBuffer("foo//bar")).toBe("foo/bar");
    expect(FS_NormalizePathBuffer("./foo")).toBe("foo");
  });

  test("FS_NormalizePathBuffer clamps excess '..' at root instead of escaping it (writes-outside-gamedir defense)", () => {
    // This is the concrete mechanism that keeps a server-supplied path from
    // ever resolving above the game directory: however many ".." components
    // a malicious filelist line stacks up, the result is clamped to a
    // relative path with no way back above where it started.
    expect(FS_NormalizePathBuffer("../../../etc/passwd")).toBe("etc/passwd");
    expect(FS_NormalizePathBuffer("../../..")).toBe("");
  });

  test("rejectAbsoluteOrDrivePath: absolute paths", () => {
    expect(rejectAbsoluteOrDrivePath("/etc/passwd")).toBe(true);
    expect(rejectAbsoluteOrDrivePath("\\Windows\\System32")).toBe(true);
    expect(rejectAbsoluteOrDrivePath("textures/foo.wal")).toBe(false);
  });

  test("rejectAbsoluteOrDrivePath: drive letters", () => {
    expect(rejectAbsoluteOrDrivePath("C:\\Windows\\System32\\evil.dll")).toBe(true);
    expect(rejectAbsoluteOrDrivePath("d:/data/foo.wav")).toBe(true);
  });

  test("rejectAbsoluteOrDrivePath: reserved characters", () => {
    expect(rejectAbsoluteOrDrivePath("foo|bar.txt")).toBe(true);
    expect(rejectAbsoluteOrDrivePath('foo"bar.txt')).toBe(true);
  });

  test("CL_CheckDownloadExtension allows only the ported allowlist", () => {
    expect(CL_CheckDownloadExtension("wav")).toBe(true);
    expect(CL_CheckDownloadExtension("WAL")).toBe(true); // case-insensitive
    expect(CL_CheckDownloadExtension("exe")).toBe(false);
    expect(CL_CheckDownloadExtension("dll")).toBe(false);
    expect(CL_CheckDownloadExtension("sh")).toBe(false);
  });

  test("escapePath percent-encodes reserved characters but leaves alnum and -_.~/ alone", () => {
    expect(escapePath("textures/foo bar.wal")).toBe("textures/foo%20bar.wal");
    expect(escapePath("a-B_1.~/x")).toBe("a-B_1.~/x");
    expect(escapePath("weird#name?.txt")).toBe("weird%23name%3F.txt");
  });

  test("validateDownloadPath: end-to-end absolute path rejection", () => {
    const r = validateDownloadPath("/etc/passwd", { requireSlash: true, forbidSlash: false, checkExtension: false });
    expect(r.ok).toBe(false);
  });

  test("validateDownloadPath: end-to-end '..' traversal rejection", () => {
    const r = validateDownloadPath("textures/../../../etc/passwd", { requireSlash: true, forbidSlash: false, checkExtension: true });
    expect(r.ok).toBe(false);
  });

  test("validateDownloadPath: oversize path rejected (MAX_QPATH)", () => {
    const r = validateDownloadPath(`textures/${"a".repeat(100)}.wal`, { requireSlash: true, forbidSlash: false, checkExtension: true });
    expect(r.ok).toBe(false);
  });

  test("validateDownloadPath: pak files must be flat (forbidSlash), other files must be in a subdirectory (requireSlash)", () => {
    const pakWithSlash = validateDownloadPath("sub/pak0.pak", { requireSlash: false, forbidSlash: true, checkExtension: false });
    expect(pakWithSlash.ok).toBe(false);

    const flatModel = validateDownloadPath("tris.md2", { requireSlash: true, forbidSlash: false, checkExtension: true });
    expect(flatModel.ok).toBe(false);

    const okPak = validateDownloadPath("pak0.pak", { requireSlash: false, forbidSlash: true, checkExtension: false });
    expect(okPak.ok).toBe(true);

    const okModel = validateDownloadPath("models/foo/tris.md2", { requireSlash: true, forbidSlash: false, checkExtension: true });
    expect(okModel.ok).toBe(true);
  });

  test("validateDownloadPath: mixed-case input is lower-cased on success", () => {
    const r = validateDownloadPath("Textures/Foo.WAL", { requireSlash: true, forbidSlash: false, checkExtension: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("textures/foo.wal");
  });
});

describe("cl_http.ts -- dlserver negotiation and queue mechanics (no network)", () => {
  beforeEach(resetHttpState);

  test("HTTP_QueueDownload returns no-server when no dlserver was advertised", () => {
    const result = HTTP_QueueDownload("textures/foo.wal", "single");
    expect(result.outcome).toBe("no-server");
    expect(result.done).toBeNull();
  });

  test("HTTP_SetServer ignores a local (listen) server connection", () => {
    HTTP_SetServer("http://example.invalid/dl/", true);
    expect(HTTP_HasServer()).toBe(false);
  });

  test("HTTP_SetServer ignores a non-HTTP(S) URL", () => {
    HTTP_SetServer("ftp://example.invalid/dl/", false);
    expect(HTTP_HasServer()).toBe(false);
  });

  test("HTTP_SetServer accepts a valid http:// URL", () => {
    HTTP_SetServer("http://example.invalid/dl/", false);
    expect(HTTP_HasServer()).toBe(true);
  });

  test("HTTP_QueueDownload dedups a path already in the queue, sharing the same completion", () => {
    HTTP_SetServer("http://example.invalid/dl/", false);
    Cvar_ForceSet("cl_http_filelists", "0");
    const first = HTTP_QueueDownload("sound/misc/foo.wav", "single");
    const second = HTTP_QueueDownload("sound/misc/foo.wav", "single");
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("duplicate");
    expect(second.done).toBe(first.done);
  });

  test("HTTP_CleanupDownloads resets state so a subsequent queue attempt reports no-server", () => {
    HTTP_SetServer("http://example.invalid/dl/", false);
    expect(HTTP_HasServer()).toBe(true);
    HTTP_CleanupDownloads();
    expect(HTTP_HasServer()).toBe(false);
    const result = HTTP_QueueDownload("sound/misc/foo.wav", "single");
    expect(result.outcome).toBe("no-server");
  });
});

// ===========================================================================
// Integration: a real local HTTP server (Bun.serve), fabricated files with
// and without Range support, exercising the full queue-drain / filelist /
// ranged-assembly / UDP-fallback paths against real fetch() traffic.
// ===========================================================================

interface MockServer {
  url: string;
  stop: () => void;
  rangeRequests: string[];
}

function startMockServer(files: Map<string, Uint8Array>, opts: { rangeSupport: boolean }): MockServer {
  const rangeRequests: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const data = files.get(path);
      if (!data) return new Response("not found", { status: 404 });

      const rangeHeader = req.headers.get("range");
      if (opts.rangeSupport && rangeHeader) {
        rangeRequests.push(`${path}:${rangeHeader}`);
        const m = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
        if (m) {
          const start = Number(m[1]);
          const end = Math.min(Number(m[2]), data.length - 1);
          const slice = data.subarray(start, end + 1);
          if (req.method === "HEAD") {
            return new Response(null, {
              status: 206,
              headers: { "content-range": `bytes ${start}-${end}/${data.length}`, "accept-ranges": "bytes", "content-length": String(slice.length) },
            });
          }
          return new Response(slice, {
            status: 206,
            headers: { "content-range": `bytes ${start}-${end}/${data.length}`, "accept-ranges": "bytes", "content-length": String(slice.length) },
          });
        }
      }

      const headers: Record<string, string> = { "content-length": String(data.length) };
      if (opts.rangeSupport) headers["accept-ranges"] = "bytes";

      if (req.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(data, { status: 200, headers });
    },
  });

  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true), rangeRequests };
}

// A server that lies about range support: HEAD advertises Accept-Ranges +
// Content-Length, but a real Range GET ignores the header and returns the
// whole file with 200 anyway. Exercises fetchRanged's own defensive check
// (status !== 206) rather than probeRanges'.
function startLyingRangeServer(files: Map<string, Uint8Array>): MockServer {
  const rangeRequests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const data = files.get(path);
      if (!data) return new Response("not found", { status: 404 });

      if (req.headers.get("range")) rangeRequests.push(path);

      const headers: Record<string, string> = { "content-length": String(data.length), "accept-ranges": "bytes" };
      if (req.method === "HEAD") return new Response(null, { status: 200, headers });
      // Ignores Range entirely: always 200 with the full body.
      return new Response(data, { status: 200, headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true), rangeRequests };
}

describe("cl_http.ts -- integration against a real local HTTP server", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2http-"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir(BASEDIRNAME);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetHttpState();
    Cvar_ForceSet("cl_http_filelists", "0"); // most cases below don't exercise filelists
  });

  test("queue drains: a queued file downloads and lands at the expected gamedir path", async () => {
    const content = bytesOf("HELLO-FROM-HTTP-DOWNLOAD");
    const server = startMockServer(new Map([[`${BASEDIRNAME}/sound/misc/foo.wav`, content]]), { rangeSupport: false });
    try {
      HTTP_SetServer(server.url, false);
      const { outcome, done } = HTTP_QueueDownload("sound/misc/foo.wav", "single");
      expect(outcome).toBe("queued");
      const ok = await done;
      expect(ok).toBe(true);

      const onDisk = FS_ReadRawFile(join(tmpRoot, BASEDIRNAME, "sound/misc/foo.wav"));
      expect(onDisk).not.toBeNull();
      expect(new TextDecoder().decode(onDisk!)).toBe("HELLO-FROM-HTTP-DOWNLOAD");
    } finally {
      server.stop();
    }
  });

  test("CL_CheckOrDownloadFile refuses a path containing '..' outright, before ever touching HTTP", () => {
    HTTP_SetServer("http://127.0.0.1:1/", false); // deliberately unreachable; must never be hit
    const result = CL_CheckOrDownloadFile("textures/../../etc/passwd.wal");
    expect(result).toBe(true); // vanilla contract: true means "no download needed / refused"
  });

  test(".filelist bulk manifest: queuing the first file also fetches and queues the mod filelist", async () => {
    Cvar_ForceSet("cl_http_filelists", "1");
    const extra = bytesOf("EXTRA-FILE-FROM-FILELIST");
    const files = new Map([
      [`${BASEDIRNAME}/sound/misc/foo.wav`, bytesOf("PRIMARY-FILE")],
      [`${BASEDIRNAME}.filelist`, bytesOf("sound/misc/extra.wav\n")],
      [`${BASEDIRNAME}/sound/misc/extra.wav`, extra],
    ]);
    const server = startMockServer(files, { rangeSupport: false });
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("sound/misc/foo.wav", "single");
      await done;

      // give the filelist's own async chain (fetch -> parse -> queue -> fetch) a turn
      let waited = 0;
      while (waited < 2000) {
        const onDisk = FS_ReadRawFile(join(tmpRoot, BASEDIRNAME, "sound/misc/extra.wav"));
        if (onDisk !== null) {
          expect(new TextDecoder().decode(onDisk)).toBe("EXTRA-FILE-FROM-FILELIST");
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
        waited += 20;
      }
      throw new Error("filelist-queued file never landed on disk");
    } finally {
      server.stop();
    }
  });

  test("ranged multi-stream enhancement: byte-exact assembly across parallel Range requests", async () => {
    Cvar_ForceSet("cl_http_range_threshold", "100");
    Cvar_ForceSet("cl_http_range_streams", "4");
    const content = fabricate(10000);
    const server = startMockServer(new Map([[`${BASEDIRNAME}/maps/big.bsp`, content]]), { rangeSupport: true });
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("maps/big.bsp", "single");
      const ok = await done;
      expect(ok).toBe(true);

      const onDisk = FS_ReadRawFile(join(tmpRoot, BASEDIRNAME, "maps/big.bsp"));
      expect(onDisk).not.toBeNull();
      expect(Buffer.from(onDisk!).equals(Buffer.from(content))).toBe(true);

      // 4 streams were actually used, not a disguised single-stream fetch
      expect(server.rangeRequests.length).toBe(4);
    } finally {
      server.stop();
    }
  });

  test("ranged multi-stream enhancement: single-stream fallback when the server doesn't advertise Range support", async () => {
    Cvar_ForceSet("cl_http_range_threshold", "100");
    Cvar_ForceSet("cl_http_range_streams", "4");
    const content = fabricate(10000);
    const server = startMockServer(new Map([[`${BASEDIRNAME}/maps/big.bsp`, content]]), { rangeSupport: false });
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("maps/big.bsp", "single");
      const ok = await done;
      expect(ok).toBe(true);

      const onDisk = FS_ReadRawFile(join(tmpRoot, BASEDIRNAME, "maps/big.bsp"));
      expect(onDisk).not.toBeNull();
      expect(Buffer.from(onDisk!).equals(Buffer.from(content))).toBe(true);
      expect(server.rangeRequests.length).toBe(0); // no Range header was ever honored/sent as split requests
    } finally {
      server.stop();
    }
  });

  test("ranged multi-stream enhancement: clean single-stream fallback when a server lies about Range support", async () => {
    Cvar_ForceSet("cl_http_range_threshold", "100");
    Cvar_ForceSet("cl_http_range_streams", "4");
    const content = fabricate(10000);
    const server = startLyingRangeServer(new Map([[`${BASEDIRNAME}/maps/big.bsp`, content]]));
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("maps/big.bsp", "single");
      const ok = await done;
      expect(ok).toBe(true);

      const onDisk = FS_ReadRawFile(join(tmpRoot, BASEDIRNAME, "maps/big.bsp"));
      expect(onDisk).not.toBeNull();
      expect(Buffer.from(onDisk!).equals(Buffer.from(content))).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("small files under the range threshold always use a single stream", async () => {
    Cvar_ForceSet("cl_http_range_threshold", "1048576");
    const content = fabricate(500);
    const server = startMockServer(new Map([[`${BASEDIRNAME}/sound/tiny.wav`, content]]), { rangeSupport: true });
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("sound/tiny.wav", "single");
      const ok = await done;
      expect(ok).toBe(true);
      expect(server.rangeRequests.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("UDP fallback trigger: a per-file HTTP failure (404) resolves false and invokes the injected UDP fallback", async () => {
    const server = startMockServer(new Map(), { rangeSupport: false }); // every path 404s
    const fallbackCalls: string[] = [];
    HTTP_SetCallbacks({ udpFallback: (path) => fallbackCalls.push(path), onSettled: () => {} });
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("sound/missing.wav", "single");
      const ok = await done;
      expect(ok).toBe(false);
      expect(fallbackCalls).toEqual(["sound/missing.wav"]);
    } finally {
      server.stop();
    }
  });

  test("onSettled fires once per completed transfer, mirroring CL_RequestNextDownload re-drive", async () => {
    let settledCount = 0;
    HTTP_SetCallbacks({ udpFallback: () => {}, onSettled: () => settledCount++ });
    const content = bytesOf("X");
    const server = startMockServer(new Map([[`${BASEDIRNAME}/sound/a.wav`, content]]), { rangeSupport: false });
    try {
      HTTP_SetServer(server.url, false);
      const { done } = HTTP_QueueDownload("sound/a.wav", "single");
      await done;
      expect(settledCount).toBe(1);
    } finally {
      server.stop();
    }
  });
});
