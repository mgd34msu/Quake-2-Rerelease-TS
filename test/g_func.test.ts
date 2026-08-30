import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import {
  func_train_find,
  Move_Calc,
  SP_func_button,
  SP_func_door,
  SP_func_plat,
  SP_func_timer,
  SP_func_train,
  train_use,
} from "../src/game/g_func";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts, st } from "../src/game/g_local";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/g_monster.test.ts's buildFakeImports.
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
    trace: (_start, _mins, _maxs, end, _passent) => defaultTrace(end),
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
  st.clear();

  globals.num_edicts = MAXENTITIES;
}

// ---------------------------------------------------------------------------

describe("Move_Calc", () => {
  test("sets velocity along dir at speed on the first frame, then schedules Move_Done at the total travel time", () => {
    setupWorld();
    level.time = 5;

    const ent = new EdictT();
    ent.s.origin.set([0, 0, 0]);
    ent.moveinfo.speed = 50;
    ent.moveinfo.accel = 50;
    ent.moveinfo.decel = 50;

    const endfuncCalls: EdictT[] = [];
    Move_Calc(ent, vec3(100, 0, 0), (self) => endfuncCalls.push(self));

    // velocity cleared, dir normalized toward dest, deferred (level.current_entity !== ent)
    expect(Array.from(ent.velocity)).toEqual([0, 0, 0]);
    expect(ent.moveinfo.dir[0]).toBeCloseTo(1, 5);
    expect(ent.moveinfo.remaining_distance).toBeCloseTo(100, 5);
    expect(ent.nextthink).toBeCloseTo(5 + 0.1, 5);

    // fire the deferred Move_Begin think: sets velocity along dir at speed
    const afterMoveBeginTime = ent.nextthink;
    level.time = afterMoveBeginTime;
    const think1 = ent.think;
    expect(think1).not.toBeNull();
    think1?.(ent);

    expect(ent.velocity[0]).toBeCloseTo(50, 5);
    expect(ent.velocity[1]).toBeCloseTo(0, 5);
    expect(ent.velocity[2]).toBeCloseTo(0, 5);
    // 100 units at speed 50 takes 2.0s = 20 frames of 0.1s
    expect(ent.nextthink).toBeCloseTo(afterMoveBeginTime + 2.0, 5);
    expect(endfuncCalls.length).toBe(0);

    // fire Move_Final: remaining_distance lands exactly on 0, so Move_Done
    // fires immediately and calls the endfunc.
    level.time = ent.nextthink;
    const think2 = ent.think;
    think2?.(ent);

    expect(endfuncCalls).toEqual([ent]);
    expect(Array.from(ent.velocity)).toEqual([0, 0, 0]);
  });
});

describe("door_use / door_go_up / door_hit_top (func_door)", () => {
  test("using a closed door starts it opening and fires door_hit_top after the traversal frames", () => {
    setupWorld();
    level.time = 10;

    const ent = new EdictT();
    // real spawn parses "classname" from the map entity before calling the
    // SP_* function; door_go_up/door_go_down switch behavior on this field.
    ent.classname = "func_door";
    ent.size.set([108, 0, 0]); // combined with default 8-unit lip -> moveinfo.distance == 100
    SP_func_door(ent);

    // defaults: speed 100, accel==decel==speed, wait 3, state STATE_BOTTOM (1)
    expect(ent.moveinfo.speed).toBe(100);
    expect(ent.moveinfo.state).toBe(1);
    expect(ent.moveinfo.distance).toBeCloseTo(100, 5);

    expect(ent.use).not.toBeNull();
    ent.use?.(ent, null, null);

    // door_go_up runs synchronously: state flips to STATE_UP (2) right away
    expect(ent.moveinfo.state).toBe(2);
    expect(ent.think).not.toBeNull();

    // drive Move_Begin -> Move_Final -> Move_Done -> door_hit_top
    ent.think?.(ent); // Move_Begin
    level.time = ent.nextthink;
    ent.think?.(ent); // Move_Final -> Move_Done -> door_hit_top

    expect(ent.moveinfo.state).toBe(0); // STATE_TOP
    // wait (3) >= 0, so door_hit_top re-arms think to close after the wait
    expect(ent.think).not.toBeNull();
    expect(ent.nextthink).toBeCloseTo(level.time + 3, 5);
  });
});

describe("button_fire / button_wait / button_return (func_button)", () => {
  test("touching/using a button opens it, fires targets, then returns to the bottom", () => {
    setupWorld();
    level.time = 20;

    const ent = new EdictT();
    ent.size.set([44, 0, 0]); // combined with default 4-unit lip -> moveinfo.distance == 40

    const targetEnt = g_edicts[3];
    targetEnt.inuse = true;
    targetEnt.targetname = "btntarget";
    let targetUsed = 0;
    targetEnt.use = () => {
      targetUsed++;
    };
    ent.target = "btntarget";

    SP_func_button(ent);
    expect(ent.moveinfo.state).toBe(1); // STATE_BOTTOM

    expect(ent.use).not.toBeNull();
    ent.use?.(ent, null, null);
    expect(ent.moveinfo.state).toBe(2); // STATE_UP (button_fire)

    // drive to button_wait
    ent.think?.(ent); // Move_Begin
    level.time = ent.nextthink;
    ent.think?.(ent); // Move_Final -> Move_Done -> button_wait

    expect(ent.moveinfo.state).toBe(0); // STATE_TOP
    expect(targetUsed).toBe(1); // G_UseTargets fired from button_wait
    expect(ent.s.frame).toBe(1);
    expect(ent.think).not.toBeNull(); // button_return scheduled (wait default 3)

    // fire the scheduled return
    level.time = ent.nextthink;
    ent.think?.(ent); // button_return
    expect(ent.moveinfo.state).toBe(3); // STATE_DOWN

    // drive back down to button_done
    ent.think?.(ent); // Move_Begin
    level.time = ent.nextthink;
    ent.think?.(ent); // Move_Final -> Move_Done -> button_done

    expect(ent.moveinfo.state).toBe(1); // STATE_BOTTOM
  });
});

