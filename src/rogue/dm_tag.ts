// dm_tag.c
// pmack
// june 1998
//
// "Tag" deathmatch game rules: a single dm_tag_token item that makes its
// holder the target -- killing the tag owner scores big, the owner scoring
// kills builds toward a free Quad Damage. Wired into DMGame (the dispatch
// table type/singleton declared in g_local.ts) by g_newdm.ts's
// InitGameRules when gamerules is 2 (RDM_TAG).
//
// `edict_t *tag_token; edict_t *tag_owner; int tag_count;` are C globals
// reassigned by these functions -- a small owning holder object per
// PORTING.md, private to this module (nothing outside dm_tag.c reads them
// in the C source either).

import { AngleVectors, vec3, VectorCopy, VectorScale, VectorSet, type Vec3 } from "../shared/math";
import { CONTENTS_LAVA, CONTENTS_SLIME, CONTENTS_SOLID, EF_ROTATE, EF_TAGTRAIL, RF_GLOW } from "../shared/q_shared";
import { SolidT } from "./game";
import {
  DROPPED_ITEM,
  type EdictT,
  type GItemT,
  gameCvars,
  gi,
  level,
  meansOfDeathHolder,
  MOD_DOPPLE_EXPLODE,
  MOD_DOPPLE_HUNTER,
  MOD_DOPPLE_VENGEANCE,
  MOD_FRIENDLY_FIRE,
  MOD_HUNTER_SPHERE,
  MovetypeT,
} from "./g_local";
import { FindItem, ITEM_INDEX, SpawnItem, Touch_Item } from "./g_items";
import { G_Find, G_FreeEdict, G_ProjectSource, G_Spawn } from "./g_utils";
import { SelectFarthestDeathmatchSpawnPoint, SelectSpawnPoint } from "./p_client";
import { ValidateSelectedItem } from "./g_cmds";

interface TagState {
  token: EdictT | null;
  owner: EdictT | null;
  count: number;
}

const tag: TagState = { token: null, owner: null, count: 0 };

function requireItem(name: string): GItemT {
  const item = FindItem(name);
  if (item === null) throw new Error(`dm_tag: item "${name}" not found (C dereferences it unconditionally)`);
  return item;
}

function requireClient(ent: EdictT, what: string): NonNullable<EdictT["client"]> {
  if (ent.client === null) {
    throw new Error(`${what}.client is null (C dereferences it unconditionally here)`);
  }
  return ent.client;
}

// ***********************
// Tag Specific Stuff
// ***********************

// `targ`/`self` are non-null in DMGame's DmGameRt signature (g_local.ts's
// committed contract), but the C body still guards with `targ &&`/`self &&`
// defensively -- kept as a faithful (if now type-redundant) transcription.
export function Tag_PlayerDeath(targ: EdictT, _inflictor: EdictT, _attacker: EdictT): void {
  if (tag.token !== null && targ !== null && targ === tag.owner) {
    Tag_DropToken(targ, requireItem("Tag Token"));
    tag.owner = null;
    tag.count = 0;
  }
}

export function Tag_KillItBonus(self: EdictT): void {
  // if the player is hurt, boost them up to max.
  if (self.health < self.max_health) {
    self.health += 200;
    if (self.health > self.max_health) self.health = self.max_health;
  }

  // give the player a body armor
  const armor = G_Spawn();
  armor.spawnflags |= DROPPED_ITEM;
  armor.item = requireItem("Body Armor");
  Touch_Item(armor, self, null, null);
  if (armor.inuse) G_FreeEdict(armor);
}

export function Tag_PlayerDisconnect(self: EdictT): void {
  if (tag.token !== null && self !== null && self === tag.owner) {
    Tag_DropToken(self, requireItem("Tag Token"));
    tag.owner = null;
    tag.count = 0;
  }
}

export function Tag_Score(attacker: EdictT, victim: EdictT, scoreChangeIn: number): void {
  let scoreChange = scoreChangeIn;
  const mod = meansOfDeathHolder.meansOfDeath & ~MOD_FRIENDLY_FIRE;

  if (tag.token !== null && tag.owner !== null) {
    // owner killed somone else
    if (scoreChange > 0 && tag.owner === attacker) {
      scoreChange = 3;
      tag.count++;
      if (tag.count === 5) {
        const quad = requireItem("Quad Damage");
        const client = requireClient(attacker, "Tag_Score: attacker");
        client.pers.inventory[ITEM_INDEX(quad)]!++;
        if (quad.use) quad.use(attacker, quad);
        tag.count = 0;
      }
    }
    // owner got killed. 5 points and switch owners
    else if (tag.owner === victim && tag.owner !== attacker) {
      scoreChange = 5;
      if (
        mod === MOD_HUNTER_SPHERE ||
        mod === MOD_DOPPLE_EXPLODE ||
        mod === MOD_DOPPLE_VENGEANCE ||
        mod === MOD_DOPPLE_HUNTER ||
        attacker.health <= 0
      ) {
        Tag_DropToken(tag.owner, requireItem("Tag Token"));
        tag.owner = null;
        tag.count = 0;
      } else {
        Tag_KillItBonus(attacker);
        tag.owner = attacker;
        tag.count = 0;
      }
    }
  }

  requireClient(attacker, "Tag_Score: attacker").resp.score += scoreChange;
}

