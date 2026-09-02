/*
Parity boot driver -- ONE dedicated headless boot of ONE (map, game module)
pair, per process, emitting a plain-JSON record of what happened in the
first N server frames.

Used by test/parity_map_sweep.test.ts, which spawns this file once per
(map, module) pair. One boot per process is deliberate: both game modules
own process-wide singletons (g_edicts, level, game, the server's svs.csr /
svs.codec, and the filesystem search path, which only ever accumulates --
see src/qcommon/files.ts's own header note), so a second boot in the same
process is never a clean boot. The existing in-process retail boot tests
(test/dedicated_boot_retail_mgu.test.ts, test/legacy_base1_rerelease_boot.ts)
each snapshot and restore all of that around a single boot for exactly this
reason; a 400-boot sweep cannot rely on that discipline holding, so it
forks instead.

BOOT SHAPE
----------
`dedicated 1` with `coop 1`. Dedicated is what makes this fast (no
renderer, no window, no sound). `coop 1` is what reaches the SINGLE-PLAYER
spawn rules on a dedicated server: src/server/sv_init.ts's SV_InitGame
ports sv_init.c:318-324 verbatim -- "dedicated servers ... are usually DM,
so unless they explicitly set coop, force it to deathmatch" -- and a
deathmatch session frees every SPAWNFLAG_NOT_DEATHMATCH entity before the
first frame, which is campaign geometry the sweep exists to compare. See
test/legacy_base1_rerelease_boot.test.ts's header for the long-form version
of that finding.

WHAT IS RECORDED, AND FROM WHERE
--------------------------------
Everything except G_UseTargets is read from the outside, by walking the
module's own exported g_edicts array once per frame:
  - live entity count by classname
  - mover state changes: moveinfo.state and s.origin for every live entity
    whose classname is in MOVER_CLASSES (doors, plats, trains, buttons,
    rotating brushes, and the water/conveyor/timer variants)
  - entities freed (inuse true -> false) and spawned (false -> true)
G_UseTargets has no persistent trace, so it is the one signal that needs an
in-module hook: src/shared/parity_trace.ts, off unless Q2_PARITY_TRACE=1 is
in the environment AND a sink is installed. This file sets both.
dprintf/Com_Print warnings are left to the parent, which reads this
process's stdout.

USAGE
-----
  Q2_PARITY_TRACE=1 bun test/support/parity_boot_driver.ts \
      --basedir <retail root> --game <""|kex> --map <name> \
      --frames 100 --out <path.json> [--homedir <path>]

Exit status 0 on a completed boot, 1 on any failure; the failure reason is
also written into the JSON so the parent gets it even on a crash-free
"never reached ss_game" result.
*/

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { CVAR_LATCH, CVAR_SERVERINFO, CVAR_NOARCHIVE } from "../../src/shared/q_shared";
import { Cvar_ForceSet, Cvar_Get } from "../../src/qcommon/cvar";
import { Cbuf_AddText } from "../../src/qcommon/cmd";
import { NET_Shutdown } from "../../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../../src/main";
import { sv, ServerStateT } from "../../src/server/server";
import { SV_Shutdown } from "../../src/server/sv_main";
import { geHolder } from "../../src/server/sv_game";
import { svs } from "../../src/server/server";
import { SZ_Init } from "../../src/qcommon/sizebuf";
import { cls, ConnstateT } from "../../src/client/client";
import { ParityTrace_SetSink, type ParityUseTargetsEventT } from "../../src/shared/parity_trace";

// ---------------------------------------------------------------------------
// The record this driver emits. Plain data only -- no edict references.
// ---------------------------------------------------------------------------

export interface ParityMoverStateT {
  readonly num: number;
  readonly classname: string;
  /**
   * The inline brush model this mover is bound to ("*20"). This, not the
   * entity number, is what identifies a mover ACROSS the two modules: the
   * modules spawn different numbers of entities (vanilla's PlayerTrail_Init
   * alone puts 8 player_trail markers in the world that the re-release has
   * no equivalent for), so every edict number after the first difference is
   * shifted and matching on it reports every mover on the map as missing.
   * The model string comes from the map file and is identical in both.
   */
  readonly model: string | null;
  readonly targetname: string | null;
  readonly state: number;
  /** s.origin, rounded to 1/8 unit so the two modules' float paths compare. */
  readonly origin: readonly [number, number, number];
}

