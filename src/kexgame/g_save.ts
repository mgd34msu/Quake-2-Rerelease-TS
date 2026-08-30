// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_save.c -- the 2023 Quake II re-release ("KEX") JSON save system. Ported
// from ~/Projects/quake2-rerelease-dll/rerelease/g_save.cpp (2,608 lines,
// C++17): the save_type_t/save_struct_t/save_field_t reflection tables for
// game_locals_t/level_locals_t/gclient_t/edict_t (and every struct nested
// inside them), write_save_type_json/read_save_type_json,
// write_save_struct_json/read_save_struct_json, and the four 2023-API entry
// points WriteGameJson/ReadGameJson/WriteLevelJson/ReadLevelJson plus
// G_CanSave (g_save.cpp:2393-2605).
//
// ============================================================================
// SCOPE / FIDELITY CONTRACT
// ============================================================================
// The C++ source's reflection tables key every field by BYTE OFFSET
// (`offsetof(struct, field)`) into a save_type_id_t. TS has no offsetof, so
// this file replaces "offset + type id" with "get/set closure pair + kind"
// -- a `FieldDescriptor<T>` (see "GENERIC FIELD-DESCRIPTOR ENGINE" below).
// The JSON SHAPE this produces is required to match the C++ writer exactly
// (field names, nesting-vs-flattening, and per-type encodings), because a
// save file this module writes needs to interoperate with saves the real
// re-release/q2repro binary produces, and vice versa. Every struct's field
// list below is transcribed 1:1 from g_save.cpp's own `SAVE_STRUCT_START`
// blocks (g_save.cpp:661-1307), cross-checked field-by-field against this
// port's actual TS shapes (src/kexgame/g_local_types.ts). Fields the C++
// struct deliberately omits (there is always an explicit "// not necessary
// to persist"-style comment at the omission site in g_save.cpp) are
// deliberately NOT given a descriptor here either, even where the richer TS
// type has the field available -- see "FIELD-TABLE COVERAGE AUDIT" below for
// how that was verified.
//
// ============================================================================
// FINDING: how jsoncpp actually encodes uint64/bigint fields (aiflags,
// EntFlagsT, EffectsT)
// ============================================================================
// g_save.cpp's ST_UINT64 write path (write_save_type_json, g_save.cpp:1992-
// 1997) is:
//     output = Json::Value(*(const uint64_t *) data);
// and the read path (read_save_type_json, g_save.cpp:1529-1534) is:
//     if (!json.isUInt64()) ...; else *((uint64_t *) data) = json.asUInt64();
// jsoncpp's `Json::Value` has a genuine 64-bit integer variant internally
// (it does NOT round-trip large integers through an IEEE double the way a
// naive "store everything as a JS number" JSON implementation would), and
// its default StreamWriter prints that variant as a bare, unquoted integer
// literal -- e.g. `"aiflags": 18446744069414584320`, not a quoted string and
// not scientific notation. This matters because JS's native `JSON.parse`/
// `JSON.stringify` round-trip every number through a `double`, which starts
// silently losing integer precision above `Number.MAX_SAFE_INTEGER`
// (2^53-1) -- well within the range real `MonsterAiFlagsT`/`EntFlagsT`/
// `EffectsT` values reach (bit 32+ flags exist in all three enums; see
// g_local.ts's `MonsterAiFlagsT`/`EntFlagsT` and kexapi/game.ts's
// `EffectsT`, all three declared `bigint` in this port for exactly this
// reason). Concretely: `JSON.stringify(JSON.parse("18446744069414584320"))`
// prints `"18446744069414584320"` truncated/rounded to
// `18446744069414584000` in Node/Bun -- a SILENT, WRONG round trip for any
// flag combination with a bit at or above 53 set.
//
// This file therefore never routes any JSON number through native
// `JSON.parse`/`JSON.stringify` at all (see "CUSTOM JSON CODEC" below): its
// own hand-rolled parser preserves the exact source digit text of every
// numeric literal in a `JNum` wrapper, and its own hand-rolled writer emits
// `bigint` values via `BigInt.prototype.toString()` (exact decimal digits,
// no double round-trip) as a bare unquoted literal -- byte-for-byte the
// same wire shape jsoncpp produces for ST_UINT64, and lossless in both
// directions for the full 64-bit range. Every other numeric kind (int32,
// float, gtime milliseconds) also flows through this same custom codec, so
// the fix is structural (one codec for the whole file) rather than a
// bigint-only patch.
//
// ============================================================================
// FINDING: flattened dotted keys vs. true nested objects
// ============================================================================
// The C `FIELD_AUTO(a.b)` macro stringifies its argument verbatim
// (`SAVE_FIELD(n, f)` expands to `#f, offsetof(n, f)`), so a field reached
// through a dotted C++ member-access expression -- `moveinfo.start_origin`,
// `monsterinfo.aiflags`, `fog.color`, `kick.angles`, `resp.entertime`, ...
// -- produces a JSON key that is the LITERAL FLAT STRING
// `"moveinfo.start_origin"` etc., a sibling of every other top-level key in
// that struct's object, NOT a nested `"moveinfo": {...}` sub-object. Nesting
// only happens for the small number of fields declared with the
// `FIELD_STRUCT(name, type)` macro (a real `ST_STRUCT`, which recurses into
// its own object): `player_state_t::pmove`, `gclient_t::ps`,
// `gclient_t::pers`, `gclient_t::resp.coop_respawn` (note: FIELD_STRUCT with
// a dotted NAME still produces a flat key `"resp.coop_respawn"` whose VALUE
// is a nested object -- the dot only affects the key text, not whether
// ST_STRUCT recurses), and `client_persistant_t::wanted_heightfog`.
// Everything else that "looks nested" in the C struct (moveinfo,
// monsterinfo, fog, heightfog, bmodel_anim, kick, lastMOD, the flat parts of
// resp) is flattened to dotted top-level keys. This file's
// `flattenPrefixed()` helper (see below) produces exactly that: field
// descriptors whose closures reach into a nested TS property but whose JSON
// `name` is the dotted flat string, matching the real wire format. (The
// predecessor `src/game/g_save.ts` nests moveinfo/monsterinfo as real
// sub-objects -- that was correct for the vanilla/legacy format, which has
// no C++ precedent to match; it is NOT correct for this kex-line format,
// which does have one.)
//
// ============================================================================
// FIELD-TABLE COVERAGE AUDIT (how "no field silently unsaved" is verified)
// ============================================================================
// Every struct's field table below is a single array consumed by BOTH the
// generic writer (`writeStruct`) and the generic reader (`readStruct`) --
// there is no separate hand-written serialize/deserialize function pair to
// let drift silently between write and read (unlike the legacy precedent's
// per-struct `serializeX`/`deserializeX` pairs, where forgetting to update
// one side compiles fine and fails silently at runtime). Coverage against
// the C++ source was verified by transcribing each `SAVE_STRUCT_START`
// block in g_save.cpp (game_locals_t g_save.cpp:661-680, level_locals_t
// :683-742, pmove_state_t :745-755, player_state_t :758-776, height_fog_t
// :779-785, client_persistant_t :788-825, gclient_t :828-932, edict_t
// :948-1306) into an ordered list of field names in this file's own
// comments immediately above each field table, in the SAME order the C++
// declares them, then writing one descriptor per line and checking off each
// C++ line as it was ported. Any C++ field this file's field table skips is
// called out with a one-line reason (either an explicit "not necessary to
// persist"-style C++ comment at that field, or -- for exactly one field,
// `monsterinfo.physics_change` -- a field this TS port's registry supports
// but the actual C++ `edict_t_savestruct`/`SAVE_STRUCT_START` block for
// edict_t never references via FIELD_AUTO; grepped g_save.cpp for
// "physics_change"/"physchange": zero matches outside the type-deducer
// machinery, so it is genuinely unsaved in the real engine, not a porting
// gap here).
//
// ============================================================================
// FINDING: gravity / gravityVector custom emptiness (the only two
// `.set_is_empty()` overrides in the whole edict_t table)
// ============================================================================
// g_save.cpp:936-945 defines `edict_t_gravity_is_empty` (empty when
// `gravity == 1.0f`, NOT `0.0f` -- 1.0 is "no override", the field's real
// default) and `edict_t_gravityVector_is_empty` (empty when `gravityVector
// == (0,0,-1)`, not the zero vector). These are the ONLY two fields in the
// entire edict_t table with a non-default emptiness rule; every other float/
// vec3 field omits itself from the JSON when it equals plain zero. Ported
// as explicit `isEmpty` overrides on those two descriptors only.
//
// ============================================================================
// OTHER NOTED DEVIATIONS
// ============================================================================
// - File I/O: the 2023 API is string-in/string-out (`char *WriteGameJson(...,
//   size_t *out_size)` / `void ReadGameJson(const char *jsonString)`) --
//   "the engine owns file I/O, the game never touches the filesystem" per
//   this unit's brief. `FS_ReadRawFile`/`FS_WriteFile` (used by the legacy
//   `src/game/g_save.ts`) are NOT used here; every entry point below takes/
//   returns a plain `string`.
// - Version gate: g_save.cpp's WriteGameJson/WriteLevelJson both write
//   `json["save_version"] = SAVE_FORMAT_VERSION`, but neither
//   ReadGameJson nor ReadLevelJson in g_save.cpp itself reads that field
//   back (grepped: `save_version` only ever appears on the WRITE side of
//   this file) -- the real engine's version gate lives one layer up, in the
//   save-file HEADER the engine reads before ever calling into this game-
//   side JSON code at all, which this port has no analog of. Since nothing
//   else in this game-side module would otherwise reject a version-mismatched
//   file, this port adds the check here (`checkSaveVersion`), mirroring the
//   precedent the legacy `src/game/g_save.ts` already set for exactly this
//   gap (`ReadGame`'s own `stamp !== SAVE_VERSION_STAMP` check).
// - `gi.TagMalloc`/`gi.FreeTags` (memory-tag bookkeeping around every
//   allocation in the C++ read paths) have no TS analog -- per PORTING.md's
//   "Z_Malloc/... -> plain allocation" convention, every place the C++
//   reallocates via a memory tag, this file just builds a fresh plain
//   array/object (GC-managed).
// - `gi.LocClient_Print(&g_edicts[1], PRINT_CENTER, "$g_no_save_dead")`
//   (G_CanSave's player-facing message, g_save.cpp:2594) is not ported --
//   this file's `G_CanSave` returns the same boolean the C++ does, but does
//   not attempt the localized on-screen message (no `LocClient_Print`
//   exists on this port's `KexGameImports`; only a plain `Client_Print`
//   does, and choosing a message-formatting scheme for it is outside a
//   save-format unit's scope). Documented, not silently dropped.
// - `gi.FreeTags`/`cached_soundindex::reset_all()` /
//   `cached_modelindex::reset_all()` / `cached_imageindex::reset_all()` /
//   `G_PrecacheInventoryItems()` / `G_LoadShadowLights()` (ReadGameJson/
//   ReadLevelJson's tail calls, g_save.cpp:2462, 2579-2586) are precaching/
//   rendering-cache concerns with no owning module in this port yet; not
//   called here. Flagged for the coordinator: whichever unit owns
//   precaching should call these (if/when ported) right after
//   `ReadGameJson`/`ReadLevelJson` return, exactly where g_save.cpp calls
//   them.
// - `gtime_t` fields serialize as the C++ does: milliseconds, as a plain
//   (non-bigint) integer JSON literal (`ST_TIME`'s `output =
//   Json::Value(time.milliseconds())`, g_save.cpp:2209) -- this port's
//   `GTime` is already a branded `number` of milliseconds (gtime.ts), so no
//   conversion beyond `Gtime_milliseconds`/`Gtime_from_ms` is needed.
// - `SetGameImports`/`SetGameExports`/`SetGEdicts`/`gi`/`globals`/`g_edicts`/
//   `game`/`level` are consumed exactly as g_utils.ts and p_client.ts
//   already do (imported from `./g_main_globals`) -- this file assumes they
//   are wired up before any entry point below runs, same as every other
//   behavior-porting unit in this line.
// - `defaultClientPersistant`/`defaultClientRespawn`/`defaultGClient`/
//   `defaultKexPmoveState`/`defaultKexPlayerState`/`defaultGameLocals`/
//   `defaultLevelLocals` are LOCAL, duplicated copies of the equivalent
//   (unexported) factories already in `p_client.ts`/`g_main_globals.ts`,
//   field-for-field identical to those. This mirrors g_utils.ts's own
//   documented convention ("duplicate the tiny unexported helper, don't
//   reach across files for it" -- see that file's "G_ShouldPlayersCollide"
//   note) rather than exporting private factories out of files this unit
//   does not own.
//
// ============================================================================
// GENERIC FIELD-DESCRIPTOR ENGINE
// ============================================================================
// A `FieldDescriptor<T>` pairs a JSON key name with an `encode`/`decode`
// closure pair; `writeStruct`/`readStruct` walk an ordered array of these
// exactly the way g_save.cpp's `write_save_struct_json`/
// `read_save_struct_json` walk a `save_struct_t`'s `fields` initializer
// list. Per-kind factory functions (`intField`, `floatField`, `vec3Field`,
// ...) build individual descriptors so each field's declaration below is a
// single terse line, the same ergonomics `FIELD_AUTO(f)` gives the C++ side.

import { vec3, type Vec3 } from "../shared/math";
import {
  MAX_CLIENTS,
  MAX_EDICTS,
  MAX_SPLIT_PLAYERS,
  MAX_STATS,
  ButtonT,
  CvarFlagsT,
  KexPmTypeT,
  RefdefFlagsT,
  WaterLevelT,
  type KexPlayerStateT,
  type KexPmoveStateT,
} from "../kexapi/game";
import {
  AmmoT,
  AnimPriorityT,
  AutoSwitchT,
  EntFlagsT,
  HandednessT,
  ItemIdT,
  MAX_HEALTH_BARS,
  MAX_LEVELS_PER_UNIT,
  MAX_REINFORCEMENTS,
  WeaponstateT,
} from "./g_local";
import type {
  ClientPersistantT,
  ClientRespawnT,
  EdictT,
  GameLocalsT,
  GClientT,
  GitemT,
  HeightFogT,
  LevelEntryT,
  LevelLocalsT,
  ModT,
  MonsterinfoT,
  MoveinfoT,
  ReinforcementT,
} from "./g_local_types";
import { CtfteamT } from "./g_local_types";
import {
  GTIME_ZERO,
  Gtime_add,
  Gtime_from_ms,
  Gtime_from_sec,
  Gtime_milliseconds,
  Gtime_nonzero,
  type GTime,
} from "./gtime";
import { SpawnFlags_from, SpawnFlags_value, type SpawnFlags } from "./spawnflags";
import { defaultEdict, g_edicts, game, gi, globals, level, SetGEdicts } from "./g_main_globals";
// IMPORT ORDER IS LOAD-BEARING: g_utils.ts must be imported before
// g_items.ts. g_utils.ts <-> p_client.ts <-> g_items.ts form a real import
// cycle, and p_client.ts's own `const Touch_Item = G_Touch_Item;`
// (g_items.ts's `Touch_Item` re-bound through the cycle) is only guaranteed
// initialized by the time p_client.ts reads it if g_utils.ts has ALREADY
// begun evaluating when g_items.ts is first reached (so p_client.ts's own
// import of g_items.ts, triggered while g_utils.ts is mid-evaluation,
// resolves g_items.ts fresh and lets it run all the way to its `Touch_Item`
// declaration before p_client.ts needs it). Importing g_items.ts first
// instead makes g_items.ts the one that pulls in g_utils.ts (hence
// p_client.ts) mid-way through g_items.ts's OWN evaluation, before
// g_items.ts's later `Touch_Item` declaration has run -- leaving it in its
// temporal dead zone. Confirmed empirically in isolation (bare
// `import "./g_utils"; import "./g_items";` vs. the reverse order) and
// reproduced independent of every other symbol this file imports; this is
// p_client.ts's/g_items.ts's own pre-existing ordering fragility (see
// PORTING.md's "no top-level const across a cyclic import" rule), not
// something introduced here. Do not reorder these two imports.
import { G_InitEdict } from "./g_utils";
import { FindItemByClassname, GetItemByIndex } from "./g_items";
import {
  LookupDie,
  LookupMmove,
  LookupMonsterinfoAttack,
  LookupMonsterinfoBlocked,
  LookupMonsterinfoCheckattack,
  LookupMonsterinfoDodge,
  LookupMonsterinfoDuck,
  LookupMonsterinfoIdle,
  LookupMonsterinfoMelee,
  LookupMonsterinfoRun,
  LookupMonsterinfoSearch,
  LookupMonsterinfoSetskin,
  LookupMonsterinfoSidestep,
  LookupMonsterinfoSight,
  LookupMonsterinfoStand,
  LookupMonsterinfoUnduck,
  LookupMonsterinfoWalk,
  LookupMoveinfoBlocked,
  LookupMoveinfoEndfunc,
  LookupPain,
  LookupPrethink,
  LookupThink,
  LookupTouch,
  LookupUse,
  NameOfDie,
  NameOfMmove,
  NameOfMonsterinfoAttack,
  NameOfMonsterinfoBlocked,
  NameOfMonsterinfoCheckattack,
  NameOfMonsterinfoDodge,
  NameOfMonsterinfoDuck,
  NameOfMonsterinfoIdle,
  NameOfMonsterinfoMelee,
  NameOfMonsterinfoRun,
  NameOfMonsterinfoSearch,
  NameOfMonsterinfoSetskin,
  NameOfMonsterinfoSidestep,
  NameOfMonsterinfoSight,
  NameOfMonsterinfoStand,
  NameOfMonsterinfoUnduck,
  NameOfMonsterinfoWalk,
  NameOfMoveinfoBlocked,
  NameOfMoveinfoEndfunc,
  NameOfPain,
  NameOfPrethink,
  NameOfThink,
  NameOfTouch,
  NameOfUse,
} from "./g_save_registry";

