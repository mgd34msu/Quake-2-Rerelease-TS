/*
Inline brush-model bounds must survive the kex edict bridge.

THE DEFECT THIS GATES (reproduced live on mgu2m3, Call of the Machine).
Booting `+map mgu2m3 +set game kex` and reading the frame 80 frames after
load showed the large "PS"-emblem func_door directly in front of the start
point simply ABSENT -- the corridor read as wide open, with the hall beyond
fully visible. The same map under `+set game baseq2` drew that door closed,
which is the correct, original behavior. So the re-release module, not the
classic one, was the broken side.

ROOT CAUSE. src/server/bindings/kex.ts keeps two views of every entity (a
KexEdictT the game module sees and an engine-side Edict), and syncs them
field by field. `syncLinkResultsToKex` exists to copy back the fields only
the engine computes. It copied `absmin`/`absmax`/`size`/`s.solid`/
`s.modelindex`/`s.old_origin`/`linkcount`/`areanum`/`areanum2`/`linked` --
but NOT `mins`/`maxs`. PF_setmodel's inline-model branch (src/server/
sv_game.ts, "Also sets mins and maxs for inline bmodels") is the engine's
only writer of those two: it reads CM_InlineModel("*N")'s bounds into
`eng.mins`/`eng.maxs` and relinks. With no copy-back the kex-side edict kept
mins == maxs == (0,0,0) forever, and -- because `syncEdictKexToEngine`
copies kex -> engine on the NEXT link -- that zero box was then written back
OVER the engine's own correct bounds. The damage therefore was not confined
to the game module's view: SV_LinkEdict recomputed `size` as (0,0,0) and
`absmin`/`absmax` as origin +/- 1 for every func_door / func_plat /
func_train / func_button / func_wall and every brush trigger_* on the map.

Measured on mgu2m3's func_door "*90" before the fix:
    mins=(0,0,0) maxs=(0,0,0) absmin=(-1,-1,-1) absmax=(1,1,1)
and its auto-spawned door trigger field came out as
    (-61,-61,-1)..(61,61,1)
-- a ~122x122x2 box sitting at the world origin -- instead of the correct
    (-1934,866,-1282)..(-1778,1118,-1150)
that the classic module produced from the same entity. Collapsed to a
degenerate box at the origin, those entities fell out of the player's PVS
(hence invisible), their door/plat trigger fields could never be reached,
and brush triggers could never be touched at all. On mgu2m3 that also meant
the trigger_once "*91" the player spawns inside never fired its
"objective_reach_comms_center" target; after the fix it fires on the first
frame, exactly as it does under the classic module.

This is the second instance of one bug: the same function carries a comment
recording that `s.modelindex` had been missing from the same copy-back list
for the same reason. The real engine has a single edict_t, so nothing there
can drift; the two-object split is this port's own architecture, and
copying every engine-computed field back is exactly what that function is
for.

WHAT THIS FILE ASSERTS, over real shipped maps, both game modules:
  1. Every in-use entity carrying an inline "*N" model has mins/maxs equal
     to CM_InlineModel("*N")'s own bounds -- i.e. non-degenerate, and the
     value PF_setmodel put there. This is the rule that was broken, and it
     is asserted for the RE-RELEASE module (where it regressed) and for the
     CLASSIC module (which was already correct and must stay that way).
  2. The two modules agree entity-for-entity on those bounds. This is the
     cross-module diff the defect would have failed loudly: pre-fix, every
     one of mgu2m3's brush entities differed between the two.

Retail-gated: skips itself when the retail install is absent, matching every
other retail-gated file in this suite. No retail content is copied into the
repository -- the maps are read out of the user's local install at test-run
time through this port's own normal FS code, with `basedir` pointed at the
real retail root, exactly the way a real play session reads them.
*/

