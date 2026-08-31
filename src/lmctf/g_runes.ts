// Ports lmctf60/g_runes.c (632 lines) -- LM_CTF's power-up rune subsystem,
// wholly new with no CTF-mod ancestor (these are LM_CTF's replacement for
// ZOID's tech powerups, which lmctf60/g_local.h drops entirely, see
// g_local.ts's IT_TECH removal note).
//
// STATUS: complete. Every function in g_runes.c is ported below: the two
// scan helpers (SelectRuneSpawnPoint/RunesRangeFromSpot/
// SelectFarthestRuneSpawnPoint), the toss helpers (tossruneset/tossrune,
// C `static`, module-private here), the think/spawn/pickup/drop lifecycle
// (Rune_Think, SpawnRune, SP_damage_rune, Pickup_Rune, Drop_Rune_Think,
// Drop_Rune), and all four combat hooks (DamageRuneHook/ResistRuneHook,
// unchanged from the prior partial port; RuneThinkHook/RuneWeaponThinkHook,
// newly ported).
//
// Several functions call into g_utils.c/g_items.c/g_ctffunc.c/g_spawn.c
// symbols this file does not itself define. All of them have since landed
// for real (g_utils.ts/g_items.ts/g_ctffunc.ts/g_spawn.ts) and are now real
// imports (ED_NewString/ED_CallSpawn via a lazy require -- see the
// "Cross-dependencies" section below -- because g_spawn.ts's spawns[]
// table statically imports this file's SP_damage_rune, and a static import
// back would close a cycle; everything else is a plain static import).

import { random, vec3, VectorAdd, VectorCopy, VectorScale, VectorSet, VectorSubtract, type Vec3, VectorLength } from "../shared/math";
import { ATTN_NORM, CHAN_ITEM, MASK_SOLID } from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  DamageT,
  DROPPED_ITEM,
  FL_RESPAWN,
  FRAMETIME,
  type EdictT,
  type GItemT,
  MovetypeT,
  gi,
  level,
  redflag,
} from "./g_local";
import { ArmorIndex, drop_temp_touch, FindItem, FindItemByClassname, ITEM_INDEX, SpawnItem, Touch_Item } from "./g_items";
import { G_Find, G_Spawn, tv, type EdictStringKey } from "./g_utils";
import { ctf_TossEnt } from "./g_ctffunc";
import { ValidateSelectedItem } from "./g_cmds";

// lmctf60/g_local.h/q_shared.h rune type bitflags
export const RUNE_DAMAGE = 1;
export const RUNE_RESIST = 2;
export const RUNE_HASTE = 4;
export const RUNE_REGEN = 8;
export const RUNE_VAMP = 16; // added by Vampire

// g_runes.c:8: `#define RUNETHINKTIME 30 //time before a rune relocates
// itself` -- only referenced within this file (Rune_Think's relocate
// check), so kept module-private.
const RUNETHINKTIME = 30;

// ---------------------------------------------------------------------
// Cross-dependencies into g_spawn.ts (ED_NewString/ED_CallSpawn), resolved
// via a lazy require rather than a static import: g_spawn.ts's spawns[]
// table statically imports SP_damage_rune from this file (its real
// "damage_rune" registry entry), so a static import back here would close
// a value cycle. Per PORTING.md's import-cycle rule, g_spawn.ts (the
// entity-dispatch module) is not the side that breaks it.
// SpawnItem/FindItemByClassname/Touch_Item/drop_temp_touch (g_items.ts),
// ctf_TossEnt (g_ctffunc.ts), and ValidateSelectedItem (g_cmds.ts) are now
// real imports (checked immediately before writing this file: none of
// those three modules import g_runes.ts, so no cycle).
// ---------------------------------------------------------------------

function spawnModule(): typeof import("./g_spawn") {
  return require("./g_spawn") as typeof import("./g_spawn");
}
function ED_NewString(value: string): string {
  return spawnModule().ED_NewString(value);
}
function ED_CallSpawn(ent: EdictT): void {
  spawnModule().ED_CallSpawn(ent);
}

// ---------------------------------------------------------------------

/*
=================
tossruneset (lmctf60/g_runes.c:10, `static`)
=================
*/
function tossruneset(ent: EdictT): void {
  ent.svflags &= ~SVF_NOCLIENT;
  ent.flags |= FL_RESPAWN;
  ent.spawnflags = DROPPED_ITEM;

  if (ent.model !== null) {
    gi.setmodel(ent, ent.model);
  } else if (ent.item !== null) {
    gi.setmodel(ent, ent.item.world_model ?? "");
  }
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
}

