// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_trigger.c -- trigger entities for the game module (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_trigger.cpp (1,332 lines,
// C++17): InitTrigger, the multi_trigger/Use_Multi/Touch_Multi family,
// trigger_multiple (incl. the LATCHED variant), trigger_once, trigger_relay,
// trigger_key, trigger_counter, trigger_always, trigger_push (incl. the
// RAFAEL push_active/push_inactive toggle-timer variant), trigger_hurt,
// trigger_gravity, trigger_monsterjump, trigger_flashlight, trigger_fog, and
// the KEX-added trigger_coop_relay. Behavioral code, ported bug-for-bug per
// PORTING.md. Every SP_* is exported under its exact C name for the future
// spawn registry; every THINK/USE/TOUCH function is registered through
// g_save_registry.ts under its exact C name.
//
// `trigger_health_relay`/`SP_trigger_health_relay` (grep-verified: NOT
// present anywhere in g_trigger.cpp) already lives in g_monster.ts
// (g_monster.cpp:1611-1650's own citation) -- no overlap to resolve here.
//
// ============================================================================
// STUB SWAP: `st` (spawn_temp_t) -- now a real import from src/kexgame/g_spawn.ts
// ============================================================================
// This file used to carry a local, unexported, permanently-defaulted (all
// null/zero/empty) `SpawnTempT` placeholder with no setter, since no shared
// `st` global existed anywhere in this port line yet -- every `st.X` read
// was honestly always "unset". src/kexgame/g_spawn.ts has now landed with
// the real, shared `SpawnTempT` global (exported as `st`, mutated in place
// by `ED_ParseField`/`ClearSpawnTemp` during real entity spawning); this
// file's own local placeholder is DELETED and replaced with `import { st }
// from "./g_spawn"`. Cross-checked this file's own placeholder defaults
// against g_spawn.ts's canonical ones (itself verified against the real
// g_local.h/game.h struct declarations) -- this file's copy was already
// correct on every field g_spawn.ts's own header flags as a latent bug
// elsewhere in this port line (`skyautorotate: 1`, `fade_start_dist: 96`,
// `fade_end_dist: 384`, `health_multiplier: 1.0`, `sl.data.intensity: 1`),
// so this swap is a clean behavior-neutral refactor for THIS file, unlike
// g_misc.ts's own rewire (which fixed real bugs). `st.was_key_specified(key)`
// stays inlined as `st.keys_specified.has(key)`, unchanged by the swap --
// the real `SpawnTempT.keys_specified` is genuinely populated now (by real
// spawning through ED_ParseField), where the old placeholder's was
// permanently empty, so every `st.X`-gated branch below is reachable for
// the first time in this port line, not dead code.
//
// This creates a two-way module cycle with g_spawn.ts (which imports
// several of this file's SP_trigger_* functions for its registry) -- safe,
// since `st` is only ever read inside function bodies here (never at this
// file's own module top level); see g_spawn.ts's own header, "Two-way
// circular imports," for the full rationale this file now shares.
//
// ============================================================================
// EDICT_NUM / traceEdict -- same idiom as g_phys.ts/g_monster.ts
// ============================================================================
// `KexTraceT.ent`/`BoxEdicts` results are `KexEdictT | null` (the
// server-visible view); "private to game" fields (`takedamage`, `flags`,
// `client`, ...) only exist on the full `EdictT` in `g_edicts[]`. Ported the
// same local `traceEdict` helper both of those files already established.
//
// ============================================================================
// STUB SWAP: FindItemByClassname / P_ToggleFlashlight -- now real imports
// from src/kexgame/g_items.ts
// ============================================================================
// Both used to be local, unexported throwing stubs here. g_items.ts has now
// landed with real, exported implementations of both; this file's own stub
// definitions are DELETED and replaced with `import { FindItemByClassname,
// P_ToggleFlashlight } from "./g_items"`.
// - FindItemByClassname: SP_trigger_key's only caller is guarded by
//   `if (!st.item) { print; return; }` immediately above it; since `st.item`
//   is always null (see above), this branch is still NEVER reached by any
//   real spawn today -- an honest, documented consequence of the missing
//   upstream global, not a silent behavior change. Swapped for correctness
//   anyway (the C++ target is a real function now, not a future one).
// - P_ToggleFlashlight: this file's own previous citation ("pending
//   p_hud.ts, see p_hud.cpp") was WRONG -- grepping the real source tree
//   twice confirms P_ToggleFlashlight is defined in g_items.cpp:1482
//   (declared in g_local.h:2035), never in p_hud.cpp. Flagged and corrected
//   here rather than silently fixed with no trace.
//
// ============================================================================
// STUB SWAP: P_UseCoopInstancedItems -- now a real import from
// src/kexgame/p_client.ts, trigger_key_use's dropped guard restored
// ============================================================================
// trigger_key_use (g_trigger.cpp:286-366) guards its two
// `resp.coop_respawn.*` resets with `if (!P_UseCoopInstancedItems())` so
// instanced-items coop doesn't strip a used key/power-cube from a player's
// COOP RESPAWN copy along with their live inventory. Previously this file's
// own copy of trigger_key_use unconditionally applied both resets (a real
// behavior gap, not a throw -- the symbol was simply unavailable from this
// file at the time, so the guard was silently dropped per a comment citing
// g_target.ts's own stub). Now imports `P_UseCoopInstancedItems` directly
// from "./p_client" (p_client.ts does not import anything from this file, so
// this is a plain one-way import, no cycle) and restores both guards to
// match the C++ exactly.
//
// ============================================================================
// latched_trigger_filter / trigger_coop_relay_player_filter -- closure
// instead of the C++ `void *data` parameter
// ============================================================================
// The C++ passes `self` through `gi.BoxEdicts`'s untyped `void *data` so one
// static filter function can serve every `trigger_multiple`/
// `trigger_coop_relay` instance. `BoxEdictsFilterT`'s TS signature threads the
// same slot through as `filter_data: unknown`, which would need an unchecked
// narrowing cast to recover `self` -- against this port's zero-cast policy.
// Both filters instead close over `self` directly (a fresh closure built
// per-think call), passing `null` for the now-unused data parameter. Same
// behavior, no cast.
//
// ============================================================================
// windsound -- module-level cached soundindex, matches the C++ `static`
// ============================================================================
// `static cached_soundindex windsound;` (g_trigger.cpp) is a single
// index shared by every `trigger_push` in the level (assigned by whichever
// entity spawns first without SPAWNFLAG_PUSH_SILENT). Ported as a genuine
// module-level mutable object, not a per-call/per-entity value, to preserve
// that sharing.

