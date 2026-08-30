// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_newdm.c -- the ROGUE mission pack's new-deathmatch-rules additions
// (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_newdm.cpp (359
// lines, C++17): `DoRandomRespawn`/`FindSubstituteItem`/
// `GetSubstituteItemFlags` (random-item-on-respawn deathmatch rule),
// `PrecacheForRandomRespawn`, the "doppleganger" fake-player decoy (spawn,
// pain/die/timeout, idle body animation), and `InitGameRules` (the
// `gamerules` cvar's dispatch switch, wiring `RDM_TAG`/`RDM_DEATHBALL` onto
// this port's sibling `./rogue_dm_tag.ts`/`./rogue_dm_ball.ts` modules).
//
// ============================================================================
// STUB SWAP: g_items.ts's `DoRandomRespawn`
// ============================================================================
// g_items.ts carries a local unexported throwing stub `DoRandomRespawn`
// cited to this file. See g_items.ts's own updated header: the stub is
// deleted and `DoRespawn`'s `g_dm_random_items`-guarded call site now
// imports the real function from here.
//
// ============================================================================
// NOT SWAPPED (out of this unit's edit scope) -- reported to the coordinator
// ============================================================================
// - g_spawn.ts carries a SEPARATE local unexported throwing stub, also
//   named `DoRandomRespawn`, also cited to this file (g_spawn.ts:979,
//   called from `DoRespawn`'s own g_spawn.ts copy at line 1234).
//   g_spawn.ts is off-limits to this unit (brief: "do NOT edit
//   src/kexgame/g_spawn.ts") -- reported here so the coordinator can swap
//   g_spawn.ts's copy for an import from here, matching g_items.ts's swap.
// - g_spawn.ts also carries `PrecacheForRandomRespawn` as a local throwing
//   stub (g_spawn.ts:1420), cited to this file. Same story: reported, not
//   edited. `PrecacheForRandomRespawn` is exported below, real.
// - g_main.ts's `InitGameRules` (g_main.cpp:557's `if (cvarTrue(gamerules))
//   InitGameRules();` call site) is ALSO a local throwing stub
//   (g_main.ts:566-571), cited generically to "ROGUE mission pack, no
//   src/kexgame/ home" -- now that this file IS that home, the stub could
//   be swapped for a real import. However: g_main.ts is off-limits to this
//   unit, AND swapping it is a genuine ARCHITECTURAL decision the
//   coordinator should rule on, not something this unit should silently
//   opt into -- g_combat.ts, g_spawn.ts, and p_client.ts each independently
//   established a deliberate "`DMGame` stays a local, all-null `DmGameRt`,
//   because `gamerules` sits at its registered default of 0 everywhere"
//   precedent (see each file's own "DMGame -- concrete faithful value, not
//   a stub" header note). Wiring g_main.ts's `InitGameRules` to this file's
//   real one would make `gamerules` nonzero actually populate a real
//   `DMGame` for the first time in this port line -- a behavior change
//   those three files' authors evidently chose NOT to make. This file
//   exports a real, working `InitGameRules` (below) so that swap is
//   possible whenever the coordinator decides it's wanted, but does not
//   perform it.
//
// ============================================================================
// STUBS THIS FILE OWNS (throwing, cited to their real C++ home)
// ============================================================================
// `Sphere_Spawn` (rogue/rogue_sphere.cpp -- not ported anywhere in this port
// line; no `g_rogue_sphere.ts` exists yet) is called by `doppleganger_die`'s
// enemy-in-range branch to spawn a Hunter/Vengeance sphere. Left as a
// throwing stub cited to its real file; `doppleganger_die` itself is real
// (matches g_items.ts's own "small cross-file functions ported here for
// real, deps that stay stubs" precedent for `Defender_Launch`/
// `Hunter_Launch`/`Vengeance_Launch`).
//
// ============================================================================
// LOCAL COPIES (not shared, per this port line's established idiom)
// ============================================================================
// - `anglemod` (q_std.h, fmod-based): g_misc.ts's/m_move.ts's own identical
//   local copy note applies verbatim here -- q_std.ts explicitly does not
//   own this function; every file that needs it carries its own copy.
// - `frameTimeAsGtime()`: g_misc.ts's own identical workaround for
//   `FRAME_TIME_MS` (a `g_local.h` extern set once in a not-yet-ported
//   `InitGame`, so not available as a real global here either) -- reads
//   `gi.frame_time_ms` per-call instead, matching g_phys.ts's/
//   g_monster.ts's/g_misc.ts's own precedent.
//
// ============================================================================
// QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `blocked_checkjump`-adjacent code aside, `FindSubstituteItem`'s
//   ordering matters: flags/tag/adrenaline/health/armor special cases are
//   each checked BEFORE the generic same-item-class scan, and the generic
//   scan is a full O(IT_TOTAL) linear scan every call (no caching) --
//   preserved exactly, including re-deriving `GetSubstituteItemFlags` a
//   second time inside the scan loop (once for `myflags`, once per
//   candidate `i`) rather than hoisting `myflags` out.
// - `doppleganger_die`'s sphere-spawn branch calls `sphere->pain(sphere,
//   attacker, 0, 0, mod)` directly (not through any generic damage/pain
//   dispatch) -- ported as a direct call to `sphere.pain`, guarded by a
//   null check only because this port's `pain` field is nullable (the
//   C++ source dereferences it unconditionally, matching every other
//   `->pain(...)` call site already established as "throw, don't
//   silently narrow" -- but `Sphere_Spawn` always throws first, so this
//   line is unreachable either way today).
// - `fire_doppleganger`'s `body->s = ent->s;` is a full C++ struct-value
//   copy (vec3_t fields copy BY VALUE in C++). This port's `Vec3` is a
//   mutable `Float32Array`, so a shallow `{...ent.s}` spread would alias
//   `origin`/`angles`/`old_origin` between `ent` and `body` -- ported as
//   an explicit field-by-field copy (`copyEntityState`, this file's own
//   local helper) that clones those three vector fields fresh, to match
//   C++ value semantics exactly rather than introduce a reference-aliasing
//   bug the original code never had.