/*
=================
tossrune (lmctf60/g_runes.c:23, `static`)

`dir` is a `vec3_t` in C, and every call site in this file passes the
integer literal `0` for it (never a real vector) -- `dir: Vec3 | null`
models that NULL-pointer convention; `dir === null || dir[0] === 0`
matches the C `!dir || !dir[0]` check exactly (a real all-zero direction
vector also takes the "random toss" branch, same as the C source).
=================
*/
function tossrune(ent: EdictT, dir: Vec3 | null): void {
  const temp: Vec3 = vec3();
  const workDir: Vec3 = dir === null ? vec3() : vec3(dir[0], dir[1], dir[2]);

  VectorSet(ent.mins, -15, -15, -15);
  VectorSet(ent.maxs, 15, 15, 15);
  tossruneset(ent);
  ent.touch = Touch_Item;
  const owner = ent.owner;
  ent.owner = null;
  ent.groundentity = null;

  VectorCopy(ent.s.origin, temp);

  if (dir === null || workDir[0] === 0) {
    // Random toss
    const v = tv(0, 0, 48);
    VectorAdd(ent.s.origin, v, ent.s.origin);
    ent.velocity[0] = -2000 + random() * 4000;
    ent.velocity[1] = -2000 + random() * 4000;
    ent.velocity[2] = 800 + random() * 200;
  } else {
    VectorScale(workDir, 64, workDir);
    VectorAdd(ent.s.origin, workDir, ent.s.origin);
    VectorScale(workDir, 4, workDir);
    VectorCopy(workDir, ent.velocity);
  }

  const tr = gi.trace(temp, ent.mins, ent.maxs, ent.s.origin, owner, MASK_SOLID);
  if (tr.fraction < 1.0 || tr.allsolid) {
    VectorCopy(temp, ent.s.origin);
  }

  ent.think = Rune_Think;
  // g_runes.c:65: `ent->nextthink = level.time + FRAMETIME;//RUNETHINKTIME;`
  // -- the commented-out RUNETHINKTIME shows a relocate-every-30s design
  // that was replaced with a plain every-frame think; preserved exactly.
  ent.nextthink = level.time + FRAMETIME;

  // We just moved. Remember this time
  ent.last_move_time = level.time;

  ent.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(ent); // always pair with changes to solid
}

const CLASSNAME: EdictStringKey = "classname" as EdictStringKey;

/*
=================
SelectRuneSpawnPoint (lmctf60/g_runes.c:77)

Picks a random `item_health_small`, falling back to `item_health_large`,
falling back to `item_health`, in that order, only trying the next tier
when the current one has zero entities in the map.
=================
*/
export function SelectRuneSpawnPoint(): EdictT | null {
  let spot: EdictT | null = null;
  let count = 0;
  let selection: number;

  spot = null;
  while ((spot = G_Find(spot, CLASSNAME, "item_health_small")) !== null) {
    count++;
  }

  if (count > 0) {
    selection = (random() * count) | 0;

    if (selection < 0) selection = 0;
    if (selection > 20) selection = 20; // arbitrary, lets not wait too long

    spot = null;
    do {
      spot = G_Find(spot, CLASSNAME, "item_health_small");
      selection--;
    } while (selection > 0);
  } else {
    count = 0;
    spot = null;
    while ((spot = G_Find(spot, CLASSNAME, "item_health_large")) !== null) {
      count++;
    }
    if (count > 0) {
      selection = (random() * count) | 0;

      if (selection < 0) selection = 0;
      if (selection > 20) selection = 20;

      spot = null;
      do {
        spot = G_Find(spot, CLASSNAME, "item_health_large");
        selection--;
      } while (selection > 0);
    } else {
      count = 0;
      spot = null;
      while ((spot = G_Find(spot, CLASSNAME, "item_health")) !== null) {
        count++;
      }
      if (count > 0) {
        selection = (random() * count) | 0;

        if (selection < 0) selection = 0;
        if (selection > 20) selection = 20;

        spot = null;
        do {
          spot = G_Find(spot, CLASSNAME, "item_health");
          selection--;
        } while (selection > 0);
      }
    }
  }

  return spot;
}

