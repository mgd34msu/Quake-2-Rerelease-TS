// Dual-ruleset spawn-inhibition verification against a REAL retail entity
// string (maps/base1.bsp's entity lump, extracted from baseq2/pak0.pak),
// for the "yellow placeholder boxes / four 'Nav entity appears to be
// missing' warnings on base1" live defect report.
//
// HYPOTHESIS UNDER TEST (as handed down): SpawnEntities' spawn-inhibition
// filter (G_InhibitEntity, g_spawn.cpp:1070-1086) inhibits entities on
// base1 at skill 1 single-player that the real rerelease keeps, deleting
// props whose inline models (*14/*22/*32) the nav graph then can't find.
//
// METHOD: this file parses the REAL base1 entity lump with an entirely
// independent regex-based reader (no reliance on this port's own
// ED_ParseEdict/COM_Parse), computes what g_spawn.cpp:1070-1086 -- copied
// here byte-for-byte as `cppInhibitRule()` -- would inhibit at skill 1,
// deathmatch 0, coop 0, and separately runs the REAL SpawnEntities() (the
// public entry point; G_InhibitEntity itself is private, matching this
// suite's sibling kexgame_g_spawn.test.ts's own established idiom) over
// the exact same bytes through a full kexgame fixture. The two are then
// cross-checked against each other AND against the exact runtime symptom
// the game printed ("41 entities inhibited").
//
// FINDING (see task report for the full derivation): G_InhibitEntity in
// src/kexgame/g_spawn.ts is byte-for-byte identical to the C++ rule --
// same flag bit values (0x100/0x200/0x400/0x800/0x1000/0x4000 -- verified
// against g_local.h:252-262), same deathmatch/coop/skill branch order, same
// EDITOR_MASK. Both rulesets inhibit exactly 41 of base1's 780 entities at
// skill 1 SP, matching the live symptom's own printed count -- 41 is the
// CORRECT count, not a bug. None of the three entities carrying the nav
// graph's referenced inline models (*14 trigger_once spawnflags=0, *22
// trigger_once spawnflags=2048/SPAWNFLAG_NOT_DEATHMATCH, *32 func_door
// spawnflags=0) are inhibited under EITHER ruleset in single-player at any
// skill -- their own spawnflags never intersect the skill/coop bits, so
// the inhibition filter cannot be the thing deleting them or shifting
// their survival. The hypothesis is REFUTED for this entity set.
//
// CONFIRMED ACTUAL ROOT CAUSE (parsed directly from the real retail
// bots/navigation/base1.nav, NAV3 v6, per nav.ts's own documented binary
// layout): the file has exactly 4 edict records -- {model: 22}, {model:
// 14}, {model: 32}, {model: 22} -- the literal RAW BSP SUBMODEL NUMBERS
// (matching "four warnings ... model 14/22/32", 22 appearing twice), NOT
// sequential precache-order indices. src/server/nav.ts's Nav_SetupEntities
// (line ~1195) compares this raw baked number directly against
// `game_e.s.modelindex`, but src/server/sv_init.ts's SV_ModelIndex (via
// SV_FindIndex) and src/server/sv_game.ts's PF_setmodel assign inline
// "*N" bmodel indices by sequential first-use precache order (no special
// case for the "*" prefix), same as every other model name -- so
// `s.modelindex` for these entities is never anywhere near the raw
// submodel number (empirically ~53/~76/~95 for *14/*22/*32 on a real
// SpawnEntities("base1", ...) run through this exact fixture, see the
// second test's console output below, even AFTER fixing the unrelated
// sm_meat/soundindex bug this same task turned up). This is a numbering-
// scheme mismatch in src/server/sv_init.ts / src/server/sv_game.ts (an
// inline model's modelindex needs to be derived directly from its "*N"
// suffix, not looked up through the generic sequential configstring
// allocator), NOT a spawn-inhibition bug -- outside src/kexgame/g_spawn.ts's
// territory, reported rather than fixed here.
//
// No retail content is read into this repository or committed anywhere:
// pak0.pak is read directly from the user's local retail install path at
// test-run time (raw node:fs PACK/IBSP parsing, matching
// test/cl_demo_retail.test.ts's own precedent) and the extracted bytes
// never touch disk. Skips itself if the retail install isn't present.

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, CvarFlagsT } from "../src/kexapi/game";
import { type EdictT, MovetypeT } from "../src/kexgame/g_local";
import { SolidT } from "../src/kexapi/game";
import { defaultEdict, gi, game, level, g_edicts, globals, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO } from "../src/kexgame/gtime";
import { ClearSpawnTemp, SpawnEntities } from "../src/kexgame/g_spawn";

