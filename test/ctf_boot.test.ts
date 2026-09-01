// Runtime game-track selection (src/server/sv_game.ts's SV_InitGameProgs) and
// the ctf track's own InitGame/GetGameAPI. Self-sufficient per
// PORTING.md/preferences.md rule 13: every global this suite reads is set up
// here, and the real qcommon cvar registry (src/qcommon/cvar.ts's
// `cvar_vars`) is snapshotted/restored around the suite since
// SV_InitGameProgs builds its GameImports from the real Cvar_Get/Cvar_Set,
// not an injectable fake.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import type { GameImports as CtfGameImports, GTraceT as CtfGTraceT } from "../src/ctf/game";
import { GAME_API_VERSION } from "../src/ctf/game";
import { GetGameAPI as CtfGetGameAPI } from "../src/ctf/g_main";
import { InitGame as CtfInitGame } from "../src/ctf/g_save";
import { cvar_vars, Cvar_Get, Cvar_Set, Cvar_VariableString } from "../src/qcommon/cvar";
import { geHolder, SV_InitGameProgs } from "../src/server/sv_game";
import { GetGameAPI as BaseGetGameAPI } from "../src/game/g_main";
import { InitGame as BaseInitGame } from "../src/game/g_save";

// ---------------------------------------------------------------------------
// Fake ctf GameImports -- modeled on test/g_save.test.ts's buildFakeImports:
// a real per-name cvar registry (Map<string, CvarT>) so InitGame's repeated
// gi.cvar()/gi.cvar_set() calls behave like the real engine's idempotent
// Cvar_Get, plus a recorder for which cvar names got registered.
// ---------------------------------------------------------------------------

interface Recorder {
  dprintf: string[];
  cvarNames: string[];
}

function makeRecorder(): Recorder {
  return { dprintf: [], cvarNames: [] };
}