export function Tag_PickupToken(ent: EdictT, other: EdictT): boolean {
  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== 2) {
    return false;
  }

  // sanity checking is good.
  if (tag.token !== ent) tag.token = ent;

  const item = ent.item;
  if (item === null) throw new Error("Tag_PickupToken: ent.item is null (C dereferences it unconditionally)");
  const client = requireClient(other, "Tag_PickupToken: other");
  client.pers.inventory[ITEM_INDEX(item)]!++;

  tag.owner = other;
  tag.count = 0;

  Tag_KillItBonus(other);

  return true;
}

export function Tag_Respawn(ent: EdictT): void {
  const spot = SelectFarthestDeathmatchSpawnPoint();
  if (spot === null) {
    ent.nextthink = level.time + 1;
    return;
  }

  VectorCopy(spot.s.origin, ent.s.origin);
  gi.linkentity(ent);
}

export function Tag_MakeTouchable(ent: EdictT): void {
  ent.touch = Touch_Item;

  const token = tag.token;
  if (token === null) throw new Error("Tag_MakeTouchable: tag.token is null (C dereferences it unconditionally)");
  token.think = Tag_Respawn;

  // check here to see if it's in lava or slime. if so, do a respawn sooner
  if (gi.pointcontents(ent.s.origin) & (CONTENTS_LAVA | CONTENTS_SLIME)) {
    token.nextthink = level.time + 3;
  } else {
    token.nextthink = level.time + 30;
  }
}

export function Tag_DropToken(ent: EdictT, item: GItemT): void {
  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const offset: Vec3 = vec3();

  // reset the score count for next player
  tag.count = 0;
  tag.owner = null;

  const token = G_Spawn();
  tag.token = token;

  token.classname = item.classname;
  token.item = item;
  token.spawnflags = DROPPED_ITEM;
  token.s.effects = EF_ROTATE | EF_TAGTRAIL;
  token.s.renderfx = RF_GLOW;
  VectorSet(token.mins, -15, -15, -15);
  VectorSet(token.maxs, 15, 15, 15);
  gi.setmodel(token, item.world_model ?? "");
  token.solid = SolidT.SOLID_TRIGGER;
  token.movetype = MovetypeT.MOVETYPE_TOSS;
  token.touch = null;
  token.owner = ent;

  const client = requireClient(ent, "Tag_DropToken: ent");
  AngleVectors(client.v_angle, forward, right, null);
  VectorSet(offset, 24, 0, -16);
  G_ProjectSource(ent.s.origin, offset, forward, right, token.s.origin);
  const trace = gi.trace(ent.s.origin, token.mins, token.maxs, token.s.origin, ent, CONTENTS_SOLID);
  VectorCopy(trace.endpos, token.s.origin);

  VectorScale(forward, 100, token.velocity);
  token.velocity[2] = 300;

  token.think = Tag_MakeTouchable;
  token.nextthink = level.time + 1;

  gi.linkentity(token);

  client.pers.inventory[ITEM_INDEX(item)]!--;
  ValidateSelectedItem(ent);
}

export function Tag_PlayerEffects(ent: EdictT): void {
  if (ent === tag.owner) ent.s.effects |= EF_TAGTRAIL;
}

// C signature is `void Tag_DogTag(edict_t *ent, edict_t *killer, char **pic)`
// -- an out-param that's only conditionally written (`if (ent == tag_owner)
// (*pic) = "tag3";`, otherwise left untouched by the caller's existing
// value). g_local.ts's DmGameRt commits DogTag to an unconditional `=>
// string` return (no "current pic" input to fall back to), so the "leave
// unchanged" branch is represented as an empty string; the caller is
// expected to treat "" as no override, same effect as an untouched pointer.
export function Tag_DogTag(ent: EdictT, _killer: EdictT | null): string {
  if (ent === tag.owner) return "tag3";
  return "";
}

// Tag_ChangeDamage - damage done that does not involve the tag owner
//		is at 75% original to encourage folks to go after the tag owner.
export function Tag_ChangeDamage(targ: EdictT, attacker: EdictT, damage: number, _mod: number): number {
  if (targ !== tag.owner && attacker !== tag.owner) return ((damage * 3) / 4) | 0;

  return damage;
}

export function Tag_GameInit(): void {
  tag.token = null;
  tag.owner = null;
  tag.count = 0;
}

export function Tag_PostInitSetup(): void {
  let e = G_Find(null, "classname", "dm_tag_token");
  if (e === null) {
    e = G_Spawn();
    e.classname = "dm_tag_token";

    const origin: Vec3 = vec3();
    const angles: Vec3 = vec3();
    SelectSpawnPoint(e, origin, angles);
    VectorCopy(origin, e.s.origin);
    VectorCopy(origin, e.s.old_origin);
    VectorCopy(angles, e.s.angles);
    SP_dm_tag_token(e);
  }
}

/*QUAKED dm_tag_token (.3 .3 1) (-16 -16 -16) (16 16 16)
The tag token for deathmatch tag games.
*/
export function SP_dm_tag_token(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }

  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== 2) {
    G_FreeEdict(self);
    return;
  }

  // store the tag token edict pointer for later use.
  tag.token = self;
  tag.count = 0;

  self.classname = "dm_tag_token";
  self.model = "models/items/tagtoken/tris.md2";
  self.count = 1;
  SpawnItem(self, requireItem("Tag Token"));
}