/*
=================
RunesRangeFromSpot (lmctf60/g_runes.c:163)

Distance from `spot` to the nearest already-spawned rune of any type
(only ever the first `G_Find` match per rune classname -- the C source's
own comment flags this: "-bat - This should use a function!"; preserved
as written, one G_Find per rune classname rather than a loop).
=================
*/
export function RunesRangeFromSpot(spot: EdictT): number {
  let bestrunedistance = 9999999;
  const v: Vec3 = vec3();

  // -bat - This should use a function!

  let rune = G_Find(spot, CLASSNAME, "damage_rune");
  if (rune !== null) {
    VectorSubtract(spot.s.origin, rune.s.origin, v);
    const runedistance = VectorLength(v);
    if (runedistance < bestrunedistance) bestrunedistance = runedistance;
  }

  rune = G_Find(spot, CLASSNAME, "haste_rune");
  if (rune !== null) {
    VectorSubtract(spot.s.origin, rune.s.origin, v);
    const runedistance = VectorLength(v);
    if (runedistance < bestrunedistance) bestrunedistance = runedistance;
  }

  rune = G_Find(spot, CLASSNAME, "resist_rune");
  if (rune !== null) {
    VectorSubtract(spot.s.origin, rune.s.origin, v);
    const runedistance = VectorLength(v);
    if (runedistance < bestrunedistance) bestrunedistance = runedistance;
  }

  rune = G_Find(spot, CLASSNAME, "regen_rune");
  if (rune !== null) {
    VectorSubtract(spot.s.origin, rune.s.origin, v);
    const runedistance = VectorLength(v);
    if (runedistance < bestrunedistance) bestrunedistance = runedistance;
  }

  rune = G_Find(spot, CLASSNAME, "vampire_rune"); // added by Vampire
  if (rune !== null) {
    VectorSubtract(spot.s.origin, rune.s.origin, v);
    const runedistance = VectorLength(v);
    if (runedistance < bestrunedistance) bestrunedistance = runedistance;
  }

  return bestrunedistance;
}

/*
================
SelectFarthestRuneSpawnPoint (lmctf60/g_runes.c:238)

C source names this after ZOID's SelectFarthestDeathmatchSpawnPoint (the
doc comment above it in the C source still says
"SelectFarthestDeathmatchSpawnPoint" -- a stale copy-paste header,
preserved as a comment quirk below); picks the `item_health` spot
farthest from every existing rune, falling back to
SelectRuneSpawnPoint() if no `item_health` spots exist at all.
================
*/
// C doc comment (stale, copy-pasted from ZOID's
// SelectFarthestDeathmatchSpawnPoint and never updated for this function):
// ================
// SelectFarthestDeathmatchSpawnPoint
//
// ================
export function SelectFarthestRuneSpawnPoint(): EdictT | null {
  let bestspot: EdictT | null = null;
  let bestdistance = 0;

  let spot = G_Find(null, CLASSNAME, "item_health");
  while (spot !== null) {
    const bestrunedistance = RunesRangeFromSpot(spot);

    if (bestrunedistance > bestdistance) {
      bestspot = spot;
      bestdistance = bestrunedistance;
    }
    spot = G_Find(spot, CLASSNAME, "item_health");
  }

  if (bestspot !== null) {
    return bestspot;
  }

  return SelectRuneSpawnPoint();
}

// g_runes.c:275: `static qboolean forward = true;` -- function-static
// animation direction shared across all RUNE_DAMAGE runes (a single
// module-level flag flips every rune's frame direction together, same
// aliasing behavior as the C function-static).
let runeThinkForward = true;

