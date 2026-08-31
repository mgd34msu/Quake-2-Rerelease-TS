// Shared test seam for a test that boots the real engine with throwaway,
// test-specific cvar overrides (a synthetic basedir, "+set s_initsound 0"
// to skip real audio, etc.) and must leave no trace in src/qcommon/
// cvar.ts's cvar_vars registry afterward.
//
// cvar_vars is a process-wide singleton Map<string, CvarT> that persists
// for the whole `bun test` run (see files.ts's FS_TestSnapshotSearchPaths
// header comment for the same shape of problem on the FS side). Cvar_Get's
// contract (src/qcommon/cvar.ts) is "first registration wins the default,
// every later call just ORs in flags" -- so if a test's own throwaway
// "+set X Y" argv is the FIRST thing in the whole process to ever touch
// cvar "X", it permanently fixes X's default_string at Y, even after the
// test that caused it finishes and even though the real code's own,
// correct `Cvar_Get("X", realDefault, flags)` call site runs moments
// later (existing found -> only flags get OR'd in, default_string is
// untouched). No later Cvar_ForceSet can repair this: Cvar_Set2 only ever
// writes `.string`/`.value`, never `.default_string`.
//
// Use ONLY for tests whose own boot is entirely throwaway/synthetic (a
// disposable tmpRoot basedir, deliberately-wrong test-only overrides like
// s_initsound=0 or allow_download=0) -- NOT for a test like
// test/cvar_parity.test.ts whose whole purpose is establishing correct,
// real ambient cvar state that other test files' own "whichever boot ran
// first" assumptions rely on afterward (vid_modes.test.ts's own header
// comment documents that reliance). Wiping cvar_vars after a legitimate
// first-mover breaks those other files; wiping it after a throwaway
// synthetic boot is always safe, since nothing else should want that
// boot's leftovers to persist.
import { cvar_vars } from "../../src/qcommon/cvar";

interface CvarFieldsSnapshotT {
  readonly string: string;
  readonly default_string: string;
  readonly latched_string: string | null;
  readonly flags: number;
  readonly modified: boolean;
  readonly value: number;
}

export type CvarSnapshotT = Map<string, CvarFieldsSnapshotT>;

// Call BEFORE any mutation the test is about to make (Cvar_ForceSet calls
// included) -- a snapshot taken even one mutation too late bakes that
// mutation in as the "restored" state.
export function snapshotCvars(): CvarSnapshotT {
  const snap = new Map<string, CvarFieldsSnapshotT>();
  for (const [name, v] of cvar_vars) {
    snap.set(name, {
      string: v.string,
      default_string: v.default_string,
      latched_string: v.latched_string,
      flags: v.flags,
      modified: v.modified,
      value: v.value,
    });
  }
  return snap;
}

export function restoreCvars(snap: CvarSnapshotT): void {
  // Drop every cvar this test's boot registered for the first time.
  for (const name of Array.from(cvar_vars.keys())) {
    if (!snap.has(name)) cvar_vars.delete(name);
  }
  // Restore every pre-existing cvar's mutable fields IN PLACE (not by
  // replacing the object) so any other module's already-captured CvarT
  // reference (e.g. src/qcommon/common.ts's `dedicated`, src/qcommon/
  // files.ts's `fs_basedir`/`fs_content_root`) sees the restored values
  // too, without needing that module to re-run Cvar_Get first.
  for (const [name, fields] of snap) {
    const v = cvar_vars.get(name);
    if (!v) continue; // pre-existing entries are never deleted above
    v.string = fields.string;
    v.default_string = fields.default_string;
    v.latched_string = fields.latched_string;
    v.flags = fields.flags;
    v.modified = fields.modified;
    v.value = fields.value;
  }
}