import { type Vec3, vec3 } from "../shared/math";
import {
  ATTN_NORM,
  BoxEdictsResultT,
  type BoxEdictsFilterT,
  CvarFlagsT,
  KexMulticastT,
  type KexEdictT,
  type KexTraceT,
  KexTempEventT,
  MODELINDEX_PLAYER,
  PrintTypeT,
  ServerCommandT,
  SolidityAreaT,
  SolidT,
  SoundchanT,
  SvflagsT,
} from "../kexapi/game";
import {
  type EdictT,
  EntFlagsT,
  type GitemT,
  ItemIdT,
  type ModT,
  ModIdT,
  MovetypeT,
  SFL_CROSS_TRIGGER_MASK,
  type ThinkFn,
  type TouchFn,
  type UseFn,
  DamageflagsT,
} from "./g_local";
import { RegisterThink, RegisterTouch, RegisterUse } from "./g_save_registry";
import { gi, g_edicts, game, level } from "./g_main_globals";
import { G_GetClipMask } from "./g_phys";
import { st } from "./g_spawn";
import { T_Damage } from "./g_combat";
import { G_UseTargets, G_FreeEdict, G_SetMovedir, G_PickTarget } from "./g_utils";
import { GTIME_ZERO, Gtime_add, Gtime_from_ms, Gtime_from_sec, Gtime_nonzero, Gtime_seconds } from "./gtime";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "./spawnflags";
import { AngleVectors, boxes_intersect, vec3_dot, vec3_muls, vec3_negate, vec3_normalized, vec3_normalized_len, vec3_origin, vec3_scale, vec3_sub } from "./q_vec3";
import { clamp, frandom, irandom } from "./q_std";
import { FindItemByClassname, P_ToggleFlashlight } from "./g_items";
import { P_UseCoopInstancedItems } from "./p_client";

// ---------------------------------------------------------------------------
// `st` -- real shared import (see file header)
// ---------------------------------------------------------------------------

/** EDICT_NUM idiom -- see g_phys.ts's/g_monster.ts's own `traceEdict`. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** g_local.h's `LocCenter_Print(e, base, ...args)` convenience wrapper. */
function giLocCenterPrint(e: EdictT | null, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(e, PrintTypeT.PRINT_CENTER, base, args.map(String), args.length);
}

/** coop->integer, worked around per g_utils.ts's own CvarT.value note. */
function coopEnabled(): boolean {
  const c = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

// ---------------------------------------------------------------------------
// PGM spawnflags shared by several trigger types in this file
// ---------------------------------------------------------------------------

const SPAWNFLAG_TRIGGER_MONSTER: SpawnFlags = SpawnFlags_from(0x01);
const SPAWNFLAG_TRIGGER_NOT_PLAYER: SpawnFlags = SpawnFlags_from(0x02);
const SPAWNFLAG_TRIGGER_TRIGGERED: SpawnFlags = SpawnFlags_from(0x04);
const SPAWNFLAG_TRIGGER_TOGGLE: SpawnFlags = SpawnFlags_from(0x08);
const SPAWNFLAG_TRIGGER_LATCHED: SpawnFlags = SpawnFlags_from(0x10);
const SPAWNFLAG_TRIGGER_CLIP: SpawnFlags = SpawnFlags_from(0x20);

// ---------------------------------------------------------------------------
// InitTrigger
// ---------------------------------------------------------------------------

/** g_trigger.cpp:14-26: `void InitTrigger(edict_t *self)`. */
export function InitTrigger(self: EdictT): void {
  if (st.keys_specified.has("angle") || st.keys_specified.has("angles") || self.s.angles[0] !== 0 || self.s.angles[1] !== 0 || self.s.angles[2] !== 0) {
    G_SetMovedir(self.s.angles, self.movedir);
  }

  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  // [Paril-KEX] adjusted to allow mins/maxs to be defined by hand instead
  if (self.model !== null) gi.setmodel(self, self.model);
  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// multi_trigger / Use_Multi / Touch_Multi
// ---------------------------------------------------------------------------

/** g_trigger.cpp:29-32: `THINK(multi_wait)`. */
export const multi_wait: ThinkFn = RegisterThink("multi_wait", (ent: EdictT): void => {
  ent.nextthink = GTIME_ZERO;
});

/** g_trigger.cpp:37-56: `void multi_trigger(edict_t *ent)`. */
export function multi_trigger(ent: EdictT): void {
  if (Gtime_nonzero(ent.nextthink)) return; // already been triggered

  G_UseTargets(ent, ent.activator);

  if (ent.wait > 0) {
    ent.think = multi_wait;
    ent.nextthink = Gtime_add(level.time, Gtime_from_sec(ent.wait));
  } else {
    // we can't just remove (self) here, because this is a touch function
    // called while looping through area links...
    ent.touch = null;
    ent.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
    ent.think = G_FreeEdict;
  }
}

/** g_trigger.cpp:58-75: `USE(Use_Multi)`. */
export const Use_Multi: UseFn = RegisterUse("Use_Multi", (ent: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_TOGGLE)) {
    ent.solid = ent.solid === SolidT.SOLID_TRIGGER ? SolidT.SOLID_NOT : SolidT.SOLID_TRIGGER;
    gi.linkentity(ent);
  } else {
    ent.activator = activator;
    multi_trigger(ent);
  }
});

