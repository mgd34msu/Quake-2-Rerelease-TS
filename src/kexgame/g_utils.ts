// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_utils.c -- misc utility functions for game module (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_utils.cpp (562 lines, C++17):
// G_Find/findradius/G_PickTarget/G_UseTargets/tv-equivalent helpers/KillBox/
// G_Spawn/G_FreeEdict/G_TouchTriggers/G_TouchProjectiles and their small
// supporting pieces. Behavioral code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// gi / globals / g_edicts / game / level -- src/kexgame/g_main_globals.ts
// ============================================================================
// No `gi`/`globals`/`g_edicts` holder existed anywhere in src/kexgame/
// before this unit (confirmed by grepping for `export let gi`/
// `SetGameImports`/`g_main_globals` -- zero matches). This unit adds
// `src/kexgame/g_main_globals.ts`, mirroring the legacy port's own
// `gi`/`globals`/`g_edicts` injection pattern (src/game/g_local.ts,
// documented in PORTING.md's "Game-track conventions": bare `export let`
// globals, assigned via `SetGameImports`/`SetGameExports`/`SetGEdicts`, no
// null-checks, "undefined-before-load matches the C global's lifetime").
// `game`/`level` are eager singletons there instead (see that file's own
// header for why), built via `defaultGameLocals()`/`defaultLevelLocals()`
// factory functions in the same style as g_local_types.ts's own
// `makeGibDef()` precedent (that file's docs explicitly leave "constructor
// call sites" to "a future behavior-porting unit" -- this unit is that
// unit, for exactly the pieces G_Spawn/G_FreeEdict/G_UseTargets need).
// `defaultEdict()` (also in g_main_globals.ts) is the "what a memset(0)
// edict looks like" factory G_FreeEdict's reset and any edict-preallocating
// caller (this unit's own test fixture; a future InitGame unit) both need,
// since `EdictT` is a plain interface with no `.clear()` method.
//
// ============================================================================
// G_Find / G_FindByString -- signature genuinely differs from the vanilla
// port, plus one placement-mismatch import from g_local.h
// ============================================================================
// This KEX header's `G_Find(from, matcher)` takes a generic
// `std::function<bool(edict_t*)>` predicate -- NOT the field+string form the
// vanilla/legacy port's `src/game/g_utils.ts::G_Find` uses (that shape is
// `G_FindByString<M>`'s specialization in THIS header, not `G_Find` itself).
// Ported as the genuinely generic predicate function the source declares.
//
// `G_FindByString<auto M>(from, value)` (the field-templated helper every
// real call site in this file actually calls) is declared in g_local.h:2054,
// NOT g_utils.cpp -- but g_local.ts/g_local_types.ts's own scope notes
// exclude every free function g_local.h declares ("those belong to the
// future units that port g_cmds.ts/g_items.ts/..."). Since G_PickTarget and
// G_UseTargets (squarely in g_utils.cpp's own scope) cannot be implemented
// without it, it is ported here instead, per PORTING.md's "the brief's
// placement wins; report the mismatch, don't move it" precedent (already
// invoked by q_std.ts's `frandom` note and g_local.ts's own `random_time`
// note). Collapsed to the field+string form exactly like the vanilla port's
// own `G_Find(from, field, match)` (PORTING.md: "C field-offset macros die
// at the call site... G_Find(from, field, match) takes field typed as the
// string-valued keys of EdictT") -- `EdictStringKey` below is the kex-line
// copy of that exact mapped type.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED
// ============================================================================
// g_utils.cpp calls five functions defined in OTHER C++ files (verified by
// grepping quake2-rerelease-dll/rerelease/*.cpp for each symbol's real
// definition, not just its g_local.h declaration):
//   - T_Damage            -> g_combat.cpp:527  (src/kexgame/g_combat.ts -- LANDED, real import)
//   - G_Impact            -> g_phys.cpp:122    (src/kexgame/g_phys.ts -- LANDED, real import)
//   - G_GetClipMask       -> g_phys.cpp:30     (src/kexgame/g_phys.ts -- LANDED, real import)
//   - G_ShouldPlayersCollide -> p_client.cpp:2996 (future src/kexgame/p_client.ts)
// G_MonsterKilled/G_ShouldPlayersCollide's owning files still don't exist in
// src/kexgame/. Per PORTING.md's "a function you cannot port faithfully is a
// reported deviation, not a TODO", each of those two is still a local,
// unexported stub that throws, naming itself and the file that owns the real
// implementation. Reached only by G_UseTargets's killtarget-vs-live-monster
// branch and KillBox's coop-collision branch -- neither of which this unit's
// own test suite exercises. Replace each with a real import once its owning
// file lands.
//
// T_Damage/G_Impact/G_GetClipMask are DIFFERENT: their owning files
// (src/kexgame/g_combat.ts, src/kexgame/g_phys.ts) have landed and export
// real implementations, so this file now imports all three directly instead
// of stubbing them. G_Impact/G_GetClipMask close a real, two-way import
// cycle with g_phys.ts (which imports G_TouchTriggers/G_TouchProjectiles
// from THIS file) -- see g_phys.ts's own file header ("g_utils.ts <->
// g_phys.ts: a real, sanctioned import cycle") for why that's safe. T_Damage
// closes an analogous cycle with g_combat.ts (which imports `findradius`
// from this file for T_RadiusDamage) -- see g_combat.ts's own file header
// ("IMPORT CYCLE: g_utils.ts <-> g_combat.ts"). All four cycle-facing
// exports on both sides of both cycles are hoisted `export function`
// declarations, never a top-level `const` evaluated at module-init time, so
// there is no TDZ hazard for PORTING.md's require()-workaround rule to apply
// to.
//
// ============================================================================
// OTHER NOTED DEVIATIONS
// ============================================================================
// - `gi.LocBroadcast_Print`/`gi.LocCenter_Print` (used by
//   G_PrintActivationMessage) have no counterpart in this port's
//   `KexGameImports` (src/kexapi/game.ts) -- only `Loc_Print`/
//   `Broadcast_Print`/`Center_Print` exist there. Since `ent.message` is
//   already a plain resolved string (this port has no loc-key + args pair
//   for edict messages), `Broadcast_Print(PRINT_CENTER, ...)`/
//   `Center_Print(...)` are the direct behavioral equivalents with the
//   localization layer (which has nothing to localize here) skipped.
// - `coop->integer`: `CvarT` (reused from src/shared/q_shared.ts) has no
//   `.integer` field -- src/kexapi/game.ts's own file header already
//   documents this exact mismatch ("kex's cvar_t has an integer: int32_t
//   field the existing CvarT lacks... fixing this means editing
//   q_shared.ts, out of scope"). `cvar.value !== 0` is used instead
//   (`integer` is simply `(int)value` truncated in the real engine; a
//   0/1-valued cvar like `coop` truncates identically either way).
// - `null_trace` (`constexpr trace_t null_trace {};`, g_local.h:627) is
//   used by G_TouchTriggers but declared in g_local.h, not g_utils.cpp --
//   same placement-mismatch treatment as `G_FindByString` above; a
//   zero-valued `KexTraceT` constant is defined locally below.
// - `#ifdef _DEBUG gi.Com_Print("tried to free special edict\n"); #endif`
//   (G_FreeEdict) is dropped per PORTING.md's "#ifdef ... take the portable
//   path" idiom -- this port has no separate debug/release build.
// - `Bot_UnRegisterEdict`/`unlinkentity` etc. are called through `gi`
//   exactly as declared; no behavior of theirs is reproduced here (they are
//   genuine engine-import calls, not local logic).

