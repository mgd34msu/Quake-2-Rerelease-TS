/*
Unit tests for the kex g_save.cpp JSON save-system port (src/kexgame/g_save.ts).

Self-sufficient per .orch/preferences.md rule 13 / PORTING.md: wires up its
own fake KexGameImports/KexGameExports and never relies on another test file
having run first. The fixture (makeFakeGameImports/makeFakeGameExports/
setupWorld) is modeled directly on test/kexgame_g_misc.test.ts's own fixture
of the same shape and name.

g_save.ts's `JVal`/`writeJSON`/`parseJSONText` are exported for exactly this
kind of shape assertion, but the numeric-literal wrapper class (`JNum`) is
intentionally NOT exported (it is an internal codec detail). `toPlain()`
below duck-types it (its only possible shape is a single `raw: string`
property) and converts a whole parsed tree into plain JS values, with every
numeric leaf represented as its RAW DIGIT TEXT -- this is what lets case 4
below prove no `number`/`JSON.parse` round trip ever touches a uint64 value.

Every case cites the exact g_save.cpp line range it exercises (see
src/kexgame/g_save.ts's own file header for the fuller architecture writeup
this suite is checking):

  1.  client_persistant_t.inventory ST_INVENTORY round trip (g_save.cpp:
      1764-1801, 2233-2258) through WriteGameJson/ReadGameJson.
  2.  edict_t.think/edict_t.use function-pointer name round trip through the
      save registry (ST_DATA, g_save.cpp:1747-1763, 2212-2232) via
      WriteLevelJson/ReadLevelJson.
  3.  gtime_t fields serialize as plain millisecond integers, never a
      fractional/quoted value (ST_TIME, g_save.cpp:1741-1746, 2203-2211).
  4.  MonsterAiFlagsT (bigint) round-trips a bit at/above 2^53 without any
      precision loss -- the ST_UINT64 finding in g_save.ts's own header.
  5.  EdictT.flags (EntFlagsT) and EntityState.effects (EffectsT) bigints
      round-trip the same way.
  6.  vec3_t fractional-float round trip (ST_FIXED_ARRAY of float,
      g_save.cpp:1625-1655, 2022-2074).
  7.  gitem_t* pointers (ST_ITEM_POINTER, g_save.cpp:1712-1740, 2160-2178)
      round-trip as classnames via client_persistant_t.weapon/lastweapon.
  8.  item_id_t indices (ST_ITEM_INDEX, same code path, g_save.cpp:2179-2202)
      round-trip via classname, with IT_NULL omitted from the JSON.
  9.  moveinfo_t/monsterinfo_t fields flatten to dotted top-level keys
      ("moveinfo.speed", "monsterinfo.aiflags") rather than nesting as real
      sub-objects -- g_save.ts's own "flattened dotted keys" finding.
  10. A registered MmoveT round-trips through monsterinfo.active_move by
      name (ST_DATA / SAVE_DATA_MMOVE).
  11. ReadGameJson rejects a save_version mismatch, and accepts a match.
  12. G_CanSave's two gating conditions (g_save.cpp:2590-2605): single-player
      death, and an active intermission.
  13. monsterinfo.reinforcements (ST_REINFORCEMENTS, g_save.cpp:1802-1870,
      2259-2289) round trip.
  14. edict_t.item_picked_up_by (std::bitset<N> encoding, g_save.cpp:524-591)
      round-trips as a compact "0"/"1" string.
  15. edict_t.gravity/.gravityVector's custom `.set_is_empty()` overrides
      (g_save.cpp:936-945) omit the default value from the JSON, and a fresh
      read still restores the correct default.
  16. Unrecognized JSON fields produce a non-fatal warning via the
      `onWarning` callback rather than throwing (read_save_struct_json's
      "unknown field" path, g_save.cpp:2349-2350).
  17. WriteLevelJson's `transition` flag skips in-range client edicts
      (g_save.cpp:2487-2492).
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION } from "../src/kexapi/game";
import { type EdictT, MonsterAiFlagsT, EntFlagsT, ItemIdT } from "../src/kexgame/g_local";
import { MmoveT } from "../src/kexgame/g_local_types";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, GTIME_ZERO } from "../src/kexgame/gtime";
// g_save.ts is imported BEFORE g_items.ts on purpose -- see g_save.ts's own
// "IMPORT ORDER IS LOAD-BEARING" comment above its g_utils.ts/g_items.ts
// imports. g_save.ts already orders those two correctly internally, but a
// module that imports g_items.ts directly BEFORE ever reaching g_save.ts
// re-triggers the exact same g_utils.ts<->p_client.ts<->g_items.ts ordering
// hazard from this file's own top level. Importing g_save.ts first lets its
// internal (correct) ordering run to completion first.
import { WriteGameJson, ReadGameJson, WriteLevelJson, ReadLevelJson, G_CanSave, SAVE_FORMAT_VERSION, writeJSON, parseJSONText, type JVal } from "../src/kexgame/g_save";
import { FindItemByClassname } from "../src/kexgame/g_items";
import { RegisterThink, RegisterUse, RegisterMmove } from "../src/kexgame/g_save_registry";

void gi; // imported for its type-side effect on SetGameImports call sites below; referenced directly in a couple of assertions

// ---------------------------------------------------------------------------
// JVal -> plain-JS-value normalizer (see file header for why this exists
// instead of exporting the internal `JNum` class).
// ---------------------------------------------------------------------------

type Plain = null | boolean | string | Plain[] | { [key: string]: Plain };

function isJNumShaped(v: object): v is { raw: string } {
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === "raw" && typeof (v as { raw?: unknown }).raw === "string";
}

function toPlain(v: JVal): Plain {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (isJNumShaped(v)) return v.raw; // numeric leaf -> its exact source digit text
  // `v` is structurally a plain `{[key:string]: JVal}` at this point, but TS
  // cannot narrow it away from the JNum-shaped case above (an arbitrary
  // string-indexed object CAN structurally match `{raw: string}` too) --
  // this is the one cast needed to index it, justified by the runtime check
  // just performed.
  const record = v as { [key: string]: JVal };
  const obj: { [key: string]: Plain } = {};
  for (const key of Object.keys(record)) obj[key] = toPlain(record[key]);
  return obj;
}

function asObject(v: Plain): { [key: string]: Plain } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("expected object");
  return v;
}

function asArray(v: Plain): Plain[] {
  if (!Array.isArray(v)) throw new Error("expected array");
  return v;
}

function parseToPlain(text: string): { [key: string]: Plain } {
  return asObject(toPlain(parseJSONText(text)));
}

// ---------------------------------------------------------------------------
// registry fixtures -- registered ONCE at module scope (RegisterX throws on
// a duplicate name, and the registry is a module-level singleton that
// beforeEach cannot reset), with names namespaced to this file so they can
// never collide with another test file's own registrations.
// ---------------------------------------------------------------------------

let thinkCalls = 0;
const kexSaveTestThink = RegisterThink("kexgame_g_save_test_think", (_self: EdictT) => {
  thinkCalls++;
});

const kexSaveTestUse = RegisterUse("kexgame_g_save_test_use", (_self: EdictT, _other: EdictT | null, _activator: EdictT | null) => {
  /* no-op: only its registered NAME is under test */
});

