import { describe, expect, test } from "bun:test";
import type { Edict, GameExports, GameImports, GTraceT } from "../src/game/game";
import { GAME_API_VERSION, SolidT, SVF_NOCLIENT } from "../src/game/game";
import {
  Add_Ammo,
  bodyarmor_info,
  combatarmor_info,
  DoRespawn,
  FindItem,
  FindItemByClassname,
  GetItemByIndex,
  InitItems,
  ITEM_INDEX,
  itemlist,
  jacketarmor_info,
  Pickup_Armor,
  Pickup_Health,
  SetItemNames,
  SetRespawn,
  Use_Quad,
} from "../src/game/g_items";
import {
  EdictT,
  g_edicts,
  game,
  gameCvars,
  gameIndices,
  GClientT,
  globals,
  level,
  SetGameExports,
  SetGameImports,
  SetGEdicts,
} from "../src/game/g_local";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports: records sound/linkentity calls; trace defaults to a
// clean miss (fraction 1, not startsolid) unless a test overrides it.
// ---------------------------------------------------------------------------

interface Recorder {
  sound: Array<{ ent: Edict; channel: number; soundindex: number }>;
  linkentity: Edict[];
  cprintf: string[];
  configstring: Array<{ num: number; str: string }>;
}

function makeRecorder(): Recorder {
  return { sound: [], linkentity: [], cprintf: [], configstring: [] };
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
    dprintf() {},
    cprintf(_ent, _printlevel, fmt) {
      rec.cprintf.push(fmt);
    },
    centerprintf() {},
    sound(ent, channel, soundindex) {
      rec.sound.push({ ent, channel, soundindex });
    },
    positioned_sound() {},
    configstring(num, str) {
      rec.configstring.push({ num, str });
    },
    error(fmt): never {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 0;
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
    WriteByte() {},
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

const MAXCLIENTS = 4;
const MAXENTITIES = 64;

function cvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

// Sets up game/level/gi/g_edicts exactly enough for g_items.ts's real logic
// to run, then calls InitItems()+SetItemNames() -- mirroring InitGame's real
// startup order -- so FindItem/ITEM_INDEX/gameIndices are populated from the
// real itemlist table before each test touches it.
function setupWorld(): Recorder {
  const rec = makeRecorder();
  SetGameImports(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;

  level.clear();

  gameCvars.deathmatch = cvar(0);
  gameCvars.coop = cvar(0);
  gameCvars.dmflags = cvar(0);
  gameCvars.skill = cvar(1);
  const maxclientsCvar = cvar(MAXCLIENTS);
  gameCvars.maxclients = maxclientsCvar;

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

  InitItems();
  SetItemNames();

  return rec;
}

function withClient(ent: EdictT): GClientT {
  const client = new GClientT();
  ent.client = client;
  return client;
}

// ---------------------------------------------------------------------------

describe("itemlist / InitItems", () => {
  test("has exactly 43 entries (transcribed from the C array literal: index 0 placeholder + 41 real items + trailing {NULL} end marker)", () => {
    setupWorld();
    expect(itemlist().length).toBe(43);
    // C: `game.num_items = sizeof(itemlist)/sizeof(itemlist[0]) - 1;`
    expect(game.num_items).toBe(42);
  });
});

describe("FindItem / FindItemByClassname / ITEM_INDEX / GetItemByIndex", () => {
  test("FindItem and FindItemByClassname resolve the same Railgun entry", () => {
    setupWorld();
    const byName = FindItem("Railgun");
    const byClassname = FindItemByClassname("weapon_railgun");
    expect(byName).not.toBeNull();
    expect(byName).toBe(byClassname);
  });

  test("ITEM_INDEX / GetItemByIndex round-trip", () => {
    setupWorld();
    const item = FindItem("Railgun");
    expect(item).not.toBeNull();
    if (item === null) return;
    const index = ITEM_INDEX(item);
    expect(index).toBeGreaterThan(0);
    expect(GetItemByIndex(index)).toBe(item);
  });

  test("GetItemByIndex returns null for index 0 and out-of-range index", () => {
    setupWorld();
    expect(GetItemByIndex(0)).toBeNull();
    expect(GetItemByIndex(game.num_items)).toBeNull();
  });

  test("SetItemNames resolves the armor indices into gameIndices", () => {
    setupWorld();
    expect(gameIndices.jacket_armor_index).toBe(ITEM_INDEX(FindItem("Jacket Armor")!));
    expect(gameIndices.combat_armor_index).toBe(ITEM_INDEX(FindItem("Combat Armor")!));
    expect(gameIndices.body_armor_index).toBe(ITEM_INDEX(FindItem("Body Armor")!));
  });
});

describe("Add_Ammo", () => {
  test("adds ammo up to max_bullets, clamps at the cap, and refuses once already full", () => {
    setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    const client = withClient(ent);
    client.pers.max_bullets = 50;

    const bullets = FindItem("Bullets");
    expect(bullets).not.toBeNull();
    if (bullets === null) return;
    const index = ITEM_INDEX(bullets);

    expect(Add_Ammo(ent, bullets, 40)).toBe(true);
    expect(client.pers.inventory[index]).toBe(40);

    // 40 + 20 = 60, clamped to max_bullets (50)
    expect(Add_Ammo(ent, bullets, 20)).toBe(true);
    expect(client.pers.inventory[index]).toBe(50);

    // already at the cap: C returns false without adding
    expect(Add_Ammo(ent, bullets, 5)).toBe(false);
    expect(client.pers.inventory[index]).toBe(50);
  });

  test("returns false when the entity has no client", () => {
    setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    const bullets = FindItem("Bullets");
    expect(bullets).not.toBeNull();
    if (bullets === null) return;
    expect(Add_Ammo(ent, bullets, 10)).toBe(false);
  });
});

describe("Pickup_Health", () => {
  test("raises health up to max_health for a normal health item", () => {
    setupWorld();
    gameCvars.deathmatch = cvar(0);
    const ent = g_edicts[MAXCLIENTS + 1];
    ent.count = 25;
    ent.style = 0;

    const other = g_edicts[MAXCLIENTS + 2];
    other.health = 50;
    other.max_health = 100;

    expect(Pickup_Health(ent, other)).toBe(true);
    expect(other.health).toBe(75);
  });

  test("refuses when already at max_health and style has no HEALTH_IGNORE_MAX bit", () => {
    setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    ent.count = 25;
    ent.style = 0;

    const other = g_edicts[MAXCLIENTS + 2];
    other.health = 100;
    other.max_health = 100;

    expect(Pickup_Health(ent, other)).toBe(false);
  });

  test("mega health (HEALTH_IGNORE_MAX|HEALTH_TIMED) overfills health and arms a timed think", () => {
    setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    ent.count = 100;
    ent.style = 1 | 2; // HEALTH_IGNORE_MAX | HEALTH_TIMED (g_items.c local #defines)
    level.time = 40;

    const other = g_edicts[MAXCLIENTS + 2];
    other.health = 100;
    other.max_health = 100;

    expect(Pickup_Health(ent, other)).toBe(true);
    expect(other.health).toBe(200); // ignores max, so no clamp to 100

    expect(ent.owner).toBe(other);
    expect(ent.nextthink).toBe(45); // level.time + 5
    expect(ent.think).not.toBeNull();
    expect((ent.flags & 0x80000000) !== 0).toBe(true); // FL_RESPAWN
    expect((ent.svflags & SVF_NOCLIENT) !== 0).toBe(true);
    expect(ent.solid).toBe(SolidT.SOLID_NOT);

    // MegaHealth_think: owner.health (200) > owner.max_health (100), so it
    // ticks health down by 1 and reschedules instead of respawning/freeing.
    const think = ent.think;
    expect(think).not.toBeNull();
    if (think === null) return;
    think(ent);
    expect(other.health).toBe(199);
    expect(ent.nextthink).toBe(41); // level.time + 1
  });
});

describe("Pickup_Armor", () => {
  test("upgrading from Jacket to Combat armor salvages the old armor per the armor_info tables", () => {
    setupWorld();
    const other = g_edicts[MAXCLIENTS + 1];
    const client = withClient(other);
    client.pers.inventory[gameIndices.jacket_armor_index] = jacketarmor_info.base_count; // 25

    const combatItem = FindItem("Combat Armor");
    expect(combatItem).not.toBeNull();
    if (combatItem === null) return;

    const ent = g_edicts[MAXCLIENTS + 2];
    ent.item = combatItem;

    expect(Pickup_Armor(ent, other)).toBe(true);

    // salvage = jacket.normal_protection / combat.normal_protection = 0.3/0.6 = 0.5
    // salvagecount = (int)(0.5 * 25) = 12
    // newcount = combat.base_count (50) + 12 = 62
    expect(client.pers.inventory[gameIndices.jacket_armor_index]).toBe(0);
    expect(client.pers.inventory[ITEM_INDEX(combatItem)]).toBe(62);
  });

  test("picking up armor with none currently worn just sets base_count", () => {
    setupWorld();
    const other = g_edicts[MAXCLIENTS + 1];
    const client = withClient(other);

    const bodyItem = FindItem("Body Armor");
    expect(bodyItem).not.toBeNull();
    if (bodyItem === null) return;

    const ent = g_edicts[MAXCLIENTS + 2];
    ent.item = bodyItem;

    expect(Pickup_Armor(ent, other)).toBe(true);
    expect(client.pers.inventory[ITEM_INDEX(bodyItem)]).toBe(bodyarmor_info.base_count);
  });

  test("refuses a strictly worse armor once already maxed out", () => {
    setupWorld();
    const other = g_edicts[MAXCLIENTS + 1];
    const client = withClient(other);
    // already at combat armor's max
    client.pers.inventory[gameIndices.combat_armor_index] = combatarmor_info.max_count;

    const jacketItem = FindItem("Jacket Armor");
    expect(jacketItem).not.toBeNull();
    if (jacketItem === null) return;

    const ent = g_edicts[MAXCLIENTS + 2];
    ent.item = jacketItem;

    expect(Pickup_Armor(ent, other)).toBe(false);
    expect(client.pers.inventory[gameIndices.combat_armor_index]).toBe(combatarmor_info.max_count);
  });
});

describe("Use_Quad", () => {
  test("calls the real g_cmds.ts ValidateSelectedItem sibling and still decrements inventory first", () => {
    // Use_Quad calls g_cmds.ts's ValidateSelectedItem before touching
    // quad_framenum (C order: inventory-- then ValidateSelectedItem, then
    // the timeout math + gi.sound). g_cmds.c has since landed a real port
    // (ValidateSelectedItem is no longer a PendingPort stub), so this now
    // just proves Use_Quad calls through to it without throwing and still
    // decrements the inventory count first.
    const rec = setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    const client = withClient(ent);
    const quadItem = FindItem("Quad Damage");
    expect(quadItem).not.toBeNull();
    if (quadItem === null) return;
    client.pers.inventory[ITEM_INDEX(quadItem)] = 1;

    expect(() => Use_Quad(ent, quadItem)).not.toThrow();
    expect(client.pers.inventory[ITEM_INDEX(quadItem)]).toBe(0);
    expect(rec.sound).toHaveLength(1);
  });

  test("pushes quad_framenum forward by the default 300-frame timeout and plays the pickup sound", () => {
    const rec = setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    const client = withClient(ent);

    const quadItem = FindItem("Quad Damage");
    expect(quadItem).not.toBeNull();
    if (quadItem === null) return;
    client.pers.inventory[ITEM_INDEX(quadItem)] = 1;

    level.framenum = 1000;
    client.quad_framenum = 0;

    Use_Quad(ent, quadItem);

    expect(client.quad_framenum).toBe(1300); // level.framenum + 300
    expect(client.pers.inventory[ITEM_INDEX(quadItem)]).toBe(0);
    expect(rec.sound).toHaveLength(1);
    expect(rec.sound[0]?.ent).toBe(ent);
  });

  test("extends an already-active quad instead of resetting it", () => {
    setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    const client = withClient(ent);
    const quadItem = FindItem("Quad Damage");
    if (quadItem === null) throw new Error("Quad Damage item missing");
    client.pers.inventory[ITEM_INDEX(quadItem)] = 1;

    level.framenum = 1000;
    client.quad_framenum = 1200; // already active past the current frame

    Use_Quad(ent, quadItem);

    expect(client.quad_framenum).toBe(1500); // 1200 + 300, not level.framenum + 300
  });
});

describe("SetRespawn", () => {
  test("marks the entity NOCLIENT/SOLID_NOT, schedules DoRespawn, and relinks it", () => {
    const rec = setupWorld();
    const ent = g_edicts[MAXCLIENTS + 1];
    level.time = 12;

    SetRespawn(ent, 15);

    expect((ent.svflags & SVF_NOCLIENT) !== 0).toBe(true);
    expect(ent.solid).toBe(SolidT.SOLID_NOT);
    expect(ent.nextthink).toBe(27); // level.time + delay
    expect(ent.think).toBe(DoRespawn);
    expect(rec.linkentity).toContain(ent);
  });
});
