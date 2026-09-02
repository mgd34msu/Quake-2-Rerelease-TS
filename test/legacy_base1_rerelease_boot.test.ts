/*
Dedicated boot of the LEGACY (vanilla 3.21) game module against the REAL
rerelease-upgraded maps/base1.bsp -- the exact data/ruleset pairing behind
.orch/followups.md's finding 6 ("inline brush-model entities MISSING on
base1: door absent, exit buttons absent, exit elevator has no collision, the
player falls down the shaft and cannot finish the level") and its addendum
("Nav entity appears to be missing (needs entity with model 22 / 14 / 32)").

WHAT THIS FILE PINS, AND WHY IT EXISTS
--------------------------------------
The reported symptom is NOT a brush-model spawn failure. base1's doors,
buttons and the two-part exit elevator all spawn correctly under the legacy
module on rerelease data in CAMPAIGN play; they are absent in DEATHMATCH,
because that is what their own spawnflags and vanilla's own spawn rules say
must happen:

  *20 func_door   spawnflags 2048 (SPAWNFLAG_NOT_DEATHMATCH)  -- the door
  *13 func_button spawnflags 2048 (SPAWNFLAG_NOT_DEATHMATCH)  -- a button
  *33 func_door   spawnflags 2056 (NOT_DEATHMATCH | 8), team "1" \ the exit
  *34 func_door   spawnflags 2056 (NOT_DEATHMATCH | 8), team "1" / elevator

SpawnEntities' own deathmatch filter (src/game/g_spawn.ts, ported from
g_spawn.c's `if (deathmatch->value) { if (ent->spawnflags &
SPAWNFLAG_NOT_DEATHMATCH) { G_FreeEdict(ent); inhibit++; continue; } }`)
frees every one of them, which is exactly "the door is gone and the exit
elevator has no collision".

That matters because a DEDICATED server reaches deathmatch on its own
without anyone asking for it: src/server/sv_init.ts's SV_InitGame ports
vanilla sv_init.c:318-324 verbatim -- "dedicated servers are can't be single
player and are usually DM, so unless they explicity set coop, force it to
deathmatch" -- so `dedicated 1` + a bare `map base1` is a DEATHMATCH session,
campaign geometry and all. Hence this file's two halves: the campaign boot
proves the entities really do spawn with their inline models bound, and the
deathmatch re-boot proves their absence is the documented spawn rule firing,
not a regression in setmodel/modelindex resolution.

The nav warnings in that same report are a downstream consequence of the
same deathmatch inhibition, not independent evidence of a spawn bug. The
three inline models base1.nav references resolve to *13 func_button
(modelindex 14), *21 func_explosive (22) and *31 func_explosive (32) -- the
button is NOT_DEATHMATCH, and both func_explosives delete themselves in
deathmatch (src/game/g_misc.ts's SP_func_explosive, ported from g_misc.c's
"auto-remove for deathmatch"). All three vanish together in deathmatch and
Nav_SetupEntities then reports all four of base1.nav's edict records
missing, which is what the live console showed.

Retail-gated: skips itself if the retail install isn't present, matching
every other retail-gated test in this suite (loud skip via describe.skipIf,
no silent no-op). No retail content is copied into this repository -- the
map is read from the user's own install at run time through the normal
filesystem search path.

Global hygiene follows test/lmctf_kex_boot.test.ts's afterAll pattern
exactly (fs_searchpaths, cvar_vars, the raw "game" cvar string, svs.csr,
svs.codec and geHolder are all snapshotted and restored), for the same
reasons that file's own comments spell out.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cls, ConnstateT } from "../src/client/client";
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
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";
import { g_edicts, type EdictT } from "../src/game/g_local";
import { SolidT } from "../src/game/game";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

const MAP_POLL_LIMIT = 600;

async function bootMap(mapname: string): Promise<void> {
  Cbuf_AddText(`map ${mapname}\n`);
  // Drain a few frames unconditionally BEFORE polling for ss_game. The
  // second boot in this file re-loads the same map while the server is
  // already sitting in ss_game, so a bare "poll until ss_game" loop would
  // return instantly having never executed the queued `map` command at all
  // (Cbuf_Execute runs once per frame). These blind frames guarantee the
  // command actually runs and SV_SpawnServer has cycled the state.
  for (let i = 0; i < 10; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
  for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

/** Every live entity bound to the given inline brush model ("*20" etc.). */
function edictsWithModel(model: string): EdictT[] {
  return g_edicts.filter((e): e is EdictT => e !== undefined && e.inuse && e.model === model);
}

