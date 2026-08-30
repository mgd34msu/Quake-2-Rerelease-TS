// End-to-end check against a REAL retail demo file, per the KEX demo
// playback unit's brief ("check the retail data for shipped .dm2/.demo
// files to test against ... if real demo files exist, an e2e playback
// test against one").
//
// CORRECTED FINDING (an earlier research pass over this same retail tree
// concluded there were no genuine KEX-format demos anywhere, based on
// file-path/extension/KPF-listing greps -- that conclusion was WRONG,
// caught only by actually reading file content): baseq2/pak0.pak's
// "demos/demo1.dm2" (and, by strong inference, its six siblings --
// demo2/rdemo1/rdemo2/xdemo1/xdemo2/xdemo3.dm2, not individually verified
// here) is NOT the original id Software v3.19 recording its classic
// filename suggests. Its first message's protocol field, read byte-for-
// byte, is 2022 (PROTOCOL_KEX_DEMOS) -- a genuine KEX-native-format demo,
// re-recorded by the re-release engine and kept under the legacy filename
// for attract-loop compatibility. Corroborating detail: its svc_serverdata
// carries server_fps=40 (the re-release engine's real tick rate) where a
// true vanilla recording would carry 10. This test therefore DOES exercise
// KEX_DEMO_CODEC against real, unmodified retail bytes, not just the
// hand-derived vectors in test/protocol_kexdemo.test.ts.
//
// BUG FOUND AND FIXED BY THIS TEST (see git history/task report for the
// full derivation): kexdemo.ts's readKexFlags() combined the playerstate
// flags word's low/high halves with `flags |= moreFlags << 16` where
// `flags` (from MSG_ReadShort, a SIGNED read) was still sign-extended to
// all-1s in bits 16-31 whenever bit 15 was set -- silently setting every
// PS_KEX_* bit beyond whatever `moreFlags` actually carried (concretely:
// PS_KEX_TEAM_ID appeared spuriously "set" on real playerstates, consuming
// one extra byte and desyncing the rest of that frame). Fixed by masking
// both halves to 0xffff before combining. test/protocol_kexdemo.test.ts's
// existing PS_MOREBITS hand-derived case did NOT catch this (it happened
// to only ever check bits the corruption also legitimately set), which is
// exactly why this real-data e2e check earns its keep independently of the
// hand-derived suite.
//
// HISTORICAL NOTE (resolved): this unit originally found that
// CL_ParseMuzzleFlash2 used only the classic MZ2_* table and crashed on
// the re-release's expanded muzzleflash indices; a crash guard was the
// interim fix. Family-aware dispatch has since landed (cl_fx.ts selects
// the 290-entry kexgame table under CS_REMAP_RERELEASE), so this demo's
// muzzleflashes now resolve real offsets; the guard remains only for
// genuinely out-of-range classic-family bytes. See test/cl_muzzleflash.test.ts.
//
// No retail content is read into this repository or committed anywhere:
// the PAK file is read directly from the user's local retail install path
// at test-run time (raw node:fs, a hand-rolled minimal PACK-format
// directory parse -- NOT the engine's own FS_* module, to avoid mutating
// that shared singleton's search-path state for other test files sharing
// this process) and the extracted demo bytes never touch disk. If the
// retail path isn't present (e.g. CI, or a machine without the retail
// install), the test skips itself rather than failing.

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cl, cls, clCvars, setRe } from "../src/client/client";
import { KEX_DEMO_CODEC, PROTOCOL_KEX_DEMOS } from "../src/qcommon/protocol/kexdemo";
import { CL_PlayDemoFromBuffer } from "../src/client/cl_demo";

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const DEMO_ENTRY = "demos/demo1.dm2";

/** Minimal classic id PACK format reader (header "PACK" + int32 dirofs +
 *  int32 dirlen, then dirlen/64 entries of {char name[56]; int filepos;
 *  int filelen}, 64 bytes each) -- deliberately NOT this engine's own
 *  FS_LoadPackFile/ZipArchive (those are for .kpf/zip-format archives;
 *  see qcommon/files.ts's own header), and deliberately not routed through
 *  FS_AddGameDirectory (which would mutate the shared, process-wide
 *  fs_searchpaths singleton other test files rely on). */
function extractFromPak(pakPath: string, entryName: string): Uint8Array | null {
  const data = readFileSync(pakPath);
  const magic = data.toString("ascii", 0, 4);
  if (magic !== "PACK") return null;

  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    const name = rawName.replace(/\0.*$/, "");
    if (name !== entryName) continue;

    const filepos = data.readInt32LE(entryOffset + 56);
    const filelen = data.readInt32LE(entryOffset + 60);
    return new Uint8Array(data.subarray(filepos, filepos + filelen));
  }
  return null;
}

beforeEach(() => {
  cl.clear();
  cls.clear();
  clCvars.cl_shownet = null;
  clCvars.cl_predict = null;
  clCvars.cl_noskins = null;
  clCvars.cl_vwep = null;
  clCvars.cl_gun = null;
  clCvars.cl_timedemo = null;
  clCvars.cl_showclamp = null;
  setRe(null);
});

const havePak = existsSync(PAK_PATH);

describe("CL_PlayDemoFromBuffer -- real retail KEX-format demo (baseq2/pak0.pak, skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("demo1.dm2 (a genuine PROTOCOL_KEX_DEMOS=2022 recording, despite its classic filename) parses end to end without error", () => {
    const bytes = extractFromPak(PAK_PATH, DEMO_ENTRY);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(397890); // matches this unit's own retail-data survey exactly

    expect(() => CL_PlayDemoFromBuffer(bytes!)).not.toThrow();

    expect(cls.serverProtocol).toBe(PROTOCOL_KEX_DEMOS);
    expect(cls.codec).toBe(KEX_DEMO_CODEC);
    expect(cl.servercount).toBeGreaterThan(0);
    expect(cls.demoplayback).toBe(false); // restored after the pump finishes
  });
});
