import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CS_LIGHTS } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, FRAMETIME, g_edicts, game, gameCvars, GClientT, globals, level, SetGEdicts } from "../src/game/g_local";
import {
  SP_target_earthquake,
  SP_target_explosion,
  SP_target_lightramp,
  target_earthquake_think,
  target_earthquake_use,
  target_explosion_explode,
  target_lightramp_think,
  target_lightramp_use,
  use_target_explosion,
} from "../src/game/g_target";
import { SP_trigger_counter, SP_trigger_hurt, SP_trigger_push, SP_trigger_multiple, trigger_counter_use, Touch_Multi } from "../src/game/g_trigger";

// ---------------------------------------------------------------------------
// fake GameImports, modeled after test/g_monster.test.ts's buildFakeImports/
// setupWorld: a per-test trace function, plus recorder arrays for the specific
// gi.* calls each suite below needs to observe.
// ---------------------------------------------------------------------------

type TraceFn = (
  start: import("../src/shared/math").Vec3,
  mins: import("../src/shared/math").Vec3 | null,
  maxs: import("../src/shared/math").Vec3 | null,
  end: import("../src/shared/math").Vec3,
  passent: Edict | null,
) => GTraceT;

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

const configstringCalls: Array<{ num: number; str: string }> = [];
const centerprintfCalls: Array<{ ent: Edict; fmt: string }> = [];
const positionedSoundCalls: Array<{ ent: Edict }> = [];

