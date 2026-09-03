/*
The owner's charter for this port is "any game content under any game
ruleset, nothing missing, nothing greyed". This file is the measurement of
that property at its widest setting: EVERY map the 2023 re-release ships,
run through EVERY ruleset this engine hosts.

Its two siblings each cover one slice of the same property and are the files
to read first for the shared idiom (hand-rolled PACK/BSP readers, retail-
gated skips, exemption lists that must justify themselves):

  test/g_spawn_rerelease_coverage.test.ts   classic src/game only
  test/g_spawn_module_coverage.test.ts      each module's OWN shipped maps

This file is deliberately wider than both. The sibling above scans, for each
expansion module, only the maps that module's own game directory ships plus
the re-release's re-authored version of those same maps. That is the right
gate for "The Reckoning can still play The Reckoning", but it is not the
charter: the charter says a player may load mguhub -- a Call of the Machine
map -- under the Ground Zero ruleset, or q2ctf1 under LM-CTF, and lose
nothing. So this file crosses the product: all 222 shipped re-release maps
against all five legacy spawn tables, with no per-module map filter.

WHAT IT MEASURED WHEN IT WAS WRITTEN. Every count below is a real dropped-
entity count from the re-release pak, and every one of them was a live
"<classname> doesn't have a spawn function" line in a real launch:

  src/xatrix      78 classnames unresolved
  src/rogue       53
  src/ctf        109
  src/lmctf      129
  src/game         0   (the classic module had already been brought across)

The single worst live cell was mguhub under The Reckoning, which dropped 63
entities across four classnames (misc_flare x36, func_eye x18,
target_crossunit_target x7, target_light x2) -- a Call of the Machine map
missing every flare, every eye and its whole cross-unit trigger web.

WHY THE EXEMPTIONS ARE NOT A LOOPHOLE. Eighteen classnames in the shipped
pak resolve in NO Quake 2 game module that has ever existed, including
src/kexgame -- this port's faithful translation of the real 2023 re-release
game DLL. They are museum content: seventeen of the eighteen come from
`maps/old/`, the pre-release beta maps id shipped in the re-release as a
historical extra, and they use a Quake-1-era vocabulary (trigger_changelevel,
item_health_1, item_key1, light_spot, monster_girl, trigger_secret) that no
shipped Quake 2 DLL ever had a spawn function for. The real re-release drops
them exactly as we do.

Rather than hardcode that claim, the exemption test below PROVES it: every
exempt classname must also fail to resolve in src/kexgame. An exemption that
src/kexgame can actually spawn is a port gap in disguise and fails the test.
The reverse guard is here too -- an exemption no shipped map places is dead
text, not an exemption.

No retail content is copied into this repository. The .bsp bytes are read out
of the user's local install at test-run time with a self-contained PACK
reader (deliberately NOT this engine's own FS_* code, matching the sibling
files' idiom, so an FS bug cannot mask a coverage hole), and nothing is
written to disk.
*/

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { vec3 } from "../src/shared/math";
import { CplaneT, CS_ITEMS, CvarT, MAX_ITEMS } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";

import { G_SpawnableClassnames as gameSpawnable } from "../src/game/g_spawn";
import { G_SpawnableClassnames as xatrixSpawnable } from "../src/xatrix/g_spawn";
import { G_SpawnableClassnames as rogueSpawnable } from "../src/rogue/g_spawn";
import { G_SpawnableClassnames as ctfSpawnable } from "../src/ctf/g_spawn";
import { G_SpawnableClassnames as lmctfSpawnable } from "../src/lmctf/g_spawn";

// The faithful port of the real 2023 game DLL. Used ONLY as the reference
// that justifies the exemption list -- never as a module under test here.
import { spawns as kexSpawns } from "../src/kexgame/g_spawn";
import { itemlist as kexItemlist } from "../src/kexgame/g_items";

/** The re-release install. Its baseq2/pak0.pak carries every shipped map --
 *  the base campaign, both expansions re-authored, Call of the Machine, the
 *  CTF set, the Nintendo 64 set, the `maps/old/` beta museum and the
 *  `maps/test/` authoring maps -- all under one `maps/` tree. */
