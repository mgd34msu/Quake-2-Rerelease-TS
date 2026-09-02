/*
CROSS-MODULE MAP SWEEP -- every shipped map, booted under BOTH game modules,
compared frame by frame.

WHAT IT DOES
------------
Enumerates all 222 maps/*.bsp in the retail pak and, for each, spawns
test/support/parity_boot_driver.ts twice as a subprocess: once with
`game ""` (the classic src/game/ module) and once with `game kex` (the
re-release src/kexgame/ module). Each subprocess boots a DEDICATED headless
server on that map, connects one player, runs 100 server frames, and writes
a plain-JSON record of what happened -- live entity counts by classname,
every mover's moveinfo.state and origin, entities freed, and every
G_UseTargets firing. See that file's header for the boot shape and why it
forks instead of booting in-process.

That is 444 boots. They are cheap (a boot is well under a second) and run
five at a time, but this is still a minutes-long test, and it needs the
retail install, so it is retail-gated like every other retail test here and
skips itself loudly when the tree is absent. No retail content is copied
into this repository -- the driver reads pak0.pak through this port's own
FS_LoadFile with basedir pointed at the user's install, exactly the way a
real play session does.

DETERMINISM
-----------
The driver pins Math.random to a constant so the two modules draw the same
value for the same quantity (its header explains why a seeded stream would
not be enough). Two runs of the same tree therefore produce byte-identical
records, which is what lets the residual table below be an exact ratchet
rather than a fuzzy bound.

WHAT IT ASSERTS
---------------
1. Every one of the 444 boots reaches ss_game and puts a live player in the
   world. This is the sweep's real value: it is the regression guard for
   the four defects it found (below), each of which made some shipped map
   unreachable under one of the two modules.
2. Per-defect invariants on the exact maps that exposed each one.
3. Every divergence between the two modules is either mechanically
   classified as a documented, deliberate vanilla/re-release rule
   difference, or counted in an exact residual table. Anything new fails.

THE FOUR DEFECTS THIS SWEEP FOUND, AND WHERE THEY WERE FIXED
------------------------------------------------------------
(a) classic-module gap -- a trigger with no brush model. g_trigger.cpp:21-24
    guards `gi.setmodel`; vanilla does not, and PF_setmodel drops the server
    on a null name. badlands, city2, outbase, rhangar2 (trigger_once) and
    q64/orbit (trigger_coop_relay) could not reach ss_game.
    Fixed in src/game/g_trigger.ts.
(b) re-release-module bug -- stationarymonster_start stood as a throwing
    stub in src/kexgame/g_monster.ts on the claim that the shipped source
    had no definition. It does: rerelease/rogue/g_rogue_monster.cpp:88-96,
    already transcribed in src/kexgame/rogue/g_rogue_monster.ts. Every map
    with a crucified misc_insane died on it -- jail2, jail4, mgu5m3,
    q64/lab and the ten rogue r* maps. Fixed by pointing m_insane.ts and
    m_rogue_turret.ts at the real function.
(c) re-release-module bug -- COM_Parse used vanilla's 128-character token
    cap (q_shared.h:70) for the re-release module, which uses 512
    (game.h:122). mgu1m5's 151-character worldspawn "start_items" came back
    cut mid-word and Player_GiveStartItems dropped the server with
    `Invalid g_start_item entry: we`. Fixed in src/shared/math.ts (the cap
    is now a parameter, still defaulting to vanilla's 128) and
    src/kexgame/q_std.ts.
(d) classic-module gap -- func_plat2 spawnflag bit 8 is START_ACTIVE on
    re-release content (rogue/g_rogue_func.cpp:10, :391); vanilla rogue
    declares the same bit as PLAT2_TRIGGER_TOP and never reads it.
    hangar1, jail1 and xcompnd2 parked their plat at STATE_TOP where the
    re-release starts it at STATE_BOTTOM. Fixed in src/game/g_newfnc.ts.

Also fixed here, and not a game-module defect: three shipped maps
(test/mals_box, test/mals_ladder_test, test/mals_barrier_test) carry no
spawn point of any kind. Vanilla ends SelectSpawnPoint with gi.error; the
re-release spawns the player at the world origin. Fixed in
src/game/p_client.ts. See test/parity_rules.test.ts for the unit tests on
all of these.

DIVERGENCES THAT ARE NOT DEFECTS
--------------------------------
Three are recognised mechanically below, because each is a deliberate rule
difference between the two games and the classic module must keep vanilla's
side of it for 1997 content:

  C1  player_trail. p_trail.c's PlayerTrail_Init lays down all 8 marker
      entities at level start; p_trail.cpp:52 creates them lazily as the
      player actually moves. 222 maps, classic 8 -> kex 0 at spawn.
  C2  func_water and func_door_secret rename themselves. Vanilla's
      g_func.c:1439 (SP_func_water) and :2028 (SP_func_door_secret) both end
      with `self->classname = "func_door"`; the re-release dropped both
      lines. So the classic module reports 0 func_water, 0 func_door_secret
      and correspondingly more func_door.
  C3  the +9 spawn nudge. Vanilla p_client.c:911 does `origin[2] += 9` in
      SelectSpawnPoint; the re-release kept it only on the deathmatch path
      (p_client.cpp SelectSpawnPoint's DM branch) and dropped it for
      single-player and coop. The player falls those 9 units on frame one
      either way.

Everything else lands in RESIDUAL_BASELINE. That table is not a list of
things that are fine -- it is the catalogue of what this sweep has NOT
resolved, held to an exact count so nothing new hides in it. Its two
dominant causes, both established by reading the two sources rather than
guessed at:

  - LEVEL-START TIMING. Under the classic module a monster is already
    moving during SV_SpawnServer's settle frames, so it touches the door
    trigger Think_SpawnDoorTrigger just spawned and the door is already
    opening on frame zero; under the re-release module it is not, and the
    door stays shut. Touch_DoorTrigger and Think_SpawnDoorTrigger are
    line-for-line identical in the two sources (g_func.c vs g_func.cpp), so
    this is not a door rule -- it is when the monster first moves relative
    to the trigger being linked. It accounts for most of mover_state,
    mover_origin and the spawn_usetargets rows. Likewise func_timer fires
    on a different phase in the two modules (SP_func_timer is identical in
    both), which accounts for most of usetargets_classic_only.
  - SPAWNFLAG_NOT_COOP. The classic module deliberately keeps vanilla's
    commented-out semantics for it (see the commit that added
    SPAWNFLAG_COOP_ONLY's arm), so in a coop session it keeps entities the
    re-release module frees -- the drop-pod script on the six Call of the
    Machine entry maps is the visible case (an extra info_player_start,
    trigger_push, trigger_teleport and info_teleport_destination each).
    That is a standing decision, not an open defect.
*/

