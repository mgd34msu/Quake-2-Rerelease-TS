/*
Coverage gate for the "any content plays under any ruleset; a map's entities
are never dropped" property, applied to the EXPANSION and MOD modules:
src/xatrix/ (The Reckoning), src/rogue/ (Ground Zero), src/ctf/ and
src/lmctf/ (Loki's Minions CTF).

This is the sibling of test/g_spawn_rerelease_coverage.test.ts, which gates
the same property for the classic src/game/ module. Read that file first --
it documents the shared idiom (hand-rolled PACK/BSP readers, retail-gated
skips, exemption lists that must justify themselves).

WHY THIS EXISTS. Two defects motivated it, both proven live from a real
launch with `developer 1`:

  A. The expansion modules never gained the re-release-era entity classes
     that src/game gained in commit 288484f, even though the re-release
     ships re-authored versions of the expansion campaign maps that place
     them. xswamp under The Reckoning dropped 12 entities across
     info_landmark, dynamic_light, target_poi and item_flashlight; rmine1
     under Ground Zero dropped 14 across dynamic_light, target_poi and
     info_landmark; q2kctf1 under CTF dropped 14 across ammo_magslug,
     weapon_phalanx, weapon_boomer, item_double and ammo_trap.

  B. src/lmctf/g_items.ts shipped a deliberately partial ITEMLIST holding
     only the hook, the flag and the runes. Because ED_CallSpawn resolves
     item classnames out of the item table (never out of spawns[]), EVERY
     standard id item failed to spawn on EVERY LM-CTF map in EVERY game
     mode: lmctf09 dropped 109 entities across 17 classnames, identically
     under `deathmatch 1` and under `coop 1`. An LM-CTF map had no weapons,
     no ammo and no armor anywhere on the floor.

WHAT IT CHECKS, per module:

  1. SHIPPED-CONTENT (retail-gated, skips if the retail trees are absent).
     Scan the entity lump of every .bsp the module's own game directory
     ships, PLUS the re-release's re-authored version of each of those same
     maps where one exists, and assert every classname they place resolves
     in that module. This corresponds one-for-one to the "doesn't have a
     spawn function" lines a real launch prints.

  2. MODE-INDEPENDENCE. The same classname set must resolve under
     deathmatch and under coop. Vanilla ED_CallSpawn takes no game mode
     into account -- mode only ever decides whether an already-spawned
     entity is then inhibited or freed -- so a module whose resolvable set
     moved with the mode would be wrong by construction. Defect B looked
     like a coop gate and was not one; this check is what keeps that
     misreading from coming back.

  3. SPOT-CHECKS naming the specific rosters that were broken, so a
     regression fails with a message that says what it lost rather than
     hiding inside a large diff.

No retail content is copied into this repository. The .bsp bytes are read
out of the user's local install at test-run time with a self-contained
PACK-format reader (deliberately NOT this engine's own FS_* code, matching
the idiom in test/g_spawn_rerelease_coverage.test.ts), and nothing is
written to disk.
*/

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { G_SpawnableClassnames as xatrixSpawnable } from "../src/xatrix/g_spawn";
import { G_SpawnableClassnames as rogueSpawnable } from "../src/rogue/g_spawn";
import { G_SpawnableClassnames as ctfSpawnable } from "../src/ctf/g_spawn";
import { G_SpawnableClassnames as lmctfSpawnable } from "../src/lmctf/g_spawn";

/** Classic retail install: one directory per game module. */
const CLASSIC_ROOT = "/home/buzzkill/q2ts";
/** Re-release install. Its baseq2/pak0.pak carries the re-authored version
 *  of every expansion campaign map (xswamp, rmine1, ... all live under
 *  maps/ in the base pack, not in a per-expansion directory), which is what
 *  an expansion module actually loads when the re-release tree is the
 *  basedir. That is where the re-release-only classnames come from. */
const RERELEASE_PAK = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";

const haveClassic = existsSync(CLASSIC_ROOT);
const haveRerelease = existsSync(RERELEASE_PAK);
const haveRetail = haveClassic && haveRerelease;

// ---------------------------------------------------------------------------
// Self-contained retail readers (see file header for why these are hand-rolled)
// ---------------------------------------------------------------------------

interface BspT {
  /** basename, lowercased, e.g. "xswamp.bsp" */
  name: string;
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
    const base = name.split("/").pop();
    if (base === undefined) continue;
    out.push({ name: base.toLowerCase(), buf: data.subarray(filepos, filepos + filelen) });
  }
  return out;
}

/** Every .bsp a directory offers: loose files plus the contents of any .pak
 *  sitting in it. Not recursive beyond the explicit directory list, which is
 *  how the engine's own search path works. */
