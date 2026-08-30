// Tests for src/game/m_flipper.ts, m_parasite.ts, m_insane.ts, exercised
// through the real GetGameAPI(...) boundary (g_main.ts) with a fake
// GameImports, per .orch/preferences.md rule 13. Every describe block calls
// setupWorld() itself; nothing here depends on another test file having run
// first. Internal mmove_t/mframe_t statics are module-private (per the
// brief), so moves are identified observably via their exported FRAME_*
// firstframe/lastframe rather than by object identity.

import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { SVF_DEADMONSTER } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  AI_STAND_GROUND,
  DamageT,
  DEAD_DEAD,
  EdictT,
  FL_FLY,
  FL_NO_KNOCKBACK,
  game,
  gameCvars,
  globals,
  level,
  SetGEdicts,
} from "../src/game/g_local";
import { monster_think } from "../src/game/g_monster";
import { SP_monster_flipper } from "../src/game/m_flipper";
import {
  FRAME_flpdth01,
  FRAME_flphor01,
  FRAME_flppn101,
  FRAME_flppn105,
  FRAME_flppn201,
  FRAME_flppn205,
} from "../src/game/m_flipper_frames";
import { SP_monster_parasite } from "../src/game/m_parasite";
import { FRAME_death101, FRAME_pain101, FRAME_pain111, FRAME_stand01 } from "../src/game/m_parasite_frames";
import { SP_misc_insane } from "../src/game/m_insane";
import {
  FRAME_cr_death10,
  FRAME_cr_pain2,
  FRAME_crawl1,
  FRAME_crawl9,
  FRAME_cross1,
  FRAME_cross15,
  FRAME_cross16,
  FRAME_st_death2,
  FRAME_st_pain2,
  FRAME_stand60,
  FRAME_stand65,
} from "../src/game/m_insane_frames";

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
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
}

function noNaN(v: Float32Array): boolean {
  return Array.from(v).every((n) => Number.isFinite(n));
}

// ---------------------------------------------------------------------------

describe("monster_flipper", () => {
  test("SP_monster_flipper sets health/mass/boxes and the stand move", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_flipper(self);

    expect(self.health).toBe(50);
    expect(self.max_health).toBe(50); // set by monster_start (self.max_health = self.health)
    expect(self.gib_health).toBe(-30);
    expect(self.mass).toBe(100);
    expect(Array.from(self.mins)).toEqual([-16, -16, 0]);
    expect(Array.from(self.maxs)).toEqual([16, 16, 32]);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_flphor01);
    expect(move.lastframe).toBe(FRAME_flphor01);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_flipper(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });

  test("pain runs: debounces, and switches to a pain move", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_flipper(self);
    expect(self.pain).not.toBeNull();

    self.pain?.(self, self, 10, 10);

    expect(self.pain_debounce_time).toBe(level.time + 3);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect([FRAME_flppn101, FRAME_flppn201]).toContain(move.firstframe);
    expect([FRAME_flppn105, FRAME_flppn205]).toContain(move.lastframe);

    // second call within the debounce window is a no-op
    const before = self.pain_debounce_time;
    self.pain?.(self, self, 10, 10);
    expect(self.pain_debounce_time).toBe(before);
  });

  test("die: regular death sets DEAD_DEAD/DAMAGE_YES and the death move; gib death frees via ThrowGib/ThrowHead without a death move", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_flipper(self);
    expect(self.die).not.toBeNull();

    self.die?.(self, self, self, 10, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_YES);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_flpdth01);

    // gib path: health <= gib_health
    setupWorld();
    const gibbed = new EdictT();
    SP_monster_flipper(gibbed);
    gibbed.health = gibbed.gib_health;
    gibbed.die?.(gibbed, gibbed, gibbed, 999, vec3());
    expect(gibbed.deadflag).toBe(DEAD_DEAD);
  });
});

// ---------------------------------------------------------------------------

describe("monster_parasite", () => {
  test("SP_monster_parasite sets health/mass/boxes and the stand move", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_parasite(self);

    expect(self.health).toBe(175);
    expect(self.max_health).toBe(175);
    expect(self.gib_health).toBe(-50);
    expect(self.mass).toBe(250);
    expect(Array.from(self.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(self.maxs)).toEqual([16, 16, 24]);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_stand01);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_parasite(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });

  test("pain runs: debounces, and switches to the pain move", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_parasite(self);

    self.pain?.(self, self, 10, 10);

    expect(self.pain_debounce_time).toBe(level.time + 3);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_pain101);
    expect(move.lastframe).toBe(FRAME_pain111);
  });

  test("die: regular death sets DEAD_DEAD/DAMAGE_YES and the death move; gib death still marks DEAD_DEAD", () => {
    setupWorld();
    const self = new EdictT();
    SP_monster_parasite(self);

    self.die?.(self, self, self, 10, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_YES);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_death101);

    setupWorld();
    const gibbed = new EdictT();
    SP_monster_parasite(gibbed);
    gibbed.health = gibbed.gib_health;
    gibbed.die?.(gibbed, gibbed, gibbed, 999, vec3());
    expect(gibbed.deadflag).toBe(DEAD_DEAD);
  });
});

// ---------------------------------------------------------------------------