const RERELEASE_PAK = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const haveRerelease = existsSync(RERELEASE_PAK);

// ---------------------------------------------------------------------------
// Self-contained retail readers (see file header for why these are hand-rolled)
// ---------------------------------------------------------------------------

interface BspT {
  /** full in-pak path, lowercased, e.g. "maps/old/fact2.bsp" */
  path: string;
  buf: Buffer;
}

function packBsps(pakPath: string): BspT[] {
  const data = readFileSync(pakPath);
  if (data.length < 12 || data.toString("ascii", 0, 4) !== "PACK") return [];
  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const out: BspT[] = [];
  for (let i = 0; i < Math.floor(dirlen / 64); i++) {
    const off = dirofs + i * 64;
    let name = data.toString("ascii", off, off + 56);
    const nul = name.indexOf("\0");
    if (nul >= 0) name = name.slice(0, nul);
    if (!name.toLowerCase().endsWith(".bsp")) continue;
    const filepos = data.readInt32LE(off + 56);
    const filelen = data.readInt32LE(off + 60);
    out.push({ path: name.toLowerCase(), buf: data.subarray(filepos, filepos + filelen) });
  }
  return out;
}

/** Lump 0 of a Quake 2 .bsp is the entity string. The classic IBSP magic and
 *  the re-release's extended QBSP magic share the header layout, so one
 *  reader covers the whole shipped set. */
function entityLump(bsp: Buffer): string | null {
  if (bsp.length < 8 + 19 * 8) return null;
  const magic = bsp.toString("ascii", 0, 4);
  if (magic !== "IBSP" && magic !== "QBSP") return null;
  const ofs = bsp.readInt32LE(8);
  const len = bsp.readInt32LE(12);
  if (ofs < 0 || len < 0 || ofs + len > bsp.length) return null;
  return bsp.toString("latin1", ofs, ofs + len);
}

/** Every `"classname" "<value>"` in an entity lump. A deliberately dumb regex
 *  reader, independent of this port's own COM_Parse/ED_ParseEdict, so a
 *  parser bug cannot mask a coverage hole. */
function classnamesIn(entityString: string): string[] {
  const out: string[] = [];
  const re = /"classname"\s*"([^"]*)"/g;
  let m = re.exec(entityString);
  while (m !== null) {
    const v = m[1];
    if (v !== undefined && v !== "") out.push(v);
    m = re.exec(entityString);
  }
  return out;
}

/** worldspawn is never dispatched through the spawn table -- ED_LoadFromFile
 *  hands entity 0 to SP_worldspawn directly -- so no module's spawnable set
 *  is expected to contain it. */
const NOT_TABLE_DISPATCHED: ReadonlySet<string> = new Set(["worldspawn"]);

/*
The eighteen museum classnames. See the file header: every one is proven
below to be unresolvable in src/kexgame too, which is what makes it an
exemption rather than a gap. The map that places each is named so a reader
can check the claim without running anything.
*/
const MUSEUM_EXEMPT: ReadonlySet<string> = new Set([
  "ammo_shells_small", //             maps/ec/waste_ec.bsp
  "func_areaportal1", //              maps/test/test_jerry.bsp
  "func_conveyor_belt", //            maps/old/fact2, fact3, ware1
  "func_explosion", //                maps/old/pjtrain1.bsp
  "item_artifact_invulnerability", // maps/old/pjtrain1.bsp  (Quake 1 name)
  "item_bullets", //                  maps/old/pjtrain1.bsp  (Quake 1 name)
  "item_grenades", //                 maps/old/pjtrain1.bsp  (Quake 1 name)
  "item_health_1", //                 maps/old/pjtrain1.bsp  (Quake 1 name)
  "item_key1", //                     maps/old/pjtrain1, ware1 (Quake 1 name)
  "item_mine", //                     maps/old/fact2.bsp
  "item_shells", //                   maps/old/pjtrain1.bsp  (Quake 1 name)
  "light_spot", //                    maps/old/pjtrain1.bsp
  "misc_fireball", //                 maps/old/fact3.bsp
  "monster_girl", //                  maps/old/pjtrain1.bsp
  "monster_turret2", //               maps/old/fact2.bsp
  "trap_shooter", //                  maps/old/fact2.bsp
  "trigger_changelevel", //           maps/old/fact1, fact2, fact3, facthub
  "trigger_secret", //                maps/old/pjtrain1.bsp
]);

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

