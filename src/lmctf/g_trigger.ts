// Ports lmctf60/g_trigger.c -- diff-derived from src/ctf/g_trigger.ts
// (lmctf60/g_trigger.c vs quake-2/ctf/g_trigger.c: 45-line diff of 579
// total, all cosmetic -- license header dropped and two `0.2` -> `0.2f`
// float-literal suffixes with no behavior change). This is otherwise a
// byte-identical port of src/ctf/g_trigger.ts.

import { _DotProduct, AngleVectors, vec3, vec3_origin, VectorCompare, VectorCopy, VectorMA, VectorScale } from "../shared/math";
import { ATTN_NORM, CHAN_AUTO, type CplaneT, type CsurfaceT, type CvarT, Q_stricmp, YAW } from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { FindItemByClassname, ITEM_INDEX } from "./g_items";
import { SolidT, SVF_DEADMONSTER, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  DAMAGE_NO_PROTECTION,
  type EdictT,
  FL_FLY,
  FL_SWIM,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  gi,
  level,
  MOD_TRIGGER_HURT,
  MovetypeT,
  st,
} from "./g_local";
import { G_FreeEdict, G_SetMovedir, G_UseTargets, vtos } from "./g_utils";

// same per-file cvarNum mirror as g_utils.ts/g_items.ts (module-local
// there too, so not reusable) -- see src/ctf/g_trigger.ts's identical
// comment.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// C dereferences these unconditionally at every call site below (activator);
// TS cannot express an unchecked deref through a nullable field, so this
// throws instead of silently miscompiling, matching g_weapon.ts's
// `requireOwner` idiom for the same situation.
function requireEdict(e: EdictT | null, what: string): EdictT {
  if (e === null) {
    throw new Error(`${what} is null (C dereferences it unconditionally here)`);
  }
  return e;
}

export function InitTrigger(self: EdictT): void {
  if (VectorCompare(self.s.angles, vec3_origin) === 0) G_SetMovedir(self.s.angles, self.movedir);

  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  gi.setmodel(self, self.model ?? "");
  self.svflags = SVF_NOCLIENT;
}

// the wait time has passed, so set back up for another activation
export function multi_wait(ent: EdictT): void {
  ent.nextthink = 0;
}

// the trigger was just activated
// ent->activator should be set to the activator so it can be held through a delay
// so wait for the delay time before firing
export function multi_trigger(ent: EdictT): void {
  if (ent.nextthink) return; // already been triggered

  G_UseTargets(ent, ent.activator);

  if (ent.wait > 0) {
    ent.think = multi_wait;
    ent.nextthink = level.time + ent.wait;
  } else {
    // we can't just remove (self) here, because this is a touch function
    // called while looping through area links...
    ent.touch = null;
    ent.nextthink = level.time + FRAMETIME;
    ent.think = G_FreeEdict;
  }
}

export function Use_Multi(ent: EdictT, other: EdictT | null, activator: EdictT | null): void {
  ent.activator = activator;
  multi_trigger(ent);
}

export function Touch_Multi(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other.client !== null) {
    if (self.spawnflags & 2) return;
  } else if (other.svflags & SVF_MONSTER) {
    if (!(self.spawnflags & 1)) return;
  } else {
    return;
  }

  if (VectorCompare(self.movedir, vec3_origin) === 0) {
    const forward = vec3();
    AngleVectors(other.s.angles, forward, null, null);
    if (_DotProduct(forward, self.movedir) < 0) return;
  }

  self.activator = other;
  multi_trigger(self);
}

/*QUAKED trigger_multiple (.5 .5 .5) ? MONSTER NOT_PLAYER TRIGGERED
Variable sized repeatable trigger.  Must be targeted at one or more entities.
If "delay" is set, the trigger waits some time after activating before firing.
"wait" : Seconds between triggerings. (.2 default)
sounds
1)	secret
2)	beep beep
3)	large switch
4)
set "message" to text string
*/
export function trigger_enable(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.solid = SolidT.SOLID_TRIGGER;
  self.use = Use_Multi;
  gi.linkentity(self);
}

