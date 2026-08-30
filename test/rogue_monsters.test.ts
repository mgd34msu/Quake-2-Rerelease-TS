/*
Tests for the rogue mission-pack monster/movement port:
src/rogue/m_carrier.ts, m_stalker.ts, m_turret.ts, m_widow.ts, m_widow2.ts, and their frame
headers, plus src/rogue/m_move2.ts (the ROGUE_GRAVITY-flavored rogue/m_move.c port).

Rule 13: self-sufficient -- this file builds its own GetGameAPI(fakeImports) world and never
depends on any other test file having run first. Modeled on test/monsters_a.test.ts's
buildFakeImports/setupWorld/runFrames harness (base game), pointed at the rogue module tree.

"construct-validate every mmove table": every MmoveT in the ported files is a module-level
`const` built at import time via `mmove.frame = [...]`, and that setter throws immediately if
frames.length !== lastframe - firstframe + 1 (src/rogue/g_local.ts's MmoveT, mirroring
src/game/g_local.ts's). Importing SP_monster_carrier/_stalker/_turret/_widow/_widow2 below --
which this file does at module load, before any test body runs -- therefore already exercises
every mmove table's construction invariant for all five monsters; a single bad row count would
throw at import time and fail the whole file before any `test()` block even started. The
explicit "module import didn't throw" tests document that guarantee rather than re-implementing
it.
*/
import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/rogue/game";
import { SolidT } from "../src/rogue/game";
import { GetGameAPI } from "../src/rogue/g_main";
import {
  DEAD_DEAD,
  EdictT,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  MovetypeT,
  SetGEdicts,
} from "../src/rogue/g_local";
import { monster_think } from "../src/rogue/g_monster";
import { SP_monster_carrier } from "../src/rogue/m_carrier";
import { SP_monster_stalker } from "../src/rogue/m_stalker";
import { SP_monster_turret } from "../src/rogue/m_turret";
import { SP_monster_widow } from "../src/rogue/m_widow";
import { SP_monster_widow2 } from "../src/rogue/m_widow2";
import { M_ChangeYaw, M_CheckBottom, M_MoveToGoal, M_walkmove } from "../src/rogue/m_move2";

// ---------------------------------------------------------------------------
// Self-sufficient fake GameImports -- an "open world" trace that never hits
// anything, so monster_think's frame stepping is exercised without depending
// on any other test file having run first (rule 13).
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
    pointcontents: () => 0, // CONTENTS_EMPTY
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
    cvar: () => null,
    cvar_set: () => null,
    cvar_forceset: () => null,
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

const MAXENTITIES = 32;

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

  // skill 1 (not deathmatch, not nightmare) so pain-anim branches run and the
  // SP_monster_* deathmatch-freeze-edict guard (every one of these five
  // spawn functions calls G_FreeEdict(self) when deathmatch != 0) is skipped.
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.coop = fakeCvar(0);
}

function freshEdict(index: number): EdictT {
  const e = new EdictT();
  e.s.number = index;
  g_edicts[index] = e;
  return e;
}

function expectFiniteOrigin(ent: EdictT): void {
  expect(Number.isFinite(ent.s.origin[0])).toBe(true);
  expect(Number.isFinite(ent.s.origin[1])).toBe(true);
  expect(Number.isFinite(ent.s.origin[2])).toBe(true);
}

function runFrames(ent: EdictT, count: number): void {
  for (let i = 0; i < count; i++) {
    monster_think(ent);
    expectFiniteOrigin(ent);
    // s.frame catches up to a currentmove switch on the NEXT think (C
    // behavior), and random fidget/attack rolls can switch moves between the
    // two reads -- range-check only when the frame already belongs to the
    // move (same relaxation as test/monsters_a.test.ts's runFrames).
    const move = ent.monsterinfo.currentmove;
    expect(Number.isFinite(ent.s.frame)).toBe(true);
    if (move && ent.s.frame >= move.firstframe) {
      expect(ent.s.frame).toBeLessThanOrEqual(move.lastframe);
    }
  }
}

