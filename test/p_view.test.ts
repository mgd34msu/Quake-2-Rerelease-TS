import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import {
  CplaneT,
  CONTENTS_WATER,
  CvarT,
  EntityEventT,
  STAT_AMMO,
  STAT_AMMO_ICON,
  STAT_ARMOR,
  STAT_ARMOR_ICON,
  STAT_HEALTH,
  STAT_HEALTH_ICON,
} from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  EdictT,
  g_edicts,
  game,
  gameCvars,
  GClientT,
  globals,
  level,
  MovetypeT,
  SetGEdicts,
} from "../src/game/g_local";
import { FindItem, InitItems, ITEM_INDEX, SetItemNames } from "../src/game/g_items";
import {
  G_SetClientFrame,
  P_FallingDamage,
  P_SetCurrentPlayerForTesting,
  P_WorldEffects,
  SV_CalcBlend,
  SV_CalcRoll,
  SV_SetRightVectorForTesting,
} from "../src/game/p_view";
import { G_SetStats, MoveClientToIntermission } from "../src/game/p_hud";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/g_monster.test.ts's buildFakeImports/
// setupWorld (rule 13: this file initializes its own globals via
// GetGameAPI, never relies on another test file having run first).
// `imageindex` returns 1 for any non-empty string and 0 for "" so tests can
// tell "an icon was looked up" apart from "no icon" without needing exact
// image-index values (the fake server assigns none).
// ---------------------------------------------------------------------------

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

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
    imageindex: (name: string) => (name.length > 0 ? 1 : 0),
    setmodel: () => {},
    trace: (_start, _mins, _maxs, end: import("../src/shared/math").Vec3, _passent: Edict | null) => defaultTrace(end),
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

const MAXENTITIES = 16;

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

  // no dmflags/deathmatch/coop restrictions unless a test opts in
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.coop = fakeCvar(0);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1); // != 0, skips T_Damage's easy-mode damage halving
}

function makePlayer(number: number): EdictT {
  const ent = g_edicts[number];
  ent.client = new GClientT();
  ent.s.modelindex = 255;
  ent.inuse = true;
  ent.health = 100;
  ent.takedamage = 1;
  return ent;
}

// ---------------------------------------------------------------------------

describe("SV_CalcRoll", () => {
  test("sign and magnitude follow the side (right-vector) component of velocity", () => {
    setupWorld();
    gameCvars.sv_rollangle = fakeCvar(2);
    gameCvars.sv_rollspeed = fakeCvar(200);
    SV_SetRightVectorForTesting(vec3(1, 0, 0));

    // side=50 < rollspeed(200): side = 50 * 2/200 = 0.5, sign +1
    expect(SV_CalcRoll(vec3(), vec3(50, 0, 0))).toBeCloseTo(0.5, 5);

    // same magnitude, opposite side sign -> negative result
    expect(SV_CalcRoll(vec3(), vec3(-50, 0, 0))).toBeCloseTo(-0.5, 5);

    // side=300 >= rollspeed(200): clamped to sv_rollangle's value (2)
    expect(SV_CalcRoll(vec3(), vec3(300, 0, 0))).toBeCloseTo(2, 5);
  });
});

describe("P_FallingDamage", () => {
  test("delta below 1 is a safe landing: no event, no damage", () => {
    setupWorld();
    const ent = makePlayer(1);
    ent.movetype = MovetypeT.MOVETYPE_STEP;
    ent.groundentity = g_edicts[2];
    ent.client!.oldvelocity[2] = 0;
    ent.velocity[2] = 0; // delta = 0*0*0.0001 = 0, < 1

    P_FallingDamage(ent);

    expect(ent.s.event).toBe(EntityEventT.EV_NONE);
    expect(ent.health).toBe(100);
  });

  test("delta in (30,55) applies real T_Damage and fires EV_FALL", () => {
    setupWorld();
    const ent = makePlayer(1);
    ent.movetype = MovetypeT.MOVETYPE_STEP;
    ent.groundentity = g_edicts[2];
    ent.client!.oldvelocity[2] = 0;
    ent.velocity[2] = 600; // delta = 600*600*0.0001 = 36

    P_FallingDamage(ent);

    expect(ent.s.event).toBe(EntityEventT.EV_FALL);
    // damage = floor((36-30)/2) = 3
    expect(ent.health).toBe(97);
  });

  test("delta >= 55 fires EV_FALLFAR with proportionally larger real T_Damage", () => {
    setupWorld();
    const ent = makePlayer(1);
    ent.movetype = MovetypeT.MOVETYPE_STEP;
    ent.groundentity = g_edicts[2];
    ent.client!.oldvelocity[2] = 0;
    ent.velocity[2] = 800; // delta = 800*800*0.0001 = 64

    P_FallingDamage(ent);

    expect(ent.s.event).toBe(EntityEventT.EV_FALLFAR);
    // damage = floor((64-30)/2) = 17
    expect(ent.health).toBe(83);
  });
});

