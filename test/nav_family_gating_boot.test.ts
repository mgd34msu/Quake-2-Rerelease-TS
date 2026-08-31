/*
Dedicated boots pinning the `sv_nav_legacy` family gate -- .orch/followups.md's
finding 14 ("nav 'appears to be missing' under legacy is upstream-faithful
(game3_proxy classname gap, triage citation)") plus Mike's ruling on top of it
(2026-08-31, quoted verbatim for the ledger): "add it to the legacy one but
default it to off. that way we don't disrupt having bots and things like
that." See src/server/nav.ts's "A DELIBERATE, DOCUMENTED DEVIATION" header
comment for the full citation trail (q2repro's init.c:163-166 unconditional
Nav_Load call; nav.c:1436's `game_e->sv.classname` check; game3_proxy.c never
populating that field for any legacy game DLL).

Three boots against the same real rerelease base1.bsp used by
test/legacy_base1_rerelease_boot.test.ts (campaign rules: coop 1,
deathmatch 0, so the door/button/elevator/nav-bound entities this file
depends on are not deathmatch-inhibited -- see that file's own header for
why a bare dedicated boot would otherwise force deathmatch):

  1. legacy family, sv_nav_legacy "0" (the default): Nav_Load must never run
     at all -- asserted directly via nav.ts's Nav_DebugState() test seam
     (loaded stays false, the module's own freshNavData() default), not by
     scraping console text for absence of a message.
  2. legacy family, sv_nav_legacy "1": Nav_Load runs AND
     bindings/legacy.ts's new nav edict provider (toNavGameEdictView/
     legacyNavEdicts) actually resolves every nav-file edict record against
     the legacy game's real, live entities -- zero "appears to be missing"
     warnings, confirmed two ways: Nav_DebugState().edicts every entry has a
     non-null game_edict, AND a stdout capture shows no such line printed.
  3. kex family, unaffected: nav loads unconditionally exactly as it always
     has (this cvar is never consulted on that path), zero missing-entity
     warnings in campaign play, same as findings 6+10's closure already
     established for the kex+DM case in .orch/followups.md.

Retail-gated: skips itself if the retail install isn't present, matching
every other retail-gated test in this suite (loud skip via describe.skipIf,
no silent no-op). Global hygiene follows test/lmctf_kex_boot.test.ts's
afterAll pattern (rule 13): fs_searchpaths, cvar_vars, the raw "game" cvar
string, svs.csr, svs.codec and geHolder are all snapshotted and restored, and
the sv_nav_legacy cvar this file flips is covered by the same cvar_vars
snapshot (restoreCvars puts it back to whatever it was -- unregistered --
before this file ran, per that helper's own documented "first-registration-
wins" contract).
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE } from "../src/shared/q_shared";
import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, svs, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { geHolder, currentGameFamily } from "../src/server/sv_game";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, type CsRemapT } from "../src/shared/cs_remap";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";
import { Nav_DebugState } from "../src/server/nav";
import { Com_BeginRedirect, Com_EndRedirect } from "../src/qcommon/common";
import { RedirectT } from "../src/server/server";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

const MAP_POLL_LIMIT = 600;

async function bootMap(mapname: string): Promise<void> {
  Cbuf_AddText(`map ${mapname}\n`);
  // See legacy_base1_rerelease_boot.test.ts's identical comment: this file
  // also reboots the same map across a live server, so the blind frames
  // guarantee the queued `map` command actually runs before polling.
  for (let i = 0; i < 10; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
  for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

/*
bootMapSettled

This file (unlike legacy_base1_rerelease_boot.test.ts, which only ever
inspects spawned entities) also needs Nav_SetupEntities to have actually run
before inspecting Nav_DebugState() -- nav.ts's Nav_Frame only calls it once
`nav_data.nav_frame` exceeds `Math.trunc(sv.framerate)` (nav.c:1456's
sv_fps->integer gate), which is 10 for the legacy family but up to 60 for
kex (sv_tick_rate, clamped [10,60], default "40" per server.ts's own cvar
comment). SV_SpawnServer itself completes (reaching ss_game) synchronously
inside the single frame that processes the queued `map` command, so
bootMap's own frame budget provides no guarantee at all about how many
POST-spawn Nav_Frame ticks have elapsed by the time it returns -- confirmed
empirically: with only bootMap's frames, every nav.edicts entry came back
unresolved (game_edict null) even under kex, where resolution is proven to
work today. Running 70 more frames after ss_game comfortably clears even the
kex ceiling before this file inspects nav state or the captured console
text.
*/
async function bootMapSettled(mapname: string): Promise<void> {
  await bootMap(mapname);
  for (let i = 0; i < 70; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

/** Captures every Com_Printf line emitted during `fn` using qcommon's own
 * rcon-style redirect seam (Com_BeginRedirect/Com_EndRedirect,
 * src/qcommon/common.ts) instead of monkeypatching `process.stdout.write` --
 * no type-unsafe cast needed, and it captures exactly the text this port's
 * own Com_Printf call sites produce (Nav_SetupEntities' "appears to be
 * missing" warning included), not incidental engine/OS chatter. Restores
 * normal (non-redirected) output afterward even if `fn` throws. Used to
 * confirm the ABSENCE of that warning, as a belt-and-suspenders check
 * alongside the Nav_DebugState()-based assertions (the primary, non-string-
 * scraping proof). */
async function captureComPrintf(fn: () => Promise<void>): Promise<string> {
  let out = "";
  Com_BeginRedirect(RedirectT.RD_PACKET, 4096, (_target, buffer) => {
    out += buffer;
  });
  try {
    await fn();
  } finally {
    Com_EndRedirect();
  }
  return out;
}

describe.skipIf(!havePak)("nav loading is family-aware (sv_nav_legacy) on the real rerelease base1.bsp", () => {
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;
  let preTestGameCvar: string;
  let preTestCsr: CsRemapT;
  let preTestCodec: ProtocolCodec;

  beforeAll(async () => {
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();
    preTestGameCvar = Cvar_VariableString("game");
    preTestCsr = svs.csr;
    preTestCodec = svs.codec;

    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");

    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "", "+set", "dedicated", "1", "+set", "port", "0"]);

    // Campaign rules, same reasoning as legacy_base1_rerelease_boot.test.ts:
    // a bare dedicated boot forces deathmatch (sv_init.c:318-324), which
    // inhibits the exact func_button/func_explosive entities base1.nav's
    // records need bound (finding 6+10's closure). coop 1 sidesteps that.
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("skill", "1");
  }, 300000);

  afterAll(async () => {
    SV_Shutdown("nav family-gating boot test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);

    geHolder.ge = null;
    svs.csr = preTestCsr;
    svs.codec = preTestCodec;
    Cvar_ForceSet("game", preTestGameCvar);
  });

  test(
    "legacy family, sv_nav_legacy off (default): nav never loads, no missing-entity spam",
    async () => {
      Cvar_ForceSet("game", "");
      // Exercise the real default: register with Cvar_Get exactly like
      // Nav_Init does, at "0", rather than assuming no prior test in this
      // process already forced it on.
      Cvar_Get("sv_nav_legacy", "0", 0);
      Cvar_ForceSet("sv_nav_legacy", "0");

      const printed = await captureComPrintf(() => bootMapSettled("base1"));

      expect(sv.state).toBe(ServerStateT.ss_game);
      expect(currentGameFamily()).toBe("legacy");
      expect(svs.csr).toBe(CS_REMAP_OLD);
      expect(svs.codec).toBe(VANILLA_CODEC);

      const nav = Nav_DebugState();
      // freshNavData()'s own default -- Nav_Load was never called at all.
      expect(nav.loaded).toBe(false);
      expect(nav.num_edicts).toBe(0);
      expect(nav.edicts).toHaveLength(0);

      expect(printed).not.toContain("Nav entity");
      expect(printed).not.toContain("appears to be missing");
    },
    300000,
  );

  test(
    "legacy family, sv_nav_legacy on: nav loads and every nav-file edict resolves against real entities",
    async () => {
      Cvar_ForceSet("game", "");
      Cvar_ForceSet("sv_nav_legacy", "1");

      const printed = await captureComPrintf(() => bootMapSettled("base1"));

      expect(sv.state).toBe(ServerStateT.ss_game);
      expect(currentGameFamily()).toBe("legacy");

      const nav = Nav_DebugState();
      expect(nav.loaded).toBe(true);
      // base1.nav genuinely ships edict records (confirmed by
      // legacy_base1_rerelease_boot.test.ts's own campaign-mode assertions
      // against modelindex 14/22/32) -- a real load, not the "file missing"
      // degenerate case.
      expect(nav.num_edicts).toBeGreaterThan(0);
      expect(nav.edicts.length).toBe(nav.num_edicts);

      for (const e of nav.edicts) {
        expect(e.game_edict).not.toBeNull();
      }

      expect(printed).not.toContain("appears to be missing");
    },
    300000,
  );

  test(
    "kex family is unaffected: nav loads unconditionally, zero missing-entity warnings, same as always",
    async () => {
      Cvar_ForceSet("game", "kex");
      // Prove the cvar genuinely isn't consulted on this path: leave it off.
      Cvar_ForceSet("sv_nav_legacy", "0");

      const printed = await captureComPrintf(() => bootMapSettled("base1"));

      expect(sv.state).toBe(ServerStateT.ss_game);
      expect(currentGameFamily()).toBe("kex");
      expect(svs.csr).toBe(CS_REMAP_RERELEASE);
      expect(svs.codec).toBe(Q2REPRO_CODEC);

      const nav = Nav_DebugState();
      expect(nav.loaded).toBe(true);
      expect(nav.num_edicts).toBeGreaterThan(0);
      for (const e of nav.edicts) {
        expect(e.game_edict).not.toBeNull();
      }

      expect(printed).not.toContain("appears to be missing");
    },
    300000,
  );
});