const kexSaveTestMmove: MmoveT = (() => {
  const m = new MmoveT();
  m.firstframe = 0;
  m.lastframe = 1;
  m.frame = [
    { aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 },
    { aifunc: null, dist: 0, thinkfunc: null, lerp_frame: -1 },
  ];
  return m;
})();
RegisterMmove("kexgame_g_save_test_mmove", kexSaveTestMmove);

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (modeled on
// test/kexgame_g_misc.test.ts's fixture of the same name/shape)
// ---------------------------------------------------------------------------

function noHitTrace(end: Vec3): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

interface Recorder {
  linkCalls: number[];
}
let rec: Recorder;

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

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print() {},
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
    modelindex() {
      return 0;
    },
    soundindex() {
      return 0;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(_start, _mins, _maxs, end) {
      return noHitTrace(end);
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
    linkentity(ent: KexEdictT | null) {
      if (ent === null) return;
      rec.linkCalls.push(ent.s.number);
    },
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
      return 0;
    },
    Bot_FollowActor() {
      return 0;
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

const NUM_EDICTS = 32;
const MAX_CLIENTS_FOR_TEST = 2;

/** Preallocates `NUM_EDICTS` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(): void {
  const edicts: EdictT[] = [];
  for (let i = 0; i < NUM_EDICTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);

  game.maxclients = MAX_CLIENTS_FOR_TEST;
  game.maxentities = NUM_EDICTS;
  game.clients = [];
  level.time = GTIME_ZERO;
  level.intermissiontime = GTIME_ZERO;

  rec = { linkCalls: [] };
  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, NUM_EDICTS));
}

beforeEach(() => {
  setupWorld();
  thinkCalls = 0;
});

// ---------------------------------------------------------------------------
// 1. client_persistant_t.inventory (ST_INVENTORY)
// ---------------------------------------------------------------------------

describe("WriteGameJson/ReadGameJson: client_persistant_t.inventory", () => {
  test("round-trips inventory counts through WriteGameJson/ReadGameJson (g_save.cpp:1764-1801, 2233-2258)", () => {
    game.maxclients = 1;
    const text1 = WriteGameJson(true);
    ReadGameJson(text1);

    const ammoShells = FindItemByClassname("ammo_shells");
    expect(ammoShells).not.toBeNull();
    game.clients[0]!.pers.inventory[ammoShells!.id] = 42;

    const text2 = WriteGameJson(true);
    const root = parseToPlain(text2);
    const client0 = asObject(asArray(root["clients"])[0]!);
    const pers = asObject(client0["pers"]!);
    const inventory = asObject(pers["inventory"]!);
    expect(inventory["ammo_shells"]).toBe("42");

    ReadGameJson(text2);
    expect(game.clients[0]!.pers.inventory[ammoShells!.id]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 2. edict_t.think/use function-pointer name round trip
// ---------------------------------------------------------------------------

describe("WriteLevelJson/ReadLevelJson: think/use save-registry round trip", () => {
  test("an edict's registered think/use functions survive a save/load cycle by name (g_save.cpp:1747-1763, 2212-2232)", () => {
    const ent = g_edicts[5]!;
    ent.inuse = true;
    ent.classname = "kexgame_test_entity";
    ent.think = kexSaveTestThink;
    ent.use = kexSaveTestUse;
    ent.nextthink = Gtime_from_ms(1234);

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const entities = asObject(root["entities"]!);
    const ent5 = asObject(entities["5"]!);
    expect(ent5["think"]).toBe("kexgame_g_save_test_think");
    expect(ent5["use"]).toBe("kexgame_g_save_test_use");

    ReadLevelJson(text);
    const restored = g_edicts[5]!;
    expect(restored.think).toBe(kexSaveTestThink);
    restored.think!(restored);
    expect(thinkCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. gtime_t fields
// ---------------------------------------------------------------------------

describe("gtime_t (ST_TIME) encoding", () => {
  test("serializes as a plain millisecond integer and round-trips exactly (g_save.cpp:1741-1746, 2203-2211)", () => {
    level.time = Gtime_from_ms(987654);
    const ent = g_edicts[2]!;
    ent.inuse = true;
    ent.nextthink = Gtime_from_ms(555);

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const levelObj = asObject(root["level"]!);
    expect(levelObj["time"]).toBe("987654");
    const entities = asObject(root["entities"]!);
    const ent2 = asObject(entities["2"]!);
    expect(ent2["nextthink"]).toBe("555");
    // No quotes, no decimal point -- a bare integer literal.
    expect(text.includes('"time": 987654')).toBe(true);
    expect(text.includes('"nextthink": 555')).toBe(true);

    level.time = GTIME_ZERO;
    ReadLevelJson(text);
    expect(level.time).toBe(Gtime_from_ms(987654));
    expect(g_edicts[2]!.nextthink).toBe(Gtime_from_ms(555));
  });
});

// ---------------------------------------------------------------------------
// 4. MonsterAiFlagsT bigint precision
// ---------------------------------------------------------------------------

describe("bigint uint64 encoding (MonsterAiFlagsT)", () => {
  test("round-trips a monsterinfo.aiflags combination with a bit at/above 2^53 without precision loss", () => {
    const ent = g_edicts[6]!;
    ent.inuse = true;
    // AI_THIRD_EYE (bit 38) | AI_STUNK (bit 32), combined with a synthetic
    // bit 60 to push well past Number.MAX_SAFE_INTEGER (2^53-1).
    const highFlags = MonsterAiFlagsT.AI_THIRD_EYE | MonsterAiFlagsT.AI_STUNK | (1n << 60n);
    ent.monsterinfo.aiflags = highFlags;
    expect(highFlags > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const entities = asObject(root["entities"]!);
    const ent6 = asObject(entities["6"]!);
    // The raw digit text must match the bigint's OWN decimal string exactly
    // -- proof this never round-tripped through a lossy `number`.
    expect(ent6["monsterinfo.aiflags"]).toBe(highFlags.toString());
    expect(text.includes(`"monsterinfo.aiflags": ${highFlags.toString()}`)).toBe(true);

    ent.monsterinfo.aiflags = 0n;
    ReadLevelJson(text);
    expect(g_edicts[6]!.monsterinfo.aiflags).toBe(highFlags);
  });
});

// ---------------------------------------------------------------------------
// 5. EdictT.flags / EntityState.effects bigints
// ---------------------------------------------------------------------------

describe("bigint uint64 encoding (EntFlagsT, entity_state_t.effects)", () => {
  test("round-trips edict_t.flags and entity_state_t.effects as exact bigints", () => {
    const ent = g_edicts[7]!;
    ent.inuse = true;
    ent.flags = EntFlagsT.FL_GODMODE | EntFlagsT.FL_IMMORTAL;
    ent.s.effects = 1n << 40n;

    const text = WriteLevelJson(false);
    ReadLevelJson(text);
    const restored = g_edicts[7]!;
    expect(restored.flags).toBe(EntFlagsT.FL_GODMODE | EntFlagsT.FL_IMMORTAL);
    expect(restored.s.effects).toBe(1n << 40n);
  });
});

// ---------------------------------------------------------------------------
// 6. vec3 fractional floats
// ---------------------------------------------------------------------------

describe("vec3_t (ST_FIXED_ARRAY of float)", () => {
  test("round-trips fractional velocity/origin values", () => {
    const ent = g_edicts[3]!;
    ent.inuse = true;
    ent.velocity[0] = 123.5;
    ent.velocity[1] = -0.25;
    ent.velocity[2] = 7;
    ent.s.origin[0] = 1.5;
    ent.s.origin[1] = 2.5;
    ent.s.origin[2] = -3.5;

    const text = WriteLevelJson(false);
    ReadLevelJson(text);
    const restored = g_edicts[3]!;
    expect(restored.velocity[0]).toBeCloseTo(123.5, 5);
    expect(restored.velocity[1]).toBeCloseTo(-0.25, 5);
    expect(restored.velocity[2]).toBeCloseTo(7, 5);
    expect(restored.s.origin[0]).toBeCloseTo(1.5, 5);
    expect(restored.s.origin[1]).toBeCloseTo(2.5, 5);
    expect(restored.s.origin[2]).toBeCloseTo(-3.5, 5);
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. item pointers / item indices
// ---------------------------------------------------------------------------

describe("gitem_t* / item_id_t (ST_ITEM_POINTER / ST_ITEM_INDEX)", () => {
  test("client_persistant_t.weapon/lastweapon round-trip as classnames (g_save.cpp:1712-1740, 2160-2178)", () => {
    game.maxclients = 1;
    const shotgun = FindItemByClassname("weapon_shotgun");
    expect(shotgun).not.toBeNull();

    const text1 = WriteGameJson(true);
    ReadGameJson(text1);
    game.clients[0]!.pers.weapon = shotgun;
    game.clients[0]!.pers.lastweapon = shotgun;

    const text2 = WriteGameJson(true);
    const root = parseToPlain(text2);
    const client0 = asObject(asArray(root["clients"])[0]!);
    const pers = asObject(client0["pers"]!);
    expect(pers["weapon"]).toBe("weapon_shotgun");
    expect(pers["lastweapon"]).toBe("weapon_shotgun");

    ReadGameJson(text2);
    expect(game.clients[0]!.pers.weapon).toBe(shotgun);
    expect(game.clients[0]!.pers.lastweapon).toBe(shotgun);
  });

  test("client_persistant_t.selected_item round-trips via classname, IT_NULL omitted (g_save.cpp:2179-2202)", () => {
    game.maxclients = 1;
    const armor = FindItemByClassname("item_armor_body");
    expect(armor).not.toBeNull();

    const text1 = WriteGameJson(true);
    ReadGameJson(text1);
    game.clients[0]!.pers.selected_item = armor!.id;

    const text2 = WriteGameJson(true);
    const root = parseToPlain(text2);
    const client0 = asObject(asArray(root["clients"])[0]!);
    const pers = asObject(client0["pers"]!);
    expect(pers["selected_item"]).toBe("item_armor_body");

    ReadGameJson(text2);
    expect(game.clients[0]!.pers.selected_item).toBe(armor!.id);

    // IT_NULL is omitted from the JSON entirely (empty-value convention).
    // `pers.health` is set alongside so the whole `pers` sub-object itself
    // is not ALSO empty (which would omit "pers" entirely via structField's
    // own recursive-emptiness check, making this assertion vacuous).
    game.clients[0]!.pers.selected_item = ItemIdT.IT_NULL;
    game.clients[0]!.pers.health = 55;
    const text3 = WriteGameJson(true);
    const root3 = parseToPlain(text3);
    const client0b = asObject(asArray(root3["clients"])[0]!);
    const persB = asObject(client0b["pers"]!);
    expect(persB["health"]).toBe("55");
    expect(persB["selected_item"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. flattened dotted keys
// ---------------------------------------------------------------------------

describe("flattened dotted keys (moveinfo.*, monsterinfo.*)", () => {
  test("moveinfo/monsterinfo fields are flat top-level dotted keys, not nested sub-objects (g_save.ts's own finding)", () => {
    const ent = g_edicts[8]!;
    ent.inuse = true;
    ent.moveinfo.speed = 200;
    ent.monsterinfo.aiflags = MonsterAiFlagsT.AI_STAND_GROUND;

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const entities = asObject(root["entities"]!);
    const ent8 = asObject(entities["8"]!);

    expect(ent8["moveinfo.speed"]).toBe("200.0");
    expect(ent8["monsterinfo.aiflags"]).toBe(MonsterAiFlagsT.AI_STAND_GROUND.toString());
    expect(ent8["moveinfo"]).toBeUndefined();
    expect(ent8["monsterinfo"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. registered MmoveT reference
// ---------------------------------------------------------------------------

describe("monsterinfo.active_move (SAVE_DATA_MMOVE)", () => {
  test("a registered MmoveT round-trips by name through monsterinfo.active_move", () => {
    const ent = g_edicts[9]!;
    ent.inuse = true;
    ent.monsterinfo.active_move = kexSaveTestMmove;

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const entities = asObject(root["entities"]!);
    const ent9 = asObject(entities["9"]!);
    expect(ent9["monsterinfo.active_move"]).toBe("kexgame_g_save_test_mmove");

    ReadLevelJson(text);
    expect(g_edicts[9]!.monsterinfo.active_move).toBe(kexSaveTestMmove);
  });
});

// ---------------------------------------------------------------------------
// 11. version mismatch rejection
// ---------------------------------------------------------------------------

describe("ReadGameJson version gating", () => {
  test("throws on a save_version mismatch instead of silently loading", () => {
    game.maxclients = 0;
    const good = WriteGameJson(true);
    expect(good.includes(`"save_version": ${SAVE_FORMAT_VERSION}`)).toBe(true);
    const bad = good.replace(`"save_version": ${SAVE_FORMAT_VERSION}`, `"save_version": ${SAVE_FORMAT_VERSION + 1}`);
    expect(() => ReadGameJson(bad)).toThrow();
  });

  test("accepts a matching save_version", () => {
    game.maxclients = 0;
    const text = WriteGameJson(true);
    expect(() => ReadGameJson(text)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. G_CanSave gating
// ---------------------------------------------------------------------------

describe("G_CanSave (g_save.cpp:2590-2605)", () => {
  test("returns false in single-player when the player is dead", () => {
    game.maxclients = 1;
    g_edicts[1]!.health = 0;
    level.intermissiontime = GTIME_ZERO;
    expect(G_CanSave()).toBe(false);
  });

  test("returns false during an active intermission", () => {
    game.maxclients = 2;
    level.intermissiontime = Gtime_from_ms(1000);
    expect(G_CanSave()).toBe(false);
  });

  test("returns true otherwise", () => {
    game.maxclients = 1;
    g_edicts[1]!.health = 100;
    level.intermissiontime = GTIME_ZERO;
    expect(G_CanSave()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. reinforcements
// ---------------------------------------------------------------------------

describe("monsterinfo.reinforcements (ST_REINFORCEMENTS)", () => {
  test("round-trips a reinforcement list (g_save.cpp:1802-1870, 2259-2289)", () => {
    const ent = g_edicts[10]!;
    ent.inuse = true;
    ent.monsterinfo.reinforcements.reinforcements = [
      { classname: "monster_soldier", strength: 3, mins: vec3(-16, -16, -24), maxs: vec3(16, 16, 32) },
      { classname: "monster_gunner", strength: 5, mins: vec3(-16, -16, -24), maxs: vec3(16, 16, 40) },
    ];

    const text = WriteLevelJson(false);
    ReadLevelJson(text);
    const restored = g_edicts[10]!.monsterinfo.reinforcements.reinforcements;
    expect(restored.length).toBe(2);
    expect(restored[0]!.classname).toBe("monster_soldier");
    expect(restored[0]!.strength).toBe(3);
    expect(restored[1]!.classname).toBe("monster_gunner");
    expect(Array.from(restored[1]!.maxs)).toEqual([16, 16, 40]);
  });
});

// ---------------------------------------------------------------------------
// 14. item_picked_up_by bitset
// ---------------------------------------------------------------------------

describe("edict_t.item_picked_up_by (std::bitset<N> encoding)", () => {
  test("round-trips as a compact trimmed '0'/'1' string", () => {
    const ent = g_edicts[11]!;
    ent.inuse = true;
    ent.item_picked_up_by[0] = true;
    ent.item_picked_up_by[1] = false;
    ent.item_picked_up_by[3] = true;

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const entities = asObject(root["entities"]!);
    const ent11 = asObject(entities["11"]!);
    // String index i encodes bit i directly (left-to-right ascending bit
    // order, matching the C++ bitset writer's `result[n] = as_bitset[n]`),
    // not conventional MSB-first binary notation: bit0=1, bit1=0, bit2=
    // (unset)=0, bit3=1 -> "1001".
    expect(ent11["item_picked_up_by"]).toBe("1001");

    ReadLevelJson(text);
    const restored = g_edicts[11]!.item_picked_up_by;
    expect(restored[0]).toBe(true);
    expect(restored[1]).toBe(false);
    expect(restored[3]).toBe(true);
    expect(restored[2]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. gravity / gravityVector custom emptiness
// ---------------------------------------------------------------------------

describe("edict_t.gravity/.gravityVector custom .set_is_empty() (g_save.cpp:936-945)", () => {
  test("the default 1.0/(0,0,-1) values are omitted from the JSON but still restored on read", () => {
    const ent = g_edicts[12]!;
    ent.inuse = true;
    ent.gravity = 1.0;
    ent.gravityVector[0] = 0;
    ent.gravityVector[1] = 0;
    ent.gravityVector[2] = -1;

    const text = WriteLevelJson(false);
    const root = parseToPlain(text);
    const entities = asObject(root["entities"]!);
    const ent12 = asObject(entities["12"]!);
    expect(ent12["gravity"]).toBeUndefined();
    expect(ent12["gravityVector"]).toBeUndefined();

    ReadLevelJson(text);
    const restored = g_edicts[12]!;
    expect(restored.gravity).toBe(1.0);
    expect(Array.from(restored.gravityVector)).toEqual([0, 0, -1]);

    // A non-default gravity DOES get written.
    ent.gravity = 2.5;
    const text2 = WriteLevelJson(false);
    const root2 = parseToPlain(text2);
    const ent12b = asObject(asObject(root2["entities"]!)["12"]!);
    expect(ent12b["gravity"]).toBe("2.5");
  });
});

// ---------------------------------------------------------------------------
// 16. unknown-field warnings
// ---------------------------------------------------------------------------

describe("unknown-field handling (read_save_struct_json's 'unknown field' path)", () => {
  test("an unrecognized field warns via onWarning instead of throwing", () => {
    const ent = g_edicts[13]!;
    ent.inuse = true;
    const text = WriteLevelJson(false);

    // Inject a bogus field directly into the parsed JVal tree (avoids
    // fragile string surgery on the exact serialized whitespace) and
    // re-serialize with the module's own writer.
    const root = parseJSONText(text);
    if (root === null || typeof root !== "object" || Array.isArray(root)) throw new Error("expected object root");
    const rootObj = root as { [key: string]: JVal };
    const entitiesVal = rootObj["entities"];
    if (entitiesVal === undefined || entitiesVal === null || typeof entitiesVal !== "object" || Array.isArray(entitiesVal)) {
      throw new Error("expected entities object");
    }
    const entitiesObj = entitiesVal as { [key: string]: JVal };
    const ent13Val = entitiesObj["13"];
    if (ent13Val === undefined || ent13Val === null || typeof ent13Val !== "object" || Array.isArray(ent13Val)) {
      throw new Error("expected entity 13 object");
    }
    (ent13Val as { [key: string]: JVal })["totally_unknown_field"] = true;
    const patched = writeJSON(root);

    const warnings: { path: string; message: string }[] = [];
    expect(() => ReadLevelJson(patched, (path, message) => warnings.push({ path, message }))).not.toThrow();
    expect(warnings.some((w) => w.message === "unknown field" && w.path.endsWith("totally_unknown_field"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. WriteLevelJson transition flag
// ---------------------------------------------------------------------------

describe("WriteLevelJson transition flag (g_save.cpp:2487-2492)", () => {
  test("skips client-range edicts when transition is true", () => {
    game.maxclients = 2;
    const player1 = g_edicts[1]!;
    const player2 = g_edicts[2]!;
    const nonPlayer = g_edicts[10]!;
    player1.inuse = true;
    player2.inuse = true;
    nonPlayer.inuse = true;

    const textTransition = WriteLevelJson(true);
    const rootTransition = parseToPlain(textTransition);
    const entitiesTransition = asObject(rootTransition["entities"]!);
    expect(entitiesTransition["1"]).toBeUndefined();
    expect(entitiesTransition["2"]).toBeUndefined();
    expect(entitiesTransition["10"]).toBeDefined();

    const textFull = WriteLevelJson(false);
    const rootFull = parseToPlain(textFull);
    const entitiesFull = asObject(rootFull["entities"]!);
    expect(entitiesFull["1"]).toBeDefined();
    expect(entitiesFull["2"]).toBeDefined();
    expect(entitiesFull["10"]).toBeDefined();
  });
});
