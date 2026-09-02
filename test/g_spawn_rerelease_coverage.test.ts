/*
Coverage gate for the "any content plays under any ruleset" property: every
entity classname the RERELEASE game module can spawn must also resolve in
the CLASSIC 3.21 game module, and -- the part that actually matters for
play -- every classname the shipped rerelease maps actually place must
resolve there too.

Why this exists: before the rerelease-content port, launching any rerelease
map under the classic ruleset printed "N unknown classnames suppressed" and
silently dropped those entities, and the whole Call of the Machine campaign
was unplayable under the classic ruleset because its monsters, items and
triggers had no spawn function in src/game/. The port added them as
first-class content. This file is the regression gate that keeps them there.

THREE independent checks, in increasing strength:

  1. TABLE-vs-TABLE (no retail data needed). Diff the classic module's
     spawnable-classname set against the kexgame module's. Any classname
     the rerelease module can spawn that the classic module cannot is a
     coverage hole. A small, explicitly-listed set of RERELEASE-ONLY
     classnames is allowed to be absent -- see RERELEASE_ONLY_EXEMPT below,
     which documents why each one is exempt.

  2. SHIPPED-CONTENT (retail-gated, skips if the retail tree is absent).
     Scan the entity lump of every .bsp inside the real retail install and
     assert that every classname they actually place resolves in the
     classic module. This is the check that corresponds one-for-one to the
     "0 unknown classnames" line in a real launch.

  3. SPOT-CHECK of the Call of the Machine roster specifically, so a
     regression that drops exactly the CotM content fails with a message
     that names it rather than hiding in a large diff.

No retail content is copied into this repository. The .bsp bytes are read
out of the user's local install at test-run time with a self-contained
PACK-format reader (deliberately NOT this engine's own FS_* code, matching
the established idiom in test/bnvib_retail.test.ts and
test/cl_demo_retail.test.ts), and nothing is written to disk.
*/

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { G_SpawnableClassnames } from "../src/game/g_spawn";
import { spawns as kexSpawns } from "../src/kexgame/g_spawn";
import { itemlist as kexItemlist } from "../src/kexgame/g_items";