import { type Vec3, vec3, VectorCopy } from "../../shared/math";
import { YAW } from "../../shared/q_shared";
import { SolidT, SoundchanT, ATTN_NORM, KexEntityEventT, RenderfxT, CvarFlagsT } from "../../kexapi/game";
import { type EdictT, ItemIdT, ItemFlagsT, ModIdT, MovetypeT, EntFlagsT, SPHERE_HUNTER, SPHERE_VENGEANCE, SPHERE_DOPPLEGANGER } from "../g_local";
import type { ModT, DmGameRt } from "../g_local_types";
import { gi, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_hz, Gtime_from_ms, type GTime } from "../gtime";
import { RegisterThink, RegisterPain, RegisterDie, type ThinkFn, type PainFn, type DieFn } from "../g_save_registry";
import { AngleVectors, vectoangles, vec3_sub, vec3_length } from "../q_vec3";
import { G_Spawn } from "../g_utils";
import { GetItemByIndex, PrecacheItem } from "../g_items";
import { T_RadiusDamage } from "../g_combat";
import { BecomeExplosion1 } from "../g_misc";
import { SpawnFlags_or, type SpawnFlags } from "../spawnflags";
import { irandom, frandom } from "../q_std";
import { M_ChangeYaw } from "../m_move";
// FRAME_stand01/FRAME_stand40 (m_boss31.h frame indices, 112/151) -- local
// numeric duplicates, NOT an import from "../m_boss31": that file is a full
// monster module with its own top-level frame-table construction reading
// g_ai.ts's `export const ai_stand`/etc at module-evaluation time, and a
// static edge into it from here (reached from g_items.ts's real import of
// this file) risks the same `ReferenceError: Cannot access 'ai_stand'
// before initialization` load-order hazard documented in
// rogue/g_rogue_newai.ts's own "IMPORT CYCLE" header note -- caught by
// running `bun test`, not `tsc`. These two are plain frame-index integers,
// never reassigned in m_boss31.ts, so duplicating the two numbers is
// zero-risk (unlike duplicating behavior).
const FRAME_stand01 = 112;
const FRAME_stand40 = 151;
import { Tag_GameInit, Tag_PostInitSetup, Tag_PlayerDeath, Tag_Score, Tag_PlayerEffects, Tag_DogTag, Tag_PlayerDisconnect, Tag_ChangeDamage } from "./rogue_dm_tag";
import {
  DBall_GameInit,
  DBall_ClientBegin,
  DBall_SelectSpawnPoint,
  DBall_PostInitSetup,
  DBall_CheckDMRules,
  DBall_ChangeKnockback,
  DBall_ChangeDamage,
} from "./rogue_dm_ball";

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