import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE } from "../src/shared/q_shared";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { cls, ConnstateT } from "../src/client/client";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { CM_InlineModel } from "../src/qcommon/cmodel";
import { FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";
import { g_edicts as kexEdicts } from "../src/kexgame/g_main_globals";
import { g_edicts as classicEdicts } from "../src/game/g_local";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

// Real maps are large (mguhub ~33MB); generous poll budget, same as
// test/dedicated_boot_retail_mgu.test.ts's own.
const MAP_POLL_LIMIT = 600;

/*
The map this file gates. mgu2m3 is the map the defect was reported and
reproduced on: it is a Call of the Machine map (re-release content) whose
start point sits directly in front of an untargeted func_door and inside a
brush trigger_once, so it exercises both halves of the breakage -- an
invisible mover and an unreachable brush trigger -- in the first frame.
*/
const MAP = "mgu2m3";

/** One entity's identity + bounds, keyed by edict slot so the two modules'
 *  records line up entity-for-entity (both modules spawn the same entity
 *  lump in the same order into the same slots). */
interface BrushRecord {
  slot: number;
  classname: string;
  model: string;
  mins: [number, number, number];
  maxs: [number, number, number];
}

async function bootMap(mapname: string): Promise<void> {
  Cbuf_AddText(`map ${mapname}\n`);
  for (let i = 0; i < MAP_POLL_LIMIT && sv.state !== ServerStateT.ss_game; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
  }
}

interface MinimalEdict {
  inuse: boolean;
  classname: string | null;
  model: string | null;
  mins: Float32Array | number[];
  maxs: Float32Array | number[];
}

/** Collect every in-use entity that carries an inline "*N" model. */
function collectBrushRecords(edicts: readonly MinimalEdict[]): BrushRecord[] {
  const out: BrushRecord[] = [];
  for (let i = 0; i < edicts.length; i++) {
    const e = edicts[i];
    if (e === undefined || !e.inuse) continue;
    const model = e.model;
    if (model === null || model.length === 0 || model[0] !== "*") continue;
    out.push({
      slot: i,
      classname: e.classname ?? "",
      model,
      mins: [e.mins[0]!, e.mins[1]!, e.mins[2]!],
      maxs: [e.maxs[0]!, e.maxs[1]!, e.maxs[2]!],
    });
  }
  return out;
}

/** Every collected record must carry exactly the bounds CM_InlineModel
 *  holds for its own "*N" -- what PF_setmodel copies in. Returns a list of
 *  human-readable mismatches (empty when correct). */
function boundsMismatches(records: readonly BrushRecord[]): string[] {
  const bad: string[] = [];
  for (const r of records) {
    const cm = CM_InlineModel(r.model);
    for (let k = 0; k < 3; k++) {
      if (r.mins[k] !== cm.mins[k] || r.maxs[k] !== cm.maxs[k]) {
        bad.push(
          `slot ${r.slot} ${r.classname} ${r.model}: got mins=${r.mins.join(",")} maxs=${r.maxs.join(",")}` +
            ` expected mins=${cm.mins[0]},${cm.mins[1]},${cm.mins[2]} maxs=${cm.maxs[0]},${cm.maxs[1]},${cm.maxs[2]}`,
        );
        break;
      }
    }
  }
  return bad;
}

/** A degenerate (zero-volume) box is the exact pre-fix signature. Called out
 *  separately so a regression names the symptom, not just a diff. */
function degenerate(records: readonly BrushRecord[]): string[] {
  return records
    .filter((r) => r.mins[0] === r.maxs[0] && r.mins[1] === r.maxs[1] && r.mins[2] === r.maxs[2])
    .map((r) => `slot ${r.slot} ${r.classname} ${r.model}`);
}

let kexRecords: BrushRecord[] = [];
let classicRecords: BrushRecord[] = [];

describe.skipIf(!havePak)(`inline brush-model bounds survive the kex bridge -- ${MAP}`, () => {
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;

  beforeAll(async () => {
    // Same process-wide-singleton discipline as
    // test/dedicated_boot_retail_mgu.test.ts: pointing `basedir` at the real
    // retail install makes Qcommon_Init exec that install's real config.cfg,
    // which permanently bakes this machine's saved values into the
    // default_string of any cvar this dedicated boot path never Cvar_Get's
    // first. Snapshot both cvar_vars and fs_searchpaths before ANY mutation
    // and restore them in afterAll; see that file's header for the full
    // rationale and test/support/cvar_snapshot.ts for the recipe.
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();

    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "kex");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("deathmatch", "0");

    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "kex", "+set", "port", "0"]);

    await bootMap(MAP);
    kexRecords = collectBrushRecords(kexEdicts);
  }, 240000);

  afterAll(async () => {
    SV_Shutdown("inline model bounds test finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);
  });

  test("both modules actually spawned the map's brush entities", () => {
    // mgu2m3 places 90+ inline-model entities; a near-empty collection would
    // make every assertion below vacuously true.
    expect(kexRecords.length).toBeGreaterThan(50);
  });

  test("re-release module: no inline-model entity has a degenerate box", () => {
    // THE REGRESSION. Pre-fix this listed every brush entity on the map.
    expect(degenerate(kexRecords)).toEqual([]);
  });

  test("re-release module: inline-model bounds equal CM_InlineModel's", () => {
    expect(boundsMismatches(kexRecords)).toEqual([]);
  });

  test("the reported entity specifically: mgu2m3's func_door *90 is a real box", () => {
    // The door in front of the start point -- the one that was invisible.
    // Its CM bounds are the submodel's, expanded by 1 on every axis the way
    // CMod_LoadSubmodels does.
    const door = kexRecords.find((r) => r.model === "*90");
    expect(door).toBeDefined();
    expect(door!.classname).toBe("func_door");
    expect(door!.mins).toEqual([-1873, 927, -1281]);
    expect(door!.maxs).toEqual([-1839, 1057, -1151]);
  });
});

