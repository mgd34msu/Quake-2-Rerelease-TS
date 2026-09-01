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
// comment documents that reliance).
//
// restoreCvars()'s second argument controls whether cvars the boot
// registered for the first time get deleted afterward (rule 13/21 fix,
// 2026-09-01 regate hygiene pass -- this used to be unconditional deletion
// with no way to opt out). Two real, opposite hazards are both documented
// here because both were observed breaking a real test:
//
//   deleteNewlyRegistered: true (the default -- matches every one of this
//   helper's callers except one at the time of this fix) is correct for a
//   DEDICATED (or non-rendering, narrow-fixture) boot: client-only
//   subsystems that might cache a CvarT reference in a module-level
//   variable (src/client/cl_view.ts, src/client/cgame/host.ts, ...) never
//   run on a dedicated boot or a narrow fixture that skips Qcommon_Init
//   entirely, so nothing can be left holding a stale reference to a
//   deleted cvar. Needed because a dedicated boot pointed at a REAL
//   basedir/content_root unconditionally execs a real user's config.cfg
//   (matching q2repro exactly), which can create ANY client-only cvar
//   fresh with that real, machine-specific saved value baked in as its
//   permanent default_string -- observed breaking test/cvar_parity.test
//   .ts's manifest audit ("crosshair: expected 3, got 1", "name: expected
//   unnamed, got tester") when a dedicated/narrow boot's own leftover
//   registration was left in place.
//
//   deleteNewlyRegistered: false is required for a REAL, full CLIENT boot
//   (dedicated 0) where client subsystems genuinely run and may lazily
//   register a cvar the FIRST time some cgame/draw function is reached
//   (e.g. host.ts's cl_kfont_source, cached in a module-level `let` guarded
//   by `if (!cached) cached = Cvar_Get(...)`, the same idiom several
//   modules in this codebase use). Deleting that registration afterward
//   does not un-cache the reference other code already holds -- it just
//   makes the module's cached CvarT object a dangling orphan, invisible to
//   every later Cvar_Get/Cvar_ForceSet against the freshly-recreated
//   object under the same map key. Confirmed root cause of test/cgame_host
//   _kfont_source.test.ts's "classic"/"switching"/"ttf:<name> missing"
//   trio all reading back a stale, frozen "kfont" value in full-suite runs,
//   traced to test/sdl_platform.test.ts's "windowed client boot with
//   dedicated 0" describe block (a REAL src/main.ts boot that runs real
//   client subsystems, not a narrow fixture) -- that describe block is the
//   one caller that must pass deleteNewlyRegistered: false.
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

export function restoreCvars(snap: CvarSnapshotT, deleteNewlyRegistered = true, preserve: readonly string[] = []): void {
  if (deleteNewlyRegistered) {
    // Drop every cvar this test's boot registered for the first time --
    // safe exactly when nothing running during this boot could have
    // cached a reference to it (see this file's header comment). `preserve`
    // is the escape hatch for a boot that is MOSTLY safe to sweep this way
    // but does run specific real client subsystems known to cache a
    // reference to specific named cvars (test/sdl_platform.test.ts's
    // "windowed client boot" passes ["cl_kfont_source", "cl_kfont_ttf_size"]
    // for exactly this reason) -- an enumerated list, not a blanket
    // false, so this boot's OWN throwaway overrides (allow_download,
    // s_initsound, ...) still get cleaned up.
    const keep = new Set(preserve);
    for (const name of Array.from(cvar_vars.keys())) {
      if (!snap.has(name) && !keep.has(name)) cvar_vars.delete(name);
    }
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