/** g_trigger.cpp:77-111: `TOUCH(Touch_Multi)`. */
export const Touch_Multi: TouchFn = RegisterTouch(
  "Touch_Multi",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (other.client !== null) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRIGGER_NOT_PLAYER)) return;
    } else if ((other.svflags & SvflagsT.SVF_MONSTER) !== 0) {
      if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRIGGER_MONSTER)) return;
    } else return;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRIGGER_CLIP)) {
      const clip = gi.clip(self, other.s.origin, other.mins, other.maxs, other.s.origin, G_GetClipMask(other));
      if (clip.fraction === 1.0) return;
    }

    if (self.movedir[0] !== 0 || self.movedir[1] !== 0 || self.movedir[2] !== 0) {
      const forward = vec3(0, 0, 0);
      AngleVectors(other.s.angles, forward, null, null);
      if (vec3_dot(forward, self.movedir) < 0) return;
    }

    self.activator = other;
    multi_trigger(self);
  },
);

// ---------------------------------------------------------------------------
// trigger_multiple (incl. the LATCHED variant)
// ---------------------------------------------------------------------------

/** g_trigger.cpp:127-132: `USE(trigger_enable)`. */
export const trigger_enable: UseFn = RegisterUse("trigger_enable", (self: EdictT): void => {
  self.solid = SolidT.SOLID_TRIGGER;
  self.use = Use_Multi;
  gi.linkentity(self);
});

/**
 * g_trigger.cpp:134-162: `static BoxEdictsResult_t latched_trigger_filter(edict_t
 * *other, void *data)` -- see file header for the closure-over-`self`
 * deviation from the C++ `void *data` parameter.
 */
function makeLatchedTriggerFilter(self: EdictT): BoxEdictsFilterT {
  return (raw: KexEdictT | null): BoxEdictsResultT => {
    if (raw === null) return BoxEdictsResultT.Skip;
    const other = traceEdict(raw);

    if (other.client !== null) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRIGGER_NOT_PLAYER)) return BoxEdictsResultT.Skip;
    } else if ((other.svflags & SvflagsT.SVF_MONSTER) !== 0) {
      if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TRIGGER_MONSTER)) return BoxEdictsResultT.Skip;
    } else return BoxEdictsResultT.Skip;

    if (self.movedir[0] !== 0 || self.movedir[1] !== 0 || self.movedir[2] !== 0) {
      const forward = vec3(0, 0, 0);
      AngleVectors(other.s.angles, forward, null, null);
      if (vec3_dot(forward, self.movedir) < 0) return BoxEdictsResultT.Skip;
    }

    self.activator = other;
    return BoxEdictsResultT.Keep | BoxEdictsResultT.End;
  };
}

/** g_trigger.cpp:164-175: `THINK(latched_trigger_think)`. */
export const latched_trigger_think: ThinkFn = RegisterThink("latched_trigger_think", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(1));

  const any_inside = gi.BoxEdicts(self.absmin, self.absmax, [], 0, SolidityAreaT.AREA_SOLID, makeLatchedTriggerFilter(self), null) !== 0;

  if ((self.count !== 0) !== any_inside) {
    G_UseTargets(self, self.activator);
    self.count = any_inside ? 1 : 0;
  }
});

/** g_trigger.cpp:177-221: `void SP_trigger_multiple(edict_t *ent)`. */
export function SP_trigger_multiple(ent: EdictT): void {
  if (ent.sounds === 1) ent.noise_index = gi.soundindex("misc/secret.wav");
  else if (ent.sounds === 2) ent.noise_index = gi.soundindex("misc/talk.wav");
  else if (ent.sounds === 3) ent.noise_index = gi.soundindex("misc/trigger1.wav");

  if (ent.wait === 0) ent.wait = 0.2;

  InitTrigger(ent);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_LATCHED)) {
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_TRIGGERED) || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_TOGGLE)) {
      gi.Com_Print(`${ent.classname ?? "?"}: latched and triggered/toggle are not supported\n`);
    }

    ent.think = latched_trigger_think;
    ent.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
    ent.use = Use_Multi;
    return;
  } else {
    ent.touch = Touch_Multi;
  }

  // PGM
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_TRIGGERED) || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_TOGGLE)) {
    ent.solid = SolidT.SOLID_NOT;
    ent.use = trigger_enable;
  } else {
    ent.solid = SolidT.SOLID_TRIGGER;
    ent.use = Use_Multi;
  }

  gi.linkentity(ent);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_CLIP)) ent.svflags |= SvflagsT.SVF_HULL;
}

// ---------------------------------------------------------------------------
// trigger_once
// ---------------------------------------------------------------------------

/** g_trigger.cpp:238-251: `void SP_trigger_once(edict_t *ent)`. */
export function SP_trigger_once(ent: EdictT): void {
  // make old maps work because I messed up on flag assignments here
  // triggered was on bit 1 when it should have been on bit 4
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRIGGER_MONSTER)) {
    ent.spawnflags = SpawnFlags_from(ent.spawnflags & ~SPAWNFLAG_TRIGGER_MONSTER);
    ent.spawnflags = SpawnFlags_from(ent.spawnflags | SPAWNFLAG_TRIGGER_TRIGGERED);
    gi.Com_Print(`${ent.classname ?? "?"}: fixed TRIGGERED flag\n`);
  }

  ent.wait = -1;
  SP_trigger_multiple(ent);
}

// ---------------------------------------------------------------------------
// trigger_relay
// ---------------------------------------------------------------------------

const SPAWNFLAGS_TRIGGER_RELAY_NO_SOUND: SpawnFlags = SpawnFlags_from(1);

/** g_trigger.cpp:258-264: `USE(trigger_relay_use)`. */
export const trigger_relay_use: UseFn = RegisterUse(
  "trigger_relay_use",
  (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
    if (self.crosslevel_flags !== 0 && self.crosslevel_flags !== (game.cross_level_flags & SFL_CROSS_TRIGGER_MASK & self.crosslevel_flags)) return;
    G_UseTargets(self, activator);
  },
);

/** g_trigger.cpp:266-272: `void SP_trigger_relay(edict_t *self)`. */
export function SP_trigger_relay(self: EdictT): void {
  self.use = trigger_relay_use;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_TRIGGER_RELAY_NO_SOUND)) self.noise_index = -1;
}