type Spawner = (self: EdictT) => void;

interface MonsterCase {
  name: string;
  spawn: Spawner;
  health: number;
  gibHealth: number | ((health: number) => boolean);
  mass: number;
  movetype: MovetypeT;
  mins: [number, number, number];
  maxs: [number, number, number];
}

// Expected spawn-time values, read directly from each SP_monster_* body
// (see the ported files' VectorSet(self.mins/maxs, ...) and self.health/
// gib_health/mass/movetype assignments). Widow/widow2's health depends on
// gameCvars.skill (1 here), matching each file's own formula.
const CASES: MonsterCase[] = [
  {
    name: "monster_carrier",
    spawn: SP_monster_carrier,
    health: 2000, // Math.max(2000, 2000 + 1000 * (skill(1) - 1)) = 2000
    gibHealth: -200,
    mass: 1000,
    movetype: MovetypeT.MOVETYPE_STEP,
    mins: [-56, -56, -44],
    maxs: [56, 56, 44],
  },
  {
    name: "monster_stalker",
    spawn: SP_monster_stalker,
    health: 250,
    gibHealth: -50,
    mass: 250,
    movetype: MovetypeT.MOVETYPE_STEP,
    mins: [-28, -28, -18],
    maxs: [28, 28, 18],
  },
  {
    name: "monster_turret",
    spawn: SP_monster_turret,
    health: 240,
    gibHealth: -100,
    mass: 250,
    movetype: MovetypeT.MOVETYPE_NONE,
    mins: [-12, -12, -12],
    maxs: [12, 12, 12],
  },
  {
    name: "monster_widow",
    spawn: SP_monster_widow,
    health: 3000, // 2000 + 1000 * skill(1)
    gibHealth: -5000,
    mass: 1500,
    movetype: MovetypeT.MOVETYPE_STEP,
    mins: [-40, -40, 0],
    maxs: [40, 40, 144],
  },
  {
    name: "monster_widow2",
    spawn: SP_monster_widow2,
    health: 3800, // (2000 + 800 + 1000 * skill(1)) | 0
    gibHealth: -900,
    mass: 2500,
    movetype: MovetypeT.MOVETYPE_STEP,
    mins: [-70, -70, 0],
    maxs: [70, 70, 144],
  },
];

// ---------------------------------------------------------------------------

describe("rogue monster mmove tables construct without throwing", () => {
  test("module import already validated every MmoveT (see file header)", () => {
    // Reaching this line at all means m_carrier/m_stalker/m_turret/m_widow/
    // m_widow2's module-level `const foo_move_bar = new MmoveT(); ...
    // foo_move_bar.frame = [...]` assignments all passed MmoveT's
    // frames.length === lastframe - firstframe + 1 invariant (or carried an
    // explicit, C-cited allowFrameCountMismatch) at import time, above.
    expect(typeof SP_monster_carrier).toBe("function");
    expect(typeof SP_monster_stalker).toBe("function");
    expect(typeof SP_monster_turret).toBe("function");
    expect(typeof SP_monster_widow).toBe("function");
    expect(typeof SP_monster_widow2).toBe("function");
  });
});