// -------------------------------------------------------------------------
// SAVE_FORMAT_VERSION (g_save.cpp:25)
// -------------------------------------------------------------------------

export const SAVE_FORMAT_VERSION = 1;

// -------------------------------------------------------------------------
// CUSTOM JSON CODEC -- see file header "FINDING: how jsoncpp actually
// encodes uint64/bigint fields" for why this exists instead of native
// JSON.parse/JSON.stringify.
// -------------------------------------------------------------------------

/** A numeric JSON literal, stored as its exact source digit text rather
 *  than as a JS `number` (which cannot exactly represent every int64/uint64
 *  value) or `bigint` (which cannot represent a fractional/float literal).
 *  Field-kind-specific decoders (`numToNumber`/`numToBigInt`) interpret the
 *  raw text according to what THAT field expects, mirroring
 *  read_save_type_json's switch-on-declared-type behavior. */
class JNum {
  constructor(readonly raw: string) {}
}

export type JVal = null | boolean | string | JNum | JVal[] | { [key: string]: JVal };

const OMIT: unique symbol = Symbol("g_save: omit field");
type EncodeResult = JVal | typeof OMIT;

function jInt(v: number): JNum {
  return new JNum(String(Math.trunc(v)));
}
function jBig(v: bigint): JNum {
  return new JNum(v.toString());
}
function jFloat(v: number): JNum {
  if (Number.isNaN(v)) return new JNum("NaN");
  if (v === Number.POSITIVE_INFINITY) return new JNum("Infinity");
  if (v === Number.NEGATIVE_INFINITY) return new JNum("-Infinity");
  // Ensure the literal carries a decimal point so it round-trips as a
  // "double" the way jsoncpp's own float/double writer does (jsoncpp never
  // emits a whole-number double as a bare integer literal).
  return new JNum(Number.isInteger(v) ? `${v}.0` : String(v));
}

export type WarnSink = (path: string, message: string) => void;
function noopWarn(): void {
  /* default: non-strict, matches g_strict_saves off -- warn and continue */
}

function numToNumber(v: JVal, warn: WarnSink, path: string): number | null {
  if (!(v instanceof JNum)) {
    warn(path, "expected number");
    return null;
  }
  if (v.raw === "NaN") return NaN;
  if (v.raw === "Infinity") return Number.POSITIVE_INFINITY;
  if (v.raw === "-Infinity") return Number.NEGATIVE_INFINITY;
  const n = Number(v.raw);
  if (Number.isNaN(n)) {
    warn(path, `invalid number literal "${v.raw}"`);
    return null;
  }
  return n;
}

function numToBigInt(v: JVal, warn: WarnSink, path: string): bigint | null {
  if (!(v instanceof JNum)) {
    warn(path, "expected integer");
    return null;
  }
  try {
    return BigInt(v.raw);
  } catch {
    warn(path, `invalid 64-bit integer literal "${v.raw}"`);
    return null;
  }
}

/** Serializes a `JVal` tree to text. Tab-indented to mirror jsoncpp's own
 *  `builder["indentation"] = "\t"` (saveJson, g_save.cpp:2377) -- cosmetic,
 *  not load-bearing for round-tripping, but kept for documentation fidelity. */
export function writeJSON(root: JVal): string {
  const out: string[] = [];
  write(root, "");
  return out.join("");

  function write(val: JVal, indent: string): void {
    if (val === null) {
      out.push("null");
      return;
    }
    if (typeof val === "boolean") {
      out.push(val ? "true" : "false");
      return;
    }
    if (typeof val === "string") {
      out.push(JSON.stringify(val)); // safe: only ever used to escape TEXT, never a number
      return;
    }
    if (val instanceof JNum) {
      out.push(val.raw);
      return;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) {
        out.push("[]");
        return;
      }
      const inner = `${indent}\t`;
      out.push("[\n");
      for (let i = 0; i < val.length; i++) {
        out.push(inner);
        write(val[i], inner);
        out.push(i === val.length - 1 ? "\n" : ",\n");
      }
      out.push(`${indent}]`);
      return;
    }
    const keys = Object.keys(val);
    if (keys.length === 0) {
      out.push("{}");
      return;
    }
    const inner = `${indent}\t`;
    out.push("{\n");
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      out.push(inner, JSON.stringify(key), ": ");
      write(val[key], inner);
      out.push(i === keys.length - 1 ? "\n" : ",\n");
    }
    out.push(`${indent}}`);
  }
}

/** Hand-rolled recursive-descent JSON parser (see file header for why native
 *  `JSON.parse` cannot be used). Supports the `NaN`/`Infinity`/`-Infinity`
 *  bare-identifier literals jsoncpp emits when `useSpecialFloats` is set
 *  (parseJson/saveJson both set it, g_save.cpp:2360/2378). */
export function parseJSONText(text: string): JVal {
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  }

  function parseValue(): JVal {
    skipWs();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("NaN", i)) {
      i += 3;
      return new JNum("NaN");
    }
    if (text.startsWith("-Infinity", i)) {
      i += 9;
      return new JNum("-Infinity");
    }
    if (text.startsWith("Infinity", i)) {
      i += 8;
      return new JNum("Infinity");
    }
    return parseNumber();
  }

  function parseObject(): { [key: string]: JVal } {
    i++; // '{'
    const obj: { [key: string]: JVal } = {};
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[i] !== ":") throw new Error(`g_save: expected ':' at offset ${i}`);
      i++;
      obj[key] = parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      throw new Error(`g_save: expected ',' or '}' at offset ${i}`);
    }
    return obj;
  }

  function parseArray(): JVal[] {
    i++; // '['
    const arr: JVal[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      throw new Error(`g_save: expected ',' or ']' at offset ${i}`);
    }
    return arr;
  }

  function parseString(): string {
    if (text[i] !== '"') throw new Error(`g_save: expected string at offset ${i}`);
    i++;
    let s = "";
    while (text[i] !== '"') {
      if (i >= n) throw new Error("g_save: unterminated string");
      const ch = text[i];
      if (ch === "\\") {
        i++;
        const esc = text[i];
        switch (esc) {
          case '"':
            s += '"';
            break;
          case "\\":
            s += "\\";
            break;
          case "/":
            s += "/";
            break;
          case "b":
            s += "\b";
            break;
          case "f":
            s += "\f";
            break;
          case "n":
            s += "\n";
            break;
          case "r":
            s += "\r";
            break;
          case "t":
            s += "\t";
            break;
          case "u":
            s += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
            i += 4;
            break;
          default:
            throw new Error(`g_save: bad escape "\\${esc}"`);
        }
        i++;
      } else {
        s += ch;
        i++;
      }
    }
    i++; // closing quote
    return s;
  }

  function parseNumber(): JNum {
    const start = i;
    if (text[i] === "-") i++;
    while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === ".") {
      i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (i === start) throw new Error(`g_save: invalid number at offset ${i}`);
    return new JNum(text.slice(start, i));
  }

  const result = parseValue();
  skipWs();
  return result;
}

// -------------------------------------------------------------------------
// FieldDescriptor<T> + writeStruct/readStruct
// -------------------------------------------------------------------------

interface FieldDescriptor<T> {
  readonly name: string;
  encode(o: T): EncodeResult;
  decode(o: T, v: JVal, warn: WarnSink, path: string): void;
}

function writeStruct<T>(o: T, fields: readonly FieldDescriptor<T>[]): { [key: string]: JVal } {
  const obj: { [key: string]: JVal } = {};
  for (const f of fields) {
    const v = f.encode(o);
    if (v !== OMIT) obj[f.name] = v;
  }
  return obj;
}

function readStruct<T>(o: T, fields: readonly FieldDescriptor<T>[], json: JVal, warn: WarnSink, path: string): void {
  if (json === null || typeof json !== "object" || Array.isArray(json) || json instanceof JNum) {
    warn(path, "expected object");
    return;
  }
  for (const key of Object.keys(json)) {
    const field = fields.find((f) => f.name === key);
    if (field === undefined) {
      warn(`${path}.${key}`, "unknown field");
      continue;
    }
    field.decode(o, json[key], warn, `${path}.${key}`);
  }
}

// -------------------------------------------------------------------------
// Per-kind field factories
// -------------------------------------------------------------------------

// Sanctioned numeric-widening cast boundary (mirrors gtime.ts's `brand()`/
// spawnflags.ts's `brand()`): TS numeric enums (`MovetypeT`, `WaterLevelT`,
// ...) and plain `number` are not mutually assignable without a cast even
// though every enum member IS a `number` at runtime. This is the ONE place
// in this file that bridges "a value read off the wire as a JS number" back
// into whatever numeric/enum type a given field actually declares -- every
// individual field declaration below stays cast-free.
function widenNumber<V extends number>(n: number): V {
  return n as V;
}

function boolField<T>(name: string, get: (o: T) => boolean, set: (o: T, v: boolean) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => (get(o) ? true : OMIT),
    decode: (o, v, warn, path) => {
      if (typeof v !== "boolean") {
        warn(path, "expected boolean");
        return;
      }
      set(o, v);
    },
  };
}

function intField<T, V extends number>(name: string, get: (o: T) => V, set: (o: T, v: V) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = get(o);
      return v === 0 ? OMIT : jInt(v);
    },
    decode: (o, v, warn, path) => {
      const n = numToNumber(v, warn, path);
      if (n === null) return;
      set(o, widenNumber<V>(n));
    },
  };
}

function floatField<T, V extends number>(
  name: string,
  get: (o: T) => V,
  set: (o: T, v: V) => void,
  isEmpty?: (v: V) => boolean,
): FieldDescriptor<T> {
  const empty = isEmpty ?? ((v: V) => v === 0);
  return {
    name,
    encode: (o) => {
      const v = get(o);
      return empty(v) ? OMIT : jFloat(v);
    },
    decode: (o, v, warn, path) => {
      const n = numToNumber(v, warn, path);
      if (n === null) return;
      set(o, widenNumber<V>(n));
    },
  };
}

function bigintField<T>(name: string, get: (o: T) => bigint, set: (o: T, v: bigint) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = get(o);
      return v === 0n ? OMIT : jBig(v);
    },
    decode: (o, v, warn, path) => {
      const n = numToBigInt(v, warn, path);
      if (n === null) return;
      set(o, n);
    },
  };
}

function timeField<T>(name: string, get: (o: T) => GTime, set: (o: T, v: GTime) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const ms = Gtime_milliseconds(get(o));
      return ms === 0 ? OMIT : jInt(ms);
    },
    decode: (o, v, warn, path) => {
      const n = numToNumber(v, warn, path);
      if (n === null) return;
      set(o, Gtime_from_ms(n));
    },
  };
}

function spawnflagsField<T>(name: string, get: (o: T) => SpawnFlags, set: (o: T, v: SpawnFlags) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = SpawnFlags_value(get(o));
      return v === 0 ? OMIT : jInt(v);
    },
    decode: (o, v, warn, path) => {
      const n = numToNumber(v, warn, path);
      if (n === null) return;
      set(o, SpawnFlags_from(n));
    },
  };
}

/** Dynamic, nullable string (`ST_STRING`): omitted from the JSON entirely
 *  when null, matching `TYPED_DATA_IS_EMPTY(type, *str == nullptr)`. */
function stringField<T>(name: string, get: (o: T) => string | null, set: (o: T, v: string | null) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = get(o);
      return v === null ? OMIT : v;
    },
    decode: (o, v, warn, path) => {
      if (v === null) {
        set(o, null);
        return;
      }
      if (typeof v !== "string") {
        warn(path, "expected string or null");
        return;
      }
      set(o, v);
    },
  };
}

/** Fixed-size, never-null string (`ST_FIXED_STRING`, C `char[N]`): omitted
 *  when empty, matching `TYPED_DATA_IS_EMPTY(type, !strlen(data))`. */
function fixedStringField<T>(name: string, get: (o: T) => string, set: (o: T, v: string) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = get(o);
      return v.length === 0 ? OMIT : v;
    },
    decode: (o, v, warn, path) => {
      if (typeof v !== "string") {
        warn(path, "expected string");
        return;
      }
      set(o, v);
    },
  };
}

function floatArrayField<T, A extends ArrayLike<number> & { [i: number]: number }>(
  name: string,
  get: (o: T) => A,
  len: number,
  isEmpty?: (v: A) => boolean,
): FieldDescriptor<T> {
  const empty =
    isEmpty ??
    ((v: A) => {
      for (let i = 0; i < len; i++) if (v[i] !== 0) return false;
      return true;
    });
  return {
    name,
    encode: (o) => {
      const v = get(o);
      if (empty(v)) return OMIT;
      const out: JVal[] = [];
      for (let i = 0; i < len; i++) out.push(jFloat(v[i]));
      return out;
    },
    decode: (o, v, warn, path) => {
      if (!Array.isArray(v) || v.length !== len) {
        warn(path, `expected array[${len}]`);
        return;
      }
      const dest = get(o);
      for (let i = 0; i < len; i++) {
        const n = numToNumber(v[i], warn, `${path}[${i}]`);
        if (n !== null) dest[i] = n;
      }
    },
  };
}

/** `vec3_t` (`ST_FIXED_ARRAY` of 3 floats) -- writes into the SAME `Vec3`
 *  buffer the getter returns rather than replacing the reference, per
 *  q_vec3.ts's aliasing-hazard convention. */
function vec3Field<T>(name: string, get: (o: T) => Vec3, isEmpty?: (v: Vec3) => boolean): FieldDescriptor<T> {
  return floatArrayField<T, Vec3>(name, get, 3, isEmpty);
}

function intArrayField<T>(name: string, get: (o: T) => ArrayLike<number> & { [i: number]: number }, len: number): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = get(o);
      let allZero = true;
      for (let i = 0; i < len; i++) {
        if (v[i] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) return OMIT;
      const out: JVal[] = [];
      for (let i = 0; i < len; i++) out.push(jInt(v[i]));
      return out;
    },
    decode: (o, v, warn, path) => {
      if (!Array.isArray(v) || v.length !== len) {
        warn(path, `expected array[${len}]`);
        return;
      }
      const dest = get(o);
      for (let i = 0; i < len; i++) {
        const n = numToNumber(v[i], warn, `${path}[${i}]`);
        if (n !== null) dest[i] = Math.trunc(n);
      }
    },
  };
}

/** `ST_SAVABLE_DYNAMIC` of float -- `moveinfo.curve_positions`'s
 *  `Float32Array | null`, the one genuinely variable-length, nullable
 *  numeric array in the whole edict_t table. */
function floatDynamicArrayField<T>(name: string, get: (o: T) => Float32Array | null, set: (o: T, v: Float32Array | null) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const v = get(o);
      if (v === null || v.length === 0) return OMIT;
      const out: JVal[] = [];
      for (let i = 0; i < v.length; i++) out.push(jFloat(v[i]));
      return out;
    },
    decode: (o, v, warn, path) => {
      if (v === null) {
        set(o, null);
        return;
      }
      if (!Array.isArray(v)) {
        warn(path, "expected array or null");
        return;
      }
      const arr = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) {
        const n = numToNumber(v[i], warn, `${path}[${i}]`);
        if (n !== null) arr[i] = n;
      }
      set(o, arr);
    },
  };
}