// ---------------------------------------------------------------------------
// trigger_key
// ---------------------------------------------------------------------------

/** g_trigger.cpp:286-366: `USE(trigger_key_use)`. */
export const trigger_key_use: UseFn = RegisterUse(
  "trigger_key_use",
  (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
    if (self.item === null) return;
    if (activator === null || activator.client === null) return;

    const index = self.item.id;
    if (activator.client.pers.inventory[index] === 0) {
      if (level.time < self.touch_debounce_time) return;
      self.touch_debounce_time = Gtime_add(level.time, Gtime_from_sec(5));
      giLocCenterPrint(activator, "$g_you_need", self.item.pickup_name_definite ?? "");
      gi.sound(activator, SoundchanT.CHAN_AUTO, gi.soundindex("misc/keytry.wav"), 1, ATTN_NORM, 0);
      return;
    }

    gi.sound(activator, SoundchanT.CHAN_AUTO, gi.soundindex("misc/keyuse.wav"), 1, ATTN_NORM, 0);
    if (coopEnabled()) {
      if (self.item.id === ItemIdT.IT_KEY_POWER_CUBE || self.item.id === ItemIdT.IT_KEY_EXPLOSIVE_CHARGES) {
        let cube = 0;
        for (cube = 0; cube < 8; cube++) {
          if ((activator.client.pers.power_cubes & (1 << cube)) !== 0) break;
        }
        for (let player = 1; player <= game.maxclients; player++) {
          const ent = g_edicts[player];
          if (ent === undefined || !ent.inuse || ent.client === null) continue;
          if ((ent.client.pers.power_cubes & (1 << cube)) !== 0) {
            ent.client.pers.inventory[index]--;
            ent.client.pers.power_cubes &= ~(1 << cube);
            // [Paril-KEX] don't allow respawning players to keep used keys
            if (!P_UseCoopInstancedItems()) {
              ent.client.resp.coop_respawn.inventory[index] = 0;
              ent.client.resp.coop_respawn.power_cubes &= ~(1 << cube);
            }
          }
        }
      } else {
        for (let player = 1; player <= game.maxclients; player++) {
          const ent = g_edicts[player];
          if (ent === undefined || !ent.inuse || ent.client === null) continue;
          ent.client.pers.inventory[index] = 0;

          // [Paril-KEX] don't allow respawning players to keep used keys
          if (!P_UseCoopInstancedItems()) {
            ent.client.resp.coop_respawn.inventory[index] = 0;
          }
        }
      }
    } else {
      activator.client.pers.inventory[index]--;
    }

    G_UseTargets(self, activator);

    self.use = null;
  },
);

/** g_trigger.cpp:368-393: `void SP_trigger_key(edict_t *self)`. */
export function SP_trigger_key(self: EdictT): void {
  if (st.item === null) {
    gi.Com_Print(`${self.classname ?? "?"}: no key item\n`);
    return;
  }
  self.item = FindItemByClassname(st.item);

  if (self.item === null) {
    gi.Com_Print(`${self.classname ?? "?"}: item ${st.item} not found\n`);
    return;
  }

  if (self.target === null) {
    gi.Com_Print(`${self.classname ?? "?"}: no target\n`);
    return;
  }

  gi.soundindex("misc/keytry.wav");
  gi.soundindex("misc/keyuse.wav");

  self.use = trigger_key_use;
}

// ---------------------------------------------------------------------------
// trigger_counter
// ---------------------------------------------------------------------------

const SPAWNFLAG_COUNTER_NOMESSAGE: SpawnFlags = SpawnFlags_from(1);

/** g_trigger.cpp:413-437: `USE(trigger_counter_use)`. */
export const trigger_counter_use: UseFn = RegisterUse(
  "trigger_counter_use",
  (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
    if (self.count === 0) return;

    self.count--;

    if (self.count !== 0) {
      if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_COUNTER_NOMESSAGE)) {
        giLocCenterPrint(activator, "$g_more_to_go", self.count);
        gi.sound(activator, SoundchanT.CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
      }
      return;
    }

    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_COUNTER_NOMESSAGE)) {
      giLocCenterPrint(activator, "$g_sequence_completed");
      gi.sound(activator, SoundchanT.CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
    }
    self.activator = activator;
    multi_trigger(self);
  },
);

/** g_trigger.cpp:439-446: `void SP_trigger_counter(edict_t *self)`. */
export function SP_trigger_counter(self: EdictT): void {
  self.wait = -1;
  if (self.count === 0) self.count = 2;

  self.use = trigger_counter_use;
}

// ---------------------------------------------------------------------------
// trigger_always
// ---------------------------------------------------------------------------

/** g_trigger.cpp:459-465: `void SP_trigger_always(edict_t *ent)`. */
export function SP_trigger_always(ent: EdictT): void {
  // we must have some delay to make sure our use targets are present
  if (ent.delay === 0) ent.delay = 0.2;
  G_UseTargets(ent, ent);
}

// ---------------------------------------------------------------------------
// trigger_push
// ---------------------------------------------------------------------------

const SPAWNFLAG_PUSH_ONCE: SpawnFlags = SpawnFlags_from(0x01);
const SPAWNFLAG_PUSH_PLUS: SpawnFlags = SpawnFlags_from(0x02);
const SPAWNFLAG_PUSH_SILENT: SpawnFlags = SpawnFlags_from(0x04);
const SPAWNFLAG_PUSH_START_OFF: SpawnFlags = SpawnFlags_from(0x08);
const SPAWNFLAG_PUSH_CLIP: SpawnFlags = SpawnFlags_from(0x10);

/** `static cached_soundindex windsound;` -- module-level, see file header. */
const windsound = { index: 0 };
function windsoundAssign(name: string): void {
  windsound.index = gi.soundindex(name);
}

