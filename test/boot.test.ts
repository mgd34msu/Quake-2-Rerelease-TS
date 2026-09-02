/*
Integration test: boots the whole dedicated server in-process through
src/main.ts's Qcommon_Init, loads a synthetic map (built by
test/support/bsp_builder.ts, no copyrighted map data) via the real `map`
console command, and runs game frames against it.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cls, ConnstateT } from "../src/client/client";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { geHolder } from "../src/server/sv_game";
import { g_edicts, level } from "../src/game/g_local";
import { buildBoxRoomBsp, ROOM_HALF } from "./support/bsp_builder";

// worldspawn plus a spawn point and one walking monster, all inside the
// hollow cube the builder emits (|x|,|y|,|z| < ROOM_HALF). The soldier sits
// well clear of every wall so M_droptofloor lands it without touching the
// boundary planes.
const BOOT_ENTITIES = [
  '{\n"classname" "worldspawn"\n"message" "boot test"\n}\n',
  '{\n"classname" "info_player_start"\n"origin" "0 0 -32"\n"angle" "0"\n}\n',
  '{\n"classname" "monster_soldier"\n"origin" "16 16 -30"\n"angle" "0"\n}\n',
].join("");

// how many event-loop turns to wait for the fire-and-forget `map` command
const MAP_POLL_LIMIT = 200;

describe("src/main.ts -- dedicated server boot", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2boot-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);
    writeFileSync(join(mapsDir, "boottest.bsp"), buildBoxRoomBsp(BOOT_ENTITIES));

    // These four are all CVAR_NOSET or CVAR_LATCH by the time Qcommon_Init
    // registers them, and a sibling suite in the same bun process may already
    // have created them, so they are force-set here the way test/files.test.ts
    // and test/cmodel_map.test.ts do. The equivalent "+set ..." arguments are
    // still passed below so COM_InitArgv/Cbuf_AddEarlyCommands run for real.
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("port", "0"); // bind an ephemeral UDP port, never a fixed one
    Cvar_ForceSet("dedicated", "1");
    // dedicated + non-coop forces deathmatch in SV_InitGame, and every monster
    // spawn function frees itself in deathmatch, so boot in coop instead.
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");

    // In-process boot: a real process starts with cls.state fresh, and CL_Init
    // returns before touching it under dedicated=1, so reset what an earlier
    // suite in this process may have left connected (otherwise init's default
    // startup command forwards to a netchan that was never set up).
    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", tmpRoot, "+set", "coop", "1", "+set", "port", "0"]);

    // SV_InitOperatorCommands registers `map` as a fire-and-forget wrapper
    // around the async SV_Map, so the command has only started once
    // Qcommon_Frame's Cbuf_Execute dispatches it. Drive real frames while
    // polling sv.state, exactly as the standalone server loop does -- that is
    // what proves SV_Frame stays out of the game library until SV_InitGame
    // has finished awaiting NET_Config and SV_InitGameProgs.
    Cbuf_AddText("map boottest\n");
    for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
      runFrames(1, 100);
      await Bun.sleep(1);
    }
  });

  afterAll(async () => {
    SV_Shutdown("boot test finished\n", false);
    await NET_Shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("the map command drives the server all the way to ss_game", () => {
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(sv.name).toBe("boottest");
  });

  test("the game library is loaded and the world entity is spawned", () => {
    expect(geHolder.ge).not.toBeNull();
    expect(g_edicts.length).toBeGreaterThan(0);
    expect(g_edicts[0].inuse).toBe(true);
    expect(g_edicts[0].classname).toBe("worldspawn");
  });

  test("the monster from the entity string spawned, is alive, and stands inside the room", () => {
    const soldier = g_edicts.find((e) => e.inuse && e.classname === "monster_soldier");
    expect(soldier).toBeDefined();
    if (!soldier) return;
    expect(soldier.health).toBeGreaterThan(0);
    expect(level.total_monsters).toBeGreaterThan(0);
    expect(Math.abs(soldier.s.origin[0])).toBeLessThan(ROOM_HALF);
    expect(Math.abs(soldier.s.origin[1])).toBeLessThan(ROOM_HALF);
    expect(Math.abs(soldier.s.origin[2])).toBeLessThan(ROOM_HALF);
  });

  test("running 20 more frames advances the game clock without throwing", () => {
    const before = level.framenum;
    expect(() => runFrames(20, 100)).not.toThrow();
    expect(level.framenum).toBeGreaterThan(before);
    expect(sv.state).toBe(ServerStateT.ss_game);
  });
});
