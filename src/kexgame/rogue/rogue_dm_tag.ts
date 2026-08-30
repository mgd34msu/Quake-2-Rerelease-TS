// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// rogue_dm_tag.cpp -- the ROGUE mission pack's "Tag" deathmatch gametype
// (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/rogue_dm_tag.cpp (297
// lines, C++17): the tag-token pickup/drop/respawn cycle, the "it" transfer-
// on-kill rule, elapsed-kill scoring bonuses, the reduced-damage-unless-it
// rule, and the `dm_game_rt` vtable hooks (`Tag_GameInit`/`Tag_PostInitSetup`/
// `Tag_PlayerDeath`/`Tag_Score`/`Tag_PlayerEffects`/`Tag_DogTag`/
// `Tag_PlayerDisconnect`/`Tag_ChangeDamage`) g_rogue_newdm.ts's `InitGameRules`
// wires up under `RDM_TAG`.
//
// ============================================================================
// GAMETYPE ACTIVATION -- see g_rogue_newdm.ts's own note
// ============================================================================
// Every function here is reached only via g_rogue_newdm.ts's `InitGameRules`
// (itself reached only when the `gamerules` cvar is nonzero -- default 0),
// OR via `SP_dm_tag_token`, reached only when a `dm_tag_token` entity is
// placed in a map AND `gamerules` is already set to `RDM_TAG` (2) when it
// spawns (both early-out otherwise). No server this port line can currently
// configure reaches either path (see g_main.ts's/g_combat.ts's/p_client.ts's
// own "DMGame -- concrete faithful value, not a stub" precedent: `DMGame`
// stays a local, all-null `DmGameRt` in every landed file, because
// `gamerules` sits at its registered default of 0 everywhere). This unit
// ports every function for real anyway (all are small and self-contained),
// rather than stubbing them, exactly matching g_rogue_newai.ts's own
// "ported for real even though currently unreachable" precedent for
// `drawbbox`.
//
// ============================================================================
// STUB SWAP: g_items.ts's `Tag_PickupToken`
// ============================================================================
// g_items.ts carries a local unexported throwing stub `Tag_PickupToken`
// cited to this file. See g_items.ts's own header note documenting the
// swap: the stub is deleted, and g_items.ts's `IT_ITEM_TAG_TOKEN` itemlist
// entry's `pickup` field now imports the real function from here.
//
// ============================================================================
// QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `Tag_Score` unconditionally does `attacker->client->resp.score +=
//   scoreChange` at the end of the function EVEN WHEN `tag_token`/
//   `tag_owner` are both null (i.e. tag mode is active but no token has
//   ever been picked up yet) -- the C++ source has no guard around that
//   final line, only around the two `if`s that might *change*
//   `scoreChange` from its caller-supplied value. Preserved exactly:
//   `attacker` is dereferenced unconditionally (see `requireClient`).
// - `Tag_Score`'s quad-bonus branch increments the attacker's quad
//   inventory count via `pers.inventory[IT_ITEM_QUAD]++` and THEN calls
//   `quad->use(attacker, quad)` (which itself decrements the same slot by
//   1 -- see g_items.ts's `Use_Quad`) -- net effect is "the attacker's
//   quad timer restarts, ending at exactly the normal quad duration from
//   now," not "the attacker gains a stacked/extra quad charge." This is
//   the C++ source's actual net behavior, preserved bug-for-bug (looks
//   redundant, isn't a no-op, since inventory count and the timer are two
//   separate pieces of state).
// - `Tag_KillItBonus` spawns a temporary `armor` edict, calls `Touch_Item`
//   on it directly (bypassing the normal touch-trigger dispatch), and
//   frees it again if it's STILL in use afterward -- `Touch_Item` itself
//   frees non-respawning pickups synchronously on a successful pickup, so
//   this is a defensive double-free-guard in the C++ source, not dead
//   code; preserved exactly, including calling `Touch_Item` with the
//   engine's `null_trace` sentinel (this file's own local copy, matching
//   g_utils.ts's/g_cmds.ts's own established "not exported, one copy per
//   file" idiom for that constant).
//
// ============================================================================
// SP LIST (for the coordinator -- g_spawn.ts is not edited by this unit)
// ============================================================================
// g_spawn.ts's spawn table already carries:
//   { name: "dm_tag_token", spawn: unported("SP_dm_tag_token", "rogue/rogue_dm_tag.cpp (future src/rogue/rogue_dm_tag.ts)") },
// Swap that entry's `spawn` to `SP_dm_tag_token` exported below.