/** g_trigger.cpp:485-520: `TOUCH(trigger_push_touch)`. */
export const trigger_push_touch: TouchFn = RegisterTouch(
  "trigger_push_touch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_CLIP)) {
      const clip = gi.clip(self, other.s.origin, other.mins, other.maxs, other.s.origin, G_GetClipMask(other));
      if (clip.fraction === 1.0) return;
    }

    if (other.classname === "grenade") {
      other.velocity = vec3_muls(self.movedir, self.speed * 10);
    } else if (other.health > 0) {
      other.velocity = vec3_muls(self.movedir, self.speed * 10);

      if (other.client !== null) {
        // don't take falling damage immediately from this
        other.client.oldvelocity = other.velocity;
        other.client.oldgroundentity = other.groundentity;
        if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_SILENT) && self.fly_sound_debounce_time < level.time) {
          self.fly_sound_debounce_time = Gtime_add(level.time, Gtime_from_ms(1500));
          gi.sound(other, SoundchanT.CHAN_AUTO, windsound.index, 1, ATTN_NORM, 0);
        }
      }
    }

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_ONCE)) G_FreeEdict(self);
  },
);

/** g_trigger.cpp:524-531: `USE(trigger_push_use)`. */
export const trigger_push_use: UseFn = RegisterUse("trigger_push_use", (self: EdictT): void => {
  self.solid = self.solid === SolidT.SOLID_NOT ? SolidT.SOLID_TRIGGER : SolidT.SOLID_NOT;
  gi.linkentity(self);
});

/** g_trigger.cpp:538-556: `void trigger_effect(edict_t *self)`. */
export function trigger_effect(self: EdictT): void {
  let origin = vec3_muls(vec3(self.absmin[0] + self.absmax[0], self.absmin[1] + self.absmax[1], self.absmin[2] + self.absmax[2]), 0.5);

  for (let i = 0; i < 10; i++) {
    origin = vec3(origin[0], origin[1], origin[2] + self.speed * 0.01 * (i + frandom()));
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_TUNNEL_SPARKS);
    gi.WriteByte(1);
    gi.WritePosition(origin);
    gi.WriteDir(vec3_origin);
    gi.WriteByte(irandom(0x74, 0x7c));
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
  }
}

/** g_trigger.cpp:558-571: `THINK(trigger_push_inactive)`. */
export const trigger_push_inactive: ThinkFn = RegisterThink("trigger_push_inactive", (self: EdictT): void => {
  if (self.delay > Gtime_seconds(level.time)) {
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
  } else {
    self.touch = trigger_push_touch;
    self.think = trigger_push_active;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    self.delay = Gtime_seconds(Gtime_add(self.nextthink, Gtime_from_sec(self.wait)));
  }
});

/** g_trigger.cpp:573-587: `THINK(trigger_push_active)`. */
export const trigger_push_active: ThinkFn = RegisterThink("trigger_push_active", (self: EdictT): void => {
  if (self.delay > Gtime_seconds(level.time)) {
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    trigger_effect(self);
  } else {
    self.touch = null;
    self.think = trigger_push_inactive;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    self.delay = Gtime_seconds(Gtime_add(self.nextthink, Gtime_from_sec(self.wait)));
  }
});

/** g_trigger.cpp:600-643: `void SP_trigger_push(edict_t *self)`. */
export function SP_trigger_push(self: EdictT): void {
  InitTrigger(self);
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_SILENT)) windsoundAssign("misc/windfly.wav");
  self.touch = trigger_push_touch;

  // RAFAEL
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_PLUS)) {
    if (self.wait === 0) self.wait = 10;

    self.think = trigger_push_active;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    self.delay = Gtime_seconds(Gtime_add(self.nextthink, Gtime_from_sec(self.wait)));
  }

  if (self.speed === 0) self.speed = 1000;

  // PGM
  if (self.targetname !== null) {
    // toggleable
    self.use = trigger_push_use;
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_START_OFF)) self.solid = SolidT.SOLID_NOT;
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_START_OFF)) {
    gi.Com_Print("trigger_push is START_OFF but not targeted.\n");
    self.svflags = SvflagsT.SVF_NONE;
    self.touch = null;
    self.solid = SolidT.SOLID_BSP;
    self.movetype = MovetypeT.MOVETYPE_PUSH;
  }

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_PUSH_CLIP)) self.svflags |= SvflagsT.SVF_HULL;
}

// ---------------------------------------------------------------------------
// trigger_hurt
// ---------------------------------------------------------------------------

const SPAWNFLAG_HURT_START_OFF: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_HURT_TOGGLE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_HURT_SILENT: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_HURT_NO_PROTECTION: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_HURT_SLOW: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_HURT_NO_PLAYERS: SpawnFlags = SpawnFlags_from(32);
const SPAWNFLAG_HURT_NO_MONSTERS: SpawnFlags = SpawnFlags_from(64);
const SPAWNFLAG_HURT_CLIPPED: SpawnFlags = SpawnFlags_from(128);

/** g_trigger.cpp:675-685: `USE(hurt_use)`. */
export const hurt_use: UseFn = RegisterUse("hurt_use", (self: EdictT): void => {
  self.solid = self.solid === SolidT.SOLID_NOT ? SolidT.SOLID_TRIGGER : SolidT.SOLID_NOT;
  gi.linkentity(self);

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_TOGGLE)) self.use = null;
});

/** g_trigger.cpp:687-731: `TOUCH(hurt_touch)`. */
export const hurt_touch: TouchFn = RegisterTouch(
  "hurt_touch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (!other.takedamage) return;
    else if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && (other.flags & EntFlagsT.FL_DAMAGEABLE) === 0n && other.client === null && other.classname !== "misc_explobox") return;
    else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_NO_MONSTERS) && (other.svflags & SvflagsT.SVF_MONSTER) !== 0) return;
    else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_NO_PLAYERS) && other.client !== null) return;

    if (self.timestamp > level.time) return;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_CLIPPED)) {
      const clip = gi.clip(self, other.s.origin, other.mins, other.maxs, other.s.origin, G_GetClipMask(other));
      if (clip.fraction === 1.0) return;
    }

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_SLOW)) self.timestamp = Gtime_add(level.time, Gtime_from_sec(1));
    else self.timestamp = Gtime_add(level.time, Gtime_from_ms(100)); // 10_hz

    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_SILENT)) {
      if (self.fly_sound_debounce_time < level.time) {
        gi.sound(other, SoundchanT.CHAN_AUTO, self.noise_index, 1, ATTN_NORM, 0);
        self.fly_sound_debounce_time = Gtime_add(level.time, Gtime_from_sec(1));
      }
    }

    const dflags: DamageflagsT = SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_NO_PROTECTION) ? DamageflagsT.DAMAGE_NO_PROTECTION : DamageflagsT.DAMAGE_NONE;

    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, self.dmg, dflags, modFromId(ModIdT.MOD_TRIGGER_HURT));
  },
);

