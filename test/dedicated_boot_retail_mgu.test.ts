/*
Dedicated boots of the two "Call of the Machine" maps the task brief names
by name -- mguhub (QBSP extended format) and mgu1m1 (QBSP extended format)
-- against REAL retail data (basedir pointed at the actual retail install,
no synthetic fixture), game=kex. Mirrors test/protocol_q2repro_boot.test.ts's
boot pattern (itself mirroring test/boot.test.ts's), but drives the real
`map` console command against the real retail maps/entity data instead of a
synthetic box room, proving the full server boot path -- CM_LoadMap's QBSP
dispatch, SV_SpawnServer, the kex game DLL's real SpawnEntities over
mguhub's/mgu1m1's actual (large, real) entity lumps -- reaches ss_game
cleanly on this content.

Retail-gated: skips itself if the retail install isn't present, matching
every other retail-gated test in this suite. No copyrighted map data is
committed anywhere -- FS_LoadFile reads pak0.pak directly from the user's
local retail install path at test-run time through this port's own normal
file-system code (basedir set to the real retail root), exactly the way a
real play session reads it.
*/

import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE } from "../src/shared/q_shared";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cls, ConnstateT } from "../src/client/client";
import { existsSync } from "node:fs";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { geHolder } from "../src/server/sv_game";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

const MAP_POLL_LIMIT = 600; // these are large real maps (mgu1m1 ~23MB, mguhub ~33MB); generous poll budget

async function bootMap(mapname: string): Promise<void> {
  Cbuf_AddText(`map ${mapname}\n`);
  for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

describe.skipIf(!havePak)("dedicated server boot -- real retail mguhub.bsp (QBSP)", () => {
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;

  beforeAll(async () => {
    // rule 13 (process-wide singleton leaks, closed at the source): this
    // boot points `basedir` directly at the real retail install, so
    // Qcommon_Init's unconditional "exec default.cfg"/"exec config.cfg"
    // (src/main.ts, matching q2repro exactly) reads that real, machine-
    // specific user's actual saved kex/config.cfg -- not a synthetic
    // fixture. Any client-only cvar name no code on this (dedicated) boot
    // path ever Cvar_Get's first ("name", "fov", "sensitivity", "hand",
    // "rate", "crosshair", "cl_run", "freelook", "vid_ref", ...) gets
    // created fresh by Cvar_Set2's create-on-demand path with that real
    // user's saved value baked in as its permanent default_string --
    // Cvar_Get's "first registration wins the default" contract means no
    // later, correct Cvar_Get call (e.g. test/cvar_parity.test.ts's own
    // real client boot) can ever fix it. Same leak shape as
    // test/savegame_retail_roundtrip.test.ts's own header comment
    // (content_root instead of basedir, identical mechanism); see
    // test/support/cvar_snapshot.ts for the snapshot/restore recipe and
    // why it's safe here (this boot is entirely throwaway). Also snapshot
    // fs_searchpaths: FS_InitFilesystem's mount of the real retail basedir
    // is never undone on its own (src/qcommon/files.ts's own header
    // comment). Capture both before ANY mutation below.
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();

    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "kex");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");

    // In-process boot: a real process starts with cls.state fresh, and CL_Init
    // returns before touching it under dedicated=1, so reset what an earlier
    // suite in this process may have left connected (otherwise init's default
    // startup command forwards to a netchan that was never set up).
    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "kex", "+set", "coop", "1", "+set", "port", "0"]);

    await bootMap("mguhub");
  }, 120000);

  afterAll(async () => {
    SV_Shutdown("mguhub boot test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);
  });

  test(
    "mguhub reaches ss_game cleanly",
    () => {
      expect(sv.state).toBe(ServerStateT.ss_game);
      expect(sv.name).toBe("mguhub");
      expect(geHolder.ge).not.toBeNull();
    },
    120000,
  );
});

describe.skipIf(!havePak)("dedicated server boot -- real retail mgu1m1.bsp (QBSP)", () => {
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;

  beforeAll(async () => {
    // See the mguhub describe block above (same file) for the full
    // rationale: this boot also points `basedir` directly at the real
    // retail install, so it must snapshot/restore both fs_searchpaths and
    // cvar_vars independently of that block (each describe's own boot is
    // its own leak).
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();

    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "kex");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");

    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "kex", "+set", "coop", "1", "+set", "port", "0"]);

    await bootMap("mgu1m1");
  }, 120000);

  afterAll(async () => {
    SV_Shutdown("mgu1m1 boot test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);
  });

  test(
    "mgu1m1 reaches ss_game cleanly",
    () => {
      expect(sv.state).toBe(ServerStateT.ss_game);
      expect(sv.name).toBe("mgu1m1");
      expect(geHolder.ge).not.toBeNull();
    },
    120000,
  );
});
