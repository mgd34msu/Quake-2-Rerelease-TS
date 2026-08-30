/*
Unit tests for the RG-systems unit's pack-only rogue files: g_sphere.ts
(spheres/doppelganger) and g_newweap.ts's proximity mine state machine.

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake GameImports/GameExports and never relies on another test
file having run first. Modeled after test/g_utils.test.ts's fake-world
fixture (setupWorld/makeFakeGameImports/makeFakeGameExports).
*/

import { describe, expect, test } from "bun:test";
import type { Edict, GameExports, GameImports, GTraceT } from "../src/rogue/game";
import { GAME_API_VERSION, SolidT } from "../src/rogue/game";
import {
  EdictT,
  game,
  gameCvars,
  level,
  MovetypeT,
  SetGameExports,
  SetGameImports,
  SetGEdicts,
  SPHERE_DEFENDER,
  SPHERE_HUNTER,
} from "../src/rogue/g_local";
import { defender_pain, defender_think, hunter_pain, hunter_touch, Sphere_Spawn, sphere_explode } from "../src/rogue/g_sphere";
import { PROX_DAMAGE, PROX_TIME_TO_LIVE, prox_open, prox_seek } from "../src/rogue/g_newweap";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, EF_BLASTER, EF_TRACKER } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports -- records the calls that matter for these tests
// (sound/soundindex/linkentity/WriteByte), everything else is a quiet no-op.
// Modeled after test/g_utils.test.ts's fixture.
// ---------------------------------------------------------------------------

interface Recorder {
  soundCalls: number;
  linkentity: Edict[];
  writeByte: number[];
  dprintf: string[];
}

function makeRecorder(): Recorder {
  return { soundCalls: 0, linkentity: [], writeByte: [], dprintf: [] };
}

let traceResult: GTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 1,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: 0,
  ent: null,
};

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf(fmt) {
      rec.dprintf.push(fmt);
    },
    cprintf() {},
    centerprintf() {},
    sound() {
      rec.soundCalls++;
    },
    positioned_sound() {},
    configstring() {},
    error(fmt): never {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 1;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      return traceResult;
    },
    pointcontents() {
      return 0;
    },
    inPVS() {
      return false;
    },
    inPHS() {
      return false;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return false;
    },
    linkentity(ent) {
      rec.linkentity.push(ent);
    },
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    Pmove() {},
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte(c) {
      rec.writeByte.push(c);
    },
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString() {},
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    cvar() {
      return null;
    },
    cvar_set() {
      return null;
    },
    cvar_forceset() {
      return null;
    },
    argc() {
      return 0;
    },
    argv() {
      return "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
  };
}

