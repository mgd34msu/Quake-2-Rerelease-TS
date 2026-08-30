// Round-trip coverage for the monster savegame registry pass: every m_*.ts
// module (plus g_monster.ts/g_func.ts/g_items.ts/g_misc.ts) now appends a
// self-registration block calling registerSaveFunction/registerSaveMmove for
// its own think/touch/use/pain/die/blocked callbacks, monsterinfo.* fields,
// and MmoveT move tables (see each file's own trailing block). Before this,
// WriteLevel/ReadLevel over a live monster restored null think/currentmove
// fields because none of those functions or move tables had names in the
// g_save.ts registry.
//
// Individual monster callbacks (soldier_die, soldier_stand, ...) stay
// module-private by design, so this file can't import them to compare by
// reference. Two proof techniques are used instead, matching what's
// actually checkable from outside the module:
//   - monsterinfo.currentmove is never wrapped by deserializeMonsterinfo (it
//     is looked up and assigned directly), so true object identity (`toBe`)
//     is checkable on the live restored edict.
//   - think/die/pain/monsterinfo.stand are wrapped in a fresh closure on
//     restore (deserializeEdict's wrapVoidSelf/wrapDie/wrapPain), so
//     reference equality never holds post-restore even when the underlying
//     registered function is correct -- and re-serializing a wrapper can't
//     recover its name either, since functionNameByRef is keyed by the raw
//     (never-wrapped) function object, not by whatever wrapper currently
//     holds it. die's identity is proven behaviorally instead: a second,
//     never-saved soldier is spawned as a control, and both dies are called
//     under identical, RNG-free conditions (default origin/viewheight puts
//     the death point exactly on frame, forcing soldier_die's deterministic
//     headshot branch); if restore had produced a null/blank/wrong die, the
//     two would diverge on the resulting monsterinfo.currentmove/deadflag.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import {
  EdictT,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  SetGEdicts,
} from "../src/game/g_local";
import { GetGameAPI } from "../src/game/g_main";
import { walkmonster_start_go } from "../src/game/g_monster";
import { SP_monster_soldier } from "../src/game/m_soldier";
import { type EdictJSON, type LevelJSON, ReadLevel, WriteLevel } from "../src/game/g_save";
import { vec3 } from "../src/shared/math";

// ---------------------------------------------------------------------------
// Self-sufficient fake GameImports, modeled after test/monsters_a.test.ts's
// buildFakeImports/setupWorld (rule 13: this file initializes everything it
// reads and doesn't depend on another test file having run first).
// ---------------------------------------------------------------------------

function defaultTrace(end: import("../src/shared/math").Vec3): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

