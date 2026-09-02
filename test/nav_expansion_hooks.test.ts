/*
The nav-mesh path query under the EXPANSION game modules -- src/xatrix and
src/rogue -- against base1's real shipped navigation graph.

WHY THIS FILE EXISTS. test/nav_compass_hook.test.ts pinned the classic
(src/game) tree's `get_path_to_goal` hook against the kex binding's
GetPathToGoal. The two mission-pack trees are HARD FORKS of src/game with
their own GameImports interfaces, and both kept a straight-line
distance_to_poi because neither interface NAMED a nav entry point -- even
though src/server/bindings/legacy.ts's BuildLegacyImports has been handing
all four legacy trees the same import object, `get_path_to_goal` included,
the whole time. So a teamed target_poi with the NEAREST flag ranked its
candidates through walls under Xatrix and Ground Zero while ranking them by
walked distance under baseq2.

What this file proves is that the gap is closed at both ends: the shape each
tree declares accepts the object the engine actually supplies (that half is
enforced by the tsc gate, through the typed bindings below), and a request
built with each tree's own PathQueryT comes back with the same points as the
classic tree's.

No copyrighted data is committed: bots/navigation/base1.nav and
maps/base1.bsp are read out of the user's local retail install at run time,
and every case skips when that install is absent -- the same convention
test/nav_compass_hook.test.ts and the rest of the retail-gated suite follow.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { CM_LoadMap } from "../src/qcommon/cmodel";
import { sv } from "../src/server/server";
import { SV_ClearWorld } from "../src/server/sv_world";
import { vec3, type Vec3 } from "../src/shared/math";
import { Nav_Load, Nav_Unload } from "../src/server/nav";
import { BuildLegacyImports } from "../src/server/bindings/legacy";
import type { GameImports as ClassicImports, PathQueryT as ClassicQueryT } from "../src/game/game";
import type { GameImports as XatrixImports, PathQueryT as XatrixQueryT } from "../src/xatrix/game";
import type { GameImports as RogueImports, PathQueryT as RogueQueryT } from "../src/rogue/game";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const havePak = existsSync(`${RETAIL_BASEDIR}/baseq2/pak0.pak`);

/** base1's `info_player_start` and its `target_poi` "t70", the same two
 *  points test/nav_compass_hook.test.ts uses. */
const BASE1_START: Vec3 = vec3(128, -320, 32);
const BASE1_POI: Vec3 = vec3(-1664, 1536, 144);

/** g_items.cpp:1495: `constexpr size_t MAX_TEMP_POI_POINTS = 128;`. */
const MAX_TEMP_POI_POINTS = 128;

function buffer(): Vec3[] {
  return Array.from({ length: MAX_TEMP_POI_POINTS }, () => vec3());
}

/** g_target.cpp:1604-1607's node-search settings, the ones every tree's
 *  distance_to_poi now builds. The three trees declare three separately
 *  spelled PathQueryT interfaces (hard forks), so this is generic over
 *  which one is being built -- if any of them drifts in shape, this file
 *  stops compiling, which is the point. */
function compassQuery<Q extends ClassicQueryT | XatrixQueryT | RogueQueryT>(points: Vec3[] | null): Q {
  return {
    start: BASE1_START,
    goal: BASE1_POI,
    moveDist: 64,
    pathFlags: 0xffffffff,
    ignoreNodeFlags: true,
    minHeight: 128,
    maxHeight: 128,
    radius: 1024,
    points,
    maxPoints: points === null ? 0 : MAX_TEMP_POI_POINTS,
  } as Q;
}

