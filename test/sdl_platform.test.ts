// Force headless SDL before ANY import can reach the FFI layer: these tests
// must never open a real window or audio device on the host desktop.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
/*
The SDL backend (src/platform/sdl.ts) against the real system libSDL2,
driven headlessly through SDL's own dummy video and audio drivers, plus a
whole-client boot with `dedicated 0` over a synthetic map.

SDL_VIDEODRIVER/SDL_AUDIODRIVER are set here before anything can arm the
backend: sdl.ts dlopen()s lazily, so as long as no SDL entry point is called
above this assignment, SDL reads these on its first SDL_Init.
*/

Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SDLSND_Active,
  SDLSND_Close,
  SDLSND_ConsumedBytes,
  SDLSND_Open,
  SDLSND_Queue,
  SDLVID_Active,
  SDLVID_ExpandFrame,
  SDLVID_FramesPresented,
  SDLVID_Init,
  SDLVID_Present,
  SDLVID_Shutdown,
  SDL_BackendEnabled,
  SDL_GetActiveGameController,
  SDL_KeyToQuake,
  SDL_ResetBackendForTests,
  SDL_SetBackendEnabled,
} from "../src/platform/sdl";
import {
  K_ALT,
  K_BACKSPACE,
  K_CTRL,
  K_DEL,
  K_ENTER,
  K_ESCAPE,
  K_F1,
  K_KP_ENTER,
  K_MWHEELUP,
  K_PGUP,
  K_SHIFT,
  K_UPARROW,
} from "../src/client/keys";
import { cvar_vars, Cvar_ForceSet, Cvar_VariableValue } from "../src/qcommon/cvar";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";
import { NET_ClearLoopback, NET_Shutdown } from "../src/platform/net_udp";
import { SV_Shutdown } from "../src/server/sv_main";
import { sv, ServerStateT } from "../src/server/server";
import { cl, cls, ConnstateT, setRe } from "../src/client/client";
import { Qcommon_Init, Qcommon_Frame } from "../src/main";
import { CL_Frame } from "../src/client/cl_main";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import { buildColormapPcx } from "./support/colormap_builder";

const SMOKE_ENTITIES = ['{\n"classname" "worldspawn"\n"message" "sdl smoke"\n}\n', '{\n"classname" "info_player_start"\n"origin" "0 0 -32"\n"angle" "0"\n}\n'].join("");

