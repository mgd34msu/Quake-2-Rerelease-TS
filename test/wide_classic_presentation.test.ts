/*
What a WIDENED classic-module session actually puts on the wire, driven
against the real retail maps rather than synthetic state.

Since sv_init.ts's SV_ContentNeedsWideLayout, a classic-ruleset session on
re-release content starts on the wide configstring layout, which is what sets
cls.csr.extended on the client and so what turns on flares, per-pixel shadow
lights, and per-entity alpha/scale. Widening the SESSION is necessary but on
its own it was not sufficient: three things in src/game were written to hold
their re-release presentation back because protocol 34 could not carry it,
and each had to learn to ask (gi.extended_layout()) instead of assuming.

This file pins all three against real content, because each of them is a
server-side decision that no amount of client-side testing can catch:

  1. dynamic_light -- RF_CASTSHADOW plus one CS_SHADOWLIGHTS configstring per
     light. Retail base1 has 37 of them and nothing else extended, so it is
     the clean case for the shadow-light path on its own.

  2. misc_flare / target_light -- `s.modelindex = 1`. The re-release sets it
     purely so the entity survives the server's "has a model" visibility test
     (sv_ents.ts's modelindex/effects/sound/event/RF_CASTSHADOW cull); the
     client's RF_FLARE / RF_CUSTOM_LIGHT branches consume the entity before
     the model lookup, so the 1 never reaches the renderer. src/game omitted
     it because on a NARROW session those branches do not exist and
     modelindex 1 would resolve to the world model. Without restoring it on a
     wide session the flare's renderfx, tint, fade distances and scale all
     travel correctly and STILL nothing draws, because the entity never
     leaves the server. Caught exactly that way: a 360-degree sweep of
     q64/complex under a widened classic session was pixel-identical to the
     same sweep under protocol 34.

  3. `_color` -- the one underscore-prefixed key the re-release parser does
     not discard, and the only place base1's shadow lights carry their tint.

Retail-gated the same way every other retail test in this suite is: loud skip
via describe.skipIf when the install is absent, and no retail content is
copied into the repository -- the maps are read from the user's own install
through the normal search path at run time.

Harness (Qcommon_Init + Cbuf "map" + frame pump, and the
fs/cvar/csr/codec/geHolder restore in afterAll) follows
test/legacy_base1_rerelease_boot.test.ts exactly; it is a private copy per
this suite's self-sufficient-test-file rule rather than a shared import.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
// cs_remap first, deliberately: src/ref_soft/r_model.ts reads
// MAX_MODELS_WIDE at module scope, and pulling the client/server graph in
// ahead of it lands in the middle of that cycle with the binding still in
// its temporal dead zone. Importing the leaf module first fixes the
// initialization order for this file. (Same reason
// test/legacy_base1_rerelease_boot.test.ts happens to be safe -- its own
// import list reaches cs_remap through a different edge.)
import { CS_REMAP_RERELEASE, type CsRemapT } from "../src/shared/cs_remap";
import { cls, ConnstateT } from "../src/client/client";
import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE, RF_CASTSHADOW, RF_FLARE, RF_CUSTOM_LIGHT } from "../src/shared/q_shared";
import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, svs, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { geHolder, currentGameFamily } from "../src/server/sv_game";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";
import { g_edicts, type EdictT } from "../src/game/g_local";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

const MAP_POLL_LIMIT = 600;

async function bootMap(mapname: string): Promise<void> {
  Cbuf_AddText(`map ${mapname}\n`);
  // Blind frames first: a `map` issued while the server already sits in
  // ss_game would otherwise let a bare "poll until ss_game" loop return
  // before Cbuf_Execute ever ran the command.
  for (let i = 0; i < 10; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
  for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

function liveEdicts(): EdictT[] {
  return g_edicts.filter((e): e is EdictT => e !== undefined && e.inuse);
}

function edictsOfClass(classname: string): EdictT[] {
  return liveEdicts().filter((e) => e.classname === classname);
}

describe.skipIf(!havePak)("widened classic session: re-release presentation on real retail maps", () => {
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
    Cvar_ForceSet("game", ""); // the CLASSIC (3.21) module -- this is the whole point
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");

    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "", "+set", "dedicated", "1", "+set", "port", "0"]);

    // Campaign-equivalent rules; see legacy_base1_rerelease_boot.test.ts for
    // why `coop 1` (and not `deathmatch 0` alone) is what reaches them on a
    // dedicated server.
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("skill", "1");

    await bootMap("base1");
  }, 300000);

  afterAll(async () => {
    SV_Shutdown("wide classic presentation test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);

    geHolder.ge = null;
    svs.csr = preTestCsr;
    svs.codec = preTestCodec;
    Cvar_ForceSet("game", preTestGameCvar);
  });

  test("retail base1 under the classic ruleset comes up on the wide layout", () => {
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(sv.name).toBe("base1");
    expect(currentGameFamily()).toBe("legacy");
    // The ruleset stayed classic; only the layout moved.
    expect(svs.csr).toBe(CS_REMAP_RERELEASE);
    expect(svs.csr.extended).toBe(true);
  });

  test("base1's dynamic_lights are stamped RF_CASTSHADOW so the server keeps them in client frames", () => {
    const lights = edictsOfClass("dynamic_light");
    // The retail lump has 37; assert the shape, not a magic count, so a
    // content update does not make this file lie.
    expect(lights.length).toBeGreaterThan(0);

    // Every one that recorded shadow data must carry the renderfx bit --
    // without it sv_ents.ts culls a modelindex-0 entity from every frame and
    // the client's CL_AddShadowLights, which reads cl_entities[] by number,
    // finds nothing to attach the light to.
    const stamped = lights.filter((e) => (e.s.renderfx & RF_CASTSHADOW) !== 0);
    expect(stamped.length).toBeGreaterThan(0);
  });

  test("base1 publishes one well-formed CS_SHADOWLIGHTS configstring per shadow light", () => {
    const block = sv.configstrings.slice(CS_REMAP_RERELEASE.shadowlights, CS_REMAP_RERELEASE.shadowlights + CS_REMAP_RERELEASE.max_shadowlights);
    const published = block.filter((s) => s.length > 0);
    expect(published.length).toBeGreaterThan(0);

    for (const s of published) {
      // cl_fx.ts's CL_ParseShadowLightConfigstring silently drops anything
      // that is not exactly 12 semicolon-separated fields, so a malformed
      // string here would be an invisible failure on the client.
      const parts = s.split(";");
      expect(parts).toHaveLength(12);
      const entnum = Number.parseInt(parts[0] ?? "", 10);
      // Field 0 is the entity number the light rides on; the client looks it
      // up in cl_entities[] every frame.
      expect(Number.isFinite(entnum)).toBe(true);
      expect(entnum).toBeGreaterThan(0);
      // Field 2 is the radius, which is what made the light exist at all.
      expect(Number.parseFloat(parts[2] ?? "")).toBeGreaterThan(0);
    }

    // Every published slot is packed from index 0 with no holes, matching the
    // re-release's own writer (setup_shadow_lights walks 0..count-1).
    expect(block.slice(0, published.length).every((s) => s.length > 0)).toBe(true);
  });

  test("`_color` reaches s.skinnum, which is where the client reads a shadow light's tint", () => {
    // Retail base1 carries `_color "1 1 0.501961"` on its bright yellow
    // lights. Vanilla 3.21 discards every underscore key; the re-release
    // parser carves out exactly this one, and so does src/game now, on a wide
    // session only. Without it cl_fx.ts's unpackShadowLightColor sees
    // skinnum 0 and paints every light white.
    const tinted = edictsOfClass("dynamic_light").filter((e) => e.s.skinnum !== 0);
    expect(tinted.length).toBeGreaterThan(0);
  });

  test("a widened classic session announces the engine-local protocol, not 34", () => {
    // Restating the wire consequence at the level a player feels it: this is
    // the number a joining client negotiates against, and the reason
    // cls.csr.extended is set on the other end.
    expect(svs.sessionProtocol).not.toBe(0);
    expect(svs.codec.name).toBe("q2repro-classic");
  });

  test("mgu2m3's misc_flares survive the server's visibility cull and carry their flare state", async () => {
    await bootMap("mgu2m3");
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(sv.name).toBe("mgu2m3");
    expect(svs.csr).toBe(CS_REMAP_RERELEASE);

    const flares = edictsOfClass("misc_flare");
    expect(flares.length).toBeGreaterThan(0);

    for (const f of flares) {
      expect(f.s.renderfx & RF_FLARE).toBe(RF_FLARE);
      // THE load-bearing assertion. modelindex 0 means sv_ents.ts drops the
      // entity from every frame and the flare is invisible no matter how
      // correct the rest of its state is.
      expect(f.s.modelindex).toBe(1);
      // The fade distances the client's RF_FLARE branch reads out of the
      // modelindex2/modelindex3 fields, and turns into the flare's alpha
      // ramp. Both must be non-zero and ordered: with both at 0 -- what the
      // classic SpawnTempT used to default them to -- the ramp collapses to
      // "always fully opaque" and no distance fade happens at all. mgu2m3
      // spells fade_start_dist on some of its 53 flares (64) and leaves it to
      // the re-release default on others (96), so the shape is what is
      // asserted here, not one magic pair.
      expect(f.s.modelindex2).toBeGreaterThan(0);
      expect(f.s.modelindex3).toBeGreaterThan(f.s.modelindex2);
    }
  }, 300000);

  test("target_lights likewise get a modelindex on a wide session", async () => {
    await bootMap("q64/geo-stat");
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(svs.csr).toBe(CS_REMAP_RERELEASE);

    const lights = edictsOfClass("target_light");
    expect(lights.length).toBeGreaterThan(0);
    for (const l of lights) {
      expect(l.s.renderfx & RF_CUSTOM_LIGHT).toBe(RF_CUSTOM_LIGHT);
      expect(l.s.modelindex).toBe(1);
      // s.frame is the light radius the client hands to V_AddLight.
      expect(l.s.frame).toBeGreaterThan(0);
    }
  }, 300000);
});