/** `ST_ENTITY`: serialized as `s.number`, `null` for a null pointer. */
function entityField<T>(name: string, get: (o: T) => EdictT | null, set: (o: T, v: EdictT | null) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const e = get(o);
      return e === null ? OMIT : jInt(e.s.number);
    },
    decode: (o, v, warn, path) => {
      if (v === null) {
        set(o, null);
        return;
      }
      const n = numToNumber(v, warn, path);
      if (n === null) return;
      const idx = Math.trunc(n);
      if (idx < 0 || idx >= g_edicts.length) {
        warn(path, "entity index out of range");
        return;
      }
      set(o, g_edicts[idx] ?? null);
    },
  };
}

/** Fixed-length array of `ST_ENTITY` (`level.monsters_registered`/
 *  `level.health_bar_entities`). */
function entityArrayField<T>(name: string, get: (o: T) => (EdictT | null)[], len: number): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const arr = get(o);
      let allNull = true;
      for (let i = 0; i < len; i++) if (arr[i] !== null) { allNull = false; break; }
      if (allNull) return OMIT;
      const out: JVal[] = [];
      for (let i = 0; i < len; i++) {
        const e = arr[i];
        out.push(e === null ? null : jInt(e.s.number));
      }
      return out;
    },
    decode: (o, v, warn, path) => {
      if (!Array.isArray(v) || v.length !== len) {
        warn(path, `expected array[${len}]`);
        return;
      }
      const arr = get(o);
      for (let i = 0; i < len; i++) {
        const item = v[i];
        if (item === null) {
          arr[i] = null;
          continue;
        }
        const n = numToNumber(item, warn, `${path}[${i}]`);
        if (n === null) continue;
        const idx = Math.trunc(n);
        arr[i] = idx >= 0 && idx < g_edicts.length ? (g_edicts[idx] ?? null) : null;
      }
    },
  };
}

/** `ST_ITEM_POINTER`: serialized as `classname`, `null` for a null pointer. */
function itemPointerField<T>(name: string, get: (o: T) => GitemT | null, set: (o: T, v: GitemT | null) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const item = get(o);
      return item === null ? OMIT : (item.classname ?? "");
    },
    decode: (o, v, warn, path) => {
      if (v === null) {
        set(o, null);
        return;
      }
      if (typeof v !== "string") {
        warn(path, "expected string or null");
        return;
      }
      const item = FindItemByClassname(v);
      if (item === null) {
        warn(path, `item "${v}" missing`);
        return;
      }
      set(o, item);
    },
  };
}

/** `ST_ITEM_INDEX`: an `item_id_t` serialized as its `classname`
 *  (`IT_NULL` <-> `null`), same wire shape as `ST_ITEM_POINTER` but the
 *  in-memory value is the numeric id, not a pointer. */
function itemIndexField<T, V extends number>(name: string, get: (o: T) => V, set: (o: T, v: V) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const idx = get(o);
      if (idx <= ItemIdT.IT_NULL) return OMIT;
      const item = GetItemByIndex(widenNumber<ItemIdT>(idx));
      return item === null || item.classname === null ? OMIT : item.classname;
    },
    decode: (o, v, warn, path) => {
      if (v === null) {
        set(o, widenNumber<V>(ItemIdT.IT_NULL));
        return;
      }
      if (typeof v !== "string") {
        warn(path, "expected string or null");
        return;
      }
      const item = FindItemByClassname(v);
      if (item === null) {
        warn(path, `item "${v}" missing`);
        return;
      }
      set(o, widenNumber<V>(item.id));
    },
  };
}

/** `ST_STRUCT`: a true nested sub-object, recursing into its own field
 *  table. Omitted when every sub-field turns out empty (matches
 *  `write_save_struct_json`'s own `null_for_empty && !obj.size()` check). */
function structField<T, S>(name: string, get: (o: T) => S, fields: readonly FieldDescriptor<S>[]): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const obj = writeStruct(get(o), fields);
      return Object.keys(obj).length === 0 ? OMIT : obj;
    },
    decode: (o, v, warn, path) => {
      readStruct(get(o), fields, v, warn, path);
    },
  };
}

/** Fixed-length array of `ST_STRUCT` (`game.level_entries`). The whole array
 *  is omitted only if EVERY element serializes to `{}`, matching
 *  `ST_FIXED_ARRAY`'s own element-wise emptiness scan
 *  (write_save_type_json, g_save.cpp:2039-2059). */
function structArrayField<T, S>(name: string, get: (o: T) => S[], fields: readonly FieldDescriptor<S>[]): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const arr = get(o).map((el) => writeStruct(el, fields));
      const allEmpty = arr.every((obj) => Object.keys(obj).length === 0);
      return allEmpty ? OMIT : arr;
    },
    decode: (o, v, warn, path) => {
      if (!Array.isArray(v)) {
        warn(path, "expected array");
        return;
      }
      const arr = get(o);
      const count = Math.min(v.length, arr.length);
      for (let i = 0; i < count; i++) readStruct(arr[i], fields, v[i], warn, `${path}[${i}]`);
    },
  };
}

/** Flattens a nested TS sub-object's own field table into the PARENT's flat
 *  field list, prefixing each JSON key with `"prefix."` -- see file header
 *  "FINDING: flattened dotted keys vs. true nested objects". */
function flattenPrefixed<T, S>(prefix: string, get: (o: T) => S, fields: readonly FieldDescriptor<S>[]): FieldDescriptor<T>[] {
  return fields.map((f) => ({
    name: `${prefix}.${f.name}`,
    encode: (o: T): EncodeResult => f.encode(get(o)),
    decode: (o: T, v: JVal, warn: WarnSink, path: string): void => f.decode(get(o), v, warn, path),
  }));
}

/** `ST_INVENTORY`: `Int32Array` (indexed by `item_id_t`) <-> `{classname:
 *  count}` object, skipping zero counts and (per g_save.cpp:2241-2247) any
 *  index with no registered item. */
function inventoryField<T>(name: string, get: (o: T) => Int32Array): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const inv = get(o);
      const obj: { [key: string]: JVal } = {};
      for (let id = ItemIdT.IT_NULL + 1; id < ItemIdT.IT_TOTAL; id++) {
        const count = inv[id] ?? 0;
        if (count === 0) continue;
        const item = GetItemByIndex(widenNumber<ItemIdT>(id));
        if (item === null || item.classname === null) continue;
        obj[item.classname] = jInt(count);
      }
      return Object.keys(obj).length === 0 ? OMIT : obj;
    },
    decode: (o, v, warn, path) => {
      if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof JNum) {
        warn(path, "expected object");
        return;
      }
      const inv = get(o);
      for (const classname of Object.keys(v)) {
        const n = numToNumber(v[classname], warn, `${path}.${classname}`);
        if (n === null) continue;
        const item = FindItemByClassname(classname);
        if (item === null) {
          warn(`${path}.${classname}`, `can't find item "${classname}"`);
          continue;
        }
        inv[item.id] = Math.trunc(n);
      }
    },
  };
}

/** `ST_REINFORCEMENTS`: `ReinforcementListT` <-> array of `{classname, mins,
 *  maxs, strength}` objects (g_save.cpp:1802-1870, 2259-2289). */
function reinforcementsField<T>(name: string, get: (o: T) => ReinforcementT[], set: (o: T, v: ReinforcementT[]) => void): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const list = get(o);
      if (list.length === 0) return OMIT;
      return list.map((r) => ({
        classname: r.classname ?? "",
        mins: [jInt(r.mins[0]), jInt(r.mins[1]), jInt(r.mins[2])],
        maxs: [jInt(r.maxs[0]), jInt(r.maxs[1]), jInt(r.maxs[2])],
        strength: jInt(r.strength),
      }));
    },
    decode: (o, v, warn, path) => {
      if (!Array.isArray(v)) {
        warn(path, "expected array");
        return;
      }
      const result: ReinforcementT[] = [];
      for (let i = 0; i < v.length; i++) {
        const entry = v[i];
        const entryPath = `${path}[${i}]`;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry instanceof JNum) {
          warn(entryPath, "expected object");
          continue;
        }
        const classnameV = entry["classname"];
        const minsV = entry["mins"];
        const maxsV = entry["maxs"];
        const strengthV = entry["strength"];
        if (typeof classnameV !== "string") {
          warn(`${entryPath}.classname`, "expected string");
          continue;
        }
        if (!Array.isArray(minsV) || minsV.length !== 3) {
          warn(`${entryPath}.mins`, "expected array[3]");
          continue;
        }
        if (!Array.isArray(maxsV) || maxsV.length !== 3) {
          warn(`${entryPath}.maxs`, "expected array[3]");
          continue;
        }
        if (strengthV === undefined) {
          warn(`${entryPath}.strength`, "expected int");
          continue;
        }
        const strength = numToNumber(strengthV, warn, `${entryPath}.strength`);
        if (strength === null) continue;
        const mins = vec3();
        const maxs = vec3();
        for (let x = 0; x < 3; x++) {
          const mv = numToNumber(minsV[x], warn, `${entryPath}.mins[${x}]`);
          const xv = numToNumber(maxsV[x], warn, `${entryPath}.maxs[${x}]`);
          if (mv !== null) mins[x] = mv;
          if (xv !== null) maxs[x] = xv;
        }
        result.push({ classname: classnameV, strength: Math.trunc(strength), mins, maxs });
      }
      set(o, result);
    },
  };
}

/** `std::bitset<N>` (`edict_t.item_picked_up_by`, ported here as
 *  `boolean[]`): a compact `"0"`/`"1"` string trimmed at the highest set
 *  bit, empty string/omitted when no bit is set -- byte-for-byte the same
 *  encoding as the C++ bitset deducer's custom read/write
 *  (save_type_deducer<std::bitset<N>>, g_save.cpp:524-591). */
function bitsetBooleansField<T>(name: string, get: (o: T) => boolean[]): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const bits = get(o);
      let highest = -1;
      for (let i = bits.length - 1; i >= 0; i--) {
        if (bits[i]) {
          highest = i;
          break;
        }
      }
      if (highest < 0) return OMIT;
      let s = "";
      for (let i = 0; i <= highest; i++) s += bits[i] ? "1" : "0";
      return s;
    },
    decode: (o, v, warn, path) => {
      if (typeof v !== "string") {
        warn(path, "expected string");
        return;
      }
      const bits = get(o);
      bits.fill(false);
      if (v.length > bits.length) {
        warn(path, "bitset length overflow");
        return;
      }
      for (let i = 0; i < v.length; i++) {
        if (v[i] === "0") continue;
        else if (v[i] === "1") bits[i] = true;
        else warn(path, "bad bitset value");
      }
    },
  };
}

/** Any `SAVE_FUNC_*`/`SAVE_DATA_MMOVE` registry-typed field: serialized as
 *  its registered name (`ST_DATA`), `null` for an unassigned callback. */
function functionRefField<T, V extends object>(
  name: string,
  get: (o: T) => V | null,
  set: (o: T, v: V | null) => void,
  lookup: (name: string) => V | null,
  nameOf: (v: V | null) => string | null,
): FieldDescriptor<T> {
  return {
    name,
    encode: (o) => {
      const n = nameOf(get(o));
      return n === null ? OMIT : n;
    },
    decode: (o, v, warn, path) => {
      if (v === null) {
        set(o, null);
        return;
      }
      if (typeof v !== "string") {
        warn(path, "expected string or null");
        return;
      }
      const fn = lookup(v);
      if (fn === null) {
        warn(path, `unknown function "${v}"`);
        return;
      }
      set(o, fn);
    },
  };
}

// -------------------------------------------------------------------------
// pmove_state_t (g_save.cpp:745-756)
// -------------------------------------------------------------------------
// pm_type, origin, velocity, pm_flags, pm_time, gravity, delta_angles,
// viewheight -- all flat, no omissions.

const pmoveStateFields: FieldDescriptor<KexPmoveStateT>[] = [
  intField(
    "pm_type",
    (o) => o.pm_type,
    (o, v) => {
      o.pm_type = v;
    },
  ),
  vec3Field("origin", (o) => o.origin),
  vec3Field("velocity", (o) => o.velocity),
  intField(
    "pm_flags",
    (o) => o.pm_flags,
    (o, v) => {
      o.pm_flags = v;
    },
  ),
  intField(
    "pm_time",
    (o) => o.pm_time,
    (o, v) => {
      o.pm_time = v;
    },
  ),
  intField(
    "gravity",
    (o) => o.gravity,
    (o, v) => {
      o.gravity = v;
    },
  ),
  vec3Field("delta_angles", (o) => o.delta_angles),
  intField(
    "viewheight",
    (o) => o.viewheight,
    (o, v) => {
      o.viewheight = v;
    },
  ),
];

// -------------------------------------------------------------------------
// player_state_t (g_save.cpp:758-777)
// -------------------------------------------------------------------------
// pmove (FIELD_STRUCT -> nested), viewangles, viewoffset, gunangles,
// gunoffset, gunindex, gunframe, gunskin, fov, stats. kick_angles/blend/
// rdflags NOT saved (C++ comments: "only last 1 frame" / "calculated by
// ClientEndServerFrame" / "generated by ClientEndServerFrame").

const playerStateFields: FieldDescriptor<KexPlayerStateT>[] = [
  structField("pmove", (o) => o.pmove, pmoveStateFields),
  vec3Field("viewangles", (o) => o.viewangles),
  vec3Field("viewoffset", (o) => o.viewoffset),
  vec3Field("gunangles", (o) => o.gunangles),
  vec3Field("gunoffset", (o) => o.gunoffset),
  intField(
    "gunindex",
    (o) => o.gunindex,
    (o, v) => {
      o.gunindex = v;
    },
  ),
  intField(
    "gunframe",
    (o) => o.gunframe,
    (o, v) => {
      o.gunframe = v;
    },
  ),
  intField(
    "gunskin",
    (o) => o.gunskin,
    (o, v) => {
      o.gunskin = v;
    },
  ),
  floatField(
    "fov",
    (o) => o.fov,
    (o, v) => {
      o.fov = v;
    },
  ),
  intArrayField("stats", (o) => o.stats, MAX_STATS),
];

// -------------------------------------------------------------------------
// height_fog_t (g_save.cpp:779-786)
// -------------------------------------------------------------------------

const heightFogFields: FieldDescriptor<HeightFogT>[] = [
  floatArrayField("start", (o) => o.start, 4),
  floatArrayField("end", (o) => o.end, 4),
  floatField(
    "falloff",
    (o) => o.falloff,
    (o, v) => {
      o.falloff = v;
    },
  ),
  floatField(
    "density",
    (o) => o.density,
    (o, v) => {
      o.density = v;
    },
  ),
];

// -------------------------------------------------------------------------
// client_persistant_t (g_save.cpp:788-826)
// -------------------------------------------------------------------------
// userinfo, social_id, netname, hand, health, max_health, savedFlags
// (bigint), selected_item (item index), inventory (ST_INVENTORY), max_ammo,
// weapon, lastweapon, power_cubes, score, game_help1changed,
// game_help2changed, helpchanged, help_time, spectator, wanted_fog,
// wanted_heightfog (FIELD_STRUCT -> nested), megahealth_time, lives,
// n64_crouch_warn_times, n64_crouch_warning.
//
// NOT saved (present on the TS type, absent from g_save.cpp's field list):
// autoswitch, autoshield, connected, spawned, selected_item_time, bob_skip,
// fog_transition_time -- session-local state, matching the C++'s own
// omission (none of these are FIELD_AUTO'd in client_persistant_t_savestruct).