/** g_trigger.cpp:733-755: `void SP_trigger_hurt(edict_t *self)`. */
export function SP_trigger_hurt(self: EdictT): void {
  InitTrigger(self);

  self.noise_index = gi.soundindex("world/electro.wav");
  self.touch = hurt_touch;

  if (self.dmg === 0) self.dmg = 5;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_START_OFF)) self.solid = SolidT.SOLID_NOT;
  else self.solid = SolidT.SOLID_TRIGGER;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_TOGGLE)) self.use = hurt_use;

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_HURT_CLIPPED)) self.svflags |= SvflagsT.SVF_HULL;
}

// ---------------------------------------------------------------------------
// trigger_gravity
// ---------------------------------------------------------------------------

const SPAWNFLAG_GRAVITY_TOGGLE: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_GRAVITY_START_OFF: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_GRAVITY_CLIPPED: SpawnFlags = SpawnFlags_from(4);

/** g_trigger.cpp:778-785: `USE(trigger_gravity_use)`. */
export const trigger_gravity_use: UseFn = RegisterUse("trigger_gravity_use", (self: EdictT): void => {
  self.solid = self.solid === SolidT.SOLID_NOT ? SolidT.SOLID_TRIGGER : SolidT.SOLID_NOT;
  gi.linkentity(self);
});

/** g_trigger.cpp:788-799: `TOUCH(trigger_gravity_touch)`. */
export const trigger_gravity_touch: TouchFn = RegisterTouch(
  "trigger_gravity_touch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GRAVITY_CLIPPED)) {
      const clip = gi.clip(self, other.s.origin, other.mins, other.maxs, other.s.origin, G_GetClipMask(other));
      if (clip.fraction === 1.0) return;
    }

    other.gravity = self.gravity;
  },
);

/** g_trigger.cpp:801-831: `void SP_trigger_gravity(edict_t *self)`. */
export function SP_trigger_gravity(self: EdictT): void {
  if (st.gravity === null || st.gravity === "") {
    gi.Com_Print(`${self.classname ?? "?"}: no gravity set\n`);
    G_FreeEdict(self);
    return;
  }

  InitTrigger(self);

  // PGM
  self.gravity = Number(st.gravity);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GRAVITY_TOGGLE)) self.use = trigger_gravity_use;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GRAVITY_START_OFF)) {
    self.use = trigger_gravity_use;
    self.solid = SolidT.SOLID_NOT;
  }

  self.touch = trigger_gravity_touch;
  // PGM

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_GRAVITY_CLIPPED)) self.svflags |= SvflagsT.SVF_HULL;
}

// ---------------------------------------------------------------------------
// trigger_monsterjump
// ---------------------------------------------------------------------------

const SPAWNFLAG_MONSTERJUMP_TOGGLE: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_MONSTERJUMP_START_OFF: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_MONSTERJUMP_CLIPPED: SpawnFlags = SpawnFlags_from(4);

/** g_trigger.cpp:854-861: `USE(trigger_monsterjump_use)`. */
export const trigger_monsterjump_use: UseFn = RegisterUse("trigger_monsterjump_use", (self: EdictT): void => {
  self.solid = self.solid === SolidT.SOLID_NOT ? SolidT.SOLID_TRIGGER : SolidT.SOLID_NOT;
  gi.linkentity(self);
});

/** g_trigger.cpp:863-889: `TOUCH(trigger_monsterjump_touch)`. */
export const trigger_monsterjump_touch: TouchFn = RegisterTouch(
  "trigger_monsterjump_touch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if ((other.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) !== 0n) return;
    if ((other.svflags & SvflagsT.SVF_DEADMONSTER) !== 0) return;
    if ((other.svflags & SvflagsT.SVF_MONSTER) === 0) return;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTERJUMP_CLIPPED)) {
      const clip = gi.clip(self, other.s.origin, other.mins, other.maxs, other.s.origin, G_GetClipMask(other));
      if (clip.fraction === 1.0) return;
    }

    // set XY even if not on ground, so the jump will clear lips
    other.velocity = vec3(self.movedir[0] * self.speed, self.movedir[1] * self.speed, other.velocity[2]);

    if (other.groundentity === null) return;

    other.groundentity = null;
    other.velocity = vec3(other.velocity[0], other.velocity[1], self.movedir[2]);
  },
);

/** g_trigger.cpp:891-916: `void SP_trigger_monsterjump(edict_t *self)`. */
export function SP_trigger_monsterjump(self: EdictT): void {
  if (self.speed === 0) self.speed = 200;
  if (st.height === 0) st.height = 200;
  if (self.s.angles[1] === 0) self.s.angles = vec3(self.s.angles[0], 360, self.s.angles[2]); // YAW
  InitTrigger(self);
  self.touch = trigger_monsterjump_touch;
  self.movedir = vec3(self.movedir[0], self.movedir[1], st.height);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTERJUMP_TOGGLE)) self.use = trigger_monsterjump_use;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTERJUMP_START_OFF)) {
    self.use = trigger_monsterjump_use;
    self.solid = SolidT.SOLID_NOT;
  }

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTERJUMP_CLIPPED)) self.svflags |= SvflagsT.SVF_HULL;
}

// ---------------------------------------------------------------------------
// trigger_flashlight
// ---------------------------------------------------------------------------

const SPAWNFLAG_FLASHLIGHT_CLIPPED: SpawnFlags = SpawnFlags_from(1);