export interface ParityFrameT {
  readonly frame: number;
  /** Classnames whose live count changed this frame: name -> new count. */
  readonly counts_changed: Readonly<Record<string, number>>;
  /** Entity numbers freed this frame, with the classname they had. */
  readonly freed: readonly (readonly [number, string])[];
  /** Entity numbers that became live this frame, with their classname. */
  readonly spawned: readonly (readonly [number, string])[];
  /** Movers whose state or origin changed this frame. */
  readonly movers: readonly ParityMoverStateT[];
  /** G_UseTargets firings during this frame. */
  readonly usetargets: readonly ParityUseTargetsEventT[];
}

export interface ParityBootRecordT {
  readonly map: string;
  readonly game: string;
  readonly ok: boolean;
  readonly error: string | null;
  /** Live entity count by classname at the end of the spawn frame (frame 0). */
  readonly spawn_counts: Readonly<Record<string, number>>;
  /** Total live edicts right after spawn. */
  readonly spawn_total: number;
  /** Movers present at the end of the spawn frame. */
  readonly spawn_movers: readonly ParityMoverStateT[];
  /**
   * Every G_UseTargets firing during SpawnEntities and SV_SpawnServer's two
   * settle frames -- i.e. before frame 1. A map's start-of-level script
   * (trigger_always chains, doors a spawn script opens) lands entirely in
   * here, so it has to be recorded separately from the per-frame log.
   */
  readonly spawn_usetargets: readonly ParityUseTargetsEventT[];
  /** Did ClientConnect+ClientBegin put a live player in the world? */
  readonly player_spawned: boolean;
  /** The player's origin after ClientBegin, rounded to 1/8 unit. */
  readonly player_origin: readonly [number, number, number] | null;
  /** Live entity count by classname right after the player spawned. */
  readonly post_player_counts: Readonly<Record<string, number>>;
  /** Live entity count by classname after the last measured frame. */
  readonly final_counts: Readonly<Record<string, number>>;
  /** Every mover still live after the last measured frame. */
  readonly final_movers: readonly ParityMoverStateT[];
  /**
   * Every G_UseTargets firing over the run, keyed by
   * "<classname>|<targetname>|<target>|<killtarget>" -> [times fired, first frame].
   * Frame numbers differ between the modules for reasons that are not rule
   * differences (the two modules start their level clocks differently), so
   * the sweep compares the KEY SET and leaves the frame as reporting detail.
   */
  readonly usetargets_summary: Readonly<Record<string, readonly [number, number]>>;
  /** Classname -> how many entities of it were freed over the run. */
  readonly freed_summary: Readonly<Record<string, number>>;
  /** Up to the first 200 frames that recorded anything. */
  readonly frames: readonly ParityFrameT[];
  readonly frames_run: number;
}

/*
Classnames whose spawn installs a moveinfo and moves a brush model. Both
modules use the same classnames (they are the map-file contract), so one
list serves both. func_object/func_explosive/func_areaportal are excluded:
they have no moveinfo state machine.
*/
const MOVER_CLASSES: ReadonlySet<string> = new Set([
  "func_door",
  "func_door_rotating",
  "func_door_secret",
  "func_water",
  "func_plat",
  "func_plat2",
  "func_train",
  "func_button",
  "func_rotating",
  "func_conveyor",
  "func_timer",
  "func_clock",
  "func_animation",
  "func_eye",
  "func_spinning",
]);

interface AnyEdict {
  inuse: boolean;
  classname: string | null;
  model: string | null;
  targetname: string | null;
  s: { number: number; origin: unknown };
  moveinfo?: { state: number } | undefined;
}

function argOf(name: string, fallback: string | null = null): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) {
    if (fallback === null) throw new Error(`missing --${name}`);
    return fallback;
  }
  return process.argv[i + 1] as string;
}

/** s.origin is a Vec3 in the classic module and a float triple in kex; both index. */
function originOf(e: AnyEdict): [number, number, number] {
  const o = e.s.origin as ArrayLike<number>;
  const q = (v: number): number => Math.round((v ?? 0) * 8) / 8;
  return [q(o[0] ?? 0), q(o[1] ?? 0), q(o[2] ?? 0)];
}

function moverOf(e: AnyEdict): ParityMoverStateT {
  return {
    num: e.s.number,
    classname: e.classname ?? "",
    model: e.model,
    targetname: e.targetname,
    state: e.moveinfo?.state ?? -1,
    origin: originOf(e),
  };
}

function moverKey(m: ParityMoverStateT): string {
  return `${m.state}|${m.origin[0]},${m.origin[1]},${m.origin[2]}`;
}

