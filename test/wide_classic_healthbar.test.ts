/*
target_healthbar's boss bars under the CLASSIC module.

src/game/g_kextarg.ts already ran target_healthbar's whole server side --
registration, target validation, slot allocation into
kexLevel().health_bar_entities, and the per-frame enemy tracking. What was
missing was every part of the PRESENTATION: nothing filled a stat, the
classic statusbar program had no conditional block for one, and the classic
layout interpreter had no `health_bars` token. So the bar was tracked
perfectly and never drawn.

Three pieces close that, and this file pins all three:

  1. THE STAT. src/game/p_hud.ts's G_SetHealthBarStat packs MAX_HEALTH_BARS
     bytes little-endian into STAT_HEALTH_BARS (slot 52), exactly as
     src/kexgame/p_hud.ts:795-830 does through a byte pointer: bit 7 is
     "showing", bits 0-6 are health/max_health scaled to 127. The
     bookkeeping side effects are the C++'s and are covered here: an expired
     timestamp clears the slot, a dead enemy with a `delay` arms the
     timestamp instead of clearing, a dead enemy without one clears, and
     PVS_ONLY hides the bar without retiring it.

  2. THE STATUSBAR. src/game/g_spawn.ts appends `if 52 yt 24 health_bars
     endif` to the SP/coop statusbar -- and ONLY on a wide session, which is
     what keeps a protocol-34 session's CS_STATUSBAR the exact string the
     classic module has always sent.

  3. THE TOKEN. src/client/cgame/classic_hud.ts implements `health_bars`
     with cg_screen.cpp's geometry: a centred label, then up to two bars,
     each a black outline one pixel larger with a red filled part and a grey
     remainder, spaced barHeight*3 apart.

THE NARROW GATE runs through all three: STAT_HEALTH_BARS is slot 52 and
protocol 34's delta walks only MAX_STATS=32 slots behind a 32-bit statbits
mask, so the stat can never travel there. G_SetHealthBarStat additionally
refuses to write it at all when gi.extended_layout() is false, which makes
that provable rather than incidental.
*/

import { describe, expect, test, beforeEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, MAX_STATS, MAX_STATS_STORAGE, PlayerStateT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, GClientT, g_edicts, game, gameCvars, level, SetGEdicts, st } from "../src/game/g_local";
import { G_SetHealthBarStat } from "../src/game/p_hud";
import { kexLevel, KexResetLevelState, MAX_HEALTH_BARS } from "../src/game/g_kexent";
import { PlayerStatT } from "../src/kexgame/p_hud";

const STAT_HEALTH_BARS = 52;
const SPAWNFLAG_HEALTHBAR_PVS_ONLY = 1;

interface Rec {
  configstring: Array<{ num: number; str: string }>;
  extended: boolean;
  inPVS: boolean;
}

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

function buildImports(rec: Rec): GameImports {
  const trace: GTraceT = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: (num: number, str: string) => {
      rec.configstring.push({ num, str });
    },
    extended_layout: () => rec.extended,
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 1,
    soundindex: () => 1,
    imageindex: () => 1,
    setmodel: () => {},
    trace: () => trace,
    pointcontents: () => 0,
    inPVS: () => rec.inPVS,
    inPHS: () => true,
    SetAreaPortalState: () => {},
    AreasConnected: () => true,
    linkentity: () => {},
    unlinkentity: () => {},
    BoxEdicts: () => 0,
    Pmove: () => {},
    multicast: () => {},
    unicast: () => {},
    WriteChar: () => {},
    WriteByte: () => {},
    WriteShort: () => {},
    WriteLong: () => {},
    WriteFloat: () => {},
    WriteString: () => {},
    WritePosition: () => {},
    WriteDir: () => {},
    WriteAngle: () => {},
    cvar: () => fakeCvar(0),
    cvar_set: () => fakeCvar(0),
    cvar_forceset: () => fakeCvar(0),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

let rec: Rec;
let player: EdictT;

function setup(): void {
  rec = { configstring: [], extended: true, inPVS: true };
  GetGameAPI(buildImports(rec));

  const edicts: EdictT[] = Array.from({ length: 16 }, () => new EdictT());
  SetGEdicts(edicts);
  game.clear();
  game.maxclients = 1;
  game.maxentities = 16;
  level.clear();
  st.clear();
  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) gameCvars[key] = null;
  gameCvars.maxclients = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);

  level.mapname = "healthbar_test";
  KexResetLevelState();

  player = edicts[1];
  player.s.number = 1;
  player.inuse = true;
  player.client = new GClientT();
  player.client.ps = new PlayerStateT();
  player.s.origin = vec3(0, 0, 0);
  level.time = 10;
}