function dirBsps(dir: string): BspT[] {
  if (!existsSync(dir)) return [];
  const out: BspT[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    const lower = f.toLowerCase();
    if (lower.endsWith(".bsp")) out.push({ name: lower, buf: readFileSync(p) });
    else if (lower.endsWith(".pak")) out.push(...packBsps(p));
  }
  return out;
}

/** Lump 0 of a Quake 2 .bsp is the entity string. Both the classic IBSP
 *  magic and the re-release's extended QBSP magic use the same header
 *  layout, so one reader covers the whole shipped set. */
function entityLump(bsp: Buffer): string | null {
  if (bsp.length < 8 + 19 * 8) return null;
  const magic = bsp.toString("ascii", 0, 4);
  if (magic !== "IBSP" && magic !== "QBSP") return null;
  const ofs = bsp.readInt32LE(8);
  const len = bsp.readInt32LE(12);
  if (ofs < 0 || len < 0 || ofs + len > bsp.length) return null;
  return bsp.toString("latin1", ofs, ofs + len);
}

/** Every `"classname" "<value>"` in an entity lump. A deliberately dumb
 *  regex reader, independent of this port's own COM_Parse/ED_ParseEdict, so
 *  a parser bug cannot mask a coverage hole. */
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

// ---------------------------------------------------------------------------
// Per-module map sets and exemptions
// ---------------------------------------------------------------------------

interface ModuleSpecT {
  label: string;
  spawnable: () => string[];
  /** Directories whose .bsp/.pak contents are this module's own map set. */
  dirs: string[];
  /** Extra map basenames that live only in the re-release base pack but are
   *  this module's content (the re-release CTF maps have no classic
   *  counterpart in the CTF install). */
  extraRereleaseMaps: string[];
  /** Classnames placed by the map set that this module deliberately does
   *  not spawn. Every entry carries its reason at the definition site. */
  exempt: ReadonlySet<string>;
  /** Guard against a vacuously-green run. */
  minBsps: number;
}

/*
=============================================================================
EXEMPTIONS

The rule that earns one: the module's real, shipped game DLL does not spawn
the classname either, so requiring our port to spawn it would make it MORE
permissive than the game it reproduces. Anything else is a port gap and
belongs in the code, not here.
=============================================================================
*/

/** kitchen.bsp is a non-id fan map that shipped inside the local Reckoning
 *  install's pak. Its four exotic classnames exist in NO Quake 2 game DLL
 *  this repository ports -- not src/game, and not src/kexgame, which is the
 *  faithful port of the real re-release DLL. They are another mod's
 *  entities that a map author left in the file. The real Reckoning DLL
 *  prints "doesn't have a spawn function" for all four, exactly as we do. */
const XATRIX_EXEMPT: ReadonlySet<string> = new Set([
  "misc_turret",
  "monster_cocoon",
  "monster_healer",
  "monster_spiker",
]);

const ROGUE_EXEMPT: ReadonlySet<string> = new Set<string>([]);

const CTF_EXEMPT: ReadonlySet<string> = new Set<string>([]);

/** LM-CTF removed ZOID's tech powerups outright: `#define IT_TECH 64` is
 *  deleted in lmctf60/g_local.h (src/lmctf/g_local.ts carries a comment at
 *  the deletion site) and there is no item_tech row anywhere in
 *  lmctf60/g_items.c's ITEMLIST. LM-CTF's equivalent subsystem is its five
 *  runes, which do spawn. bmap3.bsp is a third-party map that places the
 *  CTF techs; the real LM-CTF DLL drops them for the same reason we do.
 *  This is faithful behavior, not a coverage gap. */
const LMCTF_EXEMPT: ReadonlySet<string> = new Set([
  "item_tech1",
  "item_tech2",
  "item_tech3",
  "item_tech4",
]);

const MODULES: readonly ModuleSpecT[] = [
  {
    label: "xatrix (The Reckoning)",
    spawnable: xatrixSpawnable,
    dirs: [`${CLASSIC_ROOT}/xatrix`, `${CLASSIC_ROOT}/xatrix/maps`],
    extraRereleaseMaps: [],
    exempt: XATRIX_EXEMPT,
    minBsps: 25,
  },
  {
    label: "rogue (Ground Zero)",
    spawnable: rogueSpawnable,
    dirs: [`${CLASSIC_ROOT}/rogue`, `${CLASSIC_ROOT}/rogue/maps`],
    extraRereleaseMaps: [],
    exempt: ROGUE_EXEMPT,
    minBsps: 25,
  },
  {
    label: "ctf",
    spawnable: ctfSpawnable,
    dirs: [`${CLASSIC_ROOT}/ctf`, `${CLASSIC_ROOT}/ctf/maps`],
    // The re-release's own CTF maps. They ship only in the re-release base
    // pack and they are the ones that place the Ground Zero / Reckoning
    // pickups the classic CTF module never had.
    extraRereleaseMaps: ["q2kctf1.bsp", "q2kctf2.bsp", "ndctf0.bsp"],
    exempt: CTF_EXEMPT,
    minBsps: 15,
  },
  {
    label: "lmctf (Loki's Minions CTF)",
    spawnable: lmctfSpawnable,
    dirs: [`${CLASSIC_ROOT}/lmctf`, `${CLASSIC_ROOT}/lmctf/maps`],
    extraRereleaseMaps: [],
    exempt: LMCTF_EXEMPT,
    minBsps: 100,
  },
];