/** q_std.h:185 -- kex's OWN anglemod (fmod-based). See file header's
 *  "LOCAL COPIES" note. */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** See file header's "LOCAL COPIES" note. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };

/** rogue/g_rogue_sphere.cpp:684-ish -- `edict_t *Sphere_Spawn(edict_t
 *  *owner, spawnflags_t spawnflags)`. See file header's "STUBS THIS FILE
 *  OWNS" note. */
function Sphere_Spawn(_owner: EdictT, _spawnflags: SpawnFlags): EdictT {
  throw new Error("Sphere_Spawn: not yet ported (pending g_rogue_sphere.ts, see rogue/rogue_sphere.cpp)");
}

// ---------------------------------------------------------------------------
// DoRandomRespawn / FindSubstituteItem / GetSubstituteItemFlags
// (rogue/g_rogue_newdm.cpp:21-139)
// ---------------------------------------------------------------------------

const IF_TYPE_MASK: ItemFlagsT = ItemFlagsT.IF_WEAPON | ItemFlagsT.IF_AMMO | ItemFlagsT.IF_POWERUP | ItemFlagsT.IF_ARMOR | ItemFlagsT.IF_KEY;

/** rogue/g_rogue_newdm.cpp:21-35: `inline item_flags_t GetSubstituteItemFlags(item_id_t id)`. */
function GetSubstituteItemFlags(id: ItemIdT): ItemFlagsT {
  const item = GetItemByIndex(id);
  if (item === null) throw new Error(`GetSubstituteItemFlags: GetItemByIndex(${id}) returned null`);

  let flags: ItemFlagsT = item.flags & IF_TYPE_MASK;

  if ((flags & (ItemFlagsT.IF_WEAPON | ItemFlagsT.IF_AMMO)) === (ItemFlagsT.IF_WEAPON | ItemFlagsT.IF_AMMO)) {
    flags = ItemFlagsT.IF_AMMO;
  } else if (id === ItemIdT.IT_ITEM_ADRENALINE || id === ItemIdT.IT_HEALTH_MEGA) {
    flags = ItemFlagsT.IF_POWERUP;
  }

  return flags;
}

