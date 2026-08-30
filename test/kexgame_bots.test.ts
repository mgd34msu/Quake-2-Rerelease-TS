/*
Unit tests for the kex bots/ port (src/kexgame/bots/{bot_utils,bot_exports,
bot_think,bot_debug}.ts).

Self-sufficient per .orch/preferences.md rule 13: wires up its own fake
KexGameImports/KexGameExports and never relies on another test file having
run first. Fixture modeled after test/kexgame_g_spawn.test.ts's own fake-gi
setup, trimmed to what the bots/ subsystem actually calls, plus a settable
`traceOverride` for FindActorUnderCrosshair/UpdateMoveToPointDebug's
`gi.trace` call.

Scope (citations are to
~/Projects/quake2-rerelease-dll/rerelease/bots/*.cpp):
  - SP_info_nav_lock / info_nav_lock_use (bot_utils.cpp:382-413): missing
    targetname / missing target both free the entity; a valid spawn sets
    SVF_NOCLIENT and installs the use function; the use function toggles
    FL_LOCKED on every SVF_DOOR entity sharing the lock's target as their
    targetname, and warns-and-skips a matching non-door entity instead of
    touching it.
  - FindLocalPlayer / FindFirstBot / FindFirstMonster (bot_utils.cpp:420-
    492): linear g_edicts scans, each with its own inuse/health/svflags
    filter.
  - FindActorUnderCrosshair (bot_utils.cpp:494-529): a `gi.trace`-backed
    lookup, exercised via a settable fake trace result.
  - Bot_GetItemID (bot_exports.cpp:130-151): "none" -> Item_Null, empty ->
    Item_Invalid, a real classname -> its real id, an unknown classname ->
    Item_Invalid.
  - Bot_UseItem (bot_exports.cpp:92-123): the real inventory/selected_item
    dispatch path through a real, non-weapon itemlist entry (item_quad,
    Use_Quad) and the "item not carried -> no-op" path.
  - Bot_SetWeapon (bot_exports.cpp:12-61): every early-return guard (range,
    non-bot, no client, zero inventory, already-equipped, mid-switch,
    non-weapon item) plus the real end-to-end dispatch path (a temporarily
    substituted, restored itemlist[] weapon entry) including the
    g_instant_weapon_switch cvar poke-and-restore.
  - Bot_TriggerEdict (bot_exports.cpp:68-85): calls both `use` and `touch`
    when present; no-ops for a non-bot or a not-in-use edict/target.
  - Edict_ForceLookAtPoint (bot_exports.cpp:158-177): angle math against a
    known point, both for a client edict (delta_angles/viewangles reset)
    and a non-client edict (no crash, no client-only field writes).
  - Bot_PickedUpItem (bot_exports.cpp:186-188): reads item_picked_up_by at
    `bot.s.number - 1`.
  - Bot_BeginFrame / Bot_EndFrame (bot_think.cpp:12-23): real empty bodies,
    callable without throwing.
  - Bot_UpdateDebug (bot_debug.cpp:161-178): the default-cvar ("cheats"=="0")
    no-op path, and the "cheats" on but no local player path.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, CvarFlagsT, ContentsT, SvflagsT, GoalReturnCode } from "../src/kexapi/game";
import { type EdictT, EntFlagsT, ItemIdT, ItemFlagsT, type GitemT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, globals, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO } from "../src/kexgame/gtime";
import { defaultGClient } from "../src/kexgame/p_client";
import { itemlist } from "../src/kexgame/g_items";
import { SP_info_nav_lock, FindLocalPlayer, FindFirstBot, FindFirstMonster, FindActorUnderCrosshair } from "../src/kexgame/bots/bot_utils";
import { Bot_SetWeapon, Bot_TriggerEdict, Bot_UseItem, Bot_GetItemID, Edict_ForceLookAtPoint, Bot_PickedUpItem } from "../src/kexgame/bots/bot_exports";
import { Bot_BeginFrame, Bot_EndFrame } from "../src/kexgame/bots/bot_think";
import { Bot_UpdateDebug } from "../src/kexgame/bots/bot_debug";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture
// ---------------------------------------------------------------------------

function noHitTrace(end: Vec3): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: ContentsT.CONTENTS_NONE,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

let comPrints: string[];
let traceOverride: KexTraceT | null = null;

function makeFakeGameImports(): KexGameImports {
  const cvars = new Map<string, CvarT>();
  function getCvar(name: string, value: string): CvarT {
    let c = cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value);
      cvars.set(name, c);
    }
    return c;
  }

  const modelNamesById: string[] = [""];
  function modelindex(name: string): number {
    let idx = modelNamesById.indexOf(name);
    if (idx === -1) {
      idx = modelNamesById.length;
      modelNamesById.push(name);
    }
    return idx;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print(msg: string) {
      comPrints.push(msg);
    },
    Client_Print() {},
    Center_Print() {},
    sound() {},
    positioned_sound() {},
    local_sound() {},
    configstring() {},
    get_configstring() {
      return "";
    },
    Com_Error(message): never {
      throw new Error(`gi.Com_Error: ${message}`);
    },
    modelindex,
    soundindex() {
      return 0;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(_start, _mins, _maxs, end) {
      return traceOverride ?? noHitTrace(end);
    },
    clip(_entity, _start, _mins, _maxs, end) {
      return noHitTrace(end);
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
    linkentity() {},
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte() {},
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString() {},
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    WriteEntity() {},
    TagMalloc() {
      return null;
    },
    TagFree() {},
    FreeTags() {},
    cvar(var_name, value) {
      return getCvar(var_name, value ?? "0");
    },
    cvar_set(var_name, value) {
      return getCvar(var_name, value);
    },
    cvar_forceset(var_name, value) {
      return getCvar(var_name, value);
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
    GetExtension() {
      return null;
    },
    Bot_RegisterEdict() {},
    Bot_UnRegisterEdict() {},
    Bot_MoveToPoint() {
      return GoalReturnCode.Error;
    },
    Bot_FollowActor() {
      return GoalReturnCode.Error;
    },
    GetPathToGoal() {
      return false;
    },
    Loc_Print() {},
    Draw_Line() {},
    Draw_Point() {},
    Draw_Circle() {},
    Draw_Bounds() {},
    Draw_Sphere() {},
    Draw_OrientedWorldText() {},
    Draw_StaticWorldText() {},
    Draw_Cylinder() {},
    Draw_Ray() {},
    Draw_Arrow() {},
    ReportMatchDetails_Multicast() {},
    ServerFrame() {
      return 0;
    },
    SendToClipBoard() {},
    Info_ValueForKey() {
      return 0;
    },
    Info_RemoveKey() {
      return false;
    },
    Info_SetValueForKey() {
      return false;
    },
  };
}

function makeFakeGameExports(edicts: EdictT[], numEdicts: number): KexGameExports {
  return {
    apiversion: GAME_API_VERSION,
    PreInit() {},
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGameJson() {
      return null;
    },
    ReadGameJson() {},
    WriteLevelJson() {
      return null;
    },
    ReadLevelJson() {},
    CanSave() {
      return true;
    },
    ClientChooseSlot() {
      return null;
    },
    ClientConnect() {
      return false;
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    PrepFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: numEdicts,
    max_edicts: edicts.length,
    server_flags: 0,
    Pmove() {},
    GetExtension() {
      return null;
    },
    Bot_SetWeapon() {},
    Bot_TriggerEdict() {},
    Bot_UseItem() {},
    Bot_GetItemID() {
      return 0;
    },
    Edict_ForceLookAtPoint() {},
    Bot_PickedUpItem() {
      return false;
    },
    Entity_IsVisibleToPlayer() {
      return false;
    },
    GetShadowLightData() {
      return null;
    },
  };
}

const NUM_EDICTS = 16;
let edicts: EdictT[];

function setupWorld(): void {
  edicts = [];
  for (let i = 0; i < NUM_EDICTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = 0;
  game.maxentities = NUM_EDICTS;
  game.clients = [];
  level.time = GTIME_ZERO;

  comPrints = [];
  traceOverride = null;
  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, NUM_EDICTS));
}

function makeBot(index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.svflags = SvflagsT.SVF_PLAYER | SvflagsT.SVF_BOT;
  e.client = defaultGClient();
  e.health = 100;
  return e;
}

function makePlayer(index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.svflags = SvflagsT.SVF_PLAYER;
  e.client = defaultGClient();
  e.health = 100;
  return e;
}

function makeMonster(index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.svflags = SvflagsT.SVF_MONSTER;
  e.health = 100;
  return e;
}

beforeEach(() => {
  setupWorld();
});

// ---------------------------------------------------------------------------
// SP_info_nav_lock / info_nav_lock_use -- bot_utils.cpp:382-413
// ---------------------------------------------------------------------------

describe("SP_info_nav_lock (bot_utils.cpp:395-413)", () => {
  test("missing targetname frees the entity", () => {
    // index chosen above game.maxclients (0) + BODY_QUEUE_SIZE (8): G_FreeEdict
    // (g_utils.ts) is a real no-op for any index at or below that range, by
    // design -- it protects the client/body-queue block of g_edicts.
    const e = edicts[9]!;
    e.classname = "info_nav_lock";
    e.inuse = true;
    e.targetname = null;
    e.target = "door1";
    SP_info_nav_lock(e);
    expect(e.inuse).toBe(false);
    expect(e.use).toBeNull();
  });

  test("missing target frees the entity", () => {
    const e = edicts[9]!;
    e.classname = "info_nav_lock";
    e.inuse = true;
    e.targetname = "lock1";
    e.target = null;
    SP_info_nav_lock(e);
    expect(e.inuse).toBe(false);
    expect(e.use).toBeNull();
  });

  test("a valid spawn sets SVF_NOCLIENT and installs the use function", () => {
    const e = edicts[1]!;
    e.classname = "info_nav_lock";
    e.inuse = true;
    e.targetname = "lock1";
    e.target = "door1";
    SP_info_nav_lock(e);
    expect(e.inuse).toBe(true);
    expect((e.svflags & SvflagsT.SVF_NOCLIENT) !== 0).toBe(true);
    expect(e.use).not.toBeNull();
  });

  test("use() toggles FL_LOCKED on every matching SVF_DOOR entity", () => {
    const lock = edicts[1]!;
    lock.classname = "info_nav_lock";
    lock.inuse = true;
    lock.targetname = "lock1";
    lock.target = "door1";
    SP_info_nav_lock(lock);

    const door = edicts[2]!;
    door.inuse = true;
    door.targetname = "door1";
    door.svflags = SvflagsT.SVF_DOOR;
    door.flags = 0n;

    lock.use!(lock, null, null);
    expect((door.flags & EntFlagsT.FL_LOCKED) !== 0n).toBe(true);

    lock.use!(lock, null, null);
    expect((door.flags & EntFlagsT.FL_LOCKED) !== 0n).toBe(false);
  });

  test("use() warns and skips a matching non-SVF_DOOR entity instead of toggling it", () => {
    const lock = edicts[1]!;
    lock.classname = "info_nav_lock";
    lock.inuse = true;
    lock.targetname = "lock1";
    lock.target = "door1";
    SP_info_nav_lock(lock);

    const notADoor = edicts[2]!;
    notADoor.inuse = true;
    notADoor.targetname = "door1";
    notADoor.svflags = 0;
    notADoor.flags = 0n;

    lock.use!(lock, null, null);
    expect(notADoor.flags).toBe(0n);
    expect(comPrints.some((m) => m.includes("non-SVF_DOOR"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FindLocalPlayer / FindFirstBot / FindFirstMonster -- bot_utils.cpp:420-492
// ---------------------------------------------------------------------------

describe("FindLocalPlayer / FindFirstBot / FindFirstMonster (bot_utils.cpp:420-492)", () => {
  test("FindLocalPlayer skips dead players and non-players", () => {
    expect(FindLocalPlayer()).toBeNull();

    const deadPlayer = makePlayer(1);
    deadPlayer.health = 0;
    expect(FindLocalPlayer()).toBeNull();

    const alivePlayer = makePlayer(2);
    expect(FindLocalPlayer()).toBe(alivePlayer);
  });

  test("FindFirstBot requires SVF_BOT in addition to SVF_PLAYER", () => {
    makePlayer(1); // real player, not a bot
    expect(FindFirstBot()).toBeNull();

    const bot = makeBot(2);
    expect(FindFirstBot()).toBe(bot);
  });

  test("FindFirstMonster requires SVF_MONSTER and health > 0", () => {
    const deadMonster = makeMonster(1);
    deadMonster.health = 0;
    expect(FindFirstMonster()).toBeNull();

    const aliveMonster = makeMonster(2);
    expect(FindFirstMonster()).toBe(aliveMonster);
  });
});

// ---------------------------------------------------------------------------
// FindActorUnderCrosshair -- bot_utils.cpp:494-529
// ---------------------------------------------------------------------------

describe("FindActorUnderCrosshair (bot_utils.cpp:494-529)", () => {
  test("returns null for a null or not-in-use player", () => {
    expect(FindActorUnderCrosshair(null)).toBeNull();
    const notInUse = edicts[1]!;
    notInUse.client = defaultGClient();
    expect(FindActorUnderCrosshair(notInUse)).toBeNull();
  });

  test("returns null when the trace hits nothing", () => {
    const player = makePlayer(1);
    traceOverride = { ...noHitTrace(vec3(0, 0, 0)), ent: null };
    expect(FindActorUnderCrosshair(player)).toBeNull();
  });

  test("returns null when the trace hits a non-actor (no SVF_PLAYER/SVF_MONSTER)", () => {
    const player = makePlayer(1);
    const wall = edicts[3]!;
    wall.inuse = true;
    wall.svflags = 0;
    traceOverride = { ...noHitTrace(vec3(0, 0, 0)), ent: wall };
    expect(FindActorUnderCrosshair(player)).toBeNull();
  });

  test("returns null when the traced actor is dead", () => {
    const player = makePlayer(1);
    const deadMonster = makeMonster(3);
    deadMonster.health = 0;
    traceOverride = { ...noHitTrace(vec3(0, 0, 0)), ent: deadMonster };
    expect(FindActorUnderCrosshair(player)).toBeNull();
  });

  test("returns the traced actor when alive and a player/monster", () => {
    const player = makePlayer(1);
    const monster = makeMonster(3);
    traceOverride = { ...noHitTrace(vec3(0, 0, 0)), ent: monster };
    expect(FindActorUnderCrosshair(player)).toBe(monster);
  });
});

// ---------------------------------------------------------------------------
// Bot_GetItemID -- bot_exports.cpp:130-151
// ---------------------------------------------------------------------------

describe("Bot_GetItemID (bot_exports.cpp:130-151)", () => {
  test("empty classname -> Item_Invalid (-1)", () => {
    expect(Bot_GetItemID("")).toBe(-1);
  });

  test("\"none\" (case-insensitive) -> Item_Null (0)", () => {
    expect(Bot_GetItemID("none")).toBe(0);
    expect(Bot_GetItemID("NoNe")).toBe(0);
  });

  test("a real classname resolves to its real item id", () => {
    const quad = itemlist[ItemIdT.IT_ITEM_QUAD]!;
    expect(Bot_GetItemID(quad.classname!)).toBe(ItemIdT.IT_ITEM_QUAD);
  });

  test("an unknown classname -> Item_Invalid (-1)", () => {
    expect(Bot_GetItemID("not_a_real_item_classname")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Bot_UseItem -- bot_exports.cpp:92-123
// ---------------------------------------------------------------------------

describe("Bot_UseItem (bot_exports.cpp:92-123)", () => {
  test("non-bot edicts are a no-op", () => {
    const player = makePlayer(1);
    player.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD] = 1;
    Bot_UseItem(player, ItemIdT.IT_ITEM_QUAD);
    expect(player.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD]).toBe(1); // Use_Quad never ran
  });

  test("an item not carried resolves to IT_NULL via ValidateSelectedItem and is a no-op", () => {
    const bot = makeBot(1);
    // whole inventory stays zero -- SelectNextItem(IF_ANY) can't find anything.
    Bot_UseItem(bot, ItemIdT.IT_ITEM_QUAD);
    expect(bot.client!.pers.selected_item).toBe(ItemIdT.IT_NULL);
    expect(bot.client!.no_weapon_chains).toBe(false);
  });

  test("a real, carried, non-weapon item (item_quad) dispatches through to Use_Quad", () => {
    const bot = makeBot(1);
    bot.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD] = 1;
    const before = bot.client!.quad_time;

    Bot_UseItem(bot, ItemIdT.IT_ITEM_QUAD);

    expect(bot.client!.no_weapon_chains).toBe(true);
    expect(bot.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD]).toBe(0); // Use_Quad decrements it
    expect(bot.client!.quad_time).not.toBe(before); // Use_Quad extended quad_time
    expect(bot.client!.pers.selected_item).toBe(ItemIdT.IT_NULL); // cleared before use() runs
  });
});

// ---------------------------------------------------------------------------
// Bot_SetWeapon -- bot_exports.cpp:12-61
// ---------------------------------------------------------------------------

describe("Bot_SetWeapon (bot_exports.cpp:12-61)", () => {
  test("weaponIndex <= IT_NULL is a no-op", () => {
    const bot = makeBot(1);
    expect(() => Bot_SetWeapon(bot, ItemIdT.IT_NULL, false)).not.toThrow();
  });

  test("weaponIndex > IT_TOTAL is a no-op", () => {
    const bot = makeBot(1);
    expect(() => Bot_SetWeapon(bot, ItemIdT.IT_TOTAL + 1, false)).not.toThrow();
  });

  test("a non-bot edict is a no-op even with matching inventory", () => {
    const player = makePlayer(1);
    player.client!.pers.inventory[ItemIdT.IT_WEAPON_BLASTER] = 1;
    Bot_SetWeapon(player, ItemIdT.IT_WEAPON_BLASTER, false);
    expect(player.client!.no_weapon_chains).toBe(false);
  });

  test("a null client is a no-op", () => {
    const bot = edicts[1]!;
    bot.inuse = true;
    bot.svflags = SvflagsT.SVF_BOT;
    bot.client = null;
    expect(() => Bot_SetWeapon(bot, ItemIdT.IT_WEAPON_BLASTER, false)).not.toThrow();
  });

  test("zero inventory count for the weapon is a no-op", () => {
    const bot = makeBot(1);
    Bot_SetWeapon(bot, ItemIdT.IT_WEAPON_BLASTER, false);
    expect(bot.client!.no_weapon_chains).toBe(false);
  });

  test("already holding the requested weapon is a no-op", () => {
    const bot = makeBot(1);
    bot.client!.pers.inventory[ItemIdT.IT_WEAPON_BLASTER] = 1;
    bot.client!.pers.weapon = itemlist[ItemIdT.IT_WEAPON_BLASTER]!;
    Bot_SetWeapon(bot, ItemIdT.IT_WEAPON_BLASTER, false);
    expect(bot.client!.no_weapon_chains).toBe(false);
  });

  test("already mid-switch to the requested weapon is a no-op", () => {
    const bot = makeBot(1);
    bot.client!.pers.inventory[ItemIdT.IT_WEAPON_BLASTER] = 1;
    bot.client!.newweapon = itemlist[ItemIdT.IT_WEAPON_BLASTER]!;
    Bot_SetWeapon(bot, ItemIdT.IT_WEAPON_BLASTER, false);
    expect(bot.client!.no_weapon_chains).toBe(false);
  });

  test("a real, non-weapon item (item_quad) is rejected by the IF_WEAPON check", () => {
    const bot = makeBot(1);
    bot.client!.pers.inventory[ItemIdT.IT_ITEM_QUAD] = 1;
    Bot_SetWeapon(bot, ItemIdT.IT_ITEM_QUAD, false);
    expect(bot.client!.no_weapon_chains).toBe(false);
  });

  test("a real weapon item dispatches to the real Use_Weapon and switches for real", () => {
    // g_items.ts's own Use_Weapon used to be a cited throwing stub (pending
    // p_weapon.ts's Weapon_Blaster wiring, see g_items.cpp:426) -- g_items.ts
    // has since been reconciled to import p_weapon.ts's real Use_Weapon (see
    // that file's own "STUB INVENTORY" note), so this now proves
    // Bot_SetWeapon's real dispatch reaches the real itemlist entry AND
    // completes a real weapon switch (no ammo required for the blaster, so
    // Weapon_AttemptSwitch succeeds and Use_Weapon sets client.newweapon).
    const bot = makeBot(1);
    bot.client!.pers.inventory[ItemIdT.IT_WEAPON_BLASTER] = 1;
    expect(() => Bot_SetWeapon(bot, ItemIdT.IT_WEAPON_BLASTER, false)).not.toThrow();
    expect(bot.client!.no_weapon_chains).toBe(true); // set for real before dispatching to item.use
    expect(bot.client!.newweapon).toBe(itemlist[ItemIdT.IT_WEAPON_BLASTER]!); // Use_Weapon's successful-switch assignment
  });

  test("instantSwitch dispatch: real item.use + ChangeWeapon, with the g_instant_weapon_switch cvar poked and restored", () => {
    const bot = makeBot(1);
    bot.client!.pers.inventory[ItemIdT.IT_WEAPON_BLASTER] = 1;

    const original = itemlist[ItemIdT.IT_WEAPON_BLASTER]!;
    const useCalls: EdictT[] = [];
    const fakeWeapon: GitemT = {
      ...original,
      flags: ItemFlagsT.IF_WEAPON,
      view_model: "models/weapons/v_blast/tris.md2",
      weaponthink: null, // keep Weapon_RunThink's own dispatch a no-op for this test
      use: (ent, item) => {
        useCalls.push(ent);
        if (ent.client !== null) ent.client.newweapon = item;
      },
    };
    itemlist[ItemIdT.IT_WEAPON_BLASTER] = fakeWeapon;

    try {
      Bot_SetWeapon(bot, ItemIdT.IT_WEAPON_BLASTER, true);
    } finally {
      itemlist[ItemIdT.IT_WEAPON_BLASTER] = original;
    }

    expect(useCalls).toEqual([bot]);
    expect(bot.client!.pers.weapon).toBe(fakeWeapon); // ChangeWeapon really ran
    const cvar = gi.cvar("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_NOFLAGS);
    expect(cvar!.value).toBe(0); // poked to 1 during ChangeWeapon, restored after
  });
});

// ---------------------------------------------------------------------------
// Bot_TriggerEdict -- bot_exports.cpp:68-85
// ---------------------------------------------------------------------------

describe("Bot_TriggerEdict (bot_exports.cpp:68-85)", () => {
  test("calls both use and touch when the bot and target are both in-use", () => {
    const bot = makeBot(1);
    const target = edicts[2]!;
    target.inuse = true;
    const useCalls: EdictT[] = [];
    const touchCalls: EdictT[] = [];
    target.use = (self) => useCalls.push(self);
    target.touch = (self) => touchCalls.push(self);

    Bot_TriggerEdict(bot, target);

    expect(useCalls).toEqual([target]);
    expect(touchCalls).toEqual([target]);
  });

  test("no-ops when the bot is not in use", () => {
    const bot = makeBot(1);
    bot.inuse = false;
    const target = edicts[2]!;
    target.inuse = true;
    let called = false;
    target.use = () => {
      called = true;
    };
    Bot_TriggerEdict(bot, target);
    expect(called).toBe(false);
  });

  test("no-ops for a non-bot edict", () => {
    const player = makePlayer(1);
    const target = edicts[2]!;
    target.inuse = true;
    let called = false;
    target.use = () => {
      called = true;
    };
    Bot_TriggerEdict(player, target);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edict_ForceLookAtPoint -- bot_exports.cpp:158-177
// ---------------------------------------------------------------------------

describe("Edict_ForceLookAtPoint (bot_exports.cpp:158-177)", () => {
  test("resets a client edict's view angles toward the given point", () => {
    const bot = makeBot(1);
    bot.s.origin = vec3(0, 0, 0);
    bot.client!.v_angle = vec3(10, 20, 0);
    bot.client!.ps.viewangles = vec3(10, 20, 0);
    bot.s.angles = vec3(10, 20, 0);
    bot.client!.resp.cmd_angles = vec3(0, 0, 0);

    Edict_ForceLookAtPoint(bot, vec3(100, 0, 0));

    // Looking due +X from the origin: pitch 0, yaw 0.
    expect(bot.client!.ps.pmove.delta_angles[0]).toBeCloseTo(0, 4);
    expect(bot.client!.ps.pmove.delta_angles[1]).toBeCloseTo(0, 4);
    expect(bot.client!.ps.viewangles).toEqual(vec3(0, 0, 0));
    expect(bot.client!.v_angle).toEqual(vec3(0, 0, 0));
    expect(bot.s.angles).toEqual(vec3(0, 0, 0));
  });

  test("does not touch client-only fields for a non-client edict, and does not throw", () => {
    const e = edicts[1]!;
    e.inuse = true;
    e.s.origin = vec3(0, 0, 0);
    expect(() => Edict_ForceLookAtPoint(e, vec3(0, 100, 0))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bot_PickedUpItem -- bot_exports.cpp:186-188
// ---------------------------------------------------------------------------

describe("Bot_PickedUpItem (bot_exports.cpp:186-188)", () => {
  test("reads item_picked_up_by at bot.s.number - 1", () => {
    const bot = makeBot(3); // s.number === 3 -> index 2
    const item = edicts[4]!;
    item.inuse = true;
    item.item_picked_up_by[2] = true;
    expect(Bot_PickedUpItem(bot, item)).toBe(true);

    item.item_picked_up_by[2] = false;
    expect(Bot_PickedUpItem(bot, item)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bot_BeginFrame / Bot_EndFrame -- bot_think.cpp:12-23
// ---------------------------------------------------------------------------

describe("Bot_BeginFrame / Bot_EndFrame (bot_think.cpp:12-23)", () => {
  test("both are real, empty-bodied, and callable without throwing", () => {
    const bot = makeBot(1);
    expect(() => Bot_BeginFrame(bot)).not.toThrow();
    expect(() => Bot_EndFrame(bot)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bot_UpdateDebug -- bot_debug.cpp:161-178
// ---------------------------------------------------------------------------

describe("Bot_UpdateDebug (bot_debug.cpp:161-178)", () => {
  test("is a no-op while \"cheats\" is at its registered default (0)", () => {
    expect(() => Bot_UpdateDebug()).not.toThrow();
  });

  test("with cheats on but no local player in the world, still a no-op", () => {
    gi.cvar_set("cheats", "1");
    expect(() => Bot_UpdateDebug()).not.toThrow();
  });

  test("with cheats on and a local player, runs the debug sub-updates without throwing", () => {
    gi.cvar_set("cheats", "1");
    makePlayer(1);
    expect(() => Bot_UpdateDebug()).not.toThrow();
  });
});
