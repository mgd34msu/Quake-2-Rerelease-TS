/*
Regression tests for Mike's 2026-09-02 play test, findings 1-3 -- all three of
which only reproduce when the two data trees are NESTED.

WHY NESTED MATTERS. test/data_root.test.ts already covers the data-tree
remount, but its fixture puts the two trees SIDE BY SIDE (tmp/classic and
tmp/rerelease). Mike's machine -- and the retail Steam layout generally --
nests them instead: /home/buzzkill/q2rets is the 1997 tree and
/home/buzzkill/q2rets/rerelease is the 2023 one, INSIDE it. Every re-release
path therefore also has the classic root as a string prefix, which is exactly
the case the sibling fixture cannot produce and exactly the case that broke:

  finding 2  `data_root rerelease classic maps=classic` served the RE-RELEASE
             maps/base1.bsp even though the launch asked for the 1997
             geometry -- FS_FOpenFile's maps/ carve-out matched search-path
             entries with startsWith(root), which every nested re-release pack
             satisfies for the classic root. Fixed by attributing each entry
             to the DEEPEST data root containing it (files.ts's
             owningDataRoot).

  finding 1  Launching classic-ruleset/classic-maps after any earlier launch
             kept serving the previous tree's copy of the same map name:
             cmodel.ts's CM_LoadMap cache is keyed on the map NAME alone,
             which stops being sufficient the moment a `data_root` switch
             re-roots the filesystem under it. The two base1.bsp files differ
             in inline-model count (35 vs 45), so the mismatch surfaced as
             gl_model.ts's "bad inline model number". Fixed with files.ts's
             FS_Generation() stamp.

  finding 3  Objective text rendered as its own key (`$g_primary_mission_
             objective`). The whole localization table comes out of
             Q2Game.kpf, which on this layout lives ONLY in the nested
             re-release tree, and Loc_Init runs once at the end of
             FS_InitFilesystem -- so a boot against the classic basedir loaded
             zero strings and no later `data_root` switch ever re-read them.
             Fixed by re-running Loc_ReloadFile at the end of FS_SetDataRoot.

Self-sufficient: every fixture tree is built under its own mkdtemp, and all
the process-wide mount/cvar state a real FS_InitFilesystem/FS_SetDataRoot call
touches is snapshotted and restored, the same pattern data_root.test.ts uses.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import {
  FS_LoadFile,
  FS_InitFilesystem,
  FS_SetDataRoot,
  FS_Generation,
  FS_TestSnapshotSearchPaths,
  FS_TestRestoreSearchPaths,
  type FsSearchPathSnapshotT,
} from "../src/qcommon/files";
import { CM_LoadMap, CM_EntityString, CM_MapIsCurrentContent } from "../src/qcommon/cmodel";
import { Loc_Localize, Loc_ReloadFile } from "../src/qcommon/loc";
import { buildBoxRoomBsp } from "./support/bsp_builder";

// ---------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------

/*
A real, minimal Quake II pak (qfiles.h layout: "PACK" + dirofs + dirlen, then
one 64-byte entry per file -- 56-byte NUL-padded name, int filepos, int
filelen). Same shape as data_root.test.ts's own writePak, but taking raw bytes
so a synthetic BSP can go in one.
*/
function writePak(path: string, entries: ReadonlyArray<{ name: string; body: Uint8Array }>): void {
  const dirlen = entries.length * 64;
  let dataLen = 0;
  for (const e of entries) dataLen += e.body.length;

  const out = new Uint8Array(12 + dataLen + dirlen);
  const view = new DataView(out.buffer);
  out.set([0x50, 0x41, 0x43, 0x4b], 0); // "PACK"

  let pos = 12;
  const positions: number[] = [];
  for (const e of entries) {
    positions.push(pos);
    out.set(e.body, pos);
    pos += e.body.length;
  }

  const dirofs = pos;
  view.setInt32(4, dirofs, true);
  view.setInt32(8, dirlen, true);
  entries.forEach((entry, i) => {
    const base = dirofs + i * 64;
    out.set(new TextEncoder().encode(entry.name), base);
    view.setInt32(base + 56, positions[i] ?? 0, true);
    view.setInt32(base + 60, entry.body.length, true);
  });

  writeFileSync(path, out);
}

