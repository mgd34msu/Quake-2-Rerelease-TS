/*
Unit tests for the rogue (Ground Zero) game track's boot path: GetGameAPI,
InitGame's cvar registration, the itemlist[] table length, and the
spawns[] registry entry count -- both counted by hand against the C
source (rogue/g_items.c's `gitem_t itemlist[]` and rogue/g_spawn.c's
`spawn_t spawns[]`).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file
calls GetGameAPI(fakeImports) itself and never relies on another test file
having run first. Modeled after test/ctf_boot.test.ts's fake-GameImports
pattern (a real per-name cvar registry so InitGame's repeated
gi.cvar()/gi.cvar_set() calls behave like the real engine's idempotent
Cvar_Get).
*/

import { describe, expect, test } from "bun:test";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import type { GameImports, GTraceT } from "../src/rogue/game";
import { GAME_API_VERSION } from "../src/rogue/game";
import { GetGameAPI } from "../src/rogue/g_main";
import { InitGame } from "../src/rogue/g_save";
import { itemlist } from "../src/rogue/g_items";
import { spawnRegistry } from "../src/rogue/g_spawn";

// ---------------------------------------------------------------------------
// Fake rogue GameImports -- a real per-name cvar registry (Map<string,
// CvarT>) so InitGame's repeated gi.cvar()/gi.cvar_set() calls behave like
// the real engine's idempotent Cvar_Get, plus a recorder for which cvar
// names got registered and what InitGame printed.
// ---------------------------------------------------------------------------

interface Recorder {
  dprintf: string[];
  cvarNames: string[];
}

function makeRecorder(): Recorder {
  return { dprintf: [], cvarNames: [] };
}

function buildFakeRogueImports(rec: Recorder): GameImports {
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
// GetGameAPI / InitGame, exercised directly against a fake GameImports (no
// real server/qcommon involvement -- this unit's SCOPE does not include
// sv_game.ts's runtime game-track selection).
// ---------------------------------------------------------------------------

describe("rogue GetGameAPI", () => {
  test("returns exports whose apiversion matches game.ts's GAME_API_VERSION and Init is g_save.ts's real InitGame (function identity)", () => {
    const rec = makeRecorder();
    const ge = GetGameAPI(buildFakeRogueImports(rec));

    expect(ge.apiversion).toBe(GAME_API_VERSION);
    expect(ge.Init).toBe(InitGame);
  });

  test("edicts/num_edicts/max_edicts start at their zero-initialized-struct equivalents", () => {
    const rec = makeRecorder();
    const ge = GetGameAPI(buildFakeRogueImports(rec));

    expect(ge.edicts).toEqual([]);
    expect(ge.num_edicts).toBe(0);
    expect(ge.max_edicts).toBe(0);
  });
});

describe("rogue InitGame", () => {
  test('prints "==== InitGame ====" and registers the pack\'s new cvars (sv_stopspeed, g_showlogic, gamerules, huntercam, strong_mines, randomrespawn)', () => {
    const rec = makeRecorder();
    GetGameAPI(buildFakeRogueImports(rec));

    InitGame();

    expect(rec.dprintf).toContain("==== InitGame ====\n");
    expect(rec.cvarNames).toContain("sv_stopspeed");
    expect(rec.cvarNames).toContain("g_showlogic");
    expect(rec.cvarNames).toContain("gamerules");
    expect(rec.cvarNames).toContain("huntercam");
    expect(rec.cvarNames).toContain("strong_mines");
    expect(rec.cvarNames).toContain("randomrespawn");
    // rogue/g_local.h drops the `needpass` extern entirely -- no rogue .c
    // file references it (see g_local.ts's gameCvars comment), so InitGame
    // must not register it either.
    expect(rec.cvarNames).not.toContain("needpass");
  });
});

// ---------------------------------------------------------------------------
// itemlist[] / spawns[] table sizes, counted by hand against the C source:
//   rogue/g_items.c's `gitem_t itemlist[]` (index-0 NULL placeholder +
//   61 real items + the trailing `{NULL}` end-of-list marker = 63 entries).
//   Naively grepping for the array's brace pattern over-counts by one:
//   `item_torch`'s entire struct literal (line ~2601-2621) sits inside a
//   *second*, separate `/* ... */` C block comment on top of its own
//   QUAKED docstring comment, so it never actually compiles into the real
//   array -- consistent with g_local.ts's own note that GClientT's
//   `torch_framenum` is commented out in C and was deliberately not
//   ported either.
//   rogue/g_spawn.c's `spawn_t spawns[]` (143 real `{"name", SP_fn}`
//   entries, not counting the `{NULL, NULL}` terminator)
// ---------------------------------------------------------------------------

describe("itemlist[] (g_items.c)", () => {
  test("has 63 entries (index-0 placeholder + real items + end-of-list marker; item_torch is dead code, commented out in the C source)", () => {
    expect(itemlist().length).toBe(63);
  });
});

describe("spawns[] registry (g_spawn.c)", () => {
  test("has 143 entries, matching rogue/g_spawn.c's spawn_t spawns[] table", () => {
    expect(spawnRegistry().length).toBe(143);
  });

  test("includes entries for both sibling units' spawn functions (RG-monsters, RG-systems)", () => {
    const names = spawnRegistry().map((s) => s.name);

    // RG-monsters' pack-only monster files
    expect(names).toContain("monster_stalker");
    expect(names).toContain("monster_turret");
    expect(names).toContain("monster_carrier");
    expect(names).toContain("monster_widow");
    expect(names).toContain("monster_widow2");

    // RG-systems' new-systems files
    expect(names).toContain("func_door_secret2");
    expect(names).toContain("func_force_wall");
    expect(names).toContain("trigger_teleport");
    expect(names).toContain("hint_path");
    expect(names).toContain("dm_tag_token");
    expect(names).toContain("dm_dball_goal");
    expect(names).toContain("target_steam");

    // this unit's own new g_spawn.c-local spawn wrappers
    expect(names).toContain("func_plat2");
    expect(names).toContain("info_player_coop_lava");
    expect(names).toContain("misc_nuke_core");
    expect(names).toContain("turret_invisible_brain");
    expect(names).toContain("monster_kamikaze");

    // "monster_daedalus" reuses SP_monster_hover under a second classname key
    const daedalus = spawnRegistry().find((s) => s.name === "monster_daedalus");
    const hover = spawnRegistry().find((s) => s.name === "monster_hover");
    expect(daedalus).toBeDefined();
    expect(hover).toBeDefined();
    expect(daedalus?.spawn).toBe(hover?.spawn);
  });
});
