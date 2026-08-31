/*
Test for the live precache/download walk: src/client/cl_main.ts's
CL_RequestNextDownload/CL_Precache_f state machine, qfiles.ts's
readMd2SkinNames (the MD2 skin-name seam the walk uses), and the
pak-arrival rescan (files.ts's FS_AddPak, cl_http.ts's HTTP_RescanQueue,
cl_parse.ts's UDP-fallback pak detection).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: every global
this file reads (cvars, cl.configstrings, cls.csr/state, the module-private
precache_check state machine) is (re)initialized in beforeAll/beforeEach,
never assumed left over from another test file. The precache_check/
precache_model_skin/etc. state itself is module-private in cl_main.ts and
unreachable directly -- each test resets it the same way the real engine
does, by executing the "precache" console command (CL_Precache_f), and
drives it forward the same way the real engine's download-completion
callbacks do, by calling CL_RequestNextDownload() again after placing the
missing file on disk.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { Cmd_ExecuteString } from "../src/qcommon/cmd";
import { SZ_Init, SZ_Clear, SZ_Write } from "../src/qcommon/sizebuf";
import { MAX_MSGLEN } from "../src/qcommon/qcommon";
import { FS_InitFilesystem, FS_SetGamedir, FS_WriteFile, FS_LoadFile, FS_AddPak } from "../src/qcommon/files";
import { BASEDIRNAME } from "../src/qcommon/qcommon";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { SV_Init } from "../src/server/sv_main";

import { cl, cls, ConnstateT } from "../src/client/client";
import { CL_InitLocal, CL_RequestNextDownload } from "../src/client/cl_main";
import { HTTP_Init, HTTP_SetServer, HTTP_SetCallbacks, HTTP_CleanupDownloads, HTTP_QueueDownload, HTTP_RescanQueue } from "../src/client/cl_http";
import { CL_ParseDownload, CL_StartUdpDownload } from "../src/client/cl_parse";
import { readMd2SkinNames, MD2_IDENT, MD2_VERSION, MD2_MAX_SKINNAME } from "../src/qcommon/qfiles";
import { MSG_WriteShort, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";

// ===========================================================================
// group 1: readMd2SkinNames -- pure unit tests against hand-built model bytes
// ===========================================================================

function buildMd2(opts: { ident?: number; version?: number; skins: string[] }): Uint8Array {
  const ident = opts.ident ?? MD2_IDENT;
  const version = opts.version ?? MD2_VERSION;
  const numSkins = opts.skins.length;
  const headerSize = 68;
  const ofsSkins = headerSize;
  const buf = new Uint8Array(ofsSkins + numSkins * MD2_MAX_SKINNAME);
  const view = new DataView(buf.buffer);
  view.setInt32(0, ident, true);
  view.setInt32(4, version, true);
  view.setInt32(20, numSkins, true); // num_skins
  view.setInt32(44, ofsSkins, true); // ofs_skins
  for (let i = 0; i < numSkins; i++) {
    const name = opts.skins[i];
    for (let j = 0; j < name.length; j++) buf[ofsSkins + i * MD2_MAX_SKINNAME + j] = name.charCodeAt(j);
  }
  return buf;
}

describe("qfiles.ts -- readMd2SkinNames", () => {
  test("extracts multiple skin names in order", () => {
    const buf = buildMd2({ skins: ["players/grunt/grunt.pcx", "players/grunt/pain.pcx"] });
    expect(readMd2SkinNames(buf)).toEqual(["players/grunt/grunt.pcx", "players/grunt/pain.pcx"]);
  });

  test("a model with zero skins returns an empty array, not null", () => {
    const buf = buildMd2({ skins: [] });
    expect(readMd2SkinNames(buf)).toEqual([]);
  });

  test("rejects a bad ident (not an alias model)", () => {
    const buf = buildMd2({ ident: 0x12345678, skins: ["a"] });
    expect(readMd2SkinNames(buf)).toBeNull();
  });

  test("rejects a bad/unsupported version", () => {
    const buf = buildMd2({ version: 99, skins: ["a"] });
    expect(readMd2SkinNames(buf)).toBeNull();
  });

  test("rejects a buffer too small to hold a full header", () => {
    expect(readMd2SkinNames(new Uint8Array(10))).toBeNull();
  });

  test("rejects a num_skins/ofs_skins pair that would read past the end of the buffer (malicious/truncated download)", () => {
    const buf = buildMd2({ skins: ["a"] });
    const view = new DataView(buf.buffer);
    view.setInt32(20, 9999, true); // claim far more skins than the buffer holds
    expect(readMd2SkinNames(buf)).toBeNull();
  });
});

// ===========================================================================
// group 2: files.ts FS_AddPak
// ===========================================================================

function buildPak(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const PACKFILE_NAME_LEN = 56;
  const DPACKFILE_SIZE = PACKFILE_NAME_LEN + 8;
  const headerSize = 12;
  let dataSize = 0;
  for (const e of entries) dataSize += e.data.length;
  const dirLen = entries.length * DPACKFILE_SIZE;
  const total = headerSize + dataSize + dirLen;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // 'P','A','C','K' little-endian
  view.setUint8(0, "P".charCodeAt(0));
  view.setUint8(1, "A".charCodeAt(0));
  view.setUint8(2, "C".charCodeAt(0));
  view.setUint8(3, "K".charCodeAt(0));
  const dirOfs = headerSize + dataSize;
  view.setInt32(4, dirOfs, true);
  view.setInt32(8, dirLen, true);

  let dataCursor = headerSize;
  let dirCursor = dirOfs;
  for (const e of entries) {
    buf.set(e.data, dataCursor);
    for (let j = 0; j < e.name.length; j++) buf[dirCursor + j] = e.name.charCodeAt(j);
    view.setInt32(dirCursor + PACKFILE_NAME_LEN, dataCursor, true);
    view.setInt32(dirCursor + PACKFILE_NAME_LEN + 4, e.data.length, true);
    dataCursor += e.data.length;
    dirCursor += DPACKFILE_SIZE;
  }
  return buf;
}

describe("files.ts -- FS_AddPak", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2precache-pak-"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir(BASEDIRNAME);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("mounts a valid pak and its contents become visible to FS_LoadFile", () => {
    const content = new TextEncoder().encode("FABRICATED-PAK-CONTENT");
    const pak = buildPak([{ name: "sound/misc/fromapak.wav", data: content }]);
    const diskPath = join(tmpRoot, "downloaded.pak");
    FS_WriteFile(diskPath, pak);

    expect(FS_LoadFile("sound/misc/fromapak.wav")).toBeNull();
    expect(FS_AddPak(diskPath)).toBe(true);
    const loaded = FS_LoadFile("sound/misc/fromapak.wav");
    expect(loaded).not.toBeNull();
    expect(new TextDecoder().decode(loaded!)).toBe("FABRICATED-PAK-CONTENT");
  });

  test("declines (returns false) a corrupt pak instead of crashing the client", () => {
    const diskPath = join(tmpRoot, "corrupt.pak");
    FS_WriteFile(diskPath, new Uint8Array([1, 2, 3, 4, 5]));
    expect(() => FS_AddPak(diskPath)).not.toThrow();
    expect(FS_AddPak(diskPath)).toBe(false);
  });

  test("declines a missing file path", () => {
    expect(FS_AddPak(join(tmpRoot, "does-not-exist.pak"))).toBe(false);
  });
});

// ===========================================================================
// group 3: cl_http.ts HTTP_RescanQueue
// ===========================================================================

describe("cl_http.ts -- HTTP_RescanQueue (Q2PRO rescan_queue port)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2precache-rescan-"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir(BASEDIRNAME);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    HTTP_CleanupDownloads();
    HTTP_Init();
    HTTP_SetCallbacks({ udpFallback: () => {}, onSettled: () => {} });
    Cvar_ForceSet("cl_http_filelists", "0");
  });

  test("a queued-but-not-yet-dispatched entry is resolved done once its path exists on disk (no HTTP fetch)", async () => {
    // cl_http_max_connections=1 leaves the second queued entry genuinely
    // "pending" (never dispatched) while the first occupies the one slot --
    // HTTP_QueueDownload's own pump() call dispatches immediately, so
    // without this the entry under test would already be "running"/settled
    // by the time HTTP_RescanQueue runs below.
    Cvar_ForceSet("cl_http_max_connections", "1");
    HTTP_SetServer("http://127.0.0.1:1/", false); // deliberately unreachable
    const filler = HTTP_QueueDownload("sound/misc/filler.wav", "single"); // occupies the only connection slot
    const { done } = HTTP_QueueDownload("sound/misc/already-there.wav", "single");

    // simulate the file having landed on disk via some other mechanism
    // (in real play: contained inside a pak that just got mounted)
    FS_WriteFile(join(tmpRoot, BASEDIRNAME, "sound/misc/already-there.wav"), new TextEncoder().encode("X"));

    HTTP_RescanQueue();
    const ok = await done;
    expect(ok).toBe(true); // resolved by the rescan, never touched the unreachable server

    // drain the filler's own (failing) fetch before this test ends -- its
    // eventual settlement calls pump() again, and a still-pending orphan
    // left running past this test would corrupt the NEXT test's activeCount
    // bookkeeping (both share cl_http.ts's module-level state).
    if (filler.done) await filler.done;
  });

  test("leaves a still-missing entry pending", async () => {
    // A real-but-unreachable address (127.0.0.1:1) fails fast enough
    // (sub-millisecond ECONNREFUSED on loopback) that the filler entry
    // above would settle -- and pump() would dispatch the second entry
    // anyway -- before any assertion window could observe "still pending".
    // A mock server whose handler never resolves keeps the filler entry
    // genuinely "running" forever, which is what actually keeps
    // cl_http_max_connections=1 from ever letting the second entry dispatch.
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      Cvar_ForceSet("cl_http_max_connections", "1");
      HTTP_SetServer(`http://127.0.0.1:${server.port}/`, false);
      HTTP_QueueDownload("sound/misc/filler2.wav", "single"); // occupies the only connection slot, forever
      const { done } = HTTP_QueueDownload("sound/misc/still-missing.wav", "single");
      if (done === null) throw new Error("expected a queued download to have a done promise");
      let settled = false;
      void done.then(() => (settled = true));

      HTTP_RescanQueue();
      await Bun.sleep(5);
      expect(settled).toBe(false);
    } finally {
      // aborts the hung filler fetch too (HTTP_CleanupDownloads walks every
      // non-done entry's controller), so nothing outlives this test.
      HTTP_CleanupDownloads();
      server.stop(true);
    }
  });

  test("a pak completing over real HTTP mounts it and resolves a same-queue pending entry without ever fetching it", async () => {
    const inner = new TextEncoder().encode("FROM-THE-REAL-PAK");
    const pak = buildPak([{ name: "sound/misc/frompak.wav", data: inner }]);
    const requestedPaths: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
        requestedPaths.push(path);
        if (path === `${BASEDIRNAME}/extra.pak`) return new Response(pak, { status: 200, headers: { "content-length": String(pak.length) } });
        return new Response("not found", { status: 404 });
      },
    });

    try {
      // cl_http_max_connections=1, plus pump()'s own "stop handing out new
      // slots once we hit a pak that isn't finished yet" rule (cl_http.ts,
      // ported from Q2PRO's start_next_download comment), keeps the second
      // entry genuinely pending behind the first (a "pak"-typed entry)
      // until the pak's own transfer settles.
      Cvar_ForceSet("cl_http_max_connections", "1");
      HTTP_SetServer(`http://127.0.0.1:${server.port}/`, false);
      HTTP_QueueDownload("extra.pak", "pak");
      const { done: otherDone } = HTTP_QueueDownload("sound/misc/frompak.wav", "single");

      const ok = await otherDone;
      expect(ok).toBe(true);
      expect(requestedPaths).not.toContain(`${BASEDIRNAME}/sound/misc/frompak.wav`); // resolved by the rescan, never fetched directly

      const onDisk = FS_LoadFile("sound/misc/frompak.wav");
      expect(onDisk).not.toBeNull();
      expect(new TextDecoder().decode(onDisk!)).toBe("FROM-THE-REAL-PAK");
    } finally {
      server.stop(true);
    }
  });
});

// ===========================================================================
// group 4: the live precache/download walk (cl_main.ts CL_RequestNextDownload)
// ===========================================================================

describe("cl_main.ts -- CL_RequestNextDownload precache walk", () => {
  let tmpRoot: string;
  let mapChecksum = 0;
  const MAP_NAME = "maps/precachetest.bsp";

  beforeAll(async () => {
    const { buildBoxRoomBsp } = await import("./support/bsp_builder");

    tmpRoot = mkdtempSync(join(tmpdir(), "q2precache-walk-"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir(BASEDIRNAME);

    FS_WriteFile(join(tmpRoot, BASEDIRNAME, MAP_NAME), buildBoxRoomBsp(undefined, { renderable: true }));

    SV_Init(); // registers allow_download* cvars (this unit reads them, doesn't set them up)
    CL_InitLocal(); // registers the "precache" command CL_Precache_f drives

    const loaded = CM_LoadMap(MAP_NAME, true);
    mapChecksum = loaded.checksum;

    SZ_Init(cls.netchan.message, new Uint8Array(MAX_MSGLEN), MAX_MSGLEN);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // every downloadable-content subfolder is wiped between tests -- tests
    // write into these to simulate "file present"/"file missing", and
    // leftovers from an earlier test (e.g. "happy path"'s textures/wall.wal)
    // would silently satisfy a later test's "this file is missing" setup.
    // maps/ is deliberately NOT wiped: the fixture map is written once in
    // beforeAll and reused read-only by every test.
    for (const dir of ["models", "sound", "pics", "players", "env", "textures"]) {
      rmSync(join(tmpRoot, BASEDIRNAME, dir), { recursive: true, force: true });
    }

    for (let i = 0; i < cl.configstrings.length; i++) cl.configstrings[i] = "";
    cls.csr = CS_REMAP_OLD;
    cls.state = ConnstateT.ca_connected;
    cls.downloadname = "";
    cls.downloadtempname = "";
    cls.download = null;
    cls.downloadnumber = 0;
    SZ_Clear(cls.netchan.message);

    cl.configstrings[cls.csr.models + 1] = MAP_NAME;
    cl.configstrings[cls.csr.mapchecksum] = String(mapChecksum);

    Cvar_ForceSet("allow_download", "1");
    Cvar_ForceSet("allow_download_players", "0");
    Cvar_ForceSet("allow_download_models", "1");
    Cvar_ForceSet("allow_download_sounds", "1");
    Cvar_ForceSet("allow_download_maps", "1");

    // No HTTP server for the plain state-machine tests below (each drives
    // CL_CheckOrDownloadFile's UDP path directly via cls.downloadname) --
    // guards against a downloadServer left set by group 3's HTTP_SetServer
    // calls bleeding into these (module-level state in cl_http.ts).
    HTTP_CleanupDownloads();
  });

  function provideFile(relPath: string, content = "X"): void {
    FS_WriteFile(join(tmpRoot, BASEDIRNAME, relPath), new TextEncoder().encode(content));
  }

  function begin(): void {
    Cmd_ExecuteString("precache 1");
  }

  // The walk always runs the env/sky and texture phases regardless of what
  // else was configured (they're gated on allow_download_maps, not on
  // whether any model/sound/image was missing) -- a truly complete "nothing
  // to download" pass needs these too, since the fixture map's blank sky
  // configstring resolves to "env/rt.tga" etc. and its 7 texinfo entries
  // are all named "wall" (test/support/bsp_builder.ts).
  function provideEnvAndTextures(): void {
    for (const suf of ["rt", "bk", "lf", "ft", "up", "dn"]) {
      provideFile(`env/${suf}.tga`);
      provideFile(`env/${suf}.pcx`);
    }
    provideFile("textures/wall.wal");
  }

  test("happy path: everything already present -> the walk completes and sends 'begin 1' without starting any download", () => {
    provideEnvAndTextures();
    begin();
    expect(cls.downloadname).toBe(""); // no download was ever started
    const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
    expect(text.includes("begin 1")).toBe(true);
  });

  test("confirm-map phase: a missing map file is requested via CL_CheckOrDownloadFile before anything else", () => {
    cl.configstrings[cls.csr.models + 1] = "maps/missing.bsp";
    begin();
    expect(cls.downloadname).toBe("maps/missing.bsp");
  });

  test("model walk: requests a missing non-map model and skips '*' (inline) and '#' (localized) entries", () => {
    cl.configstrings[cls.csr.models + 2] = "*1"; // inline brush model, always skipped
    cl.configstrings[cls.csr.models + 3] = "#special"; // localized/special, always skipped
    cl.configstrings[cls.csr.models + 4] = "models/objects/gib/thing.md2";
    begin();
    expect(cls.downloadname).toBe("models/objects/gib/thing.md2");
  });

  test("model walk: extracts skin names from a fabricated MD2 and requests a missing one", () => {
    cl.configstrings[cls.csr.models + 2] = "models/monsters/soldier/tris.md2";
    provideFile("models/monsters/soldier/tris.md2");
    // overwrite with a real MD2 header carrying two skin references
    const md2 = buildMd2({ skins: ["models/monsters/soldier/skin.pcx", "models/monsters/soldier/pain.pcx"] });
    FS_WriteFile(join(tmpRoot, BASEDIRNAME, "models/monsters/soldier/tris.md2"), md2);
    provideFile("models/monsters/soldier/skin.pcx"); // first skin present, second missing

    begin();
    expect(cls.downloadname).toBe("models/monsters/soldier/pain.pcx");
  });

  test("model walk: a corrupt/non-alias model file is skipped without hanging the walk", () => {
    Cvar_ForceSet("allow_download_maps", "0"); // isolate: this test is about the model/skin scan, not env/textures
    cl.configstrings[cls.csr.models + 2] = "models/objects/bad/tris.md2";
    provideFile("models/objects/bad/tris.md2", "NOT-AN-MD2-FILE");
    begin();
    // nothing else to download (map/model both present, nothing further
    // configured) -- the walk must run all the way to completion, not get
    // stuck re-requesting the same bad file forever.
    expect(cls.downloadname).toBe("");
    const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
    expect(text.includes("begin 1")).toBe(true);
  });

  test("sound walk: skips sexed ('*'-prefixed) sound configstrings and requests sound/<name> for a plain one", () => {
    cl.configstrings[cls.csr.sounds + 1] = "*pain100_1.wav"; // sexed, never downloaded by index
    cl.configstrings[cls.csr.sounds + 2] = "world/switch1.wav";
    begin();
    expect(cls.downloadname).toBe("sound/world/switch1.wav");
  });

  test("image walk: requests pics/<name>.pcx for a missing image", () => {
    cl.configstrings[cls.csr.images + 1] = "i_health";
    begin();
    expect(cls.downloadname).toBe("pics/i_health.pcx");
  });

  test("player-skin walk: requests model, weapon model, weapon skin, skin, then skin_i in order", () => {
    Cvar_ForceSet("allow_download_players", "1");
    cl.configstrings[cls.csr.playerskins + 0] = "TestBot\\grunt/distress";

    begin();
    expect(cls.downloadname).toBe("players/grunt/tris.md2");
    provideFile("players/grunt/tris.md2");

    CL_RequestNextDownload();
    expect(cls.downloadname).toBe("players/grunt/weapon.md2");
    provideFile("players/grunt/weapon.md2");

    CL_RequestNextDownload();
    expect(cls.downloadname).toBe("players/grunt/weapon.pcx");
    provideFile("players/grunt/weapon.pcx");

    CL_RequestNextDownload();
    expect(cls.downloadname).toBe("players/grunt/distress.pcx");
    provideFile("players/grunt/distress.pcx");

    CL_RequestNextDownload();
    expect(cls.downloadname).toBe("players/grunt/distress_i.pcx");
  });

  test("player-skin walk: q2repro sexed-sound download requested after skin_i completes", () => {
    // Pin every allow_download* this walk consults (rule 13): the cvar
    // parity audit moved several defaults to q2repro's values, and this
    // test previously leaned on registration defaults instead of setting
    // its own.
    Cvar_ForceSet("allow_download", "1");
    Cvar_ForceSet("allow_download_sounds", "1");
    Cvar_ForceSet("allow_download_players", "1");
    cl.configstrings[cls.csr.playerskins + 0] = "TestBot\\grunt/distress";
    cl.configstrings[cls.csr.sounds + 7] = "*pain100_1.wav";

    provideFile("players/grunt/tris.md2");
    provideFile("players/grunt/weapon.md2");
    provideFile("players/grunt/weapon.pcx");
    provideFile("players/grunt/distress.pcx");
    provideFile("players/grunt/distress_i.pcx");

    begin();
    // The walk now interposes q2repro's dogtag download between skin_i and
    // the sexed sounds (download.c:575-576; the skinstring has no dogtag
    // field, so it resolves to "default") -- added with the skin_i/dogtag
    // resume latches that fixed the infinite re-request loop self-play
    // cell f exposed. Serve it, then the sexed sound follows.
    expect(cls.downloadname).toBe("tags/default.pcx");
    provideFile("tags/default.pcx");

    CL_RequestNextDownload();
    expect(cls.downloadname).toBe("players/grunt/pain100_1.wav");
  });

  test("player-skin walk: a blank playerskin slot is skipped entirely", () => {
    Cvar_ForceSet("allow_download_players", "1");
    Cvar_ForceSet("allow_download_maps", "0"); // isolate: this test is about the player-skin scan, not env/textures
    // every playerskin slot left blank -- the walk must reach completion
    // ("begin") instead of trying to download anything for an empty player.
    begin();
    expect(cls.downloadname).toBe("");
    const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
    expect(text.includes("begin 1")).toBe(true);
  });

  test("env/sky phase: requests env/<sky><suf>.tga then .pcx for each of the 6 faces, in order, when NEITHER extension exists", () => {
    cl.configstrings[2] = "unit1_"; // CS_SKY (fixed index 2, not per-family)
    begin();
    expect(cls.downloadname).toBe("env/unit1_rt.tga");
    provideFile("env/unit1_rt.tga");

    CL_RequestNextDownload();
    // env/unit1_rt.pcx does NOT get downloaded here even though it's
    // individually missing on disk: rt.tga (just provided above) already
    // satisfies it, mirroring "vanilla's env loop" treating .tga/.pcx as
    // interchangeable for a given skybox face -- see
    // fileExistsUnderAlternateExtension's own header in cl_parse.ts (live
    // defect B fix). The walk instead advances straight to the next face.
    expect(cls.downloadname).toBe("env/unit1_bk.tga");
  });

  // Live defect B (task report): pics/loc_ping.pcx and pics/friend.pcx ship
  // in the retail data only as .png; env/unit1_*.pcx ships only as .tga.
  // Before the fix, CL_CheckOrDownloadFile's exact-name existence check
  // queued a download for each of these even though the renderer
  // (gl_image.ts's GL_FindImage) would have found the alternate-extension
  // file on its own.
  test("image walk: a missing .pcx is satisfied by an existing .png sibling -- no download queued (GL_FindImage's own fallback order)", () => {
    cl.configstrings[cls.csr.images + 1] = "loc_ping";
    provideFile("pics/loc_ping.png");
    provideEnvAndTextures();

    begin();
    expect(cls.downloadname).toBe(""); // no download was ever started
    const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
    expect(text.includes("begin 1")).toBe(true);
  });

  test("image walk: a missing .pcx with only a .tga sibling is also satisfied (GL_FindImage's second fallback extension)", () => {
    cl.configstrings[cls.csr.images + 1] = "friend";
    provideFile("pics/friend.tga");
    provideEnvAndTextures();

    begin();
    expect(cls.downloadname).toBe("");
  });

  test("image walk: neither the exact .pcx nor any alternate extension exists -- still downloads the exact name", () => {
    cl.configstrings[cls.csr.images + 1] = "genuinely_missing";
    begin();
    expect(cls.downloadname).toBe("pics/genuinely_missing.pcx");
  });

  // Live bug fix (task report, .orch/followups.md finding 3(a)/8): Mike's
  // console showed "Downloading pics/sprites/flare_01.tga.pcx / Server does
  // not have this file" -- misc_flare's `image` spawn key
  // (kexgame/g_misc.ts's SP_misc_flare) writes a full path WITH its own
  // extension into a CS_IMAGES configstring via gi.imageindex(), and the
  // walk used to build "pics/<name>.pcx" unconditionally, producing a
  // double extension nothing can ever resolve to. Ported from q2repro's own
  // CL_RequestNextDownload (src/client/download.c:714-729): under the
  // classic (OLD) family this special case does not exist at all --
  // q2repro's own check is `cl.csr.extended && ...` -- so a subdir+extension
  // name still gets the classic "pics/<name>.pcx" treatment there.
  test("image walk (classic family): a CS_IMAGES entry that already carries a subdir+extension still gets pics/<name>.pcx appended (the skip is extended-family only)", () => {
    cl.configstrings[cls.csr.images + 1] = "sprites/flare_01.tga";
    begin();
    expect(cls.downloadname).toBe("pics/sprites/flare_01.tga.pcx");
  });

  describe("image walk (rerelease/extended family): CS_IMAGES entries carrying their own extension", () => {
    // The outer beforeEach above always resets cls.csr to CS_REMAP_OLD and
    // writes the fixture map's configstrings at the OLD family's indices;
    // switching families mid-test means re-anchoring those same two
    // configstrings at the RERELEASE family's (different) indices too, or
    // the unconditional CM_LoadMap in the walk's ENV_CNT phase reads an
    // empty map name.
    function switchToExtendedFamily(): void {
      cls.csr = CS_REMAP_RERELEASE;
      cl.configstrings[cls.csr.models + 1] = MAP_NAME;
      cl.configstrings[cls.csr.mapchecksum] = String(mapChecksum);
    }

    test("live bug repro: misc_flare's 'sprites/flare_01.tga' is skipped entirely -- no download, no double extension, walk still completes", () => {
      switchToExtendedFamily();
      cl.configstrings[cls.csr.images + 1] = "sprites/flare_01.tga";
      provideEnvAndTextures();

      begin();
      expect(cls.downloadname).toBe(""); // no download was ever started
      const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
      expect(text.includes("begin 1")).toBe(true);
    });

    test("a subdir+extension name with NO slash is NOT skipped -- q2repro's own check requires strchr(name, '/') too", () => {
      switchToExtendedFamily();
      // no "/" anywhere in the name -- fails the "subdir" half of the check
      cl.configstrings[cls.csr.images + 1] = "flare_01.tga";
      begin();
      expect(cls.downloadname).toBe("pics/flare_01.tga.pcx");
    });

    test("a bare name with no extension is unaffected -- still builds pics/<name>.pcx", () => {
      switchToExtendedFamily();
      cl.configstrings[cls.csr.images + 1] = "i_health";
      begin();
      expect(cls.downloadname).toBe("pics/i_health.pcx");
    });

    test("leading '/' escape syntax: name used verbatim, no pics/ prefix and no forced extension", () => {
      switchToExtendedFamily();
      cl.configstrings[cls.csr.images + 1] = "/sprites/direct.tga";
      begin();
      expect(cls.downloadname).toBe("sprites/direct.tga");
    });

    test("leading '\\\\' escape syntax behaves the same as '/'", () => {
      switchToExtendedFamily();
      cl.configstrings[cls.csr.images + 1] = "\\sprites\\direct.tga";
      begin();
      expect(cls.downloadname).toBe("sprites\\direct.tga");
    });
  });

  test("env/sky phase: a missing .pcx is satisfied by an existing .tga sibling for the SAME face -- no download queued", () => {
    cl.configstrings[2] = "unit1_";
    provideFile("env/unit1_rt.tga");
    provideFile("env/unit1_bk.tga");
    provideFile("env/unit1_lf.tga");
    provideFile("env/unit1_ft.tga");
    provideFile("env/unit1_up.tga");
    provideFile("env/unit1_dn.tga");
    provideFile("textures/wall.wal");

    begin();
    // every face's .tga exists, so every face's .pcx is satisfied by it too
    expect(cls.downloadname).toBe("");
    const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
    expect(text.includes("begin 1")).toBe(true);
  });

  test("env/sky phase: a missing .tga with only a .pcx sibling for that face is also satisfied (the reverse direction)", () => {
    cl.configstrings[2] = "unit1_";
    for (const suf of ["rt", "bk", "lf", "ft", "up", "dn"]) provideFile(`env/unit1_${suf}.pcx`);
    provideFile("textures/wall.wal");

    begin();
    expect(cls.downloadname).toBe("");
  });

  test("texture phase: requests textures/<name>.wal for the map's texinfo once the env phase is satisfied", () => {
    cl.configstrings[2] = ""; // blank sky -- env_suf paths become "env/rt.tga" etc., still fine
    for (const suf of ["rt", "bk", "lf", "ft", "up", "dn"]) {
      provideFile(`env/${suf}.tga`);
      provideFile(`env/${suf}.pcx`);
    }
    begin();
    expect(cls.downloadname).toBe("textures/wall.wal");
  });

  test("cl_parse.ts CL_ParseDownload: a .pak arriving via the UDP fallback path is mounted (files.ts FS_AddPak)", () => {
    // build a pak and drive it through CL_StartUdpDownload + CL_ParseDownload
    // exactly like a real "download some.pak" server reply would.
    const inner = new TextEncoder().encode("FROM-THE-PAK");
    const pak = buildPak([{ name: "sound/misc/inpak.wav", data: inner }]);

    CL_StartUdpDownload("extra.pak");
    expect(cls.downloadname).toBe("extra.pak");

    // fabricate the server's "download" reply: a single 100%-complete block
    SZ_Clear(net_message);
    MSG_WriteShort(net_message, pak.length);
    MSG_WriteByte(net_message, 100); // percent
    SZ_Write(net_message, pak, pak.length);
    net_message.readcount = 0;
    CL_ParseDownload();

    expect(FS_LoadFile("extra.pak")).not.toBeNull();
    // the pak's own contents are now visible through the mounted pack --
    // proof CL_ParseDownload's ".pak"-extension detection called FS_AddPak,
    // not just renamed the file to its final name.
    const inPak = FS_LoadFile("sound/misc/inpak.wav");
    expect(inPak).not.toBeNull();
    expect(new TextDecoder().decode(inPak!)).toBe("FROM-THE-PAK");
  });
});

// ===========================================================================
// group 5: end-to-end -- a server advertises files the client lacks, over a
// real local HTTP server (same Bun.serve precedent as test/cl_http.test.ts),
// and the walk requests/downloads/completes.
// ===========================================================================

describe("end-to-end -- precache walk against a fabricated HTTP download server", () => {
  let tmpRoot: string;
  let mapChecksum = 0;
  const MAP_NAME = "maps/e2etest.bsp";

  beforeAll(async () => {
    const { buildBoxRoomBsp } = await import("./support/bsp_builder");

    tmpRoot = mkdtempSync(join(tmpdir(), "q2precache-e2e-"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir(BASEDIRNAME);
    FS_WriteFile(join(tmpRoot, BASEDIRNAME, MAP_NAME), buildBoxRoomBsp());

    SV_Init();
    CL_InitLocal();
    mapChecksum = CM_LoadMap(MAP_NAME, true).checksum;

    SZ_Init(cls.netchan.message, new Uint8Array(MAX_MSGLEN), MAX_MSGLEN);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (let i = 0; i < cl.configstrings.length; i++) cl.configstrings[i] = "";
    cls.csr = CS_REMAP_OLD;
    cls.state = ConnstateT.ca_connected;
    cls.downloadname = "";
    cls.downloadtempname = "";
    SZ_Clear(cls.netchan.message);
    cl.configstrings[cls.csr.models + 1] = MAP_NAME;
    cl.configstrings[cls.csr.mapchecksum] = String(mapChecksum);

    Cvar_ForceSet("allow_download", "1");
    Cvar_ForceSet("allow_download_players", "0");
    Cvar_ForceSet("allow_download_models", "1");
    Cvar_ForceSet("allow_download_sounds", "1");
    // Isolates this test to the sound-download path: env/sky and texture
    // downloads (always attempted when allow_download_maps is on,
    // regardless of what else was missing) are covered by
    // cl_main.ts's own describe block above, not this one.
    Cvar_ForceSet("allow_download_maps", "0");
    Cvar_ForceSet("cl_http_filelists", "0");

    HTTP_CleanupDownloads();
    HTTP_Init();
  });

  test("a sound the client lacks is requested, HTTP-downloaded, and the walk completes", async () => {
    const content = new TextEncoder().encode("SERVER-PROVIDED-SOUND-BYTES");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
        if (path === `${BASEDIRNAME}/sound/world/e2e.wav`) return new Response(content, { status: 200, headers: { "content-length": String(content.length) } });
        return new Response("not found", { status: 404 });
      },
    });

    try {
      let settledCalls = 0;
      // mirrors cl_main.ts's own real wiring (HTTP_SetCallbacks({ ...,
      // onSettled: () => CL_RequestNextDownload() })) -- this test's whole
      // point is to prove that wiring drives the walk to completion, so it
      // has to actually call it, not just observe that it fired.
      HTTP_SetCallbacks({
        udpFallback: () => {},
        onSettled: () => {
          settledCalls++;
          CL_RequestNextDownload();
        },
      });
      HTTP_SetServer(`http://127.0.0.1:${server.port}/`, false);

      cl.configstrings[cls.csr.sounds + 1] = "world/e2e.wav";
      Cmd_ExecuteString("precache 1");
      expect(cls.downloadname).toBe(""); // HTTP path taken, not the UDP fallback

      // drive the walk forward the way onSettled really would, once the
      // real transfer resolves
      for (let i = 0; i < 200 && settledCalls === 0; i++) await Bun.sleep(5);
      expect(settledCalls).toBeGreaterThan(0);

      const onDisk = FS_LoadFile("sound/world/e2e.wav");
      expect(onDisk).not.toBeNull();
      expect(new TextDecoder().decode(onDisk!)).toBe("SERVER-PROVIDED-SOUND-BYTES");

      const text = new TextDecoder().decode(cls.netchan.message.data.subarray(0, cls.netchan.message.cursize));
      expect(text.includes("begin 1")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
