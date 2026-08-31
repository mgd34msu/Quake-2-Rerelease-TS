/*
Regression test for divergence-audit-full.json finding #27 ("Spawn settle
frames and savegame/level-return catch-up frames run as RunFrame(true),
which the rerelease game skips until a player has spawned"). The
RunFrame(mainLoop) plumbing itself (sv_init.ts passing `false`,
bindings/kex.ts's adapter forwarding it to kexGe.RunFrame) was already fixed
before this pass; what was still missing is q2repro init.c:202-203's
`for (i = 0; i < 2; i++, sv.framenum++) ge->RunFrame(false);` -- our two
post-SpawnEntities settle frames ran but never advanced sv.framenum, so
nothing on the engine side ever recorded that they happened.

This calls SV_SpawnServer directly (synchronous, no `map` command / frame
pump involved) so sv.framenum's value coming out of it reflects exactly the
two settle-frame increments and nothing else: sv.clear() zeroes framenum at
the top of SV_SpawnServer, and nothing between that and the settle-frame
block touches it.

Self-sufficient per the repo's order-independence rule, following
test/boot.test.ts's minimal single-room-map setup.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { NET_Shutdown } from "../src/platform/net_udp";
import { SV_Init, SV_Shutdown } from "../src/server/sv_main";
import { SV_InitGame, SV_SpawnServer } from "../src/server/sv_init";
import { sv, ServerStateT } from "../src/server/server";
import { buildBoxRoomBsp } from "./support/bsp_builder";

const WORLD_ONLY = '{\n"classname" "worldspawn"\n"message" "settle-frame test"\n}\n';

describe("SV_SpawnServer -- settle-frame sv.framenum advance (finding #27)", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2settle-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);
    writeFileSync(join(mapsDir, "settletest.bsp"), buildBoxRoomBsp(WORLD_ONLY));

    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();

    SV_Init();

    Cvar_ForceSet("game", "");
    Cvar_ForceSet("port", "0"); // ephemeral UDP port
    Cvar_ForceSet("dedicated", "0");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("maxclients", "4");

    await SV_InitGame();
  });

  afterAll(async () => {
    SV_Shutdown("settle-frame test finished\n", false);
    await NET_Shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("sv.framenum is exactly 2 after SV_SpawnServer's two settle frames", () => {
    SV_SpawnServer("settletest", "", ServerStateT.ss_game, false, false);
    expect(sv.state).toBe(ServerStateT.ss_game);
    // q2repro init.c:202-203: two settle-frame ge->RunFrame(false) calls,
    // each paired with sv.framenum++. sv.clear() (called at the top of
    // SV_SpawnServer) zeroes framenum first, so this is the settle frames'
    // contribution alone.
    expect(sv.framenum).toBe(2);
  });
});