/*
A real ZIP holding one STOREd entry, which is all Q2Game.kpf detection and
zipfile.ts's reader need (the retail archive stores every entry uncompressed
too). CRCs are left zero: zipfile.ts's extractEntry never verifies them, and a
fixture that lied about one would be testing the wrong thing anyway.
*/
function writeStoredZip(path: string, name: string, body: string): void {
  const nameBytes = new TextEncoder().encode(name);
  const data = new TextEncoder().encode(body);

  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); // local file header signature
  lv.setUint16(4, 20, true); // version needed
  lv.setUint16(8, 0, true); // method: STORE
  lv.setUint32(18, data.length, true); // compressed size
  lv.setUint32(22, data.length, true); // uncompressed size
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); // central directory header signature
  cv.setUint16(6, 20, true); // version needed
  cv.setUint16(10, 0, true); // method: STORE
  cv.setUint32(20, data.length, true); // compressed size
  cv.setUint32(24, data.length, true); // uncompressed size
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true); // local header offset
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true); // central directory offset

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  writeFileSync(path, out);
}

// ---------------------------------------------------------------------------
// Process-wide state this file moves, captured and put back.
// ---------------------------------------------------------------------------

const TOUCHED_CVARS = ["basedir", "homedir", "cddir", "content_root", "data_root_classic", "data_root_rerelease", "game", "gamedir"] as const;

interface SavedState {
  readonly paths: FsSearchPathSnapshotT;
  readonly cvars: ReadonlyArray<readonly [string, string]>;
}

// ---------------------------------------------------------------------------

