/*
Unit tests for the xatrix mission-pack core: GetGameAPI boot, the itemlist
delta (43 baseq2 entries + 6 xatrix entries), classname-registry spawning via
g_spawn.ts's ED_CallSpawn, and one new weapon fired end to end
(weapon_boomer / "Ionripper", src/xatrix/p_weapon.ts's Weapon_Ionripper ->
src/xatrix/g_weapon.ts's fire_ionripper).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled on test/ctf_core.test.ts's and test/ctf_weapon.test.ts's
setupWorld/makePlayer/fake-GameImports pattern.
*/

import { describe, expect, test } from "bun:test";
import type { Edict, GameImports, GTraceT } from "../src/xatrix/game";
import { GAME_API_VERSION } from "../src/xatrix/game";
import { GetGameAPI } from "../src/xatrix/g_main";
import { InitGame } from "../src/xatrix/g_save";
import {
  AmmoT,
  EdictT,
  g_edicts,
  GClientT,
  game,
  gameCvars,
  globals,
  level,
  MovetypeT,
  SetGEdicts,
  WeaponstateT,
} from "../src/xatrix/g_local";
import { droptofloor, FindItem, GetItemByIndex, InitItems, ITEM_INDEX, itemlist, SetItemNames } from "../src/xatrix/g_items";
import { ED_CallSpawn } from "../src/xatrix/g_spawn";
import { G_Spawn } from "../src/xatrix/g_utils";
import { Weapon_Ionripper } from "../src/xatrix/p_weapon";
import { vec3 } from "../src/shared/math";
import { BUTTON_ATTACK, CplaneT, type CvarT as CvarTType, CvarT, RF_FULLBRIGHT } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports -- every call this suite's code paths make is stubbed;
// modeled on test/ctf_core.test.ts's makeFakeGameImports.
// ---------------------------------------------------------------------------

interface Recorder {
  dprintf: string[];
  linkentity: Edict[];
}