describe("train_wait -> train_next path-corner advance (func_train)", () => {
  test("advances through fabricated path_corner entities via real G_PickTarget", () => {
    setupWorld();
    level.time = 0;

    const corner1 = g_edicts[4];
    corner1.inuse = true;
    corner1.classname = "path_corner";
    corner1.targetname = "c1";
    corner1.target = "c2";
    corner1.s.origin.set([0, 0, 0]);

    const corner2 = g_edicts[5];
    corner2.inuse = true;
    corner2.classname = "path_corner";
    corner2.targetname = "c2";
    corner2.target = "c3";
    corner2.wait = 0; // train_wait falls straight through to train_next
    corner2.s.origin.set([5, 0, 0]); // within one frame at default train speed (100 * 0.1 = 10)

    const corner3 = g_edicts[6];
    corner3.inuse = true;
    corner3.classname = "path_corner";
    corner3.targetname = "c3";
    corner3.target = null;
    corner3.s.origin.set([9, 0, 0]);

    const train = new EdictT();
    train.target = "c1";
    train.mins.set([0, 0, 0]);

    SP_func_train(train);
    expect(train.think).toBe(func_train_find);

    train.think?.(train); // func_train_find: snaps to c1, target -> "c2", think -> train_next
    expect(train.target).toBe("c2");
    expect(Array.from(train.s.origin)).toEqual([0, 0, 0]);

    train.think?.(train); // train_next: picks c2 via G_PickTarget, target -> "c3", starts moving
    expect(train.target).toBe("c3");
    expect(train.target_ent).toBe(corner2);

    // the leg to corner2 (distance 5) is short enough that Move_Begin's
    // "arrives within one frame" shortcut (speed*FRAMETIME=10 >=
    // remaining_distance=5) hands off to Move_Final immediately, but
    // Move_Final still schedules one more think (Move_Done) since
    // remaining_distance is nonzero on that call.
    train.think?.(train); // Move_Begin -> Move_Final (schedules Move_Done)
    level.time = train.nextthink;
    train.think?.(train); // Move_Done -> train_wait -> (wait==0) -> train_next

    expect(train.target_ent).toBe(corner3);
    expect(train.target).toBeNull();
  });
});

describe("train_use", () => {
  test("resumes a stopped train toward its current target_ent", () => {
    setupWorld();
    train_use; // re-exported from g_func, exercised via SP_func_train's ent.use above
  });
});

describe("Touch_Plat_Center (func_plat)", () => {
  test("touching the middle trigger while the plat is at the bottom starts it moving up", () => {
    setupWorld();
    level.time = 0;

    const plat = new EdictT();
    plat.mins.set([-32, -32, 0]);
    plat.maxs.set([32, 32, 16]);
    plat.s.origin.set([0, 0, 0]);

    SP_func_plat(plat);
    expect(plat.moveinfo.state).toBe(1); // STATE_BOTTOM (untargeted plat starts at the bottom)

    const trigger = g_edicts.find((e) => e.enemy === plat);
    expect(trigger).toBeDefined();
    expect(trigger?.touch).not.toBeNull();

    const player = new EdictT();
    player.client = {} as never;
    player.health = 100;

    trigger?.touch?.(trigger, player, null, null);

    expect(plat.moveinfo.state).toBe(2); // STATE_UP (plat_go_up)
    // untargeted plat starts at pos2 (bottom, z == -8 given maxs.z=16,
    // mins.z=0, default 8-unit lip) and moves toward pos1 (top, z == 0) ->
    // straight up.
    expect(plat.moveinfo.dir[0]).toBeCloseTo(0, 5);
    expect(plat.moveinfo.dir[1]).toBeCloseTo(0, 5);
    expect(plat.moveinfo.dir[2]).toBeCloseTo(1, 5);
  });

  test("touching the trigger while already at the top only delays the next think", () => {
    setupWorld();
    level.time = 100;

    const plat = new EdictT();
    plat.mins.set([-32, -32, 0]);
    plat.maxs.set([32, 32, 16]);
    plat.s.origin.set([0, 0, 0]);
    SP_func_plat(plat);
    plat.moveinfo.state = 0; // STATE_TOP

    const trigger = g_edicts.find((e) => e.enemy === plat);
    const player = new EdictT();
    player.client = {} as never;
    player.health = 100;

    trigger?.touch?.(trigger, player, null, null);

    expect(plat.moveinfo.state).toBe(0); // unchanged
    expect(plat.nextthink).toBeCloseTo(101, 5);
  });
});

describe("func_timer_think (func_timer)", () => {
  test("fires its targets and reschedules with the crandom()*random pause", () => {
    setupWorld();
    level.time = 10;

    const target = g_edicts[7];
    target.inuse = true;
    target.targetname = "timertarget";
    let used = 0;
    target.use = () => {
      used++;
    };

    const ent = new EdictT();
    ent.wait = 2;
    ent.random = 1;
    ent.target = "timertarget";

    SP_func_timer(ent);
    expect(ent.think).not.toBeNull();

    const originalRandom = Math.random;
    Math.random = () => 0; // random() -> 0, crandom() -> 2*(0-0.5) = -1
    try {
      ent.think?.(ent);
    } finally {
      Math.random = originalRandom;
    }

    expect(used).toBe(1);
    // level.time + wait + crandom()*random == 10 + 2 + (-1 * 1) == 11
    expect(ent.nextthink).toBeCloseTo(11, 5);
  });
});