import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

const DRIVER = join(import.meta.dir, "support", "parity_boot_driver.ts");
const FRAMES = 100;
const PARALLEL = 5;

/** Minimal classic id PACK reader -- same shape as
 *  test/cmodel_retail_qbsp_sweep.test.ts's own listMguMaps. */
function listMaps(pakPath: string): string[] {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return [];
  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const out: string[] = [];
  for (let i = 0; i < dirlen / 64; i++) {
    const o = dirofs + i * 64;
    const name = data.toString("ascii", o, o + 56).replace(/\0.*$/, "");
    if (/^maps\/.*\.bsp$/i.test(name)) out.push(name.slice(5, -4));
  }
  return out.sort();
}

const allMaps = havePak ? listMaps(PAK_PATH) : [];

interface MoverT {
  num: number;
  classname: string;
  model: string | null;
  targetname: string | null;
  state: number;
  origin: [number, number, number];
}
interface UseEventT {
  classname: string | null;
  targetname: string | null;
  target: string | null;
  killtarget: string | null;
}
interface RecordT {
  map: string;
  game: string;
  ok: boolean;
  error: string | null;
  spawn_counts: Record<string, number>;
  spawn_total: number;
  spawn_movers: MoverT[];
  spawn_usetargets: UseEventT[];
  player_spawned: boolean;
  player_origin: [number, number, number] | null;
  final_counts: Record<string, number>;
  usetargets_summary: Record<string, [number, number]>;
}

