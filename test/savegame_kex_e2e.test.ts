/*
Phase-8 savegame unit -- end-to-end save/load under the kex family.

Boots a whole dedicated server in-process with `game=kex` (mirroring
test/protocol_q2repro_boot.test.ts's exact boot pattern -- see that file's
header for why a synthetic BSP is used instead of a real rerelease "base1"
map: no copyrighted map data ships in this repo, and that precedent already
established the same substitution for the same reason under this same game
family), then drives the real "save"/"load" console commands
(src/server/sv_ccmds.ts's SV_Savegame_f/SV_Loadgame_f) end to end: save,
change the game clock, load, and assert the world actually rewound -- via
the kex game module's OWN state (src/kexgame/g_main_globals.ts's
`g_edicts`/`level`), not just "didn't throw".

FINDING (see this unit's report for the full writeup): kexgame's
G_RunFrame(main_loop=true) (src/kexgame/g_main.ts:1346) opens with `if
(main_loop && !G_AnyPlayerSpawned()) return;` -- q2's real, intentional
behavior (an idle dedicated server with nobody connected does not simulate
the world at all), faithfully ported. A dedicated boot with no connected
client therefore never advances `level.time` by running frames, no matter
how many are run; naturally advancing it requires a real spawned player,
and driving ClientConnect/ClientBegin without a genuine network-connected
client (tried during this unit's investigation) hits an unrelated
pre-existing crash several layers deep (ClientUserinfoChanged ->
PF_Configstring -> SV_Multicast -> SZ_Write overflow).

ROOT CAUSE CONFIRMED (2026-08-30 cleanup sweep, .orch/followups.md
SWEEP-INVESTIGATE item): this is a TEST-HARNESS gap, not a real
reliable-buffer sizing bug. `ClientT.netchan.message`/`.datagram`
(src/qcommon/net_chan.ts / src/server/server.ts) are plain `new SizeBuf()`
until something calls `SZ_Init` on them (`maxsize=0, allowoverflow=false`
by default) -- the real connect path (`SVC_DirectConnect` ->
`Netchan_Setup`, src/qcommon/net_chan.ts:169-174) always does this before
the game module's `ClientConnect`/`ClientBegin` can ever run. A harness
that calls `ge.ClientConnect`/`ge.ClientBegin` directly on a `svs.clients`
slot WITHOUT going through that setup (as this investigation did, and as
this test itself avoids by never spawning a client at all) skips that
initialization, so `SV_Multicast`'s reliable write into
`client.netchan.message` (still `maxsize=0`) throws immediately via
`SZ_GetSpace`'s `length > buf.maxsize` / `!allowoverflow` checks -- proven
by reproducing BOTH ways: identical drive-ClientConnect-directly code
throws with the netchan left uninitialized, and stops throwing entirely
once `SZ_Init(cl.netchan.message, ...)` /
`SZ_Init(cl.datagram, ...)` + `allowoverflow = true` are called first
(test/server_core.test.ts's `makeClient()` helper already does exactly
this for its own, unrelated suite). Nothing in the shipped server/game
code needs fixing; a future unit that wants a savegame E2E test with a
real simulated player should route client setup through that same
SZ_Init'd-netchan pattern (or a proper loopback connect) rather than
calling `ClientConnect`/`ClientBegin` on a bare `svs.clients` slot.
`level.time` is therefore set directly here (a legitimate "fabricated
world" shortcut, same spirit as the unit-scope container tests) instead of
earned by running real gameplay frames -- this test's job is to verify the
SAVE/LOAD ROUND TRIP preserves it, not that idle dedicated frames advance
it (a separate, already-established, unrelated behavior this test does not
need to re-prove).
*/

import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE } from "../src/shared/q_shared";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cls, ConnstateT } from "../src/client/client";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { FS_Gamedir, FS_ReadRawFile } from "../src/qcommon/files";
import { g_edicts, level } from "../src/kexgame/g_main_globals";
import { Gtime_milliseconds, Gtime_from_sec } from "../src/kexgame/gtime";
import { buildBoxRoomBsp } from "./support/bsp_builder";

const BOOT_ENTITIES = ['{\n"classname" "worldspawn"\n"message" "kex save/load E2E test"\n}\n', '{\n"classname" "info_player_start"\n"origin" "0 0 -32"\n"angle" "0"\n}\n'].join("");

const POLL_LIMIT = 400;