export function SP_trigger_multiple(ent: EdictT): void {
  if (ent.sounds === 1) ent.noise_index = gi.soundindex("misc/secret.wav");
  else if (ent.sounds === 2) ent.noise_index = gi.soundindex("misc/talk.wav");
  else if (ent.sounds === 3) ent.noise_index = gi.soundindex("misc/trigger1.wav");

  if (!ent.wait) ent.wait = 0.2;
  ent.touch = Touch_Multi;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.svflags |= SVF_NOCLIENT;

  if (ent.spawnflags & 4) {
    ent.solid = SolidT.SOLID_NOT;
    ent.use = trigger_enable;
  } else {
    ent.solid = SolidT.SOLID_TRIGGER;
    ent.use = Use_Multi;
  }

  if (VectorCompare(ent.s.angles, vec3_origin) === 0) G_SetMovedir(ent.s.angles, ent.movedir);

  gi.setmodel(ent, ent.model ?? "");
  gi.linkentity(ent);
}

/*QUAKED trigger_once (.5 .5 .5) ? x x TRIGGERED
Triggers once, then removes itself.
You must set the key "target" to the name of another object in the level that has a matching "targetname".

If TRIGGERED, this trigger must be triggered before it is live.

sounds
 1)	secret
 2)	beep beep
 3)	large switch
 4)

"message"	string to be displayed when triggered
*/

export function SP_trigger_once(ent: EdictT): void {
  // make old maps work because I messed up on flag assignments here
  // triggered was on bit 1 when it should have been on bit 4
  if (ent.spawnflags & 1) {
    const v = vec3();
    VectorMA(ent.mins, 0.5, ent.size, v);
    ent.spawnflags &= ~1;
    ent.spawnflags |= 4;
    gi.dprintf(`fixed TRIGGERED flag on ${ent.classname ?? ""} at ${vtos(v)}\n`);
  }

  ent.wait = -1;
  SP_trigger_multiple(ent);
}

/*QUAKED trigger_relay (.5 .5 .5) (-8 -8 -8) (8 8 8)
This fixed size trigger cannot be touched, it can only be fired by other events.
*/
export function trigger_relay_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  G_UseTargets(self, activator);
}

export function SP_trigger_relay(self: EdictT): void {
  self.use = trigger_relay_use;
}

/*
==============================================================================

trigger_key

==============================================================================
*/

/*QUAKED trigger_key (.5 .5 .5) (-8 -8 -8) (8 8 8)
A relay trigger that only fires it's targets if player has the proper key.
Use "item" to specify the required key, for example "key_data_cd"
*/
export function trigger_key_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  const item = self.item;
  if (item === null) return;
  if (activator === null) return;
  const client = activator.client;
  if (client === null) return;

  const index = ITEM_INDEX(item);
  if (!client.pers.inventory[index]) {
    if (level.time < self.touch_debounce_time) return;
    self.touch_debounce_time = level.time + 5.0;
    gi.centerprintf(activator, `You need the ${item.pickup_name ?? ""}`);
    gi.sound(activator, CHAN_AUTO, gi.soundindex("misc/keytry.wav"), 1, ATTN_NORM, 0);
    return;
  }

  gi.sound(activator, CHAN_AUTO, gi.soundindex("misc/keyuse.wav"), 1, ATTN_NORM, 0);
  if (cvarNum(gameCvars.coop)) {
    if (item.classname !== null && Q_stricmp(item.classname, "key_power_cube") === 0) {
      let cube = 0;
      for (; cube < 8; cube++) {
        if (client.pers.power_cubes & (1 << cube)) break;
      }
      for (let player = 1; player <= game.maxclients; player++) {
        const ent = g_edicts[player];
        if (!ent.inuse) continue;
        if (ent.client === null) continue;
        if (ent.client.pers.power_cubes & (1 << cube)) {
          ent.client.pers.inventory[index]--;
          ent.client.pers.power_cubes &= ~(1 << cube);
        }
      }
    } else {
      for (let player = 1; player <= game.maxclients; player++) {
        const ent = g_edicts[player];
        if (!ent.inuse) continue;
        if (ent.client === null) continue;
        ent.client.pers.inventory[index] = 0;
      }
    }
  } else {
    client.pers.inventory[index]--;
  }

  G_UseTargets(self, activator);

  self.use = null;
}