describe("SV_CalcBlend", () => {
  test("accumulates the damage blend and the bonus (pickup) blend, then decays both alphas", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client!;
    client.damage_alpha = 0.5;
    client.damage_blend.set([1, 0, 0]);
    client.bonus_alpha = 0.3;

    SV_CalcBlend(ent);

    // damage blend alone: a2=0.5, a3=0 -> [1,0,0,0.5]; then bonus blend
    // (0.85,0.7,0.3,0.3) mixed on top: a2=0.65, a3=0.5/0.65
    expect(client.ps.blend[0]).toBeCloseTo(0.965385, 5);
    expect(client.ps.blend[1]).toBeCloseTo(0.161538, 5);
    expect(client.ps.blend[2]).toBeCloseTo(0.069231, 5);
    expect(client.ps.blend[3]).toBeCloseTo(0.65, 5);

    // drop the damage/bonus values by their fixed per-frame decay
    expect(client.damage_alpha).toBeCloseTo(0.44, 5);
    expect(client.bonus_alpha).toBeCloseTo(0.2, 5);
  });
});

describe("P_WorldEffects", () => {
  test("a breather ticks air_finished (no drowning); once it lapses, real T_Damage drowns the player over successive frames", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client!;
    ent.movetype = MovetypeT.MOVETYPE_WALK;
    ent.waterlevel = 3;
    ent.watertype = CONTENTS_WATER;
    client.old_waterlevel = 3;
    ent.dmg = 2;

    // Phase A: breather active -- air_finished is refreshed (ticked) to
    // level.time + 10 before the drowning check runs, so no damage yet.
    client.breather_framenum = level.framenum + 100;
    ent.air_finished = level.time - 5; // already expired before the tick
    client.next_drown_time = level.time - 1;

    P_SetCurrentPlayerForTesting(ent);
    P_WorldEffects();

    expect(ent.air_finished).toBeCloseTo(level.time + 10, 5);
    expect(ent.health).toBe(100);

    // Phase B: breather gone and air now actually expired -- drowning
    // damage lands via real T_Damage, and `dmg` climbs by 2 per tick.
    client.breather_framenum = 0;
    ent.air_finished = level.time - 1;
    client.next_drown_time = level.time - 1;

    P_WorldEffects();

    expect(ent.dmg).toBe(4);
    expect(ent.health).toBe(96); // 100 - 4
    expect(client.next_drown_time).toBeCloseTo(level.time + 1, 5);

    // Phase C: over a further frame, dmg keeps climbing and health keeps dropping.
    ent.air_finished = level.time - 1;
    client.next_drown_time = level.time - 1;

    P_WorldEffects();

    expect(ent.dmg).toBe(6);
    expect(ent.health).toBe(90); // 96 - 6
  });
});

describe("G_SetStats", () => {
  test("fills STAT_HEALTH/AMMO/ARMOR from a fabricated client inventory", () => {
    setupWorld();
    InitItems();
    SetItemNames();

    const ent = makePlayer(1);
    const client = ent.client!;
    ent.health = 57;
    level.pic_health = 42;

    const shells = FindItem("Shells");
    if (shells === null) throw new Error("test setup: Shells item not found");
    client.ammo_index = ITEM_INDEX(shells);
    client.pers.inventory[client.ammo_index] = 25;

    const combatArmor = FindItem("Combat Armor");
    if (combatArmor === null) throw new Error("test setup: Combat Armor item not found");
    client.pers.inventory[ITEM_INDEX(combatArmor)] = 40;

    G_SetStats(ent);

    expect(client.ps.stats[STAT_HEALTH]).toBe(57);
    expect(client.ps.stats[STAT_HEALTH_ICON]).toBe(42);
    expect(client.ps.stats[STAT_AMMO]).toBe(25);
    expect(client.ps.stats[STAT_AMMO_ICON]).toBe(1); // a non-empty icon string was looked up
    expect(client.ps.stats[STAT_ARMOR]).toBe(40);
    expect(client.ps.stats[STAT_ARMOR_ICON]).toBe(1);
  });
});

describe("MoveClientToIntermission", () => {
  test("moves the player to the intermission spot and freezes movement", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client!;
    level.intermission_origin.set([100, 200, 300]);
    level.intermission_angle.set([0, 90, 0]);

    MoveClientToIntermission(ent);

    expect(Array.from(ent.s.origin)).toEqual([100, 200, 300]);
    expect(Array.from(client.ps.viewangles)).toEqual([0, 90, 0]);
    expect(client.ps.pmove.origin[0]).toBe(800);
    expect(client.ps.pmove.origin[1]).toBe(1600);
    expect(client.ps.pmove.origin[2]).toBe(2400);
    expect(client.quad_framenum).toBe(0);
  });
});

describe("G_SetClientFrame", () => {
  test("a grounded, stationary, unducked player lands on the standing animation", () => {
    setupWorld();
    const ent = makePlayer(1);
    ent.groundentity = g_edicts[2]; // on ground, so the airborne/jump path is not taken

    G_SetClientFrame(ent);

    // FRAME_stand01 / FRAME_stand40 per m_player.h (0 / 39)
    expect(ent.s.frame).toBe(0);
    expect(ent.client!.anim_end).toBe(39);
  });
});