/** rogue/g_rogue_newdm.cpp:37-124: `inline item_id_t FindSubstituteItem(edict_t *ent)`. */
function FindSubstituteItem(ent: EdictT): ItemIdT {
  const item = ent.item;
  if (item === null) throw new Error("FindSubstituteItem: called against an entity with no .item set");

  // never replace flags
  if (item.id === ItemIdT.IT_FLAG1 || item.id === ItemIdT.IT_FLAG2 || item.id === ItemIdT.IT_ITEM_TAG_TOKEN) {
    return ItemIdT.IT_NULL;
  }

  // stimpack/shard randomizes
  if (item.id === ItemIdT.IT_HEALTH_SMALL || item.id === ItemIdT.IT_ARMOR_SHARD) {
    return irandom(2) !== 0 ? ItemIdT.IT_HEALTH_SMALL : ItemIdT.IT_ARMOR_SHARD;
  }

  // health is special case
  if (item.id === ItemIdT.IT_HEALTH_MEDIUM || item.id === ItemIdT.IT_HEALTH_LARGE) {
    const rnd = frandom();
    return rnd < 0.6 ? ItemIdT.IT_HEALTH_MEDIUM : ItemIdT.IT_HEALTH_LARGE;
  }

  // armor is also special case
  if (
    item.id === ItemIdT.IT_ARMOR_JACKET ||
    item.id === ItemIdT.IT_ARMOR_COMBAT ||
    item.id === ItemIdT.IT_ARMOR_BODY ||
    item.id === ItemIdT.IT_ITEM_POWER_SCREEN ||
    item.id === ItemIdT.IT_ITEM_POWER_SHIELD
  ) {
    const rnd = frandom();
    if (rnd < 0.4) return ItemIdT.IT_ARMOR_JACKET;
    if (rnd < 0.6) return ItemIdT.IT_ARMOR_COMBAT;
    if (rnd < 0.8) return ItemIdT.IT_ARMOR_BODY;
    if (rnd < 0.9) return ItemIdT.IT_ITEM_POWER_SCREEN;
    return ItemIdT.IT_ITEM_POWER_SHIELD;
  }

  const myflags = GetSubstituteItemFlags(item.id);

  const g_no_spheres = cvarInt("g_no_spheres", "0", CvarFlagsT.CVAR_NOFLAGS) !== 0;
  const g_no_nukes = cvarInt("g_no_nukes", "0", CvarFlagsT.CVAR_NOFLAGS) !== 0;
  const g_no_mines = cvarInt("g_no_mines", "0", CvarFlagsT.CVAR_NOFLAGS) !== 0;

  const possible_items: ItemIdT[] = [];

  // gather matching items
  for (let i = ItemIdT.IT_NULL + 1; i < ItemIdT.IT_TOTAL; i++) {
    const it = GetItemByIndex(i);
    if (it === null) continue;
    let itflags = it.flags;

    if (itflags === 0 || (itflags & (ItemFlagsT.IF_NOT_GIVEABLE | ItemFlagsT.IF_TECH | ItemFlagsT.IF_NOT_RANDOM)) !== 0 || it.pickup === null || it.world_model === null) {
      continue;
    }

    // don't respawn spheres if they're dmflag disabled.
    if (g_no_spheres) {
      if (i === ItemIdT.IT_ITEM_SPHERE_VENGEANCE || i === ItemIdT.IT_ITEM_SPHERE_HUNTER || i === ItemIdT.IT_ITEM_SPHERE_DEFENDER) {
        continue;
      }
    }

    if (g_no_nukes && i === ItemIdT.IT_AMMO_NUKE) continue;

    if (g_no_mines && (i === ItemIdT.IT_AMMO_PROX || i === ItemIdT.IT_AMMO_TESLA || i === ItemIdT.IT_AMMO_TRAP || i === ItemIdT.IT_WEAPON_PROXLAUNCHER)) {
      continue;
    }

    itflags = GetSubstituteItemFlags(i);

    if ((itflags & IF_TYPE_MASK) === (myflags & IF_TYPE_MASK)) possible_items.push(i);
  }

  if (possible_items.length === 0) return ItemIdT.IT_NULL;

  return possible_items[irandom(possible_items.length)];
}

/**
 * rogue/g_rogue_newdm.cpp:126-139: `item_id_t DoRandomRespawn(edict_t
 * *ent)`. See g_items.ts's own "STUB SWAP" header note -- this is the real
 * body g_items.ts's `DoRespawn` (g_dm_random_items-guarded) now imports.
 */
export function DoRandomRespawn(ent: EdictT): ItemIdT {
  if (ent.item === null) return ItemIdT.IT_NULL; // why

  const id = FindSubstituteItem(ent);
  if (id === ItemIdT.IT_NULL) return ItemIdT.IT_NULL;

  return id;
}

/**
 * rogue/g_rogue_newdm.cpp:141-159: `void PrecacheForRandomRespawn()`. See
 * file header's "NOT SWAPPED" note -- g_spawn.ts carries its own separate
 * throwing stub for this, cited here, not edited by this unit.
 */
export function PrecacheForRandomRespawn(): void {
  for (let i = 0; i < ItemIdT.IT_TOTAL; i++) {
    const it = GetItemByIndex(i);
    if (it === null) continue;
    const itflags = it.flags;

    if (itflags === 0 || (itflags & (ItemFlagsT.IF_NOT_GIVEABLE | ItemFlagsT.IF_TECH | ItemFlagsT.IF_NOT_RANDOM)) !== 0 || it.pickup === null || it.world_model === null) {
      continue;
    }

    PrecacheItem(it);
  }
}