function buildFakeImports(traceFn?: TraceFn): GameImports {
  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: (ent, fmt) => {
      centerprintfCalls.push({ ent, fmt });
    },
    sound: () => {},
    positioned_sound: (_origin, ent) => {
      positionedSoundCalls.push({ ent });
    },
    configstring: (num, str) => {
      configstringCalls.push({ num, str });
    },
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 0,
    soundindex: () => 0,
    imageindex: () => 0,
    setmodel: () => {},
    trace: (start, mins, maxs, end, passent) => (traceFn ? traceFn(start, mins, maxs, end, passent) : defaultTrace(end)),
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

function setupWorld(traceFn?: TraceFn): void {
  GetGameAPI(buildFakeImports(traceFn));

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

  configstringCalls.length = 0;
  centerprintfCalls.length = 0;
  positionedSoundCalls.length = 0;

  gameCvars.deathmatch = null;
  gameCvars.coop = null;
  gameCvars.dmflags = null;
}

// ---------------------------------------------------------------------------

describe("trigger_multiple / Touch_Multi", () => {
  test("touch fires targets via G_UseTargets and re-arms after wait", () => {
    setupWorld();

    const target1 = new EdictT();
    target1.inuse = true;
    target1.targetname = "target1";
    const useCalls: Array<EdictT | null> = [];
    target1.use = (_self, _other, activator) => {
      useCalls.push(activator);
    };
    // planted directly into the world so G_Find can see it
    const edicts = Array.from({ length: MAXENTITIES }, () => new EdictT());
    edicts.forEach((e, i) => (e.s.number = i));
    edicts[5] = target1;
    target1.s.number = 5;
    SetGEdicts(edicts);
    globals.num_edicts = MAXENTITIES;

    const trig = new EdictT();
    SP_trigger_multiple(trig);
    trig.target = "target1";

    const player = edicts[1];
    player.inuse = true;
    player.client = new GClientT();

    expect(trig.touch).not.toBeNull();
    trig.touch?.(trig, player, null, null);

    expect(useCalls.length).toBe(1);
    expect(useCalls[0]).toBe(player);
    // wait re-arm: 0.2 default, nextthink scheduled, touch stays wired
    expect(trig.wait).toBeCloseTo(0.2, 5);
    expect(trig.nextthink).toBeCloseTo(level.time + 0.2, 5);

    // touching again before the wait elapses does not refire (already triggered)
    trig.touch?.(trig, player, null, null);
    expect(useCalls.length).toBe(1);

    // the wait has passed: the scheduler would call multi_wait, clearing nextthink
    level.time += 0.2;
    if (trig.think) trig.think(trig);
    expect(trig.nextthink).toBe(0);

    // now it can fire again
    trig.touch?.(trig, player, null, null);
    expect(useCalls.length).toBe(2);
  });
});

describe("trigger_counter", () => {
  test("counts down and fires targets with a message at zero", () => {
    setupWorld();

    const counter = new EdictT();
    SP_trigger_counter(counter);
    expect(counter.count).toBe(2);

    const activator = new EdictT();

    trigger_counter_use(counter, null, activator);
    expect(counter.count).toBe(1);
    expect(centerprintfCalls.length).toBe(1);
    expect(centerprintfCalls[0]?.fmt).toContain("more to go");

    trigger_counter_use(counter, null, activator);
    expect(counter.count).toBe(0);
    expect(centerprintfCalls.length).toBe(2);
    expect(centerprintfCalls[1]?.fmt).toBe("Sequence completed!");
    expect(counter.activator).toBe(activator);

    // fully spent: further uses are a no-op
    trigger_counter_use(counter, null, activator);
    expect(counter.count).toBe(0);
    expect(centerprintfCalls.length).toBe(2);
  });
});

describe("trigger_hurt", () => {
  test("touch damages via real T_Damage, gated by the per-frame timestamp", () => {
    setupWorld();

    const hurt = new EdictT();
    SP_trigger_hurt(hurt);
    expect(hurt.dmg).toBe(5);

    const victim = new EdictT();
    victim.takedamage = 1;
    victim.health = 100;
    victim.max_health = 100;

    expect(hurt.touch).not.toBeNull();
    hurt.touch?.(hurt, victim, null, null);
    expect(victim.health).toBe(95);

    // same frame: the timestamp gate blocks a second hit
    hurt.touch?.(hurt, victim, null, null);
    expect(victim.health).toBe(95);

    // next frame: damage resumes
    level.time += FRAMETIME;
    hurt.touch?.(hurt, victim, null, null);
    expect(victim.health).toBe(90);
  });
});

describe("trigger_push", () => {
  test("shoves touching entities: velocity = movedir * speed * 10", () => {
    setupWorld();

    const push = new EdictT();
    SP_trigger_push(push);
    expect(push.speed).toBe(1000);
    push.movedir.set([1, 0, 0]);

    const victim = new EdictT();
    victim.health = 50;

    expect(push.touch).not.toBeNull();
    push.touch?.(push, victim, null, null);

    expect(victim.velocity[0]).toBeCloseTo(10000, 5);
    expect(victim.velocity[1]).toBeCloseTo(0, 5);
    expect(victim.velocity[2]).toBeCloseTo(0, 5);
  });
});

describe("target_explosion", () => {
  test("fires immediately when delay is unset", () => {
    setupWorld();

    const exp = new EdictT();
    SP_target_explosion(exp);
    exp.dmg = 20;

    const activator = new EdictT();
    exp.think = null;
    use_target_explosion(exp, null, activator);
    // delay is 0 (default), so it should have exploded synchronously, not scheduled a think
    expect(exp.think).toBeNull();
    expect(exp.nextthink).toBe(0);
    expect(exp.activator).toBe(activator);
  });

  test("schedules and explodes via think when delay is set, restoring delay afterward", () => {
    setupWorld();

    const exp = new EdictT();
    SP_target_explosion(exp);
    exp.delay = 1;
    exp.dmg = 0; // skip T_RadiusDamage bookkeeping, focus on the delay/think contract

    const target1 = new EdictT();
    target1.inuse = true;
    target1.targetname = "target1";
    const useCalls: Array<EdictT | null> = [];
    target1.use = (_self, _other, activator) => {
      useCalls.push(activator);
    };
    const edicts = Array.from({ length: MAXENTITIES }, () => new EdictT());
    edicts.forEach((e, i) => (e.s.number = i));
    edicts[5] = target1;
    target1.s.number = 5;
    SetGEdicts(edicts);
    globals.num_edicts = MAXENTITIES;

    exp.target = "target1";

    const activator = new EdictT();
    use_target_explosion(exp, null, activator);

    expect(exp.think).toBe(target_explosion_explode);
    expect(exp.nextthink).toBeCloseTo(level.time + 1, 5);
    expect(exp.delay).toBe(1); // unchanged until the think actually fires

    level.time += 1;
    exp.think?.(exp);

    expect(useCalls.length).toBe(1);
    expect(useCalls[0]).toBe(activator);
    // the save/restore around G_UseTargets: delay is zeroed only for that call
    expect(exp.delay).toBe(1);
  });
});

describe("target_lightramp", () => {
  test("writes a ramping CS_LIGHTS configstring across think calls", () => {
    setupWorld();

    const light = new EdictT();
    light.inuse = true;
    light.classname = "light";
    light.targetname = "theLight";
    light.style = 3;
    const edicts = Array.from({ length: MAXENTITIES }, () => new EdictT());
    edicts.forEach((e, i) => (e.s.number = i));
    edicts[5] = light;
    light.s.number = 5;
    SetGEdicts(edicts);
    globals.num_edicts = MAXENTITIES;

    const ramp = new EdictT();
    ramp.message = "az";
    ramp.speed = 1;
    ramp.target = "theLight";
    SP_target_lightramp(ramp);

    target_lightramp_use(ramp, null, null);
    expect(ramp.enemy).toBe(light);
    expect(configstringCalls.length).toBe(1);
    expect(configstringCalls[0]).toEqual({ num: CS_LIGHTS + 3, str: "a" });

    level.time += FRAMETIME;
    target_lightramp_think(ramp);
    expect(configstringCalls.length).toBe(2);
    expect(configstringCalls[1]?.num).toBe(CS_LIGHTS + 3);
    // ramping from 'a' toward 'z': the letter should have advanced
    expect(configstringCalls[1]?.str.charCodeAt(0)).toBeGreaterThan("a".charCodeAt(0));
  });
});

describe("target_earthquake", () => {
  test("use schedules the shake; think jolts grounded clients and reschedules while active", () => {
    setupWorld();
    level.time = 1;

    const quake = new EdictT();
    SP_target_earthquake(quake);
    expect(quake.count).toBe(5);
    expect(quake.speed).toBe(200);

    const activator = new EdictT();
    target_earthquake_use(quake, null, activator);
    expect(quake.timestamp).toBeCloseTo(level.time + 5, 5);
    expect(quake.nextthink).toBeCloseTo(level.time + FRAMETIME, 5);
    expect(quake.last_move_time).toBe(0);

    const player = new EdictT();
    player.inuse = true;
    player.client = new GClientT();
    player.groundentity = quake; // any non-null edict signals "on ground"
    player.mass = 100;
    g_edicts[2] = player;
    player.s.number = 2;

    target_earthquake_think(quake);

    expect(positionedSoundCalls.length).toBe(1);
    expect(quake.last_move_time).toBeCloseTo(level.time + 0.5, 5);
    expect(player.groundentity).toBeNull();
    expect(player.velocity[2]).toBeCloseTo(200, 5); // speed * (100 / mass)
    expect(Math.abs(player.velocity[0])).toBeLessThanOrEqual(150);
    expect(Math.abs(player.velocity[1])).toBeLessThanOrEqual(150);

    // still within the quake's duration: think reschedules itself
    expect(quake.nextthink).toBeCloseTo(level.time + FRAMETIME, 5);
  });
});