const clientPersistantFields: FieldDescriptor<ClientPersistantT>[] = [
  fixedStringField(
    "userinfo",
    (o) => o.userinfo,
    (o, v) => {
      o.userinfo = v;
    },
  ),
  fixedStringField(
    "social_id",
    (o) => o.social_id,
    (o, v) => {
      o.social_id = v;
    },
  ),
  fixedStringField(
    "netname",
    (o) => o.netname,
    (o, v) => {
      o.netname = v;
    },
  ),
  intField(
    "hand",
    (o) => o.hand,
    (o, v) => {
      o.hand = v;
    },
  ),
  intField(
    "health",
    (o) => o.health,
    (o, v) => {
      o.health = v;
    },
  ),
  intField(
    "max_health",
    (o) => o.max_health,
    (o, v) => {
      o.max_health = v;
    },
  ),
  bigintField(
    "savedFlags",
    (o) => o.savedFlags,
    (o, v) => {
      o.savedFlags = v;
    },
  ),
  itemIndexField(
    "selected_item",
    (o) => o.selected_item,
    (o, v) => {
      o.selected_item = v;
    },
  ),
  inventoryField("inventory", (o) => o.inventory),
  intArrayField("max_ammo", (o) => o.max_ammo, AmmoT.AMMO_MAX),
  itemPointerField(
    "weapon",
    (o) => o.weapon,
    (o, v) => {
      o.weapon = v;
    },
  ),
  itemPointerField(
    "lastweapon",
    (o) => o.lastweapon,
    (o, v) => {
      o.lastweapon = v;
    },
  ),
  intField(
    "power_cubes",
    (o) => o.power_cubes,
    (o, v) => {
      o.power_cubes = v;
    },
  ),
  intField(
    "score",
    (o) => o.score,
    (o, v) => {
      o.score = v;
    },
  ),
  intField(
    "game_help1changed",
    (o) => o.game_help1changed,
    (o, v) => {
      o.game_help1changed = v;
    },
  ),
  intField(
    "game_help2changed",
    (o) => o.game_help2changed,
    (o, v) => {
      o.game_help2changed = v;
    },
  ),
  intField(
    "helpchanged",
    (o) => o.helpchanged,
    (o, v) => {
      o.helpchanged = v;
    },
  ),
  timeField(
    "help_time",
    (o) => o.help_time,
    (o, v) => {
      o.help_time = v;
    },
  ),
  boolField(
    "spectator",
    (o) => o.spectator,
    (o, v) => {
      o.spectator = v;
    },
  ),
  floatArrayField("wanted_fog", (o) => o.wanted_fog, 5),
  structField("wanted_heightfog", (o) => o.wanted_heightfog, heightFogFields),
  timeField(
    "megahealth_time",
    (o) => o.megahealth_time,
    (o, v) => {
      o.megahealth_time = v;
    },
  ),
  intField(
    "lives",
    (o) => o.lives,
    (o, v) => {
      o.lives = v;
    },
  ),
  intField(
    "n64_crouch_warn_times",
    (o) => o.n64_crouch_warn_times,
    (o, v) => {
      o.n64_crouch_warn_times = v;
    },
  ),
  timeField(
    "n64_crouch_warning",
    (o) => o.n64_crouch_warning,
    (o, v) => {
      o.n64_crouch_warning = v;
    },
  ),
];

// -------------------------------------------------------------------------
// gclient_t (g_save.cpp:828-933)
// -------------------------------------------------------------------------

type KickT = GClientT["kick"];
const kickFields: FieldDescriptor<KickT>[] = [
  vec3Field("angles", (o) => o.angles),
  vec3Field("origin", (o) => o.origin),
  timeField(
    "total",
    (o) => o.total,
    (o, v) => {
      o.total = v;
    },
  ),
  timeField(
    "time",
    (o) => o.time,
    (o, v) => {
      o.time = v;
    },
  ),
];

const gclientFields: FieldDescriptor<GClientT>[] = [
  structField("ps", (o) => o.ps, playerStateFields),
  structField("pers", (o) => o.pers, clientPersistantFields),
  structField("resp.coop_respawn", (o) => o.resp.coop_respawn, clientPersistantFields),
  timeField(
    "resp.entertime",
    (o) => o.resp.entertime,
    (o, v) => {
      o.resp.entertime = v;
    },
  ),
  intField(
    "resp.score",
    (o) => o.resp.score,
    (o, v) => {
      o.resp.score = v;
    },
  ),
  vec3Field("resp.cmd_angles", (o) => o.resp.cmd_angles),
  boolField(
    "resp.spectator",
    (o) => o.resp.spectator,
    (o, v) => {
      o.resp.spectator = v;
    },
  ),
  itemPointerField(
    "newweapon",
    (o) => o.newweapon,
    (o, v) => {
      o.newweapon = v;
    },
  ),
  floatField(
    "killer_yaw",
    (o) => o.killer_yaw,
    (o, v) => {
      o.killer_yaw = v;
    },
  ),
  intField(
    "weaponstate",
    (o) => o.weaponstate,
    (o, v) => {
      o.weaponstate = v;
    },
  ),
  ...flattenPrefixed<GClientT, KickT>("kick", (o) => o.kick, kickFields),
  timeField(
    "quake_time",
    (o) => o.quake_time,
    (o, v) => {
      o.quake_time = v;
    },
  ),
  floatField(
    "v_dmg_roll",
    (o) => o.v_dmg_roll,
    (o, v) => {
      o.v_dmg_roll = v;
    },
  ),
  floatField(
    "v_dmg_pitch",
    (o) => o.v_dmg_pitch,
    (o, v) => {
      o.v_dmg_pitch = v;
    },
  ),
  timeField(
    "v_dmg_time",
    (o) => o.v_dmg_time,
    (o, v) => {
      o.v_dmg_time = v;
    },
  ),
  timeField(
    "fall_time",
    (o) => o.fall_time,
    (o, v) => {
      o.fall_time = v;
    },
  ),
  floatField(
    "fall_value",
    (o) => o.fall_value,
    (o, v) => {
      o.fall_value = v;
    },
  ),
  floatField(
    "damage_alpha",
    (o) => o.damage_alpha,
    (o, v) => {
      o.damage_alpha = v;
    },
  ),
  floatField(
    "bonus_alpha",
    (o) => o.bonus_alpha,
    (o, v) => {
      o.bonus_alpha = v;
    },
  ),
  vec3Field("damage_blend", (o) => o.damage_blend),
  vec3Field("v_angle", (o) => o.v_angle),
  floatField(
    "bobtime",
    (o) => o.bobtime,
    (o, v) => {
      o.bobtime = v;
    },
  ),
  vec3Field("oldviewangles", (o) => o.oldviewangles),
  vec3Field("oldvelocity", (o) => o.oldvelocity),
  entityField(
    "oldgroundentity",
    (o) => o.oldgroundentity,
    (o, v) => {
      o.oldgroundentity = v;
    },
  ),
  timeField(
    "next_drown_time",
    (o) => o.next_drown_time,
    (o, v) => {
      o.next_drown_time = v;
    },
  ),
  intField(
    "old_waterlevel",
    (o) => o.old_waterlevel,
    (o, v) => {
      o.old_waterlevel = v;
    },
  ),
  intField(
    "breather_sound",
    (o) => o.breather_sound,
    (o, v) => {
      o.breather_sound = v;
    },
  ),
  intField(
    "machinegun_shots",
    (o) => o.machinegun_shots,
    (o, v) => {
      o.machinegun_shots = v;
    },
  ),
  intField(
    "anim_end",
    (o) => o.anim_end,
    (o, v) => {
      o.anim_end = v;
    },
  ),
  intField(
    "anim_priority",
    (o) => o.anim_priority,
    (o, v) => {
      o.anim_priority = v;
    },
  ),
  boolField(
    "anim_duck",
    (o) => o.anim_duck,
    (o, v) => {
      o.anim_duck = v;
    },
  ),
  boolField(
    "anim_run",
    (o) => o.anim_run,
    (o, v) => {
      o.anim_run = v;
    },
  ),
  timeField(
    "quad_time",
    (o) => o.quad_time,
    (o, v) => {
      o.quad_time = v;
    },
  ),
  timeField(
    "invincible_time",
    (o) => o.invincible_time,
    (o, v) => {
      o.invincible_time = v;
    },
  ),
  timeField(
    "breather_time",
    (o) => o.breather_time,
    (o, v) => {
      o.breather_time = v;
    },
  ),
  timeField(
    "enviro_time",
    (o) => o.enviro_time,
    (o, v) => {
      o.enviro_time = v;
    },
  ),
  timeField(
    "invisible_time",
    (o) => o.invisible_time,
    (o, v) => {
      o.invisible_time = v;
    },
  ),
  boolField(
    "grenade_blew_up",
    (o) => o.grenade_blew_up,
    (o, v) => {
      o.grenade_blew_up = v;
    },
  ),
  timeField(
    "grenade_time",
    (o) => o.grenade_time,
    (o, v) => {
      o.grenade_time = v;
    },
  ),
  timeField(
    "grenade_finished_time",
    (o) => o.grenade_finished_time,
    (o, v) => {
      o.grenade_finished_time = v;
    },
  ),
  timeField(
    "quadfire_time",
    (o) => o.quadfire_time,
    (o, v) => {
      o.quadfire_time = v;
    },
  ),
  intField(
    "silencer_shots",
    (o) => o.silencer_shots,
    (o, v) => {
      o.silencer_shots = v;
    },
  ),
  intField(
    "weapon_sound",
    (o) => o.weapon_sound,
    (o, v) => {
      o.weapon_sound = v;
    },
  ),
  timeField(
    "pickup_msg_time",
    (o) => o.pickup_msg_time,
    (o, v) => {
      o.pickup_msg_time = v;
    },
  ),
  timeField(
    "respawn_time",
    (o) => o.respawn_time,
    (o, v) => {
      o.respawn_time = v;
    },
  ),
  timeField(
    "double_time",
    (o) => o.double_time,
    (o, v) => {
      o.double_time = v;
    },
  ),
  timeField(
    "ir_time",
    (o) => o.ir_time,
    (o, v) => {
      o.ir_time = v;
    },
  ),
  timeField(
    "nuke_time",
    (o) => o.nuke_time,
    (o, v) => {
      o.nuke_time = v;
    },
  ),
  timeField(
    "tracker_pain_time",
    (o) => o.tracker_pain_time,
    (o, v) => {
      o.tracker_pain_time = v;
    },
  ),
  timeField(
    "empty_click_sound",
    (o) => o.empty_click_sound,
    (o, v) => {
      o.empty_click_sound = v;
    },
  ),
  entityField(
    "trail_head",
    (o) => o.trail_head,
    (o, v) => {
      o.trail_head = v;
    },
  ),
  entityField(
    "trail_tail",
    (o) => o.trail_tail,
    (o, v) => {
      o.trail_tail = v;
    },
  ),
  stringField(
    "landmark_name",
    (o) => o.landmark_name,
    (o, v) => {
      o.landmark_name = v;
    },
  ),
  vec3Field("landmark_rel_pos", (o) => o.landmark_rel_pos),
  boolField(
    "landmark_free_fall",
    (o) => o.landmark_free_fall,
    (o, v) => {
      o.landmark_free_fall = v;
    },
  ),
  timeField(
    "landmark_noise_time",
    (o) => o.landmark_noise_time,
    (o, v) => {
      o.landmark_noise_time = v;
    },
  ),
  timeField(
    "invisibility_fade_time",
    (o) => o.invisibility_fade_time,
    (o, v) => {
      o.invisibility_fade_time = v;
    },
  ),
  vec3Field("last_ladder_pos", (o) => o.last_ladder_pos),
  timeField(
    "last_ladder_sound",
    (o) => o.last_ladder_sound,
    (o, v) => {
      o.last_ladder_sound = v;
    },
  ),
  entityField(
    "sight_entity",
    (o) => o.sight_entity,
    (o, v) => {
      o.sight_entity = v;
    },
  ),
  timeField(
    "sight_entity_time",
    (o) => o.sight_entity_time,
    (o, v) => {
      o.sight_entity_time = v;
    },
  ),
  entityField(
    "sound_entity",
    (o) => o.sound_entity,
    (o, v) => {
      o.sound_entity = v;
    },
  ),
  timeField(
    "sound_entity_time",
    (o) => o.sound_entity_time,
    (o, v) => {
      o.sound_entity_time = v;
    },
  ),
  entityField(
    "sound2_entity",
    (o) => o.sound2_entity,
    (o, v) => {
      o.sound2_entity = v;
    },
  ),
  timeField(
    "sound2_entity_time",
    (o) => o.sound2_entity_time,
    (o, v) => {
      o.sound2_entity_time = v;
    },
  ),
  timeField(
    "last_firing_time",
    (o) => o.last_firing_time,
    (o, v) => {
      o.last_firing_time = v;
    },
  ),
];

// -------------------------------------------------------------------------
// level_entry_t (g_save.cpp:645-658)
// -------------------------------------------------------------------------

const levelEntryFields: FieldDescriptor<LevelEntryT>[] = [
  fixedStringField(
    "map_name",
    (o) => o.map_name,
    (o, v) => {
      o.map_name = v;
    },
  ),
  fixedStringField(
    "pretty_name",
    (o) => o.pretty_name,
    (o, v) => {
      o.pretty_name = v;
    },
  ),
  intField(
    "total_secrets",
    (o) => o.total_secrets,
    (o, v) => {
      o.total_secrets = v;
    },
  ),
  intField(
    "found_secrets",
    (o) => o.found_secrets,
    (o, v) => {
      o.found_secrets = v;
    },
  ),
  intField(
    "total_monsters",
    (o) => o.total_monsters,
    (o, v) => {
      o.total_monsters = v;
    },
  ),
  intField(
    "killed_monsters",
    (o) => o.killed_monsters,
    (o, v) => {
      o.killed_monsters = v;
    },
  ),
  timeField(
    "time",
    (o) => o.time,
    (o, v) => {
      o.time = v;
    },
  ),
  intField(
    "visit_order",
    (o) => o.visit_order,
    (o, v) => {
      o.visit_order = v;
    },
  ),
];

// -------------------------------------------------------------------------
// game_locals_t (g_save.cpp:661-681)
// -------------------------------------------------------------------------
// `clients` is set by load/init only (C++ comment) -- saved separately as
// the top-level "clients" array (see WriteGameJson/ReadGameJson below), not
// as a field of game_locals_t itself.

const gameLocalsFields: FieldDescriptor<GameLocalsT>[] = [
  fixedStringField(
    "helpmessage1",
    (o) => o.helpmessage1,
    (o, v) => {
      o.helpmessage1 = v;
    },
  ),
  fixedStringField(
    "helpmessage2",
    (o) => o.helpmessage2,
    (o, v) => {
      o.helpmessage2 = v;
    },
  ),
  intField(
    "help1changed",
    (o) => o.help1changed,
    (o, v) => {
      o.help1changed = v;
    },
  ),
  intField(
    "help2changed",
    (o) => o.help2changed,
    (o, v) => {
      o.help2changed = v;
    },
  ),
  fixedStringField(
    "spawnpoint",
    (o) => o.spawnpoint,
    (o, v) => {
      o.spawnpoint = v;
    },
  ),
  intField(
    "maxclients",
    (o) => o.maxclients,
    (o, v) => {
      o.maxclients = v;
    },
  ),
  intField(
    "maxentities",
    (o) => o.maxentities,
    (o, v) => {
      o.maxentities = v;
    },
  ),
  intField(
    "cross_level_flags",
    (o) => o.cross_level_flags,
    (o, v) => {
      o.cross_level_flags = v;
    },
  ),
  intField(
    "cross_unit_flags",
    (o) => o.cross_unit_flags,
    (o, v) => {
      o.cross_unit_flags = v;
    },
  ),
  boolField(
    "autosaved",
    (o) => o.autosaved,
    (o, v) => {
      o.autosaved = v;
    },
  ),
  structArrayField("level_entries", (o) => o.level_entries, levelEntryFields),
];

// -------------------------------------------------------------------------
// level_locals_t (g_save.cpp:683-743)
// -------------------------------------------------------------------------
// NOT saved (no FIELD_AUTO in g_save.cpp): in_frame, forcemap,
// intermission_eou, level_intermission_set, intermission_fade,
// intermission_fading, intermission_fade_time, respawn_intermission,
// pic_health/pic_ping ("set by worldspawn"), current_entity ("not necessary
// to save"), disguise_icon, shadow_light_count, is_n64, instantitems,
// entry, poi_points, deadly_kill_box, next_match_report,
// coop_health_scaling, coop_scale_players.