/*
=================
Rune_Think (lmctf60/g_runes.c:272)

Per-rune-type idle animation, then (independent of animation) relocates
the rune to a new spawn point every RUNETHINKTIME (30) seconds since it
last moved.
=================
*/
export function Rune_Think(self: EdictT): void {
  if (self.solid !== SolidT.SOLID_NOT) {
    switch (self.runetype) {
      case RUNE_DAMAGE:
        // screwy stuff to fix animation due to gimblelock
        if (runeThinkForward) {
          self.s.frame++;
          if (self.s.frame >= 5) runeThinkForward = false;
        } else {
          self.s.frame--;
          if (self.s.frame <= 0) runeThinkForward = true;
        }
        break;
      case RUNE_HASTE:
        // screwy stuff to fix animation due to gimblelock
        switch (self.s.frame) {
          case 1:
          case 2:
          case 3:
          case 4:
          case 5:
          case 6:
          case 7:
          case 8:
          case 9:
          case 10:
          case 11:
          case 12:
          case 13:
          case 14:
          case 15:
            self.s.frame++;
            break;
          default:
            self.s.frame = 5;
            break;
        }
        break;
      case RUNE_RESIST:
        self.s.frame = (self.s.frame + 1) % 15;
        break;
      case RUNE_REGEN:
        self.s.frame = (self.s.frame + 1) % 14;
        break;
      case RUNE_VAMP: // added by Vampire
        self.s.frame = (self.s.frame + 1) % 15;
        break;
      default:
        break;
    }
  }
  self.think = Rune_Think;
  self.nextthink = level.time + FRAMETIME;

  // Let's reuse last_move_time
  if (self.last_move_time + RUNETHINKTIME < level.time) {
    let spot = SelectRuneSpawnPoint();

    if (spot === null) spot = redflag;

    if (spot !== null) {
      VectorCopy(spot.s.origin, self.s.origin);
      tossrune(self, null);
    }
    self.last_move_time = level.time;
  }
}

/*
=================
SpawnRune (lmctf60/g_runes.c:357)

Spawns a fresh rune pickup of `type` at the farthest available spot from
existing runes, falling back to `redflag`'s position. The C source's
`//if (!deathmatch->value) return;` (single-player rune support) is
already commented out in the C source itself, matching the "#if 0 blocks
dropped silently" rule -- there is nothing to drop here since the C
source never compiled that check either.
=================
*/
export function SpawnRune(type: number): void {
  let name: string | null = null;
  let model: string | null = null;
  let effects = 0;
  let renderfx = 0;

  let spot = SelectFarthestRuneSpawnPoint();
  if (spot === null) spot = redflag;

  if (spot !== null) {
    switch (type) {
      case RUNE_DAMAGE:
        name = "damage_rune";
        effects = 0; // EF_COLOR_SHELL;
        renderfx = 0; // RF_SHELL_RED;
        model = "models/ctf/damage/tris.md2";
        break;

      case RUNE_HASTE:
        name = "haste_rune";
        effects = 0; // EF_COLOR_SHELL;
        renderfx = 0; // RF_SHELL_BLUE;
        model = "models/ctf/haste/tris.md2";
        break;

      case RUNE_RESIST:
        name = "resist_rune";
        effects = 0; // EF_COLOR_SHELL;
        renderfx = 0; // RF_SHELL_RED | RF_SHELL_BLUE;
        model = "models/ctf/resist/tris.md2";
        break;

      case RUNE_REGEN:
        name = "regen_rune";
        effects = 0; // EF_COLOR_SHELL;
        renderfx = 0; // RF_SHELL_GREEN;
        model = "models/ctf/regen/tris.md2";
        break;

      case RUNE_VAMP: {
        // added by Vampire
        name = "vampire_rune";
        // effects = EF_TELEPORTER | EF_ANIM01;//EF_COLOR_SHELL;
        // lmctf60/q_shared.h EF_ANIM01 = 0x00000400
        effects = 0x00000400; // EF_ANIM01
        // lmctf60/q_shared.h RF_SHELL_RED = 1024
        renderfx = 1024; // RF_SHELL_RED
        model = "models/ctf/resist/tris.md2";
        break;
      }

      default:
        gi.dprintf("Bad rune model selected.\n");
        break; // MJD If we hit this line, then name, effects, renderfx,
      // and model would stay uninitialized, which would be a bad thing,
      // I think.
    }

    // name/model may still be null here (the `default:` branch above),
    // matching the C source's own MJD-flagged uninitialized-variable risk
    // (bug-for-bug: `ED_NewString(NULL)`/passing a NULL model onward in
    // that case is exactly what the C source does).
    const ent = G_Spawn();
    ent.classname = name === null ? null : ED_NewString(name);
    ED_CallSpawn(ent);

    VectorCopy(spot.s.origin, ent.s.origin);
    ent.takedamage = DamageT.DAMAGE_NO; // no damage on runes
    ent.dontfree = 1;
    gi.soundindex("items/m_health.wav");
    ent.s.effects |= effects;
    ent.s.renderfx |= renderfx;
    ent.model = model;
    ent.runetype = type; // We store our rune type here
    tossrune(ent, null);
    // gi.dprintf("Spawned rune.\n");
  }
}

