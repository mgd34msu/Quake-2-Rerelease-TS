// Tests for src/game/m_actor.ts, m_boss3.ts, m_boss31.ts, m_boss32.ts,
// exercised through the real GetGameAPI(...) boundary (g_main.ts) with a
// fake GameImports, per .orch/preferences.md rule 13. Every describe block
// calls setupWorld() itself; nothing here depends on another test file
// having run first. Internal mmove_t/mframe_t statics are module-private,
// so moves are identified observably via their exported FRAME_*
// firstframe/lastframe rather than by object identity (see monsters_c/d).

import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { AI_GOOD_GUY, DamageT, DEAD_DEAD, EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/game/g_local";
import { SolidT } from "../src/game/game";
import { monster_think } from "../src/game/g_monster";
import { SP_misc_actor, SP_target_actor } from "../src/game/m_actor";
import { FRAME_run02, FRAME_run07, FRAME_stand101, FRAME_stand140 } from "../src/game/m_actor_frames";
import { SP_monster_boss3_stand } from "../src/game/m_boss3";
import { SP_monster_jorg } from "../src/game/m_boss31";
import { FRAME_stand01, FRAME_stand51 } from "../src/game/m_boss31_frames";
import { MakronToss, SP_monster_makron } from "../src/game/m_boss32";
import { FRAME_active01, FRAME_active13, FRAME_stand201, FRAME_stand260 } from "../src/game/m_boss32_frames";

// ---------------------------------------------------------------------------
// fake GameImports: a fixed no-collision trace, everything else a no-op.
// Modeled after test/g_monster.test.ts's buildFakeImports/setupWorld.
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
    soundindex: () => 1,
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

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 64;

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
  globals.max_edicts = MAXENTITIES;
  globals.edicts = edicts;

  // Self-sufficient per rule 13: never rely on another test file's cvar state.
  gameCvars.maxclients = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);

  nextEdictIndex = 10; // past maxclients(1) + BODY_QUEUE_SIZE(8), so G_FreeEdict actually frees these
}

function noNaN(v: Float32Array): boolean {
  return Array.from(v).every((n) => Number.isFinite(n));
}

// allocate real slots out of g_edicts (not detached `new EdictT()`s) so
// G_FreeEdict's `g_edicts.indexOf(ed)` check sees these as real world
// entities, matching a live spawn -- see monsters_c/d/e/f's identical idiom.
let nextEdictIndex = 10;
function newSlot(): EdictT {
  const ent = g_edicts[nextEdictIndex++];
  ent.inuse = true;
  return ent;
}

// ---------------------------------------------------------------------------

describe("monster_jorg", () => {
  test("SP_monster_jorg sets health/mass/boxes/stand", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_jorg(self);

    expect(self.health).toBe(3000);
    expect(self.max_health).toBe(3000); // set by monster_start (self.max_health = self.health)
    expect(self.gib_health).toBe(-2000);
    expect(self.mass).toBe(1000);
    expect(Array.from(self.mins)).toEqual([-80, -80, 0]);
    expect(Array.from(self.maxs)).toEqual([80, 80, 140]);

    expect(self.monsterinfo.stand).not.toBeNull();
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_stand01);
    expect(move.lastframe).toBe(FRAME_stand51);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_jorg(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });

  test("die: sets DEAD_DEAD/DAMAGE_NO and the death move; running the death animation far enough fires the jorg->makron toss chain (MakronToss spawns an edict carrying jorg's target)", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_jorg(self);
    self.target = "makron_wakeup";

    self.die?.(self, self, self, 500, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_NO);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;

    // The death move's 49th frame (index 48) is wired to MakronToss (see
    // m_boss31.c's jorg_frames_death1); M_MoveFrame processes one frame per
    // monster_think call, landing on that frame on the 49th call.
    for (let i = 0; i < 49; i++) monster_think(self);

    // MakronToss (m_boss32.ts) calls G_Spawn(), which scans from
    // maxclients+1 upward; with maxclients pinned to 1 the first free slot
    // is g_edicts[2].
    const tossed = g_edicts[2];
    expect(tossed.inuse).toBe(true);
    expect(tossed.target).toBe("makron_wakeup");
    expect(tossed.think).not.toBeNull();
    expect(tossed.nextthink).toBeCloseTo(level.time + 0.8, 5);
  });
});

// ---------------------------------------------------------------------------

describe("monster_makron", () => {
  test("SP_monster_makron sets health/mass/boxes/stand (currentmove starts at the sight move, not stand -- bug-for-bug: m_boss32.c comments out the stand assignment)", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_makron(self);

    expect(self.health).toBe(3000);
    expect(self.max_health).toBe(3000);
    expect(self.gib_health).toBe(-2000);
    expect(self.mass).toBe(500);
    expect(Array.from(self.mins)).toEqual([-30, -30, 0]);
    expect(Array.from(self.maxs)).toEqual([30, 30, 90]);

    expect(self.monsterinfo.stand).not.toBeNull();
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_active01);
    expect(move.lastframe).toBe(FRAME_active13);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_makron(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });

  test("MakronToss spawns a fresh edict carrying the caller's target, scheduled 0.8s out", () => {
    setupWorld();
    const jorg = newSlot();
    jorg.target = "player_start1";

    MakronToss(jorg);

    // G_Spawn scans from maxclients+1 upward; with maxclients pinned to 1
    // the first free slot is g_edicts[2], independent of jorg's own slot.
    const tossed = g_edicts[2];
    expect(tossed.inuse).toBe(true);
    expect(tossed.target).toBe("player_start1");
    expect(tossed.think).not.toBeNull();
    expect(tossed.nextthink).toBeCloseTo(level.time + 0.8, 5);
    expect(Array.from(tossed.s.origin)).toEqual(Array.from(jorg.s.origin));
  });
});