export function SP_trigger_key(self: EdictT): void {
  if (st.item === null) {
    gi.dprintf(`no key item for trigger_key at ${vtos(self.s.origin)}\n`);
    return;
  }
  self.item = FindItemByClassname(st.item);

  if (self.item === null) {
    gi.dprintf(`item ${st.item} not found for trigger_key at ${vtos(self.s.origin)}\n`);
    return;
  }

  if (self.target === null) {
    gi.dprintf(`${self.classname ?? ""} at ${vtos(self.s.origin)} has no target\n`);
    return;
  }

  gi.soundindex("misc/keytry.wav");
  gi.soundindex("misc/keyuse.wav");

  self.use = trigger_key_use;
}

/*
==============================================================================

trigger_counter

==============================================================================
*/

/*QUAKED trigger_counter (.5 .5 .5) ? nomessage
Acts as an intermediary for an action that takes multiple inputs.

If nomessage is not set, t will print "1 more.. " etc when triggered and "sequence complete" when finished.

After the counter has been triggered "count" times (default 2), it will fire all of it's targets and remove itself.
*/

export function trigger_counter_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (self.count === 0) return;

  self.count--;

  if (self.count) {
    if (!(self.spawnflags & 1)) {
      const act = requireEdict(activator, "activator");
      gi.centerprintf(act, `${self.count} more to go...`);
      gi.sound(act, CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
    }
    return;
  }

  if (!(self.spawnflags & 1)) {
    const act = requireEdict(activator, "activator");
    gi.centerprintf(act, "Sequence completed!");
    gi.sound(act, CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
  }
  self.activator = activator;
  multi_trigger(self);
}

export function SP_trigger_counter(self: EdictT): void {
  self.wait = -1;
  if (!self.count) self.count = 2;

  self.use = trigger_counter_use;
}

/*
==============================================================================

trigger_always

==============================================================================
*/

/*QUAKED trigger_always (.5 .5 .5) (-8 -8 -8) (8 8 8)
This trigger will always fire.  It is activated by the world.
*/
export function SP_trigger_always(ent: EdictT): void {
  // we must have some delay to make sure our use targets are present
  if (ent.delay < 0.2) ent.delay = 0.2;
  G_UseTargets(ent, ent);
}

/*
==============================================================================

trigger_push

==============================================================================
*/

const PUSH_ONCE = 1;

let windsound = 0;

export function trigger_push_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other.classname === "grenade") {
    VectorScale(self.movedir, self.speed * 10, other.velocity);
  } else if (other.health > 0) {
    VectorScale(self.movedir, self.speed * 10, other.velocity);

    if (other.client !== null) {
      // don't take falling damage immediately from this
      VectorCopy(other.velocity, other.client.oldvelocity);
      if (other.fly_sound_debounce_time < level.time) {
        other.fly_sound_debounce_time = level.time + 1.5;
        gi.sound(other, CHAN_AUTO, windsound, 1, ATTN_NORM, 0);
      }
    }
  }
  if (self.spawnflags & PUSH_ONCE) G_FreeEdict(self);
}