/*
=================
SP_damage_rune (lmctf60/g_runes.c:437)
=================
*/
export function SP_damage_rune(self: EdictT): void {
  self.model = "models/items/invulner/tris.md2";

  SpawnItem(self, FindItemByClassname("damage_rune"));
}

/*
=================
Pickup_Rune (lmctf60/g_runes.c:445)
=================
*/
export function Pickup_Rune(ent: EdictT, other: EdictT): boolean {
  if (other.client === null) {
    throw new Error("Pickup_Rune: other.client is null (lmctf60/g_runes.c:447 dereferences other->client unconditionally)");
  }

  if (other.client.rune === null) {
    // don't already have rune

    // Make sure it will respawn
    ent.flags |= FL_RESPAWN;
    ent.think = null;
    ent.nextthink = 0;

    if (ent.item !== null) {
      other.client.pers.inventory[ITEM_INDEX(ent.item)]++;
    }
    ent.owner = other;
    other.client.rune = ent;
    ent.solid = SolidT.SOLID_NOT;
    gi.linkentity(ent); // always pair with solid changes

    ent.svflags |= SVF_NOCLIENT;
    ent.movetype = MovetypeT.MOVETYPE_NONE; // Don't block doors
    gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0);
    return true;
  }

  ent.touch = Touch_Item;
  ent.think = Rune_Think;
  ent.nextthink = level.time + FRAMETIME;

  return false;
}

/*
=================
Drop_Rune_Think (lmctf60/g_runes.c:473)
=================
*/
export function Drop_Rune_Think(ent: EdictT): void {
  ent.touch = Touch_Item;
  ent.owner = null;
  ent.think = Rune_Think;
  ent.nextthink = level.time + FRAMETIME;
}

/*
=================
Drop_Rune (lmctf60/g_runes.c:483)

Calls `tossruneset(dropped)` twice in a row (lines 498 and 501 of the C
source, with an intervening VectorCopy) -- redundant (the second call
overwrites nothing the first didn't already set, since VectorCopy only
touches `s.origin`) but harmless; preserved exactly rather than
collapsed to one call.
=================
*/
export function Drop_Rune(ent: EdictT, item: GItemT | null): void {
  if (item === null) return;
  if (ent.client === null) {
    throw new Error("Drop_Rune: ent.client is null (lmctf60/g_runes.c:491 dereferences ent->client unconditionally)");
  }

  ent.client.pers.inventory[ITEM_INDEX(item)]--;

  const dropped = ent.client.rune;
  if (dropped === null) return;
  ent.client.rune = null;

  tossruneset(dropped);

  VectorCopy(ent.s.origin, dropped.s.origin);
  tossruneset(dropped);
  dropped.touch = drop_temp_touch;
  dropped.owner = ent;

  const v = tv(0, 0, 48);
  VectorAdd(dropped.s.origin, v, dropped.s.origin);
  dropped.velocity[0] = -2000 + random() * 4000;
  dropped.velocity[1] = -2000 + random() * 4000;
  dropped.velocity[2] = 800 + random() * 200;

  ctf_TossEnt(ent, dropped);

  dropped.think = Drop_Rune_Think;
  dropped.nextthink = level.time + 1;

  // We just moved. Remember this time
  dropped.last_move_time = level.time;

  dropped.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(dropped); // always pair with changes to solid

  gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
  ValidateSelectedItem(ent);
}

/*
=================
DamageRuneHook (lmctf60/g_runes.c:527)

1.75x outgoing damage while the attacker carries the damage rune. The C
source's own comment notes the "real" multiplier would be 2x but was
tuned down to 1.75x ("-bat"); preserved exactly, including the fact that
this truncates (C `int damage *= 1.75f` truncates the float back to int,
so does `| 0` here).
=================
*/
export function DamageRuneHook(
  _targ: EdictT,
  _inflictor: EdictT,
  attacker: EdictT | null,
  damage: number,
  _knockback: number,
  _dflags: number,
): number {
  if (attacker !== null && attacker.client !== null && attacker.client.rune !== null) {
    if (attacker.client.rune.runetype === RUNE_DAMAGE) {
      return (damage * 1.75) | 0;
    }
  }
  return damage;
}

