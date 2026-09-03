/*
Dedicated boot of the LMCTF game module under the KEX FAMILY's wire protocol
(1038, CS_REMAP_RERELEASE) -- .orch/followups.md's "kex-family LMCTF
adaptation" task #26 -- against REAL retail data (basedir pointed at the
actual rerelease install's baseq2/pak0.pak, no synthetic fixture),
game=lmctf-kex, map q2ctf1 (a real CTF map shipped in the rerelease's own
pak0.pak -- verified present via `strings pak0.pak | grep ctf` before writing
this file; `strings pak0.pak` also finds q2ctf2-5/ndctf0/q2kctf1-2, any of
which would work equally).

Mirrors test/dedicated_boot_retail_mgu.test.ts's boot pattern (basedir/
fs_searchpaths/cvar snapshot-and-restore discipline, `map` console command
through Qcommon_Init + runFrames, "reaches ss_game" gate) but drives
src/server/bindings/legacy_kex.ts's new LoadLmctfKexGame path instead of
game=kex, and additionally exercises the two things that path actually adds
over plain game=lmctf (see legacy_kex.ts's own header for the full
architecture citation):

  1. svs.csr/svs.codec really do switch to the wide/rerelease family
     (CS_REMAP_RERELEASE, Q2REPRO_CODEC/protocol 1038) even though LMCTF's
     own content is loaded (not kexgame's), while currentGameFamily() stays
     "legacy" (tick rate/savegame/MVD dispatch all correctly stay on LMCTF's
     native behavior -- see sv_game.ts's SV_InitGameProgs comment).
  2. SpawnEntities over q2ctf1's real (large, real) entity lump produces
     real spawn-point and flag entities. q2ctf1's own entity lump places
     them under the classnames "info_flag_red"/"info_flag_blue"
     (src/lmctf/g_spawn.ts's SP_info_flag_red/SP_info_flag_blue -- the
     "item_flag_team1"/"item_flag_team2" spawn-table entries are aliases
     for the same two spawn functions, which normalize `self.classname` to
     "info_flag_red"/"info_flag_blue" either way; confirmed against this
     map's actual spawned classnames, not assumed).
  3. A connecting client's PlayerStateT.stats is the wide, 64-slot array
     (MAX_STATS_STORAGE, not the classic-protocol MAX_STATS=32 bound) --
     and legacy_kex.ts's configstring remap actually lands LMCTF's raw,
     hardcoded-CS_*-index writes (ClientUserinfoChanged's own
     `gi.configstring(CS_PLAYERSKINS + playernum, ...)`) in the CORRECT wide
     slot, not wherever CS_REMAP_OLD's playerskins offset would misdirect it
     under an active CS_REMAP_RERELEASE layout.
  4. legacy_kex.ts's fixupPickupStringStat shim: a stat value shaped exactly
     like src/lmctf/g_items.ts's `client.ps.stats[STAT_PICKUP_STRING] =
     CS_ITEMS + ITEM_INDEX(item)` (the one documented cross-boundary
     CS_*-embedding LMCTF's game code contains outside gi.configstring()
     calls -- see legacy_kex.ts's header) gets remapped to the wide layout
     by the very next server frame.

Retail-gated: skips itself if the retail install isn't present, matching
every other retail-gated test in this suite (loud skip via describe.skipIf,
no silent no-op).
*/

import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE, STAT_PICKUP_STRING, MAX_STATS_STORAGE } from "../src/shared/q_shared";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cls, ConnstateT } from "../src/client/client";
import { existsSync } from "node:fs";
import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, svs, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { geHolder, currentGameFamily } from "../src/server/sv_game";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, type CsRemapT } from "../src/shared/cs_remap";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { g_edicts, level, type EdictT } from "../src/lmctf/g_local";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

const MAP_POLL_LIMIT = 600;