// ---------------------------------------------------------------------------
// Doppleganger (rogue/g_rogue_newdm.cpp:161-320)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_newdm.cpp:165-199: `DIE(doppleganger_die)`. */
export const doppleganger_die: DieFn = RegisterDie(
  "doppleganger_die",
  (self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
    if (self.enemy !== null && self.enemy !== self.teammaster) {
      const dir = vec3_sub(self.enemy.s.origin, self.s.origin);
      const dist = vec3_length(dir);

      if (dist > 80) {
        const sphere = dist > 768 ? Sphere_Spawn(self, SpawnFlags_or(SPHERE_HUNTER, SPHERE_DOPPLEGANGER)) : Sphere_Spawn(self, SpawnFlags_or(SPHERE_VENGEANCE, SPHERE_DOPPLEGANGER));
        if (sphere.pain !== null) sphere.pain(sphere, attacker, 0, 0, mod);
      }
    }

    self.takedamage = false; // DAMAGE_NONE

    // [Paril-KEX]
    if (self.teammaster === null) throw new Error("doppleganger_die: self.teammaster is null -- fire_doppleganger always sets it");
    T_RadiusDamage(self, self.teammaster, 160, self, 140, 0 /* DAMAGE_NONE */, { id: ModIdT.MOD_DOPPLE_EXPLODE, friendly_fire: false, no_point_loss: false });

    if (self.teamchain !== null) BecomeExplosion1(self.teamchain);
    BecomeExplosion1(self);
  },
);

/** rogue/g_rogue_newdm.cpp:201-204: `PAIN(doppleganger_pain)`. */
export const doppleganger_pain: PainFn = RegisterPain("doppleganger_pain", (self: EdictT, other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  self.enemy = other;
});

/** rogue/g_rogue_newdm.cpp:206-209: `THINK(doppleganger_timeout)`. */
export const doppleganger_timeout: ThinkFn = RegisterThink("doppleganger_timeout", (self: EdictT): void => {
  doppleganger_die(self, self, self, 9999, self.s.origin, MOD_UNKNOWN);
});