async function main(): Promise<void> {
  const basedir = argOf("basedir");
  const game = argOf("game", "");
  const map = argOf("map");
  const frames = Number(argOf("frames", "100"));
  const out = argOf("out");
  const homedir = argOf("homedir", "");
  const rng = argOf("rng", "fixed");

  /*
  Determinism. Both modules pull every random value from the global
  Math.random (src/shared/math.ts's frandom, src/kexgame/q_std.ts's
  frandom/crandom, and the scattered direct Math.random calls in g_monster/
  g_func/g_ai -- see each file's own "determinism is not a goal" note). Two
  boots of the same map would therefore never agree with each other, let
  alone across modules, and func_timer alone fires 33 times on base1.

  Pinning Math.random to a CONSTANT 0.5 -- rather than seeding a shared
  stream -- is what actually makes the two modules comparable. A seeded
  stream still desynchronises the moment the modules draw a different NUMBER
  of values (they do: the classic module's wide-layout restart respawns the
  world once more than kex does), so every downstream draw would differ for
  a reason that has nothing to do with game rules. A constant makes each
  random-derived quantity a pure function of the entity's own fields, so
  func_timer's `wait + crandom() * random` is the same number in both
  modules and any remaining difference is a real rule difference.

  This is the driver's own process-local choice; nothing in src/ is touched.
  */
  if (rng === "fixed") Math.random = (): number => 0.5;

  // The trace hook only records once a sink is installed; nothing in src/
  // ever installs one.
  const pending: ParityUseTargetsEventT[] = [];
  ParityTrace_SetSink((e) => {
    pending.push(e);
  });

  /*
  The map goes in as a LATE command (`+map <name>`), not as a Cbuf_AddText
  after init. Retail baseq2/pak0.pak's own default.cfg line 126 is
    alias dedicated_start "map base1"
  and src/main.ts's Qcommon_Init (porting common.c's Qcommon_Init verbatim)
  runs `dedicated_start` whenever Cbuf_AddLateCommands() finds nothing --
  `+set` pairs do not count, because Cbuf_AddEarlyCommands(true) has already
  cleared them from argv by then. So a boot that queues its map afterwards
  loads base1 FIRST, all the way through SpawnEntities, and only then loads
  the map under test. That is a wasted map load per boot and a dirty one:
  the measured map is spawned into a process that has already spawned and
  torn down another map's worth of entities. Passing `+map` makes
  Cbuf_AddLateCommands return true, so dedicated_start never runs and the
  map under test is the only map this process ever loads.
  */
  const initArgs = ["quake2", "+set", "basedir", basedir, "+set", "game", game, "+set", "dedicated", "1", "+set", "port", "0", "+set", "coop", "1", "+set", "deathmatch", "0"];
  if (homedir !== "") {
    mkdirSync(homedir, { recursive: true });
    initArgs.push("+set", "homedir", homedir);
  }
  /*
  `+wait`, not `+map <name>`: Cbuf_AddLateCommands stops a command at the
  next "+" OR "-" (cmd.c's own parser, ported verbatim), so a map whose name
  contains a hyphen would be truncated -- `+map q64/geo-stat` becomes
  `map q64/geo`, and the boot dies on "Can't find maps/q64/geo.bsp". A bare
  `+wait` (a real registered command, cmd.ts:532) is enough to make
  Cbuf_AddLateCommands return true, which is all that is needed to keep
  dedicated_start's `map base1` from running; the map under test is then
  queued by name below, where nothing reparses it.
  */
  initArgs.push("+wait");

  Cvar_ForceSet("basedir", basedir);
  Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
  Cvar_ForceSet("game", game);
  Cvar_ForceSet("port", "0");
  Cvar_ForceSet("dedicated", "1");
  Cvar_ForceSet("coop", "1");
  Cvar_ForceSet("deathmatch", "0");
  cls.state = ConnstateT.ca_disconnected;

  let error: string | null = null;
  let spawnCounts: Record<string, number> = {};
  const spawnMovers: ParityMoverStateT[] = [];
  let spawnTotal = 0;
  let playerSpawned = false;
  let playerOrigin: [number, number, number] | null = null;
  let playerError: string | null = null;
  let postPlayerCounts: Record<string, number> = {};
  let finalCounts: Record<string, number> = {};
  let spawnUseTargets: ParityUseTargetsEventT[] = [];
  const finalMovers: ParityMoverStateT[] = [];
  const useSummary: Record<string, [number, number]> = {};
  const freedSummary: Record<string, number> = {};
  const out_frames: ParityFrameT[] = [];

  try {
    await Qcommon_Init(initArgs);

    Cbuf_AddText(`map ${map}\n`);
    // These maps are large (mgu1m1 ~23MB, mguhub ~33MB); generous budget,
    // matching test/dedicated_boot_retail_mgu.test.ts's MAP_POLL_LIMIT.
    for (let i = 0; i < 600 && sv.state !== ServerStateT.ss_game; i++) {
      runFrames(1, 100);
      await Bun.sleep(0);
    }
    if (sv.state !== ServerStateT.ss_game) throw new Error(`never reached ss_game (state ${String(sv.state)})`);

    // The module's edict array is only meaningful once the module is loaded,
    // and which module that is depends on the `game` cvar the server latched.
    const mod = game === "" ? await import("../../src/game/g_local") : await import("../../src/kexgame/g_main_globals");
    const edicts = (mod as unknown as { g_edicts: (AnyEdict | undefined)[] }).g_edicts;

    // Baseline: the world as SpawnEntities left it, before any frame ran.
    const liveNow = (): Map<number, AnyEdict> => {
      const m = new Map<number, AnyEdict>();
      for (const e of edicts) if (e !== undefined && e.inuse) m.set(e.s.number, e);
      return m;
    };
    const countsOf = (live: Map<number, AnyEdict>): Record<string, number> => {
      const c: Record<string, number> = {};
      for (const e of live.values()) {
        const k = e.classname ?? "(null)";
        c[k] = (c[k] ?? 0) + 1;
      }
      return c;
    };

    const atSpawn = liveNow();
    spawnCounts = countsOf(atSpawn);
    spawnTotal = atSpawn.size;
    for (const e of atSpawn.values()) {
      if (e.classname !== null && MOVER_CLASSES.has(e.classname)) spawnMovers.push(moverOf(e));
    }
    spawnMovers.sort((a, b) => a.num - b.num);
    spawnUseTargets = pending.slice();

    /*
    Spawn a player before measuring frames.

    src/kexgame/g_main.ts's G_RunFrame ports g_main.cpp:1011-1031 exactly:
      if (main_loop && !G_AnyPlayerSpawned()) return;
    A dedicated server with nobody connected therefore runs ZERO game frames
    under the re-release module -- 100 frames of a totally frozen world --
    while the classic module (vanilla g_main.c has no such early-out) runs
    all 100. Comparing those two directly would report every func_timer,
    every trigger and every mover on every map as a divergence, and all of
    it would be this one rule.

    So the sweep connects one player, exactly the way src/server/sv_main.ts's
    SV_ConnectionlessPacket and sv_user.ts's SV_Begin_f do (ge.ClientConnect
    then ge.ClientBegin on the first client edict) and exactly the way
    test/lmctf_kex_boot.test.ts already drives it in-process. That also puts
    the spawn-point selection itself under comparison, which is the rule
    7c68b1a just changed in the classic module.
    */
    /*
    A client that never went through Netchan_Setup has zero-capacity
    reliable and datagram SizeBufs, and ClientBegin writes to both (its
    stufftexts and layout). src/server/sv_seats.ts's own
    SV_InitLocalSeatBuffers hit exactly this and carries the finding in its
    header: "the very first ge.ClientBegin threw 'SZ_GetSpace: overflow
    without allowoverflow set' the instant the game tried to write to the
    seat, on a zero-capacity SizeBuf". Same recipe here -- real buffers,
    allowoverflow so a spike is dropped rather than fatal, and drained every
    frame below since nothing transmits them. The re-release module needs
    this (it unicasts more at ClientBegin than vanilla does); the classic
    module is given the identical treatment so the two sessions differ only
    in the game module.
    */
    const cl0 = svs.clients[0];
    if (cl0 !== undefined) {
      SZ_Init(cl0.netchan.message, cl0.netchan.message_buf, cl0.netchan.message_buf.length);
      cl0.netchan.message.allowoverflow = true;
      SZ_Init(cl0.datagram, cl0.datagram_buf, cl0.datagram_buf.length);
      cl0.datagram.allowoverflow = true;
    }

    const ge = geHolder.ge;
    const playerEdict = ge?.edicts[1];
    if (ge !== null && ge !== undefined && playerEdict !== undefined && playerEdict !== null) {
      try {
        const res = ge.ClientConnect(playerEdict, "\\name\\ParitySweep\\skin\\male/grunt");
        if (res.allowed) {
          ge.ClientBegin(playerEdict);
          const pe = playerEdict as unknown as AnyEdict;
          if (pe.inuse) {
            playerSpawned = true;
            playerOrigin = originOf(pe);
          }
        }
      } catch (e) {
        playerError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }

    let prevLive = liveNow();
    let prevCounts = countsOf(prevLive);
    postPlayerCounts = prevCounts;
    let lastLive = prevLive;
    let lastCounts = prevCounts;
    const prevClass = new Map<number, string>();
    for (const [n, e] of prevLive) prevClass.set(n, e.classname ?? "(null)");
    const prevMover = new Map<number, string>();
    for (const e of prevLive.values()) {
      if (e.classname !== null && MOVER_CLASSES.has(e.classname)) prevMover.set(e.s.number, moverKey(moverOf(e)));
    }
    pending.length = 0;

    for (let f = 1; f <= frames; f++) {
      // Nothing transmits the client's buffers on this headless boot, so
      // drain them the way SV_RunLocalSeatThinks drains a seat's.
      if (cl0 !== undefined) {
        cl0.netchan.message.cursize = 0;
        cl0.netchan.message.overflowed = false;
        cl0.datagram.cursize = 0;
        cl0.datagram.overflowed = false;
      }
      runFrames(1, 100);
      const live = liveNow();
      const counts = countsOf(live);

      const counts_changed: Record<string, number> = {};
      for (const k of new Set([...Object.keys(counts), ...Object.keys(prevCounts)])) {
        if ((counts[k] ?? 0) !== (prevCounts[k] ?? 0)) counts_changed[k] = counts[k] ?? 0;
      }

      const freed: [number, string][] = [];
      for (const n of prevLive.keys()) if (!live.has(n)) freed.push([n, prevClass.get(n) ?? "(null)"]);
      const spawned: [number, string][] = [];
      for (const [n, e] of live) {
        const cn = e.classname ?? "(null)";
        if (!prevLive.has(n)) spawned.push([n, cn]);
        prevClass.set(n, cn);
      }

      const movers: ParityMoverStateT[] = [];
      for (const e of live.values()) {
        if (e.classname === null || !MOVER_CLASSES.has(e.classname)) continue;
        const m = moverOf(e);
        const key = moverKey(m);
        if (prevMover.get(m.num) !== key) {
          movers.push(m);
          prevMover.set(m.num, key);
        }
      }

      const usetargets = pending.slice();
      pending.length = 0;

      for (const [, cn] of freed) freedSummary[cn] = (freedSummary[cn] ?? 0) + 1;
      for (const u of usetargets) {
        const key = `${u.classname ?? ""}|${u.targetname ?? ""}|${u.target ?? ""}|${u.killtarget ?? ""}`;
        const prev = useSummary[key];
        useSummary[key] = prev === undefined ? [1, f] : [prev[0] + 1, prev[1]];
      }

      if (out_frames.length < 200 && (Object.keys(counts_changed).length > 0 || freed.length > 0 || spawned.length > 0 || movers.length > 0 || usetargets.length > 0)) {
        out_frames.push({
          frame: f,
          counts_changed,
          freed: freed.sort((a, b) => a[0] - b[0]),
          spawned: spawned.sort((a, b) => a[0] - b[0]),
          movers: movers.sort((a, b) => a.num - b.num),
          usetargets,
        });
      }

      prevLive = live;
      prevCounts = counts;
      lastLive = live;
      lastCounts = counts;
    }

    finalCounts = lastCounts;
    for (const e of lastLive.values()) {
      if (e.classname !== null && MOVER_CLASSES.has(e.classname)) finalMovers.push(moverOf(e));
    }
    finalMovers.sort((a, b) => a.num - b.num);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  const record: ParityBootRecordT = {
    map,
    game,
    ok: error === null,
    error: error !== null ? error : playerError !== null ? `player: ${playerError}` : null,
    spawn_counts: spawnCounts,
    spawn_total: spawnTotal,
    spawn_movers: spawnMovers,
    spawn_usetargets: spawnUseTargets,
    player_spawned: playerSpawned,
    player_origin: playerOrigin,
    post_player_counts: postPlayerCounts,
    final_counts: finalCounts,
    final_movers: finalMovers,
    usetargets_summary: useSummary,
    freed_summary: freedSummary,
    frames: out_frames,
    frames_run: out_frames.length === 0 ? frames : frames,
  };

  const dir = out.slice(0, out.lastIndexOf("/"));
  if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(out, JSON.stringify(record));

  ParityTrace_SetSink(null);
  try {
    SV_Shutdown("parity boot finished\n", false);
    await NET_Shutdown();
  } catch {
    /* shutdown noise must not change the recorded result */
  }
  process.exit(error === null ? 0 : 1);
}

await main();