import { vec3, type Vec3 } from "../shared/math";
import { CplaneT, Q_strcasecmp } from "../shared/q_shared";
import {
  ATTN_NORM,
  BoxEdictsResultT,
  ContentsT,
  CvarFlagsT,
  type KexEdictT,
  type KexTraceT,
  MAX_EDICTS,
  PrintTypeT,
  SolidityAreaT,
  SolidT,
  SoundchanT,
  SvflagsT,
} from "../kexapi/game";
import {
  BODY_QUEUE_SIZE,
  DamageflagsT,
  type EdictT,
  EntFlagsT,
  type ModT,
  ModIdT,
  MonsterAiFlagsT,
  MovetypeT,
  SPAWNFLAG_MONSTER_DEAD,
  type ThinkFn,
} from "./g_local";
import { RegisterThink } from "./g_save_registry";
import { gi, globals, g_edicts, game, level, defaultEdict } from "./g_main_globals";
import { G_Impact, G_GetClipMask } from "./g_phys";
import { T_Damage } from "./g_combat";
import { G_MonsterKilled } from "./g_monster";
import { GTIME_ZERO, Gtime_add, Gtime_from_ms, Gtime_from_sec, Gtime_nonzero, Gtime_subtract } from "./gtime";
import { SpawnFlags_has } from "./spawnflags";
import { AngleVectors, vec3_equals, vec3_length, vec3_origin } from "./q_vec3";
import { irandom } from "./q_std";