function makeRecorder(): Recorder {
  return { dprintf: [], linkentity: [] };
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

function buildFakeImports(rec: Recorder): GameImports {
  return {
    bprintf: () => {},
    dprintf: (fmt: string) => {
      rec.dprintf.push(fmt);
    },
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex: () => 1,
    soundindex: () => 1,
    imageindex: () => 0,
    setmodel: () => {},
    trace: () => defaultTrace(),
    pointcontents: () => 0,
    inPVS: () => false,
    inPHS: () => false,
    SetAreaPortalState: () => {},
    AreasConnected: () => false,
    linkentity: (ent: Edict) => {
      rec.linkentity.push(ent);
    },
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

function fakeCvar(value: number): CvarTType {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 16;
const MAXCLIENTS = 1;

// Deliberately does NOT call InitGame(): g_save.ts's InitGame re-allocates
// g_edicts itself via SetGEdicts(makeEdicts(numEntities)) sized off
// gameCvars.maxentities, which would stomp the hand-sized array this helper
// builds below. Same reasoning as test/ctf_core.test.ts's and
// test/ctf_weapon.test.ts's setupWorld, which skip InitGame() for the exact
// same reason; InitGame's own boot behavior is exercised in isolation by
// the "xatrix GetGameAPI / InitGame boot" describe block below instead.
function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(buildFakeImports(rec));

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

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;

  InitItems();
  SetItemNames();

  return rec;
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

function requireItem(item: ReturnType<typeof FindItem>) {
  if (item === null) throw new Error("expected item lookup to succeed");
  return item;
}

// Assigning `client.weaponstate = WeaponstateT.WEAPON_X` directly narrows the
// property to that literal for the rest of the enclosing scope; routing the
// write through a function call keeps every later `expect(client.weaponstate)`
// comparable against any WeaponstateT member instead of just the one last
// assigned literally (same fix as test/ctf_weapon.test.ts's setWeaponstate).
function setWeaponstate(client: GClientT, state: WeaponstateT): void {
  client.weaponstate = state;
}

// ---------------------------------------------------------------------------

describe("xatrix GetGameAPI / InitGame boot", () => {
  test("returns exports whose Init is g_save.ts's real InitGame (function identity)", () => {
    const rec = makeRecorder();
    const ge = GetGameAPI(buildFakeImports(rec));

    expect(ge.apiversion).toBe(GAME_API_VERSION);
    expect(ge.Init).toBe(InitGame);
  });

  test("InitGame runs without throwing and prints the boot banner", () => {
    // Isolated from setupWorld() on purpose: InitGame() allocates its own
    // g_edicts via SetGEdicts(makeEdicts(...)), so this call is exercised
    // standalone rather than against setupWorld()'s hand-sized array.
    const rec = makeRecorder();
    GetGameAPI(buildFakeImports(rec));
    expect(() => InitGame()).not.toThrow();
    expect(rec.dprintf.some((s) => s.includes("InitGame"))).toBe(true);
  });
});

describe("xatrix itemlist delta -- 43 baseq2 entries + 6 xatrix entries", () => {
  test("InitItems accounts for the 6 new entries (43 base + ammo_trap + weapon_boomer + weapon_phalanx + ammo_magslug + item_quadfire + key_green_key)", () => {
    setupWorld();

    // itemlist() includes index 0 ("leave index 0 alone") and the trailing
    // end-of-list marker; game.num_items excludes the end-of-list marker,
    // matching the C `sizeof(itemlist)/sizeof(itemlist[0]) - 1` calculation.
    expect(itemlist().length).toBe(game.num_items + 1);
    expect(game.num_items).toBe(48);
  });

  test("ammo_trap is wired to Weapon_Trap and tagged AMMO_TRAP", () => {
    setupWorld();
    const item = requireItem(FindItem("Trap"));
    expect(item.classname).toBe("ammo_trap");
    expect(item.tag).toBe(AmmoT.AMMO_TRAP);
    expect(item.weaponthink).not.toBeNull();
  });

  test("weapon_boomer (Ionripper) and weapon_phalanx (Phalanx) are registered weapons", () => {
    setupWorld();
    const ionripper = requireItem(FindItem("Ionripper"));
    expect(ionripper.classname).toBe("weapon_boomer");
    expect(ionripper.ammo).toBe("Cells");

    const phalanx = requireItem(FindItem("Phalanx"));
    expect(phalanx.classname).toBe("weapon_phalanx");
    expect(phalanx.ammo).toBe("Mag Slug");
  });

  test("ammo_magslug and item_quadfire and key_green_key round out the 6 new entries", () => {
    setupWorld();
    expect(requireItem(FindItem("Mag Slug")).tag).toBe(AmmoT.AMMO_MAGSLUG);
    expect(requireItem(FindItem("DualFire Damage")).classname).toBe("item_quadfire");
    expect(requireItem(FindItem("Green Key")).classname).toBe("key_green_key");
  });

  test("GetItemByIndex round-trips ITEM_INDEX for a new xatrix item", () => {
    setupWorld();
    const item = requireItem(FindItem("Ionripper"));
    const index = ITEM_INDEX(item);
    expect(GetItemByIndex(index)).toBe(item);
  });
});

describe("spawning a minimal world via g_spawn.ts's classname registry", () => {
  test("ED_CallSpawn dispatches a hand-built ammo_trap edict to SpawnItem (droptofloor + item link)", () => {
    const rec = setupWorld();

    const ent = G_Spawn();
    ent.classname = "ammo_trap";

    ED_CallSpawn(ent);

    // SpawnItem() (g_items.ts) doesn't link the item itself -- it schedules
    // droptofloor as a think 2 frames out ("items start after other
    // solids"), matching the C's `ent->nextthink = level.time + 2*FRAMETIME;
    // ent->think = droptofloor;`. Synchronous effects first:
    expect(ent.item).not.toBeNull();
    expect(ent.item?.classname).toBe("ammo_trap");
    expect(ent.think).toBe(droptofloor);
    expect(ent.nextthink).toBeGreaterThan(level.time);

    // Simulate the engine running that scheduled think one frame later, the
    // same way SV_RunEntity would: droptofloor settles the item and links it.
    ent.think?.(ent);
    expect(rec.linkentity).toContain(ent as unknown as Edict);
  });
});

describe("firing a new xatrix weapon deterministically -- Ionripper", () => {
  test("Weapon_Ionripper fires immediately on WEAPON_READY + BUTTON_ATTACK, consumes ammo, and spawns a MOVETYPE_WALLBOUNCE projectile", () => {
    setupWorld();
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("makePlayer did not attach a client");

    const ionripper = requireItem(FindItem("Ionripper"));
    const cells = requireItem(FindItem("Cells"));
    const ammoIndex = ITEM_INDEX(cells);

    client.pers.weapon = ionripper;
    client.ammo_index = ammoIndex;
    client.pers.inventory[ammoIndex] = 10;
    setWeaponstate(client, WeaponstateT.WEAPON_READY);
    client.ps.gunframe = 0;
    client.buttons = BUTTON_ATTACK;
    client.latched_buttons = BUTTON_ATTACK;

    // deathmatch=1 (set by setupWorld) and no quad damage active -> the
    // deathmatch-tuned-down damage/kick branch in weapon_ionripper_fire.
    Weapon_Ionripper(ent);

    // Weapon_Generic's WEAPON_READY branch sets gunframe to FRAME_FIRE_FIRST
    // (FRAME_ACTIVATE_LAST + 1 = 5) and WEAPON_FIRING in the same call as the
    // fire_frames match ([5]), so the shot goes out on this single call --
    // deterministic regardless of the crandom() jitter fire_ionripper adds
    // to the aim angle.
    expect(client.weaponstate).toBe(WeaponstateT.WEAPON_FIRING);
    expect(client.ps.gunframe).toBe(6);
    expect(client.pers.inventory[ammoIndex]).toBe(10 - ionripper.quantity);

    // G_Spawn() hands out the first free edict past the player range
    // (index maxclients + 1 = 1); that's the ionripper projectile.
    const projectile = g_edicts[MAXCLIENTS + 1];
    expect(projectile.inuse).toBe(true);
    expect(projectile.owner).toBe(ent);
    expect(projectile.movetype).toBe(MovetypeT.MOVETYPE_WALLBOUNCE);
    expect(projectile.dmg_radius).toBe(100);
    // deathmatch tone-down: damage 30, not the singleplayer 50.
    expect(projectile.dmg).toBe(30);
    expect(projectile.s.renderfx & RF_FULLBRIGHT).not.toBe(0);
  });
});