/*QUAKED trigger_push (.5 .5 .5) ? PUSH_ONCE
Pushes the player
"speed"		defaults to 1000
*/
export function SP_trigger_push(self: EdictT): void {
  InitTrigger(self);
  windsound = gi.soundindex("misc/windfly.wav");
  self.touch = trigger_push_touch;
  if (!self.speed) self.speed = 1000;
  gi.linkentity(self);
}

/*
==============================================================================

trigger_hurt

==============================================================================
*/

/*QUAKED trigger_hurt (.5 .5 .5) ? START_OFF TOGGLE SILENT NO_PROTECTION SLOW
Any entity that touches this will be hurt.

It does dmg points of damage each server frame

SILENT			supresses playing the sound
SLOW			changes the damage rate to once per second
NO_PROTECTION	*nothing* stops the damage

"dmg"			default 5 (whole numbers only)

*/
export function hurt_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (self.solid === SolidT.SOLID_NOT) self.solid = SolidT.SOLID_TRIGGER;
  else self.solid = SolidT.SOLID_NOT;
  gi.linkentity(self);

  if (!(self.spawnflags & 2)) self.use = null;
}

export function hurt_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (!other.takedamage) return;

  if (self.timestamp > level.time) return;

  if (self.spawnflags & 16) self.timestamp = level.time + 1;
  else self.timestamp = level.time + FRAMETIME;

  if (!(self.spawnflags & 4)) {
    if (level.framenum % 10 === 0) gi.sound(other, CHAN_AUTO, self.noise_index, 1, ATTN_NORM, 0);
  }

  const dflags = self.spawnflags & 8 ? DAMAGE_NO_PROTECTION : 0;
  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, self.dmg, dflags, MOD_TRIGGER_HURT);
}

export function SP_trigger_hurt(self: EdictT): void {
  InitTrigger(self);

  self.noise_index = gi.soundindex("world/electro.wav");
  self.touch = hurt_touch;

  if (!self.dmg) self.dmg = 5;

  if (self.spawnflags & 1) self.solid = SolidT.SOLID_NOT;
  else self.solid = SolidT.SOLID_TRIGGER;

  if (self.spawnflags & 2) self.use = hurt_use;

  gi.linkentity(self);
}

/*
==============================================================================

trigger_gravity

==============================================================================
*/

/*QUAKED trigger_gravity (.5 .5 .5) ?
Changes the touching entites gravity to
the value of "gravity".  1.0 is standard
gravity for the level.
*/

export function trigger_gravity_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  other.gravity = self.gravity;
}

export function SP_trigger_gravity(self: EdictT): void {
  if (st.gravity === null) {
    gi.dprintf(`trigger_gravity without gravity set at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  InitTrigger(self);
  const n = Number.parseInt(st.gravity, 10);
  self.gravity = Number.isNaN(n) ? 0 : n;
  self.touch = trigger_gravity_touch;
}

/*
==============================================================================

trigger_monsterjump

==============================================================================
*/

/*QUAKED trigger_monsterjump (.5 .5 .5) ?
Walking monsters that touch this will jump in the direction of the trigger's angle
"speed" default to 200, the speed thrown forward
"height" default to 200, the speed thrown upwards
*/

export function trigger_monsterjump_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other.flags & (FL_FLY | FL_SWIM)) return;
  if (other.svflags & SVF_DEADMONSTER) return;
  if (!(other.svflags & SVF_MONSTER)) return;

  // set XY even if not on ground, so the jump will clear lips
  other.velocity[0] = self.movedir[0] * self.speed;
  other.velocity[1] = self.movedir[1] * self.speed;

  if (other.groundentity === null) return;

  other.groundentity = null;
  other.velocity[2] = self.movedir[2];
}

export function SP_trigger_monsterjump(self: EdictT): void {
  if (!self.speed) self.speed = 200;
  if (!st.height) st.height = 200;
  if (self.s.angles[YAW] === 0) self.s.angles[YAW] = 360;
  InitTrigger(self);
  self.touch = trigger_monsterjump_touch;
  self.movedir[2] = st.height;
}