/*
=================
ResistRuneHook (lmctf60/g_runes.c:541)

Incoming damage divided by 1.75 (not simply halved -- the C comment notes
this offsets DamageRuneHook's 1.75x exactly) while the target carries the
resist rune, plus a sound cue. `gi.soundindex` is looked up lazily via
g_local.ts's `gi` binding, matching every other sound call site in this
port.
=================
*/
export function ResistRuneHook(
  targ: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  damage: number,
  _knockback: number,
  _dflags: number,
): number {
  if (targ.client !== null && targ.client.rune !== null) {
    if (targ.client.rune.runetype === RUNE_RESIST) {
      gi.sound(targ, CHAN_ITEM, gi.soundindex("ctf/resist.wav"), 1, ATTN_NORM, 0);
      return (damage / 1.75) | 0;
    }
  }
  return damage;
}

/*
=================
RuneThinkHook (lmctf60/g_runes.c:556)

RUNE_REGEN's per-think heal/armor-grant tick, gated by `level.framenum`
(not `level.time`) against `ent->client->regentime`. `heartrate` is
`ent->health / 5` clamped to [5, 25], both as the tick-gate interval (in
frames) and as the amount healed/granted (divided by 3, matching the
C source's own commented-out `/4` -> live `/3.0f` change, "//bat").
=================
*/
export function RuneThinkHook(ent: EdictT): void {
  let sound = false; // Don't play a sound unless needed.

  if (ent.client !== null && ent.client.rune !== null) {
    if (ent.client.rune.runetype === RUNE_REGEN) {
      let heartrate = (ent.health / 5) | 0;
      if (heartrate < 5) heartrate = 5;
      if (heartrate > 25) heartrate = 25;

      if (level.framenum < ent.client.regentime + heartrate) return;

      ent.client.regentime = level.framenum;

      if (ent.health < ent.max_health + 25) {
        // bat
        ent.health += heartrate / 3.0;
        // ent.health += heartrate / 4;
        if (ent.health > ent.max_health + 25) ent.health = ent.max_health + 25;
        sound = true;
      }

      const old_armor_index = ArmorIndex(ent);
      if (old_armor_index === 0) {
        const jacket = FindItem("Jacket Armor");
        if (jacket !== null) {
          ent.client.pers.inventory[ITEM_INDEX(jacket)] = (heartrate / 4) | 0;
        }
        sound = true;
      } else {
        if (ent.client.pers.inventory[old_armor_index] < 200) {
          // bat
          ent.client.pers.inventory[old_armor_index] += heartrate / 3.0;
          // ent.client.pers.inventory[old_armor_index] += heartrate / 4;
          if (ent.client.pers.inventory[old_armor_index] > 200) {
            ent.client.pers.inventory[old_armor_index] = 200;
          }
          sound = true;
        }
      }
      if (sound) {
        gi.sound(ent, CHAN_ITEM, gi.soundindex("ctf/regen.wav"), 1, ATTN_NORM, 0);
      }
    }
  }
}

/*
=================
RuneWeaponThinkHook (lmctf60/g_runes.c:613)

RUNE_HASTE: plays a looping-ish cue sound while firing, then -- when the
weapon has a pending gunframe -- calls the current weapon's weaponthink
a SECOND time this frame (p_weapon.ts's own Weapon_Think already called
it once earlier in the frame; this is the rune's "haste" effect: double
weapon-think ticks, i.e. double fire rate, while the haste rune is held
and `ps.gunframe` is still nonzero). RUNE_DAMAGE: just a sound cue while
firing, no mechanical effect here (its damage multiplier lives entirely
in DamageRuneHook above).
=================
*/
export function RuneWeaponThinkHook(ent: EdictT): void {
  if (ent.client !== null && ent.client.rune !== null) {
    if (ent.client.rune.runetype === RUNE_HASTE) {
      if (ent.client.isfiring) {
        gi.sound(ent, CHAN_ITEM, gi.soundindex("player/lava1.wav"), 1, ATTN_NORM, 0);
      }

      if (ent.client.ps.gunframe !== 0 && ent.client.pers.weapon !== null && ent.client.pers.weapon.weaponthink !== null) {
        ent.client.pers.weapon.weaponthink(ent);
      }
    }
    if (ent.client.rune.runetype === RUNE_DAMAGE) {
      if (ent.client.isfiring) {
        gi.sound(ent, CHAN_ITEM, gi.soundindex("ctf/strength.wav"), 1, ATTN_NORM, 0);
      }
    }
  }
}