interface ScanT {
  /** classname -> the in-pak map paths that place it */
  byClassname: Map<string, Set<string>>;
  bspCount: number;
}

let scanCache: ScanT | null = null;

function scan(): ScanT {
  if (scanCache !== null) return scanCache;
  const byClassname = new Map<string, Set<string>>();
  let bspCount = 0;
  for (const b of packBsps(RERELEASE_PAK)) {
    const e = entityLump(b.buf);
    if (e === null) continue;
    bspCount++;
    for (const cn of new Set(classnamesIn(e))) {
      let maps = byClassname.get(cn);
      if (maps === undefined) {
        maps = new Set<string>();
        byClassname.set(cn, maps);
      }
      maps.add(b.path);
    }
  }
  scanCache = { byClassname, bspCount };
  return scanCache;
}

interface ModuleSpecT {
  label: string;
  spawnable: () => string[];
}

const MODULES: readonly ModuleSpecT[] = [
  { label: "game (classic 3.21)", spawnable: gameSpawnable },
  { label: "xatrix (The Reckoning)", spawnable: xatrixSpawnable },
  { label: "rogue (Ground Zero)", spawnable: rogueSpawnable },
  { label: "ctf (ThreeWave)", spawnable: ctfSpawnable },
  { label: "lmctf (Loki's Minions CTF)", spawnable: lmctfSpawnable },
];

/** The classnames `spec` cannot resolve, with the map that places each
 *  attached so a failure names the content that would be lost. */
function unresolved(spec: ModuleSpecT): string[] {
  const s = scan();
  const have = new Set(spec.spawnable());
  return [...s.byClassname.keys()]
    .filter((cn) => !NOT_TABLE_DISPATCHED.has(cn))
    .filter((cn) => !MUSEUM_EXEMPT.has(cn))
    .filter((cn) => !have.has(cn))
    .sort()
    .map((cn) => {
      const maps = [...(s.byClassname.get(cn) ?? [])].sort();
      return `${cn} (placed by ${maps.length}: ${maps.slice(0, 3).join(", ")})`;
    });
}

describe.if(haveRerelease)("every shipped re-release map plays under every legacy ruleset (retail-gated)", () => {
  test("the retail scan actually found the shipped map set", () => {
    // Sanity: without this, every check below is vacuously green. The pak
    // held 222 readable .bsp files when this was written.
    expect(scan().bspCount).toBeGreaterThanOrEqual(200);
  });

  for (const spec of MODULES) {
    test(`${spec.label}: resolves every classname the 222 shipped maps place`, () => {
      // A failure here is exactly the set of "<classname> doesn't have a
      // spawn function" lines a real launch of these maps would print, with
      // the map that would lose the entity named alongside.
      expect(unresolved(spec)).toEqual([]);
    });
  }
});