describe("src/platform/sdl.ts -- palette expansion and keymap (no SDL needed)", () => {
  test("SDLVID_ExpandFrame turns 8-bit indices into RGBA through the padded xRGB palette", () => {
    // 2x2 frame, stride wider than the visible width so the row padding the
    // C surface allows is exercised
    const rowbytes = 4;
    const buffer = new Uint8Array([1, 2, 0xee, 0xee, 3, 0, 0xee, 0xee]);
    const palette = new Uint8Array(1024);
    // index 0 = black, 1 = red, 2 = green, 3 = blue (R,G,B,pad)
    palette.set([0, 0, 0, 0], 0);
    palette.set([255, 0, 0, 0], 4);
    palette.set([0, 255, 0, 0], 8);
    palette.set([0, 0, 255, 0], 12);

    const out = new Uint8Array(2 * 2 * 4);
    SDLVID_ExpandFrame(buffer, rowbytes, 2, 2, palette, out);

    expect(Array.from(out)).toEqual([
      255, 0, 0, 255, // (0,0) index 1 -> red
      0, 255, 0, 255, // (1,0) index 2 -> green
      0, 0, 255, 255, // (0,1) index 3 -> blue
      0, 0, 0, 255, // (1,1) index 0 -> black
    ]);
  });

  test("SDL_KeyToQuake maps SDLK_* onto keys.h's K_* numbers", () => {
    expect(SDL_KeyToQuake(27)).toBe(K_ESCAPE); // SDLK_ESCAPE
    expect(SDL_KeyToQuake(13)).toBe(K_ENTER); // SDLK_RETURN
    expect(SDL_KeyToQuake(8)).toBe(K_BACKSPACE); // SDLK_BACKSPACE -> 127
    expect(SDL_KeyToQuake(127)).toBe(K_DEL); // SDLK_DELETE -> 148
    expect(SDL_KeyToQuake(1073741906)).toBe(K_UPARROW);
    expect(SDL_KeyToQuake(1073741882)).toBe(K_F1);
    expect(SDL_KeyToQuake(1073742049)).toBe(K_SHIFT); // SDLK_LSHIFT
    expect(SDL_KeyToQuake(1073742053)).toBe(K_SHIFT); // SDLK_RSHIFT
    expect(SDL_KeyToQuake(1073742048)).toBe(K_CTRL); // SDLK_LCTRL
    expect(SDL_KeyToQuake(1073742054)).toBe(K_ALT); // SDLK_RALT
    expect(SDL_KeyToQuake(1073741899)).toBe(K_PGUP);
    expect(SDL_KeyToQuake(1073741912)).toBe(K_KP_ENTER);

    // printable ASCII passes straight through, the way XLateKey leaves it
    expect(SDL_KeyToQuake(97)).toBe(97); // 'a'
    expect(SDL_KeyToQuake(32)).toBe(32); // space
    expect(SDL_KeyToQuake(96)).toBe(96); // '`', the console key

    // anything with no K_* number is dropped rather than forwarded
    expect(SDL_KeyToQuake(1073741881)).toBe(0); // SDLK_CAPSLOCK
    expect(SDL_KeyToQuake(0)).toBe(0);

    // the wheel is not a keycode; it is synthesized by the event pump
    expect(K_MWHEELUP).toBe(240);
  });

  test("the backend is disarmed until something asks for it", () => {
    expect(SDL_BackendEnabled()).toBe(false);
    expect(SDLVID_Init(320, 240, false)).toBe(false);
    expect(SDLVID_Active()).toBe(false);
  });

  // platform/haptics.ts's own ensureController reuses this getter instead
  // of opening a second SDL_GameController handle for the same physical
  // pad (this task's brief: "reuse ... do NOT duplicate") -- a controller-
  // less/disarmed backend must report null, never throw, so that reuse
  // path's own fallback (haptics.ts's independent scan) has a clean signal
  // to fall back on.
  test("SDL_GetActiveGameController is null with no controller open", () => {
    expect(SDL_GetActiveGameController()).toBeNull();
  });
});

describe("src/platform/sdl.ts -- real libSDL2 under the dummy drivers", () => {
  afterAll(() => {
    SDL_ResetBackendForTests();
  });

  test("the video pipeline comes up headless and a frame round-trips through it", () => {
    SDL_SetBackendEnabled(true);
    expect(SDLVID_Init(320, 240, false)).toBe(true);
    expect(SDLVID_Active()).toBe(true);

    const buffer = new Uint8Array(320 * 240);
    buffer.fill(7);
    const palette = new Uint8Array(1024);
    palette.set([12, 34, 56, 0], 7 * 4);

    expect(() => SDLVID_Present(buffer, 320, 320, 240, palette)).not.toThrow();

    // a mode change tears the old window/texture down and builds a new one
    expect(SDLVID_Init(640, 480, false)).toBe(true);
    expect(() => SDLVID_Present(new Uint8Array(640 * 480), 640, 640, 480, palette)).not.toThrow();

    SDLVID_Shutdown();
    expect(SDLVID_Active()).toBe(false);
  });

  test("the audio device opens, takes queued PCM, and reports what it consumed", () => {
    SDL_SetBackendEnabled(true);
    const obtained = SDLSND_Open(44100, 2, 16);
    expect(obtained).not.toBeNull();
    expect(obtained?.freq).toBe(44100);
    expect(obtained?.channels).toBe(2);
    expect(SDLSND_Active()).toBe(true);

    // consumed can only ever be what was queued or less
    const chunk = new Uint8Array(4096);
    SDLSND_Queue(chunk);
    const consumed = SDLSND_ConsumedBytes();
    expect(consumed).toBeGreaterThanOrEqual(0);
    expect(consumed).toBeLessThanOrEqual(chunk.length);

    SDLSND_Close();
    expect(SDLSND_Active()).toBe(false);
  });
});