describe("data trees NESTED one inside the other (the retail/Steam layout)", () => {
  let tmp: string;
  let classicRoot: string;
  let rereleaseRoot: string;
  let saved: SavedState;

  // Two different maps under the SAME name, one per tree. Distinct entity
  // strings are what let a test say which file a load actually reached --
  // this is the synthetic stand-in for the real trees' 35-vs-45 inline-model
  // difference, without shipping any copyrighted map data.
  const CLASSIC_ENTS = '{\n"classname" "worldspawn"\n"message" "CLASSIC-BASE1"\n}\n';
  const RERELEASE_ENTS = '{\n"classname" "worldspawn"\n"message" "RERELEASE-BASE1"\n}\n';

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "q2nested-"));

    // THE LAYOUT UNDER TEST: the re-release tree is a SUBDIRECTORY of the
    // classic one, so rereleaseRoot.startsWith(classicRoot) is true.
    classicRoot = join(tmp, "q2install");
    rereleaseRoot = join(classicRoot, "rerelease");

    mkdirSync(join(classicRoot, "baseq2"), { recursive: true });
    writePak(join(classicRoot, "baseq2", "pak0.pak"), [
      { name: "maps/base1.bsp", body: buildBoxRoomBsp(CLASSIC_ENTS) },
      { name: "shared.txt", body: new TextEncoder().encode("CLASSIC-SHARED") },
      { name: "classic_only.txt", body: new TextEncoder().encode("CLASSIC-ONLY") },
    ]);

    // The re-release tree is the one carrying Q2Game.kpf -- which is both
    // FS_RootIsRerelease's detection rule and, on this layout, the ONLY
    // source of localization data anywhere in the stack.
    mkdirSync(join(rereleaseRoot, "baseq2"), { recursive: true });
    writeStoredZip(
      join(rereleaseRoot, "Q2Game.kpf"),
      "localization/loc_english.txt",
      'g_primary_mission_objective = "Primary Objective:\\n{}"\n',
    );
    writePak(join(rereleaseRoot, "baseq2", "pak0.pak"), [
      { name: "maps/base1.bsp", body: buildBoxRoomBsp(RERELEASE_ENTS) },
      { name: "shared.txt", body: new TextEncoder().encode("RERELEASE-SHARED") },
      { name: "rerelease_only.txt", body: new TextEncoder().encode("RERELEASE-ONLY") },
    ]);

    saved = {
      paths: FS_TestSnapshotSearchPaths(),
      cvars: TOUCHED_CVARS.map((n) => [n, Cvar_VariableString(n)] as const),
    };

    // Boot exactly the way Mike's client does: basedir is the CLASSIC tree,
    // with the re-release tree sitting unmounted one directory down.
    Cvar_ForceSet("basedir", classicRoot);
    Cvar_ForceSet("homedir", "");
    Cvar_ForceSet("cddir", "");
    Cvar_ForceSet("content_root", "");
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("gamedir", "");
    FS_InitFilesystem();
    Cvar_ForceSet("data_root_classic", classicRoot);
    Cvar_ForceSet("data_root_rerelease", rereleaseRoot);
  });

  afterAll(() => {
    FS_TestRestoreSearchPaths(saved.paths);
    for (const [name, value] of saved.cvars) Cvar_ForceSet(name, value);
    // The loc table is process-wide; re-read it against the restored search
    // path so this file's fixture strings do not outlive it.
    Loc_ReloadFile();
    rmSync(tmp, { recursive: true, force: true });
  });

  function textOf(path: string): string | null {
    const raw = FS_LoadFile(path);
    return raw ? new TextDecoder().decode(raw) : null;
  }

  // The message key is the marker each fixture BSP carries, so this reports
  // which tree the currently loaded collision map actually came from.
  function loadedMapMarker(): string {
    const match = /"message" "([^"]+)"/.exec(CM_EntityString());
    return match?.[1] ?? "";
  }

  test("the fixture really is nested -- the re-release root has the classic root as a prefix", () => {
    // If this ever stops holding, the rest of this file is testing the
    // sibling layout data_root.test.ts already covers, and proves nothing.
    expect(rereleaseRoot.startsWith(classicRoot)).toBe(true);
  });

  test("finding 2: maps=classic serves the CLASSIC map even though the re-release tree is nested inside it", () => {
    // The kex-ruleset-on-original-data mount: re-release primary (so its
    // assets win), classic beneath it, maps/ aimed back at classic.
    FS_SetDataRoot([classicRoot, rereleaseRoot], classicRoot);

    // The carve-out's whole purpose -- 1997 geometry.
    expect(textOf("maps/base1.bsp")).not.toBeNull();
    expect(new TextDecoder().decode(FS_LoadFile("maps/base1.bsp")!)).toContain("CLASSIC-BASE1");

    // ...while everything OUTSIDE maps/ still follows the mount order and
    // comes from the re-release tree ("we use the things from that ruleset").
    expect(textOf("shared.txt")).toBe("RERELEASE-SHARED");
    expect(textOf("rerelease_only.txt")).toBe("RERELEASE-ONLY");
    expect(textOf("classic_only.txt")).toBe("CLASSIC-ONLY");
  });

  test("finding 2 control: the same mount order WITHOUT maps= serves the re-release map", () => {
    // Proves the result above comes from the carve-out and not from the mount
    // order accidentally favouring classic.
    FS_SetDataRoot([classicRoot, rereleaseRoot]);
    expect(new TextDecoder().decode(FS_LoadFile("maps/base1.bsp")!)).toContain("RERELEASE-BASE1");
  });

  test("maps=rerelease aims the carve-out the other way on the same nested roots", () => {
    // The mirror image: classic primary, maps/ from the nested re-release
    // tree. A prefix test could never express this direction at all.
    FS_SetDataRoot([rereleaseRoot, classicRoot], rereleaseRoot);
    expect(new TextDecoder().decode(FS_LoadFile("maps/base1.bsp")!)).toContain("RERELEASE-BASE1");
    expect(textOf("shared.txt")).toBe("CLASSIC-SHARED");
  });

  test("a single classic root does not reach into the re-release tree nested under it", () => {
    FS_SetDataRoot([classicRoot]);
    expect(new TextDecoder().decode(FS_LoadFile("maps/base1.bsp")!)).toContain("CLASSIC-BASE1");
    expect(textOf("rerelease_only.txt")).toBeNull();
  });

  test("finding 1: a data-root switch invalidates the map cache, so the same map NAME reloads from the new tree", () => {
    FS_SetDataRoot([rereleaseRoot]);
    CM_LoadMap("maps/base1.bsp", false);
    expect(loadedMapMarker()).toBe("RERELEASE-BASE1");
    expect(CM_MapIsCurrentContent()).toBe(true);

    // The switch alone must make the cached map stale -- this is the check
    // CM_LoadMap's name comparison could not make on its own.
    FS_SetDataRoot([classicRoot]);
    expect(CM_MapIsCurrentContent()).toBe(false);

    // Same name, different tree: without the generation stamp this returned
    // the re-release map from cache, which is finding 1 exactly.
    CM_LoadMap("maps/base1.bsp", false);
    expect(loadedMapMarker()).toBe("CLASSIC-BASE1");
    expect(CM_MapIsCurrentContent()).toBe(true);
  });

  test("finding 1: the CLIENT-side load (clientload=true) is invalidated too", () => {
    // The client path ignores the `flushmap` cvar entirely, so before the
    // generation stamp it had no way at all to notice a re-root.
    FS_SetDataRoot([rereleaseRoot]);
    CM_LoadMap("maps/base1.bsp", true);
    expect(loadedMapMarker()).toBe("RERELEASE-BASE1");

    FS_SetDataRoot([classicRoot]);
    CM_LoadMap("maps/base1.bsp", true);
    expect(loadedMapMarker()).toBe("CLASSIC-BASE1");
  });

  test("FS_Generation advances on every switch and on nothing else", () => {
    const before = FS_Generation();
    FS_SetDataRoot([classicRoot]);
    const afterOne = FS_Generation();
    expect(afterOne).toBeGreaterThan(before);

    // A plain file read must not move it.
    textOf("shared.txt");
    expect(FS_Generation()).toBe(afterOne);

    FS_SetDataRoot([rereleaseRoot]);
    expect(FS_Generation()).toBeGreaterThan(afterOne);
  });

  test("finding 3: booting against the classic basedir loads no localization at all", () => {
    // Nothing in the classic tree carries a Q2Game.kpf, so Loc_Init's one
    // boot-time read finds nothing and every $key falls back to itself --
    // which is the raw text Mike saw on his HUD.
    FS_SetDataRoot([classicRoot]);
    expect(Loc_Localize("$g_primary_mission_objective", true, ["Find the gate"], 1)).toBe("g_primary_mission_objective");
  });

  test("finding 3: the key resolves once the re-release tree is the data root", () => {
    FS_SetDataRoot([rereleaseRoot]);
    expect(Loc_Localize("$g_primary_mission_objective", true, ["Find the gate"], 1)).toBe("Primary Objective:\nFind the gate");
  });

  test("finding 3: the key resolves with classic primary and re-release as the fallback root", () => {
    // The kex-ruleset-on-original-data arrangement, and the mirror of it:
    // the kpf is reachable from either, so localization must work in both.
    FS_SetDataRoot([classicRoot, rereleaseRoot], classicRoot);
    expect(Loc_Localize("$g_primary_mission_objective", true, ["Find the gate"], 1)).toBe("Primary Objective:\nFind the gate");

    FS_SetDataRoot([rereleaseRoot, classicRoot], rereleaseRoot);
    expect(Loc_Localize("$g_primary_mission_objective", true, ["Find the gate"], 1)).toBe("Primary Objective:\nFind the gate");
  });

  test("finding 3: switching back to a tree with no kpf drops the strings again", () => {
    // The reload is a real re-read of the mounted stack, not a one-way
    // "load once and keep whatever was found" latch.
    FS_SetDataRoot([rereleaseRoot]);
    expect(Loc_Localize("$g_primary_mission_objective", true, ["x"], 1)).toBe("Primary Objective:\nx");
    FS_SetDataRoot([classicRoot]);
    expect(Loc_Localize("$g_primary_mission_objective", true, ["x"], 1)).toBe("g_primary_mission_objective");
  });
});