async function bootMap(mapname: string): Promise<void> {
  Cbuf_AddText(`map ${mapname}\n`);
  for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

describe.skipIf(!havePak)("dedicated server boot -- LMCTF under the kex family (protocol 1038, real retail q2ctf1.bsp)", () => {
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;
  // Rule 13 test-hygiene seam, mirroring how test/sv_game.test.ts's own
  // suite (and test/ctf_boot.test.ts's "SV_InitGameProgs runtime game-track
  // selection" describe) leaves cvar_vars/geHolder/svs able to run any later
  // suite as if this one never ran. cvar_snapshot.ts's snapshotCvars/
  // restoreCvars handles cvar_vars' *values* correctly (restores existing
  // entries in place, drops ones this test registered for the first time --
  // see that file's own header), but it does NOT know about the
  // server-module singletons SV_InitGameProgs/SV_SpawnServer mutate outside
  // cvar_vars entirely: svs.csr/svs.codec (only ever reassigned by a later
  // SV_InitGameProgs call, which not every later test file makes before
  // reading them) and geHolder.ge (already nulled by SV_Shutdown below via
  // SV_ShutdownGameProgs, reasserted here for a self-documenting belt-and-
  // suspenders match to that seam, not because SV_Shutdown is known to skip
  // it). Snapshotting the raw "game" cvar STRING (not just via cvar_vars)
  // and re-asserting it with Cvar_ForceSet after restoreCvars additionally
  // guards the case restoreCvars's own header warns about generally --
  // another module (src/qcommon/files.ts's `fs_gamedirvar`, the same class
  // of cached-CvarT-reference risk that file's own header names for
  // `fs_basedir`/`fs_content_root`/`dedicated`) may have captured this
  // test's freshly-registered "game" CvarT object directly; Cvar_ForceSet
  // writes through whichever object is live in cvar_vars at that point
  // (pre-existing, restored in place by restoreCvars, or freshly
  // re-registered here) rather than assuming restoreCvars's delete/keep
  // decision already made the right object canonical again.
  let preTestGameCvar: string;
  let preTestCsr: CsRemapT;
  let preTestCodec: ProtocolCodec;

  beforeAll(async () => {
    // Same leak-hygiene rationale as test/dedicated_boot_retail_mgu.test.ts's
    // own header comment (basedir pointed at the real retail install, first-
    // registration-wins cvar defaults) -- snapshot/restore both fs_searchpaths
    // and cvar_vars around this entirely-throwaway boot.
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();
    preTestGameCvar = Cvar_VariableString("game");
    preTestCsr = svs.csr;
    preTestCodec = svs.codec;

    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "lmctf-kex");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("deathmatch", "1");
    Cvar_ForceSet("maxclients", "4");

    // In-process boot: a real process starts with cls.state fresh, and CL_Init
    // returns before touching it under dedicated=1, so reset what an earlier
    // suite in this process may have left connected (otherwise init's default
    // startup command forwards to a netchan that was never set up).
    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "lmctf-kex", "+set", "deathmatch", "1", "+set", "maxclients", "4", "+set", "port", "0"]);

    await bootMap("q2ctf1");
  }, 120000);

  afterAll(async () => {
    SV_Shutdown("lmctf-kex boot test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);

    // Belt-and-suspenders restoration of the server-module singletons this
    // boot mutated outside cvar_vars -- see this describe's own field
    // comment above for why restoreCvars/FS_TestRestoreSearchPaths alone
    // don't cover these.
    geHolder.ge = null;
    svs.csr = preTestCsr;
    svs.codec = preTestCodec;
    Cvar_ForceSet("game", preTestGameCvar);
  });

  test(
    "q2ctf1 reaches ss_game cleanly, running LMCTF's own content",
    () => {
      expect(sv.state).toBe(ServerStateT.ss_game);
      expect(sv.name).toBe("q2ctf1");
      expect(geHolder.ge).not.toBeNull();
    },
    120000,
  );

  test("the wire/configstring family is kex (1038, wide), while the content-tick family stays legacy", () => {
    // The whole point of "lmctf-kex" as a THIRD selection, distinct from
    // `family` -- see legacy_kex.ts's header ("two independent axes").
    expect(svs.csr).toBe(CS_REMAP_RERELEASE);
    expect(svs.codec).toBe(Q2REPRO_CODEC);
    // currentGameFamily() must NOT report "kex" here: LMCTF has no
    // tick_rate import (sv.framerate stays pinned at native 10Hz),
    // no WriteGameJson/ReadGameJson/CanSave (savegame dispatch must keep
    // using LMCTF's own fixed-width WriteGame/ReadGame), and sv_mvd.ts's
    // rerelease player-state codec must not activate for it.
    expect(currentGameFamily()).toBe("legacy");
    expect(sv.framerate).toBe(10);
  });

  test("SpawnEntities over the real q2ctf1 entity lump produced real spawn-point and flag entities", () => {
    const inUse = g_edicts.filter((e): e is EdictT => e !== undefined && e.inuse);
    const classnames = inUse.map((e) => e.classname);

    expect(classnames.some((c) => c !== null && c.startsWith("info_player"))).toBe(true);
    expect(classnames).toContain("info_flag_red");
    expect(classnames).toContain("info_flag_blue");
  });

  test("a connecting client's PlayerStateT.stats is the wide, 64-slot layout, and its raw-CS_*-index configstring writes land in the wide slot", () => {
    const clientEdict = geHolder.ge?.edicts[1];
    expect(clientEdict).toBeDefined();
    if (!clientEdict) return;

    const connectResult = geHolder.ge?.ClientConnect(clientEdict, "\\name\\Tester\\skin\\male/grunt");
    expect(connectResult?.allowed).toBe(true);
    geHolder.ge?.ClientBegin(clientEdict);

    const lmctfEnt = g_edicts[1];
    expect(lmctfEnt).toBeDefined();
    const client = lmctfEnt?.client;
    expect(client).not.toBeNull();
    if (!client) return;

    // Wide layout, not the classic protocol's narrower wire bound.
    expect(client.ps.stats.length).toBe(MAX_STATS_STORAGE);
    expect(client.ps.stats.length).toBe(64);

    // ClientUserinfoChanged (src/lmctf/p_client.ts) wrote
    // `gi.configstring(CS_PLAYERSKINS + playernum, ...)` using LMCTF's own
    // hardcoded, CS_REMAP_OLD-shaped constant -- confirm it landed at the
    // WIDE family's playerskins slot, not the (wrong-for-this-family)
    // CS_REMAP_OLD slot a naive passthrough would have produced.
    const playernum = 0; // EDICT_NUM(ent) - 1, client slot 1 -> playernum 0
    expect(sv.configstrings[CS_REMAP_RERELEASE.playerskins + playernum]).toBe("Tester\\male/grunt");
    expect(sv.configstrings[CS_REMAP_OLD.playerskins + playernum]).not.toBe("Tester\\male/grunt");
  });

  test("fixupPickupStringStat remaps a STAT_PICKUP_STRING value shaped like a real item pickup, idempotently, by the next server frame", () => {
    const lmctfEnt = g_edicts[1];
    const client = lmctfEnt?.client;
    expect(client).not.toBeNull();
    if (!client) return;

    // Shaped exactly like src/lmctf/g_items.ts's
    // `client.ps.stats[STAT_PICKUP_STRING] = CS_ITEMS + ITEM_INDEX(item)`:
    // a raw CS_REMAP_OLD-scheme items-block index, item slot 3.
    const legacyValue = CS_REMAP_OLD.items + 3;
    client.ps.stats[STAT_PICKUP_STRING] = legacyValue;

    // A real pickup does not only write STAT_PICKUP_STRING -- g_items.c's
    // Touch_Item also sets `client->pickup_msg_time = level.time + 3.0`, and
    // p_hud.c's G_SetStats clears both STAT_PICKUP_ICON and
    // STAT_PICKUP_STRING again as soon as `level.time > pickup_msg_time`.
    // This test pokes the stat directly, so it has to supply the other half
    // of that pair or G_SetStats (which now runs on every server frame, as
    // it does in the C) legitimately zeroes the value back out before the
    // fixup is ever asked to remap it. 3 seconds covers the ten 100ms
    // frames this test drives.
    client.pickup_msg_time = level.time + 3.0;

    // sv_main.ts's SV_Frame only advances the game once svs.realtime has
    // caught up to sv.time (its own accumulator, `if (svs.realtime <
    // sv.time) return` early-out). How far apart those two start here is NOT
    // fixed: beforeAll's bootMap polls `map q2ctf1` for as many 100ms frames
    // as the (wall-clock, I/O-bound) load actually needs, so the phase this
    // test inherits varies run to run. A fixed step count therefore does not
    // guarantee a RunFrame dispatch -- poll for the effect instead, the same
    // bounded-poll idiom bootMap itself uses, and fail loudly if it never
    // lands rather than silently asserting against an un-run frame.
    let remapped = client.ps.stats[STAT_PICKUP_STRING];
    for (let i = 0; i < MAP_POLL_LIMIT && remapped === legacyValue; i++) {
      runFrames(1, 100);
      remapped = client.ps.stats[STAT_PICKUP_STRING];
    }

    expect(remapped).toBe(CS_REMAP_RERELEASE.items + 3);
    expect(remapped).not.toBe(legacyValue);

    // Idempotent: further frames must not re-remap an already-wide value
    // (it is far outside CS_REMAP_OLD's items range, so the fixup's own
    // range check leaves it alone).
    runFrames(5, 100);
    expect(client.ps.stats[STAT_PICKUP_STRING]).toBe(remapped);
  });
});