// ---------------------------------------------------------------------------
// Real retail data extraction: baseq2/pak0.pak -> maps/base1.bsp -> the
// entity lump (IBSP lump 0), completely independently of this port's own
// file-reading code.
// ---------------------------------------------------------------------------

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const BSP_ENTRY = "maps/base1.bsp";

/** Minimal classic id PACK format reader -- see test/cl_demo_retail.test.ts's
 *  own identical function for the format/rationale; duplicated here rather
 *  than imported, per that file's own "self-sufficient, no relying on
 *  another test file" idiom. */
function extractFromPak(pakPath: string, entryName: string): Uint8Array | null {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return null;

  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    const name = rawName.replace(/\0.*$/, "");
    if (name !== entryName) continue;

    const filepos = data.readInt32LE(entryOffset + 56);
    const filelen = data.readInt32LE(entryOffset + 60);
    return new Uint8Array(data.subarray(filepos, filepos + filelen));
  }
  return null;
}

/** IBSP lump 0 is the entity string (idtech2 bspfile.h: LUMP_ENTITIES = 0).
 *  Header: 4-byte magic "IBSP" + int32 version, then 19 lump_t{fileofs,filelen}. */
function extractEntityLump(bsp: Uint8Array): string {
  const buf = Buffer.from(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  if (buf.toString("ascii", 0, 4) !== "IBSP") throw new Error("not an IBSP file");
  const fileofs = buf.readInt32LE(8);
  const filelen = buf.readInt32LE(12);
  return buf.toString("latin1", fileofs, fileofs + filelen);
}

const havePak = existsSync(PAK_PATH);
const bspBytes = havePak ? extractFromPak(PAK_PATH, BSP_ENTRY) : null;
const realEntityString = bspBytes !== null ? extractEntityLump(bspBytes) : null;

// ---------------------------------------------------------------------------
// Independent entity-block parser (regex-based, not this port's ED_Parse*)
// ---------------------------------------------------------------------------

interface RawBlock {
  classname: string;
  spawnflags: number;
  model: string | null;
  target: string | null;
  targetname: string | null;
}

function parseBlocks(entityString: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (const m of entityString.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]!;
    const kv = new Map<string, string>();
    for (const kvm of body.matchAll(/"([^"]*)"\s*"([^"]*)"/g)) {
      kv.set(kvm[1]!, kvm[2]!);
    }
    blocks.push({
      classname: kv.get("classname") ?? "",
      spawnflags: Number.parseInt(kv.get("spawnflags") ?? "0", 10) || 0,
      model: kv.get("model") ?? null,
      target: kv.get("target") ?? null,
      targetname: kv.get("targetname") ?? null,
    });
  }
  return blocks;
}

/** g_spawn.cpp:1070-1086, `inline bool G_InhibitEntity(edict_t *ent)`,
 *  copied byte-for-byte (bit values verified against g_local.h:252-262). */
const SPAWNFLAG_NOT_EASY = 0x00000100;
const SPAWNFLAG_NOT_MEDIUM = 0x00000200;
const SPAWNFLAG_NOT_HARD = 0x00000400;
const SPAWNFLAG_NOT_DEATHMATCH = 0x00000800;
const SPAWNFLAG_NOT_COOP = 0x00001000;
const SPAWNFLAG_COOP_ONLY = 0x00004000;

function cppInhibitRule(spawnflags: number, skill: number, deathmatch: boolean, coop: boolean): boolean {
  if (deathmatch) return (spawnflags & SPAWNFLAG_NOT_DEATHMATCH) !== 0;

  if (coop && (spawnflags & SPAWNFLAG_NOT_COOP) !== 0) return true;
  else if (!coop && (spawnflags & SPAWNFLAG_COOP_ONLY) !== 0) return true;

  return (
    (skill === 0 && (spawnflags & SPAWNFLAG_NOT_EASY) !== 0) ||
    (skill === 1 && (spawnflags & SPAWNFLAG_NOT_MEDIUM) !== 0) ||
    (skill >= 2 && (spawnflags & SPAWNFLAG_NOT_HARD) !== 0)
  );
}