/** g_trigger.cpp:934-960: `TOUCH(trigger_flashlight_touch)`. */
export const trigger_flashlight_touch: TouchFn = RegisterTouch(
  "trigger_flashlight_touch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (other.client === null) return;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FLASHLIGHT_CLIPPED)) {
      const clip = gi.clip(self, other.s.origin, other.mins, other.maxs, other.s.origin, G_GetClipMask(other));
      if (clip.fraction === 1.0) return;
    }

    if (self.style === 1) {
      P_ToggleFlashlight(other, true);
    } else if (self.style === 2) {
      P_ToggleFlashlight(other, false);
    } else {
      const lenSq = other.velocity[0] * other.velocity[0] + other.velocity[1] * other.velocity[1] + other.velocity[2] * other.velocity[2];
      if (lenSq > 32) {
        const forward = vec3_normalized(other.velocity);
        P_ToggleFlashlight(other, vec3_dot(forward, self.movedir) > 0);
      }
    }
  },
);

/** g_trigger.cpp:962-973: `void SP_trigger_flashlight(edict_t *self)`. */
export function SP_trigger_flashlight(self: EdictT): void {
  if (self.s.angles[1] === 0) self.s.angles = vec3(self.s.angles[0], 360, self.s.angles[2]); // YAW
  InitTrigger(self);
  self.touch = trigger_flashlight_touch;
  self.movedir = vec3(self.movedir[0], self.movedir[1], st.height);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FLASHLIGHT_CLIPPED)) self.svflags |= SvflagsT.SVF_HULL;
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// trigger_fog
// ---------------------------------------------------------------------------

const SPAWNFLAG_FOG_AFFECT_FOG: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_FOG_AFFECT_HEIGHTFOG: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_FOG_INSTANTANEOUS: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_FOG_FORCE: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_FOG_BLEND: SpawnFlags = SpawnFlags_from(16);

/** g_utils.ts's own `G_PickTarget` -- imported below near the end of the file. */

/** g_trigger.cpp:1022-1168: `TOUCH(trigger_fog_touch)`. */
export const trigger_fog_touch: TouchFn = RegisterTouch(
  "trigger_fog_touch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (other.client === null) return;
    if (self.timestamp > level.time) return;

    self.timestamp = Gtime_add(level.time, Gtime_from_sec(self.wait));

    const fog_value_storage = self.movetarget !== null ? self.movetarget : self;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_INSTANTANEOUS)) other.client.pers.fog_transition_time = GTIME_ZERO;
    else other.client.pers.fog_transition_time = Gtime_from_sec(fog_value_storage.delay);

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_BLEND)) {
      const center = vec3_muls(vec3(self.absmin[0] + self.absmax[0], self.absmin[1] + self.absmax[1], self.absmin[2] + self.absmax[2]), 0.5);
      const half_size = vec3(
        (self.size[0] + other.size[0]) * 0.5,
        (self.size[1] + other.size[1]) * 0.5,
        (self.size[2] + other.size[2]) * 0.5,
      );
      const start = vec3_scale(vec3_negate(self.movedir), half_size);
      const end = vec3_scale(self.movedir, half_size);
      const player_dist = vec3_scale(vec3_sub(other.s.origin, center), vec3(Math.abs(self.movedir[0]), Math.abs(self.movedir[1]), Math.abs(self.movedir[2])));

      let dist = Math.hypot(player_dist[0] - start[0], player_dist[1] - start[1], player_dist[2] - start[2]);
      dist /= Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]);
      dist = clamp(dist, 0, 1);

      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_AFFECT_FOG)) {
        other.client.pers.wanted_fog = [
          lerpN(fog_value_storage.fog.density_off, fog_value_storage.fog.density, dist),
          lerpN(fog_value_storage.fog.color_off[0], fog_value_storage.fog.color[0], dist),
          lerpN(fog_value_storage.fog.color_off[1], fog_value_storage.fog.color[1], dist),
          lerpN(fog_value_storage.fog.color_off[2], fog_value_storage.fog.color[2], dist),
          lerpN(fog_value_storage.fog.sky_factor_off, fog_value_storage.fog.sky_factor, dist),
        ];
      }

      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_AFFECT_HEIGHTFOG)) {
        const hf = fog_value_storage.heightfog;
        other.client.pers.wanted_heightfog = {
          start: [
            lerpN(hf.start_color_off[0], hf.start_color[0], dist),
            lerpN(hf.start_color_off[1], hf.start_color[1], dist),
            lerpN(hf.start_color_off[2], hf.start_color[2], dist),
            lerpN(hf.start_dist_off, hf.start_dist, dist),
          ],
          end: [
            lerpN(hf.end_color_off[0], hf.end_color[0], dist),
            lerpN(hf.end_color_off[1], hf.end_color[1], dist),
            lerpN(hf.end_color_off[2], hf.end_color[2], dist),
            lerpN(hf.end_dist_off, hf.end_dist, dist),
          ],
          falloff: lerpN(hf.falloff_off, hf.falloff, dist),
          density: lerpN(hf.density_off, hf.density, dist),
        };
      }

      return;
    }

    let use_on = true;

    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_FORCE)) {
      const { vec: forward, len } = vec3_normalized_len(other.velocity);

      // not moving enough to trip; this is so we don't trip
      // the wrong direction when on an elevator, etc.
      if (len <= 0.0001) return;

      use_on = vec3_dot(forward, self.movedir) > 0;
    }

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_AFFECT_FOG)) {
      const f = fog_value_storage.fog;
      other.client.pers.wanted_fog = use_on
        ? [f.density, f.color[0], f.color[1], f.color[2], f.sky_factor]
        : [f.density_off, f.color_off[0], f.color_off[1], f.color_off[2], f.sky_factor_off];
    }

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_AFFECT_HEIGHTFOG)) {
      const hf = fog_value_storage.heightfog;
      other.client.pers.wanted_heightfog = use_on
        ? { start: [hf.start_color[0], hf.start_color[1], hf.start_color[2], hf.start_dist], end: [hf.end_color[0], hf.end_color[1], hf.end_color[2], hf.end_dist], falloff: hf.falloff, density: hf.density }
        : {
            start: [hf.start_color_off[0], hf.start_color_off[1], hf.start_color_off[2], hf.start_dist_off],
            end: [hf.end_color_off[0], hf.end_color_off[1], hf.end_color_off[2], hf.end_dist_off],
            falloff: hf.falloff_off,
            density: hf.density_off,
          };
    }
  },
);