const levelLocalsFields: FieldDescriptor<LevelLocalsT>[] = [
  timeField(
    "time",
    (o) => o.time,
    (o, v) => {
      o.time = v;
    },
  ),
  fixedStringField(
    "level_name",
    (o) => o.level_name,
    (o, v) => {
      o.level_name = v;
    },
  ),
  fixedStringField(
    "mapname",
    (o) => o.mapname,
    (o, v) => {
      o.mapname = v;
    },
  ),
  fixedStringField(
    "nextmap",
    (o) => o.nextmap,
    (o, v) => {
      o.nextmap = v;
    },
  ),
  timeField(
    "intermissiontime",
    (o) => o.intermissiontime,
    (o, v) => {
      o.intermissiontime = v;
    },
  ),
  stringField(
    "changemap",
    (o) => o.changemap,
    (o, v) => {
      o.changemap = v;
    },
  ),
  stringField(
    "achievement",
    (o) => o.achievement,
    (o, v) => {
      o.achievement = v;
    },
  ),
  boolField(
    "exitintermission",
    (o) => o.exitintermission,
    (o, v) => {
      o.exitintermission = v;
    },
  ),
  boolField(
    "intermission_clear",
    (o) => o.intermission_clear,
    (o, v) => {
      o.intermission_clear = v;
    },
  ),
  vec3Field("intermission_origin", (o) => o.intermission_origin),
  vec3Field("intermission_angle", (o) => o.intermission_angle),
  intField(
    "total_secrets",
    (o) => o.total_secrets,
    (o, v) => {
      o.total_secrets = v;
    },
  ),
  intField(
    "found_secrets",
    (o) => o.found_secrets,
    (o, v) => {
      o.found_secrets = v;
    },
  ),
  intField(
    "total_goals",
    (o) => o.total_goals,
    (o, v) => {
      o.total_goals = v;
    },
  ),
  intField(
    "found_goals",
    (o) => o.found_goals,
    (o, v) => {
      o.found_goals = v;
    },
  ),
  intField(
    "total_monsters",
    (o) => o.total_monsters,
    (o, v) => {
      o.total_monsters = v;
    },
  ),
  entityArrayField("monsters_registered", (o) => o.monsters_registered, MAX_EDICTS),
  intField(
    "killed_monsters",
    (o) => o.killed_monsters,
    (o, v) => {
      o.killed_monsters = v;
    },
  ),
  intField(
    "body_que",
    (o) => o.body_que,
    (o, v) => {
      o.body_que = v;
    },
  ),
  intField(
    "power_cubes",
    (o) => o.power_cubes,
    (o, v) => {
      o.power_cubes = v;
    },
  ),
  entityField(
    "disguise_violator",
    (o) => o.disguise_violator,
    (o, v) => {
      o.disguise_violator = v;
    },
  ),
  timeField(
    "disguise_violation_time",
    (o) => o.disguise_violation_time,
    (o, v) => {
      o.disguise_violation_time = v;
    },
  ),
  timeField(
    "coop_level_restart_time",
    (o) => o.coop_level_restart_time,
    (o, v) => {
      o.coop_level_restart_time = v;
    },
  ),
  stringField(
    "goals",
    (o) => o.goals,
    (o, v) => {
      o.goals = v;
    },
  ),
  intField(
    "goal_num",
    (o) => o.goal_num,
    (o, v) => {
      o.goal_num = v;
    },
  ),
  intField(
    "vwep_offset",
    (o) => o.vwep_offset,
    (o, v) => {
      o.vwep_offset = v;
    },
  ),
  boolField(
    "valid_poi",
    (o) => o.valid_poi,
    (o, v) => {
      o.valid_poi = v;
    },
  ),
  vec3Field("current_poi", (o) => o.current_poi),
  intField(
    "current_poi_stage",
    (o) => o.current_poi_stage,
    (o, v) => {
      o.current_poi_stage = v;
    },
  ),
  intField(
    "current_poi_image",
    (o) => o.current_poi_image,
    (o, v) => {
      o.current_poi_image = v;
    },
  ),
  entityField(
    "current_dynamic_poi",
    (o) => o.current_dynamic_poi,
    (o, v) => {
      o.current_dynamic_poi = v;
    },
  ),
  stringField(
    "start_items",
    (o) => o.start_items,
    (o, v) => {
      o.start_items = v;
    },
  ),
  boolField(
    "no_grapple",
    (o) => o.no_grapple,
    (o, v) => {
      o.no_grapple = v;
    },
  ),
  floatField(
    "gravity",
    (o) => o.gravity,
    (o, v) => {
      o.gravity = v;
    },
  ),
  boolField(
    "hub_map",
    (o) => o.hub_map,
    (o, v) => {
      o.hub_map = v;
    },
  ),
  entityArrayField("health_bar_entities", (o) => o.health_bar_entities, MAX_HEALTH_BARS),
  intField(
    "intermission_server_frame",
    (o) => o.intermission_server_frame,
    (o, v) => {
      o.intermission_server_frame = v;
    },
  ),
  boolField(
    "story_active",
    (o) => o.story_active,
    (o, v) => {
      o.story_active = v;
    },
  ),
  timeField(
    "next_auto_save",
    (o) => o.next_auto_save,
    (o, v) => {
      o.next_auto_save = v;
    },
  ),
];

// -------------------------------------------------------------------------
// moveinfo_t (g_save.cpp:1100-1134, flattened "moveinfo." prefix)
// -------------------------------------------------------------------------

const moveinfoFields: FieldDescriptor<MoveinfoT>[] = [
  vec3Field("start_origin", (o) => o.start_origin),
  vec3Field("start_angles", (o) => o.start_angles),
  vec3Field("end_origin", (o) => o.end_origin),
  vec3Field("end_angles", (o) => o.end_angles),
  vec3Field("end_angles_reversed", (o) => o.end_angles_reversed),
  intField(
    "sound_start",
    (o) => o.sound_start,
    (o, v) => {
      o.sound_start = v;
    },
  ),
  intField(
    "sound_middle",
    (o) => o.sound_middle,
    (o, v) => {
      o.sound_middle = v;
    },
  ),
  intField(
    "sound_end",
    (o) => o.sound_end,
    (o, v) => {
      o.sound_end = v;
    },
  ),
  floatField(
    "accel",
    (o) => o.accel,
    (o, v) => {
      o.accel = v;
    },
  ),
  floatField(
    "speed",
    (o) => o.speed,
    (o, v) => {
      o.speed = v;
    },
  ),
  floatField(
    "decel",
    (o) => o.decel,
    (o, v) => {
      o.decel = v;
    },
  ),
  floatField(
    "distance",
    (o) => o.distance,
    (o, v) => {
      o.distance = v;
    },
  ),
  floatField(
    "wait",
    (o) => o.wait,
    (o, v) => {
      o.wait = v;
    },
  ),
  intField(
    "state",
    (o) => o.state,
    (o, v) => {
      o.state = v;
    },
  ),
  boolField(
    "reversing",
    (o) => o.reversing,
    (o, v) => {
      o.reversing = v;
    },
  ),
  vec3Field("dir", (o) => o.dir),
  vec3Field("dest", (o) => o.dest),
  floatField(
    "current_speed",
    (o) => o.current_speed,
    (o, v) => {
      o.current_speed = v;
    },
  ),
  floatField(
    "move_speed",
    (o) => o.move_speed,
    (o, v) => {
      o.move_speed = v;
    },
  ),
  floatField(
    "next_speed",
    (o) => o.next_speed,
    (o, v) => {
      o.next_speed = v;
    },
  ),
  floatField(
    "remaining_distance",
    (o) => o.remaining_distance,
    (o, v) => {
      o.remaining_distance = v;
    },
  ),
  floatField(
    "decel_distance",
    (o) => o.decel_distance,
    (o, v) => {
      o.decel_distance = v;
    },
  ),
  functionRefField(
    "endfunc",
    (o) => o.endfunc,
    (o, v) => {
      o.endfunc = v;
    },
    LookupMoveinfoEndfunc,
    NameOfMoveinfoEndfunc,
  ),
  functionRefField(
    "blocked",
    (o) => o.blocked,
    (o, v) => {
      o.blocked = v;
    },
    LookupMoveinfoBlocked,
    NameOfMoveinfoBlocked,
  ),
  vec3Field("curve_ref", (o) => o.curve_ref),
  floatDynamicArrayField(
    "curve_positions",
    (o) => o.curve_positions,
    (o, v) => {
      o.curve_positions = v;
    },
  ),
  intField(
    "curve_frame",
    (o) => o.curve_frame,
    (o, v) => {
      o.curve_frame = v;
    },
  ),
  intField(
    "subframe",
    (o) => o.subframe,
    (o, v) => {
      o.subframe = v;
    },
  ),
  intField(
    "num_subframes",
    (o) => o.num_subframes,
    (o, v) => {
      o.num_subframes = v;
    },
  ),
  intField(
    "num_frames_done",
    (o) => o.num_frames_done,
    (o, v) => {
      o.num_frames_done = v;
    },
  ),
];

// -------------------------------------------------------------------------
// monsterinfo_t (g_save.cpp:1136-1241, flattened "monsterinfo." prefix)
// -------------------------------------------------------------------------
// NOT saved (present on the TS type, absent from g_save.cpp's edict_t field
// list): `physics_change` (see file header "FIELD-TABLE COVERAGE AUDIT"),
// `nav_path`/`nav_path_cache_time`, `damage_attacker`/`damage_inflictor`/
// `damage_blood`/`damage_knockback`/`damage_from`/`damage_mod` -- all
// transient per-frame combat/pathing scratch state, matching the C++
// field list jumping straight from `combat_style` to `fly_max_distance`.

const monsterinfoFields: FieldDescriptor<MonsterinfoT>[] = [
  functionRefField(
    "active_move",
    (o) => o.active_move,
    (o, v) => {
      o.active_move = v;
    },
    LookupMmove,
    NameOfMmove,
  ),
  functionRefField(
    "next_move",
    (o) => o.next_move,
    (o, v) => {
      o.next_move = v;
    },
    LookupMmove,
    NameOfMmove,
  ),
  bigintField(
    "aiflags",
    (o) => o.aiflags,
    (o, v) => {
      o.aiflags = v;
    },
  ),
  intField(
    "nextframe",
    (o) => o.nextframe,
    (o, v) => {
      o.nextframe = v;
    },
  ),
  floatField(
    "scale",
    (o) => o.scale,
    (o, v) => {
      o.scale = v;
    },
  ),
  functionRefField("stand", (o) => o.stand, (o, v) => { o.stand = v; }, LookupMonsterinfoStand, NameOfMonsterinfoStand),
  functionRefField("idle", (o) => o.idle, (o, v) => { o.idle = v; }, LookupMonsterinfoIdle, NameOfMonsterinfoIdle),
  functionRefField("search", (o) => o.search, (o, v) => { o.search = v; }, LookupMonsterinfoSearch, NameOfMonsterinfoSearch),
  functionRefField("walk", (o) => o.walk, (o, v) => { o.walk = v; }, LookupMonsterinfoWalk, NameOfMonsterinfoWalk),
  functionRefField("run", (o) => o.run, (o, v) => { o.run = v; }, LookupMonsterinfoRun, NameOfMonsterinfoRun),
  functionRefField("dodge", (o) => o.dodge, (o, v) => { o.dodge = v; }, LookupMonsterinfoDodge, NameOfMonsterinfoDodge),
  functionRefField("attack", (o) => o.attack, (o, v) => { o.attack = v; }, LookupMonsterinfoAttack, NameOfMonsterinfoAttack),
  functionRefField("melee", (o) => o.melee, (o, v) => { o.melee = v; }, LookupMonsterinfoMelee, NameOfMonsterinfoMelee),
  functionRefField("sight", (o) => o.sight, (o, v) => { o.sight = v; }, LookupMonsterinfoSight, NameOfMonsterinfoSight),
  functionRefField(
    "checkattack",
    (o) => o.checkattack,
    (o, v) => {
      o.checkattack = v;
    },
    LookupMonsterinfoCheckattack,
    NameOfMonsterinfoCheckattack,
  ),
  functionRefField("setskin", (o) => o.setskin, (o, v) => { o.setskin = v; }, LookupMonsterinfoSetskin, NameOfMonsterinfoSetskin),
  timeField(
    "pausetime",
    (o) => o.pausetime,
    (o, v) => {
      o.pausetime = v;
    },
  ),
  timeField(
    "attack_finished",
    (o) => o.attack_finished,
    (o, v) => {
      o.attack_finished = v;
    },
  ),
  timeField(
    "fire_wait",
    (o) => o.fire_wait,
    (o, v) => {
      o.fire_wait = v;
    },
  ),
  vec3Field("saved_goal", (o) => o.saved_goal),
  timeField(
    "search_time",
    (o) => o.search_time,
    (o, v) => {
      o.search_time = v;
    },
  ),
  timeField(
    "trail_time",
    (o) => o.trail_time,
    (o, v) => {
      o.trail_time = v;
    },
  ),
  vec3Field("last_sighting", (o) => o.last_sighting),
  intField(
    "attack_state",
    (o) => o.attack_state,
    (o, v) => {
      o.attack_state = v;
    },
  ),
  boolField(
    "lefty",
    (o) => o.lefty,
    (o, v) => {
      o.lefty = v;
    },
  ),
  timeField(
    "idle_time",
    (o) => o.idle_time,
    (o, v) => {
      o.idle_time = v;
    },
  ),
  intField(
    "linkcount",
    (o) => o.linkcount,
    (o, v) => {
      o.linkcount = v;
    },
  ),
  itemIndexField(
    "power_armor_type",
    (o) => o.power_armor_type,
    (o, v) => {
      o.power_armor_type = v;
    },
  ),
  intField(
    "power_armor_power",
    (o) => o.power_armor_power,
    (o, v) => {
      o.power_armor_power = v;
    },
  ),
  itemIndexField(
    "initial_power_armor_type",
    (o) => o.initial_power_armor_type,
    (o, v) => {
      o.initial_power_armor_type = v;
    },
  ),
  intField(
    "max_power_armor_power",
    (o) => o.max_power_armor_power,
    (o, v) => {
      o.max_power_armor_power = v;
    },
  ),
  intField(
    "weapon_sound",
    (o) => o.weapon_sound,
    (o, v) => {
      o.weapon_sound = v;
    },
  ),
  intField(
    "engine_sound",
    (o) => o.engine_sound,
    (o, v) => {
      o.engine_sound = v;
    },
  ),
  functionRefField(
    "blocked",
    (o) => o.blocked,
    (o, v) => {
      o.blocked = v;
    },
    LookupMonsterinfoBlocked,
    NameOfMonsterinfoBlocked,
  ),
  timeField(
    "last_hint_time",
    (o) => o.last_hint_time,
    (o, v) => {
      o.last_hint_time = v;
    },
  ),
  entityField(
    "goal_hint",
    (o) => o.goal_hint,
    (o, v) => {
      o.goal_hint = v;
    },
  ),
  intField(
    "medicTries",
    (o) => o.medicTries,
    (o, v) => {
      o.medicTries = v;
    },
  ),
  entityField(
    "badMedic1",
    (o) => o.badMedic1,
    (o, v) => {
      o.badMedic1 = v;
    },
  ),
  entityField(
    "badMedic2",
    (o) => o.badMedic2,
    (o, v) => {
      o.badMedic2 = v;
    },
  ),
  entityField(
    "healer",
    (o) => o.healer,
    (o, v) => {
      o.healer = v;
    },
  ),
  functionRefField("duck", (o) => o.duck, (o, v) => { o.duck = v; }, LookupMonsterinfoDuck, NameOfMonsterinfoDuck),
  functionRefField("unduck", (o) => o.unduck, (o, v) => { o.unduck = v; }, LookupMonsterinfoUnduck, NameOfMonsterinfoUnduck),
  functionRefField(
    "sidestep",
    (o) => o.sidestep,
    (o, v) => {
      o.sidestep = v;
    },
    LookupMonsterinfoSidestep,
    NameOfMonsterinfoSidestep,
  ),
  floatField(
    "base_height",
    (o) => o.base_height,
    (o, v) => {
      o.base_height = v;
    },
  ),
  timeField(
    "next_duck_time",
    (o) => o.next_duck_time,
    (o, v) => {
      o.next_duck_time = v;
    },
  ),
  timeField(
    "duck_wait_time",
    (o) => o.duck_wait_time,
    (o, v) => {
      o.duck_wait_time = v;
    },
  ),
  entityField(
    "last_player_enemy",
    (o) => o.last_player_enemy,
    (o, v) => {
      o.last_player_enemy = v;
    },
  ),
  boolField(
    "blindfire",
    (o) => o.blindfire,
    (o, v) => {
      o.blindfire = v;
    },
  ),
  boolField(
    "can_jump",
    (o) => o.can_jump,
    (o, v) => {
      o.can_jump = v;
    },
  ),
  boolField(
    "had_visibility",
    (o) => o.had_visibility,
    (o, v) => {
      o.had_visibility = v;
    },
  ),
  floatField(
    "drop_height",
    (o) => o.drop_height,
    (o, v) => {
      o.drop_height = v;
    },
  ),
  floatField(
    "jump_height",
    (o) => o.jump_height,
    (o, v) => {
      o.jump_height = v;
    },
  ),
  timeField(
    "blind_fire_delay",
    (o) => o.blind_fire_delay,
    (o, v) => {
      o.blind_fire_delay = v;
    },
  ),
  vec3Field("blind_fire_target", (o) => o.blind_fire_target),
  intField(
    "monster_slots",
    (o) => o.monster_slots,
    (o, v) => {
      o.monster_slots = v;
    },
  ),
  intField(
    "monster_used",
    (o) => o.monster_used,
    (o, v) => {
      o.monster_used = v;
    },
  ),
  entityField(
    "commander",
    (o) => o.commander,
    (o, v) => {
      o.commander = v;
    },
  ),
  timeField(
    "quad_time",
    (o) => o.quad_time,
    (o, v) => {
      o.quad_time = v;
    },
  ),
  timeField(
    "invincible_time",
    (o) => o.invincible_time,
    (o, v) => {
      o.invincible_time = v;
    },
  ),
  timeField(
    "double_time",
    (o) => o.double_time,
    (o, v) => {
      o.double_time = v;
    },
  ),
  timeField(
    "surprise_time",
    (o) => o.surprise_time,
    (o, v) => {
      o.surprise_time = v;
    },
  ),
  itemIndexField(
    "armor_type",
    (o) => o.armor_type,
    (o, v) => {
      o.armor_type = v;
    },
  ),
  intField(
    "armor_power",
    (o) => o.armor_power,
    (o, v) => {
      o.armor_power = v;
    },
  ),
  boolField(
    "close_sight_tripped",
    (o) => o.close_sight_tripped,
    (o, v) => {
      o.close_sight_tripped = v;
    },
  ),
  timeField(
    "melee_debounce_time",
    (o) => o.melee_debounce_time,
    (o, v) => {
      o.melee_debounce_time = v;
    },
  ),
  timeField(
    "strafe_check_time",
    (o) => o.strafe_check_time,
    (o, v) => {
      o.strafe_check_time = v;
    },
  ),
  intField(
    "base_health",
    (o) => o.base_health,
    (o, v) => {
      o.base_health = v;
    },
  ),
  intField(
    "health_scaling",
    (o) => o.health_scaling,
    (o, v) => {
      o.health_scaling = v;
    },
  ),
  timeField(
    "next_move_time",
    (o) => o.next_move_time,
    (o, v) => {
      o.next_move_time = v;
    },
  ),
  timeField(
    "bad_move_time",
    (o) => o.bad_move_time,
    (o, v) => {
      o.bad_move_time = v;
    },
  ),
  timeField(
    "bump_time",
    (o) => o.bump_time,
    (o, v) => {
      o.bump_time = v;
    },
  ),
  timeField(
    "random_change_time",
    (o) => o.random_change_time,
    (o, v) => {
      o.random_change_time = v;
    },
  ),
  timeField(
    "path_blocked_counter",
    (o) => o.path_blocked_counter,
    (o, v) => {
      o.path_blocked_counter = v;
    },
  ),
  timeField(
    "path_wait_time",
    (o) => o.path_wait_time,
    (o, v) => {
      o.path_wait_time = v;
    },
  ),
  intField(
    "combat_style",
    (o) => o.combat_style,
    (o, v) => {
      o.combat_style = v;
    },
  ),
  floatField(
    "fly_max_distance",
    (o) => o.fly_max_distance,
    (o, v) => {
      o.fly_max_distance = v;
    },
  ),
  floatField(
    "fly_min_distance",
    (o) => o.fly_min_distance,
    (o, v) => {
      o.fly_min_distance = v;
    },
  ),
  floatField(
    "fly_acceleration",
    (o) => o.fly_acceleration,
    (o, v) => {
      o.fly_acceleration = v;
    },
  ),
  floatField(
    "fly_speed",
    (o) => o.fly_speed,
    (o, v) => {
      o.fly_speed = v;
    },
  ),
  vec3Field("fly_ideal_position", (o) => o.fly_ideal_position),
  timeField(
    "fly_position_time",
    (o) => o.fly_position_time,
    (o, v) => {
      o.fly_position_time = v;
    },
  ),
  boolField(
    "fly_buzzard",
    (o) => o.fly_buzzard,
    (o, v) => {
      o.fly_buzzard = v;
    },
  ),
  boolField(
    "fly_above",
    (o) => o.fly_above,
    (o, v) => {
      o.fly_above = v;
    },
  ),
  boolField(
    "fly_pinned",
    (o) => o.fly_pinned,
    (o, v) => {
      o.fly_pinned = v;
    },
  ),
  boolField(
    "fly_thrusters",
    (o) => o.fly_thrusters,
    (o, v) => {
      o.fly_thrusters = v;
    },
  ),
  timeField(
    "fly_recovery_time",
    (o) => o.fly_recovery_time,
    (o, v) => {
      o.fly_recovery_time = v;
    },
  ),
  vec3Field("fly_recovery_dir", (o) => o.fly_recovery_dir),
  timeField(
    "checkattack_time",
    (o) => o.checkattack_time,
    (o, v) => {
      o.checkattack_time = v;
    },
  ),
  intField(
    "start_frame",
    (o) => o.start_frame,
    (o, v) => {
      o.start_frame = v;
    },
  ),
  timeField(
    "dodge_time",
    (o) => o.dodge_time,
    (o, v) => {
      o.dodge_time = v;
    },
  ),
  intField(
    "move_block_counter",
    (o) => o.move_block_counter,
    (o, v) => {
      o.move_block_counter = v;
    },
  ),
  timeField(
    "move_block_change_time",
    (o) => o.move_block_change_time,
    (o, v) => {
      o.move_block_change_time = v;
    },
  ),
  timeField(
    "react_to_damage_time",
    (o) => o.react_to_damage_time,
    (o, v) => {
      o.react_to_damage_time = v;
    },
  ),
  reinforcementsField(
    "reinforcements",
    (o) => o.reinforcements.reinforcements,
    (o, v) => {
      o.reinforcements.reinforcements = v;
    },
  ),
  intArrayField("chosen_reinforcements", (o) => o.chosen_reinforcements, MAX_REINFORCEMENTS),
  timeField(
    "jump_time",
    (o) => o.jump_time,
    (o, v) => {
      o.jump_time = v;
    },
  ),
];

