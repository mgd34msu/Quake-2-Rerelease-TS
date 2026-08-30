/*
Unit tests for this unit's ctf/p_weapon.c delta (49 lines vs game/p_weapon.c):
Weapon_Generic split into a static Weapon_Generic2 plus an exported
Weapon_Generic wrapper that (a) lets the "instantweap" cvar skip the
activate/deactivate animations entirely, (b) re-runs a weapon-think frame a
second time when CTFApplyHaste(ent) (tech3) is true and the weapon state did
not change, (c) always re-runs once for the grapple weapon while it is not
WEAPON_FIRING (independent of haste), and (d) gates the quad-fire sound
behind CTFApplyStrengthSound(ent) (tech2) and adds a CTFApplyHasteSound(ent)
call on every fire dispatch.

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled after test/ctf_items.test.ts's setupWorld/makePlayer
pattern and test/p_weapon.test.ts's fake GameImports for the base-game
p_weapon.c suite.
*/

import { describe, expect, test } from "bun:test";
import type { Edict, GameImports, GTraceT } from "../src/ctf/game";
import { GetGameAPI } from "../src/ctf/g_main";
import { EdictT, g_edicts, GClientT, game, gameCvars, GItemT, globals, level, SetGEdicts, WeaponstateT } from "../src/ctf/g_local";
import { FindItemByClassname, InitItems, ITEM_INDEX, SetItemNames } from "../src/ctf/g_items";
import { ChangeWeapon, Weapon_Generic } from "../src/ctf/p_weapon";
import { vec3 } from "../src/shared/math";
import { BUTTON_ATTACK, CplaneT, CvarT } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports -- records gi.sound()/gi.soundindex() calls so the
// quad/strength/haste sound gating (CTFApplyStrengthSound/CTFApplyHasteSound)
// is directly observable; everything else is a no-op stub, same shape as
// test/ctf_items.test.ts's buildFakeImports.
// ---------------------------------------------------------------------------

interface RecordedSound {
  channel: number;
  name: string;
}

function defaultTrace(): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

function buildFakeImports(soundLog: RecordedSound[]): GameImports {
  const soundNames: string[] = [];
  function soundindex(name: string): number {
    let idx = soundNames.indexOf(name);
    if (idx === -1) {
      idx = soundNames.length;
      soundNames.push(name);
    }
    return idx;
  }

  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: (_ent: Edict, channel: number, soundIdx: number) => {
      soundLog.push({ channel, name: soundNames[soundIdx] ?? "" });
    },
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex: () => 1,
    soundindex,
    imageindex: () => 0,
    setmodel: () => {},
    trace: () => defaultTrace(),
    pointcontents: () => 0,
    inPVS: () => false,
    inPHS: () => false,
    SetAreaPortalState: () => {},
    AreasConnected: () => false,
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

const MAXENTITIES = 16;
const MAXCLIENTS = 2;

function setupWorld(soundLog: RecordedSound[]): void {
  GetGameAPI(buildFakeImports(soundLog));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());

  level.clear();
  // CTFApplyStrengthSound/CTFApplyHasteSound gate on `ctf_techsndtime <
  // level.time`; a fresh GClientT's ctf_techsndtime is 0, so level.time must
  // be > 0 for the first fire of a test to be allowed to play its sound.
  level.time = 10;

  globals.num_edicts = MAXENTITIES;

  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
  gameCvars.instantweap = fakeCvar(0);

  // g_items.c's InitItems()/SetItemNames() are called from InitGame/
  // SP_worldspawn in the real boot sequence; ITEMLIST/game.num_items must be
  // populated before FindItemByClassname("weapon_grapple"/"item_tech2"/
  // "item_tech3") can resolve.
  InitItems();
  SetItemNames();
}

function makePlayer(index: number): EdictT {
  const ent = g_edicts[index];
  ent.inuse = true;
  ent.health = 100;
  ent.deadflag = 0;
  ent.s.modelindex = 255;
  ent.client = new GClientT();
  return ent;
}

function requireItem(item: ReturnType<typeof FindItemByClassname>): GItemT {
  if (item === null) throw new Error("expected item lookup to succeed");
  return item;
}

// Assigning `client.weaponstate = WeaponstateT.WEAPON_X` directly narrows the
// property to that literal for the rest of the enclosing scope; routing the
// write through a function call keeps every later `expect(client.weaponstate)`
// comparable against any WeaponstateT member instead of just the one last
// assigned literally.
function setWeaponstate(client: GClientT, state: WeaponstateT): void {
  client.weaponstate = state;
}