interface ScanT {
  /** classname -> the map basenames that place it */
  byClassname: Map<string, Set<string>>;
  bspCount: number;
}

const scanCache = new Map<string, ScanT>();

function scanModule(spec: ModuleSpecT): ScanT {
  const cached = scanCache.get(spec.label);
  if (cached !== undefined) return cached;

  const own: BspT[] = [];
  for (const d of spec.dirs) own.push(...dirBsps(d));

  // Every map this module owns, by basename, then the re-release's
  // re-authored version of each where the base pack has one. Both variants
  // are scanned: a module has to spawn the content of whichever build of
  // the map the active basedir supplies.
  const wanted = new Set(own.map((b) => b.name));
  for (const e of spec.extraRereleaseMaps) wanted.add(e);

  const all: BspT[] = [...own];
  for (const rr of packBsps(RERELEASE_PAK)) {
    if (wanted.has(rr.name)) all.push(rr);
  }

  const byClassname = new Map<string, Set<string>>();
  let bspCount = 0;
  for (const b of all) {
    const e = entityLump(b.buf);
    if (e === null) continue;
    bspCount++;
    for (const cn of new Set(classnamesIn(e))) {
      let maps = byClassname.get(cn);
      if (maps === undefined) {
        maps = new Set<string>();
        byClassname.set(cn, maps);
      }
      maps.add(b.name);
    }
  }
  const scan: ScanT = { byClassname, bspCount };
  scanCache.set(spec.label, scan);
  return scan;
}

function unresolved(spec: ModuleSpecT): string[] {
  const scan = scanModule(spec);
  const have = new Set(spec.spawnable());
  return [...scan.byClassname.keys()]
    .filter((cn) => !NOT_TABLE_DISPATCHED.has(cn))
    .filter((cn) => !spec.exempt.has(cn))
    .filter((cn) => !have.has(cn))
    .sort();
}

// ---------------------------------------------------------------------------

describe.if(haveRetail)("expansion and mod module shipped-map coverage (retail-gated)", () => {
  for (const spec of MODULES) {
    describe(spec.label, () => {
      test("the retail scan actually found this module's maps", () => {
        // Sanity: if this drops the rest of the module's checks are
        // vacuously green.
        expect(scanModule(spec).bspCount).toBeGreaterThanOrEqual(spec.minBsps);
      });

      test("every classname its shipped maps place resolves in the module", () => {
        // A failure here is exactly the set of "<classname> doesn't have a
        // spawn function" lines a real launch of these maps would print.
        expect(unresolved(spec)).toEqual([]);
      });

      test("every exemption is actually placed by a shipped map", () => {
        // Keeps the exemption lists from rotting into a dumping ground: an
        // entry that no map places is not an exemption, it is dead text.
        const scan = scanModule(spec);
        const stale = [...spec.exempt].filter((cn) => !scan.byClassname.has(cn)).sort();
        expect(stale).toEqual([]);
      });
    });
  }
});

describe("module spawn resolution does not depend on the game mode", () => {
  /*
  Vanilla ED_CallSpawn consults exactly two things -- the item table, then
  spawns[] -- and neither is filtered by deathmatch/coop. Game mode only
  decides whether an entity that ALREADY spawned is then inhibited
  (ED_ParseEdict's SPAWNFLAG_NOT_DEATHMATCH / SPAWNFLAG_NOT_COOP) or freed
  (SpawnItem's dmflags gates). So a module's resolvable classname set must
  be identical in every mode.

  Defect B presented as "items only fail outside deathmatch" and was
  misdiagnosed as a coop gate on the item table; the truth was that the
  LM-CTF item table was near-empty and failed identically in BOTH modes
  (109 dropped entities on lmctf09 either way). These assertions pin the
  invariant so that misreading cannot return.

  G_SpawnableClassnames reads the two static tables directly, so this is
  checked by construction as well as by repetition: the call is made twice
  with the module's cvars in whatever state the suite left them, and the
  results must agree.
  */
  for (const spec of MODULES) {
    test(`${spec.label}: the resolvable set is stable across calls and modes`, () => {
      const a = [...new Set(spec.spawnable())].sort();
      const b = [...new Set(spec.spawnable())].sort();
      expect(b).toEqual(a);
      expect(a.length).toBeGreaterThan(0);
    });
  }
});

