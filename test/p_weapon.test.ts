import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  CENTER_HANDED,
  EdictT,
  g_edicts,
  game,
  gameCvars,
  GClientT,
  gi,
  GItemT,
  globals,
  LEFT_HANDED,
  level,
  PNOISE_IMPACT,
  PNOISE_SELF,
  PNOISE_WEAPON,
  RIGHT_HANDED,
  SetGEdicts,
  WeaponstateT,
} from "../src/game/g_local";
import { FindItem, ITEM_INDEX, InitItems } from "../src/game/g_items";
import {
  ChangeWeapon,
  Machinegun_Fire,
  NoAmmoWeaponChange,
  P_ProjectSource,
  PlayerNoise,
  Think_Weapon,
  Weapon_Generic,
} from "../src/game/p_weapon";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/g_monster.test.ts's buildFakeImports/
// setupWorld (rule 13: this file initializes its own globals via
// GetGameAPI, never relies on another test file having run first).
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
    imageindex: () => 0,
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
  gameCvars.g_select_empty = fakeCvar(0);

  InitItems();
}

function makePlayer(number: number): EdictT {
  const ent = g_edicts[number];
  ent.client = new GClientT();
  ent.s.modelindex = 255;
  ent.inuse = true;
  ent.health = 100; // alive by default; Think_Weapon's "just died" test overrides this
  return ent;
}

// ---------------------------------------------------------------------------

describe("P_ProjectSource", () => {
  test("right-handed: distance is used as-is", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");
    client.pers.hand = RIGHT_HANDED;

    const result = vec3();
    P_ProjectSource(client, vec3(0, 0, 0), vec3(10, 5, 2), vec3(1, 0, 0), vec3(0, 1, 0), result);

    expect(Array.from(result)).toEqual([10, 5, 2]);
  });

  test("left-handed: the lateral (right) component is mirrored", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");
    client.pers.hand = LEFT_HANDED;

    const result = vec3();
    P_ProjectSource(client, vec3(0, 0, 0), vec3(10, 5, 2), vec3(1, 0, 0), vec3(0, 1, 0), result);

    expect(Array.from(result)).toEqual([10, -5, 2]);
  });

  test("center-handed: the lateral (right) component is zeroed", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");
    client.pers.hand = CENTER_HANDED;

    const result = vec3();
    P_ProjectSource(client, vec3(0, 0, 0), vec3(10, 5, 2), vec3(1, 0, 0), vec3(0, 1, 0), result);

    expect(Array.from(result)).toEqual([10, 0, 2]);
  });
});

describe("PlayerNoise", () => {
  test("spawns both noise entities on first call and points level.sound_entity at the personal one", () => {
    setupWorld();
    const who = makePlayer(1);
    expect(who.mynoise).toBeNull();
    expect(who.mynoise2).toBeNull();

    const where = vec3(100, 200, 300);
    PlayerNoise(who, where, PNOISE_SELF);

    expect(who.mynoise).not.toBeNull();
    expect(who.mynoise2).not.toBeNull();
    expect(level.sound_entity).toBe(who.mynoise);
    expect(level.sound_entity_framenum).toBe(level.framenum);
    expect(Array.from((who.mynoise as EdictT).s.origin)).toEqual([100, 200, 300]);
    expect((who.mynoise as EdictT).teleport_time).toBe(level.time);
  });

  test("PNOISE_IMPACT reuses the existing noise pair and points level.sound2_entity at the impact one", () => {
    setupWorld();
    const who = makePlayer(1);

    PlayerNoise(who, vec3(0, 0, 0), PNOISE_SELF);
    const firstNoise = who.mynoise;
    const firstNoise2 = who.mynoise2;

    PlayerNoise(who, vec3(9, 9, 9), PNOISE_IMPACT);

    // no re-spawn: the same pair of entities is reused
    expect(who.mynoise).toBe(firstNoise);
    expect(who.mynoise2).toBe(firstNoise2);
    expect(level.sound2_entity).toBe(who.mynoise2);
    expect(Array.from((who.mynoise2 as EdictT).s.origin)).toEqual([9, 9, 9]);
  });

  test("a silenced weapon shot consumes a silencer charge instead of making noise", () => {
    setupWorld();
    const who = makePlayer(1);
    const client = who.client;
    if (client === null) throw new Error("unreachable");
    client.silencer_shots = 2;

    PlayerNoise(who, vec3(1, 1, 1), PNOISE_WEAPON);

    expect(client.silencer_shots).toBe(1);
    expect(who.mynoise).toBeNull(); // never got far enough to spawn anything
  });
});

describe("NoAmmoWeaponChange", () => {
  function inv(ent: EdictT, pickupName: string, count: number): void {
    const client = ent.client;
    if (client === null) throw new Error("unreachable");
    const item = FindItem(pickupName);
    if (item === null) throw new Error(`missing item ${pickupName}`);
    client.pers.inventory[ITEM_INDEX(item)] = count;
  }

  test("falls back through the C priority order: slugs+railgun beats everything else", () => {
    setupWorld();
    const ent = makePlayer(1);
    inv(ent, "slugs", 5);
    inv(ent, "railgun", 1);
    inv(ent, "bullets", 50); // present but lower priority

    NoAmmoWeaponChange(ent);

    expect(ent.client?.newweapon).toBe(FindItem("railgun"));
  });

  test("cells+hyperblaster beats bullets+chaingun/machinegun", () => {
    setupWorld();
    const ent = makePlayer(1);
    inv(ent, "cells", 40);
    inv(ent, "hyperblaster", 1);
    inv(ent, "bullets", 50);
    inv(ent, "chaingun", 1);
    inv(ent, "machinegun", 1);

    NoAmmoWeaponChange(ent);

    expect(ent.client?.newweapon).toBe(FindItem("hyperblaster"));
  });

  test("shells+super shotgun requires more than 1 shell, otherwise falls to shotgun", () => {
    setupWorld();
    const ent = makePlayer(1);
    inv(ent, "shells", 1); // exactly 1, not > 1
    inv(ent, "super shotgun", 1);
    inv(ent, "shotgun", 1);

    NoAmmoWeaponChange(ent);

    expect(ent.client?.newweapon).toBe(FindItem("shotgun"));
  });

  test("with nothing else available, falls all the way back to the blaster", () => {
    setupWorld();
    const ent = makePlayer(1);

    NoAmmoWeaponChange(ent);

    expect(ent.client?.newweapon).toBe(FindItem("blaster"));
  });
});