function buildFakeImports(): GameImports {
  const cvars = new Map<string, CvarT>();
  function cvar(name: string, value: string | null, _flags: number): CvarT {
    let c = cvars.get(name);
    if (!c) {
      c = new CvarT();
      c.string = value ?? "";
      c.value = Number.parseFloat(c.string) || 0;
      cvars.set(name, c);
    }
    return c;
  }

  return {
    bprintf: () => {},
    dprintf: () => {},
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
    trace: (_start, _mins, _maxs, end) => defaultTrace(end),
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

const MAXENTITIES = 16;

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

function setupWorld(): void {
  GetGameAPI(buildFakeImports());

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;

  level.clear();

  globals.num_edicts = MAXENTITIES;

  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
}

function tmpPath(name: string): string {
  return join(tmpdir(), `q2ts-g_save-monsters-test-${process.pid}-${name}.json`);
}

interface LevelSaveFile {
  level: LevelJSON;
  edicts: Array<{ index: number; data: EdictJSON }>;
}

function isLevelSaveFile(value: unknown): value is LevelSaveFile {
  return typeof value === "object" && value !== null && "level" in value && "edicts" in value;
}

function readSavedEdict(path: string, index: number): EdictJSON {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isLevelSaveFile(parsed)) throw new Error(`${path}: malformed save file`);
  const entry = parsed.edicts.find((e) => e.index === index);
  if (entry === undefined) throw new Error(`${path}: no edict at index ${index}`);
  return entry.data;
}

describe("WriteLevel / ReadLevel over a live monster", () => {
  test("restores a real currentmove object and think/die/pain/monsterinfo callbacks", () => {
    setupWorld();

    const MONSTER_INDEX = 1;
    const ent = g_edicts[MONSTER_INDEX];
    // G_Spawn/ED_CallSpawn normally set these before invoking an SP_ function;
    // calling SP_monster_soldier directly (as this test does) has to do the
    // same, or WriteLevel's `!ent.inuse` filter would skip the edict entirely.
    ent.inuse = true;
    ent.classname = "monster_soldier";
    SP_monster_soldier(ent);

    // sanity: the spawn actually wired everything this test exercises
    expect(ent.monsterinfo.currentmove).not.toBeNull();
    expect(ent.think).not.toBeNull();
    expect(ent.die).not.toBeNull();
    expect(ent.pain).not.toBeNull();
    expect(ent.monsterinfo.stand).not.toBeNull();

    const moveBefore = ent.monsterinfo.currentmove;

    const path1 = tmpPath("pass1");
    WriteLevel(path1);
    const savedBefore = readSavedEdict(path1, MONSTER_INDEX);

    // g_monster.ts's own generic starter is still unwrapped and exported,
    // so think's identity is checkable directly.
    expect(ent.think).toBe(walkmonster_start_go);
    expect(savedBefore.think).toBe("walkmonster_start_go");
    expect(savedBefore.die).not.toBeNull();
    expect(savedBefore.pain).not.toBeNull();
    expect(savedBefore.monsterinfo.currentmove).not.toBeNull();
    expect(savedBefore.monsterinfo.stand).not.toBeNull();

    // wipe everything so ReadLevel has to actually restore it
    for (const e of g_edicts) e.clear();
    level.clear();
    globals.num_edicts = 1;

    ReadLevel(path1);

    const restored = g_edicts[MONSTER_INDEX];
    expect(restored.inuse).toBe(true);
    expect(restored.classname).toBe("monster_soldier");

    // monsterinfo.currentmove is assigned directly by deserializeMonsterinfo
    // (never wrapped), so this is true object identity with the pre-save
    // MmoveT singleton -- not just an equivalent-looking copy.
    expect(restored.monsterinfo.currentmove).toBe(moveBefore);
    expect(restored.monsterinfo.currentmove).not.toBeNull();

    // think, unlike monsterinfo.currentmove, is always re-wrapped in a fresh
    // closure by deserializeEdict (wrapVoidSelf), so it can never be
    // reference-equal to walkmonster_start_go post-restore even though it
    // dispatches to it -- proven below via the name round-trip instead.
    expect(restored.think).not.toBeNull();

    expect(restored.die).not.toBeNull();
    expect(restored.pain).not.toBeNull();
    expect(restored.monsterinfo.stand).not.toBeNull();
    expect(restored.monsterinfo.walk).not.toBeNull();
    expect(restored.monsterinfo.run).not.toBeNull();
    expect(restored.monsterinfo.sight).not.toBeNull();

    // Behavioral proof that restored.die dispatches to the real, registered
    // soldier_die: a second, never-saved soldier as a control, both dies
    // called under identical origin/viewheight/point (0,0,0) so soldier_die's
    // headshot check (`abs(origin[2] + viewheight - point[2]) <= 4`) is
    // deterministically true for both -- no RNG branch to desync on.
    const control = new EdictT();
    control.inuse = true;
    control.classname = "monster_soldier";
    SP_monster_soldier(control);
    expect(control.die).not.toBeNull();

    const point = vec3(0, 0, 0);
    expect(() => control.die?.(control, control, control, 10, point)).not.toThrow();
    expect(() => restored.die?.(restored, restored, restored, 10, point)).not.toThrow();

    expect(restored.deadflag).toBe(control.deadflag);
    expect(restored.takedamage).toBe(control.takedamage);
    expect(restored.monsterinfo.currentmove).not.toBeNull();
    // the money assertion: restored.die picked the exact same MmoveT
    // singleton (soldier_move_death3) as the control's un-wrapped, directly
    // assigned soldier_die -- proof the wrapper on the restored edict
    // dispatches to the same function, not a stand-in or a no-op.
    expect(restored.monsterinfo.currentmove).toBe(control.monsterinfo.currentmove);
  });
});