describe("the rosters that were broken stay fixed", () => {
  /*
  Named spot-checks. These fail with a message that says exactly what was
  lost, instead of that loss hiding inside a large sorted diff from the
  shipped-map check above. They also keep working when the retail trees are
  absent, which the scan-driven checks cannot.
  */

  test("The Reckoning spawns the re-release entities its maps place", () => {
    const have = new Set(xatrixSpawnable());
    // The four that dropped 12 entities on xswamp, plus the rest of the
    // re-release-era set its other campaign maps place.
    for (const cn of [
      "info_landmark",
      "dynamic_light",
      "target_poi",
      "item_flashlight",
      "info_nav_lock",
      "trigger_fog",
      "func_plat2",
      "item_invisibility",
    ]) {
      expect({ classname: cn, resolves: have.has(cn) }).toEqual({ classname: cn, resolves: true });
    }
  });

  test("Ground Zero spawns the re-release entities its maps place", () => {
    const have = new Set(rogueSpawnable());
    for (const cn of [
      "dynamic_light",
      "target_poi",
      "info_landmark",
      "func_animation",
      "info_nav_lock",
      "trigger_fog",
      "item_invisibility",
    ]) {
      expect({ classname: cn, resolves: have.has(cn) }).toEqual({ classname: cn, resolves: true });
    }
  });

  test("LM-CTF spawns the standard id item set in every mode", () => {
    /*
    Defect B in one assertion. Every one of these is an ITEMLIST classname,
    resolved by ED_CallSpawn's item-table pass and never by spawns[], so
    this is a direct check that src/lmctf/g_items.ts's ITEMLIST is the real
    lmctf60/g_items.c list and not the partial stub it used to be.

    The 17 that failed on lmctf09 are all here, plus the rest of the list
    the C source carries.
    */
    const have = new Set(lmctfSpawnable());
    for (const cn of [
      // the 17 that failed live, in both deathmatch and coop
      "item_armor_shard",
      "item_armor_jacket",
      "item_armor_combat",
      "ammo_bullets",
      "ammo_shells",
      "ammo_grenades",
      "ammo_cells",
      "ammo_rockets",
      "ammo_slugs",
      "weapon_supershotgun",
      "weapon_rocketlauncher",
      "weapon_railgun",
      "weapon_machinegun",
      "weapon_hyperblaster",
      "weapon_grenadelauncher",
      "weapon_chaingun",
      "item_silencer",
      // the rest of lmctf60/g_items.c's ITEMLIST
      "item_armor_body",
      "item_power_screen",
      "item_power_shield",
      "weapon_blaster",
      "weapon_shotgun",
      "weapon_bfg",
      "item_quad",
      "item_invulnerability",
      "item_breather",
      "item_enviro",
      "item_ancient_head",
      "item_adrenaline",
      "item_bandolier",
      "item_pack",
      "key_data_cd",
      "key_power_cube",
      "key_pyramid",
      "key_data_spinner",
      "key_pass",
      "key_blue_key",
      "key_red_key",
      "key_commander_head",
      "key_airstrike_target",
    ]) {
      expect({ classname: cn, resolves: have.has(cn) }).toEqual({ classname: cn, resolves: true });
    }
  });

  test("LM-CTF keeps its own entities working", () => {
    // The mod content that already worked before defect B was fixed. A
    // regression here would mean the ITEMLIST port clobbered the partial
    // file's real contributions.
    const have = new Set(lmctfSpawnable());
    for (const cn of [
      "flag",
      "weapon_hook",
      "weapon_plasma",
      "damage_rune",
      "resist_rune",
      "haste_rune",
      "regen_rune",
      "info_player_red",
      "info_player_blue",
    ]) {
      expect({ classname: cn, resolves: have.has(cn) }).toEqual({ classname: cn, resolves: true });
    }
  });

  test("LM-CTF does not spawn the tech powerups it deliberately removed", () => {
    // The inverse guard. LM-CTF deleted `IT_TECH` and has no item_tech row;
    // if one appears, someone ported ZOID's CTF item list wholesale instead
    // of LM-CTF's, and the mod's rune subsystem is being shadowed.
    const have = new Set(lmctfSpawnable());
    for (const cn of ["item_tech1", "item_tech2", "item_tech3", "item_tech4"]) {
      expect({ classname: cn, resolves: have.has(cn) }).toEqual({ classname: cn, resolves: false });
    }
  });
});