describe("Think_Weapon", () => {
  test("calls the current weapon's weaponthink", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    const calls: EdictT[] = [];
    const item = Object.assign(new GItemT(), {
      weaponthink: (e: EdictT) => calls.push(e),
    });
    client.pers.weapon = item;
    ent.health = 100;

    Think_Weapon(ent);

    expect(calls).toEqual([ent]);
  });

  test("when just died, puts the weapon away instead of thinking it", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    const calls: EdictT[] = [];
    const item = Object.assign(new GItemT(), {
      weaponthink: (e: EdictT) => calls.push(e),
    });
    client.pers.weapon = item;
    client.newweapon = item;
    ent.health = 0; // "just died"

    Think_Weapon(ent);

    expect(calls).toEqual([]); // ChangeWeapon drops pers.weapon to null first
    expect(client.pers.weapon).toBeNull();
    expect(client.ps.gunindex).toBe(0);
  });
});

describe("ChangeWeapon / Weapon_Generic", () => {
  test("WEAPON_ACTIVATING advances gunframe until FRAME_ACTIVATE_LAST, then flips to WEAPON_READY at FRAME_IDLE_FIRST", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    // mirrors Weapon_Blaster's own frame numbers: Weapon_Generic(ent, 4, 8, 52, 55, ...)
    const FRAME_ACTIVATE_LAST = 4;
    const FRAME_FIRE_LAST = 8;
    const FRAME_IDLE_LAST = 52;
    const FRAME_DEACTIVATE_LAST = 55;
    const fireCalls: EdictT[] = [];
    const item = Object.assign(new GItemT(), {
      weaponthink: (e: EdictT) =>
        Weapon_Generic(e, FRAME_ACTIVATE_LAST, FRAME_FIRE_LAST, FRAME_IDLE_LAST, FRAME_DEACTIVATE_LAST, [19, 32], [5], () =>
          fireCalls.push(e),
        ),
    });

    client.newweapon = item;
    ChangeWeapon(ent);

    expect(client.pers.weapon).toBe(item);
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_ACTIVATING);
    expect(client.ps.gunframe).toBe(0);

    // frames 0 -> 1 -> 2 -> 3 -> 4 (still activating each step)
    for (let expected = 1; expected <= FRAME_ACTIVATE_LAST; expected++) {
      Think_Weapon(ent);
      expect(client.weaponstate).toBe(WeaponstateT.WEAPON_ACTIVATING);
      expect(client.ps.gunframe).toBe(expected);
    }

    // the next think sees gunframe === FRAME_ACTIVATE_LAST and flips to READY
    Think_Weapon(ent);
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_READY);
    expect(client.ps.gunframe).toBe(FRAME_FIRE_LAST + 1); // FRAME_IDLE_FIRST
    expect(fireCalls).toEqual([]); // never reached WEAPON_FIRING
  });

  test("WEAPON_DROPPING at FRAME_DEACTIVATE_LAST calls back into ChangeWeapon and stows the weapon", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    const FRAME_DEACTIVATE_LAST = 55;
    const item = Object.assign(new GItemT(), {
      weaponthink: (e: EdictT) => Weapon_Generic(e, 4, 8, 52, FRAME_DEACTIVATE_LAST, [], [5], () => {}),
    });

    client.pers.weapon = item;
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    client.ps.gunframe = FRAME_DEACTIVATE_LAST;
    client.newweapon = null; // nothing to switch to -> "dead" branch

    Think_Weapon(ent);

    expect(client.pers.weapon).toBeNull();
    expect(client.ps.gunindex).toBe(0);
  });
});

describe("Machinegun_Fire", () => {
  test("consumes one round of ammo and records a machinegun_shots-scaled kick", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    client.buttons = 1; // BUTTON_ATTACK
    client.ammo_index = 7;
    client.pers.inventory[7] = 50;
    client.machinegun_shots = 3;
    client.ps.gunframe = 0;

    Machinegun_Fire(ent);

    expect(client.pers.inventory[7]).toBe(49);
    // kick_angles[0] is set from the *pre-increment* shot count
    expect(client.kick_angles[0]).toBeCloseTo(3 * -1.5, 5);
    expect(client.machinegun_shots).toBe(4);
    expect(client.ps.gunframe).toBe(5);
  });

  test("releasing the attack button resets machinegun_shots and just advances the frame", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    client.buttons = 0;
    client.machinegun_shots = 6;
    client.ps.gunframe = 4;

    Machinegun_Fire(ent);

    expect(client.machinegun_shots).toBe(0);
    expect(client.ps.gunframe).toBe(5);
  });

  test("out of ammo jumps to the noammo frame and calls NoAmmoWeaponChange", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("unreachable");

    client.buttons = 1;
    client.ammo_index = 7;
    client.pers.inventory[7] = 0;

    Machinegun_Fire(ent);

    expect(client.ps.gunframe).toBe(6);
    expect(client.newweapon).toBe(FindItem("blaster")); // NoAmmoWeaponChange's ultimate fallback
  });
});