// -------------------------------------------------------------------------
// edict_t (g_save.cpp:948-1307)
// -------------------------------------------------------------------------
// NOT saved: absmin/absmax/size ("set by linkentity"), s.solid ("set by
// linkentity"), s.event ("cleared on each frame"), areanum/areanum2/linked
// (server linkage), client (auto-wired from game.clients on load), inuse
// (implied by presence as an entities[] key).

type EdictFogT = EdictT["fog"];
const fogFields: FieldDescriptor<EdictFogT>[] = [
  vec3Field("color", (o) => o.color),
  floatField(
    "density",
    (o) => o.density,
    (o, v) => {
      o.density = v;
    },
  ),
  vec3Field("color_off", (o) => o.color_off),
  floatField(
    "density_off",
    (o) => o.density_off,
    (o, v) => {
      o.density_off = v;
    },
  ),
  floatField(
    "sky_factor",
    (o) => o.sky_factor,
    (o, v) => {
      o.sky_factor = v;
    },
  ),
  floatField(
    "sky_factor_off",
    (o) => o.sky_factor_off,
    (o, v) => {
      o.sky_factor_off = v;
    },
  ),
];

type EdictHeightfogT = EdictT["heightfog"];
const edictHeightfogFields: FieldDescriptor<EdictHeightfogT>[] = [
  floatField(
    "falloff",
    (o) => o.falloff,
    (o, v) => {
      o.falloff = v;
    },
  ),
  floatField(
    "density",
    (o) => o.density,
    (o, v) => {
      o.density = v;
    },
  ),
  vec3Field("start_color", (o) => o.start_color),
  floatField(
    "start_dist",
    (o) => o.start_dist,
    (o, v) => {
      o.start_dist = v;
    },
  ),
  vec3Field("end_color", (o) => o.end_color),
  floatField(
    "end_dist",
    (o) => o.end_dist,
    (o, v) => {
      o.end_dist = v;
    },
  ),
  floatField(
    "falloff_off",
    (o) => o.falloff_off,
    (o, v) => {
      o.falloff_off = v;
    },
  ),
  floatField(
    "density_off",
    (o) => o.density_off,
    (o, v) => {
      o.density_off = v;
    },
  ),
  vec3Field("start_color_off", (o) => o.start_color_off),
  floatField(
    "start_dist_off",
    (o) => o.start_dist_off,
    (o, v) => {
      o.start_dist_off = v;
    },
  ),
  vec3Field("end_color_off", (o) => o.end_color_off),
  floatField(
    "end_dist_off",
    (o) => o.end_dist_off,
    (o, v) => {
      o.end_dist_off = v;
    },
  ),
];

const bmodelAnimFields: FieldDescriptor<EdictT["bmodel_anim"]>[] = [
  intField(
    "start",
    (o) => o.start,
    (o, v) => {
      o.start = v;
    },
  ),
  intField(
    "end",
    (o) => o.end,
    (o, v) => {
      o.end = v;
    },
  ),
  intField(
    "style",
    (o) => o.style,
    (o, v) => {
      o.style = v;
    },
  ),
  floatField(
    "speed",
    (o) => o.speed,
    (o, v) => {
      o.speed = v;
    },
  ),
  boolField(
    "nowrap",
    (o) => o.nowrap,
    (o, v) => {
      o.nowrap = v;
    },
  ),
  intField(
    "alt_start",
    (o) => o.alt_start,
    (o, v) => {
      o.alt_start = v;
    },
  ),
  intField(
    "alt_end",
    (o) => o.alt_end,
    (o, v) => {
      o.alt_end = v;
    },
  ),
  intField(
    "alt_style",
    (o) => o.alt_style,
    (o, v) => {
      o.alt_style = v;
    },
  ),
  floatField(
    "alt_speed",
    (o) => o.alt_speed,
    (o, v) => {
      o.alt_speed = v;
    },
  ),
  boolField(
    "alt_nowrap",
    (o) => o.alt_nowrap,
    (o, v) => {
      o.alt_nowrap = v;
    },
  ),
  boolField(
    "enabled",
    (o) => o.enabled,
    (o, v) => {
      o.enabled = v;
    },
  ),
  boolField(
    "alternate",
    (o) => o.alternate,
    (o, v) => {
      o.alternate = v;
    },
  ),
  boolField(
    "currently_alternate",
    (o) => o.currently_alternate,
    (o, v) => {
      o.currently_alternate = v;
    },
  ),
  timeField(
    "next_tick",
    (o) => o.next_tick,
    (o, v) => {
      o.next_tick = v;
    },
  ),
];

const lastModFields: FieldDescriptor<ModT>[] = [
  intField(
    "id",
    (o) => o.id,
    (o, v) => {
      o.id = v;
    },
  ),
  boolField(
    "friendly_fire",
    (o) => o.friendly_fire,
    (o, v) => {
      o.friendly_fire = v;
    },
  ),
];

function edictGravityIsEmpty(v: number): boolean {
  return v === 1.0;
}
const gravityVectorDefault: Vec3 = vec3(0, 0, -1);
function edictGravityVectorIsEmpty(v: Vec3): boolean {
  return v[0] === gravityVectorDefault[0] && v[1] === gravityVectorDefault[1] && v[2] === gravityVectorDefault[2];
}

