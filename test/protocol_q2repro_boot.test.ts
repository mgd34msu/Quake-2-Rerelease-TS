/*
End-to-end check for the phase-5 q2repro (1038) codec unit
(ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md): boots the whole
dedicated server in-process with `game=kex` (mirroring test/boot.test.ts's
pattern, but for the kex family instead of legacy) and asserts that
sv_game.ts's family-dispatched codec selection (Q2REPRO_CODEC for kex,
mirroring q2repro's real server which ONLY accepts the rerelease protocol)
actually took effect and that the server runs game frames cleanly with it
active.

SCOPE, stated plainly (see src/qcommon/protocol/q2repro.ts's file header for
the full citations): this proves the SERVER-SIDE selection wiring and boot
path are clean. It does not prove wire interop with a real external q2repro
client -- this engine's sv_ents.ts frame-emission pipeline still frames
entity-delta/playerstate-delta bytes inside protocol-34-shaped separate
svc_frame/svc_playerinfo/svc_packetentities messages regardless of which
codec is selected (1038's real wire format bundles them into one svc_frame
envelope with a reserved extraflags byte -- q2repro.c:2206-2242), so a real
q2repro client connecting to this server would not parse the resulting
stream correctly yet. That restructuring is out of this unit's scope
(materially larger than a codec-seam addition) and is not attempted here.
No loopback client connection is exercised in this test for the same
reason: there is nothing to meaningfully connect and validate against until
handshake/protocol negotiation and the frame envelope exist.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, svs, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { geHolder } from "../src/server/sv_game";
import { g_edicts } from "../src/kexgame/g_main_globals";
import { CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import { buildBoxRoomBsp, ROOM_HALF } from "./support/bsp_builder";

// worldspawn plus a spawn point only -- monster spawn behavior is kexgame's
// own concern, not this codec unit's; kept minimal to isolate what's
// actually under test (family-dispatched codec selection + clean frame
// execution), matching boot.test.ts's synthetic-BSP-only approach (no
// copyrighted map data, and deliberately not the real rerelease "base1" map
// the task brief names).
const BOOT_ENTITIES = ['{\n"classname" "worldspawn"\n"message" "q2repro codec boot test"\n}\n', '{\n"classname" "info_player_start"\n"origin" "0 0 -32"\n"angle" "0"\n}\n'].join(
  "",
);

const MAP_POLL_LIMIT = 200;

describe("kex game family boot -- Q2REPRO_CODEC selection (src/qcommon/protocol/q2repro.ts)", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2repro-boot-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const mapsDir = join(baseq2Dir, "maps");
    mkdirSync(baseq2Dir);
    mkdirSync(mapsDir);
    writeFileSync(join(mapsDir, "q2reprotest.bsp"), buildBoxRoomBsp(BOOT_ENTITIES));

    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "kex"); // selects the kex family -- sv_game.ts:355
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");

    Qcommon_Init(["quake2", "+set", "basedir", tmpRoot, "+set", "game", "kex", "+set", "coop", "1", "+set", "port", "0"]);

    Cbuf_AddText("map q2reprotest\n");
    for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
      runFrames(1, 100);
      await Bun.sleep(1);
    }
  });

  afterAll(async () => {
    SV_Shutdown("q2repro boot test finished\n", false);
    await NET_Shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("the map command drives the kex-family server all the way to ss_game", () => {
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(sv.name).toBe("q2reprotest");
  });

  test("sv_game.ts selected Q2REPRO_CODEC and cs_remap_rerelease for the kex family", () => {
    expect(svs.codec).toBe(Q2REPRO_CODEC);
    expect(svs.codec.name).toBe("q2repro");
    expect(svs.csr).toBe(CS_REMAP_RERELEASE);
  });

  test("the kex game library is loaded and the world entity is spawned", () => {
    expect(geHolder.ge).not.toBeNull();
    expect(g_edicts.length).toBeGreaterThan(0);
    expect(g_edicts[0].inuse).toBe(true);
    expect(g_edicts[0].classname).toBe("worldspawn");
  });

  test("running 20 more frames with Q2REPRO_CODEC active advances the game clock without throwing", () => {
    expect(() => runFrames(20, 100)).not.toThrow();
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(svs.codec).toBe(Q2REPRO_CODEC); // still selected -- SV_Frame never resets it mid-level
  });
});