// ---------------------------------------------------------------------------
// EXTERNAL DEPENDENCIES NOT YET PORTED (see file header)
// ---------------------------------------------------------------------------



// G_Impact/G_GetClipMask: formerly local throwing stubs here (see this
// file's own header, "EXTERNAL DEPENDENCIES NOT YET PORTED"), now real
// imports -- src/kexgame/g_phys.ts has landed. This closes a real,
// sanctioned import cycle (g_phys.ts imports G_TouchTriggers/
// G_TouchProjectiles from this file); see g_phys.ts's own file header
// ("g_utils.ts <-> g_phys.ts: a real, sanctioned import cycle") for why that
// is safe here (both sides are hoisted `export function` declarations, no
// top-level cross-module value access at module-init time).

function G_ShouldPlayersCollide(_weaponry: boolean): boolean {
  throw new Error("G_ShouldPlayersCollide: not yet ported (pending p_client.ts, see p_client.cpp:2996)");
}

function modFromId(id: ModIdT): ModT {
  // mod_t's implicit single-argument constructor from mod_id_t
  // (g_local.h:1081-1093): friendly_fire/no_point_loss default false.
  return { id, friendly_fire: false, no_point_loss: false };
}

/** coop->integer, worked around per the file header's CvarT.value note. */
function coopEnabled(): boolean {
  const c = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

/** g_local.h:627: `constexpr trace_t null_trace {};` -- see file header. */
const null_trace: KexTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 0,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: ContentsT.CONTENTS_NONE,
  ent: null,
  plane2: new CplaneT(),
  surface2: null,
};

// ---------------------------------------------------------------------------
// G_Find / G_FindByString / findradius
// ---------------------------------------------------------------------------

/**
 * g_utils.cpp: `edict_t *G_Find(edict_t *from, std::function<bool(edict_t*)> matcher)`.
 *
 * C: `if (!from) from = g_edicts; else from++;` -- pointer arithmetic on
 * array position, independent of the edict's own content. Array-identity
 * lookup (not `from.s.number`) is used for the same reason the vanilla port
 * documents: G_FreeEdict's zero-reset also zeroes `s.number`, so resuming a
 * scan from a just-freed edict (G_UseTargets's killtarget loop does exactly
 * this) would land on the wrong spot if keyed off `s.number`.
 */
export function G_Find(from: EdictT | null, matcher: (e: EdictT) => boolean): EdictT | null {
  const start = from === null ? 0 : g_edicts.indexOf(from) + 1;

  for (let i = start; i < globals.num_edicts; i++) {
    const candidate = g_edicts[i];
    if (candidate === undefined || !candidate.inuse) continue;
    if (matcher(candidate)) return candidate;
  }

  return null;
}

/** the string-valued keys of EdictT -- see file header's G_FindByString note. */
export type EdictStringKey = {
  [K in keyof EdictT]: EdictT[K] extends string | null ? K : never;
}[keyof EdictT];