// Frame constants lifted from the real callers in this unit's SCOPE:
// Weapon_Blaster(ent) -> Weapon_Generic(ent, 4, 8, 52, 55, [19, 32], [5], ...)
// CTFWeapon_Grapple(ent) -> Weapon_Generic(ent, 5, 9, 31, 36, [10, 18, 27, 0], [6, 0], ...)
const BLASTER_FRAMES = { activateLast: 4, fireLast: 8, idleLast: 52, deactivateLast: 55, pause: [19, 32], fire: [5] };
const GRAPPLE_FRAMES = { activateLast: 5, fireLast: 9, idleLast: 31, deactivateLast: 36, pause: [10, 18, 27, 0], fire: [6, 0] };

// ---------------------------------------------------------------------------

describe("Weapon_Generic ctf delta -- instantweap", () => {
  test("instantweap=1 activates the weapon in one call regardless of gunframe", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_blaster"));
    setWeaponstate(client, WeaponstateT.WEAPON_ACTIVATING);
    client.ps.gunframe = 0; // deliberately not FRAME_ACTIVATE_LAST (4)
    gameCvars.instantweap = fakeCvar(1);

    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {},
    );

    // base game would leave weaponstate ACTIVATING (gunframe 0 != 4) and only
    // gunframe++ once; instantweap forces READY immediately and sets
    // gunframe to FRAME_IDLE_FIRST (9). 3.21 dropped the recursive
    // Weapon_Generic2 call this ctf fork used to make here (a self-inflicted
    // double-advance bug in 3.19/3.20 -- see ctf/p_weapon.c's 3.21 diff), so
    // gunframe no longer advances a second time within this call.
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_READY);
    expect(client.ps.gunframe).toBe(9);
  });

  test("instantweap=0 (default) preserves the base-game step-by-step activation", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_blaster"));
    setWeaponstate(client, WeaponstateT.WEAPON_ACTIVATING);
    client.ps.gunframe = 0;
    // gameCvars.instantweap left at 0 by setupWorld

    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {},
    );

    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_ACTIVATING);
    expect(client.ps.gunframe).toBe(1);
  });

  test("instantweap=1 swaps weapons immediately via ChangeWeapon instead of playing the deactivate animation", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    const blaster = requireItem(FindItemByClassname("weapon_blaster"));
    const shotgun = requireItem(FindItemByClassname("weapon_shotgun"));
    client.pers.weapon = blaster;
    client.newweapon = shotgun;
    setWeaponstate(client, WeaponstateT.WEAPON_READY);
    client.ps.gunframe = 20;
    gameCvars.instantweap = fakeCvar(1);

    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {},
    );

    expect(client.pers.weapon).toBe(shotgun);
    expect(client.newweapon).toBeNull();
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_ACTIVATING);
    expect(client.ps.gunframe).toBe(0);
  });

  test("instantweap=0 (default) plays the deactivate animation instead of switching immediately", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    const blaster = requireItem(FindItemByClassname("weapon_blaster"));
    const shotgun = requireItem(FindItemByClassname("weapon_shotgun"));
    client.pers.weapon = blaster;
    client.newweapon = shotgun;
    setWeaponstate(client, WeaponstateT.WEAPON_READY);
    client.ps.gunframe = 20;

    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {},
    );

    expect(client.pers.weapon).toBe(blaster);
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_DROPPING);
    expect(client.ps.gunframe).toBe(BLASTER_FRAMES.idleLast + 1); // FRAME_DEACTIVATE_FIRST
  });
});

describe("Weapon_Generic ctf delta -- CTFApplyHaste (tech3) re-run", () => {
  test("a hasted client fires twice per Weapon_Generic call while it stays in WEAPON_FIRING", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_blaster"));
    setWeaponstate(client, WeaponstateT.WEAPON_FIRING);
    client.ps.gunframe = BLASTER_FRAMES.fire[0]; // 5, a fire frame
    const tech3 = requireItem(FindItemByClassname("item_tech3"));
    client.pers.inventory[ITEM_INDEX(tech3)] = 1;

    let fireCount = 0;
    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {
        fireCount++;
      },
    );

    expect(fireCount).toBe(2);
  });

  test("a non-hasted client fires once per Weapon_Generic call", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_blaster"));
    setWeaponstate(client, WeaponstateT.WEAPON_FIRING);
    client.ps.gunframe = BLASTER_FRAMES.fire[0];
    // no item_tech3 in inventory

    let fireCount = 0;
    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {
        fireCount++;
      },
    );

    expect(fireCount).toBe(1);
  });
});

