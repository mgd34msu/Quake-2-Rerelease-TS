/*
Regression test for divergence-audit-full.json finding #28 ("Coop maxclients
still clamped to 4 by the vanilla rule; rerelease-era engine allows large
coop"): src/server/sv_init.ts's SV_InitGame coop branch used to force
maxclients back down to 4 whenever it was set above 4, which q2repro's
init.c:446-455 does not do -- the reference only floors an unset/<=1
maxclients to 4, then relies on the shared clamp to MAX_CLIENTS that every
other mode also goes through. Above 4 and at/under MAX_CLIENTS, coop
maxclients must pass through unchanged.

Also exercises SV_InitGame directly (not through the `map` command) so this
doubles as coverage that reordering the function's only await (NET_Config)
ahead of the svs.clients/svs.spawncount/svs.num_client_entities/
svs.client_entities writes -- the fix for the sv_init.ts:404 initialization
race -- still produces a fully-populated svs.clients array of the requested
size every time, including across repeated re-init (svs.initialized was
already true) the way `map`/`changelevel`/a manual `restart` would drive it.

Self-sufficient per the repo's order-independence rule: registers its own
basedir/game/port/coop/deathmatch/maxclients state rather than assuming
another test file's run order, the same way test/boot.test.ts and
test/tickrate.test.ts do.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { NET_Shutdown } from "../src/platform/net_udp";
import { SV_Init, SV_Shutdown } from "../src/server/sv_main";
import { SV_InitGame } from "../src/server/sv_init";
import { svs, maxclients } from "../src/server/server";

describe("SV_InitGame -- coop maxclients clamp (finding #28)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2coopmax-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();

    // SV_Init registers maxclients/coop/deathmatch/dedicated-dependent cvars
    // if another suite in this same bun process has not already done so.
    SV_Init();

    Cvar_ForceSet("game", "");
    Cvar_ForceSet("port", "0"); // ephemeral UDP port, never a fixed one
    Cvar_ForceSet("dedicated", "0");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("coop", "1");
  });

  afterAll(async () => {
    SV_Shutdown("coop maxclients test finished\n", false);
    await NET_Shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("unset/<=1 maxclients still floors to 4 in coop (q2repro init.c:449-451)", async () => {
    Cvar_ForceSet("maxclients", "0");
    await SV_InitGame();
    expect(maxclients?.value).toBe(4);
    expect(svs.clients.length).toBe(4);
  });

  test("maxclients above 4 is no longer forced back down to 4 in coop", async () => {
    Cvar_ForceSet("maxclients", "6");
    await SV_InitGame();
    expect(maxclients?.value).toBe(6);
    expect(svs.clients.length).toBe(6);
  });

  test("maxclients well above 4 (e.g. an 8-player coop game) passes through unchanged", async () => {
    Cvar_ForceSet("maxclients", "8");
    await SV_InitGame();
    expect(maxclients?.value).toBe(8);
    expect(svs.clients.length).toBe(8);
    // every client slot is fully wired (finding #28's fix must not reopen
    // the sv_init.ts:404 race that used to leave slots half-built across the
    // function's await NET_Config).
    for (const cl of svs.clients) {
      expect(cl.edict).not.toBeNull();
    }
  });
});