const RETAIL_ROOT = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_ROOT}/baseq2/pak0.pak`;
const haveRetail = existsSync(PAK_PATH);

/*
=============================================================================
RERELEASE-ONLY CLASSNAMES THAT ARE DELIBERATELY NOT IN THE CLASSIC MODULE

Each entry here is a considered exemption, not an oversight. The rule that
earns an exemption: the classname is in the kexgame spawn table but is NOT
placed by any .bsp the retail install ships, AND it belongs to a subsystem
the classic module does not host at all. Check 2 below is the real gate --
it is driven by what the shipped maps actually place, so anything a map
places must resolve regardless of what this list says.
=============================================================================
*/
const RERELEASE_ONLY_EXEMPT: ReadonlySet<string> = new Set([
  // The rerelease's own deathmatch game modes. These are gamerules the
  // classic module has no equivalent of (its DM is vanilla 3.21 DM), and
  // no shipped single-player or campaign map places any of them.
  "dm_dball_ball",
  "dm_dball_ball_start",
  "dm_dball_goal",
  "dm_dball_speed_change",
  "dm_dball_team1_start",
  "dm_dball_team2_start",

  // weapon_grapple. Deliberately absent, not overlooked.
  //
  // ZERO of the 222 .bsp files the retail install ships place this
  // classname (verified by scanning every entity lump), so it is not part
  // of "the classic ruleset plays the shipped rerelease content" -- check 2
  // below, which is driven by what the maps actually place, does not want
  // it.
  //
  // It is left out rather than stubbed because a HALF-ported weapon is
  // worse than an absent one: an itemlist row whose weaponthink is null
  // makes Think_Weapon skip the weapon's state machine entirely, so a
  // player who picked it up would hold a weapon that never fires and can
  // never be switched away from. Landing it properly means porting
  // CTFWeapon_Grapple plus the grapple entity, its pull physics and the
  // CTFPlayerResetGrapple hooks across several files. Listed as known
  // remaining work in the port report.
  "weapon_grapple",

  // ---------------------------------------------------------------------
  // The remaining eight. Every one of them is in the rerelease module's
  // spawn table, and NONE of them is placed by any of the 222 .bsp files
  // the retail install ships -- verified by scanning every entity lump.
  // So the classic ruleset can already play all shipped rerelease content
  // without them (that is what the retail-gated check below actually
  // gates); they are honest coverage gaps against the kexgame TABLE, not
  // against the shipped CONTENT, and they are listed as remaining work in
  // the port report rather than quietly excused.
  //
  // Roughly in ascending order of what each would cost:
  //   func_spinning, func_force_wall, func_door_secret2  -- rogue movers
  //   misc_crashviper                                    -- xatrix prop
  //   trigger_ctf_teleport, info_ctf_teleport_destination-- the CTF
  //       teleport pair, which needs the CTF team plumbing to mean anything
  //   monster_kamikaze                                   -- rogue monster
  //   monster_guardian                                   -- a full
  //       rerelease-only boss (src/kexgame/m_guardian.ts), the single
  //       largest remaining item
  // ---------------------------------------------------------------------
  "func_door_secret2",
  "func_force_wall",
  "func_spinning",
  "info_ctf_teleport_destination",
  "misc_crashviper",
  "monster_guardian",
  "monster_kamikaze",
  "trigger_ctf_teleport",
]);

/** Classnames the CLASSIC module can spawn, as a set. */
function classicSpawnable(): ReadonlySet<string> {
  return new Set(G_SpawnableClassnames());
}

/** Classnames the RERELEASE module resolves: its spawns[] table PLUS its
 *  itemlist, because ED_CallSpawn scans the item list first and item
 *  classnames (weapon_*, ammo_*, item_*, key_*) never appear in the table. */
function kexSpawnable(): ReadonlySet<string> {
  // Same three as G_SpawnableClassnames: the rerelease's own ED_CallSpawn
  // (src/kexgame/g_spawn.ts) remaps these onto shipped items before the
  // table is consulted, so they resolve there too even though no table row
  // or itemlist row carries the name.
  const out = new Set<string>(["weapon_nailgun", "ammo_nails", "weapon_heatbeam"]);
  for (const sp of kexSpawns) out.add(sp.name);
  for (const item of kexItemlist) {
    if (item.classname !== null && item.classname !== undefined && item.classname !== "") {
      out.add(item.classname);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-contained retail readers (see file header for why these are hand-rolled)
// ---------------------------------------------------------------------------

interface PackEntryT {
  name: string;
  filepos: number;
  filelen: number;
}

function readPackDirectory(pakPath: string): { data: Buffer; entries: PackEntryT[] } | null {
  const data = readFileSync(pakPath);
  if (data.length < 12 || data.toString("ascii", 0, 4) !== "PACK") return null;

  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = Math.floor(dirlen / 64);

  const entries: PackEntryT[] = [];
  for (let i = 0; i < numEntries; i++) {
    const off = dirofs + i * 64;
    let name = data.toString("ascii", off, off + 56);
    const nul = name.indexOf("\0");
    if (nul >= 0) name = name.slice(0, nul);
    entries.push({ name, filepos: data.readInt32LE(off + 56), filelen: data.readInt32LE(off + 60) });
  }
  return { data, entries };
}

/** Lump 0 of a Quake 2 .bsp is the entity string. Both the classic IBSP
 *  magic and the rerelease's extended QBSP magic use the same header
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
    if (m[1] !== undefined && m[1] !== "") out.push(m[1]);
    m = re.exec(entityString);
  }
  return out;
}

interface ShippedScanT {
  /** classname -> how many .bsp files place it */
  byClassname: Map<string, number>;
  bspCount: number;
}

let shippedCache: ShippedScanT | null = null;

function scanShippedMaps(): ShippedScanT {
  if (shippedCache !== null) return shippedCache;
  const byClassname = new Map<string, number>();
  let bspCount = 0;

  const pak = readPackDirectory(PAK_PATH);
  if (pak !== null) {
    for (const entry of pak.entries) {
      if (!entry.name.toLowerCase().endsWith(".bsp")) continue;
      const bsp = pak.data.subarray(entry.filepos, entry.filepos + entry.filelen);
      const ents = entityLump(bsp);
      if (ents === null) continue;
      bspCount++;
      for (const cn of new Set(classnamesIn(ents))) {
        byClassname.set(cn, (byClassname.get(cn) ?? 0) + 1);
      }
    }
  }
  shippedCache = { byClassname, bspCount };
  return shippedCache;
}

/*
=============================================================================
CLASSNAMES THE SHIPPED MAPS PLACE THAT NEITHER GAME MODULE SPAWNS

These are not port gaps. They are stray entities left in shipped .bsp files
that the REAL rerelease game DLL also has no spawn function for -- verified
by diffing the shipped-map classname set against src/kexgame/'s own spawn
table, which is the faithful port of that DLL. Most are Quake 1 / editor
leftovers sitting in test and DM maps (trigger_secret, item_health_1,
weapon_nailgun, monster_girl, ...). The rerelease drops them exactly the way
the classic module now does, so requiring the classic module to spawn them
would make it MORE permissive than the game it is reproducing.

This list is asserted to be exactly the kexgame-unresolvable set, so if a
future data drop adds a real classname here the test fails rather than
silently widening the exemption.
=============================================================================
*/
const UNRESOLVABLE_BY_EITHER_MODULE: ReadonlySet<string> = new Set([
  // NOTE: weapon_nailgun, ammo_nails and weapon_heatbeam are deliberately
  // NOT in this list even though neither module's spawn table names them.
  // Both rogue's and the rerelease's ED_CallSpawn carry a "PMM classnames
  // hack" that REMAPS those three pre-release-beta names onto the shipped
  // items (ETF Rifle / Flechettes / Plasma Beam) before the table is
  // consulted, and src/game/g_spawn.ts now does the same. mgu3m2 ships a
  // real weapon_heatbeam, so this is live content, not a beta leftover.
  "ammo_shells_small",
  "func_areaportal1",
  "func_conveyor_belt",
  "func_explosion",
  "item_artifact_invulnerability",
  "item_bullets",
  "item_grenades",
  "item_health_1",
  "item_key1",
  "item_mine",
  "item_shells",
  "light_spot",
  "misc_fireball",
  "monster_girl",
  "monster_turret2",
  "trap_shooter",
  "trigger_changelevel",
  "trigger_secret",
]);

/** worldspawn is never dispatched through the spawn table -- ED_LoadFromFile
 *  hands entity 0 to SP_worldspawn directly -- so it is not expected in
 *  either module's spawnable set. */
const NOT_TABLE_DISPATCHED: ReadonlySet<string> = new Set(["worldspawn"]);

describe("rerelease content coverage in the classic game module", () => {
  test("every classname the rerelease module spawns also resolves in the classic module", () => {
    const classic = classicSpawnable();
    const kex = kexSpawnable();

    const missing = [...kex]
      .filter((cn) => !classic.has(cn))
      .filter((cn) => !RERELEASE_ONLY_EXEMPT.has(cn))
      .sort();

    expect(missing).toEqual([]);
  });

  test("the classic module still spawns everything it always did", () => {
    // Guards against a merge that dropped a vanilla classname while adding
    // rerelease ones. These are spot-picks across every vanilla category.
    const classic = classicSpawnable();
    for (const cn of [
      "info_player_start",
      "func_door",
      "func_plat",
      "trigger_multiple",
      "target_speaker",
      "misc_explobox",
      "monster_soldier",
      "monster_infantry",
      "monster_tank",
      "turret_breach",
      "item_health",
    ]) {
      expect(classic.has(cn)).toBe(true);
    }
  });

  test("the Call of the Machine roster resolves in the classic module", () => {
    // The content that was previously unplayable under the classic ruleset.
    const classic = classicSpawnable();
    const cotm = [
      "monster_arachnid",
      "monster_guncmdr",
      "monster_shambler",
      "monster_tank_stand",
      "monster_gekk",
      "monster_stalker",
      "monster_carrier",
      "monster_widow",
      "monster_widow2",
      "monster_turret",
      "monster_makron",
      "target_poi",
      "target_story",
      "target_healthbar",
      "target_autosave",
      "target_music",
      "trigger_fog",
      "trigger_coop_relay",
      "dynamic_light",
      "misc_flare",
      "misc_model",
      "info_landmark",
      "func_eye",
      "func_animation",
    ];
    const missing = cotm.filter((cn) => !classic.has(cn)).sort();
    expect(missing).toEqual([]);
  });
});

describe.if(haveRetail)("rerelease shipped-map coverage (retail-gated)", () => {
  test("the retail scan actually found maps", () => {
    const scan = scanShippedMaps();
    // Sanity: if this drops to 0 the rest of the suite is vacuously green.
    expect(scan.bspCount).toBeGreaterThan(100);
  });

  test("every classname the shipped rerelease maps place resolves in the classic module", () => {
    const scan = scanShippedMaps();
    const classic = classicSpawnable();

    const unresolved = [...scan.byClassname.keys()]
      .filter((cn) => !classic.has(cn))
      .filter((cn) => !NOT_TABLE_DISPATCHED.has(cn))
      .filter((cn) => !UNRESOLVABLE_BY_EITHER_MODULE.has(cn))
      .sort();

    // A failure here is exactly the "N unknown classnames suppressed" line
    // a real classic-ruleset launch of a rerelease map would print.
    expect(unresolved).toEqual([]);
  });

  test("the not-in-either-module list is exactly the set the rerelease module also cannot spawn", () => {
    // Keeps UNRESOLVABLE_BY_EITHER_MODULE honest: it may only ever contain
    // classnames the FAITHFUL rerelease port also has no spawn function
    // for. If this fails, something was excused that the real game handles.
    const scan = scanShippedMaps();
    const kex = kexSpawnable();

    const stillUnresolvableByKex = [...scan.byClassname.keys()]
      .filter((cn) => !kex.has(cn))
      .filter((cn) => !NOT_TABLE_DISPATCHED.has(cn))
      .sort();

    expect(stillUnresolvableByKex).toEqual([...UNRESOLVABLE_BY_EITHER_MODULE].sort());
  });
});