function buildFakeCtfImports(rec: Recorder): CtfGameImports {
  const trace: CtfGTraceT = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };

  const cvars = new Map<string, CvarT>();
  function cvar(name: string, value: string | null, _flags: number): CvarT {
    let c = cvars.get(name);
    if (!c) {
      c = new CvarT();
      c.string = value ?? "";
      c.value = Number.parseFloat(c.string) || 0;
      cvars.set(name, c);
      rec.cvarNames.push(name);
    }
    return c;
  }

  return {
    bprintf: () => {},
    dprintf: (fmt: string) => {
      rec.dprintf.push(fmt);
    },
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 0,
    soundindex: () => 0,
    imageindex: () => 0,
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
    cvar,
    cvar_set: (var_name: string, value: string) => cvar(var_name, value, 0),
    cvar_forceset: (var_name: string, value: string) => cvar(var_name, value, 0),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

// ---------------------------------------------------------------------------
// ctf InitGame / GetGameAPI, exercised directly against a fake GameImports
// (no real server/qcommon involvement).
// ---------------------------------------------------------------------------

describe("ctf InitGame", () => {
  test("registers capturelimit and the ctf-only \"ctf\" cvar (CTFInit)", () => {
    const rec = makeRecorder();
    CtfGetGameAPI(buildFakeCtfImports(rec));

    CtfInitGame();

    expect(rec.dprintf).toContain("==== InitGame ====\n");
    expect(rec.cvarNames).toContain("capturelimit");
    expect(rec.cvarNames).toContain("instantweap");
    // CTFInit() (g_ctf.ts) is the only place "ctf" itself gets registered --
    // its presence proves InitGame's `//ZOID CTFInit(); //ZOID` call ran.
    expect(rec.cvarNames).toContain("ctf");
  });
});

describe("ctf GetGameAPI", () => {
  test("returns exports whose Init is g_save.ts's real InitGame (function identity)", () => {
    const rec = makeRecorder();
    const ge = CtfGetGameAPI(buildFakeCtfImports(rec));

    expect(ge.apiversion).toBe(GAME_API_VERSION);
    expect(ge.Init).toBe(CtfInitGame);
  });
});

// ---------------------------------------------------------------------------
// SV_InitGameProgs runtime selection: builds its own GameImports from the
// real qcommon Cvar_Get/Cvar_Set, so these tests drive it through the real
// "game" cvar rather than an injectable fake. `cvar_vars` (the process-wide
// cvar registry both game tracks' `gi.cvar()` ultimately reach through
// SV_InitGameProgs's real `cvar: Cvar_Get` wiring) is snapshotted before each
// test and restored after the whole suite, per preferences.md rule 13's
// "reset cvars around the test" -- each test gets InitGame's ~40 cvar
// registrations run from a clean slate instead of accreting across cases or
// leaking into other test files that share this same process-wide registry.
// ---------------------------------------------------------------------------

describe("SV_InitGameProgs runtime game-track selection", () => {
  // rule 13/21 (regate hygiene, found 2026-09-01 chasing the cgame/host.ts
  // kfont-dispatch trio's in-suite-only failures): this used to capture
  // `savedCvars` inline in the describe body, which bun:test evaluates
  // during COLLECTION -- before any file's own beforeEach/test bodies have
  // run, i.e. essentially at the start of the whole `bun test` process. Any
  // cvar a DIFFERENT module registers later, during real test execution
  // (e.g. src/client/cgame/host.ts's `cl_kfont_source`/`cl_kfont_ttf_size`,
  // cached in a module-level `let` the first time any cgame test touches
  // them), was invisible to that too-early snapshot. This describe's own
  // afterAll then did `cvar_vars.clear()` followed by re-inserting ONLY the
  // snapshotted entries -- permanently dropping any cvar registered after
  // collection but before this suite ran, even though host.ts's cached
  // reference to that now-orphaned CvarT object lives on: Cvar_ForceSet
  // against the NEW object bun creates on next use never reaches it again,
  // so ensureActiveKfont() keeps reading whatever `.string` the orphaned
  // object had at the moment of the wipe, forever. Confirmed as the root
  // cause of test/cgame_host_kfont_source.test.ts's "classic"/"switching"/
  // "ttf:<name> missing" cases all reading back the stale already-loaded
  // "kfont" width (10) instead of their own just-forced source, but ONLY in
  // full-suite runs where this file executes first (isolated/small-group
  // runs never hit it, since nothing else had registered those cvars yet
  // to be dropped). Restoring the SAME object references (this file's
  // Map(cvar_vars) copy is a copy of the MAP, not the CvarT values inside
  // it) is correct and sufficient -- the only bug was snapshotting too
  // early. Moving the snapshot into beforeAll (real execution time for
  // this describe, not collection time) fixes it: everything any
  // earlier-executing file already registered by the time these
  // destructive tests actually start is now captured and correctly
  // restored, object identity intact, for whichever module cached it.
  let savedCvars: Map<string, CvarT>;

  beforeAll(() => {
    savedCvars = new Map(cvar_vars);
  });

  beforeEach(() => {
    cvar_vars.clear();
  });

  afterAll(() => {
    cvar_vars.clear();
    for (const [name, value] of savedCvars) cvar_vars.set(name, value);
  });

  test('Cvar "game" = "ctf" populates geHolder.ge with the ctf variant', () => {
    Cvar_Get("game", "", 0);
    Cvar_Set("game", "ctf");

    expect(() => SV_InitGameProgs()).not.toThrow();

    expect(geHolder.ge).not.toBeNull();
    expect(geHolder.ge?.apiversion).toBe(GAME_API_VERSION);
    // The ctf branch is bridged through sv_game.ts's adaptCtfGameExports, so
    // geHolder.ge.Init is a wrapper closure, not CtfInitGame itself --
    // identity is asserted at the GetGameAPI level above instead. Here, the
    // ctf-only "ctf" cvar (registered by CTFInit(), called from g_save.ts's
    // InitGame) is the symbol that proves the ctf variant's Init actually
    // ran, per this unit's brief.
    expect(cvar_vars.has("ctf")).toBe(true);
    expect(cvar_vars.has("capturelimit")).toBe(true);
  });

  test('Cvar "game" unset selects the base game (no ctf-only cvars registered)', () => {
    expect(() => SV_InitGameProgs()).not.toThrow();

    expect(geHolder.ge).not.toBeNull();
    expect(geHolder.ge?.apiversion).toBe(GAME_API_VERSION);
    // Base track's GameExports is returned unwrapped (no adapter), so
    // function identity against the real, statically-imported BaseInitGame
    // is a direct, exact check.
    expect(geHolder.ge?.Init).toBe(BaseInitGame);
    expect(cvar_vars.has("ctf")).toBe(false);
    expect(cvar_vars.has("capturelimit")).toBe(false);
  });

  test('Cvar "game" = "baseq2" also selects the base game', () => {
    Cvar_Get("game", "", 0);
    Cvar_Set("game", "baseq2");

    expect(() => SV_InitGameProgs()).not.toThrow();

    expect(geHolder.ge?.Init).toBe(BaseInitGame);
    expect(Cvar_VariableString("game")).toBe("baseq2");
    expect(cvar_vars.has("ctf")).toBe(false);
  });
});

// Sanity: the base track's own GetGameAPI/InitGame are unaffected by any of
// the above -- calling it directly still returns the same real InitGame
// reference SV_InitGameProgs's base branch uses.
describe("base GetGameAPI (unaffected by ctf selection)", () => {
  test("Init is the real, statically-imported InitGame", () => {
    const rec = makeRecorder();
    const ge = BaseGetGameAPI(buildFakeCtfImports(rec));
    expect(ge.Init).toBe(BaseInitGame);
  });
});