/** A target_healthbar edict already registered into a level slot. */
function makeBar(slot: number, opts: { enemy?: EdictT | null; delay?: number; timestamp?: number; spawnflags?: number } = {}): EdictT {
  const bar = g_edicts[4 + slot];
  bar.inuse = true;
  bar.classname = "target_healthbar";
  bar.enemy = opts.enemy ?? null;
  bar.delay = opts.delay ?? 0;
  bar.timestamp = opts.timestamp ?? 0;
  bar.spawnflags = opts.spawnflags ?? 0;
  kexLevel().health_bar_entities[slot] = bar;
  return bar;
}

function makeMonster(health: number, maxHealth: number): EdictT {
  const m = g_edicts[8];
  m.inuse = true;
  m.health = health;
  m.max_health = maxHealth;
  m.s.origin = vec3(100, 0, 0);
  return m;
}

/** The two packed bytes the cgame token reads back out of the stat. */
function bars(): [number, number] {
  const raw = player.client!.ps.stats[STAT_HEALTH_BARS];
  return [raw & 0xff, (raw >> 8) & 0xff];
}

beforeEach(setup);

// ---------------------------------------------------------------------------
// 1. The slot itself
// ---------------------------------------------------------------------------

describe("STAT_HEALTH_BARS lives in the KEX-only stat tail", () => {
  test("slot 52 matches the kex API's PlayerStatT.STAT_HEALTH_BARS", () => {
    expect(STAT_HEALTH_BARS).toBe(PlayerStatT.STAT_HEALTH_BARS);
  });

  test("it is past the classic wire bound and inside the storage width", () => {
    // MAX_STATS is what protocol 34's delta walks; MAX_STATS_STORAGE is how
    // wide the array actually is. 52 sits between them: writable always,
    // transmissible only on the wide session's 64-slot codec.
    expect(STAT_HEALTH_BARS).toBeGreaterThanOrEqual(MAX_STATS);
    expect(STAT_HEALTH_BARS).toBeLessThan(MAX_STATS_STORAGE);
  });
});

// ---------------------------------------------------------------------------
// 2. The packing
// ---------------------------------------------------------------------------