const edictFields: FieldDescriptor<EdictT>[] = [
  vec3Field("s.origin", (o) => o.s.origin),
  vec3Field("s.angles", (o) => o.s.angles),
  vec3Field("s.old_origin", (o) => o.s.old_origin),
  intField(
    "s.modelindex",
    (o) => o.s.modelindex,
    (o, v) => {
      o.s.modelindex = v;
    },
  ),
  intField(
    "s.modelindex2",
    (o) => o.s.modelindex2,
    (o, v) => {
      o.s.modelindex2 = v;
    },
  ),
  intField(
    "s.modelindex3",
    (o) => o.s.modelindex3,
    (o, v) => {
      o.s.modelindex3 = v;
    },
  ),
  intField(
    "s.modelindex4",
    (o) => o.s.modelindex4,
    (o, v) => {
      o.s.modelindex4 = v;
    },
  ),
  intField(
    "s.frame",
    (o) => o.s.frame,
    (o, v) => {
      o.s.frame = v;
    },
  ),
  intField(
    "s.skinnum",
    (o) => o.s.skinnum,
    (o, v) => {
      o.s.skinnum = v;
    },
  ),
  bigintField(
    "s.effects",
    (o) => o.s.effects,
    (o, v) => {
      o.s.effects = v;
    },
  ),
  intField(
    "s.renderfx",
    (o) => o.s.renderfx,
    (o, v) => {
      o.s.renderfx = v;
    },
  ),
  intField(
    "s.sound",
    (o) => o.s.sound,
    (o, v) => {
      o.s.sound = v;
    },
  ),
  floatField(
    "s.alpha",
    (o) => o.s.alpha,
    (o, v) => {
      o.s.alpha = v;
    },
  ),
  floatField(
    "s.scale",
    (o) => o.s.scale,
    (o, v) => {
      o.s.scale = v;
    },
  ),
  intField(
    "s.instance_bits",
    (o) => o.s.instance_bits,
    (o, v) => {
      o.s.instance_bits = v;
    },
  ),
  intField(
    "linkcount",
    (o) => o.linkcount,
    (o, v) => {
      o.linkcount = v;
    },
  ),
  intField(
    "svflags",
    (o) => o.svflags,
    (o, v) => {
      o.svflags = v;
    },
  ),
  vec3Field("mins", (o) => o.mins),
  vec3Field("maxs", (o) => o.maxs),
  intField(
    "solid",
    (o) => o.solid,
    (o, v) => {
      o.solid = v;
    },
  ),
  intField(
    "clipmask",
    (o) => o.clipmask,
    (o, v) => {
      o.clipmask = v;
    },
  ),
  entityField(
    "owner",
    (o) => o.owner,
    (o, v) => {
      o.owner = v;
    },
  ),
  intField(
    "spawn_count",
    (o) => o.spawn_count,
    (o, v) => {
      o.spawn_count = v;
    },
  ),
  intField(
    "movetype",
    (o) => o.movetype,
    (o, v) => {
      o.movetype = v;
    },
  ),
  bigintField(
    "flags",
    (o) => o.flags,
    (o, v) => {
      o.flags = v;
    },
  ),
  stringField(
    "model",
    (o) => o.model,
    (o, v) => {
      o.model = v;
    },
  ),
  timeField(
    "freetime",
    (o) => o.freetime,
    (o, v) => {
      o.freetime = v;
    },
  ),
  stringField(
    "message",
    (o) => o.message,
    (o, v) => {
      o.message = v;
    },
  ),
  stringField(
    "classname",
    (o) => o.classname,
    (o, v) => {
      o.classname = v;
    },
  ),
  spawnflagsField(
    "spawnflags",
    (o) => o.spawnflags,
    (o, v) => {
      o.spawnflags = v;
    },
  ),
  timeField(
    "timestamp",
    (o) => o.timestamp,
    (o, v) => {
      o.timestamp = v;
    },
  ),
  floatField(
    "angle",
    (o) => o.angle,
    (o, v) => {
      o.angle = v;
    },
  ),
  stringField(
    "target",
    (o) => o.target,
    (o, v) => {
      o.target = v;
    },
  ),
  stringField(
    "targetname",
    (o) => o.targetname,
    (o, v) => {
      o.targetname = v;
    },
  ),
  stringField(
    "killtarget",
    (o) => o.killtarget,
    (o, v) => {
      o.killtarget = v;
    },
  ),
  stringField(
    "team",
    (o) => o.team,
    (o, v) => {
      o.team = v;
    },
  ),
  stringField(
    "pathtarget",
    (o) => o.pathtarget,
    (o, v) => {
      o.pathtarget = v;
    },
  ),
  stringField(
    "deathtarget",
    (o) => o.deathtarget,
    (o, v) => {
      o.deathtarget = v;
    },
  ),
  stringField(
    "healthtarget",
    (o) => o.healthtarget,
    (o, v) => {
      o.healthtarget = v;
    },
  ),
  stringField(
    "itemtarget",
    (o) => o.itemtarget,
    (o, v) => {
      o.itemtarget = v;
    },
  ),
  stringField(
    "combattarget",
    (o) => o.combattarget,
    (o, v) => {
      o.combattarget = v;
    },
  ),
  entityField(
    "target_ent",
    (o) => o.target_ent,
    (o, v) => {
      o.target_ent = v;
    },
  ),
  floatField(
    "speed",
    (o) => o.speed,
    (o, v) => {
      o.speed = v;
    },
  ),
  floatField(
    "accel",
    (o) => o.accel,
    (o, v) => {
      o.accel = v;
    },
  ),
  floatField(
    "decel",
    (o) => o.decel,
    (o, v) => {
      o.decel = v;
    },
  ),
  vec3Field("movedir", (o) => o.movedir),
  vec3Field("pos1", (o) => o.pos1),
  vec3Field("pos2", (o) => o.pos2),
  vec3Field("pos3", (o) => o.pos3),
  vec3Field("velocity", (o) => o.velocity),
  vec3Field("avelocity", (o) => o.avelocity),
  intField(
    "mass",
    (o) => o.mass,
    (o, v) => {
      o.mass = v;
    },
  ),
  timeField(
    "air_finished",
    (o) => o.air_finished,
    (o, v) => {
      o.air_finished = v;
    },
  ),
  floatField(
    "gravity",
    (o) => o.gravity,
    (o, v) => {
      o.gravity = v;
    },
    edictGravityIsEmpty,
  ),
  entityField(
    "goalentity",
    (o) => o.goalentity,
    (o, v) => {
      o.goalentity = v;
    },
  ),
  entityField(
    "movetarget",
    (o) => o.movetarget,
    (o, v) => {
      o.movetarget = v;
    },
  ),
  floatField(
    "yaw_speed",
    (o) => o.yaw_speed,
    (o, v) => {
      o.yaw_speed = v;
    },
  ),
  floatField(
    "ideal_yaw",
    (o) => o.ideal_yaw,
    (o, v) => {
      o.ideal_yaw = v;
    },
  ),
  timeField(
    "nextthink",
    (o) => o.nextthink,
    (o, v) => {
      o.nextthink = v;
    },
  ),
  functionRefField(
    "prethink",
    (o) => o.prethink,
    (o, v) => {
      o.prethink = v;
    },
    LookupPrethink,
    NameOfPrethink,
  ),
  // save_prethink_t, same registry kind as prethink (g_local_types.ts's own
  // comment on `postthink`).
  functionRefField(
    "postthink",
    (o) => o.postthink,
    (o, v) => {
      o.postthink = v;
    },
    LookupPrethink,
    NameOfPrethink,
  ),
  functionRefField(
    "think",
    (o) => o.think,
    (o, v) => {
      o.think = v;
    },
    LookupThink,
    NameOfThink,
  ),
  functionRefField(
    "touch",
    (o) => o.touch,
    (o, v) => {
      o.touch = v;
    },
    LookupTouch,
    NameOfTouch,
  ),
  functionRefField(
    "use",
    (o) => o.use,
    (o, v) => {
      o.use = v;
    },
    LookupUse,
    NameOfUse,
  ),
  functionRefField(
    "pain",
    (o) => o.pain,
    (o, v) => {
      o.pain = v;
    },
    LookupPain,
    NameOfPain,
  ),
  functionRefField(
    "die",
    (o) => o.die,
    (o, v) => {
      o.die = v;
    },
    LookupDie,
    NameOfDie,
  ),
  timeField(
    "touch_debounce_time",
    (o) => o.touch_debounce_time,
    (o, v) => {
      o.touch_debounce_time = v;
    },
  ),
  timeField(
    "pain_debounce_time",
    (o) => o.pain_debounce_time,
    (o, v) => {
      o.pain_debounce_time = v;
    },
  ),
  timeField(
    "damage_debounce_time",
    (o) => o.damage_debounce_time,
    (o, v) => {
      o.damage_debounce_time = v;
    },
  ),
  timeField(
    "fly_sound_debounce_time",
    (o) => o.fly_sound_debounce_time,
    (o, v) => {
      o.fly_sound_debounce_time = v;
    },
  ),
  timeField(
    "last_move_time",
    (o) => o.last_move_time,
    (o, v) => {
      o.last_move_time = v;
    },
  ),
  intField(
    "health",
    (o) => o.health,
    (o, v) => {
      o.health = v;
    },
  ),
  intField(
    "max_health",
    (o) => o.max_health,
    (o, v) => {
      o.max_health = v;
    },
  ),
  intField(
    "gib_health",
    (o) => o.gib_health,
    (o, v) => {
      o.gib_health = v;
    },
  ),
  boolField(
    "deadflag",
    (o) => o.deadflag,
    (o, v) => {
      o.deadflag = v;
    },
  ),
  timeField(
    "show_hostile",
    (o) => o.show_hostile,
    (o, v) => {
      o.show_hostile = v;
    },
  ),
  timeField(
    "powerarmor_time",
    (o) => o.powerarmor_time,
    (o, v) => {
      o.powerarmor_time = v;
    },
  ),
  stringField(
    "map",
    (o) => o.map,
    (o, v) => {
      o.map = v;
    },
  ),
  intField(
    "viewheight",
    (o) => o.viewheight,
    (o, v) => {
      o.viewheight = v;
    },
  ),
  boolField(
    "takedamage",
    (o) => o.takedamage,
    (o, v) => {
      o.takedamage = v;
    },
  ),
  intField(
    "dmg",
    (o) => o.dmg,
    (o, v) => {
      o.dmg = v;
    },
  ),
  intField(
    "radius_dmg",
    (o) => o.radius_dmg,
    (o, v) => {
      o.radius_dmg = v;
    },
  ),
  floatField(
    "dmg_radius",
    (o) => o.dmg_radius,
    (o, v) => {
      o.dmg_radius = v;
    },
  ),
  intField(
    "sounds",
    (o) => o.sounds,
    (o, v) => {
      o.sounds = v;
    },
  ),
  intField(
    "count",
    (o) => o.count,
    (o, v) => {
      o.count = v;
    },
  ),
  entityField(
    "chain",
    (o) => o.chain,
    (o, v) => {
      o.chain = v;
    },
  ),
  entityField(
    "enemy",
    (o) => o.enemy,
    (o, v) => {
      o.enemy = v;
    },
  ),
  entityField(
    "oldenemy",
    (o) => o.oldenemy,
    (o, v) => {
      o.oldenemy = v;
    },
  ),
  entityField(
    "activator",
    (o) => o.activator,
    (o, v) => {
      o.activator = v;
    },
  ),
  entityField(
    "groundentity",
    (o) => o.groundentity,
    (o, v) => {
      o.groundentity = v;
    },
  ),
  intField(
    "groundentity_linkcount",
    (o) => o.groundentity_linkcount,
    (o, v) => {
      o.groundentity_linkcount = v;
    },
  ),
  entityField(
    "teamchain",
    (o) => o.teamchain,
    (o, v) => {
      o.teamchain = v;
    },
  ),
  entityField(
    "teammaster",
    (o) => o.teammaster,
    (o, v) => {
      o.teammaster = v;
    },
  ),
  entityField(
    "mynoise",
    (o) => o.mynoise,
    (o, v) => {
      o.mynoise = v;
    },
  ),
  entityField(
    "mynoise2",
    (o) => o.mynoise2,
    (o, v) => {
      o.mynoise2 = v;
    },
  ),
  intField(
    "noise_index",
    (o) => o.noise_index,
    (o, v) => {
      o.noise_index = v;
    },
  ),
  intField(
    "noise_index2",
    (o) => o.noise_index2,
    (o, v) => {
      o.noise_index2 = v;
    },
  ),
  floatField(
    "volume",
    (o) => o.volume,
    (o, v) => {
      o.volume = v;
    },
  ),
  floatField(
    "attenuation",
    (o) => o.attenuation,
    (o, v) => {
      o.attenuation = v;
    },
  ),
  floatField(
    "wait",
    (o) => o.wait,
    (o, v) => {
      o.wait = v;
    },
  ),
  floatField(
    "delay",
    (o) => o.delay,
    (o, v) => {
      o.delay = v;
    },
  ),
  floatField(
    "random",
    (o) => o.random,
    (o, v) => {
      o.random = v;
    },
  ),
  timeField(
    "teleport_time",
    (o) => o.teleport_time,
    (o, v) => {
      o.teleport_time = v;
    },
  ),
  intField(
    "watertype",
    (o) => o.watertype,
    (o, v) => {
      o.watertype = v;
    },
  ),
  intField(
    "waterlevel",
    (o) => o.waterlevel,
    (o, v) => {
      o.waterlevel = v;
    },
  ),
  vec3Field("move_origin", (o) => o.move_origin),
  vec3Field("move_angles", (o) => o.move_angles),
  intField(
    "style",
    (o) => o.style,
    (o, v) => {
      o.style = v;
    },
  ),
  stringField(
    "style_on",
    (o) => o.style_on,
    (o, v) => {
      o.style_on = v;
    },
  ),
  stringField(
    "style_off",
    (o) => o.style_off,
    (o, v) => {
      o.style_off = v;
    },
  ),
  itemPointerField(
    "item",
    (o) => o.item,
    (o, v) => {
      o.item = v;
    },
  ),
  intField(
    "crosslevel_flags",
    (o) => o.crosslevel_flags,
    (o, v) => {
      o.crosslevel_flags = v;
    },
  ),
  ...flattenPrefixed<EdictT, MoveinfoT>("moveinfo", (o) => o.moveinfo, moveinfoFields),
  ...flattenPrefixed<EdictT, MonsterinfoT>("monsterinfo", (o) => o.monsterinfo, monsterinfoFields),
  intField(
    "plat2flags",
    (o) => o.plat2flags,
    (o, v) => {
      o.plat2flags = v;
    },
  ),
  vec3Field("offset", (o) => o.offset),
  vec3Field("gravityVector", (o) => o.gravityVector, edictGravityVectorIsEmpty),
  entityField(
    "bad_area",
    (o) => o.bad_area,
    (o, v) => {
      o.bad_area = v;
    },
  ),
  entityField(
    "hint_chain",
    (o) => o.hint_chain,
    (o, v) => {
      o.hint_chain = v;
    },
  ),
  entityField(
    "monster_hint_chain",
    (o) => o.monster_hint_chain,
    (o, v) => {
      o.monster_hint_chain = v;
    },
  ),
  entityField(
    "target_hint_chain",
    (o) => o.target_hint_chain,
    (o, v) => {
      o.target_hint_chain = v;
    },
  ),
  intField(
    "hint_chain_id",
    (o) => o.hint_chain_id,
    (o, v) => {
      o.hint_chain_id = v;
    },
  ),
  fixedStringField(
    "clock_message",
    (o) => o.clock_message,
    (o, v) => {
      o.clock_message = v;
    },
  ),
  timeField(
    "dead_time",
    (o) => o.dead_time,
    (o, v) => {
      o.dead_time = v;
    },
  ),
  entityField(
    "beam",
    (o) => o.beam,
    (o, v) => {
      o.beam = v;
    },
  ),
  entityField(
    "beam2",
    (o) => o.beam2,
    (o, v) => {
      o.beam2 = v;
    },
  ),
  entityField(
    "proboscus",
    (o) => o.proboscus,
    (o, v) => {
      o.proboscus = v;
    },
  ),
  entityField(
    "disintegrator",
    (o) => o.disintegrator,
    (o, v) => {
      o.disintegrator = v;
    },
  ),
  timeField(
    "disintegrator_time",
    (o) => o.disintegrator_time,
    (o, v) => {
      o.disintegrator_time = v;
    },
  ),
  intField(
    "hackflags",
    (o) => o.hackflags,
    (o, v) => {
      o.hackflags = v;
    },
  ),
  ...flattenPrefixed<EdictT, EdictFogT>("fog", (o) => o.fog, fogFields),
  ...flattenPrefixed<EdictT, EdictHeightfogT>("heightfog", (o) => o.heightfog, edictHeightfogFields),
  bitsetBooleansField("item_picked_up_by", (o) => o.item_picked_up_by),
  timeField(
    "slime_debounce_time",
    (o) => o.slime_debounce_time,
    (o, v) => {
      o.slime_debounce_time = v;
    },
  ),
  ...flattenPrefixed<EdictT, EdictT["bmodel_anim"]>("bmodel_anim", (o) => o.bmodel_anim, bmodelAnimFields),
  ...flattenPrefixed<EdictT, ModT>("lastMOD", (o) => o.lastMOD, lastModFields),
];

// -------------------------------------------------------------------------
// Local default-value factories (see file header "OTHER NOTED DEVIATIONS" --
// duplicated field-for-field from p_client.ts's own unexported
// defaultClientPersistant/defaultClientRespawn/defaultGClient/
// defaultKexPmoveState/defaultKexPlayerState, and from g_main_globals.ts's
// own unexported defaultGameLocals/defaultLevelLocals).
// -------------------------------------------------------------------------

function defaultHeightFog(): HeightFogT {
  return { start: [0, 0, 0, 0], end: [0, 0, 0, 0], falloff: 0, density: 0 };
}

function defaultClientPersistant(): ClientPersistantT {
  return {
    userinfo: "",
    social_id: "",
    netname: "",
    hand: HandednessT.RIGHT_HANDED,
    autoswitch: AutoSwitchT.SMART,
    autoshield: 0,
    connected: false,
    spawned: false,
    health: 0,
    max_health: 0,
    savedFlags: 0n,
    selected_item: ItemIdT.IT_NULL,
    selected_item_time: GTIME_ZERO,
    inventory: new Int32Array(ItemIdT.IT_TOTAL),
    max_ammo: new Int16Array(AmmoT.AMMO_MAX),
    weapon: null,
    lastweapon: null,
    power_cubes: 0,
    score: 0,
    game_help1changed: 0,
    game_help2changed: 0,
    helpchanged: 0,
    help_time: GTIME_ZERO,
    spectator: false,
    bob_skip: false,
    wanted_fog: [0, 0, 0, 0, 0],
    wanted_heightfog: defaultHeightFog(),
    fog_transition_time: GTIME_ZERO,
    megahealth_time: GTIME_ZERO,
    lives: 0,
    n64_crouch_warn_times: 0,
    n64_crouch_warning: GTIME_ZERO,
  };
}

function defaultClientRespawn(): ClientRespawnT {
  return {
    coop_respawn: defaultClientPersistant(),
    entertime: GTIME_ZERO,
    score: 0,
    cmd_angles: vec3(),
    spectator: false,
    ctf_team: CtfteamT.CTF_NOTEAM,
    ctf_state: 0,
    ctf_lasthurtcarrier: GTIME_ZERO,
    ctf_lastreturnedflag: GTIME_ZERO,
    ctf_flagsince: GTIME_ZERO,
    ctf_lastfraggedcarrier: GTIME_ZERO,
    id_state: false,
    lastidtime: GTIME_ZERO,
    voted: false,
    ready: false,
    admin: false,
    ghost: null,
  };
}

function defaultKexPmoveState(): KexPmoveStateT {
  return {
    pm_type: KexPmTypeT.PM_NORMAL,
    origin: vec3(),
    velocity: vec3(),
    pm_flags: 0,
    pm_time: 0,
    gravity: 0,
    delta_angles: vec3(),
    viewheight: 0,
  };
}

function defaultKexPlayerState(): KexPlayerStateT {
  return {
    pmove: defaultKexPmoveState(),
    viewangles: vec3(),
    viewoffset: vec3(),
    kick_angles: vec3(),
    gunangles: vec3(),
    gunoffset: vec3(),
    gunindex: 0,
    gunskin: 0,
    gunframe: 0,
    gunrate: 0,
    screen_blend: new Float32Array(4),
    damage_blend: new Float32Array(4),
    fov: 90,
    rdflags: RefdefFlagsT.RDF_NONE,
    stats: new Int16Array(MAX_STATS),
    team_id: 0,
  };
}