/** The single live entity bound to `model`, or null when none survived spawn. */
function edictWithModel(model: string): EdictT | null {
  const found = edictsWithModel(model);
  return found.length === 1 ? found[0] ?? null : null;
}

describe.skipIf(!havePak)("legacy 3.21 game module on the real rerelease base1.bsp", () => {
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

    // In-process boot: a real process starts with cls.state fresh, and CL_Init
    // returns before touching it under dedicated=1, so reset what an earlier
    // suite in this process may have left connected (otherwise init's default
    // startup command forwards to a netchan that was never set up).
    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "", "+set", "dedicated", "1", "+set", "port", "0"]);

    // Campaign-equivalent play. `coop 1` is what actually reaches the
    // single-player spawn rules on a DEDICATED server: SV_InitGame's ported
    // sv_init.c:318-324 rule forces deathmatch 1 on any dedicated server
    // that has NOT explicitly set coop, so `deathmatch 0` alone would be
    // overwritten right back to 1 before SpawnEntities ever runs. Coop and
    // single player take the identical branch of the spawn filter for every
    // entity asserted below (none of them carries SPAWNFLAG_NOT_COOP).
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("skill", "1");

    await bootMap("base1");
  }, 300000);

  afterAll(async () => {
    SV_Shutdown("legacy base1 rerelease boot test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);

    geHolder.ge = null;
    svs.csr = preTestCsr;
    svs.codec = preTestCodec;
    Cvar_ForceSet("game", preTestGameCvar);
  });

  test("base1 reaches ss_game under the legacy module and the legacy wire family", () => {
    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(sv.name).toBe("base1");
    expect(geHolder.ge).not.toBeNull();
    expect(currentGameFamily()).toBe("legacy");
    // The RULESET is still the legacy one; the LAYOUT is not, and has not
    // been since sv_init.ts's SV_ContentNeedsWideLayout started asking the
    // map what it carries. Retail base1's entity lump has 37 dynamic_lights
    // with shadowlightradius keys, which the classic configstring layout has
    // no block for and protocol 34 no renderfx bit for, so this session
    // widens at spawn -- see that function's header for the full rule. The
    // 1997 base1 in the classic tree carries none of that and still comes up
    // CS_REMAP_OLD on protocol 34 (test/wide_classic_session.test.ts pins
    // both outcomes directly).
    expect(svs.csr).toBe(CS_REMAP_RERELEASE);
    // Campaign rules really are in force -- if this is 1, SV_InitGame's
    // dedicated-server rule won and every assertion below would be
    // measuring deathmatch instead.
    expect(Cvar_VariableString("deathmatch")).toBe("0");
    expect(Cvar_VariableString("coop")).toBe("1");
  });

  test("the door reported missing (*20 func_door) spawns with its inline model bound", () => {
    const door = edictWithModel("*20");
    expect(door).not.toBeNull();
    if (!door) return;
    expect(door.classname).toBe("func_door");
    // SV_SpawnServer pre-registers submodel N in configstring slot N+1
    // (world reserves slot 1), so "*20" must resolve to modelindex 21.
    expect(door.s.modelindex).toBe(21);
    expect(door.solid).toBe(SolidT.SOLID_BSP);
  });

  test("the exit buttons (*13 and *35 func_button) spawn with their inline models bound", () => {
    for (const [model, modelindex] of [
      ["*13", 14],
      ["*35", 36],
    ] as const) {
      const button = edictWithModel(model);
      expect(button).not.toBeNull();
      if (!button) continue;
      expect(button.classname).toBe("func_button");
      expect(button.s.modelindex).toBe(modelindex);
      expect(button.solid).toBe(SolidT.SOLID_BSP);
    }
  });

  test("the exit elevator (*33/*34, a linked func_door team) spawns solid, so the shaft has collision", () => {
    const lower = edictWithModel("*33");
    const upper = edictWithModel("*34");
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    if (!lower || !upper) return;

    for (const half of [lower, upper]) {
      expect(half.classname).toBe("func_door");
      expect(half.solid).toBe(SolidT.SOLID_BSP);
      // The entity lump gives both halves `team "1"`; G_FindTeams links
      // them into one moving group. A team door with no collision is the
      // exact live symptom ("player falls down the shaft").
      expect(half.team).toBe("1");
    }
    expect(lower.s.modelindex).toBe(34);
    expect(upper.s.modelindex).toBe(35);

    // G_FindTeams made them one chain rather than leaving two strays.
    const master = lower.teammaster ?? upper.teammaster;
    expect(master).not.toBeNull();
    expect(lower.teammaster).toBe(master);
    expect(upper.teammaster).toBe(master);
  });

  test("the three inline models base1.nav references all resolve to live entities in campaign play", () => {
    // base1.nav's four edict records reference modelindex 22, 14, 32 and 22
    // again. Under campaign rules every one of them is backed by a real,
    // live entity -- so the live console's four "Nav entity appears to be
    // missing" warnings cannot be blamed on campaign spawning.
    const byModelindex = new Map<number, EdictT>();
    for (const e of g_edicts) {
      if (e === undefined || !e.inuse) continue;
      if (typeof e.model === "string" && e.model.startsWith("*")) byModelindex.set(e.s.modelindex, e);
    }
    for (const modelindex of [14, 22, 32]) {
      expect(byModelindex.get(modelindex)).toBeDefined();
    }
    expect(byModelindex.get(14)?.classname).toBe("func_button");
    expect(byModelindex.get(22)?.classname).toBe("func_explosive");
    expect(byModelindex.get(32)?.classname).toBe("func_explosive");
  });

  test("every brush-model entity that survives spawn has a real, correctly numbered inline model", () => {
    const brushEnts = g_edicts.filter(
      (e): e is EdictT => e !== undefined && e.inuse && typeof e.model === "string" && e.model.startsWith("*"),
    );
    // The rerelease base1 lump carries 44 brush-model entities; the handful
    // held back in campaign play are the deathmatch-only func_walls whose
    // spawnflags carry the skill-inhibit bits.
    expect(brushEnts.length).toBeGreaterThan(35);
    for (const e of brushEnts) {
      const suffix = Number(String(e.model).slice(1));
      expect(Number.isFinite(suffix)).toBe(true);
      expect(e.s.modelindex).toBe(suffix + 1);
    }
  });

  test("DEATHMATCH re-boot: the same door, buttons and elevator are inhibited by their own spawnflags", async () => {
    // This is the reported failure reproduced deliberately. Re-boot the very
    // same map and data with deathmatch rules and watch NOT_DEATHMATCH do
    // exactly what g_spawn.c says it does.
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("deathmatch", "1");
    await bootMap("base1");

    expect(sv.state).toBe(ServerStateT.ss_game);
    expect(Cvar_VariableString("deathmatch")).toBe("1");

    // spawnflags 2048 / 2056 -- all four freed by the deathmatch filter.
    expect(edictsWithModel("*20")).toHaveLength(0);
    expect(edictsWithModel("*13")).toHaveLength(0);
    expect(edictsWithModel("*33")).toHaveLength(0);
    expect(edictsWithModel("*34")).toHaveLength(0);

    // ...while a brush entity with no deathmatch-inhibit bit is untouched,
    // proving this is the spawnflag filter and not a wholesale bmodel
    // spawn/setmodel failure.
    const survivor = edictWithModel("*32");
    expect(survivor).not.toBeNull();
    expect(survivor?.classname).toBe("func_door");
    expect(survivor?.s.modelindex).toBe(33);

    // The two func_explosives behind base1.nav's model 22 and 32 records are
    // gone too -- SP_func_explosive's own "auto-remove for deathmatch".
    expect(edictsWithModel("*21")).toHaveLength(0);
    expect(edictsWithModel("*31")).toHaveLength(0);
  }, 300000);
});