const records = new Map<string, RecordT>();
let scratch = "";

function key(map: string, game: string): string {
  return `${game}|${map}`;
}

async function bootOne(map: string, game: string): Promise<void> {
  const tag = game === "" ? "classic" : game;
  const out = join(scratch, tag, `${map.replace(/\//g, "__")}.json`);
  const home = join(scratch, "home", tag, map.replace(/\//g, "__"));
  const proc = Bun.spawn(
    [
      "bun", DRIVER,
      "--basedir", RETAIL_BASEDIR,
      "--game", game,
      "--map", map,
      "--frames", String(FRAMES),
      "--out", out,
      "--homedir", home,
    ],
    { env: { ...process.env, Q2_PARITY_TRACE: "1" }, stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
  rmSync(home, { recursive: true, force: true });
  if (!existsSync(out)) {
    records.set(key(map, game), {
      map, game, ok: false, error: "driver produced no record (crashed before writing)",
      spawn_counts: {}, spawn_total: 0, spawn_movers: [], spawn_usetargets: [],
      player_spawned: false, player_origin: null, final_counts: {}, usetargets_summary: {},
    });
    return;
  }
  records.set(key(map, game), JSON.parse(readFileSync(out, "utf8")) as RecordT);
}

async function runSweep(): Promise<void> {
  const jobs: { map: string; game: string }[] = [];
  for (const m of allMaps) {
    jobs.push({ map: m, game: "" });
    jobs.push({ map: m, game: "kex" });
  }
  let next = 0;
  const workers = Array.from({ length: PARALLEL }, async () => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (job === undefined) return;
      await bootOne(job.map, job.game);
    }
  });
  await Promise.all(workers);
}

function rec(map: string, game: string): RecordT {
  const r = records.get(key(map, game));
  if (r === undefined) throw new Error(`no record for ${game || "classic"} ${map}`);
  return r;
}

/**
 * Exact residual divergence counts -- the catalogue of what this sweep has
 * NOT resolved, held to an exact number so a new divergence cannot hide.
 * See this file's header for what dominates each bucket. Update only
 * alongside a stated reason.
 */
const RESIDUAL_BASELINE: Readonly<Record<string, number>> = {
  final_count: 22,
  mover_origin: 454,
  mover_presence: 235,
  mover_state: 39,
  player_origin: 7,
  spawn_count: 305,
  spawn_usetargets_classic_only: 228,
  spawn_usetargets_kex_only: 104,
  usetargets_classic_only: 617,
  usetargets_kex_only: 126,
};

/** Documented, deliberate rule differences -- see C1/C2/C3 in the header. */
const CLASSIFIED_BASELINE: Readonly<Record<string, number>> = {
  C1_player_trail: 222,
  C2_classname_rewrite: 110,
  C3_spawn_z_plus9: 215,
};

function moversByModel(movers: MoverT[]): Map<string, MoverT[]> {
  const m = new Map<string, MoverT[]>();
  for (const x of movers) {
    const k = x.model !== null && x.model !== "" ? x.model : `#${x.num}`;
    const list = m.get(k);
    if (list === undefined) m.set(k, [x]);
    else list.push(x);
  }
  return m;
}

function useKeys(events: UseEventT[]): Set<string> {
  return new Set(events.map((u) => `${u.classname ?? ""}|${u.targetname ?? ""}|${u.target ?? ""}|${u.killtarget ?? ""}`));
}

describe.skipIf(!havePak)("cross-module map sweep -- all 222 shipped maps under both game modules", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "q2-parity-sweep-"));
    await runSweep();
  }, 900_000);

  test("this port's own retail-data survey: 222 maps/*.bsp in pak0.pak", () => {
    expect(allMaps.length).toBe(222);
  });

  test("every map reaches ss_game under BOTH modules with a live player -- 444 boots, zero failures", () => {
    const failures: string[] = [];
    for (const m of allMaps) {
      for (const g of ["", "kex"]) {
        const r = rec(m, g);
        const who = `${g === "" ? "classic" : "kex"} ${m}`;
        if (!r.ok) failures.push(`${who}: ${r.error ?? "not ok"}`);
        else if (!r.player_spawned) failures.push(`${who}: no player spawned`);
        else if (r.spawn_total <= 0) failures.push(`${who}: no entities spawned`);
      }
    }
    expect(failures).toEqual([]);
  }, 900_000);

  test("(a) a trigger with no brush model no longer drops the classic module", () => {
    // The trigger is a point entity, so it has no inline model to key on --
    // its presence is what matters, and before the fix the map never
    // reached ss_game at all.
    const cases: [string, string][] = [
      ["badlands", "trigger_once"],
      ["city2", "trigger_once"],
      ["outbase", "trigger_once"],
      ["rhangar2", "trigger_once"],
      ["q64/orbit", "trigger_coop_relay"],
    ];
    for (const [map, cls] of cases) {
      const c = rec(map, "");
      expect(c.ok).toBe(true);
      expect(c.player_spawned).toBe(true);
      expect(c.spawn_counts[cls] ?? 0).toBeGreaterThan(0);
    }
  });

  test("(b) every map with a crucified misc_insane boots under the re-release module", () => {
    const maps = ["jail2", "jail4", "mgu5m3", "q64/lab", "rammo1", "rammo2", "rbase1", "rbase2", "rhangar1", "rhangar2", "rsewer1", "rsewer2", "rware1", "rware2"];
    for (const m of maps) {
      const k = rec(m, "kex");
      expect(k.ok).toBe(true);
      expect(k.error).toBeNull();
      expect(k.player_spawned).toBe(true);
    }
    // and the entity that used to throw really is in the world
    expect(rec("jail2", "kex").spawn_counts["misc_insane"] ?? 0).toBeGreaterThan(0);
  });

  test("(c) mgu1m5's 151-character start_items no longer truncates under the re-release module", () => {
    const k = rec("mgu1m5", "kex");
    expect(k.ok).toBe(true);
    expect(k.error).toBeNull();
    expect(k.player_spawned).toBe(true);
    // Its info_player_start is at "784 1520 440"; PutClientInServer's
    // `origin[2] += 1` puts the player at 441.
    expect(k.player_origin).toEqual([784, 1520, 441]);
  });

  test("(d) func_plat2 START_ACTIVE: the three shipped maps that use it now agree between the modules", () => {
    for (const [map, model] of [["hangar1", "*11"], ["jail1", "*62"], ["xcompnd2", "*49"]] as [string, string][]) {
      const c = rec(map, "").spawn_movers.find((x) => x.model === model && x.classname === "func_plat2");
      const k = rec(map, "kex").spawn_movers.find((x) => x.model === model && x.classname === "func_plat2");
      expect(c).toBeDefined();
      expect(k).toBeDefined();
      expect(c?.state).toBe(k?.state ?? -1);
      expect(c?.state).toBe(1); // STATE_BOTTOM
    }
  });

  test("the three maps with no spawn point of any kind put the player at the world origin under both modules", () => {
    for (const m of ["test/mals_box", "test/mals_ladder_test", "test/mals_barrier_test"]) {
      for (const g of ["", "kex"]) {
        const r = rec(m, g);
        expect(r.ok).toBe(true);
        expect(r.player_spawned).toBe(true);
        expect(r.player_origin?.[0]).toBe(0);
        expect(r.player_origin?.[1]).toBe(0);
      }
    }
  });

  test("every divergence is either a documented rule difference or accounted for in the residual table", () => {
    const classified: Record<string, number> = {};
    const residual: Record<string, number> = {};
    const bump = (o: Record<string, number>, k: string): void => {
      o[k] = (o[k] ?? 0) + 1;
    };

    for (const m of allMaps) {
      const c = rec(m, "");
      const k = rec(m, "kex");

      // spawn entity counts by classname
      const rename = (k.spawn_counts["func_water"] ?? 0) + (k.spawn_counts["func_door_secret"] ?? 0);
      for (const name of new Set([...Object.keys(c.spawn_counts), ...Object.keys(k.spawn_counts)])) {
        const a = c.spawn_counts[name] ?? 0;
        const b = k.spawn_counts[name] ?? 0;
        if (a === b) continue;
        if (name === "player_trail" && b === 0) bump(classified, "C1_player_trail");
        else if ((name === "func_water" || name === "func_door_secret") && a === 0) bump(classified, "C2_classname_rewrite");
        else if (name === "func_door" && a - b === rename) bump(classified, "C2_classname_rewrite");
        else bump(residual, "spawn_count");
      }

      // where the player ended up
      const pc = c.player_origin;
      const pk = k.player_origin;
      if (JSON.stringify(pc) !== JSON.stringify(pk)) {
        const dz = pc !== null && pk !== null && pc[0] === pk[0] && pc[1] === pk[1] ? pc[2] - pk[2] : NaN;
        if (dz >= 8.5 && dz <= 10) bump(classified, "C3_spawn_z_plus9");
        else bump(residual, "player_origin");
      }

      // movers, keyed by inline model (edict numbers shift between modules)
      const cm = moversByModel(c.spawn_movers);
      const km = moversByModel(k.spawn_movers);
      for (const model of new Set([...cm.keys(), ...km.keys()])) {
        const A = cm.get(model) ?? [];
        const B = km.get(model) ?? [];
        if (A.length !== B.length) {
          bump(residual, "mover_presence");
          continue;
        }
        for (let i = 0; i < A.length; i++) {
          const a = A[i];
          const b = B[i];
          if (a === undefined || b === undefined) continue;
          if (a.state !== b.state) bump(residual, "mover_state");
          else if (JSON.stringify(a.origin) !== JSON.stringify(b.origin)) bump(residual, "mover_origin");
        }
      }

      // G_UseTargets, as key sets (frame numbers differ for timing reasons)
      const cu = new Set(Object.keys(c.usetargets_summary));
      const ku = new Set(Object.keys(k.usetargets_summary));
      for (const x of cu) if (!ku.has(x)) bump(residual, "usetargets_classic_only");
      for (const x of ku) if (!cu.has(x)) bump(residual, "usetargets_kex_only");

      const csu = useKeys(c.spawn_usetargets);
      const ksu = useKeys(k.spawn_usetargets);
      for (const x of csu) if (!ksu.has(x)) bump(residual, "spawn_usetargets_classic_only");
      for (const x of ksu) if (!csu.has(x)) bump(residual, "spawn_usetargets_kex_only");

      // end state, for classnames whose spawn counts agreed
      for (const name of new Set([...Object.keys(c.final_counts), ...Object.keys(k.final_counts)])) {
        const a = c.final_counts[name] ?? 0;
        const b = k.final_counts[name] ?? 0;
        if (a !== b && (c.spawn_counts[name] ?? 0) === (k.spawn_counts[name] ?? 0)) bump(residual, "final_count");
      }
    }

    expect(classified).toEqual(CLASSIFIED_BASELINE as Record<string, number>);
    expect(residual).toEqual(RESIDUAL_BASELINE as Record<string, number>);
  }, 900_000);
});

if (havePak) {
  process.on("exit", () => {
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });
}