describe("Weapon_Generic ctf delta -- grapple re-run without haste", () => {
  test("the grapple weapon re-runs a frame once even without haste, as long as it stays out of WEAPON_FIRING", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_grapple")); // pickup_name "Grapple"
    setWeaponstate(client, WeaponstateT.WEAPON_READY);
    client.ps.gunframe = 20; // idle, not a pause frame, not idleLast
    client.buttons = 0;
    // no item_tech3: haste is off, so this re-run is purely the grapple special-case

    Weapon_Generic(
      ent,
      GRAPPLE_FRAMES.activateLast,
      GRAPPLE_FRAMES.fireLast,
      GRAPPLE_FRAMES.idleLast,
      GRAPPLE_FRAMES.deactivateLast,
      GRAPPLE_FRAMES.pause,
      GRAPPLE_FRAMES.fire,
      () => {},
    );

    expect(client.ps.gunframe).toBe(22); // 20 -> 21 -> 22 (two idle advances)
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_READY);
  });

  test("a non-grapple weapon in the same idle state only advances once (baseline)", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_blaster"));
    setWeaponstate(client, WeaponstateT.WEAPON_READY);
    client.ps.gunframe = 20;
    client.buttons = 0;

    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {},
    );

    expect(client.ps.gunframe).toBe(21);
  });

  test("the grapple weapon does not re-run once it is WEAPON_FIRING, even when hasted", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_grapple"));
    setWeaponstate(client, WeaponstateT.WEAPON_FIRING);
    client.ps.gunframe = GRAPPLE_FRAMES.fire[0]; // 6, a fire frame
    client.buttons = BUTTON_ATTACK;
    const tech3 = requireItem(FindItemByClassname("item_tech3"));
    client.pers.inventory[ITEM_INDEX(tech3)] = 1; // haste on -- must not matter here

    let fireCount = 0;
    Weapon_Generic(
      ent,
      GRAPPLE_FRAMES.activateLast,
      GRAPPLE_FRAMES.fireLast,
      GRAPPLE_FRAMES.idleLast,
      GRAPPLE_FRAMES.deactivateLast,
      GRAPPLE_FRAMES.pause,
      GRAPPLE_FRAMES.fire,
      () => {
        fireCount++;
      },
    );

    expect(fireCount).toBe(1);
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_FIRING);
  });
});

describe("Weapon_Generic ctf delta -- quad/strength/haste fire sound gating", () => {
  function fireOnceWithSound(soundLog: RecordedSound[], setInventory: (client: GClientT) => void): void {
    const ent = makePlayer(1);
    const client = ent.client!;
    client.pers.weapon = requireItem(FindItemByClassname("weapon_blaster"));
    setWeaponstate(client, WeaponstateT.WEAPON_FIRING);
    client.ps.gunframe = BLASTER_FRAMES.fire[0];
    level.framenum = 100;
    setInventory(client);

    Weapon_Generic(
      ent,
      BLASTER_FRAMES.activateLast,
      BLASTER_FRAMES.fireLast,
      BLASTER_FRAMES.idleLast,
      BLASTER_FRAMES.deactivateLast,
      BLASTER_FRAMES.pause,
      BLASTER_FRAMES.fire,
      () => {},
    );
  }

  test("quad active + no tech2: plays the plain quad sound", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    fireOnceWithSound(soundLog, (client) => {
      client.quad_framenum = 200; // > level.framenum (100): quad active
    });

    expect(soundLog.some((s) => s.name === "items/damage3.wav")).toBe(true);
  });

  test("quad active + tech2 held: plays the strength sound instead of the quad sound", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    fireOnceWithSound(soundLog, (client) => {
      client.quad_framenum = 200;
      const tech2 = requireItem(FindItemByClassname("item_tech2"));
      client.pers.inventory[ITEM_INDEX(tech2)] = 1;
    });

    expect(soundLog.some((s) => s.name === "items/damage3.wav")).toBe(false);
    expect(soundLog.some((s) => s.name === "ctf/tech2x.wav")).toBe(true);
  });

  test("tech3 held: plays the haste sound on fire regardless of quad/strength", () => {
    const soundLog: RecordedSound[] = [];
    setupWorld(soundLog);
    fireOnceWithSound(soundLog, (client) => {
      const tech3 = requireItem(FindItemByClassname("item_tech3"));
      client.pers.inventory[ITEM_INDEX(tech3)] = 1;
    });

    expect(soundLog.some((s) => s.name === "ctf/tech3.wav")).toBe(true);
  });
});

// Sanity: ChangeWeapon itself is untouched by this delta (imported above only
// to exercise the instantweap path through Weapon_Generic, not tested here
// directly -- confirms the import resolves through the p_weapon.ts <->
// g_ctf.ts value cycle without a TDZ failure at module load).
describe("module load sanity", () => {
  test("ChangeWeapon is a function (p_weapon.ts <-> g_ctf.ts cycle resolved)", () => {
    expect(typeof ChangeWeapon).toBe("function");
  });
});