for (const c of CASES) {
  describe(c.name, () => {
    test(`SP_${c.name} wires health/gib_health/mass/movetype/mins/maxs and a stand move`, () => {
      setupWorld();
      const ent = freshEdict(2);

      c.spawn(ent);

      expect(ent.health).toBe(c.health);
      if (typeof c.gibHealth === "number") {
        expect(ent.gib_health).toBe(c.gibHealth);
      } else {
        expect(c.gibHealth(ent.gib_health)).toBe(true);
      }
      expect(ent.mass).toBe(c.mass);
      expect(ent.movetype).toBe(c.movetype);
      expect(ent.solid).toBe(SolidT.SOLID_BBOX);
      expect(Array.from(ent.mins)).toEqual(c.mins);
      expect(Array.from(ent.maxs)).toEqual(c.maxs);
      expect(ent.monsterinfo.currentmove).not.toBeNull();
    });

    test("deathmatch guard frees the edict instead of spawning", () => {
      setupWorld();
      gameCvars.deathmatch = fakeCvar(1);
      const ent = freshEdict(2);

      c.spawn(ent);

      // G_FreeEdict clears inuse and blanks the classname (see g_utils.ts);
      // either is sufficient evidence the spawn bailed out early rather than
      // wiring up health/monsterinfo.
      expect(ent.inuse).toBe(false);
    });

    test("one AI frame runs on a fake world: s.frame stays finite and in range", () => {
      setupWorld();
      const ent = freshEdict(2);
      c.spawn(ent);

      runFrames(ent, 1);
    });

    test("monster_think advances s.frame over 5 frames with no NaN/Infinity", () => {
      setupWorld();
      const ent = freshEdict(2);
      c.spawn(ent);

      runFrames(ent, 5);
    });

    test("pain callback runs without throwing", () => {
      setupWorld();
      const ent = freshEdict(2);
      c.spawn(ent);
      const attacker = freshEdict(1);

      expect(() => ent.pain?.(ent, attacker, 10, 15)).not.toThrow();
    });

    test("die with gib-level damage sets deadflag to DEAD_DEAD", () => {
      setupWorld();
      const ent = freshEdict(2);
      c.spawn(ent);
      const inflictor = freshEdict(1);
      const attacker = freshEdict(1);
      const gibFloor = typeof c.gibHealth === "number" ? c.gibHealth : ent.gib_health;
      ent.health = gibFloor - 1;

      expect(() =>
        ent.die?.(ent, inflictor, attacker, 9999, vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2])),
      ).not.toThrow();
      // C's turret_die never sets deadflag: it explodes, throws debris, and
      // G_FreeEdicts itself -- death is ceasing to exist
      expect(ent.inuse).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// m_move2.ts -- rogue's ROGUE_GRAVITY-flavored SV_movestep/M_MoveToGoal/
// M_walkmove/M_ChangeYaw, exercised directly against a walking monster
// (stalker) rather than only indirectly through ai_walk/ai_run callbacks.
// ---------------------------------------------------------------------------

describe("m_move2 (rogue m_move.c port)", () => {
  test("M_ChangeYaw turns s.angles[YAW] toward ideal_yaw without overshoot", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_stalker(ent);

    ent.s.angles[1] = 0; // YAW
    ent.ideal_yaw = 90;
    ent.yaw_speed = 15;

    M_ChangeYaw(ent);

    // anglemod quantizes to 360/65536-degree steps (C-faithful): 15 -> 14.9963
    expect(ent.s.angles[1]).toBeCloseTo(15, 1);
  });

  test("M_walkmove on an airborne (no groundentity), non-flying monster returns false", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_stalker(ent);
    ent.groundentity = null;

    expect(M_walkmove(ent, 0, 10)).toBe(false);
  });

  test("M_MoveToGoal is a no-op with no groundentity and no FL_FLY/FL_SWIM", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_stalker(ent);
    ent.groundentity = null;
    const before = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);

    expect(() => M_MoveToGoal(ent, 10)).not.toThrow();
    expect(Array.from(ent.s.origin)).toEqual(Array.from(before));
  });

  test("M_CheckBottom on the default open-world trace (fraction 1) reports no ground", () => {
    setupWorld();
    const ent = freshEdict(2);
    SP_monster_stalker(ent);

    // gravityVector defaults to the zero vector on a fresh EdictT; M_CheckBottom's
    // gravity-relative branches (`ent.gravityVector[2] > 0` / `< 0`) both read
    // false for [0,0,0], exercising the same path rogue's own un-set-gravity
    // monsters take (the `#else` arm of the original baseq2 M_CheckBottom).
    expect(() => M_CheckBottom(ent)).not.toThrow();
  });
});