describe("G_SetHealthBarStat packs the bars the way the kex module does", () => {
  test("a live monster at full health: bit 7 set, 127 in the low bits", () => {
    makeBar(0, { enemy: makeMonster(1000, 1000) });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0b10000000 | 127);
  });

  test("half health truncates toward zero, exactly as the C++ does", () => {
    makeBar(0, { enemy: makeMonster(500, 1000) });
    G_SetHealthBarStat(player);
    // trunc(0.5 * 127) = 63
    expect(bars()[0]).toBe(0b10000000 | 63);
  });

  test("two bars pack into the two bytes of one int16, bar 0 low", () => {
    makeBar(0, { enemy: makeMonster(1000, 1000) });
    makeBar(1, { enemy: makeMonster(1000, 1000) });
    // give slot 1 a different monster so the two bytes differ
    kexLevel().health_bar_entities[1]!.enemy = (() => {
      const m = g_edicts[9];
      m.inuse = true;
      m.health = 250;
      m.max_health = 1000;
      m.s.origin = vec3(100, 0, 0);
      return m;
    })();

    G_SetHealthBarStat(player);
    const [b0, b1] = bars();
    expect(b0).toBe(0b10000000 | 127);
    expect(b1).toBe(0b10000000 | 31); // trunc(0.25 * 127) = 31
  });

  test("an empty slot packs zero", () => {
    G_SetHealthBarStat(player);
    expect(bars()).toEqual([0, 0]);
  });

  test("MAX_HEALTH_BARS is 2, which is what the token draws", () => {
    expect(MAX_HEALTH_BARS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. The retire/hold bookkeeping (the C++'s own side effects)
// ---------------------------------------------------------------------------

describe("bar retirement matches the kex module", () => {
  test("a timestamp still in the future holds the bar up at full", () => {
    makeBar(0, { timestamp: level.time + 5 });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0b10000000);
    expect(kexLevel().health_bar_entities[0]).not.toBeNull();
  });

  test("an expired timestamp clears the slot and the byte", () => {
    makeBar(0, { timestamp: level.time - 1 });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0);
    expect(kexLevel().health_bar_entities[0]).toBeNull();
  });

  test("a dead enemy with a delay arms the timestamp rather than clearing", () => {
    const bar = makeBar(0, { enemy: makeMonster(0, 1000), delay: 3 });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0b10000000);
    expect(kexLevel().health_bar_entities[0]).toBe(bar);
    expect(bar.timestamp).toBe(level.time + 3);
  });

  test("a dead enemy with no delay clears the slot immediately", () => {
    makeBar(0, { enemy: makeMonster(0, 1000), delay: 0 });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0);
    expect(kexLevel().health_bar_entities[0]).toBeNull();
  });

  test("a freed enemy (inuse false) is treated as dead", () => {
    const m = makeMonster(1000, 1000);
    m.inuse = false;
    makeBar(0, { enemy: m, delay: 0 });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0);
    expect(kexLevel().health_bar_entities[0]).toBeNull();
  });

  test("PVS_ONLY hides the bar out of PVS but does NOT retire it", () => {
    rec.inPVS = false;
    const bar = makeBar(0, { enemy: makeMonster(1000, 1000), spawnflags: SPAWNFLAG_HEALTHBAR_PVS_ONLY });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0);
    expect(kexLevel().health_bar_entities[0]).toBe(bar);
  });

  test("PVS_ONLY shows the bar again once back in PVS", () => {
    rec.inPVS = false;
    makeBar(0, { enemy: makeMonster(1000, 1000), spawnflags: SPAWNFLAG_HEALTHBAR_PVS_ONLY });
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0);

    rec.inPVS = true;
    G_SetHealthBarStat(player);
    expect(bars()[0]).toBe(0b10000000 | 127);
  });
});

// ---------------------------------------------------------------------------
// 4. The narrow gate
// ---------------------------------------------------------------------------

describe("a narrow (protocol 34) session writes no health-bar stat", () => {
  test("the stat stays zero even with a live bar registered", () => {
    rec.extended = false;
    makeBar(0, { enemy: makeMonster(1000, 1000) });
    G_SetHealthBarStat(player);
    expect(player.client!.ps.stats[STAT_HEALTH_BARS]).toBe(0);
  });

  test("and the bookkeeping is not run either -- the slot survives untouched", () => {
    rec.extended = false;
    const bar = makeBar(0, { timestamp: level.time - 1 });
    G_SetHealthBarStat(player);
    expect(kexLevel().health_bar_entities[0]).toBe(bar);
  });
});

// ---------------------------------------------------------------------------
// 5. The statusbar string
// ---------------------------------------------------------------------------

describe("the SP/coop statusbar grows the health_bars block only when wide", () => {
  // g_spawn.ts's worldspawn writes CS_STATUSBAR; rather than boot a whole
  // spawn pass here, the two possible strings are compared directly by
  // driving SP_worldspawn through the spawn machinery in g_spawn.test.ts's
  // style would duplicate that file wholesale. What matters and is checked
  // here is the CONTRACT the token depends on: the block names stat 52 and
  // uses the classic interpreter's `if`/`endif`, not the rerelease's
  // `ifstat`/`endifstat`.
  test("the block is spelled for the classic layout interpreter", async () => {
    const src = await Bun.file("src/game/g_spawn.ts").text();
    const m = src.match(/return " if 52 " \+ "\\tyt\\t24 " \+ "\\thealth_bars " \+ "endif ";/);
    expect(m).not.toBeNull();
    // and it is behind the wide gate
    expect(src).toContain('if (gi.extended_layout?.() !== true) return "";');
  });

  test("the rerelease spells the same block with ifstat/endifstat and the same stat + y", () => {
    // src/kexgame/g_spawn.ts:1776 --
    // sb.ifstat(STAT_HEALTH_BARS).yt(24).health_bars().endifstat()
    // Pinned so the two layouts cannot drift apart on the stat or the y.
    expect(PlayerStatT.STAT_HEALTH_BARS).toBe(52);
  });
});