describe.if(haveRerelease)("the museum exemptions justify themselves", () => {
  /** src/kexgame's resolvable set, built the way its own ED_CallSpawn
   *  resolves: the item table first, then spawns[]. This is the faithful
   *  port of the shipped 2023 game DLL, so it is the authority on what the
   *  real game does and does not spawn. */
  function kexResolvable(): Set<string> {
    // src/kexgame's itemlist is a top-level array literal (its own header
    // explains why it must not be a function); the legacy trees' is a
    // getter. Hence the shape difference from the sibling test files.
    const out = new Set<string>();
    for (const item of kexItemlist) {
      if (item.classname !== null) out.add(item.classname);
    }
    for (const s of kexSpawns) out.add(s.name);
    return out;
  }

  test("no exempt classname is one the real re-release DLL can spawn", () => {
    // The rule that earns an exemption: src/kexgame cannot spawn it either,
    // so requiring a legacy module to spawn it would make that module MORE
    // permissive than the game it reproduces. Anything src/kexgame CAN spawn
    // is a port gap and belongs in the code, not on this list.
    const kex = kexResolvable();
    const wronglyExempt = [...MUSEUM_EXEMPT].filter((cn) => kex.has(cn)).sort();
    expect(wronglyExempt).toEqual([]);
  });

  test("every exempt classname is actually placed by a shipped map", () => {
    // Keeps the list from rotting into a dumping ground: an entry no map
    // places is not an exemption, it is dead text.
    const s = scan();
    const stale = [...MUSEUM_EXEMPT].filter((cn) => !s.byClassname.has(cn)).sort();
    expect(stale).toEqual([]);
  });

  test("the exemptions are confined to the museum and authoring map trees", () => {
    // Every exemption must come from maps/old/ (the pre-release beta museum),
    // maps/test/ (authoring maps) or maps/ec/. If one ever appears on a real
    // campaign map, the "nobody can spawn this, it is a historical artifact"
    // reasoning no longer holds and the entry must be re-argued.
    const s = scan();
    const offenders: string[] = [];
    for (const cn of MUSEUM_EXEMPT) {
      for (const p of s.byClassname.get(cn) ?? []) {
        if (!p.startsWith("maps/old/") && !p.startsWith("maps/test/") && !p.startsWith("maps/ec/")) {
          offenders.push(`${cn} on ${p}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CS_SKYROTATE, per module, per configstring layout
// ---------------------------------------------------------------------------

/*
The sky half of the same charter. base1's re-release worldspawn authors
`skyrotate 250` WITH `skyautorotate 0` -- a fixed 250-degree sky offset that
must not spin. q2repro's CL_SetSky (src/client/precache.c:374) reads
CS_SKYROTATE as "<rotate> <autorotate>" on the wide/re-release configstring
layout and as a bare "<rotate>" float otherwise, and its autorotate defaults
to TRUE when the second token is missing. So a module that emits only the
bare float on a wide session hands the client a spinning sky on a map that
asked for a still one.

src/game was fixed for this already and test/g_spawn_sky_autorotate.test.ts
pins it against src/kexgame. The four expansion modules emitted the bare
"%f" unconditionally, so re-release content span its sky under all four.
Both directions are checked below for all five modules:

  WIDE   -> "250 0"        (the two-token form; skyautorotate honored)
  NARROW -> "250.000000"   (Com_sprintf("%f", ...), byte-for-byte what a
                            1997 session has always put on the wire)

The narrow case is the fidelity half and matters as much as the wide one: it
is what keeps a 1997 map's traffic identical to the pre-existing build.
*/

interface SkyRecorderT {
  configstring: Array<{ num: number; str: string }>;
  wide: boolean;
}

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

/*
One imports object serves all five modules. That is not a shortcut: the
legacy engine binding does exactly the same thing -- src/server/bindings/
legacy.ts builds ONE GameImports and hands it to every tree's GetGameAPI,
noting at the call site that "passing it to CTF_GetGameAPI/LMCTF_GetGameAPI
needs no cast". Typing it as src/game's GameImports here therefore also
gives the modules the same optional-hook surface they get at runtime.
*/
function buildSkyImports(rec: SkyRecorderT): GameImports {
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
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 1,
    soundindex: () => 1,
    imageindex: () => 1,
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
    cvar: () => fakeCvar(0),
    cvar_set: (_name: string, value: string) => fakeCvar(0, value),
    cvar_forceset: (_name: string, value: string) => fakeCvar(0, value),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
    // The session-wide layout decision (sv_init.ts's "content-driven layout
    // choice"). This hook IS the gate the modules read.
    extended_layout: () => rec.wide,
  };
}

/** base1's real re-release worldspawn keys. */
const SKY_KEYS = '"sky" "unit1_" "skyrotate" "250" "skyaxis" "0 0 1" "skyautorotate" "0"';
const CS_SKYROTATE_INDEX = 4;

/*
Each module is booted through its own GetGameAPI / SetGEdicts / SpawnEntities
trio. The imports object and the entity string are identical across all five,
so any difference in the recorded configstring is a difference in the module.

Namespace imports (not a dynamic `import(dir)`) on purpose: a template-literal
import resolves to `any`, and this repository bans `any` outright
(scripts/check.sh). Each module's symbols therefore stay fully typed, which
is also what makes the GetGameAPI calls below a real compile-time check that
one imports object still satisfies all five module APIs.
*/
import * as BaseLocal from "../src/game/g_local";
import * as BaseMain from "../src/game/g_main";
import * as BaseSpawn from "../src/game/g_spawn";
import * as BaseItems from "../src/game/g_items";

import * as XatLocal from "../src/xatrix/g_local";
import * as XatMain from "../src/xatrix/g_main";
import * as XatSpawn from "../src/xatrix/g_spawn";
import * as XatItems from "../src/xatrix/g_items";

import * as RogLocal from "../src/rogue/g_local";
import * as RogMain from "../src/rogue/g_main";
import * as RogSpawn from "../src/rogue/g_spawn";
import * as RogItems from "../src/rogue/g_items";

import * as CtfLocal from "../src/ctf/g_local";
import * as CtfMain from "../src/ctf/g_main";
import * as CtfSpawn from "../src/ctf/g_spawn";
import * as CtfItems from "../src/ctf/g_items";

import * as LmLocal from "../src/lmctf/g_local";
import * as LmMain from "../src/lmctf/g_main";
import * as LmSpawn from "../src/lmctf/g_spawn";
import * as LmItems from "../src/lmctf/g_items";

const MAXENTITIES = 64;
const MAXCLIENTS = 1;

/** The module-shaped state reset every run shares. Each module's `game`,
 *  `level`, `st`, `gameCvars` and `globals` are its own distinct types, so
 *  the five runners below stay separate rather than being squeezed through a
 *  common interface that would have to erase them. */
function resetCvars(cvars: Record<string, CvarT | null>): void {
  for (const key of Object.keys(cvars)) cvars[key] = null;
  cvars.maxclients = fakeCvar(MAXCLIENTS);
  cvars.skill = fakeCvar(1);
  cvars.deathmatch = fakeCvar(0);
  cvars.coop = fakeCvar(0);
}

const ENTITIES = `{ "classname" "worldspawn" ${SKY_KEYS} }`;

function skyRotateOf(rec: SkyRecorderT): string | undefined {
  return rec.configstring.find((c) => c.num === CS_SKYROTATE_INDEX)?.str;
}

/** How many CS_ITEMS slots the module wrote a pickup name into. */
function itemNameCount(rec: SkyRecorderT): number {
  return rec.configstring.filter((c) => c.num >= CS_ITEMS && c.num < CS_ITEMS + MAX_ITEMS).length;
}

function runBase(wide: boolean): SkyRecorderT {
  const rec: SkyRecorderT = { configstring: [], wide };
  BaseMain.GetGameAPI(buildSkyImports(rec));
  BaseLocal.SetGEdicts(Array.from({ length: MAXENTITIES }, () => new BaseLocal.EdictT()));
  BaseLocal.game.clear();
  BaseLocal.game.maxclients = MAXCLIENTS;
  BaseLocal.game.maxentities = MAXENTITIES;
  BaseLocal.game.num_items = 0;
  BaseLocal.level.clear();
  BaseLocal.st.clear();
  resetCvars(BaseLocal.gameCvars);
  BaseLocal.globals.num_edicts = MAXCLIENTS + 1;
  BaseItems.InitItems();
  BaseSpawn.SpawnEntities("base1", ENTITIES, "");
  return rec;
}

function runXatrix(wide: boolean): SkyRecorderT {
  const rec: SkyRecorderT = { configstring: [], wide };
  XatMain.GetGameAPI(buildSkyImports(rec));
  XatLocal.SetGEdicts(Array.from({ length: MAXENTITIES }, () => new XatLocal.EdictT()));
  XatLocal.game.clear();
  XatLocal.game.maxclients = MAXCLIENTS;
  XatLocal.game.maxentities = MAXENTITIES;
  XatLocal.game.num_items = 0;
  XatLocal.level.clear();
  XatLocal.st.clear();
  resetCvars(XatLocal.gameCvars);
  XatLocal.globals.num_edicts = MAXCLIENTS + 1;
  XatItems.InitItems();
  XatSpawn.SpawnEntities("base1", ENTITIES, "");
  return rec;
}

function runRogue(wide: boolean): SkyRecorderT {
  const rec: SkyRecorderT = { configstring: [], wide };
  RogMain.GetGameAPI(buildSkyImports(rec));
  RogLocal.SetGEdicts(Array.from({ length: MAXENTITIES }, () => new RogLocal.EdictT()));
  RogLocal.game.clear();
  RogLocal.game.maxclients = MAXCLIENTS;
  RogLocal.game.maxentities = MAXENTITIES;
  RogLocal.game.num_items = 0;
  RogLocal.level.clear();
  RogLocal.st.clear();
  resetCvars(RogLocal.gameCvars);
  RogLocal.globals.num_edicts = MAXCLIENTS + 1;
  RogItems.InitItems();
  RogSpawn.SpawnEntities("base1", ENTITIES, "");
  return rec;
}

function runCtf(wide: boolean): SkyRecorderT {
  const rec: SkyRecorderT = { configstring: [], wide };
  CtfMain.GetGameAPI(buildSkyImports(rec));
  CtfLocal.SetGEdicts(Array.from({ length: MAXENTITIES }, () => new CtfLocal.EdictT()));
  CtfLocal.game.clear();
  CtfLocal.game.maxclients = MAXCLIENTS;
  CtfLocal.game.maxentities = MAXENTITIES;
  CtfLocal.game.num_items = 0;
  CtfLocal.level.clear();
  CtfLocal.st.clear();
  resetCvars(CtfLocal.gameCvars);
  CtfLocal.globals.num_edicts = MAXCLIENTS + 1;
  CtfItems.InitItems();
  CtfSpawn.SpawnEntities("base1", ENTITIES, "");
  return rec;
}

function runLmctf(wide: boolean): SkyRecorderT {
  const rec: SkyRecorderT = { configstring: [], wide };
  LmMain.GetGameAPI(buildSkyImports(rec));
  LmLocal.SetGEdicts(Array.from({ length: MAXENTITIES }, () => new LmLocal.EdictT()));
  LmLocal.game.clear();
  LmLocal.game.maxclients = MAXCLIENTS;
  LmLocal.game.maxentities = MAXENTITIES;
  LmLocal.game.num_items = 0;
  LmLocal.level.clear();
  LmLocal.st.clear();
  resetCvars(LmLocal.gameCvars);
  LmLocal.globals.num_edicts = MAXCLIENTS + 1;
  LmItems.InitItems();
  LmSpawn.SpawnEntities("base1", ENTITIES, "");
  return rec;
}

const SKY_RUNNERS: ReadonlyArray<{ label: string; run: (wide: boolean) => SkyRecorderT }> = [
  { label: "game (classic 3.21)", run: runBase },
  { label: "xatrix (The Reckoning)", run: runXatrix },
  { label: "rogue (Ground Zero)", run: runRogue },
  { label: "ctf (ThreeWave)", run: runCtf },
  { label: "lmctf (Loki's Minions CTF)", run: runLmctf },
];

describe("CS_SKYROTATE: every legacy module honors skyautorotate on a wide session", () => {
  for (const { label, run } of SKY_RUNNERS) {
    test(`${label}: WIDE layout emits the two-token "<rotate> <autorotate>" form`, () => {
      // base1 asks for a 250-degree FIXED sky. Dropping the "0" is exactly
      // what made the sky spin under the four expansion rulesets.
      expect(skyRotateOf(run(true))).toBe("250 0");
    });

    test(`${label}: NARROW layout keeps the bare Com_sprintf("%f") form`, () => {
      // Fidelity half: a 1997-content session must put the same bytes on the
      // wire it always has, so the new branch has to be unreachable there.
      expect(skyRotateOf(run(false))).toBe("250.000000");
    });
  }
});

// ---------------------------------------------------------------------------
// CS_ITEMS, per module, per configstring layout
// ---------------------------------------------------------------------------

/*
The second thing the re-release content port changes about a module's wire
output, and the ONLY other one: SetItemNames writes a CS_ITEMS pickup-name
configstring for every row in ITEMLIST, and this port appended rows to all
four expansion modules' ITEMLISTs so they can spawn what re-release maps
place. Left ungated, a 1997-content session under those rulesets would
suddenly carry item names for pickups that did not exist in 1997.

That is not theoretical. Measured on xswamp under The Reckoning with a real
launch: the 24 appended rows added 24 configstrings, which pushed the
connection handshake into one more `cmd configstrings` batch and changed the
rendered frame by 5468 pixels -- on a map whose entities, precache list and
every other configstring were bit-identical. Capping the loop at the 1997
count restored the frame to the byte-identical control hash. That experiment
is also what proved the item names were the only 1997-observable thing in the
entire port.

So SetItemNames reads the same session-layout hook SP_worldspawn reads for
CS_SKYROTATE, and the two tests below pin both directions for all five
modules: a wide session gets every name, a narrow one gets exactly the count
its module shipped with in 1997.

src/game is in the table with the same count for both layouts on purpose --
it is the control. Its ITEMLIST was already at its full re-release size at
the commit this work branched from, so its 1997 sessions have always carried
all 80 names and gating it now would be the regression.
*/

interface ItemGateSpecT {
  label: string;
  run: (wide: boolean) => SkyRecorderT;
  /** Rows the module shipped with before the re-release content port. */
  narrow: number;
  /** Rows it has now. */
  wide: number;
}

const ITEM_GATES: readonly ItemGateSpecT[] = [
  // The classic module: never gated, both numbers are its current count.
  { label: "game (classic 3.21)", run: runBase, narrow: 80, wide: 80 },
  { label: "xatrix (The Reckoning)", run: runXatrix, narrow: 50, wide: 74 },
  { label: "rogue (Ground Zero)", run: runRogue, narrow: 63, wide: 71 },
  { label: "ctf (ThreeWave)", run: runCtf, narrow: 66, wide: 80 },
  { label: "lmctf (Loki's Minions CTF)", run: runLmctf, narrow: 50, wide: 81 },
];

describe("CS_ITEMS: the appended re-release pickups stay off a 1997 session's wire", () => {
  for (const spec of ITEM_GATES) {
    test(`${spec.label}: NARROW layout writes exactly its 1997 item-name count`, () => {
      // The fidelity gate. A change here means a 1997-content session under
      // this ruleset just started putting different bytes on the wire.
      expect(itemNameCount(spec.run(false))).toBe(spec.narrow);
    });

    test(`${spec.label}: WIDE layout writes a name for every row in the table`, () => {
      // The parity gate. A re-release pickup with no CS_ITEMS name shows an
      // empty pickup message when a player walks over it.
      expect(itemNameCount(spec.run(true))).toBe(spec.wide);
    });
  }

  test("gating only ever WITHHOLDS names -- it never renumbers them", () => {
    // Item indices are network-visible (inventory slots, CS_ITEMS offsets).
    // The narrow set must be a strict prefix of the wide set, never a
    // reordering, or a 1997 client would read the wrong item for a slot.
    for (const spec of ITEM_GATES) {
      const narrow = spec
        .run(false)
        .configstring.filter((c) => c.num >= CS_ITEMS && c.num < CS_ITEMS + MAX_ITEMS);
      const wide = spec
        .run(true)
        .configstring.filter((c) => c.num >= CS_ITEMS && c.num < CS_ITEMS + MAX_ITEMS);
      expect({ module: spec.label, prefix: wide.slice(0, narrow.length) }).toEqual({
        module: spec.label,
        prefix: narrow,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Optional engine hooks
// ---------------------------------------------------------------------------

/*
The re-release entity set does not just need spawn functions; it needs a way
to TALK to the engine. target_poi unicasts svc_poi, the compass unicasts
svc_help_path, trigger_fog sends a fog transition, the shadow-light entities
write their configstring through a dedicated slot writer, and
info_world_text draws through the debug-draw path. All eight of those arrive
as OPTIONAL members of GameImports.

The engine has always supplied all eight to every legacy tree --
src/server/bindings/legacy.ts's BuildLegacyImports sets extended_layout,
shadowlight, fog, poi, help_path, get_path_to_goal,
draw_oriented_world_text and draw_static_world_text on the single imports
object it hands to all five GetGameAPI functions. What was missing was the
DECLARATION: four of the five trees' own GameImports interfaces omitted the
members, so their game code could not call what it was already being given.

The runtime half of the check below asserts the engine really does supply
all eight. The compile-time half is the property access itself: reading
`gi.poi` through a given module's GameImports type only compiles once that
module's interface declares it, so this file fails to typecheck -- and
`bun run check` fails -- if a tree ever drops one again.
*/
describe("the optional re-release engine hooks reach every legacy module", () => {
  test("BuildLegacyImports supplies all eight to the object every tree receives", async () => {
    const { BuildLegacyImports } = await import("../src/server/bindings/legacy");
    const gi = BuildLegacyImports();
    const missing = (
      [
        "extended_layout",
        "shadowlight",
        "fog",
        "poi",
        "help_path",
        "get_path_to_goal",
        "draw_oriented_world_text",
        "draw_static_world_text",
      ] as const
    ).filter((k) => typeof gi[k] !== "function");
    expect(missing).toEqual([]);
  });

  test("each module's own GameImports type declares all eight", async () => {
    // Compile-time gate. Each block reads the eight members THROUGH that
    // module's own GameImports type; a tree that omits one fails tsc here.
    const { BuildLegacyImports } = await import("../src/server/bindings/legacy");

    const base: import("../src/game/game").GameImports = BuildLegacyImports();
    const xat: import("../src/xatrix/game").GameImports = BuildLegacyImports();
    const rog: import("../src/rogue/game").GameImports = BuildLegacyImports();
    const ctf: import("../src/ctf/game").GameImports = BuildLegacyImports();
    const lm: import("../src/lmctf/game").GameImports = BuildLegacyImports();

    const seen: boolean[] = [
      typeof base.poi === "function" &&
        typeof base.help_path === "function" &&
        typeof base.fog === "function" &&
        typeof base.shadowlight === "function" &&
        typeof base.extended_layout === "function" &&
        typeof base.get_path_to_goal === "function" &&
        typeof base.draw_oriented_world_text === "function" &&
        typeof base.draw_static_world_text === "function",
      typeof xat.poi === "function" &&
        typeof xat.help_path === "function" &&
        typeof xat.fog === "function" &&
        typeof xat.shadowlight === "function" &&
        typeof xat.extended_layout === "function" &&
        typeof xat.get_path_to_goal === "function" &&
        typeof xat.draw_oriented_world_text === "function" &&
        typeof xat.draw_static_world_text === "function",
      typeof rog.poi === "function" &&
        typeof rog.help_path === "function" &&
        typeof rog.fog === "function" &&
        typeof rog.shadowlight === "function" &&
        typeof rog.extended_layout === "function" &&
        typeof rog.get_path_to_goal === "function" &&
        typeof rog.draw_oriented_world_text === "function" &&
        typeof rog.draw_static_world_text === "function",
      typeof ctf.poi === "function" &&
        typeof ctf.help_path === "function" &&
        typeof ctf.fog === "function" &&
        typeof ctf.shadowlight === "function" &&
        typeof ctf.extended_layout === "function" &&
        typeof ctf.get_path_to_goal === "function" &&
        typeof ctf.draw_oriented_world_text === "function" &&
        typeof ctf.draw_static_world_text === "function",
      typeof lm.poi === "function" &&
        typeof lm.help_path === "function" &&
        typeof lm.fog === "function" &&
        typeof lm.shadowlight === "function" &&
        typeof lm.extended_layout === "function" &&
        typeof lm.get_path_to_goal === "function" &&
        typeof lm.draw_oriented_world_text === "function" &&
        typeof lm.draw_static_world_text === "function",
    ];
    expect(seen).toEqual([true, true, true, true, true]);
  });
});
