/*
Start-point parity between the two game modules, for the live defect: a
fresh `+map mgu4m1` put the player OUTSIDE on the open red terrain by the
Uplink Tower under the classic ruleset (`+set game baseq2`) and INSIDE the
drop pod looking out through its doorway under the rerelease ruleset
(`+set game kex`). Same map, same fresh load, no previous map.

Two separate rules produce that difference, and this file gates both.

  RULE 1 -- which starts exist. g_spawn.cpp's G_InhibitEntity has a coop
  pair vanilla 3.21 does not:

      if ( coop && spawnflags & SPAWNFLAG_NOT_COOP)  -> inhibit
      if (!coop && spawnflags & SPAWNFLAG_COOP_ONLY) -> inhibit

  Rerelease campaign-entry maps place two untargeted info_player_starts,
  one flagged with each bit, so without the rule the classic module took
  whichever the map listed first -- the coop one, on all six of them. The
  same flag also gates map scripting: mgu4m1 arms its drop-pod teleporter
  from a COOP_ONLY trigger_always, so the classic module used to teleport
  the player out of the pod on the first frame too.

  src/game/g_spawn.ts now reproduces BOTH halves, but on different gates,
  and that split is the thing these tests exist to pin:

    * SPAWNFLAG_COOP_ONLY is gated on nothing, because the bit itself is
      the gate -- vanilla assigns it no meaning and no 1997 map sets it.
    * SPAWNFLAG_NOT_COOP is a 1997 flag whose vanilla semantics are "check
      disabled", so honoring it unconditionally would rewrite coop on
      original content (15 maps in a 1997 install carry the bit, 961
      entities between them). It is honored only on a WIDE session --
      gi.extended_layout(), i.e. the map carries rerelease presentation
      that the classic wire cannot deliver, settled by sv_init.ts's
      SV_ContentNeedsWideLayout before ge.SpawnEntities runs. No map in a
      1997 install matches that predicate, so the arm is unreachable
      there. See g_spawn.ts's own long comment for the measurement behind
      the gate choice.

  The `wide` field on Ruleset below is that session axis; it defaults to
  false, so every test that does not mention it is asserting the 1997
  behavior.

  RULE 2 -- what happens when nothing matches. p_client.cpp:1199-1228's
  SelectSingleSpawnPoint falls back to any untargeted start and then to any
  start at all, where vanilla had only the "spawnpoint was empty" arm and
  otherwise reached gi.error. src/game/p_client.ts now has the rerelease
  chain.

WHAT EACH TEST DRIVES

  * The CLASSIC side is always the real thing: the real SpawnEntities()
    over the map's real entity bytes, then the real SelectSpawnPoint().
  * The RERELEASE side is a transcription of src/kexgame/g_spawn.ts's
    G_InhibitEntity and src/kexgame/p_client.ts's SelectSingleSpawnPoint,
    both of which are file-private there. Copying them under citation
    rather than widening their exports is this suite's established idiom --
    see test/g_spawn_base1_retail.test.ts's own `cppInhibitRule()`.

No retail content is copied into the repository. The .bsp bytes are read
out of the local install at test-run time with a self-contained PACK reader
(deliberately not this engine's FS_* code, matching test/bnvib_retail.test.ts
and test/cl_demo_retail.test.ts), nothing is written to disk, and the
retail-gated block skips itself when the install is absent.
*/

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts, st } from "../src/game/g_local";
import { SpawnEntities } from "../src/game/g_spawn";
import { InitItems } from "../src/game/g_items";
import { SelectSpawnPoint } from "../src/game/p_client";
import { SV_ContentNeedsWideLayout } from "../src/server/sv_init";

const RETAIL_PAK = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const haveRetail = existsSync(RETAIL_PAK);

// ---------------------------------------------------------------------------
// Classic-module fixture. Same shape as test/g_spawn.test.ts's own
// buildFakeImports/setupWorld, widened to hold a real map (mgu4m1 parses
// 1540 entity blocks) and with InitItems() run, because SP_worldspawn calls
// SetItemNames and the item classnames have to resolve the way they do in a
// real load -- an entity dropped for the wrong reason would shift the edict
// order G_Find walks.
// ---------------------------------------------------------------------------

const MAXENTITIES = 4096;
const MAXCLIENTS = 1;

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

/** Set by buildFakeImports so a test can read SpawnEntities' own
 *  "<n> entities inhibited" line -- the only place the classic module
 *  reports the count. */
let dprints: string[] = [];