describe("src/main.ts -- windowed client boot with dedicated 0", () => {
  let tmpRoot = "";
  let cvarSnapshot: CvarSnapshotT;

  beforeAll(() => {
    // rule 13 (process-wide singleton leak, closed at the source): this
    // boot's own throwaway "+set allow_download 0"/"+set s_initsound 0"
    // argv (below) can be the FIRST-ever registration of those cvar names
    // in the whole `bun test` process, in which case Cvar_Get's "first
    // registration wins the default" contract (src/qcommon/cvar.ts)
    // permanently locks their default_string at this test's own
    // deliberately-wrong override value -- observed breaking
    // test/cvar_parity.test.ts's manifest audit with "allow_download:
    // expected 1, got 0" when this file happens to run first. Snapshot
    // before ANY mutation and restore the whole registry in afterAll (see
    // test/support/cvar_snapshot.ts for why this is safe specifically for
    // a throwaway synthetic boot like this one).
    cvarSnapshot = snapshotCvars();

    tmpRoot = mkdtempSync(join(tmpdir(), "q2sdl-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(join(baseq2Dir, "maps"), { recursive: true });
    mkdirSync(join(baseq2Dir, "pics"), { recursive: true });
    // the renderable box room ref_frame.test.ts renders, plus the synthetic
    // colormap R_Init needs; no id Software game data is involved
    writeFileSync(join(baseq2Dir, "maps", "sdlsmoke.bsp"), buildBoxRoomBsp(SMOKE_ENTITIES, { renderable: true }));
    writeFileSync(join(baseq2Dir, "pics", "colormap.pcx"), buildColormapPcx());

    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "0");
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("s_initsound", "0");
    // rule 13: src/platform/vid.ts's VID_CheckChanges only (re)loads the
    // refresh module while `vid_ref.modified` is true, and clears it back
    // to false the moment a load succeeds (matching q2repro's real
    // cvar.c/vid.c exactly -- see vid.ts's own VID_CheckChanges comment).
    // That's correct for a real one-boot-per-process engine, where
    // vid_ref is always freshly Cvar_Get'd (modified=true at creation);
    // in this multi-boot-per-process test run, "vid_ref" is a process-
    // wide singleton (src/qcommon/cvar.ts's cvar_vars) another test's
    // earlier, successful client boot (e.g. test/cvar_parity.test.ts) can
    // leave registered with modified=false, which would make THIS boot's
    // own VID_CheckChanges silently skip loading the refresh and creating
    // a window at all. Pin this test's own precondition rather than rely
    // on whichever test happened to run before it.
    const vidRef = cvar_vars.get("vid_ref");
    if (vidRef) vidRef.modified = true;
  });

  afterAll(async () => {
    SV_Shutdown("sdl smoke test finished\n", false);
    NET_ClearLoopback();
    await NET_Shutdown();
    setRe(null);
    SDL_ResetBackendForTests();
    // rule 13/21 (regate hygiene, 2026-09-01): this describe block is a
    // REAL windowed client boot (dedicated 0) -- unlike this file's other,
    // narrower fixtures, real client subsystems run here and can lazily
    // register a cvar the first time some code path is reached, caching
    // the resulting CvarT reference in a module-level variable (src/client/
    // cgame/host.ts's cl_kfont_source/cl_kfont_ttf_size, the confirmed
    // case -- see test/support/cvar_snapshot.ts's own header comment for
    // the full story). Preserve those specific names from the general
    // delete-newly-registered sweep below (still needed for THIS boot's
    // own throwaway allow_download/s_initsound overrides) so host.ts's
    // cache never points at an orphaned, deleted CvarT object.
    restoreCvars(cvarSnapshot, true, ["cl_kfont_source", "cl_kfont_ttf_size"]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("Qcommon_Init brings up the real refresh through VID_Init and Qcommon_Frame runs the client", async () => {
    // the real command line from the goal: a windowed client on a map.
    // The "+map" late command is also what makes Qcommon_Init call
    // SCR_EndLoadingPlaque, which drops cls.disable_screen so the screen
    // actually draws.
    // allow_download=0: this test's synthetic map (bsp_builder) ships no
    // real player/gib/sound assets, and the game library's own worldspawn
    // precaching registers CS_MODELS/CS_SOUNDS entries regardless. Now that
    // cl_main.ts's CL_RequestNextDownload is a real precache/download walk
    // (previously a stub that unconditionally skipped straight to
    // CL_PrepRefresh), leaving downloads enabled here would stall the
    // client waiting on files this local test server can never supply,
    // instead of reaching CL_PrepRefresh the way this test expects
    // (`cl.refresh_prepped` below) -- see test/cl_main.test.ts's identical
    // fix for the same reason.
    Qcommon_Init(["quake2", "+set", "basedir", tmpRoot, "+set", "dedicated", "0", "+set", "port", "0", "+set", "coop", "1", "+set", "allow_download", "0", "+map", "sdlsmoke"]);

    expect(Cvar_VariableValue("dedicated")).toBe(0);
    expect(SDL_BackendEnabled()).toBe(true);
    // VID_Init -> VID_CheckChanges -> VID_LoadRefresh -> ref_soft's
    // GetRefAPI/R_Init, which is what creates the SDL window and its texture
    expect(SDLVID_Active()).toBe(true);

    for (let i = 0; i < 300 && sv.state !== ServerStateT.ss_game; i++) {
      Qcommon_Frame(100);
      await Bun.sleep(1);
    }
    expect(sv.state).toBe(ServerStateT.ss_game);

    // With a local server up, CL_CheckForResend connects the client to it
    // without a challenge, and the precache walk ends in CL_PrepRefresh
    // (the renderer loads maps/sdlsmoke.bsp) and a frame on the window.
    //
    // The server's own ClientBegin -> SV_Multicast -> CM_AreasConnected
    // throws on this synthetic map: bsp_builder's box room has no areas
    // lump, so map_areas is empty. That is a live sibling track's ground
    // (src/qcommon/cmodel.ts + test/support/bsp_builder.ts), the same place
    // test/cl_main.test.ts records as "stopped here", so it is caught and
    // reported rather than failing this suite -- the client-side subject of
    // this test has already run by then.
    let stoppedAt: string | null = null;
    for (let i = 0; i < 60 && cls.state !== ConnstateT.ca_active; i++) {
      try {
        Qcommon_Frame(100);
      } catch (err) {
        if (stoppedAt === null) stoppedAt = err instanceof Error ? err.message : String(err);
      }
      await Bun.sleep(1);
    }

    expect(cls.state).not.toBe(ConnstateT.ca_disconnected);
    expect(cl.refresh_prepped).toBe(true);

    // The server throws inside SV_Frame every time it retries that begin
    // command, which is ahead of CL_Frame in Qcommon_Frame, so the client
    // half of the frame is driven directly here: SCR_UpdateScreen ->
    // re.RenderFrame/EndFrame -> SWimp_EndFrame -> the SDL texture.
    for (let i = 0; i < 5; i++) CL_Frame(100);
    expect(SDLVID_FramesPresented()).toBeGreaterThan(0);
    expect(SDLVID_Active()).toBe(true);
    if (stoppedAt !== null) expect(stoppedAt).toContain("map_areas");
  });
});