function makeFakeGameExports(edicts: EdictT[], numEdicts: number): GameExports {
  return {
    apiversion: GAME_API_VERSION,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect(_ent: Edict, userinfo: string) {
      return { allowed: true, userinfo };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: numEdicts,
    max_edicts: edicts.length,
  };
}

// fabricated array of default EdictT instances: maxclients=2, maxentities=32
const MAXCLIENTS = 2;
const MAXENTITIES = 32;

function setupWorld(): Recorder {
  const rec = makeRecorder();
  SetGameImports(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;

  level.clear();

  const maxclientsCvar = new CvarT();
  maxclientsCvar.value = MAXCLIENTS;
  gameCvars.maxclients = maxclientsCvar;

  const deathmatchCvar = new CvarT();
  deathmatchCvar.value = 0;
  gameCvars.deathmatch = deathmatchCvar;

  // left null on purpose: prox_open's "strong_mines" branch is not exercised
  // by these tests, matching the C's `if (strong_mines && strong_mines->value)`
  // short-circuiting cleanly on a NULL cvar pointer.
  gameCvars.strong_mines = null;

  SetGameExports(makeFakeGameExports(edicts, MAXCLIENTS + 1));

  traceResult = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };

  return rec;
}

function spawnClientlessOwner(): EdictT {
  const owner = new EdictT();
  owner.inuse = true;
  owner.client = null;
  owner.health = 100;
  return owner;
}

// ---------------------------------------------------------------------------
// Sphere state transitions (g_sphere.ts)
// ---------------------------------------------------------------------------

describe("Sphere_Spawn", () => {
  test("wires up the defender sphere's callbacks and lifespan", () => {
    setupWorld();
    const owner = spawnClientlessOwner();

    const sphere = Sphere_Spawn(owner, SPHERE_DEFENDER);

    expect(sphere).not.toBeNull();
    expect(sphere!.classname).toBe("sphere");
    expect(sphere!.owner).toBe(owner);
    expect(sphere!.think).toBe(defender_think);
    expect(sphere!.pain).toBe(defender_pain);
    expect(sphere!.die).toBe(sphere_explode);
    expect(sphere!.wait).toBeGreaterThan(level.time);
  });

  test("hunter_pain transitions an idle sphere into chase mode (enemy assigned, touch swapped, effects set)", () => {
    setupWorld();
    const owner = spawnClientlessOwner(); // no client -> sam raimi cam branch is skipped
    const attacker = new EdictT();
    attacker.inuse = true;

    const sphere = Sphere_Spawn(owner, SPHERE_HUNTER);
    expect(sphere).not.toBeNull();
    const s = sphere!;

    // C: hunter_pain ignores hits while the owner lives ("if (owner &&
    // owner->health > 0) return") -- the hunter only turns vengeful once
    // its owner is dead. Kill the owner so the transition can happen.
    owner.health = 0;

    // before the hit: idle, no enemy, and Sphere_Spawn does not wire up
    // hunter_touch until something has hurt it (only pain/die/think/wait are
    // set for SPHERE_HUNTER at spawn time).
    expect(s.enemy).toBeNull();
    expect(s.touch).toBeNull();
    expect(s.pain).toBe(hunter_pain);

    // state transition: getting hit by a non-owner sets enemy + swaps touch
    // to the "go kill them" hunter_touch handler, and marks the sphere as
    // actively hunting (EF_BLASTER | EF_TRACKER).
    s.pain!(s, attacker, 0, 10);

    expect(s.enemy).toBe(attacker);
    expect(s.touch).toBe(hunter_touch);
    expect((s.s.effects & EF_BLASTER) !== 0).toBe(true);
    expect((s.s.effects & EF_TRACKER) !== 0).toBe(true);

    // second hit while already chasing an enemy is a no-op (C: `if
    // (self->enemy) return;`) -- enemy stays the first attacker.
    const secondAttacker = new EdictT();
    secondAttacker.inuse = true;
    s.pain!(s, secondAttacker, 0, 10);
    expect(s.enemy).toBe(attacker); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Prox mine arming (g_newweap.ts)
// ---------------------------------------------------------------------------

describe("prox mine arming (prox_open -> prox_seek)", () => {
  test("stays owned and unarmed through the opening animation, then arms with owner cleared", () => {
    setupWorld();
    const owner = spawnClientlessOwner();

    const mine = new EdictT();
    mine.inuse = true;
    mine.classname = "prox";
    mine.owner = owner;
    mine.dmg = PROX_DAMAGE; // 90 -> single-mine wait bucket
    mine.s.frame = 0;
    mine.solid = SolidT.SOLID_BBOX;
    mine.movetype = MovetypeT.MOVETYPE_NONE;

    // drive the opening animation (frames 0..8): still owned, not yet armed.
    let iterations = 0;
    while (mine.s.frame !== 9 && iterations < 20) {
      prox_open(mine);
      iterations++;
      expect(mine.owner).toBe(owner); // still unarmed mid-animation
    }
    expect(mine.s.frame).toBe(9);
    expect(mine.owner).toBe(owner); // frame 9 not yet processed

    // one more think tick processes frame 9: this is the actual arming
    // transition -- owner is released (so the firer can walk away/shoot it)
    // and the mine switches from the open animation to its seek/live-timer
    // think function.
    prox_open(mine);

    expect(mine.owner).toBeNull();
    expect(mine.think).toBe(prox_seek);
    expect(mine.wait).toBeGreaterThan(level.time);
    expect(mine.wait).toBeCloseTo(level.time + PROX_TIME_TO_LIVE, 5);
  });

  test("does not arm early: owner stays set on every frame before 9", () => {
    setupWorld();
    const owner = spawnClientlessOwner();

    const mine = new EdictT();
    mine.inuse = true;
    mine.classname = "prox";
    mine.owner = owner;
    mine.dmg = PROX_DAMAGE;
    mine.s.frame = 0;

    prox_open(mine);
    expect(mine.s.frame).toBe(1);
    expect(mine.owner).toBe(owner);
    expect(mine.think).toBe(prox_open);
  });
});