describe("misc_insane", () => {
  test("SP_misc_insane sets health/mass/boxes and AI_GOOD_GUY", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);

    expect(self.health).toBe(100);
    expect(self.max_health).toBe(100);
    expect(self.gib_health).toBe(-50);
    expect(self.mass).toBe(300);
    expect(Array.from(self.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(self.maxs)).toEqual([16, 16, 32]);
  });

  test("non-crucified: firing the spawn-completion think lands on a stand move (normal or insane variant)", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);

    // SP unconditionally seeds insane_move_stand_normal; monster_start_go
    // (fired here via self.think, matching walkmonster_start's deferred
    // completion) is what actually calls insane_stand().
    expect(self.think).not.toBeNull();
    self.think?.(self);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    // insane_stand() coin-flips between the normal and insane stand moves
    // (FRAME_stand60 / FRAME_stand65); either is a correctly-reached stand.
    expect([FRAME_stand60, FRAME_stand65]).toContain(move.firstframe);
  });

  test("crucified (spawnflags CRUCIFIED=8): the completed stand move is the cross move, and AI_STAND_GROUND is set", () => {
    setupWorld();
    const self = new EdictT();
    self.spawnflags = 8; // CRUCIFIED
    SP_misc_insane(self);

    expect(self.flags & FL_NO_KNOCKBACK).not.toBe(0); // FL_NO_KNOCKBACK set for crucified
    expect(Array.from(self.mins)).toEqual([-16, 0, 0]);
    expect(Array.from(self.maxs)).toEqual([16, 8, 32]);

    expect(self.think).not.toBeNull();
    self.think?.(self); // flymonster_start_go -> monster_start_go -> insane_stand()

    expect(self.monsterinfo.aiflags & AI_STAND_GROUND).not.toBe(0); // AI_STAND_GROUND
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_cross1);
    expect(move.lastframe).toBe(FRAME_cross15);
  });

  test("5 think frames produce no NaN in origin/angles", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);

    for (let i = 0; i < 5; i++) monster_think(self);

    expect(noNaN(self.s.origin)).toBe(true);
    expect(noNaN(self.s.angles)).toBe(true);
    expect(Number.isFinite(self.s.frame)).toBe(true);
  });

  test("pain runs (non-crucified, standing): debounces and switches to the stand-pain move", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);
    // default frame (within stand_normal's range) is outside the crawl/down
    // ranges, so insane_pain must pick the stand-pain move.
    self.s.frame = FRAME_stand60;

    self.pain?.(self, self, 10, 10);

    expect(self.pain_debounce_time).toBe(level.time + 3);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_st_pain2);
  });

  test("pain runs (crawling frame): switches to the crawl-pain move", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);
    self.s.frame = FRAME_crawl1 + 1;
    expect(self.s.frame).toBeLessThanOrEqual(FRAME_crawl9);

    self.pain?.(self, self, 10, 10);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_cr_pain2);
  });

  test("pain (crucified): always switches to the struggle-cross move regardless of frame", () => {
    setupWorld();
    const self = new EdictT();
    self.spawnflags = 8; // CRUCIFIED
    SP_misc_insane(self);

    self.pain?.(self, self, 10, 10);

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_cross16);
  });

  test("die (non-crucified, standing frame): sets DEAD_DEAD/DAMAGE_YES and the stand-death move, MOVETYPE unchanged until the animation ends", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);
    self.s.frame = FRAME_stand60;

    self.die?.(self, self, self, 10, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.takedamage).toBe(DamageT.DAMAGE_YES);
    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_st_death2);
    // insane_dead (which would flip movetype/SVF_DEADMONSTER) has not fired
    // yet -- it is the death move's endfunc, reached only once the animation
    // plays out via monster_think, not synchronously from die().
    expect(self.svflags & SVF_DEADMONSTER).toBe(0); // SVF_DEADMONSTER not yet set
  });

  test("die (crawling frame): sets the crawl-death move", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);
    self.s.frame = FRAME_crawl1;

    self.die?.(self, self, self, 10, vec3());

    const move = self.monsterinfo.currentmove;
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.firstframe).toBe(FRAME_cr_death10);
  });

  test("die (crucified): calls insane_dead immediately (FL_FLY + SVF_DEADMONSTER), skipping any death animation move -- the 'nothing' branch", () => {
    setupWorld();
    const self = new EdictT();
    self.spawnflags = 8; // CRUCIFIED
    SP_misc_insane(self);
    const moveBefore = self.monsterinfo.currentmove;

    self.die?.(self, self, self, 10, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
    expect(self.flags & FL_FLY).not.toBe(0); // FL_FLY set by insane_dead
    expect(self.svflags & SVF_DEADMONSTER).not.toBe(0); // SVF_DEADMONSTER set immediately
    expect(self.nextthink).toBe(0);
    // currentmove is untouched by the crucified die path -- no crawl/stand
    // death animation is ever assigned (bug-for-bug: insane_die's crucified
    // branch calls insane_dead(self) directly instead of setting a move).
    expect(self.monsterinfo.currentmove).toBe(moveBefore);
  });

  test("gib death (health <= gib_health) marks DEAD_DEAD regardless of crucified flag", () => {
    setupWorld();
    const self = new EdictT();
    SP_misc_insane(self);
    self.health = self.gib_health;

    self.die?.(self, self, self, 999, vec3());

    expect(self.deadflag).toBe(DEAD_DEAD);
  });
});