function lerpN(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** g_trigger.cpp:1170-1195: `void SP_trigger_fog(edict_t *self)`. */
export function SP_trigger_fog(self: EdictT): void {
  if (self.s.angles[1] === 0) self.s.angles = vec3(self.s.angles[0], 360, self.s.angles[2]); // YAW

  InitTrigger(self);

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_AFFECT_FOG) && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_FOG_AFFECT_HEIGHTFOG)) {
    gi.Com_Print(`WARNING: ${self.classname ?? "?"} with no fog spawnflags set\n`);
  }

  if (self.target !== null) {
    self.movetarget = G_PickTarget(self.target);

    if (self.movetarget !== null) {
      if (self.movetarget.delay === 0) self.movetarget.delay = 0.5;
    }
  }

  if (self.delay === 0) self.delay = 0.5;

  self.touch = trigger_fog_touch;
}

// ---------------------------------------------------------------------------
// trigger_coop_relay
// ---------------------------------------------------------------------------

const SPAWNFLAG_COOP_RELAY_AUTO_FIRE: SpawnFlags = SpawnFlags_from(1);

/** g_trigger.cpp:1212-1216: `inline bool trigger_coop_relay_filter(edict_t *player)`. */
function trigger_coop_relay_filter(player: EdictT): boolean {
  return (
    player.health <= 0 ||
    player.deadflag ||
    player.movetype === MovetypeT.MOVETYPE_NOCLIP ||
    (player.client !== null && player.client.resp.spectator) ||
    player.s.modelindex !== MODELINDEX_PLAYER
  );
}

/** g_trigger.cpp:1218-1243: `static bool trigger_coop_relay_can_use(...)`. */
function trigger_coop_relay_can_use(self: EdictT, activator: EdictT | null): boolean {
  // not coop, so act like a standard trigger_relay minus the message
  if (!coopEnabled()) return true;

  // coop; scan for all alive players, print appropriate message
  // to those in/out of range
  let can_use = true;

  for (const player of active_players()) {
    // dead or spectator, don't count them
    if (trigger_coop_relay_filter(player)) continue;

    if (boxes_intersect(player.absmin, player.absmax, self.absmin, self.absmax)) continue;

    if (self.timestamp < level.time) giLocCenterPrint(player, self.map ?? "");
    can_use = false;
  }

  return can_use;
}

/** g_trigger.cpp:1245-1260: `USE(trigger_coop_relay_use)`. */
export const trigger_coop_relay_use: UseFn = RegisterUse(
  "trigger_coop_relay_use",
  (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
    if (!trigger_coop_relay_can_use(self, activator)) {
      if (self.timestamp < level.time) giLocCenterPrint(activator, self.message ?? "");

      self.timestamp = Gtime_add(level.time, Gtime_from_sec(5));
      return;
    }

    const msg = self.message;
    self.message = null;
    G_UseTargets(self, activator);
    self.message = msg;
  },
);

/** g_trigger.cpp:1262-1270: `static BoxEdictsResult_t trigger_coop_relay_player_filter(...)`. */
function trigger_coop_relay_player_filter(raw: KexEdictT | null): BoxEdictsResultT {
  if (raw === null) return BoxEdictsResultT.Skip;
  const ent = traceEdict(raw);
  if (ent.client === null) return BoxEdictsResultT.Skip;
  else if (trigger_coop_relay_filter(ent)) return BoxEdictsResultT.Skip;
  return BoxEdictsResultT.Keep;
}

/** g_trigger.cpp:1272-1306: `THINK(trigger_coop_relay_think)`. */
export const trigger_coop_relay_think: ThinkFn = RegisterThink("trigger_coop_relay_think", (self: EdictT): void => {
  let num_active = 0;
  for (const player of active_players()) {
    if (!trigger_coop_relay_filter(player)) num_active++;
  }

  const players: (KexEdictT | null)[] = new Array(num_active).fill(null);
  const n = gi.BoxEdicts(self.absmin, self.absmax, players, num_active, SolidityAreaT.AREA_SOLID, trigger_coop_relay_player_filter, null);

  if (n === num_active) {
    const msg = self.message;
    self.message = null;
    G_UseTargets(self, g_edicts[1]);
    self.message = msg;

    G_FreeEdict(self);
    return;
  } else if (n !== 0 && self.timestamp < level.time) {
    const hit: EdictT[] = [];
    for (let i = 0; i < n; i++) {
      const raw = players[i];
      if (raw !== null && raw !== undefined) hit.push(traceEdict(raw));
    }
    for (const p of hit) giLocCenterPrint(p, self.message ?? "");

    for (const player of active_players()) {
      if (!hit.includes(player)) giLocCenterPrint(player, self.map ?? "");
    }

    self.timestamp = Gtime_add(level.time, Gtime_from_sec(5));
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
});

/** g_trigger.cpp:1308-1333: `void SP_trigger_coop_relay(edict_t *self)`. */
export function SP_trigger_coop_relay(self: EdictT): void {
  if (self.targetname !== null && SpawnFlags_has(self.spawnflags, SPAWNFLAG_COOP_RELAY_AUTO_FIRE)) {
    gi.Com_Print(`${self.classname ?? "?"}: targetname and auto-fire are mutually exclusive\n`);
  }

  InitTrigger(self);

  if (self.message === null) self.message = "$g_coop_wait_for_players";
  if (self.map === null) self.map = "$g_coop_players_waiting_for_you";
  if (self.wait === 0) self.wait = 1;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_COOP_RELAY_AUTO_FIRE)) {
    self.think = trigger_coop_relay_think;
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
  } else {
    self.use = trigger_coop_relay_use;
  }
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  gi.linkentity(self);
}