async function pollUntil(predicate: () => boolean): Promise<boolean> {
  for (let i = 0; i < POLL_LIMIT && !predicate(); i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
  return predicate();
}

function inuseEntityCount(): number {
  return g_edicts.filter((e) => e.inuse).length;
}

describe("kex family save/load -- end-to-end (boot, save, mutate, load, verify)", () => {
  let tmpRoot: string;
  let preTestGame = "";
  let preTestBasedir = "";

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2save-e2e-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);
    writeFileSync(join(mapsDir, "e2eroom.bsp"), buildBoxRoomBsp(BOOT_ENTITIES));

    preTestGame = Cvar_VariableString("game");
    preTestBasedir = Cvar_VariableString("basedir");
    Cvar_ForceSet("basedir", tmpRoot);
    // Pre-register with the engine's real default+flags (files.ts:1189) so
    // this throwaway override can never become the cvar's default_string via
    // Cvar_Get's first-registration-wins contract (the pristine-order
    // pollution class the order-independence pass closed).
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
    Qcommon_Init(["quake2", "+set", "basedir", tmpRoot, "+set", "game", "kex", "+set", "dedicated", "1", "+set", "coop", "1", "+set", "port", "0"]);

    Cbuf_AddText("map e2eroom\n");
    const booted = await pollUntil(() => sv.state === ServerStateT.ss_game);
    expect(booted).toBe(true);
    expect(sv.name).toBe("e2eroom");
  });

  afterAll(async () => {
    SV_Shutdown("kex save/load E2E test finished\n", false);
    await NET_Shutdown();
    // Rule 13: "game" and "basedir" are process-wide cvars this boot
    // overrode. A later suite's FS_InitFilesystem re-reads "game" at its
    // very end and calls FS_SetGamedir on any non-empty value, which moves
    // FS_Gamedir() off basedir/baseq2 onto <that suite's basedir>/kex --
    // exactly what test/fs_homedir.test.ts's write-root assertions measure.
    // Put both back so this throwaway boot is not observable from the next
    // file in the process.
    Cvar_ForceSet("game", preTestGame);
    Cvar_ForceSet("basedir", preTestBasedir);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("save/load round trip: entity count and level.time are restored, not just kept running", async () => {
    const entityCountBefore = inuseEntityCount();
    expect(entityCountBefore).toBeGreaterThan(0);

    // See this file's header FINDING: level.time cannot be earned by
    // running idle dedicated frames (no player is spawned), so a
    // recognizable baseline is set directly instead.
    level.time = Gtime_from_sec(500);
    const timeBefore = Gtime_milliseconds(level.time);

    Cbuf_AddText("save e2etest\n");
    runFrames(1, 100); // SV_Savegame_f is synchronous; one frame drains Cbuf

    // the four files the SSV2/SAV2 container writes (save.c's write_server_
    // file/write_level_file split -- see sv_ccmds.ts's SV_WriteServerFileKex/
    // SV_WriteLevelFileKex) should now exist under the "e2etest" slot
    const gamedir = FS_Gamedir();
    expect(FS_ReadRawFile(`${gamedir}/save/e2etest/server.ssv`)).not.toBeNull();
    expect(FS_ReadRawFile(`${gamedir}/save/e2etest/game.ssv`)).not.toBeNull();
    expect(FS_ReadRawFile(`${gamedir}/save/e2etest/e2eroom.sv2`)).not.toBeNull();
    expect(FS_ReadRawFile(`${gamedir}/save/e2etest/e2eroom.sav`)).not.toBeNull();

    // mutate the live world well past the saved snapshot, proving the
    // eventual restored value came from the save file, not from state that
    // was simply never touched
    level.time = Gtime_from_sec(9999);
    const timeMutated = Gtime_milliseconds(level.time);
    expect(timeMutated).toBeGreaterThan(timeBefore);

    Cbuf_AddText("load e2etest\n");
    // SV_Loadgame_f is async (awaits SV_ReadServerFile -> SV_InitGame ->
    // SV_Map -> SV_SpawnServer -> SV_CheckForSavegame -> SV_ReadLevelFile);
    // Cmd_AddCommand's handler type is synchronous, so sv_ccmds.ts's
    // fireAndForget wrapper fires it without a promise this test can await
    // directly -- poll for the observable completion signal instead
    // (sv.state cycles ss_dead -> ss_game across SV_SpawnServer, and
    // level.time drops back to the saved value once SV_ReadLevelFile's
    // ReadLevelJson call restores it).
    const reloaded = await pollUntil(() => sv.state === ServerStateT.ss_game && Gtime_milliseconds(level.time) !== timeMutated);
    expect(reloaded).toBe(true);

    const entityCountAfter = inuseEntityCount();
    const timeAfter = Gtime_milliseconds(level.time);

    // sv_init.ts's SV_CheckForSavegame now makes save.c's LOAD_NORMAL
    // (frames=2) vs LOAD_LEVEL_START (frames=10*framerate) distinction
    // (2026-08-30 cleanup sweep); a `load` command sets sv.loadgame=true,
    // so this reload runs the 2-frame LOAD_NORMAL branch. Those catch-up
    // frames now REALLY run (f5b976f threads mainLoop=false per q2repro
    // init.c/save.c:626-654, bypassing G_RunFrame's no-player early-out --
    // this file's older FINDING described the pre-fix no-op behavior), so
    // the restored time advances by exactly two game frames past the
    // saved snapshot.
    const catchUpMs = 2 * sv.frametime; // the game's live per-frame ms (gi.frame_time_ms mirrors sv.frametime)
    expect(timeAfter).toBe(timeBefore + catchUpMs);
    expect(entityCountAfter).toBe(entityCountBefore);
  });
});