describe("expansion-module nav hooks on base1's real .nav (skipped if the retail install isn't present)", () => {
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    if (!havePak) return;
    fsSnapshot = FS_TestSnapshotSearchPaths();
    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    FS_InitFilesystem();

    // Nav_ClosestNodeTo traces against the loaded world, so the collision
    // model has to be up before any query runs.
    sv.models[1] = CM_LoadMap("maps/base1.bsp", false).model;
    SV_ClearWorld();

    Nav_Unload();
    Nav_Load("base1");
  });

  afterAll(() => {
    if (!havePak) return;
    Nav_Unload();
    FS_TestRestoreSearchPaths(fsSnapshot);
  });

  test("BuildLegacyImports supplies get_path_to_goal, and all three trees' GameImports accept it", () => {
    // ONE import object goes to all four legacy trees (legacy.ts's
    // LoadLegacyGame hands `importsObj` to every GetGameAPI), so the runtime
    // half was never the problem -- naming the hook in each tree's own
    // interface is. These three bindings are the assertion: they only
    // compile if src/xatrix/game.ts and src/rogue/game.ts declare a
    // `get_path_to_goal` compatible with the one the engine builds.
    const imports = BuildLegacyImports();
    const asClassic: ClassicImports = imports;
    const asXatrix: XatrixImports = imports;
    const asRogue: RogueImports = imports;

    expect(typeof asClassic.get_path_to_goal).toBe("function");
    expect(typeof asXatrix.get_path_to_goal).toBe("function");
    expect(typeof asRogue.get_path_to_goal).toBe("function");
  });

  test.skipIf(!havePak)("a xatrix-shaped and a rogue-shaped request return the classic request's points exactly", () => {
    const imports = BuildLegacyImports();

    const classicPoints = buffer();
    const classicResult = (imports as ClassicImports).get_path_to_goal!(compassQuery<ClassicQueryT>(classicPoints));

    const xatrixPoints = buffer();
    const xatrixResult = (imports as XatrixImports).get_path_to_goal!(compassQuery<XatrixQueryT>(xatrixPoints));

    const roguePoints = buffer();
    const rogueResult = (imports as RogueImports).get_path_to_goal!(compassQuery<RogueQueryT>(roguePoints));

    // The path has to be real, or "they all agree" would be vacuous.
    expect(classicResult.found).toBe(true);
    expect(classicResult.numPathPoints).toBeGreaterThan(1);

    for (const [label, result, points] of [
      ["xatrix", xatrixResult, xatrixPoints],
      ["rogue", rogueResult, roguePoints],
    ] as const) {
      expect(`${label}:${result.found}`).toBe(`${label}:${classicResult.found}`);
      expect(`${label}:${result.returnCode}`).toBe(`${label}:${classicResult.returnCode}`);
      expect(`${label}:${result.numPathPoints}`).toBe(`${label}:${classicResult.numPathPoints}`);
      expect(`${label}:${result.pathDistSqr}`).toBe(`${label}:${classicResult.pathDistSqr}`);
      for (let i = 0; i < classicResult.numPathPoints; i++) {
        expect([...points[i]!]).toEqual([...classicPoints[i]!]);
      }
    }
  });

  test.skipIf(!havePak)("an unreachable goal comes back as a failure, which is what target_poi ranks as unreachable", () => {
    // This is the behavior change the hook actually buys target_poi under
    // the expansions today. distance_to_poi's three outcomes are: path found
    // -> pathDistSqr; NoNavAvailable -> straight-line squared; any other
    // failure -> Infinity, which target_poi_use's NEAREST scan treats as
    // "skip this candidate". Before the hook every candidate was a finite
    // straight-line number, so a POI behind a sealed wall could win.
    const imports = BuildLegacyImports();

    const reachable = (imports as XatrixImports).get_path_to_goal!(compassQuery<XatrixQueryT>(null));
    expect(reachable.found).toBe(true);

    const unreachableQuery = compassQuery<RogueQueryT>(null);
    unreachableQuery.goal = vec3(100000, 100000, 100000); // far outside base1
    const unreachable = (imports as RogueImports).get_path_to_goal!(unreachableQuery);
    expect(unreachable.found).toBe(false);
    // ...and specifically NOT "no nav available" (8), the one code that means
    // "fall back to straight-line distance" rather than "unreachable".
    expect(unreachable.returnCode).not.toBe(8);
  });

  test.skipIf(!havePak)("pathDistSqr is the real walked distance now, matching the real re-release engine rather than q2repro's reference", () => {
    // q2repro's inc/shared/game.h:285 declares `float pathDistSqr
    // /*= 0.0f*/` and nothing in q2repro's own nav.c reimplementation of the
    // KEX engine's pathfinder ever assigns it -- the open-source reference
    // this port otherwise mirrors line-for-line leaves the field alone. The
    // real re-release engine DOES fill it, and this port now matches that
    // (see src/server/nav.ts's Nav_ReachedGoal for where and why:
    // distance_to_poi and target_poi's SPAWNFLAG_POI_NEAREST ranking need a
    // genuine walked distance to break ties, not a tie at zero).
    //
    // This case used to pin pathDistSqr at 0 across all three trees, with a
    // comment saying it should start failing the day nav.ts computes a real
    // length -- that day is this one. It now asserts the walked distance is
    // at least the straight-line distance (base1's start and its POI are not
    // mutually visible, so the nav-mesh route can only be as long or longer
    // than a straight line) and that it comes back identical across all
    // three legacy trees, since they all reach the same src/server/nav.ts
    // A* query.
    const imports = BuildLegacyImports();
    const classic = (imports as ClassicImports).get_path_to_goal!(compassQuery<ClassicQueryT>(null));
    const xatrix = (imports as XatrixImports).get_path_to_goal!(compassQuery<XatrixQueryT>(null));
    const rogue = (imports as RogueImports).get_path_to_goal!(compassQuery<RogueQueryT>(null));

    expect(classic.found).toBe(true);

    const dx = BASE1_POI[0] - BASE1_START[0];
    const dy = BASE1_POI[1] - BASE1_START[1];
    const dz = BASE1_POI[2] - BASE1_START[2];
    const straightSqr = dx * dx + dy * dy + dz * dz;

    expect(classic.pathDistSqr).toBeGreaterThanOrEqual(straightSqr);
    expect(xatrix.pathDistSqr).toBe(classic.pathDistSqr);
    expect(rogue.pathDistSqr).toBe(classic.pathDistSqr);
  });
});
