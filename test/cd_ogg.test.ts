// Wave-B divergence-audit fix: cd_ogg.ts's CDAudio_Play used to look up
// music ONLY under the current gamedir's own music/ directory (raw track
// number, Vorbis filename only), diverging from q2repro's ogg.c jukebox
// (OGG_LoadTrackList walks every filesystem search path; remap_track shifts
// xatrix/rogue's mission-pack CD track numbers onto the remaster's shared
// baseq2 track set). This exercises the two pieces of that fix that are
// pure and don't need a real Vorbis file or libvorbisfile loaded:
// CDAudio_TestRemapTrack (ogg.c:192-205's remap_track) and
// CDAudio_TestBuildTrackCandidates (the FS_NextPath-driven candidate list
// that replaced the single-gamedir-only lookup).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_Set } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_SetGamedir } from "../src/qcommon/files";
import { cl } from "../src/client/client";
import { CDAudio_Init, CDAudio_TestResetRegistration, CDAudio_TestRemapTrack, CDAudio_TestBuildTrackCandidates } from "../src/platform/cd_ogg";

describe("cd_ogg.ts -- xatrix/rogue track remap and cross-searchpath music lookup", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2music-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    mkdirSync(join(tmpRoot, "xatrix"));
    mkdirSync(join(tmpRoot, "rogue"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // re-register cd_nocd/ogg_* (including ogg_remap_tracks) fresh for each
    // test -- see CDAudio_TestResetRegistration's own doc comment.
    CDAudio_TestResetRegistration();
    CDAudio_Init();
    // Cvar_Get on an already-registered cvar returns the existing object
    // without resetting its value, so a value change in one test (see the
    // "ogg_remap_tracks 0" test below) would otherwise leak into every
    // later test in this file -- pin it back to the default explicitly.
    Cvar_Set("ogg_remap_tracks", "1");
    FS_SetGamedir("");
    cl.gamedir = "";
  });

  test("tracks outside 2-11 are never remapped, in any gamedir", () => {
    cl.gamedir = "rogue";
    expect(CDAudio_TestRemapTrack(1)).toBe(1);
    expect(CDAudio_TestRemapTrack(12)).toBe(12);
    cl.gamedir = "xatrix";
    expect(CDAudio_TestRemapTrack(1)).toBe(1);
    expect(CDAudio_TestRemapTrack(12)).toBe(12);
  });

  test("baseq2 (no mission-pack gamedir) leaves tracks 2-11 unchanged", () => {
    cl.gamedir = "";
    for (let t = 2; t <= 11; t++) expect(CDAudio_TestRemapTrack(t)).toBe(t);
  });

  test("rogue shifts tracks 2-11 by +10 (ogg.c:196)", () => {
    cl.gamedir = "rogue";
    expect(CDAudio_TestRemapTrack(2)).toBe(12);
    expect(CDAudio_TestRemapTrack(11)).toBe(21);
  });

  test("xatrix remaps through the non-contiguous lookup table (ogg.c:199)", () => {
    cl.gamedir = "xatrix";
    const expected = [9, 13, 14, 7, 16, 2, 15, 3, 4, 18];
    for (let t = 2; t <= 11; t++) expect(CDAudio_TestRemapTrack(t)).toBe(expected[t - 2]);
  });

  test("gamedir comparison is case-insensitive", () => {
    cl.gamedir = "ROGUE";
    expect(CDAudio_TestRemapTrack(2)).toBe(12);
  });

  test("ogg_remap_tracks 0 disables the remap", () => {
    cl.gamedir = "rogue";
    Cvar_Set("ogg_remap_tracks", "0");
    expect(CDAudio_TestRemapTrack(2)).toBe(2);
  });

  test("candidate list includes both NN.ogg and trackNN.ogg under the active gamedir", () => {
    FS_SetGamedir("xatrix");
    cl.gamedir = "xatrix";
    // track 2 remaps to 09 under xatrix (first entry of the lookup table)
    const candidates = CDAudio_TestBuildTrackCandidates(2);
    const xatrixDir = join(tmpRoot, "xatrix").replaceAll("\\", "/");
    expect(candidates).toContain(`${xatrixDir}/music/09.ogg`);
    expect(candidates).toContain(`${xatrixDir}/music/track09.ogg`);
  });

  test("candidate list also searches baseq2, not just the active mod gamedir", () => {
    FS_SetGamedir("rogue");
    cl.gamedir = "rogue";
    // track 2 remaps to 12 under rogue
    const candidates = CDAudio_TestBuildTrackCandidates(2);
    const baseDir = join(tmpRoot, "baseq2").replaceAll("\\", "/");
    expect(candidates).toContain(`${baseDir}/music/12.ogg`);
    expect(candidates).toContain(`${baseDir}/music/track12.ogg`);
  });

  test("un-remapped baseq2 lookup still searches baseq2 for the raw track number", () => {
    FS_SetGamedir("");
    cl.gamedir = "";
    const candidates = CDAudio_TestBuildTrackCandidates(5);
    const baseDir = join(tmpRoot, "baseq2").replaceAll("\\", "/");
    expect(candidates).toContain(`${baseDir}/music/05.ogg`);
    expect(candidates).toContain(`${baseDir}/music/track05.ogg`);
  });
});