/**
 * g_local.h:2054: `template<auto M> edict_t *G_FindByString(edict_t *from,
 * const std::string_view &value)` -- `e->*M && strlen(e->*M) ==
 * value.length() && !Q_strncasecmp(e->*M, value.data(), value.length())`,
 * i.e. a case-insensitive, exact-length string match against one field.
 * Every real call site in this file instantiates it as `<&edict_t::targetname>`.
 */
export function G_FindByString(from: EdictT | null, field: EdictStringKey, value: string): EdictT | null {
  return G_Find(from, (e) => {
    const f = e[field];
    return f !== null && f.length === value.length && f.toLowerCase() === value.toLowerCase();
  });
}

/**
 * g_utils.cpp: `edict_t *findradius(edict_t *from, const vec3_t &org, float rad)`
 * -- entities whose bbox center lies within `rad` of `org`.
 */
export function findradius(from: EdictT | null, org: Vec3, rad: number): EdictT | null {
  const start = from === null ? 0 : g_edicts.indexOf(from) + 1;
  const eorg = vec3();

  for (let i = start; i < globals.num_edicts; i++) {
    const candidate = g_edicts[i];
    if (candidate === undefined || !candidate.inuse) continue;
    if (candidate.solid === SolidT.SOLID_NOT) continue;
    for (let j = 0; j < 3; j++) {
      eorg[j] = org[j] - (candidate.s.origin[j] + (candidate.mins[j] + candidate.maxs[j]) * 0.5);
    }
    if (vec3_length(eorg) > rad) continue;
    return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// G_PickTarget
// ---------------------------------------------------------------------------

const MAXCHOICES = 8;

/**
 * g_utils.cpp: `edict_t *G_PickTarget(const char *targetname)` -- collects up
 * to MAXCHOICES matching entities and returns one at random via `irandom`
 * (g_local.h's mt19937-backed family, ported to q_std.ts's `irandom`; not
 * separately seedable, matching the C++ source's own process-seeded rng).
 */
export function G_PickTarget(targetname: string | null): EdictT | null {
  if (targetname === null) {
    gi.Com_Print("G_PickTarget called with nullptr targetname\n");
    return null;
  }

  let ent: EdictT | null = null;
  const choice: EdictT[] = [];

  for (;;) {
    ent = G_FindByString(ent, "targetname", targetname);
    if (ent === null) break;
    choice.push(ent);
    if (choice.length === MAXCHOICES) break;
  }

  if (choice.length === 0) {
    gi.Com_Print(`G_PickTarget: target ${targetname} not found\n`);
    return null;
  }

  return choice[irandom(choice.length)] ?? null;
}

// ---------------------------------------------------------------------------
// Think_Delay / G_PrintActivationMessage / G_UseTargets
// ---------------------------------------------------------------------------

/** g_utils.cpp: `THINK(Think_Delay) (edict_t *ent) -> void`. */
export const Think_Delay: ThinkFn = RegisterThink("Think_Delay", (ent: EdictT): void => {
  G_UseTargets(ent, ent.activator);
  G_FreeEdict(ent);
});

/** g_utils.cpp: `void G_PrintActivationMessage(edict_t *ent, edict_t *activator, bool coop_global)`. */
export function G_PrintActivationMessage(ent: EdictT, activator: EdictT | null, coop_global: boolean): void {
  if (ent.message === null || activator === null || (activator.svflags & SvflagsT.SVF_MONSTER) !== 0) return;

  if (coop_global && coopEnabled()) {
    // C: gi.LocBroadcast_Print(PRINT_CENTER, "{}", ent->message) -- see file
    // header's Broadcast_Print/Center_Print deviation note.
    gi.Broadcast_Print(PrintTypeT.PRINT_CENTER, ent.message);
  } else {
    gi.Center_Print(activator, ent.message);
  }

  // [Paril-KEX] allow non-noisy centerprints
  if (ent.noise_index >= 0) {
    if (ent.noise_index !== 0) {
      gi.sound(activator, SoundchanT.CHAN_AUTO, ent.noise_index, 1, ATTN_NORM, 0);
    } else {
      gi.sound(activator, SoundchanT.CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
    }
  }
}

/**
 * g_utils.cpp: `void G_UseTargets(edict_t *ent, edict_t *activator)`.
 *
 * The KEX line's door/areaportal skip list has FOUR classnames
 * (func_door/func_door_rotating/func_door_secret/func_water), two more than
 * the vanilla/legacy port's two -- ported faithfully with all four.
 */
export function G_UseTargets(ent: EdictT, activator: EdictT | null): void {
  // check for a delay
  if (ent.delay !== 0) {
    const t = G_Spawn();
    t.classname = "DelayedUse";
    t.nextthink = Gtime_add(level.time, Gtime_from_sec(ent.delay));
    t.think = Think_Delay;
    t.activator = activator;
    if (activator === null) {
      gi.Com_Print("Think_Delay with no activator\n");
    }
    t.message = ent.message;
    t.target = ent.target;
    t.killtarget = ent.killtarget;
    return;
  }

  // print the message
  G_PrintActivationMessage(ent, activator, true);

  // kill killtargets
  if (ent.killtarget !== null) {
    const killtarget = ent.killtarget;
    let t: EdictT | null = null;
    while ((t = G_FindByString(t, "targetname", killtarget)) !== null) {
      if (t.teammaster !== null) {
        // PMM - if this entity is part of a chain, cleanly remove it
        if ((t.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) {
          let master: EdictT | null = t.teammaster;
          while (master !== null) {
            if (master.teamchain === t) {
              master.teamchain = t.teamchain;
              break;
            }
            master = master.teamchain;
          }
        } else if ((t.flags & EntFlagsT.FL_TEAMMASTER) !== 0n) {
          // [Paril-KEX] remove teammaster too
          t.teammaster.flags &= ~EntFlagsT.FL_TEAMMASTER;
          const new_master = t.teammaster.teamchain;
          if (new_master !== null) {
            new_master.flags |= EntFlagsT.FL_TEAMMASTER;
            new_master.flags &= ~EntFlagsT.FL_TEAMSLAVE;
            let m: EdictT | null = new_master;
            while (m !== null) {
              m.teammaster = new_master;
              m = m.teamchain;
            }
          }
        }
      }

      // [Paril-KEX] if we killtarget a monster, clean up properly
      if ((t.svflags & SvflagsT.SVF_MONSTER) !== 0) {
        if (!t.deadflag && (t.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) === 0n && !SpawnFlags_has(t.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
          G_MonsterKilled(t);
        }
      }

      // PMM
      G_FreeEdict(t);

      if (!ent.inuse) {
        gi.Com_Print("entity was removed while using killtargets\n");
        return;
      }
    }
  }

  // fire targets
  if (ent.target !== null) {
    const target = ent.target;
    let t: EdictT | null = null;
    while ((t = G_FindByString(t, "targetname", target)) !== null) {
      // doors fire area portals in a specific way. C dereferences both
      // classnames unconditionally; every real call site sets them, so a
      // null here is unreached in practice -- TS cannot express an
      // unchecked deref through a nullable type, so this guard silently
      // skips the areaportal special-case instead of crashing (same
      // pathological-input deviation the vanilla/legacy port documents for
      // its own copy of this check).
      if (
        t.classname !== null &&
        ent.classname !== null &&
        Q_strcasecmp(t.classname, "func_areaportal") === 0 &&
        (Q_strcasecmp(ent.classname, "func_door") === 0 ||
          Q_strcasecmp(ent.classname, "func_door_rotating") === 0 ||
          Q_strcasecmp(ent.classname, "func_door_secret") === 0 ||
          Q_strcasecmp(ent.classname, "func_water") === 0)
      ) {
        continue;
      }

      if (t === ent) {
        gi.Com_Print("WARNING: Entity used itself.\n");
      } else if (t.use !== null) {
        t.use(t, ent, activator);
      }
      if (!ent.inuse) {
        gi.Com_Print("entity was removed while using targets\n");
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// G_SetMovedir
// ---------------------------------------------------------------------------

const VEC_UP: Vec3 = vec3(0, -1, 0);
const MOVEDIR_UP: Vec3 = vec3(0, 0, 1);
const VEC_DOWN: Vec3 = vec3(0, -2, 0);
const MOVEDIR_DOWN: Vec3 = vec3(0, 0, -1);

function copyVec3(dst: Vec3, src: Vec3): void {
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
}

/** g_utils.cpp: `void G_SetMovedir(vec3_t &angles, vec3_t &movedir)`. */
export function G_SetMovedir(angles: Vec3, movedir: Vec3): void {
  if (vec3_equals(angles, VEC_UP)) {
    copyVec3(movedir, MOVEDIR_UP);
  } else if (vec3_equals(angles, VEC_DOWN)) {
    copyVec3(movedir, MOVEDIR_DOWN);
  } else {
    AngleVectors(angles, movedir, null, null);
  }

  angles[0] = 0;
  angles[1] = 0;
  angles[2] = 0;
}

// ---------------------------------------------------------------------------
// G_CopyString
// ---------------------------------------------------------------------------

/**
 * g_utils.cpp: `char *G_CopyString(const char *in, int32_t tag)` --
 * `gi.TagMalloc` + `Q_strlcpy` collapse to a plain string per PORTING.md's
 * "Z_Malloc/... -> plain allocation" idiom (JS strings are immutable
 * values, not buffers needing an independent copy); the `tag` parameter is
 * dropped entirely, matching the vanilla/legacy port's own `G_CopyString`.
 */
export function G_CopyString(inStr: string | null): string | null {
  return inStr;
}

// ---------------------------------------------------------------------------
// G_InitEdict / G_Spawn / G_FreeEdict
// ---------------------------------------------------------------------------

/** g_utils.cpp: `void G_InitEdict(edict_t *e)`. */
export function G_InitEdict(e: EdictT): void {
  // ROGUE
  if (Gtime_nonzero(e.nextthink)) e.nextthink = GTIME_ZERO;
  // ROGUE

  e.inuse = true;
  e.sv.init = false;
  e.classname = "noclass";
  e.gravity = 1.0;
  e.s.number = g_edicts.indexOf(e);

  // PGM - do this before calling the spawn function so it can be overridden.
  e.gravityVector[0] = 0.0;
  e.gravityVector[1] = 0.0;
  e.gravityVector[2] = -1.0;
  // PGM
}

/**
 * g_utils.cpp: `edict_t *G_Spawn()`. Either finds a free edict, or allocates
 * a new one. The 500ms freed-edict reuse guard (bypassed for the first 2
 * seconds of server time) is gameplay-load-bearing -- ported exactly.
 */
export function G_Spawn(): EdictT {
  let i = game.maxclients + 1;

  for (; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    // the first couple seconds of server time can involve a lot of freeing
    // and allocating, so relax the replacement policy
    if (e !== undefined && !e.inuse && (e.freetime < Gtime_from_sec(2) || Gtime_subtract(level.time, e.freetime) > Gtime_from_ms(500))) {
      G_InitEdict(e);
      return e;
    }
  }

  if (i === game.maxentities) {
    gi.Com_Error("ED_Alloc: no free edicts");
  }

  globals.num_edicts++;
  const e = g_edicts[i];
  if (e === undefined) {
    // g_edicts is preallocated to game.maxentities entries by the (not yet
    // ported) InitGame path; a missing slot here means that precondition
    // was not met, which real C can't fail in this way (its array is a raw
    // memory block sized up front) -- same deviation the vanilla/legacy
    // port's own G_Spawn documents.
    throw new Error(`G_Spawn: g_edicts has no preallocated slot at index ${i}`);
  }
  G_InitEdict(e);
  return e;
}

/**
 * g_utils.cpp: `THINK(G_FreeEdict) (edict_t *ed) -> void`. Marks the edict
 * as free. Registered as a THINK function (assignable to `edict.think`,
 * e.g. body-queue entities) via g_save_registry.ts's idiom.
 */
export const G_FreeEdict: ThinkFn = RegisterThink("G_FreeEdict", (ed: EdictT): void => {
  // already freed
  if (!ed.inuse) return;

  gi.unlinkentity(ed); // unlink from world

  const index = g_edicts.indexOf(ed);
  if (index <= game.maxclients + BODY_QUEUE_SIZE) {
    // C: #ifdef _DEBUG gi.Com_Print("tried to free special edict\n"); #endif
    // -- debug-build-only, dropped (see file header).
    return;
  }

  gi.Bot_UnRegisterEdict(ed);

  const id = ed.spawn_count + 1;
  Object.assign(ed, defaultEdict()); // memset(ed, 0, sizeof(*ed))
  ed.s.number = g_edicts.indexOf(ed);
  ed.classname = "freed";
  ed.freetime = level.time;
  ed.inuse = false;
  ed.spawn_count = id;
  ed.sv.init = false;
});

// ---------------------------------------------------------------------------
// G_TouchTriggers
// ---------------------------------------------------------------------------

function G_TouchTriggers_BoxFilter(hit: KexEdictT | null): BoxEdictsResultT {
  if (hit === null) return BoxEdictsResultT.Skip;
  const full = g_edicts[hit.s.number];
  if (full === undefined || full.touch === null) return BoxEdictsResultT.Skip;
  return BoxEdictsResultT.Keep;
}

/** g_utils.cpp: `void G_TouchTriggers(edict_t *ent)`. */
export function G_TouchTriggers(ent: EdictT): void {
  // dead things don't activate triggers!
  if ((ent.client !== null || (ent.svflags & SvflagsT.SVF_MONSTER) !== 0) && ent.health <= 0) return;

  const touch: (KexEdictT | null)[] = new Array<KexEdictT | null>(MAX_EDICTS).fill(null);
  const num = gi.BoxEdicts(
    ent.absmin,
    ent.absmax,
    touch,
    MAX_EDICTS,
    SolidityAreaT.AREA_TRIGGERS,
    G_TouchTriggers_BoxFilter,
    null,
  );

  // be careful, it is possible to have an entity in this list removed
  // before we get to it (killtriggered)
  for (let i = 0; i < num; i++) {
    const raw = touch[i];
    if (raw === null || raw === undefined) continue;
    const hit = g_edicts[raw.s.number];
    if (hit === undefined || !hit.inuse) continue;
    if (hit.touch === null) continue;
    hit.touch(hit, ent, null_trace, true);
  }
}

// ---------------------------------------------------------------------------
// G_TouchProjectiles
// ---------------------------------------------------------------------------

// `static std::vector<skipped_projectile> skipped;` -- module-scope state,
// mirroring the C++ function-local static (persists across calls, cleared
// at the end of each call). Never shared/aliased outside this function.
const skippedProjectiles: { projectile: EdictT; spawn_count: number }[] = [];

/**
 * g_utils.cpp: `void G_TouchProjectiles(edict_t *ent, vec3_t previous_origin)`
 * -- [Paril-KEX] scan for projectiles between our movement positions to see
 * if we need to collide against them.
 */
export function G_TouchProjectiles(ent: EdictT, previous_origin: Vec3): void {
  for (;;) {
    const tr = gi.trace(previous_origin, ent.mins, ent.maxs, ent.s.origin, ent, ent.clipmask | ContentsT.CONTENTS_PROJECTILE);

    if (tr.fraction === 1.0) break;
    if (tr.ent === null || (tr.ent.svflags & SvflagsT.SVF_PROJECTILE) === 0) break;

    const trEnt = g_edicts[tr.ent.s.number];
    if (trEnt === undefined) break;

    // always skip this projectile since certain conditions may cause the
    // projectile to not disappear immediately
    trEnt.svflags &= ~SvflagsT.SVF_PROJECTILE;
    skippedProjectiles.push({ projectile: trEnt, spawn_count: trEnt.spawn_count });

    // if we're both players and it's coop, allow the projectile to "pass" through
    if (ent.client !== null && trEnt.owner !== null && trEnt.owner.client !== null && !G_ShouldPlayersCollide(true)) {
      continue;
    }

    G_Impact(ent, tr);
  }

  for (const skip of skippedProjectiles) {
    if (skip.projectile.inuse && skip.projectile.spawn_count === skip.spawn_count) {
      skip.projectile.svflags |= SvflagsT.SVF_PROJECTILE;
    }
  }

  skippedProjectiles.length = 0;
}

// ---------------------------------------------------------------------------
// KillBox
// ---------------------------------------------------------------------------

function KillBox_BoxFilter(hit: KexEdictT | null): BoxEdictsResultT {
  if (hit === null) return BoxEdictsResultT.Skip;
  const full = g_edicts[hit.s.number];
  if (full === undefined) return BoxEdictsResultT.Skip;
  if (full.solid === SolidT.SOLID_NOT || !full.takedamage || full.solid === SolidT.SOLID_TRIGGER) return BoxEdictsResultT.Skip;
  return BoxEdictsResultT.Keep;
}

/**
 * g_utils.cpp: `bool KillBox(edict_t *ent, bool from_spawning, mod_id_t mod
 * = MOD_TELEFRAG, bool bsp_clipping = true)`. Kills all entities that would
 * touch the proposed new positioning of `ent`.
 */
export function KillBox(ent: EdictT, from_spawning: boolean, mod: ModIdT = ModIdT.MOD_TELEFRAG, bsp_clipping = true): boolean {
  // don't telefrag as spectator...
  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) return true;

  let mask: ContentsT = ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER;

  // [Paril-KEX] don't gib other players in coop if we're not colliding
  if (from_spawning && ent.client !== null && coopEnabled() && !G_ShouldPlayersCollide(false)) {
    mask &= ~ContentsT.CONTENTS_PLAYER;
  }

  const touch: (KexEdictT | null)[] = new Array<KexEdictT | null>(MAX_EDICTS).fill(null);
  const num = gi.BoxEdicts(ent.absmin, ent.absmax, touch, MAX_EDICTS, SolidityAreaT.AREA_SOLID, KillBox_BoxFilter, null);

  for (let i = 0; i < num; i++) {
    const raw = touch[i];
    if (raw === null || raw === undefined) continue;
    const hit = g_edicts[raw.s.number];
    if (hit === undefined) continue;

    if (hit === ent) continue;
    if (!hit.inuse || !hit.takedamage || hit.solid === SolidT.SOLID_NOT || hit.solid === SolidT.SOLID_TRIGGER || hit.solid === SolidT.SOLID_BSP) {
      continue;
    }
    if (hit.client !== null && (mask & ContentsT.CONTENTS_PLAYER) === 0) continue;

    if ((ent.solid === SolidT.SOLID_BSP || (ent.svflags & SvflagsT.SVF_HULL) !== 0) && bsp_clipping) {
      const clip = gi.clip(ent, hit.s.origin, hit.mins, hit.maxs, hit.s.origin, G_GetClipMask(hit));
      if (clip.fraction === 1.0) continue;
    }

    // [Paril-KEX] don't allow telefragging of friends in coop. the player
    // that is about to be telefragged will have collision disabled until
    // another time.
    if (ent.client !== null && hit.client !== null && coopEnabled()) {
      hit.clipmask &= ~ContentsT.CONTENTS_PLAYER;
      ent.clipmask &= ~ContentsT.CONTENTS_PLAYER;
      continue;
    }

    T_Damage(hit, ent, ent, vec3_origin, ent.s.origin, vec3_origin, 100000, 0, DamageflagsT.DAMAGE_NO_PROTECTION, modFromId(mod));
  }

  return true; // all clear
}