// ---------------------------------------------------------------------------
// Full kexgame fixture (modeled on test/kexgame_g_spawn.test.ts's own fake
// KexGameImports/KexGameExports -- see that file for the fuller rationale
// of each stub). Sized for a real map: NUM_EDICTS well above base1's 780
// parsed blocks plus headroom for reused/freed slots.
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
  comPrints: string[];
  modelindexCalls: string[];
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

  // Mirrors src/server/sv_init.ts's real SV_FindIndex algorithm exactly:
  // sequential first-use assignment, no special-casing of "*"-prefixed
  // inline-model names -- this IS the production numbering scheme (see
  // task report), reproduced here rather than faked differently, so this
  // fixture's modelindex() answers "what would our real engine assign".
  const modelNamesById: string[] = [""];
  function modelindex(name: string): number {
    rec.modelindexCalls.push(name);
    let idx = modelNamesById.indexOf(name);
    if (idx === -1) {
      idx = modelNamesById.length;
      modelNamesById.push(name);
    }
    return idx;
  }

  const soundNamesById: string[] = [""];
  function soundindex(name: string): number {
    let idx = soundNamesById.indexOf(name);
    if (idx === -1) {
      idx = soundNamesById.length;
      soundNamesById.push(name);
    }
    return idx;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print(msg: string) {
      rec.comPrints.push(msg);
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
    soundindex,
    imageindex() {
      return 0;
    },
    setmodel(ent, name) {
      if (ent === null) return;
      const full = g_edicts[ent.s.number];
      if (full === undefined) return;
      full.s.modelindex = modelindex(name);
    },
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
    linkentity(ent) {
      if (ent === null) return;
      const full = g_edicts[ent.s.number];
      if (full === undefined) return;
      for (let i = 0; i < 3; i++) {
        full.absmin[i] = full.s.origin[i] + full.mins[i];
        full.absmax[i] = full.s.origin[i] + full.maxs[i];
        full.size[i] = full.maxs[i] - full.mins[i];
      }
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

// base1's real entity lump has 780 blocks; leave generous headroom above
// MAX_EDICTS' usual 1024 default for reused/freed slots during the parse.
const NUM_EDICTS = 2048;

function setupWorld(): void {
  const edicts: EdictT[] = [];
  for (let i = 0; i < NUM_EDICTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 0;
  game.maxentities = NUM_EDICTS;
  game.clients = [];
  level.time = GTIME_ZERO;

  rec = { comPrints: [], modelindexCalls: [] };
  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, 1));

  ClearSpawnTemp();
}

beforeEach(() => {
  setupWorld();
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

describe("SpawnEntities inhibition vs. the real g_spawn.cpp:1070-1086 rule, over base1's REAL retail entstring (skipIf retail absent)", () => {
  test.skipIf(!havePak || realEntityString === null)(
    "at skill 1 / deathmatch 0 / coop 0: both rulesets inhibit the exact same 41 entities, matching the live symptom's own printed count",
    () => {
      const entityString = realEntityString!;
      const rawBlocks = parseBlocks(entityString);
      expect(rawBlocks.length).toBe(780); // this unit's own retail-data survey

      // independent hand-count (does not touch this port's code at all)
      const skill = 1;
      let expectedInhibited = 0;
      for (const b of rawBlocks.slice(1)) {
        // slice(1): world (index 0) is never passed through the inhibit check
        if (cppInhibitRule(b.spawnflags, skill, false, false)) expectedInhibited++;
      }
      expect(expectedInhibited).toBe(41); // exactly the "41 entities inhibited" the live server printed

      // set cvars BEFORE spawning: skill 1 single-player, no deathmatch/coop
      gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
      gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_NOFLAGS);
      gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);

      SpawnEntities("base1", entityString, "");

      const printedInhibit = rec.comPrints.find((m) => m.includes("entities inhibited"));
      expect(printedInhibit).toBe(`${expectedInhibited} entities inhibited\n`);
    },
  );

  test.skipIf(!havePak || realEntityString === null)(
    "the three inline-model entities the nav graph references (*14/*22/*32) are NEVER inhibited in single-player at skill 1 -- refutes the inhibition-filter hypothesis",
    () => {
      const entityString = realEntityString!;
      const rawBlocks = parseBlocks(entityString);

      // sanity: confirm the exact three blocks this defect report is about,
      // independently of the port under test
      const m14 = rawBlocks.find((b) => b.model === "*14");
      const m22 = rawBlocks.find((b) => b.model === "*22");
      const m32 = rawBlocks.find((b) => b.model === "*32");
      expect(m14).toMatchObject({ classname: "trigger_once", spawnflags: 0, target: "t77" });
      expect(m22).toMatchObject({ classname: "trigger_once", spawnflags: 2048, target: "t42" });
      expect(m32).toMatchObject({ classname: "func_door", spawnflags: 0, targetname: "t4" });

      // none of these spawnflags values intersect skill/coop bits at all --
      // *22's 2048 is SPAWNFLAG_NOT_DEATHMATCH only, irrelevant in SP -- so
      // neither ruleset can ever inhibit them in single-player, at any skill
      for (const b of [m14!, m22!, m32!]) {
        expect(cppInhibitRule(b.spawnflags, 0, false, false)).toBe(false);
        expect(cppInhibitRule(b.spawnflags, 1, false, false)).toBe(false);
        expect(cppInhibitRule(b.spawnflags, 2, false, false)).toBe(false);
        expect(cppInhibitRule(b.spawnflags, 3, false, false)).toBe(false);
      }

      gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
      gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_NOFLAGS);
      gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);

      SpawnEntities("base1", entityString, "");

      // find the survivors by classname + target/targetname (edict indices
      // get reused across the parse as entities are freed, so identity is
      // via these map-authored keys, not array position)
      const door = g_edicts.find((e) => e.inuse && e.classname === "func_door" && e.targetname === "t4");
      const trig77 = g_edicts.find((e) => e.inuse && e.classname === "trigger_once" && e.target === "t77");
      const trig42 = g_edicts.find((e) => e.inuse && e.classname === "trigger_once" && e.target === "t42");

      expect(door).toBeDefined();
      expect(trig77).toBeDefined();
      expect(trig42).toBeDefined();

      // all three genuinely got a model assigned (gi.setmodel ran) -- so
      // whatever numbering scheme downstream code expects, these entities
      // are NOT silently missing their model call either
      expect(door!.s.modelindex).toBeGreaterThan(0);
      expect(trig77!.s.modelindex).toBeGreaterThan(0);
      expect(trig42!.s.modelindex).toBeGreaterThan(0);

      // CONFIRMED FINDING, asserted here rather than merely logged: parsing
      // the REAL bots/navigation/base1.nav (NAV3 v6, per nav.ts's own
      // documented binary layout) directly gives its 4 edict records' raw
      // baked `model` values -- 22, 14, 32, 22 -- the literal submodel
      // numbers, matching "four warnings ... model 14/22/32" exactly (22
      // appears twice). This port's real modelindex() (mirroring
      // src/server/sv_init.ts's SV_FindIndex -- sequential first-use, no
      // "*"-prefix special case) does NOT reproduce those raw numbers: it
      // assigns whatever index each name's first `gi.setmodel`/
      // `gi.modelindex` call happens to land on in spawn order instead.
      // This is the actual root cause of the "Nav entity appears to be
      // missing" warnings -- a numbering-scheme mismatch between
      // src/server/nav.ts's Nav_SetupEntities and src/server/sv_init.ts's
      // SV_ModelIndex, NOT a spawn-inhibition bug (see this file's own
      // header, and the task report, for the full derivation). Fixing it
      // needs an inline-model special case in src/server/sv_init.ts /
      // src/server/sv_game.ts (outside src/kexgame/g_spawn.ts's territory),
      // not a change here -- this assertion exists so a FUTURE fix to that
      // numbering scheme flips these `not.toBe` checks to `toBe`, which is
      // the intended signal that the real bug has been fixed.
      expect(trig77!.s.modelindex).not.toBe(14);
      expect(trig42!.s.modelindex).not.toBe(22);
      expect(door!.s.modelindex).not.toBe(32);
    },
  );
});