function defaultGClient(): GClientT {
  return {
    ps: defaultKexPlayerState(),
    ping: 0,
    pers: defaultClientPersistant(),
    resp: defaultClientRespawn(),
    old_pmove: defaultKexPmoveState(),
    showscores: false,
    showeou: false,
    showinventory: false,
    showhelp: false,
    buttons: ButtonT.BUTTON_NONE,
    oldbuttons: ButtonT.BUTTON_NONE,
    latched_buttons: ButtonT.BUTTON_NONE,
    cmd: { msec: 0, buttons: ButtonT.BUTTON_NONE, angles: vec3(), forwardmove: 0, sidemove: 0, server_frame: 0 },
    weapon_fire_finished: GTIME_ZERO,
    weapon_think_time: GTIME_ZERO,
    weapon_fire_buffered: false,
    weapon_thunk: false,
    newweapon: null,
    damage_armor: 0,
    damage_parmor: 0,
    damage_blood: 0,
    damage_knockback: 0,
    damage_from: vec3(),
    damage_indicators: [],
    num_damage_indicators: 0,
    killer_yaw: 0,
    weaponstate: WeaponstateT.WEAPON_READY,
    kick: { angles: vec3(), origin: vec3(), time: GTIME_ZERO, total: GTIME_ZERO },
    quake_time: GTIME_ZERO,
    kick_origin: vec3(),
    v_dmg_roll: 0,
    v_dmg_pitch: 0,
    v_dmg_time: GTIME_ZERO,
    fall_time: GTIME_ZERO,
    fall_value: 0,
    damage_alpha: 0,
    bonus_alpha: 0,
    damage_blend: vec3(),
    v_angle: vec3(),
    v_forward: vec3(),
    bobtime: 0,
    oldviewangles: vec3(),
    oldvelocity: vec3(),
    oldgroundentity: null,
    flash_time: GTIME_ZERO,
    next_drown_time: GTIME_ZERO,
    old_waterlevel: WaterLevelT.WATER_NONE,
    breather_sound: 0,
    machinegun_shots: 0,
    anim_end: 0,
    anim_priority: AnimPriorityT.ANIM_BASIC,
    anim_duck: false,
    anim_run: false,
    anim_time: GTIME_ZERO,
    quad_time: GTIME_ZERO,
    invincible_time: GTIME_ZERO,
    breather_time: GTIME_ZERO,
    enviro_time: GTIME_ZERO,
    invisible_time: GTIME_ZERO,
    grenade_blew_up: false,
    grenade_time: GTIME_ZERO,
    grenade_finished_time: GTIME_ZERO,
    quadfire_time: GTIME_ZERO,
    silencer_shots: 0,
    weapon_sound: 0,
    pickup_msg_time: GTIME_ZERO,
    flood_locktill: GTIME_ZERO,
    flood_when: new Array<GTime>(10).fill(GTIME_ZERO),
    flood_whenhead: 0,
    respawn_time: GTIME_ZERO,
    chase_target: null,
    update_chase: false,
    double_time: GTIME_ZERO,
    ir_time: GTIME_ZERO,
    nuke_time: GTIME_ZERO,
    tracker_pain_time: GTIME_ZERO,
    owned_sphere: null,
    empty_click_sound: GTIME_ZERO,
    inmenu: false,
    menu: null,
    menutime: GTIME_ZERO,
    menudirty: false,
    ctf_grapple: null,
    ctf_grapplestate: 0,
    ctf_grapplereleasetime: GTIME_ZERO,
    ctf_regentime: GTIME_ZERO,
    ctf_techsndtime: GTIME_ZERO,
    ctf_lasttechmsg: GTIME_ZERO,
    trail_head: null,
    trail_tail: null,
    no_weapon_chains: false,
    landmark_free_fall: false,
    landmark_name: null,
    landmark_rel_pos: vec3(),
    landmark_noise_time: GTIME_ZERO,
    invisibility_fade_time: GTIME_ZERO,
    chase_msg_time: GTIME_ZERO,
    menu_sign: 0,
    last_ladder_pos: vec3(),
    last_ladder_sound: GTIME_ZERO,
    coop_respawn_state: 0,
    last_damage_time: GTIME_ZERO,
    sight_entity: null,
    sight_entity_time: GTIME_ZERO,
    sound_entity: null,
    sound_entity_time: GTIME_ZERO,
    sound2_entity: null,
    sound2_entity_time: GTIME_ZERO,
    num_lag_origins: 0,
    next_lag_origin: 0,
    is_lag_compensated: false,
    lag_restore_origin: vec3(),
    slow_view_angles: vec3(),
    slow_view_angle_time: GTIME_ZERO,
    help_draw_points: false,
    help_draw_index: 0,
    help_draw_count: 0,
    help_draw_time: GTIME_ZERO,
    step_frame: 0,
    help_poi_image: 0,
    help_poi_location: vec3(),
    awaiting_respawn: false,
    respawn_timeout: GTIME_ZERO,
    fog: [0, 0, 0, 0, 0],
    heightfog: defaultHeightFog(),
    last_attacker_time: GTIME_ZERO,
    last_firing_time: GTIME_ZERO,
  };
}

function defaultLevelEntry(): LevelEntryT {
  return {
    map_name: "",
    pretty_name: "",
    total_secrets: 0,
    found_secrets: 0,
    total_monsters: 0,
    killed_monsters: 0,
    time: GTIME_ZERO,
    visit_order: 0,
  };
}

function defaultGameLocals(): GameLocalsT {
  return {
    helpmessage1: "",
    helpmessage2: "",
    help1changed: 0,
    help2changed: 0,
    clients: [],
    spawnpoint: "",
    maxclients: 0,
    maxentities: 0,
    cross_level_flags: 0,
    cross_unit_flags: 0,
    autosaved: false,
    airacceleration_modified: 0,
    gravity_modified: 0,
    level_entries: Array.from({ length: MAX_LEVELS_PER_UNIT }, defaultLevelEntry),
    max_lag_origins: 0,
    lag_origins: null,
  };
}

function defaultLevelLocals(): LevelLocalsT {
  return {
    in_frame: false,
    time: GTIME_ZERO,
    level_name: "",
    mapname: "",
    nextmap: "",
    forcemap: "",
    intermissiontime: GTIME_ZERO,
    changemap: null,
    achievement: null,
    exitintermission: false,
    intermission_eou: false,
    intermission_clear: false,
    level_intermission_set: false,
    intermission_fade: false,
    intermission_fading: false,
    intermission_fade_time: GTIME_ZERO,
    intermission_origin: vec3(),
    intermission_angle: vec3(),
    respawn_intermission: false,
    pic_health: 0,
    pic_ping: 0,
    total_secrets: 0,
    found_secrets: 0,
    total_goals: 0,
    found_goals: 0,
    total_monsters: 0,
    monsters_registered: new Array<EdictT | null>(MAX_EDICTS).fill(null),
    killed_monsters: 0,
    current_entity: null,
    body_que: 0,
    power_cubes: 0,
    disguise_violator: null,
    disguise_violation_time: GTIME_ZERO,
    disguise_icon: 0,
    shadow_light_count: 0,
    is_n64: false,
    coop_level_restart_time: GTIME_ZERO,
    instantitems: false,
    goals: null,
    goal_num: 0,
    vwep_offset: 0,
    coop_health_scaling: 0,
    coop_scale_players: 0,
    entry: null,
    valid_poi: false,
    current_poi: vec3(),
    current_poi_image: 0,
    current_poi_stage: 0,
    current_dynamic_poi: null,
    // g_local.h:1235: `vec3_t *poi_points[MAX_SPLIT_PLAYERS]` -- was
    // incorrectly sized MAX_CLIENTS (256) here; the real C++ array is
    // MAX_SPLIT_PLAYERS (8). Not saved (see this file's own "NOT saved"
    // comment above), so this default is only ever the fresh-level value.
    poi_points: new Array<Vec3[] | null>(MAX_SPLIT_PLAYERS).fill(null),
    start_items: null,
    no_grapple: false,
    gravity: 0,
    hub_map: false,
    health_bar_entities: new Array<EdictT | null>(MAX_HEALTH_BARS).fill(null),
    intermission_server_frame: 0,
    deadly_kill_box: false,
    story_active: false,
    next_auto_save: GTIME_ZERO,
    next_match_report: GTIME_ZERO,
  };
}

// -------------------------------------------------------------------------
// SaveClientData (p_client.cpp) -- duplicated locally, NOT imported from
// p_client.ts.
// -------------------------------------------------------------------------
// p_client.ts already exports a `SaveClientData` doing exactly this. It is
// NOT imported here: p_client.ts has a top-level `const Touch_Item =
// G_Touch_Item;` alias (an import re-binding, not a hoisted function
// declaration) sitting inside a real, multi-file import cycle
// (p_client.ts <-> g_utils.ts, both importing g_items.ts). Every EXISTING
// entry point into that cycle happens to evaluate the modules in an order
// where the alias's right-hand side is already initialized; importing
// p_client.ts from a NEW module (this file) changes which module the
// bundler visits first and can leave that binding in its temporal dead
// zone instead ("ReferenceError: Cannot access 'G_Touch_Item' before
// initialization" -- reproduced in isolation: test/kexgame_p_client.test.ts
// passes cleanly on its own, so this is p_client.ts's own ordering
// fragility, not a defect introduced here; confirmed via `git diff` that
// the uncommitted in-flight changes to p_client.ts at the time of this
// unit do not touch the affected lines either). Rather than depend on that
// fragile path, this port line's own "duplicate the tiny unexported
// helper, don't reach across files for it" convention applies (see
// g_utils.ts's G_ShouldPlayersCollide note, and this file's own duplicated
// default-value factories above) -- `coopEnabled`/`saveClientData` below
// are a field-for-field copy of p_client.ts's own `coopEnabled`/
// `SaveClientData`.

function coopEnabled(): boolean {
  const c = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return (c === null ? 0 : c.value) !== 0;
}

function saveClientData(): void {
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse || ent.client === null) continue;
    const c = game.clients[i];
    if (c === undefined) continue;
    c.pers.health = ent.health;
    c.pers.max_health = ent.max_health;
    c.pers.savedFlags =
      ent.flags & (EntFlagsT.FL_FLASHLIGHT | EntFlagsT.FL_GODMODE | EntFlagsT.FL_NOTARGET | EntFlagsT.FL_POWER_ARMOR | EntFlagsT.FL_WANTS_POWER_ARMOR);
    if (coopEnabled()) c.pers.score = ent.client.resp.score;
  }
}

// -------------------------------------------------------------------------
// Entry points (g_save.cpp:2393-2605)
// -------------------------------------------------------------------------

function readTopLevel(jsonText: string): { [key: string]: JVal } {
  const parsed = parseJSONText(jsonText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed instanceof JNum) {
    throw new Error("g_save: expected an object at the JSON root");
  }
  return parsed;
}

function checkSaveVersion(root: { [key: string]: JVal }): void {
  const v = root["save_version"];
  if (!(v instanceof JNum) || Number(v.raw) !== SAVE_FORMAT_VERSION) {
    throw new Error(`g_save: savegame from an incompatible version (expected save_version ${SAVE_FORMAT_VERSION})`);
  }
}

/** WriteGameJson(bool autosave, size_t *out_size) -- g_save.cpp:2393-2419. */
export function WriteGameJson(autosave: boolean): string {
  if (!autosave) saveClientData();

  game.autosaved = autosave;
  const gameObj = writeStruct(game, gameLocalsFields);
  game.autosaved = false;

  const clientsArr: JVal[] = [];
  for (let i = 0; i < game.maxclients; i++) {
    const c = game.clients[i];
    clientsArr.push(c === undefined ? {} : writeStruct(c, gclientFields));
  }

  const root: { [key: string]: JVal } = {
    save_version: jInt(SAVE_FORMAT_VERSION),
    game: gameObj,
    clients: clientsArr,
  };
  return writeJSON(root);
}

/** ReadGameJson(const char *jsonString) -- g_save.cpp:2426-2463. */
export function ReadGameJson(jsonText: string, onWarning: WarnSink = noopWarn): void {
  const root = readTopLevel(jsonText);
  checkSaveVersion(root);

  const oldMaxEntities = game.maxentities;
  const oldMaxClients = game.maxclients;

  const freshEdicts = Array.from({ length: oldMaxEntities }, (_unused, i) => {
    const e = defaultEdict();
    e.s.number = i;
    return e;
  });
  SetGEdicts(freshEdicts);
  globals.edicts = g_edicts;

  Object.assign(game, defaultGameLocals());
  game.clients = Array.from({ length: oldMaxClients }, defaultGClient);

  const gameJson = root["game"];
  if (gameJson === undefined) throw new Error('g_save: missing "game"');
  readStruct(game, gameLocalsFields, gameJson, onWarning, "game");

  const clientsJson = root["clients"];
  if (!Array.isArray(clientsJson)) throw new Error('g_save: expected "clients" to be array');
  if (clientsJson.length !== game.maxclients) throw new Error("g_save: mismatched client size");

  for (let i = 0; i < clientsJson.length; i++) {
    const c = game.clients[i];
    if (c === undefined) continue;
    readStruct(c, gclientFields, clientsJson[i], onWarning, `clients[${i}]`);
  }
}

/** WriteLevelJson(bool transition, size_t *out_size) -- g_save.cpp:2467-2507. */
export function WriteLevelJson(transition: boolean): string {
  const levelObj = writeStruct(level, levelLocalsFields);

  const entities: { [key: string]: JVal } = {};
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse) continue;
    // clear all the client inuse flags before saving so that when the level
    // is re-entered, the clients will spawn at spawn points instead of
    // occupying body shells (g_save.cpp:2487-2492).
    if (transition && i >= 1 && i <= game.maxclients) continue;
    entities[String(i)] = writeStruct(ent, edictFields);
  }

  const root: { [key: string]: JVal } = {
    save_version: jInt(SAVE_FORMAT_VERSION),
    level: levelObj,
    entities,
  };
  return writeJSON(root);
}

/** ReadLevelJson(const char *jsonString) -- g_save.cpp:2512-2587. */
export function ReadLevelJson(jsonText: string, onWarning: WarnSink = noopWarn): void {
  const root = readTopLevel(jsonText);
  checkSaveVersion(root);

  // wipe all the entities (memset(g_edicts, 0, ...)) -- reset every field of
  // the SAME EdictT references (g_edicts array identity is untouched here,
  // matching this file's own defaultEdict()/G_FreeEdict in-place-reset
  // convention).
  for (const e of g_edicts) Object.assign(e, defaultEdict());
  globals.num_edicts = game.maxclients + 1;

  Object.assign(level, defaultLevelLocals());
  const levelJson = root["level"];
  if (levelJson === undefined) throw new Error('g_save: missing "level"');
  readStruct(level, levelLocalsFields, levelJson, onWarning, "level");

  const entitiesJson = root["entities"];
  if (entitiesJson === null || typeof entitiesJson !== "object" || Array.isArray(entitiesJson) || entitiesJson instanceof JNum) {
    throw new Error('g_save: expected "entities" to be object');
  }

  for (const key of Object.keys(entitiesJson)) {
    const number = Number.parseInt(key, 10);
    if (!Number.isInteger(number) || number < 0) continue;
    if (number >= globals.num_edicts) globals.num_edicts = number + 1;
    const ent = g_edicts[number];
    if (ent === undefined) continue;
    G_InitEdict(ent);
    readStruct(ent, edictFields, entitiesJson[key], onWarning, `entities[${number}]`);
    // let the server rebuild world links for this ent
    ent.linked = false;
    gi.linkentity(ent);
  }

  // mark all clients as unconnected
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[i + 1];
    if (ent === undefined) continue;
    ent.client = game.clients[i] ?? null;
    if (ent.client !== null) {
      ent.client.pers.connected = false;
      ent.client.pers.spawned = false;
    }
  }

  // do any load time things at this point -- fire cross-level/unit triggers
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.classname === "target_crosslevel_target" || ent.classname === "target_crossunit_target") {
      ent.nextthink = Gtime_add(level.time, Gtime_from_sec(ent.delay));
    }
  }
}

/** G_CanSave() -- g_save.cpp:2590-2605. The `gi.LocClient_Print(...,
 *  "$g_no_save_dead")` player message is not ported -- see file header
 *  "OTHER NOTED DEVIATIONS". */
export function G_CanSave(): boolean {
  if (game.maxclients === 1) {
    const p = g_edicts[1];
    if (p !== undefined && p.health <= 0) return false;
  }
  if (Gtime_nonzero(level.intermissiontime)) return false;
  return true;
}