import { type Vec3, vec3 } from "../../shared/math";
import { CplaneT } from "../../shared/q_shared";
import { RenderfxT, ContentsT, EffectsT, type KexTraceT, CvarFlagsT, SolidT } from "../../kexapi/game";
import { type EdictT, type GClientT, type GitemT, ItemIdT, ModIdT, SPAWNFLAG_ITEM_DROPPED, MovetypeT } from "../g_local";
import { gi, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec } from "../gtime";
import { RegisterThink, type ThinkFn } from "../g_save_registry";
import { AngleVectors, G_ProjectSource } from "../q_vec3";
import { G_Spawn, G_FreeEdict, G_FindByString } from "../g_utils";
import { GetItemByIndex, Touch_Item, SpawnItem } from "../g_items";
import { SelectSpawnPoint, SelectDeathmatchSpawnPoint } from "../p_client";

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0", CvarFlagsT.CVAR_LATCH) !== 0;
}

/** g_local.h:627: `constexpr trace_t null_trace {};` -- see file header's
 *  "not exported, one copy per file" note. */
const null_trace: KexTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 1,
  endpos: vec3(0, 0, 0),
  plane: new CplaneT(),
  surface: null,
  contents: 0,
  ent: null,
  plane2: new CplaneT(),
  surface2: null,
};

function requireClient(ent: EdictT, fnName: string): GClientT {
  if (ent.client === null) {
    throw new Error(`${fnName}: called against a non-client entity (${ent.classname ?? "?"}) -- the C++ source dereferences ->client unconditionally here`);
  }
  return ent.client;
}

function requireItemByIndex(id: ItemIdT, fnName: string): GitemT {
  const item = GetItemByIndex(id);
  if (item === null) throw new Error(`${fnName}: GetItemByIndex(${id}) returned null -- itemlist is not fully initialized`);
  return item;
}

// ---------------------------------------------------------------------------
// module-level state -- rogue/rogue_dm_tag.cpp:15-17
// `edict_t *tag_token; edict_t *tag_owner; int tag_count;`
// ---------------------------------------------------------------------------

let tag_token: EdictT | null = null;
let tag_owner: EdictT | null = null;
let tag_count = 0;

/** rogue/rogue_dm_tag.cpp:168-212: `void Tag_DropToken(edict_t *ent, gitem_t *item)`. */
export function Tag_DropToken(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Tag_DropToken");

  // reset the score count for next player
  tag_count = 0;
  tag_owner = null;

  const token = G_Spawn();
  tag_token = token;

  token.classname = item.classname;
  token.item = item;
  token.spawnflags = SPAWNFLAG_ITEM_DROPPED;
  token.s.effects = EffectsT.EF_ROTATE | EffectsT.EF_TAGTRAIL;
  token.s.renderfx = RenderfxT.RF_GLOW | RenderfxT.RF_NO_LOD;
  token.mins = vec3(-15, -15, -15);
  token.maxs = vec3(15, 15, 15);
  gi.setmodel(token, item.world_model ?? "");
  token.solid = SolidT.SOLID_TRIGGER;
  token.movetype = MovetypeT.MOVETYPE_TOSS;
  token.touch = null;
  token.owner = ent;

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const offset = vec3(24, 0, -16);
  token.s.origin = G_ProjectSource(ent.s.origin, offset, forward, right);
  const trace = gi.trace(ent.s.origin, token.mins, token.maxs, token.s.origin, ent, ContentsT.CONTENTS_SOLID);
  token.s.origin = trace.endpos;

  token.velocity = vec3(forward[0] * 100, forward[1] * 100, forward[2] * 100);
  token.velocity[2] = 300;

  token.think = Tag_MakeTouchable;
  token.nextthink = Gtime_add(level.time, Gtime_from_sec(1));

  gi.linkentity(token);

  client.pers.inventory[item.id]--;
}