/*
The classic module over the same map, booted separately.

`game` is CVAR_LATCH and the game module is chosen at SV_InitGameProgs time,
so the two rulesets cannot be swapped inside one boot -- the second `map`
kept the first boot's module. Each ruleset therefore gets its own
Qcommon_Init with its own cvar/searchpath snapshot, exactly the way
test/dedicated_boot_retail_mgu.test.ts runs its two map boots. This block is
declared second on purpose: bun runs describes in source order, so
`kexRecords` is already populated when the cross-module diff below reads it.
*/
describe.skipIf(!havePak)(`inline brush-model bounds -- classic module cross-check -- ${MAP}`, () => {
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;

  beforeAll(async () => {
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();

    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "baseq2");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("deathmatch", "0");

    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init(["quake2", "+set", "basedir", RETAIL_BASEDIR, "+set", "game", "baseq2", "+set", "port", "0"]);

    await bootMap(MAP);
    classicRecords = collectBrushRecords(classicEdicts);
  }, 240000);

  afterAll(async () => {
    SV_Shutdown("inline model bounds classic cross-check finished\n", false);
    await NET_Shutdown();
    restoreCvars(cvarSnapshot);
    FS_TestRestoreSearchPaths(fsSnapshot);
  });

  test("classic module actually spawned the map's brush entities", () => {
    expect(classicRecords.length).toBeGreaterThan(50);
  });

  test("classic module: inline-model bounds equal CM_InlineModel's", () => {
    expect(degenerate(classicRecords)).toEqual([]);
    expect(boundsMismatches(classicRecords)).toEqual([]);
  });

  test("the two modules agree entity-for-entity on inline-model bounds", () => {
    expect(kexRecords.length).toBeGreaterThan(50); // guard against a vacuous pass
    const kexBySlot = new Map(kexRecords.map((r) => [r.slot, r]));
    const divergences: string[] = [];
    for (const c of classicRecords) {
      const k = kexBySlot.get(c.slot);
      if (k === undefined) continue; // module-specific spawn/inhibit differences are not this file's subject
      if (k.model !== c.model) continue;
      for (let i = 0; i < 3; i++) {
        if (k.mins[i] !== c.mins[i] || k.maxs[i] !== c.maxs[i]) {
          divergences.push(
            `slot ${c.slot} ${c.classname} ${c.model}: kex mins=${k.mins.join(",")} maxs=${k.maxs.join(",")}` +
              ` vs classic mins=${c.mins.join(",")} maxs=${c.maxs.join(",")}`,
          );
          break;
        }
      }
    }
    expect(divergences).toEqual([]);
  });
});