/** rogue/g_rogue_newdm.cpp:211-240: `THINK(body_think)`. */
export const body_think: ThinkFn = RegisterThink("body_think", (self: EdictT): void => {
  if (Math.abs(self.ideal_yaw - anglemod(self.s.angles[YAW])) < 2) {
    if (self.timestamp < level.time) {
      const r = frandom();
      if (r < 0.1) {
        self.ideal_yaw = frandom(350);
        self.timestamp = Gtime_add(level.time, Gtime_from_sec(1));
      }
    }
  } else {
    M_ChangeYaw(self);
  }

  if (self.teleport_time <= level.time) {
    self.s.frame++;
    if (self.s.frame > FRAME_stand40) self.s.frame = FRAME_stand01;

    self.teleport_time = Gtime_add(level.time, Gtime_from_hz(10));
  }

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

/** Deep-copies a `KexEntityStateT` (C++ `entity_state_t`, a value type) --
 *  see file header's "QUIRKS" note on why a shallow spread would alias
 *  `origin`/`angles`/`old_origin` between `dst` and `src`. */
function copyEntityState(dst: EdictT, src: EdictT): void {
  const savedNumber = dst.s.number;
  dst.s = { ...src.s };
  dst.s.origin = vec3(src.s.origin[0], src.s.origin[1], src.s.origin[2]);
  dst.s.angles = vec3(src.s.angles[0], src.s.angles[1], src.s.angles[2]);
  dst.s.old_origin = vec3(src.s.old_origin[0], src.s.old_origin[1], src.s.old_origin[2]);
  dst.s.number = savedNumber;
}

/** rogue/g_rogue_newdm.cpp:242-320: `void fire_doppleganger(edict_t *ent,
 *  const vec3_t &start, const vec3_t &aimdir)`. */
export function fire_doppleganger(ent: EdictT, start: Vec3, aimdir: Vec3): void {
  const dir = vectoangles(aimdir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const base = G_Spawn();
  base.s.origin = start;
  base.s.angles = dir;
  base.movetype = MovetypeT.MOVETYPE_TOSS;
  base.solid = SolidT.SOLID_BBOX;
  base.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  base.s.angles[0] /* PITCH */ = 0;
  base.mins = vec3(-16, -16, -24);
  base.maxs = vec3(16, 16, 32);
  base.s.modelindex = gi.modelindex("models/objects/dopplebase/tris.md2");
  base.s.alpha = 0.1;
  base.teammaster = ent;
  base.flags |= EntFlagsT.FL_DAMAGEABLE | EntFlagsT.FL_TRAP;
  base.takedamage = true;
  base.health = 30;
  base.pain = doppleganger_pain;
  base.die = doppleganger_die;

  base.nextthink = Gtime_add(level.time, Gtime_from_sec(30));
  base.think = doppleganger_timeout;

  base.classname = "doppleganger";

  gi.linkentity(base);

  const body = G_Spawn();
  const number = body.s.number;
  copyEntityState(body, ent);
  body.s.sound = 0;
  body.s.event = KexEntityEventT.EV_NONE;
  body.s.number = number;
  body.yaw_speed = 30;
  body.ideal_yaw = 0;
  body.s.origin = vec3(start[0], start[1], start[2] + 8);
  body.teleport_time = Gtime_add(level.time, Gtime_from_hz(10));
  body.think = body_think;
  body.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  gi.linkentity(body);

  base.teamchain = body;
  body.teammaster = base;

  // [Paril-KEX]
  body.owner = ent;
  gi.sound(body, SoundchanT.CHAN_AUTO, gi.soundindex("medic_commander/monsterspawn1.wav"), 1, ATTN_NORM, 0);
}

// ---------------------------------------------------------------------------
// InitGameRules (rogue/g_rogue_newdm.cpp:322-359)
// ---------------------------------------------------------------------------

const RDM_TAG = 2;
const RDM_DEATHBALL = 3;

/** g_local.h:3275 `extern dm_game_rt DMGame;` -- see file header's
 *  "NOT SWAPPED" note on why this is not wired into g_main.ts by this unit. */
const DMGame: DmGameRt = {
  GameInit: null,
  PostInitSetup: null,
  ClientBegin: null,
  SelectSpawnPoint: null,
  PlayerDeath: null,
  Score: null,
  PlayerEffects: null,
  DogTag: null,
  PlayerDisconnect: null,
  ChangeDamage: null,
  ChangeKnockback: null,
  CheckDMRules: null,
};

/**
 * rogue/g_rogue_newdm.cpp:322-359: `void InitGameRules()`. Populates
 * `DMGame` per the `gamerules` cvar's value and calls `DMGame.GameInit()`.
 * Exported so the coordinator can wire it in at g_main.ts's own
 * `InitGameRules` call site (see file header's "NOT SWAPPED" note) --
 * NOT called from anywhere in this port line by this unit.
 */
export function InitGameRules(): void {
  DMGame.GameInit = null;
  DMGame.PostInitSetup = null;
  DMGame.ClientBegin = null;
  DMGame.SelectSpawnPoint = null;
  DMGame.PlayerDeath = null;
  DMGame.Score = null;
  DMGame.PlayerEffects = null;
  DMGame.DogTag = null;
  DMGame.PlayerDisconnect = null;
  DMGame.ChangeDamage = null;
  DMGame.ChangeKnockback = null;
  DMGame.CheckDMRules = null;

  const gamerules = cvarInt("gamerules", "0", CvarFlagsT.CVAR_LATCH);

  if (gamerules !== 0) {
    switch (gamerules) {
      case RDM_TAG:
        DMGame.GameInit = Tag_GameInit;
        DMGame.PostInitSetup = Tag_PostInitSetup;
        DMGame.PlayerDeath = Tag_PlayerDeath;
        DMGame.Score = Tag_Score;
        DMGame.PlayerEffects = Tag_PlayerEffects;
        DMGame.DogTag = Tag_DogTag;
        DMGame.PlayerDisconnect = Tag_PlayerDisconnect;
        DMGame.ChangeDamage = Tag_ChangeDamage;
        break;
      case RDM_DEATHBALL:
        DMGame.GameInit = DBall_GameInit;
        DMGame.ChangeKnockback = DBall_ChangeKnockback;
        DMGame.ChangeDamage = DBall_ChangeDamage;
        DMGame.ClientBegin = DBall_ClientBegin;
        DMGame.SelectSpawnPoint = DBall_SelectSpawnPoint;
        DMGame.PostInitSetup = DBall_PostInitSetup;
        DMGame.CheckDMRules = DBall_CheckDMRules;
        break;
      default:
        // reset gamerules if it's not a valid number
        gi.cvar_forceset("gamerules", "0");
        break;
    }
  }

  // if we're set up to play, initialize the game as needed.
  if (DMGame.GameInit !== null) DMGame.GameInit();
}