/** rogue/rogue_dm_tag.cpp:136-151: `THINK(Tag_Respawn)`. */
export const Tag_Respawn: ThinkFn = RegisterThink("Tag_Respawn", (ent: EdictT): void => {
  const { spot } = SelectDeathmatchSpawnPoint(true, false, true);

  if (spot === null) {
    ent.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
    return;
  }

  ent.s.origin = spot.s.origin;
  gi.linkentity(ent);
});

/** rogue/rogue_dm_tag.cpp:153-166: `THINK(Tag_MakeTouchable)`. */
export const Tag_MakeTouchable: ThinkFn = RegisterThink("Tag_MakeTouchable", (ent: EdictT): void => {
  ent.touch = Touch_Item;

  if (tag_token !== null) {
    tag_token.think = Tag_Respawn;

    if ((gi.pointcontents(ent.s.origin) & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0) {
      tag_token.nextthink = Gtime_add(level.time, Gtime_from_sec(3));
    } else {
      tag_token.nextthink = Gtime_add(level.time, Gtime_from_sec(30));
    }
  }
});

/** rogue/rogue_dm_tag.cpp:33-54: `void Tag_KillItBonus(edict_t *self)`. */
export function Tag_KillItBonus(self: EdictT): void {
  // if the player is hurt, boost them up to max.
  if (self.health < self.max_health) {
    self.health += 200;
    if (self.health > self.max_health) self.health = self.max_health;
  }

  // give the player a body armor
  const armor = G_Spawn();
  armor.spawnflags = SPAWNFLAG_ITEM_DROPPED;
  armor.item = requireItemByIndex(ItemIdT.IT_ARMOR_BODY, "Tag_KillItBonus");
  Touch_Item(armor, self, null_trace, true);
  if (armor.inuse) G_FreeEdict(armor);
}

/** rogue/rogue_dm_tag.cpp:21-31: `void Tag_PlayerDeath(edict_t *targ, edict_t *inflictor, edict_t *attacker)`. */
export function Tag_PlayerDeath(targ: EdictT, _inflictor: EdictT, _attacker: EdictT): void {
  if (tag_token !== null && targ === tag_owner) {
    Tag_DropToken(targ, requireItemByIndex(ItemIdT.IT_ITEM_TAG_TOKEN, "Tag_PlayerDeath"));
    tag_owner = null;
    tag_count = 0;
  }
}

/** rogue/rogue_dm_tag.cpp:56-66: `void Tag_PlayerDisconnect(edict_t *self)`. */
export function Tag_PlayerDisconnect(self: EdictT): void {
  if (tag_token !== null && self === tag_owner) {
    Tag_DropToken(self, requireItemByIndex(ItemIdT.IT_ITEM_TAG_TOKEN, "Tag_PlayerDisconnect"));
    tag_owner = null;
    tag_count = 0;
  }
}

/**
 * rogue/rogue_dm_tag.cpp:68-111: `void Tag_Score(edict_t *attacker, edict_t
 * *victim, int scoreChange, const mod_t &mod)`. See file header's QUIRKS
 * note: the final `resp.score +=` runs unconditionally, matching the C++
 * source's lack of a guard around it.
 */
export function Tag_Score(attacker: EdictT, victim: EdictT, scoreChangeIn: number, mod: { id: ModIdT }): void {
  let scoreChange = scoreChangeIn;
  const attackerClient = requireClient(attacker, "Tag_Score");

  if (tag_token !== null && tag_owner !== null) {
    // owner killed someone else
    if (scoreChange > 0 && tag_owner === attacker) {
      scoreChange = 3;
      tag_count++;
      if (tag_count === 5) {
        const quad = requireItemByIndex(ItemIdT.IT_ITEM_QUAD, "Tag_Score");
        attackerClient.pers.inventory[ItemIdT.IT_ITEM_QUAD]++;
        if (quad.use !== null) quad.use(attacker, quad);
        tag_count = 0;
      }
    }
    // owner got killed. 5 points and switch owners
    else if (tag_owner === victim && tag_owner !== attacker) {
      scoreChange = 5;
      if (
        mod.id === ModIdT.MOD_HUNTER_SPHERE ||
        mod.id === ModIdT.MOD_DOPPLE_EXPLODE ||
        mod.id === ModIdT.MOD_DOPPLE_VENGEANCE ||
        mod.id === ModIdT.MOD_DOPPLE_HUNTER ||
        attacker.health <= 0
      ) {
        Tag_DropToken(tag_owner, requireItemByIndex(ItemIdT.IT_ITEM_TAG_TOKEN, "Tag_Score"));
        tag_owner = null;
        tag_count = 0;
      } else {
        Tag_KillItBonus(attacker);
        tag_owner = attacker;
        tag_count = 0;
      }
    }
  }

  attackerClient.resp.score += scoreChange;
}

/** rogue/rogue_dm_tag.cpp:113-134: `bool Tag_PickupToken(edict_t *ent, edict_t *other)`. */
export function Tag_PickupToken(ent: EdictT, other: EdictT): boolean {
  if (cvarInt("gamerules", "0", CvarFlagsT.CVAR_LATCH) !== 2 /* RDM_TAG */) return false;

  const item = ent.item;
  if (item === null) throw new Error("Tag_PickupToken: called against an entity with no .item set -- the C++ source dereferences ent->item unconditionally here");
  const otherClient = requireClient(other, "Tag_PickupToken");

  // sanity checking is good.
  if (tag_token !== ent) tag_token = ent;

  otherClient.pers.inventory[item.id]++;

  tag_owner = other;
  tag_count = 0;

  Tag_KillItBonus(other);

  return true;
}

/** rogue/rogue_dm_tag.cpp:214-220: `void Tag_PlayerEffects(edict_t *ent)`. */
export function Tag_PlayerEffects(ent: EdictT): void {
  if (ent === tag_owner) ent.s.effects |= EffectsT.EF_TAGTRAIL;
}

/** rogue/rogue_dm_tag.cpp:222-230: `void Tag_DogTag(edict_t *ent, edict_t *killer, const char **pic)`. */
export function Tag_DogTag(ent: EdictT, _killer: EdictT, pic: [string | null]): void {
  if (ent === tag_owner) pic[0] = "tag3";
}

/**
 * rogue/rogue_dm_tag.cpp:232-240: `int Tag_ChangeDamage(edict_t *targ,
 * edict_t *attacker, int damage, mod_t mod)`. Damage done that does not
 * involve the tag owner is at 75% original, to encourage folks to go after
 * the tag owner.
 */
export function Tag_ChangeDamage(targ: EdictT, attacker: EdictT, damage: number, _mod: { id: ModIdT }): number {
  if (targ !== tag_owner && attacker !== tag_owner) return Math.trunc((damage * 3) / 4);
  return damage;
}

/** rogue/rogue_dm_tag.cpp:242-249: `void Tag_GameInit()`. */
export function Tag_GameInit(): void {
  tag_token = null;
  tag_owner = null;
  tag_count = 0;
}

/**
 * rogue/rogue_dm_tag.cpp:251-267: `void Tag_PostInitSetup()` -- automatic
 * spawning of a tag token if one is not already present on the map.
 */
export function Tag_PostInitSetup(): void {
  const existing = G_FindByString(null, "classname", "dm_tag_token");
  if (existing !== null) return;

  const e = G_Spawn();
  e.classname = "dm_tag_token";

  const originBox: [Vec3] = [vec3()];
  const anglesBox: [Vec3] = [vec3()];
  const landmarkBox: [boolean] = [false];
  SelectSpawnPoint(e, originBox, anglesBox, true, landmarkBox);
  e.s.origin = originBox[0];
  e.s.old_origin = originBox[0];
  e.s.angles = anglesBox[0];
  SP_dm_tag_token(e);
}

/*QUAKED dm_tag_token (.3 .3 1) (-16 -16 -16) (16 16 16)
The tag token for deathmatch tag games.
*/
/** rogue/rogue_dm_tag.cpp:269-297: `void SP_dm_tag_token(edict_t *self)`. */
export function SP_dm_tag_token(self: EdictT): void {
  if (!deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  if (cvarInt("gamerules", "0", CvarFlagsT.CVAR_LATCH) !== 2 /* RDM_TAG */) {
    G_FreeEdict(self);
    return;
  }

  // store the tag token edict pointer for later use.
  tag_token = self;
  tag_count = 0;

  self.classname = "dm_tag_token";
  self.model = "models/items/tagtoken/tris.md2";
  self.count = 1;
  SpawnItem(self, requireItemByIndex(ItemIdT.IT_ITEM_TAG_TOKEN, "SP_dm_tag_token"));
}