// ---------------------------------------------------------------------------

describe("misc_actor", () => {
  test("no targetname: frees itself without spawning (C: 'untargeted %s' dprintf + G_FreeEdict)", () => {
    setupWorld();
    const self = newSlot();
    // targetname left null (default)

    SP_misc_actor(self);

    expect(self.inuse).toBe(false);
    expect(self.classname).toBe("freed");
  });

  test("targetname but no target: frees itself without spawning (C: '%s with no target' dprintf + G_FreeEdict)", () => {
    setupWorld();
    const self = newSlot();
    self.targetname = "actor1";
    // target left null (default)

    SP_misc_actor(self);

    expect(self.inuse).toBe(false);
    expect(self.classname).toBe("freed");
  });

  test("targetname and target present: spawns normally with health/mass/boxes/AI_GOOD_GUY and stays dormant (use = actor_use)", () => {
    setupWorld();
    const self = newSlot();
    self.targetname = "actor1";
    self.target = "path1";

    SP_misc_actor(self);

    expect(self.inuse).toBe(true);
    expect(self.health).toBe(100);
    expect(self.mass).toBe(200);
    expect(Array.from(self.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(self.maxs)).toEqual([16, 16, 32]);
    expect(self.monsterinfo.aiflags & AI_GOOD_GUY).not.toBe(0);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_stand101);
    expect(move.lastframe).toBe(FRAME_stand140);

    // actors always start dormant -- must be `use`d to get going.
    expect(self.use).not.toBeNull();
  });

  test("actor_use with a bad target (movetarget is not a target_actor) reverts to standing and clears self.target", () => {
    setupWorld();
    const self = newSlot();
    self.targetname = "actor1";
    self.target = "path1"; // no matching target_actor entity exists

    SP_misc_actor(self);
    self.use?.(self, null, null);

    expect(self.target).toBeNull();
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_stand101);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = newSlot();
    self.targetname = "actor1";
    self.target = "path1";
    SP_misc_actor(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });

  test("run: with an enemy present, switches to the run move", () => {
    setupWorld();
    const self = newSlot();
    self.targetname = "actor1";
    self.target = "path1";
    SP_misc_actor(self);

    const enemy = newSlot();
    self.enemy = enemy;
    self.monsterinfo.run?.(self);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_run02);
    expect(move.lastframe).toBe(FRAME_run07);
  });
});

describe("target_actor", () => {
  test("SP_target_actor sets SOLID_TRIGGER, touch, and the small trigger box", () => {
    setupWorld();
    const self = newSlot();
    self.targetname = "wp1";

    SP_target_actor(self);

    expect(self.solid).toBe(SolidT.SOLID_TRIGGER);
    expect(self.touch).not.toBeNull();
    expect(Array.from(self.mins)).toEqual([-8, -8, -8]);
    expect(Array.from(self.maxs)).toEqual([8, 8, 8]);
  });
});

// ---------------------------------------------------------------------------

describe("monster_boss3_stand", () => {
  test("deathmatch: frees itself instead of spawning", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(1);
    const self = newSlot();

    SP_monster_boss3_stand(self);

    expect(self.inuse).toBe(false);
    expect(self.classname).toBe("freed");
  });

  test("normal spawn: sets the trigger box, starting frame, use, and think", () => {
    setupWorld();
    const self = newSlot();

    SP_monster_boss3_stand(self);

    expect(Array.from(self.mins)).toEqual([-32, -32, 0]);
    expect(Array.from(self.maxs)).toEqual([32, 32, 90]);
    expect(self.s.frame).toBe(FRAME_stand201);
    expect(self.use).not.toBeNull();
    expect(self.think).not.toBeNull();
    expect(self.nextthink).toBeGreaterThan(0);
  });

  test("Think_Boss3Stand cycles the frame from stand260 back to stand201; no NaN across 5 ticks", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_boss3_stand(self);

    for (let i = 0; i < 5; i++) self.think?.(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);

    self.s.frame = FRAME_stand260;
    self.think?.(self);
    expect(self.s.frame).toBe(FRAME_stand201);
  });

  test("Use_Boss3 frees the entity (teleport-away)", () => {
    setupWorld();
    const self = newSlot();
    SP_monster_boss3_stand(self);

    self.use?.(self, null, null);

    expect(self.inuse).toBe(false);
    expect(self.classname).toBe("freed");
  });
});