/*
The session's configstring layout, which SpawnEntities reads through
gi.extended_layout() and uses as the content gate on its SPAWNFLAG_NOT_COOP
arm (src/game/g_spawn.ts). In a real session sv_init.ts's
SV_ContentNeedsWideLayout answers this from the map's own entity lump before
ge.SpawnEntities runs, so the game module sees a settled value; here it is
set per test by setupWorld from the Ruleset's `wide` field.

The engine leaves the import OPTIONAL (src/game/game.ts's GameImports marks
it `?`), so a fixture that omits it is a valid narrow session -- which is
exactly what every pre-existing test in this file is, and why they all keep
vanilla's coop behavior unchanged.
*/
let sessionIsWide = false;

function buildFakeImports(): GameImports {
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
  let indexCounter = 0;
  const bump = (): number => ++indexCounter;

  return {
    bprintf: () => {},
    dprintf: (fmt: string) => {
      dprints.push(fmt);
    },
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: bump,
    soundindex: bump,
    imageindex: bump,
    setmodel: () => {},
    trace: () => trace,
    pointcontents: () => 0,
    inPVS: () => true,
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
    extended_layout: () => sessionIsWide,
    cvar: () => fakeCvar(0),
    cvar_set: (_n: string, value: string) => fakeCvar(0, value),
    cvar_forceset: (_n: string, value: string) => fakeCvar(0, value),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

interface Ruleset {
  skill: number;
  deathmatch: number;
  coop: number;
  /**
   * Is the session on the WIDE configstring layout, i.e. is it carrying
   * re-release presentation? Defaults to false everywhere it is left off,
   * which is the 1997-content case: no map in the classic tree matches
   * SV_ContentNeedsWideLayout's predicate (656 entity lumps scanned, zero
   * matches), so a classic-tree session is always narrow and the classic
   * module's SPAWNFLAG_NOT_COOP arm can never fire there.
   */
  wide?: boolean;
}

const SINGLE_PLAYER: Ruleset = { skill: 1, deathmatch: 0, coop: 0 };
/** Coop on a NARROW session -- 1997 content. Vanilla's rules, unchanged. */
const COOP_NARROW: Ruleset = { skill: 1, deathmatch: 0, coop: 1 };
/** Coop on a WIDE session -- re-release content. The re-release's rules. */
const COOP_WIDE: Ruleset = { skill: 1, deathmatch: 0, coop: 1, wide: true };

function setupWorld(rules: Ruleset): void {
  dprints = [];
  GetGameAPI(buildFakeImports());

  SetGEdicts(Array.from({ length: MAXENTITIES }, () => new EdictT()));

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;

  level.clear();
  st.clear();

  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) gameCvars[key] = null;
  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.skill = fakeCvar(rules.skill);
  gameCvars.deathmatch = fakeCvar(rules.deathmatch);
  gameCvars.coop = fakeCvar(rules.coop);
  sessionIsWide = rules.wide === true;
  gameCvars.dmflags = fakeCvar(0);

  globals.num_edicts = MAXCLIENTS + 1;

  // FindItem/FindItemByClassname bound their search by game.num_items,
  // which only InitItems() populates (see test/p_client.test.ts).
  InitItems();
}

/** What the CLASSIC module really selects: real SpawnEntities, then real
 *  SelectSpawnPoint. Returns the selection as SelectSpawnPoint hands it to
 *  PutClientInServer (origin already carrying vanilla's `origin[2] += 9`),
 *  or null if it reached gi.error. */
function classicSelection(mapname: string, entities: string, spawnpoint: string, rules: Ruleset = SINGLE_PLAYER): { origin: Vec3; angles: Vec3 } | null {
  setupWorld(rules);
  SpawnEntities(mapname, entities, spawnpoint);

  const player = g_edicts[1]!;
  const origin = vec3();
  const angles = vec3();
  try {
    SelectSpawnPoint(player, origin, angles);
  } catch {
    // Kept so a REGRESSION back to vanilla's gi.error is reported as
    // "<no spawn point>" rather than blowing the whole file up. Nothing
    // reaches it any more: p_client.ts now ends the chain the way the
    // re-release does (print, then the world origin) instead of calling
    // gi.error. See the "no spawn point at all" test below.
    return null;
  }
  return { origin, angles };
}

// ---------------------------------------------------------------------------
// Rerelease reference model (transcribed; see the file header)
// ---------------------------------------------------------------------------

/** g_local.h:252-262 / src/kexgame/g_local.ts:186-192. */
const SPAWNFLAG_NOT_EASY = 0x00000100;
const SPAWNFLAG_NOT_MEDIUM = 0x00000200;
const SPAWNFLAG_NOT_HARD = 0x00000400;
const SPAWNFLAG_NOT_DEATHMATCH = 0x00000800;
const SPAWNFLAG_NOT_COOP = 0x00001000;
const SPAWNFLAG_COOP_ONLY = 0x00004000;

interface RawEntity {
  classname: string;
  targetname: string | null;
  spawnflags: number;
  origin: Vec3;
  angles: Vec3;
}

/** src/kexgame/g_spawn.ts's `G_InhibitEntity` (g_spawn.cpp:1070-1086),
 *  line for line. */
function kexInhibits(spawnflags: number, rules: Ruleset): boolean {
  if (rules.deathmatch !== 0) return (spawnflags & SPAWNFLAG_NOT_DEATHMATCH) !== 0;

  if (rules.coop !== 0 && (spawnflags & SPAWNFLAG_NOT_COOP) !== 0) return true;
  if (rules.coop === 0 && (spawnflags & SPAWNFLAG_COOP_ONLY) !== 0) return true;

  return (
    (rules.skill === 0 && (spawnflags & SPAWNFLAG_NOT_EASY) !== 0) ||
    (rules.skill === 1 && (spawnflags & SPAWNFLAG_NOT_MEDIUM) !== 0) ||
    (rules.skill >= 2 && (spawnflags & SPAWNFLAG_NOT_HARD) !== 0)
  );
}

/** src/kexgame/p_client.ts's `SelectSingleSpawnPoint` (p_client.cpp:1199-1228),
 *  over the starts G_InhibitEntity left alive, in map order. */
function kexSelection(entities: readonly RawEntity[], spawnpoint: string, rules: Ruleset = SINGLE_PLAYER): RawEntity | null {
  const starts = entities.filter((e, i) => e.classname === "info_player_start" && (i === 0 || !kexInhibits(e.spawnflags, rules)));

  for (const spot of starts) {
    if (spawnpoint.length === 0 && spot.targetname === null) return spot;
    if (spawnpoint.length === 0 || spot.targetname === null) continue;
    if (spawnpoint.toLowerCase() === spot.targetname.toLowerCase()) return spot;
  }
  for (const spot of starts) if (spot.targetname === null) return spot;
  return starts[0] ?? null;
}

// ---------------------------------------------------------------------------
// Self-contained retail readers (see the file header for why hand-rolled)
// ---------------------------------------------------------------------------

interface PackEntry {
  name: string;
  filepos: number;
  filelen: number;
}

function readPack(pakPath: string): { data: Buffer; entries: PackEntry[] } {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") throw new Error("not a PACK file");
  const dirofs = data.readInt32LE(4);
  const count = Math.floor(data.readInt32LE(8) / 64);

  const entries: PackEntry[] = [];
  for (let i = 0; i < count; i++) {
    const off = dirofs + i * 64;
    const name = data.toString("ascii", off, off + 56).replace(/\0.*$/, "");
    entries.push({ name, filepos: data.readInt32LE(off + 56), filelen: data.readInt32LE(off + 60) });
  }
  return { data, entries };
}

/** Lump 0 is the entity string in both the classic IBSP layout and the
 *  rerelease's extended QBSP one, so one reader covers the shipped set. */
function entityLump(bsp: Buffer): string | null {
  if (bsp.length < 16) return null;
  const magic = bsp.toString("ascii", 0, 4);
  if (magic !== "IBSP" && magic !== "QBSP") return null;
  const ofs = bsp.readInt32LE(8);
  const len = bsp.readInt32LE(12);
  if (ofs < 0 || len < 0 || ofs + len > bsp.length) return null;
  return bsp.toString("latin1", ofs, ofs + len);
}

/** Deliberately dumb brace/key-value reader, independent of this port's own
 *  COM_Parse/ED_ParseEdict, so a parser bug cannot mask a selection bug. */
function parseEntities(entityString: string): RawEntity[] {
  const out: RawEntity[] = [];
  for (const block of entityString.matchAll(/\{([^{}]*)\}/g)) {
    const kv = new Map<string, string>();
    for (const pair of block[1]!.matchAll(/"([^"]*)"\s*"([^"]*)"/g)) kv.set(pair[1]!, pair[2]!);

    const nums = (s: string | undefined): Vec3 => {
      const p = (s ?? "").trim().split(/\s+/).map(Number);
      return vec3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
    };
    // "angle" is the one-value shorthand ED_ParseField expands into
    // angles[YAW]; "angles" is the full triple.
    const angles = kv.has("angles") ? nums(kv.get("angles")) : vec3(0, Number(kv.get("angle") ?? 0), 0);

    out.push({
      classname: kv.get("classname") ?? "",
      targetname: kv.get("targetname") ?? null,
      spawnflags: Number.parseInt(kv.get("spawnflags") ?? "0", 10) || 0,
      origin: nums(kv.get("origin")),
      angles,
    });
  }
  return out;
}

interface ShippedMap {
  name: string;
  entityString: string;
  entities: RawEntity[];
  /** every spawnpoint any shipped target_changelevel routes INTO this map */
  spawnpoints: Set<string>;
}

let shippedCache: ShippedMap[] | null = null;

function shippedMaps(): ShippedMap[] {
  if (shippedCache !== null) return shippedCache;

  const pak = readPack(RETAIL_PAK);
  const maps = new Map<string, ShippedMap>();

  for (const entry of pak.entries) {
    if (!entry.name.toLowerCase().endsWith(".bsp")) continue;
    const text = entityLump(pak.data.subarray(entry.filepos, entry.filepos + entry.filelen));
    if (text === null) continue;
    const name = entry.name.slice("maps/".length, -".bsp".length).toLowerCase();
    maps.set(name, { name, entityString: text, entities: parseEntities(text), spawnpoints: new Set([""]) });
  }

  // A target_changelevel's "map" key is "<dest>[$<spawnpoint>]", optionally
  // "*"-prefixed for a new unit -- exactly what the server hands
  // SpawnEntities as its `spawnpoint` argument on the next level.
  for (const map of maps.values()) {
    for (const block of map.entityString.matchAll(/\{([^{}]*)\}/g)) {
      const kv = new Map<string, string>();
      for (const pair of block[1]!.matchAll(/"([^"]*)"\s*"([^"]*)"/g)) kv.set(pair[1]!, pair[2]!);
      if (kv.get("classname") !== "target_changelevel") continue;

      const raw = (kv.get("map") ?? "").replace(/^\*/, "");
      if (raw === "") continue;
      const [dest, spawnpoint] = raw.split("$");
      maps.get((dest ?? "").toLowerCase())?.spawnpoints.add(spawnpoint ?? "");
    }
  }

  shippedCache = [...maps.values()].sort((a, b) => a.name.localeCompare(b.name));
  return shippedCache;
}

function describeSelection(sel: { origin: Vec3; angles: Vec3 } | null): string {
  if (sel === null) return "<no spawn point>";
  return `${sel.origin[0]} ${sel.origin[1]} ${sel.origin[2]} @ ${sel.angles[0]} ${sel.angles[1]} ${sel.angles[2]}`;
}

function describeReference(spot: RawEntity | null): string {
  // p_client.cpp's SelectSpawnPoint, single-player branch:
  //     spot = SelectSingleSpawnPoint(ent);
  //     // in SP, just put us at the origin if spawn fails
  //     if (!spot) { gi.Com_PrintFmt(...); origin = {0,0,0}; angles = {0,0,0}; return true; }
  // so "nothing selected" is a real, successful spawn at the world origin
  // in the re-release, not a failure -- and src/game/p_client.ts now does
  // the same instead of vanilla's gi.error. The classic module's own +9 z
  // nudge (p_client.c:911) applies to a CHOSEN spot's origin, not to this
  // constant, so the fallback compares as a plain 0 0 0.
  if (spot === null) return "0 0 0 @ 0 0 0";
  // vanilla's SelectSpawnPoint adds 9 to z after copying the spot origin;
  // the rerelease's single-player arm does not, so the reference is lifted
  // here to keep the comparison about WHICH ENTITY was chosen rather than
  // about that constant (which is 1997 behavior this module keeps).
  return `${spot.origin[0]} ${spot.origin[1]} ${spot.origin[2] + 9} @ ${spot.angles[0]} ${spot.angles[1]} ${spot.angles[2]}`;
}

// ---------------------------------------------------------------------------
// 1. Synthetic maps -- no retail data. The vanilla selection must be
//    untouched, and the rerelease keys must be the only thing that changes
//    anything.
// ---------------------------------------------------------------------------

function ent(classname: string, fields: Record<string, string> = {}): string {
  const body = Object.entries({ classname, ...fields })
    .map(([k, v]) => `"${k}" "${v}"`)
    .join("\n");
  return `{\n${body}\n}\n`;
}

const WORLD = ent("worldspawn");

describe("classic module: 1997-shaped maps select exactly what vanilla selected", () => {
  test("one untargeted info_player_start, empty spawnpoint", () => {
    const map = WORLD + ent("info_player_start", { origin: "16 32 64", angle: "90" });
    expect(describeSelection(classicSelection("v_one", map, ""))).toBe("16 32 73 @ 0 90 0");
  });

  test("several untargeted starts, empty spawnpoint: the FIRST one, in map order", () => {
    const map =
      WORLD +
      ent("info_player_start", { origin: "1 0 0", angle: "10" }) +
      ent("info_player_start", { origin: "2 0 0", angle: "20" }) +
      ent("info_player_start", { origin: "3 0 0", angle: "30" });
    expect(describeSelection(classicSelection("v_first", map, ""))).toBe("1 0 9 @ 0 10 0");
  });

  test("named spawnpoint picks the matching targetname, case-insensitively", () => {
    const map =
      WORLD +
      ent("info_player_start", { origin: "1 0 0" }) +
      ent("info_player_start", { origin: "2 0 0", targetname: "FromLab" });
    expect(describeSelection(classicSelection("v_named", map, "fromlab"))).toBe("2 0 9 @ 0 0 0");
  });

  test("empty spawnpoint with only TARGETED starts falls back to any -- vanilla's own tail", () => {
    const map =
      WORLD +
      ent("info_player_start", { origin: "7 0 0", targetname: "a" }) +
      ent("info_player_start", { origin: "8 0 0", targetname: "b" });
    expect(describeSelection(classicSelection("v_anytail", map, ""))).toBe("7 0 9 @ 0 0 0");
  });

  test("a start with no rerelease flag bits is never inhibited, at any skill", () => {
    const map = WORLD + ent("info_player_start", { origin: "5 5 5" });
    for (const skill of [0, 1, 2, 3]) {
      expect(describeSelection(classicSelection("v_skill", map, "", { skill, deathmatch: 0, coop: 0 }))).toBe("5 5 14 @ 0 0 0");
    }
  });

  test("SPAWNFLAG_NOT_COOP on a start does NOT inhibit it on a NARROW session -- vanilla left that check off", () => {
    // Vanilla's own decision, and the one this module keeps for 1997
    // content: g_spawn.c's ED_LoadFromFile has the coop check commented
    // out. A narrow session is what every classic-tree map produces.
    const map = WORLD + ent("info_player_start", { origin: "4 4 4", spawnflags: String(SPAWNFLAG_NOT_COOP) });
    expect(describeSelection(classicSelection("v_notcoop", map, "", COOP_NARROW))).toBe("4 4 13 @ 0 0 0");
  });

  test("...and single player never reads the bit either, wide session or not", () => {
    // SPAWNFLAG_NOT_COOP is a coop-only rule in both games; the wide gate
    // must not leak it into a non-coop session.
    const map = WORLD + ent("info_player_start", { origin: "4 4 4", spawnflags: String(SPAWNFLAG_NOT_COOP) });
    expect(describeSelection(classicSelection("v_notcoop_sp", map, "", { ...SINGLE_PLAYER, wide: true }))).toBe("4 4 13 @ 0 0 0");
  });
});

describe("classic module: the rerelease keys, and only those, change the selection", () => {
  test("SPAWNFLAG_COOP_ONLY start is skipped in single player and taken in coop", () => {
    // The exact shape every Call of the Machine entry map uses.
    const map =
      WORLD +
      ent("info_player_start", { origin: "100 0 0", spawnflags: String(SPAWNFLAG_COOP_ONLY) }) +
      ent("info_player_start", { origin: "200 0 0", spawnflags: String(SPAWNFLAG_NOT_COOP) });

    expect(describeSelection(classicSelection("r_pair", map, "", SINGLE_PLAYER))).toBe("200 0 9 @ 0 0 0");
    expect(describeSelection(classicSelection("r_pair", map, "", { skill: 1, deathmatch: 0, coop: 1 }))).toBe("100 0 9 @ 0 0 0");
  });

  test("SPAWNFLAG_NOT_COOP IS honored in coop on a wide session -- the rerelease's arm, gated on rerelease content", () => {
    // The COOP_ONLY/NOT_COOP pair again, but in coop and on a wide session.
    // The rerelease frees the NOT_COOP start and keeps the COOP_ONLY one;
    // the classic module now does the same, and the two starts here are far
    // enough apart that picking the wrong one is unmissable.
    const map =
      WORLD +
      ent("info_player_start", { origin: "100 0 0", spawnflags: String(SPAWNFLAG_COOP_ONLY) }) +
      ent("info_player_start", { origin: "200 0 0", spawnflags: String(SPAWNFLAG_NOT_COOP) });

    // narrow (1997 content): both starts survive, vanilla takes the first.
    expect(describeSelection(classicSelection("r_pair", map, "", COOP_NARROW))).toBe("100 0 9 @ 0 0 0");
    // wide (rerelease content): identical to the above here, because the
    // COOP_ONLY start already wins on map order -- the difference is which
    // ENTITIES exist, which the inhibit-count test below pins down.
    expect(describeSelection(classicSelection("r_pair", map, "", COOP_WIDE))).toBe("100 0 9 @ 0 0 0");
  });

  test("the wide gate changes the coop ENTITY SET, not just the start -- inhibit counts, both layouts", () => {
    // Order reversed from the test above so the NOT_COOP start is the one
    // vanilla would take: on a wide session it is gone and the COOP_ONLY
    // start is selected instead, which is exactly the mgu4m1 defect shape.
    const map =
      WORLD +
      ent("info_player_start", { origin: "200 0 0", spawnflags: String(SPAWNFLAG_NOT_COOP) }) +
      ent("info_player_start", { origin: "100 0 0", spawnflags: String(SPAWNFLAG_COOP_ONLY) }) +
      ent("monster_soldier", { origin: "0 0 0", spawnflags: String(SPAWNFLAG_NOT_COOP) });

    expect(describeSelection(classicSelection("r_rev", map, "", COOP_NARROW))).toBe("200 0 9 @ 0 0 0");
    expect(dprints.filter((m) => m.endsWith(" entities inhibited\n"))).toEqual(["0 entities inhibited\n"]);

    expect(describeSelection(classicSelection("r_rev", map, "", COOP_WIDE))).toBe("100 0 9 @ 0 0 0");
    expect(dprints.filter((m) => m.endsWith(" entities inhibited\n"))).toEqual(["2 entities inhibited\n"]);
  });

  test("a lone COOP_ONLY start leaves single player with no start at all -- same entity set as the rerelease", () => {
    // The inhibition is at load time, so the entity is gone before
    // selection runs, and the rerelease's SelectSingleSpawnPoint returns
    // null. Both modules now recover the same way: print, and put the
    // player at the world origin.
    const map = WORLD + ent("info_player_start", { origin: "9 9 9", spawnflags: String(SPAWNFLAG_COOP_ONLY) });
    expect(kexSelection(parseEntities(map), "", SINGLE_PLAYER)).toBeNull();
    expect(describeSelection(classicSelection("r_only", map, "", SINGLE_PLAYER))).toBe("0 0 0 @ 0 0 0");
  });

  test("rule 2: an unmatched non-empty spawnpoint falls back instead of reaching gi.error", () => {
    const map = WORLD + ent("info_player_start", { origin: "3 3 3" }) + ent("info_player_start", { origin: "4 4 4", targetname: "known" });
    // vanilla: no match, spawnpoint non-empty -> gi.error. rerelease: the
    // first untargeted start.
    expect(describeSelection(classicSelection("r_fallback", map, "missing"))).toBe("3 3 12 @ 0 0 0");
  });

  test("rule 2 with every start targeted: the first one in map order", () => {
    const map = WORLD + ent("info_player_start", { origin: "6 6 6", targetname: "a" });
    expect(describeSelection(classicSelection("r_any", map, "missing"))).toBe("6 6 15 @ 0 0 0");
  });

  test("a map with no info_player_start at all spawns at the world origin, as the rerelease does, instead of vanilla's gi.error", () => {
    // Vanilla p_client.c:906 ends the chain with
    //     gi.error ("Couldn't find spawn point %s\n", game.spawnpoint);
    // which drops the server. The rerelease prints and returns the world
    // origin (p_client.cpp, SelectSpawnPoint's single-player branch).
    //
    // This is not hypothetical: the cross-module map sweep
    // (test/parity_map_sweep.test.ts) found THREE shipped maps with no
    // spawn point of any kind -- test/mals_box, test/mals_ladder_test and
    // test/mals_barrier_test -- which the classic module could not host at
    // all until it adopted this branch.
    expect(describeSelection(classicSelection("r_none", WORLD, ""))).toBe("0 0 0 @ 0 0 0");
  });
});

// ---------------------------------------------------------------------------
// 2. Shipped content -- retail-gated. The classic module's real selection
//    must equal the rerelease's on every shipped map, for every spawnpoint
//    any shipped target_changelevel can route into it.
// ---------------------------------------------------------------------------

describe.skipIf(!haveRetail)("shipped maps: classic selects the rerelease's start entity", () => {
  test("every map, every reachable spawnpoint, single player", () => {
    const maps = shippedMaps();
    expect(maps.length).toBeGreaterThan(200);

    const mismatches: string[] = [];
    for (const map of maps) {
      for (const spawnpoint of [...map.spawnpoints].sort()) {
        const mine = describeSelection(classicSelection(map.name, map.entityString, spawnpoint, SINGLE_PLAYER));
        const theirs = describeReference(kexSelection(map.entities, spawnpoint, SINGLE_PLAYER));
        if (mine !== theirs) mismatches.push(`${map.name} spawnpoint=${JSON.stringify(spawnpoint)}: classic ${mine} vs rerelease ${theirs}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 600_000);

  test("the six Call of the Machine entry maps really do carry the paired starts", () => {
    // Guards the gate itself: if a data drop ever stopped shipping the
    // COOP_ONLY/NOT_COOP pair, the test above would pass vacuously.
    const paired = shippedMaps()
      .filter((m) => {
        const starts = m.entities.filter((e) => e.classname === "info_player_start");
        return starts.some((s) => (s.spawnflags & SPAWNFLAG_COOP_ONLY) !== 0) && starts.some((s) => (s.spawnflags & SPAWNFLAG_NOT_COOP) !== 0);
      })
      .map((m) => m.name);

    expect(paired).toEqual(["mgu1m1", "mgu1m4", "mgu2m1", "mgu3m1", "mgu4m1", "mgu5m1"]);
  });

  test("mgu4m1 -- the reported defect -- starts the player inside the drop pod", () => {
    const map = shippedMaps().find((m) => m.name === "mgu4m1");
    expect(map).toBeDefined();

    // The pod interior start, not the coop one out on the terrain at
    // (-2371.99 890.16 -41).
    expect(describeSelection(classicSelection("mgu4m1", map!.entityString, "", SINGLE_PLAYER))).toBe("-2320 2672 3477 @ 0 -180 0");
  });

  test("the whole inhibition pass agrees with the rerelease's, map for map", () => {
    // Broader than the start point: SPAWNFLAG_COOP_ONLY also gates monsters,
    // items and scripting (mgu4m1's drop-pod teleporter is armed by a
    // COOP_ONLY trigger_always). At skill 1 single player the two rulesets'
    // inhibition passes are the same rule, so the counts must match exactly
    // -- this is what keeps the Rogue and Q64 maps, which carry most of the
    // 239 shipped COOP_ONLY entities, playing the way the rerelease plays
    // them.
    const mismatches: string[] = [];
    for (const map of shippedMaps()) {
      setupWorld(SINGLE_PLAYER);
      SpawnEntities(map.name, map.entityString, "");
      const line = dprints.find((m) => m.endsWith(" entities inhibited\n"));
      const mine = Number.parseInt(line ?? "-1", 10);

      const theirs = map.entities.filter((e, i) => i !== 0 && kexInhibits(e.spawnflags, SINGLE_PLAYER)).length;
      if (mine !== theirs) mismatches.push(`${map.name}: classic inhibited ${mine}, rerelease ${theirs}`);
    }
    expect(mismatches).toEqual([]);
  }, 600_000);

  test("COOP: the whole inhibition pass agrees with the rerelease's on every wide map", () => {
    // The coop counterpart of the single-player test above, and the thing
    // the SPAWNFLAG_NOT_COOP arm was added for. On a WIDE session the two
    // rulesets' inhibition passes are now the same rule in coop as well, so
    // the counts must match exactly, map for map.
    const mismatches: string[] = [];
    let wideMaps = 0;
    for (const map of shippedMaps()) {
      if (!SV_ContentNeedsWideLayout(map.entityString).needed) continue;
      wideMaps++;
      setupWorld(COOP_WIDE);
      SpawnEntities(map.name, map.entityString, "");
      const line = dprints.find((m) => m.endsWith(" entities inhibited\n"));
      const mine = Number.parseInt(line ?? "-1", 10);

      const theirs = map.entities.filter((e, i) => i !== 0 && kexInhibits(e.spawnflags, COOP_WIDE)).length;
      if (mine !== theirs) mismatches.push(`${map.name}: classic inhibited ${mine}, rerelease ${theirs}`);
    }
    expect(mismatches).toEqual([]);
    // Guards the gate against passing vacuously. Deliberately a FLOOR and a
    // named set rather than an exact count: SV_ContentNeedsWideLayout's
    // predicate grows as more re-release presentation gets ported (it has
    // already gained the fog and world-text entries), and this test is
    // about the coop rule agreeing wherever the gate fires, not about how
    // many maps that is today.
    expect(wideMaps).toBeGreaterThanOrEqual(116);
    for (const name of ["mgu1m1", "mgu4m1", "mgu6m1"]) {
      const m = shippedMaps().find((x) => x.name === name);
      expect(SV_ContentNeedsWideLayout(m!.entityString).needed).toBe(true);
    }
  }, 600_000);

  test("COOP: a NARROW session keeps vanilla's counts on the very same maps", () => {
    // The other half of the gate. Re-run of the maps above with the session
    // narrow: the classic module must now DISAGREE with the rerelease by
    // exactly the number of SPAWNFLAG_NOT_COOP entities each map carries,
    // because that is the 1997 behavior it keeps for 1997 content.
    const wrong: string[] = [];
    for (const name of ["mgu4m1", "mgu1m1", "mgu6m1"]) {
      const map = shippedMaps().find((m) => m.name === name);
      expect(map).toBeDefined();
      setupWorld(COOP_NARROW);
      SpawnEntities(map!.name, map!.entityString, "");
      const mine = Number.parseInt(dprints.find((m) => m.endsWith(" entities inhibited\n")) ?? "-1", 10);
      const theirs = map!.entities.filter((e, i) => i !== 0 && kexInhibits(e.spawnflags, COOP_WIDE)).length;
      const notCoop = map!.entities.filter((e, i) => i !== 0 && (e.spawnflags & SPAWNFLAG_NOT_COOP) !== 0).length;
      if (theirs - mine !== notCoop) wrong.push(`${name}: rerelease ${theirs}, classic-narrow ${mine}, NOT_COOP ents ${notCoop}`);
    }
    expect(wrong).toEqual([]);
  }, 600_000);

  test("COOP: mgu1m1 now selects the rerelease's start -- one of the two cells the old gap left open", () => {
    // Was: the classic module took the NOT_COOP start at -496 2576 1352,
    // 1100 units up and most of the map away from where the rerelease puts
    // a coop player. Now both select the COOP_ONLY start at 2336 2192 232.
    // Both sides are reported through the same describe* pair the
    // single-player sweep above uses, so the z carries vanilla's
    // `origin[2] += 9` on both (describeReference lifts the reference to
    // match; test/parity_map_sweep.test.ts classifies the real 9-unit
    // difference as C3). The point here is the START, not the nudge.
    const map = shippedMaps().find((m) => m.name === "mgu1m1");
    expect(map).toBeDefined();
    const mine = describeSelection(classicSelection("mgu1m1", map!.entityString, "", COOP_WIDE));
    expect(mine).toBe("2336 2192 241 @ 0 -180 0");
    expect(describeReference(kexSelection(map!.entities, "", COOP_WIDE))).toBe(mine);

    // ...and it really was different before the arm: on a narrow session
    // the NOT_COOP start survives and vanilla's map-order rule takes it.
    expect(describeSelection(classicSelection("mgu1m1", map!.entityString, "", COOP_NARROW))).toBe("-496 2576 1361 @ 0 -180 0");
  });

  test("COOP: mgu6m1's entity set now matches, and its remaining start difference is a DIFFERENT rule", () => {
    // The second of the two cells. mgu6m1's only info_player_start carries
    // SPAWNFLAG_NOT_COOP, so once the arm honors it BOTH modules'
    // info_player_start chain comes up empty -- they agree, and that
    // agreement is what this test pins.
    //
    // Where they still differ is what happens NEXT, and it is not this
    // rule: vanilla's SelectCoopSpawnPoint (p_client.c) returns NULL
    // outright for client 0 ("player 0 starts in normal player spawn
    // point"), so the classic module falls through to its no-start
    // recovery and puts the player at the world origin. The rerelease
    // rewrote that routine (p_client.cpp:1270-1372, transcribed at
    // src/kexgame/p_client.ts's SelectCoopSpawnPoint): EVERY coop client,
    // client 0 included, tries SelectSingleSpawnPoint and then falls back
    // to the map's info_player_coop spots, of which mgu6m1 has four. That
    // fallback lives in p_client.ts, not g_spawn.ts, and is the one map of
    // all 222 where the difference is observable -- it is the only wide map
    // whose every info_player_start is NOT_COOP.
    const map = shippedMaps().find((m) => m.name === "mgu6m1");
    expect(map).toBeDefined();

    // Same entity set: the inhibition passes agree.
    setupWorld(COOP_WIDE);
    SpawnEntities(map!.name, map!.entityString, "");
    const mine = Number.parseInt(dprints.find((m) => m.endsWith(" entities inhibited\n")) ?? "-1", 10);
    const theirs = map!.entities.filter((e, i) => i !== 0 && kexInhibits(e.spawnflags, COOP_WIDE)).length;
    expect(mine).toBe(theirs);

    // Same info_player_start chain result: nothing survives, on both sides.
    expect(kexSelection(map!.entities, "", COOP_WIDE)).toBeNull();
    expect(describeSelection(classicSelection("mgu6m1", map!.entityString, "", COOP_WIDE))).toBe("0 0 0 @ 0 0 0");

    // And the four info_player_coop spots the rerelease would fall back to
    // really are there, so this stays a live follow-up rather than a
    // hypothetical one.
    expect(map!.entities.filter((e) => e.classname === "info_player_coop").length).toBe(4);
  });

  test("no shipped 1997/Xatrix/Rogue map places SPAWNFLAG_COOP_ONLY on a start", () => {
    // Why the flag is a safe gate: the bit only ever appears on
    // rerelease-authored starts, so the classic selection is untouched
    // everywhere else.
    const carriers = shippedMaps()
      .filter((m) => m.entities.some((e) => e.classname === "info_player_start" && (e.spawnflags & SPAWNFLAG_COOP_ONLY) !== 0))
      .map((m) => m.name);

    expect(carriers.every((n) => n.startsWith("mgu"))).toBe(true);
  });
});
